/**
 * 真实速度漂移检测（纯函数层）。
 *
 * 数据来源：网关每单真实请求顺路记一笔（首字、总耗时、吐字量），在内存里滚
 * 一个「快窗口」；基线来自 offerStats 小时桶（同样是真实流量）。**同源自比**，
 * 不跟探针分直接比——探针只发 45 token 的小请求，量到的不是你这个负载下的速度。
 *
 * ── 归一化（2026-10-29 补，解决「20 token 的快单被当成慢站」）────────────
 *
 * 裸总耗时不能直接比：输出 20 token 的请求和输出 199 token 的请求，总量差 10 倍，
 * 但站的能力可能完全一样。实测过一组：A 单 20 token / 10.0s、B 单 199 token / 15.4s，
 * 裸比 A「更快」，归一化后 A 是 500ms/token、B 是 77ms/token，B 快 6.5 倍。
 *
 * 所以综合分不用裸总耗时，而是换算到**参照工作量**下的等效耗时：
 *
 *     composite = ttft + outRef × msPerToken
 *     msPerToken = 吐字总时长 ÷ 吐字总 token      （越大越慢）
 *     outRef     = 基线里平均每单输出多少 token   （两侧用同一个参照，公平）
 *
 * 这样短单长单都折算成「同样吐 outRef 个 token 要多久」，输出长度不再污染判定。
 * 分项 ttft / msPerToken 单独返回，供 UI 定位是哪半边烂（首字慢 vs 吐字慢）。
 *
 * 首字为什么单独算而不用归一化：TTFT 是 prefill 的时间，跟输出多少 token 无关，
 * 本来就是一个可比的量（LiteLLM 的 lowest_latency 也是这么分的：流式用 TTFT，
 * 非流式才用 秒÷token）。
 *
 * 为什么不是「成本 ÷ 耗时」：那会把「吐字被抽慢一倍、价格没变」判成
 * 「每秒成本减半 = 变好」，方向反了。变慢就是变慢；价格变化走探针分和
 * 落价机制反映在排序里，不归漂移检测管。
 *
 * ── 两档基线（2026-10-29 补，常量基线）────────────────────────────────
 *
 * 基线有两档，都是「同一条供给跟自己比」，只是回看长度不同：
 *   - 近期值（6 小时）：小时桶加权均值。管「刚才到现在变没变」，漂移判定吃它。
 *   - 常量值（30 天）：按天求均值后取中位数。管「这条线平时到底多快」，
 *     是日常反复使用攒出来的账，不跟着最近几小时抖。它存在的意义是补 6 小时
 *     基线的盲区：整段慢慢变慢时，现值跟着基线一起长，6 小时基线自己看不出问题，
 *     但跟常量一比就知道「最近一直比平时慢」。
 * 两档都不依赖自动路由：账是网关每单顺路记的，跟谁来派活无关。
 * 两档**都走同一套归一化口径**（combine / msPerToken / outRef 只写一份），
 * 否则短单长单的污染只修了一半，6 小时基线和常量基线会各说各话。
 *
 * 纯函数约定：不读库、不落盘；快窗口的存储由调用方持有（daemon 里是内存，
 * 重启即空——空窗口只意味着「暂时判不了漂移」，保守方向，无害）。
 */

// 小时桶的 key 只写一份（core/offer-stats.js）：两处各写一套格式化迟早漂移
import { hourKey } from './offer-stats.js'

