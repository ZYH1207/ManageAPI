/**
 * C 棒 · 用户版 API 适配的「只读路由契约 + 脱敏 + 明确不可用声明」。
 *
 * 定位：本文件只声明**形状与纯函数**，不做真实请求。真实出站请求统一走 http.js 的
 * `daemonRequest`（仅 loopback、白名单、response 瘦身）；写通道走 write-proxy.js。
 *
 * 三条原则：
 *  1. 只读契约 ROUTES 必须逐条命中 daemon/server.js 的真实 route 正则；
 *  2. 用户版 daemon 的 /api/state 只认 light=1，`panel` 参数会被静默忽略——
 *     这里绝不把朋友的 panel=1 假设带过去（stateQuery 只发 light=1）；
 *  3. 做不到的能力（panel 独立忽略名单 / 免费池写 / daemon 生命周期 / 任意反代）
 *     一律在 UNAVAILABLE 里明确标注，绝不伪成功；基准价写与网关 Key 管理属于正常
 *     网关功能，N23 起已由 write-proxy.js#WRITE_RULES 放行，见下方 AVAILABLE。
 */

import { ApiHttpError } from './http.js'

export const PREFIX = '/api/manage-api'

/** /api/state 的取数模式。LIGHT 只发 light=1；FULL 不带 light（拿全量）。 */
export const STATE_MODE = Object.freeze({ LIGHT: 'light', FULL: 'full' })

/**
 * 6 条只读路由定义（daemonPath 是 daemon 侧真实路径，用于和白名单正则对照）。
 * path 是 Host 侧相对路径（client 契约引用的就是这一列）。
 */
export const ROUTES = Object.freeze([
  Object.freeze({ id: 'health', method: 'GET', path: '/health', daemonPath: '/api/health', write: false }),
  Object.freeze({ id: 'state', method: 'GET', path: '/state', daemonPath: '/api/state', write: false }),
  Object.freeze({ id: 'usage', method: 'GET', path: '/usage', daemonPath: '/api/usage', write: false }),
  Object.freeze({ id: 'usage-detail', method: 'GET', path: '/usage/detail', daemonPath: '/api/usage/detail', write: false }),
  Object.freeze({ id: 'monitor', method: 'GET', path: '/monitor', daemonPath: '/api/monitor', write: false }),
  Object.freeze({ id: 'provider-groups', method: 'GET', path: '/providers/:id/groups', daemonPath: '/api/providers/:id/groups', write: false }),
])

export const ROUTE_IDS = Object.freeze(ROUTES.map((r) => r.id))

/** ingest 端点契约（与 daemon/server.js 的实现口径一致）。 */
export const INGEST_PATH = '/api/ingest/usage'

export const INGEST_CONTRACT = Object.freeze({
  method: 'POST',
  path: INGEST_PATH,
  request: Object.freeze({
    provider: 'string', model: 'string', inputTokens: 'number', outputTokens: 'number',
    cachedTokens: 'number', cacheCreationTokens: 'number', latencyMs: 'number',
    ttftMs: 'number', ok: 'boolean', ts: 'string',
  }),
  status: Object.freeze([200, 400, 415]),
  dedupe: 'provider 为 manage-api 或 manage-api/* 时视为网关已记录（gateway-already-recorded），回 200 recorded:false 且不写盘',
  accounting: '合法 payload 经 daemon 的 recordUsage/usage.json 口径落账（与网关同源）',
})

/**
 * 明确「不可用」的能力声明。每条都带 reason，status 只取 403 / 503：
 *  - 403 = 用户版从根本上不做这件事（安全边界）；
 *  - 503 = 有能力但在用户版当前状态下不提供。
 */
