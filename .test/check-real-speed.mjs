#!/usr/bin/env node
/**
 * 真实速度按 prompt 分档：单元级验证。
 *
 * 要证的四件事：
 *   1. 样本能带上「它是在多大的前缀上量出来的」；
 *   2. 选尺子时按本次请求自己的档取中位，取不到同档就明说未同档；
 *   3. 未同档的实测不给超额（和探针档同一条规矩，不是新发明）；
 *   4. 造尺子时排除未同档样本，否则短请求的漂亮数字会把整把尺子拉快。
 *
 * 为什么要有这条测试：2026-11 之前「真实速度」整档从未生效过（server.js 的
 * bufferTraffic 少传一个实参，speed 永远是 null），所以任何单元测试都得同时
 * 盯住「口径」和「有没有数据」两件事。数据那条链路由 check-real-speed-e2e.mjs 管。
 */
import { experienceScores, experienceScore, EXPERIENCE_PRIOR } from '../core/experience.js'
import { scoreOffers } from '../core/score.js'
import {
  bucketOfPrompt,
  bucketLabel,
  speedRowsOf,
  bucketStats,
  selectBucketSpeed,
  ttftMsPerKiloToken,
  MIN_BUCKET_SAMPLES,
} from '../core/speed-profile.js'

let failed = 0
function ok(cond, message) {
  if (cond) console.log('  ✓ ' + message)
  else {
    console.error('  ✗ ' + message)
    failed += 1
  }
}

console.log('prompt 分档')
ok(bucketOfPrompt(30_000) === 'short', '3 万 token → 短前缀')
ok(bucketOfPrompt(100_000) === 'mid', '10 万 token → 中前缀')
ok(bucketOfPrompt(210_000) === 'long', '21 万 token → 长前缀')
ok(bucketOfPrompt(null) === null, '没有大小（老样本）→ null，不硬塞一档')
ok(bucketOfPrompt(0) === null, '0 也不算有效大小')
ok(bucketLabel('long') === '长对话', '档位有人话名字（界面上叫「长对话」，不叫「长前缀」）')
ok(bucketLabel(null) === '', '未知档返回空串，界面不硬写「未知」')

console.log('\n样本整理：新旧两种 schema')
{
  const fresh = {
    samples: 2,
    rows: [
      { ttftMs: 1200, tps: 55, promptTokens: 200000, cachedTokens: 198000, at: '2026-11-26T00:00:00Z' },
      { ttftMs: 900, tps: 60, promptTokens: 0, at: '2026-11-26T00:00:01Z' },
    ],
  }
  const rows = speedRowsOf(fresh)
  ok(rows.length === 2, '新 schema 读出 2 条')
  ok(rows[0].promptTokens === 200000, '带上 prompt 大小')
  ok(rows[1].promptTokens === null, '0 / 缺失大小 → null（只能进全档）')

  const legacy = { samples: 3, ttftMs: [1000, 2000, 3000], tps: [50, 51] }
  const old = speedRowsOf(legacy)
  ok(old.length === 3, '老 schema（平行数组）也能读，不至于让界面空白')
  ok(old.every((row) => row.promptTokens === null), '老样本没有大小 → 不参与同档比较')
  ok(old[2].tps === null, '老数组长度不一致时不瞎补 tps')
  ok(speedRowsOf(null).length === 0, '没有 speed 对象 → 0 条')
  ok(speedRowsOf({ rows: [{ ttftMs: -5 }] }).length === 0, '首字非正数的脏样本被丢掉')
}

console.log('\n按档取中位')
{
  const rows = [
    { ttftMs: 5000, tps: 50, promptTokens: 40_000 },
    { ttftMs: 6000, tps: 50, promptTokens: 50_000 },
    { ttftMs: 7000, tps: 50, promptTokens: 55_000 },
    { ttftMs: 34000, tps: 40, promptTokens: 210_000 },
    { ttftMs: 35000, tps: 40, promptTokens: 220_000 },
    { ttftMs: 36000, tps: 40, promptTokens: 230_000 },
  ]
  const short = bucketStats(rows, 'short')
  ok(short.ttftMs === 6000 && short.samples === 3, '短前缀档中位 6000ms / 3 条')
  const long = bucketStats(rows, 'long')
  ok(long.ttftMs === 35000, '长前缀档中位 35000ms（不会被短样本拉低）')
  ok(bucketStats(rows, null).ttftMs === 20500, '全档中位是混在一起的数（只用于兜底）')
  ok(bucketStats(rows, 'mid').samples === 0, '中档没有样本')
  // 没有解码速度的样本不能当成 0 tok/s 参与中位
  ok(bucketStats([{ ttftMs: 1000, tps: null }, { ttftMs: 1100, tps: 50 }], null).tps === 50, 'tps 缺失不拉低中位')
}

