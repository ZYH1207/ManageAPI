/**
 * 本地 daemon：HTTP API + 静态页。
 * 只绑 127.0.0.1，不做鉴权（个人本机工具）；DSH 插件壳将来直接复用这些接口。
 */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as store from '../core/store.js'
import * as fxLib from '../core/fx.js'
import * as inv from '../core/inventory.js'
import * as pricing from '../core/pricing.js'
import * as bench from '../core/benchmark.js'
import * as providers from '../core/providers.js'
import { scoreOffers, isRoutable, longTermScores } from '../core/score.js'
import { classifyFailure } from '../core/failure.js'
import { checkRealResponse, estimateRequestTokens } from '../core/quality-signals.js'
import {
  protocolForPath,
  upstreamPath,
  createStreamInspector,
  extractNonStream,
} from '../core/wire.js'
import { selectCandidates, listPublicModels, explain, admissionFailure } from '../core/router.js'
import { snapTtftMs, ttftTierTable, describeTtftLimit } from '../core/latency.js'
import { splitOffers, resolvePool, FREE_PREFIX, FREE_BASE_PATH } from '../core/free.js'
import { rankFreePool } from '../core/rank-free.js'
import * as platforms from '../core/platforms/index.js'
import { recordUsage, usageSummary, tokensUsedByKey, resetUsage, readUsage, localMonthStart } from '../core/usage.js'
import { buildMonitorView, markAlertsRead, markAnnouncementsRead, applySnapshot } from '../core/monitor.js'
import { collectProviderSnapshots } from './monitor-runner.js'
import { runProbes } from './probe-runner.js'
import { REFERENCE_AS_OF, listReference } from '../core/model-prices.js'
import { listPresetSites, listPresetPlatforms } from '../core/catalog.js'

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
// 网关的 chat 请求体放宽：长上下文（几十万 token 历史）+ 内嵌图片轻松超 1MB，
// 管理接口的 1MB 上限不该拦住正常的对话请求
const MAX_GATEWAY_BODY = 64 * 1024 * 1024

/** 流式转发的空闲超时：连续这么久没收到上游任何字节，才判定卡死 */
const STREAM_IDLE_MS = 120000

class HttpError extends Error {
  constructor(status, message, extra = null) {
    super(message)
    this.status = status
    // 附加字段会并进错误响应（如 needConfirm）——前端据此决定是否弹确认
    this.extra = extra
  }
}

/**
 * 价格、倍率、限额这类入参必须是非负有限数。
 * 光用 Number() 会把 '' 变成 0、把 'abc' 变成 NaN —— NaN 排进价格排序会让
 * 这个模型莫名其妙变成「最便宜」（比较结果永远是 false），负数同理。
 */
function nonNegative(value, field) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) throw new HttpError(400, `${field}必须是数字`)
  if (n < 0) throw new HttpError(400, `${field}不能是负数`)
  return n
}

/** 文件系统层的 errno：出现这些说明是服务端自己的问题，应当回 500 而不是 400 */
const IO_ERROR_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOENT', 'ENOSPC', 'EIO', 'EMFILE', 'ENFILE'])

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req, { maxBytes = MAX_BODY } = {}) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      // 超限后要先把剩下的数据读掉，否则连接会被直接掐断，客户端看不到 413
      req.resume()
      throw new HttpError(413, '请求体过大')
    }
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

/**
 * 平台侧视图：把平台、账号、额度、预计剩余天数拼在一起给前端。
 * 读失败（比如 free.json 被手改坏）不能让整个页面挂掉，所以整体包一层 try。
 */
async function freePlatformState() {
  try {
    // 整个函数只读一次 free.json：此前 listPlatforms/listAccounts/
    // getActiveAccount/daysLeft 各自 readFreeDb，P 个平台 = 2P+2 次全量
    // JSON.parse，而 buildState 是每个写接口和 15 秒轮询的必经之路
    const freeDb = await platforms.readFreeDb()
    const accounts = freeDb.accounts
    // secret 是加密后的 token，绝不该出现在前端状态里；只给一个「有没有」的布尔
    const safeAccounts = accounts.map(({ secret, ...rest }) => ({ ...rest, hasSecret: Boolean(secret) }))
    const enriched = freeDb.platforms.map((platform) => {
      const mine = safeAccounts.filter((a) => a.platformId === platform.id)
      const activeId = freeDb.activeAccount?.[platform.id] || null
      const active = activeId ? accounts.find((a) => a.id === activeId) : null
      const left = platforms.daysLeftInDb(freeDb, active?.id || mine[0]?.id || '')
      // 需要登录的平台（connector 不是 manual）必须有 token 才算「已连接」；
      // 手动平台只要有账号就算——它本来就不发请求。
      const needsLogin = platform.connectorId && platform.connectorId !== 'manual'
      const connected = needsLogin ? mine.some((a) => a.hasSecret) : mine.length > 0
      // 连接器有没有实现签到，决定前端显不显示「签到」按钮
      const connector = platforms.getConnector(platform.connectorId)
      const canCheckin = Boolean(connector && typeof connector.checkin === 'function')
      return {
        ...platform,
        canCheckin,
        accounts: mine,
        activeAccountId: active?.id || null,
        daysLeft: left,
        connected,
      }
    })
    return { platforms: enriched, accounts: safeAccounts }
  } catch (error) {
    return { platforms: [], accounts: [], platformError: error.message || String(error) }
  }
}

/** 组装前端需要的全量视图。 */
async function buildState({ light = false } = {}) {
  // 只读视图走 mtime 缓存（网关热路径同一份）：buildState 被 40 个写接口和
  // 15 秒轮询调用，此前每次全量 JSON.parse（db.json 已到 MB 级，约 15ms/次）。
  // 本函数及它调用的评分/比价/决策全部是纯读——约定见 readDbCached 的注释。
  const db = await store.readDbCached()
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

  // 免费供给在**数据入口**就切断：比价、概览结论、智能决策一律只看 paid。
  // 不靠渲染层过滤——漏一个分支就会污染「最便宜」的结论。
  // 已下线（delistedAt 有值）的供给保留在库里，但不参与任何展示与路由
  // 已下线 / 被暂停 / 被忽略的过滤收口在 inv.routeableOffers，探针目标也用同一份
  const liveOffers = inv.routeableOffers(db)
  const { paid: paidOffers, free: freeOffers } = splitOffers(liveOffers, benchmarks)

  const { ranked, unpriced } = pricing.rankByModel(paidOffers, db.settings, benchmarks, isTrusted)
  const summary = pricing.summarize(paidOffers, db.settings, benchmarks, isTrusted)

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

  const topLine = pricing.headline(ranked, db.providers, isTrusted, focusOrder, db.settings)

  // 长期表现：探针 + 真实流量，按时间衰减加权，供概览页排名
  const longTerm = longTermScores(db.probes, db.traffic)
  const siteRanking = db.providers
    .map((provider) => {
      const stats = paidOffers
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
      offers: paidOffers,
      providers: db.providers,
      credentials: db.credentials,
      scores: scoreMap,
      benchmarks,
      settings: db.settings,
      model: group.modelKey,
      order,
    })
    const rankedCandidates = explain(candidates)
    // 「当前选」= 第一张真能登场的牌。这里必须用准入而不是 routable：
    // 评分过期的 routable 为 false，但它确实会被派活（见 admissionOf）
    const winner = rankedCandidates.find((c) => c.admission?.ok) || null
    return {
      modelKey: group.modelKey,
      candidates: rankedCandidates,
      chosenOfferId: winner?.offerId ?? null,
      chosenProviderName: winner?.providerName ?? null,
      manual: Boolean(order && order.length),
    }
  })

  const result = {
    settings: db.settings,
    // 首字门槛的 20 档 + 速度等级：前端直接照着渲染，不在浏览器里另算一份
    ttftTiers: ttftTierTable(),
    ttftLimitText: describeTtftLimit(db.settings.maxTtftMs),
    dataDir: store.dataDir(),
    // 令牌与余额挂在站点上：它们是「一个后台账号一套」，跟下面挂几个 Key 无关
    // 顺序按 sortOrder（站点卡上的上移/下移），没设过的按创建时间兜底
    providers: [...db.providers]
      .sort(
        (a, b) =>
          (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) ||
          String(a.createdAt || '').localeCompare(String(b.createdAt || '')),
      )
      .map((p) => ({
        ...p,
        hasAdminToken: Boolean(p.adminToken),
        adminTokenTail: p.adminTokenTail ?? null,
        paused: Boolean(p.paused),
        // 令牌可用性：'ok' / 'invalid' / null（还没验过）
        tokenStatus: p.tokenStatus ?? null,
        tokenStatusAt: p.tokenStatusAt ?? null,
        quotaRemaining: typeof p.quotaRemaining === 'number' ? p.quotaRemaining : null,
        currency: p.currency || 'CNY',
        quotaUpdatedAt: p.quotaUpdatedAt ?? null,
        // 免费池里这个站有哪几个模型（卡片上标「免费 N」）
        freeModels: freeOffers
          .filter((o) => o.providerId === p.id)
          .map((o) => o.upstreamName || o.modelKey || '')
          .filter(Boolean),
      })),
    credentials: db.credentials.map((c) => ({
      id: c.id,
      providerId: c.providerId,
      label: c.label,
      group: c.group || '',
      tail: c.tail,
      expiresAt: c.expiresAt,
    })),
    offers: liveOffers,
    // 全部模型（含被忽略的）与覆盖站点数：忽略模型弹窗要用，不能从过滤后的 offers 推
    modelIndex: (() => {
      const counts = new Map()
      for (const offer of db.offers) {
        if (offer.delistedAt) continue
        const key = offer.modelKey || offer.upstreamName || ''
        if (!key) continue
        counts.set(key, (counts.get(key) || 0) + 1)
      }
      return [...counts.entries()]
        .map(([name, sites]) => ({ name, sites }))
        .sort((a, b) => a.name.localeCompare(b.name))
    })(),
    // 免费池：与付费侧完全隔离。两栏数据分开给，前端不用自己筛。
    // relay 已经由 rankFreePool 排好序并带上 gate / daysLeft——
    // 服务端和前端共用同一份判定，避免两套阈值漂移。
    freePool: {
      relay: rankFreePool({
        offers: freeOffers,
        scores: scoreMap,
        benchmarks,
        crossPane: db.settings.freeCrossPane || 'remaining',
      }).map((row) => ({
        ...row.offer,
        score: row.score,
        gate: row.gate,
        daysLeft: row.daysLeft,
      })),
      // 平台侧数据来自 core/platforms（独立文件 free.json）
      ...(await freePlatformState()),
      crossPane: db.settings.freeCrossPane || 'remaining',
      allowPaidFallback: Boolean(db.settings.allowPaidFallback),
    },
    benchmarks,
    reference: { asOf: REFERENCE_AS_OF, list: listReference() },
    // 预置目录：只是「省打字」的辅助，不参与逻辑
    catalog: { sites: listPresetSites(), platforms: listPresetPlatforms() },
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
  // 轻量版：自动刷新轮询用，砍掉最大的两块（scores 73KB / decisions 20KB），
  // 前端把这两项沿用旧值——比价/决策页轮询时仍走完整版
  if (light) {
    // 只裁 decisions（每模型候选表，最大的一块）。scores 要保留：概览 / 探针 /
    // 网关页和通知中心都从它派生健康状态，裁掉的话停在这些页时 15 秒轮询
    // 永远不更新评分，界面上「可疑/过期」的标记一挂就是一整个会话。
    delete result.decisions
  }
  return result
}

