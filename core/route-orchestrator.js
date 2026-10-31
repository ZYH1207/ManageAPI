/**
 * 路由编排 —— 把速度模型、余额守卫、兜底阶梯串成一条决策链。
 *
 * ## 为什么单独一层
 *
 * 原来的问题是：判定逻辑散在 router / auto-route / decision-mode / server 四处，
 * 每一处都自己判「能不能用」，任一处判错就让整条链空掉。用户原话：
 * 「很多地方都有连锁反应，机制不够完善，就导致报错很容易整体全报错，
 *   最后哪个都用不了，整体网络直接崩掉」。
 *
 * 这一层的职责：**把「判定」和「排序」和「兜底」收在一个地方，且顺序固定**。
 *
 * ## 决策顺序（这个顺序是有讲究的，不能随便换）
 *
 *   1. 余额评估        ← 先看钱，因为余额为 0 是硬失败，不参与后续任何计算
 *   2. 速度估计        ← 用标定校正探针值，得到「用户实际会等多久」的估计
 *   3. 综合评分        ← 速度 × 余额惩罚 × 质量惩罚，得到一个可比的标量
 *   4. 按时评分排序    ← 这就是「谁最优」
 *   5. 兜底阶梯        ← **保证非空**：只要还有余额不为 0 的供给，就一定有候选
 *
 * 第 5 步是核心：**排序结果为空不代表不能用，只代表没有「好的」**。
 * 阶梯会把它们按「成功率从高到低」重新组织，绝不返回空链。
 *
 * ## 与缓存的配合
 *
 * 亲和判定（core/affinity.js）在这一切**之前**：如果这段对话上次用的站还能用，
 * 直接用它，根本不做评分排序。这是 Magpie 的做法，也是缓存能保住的原因。
 * 编排层只负责「确实需要重新选」时的决策。
 */

import { assessAllBalances, dailySpendByProvider, BALANCE, BALANCE_PENALTY } from './balance-guard.js'
import { buildCalibration, estimateSpeed, speedMetric, calibrationSummary, estimateTotalWait, estimateOutputTokens } from './speed-model.js'
import { buildLadder, rescueFromEmpty, ladderSummary, TIER, TIER_LABEL } from './fallback-ladder.js'

/** 默认的评分权重。 */
export const SCORING = {
  /** 速度在综合分里的权重（1 = 主看速度） */
  speedWeight: 1.0,
  /** 质量（可用率×完整性）的惩罚强度：质量低 → 分数被拉高（变差） */
  qualityWeight: 0.5,
  /** 价格权重（0 = 完全不看价格，纯看速度） */
  priceWeight: 0.0,
  /**
   * 是否把「吐字速度」算进等待时间。
   *
   * 开：score = 首字 + 预估输出 × 每 token 毫秒（更接近真实体感）
   * 关：score = 只看首字（等价于旧行为）
   *
   * 为什么默认开：只看首字会系统性地选错站 —— 首字快但吐字慢的站，
   * 在长回答上要慢好几倍（实测：首字 1s/5tok/s vs 首字 4s/50tok/s，
   * 2000 token 时前者 401 秒、后者 44 秒）。这条差异只有算进总等待才看得出来。
   *
   * 代价：输出长度只能估（max_tokens 的 50% 或历史均值），估错了排序会偏。
   * 所以只在「有吐字速度数据」时才启用这一段，没有就退回只看首字。
   */
  includeGeneration: true,
}

/**
 * 从数据库快照造出路由上下文。这一步很便宜（纯内存计算），每个请求都可调用。
 *
 * @param {object} db  store 的 db 快照
 * @param {object} [opts]
 * @returns {{
 *   calibration: object,
 *   calibrationText: string,
 *   balances: Map<string, object>,
 *   dailySpend: Map<string, number>,
 * }}
 */
