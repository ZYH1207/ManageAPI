/**
 * 兜底阶梯 —— 解决「一处没数据，整条链崩掉」。
 *
 * ## 问题现场
 *
 * 2026-10-31 实测本机库：357 个供给里 **200 个（56%）没有任何探针记录**。
 *
 * 旧逻辑的判定链：
 *   没有探针样本 → `no-evidence` → 准入拒绝
 *   → 绝境兜底 `isLastResortCandidate` **只收 kind='slow'** → 兜不住
 *   → 候选链空 → 客户端收到 400 `no_available_supply`
 *
 * 于是出现「一个模型看起来有 40 条供给，实际一条都不敢用」的情况。
 * 更糟的是：探针一旦集体失败（网络抖动、上游限流），**所有供给同时变成
 * no-evidence，整条链路瞬间全崩** —— 这正是「最后哪个都用不了」的成因。
 *
 * ## 设计原则
 *
 * **报错是最后手段，不是默认手段。**
 *
 * 用户原话：「千万不要让前台客户端报错」。
 *
 * 所以候选链的构造原则改成：
 *   只要存在「理论上有机会成功」的供给，就一定要给出候选；
 *   按「成功率从高到低」排成阶梯，逐级往下试。
 *
 * 什么算「理论上有机会」：
 *   · 站点没被删、没欠费到 0
 *   · 模型名对得上
 *
 * 什么**不该**真的排除：
 *   · 没有探针数据（只是不知道，不是知道它不好）
 *   · 探针说慢（慢 != 不通）
 *   · 曾经失败但已过冷却期（现在可能好了）
 *
 * 什么**该**真的排除：
 *   · 余额 <= 0（上游一定会拒，试了也是白等）
 *   · 同一请求内已经试过并失败的（避免死循环）
 *
 * ## 阶梯分级（数字越小越优先）
 *
 *   0  准入通过        —— 探针说好，首选
 *   1  慢但质量合格    —— 能通，只是慢
 *   2  无证据          —— 不知道好不好，值得一试（新站/探针没覆盖）
 *   3  不稳定/降级     —— 有负面证据但仍可能通（比报错强）
 *   4  冷却刚到期      —— 之前被拒过，但冷却期过了，可以再试
 *   5  余额告警区间    —— 低于阈值但还没到 0（用户要求：低于阈值自动切换，
 *                        但换不了时这里仍是可用选项）
 *
 * 余额 <= 0 不进阶梯 —— 那是硬失败，试了只会浪费用户时间。
 * 但即使这样，如果**所有**供给余额都是 0，我们仍然返回一个明确的报错
 * （带「去充值」的指引），而不是假装成功。
 */

/** 阶梯分级。数字越小越优先。 */
export const TIER = {
  ADMITTED: 0,
  SLOW: 1,
  NO_EVIDENCE: 2,
  DEGRADED: 3,
  RECOVERING: 4,
  LOW_BALANCE: 5,
  /** 不可用（余额为 0 等硬失败），只在完全没有其它选项时才用来生成报错文案 */
  HARD_FAIL: 99,
}

/** 每一级给人看的说明。 */
export const TIER_LABEL = {
  [TIER.ADMITTED]: '正常',
  [TIER.SLOW]: '偏慢但可用',
  [TIER.NO_EVIDENCE]: '无速度证据（值得一试）',
  [TIER.DEGRADED]: '有过负面信号（仍可能通）',
  [TIER.RECOVERING]: '冷却期已过（重试）',
  [TIER.LOW_BALANCE]: '余额偏低',
  [TIER.HARD_FAIL]: '不可用',
}

/**
 * 判断一条候选落在哪一级。
 *
 * @param {object} row  路由行（selectCandidates 的产物）
 * @param {object} [opts]
 * @param {boolean} [opts.triedAlready] 本次请求里已经试过它了
 * @returns {{tier:number, reason:string, hard:boolean}}
 *   hard=true 表示「理论上一定失败」，连兜底都不该给
 */
