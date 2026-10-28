/**
 * 官方有效成本 + 币种口径自检（纯函数，不联网）。
 *
 * 币种口径（2026-10-28 与作者定的规矩）：
 *   - 站内美元（USD）与人民币 1:1 —— 中转站模板按美元标价、实际按人民币数值扣费
 *   - CNY = 真实人民币，数值上与站内美元相同（常规情况不用）
 *   - RUSD = 「真实美元 R.Dollar」，国外模型官方价专用，按汇率换算
 *
 * 覆盖：
 *   1. officialCost 与 offerCost 同一口径（混合权重），质量按 1
 *   2. USD/CNY 1:1 不乘汇率；RUSD 乘汇率
 *   3. 峰谷价（DeepSeek 空闲减半）：峰、谷两个有效成本
 *   4. blendInputWeight 自定义权重 / 限幅
 *   5. 缺基准 / 全空价 → null；只填一个价回落
 *   6. 参考价库：价格合法、国内官方 CNY、国外官方 RUSD、前缀匹配
 *   7. 倍率参照 1:1：基准价是 RUSD/CNY 也不改变供给实际价的数值
 *
 * 用法：node .test/check-official-cost.mjs
 */
import { officialCost, offerCost, resolveOfferPrice } from '../core/pricing.js'
import { resolveReference, listReference } from '../core/model-prices.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

const fx7 = { blendInputWeight: 0.25, fx: { rates: { CNY: 7 } } }

console.log('[1] 口径与 offerCost 一致：USD 基准价直接加权，不乘汇率')
{
  const c = officialCost({ in: 2, out: 10, currency: 'USD' }, fx7)
  ok(near(c.blendedCnyPerMtok, 2 * 0.25 + 10 * 0.75), `2×0.25 + 10×0.75 = ${c.blendedCnyPerMtok}`)
  ok(near(c.blendedUsdPerMtok, c.blendedCnyPerMtok), '站内美元与人民币 1:1，两个口径同数值')
  ok(c.currency === 'USD' && c.in === 2 && c.out === 10, '原始字段原样回传')
}

console.log('[2] CNY 1:1；R.Dollar（真实美元）乘汇率')
{
  const cny = officialCost({ in: 2, out: 8, currency: 'CNY' }, fx7)
  ok(near(cny.blendedCnyPerMtok, 2 * 0.25 + 8 * 0.75), `CNY ¥2/¥8 → ¥${cny.blendedCnyPerMtok}（1:1 不换算）`)
  const rusd = officialCost({ in: 2, out: 8, currency: 'RUSD' }, fx7)
  ok(near(rusd.blendedCnyPerMtok, (2 * 0.25 + 8 * 0.75) * 7), `R.Dollar $2/$8 → ¥${rusd.blendedCnyPerMtok}（×7 汇率）`)
  ok(rusd.blendedCnyPerMtok / cny.blendedCnyPerMtok - 1 < 1e9, '同数值下 RUSD 恰好是 CNY 的汇率倍')
}

console.log('[3] 峰谷价：DeepSeek 空闲减半，峰谷各一个有效成本')
{
  const c = officialCost(
    { in: 2, out: 8, offPeakIn: 1, offPeakOut: 4, currency: 'CNY' },
    fx7,
  )
  ok(c.hasOffPeak === true, 'hasOffPeak 标位')
  ok(near(c.blendedCnyPerMtok, 2 * 0.25 + 8 * 0.75), `波峰有效成本 = ${c.blendedCnyPerMtok}`)
  ok(near(c.offPeakBlendedCnyPerMtok, 1 * 0.25 + 4 * 0.75), `波谷有效成本 = ${c.offPeakBlendedCnyPerMtok}（峰的一半）`)
  // 缺一侧峰谷价 → 回落到高峰价（与 offerCost 的回落一致）
  const half = officialCost({ in: 2, out: 8, offPeakIn: 1, currency: 'CNY' }, fx7)
  ok(near(half.offPeakBlendedCnyPerMtok, 1 * 0.25 + 8 * 0.75), '谷出价缺 → 回落用峰出价')
  const none = officialCost({ in: 2, out: 8, currency: 'CNY' }, fx7)
  ok(none.hasOffPeak === false && none.offPeakBlendedCnyPerMtok === null, '没填峰谷 → hasOffPeak=false')
}

console.log('[4] blendInputWeight 自定义权重生效（含限幅）')
{
  const c = officialCost({ in: 4, out: 8, currency: 'USD' }, { blendInputWeight: 1, fx: fx7.fx })
  ok(near(c.blendedCnyPerMtok, 4), `权重 1 = 全按输入价（${c.blendedCnyPerMtok}）`)
  const c2 = officialCost({ in: 4, out: 8, currency: 'USD' }, { blendInputWeight: 0, fx: fx7.fx })
  ok(near(c2.blendedCnyPerMtok, 8), `权重 0 = 全按输出价（${c2.blendedCnyPerMtok}）`)
  const c3 = officialCost({ in: 4, out: 8, currency: 'USD' }, { blendInputWeight: 9, fx: fx7.fx })
  ok(near(c3.blendedCnyPerMtok, 4), '权重 9 限幅为 1 = 全按输入价')
  const c4 = officialCost({ in: 4, out: 8, currency: 'USD' }, { blendInputWeight: -3, fx: fx7.fx })
  ok(near(c4.blendedCnyPerMtok, 8), '权重 -3 限幅为 0 = 全按输出价')
  const c5 = officialCost({ in: 4, out: 8, currency: 'USD' }, { blendInputWeight: 'abc', fx: fx7.fx })
  ok(near(c5.blendedCnyPerMtok, 4 * 0.25 + 8 * 0.75), '非数字权重回落 0.25')
}

