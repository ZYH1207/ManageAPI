/**
 * 「模型明明在库里，网关却说没有」必须说清是被什么挡住的；
 * 「全都不可信只能硬试」必须在响应头留痕。
 *
 * 以前：忽略名单 / 站点暂停 / 已下架 三类原因全部收敛成一句
 * 「没有可用的 X。已同步的模型：…」，而且那个列表本身也是过滤后的，
 * 用户完全无从判断该去改站点还是改忽略名单（实测这类模型有 53 个）。
 * 另外 core/router.js 的注释承诺「响应头标记 degraded」，实际从来没写过。
 *
 * 用法：node .test/check-gateway-diagnostics.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP_PORT = 4419
const UP_PORT = 5131

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
let models = ['m-live', 'm-ignored', 'm-dead']
const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: models.map((id) => ({ id })) }))
    return
  }
  if (!url.pathname.endsWith('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"error":"not found"}')
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        model: 'm-live',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
      }),
    )
  })
})
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))

const HOME = await mkdtemp(join(tmpdir(), 'mapi-diag-'))
const base = `http://127.0.0.1:${APP_PORT}`
const app = spawn(process.execPath, [join(ROOT, 'daemon/index.js')], {
  cwd: ROOT,
  env: { ...process.env, MANAGE_API_HOME: HOME, PORT: String(APP_PORT), MANAGE_API_PORT: String(APP_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
app.stdout.on('data', () => {})
app.stderr.on('data', (d) => process.stderr.write(`[daemon] ${d}`))

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`)
  return json
}

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }

  // 两个站：A 提供三条模型（其中一条会被忽略名单挡、一条会被下架），B 会被暂停
  let state = await call('POST', '/api/providers', {
    name: '诊断站A',
    baseUrl: `http://127.0.0.1:${UP_PORT}/v1`,
  })
  const providerA = state.providers.find((p) => p.name === '诊断站A')
  await call('POST', '/api/credentials', { providerId: providerA.id, secret: 'sk-diag-a' })
  state = await call('POST', `/api/providers/${providerA.id}/sync`)
  ok(state.offers.filter((o) => o.providerId === providerA.id).length === 3, 'A 站同步出 3 条供给')

  models = ['m-live', 'm-ignored', 'm-dead', 'm-onlyb']
  state = await call('POST', '/api/providers', {
    name: '暂停站B',
    baseUrl: `http://127.0.0.1:${UP_PORT}/v1b`,
  })
  const providerB = state.providers.find((p) => p.name === '暂停站B')
  await call('POST', '/api/credentials', { providerId: providerB.id, secret: 'sk-diag-b' })
  await call('POST', `/api/providers/${providerB.id}/sync`)

  // 忽略名单 + 暂停 + 下架
  await call('PATCH', '/api/settings', { ignoredModels: ['m-ignored'] })
  await call('PATCH', `/api/providers/${providerB.id}`, { paused: true })
  models = ['m-live', 'm-ignored'] // m-dead 从上游消失（m-onlyb 只属于暂停站 B）
  await call('POST', `/api/providers/${providerA.id}/sync`)

  state = await call('GET', '/api/state')
  const gatewayKey = state.gateway.keys.find((k) => k.enabled)?.key
  if (!gatewayKey) throw new Error('没有可用的网关 Key')
  const auth = { Authorization: `Bearer ${gatewayKey}`, 'Content-Type': 'application/json' }

  const ask = async (model) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    })
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers }
  }

  console.log('\n[1] 命中忽略名单')
  {
    const r = await ask('m-ignored')
    ok(r.status === 404, `返回 404（实际 ${r.status}）`)
    ok(r.body?.error?.type === 'model_blocked', `错误类型是 model_blocked（实际 ${r.body?.error?.type}）`)
    ok((r.body?.error?.details?.blocked?.ignored || 0) >= 1, `details 里说清有 ${r.body?.error?.details?.blocked?.ignored} 条在忽略名单里`)
    ok(String(r.body?.error?.message || '').includes('忽略名单'), '文案点名「忽略名单」')
    ok(String(r.body?.error?.message || '').includes('移除'), '文案给出可执行的动作')
  }

  console.log('\n[2] 所属站点已暂停')
  {
    const r = await ask('m-dead') // 先看下架，再看暂停（m-dead 在 A 站，A 没暂停）
    ok(r.status === 404, `返回 404（实际 ${r.status}）`)
    ok((r.body?.error?.details?.blocked?.delisted || 0) >= 1, 'details 里标出已下架的条数')
  }
  {
    const r = await ask('m-onlyb')
    ok(r.status === 404, `返回 404（实际 ${r.status}）`)
    ok((r.body?.error?.details?.blocked?.paused || 0) >= 1, 'details 里标出所属站点被暂停的条数')
    ok(String(r.body?.error?.message || '').includes('暂停'), '文案点名「暂停」')
  }
  {
    const r = await ask('m-nothing-here')
    ok(r.status === 404 && r.body?.error?.details?.blocked?.total === 0, '库里没有的模型仍是 total=0（不硬编原因）')
  }

  console.log('\n[3] 全都不可信时硬试，但响应头留痕')
  {
    const r = await ask('m-live') // 没有任何探针样本 → routable=false
    ok(r.status === 200, `仍然照试成功（实际 ${r.status}）`)
    ok(r.headers.get('x-manageapi-degraded') === '1', `响应头 X-ManageAPI-Degraded=1（实际 ${r.headers.get('x-manageapi-degraded')}）`)
    ok(r.headers.get('x-manageapi-attempts') === '1', 'attempts 头仍在')
    ok(r.headers.get('x-manageapi-quality') === 'unknown', 'quality 头如实写 unknown')
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
  await new Promise((r) => upstream.close(r))
  setTimeout(() => process.exit(process.exitCode || 0), 300)
}
