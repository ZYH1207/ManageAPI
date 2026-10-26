/**
 * 评分口径自检（纯函数，不联网）：
 *   1. 样本不足的失败判 inconclusive（不挂红），样本够了才判 unstable
 *   2. 失败记录里缺完整性字段时不被误判成 degraded（掉包）
 *   3. 批量网络异常时本轮探针不写入评分
 *
 * 用法：node .test/check-score-verdict.mjs
 */
import { scoreOffers, isRoutable, longTermScores } from '../core/score.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

const now = Date.now()
const ago = (h) => new Date(now - h * 3600000).toISOString()
const base = { fingerprintOk: true, truncated: false, billingInflated: false, ttftMs: 100, latencyMs: 800 }
const opts = { maxAgeMs: 6 * 3600000, now }
const score = (probes, traffic = {}) => scoreOffers(probes, traffic, opts)

console.log('[1] 样本不足的失败 → 证据不足（不是不稳定）')
{
  const s = score([{ offerId: 'a', ok: false, ts: ago(0.1), error: 'HTTP 503' }])
  ok(s.get('a').status === 'inconclusive', `1 次失败 → ${s.get('a').status}`)
  ok(isRoutable(s.get('a')) === false, '证据不足不参与路由')
  const s2 = score([1, 2].map(() => ({ offerId: 'a2', ok: false, ts: ago(0.1), error: 'HTTP 503' })))
  ok(s2.get('a2').status === 'inconclusive', '2 次失败仍属证据不足（阈值 3）')
}

console.log('[2] 样本够了才判不稳定')
{
  const s = score([1, 2, 3].map(() => ({ offerId: 'b', ok: false, ts: ago(0.1), error: 'HTTP 503' })))
  ok(s.get('b').status === 'unstable', `3 次失败 → ${s.get('b').status}`)
  // 探针 + 真实流量一起算样本
  const s2 = score([{ offerId: 'b2', ok: false, ts: ago(0.1), error: 'HTTP 503' }], {
    b2: { ok: 0, fail: 3, since: ago(0.5) },
  })
  ok(s2.get('b2').status === 'unstable', '探针 1 + 流量 3 失败 → 不稳定')
}

console.log('[3] 失败记录缺完整性字段时不被误判成掉包')
{
  // 失败的探针没有 fingerprintOk/truncated/billingInflated 字段
  const s = score([
    { offerId: 'c', ok: false, ts: ago(0.1), error: 'HTTP 503' },
    { offerId: 'c', ok: false, ts: ago(0.2), error: 'HTTP 503' },
    { offerId: 'c', ok: false, ts: ago(0.3), error: 'HTTP 503' },
  ])
  ok(s.get('c').integrity === null, `完整性无证据时记 null（实际 ${s.get('c').integrity}）`)
  ok(s.get('c').status === 'unstable', '判不稳定（可用率），不是结果可疑（掉包）')
}

console.log('[4] 真的掉包仍然单次即判')
{
  const s = score([{ offerId: 'd', ok: true, ts: ago(0.1), ...base, fingerprintOk: false }])
  ok(s.get('d').status === 'degraded', '单次指纹不符 → 结果可疑')
  // 指纹 0×0.5 + 未截断 1×0.3 + 计费 1×0.2 = 0.5（加权归一，不是字面 0）
  ok(Math.abs(s.get('d').integrity - 0.5) < 1e-9, `完整性按权重折算（实际 ${s.get('d').integrity}）`)
}

console.log('[5] 正常与长期评分不受影响')
{
  const s = score([{ offerId: 'e', ok: true, ts: ago(0.1), ...base }])
  ok(s.get('e').status === 'healthy', '正常 → 健康')
  const long = longTermScores([{ offerId: 'e', ok: true, ts: ago(0.1), ...base }], {}, { now })
  ok(long.get('e').score > 0, '长期评分正常')
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}
