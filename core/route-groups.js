/**
 * 路由组：一组模型 + 组级路由算法。
 *
 * ## 为什么要有它（用户 2026-11-02 的原话）
 *
 *   「现在缺的是：我能在选好的某两个模型之间自由切换，也就是自动路由切换。
 *     所以再加一个路由组，路由组里就是 Magpie 的那个路由组。你可以编制路由组，
 *     按照哪个路由组进行自动路由。」
 *
 * 之前的 `autoRoute.scope` 已经是「只在这几个模型里挑」，但那是**一个**全局集合，
 * 而且只能在决策页每个模型组头上点一个小加号，散落在各处、没有名字、
 * 不能保存多套、也不能给组单独配算法。路由组把这件事变成一等公民：
 *
 *   · 有名字、可保存多套（「日常」「省钱」「写代码」）
 *   · 组内成员可增删
 *   · **每组一套自己的算法**（价格优先 / 流畅度优先 / 绝不换人等）
 *   · 自动路由按「当前选中的那个组」工作
 *
 * ## 算法档（对标 Magpie 的四条策略）
 *
 * 从 Magpie 二进制里提取到的策略名是 `cheap first` / `never stuck` /
 * `smart-split` / `fastest`。这里不照抄字符串，而是把它们落成**本网关已有的**
 * 六档决策侧重 + 两个约束开关，语义一一对应：
 *
 *   Magpie            → 这里
 *   cheap first       → decisionMode='price'
 *   fastest           → decisionMode='flow'（流畅度：首字+吐字）
 *   smart-split       → decisionMode='value'（价格÷质量，默认）
 *   never stuck       → 兜底阶梯已经是强制的（保证不报错），另加
 *                       keepEligible=true「尽量别换人」= affinity 钉住
 *
 * 为什么不是「再造一套平行算法」：本项目的评分/准入/兜底已经是一份实现
 * （core/decision-mode.js + router.js + fallback-ladder.js），再抄一套必然漂移。
 * 路由组只负责**选范围**和**拨档位**，判定仍然走同一份。
 *
 * ## 与 autoRoute.scope 的关系
 *
 * 组存在时以组为准，组内成员就是 scope；没有组时回到旧的 scope 行为。
 * 这样老用户的老配置不会突然失效（向后兼容）。
 *
 * 纯函数：不读库、不落盘。归一化在 normalizeRouteGroups，写库由调用方 mutate。
 */

import { normalizeDecisionMode, DEFAULT_DECISION_MODE } from './decision-mode.js'

/** 组的 id 前缀，便于与其它实体区分 */
const GROUP_PREFIX = 'rg_'

/** 一组最多多少个模型（防止把全库都塞进来，那不是「组」而是「全场」） */
export const MAX_MODELS_PER_GROUP = 24
/** 最多几组（界面上放得下、也不至于让人选择困难） */
export const MAX_GROUPS = 12

/**
 * 组级算法：对齐 Magpie 的 5 种路由方式。
 *
 * Magpie 的做法（从它的二进制里提取到的原话）：
 *   Cheap first          —— 便宜的先上
 *   Never stuck          —— 别卡死，遇挫就换（保证不报错）
 *   Fastest              —— 按首字速度
 *   Least used first     —— "the account or key with the most of its allowance
 *                            left goes first"（额度剩最多的先上）
 *   Manual / Rotate      —— 手动指定 / 轮流
 *
 * 映射到本网关已有的能力上（不另造平行算法）：
 *
 * `keepEligible` 对应 Magpie 的 never-stuck 精神：宁可慢一点也别频繁改派，
 * 因为每次改派都会把上游 prompt 缓存作废（见 core/affinity.js 的论证）。
 */
