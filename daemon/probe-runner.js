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

  let targets = db.offers
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
  if (!offerId) targets = targets.slice(0, limit)

  const results = []
  for (const offer of targets) {
    const provider = db.providers.find((p) => p.id === offer.providerId)
    if (!provider) continue
    const credential = credentialFor(offer)
    const apiKey = await inv.revealSecret(credential.id)
    if (!apiKey) {
      results.push({ offerId: offer.id, providerId: offer.providerId, ok: false, error: 'Key 解密失败' })
      continue
    }
    const record = await probeModel({
      baseUrl: provider.baseUrl,
      apiKey,
      model: offer.upstreamName,
      timeoutMs: db.settings.probeTimeoutMs || 45000,
    })
    await inv.recordProbe({
      ...record,
      offerId: offer.id,
      providerId: offer.providerId,
      modelKey: offer.modelKey,
    })
    results.push({ offerId: offer.id, providerId: offer.providerId, ...record })
  }
  return results
}
