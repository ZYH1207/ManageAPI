import { createServer } from 'node:http'

const PORT = Number(process.env.PORT || 5199)
let mode = process.env.MODE || 'native'
let seq = 0
const memories = new Map()

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

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
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

function chatPayload(body) {
  if (mode === 'degraded') {
    return {
      id: 'chatcmpl-degraded',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    }
  }
  const prompt = (body.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
  const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }
  let content = 'OK'
  let finish = 'stop'
  let toolCalls = null

  if (body.tools && (body.tool_choice || /get_weather/i.test(prompt))) {
    toolCalls = [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
      },
    ]
    finish = 'tool_calls'
  } else if (body.response_format?.type === 'json_schema') {
    content = '{"ok":true}'
  } else if (body.n === 2) {
    return {
      id: 'chatcmpl-n',
      object: 'chat.completion',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
        { index: 1, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
      ],
      usage,
    }
  } else if (Array.isArray(body.stop) && body.stop.includes('-BETA')) {
    content = 'ALPHA'
  } else if (/Repeat exactly/i.test(prompt)) {
    content = 'ALPHA-BETA-GAMMA'
  } else if (/Count from 1 to 50/i.test(prompt) && Number(body.max_tokens) <= 8) {
    content = '1,2,3,4'
    finish = 'length'
  }

  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: toolCalls ? null : content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
        finish_reason: finish,
      },
    ],
    usage,
  }
}

function chatStream(res, body) {
  if (mode === 'degraded') return send(res, 200, chatPayload(body))
  const payload = chatPayload(body)
  const choice = payload.choices[0]
  const content = choice.message.content || ''
  const events = []
  if (content) {
    for (const chunk of [content.slice(0, 1), content.slice(1)]) {
      events.push([null, { choices: [{ index: 0, delta: { content: chunk } }] }])
    }
  }
  events.push([null, { choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] }])
  if (body.stream_options?.include_usage) events.push([null, { choices: [], usage: payload.usage }])
  events.push([null, '[DONE]'])
  sse(res, events)
}

function responsesPayload(body) {
  const input = typeof body.input === 'string'
    ? body.input
    : (body.input || [])
        .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
        .map((part) => part?.text || '')
        .join('')
  const id = `resp_${++seq}`
  const usage = { input_tokens: 12, output_tokens: 3, total_tokens: 15 }

  if (body.previous_response_id) {
    const remembered = memories.get(body.previous_response_id) || ''
    return {
      id,
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: remembered || 'OK' }] }],
      usage,
    }
  }

  if (body.instructions && /7Q2K/.test(body.instructions)) {
    memories.set(id, '7Q2K')
    return {
      id,
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '7Q2K' }] }],
      usage,
    }
  }

  if (body.text?.format?.type === 'json_schema') {
    return {
      id,
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      usage,
    }
  }

  if (body.tools && /get_weather/i.test(input)) {
    return {
      id,
      object: 'response',
      status: 'completed',
      output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' }],
      usage,
    }
  }

  if (Number(body.max_output_tokens) <= 16 && /Count from 1 to 100/i.test(input)) {
    return {
      id,
      object: 'response',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '1,2,3' }] }],
      usage,
    }
  }

  if (/ORANGE/.test(input)) memories.set(id, 'ORANGE')
  return {
    id,
    object: 'response',
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
    usage,
  }
}

function responsesStream(res, body) {
  const payload = responsesPayload(body)
  const text = payload.output?.[0]?.content?.[0]?.text || 'OK'
  sse(res, [
    ['response.created', { type: 'response.created', response: { id: payload.id, status: 'in_progress', output: [] } }],
    ['response.output_item.added', { type: 'response.output_item.added', item: { type: 'message', role: 'assistant', content: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: text.slice(0, 2) }],
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: text.slice(2) }],
    ['response.completed', { type: 'response.completed', response: payload }],
  ])
}

function anthropicPayload(body) {
  const messages = body.messages || []
  const userText = messages
    .flatMap((m) => (typeof m.content === 'string' ? [m.content] : (m.content || []).map((p) => p.text || '')))
    .join('\n')
  const usage = { input_tokens: 12, output_tokens: 3 }
  const hasToolResult = messages.some((m) =>
    Array.isArray(m.content) && m.content.some((p) => p.type === 'tool_result'),
  )
  if (hasToolResult) {
    return {
      id: 'msg_tool_result',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'It is 22C and sunny in Paris.' }],
      stop_reason: 'end_turn',
      usage,
    }
  }
  if (body.tools && (body.tool_choice || /get_weather/i.test(userText))) {
    return {
      id: 'msg_tool',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }],
      stop_reason: 'tool_use',
      usage,
    }
  }
  if (body.system && /7Q2K/.test(body.system)) {
    return {
      id: 'msg_system',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '7Q2K' }],
      stop_reason: 'end_turn',
      usage,
    }
  }
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'OK' }],
    stop_reason: 'end_turn',
    usage,
  }
}

function anthropicStream(res, body) {
  const payload = anthropicPayload(body)
  const text = payload.content?.[0]?.text || 'OK'
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

const server = createServer(async (req, res) => {
  if (req.url === '/__mode') {
    const body = await readBody(req)
    mode = body.mode || 'native'
    return send(res, 200, { mode })
  }
  if (req.url.includes('/models')) {
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
  return send(res, 404, { error: { message: 'not found' } })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`protocol mock on ${PORT} mode=${mode}`)
})
