/**
 * 「重新开始累积」：把一条供给的负面证据清零，让它从干净状态重新记数。
 *
 * 为什么需要它（不只是「再加一个按钮」）：
 * 归因做错一次，代价是永久的。出口断了六分钟 → 316 次失败记成站点故障 →
 * 13 条供给 failRate=1、进 10 分钟冷却 → 冷却到期后「失败率仍超标」继续半开 →
 * 真实流量被挡在外面拿不到新证据，只能等探针一轮轮补。用户看到的就是
 * 「网早好了，这些站还是红的，而且红了好几个小时」。
 *
 * 归因修好之后，未来不会再产生这类假账；但**已经写进库里的**不会自己消失，
 * 所以要有这个出口。它刻意做成三件事：
 *
 *   1. 探针证据按「哪条算出口的账」清，不整批清。
 *      探针记录里混着两类完全不同的东西：
 *        · 网络类失败（EHOSTUNREACH / TLS 超时 / fetch failed）—— 出口断了就会有，
 *          不管站点好不好。这是要清的。
 *        · 生成层证据（指纹/截断/计费、HTTP 5xx）—— 那是站点自己的病。
 *          把它一起清掉等于替站洗白，绝不能顺手做。
 *      而且**只清网络类那几条**，不清整个探针历史：整批清空会让供给退回
 *      「没有可信样本」，准入直接拒它——为了解决假故障反而把好站下线。
 *      实现上仍然是「划界」：给条目打 `voidedBy: 'egress-reset'` 并记时间，
 *      记录留在库里，`voidedBy` 一删就全部恢复（可回滚）。
 *
 *   2. 只清「会让它被降权/被封」的几类，不清审计账。
 *      清：流量窗口计数（failRate / 冷却）、生效中的故障信号、生效中的故障上报、
 *          生效中的改道、界线之前的探针证据（靠标记忽略，不删）。
 *      不清：offerStats 小时桶、errorbook、routing、faultEvents。
 *      那些是「当时到底发生了什么」的账，删了就再也说不清这次事故。
 *      界面必须写清这个区别，否则用户会以为历史被篡改。
 *
 *   3. 支持 dryRun。动评分就是动派活，先让人看清单再落盘。
 */
import { activeDetours } from './empty-guard.js'
import { TRAFFIC_WINDOW_MS } from './inventory.js'
import { NETWORK_FAILURE } from './failure.js'

/**
 * 探针证据的回看范围：只作废最近 24 小时内的网络类失败。
 *
 * 为什么必须有这个上限：本机库里光是 EHOSTUNREACH 就跨了 11-03 到 11-14 十几天，
 * 一共几百条。一次「重新累积」把它们全作废，等于把过去十几天的真实网络事故
 * 一起抹掉——那不是修账，是毁账。而用户点这个按钮想解决的，永远是**刚才**
 * 那次故障留下的红标。
 *
 * 24 小时的取法：评分只认 6 小时内的探针（settings.scoreMaxAgeHours 默认 6），
 * 所以 24 小时已经覆盖了「还能影响派活」的全部范围，再往前留着当历史。
 */
export const RESET_LOOKBACK_MS = 24 * 60 * 60_000

/** 生效中的故障信号（空回合守卫写的那些） */
function activeSignalsOf(db, now) {
  return (db.faultSignals || []).filter(
    (s) => s && s.active !== false && (!s.expiresAt || Date.parse(s.expiresAt) > now),
  )
}

/** 生效中的故障上报（外部监控 / 网关自报的那些） */
function activeReportsOf(db, now) {
  return (db.failover?.reports || []).filter(
    (r) => r && r.status === 'active' && Number(r.until || 0) > now,
  )
}

