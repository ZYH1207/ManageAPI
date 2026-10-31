/**
 * 余额守卫 —— 阈值自动切换，但绝不因此报错。
 *
 * ## 用户的需求（原话）
 *
 * 「余额不足的，余额少于阈值的自动切换。千万不要让前台客户端报错。」
 *
 * 这两句是有张力的：
 *   · 「低于阈值自动切换」→ 想提前避开快用完的站
 *   · 「绝不报错」→ 那如果所有站都低于阈值呢？
 *
 * 解法是**把「低于阈值」和「不能用」彻底分开**：
 *
 * | 状态 | 含义 | 行为 |
 * |---|---|---|
 * | `healthy` | 余额充足 | 正常候选，排前面 |
 * | `low` | 低于阈值 | **优先级下调**，但仍可用（有别的就先用别的） |
 * | `critical` | 极低（阈值的一小部分） | 只作最后兜底 |
 * | `empty` | 余额 <= 0 | 上游必然拒单，不参与（唯一的硬排除） |
 *
 * 关键：`low` 只是「排序靠后」，不是「不能用」。这样既满足了「自动切换」，
 * 又保证了「绝不报错」——没有更好的站时，它照样顶上去。
 *
 * ## 为什么阈值不写死
 *
 * 因为「余额」的单位各家不同：
 *   · 有的站是货币（¥ / $）
 *   · 有的站是「点数」（one-api 系的 quota，1 USD = 500000 点）
 *   · 有的是请求次数
 *
 * 所以阈值必须能表达成「还能撑多久」而不是「剩多少钱」。这里用两个信号：
 *   ① 绝对阈值（用户设的 balanceWarnUsd）—— 适合货币单位的站
 *   ② **相对消耗速度**（余额 ÷ 近期日消耗 = 还能撑几天）—— 单位无关，更可靠
 *
 * ② 是核心：余额 100 但每天烧 50（能撑 2 天）比余额 20 但每天烧 1（能撑 20 天）
 * 更应该被换掉。这比「比余额大小」准确得多。
 */

/** 余额状态。 */
export const BALANCE = {
  HEALTHY: 'healthy',
  LOW: 'low',
  CRITICAL: 'critical',
  EMPTY: 'empty',
  /** 从没读到过余额（很多站不开放余额接口） */
  UNKNOWN: 'unknown',
}

/** 状态对应的排序惩罚（加到速度/价格标量上的倍数）。越小越优先。 */
export const BALANCE_PENALTY = {
  [BALANCE.HEALTHY]: 1.0,
  [BALANCE.UNKNOWN]: 1.05,   // 不知道就稍微保守一点点，但几乎不影响
  [BALANCE.LOW]: 1.6,        // 明显下调优先级，让位给充足的站
  [BALANCE.CRITICAL]: 3.0,   // 只作最后兜底
  [BALANCE.EMPTY]: Infinity, // 硬排除
}

/**
 * 默认的「还剩几天」阈值。
 *
 * 为什么是这两个数：
 *   low:      还能撑 3 天 → 低于这个就开始让位（有时间去充值，不会用到一半断）
 *   critical: 还能撑 1 天 → 只作兜底（随时可能耗尽）
 *
 * 个人使用场景下，3 天足够你发现并处理；再长会让「均衡使用」变得没意义。
 */
export const DEFAULT_DAYS_THRESHOLD = { low: 3, critical: 1 }

/**
 * 计算一条供给的余额状态。
 *
 * @param {object} provider   站点记录（含 quotaRemaining）
 * @param {object} [opts]
 * @param {number} [opts.warnThreshold]   绝对阈值（settings.balanceWarnUsd，0=关闭）
 * @param {number} [opts.dailySpend]      该站近期日均消耗（同单位，null=不知道）
 * @param {number} [opts.unitPrice]       把 quota 单位换算成货币的系数（可选）
 * @param {{low:number, critical:number}} [opts.daysThreshold]
 * @returns {{
 *   state: string,
 *   quota: number|null,
 *   daysLeft: number|null,
 *   reason: string,
 *   penalty: number,
 * }}
 */
