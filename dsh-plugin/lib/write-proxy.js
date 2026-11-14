/**
 * C 棒 · 用户版写通道白名单代理。
 *
 * 边界（与 http.js 的 daemonRequest 一致）：
 *  - 渲染进程**绝不直连 4319**：所有写操作都先落到本白名单，命中才转发；
 *  - 没命中 = 默认拒绝（403），且**零请求**（连一次 fetch 都不发）；
 *  - 免费池写 / daemon 生命周期 / 任意反代等仍在 WRITE_UNAVAILABLE 里明确声明
 *    （与 routes.js#UNAVAILABLE 同源）；基准价写与网关 Key 管理属于正常网关功能，
 *    N23 起已在 WRITE_RULES 里放行，不再是 unavailable。
 *
 * 35 条写规则逐条命中 daemon/server.js 的真实 route 正则；decision.order 与
 * benchmark.delete 用 encodeURIComponent 把模型名/基准价 key 里的 `/` 收敛为 %2F，
 * 并在 resolveWrite 里要求显式 allowEncodedSlash 才放行。
 */

import { ApiHttpError, daemonRequest } from './http.js'
import { UNAVAILABLE } from './routes.js'

const messageOf = (err) => String(err && err.message ? err.message : err)

/**
 * 35 条写规则。每条：{ method, template, action, name, allowEncodedSlash? }。
 * template 用三种占位：`:id`（[\w-]+）、`:model` 与 `:key`（encodeURIComponent）。
 * N23 追加 9 条：基准价 5 + 网关 Key 4，逐条命中 daemon/server.js L3645–L3746。
 */
