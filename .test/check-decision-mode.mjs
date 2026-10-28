/**
 * 决策侧重（性价比 / 价格 / 首字速度 / 价速比）自检（纯函数，不联网）：
 *   1. 档位归一化：合法值原样返回，非法/空回落默认（性价比）
 *   2. 四档各自按什么排序：有效成本 / 名义单价 / 首字延迟 / 价速比
 *   3. 四档都只改排序，不改准入：不可登场的永远排在后面，哪怕它最快/最便宜
 *   4. 缺数据（没探过 = 首字 null）不冒充「最快」，排到最后
 *   5. 手动顺序仍然优先（用户显式指定优先于任何自动口径）
 *   6. 看板顶部那句有**自己的档位**（headlineMode），与路由档位互不干扰
 *   7. 人工勾选（决策页点选）：勾了哪条哪条就是当前选；顺序不动、准入拦不住；
 *      网关尝试链里勾选的顶到最前，真失败照样往后故障转移
 *
 * 背景：原来的「智能」只有一种价值观——有效成本最低。但便宜和好用不是一回事：
 * 一条便宜一万倍、首字却要等十几秒的供给，按有效成本永远排第一，用户根本不想用。
 *
 * 用法：node .test/check-decision-mode.mjs
 */
import {
  DECISION_MODES,
  DEFAULT_DECISION_MODE,
  decisionModeOf,
  decisionModeTable,
  describeDecisionMode,
  normalizeDecisionMode,
  tierMetricOf,
} from '../core/decision-mode.js'
import { selectCandidates, applyPinnedChoice } from '../core/router.js'
import { decisionChampion, decisionHeadline } from '../core/pricing.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

console.log('[1] 档位归一化：非法值不静默变成别的口径')
{
  ok(DEFAULT_DECISION_MODE === 'value', `默认档 ${DEFAULT_DECISION_MODE}`)
  ok(DECISION_MODES.length === 4, `四档：${DECISION_MODES.map((m) => m.key).join(' / ')}`)
  for (const key of ['value', 'price', 'speed', 'priceSpeed']) {
    ok(normalizeDecisionMode(key) === key, `合法值 ${key} 原样返回`)
  }
  for (const bad of ['', null, undefined, 'cheap', 'SPEED', 42, {}]) {
    ok(normalizeDecisionMode(bad) === 'value', `非法值 ${JSON.stringify(bad)} → 默认`)
  }
  ok(decisionModeOf('speed').label === '首字速度', `档位定义带标签：${decisionModeOf('speed').label}`)
  ok(decisionModeTable().length === 4, '给前端的四档表')
  ok(describeDecisionMode('price').includes('价格'), `一句话描述：${describeDecisionMode('price')}`)
}

// ------------------------------------------------------------ 整条链路
const providers = [{ id: 'p1', name: '甲站' }]
const credentials = [{ id: 'c1', providerId: 'p1', group: '', tail: '0000' }]
const offer = (id, cny) => ({
  id,
  providerId: 'p1',
  credentialId: 'c1',
  group: '',
  modelKey: 'm',
  upstreamName: 'm',
  pricingMode: 'manual',
  priceUnit: 'per_mtok',
  currency: 'CNY',
  inPrice: cny,
  outPrice: cny,
})
const score = (patch = {}) => ({
  samples: 5,
  trafficSamples: 0,
  status: 'healthy',
  availability: 1,
  integrity: 1,
  integrityFaults: [],
  quality: 1,
  stale: false,
  blocked: null,
  confidence: 'medium',
  ttftMs: 3000,
  ...patch,
})
const settings = (patch = {}) => ({
  fx: { base: 'USD', rates: { CNY: 7.2 } },
  fxUsdCny: 7.2,
  maxTtftMs: 0,
  allowUntrusted: false,
  decisionMode: 'value',
  ...patch,
})
const run = (spec, settingPatch = {}, order) =>
  selectCandidates({
    offers: spec.map((row) => offer(row.id, row.cny)),
    providers,
    credentials,
    scores: Object.fromEntries(spec.map((row) => [row.id, score(row.score)])),
    benchmarks: {},
    settings: settings(settingPatch),
    model: 'm',
    order,
  })
