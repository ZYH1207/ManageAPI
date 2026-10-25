/**
 * 监控数据层：余额快照、倍率变动、公告、告警。
 *
 * 职责边界：这里只做「本地数据加工」——把一次采集结果并进 db.monitor、
 * 和上一次快照 diff 出变动、按冷却生成告警、组装页面要的视图。
 * 真正发网络请求的地方在 daemon/monitor-runner.js。
 *
 * 为什么不放在 db.json 顶层各开一个数组：它们全是「只追加 + 截断」的时序数据，
 * 语义和站点/供给完全不同，混在一起会让主文件读起来更乱。放在 monitor 下，
 * 将来要独立成文件也很容易。
 */

import { offerCost } from './pricing.js'
import { ensureFx } from './fx.js'
// localDayKey 与 usage.js 同一份（usage 不回头 import 本文件，无循环）：
// 花费曲线要拿这里的日键去 join usage 的天桶，两边必须同一口径——
// 此前这里用 UTC 键，东八区每天凌晨 8 小时的用量对不上号
import { localDayKey } from './usage.js'

/** 各类时序数据的保留上限。按「每站每小时一个点」算，4000 点≈5 个站 1 个月。 */
const KEEP = {
  balance: 4000,
  rates: 800,
  announcements: 300,
  alerts: 300,
  runs: 40,
}

/** 同一个（站点 × 告警类型）在这个窗口内只报一次。 */
const ALERT_COOLDOWN_MS = 6 * 3600 * 1000

