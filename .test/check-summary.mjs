// 概览统计卡的两个口径：maxSpreadPct 是「比最贵省多少」，maxSpreadRatio 是「贵几倍」。
// 两者必须同时对，否则卡片上的百分比会被读成「只贵 63%」。
import * as pricing from '../core/pricing.js'

let failed = 0
function ok(cond, message) {
  if (cond) console.log('  ok ' + message)
  else {
    console.error('  ✗ ' + message)
    failed += 1
  }
}

const settings = { blendInputWeight: 0.25, fx: { rates: { CNY: 1 } } }
const offer = (id, providerId, inPrice, outPrice) => ({
  id,
  providerId,
  modelKey: 'm',
  upstreamName: 'm',
  pricingMode: 'manual',
  priceUnit: 'per_mtok',
  currency: 'USD',
  currencySource: 'custom',
  inPrice,
  outPrice,
  group: '',
})
const offers = [offer('a', 'p1', 1, 4), offer('b', 'p2', 3, 12)]
const all = pricing.summarize(offers, settings, {}, () => true)
ok(all.offerCount === 2, '两条供给都算上')
ok(all.maxSpreadPct === 67, `省 67%：${all.maxSpreadPct}`)
ok(all.maxSpreadRatio === 3, `贵 3 倍：${all.maxSpreadRatio}`)
ok(all.providerCount === 2, '两个站')

// 只有一条可信行时不能给出价差，也不能崩
const one = pricing.summarize(offers, settings, {}, (id) => id === 'a')
ok(one.maxSpreadPct === null && one.maxSpreadRatio === null, '单行可信时价差为空')

// 最便宜为 0（免费行）时不产出倍数，但百分比仍可为 100
const free = pricing.summarize([offer('a', 'p1', 0, 0), offer('b', 'p2', 3, 12)], settings, {}, () => true)
ok(free.maxSpreadPct === 100, `最便宜为 0 时省 100%：${free.maxSpreadPct}`)
ok(free.maxSpreadRatio === null, '最便宜为 0 时倍数为空')

// 只有一组可比时 comparableCount 只数有 2 站以上的模型
ok(all.modelCount === 1 && all.comparableCount === 1, '单模型单组')

if (failed > 0) {
  console.error(failed + ' 项失败')
  process.exitCode = 1
} else console.log('\n全部通过')
