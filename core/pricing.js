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
import { normalizeDecisionMode, compareByBasis } from './decision-mode.js'

const UNIT_MULTIPLIER = {
  per_mtok: 1,
  per_1k: 1000,
}

/** priceUnit 的合法值域（per_call 走独立的按次分支，不吃倍率换算） */
export const PRICE_UNITS = ['per_mtok', 'per_1k', 'per_call']

/** 人民币展示用的默认汇率；只在「把美元显示成人民币」时用到，不参与排序 */
export const DISPLAY_FX_DEFAULT = 7.2

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * 把一条供给解析成「原始计价」，供后续换算。
 *
 * 口径只有一条，别再在别处各算一遍：
 *   **输入框（offer.inPrice / offer.outPrice）存的是原价，是价格的唯一来源。**
 *   基准价表不是另一个优先级更高的来源，它只负责「第一次把输入框填上」——
 *   和用户手输的价完全平级。所以这里绝不能用基准价去覆盖输入框。
 *
 *   - 倍率模式：实际价 = 输入框原价 × 倍率
 *   - 价格模式：输入框里填的就是最终价，不乘
 *   - 输入框空着（历史数据 / 只填了倍率没填价）才回落到基准价当原价
 *
 * @returns {{inPrice:number|null, outPrice:number|null, currency:string, source:string}|null}
 *   null 表示「标了倍率模式但连原价都没有」——未定价，不能拿别的字段凑数
 */
