/**
 * N21 · ManageAPI 网关 LLM Adapter（OpenAI 兼容 /v1 + 动态 /v1/models）。
 *
 * 形状来自本机 DSH @deepseek-ai/dsh-llm/lib/index.js（只读核实）：
 *  - LlmAdapter.providerInfo/providerRetryPolicy/listModels/resolveModel/prepareCall
 *  - prepareCall 的消费方 LlmRuntime.prepareCall() 读 `{ model, stream }`，并把
 *    adapterCall.model 交给 normalizeModelInfo() 校验；LlmRuntime.adapterStream()
 *    再以 `adapterCall.stream(options)` 作为最终 dispatch，产出的 chunk 词汇为
 *    block-start / text-delta / block-end / usage / finish（见 Magpie toStreamChunks）。
 *  - 因此本文件的 prepareCall 返回 `{ model, baseUrl, headers, stream }`：前三项是
 *    本 adapter 声明的线级别信息（供测试与诊断断言），DSH 消费方只用 model/stream，
 *    真实 Authorization 由 stream 里的 fetch 请求携带。
 *
 * 零绝对路径字面量（URL 由 runtime.loopbackBaseUrl 派生）、零硬编码 Key。
 */

export const LLM_ADAPTER_DEFAULTS = Object.freeze({
  providerId: 'dsh-manage-api',
  displayName: 'ManageAPI 网关',
  maxTokens: 131072,
  contextWindow: 131072,
})

const messageOf = (err) => String(err && err.message ? err.message : err)

/** 保守、单一的模型描述（maxTokens 不瞎标，一律 131072）。 */
function describeModel(provider, id, extra = {}) {
  return {
    provider,
    id,
    name: id,
    inputModalities: ['text'],
    context: { contextWindow: LLM_ADAPTER_DEFAULTS.contextWindow },
    defaultMaxTokens: LLM_ADAPTER_DEFAULTS.maxTokens,
    ...extra,
  }
}

