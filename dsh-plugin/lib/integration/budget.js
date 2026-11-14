/**
 * D 棒 · 预算与用量判定（纯内存，移植自朋友版 lib/budget.js 并适配当前工程）。
 *
 * ## 口径
 * 预算只是「本会话 / 今日已花多少」的投影，数据源两处：
 *   1) 本进程 `llm/stream` 累加器（会话维度，stream-stats.js）
 *   2) daemon `usage.totals`（全渠道日维度，定期 absorb）
 * 两者都已各自持久化，插件不再落盘，重启即归零。
 *
 * ## 它不是 token 级熔断
 * DSH 的模型请求由宿主直接发出，插件在 `llm/stream` 上只是旁观者（tee），
 * 拦不住已经发出的请求。真正能勒住的是 `tools.guard`：超预算后拒绝一切工具调用，
 * agent 只能收尾、不能再扩大动作面。**本 guard 不是「阻止模型请求」，只是工具守卫。**
 */

const ZERO_SESSION = Object.freeze({ tokens: 0, calls: 0, over: false, ratio: 0 })

/** 紧凑数字：1192909879 → 11.9亿。预算文案量级比精确值重要。 */
export function compact(value) {
  const n = Number(value) || 0
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)}万`
  return String(Math.round(n))
}

/**
 * @param {{budget?:{sessionTokens?:number, dailyTokens?:number}, streamStats:Map<string,{tokens:number,calls:number,lastAt:number,model:string}>, log?:(...a:any[])=>void}} deps
 */
export function createBudget({ budget, streamStats, log = () => {} } = {}) {
  const limits = {
    sessionTokens: Math.max(0, Math.round(Number(budget?.sessionTokens) || 0)),
    dailyTokens: Math.max(0, Math.round(Number(budget?.dailyTokens) || 0)),
  }

  /** 今日全渠道用量（由 daemon usage.totals 投影）。 */
  let daily = { tokens: 0, requests: 0, errors: 0, over: false, at: 0, error: '', source: 'unknown' }

  function sessionOf(sessionId) {
    const row = sessionId && streamStats ? streamStats.get(sessionId) : null
    if (!row) return ZERO_SESSION
    const tokens = Math.max(0, Math.round(Number(row.tokens) || 0))
    const limit = limits.sessionTokens
    return {
      tokens,
      calls: Math.max(0, Math.round(Number(row.calls) || 0)),
      over: limit > 0 && tokens >= limit,
      ratio: limit > 0 ? tokens / limit : 0,
    }
  }

  /** 从 daemon usage.totals 更新日维度（tokens = 输入 + 输出，不重复加缓存读）。 */
  function absorbUsage(totals) {
    const t = totals || {}
    const n = (v) => Math.max(0, Math.round(Number(v) || 0))
    const tokens = n(t.input) + n(t.output)
    daily = {
      tokens,
      requests: n(t.requests),
      errors: n(t.errors),
      limit: limits.dailyTokens,
      over: limits.dailyTokens > 0 && tokens >= limits.dailyTokens,
      at: Date.now(),
      error: '',
      source: totals ? 'daemon' : 'empty',
    }
    return daily
  }

  function noteError(message) {
    daily = { ...daily, error: String(message || ''), source: daily.source === 'unknown' ? 'unavailable' : daily.source }
  }

  /** 面板 / 工具 / 提示词上下文共用一份视图。 */
  function snapshot(sessionId) {
    const session = sessionOf(sessionId)
    return {
      limits,
      session,
      daily,
      over: session.over || daily.over,
      configured: limits.sessionTokens > 0 || limits.dailyTokens > 0,
      note: '工具调用守卫（tools.guard），不是模型请求/token 级熔断',
    }
  }

  /** 一行文字（提示词上下文用，控制在 160 字符内）。 */
  function describe(sessionId) {
    const snap = snapshot(sessionId)
    const parts = []
    if (limits.sessionTokens > 0) {
      parts.push(`本会话 ${compact(snap.session.tokens)}/${compact(limits.sessionTokens)} token${snap.session.over ? '（已超预算）' : ''}`)
    } else if (snap.session.tokens > 0) {
      parts.push(`本会话 ${compact(snap.session.tokens)} token`)
    }
    if (limits.dailyTokens > 0) {
      parts.push(`今日全渠道 ${compact(snap.daily.tokens)}/${compact(limits.dailyTokens)} token${snap.daily.over ? '（已超预算）' : ''}`)
    } else if (snap.daily.tokens > 0) {
      parts.push(`今日全渠道 ${compact(snap.daily.tokens)} token / ${snap.daily.requests} 次`)
    }
    return parts.join('；')
  }

  /**
   * 熔断判定（同步、无 IO：工具守卫每步都调）。
   * 文案必须明确这是工具守卫，不是阻止模型请求。
   */
  function denyReason(sessionId) {
    const snap = snapshot(sessionId)
    if (limits.sessionTokens > 0 && snap.session.over) {
      return `ManageAPI 会话预算已用完（${snap.session.tokens}/${limits.sessionTokens} token）：工具调用守卫已拒绝后续工具调用，模型只能收尾。这不是 token 级熔断（模型请求由宿主直发，拦不住）。请向用户说明并等待提高预算。`
    }
    if (limits.dailyTokens > 0 && snap.daily.over) {
      return `ManageAPI 每日预算已用完（${snap.daily.tokens}/${limits.dailyTokens} token）：工具调用守卫已拒绝后续工具调用，模型只能收尾。这不是 token 级熔断（模型请求由宿主直发，拦不住）。请向用户说明并等待明日或提高预算。`
    }
    return undefined
  }

  return { limits, absorbUsage, noteError, snapshot, describe, denyReason, sessionOf }
}
