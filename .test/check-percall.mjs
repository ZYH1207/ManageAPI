/**
 * 按次计费自检（纯函数，不联网）：
 *   1. 模型广场的 billing_mode 能被识别（token / per_request / image）
 *   2. 按次单价按站点算法乘倍率（生图分组用 image_rate_multiplier）
 *   3. 落价时按次模型进 per_call 口径，不会混进 token 比价
 *   4. 从按次切回按量时单位会复位
 *
 * 用法：node .test/check-percall.mjs
 */
import { flattenPlaza } from '../core/model-plaza.js'
import { applySitePricing } from '../core/inventory.js'
import { offerCost, resolveOfferPrice } from '../core/pricing.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

// 结构取自真实站点的 /api/v1/model-plaza（字段一个不少，方便发现解析遗漏）
const plaza = [
  {
    name: '国模-按次',
    rate_multiplier: 0.01,
    image_rate_independent: false,
    image_rate_multiplier: 1,
    models: [
      {
        name: 'deepseek-v4-flash',
        pricing: {
          billing_mode: 'per_request',
          input_price: 1.5e-7,
          output_price: 6e-7,
          per_request_price: 1,
          intervals: [],
        },
        official_pricing: { input_price: 1.5e-7, output_price: 6e-7 },
      },
    ],
  },
  {
    name: 'GPT-img-4K',
    rate_multiplier: 0.15,
    image_rate_independent: true,
    image_rate_multiplier: 1,
    models: [
      {
        name: 'gpt-image-2',
        pricing: {
          billing_mode: 'image',
          input_price: 0.000005,
          output_price: 0.00001,
          per_request_price: 0.15,
          intervals: [],
        },
        official_pricing: { input_price: 0.000005, output_price: 0.00001 },
      },
    ],
  },
  {
    name: '三方自部署',
    rate_multiplier: 0.1,
    models: [
      {
        name: 'deepseek-v4-pro',
        pricing: { billing_mode: 'token', input_price: 0.000002, output_price: 0.000008 },
        official_pricing: { input_price: 1.5e-7, output_price: 6e-7 },
      },
    ],
  },
]

const { byModel } = flattenPlaza(plaza)
const perCall = byModel.get('deepseek-v4-flash')
const image = byModel.get('gpt-image-2')
const token = byModel.get('deepseek-v4-pro')

console.log('[1] 计费形式识别')
{
  ok(perCall.billingMode === 'per_request', `按次 → ${perCall.billingMode}`)
  ok(image.billingMode === 'image', `生图 → ${image.billingMode}`)
  ok(token.billingMode === 'token', `按量 → ${token.billingMode}`)
  ok(token.callPrice === null, '按量模型没有按次单价')
}

console.log('[2] 按次单价 = 站点标价 × 倍率（生图用独立倍率）')
{
  ok(perCall.callPrice === 0.01, `1 × 0.01 = ${perCall.callPrice} 元/次`)
  ok(image.callPrice === 0.15, `0.15 × image_rate_multiplier(1) = ${image.callPrice} 元/次`)
}

console.log('[3] 落价：按次模型进 per_call 口径')
{
  const offer = { priceUnit: 'per_mtok', pricingMode: 'ratio', ratio: 0.01, inPrice: null, outPrice: null }
  const via = applySitePricing(offer, { exact: null, rate: 0.01, sitePrice: perCall, hasBench: true })
  ok(via === 'percall', `落价方式 ${via}`)
  ok(offer.priceUnit === 'per_call', '单位切成按次')
  ok(offer.inPrice === 0.01, `单价写进 inPrice（${offer.inPrice}）`)
  ok(offer.outPrice === null, '按次不区分输入/输出')
  ok(offer.pricingMode === 'manual', '按次走手填模式，不吃倍率换算')

  // 倍率模式不能把按次模型拉回去：有基准价也必须是 per_call
  ok(offer.pricingMode !== 'ratio', '不会被「有基准价就走倍率」抢走')
}

console.log('[4] 比价口径：按次价不参与 token 排序')
{
  const cost = offerCost(
    { priceUnit: 'per_call', inPrice: 0.01, currency: 'CNY', pricingMode: 'manual' },
    { fx: { rates: { CNY: 7 } } },
    {},
  )
  ok(cost.perCall === true, '识别为按次')
  ok(cost.blendedCnyPerMtok === null, 'token 口径为空（不会和 ¥/M 混排）')
  ok(cost.callPriceCny === 0.01, `按次单价 ${cost.callPriceCny} 元/次`)
}

console.log('[4b] 分组倍率解析不到时不把原价写成手填价')
{
  // 站点有分组价（exact 命中），但调用方没解析出倍率（分组名空白差异等）：
  // 必须 skip，不能按原价 × 1 写成 manual——那会把价格放大约 10 倍
  const offer = { priceUnit: 'per_mtok', pricingMode: 'ratio', ratio: 0.045, inPrice: null, outPrice: null }
  const via = applySitePricing(offer, {
    exact: { inPrice: 2, outPrice: 8 },
    rate: null,
    sitePrice: { billingMode: 'token', inPrice: 2, outPrice: 8 },
    hasBench: true,
  })
  ok(via === 'skip', `倍率缺失 → ${via}（不落价）`)
  ok(offer.inPrice === null, '原手填价为空的保持为空')
  ok(offer.ratio === 0.045, '原有倍率不被破坏')

  // 没有 exact（全站回落价）时仍按原价 × 倍率落价
  const fallback = { priceUnit: 'per_mtok', pricingMode: 'ratio', ratio: null, inPrice: null, outPrice: null }
  const via2 = applySitePricing(fallback, {
    exact: null,
    rate: null,
    sitePrice: { billingMode: 'token', inPrice: 2, outPrice: 8 },
    hasBench: false,
  })
  ok(via2 === 'manual', `无分组的全站价 → ${via2}`)
  ok(fallback.inPrice === 2, `按原价落（${fallback.inPrice}）`)
}

console.log('[5] 从按次切回按量时单位复位')
{
  const offer = { priceUnit: 'per_call', inPrice: 0.01, outPrice: null, pricingMode: 'manual' }
  const via = applySitePricing(offer, {
    exact: null,
    rate: 0.1,
    sitePrice: { billingMode: 'token', inPrice: 2, outPrice: 8 },
    hasBench: false,
  })
  ok(via === 'ratio', `落价方式 ${via}（倍率已知就走倍率模式）`)
  ok(offer.priceUnit === 'per_mtok', '单位复位成按量')
  ok(offer.ratio === 0.1, `倍率写进去了（${offer.ratio}）`)
  // 盒里存的是原价，最终价由 resolveOfferPrice 乘出来——这里不能是 0.8
  ok(offer.inPrice === 2 && offer.outPrice === 8, `输入框存原价（${offer.inPrice}/${offer.outPrice}）`)
  const resolved = resolveOfferPrice(offer, {})
  ok(resolved.inPrice === 0.2 && resolved.outPrice === 0.8, `实际价 = 原价 × 倍率（${resolved.inPrice}/${resolved.outPrice}）`)
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}
