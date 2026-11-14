/**
 * D 棒 · 会话用量累加器（内存，供 budget / tools / commands / 面板读）。
 *
 * `llm/stream` 的 tee 每收到 usage 就 `record()` 一次；这里只做投影，不落盘。
 * 为避免长生命周期进程里 Map 无限增长，超过 MAX_SESSIONS 就淘汰最久未活跃的会话。
 * 每次 record 只会同步改内存，绝不发网络 / 不 await —— 热路径安全。
 */

export const MAX_SESSIONS = 500

export function createStreamStats({ maxSessions = MAX_SESSIONS } = {}) {
  /** @type {Map<string, {tokens:number,calls:number,lastAt:number,model:string}>} */
  const map = new Map()

  function prune() {
    if (map.size <= maxSessions) return
    const ordered = [...map.entries()].sort((a, b) => (a[1].lastAt || 0) - (b[1].lastAt || 0))
    for (let i = 0; i < ordered.length - maxSessions; i += 1) map.delete(ordered[i][0])
  }

  /** 记一次调用的 token/calls；返回累计后的快照行。 */
  function record(sessionId, { tokens = 0, model = '' } = {}) {
    const key = String(sessionId || '')
    const prev = map.get(key) || { tokens: 0, calls: 0, lastAt: 0, model }
    const next = {
      tokens: prev.tokens + (Number(tokens) || 0),
      calls: prev.calls + 1,
      lastAt: Date.now(),
      model: model || prev.model || '',
    }
    map.set(key, next)
    prune()
    return next
  }

  /** 前 limit 个最近活跃会话。 */
  function sessions(limit = 5) {
    return [...map.entries()]
      .map(([sessionId, row]) => ({ sessionId, ...row }))
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
      .slice(0, Math.max(0, limit))
  }

  function totals() {
    let tokens = 0
    let calls = 0
    for (const row of map.values()) {
      tokens += row.tokens || 0
      calls += row.calls || 0
    }
    return { sessions: map.size, tokens, calls }
  }

  return { record, sessions, totals, get: (id) => map.get(String(id || '')) || null, map, size: () => map.size }
}
