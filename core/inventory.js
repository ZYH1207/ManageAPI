/**
 * 台账层：站点、凭据、模型供给的增删改查。
 * 所有写操作走 mutate()，保证读-改-写原子性。
 */
import { randomUUID, randomBytes } from 'node:crypto'
import { readDb, mutate, encryptSecret, decryptSecret } from './store.js'
// quota.js 只依赖内置类型，不回头 import 本文件，不会形成循环
import { normalizeQuota, resetIfDue, consumeQuota } from './quota.js'
// 登录态编排：凭据解密后调 providers 的登录协议（providers 不回头 import 本文件，无循环）
import * as providers from './providers.js'
// 币种口径的唯一真源（currency.js 零 import，不会成环）
import { declaredPriceCurrency, normalizeCurrency } from './currency.js'
// 速度样本的保留条数与分档口径集中在 speed-profile.js，避免两处各写一个常数
import { SPEED_SAMPLE_KEEP } from './speed-profile.js'

// 站点价目表的币种：落价时由调用方透传，读的时候也从这里取，写读同一个函数
export { declaredPriceCurrency, currencyOf, inferSiteCurrency } from './currency.js'

export function newId(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`
}

export function nowIso() {
  return new Date().toISOString()
}

/**
 * 规范化分组名：去首尾空白 + 内部连续空白收敛成一个空格。
 *
 * **所有写入/比较 offer.group 的地方都必须走这个函数。** 站点在令牌列表里
 * 返回的分组名常带尾随空格（实测「国模-0045 p哥 」比 Key 里存的多个空格），
 * 各处各写一套 trim 就会出现「同步时按 trim 后的键去重、识别分组时又写回
 * 带空格的值」——下一轮同步就匹配不上，每同步一次多插一整套行。
 */
export function normalizeGroup(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ')
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
 * 规范化 API 端点（baseUrl）：去掉尾部斜杠；没写版本号时补 /v1。
 *
 * 这个字段只存 **API 端点**，不存网站地址——网站地址是另一个字段 siteUrl，
 * 给卡片上的「打开站点」链接用。两者分开是因为它们经常不同：
 * 后台在 https://x.com/dashboard，API 在 https://x.com/v1。
 */
/**
 * 规范化 API 端点（baseUrl）：去掉尾部斜杠；没写版本号时补 /v1。
 *
 * 这个字段只存 **API 端点**，不存网站地址——网站地址是另一个字段 siteUrl，
 * 给卡片上的「打开站点」链接用。两者分开是因为它们经常不同：
 * 后台在 https://x.com/dashboard，API 在 https://x.com/v1。
 *
 * 允许为空：新建站点时只要求填网站地址，API 端点在添加 Key 时才填
 * （很多人是先有站、后有 Key，或者一个站有多个端点）。
 */
export function normalizeBaseUrl(input) {
  let url = String(input ?? '').trim()
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  url = url.replace(/\/+$/, '')
  if (!/\/v\d+$/i.test(url)) url = `${url}/v1`
  return url
}

/**
 * 规范化网站地址（siteUrl）：只要求是个 http(s) 地址，不加 /v1、不改路径。
 * 卡片上的「打开站点」直接跳它，所以用户填什么后台地址就该是什么。
 */
export function normalizeSiteUrl(input) {
  let url = String(input ?? '').trim()
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  return url.replace(/\/+$/, '')
}

/**
 * 实际请求用的 API 端点。
 *
 * baseUrl 可以为空（新建站点时只要求填网站地址，端点在加 Key 时才填），
 * 但识别系别、登录、探测、采集这些都要发请求。为空时回落到 siteUrl 的源站：
 *   https://foxapi.xin/dashboard → https://foxapi.xin/v1
 * 否则会拼出 `/api/v1/auth/login` 这种没有主机的地址，报 ERR_INVALID_URL。
 *
 * 注意只回落到「源站 + /v1」：siteUrl 可能带 /dashboard 这类后台路径，
 * 不能直接拿来拼接口。
 */
export function apiBaseOf(provider) {
  const explicit = String(provider?.baseUrl || '').trim()
  if (explicit) return explicit
  const site = String(provider?.siteUrl || '').trim()
  const m = site.match(/^(https?):\/\/([^/]+)/i)
  if (!m) return ''
  return `${m[1].toLowerCase()}://${m[2]}/v1`
}

// ---------------------------------------------------------------- providers