export const UNAVAILABLE = Object.freeze({
  PANEL_QUERY: Object.freeze({ status: 403, reason: '用户版 daemon 的 /api/state 不读 panel 参数（会被静默忽略），面板不接受 panel=1' }),
  PANEL_IGNORED_MODELS: Object.freeze({ status: 503, reason: '用户版 daemon 没有独立的 settings.panelIgnoredModels 名单，忽略模型只有全局一份' }),
  DSH_FREE_MODELS: Object.freeze({ status: 503, reason: '用户版基线守护进程不存在 dshFreeModels 设置项' }),
  FREE_POOL_WRITES: Object.freeze({ status: 503, reason: '免费池的增删改查由后端拒绝守卫处理；本插件只读，不提供免费池写通道' }),
  // N23：基准价写与网关 Key 管理已属正常网关功能，从 UNAVAILABLE 移到 AVAILABLE。
  DAEMON_LIFECYCLE_VIA_WRITE: Object.freeze({ status: 403, reason: 'daemon 生命周期由 Host 插件处理，不走写通道' }),
  ARBITRARY_PROXY: Object.freeze({ status: 403, reason: '默认拒绝任意反代：每个出站请求必须完整命中显式白名单' }),
})

/** N23 起放行的正常网关写能力（展示项；实际通路由 write-proxy.js#WRITE_RULES 决定）。 */
export const AVAILABLE = Object.freeze({
  BENCHMARK_WRITES: Object.freeze({ status: 200, reason: '基准价写 5 条已在 WRITE_RULES 放行（benchmark.*）' }),
  GATEWAY_KEYS: Object.freeze({ status: 200, reason: '网关 Key 管理 4 条已在 WRITE_RULES 放行（gatewayKey.*）' }),
})

/** 按 id 取不可用声明（未知 id 返回 null）。 */
export function unavailableFor(id) {
  return Object.prototype.hasOwnProperty.call(UNAVAILABLE, id) ? UNAVAILABLE[id] : null
}

/**
 * 精确剥离 state 里的明文密钥/令牌，**保留** UI 档位字段。
 *
 * 关键点（C 棒优化）：
 *  - 只按已知的**精确位置**剥离：gateway.keys[].key / settings.gateway.keys[].key /
 *    providers[].adminToken /
 *    settings.failoverToken / settings.lanPanel.token / failover.token / lan.token /
 *    settings.masterKey / freePool.accounts[].secret；
 *  - 结构化深层的 adminToken/secret/token 打码为 '***'，但**不动**泛化的 key，
 *    否则会毁掉 ttftTiers[].key / decisionModes[].key / scores[].key / modelKey 等页面字段；
 *  - 不改原对象（浅拷贝后处理）。
 */
// 精确剔除网关 Key 行的 `key` 字段（只删键名恰为 key 的凭据串），保留 name/enabled/
// monthlyTokenLimit/note/createdAt 等展示字段；切勿泛化删除，避免毁掉 UI 档位字段。
function stripGatewayKeyField(row) {
  if (!row || typeof row !== 'object') return row
  const { key, ...rest } = row
  return rest
}

export function sanitizeState(state) {
  if (!state || typeof state !== 'object') return state
  const out = { ...state }

  // gateway.keys[].key：明文 sk-mapi-... 一律剔除，保留 name/enabled 等展示字段
  if (out.gateway && typeof out.gateway === 'object') {
    const gateway = { ...out.gateway }
    if (Array.isArray(gateway.keys)) {
      gateway.keys = gateway.keys.map(stripGatewayKeyField)
    }
    out.gateway = gateway
  }

  // providers[].adminToken：AES 密文 iv/tag/data 剔除，保留 adminTokenTail / hasAdminToken / tokenStatus
  if (Array.isArray(out.providers)) {
    out.providers = out.providers.map((row) => {
      if (!row || typeof row !== 'object') return row
      const { adminToken, ...rest } = row
      return rest
    })
  }

  // settings：剥离 failoverToken / lanPanel.token / masterKey；保留 ignoredModels 作用域
  if (out.settings && typeof out.settings === 'object') {
    const settings = { ...out.settings }
    delete settings.failoverToken
    delete settings.masterKey
    if (settings.lanPanel && typeof settings.lanPanel === 'object') {
      const lanPanel = { ...settings.lanPanel }
      delete lanPanel.token
      settings.lanPanel = lanPanel
    }
    // settings.gateway.keys[].key：与顶层 gateway.keys 是同一份网关 Key 的副本，
    // 根修在此精确剔除，不依赖 http-server 的 scrubStateSecrets 兜底。
    if (settings.gateway && typeof settings.gateway === 'object') {
      const gateway = { ...settings.gateway }
      if (Array.isArray(gateway.keys)) gateway.keys = gateway.keys.map(stripGatewayKeyField)
      settings.gateway = gateway
    }
    out.settings = settings
  }

  // failover.{token,active}：只剥 token
  if (out.failover && typeof out.failover === 'object') {
    const failover = { ...out.failover }
    delete failover.token
    out.failover = failover
  }

  // lan.token：只剥 token
  if (out.lan && typeof out.lan === 'object') {
    const lan = { ...out.lan }
    delete lan.token
    out.lan = lan
  }

  // freePool.accounts[].secret：结构化深层，打码为 '***'（保留 hasSecret 等展示字段）
  if (out.freePool && typeof out.freePool === 'object') {
    const freePool = { ...out.freePool }
    if (Array.isArray(freePool.accounts)) {
      freePool.accounts = freePool.accounts.map((row) => {
        if (!row || typeof row !== 'object') return row
        return redactDeep(row)
      })
    }
    out.freePool = freePool
  }

  // scores / 其它任意深层对象：精确名字打码（adminToken/secret/token...），绝不碰泛化 key
  if (out.scores && typeof out.scores === 'object') out.scores = redactDeep(out.scores)

  return out
}

