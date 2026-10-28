/**
 * 定时探测调度器。
 *
 * 每分钟检查一次：哪些供给距上次探测已超过设定间隔，挑最多 10 个去探。
 * 用「检查 + 到期判断」而不是「长间隔 setInterval」，这样改配置能立即生效，
 * 也不会因为一次探测耗时较长而错过下一轮。
 *
 * 间隔是自适应的：健康站按用户设定的基础间隔，其它站（不健康 / 证据不足 /
 * 过期 / 从没探过）按 1/3 间隔（最少 10 分钟）补测——问题站点应该尽快拿到
 * 新证据，而不是等一整轮。冷却中的供给（限流/模型不在分组）在窗口内直接跳过；
 * 窗口到了按 RECOVERY_INTERVAL_MIN 复测，探到成功才重新放行（路由侧看
 * score.pendingRecovery，不看钟）。
 *
 * 「定时探测 = 关闭」只关例行体检：冷却/待复测的那几条仍会按复测节奏去验，
 * 否则关掉定时探测之后，它们永远拿不到新证据，也就永远不放行（见下面 selfHealOnly）。
 *
 * 暂停时段（core/schedule.js）优先于上面一切：窗口内一个请求都不发，到点自动恢复。
 */
import * as store from '../core/store.js'
import * as inv from '../core/inventory.js'
import * as fxLib from '../core/fx.js'
import { pauseStatus } from '../core/schedule.js'
import { scoreOffers } from '../core/score.js'

const MAX_PER_TICK = 10
const CHECK_INTERVAL_MS = 60000
const FIRST_RUN_DELAY_MS = 5000
const RETRY_INTERVAL_FLOOR_MIN = 10
/** 冷却到期后的复测节奏：限流通常几分钟就过去，等一整轮（可能几小时）太慢 */
const RECOVERY_INTERVAL_MIN = 10

