#!/usr/bin/env node
/**
 * 路由编排自检：速度模型 + 余额守卫 + 兜底阶梯。
 *
 * 核心要验的三件事：
 *   1. 探针 → 真实 的标定能算出来，且比裸探针准
 *   2. 余额低于阈值只「降级」不「排除」，余额为 0 才硬排除
 *   3. 兜底阶梯**永不为空**（只要还有余额不为 0 的供给）—— 这是「不报错」的保证
 */

import assert from 'node:assert/strict'
import { buildCalibration, estimateSpeed, speedMetric, calibrationSummary, SOURCE_CONFIDENCE, CALIBRATION_CLAMP, estimateTotalWait, estimateOutputTokens } from '../core/speed-model.js'
import { assessBalance, BALANCE, dailySpendByProvider } from '../core/balance-guard.js'
import { tierOf, buildLadder, rescueFromEmpty, TIER, TIER_LABEL } from '../core/fallback-ladder.js'
import { buildRoutingContext, scoreRow, decideRoute, SCORING } from '../core/route-orchestrator.js'

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); fail++ }
}

console.log('\n[1/4] 速度模型：标定')

check('有真实数据就直接用真实值', () => {
  const est = estimateSpeed({ ttftMs: 2000, realTtftMs: 9000, realTtftSamples: 10 })
  assert.equal(est.source, 'real')
  assert.equal(est.ms, 9000)
  assert.equal(est.confidence, SOURCE_CONFIDENCE.real)
})

check('只有探针 + 有标定 → 用标定比值校正', () => {
  const cal = buildCalibration([
    { offerId: 'a', probeTtftMs: 1000, realTtftMs: 4000 },
    { offerId: 'b', probeTtftMs: 1000, realTtftMs: 4000 },
    { offerId: 'c', probeTtftMs: 1000, realTtftMs: 4000 },
  ])
  assert.equal(cal.global, 4)
  const est = estimateSpeed({ ttftMs: 1000 }, { calibration: cal })
  assert.equal(est.source, 'calibrated')
  assert.equal(est.ms, 4000, '2000×4 应该校正到 4000')
})

check('只有探针 + 无标定 → 裸探针，置信度最低', () => {
  const est = estimateSpeed({ ttftMs: 1500 }, { calibration: null })
  assert.equal(est.source, 'probe')
  assert.equal(est.ms, 1500)
  assert.ok(est.confidence < SOURCE_CONFIDENCE.calibrated)
})

check('什么都没有 → source=none，但 ms 是 null 不是 Infinity', () => {
  const est = estimateSpeed({})
  assert.equal(est.source, 'none')
  assert.equal(est.ms, null, '不能返回 Infinity，那会污染后续计算')
})

check('标定样本不足时不算（避免用 1 个样本瞎猜）', () => {
  const cal = buildCalibration([{ probeTtftMs: 1000, realTtftMs: 9000 }])
  assert.equal(cal.global, null)
})

check('标定比值被夹在合理范围内（防离群值）', () => {
  const cal = buildCalibration([
    { probeTtftMs: 1, realTtftMs: 100000 },  // 离谱的 100000 倍
    { probeTtftMs: 1, realTtftMs: 100000 },
    { probeTtftMs: 1, realTtftMs: 100000 },
  ])
  assert.ok(cal.global <= CALIBRATION_CLAMP.max, `应被夹到 ${CALIBRATION_CLAMP.max}，实际 ${cal.global}`)
})

check('按供给标定优先于按站点', () => {
  const pairs = []
  for (let i = 0; i < 3; i++) pairs.push({ offerId: 'special', providerId: 'p1', probeTtftMs: 1000, realTtftMs: 10000 })
  for (let i = 0; i < 3; i++) pairs.push({ offerId: `other${i}`, providerId: 'p1', probeTtftMs: 1000, realTtftMs: 2000 })
  const cal = buildCalibration(pairs)
  const est = estimateSpeed({ ttftMs: 1000 }, { calibration: cal, offerId: 'special', providerId: 'p1' })
  assert.equal(est.ratio, 10, '应该用该供给自己的 10 倍，不是站点的 2 倍')
})

check('置信度越低，排序标量越保守（往上调）', () => {
  const real = speedMetric({ ms: 1000, confidence: 1.0 })
  const calibrated = speedMetric({ ms: 1000, confidence: 0.6 })
  const probe = speedMetric({ ms: 1000, confidence: 0.3 })
  assert.equal(real, 1000)
  assert.ok(calibrated > real, '标定的应该比实测保守')
  assert.ok(probe > calibrated, '裸探针应该最保守')
})

