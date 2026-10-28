/**
 * 空回合守卫：「上游这一轮到底说话了没有」，以及该不该自动再问一遍。
 *
 * 病因（2026-10-28 实测）：换中转站之后，DeepSeek / GLM 这类模型的工具调用在
 * 上游翻译层被吞掉——流里只剩思考增量，正文和 tool_calls 一个都没有，收尾却是
 * 正常的 stop。客户端拿到的是一条「已成功、但没有内容」的回合，只能安静地停下；
 * 用户看到的就是「跑着跑着自己就断了、也不汇报」。
 *
 * 两种病型：
 *   no-content         纯空：正文、思考、工具调用全都没有
 *   tool-call-dropped  客户端带了 tools，这一轮却既不说话也不调工具（本次的真凶）
 *
 * 判定只看「客户端真正拿到了什么」：正文 0 字、工具调用 0 个，这一轮就等于没发生。
 * 思考不算数——思考是模型的内心话，用户拿不到任何能执行的东西。这一点和
 * quality-signals 里的「空回答」刻意不同：那边把思考算作有内容（用于判断站点
 * 是否在偷工减料），这边要判的是「这一轮还能不能接着干下去」。
 *
 * 这个模块只做判定与记录的口径，不做任何 IO——网关怎么重试在 daemon/server.js，
 * 界面怎么展示在 web/app.js。
 */

/** 病型 → 给人看的一句话。前端直接照着显示，不再各写一套文案 */
export const EMPTY_REASON_LABEL = {
  'no-content': '上游返回了空回合：没有正文，也没有工具调用',
  'tool-call-dropped': '上游把工具调用弄丢了：带了 tools，却既不说话也不调工具',
}

/** 处置结果 → 给人看的一句话 */
export const EMPTY_ACTION_LABEL = {
  'repaired-local': '本地解析重建（不用问模型）',
  'repair-failed': '认出了标记但解析不出，转补问',
  off: '守卫关闭，只记录未处置',
  'retry-same': '同站补问一次',
  'retry-switch': '换一家补问一次',
  'no-retry': '没有可换的站点，直接放行',
  'gave-up': '补问后仍然空，放行（并记为站点失败）',
}

/** 守卫配置归一化：非法值回落默认，绝不让拼错的值悄悄变成「开着」 */
export function normalizeEmptyGuard(raw) {
  const mode = raw?.mode === 'switch' ? 'switch' : 'same'
  return { enabled: Boolean(raw?.enabled), mode }
}

/** 一次尝试里「客户端实际收到什么」的最小事实集 */
export function emptyFacts({ textChars = 0, hasToolCalls = false, finishReason = null, requestHasTools = false } = {}) {
  return {
    textChars: Math.max(0, Number(textChars) || 0),
    hasToolCalls: Boolean(hasToolCalls),
    finishReason: finishReason ?? null,
    requestHasTools: Boolean(requestHasTools),
  }
}

/**
 * 判定这一轮算不算「空回合」。
 *
 * 只认 finishReason 为 stop / null 的收尾：
 *   length    —— 是被截断，属于另一个病（截断），补问一遍只会再被截断
 *   tool_calls—— 有工具调用，这一轮干了活，不是空
 *   其它错误  —— 报错有自己的处置路径，不该伪装成空回合
 *
 * @returns {{empty: boolean, reason: string|null}}
 */
export function judgeEmptyTurn(facts = {}) {
  const { textChars, hasToolCalls, finishReason, requestHasTools } = emptyFacts(facts)
  if (hasToolCalls) return { empty: false, reason: null }
  if (textChars > 0) return { empty: false, reason: null }
  if (finishReason && finishReason !== 'stop') return { empty: false, reason: null }
  // 客户端没要工具时，模型只回一句话就结束是合法的（比如纯问答里它决定不再说了）；
  // 但一个字都没有仍然不正常——那本来就是老口径里的「空回答」
  return { empty: true, reason: requestHasTools ? 'tool-call-dropped' : 'no-content' }
}

