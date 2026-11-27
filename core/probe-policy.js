/**
 * 探测策略：哪些「失败」值得立刻再试一次，哪些供给根本不该用 chat 探针，
 * 以及探测超时该给多长。都是纯函数，方便单独测。
 */

/** 探测超时下限：真实请求里 prompt 可以到 20 万 token、TTFT 能到 90 秒，
 *  45 秒的超时会把「忙」判成「死」。低于这个数一律按它算。 */
export const PROBE_TIMEOUT_FLOOR_MS = 90_000

/** 缓存命中率几小时才变一次，没必要每轮都连发两次长请求（每次约 14.5k token）。 */
export const CACHE_PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 一次探测内的瞬时错误：值得隔一秒重试一次，两次都失败才算这条供给不可用。 */
const TRANSIENT_RE =
  /HTTP\s*5\d\d|timeout|timed out|aborted|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang ?up|temporarily unavailable|服务暂时不可用|超时/i

/** 站方明确拒绝的不在瞬时之列：429 重试会加重限流，401/403/400 是配置问题。 */
const DEFINITE_RE = /HTTP\s*(4\d\d)|429|rate[_\s-]?limit|无效|不支持|已删除/i

export function isTransientError(message) {
  const text = String(message || '')
  if (!text) return false
  if (DEFINITE_RE.test(text)) return false
  return TRANSIENT_RE.test(text)
}

/** 画图 / 向量 / 语音 / 视频模型不能用 /v1/chat/completions 探，白烧额度还永远判失败。 */
const NON_CHAT_RE =
  /(^|[-_/. ])(image|images|imagen|dall[-_ ]?e|flux|stable[-_ ]?diffusion|sdxl|midjourney|mj|tts|audio|speech|whisper|embed|embedding|rerank|video|veo|sora|kling|runway)([-_/. ]|$)/i

export function isNonChatModel(name) {
  return NON_CHAT_RE.test(String(name || ''))
}

/** 探测实际使用的超时：设置值不低于下限时用它，否则抬到下限。 */
export function probeTimeoutMsOf(settings = {}) {
  const raw = Number(settings?.probeTimeoutMs)
  return Number.isFinite(raw) && raw >= PROBE_TIMEOUT_FLOOR_MS ? raw : PROBE_TIMEOUT_FLOOR_MS
}

/**
 * 这条供给上次被探测的时间（任何一次探测记录，不论成败）。
 *
 * 用途只有一件：批量探测时按「最久没探的先用」排序。
 * 以前批量是照数据里的固定顺序 slice(0, limit)，手点「探测全部」永远只打同前 5 条，
 * 其余供给只能等定时任务轮到——13 条在售供给时那个按钮名不副实。
 */
export function lastProbeAt(probes = [], offerId = '') {
  let best = 0
  for (const p of probes) {
    if (p.offerId !== offerId) continue
    const t = new Date(p.ts).getTime()
    if (Number.isFinite(t) && t > best) best = t
  }
  return best || 0
}

/** 这条供给上次做过缓存探测的时间（用于降频）。 */
export function lastCacheProbeAt(probes = [], offerId = '') {
  let best = 0
  for (const p of probes) {
    if (p.offerId !== offerId) continue
    if (p.cacheSupported === null || p.cacheSupported === undefined) continue
    const t = new Date(p.ts).getTime()
    if (Number.isFinite(t) && t > best) best = t
  }
  return best || 0
}

export function shouldProbeCache(lastAt, now = Date.now()) {
  if (!lastAt) return true
  return now - lastAt >= CACHE_PROBE_INTERVAL_MS
}

/**
 * 站点级冷却：同一个 Key/账号被限流、余额不足时，同站每条供给都别再去撞。
 * 返回 providerId → 冷却截止时间。
 */
export function providerCooldowns(scores, providerOf, now = Date.now()) {
  const map = new Map()
  if (!scores || typeof scores.forEach !== 'function') return map
  scores.forEach((score, offerId) => {
    const until = score?.blocked?.until
    if (!until || until <= now) return
    const providerId = (typeof providerOf === 'function' ? providerOf(offerId) : '') || score?.providerId || ''
    if (!providerId) return
    const prev = map.get(providerId)?.until || 0
    if (until > prev) map.set(providerId, { offerId, until })
  })
  return map
}

/**
 * 批量探测该挑哪些目标：**最久没探的先探**，冷却中的站整站跳过。
 *
 * 以前是照数据里的固定顺序 `slice(0, limit)`：手点「探测全部」永远只打同前 5 条，
 * 13 条在售供给时后面 8 条只能等定时任务轮到，而且完全不看冷却——
 * 429 的站被反复砸，只会把限流拖得更久。
 *
 * @returns {{targets:Array, cooling:Array}} cooling 是「被跳过」的占位结果，供界面报数
 */
export function pickProbeTargets({ offers = [], probes = [], cooldowns = null, limit = 5, now = Date.now() } = {}) {
  const cooling = []
  const ready = []
  for (const offer of offers) {
    const hit = cooldowns && typeof cooldowns.get === 'function' ? cooldowns.get(offer.providerId) : null
    if (hit && Number(hit.until) > now) {
      const mins = Math.max(1, Math.round((hit.until - now) / 60000))
      cooling.push({
        offerId: offer.id,
        providerId: offer.providerId,
        ok: false,
        skipped: 'cooling',
        error: `站点在冷却中（约 ${mins} 分钟后到期），这一轮跳过`,
      })
      continue
    }
    ready.push(offer)
  }
  ready.sort((a, b) => lastProbeAt(probes, a.id) - lastProbeAt(probes, b.id))
  return { targets: ready.slice(0, Math.max(0, limit)), cooling }
}