export const GROUP_ALGOS = [
  {
    key: 'smart',
    label: '智能',
    hint: '按评分自动挑最优',
    mode: 'value',
    magpie: '智能',
    desc: 'Magpie 的「智能」：按当前判定口径挑全场最优（评分=价格÷质量×余额×速度）。日常默认。',
  },
  {
    key: 'order',
    label: '按顺序',
    hint: '从上往下挨个试',
    mode: 'value',
    magpie: '按顺序',
    orderFirst: true,
    desc: 'Magpie 的「按顺序」：不评分，严格按成员列表从上往下试，第一个能用就用。'
      + '适合「我有明确偏好，只想要这家，它不行才往下」的场景。',
  },
  {
    key: 'failover',
    label: '用完再换',
    hint: '当前这家用尽额度才换',
    mode: 'value',
    magpie: '用完再换',
    orderFirst: true,
    stickyMember: true,
    desc: 'Magpie 的「用完再换」：钉住当前这家，直到它额度耗尽/不可用才换下一家。'
      + '最省缓存，也最省心——但某家慢的时候你也得跟着慢。',
  },
  {
    key: 'rotate',
    label: '轮流',
    hint: '每次换一个，均摊负载',
    mode: 'value',
    magpie: '轮流',
    forceOff: true,
    desc: 'Magpie 的「轮流」：每一轮交给下一个成员，均摊负载。'
      + '不做缓存亲和（强制关闭）——适合额度分散、想让各家都跑起来。',
  },
  {
    key: 'least-used',
    label: '最少使用',
    hint: '挑近期用得最少的那个',
    mode: 'value',
    magpie: '最少使用',
    // 与「余量优先」的区别：这个看**已用掉多少**，那个看**还剩多少**。
    // 同一件事的两种镜像，但数据源不同——used 来自用量账本（一定有），
    // remaining 来自站点余额（可能读不到）。
    usedFirst: true,
    desc: 'Magpie 的「最少使用」：按近期**已用掉**的量排序，用得最少的先上。'
      + '与「余量优先」互为镜像——那个看还剩多少，这个看用掉多少。'
      + '数据来自本机用量账本，不依赖站点接口。',
  },
  {
    key: 'until-reset',
    label: '重置前用完',
    hint: '优先榨干即将重置的额度（需站点提供重置周期）',
    mode: 'value',
    magpie: '重置前用完',
    balanceFirst: true,
    // 需要站点侧上报「额度什么时候重置」。本项目只有少数站点接口能读到，
    // 本机 43 个凭据实测**一个都没有**。没有数据时必须说清降级，
    // 不能让用户以为它真在按「即将重置」排序。
    degradedWithout: 'resetAt',
    degradedHint: '站点没上报重置周期 → 等同「余量优先」',
    desc: 'Magpie 的「重置前用完」：额度快到期/快重置的先上，避免白白浪费。'
      + '⚠️ 需要站点侧上报重置周期；没上报时**等同余量优先**（面板会标出来）。',
  },
  {
    key: 'free',
    label: '免费优先',
    hint: '先免费，不够才付费',
    mode: 'value',
    magpie: '免费优先',
    freeFirst: true,
    desc: 'Magpie 的「免费优先」：先用免费额度/免费站，用完了才轮到付费。'
      + '与网关的 allowPaidFallback 配合——这里只是把这个偏好下推到组级。',
  },
  {
    key: 'speed',
    label: '速度优先',
    hint: '首字最快出来',
    mode: 'flow',
    magpie: '速度优先',
    desc: 'Magpie 的「速度优先」：按首字+吐字算出的流畅度排。交互场景首选。',
  },
  {
    key: 'cheap',
    label: '最便宜',
    hint: '名义单价最低',
    mode: 'price',
    magpie: '最便宜',
    desc: 'Magpie 的「最便宜」：只看名义单价，质量只用来挡不合格的。',
  },
  {
    key: 'weighted',
    label: '按权重',
    hint: '按成员设置的权重分流',
    mode: 'value',
    magpie: '按权重',
    weighted: true,
    desc: 'Magpie 的「按权重」：每个成员带一个权重，按比例分流。'
      + '适合「主力站 70%、备用 30%」这种配置。',
  },
  {
    key: 'manual',
    label: '手动',
    hint: '只派你在决策页勾选的那一条',
    mode: 'value',
    magpie: '手动',
    // 与「客户端点名模型」的区别：
    //   客户端点名 = 客户端在请求里写 model，网关被动跟随；
    //   手动档     = 你在**决策页**勾了某一条供给，不管客户端要什么，
    //                组内都只派这一条（pinnedOffer）。
    // 所以它读的是 db.pinnedOffer，不是客户端请求。
    manualPick: true,
    desc: 'Magpie 的「手动」：只派你在**决策页勾选**的那一条供给，'
      + '不管客户端请求里写的是什么模型。'
      + '（与「客户端点名」不同：那个是客户端说了算，这个是你在面板里说了算。）',
  },
]

