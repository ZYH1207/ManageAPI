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
  usageNumbers,
  isTerminalChunk,
  rewriteAppendedChunk,
} from '../core/wire.js'
import { detailRows, detailRow, sumBuckets, facetOptions } from '../core/usage-detail.js'
import {
  selectCandidates,
  listPublicModels,
  explain,
  admissionFailure,
  admissionOf,
  admissionTags,
  isTooSlow,
  candidateChain,
  applyPinnedChoice,
} from '../core/router.js'
import { snapTtftMs, ttftTierTable, describeTtftLimit } from '../core/latency.js'
import { pauseStatus, normalizeWindows, isTime, MAX_WINDOWS } from '../core/schedule.js'
import {
  DECISION_MODES,
  decisionModeTable,
  describeDecisionMode,
  normalizeDecisionMode,
} from '../core/decision-mode.js'
import {
  pickAutoRoute,
  normalizeAutoRoute,
  applyAutoRoutePick,
  defaultAutoRoute,
} from '../core/auto-route.js'
import {
  ensureFailoverToken,
  activeReports,
  addFaultReport,
  expireFaultReports,
  clearFaultReports,
  faultMatcher,
  normalizeFailover,
  FAULT_HOLD_MS,
} from '../core/failover.js'
import { splitOffers, isFreeOffer, resolvePool, FREE_PREFIX, FREE_BASE_PATH } from '../core/free.js'
import { rankFreePool } from '../core/rank-free.js'
import * as platforms from '../core/platforms/index.js'
import { recordUsage, usageSummary, tokensUsedByKey, resetUsage, readUsage, localMonthStart } from '../core/usage.js'
import {
  appendDetail,
  readDetail,
  listDetailDays,
  DETAIL_RETENTION_DAYS,
} from '../core/usage-ledger.js'
import { buildMonitorView, markAlertsRead, markAnnouncementsRead, applySnapshot } from '../core/monitor.js'
import { readProbeSpend, clearProbeSpend, buildProbeSpendView } from '../core/probe-spend.js'
import { collectProviderSnapshots } from './monitor-runner.js'
import { runProbes } from './probe-runner.js'
import { probeProtocols } from '../core/protocol-probe.js'
import {
  saveProtocolRecord,
  removeProtocolRecord,
  clearProtocolRecords,
  pruneProtocolRecords,
  buildProtocolRecord,
} from '../core/protocol-records.js'
import { REFERENCE_AS_OF, listReference } from '../core/model-prices.js'
import { listPresetSites, listPresetPlatforms } from '../core/catalog.js'
import {
  normalizeEmptyGuard,
  judgeEmptyTurn,
  buildEmptyEvent,
  estimateRetryCost,
  planEmptyRetry,
  ensureEmptyEvents,
  recordEmptyEvent,
  clearEmptyEvents,
  summarizeEmptyEvents,
  ensureDetours,
  activeDetours,
  recordDetour,
  resolveDetour,
  recentEmptyHits,
  pickClosestCandidate,
  DETOUR_RECHECK_MS,
  STALE_HITS,
  RETRY_TIERS,
} from '../core/empty-guard.js'
import { repairToolCalls, buildRepairChunks } from '../core/tool-repair.js'
import {
  buildFaultSignal,
  judgeEmptyFault,
  publishFault,
  faultSubscriberCount,
  activeFaultSignals,
  combineWithDetours,
  summarizeFaultSignals,
  applyFaultToFailover,
  FAULT_WINDOW_MS,
} from '../core/fault-signal.js'
import * as diag from '../core/diagnosis.js'
import { runCheckup } from './checkup-runner.js'
import {
  assessRequestImpact,
  shouldEscalate,
  faultKindOf,
  holdMinutesFor,
  IMPACT,
} from '../core/fault-triage.js'
import * as faultReporter from '../core/fault-reporter.js'

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
  // 由当前决策侧重（性价比 / 价格 / 首字速度）决定先后。
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

  // 「站点卡上点开分组看模型」用的台账：providerId → 分组名 → 模型清单。
  //
  // 为什么只认本地台账：站点接口给的是「分组名录」+「平台级模型表」，两者是并列的，
  // 谁属于哪个分组接口没说过——交叉相乘会编出不存在的组合。真正把模型绑到分组上的，
  // 是「这个分组下的 Key 同步回来了哪些模型」，也就只有 db.offers 知道。
  //
  // 口径：**全量**（被忽略的也列，打标记）+ 去掉已下线。这里回答的是「站点上这个
  // 分组里有什么」，不是「哪些会参与比价」；按 routeableOffers 过滤的话，忽略过模型的
  // 用户看到的分组会几乎全空（本地真实数据里 208 条供给被忽略了 203 条）。
  //
  // 同一趟循环里再按 credentialId 存一份：密钥面板上 Key 那行的「总 / 忽略 / 可用」
  // 要的是「这把 Key 同步回来哪些模型」，口径必须和分组清单一致——所以不另写一遍
  // 价格换算和忽略判定，直接共用同一个 entry。
  const modelsByGroup = {}
  const modelsByCredential = {}
  {
    const ignored = inv.ignoredModelSet(db)
    // ignoredModelSet 是按**身份键**建的集合，比对也必须用身份键。
    // 拿存储键去 has() 永远查不到，表现为「忽略了但台账里不标已忽略」且不报错
    const aliases = db.settings?.modelAliases || {}
    for (const offer of db.offers) {
      if (offer.delistedAt) continue
      const name = String(offer.upstreamName || offer.modelKey || '').trim()
      if (!name) continue
      const key = inv.modelIdentityKey(offer.modelKey || offer.upstreamName || '', aliases)
      // 价格走 offerCost：和比价/花费同一份换算（倍率模式的实际价、按次分支）
      const cost = pricing.offerCost(offer, db.settings, benchmarks)
      const entry = {
        name,
        ratio: offer.ratio === null || offer.ratio === undefined ? null : Number(offer.ratio),
        free: isFreeOffer(offer, benchmarks),
        ignored: Boolean(key) && ignored.has(key),
        perCall: Boolean(cost.perCall),
        inCny: cost.inCnyPerMtok,
        outCny: cost.outCnyPerMtok,
        callCny: cost.callPriceCny ?? null,
      }
      const groupKey = offer.group || ''
      const site = (modelsByGroup[offer.providerId] ||= {})
      ;(site[groupKey] ||= []).push(entry)
      if (offer.credentialId) (modelsByCredential[offer.credentialId] ||= []).push(entry)
    }
    for (const site of Object.values(modelsByGroup)) {
      for (const list of Object.values(site)) list.sort((a, b) => a.name.localeCompare(b.name))
    }
    for (const list of Object.values(modelsByCredential)) list.sort((a, b) => a.name.localeCompare(b.name))
  }

  const { ranked, unpriced } = pricing.rankByModel(paidOffers, db.settings, benchmarks, isTrusted)
  const summary = pricing.summarize(paidOffers, db.settings, benchmarks, isTrusted)

  // 用量按模型身份键汇总：同一个模型两种写法不该在用量页拆成两行
  const usage = await usageSummary({
    days: 30,
    resolveModel: (name) => inv.modelIdentityKey(name, db.settings?.modelAliases || {}),
  })
  // 关注度：有真实用量 > 调过手动顺序 > 探过。结论句默认推你真正在用的模型。
  // 三个来源的名字形状不一（用量是写入时的 modelKey、探针是 modelKey、手动排序是用户输入），
  // 统一过一道身份键，否则「你在用的模型」永远匹配不上比价分组键，结论句就只会推价差最大的
  const aliases = db.settings?.modelAliases || {}
  const toIdentity = (name) => inv.modelIdentityKey(name, aliases) || ''
  const focusOrder = [
    ...new Set([
      ...Object.entries(usage.byModel || {})
        .sort((a, b) => (b[1].requests || 0) - (a[1].requests || 0))
        .map(([key]) => toIdentity(key)),
      ...Object.keys(db.manualOrder || {}).map(toIdentity),
      ...db.probes.map((p) => toIdentity(p.modelKey)).filter(Boolean),
    ].filter(Boolean)),
  ]

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
    // 比价页的状态标签和决策页同一份判定（core/router.js#admissionTags）：
    // 慢速、可疑、不稳定可以同时成立，前端只管照着画，不在浏览器里再判一遍。
    // 慢速口径同样只留 isTooSlow 一份（评分过期不算慢）
    const tooSlow = isTooSlow(score, maxTtftMs)
    // 准入判定和 selectCandidates 里那份用同一个形状：samples 是探针 + 真实流量，
    // allowUntrusted 让「放行可疑供给」在比价页也生效，否则两个页面结论会打架
    const gateRow = {
      ...score,
      tooSlow,
      allowUntrusted,
      samples: (score.samples || 0) + (score.trafficSamples || 0),
    }
    scores[offerId] = {
      ...score,
      // routable 表示「会不会参与路由」，受开关影响
      routable: isTrusted(offerId),
      // probeTrusted 是探针的原始判定，只用于界面打「可疑」标记，不受开关影响
      probeTrusted: probeTrusted(offerId),
      tooSlow,
      // samples 仍是探针样本数（探针页按「探针 + 真实流量」分开显示），
      // 只有标签和准入用合并后的证据量
      tags: admissionTags(gateRow),
      // 比价页「只显示允许放行」按它过滤：门禁结论只有 admissionOf 一份，
      // 前端不拿标签自己再拼一遍「什么算不合格」
      admission: admissionOf(gateRow),
    }
  }

  // 把缓存命中率与延迟挂到比价行上，供前端展示；
  // official 是官方有效成本（基准价表 + offerCost 同一算法），供比价组头做参照
  const rankedWithCache = ranked.map((group) => ({
    ...group,
    official: pricing.officialCost(benchmarks[group.modelKey], db.settings),
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

  // 决策预览：每个模型当前的候选排序，供「智能决策」页展示。
  // 比价分组的键现在可能是多个站点写法的合并体（claude-opus-4-5 + claude-opus-4.5），
  // 不能直接拿分组键当「请求模型名」丢给 selectCandidates——它按名字匹配供给，
  // 那样两个写法都匹配不上。用组内任一成员的 upstreamName 当入口即可（selectCandidates
  // 内部再按身份键展开成整组）。
  // 外部监控上报的真实故障（故障转移）：降级不拉黑，准入、排序、快照共用一个判定
  const isFaulted = faultMatcher(db.failover)
  const decisions = rankedWithCache.map((group) => {
    const model = group.rows[0]?.upstreamName || group.modelKey
    const order = db.manualOrder?.[model] || db.manualOrder?.[group.modelKey] || null
    const candidates = selectCandidates({
      offers: paidOffers,
      providers: db.providers,
      credentials: db.credentials,
      scores: scoreMap,
      benchmarks,
      settings: db.settings,
      model,
      order,
      isFaulted,
    })
    const rankedCandidates = explain(candidates)
    // 勾选 > 排序：决策页点选的那条就是「当前选」，与顺序无关（顺序不动）。
    // 勾选的不在候选里（被暂停/删了）才回落到「第一条能登场的」。
    // 勾选的牌哪怕准入没放行也算数——人的明确指定，探针准入管不住人手点的；
    // 网关侧同口径（见下方 handleChatCompletions 里的 applyPinnedChoice），
    // 真发失败了照样沿候选链故障转移。
    const pinnedOfferId = db.pinnedOffer?.[model] || db.pinnedOffer?.[group.modelKey] || null
    const winner =
      (pinnedOfferId && rankedCandidates.find((c) => c.offerId === pinnedOfferId)) ||
      rankedCandidates.find((c) => c.admission?.ok && !c.faulted) ||
      null
    return {
      modelKey: group.modelKey,
      display: group.display || group.modelKey,
      variants: group.variants || [],
      candidates: rankedCandidates,
      pinnedOfferId,
      chosenOfferId: winner?.offerId ?? null,
      chosenProviderId: winner?.providerId ?? null,
      chosenProviderName: winner?.providerName ?? null,
      // 同一站可能有多个分组供这个模型，只报站名分不清走的是哪条线
      chosenGroup: winner?.group || '',
      manual: Boolean((order && order.length) || pinnedOfferId),
    }
  })

  // 看板顶部结论：直接吃 decisions（和决策页「当前选」、网关派活同一份），
  // 档位 / 关注模型都在这里定，不在 pricing 里再从 ranked 挑一遍
  const topLine = pricing.decisionHeadline({
    decisions,
    settings: db.settings,
    focusModels: focusOrder,
  })
  // 结论句里那个可点的模型名：本机未被忽略、并且填了价格的模型（就是 decisions 这批）。
  // 没有可用供给的也列出来但标灰——比默默消失强，至少看得出「这个模型现在没人接单」
  const headlineModels = decisions.map((decision) => ({
    modelKey: decision.modelKey,
    display: decision.display || decision.modelKey,
    available: decision.candidates.filter((c) => c.admission?.ok).length,
    total: decision.candidates.length,
  }))

  // 合并视图算一次，给 modelMerge / modelDisplay 共用（几百条供给 × 全表遍历，别重复算）
  const mergeView = inv.modelMergeView(db, Object.keys(benchmarks))

  const result = {
    settings: db.settings,
    // 「定时关闭检测」当前状态：暂停中 / 几点恢复 / 下次几点开始。
    // 由服务端算（core/schedule.js 是唯一实现），前端只负责显示，避免两边各写一套跨夜判断
    probePause: pauseStatus(db.settings.probePauseWindows),
    // 首字门槛的 20 档 + 速度等级：前端直接照着渲染，不在浏览器里另算一份
    ttftTiers: ttftTierTable(),
    ttftLimitText: describeTtftLimit(db.settings.maxTtftMs),
    // 决策侧重：四档的标签 / 说明由服务端下发，前端只负责画和发 PATCH
    decisionMode: normalizeDecisionMode(db.settings.decisionMode),
    decisionModes: decisionModeTable(),
    decisionModeText: describeDecisionMode(db.settings.decisionMode),
    // 自动路由（一键接管）：决策页的开关与「正在使用」照这份显示。
    // modelKey 之后的找补（哪个站、哪个分组、供给还活着吗）前端从
    // decisions 里按 modelKey 自己查，服务端不重复算一遍
    autoRoute: normalizeAutoRoute(db.settings.autoRoute),
    // 故障转移：上报令牌（给外部监控系统的接入配置）+ 活跃上报清单。
    // 读状态时顺手把到期记录标记成 expired（幂等，纯内存判断 + 有变化才写）
    failover: (() => {
      expireFaultReports(db.failover)
      return {
        token: db.settings.failoverToken,
        holdMs: FAULT_HOLD_MS,
        active: activeReports(db.failover),
        reports: (db.failover?.reports || []).slice(-20).reverse(),
      }
    })(),
    // 看板结论句的档位：与 decisionMode 分开存，概览页自己那条三档条改的就是它
    headlineMode: normalizeDecisionMode(db.settings.headlineMode),
    headlineModeText: describeDecisionMode(db.settings.headlineMode),
    // 看板第二句（全场冠军行）的档位：与 headlineMode 分开存
    championMode: normalizeDecisionMode(db.settings.championMode),
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
    // 分组 → 模型清单（见上面 modelsByGroup 的注释；与 offers 的区别是含被忽略的供给）
    modelsByGroup,
    // Key → 模型清单：密钥面板那行「总 / 忽略 / 可用」点开的弹窗用它。
    // 和 modelsByGroup 同一份 entry、同一个口径，只是换了索引键。
    modelsByCredential,
    // 模型合并的当前结果与「疑似未合并」建议（纯函数，前端只负责展示）
    modelMerge: mergeView,
    /**
     * 名字 → 身份键，以及 身份键 → 展示名。
     *
     * 前端各处（用量、基准价、忽略模型）本来各有一份「模型名」，合并之后
     * 必须能落到同一个键上才不会又拆成两行。前端没有归一的实现（也不该有第二份），
     * 所以由后端把这张索引算出：前端只查表，口径永远只有一份。
     */
    modelIdentity: (() => {
      const map = {}
      const aliasTable = db.settings?.modelAliases || {}
      const add = (name) => {
        const raw = String(name || '').trim()
        if (!raw) return
        const id = inv.modelIdentityKey(raw, aliasTable)
        if (!id) return
        map[raw.toLowerCase()] = id
        // 归一后的键自己去查一次：前端拿到的可能是身份键本身
        if (!map[id]) map[id] = id
      }
      for (const offer of db.offers) add(offer.modelKey || offer.upstreamName)
      for (const key of Object.keys(benchmarks)) add(key)
      for (const name of db.settings?.ignoredModels || []) add(name)
      for (const name of Object.keys(aliasTable)) add(name)
      return map
    })(),
    /** 身份键 → 给人看的名字（合并组用组内公认写法，单条就是它自己） */
    modelDisplay: (() => {
      const map = {}
      for (const group of mergeView.groups) map[group.id] = group.display || group.id
      return map
    })(),
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
    // 全场冠军：全部模型各自「能登场」的牌合在一起按 championMode 比出的第一名
    champion: pricing.decisionChampion({ decisions, settings: db.settings }),
    // 结论句里可点的模型下拉：本机未忽略且填了价格的模型，带可用供给数
    headlineModels,
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
  await store.mutate(async (db) => {
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
    // 定时关闭检测：整表替换，校验收口在 core/schedule.js。
    // 起止相同直接拒：既不是「不暂停」也不是「全天」，写进库里只会让调度器行为变得靠猜
    if (ctx.body.probePauseWindows !== undefined) {
      const list = ctx.body.probePauseWindows
      if (!Array.isArray(list)) throw new HttpError(400, '暂停时段必须是数组')
      if (list.length > MAX_WINDOWS) throw new HttpError(400, `暂停时段最多 ${MAX_WINDOWS} 段`)
      const windows = []
      for (const item of list) {
        const start = String(item?.start ?? '').trim()
        const end = String(item?.end ?? '').trim()
        if (!isTime(start) || !isTime(end)) {
          throw new HttpError(400, `时段 ${start || '（空）'}~${end || '（空）'} 格式不对，应为 HH:MM`)
        }
        if (start === end) throw new HttpError(400, `时段 ${start}~${end} 起止时间相同，没意义`)
        windows.push({ id: String(item?.id || `${start}-${end}`), start, end })
      }
      // 归一化会顺手去掉重复段（同一段时间存两遍没有意义，只会让「有几段」数不清）
      db.settings.probePauseWindows = normalizeWindows(windows)
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
    // 两个档位，同一个校验口径：decisionMode 管路由派活，headlineMode 管看板那句话。
    // 非法值直接 400，不静默回落：一个拼错的档位名若被当成「性价比」，用户会以为
    // 自己在按速度排、实际却在按价格排——静默错配置比报错危险得多。
    for (const key of ['decisionMode', 'headlineMode', 'championMode']) {
      if (ctx.body[key] === undefined) continue
      const v = String(ctx.body[key])
      if (!DECISION_MODES.some((mode) => mode.key === v)) {
        const label =
          key === 'decisionMode' ? '决策侧重' : key === 'headlineMode' ? '看板结论句档位' : '全场冠军档位'
        throw new HttpError(400, `${label}只能是 ${DECISION_MODES.map((mode) => mode.key).join(' / ')}`)
      }
      db.settings[key] = v
      // 自动路由接管中用户切了决策档位：这是显式的意图变更，立刻按新档位
      // 强制重选一次（不受 15% 迟滞约束），否则开关还开着、「正在使用」
      // 却还是旧档位的最优——口径漂了，接管就名存实亡
      if (key === 'decisionMode' && normalizeAutoRoute(db.settings.autoRoute).enabled) {
        const pick = pickAutoRoute(db, { scores: scoresFor(db), benchmarks: await bench.readBenchmarks(), force: true })
        if (pick) applyAutoRoutePick(db.settings, pick)
      }
    }
    // 自动路由开关：开启时立刻全场挑选一次并落盘，决策页不用等第一个
    // 请求才有「正在使用」可显示；关闭时清掉挑选记录——模型名只是接管
    // 期间的临时状态，关了还留着会让人误以为它仍在生效
    if (ctx.body.autoRouteEnabled !== undefined) {
      db.settings.autoRoute = normalizeAutoRoute(db.settings.autoRoute)
      db.settings.autoRoute.enabled = Boolean(ctx.body.autoRouteEnabled)
      if (db.settings.autoRoute.enabled) {
        const pick = pickAutoRoute(db, { scores: scoresFor(db), benchmarks: await bench.readBenchmarks(), force: true })
        if (pick) applyAutoRoutePick(db.settings, pick)
      } else {
        db.settings.autoRoute = { ...defaultAutoRoute(), enabled: false }
      }
    }
    if (ctx.body.focusModel !== undefined) {
      // 看板结论句里选中的模型：空 / null = 交回自动（按用量 > 手动排序 > 探过 挑）
      if (ctx.body.focusModel === null || ctx.body.focusModel === '') {
        db.settings.focusModel = null
      } else {
        const v = String(ctx.body.focusModel).trim()
        if (!v) throw new HttpError(400, '关注模型不能是空字符串')
        // 归一化后再落库：free/glm-5.3 与 glm-5.3 是同一个模型，
        // 两处各存一份迟早对不上（决策页、看板、路由都要按同一把 key 找）
        db.settings.focusModel = inv.normalizeModelKey(v)
      }
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
      if (v !== 'CNY' && v !== 'USD' && v !== 'RUSD') throw new HttpError(400, '显示币种只能是 CNY / USD / RUSD')
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
      // 存**身份键**：同一个模型的不同写法是同一个模型，忽略一次所有写法都不再参与。
      // 以前存存储键（normalizeModelKey），忽略 deepseek-v4.1-flash 时
      // deepseek-4.1-flash 那条还会照常出现在比价里
      const aliases = db.settings?.modelAliases || {}
      const list = ctx.body.ignoredModels
        .map((name) => (typeof name === 'string' ? inv.modelIdentityKey(name, aliases) : ''))
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
  // 带令牌识别：部分站的系别特征接口要求登录（匿名 401/403），
  // 优先 adminToken，其次第一把可用的 API Key
  const adminToken = await inv.revealAdminToken(provider.id)
  const apiKeys = (
    await Promise.all(
      db.credentials
        .filter((c) => c.providerId === provider.id)
        .map((c) => inv.revealSecret(c.id)),
    )
  ).filter(Boolean)
  const auth = adminToken || apiKeys[0] || ''
  const detected = await providers.detectProviderKind({ baseUrl: provider.baseUrl, adminToken: auth })
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
        ? await inv.markDelisted(provider.id, row.credential.id, row.models, row.credential.group || '')
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
  // 超时跟站点设置走：站点的「可用渠道」是整站规模的响应，实测会拖到 10 秒以上；
  // 用默认超时会把整份分组/倍率读成失败，界面就只剩一句「读不到分组」
  const pricingTimeoutMs = Math.min(Number(db.settings?.probeTimeoutMs) || 15000, 20000)
  if (!fresh && cached && !cached.error && Date.now() - cached.at < PRICING_TTL_MS) {
    pricing = cached.data
  } else {
    try {
      const adminToken = await inv.revealAdminToken(provider.id)
      pricing = await providers.fetchProviderPricing({
        baseUrl: provider.baseUrl,
        adminToken,
        kind: provider.kind,
        timeoutMs: pricingTimeoutMs,
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
            timeoutMs: pricingTimeoutMs,
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

  // 每个分组的模型名单（弹出框只显示数量，名单放 tooltip）。渠道与广场两条路的
  // byGroup 都有这个映射了，所以这里一律按分组数，不再退回全站数
  const modelNamesIn = new Map()
  for (const model of pricing.byGroup || []) {
    if (!model.group) continue
    const key = inv.normalizeGroup(model.group)
    if (!modelNamesIn.has(key)) modelNamesIn.set(key, [])
    const list = modelNamesIn.get(key)
    if (!list.includes(model.name)) list.push(model.name)
  }

  const groups = pricing.groups
    .map((g) => ({
      name: inv.normalizeGroup(g.name),
      rate: g.rate,
      modelCount: coveredIn(g.name),
      isCurrent: inv.normalizeGroup(g.name) === inv.normalizeGroup(current),
      // 这个分组里有哪些模型：没读到分组级数据时为空数组（前端就不显示 tooltip）
      models: modelNamesIn.get(inv.normalizeGroup(g.name)) || [],
    }))
    // 能覆盖模型的排前面，其次是倍率低的
    .sort((a, b) => {
      if (b.modelCount !== a.modelCount) return b.modelCount - a.modelCount
      return (a.rate ?? 99) - (b.rate ?? 99)
    })

  const unmatched = offers.filter((offer) => !match(offer, current)).map((o) => o.upstreamName)

  // 存着的分组名在站点分组表里还能不能找到。站方改过分组名（「[GM1]国模分组
  // （DS\qwen3.8\Glm5.3\K3）010」→「[GM1]Deepseek-v4.1(1017)/Minimax-m3.1」）之后
  // 就对不上了：倍率查不到、价格落不下去，而界面看上去一切正常。必须明确告知
  const currentKnown = !current || groups.some((g) => g.isCurrent)

  return {
    providerId: ctx.params[0],
    credentialId: active?.id || null,
    credentialLabel: active?.label || null,
    keyCount: credentials.length,
    current,
    currentKnown,
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
  // 重新拉一次模型把行建出来——和「识别分组」共用同一份实现（inv.importCredentialModels）。
  const timeoutMs = Math.min(Number(db.settings?.probeTimeoutMs) || 15000, 20000)
  const imported = await inv.importCredentialModels(provider, target, group, { timeoutMs })
  const resynced = imported.imported
  const resyncError = imported.error

  // 分组名两侧可能有空白差异（实测 Key 存的「国模-0045 p哥」与站点公布的
  // 「国模-0045 p哥 」差一个尾随空格），归一化后再匹配，否则倍率解析成 null，
  // 落价会退回「原价手填」，价格直接放大约 10 倍
  const normGroup = (value) => inv.normalizeGroup(value)
  const rateOfGroup = new Map(pricing.groups.map((g) => [normGroup(g.name), g.rate]))
  const rates = pricing.groups.map((g) => g.rate).filter((r) => typeof r === 'number')
  const uniformRate = rates.length > 0 && rates.every((r) => r === rates[0]) ? rates[0] : null
  // 站点分组表里还有没有这个名字。站方改过分组名之后就没有了，而「查不到倍率」
  // 在那种情况下不是「站点没公布倍率」——不能按原价 × 1 落价（会贵一个倍率）
  const rate = group && rateOfGroup.has(normGroup(group)) ? rateOfGroup.get(normGroup(group)) : uniformRate
  // 分组过期 = 分组表里没这个名字，而且令牌列表也没给倍率。两者同时落空才是真的没法算。
  // 反过来，站点没在「可用渠道」里公开某些专属分组（实测 [CC2] 只在令牌列表里有，
  // 倍率 0.55 也是那边给的），那种情况价格能算对，不能当成过期去跳过
  const groupKnown =
    !group || pricing.groups.length === 0 || rate !== null || rateOfGroup.has(normGroup(group))

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
        // 基准价查表带归一：站上叫 claude-opus-4-5、基准价表里叫 claude-opus-4.5
        // 是完全正常的事，按原名查会得出「没基准价 → 落成手填价」的结论，倍率就白丢了
        hasBench: Boolean(bench.benchmarkEntry(benchTable, key)),
        groupKnown,
      })
      if (via === 'ratio') viaRatio += 1
      if (via === 'percall') viaPercall += 1
      if (via === 'manual' && !bench.benchmarkEntry(benchTable, key)) missingBench.push(offer.upstreamName)

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
      // 站点分组表里没有这个分组名（站方多半改过名）：此时倍率对不上、价格不落，
      // 前端要明确提示去「选分组」重新选一次，而不是让用户以为已经生效
      groupUnknown: !groupKnown,
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
  const importTimeoutMs = Math.min(Number(db.settings?.probeTimeoutMs) || 15000, 20000)

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
    // 这把 Key 名下一条供给都没有（新加的 Key、或分组被删后重加）：光把分组名
    // 记下来，界面上它永远是「0 个模型」，用户看到的就是「GM1 里的 Deepseek
    // 读不出来」。这里按它自己的 Key 把模型导进来（与「选分组」同一份实现）。
    const importedModels = await inv.importCredentialModels(provider, credential, group, {
      timeoutMs: importTimeoutMs,
    })
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
      // 本次顺手导入了几个模型（0 = 已有供给行，或拉模型失败）
      imported: importedModels.imported,
      importError: importedModels.error,
      // 站点分组表里没这个名字，而且令牌列表也没给倍率：站方多半改过名，价格不能动
      groupUnknown:
        rate === null && pricing.groups.length > 0 && !rateOfGroup.has(normGroupName(group)),
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
          groupKnown: !row.groupUnknown,
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

/**
 * 余额写回站点。字段口径（余额 / 赠金 / 到期）在 inv.applyBalanceResult，
 * 这里只负责找到站点——手动读余额、采集、重登重试三处都走它，别再各写一遍。
 */
async function persistBalance(providerId, result, at) {
  return store.mutate((db) => {
    const provider = db.providers.find((p) => p.id === providerId)
    return inv.applyBalanceResult(provider, result, at)
  })
}

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
        await persistBalance(provider.id, retried)
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
    // 写回站点 + 手动刷一次余额也进曲线——否则用户点了刷新，图上却没动静。
    // 两件事放同一份 mutate 里，卡片和曲线不会一个新一个旧
    const at = new Date().toISOString()
    await store.mutate((current) => {
      inv.applyBalanceResult(
        current.providers.find((p) => p.id === provider.id),
        result,
        at,
      )
      return applySnapshot(current, { providerId: provider.id, at, balance: result })
    })
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

// 决策页点选：勾哪条供给为「当前使用」（传空 = 取消勾选）；顺序不动
route('POST', /^\/api\/decisions\/([^/]+)\/pick$/, async (ctx) => {
  const modelKey = decodeURIComponent(ctx.params[0])
  await inv.setPinnedOffer(modelKey, ctx.body.offerId ? String(ctx.body.offerId) : '')
  return buildState()
})

// ------------------------------------------------------------- 模型名合并

/**
 * 合并：把一批名字归到同一个身份（之后的比价/决策/网关清单都当作一个模型）。
 * 入参 names 是**用户看到的原始写法**，服务端只归一存储键，不改 offer。
 */
route('POST', /^\/api\/models\/merge$/, async (ctx) => {
  const names = Array.isArray(ctx.body.names) ? ctx.body.names : []
  if (names.length === 0) throw new HttpError(400, '至少要选两个名字才谈得上合并')
  const target = String(ctx.body.target || '').trim()
  if (!target) throw new HttpError(400, '缺少合并目标（合并后按哪个名字显示）')
  await inv.mergeModelNames(names, target)
  return buildState()
})

/** 拆开：让这条名字自成一档，不再参与规则归一（比如 -highspeed 确实更贵） */
route('POST', /^\/api\/models\/split$/, async (ctx) => {
  const name = String(ctx.body.name || '').trim()
  if (!name) throw new HttpError(400, '缺少模型名')
  await inv.splitModelName(name)
  return buildState()
})

/** 取消一条手动别名，回到自动规则归一 */
route('DELETE', /^\/api\/models\/alias$/, async (ctx) => {
  const name = String(ctx.body?.name || ctx.query?.get('name') || '').trim()
  if (!name) throw new HttpError(400, '缺少模型名')
  await inv.unaliasModelName(name)
  return buildState()
})

/** 清空全部分手别名 */
route('POST', /^\/api\/models\/aliases\/reset$/, async () => {
  const result = await inv.resetModelAliases()
  return { ...(await buildState()), aliasReset: result }
})

// ------------------------------------------------------------------- probes

/**
 * 协议探查的 Key 选择顺序和 probe-runner 保持一致：
 * offer 上绑的 Key → 同站同分组的 Key → 同站任意 Key。
 * 两边各写一份的话，页面显示「有 Key」、真正探测却说没有，是最难查的那种不一致。
 */
function credentialForOffer(db, offer) {
  if (offer.credentialId) {
    const exact = db.credentials.find((c) => c.id === offer.credentialId)
    if (exact) return exact
  }
  return (
    db.credentials.find(
      (c) => c.providerId === offer.providerId && (c.group || '') === (offer.group || ''),
    ) ||
    db.credentials.find((c) => c.providerId === offer.providerId) ||
    null
  )
}

/** 协议探查页的级联选择器数据：站点 → 分组 → 模型（带探针状态标签）。 */
function protocolTargets(db) {
  const ignored = inv.ignoredModelSet(db)
  // 状态标签和探针页同一份判定：scoresFor + admissionTags，这里只透传，不另判一遍
  const scoreMap = scoresFor(db)
  const maxTtftMs = Number(db.settings.maxTtftMs) || 0
  const allowUntrusted = Boolean(db.settings.allowUntrusted)
  const sites = []

  const providers = [...db.providers].sort(
    (a, b) =>
      (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) ||
      String(a.createdAt || '').localeCompare(String(b.createdAt || '')),
  )

  for (const provider of providers) {
    const groups = new Map()
    for (const offer of db.offers) {
      if (offer.providerId !== provider.id || offer.delistedAt) continue
      const name = String(offer.upstreamName || offer.modelKey || '').trim()
      if (!name) continue
      const groupName = offer.group || ''
      if (!groups.has(groupName)) groups.set(groupName, new Map())
      const models = groups.get(groupName)
      // 同组同名模型只留一条；offerId 指向第一条，探测时按它取 Key
      if (models.has(name)) continue
      // ignored 判定用身份键（ignoredModelSet 的口径）；modelKey 字段仍存存储键，
      // 它表示「这条供给自己的名字」，前端拿去做别的比对
      const identityOfOffer = inv.modelIdentityKey(offer.modelKey || name, db.settings?.modelAliases || {})
      const modelKey = inv.normalizeModelKey(offer.modelKey || name)
      // 模型当前状况：与探针/比价页同一口径（admissionTags 唯一实现）。
      // 前端拿去画标签，并在状况不佳时提醒「协议测试可能出现偏差」
      const score = scoreMap.get(offer.id)
      let tags = []
      let blocked = null
      let probeStatus = null
      if (score) {
        const tooSlow = isTooSlow(score, maxTtftMs)
        const gateRow = {
          ...score,
          tooSlow,
          allowUntrusted,
          samples: (score.samples || 0) + (score.trafficSamples || 0),
        }
        tags = admissionTags(gateRow)
        blocked = score.blocked || null
        probeStatus = score.status || null
      }
      models.set(name, {
        offerId: offer.id,
        model: name,
        modelKey,
        ignored: Boolean(identityOfOffer) && ignored.has(identityOfOffer),
        hasKey: Boolean(credentialForOffer(db, offer)),
        tags,
        blocked,
        // 窗口到了但还没被证明恢复时，页面要把原因写出来（「上游账号冷却中 · 等确认恢复」）
        pendingRecovery: score ? score.pendingRecovery || null : null,
        probeStatus,
      })
    }

    const groupList = [...groups.entries()]
      .map(([name, models]) => ({
        name,
        label: name || '（默认分组）',
        hasKey: [...models.values()].some((model) => model.hasKey),
        models: [...models.values()].sort((a, b) => a.model.localeCompare(b.model)),
      }))
      .filter((group) => group.models.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name))

    if (groupList.length === 0) continue
    sites.push({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      kind: provider.kind || 'unknown',
      paused: Boolean(provider.paused),
      groups: groupList,
    })
  }

  return sites
}

/** Anthropic 系模型才探 Anthropic Messages：模型名里带 claude / anthropic 才算。 */
function looksAnthropic(model) {
  return /claude|anthropic/i.test(String(model || ''))
}

route('GET', /^\/api\/protocol\/targets$/, async () => {
  const db = await store.readDbCached()
  const sites = protocolTargets(db)
  return {
    sites,
    modelCount: sites.reduce(
      (sum, site) => sum + site.groups.reduce((n, group) => n + group.models.length, 0),
      0,
    ),
    at: new Date().toISOString(),
  }
})

route('POST', /^\/api\/protocol\/probe$/, async (ctx) => {
  const body = ctx.body || {}
  let target

  if (body.mode === 'manual') {
    const baseUrl = String(body.baseUrl || '').trim()
    const apiKey = String(body.apiKey || '').trim()
    const model = String(body.model || '').trim()
    if (!baseUrl) throw new HttpError(400, '请填写 API 地址')
    if (!apiKey) throw new HttpError(400, '请填写 API Key')
    if (!model) throw new HttpError(400, '请填写模型名')
    target = {
      mode: 'manual',
      baseUrl: inv.normalizeBaseUrl(baseUrl),
      apiKey,
      model,
      authMode: ['auto', 'bearer', 'x-api-key'].includes(body.authMode) ? body.authMode : 'auto',
      label: `${inv.normalizeBaseUrl(baseUrl)} / ${model}`,
      anthropicSkipped: !looksAnthropic(model),
    }
  } else {
    const db = await store.readDb()
    const offer = db.offers.find((row) => row.id === body.offerId)
    if (!offer) throw new HttpError(404, '模型记录不存在，可能已下线或删除')
    const provider = db.providers.find((p) => p.id === offer.providerId)
    if (!provider) throw new HttpError(404, '站点不存在')
    const credential = credentialForOffer(db, offer)
    if (!credential) throw new HttpError(400, '这个分组没有 Key，先去「站点」页加一个')
    const apiKey = await inv.revealSecret(credential.id)
    if (!apiKey) throw new HttpError(400, 'Key 解密失败，可能是 master.key 被替换过')
    target = {
      mode: 'gateway',
      providerId: provider.id,
      providerName: provider.name,
      group: offer.group || '',
      offerId: offer.id,
      baseUrl: provider.baseUrl,
      apiKey,
      model: offer.upstreamName || offer.modelKey,
      authMode: 'auto',
      label: `${provider.name} / ${offer.group || '默认分组'} / ${offer.upstreamName}`,
      anthropicSkipped: !looksAnthropic(offer.upstreamName || offer.modelKey),
    }
  }

  // 非 Anthropic 模型（名字里没 claude/anthropic）跳过 Anthropic Messages：
  // 站点对非 Claude 模型的 /messages 几乎必拒，测了只会产出一整片误导性红圆
  const protocolScope = target.anthropicSkipped ? ['chat', 'responses'] : undefined

  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 45000, 5000), 60000)
  const overallTimeoutMs = Math.min(Math.max(Number(body.overallTimeoutMs) || 240000, 20000), 300000)
  const options = {
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    model: target.model,
    authMode: target.authMode,
    protocols: protocolScope,
    timeoutMs,
    overallTimeoutMs,
  }

  // 测试 / 脚本走 ?format=json 一次拿完整结果；浏览器走 NDJSON 实时看进度
  const wantJson =
    ctx.query.get('format') === 'json' ||
    String(ctx.req.headers.accept || '').toLowerCase().includes('application/json')

  // 探完落一条记录（同一目标只留最新）。badStatus 从 targets 同一口徃的标签来，
  // 记录页要提醒「当时这个模型状况就不佳，红圆可能是状态问题不是协议问题」
  const saveRecord = async (result) => {
    const db = await store.readDb()
    const entry = protocolTargets(db)
      .flatMap((site) => site.groups.flatMap((group) => group.models))
      .find((model) => model.offerId === target.offerId)
    const statusTags = entry ? entry.tags || [] : []
    const badStatus = statusTags.some((kind) => kind !== 'ok' && kind !== 'fallback')
    const record = buildProtocolRecord({ result, target, statusTags, badStatus })
    await store.mutate((db2) => saveProtocolRecord(db2, record))
    return record
  }

  if (wantJson) {
    const result = await probeProtocols(options)
    const record = await saveRecord(result)
    return { ...result, target: { ...result.target, ...target, apiKey: undefined }, recordId: record.id }
  }

  ctx.res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  })
  const controller = new AbortController()
  const send = (event) => {
    if (ctx.res.writableEnded || ctx.res.destroyed) return
    ctx.res.write(`${JSON.stringify(event)}\n`)
  }
  // 浏览器关页面 / 点停止：把还在飞的探测请求一起取消
  ctx.res.on('close', () => controller.abort())

  try {
    // onProgress 也会发 type:'result'（无 recordId 的原始结果），滤掉避免前端收到两份；
    // 真正的最终结果由下面显式 send（带 recordId）
    const result = await probeProtocols({
      ...options,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.type !== 'result') send(event)
      },
    })
    let recordId = null
    try {
      const record = await saveRecord(result)
      recordId = record.id
    } catch (error) {
      // 记录写盘失败不该吞掉探查结果，只在流里提醒一句
      send({ type: 'record-error', error: error?.message || String(error) })
    }
    send({ type: 'result', result: { ...result, target: { ...result.target, ...target, apiKey: undefined }, recordId } })
    send({ type: 'done' })
  } catch (error) {
    send({ type: 'error', error: error?.message || String(error) })
  } finally {
    if (!ctx.res.writableEnded) ctx.res.end()
  }
  return undefined
})

// ------------------------------------------------------------- 协议记录

route('GET', /^\/api\/protocol\/records$/, async () => {
  // 开了「按天自动清理」就顺手清一次（惰性执行：读记录页时才清，不用定时器）
  const retention = Number((await store.readDb()).settings.protocolRecordMaxAgeDays) || 0
  let pruned = 0
  if (retention > 0) {
    await store.mutate((db) => {
      pruned = pruneProtocolRecords(db, retention)
    })
  }
  const db = await store.readDbCached()
  const list = db.protocolProbes || []
  // 列表视图裁掉能力明细：那是点开单条详情才要的
  return {
    records: [...list]
      .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
      .map((row) => ({
        id: row.id,
        ts: row.ts,
        durationMs: row.durationMs,
        mode: row.mode,
        label: row.label,
        baseUrl: row.baseUrl,
        model: row.model,
        skippedProtocols: row.skippedProtocols || [],
        statusTags: row.statusTags || [],
        badStatus: Boolean(row.badStatus),
        summary: row.summary || null,
        protocols: Object.fromEntries(
          Object.entries(row.protocols || {}).map(([id, protocol]) => [
            id,
            {
              surface: protocol.surface,
              real: protocol.real,
              summary: protocol.summary,
            },
          ]),
        ),
      })),
    total: list.length,
    pruned,
    retentionDays: retention,
  }
})

/** 自动清理开关：days=0 关闭；1~365 按天清理。 */
route('PATCH', /^\/api\/protocol\/records\/retention$/, async (ctx) => {
  const days = Math.round(Number(ctx.body.days) || 0)
  if (days < 0 || days > 365) throw new HttpError(400, '清理天数必须是 0~365（0 = 关闭自动清理）')
  let pruned = 0
  await store.mutate((db) => {
    db.settings.protocolRecordMaxAgeDays = days
    pruned = pruneProtocolRecords(db, days)
  })
  return { ok: true, retentionDays: days, pruned }
})

route('GET', /^\/api\/protocol\/records\/([\w-]+)$/, async (ctx) => {
  const db = await store.readDbCached()
  const record = (db.protocolProbes || []).find((row) => row.id === ctx.params[0])
  if (!record) throw new HttpError(404, '记录不存在（可能已被清空）')
  return { record }
})

route('DELETE', /^\/api\/protocol\/records\/([\w-]+)$/, async (ctx) => {
  let removed = 0
  await store.mutate((db) => {
    removed = removeProtocolRecord(db, ctx.params[0])
  })
  if (!removed) throw new HttpError(404, '记录不存在')
  return { ok: true, removed }
})

route('DELETE', /^\/api\/protocol\/records$/, async () => {
  let removed = 0
  await store.mutate((db) => {
    removed = clearProtocolRecords(db)
  })
  return { ok: true, removed }
})

route('POST', /^\/api\/probes\/run$/, async (ctx) => {
  const limit = Math.min(Number(ctx.body.limit) || 5, 20)
  const results = await runProbes({
    providerId: ctx.body.providerId,
    offerId: ctx.body.offerId,
    offerIds: ctx.body.offerIds,
    limit,
  })
  if (results.length === 0) {
    throw new HttpError(400, '没有可探测的目标：需要该站至少一个 Key，并已同步模型列表')
  }
  return { ...(await buildState()), probeResults: results }
})

// 探针花费：单独一个接口，不塞进 /api/state。界面每半小时拉一次，而 /api/state
// 是 15 秒一轮的轮询——放进去就变成每 15 秒刷一次，不是想要的口径。
route('GET', /^\/api\/probes\/spend$/, async () => {
  const db = await store.readDb()
  const data = await readProbeSpend()
  return { probeSpend: buildProbeSpendView(data, { providers: db.providers, settings: db.settings }) }
})

// 清空探针花费统计（卡片右上角的小垃圾桶）。只是把账本归零并重置统计起点，
// 不影响 db.probes 里已经存下来的探测结果。
route('DELETE', /^\/api\/probes\/spend$/, async () => {
  await clearProbeSpend()
  const db = await store.readDb()
  const data = await readProbeSpend()
  return { probeSpend: buildProbeSpendView(data, { providers: db.providers, settings: db.settings }) }
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
    // 币种：用户改了才记成手选（currencySource='custom'），同步就不会再覆盖它。
    // 值没变不算表态——界面点一下下拉又选回原值不该把这一行冻住。
    // 认三个：USD / CNY / RUSD（真实美元，真按美元计价的站用）
    if (b.currency !== undefined) {
      const next = b.currency === 'CNY' || b.currency === 'RUSD' ? b.currency : 'USD'
      if (next !== offer.currency) {
        offer.currency = next
        offer.currencySource = 'custom'
      }
    }
    // 想重新跟随站点：清掉手选标记，下次同步按站方声明落价
    if (b.currencySource !== undefined) {
      if (b.currencySource === 'custom') offer.currencySource = 'custom'
      else delete offer.currencySource
    }
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

// ---------------------------------------------------------------- 故障转移接口
// 给未来的故障监控系统接：真实运行中探测到影响服务的故障 / 异常，就推一条过来。
// 证据等级高于探针（探针是抽样体检，运行现场才是真病），上报即故障转移。

/**
 * 故障上报（外部监控系统 → 本网关）。
 *
 *   Authorization: Bearer <failoverToken>（settings.failoverToken，daemon 启动时
 *   自动生成，UI 可查；监控系统接入时配一次即可）
 *
 * body：
 *   offerId    供给级上报：某个站的某条供给出了问题（推荐，最精确）
 *   modelKey   模型级上报：这个模型本身坏了（哪家接都一样），命中全部同款供给。
 *              两者都给也行；都不给 = 不知道坏的是谁，拒收（400）
 *   kind       故障类型（自由文本，如 timeout / 5xx / empty-response）
 *   message    人话描述，决策页的故障转移徽标悬浮时看
 *   holdMinutes 保持期（分钟，可选）：期内剔除，到期自动恢复参选。缺省 10 分钟，
 *              上限 24 小时——监控系统有自己的重试节奏时按它的填
 *
 * 返回落盘后的记录；同时若自动路由开着，会立刻按新口径重选一次（含落盘）。
 */
route('POST', /^\/api\/failover\/report$/, async (ctx) => {
  // 令牌只认 Authorization 头：URL 带 token 会被访问日志 / 浏览器历史留下来
  const auth = String(ctx.req.headers.authorization || '')
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  const expected = (await store.readDb()).settings.failoverToken
  if (!expected || token !== expected) {
    throw new HttpError(401, '故障上报令牌无效：Authorization: Bearer <failoverToken>，令牌见智能决策页')
  }
  const { offerId, modelKey, kind, message, holdMinutes } = ctx.body || {}
  if (!offerId && !modelKey) {
    throw new HttpError(400, '故障上报必须带 offerId（供给级）或 modelKey（模型级）至少一个')
  }
  const holdMs = holdMinutes !== undefined ? Number(holdMinutes) * 60_000 : FAULT_HOLD_MS
  const record = await store.mutate((db) => {
    // 核对目标真实存在：监控打错名字时不报错不落库，返回 404 让它修配置
    const offers = inv.routeableOffers(db)
    if (offerId && !offers.some((o) => o.id === offerId)) {
      throw new HttpError(404, `offerId 不存在或不在役：${offerId}`)
    }
    if (modelKey && !offers.some((o) => o.modelKey === modelKey)) {
      throw new HttpError(404, `modelKey 不存在或不在役：${modelKey}`)
    }
    const entry = normalizeFailover(db.failover)
    const saved = addFaultReport(entry, { offerId, modelKey, kind, message, holdMs })
    db.failover = entry
    return saved
  })
  // 上报即重选：不用等下一个请求才发现现役病了（重选含落盘）
  const pick = await repickAfterFailoverChange()
  return { ok: true, report: record, repick: pick }
})

/** 故障上报 / 解除后立刻重选一次自动路由（接管中才有效；失败不影响上报本身） */
async function repickAfterFailoverChange() {
  const db = await store.readDb()
  if (!normalizeAutoRoute(db.settings.autoRoute).enabled) return null
  try {
    const scores = scoresFor(db)
    const benchmarks = await bench.readBenchmarks()
    const pick = pickAutoRoute(db, { scores, benchmarks })
    if (pick?.switched) {
      await store.mutate((latest) => {
        applyAutoRoutePick(latest.settings, pick)
      })
    }
    return pick
  } catch (error) {
    console.error('[failover] 上报后重选失败:', error.message)
    return null
  }
}

/** 活跃 + 最近上报清单（监控系统对账用） */
route('GET', /^\/api\/failover\/reports$/, async () => {
  const db = await store.readDb()
  expireFaultReports(db.failover)
  return {
    token: db.settings.failoverToken,
    holdMs: FAULT_HOLD_MS,
    active: activeReports(db.failover),
    reports: (db.failover?.reports || []).slice(-50).reverse(),
  }
})

/** 人工解除：监控系统确认修好了（或误报），不必等保持期走完。body 带 id / offerId / modelKey 任一 */
route('POST', /^\/api\/failover\/clear$/, async (ctx) => {
  const auth = String(ctx.req.headers.authorization || '')
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  const expected = (await store.readDb()).settings.failoverToken
  if (!expected || token !== expected) {
    throw new HttpError(401, '故障上报令牌无效：Authorization: Bearer <failoverToken>，令牌见智能决策页')
  }
  const { id, offerId, modelKey } = ctx.body || {}
  if (!id && !offerId && !modelKey) {
    throw new HttpError(400, '解除必须带 id / offerId / modelKey 至少一个')
  }
  await store.mutate((db) => {
    const entry = normalizeFailover(db.failover)
    clearFaultReports(entry, { id, offerId, modelKey })
    db.failover = entry
  })
  const pick = await repickAfterFailoverChange()
  return { ok: true, repick: pick }
})

/**
 * 用量区间参数：自定义起止（from / to）优先，否则走 days。
 * 只接受 YYYY-MM-DD，其他格式一律当没传——宁可回自然区间，也不要拿个
 * 解析失败的怪日期去查库然后凭空得一个空结果。
 */
function usageRangeParams(ctx) {
  const pick = (key) => {
    const raw = String(ctx.query.get(key) || '').trim()
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
  }
  const from = pick('from')
  const to = pick('to')
  return from && to ? { from, to } : { from: null, to: null }
}

/**
 * 用量汇总。两种区间写法：
 *   ?days=30                          最近 30 天（含今天）
 *   ?from=2026-10-01&to=2026-10-20    自定义起止（本地日期，两端都含）
 */
route('GET', /^\/api\/usage$/, async (ctx) => {
  const days = Math.min(Math.max(Number(ctx.query.get('days')) || 30, 1), 365)
  const { from, to } = usageRangeParams(ctx)
  // 模型名归一：同一个模型在不同站写法不一，用量表里不该出现两行
  const db = await store.readDb()
  return {
    usage: await usageSummary({
      days,
      from,
      to,
      resolveModel: (name) => inv.modelIdentityKey(name, db.settings?.modelAliases || {}),
    }),
  }
})

/**
 * 详细用量。三个数字各来自**明确写在这里**的三个地方，口径不许混：
 *
 *   totals   —— usage.json 全量聚合：这段时间真的花了多少（不受日志/明细条数限制）
 *   subtotal —— 同一份全量聚合按「站点 / 分组 / 模型」过滤后求和。**不是**把
 *               明细行加起来——明细有保留期和条数上限，拿它求和必然和 totals 对不上，
 *               那正是「上面 20 条、下面 182 条」的来历
 *   requests —— 逐条账本（usage-detail/，保留 30 天）：只负责「每一条长什么样」
 *
 * 账本里没有（还没开始记 / 过期了）就退回决策日志（最近 500 条），并如实标注来源。
 */
route('GET', /^\/api\/usage\/detail$/, async (ctx) => {
  const days = Math.min(Math.max(Number(ctx.query.get('days')) || 7, 1), 90)
  const limit = Math.min(Math.max(Number(ctx.query.get('limit')) || 200, 1), 2000)
  const { from, to } = usageRangeParams(ctx)
  // 与 /api/usage 同一口径（模型身份键归一），否则同一模型两种写法会在两个接口里各算一行
  const dbForAliases = await store.readDb()
  const summary = await usageSummary({
    days,
    from,
    to,
    resolveModel: (name) => inv.modelIdentityKey(name, dbForAliases.settings?.modelAliases || {}),
  })

  // 筛选：站点 / 分组（带 providerId，同名分组到处都是）/ 模型
  const filter = {
    providerId: String(ctx.query.get('providerId') || ''),
    group: ctx.query.get('group')
      ? {
          providerId: String(ctx.query.get('groupProviderId') || ''),
          name: String(ctx.query.get('group')),
        }
      : null,
    model: String(ctx.query.get('model') || ''),
  }

  // 小计与下拉选项都从全量聚合算：这样「筛出来的」永远等于「这段时间真的花了多少」
  const subtotal = sumBuckets(summary.buckets, filter)
  const facets = facetOptions(summary.buckets, filter)

  const clearedMs = summary.clearedAt ? Date.parse(summary.clearedAt) : null
  const floorMs = Number.isFinite(clearedMs) ? clearedMs : null

  // 明细：优先逐条账本（保留期内都查得到），没有就退回决策日志
  const rangeDays = (summary.days || []).slice(-DETAIL_RETENTION_DAYS)
  let source = 'ledger'
  let rawRows = await readDetail(rangeDays)
  if (!rawRows.length) {
    source = 'log'
    rawRows = await inv.listRouting(500)
  }

  const matched = []
  let scanned = 0
  let clearedDropped = 0
  let missingUsage = 0
  for (const raw of rawRows) {
    const row = detailRow(raw)
    if (!row) continue
    scanned += 1
    // 清空水位线：清空前的请求不再计入（汇总与明细同时遵守）
    if (floorMs !== null && row.tsMs < floorMs) {
      clearedDropped += 1
      continue
    }
    if (filter.providerId && row.providerId !== filter.providerId) continue
    if (
      filter.group &&
      (row.providerId !== filter.group.providerId || (row.group || '') !== filter.group.name)
    ) {
      continue
    }
    // 桶里的模型名是身份键（同一模型的两种写法合成一行），明细行是原始写法，
    // 比对前必须过同一份归一函数——否则按模型筛会「选得到、筛出 0 条」
    if (filter.model) {
      const rowModel = inv.modelIdentityKey(row.model, dbForAliases.settings?.modelAliases || {})
      if (rowModel !== filter.model) continue
    }
    if (row.prompt === null) missingUsage += 1
    matched.push(row)
  }
  matched.sort((a, b) => b.tsMs - a.tsMs)

  return {
    days,
    totals: summary.totals,
    subtotal,
    filter,
    facets,
    requests: matched.slice(0, limit),
    window: {
      source,
      available: matched.length,
      shown: Math.min(matched.length, limit),
      capped: matched.length > limit,
      scanned,
      missingUsage,
      // 账本保留天数：过期之后那几天只剩汇总
      retentionDays: DETAIL_RETENTION_DAYS,
      ledgerDays: (await listDetailDays()).slice(-DETAIL_RETENTION_DAYS),
      // 清空水位线：前端据此说明「明细从什么时候开始算」
      clearedAt: summary.clearedAt || null,
      clearedDropped,
      logLimit: source === 'log' ? 500 : null,
    },
  }
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

// ------------------------------------------------------- 异常诊断 · 空回合守卫

/**
 * 诊断引擎：账本信号 → 说人话的结论（规则在 core/diagnosis.js、core/anomaly.js）。
 *
 * 和上面 /api/diagnostics（空回合守卫的页面数据）是两个视角：
 *   本接口回答「现在哪里不对劲、哪层问题、你该做什么」
 *   /api/diagnostics 回答「空回合守卫自己干了什么」
 * 两边数据源有重叠（都读 errorbook / offerStats），但结论不重复：
 * 空回合守卫的「救回来了」只进它自己的记录，不在这里变成告警。
 */
route('GET', /^\/api\/diagnosis$/, async () => {
  const db = await store.readDb()
  const providerName = new Map((db.providers || []).map((p) => [p.id, p.name]))
  const offerMeta = new Map()
  for (const o of db.offers || []) {
    offerMeta.set(o.id, {
      label: `${providerName.get(o.providerId) || '?'} · ${o.modelKey || o.upstreamName || '?'}`,
      modelKey: o.modelKey || o.upstreamName || null,
      providerName: providerName.get(o.providerId) || null,
      providerId: o.providerId || null,
    })
  }
  const scoreMap = scoresFor(db)
  return diag.diagnose({
    errorbook: db.errorbook || {},
    offerStats: db.offerStats || {},
    providers: db.providers || [],
    monitorBalance: db.monitor?.balance || [],
    offerMeta,
    scores: Object.fromEntries([...scoreMap].map(([id, s]) => [id, { status: s.status, routable: s.routable }])),
  })
})

/** 账本查询：错误指纹 + 供给表现小时桶（调试数据面板用） */
route('GET', /^\/api\/diagnosis\/ledger$/, async (ctx) => {
  const db = await store.readDb()
  const hours = Number(ctx.query.get('hours'))
  const kind = ctx.query.get('kind') || null

  const book = Object.values(db.errorbook || {})
    .filter((e) => (kind ? e.kind === kind : true))
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))

  let stats = Object.values(db.offerStats || {})
  if (Number.isFinite(hours) && hours > 0) {
    const cutoff = new Date(Date.now() - hours * 3600000)
    const cutoffKey = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}-${String(cutoff.getUTCDate()).padStart(2, '0')}T${String(cutoff.getUTCHours()).padStart(2, '0')}`
    stats = stats.filter((b) => String(b.hour).slice(0, 13) >= cutoffKey)
  }
  stats.sort((a, b) => String(b.hour).localeCompare(String(a.hour)))

  return {
    errorbook: book,
    offerStats: stats,
    totals: {
      fingerprints: book.length,
      errorCount: book.reduce((a, e) => a + e.count, 0),
      buckets: stats.length,
      diagnosed: book.filter((e) => e.lastDiagnosis).length,
    },
  }
})

/** 一键体检：用户亲手点才跑（会真的打上游、花 token，不做定时） */
route('POST', /^\/api\/diagnosis\/checkup$/, async (ctx) => {
  const body = ctx.body || {}
  return runCheckup({
    modelKey: body.modelKey || null,
    offerIds: Array.isArray(body.offerIds) ? body.offerIds : null,
  })
})

/** 诊断页的全部数据：开关、档位表、发生记录、当前改道 */
route('GET', /^\/api\/diagnostics$/, async () => {
  const db = await store.readDb()
  ensureEmptyEvents(db)
  ensureDetours(db)
  const guard = normalizeEmptyGuard(db.settings.emptyGuard)
  const events = [...(db.emptyTurns || [])].reverse()
  return {
    guard,
    tiers: RETRY_TIERS.map((tier) => ({
      key: tier.key,
      label: tier.label,
      retries: tier.retries,
      waitMs: tier.waitMs,
      maxMs: Number.isFinite(tier.maxMs) ? tier.maxMs : null,
    })),
    summary: summarizeEmptyEvents(db.emptyTurns || []),
    events,
    // 当前生效的改道：原站 → 现用站、从什么时候开始、下次什么时候复检
    detours: [...activeDetours(db).values()],
    recheckMinutes: Math.round(DETOUR_RECHECK_MS / 60000),
    // 故障信号：几条在生效、有没有人接（自动路由订阅了就 >0）
    faults: {
      summary: summarizeFaultSignals(db),
      active: [...combineWithDetours(db, activeFaultSignals(db)).values()],
    },
  }
})

/** 开关与模式：只改这两个字段，不和 settings 里其它开关混在一起校 */
route('PATCH', /^\/api\/diagnostics$/, async (ctx) => {
  const { enabled, mode } = ctx.body || {}
  if (mode !== undefined && !['same', 'switch'].includes(String(mode))) {
    throw new HttpError(400, '补问模式只能是 same（同站）或 switch（换一家）')
  }
  await store.mutate((db) => {
    const current = normalizeEmptyGuard(db.settings.emptyGuard)
    db.settings.emptyGuard = {
      enabled: enabled === undefined ? current.enabled : Boolean(enabled),
      mode: mode === undefined ? current.mode : String(mode),
    }
  })
  return { ok: true }
})

/**
 * 故障信号接口（给自动路由 / 外部消费方读）。
 *
 * 两种取用方式都在这里落地：
 *   GET 拉快照 —— active 的故障，已把「临时改道」并进来，key 是 offerId
 *   POST 订阅   —— 不，进程内用 subscribeFaults()，不要走 HTTP（见文件头）
 *
 * 这个接口给「人」和「外部进程」看：界面要显示有几条在生效，
 * 别的进程（非本机同进程的模块）要拿当前故障清单也只能走这里。
 */
route('GET', /^\/api\/faults$/, async (ctx) => {
  const db = await store.readDb()
  const snapshot = combineWithDetours(db, activeFaultSignals(db))
  // 上报事件账（截流/已报/上报失败）。和上面的 faultSignals 是两个层次：
  //   faultSignals —— 诊断发现的「这家现在不行」（影响路由选站）
  //   faultEvents  —— 我们向外报告的动作与结果（影响自动路由换人）
  // 放同一接口是因为页面上它们就是一张卡的两半，分开取反而容易漏读
  const events = (db.faultEvents || []).slice(-80).reverse()
  return {
    // 生效中的故障：自动路由挑优时按 offerId 过滤即可
    active: [...snapshot.values()],
    summary: summarizeFaultSignals(db),
    // 订阅者数量：0 表示「现在没有人在接信号」，界面要提示出来，
    // 否则用户会以为自动路由已经知道这件事了，其实没人听
    subscribers: faultSubscriberCount(),
    history: (db.faultSignals || []).slice(-50).reverse(),
    // ---- 上报通道（自动路由的故障转移）
    // url 回解析后的实际地址：空表示「跟着本进程端口走」，界面要能看见它到底打哪
    config: {
      ...faultReporter.normalizeFaultReport(db.settings?.faultReport),
      url: faultReporter.resolveReportUrl(db),
    },
    // 令牌只回是否就绪，不回明文（这个页面不需要看令牌）
    tokenReady: Boolean(faultReporter.resolveToken(db)),
    autoRouteTokenPresent:
      typeof db.settings?.failoverToken === 'string' && Boolean(db.settings.failoverToken),
    events,
    stats: {
      observed: events.length,
      absorbed: events.filter((e) => e.status === 'absorbed').length,
      sent: events.filter((e) => e.status === 'sent').length,
      failed: events.filter((e) => e.status === 'failed').length,
      skipped: events.filter((e) => e.status === 'skipped').length,
    },
  }
})

/** 上报通道配置：开关 / 地址 / 令牌（默认复用本库的 failoverToken，不用手抄） */
route('PATCH', /^\/api\/faults\/config$/, async (ctx) => {
  const body = ctx.body || {}
  await store.mutate((db) => {
    const cur = faultReporter.normalizeFaultReport(db.settings.faultReport)
    db.settings.faultReport = faultReporter.normalizeFaultReport({
      ...cur,
      enabled: body.enabled === undefined ? cur.enabled : Boolean(body.enabled),
      url: body.url === undefined ? cur.url : String(body.url),
      token: body.token === undefined ? cur.token : String(body.token),
      useOwnToken: body.useOwnToken === undefined ? cur.useOwnToken : Boolean(body.useOwnToken),
    })
  })
  return { ok: true }
})

/** 手动试一下上报通不通（用户点「测试上报通道」）：真发一条，但不影响任何供给 */
route('POST', /^\/api\/faults\/test$/, async () => {
  const db = await store.readDb()
  // 挑一条在役供给当目标：自动路由拒收「没有目标的报表」，所以测试必须带真的
  const offer = inv.routeableOffers(db)[0] || null
  if (!offer) {
    return { ok: false, skipped: '没有可测试的供给（先去站点页同步一个站）' }
  }
  const result = await faultReporter.reportFault({
    offerId: offer.id,
    modelKey: offer.modelKey || null,
    kind: 'connectivity-test',
    message: '来自 ManageAPI 诊断系统的连通性测试（可忽略，1 分钟后自动失效）',
    holdMinutes: 1,
    impact: { impact: 'none', reason: '连通性测试' },
  })
  return {
    ...result,
    hint: result.ok
      ? '上报通道畅通'
      : result.skipped
        ? `没发出去：${result.skipped}`
        : `上报失败：${result.error}`,
  }
})

/** 手动清掉某条供给的故障（排查时用：确认它好了就把标记摘掉） */
route('DELETE', /^\/api\/faults\/([\w-]+)$/, async (ctx) => {
  const key = ctx.params[0]
  const db = await store.readDb()
  const hit = (db.faultSignals || []).find(
    (signal) => signal.id === key || signal.scope?.offerId === key || signal.scope?.providerId === key,
  )
  if (!hit) throw new HttpError(404, '没有这条故障信号')
  await inv.clearFaults(
    hit.scope?.offerId ? { offerId: hit.scope.offerId } : { providerId: hit.scope?.providerId },
  )
  publishFault(
    buildFaultSignal({
      kind: 'empty-turn',
      level: 'notice',
      active: false,
      scope: hit.scope,
      reason: '手动清除',
    }),
  )
  return { ok: true }
})

/** 清空发生记录（只清记录，不动开关与改道） */
route('DELETE', /^\/api\/diagnostics\/events$/, async () => {
  const removed = await inv.clearEmptyEventsLog()
  return { ok: true, removed }
})

/** 手动解除一条改道（不想等 20 分钟自动复检时用） */
route('DELETE', /^\/api\/diagnostics\/detours\/([\w-]+)$/, async (ctx) => {
  const row = await inv.resolveEmptyDetour(ctx.params[0], { reason: 'manual' })
  if (!row) throw new HttpError(404, '没有这条改道，或已经解除了')
  return { ok: true }
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
  // 顺手写一份逐条明细账本（去掉候选详情，约 300 字节/条）。
  // 和决策日志并行：日志是「最近发生了什么」的调试窗口（500 条），
  // 账本是「每一条花了多少」的账（保留 30 天），用途不同别混着用
  void appendDetail(batch)
  return inv.recordRoutingBatch(batch).catch((error) => {
    // 写失败把本批塞回队头，下个 2 秒周期重试——决策日志是排查依据，
    // 静默丢弃等于让「为什么选了它」永远查不到
    console.error('[网关] 决策日志写盘失败，已回队重试：', error)
    routingBuffer.unshift(...batch)
  })
}

function queueRouting(entry) {
  // 时间戳在入队时定，不在落盘时定：一批 flush 的多条请求本来不同时刻完成，
  // 用 flush 时间会让它们看起来完全同时发生（排查时误判成并发）
  routingBuffer.push({ ...entry, ts: entry.ts || new Date().toISOString() })
  if (routingBuffer.length >= 200) flushRouting() // 上游一直失败时别把内存堆爆
  if (!routingTimer) routingTimer = setTimeout(flushRouting, 2000)
}

// 空回合记录也攒批写：理由同决策日志，尽量不让一个请求带两次整库重写。
// 异常事件本来就少，2 秒延迟完全够用
const emptyBuffer = []
let emptyTimer = null

function queueEmptyEvent(event) {
  if (!event) return
  emptyBuffer.push(event)
  if (!emptyTimer) {
    emptyTimer = setTimeout(() => {
      emptyTimer = null
      const batch = emptyBuffer.splice(0, emptyBuffer.length)
      inv.recordEmptyBatch(batch).catch((error) => {
        console.error('[网关] 空回合记录写盘失败：', error)
        emptyBuffer.unshift(...batch)
      })
    }, 2000)
    emptyTimer.unref?.()
  }
}

// 故障信号也攒批写（理由同上）。区别是它还要**广播**给订阅者（自动路由）
const faultBuffer = []
let faultTimer = null

function queueFaultSignal(signal) {
  if (!signal) return
  faultBuffer.push(signal)
  if (!faultTimer) {
    faultTimer = setTimeout(() => {
      faultTimer = null
      const batch = faultBuffer.splice(0, faultBuffer.length)
      inv.recordFaultBatch(batch).catch((error) => {
        console.error('[网关] 故障信号写盘失败：', error)
        faultBuffer.unshift(...batch)
      })
    }, 2000)
    faultTimer.unref?.()
  }
  // 广播是同步的：订阅方（自动路由）要能立刻生效，不能等落盘。
  // notice 级不广播——见 core/fault-signal.js 文件头，救回来的事不打扰路由
  if (signal.level !== 'notice') publishFault(signal)

  // 同时写进自动路由那边的故障账（core/failover.js）：那是路由排序和自动路由
  // 「不把它当最优」实际消费的那一份。只发信号不写账的话，自动路由即使订阅了
  // 也得自己再存一份——两边各存一份必然会漂，所以收口在这一处。
  // 这里做的是异步写，失败只记日志：诊断是旁路，不能拦这一单请求
  store
    .mutate((latestDb) => {
      applyFaultToFailover(latestDb, signal)
    })
    .catch((error) => console.error('[故障信号] 写故障账失败：', error.message))
}

/**
 * 一次空回合结束后，判断「这事要不要告诉路由」。
 *
 * 三档判定全在 core/fault-signal.js#judgeEmptyFault，这里只负责凑事实、发信号。
 *
 * @param {object} input
 *   provider / offer   出问题的供给
 *   model             客户端请求的模型名
 *   recovered         这一轮最后有没有救回来
 *   hadFallback       有没有别家可换
 *   detail            附加事实（记进信号，方便排查）
 */
function reportEmptyFault({ candidate, model, recovered, hadFallback = true, detail = {} }) {
  if (!candidate?.provider) return
  // 5 分钟窗口内的命中次数：进程内滑动窗口，见 emptyHitWindow
  const hits = countEmptyHits({
    providerId: candidate.provider.id,
    modelKey: inv.normalizeModelKey(model),
  })
  const verdict = judgeEmptyFault({ hits, recovered, hadFallback })
  const scope = {
    providerId: candidate.provider.id,
    providerName: candidate.provider.name,
    offerId: candidate.offer?.id ?? null,
    modelKey: inv.normalizeModelKey(model),
    model,
  }
  const signal = buildFaultSignal({
    kind: 'empty-turn',
    level: verdict.level,
    scope,
    reason: verdict.reason,
    suggested: verdict.suggested,
    hits,
    // notice 也建信号：诊断页要看得见「发生过但没影响你」。
    // 它不会广播（publishFault 里按 level 拦），只是落库留痕
    detail: { ...detail, windowMs: FAULT_WINDOW_MS, recovered },
  })
  queueFaultSignal(signal)
  return verdict.broadcast ? signal : null
}

/**
 * 「最近 5 分钟内，这条供给空了几次」的滑动窗口。
 *
 * 为什么放内存而不是查库：这是热路径上的判断，查库要么读盘要么多一次聚合；
 * 而且进程重启后窗口本来就该清空——重启前的「连续 3 次」说明不了重启后还会继续。
 * 上限 500 条，超出丢最旧的，一个永远涨不上去的环形缓冲。
 */
const emptyHitWindow = []
const EMPTY_HIT_WINDOW_MAX = 500

function countEmptyHits({ providerId = null, modelKey = null, now = Date.now() } = {}) {
  const since = now - FAULT_WINDOW_MS
  let hits = 0
  for (const hit of emptyHitWindow) {
    if (hit.at < since) continue
    if (hit.providerId !== providerId) continue
    if (modelKey && hit.modelKey && hit.modelKey !== modelKey) continue
    hits += 1
  }
  return hits + 1 // 含本次
}

/** 记一次空回合命中（补问成功、本地重建都算——它确实是空回合） */
function noteEmptyHit({ providerId = null, modelKey = null }) {
  const now = Date.now()
  emptyHitWindow.push({ at: now, providerId, modelKey })
  // 顺手把过期的剪掉，窗口不涨
  const since = now - FAULT_WINDOW_MS
  while (emptyHitWindow.length > 0 && emptyHitWindow[0].at < since) emptyHitWindow.shift()
  while (emptyHitWindow.length > EMPTY_HIT_WINDOW_MAX) emptyHitWindow.shift()
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
    if (emptyTimer) {
      clearTimeout(emptyTimer)
      emptyTimer = null
    }
    if (emptyBuffer.length > 0) {
      const batch = emptyBuffer.splice(0, emptyBuffer.length)
      await inv.recordEmptyBatch(batch)
    }
    if (faultTimer) {
      clearTimeout(faultTimer)
      faultTimer = null
    }
    if (faultBuffer.length > 0) {
      const batch = faultBuffer.splice(0, faultBuffer.length)
      await inv.recordFaultBatch(batch)
    }
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
 * 一次上游尝试：发请求、读流、把正文/工具调用写给客户端，但**不收尾**。
 *
 * 收尾为什么留给调用方：空回合守卫要能在「这一轮其实什么都没说」时反悔，而
 * finish_reason / `[DONE]` / response.completed 一旦发给客户端，这一轮就算结束了，
 * 后面补的回答会被当成多余的东西丢掉。所以终端块先扣在手里（terminal），
 * 由 forwardToUpstream 判完再决定发不发。
 *
 * resume=true 表示这是一次「接在前一次后面」的补问：响应头早就发出去了，
 * 所以不再 writeHead，并且这次产生的思考增量必须丢掉（否则客户端会看到
 * 两段一模一样的思考，比空回合更让人看不懂）。
 */
async function streamAttempt({
  candidate,
  body,
  res,
  attemptIndex,
  pool = 'paid',
  clientSignal = null,
  protocol = 'chat',
  resume = false,
}) {
  const apiKey = await inv.revealSecret(candidate.credential.id)
  if (!apiKey) return { error: 'Key 解密失败', committed: resume }

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
  const touch = (ms = STREAM_IDLE_MS) => armTimer(ms)
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
      return { committed: resume, error: `上游 ${STREAM_IDLE_MS / 1000} 秒无响应（首字超时）` }
    }
    return { committed: resume, error: `连接失败：${error.message}` }
  }

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text().catch(() => '')
    cleanup()
    return { committed: resume, error: `HTTP ${upstreamRes.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}` }
  }

  if (!isStream) {
    let payload
    try {
      payload = await upstreamRes.json()
    } catch {
      cleanup()
      return { committed: resume, error: '上游返回的不是 JSON' }
    }
    cleanup()
    // 协议差异收在 wire.js 里：Responses 的 error / status:"failed" /
    // usage 字段改名都在那边处理，这里只消费归一化结果
    const extracted = extractNonStream(protocol, payload)
    if (extracted.error) return { committed: resume, error: extracted.error }
    return {
      payload,
      committed: resume,
      usage: extracted.usage || null,
      ttftMs: null,
      realCheck: extracted.realCheck,
      // 非流式由调用方决定要不要落盘（可能要重试）
      needsWrite: !resume,
    }
  }

  const headers = {
    'X-ManageAPI-Provider': encodeURIComponent(candidate.provider.name),
    'X-ManageAPI-Attempts': String(attemptIndex + 1),
    'X-ManageAPI-Quality': candidate.quality === null ? 'unknown' : candidate.quality.toFixed(2),
    // 这次到底是免费池、付费池，还是免费池不够用后回落到的付费池——
    // 回落是显式开关（settings.allowPaidFallback），但客户端仍应能看出来
    'X-ManageAPI-Pool': pool || 'paid',
  }

  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let committed = resume
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
  // 终端块（finish_reason / [DONE] / response.completed）先扣住，见函数头注释
  const terminal = []

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
          return { committed: false, error: inspected.error, terminal }
        }
        if (inspected.drop) continue

        // 终端块扣在手里：这一轮是不是空的，要等流结束才判得出来
        if (isTerminalChunk(protocol, parsed, payloadText)) {
          terminal.push(raw)
          continue
        }

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

        // 补问时丢掉思考增量：第一次尝试的思考已经流给客户端了，再来一遍是重复
        const forwarded = resume ? rewriteAppendedChunk(protocol, raw, parsed) : raw
        if (forwarded === null) continue

        commit()
        if (heldChunks.length > 0) {
          const held = heldChunks.join('')
          heldChunks.length = 0
          await push(held)
        }
        await push(forwarded)
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

    cleanup()
    const { usage, contentChars, textChars, reasoningChars, hasToolCalls, finishReason, textTail } = inspector.state
    return {
      committed,
      usage: usage || null,
      ttftMs,
      terminal,
      realCheck: {
        contentChars,
        textChars,
        reasoningChars,
        textTail,
        hasToolCalls,
        finishReason,
        promptTokens: usage?.prompt_tokens ?? null,
      },
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    cleanup()
    const reason = idleTimedOut ? `上游流中断（${STREAM_IDLE_MS / 1000} 秒无数据）` : error.message
    const { usage, contentChars, textChars, reasoningChars, hasToolCalls, finishReason, textTail } = inspector.state
    return {
      committed,
      usage: usage || null,
      ttftMs,
      terminal,
      streamError: reason,
      realCheck: {
        contentChars,
        textChars,
        reasoningChars,
        textTail,
        hasToolCalls,
        finishReason,
        promptTokens: usage?.prompt_tokens ?? null,
      },
    }
  }
}

/**
 * 补问成本估算要的「这家站、这个模型有多快」。
 *
 * 首字用探针/流量测出来的 ttftMs（评分里就有）；生成速度用最近 7 天的真实
 * 用量（usage.json 里按「总耗时 − 首字」算出的 tok/s，见 core/usage.js）。
 * 两个都拿不到就返回 null，由 estimateRetryCost 用兜底值——宁可估慢一点。
 */
async function speedFor(candidate) {
  const ttftMs = Number(candidate?.ttftMs) || null
  let tps = null
  try {
    const summary = await usageSummary({ days: 7 })
    const row = summary?.byProvider?.[candidate.provider.id]
    if (row && Number(row.avgTps) > 0) tps = Number(row.avgTps)
  } catch {
    /* 用量文件读不出来就按兜底速度估，不影响主流程 */
  }
  return { ttftMs, tps }
}

/**
 * 把请求转给某个候选站，并在「空回合」时按档位自动补问一次。
 *
 * 空回合守卫的完整链路：
 *   1. 一次尝试没吐出任何正文和工具调用（或中途断流且还没吐出东西）
 *   2. 按这一轮的思考量 + 该站实测速度，估算「再问一遍要多久」
 *   3. 越贵补得越少（RETRY_TIERS）；同一个站 5 分钟内已经空过 2 次就不再问它
 *   4. mode='same' 就同站再问；mode='switch' 就换一家最像的（价格、速度最近）
 *   5. 每次空回合都落一条记录，界面上能看到「发生过、怎么处置的」
 *
 * 所有判断都收在 core/empty-guard.js，这里只负责按计划执行。
 */
async function forwardToUpstream({
  candidate,
  body,
  res,
  attemptIndex,
  pool = 'paid',
  clientSignal = null,
  protocol = 'chat',
  hooks = null,
}) {
  const requestHasTools = Array.isArray(body?.tools) && body.tools.length > 0
  let current = candidate
  let resume = false
  let tries = 0

  // 保底：不论走哪条分支，最后都要把收尾块发出去（否则客户端会一直等）
  const finish = (outcome) => {
    if (outcome.terminal?.length && !res.writableEnded) {
      for (const raw of outcome.terminal) {
        try {
          res.write(raw)
        } catch {
          break
        }
      }
    }
    if (!res.writableEnded) res.end()
    return outcome
  }

  while (true) {
    tries += 1
    const attemptStarted = Date.now()
    const outcome = await streamAttempt({
      candidate: current,
      body,
      res,
      attemptIndex,
      pool,
      clientSignal,
      protocol,
      resume,
    })

    // 连接层/HTTP 层失败：不 commit 的照旧让上层换站；已 commit 的只能收尾
    if (outcome.error) {
      if (outcome.committed) return finish(outcome)
      return outcome
    }

    // 非流式：内容已经完整拿到，直接落盘（重试只在流式里做——非流式一次就
    // 拿到全部内容，判空后重发的成本比流式高得多，而且这种病是流式专属）
    if (outcome.needsWrite) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-ManageAPI-Provider': encodeURIComponent(current.provider.name),
        'X-ManageAPI-Attempts': String(attemptIndex + 1),
        'X-ManageAPI-Pool': pool || 'paid',
      })
      res.end(JSON.stringify(outcome.payload))
      if (hooks?.onEmpty && judgeEmptyTurn({ ...outcome.realCheck, requestHasTools }).empty) {
        hooks.onEmpty({
          candidate: current,
          facts: { ...outcome.realCheck, requestHasTools },
          action: 'off',
          attempts: tries,
          wastedMs: Date.now() - attemptStarted,
          usage: outcome.usage,
        })
      }
      // 已经 writeHead + end 了，这一单就算交付给客户端了。
      // 不标 committed 的话外层会把「成功」当失败、继续推进下一个候选，
      // 第二个候选写头时抛 Cannot write headers，客户端却早就拿到了正文——
      // 结果就是路由日志记整单失败、供给被记假失败、还白打一整条候选链。
      return { ...outcome, needsWrite: false, committed: true }
    }

    // 这次到底有没有真的吐出东西（正文 / 工具调用）。只有「什么都没吐」才允许补问：
    // 已经说了一半再重来会让客户端读到两段重复的话
    const facts = { ...outcome.realCheck, requestHasTools }
    const forwardedContent = (outcome.realCheck?.textChars || 0) > 0 || Boolean(outcome.realCheck?.hasToolCalls)
    const verdict = judgeEmptyTurn(facts)
    const broken = Boolean(outcome.streamError)

    // 先试「本地重建」：上游只是把工具调用标记漏进了正文/思考，那玩意儿就在
    // 我们手里，自己拼回去就行——零延迟、零成本，比再问模型一遍好得多。
    //
    // 触发条件只看三件事：带了 tools、上游没回 tool_calls、文本里认得出标记。
    // **不看正文空不空**——标记漏进正文时正文当然不空，那时更需要重建；
    // 「正文必须为空」是补问的限制（怕话说到一半重来），重建不适用，
    // 它是把收尾换成 tool_calls，而不是往已有内容后面追加
    if (requestHasTools && !outcome.realCheck?.hasToolCalls) {
      const allowedToolNames = (Array.isArray(body?.tools) ? body.tools : [])
        .map((tool) => tool?.function?.name || tool?.name)
        .filter(Boolean)
      const repair = repairToolCalls(outcome.realCheck?.textTail || '', { allowedToolNames })
      if (repair.calls.length > 0) {
        // Responses 的收尾事件要带上补齐后的 output，从扣住的终端块里取原文
        let terminalEvent = null
        if (protocol === 'responses') {
          for (const raw of outcome.terminal || []) {
            const line = raw.split(/\r?\n/).find((l) => l.trim().startsWith('data:'))
            if (!line) continue
            try {
              const parsed = JSON.parse(line.trim().slice(5).trim())
              if (parsed?.type === 'response.completed') terminalEvent = parsed
            } catch {
              /* 不是 JSON 就算了，下面会自己造一个最小的收尾 */
            }
          }
        }
        const chunks = buildRepairChunks(protocol, repair.calls, { terminal: terminalEvent })
        if (chunks.length > 0) {
          // 扣住的终端块作废：它说的是 stop，我们要发的是 tool_calls
          outcome.terminal = []
          if (!res.writableEnded) {
            for (const chunk of chunks) {
              try {
                res.write(chunk)
              } catch {
                break
              }
            }
          }
          hooks?.onRepaired?.({
            candidate: current,
            facts,
            format: repair.format,
            calls: repair.calls,
            attempts: tries,
            wastedMs: Date.now() - attemptStarted,
            usage: outcome.usage,
          })
          const repaired = {
            ...outcome,
            committed: true,
            terminal: [],
            realCheck: { ...outcome.realCheck, hasToolCalls: true },
          }
          if (!res.writableEnded) res.end()
          return repaired
        }
      }
      // 认出了标记但解析不了：记一笔，让用户知道「这种方言还不支持」，
      // 然后照常走补问——不猜、不瞎拼
      if (repair.sawMarker) {
        hooks?.onRepairFailed?.({
          candidate: current,
          facts,
          rejected: repair.rejected,
          attempts: tries,
        })
      }
    }


    // 补问之后拿到内容了：告诉调用方「刚才那些空回合已经救回来了」
    if ((forwardedContent || (tries > 1 && !verdict.empty)) && tries > 1) {
      hooks?.onRecovered?.({ by: current.provider.name, candidate: current })
    }

    // 正常结束（有内容，或本来就不是空回合）：收尾
    if (!verdict.empty || forwardedContent) {
      if (broken) {
        // 断流但已经吐过正文：无从补救，只能如实收尾并让上层记一次失败
        return finish({ ...outcome, streamError: outcome.streamError })
      }
      return finish(outcome)
    }

    // ---- 到这里：这一轮等于什么都没说（断流也算，只要还没吐过东西）----

    const plan = hooks?.plan
      ? await hooks.plan({ facts, candidate: current, attemptStarted, tries, broken })
      : { retries: 0, waitMs: 0, reason: 'disabled' }

    const canRetry = plan.retries > 0 && tries <= plan.retries && !clientSignal?.aborted
    const nextCandidate = canRetry && hooks?.pickFallback ? hooks.pickFallback(current) : null

    // 不补问（守卫关着 / 这活太贵 / 没别家可换）：如实收尾并记账
    if (!canRetry || (plan.reason !== 'same' && !nextCandidate)) {
      if (!outcome.committed) {
        // 一个字节都没发出去：交回上层走普通的「换站」流程，客户端看不到这次废调用
        return {
          ...outcome,
          emptyTurn: true,
          error: broken
            ? `空回合：${outcome.streamError}，且没有正文与工具调用`
            : '空回合：上游没有返回正文，也没有工具调用',
        }
      }
      hooks?.onEmpty?.({
        candidate: current,
        facts,
        action: plan.retries > 0 && !nextCandidate ? 'no-retry' : plan.reason === 'disabled' ? 'off' : 'gave-up',
        attempts: tries,
        wastedMs: Date.now() - attemptStarted,
        usage: outcome.usage,
      })
      return finish(outcome)
    }

    // ---- 补问 ----
    const target = plan.reason === 'same' ? current : nextCandidate
    hooks?.onEmpty?.({
      candidate: current,
      facts,
      action: plan.reason === 'same' ? 'retry-same' : 'retry-switch',
      attempts: tries,
      wastedMs: Date.now() - attemptStarted,
      usage: outcome.usage,
      retryTo: target?.provider?.name || '',
      plan,
    })
    // 换站才建改道账：同站补问是「临时问一句」，不改路由
    if (plan.reason === 'switch' && hooks?.onDetour) {
      hooks.onDetour({ from: current, to: target, plan })
    }
    current = target || current
    // 流已经提交过，第二次就是「接着往后写」——思考要过滤，收尾沿用上一次的位置
    resume = Boolean(outcome.committed)
    // 上一次扣着的收尾块作废（这一轮还没结束）
    if (plan.waitMs > 0) {
      // 补问也要有上限：太慢的站不能无限等，见 RETRY_TIERS 的 waitMs
      setTimeout(() => {
        if (!res.writableEnded) {
          try {
            res.end()
          } catch {
            /* 已经断了 */
          }
        }
      }, plan.waitMs).unref?.()
    }
  }
}
/**
 * 故障研判 + 上报（网关请求结束后异步跑，绝不阻塞用户）。
 *
 * 三道门：
 *   1. assessRequestImpact —— 用户到底受没受影响（无感的不许上报）
 *   2. shouldEscalate     —— 降质要攒够次数、且冷却期内不重复
 *   3. reportFault         —— 推给自动路由，失败只记账不抛错
 *
 * 和空回合守卫的关系（两边不重复干活）：
 *   空回合守卫负责「这一轮空了，能不能自己救回来」（本地重建 / 补问 / 改道）；
 *   救回来了它只落 notice，不进路由视野（见 core/fault-signal.js 的规矩）。
 *   本函数只处理「守卫没教回来 / 本来就不是空回合」的其余失败：断流、全候选失败。
 *   也就是：能救的它救，救不了的才轮到上报自动路由。
 */
async function handleFaultSignals({
  offerId = null,
  modelKey = null,
  attemptCount = 1,
  outcome = 'ok',
  deliveredChars = 0,
  degradation = null,
  streamError = null,
} = {}) {
  const impact = assessRequestImpact({ outcome, attempts: attemptCount, deliveredChars, degradation })
  // 用户完全无感且没换过站：什么都不记（不然每单都写库）
  if (impact.impact === IMPACT.NONE && attemptCount <= 1) return

  try {
    const db = await store.readDb()
    const history = (db.faultEvents || [])
      .filter((e) => e.offerId === offerId && e.impact && e.status !== 'sent')
      .slice(-20)

    const { escalate, reason } = shouldEscalate({
      impact,
      history,
      alreadyReported: faultReporter.recentlyReported(db.faultEvents || [], {
        offerId,
        modelKey,
        kind: faultKindOf(impact),
      }),
    })

    if (!escalate) {
      // 截流/未达门槛：只记一笔（诊断页能看到「截了多少次、为什么没报」）
      await faultReporter.recordFaultEvent({
        offerId,
        modelKey,
        kind: faultKindOf(impact),
        impact: impact.impact,
        impactReason: impact.reason,
        status: 'absorbed',
        detail: `${reason}${streamError ? ` · ${String(streamError).slice(0, 80)}` : ''}`,
        attempts: attemptCount,
        deliveredChars,
      })
      return
    }

    await faultReporter.reportFault({
      offerId,
      modelKey,
      kind: faultKindOf(impact),
      message: `${impact.reason || '故障'}：${impact.detail || ''}${reason ? `（${reason}）` : ''}`.slice(0, 200),
      holdMinutes: holdMinutesFor(impact),
      impact,
    })
  } catch {
    // 故障处理链自身出错绝不能影响用户请求——静默吞掉（事件账里无记录）
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

  // 自动路由接管：开关开着且不是免费入口时，无视客户端要的模型，
  // 改派当前决策档位下全场最优的那个（口径与迟滞规则见 core/auto-route.js）。
  // 免费入口不接管：把免费请求偷偷改派到付费模型等于静默扣钱。
  // 全场连一个能登场的模型都没有时不动（pick 为 null），按原模型走正常报错，
  // admissionFailure 的人话文案比这里现编的准。
  let autoRoutePick = null
  let model = parsed.model
  if (!isFree && normalizeAutoRoute(db.settings.autoRoute).enabled) {
    autoRoutePick = pickAutoRoute(db, { scores, benchmarks })
    if (autoRoutePick) {
      model = autoRoutePick.modelKey
      // 换了模型才落盘：热路径拿到的是共享缓存对象，不能写；
      // mutate 失败只影响「正在使用」的显示，不能拦住这一单，所以只记日志
      if (autoRoutePick.switched) {
        store
          .mutate((latest) => {
            applyAutoRoutePick(latest.settings, autoRoutePick)
          })
          .catch((error) => console.error('[auto-route] 落盘失败:', error.message))
      }
    }
  }

  // 手动排序键是身份键（合并后一组共用一个键）。自动路由接管后 model 可能已被改派，
  // 所以要在接管之后再取；老数据里可能还存着 normalizeModelKey 时代的键，兜一次
  const manualOrder =
    db.manualOrder?.[inv.modelIdentityKey(model, db.settings?.modelAliases || {})] ||
    db.manualOrder?.[inv.normalizeModelKey(model)] ||
    null
  // 外部监控上报的真实故障：降级不拉黑（探针准入不受影响），但自动路由不把它当最优
  const isFaulted = faultMatcher(db.failover)
  // 临时改道的站：空回合守卫把它挂起了，流量应该已经走别家。
  // 和上面的 isFaulted 是两条独立证据来源（外部上报 vs 本机自己抓到的），
  // 两者都成立时按更严重的处理——这里各传各的，判定在 selectCandidates 里合并
  ensureDetours(db)
  const detours = activeDetours(db)
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
      isFaulted,
      detours,
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
      const available = listPublicModels({ offers: split.free, scores, settings: db.settings }).map((m) => m.id)
      return openaiError(
        res,
        404,
        `免费池里没有 ${model}。免费模型：${available.slice(0, 20).join(', ') || '（无，去「免费」页看看）'}`,
        'model_not_in_free_pool',
      )
    }
  }

  if (candidates.length === 0) {
    const available = listPublicModels({ offers: split.paid, scores, settings: db.settings }).map((m) => m.id)
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
  // 候选链 = 准入的在前 + 绝境兜底的在后（见 core/router.js#candidateChain）。
  // 兜底只收「慢速但真实成功率过得去」的：给错结果比不给更糟，
  // 所以降智/指纹不符/不稳定一律不兜底。
  const chain = candidateChain(candidates)
  const admitted = chain.admitted
  if (admitted.length === 0 && chain.lastResort.length === 0) {
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
  // 准入候选排前面，全部失败后才轮到兜底的慢速供给。
  // 用户宁可多等几秒，也不想看到报错——这是「不影响心流」的底线。
  candidates = admitted.length > 0 ? [...admitted, ...chain.lastResort] : chain.lastResort
  // 人工勾选 > 一切自动排序：决策页点选的那条顶到尝试链最前（与决策页「当前选」
  // 同一份口径，见 core/router.js#applyPinnedChoice）；哪怕准入没放行也算数——
  // 这是人的明确指定，真发失败了照样沿候选链往后故障转移。
  // 键与手动顺序同口径：身份键，老数据兜一次 normalizeModelKey 时代的键
  const pinnedOfferId =
    db.pinnedOffer?.[inv.modelIdentityKey(model, db.settings?.modelAliases || {})] ||
    db.pinnedOffer?.[inv.normalizeModelKey(model)] ||
    null
  candidates = applyPinnedChoice(candidates, pinnedOfferId).candidates

  const started = Date.now()
  const failures = []
  // 请求规模估算（只用于「计费是否明显虚报」的量级判断，不追求精确）
  const requestTokens = estimateRequestTokens(body)
  // 本次请求碰到的空回合（可能多条）：补问成功了要把它们改成「救回来了」，
  // 所以先攒着不立即落盘（见 hooks.onEmpty 与 hooks.onRecovered）
  const pendingEmpties = []

  // ---- 空回合守卫 ----
  // 配置与判定口径全部收在 core/empty-guard.js：这里只组装三个回调，
  // 回答「这次补问贵不贵」「补问打哪家」「怎么记账」。
  const emptyGuard = normalizeEmptyGuard(db.settings.emptyGuard)
  const recentEmpties = db.emptyTurns || []

  // 候选推进改成显式游标：守卫换站补问也要往前走同一根游标，
  // 否则外层循环会把已经试过的站再试一遍
  let cursor = 0

  while (cursor < candidates.length) {
    const index = cursor
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
        hooks: {
          // 估算这次补问要多久 → 查档位 → 越贵补得越少（RETRY_TIERS）
          plan: async ({ facts, candidate: current }) => {
            if (!emptyGuard.enabled) return { retries: 0, waitMs: 0, reason: 'disabled' }
            const speed = await speedFor(current)
            const cost = estimateRetryCost({
              reasoningChars: facts.reasoningChars,
              textChars: facts.textChars,
              ttftMs: speed.ttftMs,
              tps: speed.tps,
            })
            // 这个站 5 分钟内已经空过几次：必然犯病的站不再耗时间
            const hits = recentEmptyHits(recentEmpties, {
              providerId: current.provider.id,
              model,
            })
            const stale = hits >= STALE_HITS
            const base = planEmptyRetry({ estimatedMs: cost.estimatedMs, staleProvider: stale })
            // 用户选了「换一家」，或者这站已经连着空——都换成换站模式
            const reason = emptyGuard.mode === 'switch' || stale ? 'switch' : 'same'
            return { ...base, reason, retries: Math.max(reason === 'switch' ? 1 : 0, base.retries), estimatedMs: cost.estimatedMs }
          },
          // 换一家：在已经过了准入的候选里，挑价格与速度最接近的（见 empty-guard）
          pickFallback: (current) => {
            const closest = pickClosestCandidate(candidates, {
              offerId: current.offer.id,
              priceUsd: current.priceUsd,
              ttftMs: current.ttftMs,
            })
            if (!closest) return null
            const at = candidates.indexOf(closest)
            if (at > cursor) cursor = at
            return closest
          },
          // 每次空回合都落一条：不管救回来没有，用户都要能回头看
          onEmpty: (info) => {
            const event = buildEmptyEvent({
              model,
              protocol,
              stream: body.stream === true,
              facts: info.facts,
              providerId: info.candidate.provider.id,
              providerName: info.candidate.provider.name,
              offerId: info.candidate.offer.id,
              group: info.candidate.offer.group || '',
              action: info.action,
              recovered: false,
              attempts: info.attempts,
              wastedMs: info.wastedMs,
              usage: info.usage,
            })
            // 还在尝试补问的先挂着：成功后要标「救回来了」
            if (info.action === 'retry-same' || info.action === 'retry-switch') {
              pendingEmpties.push(event)
              return
            }
            queueEmptyEvent(event)
            // 只有「真的没救回来」才升级成故障信号：
            //   off       守卫关着 → 客户端确实断了一轮，算 degraded
            //   gave-up   补问也空 → degraded
            //   no-retry  没别家可换 → degraded
            //   retry-*   还在试，等 onRecovered 定性，这里不发
            if (info.action === 'off' || info.action === 'gave-up' || info.action === 'no-retry') {
              noteEmptyHit({
                providerId: info.candidate.provider.id,
                modelKey: inv.normalizeModelKey(model),
              })
              reportEmptyFault({
                candidate: info.candidate,
                model,
                recovered: false,
                hadFallback: info.action !== 'no-retry',
                detail: { action: info.action },
              })
            }
          },
          // 本地重建成功：不用问模型，标记就在我们手里。记一条 action=repaired
          onRepaired: (info) => {
            queueEmptyEvent(
              buildEmptyEvent({
                model,
                protocol,
                stream: body.stream === true,
                facts: info.facts,
                providerId: info.candidate.provider.id,
                providerName: info.candidate.provider.name,
                offerId: info.candidate.offer.id,
                group: info.candidate.offer.group || '',
                action: 'repaired-local',
                recovered: true,
                recoveredBy: `${info.format}（本地解析）`,
                attempts: info.attempts,
                wastedMs: info.wastedMs,
                usage: info.usage,
              }),
            )
            noteEmptyHit({ providerId: info.candidate.provider.id, modelKey: inv.normalizeModelKey(model) })
            reportEmptyFault({
              candidate: info.candidate,
              model,
              recovered: true,
              detail: { action: 'repaired-local', format: info.format },
            })
          },
          // 认出了标记但解析不了：记一笔「这种方言还不支持」，然后走补问
          onRepairFailed: (info) => {
            queueEmptyEvent(
              buildEmptyEvent({
                model,
                protocol,
                stream: body.stream === true,
                facts: info.facts,
                providerId: info.candidate.provider.id,
                providerName: info.candidate.provider.name,
                offerId: info.candidate.offer.id,
                group: info.candidate.offer.group || '',
                action: 'repair-failed',
                recovered: false,
                recoveredBy: '',
                attempts: info.attempts,
                note: info.rejected || 'unknown-format',
              }),
            )
          },
          // 补问成功：把刚才那几条挂着的标成已救回，再落盘
          onRecovered: ({ by, candidate: recoveredFrom }) => {
            if (recoveredFrom) {
              noteEmptyHit({
                providerId: recoveredFrom.provider.id,
                modelKey: inv.normalizeModelKey(model),
              })
              reportEmptyFault({
                candidate: recoveredFrom,
                model,
                recovered: true,
                detail: { action: 'retry', recoveredBy: by || '' },
              })
            }
            for (const event of pendingEmpties.splice(0, pendingEmpties.length)) {
              event.recovered = true
              event.recoveredBy = by || ''
              queueEmptyEvent(event)
            }
          },
          // 换站成功才建改道账：之后 20 分钟内流量先走别家，后台自动复检原站
          onDetour: ({ from, to }) => {
            if (!to) return
            void inv
              .recordEmptyDetour({
                modelKey: inv.normalizeModelKey(model),
                model,
                offerId: from.offer.id,
                providerId: from.provider.id,
                providerName: from.provider.name,
                group: from.offer.group || '',
                replacedByOfferId: to.offer.id,
                replacedByProviderId: to.provider.id,
                replacedByProviderName: to.provider.name,
                reason: 'empty-turn',
                recheckMs: DETOUR_RECHECK_MS,
              })
              .catch(() => {})
          },
        },
      })
      if (result.committed) {
        const latencyMs = Date.now() - started
        // 上游 usage → 网关口径（净值 / 缓存读 / 缓存写 / 思考）：只在 wire.js 算一次，
        // 记账、决策日志、详细用量页全部吃这一份，否则三处各写一份取值顺序必然漂移
        const numbers = usageNumbers(result.usage)
        queueRouting({
          model,
          pool,
          // 接管标记：路由日志里能看出这一单是被自动路由改派的，
          // 而不是客户端真的点名了这个模型
          autoRoute: autoRoutePick ? { reason: autoRoutePick.reason } : null,
          keyId: keyRecord?.id ?? null,
          keyName: keyRecord?.name ?? null,
          chosenOfferId: candidate.offer.id,
          chosenProviderId: candidate.offer.providerId,
          chosenProviderName: candidate.provider.name,
          upstreamModel: candidate.offer.upstreamName,
          chosenGroup: candidate.offer.group || '',
          // 这一单是不是走了「绝境兜底」（准入没过但慢速可用）。
          // 排查时能区分「正常选站」与「实在没人了才用慢站」。
          lastResort: Boolean(candidate.lastResort),
          attempts: index + 1,
          outcome: result.streamError ? 'stream-broken' : 'ok',
          latencyMs,
          ttftMs: result.ttftMs ?? null,
          // 协议 / 是否流式：详细用量页要能解释「为什么这条没有首字/没有速度」
          protocol,
          stream: body.stream === true,
          usage: result.usage || null,
          candidates: explain(allCandidates),
          failures,
        })
        await recordUsage({
          keyId: keyRecord?.id ?? '-',
          providerId: candidate.offer.providerId,
          // 分组进聚合键：详细用量的「按分组」小计要从全量聚合算，不从日志窗口算
          group: candidate.offer.group || '',
          model: candidate.offer.modelKey || candidate.offer.upstreamName,
          inputTokens: numbers?.input,
          outputTokens: numbers?.output,
          cachedTokens: numbers?.cached,
          cacheCreationTokens: numbers?.cacheCreation,
          reasoningTokens: numbers?.reasoning,
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
              // 与 usage 记账同一份归一化结果（上游别名很多，别在这里另写一遍）
              reportedCached: numbers?.cached ?? 0,
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
        // 故障研判：判定用户到底受没受影响，真影响才上报自动路由。
        // 不 await：用户已经拿到响应了，绝不能让它等故障处理。
        //
        // 注意与空回合守卫的分工：「这一轮空了但救回来了」由守卫自己落 notice，
        // 不进路由视野；这里只看剩下的——换站次数（截流了几次）与断流吐了多少字。
        void handleFaultSignals({
          offerId: candidate.offer.id,
          modelKey: candidate.offer.modelKey || null,
          attemptCount: index + 1,
          outcome: result.streamError ? 'stream-broken' : 'ok',
          deliveredChars: result.realCheck?.textChars || 0,
          streamError: result.streamError || null,
        })
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
    // 游标手动推进：补问可能已经把 cursor 推到后面那家（pickFallback），
    // 再 ++ 一次就自然跳过已经用过的候选
    cursor += 1
  }

  queueRouting({
    model,
    pool,
    // 整单失败也要记「被自动路由改派过」：否则排查时分不清客户端真的点名了这个模型，
    // 还是冠军被带崩后连带全灭
    autoRoute: autoRoutePick ? { reason: autoRoutePick.reason } : null,
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
  // 故障截流：用户看到的必须是一句中性人话，而不是内部分站报错
  // （「所有候选站都失败了：绿萝: HTTP 403 insufficient balance | 秋: 429…」）。
  // 真实原因全在决策日志 + 错误账本里，排查时一样查得到，但用户端不该被
  // 这类内部信息干扰——尤其是客户端会把整串原文贴给模型或展示给用户时。
  //
  // 和空回合守卫的关系：能走到这里说明守卫也没救回来（它会把没提交的空回合
  // 交回上层换站，全部换完才落这里）。所以这里是「真的没拿到东西」，
  // 够得上上报自动路由的级别。
  void handleFaultSignals({
    offerId: failures[0]?.offerId || null,
    modelKey: candidates[0]?.offer?.modelKey || null,
    attemptCount: failures.length,
    outcome: 'failed',
  })
  return openaiError(
    res,
    502,
    '上游暂时不可用，请稍后重试（网关已记录并提供应商）',
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
      const models = listPublicModels({ offers: split.free, scores, settings: db.settings })
      return json(res, 200, {
        object: 'list',
        data: models.map((m) => shape(m, 'manage-api-free')),
      })
    }

    // 付费入口：付费模型 + 带 free/ 前缀的免费模型。
    // 带前缀是有意的——用户在下拉里能看见、能选，且一眼知道走的是免费池。
    const paidModels = listPublicModels({ offers: split.paid, scores, settings: db.settings })
    const freeModels = listPublicModels({ offers: split.free, scores, settings: db.settings })
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