console.log('\n选尺子：同档优先，取不到就明说未同档')
{
  const speed = {
    rows: [
      { ttftMs: 5000, tps: 50, promptTokens: 40_000 },
      { ttftMs: 6000, tps: 50, promptTokens: 50_000 },
      { ttftMs: 7000, tps: 50, promptTokens: 55_000 },
      { ttftMs: 34000, tps: 40, promptTokens: 210_000 },
    ],
  }
  const long = selectBucketSpeed(speed, 200_000)
  ok(long.matched === false, `长前缀只有 1 条样本（<${MIN_BUCKET_SAMPLES}）→ 未同档`)
  ok(long.ttftMs === 6500, `退回全档中位 6500ms（实际 ${long.ttftMs}）：明确标记，不当成同档证据`)
  ok(long.wantBucket === 'long', '仍然告诉调用方「本次请求想要哪一档」')

  const shortPick = selectBucketSpeed(speed, 30_000)
  ok(shortPick.matched === true, '短前缀有 3 条 → 同档匹配')
  ok(shortPick.bucket === 'short' && shortPick.ttftMs === 6000, '取的是短前缀档的中位')
  ok(shortPick.byBucket.long.ttftMs === 34000, '三档统计一起下发，界面能画出「长前缀惩罚」')

  const none = selectBucketSpeed(null, 200_000)
  ok(none.ttftMs === null && none.samples === 0 && none.matched === false, '没有任何样本 → null 且未同档')
}

console.log('\n每 1k token 的首字：长前缀惩罚有多陡')
ok(ttftMsPerKiloToken(34000, 200_000) === 170, '34s / 20 万 token = 每 1k token 170ms')
ok(ttftMsPerKiloToken(5300, 100_000) === 53, '5.3s / 10 万 token = 每 1k token 53ms')
ok(ttftMsPerKiloToken(null, 100_000) === null, '没有首字 → null')
ok(ttftMsPerKiloToken(1000, 0) === null, '没有大小 → null')

console.log('\n体验分：未同档的实测不给超额')
{
  const baseline = { real: { ttft: 10_000, tps: 40, samples: 5 }, probe: { ttft: 3_000, tps: 50, samples: 5 } }
  const unmatched = experienceScore(
    { trafficTtftMs: 2_000, trafficTps: 80, trafficTtftMatched: false, trafficTtftBucket: null },
    baseline,
  )
  ok(unmatched.tier === 'real', '有实测就走真实档（不降级成探针档）')
  ok(unmatched.score === EXPERIENCE_PRIOR && unmatched.capped === true, '比中位快但未同档 → 压回中位水平')
  ok(unmatched.bucketMatched === false, '返回值里带 bucketMatched，界面能说清为什么压')

  const matched = experienceScore(
    { trafficTtftMs: 2_000, trafficTps: 80, trafficTtftMatched: true, trafficTtftBucket: 'long' },
    baseline,
  )
  ok(matched.capped === false && matched.score > EXPERIENCE_PRIOR, '同档又快 → 允许超额')
  ok(matched.bucket === 'long', '返回值里带档名')
}

console.log('\n证据太少时往 1.00 收缩（一条样本判不了生死）')
{
  const baseline = { real: { ttft: 10_000, tps: 40, samples: 9 }, probe: { ttft: 3_000, tps: 50, samples: 9 } }
  // 这条实测样样都只有中位的一半 → 原始偏差就是 score=0.5
  const row = { trafficTtftMs: 20_000, trafficTps: 20, trafficTtftMatched: true, trafficTtftBucket: 'long' }
  const one = experienceScore({ ...row, trafficSpeedSamples: 1 }, baseline)
  const three = experienceScore({ ...row, trafficSpeedSamples: MIN_BUCKET_SAMPLES }, baseline)
  const unknown = experienceScore(row, baseline)
  ok(three.score === 0.5, `攒够样本就全额计入（${three.score}）`)
  ok(one.score > three.score, `1 条样本被往 1.00 拉（${one.score.toFixed(3)} > ${three.score.toFixed(3)}）`)
  ok(one.confidence === 1 / MIN_BUCKET_SAMPLES && three.confidence === 1, 'confidence 随样本数上升，满额即 1')
  ok(unknown.score === three.score, '老调用方不传样本数时按证据充分处理，语义不变')
  ok(one.samples === 1 && three.samples === MIN_BUCKET_SAMPLES, '返回值里带上用了多少样本')
}