console.log('\n[1b/4] 速度模型：吐字速度与总等待')

check('长回答时吐字速度主导（首字快但吐字慢的站会输）', () => {
  // 站A：首字 1s，吐字慢（200ms/token = 5 tok/s）
  // 站B：首字 4s，吐字快（20ms/token = 50 tok/s）
  const aLong = estimateTotalWait(1000, 200, 2000)
  const bLong = estimateTotalWait(4000, 20, 2000)
  assert.ok(aLong.totalMs > bLong.totalMs * 5,
    `长回答时 B 应远快于 A：A=${aLong.totalMs} B=${bLong.totalMs}`)
})

check('短回答时首字还可能主导（A 仍可能赢）', () => {
  const aShort = estimateTotalWait(1000, 200, 10)   // 只输出 10 token
  const bShort = estimateTotalWait(4000, 20, 10)
  assert.ok(aShort.totalMs < bShort.totalMs, '极短输出时首字快的应该赢')
})

check('没有吐字数据 → 退回只看首字，并标 known=false', () => {
  const r = estimateTotalWait(3000, null, 1000)
  assert.equal(r.totalMs, 3000)
  assert.equal(r.known, false, '要知道这是不完整的估计')
})

check('首字未知 → Infinity（不参与比较）', () => {
  assert.equal(estimateTotalWait(null, 10, 100).totalMs, Infinity)
})

check('max_tokens 按 50% 折算（上限不是预期值）', () => {
  assert.equal(estimateOutputTokens({ maxTokens: 4000 }).tokens, 2000)
  assert.equal(estimateOutputTokens({ maxTokens: 4000 }).source, 'max-tokens')
})

check('没有 max_tokens 用历史均值', () => {
  const r = estimateOutputTokens({ historicalAvg: 800 })
  assert.equal(r.tokens, 800)
  assert.equal(r.source, 'historical')
})

check('什么都没有用保守兜底', () => {
  const r = estimateOutputTokens({})
  assert.equal(r.source, 'fallback')
  assert.ok(r.tokens > 0)
})

console.log('\n[2/4] 余额守卫：阈值切换但不报错')

check('余额充足 → healthy', () => {
  const a = assessBalance({ quotaRemaining: 100 }, { dailySpend: 10 })
  assert.equal(a.state, BALANCE.HEALTHY)
  assert.equal(a.penalty, 1.0)
})

check('余额低于 3 天 → low（降级但可用）', () => {
  const a = assessBalance({ quotaRemaining: 20 }, { dailySpend: 10 })
  assert.equal(a.state, BALANCE.LOW)
  assert.ok(a.penalty > 1 && Number.isFinite(a.penalty), 'low 必须有限惩罚 = 仍可用')
})

check('余额低于 1 天 → critical（只作兜底）', () => {
  const a = assessBalance({ quotaRemaining: 5 }, { dailySpend: 10 })
  assert.equal(a.state, BALANCE.CRITICAL)
  assert.ok(a.penalty > assessBalance({ quotaRemaining: 20 }, { dailySpend: 10 }).penalty)
})

check('余额为 0 → empty（硬排除，penalty=Infinity）', () => {
  const a = assessBalance({ quotaRemaining: 0 }, { dailySpend: 10 })
  assert.equal(a.state, BALANCE.EMPTY)
  assert.equal(a.penalty, Infinity)
})

check('读不到余额 → unknown，几乎不惩罚', () => {
  const a = assessBalance({ quotaRemaining: null })
  assert.equal(a.state, BALANCE.UNKNOWN)
  assert.ok(a.penalty < 1.2, '不知道不该重罚')
})

check('无消耗数据时退回绝对阈值', () => {
  const a = assessBalance({ quotaRemaining: 3 }, { warnThreshold: 5, dailySpend: null })
  assert.equal(a.state, BALANCE.LOW)
})

check('相对判定优先于绝对阈值（能撑很久就不算低）', () => {
  // 余额只有 3（低于阈值 5），但每天只花 0.1 → 能撑 30 天 → 应该是 healthy
  const a = assessBalance({ quotaRemaining: 3 }, { warnThreshold: 5, dailySpend: 0.1 })
  assert.equal(a.state, BALANCE.HEALTHY, '能撑 30 天不该因为绝对余额小就被降级')
})

