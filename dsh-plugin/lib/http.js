/**
 * 插件 HTTP 路由的本地来源防护。
 *
 * ## 为什么必须自己防
 *
 * 宿主的 `/api` 网关有鉴权（无凭据 401），但**插件通过 `webServer.register()` 注册的路由不在该保护范围内**
 * （本机实测先例：另一个插件的不带凭据 POST 返回 200 且真的改了配置）。
 *
 * 你的环境里还多一层风险：profile 装了 `@linxin666/dsh-remote-web-ui` 且开了 `autoTunnel: true` +
 * `ingressSync: true`，同源路由可能被隧道暴露到公网。因此这里**只认 loopback**，任何非回环来源一律 403。
 *
 * ## 威胁模型
 *
 * | 攻击面 | 可行 | 说明 |
 * |---|---|---|
 * | 外部网络 | 隧道开启时**可能** | 靠 socket 地址判定：非回环直接拒 |
 * | 恶意网页 | 是 | 用 Origin/Referer + Sec-Fetch-Site + 写操作强制 JSON 三条独立信号挡 |
 * | 本机其它进程 | 是 | 属于既有信任边界，不防（本机进程本来就能读文件） |
 *
 * `<form>` 只能发 urlencoded / multipart / text-plain，**发不出 application/json**；
 * 强制 JSON 等价于「必须 fetch/XHR + 预检」，而预检会被 Origin 检查拦下。
 */

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkLocalOrigin(req) {
  const socket = req.socket || {}
  const address = socket.remoteAddress || ''
  if (!LOOPBACK_ADDRESSES.has(address)) {
    return { ok: false, reason: `non-loopback socket address: ${address || 'unknown'}` }
  }

  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
  if (site === 'cross-site' || site === 'same-site') {
    return { ok: false, reason: `sec-fetch-site=${site}` }
  }

  const source = req.headers.origin || req.headers.referer || ''
  const method = String(req.method || 'GET').toUpperCase()
  const isRead = method === 'GET' || method === 'HEAD'

  if (source) {
    try {
      const url = new URL(String(source))
      if (!LOOPBACK_HOSTNAMES.has(url.hostname) && !LOOPBACK_HOSTNAMES.has(url.host)) {
        return { ok: false, reason: `origin host not loopback: ${url.host}` }
      }
    } catch {
      return { ok: false, reason: `unparsable origin: ${String(source).slice(0, 80)}` }
    }
    return { ok: true }
  }

  // 没有任何 Origin/Referer：只读请求可以（同源 fetch GET 不带 Origin），写操作一律拒。
  if (isRead) return { ok: true }
  return { ok: false, reason: 'mutating request without Origin/Referer' }
}

/**
 * 写操作必须是 application/json（见文件头）。
 * @param {import('node:http').IncomingMessage} req
 */
export function wantsJson(req) {
  const method = String(req.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return true
  const type = String(req.headers['content-type'] || '').toLowerCase()
  return type.startsWith('application/json')
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
export function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(payload)
}

/**
 * 读请求体（小体，超限直接拒）。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 */
export async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error(`请求体过大（>${limit} 字节）`)
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  return JSON.parse(text)
}
