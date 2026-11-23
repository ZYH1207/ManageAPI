/**
 * 路由层：给定一个客户端请求的模型名，决定这一单交给谁。
 *
 * 决策规则（刻意做成可解释的两步，而不是加权打分）：
 *   1. 硬约束：只留评分健康（healthy）的供给；首字超限的排除
 *   2. 排序：按用户选的「决策侧重」升序（settings.decisionMode，见 decision-mode.js）：
 *        价格档比名义单价、性价比档比有效成本、质量档先比质量再比价格
 *
 * 排序偏好只决定「谁能排前面」，不参与第 1 步的准入；两个开关各管一件事，
 * 混成一个滑块用户就说不清自己改的是哪条规则。
 *
 * 但用户可以在探针页打开「放行可疑供给」：打开后探针判定不可信/过期的照样参与排序，
 * 由「价格 ÷ 质量」自己去权衡——质量差一半，成本就翻倍，贵不到哪里去才轮得到它。
 * 首字上限是独立的显式设置，不受这个开关影响。
 *
 * 全都不可用时不做硬拒绝——按排序键排下去试（routable=false 的留在候选尾部），
 * 并在响应头打 X-ManageAPI-Degraded: 1，让客户端知道这一单是「硬试」出来的。
 * 库里根本没有候选时不是降级，而是 404/402，并带 blockedModelReport 的结构化原因。
 * 个人工具里「能用」通常比「严格」更重要。
 */
import { offerCost } from './pricing.js'
import { isRoutable, effectiveCost, THRESHOLDS } from './score.js'
import { normalizeModelKey } from './inventory.js'
import { normalizeDecisionMode, compareByMode, sortValueOf } from './decision-mode.js'

const INFINITY_COST = Number.POSITIVE_INFINITY

/** scoreOffers 返回 Map，但也允许传普通对象，两种都兼容。 */
function getScore(scores, offerId) {
  if (!scores) return undefined
  return scores instanceof Map ? scores.get(offerId) : scores[offerId]
}

/**
 * @param {{offers, providers, credentials, scores, benchmarks, settings, model, order?, profiles?}} input
 *   order —— 用户手动调过的 offerId 顺序；只影响可用的那几条，不影响可用性判定
 *   profiles —— offerId → {cacheHitRate, inputShare} 的流量画像；缺省时按设置里的固定值算
 * @returns {Array<{offer,provider,credential,price,priceUsd,quality,routable,effective,status,ttftMs}>}
 */
