/**
 * 真实流量的质量信号：探针之外的第二类完整性证据。
 *
 * 探针能验指纹（问固定题看答得对不对）、截断（让它数到 120），但真实请求的
 * prompt 是用户自己的，这两项没法验——我们不知道正确答案是什么。真实流量
 * 能验的只有两类**客观**异常，而且必须保守（误判会把好站拉黑）：
 *
 *   空回答 —— 200 成功、finish_reason=stop，但一个字都没吐（也没有工具调用、
 *             没有 reasoning_content）。反代链路出问题时的典型症状。
 *   计费虚报 —— 上报的 prompt_tokens 远大于请求体估算规模。估算用字符启发式
 *             （中日韩 1 字≈1 token，其余 4 字符≈1 token），容差放到 4 倍，
 *             只抓「明显虚报」，不做精细对账。
 *
 * 这两项只记录、按样本量定性：样本少于 REAL_QUALITY_MIN_SAMPLES 时不下结论。
 */

/** 判定「真实响应异常」所需的最少样本：少于这个数只记录不判定 */
export const REAL_QUALITY_MIN_SAMPLES = 5
/** 异常率超过这个值才判「结果可疑」 */
export const REAL_QUALITY_BAD_RATE = 0.2
/** 上报 tokens 超过估算的多少倍算虚报（宽松，只抓明显异常） */
export const BILLING_TOLERANCE_RATIO = 4
/** 低于这个绝对值不判虚报（短请求的估算误差太大） */
export const BILLING_MIN_TOKENS = 800

/**
 * 缓存命中率超过这个值才算可疑。
 * 取 0.999 而不是 0.98：长系统提示被缓存时 98%~99.7% 的命中是正常的
 * （RapidApi 实测 99.76%），只有「几乎全部命中」才像在拿缓存洗白计费。
 */
export const CACHE_SUSPECT_RATIO = 0.999

/** 低于这个 prompt 长度时，全命中有可能是正常的短请求，不算可疑 */
export const CACHE_SUSPECT_MIN_PROMPT = 5000

const CJK = /[\u3000-\u9fff\uff00-\uffef]/

/**
 * 粗略估算 token 数：中日韩字符按 1 个 token，其余按 4 字符 1 个 token。
 * 只用于「数量级对不对」的判断，不追求精确。
 */
export function estimateTokens(text) {
  const str = String(text || '')
  if (!str) return 0
  let cjk = 0
  for (const ch of str) if (CJK.test(ch)) cjk += 1
  const rest = str.length - cjk
  return cjk + Math.ceil(rest / 4)
}

/** 估算一次请求的输入规模（messages 正文 + 工具定义） */
export function estimateRequestTokens(body) {
  if (!body) return 0
  let total = 0
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const message of messages) {
    if (typeof message?.content === 'string') total += estimateTokens(message.content)
    else if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (typeof part?.text === 'string') total += estimateTokens(part.text)
      }
    }
  }
  if (body.tools) total += estimateTokens(JSON.stringify(body.tools))
  return total
}

/**
 * 一次真实响应的客观异常。
 *
 * 计费异常分两个判据，用途完全不同（以前只有一个，把「长上下文 + 高缓存命中」
 * 误判成虚报，把 RapidApi 这类站按 450 倍上报的固定开销也混在一起）：
 *
 * - `billingInflated`：上报的 prompt_tokens 远超本地估算。**只做展示**，
 *   因为 prompt 里含缓存部分，命中 99% 时 raw 值必然远超估算，但那段按缓存价
 *   收费，不是多算钱。它真正说明的是「这个站有 N token 的固定开销」。
 * - `billedInputInflated`：把缓存命中扣掉之后仍然离谱，才是真的多算钱。
 *   这一项才进完整性扣分。
 *
 * @param {{contentChars:number, hasToolCalls:boolean, finishReason:string|null,
 *   promptTokens:number|null, requestTokens:number, cachedTokens:number|null}} input
 * @returns {{empty:boolean, billingInflated:boolean, billedInputInflated:boolean,
 *   cacheSuspect:boolean, bad:boolean}}
 */
export function checkRealResponse({
  contentChars = 0,
  hasToolCalls = false,
  finishReason = null,
  promptTokens = null,
  requestTokens = 0,
  cachedTokens = null,
} = {}) {
  // 空回答：正常结束却一个字都没有。有工具调用或只有 reasoning 的响应不算
  const empty = contentChars === 0 && !hasToolCalls && (finishReason === null || finishReason === 'stop')
  const hasPrompt = typeof promptTokens === 'number' && Number.isFinite(promptTokens)
  const cached = typeof cachedTokens === 'number' && Number.isFinite(cachedTokens) ? cachedTokens : 0
  const inflated =
    hasPrompt &&
    promptTokens > BILLING_MIN_TOKENS &&
    requestTokens > 0 &&
    promptTokens > requestTokens * BILLING_TOLERANCE_RATIO
  const billedInput = hasPrompt ? Math.max(0, promptTokens - cached) : null
  const billedInputInflated =
    billedInput !== null &&
    billedInput > BILLING_MIN_TOKENS &&
    requestTokens > 0 &&
    billedInput > requestTokens * BILLING_TOLERANCE_RATIO
  // 缓存数据本身不可信：命中比 prompt 还多，或者几乎全命中（谎报缓存能洗白计费）
  const cacheSuspect =
    hasPrompt &&
    cached > 0 &&
    (cached > promptTokens || (promptTokens > CACHE_SUSPECT_MIN_PROMPT && cached / promptTokens > CACHE_SUSPECT_RATIO))
  return {
    empty,
    billingInflated: inflated,
    billedInputInflated,
    cacheSuspect,
    bad: empty || billedInputInflated,
  }
}
