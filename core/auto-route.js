/**
 * 自动路由（一键接管）：智能决策页的开关，权限在决策侧重之上。
 *
 * 开着的时候，网关不再理会客户端请求里的 model 字段——不管它要什么模型、
 * 换成什么模型，一律改派「当前决策档位下全场最优的那个模型」：
 *   1. 每个模型先取它自己准入通过的最优供给（口径与网关派活完全同一份：
 *      selectCandidates + admissionOf，慢速 / 可疑 / 冷却中照样不登场）
 *   2. 再按 settings.decisionMode 的标量（tierMetricOf）跨模型比，最小者胜
 *   3. 模型归属哪个站、哪个分组一律不管——决策侧重只回答「谁最好」
 *
 * 防抖（迟滞）：新冠军只比现役好一点点时**不换**。反复横跳对用户的干扰
 * （客户端上下文里模型突然变了）远大于那一点收益，所以只有当新模型的
 * 指标比现役好出 SWITCH_GAIN（15%）以上，或者现役的供给全下线了，才切换。
 * 切档（decisionMode 变更）是用户的显式意图，走 force 重选，不受迟滞约束。
 *
 * 故障转移（core/failover.js）：外部监控上报的真实故障比探针准——被命中的
 * 供给直接失去「最优」资格（哪怕探针说它健康）。现役因此被摘时立刻换人
 * （reason='failover'，不受迟滞约束：真故障不等人），并记住 failoverFrom。
 * 故障到期后供给自动恢复参选；若它仍是全场第一，提回来（reason=
 * 'fault-recovery'，同样不受迟滞约束——重回第一本身就是明确信号）；
 * 若已让位给更好的，回提作废，正常竞争。
 *
 * 边界：只接管付费池。免费入口（/free/v1 或 free/ 前缀）保持原行为——
 * 把免费请求偷偷改派到付费模型等于静默扣钱，这个项目明令禁止。
 *
 * 谁来决定开不开：除了界面上的开关，**客户端也能拨**（2026-10-29 定）。
 * 网关模型清单里常驻一个虚拟模型 AutoThink，其余是全场供给——
 * 客户端点 AutoThink = 请求接管（AUTO_ROUTE 打开且立刻挑一次），
 * 点别的模型 = 不再接管，就按那个模型派活。这样在本机换模型不用反复改 Key。
 * 关掉接管时钉住当前模型（`settings.pinnedModelKey`，见 daemon/server.js）：
 * 客户端行为只负责「拨开关」，不该顺带改变派的谁。
 *
 * 纯函数约定：pickAutoRoute 只读 db、不写 db（网关热路径拿到的是共享缓存对象，
 * 「下游只读不改」），切换结果由调用方决定要不要经 store.mutate 落盘。
 */
import { selectCandidates } from './router.js'
import { normalizeModelKey, modelIdentityKey, routeableOffers } from './inventory.js'
import { normalizeDecisionMode, tierMetricOf } from './decision-mode.js'
import { splitOffers } from './free.js'
import { faultMatcher } from './failover.js'

/** 新模型至少要比现役好这个比例才值得切换（0.15 = 好 15% 以上） */
export const AUTO_ROUTE_SWITCH_GAIN = 0.15

/**
 * 网关模型清单里那个虚拟模型的名字：客户端选中它 = 让网关接管。
 *
 * 为什么是「虚拟模型」而不是一个自定义参数：客户端（Codex / Claude Code / 各类
 * 桌面端）只认模型清单里的 id，改配置要重启、要重登、要重填 Key。清单里摆一个
 * AutoThink 之后，「换 Key / 改 base_url」这件事就不必反复做了——在客户端下拉里
 * 点一下就是拨开关（见 daemon/server.js#handleChatCompletions）。
 */
export const AUTO_THINK_MODEL = 'AutoThink'

