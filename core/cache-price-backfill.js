/**
 * 缓存价回填：给存量供给补上 `cacheReadSource` 标记，并区分三种「没有缓存价」。
 *
 * ── 为什么需要这个模块 ───────────────────────────────────────────
 *
 * `core/inventory.js#applySitePricing` 从 2026-11-12 起才写 `cacheReadSource`，
 * 在那之前导入的供给只有 `cacheReadPrice`（可能 null），没有任何来源信息。
 *
 * 结果是界面无法区分：
 *   「站点说缓存免费」  vs  「站点没公布」  vs  「站点压根没有价格接口」
 *
 * 这三件事的含义完全不同——前一种在比价里该按 0 算，后两种只能按输入价算。
 * 混在一起会让「没公布」被读成「缓存贵」，从而误判供给好坏。
 *
 * ── 判定规则（只用已有数据推，不猜）────────────────────────────
 *
 *   1. provider 有 adminToken 且其 kind 支持价格接口
 *      且这条 offer 的 inPrice 有值（说明当初是从站点价格表导的）
 *        → 有缓存价：'site-reported'（0 则 'explicit-zero'）
 *        → 没缓存价：'site-silent'（站点接口通了，但这条没这个字段）
 *   2. provider 没有可用价格接口（实测 rapid / 秋 的 /api/pricing 全 404）
 *        → 'no-source'
 *   3. 兜底：有 cacheReadPrice 就算 'site-reported'，否则 'no-source'
 */
import { normalizeGroup } from './store.js'

/** 实测没有 /api/pricing 的站点特征（名字/类型）。新增站点请用「试一次」而非死名单 */
const KNOWN_NO_PRICING_API = /rapid|sub2api/i

/**
 * 推断一条供给的缓存价来源。
 *
 * @param {object} offer
 * @param {object} provider
 * @returns {'site-reported'|'explicit-zero'|'site-silent'|'no-source'}
 */
export function inferCacheReadSource(offer, provider) {
  // 已有明确标记就尊重它（新导入的数据由 applySitePricing 写好了）
  if (offer.cacheReadSource) return offer.cacheReadSource

  const raw = offer.cacheReadPrice
  const hasValue = raw !== null && raw !== undefined && Number.isFinite(Number(raw))
  // 这条供给的价格是从站点价格表来的吗？inPrice 有值 = 当初确实读到了站点定价
  const fromSiteTable = offer.inPrice !== null && offer.inPrice !== undefined

  // 站点明显没有价格接口
  const noApi = KNOWN_NO_PRICING_API.test(String(provider?.kind || ''))
    || KNOWN_NO_PRICING_API.test(String(provider?.name || ''))

  if (fromSiteTable && !noApi) {
    if (!hasValue) return 'site-silent'
    return Number(raw) === 0 ? 'explicit-zero' : 'site-reported'
  }
  if (hasValue) return Number(raw) === 0 ? 'explicit-zero' : 'site-reported'
  return 'no-source'
}

/**
 * 批量回填。**就地修改 offers**，返回统计。
 *
 * 不做写盘——调用方决定何时持久化（当前实现是只改内存，重启即失效，
 * 因为它只是展示层的补充信息，不影响价格计算）。
 *
 * @param {object[]} offers
 * @param {object[]} providers
 */
export function backfillCacheReadSource(offers, providers) {
  const byId = new Map((providers || []).map((p) => [p.id, p]))
  const stats = { total: 0, patched: 0, bySource: {} }
  for (const offer of offers || []) {
    stats.total += 1
    const provider = byId.get(offer.providerId)
    const src = inferCacheReadSource(offer, provider)
    if (!offer.cacheReadSource) {
      offer.cacheReadSource = src
      stats.patched += 1
    }
    stats.bySource[offer.cacheReadSource] = (stats.bySource[offer.cacheReadSource] || 0) + 1
  }
  return stats
}
