#!/usr/bin/env node
/**
 * 打平链与粘性：排序键相同时谁先；价差很小时是否留在上次成功的站。
 *
 * 两条规则都只影响「一样好/差不多好」时的次序，不改变任何准入判定。
 */
import { selectCandidates } from '../core/router.js'

let failed = 0
function ok(cond, message) {
  if (cond) console.log('  ✓ ' + message)
  else {
    console.error('  ✗ ' + message)
    failed += 1
  }
}

const settings = {
  blendInputWeight: 0.25,
  fx: { base: 'USD', rates: { CNY: 7.2 } },
  decisionMode: 'value',
  costProfile: { mode: 'legacy', inputShare: 'auto', cacheDiscount: 0.9, cacheDiscountEnabled: true },
  stickinessPct: 0.05,
}

const provider = { id: 'p1', name: 'S', currency: 'USD' }
const credential = { id: 'c1', providerId: 'p1', secret: 'x', group: '' }

const offer = (id, inPrice, outPrice) => ({
  id,
  providerId: 'p1',
  credentialId: 'c1',
  modelKey: 'm',
  upstreamName: 'm',
  group: '',
  pricingMode: 'manual',
  priceUnit: 'per_mtok',
  inPrice,
  outPrice,
  currency: 'USD',
  currencySource: 'custom',
})

const healthy = (id, ttftMs = 100) => [
  id,
  {
    offerId: id,
    samples: 10,
    quality: 1,
    availability: 1,
    integrity: 1,
    status: 'healthy',
    stale: false,
    blocked: null,
    integrityFaults: [],
    ttftMs,
    confidence: 'high',
  },
]

console.log('排序键相同时：证据多的先（命中率已折进价格，不再比第二次）')
{
  const offers = [offer('a', 1, 1), offer('b', 1, 1)]
  const scores = new Map([
    ['a', { ...healthy('a')[1], samples: 3 }],
    ['b', { ...healthy('b')[1], samples: 10 }],
  ])
  // 命中率差很大，但 legacy 口径下它不进价格；打平链也不该拿它当依据，
  // 否则「价格里罚一次、次序上再罚一次」= 同一个优势算两遍。
  const profiles = new Map([
    ['a', { cacheHitRate: 0.95, inputShare: 0.99 }],
    ['b', { cacheHitRate: 0.05, inputShare: 0.99 }],
  ])
  const rows = selectCandidates({ offers, providers: [provider], credentials: [credential], scores, benchmarks: {}, settings, model: 'm', profiles })
  ok(rows[0].offer.id === 'b', '同价同质量时，证据多的 b 排在前面（不看命中率）')
  ok(rows[1].orderReason === 'tie-samples', '解释是 tie-samples')
}

console.log('排序键、证据都相同时：余额多的先')
{
  const offers = [offer('a', 1, 1), offer('b', 1, 1)]
  const providers = [
    { ...provider, id: 'p1', quotaRemaining: 1000 },
    { ...provider, id: 'p2', name: 'T', quotaRemaining: 900000 },
  ]
  const offers2 = [
    { ...offer('a', 1, 1), providerId: 'p1' },
    { ...offer('b', 1, 1), providerId: 'p2' },
  ]
  const credentials = [
    { id: 'c1', providerId: 'p1', secret: 'x', group: '' },
    { id: 'c2', providerId: 'p2', secret: 'x', group: '' },
  ]
  const scores = new Map([
    ['a', { ...healthy('a')[1], samples: 10 }],
    ['b', { ...healthy('b')[1], samples: 10 }],
  ])
  const rows = selectCandidates({ offers: offers2, providers, credentials, scores, benchmarks: {}, settings, model: 'm' })
  ok(rows[0].offer.id === 'b', '同价、同证据量时余额多的 b 先（能跑更久）')
  ok(rows[1].orderReason === 'tie-balance', '解释是 tie-balance')
}

console.log('粘性：价差在阈值内时留在上次成功的站')
{
  // a 比 b 便宜 2%，但 b 是上次成功的站
  const offers = [offer('a', 1.0, 1.0), offer('b', 1.02, 1.02)]
  const scores = new Map([healthy('a'), healthy('b')])
  const profiles = new Map([
    ['a', { cacheHitRate: 0.5, inputShare: 1 }],
    ['b', { cacheHitRate: 0.5, inputShare: 1 }],
  ])
  const base = { offers, providers: [provider], credentials: [credential], scores, benchmarks: {}, model: 'm', profiles }
  const sticky = selectCandidates({ ...base, stickyOfferId: 'b', stickinessPct: 0.05 })
  ok(sticky[0].offer.id === 'b', '价差 2% < 5% → 仍然选上次成功的 b')
  ok(sticky[0].sticky === true, 'b 这一行带 sticky 标记（响应头据此打 X-ManageAPI-Sticky）')
  const noSticky = selectCandidates({ ...base, stickyOfferId: 'b', stickinessPct: 0 })
  ok(noSticky[0].offer.id === 'a', '粘性关掉（阈值 0）→ 回到纯按价格排，选更便宜的 a')
  const bigGap = selectCandidates({
    ...base,
    offers: [offer('a', 1.0, 1.0), offer('b', 1.2, 1.2)],
    stickyOfferId: 'b',
    stickinessPct: 0.05,
  })
  ok(bigGap[0].offer.id === 'a', '价差 20% > 5% → 粘性不生效，选便宜的 a')
}

console.log('粘性不能盖过准入：不可用的站再粘也不排第一')
{
  const offers = [offer('a', 1.0, 1.0), offer('b', 1.02, 1.02)]
  const scores = new Map([
    healthy('a'),
    [
      'b',
      { offerId: 'b', samples: 0, quality: null, availability: null, integrity: null, status: 'unknown', stale: false, blocked: null, integrityFaults: [], ttftMs: null, confidence: null },
    ],
  ])
  const profiles = new Map([['a', { cacheHitRate: 0.5, inputShare: 1 }]])
  const rows = selectCandidates({
    offers,
    providers: [provider],
    credentials: [credential],
    scores,
    benchmarks: {},
    settings,
    model: 'm',
    profiles,
    stickyOfferId: 'b',
    stickinessPct: 0.05,
  })
  ok(rows[0].offer.id === 'a', 'b 没有可信样本 → 仍排在健康的 a 后面（粘性只调次序，不放宽准入）')
}

console.log('手动顺序仍然最高优先')
{
  const offers = [offer('a', 1.0, 1.0), offer('b', 2.0, 2.0)]
  const scores = new Map([healthy('a'), healthy('b')])
  const rows = selectCandidates({
    offers,
    providers: [provider],
    credentials: [credential],
    scores,
    benchmarks: {},
    settings,
    model: 'm',
    order: ['b', 'a'],
  })
  ok(rows[0].offer.id === 'b', '用户手动把 b 排到第一 → b 第一（价格更贵也一样）')
}

console.log('')
if (failed > 0) {
  console.error(failed + ' 项失败')
  process.exit(1)
}
console.log('全部通过')
