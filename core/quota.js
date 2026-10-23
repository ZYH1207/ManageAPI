/**
 * 免费额度的记账与推算。
 *
 * 三种单位（次 / token / 积分）**不互相换算**：一次请求可能是 200 token 也可能是 40k，
 * 硬换出来的数字看着精确，其实是编的，会把「按天还能撑多久」算成一句假话。
 * 唯一允许跨单位比较的量是 daysLeft（天）——它是「剩多少 ÷ 每天烧多少」，单位在除法里自然消掉。
 *
 * 本模块是纯函数：不读盘、不写盘，所有持久化由 inventory.js 的 mutate 负责。
 */

const UNITS = new Set(['request', 'token', 'credit'])
const DAY_MS = 86400000

/** 数值化：空串、null、undefined 一律当作「没填」，不要变成 0 */
function toNum(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * 窗口的下一个重置点。
 * 用本地零点而不是「now + 24h」：站点的每日免费次数按自然日结算，
 * 从设置那一刻起算 24 小时会让重置时间每天漂移。
 */
function nextResetAt(window, now) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  if (window === 'month') {
    d.setDate(1)
    d.setMonth(d.getMonth() + 1)
  } else {
    d.setDate(d.getDate() + 1)
  }
  return d.toISOString()
}

/** 把一个重置点往后推一个周期 */
function advance(resetAt, window) {
  const d = new Date(resetAt)
  if (window === 'month') d.setMonth(d.getMonth() + 1)
  else d.setDate(d.getDate() + 1)
  return d
}

/**
 * 把用户填的（或从站点读来的）裸数据整理成可用的配额。
 * 没有上限就返回 null——「无限额度」和「额度为 0」是两件事，不能都塞成 0。
 *
 * @returns {{unit:'request'|'token'|'credit', limit:number, used:number, window:'day'|'month', resetAt:string}|null}
 */
export function normalizeQuota(raw) {
  if (!raw || typeof raw !== 'object') return null
  const limit = toNum(raw.limit)
  if (limit === null || limit < 0) return null

  const window = raw.window === 'month' ? 'month' : 'day'
  const given = raw.resetAt ? new Date(raw.resetAt) : null
  const validGiven = given && Number.isFinite(given.getTime()) ? given.toISOString() : null

  return {
    unit: UNITS.has(raw.unit) ? raw.unit : 'request',
    limit,
    used: Math.max(0, toNum(raw.used) ?? 0),
    window,
    // 没给重置时间就按窗口推一个：调用方（界面、网关）都可以不关心周期怎么算
    resetAt: validGiven ?? nextResetAt(window, Date.now()),
  }
}

/**
 * 过期了就归零。返回新对象，不改入参——同一份 quota 可能同时被渲染和记账读到。
 *
 * 跨多个周期也要一次推到未来：daemon 停三天再起来，不能只减一天就又判过期。
 */
export function resetIfDue(quota, now = Date.now()) {
  if (!quota) return null
  const window = quota.window === 'month' ? 'month' : 'day'
  const parsed = quota.resetAt ? new Date(quota.resetAt) : null
  const base =
    parsed && Number.isFinite(parsed.getTime()) ? parsed : new Date(nextResetAt(window, now))

  let next = base
  while (next.getTime() <= now) next = advance(next, window)

  const expired = next.getTime() !== base.getTime()
  return {
    ...quota,
    window,
    used: expired ? 0 : quota.used,
    resetAt: next.toISOString(),
  }
}

/**
 * 记一次消耗。
 * request 单位按次数记，token / credit 按 token 数记——积分怎么折算由调用方算好再传，
 * 这里不认识任何站点的积分规则。
 */
export function consumeQuota(quota, { tokens = 0, requests = 1 } = {}) {
  if (!quota) return null
  const delta = quota.unit === 'request' ? toNum(requests) ?? 0 : toNum(tokens) ?? 0
  return { ...quota, used: Math.max(0, toNum(quota.used) ?? 0) + delta }
}

/** 剩余量。无配额（不限量）返回 null，界面据此显示「—」而不是 0。 */
export function remaining(quota) {
  const limit = toNum(quota?.limit)
  if (limit === null) return null
  return Math.max(0, limit - (toNum(quota.used) ?? 0))
}

/** 已用比例 0~1，供进度条用。上限为 0 时视为用满，避免除零。 */
export function usedRatio(quota) {
  const limit = toNum(quota?.limit)
  if (limit === null) return null
  if (limit === 0) return 1
  const used = toNum(quota.used) ?? 0
  return Math.min(1, Math.max(0, used / limit))
}

/**
 * 还能撑几天 = 剩余量 ÷ 每日消耗。
 * 速率未知或为 0 时返回 null（排到最后），不要用一个假的大数骗排序。
 */
export function daysLeft(quota, perDay) {
  const left = remaining(quota)
  if (left === null) return null
  const rate = toNum(perDay)
  if (rate === null || rate <= 0) return null
  return left / rate
}

/** 窗口长度（毫秒），估算消耗速率时用 */
export const WINDOW_MS = { day: DAY_MS, month: 30 * DAY_MS }
