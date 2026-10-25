/**
 * 出站请求层：从站点拉模型列表、尽力探测余额。
 *
 * 刻意保守：余额接口各家实现不一（one-api 要系统令牌，new-api 又不同），
 * 拉不到就如实返回原因，绝不猜一个数字填进台账。
 */
import { fetchModelPlaza, flattenPlaza } from './model-plaza.js'
import { readVendorBalance } from './balance.js'

function describeHttpError(status, bodyText) {
  const snippet = String(bodyText || '').slice(0, 180).replace(/\s+/g, ' ').trim()
  if (status === 401 || status === 403) return `Key 无效或无权限（HTTP ${status}）${snippet ? `：${snippet}` : ''}`
  if (status === 404) return `接口不存在（HTTP 404），检查地址是否该带 /v1`
  if (status === 429) return `被限流（HTTP 429）`
  if (status >= 500) return `站点异常（HTTP ${status}）${snippet ? `：${snippet}` : ''}`
  return `请求失败（HTTP ${status}）${snippet ? `：${snippet}` : ''}`
}

async function requestJson(url, { apiKey, timeoutMs = 15000, headers = {} } = {}) {
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new Error(`请求超时（${timeoutMs}ms）：${url}`)
    const cause = error?.cause?.code || error?.code || error?.message || 'unknown'
    throw new Error(`连接失败（${cause}）：${url}`)
  }
  const text = await response.text()
  if (!response.ok) {
    const error = new Error(describeHttpError(response.status, text))
    // 调用方要区分「令牌失效」和「网络/结构问题」，所以把状态码挂到错误上
    error.status = response.status
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`返回的不是 JSON：${text.slice(0, 120)}`)
  }
}

/**
 * 从 baseUrl 里取「协议 + 主机」。
 *
 * 协议必须跟着用户填的走：自建/内网站点多半是纯 http（常带端口），硬拼 https 连都连不上。
 * 之前这几处都写死了 https，导致这类站的「识别分组」「令牌列表」「余额」全部失败。
 */
function originOf(baseUrl, { stripApiPrefix = false } = {}) {
  const match = String(baseUrl || '').match(/^(https?):\/\/([^/]+)/i)
  if (!match) return ''
  const host = stripApiPrefix ? match[2].replace(/^api\./i, '') : match[2]
  return `${match[1].toLowerCase()}://${host}`
}

/** 同一站点可能有 api. 前缀，两种主机都值得试一次（去重、保持顺序） */
function originCandidates(baseUrl, { stripApiPrefix = true } = {}) {
  const list = [originOf(baseUrl), stripApiPrefix ? originOf(baseUrl, { stripApiPrefix: true }) : '']
  return [...new Set(list.filter(Boolean))]
}

