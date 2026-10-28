/**
 * 准入门禁的两个补丁测试：
 *   ① 失败率冷却（间歇性失败不再永远免冷却）
 *   ② 绝境兜底（准入全灭时，慢速但成功率过得去的供给顶上）
 *
 * 两个补丁解决的是同一类现场：2026-10-28 实测某模型 7 条供给只剩 1 条准入，
 * 那 1 条还间歇性报 403——探针看着健康、网关使劲派、用户看到报错。
 *
 * 跑法：node .test/check-admission-guard.mjs
 */
import assert from 'node:assert/strict'
import {
  scoreOffers,
  isRoutable,
  FAIL_RATE_MIN_SAMPLES,
  FAIL_RATE_MIN_FAILS,
  FAIL_RATE_THRESHOLD,
} from '../core/score.js'
import { candidateChain, isLastResortCandidate, admissionOf, LAST_RESORT_MIN_QUALITY } from '../core/router.js'

let n = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  n += 1
}
const eq = (a, b, label) => {
  assert.deepEqual(a, b, label)
  n += 1
}

const now = Date.now()
const iso = (msAgo) => new Date(now - msAgo).toISOString()
const hourAgo = iso(30 * 60_000)

/** 造一条健康探针（可用、指纹对、不截断、不虚报） */
const probe = (offerId, msAgo = 5 * 60_000) => ({
  offerId,
  ts: iso(msAgo),
  ok: true,
  fingerprintOk: true,
  truncated: false,
  billingInflated: false,
  ttftMs: 2000,
  latencyMs: 4000,
})

/** 造真实流量：ok/fail 计数 + 最后一次失败时间 */
const traffic = (offerId, { ok = 0, fail = 0, lastFailAgo = 60_000 } = {}) => ({
  [offerId]: {
    ok,
    fail,
    since: hourAgo,
    kinds: {},
    quality: { samples: 0, bad: 0 },
    lastOkAt: iso(30_000),
    lastFailAt: fail > 0 ? iso(lastFailAgo) : null,
  },
})

const scoreOf = (offerId, trafficRow) => {
  const map = scoreOffers([probe(offerId)], trafficRow, { now })
  return map.get(offerId)
}

// ---------------------------------------------------------------- ① 失败率冷却
{
  // 绿萝真实现场：成功很多、失败夹在中间，最后一次成功比最后一次失败新。
  // 旧逻辑「lastFail > lastOk 才冷却」永远不触发，所以永远放行。
  const row = scoreOf('o_lv', traffic('o_lv', { ok: 40, fail: 6 })) // 6/46 ≈ 13%
  ok(!(row.failRate >= FAIL_RATE_THRESHOLD), '6/46 未到 15%（数据自检）')
  // 42 次 403 那种密集失败：ok=200 fail=42 → 17%
  const hot = scoreOf('o_hot', traffic('o_hot', { ok: 200, fail: 42 }))
  ok(hot.failRate > FAIL_RATE_THRESHOLD, `200 成 42 败 → 失败率 ${(hot.failRate * 100).toFixed(1)}%`)
  eq(hot.blocked?.kind, 'error-rate', '失败率超阈值 → 强制冷却')
  ok(hot.blocked.until > now, '冷却是未来时间点')
  ok(hot.pendingRecovery?.kind === 'error-rate', '待恢复标记也带上（冷却到期不能立刻放行）')
  eq(isRoutable(hot), false, '被冷却的供给不参与路由')
  ok(String(row.blocked?.kind || '') !== 'error-rate', '13% 的失败率不进冷却（不误伤）')

  // 边界：失败次数不够
  const few = scoreOf('o_few', traffic('o_few', { ok: 3, fail: 2 })) // 2 次失败
  ok(!few.blocked, `只有 2 次失败（<${FAIL_RATE_MIN_FAILS}）不进冷却`)

  // 边界：样本总数不够
  const small = scoreOf('o_small', traffic('o_small', { ok: 10, fail: 5 })) // 15 样本
  ok(!small.blocked, `样本 ${15} < ${FAIL_RATE_MIN_SAMPLES} 不进冷却`)

  // 边界：刚好达标
  const edge = scoreOf('o_edge', traffic('o_edge', { ok: 15, fail: 5 })) // 20 样本、25%
  eq(edge.blocked?.kind, 'error-rate', '恰好达标就冷却（20 样本 / 5 次失败 / 25%）')

  // 时间型窗口仍在（优先级高于比率型）：余额不足只挡 1 分钟，充了钱就该马上能试
  const quotaRow = scoreOffers(
    [
      probe('o_q'),
      // 失败必须比成功更新，时间型窗口才成立
      { offerId: 'o_q', ts: iso(20_000), ok: false, error: 'HTTP 403 insufficient balance' },
    ],
    {},
    { now },
  ).get('o_q')
  eq(quotaRow.blocked?.kind, 'quota', '余额不足仍走时间型窗口（不被比率型覆盖）')
  ok(quotaRow.blocked.until - now <= 60_000, `余额不足只挡 1 分钟（实际 ${Math.round((quotaRow.blocked.until - now) / 1000)} 秒）`)

  // 1 分钟一过就不再挂状态：充值后靠「再试一次」自证，不要求先有成功证据
  const quotaExpired = scoreOffers(
    [
      probe('o_q2'),
      { offerId: 'o_q2', ts: iso(120_000), ok: false, error: 'HTTP 403 insufficient balance' },
    ],
    {},
    { now },
  ).get('o_q2')
  eq(quotaExpired.blocked, null, '余额不足 1 分钟后不再挡住')
  eq(quotaExpired.pendingRecovery, null, '也不要求「先有成功证据」才放行')
  eq(quotaExpired.billingOnly, true, '标记成纯账单问题（没有真故障）')
}

