/**
 * 路由层：给定一个客户端请求的模型名，决定这一单交给谁。
 *
 * 决策规则（刻意做成可解释的两步，而不是加权打分）：
 *   1. 准入：见 admissionOf——慢速 / 可疑 / 不稳定 / 没有可信样本 / 冷却中一律不登场
 *   2. 排序：剩下的人按 settings.decisionMode 选定的口径升序
 *      性价比（默认）→ 有效成本；价格 → 名义单价；首字速度 → 首字延迟
 *      三档都只改「谁排前面」，准入规则完全不看这个开关
 *   3. 手动顺序（决策页拖拽）：只改「先试谁」，准入仍然是硬门槛
 *
 * 「不登场」是真的不登场：selectCandidates 把不可用的候选也留在表里（决策页要
 * 能看出「为什么没选它」），但网关只会在 admission.ok 的候选里派活；一条都没有
 * 就直接报错，而不是像以前那样「反正都不可用了，拿最便宜的碰碰运气」。
 * 用户自己设了首字门槛，就等于明说「超过这个速度我宁可报错」。
 *
 * 但用户可以在探针页打开「放行可疑供给」：打开后可疑/不稳定的站重新获得准入，
 * 再由当前决策侧重（性价比 / 价格 / 首字速度）自己决定谁排前面。
 * 首字门槛是独立的显式设置，不受这个开关影响；冷却中同样不受影响——
 * 「结果可疑但我认了」和「刚被上游拒过」是两件事，后者试了只会白等一个来回。
 */
import { offerCost } from './pricing.js'
import { UNAVAILABLE_LABEL } from './failure.js'
import { isRoutable, effectiveCost, THRESHOLDS, MIN_SAMPLES_FOR_VERDICT } from './score.js'
import { normalizeModelKey } from './inventory.js'
import { normalizeDecisionMode, compareByBasis } from './decision-mode.js'

/** scoreOffers 返回 Map，但也允许传普通对象，两种都兼容。 */
function getScore(scores, offerId) {
  if (!scores) return undefined
  return scores instanceof Map ? scores.get(offerId) : scores[offerId]
}

/**
 * 冷却类状态的文案：原因 + 还要等多久 / 在等什么。
 *
 * 两种状态共用一套措辞，因为对客户端来说它们是同一件事（现在不派活），
 * 只差「是等时间还是等证据」：
 *   pending=false —— 冷却窗口内，等时间到（额度/限流/模型不可用）
 *   pending=true  —— 冷却已到，等下一次探测成功才算恢复
 */
function blockedText(reason, { pending = false } = {}) {
  const label = UNAVAILABLE_LABEL[reason?.kind] || '暂时不可用'
  if (pending) return `${label}：冷却已到，等下一次探测确认恢复`
  const minutes = Math.max(1, Math.ceil((Number(reason?.until) - Date.now()) / 60000))
  return `${label}：冷却 ${minutes} 分钟后自动重试`
}

/**
 * 准入门禁：这条候选现在能不能真的派流量。
 *
 * 和 isRoutable 的差别只有一个字——**过期不是罪**。
 * 评分过期只说明 6 小时内没有新证据，而一次真实调用本身就是证据
 * （scoreOffers 会把流量并进可用率）。所以过期 / 未探测的供给照样准入，
 * 只是排在健康供给之后兜底：先让真实流量跑起来，下一轮评分就自愈了。
 *
 * 硬拒的只有四类，用户看得出来、也修得动：
 *   慢速 —— 首字超过门槛，这是你自己设的线
 *   可疑 / 不稳定 —— 探针抓到掉包/截断/虚报，或真实可用率不到 80%
 *   没有可信样本 —— 探针全被额度/限流挡住，可用率根本没有分母
 *   冷却中 / 待复测 —— 额度不足、限流、模型不在分组（见下）
 *
 * 冷却为什么不放行：冷却意味着「刚才这条供给明确说不行」，放行只是再撞一次
 * 同样的墙。真实踩过：一个模型 4 条供给，3 条慢速被首字门槛挡住，剩下 1 条
 * 限流，网关就反复重试那条限流，客户端等半天最后仍然失败。
 * 恢复也不看钟：冷却到期后要等下一次探测（或真实调用）成功才放行，见
 * score.js 的 pendingRecovery。
 *
 * 判定只用这一份：网关派活、决策页的「当前选」、报错文案都调它，
 * 别在调用方再写一遍「什么算可用」，否则两处口径迟早漂移。
 */
