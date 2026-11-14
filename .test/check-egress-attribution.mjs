/**
 * 出口归因 + 重新累积 纯函数测试（不联网、不写盘）。
 *
 * 场景取自 2026-11-14 真实事故：
 *   20:31 系统重启，M78 加速器的 TUN 还没连上节点
 *   20:32-20:37 六家毫无关联的站同一秒 EHOSTUNREACH，共 316 次
 *   结果：全部记成站点故障，13 条供给 failRate=1 进冷却，DSH 里只剩 1 条能派
 *   而那条又慢到 50 秒首字，客户端超时 -> 用户以为「网关坏了」/「站全挂了」
 *
 * 跑法：node .test/check-egress-attribution.mjs
 */
import assert from 'node:assert/strict'
import { NETWORK_FAILURE, classifyFailure, trafficDelta, looksLikeLocalNetworkOutage } from '../core/failure.js'
import {
  judgeEgress,
  worstEgressLayer,
  attributeFailures,
  egressLayerText,
  blameEgressIncident,
} from '../core/egress.js'
import { checkEgress, diagnose } from '../core/diagnosis.js'
import { previewReset, resetNegativeEvidence, afterReset, RESET_LOOKBACK_MS } from '../core/evidence-reset.js'
import { scoreOffers } from '../core/score.js'

let n = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  n += 1
}
const eq = (a, b, label) => {
  assert.deepEqual(a, b, label)
  n += 1
}

// 事故原文：逐字复制自当时的 daemon.err.log
const EHOST = '连接失败（EHOSTUNREACH）：https://rapidapi.cc/v1/chat/completions'
const ENET = '连接失败（ENETUNREACH）：https://zdxjl.com/v1/chat/completions'
const PREFLIGHT_EHOST =
  '预检未过（tcp）：TCP 连接失败：connect EHOSTUNREACH 192.210.152.46:8080 - Local (192.168.1.82:50025)'

console.log('[1] EHOSTUNREACH / ENETUNREACH 必须被认成网络类失败（本次事故的根因）')
{
  // 旧正则 /timeout|超时|aborted|fetch failed|ECONN|.../ 一条都不认
  ok(NETWORK_FAILURE.test(EHOST), '真实流量文案 EHOSTUNREACH')
  ok(NETWORK_FAILURE.test(ENET), '真实流量文案 ENETUNREACH')
  ok(NETWORK_FAILURE.test(PREFLIGHT_EHOST), '预检文案 EHOSTUNREACH')
  // 反向：上游真的回了响应，不能被当成网络抖动
  ok(!NETWORK_FAILURE.test('HTTP 502：{"error":"upstream failed"}'), 'HTTP 502 不误判')
  ok(!NETWORK_FAILURE.test('HTTP 403：insufficient balance'), 'HTTP 403 不误判')
}

console.log('[2] 跨站同簇防护在本次事故里必须触发')
{
  const batch = [
    { providerId: 'p_d204c0cf', error: EHOST },
    { providerId: 'p_80c372b1', error: EHOST },
    { providerId: 'p_a012e4b2', error: ENET },
  ]
  ok(looksLikeLocalNetworkOutage({ failures: batch, now: Date.now() }), '跨三站 EHOSTUNREACH -> 判本机网络')

  const solo = [
    { providerId: 'p_d204c0cf', error: EHOST },
    { providerId: 'p_d204c0cf', error: EHOST },
    { providerId: 'p_d204c0cf', error: EHOST },
  ]
  const peer = [{ providerId: 'p_80c372b1', error: EHOST, ts: new Date(Date.now() - 120000).toISOString() }]
  ok(looksLikeLocalNetworkOutage({ failures: solo, peers: peer, now: Date.now() }), '单站+近期同类 -> 判本机网络')

  // 负例：孤立单站故障仍要记账，补正则不能洗白真故障
  ok(!looksLikeLocalNetworkOutage({ failures: solo, peers: [], now: Date.now() }), '孤立单站仍算站点账')
}

console.log('[3] trafficDelta / classifyFailure：单条仍先记 fail，等着同簇判断改判')
{
  const d = trafficDelta(false, EHOST)
  eq(d.fail, 1, '单条先记 fail')
  const cls = classifyFailure(EHOST)
  eq(cls.localDefect, false, '单条不算网关缺陷（不能凭一条就怪自己）')
}

