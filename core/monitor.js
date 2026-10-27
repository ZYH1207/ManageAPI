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
import { localDayKey, localMonthStart } from './usage.js'

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
    // 站点自己的按天账单：providerId → { 'YYYY-MM-DD': { actualCost, totalCost, requests, at } }
    // 「实际消费」的唯一数据源；读不到账单的站没有这个条目
    siteSpend: {},
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

  // ------------------------------------------------------------ 站点账单
  // 站点自己按天算的账。「实际消费」只认这个——网关侧的 token 估算缺 26%、
  // 上游 cached_tokens 也不可靠，拿它算钱必然对不上。
  // 一次采集可能带回多天（今天覆盖 + 历史回填）
  const spendDays = snap.siteSpendDays
    || (snap.siteSpend && snap.siteSpend.date ? { [String(snap.siteSpend.date).slice(0, 10)]: snap.siteSpend } : null)
  if (spendDays && Object.keys(spendDays).length > 0) {
    if (!m.siteSpend || typeof m.siteSpend !== 'object') m.siteSpend = {}
    if (!m.siteSpend[providerId] || typeof m.siteSpend[providerId] !== 'object') {
      m.siteSpend[providerId] = {}
    }
    for (const [day, spend] of Object.entries(spendDays)) {
      m.siteSpend[providerId][String(day).slice(0, 10)] = {
        actualCost: Number(spend.actualCost) || 0,
        totalCost: Number(spend.totalCost) || 0,
        requests: Number(spend.requests) || 0,
        at,
      }
    }
    // 只留最近 45 天，避免无限增长
    const keys = Object.keys(m.siteSpend[providerId]).sort()
    if (keys.length > 45) {
      for (const old of keys.slice(0, keys.length - 45)) delete m.siteSpend[providerId][old]
    }
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
/**
 * 站点单价：1 个**站点额度单位**值多少人民币（= 充值时实际付的 ÷ 到账额度）。
 *
 * 三级回落：站点自己填的 → 全局默认值（`settings.defaultUnitPrice`，
 * 适合「所有站都是 1:1 充值」这种一刀切的情况）→ null（= 按市场汇率，
 * 即模型消费与实际消费相同，行为与改前完全一致）。
 */
export function siteUnitPrice(provider, settings) {
  const own = Number(provider?.unitPrice)
  if (Number.isFinite(own) && own > 0) return own
  const fallback = Number(settings?.defaultUnitPrice)
  if (Number.isFinite(fallback) && fallback > 0) return fallback
  return null
}

/**
 * 实际消费相对「模型消费」的系数。
 *
 * 注意 **offer.currency 不能用来判断折扣**——那是「我们内部基准价表的币种」
 * （resolveOfferPrice 返回 base.currency），跟站点怎么卖额度无关：实测
 * codexpert / 秋 / 哈利恩 全部标成 CNY，即使它们的余额和计费都是美元。
 *
 * 真正的关系只有一条：「模型消费」里的美元额度是按**市场汇率**折算成人民币的，
 * 而站点实际卖你额度的价格是**站点单价**。所以
 *   实际消费 = 模型消费 × (站点单价 ÷ 市场汇率)
 *   没填单价     → 系数 1.0（两数完全相同，行为与改前一致）
 *   单价 1、市场 6.68 → 系数 0.15（充 1 元得 1 美元，真实花费只有估算的 15%）
 */
export function spendFactorOf(provider, settings) {
  const site = siteUnitPrice(provider, settings)
  if (site === null) return 1
  const fx = Number(ensureFx(settings).rates.CNY)
  const market = Number.isFinite(fx) && fx > 0 ? fx : 7.2
  return site / market
}

/** 按天聚合花费：estimated = 站点口径估算（原逻辑不变），actual = 乘以站点单价 */
function spendByDay(usageData, offers, settings, benchmarks, providerById) {
  const byKey = new Map()
  for (const offer of offers) byKey.set(`${offer.providerId}|${offer.modelKey || offer.upstreamName}`, offer)

  const dayMap = new Map()
  for (const [day, bucket] of Object.entries(usageData?.days || {})) {
    const acc = dayMap.get(day) || { estimated: 0, actual: 0, byProvider: {} }
    for (const [composite, row] of Object.entries(bucket || {})) {
      const [, providerId, model] = composite.split('|')
      const offer = byKey.get(`${providerId}|${model}`)
      if (!offer) continue
      const cost = offerCost(offer, settings, benchmarks)
      let sum = 0
      // 按次计费：花费 = 请求数 × 每次单价（token 数不参与）
      if (cost.perCall) {
        if (typeof cost.callPriceCny === 'number') sum += (row.requests || 0) * cost.callPriceCny
      } else {
        // 缓存命中的 token 单独按缓存价算：usage 里的 input 已经包含 cached，
        // 全按输入价算会把「97% 命中缓存」的用量高估近 10 倍。
        // 站点没公布缓存价时退回输入价（保守，不假装有折扣）
        // 口径兼容：新记录 input 是**净值**（缓存读/写单独存），老记录 input 含缓存。
        // 判据看该行有没有被新代码写过——新代码总会写 inputIncludesCached: 0，
        // 老行没这个字段（undefined）。此前用 ===1 判断，老行会被当净值，重复计费
        const rawInput = Number(row.input) || 0
        const cachedRaw = Number(row.cached) || 0
        const cacheWriteRaw = Number(row.cacheCreation) || 0
        const legacyInput = row.inputIncludesCached === undefined
        const freshIn = legacyInput ? Math.max(0, rawInput - cachedRaw) : rawInput
        const cacheHits = legacyInput ? Math.min(cachedRaw, rawInput) : cachedRaw
        if (typeof cost.inCnyPerMtok === 'number') {
          sum += (freshIn / 1e6) * cost.inCnyPerMtok
          const cachePrice = cost.cacheReadCnyPerMtok ?? cost.inCnyPerMtok
          sum += (cacheHits / 1e6) * cachePrice
        }
        // 缓存写入独立计费（站点按 cache_write 收，通常 1.25× 输入价）
        const cacheWrite = cacheWriteRaw
        if (cacheWrite > 0) {
          const writePrice = cost.cacheWriteCnyPerMtok ?? cost.inCnyPerMtok ?? 0
          sum += (cacheWrite / 1e6) * writePrice
        }
        if (typeof cost.outCnyPerMtok === 'number') sum += ((row.output || 0) / 1e6) * cost.outCnyPerMtok
      }
      if (!sum) continue
      acc.estimated += sum
      // 系数按「这条供给的标价币种」算，不是按站点余额币种
      acc.actual += sum * spendFactorOf(providerById.get(providerId), settings)
      // 按站点拆分：概览图要画「各站花费堆叠柱」和单站视图
      acc.byProvider[providerId] = (acc.byProvider[providerId] || 0) + sum
    }
    dayMap.set(day, acc)
  }
  return dayMap
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}

function buildSpendSeries(dayMap, days) {
  return days.map((day) => {
    const row = dayMap.get(day)
    const byProvider = {}
    for (const [pid, value] of Object.entries(row?.byProvider || {})) {
      byProvider[pid] = round4(value)
    }
    return { day, cny: round4(row?.estimated ?? 0), byProvider }
  })
}

/** 本地周一的日期键（周一为一周开始） */
function localWeekStart(date = new Date()) {
  const d = new Date(date)
  const offset = (d.getDay() + 6) % 7 // 周一=0、周日=6
  d.setDate(d.getDate() - offset)
  return localDayKey(d)
}

/**
 * 今日 / 本周 / 本月花费合计，两种口径并列：
 *   estimated —— 模型消费（站点口径估算，和图表同一份数）
 *   actual    —— 实际消费（乘站点单价，即钱包里少掉的钱）
 */
/**
 * 站点账单口径的花费汇总。
 *
 * **这是「实际消费」的唯一数据源**：站点自己按天算的账，单位是站点货币
 * （多数站是美元，1:1 充值时 1 单位 = ¥1）。网关侧的 token 估算只保留为
 * 「模型消费」参考值，不再用来回答「钱包少了多少钱」。
 *
 * 站点账单累计值是阶梯的（当天已花的钱不会回调），所以「今天」直接取当日，
 * 「本周/本月」按天累加——跨天的记录各自归属自己的那一天。
 */
function buildSiteSpendSummary(m, settings) {
  const fx = Number(ensureFx(settings).rates.CNY) || 7.2
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const monthStart = `${todayKey.slice(0, 7)}-01`
  const weekStartDate = new Date(now)
  weekStartDate.setDate(weekStartDate.getDate() - ((weekStartDate.getDay() + 6) % 7))
  const weekStart = `${weekStartDate.getFullYear()}-${pad(weekStartDate.getMonth() + 1)}-${pad(weekStartDate.getDate())}`

  const byProvider = {}
  const totals = {
    today: { actual: 0, requests: 0, providers: 0 },
    week: { actual: 0, requests: 0, providers: 0 },
    month: { actual: 0, requests: 0, providers: 0 },
  }

  for (const [providerId, days] of Object.entries(m.siteSpend || {})) {
    let today = 0
    let week = 0
    let month = 0
    let todayRequests = 0
    for (const [day, row] of Object.entries(days || {})) {
      const cost = Number(row.actualCost) || 0
      if (day === todayKey) {
        today += cost
        todayRequests += Number(row.requests) || 0
      }
      if (day >= weekStart) week += cost
      if (day >= monthStart) month += cost
    }
    byProvider[providerId] = { today, week, month, todayRequests, days: Object.keys(days || {}).length }
    totals.today.actual += today
    totals.today.requests += todayRequests
    totals.week.actual += week
    totals.month.actual += month
    if (Object.keys(days || {}).length > 0) {
      totals.today.providers += 1
      totals.week.providers += 1
      totals.month.providers += 1
    }
  }

  const round = (v) => Math.round(v * 1e4) / 1e4
  return {
    // 站点账单是站点货币单位；按 1:1 的充值口径，它同时就是人民币近似值。
    // 真正的换算留给前端（站点单价），这里只给原始数值。
    fx,
    byProvider,
    today: { actual: round(totals.today.actual), requests: totals.today.requests, providers: totals.today.providers },
    week: { actual: round(totals.week.actual), providers: totals.week.providers },
    month: { actual: round(totals.month.actual), providers: totals.month.providers },
  }
}

export function buildSpendSummary(dayMap, now = new Date()) {
  const todayKey = localDayKey(now)
  const weekStart = localWeekStart(now)
  const monthStart = localMonthStart(now)
  const sum = (predicate) => {
    let estimated = 0
    let actual = 0
    for (const [day, value] of dayMap) {
      if (!predicate(day)) continue
      estimated += value.estimated
      actual += value.actual
    }
    return { estimated: round4(estimated), actual: round4(actual) }
  }
  return {
    today: sum((day) => day === todayKey),
    week: sum((day) => day >= weekStart),
    month: sum((day) => day >= monthStart),
  }
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

  // 花费按天聚合只算一次：图表要 estimated，KPI 卡要 estimated + actual
  const providerById = new Map((db.providers || []).map((p) => [p.id, p]))
  const spendDays = usageData
    ? spendByDay(usageData, db.offers || [], settings, benchmarks, providerById)
    : null

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
    // 花费：图表用 estimated（站点口径，行为不变）；KPI 卡另外给今日/本周/本月两口径
    spendSeries: spendDays ? buildSpendSeries(spendDays, range) : [],
    spendSummary: buildSpendSummary(spendDays || new Map()),
    // 站点账单口径的花费（今日/本周/本月），以及「哪些站读得到账单」
    siteSpend: buildSiteSpendSummary(m, settings),
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
