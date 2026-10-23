/**
 * 评分层：把探测记录和真实流量压成路由可直接消费的几个数。
 *
 * 两个维度分开算，不要混成一个加权和：
 *   availability —— 连得上吗、成功率高不高（探针 + 真实流量合并）
 *   integrity    —— 连上了，但结果可不可信（掉包 / 截断 / 虚报，只来自探针）
 *
 * 路由时的用法是「硬约束 + 有效成本」：
 *   任一维度不达标直接排除；剩下的按 价格 ÷ 质量 排序。
 *
 * 时效很重要：探针数据会过期。一个站昨天健康、今天掉包了，
 * 如果评分还停在昨天，路由会继续用它——所以过期的评分一律不放行。
 */

const DEFAULT_WINDOW = 20
const DEFAULT_MAX_AGE_MS = 6 * 3600 * 1000

export const THRESHOLDS = {
  availability: 0.8,
  integrity: 0.8,
}

function ratio(values) {
  if (values.length === 0) return null
  return values.filter(Boolean).length / values.length
}

function median(numbers) {
  const list = numbers.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b)
  if (list.length === 0) return null
  const mid = Math.floor(list.length / 2)
  return list.length % 2 ? list[mid] : Math.round((list[mid - 1] + list[mid]) / 2)
}

/**
 * @param {Array} probes 探针记录
 * @param {Object} traffic offerId → { ok, fail, since } 真实流量计数
 * @param {{window?:number, maxAgeMs?:number, now?:number}} options
 * @returns {Map<string, object>}
 */
export function scoreOffers(probes, traffic = {}, options = {}) {
  const window = options.window ?? DEFAULT_WINDOW
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const now = options.now ?? Date.now()

  const byOffer = new Map()
  for (const record of probes) {
    if (!record.offerId) continue
    if (!byOffer.has(record.offerId)) byOffer.set(record.offerId, [])
    byOffer.get(record.offerId).push(record)
  }

  // 真实流量里出现过、但一次都没探过的 offer 也要给出评分
  for (const offerId of Object.keys(traffic || {})) {
    if (!byOffer.has(offerId)) byOffer.set(offerId, [])
  }

  const scores = new Map()
  for (const [offerId, records] of byOffer) {
    // 只算有效期内的探针：一次失败不该在 20 小时后还在拖累可用率
    const fresh = records.filter((r) => now - new Date(r.ts).getTime() <= maxAgeMs)
    const recent = (fresh.length > 0 ? fresh : records).slice(-window)
    const probeSamples = recent.length

    const fingerprintRate = ratio(recent.filter((r) => r.fingerprintOk !== null).map((r) => r.fingerprintOk))
    const truncationRate = ratio(recent.filter((r) => r.truncated !== null).map((r) => r.truncated === false))
    const billingRate = ratio(recent.filter((r) => r.billingInflated !== null).map((r) => r.billingInflated === false))

    // 某一项还没测出来时不惩罚，用其余项归一，避免新站被误判
    const parts = [
      { value: fingerprintRate, weight: 0.5 },
      { value: truncationRate, weight: 0.3 },
      { value: billingRate, weight: 0.2 },
    ].filter((p) => p.value !== null)
    const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0)
    const integrity = totalWeight === 0 ? null : parts.reduce((sum, p) => sum + p.value * p.weight, 0) / totalWeight

    // 可用率合并探针与真实流量：探针样本少，真实请求更能反映实际状况
    const probeOk = recent.filter((r) => r.ok).length
    const trafficRow = traffic?.[offerId]
    const trafficOk = trafficRow?.ok || 0
    const trafficFail = trafficRow?.fail || 0
    const totalSamples = probeSamples + trafficOk + trafficFail
    const availability = totalSamples === 0 ? null : (probeOk + trafficOk) / totalSamples

    const quality =
      availability === null || integrity === null ? availability ?? integrity : availability * integrity

    const cacheRates = recent
      .filter((r) => typeof r.cacheHitRate === 'number')
      .map((r) => r.cacheHitRate)
    const cacheHitRate = cacheRates.length
      ? cacheRates.reduce((a, b) => a + b, 0) / cacheRates.length
      : null

    const lastProbeAt = recent[recent.length - 1]?.ts ?? null
    const ageMs = lastProbeAt ? now - new Date(lastProbeAt).getTime() : null
    const stale = ageMs !== null && ageMs > maxAgeMs

    // 最近一次探测的原始证据，供界面展开查看「为什么判它可疑」
    const last = recent[recent.length - 1] || null

    let status = 'unknown'
    if (probeSamples === 0) status = 'unknown'
    else if (stale) status = 'stale'
    else if (availability !== null && availability < THRESHOLDS.availability) status = 'unstable'
    else if (integrity !== null && integrity < THRESHOLDS.integrity) status = 'degraded'
    else status = 'healthy'

    scores.set(offerId, {
      offerId,
      samples: probeSamples,
      trafficSamples: trafficOk + trafficFail,
      availability,
      fingerprintRate,
      truncationRate,
      billingRate,
      integrity,
      quality,
      cacheHitRate,
      ttftMs: median(recent.map((r) => r.ttftMs)),
      latencyMs: median(recent.map((r) => r.latencyMs)),
      lastProbeAt,
      ageMs,
      stale,
      lastError: [...recent].reverse().find((r) => !r.ok)?.error ?? null,
      lastProbe: last
        ? {
            ts: last.ts,
            ok: last.ok,
            error: last.error ?? null,
            fingerprintOk: last.fingerprintOk ?? null,
            fingerprintRaw: last.fingerprintRaw ?? null,
            truncated: last.truncated ?? null,
            truncationDetail: last.truncationDetail ?? null,
            billingInflated: last.billingInflated ?? null,
            promptTokens: last.promptTokens ?? null,
            cacheHitRate: last.cacheHitRate ?? null,
            cacheDetail: last.cacheDetail ?? null,
            identityClaim: last.identityClaim ?? null,
            ttftMs: last.ttftMs ?? null,
          }
        : null,
      status,
    })
  }
  return scores
}

