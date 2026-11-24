/**
 * 上游 usage 的字段归一。
 *
 * 各家中转站在同一个 OpenAI 兼容响应里放缓存数字的位置不一样，实测见过的有：
 *   prompt_tokens_details.cached_tokens       （OpenAI 官方口径）
 *   input_tokens_details.cached_tokens        （部分 Anthropic 兼容层）
 *   cached_tokens                             （简化版中转）
 *   prompt_cache_hit_tokens                   （DeepSeek 直连）
 *   cache_read_input_tokens                   （Anthropic 原生）
 *
 * 以前这里只读前两个，release 分支统计过：12179 条真实请求里 544 条命中被漏掉，
 * 于是北辰那种站的缓存命中被系统性低估（真实 37.9% 被写成 26.8%），
 * 而命中率又会折进价格，等于按错误的折扣选站。
 *
 * 取「最大的那个」而不是第一个存在的：有的站两个字段都返回，其中一个恒为 0。
 *
 * 注意与「站点没报缓存」区分：
 *   cached 字段一个都没有 → hasCacheFields=false，这时不知道该站是不支持缓存
 *   还是只是没写字段，调用方不能当成 0 命中（那会把支持缓存的站判死刑）。
 */

const CACHED_FIELDS = [
  (usage) => usage?.prompt_tokens_details?.cached_tokens,
  (usage) => usage?.input_tokens_details?.cached_tokens,
  (usage) => usage?.cached_tokens,
  (usage) => usage?.prompt_cache_hit_tokens,
  (usage) => usage?.cache_read_input_tokens,
]

const CACHE_WRITE_FIELDS = [
  (usage) => usage?.cache_creation_input_tokens,
  (usage) => usage?.prompt_tokens_details?.cache_creation_tokens,
  (usage) => usage?.input_tokens_details?.cache_creation_tokens,
  (usage) => usage?.prompt_cache_write_tokens,
]

function pickMax(usage, fields) {
  let best = null
  for (const field of fields) {
    const value = Number(field(usage))
    if (!Number.isFinite(value)) continue
    if (best === null || value > best) best = value
  }
  return best
}

/**
 * 把一次上游响应的 usage 拆成「计费输入」的组成部分。
 *
 * 计费输入 = 净输入 + 缓存读 + 缓存写 —— 这与站点账单同分母，
 * 所以 cached / billedInput 就是「钱意义上的缓存命中率」。
 *
 * @returns {{promptTokens:number|null, completionTokens:number|null, cachedTokens:number,
 *   cacheWriteTokens:number, netInputTokens:number|null, billedInputTokens:number|null,
 *   hitRate:number|null, hasCacheFields:boolean}}
 */
export function usageNumbers(usage) {
  const promptRaw = usage?.prompt_tokens ?? usage?.input_tokens
  const promptTokens = Number.isFinite(Number(promptRaw)) ? Number(promptRaw) : null
  const completionRaw = usage?.completion_tokens ?? usage?.output_tokens
  const completionTokens = Number.isFinite(Number(completionRaw)) ? Number(completionRaw) : null

  const cached = pickMax(usage, CACHED_FIELDS)
  const cacheWrite = pickMax(usage, CACHE_WRITE_FIELDS)
  const hasCacheFields = cached !== null || cacheWrite !== null

  const cachedTokens = Math.max(0, cached ?? 0)
  const cacheWriteTokens = Math.max(0, cacheWrite ?? 0)

  if (promptTokens === null) {
    return {
      promptTokens: null,
      completionTokens,
      cachedTokens,
      cacheWriteTokens,
      netInputTokens: null,
      billedInputTokens: null,
      hitRate: null,
      hasCacheFields,
    }
  }

  // prompt_tokens 通常含缓存读与缓存写；个别站报的是「净输入」，这时减出负数，钳到 0
  const netInputTokens = Math.max(0, promptTokens - cachedTokens - cacheWriteTokens)
  const billedInputTokens = netInputTokens + cachedTokens + cacheWriteTokens
  // 站点压根没报缓存字段时，命中率是「不知道」，不是 0 —— 当成 0 会把支持缓存的站
  // 的价值直接抹掉（折进价格后等于多算 6.7 倍输入成本）
  const hitRate = hasCacheFields && billedInputTokens > 0 ? Math.min(1, cachedTokens / billedInputTokens) : null

  return {
    promptTokens,
    completionTokens,
    cachedTokens,
    cacheWriteTokens,
    netInputTokens,
    billedInputTokens,
    hitRate,
    hasCacheFields,
  }
}