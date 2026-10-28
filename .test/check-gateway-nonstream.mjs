/**
 * 非流式记账自检（端到端，自带 mock 上游 + 临时数据目录）。
 *
 * 回归的是 27bcc00 引入的记账错位：`forwardToUpstream` 写完非流式响应后
 * 忘了标 committed，外层把「已经交付给客户端的成功」当成失败，继续推进
 * 整条候选链——客户端拿到 200 + 正文，路由日志却记整单失败、供给被记假失败，
 * 后面每条候选还白打一次上游（写头时抛 Cannot write headers）。
 *
 * 断言口径：
 *   1. 非流式请求：HTTP 200 + 正文正确 + X-ManageAPI-Attempts=1
 *   2. 路由日志：outcome=ok、chosenOfferId 落上、attempts=1（不重打候选链）
 *   3. 错误账本里没有「Cannot write headers」这种网关自己的假错误
 *   4. 流量计数记的是成功（不是假失败）
 *   5. 上报通道默认地址跟着本实例端口走，不写死 4319
 *   6. 同时给 offerId + modelKey 的上报只落成供给级（不连坐同型号别家）
 *
 * 用法：node .test/check-gateway-nonstream.mjs
 */
import { createServer } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm, readFile as readFileAsync } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
const ok = (cond, msg, extra) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}${extra ? `  ← ${extra}` : ''}`)
  }
}

/** 拿一个当前空闲的端口（Windows 的保留端口段偶尔会挡随机端口，绑 0 最稳） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function killTree(pid) {
  if (!pid) return
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

async function waitFor(fn, { timeoutMs = 15000, stepMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(stepMs)
  }
  throw new Error(`等待超时${last ? `：${last.message}` : ''}`)
}

async function api(base, method, path, body, headers = null) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error || res.status}`)
  return data
}

const home = await mkdtemp(join(tmpdir(), 'mapi-nonstream-'))
const mockPort = await freePort()
const daemonPort = await freePort()
let mock = null
let daemon = null
let daemonOut = ''

