/**
 * 协议探查用的假中转站：按 MODE 扮演不同成色的站。
 *
 * 设计要点：**按探针真实会发的提示词回话**，而不是「收到什么就回 OK」。
 * 因为一旦探针升级了提示词（换暗号、换问题），假站必须跟着能答上来，
 * 否则能力会被判成「模型没按要求做 → 无法判定」，测试就变成假红了。
 *
 * 支持的模式：
 *   native          全绿（四种协议都原生、能力齐全）
 *   translated      /responses、/messages 收下请求但回 Chat 结构
 *   chat-only       只有 /chat/completions，其余 404
 *   degraded        Chat 200 但响应缺 usage/choices
 *   toolchoice-blind  各协议都无视 tool_choice / functionCallingConfig
 *   no-vision       各协议都答不出图片颜色
 *   gemini-flat     Gemini 路由在但不认 responseSchema / thinkingConfig
 *   flaky           部分能力隔次失败（用于验证「三次」模式的 flaky 判定）
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT || 5199)
let mode = process.env.MODE || 'native'
let seq = 0
let callCount = 0
const memories = new Map()
const flakyCounters = new Map()

const RED_ANSWER = /颜色|color/i
const LONG_CTX_MARK = 'QX-7731'

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function sse(res, events) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  for (const [event, data] of events) {
    if (event) res.write(`event: ${event}\n`)
    res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
  }
  res.end()
}

const longEssay = '河流从山谷里出来时还只是一条细线，绕过石头，带下泥沙，慢慢变宽。'.repeat(80)

/** 同一类请求隔次失败，用来模拟「时好时坏」：探针跑三遍就能看出 flaky。 */
function flakyToggle(key) {
  if (mode !== 'flaky') return false
  const n = (flakyCounters.get(key) || 0) + 1
  flakyCounters.set(key, n)
  return n % 2 === 1
}

// ------------------------------------------------------------------ Chat

