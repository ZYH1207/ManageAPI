/**
 * 真实价速比漂移监视器 + 自动路由故障转移状态机。
 *
 * 职责（2026-10-29 与作者定的设计）：
 *   1. 记样本：网关每单提交成功的真实请求（首字 + usage）顺路记进内存快窗口，
 *      成本在 tick 里按报价估算（estimateCostCny，与 offerStats 的 estCost 同一份
 *      算法，口径不会漂）；热路径只做一次数组 push，绝不算钱
 *   2. 每分钟判一次：现役供给的「快窗口现值」比「offerStats 慢基线」差出
 *      DRIFT_THRESHOLD（30%）→ 判漂移
 *   3. 漂移即转移：把现役供给降级（本轮周期内不再当「最优」），pickAutoRoute
 *      自动改派探针价速比最优的备选；转移后新现役有试跑窗（攒满样本数或
 *      超时才允许再判它），冷却期内不再因漂移转移
 *   4. 逃生舱：备选挨个转移完还是不达标 → 踢一轮 Lite 探针刷新基础分，
 *      清空降级名单开新周期
 *
 * 诊断级故障（指纹不符 / 截断 / 虚报 / 断流）不走这里——它们走 core/failover.js
 * 的故障信号快速通道，确定坏不需要等统计阈值，也不受冷却限制。
 *
 * 状态全部在内存：重启后快窗口空、基线从 offerStats 重建，最多几分钟内
 * 判不了漂移——保守方向，无害。降级名单跟着清空，重启即新周期。
 */
import * as store from '../core/store.js'
import * as bench from '../core/benchmark.js'
import { pickAutoRoute, applyAutoRoutePick, normalizeAutoRoute } from '../core/auto-route.js'
import { scoreOffers } from '../core/score.js'
import { routeableOffers } from '../core/inventory.js'
import { estimateCostCny } from '../core/offer-stats.js'
import {
  evaluateDrift,
  usableSample,
  FAST_WINDOW_MS,
  BASELINE_HOURS,
} from '../core/real-drift.js'

/** 转移后的冷却期：10 分钟内不再因漂移转移（诊断故障不受限） */
export const DRIFT_COOLDOWN_MS = 10 * 60_000
/** 试跑窗：新现役攒满这么多真实样本前不判它（它还没来得及表现） */
export const TRIAL_SAMPLES = 10
/** 试跑窗兜底时长：流量稀疏时最多等这么久就开始判 */
export const TRIAL_MAX_MS = 5 * 60_000
/** 连续这么多次「漂移了但挑不出更好的」就踢一轮 Lite 探针开新周期 */
export const EXHAUST_LIMIT = 3
/** 没开自动路由时最多盯几条供给：按真实流量排前的十几条，能覆盖日常在用的模型 */
export const WATCH_LIMIT = 12

// e2e 要把节奏压到亚秒级才能验状态机，与 autoprobe 的环境变量同一先例
const envMs = (name, fallback) => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v >= 0 ? v : fallback
}
/** 每条供给的样本环上限（10 分钟窗口根本用不了这么多，纯防内存失控） */
const RING_CAP = 200

/**
 * @param {{runProbes: Function, onProbesRan?: Function, logger?: object}} deps
 *   runProbes 注入（daemon/probe-runner.js），逃生舱踢 Lite 探针用；测试可换桩
 *   onProbesRan —— 逃生舱踢完探针后回调（index.js 里拨 autoprobe 的轮巡表，
 *  下一轮从现在起算满一小时，避免一小时内重复拍）
 */
