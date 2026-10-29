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

/**
 * 一帧 SSE 的 data 行到底是哪一类（**唯一实现**：解析与判定只能在这里写一次）。
 *
 * 为什么要单独分类：以前解析失败一律「当作心跳原样转发」，于是三种完全不同的
 * 东西挤进了同一个假身份——
 *
 *   json       正常载荷（含 usage-only 收尾块）
 *   done       [DONE] 收尾哨兵
 *   text       心跳/keepalive：上游真的会发 `data: ping` 这种纯文本，转发无害
 *   malformed  **看着像 JSON 却解析不了**：上游把帧写坏了（连接断在半截、编码错、
 *              前面少了半个花括号）。这种帧发给客户端就是一记 deterministic 崩溃——
 *              OpenAI SDK 会在 JSON.parse 处直接抛「malformed server-sent event JSON」，
 *              客户端把整轮回答丢掉，而网关还以为自己成功交付了。所以它必须算流错误。
 *
 * 判据用「首字符像不像 JSON 容器」而不是「长得像不像心跳」：心跳谁都能造，
 * 但一个以 { 或 [ 开头却没有配平的 data 行，只可能是坏帧。
 */
export function dataLineKind(payloadText) {
  if (!payloadText) return 'none'
  if (payloadText === '[DONE]') return 'done'
  try {
    JSON.parse(payloadText)
    return 'json'
  } catch {
    return /^[[{]/.test(payloadText) ? 'malformed' : 'text'
  }
}

/** 客户端请求路径 → 协议名。返回 null 表示这个路径不归网关代理 */
export function protocolForPath(pathname) {
  if (pathname === '/v1/responses') return 'responses'
  if (pathname === '/v1/chat/completions') return 'chat'
  return null
}

/** 坏帧 → 给人看的错误文本（路由日志、错误账本、诊断页共用一句） */
export function malformedFrameError(payloadText) {
  const head = String(payloadText || '').replace(/\s+/g, ' ').slice(0, 80)
  return `上游送出损坏的 SSE 帧（无法解析为 JSON）：${head}`
}

/** 半截帧（流结束时还没有 \n\n 收尾的 data 行）也算坏帧 */
export function truncatedFrameError(payloadText) {
  const head = String(payloadText || '').replace(/\s+/g, ' ').slice(0, 80)
  return `上游的流在帧中间断掉（残留半截 SSE 帧）：${head}`
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

/**
 * 上游 usage → 网关自己的数字口径（**唯一实现**）。
 *
 * 为什么必须收在一处：同一份用量在不同上游里字段名完全不同，而且同一家还会
 * 同时回好几个别名（实测 sub2api 一个 usage 里既有 prompt_tokens_details.cached_tokens
 * 又有 prompt_cache_hit_tokens / cache_read_input_tokens）。网关、决策日志、详细用量页
 * 各写一份取值顺序，迟早出现「汇总说命中 40%、明细说命中 0%」这种对不上的账。
 *
 * 取值规则：
 *   - 主字段（prompt / completion / total）按**优先级取第一个有值的**，同名别名语义相同
 *   - 缓存读 / 缓存写 / 思考 token 取**所有别名的最大值**：这几项经常同时出现且其中
 *     一份是 0（Anthropic 系把 cache_read_input_tokens 报 0，真正命中的在
 *     cached_tokens 里），按优先级取第一个会稳定取到那个 0
 *   - input 是**净值**：prompt_tokens 是 OpenAI 约定（含缓存）→ 减掉缓存读/写；
 *     只有 input_tokens 时按 Anthropic 约定（不含缓存）原样当净值。混在一个字段里
 *     再做减法还原，边界一定漂；负数按 0 处理
 *   - cacheHitRate 的分母是「输入 + 缓存读 + 缓存写」，命中率才是「这次请求有多少
 *     输入走了缓存」，不是「缓存占 prompt 的比例」
 *
 * 拿不到 usage（上游没回）返回 null，调用方必须把这种情况显式呈现成「无 usage」，
 * 不能当成 0 token——0 和「不知道」是两件事。
 */
export function usageNumbers(raw) {
  if (!raw || typeof raw !== 'object') return null
  const ptd = raw.prompt_tokens_details || {}
  const ctd = raw.completion_tokens_details || {}
  const itd = raw.input_tokens_details || {}
  const otd = raw.output_tokens_details || {}

  const finite = (value) => {
    if (value === null || value === undefined || value === '') return null
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  const first = (...values) => {
    for (const value of values) {
      const n = finite(value)
      if (n !== null) return n
    }
    return null
  }
  const biggest = (...values) => {
    let best = null
    for (const value of values) {
      const n = finite(value)
      if (n === null) continue
      if (best === null || n > best) best = n
    }
    return best
  }

  const prompt = first(raw.prompt_tokens, raw.input_tokens) ?? 0
  const output = first(raw.completion_tokens, raw.output_tokens) ?? 0
  const cached =
    biggest(
      ptd.cached_tokens,
      itd.cached_tokens,
      raw.cached_tokens,
      raw.prompt_cache_hit_tokens,
      raw.cache_read_input_tokens,
    ) ?? 0
  const cacheCreation =
    biggest(
      raw.cache_creation_input_tokens,
      ptd.cache_creation_tokens,
      itd.cache_creation_tokens,
      raw.prompt_cache_write_tokens,
    ) ?? 0
  const reasoning =
    biggest(
      ctd.reasoning_tokens,
      otd.reasoning_tokens,
      raw.completion_thinking_tokens,
      raw.reasoning_tokens,
    ) ?? 0

  // 净值口径：prompt_tokens 是 OpenAI 约定（**含**缓存），要减；只有 input_tokens
  // 时按 Anthropic 约定（**不含**缓存）原样当净值，否则会把整笔输入减成 0
  const input =
    finite(raw.prompt_tokens) !== null
      ? Math.max(0, prompt - cached - cacheCreation)
      : Math.max(0, prompt)
  const billedInput = input + cached + cacheCreation
  return {
    // prompt 保留上游原值：核验「站点虚报」时要和本地估算比的是它，不是净值
    prompt,
    input,
    output,
    cached,
    cacheCreation,
    reasoning,
    total: first(raw.total_tokens) ?? prompt + output,
    cacheHitRate: billedInput > 0 ? cached / billedInput : null,
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

/** 攒给「工具调用本地重建」用的原文上限：16K 足够装下几段方言标记 */
const TEXT_TAIL_LIMIT = 16000

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
  // textChars / reasoningChars 分开记："这一轮有没有说话"要用正文数，"站点有没有偷工"
  // 用正文+思考（见 quality-signals）。混成一个数字两种判定必然互相带偏。
  //
  // 另外攒一份「文字原文」（只留尾部，上限见 TEXT_TAIL_LIMIT）：上游把工具调用
  // 标记漏进正文/思考时，空回合守卫要拿它本地重建（见 core/tool-repair.js）。
  // 只攒尾部是因为标记总在这一轮刚生成的那一小段里，一个大回答不值得全存。
  const state = {
    usage: null,
    contentChars: 0,
    textChars: 0,
    reasoningChars: 0,
    textTail: '',
    hasToolCalls: false,
    finishReason: null,
  }
  const rememberText = (piece) => {
    if (!piece) return
    const next = state.textTail + piece
    state.textTail = next.length > TEXT_TAIL_LIMIT ? next.slice(-TEXT_TAIL_LIMIT) : next
  }

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
          state.textChars += String(parsed.delta || '').length
          state.contentChars += String(parsed.delta || '').length
          rememberText(String(parsed.delta || ''))
        } else if (
          type === 'response.reasoning_summary_text.delta' ||
          type === 'response.reasoning_text.delta'
        ) {
          // 思考摘要也算「有内容」：只输出思考、正文为空的响应不该被判成站点偷工。
          // 但它不算「客户拿到了正文」——空回合守卫看的是 textChars
          state.reasoningChars += String(parsed.delta || '').length
          state.contentChars += String(parsed.delta || '').length
          rememberText(String(parsed.delta || ''))
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
                  if (typeof part?.text === 'string') {
                    state.textChars += part.text.length
                    state.contentChars += part.text.length
                  }
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
        if (typeof delta.content === 'string') {
          state.textChars += delta.content.length
          state.contentChars += delta.content.length
          rememberText(delta.content)
        }
        if (typeof delta.reasoning_content === 'string') {
          state.reasoningChars += delta.reasoning_content.length
          state.contentChars += delta.reasoning_content.length
          rememberText(delta.reasoning_content)
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

      // 「还没吐东西就别急着提交」。
      //
      // 为什么要 hold：Chat 流的第一个 chunk 通常只是一个 role 声明，没有任何正文。
      // 以前这个 chunk 一过就 commit（向客户端发响应头 + 开头），于是上游
      // 即使一个字都没吐就断流，用户也已经吃了一个空开头——只能报错，不能换站。
      // 现在把「无正文、无工具调用、无终止原因」的 chunk 先攒着，等真有内容
      // 再一起补发：中间断流时这一轮就还没提交，可以静默换下一条供给重放。
      // 客户端看到的东西一模一样（顺序不变、一个 chunk 不少），但失败被截流了。
      if (!state.contentChars && !state.hasToolCalls && !state.finishReason) return { hold: true }

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
    let textChars = 0
    let reasoningChars = 0
    let hasToolCalls = false
    for (const item of payload?.output || []) {
      if (item?.type === 'message') {
        textChars += textLength(item.content)
        contentChars += textLength(item.content)
      }
      if (item?.type === 'reasoning') reasoningChars += textLength(item.content) + textLength(item.summary)
      if (TOOL_ITEM_TYPES.has(item?.type)) hasToolCalls = true
    }
    contentChars += reasoningChars
    const finishReason =
      payload?.status === 'incomplete' ? 'length' : hasToolCalls ? 'tool_calls' : 'stop'

    return {
      usage: usage || null,
      realCheck: {
        contentChars,
        textChars,
        reasoningChars,
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
  const textChars = (message.content || '').length
  const reasoningChars = (message.reasoning_content || '').length
  return {
    usage,
    realCheck: {
      contentChars: textChars + reasoningChars,
      textChars,
      reasoningChars,
      hasToolCalls: Boolean(message.tool_calls?.length),
      finishReason: choice?.finish_reason ?? null,
      promptTokens: usage?.prompt_tokens ?? null,
    },
  }
}

// ------------------------------------------------------- 空回合守卫的两个工具

/**
 * 这一块是不是「这一轮的收尾」。
 *
 * 为什么需要认出来：空回合守卫要能在收尾之前反悔。收尾块（finish_reason /
 * `[DONE]` / `response.completed`）一旦转发出去，客户端就认定这一轮结束了，
 * 之后再补一次回答就变成「同一轮里出现两次收尾」，客户端只会取前者。
 * 所以收尾块必须先扣在手里，等判完再决定发不发。
 *
 * @returns {boolean} true = 收尾块，先攒着
 */
export function isTerminalChunk(protocol, parsed, payloadText) {
  if (payloadText === '[DONE]') return true
  if (!parsed) return false
  if (protocol === 'responses') {
    const type = parsed?.type || (parsed?.object === 'response' ? 'response.completed' : null)
    return RESPONSES_TERMINAL.has(type)
  }
  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null
  return Boolean(choice?.finish_reason)
}

const REASONING_EVENT = /^response\.reasoning/

/**
 * 把「第二次补问」的流接到已经发出去的那一轮后面时的过滤器。
 *
 * 为什么不能原样转发：第一次尝试的思考已经流给客户端了。补问时模型会把同样的
 * 推理再想一遍，原样转发的结果是「两段一模一样的思考」——比空回合更让人看不懂。
 * 所以补问只放正文和工具调用，思考一律丢掉。
 *
 * Responses 的收尾事件（response.completed）里带着完整 output，也必须把
 * reasoning 条目剥掉，否则客户端从终态里又读到一遍思考。
 *
 * @returns {string|null} null = 这块丢掉
 */
export function rewriteAppendedChunk(protocol, raw, parsed) {
  if (!parsed) return raw

  if (protocol === 'responses') {
    const type = parsed?.type || (parsed?.object === 'response' ? 'response.completed' : null)
    if (REASONING_EVENT.test(type || '')) return null
    const itemType = parsed?.item?.type
    if (itemType === 'reasoning') return null
    if (RESPONSES_TERMINAL.has(type) && parsed.response && Array.isArray(parsed.response.output)) {
      const response = {
        ...parsed.response,
        output: parsed.response.output.filter((item) => item?.type !== 'reasoning'),
      }
      return `data: ${JSON.stringify({ ...parsed, response })}\n\n`
    }
    return raw
  }

  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null
  const delta = choice?.delta
  if (!delta || delta.reasoning_content === undefined) return raw
  const rest = { ...delta }
  delete rest.reasoning_content
  // 只带思考的增量整块丢掉；同一个 chunk 里既有思考又有正文的，重写成只剩正文
  if (!rest.content && !rest.tool_calls?.length) return null
  const choices = parsed.choices.map((item, index) =>
    index === 0 ? { ...item, delta: rest } : item,
  )
  return `data: ${JSON.stringify({ ...parsed, choices })}\n\n`
}
