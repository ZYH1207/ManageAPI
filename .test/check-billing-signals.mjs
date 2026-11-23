#!/usr/bin/env node
/**
 * 计费判据分家：raw 上报值大 ≠ 多收钱。
 *
 * 背景：站点上报的 prompt_tokens 含缓存命中部分。RapidApi 那两条模型上报
 * 12316–26196 token，看着像 450 倍虚报，但其中 99% 是缓存命中（按缓存价计），
 * 真正多收的只有几百 token。旧判据拿 raw 值比本地估算，把它判成「用量虚报」，
 * 直接拉低完整性、影响路由。
 *
 * 新判据：
 *   billingInflated       = 上报 > 本地估算 × 4（只展示「固定开销」）
 *   billedInputInflated   = (上报 − 缓存) > 800 且 > 本地估算 × 4（进完整性扣分）
 */
import { checkRealResponse } from '../core/quality-signals.js'
import { scoreOffers } from '../core/score.js'

let failed = 0
function ok(cond, message) {
  if (cond) console.log(`  ✓ ${message}`)
  else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

console.log('checkRealResponse：raw 大但缓存命中高 → 不算多收钱')
{
  const r = checkRealResponse({
    contentChars: 10,
    finishReason: 'stop',
    promptTokens: 13251,
    requestTokens: 40,
    cachedTokens: 13000,
  })
  ok(r.billingInflated === true, 'raw 上报 13251 vs 估算 40 → billingInflated（展示用固定开销）')
  ok(r.billedInputInflated === false, '扣掉 13000 缓存后只剩 251 token → 不算多收钱')
  ok(r.bad === false, 'bad 只由 empty / billedInputInflated 决定')
  ok(r.cacheSuspect === false, '缓存占比 98.1% 属正常长提示缓存，不判可疑（阈值 99.9%）')
}

console.log('checkRealResponse：几乎全命中 → 缓存数据可疑')
{
  const r = checkRealResponse({ contentChars: 5, promptTokens: 26196, requestTokens: 40, cachedTokens: 26196 })
  ok(r.billedInputInflated === false, '全额缓存 → 实际计费输入为 0')
  ok(r.cacheSuspect === true, 'prompt 26196 且命中率 100% → 标记 cacheSuspect（可能用来洗白计费）')
  const over = checkRealResponse({ contentChars: 5, promptTokens: 900, requestTokens: 40, cachedTokens: 1200 })
  ok(over.cacheSuspect === true, '缓存比 prompt 还多 → 也可疑')
}

console.log('checkRealResponse：扣掉缓存后仍离谱 → 真的多收钱')
{
  const r = checkRealResponse({ contentChars: 5, promptTokens: 5000, requestTokens: 40, cachedTokens: 100 })
  ok(r.billedInputInflated === true, '4900 计费输入 vs 估算 40 → 判计费异常')
  ok(r.bad === true, 'bad=true，会进真实响应异常率')
}

console.log('checkRealResponse：没有缓存字段时与旧口径一致')
{
  const r = checkRealResponse({ contentChars: 5, promptTokens: 5000, requestTokens: 40 })
  ok(r.billedInputInflated === true, 'cachedTokens 缺省按 0 处理 → 等同旧 billingInflated 语义')
  ok(r.cacheSuspect === false, '没有缓存数据不判可疑')
  const short = checkRealResponse({ contentChars: 5, promptTokens: 200, requestTokens: 40 })
  ok(short.billedInputInflated === false, '低于 800 token 下限不判（短请求误差会被放大）')
}

console.log('checkRealResponse：空回答仍单独判')
{
  const r = checkRealResponse({ contentChars: 0, finishReason: 'stop', promptTokens: 100, requestTokens: 40 })
  ok(r.empty === true && r.bad === true, '正常结束但没内容 → 空回答')
  const tool = checkRealResponse({ contentChars: 0, hasToolCalls: true, finishReason: 'tool_calls' })
  ok(tool.empty === false, '有工具调用的空正文不算空回答')
}

console.log('scoreOffers：完整性只由「扣掉缓存后的计费」决定')
{
  const now = Date.now()
  const ts = new Date(now - 60_000).toISOString()
  const base = { ok: true, fingerprintOk: true, truncated: false, ttftMs: 300, latencyMs: 900 }
  const probes = [
    // 高固定开销但计费干净：3 条记录
    { ...base, ts, offerId: 'o-overhead', billingInflated: true, billedInputInflated: false, billingCheckVersion: 2 },
    { ...base, ts, offerId: 'o-overhead', billingInflated: true, billedInputInflated: false, billingCheckVersion: 2 },
    { ...base, ts, offerId: 'o-overhead', billingInflated: true, billedInputInflated: false, billingCheckVersion: 2 },
    // 真的多算钱：2 条记录
    { ...base, ts, offerId: 'o-inflated', billingInflated: true, billedInputInflated: true, billingCheckVersion: 2 },
    { ...base, ts, offerId: 'o-inflated', billingInflated: true, billedInputInflated: true, billingCheckVersion: 2 },
    // 老记录（只有 billingInflated / 或旧版 billedInputInflated）——没有同请求缓存证据，不进判据
    { ...base, ts, offerId: 'o-legacy', billingInflated: false },
    { ...base, ts, offerId: 'o-legacy', billingInflated: false },
    { ...base, ts, offerId: 'o-legacy', billingInflated: true },
    { ...base, ts, offerId: 'o-legacy', billingInflated: true, billedInputInflated: true },
  ]
  const scores = scoreOffers(probes, {}, {})
  const overhead = scores.get('o-overhead')
  const inflated = scores.get('o-inflated')
  const legacy = scores.get('o-legacy')
  ok(overhead.integrityFaults.length === 0, '高固定开销站不再被判完整性故障')
  ok(overhead.billingRate === 1, '固定开销站的计费通过率是 100%')
  ok(overhead.integrity === 1, '完整性满分（指纹/截断/计费都过）')
  ok(inflated.integrityFaults.includes('计费异常'), '真虚报站被标「计费异常」')
  ok(!inflated.integrityFaults.includes('用量虚报'), '不再用旧标签「用量虚报」')
  ok(!legacy.integrityFaults.includes('计费异常'), '老记录没有同请求缓存证据 → 不判计费异常（宁可放过）')
  ok(legacy.billingRate === null, '老记录不参与计费通过率（raw 数字只作展示）')
}

console.log('scoreOffers：overheadTokens 只做展示')
{
  const ts = new Date(Date.now() - 60_000).toISOString()
  const probes = [
    { ok: true, ts, offerId: 'o1', fingerprintOk: true, truncated: false, billingInflated: true, billedInputInflated: false, fixedOverheadTokens: 13000 },
    { ok: true, ts, offerId: 'o1', fingerprintOk: true, truncated: false, billingInflated: true, billedInputInflated: false, fixedOverheadTokens: 14000 },
  ]
  const scores = scoreOffers(probes, {}, {})
  const row = scores.get('o1')
  ok(row.overheadTokens === 13500, `固定开销取中位（实测 ${row.overheadTokens}）`)
  ok(row.integrity === 1, '固定开销不扣完整性')
}

if (failed > 0) {
  console.error(`${failed} 项失败`)
  process.exit(1)
}
console.log('全部通过')
