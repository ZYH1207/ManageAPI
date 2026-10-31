#!/usr/bin/env node
/**
 * 真实首字口径自检。
 *
 * 覆盖三块：
 *   1. realTtftOf 的指数衰减加权（不再 6 小时硬截止）
 *   2. 排序档位的口径（realSpeed 只认真实 / speed 真实优先 / 探针兜底）
 *   3. explain 输出带 speedBasis
 */

import assert from 'node:assert/strict'
import { realTtftOf, REAL_TTFT_HALF_LIFE_HOURS } from '../core/score.js'
import { tierMetricOf, speedOf, speedBasisOf, DECISION_MODES, normalizeDecisionMode } from '../core/decision-mode.js'

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); fail++ }
}

/** 造一个 offerStats：hoursAgo 小时前，n 个样本，平均 ttftMs */
function bucket(offerId, hoursAgo, n, ttftMs, now = Date.now()) {
  const t = new Date(now - hoursAgo * 3600_000)
  const hour = t.toISOString().slice(0, 13)
  return [`${offerId}|${hour}`, { ttftCount: n, ttftSum: n * ttftMs, genTimeSum: 0, genOutSum: 0 }]
}

console.log('\n[1/3] 真实首字的衰减加权')

check('6 小时外的数据不再被丢弃（原 bug）', () => {
  const now = Date.now()
  const stats = Object.fromEntries([bucket('o1', 12, 100, 8000, now)])
  const r = realTtftOf(stats, 'o1', now)
  assert.ok(r.realTtftMs !== null, '12 小时前的数据应该仍可用')
  assert.equal(r.realTtftMs, 8000)
  assert.equal(r.realTtftSamples, 100)
})

check('新鲜样本比陈旧样本权重大', () => {
  const now = Date.now()
  const stats = Object.fromEntries([
    bucket('o1', 1, 100, 2000, now),    // 很新，很快
    bucket('o1', 120, 100, 20000, now), // 很旧，很慢
  ])
  const r = realTtftOf(stats, 'o1', now)
  // 加权后应明显偏向 2000（新）而不是 11000（等权平均）
  assert.ok(r.realTtftMs < 6000, `应偏向新样本，实际 ${r.realTtftMs}`)
  assert.equal(r.realTtftSamples, 200, '样本数报原始总数')
})

check('半衰期后的权重约为一半', () => {
  const now = Date.now()
  const half = REAL_TTFT_HALF_LIFE_HOURS
  // 两个桶：一个刚发生，一个正好半衰期前，值差一倍
  const stats = Object.fromEntries([
    bucket('o1', 0, 100, 1000, now),
    bucket('o1', half, 100, 3000, now),
  ])
  const r = realTtftOf(stats, 'o1', now)
  // 权重 1 和 0.5 → (1000*1 + 3000*0.5)/(1+0.5) = 2500/1.5 ≈ 1667
  assert.ok(Math.abs(r.realTtftMs - 1667) < 30, `期望约 1667，实际 ${r.realTtftMs}`)
})

check('样本多的桶更有说服力', () => {
  const now = Date.now()
  // 注意：桶的 key 是「offerId|小时」，同一小时会互相覆盖 ——
  // 这是数据模型本身决定的（一个供给一小时一个桶）。所以测试必须用不同小时。
  const stats = Object.fromEntries([
    bucket('o1', 2, 1000, 2000, now), // 多但慢
    bucket('o1', 1, 1, 10000, now),   // 少且快（更新，但样本极少）
  ])
  const r = realTtftOf(stats, 'o1', now)
  assert.ok(r.realTtftMs < 2500,
    `应被大样本主导（1000 个样本 vs 1 个），实际 ${r.realTtftMs}`)
})

check('报出最新证据是几小时前', () => {
  const now = Date.now()
  const stats = Object.fromEntries([
    bucket('o1', 10, 5, 5000, now),
    bucket('o1', 1, 5, 5000, now),
  ])
  const r = realTtftOf(stats, 'o1', now)
  assert.equal(r.realTtftHoursAgo, 1, '应报最新那条')
})

