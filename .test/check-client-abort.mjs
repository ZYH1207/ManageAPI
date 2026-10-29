/**
 * 「客户端自己断开」与「站方断流」必须分开记、分开说、分开处置。
 *
 * 现场：真实库里 13 条 stream-broken 有 8 条的原始错误是 This operation was aborted，
 * 成因只是客户端（pi）到点取消——但旧代码一律记成站方断流，于是：
 *   - 供给表现里断流率凭空 13%（截面那条结论就是错的）；
 *   - 故障上报真把一条健康供给剔了 15 分钟；
 *   - 诊断页只写「断流」，用户根本看不出是谁掐的、要不要处理。
 *
 * 这个测试钉死四件事：
 *   1. classifyOutcome 的口径（客户端取消 / 空闲超时 / 真断流 / 正常）
 *   2. explainStreamError 的措辞必须说清「谁、算不算站的账、要不要处理」
 *   3. assessRequestImpact 里客户端断开 = 无感 + 不予处理，绝不 blocked/degraded
 *   4. 供给表现：客户端断开单开一栏，不进 requests/broken，不算首字与吐字速度
 *
 * 跑法：node .test/check-client-abort.mjs
 */
import assert from 'node:assert/strict'
import {
  OUTCOME,
  classifyOutcome,
  explainStreamError,
  assessRequestImpact,
  faultKindOf,
  shouldEscalate,
  IMPACT,
} from '../core/fault-triage.js'
import { applyRoutingToStats, ensureDiagnosisKeys, repairClientAborts } from '../core/offer-stats.js'
import { checkStreamBreaks, checkClientAborts, diagnose } from '../core/diagnosis.js'

let n = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  n += 1
  console.log(`  ✓ ${label}`)
}
const eq = (a, b, label) => {
  assert.deepEqual(a, b, label)
  n += 1
  console.log(`  ✓ ${label}`)
}

// ---------------------------------------------------------------- 1. 口径
{
  eq(classifyOutcome({ streamError: null }), OUTCOME.OK, '没错误 → ok')
  // 客户端信号已 abort + 取消瀑布文本 = 客户端自己走了
  eq(
    classifyOutcome({ streamError: 'This operation was aborted', clientAborted: true }),
    OUTCOME.CLIENT_ABORTED,
    '客户端 abort + aborted 文本 → 客户端断开',
  )
  eq(
    classifyOutcome({ streamError: '客户端已断开', clientAborted: true }),
    OUTCOME.CLIENT_ABORTED,
    '往已关的 res 写 → 客户端断开',
  )
  // 同一个错误文本，但客户端信号没 abort：那是上游自己掐的，算站方
  eq(
    classifyOutcome({ streamError: 'This operation was aborted', clientAborted: false }),
    OUTCOME.STREAM_BROKEN,
    '同文本但客户端没断 → 站方断流',
  )
  // 空闲超时永远是站方的账，哪怕客户端同时也不等了
  eq(
    classifyOutcome({ streamError: '上游流中断（120 秒无数据）', clientAborted: true }),
    OUTCOME.STREAM_BROKEN,
    '空闲超时一律算站方（客户端同时断了也不改判）',
  )
  // fetch 阶段就失败的空闲超时
  eq(
    classifyOutcome({ streamError: '上游 120 秒无响应（首字超时）', clientAborted: true }),
    OUTCOME.STREAM_BROKEN,
    '首字超时算站方',
  )
}

// ---------------------------------------------------------------- 2. 措辞
{
  const c = explainStreamError('This operation was aborted', { clientAborted: true })
  eq(c.who, 'client', '客户端断开 → who=client')
  eq(c.reason, '客户端主动断开请求', '结论用「客户端主动断开请求」')
  eq(c.todo, '不予处理', '处置写「不予处理」')
  ok(/手动中断|超时/.test(c.detail), '解释里给出两种典型成因')
  ok(/不是站点的问题/.test(c.detail), '明确说这不是站的错')

  const s = explainStreamError('This operation was aborted')
  eq(s.who, 'site', '没客户端信号 → who=site')
  eq(s.reason, '站方把连接掐断了', '站方断流的措辞')

  const idle = explainStreamError('上游流中断（120 秒无数据）', { clientAborted: true })
  eq(idle.reason, '站方卡死不出字', '空闲超时单独一种说法，不跟「掐断」混用')
  ok(/降权|停用/.test(idle.todo), '站方的账才给处置建议')
}

