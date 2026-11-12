/**
 * 账单索引：把 `db.ledger`（按天存的账单聚合行）压成「供给级」的价格查询表。
 *
 * ── 为什么需要这一层 ─────────────────────────────────────────────
 *
 * `db.ledger` 的形状是 providerId → day → rows，「同一供给的 7 天数据」散在 7 个地方。
 * 而上层（比价页、决策页）需要的是「这条供给现在多少钱」——一个数，不是 7 天流水。
 *
 * ── 跨天怎么合并（这里踩过坑，写清楚）──────────────────────────
 *
 * **不按 token 加权平均 `paidPerMtok`。**
 *
 * 实测证据（秋 / 国模-007 / deepseek-v4.1-flash，7 天，倍率恒 0.07、baseIn 恒 2，
 * 价格一天没变过）：
 *
 *   11-12 缓存 99% → paidPerMtok 0.0068
 *   11-06 缓存 43% → paidPerMtok 0.1116      ← 差 16 倍
 *
 * `paidPerMtok` = 实际花费 ÷ 全部 token，而 95% 的实际花费是缓存读（单价只有输入价的
 * 1/20）。所以它主要反映「这几天缓存命中率多少」，不是「这条线多少钱」。
 * 拿它排序等于按「谁的缓存多」排名——那是用法差异，不是价格差异。
 *
 * **而 `effIn/effOut`（= baseIn/baseOut × rate）不含缓存，是纯价格。**
 * 实测 20 条里 13 条跨天波动 <5%，波动的 7 条都是站方真调过价。
 *
 * 所以本模块的口径是：
 *   - **effIn / effOut**：取最后一个可信值，作为「这条线多少钱」的答案
 *   - **paidPerMtok**：只报出来给人看「我花了多少」，不参与任何排序
 *   - 两者都保留，因为回答的是不同问题
 *
 * ── 样本量门槛 ─────────────────────────────────────────────────
 *
 * 单天 200 token 的一单，算出来的单价噪音极大（一次缓存命中就能让它偏 10 倍）。
 * 所以设 `MIN_TOKENS`：低于它的记录不参与「价格」判定，但会标记 `thin: true`
 * 让上层能看出「这行数据薄」。
 */

/** 单天低于这个 token 量视为样本过薄，不采信其单价 */
export const MIN_TOKENS = 10000
/** 跨天合并时取多少天的窗口 */
export const DEFAULT_WINDOW_DAYS = 7
/** 视为「站方调过价」的波动阈值 */
export const PRICE_CHANGE_THRESHOLD = 0.15

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)

/**
 * 从一天的行里挑出可信的：(分组, 模型) → 一条记录。
 * 同一天同 (分组,模型) 理论上只有一行（aggregateLedgerItems 已经按这个键聚合），
 * 但这里仍然按 key 收，防止调用方传入未聚合的数据。
 */
function pickDay(day, rows, out) {
  for (const r of rows || []) {
    const model = String(r.model || '').trim()
    if (!model) continue
    const group = r.group ? String(r.group) : ''
    const key = `${group}::${model}`
    // 同一天出现两条取 token 大的那条（重复行通常一条是 0 流量残留）
    // 生图/按次计费的供给：token 单价对它没有意义（实测秋的 gpt-image 一次请求
    // 只跑 1000 来 token 却扣 0.05，算出 26~37/Mtok 这种荒谬单价，会直接污染排序）。
    // 这类行**不进价格索引**——它们的价格由站点页面的「按张价」决定，不是 token 价。
    const unit = r.billUnit || 'token'
    if (unit !== 'token') continue
    const prev = out.get(key)
    if (prev && (prev.totalTokens || 0) >= (r.totalTokens || 0)) continue
    out.set(key, { ...r, _day: day })
  }
}

/**
 * 建索引。
 *
 * @param {object} db 数据库（读 db.ledger）
 * @param {{windowDays?:number, minTokens?:number}} options
 * @returns {Map<string, object>} 键：`${providerId}|${group}|${model}`
 */