/** GET /v1/models → 去重后的模型 id 列表；非 2xx / 形状异常明确抛错。 */
async function fetchModelIds({ baseUrl, headers, fetchImpl, timeoutMs, signal }) {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null
  try {
    const res = await fetchImpl(`${baseUrl}/models`, {
      method: 'GET', headers, signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`ManageAPI /v1/models HTTP ${res.status}`)
    const body = await res.json()
    const rows = Array.isArray(body?.data) ? body.data : []
    const ids = []
    for (const row of rows) {
      if (row && typeof row.id === 'string' && row.id.length > 0 && !ids.includes(row.id)) ids.push(row.id)
    }
    return ids
  } finally {
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/** 构造 OpenAI 兼容的 chat/completions 请求体；DSH 的 options.messages 是内容块数组。 */
export function toChatRequest(options, { stream = true } = {}) {
  const messages = (Array.isArray(options.messages) ? options.messages : []).map((m) => {
    const content = Array.isArray(m.content)
      ? m.content.map((block) => (block && block.type === 'text' ? String(block.text ?? '') : '')).join('')
      : String(m.content ?? '')
    return { role: String(m.role ?? 'user'), content }
  })
  const body = {
    model: String(options.model ?? ''),
    messages,
    stream,
    ...(Number.isFinite(options.maxTokens) ? { max_tokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  }
  if (stream) body.stream_options = { include_usage: true }
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: 'function',
      function: {
        name: String(tool.name ?? ''),
        ...(tool.description ? { description: String(tool.description) } : {}),
        ...(tool.parameters ? { parameters: tool.parameters } : {}),
      },
    }))
  }
  return body
}

/** 把 OpenAI SSE 流转成 DSH StreamChunk；finish reason 只产出 DSH 认识的 kind。 */
export async function* streamSse(response, { signal } = {}) {
  if (!response || !response.ok) throw new Error(`ManageAPI /v1/chat/completions HTTP ${response?.status ?? 'no-response'}`)
  const reader = response.body?.getReader?.()
  if (!reader) throw new Error('ManageAPI 流式响应没有可读 body')
  const decoder = new TextDecoder()
  let buffer = ''
  let index = 0
  let opened = false
  let text = ''
  let usage = null
  let finishReason = 'stop'
  const contentFor = (delta) => (delta && typeof delta.content === 'string' ? delta.content : '')
  const toolCalls = new Map()
  const textIndex = index++
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
        if (data === '[DONE]') continue
        let event
        try { event = JSON.parse(data) } catch { continue }
        if (event.usage && typeof event.usage === 'object') {
          usage = {
            inputTokens: Number(event.usage.prompt_tokens) || 0,
            outputTokens: Number(event.usage.completion_tokens) || 0,
            ...(Number(event.usage.prompt_tokens_details?.cached_tokens)
              ? { cacheReadTokens: Number(event.usage.prompt_tokens_details.cached_tokens) } : {}),
          }
        }
        const choice = Array.isArray(event.choices) ? event.choices[0] : null
        if (!choice) continue
        const delta = choice.delta || {}
        const content = contentFor(delta)
        if (content) {
          if (!opened) {
            opened = true
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          text += content
          yield { type: 'text-delta', index: textIndex, text: content }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            const slot = Number.isInteger(call.index) ? call.index : 0
            const prev = toolCalls.get(slot) || { id: '', name: '', args: '', index: -1, started: false }
            const id = call.id || prev.id
            const name = call.function?.name || prev.name
            const args = call.function?.arguments || ''
            if (!prev.started) {
              prev.index = index++
              prev.started = true
              yield { type: 'block-start', index: prev.index, blockType: 'tool-call' }
            }
            toolCalls.set(slot, { ...prev, id, name, args: prev.args + args, started: true })
            if (name || args) {
              yield {
                type: 'tool-call-delta', index: prev.index, id: id || '',
                ...(name && name !== prev.name ? { name } : {}),
                argumentsDelta: args,
              }
            }
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason
      }
    }
  } finally {
    await reader.cancel?.().catch(() => {})
  }
  if (opened) yield { type: 'block-end', index: textIndex, block: { type: 'text', text } }
  for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[1].index - b[1].index)) {
    yield {
      type: 'block-end', index: call.index,
      block: { type: 'tool-call', id: call.id || `call-${call.index}`, name: call.name, arguments: call.args },
    }
  }
  if (usage) yield { type: 'usage', usage }
  if (signal?.aborted) {
    yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }
  } else if (finishReason === 'length') {
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  } else if (finishReason === 'tool_calls') {
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  } else if (finishReason === 'stop' || finishReason === 'content_filter') {
    yield { type: 'finish', reason: { kind: 'stop' } }
  } else {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: String(finishReason), code: 'UNKNOWN' } } }
  }
}

/**
 * ManageAPI adapter：providerInfo/listModels/resolveModel/prepareCall/stream。
 * 构造参数全部显式传入，不偷外层作用域。
 */
export class ManageApiAdapter {
  #providerId
  #displayName
  #baseUrl
  #headers
  #fetchImpl
  #timeoutMs

