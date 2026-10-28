/**
 * 协议探查：回答两个问题。
 *
 *   1. 表面协议 —— 这个站到底接不接受 Chat Completions / Responses / Anthropic Messages？
 *      只看「请求有没有被收下、回来的东西像不像这个协议」。
 *   2. 真实协议 —— 如果它收下了，背后到底是原生实现，还是把请求翻成 Chat 再翻回来？
 *      办法是逐项验证原生协议才有的能力（Responses 的 previous_response_id、
 *      Anthropic 的 tool_result 块……），翻译层能装出外形，装不出这些。
 *
 * 这里只发探测请求，不写 db、不参与评分。超时和取消都按「无法判定」处理，
 * 不把网络问题算成站点缺失能力。
 */

const DEFAULT_TIMEOUT_MS = 45000
const DEFAULT_OVERALL_TIMEOUT_MS = 240000
const MAX_SSE_EVENTS = 800
const MAX_SSE_BYTES = 2 * 1024 * 1024

/** 三种表面协议 + 各自的原生能力清单。UI 的「原生基线」直接吃这份。 */
export const PROTOCOLS = {
  chat: {
    id: 'chat',
    label: 'OpenAI Chat Completions',
    short: 'Chat',
    path: '/chat/completions',
    capabilities: [
      { id: 'stream_sse', name: '流式 SSE', desc: 'stream=true 时按 choices[].delta 分块返回，并以 finish_reason / [DONE] 收尾' },
      { id: 'usage', name: 'usage 计量', desc: '返回 prompt_tokens / completion_tokens' },
      { id: 'tools', name: '函数调用 tools', desc: '接受 tools 并返回 tool_calls' },
      { id: 'tool_choice', name: '强制 tool_choice', desc: 'tool_choice 指定函数时必须调用它' },
      { id: 'json_schema', name: '结构化输出 json_schema', desc: 'response_format 的 json_schema 生效' },
      { id: 'n_choices', name: '多候选 n>1', desc: 'n=2 时返回两条 choices' },
      { id: 'stop_sequence', name: 'stop 序列', desc: 'stop 命中时立即停止输出' },
      { id: 'max_tokens', name: 'max_tokens 截断', desc: 'max_tokens 生效时 finish_reason=length' },
    ],
  },
  responses: {
    id: 'responses',
    label: 'OpenAI Responses',
    short: 'Responses',
    path: '/responses',
    capabilities: [
      { id: 'input_array', name: 'input 数组', desc: 'input 接受 message/item 数组，而不只是字符串' },
      { id: 'instructions', name: 'instructions 指令', desc: '顶层 instructions 被模型采纳' },
      { id: 'sse_sequence', name: '原生 SSE 事件序列', desc: 'response.created → output_text.delta → completed' },
      { id: 'output_items', name: '原生 output 结构', desc: 'output 是 message / output_text item 数组' },
      { id: 'tools_function', name: 'Responses 函数工具', desc: '扁平 tools 定义返回 function_call item' },
      { id: 'previous_response_id', name: 'previous_response_id 多轮', desc: '能按上一轮 id 继承上下文' },
      { id: 'incomplete', name: 'incomplete 截断状态', desc: 'max_output_tokens 用完时返回 status=incomplete' },
      { id: 'text_format', name: 'text.format 结构化输出', desc: 'text.format 的 json_schema 生效' },
    ],
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Messages',
    short: 'Anthropic',
    path: '/messages',
    capabilities: [
      { id: 'system_param', name: 'system 参数', desc: '顶层 system 被模型采纳' },
      { id: 'content_blocks', name: 'content 块数组', desc: '响应 content 是 text / tool_use 块数组' },
      { id: 'sse_events', name: '原生 SSE 事件序列', desc: 'message_start → content_block_delta → message_stop' },
      { id: 'tools', name: 'Anthropic 工具', desc: 'input_schema 工具返回 tool_use 块' },
      { id: 'tool_choice', name: '强制 tool_choice', desc: 'tool_choice={type:tool} 时必须调用' },
      { id: 'stop_reason', name: 'stop_reason', desc: '返回 end_turn / max_tokens / tool_use 等原生停止原因' },
      { id: 'usage', name: 'usage 计量', desc: '返回 input_tokens / output_tokens' },
      { id: 'tool_result', name: 'tool_result 回传', desc: '接受 tool_result 块并把工具结果交给模型' },
    ],
  },
}

export const PROTOCOL_ORDER = ['chat', 'responses', 'anthropic']

const SURFACE_FAIL = new Set(['unsupported', 'rejected', 'error-body'])
const SURFACE_UNKNOWN = new Set(['denied', 'rate-limited', 'upstream-error', 'network', 'cancelled'])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function trimBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '')
}

function textOf(value, max = 240) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return String(text || '').replace(/\s+/g, ' ').slice(0, max)
}

function errorMessage(payload) {
  if (!payload || typeof payload !== 'object') return ''
  return (
    payload.error?.message ||
    payload.error?.code ||
    payload.message ||
    payload.error ||
    ''
  )
}

