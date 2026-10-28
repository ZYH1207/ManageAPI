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

/** 复合键分隔符：分组名里可能有 | / 空格 / 中文，只有控制字符是安全的 */
const SEP = ''

/**
 * 解析复合键 → { keyId, providerId, group, model }。
 *
 * 老数据（这一版之前）是 `keyId|providerId|model` 三段用 | 拼的，没有分组。
 * 两种格式都要认：老键里没有 SEP，按 | 切三段、分组记 '-'（未知）；新键按 SEP 切。
 * 不做数据迁移——老行自然老化，反正它们本来也没有分组信息。
 */
function parseComposite(composite) {
  if (composite.includes(SEP)) {
    const [keyId, providerId, group, ...modelParts] = composite.split(SEP)
    return { keyId, providerId, group: group || '', model: modelParts.join(SEP) }
  }
  // 老键没有分组信息：用空串（界面显示「未指定分组」），不用 '-' 那种假名字
  const [keyId, providerId, ...modelParts] = composite.split('|')
  return { keyId, providerId, group: '', model: modelParts.join('|') }
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
    cache = {
      version: 1,
      days: raw?.days && typeof raw.days === 'object' ? raw.days : {},
      // 清空水位线（ISO）：见 resetUsage 的注释。老文件没有这个字段 → null
      clearedAt: typeof raw?.clearedAt === 'string' ? raw.clearedAt : null,
    }
  } catch {
    cache = { version: 1, days: {}, clearedAt: null }
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
  // 复合键：keyId、providerId、**分组**、model。分组必须进键——「详细用量」的
  // 小计要能按分组筛，而小计不能从决策日志（只有最近 500 条）里算，
  // 只能从这份全量聚合里算。分隔符用 ：分组名里什么都可能有，除它。
  const composite = [
    entry.keyId || '-',
    entry.providerId || '-',
    entry.group || '',
    entry.model || '-',
  ].join(SEP)
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
/** 本地日期的偏移副本（自定义区间用，按本地时区算，和 localDayKey 同一口径） */
function shiftDay(day, offset) {
  const [y, m, d] = String(day).split('-').map(Number)
  const base = new Date(y, (m || 1) - 1, d || 1)
  base.setDate(base.getDate() + offset)
  return localDayKey(base)
}

/**
 * 区间内的日期键（从旧到新）。
 *
 * 两种指定方式，from/to 优先：
 *   days      —— 最近 N 天（含今天）
 *   from/to   —— 自定义起止日（本地日期键 YYYY-MM-DD，两端都含）。
 *                起止写反了就自动调正，不让调用方各自兜底
 */
function rangeDays({ days, from, to }) {
  if (from && to) {
    let start = String(from).slice(0, 10)
    let end = String(to).slice(0, 10)
    if (start > end) [start, end] = [end, start]
    const out = []
    // 上限 366 天：参数被人手填成十年前时，别把内存撑爆
    for (let i = 0; i < 366; i += 1) {
      out.push(start)
      if (start >= end) break
      start = shiftDay(start, 1)
    }
    return out
  }
  return recentDays(days)
}

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
 *
 * `resolveModel` 用来把「写入时的模型名」映射成模型身份键：同一个模型在不同站
 * 写法不一（deepseek-v4.1-flash / deepseek-4.1-flash）时，用量表里不该出现两行，
 * 否则用户会以为用了两个模型，而合并后的比价/决策只显示一个——数字对不上。
 * 传函数而不是别名表：口径（怎么归一）只由调用方那一份实现决定。
 */
export async function usageSummary({
  days = 30,
  from = null,
  to = null,
  // 调用方传进来的模型名归一函数（身份键合并，见上面的注释）
  resolveModel = null,
} = {}) {
  const data = await readUsage()
  const range = rangeDays({ days, from, to })
  const rangeSet = new Set(range)

  const totals = emptyRow()
  const byKey = {}
  const byProvider = {}
  const byModel = {}
  const byGroup = {}
  const byDay = {}
  // 扁平桶清单：筛选小计要按「站点 + 分组 + 模型」随便组合筛，边际汇总算不出来，
  // 得让调用方在这份全量桶上自己过滤（一天几十个桶，量很小）
  const buckets = []

  for (const [day, bucket] of Object.entries(data.days)) {
    if (!rangeSet.has(day)) continue
    const dayTotal = byDay[day] || emptyRow()
    for (const [composite, row] of Object.entries(bucket)) {
      // 复合键解析收在 parseComposite：新版是 keyIdproviderIdgroupmodel，
      // 老版是 keyId|providerId|model（没有分组信息）——两种都要认，老行自然老化
      const parsed = parseComposite(composite)
      const { keyId, providerId, group } = parsed
      const rawModel = parsed.model
      // 历史行是按写入时的名字存的，归一后合并——老数据也跟着合，不用改写 usage.json
      const model = (resolveModel && resolveModel(rawModel)) || rawModel
      addRow(totals, row)
      addRow(dayTotal, row)
      if (!byKey[keyId]) byKey[keyId] = emptyRow()
      addRow(byKey[keyId], row)
      if (!byProvider[providerId]) byProvider[providerId] = emptyRow()
      addRow(byProvider[providerId], row)
      if (!byModel[model]) byModel[model] = emptyRow()
      addRow(byModel[model], row)
      // 分组只在站点内唯一：键要带 providerId
      if (!byGroup[`${providerId}${SEP}${group}`]) {
        byGroup[`${providerId}${SEP}${group}`] = { ...emptyRow(), providerId, group }
      }
      addRow(byGroup[`${providerId}${SEP}${group}`], row)
      buckets.push({ day, keyId, providerId, group, model, row })
    }
    byDay[day] = dayTotal
  }

  const finalizeMap = (map) =>
    Object.fromEntries(Object.entries(map).map(([k, v]) => [k, finalize(v)]))

  return {
    days: range,
    // 界面要据此说明「统计从什么时候开始算」——尤其清空过之后
    clearedAt: data.clearedAt || null,
    totals: finalize(totals),
    byKey: finalizeMap(byKey),
    byProvider: finalizeMap(byProvider),
    byModel: finalizeMap(byModel),
    byGroup: Object.fromEntries(
      Object.entries(byGroup).map(([k, v]) => [
        k,
        { providerId: v.providerId, group: v.group, ...finalize(v) },
      ]),
    ),
    // 原始桶：筛选小计的唯一来源（见 core/usage-detail.js 的 sumBuckets）
    buckets,
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
      const owner = composite.includes(SEP) ? composite.split(SEP)[0] : composite.split('|')[0]
      if (owner !== keyId) continue
      total += row.input + row.output
    }
  }
  return total
}

/**
 * 清空统计（界面上的「清空统计」）。
 *
 * 除了把汇总归零，还要记一条**清空水位线**（clearedAt）。为什么：
 * 「详细用量」的明细来自决策日志（db.routing），不是 usage.json。只清汇总的话，
 * 弹窗上面写「0 次请求」、下面照样列出清空前的 200 条明细和小计——两个数字当场打架。
 * 日志本身要留着排查用，所以不清它，而是让统计（含明细）一律只认水位线之后的请求。
 */
export async function resetUsage() {
  cache = { version: 1, days: {}, clearedAt: new Date().toISOString() }
  writeChain = writeChain.then(flush).catch(() => {})
  return writeChain
}

/** 统计的清空时间（ISO 字符串）或 null。明细接口要按它过滤，和汇总保持同口径。 */
export async function usageClearedAt() {
  const data = await readUsage()
  return data.clearedAt || null
}
