/**
 * 故障转移自检（纯函数为主，不联网）：
 *   1. 上报落盘：形状、保持期钳制、历史封顶
 *   2. 活跃判定：期内 active、到期 expired（过期即恢复参选资格）
 *   3. 故障匹配：offerId 精确命中；modelKey 命中同款全部供给
 *   4. selectCandidates：故障降级不拉黑——探针说健康就照样 admission.ok，只是同类靠后
 *   5. 自动路由：现役被上报 → 立刻转移（reason='failover'，不受 15% 迟滞约束），
 *      并记住 failoverFrom；探针说健康也拦不住转移（真实故障 > 探针）
 *   6. 保持期过后：重回全场第一 → 提回来（reason='fault-recovery'）；
 *      已让位给更好的 → 回提作废，正常竞争
 *   7. 人工解除（clear）→ 立刻恢复参选
 *
 * 用法：node .test/check-failover.mjs
 */
import {
  addFaultReport,
  activeReports,
  expireFaultReports,
  clearFaultReports,
  faultMatcher,
  normalizeFailover,
  FAULT_HOLD_MS,
  MAX_FAULT_REPORTS,
} from '../core/failover.js'
import { selectCandidates } from '../core/router.js'
import { pickAutoRoute, normalizeAutoRoute, applyAutoRoutePick, AUTO_ROUTE_SWITCH_GAIN } from '../core/auto-route.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

console.log('[1] 上报落盘：形状 / 保持期钳制 / 历史封顶')
{
  const entry = { reports: [] }
  const r = addFaultReport(entry, { offerId: 'o1', kind: 'timeout', message: '首字 30s' })
  ok(r.offerId === 'o1' && r.status === 'active' && r.source === 'external-monitor', `形状：${r.id}/${r.kind}`)
  ok(Number.isFinite(r.until) && r.until > Date.now(), 'until 是未来时间戳')
  ok(entry.reports.length === 1, '记录落进 reports')

  const clamped = addFaultReport({ reports: [] }, { offerId: 'o1', holdMs: 1 })
  ok(clamped.until - Date.now() > 30_000, `holdMs 下限 60s（1ms 被钳住）：${Math.round((clamped.until - Date.now()) / 1000)}s`)

  const big = { reports: [] }
  for (let i = 0; i < MAX_FAULT_REPORTS + 20; i += 1) addFaultReport(big, { offerId: `o${i}` })
  ok(big.reports.length === MAX_FAULT_REPORTS, `历史封顶 ${MAX_FAULT_REPORTS}：${big.reports.length}`)
  ok(FAULT_HOLD_MS === 10 * 60_000, `默认保持期 10 分钟：${FAULT_HOLD_MS}`)
  ok(normalizeFailover('junk').reports.length === 0, '非法输入 → 空形状')
}

console.log('[2] 活跃判定与到期：到期即「故障可能解除」，自动恢复参选资格')
{
  const entry = { reports: [] }
  addFaultReport(entry, { offerId: 'o-alive', holdMs: 60_000 })
  addFaultReport(entry, { offerId: 'o-dead', holdMs: 60_000 })
  // 手动把第二条改成已到期
  entry.reports[1].until = Date.now() - 1
  ok(activeReports(entry).some((r) => r.offerId === 'o-alive'), '期内 → active')
  ok(!activeReports(entry).some((r) => r.offerId === 'o-dead'), '到期 → 不再活跃')
  ok(expireFaultReports(entry) === 1, '到期收尾标记 expired')
  ok(entry.reports.find((r) => r.offerId === 'o-dead').status === 'expired', '状态改成 expired（历史保留）')
}

console.log('[3] 匹配：offerId 精确；modelKey 命中同款全部供给')
{
  const entry = { reports: [] }
  addFaultReport(entry, { offerId: 'o1' })
  addFaultReport(entry, { modelKey: 'm-broken' })
  const match = faultMatcher(entry)
  ok(match({ id: 'o1', modelKey: 'm-x' }) === true, 'offerId 命中')
  ok(match({ id: 'o9', modelKey: 'm-x' }) === false, '别的供给不误伤')
  ok(match({ id: 'o-anything', modelKey: 'm-broken' }) === true, '模型级：同款全部命中')
}

// ------------------------------------------------------------ 路由与自动路由
const provider = (id, name) => ({ id, name })
const credential = (id, providerId) => ({ id, providerId, group: '', tail: '0000' })
const offer = (id, providerId, modelKey, cny, ttft) => ({
  id,
  providerId,
  credentialId: `c-${providerId}`,
  group: '',
  modelKey,
  upstreamName: modelKey,
  pricingMode: 'manual',
  priceUnit: 'per_mtok',
  currency: 'CNY',
  inPrice: cny,
  outPrice: cny,
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
  confidence: 'medium',
  ttftMs: 3000,
  ...patch,
})

// m-a：甲站（现役，最优）；m-b：乙站（次优，有效成本贵 50%）
const db = (patch = {}) => ({
  settings: {
    fx: { base: 'USD', rates: { CNY: 7.2 } },
    fxUsdCny: 7.2,
    maxTtftMs: 0,
    allowUntrusted: false,
    decisionMode: 'value',
    autoRoute: { enabled: true, modelKey: null, offerId: null, pickedAt: null, reason: null, failoverFrom: null },
    ...patch.settings,
  },
  providers: [provider('p1', '甲站'), provider('p2', '乙站')],
  credentials: [credential('c-p1', 'p1'), credential('c-p2', 'p2')],
  offers: [offer('o-a1', 'p1', 'm-a', 2, 3000), offer('o-b1', 'p2', 'm-b', 3, 3000)],
  manualOrder: {},
  failover: { reports: [] },
  ...patch,
})
const scores = { 'o-a1': score(), 'o-b1': score() }
const benchmarks = {}

