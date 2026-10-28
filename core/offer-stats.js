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
 *     requests, ok, broken, failed,        // requests=ok+broken（选中且已提交）
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

export const OFFER_STATS_MAX_AGE_DAYS = 30

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
 *   - 选中供给的 outcome（ok / stream-broken）记在该供给名下
 *   - failures[] 里的每次失败尝试记在被试供给名下（那是它们的失败）
 */
export function applyRoutingToStats(stats, record, { offerById = null, settings = {}, benchmarks = {} } = {}) {
  const hour = hourKey(record.ts)
  const usage = record.usage || null

  if (record.chosenOfferId) {
    const b = bucket(stats, record.chosenOfferId, hour)
    b.requests += 1
    if (record.outcome === 'stream-broken') b.broken += 1
    else b.ok += 1
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
    if (record.outcome === 'stream-broken' && record.streamError) {
      const kind = /无响应|超时|timed? ?out/i.test(record.streamError) ? 'slow' : 'outage'
      const key = errKey(kind, null)
      b.errors[key] = (b.errors[key] || 0) + 1
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

/** 幂等：诊断相关的新键（错误账本 + 供给表现时间序列）不存在就补上。migrate 和读取路径都调它。 */
export function ensureDiagnosisKeys(db) {
  if (!db.errorbook || typeof db.errorbook !== 'object') db.errorbook = {}
  if (!db.offerStats || typeof db.offerStats !== 'object') db.offerStats = {}
  if (!Array.isArray(db.checkups)) db.checkups = []
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