export function startProbeScheduler({
  runProbes,
  collectMonitor = null,
  recheckDetours = null,
  logger = console,
  // 测试用：e2e 要把「60 秒一轮」压到亚秒级才验得出「到点关、到点开」
  tickMs = Number(process.env.MANAGE_API_PROBE_TICK_MS) || CHECK_INTERVAL_MS,
  firstDelayMs = Number(process.env.MANAGE_API_PROBE_FIRST_DELAY_MS) || FIRST_RUN_DELAY_MS,
}) {
  let running = false
  let collecting = false
  let refreshingFx = false
  let rechecking = false
  // 暂停状态只在「翻转」时打一条日志：每分钟刷一条会把日志淹掉
  let pausedLogged = false

  async function tick() {
    if (running) return

    let db
    try {
      db = await store.readDb()
    } catch (error) {
      logger.warn?.(`[定时探测] 读取数据失败：${error.message}`)
      return
    }

    // --------------------------------------------------------------- 汇率
    // 12 小时一次；手动模式下 shouldRefresh 直接返回 false，不会覆盖用户填的值。
    if (!refreshingFx) {
      const fx = fxLib.ensureFx(db.settings)
      if (fxLib.shouldRefresh(fx)) {
        refreshingFx = true
        try {
          const result = await fxLib.refreshFx({ logger })
          if (result.ok) logger.info?.(`[汇率] 已更新：1 USD = ${result.fx.rates.CNY} CNY（${result.fx.source}）`)
        } catch (error) {
          logger.warn?.(`[汇率] 刷新失败：${error.message}`)
        } finally {
          refreshingFx = false
        }
      }
    }

    // --------------------------------------------------------------- 监控采集
    // 和探针分开：探测要打真实请求（耗钱），采集只是读后台数据，节奏可以更勤。
    if (collectMonitor && !collecting) {
      const monitorMinutes = Number(db.settings.monitorIntervalMinutes) || 0
      const lastRun = db.monitor?.lastRunAt ? new Date(db.monitor.lastRunAt).getTime() : 0
      const due = monitorMinutes > 0 && db.providers.length > 0 && (!lastRun || Date.now() - lastRun >= monitorMinutes * 60000)
      if (due) {
        collecting = true
        try {
          const results = await collectMonitor({ logger })
          logger.info?.(`[监控] 本轮采集 ${results.length} 个站点`)
        } catch (error) {
          logger.warn?.(`[监控] 采集失败：${error.message}`)
        } finally {
          collecting = false
        }
      }
    }

    // --------------------------------------------------------------- 改道复检
    // 空回合守卫把原站挂起后，这里每 20 分钟悄悄摸一次（见核心模块 DETOUR_RECHECK_MS）。
    // 放在「探测间隔 <= 0 就直接返回」之前：用户可能关掉了定时探测，但改道
    // 必须能自己解除，否则流量会永远停在别家
    if (recheckDetours && !rechecking) {
      rechecking = true
      try {
        const results = await recheckDetours({ logger })
        if (results.length > 0) {
          const back = results.filter((r) => r.resolved === 'recovered').length
          logger.info?.(`[改道复检] 检查 ${results.length} 条，${back} 条已恢复并切回`)
        }
      } catch (error) {
        logger.warn?.(`[改道复检] 失败：${error.message}`)
      } finally {
        rechecking = false
      }
    }

    const intervalMinutes = Number(db.settings.probeIntervalMinutes) || 0

    // --------------------------------------------------------------- 暂停时段
    // 放在到期判断之前：窗口内连「谁该探」都不用算，一个请求都不发。
    // 注意只暂停探针，监控采集照常——采集是读站方后台，不烧额度。
    const pause = pauseStatus(db.settings.probePauseWindows)
    if (pause.paused) {
      if (!pausedLogged) {
        logger.info?.(
          `[定时探测] 进入暂停时段，${pause.until ? `${pause.until} 自动恢复` : '全天暂停，等配置改动'}`,
        )
        pausedLogged = true
      }
      return
    }
    if (pausedLogged) {
      logger.info?.('[定时探测] 暂停时段结束，恢复探测')
      pausedLogged = false
    }
    // 「定时探测 = 关闭」只关「例行体检」，不关自愈：冷却到期/待复测的供给必须
    // 有人去验，否则永远回不来。以前这一句早退在复测判定之前，于是关掉定时探测
    // 之后，冷却中的供给就再也不会有新证据（路由也不放行），永久锁死。
    const selfHealOnly = intervalMinutes <= 0
    // 不健康 / 证据不足 / 过期的供给加密补测，让问题站点尽快拿到新证据
    const retryMinutes = Math.max(RETRY_INTERVAL_FLOOR_MIN, Math.round(intervalMinutes / 3))
    // 到期候选只用「在役」供给（未下线/站点未暂停/未忽略）——与 runProbes 同口径。
    // 此前直接对全量 db.offers 取前 10 个：下线行永久留在库前部且 lastProbeAt
    // 不更新，一旦占满名额，每轮探测 0 个目标，在役供给被饿死、评分陆续过期
    const routable = inv.routeableOffers(db)
    if (routable.length === 0) return

    const scores = scoreOffers(db.probes, db.traffic, {
      maxAgeMs: (Number(db.settings.scoreMaxAgeHours) || 6) * 3600 * 1000,
    })
    const now = Date.now()
    const due = routable
      .filter((offer) => {
        const score = scores.get(offer.id)
        // 自愈模式不主动给新供给「开张」：只补冷却/待复测这几条，其余照旧不探
        if (!score || !score.lastProbeAt) return !selfHealOnly
        // 冷却中（限流/模型不在分组）探了也是白探：等窗口到了再验
        if (score.blocked && score.blocked.until > now) return false
        // 冷却已到、但最近一次证据仍是「等它自己恢复」的那几类：按复测节奏探，
        // 探到成功才算恢复（见 score.pendingRecovery）——不复测就会永远停在那里。
        // 余额不足/单次超限已经不在 pendingRecovery 里（充值/缩小请求后本来就该
        // 立刻能试），它们会走下面的例行探测或直接由真实调用自证。
        if (score.pendingRecovery) {
          return now - new Date(score.lastProbeAt).getTime() >= RECOVERY_INTERVAL_MIN * 60000
        }
        if (selfHealOnly) return false
        // 「健康但有完整性疑点」也要加密探测：截断/虚报要 2 个样本才定性，
        // 只测到 1 次异常时状态还是 healthy，若按基础间隔等一小时才补第二针，
        // 真砍额度的站会被放过一小时。这里让它走重试间隔，20 分钟内见分晓
        const integritySuspect = score.integrity !== null && score.integrity < 0.999
        const healthy = score.status === 'healthy' && !integritySuspect
        const minutes = healthy ? intervalMinutes : retryMinutes
        return now - new Date(score.lastProbeAt).getTime() >= minutes * 60000
      })
      .slice(0, MAX_PER_TICK)

    if (due.length === 0) return

    running = true
    try {
      logger.info?.(`[定时探测] ${due.length} 个目标到期，开始探测`)
      const results = await runProbes({ offerIds: due.map((o) => o.id), limit: MAX_PER_TICK })
      const okCount = results.filter((r) => r.ok).length
      logger.info?.(`[定时探测] 完成 ${results.length} 个，成功 ${okCount}`)
    } catch (error) {
      logger.warn?.(`[定时探测] 失败：${error.message}`)
    } finally {
      running = false
    }
  }

  const timer = setInterval(tick, tickMs)
  setTimeout(tick, firstDelayMs)

  return () => clearInterval(timer)
}