function parseJsonLoose(text) {
  const raw = String(text || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
}

/** 从响应体判断它长得像哪个协议。 */
export function shapeOf(payload) {
  if (!payload || typeof payload !== 'object') return 'unknown'
  if (payload.error && !payload.choices && !payload.output) return 'error'
  if (Array.isArray(payload.choices)) return 'chat'
  if (payload.object === 'response' || (Array.isArray(payload.output) && payload.type !== 'message')) {
    return 'responses'
  }
  if (payload.type === 'message' && Array.isArray(payload.content)) return 'anthropic'
  if (payload.type === 'error') return 'error'
  return 'unknown'
}

function shapeOfEvents(events) {
  for (const entry of events || []) {
    const data = entry?.data
    if (Array.isArray(data?.choices)) return 'chat'
    const type = entry?.event || data?.type
    if (
      type === 'response.created' ||
      type === 'response.output_text.delta' ||
      type === 'response.completed' ||
      type === 'response.incomplete'
    ) {
      return 'responses'
    }
    if (type === 'message_start' || type === 'content_block_delta' || type === 'message_stop') {
      return 'anthropic'
    }
  }
  return 'unknown'
}

function chatText(payload) {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
  }
  return ''
}

function responsesText(payload) {
  let out = ''
  for (const item of payload?.output || []) {
    if (item?.type !== 'message') continue
    for (const part of item.content || []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') out += part.text
    }
  }
  if (!out && typeof payload?.output_text === 'string') out = payload.output_text
  return out
}

function anthropicText(payload) {
  return (payload?.content || [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function textOfPayload(payload) {
  return responsesText(payload) || anthropicText(payload) || chatText(payload)
}

/** 按协议发一次请求要带的鉴权头。 */
function authHeaders(protocol, apiKey, authMode) {
  const headers = { 'Content-Type': 'application/json' }
  if (!apiKey) return headers
  if (protocol !== 'anthropic') {
    headers.Authorization = `Bearer ${apiKey}`
    return headers
  }
  const mode = authMode || 'auto'
  if (mode === 'bearer') {
    headers.Authorization = `Bearer ${apiKey}`
  } else if (mode === 'x-api-key') {
    headers['x-api-key'] = apiKey
  } else {
    // 中转站两种都有人认：同时带上，先看谁先被接受。真官方 API 只认 x-api-key，
    // 但多一个 Authorization 不会影响它。
    headers['x-api-key'] = apiKey
    headers.Authorization = `Bearer ${apiKey}`
  }
  headers['anthropic-version'] = '2023-06-01'
  return headers
}

function authModesFor(protocol, authMode) {
  if (protocol !== 'anthropic') return ['bearer']
  const mode = authMode || 'auto'
  if (mode !== 'auto') return [mode]
  // auto：两个都带；401 时再单独试，兼容只认其中一种的站
  return ['auto', 'x-api-key', 'bearer']
}

/** 解析 SSE：同时认 `event:` 行和 data 里的 type 字段。 */
async function readSse(response, { signal } = {}) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ''
  let eventName = null
  let dataLines = []
  let bytes = 0
  let truncated = false

  const flush = () => {
    if (!eventName && dataLines.length === 0) return
    const raw = dataLines.join('\n')
    let data = raw
    if (raw && raw !== '[DONE]') {
      try {
        data = JSON.parse(raw)
      } catch {
        /* 非 JSON 的心跳行原样保留 */
      }
    }
    events.push({
      event: eventName || (data && typeof data === 'object' ? data.type : null) || null,
      data,
      raw: raw.slice(0, 2000),
    })
    eventName = null
    dataLines = []
  }

  const consume = (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line === '') {
        flush()
        continue
      }
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }

  try {
    while (events.length < MAX_SSE_EVENTS && bytes < MAX_SSE_BYTES) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value?.length || 0
      consume(decoder.decode(value, { stream: true }))
    }
    consume(decoder.decode())
    flush()
    if (events.length >= MAX_SSE_EVENTS || bytes >= MAX_SSE_BYTES) {
      truncated = true
      await reader.cancel().catch(() => {})
    }
  } finally {
    if (signal?.aborted) await reader.cancel().catch(() => {})
  }

  return { events, truncated, bytes }
}

function timeoutError() {
  const error = new Error('请求超时')
  error.code = 'TIMEOUT'
  return error
}

function cancelledError() {
  const error = new Error('已取消')
  error.code = 'CANCELLED'
  return error
}

function combineController(timeoutMs, outerSignal) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, Math.max(1, timeoutMs))
  const onAbort = () => controller.abort()
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort()
    else outerSignal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer)
      if (outerSignal) outerSignal.removeEventListener('abort', onAbort)
    },
  }
}

/** 一次 HTTP 请求（JSON 或 SSE）。所有网络错误都收敛成返回值，不往外抛。 */
async function requestOnce({
  protocol,
  baseUrl,
  apiKey,
  authMode,
  body,
  stream,
  timeoutMs,
  outerSignal,
}) {
  const url = `${trimBase(baseUrl)}${PROTOCOLS[protocol].path}`
  const started = Date.now()
  const combo = combineController(timeoutMs, outerSignal)
  const headers = authHeaders(protocol, apiKey, authMode)
  headers.Accept = stream ? 'text/event-stream' : 'application/json'

  const result = {
    protocol,
    path: PROTOCOLS[protocol].path,
    url,
    status: null,
    ok: false,
    ms: 0,
    error: null,
    text: '',
    payload: null,
    events: [],
    shape: 'unknown',
    authMode: protocol === 'anthropic' ? authMode || 'auto' : 'bearer',
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combo.signal,
    })
    result.status = response.status
    result.ok = response.ok
    result.contentType = String(response.headers.get('content-type') || '')

    if (stream && response.ok) {
      const sse = await readSse(response, { signal: combo.signal })
      result.events = sse.events
      result.truncated = sse.truncated
      result.bytes = sse.bytes
      result.shape = shapeOfEvents(sse.events)
      result.text = sse.events.map((entry) => entry.raw).join('\n').slice(0, 4000)
    } else {
      const text = await response.text()
      result.text = text.slice(0, 4000)
      try {
        result.payload = text ? JSON.parse(text) : null
      } catch {
        result.payload = null
      }
      result.shape = shapeOf(result.payload)
    }

    if (!response.ok) {
      result.error = errorMessage(result.payload) || result.text.slice(0, 240) || `HTTP ${response.status}`
    }
  } catch (error) {
    result.error = combo.timedOut()
      ? '请求超时'
      : outerSignal?.aborted
        ? '已取消'
        : error?.message || String(error)
    result.code = combo.timedOut() ? 'TIMEOUT' : outerSignal?.aborted ? 'CANCELLED' : 'NETWORK'
  } finally {
    combo.cleanup()
    result.ms = Date.now() - started
  }

  return result
}

