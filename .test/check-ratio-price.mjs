/**
 * 倍率定价自检（纯函数，不联网）。
 *
 * 回归的病：倍率模式只认「基准价表 × 倍率」，输入框里的原价被完全绕过。
 * 基准价表里没有这个模型时（新模型、没配过基准价），倍率整条被跳过，
 * 直接把未乘倍率的原价当最终价显示——总计价格虚高十几倍，
 * 表现为「配了倍率却没生效」。
 *
 * 口径：**输入框存的永远是原价**，基准价只是「第一次自动填进去」的默认值，
 * 和手输平级。实际价 = 原价 × 倍率，只由 resolveOfferPrice 一处算。
 *
 * 用法：node .test/check-ratio-price.mjs
 */
import { resolveOfferPrice, offerCost } from '../core/pricing.js'
import { applySitePricing } from '../core/inventory.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

const settings = { blendInputWeight: 0.25, fx: { rates: { CNY: 7 } } }
const base = (extra = {}) => ({
  modelKey: 'deepseek-v4.1-flash',
  upstreamName: 'deepseek-v4.1-flash',
  pricingMode: 'ratio',
  ratio: 0.045,
  inPrice: 2,
  outPrice: 8,
  currency: 'USD',
  priceUnit: 'per_mtok',
  ...extra,
})

console.log('[1] 倍率必须乘在输入框的原价上（基准价表为空也要生效）')
{
  const r = resolveOfferPrice(base(), {})
  ok(r.source === 'ratio', `走倍率分支（${r.source}）`)
  ok(r.inPrice === 0.09, `2 × 0.045 = ${r.inPrice}`)
  ok(r.outPrice === 0.36, `8 × 0.045 = ${r.outPrice}`)

  // 这就是原来那个 bug 的现场：没有基准价表，结果等于原价
  ok(r.inPrice !== 2, '不再把手填原价原样当最终价')
}

console.log('[2] 基准价表不再是更高优先级的来源，不能盖掉输入框')
{
  const bench = { 'deepseek-v4.1-flash': { in: 28, out: 28, currency: 'CNY' } }
  const typed = resolveOfferPrice(base({ inPrice: 30 }), bench)
  ok(typed.inPrice === 1.35, `手输 30 优先于基准价 28（30 × 0.045 = ${typed.inPrice}）`)

  // 输入框空着时才回落到基准价；实际价是站点收的钱，币种跟站点走 ——
  // 基准价只是数值参照（站点模板就是抄官方价的数字，1:1 用，不换算）
  const empty = resolveOfferPrice(base({ inPrice: null, outPrice: null }), bench)
  ok(empty.inPrice === 1.26, `盒空 → 用基准价 28 × 0.045 = ${empty.inPrice}`)
  ok(empty.currency === 'USD', `币种跟站点走，不跟基准价（${empty.currency}）`)
}

console.log('[3] 盒空且无基准价 → 未定价，不能拿别的字段凑数')
{
  const r = resolveOfferPrice(base({ inPrice: null, outPrice: null }), {})
  ok(r.inPrice === null && r.outPrice === null, '价格为空')
  const cost = offerCost(base({ inPrice: null, outPrice: null }), settings, {})
  ok(cost.blendedUsdPerMtok === null, '综合成本为空（会进「还没定价」而不是显示错价）')
}

console.log('[4] 倍率为 0 = 免费，不能被 Number(null) 误判')
{
  const free = resolveOfferPrice(base({ ratio: 0 }), {})
  ok(free.inPrice === 0 && free.outPrice === 0, `倍率 0 → 实际价 0（${free.inPrice}）`)

  // 没填倍率（null）不能被当成 0
  const noRatio = resolveOfferPrice(base({ ratio: null }), {})
  ok(noRatio.source === 'manual', `倍率没填 → 退回手填口径（${noRatio.source}）`)
  ok(noRatio.inPrice === 2, `用输入框里的价（${noRatio.inPrice}）`)
}

console.log('[5] 价格模式：输入框就是最终价，不乘倍率')
{
  const manual = resolveOfferPrice(base({ pricingMode: 'manual', ratio: 0.045 }), {})
  ok(manual.source === 'manual', `走手填分支（${manual.source}）`)
  ok(manual.inPrice === 2, `残留的倍率不参与计算（${manual.inPrice}）`)
}

console.log('[6] 落价：倍率已知就把原价写进输入框，不预先乘好')
{
  const offer = { priceUnit: 'per_mtok', pricingMode: 'manual', ratio: null, inPrice: null, outPrice: null }
  const via = applySitePricing(offer, {
    exact: null,
    rate: 0.045,
    sitePrice: { billingMode: 'token', inPrice: 2, outPrice: 8 },
    hasBench: false,
  })
  ok(via === 'ratio', `落价方式 ${via}（没基准价也能走倍率模式）`)
  ok(offer.inPrice === 2 && offer.outPrice === 8, `输入框存原价（${offer.inPrice}/${offer.outPrice}）`)
  ok(offer.ratio === 0.045, `倍率单独存（${offer.ratio}）`)
  const resolved = resolveOfferPrice(offer, {})
  ok(resolved.inPrice === 0.09, `实际价 = 原价 × 倍率（${resolved.inPrice}）`)

  // 已经手改过的价不被站点价覆盖
  const edited = { priceUnit: 'per_mtok', pricingMode: 'ratio', ratio: 0.045, inPrice: 30, outPrice: 30 }
  applySitePricing(edited, {
    exact: null,
    rate: 0.045,
    sitePrice: { billingMode: 'token', inPrice: 2, outPrice: 8 },
    hasBench: false,
  })
  ok(edited.inPrice === 30, `手改的 30 不被覆盖（${edited.inPrice}）`)
}

console.log('[7] 切模式价格守恒（原价 ⇄ 最终价互转）')
{
  const round3 = (v) => Math.round(v * 1000) / 1000
  const flip = (offer, nextMode) => {
    const prev = offer.pricingMode
    const ratioOf = Number(offer.ratio)
    const hasRatio = Number.isFinite(ratioOf) && ratioOf > 0
    offer.pricingMode = nextMode
    if (nextMode === 'manual' && prev !== 'manual' && hasRatio) {
      offer.inPrice = round3(offer.inPrice * ratioOf)
      offer.outPrice = round3(offer.outPrice * ratioOf)
    }
    if (nextMode === 'ratio' && prev !== 'ratio' && hasRatio) {
      offer.inPrice = round3(offer.inPrice / ratioOf)
      offer.outPrice = round3(offer.outPrice / ratioOf)
    }
    return offer
  }
  const o = base()
  const before = resolveOfferPrice(o, {}).inPrice
  flip(o, 'manual')
  const mid = resolveOfferPrice(o, {}).inPrice
  flip(o, 'ratio')
  const after = resolveOfferPrice(o, {}).inPrice
  ok(mid === before, `倍率 → 价格，实际价不变（${mid}）`)
  ok(after === before, `再切回倍率，实际价不变（${after}）`)
  ok(o.inPrice === 2, `原价还原（${o.inPrice}）`)
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}
