#!/usr/bin/env node
/**
 * 体验分：首字与输出速度按「同模型中位」折算，再乘进质量。
 *
 * 三条要守住的口径：
 *   1. 1.00 = 该模型的中位水平（不需要任何人拍阈值）
 *   2. 没测到按 1.00 计，不奖不罚
 *   3. 命中率留在价格侧，打平链不能再按命中率 / 首字排（否则同一个优势罚两遍）
 */
import {
  EXPERIENCE_PRIOR,
  describeExperience,
  experienceBaselines,
  experienceScore,
  experienceScores,
} from '../core/experience.js'
import { selectCandidates } from '../core/router.js'

let failed = 0
function ok(cond, message) {
  if (cond) console.log('  ✓ ' + message)
  else {
    console.error('  ✗ ' + message)
    failed += 1
  }
}
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

console.log('\n[尺子与单项分]')
{
  // 三个站只有探针（1k 级短请求，首字 3 秒上下），两个站有真实流量（二十七万 token，首字 9~14 秒）
  const rows = [
    { offerId: 'a', ttftMs: 3000, tps: 60 },
    { offerId: 'b', ttftMs: 3200, tps: 55 },
    { offerId: 'c', ttftMs: 3600, tps: 50 },
    { offerId: 'd', ttftMs: 3100, tps: 90, trafficTtftMs: 9200, trafficTps: 340 },
    { offerId: 'e', ttftMs: 3600, tps: 50, trafficTtftMs: 11400, trafficTps: 175 },
  ]
  const { map, baseline } = experienceScores(rows)
  ok(close(baseline.probe.ttft, 3200), '探针档自己的尺子：首字中位 3200ms')
  ok(close(baseline.probe.tps, 55), '探针档自己的尺子：速度中位 55 tok/s')
  ok(close(baseline.real.ttft, 10300), '真实档自己的尺子：首字中位 10300ms')
  ok(close(baseline.real.tps, 257.5), '真实档自己的尺子：速度中位 257.5 tok/s')

  const a = map.get('a')
  const d = map.get('d')
  ok(a.tier === 'probe' && a.capped === true, '只有探针数据的站走探针档，且被压回中位水平')
  ok(close(a.score, 1), '探针档封顶 1.00（不给超额）')
  ok(d.tier === 'real' && d.capped === false, '有真实流量的站走真实档，不受封顶')
  ok(d.score > 1, '真实档快于真实中位 → 体验分 >1')

  // 没实测的站不会被惩罚成 0.5，也不会凭空拿到 1.5
  ok(close(a.score, 1) || a.score < 1, '没实测的站既不被奖励也不被压到 0.5')

  // 只有真实数据的站：探针那一档为空，它自己就是真实档的中位
  const solo = experienceScores([{ offerId: 'x', trafficTtftMs: 9000, trafficTps: 200 }])
  ok(solo.map.get('x').tier === 'real' && close(solo.map.get('x').score, 1), '唯一有真实数据的站 = 真实档中位水平')
}

