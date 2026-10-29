/**
 * 协议探查：回答三个问题。
 *
 *   1. 表面协议 —— 这个站到底接不接受 Chat Completions / Responses / Anthropic / Gemini？
 *      只看「请求有没有被收下、回来的东西像不像这个协议」。
 *   2. 真实协议 —— 如果它收下了，背后到底是原生实现，还是把请求翻成 Chat 再翻回来？
 *      办法是逐项验证原生协议才有的能力（Responses 的 previous_response_id、
 *      Anthropic 的 tool_result 块……），翻译层能装出外形，装不出这些。
 *   3. 能不能干活 —— 由 core/protocol-verdict.js 把实测结果翻成「能做什么 / 能导进哪个工具 /
 *      导错会怎样」，这一层不猜，只拿 requires 和实测求交集。
 *
 * 能力清单本身在 core/protocol-catalog.js（界面与记录页共用同一份，避免口径漂移）。
 *
 * 这里只发探测请求，不写 db、不参与评分。超时和取消都按「无法判定」处理，
 * 不把网络问题算成站点缺失能力。
 */

import { PROTOCOLS, PROTOCOL_ORDER, capabilitiesFor } from './protocol-catalog.js'
import { protocolVerdict, overallAdvice } from './protocol-verdict.js'

export { PROTOCOLS, PROTOCOL_ORDER }
export { PROBE_MODES, REPEAT_OPTIONS, CONSUMERS, capabilitiesFor } from './protocol-catalog.js'

const DEFAULT_TIMEOUT_MS = 45000
const DEFAULT_OVERALL_TIMEOUT_MS = 240000
const MAX_SSE_EVENTS = 800
const MAX_SSE_BYTES = 2 * 1024 * 1024
/** 普通能力探测的 token 预算：推理模型会先花预算在想上，给太小会误判成「不可用」。 */
const BUDGET = 900
/** 要模型「必须调工具」的探测：预算更宽松，否则它还没想完就被截断。 */
const TOOL_BUDGET = 2500
/** 长上下文探针的填充量（约 1.3 万字符，不会被任何正常模型截掉）。 */
const LONG_FILLER = '这是一段用于填充上下文的无关文字，不包含任何需要记忆的信息。'.repeat(400)

/** 一张 64x64 纯红 PNG：视觉探针用，足够大不会被当成无效图片。 */
const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwIqof2UTMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj12qxUDxeFqrFAAAAABJRU5ErkJggg=='

/** 结构化输出探针用的 schema：两个字段、都必填，能同时验证「有没有真按 schema 来」。 */
const PERSON_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' }, age: { type: 'integer' } },
  required: ['name', 'age'],
  additionalProperties: false,
}


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

/**
 * 结构化输出的判据用**严格解析**：带 ``` 围栏、或前面加一句「好的，这是 JSON」的，
 * 都算没生效 —— 程序化消费方是 JSON.parse 直接吃的，宽容解析只会把真缺陷洗白。
 */
function parseJsonStrict(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
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
  if (payload.error && !payload.choices && !payload.output && !payload.candidates) return 'error'
  if (Array.isArray(payload.choices)) return 'chat'
  if (payload.object === 'response' || (Array.isArray(payload.output) && payload.type !== 'message')) {
    return 'responses'
  }
  if (payload.type === 'message' && Array.isArray(payload.content)) return 'anthropic'
  if (Array.isArray(payload.candidates)) return 'gemini'
  if (payload.type === 'error') return 'error'
  return 'unknown'
}

