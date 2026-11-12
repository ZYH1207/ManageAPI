/**
 * 站点原始走账清单：把中转站自己的计费明细（`GET /api/v1/usage`）接进网关。
 *
 * 为什么不再自己算：网关侧算价有三个结构性误差，全都无法在本地修正——
 *   1. 上游有相当比例请求不回 usage，网关只能记 0（实测约 26% token 缺失）
 *   2. `prompt_tokens_details.cached_tokens` 不稳定（同站同天报 553216 / 128 都出现过）
 *   3. 真实用量 88~96% 是缓存命中，而比价公式 `输入×0.25 + 输出×0.75` 完全不算缓存价
 *      → 缓存读价便宜的模型被系统性低估，排名直接错（秋的 GPT vs DeepSeek 就是这么翻的）
 *
 * 站点账单不会有这三个问题：它自己按分项记账，连缓存读的钱都单列。所以本模块的定位是
 * **权威数据源**，网关估算降级为「站点账单读不到时的兜底」。
 *
 * 账单里每条明细的字段（sub2api 系实测）：
 *   input_tokens / output_tokens / cache_read_tokens / cache_creation_tokens
 *   input_cost / output_cost / cache_read_cost / cache_creation_cost   ← 分项成本（原价口径）
 *   total_cost   = 分项成本之和（折前）
 *   actual_cost  = total_cost × rate_multiplier（实扣）
 *   rate_multiplier 该单实际生效的分组倍率
 *   group_id     分组 id（名字要用 /api/v1/groups/available 换）
 *
 * 由此可以反推**站点真实原价**：原价 = 分项成本 ÷ 分项 token ÷ 倍率。
 * 这比「读模型广场 + 套基准价补位」可靠得多——广场接口很多站压根没开。
 */

import { normalizeGroup } from './store.js'

/** 单次拉取最多翻多少页。秋一天 4600+ 条、单页上限 1000，6 页足够；防止站点异常时死循环 */
const MAX_PAGES = 20
/** 站点 page_size 上限实测 1000，超过会静默回落成 20 条（不是报错，很容易误判成"没数据"） */
const PAGE_SIZE = 1000
/** 聚合结果只保留这么多天，避免 db 无限膨胀 */
export const LEDGER_KEEP_DAYS = 30

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 每 token 成本 → 每百万 token 单价；没有 token 样本时返回 null（不猜） */
function perMillion(cost, tokens) {
  const t = num(tokens)
  if (t <= 0) return null
  return (num(cost) / t) * 1e6
}

/** 四舍五入到 6 位，避免 0.10000000000000002 这种尾巴渗进界面和比较 */
const round6 = (v) => (v === null ? null : Math.round(v * 1e6) / 1e6)

/**
 * 把一天的账单明细聚合成「分组 × 模型」一行。
 *
 * 每一行给三样东西，各有各的用途，别混：
 *   - baseIn/baseOut/baseCacheRead：站点真实原价（÷ 倍率还原），用来核对台账和基准价
 *   - effIn/effOut/effCacheRead：折后单价（原价 × 倍率），用来跨站比价
 *   - paidPerMtok：真实实付单价（actual_cost ÷ 全部 token），用来回答「我到底花了多少」
 *
 * paidPerMtok 才是用户真正关心的数字：它把缓存命中率这个「用量形状」也吃进去了，
 * 所以同站不同分组的对比、以及跨站对比，都应该优先看它。
 *
 * @param {Array} items 账单明细
 * @param {Map<number, {name:string, rate:number}>} groupNames group_id → 分组
 * @returns {Array<object>}
 */
