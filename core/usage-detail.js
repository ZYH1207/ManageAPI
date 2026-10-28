/**
 * 详细用量：把决策日志（db.routing）里每一条请求摊成一行可读的数字。
 *
 * 为什么读决策日志而不是另存一份明细：
 *   - 决策日志本来就按请求记了首字、总耗时、尝试次数、失败原因和**上游原始 usage**，
 *     这些正是「详细用量」要的东西，再存一份等于同一件事两处真相
 *   - 只在**读**的时候用 usageNumbers() 归一化，历史记录（含改动前写下的）自动
 *     享受新口径，不需要迁移 db.json
 *
 * 边界：
 *   - 决策日志只留最近 500 条（core/inventory.js 的 recordRoutingBatch），更早的
 *     请求只剩 usage.json 里的聚合，翻不出明细——页面必须说清这件事
 *   - 上游没回 usage 的请求（实测约 15%）token 记 null，不是 0：0 和「不知道」
 *     在「这次请求花了多少」这个问题上是两个答案
 */

import { usageNumbers } from './wire.js'

const DAY_MS = 86400000

/**
 * 一条决策日志 → 一行明细。
 *
 * genMs / tps 只对**流式且拿到首字**的请求有意义：非流式没有首字时间点，
 * 用「总耗时」当生成窗口会把速度算得偏低（还混进了排队和网络时间）。
 * 拿不到就留 null，让界面显示「—」，不要编一个数出来。
 */
export function detailRow(entry) {
  const tsMs = Date.parse(entry?.ts)
  if (!Number.isFinite(tsMs)) return null

  const numbers = usageNumbers(entry.usage)
  // 注意 Number(null) === 0：这里必须先把 null / undefined 排掉，否则非流式请求的
  // ttftMs: null 会被当成「0 毫秒首字」，再拿它算出一个假的生成速度
  const asMs = (value) => {
    if (value === null || value === undefined || value === '') return null
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  const latencyMs = asMs(entry.latencyMs)
  const ttftMs = asMs(entry.ttftMs)
  const genMs = ttftMs !== null && latencyMs !== null && latencyMs > ttftMs ? latencyMs - ttftMs : null
  const tps =
    genMs && numbers?.output ? Math.round((numbers.output / (genMs / 1000)) * 10) / 10 : null

  return {
    id: entry.id || null,
    ts: entry.ts,
    tsMs,
    model: entry.model || '',
    keyId: entry.keyId || null,
    keyName: entry.keyName || null,
    providerId: entry.chosenProviderId || null,
    providerName: entry.chosenProviderName || null,
    upstreamModel: entry.upstreamModel || null,
    group: entry.chosenGroup || '',
    pool: entry.pool || null,
    // 老记录没有这两个字段（改动后才写），null 表示「当时没记」，界面不显示
    protocol: entry.protocol || null,
    stream: typeof entry.stream === 'boolean' ? entry.stream : null,
    attempts: Number(entry.attempts) || 1,
    outcome: entry.outcome || 'unknown',
    ttftMs,
    latencyMs,
    genMs,
    // 全部来自 usageNumbers：input 是净值（prompt 去掉缓存读/写）
    prompt: numbers?.prompt ?? null,
    input: numbers?.input ?? null,
    output: numbers?.output ?? null,
    cached: numbers?.cached ?? null,
    cacheCreation: numbers?.cacheCreation ?? null,
    reasoning: numbers?.reasoning ?? null,
    total: numbers?.total ?? null,
    cacheHitRate: numbers?.cacheHitRate ?? null,
    tps,
    // 换站过程：客户端只看得到最后一次结果，这里保留「为什么换了站」
    failures: (entry.failures || []).map((f) => ({
      providerName: f.providerName || '',
      error: f.error || '',
      ms: Number(f.ms) || null,
    })),
  }
}

/**
 * 一批决策日志 → { rows, available, shown, missingUsage, capped }。
 *
 * @param {Array} entries 决策日志（顺序不限）
 * @param {{days?:number, limit?:number, now?:number}} options
 *   days  —— 只要最近几天（按日志自己的 ts 算，与 usage.json 的本地日口径略有
 *            差异，界面上的汇总以 usage.json 为准、明细以这里为准，两边都标了来源）
 *   limit —— 最多返回多少行（决策日志最多 500 条，默认全给）
 */
export function detailRows(entries = [], { days = 7, limit = 500, now = Date.now() } = {}) {
  const sinceMs = now - Math.max(1, days) * DAY_MS
  const rows = []
  for (const entry of entries) {
    const row = detailRow(entry)
    if (!row || row.tsMs < sinceMs) continue
    rows.push(row)
  }
  rows.sort((a, b) => b.tsMs - a.tsMs)

  const shown = rows.slice(0, Math.max(0, limit))
  return {
    rows: shown,
    // 区间内一共有多少条明细（可能多于 shown）
    available: rows.length,
    shown: shown.length,
    capped: rows.length > shown.length,
    // 有请求但上游没回 usage：汇总里的 token 数不含它们，界面要能解释差额
    missingUsage: shown.filter((row) => row.prompt === null).length,
  }
}
