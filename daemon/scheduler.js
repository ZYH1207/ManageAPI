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
 *
 * 连锁机制：自动路由开着时，定时探针整体让位——实时性由轮巡保证（autoprobe），
 * 固定定时探针纯属重复花钱。这个门只看自动路由的**开关状态**：轮巡因流量安静
 * 自动停下时，定时探针也不恢复（自动路由模式还在，下波流量轮巡接着接管）；
 * 只有手动关掉自动路由，探测职责才交还给定时探针。
 */
import * as store from '../core/store.js'
import * as inv from '../core/inventory.js'
import * as fxLib from '../core/fx.js'
import { pauseStatus } from '../core/schedule.js'
import { scoreOffers } from '../core/score.js'
import { normalizeAutoRoute } from '../core/auto-route.js'
import { admissionOfScore } from '../core/router.js'
import { probeEgress } from '../core/egress.js'
import { NETWORK_FAILURE } from '../core/failure.js'

const MAX_PER_TICK = 10
const CHECK_INTERVAL_MS = 60000
const FIRST_RUN_DELAY_MS = 5000
const RETRY_INTERVAL_FLOOR_MIN = 10
/** 冷却到期后的复测节奏：限流通常几分钟就过去，等一整轮（可能几小时）太慢 */
const RECOVERY_INTERVAL_MIN = 10
/**
 * 站点账单同步的默认节奏（分钟）。
 * 账单是「实际花了多少钱」和「真实单价」的唯一权威来源，但它不像余额那样
 * 需要分钟级新鲜度——当天累计值几分钟才涨一点，10 分钟一轮够用，
 * 也不会把慢站（翻 5 页要 5 秒）压得太频繁。
 */
const LEDGER_INTERVAL_DEFAULT = 10
/**
 * 出口自检的自动补跑间隔。
 *
 * 只在「检测到跨站网络失败」时才跑——不是定时轮询。判据与跨站同簇防护
 * 用的是同一个正则（core/failure.js#NETWORK_FAILURE），这样「哪些失败算网络类」
 * 不会出现两套口径。
 *
 * 10 分钟的理由：网络抖动通常几秒到几十秒，补跑一次就能拿到对照证据；
 * 但真断网时每 tick 都跑会白白增加代理日志。10 分钟内已经有一轮自检就不再跑。
 */
const EGRESS_AUTO_PROBE_COOLDOWN_MS = 10 * 60_000

