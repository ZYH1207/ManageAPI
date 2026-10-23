/**
 * 定时探测调度器。
 *
 * 每分钟检查一次：哪些供给距上次探测已超过设定间隔，挑最多 10 个去探。
 * 用「检查 + 到期判断」而不是「长间隔 setInterval」，这样改配置能立即生效，
 * 也不会因为一次探测耗时较长而错过下一轮。
 */
import * as store from '../core/store.js'
import * as fxLib from '../core/fx.js'
import { scoreOffers } from '../core/score.js'

const MAX_PER_TICK = 10
const CHECK_INTERVAL_MS = 60000
const FIRST_RUN_DELAY_MS = 5000

export function startProbeScheduler({ runProbes, collectMonitor = null, logger = console }) {
  let running = false
  let collecting = false
  let refreshingFx = false

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
    if (db.offers.length === 0) return

    const scores = scoreOffers(db.probes, db.traffic, {
      maxAgeMs: (Number(db.settings.scoreMaxAgeHours) || 6) * 3600 * 1000,
    })
    const now = Date.now()
    const due = db.offers
      .filter((offer) => {
        const score = scores.get(offer.id)
        if (!score || !score.lastProbeAt) return true
        return now - new Date(score.lastProbeAt).getTime() >= intervalMinutes * 60000
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

  const timer = setInterval(tick, CHECK_INTERVAL_MS)
  setTimeout(tick, FIRST_RUN_DELAY_MS)

  return () => clearInterval(timer)
}