export const WRITE_RULES = Object.freeze([
  Object.freeze({ method: 'POST', template: '/api/providers', action: 'provider.create', name: '新增站点' }),
  Object.freeze({ method: 'PATCH', template: '/api/providers/:id', action: 'provider.update', name: '更新站点' }),
  Object.freeze({ method: 'DELETE', template: '/api/providers/:id', action: 'provider.delete', name: '删除站点' }),
  Object.freeze({ method: 'POST', template: '/api/providers/:id/sync', action: 'provider.sync', name: '同步模型' }),
  Object.freeze({ method: 'POST', template: '/api/providers/:id/detect-kind', action: 'provider.detect-kind', name: '识别站点类型' }),
  Object.freeze({ method: 'POST', template: '/api/providers/:id/balance', action: 'provider.balance', name: '查询余额' }),
  Object.freeze({ method: 'POST', template: '/api/providers/:id/usage-check', action: 'provider.usage-check', name: '查询用量' }),
  Object.freeze({ method: 'POST', template: '/api/providers/:id/group-ratio', action: 'provider.group-ratio', name: '设置分组倍率' }),
  Object.freeze({ method: 'POST', template: '/api/providers/:id/delete-group', action: 'provider.delete-group', name: '删除分组' }),
  Object.freeze({ method: 'POST', template: '/api/providers/:id/apply-group', action: 'provider.apply-group', name: '应用分组' }),
  Object.freeze({ method: 'POST', template: '/api/providers/:id/detect-groups', action: 'provider.detect-groups', name: '探测分组' }),
  Object.freeze({ method: 'POST', template: '/api/providers/:id/restore-ratio', action: 'provider.restore-ratio', name: '恢复倍率' }),
  Object.freeze({ method: 'POST', template: '/api/providers/:id/login', action: 'provider.login', name: '站点登录' }),
  Object.freeze({ method: 'POST', template: '/api/providers/:id/import-session', action: 'provider.import-session', name: '导入会话' }),
  Object.freeze({ method: 'POST', template: '/api/providers/:id/long-lived-token', action: 'provider.long-lived-token', name: '生成长效令牌' }),
  Object.freeze({ method: 'POST', template: '/api/providers/:id/renew-token', action: 'provider.renew-token', name: '续期令牌' }),
  Object.freeze({ method: 'POST', template: '/api/providers/reorder', action: 'provider.reorder', name: '站点排序' }),
  Object.freeze({ method: 'PUT', template: '/api/decisions/:model/order', action: 'decision.order', name: '决策排序', allowEncodedSlash: true }),
  Object.freeze({ method: 'POST', template: '/api/decisions/:model/pick', action: 'decision.pick', name: '决策选点' }),
  Object.freeze({ method: 'POST', template: '/api/probes/run', action: 'probes.run', name: '运行探针' }),
  Object.freeze({ method: 'POST', template: '/api/fx/refresh', action: 'fx.refresh', name: '刷新汇率' }),
  Object.freeze({ method: 'POST', template: '/api/monitor/collect', action: 'monitor.collect', name: '监控采集' }),
  Object.freeze({ method: 'POST', template: '/api/monitor/alerts/read', action: 'monitor.alerts-read', name: '标记告警已读' }),
  Object.freeze({ method: 'POST', template: '/api/monitor/announcements/read', action: 'monitor.announcements-read', name: '标记公告已读' }),
  Object.freeze({ method: 'PATCH', template: '/api/gateway', action: 'gateway.toggle', name: '网关开关' }),
  Object.freeze({ method: 'PATCH', template: '/api/settings', action: 'settings.patch', name: '更新设置' }),
  // ── N23：基准价 5 条 + 网关 Key 4 条（daemon/server.js L3645–L3746 真实路由）──
  // benchmark.delete 的 :key 必须 encodeURIComponent：daemon 正则 (.+) 的 handler
  // 对 params[0] 做 decodeURIComponent，而基准价 key 就是模型名（可含 /、:、空格），
  // UI 也按 encodeURIComponent(name) 拼路径；编码后 / 收敛为 %2F 锁在单段内，
  // 既与 daemon 解码口径对齐，也不会越到别的路由（%2F 需 allowEncodedSlash 才放行）。
  Object.freeze({ method: 'PUT', template: '/api/benchmarks', action: 'benchmark.upsert', name: '设置基准价' }),
  Object.freeze({ method: 'DELETE', template: '/api/benchmarks/:key', action: 'benchmark.delete', name: '删除基准价', allowEncodedSlash: true }),
  Object.freeze({ method: 'POST', template: '/api/benchmarks/import', action: 'benchmark.import', name: '从站导入基准价' }),
  Object.freeze({ method: 'POST', template: '/api/benchmarks/seed', action: 'benchmark.seed', name: '载入内置参考价' }),
  Object.freeze({ method: 'POST', template: '/api/benchmarks/import-plaza', action: 'benchmark.import-plaza', name: '导入广场参考价' }),
  Object.freeze({ method: 'POST', template: '/api/gateway/keys', action: 'gatewayKey.create', name: '新增网关 Key' }),
  Object.freeze({ method: 'PATCH', template: '/api/gateway/keys/:id', action: 'gatewayKey.update', name: '更新网关 Key' }),
  Object.freeze({ method: 'DELETE', template: '/api/gateway/keys/:id', action: 'gatewayKey.delete', name: '删除网关 Key' }),
  Object.freeze({ method: 'POST', template: '/api/gateway/keys/:id/rotate', action: 'gatewayKey.rotate', name: '轮换网关 Key' }),
])

export const WRITE_ACTIONS = Object.freeze(WRITE_RULES.map((r) => r.action))

/** 写通道里明确不可用的能力（与 routes.js#UNAVAILABLE 同源，避免两处口径漂移）。
 *  N23：基准价写、网关 Key 管理已属于正常网关功能，改由 WRITE_RULES 放行，
 *  从本表移除；免费池写及其余 4 项保持 excluded。 */
