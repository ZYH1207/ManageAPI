/**
 * 连接层预检（L1/L2）：在花真钱之前先把「根本连不上的站」筛掉。
 *
 * 为什么要有这一层：一轮 Lite 探针是每目标 2 个真实请求，超时 45 秒。一个 DNS
 * 失败或 TLS 被墙的站，既拿不到任何信息，又占满 45 秒并发槽——真实踩过：本机
 * 代理断线时 9 条供给同时 `fetch failed`，一轮探测拖了七分钟，还被误判成站点
 * 故障。连接层探测只用 DNS/TCP/TLS 握手，几百毫秒、**零 token**。
 *
 * 分层口径（借 TokHub 的 L1/L2/L3 划分，只取前两层）：
 *   L1 链路   —— DNS 解析 → TCP 连接 → TLS 握手
 *   L2 入口   —— HTTP 请求 `/models`，判断是 401/403（Key 无效）还是 5xx/HTML
 *                （入口坏了）；不发对话请求，所以仍然零 token
 *   L3 生成   —— 真发对话请求（core/probe.js，唯一花 token 的一层）
 *
 * 纯判定层，不改任何数据；调用方拿到 layer 决定要不要继续跑 L3。
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { lookup } from 'node:dns/promises'

/** 各层超时：连接层卡住比慢更常见，给得比对话超时短得多 */
export const DNS_TIMEOUT_MS = 3000
export const TCP_TIMEOUT_MS = 4000
export const L2_TIMEOUT_MS = 8000

function withTimeout(promise, ms, label) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** 'https://api.x.com/v1' → { protocol, host, port, pathPrefix } */
export function parseBaseUrl(baseUrl) {
  try {
    const u = new URL(String(baseUrl || '').trim())
    const protocol = u.protocol === 'http:' ? 'http' : 'https'
    return {
      ok: true,
      protocol,
      host: u.hostname,
      port: Number(u.port) || (protocol === 'https' ? 443 : 80),
      pathPrefix: u.pathname.replace(/\/+$/, ''),
    }
  } catch {
    return { ok: false, protocol: null, host: null, port: null, pathPrefix: '' }
  }
}

/**
 * L1：DNS → TCP → TLS。返回第一个失败的层。
 * @returns {{layer:'dns'|'tcp'|'tls'|null, ok:boolean, ms:number, error:string|null,
 *            resolvedIp:string|null}}
 */
export async function probeConnectivity(baseUrl, { timeoutMs = {} } = {}) {
  const started = Date.now()
  const parsed = parseBaseUrl(baseUrl)
  if (!parsed.ok) {
    return { ok: false, layer: 'dns', ms: 0, error: '地址不是合法 URL', resolvedIp: null }
  }

  // ---- DNS
  let ip = null
  try {
    const records = await withTimeout(
      lookup(parsed.host),
      timeoutMs.dns ?? DNS_TIMEOUT_MS,
      'DNS 解析',
    )
    ip = records?.address || null
    if (!ip) throw new Error('DNS 没有返回地址')
  } catch (error) {
    return {
      ok: false,
      layer: 'dns',
      ms: Date.now() - started,
      error: `DNS 解析失败：${error.message}`,
      resolvedIp: null,
    }
  }

  // ---- TCP
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        const socket = netConnect({ host: parsed.host, port: parsed.port })
        const done = (error) => {
          socket.removeAllListeners()
          socket.destroy()
          if (error) reject(error)
          else resolve()
        }
        socket.setTimeout(timeoutMs.tcp ?? TCP_TIMEOUT_MS, () => done(new Error('TCP 连接超时')))
        socket.once('connect', () => done())
        socket.once('error', (error) => done(error))
      }),
      timeoutMs.tcp ?? TCP_TIMEOUT_MS,
      'TCP 连接',
    )
  } catch (error) {
    return {
      ok: false,
      layer: 'tcp',
      ms: Date.now() - started,
      error: `TCP 连接失败：${error.message}`,
      resolvedIp: ip,
    }
  }

  // ---- TLS（只对 https）
  if (parsed.protocol === 'https') {
    try {
      await withTimeout(
        new Promise((resolve, reject) => {
          const socket = tlsConnect({
            host: parsed.host,
            port: parsed.port,
            servername: parsed.host,
            rejectUnauthorized: false, // 证书过期也照样能用，这里只判「通不通」
          })
          const done = (error) => {
            socket.removeAllListeners()
            socket.destroy()
            if (error) reject(error)
            else resolve()
          }
          socket.setTimeout(timeoutMs.tcp ?? TCP_TIMEOUT_MS, () => done(new Error('TLS 握手超时')))
          socket.once('secureConnect', () => done())
          socket.once('error', (error) => done(error))
        }),
        timeoutMs.tcp ?? TCP_TIMEOUT_MS,
        'TLS 握手',
      )
    } catch (error) {
      return {
        ok: false,
        layer: 'tls',
        ms: Date.now() - started,
        error: `TLS 握手失败：${error.message}`,
        resolvedIp: ip,
      }
    }
  }

  return { ok: true, layer: null, ms: Date.now() - started, error: null, resolvedIp: ip }
}

