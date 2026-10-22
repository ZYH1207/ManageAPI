/**
 * 本地 daemon：HTTP API + 静态页。
 * 只绑 127.0.0.1，不做鉴权（个人本机工具）；DSH 插件壳将来直接复用这些接口。
 */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as store from '../core/store.js'
import * as inv from '../core/inventory.js'
import * as pricing from '../core/pricing.js'
import * as bench from '../core/benchmark.js'
import * as providers from '../core/providers.js'
import { scoreOffers, isRoutable, longTermScores } from '../core/score.js'
import { selectCandidates, listPublicModels, explain } from '../core/router.js'
import { recordUsage, usageSummary, tokensUsedByKey, resetUsage, readUsage } from '../core/usage.js'
import { runProbes } from './probe-runner.js'
import { REFERENCE_AS_OF, listReference } from '../core/model-prices.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const WEB_DIR = resolve(__dirname, '../web')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

const MAX_BODY = 1024 * 1024

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

/** 统一入口：探针 + 真实流量 + 时效。三处调用都用这一份，避免口径漂移。 */
function scoresFor(db) {
  return scoreOffers(db.probes, db.traffic, {
    maxAgeMs: (Number(db.settings.scoreMaxAgeHours) || 6) * 3600 * 1000,
  })
}

/** 组装前端需要的全量视图。 */
async function buildState() {
  const db = await store.readDb()
  const benchmarks = await bench.readBenchmarks()
  const scoreMap = scoresFor(db)
  const maxTtftMs = Number(db.settings.maxTtftMs) || 0
  // 用户开关：放行可疑供给。打开后探针判定不可信/过期的照样参与排序，
  // 由「有效成本 = 价格 ÷ 质量」自己去权衡——质量差的价格会被除上去。
  const allowUntrusted = Boolean(db.settings.allowUntrusted)

  // 探针口径的可信度：没探过的保留（否则新用户永远看不到结论），
  // 不可信、或超过首字上限的算不可信
  const probeTrusted = (offerId) => {
    const score = scoreMap.get(offerId)
    if (!score || score.samples === 0) return true
    if (!isRoutable(score)) return false
    if (maxTtftMs > 0 && typeof score.ttftMs === 'number' && score.ttftMs > maxTtftMs) return false
    return true
  }
  // 实际参与推荐/排序的口径：开关打开就全放行
  const isTrusted = (offerId) => allowUntrusted || probeTrusted(offerId)

  const { ranked, unpriced } = pricing.rankByModel(db.offers, db.settings, benchmarks, isTrusted)
  const summary = pricing.summarize(db.offers, db.settings, benchmarks, isTrusted)

  const usage = await usageSummary({ days: 30 })
  // 关注度：有真实用量 > 调过手动顺序 > 探过。headline 优先推你真正在用的模型
  const focusOrder = [
    ...new Set([
      ...Object.entries(usage.byModel || {})
        .sort((a, b) => (b[1].requests || 0) - (a[1].requests || 0))
        .map(([key]) => key),
      ...Object.keys(db.manualOrder || {}),
      ...db.probes.map((p) => p.modelKey).filter(Boolean),
    ]),
  ]

  const topLine = pricing.headline(ranked, db.providers, isTrusted, focusOrder)

  // 长期表现：探针 + 真实流量，按时间衰减加权，供概览页排名
  const longTerm = longTermScores(db.probes, db.traffic)
  const siteRanking = db.providers
    .map((provider) => {
      const stats = db.offers
        .filter((o) => o.providerId === provider.id)
        .map((o) => longTerm.get(o.id))
        .filter(Boolean)
      if (stats.length === 0) return null
      const avg = (pick) => {
        const values = stats.map(pick).filter((v) => typeof v === 'number')
        return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
      }
      return {
        providerId: provider.id,
        providerName: provider.name,
        score: Math.round(avg((s) => s.score) ?? 0),
        uptime: avg((s) => s.uptime),
        avgQuality: avg((s) => s.avgQuality),
        avgTtft: Math.round(avg((s) => s.avgTtft) ?? 0) || null,
        modelCount: stats.length,
        probes: stats.reduce((sum, s) => sum + s.total, 0),
        weightedSamples: Math.round(stats.reduce((sum, s) => sum + (s.weightedSamples || 0), 0) * 10) / 10,
        lastAt: stats.map((s) => s.lastAt).sort().pop(),
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)

  const scores = {}
  for (const [offerId, score] of scoreMap) {
    scores[offerId] = {
      ...score,
      // routable 表示「会不会参与路由」，受开关影响
      routable: isTrusted(offerId),
      // probeTrusted 是探针的原始判定，只用于界面打「可疑」标记，不受开关影响
      probeTrusted: probeTrusted(offerId),
    }
  }

  // 把缓存命中率与延迟挂到比价行上，供前端展示
  const rankedWithCache = ranked.map((group) => ({
    ...group,
    rows: group.rows.map((row) => {
      const score = scoreMap.get(row.offerId)
      return {
        ...row,
        cacheHitRate: score?.cacheHitRate ?? null,
        ttftMs: score?.ttftMs ?? null,
        avgLatencyMs: score?.latencyMs ?? null,
      }
    }),
  }))

  // 决策预览：每个模型当前的候选排序，供「智能决策」页展示
  const decisions = rankedWithCache.map((group) => {
    const order = db.manualOrder?.[group.modelKey] || null
    const candidates = selectCandidates({
      offers: db.offers,
      providers: db.providers,
      credentials: db.credentials,
      scores: scoreMap,
      benchmarks,
      settings: db.settings,
      model: group.modelKey,
      order,
    })
    const rankedCandidates = explain(candidates)
    const winner = rankedCandidates.find((c) => c.routable) || null
    return {
      modelKey: group.modelKey,
      candidates: rankedCandidates,
      chosenOfferId: winner?.offerId ?? null,
      chosenProviderName: winner?.providerName ?? null,
      manual: Boolean(order && order.length),
    }
  })

  return {
    settings: db.settings,
    dataDir: store.dataDir(),
    providers: db.providers,
    credentials: db.credentials.map((c) => ({
      id: c.id,
      providerId: c.providerId,
      label: c.label,
      group: c.group || '',
      tail: c.tail,
      quotaRemaining: c.quotaRemaining,
      currency: c.currency,
      quotaUpdatedAt: c.quotaUpdatedAt,
      expiresAt: c.expiresAt,
      hasAdminToken: Boolean(c.adminToken),
      adminTokenTail: c.adminTokenTail ?? null,
    })),
    offers: db.offers,
    benchmarks,
    reference: { asOf: REFERENCE_AS_OF, list: listReference() },
    ranked: rankedWithCache,
    unpriced,
    decisions,
    summary,
    headline: topLine,
    siteRanking,
    scores,
    probeTotal: db.probes.length,
    gateway: {
      enabled: Boolean(db.settings.gateway?.enabled),
      keys: (db.settings.gateway?.keys || []).map((k) => ({
        id: k.id,
        name: k.name,
        key: k.key,
        enabled: k.enabled,
        monthlyTokenLimit: k.monthlyTokenLimit ?? null,
        note: k.note || '',
        createdAt: k.createdAt,
      })),
    },
    usage,
    routing: (db.routing || []).slice(-40).reverse(),
  }
}

const routes = []
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler })
}