function createContext({ baseUrl, apiKey, model, timeoutMs, deadline, authMode, signal }) {
  const requests = []

  async function request(protocol, body, { stream = false, timeoutOverride } = {}) {
    if (signal?.aborted) throw cancelledError()
    if (Date.now() > deadline) throw timeoutError()

    let last = null
    for (const mode of authModesFor(protocol, authMode)) {
      const result = await requestOnce({
        protocol,
        baseUrl,
        apiKey,
        authMode: mode,
        body,
        stream,
        timeoutMs: Math.min(timeoutOverride || timeoutMs, Math.max(1, deadline - Date.now())),
        outerSignal: signal,
      })
      requests.push({
        protocol,
        path: result.path,
        status: result.status,
        ok: result.ok,
        ms: result.ms,
        error: result.error,
        authMode: result.authMode,
      })
      last = result
      // 只有 401 才换鉴权方式；403 往往是分组/权限问题，换法也没用
      if (result.status !== 401) break
      if (result.code === 'CANCELLED') break
    }
    if (last?.code === 'TIMEOUT') throw timeoutError()
    if (last?.code === 'CANCELLED') throw cancelledError()
    return last
  }

  return {
    baseUrl,
    apiKey,
    model,
    timeoutMs,
    deadline,
    signal,
    requests,
    json(protocol, body, options) {
      return request(protocol, body, { ...options, stream: false })
    },
    stream(protocol, body, options) {
      return request(protocol, body, { ...options, stream: true })
    },
  }
}

function httpFailure(result) {
  const detail = result.error || `HTTP ${result.status ?? '未知'}`
  const status = [400, 401, 403, 404, 405, 422].includes(result.status) ? 'fail' : 'unknown'
  return {
    status,
    detail,
    evidence: { status: result.status, error: result.error, ms: result.ms },
  }
}

function pass(detail, evidence = null) {
  return { status: 'pass', detail, evidence }
}

function fail(detail, evidence = null) {
  return { status: 'fail', detail, evidence }
}

function unknown(detail, evidence = null) {
  return { status: 'unknown', detail, evidence }
}

// ------------------------------------------------------------------ 表面协议

function surfaceBody(protocol, model) {
  const prompt = 'Reply with the single word OK.'
  if (protocol === 'responses') {
    return { model, input: prompt, max_output_tokens: 16 }
  }
  if (protocol === 'anthropic') {
    return { model, max_tokens: 16, messages: [{ role: 'user', content: prompt }] }
  }
  return {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 16,
    temperature: 0,
  }
}

// 网络层错误码：出现这些说明根本没到 HTTP 层，不能把状态按 4xx/5xx 分类
const NETWORK_CODES = new Set(['TIMEOUT', 'CANCELLED', 'NETWORK', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])

function classifySurface(protocol, result) {
  if (result.status >= 200 && result.status < 300) {
    if (result.payload?.error) return 'error-body'
    if (result.shape === protocol) return 'native'
    if (result.shape === 'chat' || result.shape === 'responses' || result.shape === 'anthropic') {
      return 'translated'
    }
    return 'unknown'
  }

  if (!result.status && (NETWORK_CODES.has(result.code) || /fetch failed|timeout|aborted|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(result.error || ''))) {
    return 'network'
  }
  const message = result.error || ''
  if (result.status === 403) {
    // 「这个分组不允许 /v1/responses」是明确不支持，不是 Key 错了
    if (/(not\s+allow|does\s+not\s+allow|unsupported|not\s+support|permission)/i.test(message) &&
        !/(invalid|expired|unauthori[sz]ed|api\s*key|token)/i.test(message)) {
      return 'unsupported'
    }
    return 'denied'
  }
  if (result.status === 401) return 'denied'
  if (result.status === 404 || result.status === 405) return 'unsupported'
  if (result.status === 400 || result.status === 422) return 'rejected'
  if (result.status === 429) return 'rate-limited'
  if (result.status >= 500) return 'upstream-error'
  return 'unknown'
}