export function aggregateLedgerItems(items, groupNames = new Map()) {
  const acc = new Map()
  for (const it of items || []) {
    if (!it) continue
    const model = String(it.model || '').trim()
    if (!model) continue
    // 分组归属以账单里的 group_id 为准——那是「这一单实际按哪个分组扣的钱」，
    // 比台账里记的分组名权威（台账可能是几天前同步的，站方改过分组名就对不上了）
    const groupId = it.group_id ?? null
    const key = `${model}||${groupId ?? ''}`
    let row = acc.get(key)
    if (!row) {
      const known = groupNames.get(groupId)
      row = {
        model,
        groupId,
        // 分组表里查不到名字是正常情况：站方删过/改过名之后，历史账单里的
        // group_id 就再也换不出名字了（实测秋的 123/86/58 三个 id 已不在
        // /groups/available 里）。这时 group 保持 null，由 groupLabel 兜底显示
        // 「分组#123」——不能编一个名字，也不能因此把整行丢掉
        group: known?.name ? normalizeGroup(known.name) : null,
        groupLabel: known?.name ? normalizeGroup(known.name) : `分组#${groupId ?? '?'}`,
        groupKnown: Boolean(known?.name),
        // 倍率按「最后一次见到的」记：同分组同模型理论上恒定，但站方调价当天会出现两个值，
        // 取最后一个更接近现状；行上同时留 rateSet 让调用方能看出「这天改过价」
        rate: null,
        rateSet: [],
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheCreationCost: 0,
        totalCost: 0,
        actualCost: 0,
        imageCount: 0,
        imageCost: 0,
        // 'token' | 'image' | 站点声明的其他计费方式。非 token 计费的行，
        // 每百万 token 单价字段一律给 null（量纲不同，算出来是假数字）
        billUnit: 'token',
        firstAt: null,
        lastAt: null,
      }
      acc.set(key, row)
    }
    row.requests += 1
    row.inputTokens += num(it.input_tokens)
    row.outputTokens += num(it.output_tokens)
    row.cacheReadTokens += num(it.cache_read_tokens)
    row.cacheCreationTokens += num(it.cache_creation_tokens)
    row.inputCost += num(it.input_cost)
    row.outputCost += num(it.output_cost)
    row.cacheReadCost += num(it.cache_read_cost)
    row.cacheCreationCost += num(it.cache_creation_cost)
    row.totalCost += num(it.total_cost)
    row.actualCost += num(it.actual_cost)
    const rate = it.rate_multiplier === null || it.rate_multiplier === undefined ? null : num(it.rate_multiplier)
    if (rate !== null) {
      row.rate = rate
      if (!row.rateSet.includes(rate)) row.rateSet.push(rate)
    }
    const at = String(it.created_at || '')
    if (at) {
      if (!row.firstAt || at < row.firstAt) row.firstAt = at
      if (!row.lastAt || at > row.lastAt) row.lastAt = at
    }
    // 按张计费（生图）：token 单价对它没有意义，得单独计数。
    // 实测秋「生图」分组：gpt-image-2.6-exact 一次请求 in=248 out=1013 token，
    // 但实际扣 0.05（按张），拿 token 去除会算出 26~37/Mtok 这种荒谬单价，
    // 直接污染「同模型谁便宜」的排序。所以这里把「有没有 image 计费」记下来，
    // 让单价字段对这类行保持 null，只在 billUnit 上标 'image'。
    row.imageCount += num(it.image_count)
    row.imageCost += num(it.image_input_cost) + num(it.image_output_cost)
    if (num(it.image_count) > 0 || num(it.image_input_cost) > 0 || num(it.image_output_cost) > 0) {
      row.billUnit = 'image'
    } else if (it.billing_mode && it.billing_mode !== 'token') {
      // 站点自己声明的非 token 计费（per_request 之类）
      row.billUnit = String(it.billing_mode)
    } else if (it.billing_type !== undefined && it.billing_type !== null && Number(it.billing_type) !== 0) {
      // 老字段：billing_type 非 0 表示非 token 计费，具体含义站方没文档，只标出来
      row.billUnit = `type${it.billing_type}`
    }
  }

  const out = []
  for (const row of acc.values()) {
    const totalTokens = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreationTokens
    // 分项成本 ÷ token = 原价单价。**注意这里不除倍率**：
    // 站点账单的 input_cost / output_cost / cache_read_cost 是按**原价**算的，
    // 折扣只体现在 actual_cost（= total_cost × rate_multiplier）上。
    // 实测校验（秋 gpt-6.1-sol 一单）：in=182 out=5 cache=5248 rate=0.06
    //   input_cost=0.000364 → 0.000364/182×1e6 = 2.00   ← 正是原价
    //   total_cost=0.0009388 = (182×2 + 5×10 + 5248×0.1)/1e6  ← 原价口径
    //   actual_cost=0.000056328 = total_cost × 0.06        ← 折后
    // 反推原价再除以倍率会得到 28.57 这种荒谬数字（DeepSeek 官方价明明是 2/8）。
    const baseIn = perMillion(row.inputCost, row.inputTokens)
    const baseOut = perMillion(row.outputCost, row.outputTokens)
    const baseCacheRead = perMillion(row.cacheReadCost, row.cacheReadTokens)
    const rate = row.rate
    // 折后单价 = 原价 × 倍率。倍率未知（老明细没这个字段）时退回原价，
    // 但调用方能从 rate === null 看出「这个折后价其实是原价」
    const eff = (v) => (v === null ? null : round6(rate === null ? v : v * rate))
    // 非 token 计费（按张生图 / 按次）：每百万 token 单价与实付单价都无意义，
    // 一律给 null，只在 billUnit / callCost 上表达。混进 token 排序会得出
    // 「生图 26 元/百万 token」这种假结论（实测就是这么冒出来的）
    const tokenBilled = row.billUnit === 'token'
    out.push({
      model: row.model,
      groupId: row.groupId,
      group: row.group,
      // 给人看的标签：分组名查不到时显示「分组#123」，前端不用再判空
      groupLabel: row.groupLabel,
      groupKnown: row.groupKnown,
      rate,
      // 同一天出现过多个倍率 = 站方当天调过价，调用方要能看出来
      rateChanged: row.rateSet.length > 1,
      rateSet: row.rateSet,
      // 计费单位：'token' 才是能和别人比 per-token 单价的；其余只报总花费
      billUnit: row.billUnit,
      requests: row.requests,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheCreationTokens: row.cacheCreationTokens,
      imageCount: row.imageCount,
      totalTokens,
      // 站点真实原价（每百万 token）——拿它校验台账和基准价
      baseIn: tokenBilled ? round6(baseIn) : null,
      baseOut: tokenBilled ? round6(baseOut) : null,
      baseCacheRead: tokenBilled ? round6(baseCacheRead) : null,
      // 折后单价（每百万 token）——跨站比价用
      effIn: tokenBilled ? eff(baseIn) : null,
      effOut: tokenBilled ? eff(baseOut) : null,
      effCacheRead: tokenBilled ? eff(baseCacheRead) : null,
      // 钱
      totalCost: Math.round(row.totalCost * 1e6) / 1e6,
      actualCost: Math.round(row.actualCost * 1e6) / 1e6,
      // 按张计费的单张价（有图才有值），量纲不同，单独一个字段
      perImageCost:
        row.imageCount > 0 ? Math.round((row.actualCost / row.imageCount) * 1e6) / 1e6 : null,
      // 真实实付单价：把缓存命中率也算进去，比任何公式都准。
      // 只对 token 计费的行成立——生图那种按张算的除出来是假的
      paidPerMtok: tokenBilled && totalTokens > 0 ? round6((row.actualCost / totalTokens) * 1e6) : null,
      firstAt: row.firstAt,
      lastAt: row.lastAt,
    })
  }
  // 按实付金额降序：调用方和界面第一眼看到的是「钱花在哪了」
  out.sort((a, b) => b.actualCost - a.actualCost)
  return out
}

