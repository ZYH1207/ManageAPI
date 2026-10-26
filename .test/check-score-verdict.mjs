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

console.log('[5] 真实流量过期后不再计入（否则一小时前的失败永远洗不掉）')
{
  // 窗口内的失败照常拉低可用率
  const fresh = score([{ offerId: 'f', ok: true, ts: ago(0.1), ...base }], {
    f: { ok: 1, fail: 1, since: ago(0.5) },
  })
  ok(fresh.get('f').trafficSamples === 2, '窗口内流量计入样本')
  ok(fresh.get('f').availability === 2 / 3, `窗口内：2 成功 1 失败（实际 ${fresh.get('f').availability}）`)
  ok(fresh.get('f').status === 'unstable', '窗口内失败达到阈值 → 不稳定')

  // 同一条记录过了窗口就完全不算：站点回到探针口径
  const stale = score([{ offerId: 'f2', ok: true, ts: ago(0.1), ...base }], {
    f2: { ok: 1, fail: 1, since: ago(3) },
  })
  ok(stale.get('f2').trafficSamples === 0, '过期流量不计样本')
  ok(stale.get('f2').trafficStale === true, '标记流量已过期')
  ok(stale.get('f2').availability === 1, `过期后只看探针（实际 ${stale.get('f2').availability}）`)
  ok(stale.get('f2').status === 'healthy', '过期失败不再把站点判成不稳定')

  // 只有过期流量、没有探针：没有任何可用的新鲜证据，不能凭空给个可用率
  const onlyStale = score([], { f3: { ok: 0, fail: 1, since: ago(5) } })
  ok(onlyStale.get('f3').availability === null, '只有过期流量时可用率为空')
  ok(isRoutable(onlyStale.get('f3')) === false, '没有新鲜证据不放行')

  // 缺 since 的旧数据无法证明在窗口内，按过期处理
  const noSince = score([], { f4: { ok: 5, fail: 0 } })
  ok(noSince.get('f4').trafficSamples === 0, '缺少 since 的流量不计入')

  // 长期评分同样不吃过期流量
  const long = longTermScores([{ offerId: 'f5', ok: true, ts: ago(0.1), ...base }], {
    f5: { ok: 0, fail: 9, since: ago(4) },
  }, { now })
  ok(long.get('f5').uptime === 1, `长期评分忽略过期流量（实际 ${long.get('f5').uptime}）`)
}

console.log('[6] 正常与长期评分不受影响')
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