/** 能不能参与路由。样本太少、已过期、任一维度不达标都不放行。 */
export function isRoutable(score) {
  if (!score || score.samples === 0) return false
  if (score.stale) return false
  if (score.availability !== null && score.availability < THRESHOLDS.availability) return false
  if (score.integrity !== null && score.integrity < THRESHOLDS.integrity) return false
  return true
}

/**
 * 长期表现：用全部历史探针 + 真实流量，按时间衰减加权。
 *
 * 短期评分回答「现在能不能用」，长期评分回答「这家一贯靠不靠谱」。
 * 关键是**近期权重更高**：三个月前的一次失败不该和今天的失败等价，
 * 否则一个已经修好的站会被旧账永远拖着。
 *
 * 半衰期 14 天：14 天前的记录权重 0.5，28 天前 0.25。
 *
 * @param {Array} probes 探针记录
 * @param {Object} traffic offerId → { ok, fail, since } 最近 1 小时的真实流量
 * @returns {Map<string, {total, weightedSamples, uptime, avgQuality, avgTtft, score, firstAt, lastAt}>}
 */
export function longTermScores(probes, traffic = {}, { halfLifeDays = 14, now = Date.now() } = {}) {
  const byOffer = new Map()
  for (const record of probes) {
    if (!record.offerId) continue
    if (!byOffer.has(record.offerId)) byOffer.set(record.offerId, [])
    byOffer.get(record.offerId).push(record)
  }

  // 单次探测的完整性：指纹 0.5 + 未截断 0.3 + 计费正常 0.2
  const qualityOf = (r) => {
    const fp = r.fingerprintOk === null || r.fingerprintOk === undefined ? null : r.fingerprintOk ? 1 : 0
    const tr = r.truncated === null || r.truncated === undefined ? null : r.truncated ? 0 : 1
    const bl =
      r.billingInflated === null || r.billingInflated === undefined ? null : r.billingInflated ? 0 : 1
    const parts = [
      { v: fp, w: 0.5 },
      { v: tr, w: 0.3 },
      { v: bl, w: 0.2 },
    ].filter((p) => p.v !== null)
    if (parts.length === 0) return null
    const w = parts.reduce((s, p) => s + p.w, 0)
    return parts.reduce((s, p) => s + p.v * p.w, 0) / w
  }

  const result = new Map()
  for (const [offerId, records] of byOffer) {
    let weightSum = 0
    let okWeight = 0
    let qualityWeight = 0
    let qualitySum = 0
    let ttftWeight = 0
    let ttftSum = 0

    for (const r of records) {
      const ageDays = (now - new Date(r.ts).getTime()) / 86400000
      const weight = Number.isFinite(ageDays) && ageDays > 0 ? Math.pow(0.5, ageDays / halfLifeDays) : 1
      weightSum += weight
      if (r.ok) okWeight += weight
      const q = qualityOf(r)
      if (q !== null) {
        qualitySum += q * weight
        qualityWeight += weight
      }
      if (typeof r.ttftMs === 'number') {
        ttftSum += r.ttftMs * weight
        ttftWeight += weight
      }
    }

    // 真实流量：窗口是最近 1 小时，等同于最新数据，权重按 1 计
    const trafficRow = traffic?.[offerId]
    const trafficOk = trafficRow?.ok || 0
    const trafficFail = trafficRow?.fail || 0
    const trafficTotal = trafficOk + trafficFail

    const totalWeight = weightSum + trafficTotal
    const uptime = totalWeight === 0 ? null : (okWeight + trafficOk) / totalWeight
    const avgQuality = qualityWeight === 0 ? null : qualitySum / qualityWeight
    const avgTtft = ttftWeight === 0 ? null : Math.round(ttftSum / ttftWeight)
    const score = Math.round((uptime ?? 0) * (avgQuality ?? 1) * 100)

    result.set(offerId, {
      offerId,
      total: records.length,
      trafficSamples: trafficTotal,
      weightedSamples: Math.round(totalWeight * 10) / 10,
      uptime,
      avgQuality,
      avgTtft,
      score,
      firstAt: records[0]?.ts ?? null,
      lastAt: records[records.length - 1]?.ts ?? null,
    })
  }
  return result
}