const ids = (rows) => rows.map((row) => row.offer.id).join(' > ')

// a：最便宜，但质量只有 0.85（可用率刚好过线）
// b：贵一点点，质量满分
// c：最贵，但首字最快
// d：最便宜且首字最快，但不可用（可用率 50%）
const spec = [
  { id: 'a', cny: 1.0, score: { quality: 0.85, availability: 0.85, ttftMs: 3000 } },
  { id: 'b', cny: 1.1, score: { quality: 1, availability: 1, ttftMs: 3000 } },
  { id: 'c', cny: 9.0, score: { quality: 1, availability: 1, ttftMs: 700 } },
  {
    id: 'd',
    cny: 0.5,
    score: { quality: 0.5, availability: 0.5, status: 'unstable', ttftMs: 100 },
  },
]

console.log('[2] 性价比档：按「价格 ÷ 质量」，贵一点但可信的站能顶掉便宜的')
{
  const rows = run(spec, { decisionMode: 'value' })
  ok(ids(rows) === 'b > a > c > d', `顺序 ${ids(rows)}`)
  ok(rows[0].offer.id === 'b', '质量满分的 b 顶掉名义价更低的 a')
  ok(rows.at(-1).offer.id === 'd', '不可用（可用率 50%）的 d 排最后，哪怕它最便宜也最快')
}

console.log('[3] 价格档：只比名义单价')
{
  const rows = run(spec, { decisionMode: 'price' })
  ok(ids(rows) === 'a > b > c > d', `顺序 ${ids(rows)}`)
  ok(rows[0].offer.id === 'a', '最便宜的 a 排第一（质量不参与排序）')
  ok(rows.at(-1).offer.id === 'd', 'd 仍然不登场，价格档也不放开准入')
  ok(rows.at(-1).admission.ok === false, 'd 的 admission 仍然是否')
}

console.log('[4] 首字速度档：完全按首字延迟')
{
  const rows = run(spec, { decisionMode: 'speed' })
  ok(ids(rows) === 'c > b > a > d', `顺序 ${ids(rows)}`)
  ok(rows[0].offer.id === 'c', '最快的 c 排第一，哪怕它贵 9 倍')
  ok(rows.at(-1).offer.id === 'd', 'd 首字最快（100ms）但不可用，仍然排最后')
}

console.log('[4b] 价速比档：价格 ÷ 首字延迟，贵的慢的一起现形')
{
  // a：1 元 / 3000ms → 0.333；b：1.1 元 / 3000ms → 0.367；c：9 元 / 700ms → 12.9
  // c 虽然最快，但每毫秒等待贵得多 → 价速比档下退居末位
  const rows = run(spec, { decisionMode: 'priceSpeed' })
  ok(ids(rows) === 'a > b > c > d', `顺序 ${ids(rows)}`)
  ok(rows[0].offer.id === 'a', '综合最优的 a 排第一：又便宜、首字也不慢')
  ok(rows.at(-1).offer.id === 'd', 'd 仍不登场：价速比档也不放开准入')

  // 缺首字数据不冒充综合最优：Infinity 沉底，与 speed 档同一口径
  const missing = run(
    [
      { id: 'known', cny: 5, score: { ttftMs: 4200 } },
      { id: 'unknown', cny: 1, score: { ttftMs: null, samples: 0, status: 'unknown' } },
    ],
    { decisionMode: 'priceSpeed' },
  )
  ok(missing[0].offer.id === 'known', `没探过首字的沉底：${ids(missing)}`)

  // tierMetricOf 与 compareByBasis 主键同源：同一个数，别两处各算一份
  ok(
    tierMetricOf({ priceUsd: 2, ttftMs: 1000 }, 'priceSpeed') === 0.002,
    `价速比标量 = 价格/首字：${tierMetricOf({ priceUsd: 2, ttftMs: 1000 }, 'priceSpeed')}`,
  )
  ok(tierMetricOf({ priceUsd: 2, ttftMs: null }, 'priceSpeed') === Number.POSITIVE_INFINITY, '缺首字 → Infinity')
  ok(tierMetricOf({ priceUsd: 2, ttftMs: 0 }, 'priceSpeed') === Number.POSITIVE_INFINITY, '首字 0 → Infinity（不除零）')
  ok(tierMetricOf({ effectiveUsd: 3 }, 'value') === 3, 'value 档标量 = 有效成本')
  ok(tierMetricOf({ priceUsd: 4 }, 'price') === 4, 'price 档标量 = 名义单价')
  ok(tierMetricOf({ ttftMs: 900 }, 'speed') === 900, 'speed 档标量 = 首字延迟')
}

