/**
 * 异常诊断：没报错，但表现不对劲。
 *
 * 中转站最坑人的地方恰恰是不报错：请求 200 通过、账单照扣，可它把速度砍了一半、
 * 把思考关掉、把缓存关了、把输出截短。错误码一个都不给你，只能靠「感觉不对劲」。
 * 这里把「感觉」换成数字：拿当前表现和**它自己的历史基线**比、和**同模型的其他站**比。
 *
 * 三条铁律（少一条都会变成误报机器）：
 *   1. 样本不足不下结论——宁可漏报，不能把好站挂成异常；
 *   2. 必须给自己的基线：每家站的速度底子不同，拿 A 家的绝对值和 B 家比没意义；
 *   3. 结论要能解释「凭什么说它变了」，所以每条都带 基线值 / 当前值 / 参照值。
 *
 * 数据源是 db.offerStats（按 供给×小时 聚合），已经在 recordRoutingBatch 里
 * 跟着真实流量落盘，这里不发任何请求。
 */

/** 最近窗口：判断「现在」有多长 */
export const RECENT_HOURS = 6
/** 基线最多往回看几天 */
export const BASELINE_DAYS = 7
/** 判定所需最少请求数（两个窗口都要满足） */
export const MIN_REQUESTS = 20
/** 速度劣化阈值：当前首字是基线的多少倍 */
export const TTFT_REGRESS_RATIO = 1.6
/** 吐字速度掉到基线的多少倍算异常 */
export const TPS_DROP_RATIO = 0.6
/** 缓存命中率掉到这个绝对值以下、且基线本来很高，才算「被关了缓存」 */
export const CACHE_OFF_RECENT = 0.35
export const CACHE_OFF_BASELINE = 0.6
/** 思考占比掉到这个绝对值以下、且基线本来很高，才算「偷思考」 */
export const THINK_STOLEN_RECENT = 0.08
export const THINK_STOLEN_BASELINE = 0.4
/** 单请求输出量掉到基线的多少倍算「输出变短」 */
export const OUTPUT_SHRINK_RATIO = 0.6
/** 真实失败率超过它、而探针还说健康 → 间歇性抽风 */
export const INTERMITTENT_FAIL_RATE = 0.15
/** 同一模型里，某条供给首字超过同组中位数的多少倍算「明显慢于别家」 */
export const CROSS_SLOW_RATIO = 2

const hourMs = (h) => Date.parse(`${h}:00:00Z`)
const bucketTs = (b) => hourMs(b.hour)

/** 把一组小时桶合并成一个窗口的累计量 */
export function mergeWindow(buckets) {
  const m = {
    requests: 0,
    ok: 0,
    broken: 0,
    failed: 0,
    // 客户端自己取消的数量：不进失败率分母（2026-10-29 现场：144 次自动副任务
    // 超时被算成断流，把真断流稀释到阈值以下）
    clientAborts: 0,
    ttftSum: 0,
    ttftCount: 0,
    genOutSum: 0,
    genTimeSum: 0,
    genCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    estCostSum: 0,
    estCostCount: 0,
    streamGapMax: 0,
    buckets: 0,
  }
  for (const b of buckets) {
    m.buckets += 1
    m.requests += b.requests || 0
    m.ok += b.ok || 0
    m.broken += b.broken || 0
    m.failed += b.failed || 0
    m.clientAborts += b.clientAborts || 0
    m.ttftSum += b.ttftSum || 0
    m.ttftCount += b.ttftCount || 0
    m.genOutSum += b.genOutSum || 0
    m.genTimeSum += b.genTimeSum || 0
    m.genCount += b.genCount || 0
    m.inputTokens += b.inputTokens || 0
    m.outputTokens += b.outputTokens || 0
    m.cachedTokens += b.cachedTokens || 0
    m.reasoningTokens += b.reasoningTokens || 0
    m.estCostSum += b.estCostSum || 0
    m.estCostCount += b.estCostCount || 0
    m.streamGapMax = Math.max(m.streamGapMax, b.streamGapMax || 0)
  }
  return m
}

