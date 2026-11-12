/**
 * Anthropic Messages 适配层：客户端说 Anthropic，网关内部照旧走 Chat。
 *
 * 为什么要单独一层，而不是「多一条 upstreamPath」：
 *
 *   Chat / Responses 的差异只在**线上形状**（路径、usage 字段名、SSE 事件名），
 *   网关把请求原样转给上游、把上游原样转回客户端就能跑通——所以 core/wire.js
 *   只做「翻译成网关内部形状」，不做「翻译成客户端形状」。
 *
 *   Anthropic 不一样：绝大多数中转站只提供 /v1/chat/completions，
 *   客户端（Claude Code、Anthropic SDK）却只会说 /v1/messages。
 *   两个方向都要翻译，而且是**结构级**的翻译：
 *
 *     请求：system 顶层参数 / content 块数组 / tool_use·tool_result 块 /
 *           tools[].input_schema / tool_choice{type:any|tool}
 *     响应：content 块数组 / stop_reason / usage 三件套（input / cache_read / cache_creation）
 *     流式：message_start → content_block_start → *_delta → content_block_stop →
 *           message_delta → message_stop（和 Chat 的 choices[].delta 完全不是一回事）
 *
 * 边界划在哪：**路由、评分、计费、空回合守卫、工具调用本地重建全部不动**。
 * 它们只认 Chat 形状，所以本层只在两个口子上工作——
 *
 *   入口：anthropicToChat(body)        客户端 → 网关内部（之后一切照旧）
 *   出口：attachAnthropicSink(res)     网关内部 → 客户端（只翻译写出去的字节）
 *
 * 出口为什么是「就地替换 res 的 writeHead/write/end」而不是包一层假 res：
 *   网关里写响应的位置有十几处（流式 push、终端块补发、工具重建、非流式 end、
 *   错误收尾），每处加一个 if 必然漏掉一处，而漏掉的那处会直接给客户端一坨
 *   Chat 形状的垃圾。就地替换之后，谁写都经过这里，只有一处需要维护。
 *   也不能用 Proxy / Object.create(res)：Node 的 ServerResponse 方法依赖内部槽位，
 *   绑错 this 会抛 ERR_INVALID_THIS——那种错只在流式收尾时才出现，最难查。
 *   就地替换保住的是**同一个对象**，`once(res,'drain')`、`res.on('close')`、
 *   `res.destroyed` 这些原生用法一律照旧。
 */

import { randomBytes } from 'node:crypto'
import { usageNumbers } from './wire.js'

/** 客户端没带 anthropic-version 时回给它的默认值（Anthropic 现行稳定版本） */
export const ANTHROPIC_VERSION = '2023-06-01'

