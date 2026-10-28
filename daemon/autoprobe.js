/**
 * 自动路由活跃期的探针轮巡。
 *
 * 需求（2026-10-28，2026-10-29 演进）：探针定时任务可能被关掉（省钱），但自动路由在接真实流量时，
 * 评分必须是新鲜的——自动路由每单都按评分挑全场最优，拿几小时前的首字/指纹
 * 派活等于闭眼开车。所以：
 *
 *   - 自动路由开着、且网关持续收到外界请求（「活跃」）→ 从没拍过、或上一轮
 *     已满一个轮巡间隔时，立刻对所有未被忽略的模型全量探一轮（开工基础分快照）；
 *     之后每 60 分钟续一轮 Lite——实时性已由漂移监视器（daemon/drift-watcher.js）
 *     吃真实流量保证，探针只负责低频刷新基础分
 *   - **休息多久都不额外重拍**：站又不知道你休息了，快照的新鲜度只看年龄。
 *     中途歇 10 分钟和连续干活，对探针节奏毫无区别；歇了 5 小时回来，快照
 *     早满一小时了，回来 3 秒内补一张全量——判据是快照年龄，不是「是否中断」
 *   - 没有请求就不探：自动路由哪怕开着，安静时一分钱也不烧
 *   - 无视定时探针的间隔设置与暂停时段：这是被真实流量驱动的，不是定时任务
 *   - 轮巡默认每模型 2 个请求（指纹+计费、截断），发太多太贵；缓存命中率
 *     不急着新鲜，走与定时探针同一套补测规则（probe-runner 的 cache:'auto'），
 *     赶上补测（距上次测缓存 ≥ 2 小时）的那轮自动升级成 4 发。定时探针被关掉、
 *     轮巡接管探测时，缓存也不会永远不更新
 *   - 已欠费的站点跳过（余额读数 ≤ 0）：探了也是白烧
 *
 * 「活跃」的定义：最近一次网关请求（自动路由开着时）距今不超过 ACTIVITY_WINDOW。
 * 请求是稀疏的（比如 5 分钟一单）也算持续接流量；窗口过期后回到安静态，
 * 再来请求时重新触发首轮。
 *
 * 活跃标记放在内存：进程重启后本来就该重新观察（重启前的流量说明不了现在），
 * 而且这是热路径上的记录，写库太重。
 */
import * as store from '../core/store.js'
import * as inv from '../core/inventory.js'
import { normalizeAutoRoute } from '../core/auto-route.js'
import { selectCandidates } from '../core/router.js'
import { scoreOffers } from '../core/score.js'
import { normalizeDecisionMode, tierMetricOf } from '../core/decision-mode.js'

/** 距最近一次网关请求超过这么久，就算「自动路由空闲了」，停止轮巡 */
export const AUTOPROBE_ACTIVITY_WINDOW_MS = 10 * 60_000
/**
 * 活跃期内的轮巡节奏（实时性由漂移监视器保证，探针只低频刷新基础分）
 */
export const AUTOPROBE_PASS_INTERVAL_MS = 60 * 60_000
/**
 * 单轮最多探多少条供给（「决赛圈」上限）。
 *
 * 为什么必须限：真实库里 300+ 条在役供给，全场全量 = 上千个真实请求，
 * 既慢又烧钱，和「自动路由省钱」的初衷正好相反。自动路由一单只派给一个模型，
 * 需要新鲜证据的只有「现役 + 可能接替它的那几个」，其余慢变模型没必要每小时扫。
 */
export const PATROL_MAX_OFFERS = 12
/** 除现役模型外，还盯几个可接替的模型（按当前档位标量取最优的几条） */
export const PATROL_ALT_MODELS = 4

/**
 * 本轮轮巡探谁：只探「决赛圈」——现役模型的全部在役供给 + 可能接替它的前几个
 * 模型各自最优的一条。上限 PATROL_MAX_OFFERS。
 *
 * 与路由同口径：routeableOffers（未下线/未暂停/未忽略）打底，去掉欠费站
 * （余额读数 ≤ 0 的不探，充上值自动回场）；候选排序用 selectCandidates +
 * tierMetricOf 的现成实现，不在这里另写一套准入/档位逻辑。
 *
 * 现役模型还没定（刚开开关、一次流量都没有）时退回「全场前 N 条」，
 * 至少能给自动路由攒出第一份可选集。
 */
