/**
 * 人工勾选的「解析 + 生效状态」自检（纯函数，不联网）。
 *
 * 背景（2026-11-12 两次现场）：
 *   1. 决策页勾的是秋「国模-007」，网关一直派「国模-0055」——勾选那条失败率过高
 *      被标 blocked，兜底阶梯把它当硬失败踢出链，applyPinnedChoice 找不到它。
 *      （那条修在 core/route-orchestrator.js，用例在 check-route-orchestrator.mjs）
 *   2. claude-opus-5.5 勾的是秋那条供给，但那一行被「忽略模型」整类过滤掉了；
 *      页面照样写「当前选 秋」，网关一直派 rapid，日志刷了 1665 行「未应用」。
 *
 * 本测试钉死第二类：**查勾选只有一份实现**（pinnedOfferIdOf），
 * 「勾了但派不到」必须能被说清原因（pinnedOfferStateOf）。
 *
 * 用法：node .test/check-pinned-offer.mjs
 */
import { pinnedOfferIdOf, pinnedOfferStateOf, manualOrderOf, routeableOffers } from '../core/inventory.js'

let failed = 0
function ok(cond, label, detail = '') {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failed += 1
    console.error(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

const baseProviders = [
  { id: 'p_ok', name: '好站', paused: false },
  { id: 'p_paused', name: '暂停站', paused: true },
]
const baseOffers = [
  { id: 'o_007', providerId: 'p_ok', group: '国模-007', upstreamName: 'deepseek-v4.1-flash', modelKey: 'deepseek-v4.1-flash' },
  { id: 'o_0055', providerId: 'p_ok', group: '国模-0055', upstreamName: 'deepseek-v4.1-flash', modelKey: 'deepseek-v4.1-flash' },
  { id: 'o_paused', providerId: 'p_paused', group: 'G', upstreamName: 'deepseek-v4.1-flash', modelKey: 'deepseek-v4.1-flash' },
]

/** 造一份最小 db：两个站、三条供给 */
function makeDb(overrides = {}) {
  return {
    settings: {
      modelAliases: { 'deepseek-v4.1-flash': 'deepseek-4.1-flash' },
      ignoredModels: [],
      modelOverrides: {},
      ...(overrides.settings || {}),
    },
    providers: [
      ...baseProviders.filter((p) => !(overrides.replaceProviders || []).includes(p.id)),
      ...(overrides.providers || []),
    ],
    offers: [
      ...baseOffers.filter((o) => !(overrides.replaceOffers || []).includes(o.id)),
      ...(overrides.offers || []),
    ],
    pinnedOffer: {},
    ...(overrides.pinnedOffer ? { pinnedOffer: overrides.pinnedOffer } : {}),
  }
}

console.log('[1] pinnedOfferIdOf：三种键写法都要认')
{
  ok(pinnedOfferIdOf(makeDb(), 'deepseek-4.1-flash') === null, '没勾选 → null')
  ok(pinnedOfferIdOf(makeDb({ pinnedOffer: { 'deepseek-4.1-flash': 'o_007' } }), 'deepseek-4.1-flash') === 'o_007', '身份键命中')
  // 页面以前用裸键查：请求写 deepseek-v4.1-flash 时查不到身份键那条
  ok(
    pinnedOfferIdOf(makeDb({ pinnedOffer: { 'deepseek-4.1-flash': 'o_007' } }), 'deepseek-v4.1-flash') === 'o_007',
    '换个写法（v4.1）也命中——这是页面/网关以前分叉的那条',
  )
  ok(
    pinnedOfferIdOf(makeDb({ pinnedOffer: { 'deepseek-v4.1-flash': 'o_007' } }), 'deepseek-4.1-flash') === 'o_007',
    '老库按原样名存的键也能命中',
  )
  ok(pinnedOfferIdOf(makeDb({ pinnedOffer: { 'deepseek-4.1-flash': 'o_007' } }), '  deepseek-4.1-flash  ') === 'o_007', '两端空白不影响')
  ok(pinnedOfferIdOf(makeDb({ pinnedOffer: { 'deepseek-4.1-flash': 'o_007' } }), '') === null, '空模型名 → null')
  ok(pinnedOfferIdOf({ ...makeDb(), pinnedOffer: null }, 'deepseek-4.1-flash') === null, 'pinnedOffer 缺失 → null')
  ok(pinnedOfferIdOf({ ...makeDb(), settings: { ...makeDb().settings, modelAliases: null } }, 'deepseek-4.1-flash') === null, '别名表缺失不崩')
}

console.log('\n[2] pinnedOfferStateOf：能派 / 派不到都要说清原因')
{
  const okDb = makeDb({ pinnedOffer: { 'deepseek-4.1-flash': 'o_007' } })
  const st = pinnedOfferStateOf(okDb, 'deepseek-4.1-flash')
  ok(st?.state === 'ok', `正常勾选 state=ok（实际 ${st?.state}）`)
  ok(st?.offer?.id === 'o_007', '带出供给本身，页面要能显示站名/分组')
  ok(st?.text === '', '正常时不给噪音文案')

  ok(pinnedOfferStateOf(makeDb(), 'deepseek-4.1-flash') === null, '没勾选 → null（不是 ok）')

  const missing = pinnedOfferStateOf(makeDb({ pinnedOffer: { 'deepseek-4.1-flash': 'o_ghost' } }), 'deepseek-4.1-flash')
  ok(missing?.state === 'missing', `供给被删 → missing（实际 ${missing?.state}）`)
  ok(/删除/.test(missing?.text || ''), '文案说清是删掉了')

  const delisted = pinnedOfferStateOf(
    makeDb({
      pinnedOffer: { 'deepseek-4.1-flash': 'o_007' },
      replaceOffers: ['o_007'],
      offers: [
        { id: 'o_007', providerId: 'p_ok', group: 'G', upstreamName: 'deepseek-v4.1-flash', modelKey: 'deepseek-v4.1-flash', delistedAt: '2026-11-01T00:00:00.000Z' },
      ],
    }),
    'deepseek-4.1-flash',
  )
  ok(delisted?.state === 'delisted', `已下线 → delisted（实际 ${delisted?.state}）`)

  const paused = pinnedOfferStateOf(makeDb({ pinnedOffer: { 'deepseek-4.1-flash': 'o_paused' } }), 'deepseek-4.1-flash')
  ok(paused?.state === 'paused', `站点暂停 → paused（实际 ${paused?.state}）`)
  ok(/暂停站/.test(paused?.text || ''), '文案点出是哪个站暂停了')

  // 整类被忽略，但这条正是勾选的那一条 → 勾选压过忽略，state 必须是 ok
  // （2026-11-12 用户定的语义：我单独放出来、手动勾选的，忽略模型不该挡它的流量）
  const ignoredDb = makeDb({
    pinnedOffer: { 'deepseek-4.1-flash': 'o_007' },
    settings: { ignoredModels: ['deepseek-4.1-flash'] },
  })
  const pinnedIgnored = pinnedOfferStateOf(ignoredDb, 'deepseek-4.1-flash')
  ok(pinnedIgnored?.state === 'ok', `勾选那条即使被整类忽略也算 ok（实际 ${pinnedIgnored?.state}）`)
  ok(pinnedIgnored?.text === '', '生效时不挂红标（不给噪音文案）')
  // 但同模型的**其他**供给仍然被忽略挡住——忽略名单不是失效了，只是压不过勾选
  ok(
    routeableOffers(ignoredDb).every((o) => o.id === 'o_007'),
    `同模型未被勾选的那些仍被挡掉（在役 ${routeableOffers(ignoredDb).map((o) => o.id).join(',')}）`,
  )

  // 单行例外：整类忽略但这一行被显式放开 → 仍算 ok（与 routeableOffers 同口径）
  const shownDb = makeDb({
    pinnedOffer: { 'deepseek-4.1-flash': 'o_007' },
    settings: {
      ignoredModels: ['deepseek-4.1-flash'],
      modelOverrides: { 'p_ok::国模-007::deepseek-v4.1-flash': 'shown' },
    },
  })
  ok(pinnedOfferStateOf(shownDb, 'deepseek-4.1-flash')?.state === 'ok', '单行例外放开的算 ok（作用域键生效）')

  // 勾选指向另一个模型（模型被拆开后老勾选残留）
  const otherDb = makeDb({
    pinnedOffer: { 'deepseek-4.1-flash': 'o_007' },
    settings: { modelAliases: { 'deepseek-v4.1-flash': 'deepseek-4.1-flash' } },
    replaceOffers: ['o_007'],
    offers: [
      { id: 'o_007', providerId: 'p_ok', group: 'G', upstreamName: 'glm-5.3-flash', modelKey: 'glm-5.3-flash' },
    ],
  })
  const other = pinnedOfferStateOf(otherDb, 'deepseek-4.1-flash')
  ok(other?.state === 'not-in-model', `指向别的模型 → not-in-model（实际 ${other?.state}）`)
}

console.log('\n[2b] 状态必须用「命中的那个键」去查，不能固定只查一个')
{
  // 合并组里 group.modelKey 是身份键、组内写法（upstreamName）是站点原名。
  // 勾选只挂在其中一个下面时，状态查询必须跟着命中的那个键走，
  // 否则会报 null，页面拿不到状态（静默失效）。
  const db = makeDb({
    pinnedOffer: { 'deepseek-4.1-flash': 'o_007' },
    settings: { ignoredModels: ['deepseek-4.1-flash'] },
  })
  const viaIdentity = pinnedOfferStateOf(db, 'deepseek-4.1-flash')
  const viaSpelling = pinnedOfferStateOf(db, 'deepseek-v4.1-flash')
  ok(viaIdentity?.state === 'ok', `身份键查得出 ok（实际 ${viaIdentity?.state}）`)
  ok(viaSpelling?.state === 'ok', `站点写法也查得出 ok（实际 ${viaSpelling?.state}）`)
  ok(viaIdentity?.offerId === viaSpelling?.offerId, '两种写法指向同一条供给')
}

console.log('\n[2c] 勾选压过忽略：在役判定与状态判定必须一致')
{
  // 这组是用户 2026-11-12 定下的语义，也是最容易再次分叉的地方：
  // 「我单独放出来的站点，手动勾选开启了，忽略模型不该挡它的流量」。
  const mk = (pinned, extra = {}) => ({
    settings: { modelAliases: {}, ignoredModels: ['deepseek-4.1-flash'], modelOverrides: {}, ...(extra.settings || {}) },
    providers: [{ id: 'p1', name: '站1', paused: false }, ...(extra.providers || [])],
    offers: [
      { id: 'o_pin', providerId: 'p1', group: 'G', upstreamName: 'deepseek-v4.1-flash', modelKey: 'deepseek-v4.1-flash' },
      { id: 'o_twin', providerId: 'p1', group: 'G2', upstreamName: 'deepseek-v4.1-flash', modelKey: 'deepseek-v4.1-flash' },
      { id: 'o_other', providerId: 'p1', group: 'G3', upstreamName: 'glm-5.3-flash', modelKey: 'glm-5.3-flash' },
      ...(extra.offers || []),
    ],
    pinnedOffer: pinned,
  })

  const pinnedDb = mk({ 'deepseek-4.1-flash': 'o_pin' })
  const live = routeableOffers(pinnedDb).map((o) => o.id)
  ok(live.includes('o_pin'), `勾选那条越过了忽略名单（在役 ${live.join(',')}）`)
  ok(!live.includes('o_twin'), '同模型另一条仍被忽略挡住（忽略名单没失效）')
  ok(pinnedOfferStateOf(pinnedDb, 'deepseek-4.1-flash')?.state === 'ok', '状态与在役一致：ok')

  const noPin = mk({})
  ok(!routeableOffers(noPin).some((o) => o.id.startsWith('o_pin') || o.id === 'o_twin'), '没勾选时整类仍被忽略')
  ok(pinnedOfferStateOf(noPin, 'deepseek-4.1-flash') === null, '没勾选 → 状态 null')

  // 勾的是没被忽略的模型 → 忽略名单照常挡 deepseek
  const pinOther = mk({ 'glm-5.3-flash': 'o_other' })
  const liveOther = routeableOffers(pinOther).map((o) => o.id)
  ok(liveOther.includes('o_other'), '勾选的那条在役')
  ok(!liveOther.includes('o_pin') && !liveOther.includes('o_twin'), '勾了别的模型不会顺带放开被忽略的 deepseek')

  // 站点暂停 / 已下线压过勾选：那是「这个站现在不该收流量」，与「用户想不想要它」无关
  const pausedDb = mk({ 'deepseek-4.1-flash': 'o_pin' })
  pausedDb.providers[0].paused = true
  ok(!routeableOffers(pausedDb).some((o) => o.id === 'o_pin'), '站点暂停时勾选救不回来')
  ok(pinnedOfferStateOf(pausedDb, 'deepseek-4.1-flash')?.state === 'paused', '状态报 paused')

  const delistedDb = mk({ 'deepseek-4.1-flash': 'o_pin' })
  delistedDb.offers[0].delistedAt = '2026-01-01T00:00:00.000Z'
  ok(!routeableOffers(delistedDb).some((o) => o.id === 'o_pin'), '已下线时勾选救不回来')
  ok(pinnedOfferStateOf(delistedDb, 'deepseek-4.1-flash')?.state === 'delisted', '状态报 delisted')

  // 一条勾选都没生效时，pinnedOffer 表本身不空也不该放开任何东西
  ok(routeableOffers(mk({ 'deepseek-4.1-flash': 'o_ghost' })).every((o) => o.id === 'o_other'), '勾选指向不存在的供给不放开任何东西')
}

console.log('\n[3] 与 routeableOffers 同口径：能被 routeable 留下的，state 一定是 ok')
{
  const cases = [
    makeDb({ pinnedOffer: { 'deepseek-4.1-flash': 'o_007' } }),
    makeDb({ pinnedOffer: { 'deepseek-4.1-flash': 'o_007' }, settings: { ignoredModels: ['deepseek-4.1-flash'] } }),
    makeDb({ pinnedOffer: { 'deepseek-4.1-flash': 'o_paused' } }),
  ]
  for (const [i, db] of cases.entries()) {
    const st = pinnedOfferStateOf(db, 'deepseek-4.1-flash')
    const alive = db.offers.some(
      (o) => o.id === st?.offerId && !o.delistedAt && !db.providers.find((p) => p.id === o.providerId)?.paused,
    )
    ok(st?.state === 'ok' ? alive : true, `第 ${i + 1} 份库：state=ok 时不与「不可路由」矛盾（${st?.state}）`)
  }
}

console.log('\n[4] manualOrderOf：手动拖拽顺序与勾选同一套查法')
{
  const db = {
    ...makeDb(),
    settings: { modelAliases: { 'deepseek-v4.1-flash': 'deepseek-4.1-flash' }, ignoredModels: [], modelOverrides: {} },
    manualOrder: { 'deepseek-4-pro': ['o_a', 'o_b'] },
  }
  // 现场：库里键是 deepseek-4-pro，请求/组内写法是 deepseek-v4-pro，
  // 页面第一跳（裸键）查不到，以前靠第二跳才命中
  ok(JSON.stringify(manualOrderOf(db, 'deepseek-v4-pro')) === '["o_a","o_b"]', '写法不同也命中（v4-pro → 4-pro）')
  ok(JSON.stringify(manualOrderOf(db, 'deepseek-4-pro')) === '["o_a","o_b"]', '身份键直查命中')
  ok(manualOrderOf(db, 'other-model') === null, '没拖过 → null（调用方据此跳过重排）')
  ok(manualOrderOf({ ...db, manualOrder: { 'deepseek-4-pro': [] } }, 'deepseek-4-pro') === null, '空数组算没拖过')
  ok(manualOrderOf({ ...db, manualOrder: null }, 'deepseek-4-pro') === null, 'manualOrder 缺失 → null')
  // 值与勾选共用一个查法，但类型不同：这里必须只认数组
  ok(manualOrderOf({ ...db, manualOrder: { 'deepseek-4-pro': 'o_a' } }, 'deepseek-4-pro') === null, '值不是数组 → null（不冒充顺序）')
}

console.log(`\n${failed === 0 ? '✓ 全部通过' : `✗ ${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
