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

/**
 * 累加一个 content 分段的文本量。
 *
 * 两种协议的 content 形状不同但都可枚举：Chat 是 {type:'text',text}，
 * Responses 是 {type:'input_text'|'output_text',text}。这里不区分类型，
 * 只认 text 字段——免得每加一种分段类型就要改一遍估算。
 */
function addContentTokens(total, content) {
  if (typeof content === 'string') return total + estimateTokens(content)
  if (!Array.isArray(content)) return total
  let next = total
  for (const part of content) {
    if (typeof part?.text === 'string') next += estimateTokens(part.text)
  }
  return next
}

/**
 * 估算一次请求的输入规模（正文 + 工具定义）。
 *
 * 必须同时认 body.messages（Chat）和 body.input（Responses）：只认 messages
 * 的话，所有 Responses 请求的估算值都是 0，而估算值为 0 会让「计费虚报」
 * 检查直接短路（见 checkRealResponse 里 requestTokens > 0 的前置条件）——
 * 等于这条路请求完全不核价。
 */
export function estimateRequestTokens(body) {
  if (!body) return 0
  let total = 0

  // Chat Completions：messages[]
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const message of messages) {
    total = addContentTokens(total, message?.content)
  }

  // Responses：instructions + input（字符串，或 item 数组）
  if (typeof body.instructions === 'string') total += estimateTokens(body.instructions)
  if (typeof body.input === 'string') {
    total += estimateTokens(body.input)
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item) continue
      total = addContentTokens(total, item.content)
      // function_call_output 的工具结果藏在 output 里，同样是真实输入规模
      if (typeof item.output === 'string') total += estimateTokens(item.output)
      if (typeof item.arguments === 'string') total += estimateTokens(item.arguments)
    }
  }

  if (body.tools) total += estimateTokens(JSON.stringify(body.tools))
  return total
}

/**
 * @param {{contentChars:number, hasToolCalls:boolean, finishReason:string|null, promptTokens:number|null, requestTokens:number}} input
 * @returns {{empty: boolean, billingInflated: boolean, bad: boolean}}
 */
export function checkRealResponse({
  contentChars = 0,
  hasToolCalls = false,
  finishReason = null,
  promptTokens = null,
  requestTokens = 0,
} = {}) {
  // 空回答：正常结束却一个字都没有。有工具调用或只有 reasoning 的响应不算
  const empty = contentChars === 0 && !hasToolCalls && (finishReason === null || finishReason === 'stop')
  const inflated =
    typeof promptTokens === 'number' &&
    promptTokens > BILLING_MIN_TOKENS &&
    requestTokens > 0 &&
    promptTokens > requestTokens * BILLING_TOLERANCE_RATIO
  return { empty, billingInflated: inflated, bad: empty || inflated }
}
