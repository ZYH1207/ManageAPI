/**
 * 持久化登录 / 令牌自动续期自检（假站点 + 临时数据目录，不联网）。
 *
 * 钉死五件事：
 *   1. 账号密码登录要把 refresh_token、userId、到期时间都存下来
 *   2. 401 后优先用刷新令牌静默续期，不重复打密码登录
 *   3. 刷新令牌是旋转式的：旧的再用必须被站点拒绝，本地不能拿旧值硬刷
 *   4. 同站并发 401 只触发一次续期（renewals Map），否则第二次会拿作废的 refresh
 *   5. 人机验证站不硬闯：登录明确报 BROWSER_LOGIN_REQUIRED，改走「导入登录响应」
 *
 * 用法：node .test/check-session-renewal.mjs
 */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'mapi-renew-'))
process.env.MANAGE_API_HOME = home

const store = await import('../core/store.js')
const inv = await import('../core/inventory.js')
const providers = await import('../core/providers.js')

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1
    console.log(`  ok ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name} ${extra}`)
  }
}

// ---------------------------------------------------------------- 假站点
const stats = { login: 0, refresh: 0, profile: 0 }
let currentRefresh = 'refresh-1'
let seq = 1
const validAccess = new Set(['access-1'])
const validRefresh = new Set(['refresh-1'])

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    const auth = String(req.headers.authorization || '')
    if (req.method === 'POST' && req.url === '/api/v1/auth/login') {
      stats.login += 1
      json(200, {
        data: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 60, user: { id: 7 } },
      })
      return
    }
    if (req.method === 'POST' && req.url === '/api/v1/auth/refresh') {
      stats.refresh += 1
      let parsed = {}
      try {
        parsed = JSON.parse(body || '{}')
      } catch {}
      const given = String(parsed.refresh_token || '')
      if (!validRefresh.has(given)) {
        json(401, { message: 'invalid refresh token' })
        return
      }
      // 旋转：用过的刷新令牌立刻作废，换发一对新的
      validRefresh.delete(given)
      seq += 1
      currentRefresh = `refresh-${seq}`
      const access = `access-${seq}`
      validAccess.add(access)
      validRefresh.add(currentRefresh)
      json(200, { data: { access_token: access, refresh_token: currentRefresh, expires_in: 3600 } })
      return
    }
    if (req.method === 'GET' && (req.url === '/api/v1/user/profile' || req.url === '/api/user/self')) {
      stats.profile += 1
      const token = auth.replace(/^Bearer\s+/i, '').trim()
      if (!validAccess.has(token)) {
        json(401, { message: 'unauthorized' })
        return
      }
      json(200, { data: { id: 7, username: 'tester' } })
      return
    }
    json(404, { message: 'not found' })
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/v1`

const readProvider = async (id) => (await store.readDb()).providers.find((p) => p.id === id)

try {
  console.log('1) 账号密码登录：refresh_token / userId / 到期时间都要落库')
  const created = await inv.createProvider({ name: '假 Sub2API', baseUrl, kind: 'sub2api' })
  await inv.loginWithCredentials(created.id, { user: 'a@b.c', password: 'pw' })
  let p = await readProvider(created.id)
  check('token 尾号', p.adminTokenTail === 'ess-1'.slice(-6) || String(p.adminTokenTail).length === 6)
  check('来源是 login', p.adminTokenSource === 'login')
  check('存了 refreshToken', Boolean(p.refreshTokenEnc))
  check('存了 userId', p.adminUserId === '7', String(p.adminUserId))
  check('到期时间在 60 秒后', Math.abs(Date.parse(p.adminTokenExpiresAt) - (Date.now() + 60000)) < 5000)
  check('续期方式记 login', p.tokenRenewMethod === 'login')
  const firstExpiry = p.adminTokenExpiresAt
  check('只打了 1 次密码登录', stats.login === 1, String(stats.login))

  console.log('2) 401 续期：优先刷新令牌，不再打密码登录')
  const renewed = await inv.autoRelogin(created.id)
  check('续期成功', renewed.ok === true, renewed.reason || '')
  check('用的是 refresh', renewed.method === 'refresh', String(renewed.method))
  check('refresh 接口被调用 1 次', stats.refresh === 1, String(stats.refresh))
  check('没有重复密码登录', stats.login === 1, String(stats.login))
  p = await readProvider(created.id)
  check('续期方式记 refresh', p.tokenRenewMethod === 'refresh', String(p.tokenRenewMethod))
  check('refreshTokenEnc 换成了新的', Boolean(p.refreshTokenEnc))
  check('到期时间前进了', Date.parse(p.adminTokenExpiresAt) > Date.parse(firstExpiry))

  console.log('3) 刷新令牌旋转：旧的那一枚必须失效')
  const rotated = await providers
    .refreshProviderToken({ baseUrl, refreshToken: 'refresh-1' })
    .then(() => ({ ok: true }))
    .catch((error) => ({ ok: false, status: error.status }))
  check('旧 refresh 被站点拒绝', rotated.ok === false && rotated.status === 401, JSON.stringify(rotated))

  console.log('4) 同站并发续期只触发一次（旋转令牌不能被并发消费）')
  inv.clearReloginCooldown(created.id)
  const before = stats.refresh
  const results = await Promise.all([inv.autoRelogin(created.id), inv.autoRelogin(created.id), inv.autoRelogin(created.id)])
  check('三个并发调用都成功', results.every((r) => r.ok), JSON.stringify(results.map((r) => r.reason || 'ok')))
  check('只多打了 1 次 refresh', stats.refresh === before + 1, String(stats.refresh - before))
  p = await readProvider(created.id)
  check('令牌尾号等于最新 access', p.adminTokenTail === `access-${seq}`.slice(-6), String(p.adminTokenTail))

  console.log('5) 人机验证站：明确报 BROWSER_LOGIN_REQUIRED，不硬闯、不做打码')
  const captchaServer = createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ message: 'captcha verification failed, turnstile required' }))
  })
  await new Promise((resolve) => captchaServer.listen(0, '127.0.0.1', resolve))
  const captchaPort = captchaServer.address().port
  const captcha = await providers
    .loginProvider({
      baseUrl: `http://127.0.0.1:${captchaPort}/v1`,
      kind: 'sub2api',
      user: 'a@b.c',
      password: 'pw',
    })
    .then(() => ({ ok: true }))
    .catch((error) => ({ ok: false, code: error.code, message: error.message }))
  check('登录被验证码挡住', captcha.ok === false && captcha.code === 'BROWSER_LOGIN_REQUIRED', JSON.stringify(captcha))
  check('提示里给出的是「导入登录响应」而不是验证码绕过', /导入/.test(String(captcha.message)))
  captchaServer.close()

  console.log('6) 导入浏览器登录响应：先验证再落库，之后靠 refresh 续期')
  validAccess.add('access-9')
  validRefresh.add('refresh-9')
  const imported = await inv.importProviderSession(created.id, {
    data: { access_token: 'access-9', refresh_token: 'refresh-9', expires_in: 120 },
  })
  check('导入成功', imported.ok === true)
  check('识别为 sub2api', imported.kind === 'sub2api', String(imported.kind))
  check('可自动续期', imported.renewable === true)
  p = await readProvider(created.id)
  check('来源记 session', p.adminTokenSource === 'session', String(p.adminTokenSource))
  check('续期方式记 session-import', p.tokenRenewMethod === 'session-import', String(p.tokenRenewMethod))
  check('导入型会话不保留密码', p.loginCred === null)
  check('profile 接口被调用过', stats.profile >= 1, String(stats.profile))

  inv.clearReloginCooldown(created.id)
  const afterImport = await inv.autoRelogin(created.id)
  check('导入型会话也能刷新续期', afterImport.ok === true && afterImport.method === 'refresh', JSON.stringify(afterImport))

  console.log('7) 粘贴的令牌无效时明确拒绝，不写坏数据')
  const beforeBad = await readProvider(created.id)
  const bad = await inv
    .importProviderSession(created.id, { access_token: 'not-a-real-token' })
    .then(() => ({ ok: true }))
    .catch((error) => ({ ok: false, message: error.message }))
  check('无效令牌被拒', bad.ok === false && /没有权限/.test(String(bad.message)), JSON.stringify(bad))
  const afterBad = await readProvider(created.id)
  check(
    '拒绝后令牌没被覆盖',
    // adminToken 是加密信封对象，两次读盘是不同的实例，只能按内容比
    JSON.stringify(afterBad.adminToken) === JSON.stringify(beforeBad.adminToken) &&
      afterBad.tokenRenewedAt === beforeBad.tokenRenewedAt &&
      afterBad.adminTokenTail === beforeBad.adminTokenTail,
    JSON.stringify({
      tail: [beforeBad.adminTokenTail, afterBad.adminTokenTail],
      renewed: [beforeBad.tokenRenewedAt, afterBad.tokenRenewedAt],
      method: [beforeBad.tokenRenewMethod, afterBad.tokenRenewMethod],
    }),
  )

  console.log('8) 解析：裸令牌 / 带 Bearer / 嵌套 data / expires_in 都能认')
  const a = inv.parseProviderSession('sk-raw-token-123')
  check('裸令牌', a.token === 'sk-raw-token-123')
  const b = inv.parseProviderSession('{"access_token":"Bearer abc-def","refresh_token":"r1","expires_in":30}')
  check('去掉 Bearer 前缀', b.token === 'abc-def', b.token)
  check('refresh 解析', b.refreshToken === 'r1')
  check('expires_in 折算成时间', Date.parse(b.expiresAt) > Date.now())
  const c = inv.parseProviderSession('{"data":{"token":"t-1","refreshToken":"r-2"}}')
  check('data 包裹的 token', c.token === 't-1')
  check('驼峰 refreshToken', c.refreshToken === 'r-2')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await rm(home, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${pass} 项通过${fail ? `，${fail} 项失败` : '，全部通过'}`)
process.exitCode = fail ? 1 : 0