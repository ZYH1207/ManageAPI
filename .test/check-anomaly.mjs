/**
 * 异常诊断（core/anomaly.js）测试。
 *
 * 场景来自现实：中转站把速度砍半、偷偷关思考、关缓存、输出截短、
 * 探针绿灯但真实流量一半失败。每条规则都要能「只因为特定变化」触发，
 * 不能因为别的指标顺手也变了就误报。
 *
 * 跑法：node .test/check-anomaly.mjs
 */
import assert from 'node:assert/strict'
import {
  mergeWindow,
  windowMetrics,
  splitWindows,
  peerTtftByModel,
  detectAnomalies,
  MIN_REQUESTS,
  RECENT_HOURS,
  BASELINE_DAYS,
} from '../core/anomaly.js'

let n = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  n += 1
}
const eq = (a, b, label) => {
  assert.deepEqual(a, b, label)
  n += 1
}

/** 构造一个小时桶 */
function bucket(hoursAgo, over = {}) {
  const d = new Date(Date.now() - hoursAgo * 3600000)
  const hour = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`
  return {
    offerId: 'o_1',
    hour,
    requests: 10,
    ok: 10,
    broken: 0,
    failed: 0,
    ttftSum: 2000 * 10,
    ttftCount: 10,
    latencySum: 10000 * 10,
    latencyCount: 10,
    genOutSum: 500 * 10,
    genCount: 10,
    genTimeSum: 5000 * 10,
    inputTokens: 100000,
    outputTokens: 5000,
    cachedTokens: 90000,
    reasoningTokens: 2000,
    estCostSum: 0.1 * 10,
    estCostCount: 10,
    streamGapMax: 500,
    errors: {},
    ...over,
  }
}

// 基线：6 小时之前、7 天之内，构造 20 个小时桶（每桶 10 单 = 200 单）
function baselineBuckets(over = {}) {
  const out = []
  for (let h = RECENT_HOURS + 2; h < RECENT_HOURS + 2 + 20; h++) out.push(bucket(h, over))
  return out
}
// 近期：最近 6 小时内，3 个小时桶 = 30 单
function recentBuckets(over = {}) {
  return [bucket(1, over), bucket(2, over), bucket(3, over)]
}

function statsOf(list) {
  const s = {}
  for (const b of list) s[`${b.offerId}|${b.hour}`] = b
  return s
}

const meta = new Map([['o_1', { label: '绿萝 · deepseek-v4.1-flash', modelKey: 'deepseek-v4.1-flash' }]])

// ---------------------------------------------------------------- 窗口切分
{
  const stats = statsOf([...baselineBuckets(), ...recentBuckets()])
  const w = splitWindows(stats).get('o_1')
  eq(w.recentM.requests, 30, '近期窗口 3 桶 × 10 单')
  eq(w.baselineM.requests, 200, '基线窗口 20 桶 × 10 单')
  // 超出 7 天的桶被丢掉（既不算近期也不算基线）
  const old = bucket(24 * 8)
  eq(splitWindows(statsOf([old])).size, 0, '超出基线上限的桶整条丢弃')
}

// ---------------------------------------------------------------- 指标计算
{
  const m = mergeWindow([bucket(1), bucket(2)])
  const met = windowMetrics(m)
  eq(met.ttft, 2000, '首字均值')
  eq(Math.round(met.tps), 100, '吐字速度 = 5000 / 5s')
  eq(met.cacheHit, 0.9, '缓存命中 = 90000/100000')
  eq(met.reasoningRatio, 0.4, '思考占比 = 2000/5000')
  eq(met.outPerReq, 500, '单请求输出 = 5000/10')
  // 全空窗口给 null，不给 0
  const empty = windowMetrics(mergeWindow([]))
  eq(empty.ttft, null, '无样本首字为 null')
  eq(empty.tps, null, '无样本速度为 null')
}

// ---------------------------------------------------------------- 规则①变慢
{
  const stats = statsOf([...baselineBuckets(), ...recentBuckets({ ttftSum: 6000 * 10 })])
  const f = detectAnomalies({ offerStats: stats, offerMeta: meta })
  const hit = f.find((x) => x.id.startsWith('ttft-regress-'))
  ok(hit, '首字从 2s 涨到 6s → 报变慢')
  eq(hit.severity, 'danger', '慢 3 倍 → danger')
  ok(hit.title.includes('6.0s') && hit.title.includes('2.0s'), '结论同时给出当前值与基线值')
  eq(hit.category, 'anomaly', '归入异常类')

  // 只慢一点（1.2 倍）不报
  const stats2 = statsOf([...baselineBuckets(), ...recentBuckets({ ttftSum: 2400 * 10 })])
  eq(detectAnomalies({ offerStats: stats2, offerMeta: meta }).filter((x) => x.id.startsWith('ttft-regress-')).length, 0, '只慢 1.2 倍不报')

  // 样本不足不报
  const stats3 = statsOf([...baselineBuckets(), bucket(1, { ttftSum: 9000 * 10 })])
  eq(detectAnomalies({ offerStats: stats3, offerMeta: meta }).filter((x) => x.id.startsWith('ttft-regress-')).length, 0, `近期样本 < ${MIN_REQUESTS} 不报`)
}

// ---------------------------------------------------------------- 规则②吐字变慢
{
  // 生成时间翻倍 → TPS 减半
  const stats = statsOf([...baselineBuckets(), ...recentBuckets({ genTimeSum: 10000 * 10 })])
  const hit = detectAnomalies({ offerStats: stats, offerMeta: meta }).find((x) => x.id.startsWith('tps-drop-'))
  ok(hit, 'TPS 减半 → 报吐字变慢')
  ok(hit.title.includes('字/秒'), '结论用人话单位')
}

// ---------------------------------------------------------------- 规则③偷思考
{
  const stats = statsOf([
    ...baselineBuckets({ reasoningTokens: 3000 }), // 思考占 3000/5000 = 60%
    ...recentBuckets({ reasoningTokens: 20 }), // 掉到 0.4%
  ])
  const hit = detectAnomalies({ offerStats: stats, offerMeta: meta }).find((x) => x.id.startsWith('think-stolen-'))
  ok(hit, '思考占比 60% → 0.4% → 报偷思考')
  ok(hit.title.includes('60%'), '结论给出基线百分比')
  ok(hit.detail.includes('降智'), '说明危害')

  // 基线本来就没思考（比如非推理模型）→ 不报
  const stats2 = statsOf([...baselineBuckets({ reasoningTokens: 0 }), ...recentBuckets({ reasoningTokens: 0 })])
  eq(detectAnomalies({ offerStats: stats2, offerMeta: meta }).filter((x) => x.id.startsWith('think-stolen-')).length, 0, '基线没思考就不谈偷')
}

// ---------------------------------------------------------------- 规则④缓存被关
{
  const stats = statsOf([
    ...baselineBuckets({ cachedTokens: 95000 }), // 95%
    ...recentBuckets({ cachedTokens: 1000 }), // 1%
  ])
  const hit = detectAnomalies({ offerStats: stats, offerMeta: meta }).find((x) => x.id.startsWith('cache-off-'))
  ok(hit, '缓存命中 95% → 1% → 报缓存被关')
  ok(hit.detail.includes('成本') || hit.detail.includes('花费'), '说明对成本的影响')

  // 基线本来就不高（60% 以下）→ 不报
  const stats2 = statsOf([...baselineBuckets({ cachedTokens: 50000 }), ...recentBuckets({ cachedTokens: 5000 })])
  eq(detectAnomalies({ offerStats: stats2, offerMeta: meta }).filter((x) => x.id.startsWith('cache-off-')).length, 0, '基线命中率不高就不报')
}

// ---------------------------------------------------------------- 规则⑤输出变短
{
  const stats = statsOf([
    ...baselineBuckets({ outputTokens: 5000 }),
    ...recentBuckets({ outputTokens: 1000 }), // 每单 100 字
  ])
  const hit = detectAnomalies({ offerStats: stats, offerMeta: meta }).find((x) => x.id.startsWith('output-shrink-'))
  ok(hit, '平均输出 500 → 100 → 报输出变短')
  ok(hit.action.includes('探针'), '建议重测指纹/截断')
}

// ---------------------------------------------------------------- 规则⑥间歇抽风
{
  const stats = statsOf([
    ...baselineBuckets(),
    ...recentBuckets({ ok: 7, broken: 2, failed: 1 }), // 失败率 30%
  ])
  const scores = { o_1: { status: 'healthy', routable: true } }
  const hit = detectAnomalies({ offerStats: stats, offerMeta: meta, scores }).find((x) => x.id.startsWith('intermittent-'))
  ok(hit, '探针健康但真实失败 30% → 报间歇抽风')
  eq(hit.severity, 'danger', '间歇抽风 = danger（看着正常但会报错）')
  ok(hit.detail.includes('探针'), '点明探针测不出这类问题')

  // 探针本来就说它不健康 → 不重复报（那是探针的活儿）
  const scores2 = { o_1: { status: 'unstable', routable: false } }
  eq(
    detectAnomalies({ offerStats: stats, offerMeta: meta, scores: scores2 }).filter((x) => x.id.startsWith('intermittent-')).length,
    0,
    '探针已判不健康就不重复报',
  )
}

// ---------------------------------------------------------------- 跨站参照
{
  // o_1 变慢，同模型 o_2 正常 → 结论里应说明「别家正常」
  const other = (h) => ({ ...bucket(h), offerId: 'o_2' })
  const stats = statsOf([
    ...baselineBuckets(),
    ...recentBuckets({ ttftSum: 8000 * 10 }),
    ...Array.from({ length: 20 }, (_, i) => other(RECENT_HOURS + 2 + i)),
    ...[1, 2, 3].map((h) => other(h)),
  ])
  const meta2 = new Map([
    ['o_1', { label: '绿萝 · deepseek', modelKey: 'deepseek' }],
    ['o_2', { label: '秋 · deepseek', modelKey: 'deepseek' }],
  ])
  const peers = peerTtftByModel(splitWindows(stats), meta2)
  eq(Math.round(peers.get('o_1')), 2000, '同模型参照取别家首字（中位数）')
  const hit = detectAnomalies({ offerStats: stats, offerMeta: meta2 }).find((x) => x.id.startsWith('ttft-regress-o_1'))
  ok(hit.title.includes('绿萝'), '结论指明是哪一家')
  ok(hit.detail.includes('别家正常'), '明确指出是同模型里只有这家慢')
}

// ---------------------------------------------------------------- 汇总行为
{
  // 什么都没变 → 一条都不报（最重要的性质：不误报）
  const stats = statsOf([...baselineBuckets(), ...recentBuckets()])
  eq(detectAnomalies({ offerStats: stats, offerMeta: meta }).length, 0, '指标没变化 → 零误报')

  // 空数据不炸
  eq(detectAnomalies({}).length, 0, '空账本 → 空结论')
  eq(detectAnomalies({ offerStats: {} }).length, 0, '空时间序列 → 空结论')

  // 多条同时命中时按严重度排序
  const stats2 = statsOf([
    ...baselineBuckets({ reasoningTokens: 3000 }),
    ...recentBuckets({ ttftSum: 9000 * 10, reasoningTokens: 10, ok: 7, broken: 2, failed: 1 }),
  ])
  const many = detectAnomalies({ offerStats: stats2, offerMeta: meta, scores: { o_1: { status: 'healthy' } } })
  ok(many.length >= 3, `多条异常同时命中（实际 ${many.length} 条）`)
  eq(many[0].severity, 'danger', 'danger 排最前')
}

// ---------------------------------------------------------------- 常量体检
{
  ok(RECENT_HOURS > 0 && BASELINE_DAYS > RECENT_HOURS / 24, '窗口常量合理')
  ok(MIN_REQUESTS >= 10, '最少样本不至于太少')
}

console.log(`check-anomaly: ${n} 项全部通过`)