export function buildRoutingContext(db, { now = Date.now(), maxTokens = null, expectedOutputTokens = null } = {}) {
  const offers = db?.offers ?? []
  const providers = db?.providers ?? []
  const offerStats = db?.offerStats ?? {}
  const settings = db?.settings ?? {}

  // ① 余额：算日均消耗，再用它评估每个站「还能撑几天」
  const dailySpend = dailySpendByProvider(offerStats, offers, { now })
  const balances = assessAllBalances(providers, {
    dailySpendMap: dailySpend,
    warnThreshold: Number(settings.balanceWarnUsd) || 0,
  })

  // ② 标定：从「同时有探针和真实数据」的供给里学「探针 → 真实」的比值
  const probesByOffer = latestProbeByOffer(db?.probes ?? [])
  const pairs = []
  for (const offer of offers) {
    const probeTtft = probesByOffer.get(offer?.id)?.ttftMs
    if (!probeTtft) continue
    // 真实值从 offerStats 算（这里用轻量版本，避免依赖 score.js 的完整链路）
    const real = realTtftOfStats(offerStats, offer.id, now)
    if (!real) continue
    pairs.push({ offerId: offer.id, providerId: offer.providerId, probeTtftMs: probeTtft, realTtftMs: real })
  }
  const calibration = buildCalibration(pairs)

  // ③ 站点级速度先验：同一个站的不同供给，速度通常接近（同一台服务器、同一条线路）。
  //    所以「这个站的其它供给有多快」是「这一条供给大概多快」的合理先验 ——
  //    比拿全局中位数准，也比「什么都不知道」强。
  //
  //    实测价值：本机库 357 个供给只有 157 个有探针，剩下的 200 个原本完全无法区分；
  //    有了站点级先验，它们能按「所在站点的整体水平」排序，而不是一律并列。
  const providerSpeed = new Map()
  for (const offer of offers) {
    const pid = offer?.providerId
    if (!pid) continue
    const probeTtft = probesByOffer.get(offer.id)?.ttftMs
    const realTtft = realTtftOfStats(offerStats, offer.id, now)
    // 只收有数据的样本
    const sampleMs = realTtft ?? probeTtft
    if (!sampleMs) continue
    // 真实值优先；探针值经标定校正后才计入
    const normalized = realTtft ?? (calibration.global ? probeTtft * calibration.global : probeTtft)
    if (!Number.isFinite(normalized) || normalized <= 0) continue
    if (!providerSpeed.has(pid)) providerSpeed.set(pid, [])
    providerSpeed.get(pid).push(normalized)
  }
  const providerSpeedPrior = new Map()
  for (const [pid, list] of providerSpeed) {
    if (!list.length) continue
    const sorted = [...list].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    providerSpeedPrior.set(pid, Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2))
  }

  // ④ 预估输出长度：短回答看首字，长回答看吐字 —— 这个数字决定了哪一段更重要
  const expectedOutput = expectedOutputTokens !== null
    ? { tokens: expectedOutputTokens, source: 'explicit' }
    : estimateOutputTokens({ maxTokens, historicalAvg: historicalOutputAvg(offerStats, now) })

  return {
    calibration,
    calibrationText: calibrationSummary(calibration).text,
    balances,
    dailySpend,
    providerSpeedPrior,
    expectedOutput,
  }
}

/** 从 offerStats 算历史平均输出 token（近 7 天）。 */
function historicalOutputAvg(offerStats, now, days = 7) {
  const cutoff = new Date(now - days * 86400_000).toISOString().slice(0, 13)
  let out = 0
  let n = 0
  for (const [key, b] of Object.entries(offerStats ?? {})) {
    const sep = key.lastIndexOf('|')
    if (sep < 0) continue
    if (key.slice(sep + 1) < cutoff) continue
    const reqs = Number(b?.requests) || 0
    if (!reqs) continue
    out += Number(b?.outputTokens) || 0
    n += reqs
  }
  return n > 0 ? out / n : null
}

/** 每个供给最近一次成功探针的 ttft。 */
function latestProbeByOffer(probes) {
  const out = new Map()
  for (const p of probes) {
    if (!p?.ok || !p?.ttftMs || !p?.offerId) continue
    const prev = out.get(p.offerId)
    if (!prev || String(p.ts) > String(prev.ts)) out.set(p.offerId, p)
  }
  return out
}

/**
 * 从 offerStats 算加权真实首字（指数衰减，半衰期 48 小时）。
 * 与 core/score.js#realTtftOf 同口径，但只算这一个值 —— 编排层不需要其它字段。
 */
