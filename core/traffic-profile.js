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
  // 支持性判定要求「所有探测都说不支持」（且至少两条）：以前只要有一条说不支持就
  // 一票否决成 0，历史脏记录会把支持缓存的站永久锁死在场外（实测 8 个站受害）。
  const supportRows = rows.filter((row) => typeof row?.cacheSupported === 'boolean')
  if (supportRows.length >= 2 && supportRows.every((row) => row.cacheSupported === false)) {
    return { rate: 0, source: 'unsupported', samples: supportRows.length, lowConfidence: false }
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
    // 命中率来源：actual=逐单真实样本（默认），probe=探针中位，legacy=不折缓存（旧口径）
    cacheSource: raw.cacheSource === 'probe' ? 'probe' : raw.cacheSource === 'legacy' ? 'legacy' : 'actual',
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

/* ───────────── 真实请求样本 → 实际命中率（逐单，非抽样） ───────────── */

/** 少于 3 单 warm 样本时不敢当结论（1 单可能就是冷启动） */
export const CACHE_ACTUAL_MIN_SAMPLES = 3

/** 少于这么多 warm token 时，收缩后仍标低置信 */
export const CACHE_ACTUAL_MIN_TOKENS = 500_000

/**
 * 收缩强度（alpha）：相当于「先验值自带这么多 token 的权重」。
 * 500k ≈ 你库里一个模型一天的输入量，样本到这个量级才明显压过先验。
 */
export const CACHE_SHRINK_TOKENS = 500_000

/** 距上一单超过这么久且几乎没命中 → 认为是缓存过期后的冷启动 */
export const CACHE_COLD_GAP_MS = 10 * 60 * 1000

/** prompt 比上一单涨这么多且几乎没命中 → 前缀变了（新会话/换了系统提示） */
export const CACHE_COLD_PROMPT_RATIO = 1.3

/** 判定「几乎没命中」的阈值 */
export const CACHE_COLD_HIT_FLOOR = 0.2

/**
 * 把逐单样本分成 warm / cold。
 *
 * 冷启动单是真实数据，但不是「这个站的缓存能力」——把它算进命中率，
 * 会出现「一次新会话把 95% 的站打成 5%」这种噪声（RapidApi 实测就是这样：
 * 3 单里 1 单 231k prompt 只有 13k 命中）。
 *
 * @param {Array<{at:number,prompt:number,cached:number,cacheWrite?:number}>} samples 按 at 升序
 */
export function splitCacheSamples(samples = []) {
  const warm = []
  const cold = []
  // 样本可能来自两处：网关逐单记账写的是 promptTokens/cachedTokens，
  // 测试与旧记录用 prompt/cached —— 这里统一成短名，两边的字段都能吃
  const list = (samples || [])
    .map((row) => ({
      ...row,
      prompt: Number(row?.prompt ?? row?.promptTokens) || 0,
      cached: Number(row?.cached ?? row?.cachedTokens) || 0,
      cacheWrite: Number(row?.cacheWrite ?? row?.cacheWriteTokens) || 0,
    }))
    .filter((row) => row && Number.isFinite(row.at) && row.prompt > 0)
    .sort((a, b) => a.at - b.at)

  for (const row of list) {
    const prompt = Number(row.prompt) || 0
    const cached = Number(row.cached) || 0
    const write = Number(row.cacheWrite) || 0
    const billed = Math.max(prompt, cached + write)
    const hit = billed > 0 ? cached / billed : 0
    const prev = warm[warm.length - 1]
    const firstCold = warm.length === 0 && cold.length < 2
    const wroteOnly = write > 0 && cached === 0
    const staleGap = Boolean(prev) && row.at - prev.at > CACHE_COLD_GAP_MS && hit < CACHE_COLD_HIT_FLOOR
    const bigger = Boolean(prev) && prompt > prev.prompt * CACHE_COLD_PROMPT_RATIO && hit < CACHE_COLD_HIT_FLOOR
    // 前缀变大比「隔太久」更具体：后者可能是同一条会话后面接了长附件，先报 prefix
    if (firstCold || wroteOnly || bigger || staleGap) {
      cold.push({ ...row, reason: wroteOnly ? 'cache-write' : firstCold ? 'first' : bigger ? 'prefix' : 'stale' })
      continue
    }
    warm.push(row)
  }
  return { warm, cold }
}

/**
 * 某条供给的「实际命中率」：只用 warm 样本，按 token 加权，再做收缩。
 *
 * 收缩 h = (Σcached + α·prior) / (Σbilled + α)
 * 样本少时 h 被拉向先验（不会因为一单 5% 就判死），样本多时贴近实测。
 *
 * @param {{offerId:string, samples?:object[], prior?:number, shrinkTokens?:number}} input
 */
export function cacheActualOf({ offerId, samples = [], prior = CACHE_HIT_PRIOR, shrinkTokens = CACHE_SHRINK_TOKENS } = {}) {
  const mine = (samples || []).filter((row) => row?.offerId === offerId)
  const { warm, cold } = splitCacheSamples(mine)
  let cached = 0
  let billed = 0
  for (const row of warm) {
    const c = Number(row.cached) || 0
    const w = Number(row.cacheWrite) || 0
    const p = Number(row.prompt) || 0
    cached += c
    billed += Math.max(p, c + w)
  }
  const safePrior = Number.isFinite(prior) ? Math.min(1, Math.max(0, prior)) : CACHE_HIT_PRIOR
  const alpha = Number.isFinite(shrinkTokens) && shrinkTokens >= 0 ? shrinkTokens : CACHE_SHRINK_TOKENS
  const raw = billed > 0 ? cached / billed : null
  if (warm.length === 0) {
    return {
      rate: safePrior,
      raw: null,
      source: 'prior',
      warmSamples: 0,
      coldSamples: cold.length,
      warmTokens: 0,
      lowConfidence: true,
    }
  }
  const rate = (cached + alpha * safePrior) / (billed + alpha)
  return {
    rate,
    raw,
    source: 'actual',
    warmSamples: warm.length,
    coldSamples: cold.length,
    warmTokens: billed,
    lowConfidence: warm.length < CACHE_ACTUAL_MIN_SAMPLES || billed < CACHE_ACTUAL_MIN_TOKENS,
  }
}