console.log('[5] 缺数据不冒充「最快」')
{
  const rows = run(
    [
      { id: 'known', cny: 5, score: { ttftMs: 4200 } },
      { id: 'unknown', cny: 1, score: { ttftMs: null, samples: 0, status: 'unknown' } },
    ],
    { decisionMode: 'speed' },
  )
  ok(rows[0].offer.id === 'known', `没探过的排在有首字数据之后：${ids(rows)}`)
  ok(rows[1].ttftMs === null, 'unknown 行首字为 null（不是 0）')
}

console.log('[6] 手动顺序仍然优先于自动口径')
{
  const rows = run(spec, { decisionMode: 'speed' }, ['a', 'c'])
  ok(rows[0].offer.id === 'a', `手动把 a 提到 c 前面：${ids(rows)}`)
  ok(rows.at(-1).offer.id === 'd', '手动顺序也提不动不可用的 d')
}

console.log('[7] 速度档不绕过慢速门槛')
{
  const rows = run(
    [
      { id: 'fast', cny: 5, score: { ttftMs: 7000 } },
      { id: 'slow', cny: 0.1, score: { ttftMs: 15000 } },
    ],
    { decisionMode: 'speed', maxTtftMs: 8000 },
  )
  ok(rows[0].offer.id === 'fast', `门槛内的排前面：${ids(rows)}`)
  ok(rows[1].admission.kind === 'slow', '超门槛的仍然判慢速（排序偏好不是放行）')
}