  constructor({ providerId, displayName, baseUrl, apiKey, fetchImpl, timeoutMs } = {}) {
    this.#providerId = providerId || LLM_ADAPTER_DEFAULTS.providerId
    this.#displayName = displayName || LLM_ADAPTER_DEFAULTS.displayName
    this.#baseUrl = String(baseUrl || '').replace(/\/+$/, '')
    this.#headers = Object.freeze({
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    })
    this.#fetchImpl = fetchImpl || globalThis.fetch
    this.#timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 120000
  }

  get wire() {
    return Object.freeze({ baseUrl: this.#baseUrl, headers: { ...this.#headers } })
  }

  providerInfo(provider) {
    const info = { id: provider, name: this.#displayName, models: [] }
    try {
      // 同步签名（DSH registerAdapter 同步调 providerInfo）；目录由 listModels 动态提供。
      info.models = Array.isArray(this.#cachedModels) ? this.#cachedModels.map((m) => m.id) : []
    } catch { /* 目录未就绪不影响注册 */ }
    return info
  }

  providerRetryPolicy(_provider) { return undefined }
  imageRequestPricing(_provider, _model) { return undefined }

  async listModels(provider, signal) {
    const ids = await fetchModelIds({
      baseUrl: this.#baseUrl, headers: this.#headers,
      fetchImpl: this.#fetchImpl, timeoutMs: this.#timeoutMs, signal,
    })
    const models = ids.map((id) => describeModel(provider, id))
    this.#cachedModels = models
    return models
  }

  async resolveModel(provider, model, signal) {
    const models = await this.listModels(provider, signal)
    const found = models.find((m) => m.id === model)
    if (!found) throw new Error(`ManageAPI 网关不存在模型 "${model}"（/v1/models 当前列出：${models.map((m) => m.id).join(', ') || '空'}）`)
    return found
  }

  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model, signal)
    return {
      model: resolved,
      baseUrl: this.#baseUrl,
      headers: { ...this.#headers },
      stream: (options) => this.stream(options),
    }
  }

  async *stream(options) {
    const ctrl = new AbortController()
    const harnessSignal = options?.signal
    const onAbort = () => ctrl.abort()
    if (harnessSignal) {
      if (harnessSignal.aborted) ctrl.abort()
      else harnessSignal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(() => ctrl.abort(), this.#timeoutMs)
    let response
    try {
      response = await this.#fetchImpl(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.#headers,
        body: JSON.stringify(toChatRequest(options || {}, { stream: true })),
        signal: ctrl.signal,
      })
      yield* streamSse(response, { signal: harnessSignal })
    } catch (err) {
      yield {
        type: 'finish',
        reason: harnessSignal?.aborted
          ? { kind: 'aborted', failure: { message: messageOf(err), code: 'ABORTED' } }
          : { kind: 'error', failure: { message: messageOf(err), code: 'UNKNOWN' } },
      }
    } finally {
      clearTimeout(timer)
      if (harnessSignal) harnessSignal.removeEventListener('abort', onAbort)
    }
  }

  #cachedModels = []
}

/** Key 解析：config.apiKey > MANAGE_API_GATEWAY_KEY > MANAGE_API_KEY。 */
export function resolveApiKey(config = {}, env = process.env) {
  const candidates = [
    ['config.apiKey', config.apiKey],
    ['MANAGE_API_GATEWAY_KEY', env.MANAGE_API_GATEWAY_KEY],
    ['MANAGE_API_KEY', env.MANAGE_API_KEY],
  ]
  for (const [source, value] of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return { key: value.trim(), source }
  }
  return { key: '', source: null }
}

/**
 * 注册入口。仅在 ctx.llm 存在且有 registerAdapter 时注册；缺则软降级不抛。
 * 返回 disposer（幂等）。apiKey 全无则警告并跳过注册。
 */
export function registerLlmAdapter({ ctx, config = {}, runtime = {}, log = () => {} } = {}) {
  const noop = () => {}
  const llm = ctx && ctx.llm
  if (!llm || typeof llm.registerAdapter !== 'function') {
    log('ManageAPI LLM adapter：ctx.llm 不可用或没有 registerAdapter，软降级跳过')
    return noop
  }
  const { key, source } = resolveApiKey(config)
  if (!key) {
    log('ManageAPI LLM adapter：缺少 apiKey（config.apiKey / MANAGE_API_GATEWAY_KEY / MANAGE_API_KEY 均为空），跳过注册')
    return noop
  }
  const providerId = config.providerId || LLM_ADAPTER_DEFAULTS.providerId
  const displayName = config.displayName || LLM_ADAPTER_DEFAULTS.displayName
  const rawBase = runtime.loopbackBaseUrl || 'http://127.0.0.1:4319'
  const baseUrl = `${String(rawBase).replace(/\/+$/, '')}/v1`
  const adapter = new ManageApiAdapter({
    providerId, displayName, baseUrl, apiKey: key,
    fetchImpl: config.fetchImpl, timeoutMs: config.timeoutMs,
  })
  let disposed = false
  let disposeRegistration = noop
  try {
    disposeRegistration = llm.registerAdapter([providerId], adapter) || noop
    log(`ManageAPI LLM adapter：已注册 provider "${providerId}"（baseUrl=${baseUrl}，key 来源=${source}）`)
  } catch (err) {
    log(`ManageAPI LLM adapter 注册失败（软降级）：${messageOf(err)}`)
    return noop
  }
  return () => {
    if (disposed) return
    disposed = true
    try { if (typeof disposeRegistration === 'function') disposeRegistration() } catch { /* ignore */ }
  }
}