// ------------------------------------------------------------------ 基础

route('GET', /^\/api\/health$/, async () => ({ ok: true, at: new Date().toISOString() }))
route('GET', /^\/api\/state$/, async () => buildState())

route('PATCH', /^\/api\/settings$/, async (ctx) => {
  await store.mutate((db) => {
    const { fxUsdCny, blendInputWeight } = ctx.body
    if (fxUsdCny !== undefined) {
      const v = Number(fxUsdCny)
      if (!Number.isFinite(v) || v <= 0) throw new HttpError(400, '汇率必须是正数')
      db.settings.fxUsdCny = v
    }
    if (blendInputWeight !== undefined) {
      const v = Number(blendInputWeight)
      if (!Number.isFinite(v) || v < 0 || v > 1) throw new HttpError(400, '输入权重必须在 0~1 之间')
      db.settings.blendInputWeight = v
    }
    if (ctx.body.probeIntervalMinutes !== undefined) {
      const v = Number(ctx.body.probeIntervalMinutes)
      if (!Number.isFinite(v) || v < 0) throw new HttpError(400, '探测间隔不能为负')
      db.settings.probeIntervalMinutes = v
    }
    if (ctx.body.scoreMaxAgeHours !== undefined) {
      const v = Number(ctx.body.scoreMaxAgeHours)
      if (!Number.isFinite(v) || v <= 0) throw new HttpError(400, '评分有效期必须大于 0')
      db.settings.scoreMaxAgeHours = v
    }
    if (ctx.body.maxTtftMs !== undefined) {
      const v = Number(ctx.body.maxTtftMs)
      if (!Number.isFinite(v) || v < 0) throw new HttpError(400, '首字延迟上限不能为负')
      db.settings.maxTtftMs = v
    }
    if (ctx.body.allowUntrusted !== undefined) {
      db.settings.allowUntrusted = Boolean(ctx.body.allowUntrusted)
    }
  })
  return buildState()
})

// ---------------------------------------------------------------- providers

route('POST', /^\/api\/providers$/, async (ctx) => {
  await inv.createProvider(ctx.body)
  return buildState()
})

route('PATCH', /^\/api\/providers\/([\w-]+)$/, async (ctx) => {
  await inv.updateProvider(ctx.params[0], ctx.body)
  return buildState()
})

route('DELETE', /^\/api\/providers\/([\w-]+)$/, async (ctx) => {
  await inv.deleteProvider(ctx.params[0])
  return buildState()
})

// -------------------------------------------------------------- credentials

route('POST', /^\/api\/credentials$/, async (ctx) => {
  await inv.createCredential(ctx.body)
  return buildState()
})

route('PATCH', /^\/api\/credentials\/([\w-]+)$/, async (ctx) => {
  await inv.updateCredential(ctx.params[0], ctx.body)
  return buildState()
})

route('DELETE', /^\/api\/credentials\/([\w-]+)$/, async (ctx) => {
  await inv.deleteCredential(ctx.params[0])
  return buildState()
})

// ------------------------------------------------------- 同步模型 / 余额

