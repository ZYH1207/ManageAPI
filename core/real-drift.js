/**
 * 真实速度漂移检测（纯函数层）。
 *
 * 探针量出来的价速比有两个天然缺陷：
 *   1. 探针环境（小 prompt、独占连接）≠ 真实负载（agent 大上下文、并发排队），
 *      探针分只能当参考，不能当现况；
 *   2. 探针是快照，两轮之间站变了没人知道。
 *
 * 解法：网关每单真实请求顺路记一笔（首字、总耗时、吐字量），在内存里滚一个
 * 「快窗口」，和 offerStats 小时桶聚出来的「慢基线」比——现值比自己的基线
 * 慢出阈值就是漂移。全部是同源数据的自比，不跟探针分直接比。
 *
 * 综合分口径：**真实总耗时**（首字 + 吐字，网关实测）。
 * 首字和吐字卡的是不同资源（prefill 算力 vs decode 带宽），会解耦劣化
 * （首字正常、吐字被抽走是真实存在的病态），总耗时把两项按真实输出长度
 * 分布自动加权——短回复为主的时段偏向首字，长回复多的时段偏向吐字速度，
 * 不需要人工定权重。分项（首字漂移 / 吐字漂移）单独算出来供 UI 定位
 * 是哪半边烂，但触发只用总耗时。
 *
 * 为什么不是「成本 ÷ 耗时」：那会把「吐字被抽慢一倍、价格没变」判成
 * 「每秒成本减半 = 变好」，方向反了。变慢就是变慢；价格变化走探针分和
 * 落价机制反映在排序里，不归漂移检测管。
 *
 * 纯函数约定：不读库、不落盘；快窗口的存储由调用方持有（daemon 里是内存，
 * 重启即空——空窗口只意味着「暂时判不了漂移」，保守方向，无害）。
 */

/** 快窗口长度：现值只看最近这么久（太长就失去「实时」意义） */
export const FAST_WINDOW_MS = 10 * 60_000
/** 快窗口最少样本数：少于这个不下漂移结论（和评分层 MIN_SAMPLES 同一哲学） */
export const FAST_MIN_SAMPLES = 5
/** 慢基线回看的小时数（offerStats 小时桶） */
export const BASELINE_HOURS = 6
/** 慢基线最少首字样本数（总耗时和首字同门槛） */
export const BASELINE_MIN_SAMPLES = 5
/** 漂移阈值：现值比基线慢出这个比例算漂移（0.30 = 慢了 30%） */
export const DRIFT_THRESHOLD = 0.3

/** 单条样本：总耗时要 ≥ 首字（吐字段不可能为负） */
export function usableSample(sample) {
  return (
    sample &&
    Number.isFinite(sample.ttftMs) &&
    sample.ttftMs > 0 &&
    Number.isFinite(sample.latencyMs) &&
    sample.latencyMs >= sample.ttftMs
  )
}

/**
 * 快窗口聚合：平均总耗时（综合分主体）+ 分项（平均首字、吐字速度）。
 * @returns {{avgLatencyMs:number|null, avgTtftMs:number|null, tps:number|null, samples:number}}
 */
export function fastCurrent(samples, now = Date.now()) {
  let latencySum = 0
  let ttftSum = 0
  let genOutSum = 0
  let genTimeSum = 0
  let n = 0
  for (const s of samples || []) {
    if (!usableSample(s)) continue
    if (Number.isFinite(s.at) && now - s.at > FAST_WINDOW_MS) continue
    latencySum += s.latencyMs
    ttftSum += s.ttftMs
    const genOut = Number(s.outTokens) || 0
    const genTime = s.latencyMs - s.ttftMs
    if (genOut > 0 && genTime > 0) {
      genOutSum += genOut
      genTimeSum += genTime
    }
    n += 1
  }
  if (n < FAST_MIN_SAMPLES) return { avgLatencyMs: null, avgTtftMs: null, tps: null, samples: n }
  return {
    avgLatencyMs: latencySum / n,
    avgTtftMs: ttftSum / n,
    tps: genTimeSum > 0 ? genOutSum / genTimeSum : null, // token/ms，×1000 = tok/s
    samples: n,
  }
}

/**
 * 慢基线：offerStats 小时桶里最近 BASELINE_HOURS 小时的加权均值。
 *
 * 优先用历史桶（排除最新的当前小时桶）——漂移中的样本正往里写，拿它当基线
 * 等于自己跟自己比，漂移永远探不出来（温水煮青蛙）。
 * 但每天头一个小时没有历史桶，按这条会全程失明，所以回退：没有可用的
 * 历史桶时，用当前小时桶当基线。代价是漂移样本会稀释基线，但稀释方向安全：
 * 只会把检测到的漂移往小了估（30% 可能显示为 25%），绝不往大了误报。
 *
 * @param {Object} offerStats db.offerStats（key = `${offerId}|${hourKey}`）
 * @param {string} offerId
 * @returns {{avgLatencyMs:number|null, avgTtftMs:number|null, tps:number|null,
 *            samples:number, source:'history'|'current-hour'|null}}
 */
