/**
 * 批量网络异常防护自检（纯函数，不联网）：
 *
 * 这层防护回答的是一个问题：「这一轮探测的失败，是站点坏了，还是我自己断网了？」
 * 答错的方向很贵——把它判成站点故障，一次本机抖动会同时污染几十条供给的可用率
 * （2026-11-07 实测：53 条供给的评分由预检失败决定，28 条可用率被写到 0，
 * 界面显示「站点完全不可用」；而直连秋/绿萝/北辰全部正常）。
 *
 * 用法：node .test/check-network-outage-guard.mjs
 */
import { localNetworkOutageOf } from "../daemon/probe-runner.js"
import { NETWORK_FAILURE, looksLikeLocalNetworkOutage } from "../core/failure.js"

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

const now = Date.now()
const agoIso = (ms) => new Date(now - ms).toISOString()
const fail = (providerId, error) => ({ ok: false, providerId, error })
const TLS_TIMEOUT = '预检未过（tls）：TLS 握手失败：TLS 握手 超时（4000ms）'
const TCP_HANGUP = '预检未过（tcp）：socket hang up'

console.log('[1] 「超时」必须被认成网络类失败')
{
  // 旧正则只列英文 timeout，中文「超时」一条都认不出来：
  // 实测本机 54 条失败样本，旧正则命中 24 条（44%），加上「超时」后 47 条（87%）。
  // 44% 那一轮正好是不触发防护、把失败全记到站点账上的那一轮。
  for (const text of [
    'TLS 握手 超时（4000ms）',
    'HTTP 请求超时',
    'DNS 解析超时',
    'TCP 连接超时',
    'The operation was aborted due to timeout',
    'socket hang up',
    'fetch failed',
    'Client network socket disconnected before secure TLS connection was established',
    // 2026-11-14 事故：本机唯一的失败形式恰好是这两个，旧正则一条都认不出，
    // 于是「网络类失败数=0」→ 同簇防护一次都没触发 → 316 次失败全记成站点故障。
    '连接失败（EHOSTUNREACH）：https://rapidapi.cc/v1/chat/completions',
    '连接失败（ENETUNREACH）：https://zdxjl.com/v1/chat/completions',
    '预检未过（tcp）：TCP 连接失败：connect EHOSTUNREACH 192.210.152.46:8080',
  ]) {
    ok(NETWORK_FAILURE.test(text), `认得出：${text.slice(0, 44)}`)
  }
  // 反向：真实的上游故障不能被当成网络抖动，否则真故障会被洗白
  for (const text of ['HTTP 502：{"error":"upstream failed"}', 'HTTP 403：insufficient balance']) {
    ok(!NETWORK_FAILURE.test(text), `不误判：${text.slice(0, 44)}`)
  }
}

console.log('[2] A 路：本轮自己就跨了多个站')
{
  const failedNow = [
    fail('p_qiu', TLS_TIMEOUT),
    fail('p_qiu', TCP_HANGUP),
    fail('p_lvluo', TLS_TIMEOUT),
  ]
  ok(localNetworkOutageOf({ failed: failedNow, now }), '同日跨 3 个站一起网络失败 → 判本机问题')
}

console.log('[3] B 路：本轮只覆盖一个站，但最近 10 分钟内别的站也网络失败过')
{
  // 这是原先漏掉的那一类：抖动被拆成几个小批次分别写盘，
  // 单个批次只看得到「一个站 3 条失败」，providers=1，A 不成立。
  const failedNow = [
    fail('p_beichen', TLS_TIMEOUT),
    fail('p_beichen', TLS_TIMEOUT),
    fail('p_beichen', TCP_HANGUP),
  ]
  const recent = [{ ok: false, providerId: 'p_qiu', error: TLS_TIMEOUT, ts: agoIso(90 * 1000) }]
  ok(localNetworkOutageOf({ failed: failedNow, recent, now }), '同一站 3 条 + 90 秒前别站也挂了 → 判本机问题')
}

console.log('[4] 负例：孤立的单站故障仍要照常记账')
{
  // 冤枉一个真坏掉的站比放过它更贵，所以两条路都不成立时必须记账。
  const failedNow = [
    fail('p_only', TLS_TIMEOUT),
    fail('p_only', TLS_TIMEOUT),
    fail('p_only', TCP_HANGUP),
  ]
  ok(!localNetworkOutageOf({ failed: failedNow, recent: [], now }), '只有这一个站、无近期同类 → 算这个站的账')

  const tiny = [fail('p_a', TLS_TIMEOUT), fail('p_b', TLS_TIMEOUT)]
  ok(!localNetworkOutageOf({ failed: tiny, recent: [], now }), '只有 2 条失败 → 证据不足，不判本机问题')

  const mixed = [
    fail('p_a', 'HTTP 502：{"error":"upstream failed"}'),
    fail('p_b', 'HTTP 502：{"error":"upstream failed"}'),
    fail('p_c', TLS_TIMEOUT),
  ]
  ok(!localNetworkOutageOf({ failed: mixed, recent: [], now }), '上游 5xx 为主（网络类只占 33%）→ 是站点故障')
}

console.log('[5] 时间窗外的旧记录不算数')
{
  const failedNow = [
    fail('p_a', TLS_TIMEOUT),
    fail('p_a', TLS_TIMEOUT),
    fail('p_a', TCP_HANGUP),
  ]
  // 20 分钟前别的站也挂过：超出 10 分钟簇窗口，不能拿来给这一轮开脱
  const stale = [{ ok: false, providerId: 'p_b', error: TLS_TIMEOUT, ts: agoIso(20 * 60 * 1000) }]
  ok(!localNetworkOutageOf({ failed: failedNow, recent: stale, now }), '20 分钟前的旧记录不构成同簇')
}

console.log('[6] 真实流量侧用同一份判据（2026-11-07 现场：三家站同分钟 ECONNRESET）')
{
  // 探针侧修好之后，真实流量侧仍把秋 145 次、北辰 48 次、绿萝 42 次 ECONNRESET
  // 全记成站点故障 → 可用率照样归零。所以两条路径必须共用同一个函数。
  const ECONNRESET = '连接失败（ECONNRESET）：https://relay.example.com/v1/chat/completions'
  const batch = [
    { providerId: 'p_qiu', error: ECONNRESET },
    { providerId: 'p_qiu', error: '连接失败（EPIPE）：http://203.0.113.7:8080/v1' },
    { providerId: 'p_beichen', error: ECONNRESET },
    { providerId: 'p_lvluo', error: ECONNRESET },
  ]
  ok(looksLikeLocalNetworkOutage({ failures: batch, now }), '跨三站同时 ECONNRESET → 判本机抖动')

  const single = [
    { providerId: 'p_qiu', error: ECONNRESET },
    { providerId: 'p_qiu', error: ECONNRESET },
    { providerId: 'p_qiu', error: ECONNRESET },
  ]
  ok(!looksLikeLocalNetworkOutage({ failures: single, peers: [], now }), '孤立单站 3 次 → 仍算这个站的账')

  const upstream = [
    { providerId: 'p_a', error: 'HTTP 502：{"error":"upstream failed"}' },
    { providerId: 'p_b', error: 'HTTP 503：{"error":"unavailable"}' },
  ]
  ok(!looksLikeLocalNetworkOutage({ failures: upstream, now }), '上游 5xx → 不算网络抖动')
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}
