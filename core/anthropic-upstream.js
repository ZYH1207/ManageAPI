/**
 * 原生 Anthropic 上游：让网关能对**只提供 /v1/messages 的站**发请求。
 *
 * 背景（2026-11-12 实测）：
 *   rapid 的 Rapid-Kiro 分组只认原生 /v1/messages。网关原来对 anthropic 客户端
 *   一律把请求翻成 Chat 再打上游 /chat/completions，这条路上游不吐任何字节，
 *   客户端挂到 60s 超时。同一个 offer 用 /messages 打，8.9 秒就有回应。
 *
 * 与 core/anthropic-wire.js 的分工（别混，一混就是两层翻译）：
 *
 *   anthropic-wire.js  客户端 Anthropic ⇄ 网关内部 Chat   —— 出入口
 *   本文件              网关内部 Chat   ⇄ 上游 Anthropic   —— 只在「上游原生 anthropic」时启用
 *
 * 所以链路是：
 *
 *   客户端 /v1/messages
 *     → anthropicToChat()            客户端 Anthropic → 内部 Chat
 *     → 路由 / 评分 / 计费 / 守卫      （全部只认 Chat，一行不动）
 *     → chatToAnthropicRequest()     内部 Chat → 上游 Anthropic  ← 本文件
 *     → 上游 POST /v1/messages
 *     → anthropicUpstreamToChatStream()  上游 Anthropic SSE → 内部 Chat SSE  ← 本文件
 *     → 现有检查器 / 终端块 / 工具重建   （一行不动）
 *     → attachAnthropicSink()        内部 Chat → 客户端 Anthropic
 *
 * 中间那两次转换之后，下游看到的仍然是一条**标准的 Chat SSE 流**，
 * 所以 createStreamInspector / extractNonStream / 计费 / 工具重建全都不需要知道
 * 上游说的是 Anthropic。
 *
 * 只做形状转换：不发请求、不读环境、不碰全局状态。
 */

import { randomBytes } from 'node:crypto'

