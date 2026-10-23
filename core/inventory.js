/**
 * 台账层：站点、凭据、模型供给的增删改查。
 * 所有写操作走 mutate()，保证读-改-写原子性。
 */
import { randomUUID, randomBytes } from 'node:crypto'
import { readDb, mutate, encryptSecret, decryptSecret } from './store.js'
// quota.js 只依赖内置类型，不回头 import 本文件，不会形成循环
import { normalizeQuota } from './quota.js'

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
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    db.providers.push(provider)
    return provider
  })
}

export async function updateProvider(id, patch) {
  return mutate((db) => {
    const provider = db.providers.find((p) => p.id === id)
    if (!provider) throw new Error(`站点不存在：${id}`)
    if (patch.name !== undefined) provider.name = String(patch.name).trim()
    if (patch.baseUrl !== undefined) provider.baseUrl = normalizeBaseUrl(patch.baseUrl)
    if (patch.kind !== undefined) provider.kind = patch.kind
    if (patch.note !== undefined) provider.note = patch.note
    provider.updatedAt = nowIso()
    return provider
  })
}

export async function deleteProvider(id) {
  return mutate((db) => {
    const before = db.providers.length
    db.providers = db.providers.filter((p) => p.id !== id)
    if (db.providers.length === before) throw new Error(`站点不存在：${id}`)
    db.credentials = db.credentials.filter((c) => c.providerId !== id)
    db.offers = db.offers.filter((o) => o.providerId !== id)
    db.probes = db.probes.filter((r) => r.providerId !== id)
    return { deleted: id }
  })
}

// -------------------------------------------------------------- credentials

export async function createCredential({ providerId, label, secret, adminToken = null, group = '', quotaRemaining = null, currency = 'CNY', expiresAt = null }) {
  if (!secret || !String(secret).trim()) throw new Error('API Key 不能为空')
  const encrypted = await encryptSecret(String(secret).trim())
  const encryptedAdmin = adminToken ? await encryptSecret(String(adminToken).trim()) : null
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
      group: String(group || '').trim(),
      // 可选：站点后台的登录令牌，只用来读余额/用量，不参与对话
      adminToken: encryptedAdmin,
      adminTokenTail: encryptedAdmin ? String(adminToken).trim().slice(-6) : null,
      quotaRemaining: quotaRemaining === null ? null : Number(quotaRemaining),
      currency,
      quotaUpdatedAt: quotaRemaining === null ? null : nowIso(),
      expiresAt,
      createdAt: nowIso(),
    }
    db.credentials.push(credential)
    return credential
  })
}

export async function updateCredential(id, patch) {
  // 加密必须在 mutate 外面做——mutate 的回调是同步的
  const encryptedAdmin =
    patch.adminToken === undefined
      ? undefined
      : patch.adminToken
        ? await encryptSecret(String(patch.adminToken).trim())
        : null

  return mutate((db) => {
    const credential = db.credentials.find((c) => c.id === id)
    if (!credential) throw new Error(`凭据不存在：${id}`)
    if (patch.label !== undefined) credential.label = patch.label
    if (patch.group !== undefined) credential.group = String(patch.group || '').trim()
    if (patch.quotaRemaining !== undefined) {
      credential.quotaRemaining = patch.quotaRemaining === null ? null : Number(patch.quotaRemaining)
      credential.quotaUpdatedAt = nowIso()
    }
    if (patch.currency !== undefined) credential.currency = patch.currency
    if (patch.expiresAt !== undefined) credential.expiresAt = patch.expiresAt
    if (encryptedAdmin !== undefined) {
      credential.adminToken = encryptedAdmin
      credential.adminTokenTail = encryptedAdmin ? String(patch.adminToken).trim().slice(-6) : null
    }
    return credential
  })
}