export function startProbeScheduler({
  runProbes,
  collectMonitor = null,
  recheckDetours = null,
  // 自动路由活跃期的探针轮巡（daemon/autoprobe.js）：放在间隔/暂停时段检查之前，
  // 它是被真实流量驱动的，不受定时探针的开关与暂停时段约束
  autoProbe = null,
  // 真实价速比漂移监视器（daemon/drift-watcher.js）：每分钟判一次漂移、执行转移，
  // 也放在间隔/暂停检查之前——它同样只由自动路由开关与真实流量驱动
  driftWatcher = null,
  // 站点账单同步（daemon/ledger-runner.js）：把各站自己的走账清单拉回来。
  // 和监控采集同档（纯读后台、不烧 token），但独立到期判断，见下面的账板块
  syncLedger = null,
  logger = console,
  // 测试用：e2e 要把「60 秒一轮」压到亚秒级才验得出「到点关、到点开」
  tickMs = Number(process.env.MANAGE_API_PROBE_TICK_MS) || CHECK_INTERVAL_MS,
  firstDelayMs = Number(process.env.MANAGE_API_PROBE_FIRST_DELAY_MS) || FIRST_RUN_DELAY_MS,
}) {
  let running = false
  let collecting = false
  let refreshingFx = false
  let rechecking = false
  // 账单同步正在跑：翻页慢站一轮要几秒到十几秒，不加锁会被下一分钟的 tick 重入
  let ledgerSyncing = false
  // 出口自检正在跑：三个对照目标并发，通常 < 2 秒，但断网时可能卡满超时
  let egressProbing = false
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

    // ------------------------------------------------------------ 出口自检补跑
    //
    // 只在「最近确实有网络类失败」时补跑，不是定时轮询：没有失败就没有对照需求，
    // 每分钟发三个请求只是白增代理日志。
    //
    // 触发判据刻意复用 NETWORK_FAILURE（与跨站同簇防护同一个正则）。2026-11-14
    // 的教训就是这一层用了两套口径：一个认得 EHOSTUNREACH、一个不认，于是断网时
    // 防护瞎了、自检也没被触发，用户在「站点全红」和「其实是我断网」之间耗了半小时。
    if (!egressProbing) {
      const lastAt = Date.parse(db.egress?.latest?.at || '')
      const stale = !Number.isFinite(lastAt) || Date.now() - lastAt >= EGRESS_AUTO_PROBE_COOLDOWN_MS
      if (stale) {
        const since = Date.now() - 10 * 60_000
        const recentFailed = (db.routing || []).some(
          (r) =>
            Date.parse(r.ts || '') >= since &&
            (r.failures || []).some((f) => NETWORK_FAILURE.test(String(f?.error || ''))),
        )
        if (recentFailed) {
          egressProbing = true
          try {
            const record = await probeEgress()
            await store.mutate((d) => {
              if (!d.egress || typeof d.egress !== 'object') d.egress = { latest: null, history: [] }
              d.egress.latest = record
              const history = Array.isArray(d.egress.history) ? d.egress.history : []
              history.push(record)
              d.egress.history = history.slice(-50)
              return d
            })
            const ok = record.targets.filter((t) => t.ok).length
            logger.info?.(`[出口自检] 有网络类失败，补跑一轮：${ok}/${record.targets.length} 个对照地址通`)
          } catch (error) {
            logger.warn?.(`[出口自检] 失败：${error.message}`)
          } finally {
            egressProbing = false
          }
        }
      }
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

    // ------------------------------------------------------------ 站点账单同步
    // 跟监控采集同一档节奏（都是纯读后台、不烧 token），但**独立判断是否到期**：
    // 采集挂掉不该连带账单停更，账单是比价和台账校验的唯一权威数据源。
    // 放在「探测间隔 <= 0 就返回」之前——关掉定时探针的人照样要账单。
    if (syncLedger && !ledgerSyncing) {
      // 0 = 明确关闭，必须显式判 null/undefined 再取默认值。
      // 写成 `Number(x) || DEFAULT` 会把 0 当成"没填"→ 关不掉（实测踩过）
      const rawInterval = db.settings.ledgerIntervalMinutes
      const ledgerMinutes =
        rawInterval === null || rawInterval === undefined || rawInterval === ''
          ? LEDGER_INTERVAL_DEFAULT
          : Number(rawInterval)
      const lastLedger = db.ledgerSyncedAt ? new Date(db.ledgerSyncedAt).getTime() : 0
      const ledgerDue =
        Number.isFinite(ledgerMinutes) &&
        ledgerMinutes > 0 &&
        db.providers.length > 0 &&
        (!lastLedger || Date.now() - lastLedger >= ledgerMinutes * 60000)
      if (ledgerDue) {
        ledgerSyncing = true
        try {
          const res = await syncLedger({ logger })
          const ok = (res.providers || []).filter((p) => p.ok).length
          logger.info?.(`[账单] 本轮同步 ${ok}/${(res.providers || []).length} 个站点`)
        } catch (error) {
          logger.warn?.(`[账单] 同步失败：${error.message}`)
        } finally {
          // 时间戳由调度器自己写，不交给注入的 syncLedger——依赖调用方
          // "记得写"是脆弱设计：少写一次就变成每轮都跑（实测每 120ms 跑一次）。
          // 失败也写：否则一个坏站会让整轮同步每分钟重试，把慢站压垮
          try {
            await store.mutate((d) => {
              d.ledgerSyncedAt = new Date().toISOString()
              return d
            })
          } catch (error) {
            logger.warn?.(`[账单] 记录同步时间失败：${error.message}`)
          }
          ledgerSyncing = false
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

    // ------------------------------------------------- 漂移监视（自动路由转移）
    if (driftWatcher) {
      try {
        await driftWatcher.tick()
      } catch (error) {
        logger.warn?.(`[漂移转移] 判定失败：${error.message}`)
      }
    }

    // ------------------------------------------------------- 自动路由轮巡
    // 也放在「探测间隔 <= 0 就直接返回」之前：用户可能关掉了定时探针，
    // 但自动路由在接真实流量时评分必须新鲜，这是它自己的事
    if (autoProbe && !running) {
      try {
        await autoProbe.tick()
      } catch (error) {
        logger.warn?.(`[自动路由探针] 轮巡失败：${error.message}`)
      }
    }

    // 连锁机制：自动路由开着 → 定时探针不跑（放在间隔/暂停检查之前，
    // 置于 autoProbe.tick 之后：轮巡自己不受这个门影响，该探照探）
    if (normalizeAutoRoute(db.settings.autoRoute).enabled) return

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
    // 余额探底的站不撞墙：自愈复检也跳过（余额回上线后自然回到候选，见 router.admissionOf）
    const depletedIds = new Set(db.providers.filter(inv.balanceDepleted).map((p) => p.id))
    const probeable = routable.filter((o) => !depletedIds.has(o.providerId))
    if (probeable.length === 0) return

    const scores = scoreOffers(db.probes, db.traffic, {
      maxAgeMs: (Number(db.settings.scoreMaxAgeHours) || 6) * 3600 * 1000,
      // 与 scoresFor 同一口径：重置界线之前的探针不参与评分。少传这一项，
      // 「重置了但调度器还按旧账判它健康/冷却」——两处口径漂移这个项目踩过太多次
      evidenceReset: db.evidenceReset || {},
    })
    const now = Date.now()
    const due = probeable
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
        // 半开（比率型冷却已过、失败率仍偏高）同样按复测节奏去探：
        // 它的 status 是 healthy（可用率可能已过 80%），会掉进下面的基础间隔，
        // 也就是一小时才补一针。而它恰恰是「刚被证明不稳、正等一条新证据」的状态，
        // 隔一小时才验一次等于把一条可能已经恢复的供给闲置一小时。
        // 与 pendingRecovery 同一档节奏，理由也相同：恢复看证据，证据得有人去取。
        if (score.halfOpen) {
          return now - new Date(score.lastProbeAt).getTime() >= RECOVERY_INTERVAL_MIN * 60000
        }
        // ---- 兜底：只要「准入会拒它」，就必须继续有人去验
        //
        // 上面三条（blocked / pendingRecovery / halfOpen）是「有名有姓」的自愈状态，
        // 但**不是所有拒绝态都有名字**。最典型的是 unstable（可用率 < 80%）：
        // 它是一个统计结论，blocked / pendingRecovery / halfOpen 三个字段全是 null。
        // 于是关掉定时探针之后：
        //
        //   准入拒绝它  → 永远拿不到真实流量（真实流量是唯一的另一个证据来源）
        //   自愈不认它  → 永远不会被复测
        //   => 它再也拿不到任何新证据，永久卡死在黑名单里
        //
        // 2026-11-07 穷举 1092 种「失败类型 × 证据年龄 × 样本数」组合实测，
        // 关闭定时探针后能踩出这些死锁路径：
        //   unstable（502/503、超时、失败率过高 ×3 条以上）
        //   degraded（指纹不符，单条即可定性）
        //   no-evidence（protocol-unsupported、我方缺陷被跳过但 samples 仍占位）
        //
        // 判据刻意用「准入是否放行」而不是枚举 kind：准入是唯一门禁，
        // 凡是过不去的都得有人去取新证据，这样以后新增任何拒绝原因都不会再漏。
        // 节奏与 pendingRecovery 同档（RECOVERY_INTERVAL_MIN），避免白烧额度。
        if (!admissionOfScore(score).ok) {
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

    // 二次检查再开跑：上面那排 await（汇率/采集/复检/漂移/轮巡）任何一个慢，
    // 本 tick 就会停在那里；期间新 tick 进来把 running 置 true 开始探测，
    // 本 tick 恢复后若不重新检查，就会与它并发再跑一轮 runProbes——
    // 重复烧钱 + 双份写盘（级联修复 2026-11-08）
    if (running) return
    running = true
    try {
      logger.info?.(`[定时探测] ${due.length} 个目标到期，开始探测`)
      const results = await runProbes({ offerIds: due.map((o) => o.id), limit: MAX_PER_TICK, cache: 'auto' })
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
