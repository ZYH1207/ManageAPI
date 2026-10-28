/**
 * 评分层：把探测记录和真实流量压成路由可直接消费的几个数。
 *
 * 两个维度分开算，不要混成一个加权和：
 *   availability —— 连得上吗、成功率高不高（探针 + 真实流量合并，只算真正的故障）
 *   integrity    —— 连上了，但结果可不可信（掉包 / 截断 / 虚报，只来自探针）
 *
 * 额度不足 / 限流 / 模型不在分组不算「连不上」：它们让供给进入冷却，
 * 不拉低可用率（详见 core/failure.js）。
 *
 * 路由时的用法是「硬约束 + 有效成本」：
 *   任一维度不达标直接排除；剩下的按 价格 ÷ 质量 排序。
 *
 * 时效很重要：探针数据会过期。一个站昨天健康、今天掉包了，
 * 如果评分还停在昨天，路由会继续用它——所以过期的评分一律不放行。
 */

import { classifyFailure, cooldownUntil } from './failure.js'
import { REAL_QUALITY_MIN_SAMPLES, REAL_QUALITY_BAD_RATE } from './quality-signals.js'

const DEFAULT_WINDOW = 20
const DEFAULT_MAX_AGE_MS = 6 * 3600 * 1000
/** 真实流量的统计窗口：与 inventory.addTraffic 的写入口径保持一致（1 小时） */
const DEFAULT_TRAFFIC_MAX_AGE_MS = 3600 * 1000

export const THRESHOLDS = {
  availability: 0.8,
  integrity: 0.8,
}

/**
 * 判定「确定坏」所需的最少失败样本数。样本更少时失败只说明「还没测出来」，
 * 判 unknown（不参与路由）而不是 unstable——否则探针间隔 6 小时、
 * 一轮只测到 1 次失败，这条供给就会在下一轮之前一直挂红。
 */
export const MIN_SAMPLES_FOR_VERDICT = 3

/**
 * 证据量分级：多少个样本才算「结论站得住」。
 * 注意这只是**置信度标注**，不是放行条件——1 个成功样本仍然算健康（能连上就是
 * 能连上），但界面必须能看出「这个 healthy 只有 1 个样本」。
 */
export const CONFIDENCE_SAMPLES = { high: 10, medium: 3 }

function median(numbers) {
  const list = numbers.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b)
  if (list.length === 0) return null
  const mid = Math.floor(list.length / 2)
  return list.length % 2 ? list[mid] : Math.round((list[mid - 1] + list[mid]) / 2)
}

/**
 * 取「还在窗口内」的真实流量计数，过期的一律当作没有。
 *
 * 写入侧（addTraffic）只在**下一条流量到来时**才重置窗口：一个站被用过一次、
 * 失败 1 次之后就不再被路由，这条记录永远不会被重置，却会被读取侧一直当成
 * 最新证据——站点于是永久停在「可用率 50% / 不稳定」上。窗口必须由读的这边
 * 也把关，两端口径一致才算数。
 */
