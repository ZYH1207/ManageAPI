/**
 * 故障信号（core/fault-signal.js）的口径验证。
 *
 * 这个模块的核心不是「能发信号」，而是「什么时候**不该**发」：
 * 救回来的事一律不打扰路由，只有明显影响干活才升级。所以测试重点是判定表。
 */
import {
  buildFaultSignal,
  judgeEmptyFault,
  subscribeFaults,
  publishFault,
  faultKey,
  isExpired,
  ensureFaultSignals,
  recordFaultSignal,
  activeFaultSignals,
  clearFaultSignals,
  summarizeFaultSignals,
  FAULT_HITS_FOR_FAULTY,
  FAULT_TTL_MS,
} from '../core/fault-signal.js'

const passed = []
function ok(cond, name, extra) {
  passed.push(Boolean(cond))
  console.log(`  ${cond ? '✓' : '✗'} ${name}${!cond && extra ? `  ← ${extra}` : ''}`)
  if (!cond) process.exitCode = 1
}

console.log('\n[1] 判定表：救回来的一律不打扰路由')
{
  const recoveredByRetry = judgeEmptyFault({ hits: 1, recovered: true, hadFallback: true })
  ok(recoveredByRetry.level === 'notice', '补问救回 → notice')
  ok(recoveredByRetry.broadcast === false, 'notice 不广播')

  const recoveredByLocal = judgeEmptyFault({ hits: 1, recovered: true, hadFallback: true })
  ok(recoveredByLocal.broadcast === false, '本地重建救回 → 同样不广播')

  const broken = judgeEmptyFault({ hits: 1, recovered: false, hadFallback: true })
  ok(broken.level === 'degraded', '补问也失败 → degraded')
  ok(broken.broadcast === true, 'degraded 要广播')

  const noFallback = judgeEmptyFault({ hits: 1, recovered: false, hadFallback: false })
  ok(noFallback.level === 'degraded', '没别家可换 → degraded')
  ok(noFallback.broadcast === true, '同样要广播')
}

console.log('\n[2] 判定表：连续犯病升级成 faulty（哪怕这次救回来了）')
{
  const third = judgeEmptyFault({ hits: FAULT_HITS_FOR_FAULTY, recovered: true, hadFallback: true })
  ok(third.level === 'faulty', `第 ${FAULT_HITS_FOR_FAULTY} 次 → faulty`)
  ok(third.suggested === 'avoid', '建议避开')
  ok(third.broadcast === true, '要广播')
  ok(third.reason.includes('次空回合'), `理由说清次数（${third.reason}）`)

  const second = judgeEmptyFault({ hits: 2, recovered: true, hadFallback: true })
  ok(second.level === 'notice', '第 2 次还不算故障（阈值是 3）')
}

console.log('\n[3] 信号形状与过期')
{
  const signal = buildFaultSignal({
    kind: 'empty-turn',
    level: 'degraded',
    scope: { providerId: 'p1', providerName: '某站', offerId: 'o1', modelKey: 'm', model: 'm' },
    reason: '测试',
    suggested: 'deprioritize',
  })
  ok(signal.level === 'degraded', '级别保留')
  ok(signal.active === true, '默认是生效中')
  ok(Boolean(signal.expiresAt), 'degraded 带过期时间')
  ok(!isExpired(signal), '刚建的没过期')
  ok(isExpired(signal, Date.now() + FAULT_TTL_MS.degraded + 1000), '过了 TTL 就过期')

  const notice = buildFaultSignal({ level: 'notice', scope: { offerId: 'o1' } })
  ok(notice.expiresAt === null, 'notice 不过期（它是历史）')

  const clearSignal = buildFaultSignal({ level: 'degraded', active: false, scope: { offerId: 'o1' } })
  ok(clearSignal.expiresAt === null, '解除信号不带过期时间')
}

console.log('\n[4] 订阅与广播')
{
  const got = []
  const off = subscribeFaults((signal) => got.push(signal))
  const signal = buildFaultSignal({ level: 'degraded', scope: { offerId: 'o1' }, reason: 'x' })
  const delivered = publishFault(signal)
  ok(delivered === 1, `送到 1 个订阅者（实际 ${delivered}）`)
  ok(got.length === 1 && got[0].reason === 'x', '订阅者收到了信号')
  off()
  const after = publishFault(signal)
  ok(after === 0, '退订之后不再收到')
}

