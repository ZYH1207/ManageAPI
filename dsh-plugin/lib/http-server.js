/**
 * C/E 棒 · 把 lib/routes.js 的只读 ROUTES 真正挂到 DSH 的 ctx.webServer 上。
 *
 * 背景：routes.js 只声明「形状与纯函数」，从不注册到 HTTP 服务器；本文件补上
 * 缺失的注册层，把 PREFIX + route.path 以 exact 路由注册为命名路由（handler 形式，
 * 任意 method 均交由本文件裁决，未知 method 回 405）。
 *
 * 设计约束（与 C 棒一致）：
 *  - 每条路由以 lib/http.js#daemonRequest 打到 daemon（loopback-only、路径/query 校验、
 *    防任意反代白名单）；query 只由 stateQuery()/白名单键生成，**绝不发 panel=1**；
 *  - /state 响应经 sanitizeState() 脱敏；再做一层纵深清除 settings.gateway.keys[].key
 *    （sanitizeState 当前只清 top-level gateway.keys，见下方 scrubStateSecrets 注释）；
 *  - 统一错误 {ok:false,error}：daemon 不可达 502 / 超时 504 / 参数错 4xx；
 *  - unavailableFor(id) 有原因的 route 直接回 403/503 + 原因，不请求 daemon；
 *  - register() 返回的 disposer 成对保存并在 dispose 全部调用（热重载重复注册会 throw）；
 *  - webServer 缺失时软降级：记日志、跳过注册、插件照常激活，绝不抛。
 *
 * 入站防护复用 lib/http.js#checkLocalOrigin：只服务本机（loopback socket）DSH 前端，
 * 拒绝跨站 sec-fetch-site / 非 loopback origin；同源 loopback 请求正常放行。
 */

import {
  PREFIX, ROUTES, isPanelQuery, materializeDaemonPath, sanitizeState, stateQuery, unavailableFor,
} from './routes.js'
import { ApiHttpError, checkLocalOrigin, daemonRequest, sendJson } from './http.js'

/** 面板查询别名：/api/manage-api/panel 是「请求 panel 模式」的显式落点，一律拒绝。 */
export const PANEL_ALIAS = `${PREFIX}/panel`

/** 各只读路由允许透传给 daemon 的 query 白名单（state 单独处理）。 */
const QUERY_KEYS = Object.freeze({
  usage: Object.freeze(['days']),
  'usage-detail': Object.freeze(['days', 'limit']),
  monitor: Object.freeze(['days']),
})

const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** daemonPath → 白名单正则：`:id` 段允许 [\w-]+，其余原样锚定。 */
function daemonPattern(daemonPath) {
  return new RegExp(`^${escapeRegex(daemonPath).replace(/:id/g, '[\\w-]+')}$`)
}

/** route.path（如 /providers/:id/groups）→ 从请求 pathname 提取 params。 */
function suffixMatcher(routePath) {
  const names = []
  const re = routePath
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)' }
      return escapeRegex(seg)
    })
    .join('/')
  return { re: new RegExp(`^/${re}/?$`), names }
}

/**
 * 纵深脱敏：sanitizeState 目前只清 top-level `gateway.keys[].key`，不覆盖
 * `settings.gateway.keys[].key`（同一份网关 Key 的两处副本）。这里补一层：任何
 * 对象里名为 `key` 且值形如 `sk-...` 的字段整条剔除；其它数据字段（ttftTiers[].key
 * 的 'value'/'price' 等）原样保留，不误伤 UI。
 */
export function scrubStateSecrets(node) {
  if (Array.isArray(node)) return node.map(scrubStateSecrets)
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === 'key' && typeof v === 'string' && /^sk-[A-Za-z0-9_-]{6,}$/.test(v)) continue
    out[k] = scrubStateSecrets(v)
  }
  return out
}

function sendBody(req, res, status, payload) {
  if (String(req.method || 'GET').toUpperCase() === 'HEAD') {
    const text = JSON.stringify(payload)
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('content-length', Buffer.byteLength(text))
    res.end()
    return
  }
  sendJson(res, status, payload)
}

function sendApiError(req, res, status, error) {
  const code = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502
  sendBody(req, res, code, { ok: false, error: String(error || '请求失败') })
}

function applyCors(req, res) {
  const origin = req.headers && req.headers.origin
  if (typeof origin === 'string' && LOOPBACK_ORIGIN_RE.test(origin)) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'origin')
  }
}

function handleThrown(req, res, err) {
  if (res.writableEnded || res.headersSent) {
    try { res.destroy() } catch { /* ignore */ }
    return
  }
  const status = err instanceof ApiHttpError ? err.status : (err && err.status) || 500
  const message = String(err && err.message ? err.message : err)
  try { sendApiError(req, res, status, message) } catch { try { res.destroy() } catch { /* ignore */ } }
}

/**
 * 构造一条只读路由的 handler。
 * @param {object} route routes.js 的 ROUTES 条目
 */