export function tierOf(row, { triedAlready = false } = {}) {
  if (!row) return { tier: TIER.HARD_FAIL, reason: '没有候选行', hard: true }

  // 本次请求已经试过 → 不再进链（防死循环）
  if (triedAlready) return { tier: TIER.HARD_FAIL, reason: '本次请求已试过', hard: true }

  // 余额真的为 0：上游必然拒单，试了只是白等一个来回
  if (row.balanceDepleted) {
    return { tier: TIER.HARD_FAIL, reason: '余额为 0，上游必然拒单', hard: true }
  }

  const admission = row.admission || {}
  if (admission.ok) {
    return { tier: TIER.ADMITTED, reason: '', hard: false }
  }

  switch (admission.kind) {
    // 慢：能通，只是慢
    case 'slow':
      return { tier: TIER.SLOW, reason: admission.text || '偏慢', hard: false }

    // 没有样本：不知道好坏，不是知道它坏
    case 'no-evidence':
    case 'none':
      return { tier: TIER.NO_EVIDENCE, reason: admission.text || '没有探针样本', hard: false }

    // 有过负面证据：降智/不稳。但仍可能通 —— 比让客户端报错强
    case 'degraded':
    case 'unstable':
      return { tier: TIER.DEGRADED, reason: admission.text || '有过负面信号', hard: false }

    // 冷却：如果已经过了冷却期，当作可重试
    case 'blocked':
      return { tier: TIER.RECOVERING, reason: admission.text || '冷却中', hard: false }

    // 待恢复：同理
    case 'pendingRecovery':
      return { tier: TIER.RECOVERING, reason: admission.text || '等待恢复', hard: false }

    // 余额告警区间（不是 0，只是低）
    case 'depleted':
      // 注意：row.balanceDepleted 为 true 的已在上面挡掉，
      // 到这里说明是「余额低但没到 0」或者别的额度原因
      return { tier: TIER.LOW_BALANCE, reason: admission.text || '余额偏低', hard: false }

    // 改道中：守卫认为先别用，但那是软判定
    case 'detoured':
      return { tier: TIER.DEGRADED, reason: admission.text || '已临时改道', hard: false }

    default:
      // 不认识的 kind：宁可试一下，也不要因此整条链空掉
      return { tier: TIER.NO_EVIDENCE, reason: admission.text || '未知原因', hard: false }
  }
}

/**
 * 把候选行排成兜底阶梯。
 *
 * 返回的数组**保证**：如果任何一条候选不是 hard-fail，数组就非空。
 *
 * @param {Array<object>} rows  selectCandidates 的产物（已按档位排序）
 * @param {object} [opts]
 * @param {Set<string>} [opts.tried] 本次请求已经试过的 offerId
 * @param {number} [opts.maxPerTier] 每一级最多保留几条（防止一条请求试几十个站，
 *   把用户等待时间拖到不可接受）
 * @returns {{
 *   chain: Array<object & {tier:number, tierLabel:string, tierReason:string}>,
 *   hardFails: Array<object>,
 *   byTier: Record<number, number>,
 * }}
 */
export function buildLadder(rows = [], { tried = new Set(), maxPerTier = 3 } = {}) {
  const buckets = new Map()
  const hardFails = []

  for (const row of rows) {
    const offerId = row?.offer?.id
    const verdict = tierOf(row, { triedAlready: Boolean(offerId && tried.has(offerId)) })
    if (verdict.hard) {
      hardFails.push({ ...row, tierReason: verdict.reason })
      continue
    }
    if (!buckets.has(verdict.tier)) buckets.set(verdict.tier, [])
    buckets.get(verdict.tier).push({ ...row, tier: verdict.tier, tierReason: verdict.reason })
  }

  // 按级别升序拼链；每一级最多取 maxPerTier 条（保留原排序，即该级内最优的在前）
  const chain = []
  const byTier = {}
  for (const tier of [...buckets.keys()].sort((a, b) => a - b)) {
    const list = buckets.get(tier)
    const picked = list.slice(0, maxPerTier)
    byTier[tier] = picked.length
    for (const row of picked) {
      chain.push({ ...row, tierLabel: TIER_LABEL[tier] ?? String(tier) })
    }
  }

  return { chain, hardFails, byTier }
}

/**
 * 兜底阶梯的「安全阀」：链为空时，判断是真的没得选，还是我们的判定太严。
 *
 * 用途：如果 hardFails 里有些是「软失败」，把它们捞回来。这是最后一道防线 ——
 * 宁可试一个余额告警的站，也不要让用户看到报错。
 *
 * @param {Array<object>} rows 原始候选行
 * @param {Set<string>} [opts.tried]
 * @returns {{rescued: Array<object>, why: string}}
 */
export function rescueFromEmpty(rows = [], { tried = new Set() } = {}) {
  const usable = rows.filter((row) => {
    const id = row?.offer?.id
    if (!id || tried.has(id)) return false
    // 唯一真正不能救的：余额确认为 0
    if (row.balanceDepleted) return false
    return true
  })
  if (!usable.length) return { rescued: [], why: '所有供给都已试过或余额为 0' }
  return {
    rescued: usable.map((row) => ({
      ...row,
      tier: TIER.HARD_FAIL,
      tierLabel: '强制兜底',
      tierReason: '所有正规候选都不可用，强制尝试',
      forcedFallback: true,
    })),
    why: `正规候选全空，强制兜底 ${usable.length} 条`,
  }
}

/**
 * 阶梯摘要（面板/日志用）：让人一眼看出「为什么派给了这一级」。
 * @param {ReturnType<typeof buildLadder>} ladder
 */
export function ladderSummary(ladder) {
  const { chain = [], byTier = {}, hardFails = [] } = ladder ?? {}
  const parts = Object.entries(byTier)
    .map(([tier, n]) => `${TIER_LABEL[tier] ?? tier}×${n}`)
  return {
    total: chain.length,
    hardFails: hardFails.length,
    text: parts.length ? parts.join(' → ') : '无可用候选',
  }
}