export const WRITE_UNAVAILABLE = Object.freeze({
  freePool: UNAVAILABLE.FREE_POOL_WRITES,
  daemonLifecycle: UNAVAILABLE.DAEMON_LIFECYCLE_VIA_WRITE,
  arbitraryProxy: UNAVAILABLE.ARBITRARY_PROXY,
  panelIgnoredModels: UNAVAILABLE.PANEL_IGNORED_MODELS,
  dshFreeModels: UNAVAILABLE.DSH_FREE_MODELS,
})

/** 用户版 settings 允许的 30 个键（daemon PATCH /api/settings 真正处理的字段）。 */
export const ALLOWED_SETTINGS_KEYS = Object.freeze([
  'fxUsdCny', 'fxAuto', 'blendInputWeight', 'probeIntervalMinutes',
  'driftEnabled', 'driftThresholdPct', 'driftCooldownMinutes', 'driftTrialSamples',
  'scoreMaxAgeHours', 'probePauseWindows', 'maxTtftMs',
  'decisionMode', 'headlineMode', 'championMode', 'lockFailover',
  'autoRouteEnabled', 'pinnedModelKey', 'focusModel', 'defaultUnitPrice',
  'allowUntrusted', 'freeCrossPane', 'allowPaidFallback', 'monitorIntervalMinutes',
  'displayCurrency', 'balanceWarnUsd', 'balanceWarnCny', 'ignoredModels',
  'enforceIgnored', 'lanPanel', 'lanPanelForce',
])

const ALLOWED_SETTINGS = new Set(ALLOWED_SETTINGS_KEYS)

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const regexCache = new WeakMap()

/** 由 template 生成匹配正则：:id → [\w-]+，:model / :key → [^/]+。 */
function ruleRegex(rule) {
  let re = regexCache.get(rule)
  if (re) return re
  const src = escapeRe(rule.template)
    .replace(/:id/g, '[\\w-]+')
    .replace(/:model/g, '[^/]+')
    .replace(/:key/g, '[^/]+')
  re = new RegExp('^' + src + '$')
  regexCache.set(rule, re)
  return re
}

/** 按 action 名查写规则。 */
export function findWriteRule(action) {
  return WRITE_RULES.find((r) => r.action === action) || null
}

/**
 * 按 method + 真实 path 反查写规则。默认拒绝：未命中返回 null。
 * 含 %2F（编码斜杠）时，只有显式 allowEncodedSlash 才放行。
 */
export function resolveWrite(method, path, { allowEncodedSlash = false } = {}) {
  const verb = String(method || '').toUpperCase()
  if (typeof path !== 'string' || !path.startsWith('/api/')) return null
  if (/%2f/i.test(path) && !allowEncodedSlash) return null
  for (const rule of WRITE_RULES) {
    if (rule.method !== verb) continue
    ruleRegex(rule).lastIndex = 0
    if (ruleRegex(rule).test(path)) return rule
  }
  return null
}

/**
 * 校验 settings 写入载荷：只认 30 个用户版键，至少一个键，未知键/空对象直接拒。
 */
export function validateSettingsPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ApiHttpError(400, 'settings 载荷必须是对象')
  }
  const keys = Object.keys(payload)
  if (keys.length === 0) throw new ApiHttpError(400, 'settings 载荷不能为空')
  for (const key of keys) {
    if (!ALLOWED_SETTINGS.has(key)) {
      throw new ApiHttpError(403, `settings 不接受字段：${key}`)
    }
  }
  return true
}

/**
 * 把规则 template 物化为真实 daemon path。
 *  - :id 只允许 [\w-]+（拒穿越）；
 *  - :model / :key 必须非空，且 encodeURIComponent（含 / → %2F）。
 *    :key 用于 daemon 的 DELETE /api/benchmarks/(.+)：handler 对 params[0]
 *    做 decodeURIComponent，模型名含 / 时编码后才与 daemon 解码口径一致。
 */
