/**
 * 准入门禁自检（纯函数，不联网）：
 *   1. 什么算「不登场」：慢速 / 可疑 / 不稳定 / 没有可信样本 / 冷却中 / 待复测
 *   2. 什么是「能登场但只兜底」：评分过期 / 未探测——真实调用本身就是证据，不拦
 *   3. 排序：默认能登场的在前，不登场的排在后面
 *   4. 全部不登场时的报错文案：慢速和不可用分开报，且用 400
 *   5. 手动顺序（决策页拖拽）：整张表都参与，排到前面不改变准入判定
 *
 * 背景：以前网关「所有候选都不健康」时仍然按价格挨个试，决策页却显示
 * 「没有可用供给」——两处口径不一致。现在准入收口在 admissionOf，
 * 报错收口在 admissionFailure，这个测试把它们钉死。
 *
 * 冷却中（额度不足 / 限流 / 模型不在分组）曾经是「放行兜底」，后来改成不放行：
 * 一个模型 4 条供给，3 条慢速 + 1 条限流时，放行等于把时间全花在必然失败的请求上。
 * 恢复看证据不看钟——冷却到期也要等下一次探测成功（pendingRecovery）。
 *
 * 用法：node .test/check-admission.mjs
 */
import { admissionOf, admissionFailure, selectCandidates } from '../core/router.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

// 一行候选的最小形状：admissionOf 只看这几个字段
const row = (patch = {}) => ({
  tooSlow: false,
  status: 'healthy',
  availability: 1,
  integrityFaults: [],
  blocked: null,
  pendingRecovery: null,
  allowUntrusted: false,
  ttftMs: 2000,
  ...patch,
})

console.log('[1] 能登场')
{
  ok(admissionOf(row()).ok === true, '健康 → 登场')
  ok(admissionOf(row({ status: 'stale' })).ok === true, '评分过期 → 仍然登场（真实调用本身就是证据）')
  ok(
    admissionOf(row({ status: 'unknown', availability: null, samples: 0 })).ok === true,
    '一次都没探过 → 登场（没证据不等于坏证据）',
  )
  ok(admissionOf(row({ status: 'inconclusive', availability: 0.5 })).ok === true, '证据不足 → 登场兜底')
  ok(
    admissionOf(row({ status: 'stale', availability: null, samples: 6 })).ok === true,
    '全部证据都过期（可用率因此无分母）→ 仍然登场，不能当成「没有可信样本」',
  )
}

console.log('[2] 不登场，且说得出原因')
{
  const slow = admissionOf(row({ tooSlow: true, ttftMs: 16522 }))
  ok(slow.ok === false && slow.kind === 'slow', `慢速 → ${slow.kind}`)
  ok(slow.text.includes('16522'), `慢速文案带数字：${slow.text}`)

  const degraded = admissionOf(row({ status: 'degraded', integrityFaults: ['指纹不符'] }))
  ok(degraded.ok === false && degraded.kind === 'degraded', `可疑 → ${degraded.kind}`)
  ok(degraded.text.includes('指纹不符'), `可疑文案点名故障项：${degraded.text}`)

  const unstable = admissionOf(row({ status: 'unstable', availability: 0.5 }))
  ok(unstable.ok === false && unstable.kind === 'unstable', `不稳定 → ${unstable.kind}`)

  const noEvidence = admissionOf(row({ status: 'unknown', availability: null, blocked: null, samples: 5 }))
  ok(noEvidence.ok === false && noEvidence.kind === 'no-evidence', `没有可信样本 → ${noEvidence.kind}`)

  // 冷却中：额度/限流/模型不在分组。以前这里放行兜底，结果是一组里其它供给都慢时，
  // 网关只剩这条会去撞限流，反复失败把客户端时间全耗掉
  const cooling = admissionOf(row({ blocked: { kind: 'rate-limit', until: Date.now() + 120000 } }))
  ok(cooling.ok === false && cooling.kind === 'blocked', `限流冷却中 → ${cooling.kind}`)
  ok(cooling.text.includes('上游账号冷却中'), `冷却文案点名原因：${cooling.text}`)
  ok(cooling.text.includes('还剩') && cooling.text.includes('分钟'), `冷却文案带上剩余时间：${cooling.text}`)
  // 余额不足不是「冷却」：必须直接说要充值，否则用户不知道该去交钱
  const broke = admissionOf(row({ blocked: { kind: 'quota', until: Date.now() + 60000 } }))
  ok(broke.ok === false && broke.kind === 'blocked', `余额不足 → ${broke.kind}`)
  ok(broke.text.includes('余额不足') && broke.text.includes('充值'), `余额不足说清怎么办：${broke.text}`)
  ok(!broke.text.includes('冷却'), `余额不足不叫「冷却」（那是账单问题，不是上游排队）：${broke.text}`)

  // 冷却到期但还没有成功证据：同样不放行，等下一次探测确认
  const recovering = admissionOf(row({ pendingRecovery: { kind: 'rate-limit', since: Date.now() - 60000 } }))
  ok(recovering.ok === false && recovering.kind === 'blocked', `冷却到期待复测 → ${recovering.kind}`)
  ok(recovering.text.includes('等一次成功调用'), `待复测文案说清在等什么：${recovering.text}`)
}

