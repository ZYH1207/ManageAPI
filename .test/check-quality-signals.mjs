/**
 * 真实流量质量信号自检（纯函数，不联网）：
 *   1. token 估算的量级对不对（中文/英文/工具定义）
 *   2. 空回答只在「200 成功 + 没有任何内容 + 正常结束」时才算异常
 *   3. 计费虚报只在明显虚高（>4 倍估算）时才算异常
 *   4. 这些信号要样本够才影响评分，样本不足只记录
 *
 * 用法：node .test/check-quality-signals.mjs
 */
import {
  estimateTokens,
  estimateRequestTokens,
  checkRealResponse,
  REAL_QUALITY_MIN_SAMPLES,
} from '../core/quality-signals.js'
import { scoreOffers, isRoutable } from '../core/score.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

console.log('[1] token 估算')
{
  ok(estimateTokens('hello world') === 3, `英文按 4 字符≈1 token（实际 ${estimateTokens('hello world')}）`)
  ok(estimateTokens('你好世界') === 4, `中文按 1 字≈1 token（实际 ${estimateTokens('你好世界')}）`)
  ok(estimateTokens('') === 0, '空串为 0')
  const body = { messages: [{ role: 'user', content: '你好' }, { role: 'user', content: 'abcdefgh' }] }
  const est = estimateRequestTokens(body)
  ok(est === 4, `messages 正文累计（实际 ${est}）`)
  const withTools = { messages: [], tools: [{ type: 'function', function: { name: 'f' } }] }
  ok(estimateRequestTokens(withTools) > 0, '工具定义也计入')
}

console.log('[2] 空回答判定')
{
  const empty = checkRealResponse({ contentChars: 0, hasToolCalls: false, finishReason: 'stop' })
  ok(empty.empty === true && empty.bad === true, '正常结束但一个字都没有 → 异常')
  const tool = checkRealResponse({ contentChars: 0, hasToolCalls: true, finishReason: 'tool_calls' })
  ok(tool.empty === false, '只有工具调用不算空回答')
  const reasoning = checkRealResponse({ contentChars: 300, hasToolCalls: false, finishReason: 'stop' })
  ok(reasoning.empty === false, '有内容不算空回答')
  const cut = checkRealResponse({ contentChars: 0, hasToolCalls: false, finishReason: 'length' })
  ok(cut.empty === false, '被长度截断不算「空回答」（那是另一类问题）')
}

console.log('[3] 计费虚报判定（只抓明显异常）')
{
  const normal = checkRealResponse({ contentChars: 10, finishReason: 'stop', promptTokens: 1200, requestTokens: 1000 })
  ok(normal.billingInflated === false, '正常上报不算虚报')
  const inflated = checkRealResponse({ contentChars: 10, finishReason: 'stop', promptTokens: 9000, requestTokens: 1000 })
  ok(inflated.billingInflated === true, '9 倍上报 → 虚报')
  const small = checkRealResponse({ contentChars: 10, finishReason: 'stop', promptTokens: 700, requestTokens: 10 })
  ok(small.billingInflated === false, '绝对值太小不判（估算误差大）')
  const noUsage = checkRealResponse({ contentChars: 10, finishReason: 'stop', promptTokens: null, requestTokens: 1000 })
  ok(noUsage.billingInflated === false, '上游没报 usage 就不判')
}

console.log('[4] 样本不足时只记录，不影响评分')
{
  const now = Date.now()
  const agoMs = (ms) => new Date(now - ms).toISOString()
  const probe = { offerId: 'r', ok: true, ts: agoMs(60000), fingerprintOk: true, truncated: false, billingInflated: false }
  const few = scoreOffers([probe], {
    r: { ok: 3, fail: 0, since: agoMs(120000), lastOkAt: agoMs(30000), kinds: {}, quality: { samples: 2, bad: 2 } },
  }, { maxAgeMs: 6 * 3600000, now }).get('r')
  ok(few.realBadRate === null, '样本 < 5 → 不下结论')
  ok(few.status === 'healthy', '状态不受影响')

  const many = scoreOffers([probe], {
    r: { ok: 10, fail: 0, since: agoMs(120000), lastOkAt: agoMs(30000), kinds: {}, quality: { samples: REAL_QUALITY_MIN_SAMPLES + 5, bad: 3 } },
  }, { maxAgeMs: 6 * 3600000, now }).get('r')
  ok(many.realBadRate !== null && many.realBadRate > 0.2, `异常率 ${Math.round(many.realBadRate * 100)}%`)
  ok(many.status === 'degraded', `判结果可疑（实际 ${many.status}）`)
  ok(many.integrityFaults.includes('真实响应异常'), '不合格项写清楚了')
  ok(isRoutable(many) === false, '不可路由')
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}

// ---- 缓存读/写分项计费
console.log('[5] 缓存读/写分项计费')
{
  const { offerCost } = await import('../core/pricing.js')
  const bench = { m: { in: 2, out: 8, currency: 'CNY' } }
  const base = { modelKey: 'm', pricingMode: 'manual', inPrice: 2, outPrice: 8, priceUnit: 'per_mtok', currency: 'CNY' }
  const withCache = offerCost({ ...base, cacheReadPrice: 0.04, cacheWritePrice: 2.5 }, { fx: { rates: { CNY: 7 } } }, bench)
  ok(withCache.cacheReadCnyPerMtok === 0.04, `缓存读价（实际 ${withCache.cacheReadCnyPerMtok}）`)
  ok(withCache.cacheWriteCnyPerMtok === 2.5, `缓存写价（实际 ${withCache.cacheWriteCnyPerMtok}）`)
  const noCache = offerCost(base, { fx: { rates: { CNY: 7 } } }, bench)
  ok(noCache.cacheReadCnyPerMtok === null && noCache.cacheWriteCnyPerMtok === null, '站点没给时都为 null')
}

console.log('[6] usage 记录：input 存净值，缓存分项单列')
{
  const { readFile } = await import('node:fs/promises')
  const usageSrc = await readFile(new URL('../core/usage.js', import.meta.url), 'utf8')
  const wireSrc = await readFile(new URL('../core/wire.js', import.meta.url), 'utf8')
  // 净值换算收在 wire.js 的 usageNumbers：上游别名多，两处各算一遍迟早漂移
  // （cache_creation 就是这样漏的）
  ok(/prompt - cached - cacheCreation/.test(wireSrc), 'wire.js 里做净值换算（prompt 减缓存读/写）')
  ok(
    /row\.input \+= Math\.max\(0, Number\(entry\.inputTokens\) \|\| 0\)/.test(usageSrc),
    'usage.js 直接累加净值（不再自己做减法）',
  )
  ok(/row\.cacheCreation = \(row\.cacheCreation \|\| 0\)/.test(usageSrc), '缓存写入单独累加（老行先兜底）')
  ok(/target\.cacheCreation \+= row\.cacheCreation \|\| 0/.test(usageSrc), '汇总也累加缓存写入（曾经漏过，恒为 0）')
  ok(/inputIncludesCached/.test(usageSrc.replace(/\/\/.*$/gm, '')), '有老数据兼容标记')
}

console.log('')