function shapeOfEvents(events) {
  for (const entry of events || []) {
    const data = entry?.data
    if (Array.isArray(data?.choices)) return 'chat'
    if (Array.isArray(data?.candidates) || (data?.usageMetadata && !data?.choices)) return 'gemini'
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

function geminiText(payload) {
  return (payload?.candidates?.[0]?.content?.parts || [])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
}

function geminiParts(payload) {
  return payload?.candidates?.[0]?.content?.parts || []
}

function textOfPayload(payload) {
  return responsesText(payload) || anthropicText(payload) || geminiText(payload) || chatText(payload)
}

/** 按协议发一次请求要带的鉴权头。 */
function authHeaders(protocol, apiKey, authMode) {
  const headers = { 'Content-Type': 'application/json' }
  if (!apiKey) return headers
  if (protocol === 'gemini') {
    // 官方 Gemini 只认 x-goog-api-key 或 ?key=；中转站多数认 Bearer。两个都带最省事。
    headers.Authorization = `Bearer ${apiKey}`
    headers['x-goog-api-key'] = apiKey
    return headers
  }
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

/**
 * Gemini 的路径与另三种不同：它把动作拼在 model 后面，且不一定挂在 /v1 下。
 * 中转站两种写法都有人用（/v1beta/models/... 或 直接 /models/...），
 * 所以这里先按标准 /v1beta 拼，失败时调用方可以换候选。
 */
function geminiRoot(baseUrl) {
  return trimBase(baseUrl).replace(/\/v1beta$/i, '').replace(/\/v1$/i, '')
}

function protocolUrl(protocol, baseUrl, model, stream) {
  if (protocol === 'gemini') {
    const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
    return `${geminiRoot(baseUrl)}/v1beta/models/${encodeURIComponent(model)}:${action}`
  }
  return `${trimBase(baseUrl)}${PROTOCOLS[protocol].path}`
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
  model,
}) {
  const url = protocolUrl(protocol, baseUrl, model || '', stream)
  const started = Date.now()
  const combo = combineController(timeoutMs, outerSignal)
  const headers = authHeaders(protocol, apiKey, authMode)
  headers.Accept = stream ? 'text/event-stream' : 'application/json'

  const result = {
    protocol,
    path: protocol === 'gemini' ? url.replace(trimBase(baseUrl), '') : PROTOCOLS[protocol].path,
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

/**
 * 推理模型会先花预算在「想」上：预算给不够时 content 是空的、finish_reason=length。
 * 这种「额度饿死」不是能力缺失，得加大预算重来一次，否则会把好好的站判成缺能力。
 *
 * 只在「正常预算」（>=500）上重试：截断类探针故意用 16 token 去撞 max_tokens，
 * 那种饿死是预期结果，不能救。
 */
const BUDGET_MIN_RETRY = 500
const BUDGET_CAP = 12000

function budgetFields(body) {
  if (!body || typeof body !== 'object') return []
  const hits = []
  for (const key of ['max_tokens', 'max_output_tokens', 'maxOutputTokens']) {
    if (typeof body[key] === 'number') hits.push({ holder: body, key })
  }
  const gen = body.generationConfig
  if (gen && typeof gen.maxOutputTokens === 'number') hits.push({ holder: gen, key: 'maxOutputTokens' })
  return hits
}

function looksStarved(protocol, result) {
  if (!result?.ok) return false
  const payload = result.payload
  if (!payload) return false
  if (protocol === 'chat') {
    return payload.choices?.[0]?.finish_reason === 'length' && !chatText(payload)
  }
  if (protocol === 'responses') {
    return payload.status === 'incomplete' && !textOfPayload(payload)
  }
  if (protocol === 'anthropic') {
    return payload.stop_reason === 'max_tokens' && !textOfPayload(payload)
  }
  if (protocol === 'gemini') {
    return payload.candidates?.[0]?.finishReason === 'MAX_TOKENS' && !geminiText(payload)
  }
  return false
}

function bumpBudget(body) {
  const fields = budgetFields(body)
  const usable = fields.filter((hit) => hit.holder[hit.key] >= BUDGET_MIN_RETRY && hit.holder[hit.key] < BUDGET_CAP)
  if (!usable.length) return null
  const clone = structuredClone(body)
  for (const hit of budgetFields(clone)) hit.holder[hit.key] = Math.min(BUDGET_CAP, hit.holder[hit.key] * 3)
  return clone
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
        model,
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

    // 额度饿死：加大预算再跑一次（最多多两轮），别把推理模型误判成缺能力
    if (!stream && looksStarved(protocol, last)) {
      for (let i = 0; i < 2; i += 1) {
        const bigger = bumpBudget(body)
        if (!bigger) break
        body = bigger
        last = await requestOnce({
          protocol,
          baseUrl,
          apiKey,
          authMode: authModesFor(protocol, authMode)[0],
          body,
          stream: false,
          model,
          timeoutMs: Math.min(timeoutOverride || timeoutMs, Math.max(1, deadline - Date.now())),
          outerSignal: signal,
        })
        requests.push({ protocol, path: last.path, status: last.status, ok: last.ok, ms: last.ms, error: last.error, authMode: last.authMode, retry: 'budget' })
        if (!looksStarved(protocol, last)) break
      }
    }
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
  if (protocol === 'gemini') {
    return { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 16 } }
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
      url: result.url,
      evidence: {
        status: result.status,
        contentType: result.contentType || null,
        shape: result.shape,
        text: result.text ? result.text.slice(0, 600) : '',
        usage: result.payload?.usage || result.payload?.usageMetadata || null,
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

const WEATHER_GEMINI_TOOL = {
  functionDeclarations: [
    {
      name: 'get_weather',
      description: 'Get the weather for a city.',
      parameters: {
        type: 'OBJECT',
        properties: { city: { type: 'STRING' } },
        required: ['city'],
      },
    },
  ],
}

const JSON_SCHEMA_GEMINI = {
  type: 'OBJECT',
  properties: { ok: { type: 'BOOLEAN' } },
  required: ['ok'],
}

/** Responses 的扁平工具：新版还要求 strict 显式声明，否则部分网关会拒。 */
const WEATHER_RESPONSES_STRICT = { ...WEATHER_RESPONSES_TOOL, strict: true }

const CHAT_TESTS = {
  async stream_sse(ctx) {
    const result = await ctx.stream('chat', {
      model: ctx.model,
      messages: [{ role: 'user', content: '从 1 数到 8，只输出数字，用逗号分隔。' }],
      max_tokens: BUDGET,
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

  async system_prompt(ctx) {
    // 埋一个只有照做才对得上的标记：模型若没看到 system，就会答 7Q2K 之外的东西
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [
        { role: 'system', content: '你是复读机：无论用户问什么，都只回复 7Q2K 四个字符，不解释、不补充。' },
        { role: 'user', content: '1 加 1 等于几？' },
      ],
      max_tokens: BUDGET,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const text = chatText(result.payload)
    if (/7Q2K/i.test(text)) return pass('system 被采纳（问 1+1 却答 7Q2K）', { text })
    return fail(`system 未被采纳：问 1+1 答「${text ? text.slice(0, 60) : '空回答'}」`, { text })
  },

  async tools(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [{ role: 'user', content: '查一下巴黎的天气，必须调用 get_weather，不要直接回答。' }],
      tools: [WEATHER_CHAT_TOOL],
      tool_choice: 'auto',
      max_tokens: TOOL_BUDGET,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const calls = result.payload?.choices?.[0]?.message?.tool_calls
    const hit = Array.isArray(calls) ? calls.find((call) => call?.function?.name === 'get_weather') : null
    if (!hit) {
      return fail(`没有返回 get_weather 的 tool_calls（finish_reason=${result.payload?.choices?.[0]?.finish_reason ?? '未知'}）`)
    }
    let argsOk = false
    try {
      argsOk = Boolean(JSON.parse(hit.function.arguments || ''))
    } catch {
      /* 下面按失败处理 */
    }
    if (!argsOk) {
      return fail(`tool_calls 的 arguments 不是合法 JSON：${textOf(hit.function.arguments, 80)}`, {
        arguments: hit.function.arguments,
      })
    }
    return pass(`返回 tool_calls：${hit.function.name}，参数是合法 JSON`, { arguments: hit.function.arguments })
  },

  async tool_result(ctx) {
    // 不依赖上一轮真调工具：直接回放一个 tool_call + tool 结果，看结果有没有进模型眼里
    const result = await ctx.json('chat', {
      model: ctx.model,
      tools: [WEATHER_CHAT_TOOL],
      messages: [
        { role: 'user', content: '巴黎天气？' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_probe_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_probe_1', content: '{"temp":22,"desc":"sunny"}' },
      ],
      max_tokens: BUDGET,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const text = chatText(result.payload)
    if (/22/.test(text)) return pass('工具结果被采纳，回答里带上了 22°C', { text })
    return fail(`工具结果没进模型眼里：${text ? text.slice(0, 80) : '空回答'}`, { text })
  },

  async max_tokens(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [{ role: 'user', content: '从 1 数到 300，每行一个数字。' }],
      max_tokens: 16,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const finishReason = result.payload?.choices?.[0]?.finish_reason
    if (finishReason === 'length') {
      return pass('max_tokens=16 生效，finish_reason=length', { finishReason })
    }
    return fail(`finish_reason=${finishReason ?? '缺失'}，max_tokens 可能被忽略`, { finishReason })
  },

  async usage(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [{ role: 'user', content: '说一句话。' }],
      max_tokens: BUDGET,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const usage = result.payload?.usage
    const prompt = usage?.prompt_tokens ?? usage?.input_tokens
    const completion = usage?.completion_tokens ?? usage?.output_tokens
    if (typeof prompt === 'number' && typeof completion === 'number' && prompt > 0) {
      return pass(`prompt_tokens=${prompt}，completion_tokens=${completion}`, { usage })
    }
    return fail('响应里没有 usage（或字段不是数字）', { usage: usage ?? null })
  },

  async multi_turn(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [
        { role: 'user', content: '记住暗号：紫色河马。只回复 OK。' },
        { role: 'assistant', content: 'OK' },
        { role: 'user', content: '暗号是什么？只回暗号本身。' },
      ],
      max_tokens: BUDGET,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const text = chatText(result.payload)
    if (/紫色河马/.test(text)) return pass('历史回放后能复述暗号', { text })
    return fail(`答不出前文暗号：${text ? text.slice(0, 80) : '空回答'}（或历史被丢弃）`, { text })
  },

  async tool_choice(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [{ role: 'user', content: '你好，随便聊两句。' }],
      tools: [WEATHER_CHAT_TOOL],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      max_tokens: TOOL_BUDGET,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const calls = result.payload?.choices?.[0]?.message?.tool_calls
    const hit = Array.isArray(calls) ? calls.find((call) => call?.function?.name === 'get_weather') : null
    if (hit) return pass('强制 tool_choice 生效', { arguments: hit.function.arguments })
    return fail('指定 tool_choice 后仍没有调用 get_weather（参数很可能被丢弃）')
  },

  async parallel_tools(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [{ role: 'user', content: '同时查巴黎和东京的天气，两个城市各调用一次 get_weather，不要合并成一次。' }],
      tools: [WEATHER_CHAT_TOOL],
      parallel_tool_calls: true,
      max_tokens: TOOL_BUDGET,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const calls = result.payload?.choices?.[0]?.message?.tool_calls
    const n = Array.isArray(calls) ? calls.length : 0
    if (n >= 2) return pass(`一次返回 ${n} 个 tool_calls`, { calls: n })
    return fail(`只返回 ${n} 个 tool_calls，并行没生效`)
  },

  async json_schema(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [{ role: 'user', content: '把「小明 18 岁」转成 JSON，字段 name 和 age。' }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'person', strict: true, schema: PERSON_SCHEMA },
      },
      max_tokens: BUDGET,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const text = chatText(result.payload)
    const parsed = parseJsonStrict(text)
    if (parsed?.age === 18) return pass('json_schema 生效，返回纯 JSON', { text })
    return fail(`json_schema 未生效：${text ? text.slice(0, 80) : '空回答'}`, { text })
  },

  async stop_sequence(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [{ role: 'user', content: '依次输出：ALPHA BETA GAMMA' }],
      stop: ['BETA'],
      max_tokens: BUDGET,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const text = chatText(result.payload)
    if (!text) return fail('回答为空，无法判断 stop 是否生效')
    if (text.includes('BETA')) return fail(`stop 未生效，输出里仍出现 BETA：${text.slice(0, 80)}`, { text })
    if (text.includes('ALPHA')) return pass(`stop 生效，输出停在：${text.slice(0, 40)}`, { text })
    return unknown(`模型没按要求复读，无法判断 stop：${text.slice(0, 80)}`, { text })
  },

  async vision(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图主要是什么颜色？只回一个颜色词。' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PNG}` } },
          ],
        },
      ],
      max_tokens: BUDGET,
    })
    if (!result.ok) return httpFailure(result)
    const text = chatText(result.payload)
    if (/红|red/i.test(text)) return pass(`看懂图片，答「${textOf(text, 20)}」`, { text })
    return fail(`没看懂图片：${text ? text.slice(0, 60) : '空回答'}`, { text })
  },

  async reasoning(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [{ role: 'user', content: '13 的平方加 7 等于几？只回数字。' }],
      max_tokens: TOOL_BUDGET,
    })
    if (!result.ok) return httpFailure(result)
    const message = result.payload?.choices?.[0]?.message || {}
    const trace = message.reasoning_content || message.reasoning || result.payload?.choices?.[0]?.message?.thinking
    if (typeof trace === 'string' && trace.length > 0) {
      return pass(`返回了思考字段（${trace.length} 字）`, { len: trace.length })
    }
    return fail('响应里没有 reasoning_content / reasoning，思考过程不可见')
  },

  async long_context(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [
        { role: 'user', content: `下面长文第一句话里有一个暗号编号，读完后只回答那个编号。\n\n暗号编号是 QX-7731。\n${LONG_FILLER}\n\n问题：暗号编号是多少？只回编号。` },
      ],
      max_tokens: BUDGET,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const text = chatText(result.payload)
    const promptTokens = result.payload?.usage?.prompt_tokens
    if (/QX-?7731/i.test(text)) return pass(`捞出了开头暗号（prompt_tokens=${promptTokens ?? '?'}）`, { text, promptTokens })
    return fail(`没捞出开头暗号：${text ? text.slice(0, 80) : '空回答'}（prompt_tokens=${promptTokens ?? '?'}，可能被截头）`, { text, promptTokens })
  },

  async long_output(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [{ role: 'user', content: '用中文写一篇约 1000 字的短文，主题「河流」。只要正文。' }],
      max_tokens: 4000,
    })
    if (!result.ok) return httpFailure(result)
    const usage = result.payload?.usage
    const completion = usage?.completion_tokens ?? 0
    const finish = result.payload?.choices?.[0]?.finish_reason
    if (finish === 'stop' && completion >= 500) {
      return pass(`连续产出 ${completion} token 并正常收尾`, { completion })
    }
    return fail(`只产出 ${completion} token（finish=${finish}），长输出被截断或被压额度`, { completion, finish })
  },

  async strict_schema(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [{ role: 'user', content: '查巴黎天气，必须调用 get_weather。' }],
      tools: [
        {
          type: 'function',
          function: { ...WEATHER_CHAT_TOOL.function, strict: true },
        },
      ],
      max_tokens: TOOL_BUDGET,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const calls = result.payload?.choices?.[0]?.message?.tool_calls
    const hit = Array.isArray(calls) ? calls.find((call) => call?.function?.name === 'get_weather') : null
    if (hit) return pass('strict 工具被接受且正常调用', { arguments: hit.function.arguments })
    return fail('带 strict 的工具定义没有被调用（可能整段被拒或忽略）')
  },

  async n_choices(ctx) {
    const result = await ctx.json('chat', {
      model: ctx.model,
      messages: [{ role: 'user', content: '说 OK。' }],
      n: 2,
      max_tokens: BUDGET,
      temperature: 0,
    })
    if (!result.ok) return httpFailure(result)
    const choices = result.payload?.choices
    if (Array.isArray(choices) && choices.length >= 2) {
      return pass(`n=2 返回了 ${choices.length} 条 choices`, { choices: choices.length })
    }
    return fail(`n=2 只返回了 ${Array.isArray(choices) ? choices.length : 0} 条 choices（n 被裁掉）`)
  },
}

// ------------------------------------------------------------- Responses 能力

const RESPONSES_TESTS = {
  async instructions(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      instructions: '你是复读机：无论用户问什么，都只回复 7Q2K 四个字符，不解释、不补充。',
      input: '1 加 1 等于几？',
      max_output_tokens: BUDGET,
    })
    if (!result.ok) return httpFailure(result)
    const text = textOfPayload(result.payload)
    if (/7Q2K/i.test(text)) return pass('instructions 被采纳（问 1+1 却答 7Q2K）', { text })
    return fail(`instructions 未被采纳：问 1+1 答「${text ? text.slice(0, 60) : '空回答'}」`, { text })
  },

  async tools_function(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      input: '查一下巴黎的天气，必须调用 get_weather，不要直接回答。',
      tools: [WEATHER_RESPONSES_STRICT],
      max_output_tokens: TOOL_BUDGET,
    })
    if (!result.ok) return httpFailure(result)
    const call = (result.payload?.output || []).find((item) => item?.type === 'function_call')
    if (call?.name === 'get_weather') {
      return pass(`返回 function_call：${call.name}`, { arguments: call.arguments })
    }
    const types = (result.payload?.output || []).map((item) => item?.type).filter(Boolean)
    return fail(`没有 function_call item（output: ${types.join(', ') || '空'}）`, { types })
  },

  async tool_result(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      tools: [WEATHER_RESPONSES_STRICT],
      input: [
        { role: 'user', content: [{ type: 'input_text', text: '巴黎天气？' }] },
        { type: 'function_call', call_id: 'call_probe_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
        { type: 'function_call_output', call_id: 'call_probe_1', output: '{"temp":22,"desc":"sunny"}' },
      ],
      max_output_tokens: BUDGET,
    })
    if (!result.ok) return httpFailure(result)
    const text = textOfPayload(result.payload)
    if (/22/.test(text)) return pass('function_call_output 被采纳，回答里带上了 22°C', { text })
    return fail(`工具结果没进模型眼里：${text ? text.slice(0, 80) : '空回答'}`, { text })
  },

  async previous_response_id(ctx) {
    const first = await ctx.json('responses', {
      model: ctx.model,
      input: '记住数字 4321，只回复 OK。',
      store: true,
      max_output_tokens: BUDGET,
    })
    if (!first.ok) return httpFailure(first)
    const id = first.payload?.id
    if (!id) return fail('首轮响应没有 id，无法用 previous_response_id', { text: first.text?.slice(0, 120) })

    const second = await ctx.json('responses', {
      model: ctx.model,
      previous_response_id: id,
      input: '我刚才让你记的数字是几？只回数字。',
      max_output_tokens: BUDGET,
    })
    if (!second.ok) return httpFailure(second)
    const text = textOfPayload(second.payload)
    if (/4321/.test(text)) return pass('previous_response_id 带上了上一轮上下文', { id, text })
    return fail(`previous_response_id 没有带上上下文：${text ? text.slice(0, 80) : '空回答'}`, { id, text })
  },

  async incomplete(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      input: '从 1 数到 300，每行一个数字。',
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

  async sse_sequence(ctx) {
    const result = await ctx.stream('responses', {
      model: ctx.model,
      input: '从 1 数到 8，只输出数字。',
      max_output_tokens: BUDGET,
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
      return pass(`原生事件序列完整（${[...types].slice(0, 5).join(' → ')}）`, { types: [...types] })
    }
    return fail(`事件序列不完整：${[...types].slice(0, 8).join(', ') || '没有可识别的 Responses 事件'}`, {
      types: [...types],
    })
  },

  async output_items(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      input: '只回复 OK。',
      max_output_tokens: BUDGET,
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

  async input_array(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: '只回复 OK。' }],
        },
      ],
      max_output_tokens: BUDGET,
    })
    if (!result.ok) return httpFailure(result)
    const text = textOfPayload(result.payload)
    if (text) return pass(`接受 input 数组，返回「${text.slice(0, 40)}」`, { text })
    return fail('2xx 但 output 里没有正文')
  },

  async text_format(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      input: '把「小明 18 岁」转成 JSON，字段 name 和 age。',
      text: {
        format: { type: 'json_schema', name: 'person', strict: true, schema: PERSON_SCHEMA },
      },
      max_output_tokens: BUDGET,
    })
    if (!result.ok) return httpFailure(result)
    const text = textOfPayload(result.payload)
    const parsed = parseJsonStrict(text)
    if (parsed?.age === 18) return pass('text.format 的 json_schema 生效，返回纯 JSON', { text })
    return fail(`text.format 未生效：${text ? text.slice(0, 80) : '空回答'}`, { text })
  },

  async tool_choice(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      input: '你好，随便聊两句。',
      tools: [WEATHER_RESPONSES_STRICT],
      tool_choice: { type: 'function', name: 'get_weather' },
      max_output_tokens: TOOL_BUDGET,
    })
    if (!result.ok) return httpFailure(result)
    const call = (result.payload?.output || []).find((item) => item?.type === 'function_call')
    if (call?.name === 'get_weather') return pass('强制 tool_choice 生效', { arguments: call.arguments })
    return fail('指定 tool_choice 后仍没有 function_call（参数很可能被丢弃）')
  },

  async parallel_tools(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      input: '同时查巴黎和东京的天气，两个城市各调用一次 get_weather，不要合并。',
      tools: [WEATHER_RESPONSES_STRICT],
      parallel_tool_calls: true,
      max_output_tokens: TOOL_BUDGET,
    })
    if (!result.ok) return httpFailure(result)
    const calls = (result.payload?.output || []).filter((item) => item?.type === 'function_call')
    if (calls.length >= 2) return pass(`一次返回 ${calls.length} 个 function_call`, { calls: calls.length })
    return fail(`只返回 ${calls.length} 个 function_call，并行没生效`)
  },

  async reasoning_item(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      input: '13 的平方加 7 等于几？只回数字。',
      reasoning: { effort: 'low' },
      max_output_tokens: TOOL_BUDGET,
    })
    if (!result.ok) return httpFailure(result)
    const items = result.payload?.output || []
    const hasReasoning = items.some((item) => item?.type === 'reasoning')
    const tokens = result.payload?.usage?.output_tokens_details?.reasoning_tokens
    if (hasReasoning || (typeof tokens === 'number' && tokens > 0)) {
      return pass(`返回了推理项（reasoning_tokens=${tokens ?? '?'}）`, { hasReasoning, tokens })
    }
    return fail(`没有 reasoning item，reasoning_tokens=${tokens ?? '缺失'}（思考被吞掉）`, { tokens })
  },

  async vision(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: '这张图主要是什么颜色？只回一个颜色词。' },
            { type: 'input_image', image_url: `data:image/png;base64,${RED_PNG}` },
          ],
        },
      ],
      max_output_tokens: BUDGET,
    })
    if (!result.ok) return httpFailure(result)
    const text = textOfPayload(result.payload)
    if (/红|red/i.test(text)) return pass(`看懂图片，答「${textOf(text, 20)}」`, { text })
    return fail(`没看懂图片：${text ? text.slice(0, 60) : '空回答'}`, { text })
  },

  async usage(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      input: '说一句话。',
      max_output_tokens: BUDGET,
    })
    if (!result.ok) return httpFailure(result)
    const usage = result.payload?.usage
    const input = usage?.input_tokens ?? usage?.prompt_tokens
    const output = usage?.output_tokens ?? usage?.completion_tokens
    if (typeof input === 'number' && typeof output === 'number' && input > 0) {
      return pass(`input_tokens=${input}，output_tokens=${output}`, { usage })
    }
    return fail('响应里没有 input_tokens / output_tokens', { usage: usage ?? null })
  },

  async long_context(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      input: `下面长文第一句话里有一个暗号编号，读完后只回答那个编号。\n\n暗号编号是 QX-7731。\n${LONG_FILLER}\n\n问题：暗号编号是多少？只回编号。`,
      max_output_tokens: BUDGET,
    })
    if (!result.ok) return httpFailure(result)
    const text = textOfPayload(result.payload)
    const promptTokens = result.payload?.usage?.input_tokens
    if (/QX-?7731/i.test(text)) return pass(`捞出了开头暗号（input_tokens=${promptTokens ?? '?'}）`, { text, promptTokens })
    return fail(`没捞出开头暗号（input_tokens=${promptTokens ?? '?'}，可能被截头）：${text ? text.slice(0, 60) : '空回答'}`, { text, promptTokens })
  },

  async store(ctx) {
    const result = await ctx.json('responses', {
      model: ctx.model,
      input: '只回复 OK。',
      store: true,
      max_output_tokens: BUDGET,
    })
    if (!result.ok) return httpFailure(result)
    if (result.payload?.store === true) return pass('store:true 被接受并在响应里回显', { store: true })
    if (result.payload?.id) {
      return unknown(`响应里没有 store 回显（id=${result.payload.id}），无法确认是否真的存了`, {
        id: result.payload.id,
      })
    }
    return fail('store:true 被忽略，响应里既没有回显也没有 id')
  },
}

