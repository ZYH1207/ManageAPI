/**
 * 路由层：给定一个客户端请求的模型名，决定这一单交给谁。
 *
 * 决策规则（刻意做成可解释的两步，而不是加权打分）：
 *   1. 硬约束：只留评分健康（healthy）的供给；首字超限的排除
 *   2. 排序：按「有效成本 = 名义价格 ÷ 质量」升序
 *
 * 但用户可以在探针页打开「放行可疑供给」：打开后探针判定不可信/过期的照样参与排序，
 * 由「价格 ÷ 质量」自己去权衡——质量差一半，成本就翻倍，贵不到哪里去才轮得到它。
 * 首字上限是独立的显式设置，不受这个开关影响。
 *
 * 全都不可用时不做硬拒绝——按价格排下去试，但在响应头标记 degraded。
 * 个人工具里「能用」通常比「严格」更重要。
 */
import { offerCost } from './pricing.js'
import { isRoutable, effectiveCost, THRESHOLDS } from './score.js'
import { normalizeModelKey } from './inventory.js'

const INFINITY_COST = Number.POSITIVE_INFINITY

/** scoreOffers 返回 Map，但也允许传普通对象，两种都兼容。 */
function getScore(scores, offerId) {
  if (!scores) return undefined
  return scores instanceof Map ? scores.get(offerId) : scores[offerId]
}

/**
 * @param {{offers, providers, credentials, scores, benchmarks, settings, model, order?}} input
 *   order —— 用户手动调过的 offerId 顺序；只影响可用的那几条，不影响可用性判定
 * @returns {Array<{offer,provider,credential,price,quality,routable,effective,status,ttftMs}>}
 */