const SENSITIVE_KEYS = new Set([
  'adminToken', 'secret', 'password', 'authorization', 'cookie', 'apiKey',
  'masterKey', 'failoverToken', 'panelToken', 'accessToken', 'refreshToken', 'token',
])

function redactDeep(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(k)) out[k] = '***'
    else if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    else out[k] = redactDeep(v, depth + 1)
  }
  return out
}

/**
 * /api/state 的 query：LIGHT → {light:'1'}；FULL → {}；任何 panel* 直接拒绝。
 * @param {string|undefined} mode
 */
export function stateQuery(mode = STATE_MODE.LIGHT) {
  const m = mode === undefined || mode === null || mode === '' ? STATE_MODE.LIGHT : mode
  if (m === STATE_MODE.LIGHT || m === 'light') return { light: '1' }
  if (m === STATE_MODE.FULL || m === 'full') return {}
  // 任何以 panel 开头的取值（如 'panel=1'）都不转发
  if (/panel/i.test(String(m))) throw new ApiHttpError(403, '用户版 daemon 不支持 panel 参数（会被静默忽略）')
  throw new ApiHttpError(400, `未知的 state 模式：${String(m)}`)
}

/** 请求 query 里出现 panel* 键即视为非法（用户版会静默忽略，不能假装生效）。 */
export function isPanelQuery(query) {
  if (!query || typeof query !== 'object') return false
  return Object.keys(query).some((k) => /^panel/i.test(k))
}

/** 按 method + 相对 path 精确查只读路由（不做路径猜测 / 归一）。 */
export function findRouteByPath(method, path) {
  const verb = String(method || 'GET').toUpperCase()
  return ROUTES.find((r) => r.method === verb && r.path === path) || null
}

/** 按 id 查只读路由。 */
export function findRoute(id) {
  return ROUTES.find((r) => r.id === id) || null
}

/**
 * 把 ROUTES 里的 `:id` 占位替换成真实值；id 只允许 [\w-]+（拒穿越）。
 */
export function materializeDaemonPath(route, params = {}) {
  if (!route || typeof route !== 'object' || typeof route.daemonPath !== 'string') {
    throw new ApiHttpError(400, '未知的只读路由')
  }
  if (route.daemonPath.includes(':id')) {
    const id = params && params.id !== undefined ? String(params.id) : ''
    if (!/^[\w-]+$/.test(id)) throw new ApiHttpError(400, '路由参数 id 不合法（只允许字母数字下划线连字符）')
    return route.daemonPath.replace(':id', id)
  }
  return route.daemonPath
}

/** days 参数夹取到 [min,max]，非数字用默认值。 */
export function clampDays(value, { def = 7, min = 1, max = 90 } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.trunc(n)))
}
