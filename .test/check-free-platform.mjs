/**
 * 验证「免费池 · 平台侧」的数据层与渲染层（T2a，纯本地部分）。
 *
 * 用 MANAGE_API_HOME 指到一个临时目录，跑完删掉——
 * 绝不能碰到本机真实的 ~/.manage-api/free.json。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'manageapi-free-'))
process.env.MANAGE_API_HOME = home

const {
  listPlatforms,
  upsertPlatform,
  deletePlatform,
  listAccounts,
  addAccount,
  updateAccount,
  getActiveAccount,
  readFreeDb,
  callConnector,
  consume,
  checkin,
  listLedger,
  daysLeft,
  freeDbPath,
} = await import('../core/platforms/index.js')
const { renderFreePlatformPane } = await import('../web/free-platform.js')

const step = (n, title) => console.log(`\n[${n}] ${title}`)

try {
  // 1 ---------------------------------------------------------------------
  step(1, '空库时 listPlatforms()')
  const empty = await listPlatforms()
  assert.deepEqual(empty, [])
  console.log('   →', JSON.stringify(empty))

  // 2 ---------------------------------------------------------------------
  step(2, '建 manual 平台 + 一个账号，再读回来')
  const platform = await upsertPlatform({ connectorId: 'manual', label: '手动' })
  const account = await addAccount({
    platformId: platform.id,
    label: '主账号',
    quota: { unit: 'credit', limit: 100, used: 0, window: 'day' },
  })
  const platformsBack = await listPlatforms()
  const accountsBack = await listAccounts(platform.id)
  assert.equal(platformsBack.length, 1)
  assert.equal(accountsBack.length, 1)
  assert.equal(accountsBack[0].id, account.id)
  const active = await getActiveAccount(platform.id)
  assert.equal(active.id, account.id)
  console.log('   平台:', platform.id, platform.connectorId, platform.label)
  console.log('   账号:', account.id, account.label, '| 活跃账号:', active.id)

  // 3 ---------------------------------------------------------------------
  step(3, '设额度 → manual connector 的 quota()')
  const withQuota = await updateAccount(account.id, {
    quota: { unit: 'credit', limit: 100, used: 0, window: 'day' },
  })
  const quotaResult = await callConnector('manual', 'quota', withQuota)
  assert.equal(quotaResult.supported, true)
  assert.equal(quotaResult.value.remaining, 100)
  assert.equal(quotaResult.value.unit, 'credit')
  console.log('   →', JSON.stringify(quotaResult.value))

  // 手动连接器没实现 checkin：应当 supported:false 而不是抛异常
  const unsupported = await callConnector('manual', 'checkin', withQuota)
  assert.equal(unsupported.supported, false)
  console.log('   checkin 未实现 →', JSON.stringify(unsupported))
  const missing = await callConnector('nope', 'quota', withQuota)
  assert.equal(missing.supported, false)
  console.log('   未知连接器 →', JSON.stringify(missing))

  // 4 ---------------------------------------------------------------------
  step(4, '连续签到两次（幂等）')
  const first = await checkin(account.id, { reward: 5 })
  const second = await checkin(account.id, { reward: 5 })
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.alreadyToday, true)
  console.log('   第一次:', JSON.stringify({ ok: first.ok, alreadyToday: first.alreadyToday }))
  console.log('   第二次:', JSON.stringify({ ok: second.ok, alreadyToday: second.alreadyToday }))

  // 5 ---------------------------------------------------------------------
  step(5, 'consume 3 积分')
  const beforeUsed = (await listAccounts(platform.id))[0].quota.used
  const beforeLedger = (await listLedger({ accountId: account.id })).length
  await consume(account.id, { amount: 3, note: 'deepseek-v4.1-flash · 12.4k tokens' })
  const afterUsed = (await listAccounts(platform.id))[0].quota.used
  const afterLedger = await listLedger({ accountId: account.id })
  assert.equal(beforeUsed, 0)
  assert.equal(afterUsed, 3)
  assert.equal(afterLedger.length, beforeLedger + 1)
  console.log(`   used: ${beforeUsed} → ${afterUsed} | 账本条数: ${beforeLedger} → ${afterLedger.length}`)
  console.log('   最新一条:', JSON.stringify(afterLedger[0]))

  // 6 ---------------------------------------------------------------------
  step(6, 'daysLeft()')
  const left = await daysLeft(account.id)
  assert.ok(left === null || typeof left === 'number')
  console.log('   →', left, '(剩余 97 积分 ÷ 3/7 日均)')

  // 渲染层跑一遍，确保不抛异常且关键动作都在（不传 esc/t，走模块自带的兜底）
  // 「已连接」现在由服务端在 freePool 里算好（需要登录的平台看有没有 token），
  // 这里补上这个字段，模拟服务端组装后的数据。
  const html = renderFreePlatformPane({
    platforms: (await listPlatforms()).map((p) => ({ ...p, connected: true })),
    accounts: await listAccounts(),
  })
  assert.ok(html.includes('data-act="platform-checkin"'))
  assert.ok(html.includes('data-act="platform-refresh"'))
  assert.ok(html.includes('今日已用 3/100 积分'))
  console.log('   渲染层输出长度:', html.length, '字符，含签到/刷新/额度文案')

  const snapshot = await readFreeDb()
  console.log('   free.json 快照:', JSON.stringify({
    version: snapshot.version,
    platforms: snapshot.platforms.length,
    accounts: snapshot.accounts.length,
    activeAccount: snapshot.activeAccount,
    ledger: snapshot.ledger.length,
  }))

  // 7 ---------------------------------------------------------------------
  step(7, '删平台 → 账号与账本级联消失')
  const removed = await deletePlatform(platform.id)
  assert.equal((await listPlatforms()).length, 0)
  assert.equal((await listAccounts()).length, 0)
  assert.equal((await listLedger()).length, 0)
  const finalDb = JSON.parse(await readFile(freeDbPath(), 'utf8'))
  assert.deepEqual(finalDb.accounts, [])
  assert.deepEqual(finalDb.ledger, [])
  assert.deepEqual(finalDb.activeAccount, {})
  console.log('   →', JSON.stringify(removed))
  console.log('   剩余 platforms/accounts/ledger:',
    finalDb.platforms.length, finalDb.accounts.length, finalDb.ledger.length)

  console.log('\n全部 7 步通过')
} finally {
  await rm(home, { recursive: true, force: true })
}
