/**
 * 故障信号：本机诊断系统（探针 / 空回合守卫）向外报告「这家供给现在有问题」的统一出口。
 *
 * 为什么要有这一层：诊断和路由是两件事，不该互相 import。诊断只负责**发现**，
 * 路由只负责**决策**——中间用一条稳定的信号接口隔开，两边各自演化、互不牵连。
 * 自动路由（core/auto-route.js）订阅这个接口，收到信号后按它自己的逻辑处理；
 * 本模块完全不知道自动路由存在，没订阅时也不会报错。
 *
 * ---------------------------------------------------------------- 什么才配发信号
 *
 * 这条规则是用户定的，也是整个模块最重要的部分：**不影响干活就只记录，别打扰路由。**
 *
 *   空回合 → 本地重建成功        → notice（自己修好了，路由不用知道）
 *   空回合 → 补问救回来了        → notice（多花了 5 秒，用户没感觉）
 *   空回合 → 补问也失败/没别家可换 → degraded（这一轮真的废了，路由该知道）
 *   5 分钟内同一个供给空过 ≥3 次  → faulty（连续犯病，明显影响体验，建议避开）
 *   探针判可疑 / 不稳定 / 冷却   → degraded / faulty（见 core/score.js 的口径）
 *   恢复（复检通过 / 后续正常）   → active=false（必须发，否则路由会把站永久拉黑）
 *
 * 三个级别里只有 'notice' 不广播。别的都发给订阅者。
 *
 * ---------------------------------------------------------------- 两种取用方式
 *
 * 推（进程内实时）：subscribeFaults(handler)。空回合守卫 / 复检发现问题的瞬间调。
 * 拉（随时查快照）：activeFaultSignals(db)。自动路由挑优时要按当前故障过滤，
 *   而推送只覆盖「那一瞬间」——重启之后、或者信号早就发过的时候，只能靠拉。
 *   两个都提供是因为缺一个都会出问题：只有推，重启即失忆；只有拉，实时性要靠轮询。
 */
import { activeDetours } from './empty-guard.js'
import { addFaultReport, clearFaultReports, normalizeFailover } from './failover.js'

/** 故障信号的唯一合法级别。notice 只落库不广播（见文件头） */
export const FAULT_LEVELS = ['notice', 'degraded', 'faulty']

/** 窗口期：判断「同一个供给是不是连续犯病」看这么久 */
export const FAULT_WINDOW_MS = 5 * 60_000

/** 同一窗口内空回合到这么多次，就从「这次废了」升级成「这家有问题」 */
export const FAULT_HITS_FOR_FAULTY = 3

/**
 * 信号自己会过期，不需要谁来手动撤销。
 *
 * 为什么必须有：路由按信号避开了某家供给，万一「恢复」那一下信号丢了（进程重启、
 * 兜底路径没走到），没有过期时间的话这家会被永久拉黑，而且没人看得出为什么。
 * 过期比黑名单安全——最坏情况是它多试一次坏站，而不是永远不用好站。
 */
export const FAULT_TTL_MS = {
  degraded: 15 * 60_000,
  faulty: 30 * 60_000,
  notice: 0,
}

/** 保留多少条历史信号：这是排查线索，不是账本 */
export const MAX_FAULT_SIGNALS = 200

// ------------------------------------------------------------------ 订阅

/** 订阅者表。空守卫往外喊，自动路由（或以后任何人）注册进来听 */
const subscribers = new Set()

/**
 * 订阅故障信号。
 *
 * 给自动路由用的约定（两侧唯一需要对齐的东西）：
 *
 *   import { subscribeFaults } from '../core/fault-signal.js'
 *   const off = subscribeFaults((signal) => {
 *     if (signal.active) {
 *       // 这条供给出问题了：signal.level = 'degraded' | 'faulty'
 *       // signal.suggested = 'deprioritize'（这次废了，先别优先）| 'avoid'（连续犯病，避开）
 *       // 用 signal.scope.offerId / providerId / modelKey 定位
 *     } else {
 *       // 已恢复：可以把这条供给放回候选
 *     }
 *   })
 *   off() // 退订
 *
 * 回调抛异常不会影响网关主流程（见 publishFault），所以订阅方可以放心写业务。
 *
 * @param {(signal: object) => void} handler
 * @returns {() => void} 退订函数
 */