export function baselineRatio(offerStats, offerId, now = Date.now()) {
  const hist = emptySums()
  const cur = emptySums()
  let newestHour = ''
  for (const key of Object.keys(offerStats || {})) {
    if (!key.startsWith(`${offerId}|`)) continue
    const hour = key.slice(offerId.length + 1)
    if (hour > newestHour) newestHour = hour
  }
  const cutoff = now - BASELINE_HOURS * 3600_000
  for (const key of Object.keys(offerStats || {})) {
    if (!key.startsWith(`${offerId}|`)) continue
    const hour = key.slice(offerId.length + 1)
    const bucketStart = Date.parse(`${hour}:00:00Z`)
    if (Number.isFinite(bucketStart) && bucketStart < cutoff) continue
    const b = offerStats[key]
    if (!b) continue
    const acc = hour >= newestHour ? cur : hist
    acc.balance = true
    if (Number(b.latencyCount) > 0) {
      acc.latencySum += Number(b.latencySum) || 0
      acc.latencyCount += Number(b.latencyCount)
    }
    if (Number(b.ttftCount) > 0) {
      acc.ttftSum += Number(b.ttftSum) || 0
      acc.ttftCount += Number(b.ttftCount)
    }
    if (Number(b.genTimeSum) > 0 && Number(b.genOutSum) > 0) {
      acc.genOutSum += Number(b.genOutSum)
      acc.genTimeSum += Number(b.genTimeSum)
    }
  }
  // 历史桶够 → 用历史（无自身污染，首选）；不够 → 回退当前小时桶（有稀释但方向保守）
  const fromSums = (sums, source) => {
    if (sums.latencyCount < BASELINE_MIN_SAMPLES) {
      return { avgLatencyMs: null, avgTtftMs: null, tps: null, samples: sums.latencyCount, source: null }
    }
    return {
      avgLatencyMs: sums.latencySum / sums.latencyCount,
      avgTtftMs: sums.ttftCount > 0 ? sums.ttftSum / sums.ttftCount : null,
      tps: sums.genTimeSum > 0 ? sums.genOutSum / sums.genTimeSum : null,
      samples: sums.latencyCount,
      source,
    }
  }
  const fromHistory = fromSums(hist, 'history')
  if (fromHistory.avgLatencyMs !== null) return fromHistory
  return fromSums(cur, 'current-hour')
}

function emptySums() {
  return { latencySum: 0, latencyCount: 0, ttftSum: 0, ttftCount: 0, genOutSum: 0, genTimeSum: 0, balance: false }
}

/**
 * 漂移判定：真实总耗时现值比基线慢出 DRIFT_THRESHOLD 就是漂移。
 * 分项漂移（首字/吐字）一并返回供 UI 定位，但不参与触发——解耦型劣化
 * 在总耗时里体现得清清楚楚，不需要单独触发。
 * @param {number} [threshold] 漂移阈值（settings.driftThresholdPct/100），缺省 30%
 * @returns {{verdict:'drifted'|'ok'|'insufficient', drift:number|null,
 *            ttftDrift:number|null, tpsDrift:number|null,
 *            current:number|null, baseline:number|null, samples:number}}
 *   current/baseline = 平均总耗时（毫秒）
 */
export function evaluateDrift(samples, offerStats, offerId, now = Date.now(), threshold = DRIFT_THRESHOLD) {
  const cur = fastCurrent(samples, now)
  const base = baselineRatio(offerStats, offerId, now)
  if (cur.avgLatencyMs === null || base.avgLatencyMs === null) {
    return {
      verdict: 'insufficient',
      drift: null,
      ttftDrift: null,
      tpsDrift: null,
      current: cur.avgLatencyMs,
      baseline: base.avgLatencyMs,
      samples: cur.samples,
    }
  }
  const drift = (cur.avgLatencyMs - base.avgLatencyMs) / base.avgLatencyMs
  // 分项：首字漂了 %（正=变慢）；吐字漂了 %（正=变慢）。哪边缺样本就是 null
  const ttftDrift =
    Number.isFinite(cur.avgTtftMs) && Number.isFinite(base.avgTtftMs) && base.avgTtftMs > 0
      ? (cur.avgTtftMs - base.avgTtftMs) / base.avgTtftMs
      : null
  const tpsDrift =
    Number.isFinite(cur.tps) && Number.isFinite(base.tps) && base.tps > 0
      ? (base.tps - cur.tps) / base.tps
      : null
  return {
    verdict: drift >= threshold ? 'drifted' : 'ok',
    drift,
    ttftDrift,
    tpsDrift,
    current: cur.avgLatencyMs,
    baseline: base.avgLatencyMs,
    samples: cur.samples,
  }
}
