/**
 * 「没有质量证据」不能当成「质量完美」。
 *
 * 旧口径：effectiveCost(price, null) 里 q=1 → 有效成本 = 名义价，一条从没成功过的
 * 供给在性价比档里和健康站同权；而真坏（quality=0）反而被 0.05 下限罚 20 倍。
 * 结果是「没测过」比「测了不行」更划算，只要打开「放行可疑供给」就会先吃流量。
 *
 * 新口径：null → NO_EVIDENCE_QUALITY（0.5），有效成本 = 名义价 × 2，
 * 位置落在「有证据且质量≥0.5」之后、「质量更差」之前。
 *
 * 用法：node .test/check-no-evidence.mjs
 */
import { effectiveCost, NO_EVIDENCE_QUALITY } from '../core/score.js'
import { selectCandidates } from '../core/router.js'

let failed = 0
function ok(cond, message) {
  if (cond) console.log(`  ✓ ${message}`)
  else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}
const near = (a, b) => Math.abs(a - b) < 1e-9

console.log('[1] effectiveCost 三档语义必须分开')
ok(near(effectiveCost(0.1, 1), 0.1), '质量 1.0 → 有效成本 = 名义价')
ok(near(effectiveCost(0.1, null), 0.1 / NO_EVIDENCE_QUALITY), `没证据 → 名义价 ÷ ${NO_EVIDENCE_QUALITY}`)
ok(near(effectiveCost(0.1, undefined), 0.2), 'undefined 与 null 同口径（0.2）')
ok(near(effectiveCost(0.1, 0), 0.1 / 0.05), '质量 0（探针全败）→ 走 0.05 下限，罚 20 倍')
ok(near(effectiveCost(0.1, 0.25), 0.4), '实测质量 0.25 → 名义价 × 4')
ok(effectiveCost(null, 1) === null, '没有价格 → null（不参与排序）')

// ---------------------------------------------------------------- 排序
const provider = { id: 'p1', name: '测试站' }
const credential = { id: 'c1', providerId: 'p1', group: '' }
const manualOffer = (id, price) => ({
  id,
  providerId: 'p1',
  credentialId: 'c1',
  upstreamName: 'm-test',
  modelKey: 'm-test',
  group: '',
  pricingMode: 'manual',
  priceUnit: 'per_mtok',
  inPrice: price,
  outPrice: price,
  currency: 'USD',
  currencySource: 'custom',
})
const offers = [manualOffer('o-good', 0.1), manualOffer('o-none', 0.1), manualOffer('o-bad', 0.1)]
const scores = new Map([
  [
    'o-good',
    { offerId: 'o-good', samples: 5, quality: 1, availability: 1, integrity: 1, status: 'healthy', stale: false, blocked: null, integrityFaults: [], ttftMs: 100, confidence: 'medium' },
  ],
  [
    'o-none',
    { offerId: 'o-none', samples: 0, quality: null, availability: null, integrity: null, status: 'unknown', stale: false, blocked: null, integrityFaults: [], ttftMs: null, confidence: 'low' },
  ],
  [
    'o-bad',
    { offerId: 'o-bad', samples: 6, quality: 0.25, availability: 0.5, integrity: 1, status: 'unstable', stale: false, blocked: null, integrityFaults: [], ttftMs: 120, confidence: 'medium' },
  ],
])
const base = {
  offers,
  providers: [provider],
  credentials: [credential],
  scores,
  benchmarks: {},
  model: 'm-test',
}

console.log('\n[2] 性价比档：同价时「没证据」不能并列第一')
{
  const rows = selectCandidates({ ...base, settings: { allowUntrusted: true, decisionMode: 'value' } })
  const order = rows.map((r) => r.offer.id)
  ok(order[0] === 'o-good', `健康站排第一（实际 ${order.join(' > ')}）`)
  const none = rows.find((r) => r.offer.id === 'o-none')
  const good = rows.find((r) => r.offer.id === 'o-good')
  ok(near(none.effectiveUsd, 0.2), `没证据的有效成本是名义价的 2 倍（${none.effectiveUsd}）`)
  ok(none.effectiveUsd > good.effectiveUsd, '没证据的有效成本严格大于健康站（不再并列）')
  ok(none.qualityKnown === false, '候选行标出 qualityKnown=false，界面能显示「无证据」')
  ok(good.qualityKnown === true, '有实测质量的标 qualityKnown=true')
  const bad = rows.find((r) => r.offer.id === 'o-bad')
  ok(none.effectiveUsd < bad.effectiveUsd, '质量 0.25 的真坏站仍然比「没证据」更贵')
}

console.log('\n[3] 默认（不放行可疑供给）时没证据的供给仍然不参与路由')
{
  const rows = selectCandidates({ ...base, settings: { allowUntrusted: false, decisionMode: 'value' } })
  const none = rows.find((r) => r.offer.id === 'o-none')
  ok(none.routable === false, 'samples=0 的供给 routable=false')
  ok(rows[0].offer.id === 'o-good', '只有健康站能被选中')
  ok(String(none.statusReason || '').includes('还没探测过'), `理由写明「还没探测过」（实际 ${none.statusReason}）`)
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}