/**
 * 这个名字算不算「要接管」。写法宽容一点：AutoThink / auto-think / AUTO THINK
 * 都算——客户端有时自己会做一次归一化，没必要为此报 404。
 *
 * 边界：如果某家站真的有个叫 AutoThink 的模型（极不可能），调用方必须先用
 * 「清单里有没有同名的真供给」把虚拟模型让开，不能把它遮住。
 */
export function isAutoThinkModel(name) {
  const flat = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, '')
  return flat === AUTO_THINK_MODEL.toLowerCase()
}

/**
 * 一个请求到底算什么：虚拟开关，还是真有这么个模型的点名单。
 *
 * 判定只有一份（网关和测试都走这里）：名字长得像 AutoThink **且** 全场没有
 * 同身份的真供给 → 'virtual'（拨开关）；否则 'real'（当普通模型名走）。
 * 少这一步，某家站真有个 AutoThink 时就会永远点不到它。
 *
 * @param {string} name 客户端请求的 model（已剥掉 free/ 前缀）
 * @param {Array} offers 参与判定的供给（付费 + 免费都要算，真供给优先）
 */
export function autoThinkIntent(name, offers) {
  if (!isAutoThinkModel(name)) return 'real'
  // 比的是同一个宽容判定，不是身份键：身份键不会把 AutoThink 与 auto-think 归到一起
  // （那两条规则只抹版本号与日期，不抹单词间的连接符），拿它比会漏掉变体写法
  const hasReal = (offers || []).some((offer) =>
    isAutoThinkModel(offer.modelKey || offer.upstreamName),
  )
  return hasReal ? 'real' : 'virtual'
}

/** settings.autoRoute 的缺省形状（store.js 的 settings 默认值也引用这一份口径） */
export function defaultAutoRoute() {
  return { enabled: false, modelKey: null, offerId: null, pickedAt: null, reason: null, failoverFrom: null, scope: [] }
}

/** 任意输入 → 完整形状；字段缺失补默认，多出来的字段丢弃 */
export function normalizeAutoRoute(value) {
  const raw = value && typeof value === 'object' ? value : {}
  return {
    enabled: Boolean(raw.enabled),
    modelKey: typeof raw.modelKey === 'string' && raw.modelKey ? raw.modelKey : null,
    offerId: typeof raw.offerId === 'string' && raw.offerId ? raw.offerId : null,
    pickedAt: typeof raw.pickedAt === 'string' && raw.pickedAt ? raw.pickedAt : null,
    reason: typeof raw.reason === 'string' && raw.reason ? raw.reason : null,
    // 因故障转移让位的模型：故障到期且重回全场第一时提回来（见 pickAutoRoute）
    failoverFrom: typeof raw.failoverFrom === 'string' && raw.failoverFrom ? raw.failoverFrom : null,
    // 接管范围（决策页分组上的加号勾选）：空数组 = 全场所有模型都参选；
    // 非空 = 只在勾选的模型里挑。存的是比价分组键（身份键口径）
    scope: Array.isArray(raw.scope)
      ? [...new Set(raw.scope.filter((key) => typeof key === 'string' && key.trim()))]
      : [],
  }
}

/**
 * 全场挑选（纯函数）。
 *
 * @returns {{modelKey, offerId, providerId, providerName, upstreamName, group,
 *            metric, switched, reason} | null}
 *   reason：'initial' 第一次挑选 / 'gain' 新冠军好出迟滞阈值 / 'unavailable'
 *   现役供给全下线被迫换 / 'mode-change' 用户切了档位（force） / 'keep' 现役够好不换
 *   switched=true 时调用方应把结果落盘（modelKey/offerId/pickedAt/reason）；
 *   reason='keep' 时返回的仍是现役（或当前最优的现役）信息，不改记录。
 *   整个池子连一个能登场的模型都没有时返回 null——调用方按原模型走正常
 *   报错流程（admissionFailure 的人话文案比这里能编的都准）。
 */
