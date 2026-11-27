#!/usr/bin/env node
/**
 * 探测入口：目标怎么挑、一次发几个请求。
 *
 * 要证的四件事：
 *   1. 批量探测按「最久没探的先探」轮转，不再是数据里的固定顺序；
 *   2. 冷却中的站整站跳过，并留下可报数的占位结果（不是静默少探几条）；
 *   3. 身份自述只在「单条深探」或「第一次探」时发，日常轮次不发（省一发请求）；
 *   4. 探测请求数真的随之变化（3 针 vs 4 针 vs 5 针），不是只改了参数名。
 *
 * 为什么要有这条测试：2026-11 之前「探测全部」被硬编码成 limit=5 且按固定顺序
 * slice(0, 5)，13 条在售供给时手点永远只打同一批 5 条，后面 8 条只能等定时任务；
 * 同时批量完全不看冷却。这两个都是「点了按钮但结果不对」的坏味道，靠肉眼不易发现。
 */
import { pickProbeTargets, lastProbeAt } from '../core/probe-policy.js'
import { probeModel } from '../core/probe.js'

let failed = 0
function ok(cond, message) {
  if (cond) console.log('  ✓ ' + message)
  else {
    console.error('  ✗ ' + message)
    failed += 1
  }
}

const now = Date.parse('2026-11-27T12:00:00Z')
const at = (iso) => ({ offerId: '', ts: iso })

console.log('上次探测时间')
const probes = [
  { offerId: 'a', ts: '2026-11-27T11:00:00Z' },
  { offerId: 'a', ts: '2026-11-27T10:00:00Z' },
  { offerId: 'b', ts: '2026-11-27T09:00:00Z' },
]
ok(lastProbeAt(probes, 'a') === Date.parse('2026-11-27T11:00:00Z'), '取最新的那一条，不是第一条')
ok(lastProbeAt(probes, 'b') === Date.parse('2026-11-27T09:00:00Z'), '各供给各算各的')
ok(lastProbeAt(probes, 'zzz') === 0, '没探过 → 0（排序时排最前）')
ok(lastProbeAt([], 'a') === 0, '空记录也不炸')

console.log('\n批量挑目标：按最久没探的轮转')
const offers13 = Array.from({ length: 13 }, (_, i) => ({
  id: `o${String(i).padStart(2, '0')}`,
  providerId: `p${String(i).padStart(2, '0')}`,
}))
// 前 5 条刚探过（就是老代码永远打的那批），后 8 条从没探过
const recentProbes = offers13.slice(0, 5).map((o) => ({ offerId: o.id, ts: '2026-11-27T11:30:00Z' }))
const pick1 = pickProbeTargets({ offers: offers13, probes: recentProbes, limit: 5, now })
ok(pick1.targets.length === 5, 'limit=5 就挑 5 条')
ok(
  pick1.targets.every((o) => Number(o.id.slice(1)) >= 5),
  '挑中的全是「没探过」的后 8 条，而不是老代码那固定的前 5 条',
)
ok(pick1.cooling.length === 0, '没有冷却时不报跳过')

console.log('\n再点一次：已经探过的不再重复打')
const secondProbes = [
  ...recentProbes,
  ...pick1.targets.map((o) => ({ offerId: o.id, ts: '2026-11-27T11:59:00Z' })),
]
const pick2 = pickProbeTargets({ offers: offers13, probes: secondProbes, limit: 5, now })
ok(pick2.targets.length === 5, '凑不满 5 条没探过的就先用剩下的补齐')
ok(
  pick2.targets.filter((o) => Number(o.id.slice(1)) >= 5).length === 3,
  '后 8 条里还剩 3 条没探 → 这 3 条优先',
)

console.log('\n冷却中的站整站跳过')
const cooldowns = new Map([
  ['p00', { offerId: 'o00', until: now + 600_000 }],
  ['p01', { offerId: 'o01', until: now + 60_000 }],
  ['p02', { offerId: 'o02', until: now - 1_000 }], // 已经过期，不算冷却
])
const pick3 = pickProbeTargets({ offers: offers13, probes: [], cooldowns, limit: 20, now })
ok(pick3.cooling.length === 2, '两个站还在冷却 → 两条占位结果')
ok(pick3.cooling.every((r) => r.skipped === 'cooling' && r.ok === false), '占位结果标了 skipped，不会被当成成功')
ok(
  pick3.cooling.find((r) => r.offerId === 'o00').error.includes('10 分钟'),
  '占位结果写明还要等多久（10 分钟）',
)
ok(!pick3.targets.some((o) => o.id === 'o00' || o.id === 'o01'), '冷却的站不进目标')
ok(pick3.targets.some((o) => o.id === 'o02'), '冷却已过期的站照常探')
ok(pick3.targets.length === 11, '13 条减去 2 条冷却 = 11 条')

console.log('\n全在冷却：目标为空但有报数，不会假装探过')
const allCool = new Map(offers13.map((o) => [o.providerId, { offerId: o.id, until: now + 60_000 }]))
const pick4 = pickProbeTargets({ offers: offers13, probes: [], cooldowns: allCool, limit: 20, now })
ok(pick4.targets.length === 0, '一条都不探')
ok(pick4.cooling.length === 13, '13 条都标了跳过，界面才能说「全在冷却」')

console.log('\n探测真的发几个请求（fetch 打桩计数）')
const SSE_OK = [
  'data: {"choices":[{"delta":{"content":"{\\"fp\\":\\"7Q2K\\",\\"calc\\":391}"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":45,"completion_tokens":12}}',
  'data: [DONE]',
  '',
].join('\n\n')
const SSE_ONE = [
  'data: {"choices":[{"delta":{"content":"1"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":30,"completion_tokens":1}}',
  'data: [DONE]',
  '',
].join('\n\n')

let calls = 0
const realFetch = globalThis.fetch
globalThis.fetch = async () => {
  calls += 1
  // 指纹请求要回 JSON，其余回一个数字即可
  const body = calls % 2 === 1 ? SSE_OK : SSE_ONE
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

async function countCalls(options) {
  calls = 0
  await probeModel({ baseUrl: 'http://stub.local/v1', apiKey: 'k', model: 'm', ...options })
  return calls
}

const deepCalls = await countCalls({ skipCache: true, skipIdentity: false })
ok(deepCalls === 3, `深探且缓存不需要：指纹 + 截断 + 身份自述 = 3 发（实际 ${deepCalls}）`)
const slimCalls = await countCalls({ skipCache: true, skipIdentity: true })
ok(slimCalls === 2, `日常且缓存不需要：指纹 + 截断 = 2 发（实际 ${slimCalls}）`)
ok(deepCalls - slimCalls === 1, '身份自述正好省下一发')
const cacheCalls = await countCalls({ skipCache: false, skipIdentity: true })
ok(cacheCalls === 4, `轮到缓存那两针：2 + 2 = 4 发（实际 ${cacheCalls}）`)
const fullCalls = await countCalls({ skipCache: false, skipIdentity: false })
ok(fullCalls === 5, `老口径（每轮都问身份、每轮都测缓存）= 5 发（实际 ${fullCalls}）`)

globalThis.fetch = realFetch

console.log(failed === 0 ? '\n全部通过 ✓' : `\n${failed} 项失败 ✗`)
process.exit(failed === 0 ? 0 : 1)