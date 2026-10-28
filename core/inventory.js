/**
 * 台账层：站点、凭据、模型供给的增删改查。
 * 所有写操作走 mutate()，保证读-改-写原子性。
 */
import { randomUUID, randomBytes } from 'node:crypto'
import {
  readDb,
  mutate,
  encryptSecret,
  decryptSecret,
  normalizeGroup,
  remapManualOrderKeys,
} from './store.js'
// quota.js 只依赖内置类型，不回头 import 本文件，不会形成循环
import { normalizeQuota, resetIfDue, consumeQuota } from './quota.js'
// 登录态编排：凭据解密后调 providers 的登录协议（providers 不回头 import 本文件，无循环）
import * as providers from './providers.js'
import {
  ensureEmptyEvents,
  recordEmptyEvent,
  clearEmptyEvents,
  recordDetour,
  resolveDetour,
  noteDetourCheck,
} from './empty-guard.js'
import {
  ensureFaultSignals,
  recordFaultSignal,
  buildFaultSignal,
  clearFaultSignals,
  activeFaultSignals,
  combineWithDetours,
  summarizeFaultSignals,
} from './fault-signal.js'
// 模型名归一：存储键 / 身份键两套口径都在 model-name.js（零依赖，不会再成环）
import {
  modelBaseKey,
  identityKey,
  SPLIT_PREFIX,
  mergeOverview as modelNamesOverview,
} from './model-name.js'
// 诊断地基：决策日志顺路更新的两份聚合（错误账本 + 供给表现时序）
import { fingerprintError, applyErrorToBook, pruneErrorbook } from './error-fingerprint.js'
import { applyRoutingToStats, pruneOfferStats } from './offer-stats.js'