export function pickAutoRoute(db, { scores, benchmarks, force = false, driftDemoted = null } = {}) {
  const settings = db.settings || {}
  const record = normalizeAutoRoute(settings.autoRoute)
  const mode = normalizeDecisionMode(settings.decisionMode)
  const paid = splitOffers(routeableOffers(db), benchmarks).paid
  // 外部监控上报的真实故障：命中即失去「最优」资格（探针的准入判定不受影响）
  const isFaulted = faultMatcher(db.failover)

  // 接管范围：空 = 全场；非空 = 只在勾选的模型里挑（决策页分组上的加号）。
  // 勾选存的是决策页的分组键（身份键口径），byModel 的键是存储键口径，
  // 两边都过一遍 modelIdentityKey 再比——不然用户勾了「deepseek-4.1-flash」
  // 却勾不住站点写成「deepseek-v4.1-flash」的供给
  const scopeIds = record.scope.length
    ? new Set(record.scope.map((key) => modelIdentityKey(key, settings.modelAliases) || key))
    : null
  const inScope = (key) =>
    !scopeIds || scopeIds.has(modelIdentityKey(key, settings.modelAliases) || key)

  // 同一个模型的供给只在该模型自己的分片里过一遍 selectCandidates：
  // 每条供给全程只被扫一次，总量 O(供给数)，不会随模型数量平方膨胀
  const byModel = new Map()
  for (const offer of paid) {
    const key = offer.modelKey || normalizeModelKey(offer.upstreamName)
    if (!key) continue
    if (!inScope(key)) continue
    if (!byModel.has(key)) byModel.set(key, [])
    byModel.get(key).push(offer)
  }

  let best = null // { modelKey, row, metric }
  let current = null // 现役模型此刻的最优行
  let currentFaulted = false // 现役模型是因故障被摘（区别于供给下线）
  let failoverBack = null // failoverFrom 的模型故障到期后的最优行
  for (const [modelKey, offers] of byModel) {
    const rows = selectCandidates({
      offers,
      providers: db.providers,
      credentials: db.credentials,
      scores,
      benchmarks,
      settings,
      model: modelKey,
      // 手动顺序只改「先试谁」，不改变准入——和网关派活同一口径
      order: db.manualOrder?.[modelKey] || null,
      isFaulted,
    })
    // 「最优」必须同时过准入和无故障：故障转移的供给哪怕探针说健康也不参选。
    // 漂移转移（daemon/drift-watcher.js）降级的供给同理——真实负载下比自己的
    // 基线差出阈值的站，探针分再好也不当「最优」，但准入不受影响（绝境兜底仍可用）
    const winner = rows.find(
      (row) =>
        row.admission?.ok &&
        !row.faulted &&
        !(driftDemoted && driftDemoted.has(row.offer.id)),
    )
    if (modelKey === record.modelKey) {
      current = winner ? { modelKey, row: winner, metric: tierMetricOf(winner, mode) } : null
      // 有供给、能登场，但全被故障上报摘了 → 是「故障转移」，不是「下线」
      currentFaulted = !winner && rows.some((row) => row.admission?.ok && row.faulted)
    }
    if (record.failoverFrom && modelKey === record.failoverFrom) {
      // 故障到期（到期记录已被 expire 标记，不在这里面）→ 有 winner 就是恢复参选了
      failoverBack = winner ? { modelKey, row: winner, metric: tierMetricOf(winner, mode) } : null
    }
    if (!winner) continue
    const metric = tierMetricOf(winner, mode)
    if (!best || metric < best.metric) best = { modelKey, row: winner, metric }
  }

  // 全场没有一个能登场的模型：交回调用方走正常报错，记录原样保留
  if (!best) return null

  // 故障回提：让位的模型故障到期且重回全场第一 → 提回来，不受迟滞约束。
  // 若它已不是第一（让位期间别人更优），回提作废，failoverFrom 清掉，正常竞争
  const recoveredBack = Boolean(
    record.failoverFrom &&
      record.failoverFrom !== record.modelKey &&
      failoverBack &&
      best.modelKey === record.failoverFrom,
  )

  // 现役还在、不是强制重选、也不是故障回提：好得不多就不折腾（迟滞）
  if (current && !force && !recoveredBack) {
    const gainRatio = current.metric > 0 ? (current.metric - best.metric) / current.metric : 1
    if (best.modelKey !== record.modelKey && gainRatio < AUTO_ROUTE_SWITCH_GAIN) {
      best = current
    }
  }

  // 推导切换原因：记录里没有 → 首次；切档（force）→ 用户显式意图；
  // 现役被故障摘掉 → 故障转移；现役模型已无可用供给 → 被迫换；
  // 现役还在但新冠军好出迟滞阈值 → 正常择优。
  // switched 的判定永远以 modelKey 是否变化为准，reason 只是给人看的注脚
  const switched = best.modelKey !== record.modelKey
  // 现役供给被漂移降级（同模型换供给或换模型都算转移）：Watcher 会把 reason
  // 覆写成 drift-failover，这里只负责把「现役没了是因为降级」从 unavailable 区分开
  const currentDemoted = Boolean(driftDemoted && record.offerId && driftDemoted.has(record.offerId))
  let reason = 'keep'
  if (recoveredBack && switched) reason = 'fault-recovery'
  else if (switched) {
    if (!record.modelKey) reason = 'initial'
    else if (force) reason = 'mode-change'
    else if (currentFaulted) reason = 'failover'
    else if (!current && currentDemoted) reason = 'drift-failover'
    else if (!current) reason = 'unavailable'
    else reason = 'gain'
  }
  // failoverFrom 的记账：因故障让位 → 记下让位对象；故障到期但没抢回第一 →
  // 回提作废；重回第一（上面已换过去）→ 记账完成。其余情况原样保留
  let failoverFrom = record.failoverFrom
  if (reason === 'failover') failoverFrom = record.modelKey
  else if (reason === 'fault-recovery' || (failoverFrom && failoverBack)) failoverFrom = null

  return {
    modelKey: best.modelKey,
    offerId: best.row.offer.id,
    providerId: best.row.offer.providerId,
    providerName: best.row.provider?.name ?? null,
    upstreamName: best.row.offer.upstreamName,
    group: best.row.offer.group || '',
    metric: best.metric,
    switched,
    reason,
    failoverFrom,
  }
}