export function admissionOf(row) {
  if (!row) return { ok: false, kind: 'none', text: '没有候选' }
  // 慢速：这是用户自己设的线，不因「放行可疑供给」而失效
  if (row.tooSlow) {
    return { ok: false, kind: 'slow', text: `慢速：首字 ${row.ttftMs}ms 超过门槛` }
  }
  // 冷却中 / 待复测：同样不受「放行可疑供给」影响。那个开关是「我认了结果可疑
  // 也愿意试」，而这里是「刚被上游明确拒过」，试了只会白等一个来回。
  if (row.blocked) {
    return { ok: false, kind: 'blocked', text: blockedText(row.blocked) }
  }
  if (row.pendingRecovery) {
    return { ok: false, kind: 'blocked', text: blockedText(row.pendingRecovery, { pending: true }) }
  }
  // 「放行可疑供给」是用户的显式覆盖：打开后可疑/不稳定的重新获得准入
  if (!row.allowUntrusted) {
    const faults = Array.isArray(row.integrityFaults) ? row.integrityFaults : []
    if (row.status === 'degraded' || faults.length > 0) {
      return {
        ok: false,
        kind: 'degraded',
        text: `可疑：${faults.length > 0 ? faults.join(' · ') : '结果不可信'}`,
      }
    }
    if (row.status === 'unstable') {
      return { ok: false, kind: 'unstable', text: '不稳定：可用率低于 80%' }
    }
  }
  // 可用率是 null 有三种来源，别一锅端：
  //   样本 0        —— 一次都没探过。`没证据` != `坏证据`，放行（新站不放行就永远用不了）
  //   状态 stale    —— 有证据但都过期了。放行，派一次真实调用就刷新了（用户明确要的）
  //   其余（samples>0、不是 stale、又不是冷却/待复测）—— 探针全被额度/限流挡住，
  //                  可用率根本没有分母，这种才是真的「没有可信样本」
  const samples = Number(row.samples) || 0
  const availability = row.availability
  if (availability === null || availability === undefined) {
    if (samples === 0 || row.status === 'stale') {
      // 放行
    } else {
      return { ok: false, kind: 'no-evidence', text: '没有可信样本：探针被额度/限流挡住' }
    }
  }
  return { ok: true, kind: null, text: null }
}

/**
 * 一条候选身上「同时成立」的全部状态标签，只给界面用。
 *
 * admissionOf 是门禁，只回答「能不能登场」，所以取第一个不通过的类别就够；
 * 但人看决策页要知道全部：一条又慢又掉包的供给只标「慢速」，会让人以为
 * 把门槛放宽就能用。所以另给一份清单。
 *
 * 它不参与任何派活判定（网关只认 admission.ok），也不改 admissionOf 的结论，
 * 纯粹是「这条供给现在有哪些毛病」的完整陈列。
 *
 * 返回的是 kind 而不是文案：翻译和配色归前端（web/app.js 的 STATUS_TAG），
 * 判定只留这一份——两个页面（比价、决策）都从这里取，免得各写一套「什么算可疑」。
 *
 * @param {object} row 与 admissionOf 同一份行（offer 候选）
 * @returns {string[]} 例：['slow','degraded','unstable']
 */
export function admissionTags(row) {
  if (!row) return []
  const tags = []
  const faults = Array.isArray(row.integrityFaults) ? row.integrityFaults : []
  const availability = row.availability
  const samples = Number(row.samples) || 0
  // 慢速：用户自己设的线
  if (row.tooSlow) tags.push('slow')
  // 结果可疑：指纹不符 / 输出截断 / 用量虚报，单次即可定性（同 score.js 的 degraded）
  if (row.status === 'degraded' || faults.length > 0) tags.push('degraded')
  if (typeof availability === 'number' && availability < THRESHOLDS.availability) {
    // 样本不够时不下「不稳定」的结论，只标证据不足——和 score.js 的
    // MIN_SAMPLES_FOR_VERDICT 同一口径，否则一次失败就挂红
    tags.push(samples >= MIN_SAMPLES_FOR_VERDICT ? 'unstable' : 'inconclusive')
  } else if (
    (availability === null || availability === undefined) &&
    samples > 0 &&
    row.status !== 'stale' &&
    !row.blocked &&
    !row.pendingRecovery
  ) {
    // 有样本、可用率却没有分母：探针全被额度/限流挡住
    tags.push('no-evidence')
  }
  // 冷却中不是「坏」：额度/限流/模型不在分组，恢复后自动回来。
  // 冷却到期但还没探到成功，就是「待复测」——两种都要标，用户才知道为什么没派活
  if (row.blocked) tags.push('blocked')
  else if (row.pendingRecovery) tags.push('awaiting-recovery')
  // 没有任何毛病时才谈「靠什么撑着」——否则「兜底」会盖住真正的问题
  if (tags.length === 0 && (row.status === 'stale' || row.status === 'unknown')) tags.push('fallback')
  if (tags.length === 0) tags.push('ok')
  return tags
}

