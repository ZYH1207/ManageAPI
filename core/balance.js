/**
 * 云厂商余额适配器。
 *
 * 中转站（one-api / new-api / Sub2API 系）的余额已经在 `providers.tryBalance` 里处理，
 * 这里只管**模型厂商**——它们的余额接口各家一套，没法用同一组路径碰运气。
 *
 * 设计原则：
 *   - 按域名精确匹配，匹配不上就返回 null 让调用方走原有逻辑，绝不瞎试别人的接口
 *   - 每家只认一个确定存在的端点，字段解析失败就如实说明，不猜第二个形状
 *   - 读不到不是错误：多数厂商本来就不对 API Key 开放余额
 */

/** 取 origin（去掉 /v1 之类的路径尾巴） */
function originOf(baseUrl) {
  return String(baseUrl)
    .replace(/\/v\d+(\.\d+)?\/?$/i, '')
    .replace(/\/+$/, '')
}

const ADAPTERS = [
  {
    id: 'siliconflow',
    label: '硅基流动',
    match: /(^|\.)siliconflow\.(cn|com)$/i,
    endpoint: '/v1/user/info',
    pick(payload) {
      const d = payload?.data ?? payload
      const value = Number(d?.totalBalance ?? d?.balance)
      return Number.isFinite(value) ? { remaining: value, currency: 'CNY' } : null
    },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    match: /(^|\.)deepseek\.com$/i,
    endpoint: '/user/balance',
    pick(payload) {
      // { is_available: true, balance_infos: [{ currency, total_balance }] }
      const list = Array.isArray(payload?.balance_infos) ? payload.balance_infos : []
      const first = list.find((row) => Number.isFinite(Number(row?.total_balance)))
      if (!first) return null
      return {
        remaining: Number(first.total_balance),
        currency: String(first.currency || 'CNY').toUpperCase() === 'USD' ? 'USD' : 'CNY',
      }
    },
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    match: /(^|\.)moonshot\.(cn|ai)$/i,
    endpoint: '/v1/users/me/balance',
    pick(payload) {
      const d = payload?.data ?? payload
      const value = Number(d?.available_balance ?? d?.balance)
      return Number.isFinite(value) ? { remaining: value, currency: 'CNY' } : null
    },
  },
]

/**
 * 尝试用厂商专用接口读余额。
 * @returns {Promise<{ok:true, remaining:number, currency:string, via:string} | {ok:false, reason:string} | null>}
 *   null 表示「这个域名没有专用适配器」，调用方应回落到通用路径。
 */
export async function readVendorBalance({ baseUrl, apiKey, timeoutMs = 10000, requestJson }) {
  const host = String(baseUrl).match(/^https?:\/\/([^/]+)/i)?.[1] || ''
  const adapter = ADAPTERS.find((a) => a.match.test(host))
  if (!adapter) return null

  const url = `${originOf(baseUrl)}${adapter.endpoint}`
  try {
    const payload = await requestJson(url, { apiKey, timeoutMs })
    const picked = adapter.pick(payload)
    if (!picked) {
      return {
        ok: false,
        reason: `${adapter.label} 的余额接口有响应，但没认出余额字段。返回片段：${JSON.stringify(payload).slice(0, 140)}`,
      }
    }
    return { ok: true, ...picked, via: adapter.id }
  } catch (error) {
    const message = error?.message || String(error)
    if (/401|403/.test(message)) {
      return { ok: false, reason: `${adapter.label} 的 Key 无效或已过期（401）` }
    }
    return { ok: false, reason: `${adapter.label} 余额接口不可用：${message}` }
  }
}