/** 窗口累计量 → 可比较的指标；算不出来的给 null，不要用 0 假装 */
export function windowMetrics(m) {
  // 客户端取消的请求不算站方的成绩：既不算成功、也不算失败，分母里一并剔掉
  const served = Math.max(0, (m.requests || 0) - (m.clientAborts || 0))
  return {
    requests: m.requests,
    ttft: m.ttftCount ? m.ttftSum / m.ttftCount : null,
    tps: m.genTimeSum > 0 ? m.genOutSum / (m.genTimeSum / 1000) : null,
    cacheHit: m.inputTokens > 0 ? m.cachedTokens / m.inputTokens : null,
    reasoningRatio: m.outputTokens > 0 ? m.reasoningTokens / m.outputTokens : null,
    outPerReq: m.requests > 0 ? m.outputTokens / m.requests : null,
    costPerReq: m.estCostCount > 0 ? m.estCostSum / m.estCostCount : null,
    failRate: served > 0 ? (m.broken + m.failed) / served : null,
    gapMax: m.streamGapMax || null,
  }
}

/**
 * 按供给切分时间窗：recent（最近 RECENT_HOURS 小时）与 baseline（再往前到 BASELINE_DAYS 天）。
 * 返回 Map<offerId, { recent, baseline, recentM, baselineM }>，只有两个窗口都有样本的才留下。
 */
export function splitWindows(offerStats, nowMs = Date.now()) {
  const recentCut = nowMs - RECENT_HOURS * 3600000
  const baseCut = nowMs - BASELINE_DAYS * 86400000
  const byOffer = new Map()
  for (const b of Object.values(offerStats)) {
    const ts = bucketTs(b)
    if (!Number.isFinite(ts) || ts < baseCut) continue
    let entry = byOffer.get(b.offerId)
    if (!entry) {
      entry = { offerId: b.offerId, recent: [], baseline: [] }
      byOffer.set(b.offerId, entry)
    }
    if (ts >= recentCut) entry.recent.push(b)
    else entry.baseline.push(b)
  }
  const out = new Map()
  for (const [id, entry] of byOffer) {
    const recentM = mergeWindow(entry.recent)
    const baselineM = mergeWindow(entry.baseline)
    out.set(id, { offerId: id, recentM, baselineM })
  }
  return out
}

/**
 * 同模型跨站参照：给每个 offer 算出**其他**供给的首字中位数。
 * 必须排除自己——把「自己」算进「别家」会把中位数往自己这边拉，
 * 変慢的那家自己就能把「别家中位数」抬高，变成自己证明自己没问题。
 */
export function peerTtftByModel(windows, offerMeta) {
  const byModel = new Map()
  for (const [offerId, w] of windows) {
    const key = offerMeta.get(offerId)?.modelKey
    if (!key) continue
    const ttft = windowMetrics(w.recentM).ttft
    if (ttft === null || w.recentM.requests < MIN_REQUESTS) continue
    if (!byModel.has(key)) byModel.set(key, [])
    byModel.get(key).push({ offerId, ttft })
  }
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b)
    const mid = s.length >> 1
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  }
  const out = new Map()
  for (const [offerId, w] of windows) {
    const key = offerMeta.get(offerId)?.modelKey
    const group = key ? byModel.get(key) || [] : []
    const others = group.filter((x) => x.offerId !== offerId).map((x) => x.ttft)
    // 至少要有一家**别家**可比，才谈得上「别家正常」
    out.set(offerId, others.length >= 1 ? median(others) : null)
  }
  return out
}