async function probeSurface(protocolId, ctx) {
  const started = Date.now()
  try {
    const result = await ctx.json(protocolId, surfaceBody(protocolId, ctx.model), {
      timeoutOverride: ctx.timeoutMs,
    })
    const outcome = classifySurface(protocolId, result)
    return {
      protocol: protocolId,
      outcome,
      canProbe: result.ok,
      httpStatus: result.status,
      shape: result.shape,
      latencyMs: result.ms || Date.now() - started,
      error: result.error,
      authMode: result.authMode,
      evidence: {
        status: result.status,
        contentType: result.contentType || null,
        shape: result.shape,
        text: result.text ? result.text.slice(0, 600) : '',
        usage: result.payload?.usage || null,
      },
    }
  } catch (error) {
    return {
      protocol: protocolId,
      outcome: error?.code === 'CANCELLED' ? 'cancelled' : 'network',
      canProbe: false,
      httpStatus: null,
      shape: 'unknown',
      latencyMs: Date.now() - started,
      error: error?.message || String(error),
      evidence: null,
    }
  }
}

// ------------------------------------------------------------------ Chat 能力

const WEATHER_CHAT_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
}

const WEATHER_RESPONSES_TOOL = {
  type: 'function',
  name: 'get_weather',
  description: 'Get the weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
}

const WEATHER_ANTHROPIC_TOOL = {
  name: 'get_weather',
  description: 'Get the weather for a city.',
  input_schema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
}

const JSON_SCHEMA_OK = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
}

const CHAT_TESTS = {
  async stream_sse(ctx) {
    const result = await ctx.stream('chat', {
      model: ctx.model,
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      max_tokens: 16,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
    })
    if (!result.ok) return httpFailure(result)
    const events = result.events || []
    const hasDelta = events.some(
      (entry) =>
        Array.isArray(entry.data?.choices) &&
        entry.data.choices.some((choice) => choice?.delta && (typeof choice.delta.content === 'string' || choice.delta.role)),
    )
    const hasFinish = events.some(
      (entry) =>
        entry.data === '[DONE]' ||
        (Array.isArray(entry.data?.choices) &&
          entry.data.choices.some((choice) => choice?.finish_reason)),
    )
    if (hasDelta && hasFinish) {
      return pass(`收到 ${events.length} 个 SSE 事件，delta 与结束标记都在`, { events: events.length })
    }
    if (result.payload && Array.isArray(result.payload.choices)) {
      return fail('上游忽略 stream=true，返回了普通 JSON')
    }
    return fail(`SSE 结构不完整（${events.length} 个事件，delta=${hasDelta}，结束=${hasFinish}）`, {
      events: events.slice(0, 3).map((entry) => entry.raw),
    })
  },

  async usage(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 16,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const usage = result.payload?.usage
    const prompt = usage?.prompt_tokens ?? usage?.input_tokens
    const completion = usage?.completion_tokens ?? usage?.output_tokens
    if (typeof prompt === 'number' && typeof completion === 'number') {
      return pass(`prompt_tokens=${prompt}，completion_tokens=${completion}`, { usage })
    }
    return fail('响应里没有 usage（或字段不是数字）', { usage: usage ?? null })
  },

  async tools(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [
        {
          role: 'user',
          content: 'Use the get_weather tool to check the weather in Paris. Do not answer directly.',
        },
      ],
      tools: [WEATHER_CHAT_TOOL],
      tool_choice: 'auto',
      max_tokens: 120,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const calls = result.payload?.choices?.[0]?.message?.tool_calls
    const hit = Array.isArray(calls) ? calls.find((call) => call?.function?.name === 'get_weather') : null
    if (hit) {
      return pass(`返回 tool_calls：${hit.function.name}`, {
        arguments: hit.function.arguments,
      })
    }
    return fail(`没有返回 get_weather 的 tool_calls（finish_reason=${result.payload?.choices?.[0]?.finish_reason ?? '未知'}）`)
  },

  async tool_choice(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [
        {
          role: 'user',
          content: 'Call the get_weather tool with city Paris. Do not answer directly.',
        },
      ],
      tools: [WEATHER_CHAT_TOOL],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      max_tokens: 120,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const calls = result.payload?.choices?.[0]?.message?.tool_calls
    const hit = Array.isArray(calls) ? calls.find((call) => call?.function?.name === 'get_weather') : null
    if (hit) return pass('强制 tool_choice 生效', { arguments: hit.function.arguments })
    return fail('指定 tool_choice 后仍没有调用 get_weather')
  },

  async json_schema(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [
        {
          role: 'user',
          content: 'Return exactly this JSON object and nothing else: {"ok":true}',
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'ok', strict: true, schema: JSON_SCHEMA_OK },
      },
      max_tokens: 64,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const text = chatText(result.payload)
    const parsed = parseJsonLoose(text)
    if (parsed?.ok === true) return pass('json_schema 生效，返回 {"ok":true}', { text })
    return fail(`json_schema 未生效：${text ? text.slice(0, 80) : '空回答'}`, { text })
  },

  async n_choices(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      n: 2,
      max_tokens: 8,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const choices = result.payload?.choices
    if (Array.isArray(choices) && choices.length >= 2) {
      return pass(`n=2 返回了 ${choices.length} 条 choices`, { choices: choices.length })
    }
    return fail(`n=2 只返回了 ${Array.isArray(choices) ? choices.length : 0} 条 choices`)
  },

  async stop_sequence(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [
        {
          role: 'user',
          content: 'Repeat exactly this string and nothing else: ALPHA-BETA-GAMMA',
        },
      ],
      stop: ['-BETA'],
      max_tokens: 32,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const text = chatText(result.payload)
    if (!text) return fail('回答为空，无法判断 stop 是否生效')
    if (text.includes('BETA')) {
      return fail(`stop 未生效，输出里仍出现 BETA：${text.slice(0, 80)}`, { text })
    }
    if (text.includes('ALPHA')) {
      return pass(`stop 生效，输出停在：${text.slice(0, 40)}`, { text })
    }
    return unknown(`模型没按要求复读，无法判断 stop：${text.slice(0, 80)}`, { text })
  },

  async max_tokens(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [
        { role: 'user', content: 'Count from 1 to 50, separated by commas.' },
      ],
      max_tokens: 8,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const finishReason = result.payload?.choices?.[0]?.finish_reason
    if (finishReason === 'length') {
      return pass('max_tokens=8 生效，finish_reason=length', { finishReason })
    }
    return fail(`finish_reason=${finishReason ?? '缺失'}，max_tokens 可能被忽略`, { finishReason })
  },
}