console.log('[4] judgeEgress / worstEgressLayer')
{
  const mk = (rows) => ({
    at: new Date().toISOString(),
    targets: rows.map(([id, okv, layer]) => ({ id, ok: okv, layer: layer || null })),
  })
  eq(judgeEgress(mk([['cloudflare', true], ['baidu', true], ['google', true]])), 'ok', '全通')
  eq(judgeEgress(mk([['cloudflare', false, 'tcp'], ['baidu', false, 'tcp'], ['google', false, 'tcp']])), 'down', '全不通')
  eq(judgeEgress(mk([['cloudflare', true], ['baidu', true], ['google', false, 'tls']])), 'partial', '部分通')
  eq(judgeEgress(null), 'unknown', '没有记录')
  eq(judgeEgress({ at: '', targets: [] }), 'unknown', '空 targets')
  eq(worstEgressLayer(mk([['a', false, 'dns'], ['b', false, 'dns'], ['c', true]])), 'dns', '取失败最多的层')
  eq(worstEgressLayer(mk([['a', true]])), null, '全通时没有失败层')
  eq(egressLayerText('tls'), 'TLS 握手失败', '层的中文文案')
}

console.log('[5] attributeFailures：四种责任，别混成一句「网络不稳」')
{
  const now = Date.now()
  const rec = (targets) => ({ at: new Date(now - 30000).toISOString(), targets })
  const failures = [{ error: EHOST }]

  const down = attributeFailures({
    record: rec([
      { id: 'cloudflare', ok: false, layer: 'tcp' },
      { id: 'baidu', ok: false, layer: 'tcp' },
      { id: 'google', ok: false, layer: 'tcp' },
    ]),
    failures,
    now,
  })
  eq(down.owner, 'egress', '全断 -> 出口')

  const site = attributeFailures({
    record: rec([
      { id: 'cloudflare', ok: true },
      { id: 'baidu', ok: true },
      { id: 'google', ok: true },
    ]),
    failures,
    now,
  })
  eq(site.owner, 'site', '出口通 -> 站点')

  const proxy = attributeFailures({
    record: rec([
      { id: 'cloudflare', ok: true },
      { id: 'baidu', ok: true },
      { id: 'google', ok: false, layer: 'tcp' },
    ]),
    failures,
    now,
  })
  eq(proxy.owner, 'egress', '直连通+代理不通 -> 仍是出口')
  ok(/代理/.test(proxy.detail), '文案点明是代理通路')

  const routing = attributeFailures({
    record: rec([
      { id: 'cloudflare', ok: false, layer: 'dns' },
      { id: 'baidu', ok: true },
      { id: 'google', ok: true },
    ]),
    failures,
    now,
  })
  eq(routing.owner, 'routing', '部分通 -> 分流规则')

  const stale = attributeFailures({
    record: { at: new Date(now - 2 * 3600000).toISOString(), targets: [{ id: 'baidu', ok: true }] },
    failures,
    now,
  })
  eq(stale.owner, 'unknown', '过期记录不下结论')

  eq(attributeFailures({ record: null, failures, now }).owner, 'unknown', '没有记录不下结论')
}

console.log('[6] checkEgress：产出 layer=network 的诊断结论')
{
  const down = checkEgress({
    egress: {
      latest: {
        at: new Date().toISOString(),
        targets: [
          { id: 'cloudflare', label: 'Cloudflare', ok: false, layer: 'tcp' },
          { id: 'baidu', label: '百度', ok: false, layer: 'tcp' },
          { id: 'google', label: 'Google', ok: false, layer: 'tcp' },
        ],
      },
    },
  })
  eq(down.length, 1, '全断产出一条')
  eq(down[0].layer, 'network', '归到 network 层（不是 site/upstream）')
  eq(down[0].severity, 'danger', '全断是 danger')
  ok(/不是那些站都坏了/.test(down[0].detail), '文案明确否认「站都坏了」')
  ok(down[0].action && down[0].action.length > 0, '必须给出可执行动作')

  const healthy = checkEgress({
    egress: { latest: { at: new Date().toISOString(), targets: [{ id: 'baidu', ok: true }] } },
  })
  eq(healthy.length, 0, '出口正常时不产出结论')

  eq(checkEgress({ egress: null }).length, 0, '没有自检记录时安静')

  const proxyOnly = checkEgress({
    egress: {
      latest: {
        at: new Date().toISOString(),
        targets: [
          { id: 'cloudflare', label: 'CF', ok: true },
          { id: 'baidu', label: '百度', ok: true },
          { id: 'google', label: 'Google', ok: false, layer: 'tcp' },
        ],
      },
    },
  })
  eq(proxyOnly[0].id, 'egress-proxy-down', '代理单独挂要单独一条')
  ok(/代理/.test(proxyOnly[0].action), '动作要指向代理')

  const report = diagnose({
    egress: {
      latest: {
        at: new Date().toISOString(),
        targets: [
          { id: 'cloudflare', label: 'CF', ok: false, layer: 'tcp' },
          { id: 'baidu', label: '百度', ok: false, layer: 'tcp' },
          { id: 'google', label: 'Google', ok: false, layer: 'tcp' },
        ],
      },
    },
  })
  ok(report.findings.some((f) => f.layer === 'network'), 'diagnose 里有 network 层结论')
}