export function patrolTargets(db, record = normalizeAutoRoute(db.settings?.autoRoute)) {
  const routeable = inv.routeableOffers(db).filter((offer) => {
    const provider = db.providers.find((p) => p.id === offer.providerId)
    if (!provider) return false
    // null 是「没读过余额」，不能当 0（Number(null)===0 会把没读过余额的站全跳过）
    const raw = provider.quotaRemaining
    if (raw === null || raw === undefined || raw === '') return true
    const remaining = Number(raw)
    return !(Number.isFinite(remaining) && remaining <= 0)
  })
  if (routeable.length <= PATROL_MAX_OFFERS) return routeable

  const settings = db.settings || {}
  const scores = scoreOffers(db.probes, db.traffic, {
    maxAgeMs: (Number(settings.scoreMaxAgeHours) || 6) * 3600 * 1000,
  })
  const mode = normalizeDecisionMode(settings.decisionMode)
  const currentModel = record?.modelKey || null

  const picked = []
  const seen = new Set()
  const take = (offer) => {
    if (!offer || seen.has(offer.id) || picked.length >= PATROL_MAX_OFFERS) return
    seen.add(offer.id)
    picked.push(offer)
  }

  // 1) 现役模型的全部在役供给（它才是此刻真正在服务的，证据必须新鲜）
  if (currentModel) {
    for (const offer of routeable) {
      if ((offer.modelKey || offer.upstreamName) === currentModel) take(offer)
    }
  }

  // 2) 可能接替它的模型：按当前档位标量排序，每个模型取最优的那条供给
  const byModel = new Map()
  for (const offer of routeable) {
    const key = offer.modelKey || offer.upstreamName
    if (!key || key === currentModel) continue
    if (!byModel.has(key)) byModel.set(key, [])
    byModel.get(key).push(offer)
  }
  const ranked = []
  for (const [modelKey, offers] of byModel) {
    const rows = selectCandidates({
      offers,
      providers: db.providers,
      credentials: db.credentials,
      scores,
      benchmarks: {},
      settings,
      model: modelKey,
      order: db.manualOrder?.[modelKey] || null,
    })
    const winner = rows.find((row) => row.admission?.ok && !row.balanceDepleted)
    if (!winner) continue
    ranked.push({ offer: winner.offer, metric: tierMetricOf(winner, mode) })
  }
  ranked.sort((a, b) => a.metric - b.metric)
  for (const r of ranked.slice(0, PATROL_ALT_MODELS)) take(r.offer)

  // 3) 一条都没挑到（现役模型还没有在役供给）才按原顺序兜底，别让首轮空转。
  // 挑到了就不再补——多探一条都是白烧的钱
  if (picked.length === 0) for (const offer of routeable) take(offer)
  return picked
}

/**
 * @param {{runProbes: Function, logger?: object}} deps
 *   runProbes 注入（daemon/probe-runner.js），测试时可以换成桩
 */
export function createAutoRouteProber({ runProbes, logger = console }) {
  // e2e 要把窗口压到亚秒级才能验「来流量就探、停流量就停」
  const activityWindowMs =
    Number(process.env.MANAGE_API_AUTOPROBE_ACTIVITY_MS) || AUTOPROBE_ACTIVITY_WINDOW_MS
  const passIntervalMs =
    Number(process.env.MANAGE_API_AUTOPROBE_INTERVAL_MS) || AUTOPROBE_PASS_INTERVAL_MS

  let lastActivityAt = 0
  let lastPassAt = 0
  let running = false
  let kickoffTimer = null

  const isActive = (now = Date.now()) => lastActivityAt > 0 && now - lastActivityAt <= activityWindowMs

  async function runPass(reason, { full = false } = {}) {
    if (running) return
    running = true
    try {
      const db = await store.readDb()
      // 自动路由被关掉就不探：哪怕刚才还有流量（正在关机前的收尾请求）
      const record = normalizeAutoRoute(db.settings.autoRoute)
      if (!record.enabled) return
      const targets = patrolTargets(db, record)
      if (targets.length === 0) return
      lastPassAt = Date.now()
      const results = await runProbes({ offerIds: targets.map((o) => o.id), lite: !full, cache: 'auto' })
      const okCount = results.filter((r) => r.ok).length
      logger.info?.(
        `[自动路由探针] ${reason}：${results.length} 个模型，成功 ${okCount}（${full ? '开工全量' : 'Lite'}）`,
      )
    } catch (error) {
      logger.warn?.(`[自动路由探针] 失败：${error.message}`)
    } finally {
      running = false
    }
  }

  /**
   * 网关每收到一单（自动路由开着）就调一次。只记时间戳 + 在「安静 → 活跃」
   * 的跳变上排一个去抖的 kickoff（3 秒，等并发的第一批请求到齐）。
   * kickoff 只在探针证据已经老化（上一轮 ≥ 一个轮巡间隔前，或从没拍过）时才重拍：
   * 中途歇几分钟回来不重拍——快照年龄没到点，站又不知道你休息过。
   */
  function noteActivity() {
    const wasActive = isActive()
    lastActivityAt = Date.now()
    // 去抖期间证据可能已被别人刷新（tick 续拍 / 逃生舱拨表），点火时重新校验，
    // 否则续拍和首拍会在几秒内先后各拍一轮，重复花钱
    const evidenceStale = () => lastPassAt === 0 || Date.now() - lastPassAt >= passIntervalMs
    if (!wasActive && evidenceStale() && !kickoffTimer) {
      const kickoffMs = Number(process.env.MANAGE_API_AUTOPROBE_KICKOFF_MS) || 3000
      kickoffTimer = setTimeout(() => {
        kickoffTimer = null
        if (isActive() && evidenceStale()) void runPass('自动路由开始接流量', { full: true })
      }, kickoffMs)
      kickoffTimer.unref?.()
    }
  }

  /**
   * 调度器每分钟调一次：活跃期内按节奏续拍；首拍由 kickoff 负责，这里不补
   * （lastPassAt 为 0 说明 kickoff 还没跑，别抢跑）。
   * 注意不活跃时**不清 lastPassAt**：休息不改变快照的新鲜度，回来后按年龄
   * 该补全量补全量（kickoff）、该续 Lite 续 Lite。
   */
  async function tick() {
    if (!isActive()) return
    if (lastPassAt === 0) return
    if (Date.now() - lastPassAt >= passIntervalMs) {
      await runPass('自动路由持续接流量')
    }
  }

  /** 逃生舱（daemon/drift-watcher.js）等外部路径踢了探针时拨表：
   *  下一轮轮巡从现在起算满一个间隔，一小时内不重复拍 */
  function markPass() {
    lastPassAt = Date.now()
  }

  return { tick, isActive, noteActivity, markPass }
}
