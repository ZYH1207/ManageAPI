/**
 * ZCode 连接器的自包含测试。
 *
 * 全是纯函数 + 注入，不碰真实客户端、不联网：
 *   - 凭据解密（与客户端同一套 enc:v1 方案）
 *   - 套餐 + 用量 → 额度汇总（含「一次性赠量」和「本周期」两种口径）
 *   - 连接流程（读不到客户端时该报什么错）
 *
 * 跑：node .test/check-zcode.mjs
 */
import { createCipheriv, randomBytes, createHash } from 'node:crypto'
import {
  createZcodeConnector,
  decryptCredentialValue,
  summarizeQuota,
  nextDailyReset,
} from '../core/platforms/zcode.js'

let failed = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` → ${detail}` : ''}`)
  if (!ok) failed += 1
}

// ---------------------------------------------------------------- 1. 解密
function encrypt(raw, secret) {
  const key = createHash('sha256').update(secret).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `enc:v1:${iv.toString('base64url')}.${tag.toString('base64url')}.${data.toString('base64url')}`
}

const secret = 'zcode-credential-fallback:win32:C:\\Users\\test:test'
const jwtFixture = 'header.payload.signature'
const blob = encrypt(jwtFixture, secret)

check('解密 enc:v1 密文', decryptCredentialValue(blob, secret) === jwtFixture)
check('换一个 secret 解不开（返回空串）', decryptCredentialValue(blob, 'other-secret') === '')
check('明文原样返回', decryptCredentialValue('sk-plain', secret) === 'sk-plain')

// ---------------------------------------------------------------- 2. 额度汇总
const now = new Date('2026-10-23T14:30:00+08:00').getTime()
const plans = [
  {
    user_plan_id: 'upl_bonus',
    plan_id: 'zcode-v3-start-plan-1024',
    name: 'ZCode 1024 Dev Day',
    status: 'active',
    ends_at: Math.floor(new Date('2026-10-26T01:00:00Z').getTime() / 1000),
    entitlements: [
      { entitlement_id: 'ent_bonus_flash', show_name: 'GLM-5.3-Flash', period: 'one_time', grant_units: 300000000 },
      { entitlement_id: 'ent_bonus_53', show_name: 'GLM-5.3', period: 'one_time', grant_units: 200000000 },
    ],
  },
  {
    user_plan_id: 'upl_daily',
    plan_id: 'zcode-v3-start-plan-0817',
    name: 'ZCode Start Plan',
    status: 'active',
    ends_at: Math.floor(new Date('2026-10-27T15:59:59Z').getTime() / 1000),
    entitlements: [
      { entitlement_id: 'ent_daily_53', show_name: 'GLM-5.3', period: 'daily', grant_units: 3000000 },
      { entitlement_id: 'ent_daily_flash', show_name: 'GLM-5.3-Flash', period: 'daily', grant_units: 5000000 },
    ],
  },
  {
    user_plan_id: 'upl_old',
    plan_id: 'zcode-v3-start-plan-0801',
    name: '已过期套餐',
    status: 'expired',
    ends_at: Math.floor(new Date('2026-10-01T00:00:00Z').getTime() / 1000),
    entitlements: [{ entitlement_id: 'ent_old', show_name: 'GLM-5.3', period: 'daily', grant_units: 999 }],
  },
]
const usage = {
  at: now - 60_000,
  source: 'client-log',
  balances: [
    { entitlement_id: 'ent_daily_53', total_units: 3000000, used_units: 1000000, remaining_units: 2000000, available_units: 2000000 },
    { entitlement_id: 'ent_daily_flash', total_units: 5000000, used_units: 0, remaining_units: 5000000, available_units: 5000000 },
  ],
}
const summary = summarizeQuota(plans, usage, now)
check('剩余 = 本周期可用（200 万 + 500 万）', summary.remaining === 7000000, String(summary.remaining))
check('本周期容量 = 800 万', summary.cycleSize === 8000000, String(summary.cycleSize))
check('过期套餐不计入', summary.rows.every((row) => row.id !== 'ent_old'))
check('一次性赠量不混进剩余', summary.rows.filter((r) => r.period === 'one_time').every((r) => r.remaining === null))
check('重置时间取北京时间次日零点', summary.refreshAt === nextDailyReset(now), new Date(summary.refreshAt).toISOString())

const noUsage = summarizeQuota(plans, null, now)
check('没有用量时 remaining 为 null（不编数字）', noUsage.remaining === null)
check('没有用量时本周期仍可从 grant 得到上限', noUsage.cycleSize === 8000000)

// ---------------------------------------------------------------- 3. 连接器
const realFetch = globalThis.fetch
function stubFetch(handler) {
  globalThis.fetch = async (url) => handler(String(url))
}
const okJson = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })
const errJson = (status, body) => ({ ok: false, status, text: async () => JSON.stringify(body) })

try {
  // 3.1 正常：current 成功、balance 400（真实情况就是这样）、用量从日志来
  stubFetch((url) => {
    if (url.includes('/billing/current')) return okJson({ code: 0, msg: '', data: { server_time: now, plans } })
    return errJson(400, { code: 3001, msg: 'parameter error' })
  })
  const connector = createZcodeConnector({
    readCredentials: async () => ({
      ok: true,
      jwt: jwtFixture,
      user: { name: 'Bird', email: 'a@b.c', user_id: 'uid-1' },
      provider: 'zai',
    }),
    readLoggedBalance: async () => usage,
    appVersion: async () => '3.16.3',
  })
  const quota = await connector.quota()
  check('quota.remaining 来自用量', quota.remaining === 7000000, String(quota.remaining))
  check('quota.unit = token', quota.unit === 'token')
  check('quota.source = client-log', quota.source === 'client-log')
  check('quota.tenantKey = 用户 id', quota.tenantKey === 'uid-1')
  check('models 去重', Array.isArray(quota.models) && new Set(quota.models).size === quota.models.length, JSON.stringify(quota.models))
  check('bonusTokens 汇总一次性赠量', quota.bonusTokens === 500000000, String(quota.bonusTokens))

  // 3.2 登录态失效要报出来，不要假装读到 0
  stubFetch(() => ({ ok: false, status: 401, text: async () => '' }))
  let authError = null
  try {
    await connector.quota()
  } catch (error) {
    authError = error.message
  }
  check('current 401 → 提示登录态失效', Boolean(authError && authError.includes('失效')), authError || '(没有报错)')

  // 3.3 没有客户端：startConnect 抛错，pollConnect 返回未就绪
  const missing = createZcodeConnector({
    readCredentials: async () => ({ ok: false, reason: '没找到 ZCode 客户端的登录态（~/.zcode/v2/credentials.json），先打开 ZCode 登录一次' }),
  })
  let connectError = null
  try {
    await missing.startConnect()
  } catch (error) {
    connectError = error.message
  }
  check('找不到客户端时 startConnect 报原因', Boolean(connectError && connectError.includes('~/.zcode')), connectError || '(没有报错)')
  const poll = await missing.pollConnect()
  check('找不到客户端时 poll 未就绪', poll.ready === false && Boolean(poll.reason))

  // 3.4 连接的形状：本地模式没有 authUrl，但要有 local 标记让前端别开窗口
  stubFetch((url) => (url.includes('/billing/current') ? okJson({ code: 0, data: { plans } }) : errJson(400, {})))
  const started = await connector.startConnect()
  check('startConnect 本地模式：local=true、无 authUrl', started.local === true && started.authUrl === '' && started.state)
  const ready = await connector.pollConnect()
  check('pollConnect 直接就绪并带 profile', ready.ready === true && Boolean(ready.profile?.label), ready.profile?.label)
} finally {
  globalThis.fetch = realFetch
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
