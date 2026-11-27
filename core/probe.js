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

import {
  estimateTokens,
  BILLING_MIN_TOKENS,
  CACHE_SUSPECT_RATIO,
  CACHE_SUSPECT_MIN_PROMPT,
} from './quality-signals.js'

const FINGERPRINT_PROMPT =
  'Reply with exactly this JSON and nothing else, no markdown code fence, no explanation:\n' +
  '{"fp":"7Q2K","calc":391}'

const TRUNCATION_PROMPT =
  'Count from 1 to 120. Output only the numbers separated by commas, nothing else.'

/**
 * 身份自述。**仅供参考，不能作为判据**。
 *
 * 模型被问「你是什么模型」时，回答来自训练数据里的自我认知，经常是错的：
 * DeepSeek 说自己是 ChatGPT、Claude 说自己是 GPT-4 都很常见。
 * 所以这里只记录、不评分，让人自己看。
 */
const IDENTITY_PROMPT = 'What model are you? Reply with only the model name, nothing else.'

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
 * 缓存检测：同一段长前缀连发两次，看第二次有多少输入 token 走了缓存。
 *
 * 只看第二次——第一次必然是冷启动。中间留 1.5 秒让上游把缓存写进去。
 * 字段名各家不一，OpenAI 用 prompt_tokens_details.cached_tokens，
 * DeepSeek 系用 prompt_cache_hit_tokens，两种都认。
 */
export async function probeCache({ baseUrl, apiKey, model, timeoutMs = 45000 }) {
  const first = await chatOnce({ baseUrl, apiKey, model, prompt: CACHE_PROMPT, maxTokens: 16, timeoutMs })
  await sleep(1500)
  const second = await chatOnce({ baseUrl, apiKey, model, prompt: CACHE_PROMPT, maxTokens: 16, timeoutMs })

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
    // 这两次请求实际发出去的前缀有多大（本地估算）——判「多收钱」必须跟它比，
    // 不能拿指纹请求的 45 token 去比缓存请求的 14k
    expectedPromptTokens: estimateTokens(CACHE_PROMPT),
    detail: `prompt_tokens=${promptTokens ?? '未返回'}，cached_tokens=${cachedTokens}`,
    firstLatencyMs: first.totalMs,
    secondLatencyMs: second.totalMs,
  }
}

/**
 * 计费判据：只比较**同一次请求**里的 prompt_tokens 与 cached_tokens。
 *
 * 拆成纯函数是为了可测——这条判据出过一次大错（拿指纹请求的 prompt_tokens
 * 去减缓存请求的 cached_tokens，两个请求长度差一个数量级），必须有单元测试钉住。
 *
 * @param {object} input
 * @param {number|null} input.fingerprintPromptTokens 指纹请求上报的 prompt_tokens（只用于算固定开销）
 * @param {number|null} input.cachePromptTokens       缓存请求上报的 prompt_tokens
 * @param {number|null} input.cacheCachedTokens       缓存请求上报的 cached_tokens
 * @param {number|null} input.expectedCachePromptTokens 缓存请求本地估算的输入长度
 * @returns {{fixedOverheadTokens:number|null, billedInputTokens:number|null,
 *            billedInputInflated:boolean|null, cacheSuspect:boolean|null}}
 */
export function billingVerdict({
  fingerprintPromptTokens = null,
  cachePromptTokens = null,
  cacheCachedTokens = null,
  expectedCachePromptTokens = null,
} = {}) {
  const fixedOverheadTokens =
    typeof fingerprintPromptTokens === 'number'
      ? fingerprintPromptTokens - BILLING_EXPECTED_PROMPT_TOKENS
      : null
  // 没有缓存请求的两个数 → 没有证据，判 null（不是 true，也不是 false）
  if (typeof cachePromptTokens !== 'number') {
    return { fixedOverheadTokens, billedInputTokens: null, billedInputInflated: null, cacheSuspect: null }
  }
  const cached = typeof cacheCachedTokens === 'number' ? cacheCachedTokens : 0
  const billedInputTokens = Math.max(0, cachePromptTokens - cached)
  const expected =
    typeof expectedCachePromptTokens === 'number' && expectedCachePromptTokens > 0
      ? expectedCachePromptTokens
      : null
  return {
    fixedOverheadTokens,
    billedInputTokens,
    billedInputInflated:
      expected !== null &&
      billedInputTokens > BILLING_MIN_TOKENS &&
      billedInputTokens > expected * BILLING_TOLERANCE,
    cacheSuspect:
      cached > 0 &&
      (cached > cachePromptTokens ||
        (cachePromptTokens > CACHE_SUSPECT_MIN_PROMPT && cached / cachePromptTokens > CACHE_SUSPECT_RATIO)),
  }
}