/** 兼容几种常见返回形态，抽出模型 id 列表。 */function extractModelIds(payload) {
  const list = Array.isArray(payload) ? payload : payload?.data || payload?.models || []
  const ids = []
  for (const item of list) {
    if (typeof item === 'string') ids.push(item)
    else if (item && typeof item === 'object') {
      const id = item.id || item.model || item.name
      if (id) ids.push(String(id))
    }
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

/**
 * 拉取模型列表。成功即代表这条 Key 到该站是通的。
 * @returns {{models:string[], raw:number, elapsedMs:number}}
 */
export async function listModels({ baseUrl, apiKey, timeoutMs = 15000 }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/models`
  const started = Date.now()
  const payload = await requestJson(url, { apiKey, timeoutMs })
  const models = extractModelIds(payload)
  if (models.length === 0) {
    throw new Error('接口通了但没有返回任何模型，可能是该站未开放 /v1/models')
  }
  return { models, raw: models.length, elapsedMs: Date.now() - started }
}

/**
 * 尽力读取余额。读不到是常态，返回原因供界面提示，不抛错。
 *
 * 现实情况：one-api / new-api 的 /api/user/self 需要「用户访问令牌」（登录后
 * 在设置里生成），不是 sk- key；不少站直接关了这些接口；自建网关更是只有 /v1/*。
 * 所以失败时给出可执行的建议，而不是一个技术错误码。
 *
 * @returns {{ok:boolean, remaining?:number, currency?:string, reason?:string}}
 */
export async function tryBalance({ baseUrl, apiKey, adminToken, timeoutMs = 10000 }) {
  // 模型厂商有专用余额接口，先试它——这类接口不认 one-api 的 /api/user/self
  const vendor = await readVendorBalance({ baseUrl, apiKey, timeoutMs, requestJson })
  if (vendor) return vendor

  const origins = originCandidates(baseUrl)

  // 有管理令牌时优先走账户接口：Sub2API 用 /api/v1/user/profile，one-api 系用 /api/user/self
  if (adminToken) {
    let lastError = null
    // 单独记鉴权失败：多 origin 轮询时「A 域名 401 + B 域名 404」的最后错误是 404，
    // 只看 lastError 会把令牌失效漏掉——令牌永远不标红
    let authError = null
    for (const origin of origins) {
      for (const path of ['/api/v1/user/profile', '/api/user/self']) {
        try {
          const payload = await requestJson(`${origin}${path}`, { apiKey: adminToken, timeoutMs })
          const data = payload?.data ?? payload
          // Sub2API 这类直接给货币值；这类中转站几乎都按美元计价，
          // 只有明确写了 currency 才当人民币
          const money = data?.balance ?? data?.credits
          if (typeof money === 'number') {
            return {
              ok: true,
              remaining: money,
              currency: String(data?.currency || '').toUpperCase() === 'CNY' ? 'CNY' : 'USD',
              via: 'admin-token',
            }
          }
          // one-api / new-api 的 quota 是内部计费单位（1/500000 美元），不是钱
          const quota = data?.quota ?? data?.remain_quota ?? data?.remaining
          if (typeof quota === 'number') {
            return {
              ok: true,
              remaining: Math.round((quota / 500000) * 100) / 100,
              currency: 'USD',
              via: 'admin-token-quota',
            }
          }
          return {
            ok: false,
            reason: `管理接口通了，但没认出余额字段。返回片段：${JSON.stringify(data).slice(0, 140)}`,
          }
        } catch (error) {
          lastError = error
          if (/HTTP (401|403)/.test(String(error?.message || ''))) authError = error
        }
      }
    }
    if (authError) {
      return { ok: false, reason: '管理令牌已失效（401），请重新从浏览器复制一个，或手动填余额。' }
    }
  }

  // 回落到 sk- key 的老路
  const origin = String(baseUrl).replace(/\/v\d+\/?$/i, '').replace(/\/+$/, '')
  const candidates = [`${origin}/api/user/self`, `${origin}/api/user/dashboard`]
  let lastError = null

  for (const url of candidates) {
    try {
      const payload = await requestJson(url, { apiKey, timeoutMs })
      const data = payload?.data ?? payload
      const remaining = data?.quota ?? data?.balance ?? data?.remain_quota
      if (typeof remaining === 'number') {
        // one-api 的 quota 单位是 1/500000 美元，换算成美元更直观
        const isQuota = data?.quota !== undefined
        return {
          ok: true,
          remaining: isQuota ? Math.round((remaining / 500000) * 100) / 100 : remaining,
          // 裸 balance 字段多半是美元余额；只有站点显式声明 CNY 才算人民币
          currency: isQuota || String(data?.currency || '').toUpperCase() !== 'CNY' ? 'USD' : 'CNY',
        }
      }
      return { ok: false, reason: '接口能访问，但返回里没有可识别的余额字段（quota / balance）' }
    } catch (error) {
      lastError = error
    }
  }

  const message = lastError?.message || ''
  if (message.includes('404')) {
    return {
      ok: false,
      reason:
        '该站没有对 API Key 开放余额接口（返回 404）。可以在 Key 那行点「令牌」填一个后台登录令牌，或者直接手动填余额。',
    }
  }
  if (message.includes('401') || message.includes('403')) {
    return {
      ok: false,
      reason: '余额接口需要「用户访问令牌」，不是 sk- key。点 Key 那行的「令牌」填一个，或者手动填余额。',
    }
  }
  return { ok: false, reason: `余额接口不可用：${message || '未知原因'}。可手动填余额。` }
}

/**
 * 多把 Key 依次试余额，任何一把成功即返回；全失败时返回最后一次的结果。
 * 背景：用户常常在旧 Key 过期后又加新的，「只试第一把」会让余额永远失败，
 * 而模型同步（sync 路由）早就改成所有 Key 都试了，两边口径应当一致。
 * 管理令牌失效时换 Key 也救不了，直接短路返回。
 */
export async function tryBalanceWithKeys({ baseUrl, apiKeys = [], adminToken, timeoutMs = 10000 }) {
  const keys = apiKeys.filter(Boolean)
  if (keys.length === 0) return tryBalance({ baseUrl, apiKey: '', adminToken, timeoutMs })
  let last = null
  for (const apiKey of keys) {
    const result = await tryBalance({ baseUrl, apiKey, adminToken, timeoutMs })
    if (result.ok) return result
    last = result
    if (adminToken && String(result.reason || '').includes('管理令牌已失效')) return result
  }
  return last
}

/**
 * 拉取「可用渠道」列表（Sub2API 的 /api/v1/channels/available）。
 *
 * 结构是三层嵌套，分组藏在第二层：
 *   data[] → { name(渠道名), platforms[] → { groups[], supported_models[] } }
 * 每个 group 有 rate_multiplier（倍率），每个 model 有 pricing（原价）。
 *
 * 这个接口比模型广场更通用——不需要站开启广场，有登录令牌就能读。
 *
 * @returns {Promise<{groups:Array, models:Array, raw:any}>}
 */
export async function fetchAvailableChannels({ baseUrl, adminToken, timeoutMs = 10000 }) {
  const origin = originOf(baseUrl, { stripApiPrefix: true })
  if (!origin) throw new Error(`站点地址无法解析：${baseUrl}`)
  const payload = await requestJson(`${origin}/api/v1/channels/available`, {
    apiKey: adminToken,
    timeoutMs,
  })

  const channels = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : []

  const groups = []
  const models = []
  for (const channel of channels) {
    if (!channel || typeof channel !== 'object') continue
    for (const platform of channel.platforms || []) {
      for (const group of platform.groups || []) {
        if (!group?.name) continue
        groups.push({
          name: String(group.name),
          rate: group.rate_multiplier === null || group.rate_multiplier === undefined
            ? null
            : Number(group.rate_multiplier),
          peakEnabled: Boolean(group.peak_rate_enabled),
          peakRate: group.peak_rate_multiplier ? Number(group.peak_rate_multiplier) : null,
          platform: platform.platform || null,
          channel: channel.name || null,
        })
      }
      for (const model of platform.supported_models || []) {
        if (!model?.name) continue
        const p = model.pricing || {}
        // 站方给的是「每 token 单价」，界面用「每百万 token」，乘 1e6。
        // 0.8e-6 * 1e6 在浮点下是 0.7999999999999999，所以统一收敛到 6 位。
        const perM = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 1e6 * 1e6) / 1e6)
        models.push({
          name: String(model.name),
          platform: platform.platform || null,
          inPrice: perM(p.input_price),
          outPrice: perM(p.output_price),
          cacheReadPrice: perM(p.cache_read_price),
        })
      }
    }
  }

  return { groups, models, raw: payload }
}

/**
 * 拉站点公告。多数站点是公共接口，不需要登录：
 *   new-api / one-api 系  GET /api/status → announcements[]
 *   sub2api                GET /api/v1/announcements → [{ id, title, content, ... }]
 *
 * 读不到就当没有——公告是锦上添花，不该让整轮采集失败。
 *
 * @returns {Promise<Array<{sourceKey:string, title:string, content:string, publishedAt:string|null}>>}
 */
export async function fetchAnnouncements({ baseUrl, apiKey, adminToken, timeoutMs = 8000 }) {
  const origins = originCandidates(baseUrl)
  const token = adminToken || apiKey
  const out = []
  const seen = new Set()

  const push = (raw) => {
    if (!raw) return
    const title = String(raw.title || raw.subject || '').trim()
    const content = String(raw.content || raw.body || raw.text || raw.message || '').trim()
    if (!title && !content) return
    const publishedAt =
      raw.publishDate || raw.published_at || raw.starts_at || raw.created_at || raw.updated_at || null
    // 没有 id 的站点用「标题 + 发布时间」当幂等键——用下标会在列表变化时重复入库
    const key =
      raw.id !== undefined && raw.id !== null
        ? `id:${raw.id}`
        : `t:${title.slice(0, 60)}|${publishedAt ? new Date(publishedAt).toISOString() : ''}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      sourceKey: key,
      title: title || content.slice(0, 60),
      content,
      publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
    })
  }

  for (const origin of origins) {
    // 1) new-api 系：/api/status 里的 announcements 数组
    try {
      const payload = await requestJson(`${origin}/api/status`, { apiKey: token, timeoutMs })
      const data = payload?.data ?? payload
      const list = Array.isArray(data) ? data : data?.announcements
      if (Array.isArray(list)) for (const item of list) push(item)
      if (out.length > 0) return out
    } catch {
      /* 试下一个接口 */
    }

    // 2) sub2api：/api/v1/announcements
    try {
      const payload = await requestJson(`${origin}/api/v1/announcements`, { apiKey: token, timeoutMs })
      const data = payload?.data ?? payload
      const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []
      for (const item of list) push(item)
      if (out.length > 0) return out
    } catch {
      /* 试下一个主机 */
    }
  }

  return out
}
export async function fetchSiteUsage({ baseUrl, adminToken, timeoutMs = 15000 }) {
  const origin = originOf(baseUrl, { stripApiPrefix: true })
  if (!origin) throw new Error(`站点地址无法解析：${baseUrl}`)
  const paths = ['/api/v1/usage/summary', '/api/v1/usage/stats', '/api/v1/user/profile']

  const results = {}
  for (const path of paths) {
    try {
      results[path] = await requestJson(`${origin}${path}`, { apiKey: adminToken, timeoutMs })
    } catch (error) {
      results[path] = { __error: error.message }
    }
  }
  return results
}