// ---------------------------------------------------------------- 3. 影响定级
{
  const impact = assessRequestImpact({ outcome: OUTCOME.CLIENT_ABORTED, deliveredChars: 2386 })
  eq(impact.impact, IMPACT.NONE, '客户端断开 → 无感（哪怕已经吐了 2386 字）')
  eq(impact.reason, '客户端主动断开请求', '理由是人话')
  eq(impact.todo, '不予处理', '结论带处置')

  eq(faultKindOf(impact), 'client-aborted', 'kind 单独一类 client-aborted')
  eq(
    shouldEscalate({ impact }).escalate,
    false,
    '客户端断开永远不上报自动路由（否则会误剔健康供给）',
  )
  // 对照：同样字数的站方断流仍然是降质
  eq(
    assessRequestImpact({ outcome: OUTCOME.STREAM_BROKEN, deliveredChars: 2386 }).impact,
    IMPACT.DEGRADED,
    '站方断流 2386 字仍是降质',
  )
}

// ---------------------------------------------------------------- 4. 供给表现
{
  const stats = {}
  const hour = '2026-10-29T05'
  // 20 次正常 + 3 次客户端断开（现场就是 23 请求里 3 条）
  for (let i = 0; i < 20; i++) {
    applyRoutingToStats(stats, {
      ts: `${hour}:10:00Z`,
      chosenOfferId: 'o_a',
      outcome: OUTCOME.OK,
      latencyMs: 5000,
      ttftMs: 3000,
    })
  }
  for (let i = 0; i < 3; i++) {
    applyRoutingToStats(stats, {
      ts: `${hour}:20:00Z`,
      chosenOfferId: 'o_a',
      outcome: OUTCOME.CLIENT_ABORTED,
      clientAborted: true,
      latencyMs: 20846,
      ttftMs: 9156,
    })
  }
  const b = stats[`o_a|${hour}`]
  // requests 仍含取消（那是「总共来过多少单」），但分母口径是 requests - clientAborts，
  // 所以断流率不会被稀释/虚高；两个数必须一起看
  eq(b.requests, 23, 'requests 记总单数（含客户端断开）')
  eq(b.clientAborts, 3, '单开 clientAborts 一栏')
  eq(b.broken, 0, '客户端断开不进 broken')
  eq(b.requests - b.clientAborts, 20, '分母 = requests - clientAborts（不被污染）')
  eq(b.ttftCount, 20, '客户端断开不算首字（那是没说完的回答）')
  eq(b.latencyCount, 20, '也不算总时长')

  // 现场还原：这条供给按新口径断流率是 0，旧口径是 13%
  const findings = checkStreamBreaks({ offerStats: stats, offerById: new Map([['o_a', '秋 · deepseek-v4.1-flash']]) })
  eq(findings.length, 0, '23 请求 3 次客户端断开 → 不再报「断流率 13%」')

  // 但也不能装作没看见：单独给一条客户端断开结论，且明确「不予处理」
  const aborts = checkClientAborts({ offerStats: stats, offerById: new Map([['o_a', '秋 · deepseek-v4.1-flash']]) })
  eq(aborts.length, 1, '客户端断开确实有 3 次 → 单独一条结论')
  eq(aborts[0].layer, 'client', '归因到客户端层，不是站点')
  eq(aborts[0].severity, 'info', '不是告警级')
  eq(aborts[0].action, '不予处理', '处置写「不予处理」')
  ok(/不是站点故障/.test(aborts[0].detail), 'detail 说清不是站点故障')

  // 真实断流照旧报
  for (let i = 0; i < 3; i++) {
    applyRoutingToStats(stats, {
      ts: `${hour}:30:00Z`,
      chosenOfferId: 'o_a',
      outcome: OUTCOME.STREAM_BROKEN,
      streamError: '上游流中断（120 秒无数据）',
      latencyMs: 120000,
      ttftMs: 3000,
    })
  }
  const b2 = stats[`o_a|${hour}`]
  eq(b2.requests, 26, '真断流也进 requests（总单数）')
  eq(b2.broken, 3, '真断流进 broken')
  eq(b2.clientAborts, 3, '客户端断开仍单列')
  const real = checkStreamBreaks({ offerStats: stats, offerById: new Map([['o_a', '秋']]) })
  eq(real.length, 1, '真断流 3 条 → 报一条')
  ok(real[0].evidence.served === 23, `分母剔掉客户端断开（3/23，实际 ${real[0].evidence.served}）`)
  ok(/只算站方断的|客户端/.test(real[0].detail), '结论里说清客户端断开不算进来')
}

// ---------------------------------------------------------------- 5. 汇总口径
{
  const stats = {}
  const hour = '2026-10-29T05'
  for (let i = 0; i < 30; i++) {
    applyRoutingToStats(stats, { ts: `${hour}:00:00Z`, chosenOfferId: 'o_x', outcome: OUTCOME.OK })
  }
  for (let i = 0; i < 5; i++) {
    applyRoutingToStats(stats, {
      ts: `${hour}:00:00Z`,
      chosenOfferId: 'o_x',
      outcome: OUTCOME.CLIENT_ABORTED,
      clientAborted: true,
    })
  }
  const db = { offerStats: stats, errorbook: {} }
  ensureDiagnosisKeys(db)
  const meta = new Map([['o_x', { label: '某站 · m', providerId: 'p_x', providerName: '某站' }]])
  const { findings } = diagnose({ errorbook: {}, offerStats: stats, offerMeta: meta })
  const stream = findings.filter((f) => f.id.startsWith('stream-'))
  const client = findings.filter((f) => f.id.startsWith('client-abort-'))
  eq(stream.length, 0, '汇总里没有假的断流结论')
  eq(client.length, 1, '汇总里有客户端断开这一条')
}

