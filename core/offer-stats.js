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
 *     inputTokens, outputTokens, cachedTokens, cacheCreationTokens, reasoningTokens,
 *           // inputTokens 是**净值**（已扣掉缓存读/写），全部由 core/wire.js#usageNumbers 归一；
 *           // cacheCreationTokens 是后加的字段，老桶没有 → 读的时候一律 || 0
 *     estCostSum, estCostCount,            // 按报价估算的费用（诊断级，非对账级）
 *     streamGapMax,                        // 流内最大停顿（毫秒）
 *     errors: { [kind|code]: n },          // 这条供给上失败的错误归类计数
 *   }
 *
 * 全部由 recordRoutingBatch 顺路更新（同一份数据，两处落盘），没有额外请求。
 */

import { offerCost } from './pricing.js'
import { fingerprintError } from './error-fingerprint.js'
import { classifyFailure } from './failure.js'
import { OUTCOME } from './fault-triage.js'
import { usageNumbers } from './wire.js'

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
      // 我方缺陷（网关自身 bug / 本机网络不通）：**不进 failed、不进分母**。
      // 归错责任层会把一条健康的站算成坏站，让用户去停用它——2026-11-03 的 507 次
      // routeTarget 故障就是这么把好站烤红的。单开一栏只给诊断页解释用。
      localDefects: 0,
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
      cacheCreationTokens: 0,
      // 命中率分母「计费输入」= 净值 + 缓存读 + 缓存写（见 addUsage 注释）。
      // 老桶没有这个字段，读的时候按 inputTokens 兜底
      billedInputTokens: 0,
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

  // 缓存读/写必须走 core/wire.js 的 usageNumbers（**唯一口径**）。
  // 这里以前自己读 `usage.prompt_tokens_details.cached_tokens`：sub2api 系上游把命中
  // 放在 prompt_cache_hit_tokens / cache_read_input_tokens 里、prompt_tokens_details
  // 那份是 0，于是缓存全按输入价算了钱（真实库实测 544/12179 条命中这样被漏掉）。
  const numbers = usageNumbers(usage) || { cached: 0, cacheCreation: 0 }
  const cached = Math.max(0, Number(numbers.cached) || 0)
  const cacheCreation = Math.max(0, Number(numbers.cacheCreation) || 0)
  // 净值口径：prompt 含缓存时减掉；只有 input_tokens（Anthropic 约定不含缓存）时原样
  const fresh = Math.max(prompt - cached - cacheCreation, 0)
  const cachePerMtok =
    Number.isFinite(cost.cacheReadCnyPerMtok) && cost.cacheReadCnyPerMtok !== null
      ? cost.cacheReadCnyPerMtok
      : inP
  let total = (fresh / 1e6) * inP + (cached / 1e6) * cachePerMtok + (completion / 1e6) * outP
  // 缓存写入独立计费（通常 1.25× 输入价）；站点没公布就退回输入价
  if (cacheCreation > 0) {
    const writePerMtok =
      Number.isFinite(cost.cacheWriteCnyPerMtok) && cost.cacheWriteCnyPerMtok !== null
        ? cost.cacheWriteCnyPerMtok
        : inP
    total += (cacheCreation / 1e6) * writePerMtok
  }
  return Number.isFinite(total) ? total : null
}

function addUsage(b, usage) {
  if (!usage) return
  // 缓存读/写与思考 token 一律走 core/wire.js#usageNumbers（**唯一口径**）。
  // 这里以前自己读 `usage.prompt_tokens_details.cached_tokens`，而 sub2api 系上游把
  // 命中放在 prompt_cache_hit_tokens / cache_read_input_tokens 里、那份是 0——
  // 真实库 12179 条里有 544 条命中被漏掉，北辰 · deepseek-4.1-flash 长期评价
  // 于是写着命中 26.8%，按同一份账应该是 37.9%。
  const numbers = usageNumbers(usage)
  if (!numbers) return
  // inputTokens 沿用「上游 prompt 原值」这个口径（老桶就是这样，不能就地改含义，
  // 否则新老桶混在一个窗口里求命中率必然漂）。唯一的顺带修正：只有 input_tokens
  // 的行（Anthropic 约定）以前连输入都记成 0，现在按 input_tokens 记——
  // 那种行以前会让命中率分母偏小、命中率虚高。
  b.inputTokens += Math.max(0, Number(numbers.prompt) || 0)
  b.outputTokens += Math.max(0, Number(numbers.output) || 0)
  b.cachedTokens += Math.max(0, Number(numbers.cached) || 0)
  b.cacheCreationTokens = (b.cacheCreationTokens || 0) + Math.max(0, Number(numbers.cacheCreation) || 0)
  b.reasoningTokens += Math.max(0, Number(numbers.reasoning) || 0)
  // 命中率的分母「计费输入」= 净值 + 缓存读 + 缓存写（与 usage.js#finalize 同一口径）。
  // 单独累加而不是现算：Anthropic 系只有 input_tokens（本身不含缓存）时，
  // 用 prompt 当分母会把缓存重复算进去。老桶没有这个字段 → 退回 inputTokens
  b.billedInputTokens =
    (b.billedInputTokens || 0) +
    Math.max(0, (Number(numbers.input) || 0) + Number(numbers.cached || 0) + Number(numbers.cacheCreation || 0))
}

const errKey = (kind, code) => `${kind || 'outage'}${code ? `/${code}` : ''}`

