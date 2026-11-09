/**
 * 锁定失败后转移：手动勾选（锁定）的那条供给失败之后，往哪儿转。
 *
 * ## 为什么要有这个开关（用户 2026-11-09 的原话）
 *
 *   「我明明在智能决策里直接选中了我要用秋网关的 GPT，我那个手动选中不应该是
 *     权重最高吗？为什么现在它会直接绕过我的权重，去选择别的站？」
 *
 * 查下来不是 pin 失效：`applyPinnedChoice` 确实把勾选那条顶到了候选链第一位
 * （core/router.js#applyPinnedChoice）。问题是**它只是排第一，不是锁**——
 * 网关的 `while (cursor < candidates.length)` 会无条件往后试，而后面那条链
 * 是按 routeScore 排的，谁分高谁上。于是 2026-11-09 00:36 秋站报
 * `GROUP_DELETED` 之后，流量整个滑到绿萝最贵的「GPT速度加倍分组」（倍率 0.37），
 * 连打五小时，站点账单 18.97 元、余额打到 -0.027。
 *
 * 所以这里补上「转不转、按什么转」。语义边界要说死：
 *
 *   · 本设置**只对手动勾选（db.pinnedOffer）的请求生效**。没勾选的请求一律维持
 *     现有候选链，不受影响——不是每个人都要被这条规则管。
 *   · 勾选那条**永远排第一**（人的明确指定 > 一切自动排序），本模块只决定它
 *     后面还剩谁、按什么顺序。
 *   · 「不转移」是默认档：锁定即硬锁，失败直接把这个错误交出去，绝不偷偷换站。
 *     这正是用户「手动选中应该权重最高」想要的行为。
 *
 * ## 与决策侧重的分工（别把两件事混成一个滑块）
 *
 *   decisionMode（智能决策页那五档）回答「自动排序时谁排前面」；
 *   lockFailover 回答「锁定的那条挂了，剩下的怎么排」。
 *   两个都会用到「价格 / 真实速度」这两个标量，但**判定实现只有一份**：
 *   排序一律走 core/decision-mode.js#compareByBasis，这里不另写比较逻辑，
 *   否则切档之后迟早一边改了一边没改（这个坑项目里踩过，见 decision-mode.js 注释）。
 *
 * 纯函数：不读库、不落盘。归一化在 normalizeLockFailover，写库由调用方 mutate。
 */

import { compareByBasis, normalizeDecisionMode } from './decision-mode.js'
import { routingTargetOf } from './route-groups.js'

/** 默认档：锁定即硬锁，失败不换站 */
export const DEFAULT_LOCK_FAILOVER = 'none'

/**
 * 八档。`scope` 决定「转给谁」，`metric` 决定「谁先上」。
 *
 *   scope  model  —— 同一模型的全部候选（候选链本来就是按模型筛出来的，等于全场）
 *          group  —— 同站点 + 同分组（用户 2026-11-09 确认：站点页上那个分组）
 *          site   —— 同一站点的所有分组
 *          route-group —— 当前生效路由组的成员与算法（core/route-groups.js）
 *          null   —— 不转移
 *
 *   metric price     —— 名义单价（priceUsd），与决策侧重「价格」档同源
 *          realSpeed —— 真实流量首字（realTtftMs），无样本沉底，与「实速」档同源
 */