console.log('[8] 看板顶部结论句：自己的档位，只在这批「能登场」的牌里挑')
{
  const candidate = (offerId, patch = {}) => ({
    offerId,
    providerName: offerId === 'x1' ? '甲站' : '乙站',
    group: '',
    price: 10,
    effective: 12,
    ttftMs: 3000,
    admission: { ok: true },
    ...patch,
  })
  const decision = (modelKey, chosenOfferId, candidates) => ({
    modelKey,
    candidates,
    chosenOfferId,
    chosenProviderName: candidates.find((c) => c.offerId === chosenOfferId)?.providerName ?? null,
  })
  // 三张能登场的牌：x1 最便宜但最慢、x2 最快但最贵、x3 中间
  const d1 = decision('m-a', 'x1', [
    candidate('x1', { effective: 5, price: 5, ttftMs: 9000 }),
    candidate('x2', { effective: 20, price: 20, ttftMs: 500 }),
    candidate('x3', { effective: 12, price: 12, ttftMs: 3000 }),
  ])
  const d2 = decision('m-b', 'y1', [candidate('y1', { effective: 3, price: 2, ttftMs: 5000 })])
  const dead = decision('m-dead', null, [candidate('z1')])

  const none = decisionHeadline({ decisions: [dead], settings: {} })
  ok(none === null, '一张能登场的牌都没有 → null（不编结论）')

  const auto = decisionHeadline({ decisions: [d1, d2], settings: {} })
  ok(auto.modelKey === 'm-a', `没指定就用第一个可用的：${auto.modelKey}`)
  ok(auto.mode === 'value', `默认档 ${auto.mode}`)
  ok(auto.effectiveCny === 5, `性价比档挑有效成本最低的：${auto.effectiveCny}`)

  // 看板档位和路由档位分开：路由按速度，看板按价格，各看各的
  const split = decisionHeadline({
    decisions: [d1],
    settings: { decisionMode: 'speed', headlineMode: 'price' },
  })
  ok(split.mode === 'price', `看板用自己的档位，不吃 decisionMode：${split.mode}`)
  ok(split.priceCny === 5, `价格档挑最便宜的：${split.priceCny}`)

  const speedPick = decisionHeadline({
    decisions: [d1],
    settings: { decisionMode: 'value', headlineMode: 'speed' },
  })
  ok(speedPick.ttftMs === 500, `速度档挑最快的（不跟路由的「当前选」）：${speedPick.ttftMs}`)
  ok(speedPick.effectiveCny === 20, '数字跟着选中的那张牌走')

  const focused = decisionHeadline({ decisions: [d1, d2], settings: { focusModel: 'm-b' } })
  ok(focused.modelKey === 'm-b', `点过的模型优先：${focused.modelKey}`)

  const byUsage = decisionHeadline({ decisions: [d1, d2], settings: {}, focusModels: ['m-b'] })
  ok(byUsage.modelKey === 'm-b', `没点过就按关注度顺序：${byUsage.modelKey}`)

  const stale = decisionHeadline({ decisions: [d1, d2], settings: { focusModel: 'm-gone' } })
  ok(stale.modelKey === 'm-a', '点过的模型没价/消失了 → 回落自动，不报错')

  for (const mode of ['value', 'price', 'speed', 'priceSpeed']) {
    const line = decisionHeadline({ decisions: [d1], settings: { headlineMode: mode } })
    ok(line.mode === mode, `档位透传：${mode}`)
  }
  const noTtft = decisionHeadline({
    decisions: [decision('m-c', 'c1', [candidate('c1', { ttftMs: null })])],
    settings: { headlineMode: 'speed' },
  })
  ok(noTtft.ttftMs === null, '没探过针 → ttftMs 为 null（前端写「未知」，不是 0ms）')

  // 不登场的牌再快再便宜也不参与：看板只在这批里挑
  const withDead = decisionHeadline({
    decisions: [
      decision('m-d', 'ok', [
        candidate('ok', { effective: 8, price: 8, ttftMs: 4000 }),
        candidate('bad', {
          effective: 0.1,
          price: 0.1,
          ttftMs: 100,
          admission: { ok: false, kind: 'degraded' },
        }),
      ]),
    ],
    settings: { headlineMode: 'speed' },
  })
  ok(withDead.ttftMs === 4000, `不可用的牌再快也不选：${withDead.ttftMs}`)

  // 速度档：有首字数据的优先，没探过针的排最后（不冒充最快）
  const mixed = decisionHeadline({
    decisions: [
      decision('m-e', 'k1', [
        candidate('k1', { effective: 1, price: 1, ttftMs: null }),
        candidate('k2', { effective: 9, price: 9, ttftMs: 7000 }),
      ]),
    ],
    settings: { headlineMode: 'speed' },
  })
  ok(mixed.ttftMs === 7000, `没探过针的排在有数据之后：${mixed.ttftMs}`)
}