/**
 * 桶里的「客户端自己断开」次数（**唯一读法**）。
 *
 * 历史上有两个字段名：`clientAborted`（release 上 9689c72 写的）和
 * `clientAborts`（本分支统一后的名字）。库里可能两种都有，读的时候必须都认，
 * 否则升级后老数据会被当成「0 次客户端断开」，那批请求就凭空变回断流了。
 */
export function clientAbortsOf(bucket) {
  if (!bucket) return 0
  return (Number(bucket.clientAborts) || 0) + (Number(bucket.clientAborted) || 0)
}

/**
 * 成功率的**分母**（唯一读法）：已交付请求 = requests − 客户端断开。
 *
 * 为什么不能直接拿 `ok / (requests - clientAborts)`：老库里有 11 个桶
 * （2026-10-29 那批，来自修复客户端断开误记 broken 的那次数据修理）
 * 满足 `ok + broken + clientAborts > requests`——都是记重复了。
 * 直接除算出来的成功率会到 101%，界面上就是一句假话。
 *
 * 兜底规则：分母至少取「真的结过果的那些单」（ok + broken），
 * 这样成功率恒 ≤ 100%，也不会因为老数据把分母撑大而虚高。
 *
 * @param {{requests?:number, ok?:number, broken?:number}} bucket
 */
export function servedRequestsOf(bucket) {
  if (!bucket) return 0
  const requests = Number(bucket.requests) || 0
  const clientAborts = clientAbortsOf(bucket)
  const settled = (Number(bucket.ok) || 0) + (Number(bucket.broken) || 0)
  return Math.max(0, requests - clientAborts, settled)
}

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
    // 责任层判定必须和 core/failure.js 用同一份口径：我方缺陷计入 localDefects，
    // 不记 failed。否则供给表现里这条站会凭空多出一次失败，诊断规则②会把它
    // 读成「站方失败率上升」，推着用户去停用一家好站。
    const cls = classifyFailure(f.error)
    if (cls.localDefect) {
      b.localDefects = (b.localDefects || 0) + 1
      const k = errKey('local', null)
      b.errors[k] = (b.errors[k] || 0) + 1
      continue
    }
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
 * 命中率的分母（**唯一读法**）：计费输入 = 净值 + 缓存读 + 缓存写。
 *
 * 2026-11 之前的桶没有 billedInputTokens，那时 inputTokens 存的是 prompt 原值、
 * 命中率算的是「缓存 ÷ prompt」。老桶按那个口径兜底，否则升级后一读老数据，
 * 分母从「含缓存的 prompt」变成「净值」会让命中率凭空跳到 96%→99%。
 *
 * @param {{billedInputTokens?:number, inputTokens?:number}} bucket
 */
function cacheHitBase(bucket) {
  if (!bucket) return 0
  const billed = Number(bucket.billedInputTokens)
  if (Number.isFinite(billed) && billed > 0) return billed
  return Number(bucket.inputTokens) || 0
}

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
 *          tps, cacheHitPct, cachedTokens, cacheCreationTokens, estCostCny, avgCostCny, hours,
 *          firstHour, lastHour}
 *   tps 的单位是「token / 毫秒」，界面自己 ×1000 成 tok/s（与 core/anomaly.js 一致）
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
        cacheCreationTokens: 0,
        billedInputTokens: 0,
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
      rec.clientAborts += clientAbortsOf(b)
      rec.ttftSum += Number(b.ttftSum) || 0
      rec.ttftCount += Number(b.ttftCount) || 0
      rec.latencySum += Number(b.latencySum) || 0
      rec.latencyCount += Number(b.latencyCount) || 0
      rec.genOutSum += Number(b.genOutSum) || 0
      rec.genTimeSum += Number(b.genTimeSum) || 0
      rec.cachedTokens += Number(b.cachedTokens) || 0
      rec.cacheCreationTokens += Number(b.cacheCreationTokens) || 0
      rec.billedInputTokens += Number(b.billedInputTokens) || 0
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
        // 成功率的口径：分母剔除客户端取消（那不是站方的成绩），
        // 且不会因为老库里重复记账的桶把分母撑小 → 成功率恒 ≤ 100%
        // （2026-10-29 的 11 个老桶曾让格子云那一行显示 101%）
        okRate: servedRequestsOf(r) > 0 ? Math.min(1, r.ok / servedRequestsOf(r)) : null,
        avgTtftMs: r.ttftCount > 0 ? r.ttftSum / r.ttftCount : null,
        avgLatencyMs: r.latencyCount > 0 ? r.latencySum / r.latencyCount : null,
        tps: r.genTimeSum > 0 ? r.genOutSum / r.genTimeSum : null,
        // 命中率 = 缓存读 ÷ **计费输入**（净值 + 缓存读 + 缓存写），与
        // core/usage.js#finalize、core/usage-detail.js#sumBuckets 同一口径。
        // 老桶没有 billedInputTokens（那时 inputTokens 就存 prompt 原值）→ 用它兜底：
        // 老口径就是「缓存 ÷ prompt」，与旧页面数字一致，不会因为升级忽然跳一下。
        cacheHitPct: cacheHitBase(r) > 0 ? r.cachedTokens / cacheHitBase(r) : null,
        // 命中率的分子/分母也交出去：界面上写「96%」时，能同时说清
        // 「缓存读 12.6 亿 ÷ 计费输入 13.2 亿」到底是谁比谁
        cachedTokens: r.cachedTokens,
        cacheCreationTokens: r.cacheCreationTokens,
        billedInputTokens: cacheHitBase(r),
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