const routes = []
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler })
}

// ------------------------------------------------------------------ 基础

route('GET', /^\/api\/health$/, async () => ({ ok: true, at: new Date().toISOString() }))
route('GET', /^\/api\/state$/, async (ctx) => buildState({ light: ctx.query.get('light') === '1' }))

route('PATCH', /^\/api\/settings$/, async (ctx) => {
  await store.mutate((db) => {
    const { fxUsdCny, blendInputWeight } = ctx.body
    if (fxUsdCny !== undefined) {
      const v = Number(fxUsdCny)
      if (!Number.isFinite(v) || v <= 0) throw new HttpError(400, '汇率必须是正数')
      // 手工填汇率 = 手动模式，自动任务不再覆盖
      db.settings.fx = { ...fxLib.ensureFx(db.settings), rates: { ...fxLib.ensureFx(db.settings).rates, CNY: v }, manual: true, source: 'manual', updatedAt: new Date().toISOString() }
      db.settings.fxUsdCny = v
    }
    // fxAuto: true → 恢复自动拉取
    if (ctx.body.fxAuto === true) {
      const fx = fxLib.ensureFx(db.settings)
      fx.manual = false
      db.settings.fx = fx
      db.settings.fxUsdCny = fx.rates.CNY
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
    // 两个时钟必须自洽：有效期是「允许错过几轮探测」，间隔比有效期还长的话，
    // 每条供给都会在两次探测之间整段过期（之前踩过：间隔和有效期都是 6 小时，
    // 一到点就集体掉出路由池）。这里直接挡住，别让配置自己打自己。
    // 只在本次真的改了这两项时校验——否则旧配置会卡住其它无关设置
    if (ctx.body.probeIntervalMinutes !== undefined || ctx.body.scoreMaxAgeHours !== undefined) {
      if (db.settings.probeIntervalMinutes > 0) {
        const maxAgeMinutes = (Number(db.settings.scoreMaxAgeHours) || 6) * 60
        if (db.settings.probeIntervalMinutes > maxAgeMinutes / 2) {
          throw new HttpError(
            400,
            `探测间隔（${db.settings.probeIntervalMinutes} 分钟）不能超过评分有效期（${maxAgeMinutes} 分钟）的一半，否则每条供给都会在两轮探测之间过期`,
          )
        }
      }
    }
    if (ctx.body.maxTtftMs !== undefined) {
      // 空串 / null = 不限（0），别把空输入当成「0 毫秒」——那是谁都过不了
      const raw = ctx.body.maxTtftMs
      const v = raw === null || raw === '' ? 0 : Number(raw)
      if (!Number.isFinite(v) || v < 0) {
        throw new HttpError(400, '首字延迟门槛必须是 0（不限）或正数毫秒')
      }
      // 取档收口在这里：不论前端发什么数字，落库的都是 1000~20000 的整档，
      // 否则「20 档」只是界面上的说法，路由读到的还是原始值
      db.settings.maxTtftMs = snapTtftMs(v)
    }
    // 全局默认站点单价：所有站口径一致时只填一次（如「全部 1:1 充值」填 1）
    if (ctx.body.defaultUnitPrice !== undefined) {
      if (ctx.body.defaultUnitPrice === null || ctx.body.defaultUnitPrice === '') {
        db.settings.defaultUnitPrice = null
      } else {
        const v = Number(ctx.body.defaultUnitPrice)
        if (!Number.isFinite(v) || v <= 0) throw new HttpError(400, '默认站点单价必须是正数')
        db.settings.defaultUnitPrice = v
      }
    }
    if (ctx.body.allowUntrusted !== undefined) {
      db.settings.allowUntrusted = Boolean(ctx.body.allowUntrusted)
    }
    if (ctx.body.freeCrossPane !== undefined) {
      const v = String(ctx.body.freeCrossPane)
      if (!['platform', 'relay', 'remaining'].includes(v)) {
        throw new HttpError(400, '免费池跨栏偏好只能是 platform / relay / remaining')
      }
      db.settings.freeCrossPane = v
    }
    if (ctx.body.allowPaidFallback !== undefined) {
      db.settings.allowPaidFallback = Boolean(ctx.body.allowPaidFallback)
    }
    if (ctx.body.monitorIntervalMinutes !== undefined) {
      const v = Number(ctx.body.monitorIntervalMinutes)
      if (!Number.isFinite(v) || v < 0) throw new HttpError(400, '监控采集间隔不能为负')
      db.settings.monitorIntervalMinutes = v
    }
    if (ctx.body.displayCurrency !== undefined) {
      const v = String(ctx.body.displayCurrency).toUpperCase()
      if (v !== 'CNY' && v !== 'USD') throw new HttpError(400, '显示币种只能是 CNY 或 USD')
      db.settings.displayCurrency = v
    }
    if (ctx.body.balanceWarnUsd !== undefined || ctx.body.balanceWarnCny !== undefined) {
      // 阈值口径是美元；兼容老前端仍传人民币，按汇率折一次
      const rawUsd = ctx.body.balanceWarnUsd
      const rawCny = ctx.body.balanceWarnCny
      // 汇率真源在 fx 模块；settings.fxUsdCny 只是兼容镜像
      const fx = Number(fxLib.ensureFx(db.settings).rates.CNY) || 7.2
      const v = rawUsd !== undefined ? Number(rawUsd) : Number(rawCny) / fx
      if (!Number.isFinite(v) || v < 0) throw new HttpError(400, '余额告警阈值不能为负')
      db.settings.balanceWarnUsd = Math.round(v * 100) / 100
    }
    if (ctx.body.ignoredModels !== undefined) {
      if (!Array.isArray(ctx.body.ignoredModels)) throw new HttpError(400, '忽略的模型必须是数组')
      // 归一化后去重：free/glm-5.3 与 glm-5.3 视为同一个模型，忽略一次两边都不再参与
      const list = ctx.body.ignoredModels
        .map((name) => (typeof name === 'string' ? inv.normalizeModelKey(name) : ''))
        .filter(Boolean)
      if (list.length > 500) throw new HttpError(400, '最多忽略 500 个模型')
      db.settings.ignoredModels = [...new Set(list)]
    }
  })
  return buildState()
})

// ---------------------------------------------------------------- providers

/** 账号密码登录：拿到的 token 写入 adminToken，下游全部读取逻辑复用。 */
route('POST', /^\/api\/providers\/([\w-]+)\/login$/, async (ctx) => {
  const { user, password, confirmUnknown } = ctx.body || {}
  if (!user || !password) throw new HttpError(400, '账号和密码都不能为空')
  try {
    const result = await inv.loginWithCredentials(ctx.params[0], {
      user,
      password,
      confirmUnknown: confirmUnknown === true,
    })
    invalidatePricing(ctx.params[0])
    // 令牌刚恢复可用：顺手跑一轮该站采集（余额 / 公告 / 分组倍率），
    // 不用等 30 分钟调度——用户看到登录成功时，数据也应该跟着回来
    collectProviderSnapshots({ providerId: ctx.params[0] }).catch(() => {})
    return {
      ...(await buildState()),
      loginResult: { ok: true, kind: result.kind, via: result.via },
    }
  } catch (error) {
    // 系别识别不出、需要用户确认双协议试探：409 + needConfirm，
    // 前端弹确认后带 confirmUnknown 重发
    if (error?.needConfirm) {
      throw new HttpError(409, error.message, { needConfirm: true, evidence: error.evidence || null })
    }
    throw error
  }
})

/** 新增站点：建库后自动探测一次系别（失败不阻断保存）。 */
route('POST', /^\/api\/providers$/, async (ctx) => {
  const created = await inv.createProvider(ctx.body)
  const state = await buildState()
  // 建站后顺手探测一次系别（只读、短超时、失败不阻断保存）：结果写回
  // provider.kind，之后余额/公告/采集都能按系别走确定性路径
  try {
    const detected = await providers.detectProviderKind({ baseUrl: created.baseUrl })
    await inv.updateProvider(created.id, { kind: detected.kind, kindSource: 'auto' })
    const inState = state.providers.find((p) => p.id === created.id)
    if (inState) {
      inState.kind = detected.kind
      inState.kindSource = 'auto'
    }
  } catch {
    /* 探测失败不阻断：kind 保持 unknown */
  }
  return state
})

/** 重新识别站点系别（用户显式触发，允许覆盖任何旧值）。 */
route('POST', /^\/api\/providers\/([\w-]+)\/detect-kind$/, async (ctx) => {
  const db = await store.readDb()
  const provider = db.providers.find((p) => p.id === ctx.params[0])
  if (!provider) throw new HttpError(404, '站点不存在')
  const detected = await providers.detectProviderKind({ baseUrl: provider.baseUrl })
  await inv.updateProvider(provider.id, { kind: detected.kind, kindSource: 'auto' })
  return {
    ...(await buildState()),
    kindResult: { kind: detected.kind, evidence: detected.evidence },
  }
})

route('PATCH', /^\/api\/providers\/([\w-]+)$/, async (ctx) => {
  await inv.updateProvider(ctx.params[0], ctx.body)
  // 换令牌后价格表必须重取，否则还是按旧令牌的结果缓存 5 分钟
  if (ctx.body?.adminToken !== undefined) invalidatePricing(ctx.params[0])
  return buildState()
})

route('DELETE', /^\/api\/providers\/([\w-]+)$/, async (ctx) => {
  await inv.deleteProvider(ctx.params[0])
  invalidatePricing(ctx.params[0])
  return buildState()
})

// 拖拽排序：一次把整份顺序落盘，比逐个 PATCH 少一堆中间态
route('POST', /^\/api\/providers\/reorder$/, async (ctx) => {
  const ids = Array.isArray(ctx.body?.ids) ? ctx.body.ids.map(String) : []
  await inv.reorderProviders(ids)
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
  // 同步模型时把该站**所有** Key 都试一遍，取并集。
  // 只试第一个 Key 是个坑：加了一把新 Key 之后，同步用的还是那把旧的，
  // 旧的过期了就会「明明填了新 Key 却拉不到模型」。
  const targets = ctx.body.credentialId
    ? db.credentials.filter((c) => c.id === ctx.body.credentialId)
    : db.credentials.filter((c) => c.providerId === provider.id)
  if (targets.length === 0) throw new HttpError(400, '该站点还没有 Key，先添加一个')

  const previous = new Set(
    db.offers.filter((o) => o.providerId === provider.id).map((o) => o.upstreamName),
  )

  // 逐把 Key 同步，各自带自己的分组——不能先并集再统一塞进第一把的分组，
  // 否则两把 Key 属于不同分组时，模型会挂到错误的分组上，行数也会虚高。
  //
  // 拉取并行、写盘串行：串行拉取时最坏情况是「N 把 Key × 超时」，
  // 两把就能等一分半；而 mutate 是读-改-写，并发写会互相覆盖。
  const startedAt = Date.now()
  const syncTimeoutMs = Math.min(Number(db.settings.probeTimeoutMs) || 15000, 20000)
  const fetched = await Promise.all(
    targets.map(async (credential) => {
      const apiKey = await inv.revealSecret(credential.id)
      if (!apiKey) {
        return { credential, error: 'Key 解密失败，可能是 master.key 被替换过' }
      }
      try {
        const result = await providers.listModels({
          baseUrl: provider.baseUrl,
          apiKey,
          timeoutMs: syncTimeoutMs,
        })
        return { credential, models: result.models }
      } catch (error) {
        return { credential, error: error.message || String(error) }
      }
    }),
  )

  const allModels = new Set()
  const failures = []
  const perKey = []
  let added = 0
  let removedTotal = 0

  for (const row of fetched) {
    if (row.error) {
      failures.push({ label: row.credential.label, error: row.error })
      continue
    }
    const saved = await inv.syncOffers(
      provider.id,
      row.credential.id,
      row.models,
      row.credential.group || '',
    )
    // 拉到了模型才敢标：空响应多半是站点抽风，不是「模型全下线了」
    const pruned =
      row.models.length > 0
        ? await inv.markDelisted(provider.id, row.credential.id, row.models)
        : { delisted: 0, revived: 0 }
    added += saved.added
    removedTotal += pruned.delisted
    for (const name of row.models) allModels.add(name)
    perKey.push({
      credentialId: row.credential.id,
      label: row.credential.label,
      group: row.credential.group || '',
      count: row.models.length,
      removed: pruned.delisted,
      // 复活现在由 syncOffers 当场摘标记（revived），markDelisted 只负责标记消失的；
      // 两者相加保持「本次同步复活了几个」的口径不变
      revived: (saved.revived || 0) + pruned.revived,
    })
  }

  if (allModels.size === 0) {
    throw new HttpError(
      502,
      `所有 Key 都拉不到模型：${failures.map((f) => `${f.label}: ${f.error}`).join(' | ')}`,
    )
  }

  const elapsedMs = Date.now() - startedAt
  const list = [...allModels]

  const current = new Set(list)
  const state = await buildState()
  return {
    ...state,
    sync: {
      providerId: provider.id,
      fetched: list.length,
      added,
      removed: [...previous].filter((name) => !current.has(name)),
      pruned: removedTotal,
      elapsedMs,
      keysUsed: perKey.length,
      keysTotal: targets.length,
      // 每把 Key 各自拉到几个模型——总数是并集，用户看到「11 个」时能对上账
      perKey,
      failures,
    },
  }
})

route('POST', /^\/api\/providers\/([\w-]+)\/group-ratio$/, async (ctx) => {
  const result = await inv.setGroupRatio(ctx.params[0], ctx.body.group, ctx.body.ratio)
  return { ...(await buildState()), groupRatioResult: result }
})

/**
 * 删掉一个分组。
 *
 * 两种来源语义不同：「＋」复制出来的孤儿分组跟着供给行一起删掉；Key 自带的分组
 * 保留 Key，只把分组归属清掉（之后在 Key 那行重新「选分组」就能加回来）。
 * 具体规则收在 inv.deleteGroup，路由只负责回传全量 state。
 */
route('POST', /^\/api\/providers\/([\w-]+)\/delete-group$/, async (ctx) => {
  const result = await inv.deleteGroup(ctx.params[0], ctx.body.group)
  return { ...(await buildState()), groupDeleteResult: result }
})

/**
 * 站点价格的加载与匹配，供「选分组」和「应用倍率」共用。
 *
 * 中转站的倍率是按「分组」定的，所以流程一定是：先知道你在哪个分组，
 * 再拿这个分组的倍率去乘模型原价。这两步拆成两个接口：
 *   GET  /groups      —— 只读，列出该站所有分组 + 每个分组能对上几个模型
 *   POST /apply-group —— 写，把选定分组的倍率落到 offer 上
 *
 * 价格表按站点缓存 5 分钟：每点一次「选分组」都要走两次网络（channels 失败再回落 plaza），
 * 一个站十几个分组、来回点几次就明显卡。缓存只影响「读」，写操作后主动失效。
 */
const PRICING_TTL_MS = 5 * 60 * 1000
// 失败也要缓存一小会儿：站点超时要 10 秒，连点几次「选分组」会一直转圈。
// 30 秒足够让用户看到「读不到」，又不至于让一次抖动锁死五分钟。
const PRICING_FAIL_TTL_MS = 30 * 1000
const pricingCache = new Map()

function invalidatePricing(providerId) {
  pricingCache.delete(providerId)
}

async function loadProviderPricing(providerId, { fresh = false } = {}) {
  const db = await store.readDb()
  const provider = db.providers.find((p) => p.id === providerId)
  if (!provider) throw new HttpError(404, '站点不存在')

  const cached = pricingCache.get(providerId)
  if (!fresh && cached) {
    const ttl = cached.error ? PRICING_FAIL_TTL_MS : PRICING_TTL_MS
    if (Date.now() - cached.at < ttl) {
      if (cached.error) throw new HttpError(502, cached.error)
    }
  }

  let pricing
  if (!fresh && cached && !cached.error && Date.now() - cached.at < PRICING_TTL_MS) {
    pricing = cached.data
  } else {
    try {
      const adminToken = await inv.revealAdminToken(provider.id)
      pricing = await providers.fetchProviderPricing({
        baseUrl: provider.baseUrl,
        adminToken,
        kind: provider.kind,
      })
      pricingCache.set(providerId, { at: Date.now(), data: pricing })
    } catch (error) {
      const message = error.message || String(error)
      pricingCache.set(providerId, { at: Date.now(), error: message })
      // 令牌失效：登录过的站先自动重登一次（冷却 10 分钟），成功就用新令牌
      // 重取一次；手动令牌/重登失败才标红到站点卡
      if (/HTTP (401|403)/.test(message)) {
        const relogin = await inv.autoRelogin(provider.id)
        if (relogin.ok) {
          invalidatePricing(provider.id)
          const retried = await providers.fetchProviderPricing({
            baseUrl: provider.baseUrl,
            adminToken: relogin.token,
            kind: provider.kind,
          })
          pricingCache.set(providerId, { at: Date.now(), data: retried })
          pricing = retried
        } else {
          await inv.setTokenStatus(provider.id, { ok: false, message }).catch(() => {})
          throw new HttpError(502, `${message}（${relogin.reason}）`)
        }
      } else {
        throw new HttpError(502, message)
      }
    }
  }

  const byModel = new Map()
  for (const model of pricing.models) {
    const key = inv.normalizeModelKey(model.name)
    if (!byModel.has(key)) byModel.set(key, model)
  }
  // 分组已知时优先按 (分组, 模型) 取——同一模型在不同分组可能是不同上游、不同原价
  const byGroupModel = new Map()
  for (const model of pricing.byGroup || []) {
    if (!model.group) continue
    // 分组名归一化：站点公告与 Key 上的分组名经常差一个尾随空格，
    // 不归一化就会「exact 查不到 → 退回全站原价」，价格直接放大 10 倍
    byGroupModel.set(`${inv.normalizeGroup(model.group)}::${inv.normalizeModelKey(model.name)}`, model)
  }

  const offers = db.offers.filter((o) => o.providerId === provider.id)
  const match = (offer, group) =>
    (group && byGroupModel.get(`${inv.normalizeGroup(group)}::${offer.modelKey}`)) ||
    byModel.get(offer.modelKey) ||
    byModel.get(inv.normalizeModelKey(offer.upstreamName)) ||
    null

  const credentials = db.credentials.filter((c) => c.providerId === provider.id)
  // 「当前分组」取第一把 Key 的分组：分组是 Key 的属性（不同 Key 可能买的是不同套餐），
  // 但绝大多数站一个账号一个分组，用第一把来展示足够。
  const credential = credentials[0] || null

  return {
    db,
    provider,
    credential,
    credentials,
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
  const credentialId = ctx.query?.get('credentialId') || ''
  const fresh = ctx.query?.get('fresh') === '1'
  const { credential, credentials, pricing, offers, match, byGroupModel } = await loadProviderPricing(
    ctx.params[0],
    { fresh },
  )
  // 分组是「这把 Key」的属性：从哪一行点进来的，就显示哪一把的当前分组。
  const active = credentials.find((c) => c.id === credentialId) || credential
  const current = active?.group || ''

  // 广场能给出「哪个分组有哪些模型」，就按分组严格数；只有渠道数据时只能全站数，
  // 每个分组都会显示成同一个数——那就没意义了，所以优先用严格口径。
  const strict = byGroupModel.size > 0
  const coveredIn = (groupName) =>
    strict
      ? offers.filter((offer) => byGroupModel.has(`${inv.normalizeGroup(groupName)}::${offer.modelKey}`)).length
      : offers.filter((offer) => match(offer, groupName)).length

  const groups = pricing.groups
    .map((g) => ({
      name: inv.normalizeGroup(g.name),
      rate: g.rate,
      modelCount: coveredIn(g.name),
      isCurrent: inv.normalizeGroup(g.name) === inv.normalizeGroup(current),
    }))
    // 能覆盖模型的排前面，其次是倍率低的
    .sort((a, b) => {
      if (b.modelCount !== a.modelCount) return b.modelCount - a.modelCount
      return (a.rate ?? 99) - (b.rate ?? 99)
    })

  const unmatched = offers.filter((offer) => !match(offer, current)).map((o) => o.upstreamName)

  return {
    providerId: ctx.params[0],
    credentialId: active?.id || null,
    credentialLabel: active?.label || null,
    keyCount: credentials.length,
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
  const group = inv.normalizeGroup(ctx.body.group)
  const credentialId = String(ctx.body.credentialId || '')
  const { db, provider, credential, credentials, pricing, match, benchTable, byGroupModel } =
    await loadProviderPricing(providerId)

  // 分组是 Key 的属性，必须作用在「你点的那把 Key」上，不能默认第一把
  const target = credentials.find((c) => c.id === credentialId) || credential
  if (!target) throw new HttpError(400, '该站点还没有 Key')

  // 分组删掉之后重新导入：那把 Key 名下的供给行跟着分组一起删了，光应用倍率只会
  // 更新 0 条，分组看起来再也加不回来。所以「这个 Key 一条供给都没有」时，先按它
  // 重新拉一次模型把行建出来；已有行就不拉——正常换分组只是给现成的行改倍率，
  // 不该每次点「应用」都多一次网络请求。
  let resynced = 0
  let resyncError = null
  const ownsOffers = db.offers.some(
    (o) => o.providerId === provider.id && o.credentialId === target.id,
  )
  if (!ownsOffers && group) {
    try {
      const apiKey = await inv.revealSecret(target.id)
      if (!apiKey) throw new Error('Key 解密失败，可能是 master.key 被替换过')
      const timeoutMs = Math.min(Number(db.settings?.probeTimeoutMs) || 15000, 20000)
      const listed = await providers.listModels({ baseUrl: provider.baseUrl, apiKey, timeoutMs })
      const saved = await inv.syncOffers(provider.id, target.id, listed.models, group)
      resynced = saved.added
    } catch (error) {
      // 拉模型失败不该让「分组记在这把 Key 上」也跟着失败：分组先存下来，
      // 用户之后点「一键同步」照样能把模型拉回来
      resyncError = error.message || String(error)
    }
  }

  // 分组名两侧可能有空白差异（实测 Key 存的「国模-0045 p哥」与站点公布的
  // 「国模-0045 p哥 」差一个尾随空格），归一化后再匹配，否则倍率解析成 null，
  // 落价会退回「原价手填」，价格直接放大约 10 倍
  const normGroup = (value) => inv.normalizeGroup(value)
  const rateOfGroup = new Map(pricing.groups.map((g) => [normGroup(g.name), g.rate]))
  const rates = pricing.groups.map((g) => g.rate).filter((r) => typeof r === 'number')
  const uniformRate = rates.length > 0 && rates.every((r) => r === rates[0]) ? rates[0] : null
  // 分组没给（或这个站只有一个分组）时，能确定倍率就用，确定不了就按原价算
  const rate = group && rateOfGroup.has(normGroup(group)) ? rateOfGroup.get(normGroup(group)) : uniformRate

  // 记下这把 Key 属于哪个分组，下次打开就不用再选
  const prevGroup = inv.normalizeGroup(target.group)
  if (group !== prevGroup) {
    // 用户在「导入倍率」里手选的分组：标记 manual，之后自动识别不覆盖
    await inv.updateCredential(target.id, { group, groupSource: 'manual' })
  }

  let updated = 0
  let viaRatio = 0
  let viaPercall = 0
  let modelTotal = 0
  const unmatched = []
  const missingBench = []

  await store.mutate((d) => {
    for (const offer of d.offers) {
      if (offer.providerId !== provider.id) continue
      modelTotal += 1
      // 只接管属于这把 Key 的行。优先按 credentialId 精确判断——
      // 两把 Key 都在默认分组时，光看 group 会互相踩。
      // 没有 credentialId 的老数据才回落到 group 比较。
      if (offer.credentialId) {
        if (offer.credentialId !== target.id) continue
      } else if (inv.normalizeGroup(offer.group) !== inv.normalizeGroup(prevGroup)) {
        continue
      }

      const hit = match(offer, group)
      if (!hit) {
        unmatched.push(offer.upstreamName)
        continue
      }

      const key = offer.benchmarkKey || offer.modelKey || offer.upstreamName
      // 落价三分支（免费优先 / 倍率模式 / 广场价×倍率）与 detect-groups 共用
      // inv.applySitePricing——exact 只认本分组精确命中，全站回落价用它判免费会误伤
      const via = inv.applySitePricing(offer, {
        exact: byGroupModel.get(`${group}::${offer.modelKey}`) || null,
        rate,
        sitePrice: hit,
        hasBench: Boolean(benchTable[key]),
      })
      if (via === 'ratio') viaRatio += 1
      if (via === 'percall') viaPercall += 1
      if (via === 'manual' && !benchTable[key]) missingBench.push(offer.upstreamName)

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
      viaPercall,
      unmatched,
      missingBench,
      source: pricing.source,
      modelTotal,
      // 分组被删掉之后重新导入时，按这把 Key 补回来的模型数（0 = 没有重建）
      resynced,
      resyncError,
      // 明确回传「改的是哪把 Key」，前端据此提示，避免「我改的是第二把，第一把却变了」
      credentialId: target.id,
      credentialLabel: target.label,
    },
  }
})

/**
 * 从站点后台的「令牌列表」反查每把 Key 属于哪个分组，并直接按各自的分组应用倍率。
 *
 * 这一步比「让用户从十几个分组里猜」可靠得多：分组是你买套餐时的商务事实，
 * 站点后台存着，我们只需要读出来。
 */
route('POST', /^\/api\/providers\/([\w-]+)\/detect-groups$/, async (ctx) => {
  const providerId = ctx.params[0]
  const db = await store.readDb()
  const provider = db.providers.find((p) => p.id === providerId)
  if (!provider) throw new HttpError(404, '站点不存在')

  const adminToken = await inv.revealAdminToken(provider.id)
  if (!adminToken) {
    throw new HttpError(400, '需要先在站点卡片上填「令牌」，才能读后台的令牌列表')
  }

  const credentials = db.credentials.filter((c) => c.providerId === provider.id)
  if (credentials.length === 0) throw new HttpError(400, '该站点还没有 Key')

  let items = []
  let source = null
  try {
    const fetched = await providers.fetchTokenList({
      baseUrl: provider.baseUrl,
      adminToken,
      timeoutMs: 20000,
    })
    items = fetched.items
    source = fetched.source
    await inv.setTokenStatus(provider.id, { ok: true })
  } catch (error) {
    // 401/403 说明令牌本身失效，别的错（网络、结构）不算令牌的锅
    if (/HTTP (401|403)/.test(String(error?.message || ''))) {
      await inv.setTokenStatus(provider.id, { ok: false, message: error.message })
    }
    throw error
  }

  // 价格表读不到不影响「认分组」——令牌列表本身就带倍率（Sub2API），够用了
  let pricing = { groups: [] }
  let match = () => null
  let byGroupModel = new Map()
  let benchTable = {}
  let pricingError = null
  try {
    const loaded = await loadProviderPricing(providerId)
    pricing = loaded.pricing
    match = loaded.match
    byGroupModel = loaded.byGroupModel
    benchTable = loaded.benchTable
  } catch (error) {
    pricingError = error.message || String(error)
    benchTable = await bench.readBenchmarks()
  }
  const normGroupName = (value) => inv.normalizeGroup(value)
  const rateOfGroup = new Map(pricing.groups.map((g) => [normGroupName(g.name), g.rate]))

  const results = []
  for (const credential of credentials) {
    const secret = await inv.revealSecret(credential.id)
    const hit = providers.matchTokenBySecret(items, secret)
    // 分组名必须归一化再写入：offers 与 credentials 两边口径不一致时，
    // 下一轮 syncOffers 的去重键就永远匹配不上，于是每同步一次就多插一整套
    // 重复行（实测一个模型积到 7 份，比价页同一分组刷出 7 行一模一样的）
    const group = inv.normalizeGroup(hit?.group)
    if (!group) {
      results.push({
        credentialId: credential.id,
        label: credential.label,
        matched: false,
        reason: hit ? '这把 Key 在后台没有分组' : '后台令牌列表里找不到这把 Key',
      })
      continue
    }
    // 后台识别只写 auto：用户在「导入倍率」里手选过的分组是商务事实，
    // 后台令牌列表的线索不能覆盖它（识别结果仍会显示在结果里）
    const manualPinned = credential.groupSource === 'manual'
    if (!manualPinned) await inv.updateCredential(credential.id, { group, groupSource: 'auto' })
    // 令牌里直接带了倍率就用它（Sub2API），否则查价格表
    const rate = typeof hit.rate === 'number' ? hit.rate : (rateOfGroup.get(normGroupName(group)) ?? null)
    results.push({
      credentialId: credential.id,
      label: credential.label,
      matched: true,
      group,
      tokenName: hit.name || '',
      rate,
      // 手选过的 Key 后台识别不覆盖，但倍率仍按后台分组落价（分组归属不动）
      pinned: manualPinned,
      updated: 0,
    })
  }

  // 按每把 Key 自己的分组落倍率。只动属于该 Key 的行，互不干扰。
  // 落价三分支（免费优先 / 倍率模式 / 广场价×倍率）与 apply-group 共用
  // inv.applySitePricing——两处此前各写一遍，细节已经漂移过一次
  await store.mutate((d) => {
    for (const row of results) {
      if (!row.matched) continue
      // 手选过分组的 Key：分组归属与倍率都不动（用户买的那一档是商务事实），
      // 只在结果里报告后台识别到的分组供参考
      if (row.pinned) continue
      for (const offer of d.offers) {
        if (offer.providerId !== provider.id) continue
        if (offer.credentialId !== row.credentialId) continue

        const key = offer.benchmarkKey || offer.modelKey || offer.upstreamName
        const hit = match(offer, row.group)
        // 分组名先写上——这一步不依赖价格表，读不到广场也该记住「你属于哪个分组」
        offer.group = inv.normalizeGroup(row.group)

        const via = inv.applySitePricing(offer, {
          exact: byGroupModel.get(`${inv.normalizeGroup(row.group)}::${offer.modelKey}`) || null,
          rate: row.rate,
          sitePrice: hit,
          hasBench: Boolean(benchTable[key]),
        })
        if (via === 'skip') {
          // 既没有基准价、也没有广场价：只记分组，价格留给用户自己填
          offer.updatedAt = new Date().toISOString()
          row.unpriced = (row.unpriced || 0) + 1
          continue
        }
        offer.updatedAt = new Date().toISOString()
        row.updated += 1
      }
    }
  })

  return {
    ...(await buildState()),
    detectResult: {
      tokenCount: items.length,
      source,
      keyCount: credentials.length,
      matched: results.filter((r) => r.matched).length,
      pricingError,
      results,
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
  const adminToken = await inv.revealAdminToken(provider.id)
  if (!adminToken) {
    throw new HttpError(400, '需要先在站点卡片上点「令牌」，填一个站点后台的登录令牌')
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
      // model 排在复合键最后一段，名字里含 | 时剩余段重新 join（与 usage.js 同规则）
      const [, providerId, ...modelParts] = composite.split('|')
      const model = modelParts.join('|')
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

  // ---- 真正的核验：拿「我们本地算出来的 token 数」和「站点上报的 token 数」比。
  // 这是唯一不依赖站点自报数字的独立证据——站点虚报 prompt_tokens 时，
  // 我们记录的 usage 会跟着虚报，光和它自己比永远一致。
  // 数据来自网关侧抽样（recordBillingSample）和探针（探针也走同一套上游调用）
  const sampleRows = await inv.listBillingSamples(provider.id, 30)
  const probeRows = (db.probes || []).filter((r) => r.providerId === provider.id && r.ok && r.promptTokens)
  const siteStats = (raw?.['/api/v1/usage/stats']?.data) || raw?.['/api/v1/usage/stats'] || null

  const verify = {
    // 逐条样本：本地估算 vs 上游上报
    samples: [
      // 老探针记录没有 requestTokens，没有对照价值，只保留能比对的
      ...probeRows
        .filter((r) => typeof r.requestTokens === 'number' && r.requestTokens > 0)
        .slice(-15)
        .map((r) => ({
          at: r.ts,
          source: 'probe',
          modelKey: r.modelKey || null,
          local: r.requestTokens,
          reported: r.promptTokens ?? null,
        })),
      ...sampleRows.map((r) => ({
        at: r.ts,
        source: 'gateway',
        modelKey: r.modelKey,
        local: r.localTokens,
        reported: r.reportedPrompt,
        suspicious: Boolean(r.suspicious),
      })),
    ]
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 30),
    // 站点声明的全站合计（若有）
    site: siteStats
      ? {
          requests: siteStats.total_requests ?? null,
          input: siteStats.total_input_tokens ?? null,
          cacheRead: siteStats.total_cache_read_tokens ?? null,
          output: siteStats.total_output_tokens ?? null,
          cost: siteStats.total_cost ?? null,
          actualCost: siteStats.total_actual_cost ?? null,
        }
      : null,
  }

  return {
    raw,
    estimate: {
      requests: estRequests,
      input: estInput,
      output: estOutput,
      cost: Math.round(estCost * 10000) / 10000,
    },
    verify,
  }
})

route('POST', /^\/api\/providers\/([\w-]+)\/balance$/, async (ctx) => {
  const db = await store.readDb()
  const provider = db.providers.find((p) => p.id === ctx.params[0])
  if (!provider) throw new HttpError(404, '站点不存在')
  const credentials = db.credentials.filter((c) => c.providerId === provider.id)
  if (credentials.length === 0) throw new HttpError(400, '该站点还没有 Key')

  // 所有 Key 都试（与 sync 同口径）：旧 Key 过期、新 Key 可用时也能读到余额
  const apiKeys = (await Promise.all(credentials.map((c) => inv.revealSecret(c.id)))).filter(Boolean)
  const adminToken = await inv.revealAdminToken(provider.id)
  const result = await providers.tryBalanceWithKeys({
    baseUrl: provider.baseUrl,
    apiKeys,
    adminToken,
    kind: provider.kind,
  })
  // 令牌失效会挂在 reason 里（HTTP 401/403）——登录过的站先自动重登一次
  // 再试；手动令牌/重登失败才标红到卡片
  if (adminToken && !result.ok && /HTTP (401|403)/.test(String(result.reason || ''))) {
    const relogin = await inv.autoRelogin(provider.id)
    if (relogin.ok) {
      const retried = await providers.tryBalanceWithKeys({
        baseUrl: provider.baseUrl,
        apiKeys,
        adminToken: relogin.token,
        kind: provider.kind,
      })
      if (retried.ok) {
        await inv.updateProvider(provider.id, {
          quotaRemaining: retried.remaining,
          currency: retried.currency,
        })
        return { ...(await buildState()), balance: retried }
      }
      result.reason = retried.reason || result.reason
    }
  }
  if (adminToken) {
    const bad = /HTTP (401|403)/.test(String(result.reason || ''))
    if (bad) await inv.setTokenStatus(provider.id, { ok: false, message: result.reason, status: 401 })
    else if (result.ok) await inv.setTokenStatus(provider.id, { ok: true })
  }
  // 余额是账号级的，写回站点——挂在 Key 上会导致「加第二个 Key 余额显示 0」
  if (result.ok) {
    await inv.updateProvider(provider.id, {
      quotaRemaining: result.remaining,
      currency: result.currency,
    })
    // 手动刷一次余额也进曲线——否则用户点了刷新，图上却没动静。
    await store.mutate((current) =>
      applySnapshot(current, {
        providerId: provider.id,
        at: new Date().toISOString(),
        balance: result,
      }),
    )
  }
  return { ...(await buildState()), balance: result }
})

// -------------------------------------------------------------------- 监控
//
// 监控页一次要的东西比较多（余额曲线、变动流、公告、告警、采集记录），
// 全部塞进 /api/state 会让每次进页面都变重，所以单独一个接口按需拉。

/** 组装监控视图：唯一的入口，四个路由共用，保证口径一致。 */
async function monitorView(days = 7) {
  const db = await store.readDb()
  const benchmarks = await bench.readBenchmarks()
  return buildMonitorView(db, { usageData: await readUsage(), benchmarks, days })
}

route('GET', /^\/api\/fx$/, async () => {
  const fx = await fxLib.readFx()
  return { ...fx, stale: fxLib.isStale(fx), refreshMs: fxLib.FX_REFRESH_MS }
})

route('POST', /^\/api\/fx\/refresh$/, async () => {
  const result = await fxLib.refreshFx({ logger: console })
  if (!result.ok) {
    // 手动模式与网络失败都如实告诉页面，让用户知道「没更新」而不是假装成功
    if (result.error === 'manual') return { ...result, hint: '当前是手动汇率，先恢复自动再刷新' }
    return { ...result, hint: '拉取失败，继续用上一次的汇率' }
  }
  return result
})

route('GET', /^\/api\/monitor$/, async (ctx) => {
  const days = Math.min(Math.max(Number(ctx.query.get('days')) || 7, 1), 90)
  return monitorView(days)
})

route('POST', /^\/api\/monitor\/collect$/, async (ctx) => {
  const providerId = ctx.body?.providerId || null
  const results = await collectProviderSnapshots({ providerId })
  const days = Math.min(Math.max(Number(ctx.body?.days) || 7, 1), 90)
  return { ...(await monitorView(days)), results }
})

route('POST', /^\/api\/monitor\/alerts\/read$/, async (ctx) => {
  const ids = Array.isArray(ctx.body?.ids) ? ctx.body.ids : []
  await store.mutate((db) => markAlertsRead(db, ids))
  return monitorView(7)
})

route('POST', /^\/api\/monitor\/announcements\/read$/, async (ctx) => {
  const ids = Array.isArray(ctx.body?.ids) ? ctx.body.ids : []
  await store.mutate((db) => markAnnouncementsRead(db, ids))
  return monitorView(7)
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
  const benchmarks = await bench.readBenchmarks()
  await store.mutate((db) => {
    const offer = db.offers.find((o) => o.id === ctx.params[0])
    if (!offer) throw new HttpError(404, '模型记录不存在')
    const b = ctx.body
    const prevMode = offer.pricingMode === 'ratio' ? 'ratio' : 'manual'
    // 只填倍率时就当「要用倍率」：未定价那张表里三个框都能填，
    // 只填倍率必须真的生效。否则 ratio 写进去了、模式还停在 manual，
    // 实际价永远是空——看着就像「倍率根本没参与计算」。
    const impliesRatio =
      b.pricingMode === undefined && b.ratio !== undefined && b.ratio !== null && b.ratio !== ''
    const nextMode =
      b.pricingMode !== undefined
        ? b.pricingMode === 'ratio'
          ? 'ratio'
          : 'manual'
        : impliesRatio
          ? 'ratio'
          : prevMode
    const switchingToManual = nextMode === 'manual' && prevMode !== 'manual'
    const switchingToRatio = nextMode === 'ratio' && prevMode !== 'ratio'
    if (b.pricingMode !== undefined || impliesRatio) {
      offer.pricingMode = nextMode
    }
    // 换算只在「用户点了模式切换按钮」时做：那一下的意思是「价格不变，换个表示法」。
    // 改倍率不换算——输入框存的就是原价，倍率一动价格就该跟着动，这才是用户要的
    const explicitModeSwitch = b.pricingMode !== undefined && switchingToRatio && !impliesRatio
    if (b.ratio !== undefined) {
      offer.ratio = nonNegative(b.ratio, '分组倍率')
    }
    if (b.benchmarkKey !== undefined) offer.benchmarkKey = b.benchmarkKey || null
    if (b.inPrice !== undefined) offer.inPrice = nonNegative(b.inPrice, '输入单价')
    if (b.outPrice !== undefined) offer.outPrice = nonNegative(b.outPrice, '输出单价')
    if (b.currency !== undefined) offer.currency = b.currency === 'CNY' ? 'CNY' : 'USD'
    if (b.priceUnit !== undefined) {
      offer.priceUnit = pricing.PRICE_UNITS.includes(b.priceUnit) ? b.priceUnit : 'per_mtok'
    }
    // 倍率模式定义在 token 口径上（基准价 × 倍率 = 每百万 token 价）——
    // 切到 ratio 时按次的单位自动回 per_mtok，避免出现 per_call + ratio 的死角
    if (offer.pricingMode === 'ratio' && offer.priceUnit === 'per_call') {
      offer.priceUnit = 'per_mtok'
    }
    if (b.group !== undefined) {
      const name = inv.normalizeGroup(b.group)
      const clash = db.offers.some(
        (o) =>
          o.id !== offer.id &&
          o.providerId === offer.providerId &&
          inv.normalizeGroup(o.group) === name &&
          o.upstreamName === offer.upstreamName,
      )
      if (clash) throw new HttpError(400, `该站「${name || '默认'}」分组下已经有同名模型了`)
      offer.group = name
    }
    // 两种模式的输入框含义不同：
    //   倍率模式 —— 输入框是「原价」，实际价 = 原价 × 倍率
    //   价格模式 —— 输入框是「最终价」
    // 所以切模式必须做一次换算，把价格守住，否则切一下价格就跳一个数量级。
    // per_call 除外：按次的单价与 token 折算价是两回事，用户传什么就用什么
    const ratioOf = Number(offer.ratio)
    const hasRatio = Number.isFinite(ratioOf) && ratioOf > 0
    const round3 = (v) => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000)
    // 用户在同一次请求里显式传了价：那就是新口径下的价，别再换算（否则会被多除一次）
    const touchedPrices = b.inPrice !== undefined || b.outPrice !== undefined
    if (switchingToManual && offer.priceUnit !== 'per_call' && hasRatio && !touchedPrices) {
      if (offer.inPrice != null || offer.outPrice != null) {
        offer.inPrice = round3(offer.inPrice == null ? null : Number(offer.inPrice) * ratioOf)
        offer.outPrice = round3(offer.outPrice == null ? null : Number(offer.outPrice) * ratioOf)
      } else {
        // 输入框本来就空着（历史数据靠基准价算的）：把折算价直接种进去
        const asRatio = pricing.resolveOfferPrice({ ...offer, pricingMode: 'ratio' }, benchmarks)
        if (asRatio && asRatio.source === 'ratio') {
          offer.inPrice = asRatio.inPrice
          offer.outPrice = asRatio.outPrice
          offer.currency = asRatio.currency
          offer.priceUnit = 'per_mtok'
        }
      }
      // 倍率保留：价格模式下 resolveOfferPrice 不看它（pricingMode 是权威），
      // 但切回倍率模式时靠它换算，丢了就得让用户重填
    }
    if (explicitModeSwitch && offer.priceUnit !== 'per_call' && hasRatio && !touchedPrices) {
      // 价格 → 倍率：把最终价还原成原价，实际价保持不变
      if (offer.inPrice != null || offer.outPrice != null) {
        offer.inPrice = round3(offer.inPrice == null ? null : Number(offer.inPrice) / ratioOf)
        offer.outPrice = round3(offer.outPrice == null ? null : Number(offer.outPrice) / ratioOf)
      }
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

// -------------------------------------------------------------- 免费池 · 配额

route('POST', /^\/api\/offers\/([\w-]+)\/free-quota$/, async (ctx) => {
  const quota = ctx.body?.quota ?? ctx.body ?? null
  await inv.setFreeQuota(ctx.params[0], quota)
  return buildState()
})

// ------------------------------------------------------------ 免费池 · 平台侧

route('POST', /^\/api\/free\/platforms$/, async (ctx) => {
  const platform = await platforms.upsertPlatform(ctx.body || {})
  const state = await buildState()
  return { ...state, platformResult: platform }
})

route('DELETE', /^\/api\/free\/platforms\/([\w-]+)$/, async (ctx) => {
  await platforms.deletePlatform(ctx.params[0])
  return buildState()
})

route('POST', /^\/api\/free\/accounts$/, async (ctx) => {
  // 自动连接的平台必须带凭据才允许建账号：不然谁都能塞一个「剩余 100」的空账号，
  // 让页面显示有额度、实际根本用不了（这也是「登录失败还能录入积分」的来源之一）。
  const platformId = ctx.body?.platformId
  const db = await platforms.readFreeDb()
  const platform = db.platforms.find((p) => p.id === platformId)
  if (!platform) throw new HttpError(404, '平台不存在')
  if (platform.connectorId !== 'manual' && !ctx.body?.secret) {
    throw new HttpError(400, '这个平台的账号要连上之后才建，先点「连接」')
  }
  const account = await platforms.addAccount(ctx.body || {})
  const state = await buildState()
  return { ...state, accountResult: account }
})

route('PATCH', /^\/api\/free\/accounts\/([\w-]+)$/, async (ctx) => {
  await platforms.updateAccount(ctx.params[0], ctx.body || {})
  return buildState()
})

route('DELETE', /^\/api\/free\/accounts\/([\w-]+)$/, async (ctx) => {
  await platforms.deleteAccount(ctx.params[0])
  return buildState()
})

route('POST', /^\/api\/free\/accounts\/([\w-]+)\/checkin$/, async (ctx) => {
  const freeDb = await platforms.readFreeDb()
  const account = freeDb.accounts.find((a) => a.id === ctx.params[0])
  if (!account) throw new HttpError(404, '账号不存在')
  const platform = freeDb.platforms.find((p) => p.id === account.platformId)
  const connector = platform ? platforms.getConnector(platform.connectorId) : null

  // 没有连接器、或连接器不会签到：只能说清楚「这里没有自动签到」，不能假装签成功
  if (!connector || typeof connector.checkin !== 'function') {
    throw new HttpError(400, '这个平台没有自动签到，只能手动记一笔')
  }
  if (!account.secret) {
    throw new HttpError(400, '这个账号还没连上平台，先点「连接」授权')
  }

  // 真签到：打到平台接口，成功才写账本
  const result = await connector.checkin(account)
  const reward = Number(result?.reward) || 0
  if (result?.ok !== false) {
    await platforms.checkin(account.id, {
      reward,
      note: result?.alreadyToday ? '今日已签（重复触发）' : '每日签到',
    })
  }
  const state = await buildState()
  return { ...state, checkinResult: result }
})

// ------------------------------------------------- 免费池 · 平台连接（OAuth 轮询）

/** 取平台 + 它的连接器；连接器缺失说明这个平台只能手动记账 */
async function platformConnector(platformId) {
  const db = await platforms.readFreeDb()
  const platform = db.platforms.find((p) => p.id === platformId)
  if (!platform) throw new HttpError(404, '平台不存在')
  const connector = platforms.getConnector(platform.connectorId)
  if (!connector || typeof connector.startConnect !== 'function') {
    throw new HttpError(400, '这个平台不支持自动连接，先手动记额度')
  }
  return { platform, connector }
}

/**
 * 连接器只给「还剩多少」，窗口得从重置时间反推：
 * 离重置还有好几天 → 月周期；一两天内 → 日周期。
 * 原来固定写 'day'，配上月底的 resetAt，就成了「每天重置、下次重置在 10 天后」。
 */
function windowFromReset(resetAt, fallback = 'day') {
  const at = Date.parse(resetAt || '')
  if (!Number.isFinite(at)) return fallback
  return (at - Date.now()) / 86400000 > 3 ? 'month' : 'day'
}

/**
 * 把连接器读回来的额度整理成落库形状。
 *
 * 不编造 limit/used：连接器只读得到剩余量，硬造总量会画出「已用 0/113」这种假进度。
 */
function quotaPatch(quota, previous) {
  const resetAt = quota.refreshAt || previous?.resetAt || null
  return {
    unit: quota.unit || previous?.unit || 'credit',
    remaining: Number(quota.remaining),
    cycleRemaining: quota.cycleRemaining ?? null,
    cycleSize: quota.cycleSize ?? null,
    bonusTokens: quota.bonusTokens ?? previous?.bonusTokens ?? null,
    tenantKey: quota.tenantKey || previous?.tenantKey || '',
    // ZCode 语义标记：remaining 含一次性赠量（不受周期闸门限制）。
    // 本次没带就继承上次的——连接器升级过渡期不丢标记
    remainingIncludesOneTime: Boolean(quota.remainingIncludesOneTime || previous?.remainingIncludesOneTime) || undefined,
    limit: null,
    used: null,
    window: windowFromReset(resetAt, previous?.window || 'day'),
    resetAt,
  }
}

/** 读一次额度并写回账号；读不到不算致命错误，卡片保持上一次的数字。 */
async function refreshAccountQuota(connector, account) {
  const quota = await connector.quota(account)
  if (!quota || !Number.isFinite(Number(quota.remaining))) return null
  await platforms.updateAccount(account.id, { quota: quotaPatch(quota, account.quota) })
  return quota
}

route('POST', /^\/api\/free\/platforms\/([\w-]+)\/connect$/, async (ctx) => {
  const { platform, connector } = await platformConnector(ctx.params[0])
  // 这里**不建账号**：授权可能被取消、可能超时，先落库就会留下一张
  // 「连过但从没拿到 token」的空卡，还会被算进账号数与剩余额度。
  // 账号等授权真的回来了再建（见下面的 connect/poll）。
  const existing = await platforms.listAccounts(platform.id)
  const account = existing.find((a) => a.secret) || null

  const started = await connector.startConnect({ product: platform.connectorId })
  const state = await buildState()
  return { ...state, connect: { ...started, accountId: account?.id || null } }
})

route('POST', /^\/api\/free\/platforms\/([\w-]+)\/connect\/poll$/, async (ctx) => {
  const { platform, connector } = await platformConnector(ctx.params[0])
  const existing = await platforms.listAccounts(platform.id)
  // 已有账号就顺手把凭据落上去；没有就只把凭据拿回来，等下面建号，
  // 这样「轮询到一半关掉页面」不会在库里留下半张卡。
  const accountId =
    ctx.body?.accountId || existing.find((a) => a.secret)?.id || existing[0]?.id || null
  const result = await connector.pollConnect({
    state: ctx.body?.state,
    product: platform.connectorId,
    accountId,
  })

  let created = null
  if (result?.ready) {
    if (accountId) {
      await platforms.updateAccount(accountId, {
        status: 'ok',
        ...(result.profile?.label ? { label: result.profile.label } : {}),
      })
    } else if (result.credential) {
      // 授权成功才建账号。saveCredential 不传 id 时只返回密文，不落库。
      const secret = await connector.saveCredential(result.credential)
      created = await platforms.addAccount({
        platformId: platform.id,
        label: result.profile?.label || '主账号',
        status: 'ok',
        secret,
      })
    }
    // 连上就顺手读一次额度：用户点完连接最想看到的就是「还剩多少」。
    // 两条提示可能同时存在（昵称没读到 + 额度没读到），合并成一句给前端，不要互相覆盖。
    const warnings = [result.warning].filter(Boolean)
    const target = created || existing.find((a) => a.id === accountId)
    if (target) {
      try {
        await refreshAccountQuota(connector, created || target)
      } catch (error) {
        warnings.push(`额度还没读到（${error?.message || error}），点「刷新」再试一次`)
      }
    }
    if (warnings.length) result.warning = warnings.join('；')
  }

  const state = await buildState()
  return { ...state, connectPoll: result, connectAccount: created ? { id: created.id } : null }
})

route('POST', /^\/api\/free\/platforms\/([\w-]+)\/refresh$/, async (ctx) => {
  const { platform, connector } = await platformConnector(ctx.params[0])
  const accounts = await platforms.listAccounts(platform.id)
  const connected = accounts.filter((a) => a.secret)
  if (!connected.length) throw new HttpError(400, '还没有连接，先点「连接」')

  // 平台可能有多个账号（同一租户的多把钥匙），只刷第一个会让其余卡片永远停在旧数字上
  const results = []
  for (const account of connected) {
    try {
      const quota = await refreshAccountQuota(connector, account)
      results.push({ accountId: account.id, ok: true, quota })
    } catch (error) {
      results.push({ accountId: account.id, ok: false, error: error?.message || String(error) })
    }
  }

  const state = await buildState()
  const quota = results.find((row) => row.ok)?.quota || null
  return { ...state, refreshResult: { ok: results.some((row) => row.ok), quota, results } }
})

route('GET', /^\/api\/free\/ledger$/, async (ctx) => {
  const accountId = ctx.query?.get('accountId') || null
  return { ledger: await platforms.listLedger({ accountId, limit: 100 }) }
})

/** 把疑似凭据的字段打码，诊断信息要能直接贴给人看 */
function redactSecrets(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = /token|secret|password|authorization|cookie/i.test(k) ? '***' : redactSecrets(v, depth + 1)
  }
  return out
}

/**
 * 诊断：把平台只读接口的原始返回带出来。
 *
 * 连接器里那些字段名是反推的，对不上时唯一可靠的解法是看真实响应。
 * 前端点「诊断」后会把结果复制到剪贴板，用户贴给我就能一次改对。
 */
route('POST', /^\/api\/free\/platforms\/([\w-]+)\/diagnose$/, async (ctx) => {
  const { platform, connector } = await platformConnector(ctx.params[0])
  if (typeof connector.diagnose !== 'function') {
    throw new HttpError(400, '这个平台的连接器没有诊断接口')
  }
  const accounts = await platforms.listAccounts(platform.id)
  const account = accounts.find((a) => a.secret) || accounts[0]
  if (!account?.secret) throw new HttpError(400, '还没有连接，先点「连接」')
  const data = await connector.diagnose(account)
  return { diagnose: redactSecrets(data) }
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

  const adminToken = await inv.revealAdminToken(provider.id)
  const pricing = await providers.fetchProviderPricing({ baseUrl: provider.baseUrl, adminToken })

  // 读-改-写走 benchmark.js 的串行队列，与手动改价 / 载入参考价 / 从站导入互斥，
  // 并发到达时不再互相覆盖
  const result = await bench.mutateBenchmarks((table) => {
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
    return { added, skipped }
  })

  return {
    ...(await buildState()),
    plazaBenchResult: {
      added: result.added.length,
      skipped: result.skipped,
      total: pricing.models.length,
      source: pricing.source,
      items: result.added,
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
  if (includeKey && ctx.req.headers['x-manage-api-intent'] !== 'reveal-secret') {
    // 明文 Key 只给页面自己的「导出」按钮：跨站请求拿不到这个自定义头（预检会被拒）
    throw new HttpError(403, '导出明文 Key 需要页面内的确认操作')
  }
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

// 决策日志攒批写：每个请求都单独 mutate 等于把 1MB 的 db.json 整份重写一遍，
// 高峰期写放大很吓人。攒 2 秒一起落盘，界面最多晚 2 秒看到。
const routingBuffer = []
let routingTimer = null

function flushRouting() {
  if (routingTimer) {
    clearTimeout(routingTimer)
    routingTimer = null
  }
  if (!routingBuffer.length) return Promise.resolve()
  const batch = routingBuffer.splice(0, routingBuffer.length)
  return inv.recordRoutingBatch(batch).catch((error) => {
    // 写失败把本批塞回队头，下个 2 秒周期重试——决策日志是排查依据，
    // 静默丢弃等于让「为什么选了它」永远查不到
    console.error('[网关] 决策日志写盘失败，已回队重试：', error)
    routingBuffer.unshift(...batch)
  })
}

function queueRouting(entry) {
  routingBuffer.push(entry)
  if (routingBuffer.length >= 200) flushRouting() // 上游一直失败时别把内存堆爆
  if (!routingTimer) routingTimer = setTimeout(flushRouting, 2000)
}

// 真实流量计数先攒内存，每 5 秒刷一次盘——每个请求都重写 db.json 太重
const trafficBuffer = new Map()
let trafficTimer = null

function bufferTraffic(offerId, ok, error, quality) {
  if (!offerId) return
  const entry = trafficBuffer.get(offerId) || { ok: 0, fail: 0, kinds: {}, quality: { samples: 0, bad: 0 } }
  if (ok) entry.ok += 1
  else {
    // 只有站点故障算 fail；额度/限流/模型不在分组单独计数，不拉低可用率
    const { kind, countsAsOutage } = classifyFailure(error)
    if (countsAsOutage) entry.fail += 1
    else entry.kinds[kind] = (entry.kinds[kind] || 0) + 1
  }
  // 真实响应的质量信号（空回答/计费虚报）：探针之外的第二类完整性证据
  if (quality) {
    entry.quality = entry.quality || { samples: 0, bad: 0 }
    entry.quality.samples += 1
    if (quality.bad) entry.quality.bad += 1
  }
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
  try {
    await inv.addTraffic(snapshot)
  } catch (error) {
    // 写失败把快照合并回 buffer（累加而不是覆盖），下个 5 秒周期重试——
    // 流量计数直接参与可用率评分，丢一批等于成败样本凭空消失
    console.error('[网关] 流量计数写盘失败，已回队重试：', error)
    for (const [offerId, entry] of snapshot) {
      const current = trafficBuffer.get(offerId) || { ok: 0, fail: 0, kinds: {}, quality: { samples: 0, bad: 0 } }
      current.ok += entry.ok
      current.fail += entry.fail
      for (const [kind, count] of Object.entries(entry.kinds || {})) {
        current.kinds[kind] = (current.kinds[kind] || 0) + count
      }
      if (entry.quality) {
        current.quality = current.quality || { samples: 0, bad: 0 }
        current.quality.samples += entry.quality.samples || 0
        current.quality.bad += entry.quality.bad || 0
      }
      trafficBuffer.set(offerId, current)
    }
  }
}

/**
 * 退出前把攒批的决策日志与流量计数落盘（index.js 的 shutdown 调用）。
 * 进程退出不会执行 setTimeout 攒的刷新，不冲掉的话最后 2-5 秒的数据就丢了——
 * 流量计数直接参与可用率评分，丢一批等于让站点的成败样本凭空消失。
 * 幂等：buffer 已空就是 no-op，退出路径里可以放心多次调用。
 */
export async function flushGatewayBuffers() {
  if (trafficTimer) {
    clearTimeout(trafficTimer)
    trafficTimer = null
  }
  try {
    await flushRouting()
    await flushTraffic()
  } catch (error) {
    console.error('[网关] 退出前落盘失败：', error)
  }
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
async function forwardToUpstream({
  candidate,
  body,
  res,
  attemptIndex,
  pool = 'paid',
  clientSignal = null,
  protocol = 'chat',
}) {
  const apiKey = await inv.revealSecret(candidate.credential.id)
  if (!apiKey) return { committed: false, error: 'Key 解密失败' }

  const isResponses = protocol === 'responses'
  const isStream = body.stream === true
  // usage 的「客户端是否要」只对 Chat 有意义：Responses 的 usage 内含在
  // response.completed 事件里，没法单独关掉，也不需要 include 参数
  const clientWantsUsage = Boolean(body.stream_options?.include_usage)
  const upstreamBody = { ...body, model: candidate.offer.upstreamName }
  // 客户端没要求 usage 时也让它返回——网关自己统计用，转发时再把那个 chunk 滤掉
  if (isStream && !isResponses && !clientWantsUsage) {
    upstreamBody.stream_options = { ...(body.stream_options || {}), include_usage: true }
  }

  const controller = new AbortController()
  const startedAt = Date.now()

  // 超时口径是「空闲」而不是「总时长」：长回答连续有字节就不该被杀掉，
  // 只有连续 STREAM_IDLE_MS 没收到任何东西才当上游卡死。
  let timer = null
  let idleTimedOut = false
  const armTimer = (ms) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      idleTimedOut = true
      controller.abort()
    }, ms)
  }
  const touch = () => armTimer(STREAM_IDLE_MS)
  armTimer(STREAM_IDLE_MS)

  // 客户端先走了就别再喂上游：否则对面继续生成，白烧额度还占着连接
  const onClientGone = () => {
    if (!controller.signal.aborted) controller.abort()
  }
  if (clientSignal) {
    if (clientSignal.aborted) onClientGone()
    else clientSignal.addEventListener('abort', onClientGone, { once: true })
  }

  const cleanup = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (clientSignal) clientSignal.removeEventListener('abort', onClientGone)
  }

  let upstreamRes
  try {
    upstreamRes = await fetch(
      `${candidate.provider.baseUrl.replace(/\/+$/, '')}${upstreamPath(protocol)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: isStream ? 'text/event-stream' : 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      },
    )
  } catch (error) {
    cleanup()
    // 空闲超时和客户端断开都是 AbortError，但成因完全不同：前者是站卡死（要记账），
    // 后者不是站的错（上层按 clientSignal 排除）。错误文本必须能区分，否则
    // 路由日志里只剩一句 This operation was aborted，排查时看不出所以然
    if (idleTimedOut) {
      return { committed: false, error: `上游 ${STREAM_IDLE_MS / 1000} 秒无响应（首字超时）` }
    }
    return { committed: false, error: `连接失败：${error.message}` }
  }

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text().catch(() => '')
    cleanup()
    return { committed: false, error: `HTTP ${upstreamRes.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}` }
  }

  const headers = {
    'X-ManageAPI-Provider': encodeURIComponent(candidate.provider.name),
    'X-ManageAPI-Attempts': String(attemptIndex + 1),
    'X-ManageAPI-Quality': candidate.quality === null ? 'unknown' : candidate.quality.toFixed(2),
    // 这次到底是免费池、付费池，还是免费池不够用后回落到的付费池——
    // 回落是显式开关（settings.allowPaidFallback），但客户端仍应能看出来
    'X-ManageAPI-Pool': pool || 'paid',
  }

  if (!isStream) {
    let payload
    try {
      payload = await upstreamRes.json()
    } catch {
      cleanup()
      return { committed: false, error: '上游返回的不是 JSON' }
    }
    cleanup()
    // 协议差异收在 wire.js 里：Responses 的 error / status:"failed" /
    // usage 字段改名都在那边处理，这里只消费归一化结果
    const extracted = extractNonStream(protocol, payload)
    if (extracted.error) return { committed: false, error: extracted.error }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
    res.end(JSON.stringify(payload))
    return {
      committed: true,
      usage: extracted.usage || null,
      ttftMs: null,
      realCheck: extracted.realCheck,
    }
  }

  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let committed = false
  let ttftMs = null
  // 质量信号与 usage 都交给检查器累积：两种协议的增量事件形状差得太远，
  // 在这里分叉写两套变量只会让后面每个字段都要判断一次协议
  const inspector = createStreamInspector(protocol, { clientWantsUsage })

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

  // 提交前攒下的生命周期事件（Responses 的 response.created 等）。
  // 它们在 commit 时按原顺序补发，但在此之前不影响「能否换站」的判断
  const heldChunks = []

  const push = async (chunk) => {
    // 客户端已经断开时 res.write 会静默失败，drain 也不会再来——直接抛，让上层收尾
    if (res.destroyed || res.writableEnded) throw new Error('客户端已断开')
    if (!res.write(chunk)) await once(res, 'drain')
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      touch()
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

        const inspected = inspector.inspect(parsed)

        // 失败要在 commit 之前拦下：Responses 的 response.failed 是 200 流里的
        // 事件，Chat 的错误可能只是一个顶层 error 字段。两种都归到这里，
        // 才能保住「未提交就能静默换站」这个核心能力
        if (!committed && inspected.error) {
          await reader.cancel().catch(() => {})
          cleanup()
          return { committed: false, error: inspected.error }
        }
        if (inspected.drop) continue

        // 生命周期事件（response.created / in_progress）先攒着不发给客户端。
        //
        // 为什么要攒：Responses 的第一个事件永远是纯生命周期事件，没有任何
        // 正文。如果见到它就 commit，而真正的失败（response.failed）恰恰是
        // 第二个事件，那错误就会变成「已提交的流」直接透传——换站能力静默失效。
        // 攒起来既不丢事件（commit 时按原顺序补发），又拖到「真有内容」才关窗。
        if (!committed && inspected.hold) {
          heldChunks.push(raw)
          continue
        }

        commit()
        if (heldChunks.length > 0) {
          const held = heldChunks.join('')
          heldChunks.length = 0
          await push(held)
        }
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
      if (heldChunks.length > 0) {
        const held = heldChunks.join('')
        heldChunks.length = 0
        await push(held)
      }
      await push(buffer)
    }

    if (!committed) {
      cleanup()
      return { committed: false, error: '上游没有返回任何内容' }
    }

    res.end()
  } catch (error) {
    await reader.cancel().catch(() => {})
    cleanup()
    const reason = idleTimedOut ? `上游流中断（${STREAM_IDLE_MS / 1000} 秒无数据）` : error.message
    if (!committed) return { committed: false, error: `流中断：${reason}` }
    if (!res.writableEnded) res.end()
    return { committed: true, usage: inspector.state.usage, ttftMs, streamError: reason }
  }

  cleanup()
  const { usage, contentChars, hasToolCalls, finishReason } = inspector.state
  return {
    committed: true,
    usage,
    ttftMs,
    realCheck: { contentChars, hasToolCalls, finishReason, promptTokens: usage?.prompt_tokens ?? null },
  }
}

async function handleChatCompletions(req, res, db, keyRecord, isFreeEntry = false, protocol = 'chat') {
  const body = await readBody(req, { maxBytes: MAX_GATEWAY_BODY })
  // 客户端关闭连接时立刻取消上游请求：否则上游会继续生成，白烧额度还占着连接。
  // res 随请求销毁，监听器跟着回收，不需要手动摘。
  const clientAbort = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) clientAbort.abort()
  })
  const rawModel = body?.model
  if (!rawModel) return openaiError(res, 400, '请求体缺少 model 字段')
  // 两条路都能进免费池：入口路径（/free/v1）或模型名带 free/ 前缀。
  // 前缀必须在这里判——body 是在这个函数里才读出来的，调用方看不到 model。
  const parsed = resolvePool({ pathname: '', model: rawModel })
  const model = parsed.model
  const isFree = isFreeEntry || parsed.isFree

  // 月度 token 上限（可选，Key 上配置）。「本月」按用户本地时区归属——
  // 用 UTC 月的话，东八区月底最后 8 小时的用量会算进下个月的额度
  if (keyRecord?.monthlyTokenLimit) {
    const monthStart = localMonthStart()
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
  // 免费池只在自己的供给里选；付费池永远看不到免费项。
  // 默认两边互不回落（免费用不了就明确报错，别偷偷扣钱），
  // 只有 settings.allowPaidFallback 显式打开时才允许「免费不够用 → 付费顶上」。
  const split = splitOffers(inv.routeableOffers(db), benchmarks)
  const manualOrder = db.manualOrder?.[inv.normalizeModelKey(model)] || null
  const pick = (offers) =>
    selectCandidates({
      offers,
      providers: db.providers,
      credentials: db.credentials,
      scores,
      benchmarks,
      settings: db.settings,
      model,
      order: manualOrder,
    })

  // 免费池先过闸门（额度 / 指纹 / 截断 / 过期），过了才交给路由排序。
  // 闸门是硬排除——免费成本恒为 0，不能靠「便宜但烂」的加权把它排下去。
  const freeRows = isFree
    ? rankFreePool({
        offers: split.free,
        scores,
        benchmarks,
        crossPane: db.settings.freeCrossPane || 'remaining',
      })
    : []
  const gateOf = new Map(freeRows.map((row) => [row.offer.id, row.gate]))

  let pool = isFree ? 'free' : 'paid'
  let candidates = pick(isFree ? freeRows.filter((row) => !row.gate).map((row) => row.offer) : split.paid)

  // 免费池一个都挑不出来时，先弄清是「池里没这个模型」还是「有但全被闸门挡住」；
  // 开了 allowPaidFallback 就在这一步回落到付费池。
  if (isFree && candidates.length === 0) {
    const inPool = pick(split.free) // 不过闸门，只为判断「有没有这个模型」
    if (db.settings.allowPaidFallback) {
      const paid = pick(split.paid)
      if (paid.length > 0) {
        candidates = paid
        pool = 'paid-fallback'
      }
    }
    if (candidates.length === 0) {
      if (inPool.length > 0) {
        const reasons = inPool
          .map((c) => {
            const gate = gateOf.get(c.offer.id)
            return `${c.offer.upstreamName}${gate ? `（${gate.label}）` : ''}`
          })
          .join('、')
        const tail = db.settings.allowPaidFallback ? '；付费池里也没有可用的同款模型' : ''
        return openaiError(
          res,
          402,
          `免费池里的 ${model} 现在都用不了：${reasons}${tail}。可去「免费」页补额度或换模型`,
          'free_pool_exhausted',
        )
      }
      const available = listPublicModels({ offers: split.free, scores }).map((m) => m.id)
      return openaiError(
        res,
        404,
        `免费池里没有 ${model}。免费模型：${available.slice(0, 20).join(', ') || '（无，去「免费」页看看）'}`,
        'model_not_in_free_pool',
      )
    }
  }

  if (candidates.length === 0) {
    const available = listPublicModels({ offers: split.paid, scores }).map((m) => m.id)
    return openaiError(
      res,
      404,
      `没有可用的 ${model}。已同步的模型：${available.slice(0, 20).join(', ') || '（无，先去同步模型列表）'}`,
      'model_not_found',
    )
  }

  // 准入门禁：慢速 / 可疑 / 不稳定 / 没有可信样本一律不登場。
  // 评分过期和未探测的仍然放行（真实调用本身就是证据），只是排在健康供给之后兜底。
  // 这里必须用 admissionOf 而不是 routable：两套口径分别长会直接导致
  // 「决策页说没有可用供给，网关却偷偷拿最差的去试」
  const allCandidates = candidates
  const admitted = candidates.filter((c) => c.admission?.ok)
  if (admitted.length === 0) {
    // 报错文案在 core/router.js：决策页要能显示同一句话，两处各写一遍必然漂移
    const failure = admissionFailure(candidates, {
      model,
      maxTtftMs: Number(db.settings.maxTtftMs) || 0,
    })
    // 免费池沿用 402：对客户端来说「这个池子空了」和网关权限问题不是一回事
    if (isFree) {
      return openaiError(res, 402, `免费池里的 ${model} 现在都不能用：${failure.detail}`, 'free_pool_exhausted')
    }
    return openaiError(res, failure.status, failure.message, failure.type)
  }
  candidates = admitted

  const started = Date.now()
  const failures = []
  // 请求规模估算（只用于「计费是否明显虚报」的量级判断，不追求精确）
  const requestTokens = estimateRequestTokens(body)

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    // 客户端已断开就别再换站：后面的候选会立刻因 aborted 失败，
    // 把「根本没发出去的请求」记成它们的失败，污染可用率评分
    if (clientAbort.signal.aborted) return
    const attemptStarted = Date.now()
    try {
      const result = await forwardToUpstream({
        candidate,
        body,
        res,
        attemptIndex: index,
        pool,
        clientSignal: clientAbort.signal,
        protocol,
      })
      if (result.committed) {
        const latencyMs = Date.now() - started
        queueRouting({
          model,
          pool,
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
          candidates: explain(allCandidates),
          failures,
        })
        await recordUsage({
          keyId: keyRecord?.id ?? '-',
          providerId: candidate.offer.providerId,
          model: candidate.offer.modelKey || candidate.offer.upstreamName,
          inputTokens: result.usage?.prompt_tokens,
          outputTokens: result.usage?.completion_tokens,
          cachedTokens: result.usage?.prompt_tokens_details?.cached_tokens,
          // 缓存写入是独立计费项（站点按 cache_creation 收，通常是输入价的 1.25 倍）。
          // 上游字段名各家不一，Anthropic 系在 cache_creation_input_tokens，
          // OpenAI 兼容层常放在 prompt_tokens_details.cache_creation_tokens
          cacheCreationTokens:
            result.usage?.cache_creation_input_tokens ??
            result.usage?.prompt_tokens_details?.cache_creation_tokens ??
            0,
          latencyMs,
          ttftMs: result.ttftMs,
          ok: !result.streamError,
        })
        bufferTraffic(
          candidate.offer.id,
          !result.streamError,
          result.streamError,
          // 只有成功响应才谈得上「空回答/计费虚报」；断流已经算失败了
          result.streamError || !result.realCheck
            ? null
            : checkRealResponse({ ...result.realCheck, requestTokens }),
        )
        // 计费核对样本：本地估算的请求 token vs 上游上报的 prompt_tokens。
        // 这是唯一不依赖站点自报数字的独立证据，虚报时两者会明显背离。
        // 只抽样记录（每 N 次一条），避免把 usage 文件撑大
        if (!result.streamError && result.usage?.prompt_tokens) {
          await inv
            .recordBillingSample(candidate.offer.id, {
              providerId: candidate.offer.providerId,
              modelKey: candidate.offer.modelKey || null,
              localTokens: requestTokens,
              reportedPrompt: Number(result.usage.prompt_tokens) || null,
              reportedCached: Number(result.usage?.prompt_tokens_details?.cached_tokens) || 0,
            })
            .catch(() => {})
        }
        // 免费池的额度必须跟着真实调用扣：以前只有手动填的接口能改 freeQuota，
        // 于是「额度用尽」永远判不出来，网关会一直往一个已经空了的池子里发请求。
        if (pool === 'free') {
          const tokens =
            (Number(result.usage?.prompt_tokens) || 0) + (Number(result.usage?.completion_tokens) || 0)
          await inv.consumeFreeQuota(candidate.offer.id, { tokens, requests: 1 }).catch(() => {})
        }
        return
      }
      // 客户端断开导致的失败不是站的错，不进失败名单、不计流量
      if (clientAbort.signal.aborted) return
      failures.push({
        providerName: candidate.provider.name,
        offerId: candidate.offer.id,
        error: result.error,
        ms: Date.now() - attemptStarted,
      })
      bufferTraffic(candidate.offer.id, false, result.error)
    } catch (error) {
      if (clientAbort.signal.aborted) return
      failures.push({
        providerName: candidate.provider.name,
        offerId: candidate.offer.id,
        error: error.message || String(error),
        ms: Date.now() - attemptStarted,
      })
      bufferTraffic(candidate.offer.id, false, error.message || String(error))
    }
  }

  queueRouting({
    model,
    pool,
    keyId: keyRecord?.id ?? null,
    keyName: keyRecord?.name ?? null,
    chosenOfferId: null,
    attempts: candidates.length,
    outcome: 'failed',
    latencyMs: Date.now() - started,
    candidates: explain(allCandidates),
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
  let pathname = url.pathname.replace(/\/+$/, '') || '/'
  // /free/v1/... 是免费池专用入口：整条路径剥掉 /free，剩下的按普通网关处理
  const isFreeEntry = pathname === FREE_BASE_PATH || pathname.startsWith(`${FREE_BASE_PATH}/`)
  if (isFreeEntry) pathname = pathname.slice(FREE_BASE_PATH.length) || '/'

  // 网关热路径用带缓存的读：db.json 已到 1MB，每请求解析一遍要 15ms 左右。
  // 注意：这里返回的对象是共享的，下游只读不改（写操作一律走 mutate）。
  const db = await store.readDbCached()

  const auth = authorizeGateway(req, db)
  if (!auth.ok) return openaiError(res, auth.status, auth.message, 'authentication_error')

  if (pathname === '/v1/models') {
    const scores = scoresFor(db)
    const benchmarks = await bench.readBenchmarks()
    const split = splitOffers(inv.routeableOffers(db), benchmarks)
    const shape = (m, ownedBy, prefix = '') => ({
      id: `${prefix}${m.id}`,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: ownedBy,
      providers: m.providers,
      healthy: m.healthy,
    })

    if (isFreeEntry) {
      const models = listPublicModels({ offers: split.free, scores })
      return json(res, 200, {
        object: 'list',
        data: models.map((m) => shape(m, 'manage-api-free')),
      })
    }

    // 付费入口：付费模型 + 带 free/ 前缀的免费模型。
    // 带前缀是有意的——用户在下拉里能看见、能选，且一眼知道走的是免费池。
    const paidModels = listPublicModels({ offers: split.paid, scores })
    const freeModels = listPublicModels({ offers: split.free, scores })
    return json(res, 200, {
      object: 'list',
      data: [
        ...paidModels.map((m) => shape(m, 'manage-api')),
        ...freeModels.map((m) => shape(m, 'manage-api-free', FREE_PREFIX)),
      ],
    })
  }

  // 两种协议的路径都在这里落地。协议只影响「往上游打哪个路径」和
  // 「怎么解析回来的东西」，路由、评分、计费、免费池这一整套完全不看协议
  const protocol = protocolForPath(pathname)
  if (protocol) {
    return handleChatCompletions(req, res, db, auth.keyRecord, isFreeEntry, protocol)
  }

  return openaiError(
    res,
    404,
    `暂不支持 ${pathname}，目前只代理 /v1/chat/completions、/v1/responses 与 /v1/models`,
  )
}

// ------------------------------------------------------------------ 静态

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = resolve(WEB_DIR, rel)
  // 必须比到「目录 + 分隔符」：startsWith(WEB_DIR) 会把 web-evil/ 这种兄弟目录也放过去
  if (target !== WEB_DIR && !target.startsWith(WEB_DIR + sep)) {
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

/**
 * 只接受本机回环 Host。
 *
 * 为什么必须查：攻击者可以让自己的域名解析到 127.0.0.1（DNS rebinding），浏览器
 * 就会把发往 evil.com 的请求原样打到本地端口上，服务端看到的是一个完全合法的请求。
 * 校验 Host 是唯一能区分「浏览器在跟本机说话」和「浏览器以为在跟 evil.com 说话」的信号。
 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function hostIsLocal(req) {
  const raw = String(req.headers.host || '').trim().toLowerCase()
  if (!raw) return true // HTTP/1.0 无 Host 的本地调试请求，放行
  const name = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0]
  return LOCAL_HOSTS.has(name)
}

export function createAppServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const pathname = url.pathname

    if (!hostIsLocal(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Forbidden: 只接受 127.0.0.1 / localhost 访问')
      return
    }

    if (
      pathname === '/v1' ||
      pathname.startsWith('/v1/') ||
      pathname === FREE_BASE_PATH ||
      pathname.startsWith(`${FREE_BASE_PATH}/`)
    ) {
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

    // method 必须在 try 外声明：catch 里要用它记日志，写在 try 里会变成 ReferenceError
    const method = req.method === 'HEAD' ? 'GET' : req.method
    try {
      // 变更类请求必须带 JSON 头。表单/纯文本的跨站请求发不出这个头（要预检），
      // 顺带挡掉「任意网页往本地端口 POST 一坨 JSON」的 CSRF 路径。
      if (method !== 'GET' && method !== 'DELETE') {
        const type = String(req.headers['content-type'] || '').toLowerCase()
        if (!type.startsWith('application/json')) {
          throw new HttpError(415, '请求体必须是 application/json')
        }
      }
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
      // HttpError 是业务校验失败；带 errno 的是磁盘/文件系统层的故障，得报 500，
      // 否则「db.json 写不进去」会被当成「你参数填错了」。
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof store.StorageError || IO_ERROR_CODES.has(error?.code)
            ? 500
            : 400
      if (status >= 500) console.error(`[api] ${method} ${pathname} 失败：`, error)
      if (!res.writableEnded) {
        json(res, status, { error: error.message || String(error), ...(error?.extra || {}) })
      }
    }
  })
}
