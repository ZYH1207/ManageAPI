// 自包含生命周期测试：仅本地模拟站 + 临时库，不访问真实站点。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = await mkdtemp(join(tmpdir(), 'mapi-token-'))
process.env.MANAGE_API_HOME = home
const inv = await import('../core/inventory.js')
const store = await import('../core/store.js')
const providers = await import('../core/providers.js')
let loginCount = 0, refreshCount = 0, generateCount = 0
let refreshStatus = 200, legacyStatus = 200
let refreshSecret = 'refresh-0'
let site
const server = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw || '{}')
  const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
  if (req.url === '/api/v1/auth/login') {
    loginCount++
    return send(200, { code: 0, data: { access_token: `access-${loginCount}`, refresh_token: refreshSecret, expires_in: 3600, user: { id: 42 } } })
  }
  if (req.url === '/api/v1/auth/refresh') {
    refreshCount++
    assert.equal(req.method, 'POST')
    assert.equal(body.refresh_token, refreshSecret)
    if (refreshStatus !== 200) return send(refreshStatus, { message: 'refresh refused' })
    refreshSecret = `rotated-${refreshCount}`
    // 同站并发刷新必须合并，轮换令牌不可重复消费。
    await new Promise((resolve) => setTimeout(resolve, 20))
    return send(200, { code: 0, data: { access_token: `renewed-${refreshCount}`, refresh_token: refreshSecret, expires_in: 7200 } })
  }
  if (req.url === '/api/user/token') {
    generateCount++
    assert.equal(req.method, 'GET')
    assert.equal(req.headers['new-api-user'], '42')
    assert.match(req.headers.authorization, /^Bearer /)
    return send(legacyStatus, legacyStatus === 200 ? { success: true, data: 'official-long-secret' } : {})
  }
  return send(404, {})
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
try {
  site = await inv.createProvider({ name: '生命周期验证站', baseUrl, kind: 'sub2api' })
  await inv.loginWithCredentials(site.id, { user: 'test', password: 'secret-password' })
  assert.equal(loginCount, 1)
  let db = await store.readDb()
  assert.ok(Date.parse(db.providers[0].adminTokenExpiresAt) > Date.now())
  const [a, b] = await Promise.all([inv.autoRelogin(site.id), inv.autoRelogin(site.id)])
  assert.equal(a.token, 'renewed-1')
  assert.equal(b.token, a.token)
  assert.equal(refreshCount, 1)
  assert.equal(loginCount, 1)
  db = await store.readDb()
  assert.equal(await store.decryptSecret(db.providers[0].refreshTokenEnc), 'rotated-1')
  assert.equal(db.providers[0].tokenRenewMethod, 'refresh')
  let view = (await inv.publicState()).providers[0]
  for (const key of ['adminToken', 'loginCred', 'refreshTokenEnc']) assert.equal(key in view, false)
  assert.equal(view.tokenRenewal, 'refresh')
  console.log('✓ 刷新优先、并发单飞、轮换凭据原子保存、凭据不回显')

  inv.clearReloginCooldown(site.id)
  refreshStatus = 429
  assert.equal((await inv.autoRelogin(site.id)).ok, false)
  assert.equal(loginCount, 1)
  assert.equal((await store.readDb()).providers[0].tokenStatus, 'ok')
  assert.match((await inv.autoRelogin(site.id)).reason, /冷却/)
  console.log('✓ 上游限流不追加登录、不误标访问令牌失效、失败后冷却')

  inv.clearReloginCooldown(site.id)
  refreshStatus = 401
  assert.equal((await inv.autoRelogin(site.id)).ok, true)
  assert.equal(loginCount, 2)
  console.log('✓ 刷新凭据失效时允许账号重新登录')

  inv.clearReloginCooldown(site.id)
  refreshStatus = 200
  await store.mutate((db) => { db.providers[0].adminTokenExpiresAt = new Date(Date.now() + 60000).toISOString() })
  assert.match(await inv.ensureAdminToken(site.id), /^renewed-/)
  console.log('✓ 已知有效期到期前自动续期')

  await inv.updateProvider(site.id, { kind: 'new-api', adminUserId: '42' })
  const generation = inv.obtainLongLivedToken(site.id)
  // 等到生成请求进入单飞表，再模拟后台采集碰到过期令牌。
  while (generateCount === 0) await new Promise(resolve => setImmediate(resolve))
  const concurrentRenewal = inv.autoRelogin(site.id)
  await generation
  const concurrentResult = await concurrentRenewal
  assert.equal(concurrentResult.ok ? concurrentResult.token : 'official-long-secret', 'official-long-secret')
  assert.equal(generateCount, 1)
  assert.equal(await inv.revealAdminToken(site.id), 'official-long-secret')
  view = (await inv.publicState()).providers[0]
  assert.equal(view.adminTokenSource, 'long-lived')
  assert.equal(view.tokenRenewal, null)
  assert.equal((await store.readDb()).providers[0].loginCred, null)
  assert.equal((await inv.autoRelogin(site.id)).ok, false)
  console.log('✓ 官方旧版长期令牌写回、保留真实用户 ID、清除不再需要的密码')

  legacyStatus = 404
  await assert.rejects(() => inv.obtainLongLivedToken(site.id), /后台.*安全验证/)
  assert.equal(await inv.revealAdminToken(site.id), 'official-long-secret')
  console.log('✓ 新版接口不支持时引导后台验证，保留当前令牌')

  await inv.updateProvider(site.id, { adminToken: 'manual-secret' })
  assert.equal((await inv.autoRelogin(site.id)).ok, false)
  assert.equal((await store.readDb()).providers[0].refreshTokenEnc, null)
  console.log('✓ 手填令牌不会被旧登录凭据覆盖')
  assert.equal(providers.tokenExpiresAt({}), null)
  assert.equal(providers.tokenExpiresAt({ expires_at: 1790000000 }), new Date(1790000000000).toISOString())
  assert.equal(providers.tokenExpiresAt({ expires_in: 60 }, 1000), new Date(61000).toISOString())
  console.log('✓ 有效期解析：秒、相对时间及未声明')
  // 升级幂等且不改已有令牌。
  await store.mutate((db) => { db.version = 7; delete db.providers[0].adminTokenExpiresAt })
  const migrated = await store.readDb()
  assert.equal(migrated.version, 8)
  assert.equal(migrated.providers[0].adminTokenExpiresAt, null)
  assert.deepEqual((await store.readDb()).providers, migrated.providers)
  console.log('✓ v7 → v8 迁移幂等，未知有效期不冒充永久')
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  // 只清理本脚本刚建的临时目录，并核对绝对目标。
  const target = await realpath(home)
  assert.equal(target, await realpath(home))
  assert.ok(target.startsWith(await realpath(tmpdir()) + '/mapi-token-'))
  await rm(target, { recursive: true, force: true })
}