export function selectCandidates({
  offers,
  providers,
  credentials,
  scores,
  benchmarks,
  settings,
  model,
  order,
  profiles,
  stickyOfferId = null,
  stickinessPct = 0.05,
}) {
  const key = normalizeModelKey(model)
  const maxTtftMs = Number(settings?.maxTtftMs) || 0
  // 用户开关：探针说可疑的也让它正常参与排序（首字上限仍然独立生效）
  const allowUntrusted = Boolean(settings?.allowUntrusted)
  // 排序偏好（价格 / 性价比 / 质量）：只改排序键，不改上面两条准入判定
  const decisionMode = normalizeDecisionMode(settings?.decisionMode)
  // 流量画像：Map 或普通对象都兼容（网关热路径传 Map，测试可以传对象）
  const profileOf = (offer) =>
    (profiles instanceof Map ? profiles.get(offer.id) : profiles?.[offer.id]) || null
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
    const profile = profileOf(offer)
    const cost = offerCost(offer, settings, benchmarks, profile || {})
    const score = getScore(scores, offer.id)
    const quality = score?.quality ?? null
    // 两个价格口径，分工写在定价模块里：比较一律按美元（pricing.js 的声明），
    // 所以排序和有效成本用 priceUsd；price 字段是给前端展示的人民币值，
    // 由前端 priceText 按显示币种换算——此前排序直接拿 CNY 值，排序结果虽
    // 不受影响（汇率对全部候选是同一标量），但和声明的口径自相矛盾。
    // 期望成本口径：输入占比按真实流量、输入价按缓存命中打折。
    // 旧口径（固定输入权重、不看缓存）保留在 priceUsdLegacy 里，供界面并列展示与回滚核对。
    const priceUsdLegacy = cost.blendedUsdPerMtok
    const priceUsd = cost.blendedUsdPerMtokExpected ?? priceUsdLegacy
    const price = cost.blendedCnyPerMtokExpected ?? cost.blendedCnyPerMtok
    const priceLegacy = cost.blendedCnyPerMtok
    const ttftMs = score?.ttftMs ?? null
    // 首字相对值（同轮「比最快的那条慢多少毫秒」）：绝对值含本机链路，
    // 打平链优先用它，两条都有相对值时才比相对值，否则回落到绝对值
    const ttftRelMs = score?.ttftRelMs ?? null
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
    // 探针全被额度/限流挡住时，可用率没有分母（null）——这不是「能用」，
    // 而是「没有任何可靠性证据」，必须说清楚，否则用户看不懂为什么没选它
    if (!score || score.samples === 0) reasons.push('还没探测过')
    if (score && score.availability === null && !score.blocked) reasons.push('没有可信样本')
    if (typeof score?.availability === 'number' && score.availability < THRESHOLDS.availability) {
      reasons.push(`可用率 ${Math.round(score.availability * 100)}%`)
    }
    // 完整性只说「哪一项不合格」，不再拿平滑后的通过率当理由：
    // 平滑值 50% 可能只是「测了 1 次、错了 1 次」，写成「指纹 50%」会误导
    if (Array.isArray(score?.integrityFaults) && score.integrityFaults.length > 0) {
      reasons.push(score.integrityFaults.join(' · '))
    }

    return {
      offer,
      provider,
      credential,
      price,
      // 美元口径的期望单价：排序用这个（CNY 值只是展示口径，见上）
      priceUsd,
      // 旧口径（未按流量画像折算）——只用于对照，不参与排序
      priceUsdLegacy,
      priceLegacy,
      // 这一条用了多少缓存命中折扣：null 表示没测到（按先验值算的）
      cacheHitRate: cost.costProfile?.cacheHitRate ?? null,
      costProfile: cost.costProfile || null,
      // 这一条是不是「上次成功的站」：粘性只在价差 <stickinessPct 时生效
      sticky: Boolean(stickyOfferId) && offer.id === stickyOfferId,
      quality,
      // 质量是否有实测证据：null 不是「质量 0」，而是「一次都没成功过」；
      // 有效成本里按 NO_EVIDENCE_QUALITY（0.5）算，界面要能看出这个区别
      qualityKnown: quality !== null && quality !== undefined,
      // probeOk 是探针的原始判定；routable 是「这一单会不会考虑它」
      probeOk: isRoutable(score),
      routable: (allowUntrusted || isRoutable(score)) && !tooSlow,
      tooSlow,
      // effective 是展示口径（人民币）；排序用 effectiveUsd，见上
      effective: effectiveCost(price, quality),
      effectiveUsd: effectiveCost(priceUsd, quality),
      // 当前档位下这一条拿什么键参与排序（界面「排序键」列直接显示它，
      // 否则用户看到的数字和排名顺序对不上，会以为排序坏了）
      decisionMode,
      sortValue: sortValueOf({ priceUsd, quality, effectiveUsd: effectiveCost(priceUsd, quality) }, decisionMode),
      status: score?.status || 'unknown',
      // 证据量与置信度：1 个样本的「健康」和 10 个样本的「健康」确定性差很多，
      // 界面必须能看出来，否则用户会以为 healthy 等于「已验证可靠」
      samples: (score?.samples || 0) + (score?.trafficSamples || 0),
      confidence: score?.confidence ?? null,
      // 冷却中（额度不足/限流/模型不在分组）：不是坏站，但此刻不派过去
      blocked: score?.blocked || null,
      statusReason: reasons.join(' · ') || null,
      ttftMs,
      ttftRelMs,
    }
  })

  const manualIndex =
    Array.isArray(order) && order.length > 0
      ? new Map(order.map((id, index) => [id, index]))
      : null

  const sorted = rows
    .filter((row) => row.provider && row.credential)
    .sort((a, b) => {
      // 可用性永远优先：手动排序不能把不可信的站提到前面
      if (a.routable !== b.routable) return a.routable ? -1 : 1
      if (manualIndex) {
        const ia = manualIndex.has(a.offer.id) ? manualIndex.get(a.offer.id) : Number.MAX_SAFE_INTEGER
        const ib = manualIndex.has(b.offer.id) ? manualIndex.get(b.offer.id) : Number.MAX_SAFE_INTEGER
        if (ia !== ib) return ia - ib
      }
      // 排序键随「决策侧重」变：价格档比名义单价、性价比档比有效成本、
      // 质量档先比质量再比价格。缺值在 orderKey 里统一按 Infinity 处理。
      const byMode = compareByMode(a, b, decisionMode)
      if (byMode !== 0) {
        // 粘性：两条价格差很小（默认 <5%）时，优先留在「上次成功的那个站」——
        // 换站会让上游的前缀缓存作废，一次抖动就换站的代价比省下的那点钱高。
        // 差得多了就照常按排序键走，粘性不能盖过真实价差。
        if (stickyOfferId && (a.offer.id === stickyOfferId || b.offer.id === stickyOfferId)) {
          const av = sortValueOf(a, decisionMode)
          const bv = sortValueOf(b, decisionMode)
          if (Number.isFinite(av) && Number.isFinite(bv)) {
            const base = Math.min(av, bv)
            const gap = Math.abs(av - bv)
            const tolerance = Math.max(0, Number(stickinessPct) || 0)
            if (base > 0 && gap / base < tolerance) {
              return a.offer.id === stickyOfferId ? -1 : 1
            }
          }
        }
        return byMode
      }
      // 完全打平（排序键相同）时的次序：命中率高的先、首字低的后、再按名义价兜底。
      // 这条链只决定「一样好的两条谁先」，不影响任何准入判定。
      const ha = typeof a.cacheHitRate === 'number' ? a.cacheHitRate : -1
      const hb = typeof b.cacheHitRate === 'number' ? b.cacheHitRate : -1
      if (ha !== hb) return hb - ha
      // 首字优先比相对值（同轮「比最快的慢多少」），这样本机带宽抖动不会影响次序
      const useRel = typeof a.ttftRelMs === 'number' && typeof b.ttftRelMs === 'number'
      const ta = useRel
        ? a.ttftRelMs
        : typeof a.ttftMs === 'number'
          ? a.ttftMs
          : INFINITY_COST
      const tb = useRel
        ? b.ttftRelMs
        : typeof b.ttftMs === 'number'
          ? b.ttftMs
          : INFINITY_COST
      if (ta !== tb) return ta - tb
      return (a.price ?? INFINITY_COST) - (b.price ?? INFINITY_COST)
    })

  // 排完之后给每一行补一句「为什么排在这里」：它跟上一名的差别是什么。
  // 排序本身在上面完成，这里只做解释，不改顺序——但两处必须用同一套判定，
  // 所以解释函数读的是同一批字段（routable / manualIndex / sortValue / 命中率 / 首字）。
  sorted.forEach((row, index) => {
    const reason = orderReasonBetween(sorted[index - 1], row, {
      decisionMode,
      stickinessPct,
      stickyOfferId,
      manualIndex,
    })
    row.orderReason = reason.code
    row.orderReasonText = reason.text
  })
  return sorted
}

