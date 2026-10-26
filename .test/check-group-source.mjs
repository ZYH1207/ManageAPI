/**
 * 分组归属来源自检（纯核心层，不联网）：
 *   manual（用户手选）优先于 auto（后台识别），auto 不覆盖 manual。
 *
 * 用法：node .test/check-group-source.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'mapi-groupsrc-'))
process.env.MANAGE_API_HOME = home

const inv = await import('../core/inventory.js')

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

try {
  const provider = await inv.createProvider({ name: '分组来源验证站', baseUrl: 'http://127.0.0.1:5199/v1' })
  const cred = await inv.createCredential({ providerId: provider.id, label: 'k1', secret: 'sk-1' })

  console.log('[1] 用户手选 → manual')
  await inv.updateCredential(cred.id, { group: 'Pro 号池', groupSource: 'manual' })
  let after = (await inv.listCredentials?.(provider.id)) || null
  // listCredentials 不存在就读取 db
  const store = await import('../core/store.js')
  const db1 = await store.readDb()
  const c1 = db1.credentials.find((c) => c.id === cred.id)
  ok(c1.group === 'Pro 号池' && c1.groupSource === 'manual', '手选分组记为 manual')

  console.log('[2] 后台识别（auto）不覆盖手选')
  await inv.updateCredential(cred.id, { group: '默认分组', groupSource: 'auto' })
  const db2 = await store.readDb()
  const c2 = db2.credentials.find((c) => c.id === cred.id)
  ok(c2.group === 'Pro 号池' && c2.groupSource === 'manual', 'auto 被拒绝，保留手选分组')

  console.log('[3] 用户再改也可以（manual 覆盖 manual）')
  await inv.updateCredential(cred.id, { group: '特惠池', groupSource: 'manual' })
  const db3 = await store.readDb()
  ok(db3.credentials.find((c) => c.id === cred.id).group === '特惠池', '手选可以改手选')

  console.log('[4] 从未手选过的 Key：auto 正常写入')
  const cred2 = await inv.createCredential({ providerId: provider.id, label: 'k2', secret: 'sk-2' })
  await inv.updateCredential(cred2.id, { group: '免费池', groupSource: 'auto' })
  const db4 = await store.readDb()
  const c4 = db4.credentials.find((c) => c.id === cred2.id)
  ok(c4.group === '免费池' && c4.groupSource === 'auto', '未手选的 Key 接受自动分组')

  console.log('')
  if (failed === 0) console.log('全部通过 ✓')
  else {
    console.error(`${failed} 项失败`)
    process.exitCode = 1
  }
} finally {
  await rm(home, { recursive: true, force: true }).catch(() => {})
}
