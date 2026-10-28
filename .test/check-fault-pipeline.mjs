/**
 * 故障截流/研判/上报链路测试。
 *
 * 三段：
 *   1. 影响定级（core/fault-triage.js assessRequestImpact）——什么算无感/降质/阻塞
 *   2. 升级判定（shouldEscalate）——什么时候才值得惊动自动路由
 *   3. 上报客户端（core/fault-reporter.js）——冷却、开关、无令牌、真发请求（mock HTTP）
 *
 * 跑法：node .test/check-fault-pipeline.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  assessRequestImpact,
  shouldEscalate,
  faultKindOf,
  holdMinutesFor,
  IMPACT,
} from '../core/fault-triage.js'
import {
  normalizeFaultReport,
  defaultFaultReport,
  recentlyReported,
  postFaultReport,
  recordFaultEvent,
} from '../core/fault-reporter.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

let n = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  n += 1
}
const eq = (a, b, label) => {
  assert.deepEqual(a, b, label)
  n += 1
}

// ---------------------------------------------------------------- 影响定级
{
  // 一把成功：无感
  eq(assessRequestImpact({ outcome: 'ok', attempts: 1 }).impact, IMPACT.NONE, '单次成功 → 无感')
  // 换站后成功：无感但 absorbed=true（截流成功了，值得记一笔）
  const absorbed = assessRequestImpact({ outcome: 'ok', attempts: 3 })
  eq(absorbed.impact, IMPACT.NONE, '换站后成功 → 仍是无感（用户拿到了）')
  eq(absorbed.absorbed, true, '但 absorbed=true（截流发生了）')

  // 断流分两档：几乎没输出 = blocked；说了一半 = degraded
  eq(assessRequestImpact({ outcome: 'stream-broken', deliveredChars: 3 }).impact, IMPACT.BLOCKED, '断流且 3 字 → 阻塞')
  eq(assessRequestImpact({ outcome: 'stream-broken', deliveredChars: 500 }).impact, IMPACT.DEGRADED, '断流且 500 字 → 降质（拿到半截）')

  // 全部候选失败 → blocked
  eq(assessRequestImpact({ outcome: 'failed', attempts: 6 }).impact, IMPACT.BLOCKED, '全部失败 → 阻塞')

  // 成功但降质
  eq(assessRequestImpact({ outcome: 'ok', degradation: { fingerprintBad: true } }).impact, IMPACT.DEGRADED, '指纹不符 → 降质')
  eq(assessRequestImpact({ outcome: 'ok', degradation: { thinkStolen: true } }).impact, IMPACT.DEGRADED, '思考被偷 → 降质')
  eq(assessRequestImpact({ outcome: 'ok', degradation: { ttftRatio: 3 } }).impact, IMPACT.DEGRADED, '首字慢 3 倍 → 降质')
  eq(assessRequestImpact({ outcome: 'ok', degradation: { ttftRatio: 1.2 } }).impact, IMPACT.NONE, '首字慢 1.2 倍 → 还算正常')

  // 无感类绝不携带上报理由
  const none = assessRequestImpact({ outcome: 'ok', attempts: 1 })
  eq(none.reason, null, '无感时不造理由')
}

// ---------------------------------------------------------------- 升级判定
{
  const now = Date.now()
  const blocked = assessRequestImpact({ outcome: 'failed', attempts: 3 })
  // blocked 立即升级
  ok(shouldEscalate({ impact: blocked }).escalate, 'blocked → 立即上报')

  // degraded 单次不报、两次报
  const degraded = assessRequestImpact({ outcome: 'ok', degradation: { thinkStolen: true } })
  eq(shouldEscalate({ impact: degraded, history: [] }).escalate, false, '降质第 1 次 → 不报')
  ok(
    shouldEscalate({ impact: degraded, history: [{ at: new Date(now - 60000).toISOString(), impact: IMPACT.DEGRADED }] })
      .escalate,
    '降质第 2 次 → 报',
  )

  // 冷却期内已报过 → 不再报（自动路由一条就剔十分钟）
  eq(
    shouldEscalate({ impact: blocked, alreadyReported: true }).escalate,
    false,
    '冷却期内已报 → 不重复',
  )

  // 无感 → 永远不报
  eq(shouldEscalate({ impact: assessRequestImpact({ outcome: 'ok' }) }).escalate, false, '无感 → 不报')
}

// ---------------------------------------------------------------- kind / 保持期
{
  eq(faultKindOf(assessRequestImpact({ outcome: 'stream-broken', deliveredChars: 3 })), 'stream-broken', '阻塞断流 → stream-broken')
  eq(faultKindOf(assessRequestImpact({ outcome: 'failed', attempts: 3 })), 'all-candidates-failed', '全部失败 → all-candidates-failed')
  eq(faultKindOf(assessRequestImpact({ outcome: 'ok', degradation: { thinkStolen: true } })), 'thinking-stolen', '偷思考 → thinking-stolen')
  eq(faultKindOf(assessRequestImpact({ outcome: 'ok', degradation: { truncated: true } })), 'truncated-output', '截断 → truncated-output')
  eq(faultKindOf(assessRequestImpact({ outcome: 'ok', degradation: { ttftRatio: 3 } })), 'slow', '变慢 → slow')

  // 保持期：blocked 久一点，degraded 短一点
  ok(holdMinutesFor(assessRequestImpact({ outcome: 'failed' })) > holdMinutesFor(assessRequestImpact({ outcome: 'ok', degradation: { ttftRatio: 3 } })), '阻塞的保持期长于降质')
}

// ---------------------------------------------------------------- 上报客户端（mock 自动路由）
{
  // 起一个 mock 接收端
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received.push({ auth: req.headers.authorization, body: JSON.parse(body || '{}') })
      if (req.headers.authorization === 'Bearer good-token') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } else {
        res.writeHead(401)
        res.end(JSON.stringify({ error: '令牌无效' }))
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/api/failover/report`

  // 用临时数据目录，不碰真实库
  const home = await mkdtemp(join(tmpdir(), 'mapi-fault-'))
  const daemon = spawn(process.execPath, ['daemon/index.js', '--port', '4594'], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, MANAGE_API_HOME: home },
    stdio: 'ignore',
  })
  await new Promise((r) => setTimeout(r, 3000))
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch('http://127.0.0.1:4594/api/health')).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }

  // 预置一条在役供给（连通性测试需要真实目标；写完等 mtime 缓存失效）
  {
    const dbPath = join(home, 'db.json')
    const db = JSON.parse(await (await import('node:fs/promises')).readFile(dbPath, 'utf8'))
    db.providers = [{ id: 'p_1', name: '测试站', baseUrl: 'http://127.0.0.1:9/v1', kind: 'sub2api', quotaRemaining: 5, currency: 'USD' }]
    db.credentials = [{ id: 'c_1', providerId: 'p_1', label: '默认', group: 'g', tail: 'xxxx' }]
    db.offers = [{ id: 'o_1', providerId: 'p_1', credentialId: 'c_1', upstreamName: 'test-model', modelKey: 'test-model', group: 'g', priceUnit: 'per_mtok', inPrice: 1, outPrice: 2, currency: 'CNY', ratio: 1 }]
    await (await import('node:fs/promises')).writeFile(dbPath, JSON.stringify(db))
    await new Promise((r) => setTimeout(r, 500))
  }

  // 配置：指向 mock，令牌正确
  await fetch('http://127.0.0.1:4594/api/faults/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, token: 'good-token', useOwnToken: false }),
  })

  // 发一条：mock 应收到，且带 Bearer
  const r1 = await (await fetch('http://127.0.0.1:4594/api/faults/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
  ok(r1.ok === true, `测试上报通（${r1.hint}）`)
  ok(received.length === 1 && received[0].auth === 'Bearer good-token', 'mock 收到了带令牌的上报')

  // 错误令牌：报失败但不抛错
  await fetch('http://127.0.0.1:4594/api/faults/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'bad-token' }),
  })
  const r2 = await (await fetch('http://127.0.0.1:4594/api/faults/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
  eq(r2.ok, false, '错令牌 → 上报失败但不炸')
  ok((r2.error || '').includes('401') || (r2.error || '').includes('令牌'), '失败原因留痕')

  // 开关关掉 → skipped
  await fetch('http://127.0.0.1:4594/api/faults/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'good-token', enabled: false }),
  })
  const r3 = await (await fetch('http://127.0.0.1:4594/api/faults/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
  eq(r3.ok, false, '开关关闭 → skipped')
  ok((r3.hint || '').includes('没发出去'), 'skipped 有解释')

  // 事件账里能看到全部三条的痕迹（诊断页的数据源）
  const faults = await (await fetch('http://127.0.0.1:4594/api/faults')).json()
  ok(faults.events.length >= 3, `事件账有记录（${faults.events.length} 条）`)
  ok(faults.stats.sent >= 1, `stats.sent 有数（${faults.stats.sent}）`)
  ok(faults.stats.failed >= 1, `stats.failed 有数（${faults.stats.failed}）`)
  ok(faults.stats.skipped >= 1, `stats.skipped 有数（${faults.stats.skipped}）`)
  ok(faults.tokenReady === true, 'tokenReady（配置了显式令牌）')

  server.close()
  daemon.kill()
  await rm(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 纯函数：冷却判定
{
  const now = Date.now()
  const events = [
    { offerId: 'o_1', kind: 'slow', status: 'sent', at: new Date(now - 5 * 60000).toISOString() },
    { offerId: 'o_1', kind: 'slow', status: 'sent', at: new Date(now - 20 * 60000).toISOString() },
    { offerId: 'o_2', kind: 'slow', status: 'sent', at: new Date(now - 60000).toISOString() },
  ]
  ok(recentlyReported(events, { offerId: 'o_1', kind: 'slow' }), '5 分钟前报过 → 冷却中')
  eq(recentlyReported(events, { offerId: 'o_1', kind: 'all-candidates-failed' }), false, '不同 kind 不算冷却')
  // o_1 的那条已过冷却（20 分钟前）
  const events2 = [{ offerId: 'o_1', kind: 'slow', status: 'sent', at: new Date(now - 20 * 60000).toISOString() }]
  eq(recentlyReported(events2, { offerId: 'o_1', kind: 'slow' }, now), false, '超冷却期 → 可再报')
}

// ---------------------------------------------------------------- 配置归一化
{
  eq(normalizeFaultReport(undefined), defaultFaultReport(), '未配置 → 缺省')
  const cfg = normalizeFaultReport({ url: 'http://x/y', token: 't', enabled: false })
  eq(cfg.enabled, false, '开关可关')
  eq(cfg.url, 'http://x/y', 'URL 可配')
  // 垃圾输入不炸
  normalizeFaultReport('garbage')
  normalizeFaultReport(42)
  ok(true, '垃圾输入不炸')
}

console.log(`check-fault-pipeline: ${n} 项全部通过`)
