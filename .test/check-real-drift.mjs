/**
 * 真实价速比漂移 + 自动路由故障转移自检。
 *
 *   1. 纯函数：快窗口现值 / 慢基线 / 漂移判定（core/real-drift.js）
 *   2. pickAutoRoute 认降级名单：漂移的供给不当「最优」，同模型换供给也算转移
 *   3. Watcher 状态机（真 store + 假上游桩）：漂移 → 改派；试跑窗挡冷启动误判；
 *      冷却期防震荡；备选耗尽踢 Lite 探针开新周期；恢复正常放回参选
 *
 * 用法：node .test/check-real-drift.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MANAGE_API_DRIFT_COOLDOWN_MS = '200'
process.env.MANAGE_API_TRIAL_SAMPLES = '3'
process.env.MANAGE_API_TRIAL_MAX_MS = '60000'
process.env.MANAGE_API_DRIFT_EXHAUST_LIMIT = '2'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- [1] 纯函数

console.log('[1] 漂移判定纯函数（core/real-drift.js，综合分 = 真实总耗时）')
{
  const { fastCurrent, baselineRatio, evaluateDrift } = await import('../core/real-drift.js')
  const now = Date.now()
  const sample = (ttftMs, latencyMs, outTokens, ageMin = 0) => ({
    at: now - ageMin * 60_000,
    ttftMs,
    latencyMs,
    outTokens,
  })

  // 快窗口：综合分是「归一化」后的等效耗时，不是裸总耗时
  const cur = fastCurrent(Array.from({ length: 5 }, () => sample(2000, 2000, 100)), now)
  ok(cur.samples === 5 && cur.avgLatencyMs === 2000, `5 单同值 → 裸总耗时 2000ms（${cur.avgLatencyMs}）`)
  // 归一化：ttft 2000 + outRef 100 × msPerToken 0 = 2000
  ok(cur.compositeMs === 2000, `综合分 = ttft + outRef×msPerToken = 2000（${cur.compositeMs}）`)
  ok(fastCurrent([sample(2000, 2000, 100)], now).compositeMs === null, '样本不足 5 → 判不了')
  const withOld = fastCurrent(
    [sample(2000, 2000, 100), sample(2000, 2000, 100), sample(2000, 2000, 100), sample(2000, 2000, 100), sample(2000, 2000, 100, 20)],
    now,
  )
  ok(withOld.samples === 4 && withOld.compositeMs === null, '20 分钟前的旧样本被窗口排除（剩 4 单判不了）')
  const withTps = fastCurrent(Array.from({ length: 5 }, () => sample(500, 2500, 100)), now)
  ok(Math.abs(withTps.tps - 0.05) < 1e-9, `吐字速度 = 吐字量 ÷ (总耗时-首字)：100/2000ms = 0.05 tok/ms（${withTps.tps}）`)

  // ---- 归一化专项：短单 vs 长单必须可比（这是「20 token 快单被当慢站」的解药）
  // A：20 token / 10.0s（ttft 1s，吐字 20 token/9s ≈ 450ms/token）
  // B：200 token / 15.4s（ttft 1s，吐字 200 token/14.4s ≈ 72ms/token）
  const shortRuns = Array.from({ length: 5 }, () => sample(1000, 10000, 20))
  const longRuns = Array.from({ length: 5 }, () => sample(1000, 15400, 200))
  const a = fastCurrent(shortRuns, now)
  const b = fastCurrent(longRuns, now)
  ok(a.avgLatencyMs < b.avgLatencyMs, `裸比：短单总耗时更小（${a.avgLatencyMs} < ${b.avgLatencyMs}）`)
  ok(
    a.msPerToken > b.msPerToken * 3,
    `但归一化后短单每 token 慢得多（${Math.round(a.msPerToken)} vs ${Math.round(b.msPerToken)} ms/token）`,
  )
  // 参照工作量不同（20 vs 200），各自折算后两者的「单位工作量耗时」由 msPerToken 决定胜负
  ok(b.msPerToken < a.msPerToken, '归一化判定：长输出的站其实是快的那个')

  // 慢基线：最新桶（漂移中的样本正往里写）必须排除
  const hourKey = (ageH) => {
    const d = new Date(now - ageH * 3600_000)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`
  }
  // requests/outputTokens 用来算「参照工作量 outRef」（这个站平均每单吐多少 token），
  // 归一化靠它把长短单折算到同一起跑线；缺了它基线算不出综合分
  const bucket = (offerId, ageH, latencySum, ttftSum, count, genOut = 0, genTime = 0, requests = count, outTokens = genOut) => [
    `${offerId}|${hourKey(ageH)}`,
    {
      latencySum,
      ttftSum,
      latencyCount: count,
      ttftCount: count,
      genOutSum: genOut,
      genTimeSum: genTime,
      requests,
      outputTokens: outTokens,
    },
  ]
  const stats = Object.fromEntries([
    bucket('o1', 0, 18000, 18000, 9), // 当前小时：漂移中的样本，不进基线
    bucket('o1', 2, 10000, 10000, 5), // 2000ms → 基线 2000ms
    bucket('o1', 3, 10000, 10000, 5),
  ])
  const base = baselineRatio(stats, 'o1', now)
  ok(
    base.avgTtftMs === 2000 && base.source === 'history',
    `基线只用历史桶（首字 2000ms，${base.samples} 单）`,
  )
  const baseEmpty = baselineRatio(Object.fromEntries([bucket('o2', 0, 2000, 2000, 2)]), 'o2', now)
  ok(baseEmpty.compositeMs === null, '基线样本不足 → 判不了')

  // 每天头一个小时没有历史桶：回退用当前小时桶当基线（稀释偏差方向保守）
  const freshDay = Object.fromEntries([bucket('o3', 0, 60000, 60000, 30)])
  const baseFresh = baselineRatio(freshDay, 'o3', now)
  ok(
    baseFresh.avgTtftMs === 2000 && baseFresh.source === 'current-hour',
    `头一小时回退当前桶（${baseFresh.source}，${baseFresh.avgTtftMs}ms）`,
  )

  // 判定：现值 4000ms vs 基线 2000ms = +100% ≥ 30% → drifted
  const verdict = evaluateDrift(
    Array.from({ length: 5 }, () => sample(2000, 4000, 100)),
    stats,
    'o1',
    now,
  )
  ok(verdict.verdict === 'drifted' && verdict.drift > 0.99, `现值慢 100% → drifted（${verdict.verdict}）`)
  const okVerdict = evaluateDrift(
    Array.from({ length: 5 }, () => sample(2000, 2000, 100)),
    stats,
    'o1',
    now,
  )
  ok(okVerdict.verdict === 'ok', '现值 ≈ 基线 → ok')

  // 解耦型劣化：首字纹丝不动、吐字被抽走——总耗时照样抓得住，且分项定位到吐字
  const decoupled = evaluateDrift(
    Array.from({ length: 5 }, () => sample(500, 6500, 100)),
    Object.fromEntries([
      bucket('o4', 0, 2500, 500, 9),
      bucket('o4', 2, 12500, 2500, 5, 500, 10000), // 基线：首字 500ms + 吐字 0.05 tok/ms
    ]),
    'o4',
    now,
  )
  ok(
    decoupled.verdict === 'drifted' && decoupled.ttftDrift === 0 && decoupled.tpsDrift > 0.5,
    `首字不动、吐字慢 → 综合分照样触发（首字 ${decoupled.ttftDrift}，吐字 ${decoupled.tpsDrift?.toFixed(2)}）`,
  )
}

// ------------------------------------------- [1b] 常量基线（30 天按天取中位）

console.log('[1b] 常量基线：按天取中位、今天不参与、不够 3 天退回加权均值')
{
  const { longTermBaseline, evaluateDrift } = await import('../core/real-drift.js')
  const now = Date.now()
  const hourKey = (ageH) => {
    const d = new Date(now - ageH * 3600_000)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`
  }
  // 一天一个桶：latency 均值 = latencyEach，样本数 count（genOutSum/genTimeSum 用来算吐字）
  const day = (offerId, ageH, latencyEach, count) => [
    `${offerId}|${hourKey(ageH)}`,
    {
      latencySum: latencyEach * count,
      latencyCount: count,
      ttftSum: latencyEach * count,
      ttftCount: count,
      genOutSum: 100 * count,
      genTimeSum: 1000 * count,
    },
  ]
  const stats = Object.fromEntries([
    day('o5', 2, 60000, 30), // 今天：正在写的桶，不许进常量
    day('o5', 30, 2000, 10),
    day('o5', 54, 3000, 10),
    day('o5', 78, 10000, 10), // 一天突然塌了：中位数应该无视它
  ])
  const lt = longTermBaseline(stats, 'o5', now)
  ok(
    lt.source === 'days' && lt.days === 3 && lt.avgLatencyMs === 3000,
    `3 天中位 = 3000ms（${lt.source}/${lt.days} 天/${lt.avgLatencyMs}ms）`,
  )
  ok(lt.samples === 30, `常量只算合格的天（${lt.samples} 单）`)
  ok(Math.abs(lt.tps - 0.1) < 1e-9, `吐字速度 = 100/(1000) = 0.1 tok/ms（${lt.tps}）`)

  const twoDays = longTermBaseline(
    Object.fromEntries([day('o5', 30, 2000, 10), day('o5', 54, 4000, 10)]),
    'o5',
    now,
  )
  ok(
    twoDays.source === 'pooled' && twoDays.avgLatencyMs === 3000,
    `不够 3 天 → 退回全窗口加权均值（${twoDays.source}/${twoDays.avgLatencyMs}ms）`,
  )
  const tooFew = longTermBaseline(Object.fromEntries([day('o5', 30, 2000, 3)]), 'o5', now)
  ok(tooFew.avgLatencyMs === null, '样本不够 5 单 → 没有常量（不给一两单编个数）')
  const noData = longTermBaseline({}, 'o5', now)
  ok(noData.avgLatencyMs === null && noData.source === null && noData.days === 0, '没有任何账 → null')

  // 判定里带出常量与「现值较常量」：6 小时基线被整段拖慢时的兑底证据
  const verdict = evaluateDrift(
    Array.from({ length: 5 }, () => ({ at: now, ttftMs: 2000, latencyMs: 6000, outTokens: 100 })),
    Object.fromEntries([day('o6', 30, 2000, 10), day('o6', 54, 2000, 10), day('o6', 78, 2000, 10), day('o6', 2, 6000, 10)]),
    'o6',
    now,
  )
  ok(
    verdict.constant === 2000 && Math.abs(verdict.driftVsConstant - 2) < 1e-9,
    `现值 6000ms 较常量 2000ms = +200%（${verdict.driftVsConstant}）`,
  )
  // 现值算不出来时（这十分钟没流量）也要带出基线绝对值：界面上不能只余一排横线
  const noTraffic = evaluateDrift(
    [],
    Object.fromEntries([day('o7', 2, 2000, 10), day('o7', 30, 2000, 10)]),
    'o7',
    now,
  )
  ok(
    noTraffic.verdict === 'insufficient' &&
      noTraffic.current === null &&
      noTraffic.baselineTtftMs === 2000 &&
      Math.abs(noTraffic.baselineTps - 0.1) < 1e-9,
    `没流量也带出基线首字/吐字（${noTraffic.baselineTtftMs}ms / ${noTraffic.baselineTps} tok/ms）`,
  )
  // 现值补位用：最近一小时小时桶（只展示，不参与判定）
  ok(
    Math.abs(noTraffic.recent.avgLatencyMs - 2000) < 1e-9 && noTraffic.recent.samples === 10,
    `现值空时用最近一小时补位（${noTraffic.recent.avgLatencyMs}ms / ${noTraffic.recent.samples} 单）`,
  )
  ok(
    !("drift" in noTraffic.recent) && Number.isFinite(noTraffic.recent.ageMs),
    `补位值不带漂移结论，只带时间戳（龄 ${noTraffic.recent.ageMs}ms）`,
  )
  // 参考漂移：最近一小时 vs 6 小时基线，只给界面看，不参与触发
  ok(
    Number.isFinite(noTraffic.reference?.ttftDrift) &&
      Math.abs(noTraffic.reference.ttftDrift) < 1e-9 &&
      Number.isFinite(noTraffic.reference?.tpsDrift),
    `同一小时当参考：首字/吐字漂移都是 0（${noTraffic.reference?.ttftDrift} / ${noTraffic.reference?.tpsDrift}）`,
  )
  // 首字/吐字是两个不同资源，必须能分别算出来（UI 那格以前永远是横线就是这个丢了）
  const split = evaluateDrift(
    [],
    Object.fromEntries([
      day('o8', 2, 12000, 10), // 最近一小时：总 12s
      day('o8', 4, 6000, 10), // 6 小时基线：总 6s
    ]),
    'o8',
    now,
  )
  ok(
    Math.abs(split.reference.ttftDrift - 1) < 1e-9 && Math.abs(split.reference.drift - 1) < 1e-9,
    `最近一小时比基线慢一倍 → 参考漂移 +100%（首字 ${split.reference.ttftDrift}）`,
  )
  ok(
    Number.isFinite(split.baselineTtftMs) && Number.isFinite(split.baselineTps),
    `基线首字/吐字绝对值都在（${split.baselineTtftMs}ms / ${split.baselineTps} tok/ms）`,
  )
}

// ------------------------------------------------- [2] pickAutoRoute 认降级名单

console.log('[2] pickAutoRoute：降级的供给不当「最优」，同模型换供给也算转移')
{
  const { pickAutoRoute } = await import('../core/auto-route.js')
  const provider = (id, name) => ({ id, name })
  const credential = (id, providerId) => ({ id, providerId, group: '', tail: '0000' })
  const offer = (id, providerId, modelKey, cny) => ({
    id,
    providerId,
    credentialId: `c-${providerId}`,
    group: '',
    modelKey,
    upstreamName: modelKey,
    pricingMode: 'manual',
    priceUnit: 'per_mtok',
    currency: 'CNY',
    inPrice: cny,
    outPrice: cny,
  })
  const score = { samples: 5, trafficSamples: 0, status: 'healthy', availability: 1, integrity: 1, quality: 1, stale: false, blocked: null, ttftMs: 3000 }
  const db = {
    settings: {
      fx: { base: 'USD', rates: { CNY: 7.2 } },
      fxUsdCny: 7.2,
      maxTtftMs: 0,
      allowUntrusted: false,
      decisionMode: 'priceSpeed',
      autoRoute: { enabled: true, modelKey: 'm-a', offerId: 'o-a1', pickedAt: 't', reason: 'initial' },
    },
    providers: [provider('p1', '甲站'), provider('p2', '乙站')],
    credentials: [credential('c-p1', 'p1'), credential('c-p2', 'p2')],
    offers: [offer('o-a1', 'p1', 'm-a', 2), offer('o-a2', 'p1', 'm-a', 2), offer('o-b1', 'p2', 'm-b', 6)],
    manualOrder: {},
  }
  const scores = { 'o-a1': score, 'o-a2': score, 'o-b1': { ...score, ttftMs: 1000 } }

  const pick = pickAutoRoute(db, { scores, benchmarks: {}, driftDemoted: new Set(['o-a1']) })
  ok(pick.offerId === 'o-a2', `同模型换供给也算转移：${pick.offerId}`)

  const both = pickAutoRoute(db, { scores, benchmarks: {}, driftDemoted: new Set(['o-a1', 'o-a2']) })
  ok(both.offerId === 'o-b1' && both.reason === 'drift-failover', `同模型全降级 → 换模型（${both.offerId}/${both.reason}）`)

  const none = pickAutoRoute(db, { scores, benchmarks: {} })
  ok(none.offerId === 'o-a1', '没有降级名单 → 现役照旧（迟滞口径不变）')
}

// ------------------------------------------------- [3] Watcher 状态机（真 store）

console.log('[3] Watcher 状态机：转移 / 试跑窗 / 冷却 / 逃生舱 / 恢复')
{
  process.env.MANAGE_API_HOME = mkdtempSync(join(tmpdir(), 'mapi-drift-'))
  const store = await import('../core/store.js')
  const { createDriftWatcher, DRIFT_COOLDOWN_MS } = await import('../daemon/drift-watcher.js')

  const hourKey = (ageH) => {
    const d = new Date(Date.now() - ageH * 3600_000)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`
  }
  const probeRecords = (offerId, ttft) =>
    Array.from({ length: 5 }, (_, i) => ({
      offerId,
      ts: new Date(Date.now() - i * 60_000).toISOString(),
      ok: true,
      fingerprintOk: true,
      truncated: false,
      billingInflated: false,
      ttftMs: ttft,
      latencyMs: ttft + 500,
    }))

  await store.mutate((db) => {
    db.providers = [
      { id: 'p1', name: '甲站', baseUrl: 'https://a.test/v1' },
      { id: 'p2', name: '乙站', baseUrl: 'https://b.test/v1' },
    ]
    db.credentials = [
      { id: 'c-p1', providerId: 'p1', group: '', tail: '0000' },
      { id: 'c-p2', providerId: 'p2', group: '', tail: '0000' },
    ]
    db.offers = [
      { id: 'o-a1', providerId: 'p1', credentialId: 'c-p1', group: '', modelKey: 'm-a', upstreamName: 'm-a', pricingMode: 'manual', priceUnit: 'per_mtok', currency: 'CNY', inPrice: 2, outPrice: 2 },
      { id: 'o-b1', providerId: 'p2', credentialId: 'c-p2', group: '', modelKey: 'm-b', upstreamName: 'm-b', pricingMode: 'manual', priceUnit: 'per_mtok', currency: 'CNY', inPrice: 6, outPrice: 6 },
    ]
    db.probes = [...probeRecords('o-a1', 3000), ...probeRecords('o-b1', 1000)]
    db.traffic = {}
    // 基线：两家都是 2000ms / 0.002 元 = 1e-6（当前小时桶会被排除，随便填点漂移值）
    // 基线：两家都是总耗时 2000ms（当前小时桶会被排除）
    db.offerStats = Object.fromEntries([
      ['o-a1|' + hourKey(0), { latencySum: 18000, latencyCount: 9, ttftSum: 18000, ttftCount: 9 }],
      ['o-a1|' + hourKey(2), { latencySum: 10000, latencyCount: 5, ttftSum: 10000, ttftCount: 5 }],
      ['o-b1|' + hourKey(0), { latencySum: 18000, latencyCount: 9, ttftSum: 18000, ttftCount: 9 }],
      ['o-b1|' + hourKey(2), { latencySum: 10000, latencyCount: 5, ttftSum: 10000, ttftCount: 5 }],
    ])
    db.settings.decisionMode = 'priceSpeed'
    db.settings.autoRoute = {
      enabled: true,
      modelKey: 'm-a',
      offerId: 'o-a1',
      pickedAt: new Date().toISOString(),
      reason: 'initial',
    }
  })

  const probeCalls = []
  const watcher = createDriftWatcher({
    runProbes: async (opts) => {
      probeCalls.push(opts)
      return []
    },
    logger: { info() {}, warn() {} },
  })
  const drifted = () => Array.from({ length: 5 }, () => ({ ttftMs: 2000, latencyMs: 4000, outTokens: 100 })) // 总耗时慢 100%
  const normal = () => Array.from({ length: 5 }, () => ({ ttftMs: 2000, latencyMs: 2000, outTokens: 100 })) // 与基线平

  // (a) o-a1 漂移 100% → 改派 o-b1（探针价速比最优的备选），进试跑窗 + 冷却
  drifted().forEach((s) => watcher.seedSample('o-a1', s))
  await watcher.tick()
  let db = await store.readDb()
  ok(db.settings.autoRoute.offerId === 'o-b1', `漂移 → 改派 o-b1（${db.settings.autoRoute.offerId}）`)
  ok(db.settings.autoRoute.reason === 'drift-failover', `reason=drift-failover（${db.settings.autoRoute.reason}）`)
  ok(watcher.snapshot().trial?.offerId === 'o-b1', '改派后新现役进试跑窗')

  // (b) 试跑窗：o-b1 头 2 单就「漂移」也不判——它还没来得及表现
  for (let i = 0; i < 2; i++) watcher.seedSample('o-b1', { ttftMs: 2000, latencyMs: 4000, outTokens: 100 })
  await watcher.tick()
  db = await store.readDb()
  ok(db.settings.autoRoute.offerId === 'o-b1', '试跑窗内不转移（2/3 单）')
  ok(watcher.snapshot().trial?.samples === 2, `试跑窗在攒样本（${watcher.snapshot().trial?.samples}）`)

  // (c) 攒满试跑窗（3 单）且冷却已过 → o-b1 也漂移（判定需 5 单样本）→ 降级，
  //     但备选 o-a1 还在降级名单 → 逃生舱计数 1
  for (let i = 0; i < 3; i++) watcher.seedSample('o-b1', { ttftMs: 2000, latencyMs: 4000, outTokens: 100 })
  await sleep(250) // 越过 200ms 冷却
  await watcher.tick()
  ok(watcher.snapshot().demoted.includes('o-b1'), 'o-b1 漂移被降级')
  ok(probeCalls.length === 0, `还没到逃生舱阈值不踢探针（${probeCalls.length} 次）`)

  // (d) 再漂一轮（还冷却早已过）→ 连续第 2 次 → 踢 Lite 探针 + 清降级开新周期
  await watcher.tick()
  ok(probeCalls.length === 1 && probeCalls[0].lite === true && probeCalls[0].cache === 'auto', '备选耗尽 → 踢一轮 Lite 探针')
  ok(watcher.snapshot().demoted.length === 0, '新周期：降级名单清空')

  // (e) 新周期里 o-b1 还漂 → 降级 o-b1 → o-a1 回来
  await watcher.tick()
  db = await store.readDb()
  ok(db.settings.autoRoute.offerId === 'o-a1', `新周期里 o-b1 仍漂移 → 转回 o-a1（${db.settings.autoRoute.offerId}）`)

  // (f) o-a1 也漂 → 降级；随后恢复正常 → 从降级名单放出来
  await sleep(250) // 越过 (e) 转移设下的冷却
  drifted().forEach((s) => watcher.seedSample('o-a1', s))
  await watcher.tick()
  ok(watcher.snapshot().demoted.includes('o-a1'), 'o-a1 漂移也被降级')
  normal().forEach((s) => watcher.seedSample('o-a1', s))
  await watcher.tick()
  ok(!watcher.snapshot().demoted.includes('o-a1'), '恢复正常 → 放回参选')

  // (g) 自动路由关掉 → 不再改派，但监视不停（基线账照算）
  await store.mutate((latest) => {
    latest.settings.autoRoute = { ...latest.settings.autoRoute, enabled: false }
  })
  await watcher.tick()
  ok(watcher.snapshot().demoted.length === 0, '关闭自动路由 → 降级名单作废（重新开启不带旧账）')

  // (h) 没开自动路由：照常算两档基线、照常判漂移，但一单也不改派
  for (let i = 0; i < 5; i++) watcher.seedSample('o-b1', { ttftMs: 2000, latencyMs: 9000, outTokens: 100 })
  await watcher.tick()
  const snap = watcher.snapshot()
  db = await store.readDb()
  ok(snap.evaluation !== null && snap.evaluation.verdict !== undefined, '不开自动路由也算得出判定（不再返回 null）')
  ok(snap.scan.length >= 2, `同时在监视多条供给（${snap.scan.length} 条）`)
  ok(
    snap.evaluation.baseline === 2000 && Number.isFinite(snap.evaluation.constant),
    `两档基线都算出来了（6h ${snap.evaluation.baseline}ms / 常量 ${snap.evaluation.constant}ms）`,
  )
  ok(
    snap.evaluation.offerId === 'o-a1',
    `主监控 = 真实流量最多的那条（${snap.evaluation.offerId}）`,
  )
  ok(db.settings.autoRoute.offerId === 'o-a1' && snap.demoted.length === 0, '漂移了也不改派、不降级')
  ok(snap.trial === null && snap.cooldownUntil === null, '试跑窗/冷却期在关掉自动路由后为空')

  // (i) 总开关关掉 → 连监视都停（用户明确关掉漂移检测）
  await store.mutate((latest) => {
    latest.settings.driftEnabled = false
  })
  await watcher.tick()
  ok(watcher.snapshot().evaluation === null && watcher.snapshot().scan.length === 0, '漂移检测总开关关掉 → 快照清空')
  await store.mutate((latest) => {
    latest.settings.driftEnabled = true
  })

  ok(DRIFT_COOLDOWN_MS === 10 * 60_000, `默认冷却 10 分钟（${DRIFT_COOLDOWN_MS}）`)

  // (j) 进程刚重启、快窗口是空的：监视对象从 offerStats 里挑（不因「这十分钟没流量」就什么都不显示）
  const coldWatcher = createDriftWatcher({ runProbes: async () => [], logger: { info() {}, warn() {} } })
  await coldWatcher.tick()
  const cold = coldWatcher.snapshot()
  ok(cold.scan.length === 2, `快窗口空 → 从 6 小时小时桶里挑监视对象（${cold.scan.length} 条）`)
  ok(
    cold.evaluation.samples === 0 && cold.evaluation.baseline !== null,
    `没流量也把已攒好的基线露出来（样本 ${cold.evaluation.samples} / 基线 ${cold.evaluation.baseline}ms）`,
  )
  ok(cold.evaluation.offerId === 'o-a1', `按请求数排序，主监控仍是 o-a1（${cold.evaluation.offerId}）`)
  ok(
    cold.scan.every((r) => r.lastSampleAt === null && Number.isFinite(r.baselineTtftMs)),
    '快窗口空 → 最近一单为空，但基线首字照样带出（界面不会只剩横线）',
  )

  // (k) 快窗口只走了小流量那条，大流量那条也不许被漏——两份账取并集后按流量排
  // 先把 o-a1 的账本推到明显大头（它是站内主力），o-b1 只在快窗口里露了个头
  await store.mutate((latest) => {
    latest.offerStats[`o-a1|${hourKey(0)}`] = { latencySum: 200000, latencyCount: 100, ttftSum: 200000, ttftCount: 100, requests: 100 }
  })
  const mixedWatcher = createDriftWatcher({ runProbes: async () => [], logger: { info() {}, warn() {} } })
  // 只给 o-b1 灌快窗口样本（o-a1 这十分钟没流量，但账本里它是大头）
  for (let i = 0; i < 5; i++) mixedWatcher.seedSample('o-b1', { ttftMs: 1000, latencyMs: 1200, outTokens: 100 })
  await mixedWatcher.tick()
  const mixed = mixedWatcher.snapshot()
  ok(
    mixed.scan.map((r) => r.offerId).sort().join(',') === 'o-a1,o-b1',
    `快窗口 + 账本取并集，大流量那条不会被漏（${mixed.scan.map((r) => r.offerId).join(' / ')}）`,
  )
  ok(mixed.evaluation.offerId === 'o-a1', `主监控仍是大流量那条（${mixed.evaluation.offerId}）`)
  ok(
    mixed.scan.find((r) => r.offerId === 'o-a1').current === null &&
      Number.isFinite(mixed.scan.find((r) => r.offerId === 'o-a1').recent.avgLatencyMs),
    '大流量那条现值空着，但最近一小时有数可补位',
  )

  // (l) 自动路由开着也不能只算现役一条：其它模型也在跑，账也得算
  await store.mutate((latest) => {
    latest.settings.autoRoute = {
      ...latest.settings.autoRoute,
      enabled: true,
      modelKey: 'm-b',
      offerId: 'o-b1',
      pickedAt: new Date().toISOString(),
      reason: 'initial',
    }
  })
  const autoWatcher = createDriftWatcher({ runProbes: async () => [], logger: { info() {}, warn() {} } })
  await autoWatcher.tick()
  const autoSnap = autoWatcher.snapshot()
  ok(autoSnap.scan.length >= 2, `自动路由开着也扫多条（${autoSnap.scan.length} 条）`)
  ok(autoSnap.evaluation.offerId === 'o-b1', `主监控 = 现役那条（${autoSnap.evaluation.offerId}）`)
  ok(
    autoSnap.scan.some((r) => r.offerId === 'o-a1'),
    '非现役但有大流量，也在 scan 里（界面看得到它慢不慢）',
  )
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
