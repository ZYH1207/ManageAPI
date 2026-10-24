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
 * 本地日期键（YYYY-MM-DD）。「今天/本月」按用户所在时区算，与签到账本
 * (platforms/ledger.js 的 localDayKey) 同一口径；此前用 UTC 日，东八区用户
 * 每天早上 8 点前的用量都记在「昨天」、月底 8 小时记错月。旧数据里的 UTC
 * 键不迁移，自然老化——只是图表边界略歪，聚合数字不变。
 */
export function localDayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 本地月份月初的日期键（月度 Key 限额用，同样按本地时区归属月份）。 */
export function localMonthStart(date = new Date()) {
  return `${localDayKey(date).slice(0, 7)}-01`
}

function todayKey(iso) {
  return localDayKey(iso ? new Date(iso) : new Date())
}

/**
 * 记一次请求。写入串行化，避免并发请求互相覆盖。
 * @param {{keyId:string, providerId:string, model:string, inputTokens?:number,
 *          outputTokens?:number, cachedTokens?:number, latencyMs?:number,
 *          ttftMs?:number, ok?:boolean, ts?:string}} entry
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
  row.input += Number(entry.inputTokens) || 0
  row.output += Number(entry.outputTokens) || 0
  row.cached += Number(entry.cachedTokens) || 0
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
      // 复合键是 keyId|providerId|model，model 排最后——模型名里含 | 时
      // 剩余段重新 join 才能还原（前两段是内部生成的 id，不会含 |）
      const [keyId, providerId, ...modelParts] = composite.split('|')
      const model = modelParts.join('|')
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

/** 清空统计（界面上的「重置用量」）。 */
export async function resetUsage() {
  cache = { version: 1, days: {} }
  writeChain = writeChain.then(flush).catch(() => {})
  return writeChain
}
