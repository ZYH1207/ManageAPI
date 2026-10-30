/**
 * 真实用量回写（host 半边）。
 *
 * ## 为什么要有
 *
 * DSH 会话不一定总走 ManageAPI 网关：用户随时可能在模型选择器里换到别的渠道，
 * 那部分钱在 ManageAPI 界面里完全不可见。插件在 `llm/stream` 上本来就看得到 usage，
 * 推给 daemon 的 `POST /api/ingest/usage` 后，「今日用量」才能覆盖全部渠道。
 *
 * ## 为什么必须跳过 manage-api
 *
 * 走网关的请求，网关自己已经 `recordUsage` 记过一次；插件再推一遍就是同一笔账记两遍。
 * 这条判据放在 daemon 侧也有一份（双保险），两边任一侧改动都不会造成重复计账。
 *
 * ## 为什么是「串行 + 吞错」
 *
 * 这是旁路记账，不是业务流程：网络抖动、daemon 刚好在重启都不该影响用户的对话。
 * 串行是为了让同一进程内的写入顺序稳定（daemon 侧 usage 写入本来就是串行的），
 * 吞错是为了不产生 unhandledRejection。
 */

import { daemonPost } from './daemon.js'

/**
 * @param {{
 *   port: number,
 *   enabled: boolean,
 *   getMode: () => string,
 *   log: (...args: any[]) => void,
 * }} deps
 */
export function createIngest({ port, enabled, getMode, log }) {
  const stats = { pushed: 0, skipped: 0, failed: 0, lastError: '' }
  let chain = Promise.resolve()
  let loggedOnce = false

  const numberOrUndefined = (value) => {
    const n = Number(value)
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined
  }

  /**
   * 记一次真实调用。调用方（`llm/stream` 的 tee）只负责交数据，不等待结果。
   * @param {{provider?: string, model?: string, usage?: object|null, latencyMs?: number, ttftMs?: number, ok?: boolean}} call
   */
  function record(call) {
    if (!enabled) return
    const provider = String(call?.provider || '').trim()
    const model = String(call?.model || '').trim()
    if (!provider || !model) return
    // 网关自己会记，插件不要再记一遍
    if (provider === 'manage-api' || provider.startsWith('manage-api/')) {
      stats.skipped += 1
      return
    }
    const mode = getMode()
    if (mode !== 'attached' && mode !== 'owned') {
      stats.skipped += 1
      return
    }
    const usage = call.usage || null
    if (!usage) return
    const payload = {
      provider,
      model,
      inputTokens: numberOrUndefined(usage.inputTokens),
      outputTokens: numberOrUndefined(usage.outputTokens),
      cachedTokens: numberOrUndefined(usage.cacheReadTokens),
      cacheCreationTokens: numberOrUndefined(usage.cacheWriteTokens),
      latencyMs: numberOrUndefined(call.latencyMs),
      ttftMs: numberOrUndefined(call.ttftMs),
      ok: call.ok !== false,
      ts: new Date().toISOString(),
    }
    if (!payload.inputTokens && !payload.outputTokens) return

    chain = chain
      .then(async () => {
        const result = await daemonPost(port, '/api/ingest/usage', payload)
        if (result.ok) {
          stats.pushed += 1
          stats.lastError = ''
        } else {
          stats.failed += 1
          stats.lastError = String(result.error || 'unknown')
          if (!loggedOnce) {
            loggedOnce = true
            log(`[ingest] 用量回写失败（后续同类错误不再打印）：${stats.lastError}`)
          }
        }
      })
      .catch((err) => {
        stats.failed += 1
        stats.lastError = String(err && err.message ? err.message : err)
      })
  }

  function snapshot() {
    return { ...stats, enabled, pending: false }
  }

  return { record, snapshot, drain: () => chain }
}