/** 记录条目的字段收敛在一处：写入口径和界面读的口径不允许各写一份 */
export function buildEmptyEvent({
  model = '',
  protocol = 'chat',
  stream = true,
  facts = {},
  providerId = null,
  providerName = '',
  offerId = null,
  group = '',
  action = 'off',
  note = '',
  recovered = false,
  recoveredBy = '',
  attempts = 1,
  wastedMs = null,
  usage = null,
} = {}) {
  const { textChars, hasToolCalls, finishReason, requestHasTools } = emptyFacts(facts)
  return {
    ts: new Date().toISOString(),
    model: String(model || ''),
    protocol: String(protocol || 'chat'),
    stream: Boolean(stream),
    reason: judgeEmptyTurn(facts).reason || 'no-content',
    requestHasTools,
    textChars,
    hasToolCalls,
    finishReason,
    providerId,
    providerName: String(providerName || ''),
    offerId,
    group: String(group || ''),
    action,
    // 附注：本地重建失败时要写清为什么（unknown-format / name-not-allowed / bad-args）
    note: String(note || ''),
    recovered: Boolean(recovered),
    recoveredBy: String(recoveredBy || ''),
    attempts: Math.max(1, Number(attempts) || 1),
    wastedMs: wastedMs === null || wastedMs === undefined ? null : Math.max(0, Number(wastedMs) || 0),
    // 第一次尝试烧掉的 token：这部分钱是真花出去了，客户端那边却什么都没拿到
    wastedInput: Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0,
    wastedOutput: Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0,
  }
}

/** 封顶：这是诊断记录，不是账单，留下最近这些足够回看 */
export const MAX_EMPTY_EVENTS = 300

/** 幂等：db 里没有这个键就补上 */
export function ensureEmptyEvents(db) {
  if (!Array.isArray(db.emptyTurns)) db.emptyTurns = []
  return db
}

export function recordEmptyEvent(db, event) {
  ensureEmptyEvents(db)
  db.emptyTurns.push(event)
  if (db.emptyTurns.length > MAX_EMPTY_EVENTS) {
    db.emptyTurns = db.emptyTurns.slice(-MAX_EMPTY_EVENTS)
  }
  return event
}

export function clearEmptyEvents(db) {
  ensureEmptyEvents(db)
  const removed = db.emptyTurns.length
  db.emptyTurns = []
  return removed
}

/** 概览数字：一共撞了多少次、其中补问救回来几次、白烧了多少 token */
export function summarizeEmptyEvents(events = []) {
  const list = Array.isArray(events) ? events : []
  const summary = {
    total: list.length,
    toolCallDropped: 0,
    noContent: 0,
    recovered: 0,
    gaveUp: 0,
    off: 0,
    wastedInput: 0,
    wastedOutput: 0,
    lastAt: null,
  }
  for (const event of list) {
    if (event.reason === 'tool-call-dropped') summary.toolCallDropped += 1
    else summary.noContent += 1
    if (event.recovered) summary.recovered += 1
    if (event.action === 'gave-up') summary.gaveUp += 1
    if (event.action === 'off') summary.off += 1
    summary.wastedInput += Number(event.wastedInput) || 0
    summary.wastedOutput += Number(event.wastedOutput) || 0
    if (event.ts && (!summary.lastAt || event.ts > summary.lastAt)) summary.lastAt = event.ts
  }
  return summary
}

// ------------------------------------------------------------ 补问成本档位

/**
 * 补问档位：预计补问越贵，补问次数越少。
 *
 * 为什么不做成固定次数：一次补问的代价不是常数。同一句话在 2 万 token 的上下文
 * 里可能 5 秒回来，在 20 万 token 的上下文里要一分钟。固定「补 2 次」在后一种
 * 情况下等于白等两分钟，用户宁可早点知道「这轮废了」。
 *
 * 判定依据是**这一轮自己的表现**：这次思考了多久、吐了多少字，乘以该站实测速度，
 * 就是「再来一遍」的预计耗时。上下文规模的影响（更大 → 首字更慢、思考更长）
 * 自动包含在里面，不需要单独去数 token。
 *
 * waitMs 是「多久还没见到正文就放弃」的上限，不是整轮超时——只要开始出正文，
 * 就该让它说完。
 */
export const RETRY_TIERS = [
  { key: 'fast', maxMs: 5_000, retries: 2, waitMs: 30_000, label: '很快（≤5 秒）' },
  { key: 'normal', maxMs: 15_000, retries: 1, waitMs: 40_000, label: '一般（5~15 秒）' },
  { key: 'slow', maxMs: 40_000, retries: 1, waitMs: 60_000, label: '偏慢（15~40 秒）' },
  { key: 'costly', maxMs: Infinity, retries: 0, waitMs: 0, label: '太贵（>40 秒）' },
]

/** 字符 → token 的粗估。中英混排取 2.5 字/token；只用于估算耗时，不求精确 */
function charsToTokens(chars) {
  return Math.ceil(Math.max(0, Number(chars) || 0) / 2.5)
}