function chatPayload(body) {
  const messages = body.messages || []
  const textOfMessage = (m) =>
    typeof m?.content === 'string'
      ? m.content
      : (m?.content || []).map((part) => part?.text || '').join('')
  const prompt = messages.map(textOfMessage).join('\n')
  const lastUser = textOfMessage([...messages].reverse().find((m) => m.role === 'user'))
  const usageFor = (text) => {
    const completion = Math.max(12, Math.round(String(text || '').length / 1.4))
    return { prompt_tokens: 32, completion_tokens: completion, total_tokens: 32 + completion }
  }
  const usage = { prompt_tokens: 32, completion_tokens: 12, total_tokens: 44 }

  if (mode === 'degraded') {
    // 200 但缺 usage，用来验证「表面通、能力红」
    return {
      id: 'chatcmpl-degraded',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    }
  }

  const respond = (content, finish = 'stop', extra = null) => ({
    id: `chatcmpl-${++seq}`,
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, ...(extra || {}) },
        finish_reason: finish,
      },
    ],
    usage: usageFor(content),
  })

  const toolCalls = (cities) =>
    cities.map((city, i) => ({
      id: `call_${seq}_${i}`,
      type: 'function',
      function: { name: 'get_weather', arguments: JSON.stringify({ city }) },
    }))

  // 1) 视觉
  if (RED_ANSWER.test(prompt)) {
    if (mode === 'no-vision') return respond('无法判断')
    return respond('红色')
  }
  // 2) 思考字段
  if (/13 的平方/.test(prompt)) {
    return respond('176', 'stop', { reasoning_content: '13*13=169，169+7=176。' })
  }
  // 3) 长上下文
  if (prompt.includes(LONG_CTX_MARK) || /暗号编号/.test(prompt)) {
    if (mode === 'truncate-context') return respond('无法找到')
    return respond(LONG_CTX_MARK)
  }
  // 4) 长输出
  if (/河流/.test(prompt)) return respond(longEssay)
  // 5) 结构化输出
  if (body.response_format?.type === 'json_schema') {
    return respond(JSON.stringify({ name: '小明', age: 18 }))
  }
  if (body.response_format?.type === 'json_object') return respond('{"ok":true}')
  // 6) 多候选
  if (Number(body.n) >= 2) {
    return {
      id: `chatcmpl-n-${++seq}`,
      object: 'chat.completion',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
        { index: 1, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
      ],
      usage,
    }
  }
  // 7) stop 序列
  if (Array.isArray(body.stop) && body.stop.length) return respond('ALPHA ')
  // 8) 截断信号
  if (/数到 300|从 1 数到 300/.test(prompt) && Number(body.max_tokens) <= 16) {
    return respond('1,2,3', 'length')
  }
  // 9) 工具：回放结果
  const hasToolMsg = messages.some((m) => m.role === 'tool')
  if (hasToolMsg) return respond('巴黎现在 22C 晴。')
  // 10) 工具：并行
  if (/巴黎和东京/.test(prompt) && Array.isArray(body.tools)) {
    return respond(null, 'tool_calls', { tool_calls: toolCalls(['Paris', 'Tokyo']) })
  }
  // 11) flaky：工具类请求隔次失败（放在正常工具分支之前才有机会命中）
  if (Array.isArray(body.tools) && mode === 'flaky' && !/巴黎和东京/.test(prompt)) {
    if (flakyToggle('chat-tools')) return respond('巴黎今天不错，适合出门。')
    return respond(null, 'tool_calls', { tool_calls: toolCalls(['Paris']) })
  }
  // 11.5) 工具：强制/普通调用
  if (Array.isArray(body.tools) && body.tools.length) {
    const forced = body.tool_choice && body.tool_choice !== 'auto'
    const wantsTool = forced || /get_weather/.test(prompt)
    if (wantsTool && !(mode === 'toolchoice-blind' && forced)) {
      return respond(null, 'tool_calls', { tool_calls: toolCalls(['Paris']) })
    }
    return respond('巴黎今天不错，适合出门。')
  }
  // 12) 多轮：复述暗号
  if (/紫色河马/.test(prompt) && messages.some((m) => m.role === 'assistant')) {
    return respond('紫色河马')
  }
  // 13) 系统提示（探针问 1+1，看模型有没有被 system 劫持成复读机）
  if (/7Q2K/.test(prompt)) return respond('7Q2K')
  // 14) 普通对话
  if (/只回复|只回|OK/.test(lastUser)) return respond('OK')
  return respond('OK')
}

function chatStream(res, body) {
  if (mode === 'degraded') return send(res, 200, chatPayload(body))
  const payload = chatPayload(body)
  const choice = payload.choices[0]
  const content = choice.message.content || ''
  const events = []
  if (choice.message.tool_calls) {
    events.push([
      null,
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: choice.message.tool_calls.map((call, i) => ({
                index: i,
                id: call.id,
                type: 'function',
                function: { name: call.function.name, arguments: '' },
              })),
            },
          },
        ],
      },
    ])
    for (const call of choice.message.tool_calls) {
      events.push([
        null,
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: call.function.arguments } }] },
            },
          ],
        },
      ])
    }
  }
  for (let i = 0; i < content.length; i += 8) {
    events.push([null, { choices: [{ index: 0, delta: { content: content.slice(i, i + 8) } }] }])
    if (i > 400) break
  }
  events.push([null, { choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] }])
  if (body.stream_options?.include_usage && payload.usage) {
    events.push([null, { choices: [], usage: payload.usage }])
  }
  events.push([null, '[DONE]'])
  sse(res, events)
}

// ------------------------------------------------------------- Responses

function responsesInput(body) {
  if (typeof body.input === 'string') return body.input
  return (body.input || [])
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text || '')
    .join('\n')
}

function responsesOutput(text, extra = {}) {
  return {
    id: `resp_${++seq}`,
    object: 'response',
    status: 'completed',
    store: true,
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 32, output_tokens: 12, total_tokens: 44 },
    ...extra,
  }
}