// ---------------------------------------------------------------- ② 绝境兜底
{
  /** 造一行候选（字段与 selectCandidates 输出对齐） */
  const row = (id, { kind = null, quality = 1, ...rest } = {}) => ({
    offer: { id, providerId: 'p1', modelKey: 'm', upstreamName: 'm' },
    provider: { id: 'p1', name: '站' },
    quality,
    admission: kind ? { ok: false, kind, text: kind } : { ok: true, kind: null, text: null },
    ...rest,
  })

  const chain = candidateChain([
    row('a_ok'),
    row('b_slow', { kind: 'slow' }),
    row('c_slow_bad', { kind: 'slow', quality: 0.5 }),
    row('d_degraded', { kind: 'degraded' }),
    row('e_unstable', { kind: 'unstable' }),
    row('f_blocked', { kind: 'blocked', blocked: { kind: 'quota', until: now + 60000 } }),
    row('g_detour', { kind: 'slow', detour: { replacedByProviderName: '别家' } }),
    row('h_faulted', { kind: 'slow', faulted: true }),
  ])

  eq(chain.admitted.map((c) => c.offer.id), ['a_ok'], '准入候选只有真正准入的')
  eq(
    chain.lastResort.map((c) => c.offer.id),
    ['b_slow'],
    `兜底只收「慢速且质量≥${LAST_RESORT_MIN_QUALITY}」的（降智/不稳定/冷却/改道/故障一律不收）`,
  )
  ok(chain.lastResort[0].lastResort === true, '兜底候选带标记（决策日志能区分）')

  // 降智的绝不兜底：给错结果比不给更糟
  ok(!isLastResortCandidate(row('x', { kind: 'degraded' })), '降智不兜底')
  ok(!isLastResortCandidate(row('x', { kind: 'unstable' })), '不稳定不兜底')
  ok(!isLastResortCandidate(row('x', { kind: 'slow', quality: 0.79 })), '质量差一点就不够格')
  ok(isLastResortCandidate(row('x', { kind: 'slow', quality: 0.8 })), '质量刚好 0.8 够格')
  ok(!isLastResortCandidate(row('x')), '已准入的不会再进兜底列表（不重复）')

  // 全灭但有一条可兜底：不该报错，该试兜底
  const onlySlows = candidateChain([row('s1', { kind: 'slow' }), row('s2', { kind: 'slow', quality: 0.5 })])
  eq(onlySlows.admitted.length, 0, '没有准入候选')
  eq(onlySlows.lastResort.map((c) => c.offer.id), ['s1'], '但有一条可兜底 → 网关应该试它而不是直接报错')

  // 全灭且没有可兜底的：保持原有报错
  const none = candidateChain([row('d', { kind: 'degraded' })])
  eq(none.admitted.length + none.lastResort.length, 0, '全灭且无可兜底 → 走原有报错路径')

  // 准入口径本身不被改：兜底只是「排在后面备着」，不改标签。
  // 决策页看到的仍是「慢速：首字 XXms 超过门槛」——用户不会以为它是正常供给
  const slowAdmission = row('b', { kind: 'slow' }).admission
  ok(slowAdmission.ok === false && slowAdmission.kind === 'slow', '兜底不改变准入判定（决策页显示不变）')
  ok(admissionOf({ tooSlow: true, ttftMs: 9000 }).kind === 'slow', '准入判定仍是唯一口径（tooSlow → slow）')
}

// ---------------------------------------------------------------- 两条规则的顺序
{
  // 一条供给既慢又失败率高：先被错误率冷却，就不该进兜底
  const s = scoreOf('o_both', traffic('o_both', { ok: 200, fail: 42 }))
  const rowLike = {
    offer: { id: 'o_both' },
    provider: { id: 'p1', name: '站' },
    quality: s.quality,
    tooSlow: true,
    blocked: s.blocked,
    pendingRecovery: s.pendingRecovery,
    admission: admissionOf({
      ...s,
      tooSlow: true,
      admission: { ok: false, kind: 'slow' },
    }),
  }
  ok(!isLastResortCandidate(rowLike), '慢速 + 失败率高 → 不进兜底（冷却优先级更高）')
}

console.log(`check-admission-guard: ${n} 项全部通过`)