/**
 * 读站点的「令牌列表」——每把 Key 在后台属于哪个分组，站点自己最清楚。
 *
 * 两类站的接口不同，按优先级试：
 *   Sub2API   GET /api/v1/keys        → { data: { items: [{ key, name, group: { name, rate_multiplier } }] } }
 *   one-api   GET /api/token/?p=0...  → { data: { items: [{ key, name, group: '分组名' }] } }
 *
 * Sub2API 那条更好：它把 group 展开成对象，连倍率一起给了，
 * 所以连「模型广场」都不用读，站慢的时候也能用。
 *
 * @returns {Promise<{items:Array<{name,key,group,rate}>, raw:any, source:string}>}
 */
export async function fetchTokenList({ baseUrl, adminToken, timeoutMs = 15000 }) {
  const origins = originCandidates(baseUrl)

  const attempts = [
    { path: '/api/v1/keys', source: 'sub2api' },
    { path: '/api/token/?p=0&size=100', source: 'one-api' },
    { path: '/api/token?p=0&size=100', source: 'one-api' },
  ]

  const tried = []
  // 401 比 404 重要得多：404 只说明「这个路径没有」，401 说明「令牌本身不行」。
  // 之前直接抛最后一个错误，导致令牌过期的站显示成「接口不存在」，指错了方向。
  let authError = null
  let shapeError = null
  let firstError = null

  for (const attempt of attempts) {
    for (const origin of origins) {
      const where = `${origin}${attempt.path}`
      try {
        const payload = await requestJson(where, { apiKey: adminToken, timeoutMs })
        const raw = pickTokenArray(payload)
        if (raw.length === 0) {
          shapeError = `接口有响应但没认出列表结构：${JSON.stringify(payload).slice(0, 120)}`
          tried.push(`${where} 200（结构不认识）`)
          continue
        }
        return { items: raw.map(normalizeToken), raw: payload, source: attempt.source }
      } catch (error) {
        const message = error.message || String(error)
        tried.push(`${where} ${message}`)
        if (/HTTP 40[13]/.test(message)) authError = message
        else if (!firstError) firstError = message
      }
    }
  }

  if (authError) {
    throw new Error(
      '站点令牌已失效或无权限（401/403）。在站点卡片上点「令牌」，从浏览器重新复制一个再试。',
    )
  }
  if (shapeError) throw new Error(shapeError)
  throw new Error(
    `这个站没有暴露「令牌列表」接口，读不到每把 Key 属于哪个分组。改用「导入倍率」手动选即可。已试过：${tried.join('；')}`,
  )
}