console.log('[3] 「放行可疑供给」只覆盖可疑/不稳定，不覆盖慢速和冷却')
{
  ok(admissionOf(row({ status: 'degraded', allowUntrusted: true })).ok === true, '开关打开 → 可疑的重新登场')
  ok(admissionOf(row({ status: 'unstable', allowUntrusted: true })).ok === true, '开关打开 → 不稳定的重新登场')
  ok(
    admissionOf(row({ tooSlow: true, allowUntrusted: true })).ok === false,
    '开关打开 → 慢速仍然不登场（门槛是独立设置）',
  )
  ok(
    admissionOf(row({ blocked: { kind: 'rate-limit', until: Date.now() + 120000 }, allowUntrusted: true })).ok === false,
    '开关打开 → 冷却中仍然不登场（刚被上游拒过，试了只会白等）',
  )
}

// ------------------------------------------------------------ 整条链路
const providers = [{ id: 'p1', name: '甲站' }]
const credentials = [{ id: 'c1', providerId: 'p1', group: '', tail: '0000' }]
const offer = (id, group) => ({
  id,
  providerId: 'p1',
  credentialId: 'c1',
  group,
  modelKey: 'm',
  upstreamName: 'm',
  pricingMode: 'manual',
  priceUnit: 'per_mtok',
  currency: 'CNY',
  inPrice: 1,
  outPrice: 1,
})
const score = (patch = {}) => ({
  samples: 5,
  trafficSamples: 0,
  status: 'healthy',
  availability: 1,
  integrity: 1,
  integrityFaults: [],
  quality: 1,
  stale: false,
  blocked: null,
  pendingRecovery: null,
  confidence: 'medium',
  ttftMs: 2000,
  ...patch,
})
const settings = (patch = {}) => ({
  fx: { base: 'USD', rates: { CNY: 7.2 } },
  fxUsdCny: 7.2,
  maxTtftMs: 8000,
  allowUntrusted: false,
  ...patch,
})
const run = (scores, settingPatch = {}, order = null) =>
  selectCandidates({
    offers: Object.keys(scores).map((id) => offer(id, id)),
    providers,
    credentials,
    scores,
    benchmarks: {},
    settings: settings(settingPatch),
    model: 'm',
    order,
  })

console.log('[4] 排序：能登场的在前，不登场的永远在后面')
{
  // a 健康但贵、b 过期但便宜、c 慢速且最便宜
  const rows = run({
    a: score({ ttftMs: 2000 }),
    b: score({ status: 'stale', stale: true }),
    c: score({ ttftMs: 16522, status: 'healthy' }),
  })
  ok(rows[0].offer.id === 'a', `健康的最前：${rows.map((r) => r.offer.id).join(' > ')}`)
  ok(rows[1].offer.id === 'b', '过期的排在健康之后（兜底但不被拦）')
  ok(rows[2].offer.id === 'c', '慢速的排最后')
  ok(rows[2].admission.ok === false && rows[2].admission.kind === 'slow', '慢速行带 admission 说明')
  ok(rows[1].admission.ok === true, '过期行 admission.ok 为 true（网关会派它）')
}