export function selectCandidates({ offers, providers, credentials, scores, benchmarks, settings, model, order }) {
  const key = normalizeModelKey(model)
  const maxTtftMs = Number(settings?.maxTtftMs) || 0
  // 用户开关：探针说可疑的也让它正常参与排序（首字上限仍然独立生效）
  const allowUntrusted = Boolean(settings?.allowUntrusted)
  const matched = offers.filter(
    (offer) =>
      offer.modelKey === key ||
      offer.upstreamName === model ||
      normalizeModelKey(offer.upstreamName) === key,
  )

  const rows = matched.map((offer) => {
    const provider = providers.find((p) => p.id === offer.providerId)
    const credential =
      (offer.credentialId && credentials.find((c) => c.id === offer.credentialId)) ||
      // 优先用同分组的 Key：不同分组的 Key 权限和倍率可能不同
      credentials.find(
        (c) => c.providerId === offer.providerId && (c.group || '') === (offer.group || ''),
      ) ||
      credentials.find((c) => c.providerId === offer.providerId)
    const cost = offerCost(offer, settings, benchmarks)
    const score = getScore(scores, offer.id)
    const quality = score?.quality ?? null
    // 两个价格口径，分工写在定价模块里：比较一律按美元（pricing.js 的声明），
    // 所以排序和有效成本用 priceUsd；price 字段是给前端展示的人民币值，
    // 由前端 priceText 按显示币种换算——此前排序直接拿 CNY 值，排序结果虽
    // 不受影响（汇率对全部候选是同一标量），但和声明的口径自相矛盾。
    const priceUsd = cost.blendedUsdPerMtok
    const price = cost.blendedCnyPerMtok
    const ttftMs = score?.ttftMs ?? null
    // 太慢的直接排除，但仍保留在候选列表里——决策日志要能看出「为什么没选它」
    const tooSlow = maxTtftMs > 0 && typeof ttftMs === 'number' && ttftMs > maxTtftMs

    // 把「为什么不可用」拆成人话，决策页直接显示。
    // 注意口径：fingerprint/truncation/billingRate 都是「正常比例」（未截断/未虚报），
    // 给用户看的要换算成异常比例——此前直接把 80% 未截断显示成「截断 80%」，意思完全反了
    const reasons = []
    if (tooSlow) reasons.push('首字超限')
    // 冷却中（额度不足/限流/模型不在分组）由状态标签单独表达，不塞进 reasons——
    // 决策页那一格已经显示「额度不足 · 冷却中」，再拼一遍等于同一句话说两次
    if (score?.stale) reasons.push('评分过期')
    if (typeof score?.availability === 'number' && score.availability < THRESHOLDS.availability) {
      reasons.push(`可用率 ${Math.round(score.availability * 100)}%`)
    }
    if (typeof score?.fingerprintRate === 'number' && score.fingerprintRate < 1) {
      reasons.push(`指纹 ${Math.round(score.fingerprintRate * 100)}%`)
    }
    if (typeof score?.truncationRate === 'number' && score.truncationRate < 1) {
      reasons.push(`截断 ${Math.round((1 - score.truncationRate) * 100)}%`)
    }
    if (typeof score?.billingRate === 'number' && score.billingRate < 1) {
      reasons.push(`计费 ${Math.round((1 - score.billingRate) * 100)}%`)
    }

    return {
      offer,
      provider,
      credential,
      price,
      quality,
      // probeOk 是探针的原始判定；routable 是「这一单会不会考虑它」
      probeOk: isRoutable(score),
      routable: (allowUntrusted || isRoutable(score)) && !tooSlow,
      tooSlow,
      // effective 是展示口径（人民币）；排序用 effectiveUsd，见上
      effective: effectiveCost(price, quality),
      effectiveUsd: effectiveCost(priceUsd, quality),
      status: score?.status || 'unknown',
      // 冷却中（额度不足/限流/模型不在分组）：不是坏站，但此刻不派过去
      blocked: score?.blocked || null,
      statusReason: reasons.join(' · ') || null,
      ttftMs,
    }
  })

  const manualIndex =
    Array.isArray(order) && order.length > 0
      ? new Map(order.map((id, index) => [id, index]))
      : null

  return rows
    .filter((row) => row.provider && row.credential)
    .sort((a, b) => {
      // 可用性永远优先：手动排序不能把不可信的站提到前面
      if (a.routable !== b.routable) return a.routable ? -1 : 1
      if (manualIndex) {
        const ia = manualIndex.has(a.offer.id) ? manualIndex.get(a.offer.id) : Number.MAX_SAFE_INTEGER
        const ib = manualIndex.has(b.offer.id) ? manualIndex.get(b.offer.id) : Number.MAX_SAFE_INTEGER
        if (ia !== ib) return ia - ib
      }
      // 有效成本排序按美元口径；兜底的展示价（CNY）与美元只差同一汇率标量，等价
      const ea = a.effectiveUsd ?? INFINITY_COST
      const eb = b.effectiveUsd ?? INFINITY_COST
      if (ea !== eb) return ea - eb
      return (a.price ?? INFINITY_COST) - (b.price ?? INFINITY_COST)
    })
}

/** 网关对外的模型清单：按归一化名去重，客户端用这个名字请求即可。 */
export function listPublicModels({ offers, scores }) {
  const seen = new Map()
  for (const offer of offers) {
    const id = offer.modelKey || normalizeModelKey(offer.upstreamName)
    if (!id) continue
    const entry = seen.get(id)
    const score = getScore(scores, offer.id)
    const healthy = isRoutable(score)
    if (!entry) {
      seen.set(id, { id, providers: 1, healthy: healthy ? 1 : 0 })
    } else {
      entry.providers += 1
      if (healthy) entry.healthy += 1
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** 生成给人看的决策说明，写进日志与响应头。 */
export function explain(candidates) {
  return candidates.map((c, index) => ({
    rank: index + 1,
    offerId: c.offer.id,
    providerId: c.offer.providerId,
    providerName: c.provider?.name ?? null,
    upstreamName: c.offer.upstreamName,
    group: c.offer.group || '',
    price: c.price,
    quality: c.quality,
    effective: c.effective,
    routable: c.routable,
    probeOk: c.probeOk,
    tooSlow: Boolean(c.tooSlow),
    ttftMs: c.ttftMs,
    status: c.status,
    // 冷却中（额度不足/限流/模型不在分组）：决策页用它显示「额度不足 · 冷却中」，
    // 不然用户看到一条看着健康的站却没被选，会以为评分出错
    blocked: c.blocked ? { kind: c.blocked.kind, until: c.blocked.until } : null,
    statusReason: c.statusReason ?? null,
  }))
}