const pct = (v) => `${Math.round(v * 100)}%`
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`

/**
 * 主入口：产出异常 findings（结构与错误诊断一致，多了 category:'anomaly'）。
 *
 * @param {object} opts
 * @param {object} opts.offerStats  db.offerStats
 * @param {Map}    opts.offerMeta   offerId → { label, modelKey, providerName }
 * @param {object} opts.scores      offerId → score（用来判定「探针说健康却总失败」）
 * @param {number} opts.nowMs
 */
export function detectAnomalies({ offerStats = {}, offerMeta = new Map(), scores = {}, nowMs = Date.now() } = {}) {
  const windows = splitWindows(offerStats, nowMs)
  const peers = peerTtftByModel(windows, offerMeta)
  const findings = []
  // owner：这条结论属于哪条供给/哪个站。归因收敛靠它把「同一个站的多个症状」
  // 聚到一条根因下（例：余额空的站同时报「间歇抽风」「限流」——那都是一个病）
  const push = (f, owner = null) =>
    findings.push({
      category: 'anomaly',
      ...(owner ? { offerId: owner.offerId, providerId: owner.providerId || null } : {}),
      ...f,
    })

  for (const [offerId, w] of windows) {
    const meta = offerMeta.get(offerId) || { label: offerId }
    const label = meta.label || offerId
    const cur = windowMetrics(w.recentM)
    const base = windowMetrics(w.baselineM)
    // 两个窗口都要有足够样本，否则不谈「变化」
    if (w.recentM.requests < MIN_REQUESTS || w.baselineM.requests < MIN_REQUESTS) continue

    // ① 变慢：首字明显慢于自己的基线
    if (cur.ttft !== null && base.ttft !== null && base.ttft > 0) {
      const ratio = cur.ttft / base.ttft
      if (ratio >= TTFT_REGRESS_RATIO) {
        const peer = peers.get(offerId)
        const peerNote =
          peer !== null && peer > 0
            ? `；同模型的别家中位数 ${secs(peer)}，${cur.ttft > peer * CROSS_SLOW_RATIO ? '别家正常，是这一家自己的问题' : '别家也慢，可能是模型本身忙'}`
            : ''
        push({
          id: `ttft-regress-${offerId}`,
          layer: 'site',
          severity: ratio >= 2.5 ? 'danger' : 'warn',
          title: `${label} 首字变慢到 ${secs(cur.ttft)}（基线 ${secs(base.ttft)}，慢 ${ratio.toFixed(1)} 倍）`,
          detail: `样本：近期 ${w.recentM.requests} 单 / 基线 ${w.baselineM.requests} 单${peerNote}`,
          evidence: { recentTtftMs: Math.round(cur.ttft), baselineTtftMs: Math.round(base.ttft), ratio, peerTtftMs: peer },
          action: '在智能决策页把这条供给降到后面，或先停用观察一段时间',
        }, { offerId, providerId: meta.providerId || null })
      }
    }

    // ② 吐字变慢：TPS 掉下去（体感「卡顿」的另一半）
    if (cur.tps !== null && base.tps !== null && base.tps > 0) {
      const ratio = cur.tps / base.tps
      if (ratio <= TPS_DROP_RATIO) {
        push({
          id: `tps-drop-${offerId}`,
          layer: 'upstream',
          severity: ratio <= 0.35 ? 'danger' : 'warn',
          title: `${label} 吐字速度掉到 ${cur.tps.toFixed(1)} 字/秒（基线 ${base.tps.toFixed(1)}）`,
          detail: `输出总时长里生成的部分变慢，常见于站方限速或把请求转发到低配通道`,
          evidence: { recentTps: Number(cur.tps.toFixed(2)), baselineTps: Number(base.tps.toFixed(2)), ratio: Number(ratio.toFixed(2)) },
          action: '避开高峰使用；持续这样就把这条供给降权',
        }, { offerId, providerId: meta.providerId || null })
      }
    }

    // ③ 偷思考：基线有明显思考，现在几乎没有了
    if (
      base.reasoningRatio !== null &&
      cur.reasoningRatio !== null &&
      base.reasoningRatio >= THINK_STOLEN_BASELINE &&
      cur.reasoningRatio <= THINK_STOLEN_RECENT
    ) {
      push({
        id: `think-stolen-${offerId}`,
        layer: 'upstream',
        severity: 'warn',
        title: `${label} 的思考量从 ${pct(base.reasoningRatio)} 掉到 ${pct(cur.reasoningRatio)}`,
        detail: '你的请求没变，思考 token 却几乎没了——典型的「偷偷关掉 reasoning」降智',
        evidence: {
          baselineReasoningRatio: Number(base.reasoningRatio.toFixed(3)),
          recentReasoningRatio: Number(cur.reasoningRatio.toFixed(3)),
        },
        action: '换一家站跑同一模型对比；这条供给别用在需要思考的任务上',
      }, { offerId, providerId: meta.providerId || null })
    }

    // ④ 缓存被关：命中率从高掉到低，等于成本翻倍
    if (
      base.cacheHit !== null &&
      cur.cacheHit !== null &&
      base.cacheHit >= CACHE_OFF_BASELINE &&
      cur.cacheHit <= CACHE_OFF_RECENT
    ) {
      push({
        id: `cache-off-${offerId}`,
        layer: 'site',
        severity: 'warn',
        title: `${label} 缓存命中率从 ${pct(base.cacheHit)} 掉到 ${pct(cur.cacheHit)}`,
        detail: '同样长度的上下文被全额计费了，实际花费会比比价页估算高出一截',
        evidence: {
          baselineCacheHit: Number(base.cacheHit.toFixed(3)),
          recentCacheHit: Number(cur.cacheHit.toFixed(3)),
        },
        action: '看一眼监控页这家余额掉得是不是变快了；明显变快就换站',
      }, { offerId, providerId: meta.providerId || null })
    }

    // ⑤ 输出变短：同样的请求，回答被砍掉一截（截断/降智的间接证据）
    if (cur.outPerReq !== null && base.outPerReq !== null && base.outPerReq > 0) {
      const ratio = cur.outPerReq / base.outPerReq
      if (ratio <= OUTPUT_SHRINK_RATIO) {
        push({
          id: `output-shrink-${offerId}`,
          layer: 'upstream',
          severity: 'warn',
          title: `${label} 平均每单输出从 ${Math.round(base.outPerReq)} 字掉到 ${Math.round(cur.outPerReq)}`,
          detail: '请求没变短，回答先变短了——可能被压低 max_tokens 或换成了小模型',
          evidence: { recentOutPerReq: Math.round(cur.outPerReq), baselineOutPerReq: Math.round(base.outPerReq), ratio: Number(ratio.toFixed(2)) },
          action: '用探针页对这个模型重测一次指纹与截断',
        }, { offerId, providerId: meta.providerId || null })
      }
    }

    // ⑥ 间歇性抽风：探针说健康，真实失败率却不低
    const score = scores[offerId]
    const probeHealthy = score?.status === 'healthy' || score?.routable === true
    if (probeHealthy && cur.failRate !== null && cur.failRate >= INTERMITTENT_FAIL_RATE) {
      push({
        id: `intermittent-${offerId}`,
        layer: 'upstream',
        severity: 'danger',
        title: `${label} 探针显示健康，但近 ${RECENT_HOURS} 小时真实失败率 ${pct(cur.failRate)}`,
        detail: `探针只戳一两次、间隔很久；真实流量才暴露「时好时坏」（${w.recentM.broken} 断流 / ${w.recentM.failed} 失败 / ${w.recentM.requests} 请求）`,
        evidence: { failRate: Number(cur.failRate.toFixed(3)), requests: w.recentM.requests, broken: w.recentM.broken, failed: w.recentM.failed },
        action: '别只信探针的绿灯；这是「看着正常但一打就报错」的典型，建议降权',
      }, { offerId, providerId: meta.providerId || null })
    }
  }

  findings.sort((a, b) => {
    const order = { danger: 0, warn: 1, info: 2 }
    return order[a.severity] - order[b.severity]
  })
  return findings
}