/**
 * 一条能登场的候选都没有时，该跟客户端说什么。
 *
 * 慢速和「不可用」必须分开报：前者是门槛设得太紧（或这家确实变慢了），
 * 后者是站坏了——用户和客户端要做的动作完全不同。两者都用 400：
 * 这不是「服务端临时故障」（5xx 会让客户端无限重试），而是「按你的规则，
 * 这单没人能接」，重试也没意义。
 *
 * 文案放这里而不是写在 server.js：决策页以后要显示同一句话，两处各写一遍必然漂移。
 *
 * @returns {{status:number, type:string, message:string, detail:string}}
 */
export function admissionFailure(candidates, { model = '', maxTtftMs = 0 } = {}) {
  const detail = candidates
    .map(
      (c) =>
        `${c.provider?.name ?? '未知站点'}${c.offer?.group ? `（${c.offer.group}）` : ''}：${c.admission?.text || c.statusReason || c.status || '不可用'}`,
    )
    .join('；')
  const onlySlow = candidates.length > 0 && candidates.every((c) => c.admission?.kind === 'slow')
  if (onlySlow) {
    return {
      status: 400,
      type: 'upstream_too_slow',
      detail,
      message: `上游速度慢于首字门槛（${maxTtftMs}ms）：${detail}。可在「智能决策」页放宽门槛，或换个模型`,
    }
  }
  return {
    status: 400,
    type: 'no_available_supply',
    detail,
    message: `没有可用的 ${model}：${detail}`,
  }
}

/**
 * @param {{offers, providers, credentials, scores, benchmarks, settings, model, order?, isFaulted?}} input
 *   order —— 用户手动调过的 offerId 顺序；整张表都参与（包括暂时不会登场的），
 *            但能不能真的登场仍由 admissionOf 判定——排在前面只是位置，不是通行证
 *   isFaulted —— 可选谓词（core/failover.js#faultMatcher）：外部监控上报的真实故障。
 *            降级不拉黑：故障转移不是准入判定，探针说健康就照样 admission.ok，
 *            只是同类里靠后 + 自动路由不把它当「最优」；故障到期自动恢复
 * @returns {Array<{offer,provider,credential,price,quality,routable,effective,status,ttftMs}>}
 */
