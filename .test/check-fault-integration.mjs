/**
 * 诊断 → 自动路由的联动验证。
 *
 * 验的是这条链路能不能真跑通：
 *   空回合守卫抓到故障
 *     → core/fault-signal.js 判定「这不是能自己救回来的事」
 *     → 写进 core/failover.js 的故障账（自动路由与路由排序实际消费的那一份）
 *     → selectCandidates 把这条供给排到同类最后
 *     → 自动路由不把它当「最优」
 *     → 恢复信号 → 故障账清除 → 供给重新参与竞争
 *
 * 为什么要单独测这个：两个模块各自的单测都绿，不代表中间那根线接上了。
 * 真实踩过「判定写了、动作没做」这种「看起来做了什么也没做」的坑。
 */
import { judgeEmptyFault, buildFaultSignal, applyFaultToFailover } from '../core/fault-signal.js'
import { faultMatcher, activeReports } from '../core/failover.js'
import { selectCandidates } from '../core/router.js'
import { pickAutoRoute } from '../core/auto-route.js'

const passed = []
function ok(cond, name, extra) {
  passed.push(Boolean(cond))
  console.log(`  ${cond ? '✓' : '✗'} ${name}${!cond && extra ? `  ← ${extra}` : ''}`)
  if (!cond) process.exitCode = 1
}

/** 造一个最小可用的库：两个站、各一条同模型供给，A 便宜、B 贵 */
function makeDb() {
  return {
    settings: {
      decisionMode: 'value',
      maxTtftMs: 0,
      fx: { base: 'USD', rates: { CNY: 7.2 } },
      blendInputWeight: 0.25,
    },
    providers: [
      { id: 'pA', name: '便宜站A', baseUrl: 'http://a' },
      { id: 'pB', name: '正常站B', baseUrl: 'http://b' },
    ],
    credentials: [
      { id: 'cA', providerId: 'pA' },
      { id: 'cB', providerId: 'pB' },
    ],
    offers: [
      {
        id: 'oA',
        providerId: 'pA',
        modelKey: 'test-model',
        upstreamName: 'test-model',
        pricingMode: 'manual',
        inPrice: 1,
        outPrice: 2,
      },
      {
        id: 'oB',
        providerId: 'pB',
        modelKey: 'test-model',
        upstreamName: 'test-model',
        pricingMode: 'manual',
        inPrice: 4,
        outPrice: 8,
      },
    ],
    manualOrder: {},
    failover: { reports: [] },
  }
}

/** 用同一份口径排一次序，返回候选行 */
function rank(db) {
  return selectCandidates({
    offers: db.offers,
    providers: db.providers,
    credentials: db.credentials,
    scores: new Map(),
    benchmarks: {},
    settings: db.settings,
    model: 'test-model',
    order: null,
    isFaulted: faultMatcher(db.failover),
    detours: new Map(),
  })
}

console.log('\n[1] 基线：没有任何故障时，便宜站 A 排第一')
{
  const db = makeDb()
  const rows = rank(db)
  ok(rows[0]?.offer.id === 'oA', `A 在前（实际 ${rows[0]?.offer.id}）`)
  ok(rows.every((row) => row.admission?.ok), '两条都准入通过')
}

console.log('\n[2] 救回来的空回合（notice）→ 不上报，路由不受影响')
{
  const db = makeDb()
  const verdict = judgeEmptyFault({ hits: 1, recovered: true, hadFallback: true })
  const signal = buildFaultSignal({
    kind: 'empty-turn',
    level: verdict.level,
    scope: { providerId: 'pA', providerName: '便宜站A', offerId: 'oA', modelKey: 'test-model' },
    reason: verdict.reason,
  })
  const report = applyFaultToFailover(db, signal)
  ok(report === null, 'notice 不写故障账')
  ok(activeReports(db.failover).length === 0, '故障账里没有记录')
  const rows = rank(db)
  ok(rows[0]?.offer.id === 'oA', 'A 仍然排第一（救回来的事不打扰路由）')
}