/**
 * 估算「再问一遍要多久」。
 *
 * @param {object} input
 *   reasoningChars / textChars —— 这一轮失败尝试里模型实际想了多少、说了多少
 *   ttftMs                     —— 该站该模型的首字延迟（没有就给全局兜底）
 *   tps                        —— 该站该模型的实测生成速度（tok/s）
 * @returns {{estimatedMs:number, outputTokens:number, tps:number|null, ttftMs:number}}
 */
export function estimateRetryCost({ reasoningChars = 0, textChars = 0, ttftMs = null, tps = null } = {}) {
  // 模型想多少，下一遍大概还想那么多——下限 120 是给「一句话就结束」的回合留的余量
  const outputTokens = Math.max(120, charsToTokens((Number(reasoningChars) || 0) + (Number(textChars) || 0)))
  // 没有实测速度时按 40 tok/s 兜底（国内中转站的常见档位，宁可估慢一点）
  const speed = Number(tps) > 0 ? Number(tps) : 40
  const firstByte = Number(ttftMs) > 0 ? Number(ttftMs) : 1_500
  return {
    estimatedMs: Math.round(firstByte + (outputTokens / speed) * 1000),
    outputTokens,
    tps: Number(tps) > 0 ? Number(tps) : null,
    ttftMs: firstByte,
  }
}

/**
 * 给出这次的补问计划。
 *
 * staleProvider=true 表示「这个站最近已经空过几次了」：那就不要再用它，
 * 直接把次数让给换站（mode='switch' 时由调用方挑下一家）。
 */
export function planEmptyRetry({ estimatedMs = 0, staleProvider = false } = {}) {
  const tier = RETRY_TIERS.find((item) => estimatedMs <= item.maxMs) || RETRY_TIERS[RETRY_TIERS.length - 1]
  if (staleProvider) {
    return { ...tier, retries: 0, waitMs: 0, reason: 'stale-provider' }
  }
  return { ...tier, reason: 'tier' }
}

// ------------------------------------------------------------ 临时改道（换一家）

/** 改道复检节奏：平均 20 分钟摸一次原站，正常了就把流量切回去 */
export const DETOUR_RECHECK_MS = 20 * 60_000

/**
 * 改道（故障转移）的门槛：同一个站 + 同一个模型在这么长的窗口里，
 * 空回合累计空耗超过这么多毫秒，才认定「空回复已经严重影响生产效率」，
 * 值得把流量挪走。
 *
 * 为什么看时间不看次数：一次空回合的代价不是常数。大上下文里一次白等
 * 可能就是一分钟（还要再补问一遍，实际损失翻倍）；轻快的小请求空十次
 * 也就几十秒。按次数判定会「错杀耐心补全的小请求站、放过慢刀大上下文」。
 *
 * 口径：窗口内每次空回合的 wastedMs（那次失败尝试实际耗掉的时间）累加。
 * 刻意只记这确定性的一半——补问/重建的时长没有逐条落盘，不硬算；
 * 所以阈值按真实损失的一半定：这里 2 分钟，对应真实等待约 4 分钟/半小时。
 * 旧数据没有 wastedMs 的计 0（宁可少记，不编数）。
 */
export const EMPTY_DETOUR_WINDOW_MS = 30 * 60_000
export const EMPTY_DETOUR_WASTED_MS = 120_000

/**
 * 「空回复」展示徽章的窗口：窗口内发生过空回合（含补全救回来的）就在决策页
 * 标一个「空回复」，只给人看，不影响准入与路由——救得回来的空回合是「烦」，
 * 不是「不可用」。真正的处置门槛见上面 EMPTY_DETOUR_*。
 */
export const EMPTY_REPLY_BADGE_WINDOW_MS = 60 * 60_000

/** 复检连续正常几次才算「不波动了」，可以切回去 */
export const DETOUR_OK_STREAK = 2

/** 幂等：改道账是追加式历史，resolvedAt 有值表示已解除 */
export function ensureDetours(db) {
  if (!Array.isArray(db.emptyDetour)) db.emptyDetour = []
  return db
}

/** 当前生效的改道（按 offerId 索引）：路由和界面都用这一份，不各算一遍 */
export function activeDetours(db) {
  ensureDetours(db)
  const map = new Map()
  for (const row of db.emptyDetour) {
    if (row.resolvedAt) continue
    map.set(row.offerId, row)
  }
  return map
}

