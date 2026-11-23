#!/usr/bin/env node
/**
 * 首字相对化：绝对毫秒含本机链路，跨轮不可比；同轮「比最快的慢多少」才是站点的差异。
 *
 * 三件事要成立：
 *  1. 探针记录带 roundId + ttftRel（本轮最小值已减掉）
 *  2. 评分聚合出 ttftRelMs 中位
 *  3. 打平链优先比相对值；只有一条有相对值时回落绝对值
 */
import { scoreOffers } from '../core/score.js'
import { selectCandidates, orderReasonBetween } from '../core/router.js'

let failed = 0
function ok(cond, message) {
  if (cond) console.log('  ✓ ' + message)
  else {
    console.error('  ✗ ' + message)
    failed += 1
  }
}

const now = Date.now()
const probe = (offerId, ttftMs, ttftRel, extra = {}) => ({
  offerId,
  ts: new Date(now - 60_000).toISOString(),
  ok: true,
  ttftMs,
  ttftRel,
  latencyMs: ttftMs * 2,
  fingerprintOk: true,
  truncated: false,
  billingInflated: false,
  ...extra,
})

console.log('评分聚合：相对值取中位，老记录缺失时为 null')
{
  const scores = scoreOffers(
    [probe('a', 900, 20), probe('a', 950, 30), probe('b', 200, null)],
    {},
    { now },
  )
  ok(scores.get('a').ttftMs === 925, '绝对首字取中位（925ms）')
  ok(scores.get('a').ttftRelMs === 25, '相对首字取中位（25ms）')
  ok(scores.get('b').ttftRelMs === null, '没有相对值的老记录 → null')
  ok(scores.get('b').ttftMs === 200, '绝对值仍然可用')
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
const offer = (id) => ({
  id,
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
})
const scoreRow = (id, { ttftMs, ttftRelMs }) => ({
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
  ttftRelMs,
  confidence: 'high',
})

const run = (scores) =>
  selectCandidates({
    offers: [offer('a'), offer('b')],
    providers: [provider],
    credentials: [credential],
    scores: new Map(scores.map((s) => [s.offerId, s])),
    benchmarks: {},
    settings,
    model: 'm',
  })

console.log('打平链：两条都有相对值时按相对值排（绝对值更小的反而在后）')
{
  // a 绝对 900ms 但相对只有 20ms；b 绝对 200ms 但相对 180ms。
  // 说明这一轮本机链路整体快/慢不同，绝对毫秒不可比，站点自身首字 a 更快。
  const rows = run([
    scoreRow('a', { ttftMs: 900, ttftRelMs: 20 }),
    scoreRow('b', { ttftMs: 200, ttftRelMs: 180 }),
  ])
  ok(rows[0].offer.id === 'a', '相对首字更小的 a 排第一')
  ok(rows[1].orderReason === 'tie-ttft', '落败原因标成 tie-ttft')
  ok(/相对值/.test(rows[1].orderReasonText), '解释里点明用的是相对值')
}

console.log('只有一条有相对值时回落到绝对值，不混着比')
{
  const rows = run([
    scoreRow('a', { ttftMs: 200, ttftRelMs: 20 }),
    scoreRow('b', { ttftMs: 900, ttftRelMs: null }),
  ])
  ok(rows[0].offer.id === 'a', '回落到绝对值时 200ms 仍排前面')
  ok(typeof rows[0].ttftRelMs === 'number' && rows[1].ttftRelMs === null, '两条的相对值分别保留')
}

console.log('解释函数：相对值口径写进说明')
{
  const a = { offer: { id: 'a' }, routable: true, sortValue: 1, cacheHitRate: 0.5, ttftMs: 900, ttftRelMs: 20, price: 7 }
  const b = { offer: { id: 'b' }, routable: true, sortValue: 1, cacheHitRate: 0.5, ttftMs: 200, ttftRelMs: 180, price: 7 }
  const reason = orderReasonBetween(a, b, { decisionMode: 'value', stickinessPct: 0.05 })
  ok(reason.code === 'tie-ttft', 'tie-ttft')
  ok(/20ms/.test(reason.text) && /180ms/.test(reason.text), '说明里是相对值而不是 900/200')
}

console.log('')
if (failed > 0) {
  console.error(failed + ' 项失败')
  process.exit(1)
}
console.log('全部通过')