// ------------------------------------------------------------- Anthropic 能力

const ANTHROPIC_TESTS = {
  async tools(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: TOOL_BUDGET,
      tools: [WEATHER_ANTHROPIC_TOOL],
      messages: [{ role: 'user', content: '查一下巴黎的天气，必须调用 get_weather，不要直接回答。' }],
    })
    if (!result.ok) return httpFailure(result)
    const block = (result.payload?.content || []).find((item) => item?.type === 'tool_use')
    if (block?.name === 'get_weather' && block.input && typeof block.input === 'object') {
      return pass(`返回 tool_use：${block.name}`, { input: block.input })
    }
    return fail('没有返回 get_weather 的 tool_use 块')
  },

  async tool_result(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: BUDGET,
      tools: [WEATHER_ANTHROPIC_TOOL],
      messages: [
        { role: 'user', content: '巴黎天气？' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_probe_1', name: 'get_weather', input: { city: 'Paris' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_probe_1', content: '{"temp":22,"desc":"sunny"}' }],
        },
      ],
    })
    if (!result.ok) return httpFailure(result)
    const text = textOfPayload(result.payload)
    if (/22/.test(text)) return pass('tool_result 块被采纳，回答里带上了 22°C', { text })
    return fail(`tool_result 未被采纳：${text ? text.slice(0, 80) : '空回答'}`, { text })
  },

  async system_param(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: BUDGET,
      system: '你是复读机：无论用户问什么，都只回复 7Q2K 四个字符，不解释、不补充。',
      messages: [{ role: 'user', content: '1 加 1 等于几？' }],
    })
    if (!result.ok) return httpFailure(result)
    const text = textOfPayload(result.payload)
    if (/7Q2K/i.test(text)) return pass('system 参数被采纳（问 1+1 却答 7Q2K）', { text })
    return fail(`system 参数未被采纳：问 1+1 答「${text ? text.slice(0, 60) : '空回答'}」`, { text })
  },

  async sse_events(ctx) {
    const result = await ctx.stream('anthropic', {
      model: ctx.model,
      max_tokens: BUDGET,
      stream: true,
      messages: [{ role: 'user', content: '从 1 数到 8，只输出数字。' }],
    })
    if (!result.ok) return httpFailure(result)
    const types = new Set(
      (result.events || []).map((entry) => entry.event || entry.data?.type).filter(Boolean),
    )
    const required = ['message_start', 'content_block_start', 'content_block_delta', 'message_stop']
    const missing = required.filter((type) => !types.has(type))
    if (missing.length === 0) {
      return pass(`原生事件序列完整（${[...types].slice(0, 5).join(' → ')}）`, { types: [...types] })
    }
    return fail(`缺少事件：${missing.join(', ')}（收到 ${[...types].slice(0, 8).join(', ') || '无可识别事件'}）`, {
      types: [...types],
    })
  },

  async stop_reason(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: BUDGET,
      messages: [{ role: 'user', content: '只回复 OK。' }],
    })
    if (!result.ok) return httpFailure(result)
    const reason = result.payload?.stop_reason
    if (typeof reason === 'string' && reason) {
      return pass(`stop_reason=${reason}`, { stopReason: reason })
    }
    return fail('响应里没有 stop_reason')
  },

  async content_blocks(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: BUDGET,
      messages: [{ role: 'user', content: '只回复 OK。' }],
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

  async tool_choice(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: TOOL_BUDGET,
      tools: [WEATHER_ANTHROPIC_TOOL],
      tool_choice: { type: 'tool', name: 'get_weather' },
      messages: [{ role: 'user', content: '你好，随便聊两句。' }],
    })
    if (!result.ok) return httpFailure(result)
    const block = (result.payload?.content || []).find((item) => item?.type === 'tool_use')
    if (block?.name === 'get_weather') return pass('强制 tool_choice 生效', { input: block.input })
    return fail('指定 tool_choice 后仍没有调用 get_weather（参数很可能被丢弃）')
  },

  async usage(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: BUDGET,
      messages: [{ role: 'user', content: '说一句话。' }],
    })
    if (!result.ok) return httpFailure(result)
    const usage = result.payload?.usage
    if (typeof usage?.input_tokens === 'number' && typeof usage?.output_tokens === 'number' && usage.input_tokens > 0) {
      return pass(`input_tokens=${usage.input_tokens}，output_tokens=${usage.output_tokens}`, { usage })
    }
    return fail('响应里没有 input_tokens / output_tokens', { usage: usage ?? null })
  },

  async thinking(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: 3000,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: '13 的平方加 7 等于几？只回数字。' }],
    })
    if (!result.ok) return httpFailure(result)
    const blocks = result.payload?.content || []
    const hasThinking = blocks.some((item) => item?.type === 'thinking' || item?.type === 'redacted_thinking')
    if (hasThinking) return pass('thinking 生效，返回 thinking 块', { blocks: blocks.map((b) => b.type) })
    return fail(`接受参数但没有 thinking 块（content: ${blocks.map((b) => b.type).join(', ') || '空'}）`, {
      blocks: blocks.map((b) => b.type),
    })
  },

  async vision(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: BUDGET,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_PNG } },
            { type: 'text', text: '这张图主要是什么颜色？只回一个颜色词。' },
          ],
        },
      ],
    })
    if (!result.ok) return httpFailure(result)
    const text = textOfPayload(result.payload)
    if (/红|red/i.test(text)) return pass(`看懂图片，答「${textOf(text, 20)}」`, { text })
    return fail(`没看懂图片：${text ? text.slice(0, 60) : '空回答'}`, { text })
  },

  async stop_sequences(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: BUDGET,
      stop_sequences: ['BETA'],
      messages: [{ role: 'user', content: '依次输出：ALPHA BETA GAMMA' }],
    })
    if (!result.ok) return httpFailure(result)
    const text = textOfPayload(result.payload)
    if (!text) return fail('回答为空，无法判断 stop_sequences 是否生效')
    if (text.includes('BETA')) return fail(`stop_sequences 未生效，输出里仍出现 BETA：${text.slice(0, 80)}`, { text })
    if (text.includes('ALPHA')) return pass(`stop_sequences 生效，输出停在：${text.slice(0, 40)}`, { text })
    return unknown(`模型没按要求复读，无法判断 stop_sequences：${text.slice(0, 80)}`, { text })
  },

  async max_tokens(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: 16,
      messages: [{ role: 'user', content: '从 1 数到 300，每行一个数字。' }],
    })
    if (!result.ok) return httpFailure(result)
    const reason = result.payload?.stop_reason
    if (reason === 'max_tokens') return pass('max_tokens=16 生效，stop_reason=max_tokens', { reason })
    return fail(`stop_reason=${reason ?? '缺失'}，max_tokens 可能被忽略或换算错`, { reason })
  },

  async multi_turn(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: BUDGET,
      messages: [
        { role: 'user', content: '记住暗号：紫色河马。只回复 OK。' },
        { role: 'assistant', content: 'OK' },
        { role: 'user', content: '暗号是什么？只回暗号本身。' },
      ],
    })
    if (!result.ok) return httpFailure(result)
    const text = textOfPayload(result.payload)
    if (/紫色河马/.test(text)) return pass('历史回放后能复述暗号', { text })
    return fail(`答不出前文暗号：${text ? text.slice(0, 80) : '空回答'}（或历史被丢弃）`, { text })
  },

  async long_context(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: BUDGET,
      messages: [
        { role: 'user', content: `下面长文第一句话里有一个暗号编号，读完后只回答那个编号。\n\n暗号编号是 QX-7731。\n${LONG_FILLER}\n\n问题：暗号编号是多少？只回编号。` },
      ],
    })
    if (!result.ok) return httpFailure(result)
    const text = textOfPayload(result.payload)
    const inputTokens = result.payload?.usage?.input_tokens
    if (/QX-?7731/i.test(text)) return pass(`捞出了开头暗号（input_tokens=${inputTokens ?? '?'}）`, { text, inputTokens })
    return fail(`没捞出开头暗号（input_tokens=${inputTokens ?? '?'}，可能被截头）：${text ? text.slice(0, 60) : '空回答'}`, { text, inputTokens })
  },

  async json_via_tool(ctx) {
    const result = await ctx.json('anthropic', {
      model: ctx.model,
      max_tokens: TOOL_BUDGET,
      tools: [
        {
          name: 'emit_person',
          description: '输出结构化结果',
          input_schema: PERSON_SCHEMA,
        },
      ],
      messages: [{ role: 'user', content: '把「小明 18 岁」转成结构化数据，必须调用 emit_person。' }],
    })
    if (!result.ok) return httpFailure(result)
    const block = (result.payload?.content || []).find((item) => item?.type === 'tool_use')
    if (block?.input?.age === 18) return pass('靠 tool_use 拿到了结构化结果', { input: block.input })
    return fail(`拿不到结构化结果：${block ? textOf(block.input, 60) : '没有 tool_use 块'}`, { input: block?.input ?? null })
  },
}