export function selectCandidates({ offers, providers, credentials, scores, benchmarks, settings, model, order, isFaulted }) {
  const key = normalizeModelKey(model)
  const maxTtftMs = Number(settings?.maxTtftMs) || 0
  // 用户开关：探针说可疑的也让它正常参与排序（首字上限仍然独立生效）
  const allowUntrusted = Boolean(settings?.allowUntrusted)
  // 排序侧重：只影响「能登场的里面谁排前面」，准入判定完全不受它影响
  const decisionMode = normalizeDecisionMode(settings?.decisionMode)
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
    // 徽章已经写着「慢速」，理由只补数字：差多少、门槛多少
    if (tooSlow) reasons.push(`首字 ${ttftMs}ms > 门槛 ${maxTtftMs}ms`)
    // 冷却中 / 待复测：这是「刚才上游明确说不行」，必须让人看得出为什么没派它
    if (score?.blocked) reasons.push(blockedText(score.blocked))
    else if (score?.pendingRecovery) reasons.push(blockedText(score.pendingRecovery, { pending: true }))
    // 评分过期不挡路（真实调用本身就是证据），但要说清楚它现在是靠不住的
    if (score?.stale) reasons.push('评分过期：没有新鲜证据，先拿真实调用打探')
    // 探针全被额度/限流挡住时，可用率没有分母（null）——这不是「能用」，
    // 而是「没有任何可靠性证据」，必须说清楚，否则用户看不懂为什么没选它。
    // 冷却 / 待复测已经单独说了原因，不再重复标「没有可信样本」
    if (score && score.availability === null && !score.blocked && !score.pendingRecovery) {
      reasons.push('没有可信样本')
    }
    if (typeof score?.availability === 'number' && score.availability < THRESHOLDS.availability) {
      reasons.push(`可用率 ${Math.round(score.availability * 100)}%`)
    }
    // 完整性只说「哪一项不合格」，不再拿平滑后的通过率当理由：
    // 平滑值 50% 可能只是「测了 1 次、错了 1 次」，写成「指纹 50%」会误导
    if (Array.isArray(score?.integrityFaults) && score.integrityFaults.length > 0) {
      reasons.push(score.integrityFaults.join(' · '))
    }

    const row = {
      offer,
      provider,
      credential,
      price,
      // 名义单价（美元/百万 token）：价格档排序用，展示仍走 price（人民币）
      priceUsd,
      quality,
      // probeOk 是探针的原始判定；routable 是「这一单会不会优先考虑它」
      probeOk: isRoutable(score),
      routable: (allowUntrusted || isRoutable(score)) && !tooSlow,
      tooSlow,
      // effective 是展示口径（人民币）；排序用 effectiveUsd，见上
      effective: effectiveCost(price, quality),
      effectiveUsd: effectiveCost(priceUsd, quality),
      status: score?.status || 'unknown',
      // 证据量与置信度：1 个样本的「健康」和 10 个样本的「健康」确定性差很多，
      // 界面必须能看出来，否则用户会以为 healthy 等于「已验证可靠」
      samples: (score?.samples || 0) + (score?.trafficSamples || 0),
      confidence: score?.confidence ?? null,
      // 冷却中（额度不足/限流/模型不在分组）：不是坏站，但此刻不派过去
      blocked: score?.blocked || null,
      // 冷却已到、但还没被证明恢复：同样不派，等下一次探测成功
      pendingRecovery: score?.pendingRecovery || null,
      availability: score?.availability ?? null,
      integrityFaults: score?.integrityFaults || [],
      allowUntrusted,
      statusReason: reasons.join(' · ') || null,
      ttftMs,
      // 外部监控上报的真实故障：只降级不拉黑（探针的准入判定不受影响），
      // 排序时同类靠后；自动路由不把它当「最优」，到期自动恢复
      faulted: typeof isFaulted === 'function' ? Boolean(isFaulted(offer)) : false,
    }
    row.admission = admissionOf(row)
    return row
  })

  const manualIndex =
    Array.isArray(order) && order.length > 0
      ? new Map(order.map((id, index) => [id, index]))
      : null

  return rows
    .filter((row) => row.provider && row.credential)
    .sort((a, b) => {
      // 手动顺序优先于一切：决策页整张表都能拖，用户摆的位置就是他要的顺序。
      // 这里刻意不再「可用性永远排前面」——那会让拖到前面的不可用行自己弹回去，
      // 看起来像坏了。安全由准入把关：网关只在 admission.ok 的候选里派活，
      // 把不会登场的行拖到第一位也只是摆在第一位，不会把流量引过去。
      if (manualIndex) {
        const ia = manualIndex.has(a.offer.id) ? manualIndex.get(a.offer.id) : Number.MAX_SAFE_INTEGER
        const ib = manualIndex.has(b.offer.id) ? manualIndex.get(b.offer.id) : Number.MAX_SAFE_INTEGER
        if (ia !== ib) return ia - ib
      }
      // 没手动调过（或两条都不在手动顺序里）：能优先考虑的在前，再按当前决策侧重排。
      // 比较逻辑收在 core/decision-mode.js#compareByBasis——看板结论句也用同一份。
      // 「能优先考虑的在前」这条只在自动排序里成立：手动顺序优先于一切（见上），
      // 否则把一条不可用的行拖到前面会自己弹回去，看起来像坏了。
      if (a.routable !== b.routable) return a.routable ? -1 : 1
      // 外部故障上报的行同类靠后（降级不拉黑：准入仍然只看 admissionOf）
      if (a.faulted !== b.faulted) return a.faulted ? 1 : -1
      return compareByBasis(a, b, decisionMode)
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
    // 能不能真的登场（网关只用 admission.ok 的候选）；
    // routable 是「优先考虑」，过期/未探测的 routable 为 false 但仍然能登场兜底
    admission: c.admission || null,
    // 全部状态标签（慢速 / 可疑 / 不稳定 / 冷却中…可以同时出现），决策页直接照着画
    tags: admissionTags(c),
    probeOk: c.probeOk,
    tooSlow: Boolean(c.tooSlow),
    // 外部监控上报的真实故障（故障转移标记，红色徽标）：
    // 探针看着再健康，监控报了故障就是真故障——先用起来，证据细情看 failover 字段
    faulted: Boolean(c.faulted),
    ttftMs: c.ttftMs,
    status: c.status,
    samples: c.samples,
    confidence: c.confidence,
    // 冷却中（额度不足/限流/模型不在分组）：决策页用它显示「额度不足 · 冷却中」，
    // 不然用户看到一条看着健康的站却没被选，会以为评分出错
    blocked: c.blocked ? { kind: c.blocked.kind, until: c.blocked.until } : null,
    // 冷却已到、等探测确认：决策页显示「限流中 · 等探测确认」，
    // 不然用户看到一条看着健康的站却没被选，会以为评分出错
    pendingRecovery: c.pendingRecovery ? { kind: c.pendingRecovery.kind, since: c.pendingRecovery.since } : null,
    statusReason: c.statusReason ?? null,
  }))
}