function realTtftOfStats(offerStats, offerId, now, halfLifeHours = 48) {
  let weighted = 0
  let weightSum = 0
  for (const [key, b] of Object.entries(offerStats ?? {})) {
    if (!key.startsWith(`${offerId}|`)) continue
    const n = Number(b?.ttftCount)
    if (!(n > 0)) continue
    const hour = key.slice(offerId.length + 1)
    const bucketStart = Date.parse(`${hour}:00:00Z`)
    if (!Number.isFinite(bucketStart)) continue
    const ageHours = Math.max(0, (now - bucketStart) / 3600_000)
    const weight = Math.pow(0.5, ageHours / halfLifeHours)
    weighted += (Number(b.ttftSum) / n) * n * weight
    weightSum += n * weight
  }
  return weightSum > 0 ? Math.round(weighted / weightSum) : null
}

/**
 * 给一条候选行算综合评分（越小越优）。
 *
 * 评分构成：
 *   基础 = 速度估计（毫秒）
 *   × 余额惩罚（余量低的站被下调）
 *   × 质量惩罚（可用率差的站被下调）
 *   × 价格惩罚（可选，默认关闭 —— 用户明确说要「更注重速度」）
 *
 * @param {object} row 路由行
 * @param {object} ctx buildRoutingContext 的产物
 * @param {object} [opts]  SCORING 的覆盖
 * @returns {{
 *   score: number,
 *   speed: ReturnType<typeof estimateSpeed>,
 *   balance: object|null,
 *   parts: { speedMs:number, balancePenalty:number, qualityPenalty:number, pricePenalty:number },
 *   explain: string,
 * }}
 */
export function scoreRow(row, ctx, opts = {}) {
  const cfg = { ...SCORING, ...opts }
  const offerId = row?.offer?.id ?? null
  const providerId = row?.offer?.providerId ?? null

  // ① 速度：真实优先，探针经标定校正，都没有就用站点级先验
  let speed = estimateSpeed(row, {
    calibration: ctx?.calibration,
    offerId,
    providerId,
  })
  // 一条数据都没有：用「这个站别的供给有多快」当先验。
  // 置信度比裸探针更低（0.2），但比「完全未知」有用得多 ——
  // 至少能把「快站里的新供给」和「慢站里的新供给」区分开。
  if (speed.source === 'none' && providerId) {
    const prior = ctx?.providerSpeedPrior?.get(providerId)
    if (Number.isFinite(prior) && prior > 0) {
      speed = {
        ms: prior,
        source: 'provider-prior',
        confidence: 0.2,
        rawProbeMs: null,
        rawRealMs: null,
        ratio: null,
        note: `该站其它供给的中位速度 ${prior}ms（本条无数据，用站点先验）`,
      }
    }
  }
  const firstTokenMs = speedMetric(speed)
  const speedUsable = Number.isFinite(firstTokenMs)

  // ①b 吐字速度：把「首字 + 生成」合成「这次大概要等多久」。
  //     短回答时首字主导，长回答时吐字主导 —— 只有算进总等待才能正确比较。
  const perToken = Number(row?.realMsPerToken)
  const expected = ctx?.expectedOutput ?? null
  let baseMs = firstTokenMs
  let totalWait = null
  if (cfg.includeGeneration && speedUsable && expected) {
    totalWait = estimateTotalWait(firstTokenMs, perToken, expected.tokens)
    if (totalWait.known) baseMs = totalWait.totalMs
  }

  // ② 余额惩罚
  const balance = providerId ? (ctx?.balances?.get(providerId) ?? null) : null
  const balancePenalty = balance ? balance.penalty : BALANCE_PENALTY[BALANCE.UNKNOWN]

  // ③ 质量惩罚：质量 1.0 → 1.0 倍；质量 0.5 → 1.5 倍（变差）
  const quality = Number(row?.quality)
  const qualityPenalty = Number.isFinite(quality) && quality > 0
    ? 1 + (1 - Math.min(1, quality)) * cfg.qualityWeight
    : 1.5   // 不知道质量 → 保守

  // ④ 价格惩罚（默认关闭，保留开关）
  const price = Number(row?.priceUsd ?? row?.price)
  const pricePenalty = cfg.priceWeight > 0 && Number.isFinite(price) && price > 0
    ? 1 + price * cfg.priceWeight
    : 1

  // 速度完全未知：给一个「比最慢还慢一点」的分数，而不是 Infinity
  // —— Infinity 会让它在后续任何乘法里吃掉一切，反而丢失区分度
  const effective = speedUsable ? baseMs : Number.MAX_SAFE_INTEGER / 1e6

  const score = effective * balancePenalty * qualityPenalty * pricePenalty
  const parts = { speedMs: effective, balancePenalty, qualityPenalty, pricePenalty }

  const notes = []
  const sourceLabel = { real: '实测', calibrated: '标定', probe: '探针', 'provider-prior': '站点先验' }[speed.source] ?? '未知'
  if (totalWait?.known && totalWait.genMs > 0) {
    notes.push(`${sourceLabel} 首字${Math.round(totalWait.firstTokenMs)}ms+生成${Math.round(totalWait.genMs)}ms`)
  } else {
    notes.push(`${sourceLabel} ${Math.round(effective)}ms`)
  }
  if (balancePenalty !== 1) notes.push(`余额×${balancePenalty}`)
  if (qualityPenalty !== 1) notes.push(`质量×${qualityPenalty.toFixed(2)}`)
  if (pricePenalty !== 1) notes.push(`价格×${pricePenalty.toFixed(2)}`)

  return {
    score: Number.isFinite(score) ? score : Number.MAX_SAFE_INTEGER,
    speed,
    balance,
    parts,
    explain: notes.join(' · '),
  }
}