console.log('[9] 全场冠军行：全部模型合在一起比，只看能登场的牌，档位独立')
{
  const candidate = (offerId, providerName, patch = {}) => ({
    offerId,
    providerName,
    group: '',
    price: 10,
    effective: 12,
    ttftMs: 3000,
    admission: { ok: true },
    ...patch,
  })
  const decision = (modelKey, candidates) => ({
    modelKey,
    candidates,
    chosenOfferId: candidates[0]?.offerId ?? null,
    chosenProviderName: candidates[0]?.providerName ?? null,
  })
  // m-a：最便宜的是 x1（5 元）；m-b：全体里最快的 y2（500ms）但贵
  const d1 = decision('m-a', [
    candidate('x1', '甲站', { effective: 5, price: 5, ttftMs: 9000 }),
    candidate('x2', '甲站', { effective: 12, price: 12, ttftMs: 3000 }),
  ])
  const d2 = decision('m-b', [
    candidate('y1', '乙站', { effective: 15, price: 15, ttftMs: 1200 }),
    candidate('y2', '乙站', { effective: 30, price: 30, ttftMs: 500 }),
  ])
  const dead = decision('m-dead', [
    candidate('z1', '丙站', { effective: 0.01, price: 0.01, ttftMs: 10, admission: { ok: false, kind: 'degraded' } }),
  ])

  const champ = decisionChampion({ decisions: [d1, d2], settings: {} })
  ok(champ.modelKey === 'm-a' && champ.effectiveCny === 5, `性价比档全场第一是 m-a 的 x1：${champ.modelKey}/${champ.effectiveCny}`)
  ok(champ.providerName === '甲站', `冠军带站名：${champ.providerName}`)
  ok(champ.mode === 'value', `默认档 ${champ.mode}`)

  const fastest = decisionChampion({ decisions: [d1, d2], settings: { championMode: 'speed' } })
  ok(fastest.modelKey === 'm-b' && fastest.ttftMs === 500, `速度档全场第一是 m-b 的 y2：${fastest.ttftMs}ms`)

  const cheapest = decisionChampion({ decisions: [d1, d2], settings: { championMode: 'price' } })
  ok(cheapest.modelKey === 'm-a' && cheapest.priceCny === 5, `价格档全场第一还是 x1：${cheapest.priceCny}`)

  // 与第一句互不干扰：headlineMode 管上面，championMode 管下面
  const both = decisionChampion({ decisions: [d1, d2], settings: { headlineMode: 'speed', championMode: 'price' } })
  ok(both.mode === 'price', `冠军用自己的档位，不吃 headlineMode：${both.mode}`)
  const head = decisionHeadline({ decisions: [d1], settings: { headlineMode: 'speed', championMode: 'price' } })
  ok(head.mode === 'speed', `第一句照旧用 headlineMode：${head.mode}`)

  // 不登场的牌再便宜再快也夺不了冠
  const withDead = decisionChampion({ decisions: [dead, d2], settings: { championMode: 'speed' } })
  ok(withDead.modelKey === 'm-b', `不可用的 z1（10ms）不进池子：${withDead.modelKey}`)

  // 全部不可用 → null，前端不画
  ok(decisionChampion({ decisions: [dead], settings: {} }) === null, '一张能登场的牌都没有 → null')

  // 缺数据不冒充最快：没探过针的排在有数据之后
  const noTtft = decisionChampion({
    decisions: [decision('m-nt', [candidate('n1', '甲站', { ttftMs: null })]), d2],
    settings: { championMode: 'speed' },
  })
  ok(noTtft.modelKey === 'm-b' && noTtft.ttftMs === 500, `没探过针的不冒充最快：${noTtft.ttftMs}ms`)
}

console.log('[7] 人工勾选（点选）：勾了哪条哪条就是当前选，顺序不动、准入拦不住人手点的')
{
  const rows = run(spec, { decisionMode: 'value' })
  ok(ids(rows) === 'b > a > c > d', `基准顺序 ${ids(rows)}`)

  // 勾选排在第三的 c：页面顺序不动（applyPinnedChoice 只在网关尝试链里用，
  // 决策页的展示顺序吃原始排序），但「当前选」= 勾选的那条
  const pinned = applyPinnedChoice(rows, 'c')
  ok(pinned.pinned?.offer.id === 'c', '勾选 c 生效')
  ok(ids(rows) === 'b > a > c > d', `原始顺序不被勾选改动：${ids(rows)}`)
  ok(ids(pinned.candidates) === 'c > b > a > d', `尝试链里勾选的顶到最前：${ids(pinned.candidates)}`)

  // 勾选被准入拉黑的 d（可用率 50%）：人的明确指定压过探针准入，照样生效，
  // 真发失败了网关沿链往后转移（b 接着接单）
  const pinnedBlocked = applyPinnedChoice(rows, 'd')
  ok(pinnedBlocked.pinned?.offer.id === 'd', '勾选准入拉黑的 d 也生效（人手点的压过准入）')
  ok(ids(pinnedBlocked.candidates) === 'd > b > a > c', `d 顶到尝试链最前：${ids(pinnedBlocked.candidates)}`)

  // 勾选不在候选里的（已暂停/已删除）→ 不生效，回落自动
  const pinnedMissing = applyPinnedChoice(rows, 'nope')
  ok(pinnedMissing.pinned === null && ids(pinnedMissing.candidates) === ids(rows), '勾选的牌不在候选里 → 不生效，顺序不变')

  // 没勾选 → 原样返回
  const none = applyPinnedChoice(rows, null)
  ok(none.pinned === null && ids(none.candidates) === ids(rows), '没勾选 → 原样')
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