/** 这一条供给背着多少「会挡路由」的负面状态。dryRun 清单直接用它生成。 */
export function negativeStateOf(db, offerId, now = Date.now()) {
  const row = db.traffic?.[offerId] || null
  // 流量计数只在窗口内才算数（与 core/score.js#freshTraffic 同一口径）。
  // 窗口早就过期的那份计数不参与评分，清它没有任何效果，只会把清单撑长、
  // 让人以为「要清 39 条」实际只有 3 条真的在挡路。
  const trafficFresh = row && Number.isFinite(Date.parse(row.since || ''))
    ? now - Date.parse(row.since) <= TRAFFIC_WINDOW_MS
    : false
  const traffic = row
    ? {
        ok: Number(row.ok) || 0,
        fail: Number(row.fail) || 0,
        // 我方缺陷本来就不进可用率，但一起显示，方便核对「这次清的是什么」
        localDefects: Number(row.localDefects) || 0,
        // 是否仍在统计窗口内：false 表示这份计数已经不影响评分了
        fresh: trafficFresh,
        kinds: Object.keys(row.kinds || {}),
        lastFailAt: row.lastFailAt || null,
        since: row.since || null,
      }
    : null
  const signals = activeSignalsOf(db, now).filter((s) => s?.scope?.offerId === offerId).length
  const reports = activeReportsOf(db, now).filter((r) => r?.offerId === offerId).length
  const detour = activeDetours(db).has(offerId)
  // 探针记录里「出口断网造成的」那几条：它们会被算进可用率分母，
  // 正是「网好了但供给还是红的」最主要的来源（探针证据保鲜 6 小时）。
  const resetAt = Date.parse(db.evidenceReset?.[offerId]?.at || '')
  const networkProbes = (db.probes || []).filter(
    (p) =>
      p?.offerId === offerId &&
      !p.voidedBy &&
      !(Number.isFinite(resetAt) && Date.parse(p.ts) > resetAt) &&
      // 只看最近 24 小时（见 RESET_LOOKBACK_MS）：更早的是历史事故，
      // 不该被一次「重新累积」顺手抹掉
      now - Date.parse(p.ts || '') <= RESET_LOOKBACK_MS &&
      p.ok === false &&
      NETWORK_FAILURE.test(String(p.error || '')),
  ).length
  return { offerId, traffic, signals, reports, detour, networkProbes }
}

/** 有一条负面状态就要清（用来筛选 dryRun 清单，口径与执行侧一致） */
function isDirty(state) {
  // 过期的流量计数不算「要清」：它不影响评分（见 negativeStateOf 的 trafficFresh）
  const liveTraffic = Boolean(state.traffic?.fresh && (state.traffic.fail || state.traffic.localDefects))
  return Boolean(liveTraffic || state.signals || state.reports || state.detour || state.networkProbes)
}

/**
 * 预览：不写盘，只列出会被清掉什么。
 * 与 resetNegativeEvidence 共用 negativeStateOf，避免「预览说 3 条、执行清 5 条」。
 */
export function previewReset(db, { offerIds = [], now = Date.now(), includeProbes = false } = {}) {
  const wanted = offerIds.filter(Boolean)
  // 没传 offerIds 时的范围，只看**可能背着负面状态**的那几条：
  //   · db.traffic 里有行的 → 可能有失败率/冷却
  //   · 最近 24 小时有网络类探针的 → 可能被那些失败拉低了可用率
  // 不能只取 db.traffic：一条供给可能流量窗口已经过期（行还在但 fresh=false），
  // 负面状态全在探针记录里——只按 traffic 筛会把它整条漏掉，用户点了「重新累积」
  // 却发现这条还是红的。也不能扫全部 781 条：绝大多数从没派过活，列进清单
  // 只会让人以为要清 39 条、实际只动 3 条。
  const scopeIds =
    wanted.length > 0
      ? wanted
      : [...new Set([
          ...Object.keys(db.traffic || {}),
          ...(db.probes || [])
            .filter(
              (p) =>
                p?.offerId &&
                !p.voidedBy &&
                p.ok === false &&
                now - Date.parse(p.ts || '') <= RESET_LOOKBACK_MS &&
                NETWORK_FAILURE.test(String(p.error || '')),
            )
            .map((p) => p.offerId),
        ])]
  const rows = scopeIds.map((id) => negativeStateOf(db, id, now))
  const dirty = rows.filter(isDirty)
  return {
    offers: scopeIds.length,
    affected: dirty.length,
    rows: dirty,
    // 明确告诉界面：这些账没动。includeProbes 时探针证据也动（划界），所以不列它。
    kept: [
      '站点侧探针证据（指纹/截断/计费、HTTP 5xx）',
      'offerStats（小时桶）',
      'errorbook（错误指纹）',
      'routing（决策日志）',
      'faultEvents（上报事件）',
    ],
  }
}

/**
 * 清零（就地改 db，调用方负责 mutate）。
 *
 * @param {object} db
 * @param {{offerIds?:string[], reason?:string, now?:number}} options
 *        offerIds 为空 = 作用于所有有过流量的供给
 * @returns {{at:string, offers:string[], cleared:object, kept:string[]}}
 */
