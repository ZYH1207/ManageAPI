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
  ok(s.get('d').integrityFaults.includes('指纹不符'), '明确给出不合格项')
  // 平滑后：指纹 1/2=0.5×0.5 + 未截断 1×0.3 + 计费 1×0.2 = 0.75
  // （以前是硬 0，一次探针异常就把成本翻倍；现在只轻微降权，靠 integrityFaults 拦下）
  ok(Math.abs(s.get('d').integrity - 0.75) < 1e-9, `完整性按平滑值折算（实际 ${s.get('d').integrity}）`)
}

console.log('[4b] 截断/虚报要 2 个样本才定性，单次异常只轻微降权')
{
  const once = score([{ offerId: 't1', ok: true, ts: ago(0.1), ...base, truncated: true }]).get('t1')
  ok(once.status === 'healthy', `单次截断不下结论（实际 ${once.status}）`)
  ok(once.integrity < 1 && once.integrity > 0.8, `但质量轻微下降（实际 ${once.integrity.toFixed(3)}）`)
  ok(isRoutable(once) === true, '仍然可路由')

  const twice = score([
    { offerId: 't2', ok: true, ts: ago(0.1), ...base, truncated: true },
    { offerId: 't2', ok: true, ts: ago(0.2), ...base, truncated: true },
  ]).get('t2')
  ok(twice.status === 'degraded', `连续 2 次截断 → 结果可疑（实际 ${twice.status}）`)
  ok(twice.integrityFaults.includes('输出截断'), '不合格项写清楚了')
  ok(isRoutable(twice) === false, '不可路由')
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

console.log('[6] 证据新鲜度统一：任何有效证据都算数，不只看探针')
{
  // 探针 7 小时前，但 10 分钟前有真实调用失败（站点故障）：证据是新鲜的，
  // 不能判「过期」把失败信号盖掉
  const freshFail = score([{ offerId: 'e1', ok: true, ts: ago(7), ...base }], {
    e1: { ok: 0, fail: 1, since: ago(0.3), lastFailAt: new Date(now - 10 * 60000).toISOString() },
  }).get('e1')
  ok(freshFail.stale === false, '真实失败也是新鲜证据 → 不判过期')
  ok(freshFail.status === 'inconclusive', `1 次失败证据不足（实际 ${freshFail.status}）`)
  ok(freshFail.evidenceAgeMs < 3600000, '证据年龄取自最近一次真实调用')

  // 探针 7 小时前 + 没有任何真实流量 → 过期
  const noEvidence = score([{ offerId: 'e2', ok: true, ts: ago(7), ...base }]).get('e2')
  ok(noEvidence.stale === true, '只有旧探针 → 过期')

  // 过期流量不算证据
  const oldTraffic = score([{ offerId: 'e3', ok: true, ts: ago(7), ...base }], {
    e3: { ok: 5, fail: 0, since: ago(3), lastOkAt: ago(3) },
  }).get('e3')
  ok(oldTraffic.stale === true, '流量记录本身已过期 → 不能续命')
}

console.log('[7] 置信度：healthy 也分证据厚薄')
{
  const one = score([{ offerId: 'c1', ok: true, ts: ago(0.1), ...base }]).get('c1')
  ok(one.status === 'healthy' && one.confidence === 'low', `1 个样本 → 健康但低置信（${one.confidence}）`)
  const three = score([1, 2, 3].map(() => ({ offerId: 'c2', ok: true, ts: ago(0.1), ...base }))).get('c2')
  ok(three.confidence === 'medium', `3 个样本 → 中置信（${three.confidence}）`)
  const ten = score(Array.from({ length: 10 }, () => ({ offerId: 'c3', ok: true, ts: ago(0.1), ...base }))).get('c3')
  ok(ten.confidence === 'high', `10 个样本 → 高置信（${ten.confidence}）`)
}

console.log('[8] 正常与长期评分不受影响')
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