export function materializeWritePath(rule, params = {}) {
  if (!rule || typeof rule !== 'object' || typeof rule.template !== 'string') {
    throw new ApiHttpError(400, '未知的写规则')
  }
  let path = rule.template
  if (path.includes(':id')) {
    const id = params && params.id !== undefined ? String(params.id) : ''
    if (!/^[\w-]+$/.test(id)) throw new ApiHttpError(400, '写操作 id 不合法（只允许字母数字下划线连字符）')
    path = path.replace(':id', id)
  }
  if (path.includes(':model')) {
    const model = params && params.model !== undefined ? String(params.model) : ''
    if (!model.trim()) throw new ApiHttpError(400, '写操作 model 不能为空')
    path = path.replace(':model', encodeURIComponent(model))
  }
  if (path.includes(':key')) {
    const key = params && params.key !== undefined ? String(params.key) : ''
    if (!key.trim()) throw new ApiHttpError(400, '写操作 key 不能为空')
    path = path.replace(':key', encodeURIComponent(key))
  }
  return path
}

function pickProvider(row) {
  if (!row || typeof row !== 'object') return null
  const out = {}
  if (row.id !== undefined) out.id = row.id
  if (row.name !== undefined) out.name = row.name
  return out
}

/**
 * 写响应瘦身：只回小字段，绝不把 daemon 全量 state / 明文 Key 带回渲染进程。
 * @param {any} respBody daemon 响应体
 * @param {{provider?: object}} [extra]
 */
export function summarizeWrite(respBody, extra = {}) {
  const body = respBody && typeof respBody === 'object' ? respBody : {}
  const out = {}
  if (body.sync && typeof body.sync === 'object') out.sync = body.sync
  let provider = null
  if (extra && extra.provider && typeof extra.provider === 'object') provider = pickProvider(extra.provider)
  else if (body.provider && typeof body.provider === 'object') provider = pickProvider(body.provider)
  else if (Array.isArray(body.providers) && body.providers[0]) provider = pickProvider(body.providers[0])
  if (provider && Object.keys(provider).length) out.provider = provider
  if (Array.isArray(body.providers)) out.providers = body.providers.length
  if (Array.isArray(body.offers)) out.offers = body.offers.length
  return out
}

/**
 * 执行一次白名单写。任一步不合法都返回 {ok:false,status,error}，且**不发请求**。
 * @returns {Promise<{ok:boolean,status:number,action?:string,summary?:object,error?:string}>}
 */
export async function runWrite(options = {}) {
  const {
    baseUrl, action, params = {}, payload,
    fetchImpl = globalThis.fetch, timeoutMs,
  } = options
  let method = options.method
  let path = options.path
  let rule = null

  if (action) {
    rule = findWriteRule(action)
    if (!rule) return { ok: false, status: 403, error: `未授权的写操作：${action}` }
    try {
      path = materializeWritePath(rule, params)
    } catch (err) {
      return { ok: false, status: err instanceof ApiHttpError ? err.status : 400, error: messageOf(err) }
    }
    method = rule.method
  } else if (method && path) {
    rule = resolveWrite(method, path)
    if (!rule) return { ok: false, status: 403, error: `写操作不在白名单（默认拒绝）：${String(method).toUpperCase()} ${path}` }
  } else {
    return { ok: false, status: 400, error: '缺少 action 或 method/path' }
  }

  if (rule.action === 'settings.patch') {
    try { validateSettingsPayload(payload) } catch (err) {
      return { ok: false, status: err instanceof ApiHttpError ? err.status : 400, error: messageOf(err) }
    }
  }

  const result = await daemonRequest({
    baseUrl,
    method,
    path,
    body: payload,
    allowedPattern: ruleRegex(rule),
    allowEncodedSlash: Boolean(rule.allowEncodedSlash),
    timeoutMs,
    fetchImpl,
  })

  if (!result.ok) {
    return { ok: false, status: result.status, action: rule.action, error: result.error }
  }
  return { ok: true, status: result.status, action: rule.action, summary: summarizeWrite(result.body) }
}
