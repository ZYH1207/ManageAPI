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
import { buildCalibration, estimateSpeed, speedMetric, calibrationSummary, SOURCE_CONFIDENCE, CALIBRATION_CLAMP } from '../core/speed-model.js'
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
  const stats = {
    'o1|2026-10-31T00': { requests: 10, estCostSum: 5 },
    'o2|2026-10-31T00': { requests: 10, estCostSum: 5 },
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

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
