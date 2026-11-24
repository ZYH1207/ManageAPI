/**
 * 缓存命中率「实际口径」的测试：字段归一 / 逐单样本 / 冷启动剔除 / 收缩 / 一票否决。
 *
 * 这些数字会折进价格参与选站，所以每一条规则都要能指着测例说清楚，
 * 而不是靠「看起来差不多」。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'mapi-cache-'))
process.env.MANAGE_API_HOME = home

const { usageNumbers } = await import('../core/wire.js')
const { recordCacheSample, readCacheSamples, recentCacheSamples, resetCacheSampleRing } = await import(
  '../core/cache-samples.js'
)
const {
  splitCacheSamples,
  cacheActualOf,
  cacheHitRateOf,
  CACHE_HIT_PRIOR,
  CACHE_SHRINK_TOKENS,
} = await import('../core/traffic-profile.js')

let failed = 0
function ok(cond, message) {
  if (cond) console.log('  ✓ ' + message)
  else {
    failed += 1
    console.error('  ✗ ' + message)
  }
}
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

// ── 1. usageNumbers：五路缓存字段都要认 ----
console.log('usageNumbers')
{
  const a = usageNumbers({ prompt_tokens: 14498, completion_tokens: 463, prompt_tokens_details: { cached_tokens: 14464 } })
  ok(a.cachedTokens === 14464, 'prompt_tokens_details.cached_tokens 认得')
  ok(a.netInputTokens === 34, '14498 - 14464 → 净输入 34（几乎全命中）')
  ok(a.billedInputTokens === 14498, '计费输入 = 净 + 缓存读 = prompt_tokens')
  ok(close(a.hitRate, 14464 / 14498), '命中率 = 缓存读 ÷ 计费输入')

  const b = usageNumbers({ prompt_tokens: 1000, cached_tokens: 500 })
  ok(b.cachedTokens === 500, '顶层 cached_tokens 认得')

  const c = usageNumbers({ prompt_tokens: 1000, prompt_cache_hit_tokens: 600 })
  ok(c.cachedTokens === 600, 'DeepSeek 的 prompt_cache_hit_tokens 认得')

  const d = usageNumbers({ prompt_tokens: 1000, cache_read_input_tokens: 700 })
  ok(d.cachedTokens === 700, 'Anthropic 的 cache_read_input_tokens 认得')

  const e = usageNumbers({
    prompt_tokens: 1000,
    prompt_tokens_details: { cached_tokens: 0 },
    cache_read_input_tokens: 800,
  })
  ok(e.cachedTokens === 800, '两个字段都在时取更大的（一个恒为 0 的坑）')

  const f = usageNumbers({ prompt_tokens: 1000 })
  ok(f.hasCacheFields === false, '一个缓存字段都没有 → hasCacheFields=false（不是 0 命中）')
  ok(f.cachedTokens === 0 && f.hitRate === null, '没有字段时命中率是 null，不是 0')

  const g = usageNumbers({ input_tokens: 2000, output_tokens: 10, cache_creation_input_tokens: 500 })
  ok(g.promptTokens === 2000 && g.completionTokens === 10, 'input_tokens/output_tokens 命名也认')
  ok(g.cacheWriteTokens === 500, 'cache_creation_input_tokens 计入缓存写')
  ok(g.netInputTokens === 1500, '净输入扣掉缓存写')
}

// ── 2. 逐单样本：落盘 + 读回 + 窗口 ----
console.log('cache-samples')
{
  const now = Date.now()
  resetCacheSampleRing()
  await recordCacheSample({ at: now - 1000, offerId: 'o1', promptTokens: 100, cachedTokens: 90 })
  await recordCacheSample({ at: now, offerId: 'o2', promptTokens: 200, cachedTokens: 0, cacheWriteTokens: 200 })
  await recordCacheSample({ at: now, offerId: 'o1', promptTokens: 0, cachedTokens: 5 })
  ok(recentCacheSamples(10).length === 2, 'prompt<=0 的样本被丢弃')
  const rows = await readCacheSamples({ now })
  ok(rows.length === 2, '读回两条（当天文件）')
  ok(rows[0].offerId === 'o1' && rows[1].offerId === 'o2', '按时间升序')
  const empty = await readCacheSamples({ now: now + 40 * 24 * 3600 * 1000 })
  ok(empty.length === 0, '窗口外的样本不再参与统计')
}

// ── 3. 冷启动剔除 ----
console.log('splitCacheSamples')
{
  const t0 = 1_700_000_000_000
  const warm = { at: t0, offerId: 'x', prompt: 100000, cached: 95000, cacheWrite: 0 }
  const rows = [
    { at: t0, offerId: 'x', prompt: 100000, cached: 0, cacheWrite: 0 }, // 第 1 条：没有基线
    { at: t0 + 1000, offerId: 'x', prompt: 100000, cached: 98000, cacheWrite: 0 }, // 第 2 条：仍算冷启动
    warm, // 第 3 条：warm 基线
    { at: warm.at + 60 * 1000, offerId: 'x', prompt: 100000, cached: 97000, cacheWrite: 0 }, // warm
    { at: warm.at + 120 * 1000, offerId: 'x', prompt: 100000, cached: 0, cacheWrite: 100000 }, // 只写缓存
    { at: warm.at + 30 * 60 * 1000, offerId: 'x', prompt: 100000, cached: 1000, cacheWrite: 0 }, // 隔太久
    { at: warm.at + 31 * 60 * 1000, offerId: 'x', prompt: 400000, cached: 500, cacheWrite: 0 }, // 前缀变大
  ]
  const { warm: w, cold: c } = splitCacheSamples(rows)
  ok(c.length === 5, `冷启动剔除 5 条（实际 ${c.length}）`)
  ok(w.length === 2, `warm 保留 2 条（实际 ${w.length}）`)
  ok(c.some((r) => r.reason === 'cache-write'), '只写缓存不命中 → 判冷启动')
  ok(c.some((r) => r.reason === 'stale'), '隔太久且不命中 → 判冷启动')
  ok(c.some((r) => r.reason === 'prefix'), '前缀变大且不命中 → 判冷启动')
}

// ── 4. 收缩：小样本被拉回先验，大样本贴近实测 ----
console.log('cacheActualOf')
{
  const t0 = 1_700_000_000_000
  const small = [
    { at: t0, offerId: 's', prompt: 231333, cached: 13056, cacheWrite: 0 },
    { at: t0 + 1000, offerId: 's', prompt: 200000, cached: 190000, cacheWrite: 0 },
    { at: t0 + 2000, offerId: 's', prompt: 200000, cached: 190000, cacheWrite: 0 },
  ]
  const a = cacheActualOf({ offerId: 's', samples: small })
  // 第 1 条冷启动被剔除；warm 两条 190k/190k → rate 被收缩拉向先验
  ok(a.source === 'actual', '有 warm 样本 → source=actual')
  ok(a.raw > 0.9, `raw 只算 warm（${(a.raw * 100).toFixed(1)}%）`)
  ok(a.rate < a.raw, '收缩后低于 raw（向先验靠）')
  ok(a.lowConfidence === true, '两条 warm → 低置信')
  ok(a.coldSamples >= 1, '记录被剔除的冷启动条数')

  const big = []
  for (let i = 0; i < 40; i += 1) {
    big.push({ at: t0 + i * 60000, offerId: 'b', prompt: 150000, cached: 141000, cacheWrite: 0 })
  }
  const b = cacheActualOf({ offerId: 'b', samples: big })
  ok(b.lowConfidence === false, '40 条 × 150k → 高置信')
  ok(Math.abs(b.rate - b.raw) < 0.01, '样本足够时收缩几乎不动')
  ok(b.warmTokens > 40 * 140000, 'warm token 累计正确')

  const none = cacheActualOf({ offerId: 'zzz', samples: [] })
  ok(none.source === 'prior' && close(none.rate, CACHE_HIT_PRIOR), '没有样本 → 用先验且标 prior')
  ok(none.lowConfidence === true, '先验必然低置信')

  const single = cacheActualOf({ offerId: 'one', samples: [{ at: t0, offerId: 'one', prompt: 900000, cached: 1000 }] })
  ok(single.rate > 0.5, '单条冷启动样本 → 收缩后被拉回先验附近，不会判 0.1%')

  ok(CACHE_SHRINK_TOKENS > 0, '收缩强度是正数')
}

// ── 5. 一票否决：只有「所有探测都说不支持」才判 0 ----
console.log('cacheHitRateOf')
{
  const mixed = cacheHitRateOf({
    offerId: 'm',
    probes: [
      { offerId: 'm', cacheSupported: false },
      { offerId: 'm', cacheSupported: true, cacheHitRate: 0.9 },
      { offerId: 'm', cacheSupported: true, cacheHitRate: 0.8 },
    ],
  })
  ok(mixed.source === 'probe' && close(mixed.rate, 0.85), '一条说不支持不再一票否决（取探针中位 0.85）')

  const allFalse = cacheHitRateOf({
    offerId: 'n',
    probes: [
      { offerId: 'n', cacheSupported: false },
      { offerId: 'n', cacheSupported: false },
    ],
  })
  ok(allFalse.source === 'unsupported' && allFalse.rate === 0, '全部探测都说不支持 → 真实 0')

  const once = cacheHitRateOf({ offerId: 'o', probes: [{ offerId: 'o', cacheSupported: false }] })
  ok(once.source !== 'unsupported', '只有一条「不支持」不足以判 0')
}

await rm(home, { recursive: true, force: true })
if (failed > 0) {
  console.error(failed + ' 项失败')
  process.exit(1)
}
console.log('全部通过')