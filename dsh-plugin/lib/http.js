/**
 * C 棒 · 仅 loopback 的 daemon HTTP 客户端 + 插件 Host 入口来源防护。
 *
 * 硬边界（交给 D/E 的运行时保证）：
 *  1. 出站目标只能是 127.0.0.1 / localhost / ::1 上的 http:，默认拒绝其它一切
 *     （含 0.0.0.0、局域网 IP、域名、userinfo、https、带 path/search/hash 的 base）；
 *  2. 不做任意反代：每次请求必须显式给 allowedPattern（RegExp），且最终 daemon
 *     pathname 必须完整命中该白名单；未给白名单 = 默认拒绝；
 *  3. 路径/query 逐字符校验：只认 /api/ 前缀，拒 `..`/编码 `..`、双斜杠、反斜杠、
 *     `?`/`#` 注入、控制字符、`@`、非法百分号编码；%2F 仅在明确开启时允许
 *     （用户版 `PUT /api/decisions/:model/order` 用 encodeURIComponent 后的 %2F）；
 *  4. 用户版 daemon 的 /api/state 不读 `panel` 参数（会静默忽略），因此任何以
 *     `panel` 开头的 query key 一律拒绝，不转发、不假装生效；
 *  5. 超时、错误归一、响应瘦身：不跟随重定向、响应体有上限、非 JSON 只留 4000 字符、
 *     失败只回 `{ok,status,error}`（不透传 daemon 全量 state 给渲染进程）。
 *
 * 本文件不 import node:fs，不写任何数据文件；所有业务写入只能经 daemon HTTP。
 */

export const LOOPBACK_HOST = '127.0.0.1'
export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])

export class ApiHttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'ApiHttpError'
    this.status = status
  }
}

const fail = (status, message) => { throw new ApiHttpError(status, message) }
const messageOf = (err) => String(err && err.message ? err.message : err)

/** 端口 → 严格 loopback base URL。非 loopback 直接抛（默认拒绝）。 */
export function loopbackBaseUrl(port = 4319, host = LOOPBACK_HOST) {
  const n = Number(port)
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(400, `daemon 端口不合法：${String(port)}`)
  return assertLoopbackBase(`http://${host}:${n}`)
}

/** 校验并归一 base URL；返回 origin 字符串。非 loopback 一律拒绝。 */
export function assertLoopbackBase(baseUrl) {
  let url
  try { url = new URL(String(baseUrl ?? '')) } catch { fail(400, 'daemon 地址不合法') }
  if (url.protocol !== 'http:') fail(403, `只允许 http: loopback，拒绝 ${url.protocol}`)
  if (url.username || url.password) fail(403, 'daemon 地址不允许 userinfo')
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) fail(403, `拒绝非 loopback 目标：${url.hostname}`)
  if (url.pathname !== '/' || url.search || url.hash) fail(403, 'daemon base 不允许 path / query / hash')
  if (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)) {
    fail(400, 'daemon 端口不合法')
  }
  return url.origin
}

/**
 * daemon 侧路径校验。返回原样 path（保留 %2F 等编码，由 daemon URL 解析）。
 * @param {string} path
 * @param {{allowEncodedSlash?: boolean}} [options]
 */
export function validateDaemonPath(path, { allowEncodedSlash = false } = {}) {
  if (typeof path !== 'string' || path.length < 5 || path.length > 512) fail(400, 'daemon 路径不合法')
  if (!path.startsWith('/api/')) fail(403, '只允许转发 /api/ 前缀的 daemon 路径')
  if (/[\x00-\x1f\x7f]/.test(path)) fail(400, 'daemon 路径含控制字符')
  if (/[?#\\]/.test(path)) fail(400, 'daemon 路径不允许 ? / # / 反斜杠')
  if (path.includes('//')) fail(400, 'daemon 路径不允许连续斜杠')
  if (path.includes('@')) fail(400, 'daemon 路径不允许 @')
  if (path.includes('..')) fail(400, 'daemon 路径不允许 ..')
  if (/%00|%2e/i.test(path)) fail(400, 'daemon 路径不允许编码的 NUL / 点')
  for (const segment of path.split('/').slice(1)) {
    if (segment === '') fail(400, 'daemon 路径存在空段')
    let decoded
    try { decoded = decodeURIComponent(segment) } catch { fail(400, 'daemon 路径百分号编码不合法') }
    if (decoded === '.' || decoded === '..' || decoded.includes('\\') || decoded.includes('\0') || /[?#]/.test(decoded)) {
      fail(400, 'daemon 路径段解码后不安全')
    }
    if (decoded.includes('/') && !allowEncodedSlash) fail(400, 'daemon 路径段解码后含 /（需 encodeURIComponent）')
  }
  return path
}

/** 严格的 query 构造：只接受标量、白名单由调用方在 ROUTES 里做；这里再挡 panel。 */
export function buildQueryString(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) fail(400, 'query 必须是对象')
  const out = []
  for (const [key, raw] of Object.entries(query)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key)) fail(400, `query 字段名不合法：${key}`)
    // 用户版 /api/state 只接 light，panel 被静默忽略；绝不把朋友的假设带过去。
    if (/^panel/i.test(key)) fail(403, `用户版 daemon 不支持 ${key} 参数（会被静默忽略）`)
    if (raw === undefined || raw === null || raw === '') continue
    if (typeof raw === 'object' || typeof raw === 'function') fail(400, `query.${key} 必须是标量`)
    const value = String(raw)
    if (value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) fail(400, `query.${key} 值不合法`)
    out.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  }
  return out.length ? `?${out.join('&')}` : ''
}

