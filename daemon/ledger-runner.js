/**
 * 站点账单同步：把各站自己的走账清单拉回来落进 db.ledger。
 *
 * 定位是**权威数据源**，不是又一份估算。网关侧算价有三个修不掉的误差
 * （缺 usage 26%、cached_tokens 不稳、缓存读价压根不进比价公式），
 * 站点账单没有这些问题——它自己按分项记账。所以这里的口径是：
 *   有账单 → 用账单；没账单 → 才回落到网关估算。
 *
 * 调度策略与 monitor 的 siteSpend 一致：
 *   - 今天每次采都覆盖（当天累计值在增长）
 *   - 最近 N 天只在缺记录时回填（重拉历史是白花的往返）
 *   - 读不到账单不算失败：站可能没开 usage 接口，或令牌只够读余额
 *
 * 与 monitor 的区别：monitor 只存「当天花了多少钱」这一个数，供余额/告警用；
 * 这里存**逐分组逐模型的分项明细**，供比价、台账校验、真实单价反推用。
 */

import * as store from '../core/store.js'
import * as providers from '../core/providers.js'
import {
  fetchLedgerItems,
  aggregateLedgerItems,
  applyLedgerDay,
  listLedgerDays,
  diffLedgerAgainstOffers,
  cheapestByPaid,
  healResidualPricesFromLedger,
} from '../core/site-ledger.js'

/** 回填最近几天（今天之外）。7 天够覆盖「本周」口径，再多只是徒增往返 */
export const BACKFILL_DAYS = 6

const pad = (n) => String(n).padStart(2, '0')
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * 同步单个站点的账单。
 *
 * @param {object} provider
 * @param {{adminToken?: string, days?: number, force?: boolean, logger?: object}} options
 *   days —— 回填天数（不含今天）；force —— 连历史天也重拉
 * @returns {Promise<{providerId:string, providerName:string, ok:boolean, days?:object,
 *                    error?:string, groupIndexOk?:boolean}>}
 */
