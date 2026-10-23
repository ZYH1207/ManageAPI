/**
 * WorkBuddy 连接器（T2b）离线验证。
 *
 * 真实登录要开浏览器走 OAuth，自动化环境里走不完，所以这里注入假 fetch，
 * 把「授权流 → 业务码中间态 → 落库加密 → 余额解析 → 过期刷新 → 错误翻译」
 * 这些分支都跑一遍。数据目录指到临时目录，跑完删掉，绝不碰本机 ~/.manage-api。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'manageapi-workbuddy-'))
process.env.MANAGE_API_HOME = home

const { createWorkbuddyConnector, AUTH_TIMEOUT_MS } = await import(
  '../core/platforms/workbuddy.js'
)
const { encryptSecret, decryptSecret } = await import('../core/store.js')
const { getConnector } = await import('../core/platforms/connector.js')

const step = (n, title) => console.log(`\n[${n}] ${title}`)
const futureIso = (ms) => new Date(Date.now() + ms).toISOString()

/** 最小 Response 替身：连接器只用到 status / ok / json()。 */
const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

try {
  // 1 ---------------------------------------------------------------------
  step(1, '导入即注册：registry 里能拿到 workbuddy')
  const registered = getConnector('workbuddy')
  assert.ok(registered, '连接器应当已注册')
  assert.equal(registered.id, 'workbuddy')
  assert.deepEqual(registered.detect(), { available: true })
  assert.equal(registered.pollIntervalMs, 1000)
  assert.equal(registered.authTimeoutMs, AUTH_TIMEOUT_MS)
  console.log('   →', registered.label, '| detect:', JSON.stringify(registered.detect()))

  // 假 fetch：按 URL 分派，并记录调用次数
  const calls = []
  let tokenPolls = 0
  let refreshCalls = 0

  const fakeFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {} })
    const u = String(url)

    if (u.includes('/v2/plugin/auth/state')) {
      return reply({
        code: 0,
        data: { state: 'st_test_1', authUrl: 'https://www.workbuddy.ai/authorize?state=st_test_1' },
      })
    }

    if (u.includes('/v2/plugin/auth/token?')) {
      tokenPolls += 1
      if (tokenPolls === 1) {
        // HTTP 200 + 业务码 11217 = 还没好，必须当中间态而不是错误
        return reply({ code: 11217, msg: 'token not ready' })
      }
      return reply({
        code: 0,
        data: {
          accessToken: 'at_secret_1',
          refreshToken: 'rt_secret_1',
          expiresAt: futureIso(3600_000),
          domain: 'www.workbuddy.ai',
          enterpriseId: 'ent_9',
        },
      })
    }

    if (u.includes('/v2/plugin/login/account')) {
      return reply({ code: 0, data: { name: '测试账号', enterpriseId: 'ent_9' } })
    }

    if (u.includes('/v2/plugin/auth/token/refresh')) {
      refreshCalls += 1
      return reply({
        code: 0,
        data: { accessToken: 'at_secret_2', expiresAt: futureIso(7200_000) },
      })
    }

    if (u.includes('/v2/billing/meter/get-user-resource')) {
      return reply({ code: 0, data: { total: 100, used: 30, resetAt: '2026-11-01T00:00:00Z' } })
    }

    if (u.includes('/v2/billing/meter/daily-checkin')) {
      return reply({ code: 0, data: { reward: 10 }, msg: '签到成功' })
    }

    if (u.includes('/v1/models')) {
      return reply({ code: 0, data: { models: [{ name: 'deepseek-v4.1-flash' }, { id: 'glm-5' }] } })
    }

    return reply({ code: 404, msg: 'not found' }, 404)
  }

  // 落库用一个假账号对象承接，验证的是「密文进 secret」而不是存储层实现
  const account = { id: 'pa_test', label: '测试账号', secret: null }
  const store = {
    async updateAccount(id, patch) {
      assert.equal(id, account.id)
      if (patch.secret !== undefined) account.secret = patch.secret
      return account
    },
  }

  const connector = createWorkbuddyConnector({ fetch: fakeFetch, store })

  // 2 ---------------------------------------------------------------------
  step(2, 'startConnect → 解析 state 与 authUrl')
  const started = await connector.startConnect({ product: 'workbuddy' })
  assert.equal(started.state, 'st_test_1')
  assert.ok(started.authUrl.startsWith('https://www.workbuddy.ai/authorize'))
  assert.ok(Date.parse(started.expiresAt) > Date.now())
  const stateCall = calls[0]
  assert.equal(stateCall.method, 'POST')
  assert.ok(stateCall.url.includes('platform=workbuddy-ai'))
  assert.equal(stateCall.headers['x-no-authorization'], 'true')
  assert.equal(stateCall.headers['x-domain'], 'www.workbuddy.ai')
  console.log('   →', JSON.stringify(started))

  // 3 ---------------------------------------------------------------------
  step(3, 'pollConnect 两次：11217 → ready:false，随后 ready:true')
  const first = await connector.pollConnect({ state: started.state, product: 'workbuddy' })
  assert.equal(first.ready, false)
  console.log('   第一次:', JSON.stringify(first))

  const second = await connector.pollConnect({
    state: started.state,
    product: 'workbuddy',
    accountId: account.id,
  })
  assert.equal(second.ready, true)
  assert.equal(second.credential.accessToken, 'at_secret_1')
  assert.equal(second.credential.refreshToken, 'rt_secret_1')
  assert.equal(second.credential.enterpriseId, 'ent_9')
  assert.equal(second.profile.label, '测试账号')
  console.log('   第二次:', JSON.stringify({
    ready: second.ready,
    credential: {
      accessToken: '***已省略***',
      refreshToken: '***已省略***',
      expiresAt: second.credential.expiresAt,
      domain: second.credential.domain,
      enterpriseId: second.credential.enterpriseId,
    },
    profile: second.profile,
  }))

  // 4 ---------------------------------------------------------------------
  step(4, 'token 以密文落库，且明文不出现在 secret 里')
  assert.ok(account.secret?.data && account.secret?.iv && account.secret?.tag, 'secret 应是 AES-GCM 密文对象')
  const serialized = JSON.stringify(account.secret)
  assert.ok(!serialized.includes('at_secret_1'), '密文里不能出现明文 token')
  const plain = JSON.parse(await decryptSecret(account.secret))
  assert.equal(plain.accessToken, 'at_secret_1')
  assert.equal(plain.product, 'workbuddy')
  console.log('   密文字段:', Object.keys(account.secret).join(','), '| 解密后 accessToken 一致')

  // 5 ---------------------------------------------------------------------
  step(5, 'quota → 把 get-user-resource 解析成 remaining')
  const quota = await connector.quota(account)
  assert.equal(quota.remaining, 70) // total 100 - used 30
  assert.equal(quota.unit, 'credit')
  assert.equal(quota.refreshAt, '2026-11-01T00:00:00.000Z')
  const quotaCall = calls.find((c) => c.url.includes('get-user-resource'))
  assert.equal(quotaCall.method, 'POST')
  assert.equal(quotaCall.headers.authorization, 'Bearer at_secret_1')
  assert.equal(quotaCall.headers['x-enterprise-id'], 'ent_9')
  console.log('   →', JSON.stringify(quota))

  // 6 ---------------------------------------------------------------------
  step(6, 'catalog → 模型名列表；checkin → reward')
  const models = await connector.catalog(account)
  assert.deepEqual(models, [{ name: 'deepseek-v4.1-flash' }, { name: 'glm-5' }])
  console.log('   models:', JSON.stringify(models))

  const checked = await connector.checkin(account)
  assert.equal(checked.ok, true)
  assert.equal(checked.reward, 10)
  assert.equal(checked.alreadyToday, false)
  console.log('   →', JSON.stringify(checked))

  // 7 ---------------------------------------------------------------------
  step(7, 'token 过期 → 自动 refresh 并回写密文')
  account.secret = await encryptSecret(
    JSON.stringify({
      accessToken: 'at_old',
      refreshToken: 'rt_secret_1',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      domain: 'www.workbuddy.ai',
      enterpriseId: 'ent_9',
      product: 'workbuddy',
    }),
  )
  const refreshed = await connector.quota(account)
  assert.equal(refreshCalls, 1)
  assert.equal(refreshed.remaining, 70)
  const afterRefresh = JSON.parse(await decryptSecret(account.secret))
  assert.equal(afterRefresh.accessToken, 'at_secret_2')
  // 刷新响应没带 refreshToken，必须沿用旧的，否则下次刷新直接失败
  assert.equal(afterRefresh.refreshToken, 'rt_secret_1')
  console.log('   refresh 次数:', refreshCalls, '| 新 accessToken 已回写:', afterRefresh.accessToken)

  // 8 ---------------------------------------------------------------------
  step(8, '错误翻译：401 / 404 / 超时 / 业务码')
  const expired = createWorkbuddyConnector({
    fetch: async () => reply({ code: 401, msg: 'unauthorized' }, 401),
    store,
  })
  await assert.rejects(() => expired.quota(account), /登录已失效，重新连接/)

  const missing = createWorkbuddyConnector({
    fetch: async () => reply({ msg: 'no such route' }, 404),
    store,
  })
  await assert.rejects(() => missing.startConnect({}), /这个平台没有这个接口/)

  const timeout = createWorkbuddyConnector({
    fetch: async () => {
      const error = new Error('The operation was aborted due to timeout')
      error.name = 'TimeoutError'
      throw error
    },
    store,
  })
  await assert.rejects(() => timeout.startConnect({}), /平台没有响应/)

  const broken = createWorkbuddyConnector({
    fetch: async () => reply({ code: 50001, msg: '风控拦截' }),
    store,
  })
  await assert.rejects(() => broken.startConnect({}), /发起授权失败：风控拦截/)

  const noCatalog = createWorkbuddyConnector({
    fetch: async () => reply({ msg: 'boom' }, 500),
    store,
  })
  assert.deepEqual(await noCatalog.catalog(account), [], '目录失败应退化成空数组')
  console.log('   401/404/超时/业务码/目录降级 全部符合预期')

  // 9 ---------------------------------------------------------------------
  step(9, '签到幂等：code 0 + checkedIn 标记 → alreadyToday')
  const already = createWorkbuddyConnector({
    fetch: async (url) => {
      if (String(url).includes('daily-checkin')) {
        return reply({ code: 0, data: { checkedIn: true }, msg: '今日已签到' })
      }
      return reply({ code: 0, data: {} })
    },
    store,
  })
  const again = await already.checkin(account)
  assert.equal(again.ok, false)
  assert.equal(again.alreadyToday, true)
  console.log('   →', JSON.stringify(again))

  console.log('\n全部 9 步通过')
} finally {
  await rm(home, { recursive: true, force: true })
}