/**
 * 「迟迟不出字」：多久没见到第一个字就换下一个成员。
 *
 * Magpie 原文：「成员超过 60 秒仍未开始回答（无文字、思考或工具调用）时，
 * 改问下一个，此时尚无内容发给 agent。偶尔一次不休息；连续两次，
 * 该模型在这个账号上休息，从一分钟起每次更久，直到它再次回答。」
 *
 * 这里的 holdMs = 0 表示「一直等」（不做首字超时）。
 */
export const FIRST_TOKEN_OPTIONS = [
  { key: 'forever', label: '一直等', ms: 0 },
  { key: '30s', label: '30 秒', ms: 30_000 },
  { key: '60s', label: '1 分钟', ms: 60_000 },
  { key: '120s', label: '2 分钟', ms: 120_000 },
]

/** 「成员全都忙」：全部失败后，隔多久再试。0 = 关闭（立刻把最后一个错误交出去） */
export const ALL_BUSY_OPTIONS = [
  { key: 'off', label: '关闭', ms: 0 },
  { key: '1m', label: '1 分钟', ms: 60_000 },
  { key: '2m', label: '2 分钟', ms: 120_000 },
  { key: '4m', label: '4 分钟', ms: 240_000 },
]

/** 「上下文」：本组对外的上下文窗口怎么报 */
export const CONTEXT_OPTIONS = [
  { key: 'max', label: '最大模型的' },
  { key: 'min', label: '最小模型的' },
  { key: 'custom', label: '自定义' },
]

/**
 * 「会话保持」：这段对话要不要一直用同一个成员。
 *
 * 与 core/affinity.js 的 AFFINITY 是同一件事的两种粒度：
 * 这里是**组级**默认，个体的手动设置优先。
 */
export const SESSION_KEEP_OPTIONS = [
  { key: 'auto', label: '自动', affinity: 'auto' },
  { key: 'session', label: '整个会话', affinity: 'session' },
  { key: 'turn', label: '一轮之内', affinity: 'turn' },
  { key: 'off', label: '关闭', affinity: 'off' },
  { key: 'strict', label: '严格', affinity: 'strict' },
]

/** 「模型列表」：Agent 的模型清单里露什么 */
export const MODEL_LIST_OPTIONS = [
  { key: 'list-members', label: '也列出成员模型' },
  { key: 'only-group', label: '只列出本组' },
]

/** 推理强度 / 档位（Magpie 的 thinking levels） */
export const EFFORT_OPTIONS = [
  { key: 'agent', label: '按 agent' },
  { key: 'per-turn', label: '每轮判断' },
]
export const EFFORT_LEVEL_OPTIONS = [
  { key: 'shared', label: '成员共有' },
  { key: 'custom', label: '自定' },
]

/** 算法 key → 完整定义（非法 key 回落第一条） */
export function algoOf(key) {
  const normalized = String(key || '').trim()
  return GROUP_ALGOS.find((a) => a.key === normalized) || GROUP_ALGOS[0]
}

/** 生成一个组 id */
function newGroupId(existing = []) {
  const used = new Set(existing.map((g) => g.id))
  for (let i = 0; i < 1000; i += 1) {
    // 不用随机数：测试要可复现，且 id 只需要在本机唯一
    const id = `${GROUP_PREFIX}${String(i + 1).padStart(2, '0')}`
    if (!used.has(id)) return id
  }
  return `${GROUP_PREFIX}${Date.now().toString(36)}`
}

