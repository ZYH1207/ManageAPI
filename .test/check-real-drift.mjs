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

  // 快窗口：平均总耗时是综合分主体
  const cur = fastCurrent(Array.from({ length: 5 }, () => sample(2000, 2000, 100)), now)
  ok(cur.samples === 5 && cur.avgLatencyMs === 2000, `5 单同值 → 总耗时 2000ms（${cur.avgLatencyMs}）`)
  ok(fastCurrent([sample(2000, 2000, 100)], now).avgLatencyMs === null, '样本不足 5 → 判不了')
  const withOld = fastCurrent(
    [sample(2000, 2000, 100), sample(2000, 2000, 100), sample(2000, 2000, 100), sample(2000, 2000, 100), sample(2000, 2000, 100, 20)],
    now,
  )
  ok(withOld.samples === 4 && withOld.avgLatencyMs === null, '20 分钟前的旧样本被窗口排除（剩 4 单判不了）')
  const withTps = fastCurrent(Array.from({ length: 5 }, () => sample(500, 2500, 100)), now)
  ok(Math.abs(withTps.tps - 0.05) < 1e-9, `吐字速度 = 吐字量 ÷ (总耗时-首字)：100/2000ms = 0.05 tok/ms（${withTps.tps}）`)

  // 慢基线：最新桶（漂移中的样本正往里写）必须排除
  const hourKey = (ageH) => {
    const d = new Date(now - ageH * 3600_000)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`
  }
  const bucket = (offerId, ageH, latencySum, ttftSum, count, genOut = 0, genTime = 0) => [
    `${offerId}|${hourKey(ageH)}`,
    { latencySum, ttftSum, latencyCount: count, ttftCount: count, genOutSum: genOut, genTimeSum: genTime },
  ]
  const stats = Object.fromEntries([
    bucket('o1', 0, 18000, 18000, 9), // 当前小时：漂移中的样本，不进基线
    bucket('o1', 2, 10000, 10000, 5), // 2000ms → 基线 2000ms
    bucket('o1', 3, 10000, 10000, 5),
  ])
  const base = baselineRatio(stats, 'o1', now)
  ok(base.avgLatencyMs === 2000 && base.source === 'history', `基线只用历史桶（2000ms，${base.samples} 单）`)
  const baseEmpty = baselineRatio(Object.fromEntries([bucket('o2', 0, 2000, 2000, 2)]), 'o2', now)
  ok(baseEmpty.avgLatencyMs === null, '基线样本不足 → 判不了')

  // 每天头一个小时没有历史桶：回退用当前小时桶当基线（稀释偏差方向保守）
  const freshDay = Object.fromEntries([bucket('o3', 0, 60000, 60000, 30)])
  const baseFresh = baselineRatio(freshDay, 'o3', now)
  ok(
    baseFresh.avgLatencyMs === 2000 && baseFresh.source === 'current-hour',
    `头一小时回退当前桶（${baseFresh.source}，${baseFresh.avgLatencyMs}ms）`,
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

  // (g) 自动路由关掉 → 周期状态全清（连锁机制同调度器侧）
  await store.mutate((latest) => {
    latest.settings.autoRoute = { ...latest.settings.autoRoute, enabled: false }
  })
  await watcher.tick()
  ok(watcher.snapshot().evaluation === null && watcher.snapshot().demoted.length === 0, '关闭自动路由 → 周期状态清空')

  ok(DRIFT_COOLDOWN_MS === 10 * 60_000, `默认冷却 10 分钟（${DRIFT_COOLDOWN_MS}）`)
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
