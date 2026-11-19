/**
 * 币种口径自检（纯函数 + 临时数据目录，不联网）。
 *
 * 钉死这次修的四件事：
 *   1. 归一化只认 CNY，其余（RUSD / 空串 / 小写 / undefined）全当美元
 *   2. 「站点价目表币种」= 用户显式声明 > 数据证据（倍率 × 基准价）> 沿用原值，
 *      没有证据不动任何一条数据
 *   3. 落价时调用方给了币种就按它写，没给就沿用这条供给原来的币种（不静默翻转）
 *   4. 美元价被标成 CNY 会让综合成本少算一个汇率（修的就是这个量级）
 *
 * 用法：node .test/check-currency.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'mapi-currency-'))
process.env.MANAGE_API_HOME = home

const { normalizeCurrency, declaredPriceCurrency, inferSiteCurrency, currencyOf } = await import(
  '../core/currency.js'
)
const { planCurrencyReconcile, applyCurrencyReconcile } = await import('../core/currency-reconcile.js')
const inv = await import('../core/inventory.js')
const store = await import('../core/store.js')
const { offerCost } = await import('../core/pricing.js')

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1
    console.log(`  ok ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name} ${extra}`)
  }
}

// 基准价表：中文模型是官方人民币价（9 元 / 27 元），英文模型是美元价
const BENCH = {
  'deepseek-v4-pro': { in: 9, out: 27, currency: 'CNY' },
  'glm-5.3': { in: 8, out: 28, currency: 'CNY' },
  'gpt-4o': { in: 2.5, out: 10, currency: 'USD' },
}
const FX = 7.2

try {
  console.log('1) 归一化：只认 CNY，其余都是美元')
  check('CNY', normalizeCurrency('CNY') === 'CNY')
  check('小写 cny', normalizeCurrency('cny') === 'CNY')
  check('带空格', normalizeCurrency(' CNY ') === 'CNY')
  check('USD', normalizeCurrency('USD') === 'USD')
  check('历史脏值 RUSD 归美元', normalizeCurrency('RUSD') === 'USD')
  check('空串归美元', normalizeCurrency('') === 'USD')
  check('undefined 归美元', normalizeCurrency(undefined) === 'USD')
  check('null 归美元', normalizeCurrency(null) === 'USD')

  console.log('2) 显式声明：没声明是 null（「还没定」，不是美元）')
  check('没有 provider', declaredPriceCurrency(null) === null)
  check('没设 priceCurrency', declaredPriceCurrency({ id: 'p1' }) === null)
  check('空串 = 没设', declaredPriceCurrency({ priceCurrency: '' }) === null)
  check('声明 CNY', declaredPriceCurrency({ priceCurrency: 'CNY' }) === 'CNY')
  check('声明小写 cny', declaredPriceCurrency({ priceCurrency: 'cny' }) === 'CNY')
  check('声明 USD', declaredPriceCurrency({ priceCurrency: 'USD' }) === 'USD')
  check('钱包币种不算价目表声明', declaredPriceCurrency({ currency: 'CNY' }) === null)

  console.log('3) 单条供给：custom 优先，其次站点声明，否则沿用自己')
  check(
    'custom 的 CNY',
    currencyOf({ currency: 'CNY', currencySource: 'custom' }, { priceCurrency: 'USD' }) === 'CNY',
  )
  check('站点声明覆盖非 custom', currencyOf({ currency: 'USD' }, { priceCurrency: 'CNY' }) === 'CNY')
  check('没声明 → 沿用原值 CNY', currencyOf({ currency: 'CNY' }, {}) === 'CNY')
  check('没声明 → 沿用原值 USD', currencyOf({ currency: 'USD' }) === 'USD')

  console.log('4) 数据证据：手填价与「基准价 × 倍率」的关系反推币种')
  const cnyVotes = inferSiteCurrency(
    [
      { modelKey: 'deepseek-v4-pro', inPrice: 1.35, ratio: 0.15 }, // 9 × 0.15 = 1.35 ✓
      { modelKey: 'glm-5.3', inPrice: 1.2, ratio: 0.15 }, // 8 × 0.15 = 1.2 ✓
    ],
    BENCH,
    FX,
  )
  check('两条对上 → CNY', cnyVotes.currency === 'CNY', cnyVotes.currency)
  check('票数 2', cnyVotes.votes === 2, cnyVotes.votes)

  const flipped = inferSiteCurrency(
    [
      // 9 × 0.15 ÷ 7.2 = 0.1875 → 美元
      { modelKey: 'deepseek-v4-pro', inPrice: 0.1875, ratio: 0.15 },
      { modelKey: 'glm-5.3', inPrice: 0.1667, ratio: 0.15 }, // 8×0.15÷7.2=0.1667
    ],
    BENCH,
    FX,
  )
  check('差一个汇率才成立 → USD', flipped.currency === 'USD', flipped.currency)

  const oneVote = inferSiteCurrency([{ modelKey: 'deepseek-v4-pro', inPrice: 1.35, ratio: 0.15 }], BENCH, FX)
  check('只有一条证据不下结论', oneVote.currency === null, oneVote.currency)

  const noBench = inferSiteCurrency([{ modelKey: 'unknown-x', inPrice: 1, ratio: 0.1 }], BENCH, FX)
  check('没有基准价 → 沉默', noBench.currency === null, noBench.currency)

  const tie = inferSiteCurrency(
    [
      { modelKey: 'deepseek-v4-pro', inPrice: 1.35, ratio: 0.15 }, // CNY
      { modelKey: 'glm-5.3', inPrice: 0.1667, ratio: 0.15 }, // USD
    ],
    BENCH,
    FX,
  )
  check('一比一僵持 → 沉默', tie.currency === null, tie.currency)

  console.log('5) 落价分支：给了币种按它写，没给沿用原值')
  const percall = { id: 'o-percall', inPrice: null, outPrice: null, currency: 'CNY' }
  const rPer = inv.applySitePricing(percall, {
    exact: { inPrice: 1, outPrice: 2 },
    rate: 0.5,
    sitePrice: { billingMode: 'per_request', callPrice: 0.4 },
    hasBench: true,
    currency: 'USD',
  })
  check('按次走 percall', rPer === 'percall', rPer)
  check('按次币种来自参数', percall.currency === 'USD', percall.currency)
  check('按次标记 site', percall.currencySource === 'site')

  const free = { id: 'o-free', currency: 'USD' }
  const rFree = inv.applySitePricing(free, {
    exact: { inPrice: 0, outPrice: 0 },
    rate: 0.3,
    sitePrice: null,
    hasBench: false,
    currency: 'CNY',
  })
  check('原地免费走 free', rFree === 'free', rFree)
  check('免费行也写对币种', free.currency === 'CNY', free.currency)
  check('免费行标记 site', free.currencySource === 'site')

  const siteBase = { id: 'o-base', currency: 'USD' }
  const rBase = inv.applySitePricing(siteBase, {
    exact: { inPrice: 1, outPrice: 3 },
    rate: 2,
    sitePrice: { inPrice: 1, outPrice: 3 },
    hasBench: true,
    currency: 'CNY',
  })
  check('站点原价走 site-base', rBase === 'site-base', rBase)
  check('站点原价币种跟随', siteBase.currency === 'CNY', siteBase.currency)

  // 关键：调用方没传币种（站点还没声明也没推断出来）→ 沿用这条供给原来的币种
  const kept = { id: 'o-kept', inPrice: 1, outPrice: 2, currency: 'CNY' }
  inv.applySitePricing(kept, { exact: { inPrice: 1, outPrice: 2 }, rate: 1, sitePrice: null, hasBench: true })
  check('没传币种 → 沿用原值 CNY（不翻转）', kept.currency === 'CNY', kept.currency)

  const skipped = { id: 'o-skip' }
  const rSkip = inv.applySitePricing(skipped, {
    exact: { inPrice: 1, outPrice: 2 },
    rate: null,
    sitePrice: { inPrice: 1, outPrice: 2 },
    hasBench: true,
    currency: 'CNY',
  })
  check('没解析出倍率就 skip，不落错价', rSkip === 'skip', rSkip)
  check('skip 不碰币种', skipped.currency === undefined, skipped.currency)

  console.log('6) 同步新供给：跟随站点声明，没有声明沿用钱包币种')
  const provider = await inv.createProvider({ name: '测试站', baseUrl: 'https://currency.example.com/v1' })
  await inv.syncOffers(provider.id, null, ['gpt-4o-mini'])
  let db = await store.readDb()
  let offer = db.offers.find((o) => o.upstreamName === 'gpt-4o-mini')
  check('没声明 → 美元', offer?.currency === 'USD', offer?.currency)
  check('新供给标记 site', offer?.currencySource === 'site')

  await inv.updateProvider(provider.id, { priceCurrency: 'cny' })
  const updated = (await store.readDb()).providers.find((p) => p.id === provider.id)
  check('站点币种被归一成 CNY', updated?.priceCurrency === 'CNY')
  check('显式设置标记 custom', updated?.priceCurrencySource === 'custom')
  await inv.syncOffers(provider.id, null, ['deepseek-v4-pro'])
  db = await store.readDb()
  const cnyOffer = db.offers.find((o) => o.upstreamName === 'deepseek-v4-pro')
  check('站点改 CNY 后新供给是 CNY', cnyOffer?.currency === 'CNY', cnyOffer?.currency)

  console.log('7) 校正计划：只改有证据的站，custom 与无证据的一律不动')
  const fakeDb = {
    providers: [
      { id: 'p-auto', name: '有证据站' },
      { id: 'p-silent', name: '没证据站' },
      { id: 'p-declared', name: '用户声明站', priceCurrency: 'USD' },
    ],
    offers: [
      // p-auto：两条元价证据 → 推断 CNY
      { id: 'a1', providerId: 'p-auto', modelKey: 'deepseek-v4-pro', inPrice: 1.35, ratio: 0.15, currency: 'USD' },
      { id: 'a2', providerId: 'p-auto', modelKey: 'glm-5.3', inPrice: 1.2, ratio: 0.15, currency: 'USD' },
      // p-auto：手改过的行不能被覆盖
      { id: 'a3', providerId: 'p-auto', modelKey: 'gpt-4o', inPrice: 0.9, ratio: 0.4, currency: 'USD', currencySource: 'custom' },
      // p-silent：没有基准价
      { id: 's1', providerId: 'p-silent', modelKey: 'mystery', inPrice: 5, ratio: 0.5, currency: 'CNY' },
      // p-declared：用户声明美元，数据看起来像人民币 → 以用户为准
      { id: 'd1', providerId: 'p-declared', modelKey: 'deepseek-v4-pro', inPrice: 1.35, ratio: 0.15, currency: 'USD' },
    ],
  }
  const plan = planCurrencyReconcile(fakeDb, BENCH, FX)
  const byId = Object.fromEntries(plan.providers.map((p) => [p.providerId, p]))
  check('有证据站推断 CNY', byId['p-auto']?.inferred === 'CNY', byId['p-auto']?.inferred)
  check('有证据站计划改 2 条', byId['p-auto']?.offers.filter((o) => !o.relabel).length === 2)
  check('没证据站不在计划里', !byId['p-silent'])
  check('声明站以用户为准', byId['p-declared']?.next === 'USD', byId['p-declared']?.next)
  check('声明站不改行', byId['p-declared']?.offers.filter((o) => !o.relabel).length === 0)
  const result = applyCurrencyReconcile(fakeDb, plan)
  check('落库 2 条', result.offersChanged === 2, result.offersChanged)
  check('a1 变 CNY/site', fakeDb.offers[0].currency === 'CNY' && fakeDb.offers[0].currencySource === 'site')
  check('custom 行没被碰', fakeDb.offers[2].currency === 'USD' && fakeDb.offers[2].currencySource === 'custom')
  check('无证据行没被碰', fakeDb.offers[3].currency === 'CNY' && !fakeDb.offers[3].currencySource)
  check('推断结果写回站点', fakeDb.providers[0].priceCurrency === 'CNY' && fakeDb.providers[0].priceCurrencySource === 'auto')

  // 第二次跑应当无事可做（幂等）
  const again = planCurrencyReconcile(fakeDb, BENCH, FX)
  check('再跑一次没有要改的行', again.offers.filter((o) => !o.relabel).length === 0)

  console.log('8) 错标币种的代价就是差一个汇率（bug 本体）')
  const settings = (await store.readDb()).settings
  const fx = Number(settings.fx?.rates?.CNY) || 7.2
  const shape = { pricingMode: 'manual', inPrice: 0.3, outPrice: 1.2, ratio: null }
  const usd = offerCost({ ...shape, currency: 'USD' }, settings, {})
  const mislabeled = offerCost({ ...shape, currency: 'CNY' }, settings, {})
  const blended = 0.3 * 0.25 + 1.2 * 0.75
  check('美元标签按美元算', Math.abs(usd.blendedUsdPerMtok - blended) < 1e-9, usd.blendedUsdPerMtok)
  check(
    `错标 CNY 少算 ${fx} 倍`,
    Math.abs(mislabeled.blendedUsdPerMtok * fx - blended) < 1e-6,
    mislabeled.blendedUsdPerMtok,
  )
} finally {
  await rm(home, { recursive: true, force: true })
}

console.log(fail === 0 ? `\n全部 ${pass} 项通过` : `\n失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)