console.log('[5] 缺基准 / 全空价 → null，不硬凑')
{
  ok(officialCost(undefined, fx7) === null, '没有基准条目 → null')
  ok(officialCost(null, fx7) === null, 'null → null')
  ok(officialCost({ in: null, out: null, currency: 'USD' }, fx7) === null, '两个价全空 → null')
  const onlyIn = officialCost({ in: 2, out: null, currency: 'USD' }, fx7)
  ok(near(onlyIn.blendedCnyPerMtok, 2), `只填输入价 → 用输入价（${onlyIn.blendedCnyPerMtok}）`)
  const onlyOut = officialCost({ in: null, out: 6, currency: 'USD' }, fx7)
  ok(near(onlyOut.blendedCnyPerMtok, 6), `只填输出价 → 用输出价（${onlyOut.blendedCnyPerMtok}）`)
}

console.log('[6] 参考价库：价格合法、币种口径正确、前缀匹配')
{
  const list = listReference()
  ok(list.length >= 60, `主流模型条目数充足（${list.length} 条）`)
  const bad = list.filter((e) => !(e.in >= 0 && e.out >= 0) || (e.in !== null && e.out !== null && e.out < e.in))
  ok(bad.length === 0, `价格合法（负价或 in≥out 的条目：${bad.map((b) => b.modelKey).join(', ') || '无'}）`)
  ok(list.every((e) => ['CNY', 'USD', 'RUSD'].includes(e.currency)), '币种只有 CNY / USD / RUSD')
  // 国内官方价必须是 CNY；国外官方价（真美元）必须是 RUSD
  const domestic = ['deepseek-v4-pro', 'glm-5.3', 'minimax-m3.1-flash', 'qwen3.8-max', 'kimi-k3']
  ok(domestic.every((k) => resolveReference(k)?.currency === 'CNY'), '国内官方价标 CNY')
  const foreign = ['gpt-5.5', 'claude-sonnet-5.5', 'gemini-2.5-flash', 'grok-4.7', 'kimi-k3.1-pro', 'mimo-v2.6-pro']
  ok(foreign.every((k) => resolveReference(k)?.currency === 'RUSD'), '国外官方价标 R.Dollar')
  ok(list.every((e) => e.source), '每条都有来源标注')
  const tail = resolveReference('gpt-5.5-2026-01-01')
  ok(tail.matchedKey === 'gpt-5.5', `-2026 尾巴归到 gpt-5.5（${tail.matchedKey}）`)
  // 横线变体：canonicalName 把 5-5 归一到 5.5，不会错归到 claude-opus-5（5/25）
  const dash = resolveReference('claude-opus-5-5')
  ok(['claude-opus-5-5', 'claude-opus-5.5'].includes(dash.matchedKey) && dash.in === 4 && dash.out === 20,
    `claude-opus-5-5 横线变体拿到 5.5 的价（${dash.in}/${dash.out}）`)
  ok(resolveReference('完全陌生的小模型') === null, '不在库里 → null')
}

console.log('[7] 倍率参照 1:1：基准价币种不影响供给实际价的数值')
{
  // 站点标 $2/$8（站内美元），倍率 0.5；基准价是 RUSD 官方价 2/8 —— 数值一样
  // （站点模板就是抄官方价的数字），实际价必须还是 1/4，绝不能乘汇率变 7/28
  const bench = { 'deepseek-v4.1-flash': { in: 2, out: 8, currency: 'RUSD' } }
  const r = resolveOfferPrice(
    { modelKey: 'deepseek-v4.1-flash', pricingMode: 'ratio', ratio: 0.5, inPrice: null, outPrice: null, currency: 'USD', priceUnit: 'per_mtok' },
    bench,
  )
  ok(near(r.inPrice, 1) && near(r.outPrice, 4), `RUSD 基准价当参照 → 实际价 1/4（${r.inPrice}/${r.outPrice}），不乘汇率`)
  ok(r.currency === 'USD', `实际价币种跟站点走（${r.currency}）`)
  const cost = offerCost(
    { modelKey: 'deepseek-v4.1-flash', pricingMode: 'ratio', ratio: 0.5, inPrice: null, outPrice: null, currency: 'USD', priceUnit: 'per_mtok' },
    fx7,
    bench,
  )
  ok(near(cost.blendedUsdPerMtok, 1 * 0.25 + 4 * 0.75), `综合成本 = ${cost.blendedUsdPerMtok}（1:1 口径）`)
  ok(near(cost.blendedCnyPerMtok, cost.blendedUsdPerMtok), 'CNY 口径同数值')
  // CNY 标价的供给同样 1:1（旧口径会 ÷ 汇率，错把真实人民币当外币）
  const cnyCost = offerCost(
    { inPrice: 2, outPrice: 8, currency: 'CNY', priceUnit: 'per_mtok', pricingMode: 'manual' },
    fx7,
    {},
  )
  ok(near(cnyCost.blendedUsdPerMtok, 2 * 0.25 + 8 * 0.75), `CNY 标价供给 1:1（${cnyCost.blendedUsdPerMtok}），不再 ÷ 汇率`)
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
