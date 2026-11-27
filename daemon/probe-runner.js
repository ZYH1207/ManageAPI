/**
 * 探测执行器：HTTP 路由和定时调度共用同一份逻辑。
 */
import * as store from '../core/store.js'
import * as inv from '../core/inventory.js'
import { probeModel } from '../core/probe.js'
import { scoreOffers } from '../core/score.js'
import {
  isNonChatModel,
  isTransientError,
  lastCacheProbeAt,
  pickProbeTargets,
  probeTimeoutMsOf,
  providerCooldowns,
  shouldProbeCache,
} from '../core/probe-policy.js'

/**
 * @param {{providerId?:string, offerId?:string, offerIds?:string[], limit?:number, deep?:boolean}} options
 * @returns {Promise<Array>} 每个目标的探测结果
 */
export async function runProbes({ providerId, offerId, offerIds, limit = 5, deep = false } = {}) {
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

  // ---- 批量目标怎么挑：最久没探的先探，冷却中的站跳过。
  // 以前这里是 targets.slice(0, limit)：顺序永远是数据里的固定顺序，于是手点
  // 「探测全部」每次都打同前 5 条（13 条在售供给时后面 8 条只能等定时任务），
  // 而且完全不看冷却——429 的站被反复砸，只会把限流拖得更久。
  // 定时任务会显式传 offerIds（它自己已经算过到期顺序与冷却）：名单说了算，
  // 这里只按 limit 截断；只有「没给名单」的手动/站点级批量才由这里挑目标。
  // 挑选规则本身是纯函数（pickProbeTargets），有单测盯着。
  const explicitList = Array.isArray(offerIds) && offerIds.length > 0
  let coolingRows = []
  if (explicitList) {
    targets = targets.slice(0, limit)
  } else if (!offerId) {
    const scores = scoreOffers(db.probes, db.traffic, {
      maxAgeMs: (Number(db.settings?.scoreMaxAgeHours) || 6) * 3600 * 1000,
    })
    const cooldowns = providerCooldowns(scores, (id) => db.offers.find((o) => o.id === id)?.providerId)
    const picked = pickProbeTargets({ offers: targets, probes: db.probes, cooldowns, limit })
    targets = picked.targets
    coolingRows = picked.cooling
  }

  // 4 路并发：一轮 10 个目标串行跑满 45 秒超时时要 7 分钟以上，
  // 站点会在这期间持续处于「探针过期」而掉出路由池。写盘仍由 mutate 串行，
  // 并发只影响网络等待，不影响数据一致性
  const timeoutMs = probeTimeoutMsOf(db.settings)
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
      // 画图 / 向量 / 语音这类模型拿 chat/completions 打必然 400，
      // 白白拉低可用率，还每次记一条「失败」——直接跳过，不写评分。
      if (isNonChatModel(offer.upstreamName)) {
        results[index] = {
          offerId: offer.id,
          providerId: offer.providerId,
          ok: false,
          skipped: 'non-chat-model',
          error: '非对话模型，不用 chat 探针',
        }
        continue
      }
      const skipCache = !shouldProbeCache(lastCacheProbeAt(db.probes, offer.id))
      // 身份自述只记录、不评分（模型自述经常是错的），日常每轮白打一发没意义：
      // 只在「这条供给第一次探」或单条深探（人点的那一下）时才问。
      const skipIdentity = !deep && db.probes.some((p) => p.offerId === offer.id)
      const probeOnce = () =>
        probeModel({
          baseUrl: inv.apiBaseOf(provider),
          apiKey,
          model: offer.upstreamName,
          timeoutMs,
          skipCache,
          skipIdentity,
        })
      let record = await probeOnce()
      // 瞬时错误（5xx / 超时 / 连接没建立）先重试一次：一针定生死会把
      // 「站点此刻忙」记成「不可用」，手动点探测时体感尤其差。
      if (record.ok === false && isTransientError(record.error)) {
        await new Promise((resolve) => setTimeout(resolve, 800))
        const again = await probeOnce()
        again.retried = true
        record = again
      }
      // 先只收集结果，落盘在批量网络异常判断之后（见下）
      results[index] = { offerId: offer.id, providerId: offer.providerId, ...record }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()),
  )

  // ---- 批量网络异常防护：本机断网/代理挂了时，一轮探测会「所有站一起失败」。
  // 那不是站点的问题，写进评分会让几十条供给同时变红（真实踩过：代理断线
  // 造成 9 条 fetch failed）。判据：失败样本 ≥2、网络类错误占比 ≥60%，
  // 且这些网络失败跨了 ≥2 个站——只挂一个站（哪怕它下面 10 个模型全挂）
  // 是那个站的问题，必须照常记账，否则真故障永远测不出来。
  // （原来是 ≥3 条：一轮最多 10 个目标，只抖动 1~2 条时整轮照样落库，
  //   把本机抖动写成了站点故障——这正是「网络波动污染排名」的主因。）
  const failed = results.filter((r) => r && r.ok === false)
  const netFailed = failed.filter((r) =>
    /timeout|aborted|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|网络/i.test(String(r.error || '')),
  )
  const netProviders = new Set(netFailed.map((r) => r.providerId))
  const localNetworkOutage =
    failed.length >= 2 && netFailed.length / failed.length >= 0.6 && netProviders.size >= 2
  if (localNetworkOutage) {
    return [
      ...results.filter(Boolean).map((r) => ({ ...r, skipped: 'local-network-outage' })),
      ...coolingRows,
    ]
  }

  // ---- 首字相对化：绝对毫秒里含本机链路（带宽/运营商抖动/家里路由器），
  // 跨轮不可比，也解释不了「为什么这个站排后面」。同一轮里所有目标的链路
  // 条件是同一份，减去本轮最快的那条，剩下的才是站点自身的首字差异。
  // 老记录没有 ttftRel，读取侧会回落到绝对值，所以不用迁移数据。
  const roundId = `r${Date.now()}`
  const okTtfts = results
    .filter((r) => r && r.ok !== false && typeof r.ttftMs === 'number' && r.ttftMs > 0)
    .map((r) => r.ttftMs)
  const roundMinTtft = okTtfts.length > 0 ? Math.min(...okTtfts) : null
  for (const r of results) {
    if (!r) continue
    r.roundId = roundId
    r.ttftRel =
      roundMinTtft !== null && typeof r.ttftMs === 'number' && r.ttftMs > 0
        ? Math.max(0, r.ttftMs - roundMinTtft)
        : null
  }

  for (const record of results) {
    if (!record) continue
    if (record.error === 'Key 解密失败') continue // 没有真实探测，不写评分
    if (record.skipped) continue // 跳过类的（非对话模型 / 本机断网）不写评分
    const { skipped, ...clean } = record
    await inv.recordProbe({
      ...clean,
      modelKey: targets.find((t) => t.id === record.offerId)?.modelKey,
    })
  }
  return [...results.filter(Boolean), ...coolingRows]
}