/**
 * 第 cur 条为什么排在 prev 后面——把排序时真正生效的那一步翻译成人话。
 * 纯解释函数：只读候选行，不修改、不参与排序。
 */
export function orderReasonBetween(
  prev,
  cur,
  { decisionMode = 'value', stickinessPct = 0, stickyOfferId = null, manualIndex = null } = {},
) {
  if (!prev) return { code: 'first', text: '排序键最优（同模型里它最便宜/质量最高）' }
  // 1. 准入：能不能用排在第一位，价格再好也翻不过去
  if (prev.routable !== cur.routable) {
    return cur.routable
      ? { code: 'gate', text: '它可用，上一条不可用（准入优先于价格）' }
      : { code: 'gate', text: '它不可路由：没有可信证据/被探针判可疑，排在有证据的后面' }
  }
  // 2. 手动顺序
  if (manualIndex) {
    const ip = manualIndex.has(prev.offer.id) ? manualIndex.get(prev.offer.id) : Number.MAX_SAFE_INTEGER
    const ic = manualIndex.has(cur.offer.id) ? manualIndex.get(cur.offer.id) : Number.MAX_SAFE_INTEGER
    if (ip !== ic) return { code: 'manual', text: '你在决策页手动排的顺序' }
  }
  // 3. 排序键（档位决定比什么）
  const byMode = compareByMode(prev, cur, decisionMode)
  const pv = sortValueOf(prev, decisionMode)
  const cv = sortValueOf(cur, decisionMode)
  const pct = Number.isFinite(pv) && Number.isFinite(cv) && Math.min(pv, cv) > 0
    ? Math.abs(cv - pv) / Math.min(pv, cv)
    : null
  if (byMode !== 0) {
    // 粘性：价差在阈值内时，优先留在上次成功的站（避免换站导致上游前缀缓存作废）
    if (stickyOfferId && (prev.offer.id === stickyOfferId || cur.offer.id === stickyOfferId)) {
      const tolerance = Math.max(0, Number(stickinessPct) || 0)
      if (pct !== null && pct < tolerance) {
        return {
          code: 'sticky',
          text: `粘住上次成功的站（价差 ${(pct * 100).toFixed(1)}% < 阈值 ${(tolerance * 100).toFixed(0)}%，换站会让上游缓存作废）`,
          gapPct: pct,
        }
      }
    }
    return {
      code: 'key',
      text: pct === null ? '排序键更低' : `排序键比上一条高 ${(pct * 100).toFixed(1)}%`,
      gapPct: pct,
    }
  }
  // 4. 排序键完全相同时的打平链
  const hp = typeof prev.cacheHitRate === 'number' ? prev.cacheHitRate : -1
  const hc = typeof cur.cacheHitRate === 'number' ? cur.cacheHitRate : -1
  if (hp !== hc) {
    const fmt = (v) => (v < 0 ? '未测' : `${Math.round(v * 100)}%`)
    return { code: 'tie-hit', text: `排序键相同，缓存命中率 ${fmt(hc)} 低于上一条的 ${fmt(hp)}` }
  }
  const useRel = typeof prev.ttftRelMs === 'number' && typeof cur.ttftRelMs === 'number'
  const tp = useRel
    ? prev.ttftRelMs
    : typeof prev.ttftMs === 'number'
      ? prev.ttftMs
      : INFINITY_COST
  const tc = useRel
    ? cur.ttftRelMs
    : typeof cur.ttftMs === 'number'
      ? cur.ttftMs
      : INFINITY_COST
  if (tp !== tc) {
    const fmt = (v) => (v === INFINITY_COST ? '无数据' : `${v}ms`)
    const unit = useRel ? '比本轮最快多' : ''
    return {
      code: 'tie-ttft',
      text: `排序键与命中率相同，首字 ${unit}${fmt(tc)} 慢于上一条的 ${unit}${fmt(tp)}${useRel ? '（相对值，已扣掉本机链路）' : ''}`,
    }
  }
  return { code: 'tie-price', text: '前面全都相同，按名义单价兜底' }
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
    priceUsd: c.priceUsd,
    priceUsdLegacy: c.priceUsdLegacy ?? null,
    cacheHitRate: c.cacheHitRate ?? null,
    quality: c.quality,
    qualityKnown: c.qualityKnown,
    effective: c.effective,
    // 当前档位与它真正用来排序的值：决策页「排序键」列直接显示这个值，
    // 否则用户切到价格档后看到「有效成本」一列的数字和排名对不上
    decisionMode: c.decisionMode,
    sortValue: c.sortValue,
    routable: c.routable,
    probeOk: c.probeOk,
    tooSlow: Boolean(c.tooSlow),
    ttftMs: c.ttftMs,
    ttftRelMs: c.ttftRelMs ?? null,
    status: c.status,
    samples: c.samples,
    confidence: c.confidence,
    // 冷却中（额度不足/限流/模型不在分组）：决策页用它显示「额度不足 · 冷却中」，
    // 不然用户看到一条看着健康的站却没被选，会以为评分出错
    blocked: c.blocked ? { kind: c.blocked.kind, until: c.blocked.until } : null,
    statusReason: c.statusReason ?? null,
    // 为什么排在这里（相对上一名）：决策页单独一列显示，纯解释不改顺序
    orderReason: c.orderReason ?? null,
    orderReasonText: c.orderReasonText ?? null,
  }))
}