/**
 * L2：打 `/models` 判入口与 Key 是否有效。**不发对话请求，零 token**。
 *
 * 分类：
 *   'ok'        2xx，且有 data 数组（或至少是 JSON）
 *   'auth'      401/403 —— Key 无效或没权限（站是通的，问题在凭据）
 *   'entry'     其他状态码 / 返回 HTML / 不是 JSON —— 入口坏了（网关页、反代 502）
 *   'unreachable' 请求本身失败（连接被重置、超时）
 *
 * @returns {{kind:'ok'|'auth'|'entry'|'unreachable', status:number|null,
 *            ms:number, error:string|null, modelCount:number|null}}
 */
export async function probeEntry({ baseUrl, apiKey, timeoutMs = L2_TIMEOUT_MS } = {}) {
  const started = Date.now()
  const parsed = parseBaseUrl(baseUrl)
  if (!parsed.ok) {
    return { kind: 'unreachable', status: null, ms: 0, error: '地址不是合法 URL', modelCount: null }
  }
  const url = `${parsed.protocol}://${parsed.host}:${parsed.port}${parsed.pathPrefix}/models`
  const doRequest = parsed.protocol === 'https' ? httpsRequest : httpRequest

  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve({ ...value, ms: Date.now() - started })
    }
    const req = doRequest(
      url,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey || ''}`, Accept: 'application/json' },
        timeout: timeoutMs,
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          if (body.length < 4000) body += chunk
        })
        res.on('end', () => {
          const status = res.statusCode || 0
          if (status === 401 || status === 403) {
            finish({ kind: 'auth', status, error: `HTTP ${status}（Key 无效或无权限）`, modelCount: null })
            return
          }
          if (status < 200 || status >= 300) {
            finish({ kind: 'entry', status, error: `HTTP ${status}`, modelCount: null })
            return
          }
          let parsedBody = null
          try {
            parsedBody = JSON.parse(body)
          } catch {
            finish({ kind: 'entry', status, error: '返回不是 JSON（多半落到网关页/反代页）', modelCount: null })
            return
          }
          const data = parsedBody?.data
          finish({
            kind: 'ok',
            status,
            error: null,
            modelCount: Array.isArray(data) ? data.length : null,
          })
        })
        res.on('error', (error) => finish({ kind: 'unreachable', status: null, error: error.message, modelCount: null }))
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error('HTTP 请求超时'))
    })
    req.on('error', (error) => finish({ kind: 'unreachable', status: null, error: error.message, modelCount: null }))
    req.end()
  })
}

/**
 * 一次跑完 L1 + L2，给探测执行器用。
 *
 * @returns {{ok:boolean, layer:'dns'|'tcp'|'tls'|'auth'|'entry'|null,
 *            error:string|null, ms:number, modelCount:number|null, resolvedIp:string|null}}
 *   ok=true 才该继续跑 L3（真发对话请求）
 */
export async function preflight({ baseUrl, apiKey, timeoutMs = {} } = {}) {
  const conn = await probeConnectivity(baseUrl, { timeoutMs })
  if (!conn.ok) {
    return {
      ok: false,
      layer: conn.layer,
      error: conn.error,
      ms: conn.ms,
      modelCount: null,
      resolvedIp: conn.resolvedIp,
    }
  }
  const entry = await probeEntry({ baseUrl, apiKey, timeoutMs: timeoutMs.l2 ?? L2_TIMEOUT_MS })
  const ok = entry.kind === 'ok'
  return {
    ok,
    layer: ok ? null : entry.kind === 'unreachable' ? 'tcp' : entry.kind,
    error: entry.error,
    ms: conn.ms + entry.ms,
    modelCount: entry.modelCount,
    resolvedIp: conn.resolvedIp,
  }
}
