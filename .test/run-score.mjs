/** 验证评分层：时效、真实流量合并、路由放行判断。 */
import { scoreOffers, isRoutable } from '../core/score.js'

const now = Date.now()
const ago = (hours) => new Date(now - hours * 3600 * 1000).toISOString()

const base = { fingerprintOk: true, truncated: false, billingInflated: false, ttftMs: 120, latencyMs: 900 }

const probes = [
  // 刚探过，一切正常
  { offerId: 'fresh-ok', ok: true, ts: ago(0.1), ...base },
  // 10 小时前探过，正常，但已过期
  { offerId: 'stale-ok', ok: true, ts: ago(10), ...base },
  // 探针失败一次
  { offerId: 'probe-fail', ok: false, ts: ago(0.1), error: 'HTTP 503' },
  // 探针正常，但真实流量大面积失败
  { offerId: 'traffic-bad', ok: true, ts: ago(0.1), ...base },
]

const traffic = {
  'traffic-bad': { ok: 2, fail: 8, since: ago(0.5) },
  'fresh-ok': { ok: 20, fail: 0, since: ago(0.5) },
}

const scores = scoreOffers(probes, traffic, { maxAgeMs: 6 * 3600 * 1000, now })

console.log('offer            status      可用率  完整性  过期   可路由')
for (const [id, s] of scores) {
  console.log(
    `${id.padEnd(16)} ${String(s.status).padEnd(10)} ` +
    `${String(s.availability?.toFixed(2) ?? '—').padEnd(7)} ` +
    `${String(s.integrity?.toFixed(2) ?? '—').padEnd(7)} ` +
    `${String(s.stale).padEnd(6)} ${isRoutable(s)}`,
  )
}

console.log('\n期望：')
console.log('  fresh-ok     healthy   可用率 1.00  可路由 true')
console.log('  stale-ok     stale     可路由 false（10 小时前，超过 6 小时有效期）')
console.log('  probe-fail   unstable  可路由 false')
console.log('  traffic-bad  unstable  可用率约 0.19  可路由 false（探针正常但真实流量失败多）')

// ---------------------------------------------------------------- 断言部分
// 上面的表是给人对照的；这里把关键行为钉成断言，跑挂了才叫失败。
let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

console.log('\n断言：短期评分')
ok(scores.get('fresh-ok')?.status === 'healthy', '正常探针 → healthy')
ok(isRoutable(scores.get('fresh-ok')) === true, 'healthy 可路由')
ok(scores.get('stale-ok')?.stale === true && !isRoutable(scores.get('stale-ok')), '过期评分不可路由')
ok(scores.get('traffic-bad')?.status === 'unstable', '探针正常但真实流量大面积失败 → unstable')

console.log('\n断言：长期评分（longTermScores）')
{
  const { longTermScores } = await import('../core/score.js')
  const long = longTermScores(probes, traffic, { now })
  const fresh = long.get('fresh-ok')
  ok(Boolean(fresh) && fresh.score > 0, '有探针的 offer 有长期分')
  const bad = long.get('traffic-bad')
  ok(Boolean(bad) && bad.uptime < 0.5, '流量失败的 offer 长期 uptime 偏低')

  // 纯流量站：traffic 里有、probes 里一条都没有——概览排名靠长期分，
  // 此前这类 offer 不进长期评分，天天在用的站会从站点排名里凭空消失
  const trafficOnly = { 'traffic-only': { ok: 9, fail: 1, since: ago(0.5) } }
  const long2 = longTermScores(probes, trafficOnly, { now })
  const entry = long2.get('traffic-only')
  ok(Boolean(entry), '只有流量、没探过针的 offer 也有长期分')
  ok(entry && Math.abs(entry.uptime - 0.9) < 1e-9, '纯流量条目的 uptime 就是流量成功率（0.9）')
  ok(entry && entry.avgQuality === null, '纯流量条目质量未知记 null（不编造）')
  ok(entry && entry.score === 90, '纯流量条目得分 = uptime × 100（质量按 1）')
  ok(entry && entry.lastAt === trafficOnly['traffic-only'].since, '纯流量条目 lastAt 用流量窗口起点')
}

console.log(failed === 0 ? '\n断言全部通过 ✓' : `\n${failed} 项断言失败`)
if (failed > 0) process.exit(1)