// ------------------------------------------------------------- Responses 能力

const RESPONSES_TESTS = {
  async input_array(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Reply with the single word OK.' }],
        },
      ],
      max_output_tokens: 16,
    })
    if (!result.ok) return httpFailure(result)
    const text = textOfPayload(result.payload)
    if (text) return pass(`接受 input 数组，返回「${text.slice(0, 40)}」`, { text })
    return fail('2xx 但 output 里没有正文')
  },

  async instructions(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      instructions:
        'The reference code is 7Q2K. When the user asks for the reference code, reply with only the code.',
      input: 'What is the reference code?',
      max_output_tokens: 16,
    })
    if (!result.ok) return httpFailure(result)
    const text = textOfPayload(result.payload)
    if (/7Q2K/i.test(text)) return pass('instructions 被采纳，回答 7Q2K', { text })
    return fail(`instructions 未被采纳：${text ? text.slice(0, 80) : '空回答'}`, { text })
  },

  async sse_sequence(ctx) {
    const result = await ctx.stream('responses', {
      model: ctx.model,
      input: 'Reply with OK.',
      max_output_tokens: 16,
      stream: true,
    })
    if (!result.ok) return httpFailure(result)
    const types = new Set(
      (result.events || []).map((entry) => entry.event || entry.data?.type).filter(Boolean),
    )
    const hasCreated = types.has('response.created')
    const hasDelta = types.has('response.output_text.delta') || types.has('response.output_item.added')
    const terminal = types.has('response.completed') || types.has('response.incomplete')
    if (hasCreated && hasDelta && terminal) {
      return pass(`原生事件序列完整（${[...types].slice(0, 6).join(' → ')}）`, {
        types: [...types],
      })
    }
    return fail(`事件序列不完整：${[...types].slice(0, 10).join(', ') || '没有可识别的 Responses 事件'}`, {
      types: [...types],
    })
  },

  async output_items(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      input: 'Reply with OK.',
      max_output_tokens: 16,
    })
    if (!result.ok) return httpFailure(result)
    const output = result.payload?.output
    const hasMessage = Array.isArray(output) && output.some(
      (item) =>
        item?.type === 'message' &&
        Array.isArray(item.content) &&
        item.content.some((part) => part?.type === 'output_text'),
    )
    if (result.payload?.object === 'response' && hasMessage) {
      return pass('output 是原生 message / output_text item 数组', { outputTypes: output.map((item) => item.type) })
    }
    return fail(`output 不是 Responses 原生结构（object=${result.payload?.object ?? '缺失'}）`, {
      object: result.payload?.object ?? null,
    })
  },

  async tools_function(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      input: 'Use the get_weather tool to check the weather in Paris. Do not answer directly.',
      tools: [WEATHER_RESPONSES_TOOL],
      tool_choice: 'auto',
      max_output_tokens: 120,
    })
    if (!result.ok) return httpFailure(result)
    const call = (result.payload?.output || []).find((item) => item?.type === 'function_call')
    if (call?.name === 'get_weather') {
      return pass(`返回 function_call：${call.name}`, { arguments: call.arguments })
    }
    const types = (result.payload?.output || []).map((item) => item?.type).filter(Boolean)
    return fail(`没有 function_call item（output: ${types.join(', ') || '空'}）`, { types })
  },

  async previous_response_id(ctx) {
    const first = await ctx.json('responses', {
      model: ctx.model,
      input: 'Remember the word ORANGE. Reply with OK.',
      store: true,
      max_output_tokens: 16,
    })
    if (!first.ok) return httpFailure(first)
    const id = first.payload?.id
    if (!id) return fail('首轮响应没有 id，无法用 previous_response_id', { text: first.text?.slice(0, 120) })

    const second = await ctx.json('responses', {
      model: ctx.model,
      previous_response_id: id,
      input: 'What word did I ask you to remember? Reply with only that word.',
      max_output_tokens: 16,
    })
    if (!second.ok) return httpFailure(second)
    const text = textOfPayload(second.payload)
    if (/ORANGE/i.test(text)) return pass('previous_response_id 带上了上一轮上下文', { id, text })
    return fail(`previous_response_id 没有带上上下文：${text ? text.slice(0, 80) : '空回答'}`, { id, text })
  },

  async incomplete(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      input: 'Count from 1 to 100, separated by commas.',
      max_output_tokens: 16,
    })
    if (!result.ok) return httpFailure(result)
    const status = result.payload?.status
    const reason = result.payload?.incomplete_details?.reason
    if (status === 'incomplete' && (!reason || reason === 'max_output_tokens')) {
      return pass(`status=incomplete${reason ? `，reason=${reason}` : ''}`, { status, reason })
    }
    return fail(`status=${status ?? '缺失'}，incomplete_details=${reason ?? '缺失'}`, { status, reason })
  },

  async text_format(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      input: 'Return exactly this JSON object and nothing else: {"ok":true}',
      text: {
        format: { type: 'json_schema', name: 'ok', strict: true, schema: JSON_SCHEMA_OK },
      },
      max_output_tokens: 64,
    })
    if (!result.ok) return httpFailure(result)
    const text = textOfPayload(result.payload)
    const parsed = parseJsonLoose(text)
    if (parsed?.ok === true) return pass('text.format 的 json_schema 生效', { text })
    return fail(`text.format 未生效：${text ? text.slice(0, 80) : '空回答'}`, { text })
  },
}