/** 防任意反代：没有显式白名单 = 默认拒绝；有则要求完整命中。 */
export function assertAllowed(pathname, allowedPattern) {
  if (!(allowedPattern instanceof RegExp)) fail(403, '缺少 daemon 路径白名单：默认拒绝任意转发')
  allowedPattern.lastIndex = 0
  if (!allowedPattern.test(pathname)) fail(403, `路径不在白名单：${pathname}`)
  allowedPattern.lastIndex = 0
}

async function readCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text()
    if (Buffer.byteLength(text) > maxBytes) fail(502, `daemon 响应过大（>${maxBytes} 字节）`)
    return text
  }
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) fail(502, `daemon 响应过大（>${maxBytes} 字节）`)
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 非 JSON 响应只留 4000 字符，绝不把整页 HTML 塞进渲染进程。 */
export function parseResponseText(text, sanitize = null) {
  let value
  let json = true
  try { value = JSON.parse(text) } catch { value = { raw: text.slice(0, 4000) }; json = false }
  return { value: json && typeof sanitize === 'function' ? sanitize(value) : value, json }
}

/**
 * 精确字段名的深度打码（用于写响应摘要 / 杂项透传）。
 * 刻意不碰泛化的 `key`：用户版 state 里 `ttftTiers[].key` / `modelKey` /
 * `decisionModes[].key` 都是 UI 数据，一刀切会毁掉页面；结构化的密钥脱敏在
 * routes.js#sanitizeState 里按路径精确处理。
 */
const SENSITIVE_NAMES = new Set([
  'adminToken', 'secret', 'password', 'authorization', 'cookie', 'apiKey',
  'masterKey', 'failoverToken', 'panelToken', 'accessToken', 'refreshToken',
])
export function redactSensitiveDeep(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redactSensitiveDeep(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_NAMES.has(k)) out[k] = '***'
    else if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    else out[k] = redactSensitiveDeep(v, depth + 1)
  }
  return out
}

/**
 * 唯一的 daemon 出站请求入口。
 * @returns {Promise<{ok:boolean,status:number,body?:any,error?:string,json?:boolean}>}
 */
export async function daemonRequest(input = {}) {
  const {
    baseUrl, method = 'GET', path, query = {}, body,
    allowedPattern, timeoutMs = DEFAULT_TIMEOUT_MS, allowEncodedSlash = false,
    sanitize = null, maxBytes = DEFAULT_MAX_BYTES, fetchImpl = globalThis.fetch,
  } = input
  const origin = assertLoopbackBase(baseUrl)
  const verb = String(method || '').toUpperCase()
  if (!METHODS.has(verb)) fail(405, `不支持的 method：${verb}`)
  const pathname = validateDaemonPath(path, { allowEncodedSlash })
  assertAllowed(pathname, allowedPattern)
  const search = buildQueryString(query)
  const target = new URL(`${origin}${pathname}${search}`)
  if (target.origin !== origin) fail(403, '构造出的目标 origin 与 loopback base 不一致')

  const mutating = verb !== 'GET' && verb !== 'DELETE'
  let res
  try {
    res = await fetchImpl(target.href, {
      method: verb,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: mutating ? { 'content-type': 'application/json' } : {},
      ...(mutating ? { body: JSON.stringify(body ?? {}) } : {}),
    })
  } catch (err) {
    const timedOut = /timeout|abort/i.test(`${err?.name || ''} ${err?.message || ''}`)
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      error: timedOut ? `daemon 请求超时（${timeoutMs}ms）` : `daemon 不可达：${messageOf(err)}`,
    }
  }
  let text
  try { text = await readCapped(res, maxBytes) } catch (err) {
    return { ok: false, status: 502, error: messageOf(err) }
  }
  let parsed
  try { parsed = parseResponseText(text, sanitize) } catch (err) {
    return { ok: false, status: 502, error: `响应脱敏失败：${messageOf(err)}` }
  }
  const errorText = parsed.value && typeof parsed.value === 'object'
    ? String(parsed.value.error || `HTTP ${res.status}`)
    : `HTTP ${res.status}`
  if (!res.ok) return { ok: false, status: res.status, error: errorText, body: { error: errorText } }
  return { ok: true, status: res.status, body: parsed.value, json: parsed.json }
}

// ---------------------------------------------------------------- 入站防护（供 D 注册 Host 路由时用）

/** 插件 webServer 路由不在宿主 /api 鉴权内，必须自己只认 loopback + 挡跨站。 */
export function checkLocalOrigin(req) {
  const address = String(req?.socket?.remoteAddress || '')
  if (!LOOPBACK_ADDRESSES.has(address)) return { ok: false, reason: `non-loopback socket: ${address || 'unknown'}` }
  const site = String(req?.headers?.['sec-fetch-site'] || '').toLowerCase()
  if (site === 'cross-site' || site === 'same-site') return { ok: false, reason: `sec-fetch-site=${site}` }
  const source = req?.headers?.origin || req?.headers?.referer || ''
  if (source) {
    try {
      const url = new URL(String(source))
      if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return { ok: false, reason: `origin not loopback: ${url.host}` }
    } catch {
      return { ok: false, reason: 'unparsable origin' }
    }
  }
  return { ok: true }
}

/** 写操作强制 application/json（form 发不出，跨站 JSON 必走预检且本机无 CORS 放行）。 */
export function wantsJson(req) {
  const verb = String(req?.method || 'GET').toUpperCase()
  if (verb === 'GET' || verb === 'HEAD') return true
  return String(req?.headers?.['content-type'] || '').toLowerCase().startsWith('application/json')
}

export function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(text)
}

export async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) fail(413, `请求体过大（>${limit} 字节）`)
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try { return JSON.parse(text) } catch { fail(400, '请求体不是合法 JSON') }
}