export function newId(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`
}

export function nowIso() {
  return new Date().toISOString()
}

/**
 * 归一化模型名，用于跨站比对同一个模型（**存储键**口径）。
 * 处理：大小写、空白、`provider/` 前缀、`:free` / `-free` 后缀。
 *
 * 实现搬到 core/model-name.js 的 modelBaseKey：两套口径（存储键 / 身份键）
 * 必须放在一起看才不会各写一遍——这个项目的头号 bug 类型就是「同一个概念
 * 在两处各归一一次，然后漂移」。这里只做转发。
 */
export function normalizeModelKey(name) {
  return modelBaseKey(name)
}

/**
 * 身份键：判断「两个名字是不是同一个模型」。
 * 在存储键之上再抹平 4-5 ↔ 4.5、v4.1 ↔ 4.1、日期尾巴，以及用户手动的合并/拆开。
 * 只给「比价分组、网关模型清单、占比价用的忽略判定」使用——**不写回 offer.modelKey**，
 * 因为写给上游的模型名必须保持站点原样。
 */
export function modelIdentityKey(name, aliases) {
  return identityKey(name, aliases)
}

/**
 * 归一化分组名。实现放在 store.js（零依赖），这里只做转发，保证：
 * 写入、去重键、匹配、迁移清理**共用同一个口径**。
 * 之前两边各写一份 trim，就是「每轮同步多插一整套重复行」的根源。
 */
export { normalizeGroup }

/** 规范化 baseUrl：去掉尾部斜杠；没写 /v1 时补上（多数中转站都挂在 /v1 下）。 */
export function normalizeBaseUrl(input) {
  let url = String(input ?? '').trim()
  if (!url) throw new Error('baseUrl 不能为空')
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  url = url.replace(/\/+$/, '')
  if (!/\/v\d+$/i.test(url)) url = `${url}/v1`
  return url
}

// ---------------------------------------------------------------- providers

export async function listProviders() {
  const db = await readDb()
  return db.providers
}

export async function createProvider({ name, baseUrl, kind = 'unknown', note = '' }) {
  if (!name || !String(name).trim()) throw new Error('站点名称不能为空')
  const normalized = normalizeBaseUrl(baseUrl)
  return mutate((db) => {
    if (db.providers.some((p) => p.baseUrl === normalized)) {
      throw new Error(`该地址已存在：${normalized}`)
    }
    const provider = {
      id: newId('p'),
      name: String(name).trim(),
      baseUrl: normalized,
      kind,
      note,
      // 排序号：站点卡的顺序（小的在前），新建的排到最后
      sortOrder: db.providers.reduce((max, p) => Math.max(max, Number(p.sortOrder) || 0), 0) + 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    db.providers.push(provider)
    return provider
  })
}

export async function updateProvider(id, patch) {
  // 令牌加密必须在 mutate 外面做——mutate 的回调是同步的
  const encryptedAdmin =
    patch.adminToken === undefined
      ? undefined
      : patch.adminToken
        ? await encryptSecret(String(patch.adminToken).trim())
        : null

  return mutate((db) => {
    const provider = db.providers.find((p) => p.id === id)
    if (!provider) throw new Error(`站点不存在：${id}`)
    if (patch.name !== undefined) provider.name = String(patch.name).trim()
    if (patch.baseUrl !== undefined) provider.baseUrl = normalizeBaseUrl(patch.baseUrl)
    if (patch.kind !== undefined) {
      // 系别白名单：vendor（厂商直连）/ relay（通用中转）/ unknown，
      // 以及自动识别出的三系——识别来源见 kindSource
      const KINDS = ['vendor', 'relay', 'unknown', 'one-api', 'new-api', 'sub2api']
      if (!KINDS.includes(patch.kind)) throw new Error(`未知的站点类型：${patch.kind}`)
      provider.kind = patch.kind
    }
    // kindSource 记录系别来源：auto（探测）/ manual（用户手选）。手填过的不被自动覆盖
    if (patch.kindSource !== undefined) {
      provider.kindSource = patch.kindSource === 'manual' ? 'manual' : 'auto'
    }
    if (patch.note !== undefined) provider.note = patch.note
    // 暂停：站点留在网关里，但不接新请求、不探针、不进比价和决策
    if (patch.paused !== undefined) provider.paused = Boolean(patch.paused)
    // 令牌与余额是站点级的：一个后台账号一套，跟下面挂几个 Key 无关
    if (encryptedAdmin !== undefined) {
      provider.adminToken = encryptedAdmin
      provider.adminTokenTail = encryptedAdmin ? String(patch.adminToken).trim().slice(-6) : null
      // 来源要记：手动填的令牌（'manual'）不被自动续期覆盖；清空时一并清掉
      provider.adminTokenSource = encryptedAdmin ? 'manual' : null
      // 换令牌（包括清空）都把上一次的失效结论清掉，重新判
      provider.tokenStatus = null
      provider.tokenStatusAt = null
    }
    // 站点单价：1 个站点货币单位值多少人民币。只用于「实际消费」展示，
    // 不参与比价/路由/有效成本——内部金钱逻辑保持站点口径不动
    if (patch.unitPrice !== undefined) {
      if (patch.unitPrice === null || patch.unitPrice === '') provider.unitPrice = null
      else {
        const value = Number(patch.unitPrice)
        if (!Number.isFinite(value) || value <= 0) throw new Error('实际花费折算必须是正数')
        provider.unitPrice = value
      }
    }
    if (patch.quotaRemaining !== undefined) {
      provider.quotaRemaining = patch.quotaRemaining === null ? null : Number(patch.quotaRemaining)
      provider.quotaUpdatedAt = nowIso()
    }
    if (patch.currency !== undefined) provider.currency = patch.currency
    if (patch.sortOrder !== undefined) {
      const n = Number(patch.sortOrder)
      if (!Number.isFinite(n)) throw new Error('排序号必须是数字')
      provider.sortOrder = n
    }
    provider.updatedAt = nowIso()
    return provider
  })
}

/**
 * 把一次余额读取的结果写回站点（调用方在 mutate 里传 provider 对象）。
 *
 * 余额和赠金都是账号级的：挂在 Key 上会出现「加第二个 Key 余额显示 0」。
 * 手动读余额、定时采集、令牌失效重登后重试三处共用这一份——
 * remaining / giftBalance / giftExpiry 的口径只在这里定义一次。
 */
export function applyBalanceResult(provider, result, at = nowIso()) {
  if (!provider || !result?.ok) return false
  const remaining = Number(result.remaining)
  if (!Number.isFinite(remaining)) return false
  provider.quotaRemaining = remaining
  if (result.currency) provider.currency = result.currency
  provider.quotaUpdatedAt = at
  // 赠金读不到就清掉：否则上次的赠金会一直挂着，过期后界面还写着「其中赠金 $2」
  const gift = result.giftBalance === null || result.giftBalance === undefined ? NaN : Number(result.giftBalance)
  provider.giftBalance = Number.isFinite(gift) ? gift : null
  provider.giftExpiry = result.giftExpiry || null
  return true
}

/**
 * 按给定的 id 顺序重排站点卡片（拖拽用）。
 * 只调整传进来的这些；没提到的保持原相对位置排在后面。
 */
export async function reorderProviders(ids = []) {
  if (!Array.isArray(ids) || ids.length === 0) return { reordered: 0 }
  return mutate((db) => {
    const rank = new Map(ids.map((id, index) => [String(id), index]))
    const rest = db.providers
      .filter((p) => !rank.has(p.id))
      .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0))
    let next = rank.size
    for (const provider of db.providers) {
      if (rank.has(provider.id)) provider.sortOrder = rank.get(provider.id) + 1
      else provider.sortOrder = ++next
    }
    return { reordered: ids.length, total: db.providers.length, rest: rest.length }
  })
}

/**
 * 记下「站点令牌还能不能用」的结论，卡片上直接标红。
 *
 * ok=true 只在真的拿令牌打通了接口时记；401/403 记 invalid；
 * 网络超时之类不算令牌的错，传 null 表示「这次没结论」，保留上一次的。
 */
export async function setTokenStatus(id, { ok, message = null, status = null } = {}) {
  return mutate((db) => {
    const provider = db.providers.find((p) => p.id === id)
    if (!provider) return null
    if (ok === true) {
      provider.tokenStatus = 'ok'
      provider.tokenStatusAt = nowIso()
      provider.tokenStatusMessage = null
    } else if (ok === false) {
      provider.tokenStatus = 'invalid'
      provider.tokenStatusAt = nowIso()
      provider.tokenStatusMessage = message || (status ? `HTTP ${status}` : '令牌不可用')
    }
    return { tokenStatus: provider.tokenStatus }
  })
}

/** 删掉按 offerId 记的孤儿数据：流量计数与手动排序。routing 是带名字快照的历史日志，刻意保留。 */
function pruneOfferRefs(db, deadOfferIds) {
  if (!deadOfferIds.size) return
  if (db.traffic && typeof db.traffic === 'object') {
    for (const offerId of Object.keys(db.traffic)) {
      if (deadOfferIds.has(offerId)) delete db.traffic[offerId]
    }
  }
  if (db.manualOrder && typeof db.manualOrder === 'object') {
    for (const key of Object.keys(db.manualOrder)) {
      const order = Array.isArray(db.manualOrder[key]) ? db.manualOrder[key] : []
      const left = order.filter((oid) => !deadOfferIds.has(String(oid)))
      if (left.length === 0) delete db.manualOrder[key]
      else if (left.length !== order.length) db.manualOrder[key] = left
    }
  }
}

export async function deleteProvider(id) {
  return mutate((db) => {
    const before = db.providers.length
    db.providers = db.providers.filter((p) => p.id !== id)
    if (db.providers.length === before) throw new Error(`站点不存在：${id}`)
    const deadOfferIds = new Set(
      db.offers.filter((o) => o.providerId === id).map((o) => o.id),
    )
    db.credentials = db.credentials.filter((c) => c.providerId !== id)
    db.offers = db.offers.filter((o) => o.providerId !== id)
    db.probes = db.probes.filter((r) => r.providerId !== id)
    pruneOfferRefs(db, deadOfferIds)
    return { deleted: id }
  })
}

// -------------------------------------------------------------- credentials

export async function createCredential({ providerId, label, secret, group = '', expiresAt = null, groupSource }) {
  if (!secret || !String(secret).trim()) throw new Error('API Key 不能为空')
  const encrypted = await encryptSecret(String(secret).trim())
  return mutate((db) => {
    if (!db.providers.some((p) => p.id === providerId)) throw new Error(`站点不存在：${providerId}`)
    const credential = {
      id: newId('c'),
      providerId,
      label: label || '默认',
      secret: encrypted,
      // 只留尾部四位做识别，避免任何界面回显完整 key
      tail: String(secret).trim().slice(-4),
      // 这把 Key 属于站点的哪个分组——同步模型、探针、路由都按它走
      group: normalizeGroup(group),
      groupSource: groupSource === 'auto' ? 'auto' : undefined,
      expiresAt,
      createdAt: nowIso(),
    }
    db.credentials.push(credential)
    return credential
  })
}

/**
 * 把站点后台令牌列表里的密钥一键导入为本站 Key（幂等）。
 *
 * 去重口径与 matchTokenBySecret 一致：两边都剥掉 sk- 前缀再比完整 key，
 * 撞不上的才建。站点返回的 key 保持原样存——它就是站点要校验的原文，
 * 自作主张补 sk- 反而可能发出站点不认的 Authorization。
 *
 * 分组记 groupSource:'auto'（令牌列表只是线索），用户之后手选分组不会被覆盖。
 *
 * @returns {{imported:number, skipped:number, total:number, labels:string[]}}
 */
export async function importProviderKeys(providerId, items) {
  const list = (Array.isArray(items) ? items : [])
    .map((t) => ({
      name: String(t?.name || '').trim(),
      key: String(t?.key || '').trim(),
      group: normalizeGroup(typeof t?.group === 'string' ? t.group : String(t?.group?.name || '')),
    }))
    .filter((t) => {
      // 掩码值（含星号）和过短残值导进来也同步不了模型，宁可跳过
      return t.key && !t.key.includes('*') && t.key.replace(/^sk-/i, '').length >= 8
    })
  const db = await readDb()
  if (!db.providers.some((p) => p.id === providerId)) throw new Error(`站点不存在：${providerId}`)
  const existing = new Set()
  for (const credential of db.credentials || []) {
    if (credential.providerId !== providerId) continue
    const secret = await decryptSecret(credential.secret)
    existing.add(String(secret).replace(/^sk-/i, '').trim())
  }
  const fresh = list.filter((t) => !existing.has(t.key.replace(/^sk-/i, '').trim()))
  const skipped = list.length - fresh.length
  if (fresh.length === 0) return { imported: 0, skipped, total: list.length, labels: [] }
  // encryptSecret 是异步的，先全部加密完再进同步 mutate，别在回调里 await
  const encrypted = await Promise.all(fresh.map((t) => encryptSecret(t.key)))
  const labels = await mutate((db) => {
    const created = []
    for (let i = 0; i < fresh.length; i += 1) {
      const t = fresh[i]
      db.credentials.push({
        id: newId('c'),
        providerId,
        label: t.name || `站点密钥 ${t.key.slice(-4)}`,
        secret: encrypted[i],
        // 只留尾部四位做识别，避免任何界面回显完整 key
        tail: t.key.slice(-4),
        group: t.group,
        groupSource: 'auto',
        expiresAt: null,
        createdAt: nowIso(),
      })
      created.push(t.name || `站点密钥 ${t.key.slice(-4)}`)
    }
    return created
  })
  return { imported: labels.length, skipped, total: list.length, labels }
}

export async function updateCredential(id, patch) {
  return mutate((db) => {
    const credential = db.credentials.find((c) => c.id === id)
    if (!credential) throw new Error(`凭据不存在：${id}`)
    if (patch.label !== undefined) credential.label = patch.label
    if (patch.group !== undefined) {
      const next = normalizeGroup(patch.group)
      // 归属来源：手选（用户明确指定）优先于自动识别——后台令牌列表识别的
      // 分组只是线索，用户买了哪一档才是商务事实。auto 写入不覆盖 manual。
      const source = patch.groupSource === 'auto' ? 'auto' : 'manual'
      if (source === 'auto' && credential.groupSource === 'manual' && next !== credential.group) {
        // 跳过：保留用户手选
      } else {
        credential.group = next
        credential.groupSource = source
      }
    } else if (patch.groupSource !== undefined) {
      credential.groupSource = patch.groupSource === 'auto' ? 'auto' : 'manual'
    }
    if (patch.expiresAt !== undefined) credential.expiresAt = patch.expiresAt
    return credential
  })
}

/**
 * 取出站点后台令牌（明文）。没有就返回 null。
 *
 * 传 providerId 是正常用法；也接受 credentialId，兼容旧调用与未迁移的数据。
 */
export async function revealAdminToken(providerIdOrCredentialId) {
  const db = await readDb()
  const provider = db.providers.find((p) => p.id === providerIdOrCredentialId)
  if (provider?.adminToken) return decryptSecret(provider.adminToken)
  const credential = db.credentials.find((c) => c.id === providerIdOrCredentialId)
  if (credential?.adminToken) return decryptSecret(credential.adminToken)
  return null
}

export async function deleteCredential(id) {
  return mutate((db) => {
    const before = db.credentials.length
    db.credentials = db.credentials.filter((c) => c.id !== id)
    if (db.credentials.length === before) throw new Error(`凭据不存在：${id}`)
    db.offers = db.offers.filter((o) => o.credentialId !== id)
    return { deleted: id }
  })
}

/** 取出明文 key，仅用于出站请求，绝不返回给前端。 */
export async function revealSecret(credentialId) {
  const db = await readDb()
  const credential = db.credentials.find((c) => c.id === credentialId)
  if (!credential) throw new Error(`凭据不存在：${credentialId}`)
  return decryptSecret(credential.secret)
}

// ------------------------------------------------------------------- offers

/**
 * 被忽略模型的归一化集合。
 *
 * 归一化口径只有这一份：routeableOffers 用它过滤供给，「站点卡分组里的模型」用它打
 * 「已忽略」标记——两边各写一遍 trim/大小写，迟早一边认得出、另一边认不出。
 */
/**
 * 忽略名单的判定集合。
 *
 * 键是**身份键**：同一个模型的不同写法（deepseek-v4.1-flash / deepseek-4.1-flash）
 * 是一个模型，忽略一次必须整组消失，否则用户会看到「忽略了但还在比价里」。
 * 调用方拿模型名来比对时也要走同一个归一（见 modelIdentityKey），
 * 两边口径不一致就会一半生效一半不生效。
 */
export function ignoredModelSet(db) {
  const aliases = db.settings?.modelAliases || {}
  return new Set(
    (db.settings?.ignoredModels || []).map((name) => identityKey(String(name), aliases)),
  )
}

/**
 * 余额探底线（站内额度单位）：余额 ≤ 0.01 视为「没钱了」，不是「快没钱了」。
 *
 * 为什么是主动离场而不是等 403：站点卡读余额就能知道没钱，让路由再拿真实请求
 * 去撞一次 403 是白撞——billingOnly 放行机制（冷却 60 秒后按价格排第一）在
 * 「用户一直不充值」的场景里会让每一单都先吃一个来回的失败。到线把整站供给
 * 拒之门外，充值后（采集 / 手动刷新余额 / 手填）余额回上线，下一轮读取
 * 自动恢复，没有任何要清理的状态。
 *
 * 待遇与「慢速」同款：供给留在候选表里挂红标（准入拒、排序沉底），不是从
 * 数据口删掉——离场是「不派活」，不是「看不见」；「只显示准入通过」一开就隐藏。
 *
 * 余额含赠金（applyBalanceResult 的 remaining 已把赠金算进去），
 * 「本金 0 + 赠金 2」不会被误伤；余额从未读到（null）也不算探底。
 */
export const BALANCE_DEPLETED_BELOW = 0.01

export function balanceDepleted(provider) {
  // null/undefined 是「没读到过」，不是 0：Number(null) === 0 会把从未读余额的站误杀
  const remaining = provider?.quotaRemaining
  if (remaining === null || remaining === undefined) return false
  const n = Number(remaining)
  return Number.isFinite(n) && n <= BALANCE_DEPLETED_BELOW
}

/**
 * 真正「在役」的供给：没下线（delistedAt）、站点没暂停（paused）、模型没被忽略（ignoredModels）。
 * 这是三条过滤规则的唯一实现——比价 / 概览 / 智能决策 / 网关 / 免费池 / 探针目标都从这里取，
 * 任何一侧自己再写一遍迟早漂移（曾出过「暂停站点仍被派流量」「下线模型仍被探测白烧额度」）。
 * 注意：余额探底不在这里过滤——那是准入门禁的事（要挂标、要能被「只显示准入」隐藏），
 * 见 core/router.js#admissionOf；探针/复检的「不撞墙」各自显式跳过。
 * 纯函数：只读 db，不改；调用方拿到的是 db.offers 里的原对象，不要原地修改。
 */
export function routeableOffers(db) {
  const pausedIds = new Set(db.providers.filter((p) => p.paused).map((p) => p.id))
  // 忽略列表按身份键比对（口径唯一实现在 ignoredModelSet，别在这里再拼一份）
  const aliases = db.settings?.modelAliases || {}
  const ignored = ignoredModelSet(db)
  return db.offers.filter((offer) => {
    if (offer.delistedAt) return false
    if (pausedIds.has(offer.providerId)) return false
    if (ignored.size) {
      const key = identityKey(offer.modelKey || offer.upstreamName || '', aliases)
      if (key && ignored.has(key)) return false
    }
    return true
  })
}

/**
 * 把一次拉取到的模型列表合并进台账。
 * 已存在的 upstreamName 保留用户手填的价格与分组，只更新"还在不在"。
 * 分组需要手动维护——大多数站的 /v1/models 不返回分组信息。
 */
export async function syncOffers(providerId, credentialId, models, group = '') {
  return mutate((db) => {
    if (!db.providers.some((p) => p.id === providerId)) throw new Error(`站点不存在：${providerId}`)
    const g = normalizeGroup(group)
    // 按「分组 + 模型名」去重：同一个站的不同分组可以有同名模型。
    // 新旧两边都过 normalizeGroup，历史数据里带空白的行顺手就地收敛
    // （不然它们永远匹配不上新键，每轮同步都再插一份）
    const existing = new Map()
    for (const o of db.offers) {
      if (o.providerId !== providerId) continue
      const name = normalizeGroup(o.group)
      if (name !== (o.group || '')) o.group = name
      const key = `${name}::${o.upstreamName}`
      if (!existing.has(key)) existing.set(key, o)
    }
    let added = 0
    let revived = 0
    for (const upstreamName of models) {
      const dedupeKey = `${g}::${upstreamName}`
      if (existing.has(dedupeKey)) {
        const row = existing.get(dedupeKey)
        row.listedAt = nowIso()
        // 模型回来了就当场摘掉下线标记——「在不在」本来就是本函数的职责，
        // 不能依赖调用方随后再跑一次 markDelisted 才复活（单用其一会出现
        // 「模型明明回来了还显示下线」）
        if (row.delistedAt) {
          delete row.delistedAt
          revived += 1
        }
        continue
      }
      db.offers.push({
        id: newId('o'),
        providerId,
        credentialId: credentialId || null,
        upstreamName,
        modelKey: normalizeModelKey(upstreamName),
        group: g,
        // 没有 supply 字段：付费/免费不落库、每次按「解析后实际价 === 0」现算
        // （free.js 的 isFreeOffer），倍率一改判定立刻跟着变
        inPrice: null,
        outPrice: null,
        ratio: null,
        // siteRatio 是站点公布的原始倍率，导入时写入、只由导入改；
        // ratio 是当前生效值，ratioSource 说明它跟不跟站点一致（site / custom）。
        siteRatio: null,
        ratioSource: null,
        pricingMode: 'manual',
        benchmarkKey: null,
        currency: 'USD',
        priceUnit: 'per_mtok',
        listedAt: nowIso(),
        updatedAt: nowIso(),
      })
      added += 1
    }
    return { added, revived, total: models.length }
  })
}

/**
 * 某把 Key 名下一条供给都没有时，用这把 Key 自己拉一次 /v1/models 把行建出来。
 *
 * 为什么需要：分组是「识别」出来的，模型是「同步」出来的，两件事各管一半。
 * 新加一把 Key、或者站方新开一个分组（旧分组被删了）时，分组名已经记在 Key 上，
 * 但它名下 0 行供给——界面上就是一个「3 个模型也读不到、写着你还没同步」的空分组。
 * 用户看到的是「网关里存了 GM1，但 GM1 里的 Deepseek 读不出来」，而其实一把 Key
 * 就能列出来。所以「选分组」和「识别分组」都要在发现 0 行时补这一次。
 *
 * 有行就不拉：正常换分组只是给现成的行改倍率，不该每次点一下都多走一次网络。
 * 拉模型失败也不算致命——分组先存下来，之后点「一键同步」还能补。
 *
 * @returns {Promise<{imported:number, skipped:boolean, error:string|null}>}
 */
export async function importCredentialModels(provider, credential, group, { timeoutMs = 15000 } = {}) {
  const name = normalizeGroup(group)
  if (!provider?.id || !credential?.id || !name) return { imported: 0, skipped: true, error: null }

  const db = await readDb()
  const ownsOffers = db.offers.some(
    (o) => o.providerId === provider.id && o.credentialId === credential.id,
  )
  if (ownsOffers) return { imported: 0, skipped: true, error: null }

  try {
    const apiKey = await revealSecret(credential.id)
    if (!apiKey) throw new Error('Key 解密失败，可能是 master.key 被替换过')
    const listed = await providers.listModels({ baseUrl: provider.baseUrl, apiKey, timeoutMs })
    const saved = await syncOffers(provider.id, credential.id, listed.models, name)
    return { imported: saved.added, skipped: false, error: null }
  } catch (error) {
    return { imported: 0, skipped: false, error: error.message || String(error) }
  }
}

/**
 * 同一个模型在不同分组下的价格和降智程度可能完全不同
 * （特价池 / Pro 号池 / 企业通道），所以支持复制一条出来单独填。
 */
export async function duplicateOffer(id, { group }) {
  return mutate((db) => {
    const source = db.offers.find((o) => o.id === id)
    if (!source) throw new Error(`模型记录不存在：${id}`)
    const name = normalizeGroup(group)
    if (!name) throw new Error('分组名不能为空')
    const exists = db.offers.some(
      (o) =>
        o.providerId === source.providerId &&
        normalizeGroup(o.group) === name &&
        o.upstreamName === source.upstreamName,
    )
    if (exists) throw new Error(`该站「${name}」分组下已经有同名模型了`)
    // 分组是 Key 的属性：复制到新分组时改挂该组的 Key（没有就留空，
    // 路由会按「同分组 Key」回落到该站的任意 Key）——不能让新行继续
    // 挂着别的分组的 Key，否则分组归属和实际鉴权就脱节了
    const groupCred = db.credentials.find(
      (c) => c.providerId === source.providerId && normalizeGroup(c.group) === name,
    )
    const copy = {
      ...source,
      id: newId('o'),
      group: name,
      credentialId: groupCred?.id ?? null,
      listedAt: nowIso(),
      updatedAt: nowIso(),
    }
    db.offers.push(copy)
    return copy
  })
}

export async function updateOfferPrice(
  id,
  { inPrice, outPrice, currency, priceUnit, ratio, benchmarkKey, pricingMode, group },
) {
  return mutate((db) => {
    const offer = db.offers.find((o) => o.id === id)
    if (!offer) throw new Error(`模型记录不存在：${id}`)
    const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))
    if (inPrice !== undefined) offer.inPrice = num(inPrice)
    if (outPrice !== undefined) offer.outPrice = num(outPrice)
    if (ratio !== undefined) offer.ratio = num(ratio)
    if (benchmarkKey !== undefined) offer.benchmarkKey = benchmarkKey || null
    if (pricingMode !== undefined) offer.pricingMode = pricingMode === 'ratio' ? 'ratio' : 'manual'
    // 只有「真的改了」才算用户手选：值没变不算表态。
    // R.Dollar（RUSD）也允许手选：真遇到按真实美元计价的站用它
    if (currency && currency !== offer.currency) {
      const c = String(currency).toUpperCase()
      offer.currency = c === 'USD' || c === 'CNY' || c === 'RUSD' ? c : 'USD'
      offer.currencySource = 'custom'
    }
    if (priceUnit) offer.priceUnit = priceUnit
    if (group !== undefined) {
      const name = normalizeGroup(group)
      const clash = db.offers.some(
        (o) =>
          o.id !== id &&
          o.providerId === offer.providerId &&
          normalizeGroup(o.group) === name &&
          o.upstreamName === offer.upstreamName,
      )
      if (clash) throw new Error(`该站「${name || '默认'}」分组下已经有同名模型了`)
      offer.group = name
    }
    offer.updatedAt = nowIso()
    return offer
  })
}

export async function deleteOffer(id) {
  return mutate((db) => {
    const before = db.offers.length
    db.offers = db.offers.filter((o) => o.id !== id)
    if (db.offers.length === before) throw new Error(`模型记录不存在：${id}`)
    pruneOfferRefs(db, new Set([id]))
    return { deleted: id }
  })
}

/**
 * 标记「这次同步没再返回」的模型为已下线，而不是直接删。
 *
 * 硬删会把用户手填的价格一起抹掉——万一站点只是暂时抽风，或者你换了分组
 * 又换回来，价格就白填了。所以只打 `delistedAt` 标记，读的时候过滤掉；
 * 下次它再出现，标记清掉、价格还在。
 *
 * 只按 credentialId 处理，不碰别的 Key 的行。分组也参与判断：同一把 Key 换过
 * 分组之后，同名模型可能同时挂在两个分组下，只按 upstreamName 会把
 * 「A 分组还在用、B 分组已下线」的两边一起标记/复活。
 */
export async function markDelisted(providerId, credentialId, keepNames, group = '') {
  const keep = new Set(keepNames)
  // 不传 group 时保持旧行为（按 credentialId 全覆盖），兼容其它调用点
  const wantGroup = group ? normalizeGroup(group) : null
  return mutate((db) => {
    let delisted = 0
    let revived = 0
    for (const offer of db.offers) {
      if (offer.providerId !== providerId) continue
      if (credentialId && offer.credentialId !== credentialId) continue
      if (wantGroup !== null && normalizeGroup(offer.group) !== wantGroup) continue
      const alive = keep.has(offer.upstreamName)
      if (!alive && !offer.delistedAt) {
        offer.delistedAt = nowIso()
        delisted += 1
      } else if (alive && offer.delistedAt) {
        offer.delistedAt = null
        revived += 1
      }
    }
    return { delisted, revived }
  })
}

// --------------------------------------------------------------- 网关凭据

function newGatewayKeyRecord(name) {
  return {
    id: newId('gk'),
    name: String(name || '未命名').trim() || '未命名',
    key: `sk-mapi-${randomBytes(16).toString('hex')}`,
    enabled: true,
    monthlyTokenLimit: null,
    note: '',
    createdAt: nowIso(),
  }
}

/** 确保 keys 结构存在；把老版本的单 key 迁移成数组。 */
export async function ensureGatewayKeys() {
  return mutate((db) => {
    const gateway = db.settings.gateway || {}
    if (!Array.isArray(gateway.keys)) {
      gateway.keys = []
      if (gateway.key) {
        gateway.keys.push({ ...newGatewayKeyRecord('默认 Key'), key: gateway.key })
      }
      delete gateway.key
      delete gateway.createdAt
    }
    if (gateway.keys.length === 0) gateway.keys.push(newGatewayKeyRecord('默认 Key'))
    if (gateway.enabled === undefined) gateway.enabled = true
    db.settings.gateway = gateway
    return gateway
  })
}

/**
 * 月度 token 上限必须是正整数。
 * 之前 Number() 直通，填 -1 会变成「已用 0 >= -1」→ 这把 Key 立刻 429，而且界面上看不出来。
 */
function normalizeTokenLimit(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new Error('月度 token 上限必须是非负数')
  return Math.floor(n)
}

export async function createGatewayKey({ name, monthlyTokenLimit = null, note = '' }) {
  return mutate((db) => {
    const gateway = db.settings.gateway
    if (!gateway?.keys) throw new Error('网关尚未初始化')
    const record = newGatewayKeyRecord(name)
    record.monthlyTokenLimit = normalizeTokenLimit(monthlyTokenLimit)
    record.note = note
    gateway.keys.push(record)
    return record
  })
}

export async function updateGatewayKey(id, patch) {
  return mutate((db) => {
    const record = db.settings.gateway?.keys?.find((k) => k.id === id)
    if (!record) throw new Error(`Key 不存在：${id}`)
    if (patch.name !== undefined) record.name = String(patch.name).trim() || record.name
    if (patch.enabled !== undefined) record.enabled = Boolean(patch.enabled)
    if (patch.note !== undefined) record.note = patch.note
    if (patch.monthlyTokenLimit !== undefined) {
      record.monthlyTokenLimit = normalizeTokenLimit(patch.monthlyTokenLimit)
    }
    return record
  })
}

export async function deleteGatewayKey(id) {
  return mutate((db) => {
    const gateway = db.settings.gateway
    if (!Array.isArray(gateway?.keys)) throw new Error('网关尚未初始化')
    const before = gateway.keys.length
    gateway.keys = gateway.keys.filter((k) => k.id !== id)
    if (gateway.keys.length === before) throw new Error(`Key 不存在：${id}`)
    return { deleted: id }
  })
}

export async function rotateGatewayKey(id) {
  return mutate((db) => {
    const record = db.settings.gateway?.keys?.find((k) => k.id === id)
    if (!record) throw new Error(`Key 不存在：${id}`)
    record.key = `sk-mapi-${randomBytes(16).toString('hex')}`
    record.createdAt = nowIso()
    return record
  })
}

export async function setGatewayEnabled(enabled) {
  return mutate((db) => {
    if (!db.settings.gateway) throw new Error('网关还没初始化')
    db.settings.gateway.enabled = Boolean(enabled)
    return db.settings.gateway
  })
}

/** 按明文 key 找记录，鉴权用。 */
export async function findGatewayKey(value) {
  const db = await readDb()
  return db.settings.gateway?.keys?.find((k) => k.key === value) || null
}

// ------------------------------------------------------------------- probes

/** 探针记录的保留窗口：长期评分用 14 天半衰期，留 30 天足够，再老的数据只是占体积 */
const PROBE_KEEP_DAYS = 30
const PROBE_KEEP_MAX = 5000

/**
 * 探针结果落库，并顺手把「这家现在有问题」翻译成故障信号。
 *
 * 为什么在这里而不是在探针模块里：探针只负责测，测完的结论怎么往上报告是
 * 台账层的事。而且只有台账层知道供给的 providerId / offerId 全貌。
 *
 * 只对**确定的坏证据**发信号（指纹不符 / 输出截断 / 用量虚报 / 明确失败），
 * 「过期」「没证据」不发——那不是站坏了，是我们还没测，报出去会误导路由。
 */
export async function recordProbe(record) {
  return mutate((db) => {
    const entry = {
      id: newId('r'),
      ts: nowIso(),
      ...record,
    }
    db.probes.push(entry)
    // 先按条数截断，再按时间淘汰——只按条数的话，闲时一个月也涨不到 5000，
    // 老记录会一直躺着把 db.json 撑大。
    if (db.probes.length > PROBE_KEEP_MAX) db.probes = db.probes.slice(-PROBE_KEEP_MAX)
    const cutoff = Date.now() - PROBE_KEEP_DAYS * 86400000
    const kept = db.probes.filter((p) => {
      const ts = new Date(p.ts).getTime()
      return !Number.isFinite(ts) || ts >= cutoff
    })
    if (kept.length !== db.probes.length) db.probes = kept

    // 探针结论 → 故障信号（口径见函数头）。只报「确定坏」，不报「还没测」
    const faults = []
    if (record.fingerprintOk === false) faults.push('指纹不符（疑似掉包）')
    if (record.truncated === true) faults.push('输出被截断（疑似砍额度）')
    if (record.billingInflated === true) faults.push('用量虚报')
    if (faults.length > 0) {
      const offer = db.offers.find((o) => o.id === record.offerId)
      const provider = db.providers.find((p) => p.id === record.providerId)
      recordFaultSignal(
        db,
        buildFaultSignal({
          kind: 'integrity',
          level: 'faulty',
          scope: {
            providerId: record.providerId,
            providerName: provider?.name || '',
            offerId: record.offerId,
            modelKey: record.modelKey || offer?.modelKey || null,
            model: offer?.upstreamName || '',
          },
          reason: `探针判定：${faults.join(' · ')}`,
          suggested: 'avoid',
          detail: { probeId: entry.id, faults },
        }),
      )
    } else if (record.ok === true) {
      // 探针这次正常 → 把这条供给之前的完整性故障解掉，
      // 否则一次历史污点会让它永远被避开（探针是定期跑的，它自己会证明恢复）
      clearFaultSignals(db, { offerId: record.offerId })
    }
    return entry
  })
}

export async function listProbes(limit = 100) {
  const db = await readDb()
  return db.probes.slice(-limit).reverse()
}

/**
 * 给某个站的一个分组统一设置倍率。
 *
 * 中转站的倍率是「按分组」定的，不是按模型——所以填一次就该覆盖该分组下所有模型。
 * 单条记录仍可单独改（改完这里会显示「混合」）。
 */
/**
 * 手动改某个分组的倍率。
 *
 * 和「导入倍率」的区别只在于标记：这里写的是 ratioSource = 'custom'，
 * 站点原始值仍然留在 siteRatio 里，随时可以「恢复」。
 */
/**
 * 按站点给的分组价格信息给一条供给落价。apply-group（用户选分组）与
 * detect-groups（后台识别分组）共用——此前两处各写一遍三分支，已经漂移过一次。
 *
 * 三分支（顺序固定）：
 *  1. 站点把模型标成 0 价 → 免费（manual + 双零价）。「免费模型」分组往往倍率
 *     写 1，真正免费体现在原价上，必须先判这条，否则会被「基准价 × 倍率」算回原价。
 *     只认本分组精确命中（exact）——全站同名回落拿到的是别的分组的价格，判免费会误伤。
 *  2. 倍率已知 → 倍率模式：站点原价写进输入框，倍率另存，算钱时再乘。
 *     不依赖广场的绝对价，也不依赖用户先配好基准价。
 *  3. 只有渠道/广场的模型原价、且倍率未知 → 原价 × 1 直接填绝对价（manual）。
 *
 * 重要的口径：**倍率模式下输入框存的是「原价」**，不是最终价。
 * 最终价由 pricing.js 的 resolveOfferPrice 统一算（原价 × 倍率），只有一处。
 * 基准价表的作用是「第一次把输入框填上」，和手输平级，不能反过来盖掉手输值。
 *
 * 只改价格字段，不碰 offer.group——分组归属是调用方的语义（一边按用户选择、
 * 一边按后台识别）。返回落价方式：'free' | 'percall' | 'ratio' | 'manual' | 'skip'
 * （skip = 信息不足，调用方只记分组、价格留给用户填）。
 *
 * groupKnown：调用方保存的分组名在站点分组表里能不能对上。站方改过分组名之后
 * 必然对不上——这时倍率不是「站点没公布」，而是「我们手里的名字过期了」，
 * 必须按 skip 处理（见下面第 4 步）。
 */
/**
 * 这一行的价格该标什么币种——落价的唯一口径，别在别处再判一次。
 *
 * 规则只有两条：
 *   1. 用户手选过（currencySource === 'custom'）→ 听用户的，同步不许改；
 *   2. 没选过 → 美元。
 *
 * 为什么默认美元而不是人民币：实测这些中转站的报价就是美元——绿萝的广场接口
 * 报 gpt-4o 2.5/10、gpt-4o-mini 0.15/0.6、gemini-2.5-flash 0.3/2.5，正好是官方
 * 美元价；站点余额也是美元（provider.currency = USD）。而广场/渠道接口都
 * **不带币种字段**，所以「按站方声明」这条路根本不存在。
 *
 * 以前这里无条件写 'CNY'，等于把美元价当人民币，offerCost 再除以汇率——
 * 比价里便宜 6.68 倍、花费估算也少算 6.68 倍，页面照常渲染不报错。
 * 真遇到按人民币报价的站，用户把币种改成 CNY 就冻住了（规则 1）。
 */
function currencyOf(offer) {
  if (offer.currencySource === 'custom') {
    const c = String(offer.currency || '').toUpperCase()
    // 用户手选过的就保留（含 RUSD）；站点声明永远不会是 RUSD
    if (c === 'CNY' || c === 'RUSD') return c
    return 'USD'
  }
  return 'USD'
}

export function applySitePricing(offer, { exact, rate, sitePrice, hasBench, groupKnown = true }) {
  const siteRatio = typeof rate === 'number' ? rate : null

  // 缓存读价跟着同一次落价一起写：命中缓存的部分按它计费（通常只有输入价的 1/10），
  // 不写的话花费只能按输入全价算，缓存占比高的用户会被高估好几倍
  const scaleTo = (value) =>
    value === null || value === undefined || !Number.isFinite(Number(value))
      ? null
      : Math.round(Number(value) * (siteRatio ?? 1) * 1000) / 1000
  if (sitePrice) {
    // 站点明确没给某一项时清掉旧值，避免沿用一个已经不成立的价
    offer.cacheReadPrice = scaleTo(sitePrice.cacheReadPrice)
    offer.cacheWritePrice = scaleTo(sitePrice.cacheWritePrice)
  }

  // ---- 按次计费：站点在模型广场里声明了 billing_mode=per_request / image。
  // 这类供给的单价是「每次多少钱」，和 token 口径量纲不同——塞进 per_mtok 会让
  // 比价页把 ¥1/次 当成 ¥1/百万 token 来比，结论完全错。倍率已在 model-plaza
  // 里按站点的算法（含生图独立倍率）折算过，这里直接用
  if (sitePrice && sitePrice.billingMode && sitePrice.billingMode !== 'token') {
    const call = Number(sitePrice.callPrice)
    if (sitePrice.callPrice === null || sitePrice.callPrice === undefined || !Number.isFinite(call)) {
      return 'skip'
    }
    offer.priceUnit = 'per_call'
    offer.inPrice = Math.round(call * 1000) / 1000
    offer.outPrice = null
    offer.currency = currencyOf(offer)
    offer.pricingMode = 'manual'
    offer.ratio = null
    offer.siteRatio = siteRatio
    offer.ratioSource = 'site'
    return 'percall'
  }

  // 从按次切回按量：不清掉单位的话，per_call 会带着 token 价格一起留着
  const wasPerCall = offer.priceUnit === 'per_call'
  if (wasPerCall) offer.priceUnit = 'per_mtok'

  if (exact && exact.inPrice === 0 && exact.outPrice === 0) {
    offer.pricingMode = 'manual'
    offer.ratio = null
    offer.inPrice = 0
    offer.outPrice = 0
    offer.currency = currencyOf(offer)
    offer.siteRatio = siteRatio
    offer.ratioSource = 'site'
    return 'free'
  }

  // 站点确实有分组价，但调用方没解析出倍率（分组名对不上、或站点没公布倍率）：
  // 这时不能把「未乘倍率」的原价当成手填价写下去——那会把价格放大约 10 倍。
  // 返回 skip，让调用方保留原值和分组名，等下次分组识别成功再落价。
  //
  // exact 查不到也要拦：站方改过分组名之后，行上存的旧名字在 byGroup 里也不存在，
  // 光靠 exact !== null 挡不住——这种时候原价 × 1 和「按原价买」没区别，
  // 用户看到的数字不会报错，只会安静地贵十倍。所以再加一条 groupKnown。
  if (sitePrice && siteRatio === null && (exact !== null || !groupKnown)) {
    return 'skip'
  }

  // 倍率已知 → 倍率模式。原价写进输入框（只补空，不覆盖手输），倍率另存，
  // 算钱时由 resolveOfferPrice 统一乘——这里不要预先乘好，否则改倍率得重算\n  // 每一行，而且会和「基准价 × 倍率」两套口径打架。
  if (siteRatio !== null) {
    offer.ratio = siteRatio
    offer.siteRatio = siteRatio
    offer.ratioSource = 'site'
    offer.pricingMode = 'ratio'
    // 原价：站点给了就补空位；用户手输过的不动（基准价只是默认值，没有高优先级）
    const fill = (value) =>
      value === null || value === undefined || !Number.isFinite(Number(value))
        ? null
        : Math.round(Number(value) * 1000) / 1000
    if (sitePrice) {
      // 从按次切过来时，旧的 inPrice 是「每次多少钱」，量纲不同，不能当原价——直接覆盖
      if (wasPerCall || offer.inPrice === null || offer.inPrice === undefined) {
        offer.inPrice = fill(sitePrice.inPrice)
      }
      if (wasPerCall || offer.outPrice === null || offer.outPrice === undefined) {
        offer.outPrice = fill(sitePrice.outPrice)
      }
      // 站点价格单位是元（渠道/广场都是），原价跟着标 CNY
      // 站点价格单位实测是美元（广场报价就是官方美元价），币种按行上的选择落
      if (offer.inPrice !== null || offer.outPrice !== null) {
        offer.currency = currencyOf(offer)
      }
    }
    return 'ratio'
  }

  if (sitePrice) {
    const mult = siteRatio ?? 1
    if (sitePrice.inPrice !== null && sitePrice.inPrice !== undefined) {
      offer.inPrice = Math.round(sitePrice.inPrice * mult * 1000) / 1000
    }
    if (sitePrice.outPrice !== null && sitePrice.outPrice !== undefined) {
      offer.outPrice = Math.round(sitePrice.outPrice * mult * 1000) / 1000
    }
    offer.currency = currencyOf(offer)
    offer.pricingMode = 'manual'
    offer.ratio = null
    offer.siteRatio = siteRatio
    offer.ratioSource = 'site'
    return 'manual'
  }

  return 'skip'
}

/**
 * 把一条供给从「价格模式」切到「倍率模式」时，把输入框里的数字还原成原价。
 *
 * 两个口径：价格模式的输入框是**最终价**，倍率模式的输入框是**原价**。
 * 直接切模式会把最终价当成原价再乘一遍，价格静默缩水一个倍率——必须换算。
 *
 * 还原优先用站点公布倍率（siteRatio）：历史落价写成手填价时，就是
 * 「原价 × siteRatio」得到的。站点倍率未知（老数据 / 站点没公布）时，
 * 只能把现有数字当原价（用户本来就是按原价填的）。
 */
export function priceToRatioMode(offer, nextRatio) {
  if (!(Number.isFinite(nextRatio) && nextRatio > 0)) return false
  const siteRatio = Number(offer.siteRatio)
  const divisor = Number.isFinite(siteRatio) && siteRatio > 0 ? siteRatio : 1
  if (divisor === 1) return false
  const round3 = (v) => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000)
  if (offer.inPrice != null) offer.inPrice = round3(Number(offer.inPrice) / divisor)
  if (offer.outPrice != null) offer.outPrice = round3(Number(offer.outPrice) / divisor)
  return true
}

/**
 * 删掉一个分组。
 *
 * 分组不是独立实体，只是 offer.group / credential.group 上的一串名字——所以
 * 「删分组」只有两件事可做：删掉这个分组下的供给行，把 Key 从分组里摘出来。
 *
 * 两种来源分开处理：
 *  - 比价页「＋」复制出来的分组：行是手写的副本，没有 Key 兜底，跟着一起删；
 *  - Key 自带的分组：Key 保留，只清掉分组归属；供给行删掉——之后在那把 Key 上
 *    重新「选分组」，apply-group 会按这把 Key 重新拉模型建行，所以删了能加回来。
 *
 * 「未指定分组」不是真分组（它只是「这把 Key 没选分组」），不接受删除。
 *
 * @returns {Promise<{group:string, removedOffers:number, keys:string[]}>}
 */
export async function deleteGroup(providerId, group) {
  return mutate((db) => {
    if (!db.providers.some((p) => p.id === providerId)) throw new Error(`站点不存在：${providerId}`)
    const name = normalizeGroup(group)
    if (!name) throw new Error('「未指定分组」不是真正的分组，不能删除')
    const rows = db.offers.filter(
      (o) => o.providerId === providerId && normalizeGroup(o.group) === name,
    )
    const keys = db.credentials.filter(
      (c) => c.providerId === providerId && normalizeGroup(c.group) === name,
    )
    if (rows.length === 0 && keys.length === 0) throw new Error(`该站没有「${name}」分组`)

    if (rows.length > 0) {
      const dead = new Set(rows.map((o) => o.id))
      db.offers = db.offers.filter((o) => !dead.has(o.id))
      // 流量计数与手动排序都按 offerId 记，删行必须一起清，否则留下孤儿键
      pruneOfferRefs(db, dead)
    }
    for (const credential of keys) {
      credential.group = ''
      // 分组都不在了，手选标记一起清掉：留着 manual 会让后台自动识别再也写不进来
      delete credential.groupSource
    }
    return { group: name, removedOffers: rows.length, keys: keys.map((c) => c.label) }
  })
}

export async function setGroupRatio(providerId, group, ratio) {
  return mutate((db) => {
    if (!db.providers.some((p) => p.id === providerId)) throw new Error(`站点不存在：${providerId}`)
    const name = normalizeGroup(group)
    const value = ratio === null || ratio === undefined || ratio === '' ? null : Number(ratio)
    if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error('倍率需要是 0 或正数')

    let updated = 0
    const siteValues = new Set()
    for (const offer of db.offers) {
      if (offer.providerId !== providerId) continue
      if (normalizeGroup(offer.group) !== name) continue
      // 手填模式 → 倍率模式：输入框里的最终价先还原成原价，否则会被再乘一遍
      if (value !== null && offer.pricingMode !== 'ratio' && offer.priceUnit !== 'per_call') {
        priceToRatioMode(offer, value)
      }
      offer.ratio = value
      offer.ratioSource = value === null ? null : value === offer.siteRatio ? 'site' : 'custom'
      // 清空倍率要同步回手填模式：pricingMode 是定价的权威开关（pricing.js 的约定），
      // 留着 'ratio' + ratio=null + 无手填价会变成自相矛盾的「未定价」行
      offer.pricingMode = value === null ? 'manual' : 'ratio'
      offer.updatedAt = nowIso()
      siteValues.add(offer.siteRatio ?? null)
      updated += 1
    }
    if (updated === 0) throw new Error(`该站没有「${name || '默认'}」分组下的模型`)
    // siteRatio 让前端能提示「站点值是多少、能不能恢复」
    const siteRatio = siteValues.size === 1 ? [...siteValues][0] : null
    return { group: name, ratio: value, updated, siteRatio }
  })
}

/**
 * 把自定义倍率恢复成站点公布的值。
 * @param {string} [group] 只恢复某个分组；不传则恢复该站全部
 * @returns {Promise<{restored:number, noSiteValue:string[]}>}
 */
export async function restoreSiteRatio(providerId, group) {
  return mutate((db) => {
    if (!db.providers.some((p) => p.id === providerId)) throw new Error(`站点不存在：${providerId}`)
    const name = group === undefined || group === null ? null : normalizeGroup(group)
    let restored = 0
    const noSiteValue = []
    for (const offer of db.offers) {
      if (offer.providerId !== providerId) continue
      if (name !== null && normalizeGroup(offer.group) !== name) continue
      if (offer.ratioSource !== 'custom') continue
      if (offer.siteRatio === null || offer.siteRatio === undefined) {
        noSiteValue.push(offer.upstreamName)
        continue
      }
      offer.ratio = offer.siteRatio
      offer.ratioSource = 'site'
      offer.pricingMode = 'ratio'
      offer.updatedAt = nowIso()
      restored += 1
    }
    if (restored === 0 && noSiteValue.length === 0) {
      throw new Error(`该站没有自定义过倍率，无需恢复`)
    }
    return { restored, noSiteValue }
  })
}

// --------------------------------------------------------------- 免费配额

/**
 * 给一条免费供给设置额度上限。
 *
 * 传 null 表示「没有配额」（不限量），和「额度为 0」是两件事：
 * 前者在界面上显示「—」，后者是「已用尽」。
 *
 * 归一化放在 mutate 外面——mutate 的回调是同步的，校验失败时不该已经落盘。
 */
export async function setFreeQuota(offerId, rawQuota) {
  const clearing = rawQuota === null || rawQuota === undefined
  const quota = clearing ? null : normalizeQuota(rawQuota)
  if (!clearing && quota === null) throw new Error('配额需要包含一个不小于 0 的上限')

  return mutate((db) => {
    const offer = db.offers.find((o) => o.id === offerId)
    if (!offer) throw new Error(`模型记录不存在：${offerId}`)
    offer.freeQuota = quota
    offer.updatedAt = nowIso()
    return offer
  })
}

/** 清掉配额，回到「不限量」。 */
export async function clearFreeQuota(offerId) {
  return setFreeQuota(offerId, null)
}

/**
 * 真实调用后扣减免费额度。
 *
 * 单位口径沿用 quota.js：request 记次数，token / credit 记 token 数。
 * 跨窗口的先归零再记（resetIfDue），否则昨天的 used 会算进今天。
 * 没有配额的供给直接跳过——「不限量」不该被写成 0 上限。
 */
export async function consumeFreeQuota(offerId, { tokens = 0, requests = 1 } = {}) {
  if (!offerId) return null
  return mutate((db) => {
    const offer = db.offers.find((o) => o.id === offerId)
    if (!offer?.freeQuota) return null
    const current = resetIfDue(normalizeQuota(offer.freeQuota), Date.now())
    if (!current) return null
    offer.freeQuota = consumeQuota(current, { tokens, requests })
    offer.updatedAt = nowIso()
    return offer.freeQuota
  })
}

// ------------------------------------------------------------ 模型名合并

/**
 * 手动合并一批模型名：把 `names` 全部指给 `target`（别名表只做一层指向）。
 *
 * 为什么是别名而不是改 offer.modelKey：modelKey 是「写给上游的名字」的克隆，
 * 一旦改掉，请求就会带着另一个站的名字出去，直接 404。身份层单独加一层，
 * 上游永远拿原样名字，显示/比价/路由用合并后的身份。
 *
 * @param {string[]} names 要被归并的名字
 * @param {string} target 归到哪个名字（可以不在 names 里）
 */
export async function mergeModelNames(names, target) {
  return mutate((db) => {
    const wanted = (Array.isArray(names) ? names : [names]).map((n) => modelBaseKey(n)).filter(Boolean)
    const to = String(target ?? '').trim().toLowerCase()
    if (!to) throw new Error('缺少合并目标')
    if (!db.settings) db.settings = {}
    const before = db.settings.modelAliases || {}
    const table = { ...before }
    let changed = 0
    for (const name of wanted) {
      if (name === to) delete table[name]
      else table[name] = to
      changed += 1
    }
    db.settings.modelAliases = table
    // 身份键变了，手动排序的键必须跟着换，否则用户拖过的顺序会静默失效
    db.manualOrder = remapManualOrderKeys(db.manualOrder, db.offers, table, before)
    return { changed, target: to, aliases: table }
  })
}

/**
 * 拆开一个合并：让这条名字自成一档，不再参与规则归一。
 * 比如 claude-opus-4-5 确实不是 claude-opus-4.5 时，拆开就不会再被合回去。
 */
export async function splitModelName(name) {
  const base = modelBaseKey(name)
  if (!base) throw new Error('缺少模型名')
  return mutate((db) => {
    if (!db.settings) db.settings = {}
    const before = db.settings.modelAliases || {}
    const table = { ...before }
    // 指到 SPLIT_PREFIX 命名空间里的自己：不能写 base 本身，
    // 否则另一个写法的归一键正好等于它，两者又撞回一组
    table[base] = `${SPLIT_PREFIX}${base}`
    db.settings.modelAliases = table
    db.manualOrder = remapManualOrderKeys(db.manualOrder, db.offers, table, before)
    return { split: base, aliases: table }
  })
}

/** 取消一条别名（回到自动规则归一）。 */
export async function unaliasModelName(name) {
  const base = modelBaseKey(name)
  if (!base) throw new Error('缺少模型名')
  return mutate((db) => {
    if (!db.settings) db.settings = {}
    const before = db.settings.modelAliases || {}
    const table = { ...before }
    delete table[base]
    db.settings.modelAliases = table
    db.manualOrder = remapManualOrderKeys(db.manualOrder, db.offers, table, before)
    return { reset: base, aliases: table }
  })
}

/** 清空所有手动别名，全部回到自动归一。 */
export async function resetModelAliases() {
  return mutate((db) => {
    if (!db.settings) db.settings = {}
    const before = db.settings.modelAliases || {}
    const count = Object.keys(before).length
    db.settings.modelAliases = {}
    db.manualOrder = remapManualOrderKeys(db.manualOrder, db.offers, {}, before)
    return { cleared: count }
  })
}

/**
 * 合并总览（供界面展示）：现在哪些名字已经归在一起、哪些疑似该合并但还没合。
 * 只读不写：规则归一是自动的，别名表是用户决定的，这两者分开说清楚。
 */
export function modelMergeView(db, official = null) {
  const aliases = db.settings?.modelAliases || {}
  const names = db.offers.filter((o) => !o.delistedAt).map((o) => o.modelKey || o.upstreamName || '')
  const overview = modelNamesOverview(names, aliases, official)
  // 把每个分组映射回实际供给，界面上才能显示「这条合并动了几个站的几个模型」
  const byIdentity = new Map()
  for (const offer of db.offers) {
    if (offer.delistedAt) continue
    const id = identityKey(offer.modelKey || offer.upstreamName || '', aliases)
    if (!byIdentity.has(id)) byIdentity.set(id, [])
    byIdentity.get(id).push({
      offerId: offer.id,
      providerId: offer.providerId,
      upstreamName: offer.upstreamName,
      group: offer.group || '',
      paused: Boolean(db.providers.find((p) => p.id === offer.providerId)?.paused),
    })
  }
  return {
    ...overview,
    groups: overview.groups.map((g) => ({ ...g, offers: byIdentity.get(g.id) || [] })),
    aliasCount: Object.keys(aliases).length,
    aliases,
  }
}

// --------------------------------------------------------------- 手动排序

/**
 * 保存某个模型的手动候选顺序；传空数组即恢复自动。
 * 只影响「可用的那几条」的相对次序，不会把不可信的站提到前面。
 *
 * 键统一成**身份键**：界面上看到的「一个模型」可能由两个站名合并而成，
 * 存成身份键才能在名字写法变动后仍然命中。读的时候也按身份键查。
 */
export async function setManualOrder(modelKey, order) {
  return mutate((db) => {
    if (!db.manualOrder || typeof db.manualOrder !== 'object') db.manualOrder = {}
    const key = identityKey(String(modelKey || '').trim(), db.settings?.modelAliases || {})
    if (!key) throw new Error('缺少模型名')
    if (!Array.isArray(order) || order.length === 0) {
      delete db.manualOrder[key]
      // 「恢复自动」= 顺序和勾选一并清掉，回到全自动
      if (db.pinnedOffer) delete db.pinnedOffer[key]
      return null
    }
    db.manualOrder[key] = order.map(String)
    return db.manualOrder[key]
  })
}

/**
 * 勾选某个模型的供给为「当前使用」：与手动顺序相互独立——勾了哪条哪条就是
 * 当前选，页面顺序不动；传空 = 取消勾选，回到按顺序自动选。
 * 键与手动顺序同口径（身份键），读的时候也按身份键查。
 */
export async function setPinnedOffer(modelKey, offerId) {
  return mutate((db) => {
    const key = identityKey(String(modelKey || '').trim(), db.settings?.modelAliases || {})
    if (!key) throw new Error('缺少模型名')
    if (!offerId) {
      if (db.pinnedOffer) delete db.pinnedOffer[key]
      return null
    }
    if (!db.pinnedOffer || typeof db.pinnedOffer !== 'object') db.pinnedOffer = {}
    db.pinnedOffer[key] = String(offerId)
    return db.pinnedOffer[key]
  })
}

export async function getManualOrder(modelKey) {
  const db = await readDb()
  const key = identityKey(modelKey, db.settings?.modelAliases || {})
  return db.manualOrder?.[key] || null
}

// ----------------------------------------------------------- 真实流量计数

const TRAFFIC_WINDOW_MS = 3600 * 1000

/**
 * 计费核对样本：每 N 次成功请求抽一条，记「本地估算 token vs 上游上报 prompt_tokens」。
 *
 * 这是唯一**不依赖站点自报数字**的独立证据：站点虚报 prompt_tokens 时，
 * 我们的 usage 记录会跟着虚报，拿它和站点账单比永远一致——只有本地按请求体
 * 重新数一遍 token，才能看出上报值是否离谱。
 */
const BILLING_SAMPLE_EVERY = 20
const BILLING_SAMPLE_KEEP = 200
let billingSampleCounter = 0

export async function recordBillingSample(offerId, entry) {
  billingSampleCounter += 1
  if (billingSampleCounter % BILLING_SAMPLE_EVERY !== 0) return null
  if (!offerId) return null
  return mutate((db) => {
    if (!Array.isArray(db.billingSamples)) db.billingSamples = []
    const row = {
      id: `bs_${Date.now().toString(36)}`,
      ts: nowIso(),
      offerId,
      providerId: entry.providerId || null,
      modelKey: entry.modelKey || null,
      localTokens: Number(entry.localTokens) || 0,
      reportedPrompt: Number(entry.reportedPrompt) || 0,
      reportedCached: Number(entry.reportedCached) || 0,
    }
    // 离谱的样本单独标出来：上报值超过本地估算 2 倍（且绝对量不小）就值得报警
    row.suspicious = row.localTokens >= 200 && row.reportedPrompt > row.localTokens * 2
    db.billingSamples.push(row)
    if (db.billingSamples.length > BILLING_SAMPLE_KEEP) {
      db.billingSamples = db.billingSamples.slice(-BILLING_SAMPLE_KEEP)
    }
    return row
  })
}

/** 某站最近的计费样本（用量核对用） */
export async function listBillingSamples(providerId, limit = 30) {
  const db = await readDb()
  return (db.billingSamples || [])
    .filter((r) => r.providerId === providerId)
    .slice(-limit)
    .reverse()
}

/**
 * 累加真实请求的成败。窗口超过 1 小时就重置——
 * 一个站上午挂了下午恢复了，不该被上午的失败一直拖累。
 *
 * fail 只记「站点故障」（5xx、超时、连接失败）；额度不足 / 限流 / 模型不在分组
 * 记在 kinds 里，不参与可用率，只用来给供给侧设冷却（见 core/failure.js）。
 */
export async function addTraffic(entries, windowMs = TRAFFIC_WINDOW_MS) {
  if (!entries || entries.length === 0) return null
  return mutate((db) => {
    if (!db.traffic || typeof db.traffic !== 'object') db.traffic = {}
    const now = Date.now()
    const nowIso = new Date(now).toISOString()
    for (const [offerId, delta] of entries) {
      const row = db.traffic[offerId] || { ok: 0, fail: 0, since: nowIso, kinds: {}, quality: { samples: 0, bad: 0 } }
      if (now - new Date(row.since).getTime() > windowMs) {
        row.ok = 0
        row.fail = 0
        row.since = nowIso
        row.kinds = {}
        row.lastOkAt = null
        row.lastFailAt = null
        row.quality = { samples: 0, bad: 0 }
      }
      row.ok += delta.ok || 0
      row.fail += delta.fail || 0
      if (delta.ok) row.lastOkAt = nowIso
      if (delta.fail) row.lastFailAt = nowIso
      // 真实响应的质量信号（空回答 / 计费虚报）：探针之外的第二类完整性证据
      if (delta.quality) {
        if (!row.quality || typeof row.quality !== 'object') row.quality = { samples: 0, bad: 0 }
        row.quality.samples += delta.quality.samples || 0
        row.quality.bad += delta.quality.bad || 0
      }
      if (delta.kinds) {
        if (!row.kinds || typeof row.kinds !== 'object') row.kinds = {}
        for (const [kind, count] of Object.entries(delta.kinds)) {
          if (!count) continue
          const current = row.kinds[kind] || { n: 0, lastAt: null }
          current.n += count
          current.lastAt = nowIso
          row.kinds[kind] = current
        }
      }
      db.traffic[offerId] = row
    }
    return db.traffic
  })
}

// ------------------------------------------------------------ 路由决策日志

export async function recordRouting(entry) {
  return recordRoutingBatch([entry])
}

/**
 * 批量写空回合记录（异常诊断页）。
 *
 * 和决策日志同一个理由：每个请求都 mutate 一次等于整份重写 db.json。异常事件
 * 很少，但一旦发生往往连着几条，照样攒批写。
 */
export async function recordEmptyBatch(events = []) {
  if (!events.length) return []
  return mutate((db) => events.map((event) => recordEmptyEvent(db, event)))
}

/** 手动清空空回合记录（诊断页的「清空」按钮） */
export async function clearEmptyEventsLog() {
  return mutate((db) => clearEmptyEvents(db))
}

/** 建一条临时改道账：原站出问题，流量先走别家，20 分钟后复检 */
export async function recordEmptyDetour(entry) {
  return mutate((db) => recordDetour(db, entry))
}

/** 解除改道（复检连续正常 / 用户手动） */
export async function resolveEmptyDetour(offerId, options = {}) {
  return mutate((db) => resolveDetour(db, offerId, options))
}

/** 批量写故障信号（攒批理由同决策日志） */
export async function recordFaultBatch(signals = []) {
  if (!signals.length) return []
  return mutate((db) => signals.map((signal) => recordFaultSignal(db, signal)))
}

/** 清掉某个供给上的故障信号（恢复时调） */
export async function clearFaults({ offerId = null, providerId = null } = {}) {
  return mutate((db) => clearFaultSignals(db, { offerId, providerId }))
}

/** 故障快照（已把临时改道并进来）：自动路由挑优时读这一份就够 */
export async function faultSnapshot() {
  const db = await readDb()
  ensureFaultSignals(db)
  return combineWithDetours(db, activeFaultSignals(db))
}

/** 记一次改道复检的结果（连续正常到阈值就自动解除改道） */
export async function noteEmptyDetourCheck(offerId, { ok } = {}) {
  return mutate((db) => noteDetourCheck(db, offerId, { ok }))
}

/**
 * 批量写决策日志。
 *
 * 每个网关请求都单独 mutate 一次的话，等于每请求把 1MB 的 db.json 读一遍再整份重写，
 * 高峰期写放大非常吓人。调用方（server.js）攒几秒再一起写，语义不变。
 *
 * 顺路更新两份诊断聚合（与决策日志同源，不额外发任何请求）：
 *   - db.errorbook  错误指纹账本：failures[] 与断流原因归一化后沉淀，不受 500 条滚动窗口影响
 *   - db.offerStats 供给表现时间序列：按供给×小时聚合成功/失败/TTFT/TPS/估算费用等，
 *     这是将来「站点综合评判（速度/稳定性/置信度）」直接消费的数据
 */
export async function recordRoutingBatch(entries = []) {
  if (!entries.length) return []
  return mutate((db) => {
    if (!Array.isArray(db.routing)) db.routing = []
    if (!db.errorbook || typeof db.errorbook !== 'object') db.errorbook = {}
    if (!db.offerStats || typeof db.offerStats !== 'object') db.offerStats = {}
    // 入队时已经盖过请求完成时刻，落盘只补没盖过的时间（老调用方）
    const records = entries.map((entry) => ({ id: newId('g'), ...entry, ts: entry.ts || nowIso() }))
    db.routing.push(...records)
    if (db.routing.length > 500) db.routing = db.routing.slice(-500)

    // ---- 诊断聚合：只在有供给的批次才去碰价格表（offerCost 不便宜）
    const needStats = records.some((r) => r.chosenOfferId)
    let offerById = null
    if (needStats) {
      offerById = new Map((db.offers || []).map((o) => [o.id, o]))
    }
    for (const record of records) {
      // 错误账本：被试供给的失败原文 + 断流原因，都要沉淀
      for (const f of record.failures || []) {
        const fp = fingerprintError(f.error)
        if (fp) applyErrorToBook(db.errorbook, fp, { providerName: f.providerName, offerId: f.offerId, at: record.ts })
      }
      if (record.outcome === 'stream-broken' && record.streamError) {
        const fp = fingerprintError(record.streamError)
        if (fp) applyErrorToBook(db.errorbook, fp, { providerName: record.chosenProviderName, offerId: record.chosenOfferId, at: record.ts })
      }
      // 供给表现时间序列
      if (needStats) {
        applyRoutingToStats(db.offerStats, record, {
          offerById,
          settings: db.settings || {},
          benchmarks: db.benchmarks || {},
        })
      }
    }
    // 瘦身按天做一次就够：批次里随便挑一条的时间戳当「今天」
    const today = records[records.length - 1].ts
    if (!db._diagPrunedAt || today.slice(0, 10) !== String(db._diagPrunedAt).slice(0, 10)) {
      pruneErrorbook(db.errorbook, Date.parse(today) || Date.now())
      pruneOfferStats(db.offerStats, Date.parse(today) || Date.now())
      db._diagPrunedAt = today
    }
    return records
  })
}

export async function listRouting(limit = 50) {
  const db = await readDb()
  return (db.routing || []).slice(-limit).reverse()
}

// --------------------------------------------------------------- public view

/** 给前端的视图：去掉密文，只留可识别信息。 */
export async function publicState() {
  const db = await readDb()
  return {
    settings: db.settings,
    providers: db.providers,
    credentials: db.credentials.map((c) => ({
      id: c.id,
      providerId: c.providerId,
      label: c.label,
      tail: c.tail,
      quotaRemaining: c.quotaRemaining,
      currency: c.currency,
      quotaUpdatedAt: c.quotaUpdatedAt,
      expiresAt: c.expiresAt,
      createdAt: c.createdAt,
    })),
    offers: db.offers,
    probeCount: db.probes.length,
  }
}

// ------------------------------------------------------------------ 登录态

/** 自动重登的冷却：同一站 10 分钟内不重复自动登录（防止反复触发站点风控） */
const RELOGIN_COOLDOWN_MS = 10 * 60 * 1000
const reloginAt = new Map()

export function reloginAllowed(providerId, now = Date.now()) {
  const last = reloginAt.get(providerId) || 0
  return now - last >= RELOGIN_COOLDOWN_MS
}

/** 记录一次自动重登尝试（无论成败），进入冷却 */
export function markRelogin(providerId, now = Date.now()) {
  reloginAt.set(providerId, now)
}

/** 手动登录成功后清掉冷却，让自动续期立刻可用 */
export function clearReloginCooldown(providerId) {
  reloginAt.delete(providerId)
}

/**
 * 账号密码登录并把凭据写回站点。产物（access token）写入现有
 * adminToken 字段——下游余额/公告/用量核对/分组识别零改动复用；
 * Sub2API 的 refresh token 单独加密存（旋转式，续期时更新）。
 *
 * **登录前先只读识别系别**（零风险）：系别确定就走确定性端点；识别不出
 * 才退化为双端点试探——那会向站点发一次「错误协议」的失败登录，部分站
 * 对失败登录有风控计数，所以必须由用户显式确认（confirmUnknown）。
 *
 * 登录成功同时把 kind 修正为登录实际使用的系别（unknown 站的双端点
 * 试探结果是免费可靠的系别证据）。
 */
export async function loginWithCredentials(providerId, { user, password, confirmUnknown = false }) {
  const db = await readDb()
  const provider = db.providers.find((p) => p.id === providerId)
  if (!provider) throw new Error(`站点不存在：${providerId}`)

  const AUTH_KINDS = ['sub2api', 'one-api', 'new-api']
  let kind = AUTH_KINDS.includes(provider.kind) ? provider.kind : null
  let detected = null
  if (!kind) {
    // 只读探测：/api/status、/api/v1/settings/public 等，不产生任何写操作
    detected = await providers
      .detectProviderKind({ baseUrl: provider.baseUrl, timeoutMs: 5000 })
      .catch(() => ({ kind: 'unknown', evidence: '探测失败' }))
    if (AUTH_KINDS.includes(detected.kind)) kind = detected.kind
  }
  if (!kind) {
    // 系别识别不出：双端点试探会向站点发错误协议的登录请求（可能失败）
    if (!confirmUnknown) {
      const error = new Error(
        `无法识别站点系别（${detected?.evidence || '探测无结果'}）。将依次尝试 Sub2API 与 OneAPI/NewAPI 两种登录协议，` +
          '其中一次是「错误协议」的失败登录（部分站会据此计风控），确认继续？',
      )
      error.needConfirm = true
      error.evidence = detected?.evidence || null
      throw error
    }
    kind = undefined // 用户确认后才双试
  }

  const result = await providers.loginProvider({
    baseUrl: provider.baseUrl,
    kind,
    user,
    password,
  })

  const encrypted = await encryptSecret(JSON.stringify({ user, password }))
  const tokenEnc = await encryptSecret(result.token)
  const refreshEnc = result.refreshToken ? await encryptSecret(result.refreshToken) : null

  await mutate((db) => {
    const p = db.providers.find((x) => x.id === providerId)
    if (!p) return
    p.adminToken = tokenEnc
    p.adminTokenTail = String(result.token).slice(-6)
    p.adminTokenSource = 'login'
    p.loginCred = encrypted
    p.refreshTokenEnc = refreshEnc
    // 双端点试探的结果就是系别证据（unknown 站也能借此归位）
    if (result.kind) {
      p.kind = result.kind
      p.kindSource = 'auto'
    }
    p.tokenStatus = 'ok'
    p.tokenStatusAt = nowIso()
    p.tokenStatusMessage = null
    p.updatedAt = nowIso()
  })
  clearReloginCooldown(providerId)
  return { kind: result.kind, via: result.refreshToken ? 'sub2api' : 'one-api' }
}

/**
 * 401 时的自动续期：用已存的登录凭据重新登录、写回 adminToken。
 * 冷却内直接返回「不可用」（调用方按普通 401 处理，不硬刚站点风控）；
 * 手动令牌（adminTokenSource='manual'）不自动覆盖——用户手动填的
 * 说明他知道自己有什么，自动换掉反而丢信息。
 *
 * @returns {{ok:boolean, token?:string, reason?:string}}
 */
export async function autoRelogin(providerId) {
  const db = await readDb()
  const provider = db.providers.find((p) => p.id === providerId)
  if (!provider?.loginCred) return { ok: false, reason: '没有登录凭据' }
  if (provider.adminTokenSource === 'manual') {
    return { ok: false, reason: '手动令牌不做自动覆盖' }
  }
  if (!reloginAllowed(providerId)) {
    return { ok: false, reason: '自动重登冷却中（10 分钟内已尝试过）' }
  }
  markRelogin(providerId)
  try {
    const plain = JSON.parse(await decryptSecret(provider.loginCred))
    const result = await providers.loginProvider({
      baseUrl: provider.baseUrl,
      kind: provider.kind === 'relay' ? undefined : provider.kind,
      user: plain.user,
      password: plain.password,
    })
    const tokenEnc = await encryptSecret(result.token)
    const refreshEnc = result.refreshToken ? await encryptSecret(result.refreshToken) : null
    await mutate((db) => {
      const p = db.providers.find((x) => x.id === providerId)
      if (!p) return
      p.adminToken = tokenEnc
      p.adminTokenTail = String(result.token).slice(-6)
      p.adminTokenSource = 'login'
      if (refreshEnc) p.refreshTokenEnc = refreshEnc
      p.tokenStatus = 'ok'
      p.tokenStatusAt = nowIso()
      p.tokenStatusMessage = null
      p.updatedAt = nowIso()
    })
    return { ok: true, token: result.token }
  } catch (error) {
    const message = error.message || String(error)
    await mutate((db) => {
      const p = db.providers.find((x) => x.id === providerId)
      if (p) {
        p.tokenStatus = 'invalid'
        p.tokenStatusAt = nowIso()
        p.tokenStatusMessage = message
        p.updatedAt = nowIso()
      }
    })
    return { ok: false, reason: message }
  }
}

/**
 * 揭开登录凭据（仅供「重新登录」的编排使用）；没有返回 null。
 */
export async function revealLoginCred(providerId) {
  const db = await readDb()
  const provider = db.providers.find((p) => p.id === providerId)
  if (!provider?.loginCred) return null
  try {
    return JSON.parse(await decryptSecret(provider.loginCred))
  } catch {
    return null
  }
}