export function createDriftWatcher({ runProbes, onProbesRan = null, logger = console } = {}) {
  const trialMaxMs = envMs('MANAGE_API_TRIAL_MAX_MS', TRIAL_MAX_MS)
  const exhaustLimit = envMs('MANAGE_API_DRIFT_EXHAUST_LIMIT', EXHAUST_LIMIT)
  // offerId → 样本环 { at, ttftMs, usage }。时间乱序无所谓，聚合只看窗口；
  // costCny 在 tick 里统一换算，热路径绝不碰价格表
  const rings = new Map()
  // 本轮漂移周期里被降级的供给：pickAutoRoute 不再把它们当「最优」
  const demoted = new Set()
  let cooldownUntil = 0
  let exhausted = 0
  let probing = false
  // 试跑窗：刚转移过去的新现役，攒样本期不判它
  let trial = null // { offerId, startedAt, samples }
  // 最近一次判定（UI 读这份缓存，不必每 15 秒重算一遍）
  let lastEvaluation = null
  // 同时在监视的其它供给（自动路由关着时是流量最多的几条；开着时只有现役一条）
  let lastScan = []
  let lastSwitch = null // { at, fromOfferId, toOfferId, drift }

  function record(offerId, { ttftMs, latencyMs, usage, stream } = {}) {
    if (!offerId || !Number.isFinite(ttftMs) || ttftMs <= 0) return
    const ring = rings.get(offerId) || []
    // stream 只用于排查「流式/非流式的吐字口径差异」；归一化本身吃 usage 里的
    // completion_tokens，与是否流式无关（见 core/real-drift.js）
    ring.push({
      at: Date.now(),
      ttftMs,
      latencyMs: Number(latencyMs) || ttftMs,
      usage: usage || null,
      stream: stream === true,
    })
    if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP)
    rings.set(offerId, ring)
    if (trial && trial.offerId === offerId) trial.samples += 1
  }

  /** 测试与预热用：直接灌已折算好的样本（costCny 必须有） */
  function seedSample(offerId, sample) {
    if (!usableSample(sample)) return
    const ring = rings.get(offerId) || []
    ring.push({
      at: sample.at ?? Date.now(),
      ttftMs: sample.ttftMs,
      latencyMs: sample.latencyMs,
      outTokens: sample.outTokens,
      costCny: sample.costCny,
      stream: sample.stream === true,
    })
    if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP)
    rings.set(offerId, ring)
    if (trial && trial.offerId === offerId) trial.samples += 1
  }

  function resetCycle() {
    demoted.clear()
    cooldownUntil = 0
    exhausted = 0
    trial = null
  }

  /** 环里的原始样本 → 漂移判定吃的形状（usage → 成本/吐字量换算在这做，报价同 offerStats） */
  function convert(ring, offer, settings, benchmarks, now) {
    const out = []
    for (const s of ring || []) {
      if (now - s.at > FAST_WINDOW_MS) continue
      if (!Number.isFinite(s.ttftMs) || s.ttftMs <= 0) continue
      const latencyMs = Number.isFinite(s.latencyMs) && s.latencyMs >= s.ttftMs ? s.latencyMs : s.ttftMs
      const costCny =
        Number.isFinite(s.costCny) && s.costCny >= 0
          ? s.costCny
          : estimateCostCny(offer, s.usage, settings, benchmarks)
      out.push({
        at: s.at,
        ttftMs: s.ttftMs,
        latencyMs,
        outTokens: Number(s.usage?.completion_tokens) || Number(s.outTokens) || 0,
        stream: s.stream === true,
        costCny,
      })
    }
    return out
  }

  /**
   * 没开自动路由时要盯谁：按真实流量排前的几条供给。
   *
   * 不能「快窗口里有东西就不看账本」——这十分钟只走过一两条供给、
   * 流量最大的那条恰好没流量时，会被完全漏掉。所以两份并起来取并集，
   * 按 6 小时总流量（账本 requests + 快窗口样本数）排序，流量最大的
   * 那几条才能保证被盯上。
   */
  function watchedOffers(db, now) {
    const live = new Map()
    // 快窗口：最近 10 分钟真在跑的（进程重启会空，不能只靠它）
    for (const [offerId, ring] of rings) {
      const n = (ring || []).filter(
        (s) => usableSample(s) && (!Number.isFinite(s.at) || now - s.at <= FAST_WINDOW_MS),
      ).length
      if (n > 0) live.set(offerId, n)
    }
    // 账本：最近 6 小时小时桶的样本数（即使快窗口空也补上流量最大的几条）。
    // 取样口径取 requests / latencyCount / ttftCount 里最大的那个：正常桶三者相等，
    // 但老数据与测试夹具可能只填了其中一个，只认 requests 会把有数的桶当成 0 单
    const cutoff = now - BASELINE_HOURS * 3600_000
    for (const [key, b] of Object.entries(db.offerStats || {})) {
      const sep = String(key).lastIndexOf('|')
      if (sep <= 0 || !b) continue
      const start = Date.parse(`${String(key).slice(sep + 1)}:00:00Z`)
      if (Number.isFinite(start) && start < cutoff) continue
      const offerId = String(key).slice(0, sep)
      const weight = Math.max(Number(b.requests) || 0, Number(b.latencyCount) || 0, Number(b.ttftCount) || 0)
      live.set(offerId, (live.get(offerId) || 0) + weight)
    }
    return [...live.entries()]
      .filter(([offerId]) => db.offers.some((o) => o.id === offerId))
      .sort((a, b) => b[1] - a[1])
      .slice(0, WATCH_LIMIT)
      .map(([offerId]) => offerId)
  }

  const fmtMs = (v) => (Number.isFinite(v) ? `${(v / 1000).toFixed(1)}s` : '?')

  /**
   * 调度器每分钟调一次：算基线、判漂移，自动路由开着时才执行转移。
   *
   * 监视与动手是两件事：基线（6 小时近期值 + 30 天常量值）是网关每单顺路记账
   * 攒出来的，跟「谁来派活」无关。自动路由关着的时候只是没有「改派给谁」，
   * 不代表算不了「这条线现在比平时慢多少」——所以这里先算，再决定动不动手。
   */
  async function tick() {
    const db = await store.readDb()
    const settings = db.settings || {}
    const record = normalizeAutoRoute(settings.autoRoute)
    // 总开关：用户可以在诊断页关掉漂移检测（自动路由仍然工作，只是不靠真实分转移）
    if (settings.driftEnabled === false) {
      resetCycle()
      lastEvaluation = null
      lastScan = []
      return
    }
    // 可调参数：环境变量 > 设置 > 默认（环境变量是测试压节奏用的）
    const threshold =
      Number.isFinite(Number(settings.driftThresholdPct)) && Number(settings.driftThresholdPct) > 0
        ? Number(settings.driftThresholdPct) / 100
        : undefined
    const cooldownMs =
      envMs('MANAGE_API_DRIFT_COOLDOWN_MS', 0) ||
      (Number(settings.driftCooldownMinutes) > 0 ? Number(settings.driftCooldownMinutes) * 60_000 : DRIFT_COOLDOWN_MS)
    const trialSamples =
      envMs('MANAGE_API_TRIAL_SAMPLES', 0) ||
      (Number(settings.driftTrialSamples) > 0 ? Number(settings.driftTrialSamples) : TRIAL_SAMPLES)
    const now = Date.now()
    const benchmarks = await bench.readBenchmarks().catch(() => ({}))
    // 监视对象与改派对象是两回事：
    //   - 监视：始终盯真实流量最多的那几条（基线账是日常累积的，不管开不开自动路由都要算）
    //   - 改派：只看自动路由的现役那条（换也只有它能换）
    // 以前自动路由开着就只算现役一条，结果用户看到「只有一格有数」，
    // 实际上其它模型也在跑，只是没人算了。
    const autoWatching = Boolean(record.enabled && record.offerId)
    const watched = watchedOffers(db, now)
    // 现役那条必须当第一优先：它是改派的对象，判不出来就没法动手
    const targets = autoWatching
      ? [record.offerId, ...watched.filter((id) => id !== record.offerId)]
      : watched

    // 每条监视对象都算一份完整判定（现值 + 两档基线 + 分项漂移），UI 直接照这份画
    const scan = []
    for (const offerId of targets) {
      const offer = db.offers.find((o) => o.id === offerId) || null
      if (!offer) continue
      const ring = rings.get(offerId) || []
      // 最近一单是什么时候：现值空着时用它告诉用户「账没断，只是这十分钟没用过」
      let lastSampleAt = null
      for (const s of ring) {
        if (Number.isFinite(s.at) && (lastSampleAt === null || s.at > lastSampleAt)) lastSampleAt = s.at
      }
      const converted = convert(ring, offer, db.settings, benchmarks, now)
      // 标签一并算好：状态里只下发「在役」供给（routeableOffers），
      // 被忽略/停用的供给前端查不到名字，只能显原始 offerId
      const provider = db.providers.find((p) => p.id === offer.providerId) || null
      const label = `${provider?.name || '?'} · ${offer.modelKey || offer.upstreamName || '?'}`
      scan.push({
        offerId,
        label,
        at: now,
        lastSampleAt,
        ...evaluateDrift(converted, db.offerStats, offerId, now, threshold),
      })
    }
    lastScan = scan
    // 主监控：自动路由开着就是现役那条（scan[0]），关着是流量最多的那条
    const evaluation = scan.find((r) => r.offerId === record.offerId) || scan[0] || null
    lastEvaluation = evaluation

    // 没开自动路由：账照算、漂移照判，但不动手——没有「改派给谁」这回事。
    // 降级名单/冷却/试跑窗一并作废，免得重新开启自动路由时带着上一轮的旧账把好站排除在外
    if (!autoWatching) {
      resetCycle()
      return
    }
    if (!evaluation) return

    if (evaluation.verdict !== 'drifted') {
      // 现役恢复正常 → 从降级名单放出来重新参选；连续成功也把逃生舱计数清零
      if (demoted.delete(record.offerId)) {
        logger.info?.('[漂移转移] 现役供给真实价速比回到基线附近，恢复参选资格')
      }
      if (evaluation.verdict === 'ok') exhausted = 0
      return
    }

    // 试跑窗：新现役还没攒够样本，它「漂移」可能只是头几单的冷启动抖动
    if (trial && trial.offerId === record.offerId) {
      if (trial.samples < trialSamples && now - trial.startedAt < trialMaxMs) return
      trial = null
    }
    // 冷却期：刚转移过，让新现役跑一会儿再说
    if (now < cooldownUntil) return

    demoted.add(record.offerId)
    const fmtMs = (v) => (Number.isFinite(v) ? `${(v / 1000).toFixed(1)}s` : '?')
    logger.info?.(
      `[漂移转移] 现役供给真实总耗时 ${fmtMs(evaluation.current)} 比基线 ${fmtMs(
        evaluation.baseline,
      )} 慢 ${(evaluation.drift * 100).toFixed(0)}%（样本 ${evaluation.samples}），降级并改派`,
    )

    const pick = pickAutoRoute(db, {
      scores: scoreOffers(db.probes, db.traffic, {
        maxAgeMs: (Number(db.settings.scoreMaxAgeHours) || 6) * 3600 * 1000,
      }),
      benchmarks,
      driftDemoted: demoted,
    })

    // 挑出了别的供给（哪怕是同模型的另一条）→ 转移
    if (pick && pick.offerId && pick.offerId !== record.offerId) {
      const fromOfferId = record.offerId
      await store.mutate((latest) => {
        applyAutoRoutePick(latest.settings, { ...pick, reason: 'drift-failover' })
      })
      lastSwitch = { at: now, fromOfferId, toOfferId: pick.offerId, drift: evaluation.drift }
      cooldownUntil = now + cooldownMs
      trial = { offerId: pick.offerId, startedAt: now, samples: 0 }
      exhausted = 0
      logger.info?.(
        `[漂移转移] 已改派 ${pick.providerName ?? ''} ${pick.upstreamName}（探针价速比最优的备选），冷却 ${Math.round(cooldownMs / 60000)} 分钟`,
      )
      return
    }

    // 备选全试完还是不行（或全场只剩降级的）→ 数着次数踢 Lite 探针开新周期
    exhausted += 1
    logger.info?.(`[漂移转移] 漂移但挑不出未降级的备选（连续第 ${exhausted}/${exhaustLimit} 次）`)
    if (exhausted >= exhaustLimit && !probing) {
      probing = true
      try {
        const targets = routeableOffers(db).map((o) => o.id)
        if (targets.length > 0) {
          const results = await runProbes({ offerIds: targets, lite: true, cache: 'auto' })
          onProbesRan?.()
          logger.info?.(
            `[漂移转移] 备选耗尽，踢一轮 Lite 探针刷新基础分（${results.length} 个目标），开新周期`,
          )
        }
        resetCycle()
      } catch (error) {
        logger.warn?.(`[漂移转移] 逃生舱 Lite 探针失败：${error.message}`)
      } finally {
        probing = false
      }
    }
  }

  /** UI 读的快照：最近一次判定 + 同时在监视的几条 + 周期状态。纯读缓存，随便调。 */
  function snapshot() {
    return {
      evaluation: lastEvaluation,
      scan: lastScan,
      demoted: [...demoted],
      cooldownUntil: cooldownUntil || null,
      trial: trial ? { ...trial } : null,
      lastSwitch,
      fastWindowMs: FAST_WINDOW_MS,
      baselineHours: BASELINE_HOURS,
    }
  }

  /** 网关热路径重挑时用：本轮降级名单（快照数组），空数组 = 无降级 */
  function demotedList() {
    return [...demoted]
  }

  return { record, tick, snapshot, resetCycle, seedSample, demotedList }
}