route('POST', /^\/api\/providers\/([\w-]+)\/sync$/, async (ctx) => {
  const db = await store.readDb()
  const provider = db.providers.find((p) => p.id === ctx.params[0])
  if (!provider) throw new HttpError(404, '站点不存在')
  const credentialId = ctx.body.credentialId || db.credentials.find((c) => c.providerId === provider.id)?.id
  if (!credentialId) throw new HttpError(400, '该站点还没有 Key，先添加一个')

  const apiKey = await inv.revealSecret(credentialId)
  if (!apiKey) throw new HttpError(400, 'Key 解密失败，可能是 master.key 被替换过')

  const previous = new Set(
    db.offers.filter((o) => o.providerId === provider.id).map((o) => o.upstreamName),
  )
  const { models, elapsedMs } = await providers.listModels({
    baseUrl: provider.baseUrl,
    apiKey,
    timeoutMs: db.settings.probeTimeoutMs || 15000,
  })
  const credential = db.credentials.find((c) => c.id === credentialId)
  const result = await inv.syncOffers(provider.id, credentialId, models, credential?.group || '')

  const current = new Set(models)
  const state = await buildState()
  return {
    ...state,
    sync: {
      providerId: provider.id,
      fetched: models.length,
      added: result.added,
      removed: [...previous].filter((name) => !current.has(name)),
      elapsedMs,
    },
  }
})

route('POST', /^\/api\/providers\/([\w-]+)\/group-ratio$/, async (ctx) => {
  const result = await inv.setGroupRatio(ctx.params[0], ctx.body.group, ctx.body.ratio)
  return { ...(await buildState()), groupRatioResult: result }
})

/**
 * 站点价格的加载与匹配，供「选分组」和「应用倍率」共用。
 *
 * 中转站的倍率是按「分组」定的，所以流程一定是：先知道你在哪个分组，
 * 再拿这个分组的倍率去乘模型原价。这两步拆成两个接口：
 *   GET  /groups      —— 只读，列出该站所有分组 + 每个分组能对上几个模型
 *   POST /apply-group —— 写，把选定分组的倍率落到 offer 上
 */
async function loadProviderPricing(providerId) {
  const db = await store.readDb()
  const provider = db.providers.find((p) => p.id === providerId)
  if (!provider) throw new HttpError(404, '站点不存在')

  const credential = db.credentials.find((c) => c.providerId === provider.id)
  const adminToken = credential ? await inv.revealAdminToken(credential.id) : null
  const pricing = await providers.fetchProviderPricing({ baseUrl: provider.baseUrl, adminToken })

  const byModel = new Map()
  for (const model of pricing.models) {
    const key = inv.normalizeModelKey(model.name)
    if (!byModel.has(key)) byModel.set(key, model)
  }
  // 分组已知时优先按 (分组, 模型) 取——同一模型在不同分组可能是不同上游、不同原价
  const byGroupModel = new Map()
  for (const model of pricing.byGroup || []) {
    if (!model.group) continue
    byGroupModel.set(`${model.group}::${inv.normalizeModelKey(model.name)}`, model)
  }

  const offers = db.offers.filter((o) => o.providerId === provider.id)
  const match = (offer, group) =>
    (group && byGroupModel.get(`${group}::${offer.modelKey}`)) ||
    byModel.get(offer.modelKey) ||
    byModel.get(inv.normalizeModelKey(offer.upstreamName)) ||
    null

  return {
    db,
    provider,
    credential,
    pricing,
    offers,
    byModel,
    byGroupModel,
    match,
    benchTable: await bench.readBenchmarks(),
  }
}

/**
 * 列出该站的分组，并预估每个分组能覆盖多少个模型。
 *
 * 这一步只读不写，用户选中之后再调 apply-group——因为「选哪个分组」是用户的
 * 商务事实（他买的是哪个套餐），工具不该替他猜。
 */
route('GET', /^\/api\/providers\/([\w-]+)\/groups$/, async (ctx) => {
  const { credential, pricing, offers, match, byGroupModel } = await loadProviderPricing(ctx.params[0])
  const current = credential?.group || ''

  // 广场能给出「哪个分组有哪些模型」，就按分组严格数；只有渠道数据时只能全站数，
  // 每个分组都会显示成同一个数——那就没意义了，所以优先用严格口径。
  const strict = byGroupModel.size > 0
  const coveredIn = (groupName) =>
    strict
      ? offers.filter((offer) => byGroupModel.has(`${groupName}::${offer.modelKey}`)).length
      : offers.filter((offer) => match(offer, groupName)).length

  const groups = pricing.groups
    .map((g) => ({
      name: g.name,
      rate: g.rate,
      modelCount: coveredIn(g.name),
      isCurrent: g.name === current,
    }))
    // 能覆盖模型的排前面，其次是倍率低的
    .sort((a, b) => {
      if (b.modelCount !== a.modelCount) return b.modelCount - a.modelCount
      return (a.rate ?? 99) - (b.rate ?? 99)
    })

  const unmatched = offers.filter((offer) => !match(offer, current)).map((o) => o.upstreamName)

  return {
    providerId: ctx.params[0],
    current,
    source: pricing.source,
    groups,
    unmatched,
    // 一个分组都没有时，前端直接提示「读不到分组」
    hasGroupInfo: groups.some((g) => g.rate !== null),
  }
})

/**
 * 应用某个分组的倍率：把 Key 的分组记下来，再按这个分组把倍率/价格落到 offer。
 *
 * 写完之后全站的价格、比价、决策、路由会一起变——因为它们都读同一份 offers。
 */