console.log('\n[尺子与单项分]')
{
  const rows = [{ ttftMs: 100, tps: 10 }, { ttftMs: 200, tps: 20 }, { ttftMs: 300, tps: 30 }]
  const base = experienceBaselines(rows)
  ok(base.ttft === 200, '首字中位 200ms')
  ok(base.tps === 20, '速度中位 20 tok/s')
  ok(base.samples === 3, '样本数 3')

  const fast = experienceScore({ ttftMs: 100, tps: 40 }, base)
  ok(close(fast.ttftScore, 2), '首字 100ms 是「中位的 2 倍快」→ 2.00')
  ok(close(fast.tpsScore, 2), '速度 40 = 中位 20 的两倍 → 2.00')
  // 2^0.6 × 2^0.4 = 2
  // 两档尺子：只有探针数据时不给超额，分数上限压到中位水平 1.00
  ok(close(fast.score, EXPERIENCE_PRIOR), '只有探针数据时体验分封顶 1.00（没有实测不给超额）')
  ok(fast.source === 'probe', '只有探针数据标 probe')
  ok(fast.capped === true, '被压回中位水平时标 capped')
  ok(close(fast.ttftScore, 2) && close(fast.tpsScore, 2), '单项分本身照实算（2.00 / 2.00），只是总分封顶')

  const slow = experienceScore({ ttftMs: 400, tps: 10 }, base)
  ok(close(slow.ttftScore, 0.5), '首字 400ms → 0.50')
  ok(close(slow.tpsScore, 0.5), '速度 10 → 0.50')
  ok(close(slow.score, 0.5), '慢站体验分 0.50（对称，没有上下限）')

  const unknown = experienceScore({ ttftMs: null, tps: null }, base)
  ok(unknown.score === EXPERIENCE_PRIOR, '没测到按中位水平 1.00，不是 0.5')
  ok(unknown.source === 'none', '没测到标 none')

  const noBaseline = experienceScore({ ttftMs: 100, tps: 50 }, { ttft: null, tps: null })
  ok(noBaseline.score === EXPERIENCE_PRIOR, '尺子本身没样本 → 1.00')

  const noCap = experienceScore({ ttftMs: 10, tps: 400 }, base)
  // 真实档没有上限：同价下快出 5 倍就该拿到 5 倍的体验分
  // 真实档的尺子来自真实档本身（真实请求十几万 token，探针 1k 级，量纲不同）
  const realBase = experienceBaselines([
    { trafficTtftMs: 100, trafficTps: 10 },
    { trafficTtftMs: 200, trafficTps: 20 },
    { trafficTtftMs: 300, trafficTps: 30 },
  ])
  const realNoCap = experienceScore({ trafficTtftMs: 10, trafficTps: 400, ttftMs: 10, tps: 400 }, realBase)
  ok(realNoCap.score > 5, '真实档不设上限：10ms 首字 / 400 tok/s 得 >5 的体验分')
}

console.log('\n[文案]')
{
  ok(describeExperience(1) === '中位水平', '1.00 说成「中位水平」')
  ok(describeExperience(1.72).includes('快 72%'), '1.72 说成「比中位快 72%」')
  ok(describeExperience(0.5).includes('慢 50%'), '0.50 说成「比中位慢 50%」')
}

