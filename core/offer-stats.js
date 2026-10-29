/**
 * 供给表现的时间序列：按「供给 × 小时」聚合真实流量的表现。
 *
 * 为什么要有这张表：决策日志（db.routing）只留最近 500 条，适合查案，
 * 不适合统计——「这家上礼拜稳不稳」「这家晚高峰是不是更慢」都答不了。
 * 将来的站点综合评判（速度 / 稳定性 / 置信度）要吃的正是这种带时间维度的
 * 聚合数据，所以落盘结构一步到位：
 *
 *   db.offerStats["o_xxx|2026-10-28T08"] = {
 *     offerId, hour,
 *     requests, ok, broken, failed, clientAborts,
 *           // requests = ok + broken + clientAborts
 *           // clientAborts = 客户端自己断开（用户关对话 / 客户端到点取消 / 自动副任务超时）。
 *           // 它既不是站方的错也不是断流，但必须单列：混进 broken 会把真断流的
 *           // 比例稀释到诊断阈值以下（2026-10-29 的真实现场），混进 ok 又会
 *           // 把「没拿到结果」算成好样本。算率时分母要用 requests - clientAborts。
 *     ttftSum, ttftCount,                  // 首字
 *     latencySum, latencyCount,            // 总时长
 *     genOutSum, genCount, genTimeSum,     // 吐字速度分母/分子（TPS）
 *     inputTokens, outputTokens, cachedTokens, reasoningTokens,
 *     estCostSum, estCostCount,            // 按报价估算的费用（诊断级，非对账级）
 *     streamGapMax,                        // 流内最大停顿（毫秒）
 *     errors: { [kind|code]: n },          // 这条供给上失败的错误归类计数
 *   }
 *
 * 全部由 recordRoutingBatch 顺路更新（同一份数据，两处落盘），没有额外请求。
 */

import { offerCost } from './pricing.js'
import { fingerprintError } from './error-fingerprint.js'
import { OUTCOME } from './fault-triage.js'

export const OFFER_STATS_MAX_AGE_DAYS = 30

/** 客户端主动断开在事件账里的 kind（与 fault-triage 的 faultKindOf 同一口径） */
const CLIENT_ABORTED_KIND = 'client-aborted'

