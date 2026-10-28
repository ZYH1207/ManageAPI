/**
 * 后台拉取密钥自检（纯核心层，不联网）：
 *   只补缺、不动已有；掩码/残值/空值不导入；新 Key 记 auto 分组；重跑幂等。
 *
 * 用法：node .test/check-pull-keys.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'mapi-pullkeys-'))
process.env.MANAGE_API_HOME = home

const inv = await import('../core/inventory.js')
const store = await import('../core/store.js')

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

try {
  const provider = await inv.createProvider({ name: '拉密钥验证站', baseUrl: 'http://127.0.0.1:5199/v1' })
  const existing = await inv.createCredential({ providerId: provider.id, label: 'k1', secret: 'sk-existing-key-123456' })

  console.log('[1] 新 Key 导入，已有/掩码/残值/空值全跳过')
  const items = [
    { name: '新令牌', key: 'sk-fresh-key-987654321', group: '默认分组' },
    // 无 sk- 前缀，剥掉后应认出和本地是同一把
    { name: '已有令牌', key: 'existing-key-123456', group: '别的分组' },
    { name: '掩码令牌', key: 'sk-***abc123', group: 'x' },
    { name: '空值', key: '' },
    { name: '残值', key: 'sk-abc' },
  ]
  const ids = await inv.importMissingCredentials(provider.id, items)
  ok(ids.length === 1, `只导入 1 把（实际 ${ids.length}）`)
  let db = await store.readDb()
  let creds = db.credentials.filter((c) => c.providerId === provider.id)
  ok(creds.length === 2, `本地共 2 把凭据（实际 ${creds.length}）`)
  const fresh = creds.find((c) => ids.includes(c.id))
  ok(!!fresh, '能找到新导入的凭据')
  ok(fresh?.label === '新令牌', 'label 用令牌名')
  ok(fresh?.group === '默认分组' && fresh?.groupSource === 'auto', '分组用令牌自带的，记 auto')
  const kept = db.credentials.find((c) => c.id === existing.id)
  ok(!kept.group && !kept.groupSource, '已有凭据的分组没被动')

  console.log('[2] 无前缀同尾号：认出同一把，不重复导入')
  // 尾号唯一时按尾号认（和 detect-groups 的 matchTokenBySecret 同一口径）
  const ids2 = await inv.importMissingCredentials(provider.id, [
    { name: '同尾令牌', key: 'zzzzzz123456', group: 'y' },
  ])
  ok(ids2.length === 0, `不导入（实际 ${ids2.length}）`)

  console.log('[3] 重跑幂等：同一份列表再拉一遍，不再新增')
  const ids3 = await inv.importMissingCredentials(provider.id, items)
  ok(ids3.length === 0, `不导入（实际 ${ids3.length}）`)
  db = await store.readDb()
  ok(db.credentials.filter((c) => c.providerId === provider.id).length === 2, '凭据总数不变')

  console.log('')
  if (failed === 0) console.log('全部通过 ✓')
  else {
    console.error(`${failed} 项失败`)
    process.exitCode = 1
  }
} finally {
  await rm(home, { recursive: true, force: true }).catch(() => {})
}
