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
// 模型名归一：比价分组 / 基准价查表都用同一套口径，别在这里再写一遍 trim
import { identityKey, benchmarkEntry, pickDisplayName } from './model-name.js'

const UNIT_MULTIPLIER = {
  per_mtok: 1,
  per_1k: 1000,
}

/** priceUnit 的合法值域（per_call 走独立的按次分支，不吃倍率换算） */
export const PRICE_UNITS = ['per_mtok', 'per_1k', 'per_call']

/** 人民币展示用的默认汇率；只在「真实美元 R.Dollar」换算时用到 */
export const DISPLAY_FX_DEFAULT = 7.2

/**
 * 币种口径（2026-10-28 与作者定的规矩）：
 *
 *   - USD  = 中转站标价用的「美元」。这些站模板按美元标价、实际按人民币 1:1 扣费，
 *          所以站内美元数值 = 人民币数值，换算不乘汇率。
 *   - CNY  = 真实人民币。因为 1:1，数值与 USD 相同；常规情况不用，仅作语义标注。
 *   - RUSD = 「真实美元 R.Dollar」，国外模型官方价的专用单位。换算按真实汇率：
 *          1 R.Dollar = fx 个站内美元/人民币。基准价页手动填国外官方价时用它。
 *
 * 内部比较口径（*UsdPerMtok 字段，名字沿用历史）的数值 = 站内美元 = 人民币数值；
 * *CnyPerMtok 与之相等（1:1）。换算只发生在 RUSD 入口这一处。
 */
export function normalizeCurrency(value) {
  const v = String(value || '').toUpperCase()
  if (v === 'CNY') return 'CNY'
  if (v === 'RUSD' || v === 'R.DOLLAR' || v === 'R$') return 'RUSD'
  return 'USD'
}

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
  // 查表带归一：基准价表的键是「导入时的那个名字」，和模型名不一定同形
  // （表里 claude-opus-4-5 与 claude-opus-4.5 并存过）。不归一就会出现
  // 「同一组里一条有价、一条无价」，比价结论直接错
  const bench = benchmarkEntry(benchmarks, key)
  const wantsRatio = offer.pricingMode === 'ratio'
  // 注意不能直接 Number(offer.ratio)：null 会被转成 0，把「没填倍率」当成「倍率 0（免费）」
  const hasRatio = offer.ratio !== null && offer.ratio !== undefined && offer.ratio !== ''
  const ratio = hasRatio ? Number(offer.ratio) : NaN

  if (wantsRatio && Number.isFinite(ratio) && ratio >= 0) {
    // 被乘数 = 输入框里的原价；空着才用基准价补位。
    // 基准价的数值与站点标价同构（站点模板就是抄官方价的数字），永远按 1:1 用，
    // 不做任何币种换算 —— 换算只发生在 officialCost（官方有效成本）那一处。
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
        // 实际价是站点收的钱，币种跟站点走（默认 USD）；基准价只是数字参照
        currency: normalizeCurrency(offer.currency),
        source: 'ratio',
      }
    }
  }

  return {
    inPrice: finiteOrNull(offer.inPrice),
    outPrice: finiteOrNull(offer.outPrice),
    offPeakInPrice: null,
    offPeakOutPrice: null,
    currency: normalizeCurrency(offer.currency),
    source: 'manual',
  }
}

