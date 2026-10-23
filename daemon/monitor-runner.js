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

    const credential = db.credentials.find((c) => c.providerId === provider.id)
    const apiKey = credential ? await inv.revealSecret(credential.id) : ''
    const adminToken = await inv.revealAdminToken(provider.id)

    // ---------------------------------------------------------------- 余额
    if (apiKey || adminToken) {
      try {
        snap.balance = await providers.tryBalance({
          baseUrl: provider.baseUrl,
          apiKey,
          adminToken,
          timeoutMs: 10000,
        })
        // ok:false 的 reason 由 applySnapshot 记成 info 级告警，不算采集失败
      } catch (error) {
        errors.push(`余额：${error.message}`)
      }
    }

    // ---------------------------------------------------------------- 公告
    try {
      snap.announcements = await providers.fetchAnnouncements({
        baseUrl: provider.baseUrl,
        apiKey,
        adminToken,
      })
    } catch {
      /* 公告拿不到不影响任何判断 */
    }

    // ---------------------------------------------------------- 倍率与价格
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
        errors.push(`倍率：${error.message}`)
        // 401/403 才是令牌失效；超时、404、结构不对都不该给令牌判死刑
        if (/HTTP (401|403)/.test(String(error?.message || ''))) {
          await inv.setTokenStatus(provider.id, { ok: false, message: error.message })
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
