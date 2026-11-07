/**
 * 故障转移：接收外部监控系统的真实故障上报，与探针测定互相独立。
 *
 * 为什么要有这一套：探针是「抽样体检」，运行中的真实故障是「当场发病」——
 * 探针间隔里的故障、只在特定请求形态下出现的故障，探针都测不到。而网关这边
 * 每一次真实调用本身就是运行现场。所以真实故障的证据等级高于探针：
 * 探针说健康、监控说故障，以监控为准——先把流量挪走（故障转移），再谈别的。
 *
 * 语义（刻意与准入分开）：
 *   - 故障转移**不是**准入门禁。被上报故障的供给只是被排到同类最后 + 从自动路由
 *     的「最优」里剔除，不会被打成分数问题（它可能真的完全健康，只是监控看见了
 *     探针看不见的病）。探针自己的准入判定一行都不改。
 *   - 故障有保持期（默认 10 分钟）。期内剔除；到期视为「故障可能解除」，
 *     供给自动恢复参选资格。若此时它仍是全场第一（自动路由的口径），就把它
 *     提回来（reason='fault-recovery'，不受 15% 迟滞约束——重回第一本身就是
 *     明确的信号，再压着它反而是折腾）。若已不是第一，就让位，正常竞争。
 *   - 上报可以只给 modelKey（模型级故障：这个模型本身坏了，哪家接都一样），
 *     也可以给 offerId（供给级：某个站的问题）。模型级上报命中该模型全部供给。
 *
 * 接口（给未来的故障监控系统接）：POST /api/failover/report，令牌鉴权
 * （settings.failoverToken，daemon 启动时自动生成，UI 可查）。本模块只管
 * 记录、判定与剔除口径，HTTP 收口在 daemon/server.js。
 */
import { randomUUID } from 'node:crypto'
import { mutate } from './store.js'

/** 故障保持期：期内剔除，到期自动恢复参选资格（毫秒） */
export const FAULT_HOLD_MS = 10 * 60_000
/** 上报历史保留上限：监控打得多也不许把 db.json 撑爆 */
export const MAX_FAULT_REPORTS = 200

/** db.failover 的缺省形状（store.js 的 emptyDb 引用同一口径） */
export function defaultFailover() {
  return { reports: [] }
}

/** 任意输入 → 完整形状；reports 非数组丢弃 */
export function normalizeFailover(value) {
  const raw = value && typeof value === 'object' ? value : {}
  return { reports: Array.isArray(raw.reports) ? raw.reports : [] }
}

/**
 * daemon 启动时确保上报令牌存在（幂等）：监控系统拿它证明「故障是我报的」，
 * 否则任何能碰到端口的人都能把供给全打成故障。生成一次、落盘、之后不变。
 */
export function ensureFailoverToken() {
  return mutate((db) => {
    if (typeof db.settings.failoverToken === 'string' && db.settings.failoverToken) {
      return db.settings.failoverToken
    }
    db.settings.failoverToken = `fv_${randomUUID().replace(/-/g, '')}`
    return db.settings.failoverToken
  })
}

/**
 * 落一条故障上报（mutate 回调里用）。
 *
 * offerId 与 modelKey 二选一：**给了 offerId 就是供给级**，modelKey 不再落盘。
 * 只用 modelKey 才是模型级（「这个型号本身坏了，哪家接都一样」）。
 * 为什么要强制：以前两个都存，于是一条供给的故障会命中同型号所有供给，
 * 别家明明健康也被一起拉黑——同级换站能力白丢，自动路由被迫跳去另一个模型。
 *
 * @returns {object} 落盘后的记录（含 id / until），调用方据此触发重选
 */
