/**
 * 用量统计：按天 × Key × 站点 × 模型 聚合。
 *
 * 独立于 db.json 存（usage.json），因为它是唯一会持续增长的数据，
 * 混在主文件里会让每次写配置都变慢。
 *
 * 聚合而非明细：个人用量一天几百次请求，按维度聚合后文件一年也就几十 KB。
 */
import { join } from 'node:path'
import { readFile, mkdir } from 'node:fs/promises'
import { dataDir } from './store.js'
import { writeJsonAtomic } from './fsx.js'
// 本地日期键的唯一实现在 dates.js；这里 re-export 供既有调用方（monitor.js 等）继续使用
import { localDayKey, localMonthStart } from './dates.js'
export { localDayKey, localMonthStart }

let cache = null
let writeChain = Promise.resolve()

function filePath() {
  return join(dataDir(), 'usage.json')
}

function emptyRow() {
  return {
    requests: 0,
    errors: 0,
    input: 0,
    output: 0,
    cached: 0,
    // 缓存写入（站点按 cache_creation 单独计费，通常是输入价的 1.25 倍）。
    // 之前完全没记，这部分花费一直按 0 算——累计能到几万 token
    cacheCreation: 0,
    // 1 = 这一行的 input 里包含缓存（老数据）；新记录 input 是净值，不写这个字段
    inputIncludesCached: 0,
    latencySum: 0,
    latencyCount: 0,
    ttftSum: 0,
    ttftCount: 0,
  }
}

export async function readUsage() {
  if (cache) return cache
  try {
    const raw = JSON.parse(await readFile(filePath(), 'utf8'))
    cache = { version: 1, days: raw?.days && typeof raw.days === 'object' ? raw.days : {} }
  } catch {
    cache = { version: 1, days: {} }
  }
  return cache
}

async function flush() {
  const data = await readUsage()
  await mkdir(dataDir(), { recursive: true })
  await writeJsonAtomic(filePath(), data)
}

/**
 * 解析用量复合键 `keyId|providerId|model`。
 * model 排最后且模型名本身可能含 `|`——前两段是内部生成的 id（不含 |），
 * 剩余段重新 join 才能还原。usage 汇总、监控花费、用量核对三处共用这一份。
 */
export function parseUsageComposite(composite) {
  const [keyId, providerId, ...modelParts] = String(composite).split('|')
  return { keyId, providerId, model: modelParts.join('|') }
}

function todayKey(iso) {
  return localDayKey(iso ? new Date(iso) : new Date())
}

/**
 * 记一次请求。写入串行化，避免并发请求互相覆盖。
 * @param {{keyId:string, providerId:string, model:string, inputTokens?:number,
 *          outputTokens?:number, cachedTokens?:number, cacheCreationTokens?:number,
 *          latencyMs?:number, ttftMs?:number, ok?:boolean, ts?:string}} entry
 */
export async function recordUsage(entry) {
  const data = await readUsage()
  const day = todayKey(entry.ts)
  if (!data.days[day]) data.days[day] = {}
  const bucket = data.days[day]
  const composite = `${entry.keyId || '-'}|${entry.providerId || '-'}|${entry.model || '-'}`
  const row = bucket[composite] || emptyRow()

  row.requests += 1
  if (entry.ok === false) row.errors += 1
  // input 存**净值**（不含缓存读/写）：站点计费把「新读」「命中缓存」「写入缓存」
  // 当成三个独立项，混在一个字段里再做减法还原，边界一定会漂。
  // 老数据没有 inputIncludesCached 标记，花费算法仍按「input 含缓存」还原
  const rawInput = Number(entry.inputTokens) || 0
  const cached = Number(entry.cachedTokens) || 0
  const cacheCreation = Number(entry.cacheCreationTokens) || 0
  row.input += Math.max(0, rawInput - cached - cacheCreation)
  row.output += Number(entry.outputTokens) || 0
  row.cached += cached
  row.cacheCreation += cacheCreation
  if (Number.isFinite(entry.latencyMs)) {
    row.latencySum += entry.latencyMs
    row.latencyCount += 1
  }
  if (Number.isFinite(entry.ttftMs)) {
    row.ttftSum += entry.ttftMs
    row.ttftCount += 1
  }
  bucket[composite] = row

  writeChain = writeChain.then(flush).catch(() => {})
  return writeChain
}

/** 最近 n 天的日期键（本地日），从旧到新。 */
function recentDays(count) {
  const days = []
  const now = new Date()
  for (let i = count - 1; i >= 0; i -= 1) {
    days.push(localDayKey(new Date(now.getTime() - i * 86400000)))
  }
  return days
}

function addRow(target, row) {
  target.requests += row.requests
  target.errors += row.errors
  target.input += row.input
  target.output += row.output
  target.cached += row.cached
  // 缓存写入此前漏加：byModel/byDay 等汇总行的 cacheCreation 恒 0，
  // 一旦有展示方读汇总（而不是原始 days）就会少算一笔缓存写费用
  target.cacheCreation += row.cacheCreation || 0
  target.latencySum += row.latencySum
  target.latencyCount += row.latencyCount
  target.ttftSum += row.ttftSum
  target.ttftCount += row.ttftCount
}

function finalize(row) {
  return {
    ...row,
    avgLatencyMs: row.latencyCount ? Math.round(row.latencySum / row.latencyCount) : null,
    avgTtftMs: row.ttftCount ? Math.round(row.ttftSum / row.ttftCount) : null,
  }
}

/**
 * 汇总最近 N 天。返回按天、按 Key、按站点、按模型的四个切面。
 */
export async function usageSummary({ days = 30 } = {}) {
  const data = await readUsage()
  const range = recentDays(days)
  const rangeSet = new Set(range)

  const totals = emptyRow()
  const byKey = {}
  const byProvider = {}
  const byModel = {}
  const byDay = {}

  for (const [day, bucket] of Object.entries(data.days)) {
    if (!rangeSet.has(day)) continue
    const dayTotal = byDay[day] || emptyRow()
    for (const [composite, row] of Object.entries(bucket)) {
      // 复合键 keyId|providerId|model，model 可能含 |——统一走 parseUsageComposite
      const { keyId, providerId, model } = parseUsageComposite(composite)
      addRow(totals, row)
      addRow(dayTotal, row)
      if (!byKey[keyId]) byKey[keyId] = emptyRow()
      addRow(byKey[keyId], row)
      if (!byProvider[providerId]) byProvider[providerId] = emptyRow()
      addRow(byProvider[providerId], row)
      if (!byModel[model]) byModel[model] = emptyRow()
      addRow(byModel[model], row)
    }
    byDay[day] = dayTotal
  }

  const finalizeMap = (map) =>
    Object.fromEntries(Object.entries(map).map(([k, v]) => [k, finalize(v)]))

  return {
    days: range,
    totals: finalize(totals),
    byKey: finalizeMap(byKey),
    byProvider: finalizeMap(byProvider),
    byModel: finalizeMap(byModel),
    byDay: Object.fromEntries(
      range.map((day) => [day, finalize(byDay[day] || emptyRow())]),
    ),
  }
}

/** 某一天某把 Key 已用 token（用于月度限额判断）。 */
export async function tokensUsedByKey(keyId, sinceDay) {
  const data = await readUsage()
  let total = 0
  for (const [day, bucket] of Object.entries(data.days)) {
    if (day < sinceDay) continue
    for (const [composite, row] of Object.entries(bucket)) {
      if (!composite.startsWith(`${keyId}|`)) continue
      total += row.input + row.output
    }
  }
  return total
}
