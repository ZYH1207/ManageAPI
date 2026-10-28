/**
 * 状态标签自检（纯函数，不联网）：
 *
 * 背景：决策页/比价页的状态以前是「if/else 取第一个毛病」，一条又慢又掉包、
 * 可用率还只有 33% 的供给只会显示「慢速」——用户会以为把首字门槛放宽就能用。
 * 现在状态是一串标签（core/router.js#admissionTags），该标的都标。
 *
 * 钉死三件事：
 *   1. 同时成立的问题必须同时出现（慢速 + 结果可疑 + 不稳定）
 *   2. 「不稳定」和「证据不足」的分界和 score.js 一致（样本 < 3 不下结论）
 *   3. 标签只是展示：admissionOf 的门禁结论不能跟着变（网关只认它）
 *
 * 用法：node .test/check-status-tags.mjs
 */
import { admissionOf, admissionTags, explain, selectCandidates } from '../core/router.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}
const same = (list, expected) => JSON.stringify(list) === JSON.stringify(expected)

// 一行候选的最小形状：admissionTags 只看这几个字段
const row = (patch = {}) => ({
  tooSlow: false,
  status: 'healthy',
  availability: 1,
  integrityFaults: [],
  blocked: null,
  pendingRecovery: null,
  samples: 10,
  ttftMs: 2000,
  ...patch,
})

console.log('[1] 没毛病 → 只有「可用」')
{
  ok(same(admissionTags(row()), ['ok']), '健康 → [ok]')
  ok(same(admissionTags(row({ status: 'stale' })), ['fallback']), '评分过期 → [fallback]')
  ok(same(admissionTags(row({ status: 'unknown', samples: 0, availability: null })), ['fallback']), '未探测 → [fallback]')
}

console.log('[2] 同时成立的问题全部标出来')
{
  // 现场：首字 11761ms（门槛 6000）、可用率 33%、指纹不符
  const bad = row({
    tooSlow: true,
    status: 'degraded',
    availability: 0.33,
    integrityFaults: ['指纹不符'],
    ttftMs: 11761,
  })
  ok(same(admissionTags(bad), ['slow', 'degraded', 'unstable']), `又慢又掉包又不稳 → ${admissionTags(bad).join('+')}`)
  // 门禁不受影响：仍然是「慢速」一条（第一个不通过的类别），不是三个
  ok(admissionOf(bad).kind === 'slow', 'admissionOf 仍然是 slow（门禁只报第一个）')
}

console.log('[3] 不稳定 / 证据不足的分界与 score.js 一致（样本 < 3 不下结论）')
{
  const few = row({ status: 'inconclusive', availability: 0.5, samples: 2 })
  ok(same(admissionTags(few), ['inconclusive']), '样本 2 → 证据不足')
  const enough = row({ status: 'unstable', availability: 0.5, samples: 3 })
  ok(same(admissionTags(enough), ['unstable']), '样本 3 → 不稳定')
}

console.log('[4] 没有分母 / 冷却中 / 兜底各标各的')
{
  const noEvidence = row({ status: 'unknown', availability: null, samples: 6 })
  ok(same(admissionTags(noEvidence), ['no-evidence']), '有样本但没有可用率 → 没有可信样本')
  const stale = row({ status: 'stale', availability: null, samples: 6 })
  ok(same(admissionTags(stale), ['fallback']), '证据全过期 → 兜底（不是「没有可信样本」）')
  // 余额不足不叫「冷却」：单独一个 billing 标签，让页面直接写「请充值」
  const broke = row({ status: 'unknown', availability: null, samples: 6, blocked: { kind: 'quota', until: Date.now() + 1e6 } })
  ok(same(admissionTags(broke), ['billing']), '余额不足 → billing，不标「没有可信样本」')
  const billingOnly = row({ status: 'unknown', availability: null, samples: 6, billingOnly: true })
  ok(same(admissionTags(billingOnly), ['unverified']), '纯账单问题 → 待验证（不叫「没有可信样本」）')
  const blocked = row({
    status: 'unknown',
    availability: null,
    samples: 6,
    blocked: { kind: 'rate-limit', until: Date.now() + 1e6 },
  })
  ok(same(admissionTags(blocked), ['blocked']), '真冷却（限流）→ 只标冷却，不标「没有可信样本」')
  // 冷却 + 慢速：两件事都成立，都标
  const blockedSlow = row({ tooSlow: true, blocked: { kind: 'rate-limit', until: Date.now() + 1e6 } })
  ok(same(admissionTags(blockedSlow), ['slow', 'blocked']), '又慢又冷却 → slow + blocked')
  // 冷却到期、但还没有成功证据：不是「冷却中」，也不是「可用」，是「等探测确认」
  const recovering = row({ pendingRecovery: { kind: 'rate-limit', since: Date.now() - 60000 } })
  ok(same(admissionTags(recovering), ['awaiting-recovery']), '冷却到期待复测 → awaiting-recovery')
  const recoveringNoEvidence = row({
    status: 'unknown',
    availability: null,
    samples: 6,
    pendingRecovery: { kind: 'rate-limit', since: Date.now() - 3600000 },
  })
  ok(
    same(admissionTags(recoveringNoEvidence), ['awaiting-recovery']),
    '待复测时不再重复标「没有可信样本」（同一个原因说一次就够）',
  )
}

console.log('[5] explain 把标签下发给前端（决策页照着画）')
{
  const offers = [
    { id: 'a', providerId: 'p1', credentialId: 'c1', upstreamName: 'gpt-x', modelKey: 'gpt-x', inPrice: 1, outPrice: 2, currency: 'USD', priceUnit: 'per_mtok', pricingMode: 'manual' },
  ]
  const providers = [{ id: 'p1', name: '站A' }]
  const credentials = [{ id: 'c1', providerId: 'p1', group: '' }]
  const scores = new Map([
    ['a', { offerId: 'a', status: 'degraded', availability: 0.33, samples: 10, integrityFaults: ['指纹不符'], ttftMs: 9000 }],
  ])
  const candidates = selectCandidates({
    offers,
    providers,
    credentials,
    scores,
    benchmarks: {},
    settings: { maxTtftMs: 6000, fxUsdCny: 7 },
    model: 'gpt-x',
  })
  const [row0] = explain(candidates)
  ok(same(row0.tags, ['slow', 'degraded', 'unstable']), `explain 带出 tags：${row0.tags.join('+')}`)
  ok(row0.admission?.ok === false && row0.admission.kind === 'slow', '准入仍然只报第一个（slow）')
}

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