try {
  mock = spawn(process.execPath, [join(ROOT, '.test/mock-upstream.mjs')], {
    cwd: ROOT,
    env: { ...process.env, MODE: 'good', PORT: String(mockPort) },
    stdio: 'ignore',
  })

  daemon = spawn(process.execPath, [join(ROOT, 'daemon/index.js'), '--port', String(daemonPort)], {
    cwd: ROOT,
    env: {
      ...process.env,
      MANAGE_API_HOME: home,
      MANAGE_API_BACKUP_DIR: join(home, 'backups'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  daemon.stdout.setEncoding('utf8')
  daemon.stderr.setEncoding('utf8')
  daemon.stdout.on('data', (chunk) => (daemonOut += chunk))
  daemon.stderr.on('data', (chunk) => (daemonOut += chunk))

  // 端口被占会顺延，从启动日志里读回真实端口
  const base = await waitFor(async () => {
    const hit = daemonOut.match(/http:\/\/127\.0\.0\.1:(\d+)\//)
    if (hit) {
      const url = `http://127.0.0.1:${hit[1]}`
      await api(url, 'GET', '/api/health')
      return url
    }
    return null
  })

  console.log(`\n实例 ${base}（mock ${mockPort}）`)
  await api(base, 'PATCH', '/api/settings', { probeIntervalMinutes: 0, monitorIntervalMinutes: 0 })

  // ---- 建站 + 一条供给
  let state = await api(base, 'GET', '/api/state')
  await api(base, 'POST', '/api/providers', { name: '正常站', baseUrl: `http://127.0.0.1:${mockPort}/v1` })
  state = await api(base, 'GET', '/api/state')
  const provider = state.providers.find((p) => p.name === '正常站')
  await api(base, 'POST', '/api/credentials', { providerId: provider.id, label: '主Key', secret: 'sk-test' })
  await api(base, 'POST', `/api/providers/${provider.id}/sync`, {})
  state = await api(base, 'GET', '/api/state')
  const offer = state.offers.find((o) => o.modelKey === 'test-model-a')
  await api(base, 'PATCH', `/api/offers/${offer.id}`, {
    inPrice: 1,
    outPrice: 4,
    currency: 'CNY',
    ratio: null,
    pricingMode: 'manual',
  })
  const key = state.gateway.keys[0].key

  console.log('\n[1] 非流式请求：客户端拿到 200 + 正文，路由日志记成功')
  const startedAt = Date.now()
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'test-model-a',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }),
  })
  const bodyText = await res.text()
  let body = null
  try {
    body = JSON.parse(bodyText)
  } catch {
    /* 下面会断言 */
  }
  ok(res.status === 200, `HTTP ${res.status}`)
  ok(res.headers.get('x-manageapi-attempts') === '1', `X-ManageAPI-Attempts=${res.headers.get('x-manageapi-attempts')}（不重打候选链）`)
  ok(body?.choices?.[0]?.message?.content === 'ok', `正文 ${JSON.stringify(body?.choices?.[0]?.message?.content)}`)

  await sleep(5600) // 决策日志攒批 2000ms、流量计数 5000ms
  const after = await api(base, 'GET', '/api/state')
  const row = (after.routing || []).find((r) => Date.parse(r.ts) >= startedAt - 1000)
  ok(row && row.outcome === 'ok', `路由 outcome=${row?.outcome}`)
  ok(row?.chosenOfferId === offer.id, `chosenOfferId=${row?.chosenOfferId}`)
  ok(row?.attempts === 1, `attempts=${row?.attempts}`)
  ok(row?.ts && Date.parse(row.ts) - startedAt < 5000, `时间戳是请求完成时刻（${row?.ts}）`)

  console.log('\n[2] 错误账本 / 流量计数：不能出现网关自己的假错误')
  const ledger = await api(base, 'GET', '/api/diagnosis/ledger')
  const fpText = JSON.stringify(ledger)
  ok(!/Cannot write headers/.test(fpText), '错误账本里没有 Cannot write headers')
  // traffic 不在 /api/state 里，直接读临时数据目录的 db.json（这份库只属于这个测试）
  const rawDb = JSON.parse(await readFileAsync(join(home, 'db.json'), 'utf8'))
  const cell = rawDb.traffic?.[offer.id]
  ok((cell?.fail || 0) === 0, `流量 fail=${cell?.fail ?? 0}`)
  ok((cell?.ok || 0) >= 1, `流量 ok=${cell?.ok ?? 0}`)

  console.log('\n[3] 流式请求仍然正常（防止修非流式改坏流式）')
  const streamRes = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'test-model-a',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }),
  })
  const sse = await streamRes.text()
  ok(streamRes.status === 200 && /"content":"ok"/.test(sse), `流式正文 ${sse.includes('ok') ? 'ok' : '缺失'}`)
  await sleep(2600)
  const rows2 = (await api(base, 'GET', '/api/state')).routing || []
  ok(rows2.filter((r) => r.outcome === 'ok').length >= 2, `成功路由累计 ${rows2.filter((r) => r.outcome === 'ok').length} 条`)

  console.log('\n[4] 故障上报默认地址：跟着本实例端口，不写死 4319')
  const faults = await api(base, 'GET', '/api/faults')
  const wantUrl = `${base}/api/failover/report`
  ok(faults.config?.url === wantUrl, `config.url=${faults.config?.url}（期望 ${wantUrl}）`)
  ok(!/4319/.test(faults.config?.url || ''), '不含 4319')

  console.log('\n[5] offerId + modelKey 同时上报：只落供给级')
  const { token } = await api(base, 'GET', '/api/failover/reports')
  const report = await api(
    base,
    'POST',
    '/api/failover/report',
    {
      offerId: offer.id,
      modelKey: 'test-model-a',
      kind: 'runtime',
      message: '自检用例（可忽略）',
      holdMinutes: 1,
    },
    { Authorization: `Bearer ${token}` },
  )
  ok(report.report?.offerId === offer.id, `offerId=${report.report?.offerId}`)
  ok(report.report?.modelKey === null, `modelKey=${report.report?.modelKey}（应为 null）`)
  const reports = await api(base, 'GET', '/api/failover/reports')
  const active = (reports.active || []).find((r) => r.id === report.report?.id)
  ok(active && active.modelKey === null, '生效清单里也是供给级')} catch (error) {
  failed += 1
  console.error(`\n✗ ${error.message}`)
  if (daemonOut) console.error(daemonOut.slice(-1500))
} finally {
  killTree(daemon?.pid)
  killTree(mock?.pid)
  await sleep(200)
  await rm(home, { recursive: true, force: true }).catch(() => {})
}

process.exitCode = failed ? 1 : 0
console.log(failed ? `\n${failed} 项失败` : '\n全通过')