/** 取出管理令牌（明文）。没有就返回 null。 */
export async function revealAdminToken(credentialId) {
  const db = await readDb()
  const credential = db.credentials.find((c) => c.id === credentialId)
  if (!credential?.adminToken) return null
  return decryptSecret(credential.adminToken)
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
 * 把一次拉取到的模型列表合并进台账。
 * 已存在的 upstreamName 保留用户手填的价格与分组，只更新"还在不在"。
 * 分组需要手动维护——大多数站的 /v1/models 不返回分组信息。
 */
export async function syncOffers(providerId, credentialId, models, group = '') {
  return mutate((db) => {
    if (!db.providers.some((p) => p.id === providerId)) throw new Error(`站点不存在：${providerId}`)
    const g = String(group || '').trim()
    // 按「分组 + 模型名」去重：同一个站的不同分组可以有同名模型
    const existing = new Map(
      db.offers
        .filter((o) => o.providerId === providerId)
        .map((o) => [`${o.group || ''}::${o.upstreamName}`, o]),
    )
    let added = 0
    for (const upstreamName of models) {
      const dedupeKey = `${g}::${upstreamName}`
      if (existing.has(dedupeKey)) {
        existing.get(dedupeKey).listedAt = nowIso()
        continue
      }
      db.offers.push({
        id: newId('o'),
        providerId,
        credentialId: credentialId || null,
        upstreamName,
        modelKey: normalizeModelKey(upstreamName),
        group: g,
        // supply 决定这条供给进哪个池：paid 走比价与自动选站，free 只进免费池。
        // 新建时一律按 paid，实际价解析为 0 时由 tagSupply 改成 free。
        supply: 'paid',
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
    return { added, total: models.length }
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
    const name = String(group || '').trim()
    if (!name) throw new Error('分组名不能为空')
    const exists = db.offers.some(
      (o) =>
        o.providerId === source.providerId &&
        (o.group || '') === name &&
        o.upstreamName === source.upstreamName,
    )
    if (exists) throw new Error(`该站「${name}」分组下已经有同名模型了`)
    const copy = {
      ...source,
      id: newId('o'),
      group: name,
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
      const name = String(group || '').trim()
      const clash = db.offers.some(
        (o) =>
          o.id !== id &&
          o.providerId === offer.providerId &&
          (o.group || '') === name &&
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
    return { deleted: id }
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

export async function createGatewayKey({ name, monthlyTokenLimit = null, note = '' }) {
  return mutate((db) => {
    const gateway = db.settings.gateway
    if (!gateway?.keys) throw new Error('网关尚未初始化')
    const record = newGatewayKeyRecord(name)
    record.monthlyTokenLimit =
      monthlyTokenLimit === null || monthlyTokenLimit === '' ? null : Number(monthlyTokenLimit)
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
      record.monthlyTokenLimit =
        patch.monthlyTokenLimit === null || patch.monthlyTokenLimit === ''
          ? null
          : Number(patch.monthlyTokenLimit)
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

export async function recordProbe(record) {
  return mutate((db) => {
    const entry = {
      id: newId('r'),
      ts: nowIso(),
      ...record,
    }
    db.probes.push(entry)
    // 保留最近 5000 条（约一个月的定时探测），长期评分要用
    if (db.probes.length > 5000) db.probes = db.probes.slice(-5000)
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
export async function setGroupRatio(providerId, group, ratio) {
  return mutate((db) => {
    if (!db.providers.some((p) => p.id === providerId)) throw new Error(`站点不存在：${providerId}`)
    const name = String(group || '').trim()
    const value = ratio === null || ratio === undefined || ratio === '' ? null : Number(ratio)
    if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error('倍率需要是 0 或正数')

    let updated = 0
    const siteValues = new Set()
    for (const offer of db.offers) {
      if (offer.providerId !== providerId) continue
      if ((offer.group || '') !== name) continue
      offer.ratio = value
      offer.ratioSource = value === null ? null : value === offer.siteRatio ? 'site' : 'custom'
      if (value !== null) offer.pricingMode = 'ratio'
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
    const name = group === undefined || group === null ? null : String(group).trim()
    let restored = 0
    const noSiteValue = []
    for (const offer of db.offers) {
      if (offer.providerId !== providerId) continue
      if (name !== null && (offer.group || '') !== name) continue
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
 * 累加真实请求的成败。窗口超过 1 小时就重置——
 * 一个站上午挂了下午恢复了，不该被上午的失败一直拖累。
 */
export async function addTraffic(entries, windowMs = TRAFFIC_WINDOW_MS) {
  if (!entries || entries.length === 0) return null
  return mutate((db) => {
    if (!db.traffic || typeof db.traffic !== 'object') db.traffic = {}
    const now = Date.now()
    for (const [offerId, delta] of entries) {
      const row = db.traffic[offerId] || { ok: 0, fail: 0, since: new Date(now).toISOString() }
      if (now - new Date(row.since).getTime() > windowMs) {
        row.ok = 0
        row.fail = 0
        row.since = new Date(now).toISOString()
      }
      row.ok += delta.ok || 0
      row.fail += delta.fail || 0
      db.traffic[offerId] = row
    }
    return db.traffic
  })
}

// ------------------------------------------------------------ 路由决策日志

export async function recordRouting(entry) {
  return mutate((db) => {
    if (!Array.isArray(db.routing)) db.routing = []
    const record = { id: newId('g'), ts: nowIso(), ...entry }
    db.routing.push(record)
    if (db.routing.length > 500) db.routing = db.routing.slice(-500)
    return record
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