console.log('[7] 重新累积：只清负面状态，不动审计账与探针证据')
{
  const now = Date.now()
  const iso = (agoMs) => new Date(now - agoMs).toISOString()
  const db = {
    traffic: {
      o_a: {
        ok: 0,
        fail: 20,
        kinds: {},
        quality: { samples: 0, bad: 0 },
        localDefects: 11,
        since: iso(600000),
        lastFailAt: iso(60000),
      },
      o_b: {
        ok: 5,
        fail: 1,
        kinds: { quota: { n: 2, lastAt: iso(60000) } },
        quality: { samples: 5, bad: 0 },
        since: iso(600000),
      },
      o_clean: { ok: 3, fail: 0, kinds: {}, quality: { samples: 3, bad: 0 }, since: iso(600000) },
    },
    faultSignals: [
      { id: 's1', active: true, scope: { offerId: 'o_a' }, expiresAt: new Date(now + 3600000).toISOString() },
      { id: 's2', active: true, scope: { offerId: 'o_b' }, expiresAt: new Date(now + 3600000).toISOString() },
      { id: 's3', active: false, scope: { offerId: 'o_a' } },
    ],
    failover: {
      reports: [
        { id: 'r1', offerId: 'o_a', status: 'active', until: now + 600000 },
        { id: 'r2', offerId: 'o_b', status: 'expired', until: now - 600000 },
      ],
    },
    emptyDetour: [{ offerId: 'o_a', resolvedAt: null }],
    probes: [
      { id: 'p1', offerId: 'o_a', ts: iso(3600000), ok: false },
      { id: 'p2', offerId: 'o_a', ts: iso(120000), ok: true },
    ],
    offers: [{ id: 'o_a' }, { id: 'o_b' }, { id: 'o_clean' }],
    offerStats: { 'o_a|2026-11-14T12': { offerId: 'o_a', failed: 20 } },
    errorbook: { fp_x: { id: 'fp_x', count: 20 } },
    routing: [{ id: 'g1', ts: iso(60000) }],
    faultEvents: [{ id: 'ev1' }],
  }

  const preview = previewReset(db, { now })
  eq(preview.affected, 2, '预览只在有负面状态的 2 条上')
  ok(!preview.rows.some((r) => r.offerId === 'o_clean'), '干净的供给不进清单')
  ok(preview.kept.some((k) => k.startsWith('站点侧探针证据')), '默认只清网络类探针，保护站点侧证据')
  eq(preview.rows.find((r) => r.offerId === 'o_a').networkProbes, 0, '这两条探针不是网络类（p1 没有 error）')

  const result = resetNegativeEvidence(db, { now, reason: 'test' })
  eq(result.cleared.traffic, 2, '清了 2 条流量窗口')
  eq(result.cleared.signals, 2, '清了 2 条生效信号（已失效那条不动）')
  eq(result.cleared.reports, 1, '清了 1 条生效上报（expired 那条不动）')
  eq(result.cleared.detours, 1, '解除 1 条改道')

  eq(db.traffic.o_a.fail, 0, 'fail 归零')
  eq(db.traffic.o_a.ok, 0, 'ok 归零')
  eq(db.traffic.o_a.localDefects, 0, 'localDefects 一起归零')
  eq(db.traffic.o_a.lastFailAt, null, 'lastFailAt 清掉')
  eq(db.traffic.o_a.since, result.at, '窗口起点推到此刻')

  eq(db.faultSignals.length, 3, '信号不删行')
  eq(db.faultSignals[0].active, false, '生效信号标成失效')
  eq(db.faultSignals[0].resolvedBy, 'test', '记下是谁清的')
  eq(db.failover.reports[0].status, 'cleared', '上报标成 cleared')
  ok(Boolean(db.emptyDetour[0].resolvedAt), '改道被解除')

  eq(db.probes.length, 2, '探针记录保留')
  ok(!db.evidenceReset, '默认不写重置界线（不动探针）')

  eq(Object.keys(db.offerStats).length, 1, 'offerStats 保留')
  eq(Object.keys(db.errorbook).length, 1, 'errorbook 保留')
  eq(db.routing.length, 1, 'routing 保留')
  eq(db.faultEvents.length, 1, 'faultEvents 保留')
}