export function assessBalance(provider, {
  warnThreshold = 0,
  dailySpend = null,
  unitPrice = 1,
  daysThreshold = DEFAULT_DAYS_THRESHOLD,
} = {}) {
  const raw = provider?.quotaRemaining
  const quota = raw === null || raw === undefined ? null : Number(raw)

  // 读不到余额：不惩罚（大多数站本来就不开放）
  if (quota === null || !Number.isFinite(quota)) {
    return { state: BALANCE.UNKNOWN, quota: null, daysLeft: null, reason: '读不到余额', penalty: BALANCE_PENALTY[BALANCE.UNKNOWN] }
  }

  // 明确为 0：上游必拒，硬排除
  if (quota <= 0) {
    return { state: BALANCE.EMPTY, quota, daysLeft: 0, reason: '余额为 0，上游会拒单', penalty: Infinity }
  }

  // ① 相对判定：还能撑几天（单位无关，更可靠）
  const spend = Number(dailySpend)
  const hasSpend = Number.isFinite(spend) && spend > 0
  const daysLeft = hasSpend ? quota / spend : null

  if (daysLeft !== null) {
    if (daysLeft <= daysThreshold.critical) {
      return {
        state: BALANCE.CRITICAL, quota, daysLeft,
        reason: `按当前消耗只能撑 ${daysLeft.toFixed(1)} 天（低于 ${daysThreshold.critical} 天）`,
        penalty: BALANCE_PENALTY[BALANCE.CRITICAL],
      }
    }
    if (daysLeft <= daysThreshold.low) {
      return {
        state: BALANCE.LOW, quota, daysLeft,
        reason: `按当前消耗只能撑 ${daysLeft.toFixed(1)} 天（低于 ${daysThreshold.low} 天），优先让位`,
        penalty: BALANCE_PENALTY[BALANCE.LOW],
      }
    }
    return {
      state: BALANCE.HEALTHY, quota, daysLeft,
      reason: `按当前消耗能撑 ${daysLeft.toFixed(1)} 天`,
      penalty: BALANCE_PENALTY[BALANCE.HEALTHY],
    }
  }

  // ② 没有消耗速度数据 → 退回绝对阈值
  const threshold = Number(warnThreshold)
  const inMoney = quota * (Number.isFinite(unitPrice) && unitPrice > 0 ? unitPrice : 1)
  if (Number.isFinite(threshold) && threshold > 0 && inMoney <= threshold) {
    return {
      state: BALANCE.LOW, quota, daysLeft: null,
      reason: `余额 ${inMoney.toFixed(2)} 低于阈值 ${threshold}，优先让位`,
      penalty: BALANCE_PENALTY[BALANCE.LOW],
    }
  }

  return {
    state: BALANCE.HEALTHY, quota, daysLeft: null,
    reason: '余额充足（无消耗数据，按绝对阈值判定）',
    penalty: BALANCE_PENALTY[BALANCE.HEALTHY],
  }
}

/**
 * 从流量记录里算每个站点的日均消耗。
 *
 * 数据来源：`db.offerStats` 的逐小时桶（每桶有 estimatedCost 或 tokens）。
 * 只统计最近 N 天，避免用很久以前的消耗速率误导判断。
 *
 * @param {object} offerStats  db.offerStats
 * @param {Array<object>} offers  db.offers（用来把 offerId 映射到 providerId）
 * @param {object} [opts]
 * @param {number} [opts.days=7]   统计窗口
 * @param {number} [opts.now]
 * @returns {Map<string, number>}  providerId → 日均消耗（与 quotaRemaining 同单位时才有意义）
 */
export function dailySpendByProvider(offerStats = {}, offers = [], { days = 7, now = Date.now() } = {}) {
  const providerOf = new Map()
  for (const o of offers) {
    if (o?.id && o?.providerId) providerOf.set(o.id, o.providerId)
  }

  const cutoffHour = new Date(now - days * 86400_000).toISOString().slice(0, 13)
  const spendByProvider = new Map()

  for (const [key, bucket] of Object.entries(offerStats ?? {})) {
    const sep = key.lastIndexOf('|')
    if (sep < 0) continue
    const offerId = key.slice(0, sep)
    const hour = key.slice(sep + 1)
    if (hour < cutoffHour) continue

    const providerId = providerOf.get(offerId)
    if (!providerId) continue

    // 用「花费」优先；没有花费就用 token 数（单位不同但相对可比）
    const cost = Number(bucket?.estCostSum)
    const requests = Number(bucket?.requests) || 0
    const value = Number.isFinite(cost) && cost > 0 ? cost : requests
    if (!value) continue

    spendByProvider.set(providerId, (spendByProvider.get(providerId) || 0) + value)
  }

  // 转成日均
  const out = new Map()
  for (const [providerId, total] of spendByProvider) {
    out.set(providerId, total / days)
  }
  return out
}

/**
 * 给站点列表算余额评估表（面板展示 + 路由排序共用）。
 *
 * @param {Array<object>} providers
 * @param {object} [opts]  透传给 assessBalance，外加：
 * @param {Map<string,number>} [opts.dailySpendMap]
 * @returns {Map<string, ReturnType<typeof assessBalance>>}
 */
export function assessAllBalances(providers = [], { dailySpendMap = new Map(), ...opts } = {}) {
  const out = new Map()
  for (const p of providers) {
    if (!p?.id) continue
    out.set(p.id, assessBalance(p, {
      ...opts,
      dailySpend: dailySpendMap.get(p.id) ?? null,
    }))
  }
  return out
}

/** 面板用的一句话摘要。 */
export function balanceSummary(assessments = new Map()) {
  const counts = {}
  let worst = null
  for (const [providerId, a] of assessments) {
    counts[a.state] = (counts[a.state] || 0) + 1
    if (a.state === BALANCE.CRITICAL || a.state === BALANCE.LOW) {
      if (!worst || (a.daysLeft ?? Infinity) < (worst.daysLeft ?? Infinity)) {
        worst = { providerId, ...a }
      }
    }
  }
  return {
    counts,
    worst,
    text: Object.entries(counts).map(([k, n]) => `${k}×${n}`).join(' ') || '无数据',
  }
}
