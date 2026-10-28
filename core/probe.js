/**
 * 探针层：判断一个「站 × 模型」现在是否可信。
 *
 * 三个检测，各自针对中转站最常见的一种偷工：
 *   fingerprint —— 掉包：把请求偷偷路由到便宜模型
 *   truncation  —— 砍额度：把 max_tokens 悄悄压低，输出被截断
 *   billing     —— 虚报：返回的 usage 远大于实际请求规模
 *
 * 全部用流式请求，顺带拿到 TTFT（首 token 延迟）——这是体验里最敏感的一项。
 */

import { estimateTokens } from './quality-signals.js'

const FINGERPRINT_PROMPT =
  'Reply with exactly this JSON and nothing else, no markdown code fence, no explanation:\n' +
  '{"fp":"7Q2K","calc":391}'

const TRUNCATION_PROMPT =
  'Count from 1 to 120. Output only the numbers separated by commas, nothing else.'

/**
 * 缓存检测用的长前缀。多数上游的 prompt cache 有最小长度门槛（常见 1024 token），
 * 所以这里凑到 1200+ token，确保能触发。
 */
const CACHE_FILLER = 'The quick brown fox jumps over the lazy dog. '.repeat(120)
const CACHE_PROMPT = `${CACHE_FILLER}\n\nReply with the single word: OK`

const FINGERPRINT_EXPECT = { fp: '7Q2K', calc: 391 }

/** 指纹请求的提示词大约 45 token，超过这个倍数就可疑。 */
const BILLING_TOLERANCE = 3
const BILLING_EXPECTED_PROMPT_TOKENS = 45

function stripFence(text) {
  return String(text || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
}

/** 流式读 SSE，回调每个 data 事件，同时记录首字节时间。 */
async function readSse(response, onEvent) {
  const decoder = new TextDecoder()
  let buffer = ''
  let firstEventAt = null
  for await (const chunk of response.body) {
    if (firstEventAt === null) firstEventAt = Date.now()
    buffer += decoder.decode(chunk, { stream: true })
    let newlineIndex
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return { firstEventAt, done: true }
      try {
        onEvent(JSON.parse(payload))
      } catch {
        /* 有些站会插入非 JSON 的心跳行，忽略 */
      }
    }
  }
  return { firstEventAt, done: false }
}

/**
 * 发一次对话请求，尽量用流式（为了 TTFT），失败则退回非流式。
 * @returns {{text:string, usage:object|null, finishReason:string|null, ttftMs:number|null, totalMs:number, streamed:boolean}}
 */
