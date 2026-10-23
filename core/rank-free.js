/**
 * 免费池的排序：闸门 + 单指标排序。
 *
 * 为什么不照搬付费侧的「价格 ÷ 质量」：免费侧成本恒为 0，0 除以任何数都是 0，
 * 除法失去区分度——质量再差也不会被降权。所以质量在这里只能当**闸门**：
 * 不达标就整个排除，不给「便宜但烂」留位置。
 *
 * 通过闸门之后只看一个指标：预计还能撑几天（跨来源唯一可比的量）。
 * 首字只用来打破平局，不参与加权。
 */
import { normalizeQuota, resetIfDue, remaining, daysLeft as daysLeftOf, WINDOW_MS } from './quota.js'

const MIN_FINGERPRINT = 0.8
const MIN_TRUNCATION = 0.8

/** score 可能是 Map（服务端）或裸对象（前端塞在 offer.score 上） */
function scoreOf(offer, scores) {
  if (scores instanceof Map) return scores.get(offer.id) || null
  if (scores && typeof scores === 'object') return scores[offer.id] || null
  return offer.score || null
}

/**
 * 近期消耗速率（每天）。
 *
 * 配额里只存了「已用多少」和「什么时候重置」，速率只能反推：
 * 窗口已经过掉多少天，用已用量除以它。窗口刚开始的半天不足以估速率，
 * 返回 null 而不是拿 3 次消耗算出夸张的天数。
 */
function dailyBurn(quota, now) {
  if (!quota) return null
  const windowMs = WINDOW_MS[quota.window] ?? WINDOW_MS.day
  const resetMs = new Date(quota.resetAt).getTime()
  if (!Number.isFinite(resetMs)) return null
  const elapsedDays = (windowMs - (resetMs - now)) / 86400000
  if (!(elapsedDays >= 0.5)) return null
  const used = Number(quota.used) || 0
  return used > 0 ? used / Math.min(elapsedDays, windowMs / 86400000) : 0
}

/**
 * 闸门。任一命中即排除。
 *
 * 顺序上先看「额度用超了」再看「正好用尽」：used > limit 说明账已经记爆
 * （站点给的额度和实际允许的不一致），这时报「超出配额」比「用尽」更接近事实。
 */
function gateOf(score, quota) {
  if (quota) {
    if (Number(quota.used) > Number(quota.limit)) {
      return { code: 'quota_capped', label: '超出配额' }
    }
    if (remaining(quota) <= 0) return { code: 'exhausted', label: '额度用尽' }
  }
  // 没探测过就不算可用：免费站的掉包率远高于付费站，不能靠「看着像真的」放行
  if (!score || !score.samples) return { code: 'probing', label: '未探测' }
  if (score.stale === true) return { code: 'stale', label: '评分过期' }
  if (typeof score.fingerprintRate === 'number' && score.fingerprintRate < MIN_FINGERPRINT) {
    return { code: 'fingerprint', label: '指纹不符' }
  }
  // 注意：truncationRate 是「未截断比例」，不是截断率，所以判据是 < 0.8
  if (typeof score.truncationRate === 'number' && score.truncationRate < MIN_TRUNCATION) {
    return { code: 'truncated', label: '输出截断' }
  }
  return null
}

function ttftOf(score) {
  return typeof score?.ttftMs === 'number' ? score.ttftMs : Infinity
}

/**
 * @param {Object} options
 * @param {Array} options.offers 免费供给
 * @param {Map|Object|null} options.scores offerId → score
 * @param {Object} [options.benchmarks] 预留给调用方统一入参，排序本身不看价格
 * @param {'remaining'|'relay'|'platform'} [options.crossPane] 跨栏偏好
 * @param {number} [options.now]
 * @returns {Array<{offer:Object, score:Object|null, gate:null|{code:string,label:string}, daysLeft:number|null, priority:number}>}
 *          priority 是最终展示次序（0 = 首选），供界面直接拿来标「首选」
 */
export function rankFreePool({
  offers = [],
  scores = null,
  benchmarks = {},
  crossPane = 'remaining',
  now = Date.now(),
} = {}) {
  void benchmarks // 价格对免费侧不参与决策，保留参数只为调用方统一传参

  const rows = (offers || []).map((offer) => {
    const score = scoreOf(offer, scores)
    // 先用 resetIfDue 把过期的账归零，否则跨天之后整池都会被判「用尽」
    const quota = resetIfDue(normalizeQuota(offer.freeQuota), now)
    const gate = gateOf(score, quota)
    const days = quota ? daysLeftOf(quota, dailyBurn(quota, now)) : null
    return {
      offer,
      score,
      gate,
      daysLeft: days === null ? null : Math.round(days * 10) / 10,
      priority: 0,
    }
  })

  const passed = rows.filter((row) => !row.gate)
  const gated = rows.filter((row) => row.gate)

  // relay 偏好下中转站侧不重排：用户既然选了「中转站优先」，同栏内就按导入顺序来
  if (crossPane !== 'relay') {
    passed.sort((a, b) => {
      if (a.daysLeft === null && b.daysLeft === null) return ttftOf(a.score) - ttftOf(b.score)
      if (a.daysLeft === null) return 1
      if (b.daysLeft === null) return -1
      if (a.daysLeft !== b.daysLeft) return b.daysLeft - a.daysLeft
      return ttftOf(a.score) - ttftOf(b.score)
    })
  }

  // 被排除的按原因分组排（同因相邻），组内保持传入顺序：界面上一眼能看出「这批都是没探测」
  const groupOrder = new Map()
  for (const row of gated) {
    if (!groupOrder.has(row.gate.code)) groupOrder.set(row.gate.code, groupOrder.size)
  }
  gated.sort((a, b) => groupOrder.get(a.gate.code) - groupOrder.get(b.gate.code))

  const ordered = [...passed, ...gated]
  ordered.forEach((row, index) => {
    row.priority = index
  })
  return ordered
}