const newId = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`

/** Anthropic 的 max_tokens 必填；上游没给就按这个保守值兜底。 */
const DEFAULT_MAX_TOKENS = 8192

const isText = (block) => block && block.type === 'text' && typeof block.text === 'string'

/** Chat 的 content 块（text / image_url）→ Anthropic 的 content 块。 */
function toAnthropicBlocks(content) {
  const out = []
  if (typeof content === 'string') {
    if (content) out.push({ type: 'text', text: content })
    return out
  }
  if (!Array.isArray(content)) return out
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') {
      const text = String(block.text ?? '')
      if (text) out.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image_url') {
      const url = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url
      if (!url) continue
      // data:image/png;base64,xxx → Anthropic 的 base64 source
      const m = /^data:([^;]+);base64,(.*)$/s.exec(String(url))
      if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
      else out.push({ type: 'image', source: { type: 'url', url: String(url) } })
    }
  }
  return out
}

/**
 * 内部 Chat 请求体 → 上游 Anthropic /v1/messages 请求体。
 *
 * 三件必须做的事：
 *  1. role:"system" 提到顶层 system 参数（Anthropic 不接受 system 角色）；
 *  2. max_tokens 必填，缺了补一个保守值；
 *  3. tools 从 {type:'function', function:{...}} 摊平成 {name, description, input_schema}。
 *
 * tool 结果的回放：Chat 用 role:"tool" + tool_call_id，Anthropic 要的是
 * user 消息里的 tool_result 块。两者形状差得远，这里一并翻掉，
 * 否则带工具的二轮请求上游会直接 400。
 */
export function chatToAnthropicRequest(chatBody, { model } = {}) {
  const body = chatBody && typeof chatBody === 'object' ? chatBody : {}
  const messages = Array.isArray(body.messages) ? body.messages : []
  const systemParts = []
  const turns = []

  for (const message of messages) {
    const role = String(message?.role ?? 'user')
    if (role === 'system') {
      const blocks = toAnthropicBlocks(message.content)
      const text = blocks.filter(isText).map((b) => b.text).join('\n\n')
      if (text) systemParts.push(text)
      continue
    }
    if (role === 'tool') {
      // Chat 的 tool 结果 → Anthropic 的 user.tool_result 块，必须紧跟在
      // 发起调用的 assistant 消息之后，否则上游报「tool_result 没有对应的 tool_use」
      const block = {
        type: 'tool_result',
        tool_use_id: String(message?.tool_call_id ?? ''),
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
      }
      const last = turns[turns.length - 1]
      if (last && last.role === 'user') last.content.push(block)
      else turns.push({ role: 'user', content: [block] })
      continue
    }
    if (role === 'assistant') {
      const blocks = toAnthropicBlocks(message.content)
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      for (const call of calls) {
        blocks.push({
          type: 'tool_use',
          id: String(call?.id || newId('toolu')),
          name: String(call?.function?.name || 'tool'),
          input: parseArgs(call?.function?.arguments),
        })
      }
      if (blocks.length === 0) continue
      turns.push({ role: 'assistant', content: blocks })
      continue
    }
    const blocks = toAnthropicBlocks(message?.content)
    if (blocks.length === 0) continue
    turns.push({ role: 'user', content: blocks })
  }

  const maxTokens = Number(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens)
  const out = {
    model: String(model || body.model || ''),
    max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.trunc(maxTokens) : DEFAULT_MAX_TOKENS,
    messages: turns,
    ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
    ...(body.stream === true ? { stream: true } : {}),
    ...(Number.isFinite(body.temperature) ? { temperature: body.temperature } : {}),
    ...(Number.isFinite(body.top_p) ? { top_p: body.top_p } : {}),
    ...(body.stop !== undefined ? { stop_sequences: Array.isArray(body.stop) ? body.stop : [body.stop] } : {}),
  }

  const tools = Array.isArray(body.tools) ? body.tools : []
  if (tools.length > 0) {
    out.tools = tools.map((tool) => {
      const fn = tool?.function && typeof tool.function === 'object' ? tool.function : tool
      return {
        name: String(fn?.name ?? ''),
        ...(fn?.description ? { description: String(fn.description) } : {}),
        input_schema: fn?.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} },
      }
    })
    const choice = body.tool_choice
    if (choice === 'auto' || choice === undefined) out.tool_choice = { type: 'auto' }
    else if (choice === 'required') out.tool_choice = { type: 'any' }
    else if (choice === 'none') delete out.tools
    else if (choice && typeof choice === 'object' && choice.function?.name) {
      out.tool_choice = { type: 'tool', name: String(choice.function.name) }
    }
  }

  return out
}

/** 工具参数：上游有时把 arguments 作为 JSON 字符串，有时已经是对象。 */
function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Anthropic stop_reason → Chat finish_reason。 */
function mapStopReason(reason, hasTools) {
  const r = String(reason || '')
  if (r === 'max_tokens') return 'length'
  if (r === 'tool_use') return 'tool_calls'
  if (r === 'end_turn' || r === 'stop_sequence') return 'stop'
  if (!r) return hasTools ? 'tool_calls' : 'stop'
  return 'stop'
}

/**
 * 上游非流式 Anthropic message → Chat completion 形状。
 * 返回形状与真实 /chat/completions 一致，下游 extractNonStream 直接能消费。
 */
export function anthropicMessageToChat(payload, { model } = {}) {
  const source = payload && typeof payload === 'object' ? payload : {}
  const content = Array.isArray(source.content) ? source.content : []
  let text = ''
  const calls = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') text += String(block.text ?? '')
    else if (block.type === 'tool_use') {
      calls.push({
        id: String(block.id || newId('call')),
        type: 'function',
        function: { name: String(block.name || 'tool'), arguments: JSON.stringify(block.input ?? {}) },
      })
    }
    // thinking / redacted_thinking 丢弃：上游的思考块对网关内部没有意义，
    // 真要给客户端看由出口层决定（那里有自己的 emitThinking 开关）
  }
  const usage = source.usage && typeof source.usage === 'object' ? source.usage : {}
  const input = Number(usage.input_tokens) || 0
  const cached = Number(usage.cache_read_input_tokens) || 0
  return {
    id: String(source.id || newId('chatcmpl')),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: String(source.model || model || ''),
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text,
        ...(calls.length ? { tool_calls: calls } : {}),
      },
      finish_reason: mapStopReason(source.stop_reason, calls.length > 0),
    }],
    usage: {
      // 网关内部按 Chat 口径消费；Anthropic 的 input_tokens 是净值，
      // 这里把缓存读加回去凑成 prompt_tokens（含缓存）的总量
      prompt_tokens: input + cached,
      completion_tokens: Number(usage.output_tokens) || 0,
      total_tokens: input + cached + (Number(usage.output_tokens) || 0),
      ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    },
  }
}

/**
 * 上游 Anthropic SSE → 内部 Chat SSE 的转换器。
 *
 * 吃 `data: {"type":"content_block_delta",...}`，吐 Chat 的 `choices[].delta` 帧。
 * 只在内存里做形状映射，不改任何判定逻辑。
 *
 * @returns {{feed: (event: object) => object[], finish: () => object[]}}
 *          每次 feed 返回「这次该往下游发哪些 Chat chunk」
 */
export function createAnthropicToChatStream({ model } = {}) {
  const id = newId('chatcmpl')
  const created = Math.floor(Date.now() / 1000)
  let started = false
  const toolSlots = new Map() // content_block index → chat tool_calls index
  let nextToolIndex = 0
  let stopReason = null
  let usage = null
  let textStarted = false

  const chunk = (delta, finishReason = null) => ({
    id, object: 'chat.completion.chunk', created,
    model: String(model || ''),
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })

  return {
    feed(event) {
      const out = []
      if (!event || typeof event !== 'object') return out
      const type = String(event.type || '')

      if (type === 'message_start') {
        if (!started) {
          started = true
          out.push(chunk({ role: 'assistant' }))
        }
        const u = event.message?.usage
        if (u && typeof u === 'object') {
          const input = Number(u.input_tokens) || 0
          const cached = Number(u.cache_read_input_tokens) || 0
          usage = { prompt_tokens: input + cached, ...(cached ? { cached_tokens: cached } : {}) }
        }
        return out
      }

      if (type === 'content_block_start') {
        const block = event.content_block || {}
        if (block.type === 'tool_use') {
          const slot = Number.isInteger(event.index) ? event.index : 0
          const chatIndex = nextToolIndex++
          toolSlots.set(slot, { chatIndex, id: String(block.id || newId('call')), name: String(block.name || 'tool') })
          out.push(chunk({
            tool_calls: [{
              index: chatIndex,
              id: String(block.id || newId('call')),
              type: 'function',
              function: { name: String(block.name || 'tool'), arguments: '' },
            }],
          }))
        }
        return out
      }

      if (type === 'content_block_delta') {
        const delta = event.delta || {}
        if (delta.type === 'text_delta') {
          const text = String(delta.text ?? '')
          if (text) {
            if (!textStarted) { textStarted = true }
            out.push(chunk({ content: text }))
          }
          return out
        }
        if (delta.type === 'input_json_delta') {
          const slot = Number.isInteger(event.index) ? event.index : 0
          const info = toolSlots.get(slot)
          const partial = String(delta.partial_json ?? '')
          if (info && partial) {
            out.push(chunk({
              tool_calls: [{ index: info.chatIndex, function: { arguments: partial } }],
            }))
          }
          return out
        }
        // thinking_delta 丢弃：内部 Chat 形状没有对应字段
        return out
      }

      if (type === 'message_delta') {
        if (event.delta?.stop_reason) stopReason = String(event.delta.stop_reason)
        const u = event.usage
        if (u && typeof u === 'object') {
          const output = Number(u.output_tokens)
          if (Number.isFinite(output)) {
            usage = {
              ...(usage || {}),
              completion_tokens: output,
              total_tokens: (Number(usage?.prompt_tokens) || 0) + output,
            }
          }
        }
        return out
      }

      if (type === 'error') {
        // 上游把错误写在流里：包成 Chat 的 error 帧，让现有流级失败检测接住
        const message = String(event.error?.message || event.message || '上游 Anthropic 流内报错')
        out.push({ error: { message, type: String(event.error?.type || 'upstream_error') } })
        return out
      }

      return out
    },
    finish() {
      const out = []
      const hasTools = nextToolIndex > 0
      out.push(chunk({}, mapStopReason(stopReason, hasTools)))
      if (usage) out.push({ id, object: 'chat.completion.chunk', created, model: String(model || ''), choices: [], usage })
      return out
    },
  }
}

/**
 * 把上游 Anthropic 的 SSE 字节流包成「Chat SSE 字节流」。
 *
 * 这样 streamAttempt 里原有的读取循环、终端块判定、工具重建、usage 归集
 * 全部不需要知道上游在说 Anthropic —— 它们看到的仍然是一条普通 Chat 流。
 *
 * @param {ReadableStream} upstreamBody 上游 response.body
 * @param {{model?: string}} options
 * @returns {ReadableStream}
 */
export function anthropicUpstreamToChatStream(upstreamBody, options = {}) {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const converter = createAnthropicToChatStream(options)

  return new ReadableStream({
    async start(controller) {
      const reader = upstreamBody.getReader()
      let buffer = ''
      const push = (payload) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      }
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let cut
          while ((cut = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, cut).replace(/\r$/, '')
            buffer = buffer.slice(cut + 1)
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (!data || data === '[DONE]') continue
            let event
            try { event = JSON.parse(data) } catch { continue }
            for (const out of converter.feed(event)) push(out)
          }
        }
        // 收尾：finish_reason 帧 + usage 帧，形状与真实 Chat 流一致
        for (const out of converter.finish()) push(out)
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } catch (err) {
        // 上游中途断了：把错误也写成 Chat 的 error 帧，让现有检测器记成流级失败
        push({ error: { message: String(err && err.message ? err.message : err), type: 'upstream_error' } })
      } finally {
        try { await reader.cancel?.() } catch { /* ignore */ }
        try { controller.close() } catch { /* ignore */ }
      }
    },
  })
}

/** 上游是不是 Anthropic 形状的响应（用于非流式时挑转换器）。 */
export function looksLikeAnthropicMessage(payload) {
  return Boolean(
    payload && typeof payload === 'object'
    && payload.type === 'message'
    && Array.isArray(payload.content)
    && payload.role === 'assistant',
  )
}