route('POST', /^\/api\/providers\/([\w-]+)\/apply-group$/, async (ctx) => {
  const providerId = ctx.params[0]
  const group = String(ctx.body.group ?? '').trim()
  const { provider, credential, pricing, offers, match, benchTable } = await loadProviderPricing(providerId)

  const rateOfGroup = new Map(pricing.groups.map((g) => [g.name, g.rate]))
  const rates = pricing.groups.map((g) => g.rate).filter((r) => typeof r === 'number')
  const uniformRate = rates.length > 0 && rates.every((r) => r === rates[0]) ? rates[0] : null
  // 分组没给（或这个站只有一个分组）时，能确定倍率就用，确定不了就按原价算
  const rate = group && rateOfGroup.has(group) ? rateOfGroup.get(group) : uniformRate

  // 记下这把 Key 属于哪个分组，下次打开就不用再选
  const prevGroup = credential?.group || ''
  if (credential && group !== prevGroup) {
    await inv.updateCredential(credential.id, { group })
  }

  let updated = 0
  let viaRatio = 0
  const unmatched = []
  const missingBench = []

  await store.mutate((d) => {
    for (const offer of d.offers) {
      if (offer.providerId !== provider.id) continue
      // 只接管「属于这把 Key 的那个分组」的行。用户手工复制出来的其他分组不动，
      // 否则一次导入会把他自己分的组全冲掉。
      if ((offer.group || '') !== prevGroup) continue

      const hit = match(offer, group)
      if (!hit) {
        unmatched.push(offer.upstreamName)
        continue
      }

      const key = offer.benchmarkKey || offer.modelKey || offer.upstreamName

      if (benchTable[key] && rate) {
        offer.ratio = rate
        offer.siteRatio = rate
        offer.ratioSource = 'site'
        offer.pricingMode = 'ratio'
        offer.inPrice = null
        offer.outPrice = null
        viaRatio += 1
      } else {
        const mult = rate ?? 1
        if (hit.inPrice !== null) offer.inPrice = Math.round(hit.inPrice * mult * 1000) / 1000
        if (hit.outPrice !== null) offer.outPrice = Math.round(hit.outPrice * mult * 1000) / 1000
        offer.currency = 'CNY'
        offer.pricingMode = 'manual'
        offer.ratio = null
        offer.siteRatio = rate ?? null
        offer.ratioSource = 'site'
        if (!benchTable[key]) missingBench.push(offer.upstreamName)
      }
      // 行上标出它属于哪个分组，页面就不用再显示「默认分组」了
      if (group) offer.group = group
      offer.updatedAt = new Date().toISOString()
      updated += 1
    }
  })

  return {
    ...(await buildState()),
    groupResult: {
      group,
      rate,
      updated,
      viaRatio,
      unmatched,
      missingBench,
      source: pricing.source,
      modelTotal: offers.length,
    },
  }
})

/** 把自定义倍率恢复成站点公布的值。 */
route('POST', /^\/api\/providers\/([\w-]+)\/restore-ratio$/, async (ctx) => {
  const group = ctx.body?.group
  const result = await inv.restoreSiteRatio(ctx.params[0], group)
  return { ...(await buildState()), restoreResult: result }
})

/**
 * 扣费核对：拉站方记录的用量/消费，和「我们按当前价格估算的消费」对比。
 * 差异大说明倍率有水分、或者计费口径不一致。
 */
route('POST', /^\/api\/providers\/([\w-]+)\/usage-check$/, async (ctx) => {
  const db = await store.readDb()
  const provider = db.providers.find((p) => p.id === ctx.params[0])
  if (!provider) throw new HttpError(404, '站点不存在')
  const credential = db.credentials.find((c) => c.providerId === provider.id)
  if (!credential) throw new HttpError(400, '该站还没有 Key')
  const adminToken = await inv.revealAdminToken(credential.id)
  if (!adminToken) {
    throw new HttpError(400, '需要先在 Key 那行点「令牌」，填一个站点后台的登录令牌')
  }

  const raw = await providers.fetchSiteUsage({ baseUrl: provider.baseUrl, adminToken })

  // 我们这边的估算：usage 记录里的 token × 当前价格
  const usageData = await readUsage()
  const benchmarks = await bench.readBenchmarks()
  const offers = db.offers.filter((o) => o.providerId === provider.id)
  let estInput = 0
  let estOutput = 0
  let estCost = 0
  let estRequests = 0

  for (const bucket of Object.values(usageData.days || {})) {
    for (const [composite, row] of Object.entries(bucket)) {
      const [, providerId, model] = composite.split('|')
      if (providerId !== provider.id) continue
      estRequests += row.requests || 0
      estInput += row.input || 0
      estOutput += row.output || 0
      const offer = offers.find((o) => (o.modelKey || o.upstreamName) === model)
      if (!offer) continue
      const cost = pricing.offerCost(offer, db.settings, benchmarks)
      if (typeof cost.inCnyPerMtok === 'number') estCost += ((row.input || 0) / 1e6) * cost.inCnyPerMtok
      if (typeof cost.outCnyPerMtok === 'number') estCost += ((row.output || 0) / 1e6) * cost.outCnyPerMtok
    }
  }

  return {
    raw,
    estimate: {
      requests: estRequests,
      input: estInput,
      output: estOutput,
      cost: Math.round(estCost * 10000) / 10000,
    },
  }
})

route('POST', /^\/api\/providers\/([\w-]+)\/balance$/, async (ctx) => {
  const db = await store.readDb()
  const provider = db.providers.find((p) => p.id === ctx.params[0])
  if (!provider) throw new HttpError(404, '站点不存在')
  const credentialId = ctx.body.credentialId || db.credentials.find((c) => c.providerId === provider.id)?.id
  if (!credentialId) throw new HttpError(400, '该站点还没有 Key')

  const apiKey = await inv.revealSecret(credentialId)
  const adminToken = await inv.revealAdminToken(credentialId)
  const result = await providers.tryBalance({ baseUrl: provider.baseUrl, apiKey, adminToken })
  if (result.ok) {
    await inv.updateCredential(credentialId, {
      quotaRemaining: result.remaining,
      currency: result.currency,
    })
  }
  return { ...(await buildState()), balance: result }
})