console.log('[8] 只作废「网络类」探针记录，站点侧证据一条不动')
{
  const now = Date.now()
  const iso = (ago) => new Date(now - ago).toISOString()
  const EHOST_ERR = '预检未过（tcp）：TCP 连接失败：connect EHOSTUNREACH 1.2.3.4:8080'
  const db = {
    traffic: { o_a: { ok: 0, fail: 2, kinds: {}, quality: { samples: 0, bad: 0 }, since: iso(600000) } },
    probes: [
      { id: 'net1', offerId: 'o_a', ts: iso(3600000), ok: false, error: EHOST_ERR },
      { id: 'net2', offerId: 'o_a', ts: iso(3000000), ok: false, error: 'The operation was aborted due to timeout' },
      { id: 'site1', offerId: 'o_a', ts: iso(2400000), ok: false, error: 'HTTP 502：{"error":"upstream failed"}' },
      { id: 'ok1', offerId: 'o_a', ts: iso(60000), ok: true },
    ],
    offers: [{ id: 'o_a' }],
  }
  // 预览要能看见「有 2 条网络类探针会被作废」
  eq(previewReset(db, { now }).rows.find((r) => r.offerId === 'o_a').networkProbes, 2, '预览数出 2 条网络类探针')

  const result = resetNegativeEvidence(db, { now, reason: 'test2' })
  eq(result.cleared.probes, 2, '只作废 2 条网络类')
  eq(db.probes.length, 4, '记录一条都没删（打标记）')
  eq(db.probes.find((p) => p.id === 'net1').voidedBy, 'test2', '网络类失败被标记')
  ok(!db.probes.find((p) => p.id === 'site1').voidedBy, '站点侧 502 不动（不能替站洗白）')
  ok(!db.probes.find((p) => p.id === 'ok1').voidedBy, '成功记录不动')

  // 评分忽略作废的那两条
  const scores = scoreOffers(db.probes, db.traffic, { now: now + 1000 })
  eq(scores.get('o_a').samples, 2, '作废后只剩 502 + 成功两条参与评分')
  ok(scores.get('o_a').availability < 0.8, '站点侧 502 仍然拉低可用率（没有洗白）')

  // 回滚：删掉标记，网络类证据全部回来
  for (const p of db.probes) delete p.voidedBy
  const back = scoreOffers(db.probes, {}, { now: now + 1000 })
  eq(back.get('o_a').samples, 4, '删掉标记后旧证据全部回来（可回滚）')
}

console.log('[9] 24 小时回看上限：不能一次把十几天的历史事故一起抹掉')
{
  const now = Date.now()
  const iso = (ago) => new Date(now - ago).toISOString()
  const EHOST_ERR = '预检未过（tcp）：TCP 连接失败：connect EHOSTUNREACH 1.2.3.4:8080'
  const db = {
    traffic: {},
    probes: [
      { id: 'today', offerId: 'o_a', ts: iso(2 * 3600000), ok: false, error: EHOST_ERR },
      { id: 'yesterday', offerId: 'o_a', ts: iso(RESET_LOOKBACK_MS - 60000), ok: false, error: EHOST_ERR },
      { id: 'ancient', offerId: 'o_a', ts: iso(10 * 24 * 3600000), ok: false, error: EHOST_ERR },
    ],
    offers: [{ id: 'o_a' }],
  }
  // 预览与执行必须数出同一个数：2 条（今天 + 昨天，都在 24h 内）
  eq(previewReset(db, { now }).rows.find((r) => r.offerId === 'o_a').networkProbes, 2, '预览：24h 内 2 条')
  const result = resetNegativeEvidence(db, { now, reason: 'lookback' })
  eq(result.cleared.probes, 2, '执行：也只作废 2 条（预览与执行一致）')
  eq(db.probes.find((p) => p.id === 'ancient').voidedBy, undefined, '10 天前的历史事故不被抹掉')
}

console.log('[10] afterReset 边界：坏时间戳保守放行')
{
  const reset = { at: '2026-11-14T12:40:00.000Z' }
  ok(afterReset(reset, '2026-11-14T12:41:00.000Z'), '界线之后 -> true')
  ok(!afterReset(reset, '2026-11-14T12:39:00.000Z'), '界线之前 -> false')
  ok(afterReset(reset, 'not-a-date'), '坏时间戳 -> 放行（宁可少清）')
  ok(afterReset(null, 'anything'), '没有界线 -> 一律放行')
  ok(afterReset({ at: 'bad' }, '2026-11-14T12:00:00.000Z'), '界线坏了 -> 放行')
}

console.log('[11] blameEgressIncident：识别「这批负面积是出口故障期攒的」')
{
  ok(blameEgressIncident({ incidentAt: '2026-11-14T12:32:00.000Z', since: '2026-11-14T12:30:00.000Z' }), '起点早于故障 -> true')
  ok(!blameEgressIncident({ incidentAt: '2026-11-14T12:32:00.000Z', since: '2026-11-14T13:00:00.000Z' }), '起点晚于故障 -> false')
  ok(!blameEgressIncident({ incidentAt: null, since: '2026-11-14T12:30:00.000Z' }), '没有故障时间 -> false')
  ok(!blameEgressIncident({ incidentAt: '2026-11-14T12:32:00.000Z', since: null }), '没有起点 -> false')
}

console.log('\n全部通过 ✓（' + n + ' 项断言）')