let seq = 0
function nextId(prefix) {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`
}

export function defaultMonitor() {
  return {
    balance: [],
    rates: [],
    announcements: [],
    alerts: [],
    // 上一次采集到的分组倍率/模型价，用来 diff；首次采集只记不发
    snapshot: {},
    // 告警冷却水位：`<providerId>:<code>` → 毫秒时间戳
    cooldowns: {},
    // 最近几次采集的结果，用于「上次采集 N 分钟前 / 失败原因」
    runs: [],
    lastRunAt: null,
  }
}

/** 老数据没有 monitor 字段时补齐，避免各处判空。 */
export function ensureMonitor(db) {
  const base = defaultMonitor()
  const current = db.monitor && typeof db.monitor === 'object' ? db.monitor : {}
  const merged = { ...base, ...current }
  for (const key of Object.keys(base)) {
    if (merged[key] === undefined || merged[key] === null) merged[key] = base[key]
  }
  db.monitor = merged
  return merged
}

function trim(list, max) {
  if (!Array.isArray(list)) return []
  if (list.length <= max) return list
  list.splice(0, list.length - max)
  return list
}

function toMap(list, keyOf) {
  const map = {}
  for (const item of list || []) {
    if (!item) continue
    const key = keyOf(item)
    if (key === null || key === undefined || key === '') continue
    map[key] = item
  }
  return map
}

/**
 * 余额阈值：设置里统一存美元（`balanceWarnUsd`），站点余额可能是人民币，换算后再比。
 * 老配置只有 `balanceWarnCny`，按汇率折一次即可（迁移在 store.migrate 里做）。
 */
function lowBalanceThreshold(settings, currency) {
  const rawUsd = Number(settings.balanceWarnUsd ?? settings.balanceWarnCny)
  const thresholdUsd = Number.isFinite(rawUsd) && rawUsd >= 0 ? rawUsd : 10
  if (thresholdUsd === 0) return null
  if (String(currency || 'USD').toUpperCase() === 'CNY') {
    // 汇率真源在 fx 模块，别读兼容镜像
    const fx = Number(ensureFx(settings).rates.CNY) || 7.2
    return thresholdUsd * fx
  }
  return thresholdUsd
}

function pushAlert(m, { providerId, code, level = 'warn', title, detail = '', at, cooldownMs = ALERT_COOLDOWN_MS }) {
  const now = new Date(at).getTime()
  const key = `${providerId || '-'}:${code}`
  if (cooldownMs > 0 && m.cooldowns[key] && now - m.cooldowns[key] < cooldownMs) return null
  m.cooldowns[key] = now
  const alert = {
    id: nextId('alert'),
    providerId: providerId || null,
    code,
    level,
    title,
    detail,
    at,
    readAt: null,
  }
  m.alerts.push(alert)
  trim(m.alerts, KEEP.alerts)
  return alert
}

/**
 * 把一次采集结果并进监控数据。
 *
 * @param {object} db 会被就地修改
 * @param {{providerId:string, at?:string, balance?:object, groups?:Array,
 *          models?:Array, announcements?:Array, error?:string}} snap
 * @returns {{changes:Array, newAnnouncements:Array, alerts:Array}}
 */
export function applySnapshot(db, snap) {
  const m = ensureMonitor(db)
  const settings = db.settings || {}
  const at = snap.at || new Date().toISOString()
  const providerId = snap.providerId
  const changes = []
  const addedAlerts = []

  // ---------------------------------------------------------------- 余额
  const balance = snap.balance
  if (balance && balance.ok && Number.isFinite(balance.remaining)) {
    m.balance.push({
      providerId,
      at,
      balance: balance.remaining,
      currency: balance.currency || 'CNY',
    })
    trim(m.balance, KEEP.balance)

    const threshold = lowBalanceThreshold(settings, balance.currency)
    if (threshold !== null && balance.remaining <= threshold) {
      const level = balance.remaining <= 0 ? 'danger' : 'warn'
      const alert = pushAlert(m, {
        providerId,
        code: balance.remaining <= 0 ? 'balance_depleted' : 'balance_low',
        level,
        title:
          balance.remaining <= 0
            ? `余额已用尽（${balance.currency || 'CNY'} ${balance.remaining}）`
            : `余额低于阈值（剩 ${balance.currency || 'CNY'} ${balance.remaining}，阈值 ${Math.round(threshold * 100) / 100}）`,
        at,
        cooldownMs: 12 * 3600 * 1000,
      })
      if (alert) addedAlerts.push(alert)
    }
  } else if (balance && !balance.ok && balance.reason) {
    const alert = pushAlert(m, {
      providerId,
      code: 'balance_failed',
      level: 'info',
      title: '余额读取失败',
      detail: balance.reason,
      at,
      cooldownMs: 24 * 3600 * 1000,
    })
    if (alert) addedAlerts.push(alert)
  }

  // ------------------------------------------------------------ 倍率 / 价格
  const prev = m.snapshot[providerId]
  const firstTime = !prev || !prev.at
  const nextGroups = toMap(snap.groups, (g) => (g && typeof g.rate === 'number' ? g.name : null))
  const nextModels = toMap(snap.models, (mo) => (mo && mo.name ? mo.name : null))

  const record = (kind, key, from, to) => {
    changes.push({ providerId, kind, key, at, from, to })
  }

  if (!firstTime) {
    const prevGroups = prev.groups || {}
    for (const [name, group] of Object.entries(nextGroups)) {
      const was = prevGroups[name]
      if (!was) continue
      if (typeof was.rate === 'number' && was.rate !== group.rate) {
        record('group', name, was.rate, group.rate)
      }
    }

    const prevModels = prev.models || {}
    for (const [name, model] of Object.entries(nextModels)) {
      const was = prevModels[name]
      if (!was) continue
      if (typeof was.inPrice === 'number' && typeof model.inPrice === 'number' && was.inPrice !== model.inPrice) {
        record('model-in', name, was.inPrice, model.inPrice)
      }
      if (
        typeof was.outPrice === 'number' &&
        typeof model.outPrice === 'number' &&
        was.outPrice !== model.outPrice
      ) {
        record('model-out', name, was.outPrice, model.outPrice)
      }
    }
  }

  if (snap.groups || snap.models) {
    m.snapshot[providerId] = {
      at,
      groups: nextGroups,
      models: nextModels,
      modelCount: Object.keys(nextModels).length,
    }
  }

  if (changes.length > 0) {
    m.rates.push(...changes)
    trim(m.rates, KEEP.rates)
    const alert = pushAlert(m, {
      providerId,
      code: 'rate_changed',
      level: 'warn',
      title: `检测到 ${changes.length} 项倍率/价格变动`,
      detail: changes
        .slice(0, 4)
        .map((c) => `${c.key} ${c.from} → ${c.to}`)
        .join('；'),
      at,
      cooldownMs: 30 * 60 * 1000,
    })
    if (alert) addedAlerts.push(alert)
  }

  // ---------------------------------------------------------------- 公告
  const newAnnouncements = []
  if (Array.isArray(snap.announcements) && snap.announcements.length > 0) {
    const seen = new Set(
      m.announcements.filter((a) => a.providerId === providerId).map((a) => a.sourceKey),
    )
    for (const item of snap.announcements) {
      if (!item || !item.sourceKey || seen.has(item.sourceKey)) continue
      seen.add(item.sourceKey)
      const row = {
        id: nextId('ann'),
        providerId,
        sourceKey: item.sourceKey,
        title: item.title || '未命名公告',
        content: item.content || '',
        publishedAt: item.publishedAt || at,
        seenAt: at,
        readAt: null,
      }
      m.announcements.push(row)
      newAnnouncements.push(row)
    }
    trim(m.announcements, KEEP.announcements)
  }

  // ---------------------------------------------------------------- 采集失败
  if (snap.error) {
    const alert = pushAlert(m, {
      providerId,
      code: 'collect_failed',
      level: 'danger',
      title: '采集失败',
      detail: String(snap.error).slice(0, 300),
      at,
      cooldownMs: 2 * 3600 * 1000,
    })
    if (alert) addedAlerts.push(alert)
  }

  return { changes, newAnnouncements, alerts: addedAlerts }
}

/** 记一次采集（成功或失败都记），供页面显示「上次采集」与失败原因。 */
export function recordRun(db, { providerId, at, ok, ms, error = '' }) {
  const m = ensureMonitor(db)
  m.runs.push({ providerId, at, ok: Boolean(ok), ms: Number(ms) || 0, error: error ? String(error).slice(0, 300) : '' })
  trim(m.runs, KEEP.runs)
  m.lastRunAt = at
  // 冷却水位只留 7 天，否则会无限增长
  const cutoff = Date.now() - 7 * 86400000
  for (const [key, ts] of Object.entries(m.cooldowns)) {
    if (Number(ts) < cutoff) delete m.cooldowns[key]
  }
  return m
}

/** 点「全部已读」或勾选若干条。 */
export function markAlertsRead(db, ids) {
  const m = ensureMonitor(db)
  const at = new Date().toISOString()
  const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null
  let count = 0
  for (const alert of m.alerts) {
    if (alert.readAt) continue
    if (wanted && !wanted.has(alert.id)) continue
    alert.readAt = at
    count += 1
  }
  return count
}

export function markAnnouncementsRead(db, ids) {
  const m = ensureMonitor(db)
  const at = new Date().toISOString()
  const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null
  let count = 0
  for (const item of m.announcements) {
    if (item.readAt) continue
    if (wanted && !wanted.has(item.id)) continue
    item.readAt = at
    count += 1
  }
  return count
}

function recentDays(count, now = new Date()) {
  const days = []
  // 按本地日迭代而不是毫秒减法：毫秒减法在夏令时时区会产生重复/缺失的日键
  for (let i = count - 1; i >= 0; i -= 1) {
    days.push(localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)))
  }
  return days
}

/**
 * 每天取「当天最后一笔余额」求和，得到总余额曲线。
 * 某个站某天没有点时沿用上一个已知值（余额不会因为没采集就归零）。
 *
 * 美元站按汇率折成人民币再相加——不折算的话「$5 + ¥10」这种加法在图上没有意义。
 */
function buildBalanceSeries(m, days, settings = {}) {
  const fx = Number(ensureFx(settings).rates.CNY) || 7.2
  const byProvider = new Map()
  for (const point of m.balance) {
    if (!byProvider.has(point.providerId)) byProvider.set(point.providerId, [])
    byProvider.get(point.providerId).push(point)
  }
  for (const list of byProvider.values()) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)))
  }

  return days.map((day) => {
    // 本地日的末尾（转 UTC ISO 再与 point.at 比较），与本地日键配套；
    // 此前拼的 T23:59:59.999Z 是 UTC 日界，东八区每天会多吞 8 小时的点
    const [y, mo, d] = day.split('-').map(Number)
    const endOfDay = new Date(y, mo - 1, d, 23, 59, 59, 999).toISOString()
    let total = 0
    let counted = 0
    const perProvider = {}
    for (const [providerId, list] of byProvider) {
      let last = null
      for (const point of list) {
        if (String(point.at) <= endOfDay) last = point
        else break
      }
      if (!last) continue
      perProvider[providerId] = last.balance
      const isUsd = String(last.currency || 'CNY').toUpperCase() === 'USD'
      total += isUsd ? last.balance * fx : last.balance
      counted += 1
    }
    return {
      day,
      total: counted > 0 ? Math.round(total * 100) / 100 : null,
      perProvider,
    }
  })
}

/**
 * 按「用量 × 当前价」估算每天花了多少钱。
 * 这不是站点口径的账单（那需要登录态），是「用今天的量按今天的价算」，
 * 用来画趋势、判断量级足够。
 */
function buildSpendSeries(usageData, offers, settings, benchmarks, days) {
  const byKey = new Map()
  for (const offer of offers) byKey.set(`${offer.providerId}|${offer.modelKey || offer.upstreamName}`, offer)

  const dayMap = new Map(days.map((day) => [day, 0]))
  for (const [day, bucket] of Object.entries(usageData?.days || {})) {
    if (!dayMap.has(day)) continue
    let sum = 0
    for (const [composite, row] of Object.entries(bucket || {})) {
      const [, providerId, model] = composite.split('|')
      const offer = byKey.get(`${providerId}|${model}`)
      if (!offer) continue
      const cost = offerCost(offer, settings, benchmarks)
      // 按次计费：花费 = 请求数 × 每次单价（token 数不参与）
      if (cost.perCall) {
        if (typeof cost.callPriceCny === 'number') sum += (row.requests || 0) * cost.callPriceCny
        continue
      }
      if (typeof cost.inCnyPerMtok === 'number') sum += ((row.input || 0) / 1e6) * cost.inCnyPerMtok
      if (typeof cost.outCnyPerMtok === 'number') sum += ((row.output || 0) / 1e6) * cost.outCnyPerMtok
    }
    dayMap.set(day, Math.round(sum * 10000) / 10000)
  }

  return days.map((day) => ({ day, cny: dayMap.get(day) ?? 0 }))
}

/**
 * 组装监控页需要的全部数据。
 *
 * @param {object} db
 * @param {{usageData?:object, days?:number}} options
 */
export function buildMonitorView(db, { usageData = null, benchmarks = {}, days = 7 } = {}) {
  const m = ensureMonitor(db)
  const settings = db.settings || {}
  const range = recentDays(days)
  const rangeSet = new Set(range)

  const providers = (db.providers || []).map((p) => ({ id: p.id, name: p.name, kind: p.kind || null }))
  const providerIndex = new Map(providers.map((p) => [p.id, p]))
  const nameOf = (id) => providerIndex.get(id)?.name || '未知站点'

  // 每个站最新一条余额
  const latest = new Map()
  for (const point of m.balance) {
    const prev = latest.get(point.providerId)
    if (!prev || String(point.at) > String(prev.at)) latest.set(point.providerId, point)
  }

  const balanceByProvider = providers
    .map((p) => {
      const point = latest.get(p.id)
      return {
        providerId: p.id,
        name: p.name,
        currency: point?.currency || null,
        balance: point ? point.balance : null,
        at: point?.at || null,
        threshold: lowBalanceThreshold(settings, point?.currency || 'CNY'),
        groups: (m.snapshot[p.id]?.groups
          ? Object.values(m.snapshot[p.id].groups).map((g) => ({ name: g.name, rate: g.rate }))
          : []
        ).sort((a, b) => a.name.localeCompare(b.name)),
        modelCount: m.snapshot[p.id]?.modelCount ?? null,
        snapshotAt: m.snapshot[p.id]?.at || null,
      }
    })
    .sort((a, b) => {
      const av = a.balance === null ? Infinity : a.balance
      const bv = b.balance === null ? Infinity : b.balance
      return av - bv
    })

  const withBalance = balanceByProvider.filter((row) => row.balance !== null)
  const lowest = withBalance[0] || null

  const changes = m.rates
    .slice(-60)
    .reverse()
    .map((row) => ({
      ...row,
      providerName: nameOf(row.providerId),
      pct:
        typeof row.from === 'number' && row.from !== 0 && typeof row.to === 'number'
          ? Math.round(((row.to - row.from) / row.from) * 1000) / 10
          : null,
    }))

  const announcements = m.announcements
    .slice(-60)
    .reverse()
    .map((row) => ({ ...row, providerName: nameOf(row.providerId) }))

  const alerts = m.alerts
    .slice(-60)
    .reverse()
    .map((row) => ({ ...row, providerName: nameOf(row.providerId) }))

  const unread = m.alerts.filter((a) => !a.readAt).length
  const unreadAnnouncements = m.announcements.filter((a) => !a.readAt).length
  const dayAgo = Date.now() - 86400000
  const changes24h = m.rates.filter((row) => new Date(row.at).getTime() >= dayAgo).length

  return {
    days: range,
    providers,
    kpi: {
      providerCount: providers.length,
      withBalance: withBalance.length,
      lowest: lowest
        ? { name: lowest.name, balance: lowest.balance, currency: lowest.currency }
        : null,
      rateChanges24h: changes24h,
      unreadAlerts: unread,
      unreadAnnouncements,
      lastRunAt: m.lastRunAt,
    },
    balanceSeries: buildBalanceSeries(m, range, settings),
    spendSeries: usageData ? buildSpendSeries(usageData, db.offers || [], settings, benchmarks, range) : [],
    balanceByProvider,
    changes,
    announcements,
    alerts,
    runs: m.runs.slice(-10).reverse().map((run) => ({ ...run, providerName: nameOf(run.providerId) })),
    settings: {
      monitorIntervalMinutes: Number(settings.monitorIntervalMinutes) || 0,
      // 阈值口径统一是美元；老字段留着给还没迁移的前端兜底
      balanceWarnUsd: Number(settings.balanceWarnUsd ?? settings.balanceWarnCny) || 0,
      balanceWarnCny: Number(settings.balanceWarnCny) || 0,
    },
  }
}