// ------------------------------------------------------------------- 决策排序

route('PUT', /^\/api\/decisions\/([^/]+)\/order$/, async (ctx) => {
  const modelKey = decodeURIComponent(ctx.params[0])
  await inv.setManualOrder(modelKey, ctx.body.order)
  return buildState()
})

// ------------------------------------------------------------------- probes

route('POST', /^\/api\/probes\/run$/, async (ctx) => {
  const limit = Math.min(Number(ctx.body.limit) || 5, 20)
  const results = await runProbes({
    providerId: ctx.body.providerId,
    offerId: ctx.body.offerId,
    limit,
  })
  if (results.length === 0) {
    throw new HttpError(400, '没有可探测的目标：需要该站至少一个 Key，并已同步模型列表')
  }
  return { ...(await buildState()), probeResults: results }
})

route('GET', /^\/api\/probes\/history$/, async (ctx) => {
  const db = await store.readDb()
  const offerId = ctx.query.get('offerId')
  const list = offerId ? db.probes.filter((r) => r.offerId === offerId) : db.probes
  return { probes: list.slice(-200).reverse() }
})

// ------------------------------------------------------------------- offers

route('PATCH', /^\/api\/offers\/([\w-]+)$/, async (ctx) => {
  await store.mutate((db) => {
    const offer = db.offers.find((o) => o.id === ctx.params[0])
    if (!offer) throw new HttpError(404, '模型记录不存在')
    const b = ctx.body
    if (b.pricingMode !== undefined) {
      offer.pricingMode = b.pricingMode === 'ratio' ? 'ratio' : 'manual'
    }
    if (b.ratio !== undefined) {
      offer.ratio = b.ratio === null || b.ratio === '' ? null : Number(b.ratio)
    }
    if (b.benchmarkKey !== undefined) offer.benchmarkKey = b.benchmarkKey || null
    if (b.inPrice !== undefined) offer.inPrice = b.inPrice === null || b.inPrice === '' ? null : Number(b.inPrice)
    if (b.outPrice !== undefined) offer.outPrice = b.outPrice === null || b.outPrice === '' ? null : Number(b.outPrice)
    if (b.currency !== undefined) offer.currency = b.currency === 'CNY' ? 'CNY' : 'USD'
    if (b.priceUnit !== undefined) offer.priceUnit = b.priceUnit === 'per_1k' ? 'per_1k' : 'per_mtok'
    if (b.group !== undefined) {
      const name = String(b.group || '').trim()
      const clash = db.offers.some(
        (o) =>
          o.id !== offer.id &&
          o.providerId === offer.providerId &&
          (o.group || '') === name &&
          o.upstreamName === offer.upstreamName,
      )
      if (clash) throw new HttpError(400, `该站「${name || '默认'}」分组下已经有同名模型了`)
      offer.group = name
    }
    offer.updatedAt = new Date().toISOString()
  })
  return buildState()
})

route('POST', /^\/api\/offers\/([\w-]+)\/duplicate$/, async (ctx) => {
  await inv.duplicateOffer(ctx.params[0], { group: ctx.body.group })
  return buildState()
})

route('DELETE', /^\/api\/offers\/([\w-]+)$/, async (ctx) => {
  await inv.deleteOffer(ctx.params[0])
  return buildState()
})

// -------------------------------------------------------------- benchmarks

route('PUT', /^\/api\/benchmarks$/, async (ctx) => {
  const { modelKey, ...entry } = ctx.body
  if (!modelKey) throw new HttpError(400, '缺少 modelKey')
  await bench.setBenchmark(modelKey, entry)
  return buildState()
})

route('DELETE', /^\/api\/benchmarks\/(.+)$/, async (ctx) => {
  await bench.deleteBenchmark(decodeURIComponent(ctx.params[0]))
  return buildState()
})

route('POST', /^\/api\/benchmarks\/import$/, async (ctx) => {
  const db = await store.readDb()
  const providerId = ctx.body.providerId
  if (!providerId) throw new HttpError(400, '缺少 providerId')
  const result = await bench.importBenchmarksFrom(db.offers, providerId)
  return { ...(await buildState()), importResult: result }
})

route('POST', /^\/api\/benchmarks\/seed$/, async () => {
  const db = await store.readDb()
  const keys = [...new Set(db.offers.map((o) => o.modelKey || o.upstreamName))]
  const result = await bench.seedReferenceBenchmarks(keys)
  return { ...(await buildState()), seedResult: result }
})

/**
 * 从某个站点的模型广场导入「官方价」到基准价表。
 * 和站点页的「广场导入」分工：这里只写基准价（参照物），那边只写倍率。
 */
