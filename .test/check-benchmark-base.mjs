/**
 * 基准价口径：基准价必须是「倍率之前」的原价。
 *
 * 这里钉住三件事：
 *  1. 从站导入时优先用 offer.siteBaseIn/siteBaseOut（站点原价），而不是乘过倍率的实际价
 *  2. 0 价基准不收（倍率乘上去会把整行算成免费）
 *  3. 倍率行的币种跟着基准价走（价格是「基准价 × 倍率」算出来的，不在站点报价的币种里）
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'mapi-bench-'))
process.env.MANAGE_API_HOME = home

const { importBenchmarksFrom, readBenchmarks, writeBenchmarks } = await import('../core/benchmark.js')
const { applySitePricing } = await import('../core/inventory.js')
const { offerCost, rankByModel } = await import('../core/pricing.js')

let failed = 0
function ok(cond, message) {
  if (cond) console.log('  ✓ ' + message)
  else {
    console.error('  ✗ ' + message)
    failed += 1
  }
}

const providerId = 'p-test'
const offers = [
  // 站点原价 9 CNY，倍率 0.15 → 实际价 1.35（历史 bug：存的是这个）
  {
    providerId,
    id: 'o1',
    upstreamName: 'deepseek-v4-pro',
    modelKey: 'deepseek-v4-pro',
    pricingMode: 'manual',
    inPrice: 1.35,
    outPrice: 4.05,
    siteBaseIn: 9,
    siteBaseOut: 27,
    currency: 'CNY',
  },
  // 站点把模型标成免费：0 价基准会把整行算成免费，必须跳过
  {
    providerId,
    id: 'o2',
    upstreamName: 'free-model',
    modelKey: 'free-model',
    pricingMode: 'manual',
    inPrice: 0,
    outPrice: 0,
    currency: 'CNY',
  },
  // 没有 siteBase 的老数据：退回实际价（channels 源没有倍率，两者相等）
  {
    providerId,
    id: 'o3',
    upstreamName: 'gpt-4o',
    modelKey: 'gpt-4o',
    pricingMode: 'manual',
    inPrice: 2.5,
    outPrice: 10,
    currency: 'USD',
  },
]

await writeBenchmarks({})
const result = await importBenchmarksFrom(offers, providerId)
const table = await readBenchmarks()

ok(table['deepseek-v4-pro']?.in === 9, '优先用 siteBaseIn（9）而不是乘过倍率的实际价（1.35）')
ok(table['deepseek-v4-pro']?.out === 27, '输出价同样用 siteBaseOut')
ok(table['deepseek-v4-pro']?.currency === 'CNY', '币种沿用供给的价目表口径')
ok(table['free-model'] === undefined, '0 价基准不收（否则倍率行会被算成免费）')
ok(result.skipped === 1, '跳过的条目计入 skipped')
ok(table['gpt-4o']?.in === 2.5, '没有 siteBase 时退回实际价')

// ---- 倍率行：币种必须跟着基准价走
const ratioOffer = {
  id: 'o4',
  providerId,
  upstreamName: 'deepseek-v4-pro',
  modelKey: 'deepseek-v4-pro',
  pricingMode: 'manifest',
  priceUnit: 'per_mtok',
  ratio: 0.15,
  currency: 'USD', // 上次落价残留的错误标签
  inPrice: null,
  outPrice: null,
}
const via = applySitePricing(ratioOffer, {
  exact: null,
  rate: 0.15,
  sitePrice: null,
  hasBench: true,
  currency: 'CNY',
  benchCurrency: 'CNY',
})
ok(via === 'ratio', '没有站点原价时落到倍率模式')
ok(ratioOffer.pricingMode === 'ratio', 'pricingMode 改成 ratio')
ok(ratioOffer.currency === 'CNY', '倍率行币种 = 基准价币种（不再留着上次的 USD）')
ok(ratioOffer.currencySource === 'bench', '来源标记为 bench，说明钱不在站点口径里')

const settings = { fx: { rates: { CNY: 7.2 } }, blendInputWeight: 0.25 }
const cost = offerCost(ratioOffer, settings, table)
ok(cost.currency === 'CNY', 'offerCost 报出算钱用的币种')
ok(Math.abs(cost.inUsdPerMtok - 0.1875) < 1e-9, '9 CNY × 0.15 ÷ 7.2 = $0.1875/M')

const ranked = rankByModel([ratioOffer], settings, table)
ok(ranked.ranked[0]?.rows[0]?.currency === 'CNY', '比价页那一行显示的币种跟着算钱币种走')

// ---- 关键回归：基准价若存了折后价，价格会差 12.5 倍
const buggy = { 'deepseek-v4-pro': { in: 0.72, out: 2.16, currency: 'CNY' } }
const wrong = offerCost(ratioOffer, settings, buggy)
ok(
  Math.abs(cost.inUsdPerMtok / wrong.inUsdPerMtok - 12.5) < 1e-6,
  '折后基准价（0.72 vs 9）正好让价格少算 12.5 倍',
)

await rm(home, { recursive: true, force: true })
if (failed > 0) {
  console.error(failed + ' 项失败')
  process.exit(1)
}
console.log('全部通过')