/** 把两种结构统一成 { name, key, group, rate } */
function normalizeToken(token) {
  const g = token?.group
  const group = typeof g === 'string' ? g : String(g?.name || '')
  const rate = typeof g === 'object' && g ? Number(g.rate_multiplier) : NaN
  return {
    name: String(token?.name || ''),
    key: String(token?.key || ''),
    group,
    rate: Number.isFinite(rate) ? rate : null,
  }
}

function pickTokenArray(payload) {
  const candidates = [
    payload?.data?.items,
    payload?.data,
    payload?.items,
    payload?.tokens,
    Array.isArray(payload) ? payload : null,
  ]
  for (const c of candidates) {
    if (Array.isArray(c)) return c
  }
  return []
}

/**
 * 把「我们存的 sk-xxx」和「站点令牌列表里的 key」对上。
 *
 * 站点返回的 key 通常不带 sk- 前缀，所以两边都剥掉前缀再比；
 * 完全比不中时退一步用尾号，但只在尾号唯一时才认——尾号撞车比认错强。
 */
export function matchTokenBySecret(items, secret) {
  const bare = String(secret || '').replace(/^sk-/i, '').trim()
  if (!bare) return null

  const exact = items.find((t) => String(t.key || '').replace(/^sk-/i, '').trim() === bare)
  if (exact) return exact

  const tail = bare.slice(-6)
  if (tail.length < 6) return null
  const byTail = items.filter((t) => String(t.key || '').replace(/^sk-/i, '').endsWith(tail))
  return byTail.length === 1 ? byTail[0] : null
}

