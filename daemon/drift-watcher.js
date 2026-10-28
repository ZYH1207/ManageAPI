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
} from '../core/real-drift.js'

/** 转移后的冷却期：10 分钟内不再因漂移转移（诊断故障不受限） */
export const DRIFT_COOLDOWN_MS = 10 * 60_000
/** 试跑窗：新现役攒满这么多真实样本前不判它（它还没来得及表现） */
export const TRIAL_SAMPLES = 10
/** 试跑窗兜底时长：流量稀疏时最多等这么久就开始判 */
export const TRIAL_MAX_MS = 5 * 60_000
/** 连续这么多次「漂移了但挑不出更好的」就踢一轮 Lite 探针开新周期 */
export const EXHAUST_LIMIT = 3

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
  const cooldownMs = envMs('MANAGE_API_DRIFT_COOLDOWN_MS', DRIFT_COOLDOWN_MS)
  const trialSamples = envMs('MANAGE_API_TRIAL_SAMPLES', TRIAL_SAMPLES)
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
  let lastSwitch = null // { at, fromOfferId, toOfferId, drift }

  function record(offerId, { ttftMs, latencyMs, usage } = {}) {
    if (!offerId || !Number.isFinite(ttftMs) || ttftMs <= 0) return
    const ring = rings.get(offerId) || []
    ring.push({ at: Date.now(), ttftMs, latencyMs: Number(latencyMs) || ttftMs, usage: usage || null })
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
        outTokens: Number(s.usage?.completion_tokens) || 0,
        costCny,
      })
    }
    return out
  }

  const fmtMs = (v) => (Number.isFinite(v) ? `${(v / 1000).toFixed(1)}s` : '?')

  /**
   * 调度器每分钟调一次：判漂移、执行转移。
   * 自动路由没开就只清周期状态不判——判定逻辑全部让位（连锁机制同调度器侧）。
   */
  async function tick() {
    const db = await store.readDb()
    const record = normalizeAutoRoute(db.settings.autoRoute)
    if (!record.enabled || !record.offerId) {
      resetCycle()
      lastEvaluation = null
      return
    }
    const now = Date.now()
    const benchmarks = await bench.readBenchmarks().catch(() => ({}))
    const offer = db.offers.find((o) => o.id === record.offerId) || null
    const converted = convert(rings.get(record.offerId), offer, db.settings, benchmarks, now)

    // 快窗口现值 + 慢基线 → 漂移判定（UI 缓存这份结果）
    const evaluation = evaluateDrift(converted, db.offerStats, record.offerId, now)
    lastEvaluation = { offerId: record.offerId, at: now, ...evaluation }

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

  /** UI 读的快照：最近一次判定 + 周期状态。纯读缓存，随便调。 */
  function snapshot() {
    return {
      evaluation: lastEvaluation,
      demoted: [...demoted],
      cooldownUntil: cooldownUntil || null,
      trial: trial ? { ...trial } : null,
      lastSwitch,
      fastWindowMs: FAST_WINDOW_MS,
    }
  }

  /** 网关热路径重挑时用：本轮降级名单（快照数组），空数组 = 无降级 */
  function demotedList() {
    return [...demoted]
  }

  return { record, tick, snapshot, resetCycle, seedSample, demotedList }
}