check('日均消耗按站点聚合', () => {
  // 桶的 key 是「UTC 小时」，而 dailySpendByProvider 会按 now - days 算 cutoff。
  // 原来这里钉了 '2026-10-31T00'，日子一过 cutoff 就把它整片滤掉，
  // map 变成空、断言拿 undefined——不是产品坏了，是 fixture 会自己过期。
  // 改成相对现在算，跑多久都对。
  const hour = new Date(Date.now() - 3600_000).toISOString().slice(0, 13)
  const stats = {
    [`o1|${hour}`]: { requests: 10, estCostSum: 5 },
    [`o2|${hour}`]: { requests: 10, estCostSum: 5 },
  }
  const offers = [{ id: 'o1', providerId: 'p1' }, { id: 'o2', providerId: 'p1' }]
  const map = dailySpendByProvider(stats, offers, { days: 1 })
  assert.equal(map.get('p1'), 10)
})

console.log('\n[3/4] 兜底阶梯：永不为空')

check('无探针证据的供给仍进链（这是修掉崩溃的关键）', () => {
  const rows = [
    { offer: { id: 'a' }, admission: { ok: false, kind: 'no-evidence' } },
    { offer: { id: 'b' }, admission: { ok: false, kind: 'no-evidence' } },
  ]
  const ladder = buildLadder(rows)
  assert.equal(ladder.chain.length, 2, '旧逻辑这里会是 0 → 客户端 400')
  assert.equal(ladder.chain[0].tier, TIER.NO_EVIDENCE)
})

check('慢速供给进链（慢 != 不能用）', () => {
  const rows = [{ offer: { id: 'a' }, admission: { ok: false, kind: 'slow' } }]
  assert.equal(buildLadder(rows).chain[0].tier, TIER.SLOW)
})

check('降级/不稳定也进链（比报错强）', () => {
  const rows = [{ offer: { id: 'a' }, admission: { ok: false, kind: 'degraded' } }]
  assert.equal(buildLadder(rows).chain[0].tier, TIER.DEGRADED)
})

check('余额为 0 的被硬排除', () => {
  const rows = [{ offer: { id: 'a' }, balanceDepleted: true, admission: { ok: false } }]
  const ladder = buildLadder(rows)
  assert.equal(ladder.chain.length, 0)
  assert.equal(ladder.hardFails.length, 1)
})

check('本次已试过的不再进链（防死循环）', () => {
  const rows = [{ offer: { id: 'a' }, admission: { ok: true } }]
  assert.equal(buildLadder(rows, { tried: new Set(['a']) }).chain.length, 0)
})

check('阶梯按优先级排序：准入 → 慢 → 无证据 → 降级', () => {
  const rows = [
    { offer: { id: 'deg' }, admission: { ok: false, kind: 'degraded' } },
    { offer: { id: 'ok' }, admission: { ok: true } },
    { offer: { id: 'noev' }, admission: { ok: false, kind: 'no-evidence' } },
    { offer: { id: 'slow' }, admission: { ok: false, kind: 'slow' } },
  ]
  const ids = buildLadder(rows).chain.map((r) => r.offer.id)
  assert.deepEqual(ids, ['ok', 'slow', 'noev', 'deg'])
})

check('每级有条数上限（防止一次请求试几十个站）', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ offer: { id: `a${i}` }, admission: { ok: true } }))
  assert.equal(buildLadder(rows, { maxPerTier: 3 }).chain.length, 3)
})

check('全空时强制兜底（最后一道防线）', () => {
  const rows = [{ offer: { id: 'a' }, admission: { ok: false, kind: 'weird-unknown-kind' }, balanceDepleted: false }]
  const ladder = buildLadder(rows)
  // weird kind 会被当作 no-evidence，已在链里
  assert.ok(ladder.chain.length > 0)
})

check('rescueFromEmpty 只救非余额为 0 的', () => {
  const rows = [
    { offer: { id: 'ok1' }, admission: { ok: true } },
    { offer: { id: 'empty' }, balanceDepleted: true },
  ]
  const r = rescueFromEmpty(rows, { tried: new Set() })
  assert.equal(r.rescued.length, 1)
  assert.equal(r.rescued[0].offer.id, 'ok1')
})

console.log('\n[4/4] 编排层：端到端')

check('decideRoute 保证链非空（只要有余额不为 0 的）', () => {
  const rows = [
    { offer: { id: 'a', providerId: 'p1' }, admission: { ok: false, kind: 'no-evidence' }, quality: 0.9 },
    { offer: { id: 'b', providerId: 'p1' }, admission: { ok: false, kind: 'unstable' }, quality: 0.5 },
  ]
  const d = decideRoute(rows, { calibration: null, balances: new Map(), providerSpeedPrior: new Map() })
  assert.ok(d.chain.length > 0, '绝不能返回空链')
})

