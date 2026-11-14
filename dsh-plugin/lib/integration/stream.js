/**
 * D 棒 · `llm/stream` 只读用量观察（waterfall tee，移植自朋友版 lib/index.js 的 stream tee）。
 *
 * 本机 dsh-llm 的 `llm/stream` 是 **waterfall**（dsh-llm/lib/index.js：
 * `this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(...))`）。
 * 不拥有决策的 listener 必须 **调用 next() 并原样续流**，否则会吞掉整条流。
 *
 * 硬规则（热路径）：
 *  - 逐块 `yield` 下一层产物，不缓冲整流、不改 chunk；
 *  - 拿 usage/首字延迟只做内存累加，`ingest.record()` 是 fire-and-forget 旁路队列，
 *    **绝不 await 网络/磁盘**；
 *  - 只在 finally 里登记（无论正常收尾还是异常中断都记账），失败吞掉不上抛。
 */

/**
 * 注册一个 llm/stream waterfall listener。返回 disposer。
 * @param {{ctx:any, streamStats:any, ingest:any, log?:(...a:any[])=>void}} deps
 */
export function registerStreamObserver({ ctx, streamStats, ingest, log = () => {} }) {
  const listener = async function* llmStreamTee(options, next) {
    const sessionId = options && options.sessionId ? String(options.sessionId) : ''
    const model = options && options.model ? String(options.model) : ''
    const provider = options && options.provider ? String(options.provider) : ''
    const startedAt = Date.now()
    let ttftMs = null
    let usage = null
    let finish = null
    try {
      for await (const chunk of next()) {
        if (ttftMs === null && chunk && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')) {
          ttftMs = Date.now() - startedAt
        }
        if (chunk && chunk.type === 'usage') usage = chunk.usage
        else if (chunk && chunk.type === 'finish') finish = chunk.reason
        yield chunk
      }
    } finally {
      if (usage) {
        const tokens = typeof usage.totalTokens === 'number'
          ? usage.totalTokens
          : (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0)
        try {
          if (streamStats) streamStats.record(sessionId, { tokens, model })
        } catch { /* ignore */ }
        try {
          if (ingest) {
            ingest.record({
              provider,
              model,
              usage,
              latencyMs: Date.now() - startedAt,
              ttftMs,
              ok: !(finish && finish.kind === 'error'),
            })
          }
        } catch { /* 旁路记账失败不影响对话 */ }
        log(`stream usage session=${sessionId || '-'} provider=${provider || '-'} model=${model || '-'} in=${usage.inputTokens ?? 0} out=${usage.outputTokens ?? 0} finish=${finish && finish.kind ? finish.kind : '-'}`)
      }
    }
  }

  const dispose = ctx.on('llm/stream', listener)
  return () => { try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ } }
}