/** 快窗口长度：现值只看最近这么久（太长就失去「实时」意义） */
export const FAST_WINDOW_MS = 10 * 60_000
/** 快窗口最少样本数：少于这个不下漂移结论（和评分层 MIN_SAMPLES 同一哲学） */
export const FAST_MIN_SAMPLES = 5
/** 慢基线回看的小时数（offerStats 小时桶） */
export const BASELINE_HOURS = 6
/** 慢基线最少样本数 */
export const BASELINE_MIN_SAMPLES = 5
/** 漂移阈值：现值比基线慢出这个比例算漂移（0.30 = 慢了 30%） */
export const DRIFT_THRESHOLD = 0.3
/** 首字取哪个分位：尾延迟比均值更能反映「偶尔卡死」 */
export const TTFT_PERCENTILE = 0.9
/** 常量基线的回看天数：与 offerStats 的保留期一致（30 天），再老的桶已经被剪掉了 */
export const LONG_TERM_DAYS = 30
/** 一天至少这么多单才算「有一天」：否则那天的均值等于一两单的噪声，进中位数会把常量带偏 */
export const LONG_TERM_MIN_DAY_SAMPLES = 10
/** 至少攒够这么多天（不含今天）才取中位数；不够就退回全窗口加权均值并标注 */
export const LONG_TERM_MIN_DAYS = 3

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

/** 分位数（线性插值）。样本少于 2 个时直接返回唯一值。 */
export function percentile(values, p = TTFT_PERCENTILE) {
  const list = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (list.length === 0) return null
  if (list.length === 1) return list[0]
  const idx = (list.length - 1) * Math.min(1, Math.max(0, p))
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return list[lo]
  return list[lo] + (list[hi] - list[lo]) * (idx - lo)
}

/**
 * 快窗口聚合：归一化后的综合耗时 + 分项。
 *
 * @returns {{
 *   compositeMs:number|null,   // 归一化综合分（越小越快），漂移判定用它
 *   ttftMs:number|null,        // 首字 P90
 *   ttftMeanMs:number|null,    // 首字均值（UI 想显示均值时用）
 *   msPerToken:number|null,    // 每输出 token 的吐字毫秒（越大越慢）
 *   tps:number|null,           // token/ms，×1000 = tok/s（UI 展示用）
 *   outRef:number|null,        // 本窗口平均每单输出 token（参照工作量）
 *   avgLatencyMs:number|null,  // 裸平均总耗时（只用于展示，不参与判定）
 *   samples:number
 * }}
 */
export function fastCurrent(samples, now = Date.now()) {
  const ttfts = []
  let latencySum = 0
  let genOutSum = 0
  let genTimeSum = 0
  let outSum = 0
  let n = 0
  for (const s of samples || []) {
    if (!usableSample(s)) continue
    if (Number.isFinite(s.at) && now - s.at > FAST_WINDOW_MS) continue
    ttfts.push(s.ttftMs)
    latencySum += s.latencyMs
    // 吐字段：非流式也常有完整 usage，有就用；没有就退化成「总耗时 - 首字」按已知 token 算
    const genOut = Number(s.outTokens) || 0
    const genTime = s.latencyMs - s.ttftMs
    if (genOut > 0 && genTime > 0) {
      genOutSum += genOut
      genTimeSum += genTime
    }
    if (genOut > 0) outSum += genOut
    n += 1
  }
  if (n < FAST_MIN_SAMPLES) {
    return {
      compositeMs: null,
      ttftMs: null,
      ttftMeanMs: null,
      msPerToken: null,
      tps: null,
      outRef: null,
      avgLatencyMs: null,
      samples: n,
    }
  }
  const ttftMs = percentile(ttfts)
  const ttftMeanMs = ttfts.reduce((a, b) => a + b, 0) / ttfts.length
  const msPerToken = genTimeSum > 0 ? genTimeSum / genOutSum : null
  const outRef = outSum > 0 ? outSum / n : null
  return {
    compositeMs: combine(ttftMs, msPerToken, outRef),
    ttftMs,
    ttftMeanMs,
    msPerToken,
    tps: genTimeSum > 0 ? genOutSum / genTimeSum : null,
    outRef,
    avgLatencyMs: latencySum / n,
    samples: n,
  }
}

