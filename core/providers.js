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
  if (!response.ok) throw new Error(describeHttpError(response.status, text))
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`返回的不是 JSON：${text.slice(0, 120)}`)
  }
}

/** 兼容几种常见返回形态，抽出模型 id 列表。 */
function extractModelIds(payload) {
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

  const hostMatch = String(baseUrl).match(/^https?:\/\/([^/]+)/i)
  const host = hostMatch ? hostMatch[1] : ''
  const hosts = [host, host.replace(/^api\./, '')].filter((v, i, a) => v && a.indexOf(v) === i)

  // 有管理令牌时优先走账户接口：Sub2API 用 /api/v1/user/profile，one-api 系用 /api/user/self
  if (adminToken) {
    let lastError = null
    for (const h of hosts) {
      for (const path of ['/api/v1/user/profile', '/api/user/self']) {
        try {
          const payload = await requestJson(`https://${h}${path}`, { apiKey: adminToken, timeoutMs })
          const data = payload?.data ?? payload
          const remaining =
            data?.balance ?? data?.quota ?? data?.credits ?? data?.remaining ?? data?.remain_quota
          if (typeof remaining === 'number') {
            return {
              ok: true,
              remaining,
              currency: data?.currency === 'USD' ? 'USD' : 'CNY',
              via: 'admin-token',
            }
          }
          return {
            ok: false,
            reason: `管理接口通了，但没认出余额字段。返回片段：${JSON.stringify(data).slice(0, 140)}`,
          }
        } catch (error) {
          lastError = error
        }
      }
    }
    if (lastError && /401|403/.test(lastError.message)) {
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
          currency: isQuota ? 'USD' : 'CNY',
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
  const hostMatch = String(baseUrl).match(/^https?:\/\/([^/]+)/i)
  const host = (hostMatch ? hostMatch[1] : '').replace(/^api\./, '')
  const payload = await requestJson(`https://${host}/api/v1/channels/available`, {
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
export async function fetchSiteUsage({ baseUrl, adminToken, timeoutMs = 15000 }) {
  const hostMatch = String(baseUrl).match(/^https?:\/\/([^/]+)/i)
  const host = (hostMatch ? hostMatch[1] : '').replace(/^api\./, '')
  const paths = ['/api/v1/usage/summary', '/api/v1/usage/stats', '/api/v1/user/profile']

  const results = {}
  for (const path of paths) {
    try {
      results[path] = await requestJson(`https://${host}${path}`, { apiKey: adminToken, timeoutMs })
    } catch (error) {
      results[path] = { __error: error.message }
    }
  }
  return results
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
