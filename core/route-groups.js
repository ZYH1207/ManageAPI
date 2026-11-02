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
    key: 'value',
    label: '性价比',
    hint: '价格 ÷ 质量',
    mode: 'value',
    magpie: 'smart-split',
    desc: '降智的站名义价再低，除下来也更贵。适合「不想动脑、交给程序」的日常场景。',
  },
  {
    key: 'price',
    label: '价格优先',
    hint: '最便宜的先上',
    mode: 'price',
    magpie: 'cheap first',
    desc: '只比名义单价，质量只用来挡不合格的。适合「省钱为主，慢点没关系」。',
  },
  {
    key: 'flow',
    label: '流畅度优先',
    hint: '一屏回答谁先读完',
    mode: 'flow',
    magpie: 'fastest',
    desc: '按「首字 + 吐字」算一屏回答要多久。适合交互式、要手感快的场景。',
  },
  {
    key: 'speed',
    label: '首字优先',
    hint: '第一个字最快出来',
    mode: 'speed',
    magpie: 'fastest',
    desc: '只看首字延迟。适合短问答；长回答可能被「首字快但吐字慢」的站坑到。',
  },
  {
    key: 'realSpeed',
    label: '只信实测',
    hint: '没真实样本直接淘汰',
    mode: 'realSpeed',
    magpie: 'fastest',
    desc: '只用真实流量的首字，无样本的站排最后。适合「探针不可信、只认自己跑过」的人。',
  },
  {
    key: 'value-steady',
    label: '稳妥（少换人）',
    hint: '性价比 + 尽量钉住现役',
    mode: 'value',
    magpie: 'never stuck',
    keepEligible: true,
    desc: '按性价比挑，但一旦选定就尽量不换（改用更粘的缓存亲和）。'
      + '适合长对话——每次换站都要重算上下文缓存。',
  },
  {
    key: 'balance',
    label: '余量优先',
    hint: '余额/额度剩得最多的先上',
    mode: 'value',
    magpie: 'Least used first',
    balanceFirst: true,
    desc: 'Magpie 的 Least used first：把「额度还剩多少」放在价格之前——'
      + '余额多的站先用，避免某一家先耗尽、临时没有兜底。'
      + '适合同时挂了多个免费额度、想平均用的场景。',
  },
  {
    key: 'rotate',
    label: '轮流',
    hint: '每次换一个站，不钉住',
    mode: 'value',
    magpie: 'Manual / Rotate',
    forceOff: true,
    desc: 'Magpie 的 Rotate：每次都重新挑，不做缓存亲和（affinity 强制为「轮流」）。'
      + '适合额度分散、想让各家都跑起来，或者怀疑某家变慢想尽快发现。'
      + '代价是缓存命中率会掉——每次换站上下文都要重算。',
  },
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
export function newRouteGroup({ name = '新路由组', models = [], algo = 'value' } = {}, existing = []) {
  return {
    id: newGroupId(existing),
    name: String(name).trim() || '新路由组',
    models: normalizeModels(models),
    algo: algoOf(algo).key,
    createdAt: new Date().toISOString(),
  }
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
        .map((g, index) => ({
          id: typeof g.id === 'string' && g.id ? g.id : `${GROUP_PREFIX}${String(index + 1).padStart(2, '0')}`,
          name: String(g.name || '').trim() || `路由组 ${index + 1}`,
          models: normalizeModels(g.models),
          algo: algoOf(g.algo).key,
          createdAt: g.createdAt || new Date().toISOString(),
        }))
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
    group: null,
  }
}