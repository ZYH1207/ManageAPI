/**
 * 比价层：把各站各不相同的计价方式，统一换算成「每百万 token 人民币」。
 *
 * 两种定价模式：
 *   manual —— 直接填该站的输入/输出单价
 *   ratio  —— 只填倍率，价格 = 基准价 × 倍率（中转站最常见的标法）
 *
 * 只有归一化之后，跨站横向比较才有意义。
 */

const UNIT_MULTIPLIER = {
  per_mtok: 1,
  per_1k: 1000,
}

/**
 * 把一条供给解析成「原始计价」，供后续换算。
 * @returns {{inPrice:number|null, outPrice:number|null, currency:string, source:string}|null}
 */
export function resolveOfferPrice(offer, benchmarks = {}) {
  // 填了倍率且基准价存在 → 走倍率换算；否则回落到手填单价。
  const key = offer.benchmarkKey || offer.modelKey || offer.upstreamName
  const base = benchmarks[key]
  const ratio = Number(offer.ratio)
  if (Number.isFinite(ratio) && ratio > 0 && base) {
    const scale = (v) => (v === null || v === undefined ? null : Number(v) * ratio)
    return {
      inPrice: scale(base.in),
      outPrice: scale(base.out),
      // 峰谷：基准价里有空闲价就一起换算，仅供展示，不参与排序
      offPeakInPrice: scale(base.offPeakIn),
      offPeakOutPrice: scale(base.offPeakOut),
      currency: base.currency === 'CNY' ? 'CNY' : 'USD',
      source: 'ratio',
    }
  }
  return {
    inPrice: offer.inPrice === null || offer.inPrice === undefined || offer.inPrice === '' ? null : Number(offer.inPrice),
    outPrice: offer.outPrice === null || offer.outPrice === undefined || offer.outPrice === '' ? null : Number(offer.outPrice),
    offPeakInPrice: null,
    offPeakOutPrice: null,
    currency: offer.currency === 'CNY' ? 'CNY' : 'USD',
    source: 'manual',
  }
}

/**
 * 单个模型供给的实际成本（人民币 / 每百万 token）。
 * @returns {{inCnyPerMtok:number|null, outCnyPerMtok:number|null, blendedCnyPerMtok:number|null, complete:boolean}}
 */
export function offerCost(offer, settings = {}, benchmarks = {}) {
  const fx = Number(settings.fxUsdCny) || 7.2
  const rawWeight = Number(settings.blendInputWeight)
  const weight = Number.isFinite(rawWeight) ? Math.min(Math.max(rawWeight, 0), 1) : 0.25
  const mult = UNIT_MULTIPLIER[offer.priceUnit] ?? 1

  const resolved = resolveOfferPrice(offer, benchmarks)
  if (!resolved) {
    return { inCnyPerMtok: null, outCnyPerMtok: null, blendedCnyPerMtok: null, complete: false }
  }

  const toCny = (price) => {
    if (price === null || !Number.isFinite(price)) return null
    const perMtok = price * mult
    return resolved.currency === 'CNY' ? perMtok : perMtok * fx
  }

  const inCnyPerMtok = toCny(resolved.inPrice)
  const outCnyPerMtok = toCny(resolved.outPrice)
  const complete = inCnyPerMtok !== null && outCnyPerMtok !== null

  let blendedCnyPerMtok = null
  if (complete) blendedCnyPerMtok = inCnyPerMtok * weight + outCnyPerMtok * (1 - weight)
  else if (inCnyPerMtok !== null) blendedCnyPerMtok = inCnyPerMtok
  else if (outCnyPerMtok !== null) blendedCnyPerMtok = outCnyPerMtok

  // 峰谷：只算空闲时段的展示价，排序仍用高峰价，避免选站结果随时间跳变
  const offPeakIn = toCny(resolved.offPeakInPrice)
  const offPeakOut = toCny(resolved.offPeakOutPrice)
  const hasOffPeak = offPeakIn !== null || offPeakOut !== null
  let offPeakBlendedCnyPerMtok = null
  if (hasOffPeak) {
    const i = offPeakIn ?? inCnyPerMtok
    const o = offPeakOut ?? outCnyPerMtok
    if (i !== null && o !== null) offPeakBlendedCnyPerMtok = i * weight + o * (1 - weight)
  }

  return {
    inCnyPerMtok,
    outCnyPerMtok,
    blendedCnyPerMtok,
    offPeakInCnyPerMtok: offPeakIn,
    offPeakOutCnyPerMtok: offPeakOut,
    offPeakBlendedCnyPerMtok,
    hasOffPeak,
    complete,
  }
}

/**
 * 按归一化模型分组，组内按综合成本升序。
 *
 * 不可信的供给仍然列出（价格信息本身有用），但不参与「最便宜」与价差的判定，
 * 否则会和 headline、路由的选择打架。
 */