/** 空组（新建时用） */
export function newRouteGroup({ name = '新路由组', models = [], algo = 'smart', ...rest } = {}, existing = []) {
  return {
    id: newGroupId(existing),
    name: String(name).trim() || '新路由组',
    models: normalizeModels(models),
    algo: algoOf(algo).key,
    // ── Magpie 的组级设置（2026-11-02 补全）──
    patterns: normalizePatterns(rest.patterns),          // 模式匹配
    modelListMode: normalizeChoice(MODEL_LIST_OPTIONS, rest.modelListMode, 'only-group'),
    firstTokenMs: normalizeOptionMs(FIRST_TOKEN_OPTIONS, rest.firstTokenMs, 60_000),
    allBusyMs: normalizeOptionMs(ALL_BUSY_OPTIONS, rest.allBusyMs, 0),
    contextMode: normalizeChoice(CONTEXT_OPTIONS, rest.contextMode, 'max'),
    contextCustom: Number.isFinite(Number(rest.contextCustom)) ? Number(rest.contextCustom) : null,
    sessionKeep: normalizeChoice(SESSION_KEEP_OPTIONS, rest.sessionKeep, 'auto'),
    effort: normalizeChoice(EFFORT_OPTIONS, rest.effort, 'agent'),
    effortLevel: normalizeChoice(EFFORT_LEVEL_OPTIONS, rest.effortLevel, 'shared'),
    weights: normalizeWeights(rest.weights, models),
    createdAt: new Date().toISOString(),
  }
}

/** 模式列表归一化：只留非空字符串，去掉首尾空白，限量 */
function normalizePatterns(patterns) {
  if (!Array.isArray(patterns)) return []
  const out = []
  for (const p of patterns) {
    if (typeof p !== 'string') continue
    const v = p.trim()
    if (!v) continue
    if (!out.includes(v)) out.push(v)
    if (out.length >= 12) break
  }
  return out
}

/** 选项 key 合法性：非法回落默认（绝不让拼错的值悄悄存进去） */
function normalizeChoice(options, value, fallbackKey) {
  const key = String(value || '').trim()
  return options.some((o) => o.key === key) ? key : fallbackKey
}

/** 毫秒选项：允许直接传数字（自定义），非法回落默认 */
function normalizeOptionMs(options, value, fallbackMs) {
  const n = Number(value)
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.round(n), 60 * 60_000)
  const key = String(value || '').trim()
  const hit = options.find((o) => o.key === key)
  return hit ? hit.ms : fallbackMs
}

/** 权重归一化：每个成员一个权重，缺省 1 */
function normalizeWeights(weights, models) {
  const src = weights && typeof weights === 'object' ? weights : {}
  const out = {}
  for (const m of normalizeModels(models)) {
    const w = Number(src[m])
    out[m] = Number.isFinite(w) && w > 0 ? Math.min(w, 100) : 1
  }
  return out
}

/** 模型列表归一化：去重、去空、限量 */
function normalizeModels(models) {
  if (!Array.isArray(models)) return []
  const out = []
  const seen = new Set()
  for (const raw of models) {
    if (typeof raw !== 'string') continue
    const key = raw.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= MAX_MODELS_PER_GROUP) break
  }
  return out
}

/**
 * 归一化整个路由组配置。
 *
 * 形状：`{ groups: [...], activeId: string|null }`
 *   groups   —— 组列表（顺序即界面顺序）
 *   activeId —— 自动路由按哪个组工作；null = 不启用任何组（回到全场）
 *
 * 为什么 activeId 单独存而不是用「组上的 enabled 布尔」：
 * 有且只有一个组生效，用单选语义表达最直接，也不可能出现「两组同时生效」的怪状态。
 */