const newId = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`

/** Anthropic 的 system 可以是字符串，也可以是 text 块数组 */
function flattenSystem(system) {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n')
}

/** content 块数组 → 纯文本（tool_result 的内容、错误文案都要用） */
function textOfBlocks(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block?.type === 'text' && typeof block.text === 'string') return block.text
      if (block?.type === 'image') return '[image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** 图片块 → Chat 的 image_url（中转站普遍认 data URI 这一种） */
function imagePart(block) {
  const source = block?.source
  if (!source || typeof source !== 'object') return null
  if (source.type === 'base64' && source.data) {
    const media = source.media_type || 'image/png'
    return { type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } }
  }
  if (source.type === 'url' && source.url) {
    return { type: 'image_url', image_url: { url: String(source.url) } }
  }
  return null
}

/**
 * 把 Anthropic 的 content 块数组翻成 Chat 的 content。
 *
 * 只有纯文本时压成字符串——这是最保守的形状，任何中转站都认；
 * 一旦混进图片就必须用分段数组（OpenAI 的 multimodal 形状）。
 */
function toChatContent(blocks) {
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const part = imagePart(block)
      if (part) parts.push(part)
    }
    // thinking / redacted_thinking / document / server_tool_use 一律丢弃：
    // Chat 上游没有对应形状，硬塞进去只会让上游 400
  }
  if (parts.length === 0) return ''
  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => part.text).join('')
  }
  return parts
}

/** tool_choice：Anthropic 的 auto / any / tool / none → Chat 的四种写法 */
function toChatToolChoice(choice, parallelDisabled) {
  const out = {}
  let noParallel = Boolean(parallelDisabled)
  if (choice && typeof choice === 'object') {
    if (choice.type === 'auto') out.tool_choice = 'auto'
    else if (choice.type === 'any') out.tool_choice = 'required'
    else if (choice.type === 'none') out.tool_choice = 'none'
    else if (choice.type === 'tool' && choice.name) {
      out.tool_choice = { type: 'function', function: { name: String(choice.name) } }
    }
    if (choice.disable_parallel_tool_use) noParallel = true
  }
  if (noParallel) out.parallel_tool_calls = false
  return out
}

/** tools[].input_schema → tools[].function.parameters */
function toChatTools(tools) {
  if (!Array.isArray(tools)) return null
  const mapped = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || !tool.name) continue
    // Anthropic 的服务端工具（web_search / bash 之类）没有 input_schema，
    // 翻译成 Chat 没有意义：上游不认，留着还会让整单 400
    if (!tool.input_schema && tool.type && tool.type !== 'custom') continue
    mapped.push({
      type: 'function',
      function: {
        name: String(tool.name),
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters:
          tool.input_schema && typeof tool.input_schema === 'object'
            ? tool.input_schema
            : { type: 'object', properties: {} },
      },
    })
  }
  return mapped.length > 0 ? mapped : null
}

/**
 * Anthropic Messages 请求 → Chat Completions 请求。
 *
 * 抛错表示「客户端请求本身不合法」，调用方翻成 400；这里只认结构
 * （字段缺失、类型不对），不猜语义（内容长短、参数取值范围），那些交给上游。
 *
 * @param {object} input Anthropic 请求体
 * @param {{requireMaxTokens?: boolean}} [opts]
 *   requireMaxTokens=false 给 /v1/messages/count_tokens 用：那个接口本来就不带
 *   max_tokens（它只数输入），跟着拒会把 Claude Code 的上下文估算整条打掉。
 * @returns {object} Chat 请求体
 */
export function anthropicToChat(input, opts = {}) {
  const requireMaxTokens = opts.requireMaxTokens !== false
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (!model) throw new Error('请求体缺少 model 字段')
  // Anthropic 协议里 max_tokens 是必填项；跟着拒，客户端才看得懂自己少写了什么
  const hasMaxTokens = input.max_tokens !== undefined && input.max_tokens !== null
  if (!hasMaxTokens && requireMaxTokens) {
    throw new Error('缺少 max_tokens 字段（Anthropic Messages 协议必填）')
  }
  const maxTokens = hasMaxTokens ? Number(input.max_tokens) : null
  if (hasMaxTokens && (!Number.isFinite(maxTokens) || maxTokens <= 0)) {
    throw new Error('max_tokens 必须是正数')
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new Error('messages 不能为空数组')
  }

  const out = { model }
  if (maxTokens !== null) out.max_tokens = maxTokens
  for (const key of ['temperature', 'top_p', 'top_k', 'service_tier']) {
    if (input[key] !== undefined && input[key] !== null) out[key] = input[key]
  }
  // stop_sequences → stop（Chat 只认 stop，且上限 4 条）
  if (Array.isArray(input.stop_sequences) && input.stop_sequences.length > 0) {
    out.stop = input.stop_sequences.slice(0, 4)
  }
  if (typeof input.metadata?.user_id === 'string' && input.metadata.user_id) {
    out.user = input.metadata.user_id
  }
  if (input.stream === true) {
    out.stream = true
    // 流式一定要上游带 usage：Anthropic 的 message_delta 里必须报 output_tokens，
    // 而 Chat 不主动要就不给（同 daemon/server.js 里 clientWantsUsage 的处理）
    out.stream_options = { include_usage: true }
  } else {
    out.stream = false
  }

  const tools = toChatTools(input.tools)
  if (tools) out.tools = tools
  const choice = toChatToolChoice(input.tool_choice, !tools)
  if (choice.tool_choice !== undefined) out.tool_choice = choice.tool_choice
  if (choice.parallel_tool_calls !== undefined) out.parallel_tool_calls = choice.parallel_tool_calls

  const messages = []
  const systemParts = []
  const system = flattenSystem(input.system)
  if (system) systemParts.push(system)

  for (let i = 0; i < input.messages.length; i += 1) {
    const message = input.messages[i]
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error(`messages[${i}] 必须是对象`)
    }
    // Claude Code may include environment context as a system message in
    // addition to the top-level Anthropic `system` field. Merge it into the
    // single system message expected by Chat Completions providers.
    if (message.role === 'system') {
      const extra = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content) ? textOfBlocks(message.content) : ''
      if (extra) systemParts.push(extra)
      continue
    }
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : null
    if (!role) throw new Error(`messages[${i}].role 必须是 user 或 assistant`)

    if (typeof message.content === 'string') {
      messages.push({ role, content: message.content })
      continue
    }
    if (!Array.isArray(message.content)) {
      messages.push({ role, content: '' })
      continue
    }

    const blocks = message.content.filter((block) => block && typeof block === 'object')
    const toolResults = blocks.filter((block) => block.type === 'tool_result')
    const toolUses = blocks.filter((block) => block.type === 'tool_use')
    const rest = blocks.filter((block) => block.type !== 'tool_result' && block.type !== 'tool_use')

    if (role === 'user') {
      // 工具结果必须先回放：Chat 要求 role='tool' 的消息紧跟在那条 assistant 的
      // tool_calls 之后，中间夹一条 user 文本会让上游报
      // 「tool message must follow a message with tool_calls」
      for (const result of toolResults) {
        const payload = textOfBlocks(result.content)
        messages.push({
          role: 'tool',
          tool_call_id: String(result.tool_use_id || ''),
          content: result.is_error === true ? `[tool error] ${payload}` : payload,
        })
      }
      const content = toChatContent(rest)
      if (toolResults.length === 0 || content) messages.push({ role: 'user', content })
      continue
    }

    // assistant：正文与 tool_use 要合成同一条消息（Chat 的 tool_calls 挂在消息上）
    const content = toChatContent(rest)
    const entry = { role: 'assistant', content }
    if (toolUses.length > 0) {
      entry.tool_calls = toolUses.map((block, index) => ({
        id: String(block.id || newId(`call${index}`)),
        type: 'function',
        function: {
          name: String(block.name || 'tool'),
          arguments: JSON.stringify(block.input ?? {}),
        },
      }))
      if (!content) entry.content = ''
    }
    messages.push(entry)
  }

  if (systemParts.length > 0) messages.unshift({ role: 'system', content: systemParts.join('\n\n') })
  out.messages = messages
  return out
}

/** Chat 的 finish_reason → Anthropic 的 stop_reason */
export function mapStopReason(finishReason, hasToolUse = false) {
  switch (finishReason) {
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'stop':
      return 'end_turn'
    case 'content_filter':
      return 'end_turn'
    default:
      return hasToolUse ? 'tool_use' : 'end_turn'
  }
}

/** 网关口径的 usage → Anthropic 的三件套（input 是净值，缓存单列） */
export function toAnthropicUsage(raw) {
  const numbers = usageNumbers(raw)
  const usage = {
    input_tokens: numbers?.input ?? 0,
    output_tokens: numbers?.output ?? 0,
  }
  if (numbers?.cached > 0) usage.cache_read_input_tokens = numbers.cached
  if (numbers?.cacheCreation > 0) usage.cache_creation_input_tokens = numbers.cacheCreation
  return usage
}

/** 上游 tool_call 的 arguments（字符串）→ Anthropic 的 input 对象 */
function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw
  const text = String(raw ?? '').trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // 参数写坏了：给一个原样字段而不是丢块——客户端至少能看到模型想调什么
    return { _raw_arguments: text }
  }
}

/**
 * Chat 非流式响应 → Anthropic Message。
 *
 * @param {object} payload Chat 响应体
 * @param {{model?: string, id?: string, emitThinking?: boolean}} [opts]
 */
export function chatToAnthropicMessage(payload, opts = {}) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null
  const message = choice?.message || {}
  const content = []
  const emitThinking = Boolean(opts.emitThinking)

  if (emitThinking && typeof message.reasoning_content === 'string' && message.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content, signature: '' })
  }

  let text = ''
  if (typeof message.content === 'string') text = message.content
  else if (Array.isArray(message.content)) {
    text = message.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
  }
  if (text) content.push({ type: 'text', text })

  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  for (const call of calls) {
    content.push({
      type: 'tool_use',
      id: String(call?.id || newId('toolu')),
      name: String(call?.function?.name || 'tool'),
      input: parseArguments(call?.function?.arguments),
    })
  }

  return {
    id: opts.id || newId('msg'),
    type: 'message',
    role: 'assistant',
    model: opts.model || payload?.model || '',
    content,
    stop_reason: mapStopReason(choice?.finish_reason, calls.length > 0),
    stop_sequence: null,
    usage: toAnthropicUsage(payload?.usage),
  }
}

/**
 * 流式翻译器：吃 Chat 的 `data: {...}` 帧，吐 Anthropic 的 `event:` 帧。
 *
 * 状态机只认三件事：当前开着的 content 块、已拿到的 usage、收尾是否已经发过。
 * Anthropic 的 SSE 是**有结构的**：每个块必须先 start 再 delta 再 stop，
 * 收尾必须走 message_delta + message_stop。顺序错了客户端直接抛解析错。
 *
 * @param {{model?: string, messageId?: string, inputTokensHint?: number,
 *          emitThinking?: boolean, emit: (frame: string) => void}} opts
 */
export function createAnthropicStream(opts = {}) {
  const emit = typeof opts.emit === 'function' ? opts.emit : () => {}
  const model = opts.model || ''
  const id = opts.messageId || newId('msg')
  const inputTokensHint = Number(opts.inputTokensHint) || 0
  const emitThinking = Boolean(opts.emitThinking)

  const state = {
    started: false,
    finished: false,
    index: -1,
    open: null, // { type, index }
    // 工具调用按 Chat 的 tool_calls[].index 先攒着，不边收边发——理由见 flushTools()
    tools: new Map(), // slot → { id, name, args }
    toolCount: 0,
    stopReason: null,
    usage: null,
    buffer: '',
    sawContent: false,
  }

  const send = (type, payload) => {
    emit(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
  }

  const start = () => {
    if (state.started) return
    state.started = true
    send('message_start', {
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokensHint, output_tokens: 0 },
      },
    })
    send('ping', {})
  }

  const closeBlock = () => {
    if (!state.open) return
    send('content_block_stop', { index: state.open.index })
    state.open = null
  }

  const openBlock = (type) => {
    if (state.open && state.open.type === type) return state.open
    closeBlock()
    state.index += 1
    const block = { type, index: state.index }
    state.open = block
    const contentBlock =
      type === 'thinking'
        ? { type: 'thinking', thinking: '', signature: '' }
        : { type: 'text', text: '' }
    send('content_block_start', { index: block.index, content_block: contentBlock })
    return block
  }

  const openToolBlock = (meta) => {
    closeBlock()
    state.index += 1
    const block = { type: 'tool_use', index: state.index }
    state.open = block
    send('content_block_start', {
      index: block.index,
      content_block: { type: 'tool_use', id: meta.id, name: meta.name, input: {} },
    })
    if (meta.args) {
      send('content_block_delta', {
        index: block.index,
        delta: { type: 'input_json_delta', partial_json: meta.args },
      })
    }
  }

  /**
   * 把攒下的工具调用一次性发出去。
   *
   * 为什么不能「边收边发」：Chat 的流式 tool_calls 是**按 index 交错**的——
   * 两个并行调用会这样来：
   *   {index:0,name:'read'} → {index:1,name:'write'} → {index:0,args:'{"a'} → {index:1,args:'{"b'} → …
   * 而 Anthropic 的块是**串行**的：一个块 start 之后必须 delta* 再 stop，
   * 中途换块就意味着前一个块已经关了，后面的 delta 会指向一个已关闭的 index，
   * 客户端直接抛解析错。所以只能攒到收尾时按 slot 顺序一次发完。
   *
   * 代价是工具调用不像正文那样逐字流式；但 Anthropic 客户端本来就要等
   * content_block_stop 之后才执行工具，观感一致。
   */
  const flushTools = () => {
    if (state.tools.size === 0) return
    const slots = [...state.tools.keys()].sort((a, b) => a - b)
    for (const slot of slots) openToolBlock(state.tools.get(slot))
    state.tools.clear()
  }

  const emitError = (message) => {
    if (state.finished) return
    state.finished = true
    send('error', { error: { type: 'api_error', message: String(message || '上游返回 error') } })
  }

  /** 一帧 Chat 载荷 → 若干帧 Anthropic 事件 */
  const translate = (parsed) => {
    if (!parsed || typeof parsed !== 'object') return
    if (parsed.error) {
      emitError(parsed.error.message || parsed.error.type || '上游返回 error')
      return
    }
    if (parsed.usage) state.usage = parsed.usage
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null
    if (!choice) return
    const delta = choice.delta || {}

    if (emitThinking && typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      start()
      state.sawContent = true
      const block = openBlock('thinking')
      send('content_block_delta', {
        index: block.index,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
      })
    }

    if (typeof delta.content === 'string' && delta.content) {
      start()
      state.sawContent = true
      const block = openBlock('text')
      send('content_block_delta', {
        index: block.index,
        delta: { type: 'text_delta', text: delta.content },
      })
    }

    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      start()
      state.sawContent = true
      for (const call of delta.tool_calls) {
        const slot = Number.isInteger(call?.index) ? call.index : 0
        let meta = state.tools.get(slot)
        if (!meta) {
          meta = {
            id: String(call?.id || newId('toolu')),
            name: String(call?.function?.name || 'tool'),
            args: '',
          }
          state.tools.set(slot, meta)
          // toolCount 是「这一轮到底有没有工具调用」的持久标记：tools 会被 flushTools
          // 清空，不能拿它当判据（否则收尾时 stop_reason 会退回 end_turn）
          state.toolCount += 1
        }
        // 名字和 id 可能只在第一帧出现，后面几帧只有参数增量
        if (!meta.name || meta.name === 'tool') {
          if (typeof call?.function?.name === 'string' && call.function.name) {
            meta.name = call.function.name
          }
        }
        if (call?.id && meta.id.startsWith('toolu_')) meta.id = String(call.id)
        const args = call?.function?.arguments
        if (typeof args === 'string' && args) meta.args += args
      }
    }

    if (choice.finish_reason) {
      state.stopReason = mapStopReason(choice.finish_reason, state.tools.size > 0)
    }
  }

  /** 收尾：发工具块 → 关块 → message_delta（带 usage）→ message_stop。幂等 */
  const finish = () => {
    if (state.finished) return
    start()
    // 工具块必须在这里补发：流式 tool_calls 是交错来的，攒完才能按序成块
    flushTools()
    closeBlock()
    const usage = toAnthropicUsage(state.usage)
    send('message_delta', {
      delta: {
        stop_reason: state.stopReason || (state.toolCount > 0 ? 'tool_use' : 'end_turn'),
        stop_sequence: null,
      },
      usage,
    })
    send('message_stop', {})
    state.finished = true
  }

  /**
   * 吃一段原始 SSE 文本（可能是半帧、也可能一次来好几帧）。
   * 上游的帧边界不保证和 TCP 分片对齐，所以必须自己缓冲。
   */
  const push = (text) => {
    if (!text) return
    state.buffer += String(text)
    let boundary
    while ((boundary = state.buffer.indexOf('\n\n')) !== -1) {
      const raw = state.buffer.slice(0, boundary)
      state.buffer = state.buffer.slice(boundary + 2)
      const dataLine = raw.split('\n').find((line) => line.trim().startsWith('data:'))
      if (!dataLine) continue
      const payload = dataLine.trim().slice(5).trim()
      if (!payload) continue
      if (payload === '[DONE]') {
        finish()
        continue
      }
      let parsed = null
      try {
        parsed = JSON.parse(payload)
      } catch {
        // 坏帧不往客户端吐：Anthropic SDK 遇到解析不了的 data 会直接抛错
        continue
      }
      translate(parsed)
    }
  }

  return { push, finish, state, start, id }
}

/** 状态码 → Anthropic 的 error.type（客户端按它决定要不要重试） */
function anthropicErrorType(status, fallback) {
  const known =
    /^(invalid_request_error|authentication_error|permission_error|not_found_error|rate_limit_error|api_error|overloaded_error|request_too_large)$/
  if (fallback && known.test(fallback)) return fallback
  if (status === 400 || status === 422) return 'invalid_request_error'
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 413) return 'request_too_large'
  if (status === 429) return 'rate_limit_error'
  if (status === 529) return 'overloaded_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}

/** 网关的错误文案 → Anthropic 的 error 信封 */
export function anthropicErrorBody(status, message, type = 'invalid_request_error') {
  return JSON.stringify({
    type: 'error',
    error: { type: anthropicErrorType(status, type), message: String(message || '请求失败') },
  })
}

/** 装在 res 上的控制器挂在这个符号下：重复调用只装一次（鉴权失败也要是 Anthropic 信封） */
export const ANTHROPIC_SINK = Symbol.for('manage-api.anthropic-sink')

/**
 * 就地给 res 装上 Anthropic 出口。
 *
 * 三种模式，由网关自己写头时的状态码 / Content-Type 决定：
 *   sse    —— 200 + text/event-stream：所有 `data:` 帧翻成 `event:` 帧
 *   json   —— 200 + application/json：end 时把 Chat 响应翻成 Anthropic Message
 *   error  —— 4xx/5xx：把 OpenAI 信封翻成 Anthropic 信封（客户端只认后者）
 *
 * 返回一个控制器：`configure()` 补上「解析完请求体才知道的事」
 * （模型名、要不要 thinking 块、输入规模提示）。
 */
export function attachAnthropicSink(res, options = {}) {
  // 幂等：handleProxy 为了「鉴权失败也回 Anthropic 信封」会先装一次，
  // handleChatCompletions 进来再装就会把方法套两层（帧被翻译两遍，客户端直接炸）
  if (res[ANTHROPIC_SINK]) return res[ANTHROPIC_SINK]

  const rawWrite = res.write.bind(res)
  const rawEnd = res.end.bind(res)
  const rawWriteHead = res.writeHead.bind(res)

  let model = options.model || ''
  let inputTokensHint = Number(options.inputTokensHint) || 0
  let emitThinking = Boolean(options.emitThinking)

  // mode：'sse' | 'json' | 'error' | null（还没写头）
  let mode = null
  let errorStatus = 502
  let buffered = ''
  let translator = null
  // 上游一次吐很多帧时底层 socket 会回压：把 rawWrite 的 false 记下来，
  // 让本层 res.write 也返回 false，网关那边才会 await 'drain'。
  // 不传的话长回答会整轮堆在内存里（实测几十 MB）
  let backpressure = false

  const ensureTranslator = () => {
    if (!translator) {
      translator = createAnthropicStream({
        model,
        inputTokensHint,
        emitThinking,
        // 一定要用原始 write：res.write 已经被换掉了，直接调会无限递归。
        // 返回值要接住——上游一次吐很多帧时 socket 会回压，丢掉这个信号
        // 就等于让网关把整轮回答堆在内存里（长回答会直接涨到几十 MB）
        emit: (frame) => {
          if (res.writableEnded || res.destroyed) return
          if (rawWrite(frame) === false) backpressure = true
        },
      })
    }
    return translator
  }

  res.writeHead = (status, statusOrHeaders, maybeHeaders) => {
    // Node 允许 writeHead(status, statusMessage, headers)，网关只用到两种参数的写法，
    // 但状态文案也不能悄悄丢掉
    const statusMessage = typeof statusOrHeaders === 'string' ? statusOrHeaders : null
    const headers = statusMessage ? maybeHeaders : statusOrHeaders
    const source = headers && typeof headers === 'object' ? { ...headers } : {}
    const head = (payload) =>
      statusMessage ? rawWriteHead(status, statusMessage, payload) : rawWriteHead(status, payload)

    if (status >= 400) {
      mode = 'error'
      errorStatus = status
      return head(source)
    }
    const contentType = String(source['Content-Type'] || source['content-type'] || '').toLowerCase()
    if (contentType.includes('text/event-stream')) {
      mode = 'sse'
      source['Content-Type'] = 'text/event-stream; charset=utf-8'
      if (!source['Cache-Control']) source['Cache-Control'] = 'no-cache'
      source['anthropic-version'] = ANTHROPIC_VERSION
      const result = head(source)
      // 头发出去了才算「客户端已经看到这一轮开始了」：网关的 commit() 只在真有内容时
      // 才调 writeHead，所以这里的 message_start 不会提前泄给客户端，
      // 「还没提交就能静默换站」的能力原样保留
      ensureTranslator().start()
      return result
    }
    mode = 'json'
    // 正文会被改写，长度必然变：留着旧的 Content-Length 会让客户端截断或挂住
    for (const key of Object.keys(source)) {
      if (key.toLowerCase() === 'content-length') delete source[key]
    }
    return head(source)
  }

  res.write = (chunk, encoding, callback) => {
    if (mode === 'sse') {
      ensureTranslator().push(typeof chunk === 'string' ? chunk : String(chunk))
      if (callback) callback()
      if (backpressure) {
        backpressure = false
        return false
      }
      return true
    }
    if (mode === 'json' || mode === 'error') {
      if (chunk !== undefined && chunk !== null) {
        buffered += typeof chunk === 'string' ? chunk : String(chunk)
      }
      if (callback) callback()
      return true
    }
    // 还没写头就写正文：交给原生实现，它会自己补 200
    return rawWrite(chunk, encoding, callback)
  }

  res.end = (chunk, encoding, callback) => {
    // end(chunk, cb) 这种写法 Node 也认，回调不能吞掉——网关收尾时靠它判断落盘时机
    let cb = callback
    if (typeof encoding === 'function') {
      cb = encoding
      encoding = undefined
    }
    if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
      const text = typeof chunk === 'string' ? chunk : String(chunk)
      if (mode === 'sse') ensureTranslator().push(text)
      else buffered += text
    } else if (typeof chunk === 'function') {
      cb = chunk
    }
    if (mode === 'sse') {
      ensureTranslator().finish()
      return rawEnd(cb)
    }
    if (mode === 'error') {
      let message = ''
      let type = ''
      try {
        const payload = JSON.parse(buffered)
        message = payload?.error?.message || payload?.message || ''
        type = payload?.error?.type || ''
      } catch {
        message = buffered.slice(0, 500)
      }
      return rawEnd(anthropicErrorBody(errorStatus, message || '请求失败', type), cb)
    }
    // json（或没写头就直接 end）：把 Chat 响应翻成 Anthropic Message
    try {
      const payload = JSON.parse(buffered)
      if (payload?.error) {
        const status = res.statusCode && res.statusCode >= 400 ? res.statusCode : 502
        return rawEnd(
          anthropicErrorBody(status, payload.error.message || '上游返回 error', payload.error.type),
          cb,
        )
      }
      // 只有「真的是一条 Chat 补全」才翻译。count_tokens 这类本机自己生成的响应
      // （{input_tokens:N}）形状不同，硬翻会变成一条空 message，把客户端带偏
      const isChatCompletion = Array.isArray(payload?.choices) || payload?.object === 'chat.completion'
      if (!isChatCompletion) return rawEnd(buffered, cb)
      return rawEnd(JSON.stringify(chatToAnthropicMessage(payload, { model, emitThinking })), cb)
    } catch {
      // 不是 JSON：原样交出去，总比吞掉强（客户端至少能看到原文去查）
      return rawEnd(buffered, cb)
    }
  }

  const controller = {
    /** 已经装过了就认这一个：handleProxy 与 handleChatCompletions 都可能走到这里 */
    attached: true,
    configure(next = {}) {
      if (typeof next.model === 'string' && next.model) {
        model = next.model
        if (translator) translator.state.model = model
      }
      if (Number.isFinite(Number(next.inputTokensHint))) inputTokensHint = Number(next.inputTokensHint)
      if (next.emitThinking !== undefined) emitThinking = Boolean(next.emitThinking)
    },
  }
  Object.defineProperty(res, ANTHROPIC_SINK, { value: controller, configurable: true })
  return controller
}