/**
 * 单个模型供给的实际成本。
 *
 * 比较口径是**站内美元/每百万 token**：中转站按美元标价、实际按人民币 1:1 扣费，
 * 所以站内美元数值 = 人民币数值，换算不需要汇率。人民币只是同一数值的另一读法
 * （`*CnyPerMtok` 恒等于 `*UsdPerMtok`，字段名沿用历史）。
 *
 * 唯一的例外是「真实美元 R.Dollar」：国外模型的官方价用它标注，
 * 按 `fx.rates.CNY` 换算成站内口径（见 normalizeCurrency 的口径说明）。
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
      cacheReadCnyPerMtok: null,
      complete: false,
    }
  }

  // ---- 按次计费：inPrice 即「每次请求的价格」，outPrice 不适用。
  // 与按 token 的供给量纲不同，token 口径字段全空——比价排序自然落到组尾，
  // 前端按「/次」显示；免费判定走 free.js 的 per_call 分支。
  if (offer.priceUnit === 'per_call') {
    const raw = resolved.inPrice
    // R.Dollar 按真实汇率折站内口径；站内美元/CNY 与人民币 1:1，数值原样
    const siteRate = resolved.currency === 'RUSD' ? fx : 1
    const callUsd =
      raw === null || !Number.isFinite(Number(raw)) ? null : Number(raw) * siteRate
    const callCny = callUsd // 1:1，同一数值的另一种读法
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

  // 换算收口在这一行：只有 R.Dollar 乘真实汇率，站内美元/CNY 都是 1:1
  const siteRate = resolved.currency === 'RUSD' ? fx : 1
  const toUsd = (price) => {
    if (price === null || !Number.isFinite(price)) return null
    return price * mult * siteRate
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

  // 站内美元与人民币 1:1，两个口径是同一个数值（字段名沿用历史）
  const toCny = (usd) => usd

  // 缓存读价：命中缓存的部分按它计费，通常远低于输入价。站点没给就退回输入价
  // （保守，不假装有折扣），但要把「是不是真的给了」标出来，界面上能区分。
  // 币种换算与主价同一条规则（只有 R.Dollar 乘汇率）
  const cacheReadRaw = offer.cacheReadPrice
  const cacheReadCny =
    cacheReadRaw === null || cacheReadRaw === undefined || !Number.isFinite(Number(cacheReadRaw))
      ? null
      : Number(cacheReadRaw) * mult * siteRate
  // 缓存写价同理：站点按它收「写入缓存」的钱（通常 1.25× 输入价）
  const cacheWriteRaw = offer.cacheWritePrice
  const cacheWriteCny =
    cacheWriteRaw === null || cacheWriteRaw === undefined || !Number.isFinite(Number(cacheWriteRaw))
      ? null
      : Number(cacheWriteRaw) * mult * siteRate

  return {
    inUsdPerMtok,
    outUsdPerMtok,
    blendedUsdPerMtok,
    // 缓存读价（站内口径，= 人民币/百万 token）；站点没公布时为 null，调用方退回输入价
    cacheReadCnyPerMtok: cacheReadCny,
    cacheReadUsdPerMtok: cacheReadCny,
    cacheWriteCnyPerMtok: cacheWriteCny,
    cacheWriteUsdPerMtok: cacheWriteCny,
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
 * 官方有效成本：拿基准价表当「官方价」，走 offerCost 同一条算法。
 *
 * 口径与站内供给完全一致：
 *   - 混合权重 settings.blendInputWeight（默认输入 25% / 输出 75%）
 *   - 币种换算同一条规则：真实美元 R.Dollar 乘汇率，站内美元/CNY 1:1
 *   - 质量无数据按 1 —— 官方价不存在降智，有效成本就是综合成本
 *
 * 基准价填了峰谷价（如 DeepSeek 空闲时段减半）时，同时返回
 * offPeakBlendedCnyPerMtok，比价组头分「峰 / 谷」展示。
 *
 * @param {{in:number|null, out:number|null, offPeakIn:number|null, offPeakOut:number|null,
 *            currency:string}|undefined} bench 基准价条目
 * @returns {{in:number|null, out:number|null, currency:string,
 *            blendedUsdPerMtok:number|null, blendedCnyPerMtok:number|null,
 *            offPeakBlendedCnyPerMtok:number|null, hasOffPeak:boolean}|null}
 *   bench 缺失或两个价都空时返回 null（没官方价，不硬凑）
 */
export function officialCost(bench, settings = {}) {
  if (!bench) return null
  const inPrice = finiteOrNull(bench.in)
  const outPrice = finiteOrNull(bench.out)
  if (inPrice === null && outPrice === null) return null
  const currency = normalizeCurrency(bench.currency)
  const pseudo = { currency, priceUnit: 'per_mtok', pricingMode: 'manual' }
  const peak = offerCost({ ...pseudo, inPrice, outPrice }, settings, {})
  // 峰谷价（如 DeepSeek 空闲时段减半）：缺一侧回落到高峰价，与 offerCost 同一回落；
  // offerCost 的峰谷只从基准价分支来，这里直接把谷价当主价再算一次，同一算法
  const hasOffPeak = finiteOrNull(bench.offPeakIn) !== null || finiteOrNull(bench.offPeakOut) !== null
  const offPeak = hasOffPeak
    ? offerCost(
        {
          ...pseudo,
          inPrice: finiteOrNull(bench.offPeakIn) ?? inPrice,
          outPrice: finiteOrNull(bench.offPeakOut) ?? outPrice,
        },
        settings,
        {},
      )
    : null
  return {
    in: inPrice,
    out: outPrice,
    currency,
    blendedUsdPerMtok: peak.blendedUsdPerMtok,
    blendedCnyPerMtok: peak.blendedCnyPerMtok,
    offPeakBlendedCnyPerMtok: offPeak ? offPeak.blendedCnyPerMtok : null,
    hasOffPeak,
  }
}