function responsesPayload(body) {
  const input = responsesInput(body)
  const items = Array.isArray(body.input) ? body.input : []
  const usage = { input_tokens: 32, output_tokens: 12, total_tokens: 44 }

  if (body.previous_response_id) {
    const remembered = memories.get(body.previous_response_id) || ''
    return {
      id: `resp_${++seq}`,
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: remembered || '不知道' }],
        },
      ],
      usage,
    }
  }

  // 跨请求接续：记住 4321
  if (/记住数字 4321/.test(input)) {
    const id = `resp_${++seq}`
    memories.set(id, '4321')
    return { id, object: 'response', status: 'completed', store: true, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }], usage }
  }

  if (RED_ANSWER.test(input)) {
    return responsesOutput(mode === 'no-vision' ? '无法判断' : '红色')
  }
  if (/13 的平方/.test(input)) {
    return {
      ...responsesOutput('176'),
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '169+7=176' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '176' }] },
      ],
      usage: { input_tokens: 32, output_tokens: 40, total_tokens: 72, output_tokens_details: { reasoning_tokens: 28 } },
    }
  }
  if (input.includes(LONG_CTX_MARK)) {
    return responsesOutput(mode === 'truncate-context' ? '无法找到' : LONG_CTX_MARK)
  }
  if (/河流/.test(input)) return responsesOutput('河流从山谷里流出来，绕过石头，带下泥沙。'.repeat(40))
  if (body.text?.format?.type === 'json_schema') return responsesOutput('{"name":"小明","age":18}')
  // 工具结果回放
  if (items.some((item) => item?.type === 'function_call_output')) {
    return responsesOutput('巴黎现在 22C 晴。')
  }
  if (/巴黎和东京/.test(input) && Array.isArray(body.tools)) {
    return {
      ...responsesOutput(''),
      output: [
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
        { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'get_weather', arguments: '{"city":"Tokyo"}' },
      ],
    }
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    const forced = body.tool_choice && body.tool_choice !== 'auto'
    if ((forced || /get_weather/.test(input)) && !(mode === 'toolchoice-blind' && forced)) {
      return {
        ...responsesOutput(''),
        output: [
          { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
        ],
      }
    }
    return responsesOutput('巴黎今天不错。')
  }
  if (/数到 300|从 1 数到 300/.test(input) && Number(body.max_output_tokens) <= 16) {
    return {
      id: `resp_${++seq}`,
      object: 'response',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '1,2,3' }] }],
      usage,
    }
  }
  if (body.instructions && /7Q2K/.test(body.instructions)) return responsesOutput('7Q2K')
  return responsesOutput('OK')
}

function responsesStream(res, body) {
  const payload = responsesPayload(body)
  const text =
    payload.output?.find((item) => item.type === 'message')?.content?.[0]?.text || 'OK'
  sse(res, [
    ['response.created', { type: 'response.created', response: { id: payload.id, status: 'in_progress', output: [] } }],
    ['response.output_item.added', { type: 'response.output_item.added', item: { type: 'message', role: 'assistant', content: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: text.slice(0, 2) }],
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: text.slice(2) }],
    ['response.completed', { type: 'response.completed', response: payload }],
  ])
}

// ------------------------------------------------------------- Anthropic

function anthropicPrompt(body) {
  return (body.messages || [])
    .flatMap((m) => (typeof m.content === 'string' ? [m.content] : (m.content || []).map((part) => part.text || '')))
    .join('\n')
}

