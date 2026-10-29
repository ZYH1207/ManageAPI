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
import { describeUnavailable, isRealCooldown } from './failure.js'
import { isRoutable, effectiveCost, THRESHOLDS, MIN_SAMPLES_FOR_VERDICT } from './score.js'
import { normalizeModelKey, modelIdentityKey, balanceDepleted } from './inventory.js'
import { normalizeDecisionMode, compareByBasis } from './decision-mode.js'
import { siteUnitPrice } from './monitor.js'

const INFINITY_COST = Number.POSITIVE_INFINITY

/** scoreOffers 返回 Map，但也允许传普通对象，两种都兼容。 */
function getScore(scores, offerId) {
  if (!scores) return undefined
  return scores instanceof Map ? scores.get(offerId) : scores[offerId]
}

/**
 * 这一类状态的文案：原因 + 还要等多久 / 在等什么 + 该做什么。
 *
 *   pending=false —— 等待窗口内，等时间到
 *   pending=true  —— 窗口到了，等一次成功调用确认恢复
 *
 * 「冷却」只用在真正的账号冷却（限流）上：余额不足写成「冷却 30 分钟」会把
 * 账单问题伪装成上游在排队，用户不知道该去充值。
 */
function blockedText(reason, { pending = false } = {}) {
  const { label, hint } = describeUnavailable(reason?.kind)
  const kind = reason?.kind
  if (pending) return `${label}：已到点，等一次成功调用确认恢复（${hint}）`
  const minutes = Math.max(1, Math.ceil((Number(reason?.until) - Date.now()) / 60000))
  if (isRealCooldown(kind)) return `${label}：还剩 ${minutes} 分钟（${hint}）`
  return `${label}：${minutes} 分钟后自动重试（${hint}）`
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
  // 临时改道：这家的工具调用最近被上游吞掉，网关把它挂起、流量走别家。
  // 不是「坏站」，是「先别用它」——复检连续正常后会自动解除（见 empty-guard）
  if (row.detour) {
    const to = row.detour.replacedByProviderName
    return {
      ok: false,
      kind: 'detoured',
      text: `临时改道中${to ? `：当前走 ${to}` : ''}（原站每 20 分钟复检，正常了自动切回）`,
    }
  }
  // 余额探底：站点卡已经读到没钱了，不再让真实请求去撞 403。
  // 与慢速同款待遇：留在候选表里挂红标，准入拒之门外；充值并刷新余额后自动回场
  if (row.balanceDepleted) {
    return {
      ok: false,
      kind: 'depleted',
      text: '余额不足：整站已离场（不派活、不探测、不撞 403），充值并刷新余额后自动回场',
    }
  }
  // 慢速：这是用户自己设的线，不因「放行可疑供给」而失效
  if (row.tooSlow) {
    return { ok: false, kind: 'slow', text: `慢速：首字 ${row.ttftMs}ms 超过门槛` }
  }
  // 欠费：站内余额 ≤ 0，请求必然被拒。证据来自站点余额读数（持久化数据），
  // 探针测都不用测；不受「放行可疑供给」影响——那个开关是「结果可疑也愿意试」，
  // 欠费是「一定不行」。充值后自动恢复（每次请求都重新读阈值，没有冷却账要清）
  if (row.balanceDepleted) {
    return { ok: false, kind: 'depleted', text: '余额不足：站点已欠费，充值后自动恢复' }
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
    if (samples === 0 || row.status === 'stale' || row.billingOnly) {
      // 放行：没探过 / 证据过期 / 纯账单问题（充值后重试本身就是证据）
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
  // 临时改道：空回合守卫把它挂起了（和「坏站」是两件事，单独一个标签）
  if (row.detour) tags.push('detoured')
  // 余额探底：整站离场但留在表里挂红标（与慢速同款，不是从数据口删掉）
  if (row.balanceDepleted) tags.push('depleted')
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
    // 有样本、可用率却没有分母：探针全被限流/模型缺失挡住（真没证据）。
    // 纯账单问题不算「没证据」——那是钱包问题，准入会放行，标「待验证」就好
    tags.push(row.billingOnly ? 'unverified' : 'no-evidence')
  }
  // 冷却中 / 待复测：不是「坏」，但此刻派过去只会失败。
  // 余额不足单独给一个标签：那是账单问题，要人去充值，跟「上游在排队」不是一回事
  if (row.blocked) tags.push(row.blocked.kind === 'quota' ? 'billing' : 'blocked')
  else if (row.pendingRecovery) {
    tags.push(row.pendingRecovery.kind === 'quota' ? 'billing' : 'awaiting-recovery')
  }
  // 余额（持久化读数）：欠费挡准入，预警只提醒。两条互斥，欠费优先
  if (row.balanceDepleted) tags.push('balance-empty')
  else if (row.balanceWarn) tags.push('balance-warn')
  // 空回复：近 1 小时发生过空回合（含补全救回来的）。只给人看，不影响准入——
  // 救得回来是「烦」，不是「不可用」；真正触发改道的门槛在 empty-guard.js
  if (Number(row.emptyRecent) > 0) tags.push('empty-reply')
  // 没有任何毛病时才谈「靠什么撑着」——否则「兜底」会盖住真正的问题
  if (tags.length === 0 && (row.status === 'stale' || row.status === 'unknown')) tags.push('fallback')
  if (tags.length === 0) tags.push('ok')
  return tags
}

/**
 * 慢速判定唯一口径（决策/网关、比价页、探针页三处共用）：门槛开着 + 有实测首字 + 超线。
 * 评分过期（stale）时首字是旧证据，不作数——首字列都不显示它了，
 * 准入再拿它判「慢速」就是自相矛盾；真实调用本身就是刷新证据，到时候再判。
 */
export function isTooSlow(score, maxTtftMs) {
  if (!(Number(maxTtftMs) > 0)) return false
  if (!score || score.stale) return false
  return typeof score.ttftMs === 'number' && score.ttftMs > maxTtftMs
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
/**
 * 绝境兜底：准入没过、但「能用」的候选。
 *
 * 为什么需要：准入误判的代价自相矛盾——把慢站当真坏站挡在门外，看上去很安全，
 * 实际上会让整条供给链变成单点。2026-10-28 实测：某模型 7 条供给只剩 1 条
 * 准入（其余全被「慢速/不稳定/指纹不符」挡死），那一条一挂就整单失败。
 * 用户宁可多等 10 秒，也不想看到报错。
 *
 * 资格条件刻意严：
 *   只收 kind='slow'   —— 慢是「体验差」，不是「不能用」；降智/指纹不符/不稳定
 *                       是「不能用」，一律不兜底（给错结果比不给更糟）
 *   quality ≥ 0.8      —— 真实成功率得过得去（可用率×完整性）
 *   不在冷却/不待恢复  —— 刚被上游明确拒过的，再试只是白等一个来回
 *   不在改道/不故障   —— 那是守卫和外部上报已经认定「先别用」的
 *
 * 兜底候选只追加在准入候选**后面**：前面的都失败了才会轮到它。
 */
export const LAST_RESORT_MIN_QUALITY = 0.8

export function isLastResortCandidate(row) {
  if (!row) return false
  if (row.detour || row.faulted) return false
  if (row.blocked || row.pendingRecovery) return false
  if (row.admission?.ok) return false
  if (row.admission?.kind !== 'slow') return false
  const quality = Number(row.quality)
  return Number.isFinite(quality) && quality >= LAST_RESORT_MIN_QUALITY
}

/**
 * 人工勾选（决策页点选）某条供给：它就是「当前选」，与排序无关（页面顺序不动）。
 *
 * 收在一处是为了让「勾选了谁」只有一个真源——决策页的「当前选」与网关的
 * 首选尝试吃同一份。勾选的牌只要还在候选里（没被暂停/删掉）就顶到最前，
 * 哪怕准入没放行：这是人的明确指定，探针准入管的是自动选择，管不住人手点的；
 * 真发出去失败了照样沿候选链往后故障转移。
 * 返回新数组（勾选的在前），pinned 为实际生效的勾选候选（没勾/勾的不在候选里 → null）。
 */
export function applyPinnedChoice(candidates = [], pinnedOfferId = null) {
  if (!pinnedOfferId) return { candidates, pinned: null }
  const index = candidates.findIndex((c) => c.offer.id === pinnedOfferId)
  if (index < 0) return { candidates, pinned: null }
  const pinned = candidates[index]
  return {
    candidates: [pinned, ...candidates.slice(0, index), ...candidates.slice(index + 1)],
    pinned,
  }
}

/**
 * 一次请求的候选链：准入的在前，绝境兜底的在后。
 *
 * 收在一处是为了让「谁会被试到、按什么顺序」只有一个真源——网关与诊断
 * 解释「为什么派给了这个站」时用的是同一份顺序。
 */
export function candidateChain(candidates = []) {
  const admitted = candidates.filter((c) => c.admission?.ok)
  const lastResort = candidates.filter(isLastResortCandidate)
  return {
    admitted,
    lastResort: lastResort.map((c) => ({ ...c, lastResort: true })),
  }
}

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
  // 最后一句必须是「我能做什么」。只报原因不给出路，用户照样看不懂
  const kinds = new Set(candidates.map((c) => c.admission?.kind).filter(Boolean))
  const advice = kinds.has('depleted')
    ? '有站点余额探底已离场：去充值后点「刷新余额」就回来，或看剩下来的供给'
    : kinds.has('blocked')
      ? '按括号里的提示处理（充值 / 等冷却 / 换分组），或到「智能决策」页换一条供给'
      : kinds.has('degraded') || kinds.has('unstable')
        ? '这些供给结果不可信或不稳：去「探针」页复测一次，或换一条供给'
        : kinds.has('no-evidence')
          ? '这些供给没有可用样本：在「探针」页手动探一次就有结论'
          : '到「智能决策」页看全部候选和原因'
  return {
    status: 400,
    type: 'no_available_supply',
    detail,
    message: `没有可用的 ${model}：${detail}。${advice}`,
  }
}

/**
 * @param {{offers, providers, credentials, scores, benchmarks, settings, model, order?, isFaulted?}} input
 *   order —— 用户手动调过的 offerId 顺序；整张表都参与（包括暂时不会登场的），
 *            但能不能真的登场仍由 admissionOf 判定——排在前面只是位置，不是通行证
 *   isFaulted —— 可选谓词（core/failover.js#faultMatcher）：外部监控上报的真实故障。
 *            降级不拉黑：故障转移不是准入判定，探针说健康就照样 admission.ok，
 *            只是同类里靠后 + 自动路由不把它当「最优」；故障到期自动恢复
 *   emptyRecent —— 可选 Map<offerId, n>：近 1 小时空回合次数。只供展示徽章（空回复），
 *            不参与准入与路由
 * @returns {Array<{offer,provider,credential,price,quality,routable,effective,status,ttftMs,realTtftMs,realTtftSamples}>}
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
  // 外部监控上报的真实故障（core/failover.js#faultMatcher）：降级不拉黑
  isFaulted,
  // 空回合守卫的临时改道账（core/empty-guard.js#activeDetours）：
  // 和 isFaulted 是两件事——那是「别的进程报上来的故障」，这是「这套网关自己
  // 抓到的、并且已经动手改过道的」。两个都要认，见下面 row 的注释
  detours,
  // 「空回复」展示徽章的数据（近 1 小时空回合次数）：只画徽章，不参与判定
  emptyRecent = null,
}) {
  const key = normalizeModelKey(model)
  // 身份键：deepseek-4.1-flash 与 deepseek-v4.1-flash 是同一个模型。
  // 少了这一步，客户端把模型名缩写成站点的另一种写法就直接找不到供给——
  // 「网关里它被识别成两个模型」正是这么来的
  const aliases = settings?.modelAliases || null
  const identity = modelIdentityKey(model, aliases)
  const maxTtftMs = Number(settings?.maxTtftMs) || 0
  // 用户开关：探针说可疑的也让它正常参与排序（首字上限仍然独立生效）
  const allowUntrusted = Boolean(settings?.allowUntrusted)
  // 排序侧重：只影响「能登场的里面谁排前面」，准入判定完全不受它影响
  const decisionMode = normalizeDecisionMode(settings?.decisionMode)
  const matched = offers.filter(
    (offer) =>
      offer.modelKey === key ||
      offer.upstreamName === model ||
      normalizeModelKey(offer.upstreamName) === key ||
      (identity && modelIdentityKey(offer.upstreamName, aliases) === identity),
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
    // 站点余额（持久化数据，不需要探针）：quotaRemaining 是站内额度单位，
    // 与 balanceWarnUsd 阈值（0=关闭）直接比。欠费是「一定会拒单」的事实，
    // 探针测都不用测，余额读数自己会说话；预警只提醒不拦人。
    // null/空串是「没填」，绝不能当 0——Number(null)===0 会把所有没读过余额
    // 的站误判成欠费
    const rawQuota = provider.quotaRemaining
    const quotaRemaining =
      rawQuota === null || rawQuota === undefined || rawQuota === '' ? null : Number(rawQuota)
    const hasBalanceReading = quotaRemaining !== null && Number.isFinite(quotaRemaining)
    const warnThreshold = Number(settings?.balanceWarnUsd)
    // 注意别用 balanceDepleted 当变量名：它是 inventory.js 导进来的函数
    // （main 线的「余额探底整站离场」要在下面调用），同名会把函数遮蔽掉
    const depleted = balanceDepleted(provider)
    const balanceDepletedFlag = hasBalanceReading && quotaRemaining <= 0
    // 阈值是真实人民币，余额是站内额度——乘站点单价再比（¥7=1 单位的站不折算会误报）
    const balanceWarn =
      hasBalanceReading &&
      !balanceDepletedFlag &&
      warnThreshold > 0 &&
      quotaRemaining * siteUnitPrice(provider, settings) <= warnThreshold
    // 两个价格口径，分工写在定价模块里：比较一律按美元（pricing.js 的声明），
    // 所以排序和有效成本用 priceUsd；price 字段是给前端展示的人民币值，
    // 由前端 priceText 按显示币种换算——此前排序直接拿 CNY 值，排序结果虽
    // 不受影响（汇率对全部候选是同一标量），但和声明的口径自相矛盾。
    const priceUsd = cost.blendedUsdPerMtok
    const price = cost.blendedCnyPerMtok
    const ttftMs = score?.ttftMs ?? null
    // 真实流量首字：和探针首字**并列**，绝不混算（见 core/score.js#realTtftOf）。
    // 决策页首字列优先显示真实值，探针值退到悬浮提示里标「探针口径」。
    const realTtftMs = score?.realTtftMs ?? null
    const realTtftSamples = score?.realTtftSamples ?? 0
    // 太慢的直接排除，但仍保留在候选列表里——决策日志要能看出「为什么没选它」。
    // 口径在 isTooSlow：评分过期不算慢（首字是旧证据）
    const tooSlow = isTooSlow(score, maxTtftMs)
    // 余额探底：整站离场（准入拒、不参选、不探测），但留在表里挂红标

    // 把「为什么不可用」拆成人话，决策页直接显示。
    // 注意口径：fingerprint/truncation/billingRate 都是「正常比例」（未截断/未虚报），
    // 给用户看的要换算成异常比例——此前直接把 80% 未截断显示成「截断 80%」，意思完全反了
    const reasons = []
    // 徽章已经写着「慢速」，理由只补数字：差多少、门槛多少
    if (tooSlow) reasons.push(`首字 ${ttftMs}ms > 门槛 ${maxTtftMs}ms`)
    // 余额探底：不是 403 冷却（那要等上游拒），是站点卡读出来的，提前离场
    if (depleted) reasons.push(`余额不足：只剩 ${provider.quotaRemaining}，整站离场`)
    // 冷却中 / 待复测：这是「刚才上游明确说不行」，必须让人看得出为什么没派它
    if (score?.blocked) reasons.push(blockedText(score.blocked))
    else if (score?.pendingRecovery) reasons.push(blockedText(score.pendingRecovery, { pending: true }))
    // 余额（持久化读数）：欠费挡准入，预警只提醒
    if (balanceDepletedFlag) reasons.push(`余额不足：剩 ${quotaRemaining}`)
    else if (balanceWarn) reasons.push(`余额告警：剩 ${quotaRemaining}，低于预警阈值 ${warnThreshold}`)
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
      // 空回合守卫的改道账（生效中才有值）：准入与界面都读这一份，
      // 不允许另写一处「这个站现在能不能用」
      detour: detours?.get?.(offer.id) || null,
      price,
      // 名义单价（美元/百万 token）：价格档排序用，展示仍走 price（人民币）
      priceUsd,
      quality,
      // probeOk 是探针的原始判定；routable 是「这一单会不会优先考虑它」。
      // 余额探底同样沉底：准入已拒，routable 不该再给它「优先考虑」的资格
      probeOk: isRoutable(score),
      routable: (allowUntrusted || isRoutable(score)) && !tooSlow && !depleted,
      tooSlow,
      // 余额探底：admissionOf 据此硬拒并挂「余额不足」标签
      balanceDepleted: depleted,
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
      // 只有额度/预算类失败、没有任何真故障：不是「没证据」，是账单问题
      billingOnly: Boolean(score?.billingOnly),
      availability: score?.availability ?? null,
      integrityFaults: score?.integrityFaults || [],
      allowUntrusted,
      statusReason: reasons.join(' · ') || null,
      ttftMs,
      realTtftMs,
      realTtftSamples,
      realMsPerToken: score?.realMsPerToken ?? null,
      // 外部监控上报的真实故障：只降级不拉黑（探针的准入判定不受影响），
      // 排序时同类靠后；自动路由不把它当「最优」，到期自动恢复
      faulted: typeof isFaulted === 'function' ? Boolean(isFaulted(offer)) : false,
      // 余额（持久化读数）：欠费挡准入，预警只标黄。
      // 注意这里必须写显式值——合并时曾写成简写 `balanceDepleted,`，
      // 结果字段绑到了 import 进来的函数本身，准入一律判「整站离场」
      balanceDepleted: depleted,
      balanceWarn: Boolean(balanceWarn),
      // 近 1 小时空回合次数：只画「空回复」徽章，不参与判定
      emptyRecent: Number(emptyRecent?.get?.(offer.id)) || 0,
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

/**
 * 网关对外的模型清单：按**身份键**去重，客户端用这个名字请求即可。
 *
 * 用身份键而不是存储键：深站的 deepseek-4.1-flash 与别站的 deepseek-v4.1-flash
 * 是同一个模型，在 /v1/models 里应该是**一项**（providers 计 2）。
 * 两串都出现在下拉里，用户会以为有两个模型可选，选错了还以为换了个模型。
 */
export function listPublicModels({ offers, scores, settings }) {
  const aliases = settings?.modelAliases || null
  const seen = new Map()
  for (const offer of offers) {
    const id = modelIdentityKey(offer.upstreamName, aliases) || offer.modelKey || normalizeModelKey(offer.upstreamName)
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
    // 真实流量首字与样本数：决策页首字列按「真实优先、探针兑底」的规则显示
    realTtftMs: c.realTtftMs,
    realTtftSamples: c.realTtftSamples,
    realMsPerToken: c.realMsPerToken,
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