/**
 * 拉取某站某天的账单明细（自动翻页）。
 *
 * 三个站点实测差异，全都踩过：
 *   - page_size 上限 1000，超过会**静默回落成 20 条**（不报错），必须按返回的 page_size 校验
 *   - 不传日期参数时返回全量（最新在前）；传了 start_date/end_date 才按天过滤
 *   - rapid 那种站日期过滤能匹配但当天没明细，返回 total=0 是正常的，不是失败
 *
 * @param {{fetchPage: (page:number, pageSize:number, day:string|null) => Promise<object>}} io
 *   注入取数函数，避免本模块直接依赖 providers.js（也让测试能换桩）
 * @param {{day?: string|null, maxPages?: number}} options
 * @returns {Promise<{items:Array, pages:number, total:number, truncated:boolean}>}
 */
export async function fetchLedgerItems(io, { day = null, maxPages = MAX_PAGES } = {}) {
  const items = []
  let page = 1
  let total = null
  let pages = 1
  for (; page <= maxPages; page += 1) {
    const payload = await io.fetchPage(page, PAGE_SIZE, day)
    const data = payload?.data
    const batch = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : []
    if (total === null && typeof data?.total === 'number') total = data.total
    if (typeof data?.pages === 'number' && data.pages > 0) pages = data.pages
    if (batch.length === 0) break
    items.push(...batch)
    // 返回条数比请求的少，说明这是最后一页（或站点把 page_size 压小了）
    if (batch.length < PAGE_SIZE) break
    if (total !== null && items.length >= total) break
    if (page >= pages) break
  }
  return {
    items,
    pages,
    total: total ?? items.length,
    // 翻到上限还没拉完：调用方要能知道「这份聚合是不完整的」
    truncated: total !== null && items.length < total && page > maxPages,
  }
}

