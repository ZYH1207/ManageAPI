/**
 * 定时探测调度器。
 *
 * 每分钟检查一次：哪些供给距上次探测已超过设定间隔，挑最多 10 个去探。
 * 用「检查 + 到期判断」而不是「长间隔 setInterval」，这样改配置能立即生效，
 * 也不会因为一次探测耗时较长而错过下一轮。
 *
 * 间隔是自适应的：健康站按用户设定的基础间隔，其它站（不健康 / 证据不足 /
 * 过期 / 从没探过）按 1/3 间隔（最少 10 分钟）补测——问题站点应该尽快拿到
 * 新证据，而不是等一整轮。冷却中的供给（额度不足/限流）在冷却窗口内直接跳过；
 * 冷却到期后按 RECOVERY_INTERVAL_MIN 复测，探到成功才重新放行（路由侧看
 * score.pendingRecovery，不看钟）。
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
  logger = console,
  // 测试用：e2e 要把「60 秒一轮」压到亚秒级才验得出「到点关、到点开」
  tickMs = Number(process.env.MANAGE_API_PROBE_TICK_MS) || CHECK_INTERVAL_MS,
  firstDelayMs = Number(process.env.MANAGE_API_PROBE_FIRST_DELAY_MS) || FIRST_RUN_DELAY_MS,
}) {
  let running = false
  let collecting = false
  let refreshingFx = false
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

    const intervalMinutes = Number(db.settings.probeIntervalMinutes) || 0
    if (intervalMinutes <= 0) return

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
        if (!score || !score.lastProbeAt) return true
        // 冷却中（额度不足/限流/模型不在分组）探了也是白探：等冷却结束再验
        if (score.blocked && score.blocked.until > now) return false
        // 冷却已到、但最近一次证据仍是「暂时不可用」（额度/限流/模型不在分组）：
        // 按复测节奏探，探到成功才算恢复。路由在恢复前一直不放行（见
        // score.pendingRecovery）——不复测就会永远停在那里，复测太慢又会把站晾着
        if (score.pendingRecovery) {
          return now - new Date(score.lastProbeAt).getTime() >= RECOVERY_INTERVAL_MIN * 60000
        }
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
