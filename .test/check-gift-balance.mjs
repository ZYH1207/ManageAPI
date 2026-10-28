/**
 * 赠金（Sub2API 的「赠送额度」）识别自检。
 *
 * 现场的病：codexpert 上本金余额 0、赠金 $2，网关只读 `/api/v1/user/profile`
 * 的 `balance`，于是卡片显示 $0.000、还判「余额已用尽」。赠金在另一个接口
 * `/api/v1/rewards/overview`（gift_available_balance + nearest_expiry），
 * 以前根本没读。
 *
 * 这个测试盯四条底线：
 *   1. 有赠金时「可用余额」= 本金 + 赠金可用（赠金能花，漏掉会误报余额不足）；
 *   2. 本金与赠金分开回传（卡片要能写「其中赠金 $2.00」）；
 *   3. 站点没有赠金接口（404/超时）时，本金余额照常返回，不报错；
 *   4. 赠金消失（过期/用光）后，站点上挂着的旧赠金字段要被清掉。
 *
 * 用法：node .test/check-gift-balance.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = await mkdtemp(join(tmpdir(), 'mapi-gift-'))
process.env.MANAGE_API_HOME = HOME

const APP_PORT = 4393
const UP_PORT = 5122

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

// ---------------------------------------------------------------- 假上游
//
// 结构照抄真实站点：本金在 /api/v1/user/profile 的 balance，
// 赠金在 /api/v1/rewards/overview 的 gift_available_balance。
const site = { giftEnabled: true, gift: 1.998353 }

const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/api/v1/user/profile') {
    return send(200, {
      code: 0,
      data: { id: 1, balance: 0, frozen_balance: 0, currency: 'USD', status: 'active' },
    })
  }
  if (url.pathname === '/api/v1/rewards/overview') {
    if (!site.giftEnabled) return send(404, { error: 'not found' })
    return send(200, {
      code: 0,
      data: {
        enabled: true,
        gift_balance: site.gift,
        gift_available_balance: site.gift,
        gift_frozen_balance: 0,
        consumption_multiplier: 0.15,
        nearest_expiry: '2026-11-27T11:57:35.305177+08:00',
      },
    })
  }
  return send(404, { error: 'not found' })
})
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))

const base = `http://127.0.0.1:${APP_PORT}`
const siteUrl = `http://127.0.0.1:${UP_PORT}/v1`

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

async function waitReady() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('服务没起来')
}

const near = (a, b, eps = 1e-6) => Number.isFinite(a) && Math.abs(a - b) < eps

try {
  const providers = await import('../core/providers.js')
  const inv = await import('../core/inventory.js')

  // ------------------------------------------------ 1 纯函数：本金 + 赠金
  console.log('[1] tryBalance：赠金并进可用余额，本金单独回传')
  const withGift = await providers.tryBalance({ baseUrl: siteUrl, apiKey: '', adminToken: 'admin-test', kind: 'sub2api' })
  ok(withGift.ok === true, '余额读取成功')
  ok(near(withGift.remaining, 1.998353), `可用余额 = 0 + 1.998353（实际 ${withGift.remaining}）`)
  ok(withGift.principal === 0, `本金单独回传（实际 ${withGift.principal}）`)
  ok(near(withGift.giftBalance, 1.998353), `赠金单独回传（实际 ${withGift.giftBalance}）`)
  ok(String(withGift.giftExpiry || '').startsWith('2026-11-27'), `带上赠金到期时间（实际 ${withGift.giftExpiry}）`)

  console.log('[2] 站点没有赠金接口：本金照常返回，不报错')
  site.giftEnabled = false
  const noGift = await providers.tryBalance({ baseUrl: siteUrl, apiKey: '', adminToken: 'admin-test', kind: 'sub2api' })
  ok(noGift.ok === true, '余额读取仍然成功')
  ok(noGift.remaining === 0, `可用余额就是本金 0（实际 ${noGift.remaining}）`)
  ok(noGift.giftBalance === null, `赠金为 null（实际 ${JSON.stringify(noGift.giftBalance)}）`)
  ok(noGift.giftExpiry === null, '到期时间为 null')
  site.giftEnabled = true

  // ------------------------------------------------ 2 端到端：写回站点
  console.log('[3] 端到端：读余额把赠金写到站点卡片上')
  const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
    env: { ...process.env, MANAGE_API_HOME: HOME },
    stdio: 'ignore',
  })
  await waitReady()

  let state = await call('POST', '/api/providers', { name: '赠金验证站', baseUrl: siteUrl })
  const provider = state.providers.find((p) => p.name === '赠金验证站')
  await call('PATCH', `/api/providers/${provider.id}`, { adminToken: 'admin-test' })
  state = await call('POST', '/api/credentials', {
    providerId: provider.id,
    label: '默认',
    secret: 'sk-gift-test',
  })
  ok(Boolean(state.credentials.find((c) => c.providerId === provider.id)), 'Key 建好了')

  state = await call('POST', `/api/providers/${provider.id}/balance`, {})
  const saved = state.providers.find((p) => p.id === provider.id)
  ok(near(saved.quotaRemaining, 1.998353), `站点余额 = 本金 + 赠金（实际 ${saved.quotaRemaining}）`)
  ok(near(saved.giftBalance, 1.998353), `站点上记下赠金（实际 ${saved.giftBalance}）`)
  ok(String(saved.giftExpiry || '').startsWith('2026-11-27'), '站点上记下赠金到期时间')
  ok(near(state.balance?.remaining, 1.998353), '接口回包也带着赠金口径')

  // ------------------------------------------------ 3 赠金消失要清掉
  console.log('[4] 赠金用光/过期：旧字段必须清掉，不能一直挂着')
  site.giftEnabled = false
  state = await call('POST', `/api/providers/${provider.id}/balance`, {})
  const after = state.providers.find((p) => p.id === provider.id)
  ok(after.quotaRemaining === 0, `余额回落到本金 0（实际 ${after.quotaRemaining}）`)
  ok(after.giftBalance === null, `赠金字段被清空（实际 ${JSON.stringify(after.giftBalance)}）`)
  ok(after.giftExpiry === null, '到期时间被清空')

  // ------------------------------------------------ 4 写回口径只有一处
  console.log('[5] applyBalanceResult：写回字段的唯一口径')
  const fake = {}
  const wrote = inv.applyBalanceResult(fake, { ok: true, remaining: 3.5, currency: 'USD', giftBalance: 2, giftExpiry: '2026-12-01' }, 'T')
  ok(wrote === true, '写回成功')
  ok(fake.quotaRemaining === 3.5 && fake.currency === 'USD', '余额与币种写对')
  ok(fake.giftBalance === 2 && fake.giftExpiry === '2026-12-01', '赠金与到期写对')
  ok(fake.quotaUpdatedAt === 'T', '时间戳由调用方给，便于同一份 mutate 里对齐')
  ok(inv.applyBalanceResult({}, { ok: false, reason: 'x' }) === false, '读取失败时不写（保留旧值）')

  app.kill()
} catch (error) {
  failed += 1
  console.error(`\n测试异常：${error.stack || error.message}`)
} finally {
  upstream.close()
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
