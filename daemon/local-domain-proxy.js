#!/usr/bin/env node
/** Fixed formal entry: http://manage-api.localhost/ -> 127.0.0.1:4319.
 * No discovery or port drift: a stopped formal daemon must never select a preview.
 */
import { createServer, request } from 'node:http'
import { open, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isIP } from 'node:net'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DOMAIN = 'manage-api.localhost'
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection'])

function portNumber(value, allowZero = false) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 65535) {
    throw new Error('Port must be an integer between 1 and 65535')
  }
  return value
}

function loopback(address) {
  if (typeof address !== 'string') return false
  const value = address.toLowerCase().replace(/^::ffff:/, '')
  return (isIP(value) === 4 && value.startsWith('127.')) || value === '::1'
}

function cleanHeaders(headers) {
  const removed = new Set(HOP)
  for (const name of String(headers.connection || '').split(',')) removed.add(name.trim().toLowerCase())
  const clean = {}
  for (const [name, value] of Object.entries(headers)) {
    if (removed.has(name) || name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-real-ip') continue
    clean[name] = value
  }
  return clean
}

function allowedHost(value, port) {
  return typeof value === 'string' && (value.toLowerCase() === DOMAIN || value.toLowerCase() === `${DOMAIN}:${port}`)
}

function allowedOrigin(value, port) {
  if (value === undefined) return true // CLI and API clients need not send Origin.
  return typeof value === 'string' && (value === `http://${DOMAIN}` || value === `http://${DOMAIN}:${port}`)
}

function fail(res, status, message) {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) { res.destroy(); return }
  const body = JSON.stringify({ error: message, entry: 'formal' })
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-ManageAPI-Entry': 'formal', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

/** Factory has no side effects until listen(). All upstream traffic is loopback HTTP. */
export function createLocalDomainProxy({ targetPort = 4319, port = 80, ipv6 = true, listenFds = null } = {}) {
  portNumber(targetPort)
  portNumber(port, true)
  if (listenFds !== null && (!Array.isArray(listenFds) || listenFds.length < 1 || listenFds.length > 2 ||
    listenFds.some((fd) => !Number.isInteger(fd) || fd < 3) || new Set(listenFds).size !== listenFds.length)) {
    throw new Error('listenFds must contain one or two distinct inherited socket descriptors >= 3')
  }
  const servers = []
  const sockets = new Set()
  const upstreams = new Set()
  let actualPort = port
  let listening = false
  let identityUntil = 0
  let identityCheck = null

  function isFormal() {
    if (Date.now() < identityUntil) return Promise.resolve(true)
    if (identityCheck) return identityCheck
    identityCheck = new Promise((done) => {
      const check = request({ hostname: '127.0.0.1', port: targetPort, path: '/api/instance',
        headers: { host: `127.0.0.1:${targetPort}` }, agent: false }, (incoming) => {
        let text = ''
        incoming.setEncoding('utf8')
        incoming.on('data', (chunk) => { text += chunk; if (text.length > 16384) check.destroy() })
        incoming.on('error', () => done(false))
        incoming.on('end', () => {
          try { done(incoming.statusCode === 200 && JSON.parse(text).mode === 'formal') } catch { done(false) }
        })
      })
      upstreams.add(check)
      check.once('close', () => upstreams.delete(check))
      const deadline = setTimeout(() => check.destroy(new Error('Identity deadline exceeded')), 1000)
      check.once('error', () => done(false))
      check.once('close', () => clearTimeout(deadline))
      check.end()
    }).then((ok) => { if (ok) identityUntil = Date.now() + 1000; return ok })
      .finally(() => { identityCheck = null })
    return identityCheck
  }

  async function handler(req, res) {
    res.setHeader('X-ManageAPI-Entry', 'formal')
    if (!loopback(req.socket.remoteAddress)) { fail(res, 403, 'Formal entry accepts local connections only'); return }
    if (!allowedHost(req.headers.host, req.socket.localPort)) { fail(res, 403, `Use http://${DOMAIN}/ for the formal instance`); return }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !allowedOrigin(req.headers.origin, req.socket.localPort)) {
      fail(res, 403, 'Foreign Origin cannot change the formal instance'); return
    }
    // Only origin-form request targets; absolute URLs must not become proxy instructions.
    if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) {
      fail(res, 400, 'Invalid local request target'); return
    }
    if (!(await isFormal())) {
      fail(res, 502, `Formal ManageAPI unavailable at 127.0.0.1:${targetPort}; formal instance identity could not be verified; previews are not used`)
      return
    }
    if (req.aborted || res.destroyed) return
    const headers = cleanHeaders(req.headers)
    headers.host = `127.0.0.1:${targetPort}`
    const upstream = request({ hostname: '127.0.0.1', port: targetPort, method: req.method,
      path: req.url, headers, agent: false }, (incoming) => {
      if (res.destroyed) { incoming.destroy(); return }
      const responseHeaders = cleanHeaders(incoming.headers)
      responseHeaders['x-manageapi-entry'] = 'formal'
      res.writeHead(incoming.statusCode || 502, responseHeaders)
      // SSE headers must arrive even when the first event is still pending.
      res.flushHeaders()
      incoming.on('error', () => res.destroy())
      incoming.pipe(res)
    })
    upstreams.add(upstream)
    upstream.on('close', () => upstreams.delete(upstream))
    upstream.on('error', () => fail(res, 502, `Formal ManageAPI unavailable at 127.0.0.1:${targetPort}; previews are not used`))
    const cancel = () => upstream.destroy()
    req.on('aborted', cancel)
    req.on('error', cancel)
    res.on('close', () => { if (!res.writableFinished) cancel() })
    req.pipe(upstream)
  }

  async function close() {
    for (const upstream of upstreams) upstream.destroy()
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(() => done()))))
    listening = false
  }

  async function bind(host, fd = null) {
    const server = createServer(handler)
    server.requestTimeout = 0
    server.timeout = 0
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    // WebSocket upgrades are intentionally unsupported, rather than left hanging.
    server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n'))
    await new Promise((done, reject) => {
      const onError = (error) => { server.removeListener('listening', onListen); reject(error) }
      const onListen = () => { server.removeListener('error', onError); done() }
      server.once('error', onError)
      server.once('listening', onListen)
      server.listen(fd === null ? { port: actualPort, host, ipv6Only: host === '::1' } : { fd })
    })
    servers.push(server)
    const address = server.address()
    if (!address || typeof address === 'string' || !loopback(address.address) ||
      (fd !== null && actualPort !== 0 && address.port !== actualPort)) {
      throw new Error('Inherited listener must be a loopback TCP socket on the configured port')
    }
    actualPort = address.port
  }

  async function listen() {
    if (listening) return status()
    try {
      if (listenFds) {
        for (const fd of listenFds) await bind(null, fd)
      } else {
        await bind('127.0.0.1')
        if (ipv6) {
          try { await bind('::1') } catch (error) {
            if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)) throw error
          }
        }
      }
      listening = true
      return status()
    } catch (error) {
      await close()
      throw new Error(`Cannot bind formal entry on loopback port ${actualPort}: ${error.code || error.message}. No alternate port was selected.`, { cause: error })
    }
  }

  function status() {
    return { port: actualPort, addresses: servers.map((server) => server.address()?.address).filter(Boolean), targetPort }
  }
  return { listen, close, status }
}