// -------------------------------------------------------------- Gemini 能力

const GEMINI_TESTS = {
  async basic(ctx) {
    const result = await ctx.json('gemini', {
      contents: [{ role: 'user', parts: [{ text: '只回复两个字母：OK' }] }],
      generationConfig: { maxOutputTokens: BUDGET },
    })
    if (!result.ok) return httpFailure(result)
    const text = geminiText(result.payload)
    if (text) return pass(`返回 candidates[0].content.parts：「${textOf(text, 30)}」`, { text })
    return fail('2xx 但 candidates 里没有正文')
  },

  async system_instruction(ctx) {
    const result = await ctx.json('gemini', {
      systemInstruction: { parts: [{ text: '你是复读机：无论用户问什么，都只回复 7Q2K 四个字符，不解释、不补充。' }] },
      contents: [{ role: 'user', parts: [{ text: '1 加 1 等于几？' }] }],
      generationConfig: { maxOutputTokens: BUDGET },
    })
    if (!result.ok) return httpFailure(result)
    const text = geminiText(result.payload)
    if (/7Q2K/i.test(text)) return pass('systemInstruction 被采纳（问 1+1 却答 7Q2K）', { text })
    return fail(`systemInstruction 未被采纳：问 1+1 答「${text ? text.slice(0, 60) : '空回答'}」`, { text })
  },

  async function_call(ctx) {
    const result = await ctx.json('gemini', {
      contents: [{ role: 'user', parts: [{ text: '查一下巴黎的天气，必须调用 get_weather，不要直接回答。' }] }],
      tools: [WEATHER_GEMINI_TOOL],
      generationConfig: { maxOutputTokens: TOOL_BUDGET },
    })
    if (!result.ok) return httpFailure(result)
    const part = geminiParts(result.payload).find((item) => item?.functionCall)
    if (part?.functionCall?.name === 'get_weather') {
      return pass(`返回 functionCall：${part.functionCall.name}`, { args: part.functionCall.args })
    }
    return fail(`没有 functionCall part（parts: ${geminiParts(result.payload).map((p) => Object.keys(p).join('/')).join(', ') || '空'}）`)
  },

  async function_response(ctx) {
    const result = await ctx.json('gemini', {
      tools: [WEATHER_GEMINI_TOOL],
      contents: [
        { role: 'user', parts: [{ text: '巴黎天气？' }] },
        { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 22, desc: 'sunny' } } }] },
      ],
      generationConfig: { maxOutputTokens: BUDGET },
    })
    if (!result.ok) return httpFailure(result)
    const text = geminiText(result.payload)
    if (/22/.test(text)) return pass('functionResponse 被采纳，回答里带上了 22°C', { text })
    return fail(`工具结果没进模型眼里：${text ? text.slice(0, 80) : '空回答'}`, { text })
  },

  async sse_stream(ctx) {
    const result = await ctx.stream('gemini', {
      contents: [{ role: 'user', parts: [{ text: '从 1 数到 8，只输出数字。' }] }],
      generationConfig: { maxOutputTokens: BUDGET },
    })
    if (!result.ok) return httpFailure(result)
    const frames = (result.events || []).length
    const hasCandidates = (result.events || []).some((entry) => Array.isArray(entry.data?.candidates))
    if (frames > 1 && hasCandidates) return pass(`${frames} 个 SSE 块，candidates 正常分片`, { frames })
    return fail(`SSE 不完整（${frames} 块，candidates=${hasCandidates}）`, { frames })
  },

  async response_schema(ctx) {
    const result = await ctx.json('gemini', {
      contents: [{ role: 'user', parts: [{ text: '把「小明 18 岁」转成 JSON，字段 name 和 age。' }] }],
      generationConfig: {
        maxOutputTokens: BUDGET,
        responseMimeType: 'application/json',
        responseSchema: JSON_SCHEMA_GEMINI,
      },
    })
    if (!result.ok) return httpFailure(result)
    const text = geminiText(result.payload)
    const parsed = parseJsonStrict(text)
    if (parsed?.age === 18) return pass('responseSchema 生效，返回纯 JSON', { text })
    return fail(`responseSchema 未生效：${text ? text.slice(0, 80) : '空回答'}`, { text })
  },

  async function_config(ctx) {
    const result = await ctx.json('gemini', {
      contents: [{ role: 'user', parts: [{ text: '你好，随便聊两句。' }] }],
      tools: [WEATHER_GEMINI_TOOL],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      generationConfig: { maxOutputTokens: TOOL_BUDGET },
    })
    if (!result.ok) return httpFailure(result)
    const part = geminiParts(result.payload).find((item) => item?.functionCall)
    if (part?.functionCall?.name === 'get_weather') return pass('mode=ANY 生效，强制调用了工具', { args: part.functionCall.args })
    return fail('mode=ANY 未生效，没有 functionCall（配置很可能被丢弃）')
  },

  async max_output_tokens(ctx) {
    const result = await ctx.json('gemini', {
      contents: [{ role: 'user', parts: [{ text: '从 1 数到 300，每行一个数字。' }] }],
      generationConfig: { maxOutputTokens: 16 },
    })
    if (!result.ok) return httpFailure(result)
    const reason = result.payload?.candidates?.[0]?.finishReason
    if (reason === 'MAX_TOKENS') return pass('maxOutputTokens=16 生效，finishReason=MAX_TOKENS', { reason })
    return fail(`finishReason=${reason ?? '缺失'}，maxOutputTokens 可能被忽略`, { reason })
  },

  async stop_sequences(ctx) {
    const result = await ctx.json('gemini', {
      contents: [{ role: 'user', parts: [{ text: '依次输出：ALPHA BETA GAMMA' }] }],
      generationConfig: { maxOutputTokens: BUDGET, stopSequences: ['BETA'] },
    })
    if (!result.ok) return httpFailure(result)
    const text = geminiText(result.payload)
    if (!text) return fail('回答为空，无法判断 stopSequences 是否生效')
    if (text.includes('BETA')) return fail(`stopSequences 未生效，输出里仍出现 BETA：${text.slice(0, 80)}`, { text })
    if (text.includes('ALPHA')) return pass(`stopSequences 生效，输出停在：${text.slice(0, 40)}`, { text })
    return unknown(`模型没按要求复读，无法判断 stopSequences：${text.slice(0, 80)}`, { text })
  },

  async vision(ctx) {
    const result = await ctx.json('gemini', {
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'image/png', data: RED_PNG } }, { text: '这张图主要是什么颜色？只回一个颜色词。' }],
        },
      ],
      generationConfig: { maxOutputTokens: BUDGET },
    })
    if (!result.ok) return httpFailure(result)
    const text = geminiText(result.payload)
    if (/红|red/i.test(text)) return pass(`看懂图片，答「${textOf(text, 20)}」`, { text })
    return fail(`没看懂图片：${text ? text.slice(0, 60) : '空回答'}`, { text })
  },

  async usage(ctx) {
    const result = await ctx.json('gemini', {
      contents: [{ role: 'user', parts: [{ text: '说一句话。' }] }],
      generationConfig: { maxOutputTokens: BUDGET },
    })
    if (!result.ok) return httpFailure(result)
    const usage = result.payload?.usageMetadata
    if (typeof usage?.promptTokenCount === 'number' && usage.promptTokenCount > 0) {
      return pass(`promptTokenCount=${usage.promptTokenCount}，candidatesTokenCount=${usage.candidatesTokenCount ?? '?'}`, { usage })
    }
    return fail('响应里没有 usageMetadata', { usage: usage ?? null })
  },

  async multi_turn(ctx) {
    const result = await ctx.json('gemini', {
      contents: [
        { role: 'user', parts: [{ text: '记住暗号：紫色河马。只回复 OK。' }] },
        { role: 'model', parts: [{ text: 'OK' }] },
        { role: 'user', parts: [{ text: '暗号是什么？只回暗号本身。' }] },
      ],
      generationConfig: { maxOutputTokens: BUDGET },
    })
    if (!result.ok) return httpFailure(result)
    const text = geminiText(result.payload)
    if (/紫色河马/.test(text)) return pass('历史回放后能复述暗号', { text })
    return fail(`答不出前文暗号：${text ? text.slice(0, 80) : '空回答'}（或历史被丢弃）`, { text })
  },

  async long_context(ctx) {
    const result = await ctx.json('gemini', {
      contents: [{ role: 'user', parts: [{ text: `下面长文第一句话里有一个暗号编号，读完后只回答那个编号。\n\n暗号编号是 QX-7731。\n${LONG_FILLER}\n\n问题：暗号编号是多少？只回编号。` }] }],
      generationConfig: { maxOutputTokens: BUDGET },
    })
    if (!result.ok) return httpFailure(result)
    const text = geminiText(result.payload)
    const promptTokens = result.payload?.usageMetadata?.promptTokenCount
    if (/QX-?7731/i.test(text)) return pass(`捞出了开头暗号（promptTokenCount=${promptTokens ?? '?'}）`, { text, promptTokens })
    return fail(`没捞出开头暗号（promptTokenCount=${promptTokens ?? '?'}，可能被截头）：${text ? text.slice(0, 60) : '空回答'}`, { text, promptTokens })
  },

  async thinking(ctx) {
    const result = await ctx.json('gemini', {
      contents: [{ role: 'user', parts: [{ text: '13 的平方加 7 等于几？只回数字。' }] }],
      generationConfig: { maxOutputTokens: 3000, thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 } },
    })
    if (!result.ok) return httpFailure(result)
    const parts = geminiParts(result.payload)
    const thoughts = parts.filter((part) => part?.thought)
    if (thoughts.length) return pass(`返回了 ${thoughts.length} 段思考`, { thoughts: thoughts.length })
    return fail('includeThoughts=true 但没有 thought part（配置被丢弃）')
  },
}

