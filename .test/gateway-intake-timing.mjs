/**
 * 网关入口回归：客户端请求形状 + 非流式读体计时。
 *
 * ## 两个现场（2026-11-03/04 实测出来的）
 *
 * ### ① 畸形请求不该去撞上游（N02）
 *
 * 候选链是「挨个试，全灭才报错」。一个缺 `messages` 的请求发进来，每个候选都会
 * 因为上游回 400 而失败，最后聚合成 502；这些 400 还会被记进供给的流量账。
 * 一次客户端笔误就能让若干条正常供给的可用率下降——用户看到的是「站点变坏了」。
 * 断言：本地 400、**上游零请求**、该供给失败计数不变。
 *
 * ### ② 非流式分块下发不该被首字窗口误杀（N03）
 *
 * 非流式读体以前交给 `res.json()` 一次性等到底，期间没有 touch 点，只能靠初始
 * 窗口当**总时长硬限**。中转站「边生成边写」时明明有字节在流动，超过门槛仍被
 * abort，还报成首字超时并给站点记分。
 * 断言：组级首字窗口压到 2 秒，假上游分 5 块、每块间隔 1 秒（总约 5 秒）下发，
 * 请求必须 200 且拿到完整正文。
 *
 * 全部落在 mktemp 目录，不碰 ~/.manage-api，不发真模型请求。
 * 用法：node .test/gateway-intake-timing.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let n = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  n += 1
}

const freePort = async () => {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 形状校验（纯函数）
console.log('[0] validateGatewayRequest：只查结构，不猜语义')
{
  const { validateGatewayRequest } = await import(pathToFileURL(join(ROOT, 'core/wire.js')).href)
  const bad = [
    [null, 'chat'],
    [{}, 'chat'],
    [{ messages: 'hi' }, 'chat'],
    [{ messages: [] }, 'chat'],
    [{ messages: [{ content: 'hi' }] }, 'chat'],
    [{ messages: ['hi'] }, 'chat'],
    [{ input: 5 }, 'responses'],
  ]
  for (const [body, protocol] of bad) {
    ok(
      typeof validateGatewayRequest(body, protocol) === 'string',
      `拒绝畸形的 ${protocol} 请求：${JSON.stringify(body)?.slice(0, 40)}`,
    )
  }
  const good = [
    [{ messages: [{ role: 'user', content: 'hi' }] }, 'chat'],
    // 空 content 是合法占位（有的客户端用它挂工具结果）
    [{ messages: [{ role: 'tool', content: '' }] }, 'chat'],
    [{ input: 'hi' }, 'responses'],
    [{ input: [{ role: 'user', content: 'hi' }] }, 'responses'],
    // input 缺省合法：有的客户端只传 instructions
    [{ instructions: 'be brief' }, 'responses'],
  ]
  for (const [body, protocol] of good) {
    ok(
      validateGatewayRequest(body, protocol) === null,
      `放行合法的 ${protocol} 请求：${JSON.stringify(body).slice(0, 40)}`,
    )
  }
}

// ---------------------------------------------------------------- 端到端
const HOME = await mkdtemp(join(tmpdir(), 'mapi-intake-'))
process.env.MANAGE_API_HOME = HOME
const APP_PORT = await freePort()
const UP_PORT = await freePort()

const hits = { chat: 0 }
const PAYLOAD = JSON.stringify({
  id: 'chatcmpl-intake',
  object: 'chat.completion',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'slow but fine' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
})

const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'gpt-x' }] }))
    return
  }
  if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
    hits.chat += 1
    req.on('data', () => {})
    req.on('end', async () => {
      // 非流式：分 5 块、每块间隔 1 秒下发（总约 5 秒），模拟中转站边生成边写。
      // 每块都到达 → 网关每次 touch 都续命；真卡死才该被杀。
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const parts = 4
      const size = Math.ceil(PAYLOAD.length / parts)
      for (let i = 0; i < parts; i += 1) {
        res.write(PAYLOAD.slice(i * size, (i + 1) * size))
        await sleep(2000)
      }
      res.end()
    })
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end('{}')
})
await new Promise((resolve) => upstream.listen(UP_PORT, '127.0.0.1', resolve))

const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  cwd: ROOT,
  env: {
    ...process.env,
    MANAGE_API_HOME: HOME,
    MANAGE_API_PROBE_FIRST_DELAY_MS: '600000',
    // 空闲窗口 3 秒：让「总时长硬限 vs 空闲超时」的区别在一次自测里就能被证明。
    // 假上游每 2 秒发一块，所以这一段永远不该判超时；旧的 `json()` 写法会在 3 秒时 abort。
    MANAGE_API_STREAM_IDLE_MS: '3000',
  },
  stdio: 'ignore',
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

  const up = `http://127.0.0.1:${UP_PORT}`
  const created = await call('POST', '/api/providers', { name: '甲', baseUrl: `${up}/v1` })
  const provider = created.providers.find((p) => p.name === '甲')
  await call('POST', '/api/credentials', { providerId: provider.id, label: '默认', secret: 'sk-intake' })
  await call('POST', `/api/providers/${provider.id}/sync`, {})

  const state = await call('GET', '/api/state')
  const offer = state.offers.find((o) => o.providerId === provider.id)
  ok(Boolean(offer), '供给已同步')
  await call('PATCH', `/api/offers/${offer.id}`, {
    inPrice: 1,
    outPrice: 2,
    currency: 'USD',
    pricingMode: 'manual',
  })
  const key = state.gateway.keys.find((k) => k.enabled)?.key
  ok(Boolean(key), '网关 Key 就绪')

  const post = (payload) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    })

  // ---------------------------------------------------------------- ① N02
  hits.chat = 0
  const missing = await post({ model: 'gpt-x' })
  const missingBody = await missing.json().catch(() => ({}))
  ok(missing.status === 400, `缺 messages → 本地 400（${missing.status}）`)
  ok(
    String(missingBody.error?.message || '').includes('messages'),
    `报错点名缺了哪个字段：${missingBody.error?.message}`,
  )
  ok(hits.chat === 0, `缺 messages 时上游零请求（实际 ${hits.chat}）`)

  for (const payload of [{ model: 'gpt-x', messages: [] }, { model: 'gpt-x', messages: 'hi' }]) {
    const res = await post(payload)
    await res.text()
    ok(res.status === 400, `畸形 messages 形状 → 400（${JSON.stringify(payload.messages)}）`)
  }
  ok(hits.chat === 0, `全部畸形请求都没有触达上游（实际 ${hits.chat}）`)

  // 攒批 5 秒落盘后，确认评分没有被这些请求污染
  await sleep(6500)
  const db = JSON.parse(await readFile(join(HOME, 'db.json'), 'utf8'))
  const tr = db.traffic?.[offer.id] || {}
  ok(!(Number(tr.fail) > 0), `畸形的客户端请求没有被记成站点失败（fail=${tr.fail ?? 0}）`)

  // ---------------------------------------------------------------- ② N03
  //
  // 建一个生效组（routeTarget 非 null 的路径），只关掉全忙重试。
  // 空闲窗口由 MANAGE_API_STREAM_IDLE_MS 控制，不碰首字门槛。
  const group = await call('POST', '/api/route-groups', { name: '读体计时', models: ['gpt-x'] })
  await call('PATCH', `/api/route-groups/${group.group.id}`, { allBusyMs: 0 })
  await call('POST', '/api/route-groups/active', { id: group.group.id })

  const startedAt = Date.now()
  const streamed = await post({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] })
  const streamedText = await streamed.text()
  const elapsed = Date.now() - startedAt
  // 关键：总耗时（约 8 秒）**远超**单个空闲窗口（3 秒），
  // 但因为每 2 秒都有字节到达，这一单不该被判超时。
  ok(streamed.status === 200, `总耗时 8s > 空闲窗口 3s，但字节持续到达 → 仍然 200（${streamed.status}）`)
  ok(streamedText.includes('slow but fine'), '拿到了完整正文，不是被截断的半份')
  ok(elapsed >= 6500, `确实等满了上游的下发时间（${elapsed}ms），不是提前返回`)

  console.log(`gateway-intake-timing: ${n} 项全部通过`)
} finally {
  app.kill()
  upstream.close()
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}