console.log('[5] 全部不登场时的报错：慢速单独报，其余报不可用')
{
  const rows = run({ s1: score({ ttftMs: 16522 }), s2: score({ ttftMs: 19300 }) })
  const failure = admissionFailure(rows, { model: 'm', maxTtftMs: 8000 })
  ok(failure.status === 400, `状态码 ${failure.status}`)
  ok(failure.type === 'upstream_too_slow', `type ${failure.type}`)
  ok(failure.message.includes('8000ms'), '文案带上门槛值')
  ok(failure.detail.includes('慢速'), `逐站原因：${failure.detail}`)

  const mixed = run({
    x: score({ status: 'degraded', integrityFaults: ['指纹不符'] }),
    y: score({ ttftMs: 16522 }),
  })
  const failure2 = admissionFailure(mixed, { model: 'm', maxTtftMs: 8000 })
  ok(failure2.type === 'no_available_supply', `混合原因 → ${failure2.type}`)
  ok(failure2.message.startsWith('没有可用的 m'), `文案：${failure2.message.slice(0, 24)}…`)
  ok(failure2.detail.includes('指纹不符') && failure2.detail.includes('慢速'), '两种原因都写进 detail')

  const allBlocked = run({ z: score({ status: 'unknown', availability: null, samples: 5 }) })
  const failure3 = admissionFailure(allBlocked, { model: 'm', maxTtftMs: 8000 })
  ok(failure3.type === 'no_available_supply', `没有可信样本 → ${failure3.type}`)
  ok(failure3.detail.includes('没有可信样本'), '原因写清楚了')

  // 现场：3 条慢速 + 1 条限流。以前限流那条会被放行兜底，网关反复撞它；
  // 现在一条都不登场，直接 400 并说清每条为什么不行
  const realistic = run({
    slow1: score({ ttftMs: 16522 }),
    slow2: score({ ttftMs: 19300 }),
    slow3: score({ ttftMs: 22000 }),
    limited: score({ blocked: { kind: 'rate-limit', until: Date.now() + 180000 } }),
  })
  ok(realistic.every((r) => r.admission.ok === false), '3 慢 + 1 限流 → 没有一条能登场')
  const failure4 = admissionFailure(realistic, { model: 'm', maxTtftMs: 8000 })
  ok(failure4.status === 400, `状态码 ${failure4.status}（重试无意义，不能给 5xx）`)
  ok(failure4.detail.includes('上游账号冷却中'), `逐站原因里有冷却：${failure4.detail}`)
}

console.log('[6] 门槛为 0（不限）时不因速度报错')
{
  const rows = run({ s1: score({ ttftMs: 19300 }) }, { maxTtftMs: 0 })
  ok(rows[0].admission.ok === true, '不限 = 19.3 秒也登场')
}

console.log('[7] 手动顺序：整张表都能拖，准入不受影响')
{
  // 决策页把慢速的 c 拖到第一、过期的 b 第二、健康的 a 最后
  const scores = {
    a: score({ ttftMs: 2000 }),
    b: score({ status: 'stale', stale: true }),
    c: score({ ttftMs: 16522 }),
  }
  const rows = run(scores, {}, ['c', 'b', 'a'])
  ok(rows.map((r) => r.offer.id).join('>') === 'c>b>a', `拖动后顺序就是保存的顺序：${rows.map((r) => r.offer.id).join('>')}`)
  ok(rows[0].admission.ok === false, '慢速行摆到第一，admission.ok 仍是 false（不会被派活）')
  ok(rows[1].admission.ok === true && rows[2].admission.ok === true, '能登场的两条仍然能登场')

  // 没进手动顺序的新供给（比如新加了一个站）排在后面，按原来的规则兜底
  const withNew = run({ ...scores, d: score({ ttftMs: 2000 }) }, {}, ['c', 'b', 'a'])
  ok(withNew[withNew.length - 1].offer.id === 'd', `不在顺序里的排最后：${withNew.map((r) => r.offer.id).join('>')}`)

  // 空数组 = 恢复自动，排序回到默认规则
  const auto = run(scores, {}, [])
  ok(auto.map((r) => r.offer.id).join('>') === 'a>b>c', `恢复自动：${auto.map((r) => r.offer.id).join('>')}`)
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
