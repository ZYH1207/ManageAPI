/**
 * new-api 登录响应兼容性（纯单元，不起 daemon）：
 *   - 新版 new-api 返回 data.access_token（配 access_expires_at）→ 必须认
 *   - 老版 one-api/new-api 返回 data.token → 仍然要认
 *   - 两者都没有 → 报错里带出响应片段（便于现场定位）
 *
 * 背景：格子API（api.geziapi.com，v1.0.0-rc.46）登录报
 * 「登录响应里没有 token: {"access_expires_at":...,"access_token":"eyJ..."}」
 *
 * 用法：node .test/check-login-newapi.mjs
 */
import { createServer } from 'node:http'
import { loginProvider } from '../core/providers.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

const PORT = 5288
const BASE = `http://127.0.0.1:${PORT}`

// mode: 'access' 新版 / 'token' 老版 / 'none' 都没有
let mode = 'access'
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/api/user/login') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      if (body.username !== 'me@x.test' || body.password !== 'pw') {
        return send(401, { success: false, message: '用户名或密码错误' })
      }
      if (mode === 'access') {
        return send(200, {
          success: true,
          data: {
            id: 7,
            username: 'me',
            role: 1,
            access_expires_at: 1793249277,
            access_token: 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6N30.sig',
          },
        })
      }
      if (mode === 'token') return send(200, { success: true, data: { id: 7, token: 'legacy-token-7' } })
      return send(200, { success: true, data: { id: 7, something_else: 1 } })
    })
    return
  }
  send(404, {})
})

await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

try {
  console.log('[1] 新版 new-api：data.access_token')
  {
    mode = 'access'
    const r = await loginProvider({ baseUrl: `${BASE}/v1`, kind: 'new-api', user: 'me@x.test', password: 'pw' })
    ok(r.token === 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6N30.sig', 'token 取到 access_token')
    ok(r.userId === '7', 'userId 取到 id')
    ok(r.kind === 'new-api', 'kind 保持 new-api')
  }

  console.log('[2] 老版 one-api：data.token 仍需兼容')
  {
    mode = 'token'
    const r = await loginProvider({ baseUrl: `${BASE}/v1`, kind: 'one-api', user: 'me@x.test', password: 'pw' })
    ok(r.token === 'legacy-token-7', 'token 取到 token')
    ok(r.userId === '7', 'userId 取到 id')
  }

  console.log('[3] 两个字段都没有 → 报错带响应片段')
  {
    mode = 'none'
    let msg = ''
    try {
      await loginProvider({ baseUrl: `${BASE}/v1`, kind: 'new-api', user: 'me@x.test', password: 'pw' })
    } catch (e) {
      msg = String(e.message || e)
    }
    ok(/没有 token\/access_token/.test(msg), `报错提到两个字段名（${msg.slice(0, 80)}）`)
    ok(/something_else/.test(msg), '报错里带响应片段')
  }

  console.log('[4] 密码错 → 仍按登录被拒绝处理')
  {
    mode = 'access'
    let msg = ''
    try {
      await loginProvider({ baseUrl: `${BASE}/v1`, kind: 'new-api', user: 'me@x.test', password: 'bad' })
    } catch (e) {
      msg = String(e.message || e)
    }
    ok(/登录失败|用户名或密码错误/.test(msg), `报错可读（${msg.slice(0, 90)}）`)
  }
} finally {
  server.close()
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}
