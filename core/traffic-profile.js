/**
 * 流量画像：把「用户实际怎么用」变成选站时可以代入的数字。
 *
 * 三个量，各有明确来源，缺数据时回落到先验并标记置信度——不猜、不静默当成 0：
 *
 *   inputShare   输入 token 占总 token 的比例。你的库实测 99.6%（大量长上下文），
 *                所以「输入 25% / 输出 75%」的旧混合价把便宜输入价的优势压掉了。
 *   cacheHitRate 缓存命中率。命中部分按缓存价（约输入价 1/10）计费，
 *                所以它是**价格折扣**，不是质量指标——不能塞进质量层重复计算。
 *   tps / ttft   速度，只做打平链，不进质量（换算成钱没有依据，且含本机链路）。
 *
 * 所有函数都是纯函数：传进来的都是已经读好的数据，方便单测。
 */

/** 少于这么多个「模型×天」样本时，不采信流量画像，回落到设置里的固定值 */
export const PROFILE_MIN_SAMPLES = 20

/** 设置里没配、流量也不够时的兜底：输入占比与缓存折扣 */
export const DEFAULT_INPUT_SHARE = 0.9
export const DEFAULT_CACHE_DISCOUNT = 0.9

/**
 * 缓存命中率拿不到时的先验值。
 * 取全局中位而不是 0：这批站几乎都支持缓存（实测 75%~99.7%），
 * 把「没测到」当 0 会系统性惩罚新站和探针测不到缓存的站——那正是
 * 「没证据 = 最差」的老毛病。
 */
export const CACHE_HIT_PRIOR = 0.85

/** 真实流量里至少要有这么多条计费样本，才用它算命中率 */
export const CACHE_HIT_MIN_SAMPLES = 3

export function medianOf(values) {
  const list = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (list.length === 0) return null
  const mid = Math.floor(list.length / 2)
  return list.length % 2 === 1 ? list[mid] : (list[mid - 1] + list[mid]) / 2
}

/**
 * 输入 token 占比。
 *
 * @param {object} usageDays usage.json 的 days：`{ 'YYYY-MM-DD': { '<key>': {input, output, cached, ...} } }`
 * @returns {{share:number|null, samples:number, inputTokens:number, outputTokens:number, cachedTokens:number}}
 */
export function inputShareOf(usageDays) {
  let inputTokens = 0
  let outputTokens = 0
  let cachedTokens = 0
  let samples = 0
  for (const day of Object.values(usageDays || {})) {
    for (const entry of Object.values(day || {})) {
      const input = Number(entry?.input) || 0
      const output = Number(entry?.output) || 0
      if (input <= 0 && output <= 0) continue
      inputTokens += input
      outputTokens += output
      cachedTokens += Number(entry?.cached) || 0
      samples += 1
    }
  }
  const total = inputTokens + outputTokens
  return {
    share: samples >= PROFILE_MIN_SAMPLES && total > 0 ? inputTokens / total : null,
    samples,
    inputTokens,
    outputTokens,
    cachedTokens,
  }
}

/**
 * 某条供给的缓存命中率。
 *
 * 优先级：真实流量（最可信）→ 探针（受控 prompt，命中率偏高）→ 明确不支持 → 先验。
 *
 * @param {{offerId:string, probes?:object[], billingSamples?:object[], prior?:number}} input
 * @returns {{rate:number, source:'traffic'|'probe'|'unsupported'|'prior'|'none', samples:number, lowConfidence:boolean}}
 */
export function cacheHitRateOf({ offerId, probes = [], billingSamples = [], prior = CACHE_HIT_PRIOR } = {}) {
  const traffic = (billingSamples || [])
    .filter((row) => row?.offerId === offerId && Number(row?.reportedPrompt) > 0)
    .map((row) => Math.min(1, Math.max(0, (Number(row.reportedCached) || 0) / Number(row.reportedPrompt))))
  if (traffic.length >= CACHE_HIT_MIN_SAMPLES) {
    return { rate: medianOf(traffic), source: 'traffic', samples: traffic.length, lowConfidence: false }
  }

  const rows = (probes || []).filter((row) => row?.offerId === offerId)
  // 明确测出「不支持缓存」就是真实值 0，不该用先验覆盖
  if (rows.some((row) => row?.cacheSupported === false)) {
    return { rate: 0, source: 'unsupported', samples: rows.length, lowConfidence: false }
  }
  const hits = rows.map((row) => row?.cacheHitRate).filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (hits.length > 0) {
    return {
      rate: medianOf(hits),
      source: 'probe',
      samples: hits.length,
      lowConfidence: hits.length < CACHE_HIT_MIN_SAMPLES,
    }
  }
  return { rate: prior, source: 'prior', samples: 0, lowConfidence: true }
}