export function recordDetour(db, entry) {
  ensureDetours(db)
  // 同一 offer 已经有生效中的改道就更新它，不叠一条新的——否则一次故障期
  // 反复空回合会堆出一串「改道到 X」，界面和复检都要处理重复
  const existing = db.emptyDetour.find((row) => row.offerId === entry.offerId && !row.resolvedAt)
  if (existing) {
    Object.assign(existing, entry, { updatedAt: new Date().toISOString() })
    return existing
  }
  const row = {
    id: `ed_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    since: new Date().toISOString(),
    lastCheckAt: null,
    okStreak: 0,
    checkCount: 0,
    failCount: 0,
    resolvedAt: null,
    ...entry,
  }
  db.emptyDetour.push(row)
  // 只留最近 50 条历史：这是排查线索，不是账本
  if (db.emptyDetour.length > 50) db.emptyDetour = db.emptyDetour.slice(-50)
  return row
}

export function resolveDetour(db, offerId, { reason = 'recovered' } = {}) {
  ensureDetours(db)
  const row = db.emptyDetour.find((item) => item.offerId === offerId && !item.resolvedAt)
  if (!row) return null
  row.resolvedAt = new Date().toISOString()
  row.resolveReason = reason
  return row
}

/** 记一次复检结果：连续正常到 streak 就自动解除改道（由调用方决定何时真正切回） */
export function noteDetourCheck(db, offerId, { ok, at = new Date().toISOString() } = {}) {
  ensureDetours(db)
  const row = db.emptyDetour.find((item) => item.offerId === offerId && !item.resolvedAt)
  if (!row) return null
  row.lastCheckAt = at
  row.checkCount = (Number(row.checkCount) || 0) + 1
  if (ok) {
    row.okStreak = (Number(row.okStreak) || 0) + 1
  } else {
    row.okStreak = 0
    row.failCount = (Number(row.failCount) || 0) + 1
  }
  if (row.okStreak >= DETOUR_OK_STREAK) {
    row.resolvedAt = at
    row.resolveReason = 'recovered'
  }
  return row
}

/**
 * 近期空回合的累计空耗（毫秒）：改道门槛用的就是它（见 EMPTY_DETOUR_WASTED_MS）。
 * 每条事件只累加 wastedMs（那次失败尝试实际耗掉的时间），旧数据没有的计 0。
 */
export function emptyWastedMs(
  events,
  { providerId, model, now = Date.now(), windowMs = EMPTY_DETOUR_WINDOW_MS } = {},
) {
  const since = now - windowMs
  let total = 0
  for (const event of events || []) {
    if (event.providerId !== providerId) continue
    if (model && event.model && event.model !== model) continue
    const ts = Date.parse(event.ts || '')
    if (!Number.isFinite(ts) || ts < since) continue
    total += Math.max(0, Number(event.wastedMs) || 0)
  }
  return total
}

/** 相对差：两边都缺就是 0，只有一边有就按「差得最远」算 1 */
function relativeGap(a, b) {
  const x = Number.isFinite(a) ? a : null
  const y = Number.isFinite(b) ? b : null
  if (x === null && y === null) return 0
  if (x === null || y === null) return 1
  const denom = Math.max(Math.abs(x), Math.abs(y), 1e-9)
  return Math.min(1, Math.abs(x - y) / denom)
}

/**
 * 从「智能决策」判完之后还能登场的候选里，挑一个和当前这家最像的。
 *
 * 「最像」= 价格差 + 首字速度差，各归一化后对半加权：
 * 用户手里的任务已经按当前这家的脾气调好了，换一家最怕的是「忽然变贵」或
 * 「忽然变慢」，所以这两个维度等权，其它（质量、可用率）已经由 admissibility
 * 挡过一道了，不再重复加权。
 *
 * @param {Array} rows selectCandidates 的输出
 * @param {{offerId?:string, priceUsd?:number, ttftMs?:number}} current 出问题的那一家
 * @returns {object|null} 最接近的可登场候选行
 */
export function pickClosestCandidate(rows = [], current = {}) {
  const pool = rows.filter(
    (row) => row?.admission?.ok && !row.detour && row.offer?.id !== current.offerId,
  )
  if (pool.length === 0) return null
  let best = null
  let bestScore = Infinity
  for (const row of pool) {
    const priceGap = relativeGap(Number(row.priceUsd), Number(current.priceUsd))
    const speedGap = relativeGap(Number(row.ttftMs), Number(current.ttftMs))
    // 价格差权重略高：贵了是真花钱，慢了只是难受
    const score = priceGap * 0.6 + speedGap * 0.4
    if (score < bestScore) {
      bestScore = score
      best = row
    }
  }
  return best
}

/** 改道复检结果的落库入口（与 noteDetourCheck 分开放，便于 inventory 层引用） */
export function applyDetourCheck(db, offerId, { ok } = {}) {
  return noteDetourCheck(db, offerId, { ok })
}