export function addFaultReport(failover, { offerId, modelKey, providerId = null, kind = 'runtime', message = '', holdMs = FAULT_HOLD_MS } = {}) {
  const raw = normalizeFailover(failover)
  const hold = Number.isFinite(Number(holdMs)) ? Math.min(Math.max(Number(holdMs), 60_000), 24 * 60 * 60_000) : FAULT_HOLD_MS
  const offer = typeof offerId === 'string' && offerId ? offerId : null
  const model = offer ? null : (typeof modelKey === 'string' && modelKey ? modelKey : null)
  const record = {
    id: `f_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    // 供给级 / 模型级二选一：定位越精确越优先，宁可少拉黑不可多拉黑
    offerId: offer,
    modelKey: model,
    // 模型级上报带上报时的站，faultMatcher 就只在该站内匹配——
    // 知道是哪家的病，不该株连 4~5 个健康站（见 faultMatcher 的注释）。
    // 只有在「明确说这是型号本身的问题」时才传 null，那才允许跨站。
    providerId: model ? (typeof providerId === 'string' && providerId ? providerId : null) : null,
    kind: String(kind || 'runtime'),
    message: String(message || ''),
    source: 'external-monitor',
    reportedAt: new Date().toISOString(),
    // 保持期到点自动失效——「过了一段时间判断故障可能解除」就是这一个时间戳
    until: Date.now() + hold,
    status: 'active',
  }
  raw.reports.push(record)
  // 只留最近的历史：故障转移看的是「现在有没有活跃上报」，陈年旧账没有读者
  if (raw.reports.length > MAX_FAULT_REPORTS) raw.reports.splice(0, raw.reports.length - MAX_FAULT_REPORTS)
  failover.reports = raw.reports
  return record
}

/** 活跃上报：until 未到（「故障可能解除」之前）的全部记录 */
export function activeReports(failover, now = Date.now()) {
  return normalizeFailover(failover).reports.filter((r) => r.status === 'active' && Number(r.until) > now)
}

/**
 * 供给是否被故障上报命中（唯一判定，路由 / 自动路由 / 决策快照共用）。
 *
 * 两级定位：
 *   offerId  —— 供给级，精确命中一条。
 *   modelKey —— 模型级。**但必须带上报时的 providerId 才能跨站**，见下。
 *
 * ## 为什么 modelKey 不能无条件通配
 *
 * 旧实现是 `r.modelKey && r.modelKey === offer.modelKey`——一条只带 modelKey 的
 * 上报会命中**所有站**的同款模型。本机实测影响面：
 *
 *     deepseek-v4.1-flash  → 5 个站 / 11 条供给
 *     gpt-6-astra          → 4 个站
 *     gpt-6.1-sol / terra  → 各 4 个站
 *     claude-* 系列        → 各 4 个站
 *
 * 于是一个站的模型问题会被放大成全平台问题（用户的原话是「全站都崩溃了」），
 * 而别的站明明健康——同级换站能力白丢。
 *
 * 现在的口径：带了 providerId 就只在该站内匹配；没带才按真·模型级通配
 * （外部监控明确说「这个型号本身坏了，哪家接都一样」时才这么报）。
 */
export function faultMatcher(failover, now = Date.now()) {
  const active = activeReports(failover, now)
  return (offer) =>
    active.some((r) => {
      if (r.offerId) return r.offerId === offer.id
      if (!r.modelKey) return false
      if (r.modelKey !== (offer.modelKey || offer.upstreamName)) return false
      // 有 providerId 就锁在站内：知道是哪家的病，就别株连别家
      if (r.providerId) return r.providerId === offer.providerId
      return true
    })
}

/**
 * 到期收尾（mutate 回调里用）：把过了保持期的 active 记录标成 expired。
 * 只改状态不删行——历史要能回答「它之前出过什么事」。
 */
export function expireFaultReports(failover, now = Date.now()) {
  const raw = normalizeFailover(failover)
  let changed = 0
  for (const r of raw.reports) {
    if (r.status === 'active' && Number(r.until) <= now) {
      r.status = 'expired'
      changed += 1
    }
  }
  if (changed > 0) failover.reports = raw.reports
  return changed
}

/**
 * 人工解除：监控系统说故障修好了，不必等保持期走完。
 */
export function clearFaultReports(failover, { id, offerId, modelKey } = {}) {
  const raw = normalizeFailover(failover)
  const now = Date.now()
  for (const r of raw.reports) {
    if (r.status !== 'active') continue
    if (id ? r.id === id : (offerId && r.offerId === offerId) || (modelKey && r.modelKey === modelKey)) {
      r.status = 'cleared'
      r.until = now
    }
  }
  failover.reports = raw.reports
}