/**
 * 完整路由决策。
 *
 * 这是**唯一该被网关和诊断页调用的入口** —— 它保证：
 *   1. 返回的链非空（只要还有余额不为 0 的供给）
 *   2. 链里每一条都带 tier（为什么在这个位置）
 *   3. 每条都带可解释的评分明细
 *
 * @param {Array<object>} rows  selectCandidates 的产物
 * @param {object} ctx          buildRoutingContext 的产物
 * @param {object} [opts]
 * @param {Set<string>} [opts.tried]     本次请求已试过的 offerId
 * @param {number} [opts.maxPerTier]     每级最多几条
 * @param {object} [opts.scoring]        覆盖 SCORING
 * @returns {{
 *   chain: Array<object>,
 *   summary: object,
 *   context: object,
 *   degraded: boolean,
 * }}
 */
export function decideRoute(rows = [], ctx = {}, { tried = new Set(), maxPerTier = 3, scoring = {} } = {}) {
  // ① 逐条打分，并把余额状态**回填进行本身**
  //
  // 为什么必须回填：兜底阶梯（core/fallback-ladder.js）靠 `row.balanceDepleted`
  // 判「这条是不是根本不能用」。如果这里只在 scoreRow 内部算余额、不写回 row，
  // 阶梯就看不到余额为 0 这件事，会把欠费的站也排进链里 —— 用户白等一个来回
  // 才拿到上游的拒单。（这个 bug 在集成测试里真踩到了。）
  const scored = rows.map((row) => {
    const s = scoreRow(row, ctx, scoring)
    const balanceDepleted = s.balance?.state === BALANCE.EMPTY
      // 兜底：如果调用方（selectCandidates）已经标了，尊重它
      || row.balanceDepleted === true
    return {
      ...row,
      // 余额状态回填：让后续阶梯/日志/面板看到的是同一份判定
      balanceDepleted,
      routeScore: s.score,
      speedInfo: s.speed,
      balanceInfo: s.balance,
      scoreParts: s.parts,
      scoreExplain: s.explain,
    }
  })

  // ② 按综合分排序（只调顺序，不改准入判定 —— 准入仍由 selectCandidates 负责）
  scored.sort((a, b) => a.routeScore - b.routeScore)

  // ③ 兜底阶梯：保证非空
  let ladder = buildLadder(scored, { tried, maxPerTier })
  let rescued = null

  if (ladder.chain.length === 0) {
    // 最后一道防线：捞回软失败的候选
    rescued = rescueFromEmpty(scored, { tried })
    if (rescued.rescued.length > 0) {
      ladder = {
        ...ladder,
        chain: rescued.rescued.slice(0, maxPerTier),
        byTier: { ...ladder.byTier, [TIER.HARD_FAIL]: rescued.rescued.length },
      }
    }
  }

  const summary = ladderSummary(ladder)
  return {
    chain: ladder.chain,
    summary: {
      ...summary,
      rescued: rescued?.why ?? null,
      calibration: ctx?.calibrationText ?? '',
    },
    context: ctx,
    // 只有「连强制兜底都用上」或「全是次优级」才算降级
    degraded: ladder.chain.length > 0 && ladder.chain.every((r) => (r.tier ?? 0) > TIER.SLOW),
  }
}

export { TIER, TIER_LABEL, BALANCE, buildCalibration, estimateSpeed, speedMetric }
