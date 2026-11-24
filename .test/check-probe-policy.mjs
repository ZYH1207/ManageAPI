/**
 * 探测策略：瞬时错误重试、非对话模型跳过、超时下限、缓存探测降频、站点级冷却。
 *
 * 背景（用户实测）：探针 24h 成功只有 36%，而同一时段真实流量 500 条里
 * 站方失败 0 条；被手点的「孤立探测」失败 46 例，全是 502/超时/fetch failed。
 * 一针定生死把「站点此刻忙」记成「站点不可用」。
 *
 * 用法：node .test/check-probe-policy.mjs
 */
import { createServer } from 'node:http'
import { probeModel } from '../core/probe.js'
import { classifyFailure, UNAVAILABLE_COOLDOWN_MS } from '../core/failure.js'
import {
  isTransientError,
  isNonChatModel,
  probeTimeoutMsOf,
  shouldProbeCache,
  lastCacheProbeAt,
  providerCooldowns,
  PROBE_TIMEOUT_FLOOR_MS,
  CACHE_PROBE_INTERVAL_MS,
} from '../core/probe-policy.js'

let failed = 0
function ok(cond, message) {
  if (cond) console.log(`  ✓ ${message}`)
  else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

// ------------------------------------------------------------- 纯函数部分
ok(isTransientError('HTTP 502：{"error":"bad gateway"}'), '5xx 算瞬时错误')
ok(isTransientError('HTTP 503：service temporarily unavailable'), '503 算瞬时错误')
ok(isTransientError('The operation was aborted due to timeout'), '超时算瞬时错误')
ok(isTransientError('fetch failed'), '连接没建立算瞬时错误')
ok(!isTransientError('HTTP 429：rate limit exceeded'), '429 不算瞬时（重试只会更糟）')
ok(!isTransientError('HTTP 403：{"code":"GROUP_DELETED"}'), '403 明确拒绝不算瞬时')
ok(!isTransientError('HTTP 400：This model is not supported'), '400 不算瞬时')

ok(isNonChatModel('gpt-image-1.5'), '画图模型跳过 chat 探针')
ok(isNonChatModel('text-embedding-3-large'), 'embedding 跳过')
ok(isNonChatModel('veo-3'), '视频模型跳过')
ok(!isNonChatModel('deepseek-v4.1-flash'), '普通对话模型照常探测')
ok(!isNonChatModel('gpt-5.2'), '带点号的对话模型不被误判')

ok(probeTimeoutMsOf({}) === PROBE_TIMEOUT_FLOOR_MS, '没设置时用 90 秒下限')
ok(probeTimeoutMsOf({ probeTimeoutMs: 45000 }) === PROBE_TIMEOUT_FLOOR_MS, '老的 45 秒被抬到 90 秒')
ok(probeTimeoutMsOf({ probeTimeoutMs: 120000 }) === 120000, '用户设得更大就照用')

const now = Date.UTC(2026, 10, 24, 2, 0, 0)
const fresh = new Date(now - 60 * 60 * 1000).toISOString()
const stale = new Date(now - CACHE_PROBE_INTERVAL_MS - 1000).toISOString()
const probes = [
  { offerId: 'o1', ts: fresh, cacheSupported: true },
  { offerId: 'o1', ts: stale, cacheSupported: false },
  { offerId: 'o2', ts: fresh, cacheSupported: null },
]
ok(lastCacheProbeAt(probes, 'o1') === now - 60 * 60 * 1000, '取最近一次带缓存结论的探针时间')
ok(lastCacheProbeAt(probes, 'o2') === 0, 'cacheSupported 为 null 的记录不算「探过缓存」')
ok(shouldProbeCache(0, now), '从没探过缓存 → 要探')
ok(!shouldProbeCache(now - 60 * 60 * 1000, now), '1 小时前探过 → 这轮跳过')
ok(shouldProbeCache(now - CACHE_PROBE_INTERVAL_MS - 1, now), '超过 6 小时 → 再探')

const scores = new Map([
  ['o1', { blocked: { kind: 'rate-limit', until: now + 60000 } }],
  ['o2', { blocked: { kind: 'rate-limit', until: now + 120000 } }],
  ['o3', { blocked: null }],
])
const cooling = providerCooldowns(scores, (id) => ({ o1: 'p1', o2: 'p1', o3: 'p1' })[id], now)
ok(cooling.size === 1 && cooling.get('p1').until === now + 120000, '同站两条供给冷却 → 合并成站点级一门冷却')

ok(UNAVAILABLE_COOLDOWN_MS['rate-limit'] >= 20 * 60 * 1000, '限流冷却不短于重试节奏（20 分钟）')
ok(UNAVAILABLE_COOLDOWN_MS.quota >= 60 * 60 * 1000, '欠费冷却按小时算，别每 20 分钟白试')
ok(UNAVAILABLE_COOLDOWN_MS['group-deleted'] >= 60 * 60 * 1000, '分组被删按小时算')
ok(classifyFailure('HTTP 502 bad gateway').countsAsOutage === true, '502 仍扣可用率')
ok(classifyFailure('HTTP 429 rate limit').countsAsOutage === false, '429 只记档、不扣可用率')

// ------------------------------------------------------------- 集成部分
const EXPECT = { fp: '7Q2K', calc: 391 }
let chatCount = 0
let cacheRequests = 0
let failFirst = 1

const upstream = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404).end('{}')
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    chatCount += 1
    if (failFirst > 0) {
      failFirst -= 1
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"Upstream service temporarily unavailable"}}')
      return
    }
    let prompt = ''
    try {
      prompt = JSON.parse(body).messages?.[0]?.content || ''
    } catch {
      /* 忽略 */
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    if (prompt.includes(EXPECT.fp)) {
      frame({ choices: [{ delta: { role: 'assistant', content: JSON.stringify(EXPECT) } }] })
      frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 45, completion_tokens: 12 } })
    } else if (prompt.includes('Count from 1 to 120')) {
      const numbers = Array.from({ length: 120 }, (_, i) => i + 1).join(',')
      frame({ choices: [{ delta: { content: numbers } }] })
      frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 200 } })
    } else if (prompt.includes('What model are you')) {
      frame({ choices: [{ delta: { content: 'model-x' } }] })
      frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4 } })
    } else {
      cacheRequests += 1
      frame({ choices: [{ delta: { content: 'OK' } }] })
      frame({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 14498, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 14460 } },
      })
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const PORT = upstream.address().port
const baseUrl = `http://127.0.0.1:${PORT}/v1`