export function normalizeRouteGroups(raw) {
  const groups = Array.isArray(raw?.groups)
    ? raw.groups
        .filter((g) => g && typeof g === 'object')
        .slice(0, MAX_GROUPS)
        .map((g, index) => {
          const models = normalizeModels(g.models)
          return {
            id: typeof g.id === 'string' && g.id ? g.id : `${GROUP_PREFIX}${String(index + 1).padStart(2, '0')}`,
            name: String(g.name || '').trim() || `路由组 ${index + 1}`,
            models,
            algo: algoOf(g.algo).key,
            patterns: normalizePatterns(g.patterns),
            modelListMode: normalizeChoice(MODEL_LIST_OPTIONS, g.modelListMode, 'only-group'),
            firstTokenMs: normalizeOptionMs(FIRST_TOKEN_OPTIONS, g.firstTokenMs, 60_000),
            allBusyMs: normalizeOptionMs(ALL_BUSY_OPTIONS, g.allBusyMs, 0),
            contextMode: normalizeChoice(CONTEXT_OPTIONS, g.contextMode, 'max'),
            contextCustom: Number.isFinite(Number(g.contextCustom)) ? Number(g.contextCustom) : null,
            sessionKeep: normalizeChoice(SESSION_KEEP_OPTIONS, g.sessionKeep, 'auto'),
            effort: normalizeChoice(EFFORT_OPTIONS, g.effort, 'agent'),
            effortLevel: normalizeChoice(EFFORT_LEVEL_OPTIONS, g.effortLevel, 'shared'),
            weights: normalizeWeights(g.weights, models),
            createdAt: g.createdAt || new Date().toISOString(),
          }
        })
    : []
  // id 去重（手工改库时可能出现重复，留第一个）
  const seen = new Set()
  const deduped = groups.filter((g) => {
    if (seen.has(g.id)) return false
    seen.add(g.id)
    return true
  })
  const activeId =
    typeof raw?.activeId === 'string' && deduped.some((g) => g.id === raw.activeId)
      ? raw.activeId
      : null
  return { groups: deduped, activeId }
}

/** 当前生效的组（没有就是 null） */
export function activeGroupOf(routeGroups) {
  const norm = normalizeRouteGroups(routeGroups)
  if (!norm.activeId) return null
  return norm.groups.find((g) => g.id === norm.activeId) || null
}

/**
 * 自动路由实际该用的「范围 + 档位」。
 *
 * 优先级：
 *   1. 有生效组 → 用组的 models 作范围、组的 algo.mode 作决策档
 *   2. 没有组   → 用旧的 autoRoute.scope（空 = 全场）、autoRoute 自己的档位
 *
 * 这是 auto-route 与路由组之间**唯一**的接口，判定逻辑不在这里
 * （仍然走 selectCandidates / tierMetricOf），这里只决定「看哪些、按什么排」。
 *
 * @returns {{ scope: string[]|null, decisionMode: string|null, keepEligible: boolean, forceOff: boolean, balanceFirst: boolean, group: object|null }}
 *   scope=null 表示全场；decisionMode=null 表示沿用 settings.decisionMode
 */
export function routingTargetOf(routeGroups, autoRoute, settings) {
  const group = activeGroupOf(routeGroups)
  if (group && group.models.length > 0) {
    const algo = algoOf(group.algo)
    return {
      scope: group.models,
      decisionMode: normalizeDecisionMode(algo.mode),
      keepEligible: Boolean(algo.keepEligible),
      // Magpie 的 Rotate：强制关闭缓存亲和，每次重挑。调用方据此把
      // affinity 临时当 'off' 处理（不落库，只影响这一单的判定）
      forceOff: Boolean(algo.forceOff),
      balanceFirst: Boolean(algo.balanceFirst),
      orderFirst: Boolean(algo.orderFirst),
      freeFirst: Boolean(algo.freeFirst),
      weighted: Boolean(algo.weighted),
      manualPick: Boolean(algo.manualPick),
      usedFirst: Boolean(algo.usedFirst),
      // 组级运行参数（Magpie 那套）：首字超时、全忙冷却、会话保持
      firstTokenMs: group.firstTokenMs,
      allBusyMs: group.allBusyMs,
      sessionKeep: group.sessionKeep,
      weights: group.weights,
      group,
    }
  }
  const legacyScope = Array.isArray(autoRoute?.scope) ? autoRoute.scope.filter(Boolean) : []
  return {
    scope: legacyScope.length ? legacyScope : null,
    decisionMode: null, // 沿用 settings.decisionMode
    keepEligible: false,
    forceOff: false,
    balanceFirst: false,
    orderFirst: false,
    freeFirst: false,
    weighted: false,
    manualPick: false,
    usedFirst: false,
    firstTokenMs: settings?.autoRoute?.firstTokenMs ?? 60_000,
    allBusyMs: 0,
    sessionKeep: 'auto',
    weights: {},
    group: null,
  }
}