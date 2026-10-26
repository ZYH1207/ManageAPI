/**
 * 登录态自检：mock Sub2API 站（登录端点 + 鉴权端点），验证
 * 账号密码登录 → token 写入 adminToken → 令牌失效自动重登（含冷却）
 * → 凭据不回显。全程临时数据目录。
 *
 * 用法：node .test/check-login.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = await mkdtemp(join(tmpdir(), 'mapi-login-'))
const APP_PORT = 4394
const UP_PORT = 5210
const BASE = `http://127.0.0.1:${APP_PORT}`
const UP = `http://127.0.0.1:${UP_PORT}`

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

// ---- mock Sub2API 站
// 登录：账号 user@x.test / pw-12345 → access_token（第一轮 good，过期轮 expired）
// channels：Bearer 有效→ 200 分组数据；Bearer=expired → 401 TOKEN_EXPIRED
let seq = 0
const validTokens = new Set(['good-access-token'])
let lockLogin = false // 模拟站点风控：true 时登录接口拒绝
const up = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/api/v1/auth/login') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      if (lockLogin) return send(401, { code: 'INVALID_CREDENTIALS', message: 'wrong email or password' })
      if (body.email === 'user@x.test' && body.password === 'pw-12345') {
        seq += 1
        const tok = `access-${seq}`
        validTokens.add(tok)
        send(200, { data: { access_token: tok, refresh_token: 'rt-' + seq, expires_in: 7200, user: { id: 42, email: body.email } } })
      } else {
        send(401, { code: 'INVALID_CREDENTIALS', message: 'wrong email or password' })
      }
    })
    return
  }
  if (url.pathname === '/api/v1/channels/available') {
    const auth = String(req.headers.authorization || '')
    if (validTokens.has(auth.replace('Bearer ', ''))) return send(200, { data: [{ name: 'ch', platforms: [{ platform: 'openai', groups: [{ name: 'default', rate_multiplier: 0.5 }], supported_models: [{ name: 'test-model-a', pricing: { input_price: 1e-6, output_price: 2e-6 } }] }] }] })
    return send(401, { code: 'TOKEN_EXPIRED', message: 'Token has expired' })
  }
  if (url.pathname === '/api/v1/user/profile') {
    const auth = String(req.headers.authorization || '')
    if (validTokens.has(auth.replace('Bearer ', ''))) return send(200, { data: { balance: 42.5, currency: 'CNY' } })
    return send(401, { code: 'TOKEN_EXPIRED', message: 'Token has expired' })
  }
  if (url.pathname === '/v1/models') return send(200, { data: [{ id: 'test-model-a' }] })
  return send(404, {})
})
await new Promise((r) => up.listen(UP_PORT, '127.0.0.1', r))

const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  cwd: ROOT,
  env: { ...process.env, MANAGE_API_HOME: HOME },
  stdio: ['ignore', 'ignore', 'ignore'],
})
const api = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

try {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150))
  }

  console.log('[1] 建站（自动系别探测会命中 sub2api 的 settings/public？mock 没有 → unknown）')
  {
    const { data } = await api('POST', '/api/providers', { name: '登录验证站', baseUrl: `${UP}/v1` })
    const p = data.providers.find((x) => x.name === '登录验证站')
    ok(Boolean(p?.id), '站点已建')
    await api('POST', '/api/credentials', { providerId: p.id, secret: 'sk-x' })
  }

  console.log('[2] 账号密码登录 → token 写入 adminToken')
  let state = (await api('GET', '/api/state')).data
  const pid = state.providers[0].id
  {
    const r = await api('POST', `/api/providers/${pid}/login`, { user: 'user@x.test', password: 'pw-12345' })
    ok(r.status === 200 && r.data.loginResult?.ok, '登录接口成功')
    // adminToken 写回后 channels 可用：识别分组（groups 接口）能读到数据
    const g = await api('GET', `/api/providers/${pid}/groups`)
    ok(g.status === 200 && (g.data.groups || []).length > 0, '写入的 token 能读可用渠道（复用现有逻辑）')
    // 凭据不回显：state 里不该出现明文密码
    const raw = JSON.stringify(r.data)
    ok(!raw.includes('pw-12345'), 'state 里不出现明文密码')
  }

  console.log('[3] 令牌过期 → 401 自动重登 → 恢复')
  {
    validTokens.clear() // 模拟站点侧令牌轮换：旧 token 全部 401
    // 重新登录拿新 token（等价于真实场景里的令牌失效）
    const before = (await api('GET', '/api/state')).data
    ok(before.providers[0].adminTokenSource === 'login', '令牌来源标记为 login')
    // 触发一次会 401 的读取（导入基准价 → channels 401 → 自动重登 → 重试成功）
    const r = await api('POST', '/api/benchmarks/import', { providerId: pid })
    ok(r.status === 200, `导入在自动重登后成功（status=${r.status}）`)
    const after = (await api('GET', '/api/state')).data
    ok((after.providers[0].tokenStatus || 'ok') !== 'invalid', '令牌状态没有被误标为失效')
  }

  console.log('[4] 冷却：登录被站点拒绝时不硬刚（重登失败进入冷却）')
  {
    lockLogin = true // 模拟站点风控：连登录接口都拒绝
    const r1 = await api('GET', `/api/providers/${pid}/groups?fresh=1`)
    ok(r1.status === 502, `请求失败（status=${r1.status}）`)
    const msg1 = JSON.stringify(r1.data)
    ok(/登录失败|风控|拒绝/.test(msg1) || /冷却/.test(msg1), `第一次失败带原因（${msg1.slice(0, 140)}）`)
    // 第二次：自动重登已在冷却中，不再打扰站点
    const r2 = await api('GET', `/api/providers/${pid}/groups?fresh=1`)
    ok(/冷却/.test(JSON.stringify(r2.data)), '第二次失败提示冷却（不硬刚站点）')
    lockLogin = false
  }

  console.log('')
  if (failed === 0) console.log('全部通过 ✓')
  else {
    console.error(`${failed} 项失败`)
    process.exitCode = 1
  }
} finally {
  app.kill()
  up.close()
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}