{
  // 第一次：站方 502 —— 调用方（probe-runner）看到 isTransientError 就会重试
  const first = await probeModel({ baseUrl, apiKey: 'k', model: 'm', timeoutMs: 90000 })
  ok(first.ok === false && /HTTP 502/.test(first.error), '首针 502 → 记为失败（待重试）')
  ok(isTransientError(first.error), '这条失败会被判成瞬时 → 触发重试')

  const second = await probeModel({ baseUrl, apiKey: 'k', model: 'm', timeoutMs: 90000 })
  ok(second.ok === true, '重试这一针成功 → 这条供给不该被判死')
  ok(second.fingerprintOk === true, '指纹核对通过')
  ok(second.truncated === false, '输出没有被截断')
  ok(second.cacheSupported === true && second.cacheHitRate > 0.99, '缓存命中率照常统计')
  ok(second.billedInputTokens === 14498 - 14460, '计费输入按同一请求扣掉缓存命中')

  const before = cacheRequests
  const third = await probeModel({ baseUrl, apiKey: 'k', model: 'm', timeoutMs: 90000, skipCache: true })
  ok(third.ok === true, '降频这一针仍然成功')
  ok(third.cacheSupported === null && third.cacheDetail === null, '跳过缓存时不留缓存结论（沿用老记录）')
  ok(cacheRequests === before, '跳过缓存时确实没发那两条 14.5k token 的长请求')
}

await new Promise((resolve) => upstream.close(resolve))
if (failed > 0) {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}
console.log('全部通过')
