/**
 * 分组名归一化 + 重复供给收敛自检（纯核心层，不联网）。
 *
 * 回归的病：写 offer 时分组名没归一化（detect-groups 把令牌列表原样写下去，
 * 带尾随空格），而 syncOffers 用 trim 过的名字当去重键——两边口径不同，
 * 每轮「同步 + 识别分组」都匹配不上旧行，于是再插一整套。实测一个模型积到 7 份。
 *
 * 用法：node .test/check-group-dedupe.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'mapi-groupdedupe-'))
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

const models = ['deepseek-v4.1-flash', 'kimi-k3']

try {
  console.log('[1] normalizeGroup 口径')
  ok(inv.normalizeGroup('国模-0045 p哥 ') === '国模-0045 p哥', '尾随空格被去掉')
  ok(inv.normalizeGroup('  a   b  ') === 'a b', '连续空白收敛成一个')
  ok(inv.normalizeGroup(null) === '', 'null → 空串')
  ok(inv.normalizeGroup(undefined) === '', 'undefined → 空串')
  ok(inv.normalizeGroup('国模-0045 p哥') === inv.normalizeGroup('国模-0045 p哥 '), '两边等价')

  console.log('[2] 带尾随空格的分组名连同步 3 轮，行数不变')
  const provider = await inv.createProvider({ name: '空格分组站', baseUrl: 'http://127.0.0.1:5199/v1' })
  const cred = await inv.createCredential({
    providerId: provider.id,
    label: 'k1',
    secret: 'sk-1',
    group: '国模-0045 p哥 ',
  })
  for (let round = 1; round <= 3; round += 1) {
    await inv.syncOffers(provider.id, cred.id, models, '国模-0045 p哥 ')
    const db = await store.readDb()
    const rows = db.offers.filter((o) => o.providerId === provider.id)
    ok(rows.length === models.length, `第 ${round} 轮同步后仍是 ${models.length} 行（实际 ${rows.length}）`)
    ok(
      rows.every((o) => o.group === '国模-0045 p哥'),
      `第 ${round} 轮同步后分组名已归一化`,
    )
  }

  console.log('[3] 同一模型换分组另存一份是允许的（不是重复）')
  await inv.syncOffers(provider.id, cred.id, models, '特价池')
  const db3 = await store.readDb()
  const rows3 = db3.offers.filter((o) => o.providerId === provider.id)
  ok(rows3.length === models.length * 2, `两个分组共 ${models.length * 2} 行（实际 ${rows3.length}）`)

  console.log('[4] duplicateOffer 去过空格后拒绝同分组重名')
  const sample = rows3.find((o) => o.group === '国模-0045 p哥')
  let threw = false
  try {
    await inv.duplicateOffer(sample.id, { group: ' 国模-0045 p哥  ' })
  } catch {
    threw = true
  }
  ok(threw, '同分组（只差空白）重名被拒绝')

  console.log('[5] 历史重复数据：迁移按「站点+分组+模型」收敛并重挂探针')
  const dupHome = await mkdtemp(join(tmpdir(), 'mapi-groupdedupe-mig-'))
  const { writeFile } = await import('node:fs/promises')
  const now = new Date().toISOString()
  const base = {
    providerId: 'p_dup',
    credentialId: 'c_dup',
    upstreamName: 'deepseek-v4.1-flash',
    modelKey: 'deepseek-v4.1-flash',
    currency: 'USD',
    priceUnit: 'per_mtok',
    pricingMode: 'manual',
    listedAt: now,
    updatedAt: now,
  }
  const fixture = {
    version: 3,
    settings: {},
    providers: [{ id: 'p_dup', name: '重复站', baseUrl: 'http://127.0.0.1:5199/v1' }],
    credentials: [{ id: 'c_dup', providerId: 'p_dup', label: 'k', group: '国模-0045 p哥', secret: {} }],
    offers: [
      // 同一个 (站点, 分组, 模型) 三份，其中一份带尾随空格、一份有手填价
      { ...base, id: 'o_a', group: '国模-0045 p哥', inPrice: null, outPrice: null },
      { ...base, id: 'o_b', group: '国模-0045 p哥 ', inPrice: null, outPrice: null },
      { ...base, id: 'o_c', group: '国模-0045 p哥', inPrice: 0.09, outPrice: 0.36 },
      // 不同模型 / 不同分组：不能被合掉
      { ...base, id: 'o_d', group: '国模-0045 p哥', upstreamName: 'kimi-k3', modelKey: 'kimi-k3' },
      { ...base, id: 'o_e', group: '特价池', inPrice: 0.05, outPrice: 0.2 },
    ],
    probes: [
      { id: 'r1', ts: now, offerId: 'o_a', providerId: 'p_dup', ok: true },
      { id: 'r2', ts: now, offerId: 'o_b', providerId: 'p_dup', ok: true },
      { id: 'r3', ts: now, offerId: 'o_c', providerId: 'p_dup', ok: false },
    ],
    traffic: { o_a: { ok: 2, fail: 1, since: now }, o_c: { ok: 1, fail: 0, since: now } },
    manualOrder: { 'deepseek-v4.1-flash': ['o_b', 'o_c', 'o_a', 'o_e'] },
  }
  await writeFile(join(dupHome, 'db.json'), JSON.stringify(fixture, null, 2), 'utf8')
  process.env.MANAGE_API_HOME = dupHome
  const migrated = await store.readDb()
  const flash = migrated.offers.filter((o) => o.upstreamName === 'deepseek-v4.1-flash')
  ok(flash.length === 2, `同名模型只留 2 行（同分组 1 + 特价池 1），实际 ${flash.length}`)
  const kept = migrated.offers.find((o) => o.id === 'o_c')
  ok(Boolean(kept), '保留的是有手填价的那条（o_c）')
  ok(
    migrated.probes.every((r) => ['o_c', 'o_d', 'o_e'].includes(r.offerId)),
    '探针记录全部重挂到保留行，没有孤儿',
  )
  ok(
    (migrated.probes.filter((r) => r.offerId === 'o_c').length) === 3,
    '三份重复行上的探针合并到保留行（3 条）',
  )
  ok(migrated.traffic.o_c.ok === 3 && migrated.traffic.o_c.fail === 1, '流量计数累加（ok 3 / fail 1）')
  ok(!migrated.traffic.o_a, '死行的流量条目被清掉')
  const order = migrated.manualOrder['deepseek-v4.1-flash'] || []
  ok(new Set(order).size === order.length, '手动排序里没有重复 id')
  ok(order.includes('o_c') && order.includes('o_e'), '手动排序里的重复 id 已重挂到保留行')
  ok(migrated.version === 4, '版本号升到 4')
  await rm(dupHome, { recursive: true, force: true })

  console.log('')
  if (failed === 0) console.log('全部通过 ✓')
  else {
    console.error(`${failed} 项失败`)
    process.exitCode = 1
  }
} finally {
  await rm(home, { recursive: true, force: true })
}
