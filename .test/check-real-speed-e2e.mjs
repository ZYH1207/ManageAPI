/**
 * 真实速度这一档，端到端必须真的有数据。
 *
 * 背景：`daemon/server.js` 的 bufferTraffic 少传了一个实参，speed 落在 providerId 的位置，
 * 于是「真实速度」从上线起就没写进过库——db.traffic 里 samples 一路涨到两百多，
 * ttftMs 数组却始终是空的。所有单元测试都通不了这条链（bug 在调用点），所以必须走真网关。
 *
 * 本测试只要证明三件事：
 *   1. 一次真实请求之后，traffic 行里存下了首字与它自己的 prompt 大小；
 *   2. 老的两条平行数组由样本派生（老路径与新路径说同一个数）；
 *   3. 下一次选站时，体验分已经按实测走（tier = real，而不是永远探针）。
 *
 * 用法：node .test/check-real-speed-e2e.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP_PORT = 4396
const UP_PORT = 5116

let failed = 0
function ok(cond, message) {
  if (cond) console.log(`  ✓ ${message}`)
  else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 假上游
// 只做一件事：用「13 万 token 的 prompt」回报 usage，让这条样本明确落在中前缀档。
const UPSTREAM_PROMPT_TOKENS = 130_000
const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'm-long' }] }))
    return
  }
  if (!url.pathname.endsWith('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"error":"not found"}')
    return
  }
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    frame({ choices: [{ delta: { role: 'assistant' } }] })
    // 留出首字延迟：ttft 才有意义（真 0ms 会被当成「没测到」跳过）
    setTimeout(() => {
      frame({ choices: [{ delta: { content: '收到。' } }] })
      frame({ choices: [{ delta: { content: '这是一次真实速度的样本。' } }] })
      frame({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      frame({
        choices: [],
        usage: {
          prompt_tokens: UPSTREAM_PROMPT_TOKENS,
          completion_tokens: 24,
          prompt_tokens_details: { cached_tokens: 129_000 },
        },
      })
      res.write('data: [DONE]\n\n')
      res.end()
    }, 250)
  })
})
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))

// ---------------------------------------------------------------- daemon
const HOME = await mkdtemp(join(tmpdir(), 'mapi-real-speed-'))
const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  cwd: ROOT,
  env: { ...process.env, MANAGE_API_HOME: HOME },
  // MAPI_DEBUG_SPEED=1 时让 daemon 的日志直通终端（排查「为什么没有样本」用）
  stdio: process.env.MAPI_DEBUG_SPEED ? 'inherit' : 'ignore',
})
const base = `http://127.0.0.1:${APP_PORT}`

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`)
  return data
}

async function chatOnce(auth) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ model: 'm-long', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const text = await res.text()
  return { status: res.status, text }
}

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) break
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }

  let state = await call('POST', '/api/providers', {
    name: '真实速度测试站',
    baseUrl: `http://127.0.0.1:${UP_PORT}/v1`,
  })
  const provider = state.providers.find((p) => p.name === '真实速度测试站')
  await call('POST', '/api/credentials', { providerId: provider.id, secret: 'sk-real-speed' })
  state = await call('POST', `/api/providers/${provider.id}/sync`)
  const offer = state.offers.find((o) => o.modelKey === 'm-long')
  ok(Boolean(offer), '同步出供给 m-long')

  const gatewayKey = state.gateway.keys.find((k) => k.enabled)?.key
  if (!gatewayKey) throw new Error('没有可用的网关 Key')
  const auth = { Authorization: `Bearer ${gatewayKey}` }

  console.log('\n[1] 一次真实请求之后，速度样本必须真的落库')
  const first = await chatOnce(auth)
  ok(first.status === 200, `请求成功（HTTP ${first.status}）`)
  // traffic 攒批 5 秒落盘
  await sleep(6500)
  let db = JSON.parse(await readFile(join(HOME, 'db.json'), 'utf8'))
  {
    const row = db.traffic?.[offer.id] || {}
    const speed = row.speed || {}
    const rows = Array.isArray(speed.rows) ? speed.rows : []
    // 这条链断在调用点，失败时最需要的证据是「库里到底写进了什么」
    if (rows.length === 0) console.error('    [调试] db.traffic[' + offer.id + '] =', JSON.stringify(row))
    ok(rows.length >= 1, `speed.rows 里有样本（${rows.length} 条）——这正是之前永远为 0 的东西`)
    ok(Number(rows[0]?.ttftMs) > 0, `样本带正的首字（${rows[0]?.ttftMs}ms）`)
    ok(
      Number(rows[0]?.promptTokens) === UPSTREAM_PROMPT_TOKENS,
      `样本带上它自己的 prompt 大小（${rows[0]?.promptTokens}）`,
    )
    ok(speed.samples === rows.length, `计数器由样本推出（samples=${speed.samples} / rows=${rows.length}）`)
    ok(
      Array.isArray(speed.ttftMs) && speed.ttftMs.length === rows.length,
      `老路径的两条平行数组由样本派生（ttftMs ${speed.ttftMs?.length} 条）`,
    )
    ok(Number(speed.ttftMs?.[0]) === Number(rows[0]?.ttftMs), '新旧两条路径说的是同一个数')
  }

  console.log('\n[2] 第二次选站：体验分应该已经按实测走，而不是永远「探针」')
  const second = await chatOnce(auth)
  ok(second.status === 200, `第二次请求成功（HTTP ${second.status}）`)
  await sleep(2500)
  db = JSON.parse(await readFile(join(HOME, 'db.json'), 'utf8'))
  {
    const entry = (db.routing || []).filter((r) => r.model === 'm-long').at(-1)
    const pick = entry?.candidates?.find((c) => c.offerId === offer.id)
    ok(Boolean(pick), '路由日志里能找到这次选中的供给')
    ok(Number(pick?.trafficTtftMs) > 0, `决策页能拿到实测首字（trafficTtftMs=${pick?.trafficTtftMs}）`)
    ok(pick?.experienceDetail?.tier === 'real', `体验分走真实档（tier=${pick?.experienceDetail?.tier}）`)
    ok(typeof pick?.trafficTtftMatched === 'boolean', '同档标记随候选一起下发（界面据此写「未同档」）')
    ok(
      pick?.trafficSpeedByBucket && typeof pick.trafficSpeedByBucket === 'object',
      '三档统计随候选一起下发，界面能画出「长前缀惩罚」',
    )
  }

  console.log('')
  if (failed === 0) console.log('全部通过 ✓')
  else {
    console.error(`${failed} 项失败`)
    process.exitCode = 1
  }
} catch (error) {
  console.error('测试出错：', error.message || error)
  process.exitCode = 1
} finally {
  app.kill()
  upstream.close()
  setTimeout(() => process.exit(process.exitCode || 0), 300)
}