console.log('\n[3] 连续犯病（faulty）→ 写进故障账，A 掉到最后')
{
  const db = makeDb()
  const verdict = judgeEmptyFault({ hits: 3, recovered: true, hadFallback: true })
  ok(verdict.level === 'faulty', '判成 faulty')
  const signal = buildFaultSignal({
    kind: 'empty-turn',
    level: verdict.level,
    scope: { providerId: 'pA', providerName: '便宜站A', offerId: 'oA', modelKey: 'test-model' },
    reason: verdict.reason,
    suggested: 'avoid',
  })
  const report = applyFaultToFailover(db, signal)
  ok(report && report.offerId === 'oA', '写进了故障账，指向 oA')
  ok(activeReports(db.failover).length === 1, '故障账里 1 条')

  const rows = rank(db)
  ok(rows[0]?.offer.id === 'oB', `排序变了：B 到第一（实际 ${rows[0]?.offer.id}）`)
  ok(rows.find((row) => row.offer.id === 'oA')?.faulted === true, 'A 被标成 faulted')
  ok(
    rows.find((row) => row.offer.id === 'oA')?.admission?.ok === true,
    '但 A 的准入仍然通过（降级不拉黑）',
  )
}

console.log('\n[4] 自动路由不会把故障中的供给当最优')
{
  const db = makeDb()
  const before = pickAutoRoute(db, { scores: new Map(), benchmarks: {}, force: true })
  ok(before?.offerId === 'oA', `故障前自动路由选 A（实际 ${before?.offerId}）`)

  applyFaultToFailover(
    db,
    buildFaultSignal({
      kind: 'empty-turn',
      level: 'faulty',
      scope: { providerId: 'pA', providerName: '便宜站A', offerId: 'oA', modelKey: 'test-model' },
      reason: '连续空回合',
    }),
  )
  const after = pickAutoRoute(db, { scores: new Map(), benchmarks: {}, force: true })
  ok(after?.offerId === 'oB', `故障后自动路由改选 B（实际 ${after?.offerId}）`)
}

console.log('\n[5] 恢复信号 → 故障账清除 → A 重新参选')
{
  const db = makeDb()
  applyFaultToFailover(
    db,
    buildFaultSignal({
      kind: 'empty-turn',
      level: 'faulty',
      scope: { providerId: 'pA', providerName: '便宜站A', offerId: 'oA', modelKey: 'test-model' },
      reason: '连续空回合',
    }),
  )
  ok(rank(db)[0].offer.id === 'oB', '故障中：B 在前')

  applyFaultToFailover(
    db,
    buildFaultSignal({
      kind: 'empty-turn',
      level: 'notice',
      active: false,
      scope: { providerId: 'pA', providerName: '便宜站A', offerId: 'oA', modelKey: 'test-model' },
      reason: '复检通过，已恢复',
    }),
  )
  ok(activeReports(db.failover).length === 0, '故障账清空了')
  ok(rank(db)[0].offer.id === 'oA', 'A 又排回第一（能放回来才叫恢复）')
  ok(pickAutoRoute(db, { scores: new Map(), benchmarks: {}, force: true })?.offerId === 'oA', '自动路由也选回 A')
}

console.log('\n[6] 没有 offerId 时按模型级上报（整款模型都被避开）')
{
  const db = makeDb()
  applyFaultToFailover(
    db,
    buildFaultSignal({
      kind: 'empty-turn',
      level: 'degraded',
      scope: { providerId: 'pA', providerName: '便宜站A', offerId: null, modelKey: 'test-model' },
      reason: '模型级故障',
    }),
  )
  const rows = rank(db)
  ok(rows.every((row) => row.faulted === true), '同款模型的所有供给都被标故障')
  ok(rows.every((row) => row.admission?.ok), '但准入都没被拉黑')
}

console.log('\n[7] 保持期到期自动恢复参选')
{
  const db = makeDb()
  const signal = buildFaultSignal({
    kind: 'empty-turn',
    level: 'degraded',
    scope: { providerId: 'pA', providerName: '便宜站A', offerId: 'oA', modelKey: 'test-model' },
    reason: 'x',
  })
  applyFaultToFailover(db, signal)
  const later = Date.parse(signal.expiresAt) + 1000
  const activeLater = activeReports(db.failover, later)
  ok(activeLater.length === 0, '过了保持期就不再命中')
  const matcher = faultMatcher(db.failover, later)
  ok(matcher({ id: 'oA', modelKey: 'test-model' }) === false, '查询谓词也不再命中')
}

console.log(`\n${passed.every(Boolean) ? '全部通过 ✓' : '有失败 ✗'}`)