const TESTS = {
  chat: CHAT_TESTS,
  responses: RESPONSES_TESTS,
  anthropic: ANTHROPIC_TESTS,
  gemini: GEMINI_TESTS,
}

function fallbackCapabilities(protocolId, surface, mode = 'full') {
  const reason =
    surface?.error ||
    (surface?.httpStatus ? `HTTP ${surface.httpStatus}` : '表面协议未通过')
  return capabilitiesFor(protocolId, mode).map((capability) => ({
    ...capability,
    status: SURFACE_FAIL.has(surface?.outcome) ? 'fail' : 'unknown',
    detail: SURFACE_FAIL.has(surface?.outcome)
      ? `表面协议不支持：${reason}`
      : `无法判定：${reason}`,
    evidence: { surface: surface?.outcome ?? 'unknown' },
  }))
}

/**
 * 跑一遍某一项能力。
 *
 * 单项内部的偶发（模型没按要求做、上游 5xx）不该直接定成「缺失」，
 * 所以这里给出三态：pass / fail / unknown。unknown 的项在多轮模式下会重跑。
 */
async function runOneCapability(protocolId, meta, ctx) {
  const test = TESTS[protocolId]?.[meta.id]
  if (!test) return { status: 'unknown', detail: '这一项还没有实现探测器', evidence: null }
  try {
    return await test(ctx)
  } catch (error) {
    if (error?.code === 'CANCELLED') return { status: 'unknown', detail: '已取消', evidence: null }
    if (error?.code === 'TIMEOUT') return { status: 'unknown', detail: '请求超时', evidence: null }
    return { status: 'unknown', detail: error?.message || String(error), evidence: null }
  }
}