export function rankByModel(offers, settings = {}, benchmarks = {}, isTrusted = () => true) {
  const groups = new Map()
  const unpriced = []

  for (const offer of offers) {
    const cost = offerCost(offer, settings, benchmarks)
    const row = { offer, cost }
    if (cost.blendedCnyPerMtok === null) {
      unpriced.push(row)
      continue
    }
    const key = offer.modelKey || offer.upstreamName
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  const ranked = [...groups.entries()].map(([modelKey, rows]) => {
    rows.sort((a, b) => {
      if (a.cost.complete !== b.cost.complete) return a.cost.complete ? -1 : 1
      return a.cost.blendedCnyPerMtok - b.cost.blendedCnyPerMtok
    })

    const trustedRows = rows.filter((r) => isTrusted(r.offer.id))
    // 全部不可信时退回全量，至少还能看出价格关系
    const statsRows = trustedRows.length > 0 ? trustedRows : rows
    const cheapest = statsRows[0]?.cost.blendedCnyPerMtok ?? null
    const priciest = statsRows.length > 1 ? statsRows[statsRows.length - 1].cost.blendedCnyPerMtok : null
    const spreadPct =
      cheapest && priciest && priciest > 0 ? Math.round(((priciest - cheapest) / priciest) * 100) : null
    const cheapestId = statsRows[0]?.offer.id ?? null

    return {
      modelKey,
      rows: rows.map((r) => ({
        offerId: r.offer.id,
        providerId: r.offer.providerId,
        credentialId: r.offer.credentialId,
        upstreamName: r.offer.upstreamName,
        group: r.offer.group || '',
        pricingMode: r.offer.pricingMode || 'manual',
        ratio: r.offer.ratio ?? null,
        siteRatio: r.offer.siteRatio ?? null,
        ratioSource: r.offer.ratioSource ?? null,
        benchmarkKey: r.offer.benchmarkKey ?? null,
        currency: r.offer.currency,
        priceUnit: r.offer.priceUnit,
        inPrice: r.offer.inPrice,
        outPrice: r.offer.outPrice,
        inCnyPerMtok: r.cost.inCnyPerMtok,
        outCnyPerMtok: r.cost.outCnyPerMtok,
        blendedCnyPerMtok: r.cost.blendedCnyPerMtok,
        offPeakBlendedCnyPerMtok: r.cost.offPeakBlendedCnyPerMtok,
        hasOffPeak: r.cost.hasOffPeak,
        complete: r.cost.complete,
        trusted: isTrusted(r.offer.id),
        isCheapest: r.offer.id === cheapestId,
        deltaPct:
          cheapest && r.cost.blendedCnyPerMtok && isTrusted(r.offer.id)
            ? Math.round(((r.cost.blendedCnyPerMtok - cheapest) / cheapest) * 100)
            : null,
      })),
      cheapest,
      priciest,
      spreadPct,
      providerCount: new Set(rows.map((r) => r.offer.providerId)).size,
    }
  })

  ranked.sort((a, b) => {
    if (b.spreadPct !== null && a.spreadPct !== null) return b.spreadPct - a.spreadPct
    return (b.rows.length || 0) - (a.rows.length || 0)
  })

  return { ranked, unpriced: unpriced.map((r) => r.offer) }
}

/**
 * 汇总指标，供看板顶部展示。
 * 价差只统计 isTrusted 的供给——否则会把「便宜但不可用」的站算进去，
 * 和 headline 的口径不一致，用户会觉得两个数对不上。
 */
export function summarize(offers, settings = {}, benchmarks = {}, isTrusted = () => true) {
  const { ranked, unpriced } = rankByModel(offers, settings, benchmarks, isTrusted)

  const spreads = ranked
    .map((group) => {
      const rows = group.rows.filter((row) => isTrusted(row.offerId))
      if (rows.length < 2) return null
      const cheapest = rows[0].blendedCnyPerMtok
      const priciest = rows[rows.length - 1].blendedCnyPerMtok
      if (!cheapest || !priciest || priciest <= 0) return null
      return Math.round(((priciest - cheapest) / priciest) * 100)
    })
    .filter((value) => typeof value === 'number')

  const comparable = ranked.filter((group) => group.providerCount > 1)
  return {
    offerCount: offers.length,
    pricedCount: offers.length - unpriced.length,
    modelCount: ranked.length,
    comparableCount: comparable.length,
    providerCount: new Set(offers.map((o) => o.providerId)).size,
    avgSpreadPct: spreads.length ? Math.round(spreads.reduce((a, b) => a + b, 0) / spreads.length) : null,
    maxSpreadPct: spreads.length ? Math.max(...spreads) : null,
  }
}

/**
 * 生成一句人话结论——看板与宣传截图的主角。
 *
 * 选择顺序：
 *   1. 用户「关心」的模型（按用量 > 手动排序 > 探过的顺序挑第一个能比价的）
 *   2. 都没有时，回落到价差最大的模型
 *
 * 光按价差排会出现「你只关心 gpt-4o，它却给你推 deepseek 省了 90%」的尴尬。
 *
 * isTrusted 用来剔除探针判定不可信的供给：结论句不能推荐一个会挂或掉包的站，
 * 否则它和路由的实际选择会自相矛盾。
 */
export function headline(ranked, providers, isTrusted = () => true, focusModels = []) {
  const nameOf = (id) => providers.find((p) => p.id === id)?.name || '未知站'

  const groups = ranked
    .map((group) => {
      const rows = group.rows.filter((row) => isTrusted(row.offerId))
      if (rows.length < 2) return null
      const cheapest = rows[0].blendedCnyPerMtok
      const priciest = rows[rows.length - 1].blendedCnyPerMtok
      if (!cheapest || !priciest || priciest <= 0) return null
      return {
        modelKey: group.modelKey,
        top: rows[0],
        spreadPct: Math.round(((priciest - cheapest) / priciest) * 100),
      }
    })
    .filter(Boolean)

  let best = null
  for (const key of focusModels) {
    const hit = groups.find((g) => g.modelKey === key)
    if (hit) {
      best = hit
      break
    }
  }
  if (!best) best = [...groups].sort((a, b) => b.spreadPct - a.spreadPct)[0]
  if (!best) return null

  const price = Math.round(best.top.blendedCnyPerMtok * 100) / 100
  const providerName = nameOf(best.top.providerId)
  return {
    modelKey: best.modelKey,
    providerName,
    price,
    spreadPct: best.spreadPct,
    text: `${best.modelKey} 目前 ${providerName} 最便宜，¥${price.toFixed(2)}/百万 token，比最贵的省 ${best.spreadPct}%`,
  }
}
