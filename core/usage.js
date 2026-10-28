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
    // 缓存写入（站点按 cache_creation 单独计费，通常是输入价的 1.25 倍）。
    // 之前完全没记，这部分花费一直按 0 算——累计能到几万 token
    cacheCreation: 0,
    // 思考 token（reasoning）：已经含在 output 里，单独存一份是为了看清「钱花在思考上了」
    reasoning: 0,
    // 1 = 这一行的 input 里包含缓存（老数据）；新记录 input 是净值，不写这个字段
    inputIncludesCached: 0,
    latencySum: 0,
    latencyCount: 0,
    ttftSum: 0,
    ttftCount: 0,
    // 生成窗口（总耗时 − 首字）与这段时间产出的 output：两者相除才是真实的
    // token/秒。只累加「流式且有首字」的请求——非流式没有首字，把整段耗时
    // 当生成窗口会把速度算低一半以上。
    genSum: 0,
    genOutput: 0,
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
 *          outputTokens?:number, cachedTokens?:number, cacheCreationTokens?:number,
 *          reasoningTokens?:number, latencyMs?:number, ttftMs?:number,
 *          ok?:boolean, ts?:string}} entry
 *
 * inputTokens 是**净值**（已扣掉缓存读/写）：上游字段名与净值换算全部收在
 * core/wire.js 的 usageNumbers()，这里不再做减法。
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
  const output = Number(entry.outputTokens) || 0
  row.input += Math.max(0, Number(entry.inputTokens) || 0)
  row.output += output
  row.cached += Number(entry.cachedTokens) || 0
  // 这两个字段是后加的，老行没有 → 先兜底再累加
  row.cacheCreation = (row.cacheCreation || 0) + (Number(entry.cacheCreationTokens) || 0)
  row.reasoning = (row.reasoning || 0) + (Number(entry.reasoningTokens) || 0)
  if (Number.isFinite(entry.latencyMs)) {
    row.latencySum += entry.latencyMs
    row.latencyCount += 1
  }
  if (Number.isFinite(entry.ttftMs)) {
    row.ttftSum += entry.ttftMs
    row.ttftCount += 1
  }
  // 生成速度只算「流式（有首字）且真有输出」的请求，见 emptyRow 的 genSum 注释
  if (
    Number.isFinite(entry.ttftMs) &&
    Number.isFinite(entry.latencyMs) &&
    output > 0 &&
    entry.latencyMs > entry.ttftMs
  ) {
    row.genSum = (row.genSum || 0) + (entry.latencyMs - entry.ttftMs)
    row.genOutput = (row.genOutput || 0) + output
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
  // 这里曾经漏了 cacheCreation：明细行有值、汇总恒为 0，页面上的「缓存写入」
  // 永远是 0，花费也一直少算这一项。后加的字段一律 || 0 兜底（老行没有它们）
  target.cacheCreation += row.cacheCreation || 0
  target.reasoning = (target.reasoning || 0) + (row.reasoning || 0)
  target.latencySum += row.latencySum
  target.latencyCount += row.latencyCount
  target.ttftSum += row.ttftSum
  target.ttftCount += row.ttftCount
  target.genSum = (target.genSum || 0) + (row.genSum || 0)
  target.genOutput = (target.genOutput || 0) + (row.genOutput || 0)
}

function finalize(row) {
  const billedInput = (row.input || 0) + (row.cached || 0) + (row.cacheCreation || 0)
  // 生成速度的分母（总耗时 − 首字）从这一版才开始累加，老行没有。
  // 补法：流式请求占全部时（ttftCount === latencyCount，非流式没有首字）
  // 总耗时减首字就是生成窗口，算出来是准确的；混合行补不出来，宁可显示「—」。
  // 这是**读时**换算，不改 usage.json，老数据也能立刻看到速度。
  const allStreamed =
    (row.ttftCount || 0) > 0 && row.ttftCount === row.latencyCount
  const genSum =
    (row.genSum || 0) > 0
      ? row.genSum
      : allStreamed
        ? Math.max(0, (row.latencySum || 0) - (row.ttftSum || 0))
        : 0
  const genOutput = (row.genOutput || 0) > 0 ? row.genOutput : genSum > 0 ? row.output || 0 : 0
  return {
    ...row,
    avgLatencyMs: row.latencyCount ? Math.round(row.latencySum / row.latencyCount) : null,
    avgTtftMs: row.ttftCount ? Math.round(row.ttftSum / row.ttftCount) : null,
    // 命中率分母是「输入 + 缓存读 + 缓存写」，与 core/wire.js 的 usageNumbers 同口径
    cacheHitRate: billedInput > 0 ? row.cached / billedInput : null,
    // 真实生成速度：只统计有首字的流式请求（见 emptyRow 的 genSum 注释）
    avgTps: genSum > 0 ? Math.round((genOutput / (genSum / 1000)) * 10) / 10 : null,
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