/** 归一化综合分：ttft + outRef × msPerToken。缺哪个分项就只用有的那半边。 */
function combine(ttftMs, msPerToken, outRef) {
  const hasTtft = Number.isFinite(ttftMs)
  const hasGen = Number.isFinite(msPerToken) && Number.isFinite(outRef)
  if (hasTtft && hasGen) return ttftMs + outRef * msPerToken
  if (hasTtft) return ttftMs
  if (hasGen) return outRef * msPerToken
  return null
}

/**
 * 累加器 → 基线结论。
 *
 * 6 小时基线和常量基线都从这里出数，**归一化口径只写这一份**（combine /
 * msPerToken / outRef）。两处各算一套的话，短单长单的污染只会修好一半：
 * 判定用归一化、常量还是裸均值，界面上的「现值较常量」就又开始骗人。
 *
 * @param {object} sums 累加器（见 emptySums）
 * @param {string|null} source 'history' | 'current-hour' | 'hour' | 'days' | 'pooled'
 * @param {object} [extra] 额外字段（days 等）原样带回
 */
function fromSums(sums, source, extra = {}) {
  if (sums.latencyCount < BASELINE_MIN_SAMPLES) {
    return {
      compositeMs: null,
      avgLatencyMs: null,
      avgTtftMs: null,
      ttftMs: null,
      msPerToken: null,
      tps: null,
      outRef: null,
      samples: sums.latencyCount,
      source: null,
      ...extra,
    }
  }
  const avgLatencyMs = sums.latencySum / sums.latencyCount
  const avgTtftMs = sums.ttftCount > 0 ? sums.ttftSum / sums.ttftCount : null
  const msPerToken = sums.genTimeSum > 0 ? sums.genTimeSum / sums.genOutSum : null
  // 参照工作量：这个站历史上平均每单吐多少 token。两侧用同一个值折算，长短单公平
  const outRef = sums.requests > 0 ? sums.outputTokens / sums.requests : null
  return {
    compositeMs: combine(avgTtftMs, msPerToken, outRef),
    avgLatencyMs,
    avgTtftMs,
    ttftMs: avgTtftMs,
    msPerToken,
    tps: sums.genTimeSum > 0 ? sums.genOutSum / sums.genTimeSum : null,
    outRef,
    samples: sums.latencyCount,
    source,
    ...extra,
  }
}

/** 把一个小时桶摊进累加器（6 小时基线、常量基线、最近一小时共用，口径只写一份） */
function accBucket(sums, b) {
  if (!b) return
  sums.balance = true
  if (Number(b.latencyCount) > 0) {
    sums.latencySum += Number(b.latencySum) || 0
    sums.latencyCount += Number(b.latencyCount)
  }
  if (Number(b.ttftCount) > 0) {
    sums.ttftSum += Number(b.ttftSum) || 0
    sums.ttftCount += Number(b.ttftCount)
  }
  if (Number(b.genTimeSum) > 0 && Number(b.genOutSum) > 0) {
    sums.genOutSum += Number(b.genOutSum)
    sums.genTimeSum += Number(b.genTimeSum)
  }
  if (Number(b.requests) > 0) {
    sums.requests += Number(b.requests)
    sums.outputTokens += Number(b.outputTokens) || 0
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
 * @returns {{compositeMs:number|null, avgLatencyMs:number|null, avgTtftMs:number|null,
 *            ttftMs:number|null, msPerToken:number|null, tps:number|null,
 *            outRef:number|null, samples:number, source:'history'|'current-hour'|null}}
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
    accBucket(hour >= newestHour ? cur : hist, offerStats[key])
  }
  // 历史桶够 → 用历史（无自身污染，首选）；不够 → 回退当前小时桶（有稀释但方向保守）
  const fromHistory = fromSums(hist, 'history')
  if (fromHistory.compositeMs !== null) return fromHistory
  return fromSums(cur, 'current-hour')
}

