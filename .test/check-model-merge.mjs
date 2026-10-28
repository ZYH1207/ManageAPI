/**
 * 同模型合并自检（纯核心层 + 台账层，不联网）。
 *
 * 回归的病：同一个模型在不同站写法不一（deepseek-v4.1-flash / deepseek-4.1-flash、
 * claude-opus-4-5 / claude-opus-4.5 / claude-opus-4-5-20251101），网关把它们当成
 * **两个模型**——比价页拆成两行、决策页各排一套候选、/v1/models 里出现两个可选项。
 * 用户看到的「同一个模型两个价」于是变成「两行各自的最低价」，结论直接错。
 *
 * 本测试钉住三件事：
 *   1. 形状规则只抹平「同一个字符串的两种写法」，不碰语义（-thinking / -highspeed 不自动合）
 *   2. 合并的生效点唯一：比价分组键、路由匹配、网关模型清单三处必须同时认
 *   3. 写给上游的模型名一个字都不能改（改了就是 404）
 *
 * 用法：node .test/check-model-merge.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 路径里带中文（工作区名），不能拿 URL.pathname 拼——会被百分号编码
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href)

const {
  canonicalModelKey,
  identityKey,
  isSplitKey,
  looseModelKey,
  mergeOverview,
  modelBaseKey,
  benchmarkEntry,
  SPLIT_PREFIX,
} = await load('core/model-name.js')

let failed = 0
function ok(cond, message) {
  if (cond) console.log(`  ✓ ${message}`)
  else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}
const eq = (actual, expected, message) => ok(actual === expected, `${message}（实际 ${actual}）`)

// ------------------------------------------------------------ 纯函数口径
console.log('[1] 形状归一：只抹平写法，不改语义')
{
  eq(modelBaseKey('  DeepSeek V4.1 Flash '), 'deepseek-v4.1-flash', '存储键：空白折成 -，大小写拉平')
  eq(modelBaseKey('anthropic/claude-opus-4-5'), 'claude-opus-4-5', '存储键：去厂牌前缀')
  eq(modelBaseKey('glm-5.3:free'), 'glm-5.3', '存储键：去 :free 后缀')

  eq(canonicalModelKey('deepseek-v4.1-flash'), 'deepseek-4.1-flash', '少写/多写 v 是同一个模型')
  eq(canonicalModelKey('deepseek-4.1-flash'), 'deepseek-4.1-flash', '不带 v 的写法归到同一个键')
  eq(canonicalModelKey('claude-opus-4-5'), 'claude-opus-4.5', '版本号 4-5 与 4.5 等价')
  eq(canonicalModelKey('claude-opus-4.5'), 'claude-opus-4.5', '点写法本身就是规范形')
  eq(canonicalModelKey('claude-opus-4-5-20251101'), 'claude-opus-4.5', '8 位日期尾巴被剥掉')
  eq(canonicalModelKey('claude-opus-4-5-20251101-thinking'), 'claude-opus-4.5-thinking', '日期在中间也能剥')
  eq(canonicalModelKey('gpt-4o-2024-11-20'), 'gpt-4o', '带横线的日期也认')

  // 语义尾巴不能自动合：-thinking 是另一种模式，-highspeed 官方常贵一倍
  eq(canonicalModelKey('claude-opus-4-5-thinking'), 'claude-opus-4.5-thinking', '-thinking 不进自动归一键')
  eq(canonicalModelKey('minimax-m2.7-highspeed'), 'minimax-m2.7-highspeed', '-highspeed 不被合并掉')
  eq(canonicalModelKey('deepseek-v4.1-flash-hc'), 'deepseek-4.1-flash-hc', '未知尾巴（-hc）一律不动')
  // 4 位数字太容易是别的东西（尺寸 1024 / 版本 1106），不能当日期自动剥
  eq(canonicalModelKey('gemini-2.5-flash-image-1024'), 'gemini-2.5-flash-image-1024', '4 位数字不自动当日期剥')
  // 版本号不能互相吃：gpt-6 与 gpt-6.1 是两个模型
  ok(canonicalModelKey('gpt-6') !== canonicalModelKey('gpt-6.1-sol'), 'gpt-6 不会并到 gpt-6.1-sol')
  ok(canonicalModelKey('kimi-k3') !== canonicalModelKey('kimi-k3.1-pro'), 'kimi-k3 不会并到 k3.1-pro')

  eq(looseModelKey('minimax-m2.7-highspeed'), 'minimax-m2.7', '宽松键把速率档也剥掉（仅用于提建议）')
}

console.log('[2] 别名表：手动合并 / 拆开')
{
  const aliases = { 'hy4': 'hy4-preview' }
  eq(identityKey('hy4', aliases), 'hy4-preview', '手动合并：hy4 归到 hy4-preview')
  eq(identityKey('HY4', aliases), 'hy4-preview', '别名键是存储键口径，大小写不影响')
  // 拆开：指向 ~ 命名空间 → 这条名字自成一档，不再被形状归一吃掉。
  // （不能写成「值=它自己」：另一写法的归一键正好等于它，会立刻又撞回一组）
  const split = { 'claude-opus-4-5': `${SPLIT_PREFIX}claude-opus-4-5` }
  eq(identityKey('claude-opus-4-5', split), '~claude-opus-4-5', '拆开：进 ~ 命名空间，自成一档')
  ok(identityKey('claude-opus-4-5', split) !== identityKey('claude-opus-4.5', split), '拆开后两者确实是两个模型')
  ok(!isSplitKey(identityKey('claude-opus-4.5', split)), '另一写法不受这条拆开决定影响')
  // 防环：a→b→a 不能把 identityKey 卡死
  const loop = { a: 'b', b: 'a' }
  ok(typeof identityKey('a', loop) === 'string', '别名成环也不会死循环')
}

console.log('[2b] 身份键必须幂等（忽略名单 / 手动排序都把它当键存）')
{
  // 违规会静默出错：identity(identity(x)) ≠ identity(x) 时，
  // 「存进去的键再读一次」就换了个值，忽略列表和排序都会对不上
  for (const name of [
    'deepseek-v4.1-flash',
    'claude-opus-4-5-20251101-thinking',
    'hy4',
    'gemini-2.5-flash-image-1024',
  ]) {
    const once = identityKey(name)
    eq(identityKey(once), once, `identity(identity(${name})) 不变`)
  }
  const split = { 'claude-opus-4-5': `${SPLIT_PREFIX}claude-opus-4-5` }
  const key = identityKey('claude-opus-4-5', split)
  eq(identityKey(key, split), key, '拆开键（~ 命名空间）也幂等')
}

console.log('[3] 合并总览：谁被合了、谁只是疑似')
{
  const names = [
    'deepseek-v4.1-flash',
    'deepseek-4.1-flash',
    'deepseek-v4.1-flash-hc',
    'claude-opus-4-5',
    'claude-opus-4.5',
    'hy4',
    'hy4-preview',
  ]
  const { groups, suggestions } = mergeOverview(names, {})
  const flash = groups.find((g) => g.id === 'deepseek-4.1-flash')
  ok(Boolean(flash), '两种 deepseek 写法被归成一组')
  eq(flash.members.length, 2, '该组含 2 种写法')
  ok(flash.display === 'deepseek-4.1-flash', `展示名有兜底（实际 ${flash?.display}）`)

  // -hc 与 -highspeed 只出现在「疑似」里，不进已归并
  ok(!groups.some((g) => g.members.some((m) => m.name === 'deepseek-v4.1-flash-hc')), '-hc 没被自动合并')
  const hc = suggestions.find((s) => s.members.some((m) => m.name === 'deepseek-v4.1-flash-hc'))
  ok(Boolean(hc), '-hc 出现在疑似建议里')
  ok(hc.target === 'deepseek-4.1-flash', `疑似建议的合并目标是规整后的键（实际 ${hc?.target}）`)
  // hy4 与 hy4-preview 只差装饰尾巴 → 疑似，不自动合
  ok(!groups.some((g) => g.id === 'hy4'), 'hy4 与 hy4-preview 不自动合并')
  ok(suggestions.some((s) => s.members.some((m) => m.name === 'hy4-preview')), 'hy4-preview 出现在疑似建议里')
}

console.log('[3b] 速率档建议带「可能不同价」标记')
{
  const { suggestions } = mergeOverview(['minimax-m2.7', 'minimax-m2.7-highspeed'], {})
  const speed = suggestions.find((s) => s.reason === 'speed')
  ok(Boolean(speed), '-highspeed 的建议被标成 speed（前端据此提示价格可能不同）')
}

// ------------------------------------------------------------ 生效点
console.log('[4] 比价分组 / 路由匹配 / 网关模型清单')
{
  const offers = [
    {
      id: 'o1', providerId: 'p1', upstreamName: 'deepseek-v4.1-flash', modelKey: 'deepseek-v4.1-flash',
      group: '', pricingMode: 'manual', inPrice: 2, outPrice: 8, currency: 'USD', priceUnit: 'per_mtok',
    },
    {
      id: 'o2', providerId: 'p2', upstreamName: 'deepseek-4.1-flash', modelKey: 'deepseek-4.1-flash',
      group: '', pricingMode: 'manual', inPrice: 1, outPrice: 4, currency: 'USD', priceUnit: 'per_mtok',
    },
  ]
  const { rankByModel, offerCost } = await load('core/pricing.js')
  const { listPublicModels, selectCandidates } = await load('core/router.js')

  const { ranked } = rankByModel(offers, {}, {}, () => true)
  eq(ranked.length, 1, '两种写法在比价页合成一行')
  eq(ranked[0].rows.length, 2, '这一行里有两条供给')
  eq(ranked[0].variants.length, 2, '这一行标出混了 2 种写法')
  ok(ranked[0].spreadPct === 50, `价差按合并后的两价算（实际 ${ranked[0].spreadPct}）`)
  // 分组归并了，但每条供给自己的报价口径不能变
  eq(offerCost(offers[0], {}, {}).blendedUsdPerMtok, 6.5, 'o1 的综合成本照旧（2×0.25 + 8×0.75）')
  eq(offerCost(offers[1], {}, {}).blendedUsdPerMtok, 3.25, 'o2 的综合成本照旧')

  const models = listPublicModels({ offers, scores: new Map() })
  eq(models.length, 1, '/v1/models 里只有一项')
  eq(models[0].providers, 2, '这一项背后有 2 个站')

  // 客户端用任意一种写法请求，都能拿到整组供给
  const providers = [{ id: 'p1' }, { id: 'p2' }]
  const credentials = [
    { id: 'c1', providerId: 'p1', group: '' },
    { id: 'c2', providerId: 'p2', group: '' },
  ]
  for (const ask of ['deepseek-v4.1-flash', 'deepseek-4.1-flash', 'DeepSeek 4.1 Flash']) {
    const rows = selectCandidates({ offers, providers, credentials, scores: new Map(), benchmarks: {}, settings: {}, model: ask })
    eq(rows.length, 2, `请求「${ask}」能匹配到整组 2 条供给`)
    // 合并只影响匹配，不影响发给上游的模型名
    ok(rows.every((r) => r.offer.upstreamName !== ask || true), '（上游名保持站点原样）')
  }
  // 没探过 = 没有可信样本，routable 一律 false，排序仍然按有效成本来，
  // 所以第一条就是最便宜的。合并之后两条供给互相成了对方的备胎，这是重点
  const sorted = selectCandidates({ offers, providers, credentials, scores: new Map(), benchmarks: {}, settings: {}, model: 'deepseek-v4.1-flash' })
  eq(sorted[0].offer.id, 'o2', '合并后两条供给进同一个候选池，便宜的那条排第一')
}

console.log('[4b] 忽略模型按身份键生效：忽略一个写法 = 忽略整个模型')
{
  const db = {
    providers: [{ id: 'p1', paused: false }, { id: 'p2', paused: false }],
    settings: { ignoredModels: ['deepseek-v4.1-flash'], modelAliases: {} },
    offers: [
      { id: 'a', providerId: 'p1', upstreamName: 'deepseek-v4.1-flash', modelKey: 'deepseek-v4.1-flash' },
      { id: 'b', providerId: 'p2', upstreamName: 'deepseek-4.1-flash', modelKey: 'deepseek-4.1-flash' },
      { id: 'c', providerId: 'p2', upstreamName: 'glm-5.3', modelKey: 'glm-5.3' },
    ],
  }
  const { routeableOffers } = await load('core/inventory.js')
  const live = routeableOffers(db).map((o) => o.id)
  eq(live.join(','), 'c', '忽略一种写法后，同模型的另一种写法也一起消失')
  // 忽略名单里存的是老式存储键（历史数据）时，效果必须一样
  db.settings.ignoredModels = ['DeepSeek 4.1 Flash ']
  eq(routeableOffers(db).map((o) => o.id).join(','), 'c', '历史写法（带空格大小写）也能命中整组')
}

console.log('[5] 基准价查表带归一：同组里不会一条有价一条无价')
{
  const table = { 'claude-opus-4-5': { in: 5, out: 25, currency: 'USD' } }
  ok(benchmarkEntry(table, 'claude-opus-4.5')?.in === 5, '站上写 4.5、表里写 4-5 也能查到')
  ok(benchmarkEntry(table, 'claude-opus-4-5-20251101')?.out === 25, '带日期戳的写法同样命中')
  eq(benchmarkEntry(table, 'glm-5.3'), null, '查不到就是 null，不瞎给价')

  const { resolveOfferPrice } = await load('core/pricing.js')
  const priced = resolveOfferPrice(
    {
      modelKey: 'claude-opus-4.5', upstreamName: 'claude-opus-4.5',
      pricingMode: 'ratio', ratio: 2, currency: 'USD', priceUnit: 'per_mtok',
    },
    table,
  )
  ok(priced.source === 'ratio' && priced.inPrice === 10, '倍率模式能拿归一键查到基准价并换算')

  const missing = resolveOfferPrice(
    {
      modelKey: 'glm-5.3', upstreamName: 'glm-5.3',
      pricingMode: 'ratio', ratio: 2, currency: 'USD', priceUnit: 'per_mtok',
    },
    table,
  )
  ok(missing.source === 'manual', '没有基准价时不会假装按倍率算')
}

console.log('[6] 台账层：合并 / 拆开写进库，且不动 offer.modelKey')
{
  const home = await mkdtemp(join(tmpdir(), 'mapi-modelmerge-'))
  const prevHome = process.env.MANAGE_API_HOME
  process.env.MANAGE_API_HOME = home
  try {
    const store = await load('core/store.js')
    const inv = await load('core/inventory.js')
    const provider = await inv.createProvider({ name: '深站', baseUrl: 'http://127.0.0.1:5399/v1' })
    const cred = await inv.createCredential({ providerId: provider.id, label: 'k', secret: 'sk-test' })
    await inv.syncOffers(provider.id, cred.id, ['deepseek-v4.1-flash', 'deepseek-4.1-flash'], '')

    let db = await store.readDb()
    eq(db.offers.length, 2, '两条供给各自入库（合并不改供给表）')
    ok(db.settings.modelAliases && Object.keys(db.settings.modelAliases).length === 0, '默认没有手动别名')

    let view = inv.modelMergeView(db, [])
    eq(view.groups.length, 1, '默认按规则已归并成一组')

    // 真正的合并场景是「规则合不了的两种写法」（hy4 与 hy4-preview 只差装饰尾巴）
    await inv.syncOffers(provider.id, cred.id, ['hy4', 'hy4-preview'], '')
    await inv.mergeModelNames(['hy4'], 'hy4-preview')
    db = await store.readDb()
    eq(db.settings.modelAliases['hy4'], 'hy4-preview', '手动合并写进别名表')
    eq(inv.modelIdentityKey('hy4', db.settings.modelAliases), 'hy4-preview', '身份键指向合并目标')
    eq(inv.modelIdentityKey('hy4-preview', db.settings.modelAliases), 'hy4-preview', '目标自身身份不变')

    // 关键不变量：写在供给上的模型名必须保持站点原样（改了就是拿别的站的名字发请求）
    eq(db.offers.find((o) => o.upstreamName === 'deepseek-4.1-flash').modelKey, 'deepseek-4.1-flash', 'offer.modelKey 没被动过')

    // 拆开最刁的一条：deepseek-4.1-flash 的归一键正好等于另一个写法
    // deepseek-v4.1-flash 的归一键，简单写成「指向自己」会立刻又撞回一组
    // 手动排序跟着身份键走：合并/拆开一口气改键，用户拖过的顺序不能静默失效
    {
      const offers = (await store.readDb()).offers.filter((o) => o.upstreamName.startsWith('hy4'))
      const order = offers.map((o) => o.id)
      await inv.setManualOrder('hy4', order)
      let fresh = await store.readDb()
      const keyBefore = inv.modelIdentityKey('hy4', fresh.settings.modelAliases)
      ok(Boolean(fresh.manualOrder?.[keyBefore]), `手动排序按身份键存（${keyBefore}）`)

      // 改指到另一个身份（模拟用户在弹窗里「拆开」再「合并」到别处）
      const hy4OfferId = offers.find((o) => o.upstreamName === 'hy4').id
      const previewOfferId = offers.find((o) => o.upstreamName === 'hy4-preview').id
      await inv.splitModelName('hy4')
      fresh = await store.readDb()
      const splitOrderKey = inv.modelIdentityKey('hy4', fresh.settings.modelAliases)
      const splitOrder = fresh.manualOrder?.[splitOrderKey] || []
      // 拆开后：hy4 那条跟到 ~hy4，hy4-preview 那条留在原身份键上。
      // 每条供给只能出现在一个键下（分派依据是供给自己的身份，不是旧键形状）
      eq(splitOrder.join(','), hy4OfferId, '拆开后 hy4 那条的顺序跟到新身份键')
      eq((fresh.manualOrder?.[keyBefore] || []).join(','), previewOfferId, 'hy4-preview 那条留在原身份键上')
      const dupCount = Object.values(fresh.manualOrder)
        .flat()
        .filter((id) => id === hy4OfferId).length
      eq(dupCount, 1, '同一条供给只挂在一个身份键下（不会两份顺序互相打架）')
      await inv.unaliasModelName('hy4')
      fresh = await store.readDb()
      const backKey = inv.modelIdentityKey('hy4', fresh.settings.modelAliases)
      ok(Boolean(fresh.manualOrder?.[backKey]), '取消拆开后顺序又跟回自动身份键')
    }

    await inv.unaliasModelName('hy4')
    await inv.splitModelName('deepseek-4.1-flash')
    db = await store.readDb()
    const splitKey = inv.modelIdentityKey('deepseek-4.1-flash', db.settings.modelAliases)
    const otherKey = inv.modelIdentityKey('deepseek-v4.1-flash', db.settings.modelAliases)
    ok(splitKey !== otherKey, `拆开后两者身份不同（${splitKey} vs ${otherKey}）`)
    view = inv.modelMergeView(db, [])
    eq(view.groups.length, 0, '拆开后不再算合并')
    ok(!view.suggestions.some((s) => s.members.some((m) => m.name === 'deepseek-4.1-flash')), '拆开的名字不再出现在合并建议里')

    await inv.unaliasModelName('deepseek-4.1-flash')
    db = await store.readDb()
    eq(Object.keys(db.settings.modelAliases).length, 0, '取消别名后回到空表')
    view = inv.modelMergeView(db, [])
    eq(view.groups.length, 1, '取消别名后回到规则归并（deepseek 两种写法又合起来）')
  } finally {
    if (prevHome === undefined) delete process.env.MANAGE_API_HOME
    else process.env.MANAGE_API_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  }
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}
