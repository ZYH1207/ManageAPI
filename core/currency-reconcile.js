/**
 * 币种校正：把「站点价目表币种」这件事从「猜」变成「按证据对齐」。
 *
 * 以前的做法是在各个写入点各猜一个默认值（历史代码里 8 处硬写 'CNY'、2 处
 * 「非 USD 一律 CNY」），读取点又默认美元，于是同一条价格在写入和读取两侧
 * 被解释成不同币种，美元价按人民币算，差一个汇率（6.68 倍）。
 *
 * 现在只有一条规则：**站点级币种由证据决定，没有证据就不动**。
 * 证据来自 core/currency.js 的 inferSiteCurrency（供给的「倍率 × 基准价」
 * 关系），推断结果写回 provider.priceCurrency，之后所有落价都按它写。
 *
 * 为什么不在启动时无条件把「没声明的站点」改成美元：存量库里人民币标价的
 * 站点占多数（它们的数字是「官方人民币价 × 倍率」），一刀切成美元会让这些
 * 站的价格全部高估 6.68 倍。没证据时沿用供给自己的币种，才是零风险的默认。
 */

import { inferSiteCurrency, declaredPriceCurrency, normalizeCurrency } from './currency.js'

/**
 * 算出「要改什么」，不改数据（dry run 与落库共用这一份计划）。
 *
 * @param {object} db 整个库（只读）
 * @param {Record<string, object>} benchmarks 基准价表
 * @param {number} fx 人民币/美元汇率
 * @returns {{providers: object[], offers: object[], changedOffers: number}}
 */
export function planCurrencyReconcile(db, benchmarks = {}, fx = 7.2) {
  const providers = []
  const offers = []
  const offersByProvider = new Map()
  for (const offer of db?.offers || []) {
    if (!offersByProvider.has(offer.providerId)) offersByProvider.set(offer.providerId, [])
    offersByProvider.get(offer.providerId).push(offer)
  }

  for (const provider of db?.providers || []) {
    const own = offersByProvider.get(provider.id) || []
    const declared = declaredPriceCurrency(provider)
    const inferred = inferSiteCurrency(own, benchmarks, fx)
    const next = declared || inferred.currency
    if (!next) continue // 没证据：一条都不动
    const reasons = []
    if (declared && inferred.currency && declared !== inferred.currency) {
      // 用户显式设过就以用户为准，但把矛盾摆出来——大概率是站点换了计价单位
      reasons.push(`用户声明 ${declared}，数据更像 ${inferred.currency}`)
    } else if (!declared) {
      reasons.push(`按倍率关系推断 ${inferred.currency}（${inferred.votes}/${inferred.total} 条对上）`)
    }
    const changed = []
    for (const offer of own) {
      if (offer.currencySource === 'custom') continue
      if (normalizeCurrency(offer.currency) === next && offer.currencySource === 'site') continue
      if (normalizeCurrency(offer.currency) === next && !offer.currencySource) {
        // 币种本来就对，只是没标记来源：补标记，价格不动
        changed.push({ offerId: offer.id, upstreamName: offer.upstreamName, from: next, to: next, relabel: true })
        continue
      }
      changed.push({
        offerId: offer.id,
        upstreamName: offer.upstreamName,
        group: offer.group || '',
        from: normalizeCurrency(offer.currency),
        to: next,
        inPrice: offer.inPrice,
        outPrice: offer.outPrice,
        ratio: offer.ratio ?? null,
      })
    }
    providers.push({
      providerId: provider.id,
      provider: provider.name,
      declared,
      inferred: inferred.currency,
      next,
      votes: inferred.votes,
      total: inferred.total,
      samples: inferred.samples,
      notes: reasons,
      offers: changed,
      relabelOnly: changed.length > 0 && changed.every((c) => c.relabel),
    })
    for (const c of changed) offers.push({ ...c, providerId: provider.id, provider: provider.name, next })
  }

  return {
    providers,
    offers,
    changedOffers: offers.filter((o) => !o.relabel).length,
  }
}

/**
 * 计划 + 落库，一步到位；就地修改传入的 db（配合 store.mutate 使用）。
 * @returns {{plan:object, result:{providersChanged:number, offersChanged:number}}}
 */
export function reconcileCurrencies(db, benchmarks = {}, fx = 7.2) {
  const plan = planCurrencyReconcile(db, benchmarks, fx)
  const result = applyCurrencyReconcile(db, plan)
  return { plan, result }
}

/**
 * 把计划落到 db 上（就地修改，交给 store.mutate 写盘）。
 * @returns {{providersChanged:number, offersChanged:number, offersRelabeled:number}}
 */
export function applyCurrencyReconcile(db, plan) {
  const now = new Date().toISOString()
  let providersChanged = 0
  let offersChanged = 0
  let offersRelabeled = 0
  const byId = new Map((db.providers || []).map((p) => [p.id, p]))
  for (const entry of plan.providers || []) {
    const provider = byId.get(entry.providerId)
    if (!provider) continue
    if (entry.declared !== entry.next) {
      provider.priceCurrency = entry.next
      provider.priceCurrencySource = 'auto'
      providersChanged += 1
    }
    const offers = (db.offers || []).filter((o) => o.providerId === provider.id)
    for (const offer of offers) {
      if (offer.currencySource === 'custom') continue
      const target = entry.next
      if (normalizeCurrency(offer.currency) !== target) {
        offer.currency = target
        offer.currencySource = 'site'
        offer.updatedAt = now
        offersChanged += 1
      } else if (offer.currencySource !== 'site') {
        offer.currencySource = 'site'
        offersRelabeled += 1
      }
    }
  }
  return { providersChanged, offersChanged, offersRelabeled }
}