/**
 * 常量基线：最近 LONG_TERM_DAYS 天里，按天算均值再取中位数。
 *
 * 为什么按天取中位数、而不是 30 天整体加权平均：
 *   - 整体加权会被「用得最多的那几天」绑架——某天连刷了几百单，常量就跟着那天的
 *     网络状况走；中位数对单日异常完全免疫（出差住酒店、站点当天塌了都只影响一天）。
 *   - 按小时桶直接平均也不行：小时粒度的样本量差两个数量级，等于变成小时加权。
 * 为什么排除今天：今天的桶还在写，正在漂移的样本会把它往下拽；跟 6 小时基线
 * 「排除当前小时桶」是同一条道理。天不够（老用户重装/新接的站）时退回全窗口
 * 加权均值并标 source='pooled'，让 UI 能说清「这数还不是攒出来的」。
 *
 * 中位数按**归一化综合分**取，不按裸总耗时：哪天单子普遍长一点，裸均值就整天偏大，
 * 中位数再稳也稳错了东西。
 *
 * @returns {{compositeMs:number|null, avgLatencyMs:number|null, avgTtftMs:number|null,
 *            tps:number|null, samples:number, days:number,
 *            source:'days'|'pooled'|null}}
 */
export function longTermBaseline(offerStats, offerId, now = Date.now()) {
  const today = hourKey(now).slice(0, 10)
  const cutoff = now - LONG_TERM_DAYS * 86400_000
  const byDay = new Map()
  const pooled = emptySums()
  for (const key of Object.keys(offerStats || {})) {
    if (!key.startsWith(`${offerId}|`)) continue
    const hour = key.slice(offerId.length + 1)
    const bucketStart = Date.parse(`${hour}:00:00Z`)
    if (Number.isFinite(bucketStart) && bucketStart < cutoff) continue
    const b = offerStats[key]
    if (!b) continue
    accBucket(pooled, b)
    const day = String(hour).slice(0, 10)
    let sums = byDay.get(day)
    if (!sums) byDay.set(day, (sums = emptySums()))
    accBucket(sums, b)
  }
  // 够样本的天（不含今天）才进中位数；一天里只有一两单的不算「有一天」
  const history = [...byDay.entries()].filter(
    ([day, sums]) => day !== today && sums.latencyCount >= LONG_TERM_MIN_DAY_SAMPLES,
  )
  if (history.length >= LONG_TERM_MIN_DAYS) {
    // 每天先归一化成综合分再取中位，口径和判定完全一致
    const dayComposite = history.map(([, s]) => fromSums(s, 'days').compositeMs)
    const dayLatency = history.map(([, s]) => s.latencySum / s.latencyCount)
    const dayTtft = history.filter(([, s]) => s.ttftCount > 0).map(([, s]) => s.ttftSum / s.ttftCount)
    const dayTps = history.filter(([, s]) => s.genTimeSum > 0).map(([, s]) => s.genOutSum / s.genTimeSum)
    return {
      compositeMs: median(dayComposite),
      avgLatencyMs: median(dayLatency),
      avgTtftMs: dayTtft.length > 0 ? median(dayTtft) : null,
      tps: dayTps.length > 0 ? median(dayTps) : null,
      samples: history.reduce((sum, [, s]) => sum + s.latencyCount, 0),
      days: history.length,
      source: 'days',
    }
  }
  // 天不够：退回全窗口加权均值，同样走归一化口径
  return fromSums(pooled, 'pooled', { days: byDay.size })
}

/**
 * 最近一小时的真实表现：取该供给最新的那个小时桶。
 *
 * 为什么需要它：现值只用最近 10 分钟的内存快窗口（进程一重启就空），
 * 流量稀疏时那一格就永远是个空。但账本里明明有最近一小时的数，
 * 界面却只给一排横线，看起来就像「系统没在工作」。
 * 这是**展示用**的兼顾值：漂移判定绝不拿它算（小时桶的粒度太粗，
 * 也分不清「刚刚才变慢」和「一小时前就慢了」）。
 *
 * @returns {{compositeMs:number|null, avgLatencyMs:number|null, avgTtftMs:number|null,
 *            tps:number|null, samples:number, hour:string|null, ageMs:number|null}}
 */
