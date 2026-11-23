#!/usr/bin/env node
/**
 * 期望成本口径：offerCost 的两套价格 + 路由按期望价排序。
 *
 * 核心断言：同一串数字，在「输入占比 99% + 缓存命中 90%」的真实画像下，
 * 期望成本要远低于旧口径（固定 25% 输入权重、忽略缓存）；
 * 并且 `costProfile.mode = 'legacy'` 能一键回到旧口径。
 */
import { offerCost } from '../core/pricing.js'
import { selectCandidates } from '../core/router.js'

let failed = 0
function ok(cond, message) {
  if (cond) console.log('  ✓ ' + message)
  else {
    console.error('  ✗ ' + message)
    failed += 1
  }
}
const near = (a, b, eps = 1e-6) => typeof a === 'number' && Math.abs(a - b) < eps

const settings = {
  blendInputWeight: 0.25,
  fx: { base: 'USD', rates: { CNY: 7.2 } },
  costProfile: { mode: 'expected', inputShare: 'auto', cacheDiscount: 0.9, cacheDiscountEnabled: true },
}

const offer = {
  id: 'o1',
  providerId: 'p1',
  credentialId: 'c1',
  modelKey: 'm',
  upstreamName: 'm',
  group: '',
  pricingMode: 'manual',
  priceUnit: 'per_mtok',
  inPrice: 1,
  outPrice: 4,
  currency: 'USD',
  currencySource: 'custom',
}

console.log('offerCost：两套口径并存')
const legacy = offerCost(offer, settings, {})
ok(near(legacy.blendedUsdPerMtok, 3.25), '旧口径 = 1×0.25 + 4×0.75 = 3.25')
ok(near(legacy.blendedUsdPerMtokExpected, 1.3), '没有画像时，期望口径按默认输入占比 0.9 算 = 1×0.9 + 4×0.1 = 1.3')

const withProfile = offerCost(offer, settings, {}, { cacheHitRate: 0.9, inputShare: 1 })
ok(near(withProfile.inUsdPerMtokEffective, 0.19), '命中 90%、k=0.9 → 有效输入价 1×(1−0.81) = 0.19')
ok(near(withProfile.blendedUsdPerMtokExpected, 0.19), '输入占比 100% → 期望混合价 = 有效输入价')
ok(withProfile.blendedUsdPerMtokExpected < withProfile.blendedUsdPerMtok / 10, '期望成本比旧口径低一个数量级')

const noCache = offerCost(offer, settings, {}, { cacheHitRate: null, inputShare: 0.99 })
ok(near(noCache.inUsdPerMtokEffective, 1), '命中率未知 → 不折扣（按原价，不按 0 罚）')
ok(near(noCache.blendedUsdPerMtokExpected, 1 * 0.99 + 4 * 0.01), '输入占比 99% → 混合价按 99/1 加权')

console.log('开关与回滚')
const legacyMode = offerCost(offer, { ...settings, costProfile: { ...settings.costProfile, mode: 'legacy' } }, {}, { cacheHitRate: 0.9, inputShare: 1 })
ok(near(legacyMode.blendedUsdPerMtokExpected, legacyMode.blendedUsdPerMtok), "mode='legacy' → 期望价等于旧口径（唯一回滚开关）")
const noDiscount = offerCost(offer, { ...settings, costProfile: { ...settings.costProfile, cacheDiscountEnabled: false } }, {}, { cacheHitRate: 0.9, inputShare: 1 })
ok(near(noDiscount.inUsdPerMtokEffective, 1), '关掉缓存折扣 → 有效输入价 = 原价')
const zeroDiscount = offerCost(offer, { ...settings, costProfile: { ...settings.costProfile, cacheDiscount: 0 } }, {}, { cacheHitRate: 0.9, inputShare: 1 })
ok(near(zeroDiscount.inUsdPerMtokEffective, 1), '折扣系数 0 → 有效输入价 = 原价')
ok(near(withProfile.blendedCnyPerMtokExpected, 0.19 * 7.2), '人民币展示值按同一汇率换算')

console.log('按次计费的供给没有混合价')
const perCall = offerCost({ ...offer, priceUnit: 'per_call', callPrice: 0.01 }, settings, {}, { cacheHitRate: 0.9 })
ok(perCall.blendedUsdPerMtokExpected === null, '按次：期望混合价为 null')
ok(perCall.inUsdPerMtokEffective === null, '按次：有效输入价为 null')

console.log('路由：同一份数据，两套口径给出不同排名')
const providers = [{ id: 'p1', name: 'A', currency: 'USD' }, { id: 'p2', name: 'B', currency: 'USD' }]
const credentials = [
  { id: 'c1', providerId: 'p1', secret: 'x', group: '' },
  { id: 'c2', providerId: 'p2', secret: 'y', group: '' },
]
const makeOffer = (id, providerId, credentialId, inPrice, outPrice) => ({
  ...offer,
  id,
  providerId,
  credentialId,
  inPrice,
  outPrice,
})
// A：输入输出都 1（不吃缓存）；B：输入便宜、输出贵，但 95% 命中缓存
const offers = [makeOffer('a', 'p1', 'c1', 1, 1), makeOffer('b', 'p2', 'c2', 0.5, 4)]
const profiles = new Map([
  ['a', { cacheHitRate: 0, inputShare: 0.99 }],
  ['b', { cacheHitRate: 0.95, inputShare: 0.99 }],
])
const scores = new Map(
  offers.map((o) => [
    o.id,
    { offerId: o.id, samples: 10, quality: 1, availability: 1, integrity: 1, status: 'healthy', stale: false, blocked: null, integrityFaults: [], ttftMs: 100, confidence: 0.9 },
  ]),
)
const base = { offers, providers, credentials, scores, benchmarks: {}, model: 'm', settings }

const expectedRows = selectCandidates({ ...base, profiles })
const legacyRows = selectCandidates({
  ...base,
  profiles,
  settings: { ...settings, costProfile: { ...settings.costProfile, mode: 'legacy' } },
})
ok(expectedRows[0].offer.id === 'b', '期望口径：缓存命中高的 B 排第一')
ok(legacyRows[0].offer.id === 'a', '旧口径：名义便宜的 A 排第一（排名确实会变）')
ok(near(expectedRows[0].priceUsdLegacy, 3.125), '行里同时保留旧口径价格，便于对照')
ok(expectedRows[0].cacheHitRate === 0.95, '行里带这条供给用的命中率')
ok(expectedRows[0].costProfile?.mode === 'expected', '行里带口径来源')

console.log('')
if (failed > 0) {
  console.error(failed + ' 项失败')
  process.exit(1)
}
console.log('全部通过')