export async function createProvider({ name, baseUrl = '', siteUrl = '', kind = 'unknown', note = '' }) {
  if (!name || !String(name).trim()) throw new Error('站点名称不能为空')
  const normalized = normalizeBaseUrl(baseUrl)
  const site = normalizeSiteUrl(siteUrl)
  // 两个地址至少给一个：否则既不知道去哪请求、也没有可打开的页面
  if (!normalized && !site) throw new Error('网站地址和 API 端点至少要填一个')
  return mutate((db) => {
    if (normalized && db.providers.some((p) => p.baseUrl === normalized)) {
      throw new Error(`该 API 端点已存在：${normalized}`)
    }
    const provider = {
      id: newId('p'),
      name: String(name).trim(),
      // 可以为空：API 端点在添加 Key 时填
      baseUrl: normalized || null,
      // 网站地址：只给卡片上的「打开站点」用，和 API 端点分开
      // （后台常在 /dashboard，API 在 /v1，两者不是一回事）
      siteUrl: site || null,
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
    // API 端点：空串表示清空（还没填 Key 时它就是空的）
    if (patch.baseUrl !== undefined) provider.baseUrl = normalizeBaseUrl(patch.baseUrl) || null
    // 网站地址：空串表示清空（卡片上就不显示「打开站点」了）
    if (patch.siteUrl !== undefined) provider.siteUrl = normalizeSiteUrl(patch.siteUrl) || null
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
    // 登录态簿记：new-api 的管理接口要 New-Api-User，令牌有寿命时要能展示/判断续期
    if (patch.adminUserId !== undefined) {
      provider.adminUserId = patch.adminUserId === null || patch.adminUserId === '' ? null : String(patch.adminUserId)
    }
    if (patch.adminTokenExpiresAt !== undefined) {
      provider.adminTokenExpiresAt = patch.adminTokenExpiresAt || null
    }
    if (patch.tokenRenewedAt !== undefined) provider.tokenRenewedAt = patch.tokenRenewedAt || null
    if (patch.tokenRenewMethod !== undefined) provider.tokenRenewMethod = patch.tokenRenewMethod || null
    if (patch.tokenRenewError !== undefined) provider.tokenRenewError = patch.tokenRenewError || null
    if (patch.currency !== undefined) provider.currency = patch.currency
    // 站点价目表的币种：和「钱包币种」是两件事（见 core/currency.js）。
    // 改它不会动已有供给的价格，只决定之后自动落价写什么币种
    if (patch.priceCurrency !== undefined) {
      const empty = patch.priceCurrency === null || patch.priceCurrency === ''
      provider.priceCurrency = empty ? null : normalizeCurrency(patch.priceCurrency)
      // 用户显式设过 = 他比数据更清楚，自动推断不再覆盖（见 core/currency-reconcile.js）
      provider.priceCurrencySource = empty ? null : 'custom'
    }
    // 站点自述信息（/api/status、Sub2API 公共设置）：只做展示与参考，不参与计价。
    // 「完整同步」顺手抄下来，省得用户再手填站名、版本、客服链接
    if (patch.siteName !== undefined) provider.siteName = patch.siteName || null
    if (patch.siteVersion !== undefined) provider.siteVersion = patch.siteVersion || null
    if (patch.quotaPerUnit !== undefined) {
      provider.siteQuotaPerUnit =
        patch.quotaPerUnit === null || patch.quotaPerUnit === '' ? null : Number(patch.quotaPerUnit)
    }
    if (patch.chatLink !== undefined) provider.chatLink = patch.chatLink || null
    if (patch.topUpLink !== undefined) provider.topUpLink = patch.topUpLink || null
    if (patch.displayInCurrency !== undefined) {
      provider.displayInCurrency = patch.displayInCurrency || null
    }
    // 站点自己公布的价目表来源（channels / plaza / pricing）与最近一次全量同步时间
    if (patch.priceSource !== undefined) provider.priceSource = patch.priceSource || null
    if (patch.lastFullSyncAt !== undefined) provider.lastFullSyncAt = patch.lastFullSyncAt || null
    // 分组价目表：站点公布的全部分组与倍率（不只是我们买的那几个）。
    // 只存档，是「识别分组」与「补齐缺失倍率」的来源，不改任何已有价格口径
    if (patch.siteGroups !== undefined) {
      const list = Array.isArray(patch.siteGroups) ? patch.siteGroups : []
      provider.siteGroups = list
        .map((g) => ({
          name: String(g?.name || '').trim(),
          rate: Number.isFinite(Number(g?.rate)) ? Number(g.rate) : null,
          source: g?.source || null,
        }))
        .filter((g) => g.name)
      provider.siteGroupsAt = nowIso()
    }
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
    }
    if (patch.expiresAt !== undefined) credential.expiresAt = patch.expiresAt
    // 后台令牌列表里这把 Key 的名字与它自带的分组倍率（Sub2API 的 rate_multiplier）。
    // 令牌名常是「我的套餐」这类人话，比我们自己起的 label 更适合当显示名；
    // 倍率只作参考——真落价时仍以价格表/分组倍率为准
    if (patch.tokenName !== undefined) credential.tokenName = patch.tokenName || null
    if (patch.tokenRate !== undefined) {
      credential.tokenRate =
        patch.tokenRate === null || patch.tokenRate === '' ? null : Number(patch.tokenRate)
    }
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
 * 供给的去重键：分组 + 归一化后的模型名。
 *
 * 分组是 Key 的属性（同一把 Key 才能拉到同一个池），模型名要归一化
 * ——`Qwen3.8-Max` / `qwen3.8-max` / `qwen3_8_max` 在站点上就是同一个模型，
 * 按原文比较会让每次同步各插一条，最后比价页同站同模型两行。
 */
export function offerKey(group, upstreamName) {
  return `${normalizeGroup(group)}::${normalizeModelKey(upstreamName)}`
}

/**
 * 换分组时把该 Key 名下的行一起迁到新分组。
 *
 * 分组只认 Key（`credential.group`），`offer.group` 只是「落价时用的分组快照」。
 * 以前改了 Key 分组不动行，而同步又按「分组 + 模型名」去重：
 * 下一次同步就把同名模型当新行插进来，同一模型在旧组、新组各一条。
 * 所以改分组必须当场迁移，先把键对齐，再落价。
 */
export function rekeyCredentialOffers(db, credentialId, nextGroup) {
  const want = normalizeGroup(nextGroup)
  let moved = 0
  for (const offer of db.offers) {
    if (offer.credentialId !== credentialId) continue
    if (normalizeGroup(offer.group) === want) continue
    offer.group = want
    offer.updatedAt = nowIso()
    moved += 1
  }
  return { moved, group: want }
}

/**
 * 合并「同站 + 同 Key + 同模型」的重复行（大小写、换组迁移遗留）。
 *
 * 保留哪一条：已定价的优先（手填价 > 倍率 > 未定价），其次保留更早建的那条，
 * 这样用户手填的价格不会被合并掉。被合并掉的行如果还挂着探针/流量引用，
 * 这些引用会跟着一起清掉（pruneOfferRefs），避免读到已删除的行。
 */
export function planDuplicateMerges(db) {
  const buckets = new Map()
  for (const offer of db.offers) {
    const key = `${offer.providerId}::${offer.credentialId || ''}::${normalizeModelKey(offer.upstreamName)}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(offer)
  }
  const score = (o) => {
    if (o.inPrice !== null && o.inPrice !== undefined) return 3
    if (o.pricingMode === 'ratio' && o.ratio !== null && o.ratio !== undefined) return 2
    return 1
  }
  const merged = []
  const drop = new Set()
  for (const rows of buckets.values()) {
    if (rows.length < 2) continue
    const sorted = [...rows].sort((a, b) => score(b) - score(a) || String(a.listedAt).localeCompare(String(b.listedAt)))
    const keep = sorted[0]
    const gone = sorted.slice(1)
    // 只要其中一条还在售，合并结果就算在售（下线标记只对「本次没返回」有意义）
    if (gone.some((o) => !o.delistedAt) && keep.delistedAt) keep.delistedAt = null
    for (const row of gone) drop.add(row.id)
    merged.push({
      keepId: keep.id,
      keepName: keep.upstreamName,
      providerId: keep.providerId,
      credentialId: keep.credentialId,
      modelKey: normalizeModelKey(keep.upstreamName),
      dropped: gone.map((o) => ({ id: o.id, upstreamName: o.upstreamName, group: o.group })),
    })
  }
  return { merged, drop }
}

/**
 * 按 planDuplicateMerges 的结果真正合并（保留已定价的那条，删掉重复）。
 * 引用（探针/流量）跟着被删的行一起清掉，避免读到不存在的供给。
 */
export function mergeDuplicateOffers(db) {
  const plan = planDuplicateMerges(db)
  if (!plan.drop.size) return { merged: [], droppedCount: 0 }
  db.offers = db.offers.filter((o) => !plan.drop.has(o.id))
  pruneOfferRefs(db, plan.drop)
  return { merged: plan.merged, droppedCount: plan.drop.size }
}

/**
 * 真正「在役」的供给：没下线（delistedAt）、站点没暂停（paused）、模型没被忽略（ignoredModels）。
 * 这是三条过滤规则的唯一实现——比价 / 概览 / 智能决策 / 网关 / 探针目标都从这里取，
 * 任何一侧自己再写一遍迟早漂移（曾出过「暂停站点仍被派流量」「下线模型仍被探测白烧额度」）。
 * 纯函数：只读 db，不改；调用方拿到的是 db.offers 里的原对象，不要原地修改。
 *
 * @param {{ignoreModels?:boolean}} [options] ignoreModels=false 时跳过「忽略模型」这一条。
 *   免费池用这个：用户忽略某个模型通常是因为它在付费比价里碍事，而免费额度是另一回事——
 *   一起藏掉会让免费池少掉本来能用的供给。暂停站点和下线模型仍然照滤
 *   （那两条表示「这条供给不存在」，不是「不想看」）。
 */
export function routeableOffers(db, { ignoreModels = true } = {}) {
  const pausedIds = new Set(db.providers.filter((p) => p.paused).map((p) => p.id))
  const ignored = ignoreModels
    ? new Set((db.settings?.ignoredModels || []).map((name) => normalizeModelKey(String(name))))
    : new Set()
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
    const provider = db.providers.find((p) => p.id === providerId)
    if (!provider) throw new Error(`站点不存在：${providerId}`)
    // 新供给的币种跟随站点价目表（默认美元），别在这里写死——写死一处就多一个口径
    const siteCurrency = declaredPriceCurrency(provider) || normalizeCurrency(provider.currency)
    const g = normalizeGroup(group)
    // 按「分组 + 模型名」去重：同一个站的不同分组可以有同名模型。
    // 两侧都走 normalizeGroup——老数据的分组名可能带尾随空格，
    // 只归一化新键会造成「永远匹配不上、每轮多插一批」
    // 模型名也要归一化：`Qwen3.8-Max` 与 `qwen3.8-max` 是同一个模型，
    // 只按原文比较会让每次同步各插入一条（比价页同站同模型出现两行）。
    const existing = new Map(
      db.offers
        .filter((o) => o.providerId === providerId)
        .map((o) => [offerKey(o.group, o.upstreamName), o]),
    )
    let added = 0
    let revived = 0
    for (const upstreamName of models) {
      const dedupeKey = offerKey(g, upstreamName)
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
      const created = {
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
        currency: siteCurrency,
        // 币种来源：'site' = 跟站点价目表（自动落价可以覆盖）；
        // 'custom' = 用户手填（自动落价不碰）。见 core/currency.js
        currencySource: 'site',
        priceUnit: 'per_mtok',
        listedAt: nowIso(),
        updatedAt: nowIso(),
      }
      db.offers.push(created)
      // 同一批里出现两次同名（站点自己列重了、大小写两版）：新行也要进索引，
      // 否则只在「进循环之前的快照」里查，本批第二条会再插一条重复
      existing.set(dedupeKey, created)
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
    if (hasDuplicateOffer(db, { providerId: source.providerId, group: name, upstreamName: source.upstreamName })) {
      throw new Error(`该站「${name}」分组下已经有同名模型了`)
    }
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

/**
 * 同站同分组下是否已有同名模型。
 *
 * duplicateOffer 用默认的 excludeId=null（要求目标分组里完全没有这个模型）；
 * PATCH 路由传当前行 id（允许改自己、只防撞别人）。
 */
export function hasDuplicateOffer(db, { providerId, group, upstreamName, excludeId = null }) {
  const name = normalizeGroup(group)
  return db.offers.some(
    (o) =>
      o.id !== excludeId &&
      o.providerId === providerId &&
      normalizeGroup(o.group) === name &&
      normalizeModelKey(o.upstreamName) === normalizeModelKey(upstreamName),
  )
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
export async function markDelisted(providerId, credentialId, keepNames, group = '') {
  const keep = new Set(keepNames)
  // 分组也要参与判断：同一把 Key 在多个分组下可以有同名模型，只按 upstreamName
  // 会「A 分组还在用、B 分组已下线」时把两边一起标记/复活。
  // 不传 group 时保持旧行为（按 credentialId 全覆盖），兼容其它调用点。
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

/**
 * 按站点给的分组价格信息给一条供给落价。apply-group（用户选分组）与
 * detect-groups（后台识别分组）共用——此前两处各写一遍三分支，已经漂移过一次。
 *
 * 三分支（顺序固定）：
 *  1. 站点把模型标成 0 价 → 免费（manual + 双零价）。「免费模型」分组往往倍率
 *     写 1，真正免费体现在原价上，必须先判这条，否则会被「基准价 × 倍率」算回原价。
 *     只认本分组精确命中（exact）——全站同名回落拿到的是别的分组的价格，判免费会误伤。
 *  2. 有基准价且倍率已知 → 倍率模式（ratio = rate）。不依赖广场的绝对价，
 *     站点没开模型广场时这条路仍然能走通。
 *  3. 只有渠道/广场的模型原价 → 原价 × 倍率直接填绝对价（manual）。
 *
 * 只改价格字段，不碰 offer.group——分组归属是调用方的语义（一边按用户选择、
 * 一边按后台识别）。返回落价方式：'free' | 'percall' | 'ratio' | 'manual' | 'skip'
 * （skip = 信息不足，调用方只记分组、价格留给用户填）。
 *
 * currency：站点价目表的币种（调用方用 declaredPriceCurrency(provider) 取，没有就传 null 让本函数沿用这条供给原来的币种）。落价同时
 * 把币种写对——广场/channels 不带币种字段，以前这里猜 'CNY'，美元标价站的价
 * 会被当成人民币，`offerCost` 再除一次汇率，比价直接便宜 6.68 倍。
 */
export function applySitePricing(offer, { exact, rate, sitePrice, hasBench, currency, benchCurrency }) {
  const siteRatio = typeof rate === 'number' ? rate : null
  // 调用方没给（站点还没声明也没推断出来）就沿用这条供给自己的币种：
  // 存量数据里币种本来就是对的，不能被一个默认值静默翻转
  const siteCurrency = currency ? normalizeCurrency(currency) : normalizeCurrency(offer.currency)

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
    offer.currency = siteCurrency
    offer.currencySource = 'site'
    offer.pricingMode = 'manual'
    offer.ratio = null
    offer.siteRatio = siteRatio
    offer.ratioSource = 'site'
    return 'percall'
  }

  // 从按次切回按量：不清掉单位的话，per_call 会带着 token 价格一起留着
  if (offer.priceUnit === 'per_call') offer.priceUnit = 'per_mtok'

  if (exact && exact.inPrice === 0 && exact.outPrice === 0) {
    offer.pricingMode = 'manual'
    offer.ratio = null
    offer.inPrice = 0
    offer.outPrice = 0
    offer.currency = siteCurrency
    offer.currencySource = 'site'
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

  // 有基准价 + 站点倍率：默认走倍率模式（改倍率能一键重算全组）。
  // **但站点给了自己的原价时，必须用它而不是我们的基准价**——两者常常不等
  // （实测 codexpert 站点原价 3.00/M，我们基准价 2/M），用基准价 × 倍率
  // 会少算 33%，而站点实际是按自己的原价扣的。
  // 所以这里把站点原价落成绝对价，同时保留倍率（改倍率时按原价重算：
  // siteBase 记下原价，倍率模式仍是权威开关）。
  if (siteRatio !== null && hasBench) {
    const hasSiteBase =
      sitePrice &&
      sitePrice.inPrice !== null && sitePrice.inPrice !== undefined &&
      sitePrice.outPrice !== null && sitePrice.outPrice !== undefined
    if (hasSiteBase) {
      const mult = siteRatio
      offer.ratio = siteRatio
      offer.siteRatio = siteRatio
      offer.ratioSource = 'site'
      offer.pricingMode = 'manual'
      offer.inPrice = Math.round(Number(sitePrice.inPrice) * mult * 1000) / 1000
      offer.outPrice = Math.round(Number(sitePrice.outPrice) * mult * 1000) / 1000
      // 记下站点原价，供倍率变化时重算（见 setGroupRatio）
      offer.siteBaseIn = Number(sitePrice.inPrice)
      offer.siteBaseOut = Number(sitePrice.outPrice)
      offer.currency = siteCurrency
      offer.currencySource = 'site'
      if (sitePrice.cacheReadPrice != null) {
        offer.cacheReadPrice = Math.round(Number(sitePrice.cacheReadPrice) * mult * 1000) / 1000
      }
      if (sitePrice.cacheWritePrice != null) {
        offer.cacheWritePrice = Math.round(Number(sitePrice.cacheWritePrice) * mult * 1000) / 1000
      }
      return 'site-base'
    }
    offer.ratio = siteRatio
    offer.siteRatio = siteRatio
    offer.ratioSource = 'site'
    offer.pricingMode = 'ratio'
    offer.inPrice = null
    offer.outPrice = null
    // 倍率模式没有自己的报价：价格由「基准价 × 倍率」算出来，币种就是基准价的币种。
    // 以前这里不写币种，行上留着上次落价的币种 → 显示美元、实际按人民币算，
    // 用户一旦切成手填，同一串数字就被当美元读，差一个汇率
    offer.currency = normalizeCurrency(benchCurrency || offer.currency)
    offer.currencySource = 'bench'
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
    // 币种取站点价目表的口径（见 core/currency.js），不再写死 CNY、也不再靠
    // sitePrice.currency 这个「广场层猜的字段」——广场接口根本不给币种
    offer.currency = siteCurrency
    offer.currencySource = 'site'
    offer.pricingMode = 'manual'
    offer.ratio = null
    offer.siteRatio = siteRatio
    offer.ratioSource = 'site'
    return 'manual'
  }

  return 'skip'
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
      offer.ratio = value
      offer.ratioSource = value === null ? null : value === offer.siteRatio ? 'site' : 'custom'
      // 落过「站点原价 × 倍率」绝对价的行走绝对价模式：改倍率就按站点原价重算。
      // 否则倍率开关对这类行失效（它们已经不吃倍率了）
      const hasSiteBase =
        Number.isFinite(Number(offer.siteBaseIn)) && Number.isFinite(Number(offer.siteBaseOut))
      if (hasSiteBase && value !== null) {
        offer.pricingMode = 'manual'
        offer.inPrice = Math.round(Number(offer.siteBaseIn) * value * 1000) / 1000
        offer.outPrice = Math.round(Number(offer.siteBaseOut) * value * 1000) / 1000
      } else {
        // 清空倍率要同步回手填模式：pricingMode 是定价的权威开关（pricing.js 的约定），
        // 留着 'ratio' + ratio=null + 无手填价会变成自相矛盾的「未定价」行
        offer.pricingMode = value === null ? 'manual' : 'ratio'
      }
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
    // 离谱的样本单独标出来：比的是「上报 − 缓存命中」而不是 raw 上报值。
    // 站点上报的 prompt_tokens 含缓存部分，缓存命中 99% 时 raw 值必然远超本地
    // 估算，但那部分按缓存价（通常 1/10 价）收，不是多算钱——拿 raw 比会全是假阳性。
    // 绝对值下限与 quality-signals.js 的 BILLING_MIN_TOKENS 一致：短请求的
    // 字符启发式误差按比例放大后没有判定意义。
    const billedInput = Math.max(0, row.reportedPrompt - row.reportedCached)
    row.billedInput = billedInput
    row.suspicious = billedInput >= 800 && billedInput > row.localTokens * 2
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
    const atIso = new Date(now).toISOString()
    for (const [offerId, delta] of entries) {
      // 速度样本单独存一份「长期」档：可用率只关心最近 1 小时，但「这个站快不快」
      // 是相对稳定的属性，只留 1 小时会随窗口滚动而闪断（决策页的体验分跟着抖）。
      // 所以窗口滚动时只清 ok/fail，速度样本保留最近 SPEED_SAMPLE_KEEP 条。
      const prevSpeed = db.traffic?.[offerId]?.speed || null
      const row = db.traffic[offerId] || { ok: 0, fail: 0, since: atIso, kinds: {}, quality: { samples: 0, bad: 0 } }
      if (now - new Date(row.since).getTime() > windowMs) {
        row.ok = 0
        row.fail = 0
        row.since = atIso
        row.kinds = {}
        row.lastOkAt = null
        row.lastFailAt = null
        row.quality = { samples: 0, bad: 0 }
      }
      row.ok += delta.ok || 0
      row.fail += delta.fail || 0
      if (delta.ok) row.lastOkAt = atIso
      if (delta.fail) row.lastFailAt = atIso
      // 真实响应的质量信号（空回答 / 计费虚报）：探针之外的第二类完整性证据
      if (delta.quality) {
        if (!row.quality || typeof row.quality !== 'object') row.quality = { samples: 0, bad: 0 }
        row.quality.samples += delta.quality.samples || 0
        row.quality.bad += delta.quality.bad || 0
      }
      // 真实流量的速度画像：只累计「有效样本」（成功、有 token、有首字），
      // 用来判断探针测出来的快慢能不能代表真实工况——探针发的是 1k 级短请求，
      // 而真实请求常常是十几万 token 的长前缀，两者的首字根本不是一个量纲。
      //
      // 每条样本都要带上它自己的 prompt 大小：首字不是站点常数，是 prompt 大小的函数
      // （实测同一站 50–120k 档 5.3s、200k 以上 34.9s，缓存都自报 99%）。
      // 不带大小的样本只能进「全档」，参与不了同档比较。
      if (delta.speed) {
        if (!row.speed || typeof row.speed !== 'object') row.speed = prevSpeed && typeof prevSpeed === 'object' ? prevSpeed : { samples: 0, rows: [] }
        const speed = row.speed
        if (!Array.isArray(speed.rows)) speed.rows = []
        // 兼容老调用方：只给 {ttftMs, tps} 的也收，当成「大小未知」的样本
        const incoming = Array.isArray(delta.speed.rows)
          ? delta.speed.rows
          : Number.isFinite(Number(delta.speed.ttftMs))
            ? [delta.speed]
            : []
        for (const sample of incoming) {
          const ttft = Number(sample?.ttftMs)
          if (!Number.isFinite(ttft) || ttft <= 0) continue
          const tps = Number(sample?.tps)
          const promptTokens = Number(sample?.promptTokens)
          const cachedTokens = Number(sample?.cachedTokens)
          speed.rows.push({
            ttftMs: Math.round(ttft),
            tps: Number.isFinite(tps) && tps > 0 ? Math.round(tps * 10) / 10 : null,
            // prompt 大小决定了这条样本属于哪一档；没有就留 null（只能进全档）
            promptTokens: Number.isFinite(promptTokens) && promptTokens > 0 ? Math.round(promptTokens) : null,
            cachedTokens: Number.isFinite(cachedTokens) && cachedTokens >= 0 ? Math.round(cachedTokens) : null,
            // 断流的请求只测到了首字（我们没等它解码完），留着但不贡献解码速度；
            // clean=true 表示上游其实交付完了（finish_reason 收到），只是客户端先关了连接
            aborted: Boolean(sample?.aborted),
            clean: Boolean(sample?.clean),
            at: sample?.at || atIso,
          })
        }
        if (speed.rows.length > SPEED_SAMPLE_KEEP) speed.rows.splice(0, speed.rows.length - SPEED_SAMPLE_KEEP)
        // 计数器由样本推出来，不再「每次落盘 +1」：
        // 早先那版不管有没有样本都自增，db 里攒出 samples=243 却一条数组都没有的假账
        speed.samples = speed.rows.length
        // 老格式（两条平行数组）由 rows 派生，score.js 与前端的老路径照旧能读
        speed.ttftMs = speed.rows.map((sample) => sample.ttftMs)
        speed.tps = speed.rows.map((sample) => sample.tps).filter((value) => value !== null)
      }
      if (delta.kinds) {
        if (!row.kinds || typeof row.kinds !== 'object') row.kinds = {}
        for (const [kind, count] of Object.entries(delta.kinds)) {
          if (!count) continue
          const current = row.kinds[kind] || { n: 0, lastAt: null }
          current.n += count
          current.lastAt = atIso
          row.kinds[kind] = current
        }
      }
      db.traffic[offerId] = row
    }
    return db.traffic
  })
}

// ------------------------------------------------------------ 路由决策日志

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
      .detectProviderKind({ baseUrl: apiBaseOf(provider), timeoutMs: 5000 })
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
    baseUrl: apiBaseOf(provider),
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
    p.adminUserId = result.userId || p.adminUserId || null
    p.adminTokenExpiresAt = result.expiresAt || null
    p.tokenRenewedAt = nowIso()
    p.tokenRenewMethod = 'login'
    p.tokenRenewError = null
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
 * 刷新令牌是旋转式的（用一次就换新），所以同站并发 401 必须共享同一次续期：
 * 否则第二个请求会拿着刚被作废的 refresh_token 去打站点，把会话彻底搞死。
 */
const renewals = new Map()

/**
 * 401 时的自动续期。两条路，按「不打扰用户」排序：
 *   1. Sub2API 的 refresh_token 静默刷新（不需要密码，也不碰验证码）
 *   2. 账号密码重登（只对密码登录存的凭据有效）
 * 冷却内直接返回「不可用」（按普通 401 处理，不硬刚站点风控）；
 * 手动令牌（adminTokenSource='manual'）不自动覆盖——用户手动填的
 * 说明他知道自己有什么，自动换掉反而丢信息。
 *
 * @returns {Promise<{ok:boolean, token?:string, method?:string, reason?:string}>}
 */
export function autoRelogin(providerId) {
  if (renewals.has(providerId)) return renewals.get(providerId)
  const pending = renewProviderSession(providerId).finally(() => renewals.delete(providerId))
  renewals.set(providerId, pending)
  return pending
}

async function renewProviderSession(providerId) {
  const db = await readDb()
  const provider = db.providers.find((p) => p.id === providerId)
  if (!provider) return { ok: false, reason: '站点不存在' }
  if (provider.adminTokenSource === 'manual') {
    return { ok: false, reason: '手动令牌不做自动覆盖' }
  }
  // 导入型会话只有 refresh_token，没有密码；刷新不成就只能请用户重新导入
  const imported = provider.adminTokenSource === 'session'
  const canRefresh = provider.kind === 'sub2api' && Boolean(provider.refreshTokenEnc)
  if (!provider.loginCred && !canRefresh) {
    return { ok: false, reason: imported ? '这个站的会话没有刷新令牌，请重新登录并导入登录响应' : '没有登录凭据' }
  }
  if (!reloginAllowed(providerId)) {
    return { ok: false, reason: '自动重登冷却中（10 分钟内已尝试过）' }
  }
  markRelogin(providerId)
  try {
    let result = null
    let method = 'login'
    if (canRefresh) {
      try {
        result = await providers.refreshProviderToken({
          baseUrl: apiBaseOf(provider),
          refreshToken: await decryptSecret(provider.refreshTokenEnc),
        })
        method = 'refresh'
      } catch (error) {
        // 只有站方明确拒绝（4xx）才判定刷新凭据失效；超时/5xx 是站点抽风，不逼迫用户重登
        const denied = [400, 401, 403, 404, 405].includes(error.status)
        if (imported) {
          throw new Error(
            denied
              ? '站点的刷新会话已失效，请在浏览器重新登录后导入新的登录响应'
              : `刷新会话暂时失败（${String(error.message || error).slice(0, 120)}），稍后会重试`,
          )
        }
        if (!denied || !provider.loginCred) throw error
      }
    }
    if (!result) {
      if (imported) throw new Error('这个会话无法刷新，请重新登录后导入登录响应')
      const plain = JSON.parse(await decryptSecret(provider.loginCred))
      result = await providers.loginProvider({
        baseUrl: apiBaseOf(provider),
        kind: provider.kind === 'relay' ? undefined : provider.kind,
        user: plain.user,
        password: plain.password,
      })
    }
    const tokenEnc = await encryptSecret(result.token)
    const refreshEnc = result.refreshToken ? await encryptSecret(result.refreshToken) : null
    const saved = await mutate((db) => {
      const p = db.providers.find((x) => x.id === providerId)
      // 网络请求期间用户换了令牌或账号，就不覆盖他的新选择
      if (
        !p ||
        ['baseUrl', 'kind', 'adminToken', 'adminTokenSource', 'refreshTokenEnc', 'loginCred', 'adminUserId']
          .some((key) => JSON.stringify(p[key]) !== JSON.stringify(provider[key]))
      ) {
        return false
      }
      p.adminToken = tokenEnc
      p.adminTokenTail = String(result.token).slice(-6)
      if (refreshEnc) p.refreshTokenEnc = refreshEnc
      p.adminUserId = result.userId || p.adminUserId || null
      p.adminTokenExpiresAt = result.expiresAt || null
      p.tokenRenewedAt = nowIso()
      p.tokenRenewMethod = method
      p.tokenRenewError = null
      p.tokenStatus = 'ok'
      p.tokenStatusAt = nowIso()
      p.tokenStatusMessage = null
      p.updatedAt = nowIso()
      return true
    })
    if (!saved) return { ok: false, reason: '令牌已被更换，本次续期没有覆盖' }
    // 短寿命令牌不能被固定 10 分钟冷却锁死：成功后的保护窗口取剩余寿命的一半
    const remaining = Date.parse(result.expiresAt) - Date.now()
    if (Number.isFinite(remaining) && remaining > 0) {
      const readyAt = Date.now() + Math.min(remaining / 2, RELOGIN_COOLDOWN_MS)
      reloginAt.set(providerId, readyAt - RELOGIN_COOLDOWN_MS)
    }
    return { ok: true, token: result.token, method }
  } catch (error) {
    const message = error.message || String(error)
    // 只有「凭据/鉴权本身有问题」才把令牌标成失效；网络超时、loginCred 解密失败、
    // 响应解析失败都不算令牌的错——与 setTokenStatus 的口径一致（null 表示没结论），
    // 否则一次网络抖动就会把站点卡标红，误导用户去重新登录。
    const authProblem = /HTTP (401|403)|登录被拒绝|密码|账号|人机验证|验证码|2fa|totp/i.test(message)
    if (authProblem) {
      await mutate((db) => {
        const p = db.providers.find((x) => x.id === providerId)
        if (p) {
          p.tokenStatus = 'invalid'
          p.tokenStatusAt = nowIso()
          p.tokenStatusMessage = message
          p.tokenRenewError = message
          p.updatedAt = nowIso()
        }
      })
    }
    return { ok: false, reason: message }
  }
}

/**
 * 解析「从浏览器里拿到的登录响应」。
 *
 * 站点开了人机验证时，账号密码直连这条路是封死的（也不该去破解验证码）。
 * 用户能在浏览器里自己过验证码，那就把浏览器拿到的 access_token / refresh_token
 * 交给我们：之后靠 refresh 静默续期，不用反复登录。
 *
 * 接受的对象形态很多（sub2api 的 {data:{access_token,refresh_token}}、new-api 的
 * {data:{token}}、直接贴 access_token 字符串），所以这里全部宽松识别，只在
 * 「一个令牌都找不到」时报错。
 */
export function parseProviderSession(input) {
  let raw = input
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) throw new Error('登录响应是空的')
    // 允许直接贴裸令牌（有的站只在控制台给一串 access_token）
    if (!text.startsWith('{') && !text.startsWith('"')) {
      return { token: text.replace(/^Bearer\s+/i, ''), refreshToken: null, expiresAt: null }
    }
    try {
      raw = JSON.parse(text)
    } catch {
      throw new Error('这段内容不是 JSON，也不是一个令牌：请贴站点登录接口返回的完整响应')
    }
  }
  if (!raw || typeof raw !== 'object') throw new Error('登录响应格式不认识')
  const layers = [raw, raw.data, raw.result, raw.session, raw.token]
  const pick = (keys) => {
    for (const layer of layers) {
      if (!layer || typeof layer !== 'object') continue
      for (const key of keys) {
        const value = layer[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
    }
    return null
  }
  const token = pick(['access_token', 'accessToken', 'token'])
  if (!token) throw new Error('登录响应里没有 access_token / token')
  const refreshToken = pick(['refresh_token', 'refreshToken'])
  // 有效期：优先绝对值字段，其次 expires_in（秒）
  const forLayer = (keys) => {
    for (const layer of layers) {
      if (!layer || typeof layer !== 'object') continue
      for (const key of keys) if (layer[key] !== undefined && layer[key] !== null && layer[key] !== '') return layer[key]
    }
    return null
  }
  const absolute = forLayer(['access_expires_at', 'expires_at', 'expiresAt'])
  const expiresIn = Number(forLayer(['expires_in', 'expiresIn']))
  let expiresAt = null
  if (absolute !== null) {
    const n = Number(absolute)
    const ms = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(String(absolute))
    if (Number.isFinite(ms) && ms > 0) expiresAt = new Date(ms).toISOString()
  } else if (Number.isFinite(expiresIn) && expiresIn > 0) {
    expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
  }
  return { token: token.replace(/^Bearer\s+/i, ''), refreshToken, expiresAt }
}

/**
 * 导入浏览器里拿到的登录响应：先用它真打一次站点接口验证，再写回 adminToken。
 *
 * 为什么不直接存：用户可能贴的是过期令牌、粘错站点的响应、或者只截了一半。
 * 一次 /api/user/self（或 sub2api 的 /user/profile）就能证明「这枚令牌有权限」，
 * 顺带拿到 new-api 必需的 userId。
 */
export async function importProviderSession(providerId, input) {
  if (renewals.has(providerId)) throw new Error('此站正在更新令牌，请稍后再试')
  const pending = importAndSaveSession(providerId, input).finally(() => renewals.delete(providerId))
  renewals.set(providerId, pending)
  return pending
}

async function importAndSaveSession(providerId, input) {
  const provider = (await readDb()).providers.find((p) => p.id === providerId)
  if (!provider) throw new Error(`站点不存在：${providerId}`)
  const session = parseProviderSession(input)
  const verified = await providers.fetchSessionProfile({
    baseUrl: apiBaseOf(provider),
    token: session.token,
    userId: provider.adminUserId,
    kind: ['sub2api', 'one-api', 'new-api'].includes(provider.kind) ? provider.kind : undefined,
  })
  const tokenEnc = await encryptSecret(session.token)
  const refreshEnc = session.refreshToken ? await encryptSecret(session.refreshToken) : null
  await mutate((db) => {
    const p = db.providers.find((item) => item.id === providerId)
    const same =
      p &&
      ['baseUrl', 'kind', 'adminToken', 'adminTokenSource', 'refreshTokenEnc', 'loginCred', 'adminUserId'].every(
        (key) => JSON.stringify(p[key]) === JSON.stringify(provider[key]),
      )
    if (!same) throw new Error('校验期间站点地址或凭据已改变，本次导入没有覆盖，请重新导入')
    p.adminToken = tokenEnc
    p.adminTokenTail = session.token.slice(-6)
    p.adminTokenSource = 'session'
    p.refreshTokenEnc = refreshEnc
    p.loginCred = null
    p.adminTokenExpiresAt = session.expiresAt
    p.adminUserId = verified.userId || p.adminUserId || null
    if (verified.kind) {
      p.kind = verified.kind
      p.kindSource = 'auto'
    }
    p.tokenRenewedAt = nowIso()
    p.tokenRenewMethod = 'session-import'
    p.tokenRenewError = null
    p.tokenStatus = 'ok'
    p.tokenStatusAt = nowIso()
    p.tokenStatusMessage = null
    p.updatedAt = nowIso()
  })
  clearReloginCooldown(providerId)
  return {
    ok: true,
    kind: verified.kind,
    renewable: Boolean(refreshEnc),
    expiresAt: session.expiresAt,
    userId: verified.userId,
  }
}