/**
 * 有效成本 = 名义价格 ÷ 质量系数。
 * 直观含义：为「一份可信输出」实际付了多少钱。
 * 降智的站名义价再低，除下来也可能更贵。
 */
export function effectiveCost(priceCnyPerMtok, quality) {
  if (priceCnyPerMtok === null || priceCnyPerMtok === undefined) return null
  const q = typeof quality === 'number' && quality > 0 ? Math.max(quality, 0.05) : 1
  return priceCnyPerMtok / q
}

/**
 * 按供给类型取质量分。
 *
 * 免费供给去掉「计费正常」这一项：0 元的模型本来就不该收钱，计费项恒为 1，
 * 留着只会把 0.2 的权重白送给一个永远满分的项，把「掉包」和「截断」这两个
 * 真正能区分免费站的信号稀释掉。剩下的权重重新归一到 1（0.6 / 0.4）。
 *
 * 付费侧维持 score.integrity 不动，否则整条比价链路的排序都会跟着变。
 */
export function qualityFor(score, supply = 'paid') {
  if (!score) return null
  if (supply !== 'free') return score.integrity ?? null

  const parts = [
    { value: score.fingerprintRate, weight: 0.6 },
    { value: score.truncationRate, weight: 0.4 },
  ].filter((p) => typeof p.value === 'number')
  if (parts.length === 0) return null
  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0)
  return parts.reduce((sum, p) => sum + p.value * p.weight, 0) / totalWeight
}