export function subscribeFaults(handler) {
  if (typeof handler !== 'function') return () => {}
  subscribers.add(handler)
  return () => subscribers.delete(handler)
}

/** 当前有几个订阅者：界面/日志用来说明「信号有没有人接」 */
export function faultSubscriberCount() {
  return subscribers.size
}

/**
 * 广播一条信号。
 *
 * 订阅者的异常一律吞掉并记日志：诊断是旁路，它的失败不该拖垮正在服务的网关。
 * 这也是「解耦」的实际含义——不是写在注释里，是出错时真的互不影响。
 *
 * @returns {number} 实际送达的订阅者数量
 */
export function publishFault(signal, { logger = console } = {}) {
  if (!signal) return 0
  let delivered = 0
  for (const handler of subscribers) {
    try {
      handler(signal)
      delivered += 1
    } catch (error) {
      logger.warn?.(`[故障信号] 订阅者处理失败：${error?.message || error}`)
    }
  }
  return delivered
}

// ------------------------------------------------------------------ 形状

/** 信号去重键：同一个供给的同一类问题算一条，不堆成一串 */
export function faultKey(signal) {
  const scope = signal?.scope || {}
  const target = scope.offerId || `${scope.providerId || '-'}:${scope.modelKey || '-'}`
  return `${signal?.kind || 'unknown'}::${target}`
}

/**
 * 组装一条信号。字段收敛在一处，避免两边各自拼一份形状。
 *
 * @param {object} input
 *   kind      'empty-turn' | 'integrity' | 'availability' | 'recovered'
 *   level     FAULT_LEVELS 之一；'recovered' 的信号用它传原级别
 *   scope     { providerId, providerName, offerId, modelKey, model }
 *   reason    给人看的一句话
 *   suggested 'none' | 'deprioritize' | 'avoid'
 *   hits      窗口内命中次数
 *   active    true = 新故障，false = 已恢复
 *   detail    附加事实（不会被路由消费，仅供排查）
 */
