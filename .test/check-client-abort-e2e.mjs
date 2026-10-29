/**
 * 客户端中途取消请求的端到端行为（真断开，不信纯函数）。
 *
 * 现场：pi 到点取消 / 用户按 Esc，网关收到 res 的 close 就把上游也掐了。
 * 旧代码把这件事记成站方断流，于是断流率虚高、还真的上报了自动路由。
 *
 * 钉死五件事：
 *   1. 决策日志 outcome = client-aborted（不是 stream-broken）
 *   2. 供给表现：clientAborted=1，requests/broken 都是 0（不污染断流率分母）
 *   3. 供给表现里也没有首字/吐字样本（没说完的回答不能拿来算速度）
 *   4. 流量可用率不吃这一单（ok/fail 都不加）
 *   5. 故障事件账记一条 status=ignored、措辞是「客户端主动断开请求，不予处理」，
 *      并且同一供给连续断开只聚合一条（hits 递增），不刷屏
 *
 * 跑法：node .test/check-client-abort-e2e.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import http from 'node:http'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let n = 0
const ok = (cond, label) => {
  if (!cond) throw new Error(`✗ ${label}`)
  n += 1
  console.log(`  ✓ ${label}`)
}

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- mock 上游：慢慢吐 200 个 chunk（约 4 秒），给客户端留出「中途走人」的窗口
const UP_PORT = await freePort()
let upstreamClosed = 0
const upstream = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null,"index":0}]}\n\n')
    let i = 0
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer)
        upstreamClosed += 1
        return
      }
      res.write(
        `data: {"choices":[{"delta":{"content":"第${i}段"},"finish_reason":null,"index":0}]}\n\n`,
      )
      i += 1
      if (i >= 200) {
        clearInterval(timer)
        res.write(
          'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
        )
        res.write('data: [DONE]\n\n')
        res.end()
      }
    }, 20)
  })
})
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))

const home = await mkdtemp(join(tmpdir(), 'mapi-clientabort-'))
const APP_PORT = await freePort()
const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  cwd: ROOT,
  env: { ...process.env, MANAGE_API_HOME: home },
  stdio: 'ignore',
})
await sleep(3000)
for (let i = 0; i < 40; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)).ok) break
  } catch {}
  await sleep(250)
}

const apiPost = (path, body) =>
  fetch(`http://127.0.0.1:${APP_PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json())

// ---- 预置一个站 + 一条供给 + 一把网关 Key
{
  const st = await apiPost('/api/providers', { name: '慢站', baseUrl: `http://127.0.0.1:${UP_PORT}/v1` })
  const p = st.providers.find((x) => x.name === '慢站')
  await apiPost('/api/credentials', { providerId: p.id, label: 'k', secret: 'test-key', group: 'g' })
  const dbPath = join(home, 'db.json')
  const db = JSON.parse(await readFile(dbPath, 'utf8'))
  db.offers = [
    {
      id: 'o_slow',
      providerId: p.id,
      credentialId: db.credentials.find((c) => c.providerId === p.id)?.id || null,
      upstreamName: 'test-model',
      modelKey: 'test-model',
      group: 'g',
      priceUnit: 'per_mtok',
      inPrice: 1,
      outPrice: 2,
      currency: 'CNY',
      ratio: 1,
    },
  ]
  db.settings.gateway = {
    enabled: true,
    keys: [
      {
        id: 'gk_test',
        name: 'test',
        key: 'sk-mapi-test000000000000000000000000',
        enabled: true,
        monthlyTokenLimit: null,
        note: '',
        createdAt: new Date().toISOString(),
      },
    ],
  }
  await writeFile(dbPath, JSON.stringify(db))
  // 等 daemon 真的读到这把 Key：直写 db.json 之后它要等 mtime 缓存失效。
  // 固定 sleep 在这里会偶发 401（daemon 首轮写入把我们的改动覆盖/缓存没刷新），
  // 表现就是「客户端拿到 401」——重跑又过，是最难查的那种假红。
  //
  // 注意：这里**不能**拿一次真请求来探活。mock 上游只会发 SSE，非流式探活会
  // 解析失败并记一条「全部候选失败」故障，把后面「一次都没上报」的断言弄假红。
  // 直接问 /api/state 看 Key 在不在，零副作用。
  for (let i = 0; i < 40; i++) {
    const st = await fetch(`http://127.0.0.1:${APP_PORT}/api/state`).then((r) => r.json()).catch(() => null)
    const keys = st?.gateway?.keys || []
    if (keys.some((k) => k.key === 'sk-mapi-test000000000000000000000000')) break
    await sleep(250)
  }
}

// ---- 客户端：读到一半就取消（模拟 pi 到点超时 / 用户按 Esc）
async function halfReadAbort() {
  const ac = new AbortController()
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-mapi-test000000000000000000000000',
    },
    body: JSON.stringify({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    signal: ac.signal,
  })
  ok(res.status === 200, `客户端拿到 200（实际 ${res.status}）`)
  const reader = res.body.getReader()
  let got = ''
  // 读到第一段正文就挂断：这时候流已经提交，网关只能收尾不能换站
  while (!got.includes('第0段')) {
    const { value, done } = await reader.read()
    if (done) break
    got += new TextDecoder().decode(value)
  }
  ok(got.includes('第0段'), '取消前确实已经收到了正文（不是零输出的场景）')
  ac.abort()
  await reader.cancel().catch(() => {})
}

try {
  await halfReadAbort()
  // 决策日志攒批写盘 2000ms，供给表现跟着它一起落
  await sleep(4000)

  const state = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/state`)).json()
  const last = state.routing[0]
  ok(last, '决策日志有记录')
  ok(last.outcome === 'client-aborted', `outcome = client-aborted（实际 ${last?.outcome}）`)
  ok(last.clientAborted === true, '带 clientAborted 标记')
  ok(last.attempts === 1, `没有换站乱试（attempts=${last.attempts}）`)

  const db = JSON.parse(await readFile(join(home, 'db.json'), 'utf8'))
  const buckets = Object.values(db.offerStats || {}).filter((b) => b.offerId === 'o_slow')
  ok(buckets.length === 1, `供给表现有一个小时桶（${buckets.length}）`)
  const b = buckets[0]
  ok(b.clientAborts === 1, `clientAborts = 1（实际 ${b.clientAborts}）`)
  ok(b.requests === 1 && b.clientAborts === 1, `requests 记总单数、分母靠相减（requests=${b.requests} clientAborts=${b.clientAborts}）`)
  ok(b.broken === 0, `broken 没被污染（实际 ${b.broken}）`)
  ok(b.ttftCount === 0, `不算首字（实际 ${b.ttftCount}）`)
  ok(b.latencyCount === 0, `不算总时长（实际 ${b.latencyCount}）`)

  const traffic = db.traffic?.o_slow
  ok(!traffic || ((traffic.ok || 0) === 0 && (traffic.fail || 0) === 0), '流量可用率不吃这一单')

  const faults = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/faults`)).json()
  const ignored = faults.events.filter((e) => e.kind === 'client-aborted')
  ok(ignored.length === 1, `故障事件账有一条（${ignored.length}）`)
  const e = ignored[0]
  ok(e.status === 'ignored', `status = ignored（实际 ${e.status}）`)
  ok(e.message === '客户端主动断开请求，不予处理', `措辞是人话（实际「${e.message}」）`)
  ok((e.detail || '').includes('不是站点'), 'detail 说清不是站点的问题')
  ok(e.impact === 'none', '影响等级 none')
  ok(faults.stats.ignored === 1, `stats.ignored 有数（${faults.stats.ignored}）`)
  ok(faults.stats.sent === 0, '一次都没上报自动路由')

  // ---- 再来两次：同一供给 10 分钟内只留一条，hits 递增（不刷屏）
  await halfReadAbort()
  await sleep(500)
  await halfReadAbort()
  await sleep(1200)
  const faults2 = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/faults`)).json()
  const agg = faults2.events.filter((x) => x.kind === 'client-aborted')
  ok(agg.length === 1, `三次断开仍只有一条记录（${agg.length}）`)
  ok(agg[0].hits === 3, `hits 聚合到 3（实际 ${agg[0].hits}）`)
  ok(faults2.stats.sent === 0, '三次断开都没有上报自动路由')

  // 上游确实被我们掐了（否则「客户端断开」只是记账口径，实际还在烧钱）
  await sleep(300)
  ok(upstreamClosed >= 1, `上游连接被及时掐掉（${upstreamClosed} 次）`)
} catch (e) {
  try {
    const db = JSON.parse(await readFile(join(home, 'db.json'), 'utf8'))
    console.error('DEBUG routing[0]:', JSON.stringify(db.routing?.[db.routing.length - 1]))
    console.error('DEBUG faultEvents:', JSON.stringify(db.faultEvents?.slice(-3)))
    console.error('DEBUG offerStats:', JSON.stringify(Object.values(db.offerStats || {}).slice(-2)))
  } catch {}
  console.error(e)
  process.exitCode = 1
} finally {
  app.kill()
  upstream.close()
  await rm(home, { recursive: true, force: true }).catch(() => {})
}
console.log(`check-client-abort-e2e: ${n} 项全部通过`)
