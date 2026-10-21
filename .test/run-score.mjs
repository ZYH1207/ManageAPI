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
