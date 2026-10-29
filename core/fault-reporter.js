/**
 * 故障上报：把「用户真的受了影响」的故障推给自动路由，让它做故障转移。
 *
 * 对接的是自动路由那一侧的接口（见 core/failover.js 的注释）：
 *   POST {url}                      默认 http://127.0.0.1:<本进程端口>/api/failover/report
 *   Authorization: Bearer <token>   令牌在自动路由侧的 settings.failoverToken
 *   body: { offerId?, modelKey?, kind, message, holdMinutes }
 *
 * 三条铁律：
 *   1. **绝不阻塞用户请求**。上报是 fire-and-forget，失败只记账不抛错——
 *      用户的心流不能因为「通知不到监控系统」而断掉。
 *   2. **绝不重复轰炸**。同一供给同一类故障在冷却期内只报一次；自动路由那边
 *      一条上报就剔除十分钟，报多了等于来回折腾它。
 *   3. **绝不上报「用户无感」的故障**。那由 core/fault-triage.js 先把关，
 *      本模块只负责送出去。
 */
import { mutate, readDb } from './store.js'
import { randomUUID } from 'node:crypto'

/** 同一供给同一 kind 的上报冷却：期内不重复报 */
export const REPORT_COOLDOWN_MS = 10 * 60_000
/** 事件账保留条数 */
export const MAX_FAULT_EVENTS = 300
/** 单次上报超时：宁可放弃上报也不能挂着 */
const REPORT_TIMEOUT_MS = 5000

/**
 * 老版本写死的默认地址。
 *
 * 以前 defaultFaultReport().url 就是这一串，所有实例（含 4500 上的验收副本）
 * 都往 4319 发。副本的 failoverToken 又是从真实库复制的，令牌对得上，于是
 * 诊断上报直接写进了真实实例的故障账——一个任务在预览里点两下，真实路由换人。
 * 现在这个值只用于兼容识别：读到它一律当「没配过」，按本进程实际端口解析。
 */
export const LEGACY_DEFAULT_URL = 'http://127.0.0.1:4319/api/failover/report'

/** 本进程实际监听端口：由 daemon 启动时注入（端口可能因占用顺延） */
let reportPort = Number(process.env.MANAGE_API_PORT) || 4319

/** daemon 启动拿到真实端口后调用（幂等） */
export function setReportPort(port) {
  const n = Number(port)
  if (Number.isInteger(n) && n > 0) reportPort = n
}

/** 默认上报地址：跟着本进程端口走，预览 / 隔离实例不会打到别人家里 */
export function defaultReportUrl() {
  return `http://127.0.0.1:${reportPort}/api/failover/report`
}

/** 上报配置的缺省值（store.js 的 emptyDb 引用同一口径） */
export function defaultFaultReport() {
  return {
    enabled: true,
    // 空 = 自动指向本进程端口（见 defaultReportUrl）；分开部署时再手填
    url: '',
    token: '',
    // 留空 = 用本机 db 自己的 failoverToken（同库同令牌时最省事）
    useOwnToken: true,
  }
}

export function normalizeFaultReport(value) {
  const raw = value && typeof value === 'object' ? value : {}
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  return {
    enabled: raw.enabled !== false,
    // 空 / 老默认值 = 没显式配过 → 交给运行时按端口解析
    url: url && url !== LEGACY_DEFAULT_URL ? url : '',
    token: typeof raw.token === 'string' ? raw.token : '',
    useOwnToken: raw.useOwnToken !== false,
  }
}

/** 实际要打向哪里（界面展示与真正发送共用这一份口径） */
export function resolveReportUrl(db) {
  const cfg = normalizeFaultReport(db?.settings?.faultReport)
  return cfg.url || defaultReportUrl()
}

/** 事件账缺省形状 */
export function defaultFaultEvents() {
  return []
}

/** 幂等：缺键补上 */
export function ensureFaultKeys(db) {
  if (!Array.isArray(db.faultEvents)) db.faultEvents = []
  if (!db.settings.faultReport || typeof db.settings.faultReport !== 'object') {
    db.settings.faultReport = defaultFaultReport()
  } else {
    db.settings.faultReport = normalizeFaultReport(db.settings.faultReport)
  }
  // 零配置就绪：自动路由侧的 failoverToken 格式一致（fv_<uuid>），若尚未生成
  // 则在此预先生成；两边合入同一库后自然复用同一枚令牌，用户不用手工抄配置
  if (typeof db.settings.failoverToken !== 'string' || !db.settings.failoverToken) {
    db.settings.failoverToken = `fv_${randomUUID().replace(/-/g, '')}`
  }
  return db
}

/**
 * 取上报令牌。
 * 同一份 db 里自动路由也会生成 failoverToken——本机自报时直接复用，
 * 用户不用手工抄一遍令牌（「一键即开」的底线）。
 */