export function resetNegativeEvidence(
  db,
  { offerIds = [], reason = 'manual', now = Date.now(), includeProbes = false } = {},
) {
  const at = new Date(now).toISOString()
  const wanted = new Set(offerIds.filter(Boolean))
  const inScope = (offerId) => wanted.size === 0 || wanted.has(offerId)
  const cleared = { traffic: 0, signals: 0, reports: 0, detours: 0, probes: 0 }

  // 1) 流量窗口：清零计数并把 since 推到此刻。
  //    localDefects 一起清——它和 ok/fail 同属一个窗口，留着会跟新计数混在
  //    一起，让诊断页显示「0 次请求里有 11 次我方缺陷」。
  if (db.traffic && typeof db.traffic === 'object') {
    for (const [offerId, row] of Object.entries(db.traffic)) {
      if (!inScope(offerId) || !row) continue
      // 与预览同一口径（isDirty）：过期的窗口不清，它本来就不参与评分
      if (!isDirty(negativeStateOf(db, offerId, now))) continue
      row.ok = 0
      row.fail = 0
      row.kinds = {}
      row.quality = { samples: 0, bad: 0 }
      row.localDefects = 0
      row.lastOkAt = null
      row.lastFailAt = null
      row.since = at
      cleared.traffic += 1
    }
  }

  // 2) 生效中的故障信号：标成 resolved，不删行（历史要看得出「它曾被判过故障」）
  for (const signal of db.faultSignals || []) {
    if (!signal || signal.active === false) continue
    if (!inScope(signal.scope?.offerId)) continue
    if (signal.expiresAt && Date.parse(signal.expiresAt) <= now) continue
    signal.active = false
    signal.resolvedAt = at
    signal.resolvedBy = reason
    cleared.signals += 1
  }

  // 3) 故障上报：同样只改状态
  for (const report of db.failover?.reports || []) {
    if (!report || report.status !== 'active') continue
    if (!inScope(report.offerId)) continue
    report.status = 'cleared'
    report.until = now
    report.clearedBy = reason
    report.clearedAt = at
    cleared.reports += 1
  }

  // 4) 改道：解除，让请求回到原本的供给
  for (const row of db.emptyDetour || []) {
    if (!row || row.resolvedAt) continue
    if (!inScope(row.offerId)) continue
    row.resolvedAt = at
    row.resolvedBy = reason
    cleared.detours += 1
  }

  // 5) 探针证据：只作废「网络类失败」那几条（见文件头第 1 条）。
  //    作废 = 打标记，不删记录；删掉标记就全部恢复。
  const offers = wanted.size > 0 ? [...wanted] : Object.keys(db.traffic || {})
  for (const probe of db.probes || []) {
    if (!probe || probe.voidedBy) continue
    if (!inScope(probe.offerId)) continue
    // 与预览同一口径：只动最近 24 小时（见 RESET_LOOKBACK_MS）。
    // 少了这一行，预览说「1 条」而执行作废 300 条——这是最坏的一类不一致。
    if (!(now - Date.parse(probe.ts || '') <= RESET_LOOKBACK_MS)) continue
    if (probe.ok !== false) continue
    if (!NETWORK_FAILURE.test(String(probe.error || ''))) continue
    probe.voidedBy = reason
    probe.voidedAt = at
    cleared.probes += 1
  }

  // 5b) 整批划界（显式要求才做）：连生成层证据一起忽略
  if (includeProbes) {
    if (!db.evidenceReset || typeof db.evidenceReset !== 'object') db.evidenceReset = {}
    for (const offerId of offers) {
      const old = db.evidenceReset[offerId]
      db.evidenceReset[offerId] = { at, reason, previousAt: old?.at || null }
    }
  }

  return {
    at,
    offers,
    cleared,
    kept: includeProbes
      ? ['offerStats（小时桶）', 'errorbook（错误指纹）', 'routing（决策日志）', 'faultEvents（上报事件）']
      : ['探针记录（指纹/截断/计费证据）', 'offerStats（小时桶）', 'errorbook（错误指纹）', 'routing（决策日志）', 'faultEvents（上报事件）'],
  }
}

/**
 * 评分侧的唯一口径：这条记录的 `ts` 是否在重置界线之后。
 *
 * 单独导出而不是各调用方自己比时间，是因为这条判断一旦漂移，
 * 「重置了但还显示红」会变成最难查的那类 bug（数据看着对、行为不对）。
 *
 * @param {{at?:string}|undefined|null} reset db.evidenceReset[offerId]
 * @param {string} iso 记录时间
 */
export function afterReset(reset, iso) {
  if (!reset?.at) return true
  const line = Date.parse(reset.at)
  const ts = Date.parse(iso)
  if (!Number.isFinite(line)) return true
  // 时间解析失败时保守放行（宁可少清一天，也不要凭一个坏时间戳吞掉证据）
  if (!Number.isFinite(ts)) return true
  return ts >= line
}