export async function syncProviderLedger(
  provider,
  { adminToken = '', days = BACKFILL_DAYS, force = false, healPrices = false, logger = console } = {},
) {
  const result = { providerId: provider.id, providerName: provider.name, ok: false }
  // 折后价残留的自愈结果（账单是全库唯一能确诊它的依据）
  let healResult = null
  if (!provider?.id) {
    result.error = '站点不存在'
    return result
  }
  if (!adminToken) {
    result.error = '没有管理令牌（站点账单接口要它）'
    return result
  }

  // 分组表读不到不算失败：账单明细里只有 group_id，没有名字就没法按分组名比对台账，
  // 但「每个模型真实花多少钱」这件事照样成立
  let groupIndex = new Map()
  let groupIndexOk = false
  try {
    groupIndex = await providers.fetchGroupIndex({ baseUrl: provider.baseUrl, adminToken })
    groupIndexOk = groupIndex.size > 0
  } catch (error) {
    logger.warn?.(`[账单] ${provider.name} 读分组表失败：${error.message}`)
  }

  const io = {
    fetchPage: (page, pageSize, day) =>
      providers.fetchUsagePage({
        baseUrl: provider.baseUrl,
        adminToken,
        page,
        pageSize,
        day,
        // 单页 1000 条实测 2 秒上下，给足余量；慢站翻 6 页也就十几秒
        timeoutMs: 25000,
      }),
  }

  const known = (await store.readDb()).ledger?.[provider.id] || {}
  const today = new Date()
  const targets = []
  // 今天总是重拉（累计值在长）
  targets.push({ day: dayKey(today), offset: 0, force: true })
  for (let i = 1; i <= days; i += 1) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = dayKey(d)
    if (!force && known[key]) continue
    targets.push({ day: key, offset: i, force })
  }

  const synced = {}
  const errors = []
  // 并发拉：逐天串行时 7 天要 7 个往返，慢站会把整轮同步拖到超时
  const settled = await Promise.all(
    targets.map(async ({ day, force: f }) => {
      try {
        const fetched = await fetchLedgerItems(io, { day })
        const rows = aggregateLedgerItems(fetched.items, groupIndex)
        return { day, rows, fetched, force: f }
      } catch (error) {
        return { day, error: error.message || String(error) }
      }
    }),
  )

  const written = await store.mutate((db) => {
    let count = 0
    for (const item of settled) {
      if (item.error) {
        errors.push(`${item.day}: ${item.error}`)
        continue
      }
      const res = applyLedgerDay(db, provider.id, item.day, item.rows, { force: item.force })
      if (res.written) {
        count += 1
        synced[item.day] = {
          rows: item.rows.length,
          requests: item.rows.reduce((s, r) => s + (Number(r.requests) || 0), 0),
          actualCost: Math.round(item.rows.reduce((s, r) => s + (Number(r.actualCost) || 0), 0) * 1e6) / 1e6,
          // 翻到上限还没拉完：这份聚合不完整，界面要能标出来
          truncated: Boolean(item.fetched?.truncated),
        }
      } else {
        synced[item.day] = { rows: item.rows.length, skipped: res.reason }
      }
    }

    // 顺手治「折后价残留」：账单里有站点真实原价，是全库唯一能确诊它的依据。
    // 只在 healPrices=true 时真改；默认只统计，由调用方（用户点按钮）决定。
    //
    // 逐天往下试，任一天确诊到就治——不能只看最新一天：某个分组可能今天
    // 完全没流量（实测 Ultrafast 组就是这样），只看今天会得出「没有残留」的
    // 假阴性。同一条供给被多天同时确诊时只治一次（按 offerId 去重），
    // 避免后一天的账单把前一天的修正再改回去。
    if (settled.some((s) => !s.error && s.rows.length > 0)) {
      const offers = (db.offers || []).filter((o) => o.providerId === provider.id && !o.delistedAt)
      // 新的在前：价格以最近一天为准，旧账只用来补「今天没流量」的漏
      const days = settled
        .filter((s) => !s.error && s.rows.length > 0)
        .sort((a, b) => String(b.day).localeCompare(String(a.day)))
      const seen = new Set()
      const healed = []
      let checked = 0
      for (const d of days) {
        const res = healResidualPricesFromLedger(offers, d.rows, { dryRun: !healPrices })
        checked = Math.max(checked, res.checked)
        for (const h of res.healed) {
          if (seen.has(h.offerId)) continue
          seen.add(h.offerId)
          healed.push({ ...h, day: d.day })
        }
      }
      healResult = { checked, healed }
    }
    return count
  })

  return {
    ...result,
    ok: errors.length < targets.length,
    groupIndexOk,
    written,
    days: synced,
    ...(healResult ? { priceHeal: healResult } : {}),
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  }
}

/**
 * 同步全部「有管理令牌」的站点。串行——每家要打好几个接口，
 * 并发把 6 家全放出去只会互相抢带宽，慢站拖垮整轮。
 *
 * @returns {Promise<{ok:boolean, providers:Array, at:string}>}
 */
export async function syncAllLedgers({ days = BACKFILL_DAYS, force = false, healPrices = false, logger = console } = {}) {
  const db = await store.readDb()
  const out = []
  for (const provider of db.providers || []) {
    let adminToken = ''
    try {
      adminToken = provider.adminToken ? await store.decryptSecret(provider.adminToken) : ''
    } catch {
      adminToken = ''
    }
    if (!adminToken) {
      out.push({ providerId: provider.id, providerName: provider.name, ok: false, error: '没有管理令牌' })
      continue
    }
    try {
      out.push(await syncProviderLedger(provider, { adminToken, days, force, healPrices, logger }))
    } catch (error) {
      out.push({
        providerId: provider.id,
        providerName: provider.name,
        ok: false,
        error: error.message || String(error),
      })
    }
  }
  return { ok: out.some((r) => r.ok), providers: out, at: new Date().toISOString() }
}

/**
 * 给 /api/state 用的账单视图：把 db.ledger 摊平成前端能直接渲染的形状。
 *
 * 三块内容，各答一个问题：
 *   providers —— 每家最近几天花了多少（顶部合计）
 *   rows      —— 逐「站 × 分组 × 模型」的真实单价（比价用，含 paidPerMtok）
 *   drift     —— 账单反推的原价 vs 台账，差在哪（台账校验用）
 *
 * @param {object} db
 * @param {{days?:number}} options
 */