/**
 * 按归一化模型分组，组内按综合成本升序。
 *
 * 不可信的供给仍然列出（价格信息本身有用），但不参与「最便宜」与价差的判定，
 * 否则会和 headline、路由的选择打架。
 */
/**
 * 比价分组键：一个模型一行，不看站点把它写成什么名字。
 *
 * 这里是「同模型合并」在比价侧的唯一生效点：deepseek-v4.1-flash 与
 * deepseek-4.1-flash、claude-opus-4-5-20251101 与 claude-opus-4.5 必须落进同一行，
 * 否则用户看到的「同一个模型两个价」其实是两行各自的最低价，价差结论也跟着错。
 * 只影响分组键——写给上游的 model 仍旧是 offer.upstreamName，一个字不改。
 */
function modelGroupKey(offer, aliases) {
  return identityKey(offer.modelKey || offer.upstreamName, aliases) || offer.modelKey || offer.upstreamName
}

export function rankByModel(offers, settings = {}, benchmarks = {}, isTrusted = () => true) {
  const groups = new Map()
  const unpriced = []
  const aliases = settings?.modelAliases || null

  for (const offer of offers) {
    const cost = offerCost(offer, settings, benchmarks)
    const row = { offer, cost }
    // 按次计费：有单价的进正常分组（前端显示「/次」、不参与按 token 的
    // 最便宜判定——量纲不同没法比），没填单价的才算未定价
    if (cost.perCall) {
      if (cost.callPriceUsd === null) unpriced.push(row)
      else {
        const key = modelGroupKey(offer, aliases)
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(row)
      }
      continue
    }
    if (cost.blendedUsdPerMtok === null) {
      unpriced.push(row)
      continue
    }
    const key = modelGroupKey(offer, aliases)
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
      // 展示名：分组键是归一键（deepseek-4.1-flash），给人看的应该是公认写法
      // （deepseek-v4.1-flash）。基准价表的键就是现有最靠谱的「公认写法」线索
      display: pickDisplayName(
        rows.map((r) => r.offer.upstreamName),
        Object.keys(benchmarks || {}),
      ),
      // 这一组混了哪几种写法：合并后必须能看见，否则「为什么这两个价在一行」没法解释
      variants: [...new Set(rows.map((r) => r.offer.upstreamName))].sort(),
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
 * 全场冠军行——看板顶部第二句。
 *
 * 第一句（decisionHeadline）回答「你关注的这个模型，谁给它当家」；这一句把口径
 * 放大到全部模型：每家模型各自「能登场」的牌先放着，全站合在一起按档位比一次，
 * 挑出那一张真正的全场第一——回答「全站未被忽略的模型里，谁家谁是尖子」。
 * 数据仍然只吃 decisions（未忽略、填了价的模型），和第一句同一批原料：
 * 没填价的模型三档里两档没法比，放进来只会让冠军名次没法解释。
 *
 * 档位是自己的（settings.championMode），和第一句的 headlineMode 分开存：
 * 上面看某个模型的速度，下面看全场谁最便宜，两句话各看各的互不带偏。
 * 排序口径仍然是 compareByBasis（唯一实现），不许在这里另写一份。
 *
 * @returns {{modelKey, providerName, group, mode, effectiveCny, priceCny, ttftMs}|null}
 */
export function decisionChampion({ decisions = [], settings = {} } = {}) {
  const mode = normalizeDecisionMode(settings.championMode)
  const pool = []
  for (const d of decisions) {
    for (const c of d.candidates) {
      if (c.admission?.ok) pool.push({ ...c, modelKey: d.modelKey })
    }
  }
  // 不登场的牌不进池子，所以排序结果天然没有「脏牌夺冠」；空池返回 null，前端不画
  const champion = pool.sort((a, b) => compareByBasis(a, b, mode))[0] || null
  if (!champion) return null
  return {
    modelKey: champion.modelKey,
    providerName: champion.providerName ?? null,
    group: champion.group || '',
    mode,
    // 三档各自的关键数字（人民币口径，前端按显示币种格式化）；拿不到就是 null
    effectiveCny: champion.effective ?? null,
    priceCny: champion.price ?? null,
    ttftMs: typeof champion.ttftMs === 'number' ? champion.ttftMs : null,
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
