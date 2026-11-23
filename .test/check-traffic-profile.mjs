#!/usr/bin/env node
/**
 * 流量画像：把「用户实际怎么用」变成选站可以代入的数字。
 *
 * 重点验证三件事：
 *   1. 输入占比确实从 usage.json 算出来，样本不足时明确回落而不是瞎猜；
 *   2. 缓存命中率的优先级（真实流量 > 探针 > 明确不支持 > 先验），
 *      尤其「没测到」不能当 0——那会把新站系统性惩罚；
 *   3. 有效输入价 / 混合价的口径与手算一致。
 */
import {
  inputShareOf,
  cacheHitRateOf,
  tpsOf,
  relativeToMin,
  costProfileOf,
  effectiveInPrice,
  blendedWithProfile,
  medianOf,
  PROFILE_MIN_SAMPLES,
  CACHE_HIT_PRIOR,
  DEFAULT_CACHE_DISCOUNT,
  DEFAULT_INPUT_SHARE,
} from '../core/traffic-profile.js'

let failed = 0
function ok(cond, message) {
  if (cond) console.log(`  ✓ ${message}`)
  else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

console.log('medianOf')
{
  ok(medianOf([1, 3, 2]) === 2, '奇数个取中位')
  ok(medianOf([1, 2, 3, 4]) === 2.5, '偶数个取平均')
  ok(medianOf([]) === null, '空数组 → null')
  ok(medianOf([1, null, undefined, NaN, 3]) === 2, '过滤非有限值后取中位')
}

console.log('inputShareOf：从 usage.json 的 days 汇总')
{
  const days = {}
  // 25 天 × 每天一条：输入 995、输出 5 → 输入占比 0.995
  for (let i = 1; i <= 25; i += 1) {
    days[`2026-11-${String(i).padStart(2, '0')}`] = {
      'gk_x|p_1|deepseek-v4.1-flash': { input: 995, output: 5, cached: 700, requests: 3 },
    }
  }
  const r = inputShareOf(days)
  ok(r.samples === 25, `样本数 25（实测 ${r.samples}）`)
  ok(near(r.share, 0.995), `输入占比 0.995（实测 ${r.share}）`)
  ok(r.cachedTokens === 17500, '缓存 token 汇总正确')
}
{
  const days = {}
  for (let i = 1; i <= PROFILE_MIN_SAMPLES - 1; i += 1) {
    days[`2026-11-${String(i).padStart(2, '0')}`] = { k: { input: 100, output: 100 } }
  }
  const r = inputShareOf(days)
  ok(r.share === null, `样本只有 ${PROFILE_MIN_SAMPLES - 1} 条时返回 null（不猜）`)
  ok(inputShareOf({}).share === null, '完全没有数据 → null')
}

console.log('cacheHitRateOf：优先级与先验')
{
  const billingSamples = [
    { offerId: 'o1', reportedPrompt: 1000, reportedCached: 800 },
    { offerId: 'o1', reportedPrompt: 1000, reportedCached: 900 },
    { offerId: 'o1', reportedPrompt: 1000, reportedCached: 700 },
    { offerId: 'o2', reportedPrompt: 1000, reportedCached: 100 },
  ]
  const probes = [{ offerId: 'o1', cacheHitRate: 0.2, cacheSupported: true }]
  const r1 = cacheHitRateOf({ offerId: 'o1', probes, billingSamples })
  ok(r1.source === 'traffic', '真实流量样本够 3 条时优先用流量')
  ok(near(r1.rate, 0.8), `取中位 0.8（实测 ${r1.rate}）`)
  ok(r1.lowConfidence === false, '样本充足 → 高置信')

  const r2 = cacheHitRateOf({ offerId: 'o2', probes, billingSamples })
  ok(r2.source === 'prior', '只有 1 条流量样本时不用流量（退回探针/先验）')
  ok(r2.rate === CACHE_HIT_PRIOR, `落到先验 ${CACHE_HIT_PRIOR}`)
  ok(r2.lowConfidence === true, '先验值标记为低置信')

  const r3 = cacheHitRateOf({
    offerId: 'o3',
    probes: [
      { offerId: 'o3', cacheHitRate: 0.9, cacheSupported: true },
      { offerId: 'o3', cacheHitRate: 0.94, cacheSupported: true },
    ],
  })
  ok(r3.source === 'probe', '没有流量样本时用探针')
  ok(near(r3.rate, 0.92), '探针取中位 0.92')

  const r4 = cacheHitRateOf({ offerId: 'o4', probes: [{ offerId: 'o4', cacheSupported: false }] })
  ok(r4.rate === 0 && r4.source === 'unsupported', '探针明确测出不支持缓存 → 0（真实值，不用先验）')
  ok(r4.lowConfidence === false, '这是证据而不是猜测')

  const r5 = cacheHitRateOf({ offerId: 'o5' })
  ok(r5.source === 'prior' && r5.rate === CACHE_HIT_PRIOR, '什么证据都没有 → 先验 + 低置信')
}

console.log('tpsOf / relativeToMin')
{
  const probes = [
    { offerId: 'o1', latencyMs: 2000, ttftMs: 500, completionTokens: 300 },
    { offerId: 'o1', latencyMs: 3000, ttftMs: 600, completionTokens: 480 },
    { offerId: 'o1', latencyMs: 1000, ttftMs: 1000, completionTokens: 10 }, // 首字占满，不算
  ]
  // 第一个：300 token / 1.5s = 200；第二个：480 / 2.4s = 200
  ok(tpsOf(probes, 'o1') === 200, `输出速度取中位 200 token/s（实测 ${tpsOf(probes, 'o1')}）`)
  ok(relativeToMin(900, [300, 1200, 900]) === 600, '相对首字 = 减去同组最小值')
  ok(relativeToMin(null, [300]) === null, '没有值 → null')
}

console.log('costProfileOf：默认值与回滚开关')
{
  const d = costProfileOf({})
  ok(d.mode === 'expected', '默认 expected')
  ok(d.inputShare === 'auto', '默认输入占比跟随真实流量')
  ok(d.cacheDiscount === DEFAULT_CACHE_DISCOUNT, `默认缓存折扣 ${DEFAULT_CACHE_DISCOUNT}`)
  ok(d.cacheDiscountEnabled === true, '默认启用缓存折扣')
  ok(costProfileOf({ costProfile: { mode: 'legacy' } }).mode === 'legacy', 'legacy 是回滚开关')
  ok(costProfileOf({ costProfile: { inputShare: 0.5 } }).inputShare === 0.5, '固定输入占比可用')
  ok(costProfileOf({ costProfile: { inputShare: 7 } }).inputShare === 'auto', '越界值回落 auto')
  ok(costProfileOf({ costProfile: { cacheDiscount: 2 } }).cacheDiscount === DEFAULT_CACHE_DISCOUNT, '越界折扣回落默认')
}

console.log('effectiveInPrice / blendedWithProfile：手算对齐')
{
  ok(near(effectiveInPrice(2, 0.8, 0.9), 2 * (1 - 0.72)), '2 元输入 + 80% 命中 + k=0.9 → 0.56')
  ok(effectiveInPrice(2, null, 0.9) === 2, '没有命中率时不打折')
  ok(effectiveInPrice(null, 0.5) === null, '没有输入价 → null')

  const blended = blendedWithProfile({
    inUsdPerMtok: 1,
    outUsdPerMtok: 4,
    inputShare: 0.9,
    hitRate: 0.5,
    cacheDiscount: 0.9,
  })
  // 有效输入 = 1 × (1 − 0.45) = 0.55；混合 = 0.55×0.9 + 4×0.1 = 0.495 + 0.4 = 0.895
  ok(near(blended, 0.895), `混合价 0.895（实测 ${blended}）`)

  const legacy = blendedWithProfile({
    inUsdPerMtok: 1,
    outUsdPerMtok: 4,
    inputShare: DEFAULT_INPUT_SHARE,
    hitRate: 0.5,
    cacheDiscount: 0.9,
    cacheDiscountEnabled: false,
  })
  ok(near(legacy, 0.9 * 1 + 0.1 * 4), '关掉缓存折扣时退化为「输入价×占比 + 输出价×占比」')

  const onlyOut = blendedWithProfile({ inUsdPerMtok: null, outUsdPerMtok: 4, inputShare: 0.9, hitRate: 0.5 })
  ok(onlyOut === 4, '只有输出价时直接用输出价')
  ok(blendedWithProfile({ inUsdPerMtok: null, outUsdPerMtok: null }) === null, '两个价都没有 → null')
}

console.log('缓存折扣到底能省多少（口径自检）')
{
  // 输入 2、输出 8、输入占比 0.9、命中 85%、k=0.9
  const noCache = blendedWithProfile({ inUsdPerMtok: 2, outUsdPerMtok: 8, inputShare: 0.9, hitRate: 0, cacheDiscount: 0.9 })
  const withCache = blendedWithProfile({ inUsdPerMtok: 2, outUsdPerMtok: 8, inputShare: 0.9, hitRate: 0.85, cacheDiscount: 0.9 })
  ok(near(noCache, 2 * 0.9 + 8 * 0.1), `无缓存 2.6（实测 ${noCache}）`)
  ok(near(withCache, 2 * (1 - 0.765) * 0.9 + 8 * 0.1), `命中 85% 后 1.223（实测 ${withCache}）`)
  ok(withCache < noCache, '缓存命中确实降低有效成本')
}

if (failed > 0) {
  console.error(`${failed} 项失败`)
  process.exit(1)
}
console.log('全部通过')
