#!/usr/bin/env node
/**
 * 计费判据必须在**同一个请求内**比较：prompt_tokens 与 cached_tokens 出自同一次调用。
 *
 * 反例（曾经真的这么写过）：拿指纹请求的 prompt_tokens（~45 token 的短 prompt）
 * 去减缓存请求的 cached_tokens（14k 长前缀），两个请求长度差一个数量级，
 * 减出来的数既不是任何一次请求的计费输入，还把「系统提示很长但每次都命中缓存」
 * 的站判成多收钱——实测 40% 的探针被冤枉成「结果可疑」。
 */
import { billingVerdict } from '../core/probe.js'
import { scoreOffers } from '../core/score.js'

let failed = 0
function ok(cond, message) {
  if (cond) console.log('  ✓ ' + message)
  else {
    console.error('  ✗ ' + message)
    failed += 1
  }
}

console.log('用户遇到的那条：指纹报 14498，缓存请求命中 14464')
{
  // 缓存请求本地估算 ~2000 token，站点上报 14498（含很长系统提示），命中 14464
  const v = billingVerdict({
    fingerprintPromptTokens: 14498,
    cachePromptTokens: 14498,
    cacheCachedTokens: 14464,
    expectedCachePromptTokens: 2000,
  })
  ok(v.billedInputTokens === 34, '同请求内计费输入只剩 34 token')
  ok(v.billedInputInflated === false, '不再判成多收钱（旧算法会判 true）')
  ok(v.cacheSuspect === false, '命中率 99.8% 但未到 99.9% 阈值 → 不算可疑')
  ok(v.fixedOverheadTokens === 14453, '固定开销照旧记录（展示用，不扣分）')
}

console.log('真正的多收钱：缓存请求报 14498、只命中 100')
{
  const v = billingVerdict({
    fingerprintPromptTokens: 14498,
    cachePromptTokens: 14498,
    cacheCachedTokens: 100,
    expectedCachePromptTokens: 2000,
  })
  ok(v.billedInputInflated === true, '扣掉缓存后仍远超估算 → 判多收钱')
}

console.log('正常站：估算 2000，上报 2050，命中 1900')
{
  const v = billingVerdict({
    fingerprintPromptTokens: 2050,
    cachePromptTokens: 2050,
    cacheCachedTokens: 1900,
    expectedCachePromptTokens: 2000,
  })
  ok(v.billedInputInflated === false, '正常范围不误报')
}

console.log('缓存探测失败（拿不到同请求的两个数）→ 没有证据，不是「有问题」')
{
  const v = billingVerdict({ fingerprintPromptTokens: 14498 })
  ok(v.billedInputInflated === null, 'billedInputInflated = null')
  ok(v.billedInputTokens === null, 'billedInputTokens = null')
  ok(v.fixedOverheadTokens === 14453, '固定开销仍然可算')
}

console.log('缓存字段缺失（站点不报 cached）→ 全额都算输入，会判多收钱')
{
  const v = billingVerdict({
    fingerprintPromptTokens: 2000,
    cachePromptTokens: 2000,
    cacheCachedTokens: null,
    expectedCachePromptTokens: 2000,
  })
  ok(v.billedInputTokens === 2000, 'billedInput = prompt')
  ok(v.billedInputInflated === false, '2000 未超过 3 倍估算，不误报')
}

console.log('老记录（没有 billingCheckVersion）不参与计费判据')
{
  const now = Date.now()
  const base = { offerId: 'o1', ts: new Date(now - 60_000).toISOString(), ok: true, ttftMs: 100 }
  const buggy = [
    { ...base, fingerprintOk: true, truncated: false, billedInputInflated: true },
    { ...base, fingerprintOk: true, truncated: false, billedInputInflated: true },
    { ...base, fingerprintOk: true, truncated: false, billedInputInflated: true },
  ]
  const legacyOnly = scoreOffers(buggy, {}, { now })
  // 没有 v2 记录时按旧口径（只有 billingInflated 才算证据），这里连 billingInflated 都没有
  ok(legacyOnly.get('o1').integrityFaults.includes('计费异常') === false, '坏记录被忽略，不再判「计费异常」')

  const mixed = scoreOffers(
    [...buggy, { ...base, fingerprintOk: true, truncated: false, billedInputInflated: false, billingCheckVersion: 2 }],
    {},
    { now },
  )
  ok(mixed.get('o1').integrityFaults.includes('计费异常') === false, '有 v2 记录时只看 v2 结论')
  ok(mixed.get('o1').billingRate === 1, '计费通过率按 v2 记录算成 1（平滑后）')
}

console.log('')
if (failed > 0) {
  console.error(failed + ' 项失败')
  process.exit(1)
}
console.log('全部通过')