route('POST', /^\/api\/benchmarks\/import-plaza$/, async (ctx) => {
  const db = await store.readDb()
  const providerId = ctx.body.providerId
  if (!providerId) throw new HttpError(400, '先选一个站点')
  const provider = db.providers.find((p) => p.id === providerId)
  if (!provider) throw new HttpError(404, '站点不存在')

  const credential = db.credentials.find((c) => c.providerId === provider.id)
  const adminToken = credential ? await inv.revealAdminToken(credential.id) : null
  const pricing = await providers.fetchProviderPricing({ baseUrl: provider.baseUrl, adminToken })

  const table = await bench.readBenchmarks()
  const added = []
  let skipped = 0
  for (const model of pricing.models) {
    const modelKey = inv.normalizeModelKey(model.name)
    if (!modelKey) continue
    if (model.inPrice === null && model.outPrice === null) {
      skipped += 1
      continue
    }
    if (table[modelKey]) {
      skipped += 1
      continue
    }
    table[modelKey] = {
      display: model.name,
      in: model.inPrice,
      out: model.outPrice,
      offPeakIn: null,
      offPeakOut: null,
      currency: 'CNY',
      source: `${pricing.source}:${provider.id}`,
      updatedAt: new Date().toISOString(),
    }
    added.push({ modelKey, in: model.inPrice, out: model.outPrice })
  }
  if (added.length > 0) await bench.writeBenchmarks(table)

  return {
    ...(await buildState()),
    plazaBenchResult: {
      added: added.length,
      skipped,
      total: pricing.models.length,
      source: pricing.source,
      items: added,
    },
  }
})

// ------------------------------------------------------------------- 网关管理

route('POST', /^\/api\/gateway\/keys$/, async (ctx) => {
  await inv.createGatewayKey(ctx.body)
  return buildState()
})

route('PATCH', /^\/api\/gateway\/keys\/([\w-]+)$/, async (ctx) => {
  await inv.updateGatewayKey(ctx.params[0], ctx.body)
  return buildState()
})

route('DELETE', /^\/api\/gateway\/keys\/([\w-]+)$/, async (ctx) => {
  await inv.deleteGatewayKey(ctx.params[0])
  return buildState()
})

route('POST', /^\/api\/gateway\/keys\/([\w-]+)\/rotate$/, async (ctx) => {
  await inv.rotateGatewayKey(ctx.params[0])
  return buildState()
})

route('GET', /^\/api\/usage$/, async (ctx) => {
  const days = Math.min(Math.max(Number(ctx.query.get('days')) || 30, 1), 365)
  return { usage: await usageSummary({ days }) }
})

route('POST', /^\/api\/usage\/reset$/, async () => {
  await resetUsage()
  return buildState()
})

route('PATCH', /^\/api\/gateway$/, async (ctx) => {
  if (ctx.body.enabled !== undefined) await inv.setGatewayEnabled(ctx.body.enabled)
  return buildState()
})

route('GET', /^\/api\/gateway\/routing$/, async (ctx) => {
  const limit = Math.min(Number(ctx.query.get('limit')) || 50, 200)
  return { routing: await inv.listRouting(limit) }
})

// ------------------------------------------------------------------ 导出

route('GET', /^\/api\/export\/backup$/, async () => {
  const db = await store.readDb()
  return {
    exportedAt: new Date().toISOString(),
    note: '凭据为密文，需同一份 master.key 才能还原',
    db: {
      ...db,
      credentials: db.credentials.map((c) => ({ ...c, secret: '[encrypted]' })),
    },
  }
})

route('GET', /^\/api\/export\/config$/, async (ctx) => {
  const providerId = ctx.query.get('providerId')
  const includeKey = ctx.query.get('includeKey') === '1'
  const db = await store.readDb()
  const provider = db.providers.find((p) => p.id === providerId)
  if (!provider) throw new HttpError(404, '站点不存在')
  const credential = db.credentials.find((c) => c.providerId === provider.id)
  const models = db.offers.filter((o) => o.providerId === provider.id).map((o) => o.upstreamName)
  const apiKey = includeKey && credential ? await inv.revealSecret(credential.id) : 'sk-********'

  const openaiCompatible = {
    baseURL: provider.baseUrl,
    apiKey,
    models,
  }
  const envBlock = [
    `# ${provider.name}`,
    `export OPENAI_BASE_URL="${provider.baseUrl}"`,
    `export OPENAI_API_KEY="${apiKey}"`,
  ].join('\n')

  return { provider: { id: provider.id, name: provider.name, baseUrl: provider.baseUrl }, openaiCompatible, envBlock, modelCount: models.length }
})

// ------------------------------------------------------------------ 网关

// 真实流量计数先攒内存，每 5 秒刷一次盘——每个请求都重写 db.json 太重
const trafficBuffer = new Map()
let trafficTimer = null

function bufferTraffic(offerId, ok) {
  if (!offerId) return
  const entry = trafficBuffer.get(offerId) || { ok: 0, fail: 0 }
  if (ok) entry.ok += 1
  else entry.fail += 1
  trafficBuffer.set(offerId, entry)
  if (!trafficTimer) {
    trafficTimer = setTimeout(() => {
      trafficTimer = null
      flushTraffic().catch(() => {})
    }, 5000)
  }
}

async function flushTraffic() {
  if (trafficBuffer.size === 0) return
  const snapshot = [...trafficBuffer.entries()]
  trafficBuffer.clear()
  await inv.addTraffic(snapshot)
}