export function resolveToken(db) {
  const cfg = normalizeFaultReport(db.settings?.faultReport)
  if (cfg.token) return cfg.token
  if (cfg.useOwnToken && typeof db.settings?.failoverToken === 'string') return db.settings.failoverToken
  return ''
}

/** 该供给在冷却期内是否已经报过同一 kind（读事件账，重启也不丢） */
export function recentlyReported(events, { offerId, modelKey, kind }, now = Date.now()) {
  return (events || []).some((e) => {
    if (e.status !== 'sent') return false
    if (now - Date.parse(e.at) > REPORT_COOLDOWN_MS) return false
    if (e.kind !== kind) return false
    return offerId ? e.offerId === offerId : !e.offerId && e.modelKey === modelKey
  })
}

/** 落一条研判/上报事件（截流记录也走这里，诊断页统一读）
 *
 * dedupeMs > 0 时做聚合：同一供给、同一 kind、同一 status 在窗口内已有一条，
 * 就把 hits +1 并刷新 detail，不再新增。用于「客户端断开」这类高频又不需要逐条看的记录
 * ——不聚合的话它会把事件账刷满，真故障反而被挤出去。 */
export async function recordFaultEvent(entry, { dedupeMs = 0 } = {}) {
  return mutate((db) => {
    ensureFaultKeys(db)
    const now = Date.now()
    if (dedupeMs > 0) {
      const prev = [...db.faultEvents]
        .reverse()
        .find(
          (e) =>
            e.status === entry.status &&
            e.kind === entry.kind &&
            e.offerId === entry.offerId &&
            now - Date.parse(e.at) < dedupeMs,
        )
      if (prev) {
        prev.hits = (prev.hits || 1) + 1
        prev.lastAt = new Date(now).toISOString()
        if (entry.detail) prev.detail = entry.detail
        return prev
      }
    }
    const record = {
      id: `ev_${Math.random().toString(36).slice(2, 10)}`,
      at: new Date(now).toISOString(),
      status: 'observed',
      ...entry,
    }
    db.faultEvents.push(record)
    if (db.faultEvents.length > MAX_FAULT_EVENTS) {
      db.faultEvents.splice(0, db.faultEvents.length - MAX_FAULT_EVENTS)
    }
    return record
  }).catch(() => null)
}

/** 更新一条事件的上报结果（成功/失败原因） */
export async function markFaultEvent(id, patch) {
  return mutate((db) => {
    ensureFaultKeys(db)
    const e = db.faultEvents.find((x) => x.id === id)
    if (e) Object.assign(e, patch)
    return e || null
  }).catch(() => null)
}

/**
 * 真正发出去。**不抛错**——调用方在网关热路径上，任何异常都会伤到用户请求。
 *
 * @returns {Promise<{ok:boolean, status?:number, error?:string, skipped?:string}>}
 */
export async function postFaultReport({ offerId = null, modelKey = null, kind = 'runtime', message = '', holdMinutes = 10 } = {}) {
  let db
  try {
    db = await readDb()
  } catch {
    return { ok: false, error: '读库失败' }
  }
  const cfg = normalizeFaultReport(db.settings?.faultReport)
  if (!cfg.enabled) return { ok: false, skipped: '上报开关未打开' }
  const token = resolveToken(db)
  if (!token) return { ok: false, skipped: '没有可用令牌（自动路由的 failoverToken 尚未生成）' }
  if (!offerId && !modelKey) return { ok: false, skipped: '没有上报目标' }
  const target = cfg.url || defaultReportUrl()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS)
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ offerId: offerId || undefined, modelKey: modelKey || undefined, kind, message, holdMinutes }),
      signal: controller.signal,
    })
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      return { ok: false, status: res.status, error: text.slice(0, 160) || `HTTP ${res.status}` }
    }
    return { ok: true, status: res.status }
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? `上报超时（${REPORT_TIMEOUT_MS / 1000}s）` : error?.message || String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 上报 + 记账的完整流程（网关在请求结束后调用，不等待结果语义）。
 *
 * @param {object} p
 * @param {string} p.offerId
 * @param {string} p.modelKey
 * @param {string} p.kind
 * @param {string} p.message
 * @param {number} p.holdMinutes
 * @param {object} p.impact   assessRequestImpact 的结果，记进事件账供诊断页展示
 */
export async function reportFault({ offerId = null, modelKey = null, kind = 'runtime', message = '', holdMinutes = 10, impact = null } = {}) {
  const result = await postFaultReport({ offerId, modelKey, kind, message, holdMinutes })
  await recordFaultEvent({
    offerId,
    modelKey,
    kind,
    message,
    impact: impact?.impact || null,
    impactReason: impact?.reason || null,
    status: result.ok ? 'sent' : result.skipped ? 'skipped' : 'failed',
    // 上报失败也留痕：诊断页要能看出「你以为报了其实没报」
    error: result.ok ? null : result.error || result.skipped || null,
    httpStatus: result.status || null,
  })
  return result
}
