/**
 * 缓存命中字段自检（纯函数，不联网）。
 *
 * 回归的病：探针（core/probe.js 的 probeCache）同时认
 * prompt_tokens_details.cached_tokens 和 prompt_cache_hit_tokens，
 * 而网关记账只认前者。DeepSeek 官方接口恰恰只用后者——于是探针报
 * 「缓存命中 96%」，账单却按零缓存算，缓存读的廉价档全按输入原价结算。
 *
 * 用法：node .test/check-usage-cache.mjs
 */
import { readCachedTokens, readCacheCreationTokens } from '../daemon/server.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

console.log('[1] 各家记命中数的字段名都能认出来')
{
  ok(
    readCachedTokens({ prompt_tokens_details: { cached_tokens: 3840 } }) === 3840,
    'OpenAI 标准：prompt_tokens_details.cached_tokens',
  )
  ok(
    readCachedTokens({ input_tokens_details: { cached_tokens: 3840 } }) === 3840,
    'Responses：input_tokens_details.cached_tokens',
  )
  ok(readCachedTokens({ prompt_cache_hit_tokens: 3840 }) === 3840, 'DeepSeek 官方：prompt_cache_hit_tokens')
  ok(readCachedTokens({ cached_tokens: 3840 }) === 3840, 'one-api / new-api：顶层 cached_tokens')
  ok(
    readCachedTokens({ cache_read_input_tokens: 3840 }) === 3840,
    'Anthropic 兼容层：cache_read_input_tokens',
  )
}

console.log('[2] 字段存在但为 0 与「根本没报」是两件事')
{
  ok(readCachedTokens({ prompt_tokens_details: { cached_tokens: 0 } }) === 0, '报了 0 → 就是没命中')
  ok(readCachedTokens({ prompt_tokens: 500 }) === null, '一个都没报 → null（不编造 0）')
  ok(readCachedTokens(null) === null, 'usage 缺失 → null')
}

console.log('[3] 缓存写入（cache_creation）字段')
{
  ok(
    readCacheCreationTokens({ cache_creation_input_tokens: 1200 }) === 1200,
    'Anthropic：cache_creation_input_tokens',
  )
  ok(
    readCacheCreationTokens({ prompt_tokens_details: { cache_creation_tokens: 1200 } }) === 1200,
    'OpenAI 兼容层：prompt_tokens_details.cache_creation_tokens',
  )
  ok(readCacheCreationTokens({ prompt_tokens: 500 }) === 0, '没报 → 0（与旧行为一致）')
  ok(readCacheCreationTokens(null) === 0, 'usage 缺失 → 0')
}

console.log('[4] 计费含义：缓存数认对之后，输入不再按原价全算')
{
  // 与 core/usage.js recordUsage 同一口径：input 存净值，缓存单独记
  const split = (cached) => {
    const rawInput = 4007
    return { input: Math.max(0, rawInput - cached), cached }
  }
  const miss = split(0)
  const hit = split(readCachedTokens({ prompt_cache_hit_tokens: 3840 }))
  ok(miss.input === 4007 && hit.input === 167, 'DeepSeek 写法也能算出净值输入 167（而非 4007）')
  ok(hit.cached === 3840, '缓存数被正确记下')

  // 缓存价通常是输入价的 1/10：1750 美元/M 对 175 美元/M，差一个数量级
  const inPrice = 10
  const cachePrice = 1
  const overcharge = miss.input * inPrice
  const correct = hit.input * inPrice + hit.cached * cachePrice
  ok(overcharge === 40070 && correct === 5510, `花费由 ${overcharge} 降到 ${correct}（少算 86%）`)
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}