check('站点速度先验能区分「无数据」的供给', () => {
  const ctx = {
    calibration: null,
    balances: new Map(),
    providerSpeedPrior: new Map([['fast', 1000], ['slow', 9000]]),
  }
  const fastRow = scoreRow({ offer: { id: 'a', providerId: 'fast' }, quality: 1 }, ctx)
  const slowRow = scoreRow({ offer: { id: 'b', providerId: 'slow' }, quality: 1 }, ctx)
  assert.equal(fastRow.speed.source, 'provider-prior')
  assert.ok(fastRow.score < slowRow.score, '快站的供给应排前面')
})

check('余额低的站排序靠后，但不被排除', () => {
  const ctx = {
    calibration: null,
    balances: new Map([['poor', { state: BALANCE.LOW, penalty: 1.6 }]]),
    providerSpeedPrior: new Map([['poor', 1000], ['rich', 1000]]),
  }
  const poor = scoreRow({ offer: { id: 'a', providerId: 'poor' }, quality: 1 }, ctx)
  const rich = scoreRow({ offer: { id: 'b', providerId: 'rich' }, quality: 1 }, ctx)
  assert.ok(poor.score > rich.score, '余额低的应该排后面')
  // 但它仍然能在决策链里
  const d = decideRoute([
    { offer: { id: 'a', providerId: 'poor' }, admission: { ok: true }, quality: 1 },
  ], ctx)
  assert.equal(d.chain.length, 1, '余额低不该被排除，只是排后面')
})

check('余额为 0 的供给在 decideRoute 里被回填并排除（回归）', () => {
  // 这个 bug 真踩到过：scoreRow 内部算了余额状态，但没写回 row，
  // 兜底阶梯看不到 balanceDepleted，就把欠费站也排进了链里。
  const ctx = {
    calibration: null,
    providerSpeedPrior: new Map(),
    balances: new Map([
      ['poor', { state: BALANCE.EMPTY, penalty: Infinity }],
      ['rich', { state: BALANCE.HEALTHY, penalty: 1 }],
    ]),
  }
  const rows = [
    { offer: { id: 'a', providerId: 'poor' }, admission: { ok: true }, quality: 1 },
    { offer: { id: 'b', providerId: 'rich' }, admission: { ok: true }, quality: 1 },
  ]
  const d = decideRoute(rows, ctx)
  assert.equal(d.chain.length, 1, '欠费站必须被排除')
  assert.equal(d.chain[0].offer.id, 'b')
})

check('decideRoute 输出带评分解释', () => {
  const ctx = { calibration: null, balances: new Map(), providerSpeedPrior: new Map() }
  const d = decideRoute([{ offer: { id: 'a', providerId: 'p' }, admission: { ok: true }, quality: 1 }], ctx)
  assert.ok(d.chain[0].scoreExplain, '每条要能解释为什么在这位置')
  assert.ok(Number.isFinite(d.chain[0].routeScore))
})

console.log('\n[5/5] 决策侧重是排序主键，routeScore 只做主键打平时的次键')

// 回归：2026-11-11 的现场。「价格」档选了半天，永远还是最贵的那家第一，
// 因为 decideRoute 无条件按 routeScore 排，而 routeScore 里 priceWeight = 0
// ——价格一分钱都不参与，贵 2.9 倍和便宜 2.9 倍算出来一样。
// 同一个链路还让「首字速度」档被余额惩罚翻转：快站余额只剩 1.7 天 ×1.6，
// 直接输给慢 400ms 但余额健康的站。
//
// 造两条供给：穷站 = 又快又便宜，但余额低；富站 = 又慢又贵，余额健康。
const priceFight = () => {
  const ctx = {
    calibration: null,
    providerSpeedPrior: new Map(),
    // 穷站余额低（1.6 倍惩罚），富站健康
    balances: new Map([
      ['poor', { state: BALANCE.LOW, penalty: 1.6 }],
      ['rich', { state: BALANCE.HEALTHY, penalty: 1 }],
    ]),
  }
  // row 上带齐 compareByBasis 需要的字段（effective / price 用人民币口径，等价）
  const cheap = {
    offer: { id: 'cheap', providerId: 'poor' },
    admission: { ok: true },
    quality: 1,
    price: 0.455,
    priceUsd: 0.455,
    effective: 0.455,
    effectiveUsd: 0.455,
    realTtftMs: 4400,
    realTtftSamples: 10,
  }
  const pricey = {
    offer: { id: 'pricey', providerId: 'rich' },
    admission: { ok: true },
    quality: 1,
    price: 1.3,
    priceUsd: 1.3,
    effective: 1.3,
    effectiveUsd: 1.3,
    realTtftMs: 5000,
    realTtftSamples: 10,
  }
  return { ctx, rows: [pricey, cheap] }
}