// ------------------------------------------------------------- Anthropic 能力

const ANTHROPIC_TESTS = {
  async system_param(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: 32,
      system:
        'The reference code is 7Q2K. When the user asks for the reference code, reply with only the code.',
      messages: [{ role: 'user', content: 'What is the reference code?' }],
    })
    if (!result.ok) return httpFailure(result)
    const text = textOfPayload(result.payload)
    if (/7Q2K/i.test(text)) return pass('system 参数被采纳，回答 7Q2K', { text })
    return fail(`system 参数未被采纳：${text ? text.slice(0, 80) : '空回答'}`, { text })
  },

  async content_blocks(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    })
    if (!result.ok) return httpFailure(result)
    const blocks = result.payload?.content
    const hasText = Array.isArray(blocks) && blocks.some(
      (block) => block?.type === 'text' && typeof block.text === 'string',
    )
    if (result.payload?.type === 'message' && hasText) {
      return pass('content 是 Anthropic 的 text 块数组', {
        blockTypes: blocks.map((block) => block.type),
      })
    }
    return fail(`content 不是 Anthropic 块结构（type=${result.payload?.type ?? '缺失'}）`, {
      type: result.payload?.type ?? null,
    })
  },

  async sse_events(ctx) {
    const result = await ctx.stream('anthropic', {
      model: ctx.model,
      max_tokens: 16,
      stream: true,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    })
    if (!result.ok) return httpFailure(result)
    const types = new Set(
      (result.events || []).map((entry) => entry.event || entry.data?.type).filter(Boolean),
    )
    const required = ['message_start', 'content_block_start', 'content_block_delta', 'message_stop']
    const missing = required.filter((type) => !types.has(type))
    if (missing.length === 0) {
      return pass(`原生事件序列完整（${[...types].slice(0, 6).join(' → ')}）`, { types: [...types] })
    }
    return fail(`缺少事件：${missing.join(', ')}（收到 ${[...types].slice(0, 8).join(', ') || '无可识别事件'}）`, {
      types: [...types],
    })
  },

  async tools(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: 120,
      tools: [WEATHER_ANTHROPIC_TOOL],
      messages: [
        {
          role: 'user',
          content: 'Use the get_weather tool to check the weather in Paris. Do not answer directly.',
        },
      ],
    })
    if (!result.ok) return httpFailure(result)
    const block = (result.payload?.content || []).find((item) => item?.type === 'tool_use')
    if (block?.name === 'get_weather' && block.input && typeof block.input === 'object') {
      return pass(`返回 tool_use：${block.name}`, { input: block.input })
    }
    return fail('没有返回 get_weather 的 tool_use 块')
  },

  async tool_choice(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: 120,
      tools: [WEATHER_ANTHROPIC_TOOL],
      tool_choice: { type: 'tool', name: 'get_weather' },
      messages: [
        {
          role: 'user',
          content: 'Call the get_weather tool with city Paris. Do not answer directly.',
        },
      ],
    })
    if (!result.ok) return httpFailure(result)
    const block = (result.payload?.content || []).find((item) => item?.type === 'tool_use')
    if (block?.name === 'get_weather') return pass('强制 tool_choice 生效', { input: block.input })
    return fail('指定 tool_choice 后仍没有调用 get_weather')
  },

  async stop_reason(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    })
    if (!result.ok) return httpFailure(result)
    const reason = result.payload?.stop_reason
    if (typeof reason === 'string' && reason) {
      return pass(`stop_reason=${reason}`, { stopReason: reason })
    }
    return fail('响应里没有 stop_reason')
  },

  async usage(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    })
    if (!result.ok) return httpFailure(result)
    const usage = result.payload?.usage
    if (typeof usage?.input_tokens === 'number' && typeof usage?.output_tokens === 'number') {
      return pass(`input_tokens=${usage.input_tokens}，output_tokens=${usage.output_tokens}`, { usage })
    }
    return fail('响应里没有 input_tokens / output_tokens', { usage: usage ?? null })
  },

  async tool_result(ctx) {
    const first = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: 120,
      tools: [WEATHER_ANTHROPIC_TOOL],
      messages: [
        { role: 'user', content: 'What is the weather in Paris? Use the get_weather tool.' },
      ],
    })
    if (!first.ok) return httpFailure(first)
    const toolUse = (first.payload?.content || []).find((item) => item?.type === 'tool_use')
    if (!toolUse?.id) return fail('首轮没有返回 tool_use，无法测试 tool_result')

    const second = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: 64,
      tools: [WEATHER_ANTHROPIC_TOOL],
      messages: [
        { role: 'user', content: 'What is the weather in Paris? Use the get_weather tool.' },
        { role: 'assistant', content: [toolUse] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: toolUse.id, content: '22C and sunny' },
          ],
        },
      ],
    })
    if (!second.ok) return httpFailure(second)
    const text = textOfPayload(second.payload)
    if (/22/.test(text)) return pass('tool_result 块被采纳，回答里带上了工具结果', { text })
    return fail(`tool_result 未被采纳：${text ? text.slice(0, 80) : '空回答'}`, { text })
  },
}

