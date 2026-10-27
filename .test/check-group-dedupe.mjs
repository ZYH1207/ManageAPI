/**
 * 分组名归一化自检（纯函数，不联网）：
 *   1. normalizeGroup 去掉首尾空白、收敛内部连续空格
 *   2. 带尾随空格的分组反复同步，不会新增重复行
 *   3. 两把同组 Key 共用同一分组时不会互相吞行
 *
 * 用法：node .test/check-group-dedupe.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import core 之前设好数据目录：store 在模块加载时读它
const home = await mkdtemp(join(tmpdir(), 'mapi-groupdedupe-'))
process.env.MANAGE_API_HOME = home

const { normalizeGroup, syncOffers, createProvider, createCredential, updateCredential } = await import(
  '../core/inventory.js'
)
const { readDb } = await import('../core/store.js')

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

console.log('[1] normalizeGroup')
{
  ok(normalizeGroup('国模-0045 p哥 ') === '国模-0045 p哥', '去掉尾随空格')
  ok(normalizeGroup('  前导') === '前导', '去掉前导空格')
  ok(normalizeGroup('a   b') === 'a b', '内部连续空格收敛成一个')
  ok(normalizeGroup(null) === '', 'null → 空串')
  ok(normalizeGroup(undefined) === '', 'undefined → 空串')
  ok(normalizeGroup('正常分组') === '正常分组', '无空格时原样返回')
}

console.log('[2] 尾随空格的分组：反复同步不新增行')
{
  const provider = await createProvider({ name: '测试站', baseUrl: 'https://example.test/v1' })
  const credential = await createCredential({ providerId: provider.id, label: 'K1', secret: 'sk-test-1' })

  const models = ['model-a', 'model-b']
  // 第一次：分组名带尾随空格
  await syncOffers(provider.id, credential.id, models, '国模-0045 p哥 ')
  let db = await readDb()
  const count1 = db.offers.filter((o) => o.providerId === provider.id).length

  // 第二次、第三次：同一个分组，空格情况不同
  await syncOffers(provider.id, credential.id, models, '国模-0045 p哥')
  await syncOffers(provider.id, credential.id, models, '国模-0045 p哥  ')
  db = await readDb()
  const count2 = db.offers.filter((o) => o.providerId === provider.id).length

  ok(count1 === 2, `首轮插入 2 行（实际 ${count1}）`)
  ok(count2 === 2, `后续两轮同步没有新增（实际 ${count2}）`)
  const groups = new Set(db.offers.filter((o) => o.providerId === provider.id).map((o) => o.group))
  ok(groups.size === 1, `分组名统一成一个（实际 ${[...groups].map((g) => JSON.stringify(g)).join(', ')}）`)
}

console.log('[3] 不同分组仍是不同行')
{
  const db = await readDb()
  const provider = db.providers.find((p) => p.name === '测试站')
  const credential = db.credentials.find((c) => c.providerId === provider.id)
  await syncOffers(provider.id, credential.id, ['model-a'], '另一个分组')
  const after = await readDb()
  const rows = after.offers.filter((o) => o.providerId === provider.id && o.upstreamName === 'model-a')
  ok(rows.length === 2, `同名模型在不同分组各一行（实际 ${rows.length}）`)
}

console.log('[4] credential.group 归一化')
{
  const db = await readDb()
  const provider = db.providers.find((p) => p.name === '测试站')
  const credential = db.credentials.find((c) => c.providerId === provider.id)
  await updateCredential(credential.id, { group: '  带空格的分组  ', groupSource: 'manual' })
  const after = await readDb()
  const updated = after.credentials.find((c) => c.id === credential.id)
  ok(updated.group === '带空格的分组', `写入时归一化（实际 ${JSON.stringify(updated.group)}）`)
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}

await rm(home, { recursive: true, force: true })