/**
 * 同一项跑 repeat 遍，把结果折成一个结论：
 *   repeat=1  —— 一次定生死，快但偶发会被误判
 *   repeat>=3 —— 全过才 pass、全挂才 fail、中间态标 flaky（真的时好时坏）
 *
 * flaky 是最有价值的一档：它说明这个能力「有时候在」，这类站会让 agent
 * 时好时坏，比彻底缺失更难查。
 */
function foldRuns(meta, runs) {
  const decided = runs.filter((run) => run.status !== 'unknown')
  const passes = decided.filter((run) => run.status === 'pass').length
  const fails = decided.filter((run) => run.status === 'fail').length
  const unknowns = runs.length - decided.length

  let status
  let detail
  if (runs.length === 1) {
    status = runs[0].status
    detail = runs[0].detail
  } else if (decided.length === 0) {
    status = 'unknown'
    detail = `跑了 ${runs.length} 次都没拿到有效样本：${runs[0]?.detail || '无'}`
  } else if (fails === 0) {
    status = 'pass'
    detail = passes === runs.length ? runs[passes - 1].detail : `跑了 ${runs.length} 次全部通过`
  } else if (passes === 0) {
    status = 'fail'
    detail = runs[0].detail
  } else {
    status = 'flaky'
    detail = `跑了 ${runs.length} 次：${passes} 次通过、${fails} 次缺失${unknowns ? `、${unknowns} 次无法判定` : ''}——这一项时好时坏`
  }
  return { status, detail, runs: runs.map((run) => ({ status: run.status, detail: run.detail })) }
}

