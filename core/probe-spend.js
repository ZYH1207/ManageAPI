/**
 * 探针花费账本：只统计「探针自己发出去的那几个请求」花了多少钱。
 *
 * 为什么不去读站点账单做差：站点账单是**全站**口径——这半小时里你自己的网关
 * 真实流量、别的客户端、别的设备都在同一个数字里滚。用账单差额记账，等于把
 * 整站的用量算到探针头上，探针那点钱会被真实流量彻底淹没。
 * 所以这里唯一的数来源是**探针请求上游返回的 usage**，乘这条供给自己的价格
 * （走 pricing.js 与 monitor.js 的 usageRowCost，和概览图同一套算法）。
 *
 * 独立文件（probe-spend.json）而不是塞进 usage.json：usage.json 是网关真实
 * 流量的账本，混进去就正好违反上面那条。
 *
 * 只记钱，不记 token 明细——这是账本，不是用量报表。
 */
import { join } from 'node:path'
import { readFile, mkdir } from 'node:fs/promises'
import { dataDir } from './store.js'
import { writeJsonAtomic } from './fsx.js'
import { spendFactorOf } from './monitor.js'

/** 按半小时分桶：前端「每半小时更新一次」看的就是这些桶。 */
export const BUCKET_MS = 30 * 60 * 1000
/** 桶只留 7 天，再老的一次探测没有参考价值，留着只会让文件慢慢变大。 */
export const KEEP_MS = 7 * 24 * 3600 * 1000

let cache = null
let writeChain = Promise.resolve()

function filePath() {
  return join(dataDir(), 'probe-spend.json')
}

function emptyData() {
  return {
    version: 1,
    // 统计起点（上次清除的时间）。清除不是删文件，而是把账本归零并记下新起点
    since: null,
    totals: { cny: 0, probes: 0, requests: 0, unpriced: 0 },
    byProvider: {},
    // 半小时桶：`<桶起始毫秒>` → { cny, probes, requests, byProvider }
    buckets: {},
    updatedAt: null,
  }
}

function emptyTotals() {
  return { cny: 0, probes: 0, requests: 0, unpriced: 0 }
}

function emptyProvider() {
  return { cny: 0, probes: 0, requests: 0, unpriced: 0, lastAt: null }
}

/** 桶起点：向下取整到 30 分钟。 */
export function bucketStart(ms = Date.now()) {
  return Math.floor(ms / BUCKET_MS) * BUCKET_MS
}

function normalize(raw) {
  const base = emptyData()
  if (!raw || typeof raw !== 'object') return base
  const data = {
    version: 1,
    since: typeof raw.since === 'string' ? raw.since : null,
    totals: { ...emptyTotals(), ...(raw.totals && typeof raw.totals === 'object' ? raw.totals : {}) },
    byProvider: raw.byProvider && typeof raw.byProvider === 'object' ? raw.byProvider : {},
    buckets: raw.buckets && typeof raw.buckets === 'object' ? raw.buckets : {},
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  }
  // 老/坏数据里的字段类型不可信，数字一律过一遍
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  for (const key of Object.keys(data.totals)) data.totals[key] = num(data.totals[key])
  for (const [pid, row] of Object.entries(data.byProvider)) {
    data.byProvider[pid] = {
      ...emptyProvider(),
      ...row,
      cny: num(row?.cny),
      probes: num(row?.probes),
      requests: num(row?.requests),
      unpriced: num(row?.unpriced),
    }
  }
  for (const [key, row] of Object.entries(data.buckets)) {
    if (!/^\d+$/.test(key)) {
      delete data.buckets[key]
      continue
    }
    data.buckets[key] = {
      cny: num(row?.cny),
      probes: num(row?.probes),
      requests: num(row?.requests),
      byProvider: row?.byProvider && typeof row.byProvider === 'object' ? row.byProvider : {},
    }
  }
  return data
}

export async function readProbeSpend() {
  if (cache) return cache
  try {
    cache = normalize(JSON.parse(await readFile(filePath(), 'utf8')))
  } catch {
    cache = emptyData()
  }
  return cache
}

async function flush() {
  const data = await readProbeSpend()
  await mkdir(dataDir(), { recursive: true })
  await writeJsonAtomic(filePath(), data)
}

/**
 * 记一次探测的花费。
 *
 * @param {{providerId:string, cny:number, requests:number, priced?:boolean, at?:number}} entry
 *   requests —— 这一轮探测真正发出去并拿到 usage 的请求数（一次探测通常 5 个）
 *   priced   —— 这条供给有没有可用的价格；false 表示「花了 token 但算不出钱」，
 *               会单独计数并在界面上提示，绝不静默当成 0
 */