export const LOCK_FAILOVER_MODES = [
  {
    key: 'model-price',
    label: '同模型低价优先',
    hint: '同模型里最便宜的先上',
    scope: 'model',
    metric: 'price',
    desc: '锁定的那条失败后，在**同一个模型**的所有供给里按名义单价从低到高接着试。'
      + '最省钱，但可能换来更慢的站——长回答场景实际可能更贵（吐字慢）。',
  },
  {
    key: 'model-realSpeed',
    label: '同模型真实速度优先',
    hint: '同模型里真实首字最快的先上',
    scope: 'model',
    metric: 'realSpeed',
    desc: '锁定的那条失败后，在**同一个模型**的所有供给里按真实流量首字从快到慢接着试。'
      + '只认真实流量样本，没跑过真实流量的供给排最后（不让探针冒充最快）。'
      + '最贴近体感，但快的站通常更贵。',
  },
  {
    key: 'group-price',
    label: '同组低价优先',
    hint: '同一个分组的其它供给，便宜的先上',
    scope: 'group',
    metric: 'price',
    desc: '锁定的那条失败后，**先**在同一个站点的同一个分组里按单价从低到高试；'
      + '这个分组里没有别的可用供给时，才按原顺序往外兜底。'
      + '范围最窄，最不容易跑到陌生分组上去。',
  },
  {
    key: 'group-realSpeed',
    label: '同组真实速度优先',
    hint: '同一个分组的其它供给，真实首字快的先上',
    scope: 'group',
    metric: 'realSpeed',
    desc: '锁定的那条失败后，**先**在同一个站点的同一个分组里按真实首字从快到慢试；'
      + '分组里没有别的可用供给时，才按原顺序往外兜底。',
  },
  {
    key: 'site-price',
    label: '同站低价优先',
    hint: '同一个站的其它分组，便宜的先上',
    scope: 'site',
    metric: 'price',
    desc: '锁定的那条失败后，**先**在同一个站点的其它分组里按单价从低到高试；'
      + '这个站没有别的可用供给时，才按原顺序往外兜底。'
      + '适合「我认这家站，但不想在它最贵的分组上烧钱」。',
  },
  {
    key: 'site-realSpeed',
    label: '同站真实速度优先',
    hint: '同一个站的其它分组，真实首字快的先上',
    scope: 'site',
    metric: 'realSpeed',
    desc: '锁定的那条失败后，**先**在同一个站点的其它分组里按真实首字从快到慢试；'
      + '这个站没有别的可用供给时，才按原顺序往外兜底。',
  },
  {
    key: 'route-group',
    label: '预设路由组优先',
    hint: '按当前生效路由组的算法排',
    scope: 'route-group',
    metric: null,
    desc: '锁定的那条失败后，按**当前生效的路由组**（智能决策页那套「日常 / 省钱 / 写代码」）'
      + '所配的算法重排兜底链：组里配的是「最便宜」就按价格排，配的是「速度优先」就按流畅度排。'
      + '组里配的是「按顺序 / 用完再换」这类有明确先后偏好的档，保持你拖出来的顺序不重排。'
      + '没有生效的路由组时，退回原候选链顺序（等于不做特殊处理）。',
  },
  {
    key: 'none',
    label: '不转移',
    hint: '锁定的那条失败就直接报错',
    scope: null,
    metric: null,
    desc: '锁定的那条失败后**不再尝试任何其它站**，直接把这个错误交回客户端。'
      + '最严格，也最可预期：绝不会有「我以为在用秋，实际在烧绿萝」这种事。'
      + '代价是这一单会失败（客户端能自己重试或换模型）。这是默认档。',
  },
]

/** 任意输入 → 合法档位；非法 / 空一律回落默认（宁可回到「不转移」，也不静默改成别的口径） */
export function normalizeLockFailover(value) {
  const key = String(value ?? '').trim()
  return LOCK_FAILOVER_MODES.some((mode) => mode.key === key) ? key : DEFAULT_LOCK_FAILOVER
}

/** 档位定义（含 label / hint / desc），非法输入回落默认档 */
export function lockFailoverOf(value) {
  const key = normalizeLockFailover(value)
  return LOCK_FAILOVER_MODES.find((mode) => mode.key === key)
}

/** 给 /api/state 的整张表：前端照着渲染，不在浏览器里重写标签 */
export function lockFailoverTable() {
  return LOCK_FAILOVER_MODES.map((mode) => ({ ...mode }))
}

/** 一句话描述当前档位，用于决策页说明与路由日志 */
export function describeLockFailover(value) {
  const mode = lockFailoverOf(value)
  return `${mode.label}（${mode.hint}）`
}

/** 这一行是否落在「同模型 / 同站 / 同组」的范围里（scope=model 时恒为 true） */
function inScopeOf(row, pinned, scope) {
  if (scope === 'model') return true
  const a = row?.offer || {}
  const b = pinned?.offer || {}
  if (scope === 'site') return Boolean(a.providerId) && a.providerId === b.providerId
  if (scope === 'group') {
    return (
      Boolean(a.providerId) &&
      a.providerId === b.providerId &&
      String(a.group || '') === String(b.group || '')
    )
  }
  return false
}

