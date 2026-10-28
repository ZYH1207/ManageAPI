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
export function detailRows(
  entries = [],
  { days = 7, limit = 500, now = Date.now(), sinceMs: clearedMs = null } = {},
) {
  const windowMs = now - Math.max(1, days) * DAY_MS
  // 清空水位线：清空前发生、日志里还留着的那些请求不再算进明细。
  // 不这么做的话，汇总（usage.json）已经归零、明细（决策日志）照旧列一大片，
  // 弹窗上下两个数字必然对不上。
  const floorMs = Number.isFinite(clearedMs) ? Math.max(windowMs, clearedMs) : windowMs
  const rows = []
  let clearedDropped = 0
  for (const entry of entries) {
    const row = detailRow(entry)
    if (!row || row.tsMs < windowMs) continue
    if (row.tsMs < floorMs) {
      clearedDropped += 1
      continue
    }
    rows.push(row)
  }
  rows.sort((a, b) => b.tsMs - a.tsMs)

  const shown = rows.slice(0, Math.max(0, limit))
  return {
    rows: shown,
    // 被清空水位线挡掉的条数（界面要能解释「日志里看着有 500 条，为什么这里更少」）
    clearedDropped,
    // 区间内一共有多少条明细（可能多于 shown）
    available: rows.length,
    shown: shown.length,
    capped: rows.length > shown.length,
    // 有请求但上游没回 usage：汇总里的 token 数不含它们，界面要能解释差额
    missingUsage: shown.filter((row) => row.prompt === null).length,
  }
}

/**
 * 在**全量聚合桶**上按条件求和（筛选小计的唯一来源）。
 *
 * 为什么不从明细行算：明细来自日志/账本，条数有上限（日志 500 条、账本按天封顶），
 * 拿它求和出来的「小计」和上面那份全量汇总必然对不上——这正是「上面 20 条、
 * 下面 182 条」的来历。改成在全量桶上过滤，小计永远等于「这段时间真的花了多少」。
 *
 * @param {Array} buckets usageSummary 返回的 buckets（{keyId,providerId,group,model,row}）
 * @param {{providerId?:string, group?:{providerId:string,name:string}|null, model?:string}} filter
 */
export function sumBuckets(buckets = [], filter = {}) {
  const totals = {
    requests: 0,
    errors: 0,
    input: 0,
    output: 0,
    cached: 0,
    cacheCreation: 0,
    reasoning: 0,
    latencySum: 0,
    latencyCount: 0,
    ttftSum: 0,
    ttftCount: 0,
    genSum: 0,
    genOutput: 0,
  }
  for (const bucket of buckets) {
    if (filter.providerId && bucket.providerId !== filter.providerId) continue
    if (
      filter.group &&
      (bucket.providerId !== filter.group.providerId || (bucket.group || '') !== filter.group.name)
    ) {
      continue
    }
    if (filter.model && bucket.model !== filter.model) continue

    const row = bucket.row || {}
    totals.requests += row.requests || 0
    totals.errors += row.errors || 0
    totals.input += row.input || 0
    totals.output += row.output || 0
    totals.cached += row.cached || 0
    totals.cacheCreation += row.cacheCreation || 0
    totals.reasoning += row.reasoning || 0
    totals.latencySum += row.latencySum || 0
    totals.latencyCount += row.latencyCount || 0
    totals.ttftSum += row.ttftSum || 0
    totals.ttftCount += row.ttftCount || 0
    totals.genSum += row.genSum || 0
    totals.genOutput += row.genOutput || 0
  }

  const billedInput = totals.input + totals.cached + totals.cacheCreation
  const genSum = totals.genSum > 0 ? totals.genSum : 0
  return {
    ...totals,
    avgLatencyMs: totals.latencyCount ? Math.round(totals.latencySum / totals.latencyCount) : null,
    avgTtftMs: totals.ttftCount ? Math.round(totals.ttftSum / totals.ttftCount) : null,
    cacheHitRate: billedInput > 0 ? totals.cached / billedInput : null,
    avgTps: genSum > 0 ? Math.round((totals.genOutput / (genSum / 1000)) * 10) / 10 : null,
  }
}

/**
 * 三列筛选的下拉选项（站点 / 分组 / 模型），带各自在区间内的请求条数。
 * 数据来自全量聚合桶，所以「秋（120 次请求）」是这段时间的真实条数，
 * 不是明细窗口里剩几条。逐级收窄的口径和界面上一致：
 * 选了站点，分组和模型只列这个站有的；再选分组，模型只列这个分组里的。
 */
export function facetOptions(buckets = [], filter = {}) {
  const providers = new Map()
  const groups = new Map()
  const models = new Map()

  const add = (map, key, seed, requests) => {
    const item = map.get(key) || { ...seed, requests: 0 }
    item.requests += requests
    map.set(key, item)
  }

  for (const bucket of buckets) {
    const requests = bucket.row?.requests || 0
    if (bucket.providerId) {
      add(
        providers,
        bucket.providerId,
        { id: bucket.providerId, name: bucket.providerName || bucket.providerId },
        requests,
      )
    }
    // 分组只列「当前已选站点」的
    if (!filter.providerId || bucket.providerId === filter.providerId) {
      add(
        groups,
        `${bucket.providerId}\u0001${bucket.group || ''}`,
        { providerId: bucket.providerId, name: bucket.group || '' },
        requests,
      )
    }
    // 模型只列「当前已选站点 + 分组」里的
    const groupOk =
      !filter.group ||
      (bucket.providerId === filter.group.providerId && (bucket.group || '') === filter.group.name)
    const providerOk = !filter.providerId || bucket.providerId === filter.providerId
    if (providerOk && groupOk) add(models, bucket.model, { name: bucket.model }, requests)
  }

  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'zh')
  return {
    providers: [...providers.values()].sort(byName),
    groups: [...groups.values()].sort(byName),
    models: [...models.values()].sort(byName),
  }
}
