/**
 * 台账层：站点、凭据、模型供给的增删改查。
 * 所有写操作走 mutate()，保证读-改-写原子性。
 */
import { randomUUID, randomBytes } from 'node:crypto'
import { readDb, mutate, encryptSecret, decryptSecret, normalizeGroup } from './store.js'
// quota.js 只依赖内置类型，不回头 import 本文件，不会形成循环
import { normalizeQuota, resetIfDue, consumeQuota } from './quota.js'
// 登录态编排：凭据解密后调 providers 的登录协议（providers 不回头 import 本文件，无循环）
import * as providers from './providers.js'

export function newId(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`
}

export function nowIso() {
  return new Date().toISOString()
}

/**
 * 归一化模型名，用于跨站比对同一个模型。
 * 处理：大小写、空白、`provider/` 前缀、`:free` / `-free` 后缀。
 */
export function normalizeModelKey(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^[a-z0-9_.-]+\//, '')
    .replace(/[-:]free$/, '')
    .trim()
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

export async function createCredential({ providerId, label, secret, group = '', expiresAt = null }) {
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
      expiresAt,
      createdAt: nowIso(),
    }
    db.credentials.push(credential)
    return credential
  })
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
 * 真正「在役」的供给：没下线（delistedAt）、站点没暂停（paused）、模型没被忽略（ignoredModels）。
 * 这是三条过滤规则的唯一实现——比价 / 概览 / 智能决策 / 网关 / 免费池 / 探针目标都从这里取，
 * 任何一侧自己再写一遍迟早漂移（曾出过「暂停站点仍被派流量」「下线模型仍被探测白烧额度」）。
 * 纯函数：只读 db，不改；调用方拿到的是 db.offers 里的原对象，不要原地修改。
 */
export function routeableOffers(db) {
  const pausedIds = new Set(db.providers.filter((p) => p.paused).map((p) => p.id))
  const ignored = new Set(
    (db.settings?.ignoredModels || []).map((name) => normalizeModelKey(String(name))),
  )
  return db.offers.filter((offer) => {
    if (offer.delistedAt) return false
    if (pausedIds.has(offer.providerId)) return false
    if (ignored.size) {
      const key = normalizeModelKey(offer.modelKey || offer.upstreamName || '')
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
    if (currency) offer.currency = currency
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
 * 只按 credentialId 处理，不碰别的 Key 的行。
 */
export async function markDelisted(providerId, credentialId, keepNames) {
  const keep = new Set(keepNames)
  return mutate((db) => {
    let delisted = 0
    let revived = 0
    for (const offer of db.offers) {
      if (offer.providerId !== providerId) continue
      if (credentialId && offer.credentialId !== credentialId) continue
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
 */
export function applySitePricing(offer, { exact, rate, sitePrice, hasBench }) {
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
    offer.currency = 'CNY'
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
    offer.currency = 'CNY'
    offer.siteRatio = siteRatio
    offer.ratioSource = 'site'
    return 'free'
  }

  // 站点确实有分组价，但调用方没解析出倍率（分组名对不上、或站点没公布倍率）：
  // 这时不能把「未乘倍率」的原价当成手填价写下去——那会把价格放大约 10 倍。
  // 返回 skip，让调用方保留原值和分组名，等下次分组识别成功再落价
  if (sitePrice && siteRatio === null && exact !== null) {
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
      if (offer.inPrice !== null || offer.outPrice !== null) offer.currency = 'CNY'
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
    offer.currency = 'CNY'
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

// --------------------------------------------------------------- 手动排序

/**
 * 保存某个模型的手动候选顺序；传空数组即恢复自动。
 * 只影响「可用的那几条」的相对次序，不会把不可信的站提到前面。
 */
export async function setManualOrder(modelKey, order) {
  return mutate((db) => {
    if (!db.manualOrder || typeof db.manualOrder !== 'object') db.manualOrder = {}
    const key = String(modelKey || '').trim()
    if (!key) throw new Error('缺少模型名')
    if (!Array.isArray(order) || order.length === 0) {
      delete db.manualOrder[key]
      return null
    }
    db.manualOrder[key] = order.map(String)
    return db.manualOrder[key]
  })
}

export async function getManualOrder(modelKey) {
  const db = await readDb()
  return db.manualOrder?.[modelKey] || null
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
 * 批量写决策日志。
 *
 * 每个网关请求都单独 mutate 一次的话，等于每请求把 1MB 的 db.json 读一遍再整份重写，
 * 高峰期写放大非常吓人。调用方（server.js）攒几秒再一起写，语义不变。
 */
export async function recordRoutingBatch(entries = []) {
  if (!entries.length) return []
  return mutate((db) => {
    if (!Array.isArray(db.routing)) db.routing = []
    const records = entries.map((entry) => ({ id: newId('g'), ts: nowIso(), ...entry }))
    db.routing.push(...records)
    if (db.routing.length > 500) db.routing = db.routing.slice(-500)
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
