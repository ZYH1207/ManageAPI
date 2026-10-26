/**
 * 失败归因与冷却自检（纯函数，不联网）：
 *   1. 错误文本能分清「站点故障」和「供给暂时不可用」
 *   2. 额度/限流/模型不在组的失败不拉低可用率，只进入冷却
 *   3. 冷却过期、或之后有成功调用，就自动恢复
 *   4. 真实流量的成功可以给「探针过期」的站点续命
 *
 * 用法：node .test/check-failure-kind.mjs
 */
import { classifyFailure, UNAVAILABLE_COOLDOWN_MS } from '../core/failure.js'
import { scoreOffers, isRoutable } from '../core/score.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

const now = Date.now()
const agoMs = (ms) => new Date(now - ms).toISOString()
const ago = (h) => agoMs(h * 3600000)
const base = { fingerprintOk: true, truncated: false, billingInflated: false, ttftMs: 100, latencyMs: 800 }
const score = (probes, traffic = {}) => scoreOffers(probes, traffic, { maxAgeMs: 6 * 3600000, now })
const probe = (offerId, okFlag, error, hoursAgo) => ({ offerId, ok: okFlag, ts: ago(hoursAgo), error, ...(okFlag ? base : {}) })

console.log('[1] 错误文本分类')
{
  const cases = [
    ['HTTP 403：{"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}', 'quota', false],
    ['HTTP 403：{"error":{"message":"insufficient balance","type":"billing_error"}}', 'quota', false],
    ['HTTP 403：{"error":{"code":"REQUEST_BUDGET_EXCEEDED","message":"本次预计需要 0.36"}}', 'budget', false],
    ['HTTP 429：{"error":{"message":"Upstream rate limit exceeded"}}', 'rate-limit', false],
    ['HTTP 429：{"error":{"message":"All available accounts are currently rate limited"}}', 'rate-limit', false],
    ['HTTP 404：{"error":{"message":"Model \\"deepseek-v4.1\\" is not supported by any configured account"}}', 'model-missing', false],
    ['HTTP 502：{"error":{"message":"Upstream request failed","type":"upstream_error"}}', null, true],
    ['HTTP 503：{"error":{"message":"Service temporarily unavailable"}}', null, true],
    ['The operation was aborted due to timeout', null, true],
    ['fetch failed', null, true],
    ['上游 120 秒无响应（首字超时）', null, true],
  ]
  for (const [text, kind, counts] of cases) {
    const r = classifyFailure(text)
    ok(r.kind === kind && r.countsAsOutage === counts, `${text.slice(0, 42)} → ${r.kind ?? '故障'}`)
  }
}

console.log('[2] 额度类失败不算站点故障，只进冷却')
{
  const probes = [0.1, 0.2, 0.3].map((h) =>
    probe('q', false, 'HTTP 403：{"code":"INSUFFICIENT_BALANCE"}', h),
  )
  const s = score(probes).get('q')
  ok(s.availability === null, `可用率无证据（实际 ${s.availability}）`)
  ok(s.status === 'unknown', `状态 ${s.status}（不是不稳定）`)
  ok(s.unavailableSamples === 3, '额度失败单独计数')
  ok(s.blocked?.kind === 'quota', '标记为额度冷却')
  ok(isRoutable(s) === false, '冷却中不参与路由')

  // 额度失败不该把「站点故障」样本冲掉：混着 5xx 时仍然按故障算
  const mixed = score([
    ...probes,
    probe('m', false, 'HTTP 502 bad gateway', 0.1),
    probe('m', false, 'HTTP 502 bad gateway', 0.2),
    probe('m', false, 'HTTP 502 bad gateway', 0.3),
  ]).get('m')
  ok(mixed.availability === 0 && mixed.outageSamples === 3, '混入额度失败不影响故障口径')
  ok(mixed.status === 'unstable', `真故障仍判不稳定（实际 ${mixed.status}）`)
}

console.log('[3] 冷却会自动过期，或被之后的成功调用解除')
{
  const expired = score([
    probe('e', false, 'HTTP 429：rate limit exceeded', (UNAVAILABLE_COOLDOWN_MS['rate-limit'] + 60000) / 3600000),
  ]).get('e')
  ok(expired.blocked === null, '限流冷却 5 分钟后失效')

  const recovered = score([
    probe('r', false, 'HTTP 403：INSUFFICIENT_BALANCE', 0.5),
    probe('r', true, null, 0.1),
  ]).get('r')
  ok(recovered.blocked === null, '之后探测成功 → 解除冷却')
  ok(recovered.status === 'healthy', '并且判健康')

  // 单次预算超限只冷却 5 分钟：那一次请求太大，不代表供给不能用
  const budget = score([
    probe('b1', false, 'HTTP 403：{"error":{"code":"REQUEST_BUDGET_EXCEEDED"}}', 0.02),
  ]).get('b1')
  ok(budget.blocked?.kind === 'budget', '单次预算超限单独归类')
  const budgetExpired = score([
    probe('b2', false, 'HTTP 403：{"error":{"code":"REQUEST_BUDGET_EXCEEDED"}}', 0.2),
  ]).get('b2')
  ok(budgetExpired.blocked === null, '12 分钟后已不在冷却（不是额度不足的 30 分钟）')
}

console.log('[4] 真实流量里的额度失败同样不进可用率')
{
  const s = score([probe('t', true, null, 0.1)], {
    t: { ok: 3, fail: 0, since: ago(0.2), lastOkAt: agoMs(10 * 60000), kinds: { quota: { n: 2, lastAt: agoMs(5 * 60000) } } },
  }).get('t')
  ok(s.availability === 1, `可用率只算 3 次成功（实际 ${s.availability}）`)
  ok(s.trafficUnavailable === 2, '额度失败单独统计')
  ok(s.blocked?.kind === 'quota', '最近一次是额度失败 → 冷却')
  ok(isRoutable(s) === false, '冷却中不路由')
}

console.log('[5] 真实流量成功给探针过期的站点续命')
{
  const staleNoTraffic = score([probe('s1', true, null, 7)]).get('s1')
  ok(staleNoTraffic.stale === true && isRoutable(staleNoTraffic) === false, '7 小时无流量 → 过期')

  const revived = score([probe('s2', true, null, 7)], {
    s2: { ok: 12, fail: 0, since: ago(0.5), lastOkAt: agoMs(2 * 60000), kinds: {} },
  }).get('s2')
  ok(revived.stale === false, '有新鲜成功流量 → 不算过期')
  ok(revived.availability === 1, '可用率来自真实流量')
  ok(isRoutable(revived) === true, '因此重新可路由')
}

console.log('[6] 没有可靠性样本的供给不能路由（「没测过」不等于「合格」）')
{
  // 探针全被限流挡住：归因后不进可用率分母 → 可用率为 null。
  // 冷却早已过期，所以它不是「冷却中」，而是「没有任何证据」。
  const onlyLimited = score([
    probe('n1', false, 'HTTP 429：rate limit exceeded', 2),
    probe('n1', false, 'HTTP 429：rate limit exceeded', 3),
  ]).get('n1')
  ok(onlyLimited.availability === null, '可用率为空（没有可靠性样本）')
  ok(onlyLimited.blocked === null, '冷却已过期')
  ok(isRoutable(onlyLimited) === false, '仍然不可路由——没证据就不放行')
  ok(onlyLimited.quality === null, '质量为空，不会被当成合格质量参与比价')
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}
