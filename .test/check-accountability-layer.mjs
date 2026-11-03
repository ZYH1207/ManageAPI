/**
 * 责任层回归：一次失败到底该算谁的账。
 *
 * ## 为什么要有这个测试（真实事故）
 *
 * 2026-11-02 的 routeTarget 未定义（见 .test/check-route-target-forward.mjs 头注）
 * 让 507 次请求在网关内部就炸了，一个字节都没发到站点。但当时只有
 * core/score.js 的探针侧认「本地缺陷」，其余三条链路全部照站点故障记账：
 *
 *   ① core/offer-stats.js —— `b.failed += 1` 无条件，我方 bug 记成站点失败
 *   ② core/diagnosis.js   —— 失败率分子含我方缺陷，结论说「站方失败率上升」
 *   ③ daemon/server.js    —— handleFaultSignals 一律 BLOCKED → 上报自动路由，
 *                            把一条健康供给剔除 10 分钟；502 文案还说
 *                            「故障在中转站侧，改客户端 Key 没用」
 *
 * 结果：坏的是我们的代码，挨罚的是站，用户被指引去充值/换站。
 * 这个测试把「责任层」在四处落点全部钉死，纯函数 + 端到端各一半。
 *
 * ## 怎么不依赖线上
 *
 * 自己起假上游、自己起 daemon，全部落在 mktemp 目录里。
 * 端到端部分故意**先同步再关掉**上游：关掉后 baseUrl 指向本机 port，
 * `连接失败（ECONNREFUSED）：http://127.0.0.1:<port>/...` 正好命中
 * core/failure.js 的「连接错误 + loopback」判据 —— 这就是事故的同一形状。
 *
 * 用法：node .test/check-accountability-layer.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isLocalOnlyFailure, assessRequestImpact, faultKindOf, shouldEscalate, IMPACT } from '../core/fault-triage.js'
import { applyRoutingToStats } from '../core/offer-stats.js'
import { checkLocalDefects, checkConcurrency, LAYERS } from '../core/diagnosis.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let n = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  n += 1
}
const eq = (a, b, label) => {
  assert.equal(a, b, `${label}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`)
  n += 1
}

const LOCAL = '连接失败（ECONNREFUSED）：http://127.0.0.1:9/v1/chat/completions'
const SITE = 'HTTP 500 {"error":{"message":"upstream blew up"}}'

// ---------------------------------------------------------------- ① 纯函数：责任层判定
ok(isLocalOnlyFailure([{ error: LOCAL }]) === true, '全是我方缺陷 → true')
ok(isLocalOnlyFailure([{ error: SITE }]) === false, '站点 5xx → false')
ok(
  isLocalOnlyFailure([{ error: LOCAL }, { error: SITE }]) === false,
  '混着站点错误 → false（宁可冤枉一条供给，也不掩盖真站点故障）',
)
ok(isLocalOnlyFailure([]) === false, '空清单 → false（没有证据不算我方）')
// 远端站连不上是站点的账：ENOTFOUND 没有 loopback，不能被我方吞掉
ok(
  isLocalOnlyFailure([{ error: '连接失败（ENOTFOUND）：https://nowhere.example/v1/chat/completions' }]) === false,
  '远端站连不上 → 站点的账',
)

// ---------------------------------------------------------------- ② 影响定级
const localImpact = assessRequestImpact({ outcome: 'failed', attempts: 3, failures: [{ error: LOCAL }] })
eq(localImpact.impact, IMPACT.NONE, '我方缺陷 → 无感（不是 blocked）')
ok(localImpact.local === true, '标记 local:true，调用方据此不报故障转移')
eq(localImpact.mixed, false, '全是我方 → mixed:false')
ok(/网关/.test(localImpact.todo), `处置指向网关自身（实际「${localImpact.todo}」）`)

const siteImpact = assessRequestImpact({ outcome: 'failed', attempts: 3, failures: [{ error: SITE }] })
eq(siteImpact.impact, IMPACT.BLOCKED, '站点全灭 → blocked（和以前一致）')
ok(!siteImpact.local, '站点故障不带 local 标记')
eq(siteImpact.reason, '全部候选失败', '站点故障保留原措辞')

// 显式指定优先于兜底扫描：调用方已经判过就不用再猜
ok(
  assessRequestImpact({ outcome: 'failed', localDefect: true, failures: [{ error: SITE }] }).local === true,
  'localDefect:true 显式生效',
)
ok(
  assessRequestImpact({ outcome: 'failed', localDefect: false, failures: [{ error: LOCAL }] }).local !== true,
  'localDefect:false 显式否决兜底判定（调用方说是站点，就按站点）',
)

eq(faultKindOf(localImpact), 'local-defect', '我方缺陷的 kind 自成一类')
ok(faultKindOf(localImpact) !== 'all-candidates-failed', '绝不落进「全部失败」（那会剔除站点）')
eq(shouldEscalate({ impact: localImpact }).escalate, false, '我方缺陷不报故障转移')

// ---------------------------------------------------------------- ③ 供给表现：local 不进 failed
// 真实形状：整单失败时 chosenOfferId 为 null，账只从 failures[] 来
const stats = {}
applyRoutingToStats(stats, {
  ts: '2026-11-04T01:30:00Z',
  outcome: 'failed',
  attempts: 1,
  failures: [{ providerName: '甲站', offerId: 'o1', error: LOCAL }],
})
const b1 = Object.values(stats)[0]
eq(b1.failed, 0, '我方缺陷不记 failed（不进可用率）')
eq(b1.ok, 0, '我方缺陷也不算成功')
eq(b1.localDefects, 1, '我方缺陷记 localDefects')
eq(b1.errors.local, 1, '错误归类里单列 local')

// 混合单：一条我方 + 一条站点，站点的账不能被我方的账冲掉
const stats2 = {}
applyRoutingToStats(stats2, {
  ts: '2026-11-04T01:30:00Z',
  outcome: 'failed',
  attempts: 2,
  failures: [
    { providerName: '甲站', offerId: 'o1', error: LOCAL },
    { providerName: '甲站', offerId: 'o1', error: SITE },
  ],
})
const b2 = Object.values(stats2)[0]
eq(b2.failed, 1, '混合单里站点那次仍记 failed')
eq(b2.localDefects, 1, '混合单里我方那次记 localDefects')
ok(b2.errors.local === 1 && b2.errors['outage/500'] === 1, '两类的错误归类都在（local + outage/500）')

// ---------------------------------------------------------------- ④ 诊断：不再诬告站点
// checkLocalDefects 的门槛是「同一供给累计 2 次」——单次偶发不惊动用户，
// 所以这里再摊一条，凑到 2。
applyRoutingToStats(stats, {
  ts: '2026-11-04T01:35:00Z',
  outcome: 'failed',
  attempts: 1,
  failures: [{ providerName: '甲站', offerId: 'o1', error: LOCAL }],
})
const localFinding = checkLocalDefects({ offerStats: stats })
eq(localFinding.length, 1, '我方缺陷单独出一条结论')
eq(localFinding[0].layer, 'gateway', '责任层是「网关自身」，不是站点')
ok(LAYERS[localFinding[0].layer] !== undefined, 'layer 在 LAYERS 里（页面能翻译）')
eq(localFinding[0].id, 'local-o1', 'id 按供给定位')
ok(/网关自己的问题/.test(localFinding[0].title), `标题说清是网关的问题（实际「${localFinding[0].title}」）`)
ok(!/站点/.test(localFinding[0].title), '标题不把责任推给站点')

// 只有 1 次时不说话：偶发不惊动用户
ok(checkLocalDefects({ offerStats: { a: { offerId: 'a', localDefects: 1 } } }).length === 0, '单次我方缺陷不报')

// 关键回归：供给全是断流 0、失败 0、只有我方缺陷 —— 规则②不许说「失败率上升」
const onlyLocal = {}
const nowHour = new Date()
for (let i = 0; i < 6; i += 1) {
  const d = new Date(nowHour.getTime() - i * 3600_000)
  const hour = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`
  onlyLocal[`o1|${hour}`] = { offerId: 'o1', hour, requests: 20, ok: 0, broken: 0, failed: 0, clientAborts: 0, localDefects: 20 }
}
eq(checkConcurrency({ offerStats: onlyLocal }).length, 0, '只有我方缺陷时，规则②不许报「失败率上升」')

// ---------------------------------------------------------------- ⑤ 端到端：502 文案 + 落盘
const freePort = async () => {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const HOME = await mkdtemp(join(tmpdir(), 'mapi-accountability-'))
process.env.MANAGE_API_HOME = HOME
const APP_PORT = await freePort()
const UP_PORT = await freePort()

let upstreamMode = 'ok'
const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname.endsWith('/models')) return send(200, { data: [{ id: 'gpt-x' }] })
  if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
    req.on('data', () => {})
    req.on('end', () => {
      if (upstreamMode === 'site-500') return send(500, { error: { message: 'upstream blew up' } })
      send(200, {
        id: 'chatcmpl-acc',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'served' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      })
    })
    return
  }
  return send(404, { error: 'not found' })
})
await new Promise((resolve) => upstream.listen(UP_PORT, '127.0.0.1', resolve))

const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  cwd: ROOT,
  env: {
    ...process.env,
    MANAGE_API_HOME: HOME,
    MANAGE_API_PROBE_FIRST_DELAY_MS: '600000',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let stderrText = ''
app.stderr.on('data', (chunk) => {
  stderrText += chunk.toString()
})

const base = `http://127.0.0.1:${APP_PORT}`
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`)
  return data
}

try {
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }
  await call('PATCH', '/api/settings', { probeIntervalMinutes: 0 })

  const created = await call('POST', '/api/providers', { name: '甲站', baseUrl: `http://127.0.0.1:${UP_PORT}/v1` })
  const provider = created.providers.find((p) => p.name === '甲站')
  await call('POST', '/api/credentials', { providerId: provider.id, label: '默认', secret: 'sk-acc-1234' })
  await call('POST', `/api/providers/${provider.id}/sync`)
  const state = await call('GET', '/api/state')
  const key = state.gateway.keys.find((k) => k.enabled)?.key
  ok(Boolean(key), '网关 Key 就绪')
  const offerId = state.offers.find((o) => o.providerId === provider.id)?.id
  ok(Boolean(offerId), '供给已同步')

  const post = (body) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    })
  const req = { model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }

  // ---- 5a 站点 500：仍是「上游全部失败」，照记 failed
  upstreamMode = 'site-500'
  const siteRes = await post(req)
  const siteText = await siteRes.text()
  eq(siteRes.status, 502, '站点全灭仍是 502')
  ok(siteText.includes('上游全部失败'), `站点故障的文案不变（实际 ${siteText.slice(0, 80)}）`)
  ok(!siteText.includes('网关自身'), '站点故障不许说自己')
  // 流量计数 5 秒攒批落盘（daemon/server.js#bufferTraffic）：不等就什么都读不到
  await sleep(5600)

  // 落盘要直接读 db.json：/api/diagnosis/ledger 只回 errorbook + offerStats，
  // 不回 db.traffic（那是评分的输入，不在调试接口里暴露）
  const readDb = async () => JSON.parse(await readFile(join(HOME, 'db.json'), 'utf8'))

  let db = await readDb()
  const siteRow = db.traffic?.[offerId]
  ok(Number(siteRow?.fail) >= 1, `站点失败记进 fail（${siteRow?.fail}）`)
  eq(Number(siteRow?.localDefects) || 0, 0, '站点失败不记 localDefects')

  // ---- 5b 关掉上游 → 连本机 port 失败 = 我方缺陷
  await new Promise((resolve) => upstream.close(resolve))
  stderrText = ''
  const localRes = await post(req)
  const localText = await localRes.text()
  eq(localRes.status, 502, '本地缺陷仍是 502（用户确实没拿到东西）')
  ok(localText.includes('网关自身'), `文案指向网关自身（实际 ${localText.slice(0, 90)}）`)
  ok(localText.includes('不是站点的问题'), '明确排除站点责任')
  ok(!localText.includes('中转站侧'), '不再说「故障在中转站侧」')
  await sleep(5600)

  // 落盘：fail 不涨（站点不被冤枉），localDefects 涨
  db = await readDb()
  const row2 = db.traffic?.[offerId]
  eq(Number(row2?.fail), Number(siteRow?.fail), '连本机失败不涨 fail（站点不被冤枉）')
  ok(Number(row2?.localDefects) >= 1, `记进 localDefects（${row2?.localDefects}）`)

  // 供给表现桶：local 也不进 failed
  const buckets = Object.values(db.offerStats || {}).filter((b) => b.offerId === offerId)
  ok(buckets.length > 0, '供给表现桶存在')
  ok(
    buckets.some((b) => Number(b.localDefects) >= 1),
    '供给表现桶里有 localDefects',
  )
  // local 的账必须和 localDefects 对得上，且 failed 只统计站点那条
  const localErrTotal = buckets.reduce((a, b) => a + (Number(b.errors?.local) || 0), 0)
  const localDefectTotal = buckets.reduce((a, b) => a + (Number(b.localDefects) || 0), 0)
  const failedTotal = buckets.reduce((a, b) => a + (Number(b.failed) || 0), 0)
  eq(localErrTotal, localDefectTotal, `local 错误计数与 localDefects 一致（${localErrTotal} vs ${localDefectTotal}）`)
  eq(failedTotal, 1, `整单失败里站点那次仍记 failed（${failedTotal}）`)

  // 故障事件账：status='local'、kind='local-defect'，不是 'absorbed'
  const faults = await call('GET', '/api/faults')
  const localEvents = (faults.events || []).filter((e) => e.status === 'local')
  ok(localEvents.length >= 1, `事件账记了 status='local'（${localEvents.length} 条）`)
  eq(localEvents[0].kind, 'local-defect', 'kind 是 local-defect')
  ok(/网关|本机网络/.test(localEvents[0].message || ''), `措辞是人话（实际「${localEvents[0].message}」）`)
  eq(Number(faults.stats?.local) >= 1, true, '/api/faults 的 stats.local 有计数')
  eq(Number(faults.stats?.absorbed) || 0, 0, '我方缺陷不算「已截流」')
  // 前面那次站点 500 正常上报了（sent>=1），这里只断言「我方缺陷没被报出去」
  ok(
    !(faults.events || []).some((e) => e.kind === 'local-defect' && e.status === 'sent'),
    '我方缺陷绝不上报自动路由（站点 500 那次 sent 是正常的）',
  )
  ok(
    !(faults.events || []).some((e) => e.kind === 'all-candidates-failed' && /网关/.test(e.message || '')),
    '没有把本地缺陷记成 all-candidates-failed',
  )

  // 诊断页：我方缺陷单独成一条，责任层是网关
  // checkLocalDefects 的门槛是同一供给累计 2 次（单次偶发不惊动用户），
  // 上面只发了一单，这里再补一单凑到 2。
  await post(req).then((r) => r.text())
  await sleep(5600)
  const diag = await call('GET', '/api/diagnosis')
  const localFindings = (diag.findings || []).filter((f) => String(f.id).startsWith('local-'))
  ok(localFindings.length >= 1, `诊断结论里有我方缺陷条目（${localFindings.length}）`)
  eq(localFindings[0].layer, 'gateway', '结论责任层是网关自身')

  ok(!/routeTarget is not defined/.test(stderrText), '日志里没有 routeTarget 未定义（这次是我们故意关的上游）')

  console.log(`check-accountability-layer: ${n} 项全部通过`)
} finally {
  app.kill()
  upstream.close()
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}