export function recentHour(offerStats, offerId, now = Date.now()) {
  let newest = null
  for (const key of Object.keys(offerStats || {})) {
    if (!key.startsWith(`${offerId}|`)) continue
    const hour = key.slice(offerId.length + 1)
    if (newest === null || hour > newest) newest = hour
  }
  if (newest === null) {
    return { compositeMs: null, avgLatencyMs: null, avgTtftMs: null, tps: null, samples: 0, hour: null, ageMs: null }
  }
  const sums = emptySums()
  accBucket(sums, offerStats[`${offerId}|${newest}`])
  const start = Date.parse(`${newest}:00:00Z`)
  return {
    ...fromSums(sums, 'hour'),
    hour: newest,
    ageMs: Number.isFinite(start) ? Math.max(0, now - start) : null,
  }
}

/** 两个值的相对变化：正 = 变差（更慢） */
function relativeDrift(nowValue, baseValue) {
  return Number.isFinite(nowValue) && Number.isFinite(baseValue) && baseValue > 0
    ? (nowValue - baseValue) / baseValue
    : null
}

/**
 * 参考漂移：「最近一小时」相对 6 小时基线。只给界面看，不参与判定触发。
 *
 * @returns {{drift:number|null, ttftDrift:number|null, tpsDrift:number|null,
 *            samples:number, hour:string|null}|null}
 */
function referenceDrift(recent, base) {
  if (!recent || !Number.isFinite(recent.compositeMs) || !Number.isFinite(base?.compositeMs)) return null
  return {
    drift: relativeDrift(recent.compositeMs, base.compositeMs),
    ttftDrift: relativeDrift(recent.avgTtftMs, base.avgTtftMs),
    // 吐字方向相反：慢 = 速度降，所以用 (基线 - 当前) / 基线
    tpsDrift:
      Number.isFinite(recent.tps) && Number.isFinite(base.tps) && base.tps > 0
        ? (base.tps - recent.tps) / base.tps
        : null,
    samples: recent.samples,
    hour: recent.hour,
  }
}

/** 中位数（过滤 null/NaN：分项缺样本时是 null，别让它把整列拖成 NaN） */
function median(values) {
  const xs = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (xs.length === 0) return null
  const mid = xs.length >> 1
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
}

function emptySums() {
  return {
    latencySum: 0,
    latencyCount: 0,
    ttftSum: 0,
    ttftCount: 0,
    genOutSum: 0,
    genTimeSum: 0,
    requests: 0,
    outputTokens: 0,
    balance: false,
  }
}

/**
 * 漂移判定：**归一化综合耗时**现值比基线慢出阈值就是漂移。
 *
 * 分项漂移（首字 / 每 token 吐字）一并返回供 UI 定位，但不参与触发——
 * 解耦型劣化（首字正常、吐字被抽走）在综合分里同样体现得出来。
 *
 * 常量基线是「平时该多快」的参照系，用来指出「最近一直偏慢」，
 * **不单独触发改派**：它攒的是 30 天的账，抖一下不该换站。
 *
 * @param {Array} samples 快窗口样本
 * @param {Object} offerStats db.offerStats
 * @param {string} offerId
 * @param {number} [now]
 * @param {number} [threshold] 阈值（settings.driftThresholdPct / 100），缺省 30%
 * @returns {{verdict:'drifted'|'ok'|'insufficient', drift:number|null,
 *            ttftDrift:number|null, tpsDrift:number|null,
 *            current:number|null, baseline:number|null, samples:number,
 *            currentTtftMs:number|null, baselineTtftMs:number|null,
 *            currentMsPerToken:number|null, baselineMsPerToken:number|null,
 *            outRef:number|null, constant:number|null, constantDays:number,
 *            constantSource:string|null, driftVsConstant:number|null,
 *            currentTps:number|null, baselineTps:number|null, recent:object,
 *            reference:object|null}}
 *   current / baseline / constant = 归一化综合耗时（毫秒，参照工作量下）。
 *   verdict 只吃 6 小时基线。
 */
