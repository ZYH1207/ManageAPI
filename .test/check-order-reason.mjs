#!/usr/bin/env node
/**
 * 「为什么排这里」：每条候选相对上一名的解释，必须和排序真正生效的那一步一致。
 *
 * 解释只读候选行、不改顺序；但如果它和排序口径脱节，用户就会看到
 * 「价差 8 倍却写着粘住上次的站」这种自相矛盾的说明，比没有这一列更糟。
 */
import { selectCandidates, orderReasonBetween } from '../core/router.js'

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

const score = (id, { ttftMs = 100, quality = 1, samples = 10 } = {}) => ({
  offerId: id,
  samples,
  quality,
  availability: 1,
  integrity: 1,
  status: 'healthy',
  stale: false,
  blocked: null,
  integrityFaults: [],
  ttftMs,
  confidence: 'high',
})

function run({ offers, scores, ...extra }) {
  return selectCandidates({
    offers,
    providers: [provider],
    credentials: [credential],
    scores: new Map(scores.map((s) => [s.offerId, s])),
    benchmarks: {},
    settings,
    model: 'm',
    ...extra,
  })
}

console.log('第一名与「价差」')
{
  const rows = run({
    offers: [offer('a', 1, 4), offer('b', 2, 8)],
    scores: [score('a'), score('b')],
  })
  ok(rows[0].orderReason === 'first', '第一名标 first')
  ok(/最优/.test(rows[0].orderReasonText), '第一名说明里写了「最优」')
  ok(rows[1].orderReason === 'key', '第二名牌价差更大 → 标 key')
  ok(/高 \d/.test(rows[1].orderReasonText), '说明里带出「高 N%」')
}

console.log('粘性：价差在阈值内时解释要说「粘住上次」')
{
  const rows = run({
    offers: [offer('a', 1, 4), offer('b', 1.02, 4.08)],
    scores: [score('a'), score('b')],
    stickyOfferId: 'b',
  })
  ok(rows[0].offer.id === 'b', '上次成功的 b 被粘住排第一')
  ok(rows[1].orderReason === 'sticky', '落败那条标 sticky')
  ok(/粘住上次成功的站/.test(rows[1].orderReasonText), '说明里解释了换站会让缓存作废')
}

console.log('价差超出阈值时不能拿粘性解释')
{
  const rows = run({
    offers: [offer('a', 1, 4), offer('b', 2, 8)],
    scores: [score('a'), score('b')],
    stickyOfferId: 'b',
  })
  ok(rows[0].offer.id === 'a', '价差 2 倍，粘性不生效')
  ok(rows[1].orderReason === 'key', '解释退回「排序键」')
}

console.log('打平链：证据量（命中率与首字已在价格/质量里算过）')
{
  const rows = run({
    offers: [offer('a', 1, 4), offer('b', 1, 4)],
    scores: [score('a', { samples: 3 }), score('b', { samples: 12 })],
    profiles: new Map([
      ['a', { inputShare: 0.9, cacheHitRate: 0.95 }],
      ['b', { inputShare: 0.9, cacheHitRate: 0.05 }],
    ]),
  })
  ok(rows[0].offer.id === 'b', '同价同质量时证据多的 b 排前面（不再按命中率排）')
  ok(rows[1].orderReason === 'tie-samples', '解释是 tie-samples')
}

console.log('准入：不可路由的排后面，且解释为「准入」')
{
  const rows = run({
    offers: [offer('a', 0.1, 0.4), offer('b', 1, 4)],
    scores: [score('a', { samples: 0, quality: null, availability: null, integrity: null, status: 'unknown' }), score('b')],
  })
  ok(rows[0].offer.id === 'b', '有证据的 b 排在没证据的 a 前面')
  ok(rows[1].orderReason === 'gate', 'a 的解释是准入')
}

console.log('手动顺序')
{
  const rows = run({
    offers: [offer('a', 1, 4), offer('b', 2, 8)],
    scores: [score('a'), score('b')],
    order: ['b', 'a'],
  })
  ok(rows[0].offer.id === 'b', '手动把贵的 b 提到第一')
  ok(rows[1].orderReason === 'manual', '解释是「手动顺序」')
}

console.log('直接调用解释函数：相同两条返回打平链结论')
{
  const a = { offer: { id: 'a' }, routable: true, sortValue: 1, samples: 10, provider: { quotaRemaining: 100000 }, price: 7 }
  const b = { offer: { id: 'b' }, routable: true, sortValue: 1, samples: 10, provider: { quotaRemaining: 1000 }, price: 7 }
  const reason = orderReasonBetween(a, b, { decisionMode: 'value', stickinessPct: 0.05 })
  ok(reason.code === 'tie-balance', '证据量相同、余额更少 → tie-balance')
  ok(/余额/.test(reason.text), '说明里解释余额')
  const c = { ...b, provider: { quotaRemaining: 100000 } }
  ok(
    orderReasonBetween(a, c, { decisionMode: 'value', stickinessPct: 0.05 }).code === 'tie-order',
    '全同 → tie-order（固定次序，刷新不跳）',
  )
  ok(orderReasonBetween(null, a).code === 'first', '没有上一条时返回 first')
}

console.log('')
if (failed > 0) {
  console.error(failed + ' 项失败')
  process.exit(1)
}
console.log('全部通过')