// ---------------------------------------------------------------- 6. 历史数据修数
{
  // 现场还原：o_a 那个小时 23 请求里 3 条被误记成断流，事件账里留着原始错误文本
  const stats = {
    'o_a|2026-10-28T21': {
      offerId: 'o_a',
      hour: '2026-10-28T21',
      requests: 23,
      ok: 20,
      broken: 3,
      failed: 0,
      ttftSum: 30000,
      ttftCount: 23,
      latencySum: 0,
      latencyCount: 23,
      errors: { outage: 3 },
    },
    // 另一条真断流：没有 aborted 证据，不能动
    'o_b|2026-10-28T21': {
      offerId: 'o_b',
      hour: '2026-10-28T21',
      requests: 10,
      ok: 7,
      broken: 3,
      failed: 0,
      errors: { outage: 3 },
    },
  }
  const db = {
    offerStats: stats,
    faultEvents: [
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `ev_c${i}`,
        at: `2026-10-28T21:37:3${i}.000Z`,
        offerId: 'o_a',
        kind: 'truncated-output',
        status: 'absorbed',
        detail: '降质第 1 次，还没到上报门槛（2） · This operation was aborted',
      })),
      {
        id: 'ev_real',
        at: '2026-10-28T21:40:00.000Z',
        offerId: 'o_b',
        kind: 'stream-broken',
        status: 'sent',
        detail: '用户真的没拿到结果，立即故障转移',
      },
    ],
  }
  const moved = repairClientAborts(db)
  eq(moved, 3, '只挪有 aborted 证据的 3 条')
  const a = stats['o_a|2026-10-28T21']
  eq(a.broken, 0, 'o_a 的 broken 被清回 0')
  eq(a.clientAborts, 3, 'o_a 的 clientAborts = 3')
  eq(a.requests, 20, 'requests 同步减（旧口径里这 3 条进了 requests）')
  eq(a.ok, 20, 'ok 不变')
  eq(stats['o_b|2026-10-28T21'].broken, 3, '没有证据的真断流不动')
  eq(repairClientAborts(db), 0, '重复执行不重复扣（幂等）')
  eq(stats['o_a|2026-10-28T21'].clientAborts, 3, '幂等后计数不变')

  // ensureDiagnosisKeys 会顺路跑一次修数（老库升上来不用手动点）
  const db2 = {
    offerStats: JSON.parse(JSON.stringify(stats)),
    faultEvents: Array.from({ length: 1 }, (_, i) => ({
      id: `ev_old${i}`,
      at: `2026-10-28T21:38:0${i}.000Z`,
      offerId: 'o_a',
      kind: 'truncated-output',
      status: 'absorbed',
      detail: '降质第 1 次，还没到上报门槛（2） · This operation was aborted',
    })),
  }
  db2.offerStats['o_a|2026-10-28T21'] = { ...db2.offerStats['o_a|2026-10-28T21'], broken: 1, requests: 21 }
  ensureDiagnosisKeys(db2)
  eq(db2.offerStats['o_a|2026-10-28T21'].broken, 0, 'ensureDiagnosisKeys 顺路把剩下那条也修了')
  // 事件本身也要改成新口径，否则页面继续显示「回答被截断」看不懂
  eq(db2.faultEvents[0].kind, 'client-aborted', '老事件的 kind 改成 client-aborted')
  eq(db2.faultEvents[0].status, 'ignored', '老事件的状态改成 ignored')
  eq(db2.faultEvents[0].message, '客户端主动断开请求，不予处理', '老事件的说明改成人话')
  ok(/aborted/.test(db2.faultEvents[0].originalText || ''), '原文留在 originalText 里可追溯')

  // 新代码写的 client-aborted 事件：不能再被扣一次桶（它本来就没进 broken）
  const db3 = {
    offerStats: { 'o_c|2026-10-28T21': { offerId: 'o_c', hour: '2026-10-28T21', requests: 5, ok: 5, broken: 1, errors: {} } },
    faultEvents: [
      { id: 'ev_new', at: '2026-10-28T21:10:00.000Z', offerId: 'o_c', kind: 'client-aborted', status: 'ignored', detail: '客户端主动断开请求' },
    ],
  }
  repairClientAborts(db3)
  eq(db3.offerStats['o_c|2026-10-28T21'].broken, 1, '新口径事件不再扣桶（那是别的请求的断流）')
}

console.log(`check-client-abort: ${n} 项全部通过`)