/**
 * 按档位重排/裁剪候选链。
 *
 * 入参 chain 是网关拿到的尝试链（`decideRoute` 的产物，元素带 `offer` 与价格/速度字段：
 * priceUsd / effectiveUsd / realTtftMs / ttftMs，见 core/router.js#selectCandidates）。
 * 勾选那条不一定要在链首——本函数自己找、自己顶到第一，调用顺序不影响结果。
 *
 * @param {Array<object>} chain 候选链
 * @param {object} [opts]
 * @param {string} [opts.mode]              档位（见 LOCK_FAILOVER_MODES）
 * @param {string|null} [opts.pinnedOfferId] 手动勾选的那条供给 id
 * @param {object|null} [opts.routeGroups]  db.settings.routeGroups（route-group 档要用）
 * @param {object|null} [opts.autoRoute]    db.settings.autoRoute（route-group 档要用）
 * @param {object|null} [opts.settings]     db.settings（route-group 档兜底档位）
 * @returns {{
 *   chain: Array<object>,
 *   mode: string,
 *   pinned: object|null,
 *   applied: boolean,
 *   scope: string|null,
 *   metric: string|null,
 *   skipped: string|null,
 * }}
 *   applied=false 表示「没勾选 / 勾选的不在链里 / 该档位缺前提」，chain 原样返回。
 *   skipped 说明为什么没应用，路由日志与测试据此解释。
 */
export function applyLockFailover(
  chain = [],
  { mode = DEFAULT_LOCK_FAILOVER, pinnedOfferId = null, routeGroups = null, autoRoute = null, settings = null } = {},
) {
  const list = Array.isArray(chain) ? chain : []
  const key = normalizeLockFailover(mode)
  const base = { chain: list, mode: key, pinned: null, applied: false, scope: null, metric: null, skipped: null }

  // 没勾选 → 本设置不生效（只管手动锁定的请求，别影响别人的兜底）
  if (!pinnedOfferId) return { ...base, skipped: 'no-pin' }
  const index = list.findIndex((row) => row?.offer?.id === pinnedOfferId)
  // 勾选的牌已经不在候选里（被暂停/删除/本次已试过）→ 无从锁起，交给原链
  if (index < 0) return { ...base, skipped: 'pin-not-in-chain' }

  const pinned = list[index]
  const rest = list.filter((_, i) => i !== index)
  // 跳过（缺前提）时的统一返回：勾选那条仍然顶到第一，只是不再重排它后面的链。
  // 为什么不能直接「原样返回」：本模块的契约是「勾选永远排第一」，
  // 而「跳过一个档位」只是跳过重排，不该连人的明确指定一起丢掉。
  // 真实链路里 applyPinnedChoice 已经排过一遍，这里是让模块自己站得住
  // （单测和将来的其它调用方不该依赖调用顺序）。
  const pinnedFirst = (skipped) => ({ ...base, chain: [pinned, ...rest], pinned, skipped })

  // 「不转移」：链只剩勾选的那一条。后面没有候选 = 网关不会换站，失败直接把错交出去
  if (key === 'none') {
    return {
      chain: [pinned],
      mode: key,
      pinned,
      applied: true,
      scope: null,
      metric: null,
      skipped: null,
    }
  }

  const def = lockFailoverOf(key)

  // 路由组档：按生效组的算法重排；组里配的是「有明确先后偏好」的档就保持原顺序
  if (def.scope === 'route-group') {
    const target = routingTargetOf(routeGroups, autoRoute, settings || {})
    if (!target.group) return pinnedFirst('no-active-route-group')
    if (target.orderFirst) {
      // 按顺序 / 用完再换 / 轮流：用户已经用拖拽表过态，再按指标重排就是覆盖他的意思。
      // 但勾选优先仍然成立，所以走 pinnedFirst 而不是原样返回
      return pinnedFirst('route-group-order-first')
    }
    const sortMode = normalizeDecisionMode(target.decisionMode || settings?.decisionMode)
    const sorted = [...rest].sort((a, b) => compareByBasis(a, b, sortMode))
    return {
      chain: [pinned, ...sorted],
      mode: key,
      pinned,
      applied: true,
      scope: 'route-group',
      metric: sortMode,
      skipped: null,
    }
  }

  // 其余六档：范围内按指标排在前，范围外保持原顺序（仍可兜底，不会因为范围太窄而整单报错）
  const inScope = []
  const outScope = []
  for (const row of rest) (inScopeOf(row, pinned, def.scope) ? inScope : outScope).push(row)
  inScope.sort((a, b) => compareByBasis(a, b, def.metric))

  return {
    chain: [pinned, ...inScope, ...outScope],
    mode: key,
    pinned,
    applied: true,
    scope: def.scope,
    metric: def.metric,
    skipped: null,
  }
}
