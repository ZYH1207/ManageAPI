#!/usr/bin/env node
/**
 * 本机网络抖动的归因：连接层失败单条算站方，多站同时才算「我们自己的网络」。
 *
 * 这条判据的意义：一次本机断网不该把十几个站一起打成不可用，
 * 但也不能反过来把「真的挂了」的站洗白。
 */
import { classifyFailure, isConnectionError, localNetworkSuspect, LOCAL_NETWORK_WINDOW_MS } from '../core/failure.js'

let failed = 0
function ok(cond, message) {
  if (cond) console.log('  ✓ ' + message)
  else {
    console.error('  ✗ ' + message)
    failed += 1
  }
}

console.log('连接层失败 vs 有 HTTP 响应的失败')
ok(isConnectionError('fetch failed'), "'fetch failed' 算连接层失败")
ok(isConnectionError('read ECONNRESET'), 'ECONNRESET 算连接层失败')
ok(isConnectionError('connect ETIMEDOUT 1.2.3.4:443'), 'ETIMEDOUT 算连接层失败')
ok(!isConnectionError('HTTP 502 upstream connect error'), '带 HTTP 状态码 → 不算连接层失败（已经连上了）')
ok(!isConnectionError('HTTP 429 rate limit'), 'HTTP 429 不算连接层失败')

console.log('分类结果：连接层失败仍然先按站方故障计')
const conn = classifyFailure('fetch failed')
ok(conn.kind === 'connection', "kind = 'connection'")
ok(conn.countsAsOutage === true, '单条仍计入可用率（豁免要靠「多站同时」这条证据）')
ok(classifyFailure('HTTP 429').countsAsOutage === false, '限流仍不算故障（原有行为不变）')

console.log('多站同时：5 分钟内 ≥2 个站才算本机网络')
{
  const recent = new Map()
  const t0 = 1_000_000
  ok(localNetworkSuspect('p1', recent, t0).localNetwork === false, '只有 1 个站 → 不豁免')
  ok(localNetworkSuspect('p2', recent, t0 + 30_000).localNetwork === true, '第 2 个站也失败 → 判定本机网络')
  ok(localNetworkSuspect('p2', recent, t0 + 30_000).providers === 2, '返回同时失败的站点数')
}

console.log('窗口过期后回到「站方故障」')
{
  const recent = new Map()
  const t0 = 2_000_000
  localNetworkSuspect('p1', recent, t0)
  const later = localNetworkSuspect('p2', recent, t0 + LOCAL_NETWORK_WINDOW_MS + 1)
  ok(later.localNetwork === false, '超过 5 分钟 → 旧的失败被清掉，不再豁免')
}

console.log('')
if (failed > 0) {
  console.error(failed + ' 项失败')
  process.exit(1)
}
console.log('全部通过')
