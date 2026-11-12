/**
 * 价格校准探针自检。
 *
 * 这一层最容易出两类错，都在这里钉死：
 *   A. 判定错——把「币种标错」当「价格不符」去改数字，改完更错
 *   B. 目标选错——给忽略的模型花校准费，或者漏掉该校准的
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pp = await import(join(here, '..', 'core', 'price-probe.js'))
const { judgeCalibration, pickCalibrationTargets, buildCalibrationPrompt,
        backComputePrice, planBenchmarkFixes, MIN_CALIBRATION_TOKENS,
        CALIBRATION_TOLERANCE } = pp

let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  ✓ ' + l) } else { fail++; console.log('  ✗ ' + l) } }

console.log('[A] 判定：一致 / 不符 / 币种误标')
{
  const FX = 6.6878
  // 标价 0.2，账单反推 0.2
  const same = judgeCalibration({ backIn: 0.2 }, 0.2, FX)
  ok(same.verdict === 'ok', '偏差 0% → ok')
  ok(same.suggestedPrice === null, 'ok 时不给建议价（没什么可改）')

  // 标价 0.2，账单 0.26（差 30%）
  const mis = judgeCalibration({ backIn: 0.26 }, 0.2, FX)
  ok(mis.verdict === 'mismatch', '差 30% → mismatch')
  ok(mis.suggestedPrice === 0.26, 'mismatch 给建议价 = 账单反推价')

  // 标价 0.2，账单 1.34（≈ ×6.69）
  const cur = judgeCalibration({ backIn: 0.2 * FX }, 0.2, FX)
  ok(cur.verdict === 'currency', '差 ≈ 汇率倍数 → currency（不是 mismatch）')
  ok(cur.suggestedPrice === null, 'currency 不给建议价（改数字没用，要改币种）')

  // 反向：标价 0.2，账单 0.03（≈ ÷6.69）
  const cur2 = judgeCalibration({ backIn: 0.2 / FX }, 0.2, FX)
  ok(cur2.verdict === 'currency', '反向汇率倍数也能识别（负偏差不漏判）')

  // 容差边界
  const edge = judgeCalibration({ backIn: 0.2 * (1 + CALIBRATION_TOLERANCE) }, 0.2, FX)
  ok(edge.verdict === 'ok', `正好 ${CALIBRATION_TOLERANCE * 100}% 容差 → ok`)
  const over = judgeCalibration({ backIn: 0.2 * (1 + CALIBRATION_TOLERANCE * 2) }, 0.2, FX)
  ok(over.verdict === 'mismatch', '超过容差一倍 → mismatch')

  // 缺数据
  ok(judgeCalibration(null, 0.2, FX).verdict === 'unknown', '没有账单数据 → unknown')
  ok(judgeCalibration({ backIn: 0.2 }, 0, FX).verdict === 'unknown', '标价 0 → unknown（不猜）')
}

console.log('\n[B] 目标筛选：默认排除被忽略的')
{
  const offers = [
    { id: 'o1', providerId: 'p1', upstreamName: 'gpt-6.1-sol', pricingMode: 'ratio' },
    { id: 'o2', providerId: 'p1', upstreamName: 'claude-opus-5-5', pricingMode: 'ratio' },
    { id: 'o3', providerId: 'p2', upstreamName: 'gpt-5.6-sol', pricingMode: 'ratio' },
    { id: 'o4', providerId: 'p1', upstreamName: 'gpt-image-2', pricingMode: 'call' },
  ]
  const def = pickCalibrationTargets(offers, {})
  ok(def.length === 3, '默认取全部分组（按次计费的排除）')
  ok(!def.some((o) => o.id === 'o4'), '按次计费的 o4 被排除')

  const skipIgnored = pickCalibrationTargets(offers, { ignoredIds: new Set(['o1']) })
  ok(skipIgnored.length === 2, '忽略 o1 后剩 2 条')
  ok(!skipIgnored.some((o) => o.id === 'o1'), 'o1 确实被排除')

  const byProvider = pickCalibrationTargets(offers, { providerIds: ['p2'] })
  ok(byProvider.length === 1 && byProvider[0].id === 'o3', '按站点筛选只留 p2')

  const byModel = pickCalibrationTargets(offers, { modelKeys: ['gpt'] })
  ok(byModel.length === 2, '按模型子串「gpt」筛出 o1/o3（o4 是按次已排除）')

  const onlyDrift = pickCalibrationTargets(offers, { onlyDrifted: ['o2'] })
  ok(onlyDrift.length === 1 && onlyDrift[0].id === 'o2', '只校准有预警的 o2')
}

console.log('\n[C] 校准提示词：够大、不重复')
{
  const a = buildCalibrationPrompt(1000, Math.random)
  const b = buildCalibrationPrompt(1000, Math.random)
  ok(a !== b, '两次生成的提示词不同（避免缓存命中）')
  const est = (a.length / 4)
  ok(est > MIN_CALIBRATION_TOKENS * 0.6, `提示词长度够（约 ${Math.round(est)} token 量级）`)
  ok(a.includes('OK'), '带明确的短输出指令（控制输出成本）')
}

console.log('\n[D] 账单反推价')
{
  // 账单：inputCost 0.0002 对应 1000 token → 0.2/M
  // 账单聚合行给的是已除过 token 的每百万单价（baseIn/baseOut），不是分项成本
  const r = backComputePrice(
    { prompt_tokens: 1000, completion_tokens: 4 },
    { inputTokens: 1000, outputTokens: 4, baseIn: 4, baseOut: 8 },
    0.05,   // 原价 4/8 × 倍率 0.05 = 0.2/0.4
  )
  ok(Math.abs(r.backIn - 0.2) < 1e-9, `反推输入价 = 4×0.05 = 0.2（实际 ${r.backIn}）`)
  ok(Math.abs(r.backOut - 0.4) < 1e-9, '反推输出价 = 8×0.05 = 0.4')
  ok(backComputePrice(null, {}, 0.1) === null, '缺参数返回 null，不瞎算')
}

console.log('\n[E] 修复计划：只修有问题的')
{
  const FX = 6.6878
  const db = {
    offers: [
      { id: 'o1', benchmarkKey: 'gpt-6.1-sol', modelKey: 'gpt-6.1-sol', upstreamName: 'gpt-6.1-sol', ratio: 0.05 },
      { id: 'o2', benchmarkKey: 'claude-opus-5-5', modelKey: 'claude-opus-5-5', upstreamName: 'claude-opus-5-5', ratio: 0.05 },
      { id: 'o3', benchmarkKey: 'deepseek-v4.1-flash', modelKey: 'ds', upstreamName: 'deepseek-v4.1-flash', ratio: 0.1 },
    ],
  }
  const benchmarks = {
    'gpt-6.1-sol': { in: 0.2, out: 1.0, currency: 'USD', offPeakIn: 0.1, offPeakOut: 0.5, display: 'GPT 6.1' },
    'claude-opus-5-5': { in: 0.2, out: 1.0, currency: 'USD' },
    'deepseek-v4.1-flash': { in: 0.1, out: 0.4, currency: 'USD' },
  }
  const results = [
    // ok：不能出现在计划里
    { offerId: 'o1', verdict: 'ok', listPrice: 0.2, backIn: 0.2, backOut: 1.0 },
    // mismatch：要改
    { offerId: 'o2', verdict: 'mismatch', listPrice: 0.2, backIn: 0.26, backOut: 1.3 },
    // currency：账单比标价大 fx 倍 → 应标 RUSD
    { offerId: 'o3', verdict: 'currency', listPrice: 0.1, backIn: 0.1 * FX, backOut: 0.4 * FX },
  ]
  const plan = planBenchmarkFixes(results, benchmarks, db, FX)
  ok(plan.length === 2, `只产出 2 条修复（ok 那条被跳过），实际 ${plan.length}`)
  ok(!plan.some((f) => f.modelKey === 'gpt-6.1-sol'), 'ok 的 gpt-6.1-sol 不在计划里')

  const price = plan.find((f) => f.modelKey === 'claude-opus-5-5')
  ok(price && price.kind === 'price', 'mismatch → kind=price')
  ok(price.nextIn === 0.26, `输入价建议 0.26（实际 ${price.nextIn}）`)
  ok(price.nextOut === 1.3, '输出价也一起给（之前只比 in）')

  const cur = plan.find((f) => f.modelKey === 'deepseek-v4.1-flash')
  ok(cur && cur.kind === 'currency', 'currency 单独一类')
  ok(cur.nextCurrency === 'RUSD', '账单大 fx 倍 → 改为 RUSD')
  ok(cur.nextIn === null, '币种修复不动数值（改数字没用）')

  // 用 benchmarkKey 而不是 upstreamName
  ok(plan.every((f) => f.modelKey !== 'ds'), '键用 benchmarkKey，不用 modelKey 别名')
}

console.log('\n[F] 币种反向判定')
{
  const FX = 6.6878
  const db = { offers: [{ id: 'o1', benchmarkKey: 'm1', upstreamName: 'm1', ratio: 0.05 }] }
  const benchmarks = { m1: { in: 1.34, out: 6.7, currency: 'RUSD' } }
  // 标价 1.34（RUSD 乘过汇率），账单反推 0.2 → 说明本该是 USD 不乘汇率
  const plan = planBenchmarkFixes(
    [{ offerId: 'o1', verdict: 'currency', listPrice: 1.34, backIn: 0.2, backOut: 1.0 }],
    benchmarks, db, FX,
  )
  ok(plan.length === 1 && plan[0].nextCurrency === 'USD', '账单小 fx 倍 → 改回 USD')
}

console.log('\n[G] 无意义修复被过滤')
{
  const db = { offers: [{ id: 'o1', benchmarkKey: 'm1', upstreamName: 'm1', ratio: 1 }] }
  const benchmarks = { m1: { in: 0.2, out: 1.0, currency: 'USD' } }
  // 建议值和原值差 0.1%，不该产生修复
  const plan = planBenchmarkFixes(
    [{ offerId: 'o1', verdict: 'mismatch', listPrice: 0.2, backIn: 0.2002, backOut: 1.0 }],
    benchmarks, db, 6.6878,
  )
  ok(plan.length === 0, '差异 <0.5% 不产生修复（避免无意义写入）')
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