export function buildLedgerView(db, { days = 7 } = {}) {
  const providers = []
  const rows = []
  const drift = []

  for (const provider of db.providers || []) {
    const list = listLedgerDays(db, provider.id, days)
    if (list.length === 0) {
      providers.push({
        providerId: provider.id,
        providerName: provider.name,
        hasLedger: false,
        days: 0,
        todayActual: null,
        weekActual: null,
        lastAt: null,
      })
      continue
    }
    const todayKeyStr = dayKey(new Date())
    let todayActual = 0
    let weekActual = 0
    let tokens = 0
    let requests = 0
    for (const day of list) {
      const cost = Number(day.actualCost) || 0
      if (day.day === todayKeyStr) todayActual += cost
      weekActual += cost
      tokens += Number(day.tokens) || 0
      requests += Number(day.requests) || 0
      for (const r of day.rows || []) {
        rows.push({ ...r, day: day.day, providerId: provider.id, providerName: provider.name })
      }
    }
    providers.push({
      providerId: provider.id,
      providerName: provider.name,
      hasLedger: true,
      days: list.length,
      todayActual: Math.round(todayActual * 1e6) / 1e6,
      weekActual: Math.round(weekActual * 1e6) / 1e6,
      tokens,
      requests,
      lastAt: list[0].at || null,
    })

    // 台账校验：拿最近一天里这个站出现过的分组去比。
    //
    // 2026-11-12 修：原来只用「最新一天」的账单比对，导致当天没流量的分组
    // 全被报成 group-gone（实测 26 条差异里 20 条是这个误报——用户根本没切走
    // 那些分组，只是今天没用）。
    //
    // 改成：用「窗口期内出现过」的分组做存在性判断，但价格/倍率仍取最新一天的。
    // 判定分两条路径：
    //   - 窗口内出现过 → 正常比对价格与倍率
    //   - 窗口内完全没出现 → 不报 group-gone，只标 idle（今天没流量，无法校验）
    const latest = list[0]
    const seenInWindow = new Set()
    for (const day of list) {
      for (const r of day.rows || []) {
        if (r.group) seenInWindow.add(`${r.group}::${r.model}`)
      }
    }
    const offers = (db.offers || []).filter((o) => o.providerId === provider.id && !o.delistedAt)
    const activeRows = list.flatMap((day) => day.rows || [])
    // 同一 (分组,模型) 只留最新一天的那行，避免多天重复命中
    const latestByKey = new Map()
    for (const day of list) {
      for (const r of day.rows || []) {
        const k = `${r.group || ''}::${r.model}`
        if (!latestByKey.has(k)) latestByKey.set(k, r)
      }
    }
    const activeUnique = [...latestByKey.values()]
    for (const d of diffLedgerAgainstOffers(offers, activeUnique)) {
      drift.push({
        ...d,
        providerId: provider.id,
        providerName: provider.name,
        day: latest.day,
      })
    }
  }

  return {
    providers,
    rows,
    drift,
    // 「同模型谁真的便宜」：按真实实付单价排，跨站合并
    cheapest: Object.fromEntries(
      [...cheapestByPaid(rows)].map(([model, list]) => [
        model,
        list.slice(0, 5).map((r) => ({
          providerId: r.providerId,
          providerName: r.providerName,
          group: r.group,
          // 分组名查不到时（站方删过）用「分组#123」兜底，前端不用判空
          groupLabel: r.group ?? (r.groupId !== null ? `分组#${r.groupId}` : '未知分组'),
          groupId: r.groupId,
          rate: r.rate,
          paidPerMtok: r.paidPerMtok,
          effIn: r.effIn,
          effOut: r.effOut,
          effCacheRead: r.effCacheRead,
          // 合并后的样本量：判断这个结论有多可信（7 天 × 多少 token）
          tokens: r.tokens,
          requests: r.requests,
          days: r.days,
        })),
      ]),
    ),
    at: new Date().toISOString(),
  }
}
