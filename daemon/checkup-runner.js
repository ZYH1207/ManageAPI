/**
 * 体检执行器：发请求的那一半。判定逻辑全在 core/checkup.js（纯函数）。
 *
 * 为什么要跟诊断页的其他部分分开：诊断页平时是「读账本」，纯本地零请求；
 * 只有用户亲手点「体检」才允许真的打上游（探针会花 token）。这条边界必须
 * 在代码结构上就看得见，避免哪天被别的地方顺手调用变成定时刷上游。
 */
import * as store from '../core/store.js'
import * as inv from '../core/inventory.js'
import * as providers from '../core/providers.js'
import { probeModel } from '../core/probe.js'
import { buildCheckupReport } from '../core/checkup.js'

/** 并发：体检要快（用户等着看），但不能把站打爆 */
const CONCURRENCY = 3

/**
 * 对某个模型的所有供给做一次体检。
 *
 * @param {{modelKey?: string, offerIds?: string[]}} options
 *        modelKey：体检哪个模型（按 modelKey 归一化匹配）；offerIds：直接点名
 * @returns {Promise<object>} core/checkup.js 的体检报告
 */
export async function runCheckup({ modelKey, offerIds } = {}) {
  const db = await store.readDb()
  const live = inv.routeableOffers(db)

  let targets = live
  if (Array.isArray(offerIds) && offerIds.length > 0) {
    const wanted = new Set(offerIds)
    targets = live.filter((o) => wanted.has(o.id))
  } else if (modelKey) {
    const key = inv.normalizeModelKey(modelKey)
    targets = live.filter((o) => inv.normalizeModelKey(o.modelKey || o.upstreamName || '') === key)
  }
  if (!targets.length) targets = live.slice(0, 8)

  const credentialFor = (offer) =>
    (offer.credentialId && db.credentials.find((c) => c.id === offer.credentialId)) ||
    db.credentials.find(
      (c) => c.providerId === offer.providerId && (c.group || '') === (offer.group || ''),
    ) ||
    db.credentials.find((c) => c.providerId === offer.providerId)

  const providerById = new Map((db.providers || []).map((p) => [p.id, p]))

  // 余额按站读一次，不用每条供给都读
  const balanceCache = new Map()
  const readBalance = async (provider) => {
    if (balanceCache.has(provider.id)) return balanceCache.get(provider.id)
    // 台账旧值当兼底：读不到就用它，判定时按「已知」处理
    let value = typeof provider.quotaRemaining === 'number' ? provider.quotaRemaining : null
    try {
      // 与站点页「刷新余额」同口径：所有 Key 都试 + 令牌（sub2api 系需要）
      const creds = db.credentials.filter((c) => c.providerId === provider.id)
      const apiKeys = (await Promise.all(creds.map((c) => inv.revealSecret(c.id)))).filter(Boolean)
      const adminToken = await inv.revealAdminToken(provider.id)
      const result = await providers.tryBalanceWithKeys({
        baseUrl: provider.baseUrl,
        apiKeys,
        adminToken,
        kind: provider.kind,
      })
      if (result?.ok && typeof result.remaining === 'number') value = result.remaining
    } catch {
      // 读不到余额不是错误：保留台账里的旧值
    }
    balanceCache.set(provider.id, value)
    return value
  }

  const results = new Array(targets.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < targets.length) {
      const index = cursor
      cursor += 1
      const offer = targets[index]
      const provider = providerById.get(offer.providerId)
      const credential = credentialFor(offer)
      const base = {
        offerId: offer.id,
        providerId: offer.providerId,
        providerName: provider?.name || '?',
        label: `${provider?.name || '?'} · ${offer.modelKey || offer.upstreamName || '?'}`,
      }
      if (!provider || !credential) {
        results[index] = { ...base, probe: { ok: false, error: '没有可用的 Key' }, modelListed: null, balance: null }
        continue
      }
      const apiKey = await inv.revealSecret(credential.id)
      if (!apiKey) {
        results[index] = { ...base, probe: { ok: false, error: 'Key 解密失败' }, modelListed: null, balance: null }
        continue
      }

      // 三件事并行：探针（含指纹/截断/计费/缓存）、模型清单、余额
      const [probe, modelListed, balance] = await Promise.all([
        probeModel({
          baseUrl: provider.baseUrl,
          apiKey,
          model: offer.upstreamName,
          timeoutMs: db.settings.probeTimeoutMs || 45000,
        }).catch((error) => ({ ok: false, error: error?.message || String(error) })),
        providers
          .listModels({ baseUrl: provider.baseUrl, apiKey, timeoutMs: 15000 })
          .then(({ models }) => models.includes(offer.upstreamName))
          .catch(() => null), // 拉不到列表就当未知，不冤枉站
        readBalance(provider),
      ])

      results[index] = { ...base, probe, modelListed, balance }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()))

  // 体检结果写回账本：同一条供给的判定结论落一份，诊断页下次能直接拿出来看
  const report = buildCheckupReport({
    modelKey: modelKey || targets[0]?.modelKey || null,
    rows: results.filter(Boolean),
    lowBalanceThreshold: Number(db.settings.balanceWarnUsd) > 0 ? Number(db.settings.balanceWarnUsd) : 1,
  })
  await store
    .mutate((fresh) => {
      if (!Array.isArray(fresh.checkups)) fresh.checkups = []
      fresh.checkups.push({
        at: report.at,
        modelKey: report.modelKey,
        summary: report.summary,
        findings: report.findings,
        rows: report.rows.map((r) => ({
          offerId: r.offerId,
          label: r.label,
          verdict: r.verdict,
          reasons: r.reasons,
          ttftMs: r.ttftMs,
        })),
      })
      if (fresh.checkups.length > 20) fresh.checkups = fresh.checkups.slice(-20)
    })
    .catch(() => {})

  return report
}
