/**
 * 监控采集执行器：HTTP 路由（手动刷新）与定时调度共用同一份逻辑。
 *
 * 一个站一轮采三样东西，各自独立失败：
 *   1. 余额      —— 有 Key 才试；失败只记原因，不当成整轮失败
 *   2. 公告      —— 公共接口，拿不到就算了，不打扰用户
 *   3. 倍率/价格 —— 需要站点后台令牌（adminToken），没有就跳过
 *
 * 全程不发 HttpError：调度器里没人接异常，网络错误必须被消化成 runs 里的一行。
 */
import * as store from '../core/store.js'
import * as inv from '../core/inventory.js'
import * as providers from '../core/providers.js'
import { applySnapshot, recordRun } from '../core/monitor.js'
import { localDayKey } from '../core/dates.js'

/**
 * @param {{providerId?:string|null, logger?:Console}} options
 * @returns {Promise<Array<{providerId:string, ok:boolean, ms:number,
 *          changes:number, announcements:number, alerts:number, error:string}>>}
 */
export async function collectProviderSnapshots({ providerId = null, logger = console } = {}) {
  const db = await store.readDb()
  // 暂停的站点不采：既不刷余额也不打后台接口
  const targets = db.providers.filter((p) => !p.paused && (!providerId || p.id === providerId))
  const results = []

  for (const provider of targets) {
    const started = Date.now()
    const at = new Date().toISOString()
    const snap = { providerId: provider.id, at }
    const errors = []

    // 余额要试该站**所有** Key（与 sync 同口径）：只试第一把的话，
    // 旧 Key 过期后新加的 Key 永远轮不上，余额就一直读不到
    const apiKeys = []
    for (const credential of db.credentials.filter((c) => c.providerId === provider.id)) {
      const secret = await inv.revealSecret(credential.id)
      if (secret) apiKeys.push(secret)
    }
    const apiKey = apiKeys[0] || ''
    const adminToken = await inv.revealAdminToken(provider.id)

    // ---------------------------------------------------------------- 余额
    if (apiKey || adminToken) {
      try {
        snap.balance = await providers.tryBalanceWithKeys({
          baseUrl: provider.baseUrl,
          apiKeys,
          adminToken,
          kind: provider.kind,
          timeoutMs: 10000,
        })
        // ok:false 的 reason 由 applySnapshot 记成 info 级告警，不算采集失败
      } catch (error) {
        errors.push(`余额：${error.message}`)
      }
    }

    // ------------------------------------------------------------ 站点账单
    // 「实际消费」只认站点自己的账：网关侧估算缺 26% 的 token、上游 cached
    // 字段也不可靠，拿它算钱必然对不上。sub2api 系的 /api/v1/usage 有逐条明细，
    // 按天取一次即可（当天累计值会随使用增长，每次采集覆盖写入）。
    if (adminToken && (provider.kind === 'sub2api' || provider.kind === 'unknown')) {
      // 今天每次采集都覆盖（当天累计值在增长）；最近 6 天在「缺记录」或
      // 「记录不可信」时回填，否则「本周/本月」永远只有今天一个数。
      //
      // 「记录不可信」有两种，都必须重拉：
      //   truncated    —— 上次翻页没拉全（单页上限 1000，高峰期一天能到 995+）
      //   legacy       —— 分页修复前写入的老记录没带 fetchedAt 字段，
      //                   无法判断是否完整，按不可信处理（重拉一次就带上了）
      const known = db.monitor?.siteSpend?.[provider.id] || {}
      const today = new Date()
      const needsRefetch = (row) => !row || row.truncated === true || !row.fetchedAt
      const wanted = [0]
      for (let i = 1; i <= 6; i += 1) {
        const d = new Date(today)
        d.setDate(d.getDate() - i)
        if (needsRefetch(known[localDayKey(d)])) wanted.push(i)
      }
      // 并发拉：逐天串行时 7 天要 7 个往返，慢站会把整轮采集拖超时
      const dayList = wanted.map((offset) => {
        const d = new Date(today)
        d.setDate(d.getDate() - offset)
        return { offset, day: localDayKey(d) }
      })
      const settled = await Promise.all(
        dayList.map(async ({ day }) => {
          try {
            const spend = await providers.fetchSiteDailySpend({
              baseUrl: provider.baseUrl,
              adminToken,
              date: day,
              timeoutMs: 12000,
            })
            return [day, spend]
          } catch {
            // 读不到账单不是采集失败：站点可能没开 usage 接口，或令牌只读余额
            return null
          }
        }),
      )
      const days = Object.fromEntries(settled.filter(Boolean))
      if (Object.keys(days).length > 0) snap.siteSpendDays = days
    }

    // ---------------------------------------------------------------- 公告
    try {
      snap.announcements = await providers.fetchAnnouncements({
        baseUrl: provider.baseUrl,
        apiKey,
        adminToken,
        kind: provider.kind,
      })
    } catch {
      /* 公告拿不到不影响任何判断 */
    }

    // ---------------------------------------------------------- 倍率与价格
    // channels/available 对所有系别都试（404 已静默跳过、告警噪音已修）：
    // 现实里存在「/api/status 出公告 + channels 出倍率」的混合站，按 kind
    // 硬排除会误伤——系别分支保留在收益明确的 tryBalance/公告上
    if (adminToken) {
      try {
        const pricing = await providers.fetchAvailableChannels({
          baseUrl: provider.baseUrl,
          adminToken,
        })
        snap.groups = pricing.groups
        snap.models = pricing.models
        await inv.setTokenStatus(provider.id, { ok: true })
      } catch (error) {
        // 404 = 这个站没有 Sub2API 的可用渠道接口（one-api/new-api 系就没有），
        // 属于「不支持」而不是「采集失败」——记一行日志即可，不进 errors；
        // 否则每轮采集都出一条 danger 告警（约一天 12 条/站），淹没真正的告警
        if (/HTTP 404/.test(String(error?.message || ''))) {
          logger.info?.(`[监控] ${provider.name}：无可用渠道接口（404），跳过倍率采集`)
        } else {
          errors.push(`倍率：${error.message}`)
          // 401/403 才是令牌失效；超时、404、结构不对都不该给令牌判死刑
          if (/HTTP (401|403)/.test(String(error?.message || ''))) {
            await inv.setTokenStatus(provider.id, { ok: false, message: error.message })
          }
        }
      }
    }

    if (errors.length > 0) snap.error = errors.join('；')

    const ms = Date.now() - started
    const applied = await store.mutate((current) => {
      const out = applySnapshot(current, snap)
      // 余额是账号级的，顺手写回站点——站点卡片上就能看到最新值
      if (snap.balance?.ok) {
        const target = current.providers.find((p) => p.id === provider.id)
        if (target) {
          target.quotaRemaining = snap.balance.remaining
          target.currency = snap.balance.currency
          target.quotaUpdatedAt = at
        }
      }
      recordRun(current, {
        providerId: provider.id,
        at,
        ok: !snap.error,
        ms,
        error: snap.error || '',
      })
      return out
    })

    results.push({
      providerId: provider.id,
      ok: !snap.error,
      ms,
      changes: applied.changes.length,
      announcements: applied.newAnnouncements.length,
      alerts: applied.alerts.length,
      error: snap.error || '',
    })

    const tail = [
      snap.balance?.ok ? `余额 ${snap.balance.remaining}` : '',
      applied.changes.length ? `${applied.changes.length} 项变动` : '',
      applied.newAnnouncements.length ? `${applied.newAnnouncements.length} 条新公告` : '',
      snap.error || '',
    ]
      .filter(Boolean)
      .join('，')
    logger.info?.(`[监控] ${provider.name}：${tail || '无变化'}（${ms}ms）`)
  }

  return results
}