/** 输出速度（token/秒）：只算「首字之后」的时间，否则会把排队时间算成慢 */
export function tpsOf(probes = [], offerId = null) {
  const rates = (probes || [])
    .filter((row) => !offerId || row?.offerId === offerId)
    .map((row) => {
      const latency = Number(row?.latencyMs)
      const ttft = Number(row?.ttftMs)
      const tokens = Number(row?.completionTokens)
      if (!Number.isFinite(latency) || !Number.isFinite(ttft) || !Number.isFinite(tokens)) return null
      const span = (latency - ttft) / 1000
      if (span <= 0 || tokens <= 0) return null
      return tokens / span
    })
    .filter((v) => v !== null)
  return medianOf(rates)
}

/**
 * 首字延迟的相对值：减去同组最小值。
 * 绝对值里含本机到机房的链路时间，跨站不可比；相对值能抵消掉一部分本机波动。
 */
export function relativeToMin(value, values) {
  const list = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (typeof value !== 'number' || !Number.isFinite(value) || list.length === 0) return null
  return Math.max(0, value - Math.min(...list))
}

/**
 * 归一化设置里的成本口径。缺字段一律回落到本文件的默认值，
 * 这样老库（没有 costProfile）升级后行为可预测。
 */
export function costProfileOf(settings = {}) {
  const raw = settings?.costProfile || {}
  const share = raw.inputShare === 'auto' || raw.inputShare === undefined ? 'auto' : Number(raw.inputShare)
  const discount = Number(raw.cacheDiscount)
  return {
    mode: raw.mode === 'legacy' ? 'legacy' : 'expected',
    inputShare: share === 'auto' ? 'auto' : Number.isFinite(share) && share >= 0 && share <= 1 ? share : 'auto',
    cacheDiscount: Number.isFinite(discount) && discount >= 0 && discount <= 1 ? discount : DEFAULT_CACHE_DISCOUNT,
    cacheDiscountEnabled: raw.cacheDiscountEnabled === false ? false : true,
  }
}

/**
 * 有效输入价：命中缓存的那部分按 (1 − k) 折算。
 *
 * 不用每站自己的缓存价（多数站没公布，且口径不一），只用一个全局折扣 k：
 * DeepSeek 缓存价约输入价 1/10，OpenAI 约 1/4，取 0.9 覆盖主流。
 */
export function effectiveInPrice(inUsdPerMtok, hitRate, discount = DEFAULT_CACHE_DISCOUNT) {
  if (typeof inUsdPerMtok !== 'number' || !Number.isFinite(inUsdPerMtok)) return null
  if (typeof hitRate !== 'number' || !Number.isFinite(hitRate)) return inUsdPerMtok
  const k = Math.min(1, Math.max(0, discount))
  return inUsdPerMtok * (1 - Math.min(1, Math.max(0, hitRate)) * k)
}

/** 混合价 = 有效输入价 × 输入占比 + 输出价 × 输出占比 */
export function blendedWithProfile({ inUsdPerMtok, outUsdPerMtok, inputShare, hitRate, cacheDiscount, cacheDiscountEnabled = true }) {
  const inPrice = cacheDiscountEnabled ? effectiveInPrice(inUsdPerMtok, hitRate, cacheDiscount) : inUsdPerMtok
  const share = typeof inputShare === 'number' && Number.isFinite(inputShare) ? Math.min(1, Math.max(0, inputShare)) : DEFAULT_INPUT_SHARE
  if (inPrice === null && outUsdPerMtok === null) return null
  if (inPrice === null) return outUsdPerMtok
  if (typeof outUsdPerMtok !== 'number' || !Number.isFinite(outUsdPerMtok)) return inPrice
  return inPrice * share + outUsdPerMtok * (1 - share)
}