const TESTS = {
  chat: CHAT_TESTS,
  responses: RESPONSES_TESTS,
  anthropic: ANTHROPIC_TESTS,
}

function fallbackCapabilities(protocolId, surface) {
  const reason =
    surface?.error ||
    (surface?.httpStatus ? `HTTP ${surface.httpStatus}` : '表面协议未通过')
  return PROTOCOLS[protocolId].capabilities.map((capability) => ({
    ...capability,
    status: SURFACE_FAIL.has(surface?.outcome) ? 'fail' : 'unknown',
    detail: SURFACE_FAIL.has(surface?.outcome)
      ? `表面协议不支持：${reason}`
      : `无法判定：${reason}`,
    evidence: { surface: surface?.outcome ?? 'unknown' },
  }))
}

async function runCapabilities(protocolId, ctx, surface, onProgress) {
  const capabilities = []
  for (const meta of PROTOCOLS[protocolId].capabilities) {
    if (ctx.signal?.aborted) {
      capabilities.push({ ...meta, status: 'unknown', detail: '已取消', evidence: null })
      continue
    }
    if (Date.now() > ctx.deadline) {
      capabilities.push({ ...meta, status: 'unknown', detail: '整体超时，未测', evidence: null })
      continue
    }
    onProgress?.({ type: 'capability-start', protocol: protocolId, capability: meta.id })
    let result
    try {
      result = await TESTS[protocolId][meta.id](ctx)
    } catch (error) {
      result = {
        status: error?.code === 'CANCELLED' || error?.code === 'TIMEOUT' ? 'unknown' : 'unknown',
        detail: error?.message || String(error),
        evidence: null,
      }
    }
    const row = { ...meta, ...result }
    capabilities.push(row)
    onProgress?.({ type: 'capability', protocol: protocolId, capability: row })
    await sleep(60)
  }
  return capabilities
}

// ------------------------------------------------------------------ 真实协议

function inferRealProtocol(protocolId, surface, capabilities) {
  const known = capabilities.filter((capability) => capability.status !== 'unknown')
  const passed = known.filter((capability) => capability.status === 'pass').length
  const passRate = known.length ? passed / known.length : 0
  const shape = surface?.shape

  // 端点根本没被接受：没有「真实协议」可谈，直接说不支持，别硬猜成 Chat
  if (SURFACE_FAIL.has(surface?.outcome)) {
    return {
      id: 'unsupported',
      label: '不支持该协议',
      confidence: 'high',
      note: surface?.error
        ? `${PROTOCOLS[protocolId].label} 请求被拒：${surface.error}`
        : `${PROTOCOLS[protocolId].label} 端点不可用。`,
    }
  }
  if (SURFACE_UNKNOWN.has(surface?.outcome)) {
    return {
      id: 'unknown',
      label: '无法判定',
      confidence: 'low',
      note: `表面协议没有拿到可用响应：${surface?.error || surface?.outcome}`,
    }
  }

  if (shape === 'chat' && protocolId !== 'chat') {
    return {
      id: 'chat',
      label: 'OpenAI Chat Completions（底层翻译）',
      confidence: 'high',
      note: `表面是 ${PROTOCOLS[protocolId].label}，但响应体是 Chat 的 choices/delta 结构。`,
    }
  }

  if (protocolId === 'chat') {
    if (shape === 'chat') {
      return {
        id: 'chat',
        label: 'OpenAI Chat Completions（原生）',
        confidence: 'high',
        note:
          known.length && passed < known.length
            ? `${known.length} 项原生能力中 ${passed} 项通过；协议是原生的，但站点或模型有裁剪。`
            : '8 项原生能力全部通过。',
      }
    }
    const label =
      shape === 'responses'
        ? 'OpenAI Responses'
        : shape === 'anthropic'
          ? 'Anthropic Messages'
          : '无法判定'
    return { id: shape === 'unknown' ? 'unknown' : shape, label, confidence: 'medium', note: 'Chat 端点返回了别的协议形状。' }
  }

  const strongIds =
    protocolId === 'responses'
      ? ['previous_response_id', 'incomplete', 'tools_function', 'text_format']
      : ['tools', 'tool_result', 'stop_reason']
  const strongPassed = strongIds.filter(
    (id) => capabilities.find((capability) => capability.id === id)?.status === 'pass',
  ).length
  const nativeLabel = `${PROTOCOLS[protocolId].label}（原生）`
  const compatLabel = `${PROTOCOLS[protocolId].label} 兼容层（部分原生能力缺失）`

  if (shape === protocolId && strongPassed >= strongIds.length - 1 && passRate >= 0.75) {
    return {
      id: protocolId,
      label: nativeLabel,
      confidence: 'high',
      note:
        passed === known.length
          ? '8 项原生能力全部通过。'
          : `${known.length} 项能力中 ${passed} 项通过；未通过的可能是模型限制。`,
    }
  }

  if (shape === protocolId && strongPassed >= 1) {
    return {
      id: `${protocolId}-compat`,
      label: compatLabel,
      confidence: 'medium',
      note: `关键原生能力只有 ${strongPassed}/${strongIds.length} 项通过，底层很可能是 Chat 翻译层。`,
    }
  }

  if (shape === protocolId) {
    return {
      id: 'chat',
      label: 'OpenAI Chat Completions（底层翻译）',
      confidence: 'medium',
      note: '外形像原生协议，但关键原生能力全部缺失，判断为翻译层。',
    }
  }

  return {
    id: 'unknown',
    label: '无法判定',
    confidence: 'low',
    note: '表面协议没有返回可识别的结构，能力测试也无法给出结论。',
  }
}

