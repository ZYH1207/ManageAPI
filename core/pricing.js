/**
 * 比价层：把各站各不相同的计价方式，统一换算成「每百万 token 人民币」。
 *
 * 两种定价模式：
 *   manual —— 直接填该站的输入/输出单价
 *   ratio  —— 只填倍率，价格 = 基准价 × 倍率（中转站最常见的标法）
 *
 * 只有归一化之后，跨站横向比较才有意义。
 */

import { ensureFx } from './fx.js'

const UNIT_MULTIPLIER = {
  per_mtok: 1,
  per_1k: 1000,
}

/** 人民币展示用的默认汇率；只在「把美元显示成人民币」时用到，不参与排序 */
export const DISPLAY_FX_DEFAULT = 7.2

/**
 * 把一条供给解析成「原始计价」，供后续换算。
 * @returns {{inPrice:number|null, outPrice:number|null, currency:string, source:string}|null}
 */
export function resolveOfferPrice(offer, benchmarks = {}) {
  // 定价模式是谁，就用谁：pricingMode 是权威，
  // 不能拿「倍率有没有填」猜——否则切成手动后残留的倍率会继续把价格乘一遍。
  const key = offer.benchmarkKey || offer.modelKey || offer.upstreamName
  const base = benchmarks[key]
  const ratio = Number(offer.ratio)
  const wantsRatio = offer.pricingMode === 'ratio'
  if (wantsRatio && Number.isFinite(ratio) && ratio > 0 && base) {
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
 * 单个模型供给的实际成本。
 *
 * 基准口径是 **美元 / 每百万 token** —— 绝大多数中转站按美元标价，用美元比较
 * 不需要经过汇率，汇率一变也不会让历史结论跟着变。人民币只是展示口径
 * （`*CnyPerMtok` 由美元乘汇率得出），不参与任何排序。
 *
 * @returns {{inUsdPerMtok:number|null, outUsdPerMtok:number|null, blendedUsdPerMtok:number|null,
 *            inCnyPerMtok:number|null, outCnyPerMtok:number|null, blendedCnyPerMtok:number|null,
 *            complete:boolean}}
 */
export function offerCost(offer, settings = {}, benchmarks = {}) {
  // 汇率只有 fx 模块一个真源；settings.fxUsdCny 是兼容镜像，别再直接读
  const fx = Number(ensureFx(settings).rates.CNY) || DISPLAY_FX_DEFAULT
  const rawWeight = Number(settings.blendInputWeight)
  const weight = Number.isFinite(rawWeight) ? Math.min(Math.max(rawWeight, 0), 1) : 0.25
  const mult = UNIT_MULTIPLIER[offer.priceUnit] ?? 1

  const resolved = resolveOfferPrice(offer, benchmarks)
  if (!resolved) {
    return {
      inUsdPerMtok: null,
      outUsdPerMtok: null,
      blendedUsdPerMtok: null,
      inCnyPerMtok: null,
      outCnyPerMtok: null,
      blendedCnyPerMtok: null,
      complete: false,
    }
  }

  // 人民币标价的供给按汇率折成美元，参与比较的一律是美元
  const toUsd = (price) => {
    if (price === null || !Number.isFinite(price)) return null
    const perMtok = price * mult
    return resolved.currency === 'CNY' ? perMtok / fx : perMtok
  }

  const inUsdPerMtok = toUsd(resolved.inPrice)
  const outUsdPerMtok = toUsd(resolved.outPrice)
  const complete = inUsdPerMtok !== null && outUsdPerMtok !== null

  let blendedUsdPerMtok = null
  if (complete) blendedUsdPerMtok = inUsdPerMtok * weight + outUsdPerMtok * (1 - weight)
  else if (inUsdPerMtok !== null) blendedUsdPerMtok = inUsdPerMtok
  else if (outUsdPerMtok !== null) blendedUsdPerMtok = outUsdPerMtok

  // 峰谷：只算空闲时段的展示价，排序仍用高峰价，避免选站结果随时间跳变
  const offPeakInUsd = toUsd(resolved.offPeakInPrice)
  const offPeakOutUsd = toUsd(resolved.offPeakOutPrice)
  const hasOffPeak = offPeakInUsd !== null || offPeakOutUsd !== null
  let offPeakBlendedUsdPerMtok = null
  if (hasOffPeak) {
    const i = offPeakInUsd ?? inUsdPerMtok
    const o = offPeakOutUsd ?? outUsdPerMtok
    if (i !== null && o !== null) offPeakBlendedUsdPerMtok = i * weight + o * (1 - weight)
  }

  const toCny = (usd) => (usd === null ? null : usd * fx)

  return {
    inUsdPerMtok,
    outUsdPerMtok,
    blendedUsdPerMtok,
    offPeakInUsdPerMtok: offPeakInUsd,
    offPeakOutUsdPerMtok: offPeakOutUsd,
    offPeakBlendedUsdPerMtok,
    // 展示用的人民币值（只影响显示，不参与排序）
    inCnyPerMtok: toCny(inUsdPerMtok),
    outCnyPerMtok: toCny(outUsdPerMtok),
    blendedCnyPerMtok: toCny(blendedUsdPerMtok),
    offPeakBlendedCnyPerMtok: toCny(offPeakBlendedUsdPerMtok),
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
    if (cost.blendedUsdPerMtok === null) {
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
      return a.cost.blendedUsdPerMtok - b.cost.blendedUsdPerMtok
    })

    const trustedRows = rows.filter((r) => isTrusted(r.offer.id))
    // 全部不可信时退回全量，至少还能看出价格关系
    const statsRows = trustedRows.length > 0 ? trustedRows : rows
    const cheapest = statsRows[0]?.cost.blendedUsdPerMtok ?? null
    const priciest = statsRows.length > 1 ? statsRows[statsRows.length - 1].cost.blendedUsdPerMtok : null
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
        inUsdPerMtok: r.cost.inUsdPerMtok,
        outUsdPerMtok: r.cost.outUsdPerMtok,
        blendedUsdPerMtok: r.cost.blendedUsdPerMtok,
        offPeakBlendedUsdPerMtok: r.cost.offPeakBlendedUsdPerMtok,
        inCnyPerMtok: r.cost.inCnyPerMtok,
        outCnyPerMtok: r.cost.outCnyPerMtok,
        blendedCnyPerMtok: r.cost.blendedCnyPerMtok,
        offPeakBlendedCnyPerMtok: r.cost.offPeakBlendedCnyPerMtok,
        hasOffPeak: r.cost.hasOffPeak,
        complete: r.cost.complete,
        trusted: isTrusted(r.offer.id),
        isCheapest: r.offer.id === cheapestId,
        deltaPct:
          cheapest && r.cost.blendedUsdPerMtok && isTrusted(r.offer.id)
            ? Math.round(((r.cost.blendedUsdPerMtok - cheapest) / cheapest) * 100)
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
      const cheapest = rows[0].blendedUsdPerMtok
      const priciest = rows[rows.length - 1].blendedUsdPerMtok
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
export function headline(ranked, providers, isTrusted = () => true, focusModels = [], settings = {}) {
  const fxFor = (s) => Number(ensureFx(s).rates.CNY) || DISPLAY_FX_DEFAULT
  const nameOf = (id) => providers.find((p) => p.id === id)?.name || '未知站'

  const groups = ranked
    .map((group) => {
      const rows = group.rows.filter((row) => isTrusted(row.offerId))
      if (rows.length < 2) return null
      const cheapest = rows[0].blendedUsdPerMtok
      const priciest = rows[rows.length - 1].blendedUsdPerMtok
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

  // 排序口径是美元；文案暂时仍按人民币展示（显示币种开关是下一步的事）
  const priceUsd = Math.round(best.top.blendedUsdPerMtok * 10000) / 10000
  const price = Math.round(priceUsd * fxFor(settings) * 100) / 100
  const providerName = nameOf(best.top.providerId)
  return {
    modelKey: best.modelKey,
    providerName,
    price,
    priceUsd,
    spreadPct: best.spreadPct,
    // 一句人话，别写成「模型 X 目前站点 Y 最便宜」这种机器腔
    text: `此刻 ${best.modelKey} 在 ${providerName} 最便宜，¥${price.toFixed(2)} / 百万 token，比最贵的一家省 ${best.spreadPct}%。`,
  }
}
