#!/usr/bin/env node
/**
 * 请求耗时细分自检。
 *
 * 覆盖：分段正确性（各段加总 = 总时长）、缺失阶段的兜底、诊断文案、中位数聚合。
 */

import assert from 'node:assert/strict'
import { PhaseTimer, diagnosePhases, medianPhases } from '../core/net-timing.js'

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); fail++ }
}

/** 用可注入时钟造一次请求 */
function makeTimer(marks) {
  let t = 1000
  const tm = new PhaseTimer(() => t)
  for (const [phase, delta] of marks) { t += delta; if (phase) tm.mark(phase) }
  return tm
}

console.log('\n[1/3] 分段计时')

check('四段正确切分，且加总等于总时长', () => {
  const tm = makeTimer([
    ['dispatch', 80],    // own = 80
    ['headers', 5000],   // wait = 5000
    ['firstByte', 100],  // head = 100
    ['done', 2000],      // flow = 2000
  ])
  const net = tm.finish()
  assert.equal(net.own, 80)
  assert.equal(net.wait, 5000)
  assert.equal(net.head, 100)
  assert.equal(net.flow, 2000)
  assert.equal(net.total, 7180)
  assert.equal(net.own + net.wait + net.head + net.flow, net.total, '各段必须能加总回总时长')
})

check('toFirstToken = own + wait + head（用户体感的首字时间）', () => {
  const tm = makeTimer([['dispatch', 80], ['headers', 5000], ['firstByte', 100], ['done', 2000]])
  const net = tm.finish()
  assert.equal(net.toFirstToken, 80 + 5000 + 100)
})

check('重复打同一阶段只保留第一次（首字节不被后续覆盖）', () => {
  let t = 1000
  const tm = new PhaseTimer(() => t)
  t += 100; tm.mark('firstByte')
  t += 500; tm.mark('firstByte')   // 第二次不该覆盖
  assert.equal(tm.at('firstByte'), 1100)
})

check('没打 dispatch → own 记 0，时间算到 wait（不虚报自己开销小）', () => {
  let t = 1000
  const tm = new PhaseTimer(() => t)
  t += 5000; tm.mark('headers')
  t += 100; tm.mark('done')
  const net = tm.finish()
  assert.equal(net.own, 0)
  assert.equal(net.wait, 5000)
})

check('一个阶段都没打也能给出合法结果（总时长不为负）', () => {
  const tm = makeTimer([['done', 1234]])
  const net = tm.finish()
  assert.ok(net.total >= 0)
  assert.equal(net.own + net.wait + net.head + net.flow, net.total)
})

check('phases 保留原始时间戳供排查', () => {
  const tm = makeTimer([['dispatch', 10], ['headers', 20], ['firstByte', 30], ['done', 40]])
  const net = tm.finish()
  assert.ok(net.phases.start > 0)
  assert.equal(net.phases.dispatch, net.phases.start + 10)
  assert.equal(net.phases.done, net.phases.start + 100)
})

console.log('\n[2/3] 诊断文案')

check('网关自身开销过大 → 指出是自己的问题', () => {
  const msg = diagnosePhases({ own: 900, wait: 800, head: 50, flow: 300, total: 2050 })
  assert.match(msg, /网关自身开销/)
})

check('等上游首字节占绝大部分 → 指出上游在思考', () => {
  const msg = diagnosePhases({ own: 50, wait: 9000, head: 100, flow: 200, total: 9350 })
  assert.match(msg, /等上游首字节/)
})

check('生成阶段占绝大部分 → 指出吐字慢', () => {
  const msg = diagnosePhases({ own: 50, wait: 500, head: 100, flow: 9000, total: 9650 })
  assert.match(msg, /生成阶段/)
})

check('没有明显异常 → 空串（不硬凑结论）', () => {
  assert.equal(diagnosePhases({ own: 80, wait: 2000, head: 100, flow: 2000, total: 4180 }), '')
})

check('无效输入 → 空串，不抛异常', () => {
  assert.equal(diagnosePhases(null), '')
  assert.equal(diagnosePhases({ total: 0 }), '')
})

console.log('\n[3/3] 中位数聚合')

check('算多个样本的中位数', () => {
  const m = medianPhases([
    { own: 10, wait: 100, flow: 5, total: 115 },
    { own: 30, wait: 300, flow: 15, total: 345 },
    { own: 20, wait: 200, flow: 10, total: 230 },
  ])
  assert.equal(m.own, 20)
  assert.equal(m.wait, 200)
  assert.equal(m.n, 3)
})

check('偶数个样本取中间两个的平均', () => {
  const m = medianPhases([
    { own: 10, wait: 100, flow: 5, total: 115 },
    { own: 20, wait: 200, flow: 10, total: 230 },
  ])
  assert.equal(m.own, 15)
  assert.equal(m.wait, 150)
})

check('空数组 → 全 null', () => {
  const m = medianPhases([])
  assert.equal(m.own, null)
  assert.equal(m.n, 0)
})

check('忽略 null/undefined/NaN，但负数是有效数字（保留）', () => {
  const m = medianPhases([
    { own: 10, wait: 100, flow: 5, total: 115 },
    { own: null, wait: undefined, flow: NaN, total: -1 },
  ])
  // own 只有 10 一个有效值（null 不能被当成 0 —— 这是真踩到的 bug）
  assert.equal(m.own, 10)
  // total 只有 115（-1 被 >=0 过滤掉）
  assert.equal(m.total, 115)
  assert.equal(m.n, 2, 'n 报样本条数而不是有效值数')
})

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
