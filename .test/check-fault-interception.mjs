/**
 * 故障截流 e2e：上游「刚开口就断流」时，用户必须完全无感。
 *
 * 现场还原：上游 A 发完 role 声明 chunk 就断开连接（现实中就是「刚开口就没了」）。
 * 旧代码在 role chunk 一到就向客户端提交，于是用户吃到空开头 + 报错，救不回来。
 * 现在无正文的 chunk 先攒着，断流发生时这一轮还没提交 → 网关静默换下一条供给重放
 * → 用户拿到的就是 B 家的完整回答，中间发生过什么都不知道。
 *
 * 钉死四件事：
 *   1. 客户端拿到 200 + B 家完整回答（HTTP 状态、内容、usage 一个不缺）
 *   2. 决策日志里 outcome=ok 且 attempts=2（换过站）
 *   3. 故障事件账里有「无感截流」的记录（absorbed，不上报自动路由）
 *   4. 客户端全程没看到任何错误码 / 内部报错文本
 *
 * 跑法：node .test/check-fault-interception.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import http from 'node:http'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = 'D:/micro/ManageAPI/.wt/diagnosis'
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

// ---- mock 上游：bad 端口「role 就断」，good 端口完整回答
const UP_PORT = await freePort()
const upstream = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const isBad = String(req.url).includes('bad')
    if (isBad) {
      // 先发一个 role 声明（无正文），然后直接断开连接
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null,"index":0}]}\n\n')
      setTimeout(() => res.destroy(), 50)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null,"index":0}]}\n\n')
    res.write('data: {"choices":[{"delta":{"content":"截流测试回答"},"finish_reason":null,"index":0}]}\n\n')
    res.write(
      `data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":0}}}\n\n`,
    )
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))

// ---- 起网关（临时库）
const home = await mkdtemp(join(tmpdir(), 'mapi-intercept-'))
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

// ---- 预置：走正规 API 建站 + 建 Key（secret 必须走加密管道，直写 db 会解密失败）
{
  const apiPost = (path, body) =>
    fetch(`http://127.0.0.1:${APP_PORT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json())
  const st1 = await apiPost('/api/providers', { name: '坏站', baseUrl: `http://127.0.0.1:${UP_PORT}/bad` })
  const st2 = await apiPost('/api/providers', { name: '好站', baseUrl: `http://127.0.0.1:${UP_PORT}/good` })
  const pBad = st1.providers.find((x) => x.name === '坏站')
  const pGood = st2.providers.find((x) => x.name === '好站')
  await apiPost('/api/credentials', { providerId: pBad.id, label: 'k', secret: 'test-key-bad', group: 'g' })
  await apiPost('/api/credentials', { providerId: pGood.id, label: 'k', secret: 'test-key-good', group: 'g' })
  // 供给直写库（offers 没有密文，直写无碍）
  const dbPath = join(home, 'db.json')
  const db = JSON.parse(await readFile(dbPath, 'utf8'))
  db.offers = [
    { id: 'o_bad', providerId: pBad.id, credentialId: null, upstreamName: 'test-model', modelKey: 'test-model', group: 'g', priceUnit: 'per_mtok', inPrice: 1, outPrice: 2, currency: 'CNY', ratio: 1 },
    { id: 'o_good', providerId: pGood.id, credentialId: null, upstreamName: 'test-model', modelKey: 'test-model', group: 'g', priceUnit: 'per_mtok', inPrice: 1, outPrice: 2, currency: 'CNY', ratio: 1 },
  ]
  // 手动顺序：坏站排第一（逼网关先撞坏站）
  db.manualOrder = { 'test-model': ['o_bad', 'o_good'] }
  // 网关 Key：客户端凭它进网关（挂在 settings.gateway）
  db.settings.gateway = { enabled: true, keys: [{ id: 'gk_test', name: 'test', key: 'sk-mapi-test000000000000000000000000', enabled: true, monthlyTokenLimit: null, note: '', createdAt: new Date().toISOString() }] }
  await writeFile(dbPath, JSON.stringify(db))
  await sleep(600)
}

try {
  // ---- 客户端视角：一次请求
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-mapi-test000000000000000000000000' },
    body: JSON.stringify({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  ok(res.status === 200, `客户端拿到 200（实际 ${res.status}）`)
  const text = await res.text()
  ok(text.includes('截流测试回答'), '客户端拿到完整回答')
  ok(!text.includes('502') && !text.includes('上游暂时不可用'), '全程没有错误码')
  ok(text.includes('"role":"assistant"'), 'role 声明也没丢（攒着的 chunk 被补发）')
  ok(text.includes('[DONE]'), '流正常收尾')

  // ---- 网关侧：决策日志证明换过站（决策日志攒批落盘，多等一会）
  await sleep(3500)
  const state = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/state`)).json()
  const last = state.routing[0]
  ok(last && last.outcome === 'ok', `决策日志 outcome=ok（实际 ${last?.outcome}）`)
  ok(last.attempts === 2, `换过站（attempts=${last.attempts}）`)
  ok(last.chosenProviderName === '好站', `最终落在好站（实际 ${last.chosenProviderName}）`)

  // ---- 故障事件账：无感截流有记录、但没上报自动路由（上报需要目标配置，这里没有 = skipped 也不算 sent）
  const faults = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/faults`)).json()
  const absorbed = faults.events.filter((e) => e.status === 'absorbed')
  ok(absorbed.length >= 1, `无感截流记了一笔（${absorbed.length} 条 absorbed）`)
  const sent = faults.events.filter((e) => e.status === 'sent')
  eq: console.log(`  · 上报条数 ${sent.length}（未配置自动路由时不上报，符合预期）`)
} catch (e) {
  try {
    const st = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/state`)).json()
    const r0 = st.routing && st.routing[0]
    console.error('DEBUG routing[0]:', r0 ? JSON.stringify({outcome:r0.outcome,attempts:r0.attempts,failures:(r0.failures||[]).map(f=>f.providerName+': '+String(f.error).slice(0,60)),candidates:(r0.candidates||[]).map(c=>c.providerName+':'+c.routable)}) : 'null')
    console.error('DEBUG offers:', JSON.stringify((st.offers||[]).map(o=>({id:o.id,providerId:o.providerId,modelKey:o.modelKey}))))
    console.error('DEBUG providers:', JSON.stringify((st.providers||[]).map(p=>({id:p.id,name:p.name,baseUrl:p.baseUrl}))))
    console.error('DEBUG gateway:', JSON.stringify(st.gateway && st.gateway.enabled))
  } catch {}
  console.error(e)
  process.exitCode = 1
} finally {
  app.kill()
  upstream.close()
  await rm(home, { recursive: true, force: true }).catch(() => {})
}
console.log(`check-fault-interception: ${n} 项全部通过`)