async function chatOnce({ baseUrl, apiKey, model, prompt, maxTokens = 300, timeoutMs = 45000 }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`
  const started = Date.now()

  const attempt = async (stream) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
        ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      const error = new Error(`HTTP ${response.status}${body ? `：${body.slice(0, 160)}` : ''}`)
      error.status = response.status
      throw error
    }

    if (!stream) {
      const payload = await response.json()
      const choice = payload?.choices?.[0]
      return {
        text: choice?.message?.content || '',
        usage: payload?.usage || null,
        finishReason: choice?.finish_reason || null,
        ttftMs: null,
        totalMs: Date.now() - started,
        streamed: false,
      }
    }

    let text = ''
    let usage = null
    let finishReason = null
    const { firstEventAt } = await readSse(response, (event) => {
      const choice = event?.choices?.[0]
      if (choice?.delta?.content) text += choice.delta.content
      if (choice?.finish_reason) finishReason = choice.finish_reason
      if (event?.usage) usage = event.usage
    })
    return {
      text,
      usage,
      finishReason,
      ttftMs: firstEventAt === null ? null : firstEventAt - started,
      totalMs: Date.now() - started,
      streamed: true,
    }
  }

  try {
    return await attempt(true)
  } catch (error) {
    // 有些站不支持 stream_options，退回非流式再试一次
    if (error.status === 400 || error.status === 422) return attempt(false)
    throw error
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 探针花费累计器。
 *
 * 形状与 usage.js 的 emptyRow 一致（input 是**净值**，缓存读/写单独存），
 * 这样记账时可以直接走 monitor.usageRowCost，与概览图的花费同一套算法。
 * 只有探针**自己发出的请求**会记进来——不读站点账单，也就不会把同一时间段
 * 里整站的真实用量算到探针头上。
 */
function newSpendRow() {
  return { requests: 0, input: 0, output: 0, cached: 0, cacheCreation: 0, inputIncludesCached: 0, estimated: 0 }
}

/** 把一个请求的结果累加进花费账本（只认上游真报的 usage；没报就按字数估并标记）。 */
function addSpend(spend, prompt, result) {
  if (!spend) return
  spend.requests += 1
  const usage = result?.usage || null
  const cached =
    Number(usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0) || 0
  const cacheCreation =
    Number(
      usage?.cache_creation_input_tokens ?? usage?.prompt_tokens_details?.cache_creation_tokens ?? 0,
    ) || 0
  const promptTokens = Number(usage?.prompt_tokens)
  if (Number.isFinite(promptTokens) && promptTokens >= 0) {
    spend.input += Math.max(0, promptTokens - cached - cacheCreation)
    spend.output += Number(usage?.completion_tokens) || 0
    spend.cached += cached
    spend.cacheCreation += cacheCreation
    return
  }
  // 上游没报 usage（个别站的流式不带）：只能按字数估。这个数会偏，所以单独
  // 计数，界面能说清楚「其中 N 个请求按字数估算」，不假装精确
  spend.estimated += 1
  spend.input += estimateTokens(prompt)
  spend.output += estimateTokens(result?.text)
}

/**
 * 缓存检测：同一段长前缀连发两次，看第二次有多少输入 token 走了缓存。
 *
 * 只看第二次——第一次必然是冷启动。中间留 1.5 秒让上游把缓存写进去。
 * 字段名各家不一，OpenAI 用 prompt_tokens_details.cached_tokens，
 * DeepSeek 系用 prompt_cache_hit_tokens，两种都认。
 *
 * @param {object} [spend] 花费累计器（两次请求的 usage 都会记进去）
 */
export async function probeCache({ baseUrl, apiKey, model, timeoutMs = 45000, spend = null }) {
  const first = await chatOnce({ baseUrl, apiKey, model, prompt: CACHE_PROMPT, maxTokens: 16, timeoutMs })
  addSpend(spend, CACHE_PROMPT, first)
  await sleep(1500)
  const second = await chatOnce({ baseUrl, apiKey, model, prompt: CACHE_PROMPT, maxTokens: 16, timeoutMs })
  addSpend(spend, CACHE_PROMPT, second)

  const promptTokens = second.usage?.prompt_tokens ?? null
  const cachedTokens =
    second.usage?.prompt_tokens_details?.cached_tokens ??
    second.usage?.prompt_cache_hit_tokens ??
    0
  const hitRate = promptTokens ? Math.min(cachedTokens / promptTokens, 1) : 0

  return {
    supported: cachedTokens > 0,
    hitRate,
    cachedTokens,
    promptTokens,
    detail: `prompt_tokens=${promptTokens ?? '未返回'}，cached_tokens=${cachedTokens}`,
    firstLatencyMs: first.totalMs,
    secondLatencyMs: second.totalMs,
  }
}

/**
 * 完整探测一个「站 × 分组 × 模型」。
 * 发四个请求：指纹与计费、截断、缓存（两次）。
 * withCache=false 时只发两个，缓存命中率保持上次的结果。
 * 每个请求的 usage 都会被累加进 result.spend，供探针花费账本记账。
 *
 * lite=true 只发两个请求（指纹与计费、截断），跳过缓存×2：
 * 自动路由活跃期的全量轮巡（daemon/autoprobe.js）每 30 分钟把所有模型过一遍，
 * 四连发太贵；指纹和截断才是「结果可不可信」的核心证据，缓存命中率慢点更新无所谓。
 */
export async function probeModel({ baseUrl, apiKey, model, timeoutMs = 45000, lite = false, withCache = true }) {
  const result = {
    ok: false,
    model,
    ts: new Date().toISOString(),
    latencyMs: null,
    ttftMs: null,
    fingerprintOk: null,
    fingerprintRaw: null,
    truncated: null,
    truncationDetail: null,
    billingInflated: null,
    cacheSupported: null,
    cacheHitRate: null,
    cacheDetail: null,
    promptTokens: null,
    requestTokens: null,
    completionTokens: null,
    finishReason: null,
    error: null,
    // 这一轮探测自己花了多少 token（记账用，见 addSpend）：
    // {requests, input, output, cached, cacheCreation, inputIncludesCached, estimated}
    spend: null,
  }
  const spend = newSpendRow()
  result.spend = spend
  /** 发一次请求并顺手记账——所有探测请求都必须走这里，漏一个就少算一笔钱 */
  const chat = async (options) => {
    const response = await chatOnce(options)
    addSpend(spend, options.prompt, response)
    return response
  }

  let first
  try {
    first = await chat({
      baseUrl,
      apiKey,
      model,
      prompt: FINGERPRINT_PROMPT,
      maxTokens: 200,
      timeoutMs,
    })
  } catch (error) {
    result.error = error?.message || String(error)
    return result
  }

  result.ok = true
  result.latencyMs = first.totalMs
  result.ttftMs = first.ttftMs
  result.finishReason = first.finishReason
  // 本地估算的 prompt token：和下面上游报的 promptTokens 一起构成「计费核验」的
  // 对照组——站点虚报时两者会明显背离（这是唯一不依赖站点自报数字的证据）
  result.requestTokens = estimateTokens(FINGERPRINT_PROMPT)

  // ---- 指纹：输出是否精确匹配
  const cleaned = stripFence(first.text)
  let parsed = null
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        parsed = JSON.parse(match[0])
      } catch {
        parsed = null
      }
    }
  }
  result.fingerprintOk =
    Boolean(parsed) &&
    String(parsed.fp ?? '') === FINGERPRINT_EXPECT.fp &&
    Number(parsed.calc) === FINGERPRINT_EXPECT.calc
  if (!result.fingerprintOk) result.fingerprintRaw = cleaned.slice(0, 200)

  // ---- 虚报：usage 是否远大于实际请求规模
  const promptTokens = first.usage?.prompt_tokens ?? null
  result.promptTokens = promptTokens
  result.completionTokens = first.usage?.completion_tokens ?? null
  if (typeof promptTokens === 'number') {
    result.billingInflated = promptTokens > BILLING_EXPECTED_PROMPT_TOKENS * BILLING_TOLERANCE
  }

  // ---- 截断：要求数到 120，看是否被提前掐断
  try {
    const second = await chat({
      baseUrl,
      apiKey,
      model,
      prompt: TRUNCATION_PROMPT,
      maxTokens: 1500,
      timeoutMs,
    })
    const numbers = (second.text.match(/\d+/g) || []).map(Number)
    const highest = numbers.length ? Math.max(...numbers) : 0
    const reportedTokens = second.usage?.completion_tokens ?? null
    // 两种截断信号（与 README 的判定依据一致）：
    // 1. 数字没数到 120——正常模型会数完，被砍就到不了
    // 2. finish_reason=length 但吐出的 token 远低于请求的 1500——站偷偷压了 max_tokens。
    //    （此前的 cutByLength 条件被 1 完全包含，是重复判断）
    const cutByQuota =
      second.finishReason === 'length' && typeof reportedTokens === 'number' && reportedTokens < 1500 * 0.4
    result.truncated = highest < 120 || cutByQuota
    result.truncationDetail = `最高数字 ${highest}，finish_reason=${second.finishReason ?? '未知'}，completion_tokens=${reportedTokens ?? '未返回'}`
  } catch (error) {
    result.truncationDetail = `截断检测失败：${error?.message || error}`
    result.truncated = null
  }

  // ---- 缓存：连发两次相同长前缀，看第二次命中多少
  // lite 模式跳过；withCache=false 跳过（定时探测隔轮补测，见 daemon/probe-runner.js）
  if (!lite && withCache) {
    try {
      const cache = await probeCache({ baseUrl, apiKey, model, timeoutMs, spend })
      result.cacheSupported = cache.supported
      result.cacheHitRate = cache.hitRate
      result.cacheDetail = cache.detail
    } catch (error) {
      result.cacheDetail = `缓存检测失败：${error?.message || error}`
    }
  }

  return result
}