export function buildLedgerIndex(db, { windowDays = DEFAULT_WINDOW_DAYS, minTokens = MIN_TOKENS } = {}) {
  const index = new Map()
  const ledger = db?.ledger || {}

  for (const [providerId, days] of Object.entries(ledger)) {
    if (!days || typeof days !== 'object') continue
    const dayKeys = Object.keys(days).sort().slice(-windowDays)
    // 收集每个 (分组,模型) 的按天记录
    const perKey = new Map()
    for (const day of dayKeys) {
      const payload = days[day]
      if (!payload || !Array.isArray(payload.rows)) continue
      const dayRows = new Map()
      pickDay(day, payload.rows, dayRows)
      for (const [k, r] of dayRows) {
        if (!perKey.has(k)) perKey.set(k, [])
        perKey.get(k).push(r)
      }
    }

    for (const [k, list] of perKey) {
      list.sort((a, b) => String(a._day).localeCompare(String(b._day)))
      const [group, model] = k.split('::')

      // 只有达到样本门槛的记录才能当「价格」用
      const solid = list.filter((r) => (r.totalTokens || 0) >= minTokens)
      const pool = solid.length > 0 ? solid : list
      const thin = solid.length === 0

      // effIn/effOut 取最后一条可信值（不平均：异常波动会被平均掩盖，
      // 而「最后一次站方定的价」才是下次请求会遇到的价）
      const withEff = pool.filter((r) => r.effIn !== null && r.effIn !== undefined)
      const last = withEff.length > 0 ? withEff[withEff.length - 1] : null

      // 跨天波动：只在有多天数据时判定
      let priceChange = false
      let spreadPct = null
      if (withEff.length >= 2) {
        const vals = withEff.map((r) => Number(r.effIn))
        const mx = Math.max(...vals)
        const mn = Math.min(...vals)
        if (mn > 0) {
          spreadPct = Math.round(((mx - mn) / mn) * 1000) / 10
          priceChange = (mx - mn) / mn > PRICE_CHANGE_THRESHOLD
        }
      }

      // 汇总样本量（用于告诉用户「这个结论有多少证据」）
      const tokens = list.reduce((s, r) => s + (Number(r.totalTokens) || 0), 0)
      const requests = list.reduce((s, r) => s + (Number(r.requests) || 0), 0)

      // paidPerMtok：按 token 加权平均（这里加权是对的——加权平均「花费÷token」
      // 等于「总花费÷总token」，正是这个指标的定义）。但仍然**不用于排序**。
      const totalActual = list.reduce((s, r) => s + (Number(r.actualCost) || 0), 0)
      const totalTok = list.reduce((s, r) => s + (Number(r.totalTokens) || 0), 0)
      const paidPerMtok = totalTok > 0 ? Math.round((totalActual / totalTok) * 1e6 * 1e6) / 1e6 : null

      index.set(`${providerId}|${group}|${model}`, {
        providerId,
        group,
        model,
        // ---- 价格（可用于排序）----
        effIn: last ? num(last.effIn) : null,
        effOut: last ? num(last.effOut) : null,
        effCacheRead: last ? num(last.effCacheRead) : null,
        // ---- 实付（只展示，不排序）----
        paidPerMtok,
        totalActual: Math.round(totalActual * 1e6) / 1e6,
        // ---- 站点原始口径（当参考）----
        baseIn: last ? num(last.baseIn) : null,
        baseOut: last ? num(last.baseOut) : null,
        rate: last ? num(last.rate) : null,
        // ---- 证据 ----
        tokens,
        requests,
        days: list.length,
        lastDay: list[list.length - 1]?._day || null,
        thin,
        // 站方调过价：上层显示时要提醒「价格近期变过」
        priceChange,
        spreadPct,
      })
    }
  }
  return index
}

/**
 * 给定一条供给，取它的账单快照。键优先用 (分组,模型)，退化到 (空分组,模型)。
 *
 * @param {Map} index buildLedgerIndex 的输出
 * @param {{providerId:string, group?:string, upstreamName?:string, modelKey?:string}} offer
 */
export function ledgerForOffer(index, offer) {
  if (!index || !offer) return null
  const pid = offer.providerId
  if (!pid) return null
  const group = offer.group ? String(offer.group) : ''
  const names = [offer.upstreamName, offer.modelKey].filter(Boolean).map((s) => String(s))
  for (const name of names) {
    const hit = index.get(`${pid}|${group}|${name}`)
    if (hit) return hit
  }
  // 分组名对不上（站方改过名 / 台账没同步）：**不跨分组回落**。
  //
  // 2026-11-12 修：原来这里会「按模型找该站最便宜的那条」兜底，实测造成张冠李戴——
  // 台账里 `国模-0055 p哥` 的 deepseek 供给，因为该分组没账单，被兜底到了
  // `luna专线` 的账单（effIn 0.075），于是决策页拿着另一条线的心跳价去给这条线定价。
  //
  // 分组之间价格能差好几倍（同站对比实测 0.16 vs 2.69），跨分组借用不是「兜底」，
  // 是「编数据」。没账单就该老实说没账单，让上层回落到估算并标 source='benchmark'。
  return null
}