console.log('[4] selectCandidates：故障降级不拉黑（探针说健康照样 admission.ok）')
{
  const d = db()
  addFaultReport(d.failover, { offerId: 'o-a1' })
  const rows = selectCandidates({
    offers: d.offers.filter((o) => o.modelKey === 'm-a'),
    providers: d.providers,
    credentials: d.credentials,
    scores,
    benchmarks,
    settings: d.settings,
    model: 'm-a',
    isFaulted: faultMatcher(d.failover),
  })
  const faulted = rows.find((r) => r.offer.id === 'o-a1')
  ok(faulted.faulted === true, '被上报的行标 faulted')
  ok(faulted.admission.ok === true, '探针健康 → admission 仍然 ok（降级不拉黑）')
  ok(rows[0].offer.id === 'o-b1' || rows.length === 1, `同类里故障行靠后：${rows.map((r) => r.offer.id).join(',')}`)
}

console.log('[5] 自动路由：现役被上报 → 立刻转移，不受迟滞约束；探针健康也拦不住')
{
  // 现役 m-a（有效成本 2），替补 m-b（3，只差 50%？——3/2 = 差 33% > 15%，会正常换；
  // 为了验证「不受迟滞约束」再造一个只差 5% 的替补 m-c）
  const d = db({ offers: [offer('o-a1', 'p1', 'm-a', 2, 3000), offer('o-c1', 'p2', 'm-c', 2.05, 3000)] })
  d.settings.autoRoute = { enabled: true, modelKey: 'm-a', offerId: 'o-a1', pickedAt: 't0', reason: 'gain', failoverFrom: null }
  const s = { ...scores, 'o-c1': score() }
  // 先确认没故障时：m-c 只好 2.4%（< 15%）→ 迟滞挡住，不换
  const keep = pickAutoRoute(d, { scores: s, benchmarks })
  ok(keep.modelKey === 'm-a' && keep.reason === 'keep', `无故障时只好 2.4% → 迟滞挡住：${keep.modelKey}/${keep.reason}`)
  // 现役被上报 → 立刻转移到 m-c
  addFaultReport(d.failover, { offerId: 'o-a1' })
  const moved = pickAutoRoute(d, { scores: s, benchmarks })
  ok(moved.modelKey === 'm-c' && moved.reason === 'failover' && moved.switched === true, `现役被上报 → 立刻转移：${moved.modelKey}/${moved.reason}`)
  ok(moved.failoverFrom === 'm-a', `记住让位对象：${moved.failoverFrom}`)

  // applyAutoRoutePick 落盘 failoverFrom
  const settings = { autoRoute: normalizeAutoRoute({ enabled: true, modelKey: 'm-a', failoverFrom: null }) }
  applyAutoRoutePick(settings, moved)
  ok(settings.autoRoute.failoverFrom === 'm-a' && settings.autoRoute.modelKey === 'm-c', '落盘含 failoverFrom')
}

console.log('[6] 保持期过后：仍是全场第一 → 提回来；已让位 → 回提作废')
{
  // 现役 m-c（2.05，failoverFrom=m-a）。m-a 故障到期 → m-a（2）重新最优 → 提回
  const d = db({ offers: [offer('o-a1', 'p1', 'm-a', 2, 3000), offer('o-c1', 'p2', 'm-c', 2.05, 3000)] })
  d.settings.autoRoute = { enabled: true, modelKey: 'm-c', offerId: 'o-c1', pickedAt: 't0', reason: 'failover', failoverFrom: 'm-a' }
  // 故障已到期：activeReports 里没有 o-a1 → 恢复参选
  const back = pickAutoRoute(d, { scores, benchmarks })
  ok(back.modelKey === 'm-a' && back.reason === 'fault-recovery', `故障到期且重回第一 → 提回：${back.modelKey}/${back.reason}`)
  ok(back.failoverFrom === null, '回提后清 failoverFrom')

  // 已让位：替补换成了更优的 m-e（1.5），m-a 恢复了但不是第一 → 不动
  const e = db({ offers: [offer('o-a1', 'p1', 'm-a', 2, 3000), offer('o-e1', 'p2', 'm-e', 1.5, 3000)] })
  e.settings.autoRoute = { enabled: true, modelKey: 'm-e', offerId: 'o-e1', pickedAt: 't0', reason: 'failover', failoverFrom: 'm-a' }
  const stay = pickAutoRoute(e, { scores: { ...scores, 'o-e1': score() }, benchmarks })
  ok(stay.modelKey === 'm-e', `m-a 恢复了但不是第一（m-e 1.5 更优）→ 不动：${stay.modelKey}/${stay.reason}`)
}

console.log('[7] 人工解除 → 立刻恢复参选')
{
  const entry = { reports: [] }
  addFaultReport(entry, { offerId: 'o1' })
  ok(faultMatcher(entry)({ id: 'o1' }) === true, '解除前命中')
  clearFaultReports(entry, { offerId: 'o1' })
  ok(faultMatcher(entry)({ id: 'o1' }) === false, '解除后不再命中')
  ok(entry.reports[0].status === 'cleared', '状态 cleared（历史保留）')
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
