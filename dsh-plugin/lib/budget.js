/**
 * 预算与用量判定（host 半边，纯内存）。
 *
 * ## 为什么不落盘
 *
 * 预算只是「本会话/今日已经花掉多少」的判定，数据源有两处：本进程的 `llm/stream` 累加器
 * （会话维度）和 daemon 的 `usage.totals`（全渠道日维度）。两者都各自持久化过，
 * 插件再存一份只会制造三方不一致，所以这里只做投影，重启即归零。
 *
 * ## 为什么熔断放在工具守卫上
 *
 * DSH 的模型请求由宿主直接发出，插件在 `llm/stream` 上只能旁观（tee），拦不住已经发出的
 * 请求。真正能「勒住」的是 `tools.guard`：超预算后拒绝一切工具调用，agent 就只能收尾、
 * 不能继续扩大动作面。配合系统提示词里那段预算状态，模型能自己停止试探。
 */

const ZERO_SESSION = Object.freeze({ tokens: 0, calls: 0, over: false, ratio: 0 })

/** 紧凑数字：1192909879 → 11.9亿。预算文案是给模型和用户读的，量级比精确值重要。 */
function compact(value) {
  const n = Number(value) || 0
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)}万`
  return String(Math.round(n))
}

/**
 * @param {{
 *   config: { budget?: { sessionTokens?: number, dailyTokens?: number } },
 *   streamStats: Map<string, { tokens: number, calls: number, lastAt: number, model: string }>,
 *   log: (...args: any[]) => void,
 * }} deps
 */
export function createBudget({ config, streamStats, log }) {
  const limits = {
    sessionTokens: Math.max(0, Math.round(Number(config?.budget?.sessionTokens) || 0)),
    dailyTokens: Math.max(0, Math.round(Number(config?.budget?.dailyTokens) || 0)),
  }

  /** 今日全渠道用量（由 daemon usage.totals 投影，30 秒刷一次）。 */
  let daily = { tokens: 0, requests: 0, errors: 0, over: false, at: 0, error: '', source: 'unknown' }

  function sessionOf(sessionId) {
    const row = sessionId ? streamStats.get(sessionId) : null
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

  /** 从 daemon 的 usage.totals 更新日维度（tokens = 输入 + 输出）。 */
  function absorbUsage(totals) {
    const t = totals || {}
    const n = (v) => Math.max(0, Math.round(Number(v) || 0))
    // 只算「输入 + 输出」：daemon 的 totals.input 本身可能已含缓存读，再加 cached 会翻倍
    const tokens = n(t.input) + n(t.output)
    daily = {
      tokens,
      requests: n(t.requests),
      errors: n(t.errors),
      limit: limits.dailyTokens,
      over: limits.dailyTokens > 0 && tokens >= limits.dailyTokens,
      at: Date.now(),
      error: '',
      source: 'daemon',
    }
    if (!totals) daily.source = 'empty'
    return daily
  }

  function noteError(message) {
    daily = { ...daily, error: String(message || ''), source: daily.source === 'unknown' ? 'unavailable' : daily.source }
  }

  /** 快照：面板、工具、提示词上下文共用一份视图。 */
  function snapshot(sessionId) {
    const session = sessionOf(sessionId)
    return {
      limits,
      session,
      daily,
      over: session.over || daily.over,
      configured: limits.sessionTokens > 0 || limits.dailyTokens > 0,
    }
  }

  /** 一行文字（提示词上下文用；控制在 160 字符内，别把每一步的 token 都吃掉）。 */
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

  /** 熔断判定（同步、无 IO：工具守卫里每步都会调）。 */
  function denyReason(sessionId) {
    const snap = snapshot(sessionId)
    if (limits.sessionTokens > 0 && snap.session.over) {
      return `ManageAPI 会话预算已用完（${snap.session.tokens}/${limits.sessionTokens} token）。停止调用工具，向用户说明并等待提高预算。`
    }
    if (limits.dailyTokens > 0 && snap.daily.over) {
      return `ManageAPI 每日预算已用完（${snap.daily.tokens}/${limits.dailyTokens} token）。停止调用工具，向用户说明并等待明日或提高预算。`
    }
    return undefined
  }

  return { limits, absorbUsage, noteError, snapshot, describe, denyReason, sessionOf }
}
