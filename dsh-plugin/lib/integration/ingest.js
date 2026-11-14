/**
 * D 棒 · 真实用量回写（移植自朋友版 lib/ingest.js，适配 C 棒的 /api/ingest/usage）。
 *
 * DSH 会话不一定总走 ManageAPI 网关：用户可能在模型选择器里换到别的渠道，那部分钱
 * 在 ManageAPI 界面里本来看不到。`llm/stream` 上本来就能看到 usage，这里把**非 ManageAPI**
 * 渠道的真实用量异步推给 daemon 记账（POST /api/ingest/usage，C 棒已授权）。
 *
 * 硬规则：
 *  - 只做旁路记账：串行、吞错、fire-and-forget，绝不 await 到 `llm/stream` 热路径；
 *  - 跳过 provider === 'manage-api' / 'manage-api/*'（网关自己已记一次，daemon 侧再兜一层）；
 *  - daemon 未 attached/owned 时跳过（没地方记账）；
 *  - 无 input/output token 直接丢。
 */

/**
 * @param {{client:{postIngest:(p:object)=>Promise<any>}, enabled?:boolean, getMode:()=>string, log?:(...a:any[])=>void, onRecorded?:(payload:object)=>void}} deps
 */
export function createIngest({ client, enabled = true, getMode, log = () => {}, onRecorded } = {}) {
  const stats = { pushed: 0, skipped: 0, failed: 0, lastError: '', enabled }
  let chain = Promise.resolve()
  let loggedOnce = false

  const numberOrUndefined = (value) => {
    const n = Number(value)
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined
  }

  /** 记一次真实调用。调用方（llm/stream tee）只负责交数据，不等待结果。 */
  function record(call) {
    if (!enabled) return
    const provider = String(call?.provider || '').trim()
    const model = String(call?.model || '').trim()
    if (!provider || !model) return
    if (provider === 'manage-api' || provider.startsWith('manage-api/')) {
      stats.skipped += 1
      return
    }
    const mode = typeof getMode === 'function' ? getMode() : 'down'
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
      cachedTokens: numberOrUndefined(usage.cacheReadTokens ?? usage.cachedTokens),
      cacheCreationTokens: numberOrUndefined(usage.cacheWriteTokens ?? usage.cacheCreationTokens),
      latencyMs: numberOrUndefined(call.latencyMs),
      ttftMs: numberOrUndefined(call.ttftMs),
      ok: call.ok !== false,
      ts: new Date().toISOString(),
    }
    if (!payload.inputTokens && !payload.outputTokens) return

    chain = chain
      .then(async () => {
        const result = await client.postIngest(payload)
        if (result && result.ok) {
          stats.pushed += 1
          stats.lastError = ''
          try { if (typeof onRecorded === 'function') onRecorded({ payload, result }) } catch { /* ignore */ }
        } else {
          stats.failed += 1
          stats.lastError = String((result && result.error) || 'unknown')
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