/**
 * 打开接管（mutate 回调里用）：保留已有记录（scope / modelKey / failoverFrom）。
 * 单独一个函数是为了「客户端点名 AutoThink」和 UI 开关走同一条路，不各写一遍。
 */
export function enableAutoRoute(settings) {
  settings.autoRoute = { ...normalizeAutoRoute(settings.autoRoute), enabled: true }
  return settings.autoRoute
}

/**
 * 关闭接管（mutate 回调里用）。
 *
 * 清掉挑选记录（modelKey / offerId / pickedAt / reason / failoverFrom）：那只是
 * 接管期间的临时状态，关了还留着会让人以为它还在生效。
 * **但保留 scope**：接管范围是用户在决策页一个个勾出来的偏好，不是接管结果；
 * 现在客户端切一下模型就会关一次接管（见 daemon/server.js），要是每次顺手
 * 把 scope 抹了，用户勾的范围一天掉八遍。
 */
export function disableAutoRoute(settings) {
  const record = normalizeAutoRoute(settings.autoRoute)
  settings.autoRoute = { ...defaultAutoRoute(), enabled: false, scope: record.scope }
  return settings.autoRoute
}

/** 把挑选结果写回 settings.autoRoute 的落盘形状（mutate 回调里用） */
export function applyAutoRoutePick(settings, pick) {
  const record = normalizeAutoRoute(settings.autoRoute)
  settings.autoRoute = {
    ...record,
    modelKey: pick.modelKey,
    offerId: pick.offerId,
    pickedAt: new Date().toISOString(),
    reason: pick.reason,
    failoverFrom: pick.failoverFrom !== undefined ? pick.failoverFrom : record.failoverFrom,
  }
  return settings.autoRoute
}