function makeReadHandler({ route, baseUrl, allowedPattern, matcher }) {
  return async function handleRead(req, res) {
    applyCors(req, res)
    try {
      const verb = String(req.method || 'GET').toUpperCase()
      if (verb !== 'GET' && verb !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD')
        return sendApiError(req, res, 405, `method 不允许：${verb}`)
      }
      const gate = checkLocalOrigin(req)
      if (!gate.ok) return sendApiError(req, res, 403, `禁止的来源：${gate.reason}`)

      if (route && route.id && unavailableFor(route.id)) {
        const u = unavailableFor(route.id)
        return sendApiError(req, res, u.status, u.reason)
      }

      const url = new URL(req.url, 'http://localhost')
      const params = {}
      if (matcher) {
        const m = matcher.re.exec(url.pathname)
        if (!m) return sendApiError(req, res, 404, '路径不匹配')
        matcher.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]) })
      }
      const daemonPath = materializeDaemonPath(route, params)

      let query
      if (route.id === 'state') {
        if (isPanelQuery(Object.fromEntries(url.searchParams))) {
          return sendApiError(req, res, 403, '用户版 daemon 不支持 panel 参数（会被静默忽略）')
        }
        const full = url.searchParams.get('full')
        const wantFull = full !== null && full !== '' && full !== '0' && full !== 'false'
        query = stateQuery(wantFull ? 'full' : 'light') // 默认只发 light=1；full 才不带 light；绝不带 panel
      } else {
        query = {}
        for (const key of QUERY_KEYS[route.id] || []) {
          const v = url.searchParams.get(key)
          if (v !== null) query[key] = v
        }
      }

      const result = await daemonRequest({
        baseUrl,
        method: 'GET',
        path: daemonPath,
        query,
        allowedPattern,
        sanitize: route.id === 'state' ? sanitizeState : null,
      })
      if (!result.ok) return sendApiError(req, res, result.status || 502, result.error)

      const body = route.id === 'state' ? scrubStateSecrets(result.body) : result.body
      return sendBody(req, res, 200, body)
    } catch (err) {
      return handleThrown(req, res, err)
    }
  }
}

/** /api/manage-api/panel：显式拒绝 panel 模式（不请求 daemon）。 */
function makePanelHandler() {
  return function handlePanel(req, res) {
    applyCors(req, res)
    const verb = String(req.method || 'GET').toUpperCase()
    if (verb !== 'GET' && verb !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD')
      return sendApiError(req, res, 405, `method 不允许：${verb}`)
    }
    const gate = checkLocalOrigin(req)
    if (!gate.ok) return sendApiError(req, res, 403, `禁止的来源：${gate.reason}`)
    const u = unavailableFor('PANEL_QUERY') || { status: 403, reason: '不接受 panel=1' }
    return sendApiError(req, res, u.status, u.reason)
  }
}

/**
 * 生成注册项（不触碰 webServer，纯函数，便于单测）。
 *
 * 带参路由（`/providers/:id/groups`）不能注册为 exact：DSH 的 exact 匹配是
 * 字面量全等（`table.has(route.path)`），字符串里的 `:id` 永远打不中真实请求。
 * 因此改为注册 `kind:'prefix'`，路径取参数段之前的稳定前缀（`/api/manage-api/providers`），
 * 让前缀匹配把 `/providers/*` 全部放进来；进入 handler 后再用 suffixMatcher 按**完整
 * pathname**（含 PREFIX）严格收紧成只认 `/providers/<id>/groups`，多段（如 `/providers/x/y/z`）
 * 在 handler 内明确回 404，绝不透传给 daemon。
 * @returns {{path:string, kind:('exact'|'prefix'), handler:Function}[]}
 */
export function buildRouteRegistrations({ port }) {
  const n = Number(port)
  const baseUrl = `http://127.0.0.1:${Number.isInteger(n) && n > 0 && n <= 65535 ? n : 4319}`
  const registrations = []
  for (const route of ROUTES) {
    const fullPath = PREFIX + route.path
    const hasParam = route.path.includes(':id')
    let regPath = fullPath
    let kind = 'exact'
    if (hasParam) {
      // 取第一个 `:id` 段之前的稳定前缀作为 prefix 注册键。
      const segments = route.path.split('/').filter(Boolean)
      const paramIdx = segments.findIndex((seg) => seg.startsWith(':'))
      const stablePrefix = segments.slice(0, Math.max(0, paramIdx)).join('/')
      regPath = `${PREFIX}/${stablePrefix}`
      kind = 'prefix'
    }
    registrations.push({
      path: regPath,
      kind,
      method: route.method,
      handler: makeReadHandler({
        route,
        baseUrl,
        allowedPattern: daemonPattern(route.daemonPath),
        // matcher 必须匹配完整 pathname（含 PREFIX）才能命中；suffixMatcher 内部用 ^/…$ 锚定。
        matcher: hasParam ? suffixMatcher(fullPath) : null,
      }),
    })
  }
  registrations.push({ path: PANEL_ALIAS, kind: 'exact', method: 'GET', handler: makePanelHandler() })
  return registrations
}

/**
 * 把路由注册到 ctx.webServer；webServer 缺失时软降级。
 * @returns {{ registered: string[], count: number, dispose: Function, disposeAll: Function }}
 */
export function registerHttpRoutes({ webServer, port, log } = {}) {
  const warn = typeof log === 'function' ? log : () => {}
  if (!webServer || typeof webServer.register !== 'function') {
    warn('webServer 服务缺失，跳过 /api/manage-api 路由注册（软降级，插件照常激活）')
    return { registered: [], count: 0, dispose() {}, disposeAll() {} }
  }
  let registrations
  try {
    registrations = buildRouteRegistrations({ port })
  } catch (err) {
    warn(`构造路由注册项失败（软降级）：${String(err && err.message ? err.message : err)}`)
    return { registered: [], count: 0, dispose() {}, disposeAll() {} }
  }

  const disposers = []
  const registered = []
  for (const reg of registrations) {
    try {
      const d = webServer.register({ kind: reg.kind, path: reg.path, handler: reg.handler })
      if (typeof d === 'function') { disposers.push(d); registered.push(reg.path) }
    } catch (err) {
      warn(`注册路由失败 ${reg.path}（跳过）：${String(err && err.message ? err.message : err)}`)
    }
  }
  warn(`已注册 ${registered.length} 条 /api/manage-api 路由`)

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    while (disposers.length) { const d = disposers.pop(); try { d() } catch { /* ignore */ } }
  }
  return { registered, count: registered.length, dispose, disposeAll: dispose }
}
