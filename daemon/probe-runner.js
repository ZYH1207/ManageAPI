/**
 * 探测执行器：HTTP 路由和定时调度共用同一份逻辑。
 */
import * as store from '../core/store.js'
import * as inv from '../core/inventory.js'
import { probeModel } from '../core/probe.js'

/**
 * @param {{providerId?:string, offerId?:string, offerIds?:string[], limit?:number}} options
 * @returns {Promise<Array>} 每个目标的探测结果
 */
export async function runProbes({ providerId, offerId, offerIds, limit = 5 } = {}) {
  const db = await store.readDb()

  // 探针目标与路由/比价同口径：下线、暂停、忽略的都不探（手动指定 offerId 时也拦，避免定时任务漏网）。
  // 过滤规则唯一实现见 inv.routeableOffers——此前这里漏了 delistedAt，下线模型仍被定时探测白烧额度。
  let targets = inv.routeableOffers(db)
  if (offerId) targets = targets.filter((o) => o.id === offerId)
  else if (Array.isArray(offerIds) && offerIds.length > 0) {
    const wanted = new Set(offerIds)
    targets = targets.filter((o) => wanted.has(o.id))
  } else if (providerId) targets = targets.filter((o) => o.providerId === providerId)

  const credentialFor = (offer) =>
    (offer.credentialId && db.credentials.find((c) => c.id === offer.credentialId)) ||
    db.credentials.find(
      (c) => c.providerId === offer.providerId && (c.group || '') === (offer.group || ''),
    ) ||
    db.credentials.find((c) => c.providerId === offer.providerId)

  targets = targets.filter((offer) => credentialFor(offer))
  // 前端点名的 offerIds 照单全收：那是用户按筛选条件勾好的清单，截断会让
  // 「探测所选」悄悄少探。限量只管无差别调用（定时轮巡、老版不带筛选的「探测全部」）。
  if (!offerId && !(Array.isArray(offerIds) && offerIds.length > 0)) targets = targets.slice(0, limit)

  // 4 路并发：一轮 10 个目标串行跑满 45 秒超时时要 7 分钟以上，
  // 站点会在这期间持续处于「探针过期」而掉出路由池。写盘仍由 mutate 串行，
  // 并发只影响网络等待，不影响数据一致性
  const CONCURRENCY = 4
  const results = new Array(targets.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < targets.length) {
      const index = cursor
      cursor += 1
      const offer = targets[index]
      const provider = db.providers.find((p) => p.id === offer.providerId)
      if (!provider) continue
      const credential = credentialFor(offer)
      const apiKey = await inv.revealSecret(credential.id)
      if (!apiKey) {
        results[index] = { offerId: offer.id, providerId: offer.providerId, ok: false, error: 'Key 解密失败' }
        continue
      }
      const record = await probeModel({
        baseUrl: provider.baseUrl,
        apiKey,
        model: offer.upstreamName,
        timeoutMs: db.settings.probeTimeoutMs || 45000,
      })
      // 先只收集结果，落盘在批量网络异常判断之后（见下）
      results[index] = { offerId: offer.id, providerId: offer.providerId, ...record }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()),
  )

  // ---- 批量网络异常防护：本机断网/代理挂了时，一轮探测会「所有站一起失败」。
  // 那不是站点的问题，写进评分会让几十条供给同时变红（真实踩过：代理断线
  // 造成 9 条 fetch failed）。判据：失败样本 ≥3、网络类错误占比 ≥60%，
  // 且这些网络失败跨了 ≥2 个站——只挂一个站（哪怕它下面 10 个模型全挂）
  // 是那个站的问题，必须照常记账，否则真故障永远测不出来。
  const failed = results.filter((r) => r && r.ok === false)
  const netFailed = failed.filter((r) =>
    /timeout|aborted|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|网络/i.test(String(r.error || '')),
  )
  const netProviders = new Set(netFailed.map((r) => r.providerId))
  const localNetworkOutage =
    failed.length >= 3 && netFailed.length / failed.length >= 0.6 && netProviders.size >= 2
  if (localNetworkOutage) {
    return results.filter(Boolean).map((r) => ({ ...r, skipped: 'local-network-outage' }))
  }

  for (const record of results) {
    if (!record) continue
    if (record.error === 'Key 解密失败') continue // 没有真实探测，不写评分
    const { skipped, ...clean } = record
    await inv.recordProbe({
      ...clean,
      modelKey: targets.find((t) => t.id === record.offerId)?.modelKey,
    })
  }
  return results.filter(Boolean)
}