export function resolveOfferPrice(offer, benchmarks = {}) {
  // 定价模式是谁，就用谁：pricingMode 是权威，
  // 不能拿「倍率有没有填」猜——否则切成手动后残留的倍率会继续把价格乘一遍。
  const key = offer.benchmarkKey || offer.modelKey || offer.upstreamName
  const bench = benchmarks[key]
  const wantsRatio = offer.pricingMode === 'ratio'
  // 注意不能直接 Number(offer.ratio)：null 会被转成 0，把「没填倍率」当成「倍率 0（免费）」
  const hasRatio = offer.ratio !== null && offer.ratio !== undefined && offer.ratio !== ''
  const ratio = hasRatio ? Number(offer.ratio) : NaN

  if (wantsRatio && Number.isFinite(ratio) && ratio >= 0) {
    // 被乘数 = 输入框里的原价；空着才用基准价补位
    const boxIn = finiteOrNull(offer.inPrice)
    const boxOut = finiteOrNull(offer.outPrice)
    const fromBox = boxIn !== null || boxOut !== null
    const baseIn = fromBox ? boxIn : finiteOrNull(bench?.in)
    const baseOut = fromBox ? boxOut : finiteOrNull(bench?.out)

    if (baseIn !== null || baseOut !== null) {
      // 收到 9 位小数：0.75 × 0.2 在浮点下是 0.15000000000000002，
      // 这个尾巴会一路渗到界面和价差计算里（显示、比较、排序都会被噪声扰一下）
      const scale = (v) => (v === null ? null : Math.round(v * ratio * 1e9) / 1e9)
      return {
        inPrice: scale(baseIn),
        outPrice: scale(baseOut),
        // 峰谷只存在于基准价表，输入框没有这一档；仅供展示，不参与排序
        offPeakInPrice: fromBox ? null : scale(finiteOrNull(bench?.offPeakIn)),
        offPeakOutPrice: fromBox ? null : scale(finiteOrNull(bench?.offPeakOut)),
        // 币种跟着「原价是从哪来的」走，别把人民币原价按美元算
        currency: fromBox
          ? (offer.currency === 'CNY' ? 'CNY' : 'USD')
          : (bench.currency === 'CNY' ? 'CNY' : 'USD'),
        source: 'ratio',
      }
    }
  }

  return {
    inPrice: finiteOrNull(offer.inPrice),
    outPrice: finiteOrNull(offer.outPrice),
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

  // ---- 按次计费：inPrice 即「每次请求的价格」，outPrice 不适用。
  // 与按 token 的供给量纲不同，token 口径字段全空——比价排序自然落到组尾，
  // 前端按「/次」显示；免费判定走 free.js 的 per_call 分支。
  if (offer.priceUnit === 'per_call') {
    const raw = resolved.inPrice
    const callUsd =
      raw === null || !Number.isFinite(Number(raw))
        ? null
        : resolved.currency === 'CNY'
          ? Number(raw) / fx
          : Number(raw)
    const callCny =
      raw === null || !Number.isFinite(Number(raw))
        ? null
        : resolved.currency === 'CNY'
          ? Number(raw)
          : Number(raw) * fx
    return {
      perCall: true,
      callPriceUsd: callUsd,
      callPriceCny: callCny,
      inUsdPerMtok: null,
      outUsdPerMtok: null,
      blendedUsdPerMtok: null,
      offPeakInUsdPerMtok: null,
      offPeakOutUsdPerMtok: null,
      offPeakBlendedUsdPerMtok: null,
      inCnyPerMtok: null,
      outCnyPerMtok: null,
      blendedCnyPerMtok: null,
      offPeakBlendedCnyPerMtok: null,
      hasOffPeak: false,
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

  // 缓存读价：命中缓存的部分按它计费，通常远低于输入价。站点没给就退回输入价
  // （保守，不假装有折扣），但要把「是不是真的给了」标出来，界面上能区分
  const cacheReadRaw = offer.cacheReadPrice
  const cacheReadCny =
    cacheReadRaw === null || cacheReadRaw === undefined || !Number.isFinite(Number(cacheReadRaw))
      ? null
      : Number(cacheReadRaw) * mult
  // 缓存写价同理：站点按它收「写入缓存」的钱（通常 1.25× 输入价）
  const cacheWriteRaw = offer.cacheWritePrice
  const cacheWriteCny =
    cacheWriteRaw === null || cacheWriteRaw === undefined || !Number.isFinite(Number(cacheWriteRaw))
      ? null
      : Number(cacheWriteRaw) * mult

  return {
    inUsdPerMtok,
    outUsdPerMtok,
    blendedUsdPerMtok,
    // 缓存读价（人民币/百万 token）；站点没公布时为 null，调用方退回输入价
    cacheReadCnyPerMtok: cacheReadCny,
    cacheReadUsdPerMtok: cacheReadCny === null ? null : cacheReadCny / fx,
    cacheWriteCnyPerMtok: cacheWriteCny,
    cacheWriteUsdPerMtok: cacheWriteCny === null ? null : cacheWriteCny / fx,
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
    // 按次计费：有单价的进正常分组（前端显示「/次」、不参与按 token 的
    // 最便宜判定——量纲不同没法比），没填单价的才算未定价
    if (cost.perCall) {
      if (cost.callPriceUsd === null) unpriced.push(row)
      else {
        const key = offer.modelKey || offer.upstreamName
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(row)
      }
      continue
    }
    if (cost.blendedUsdPerMtok === null) {
      unpriced.push(row)
      continue
    }
    const key = offer.modelKey || offer.upstreamName
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  const ranked = [...groups.entries()].map(([modelKey, rows]) => {
    // 按次计价的行与按 token 的行量纲不同，不能同列比价：排在组尾，
    // 彼此之间按每次单价升序
    rows.sort((a, b) => {
      if (Boolean(a.cost.perCall) !== Boolean(b.cost.perCall)) return a.cost.perCall ? 1 : -1
      if (a.cost.perCall) return a.cost.callPriceUsd - b.cost.callPriceUsd
      if (a.cost.complete !== b.cost.complete) return a.cost.complete ? -1 : 1
      return a.cost.blendedUsdPerMtok - b.cost.blendedUsdPerMtok
    })

    // 最便宜 / 价差只在按 token 的行里算——把按次行混进来会得出假结论
    const tokenRows = rows.filter((r) => !r.cost.perCall)
    const trustedToken = tokenRows.filter((r) => isTrusted(r.offer.id))
    const statsRows = trustedToken.length > 0 ? trustedToken : tokenRows
    const cheapest = statsRows[0]?.cost.blendedUsdPerMtok ?? null
    const priciest = statsRows.length > 1 ? statsRows[statsRows.length - 1].cost.blendedUsdPerMtok : null
    // 0 是合法的「最便宜」（如 blendInputWeight=1 且输入价 0 的促销价），
    // 判空必须用显式 null 比较——此前 cheapest=0 被 falsy 判掉，整组价差全没
    const spreadPct =
      cheapest !== null && priciest !== null && priciest > 0
        ? Math.round(((priciest - cheapest) / priciest) * 100)
        : null
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
        // 按次计费行：blended* 全 null、perCall 标位 + 单次价（CNY 展示口径）
        perCall: Boolean(r.cost.perCall),
        callPriceCny: r.cost.callPriceCny ?? null,
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
          cheapest !== null && cheapest > 0 && r.cost.blendedUsdPerMtok !== null && isTrusted(r.offer.id)
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
      // cheapest=0 合法（同 rankByModel 的处理）；priciest=0 时除零无意义
      if (cheapest === null || priciest === null || priciest <= 0) return null
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
 * 生成一句人话结论——看板页顶部那一句。
 *
 * 数据来自 `decisions`（决策页「当前选」和网关派活用的那份），但**排序口径独立**：
 * 看板有自己的档位（settings.headlineMode），和路由档位（settings.decisionMode）分开。
 * 路由按你定的策略派活；看板只是换一个角度看同一批「能登场」的站——
 * 比如路由按性价比跑，看板上切到「首字速度」看看最快的那个是谁，不用改派活规则。
 *
 * 结论句只说三件事：用哪个站、按什么档算的、那个档的关键数字是多少。
 * 不再写「比最贵的站省 X%」：最贵的那家你本来也不会选，这个百分比只能看着玩。
 *
 * 站点的选法：在**能登场**的候选里按看板档位重新排一遍（不跟路由的手动顺序）。
 * 手动顺序是「派活偏好」，而这句话说的是「按这个档算，谁最好」——两件事别混。
 *
 * 选哪个模型说：用户点过就听用户的（settings.focusModel）；没点过就按
 * 「有真实用量 > 调过手动顺序 > 探过」挑第一个现在真有牌能登场的模型。
 *
 * @param {{decisions: Array, settings: Object, focusModels: string[]}} input
 * @returns {{modelKey, providerName, group, mode, effectiveCny, priceCny, ttftMs}|null}
 */
export function decisionHeadline({ decisions = [], settings = {}, focusModels = [] } = {}) {
  const mode = normalizeDecisionMode(settings.headlineMode)
  // 只留「现在真有牌能登场」的模型：没有可用供给的模型下不了结论
  const usable = decisions.filter(
    (d) => d.chosenOfferId && d.candidates.some((c) => c.offerId === d.chosenOfferId),
  )
  if (usable.length === 0) return null

  const byKey = new Map(usable.map((d) => [d.modelKey, d]))
  const focused = settings.focusModel ? byKey.get(String(settings.focusModel)) : null
  const fromUsage = focusModels.map((key) => byKey.get(key)).find(Boolean)
  const picked = focused || fromUsage || usable[0]
  // 在能登场的牌里按看板档位重排：缺数据（没探过针）的由 compareByBasis 排到最后
  const chosen =
    [...picked.candidates]
      .filter((c) => c.admission?.ok)
      .sort((a, b) => compareByBasis(a, b, mode))[0] || null
  if (!chosen) return null

  return {
    modelKey: picked.modelKey,
    providerName: chosen.providerName ?? picked.chosenProviderName ?? null,
    group: chosen.group || '',
    mode,
    // 三档各自的关键数字（人民币口径，前端按显示币种格式化）；拿不到就是 null
    effectiveCny: chosen.effective ?? null,
    priceCny: chosen.price ?? null,
    ttftMs: typeof chosen.ttftMs === 'number' ? chosen.ttftMs : null,
  }
}