console.log('\n造尺子：未同档样本不参与（否则尺子被拉快）')
{
  const { map, baseline } = experienceScores([
    { offerId: 'a', trafficTtftMs: 10_000, trafficTps: 40, trafficTtftMatched: true, trafficTtftBucket: 'long' },
    { offerId: 'b', trafficTtftMs: 1_000, trafficTps: 90, trafficTtftMatched: false, trafficTtftBucket: null },
    { offerId: 'c', ttftMs: 3_000, tps: 50 },
  ])
  ok(baseline.real.ttft === 10_000, `真实档尺子只用同档样本（实际 ${baseline.real.ttft}）`)
  ok(baseline.probe.ttft === 3_000, '探针档尺子照旧只看探针')
  ok(map.get('b').tier === 'real', 'b 仍然走真实档，只是不给超额')
  ok(map.get('b').capped === true, 'b 被压回中位水平')
}

console.log('\n评分层：选站时按本次请求的档取真实首字')
{
  const now = Date.now()
  const ts = new Date(now - 60_000).toISOString()
  const probeOf = (offerId) => ({
    offerId,
    ok: true,
    ts,
    fingerprintOk: true,
    truncated: false,
    billingInflated: false,
    ttftMs: 120,
    latencyMs: 900,
  })
  const speed = {
    samples: 6,
    rows: [
      { ttftMs: 5000, tps: 50, promptTokens: 40_000 },
      { ttftMs: 6000, tps: 50, promptTokens: 50_000 },
      { ttftMs: 7000, tps: 50, promptTokens: 55_000 },
      { ttftMs: 34000, tps: 40, promptTokens: 210_000 },
      { ttftMs: 35000, tps: 40, promptTokens: 220_000 },
      { ttftMs: 36000, tps: 40, promptTokens: 230_000 },
    ],
  }
  const probes = [probeOf('o1')]
  // 注意 since：真实流量的计数只在 1 小时窗口内算证据（score.js freshTraffic）
  const traffic = { o1: { ok: 6, fail: 0, since: ts, lastOkAt: ts, speed } }

  const long = scoreOffers(probes, traffic, { promptTokens: 200_000 }).get('o1')
  ok(long.trafficTtftMs === 35000, `20 万 token 的请求看到长前缀中位 35s（实际 ${long.trafficTtftMs}）`)
  ok(long.trafficTtftBucket === 'long' && long.trafficTtftMatched === true, '标记同档')

  const short = scoreOffers(probes, traffic, { promptTokens: 30_000 }).get('o1')
  ok(short.trafficTtftMs === 6000, `3 万 token 的请求看到短前缀中位 6s（实际 ${short.trafficTtftMs}）`)
  ok(short.trafficTtftBucket === 'short', '标记短档')

  const noPrompt = scoreOffers(probes, traffic, {}).get('o1')
  ok(noPrompt.trafficTtftMs === 20500, '不知道请求大小时退回全档中位')
  // 列表/汇总这种「没有具体请求在定价」的场合，全档中位就是总体本身，不算跨档混算；
  // 否则「供给列表」里所有真实档都会被压回 1.00，体验分那列等于废掉
  ok(noPrompt.trafficTtftMatched === true, '不声明同档，但也不算证据不足（不给压回）')
  ok(noPrompt.trafficSpeedSamples === 6 && noPrompt.trafficSpeedByBucket.long.samples === 3, '三档统计一并给出')

  const legacyOnly = scoreOffers(probes, { o1: { ok: 2, since: ts, lastOkAt: ts, speed: { samples: 2, ttftMs: [1200, 1400], tps: [50] } } }, { promptTokens: 200_000 }).get('o1')
  ok(legacyOnly.trafficTtftMs === 1300, '老 schema 的平行数组仍然能出数（唯一样本量纲未知）')
  ok(legacyOnly.trafficTtftMatched === false, '但它证明不了「20 万 token 也这么快」→ 未同档')
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}
