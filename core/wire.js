/**
 * 协议适配层：网关内部只认一套形状，两种上游协议各自翻译过来。
 *
 * 为什么单独一个文件：Chat Completions 和 Responses 的差异不只是路径，而是
 * 三个地方都不在一处——
 *
 *   1. usage 字段名不同（prompt_tokens/completion_tokens vs input_tokens/output_tokens）
 *   2. 流式事件的结构完全不同（choices[].delta vs 一堆 type 命名的 SSE 事件）
 *   3. 失败的表达方式不同（顶层 error 字段 vs `error` / `response.failed` 事件）
 *
 * 第 3 点最要紧：网关的核心能力是「还没向客户端提交就能静默换站」。Responses
 * 的失败可能以 HTTP 400 直接返回（没有 SSE），也可能在 200 的流里以
 * `response.failed` 事件出现。漏判任意一种，都会把错误当成成功写回去，
 * 换站能力直接失效。
 *
 * 这里只做「翻译」，不做路由、不碰计费口径——上游返回什么就翻成网关认识的
 * 形状，怎么用由调用方决定。
 */

/** Responses 的终态事件；流到这两个之一就说明这一轮结束了 */
const RESPONSES_TERMINAL = new Set(['response.completed', 'response.incomplete'])

/** 客户端请求路径 → 协议名。返回 null 表示这个路径不归网关代理 */
export function protocolForPath(pathname) {
  if (pathname === '/v1/responses') return 'responses'
  if (pathname === '/v1/chat/completions') return 'chat'
  return null
}

/** 协议名 → 上游要打的路径 */
export function upstreamPath(protocol) {
  return protocol === 'responses' ? '/responses' : '/chat/completions'
}

/**
 * usage 归一化：网关只按 Chat 的字段名消费（prompt_tokens / completion_tokens），
 * 所以 Responses 的 usage 在进网关之前必须改名。
 *
 * 保留原始字段不动，只补上网关要用的那几个——将来要看上游原始口径时还能查到。
 */
export function normalizeUsage(protocol, raw) {
  if (!raw) return null
  if (protocol !== 'responses') return raw

  const inputDetails = raw.input_tokens_details || {}
  const outputDetails = raw.output_tokens_details || {}
  const promptTokens = raw.input_tokens ?? raw.prompt_tokens
  const completionTokens = raw.output_tokens ?? raw.completion_tokens

  // Responses 把缓存命中放在 input_tokens_details.cached_tokens，
  // Chat 放在 prompt_tokens_details.cached_tokens。网关下游只读后一个位置，
  // 所以这里改名而不只是搬运
  const cachedTokens =
    inputDetails.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? 0

  return {
    ...raw,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens:
      raw.total_tokens ?? (Number(promptTokens) || 0) + (Number(completionTokens) || 0),
    prompt_tokens_details: {
      ...(raw.prompt_tokens_details || {}),
      cached_tokens: cachedTokens,
    },
    completion_tokens_details: {
      ...(raw.completion_tokens_details || {}),
      reasoning_tokens:
        outputDetails.reasoning_tokens ??
        raw.completion_tokens_details?.reasoning_tokens ??
        0,
    },
  }
}

/** 从 message.content（字符串或分段数组）里取出纯文本长度 */
function textLength(content) {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const part of content) if (typeof part?.text === 'string') total += part.text.length
  return total
}

const TOOL_ITEM_TYPES = new Set(['function_call', 'custom_tool_call', 'tool_call'])

/** Responses 里纯生命周期、不含任何正文的事件：先攒着，不靠它们提交 */
const RESPONSES_LIFECYCLE = new Set([
  'response.created',
  'response.in_progress',
  'response.queued',
])

/**
 * 流式检查器：边解析边累积「这一轮到底发生了什么」。
 *
 * inspect() 返回：
 *   error —— 上游报错。调用方在还没 commit 时要立刻换站
 *   drop  —— 这一块不该转给客户端（Chat 的 usage-only 收尾 chunk，
 *            客户端没要 include_usage 时滤掉）
 *   hold  —— 纯生命周期事件，先攒着不要提交。Responses 的第一个事件永远是
 *            response.created，里面没有正文；见到它就提交会把紧随其后的
 *            response.failed 变成「已提交的流」，换站能力静默失效
 *
 * Chat 和 Responses 在「要不要转发终态事件」上不一样：Responses 的
 * response.completed 里带着 usage，而且 Codex 这类客户端要靠它收尾，
 * 所以永远不丢。Chat 的 usage chunk 是网关自己要的，可以藏起来。
 */