async function readRootConfig(file) {
  if (!file || !isAbsolute(file)) throw new Error('--config requires an absolute root-owned JSON file path')
  const before = await lstat(file)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Config must be a regular file, not a symlink')
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const info = await handle.stat()
    // Windows runs this entry as the installing user, never as SYSTEM. POSIX installs
    // bind port 80 as root and therefore require a root-controlled configuration.
    if (process.platform !== 'win32' && (info.uid !== 0 || (info.mode & 0o022))) {
      throw new Error('Config must be owned by root and not writable by group or others')
    }
    const config = JSON.parse(await handle.readFile('utf8'))
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Config must be a JSON object')
    if (Object.keys(config).some((key) => !['targetPort', 'uid', 'gid'].includes(key))) throw new Error('Config supports only targetPort, uid and gid')
    portNumber(config.targetPort ?? 4319)
    if (process.platform === 'win32' && (config.uid !== undefined || config.gid !== undefined)) {
      throw new Error('Windows entry runs as the installing user; uid/gid options are not supported')
    }
    if ((config.uid === undefined) !== (config.gid === undefined)) throw new Error('Provide both uid and gid to drop privileges')
    for (const key of ['uid', 'gid']) {
      if (config[key] !== undefined && (!Number.isInteger(config[key]) || config[key] <= 0)) throw new Error(`${key} must be a positive integer`)
    }
    return config
  } finally { await handle.close() }
}

async function main() {
  const args = process.argv.slice(2)
  if (![2, 4].includes(args.length) || args[0] !== '--config' || (args.length === 4 && args[2] !== '--listen-fds')) {
    throw new Error('Usage: node daemon/local-domain-proxy.js --config /absolute/config.json [--listen-fds 3,4]')
  }
  const config = await readRootConfig(args[1])
  const listenFds = args.length === 4 ? args[3].split(',').map((part) => /^\d+$/.test(part) ? Number(part) : NaN) : null
  const proxy = createLocalDomainProxy({ targetPort: config.targetPort ?? 4319, listenFds })
  try {
    const bound = await proxy.listen()
    if (typeof process.getuid === 'function' && process.getuid() === 0 && config.uid !== undefined) {
      process.setgroups([])
      process.setgid(config.gid)
      process.setuid(config.uid)
    }
    console.log(`Formal ManageAPI: http://${DOMAIN}/ -> 127.0.0.1:${bound.targetPort} (${bound.addresses.join(', ')})`)
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { proxy.close().then(() => process.exit(0)) })
  } catch (error) { await proxy.close(); throw error }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(`[manage-api formal entry] ${error.message}`); process.exitCode = 1 })
}