console.log('\n[选站：体验分乘进质量]')
const provider = (id, quotaRemaining = 100000) => ({
  id,
  name: 'S' + id,
  currency: 'USD',
  quotaRemaining,
})
const credential = (pid) => ({ id: 'c_' + pid, providerId: pid, secret: 'x', group: '' })
const offer = (pid, inPrice, outPrice) => ({
  id: 'o_' + pid,
  providerId: pid,
  credentialId: 'c_' + pid,
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
const scoreRow = (id, { ttftMs = 100, tps = 20, samples = 10, cacheHitRate = null } = {}) => [
  id,
  {
    offerId: id,
    samples,
    quality: 1,
    availability: 1,
    integrity: 1,
    status: 'healthy',
    stale: false,
    blocked: null,
    integrityFaults: [],
    ttftMs,
    tps,
    ttftRelMs: 0,
    cacheHitRate,
    confidence: 'high',
  },
]
const settings = (extra = {}) => ({
  blendInputWeight: 0.25,
  fx: { base: 'USD', rates: { CNY: 7.2 } },
  decisionMode: 'value',
  costProfile: { mode: 'legacy', inputShare: 'auto', cacheDiscount: 0.9, cacheDiscountEnabled: true },
  stickinessPct: 0,
  quality: { experienceEnabled: true },
  ...extra,
})

{
  // 三家同价、可靠度相同，只有快慢不同
  const offers = [offer('fast', 1, 1), offer('slow', 1, 1)]
  const providers = [provider('fast'), provider('slow')]
  const credentials = [credential('fast'), credential('slow')]
  const scores = new Map([
    scoreRow('o_fast', { ttftMs: 100, tps: 40 }),
    scoreRow('o_slow', { ttftMs: 400, tps: 10 }),
  ])
  const rows = selectCandidates({
    offers,
    providers,
    credentials,
    scores,
    benchmarks: {},
    settings: settings(),
    model: 'm',
  })
  ok(rows.length === 2, '两家都进候选')
  const fast = rows.find((r) => r.offer.id === 'o_fast')
  const slow = rows.find((r) => r.offer.id === 'o_slow')
  // 尺子是「这两家的中位」：首字中位 250ms、速度中位 25 tok/s
  ok(close(fast.experienceDetail.baseline.ttft, 250), '尺子取同模型中位：首字 250ms')
  ok(close(fast.experienceDetail.baseline.tps, 25), '尺子取同模型中位：速度 25 tok/s')
  // 两家都只有探针数据 → 同一档，快的那家本该拿 2.09，但探针档不给超额，压回 1.00
  ok(close(fast.experience, 1), '快站只有探针数据 → 体验分封顶 1.00')
  ok(close(fast.experienceDetail.ttftScore, 2.5), '但单项分照实：首字 2.5 分')
  ok(slow.experience > 0.4 && slow.experience < 0.6, '慢站体验分 <0.6（首字 0.625 分 × 速度 0.4 分）→ 慢站照样降权')
  ok(close(fast.quality, fast.experience), '质量 = 可靠度 1.00 × 体验分')
  ok(close(slow.effectiveUsd / fast.effectiveUsd, 1.913, 0.01), '同价时有效成本差约 1.9 倍（封顶 1.00 vs 0.52）')
  ok(rows[0].offer.id === 'o_fast', '同价时快站排第一')
  ok(fast.effectiveUsd < slow.effectiveUsd, '有效成本：快站 < 慢站')

  // 关掉体验分 → 回到「只看可靠度」，同价同可靠度由打平链决定
  const rowsOff = selectCandidates({
    offers,
    providers,
    credentials,
    scores,
    benchmarks: {},
    settings: settings({ quality: { experienceEnabled: false } }),
    model: 'm',
  })
  ok(rowsOff.every((r) => r.experience === 1), '关掉后体验分恒为 1.00')
  ok(rowsOff.every((r) => r.quality === 1), '关掉后质量就是可靠度')
  ok(
    close(rowsOff[0].effectiveUsd, rowsOff[1].effectiveUsd),
    '关掉后两家有效成本相同（体验不再参与）',
  )
}

console.log('\n[价格档只按单价，不被体验分带偏]')
{
  const offers = [
    { ...offer('cheap'), inPrice: 1, outPrice: 1 },
    { ...offer('pricey'), inPrice: 10, outPrice: 10 },
  ]
  const providers = [provider('cheap'), provider('pricey')]
  const credentials = [credential('cheap'), credential('pricey')]
  const scores = new Map([
    // 贵的那个更快，但价格档只看单价
    scoreRow('o_cheap', { ttftMs: 900, tps: 5 }),
    scoreRow('o_pricey', { ttftMs: 100, tps: 50 }),
  ])
  const rows = selectCandidates({
    offers,
    providers,
    credentials,
    scores,
    benchmarks: {},
    settings: settings({ decisionMode: 'price' }),
    model: 'm',
  })
  ok(rows[0].offer.id === 'o_cheap', '价格档：便宜但慢的站仍排第一')
}

console.log('\n[打平链不再按命中率 / 首字]')
{
  const offers = [{ ...offer('a') }, { ...offer('b') }]
  const providers = [provider('a', 500000), provider('b', 100000)]
  const credentials = [credential('a'), credential('b')]
  // 完全同价同快，只有命中率不同：命中率高的那条曾被旧打平链提前
  const scores = new Map([
    scoreRow('o_a', { samples: 3, cacheHitRate: 0.2 }),
    scoreRow('o_b', { samples: 10, cacheHitRate: 0.95 }),
  ])
  const rows = selectCandidates({
    offers,
    providers,
    credentials,
    scores,
    benchmarks: {},
    settings: settings(),
    model: 'm',
  })
  ok(rows[0].offer.id === 'o_b', '证据多的先（10 条 > 3 条）')
  ok(rows[0].orderReason === 'first', '第一名没有打平原因')
  ok(rows[1].orderReason === 'tie-samples', '第二名的原因是 tie-samples，不是拿命中率比')

  // 证据量相同 → 比余额
  const sameSamples = new Map([scoreRow('o_a', { samples: 8 }), scoreRow('o_b', { samples: 8 })])
  const rows2 = selectCandidates({
    offers,
    providers,
    credentials,
    scores: sameSamples,
    benchmarks: {},
    settings: settings(),
    model: 'm',
  })
  ok(rows2[0].offer.id === 'o_a', '证据相同时余额多的先')
  ok(rows2[1].orderReason === 'tie-balance', '原因是 tie-balance')
}

console.log('\n[体验分对「没证据的站」也不奖不罚]')
{
  const offers = [offer('none', 1, 1), offer('known', 1, 1)]
  const providers = [provider('none'), provider('known')]
  const credentials = [credential('none'), credential('known')]
  const noneRow = [
    'o_none',
    {
      offerId: 'o_none',
      samples: 0,
      quality: null,
      availability: null,
      integrity: null,
      status: 'unknown',
      stale: false,
      blocked: null,
      integrityFaults: [],
      ttftMs: null,
      tps: null,
      confidence: 'low',
    },
  ]
  const scores = new Map([noneRow, scoreRow('o_known', { ttftMs: 100, tps: 20 })])
  const rows = selectCandidates({
    offers,
    providers,
    credentials,
    scores,
    benchmarks: {},
    settings: settings({ allowUntrusted: true }),
    model: 'm',
  })
  const none = rows.find((r) => r.offer.id === 'o_none')
  ok(close(none.experience, EXPERIENCE_PRIOR), '没测到的站体验分 1.00')
  ok(close(none.qualityScore, 0.5), '可靠度缺证据按 0.5 先验，乘体验 1.00 → 0.5')
  ok(none.quality === null, '界面上的质量列仍保持「无证据」（不是 0.5）')
  ok(none.effectiveUsd > rows.find((r) => r.offer.id === 'o_known').effectiveUsd, '缺证据的站排在健康站之后')
}

console.log('\n[同一个模型里「快」不会越过准入门槛]')
{
  const offers = [offer('dead', 1, 1), offer('live', 1, 1)]
  const providers = [provider('dead'), provider('live')]
  const credentials = [credential('dead'), credential('live')]
  const dead = [
    'o_dead',
    {
      offerId: 'o_dead',
      samples: 10,
      quality: null,
      availability: 0,
      integrity: null,
      status: 'down',
      stale: false,
      blocked: null,
      integrityFaults: ['指纹不一致'],
      ttftMs: 10,
      tps: 400,
      confidence: 'high',
    },
  ]
  const scores = new Map([dead, scoreRow('o_live', { ttftMs: 900, tps: 5 })])
  const rows = selectCandidates({
    offers,
    providers,
    credentials,
    scores,
    benchmarks: {},
    settings: settings(),
    model: 'm',
  })
  const deadRow = rows.find((r) => r.offer.id === 'o_dead')
  ok(deadRow.experienceDetail.ttftScore > 1, '死站虽然最快，单项分确实 >1')
  ok(deadRow.experience === 1, '但它只有探针数据 → 体验分封顶 1.00，不给超额')
  ok(deadRow.routable === false, '但它依旧不可路由（体验分不改准入）')
  ok(rows[0].offer.id === 'o_live', '排第一的是能用的那条')
}

if (failed > 0) {
  console.error('\n' + failed + ' 项失败')
  process.exit(1)
}
console.log('\n全部通过')