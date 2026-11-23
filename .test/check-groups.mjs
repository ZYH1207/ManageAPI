/**
 * 分组逻辑：单一真源在 Key 上，行上的 group 只是落价快照。
 *
 * 覆盖四条以前真出过的坑（用户库里都能找到实锤）：
 *   1. 同一模型大小写不同被当成两条（智惠 qwen3.8-max / Qwen3.8-Max）
 *   2. 换 Key 分组不迁移旧行 → 下次同步再插一条（RapidApi auto/step-5-preview）
 *   3. 合并重复行时把「已定价」的那条删掉、留下空壳
 *   4. 预览（plan）不能改数据
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'mapi-groups-'))
process.env.MANAGE_API_HOME = home

const inv = await import('../core/inventory.js')
const store = await import('../core/store.js')

let failed = 0
function ok(cond, message) {
  if (cond) console.log('  ✓ ' + message)
  else {
    failed += 1
    console.error('  ✗ ' + message)
  }
}

const { createProvider, createCredential, syncOffers, updateCredential, rekeyCredentialOffers } = inv
const { readDb, mutate } = store
const { offerKey, planDuplicateMerges, mergeDuplicateOffers } = inv

// ------------------------------------------------------------------ 1 去重键
console.log('去重键：模型名归一化，分组名只归一空白')
ok(offerKey('国模', 'Qwen3.8-Max') === offerKey('国模', 'qwen3.8-max'), '大小写不同的模型名得到同一个键')
ok(offerKey(' 国模  GM2 ', 'x') === offerKey('国模 GM2', 'x'), '分组名内部连续空白收敛')
ok(offerKey('A', 'x') !== offerKey('a', 'x'), '分组名大小写仍是两个分组（人名/套餐名，不做猜测）')

// ------------------------------------------------------- 2 同步不再插重复行
const provider = await createProvider({ name: '测试站', baseUrl: 'http://127.0.0.1:1/v1' })
const credential = await createCredential({ providerId: provider.id, label: '主 Key', secret: 'sk-test-1', group: '国模' })

await syncOffers(provider.id, credential.id, ['Qwen3.8-Max'], '国模')
await syncOffers(provider.id, credential.id, ['qwen3.8-max'], '国模')
let db = await readDb()
ok(db.offers.length === 1, '同一个模型第二次同步不会多出一条（大小写不同也算同一个）')
ok(db.offers[0].upstreamName === 'Qwen3.8-Max', '保留第一次见到的写法，不改写上游名字')

// ------------------------------------------------------- 3 换分组迁移旧行
await updateCredential(credential.id, { group: '科学家大雄', groupSource: 'manual' })
const moved = await (async () => {
  // 用 mutate 包一层，模拟 apply-group 的动作
  return mutate((d) => rekeyCredentialOffers(d, credential.id, '科学家大雄'))
})()
db = await readDb()
ok(moved.moved === 1, '换分组时这把 Key 的行被一起迁移（返回 1 条）')
ok(db.offers[0].group === '科学家大雄', '行上的分组跟着 Key 走')

await syncOffers(provider.id, credential.id, ['qwen3.8-max', 'step-5-preview'], '科学家大雄')
db = await readDb()
ok(db.offers.length === 2, '迁移后再同步不会在旧分组下多出一条')

// ------------------------------------------------------- 4 合并重复保留定价行
// 手工造一组「同 Key 同模型」的重复：一条已定价、一条空壳、一条大小写变体
const extra = await createProvider({ name: '重复站', baseUrl: 'http://127.0.0.1:2/v1' })
const extraKey = await createCredential({ providerId: extra.id, label: '主 Key', secret: 'sk-test-2', group: 'GM2' })
await syncOffers(extra.id, extraKey.id, ['deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash'], 'GM2')
db = await readDb()
ok(db.offers.filter((o) => o.providerId === extra.id).length === 1, '同一批里出现两个大小写变体也只建一条')

// 直接造两条真正重复的行（绕过同步），验证合并逻辑
await mutate((d) => {
  const row = d.offers.find((o) => o.providerId === extra.id)
  const priced = { ...row, id: inv.newId('o'), upstreamName: 'DeepSeek-V4.1-Flash', inPrice: 0.9, outPrice: 3.6 }
  const shell = { ...row, id: inv.newId('o'), upstreamName: 'deepseek-v4.1-flash', inPrice: null, outPrice: null }
  d.offers = d.offers.filter((o) => o.providerId !== extra.id)
  d.offers.push(shell, priced)
})
db = await readDb()
const before = db.offers.filter((o) => o.providerId === extra.id)
ok(before.length === 2, '构造出两条重复行')

const plan = planDuplicateMerges(db)
ok(plan.merged.length === 1, '预览认出 1 组重复')
ok(plan.drop.size === 1, '预览要删 1 条')
const afterPlan = (await readDb()).offers.filter((o) => o.providerId === extra.id)
ok(afterPlan.length === 2, '预览不改数据（dry-run）')

const merged = await (async () => mutate((d) => mergeDuplicateOffers(d)))()
db = await readDb()
const kept = db.offers.filter((o) => o.providerId === extra.id)
ok(merged.droppedCount === 1, '合并删掉 1 条')
ok(kept.length === 1, '合并后只剩一条')
ok(kept[0].inPrice === 0.9 && kept[0].outPrice === 3.6, '留下的是有价格的那条，不是空壳')

// ------------------------------------------------------- 5 无 Key 的行不算错
await mutate((d) => {
  d.offers.push({
    id: inv.newId('o'),
    providerId: extra.id,
    credentialId: null,
    upstreamName: 'orphan-model',
    modelKey: 'orphan-model',
    group: '',
    inPrice: null,
    outPrice: null,
    ratio: null,
    siteRatio: null,
    ratioSource: null,
    pricingMode: 'manual',
    benchmarkKey: null,
    currency: 'USD',
    currencySource: 'site',
    priceUnit: 'per_mtok',
    listedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
})
db = await readDb()
const plan2 = planDuplicateMerges(db)
ok(plan2.drop.size === 0, '没有 Key 的孤立行不参与合并（避免误删）')

await rm(home, { recursive: true, force: true })
if (failed > 0) {
  console.error(failed + ' 项失败')
  process.exit(1)
}
console.log('全部通过')