function summarize(protocols, requests, durationMs) {
  const surfaceSupported = []
  const surfaceNative = []
  const surfaceTranslated = []
  const realProtocols = {}
  let pass = 0
  let fail = 0
  let unknownCount = 0

  for (const id of PROTOCOL_ORDER) {
    const entry = protocols[id]
    if (!entry) continue
    if (entry.surface?.canProbe) surfaceSupported.push(id)
    if (entry.surface?.outcome === 'native') surfaceNative.push(id)
    if (entry.surface?.outcome === 'translated') surfaceTranslated.push(id)
    if (entry.real?.id) realProtocols[id] = entry.real
    for (const capability of entry.capabilities || []) {
      if (capability.status === 'pass') pass += 1
      else if (capability.status === 'fail') fail += 1
      else unknownCount += 1
    }
  }

  return {
    surfaceSupported,
    surfaceNative,
    surfaceTranslated,
    realProtocols,
    capabilities: { pass, fail, unknown: unknownCount, total: pass + fail + unknownCount },
    requests: requests.length,
    durationMs,
  }
}

/**
 * 探查一个「地址 + Key + 模型」的表面协议和背后的真实能力。
 *
 * @param {{
 *   baseUrl: string,
 *   apiKey: string,
 *   model: string,
 *   protocols?: string[],                     // 只探其中这几个（如非 Anthropic 模型跳过 anthropic）
 *   timeoutMs?: number,
 *   overallTimeoutMs?: number,
 *   authMode?: 'auto'|'bearer'|'x-api-key',
 *   signal?: AbortSignal,
 *   onProgress?: (event: object) => void,
 * }} options
 */
export async function probeProtocols({
  baseUrl,
  apiKey,
  model,
  protocols,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  overallTimeoutMs = DEFAULT_OVERALL_TIMEOUT_MS,
  authMode = 'auto',
  signal,
  onProgress,
}) {
  const scope =
    Array.isArray(protocols) && protocols.length
      ? PROTOCOL_ORDER.filter((id) => protocols.includes(id))
      : PROTOCOL_ORDER
  const started = Date.now()
  const deadline = started + overallTimeoutMs
  const ctx = createContext({
    baseUrl: trimBase(baseUrl),
    apiKey,
    model,
    timeoutMs,
    deadline,
    authMode,
    signal,
  })

  onProgress?.({
    type: 'start',
    target: { baseUrl: ctx.baseUrl, model },
    protocols: scope.map((id) => ({
      id,
      label: PROTOCOLS[id].label,
      capabilities: PROTOCOLS[id].capabilities,
    })),
  })

  // 表面协议并发探：它们互不依赖，串行会让用户多等两个来回
  const surfaces = {}
  await Promise.all(
    scope.map(async (id) => {
      onProgress?.({ type: 'surface-start', protocol: id })
      const surface = await probeSurface(id, ctx)
      surfaces[id] = surface
      onProgress?.({ type: 'surface', protocol: id, surface })
    }),
  )

  // 能力测试也按协议并发；每个协议内部串行，避免同一个站被 24 个请求同时打
  const protocolResults = {}
  await Promise.all(
    scope.map(async (id) => {
      const surface = surfaces[id]
      let capabilities
      if (surface.canProbe) {
        capabilities = await runCapabilities(id, ctx, surface, onProgress)
      } else {
        capabilities = fallbackCapabilities(id, surface)
        for (const capability of capabilities) {
          onProgress?.({ type: 'capability', protocol: id, capability })
        }
      }
      const real = inferRealProtocol(id, surface, capabilities)
      const passed = capabilities.filter((capability) => capability.status === 'pass').length
      const failed = capabilities.filter((capability) => capability.status === 'fail').length
      const unknownCount = capabilities.filter((capability) => capability.status === 'unknown').length
      protocolResults[id] = {
        id,
        label: PROTOCOLS[id].label,
        short: PROTOCOLS[id].short,
        path: PROTOCOLS[id].path,
        surface,
        real,
        capabilities,
        summary: { pass: passed, fail: failed, unknown: unknownCount, total: capabilities.length },
      }
      onProgress?.({ type: 'protocol', protocol: id, result: protocolResults[id] })
    }),
  )

  const finishedAt = new Date().toISOString()
  const result = {
    ok: true,
    target: {
      baseUrl: ctx.baseUrl,
      model,
      authMode,
    },
    startedAt: new Date(started).toISOString(),
    finishedAt,
    durationMs: Date.now() - started,
    protocols: protocolResults,
    summary: summarize(protocolResults, ctx.requests, Date.now() - started),
    requests: ctx.requests,
    skippedProtocols: PROTOCOL_ORDER.filter((id) => !scope.includes(id)),
  }

  onProgress?.({ type: 'result', result })
  return result
}