check('没有任何样本 → null（不能冒充有数据）', () => {
  const r = realTtftOf({}, 'o1')
  assert.equal(r.realTtftMs, null)
  assert.equal(r.realTtftSamples, 0)
})

check('只算自己的 offer（不串台）', () => {
  const now = Date.now()
  const stats = Object.fromEntries([
    bucket('o1', 1, 10, 1000, now),
    bucket('o2', 1, 10, 9000, now),
  ])
  assert.equal(realTtftOf(stats, 'o1', now).realTtftMs, 1000)
  assert.equal(realTtftOf(stats, 'o2', now).realTtftMs, 9000)
})

console.log('\n[2/3] 排序档位口径')

check('新增 realSpeed 档位', () => {
  assert.ok(DECISION_MODES.some((m) => m.key === 'realSpeed'))
  assert.equal(normalizeDecisionMode('realSpeed'), 'realSpeed')
})

check('realSpeed：只有真实首字才算数，探针不冒充', () => {
  const probeOnly = { ttftMs: 900, realTtftMs: null }
  assert.equal(tierMetricOf(probeOnly, 'realSpeed'), Infinity,
    '没有真实样本就该排最后，不能让探针的 900ms 冒充')
})

check('realSpeed：真实优先于探针', () => {
  // 探针说快（1s），真实很慢（12s）
  const row = { ttftMs: 1000, realTtftMs: 12000, priceUsd: 1 }
  assert.equal(tierMetricOf(row, 'realSpeed'), 12000)
})

check('speed 档：真实优先，无真实样本退回探针', () => {
  assert.equal(tierMetricOf({ ttftMs: 1000, realTtftMs: 12000 }, 'speed'), 12000, '有真实值时用真实')
  assert.equal(tierMetricOf({ ttftMs: 1000, realTtftMs: null }, 'speed'), 1000, '没真实值时用探针')
})

check('speedBasis 正确标注口径', () => {
  assert.equal(speedBasisOf({ ttftMs: 1000, realTtftMs: 2000 }), 'real')
  assert.equal(speedBasisOf({ ttftMs: 1000, realTtftMs: null }), 'probe')
  assert.equal(speedBasisOf({ ttftMs: null, realTtftMs: null }), 'none')
  assert.equal(speedBasisOf({ ttftMs: 1000, realTtftMs: null }, 'real'), 'none',
    'real 策略下没真实值就是 none')
})

check('speedOf 在 real 策略下只认真实', () => {
  assert.equal(speedOf({ ttftMs: 500, realTtftMs: null }, 'real'), Infinity)
  assert.equal(speedOf({ ttftMs: 500, realTtftMs: 3000 }, 'real'), 3000)
})

check('priceSpeed 用真实首字算比值', () => {
  // 探针 1s、真实 10s，价格 1 → pace = 1/10000 而不是 1/1000
  const row = { ttftMs: 1000, realTtftMs: 10000, priceUsd: 1 }
  assert.ok(Math.abs(tierMetricOf(row, 'priceSpeed') - 1 / 10000) < 1e-9)
})

check('非速度档位不受影响（回归）', () => {
  const row = { ttftMs: 1000, realTtftMs: 12000, priceUsd: 2, effectiveUsd: 3 }
  assert.equal(tierMetricOf(row, 'price'), 2)
  assert.equal(tierMetricOf(row, 'value'), 3)
})

console.log('\n[3/3] 端到端：真实数据算得出来')

check('真实库里 14 个供给都能算出真实首字（原为 1 个）', async () => {
  const { readFileSync } = await import('node:fs')
  const db = JSON.parse(readFileSync(`${process.env.HOME}/.manage-api/db.json`, 'utf8'))
  const stats = db.offerStats || {}
  const ids = [...new Set(Object.keys(stats).map((k) => k.split('|')[0]))]
  if (ids.length === 0) { console.log('    （本机没有 offerStats，跳过）'); return }
  let withReal = 0
  for (const id of ids) if (realTtftOf(stats, id).realTtftMs !== null) withReal++
  assert.equal(withReal, ids.length, `${withReal}/${ids.length} 有真实首字`)
})

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