export function createStreamInspector(protocol, { clientWantsUsage = false } = {}) {
  const state = { usage: null, contentChars: 0, hasToolCalls: false, finishReason: null }

  if (protocol === 'responses') {
    return {
      state,
      inspect(parsed) {
        // 兼容层不用 type 而直接回一个 response 对象的，按终态处理
        const type =
          parsed?.type || (parsed?.object === 'response' ? 'response.completed' : null)

        // 失败的第一种形态：顶层 error 事件。部分兼容层直接发 {"type":"error",...}
        if (type === 'error') {
          const message =
            parsed.error?.message || parsed.message || parsed.error?.type || '上游返回 error 事件'
          return { error: message }
        }

        // 失败的第二种形态：跑到一半失败，仍然是 200 的流
        if (type === 'response.failed') {
          const err = parsed.response?.error
          const message =
            err?.message || err?.code || '上游 response.failed（未给出原因）'
          return { error: message }
        }

        if (type === 'response.output_text.delta') {
          state.contentChars += String(parsed.delta || '').length
        } else if (
          type === 'response.reasoning_summary_text.delta' ||
          type === 'response.reasoning_text.delta'
        ) {
          // 思考摘要也算「有内容」：只输出思考、正文为空的响应不该被判成空回答
          state.contentChars += String(parsed.delta || '').length
        } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
          if (TOOL_ITEM_TYPES.has(parsed.item?.type)) state.hasToolCalls = true
        } else if (RESPONSES_TERMINAL.has(type)) {
          const response = parsed.response || {}
          state.usage = normalizeUsage('responses', response.usage) || state.usage
          if (type === 'response.incomplete') state.finishReason = 'length'

          // 有些兼容层一个 delta 都不发，只在终态里给整段 output。
          // 只在没收到任何增量时兜底，否则会把同一段正文数两遍。
          if (state.contentChars === 0) {
            for (const item of response.output || []) {
              if (item?.type === 'message') {
                for (const part of item.content || []) {
                  if (typeof part?.text === 'string') state.contentChars += part.text.length
                }
              }
              if (TOOL_ITEM_TYPES.has(item?.type)) state.hasToolCalls = true
            }
          }
          if (!state.finishReason) {
            state.finishReason = state.hasToolCalls ? 'tool_calls' : 'stop'
          }
          // 终态不 hold：它本身就该提交
          return {}
        }

        // 纯生命周期事件先攒着（见上方注释：否则 response.failed 拦不住）
        if (RESPONSES_LIFECYCLE.has(type)) return { hold: true }
        return {}
      },
    }
  }

  // ---- Chat Completions ----
  return {
    state,
    inspect(parsed) {
      if (parsed?.usage) state.usage = parsed.usage

      const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null
      if (choice) {
        const delta = choice.delta || {}
        if (typeof delta.content === 'string') state.contentChars += delta.content.length
        if (typeof delta.reasoning_content === 'string') {
          state.contentChars += delta.reasoning_content.length
        }
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
          state.hasToolCalls = true
        }
        if (choice.finish_reason) state.finishReason = choice.finish_reason
      }

      // 第一个事件就是错误：还没提交，可以换站
      if (parsed?.error) {
        return { error: parsed.error.message || '上游返回 error' }
      }

      // 只带 usage 的收尾 chunk，客户端没要求就别塞给它
      const usageOnly =
        parsed && Array.isArray(parsed.choices) && parsed.choices.length === 0 && parsed.usage
      if (usageOnly && !clientWantsUsage) return { drop: true }

      return {}
    },
  }
}

/**
 * 非流式响应的解析：把两种协议各自翻成 { error } 或 { usage, realCheck }。
 */
export function extractNonStream(protocol, payload) {
  if (protocol === 'responses') {
    if (payload?.error) {
      return { error: payload.error.message || '上游返回 error 字段' }
    }
    // 有的兼容层用 HTTP 200 + status:"failed" 表达失败
    if (payload?.status === 'failed') {
      const err = payload.error
      return { error: err?.message || err?.code || '上游 response 失败（status=failed）' }
    }

    const usage = normalizeUsage('responses', payload?.usage)
    let contentChars = 0
    let hasToolCalls = false
    for (const item of payload?.output || []) {
      if (item?.type === 'message') contentChars += textLength(item.content)
      if (TOOL_ITEM_TYPES.has(item?.type)) hasToolCalls = true
    }
    const finishReason =
      payload?.status === 'incomplete' ? 'length' : hasToolCalls ? 'tool_calls' : 'stop'

    return {
      usage: usage || null,
      realCheck: {
        contentChars,
        hasToolCalls,
        finishReason,
        promptTokens: usage?.prompt_tokens ?? null,
      },
    }
  }

  if (payload?.error) {
    return { error: payload.error.message || '上游返回 error 字段' }
  }
  const usage = payload?.usage || null
  const choice = payload?.choices?.[0]
  const message = choice?.message || {}
  return {
    usage,
    realCheck: {
      contentChars: (message.content || '').length + (message.reasoning_content || '').length,
      hasToolCalls: Boolean(message.tool_calls?.length),
      finishReason: choice?.finish_reason ?? null,
      promptTokens: usage?.prompt_tokens ?? null,
    },
  }
}