/**
 * 完整探测一个「站 × 分组 × 模型」。
 * 发四次请求：指纹与计费、截断、缓存（两次）。
 */
export async function probeModel({ baseUrl, apiKey, model, timeoutMs = 45000, skipCache = false, skipIdentity = false }) {
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
    billedInputInflated: null,
    billedInputTokens: null,
    fixedOverheadTokens: null,
    cacheSupported: null,
    cacheHitRate: null,
    cacheDetail: null,
    cachedTokens: null,
    cacheSuspect: null,
    identityClaim: null,
    promptTokens: null,
    requestTokens: null,
    completionTokens: null,
    finishReason: null,
    error: null,
  }

  let first
  try {
    first = await chatOnce({ baseUrl, apiKey, model, prompt: FINGERPRINT_PROMPT, maxTokens: 200, timeoutMs })
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
    const second = await chatOnce({ baseUrl, apiKey, model, prompt: TRUNCATION_PROMPT, maxTokens: 1500, timeoutMs })
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

  // ---- 缓存：连发两次相同长前缀，看第二次命中多少。
  // 这两针各带约 14.5k token，而命中率几小时才变一次——按调用方给的间隔降频，
  // 其余轮次沿用上次结果（读取侧本来就对老记录取中位）。
  let cacheInfo = null
  try {
    if (skipCache) throw new Error('skipped')
    cacheInfo = await probeCache({ baseUrl, apiKey, model, timeoutMs })
    result.cacheSupported = cacheInfo.supported
    result.cacheHitRate = cacheInfo.hitRate
    result.cacheDetail = cacheInfo.detail
    result.cachedTokens = typeof cacheInfo.cachedTokens === 'number' ? cacheInfo.cachedTokens : null
  } catch (error) {
    if (!skipCache) result.cacheDetail = `缓存检测失败：${error?.message || error}`
  }

  // ---- 计费判据分家
  // billingInflated 只说明「这个站有固定开销」（展示用，不扣分）；
  // billedInputInflated 才是真的多算钱，判它必须**在同一个请求内**比较：
  // prompt_tokens 与 cached_tokens 来自同一次调用，跟那次调用实际发出去的长度比。
  //
  // 曾经的错误做法是「指纹请求的 prompt_tokens − 缓存请求的 cached_tokens」：
  // 两个请求长度差一个数量级（45 vs 14k），减出来的数既不是任何一次请求的计费输入，
  // 还会把「系统提示很长但每次都命中缓存」的站误判成多收钱（实测 40% 的探针被冤枉）。
  result.billingCheckVersion = 2
  const verdict = billingVerdict({
    fingerprintPromptTokens: promptTokens,
    cachePromptTokens: cacheInfo?.promptTokens ?? null,
    cacheCachedTokens: cacheInfo?.cachedTokens ?? null,
    expectedCachePromptTokens: cacheInfo?.expectedPromptTokens ?? null,
  })
  result.fixedOverheadTokens = verdict.fixedOverheadTokens
  result.billedInputTokens = verdict.billedInputTokens
  result.billedInputInflated = verdict.billedInputInflated
  result.cacheSuspect = verdict.cacheSuspect

  // ---- 身份自述：只记录，不参与评分（模型自述经常不准）。
  // 日常轮次跳过（skipIdentity）：一条供给探过一次之后，再问「你是什么模型」
  // 就是每轮白打一发请求——它对评分零贡献，只占额度。
  if (!skipIdentity) {
    try {
      const identity = await chatOnce({
        baseUrl,
        apiKey,
        model,
        prompt: IDENTITY_PROMPT,
        maxTokens: 40,
        timeoutMs,
      })
      const text = String(identity.text || '').trim().replace(/\s+/g, ' ')
      result.identityClaim = text ? text.slice(0, 80) : null
    } catch {
      result.identityClaim = null
    }
  }

  return result
}