async function runCapabilities(protocolId, ctx, surface, onProgress, { mode = 'full', repeat = 1 } = {}) {
  const capabilities = []
  const list = capabilitiesFor(protocolId, mode)
  for (const meta of list) {
    if (ctx.signal?.aborted) {
      capabilities.push({ ...meta, status: 'unknown', detail: '已取消', evidence: null })
      continue
    }
    if (Date.now() > ctx.deadline) {
      capabilities.push({ ...meta, status: 'unknown', detail: '整体超时，未测', evidence: null })
      continue
    }
    onProgress?.({ type: 'capability-start', protocol: protocolId, capability: meta.id })

    const runs = []
    for (let i = 0; i < repeat; i += 1) {
      if (ctx.signal?.aborted || Date.now() > ctx.deadline) break
      runs.push(await runOneCapability(protocolId, meta, ctx))
      await sleep(60)
    }
    if (!runs.length) runs.push({ status: 'unknown', detail: '未执行（已取消或整体超时）' })
    const folded = foldRuns(meta, runs)
    const row = {
      ...meta,
      status: folded.status,
      detail: folded.detail,
      evidence: runs[runs.length - 1]?.evidence ?? null,
      runs: repeat > 1 ? folded.runs : undefined,
    }
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
            : `${known.length} 项原生能力全部通过。`,
      }
    }
    const label =
      shape === 'responses'
        ? 'OpenAI Responses'
        : shape === 'anthropic'
          ? 'Anthropic Messages'
          : shape === 'gemini'
            ? 'Gemini generateContent'
            : '无法判定'
    return { id: shape === 'unknown' ? 'unknown' : shape, label, confidence: 'medium', note: 'Chat 端点返回了别的协议形状。' }
  }

  const strongIds =
    protocolId === 'responses'
      ? ['previous_response_id', 'incomplete', 'tools_function', 'text_format']
      : protocolId === 'gemini'
        ? ['function_call', 'function_response', 'response_schema', 'system_instruction']
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
          ? `${known.length} 项原生能力全部通过。`
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
  const readyProtocols = []
  let pass = 0
  let fail = 0
  let flaky = 0
  let unknownCount = 0

  for (const id of PROTOCOL_ORDER) {
    const entry = protocols[id]
    if (!entry) continue
    if (entry.surface?.canProbe) surfaceSupported.push(id)
    if (entry.surface?.outcome === 'native') surfaceNative.push(id)
    if (entry.surface?.outcome === 'translated') surfaceTranslated.push(id)
    if (entry.real?.id) realProtocols[id] = entry.real
    if (entry.verdict?.level === 'native' || entry.verdict?.level === 'mostly') readyProtocols.push(id)
    for (const capability of entry.capabilities || []) {
      if (capability.status === 'pass') pass += 1
      else if (capability.status === 'fail') fail += 1
      else if (capability.status === 'flaky') flaky += 1
      else unknownCount += 1
    }
  }

  return {
    surfaceSupported,
    surfaceNative,
    surfaceTranslated,
    realProtocols,
    readyProtocols,
    capabilities: { pass, fail, flaky, unknown: unknownCount, total: pass + fail + flaky + unknownCount },
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
 *   protocols?: string[],                     // 只探其中这几个（默认四种全测）
 *   mode?: 'lite'|'full',                     // 轻量只测关键项，全量逐项验证
 *   repeat?: number,                          // 同一项跑几遍，>1 时能识别「时好时坏」
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
  mode = 'full',
  repeat = 1,
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
  const runs = Math.min(Math.max(Math.round(Number(repeat) || 1), 1), 5)
  const probeMode = mode === 'lite' ? 'lite' : 'full'
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
    mode: probeMode,
    repeat: runs,
    protocols: scope.map((id) => ({
      id,
      label: PROTOCOLS[id].label,
      capabilities: capabilitiesFor(id, probeMode),
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

  // 能力测试也按协议并发；每个协议内部串行，避免同一个站被几十个请求同时打
  const protocolResults = {}
  await Promise.all(
    scope.map(async (id) => {
      const surface = surfaces[id]
      let capabilities
      if (surface.canProbe) {
        capabilities = await runCapabilities(id, ctx, surface, onProgress, { mode: probeMode, repeat: runs })
      } else {
        capabilities = fallbackCapabilities(id, surface, probeMode)
        for (const capability of capabilities) {
          onProgress?.({ type: 'capability', protocol: id, capability })
        }
      }
      const real = inferRealProtocol(id, surface, capabilities)
      const verdict = protocolVerdict(id, capabilities, surface)
      const count = (status) => capabilities.filter((capability) => capability.status === status).length
      protocolResults[id] = {
        id,
        label: PROTOCOLS[id].label,
        short: PROTOCOLS[id].short,
        path: PROTOCOLS[id].path,
        surface,
        real,
        verdict,
        capabilities,
        summary: {
          pass: count('pass'),
          fail: count('fail'),
          flaky: count('flaky'),
          unknown: count('unknown'),
          total: capabilities.length,
        },
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
    mode: probeMode,
    repeat: runs,
    startedAt: new Date(started).toISOString(),
    finishedAt,
    durationMs: Date.now() - started,
    protocols: protocolResults,
    advice: overallAdvice(protocolResults),
    summary: summarize(protocolResults, ctx.requests, Date.now() - started),
    requests: ctx.requests,
    skippedProtocols: PROTOCOL_ORDER.filter((id) => !scope.includes(id)),
  }

  onProgress?.({ type: 'result', result })
  return result
}
