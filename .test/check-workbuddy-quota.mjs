/**
 * 免费池 · 额度口径回归。
 *
 * 这条测试盯的是「余额对不上」的那个根因：WorkBuddy 的返回里
 *   TotalDosage / CapacityRemain —— 包内还剩多少
 *   CycleCapacityRemain           —— 本周期还剩多少
 * 两者不是一回事（免费订阅会出现「包内 100、本周期 0」），而且同一个租户下
 * 国际版/国内版两张卡读到的是同一份余额，靠 AppId 才能识别。
 *
 * 用假 fetch 注入真实结构的返回，不联网、不碰本机 ~/.manage-api。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'manageapi-quota-'))
process.env.MANAGE_API_HOME = home

const { createWorkbuddyConnector } = await import('../core/platforms/workbuddy.js')
const { encryptSecret } = await import('../core/store.js')

const step = (n, title) => console.log(`\n[${n}] ${title}`)
const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

/** 真实结构：一个还在生效的免费订阅 + 一堆已过期的礼包 */
const billingBody = {
  Response: {
    Data: {
      TotalCount: 6,
      TotalDosage: 100,
      AppId: '1511803817',
      Accounts: [
        {
          Name: 'Free Plan Subscription',
          Status: 0,
          CapacitySize: 100,
          CapacityRemain: 100,
          CycleCapacitySize: 100,
          CycleCapacityRemain: 0,
          CycleCapacityUsed: 100,
          CycleEndTime: '2026-10-31 23:59:59',
          ExpiredTime: '2027-10-31 23:59:59',
        },
        { Name: 'Bonus Pack', Status: 3, CapacityRemain: 0, ExpiredTime: '2026-10-22 23:59:59' },
        { Name: 'Bonus Pack', Status: 3, CapacityRemain: 0, ExpiredTime: '2026-10-23 23:59:59' },
      ],
    },
  },
}

try {
  const fakeFetch = async (url) => {
    const u = String(url)
    if (u.includes('/v2/billing/meter/get-user-resource')) return reply(billingBody)
    if (u.includes('/v2/plugin/auth/token/refresh')) return reply({ code: 0, data: {} })
    throw new Error(`测试没有准备好这个请求：${u}`)
  }

  const store = { updateAccount: async () => {} }
  const connector = createWorkbuddyConnector({ product: 'workbuddy', fetch: fakeFetch, store })

  const secret = await encryptSecret(
    JSON.stringify({
      accessToken: 'at_test',
      refreshToken: 'rt_test',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      domain: 'www.workbuddy.ai',
      enterpriseId: 'ent_1',
      product: 'workbuddy',
    }),
  )
  const account = { id: 'pa_test', secret, quota: null }

  step(1, '包内剩余 / 本周期剩余 / 租户 都解析出来了')
  const quota = await connector.quota(account)
  console.log(`   → ${JSON.stringify(quota)}`)
  assert.equal(quota.remaining, 100, '包内剩余应等于 TotalDosage')
  assert.equal(quota.cycleRemaining, 0, '本周期剩余应来自 CycleCapacityRemain（已用满）')
  assert.equal(quota.cycleSize, 100, '本周期总量应来自 CycleCapacitySize')
  assert.equal(quota.tenantKey, '1511803817', '租户 id 用来识别同一账号的两张卡')
  assert.equal(quota.refreshAt, '2026-10-31T15:59:59.000Z', '刷新时间取 CycleEndTime')
  assert.equal(quota.unit, 'credit')

  step(2, '已过期的包不参与求和')
  const expiredOnly = {
    Response: {
      Data: {
        TotalCount: 2,
        TotalDosage: 0,
        Accounts: [
          { Status: 3, CapacityRemain: 500, CycleCapacityRemain: 500 },
          { Status: 0, CapacityRemain: 20, CycleCapacityRemain: 20, CycleEndTime: '2026-11-30 23:59:59' },
        ],
      },
    },
  }
  const connector2 = createWorkbuddyConnector({
    product: 'workbuddy',
    fetch: async (url) =>
      String(url).includes('get-user-resource') ? reply(expiredOnly) : reply({ code: 0, data: {} }),
    store,
  })
  const quota2 = await connector2.quota(account)
  console.log(`   → remaining=${quota2.remaining} cycle=${quota2.cycleRemaining}`)
  assert.equal(quota2.cycleRemaining, 20, '过期包的 CycleCapacityRemain 不该算进去')

  step(3, '没有计费结构时回落到猜字段（保持旧行为）')
  const plain = createWorkbuddyConnector({
    product: 'workbuddy',
    fetch: async (url) =>
      String(url).includes('get-user-resource')
        ? reply({ data: { remaining: 42, refreshAt: '2026-11-01 00:00:00' } })
        : reply({ code: 0, data: {} }),
    store,
  })
  const quota3 = await plain.quota(account)
  console.log(`   → ${JSON.stringify(quota3)}`)
  assert.equal(quota3.remaining, 42)
  assert.equal(quota3.cycleRemaining, null, '没有周期字段时不该编造')
  assert.equal(quota3.tenantKey, '')

  step(4, '字段全对不上时要报错并带上片段（不能静默返回 0）')
  const broken = createWorkbuddyConnector({
    product: 'workbuddy',
    fetch: async (url) =>
      String(url).includes('get-user-resource')
        ? reply({ Response: { Data: { SomethingElse: 1 } } })
        : reply({ code: 0, data: {} }),
    store,
  })
  await assert.rejects(() => broken.quota(account), /没认出积分字段/)
  console.log('   → 抛错并带返回片段，符合预期')

  console.log('\n全部 4 步通过')
} finally {
  await rm(home, { recursive: true, force: true })
}