export function buildFaultSignal({
  kind = 'empty-turn',
  level = 'notice',
  scope = {},
  reason = '',
  suggested = 'none',
  hits = 1,
  active = true,
  detail = {},
  now = Date.now(),
} = {}) {
  const safeLevel = FAULT_LEVELS.includes(level) ? level : 'notice'
  const ttl = FAULT_TTL_MS[safeLevel] || 0
  return {
    id: `fs_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    ts: new Date(now).toISOString(),
    kind: String(kind),
    level: safeLevel,
    active: Boolean(active),
    scope: {
      providerId: scope.providerId ?? null,
      providerName: scope.providerName ?? '',
      offerId: scope.offerId ?? null,
      modelKey: scope.modelKey ?? null,
      model: scope.model ?? '',
    },
    reason: String(reason || ''),
    suggested: ['none', 'deprioritize', 'avoid'].includes(suggested) ? suggested : 'none',
    hits: Math.max(1, Number(hits) || 1),
    // active=false 是「解除」信号，不带过期时间
    expiresAt: active && ttl > 0 ? new Date(now + ttl).toISOString() : null,
    detail: detail && typeof detail === 'object' ? detail : {},
  }
}

/**
 * 判定「这一串空回合该不该升级成故障信号」。
 *
 * 纯函数：只吃事实、只出结论，不碰 db、不广播。这样口径可以单测，
 * 也能被界面拿去解释「为什么刚才没报警」。
 *
 * @param {object} input
 *   hits       窗口内空回合次数（含本次）
 *   recovered  这一轮最后有没有救回来（本地重建或补问成功）
 *   hadFallback 有没有可换别家（false 表示这一轮彻底没救）
 * @returns {{level: string, suggested: string, broadcast: boolean, reason: string}}
 */
export function judgeEmptyFault({ hits = 1, recovered = true, hadFallback = true, windowMinutes = 5 } = {}) {
  // 连续犯病优先：哪怕这次救回来了，5 分钟内已经第 3 次，说明它一直在拖后腿
  if (hits >= FAULT_HITS_FOR_FAULTY) {
    return {
      level: 'faulty',
      suggested: 'avoid',
      broadcast: true,
      reason: `${windowMinutes} 分钟内第 ${hits} 次空回合（工具调用被吞），这家供给明显不稳`,
    }
  }
  // 这一轮彻底废了：客户端直接断了，用户看到的就是「没回应」。
  // 不管有没有别家可换都算 degraded —— 没有别家是运维问题，
  // 但有别家却没救回来，说明这家的问题更严重，更该让路由知道
  if (!recovered) {
    return {
      level: 'degraded',
      suggested: 'deprioritize',
      broadcast: true,
      reason: hadFallback
        ? '空回合且补问也没救回来，这一轮请求彻底失败'
        : '空回合且没有可换的供给，这一轮请求彻底失败',
    }
  }
  // 救回来了：用户没感觉，只记录，不打扰路由
  return {
    level: 'notice',
    suggested: 'none',
    broadcast: false,
    reason: recovered ? '空回合已救回，未影响这次请求' : '空回合已记录',
  }
}

// ------------------------------------------------------------------ 落库

/** 幂等：db 里没有这个键就补上 */
export function ensureFaultSignals(db) {
  if (!Array.isArray(db.faultSignals)) db.faultSignals = []
  return db
}

/** 记一条信号（含 notice）。过期的不清——历史留着排查，查询时按 expiresAt 过滤 */
export function recordFaultSignal(db, signal) {
  ensureFaultSignals(db)
  // 去重：同一 key 已经有生效中的同类信号，就更新它而不是再插一条，
  // 否则一次故障会堆出一串几乎一样的记录，界面和路由都要处理重复
  if (signal.active) {
    const key = faultKey(signal)
    const existing = db.faultSignals.find(
      (row) => row.active && faultKey(row) === key && !isExpired(row),
    )
    if (existing) {
      Object.assign(existing, {
        ...signal,
        id: existing.id,
        // 命中次数累加而不是覆盖：这是「连续犯病」的证据
        hits: Math.max(Number(existing.hits) || 1, Number(signal.hits) || 1),
        detail: { ...(existing.detail || {}), ...(signal.detail || {}) },
      })
      return existing
    }
  }
  db.faultSignals.push(signal)
  if (db.faultSignals.length > MAX_FAULT_SIGNALS) {
    db.faultSignals = db.faultSignals.slice(-MAX_FAULT_SIGNALS)
  }
  return signal
}

/** 一条信号是不是已经过期（notice 永不过期，它是历史） */
export function isExpired(signal, now = Date.now()) {
  if (!signal || signal.active === false) return false
  if (!signal.expiresAt) return false
  const at = Date.parse(signal.expiresAt)
  return Number.isFinite(at) && at <= now
}

/**
 * 当前生效的故障快照（按 offerId 索引）。
 *
 * **自动路由挑优时应该读这个**：推送只覆盖「发生的那一瞬间」，重启之后、
 * 或者信号早就发过的时候，只能靠这份快照。两条路都提供，缺一个都会出问题。
 *
 * @returns {Map<string, object>} key = offerId（没有 offerId 时退化成 providerId）
 */
export function activeFaultSignals(db, now = Date.now()) {
  ensureFaultSignals(db)
  const map = new Map()
  for (const signal of db.faultSignals) {
    if (!signal.active) continue
    if (isExpired(signal, now)) continue
    if (signal.level === 'notice') continue // notice 不是故障，不进路由视野
    const key = signal.scope?.offerId || signal.scope?.providerId
    if (!key) continue
    const existing = map.get(key)
    // 同一供给有多条信号时，取最严重的（faulty > degraded）
    if (!existing || (signal.level === 'faulty' && existing.level !== 'faulty')) {
      map.set(key, signal)
    }
  }
  return map
}

/** 把某个供给上的生效信号标成「已恢复」。复检通过 / 后续正常时调 */
export function clearFaultSignals(db, { offerId = null, providerId = null, now = Date.now() } = {}) {
  ensureFaultSignals(db)
  let cleared = 0
  for (const signal of db.faultSignals) {
    if (!signal.active) continue
    const hit =
      (offerId && signal.scope?.offerId === offerId) ||
      (!offerId && providerId && signal.scope?.providerId === providerId)
    if (!hit) continue
    signal.active = false
    signal.resolvedAt = new Date(now).toISOString()
    cleared += 1
  }
  return cleared
}

/** 概览：几条在生效、几条是历史、有没有人在接信号 */
export function summarizeFaultSignals(db, now = Date.now()) {
  ensureFaultSignals(db)
  const all = db.faultSignals
  // notice 不是故障：它只是「发生过、但没影响你」的留痕，算进「生效中」会让人
  // 以为系统一直在出事。所以这里的 active 只数真正会让路由避让的级别
  const active = all.filter(
    (signal) => signal.active && signal.level !== 'notice' && !isExpired(signal, now),
  )
  return {
    total: all.length,
    active: active.length,
    faulty: active.filter((signal) => signal.level === 'faulty').length,
    degraded: active.filter((signal) => signal.level === 'degraded').length,
    subscribers: faultSubscriberCount(),
    lastAt: all.length > 0 ? all[all.length - 1].ts : null,
  }
}

/**
 * 把「当前改道」并入故障快照。
 *
 * 为什么需要：改道账（empty-guard 的 20 分钟复检那套）和故障信号是同一件事的
 * 两个视角——改道是「我已经动手换了」，故障是「这家现在别用」。自动路由只看
 * 信号的话，会漏掉「某家正被守卫改道」这个事实，于是又把流量派回去。
 * 合成一份，路由就只需要读一个地方。
 */
export function combineWithDetours(db, faults) {
  const merged = new Map(faults || [])
  for (const [offerId, detour] of activeDetours(db)) {
    if (merged.has(offerId)) continue
    merged.set(
      offerId,
      buildFaultSignal({
        kind: 'empty-turn',
        level: 'degraded',
        scope: {
          providerId: detour.providerId,
          providerName: detour.providerName,
          offerId,
          modelKey: detour.modelKey,
          model: detour.model,
        },
        reason: `临时改道中：当前走 ${detour.replacedByProviderName || '别家'}`,
        suggested: 'deprioritize',
        detail: { detour: true, since: detour.since },
      }),
    )
  }
  return merged
}

// ------------------------------------------------------- 接自动路由的接收端

/**
 * 一条故障信号 → 自动路由那边的故障上报（core/failover.js）。
 *
 * 为什么要有这一层：两边各自演化，但**不能各存一份**。
 * core/failover.js 是自动路由和路由排序实际消费的那份账（它决定「排最后、
 * 不进自动路由的最优」），我这边的 faultSignals 是诊断视角的留痕。
 * 信号只是「发现」，故障上报才是「生效」——所以真正让流量挪走的动作在这里。
 *
 * 映射口径：
 *   notice          → 不上报（救回来的事不该改变路由）
 *   degraded        → kind='empty-turn'，保持期用信号自己的 TTL
 *   faulty          → 同上，且 message 带上「连续 N 次」这种可读证据
 *   active=false    → 清除对应上报（恢复必须能立刻放回来，不等保持期）
 *
 * 注意：这里只写 db（在传入的 db 上原地改），落盘由调用方负责——
 * 网关热路径不能在这里做 IO。
 *
 * @returns {object|null} 写入的上报记录（notice / 非活跃信号返回 null）
 */
export function applyFaultToFailover(db, signal, now = Date.now()) {
  if (!db || !signal) return null

  // 恢复信号：按 offerId 优先、退化到 modelKey 清除
  if (signal.active === false) {
    if (!db.failover) db.failover = normalizeFailover(null)
    clearFaultReports(db.failover, {
      offerId: signal.scope?.offerId || undefined,
      modelKey: signal.scope?.modelKey || undefined,
    })
    return null
  }

  // notice 不上报：这是用户定的规矩，救回来的不打扰路由
  if (signal.level === 'notice') return null

  const holdMs = signal.expiresAt ? Math.max(60_000, Date.parse(signal.expiresAt) - now) : undefined
  if (!db.failover) db.failover = normalizeFailover(null)
  return addFaultReport(db.failover, {
    offerId: signal.scope?.offerId || null,
    // 没有 offerId 时（只知道站坏了）用 modelKey 兜底，命中该模型全部供给
    modelKey: signal.scope?.offerId ? null : signal.scope?.modelKey || null,
    kind: signal.kind || 'empty-turn',
    message: signal.reason || '',
    holdMs,
  })
}