function anthropicPayload(body) {
  const prompt = anthropicPrompt(body)
  const blocks = (body.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : []))
  const usage = { input_tokens: 32, output_tokens: 12 }

  if (blocks.some((block) => block?.type === 'tool_result')) {
    return {
      id: `msg_${++seq}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '巴黎现在 22C 晴。' }],
      stop_reason: 'end_turn',
      usage,
    }
  }
  if (RED_ANSWER.test(prompt)) {
    return {
      id: `msg_${++seq}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: mode === 'no-vision' ? '无法判断' : '红色' }],
      stop_reason: 'end_turn',
      usage,
    }
  }
  if (/13 的平方/.test(prompt)) {
    return {
      id: `msg_${++seq}`,
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '169+7=176' },
        { type: 'text', text: '176' },
      ],
      stop_reason: 'end_turn',
      usage,
    }
  }
  if (prompt.includes(LONG_CTX_MARK)) {
    return {
      id: `msg_${++seq}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: mode === 'truncate-context' ? '无法找到' : LONG_CTX_MARK }],
      stop_reason: 'end_turn',
      usage,
    }
  }
  if (/数到 300|从 1 数到 300/.test(prompt) && Number(body.max_tokens) <= 16) {
    return {
      id: `msg_${++seq}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '1,2,3' }],
      stop_reason: 'max_tokens',
      usage,
    }
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    return {
      id: `msg_${++seq}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ALPHA ' }],
      stop_reason: 'stop_sequence',
      usage,
    }
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    const forced = body.tool_choice && body.tool_choice.type
    const toolName = body.tools[0].name
    const named = new RegExp(toolName).test(prompt)
    if ((forced || named) && !(mode === 'toolchoice-blind' && forced)) {
      const args = toolName === 'emit_person' ? { name: '小明', age: 18 } : { city: 'Paris' }
      return {
        id: `msg_${++seq}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: toolName, input: args }],
        stop_reason: 'tool_use',
        usage,
      }
    }
  }
  if (/紫色河马/.test(prompt) && (body.messages || []).some((m) => m.role === 'assistant')) {
    return {
      id: `msg_${++seq}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '紫色河马' }],
      stop_reason: 'end_turn',
      usage,
    }
  }
  if (body.system && /7Q2K/.test(body.system)) {
    return {
      id: `msg_${++seq}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '7Q2K' }],
      stop_reason: 'end_turn',
      usage,
    }
  }
  return {
    id: `msg_${++seq}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'OK' }],
    stop_reason: 'end_turn',
    usage,
  }
}

function anthropicStream(res, body) {
  const payload = anthropicPayload(body)
  const text = payload.content?.find((block) => block.type === 'text')?.text || 'OK'
  sse(res, [
    ['message_start', { type: 'message_start', message: { id: payload.id, type: 'message', role: 'assistant', content: [] } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 1) } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(1) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: payload.stop_reason }, usage: payload.usage }],
    ['message_stop', { type: 'message_stop' }],
  ])
}

// --------------------------------------------------------------- Gemini

function geminiText(body) {
  return (body.contents || [])
    .flatMap((item) => (item.parts || []).map((part) => part.text || ''))
    .join('\n')
}

function geminiPayload(body, model) {
  const prompt = geminiText(body)
  const parts = (body.contents || []).flatMap((item) => item.parts || [])
  const usageMetadata = { promptTokenCount: 32, candidatesTokenCount: 12, totalTokenCount: 44 }
  const out = (textParts, finish = 'STOP') => ({
    candidates: [{ content: { role: 'model', parts: textParts }, finishReason: finish }],
    usageMetadata,
    modelVersion: model,
  })
  const outText = (text, finish = 'STOP') => out([{ text }], finish)

  if (parts.some((part) => part?.functionResponse)) return outText('巴黎现在 22C 晴。')
  if (parts.some((part) => part?.inlineData)) return outText(mode === 'no-vision' ? '无法判断' : '红色')
  if (/13 的平方/.test(prompt)) {
    if (mode === 'gemini-flat') return outText('176')
    return out([{ text: '169+7=176', thought: true }, { text: '176' }])
  }
  if (prompt.includes(LONG_CTX_MARK)) return outText(mode === 'truncate-context' ? '无法找到' : LONG_CTX_MARK)
  if (/河流/.test(prompt)) return outText('河流从山谷里流出来，绕过石头，带下泥沙。'.repeat(40))
  if (body.generationConfig?.responseSchema) {
    if (mode === 'gemini-flat') return outText('```json\n{"name":"小明","age":18}\n```')
    return outText('{"name":"小明","age":18}')
  }
  if (/数到 300|从 1 数到 300/.test(prompt) && Number(body.generationConfig?.maxOutputTokens) <= 16) {
    return outText('1,2,3', 'MAX_TOKENS')
  }
  if (Array.isArray(body.generationConfig?.stopSequences) && body.generationConfig.stopSequences.length) {
    return outText('ALPHA ')
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    const forced = body.toolConfig?.functionCallingConfig?.mode === 'ANY'
    if ((forced || /get_weather/.test(prompt)) && !(mode === 'toolchoice-blind' && forced)) {
      return out([{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }])
    }
  }
  if (/紫色河马/.test(prompt) && (body.contents || []).some((item) => item.role === 'model')) {
    return outText('紫色河马')
  }
  if (body.systemInstruction && /7Q2K/.test(JSON.stringify(body.systemInstruction))) return outText('7Q2K')
  return outText('OK')
}

function geminiStream(res, body, model) {
  const payload = geminiPayload(body, model)
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || 'OK'
  sse(res, [
    [null, { candidates: [{ content: { role: 'model', parts: [{ text: text.slice(0, 1) }] } }] }],
    [null, { candidates: [{ content: { role: 'model', parts: [{ text: text.slice(1) }] }, finishReason: 'STOP' }], usageMetadata: payload.usageMetadata }],
  ])
}

// ------------------------------------------------------------------ 路由

const server = createServer(async (req, res) => {
  if (req.url === '/__mode') {
    const body = await readBody(req)
    mode = body.mode || 'native'
    callCount = 0
    flakyCounters.clear()
    return send(res, 200, { mode })
  }
  if (/\/models\/?$/.test(req.url)) {
    return send(res, 200, { data: [{ id: 'test-model-a' }, { id: 'test-model-b' }] })
  }
  if (req.url.includes('/chat/completions')) {
    const body = await readBody(req)
    if (body.stream === true) return chatStream(res, body)
    return send(res, 200, chatPayload(body))
  }
  if (req.url.includes('/responses')) {
    if (mode === 'chat-only') return send(res, 404, { error: { message: 'not found' } })
    const body = await readBody(req)
    if (mode === 'translated') {
      if (body.stream === true) return chatStream(res, body)
      return send(res, 200, chatPayload(body))
    }
    if (body.stream === true) return responsesStream(res, body)
    return send(res, 200, responsesPayload(body))
  }
  if (req.url.includes('/messages')) {
    if (mode === 'chat-only') return send(res, 404, { error: { message: 'not found' } })
    const body = await readBody(req)
    if (mode === 'translated') {
      if (body.stream === true) return chatStream(res, body)
      return send(res, 200, chatPayload(body))
    }
    if (body.stream === true) return anthropicStream(res, body)
    return send(res, 200, anthropicPayload(body))
  }
  // Gemini：/v1beta/models/{model}:generateContent
  const gem = String(req.url).match(/\/models\/([^:/?]+):(\w+)/)
  if (gem) {
    if (mode === 'chat-only') return send(res, 404, { error: { message: 'not found' } })
    const model = decodeURIComponent(gem[1])
    const action = gem[2]
    const body = await readBody(req)
    if (mode === 'translated') {
      if (action === 'streamGenerateContent') return chatStream(res, body)
      return send(res, 200, chatPayload(body))
    }
    if (action === 'streamGenerateContent') return geminiStream(res, body, model)
    return send(res, 200, geminiPayload(body, model))
  }
  return send(res, 404, { error: { message: 'not found' } })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`protocol mock on ${PORT} mode=${mode}`)
})