/**
 * 把某站的账单聚合结果并进 db.ledger（providerId → day → rows）。
 *
 * 覆盖写当天（当天累计值在增长），历史天只在缺失时回填——
 * 和 monitor 的 siteSpend 同一套策略，理由也一样：重拉历史是白花的往返。
 *
 * @param {object} db 会被就地修改
 * @param {string} providerId
 * @param {string} day 'YYYY-MM-DD'
 * @param {Array} rows aggregateLedgerItems 的输出
 * @param {{force?: boolean, at?: string}} options
 * @returns {{written:boolean, reason?:string}}
 */
export function applyLedgerDay(db, providerId, day, rows, { force = false, at = null } = {}) {
  const key = String(day || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return { written: false, reason: 'bad-day' }
  if (!Array.isArray(rows)) return { written: false, reason: 'bad-rows' }
  if (!db.ledger || typeof db.ledger !== 'object') db.ledger = {}
  if (!db.ledger[providerId] || typeof db.ledger[providerId] !== 'object') db.ledger[providerId] = {}
  const site = db.ledger[providerId]
  // 历史天已经采过就跳过，除非 force（用户手动点「重新同步账单」）
  if (site[key] && !force) return { written: false, reason: 'exists' }
  site[key] = {
    day: key,
    at: at || new Date().toISOString(),
    rows,
    // 汇总：界面顶部「今天花了多少」直接读它，不用每次遍历 rows
    requests: rows.reduce((s, r) => s + (Number(r.requests) || 0), 0),
    actualCost: Math.round(rows.reduce((s, r) => s + (Number(r.actualCost) || 0), 0) * 1e6) / 1e6,
    totalCost: Math.round(rows.reduce((s, r) => s + (Number(r.totalCost) || 0), 0) * 1e6) / 1e6,
    tokens: rows.reduce((s, r) => s + (Number(r.totalTokens) || 0), 0),
  }
  // 只留最近 N 天
  const days = Object.keys(site).sort()
  if (days.length > LEDGER_KEEP_DAYS) {
    for (const old of days.slice(0, days.length - LEDGER_KEEP_DAYS)) delete site[old]
  }
  return { written: true }
}

/** 读某站最近 N 天的账单（新的在前） */
export function listLedgerDays(db, providerId, limit = 7) {
  const site = db.ledger?.[providerId]
  if (!site || typeof site !== 'object') return []
  return Object.values(site)
    .sort((a, b) => String(b.day).localeCompare(String(a.day)))
    .slice(0, limit)
}

/**
 * 把账单里反推出的原价和台账逐行对照，产出差异清单。
 *
 * 这是「接账单」最直接的收益：不用再信「模型广场 + 基准价补位」的推断价，
 * 而是拿站点自己扣费时用的数字回头校验台账。
 *
 * 判定口径：
 *   - 台账倍率 ≠ 账单倍率 → 'rate-drift'（站方调价了，台账过期）
 *   - 台账原价 ≠ 账单原价（相对误差 > 1%）→ 'price-drift'
 *   - 台账分组名在账单里完全找不到 → 'group-gone'（分组被删/改名，供给是僵尸）
 *   - 台账 inPrice 为空但账单有原价 → 'fillable'（能补上，不用再猜基准价）
 *
 * @param {Array} offers 台账供给
 * @param {Array} rows 账单聚合行
 * @returns {Array<{offerId, modelKey, group, kind, ledger, site, note}>}
 */
export function diffLedgerAgainstOffers(offers, rows, { tolerance = 0.01 } = {}) {
  const byGroupModel = new Map()
  for (const r of rows || []) {
    // 账单里的分组名可能为空（group_id 没查到名字）：这种行只按模型索引，
    // 不参与分组精确比对，否则会把「查不到名字」误判成「分组不存在」
    if (r.group) byGroupModel.set(`${normalizeGroup(r.group)}::${r.model}`, r)
  }
  const byModel = new Map()
  for (const r of rows || []) {
    if (!byModel.has(r.model)) byModel.set(r.model, [])
    byModel.get(r.model).push(r)
  }

  const out = []
  for (const offer of offers || []) {
    const name = String(offer.upstreamName || offer.modelKey || '').trim()
    if (!name) continue
    const group = normalizeGroup(offer.group)
    const hit = byGroupModel.get(`${group}::${name}`)
    if (!hit) {
      // 分组精确匹配不到：先看这个模型在账单里有没有任何行
      const sameModel = byModel.get(name)
      if (!sameModel || sameModel.length === 0) {
        // 整个模型这天都没流量，无从判断——不能算「分组消失」
        continue
      }
      out.push({
        offerId: offer.id,
        modelKey: offer.modelKey,
        group: offer.group,
        kind: 'group-gone',
        ledger: { ratio: offer.ratio ?? null, inPrice: offer.inPrice ?? null, outPrice: offer.outPrice ?? null },
        site: null,
        note: `账单里这个模型只出现在 ${sameModel.map((r) => r.group || `group#${r.groupId}`).join('、')}`,
      })
      continue
    }

    const ledgerRatio = offer.ratio === null || offer.ratio === undefined ? null : Number(offer.ratio)
    if (ledgerRatio !== null && hit.rate !== null && Math.abs(ledgerRatio - hit.rate) > 1e-9) {
      out.push({
        offerId: offer.id,
        modelKey: offer.modelKey,
        group: offer.group,
        kind: 'rate-drift',
        ledger: { ratio: ledgerRatio, inPrice: offer.inPrice ?? null, outPrice: offer.outPrice ?? null },
        site: { rate: hit.rate, baseIn: hit.baseIn, baseOut: hit.baseOut },
        note: `倍率 ${ledgerRatio} → ${hit.rate}`,
      })
    }

    const near = (a, b) => {
      if (a === null || b === null || a === undefined || b === undefined) return true
      const x = Number(a)
      const y = Number(b)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return true
      if (y === 0) return Math.abs(x) < 1e-9
      return Math.abs(x - y) / Math.abs(y) <= tolerance
    }
    const priceDrift = !near(offer.inPrice, hit.baseIn) || !near(offer.outPrice, hit.baseOut)
    if (priceDrift) {
      out.push({
        offerId: offer.id,
        modelKey: offer.modelKey,
        group: offer.group,
        kind: 'price-drift',
        ledger: { ratio: ledgerRatio, inPrice: offer.inPrice ?? null, outPrice: offer.outPrice ?? null },
        site: { rate: hit.rate, baseIn: hit.baseIn, baseOut: hit.baseOut },
        note: `原价 台账 ${offer.inPrice ?? '—'}/${offer.outPrice ?? '—'} vs 站点 ${hit.baseIn ?? '—'}/${hit.baseOut ?? '—'}`,
      })
    }
    const fillable =
      (offer.inPrice === null || offer.inPrice === undefined) &&
      (offer.outPrice === null || offer.outPrice === undefined) &&
      (hit.baseIn !== null || hit.baseOut !== null)
    if (fillable) {
      out.push({
        offerId: offer.id,
        modelKey: offer.modelKey,
        group: offer.group,
        kind: 'fillable',
        ledger: { ratio: ledgerRatio, inPrice: null, outPrice: null },
        site: { rate: hit.rate, baseIn: hit.baseIn, baseOut: hit.baseOut },
        note: '台账无原价，账单能直接补上（不用再靠基准价猜）',
      })
    }
  }
  return out
}

/**
 * 从账单聚合行里挑出「这个模型在哪些分组下最便宜」，按真实实付单价排。
 *
 * 和 rankByModel 的区别：那边比的是**挂牌 blended**（不算缓存），这边比的是
 * **真实实付**（算上缓存命中和实际倍率）。用户问「哪个更便宜」时，后者才是答案。
 *
 * 两个必须做的合并，否则结论不可用：
 *   1. **同站同分组同模型跨天合并**——调用方传进来的 rows 通常是一周的量，
 *      不合并的话「最便宜的 5 个」全是同一个分组的 5 天，看不出任何信息。
 *      合并口径是加权平均（按 token 加权），不是简单平均：一天的用量可能是
 *      另一天的 1000 倍，简单平均会让样本少的那天决定结论。
 *   2. **非 token 计费（生图）不参与**——量纲不同，per-token 单价是假的。
 *
 * @param {Array} rows 账单聚合行（可跨天、跨站拼在一起）
 * @returns {Map<string, Array>} model → 按加权实付单价升序的行
 */
export function cheapestByPaid(rows) {
  // 先按「站 + 分组 + 模型」把多天合成一条
  const merged = new Map()
  for (const r of rows || []) {
    if (r.paidPerMtok === null || r.paidPerMtok === undefined) continue
    if (r.billUnit && r.billUnit !== 'token') continue
    const key = `${r.providerId ?? ''}||${r.groupId ?? r.group ?? ''}||${r.model}`
    let m = merged.get(key)
    if (!m) {
      m = {
        model: r.model,
        providerId: r.providerId ?? null,
        providerName: r.providerName ?? null,
        group: r.group ?? null,
        groupId: r.groupId ?? null,
        rate: r.rate ?? null,
        tokens: 0,
        actualCost: 0,
        requests: 0,
        days: 0,
        effIn: null,
        effOut: null,
        effCacheRead: null,
      }
      merged.set(key, m)
    }
    m.tokens += Number(r.totalTokens) || 0
    m.actualCost += Number(r.actualCost) || 0
    m.requests += Number(r.requests) || 0
    m.days += 1
    // 折后单价取「最新那天」的（行按天倒序传进来时第一条最新），
    // 倍率调过价的话旧值会误导；实付单价则始终是加权平均
    if (m.effIn === null && r.effIn !== null) {
      m.effIn = r.effIn
      m.effOut = r.effOut
      m.effCacheRead = r.effCacheRead
    }
  }

  const byModel = new Map()
  for (const m of merged.values()) {
    if (m.tokens <= 0) continue
    m.paidPerMtok = round6((m.actualCost / m.tokens) * 1e6)
    if (!byModel.has(m.model)) byModel.set(m.model, [])
    byModel.get(m.model).push(m)
  }
  for (const list of byModel.values()) list.sort((a, b) => a.paidPerMtok - b.paidPerMtok)
  return byModel
}

/**
 * 用账单反推出的原价，确诊并纠正「折后价残留」。
 *
 * 为什么只能在账单这一层做：折后价残留的判据是「输入框里存的是 原价×倍率」，
 * 要判它必须知道**站点的真实原价**。基准价不是它（那是官方参考，站点自己的
 * 报价经常比基准价低——实测 rapid 官key 组 deepseek-v4-pro 报 4.5/13.5，
 * 基准价 9/27，那 4.5 是真价）。拿基准价当上限去纠正会误伤一大批。
 * 账单里的 `baseIn` 才是站点扣费时真正用的原价。
 *
 * 判据（要求**精确吻合**，不是「小于」）：
 *   台账现值 ≈ 账单原价 × 倍率   （相对误差 < tolerance）
 * 这个等式只在「输入框被写成了折后价」时成立。如果台账存的是原价，
 * 它应该 ≈ 账单原价本身，不会同时等于「原价×倍率」（除非倍率≈1，
 * 那种情况下改了也没影响，所以显式跳过倍率≈1 的行避免无意义写入）。
 *
 * 实测确诊的案例：秋 gpt-6.1-sol @【自建】Ultrafast 分组
 *   台账 inPrice=2，站点原价=16，倍率=0.14 → 2 ≈ 16×0.14 ✓ 确诊
 *   改正后按 16×0.14=2.24 计费，与站点账单实扣一致
 *
 * @param {Array} offers 会被就地修改
 * @param {Array} rows 账单聚合行
 * @param {{tolerance?:number, dryRun?:boolean}} options
 * @returns {{healed:Array<{offerId,modelKey,group,from,to,ratio}>, checked:number}}
 */
export function healResidualPricesFromLedger(offers, rows, { tolerance = 0.02, dryRun = false } = {}) {
  // (分组, 模型) → 账单原价。分组名查不到时用 groupId 兜底匹配
  const byGroupModel = new Map()
  const byModel = new Map()
  for (const r of rows || []) {
    if (r.billUnit && r.billUnit !== 'token') continue
    if (r.baseIn === null || r.baseIn === undefined) continue
    if (r.group) byGroupModel.set(`${normalizeGroup(r.group)}::${r.model}`, r)
    if (!byModel.has(r.model)) byModel.set(r.model, [])
    byModel.get(r.model).push(r)
  }

  const healed = []
  let checked = 0
  for (const offer of offers || []) {
    const name = String(offer.upstreamName || offer.modelKey || '').trim()
    if (!name) continue
    const ratio = Number(offer.ratio)
    // 倍率缺失、为 0、或约等于 1 时不判：倍率≈1 时「原价」与「折后价」数值相同，
    // 改了也不影响计费，白白写盘还会把 updatedAt 搅乱
    if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 1e-6) continue
    // 用户手改过的价格是商务事实，绝不碰
    if (offer.priceSource === 'custom') continue
    const curIn = Number(offer.inPrice)
    if (!Number.isFinite(curIn) || curIn <= 0) continue

    const hit =
      byGroupModel.get(`${normalizeGroup(offer.group)}::${name}`) ||
      // 分组名对不上时退到「这个模型在账单里唯一的那条」——只有唯一时才敢用，
      // 多条就没法确定是哪一档价
      (byModel.get(name)?.length === 1 ? byModel.get(name)[0] : null)
    if (!hit) continue
    checked += 1

    const realIn = Number(hit.baseIn)
    if (!Number.isFinite(realIn) || realIn <= 0) continue
    const discounted = realIn * ratio
    // 精确吻合才判：|现值 - 原价×倍率| / 原价 < tolerance
    if (Math.abs(curIn - discounted) / realIn > tolerance) continue
    // 现值本来就等于原价（没有残留）：不动
    if (Math.abs(curIn - realIn) / realIn <= tolerance) continue

    const realOut = hit.baseOut === null || hit.baseOut === undefined ? null : Number(hit.baseOut)
    if (!dryRun) {
      offer.inPrice = Math.round(realIn * 1000) / 1000
      if (realOut !== null && Number.isFinite(realOut)) {
        offer.outPrice = Math.round(realOut * 1000) / 1000
      }
      // 缓存读价的口径**和 in/out 不一样**，别照搬：
      //   inPrice / outPrice  存的是**原价**（算钱时再乘倍率）
      //   cacheReadPrice      存的是**折后价**（inventory.js#scaleTo 已乘过倍率）
      // 实测台账：秋 gpt-6.1-sol @ gpt team 混池 cacheReadPrice=0.005，
      // 站点原价 0.1 × 倍率 0.047 = 0.0047 —— 存的确实是折后价。
      // 所以这里写「站点原价 × 倍率」，不是原价。
      if (hit.baseCacheRead !== null && hit.baseCacheRead !== undefined) {
        offer.cacheReadPrice = Math.round(Number(hit.baseCacheRead) * ratio * 1000) / 1000
      }
      offer.priceSource = undefined
      offer.priceHealedAt = new Date().toISOString()
      offer.updatedAt = new Date().toISOString()
    }
    healed.push({
      offerId: offer.id,
      modelKey: offer.modelKey,
      group: offer.group,
      from: curIn,
      to: Math.round(realIn * 1000) / 1000,
      ratio,
    })
  }
  return { healed, checked }
}