function freshTraffic(row, now, maxAgeMs) {
  if (!row) return null
  const since = new Date(row.since).getTime()
  // 没有起点（旧数据）就无法证明它还在窗口内，按过期处理：
  // 宁可少一份证据（探针补位），也不留一份永远洗不掉的失败账
  if (!Number.isFinite(since)) return null
  if (now - since > maxAgeMs) return null
  return row
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
  const trafficMaxAgeMs = options.trafficMaxAgeMs ?? DEFAULT_TRAFFIC_MAX_AGE_MS
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
    // 可用率只认「新鲜」的探针：记录全部过期时不能拿旧数据充当现况证据，
    // 那条供给的可用率只由窗口内的真实流量说话（没有流量就是 null）
    const evidence = fresh.slice(-window)

    // 完整性只统计「真的测到了这一项」的记录：探测失败的记录里这些字段是
    // undefined（请求都没成功，谈不上指纹/截断），不能当成「没通过」——
    // 否则一次失败就会把 integrity 拉到 0，被误判成 degraded（掉包）
    const has = (r, key) => r[key] !== null && r[key] !== undefined
    const fpChecks = recent.filter((r) => has(r, 'fingerprintOk'))
    const trChecks = recent.filter((r) => has(r, 'truncated'))
    const blChecks = recent.filter((r) => has(r, 'billingInflated'))
    const fpPass = fpChecks.filter((r) => r.fingerprintOk).length
    const trPass = trChecks.filter((r) => r.truncated === false).length
    const blPass = blChecks.filter((r) => r.billingInflated === false).length

    // 平滑通过率：等价于「先记一次通过」，样本越少越接近 1，样本多了才收敛到真实值。
    // 这样一次探针异常只会让质量轻微下降（~5~15%），而不是把质量砸到 0.5 让成本翻倍——
    // 惩罚力度必须和证据强度匹配。判定「是否掉包」另有更严的规则（见下）
    const smooth = (pass, total) => (total === 0 ? null : (pass + 1) / (total + 1))
    const fingerprintRate = smooth(fpPass, fpChecks.length)
    const truncationRate = smooth(trPass, trChecks.length)
    const billingRate = smooth(blPass, blChecks.length)

    // 某一项还没测出来时不惩罚，用其余项归一，避免新站被误判
    const parts = [
      { value: fingerprintRate, weight: 0.5 },
      { value: truncationRate, weight: 0.3 },
      { value: billingRate, weight: 0.2 },
    ].filter((p) => p.value !== null)
    const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0)
    const integrity = totalWeight === 0 ? null : parts.reduce((sum, p) => sum + p.value * p.weight, 0) / totalWeight

    // 「结果可疑」的判定不看平滑值，看原始证据：
    //   指纹——单次不符即判（掉包是确定性的，网络抖动不会让答案变成别的数）
    //   截断 / 虚报——至少 2 个样本才下结论（单次异常可能是流被切断，不是站的问题）
    //   真实响应——空回答 / 计费虚报，样本 ≥5 且异常率 >20% 才判（网关能验的
    //              只有这两类客观异常，指纹和截断需要受控 prompt，探针才做得到）
    const integrityFaults = []
    if (fpChecks.length > 0 && fpPass < fpChecks.length) integrityFaults.push('指纹不符')
    if (trChecks.length >= 2 && trPass / trChecks.length < THRESHOLDS.integrity) integrityFaults.push('输出截断')
    if (blChecks.length >= 2 && blPass / blChecks.length < THRESHOLDS.integrity) integrityFaults.push('用量虚报')

    // 可用率合并探针与真实流量：探针样本少，真实请求更能反映实际状况。
    // 流量只认窗口内的（1 小时），过期的失败不能一直压着站点。
    // 额度不足 / 限流 / 模型不在分组不是「站点坏了」：它们不进分母，
    // 只让这条供给进入冷却，否则一堆只是没余额的站会长期挂红，
    // 真正的故障（502、卡死）反而被淹没
    const trafficRow = freshTraffic(traffic?.[offerId], now, trafficMaxAgeMs)

    // 真实响应的质量信号（空回答 / 计费虚报）：探针之外的第二类完整性证据。
    // 网关能验的只有这两类客观异常（指纹和截断需要受控 prompt），
    // 所以门槛放高：样本 ≥5 且异常率 >20% 才判
    const realQuality = trafficRow?.quality || null
    const realSamples = Number(realQuality?.samples) || 0
    const realBad = Number(realQuality?.bad) || 0
    const realBadRate = realSamples >= REAL_QUALITY_MIN_SAMPLES ? realBad / realSamples : null
    if (realBadRate !== null && realBadRate > REAL_QUALITY_BAD_RATE) integrityFaults.push('真实响应异常')
    const trafficOk = trafficRow?.ok || 0
    const trafficFail = trafficRow?.fail || 0
    const trafficKinds = trafficRow?.kinds || {}
    let trafficUnavailable = 0
    for (const entry of Object.values(trafficKinds)) trafficUnavailable += Number(entry?.n) || 0

    let probeOk = 0
    let probeOutage = 0
    let probeUnavailable = 0
    let unavailableAt = 0
    let unavailableKind = null
    let successAt = 0
    for (const record of evidence) {
      const tsMs = new Date(record.ts).getTime()
      if (record.ok) {
        probeOk += 1
        if (tsMs > successAt) successAt = tsMs
        continue
      }
      const { kind, countsAsOutage } = classifyFailure(record.error)
      if (countsAsOutage) {
        probeOutage += 1
        continue
      }
      probeUnavailable += 1
      if (tsMs > unavailableAt) {
        unavailableAt = tsMs
        unavailableKind = kind
      }
    }

    // 流量侧同口径：最后一次成功与最后一次「暂时不可用」谁更近，决定是否还在冷却。
    // 落盘的是 ISO 字符串，必须按时间解析（Number() 会得到 NaN）
    const tsOf = (value) => {
      if (value === null || value === undefined || value === '') return 0
      const ms = typeof value === 'number' ? value : new Date(value).getTime()
      return Number.isFinite(ms) ? ms : 0
    }
    if (tsOf(trafficRow?.lastOkAt) > successAt) successAt = tsOf(trafficRow.lastOkAt)
    for (const [kind, entry] of Object.entries(trafficKinds)) {
      const lastAt = tsOf(entry?.lastAt)
      if (lastAt > unavailableAt) {
        unavailableAt = lastAt
        unavailableKind = kind
      }
    }

    const totalSamples = probeOk + probeOutage + trafficOk + trafficFail
    const availability = totalSamples === 0 ? null : (probeOk + trafficOk) / totalSamples

    // 冷却期内不放行，但不当成「坏站」：额度充上、限流过去就自动恢复，
    // 判断依据是「最后一次不可用失败」晚于「最后一次成功」
    const blockedUntil =
      unavailableKind && unavailableAt > successAt ? cooldownUntil(unavailableKind, unavailableAt) : 0
    const blocked = blockedUntil > now ? { kind: unavailableKind, until: blockedUntil } : null

    // 冷却到期不等于恢复。冷却只回答「这段时间别去试」，恢复要**证据**：
    // 最近一次证据仍是额度/限流/模型不可用（晚于最后一次成功），说明它还没被证明
    // 能用了。此时放行只会再撞一次同样的墙——典型现场：一个模型 4 条供给，3 条
    // 慢速被首字门槛挡住，剩下 1 条限流，网关就反复拿这条去试，时间全耗在必然失败的请求上。
    // 解除条件只有一个：之后有一次成功（探针或真实流量）把 successAt 推到失败之后。
    const pendingRecovery =
      unavailableKind && unavailableAt > successAt
        ? { kind: unavailableKind, since: unavailableAt }
        : null

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

    // ---- 证据新鲜度：一个概念，两个来源
    // 判「这份评分还作不作数」看的是「最后一次有效证据」，而不是「最后一次探针」。
    // 真实调用（成功或失败）同样是证据：一个站 7 小时没被探过、但 10 分钟前刚
    // 被真实调用过，它既不过期、也不该因为「探针旧」而掩盖掉新鲜失败信号。
    // 以前这里只认探针 + 一条「有成功流量就免死」的特例，特例之外的情况都算错。
    const trafficLastAt = Math.max(
      tsOf(trafficRow?.lastOkAt),
      tsOf(trafficRow?.lastFailAt),
      unavailableAt,
    )
    const evidenceAt = Math.max(tsOf(lastProbeAt), trafficLastAt)
    const evidenceAgeMs = evidenceAt > 0 ? now - evidenceAt : null
    const stale = evidenceAgeMs !== null && evidenceAgeMs > maxAgeMs

    // 证据量决定「这个结论有多可信」：1 个样本的成功和 10 个样本的成功，
    // 都叫 healthy，但确定性完全不同。界面要能把这件事说清楚
    const totalEvidence = probeOk + probeOutage + trafficOk + trafficFail
    const confidence =
      totalEvidence >= CONFIDENCE_SAMPLES.high
        ? 'high'
        : totalEvidence >= CONFIDENCE_SAMPLES.medium
          ? 'medium'
          : 'low'

    // 最近一次探测的原始证据，供界面展开查看「为什么判它可疑」
    const last = recent[recent.length - 1] || null

    // 完整性（指纹/截断/计费）是「单次即可定性」的证据：一次指纹不符就是掉包，
    // 不需要多次确认；而可用率是统计量——样本太少时的失败只代表「还没测出来」，
    // 判 unknown 而不是 unstable（不参与路由，但不挂红、不催用户去修）
    const availabilityVerdict =
      availability !== null &&
      availability < THRESHOLDS.availability &&
      totalSamples >= MIN_SAMPLES_FOR_VERDICT

    let status = 'unknown'
    if (probeSamples === 0) status = 'unknown'
    else if (stale) status = 'stale'
    else if (integrityFaults.length > 0) status = 'degraded'
    else if (availabilityVerdict) status = 'unstable'
    else if (availability !== null && availability < THRESHOLDS.availability) {
      // 样本不足的失败：明确标「证据不足」，界面不显示成可疑/不稳定
      status = 'inconclusive'
    } else if (availability === null) {
      // 只有额度/限流这类「暂时不可用」的失败：没有任何可靠性证据，不算健康
      status = 'unknown'
    } else status = 'healthy'

    scores.set(offerId, {
      offerId,
      samples: probeSamples,
      trafficSamples: trafficOk + trafficFail,
      trafficUnavailable,
      // 真实响应的质量抽样（空回答 / 计费虚报）：样本不足时 badRate 为 null
      realQualitySamples: realSamples,
      realBadRate,
      trafficStale: Boolean(traffic?.[offerId]) && trafficRow === null,
      // 样本拆分：参与可用率的是 ok + outage；unavailable 不进分母
      outageSamples: probeOutage + trafficFail,
      unavailableSamples: probeUnavailable + trafficUnavailable,
      // 冷却中的供给：不参与路由，但不是「坏」，额度/限流恢复后自动回来
      blocked,
      // 冷却已到、但还没被证明恢复（最近一次证据是额度/限流/模型不可用）
      pendingRecovery,
      availability,
      fingerprintRate,
      truncationRate,
      billingRate,
      integrity,
      // 具体是哪一项不合格（指纹不符 / 输出截断 / 用量虚报），界面直接展示
      integrityFaults,
      quality,
      cacheHitRate,
      ttftMs: median(recent.map((r) => r.ttftMs)),
      latencyMs: median(recent.map((r) => r.latencyMs)),
      lastProbeAt,
      ageMs,
      // 证据新鲜度（探针或真实流量，取最近一次）与置信度（样本量）
      evidenceAt: evidenceAt > 0 ? new Date(evidenceAt).toISOString() : null,
      evidenceAgeMs,
      confidence,
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

/**
 * 能不能参与路由。样本太少、已过期、任一维度不达标都不放行。
 * inconclusive（样本不足的失败）同样不放行——宁可少用一个站，
 * 也不要把一个「可能已经坏了」的站派上流量；但它在界面上不算「可疑」。
 */
export function isRoutable(score) {
  if (!score || score.samples === 0) return false
  if (score.stale) return false
  if (score.status === 'inconclusive') return false
  // 冷却中（额度不足/限流/模型不在分组）：不是坏站，但此刻派过去只会失败
  if (score.blocked) return false
  // 冷却已到但还没有成功证据：同样不放行。恢复看证据不看钟（见 scoreOffers 的
  // pendingRecovery）——否则冷却一过就再撞一次限流，白等一个来回
  if (score.pendingRecovery) return false
  // 一条可靠性样本都没有（探针全是额度/限流失败，归因后不进分母）时不能放行：
  // 这种供给的质量会退化成 null（有效成本按 1 算），等于纯按价格把最没有
  // 证据的那条排到前面。以前这类失败算故障，可用率是 0 自然挡住；归因之后
  // 必须显式要求「有证据」，否则「没测过」就变成了「合格」
  if (score.availability === null) return false
  if (score.availability < THRESHOLDS.availability) return false
  // 完整性看「有没有确凿的不合格项」，不看平滑后的分数：
  // 平滑值低只说明证据多且都不好，具体判定由 integrityFaults 给出
  if (Array.isArray(score.integrityFaults) && score.integrityFaults.length > 0) return false
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
export function longTermScores(
  probes,
  traffic = {},
  { halfLifeDays = 14, now = Date.now(), trafficMaxAgeMs = DEFAULT_TRAFFIC_MAX_AGE_MS } = {},
) {
  const byOffer = new Map()
  for (const record of probes) {
    if (!record.offerId) continue
    if (!byOffer.has(record.offerId)) byOffer.set(record.offerId, [])
    byOffer.get(record.offerId).push(record)
  }

  // 真实流量里出现过、但一次都没探过的 offer 也要给长期分（与 scoreOffers 同口径）：
  // 概览页的站点排名靠它，只被真实使用、没轮到探针的站不该凭空从排名里消失。
  // 此类条目没有探针记录，uptime 就是流量成功率、质量未知记 null。
  for (const offerId of Object.keys(traffic || {})) {
    if (!byOffer.has(offerId)) byOffer.set(offerId, [])
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

    // 真实流量：窗口是最近 1 小时，等同于最新数据，权重按 1 计；
    // 超出窗口的历史流量既不新、也不能当作长期表现（探针已经覆盖长期），直接不计
    const trafficRow = freshTraffic(traffic?.[offerId], now, trafficMaxAgeMs)
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
      // 没探过针、只有流量的条目，用流量窗口起点当「最近活跃时间」
      lastAt: records[records.length - 1]?.ts ?? traffic?.[offerId]?.since ?? null,
    })
  }
  return result
}

/**
 * 有效成本 = 名义价格 ÷ 质量系数。
 * 直观含义：为「一份可信输出」实际付了多少钱。
 * 降智的站名义价再低，除下来也可能更贵。
 * 价格入参按美元/百万 token（项目声明的比较口径）；币种不影响排序，
 * 但统一美元命名是为了和 pricing.js 的「比较一律按美元」对上。
 */
export function effectiveCost(priceUsdPerMtok, quality) {
  if (priceUsdPerMtok === null || priceUsdPerMtok === undefined) return null
  // 只有没有质量数据（null/undefined）才按 1 算；quality 恰为 0（探针全失败/
  // 流量全败）是「完全坏」，走 0.05 下限把成本放大 20 倍——此前 0 被当成
  // 「没探过」按 1 算，完全坏的站反而不降权
  const q =
    quality === null || quality === undefined || !Number.isFinite(quality)
      ? 1
      : Math.max(quality, 0.05)
  return priceUsdPerMtok / q
}