console.log('\n[5] 订阅者抛异常不能拖垮网关')
{
  const off = subscribeFaults(() => {
    throw new Error('我的业务崩了')
  })
  const warnings = []
  const delivered = publishFault(buildFaultSignal({ level: 'faulty' }), {
    logger: { warn: (msg) => warnings.push(msg) },
  })
  ok(delivered === 0, '异常算未送达')
  ok(warnings.length === 1, '但记了一条警告，不是静默吞掉')
  off()
}

console.log('\n[6] 落库去重：同一供给同一类问题只留一条')
{
  const db = {}
  ensureFaultSignals(db)
  const make = (hits) =>
    buildFaultSignal({
      kind: 'empty-turn',
      level: 'degraded',
      scope: { providerId: 'p1', offerId: 'o1' },
      reason: 'r',
      hits,
    })
  const first = recordFaultSignal(db, make(1))
  const second = recordFaultSignal(db, make(2))
  ok(db.faultSignals.length === 1, `只留一条（实际 ${db.faultSignals.length}）`)
  ok(first.id === second.id, '是同一条被更新')
  ok(second.hits === 2, '命中次数累加')
}

console.log('\n[7] 快照只给「生效中」的，且排除 notice')
{
  const db = {}
  ensureFaultSignals(db)
  recordFaultSignal(db, buildFaultSignal({ level: 'notice', scope: { offerId: 'o1' } }))
  recordFaultSignal(db, buildFaultSignal({ level: 'degraded', scope: { offerId: 'o2' } }))
  recordFaultSignal(db, buildFaultSignal({ level: 'faulty', scope: { offerId: 'o3' } }))
  const snapshot = activeFaultSignals(db)
  ok(!snapshot.has('o1'), 'notice 不进路由视野')
  ok(snapshot.has('o2'), 'degraded 在快照里')
  ok(snapshot.get('o3').level === 'faulty', 'faulty 也在，且级别正确')

  const summary = summarizeFaultSignals(db)
  ok(summary.active === 2, `生效中 2 条（实际 ${summary.active}）`)
  ok(summary.faulty === 1 && summary.degraded === 1, '分级计数正确')
}

console.log('\n[8] 清除：恢复后必须能放回去')
{
  const db = {}
  ensureFaultSignals(db)
  recordFaultSignal(db, buildFaultSignal({ level: 'faulty', scope: { providerId: 'p1', offerId: 'o1' } }))
  recordFaultSignal(db, buildFaultSignal({ level: 'degraded', scope: { providerId: 'p2', offerId: 'o2' } }))
  const cleared = clearFaultSignals(db, { offerId: 'o1' })
  ok(cleared === 1, '清掉 1 条')
  ok(!activeFaultSignals(db).has('o1'), 'o1 不在快照里了（可以放回候选）')
  ok(activeFaultSignals(db).has('o2'), 'o2 不受影响')
  const row = db.faultSignals.find((s) => s.scope.offerId === 'o1')
  ok(row.active === false && Boolean(row.resolvedAt), '是标成解除，不是删掉（留痕）')
}

console.log('\n[9] 过期自动失效（黑名单不能永久）')
{
  const db = {}
  ensureFaultSignals(db)
  const signal = buildFaultSignal({ level: 'degraded', scope: { offerId: 'o1' } })
  recordFaultSignal(db, signal)
  ok(activeFaultSignals(db).has('o1'), '现在还没到期，在快照里')
  const later = Date.parse(signal.expiresAt) + 1000
  ok(!activeFaultSignals(db, later).has('o1'), '过了到期时间自动消失（黑名单不会永久）')
  ok(activeFaultSignals(db, later).size === 0, '快照为空')
}

console.log('\n[10] 去重键')
{
  const a = faultKey({ kind: 'empty-turn', scope: { offerId: 'o1', providerId: 'p1' } })
  const b = faultKey({ kind: 'empty-turn', scope: { offerId: 'o1', providerId: 'p2' } })
  ok(a === b, '按 offerId 归并（同一供给换了站名也算一条）')
  const c = faultKey({ kind: 'integrity', scope: { offerId: 'o1' } })
  ok(a !== c, '不同 kind 分开算')
}

console.log(`\n${passed.every(Boolean) ? '全部通过 ✓' : '有失败 ✗'}`)