export function evaluateDrift(samples, offerStats, offerId, now = Date.now(), threshold = DRIFT_THRESHOLD) {
  const cur = fastCurrent(samples, now)
  const base = baselineRatio(offerStats, offerId, now)
  const long = longTermBaseline(offerStats, offerId, now)
  const recent = recentHour(offerStats, offerId, now)
  // 现值 vs 常量：6 小时基线被整段拖慢时的兜底证据（慢出来多少算多少，不设阈值）
  const driftVsConstant = relativeDrift(cur.compositeMs, long.compositeMs)
  const constantShape = {
    constant: long.compositeMs,
    constantDays: long.days,
    constantSource: long.source,
    driftVsConstant,
  }
  // 绝对值一并带出去：现值和分项算不出来时（这十分钟没流量），
  // 界面至少能把「平时首字多少、平时吐字多快」摆出来，而不是一片横线
  const absoluteShape = {
    currentTtftMs: cur.ttftMs,
    currentTps: cur.tps,
    baselineTtftMs: base.ttftMs,
    baselineTps: base.tps,
    // 快窗口空时界面拿它顶一下现值（只展示，不参与判定）
    recent: {
      compositeMs: recent.compositeMs,
      avgLatencyMs: recent.avgLatencyMs,
      avgTtftMs: recent.avgTtftMs,
      tps: recent.tps,
      samples: recent.samples,
      hour: recent.hour,
      ageMs: recent.ageMs,
    },
    // 参考漂移：拿「最近一小时」与 6 小时基线比。
    // 它不能用来触发改派（小时桶太粗，分不清刚变慢还是一小时前就慢），
    // 但足以回答用户那句「首字到底变没变慢」——不然盯着 5 分钟等满 5 单，
    // 分项永远是空。名字特意不叫 drift，避免被当成判定结果。
    reference: referenceDrift(recent, base),
  }
  const baseOut = {
    ttftDrift: null,
    tpsDrift: null,
    currentMsPerToken: cur.msPerToken,
    baselineMsPerToken: base.msPerToken,
    outRef: base.outRef ?? cur.outRef,
  }
  if (cur.compositeMs === null || base.compositeMs === null) {
    return {
      verdict: 'insufficient',
      drift: null,
      current: cur.compositeMs,
      baseline: base.compositeMs,
      samples: cur.samples,
      ...baseOut,
      ...absoluteShape,
      ...constantShape,
    }
  }
  const drift = (cur.compositeMs - base.compositeMs) / base.compositeMs
  // 分项：首字漂了 %（正=变慢）；吐字漂了 %（正=变慢）。哪边缺样本就是 null
  const ttftDrift = relativeDrift(cur.ttftMs, base.ttftMs)
  const tpsDrift =
    Number.isFinite(cur.tps) && Number.isFinite(base.tps) && base.tps > 0
      ? (base.tps - cur.tps) / base.tps
      : null
  return {
    verdict: drift >= threshold ? 'drifted' : 'ok',
    drift,
    // ⚠️ 必须先展开 baseOut，再写 ttftDrift/tpsDrift：反过来会被 baseOut 里的
    // 默认 null 覆盖掉算好的值（写成 ...baseOut 在最后时踩过）
    ...baseOut,
    current: cur.compositeMs,
    baseline: base.compositeMs,
    ttftDrift,
    tpsDrift,
    samples: cur.samples,
    ...absoluteShape,
    ...constantShape,
  }
}