/** ISO 时间串 → 小时桶 key（本地无时区概念，一律 UTC，别混） */
export function hourKey(iso) {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso)
  const d = new Date(Number.isFinite(ms) ? ms : Date.now())
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`
}

function bucket(stats, offerId, hour) {
  const key = `${offerId}|${hour}`
  let b = stats[key]
  if (!b) {
    b = stats[key] = {
      offerId,
      hour,
      requests: 0,
      ok: 0,
      broken: 0,
      failed: 0,
      // 客户端自己关连接（用户中断 / 客户端到点取消）：既不算成功也不算站方断流，
      // 单开一栏只用于「解释你看到的那些断流」，绝不进请求数与分母
      clientAborts: 0,
      ttftSum: 0,
      ttftCount: 0,
      latencySum: 0,
      latencyCount: 0,
      genOutSum: 0,
      genCount: 0,
      genTimeSum: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      estCostSum: 0,
      estCostCount: 0,
      streamGapMax: 0,
      errors: {},
    }
  }
  return b
}

/**
 * 诊断级的单请求费用估算（人民币数值口径，与比价页同一套 offerCost 换算）。
 * 缓存命中部分用缓存读价（站点没公布就退回输入价，保守）。
 * 拿不到价 → null（未定价/按次缺失，别硬编 0 污染均值）。
 * 这是「量级对不对」的估算，不是对账——对账由 billingSamples 负责。
 */
export function estimateCostCny(offer, usage, settings = {}, benchmarks = {}) {
  if (!offer || !usage) return null
  const prompt = Number(usage.prompt_tokens) || 0
  const completion = Number(usage.completion_tokens) || 0
  if (!prompt && !completion) return null

  const cost = offerCost(offer, settings, benchmarks)
  if (cost.perCall) return cost.callPriceCny ?? null
  const inP = cost.inCnyPerMtok
  const outP = cost.outCnyPerMtok
  if (inP === null || outP === null || !Number.isFinite(inP) || !Number.isFinite(outP)) return null

  const cached = Number(usage.prompt_tokens_details?.cached_tokens) || 0
  const fresh = Math.max(prompt - cached, 0)
  const cachePerMtok =
    Number.isFinite(cost.cacheReadCnyPerMtok) && cost.cacheReadCnyPerMtok !== null
      ? cost.cacheReadCnyPerMtok
      : inP
  const total = (fresh / 1e6) * inP + (cached / 1e6) * cachePerMtok + (completion / 1e6) * outP
  return Number.isFinite(total) ? total : null
}

function addUsage(b, usage) {
  if (!usage) return
  const numbers = usage.prompt_tokens_details || {}
  b.inputTokens += Number(usage.prompt_tokens) || 0
  b.outputTokens += Number(usage.completion_tokens) || 0
  b.cachedTokens += Number(numbers.cached_tokens) || 0
  b.reasoningTokens += Number(usage.completion_tokens_details?.reasoning_tokens) || 0
}

const errKey = (kind, code) => `${kind || 'outage'}${code ? `/${code}` : ''}`

/**
 * 把一条决策记录摊进时间序列。纯函数（原地改 stats）：
 *   - 选中供给的 outcome（ok / stream-broken / client-aborted）记在该供给名下
 *   - failures[] 里的每次失败尝试记在被试供给名下（那是它们的失败）
 */
export function applyRoutingToStats(stats, record, { offerById = null, settings = {}, benchmarks = {} } = {}) {
  const hour = hourKey(record.ts)
  const usage = record.usage || null

  if (record.chosenOfferId) {
    const b = bucket(stats, record.chosenOfferId, hour)
    // 结局口径只有一份（core/fault-triage.js#OUTCOME），这里不再自己拼字符串
    const clientAborted = record.outcome === OUTCOME.CLIENT_ABORTED
    b.requests += 1
    // 客户端自己断开的：只计次数，不记成败，也不参与速度/费用/吐字统计——
    // 那是一个没说完的回答，拿去算速度只会把基线拉歪。
    // requests 仍然 +1，是为了让诊断侧能用「requests - clientAborts」这个唯一分母。
    if (clientAborted) b.clientAborts += 1
    else if (record.outcome === OUTCOME.STREAM_BROKEN) b.broken += 1
    else b.ok += 1
    if (!clientAborted) {
      b.latencySum += Number(record.latencyMs) || 0
      b.latencyCount += 1
      if (Number(record.ttftMs) > 0) {
        b.ttftSum += Number(record.ttftMs)
        b.ttftCount += 1
      }
      if (Number(record.streamGapMs) > 0) {
        b.streamGapMax = Math.max(b.streamGapMax, Number(record.streamGapMs))
      }
      if (usage) {
        addUsage(b, usage)
        const genOut = Number(usage.completion_tokens) || 0
        if (genOut > 0 && Number(record.latencyMs) > Number(record.ttftMs || 0)) {
          b.genOutSum += genOut
          b.genTimeSum += Number(record.latencyMs) - Number(record.ttftMs || 0)
          b.genCount += 1
        }
      }
      const offer = offerById?.get?.(record.chosenOfferId)
      if (offer && usage) {
        const est = estimateCostCny(offer, usage, settings, benchmarks)
        if (est !== null && Number.isFinite(est)) {
          b.estCostSum += est
          b.estCostCount += 1
        }
      }
      // 断流原因也进错误归类（空闲超时 / 流中断是两种不同的病）
      if (record.outcome === OUTCOME.STREAM_BROKEN && record.streamError) {
        const kind = /无响应|超时|timed? ?out/i.test(record.streamError) ? 'slow' : 'outage'
        b.errors[errKey(kind, null)] = (b.errors[errKey(kind, null)] || 0) + 1
      }
    }
  }

  for (const f of record.failures || []) {
    if (!f.offerId) continue
    const b = bucket(stats, f.offerId, hour)
    b.failed += 1
    // kind/code 与错误账本同一来源（fingerprintError），两边口径必须一致
    const fp = fingerprintError(f.error)
    const kind = /无响应|超时|timed? ?out/i.test(String(f.error))
      ? 'slow'
      : fp?.kind || 'outage'
    const key = errKey(kind, fp?.code || null)
    b.errors[key] = (b.errors[key] || 0) + 1
  }
}

/**
 * 一次性修数：把历史上误记成「站方断流」的客户端断开挪回它该在的栏。
 *
 * 2026-10-29 之前的口径：客户端自己关连接（agent 到点取消 / 用户按 Esc）产生的
 * `This operation was aborted` 一律记成 stream-broken，于是：
 *   - 供给表现里断流率虚高（真实库 23 请求里 3 条是这么来的，13% 全是冤的）；
 *   - 诊断页弹一条「断流率 13%」让用户去降权/停用一家健康站；
 *   - 故障研判还真的上报过自动路由。
 *
 * 不能全清（真有站方断流的桶也在里面），也不能猜。这里只认直接证据：
 * 故障事件账里留了原始错误文本，只有写着 aborted / 客户端已断开的那几条才算。
 * 每挪一条就给事件打 `movedToClientAbort` 标记，重复执行不会重复扣。
 *
 * 为什么放在 ensure 里而不是 store.migrate：它是诊断数据的自我修复，
 * 跟 DB 结构版本无关；放 migrate 里还要为它单独抬一次版本号。
 *
 * @returns {number} 挪了多少条
 */
export function repairClientAborts(db) {
  const events = Array.isArray(db.faultEvents) ? db.faultEvents : []
  if (!events.length) return 0
  const stats = db.offerStats || {}
  let moved = 0
  for (const e of events) {
    if (!e || e.movedToClientAbort) continue
    if (!e.offerId || !e.at) continue
    const text = String(e.detail || e.message || e.error || '')
    // 只认直接证据：客户端取消瀑布的原文，或我们自己「往已关的 res 写」那句
    if (!/operation was aborted|客户端已断开/i.test(text)) continue
    // 已经是新口径的（新代码写的事件）不用再改，也不能再扣桶——
    // 它的桶从一开始就没算进 broken，再扣一次就是把别人的锅算到它头上
    if (e.kind === CLIENT_ABORTED_KIND) continue

    // 事件本身要改成新口径：不然页面上的「故障处理」表会继续挂着一堆
    // 「回答被截断 · This operation was aborted」——用户仍然看不出是谁掐的。
    // 原始文本不删，挪进 originalText 留着查案。
    e.originalText = text
    e.kind = CLIENT_ABORTED_KIND
    e.impact = 'none'
    e.impactReason = '客户端主动断开请求'
    e.status = 'ignored'
    e.message = '客户端主动断开请求，不予处理'
    e.detail = '客户端主动断开请求：客户端自己把连接关了（手动中断 / 客户端到点取消），回答没要完，但这不是站点的问题'
    e.todo = '不予处理'
    e.movedToClientAbort = true
    moved += 1

    // 小时桶也要扣：老库把这类算进了 broken/requests，不扣历史断流率就一直是假的。
    // 桶里没有可扣的就不动它（事件可能已经被 300 条滚动窗口挤掉了对应记录）
    const b = stats[`${e.offerId}|${hourKey(e.at)}`]
    if (b && Number(b.broken) > 0) {
      b.broken -= 1
      // requests = ok + broken 是这个表的口径，挪走一条要同步减，否则三栏对不上
      b.requests = Math.max(0, (Number(b.requests) || 0) - 1)
      b.clientAborts = (Number(b.clientAborts) || 0) + 1
    }
  }
  return moved
}

/** 幂等：诊断相关的新键（错误账本 + 供给表现时间序列）不存在就补上。migrate 和读取路径都调它。 */
export function ensureDiagnosisKeys(db) {
  if (!db.errorbook || typeof db.errorbook !== 'object') db.errorbook = {}
  if (!db.offerStats || typeof db.offerStats !== 'object') db.offerStats = {}
  if (!Array.isArray(db.checkups)) db.checkups = []
  // 旧口径的历史数据：只挪一次（幂等），修完的事件有标记
  repairClientAborts(db)
  return db
}

/** 清掉太老的小时桶：评判用的是近期表现，30 天前的数据只会白占体积 */
export function pruneOfferStats(stats, now = Date.now(), maxAgeDays = OFFER_STATS_MAX_AGE_DAYS) {
  const cutoffHour = hourKey(new Date(now - maxAgeDays * 86400000).toISOString())
  let removed = 0
  for (const key of Object.keys(stats)) {
    const hour = String(key).split('|')[1]
    if (hour && hour < cutoffHour) {
      delete stats[key]
      removed += 1
    }
  }
  return removed
}

// ------------------------------------------------------------ 长期评价聚合

/**
 * 长期评价：把小时桶聚合成「站点 / 模型 / 分组」三个维度的长期表现。
 *
 * 数据源就是 offerStats 本身（保留 30 天），没有额外请求——网关每单顺路记的
 * 账在这里升维汇总。分组维度用的是「站点 × 分组」（一条供给的归属），
 * 站点维度把一个站下所有分组并起来，模型维度跨站并。
 *
 * @param {Object} offerStats db.offerStats
 * @param {Map} offerMeta offerId → {label, modelKey, providerId, providerName, group}
 * @returns {{byProvider:Array, byModel:Array, byGroup:Array}}
 *   每条：{key, label, requests, ok, broken, failed, okRate, avgTtftMs, avgLatencyMs,
 *          tps, cacheHitPct, estCostCny, avgCostCny, hours, firstHour, lastHour}
 */
export function aggregateLongTerm(offerStats = {}, offerMeta = new Map()) {
  const dims = { byProvider: new Map(), byModel: new Map(), byGroup: new Map() }
  const ensure = (map, key, label) => {
    let rec = map.get(key)
    if (!rec) {
      rec = {
        key,
        label,
        requests: 0,
        ok: 0,
        broken: 0,
        failed: 0,
        clientAborts: 0,
        ttftSum: 0,
        ttftCount: 0,
        latencySum: 0,
        latencyCount: 0,
        genOutSum: 0,
        genTimeSum: 0,
        cachedTokens: 0,
        inputTokens: 0,
        estCostSum: 0,
        estCostCount: 0,
        errors: 0,
        hours: new Set(),
        firstHour: null,
        lastHour: null,
      }
      map.set(key, rec)
    }
    return rec
  }
  for (const [statsKey, b] of Object.entries(offerStats || {})) {
    const offerId = String(statsKey).split('|')[0]
    const meta = offerMeta.get(offerId)
    if (!meta || !b) continue
    const hour = String(b.hour || '')
    const targets = [
      [dims.byProvider, meta.providerId, meta.providerName || meta.providerId || '?'],
      [dims.byModel, meta.modelKey, meta.modelKey || '?'],
      [dims.byGroup, `${meta.providerId}|${meta.group || ''}`, `${meta.providerName || '?'} · ${meta.group || '默认'}`],
    ]
    for (const [map, key, label] of targets) {
      if (key === null || key === undefined) continue
      const rec = ensure(map, String(key), label)
      rec.requests += Number(b.requests) || 0
      rec.ok += Number(b.ok) || 0
      rec.broken += Number(b.broken) || 0
      rec.failed += Number(b.failed) || 0
      rec.clientAborts += Number(b.clientAborts) || 0
      rec.ttftSum += Number(b.ttftSum) || 0
      rec.ttftCount += Number(b.ttftCount) || 0
      rec.latencySum += Number(b.latencySum) || 0
      rec.latencyCount += Number(b.latencyCount) || 0
      rec.genOutSum += Number(b.genOutSum) || 0
      rec.genTimeSum += Number(b.genTimeSum) || 0
      rec.cachedTokens += Number(b.cachedTokens) || 0
      rec.inputTokens += Number(b.inputTokens) || 0
      rec.estCostSum += Number(b.estCostSum) || 0
      rec.estCostCount += Number(b.estCostCount) || 0
      rec.errors += Object.values(b.errors || {}).reduce((a, c) => a + (Number(c) || 0), 0)
      if (hour) {
        rec.hours.add(hour)
        if (rec.firstHour === null || hour < rec.firstHour) rec.firstHour = hour
        if (rec.lastHour === null || hour > rec.lastHour) rec.lastHour = hour
      }
    }
  }
  const finalize = (map) =>
    [...map.values()]
      .map((r) => ({
        key: r.key,
        label: r.label,
        requests: r.requests,
        ok: r.ok,
        broken: r.broken,
        failed: r.failed,
        clientAborts: r.clientAborts,
        // 成功率的口径：分母剔除客户端取消（那不是站方的成绩）
        okRate: r.requests - r.clientAborts > 0 ? r.ok / (r.requests - r.clientAborts) : null,
        avgTtftMs: r.ttftCount > 0 ? r.ttftSum / r.ttftCount : null,
        avgLatencyMs: r.latencyCount > 0 ? r.latencySum / r.latencyCount : null,
        tps: r.genTimeSum > 0 ? r.genOutSum / r.genTimeSum : null,
        cacheHitPct: r.inputTokens > 0 ? r.cachedTokens / r.inputTokens : null,
        estCostCny: r.estCostSum,
        avgCostCny: r.estCostCount > 0 ? r.estCostSum / r.estCostCount : null,
        errors: r.errors,
        hours: r.hours.size,
        firstHour: r.firstHour,
        lastHour: r.lastHour,
      }))
      .sort((a, b) => b.requests - a.requests)
  return { byProvider: finalize(dims.byProvider), byModel: finalize(dims.byModel), byGroup: finalize(dims.byGroup) }
}