check('价格档：便宜的那家排第一，哪怕它余额低、routeScore 更差', () => {
  const { ctx, rows } = priceFight()
  const d = decideRoute(rows, ctx, { decisionMode: 'price' })
  // 先确认前提成立：routeScore 这边确实是富站（慢但有钱）赢，
  // 否则这条测试就是空的——测了半天没人违反它
  assert.ok(
    d.chain.find((r) => r.offer.id === 'pricey').routeScore
      < d.chain.find((r) => r.offer.id === 'cheap').routeScore,
    '前提：按 routeScore 排富站赢（余额惩罚翻转了速度差）',
  )
  assert.equal(d.chain[0].offer.id, 'cheap', '价格档必须由价格说了算，不能被余额惩罚夺权')
})

check('首字速度档：快的那家排第一，哪怕它余额低', () => {
  const { ctx, rows } = priceFight()
  const d = decideRoute(rows, ctx, { decisionMode: 'speed' })
  assert.equal(d.chain[0].offer.id, 'cheap', '速度档必须由首字说了算')
})

check('性价比档：仍然是便宜那家（0.455 < 1.3）', () => {
  const { ctx, rows } = priceFight()
  const d = decideRoute(rows, ctx, { decisionMode: 'value' })
  assert.equal(d.chain[0].offer.id, 'cheap')
})

check('档次不同，第一名就该不同——不是永远同一家', () => {
  // 便宜但慢 vs 贵但快：两个档必须给出相反的首名，否则档位就是摆设
  const ctx = { calibration: null, providerSpeedPrior: new Map(), balances: new Map() }
  const rows = [
    { offer: { id: 'slowCheap', providerId: 'p1' }, admission: { ok: true }, quality: 1, price: 0.3, priceUsd: 0.3, effective: 0.3, effectiveUsd: 0.3, realTtftMs: 12000, realTtftSamples: 10 },
    { offer: { id: 'fastPricey', providerId: 'p2' }, admission: { ok: true }, quality: 1, price: 2.0, priceUsd: 2.0, effective: 2.0, effectiveUsd: 2.0, realTtftMs: 1500, realTtftSamples: 10 },
  ]
  assert.equal(decideRoute(rows, ctx, { decisionMode: 'price' }).chain[0].offer.id, 'slowCheap', '价格档选便宜的')
  assert.equal(decideRoute(rows, ctx, { decisionMode: 'speed' }).chain[0].offer.id, 'fastPricey', '速度档选快的')
})

check('准入不通过的不因为档位靠前就越过梯队', () => {
  // 便宜且最快的站被冷却了（hard-fail）：任何档位下它都不该是链首
  const ctx = { calibration: null, providerSpeedPrior: new Map(), balances: new Map() }
  const rows = [
    {
      offer: { id: 'cooled', providerId: 'p1' }, admission: { ok: false, kind: 'blocked', text: '限流中' },
      quality: 1, price: 0.01, priceUsd: 0.01, effective: 0.01, effectiveUsd: 0.01,
      realTtftMs: 100, realTtftSamples: 10, blocked: { kind: 'rate', until: '2999-01-01T00:00:00Z' },
    },
    { offer: { id: 'ok', providerId: 'p2' }, admission: { ok: true }, quality: 1, price: 5, priceUsd: 5, effective: 5, effectiveUsd: 5, realTtftMs: 9000, realTtftSamples: 10 },
  ]
  for (const mode of ['value', 'price', 'speed', 'realSpeed', 'flow']) {
    const d = decideRoute(rows, ctx, { decisionMode: mode })
    assert.equal(d.chain[0].offer.id, 'ok', `${mode} 档不能让冷却中的站排第一`)
  }
})

check('决策侧重从 ctx 兜底：调用方不改代码也能吃到 db 里的档位', () => {
  const { rows } = priceFight()
  // buildRoutingContext 会把 settings.decisionMode 放进 ctx
  const ctx = {
    calibration: null,
    providerSpeedPrior: new Map(),
    balances: new Map([
      ['poor', { state: BALANCE.LOW, penalty: 1.6 }],
      ['rich', { state: BALANCE.HEALTHY, penalty: 1 }],
    ]),
    decisionMode: 'price',
  }
  assert.equal(decideRoute(rows, ctx).chain[0].offer.id, 'cheap', '没显式传 decisionMode 时读 ctx')
})

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