function openaiError(res, status, message, type = 'invalid_request_error') {
  if (res.writableEnded) return
  const body = JSON.stringify({ error: { message, type, code: status } })
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

function authorizeGateway(req, db) {
  const gateway = db.settings.gateway
  if (!Array.isArray(gateway?.keys)) return { ok: false, status: 503, message: '网关尚未初始化' }
  if (!gateway.enabled) return { ok: false, status: 503, message: '网关已在设置中关闭' }
  const header = String(req.headers.authorization || '')
  const token = header.replace(/^Bearer\s+/i, '').trim()
  if (!token) return { ok: false, status: 401, message: '缺少 API Key，请在 Authorization 头里带上 Bearer <网关 Key>' }
  const keyRecord = gateway.keys.find((k) => k.key === token)
  if (!keyRecord) return { ok: false, status: 401, message: 'API Key 无效' }
  if (!keyRecord.enabled) return { ok: false, status: 403, message: `Key「${keyRecord.name}」已被禁用` }
  return { ok: true, keyRecord }
}

/**
 * 把一次请求转给某个候选站。
 *
 * 关键在流式的提交边界：必须读到第一个 chunk 并确认它不是错误，才向客户端
 * writeHead。在这之前失败都可以静默换站；一旦提交，就只能收尾，不能重试。
 */
async function forwardToUpstream({ candidate, body, res, attemptIndex }) {
  const apiKey = await inv.revealSecret(candidate.credential.id)
  if (!apiKey) return { committed: false, error: 'Key 解密失败' }

  const isStream = body.stream === true
  const clientWantsUsage = Boolean(body.stream_options?.include_usage)
  const upstreamBody = { ...body, model: candidate.offer.upstreamName }
  // 客户端没要求 usage 时也让它返回——网关自己统计用，转发时再把那个 chunk 滤掉
  if (isStream && !clientWantsUsage) {
    upstreamBody.stream_options = { ...(body.stream_options || {}), include_usage: true }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 300000)
  const startedAt = Date.now()

  let upstreamRes
  try {
    upstreamRes = await fetch(`${candidate.provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: isStream ? 'text/event-stream' : 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    return { committed: false, error: `连接失败：${error.message}` }
  }

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text().catch(() => '')
    clearTimeout(timer)
    return { committed: false, error: `HTTP ${upstreamRes.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}` }
  }

  const headers = {
    'X-ManageAPI-Provider': encodeURIComponent(candidate.provider.name),
    'X-ManageAPI-Attempts': String(attemptIndex + 1),
    'X-ManageAPI-Quality': candidate.quality === null ? 'unknown' : candidate.quality.toFixed(2),
  }

  if (!isStream) {
    let payload
    try {
      payload = await upstreamRes.json()
    } catch {
      clearTimeout(timer)
      return { committed: false, error: '上游返回的不是 JSON' }
    }
    clearTimeout(timer)
    if (payload?.error) return { committed: false, error: payload.error.message || '上游返回 error 字段' }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
    res.end(JSON.stringify(payload))
    return { committed: true, usage: payload.usage || null, ttftMs: null }
  }

  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let committed = false
  let usage = null
  let ttftMs = null

  const commit = () => {
    if (committed) return
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...headers,
    })
    committed = true
    ttftMs = Date.now() - startedAt
  }

  const push = async (chunk) => {
    if (!res.write(chunk)) await once(res, 'drain')
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, boundary + 2)
        buffer = buffer.slice(boundary + 2)

        const dataLine = raw.split('\n').find((line) => line.trim().startsWith('data:'))
        const payloadText = dataLine ? dataLine.trim().slice(5).trim() : ''
        let parsed = null
        if (payloadText && payloadText !== '[DONE]') {
          try {
            parsed = JSON.parse(payloadText)
          } catch {
            /* 心跳或非 JSON 行，原样转发 */
          }
        }

        if (parsed?.usage) usage = parsed.usage

        // 第一个事件就是错误：还没提交，可以换站
        if (!committed && parsed?.error) {
          clearTimeout(timer)
          return { committed: false, error: parsed.error.message || '上游返回 error' }
        }

        // 只带 usage 的收尾 chunk，客户端没要求就别塞给它
        const usageOnly =
          parsed && Array.isArray(parsed.choices) && parsed.choices.length === 0 && parsed.usage
        if (usageOnly && !clientWantsUsage) continue

        commit()
        await push(raw)
      }

      // 非标准上游可能不用 \n\n 分隔，攒太多就整块放行
      if (buffer.length > 8192) {
        commit()
        await push(buffer)
        buffer = ''
      }
    }

    if (buffer) {
      commit()
      await push(buffer)
    }

    if (!committed) {
      clearTimeout(timer)
      return { committed: false, error: '上游没有返回任何内容' }
    }

    res.end()
  } catch (error) {
    clearTimeout(timer)
    if (!committed) return { committed: false, error: `流中断：${error.message}` }
    if (!res.writableEnded) res.end()
    return { committed: true, usage, ttftMs, streamError: error.message }
  }

  clearTimeout(timer)
  return { committed: true, usage, ttftMs }
}

async function handleChatCompletions(req, res, db, keyRecord) {
  const body = await readBody(req)
  const model = body?.model
  if (!model) return openaiError(res, 400, '请求体缺少 model 字段')

  // 月度 token 上限（可选，Key 上配置）
  if (keyRecord?.monthlyTokenLimit) {
    const monthStart = `${new Date().toISOString().slice(0, 7)}-01`
    const used = await tokensUsedByKey(keyRecord.id, monthStart)
    if (used >= keyRecord.monthlyTokenLimit) {
      return openaiError(
        res,
        429,
        `Key「${keyRecord.name}」本月已用 ${used.toLocaleString()} token，达到上限 ${keyRecord.monthlyTokenLimit.toLocaleString()}`,
        'insufficient_quota',
      )
    }
  }

  const benchmarks = await bench.readBenchmarks()
  const scores = scoresFor(db)
  const candidates = selectCandidates({
    offers: db.offers,
    providers: db.providers,
    credentials: db.credentials,
    scores,
    benchmarks,
    settings: db.settings,
    model,
    order: db.manualOrder?.[inv.normalizeModelKey(model)] || null,
  })

  if (candidates.length === 0) {
    const available = listPublicModels({ offers: db.offers, scores }).map((m) => m.id)
    return openaiError(
      res,
      404,
      `没有可用的 ${model}。已同步的模型：${available.slice(0, 20).join(', ') || '（无，先去同步模型列表）'}`,
      'model_not_found',
    )
  }

  const started = Date.now()
  const failures = []

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const attemptStarted = Date.now()
    try {
      const result = await forwardToUpstream({ candidate, body, res, attemptIndex: index })
      if (result.committed) {
        const latencyMs = Date.now() - started
        await inv.recordRouting({
          model,
          keyId: keyRecord?.id ?? null,
          keyName: keyRecord?.name ?? null,
          chosenOfferId: candidate.offer.id,
          chosenProviderId: candidate.offer.providerId,
          chosenProviderName: candidate.provider.name,
          upstreamModel: candidate.offer.upstreamName,
          chosenGroup: candidate.offer.group || '',
          attempts: index + 1,
          outcome: result.streamError ? 'stream-broken' : 'ok',
          latencyMs,
          ttftMs: result.ttftMs ?? null,
          usage: result.usage || null,
          candidates: explain(candidates),
          failures,
        })
        await recordUsage({
          keyId: keyRecord?.id ?? '-',
          providerId: candidate.offer.providerId,
          model: candidate.offer.modelKey || candidate.offer.upstreamName,
          inputTokens: result.usage?.prompt_tokens,
          outputTokens: result.usage?.completion_tokens,
          cachedTokens: result.usage?.prompt_tokens_details?.cached_tokens,
          latencyMs,
          ttftMs: result.ttftMs,
          ok: !result.streamError,
        })
        bufferTraffic(candidate.offer.id, !result.streamError)
        return
      }
      failures.push({
        providerName: candidate.provider.name,
        offerId: candidate.offer.id,
        error: result.error,
        ms: Date.now() - attemptStarted,
      })
      bufferTraffic(candidate.offer.id, false)
    } catch (error) {
      failures.push({
        providerName: candidate.provider.name,
        offerId: candidate.offer.id,
        error: error.message || String(error),
        ms: Date.now() - attemptStarted,
      })
      bufferTraffic(candidate.offer.id, false)
    }
  }

  await inv.recordRouting({
    model,
    keyId: keyRecord?.id ?? null,
    keyName: keyRecord?.name ?? null,
    chosenOfferId: null,
    attempts: candidates.length,
    outcome: 'failed',
    latencyMs: Date.now() - started,
    candidates: explain(candidates),
    failures,
  })
  await recordUsage({
    keyId: keyRecord?.id ?? '-',
    providerId: '-',
    model,
    latencyMs: Date.now() - started,
    ok: false,
  })
  return openaiError(
    res,
    502,
    `所有候选站都失败了：${failures.map((f) => `${f.providerName}: ${f.error}`).join(' | ')}`,
    'upstream_error',
  )
}

async function handleProxy(req, res, url) {
  const pathname = url.pathname.replace(/\/+$/, '') || '/'
  const db = await store.readDb()

  const auth = authorizeGateway(req, db)
  if (!auth.ok) return openaiError(res, auth.status, auth.message, 'authentication_error')

  if (pathname === '/v1/models') {
    const scores = scoresFor(db)
    const models = listPublicModels({ offers: db.offers, scores })
    return json(res, 200, {
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'manage-api',
        providers: m.providers,
        healthy: m.healthy,
      })),
    })
  }

  if (pathname === '/v1/chat/completions') {
    return handleChatCompletions(req, res, db, auth.keyRecord)
  }

  return openaiError(res, 404, `暂不支持 ${pathname}，目前只代理 /v1/chat/completions 与 /v1/models`)
}

// ------------------------------------------------------------------ 静态

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = resolve(WEB_DIR, rel)
  if (!target.startsWith(WEB_DIR)) {
    res.writeHead(403).end('Forbidden')
    return
  }
  try {
    const data = await readFile(target)
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    res.end(data)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found')
  }
}

// ------------------------------------------------------------------ server

export function createAppServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const pathname = url.pathname

    if (pathname === '/v1' || pathname.startsWith('/v1/')) {
      try {
        await handleProxy(req, res, url)
      } catch (error) {
        if (!res.writableEnded) openaiError(res, 500, error.message || String(error), 'server_error')
      }
      return
    }

    if (!pathname.startsWith('/api/')) {
      await serveStatic(req, res, pathname)
      return
    }

    try {
      const method = req.method === 'HEAD' ? 'GET' : req.method
      for (const r of routes) {
        if (r.method !== method) continue
        const match = r.pattern.exec(pathname)
        if (!match) continue
        const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req)
        const result = await r.handler({
          body,
          params: match.slice(1),
          query: url.searchParams,
          req,
          res,
        })
        if (res.writableEnded) return
        json(res, 200, result ?? { ok: true })
        return
      }
      json(res, 404, { error: `没有这个接口：${method} ${pathname}` })
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400
      if (!res.writableEnded) json(res, status, { error: error.message || String(error) })
    }
  })
}