/**
 * 统一的价格来源：优先「可用渠道」，回落「模型广场」。
 *
 * 两条路的差异：
 *   channels —— 要登录令牌，但数据全（分组倍率 + 模型原价），不要求站开广场
 *   plaza    —— 不要令牌，但要求站主动开启模型广场
 *
 * 调用方拿到的结构是统一的，不用关心走了哪条。
 *
 * @returns {Promise<{groups:Array<{name,rate}>, models:Array, byGroup:Array, source:string}>}
 */
export async function fetchProviderPricing({ baseUrl, adminToken }) {
  let channelError = null

  if (adminToken) {
    try {
      const result = await fetchAvailableChannels({ baseUrl, adminToken })
      if (result.groups.length > 0 || result.models.length > 0) {
        return { groups: result.groups, models: result.models, byGroup: [], source: 'channels' }
      }
    } catch (error) {
      channelError = error
    }
  }

  try {
    const plazaGroups = await fetchModelPlaza({ baseUrl })
    const { byModel, groupList, allEntries } = flattenPlaza(plazaGroups)
    const toModel = (m) => ({
      name: m.name,
      // 和 channels 保持同一语义：这里给「原价」（未乘倍率），倍率由调用方按分组套
      inPrice: m.baseIn,
      outPrice: m.baseOut,
      group: m.groupName || null,
    })
    return {
      groups: groupList.map((g) => ({ name: g.name, rate: g.rateMultiplier })),
      // models：每个模型一条（同模型跨分组时取「最多分组采用」的那个价）
      models: [...byModel.values()].map(toModel),
      // byGroup：每个 (分组, 模型) 一条——分组已知时用它，价格更准
      byGroup: allEntries.map(toModel),
      source: 'plaza',
    }
  } catch (error) {
    if (channelError) {
      throw new Error(
        `可用渠道读取失败（${channelError.message}），模型广场也不可用（${error.message}）`,
      )
    }
    throw new Error('该站没有开启模型广场。填一个「令牌」就能读「可用渠道」，那里数据更全。')
  }
}