export async function recordProbeSpend({ providerId, cny, requests = 0, priced = true, at = Date.now() }) {
  const data = await readProbeSpend()
  const amount = Number(cny)
  const money = Number.isFinite(amount) && amount > 0 ? amount : 0
  const reqs = Number(requests) || 0

  if (!data.since) data.since = new Date(at).toISOString()

  data.totals.cny += money
  data.totals.probes += 1
  data.totals.requests += reqs
  if (!priced) data.totals.unpriced += 1

  if (providerId) {
    const row = data.byProvider[providerId] || emptyProvider()
    row.cny += money
    row.probes += 1
    row.requests += reqs
    if (!priced) row.unpriced += 1
    row.lastAt = new Date(at).toISOString()
    data.byProvider[providerId] = row
  }

  const key = String(bucketStart(at))
  const bucket = data.buckets[key] || { cny: 0, probes: 0, requests: 0, byProvider: {} }
  bucket.cny += money
  bucket.probes += 1
  bucket.requests += reqs
  if (providerId) {
    bucket.byProvider[providerId] = (Number(bucket.byProvider[providerId]) || 0) + money
  }
  data.buckets[key] = bucket

  // 裁剪：只留最近 7 天。按写入时机裁，读路径不用再动。
  const floor = bucketStart(at - KEEP_MS)
  for (const key of Object.keys(data.buckets)) {
    if (Number(key) < floor) delete data.buckets[key]
  }

  data.updatedAt = new Date(at).toISOString()
  writeChain = writeChain.then(flush).catch(() => {})
  return writeChain
}

/** 清除统计：账本归零，并把起点重置为现在（界面上「统计自 …起」跟着变）。 */
export async function clearProbeSpend(at = Date.now()) {
  const data = await readProbeSpend()
  const fresh = emptyData()
  fresh.since = new Date(at).toISOString()
  fresh.updatedAt = fresh.since
  Object.assign(data, fresh)
  writeChain = writeChain.then(flush).catch(() => {})
  return writeChain
}

function round6(value) {
  return Math.round((Number(value) || 0) * 1e6) / 1e6
}

/**
 * 页面视图：总花费 + 分站点 + 半小时桶。
 *
 * 两个口径都算好一起给：`cny` 是模型标价算出来的模型消费，`paidCny` 是乘站点
 * 单价之后的实际消费（钱包里真少掉的钱，1:1 充值的站两者相同）。界面只显示
 * paidCny——作者的原话是「我只想看我探针真花了多少钱」——但 cny 留着，方便
 * 和概览页的模型消费口径对账。
 */
export function buildProbeSpendView(data, { providers = [], settings = {}, now = Date.now() } = {}) {
  const providerById = new Map(providers.map((p) => [p.id, p]))
  const totals = data?.totals || emptyTotals()

  const byProvider = Object.entries(data?.byProvider || {})
    .map(([providerId, row]) => {
      const provider = providerById.get(providerId)
      const factor = spendFactorOf(provider, settings)
      return {
        providerId,
        name: provider?.name || '未知站',
        cny: round6(row.cny),
        paidCny: round6(row.cny * factor),
        probes: row.probes || 0,
        requests: row.requests || 0,
        unpriced: row.unpriced || 0,
        lastAt: row.lastAt || null,
      }
    })
    .sort((a, b) => b.cny - a.cny || b.probes - a.probes)

  // 桶按时间升序；只回最近 7 天内的（存储层已经裁过，这里兜一层）
  const floor = bucketStart(now - KEEP_MS)
  const buckets = Object.entries(data?.buckets || {})
    .map(([key, bucket]) => ({ at: Number(key), ...bucket }))
    .filter((bucket) => Number.isFinite(bucket.at) && bucket.at >= floor)
    .sort((a, b) => a.at - b.at)
    .map((bucket) => {
      const split = {}
      let paid = 0
      for (const [pid, value] of Object.entries(bucket.byProvider || {})) {
        split[pid] = round6(value)
        // 桶也带「实际消费」：卡片上的总额、分站、柱子必须是同一个口径，
        // 否则柱子高矮和总金额对不上（用户看的就一个数）
        paid += (Number(value) || 0) * spendFactorOf(providerById.get(pid), settings)
      }
      return {
        at: bucket.at,
        cny: round6(bucket.cny),
        paidCny: round6(paid),
        probes: bucket.probes || 0,
        byProvider: split,
      }
    })

  const factorTotal = byProvider.length
    ? byProvider.reduce((sum, row) => sum + row.paidCny, 0)
    : 0

  return {
    since: data?.since || null,
    updatedAt: data?.updatedAt || null,
    total: {
      cny: round6(totals.cny),
      paidCny: round6(factorTotal),
      probes: totals.probes || 0,
      requests: totals.requests || 0,
      unpriced: totals.unpriced || 0,
    },
    byProvider,
    buckets,
    bucketMs: BUCKET_MS,
    keepMs: KEEP_MS,
  }
}
