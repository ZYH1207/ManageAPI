/**
 * E2E · /api/manage-api 路由端到端（真实 node:http 服务器 + 真实 daemon 4319 只读）。
 *
 * 目的：把「静态形状对了 ≠ 路由真能通」这条漏掉过的坑固化成正式测试。
 *
 * 做法：
 *  1) 用假 webServer 收集 registerHttpRoutes 的注册项，断言带参路由是 prefix、
 *     其余 5 条只读 + panel 仍是 exact；
 *  2) 真起一个 node:http 服务器（listen 127.0.0.1:0，绝不占 4319），按 DSH 的
 *     匹配语义分发：exact 表全等 → prefix 表最长前缀 → 无匹配 404；
 *  3) 真打各 URL 断言状态码与 body；provider id 从 /state 实时取；
 *  4) 全程不 spawn daemon；只读访问已在 4319 跑的 daemon（PID 811）；
 *  5) 关闭服务器、调 disposer，断言 7/7 disposer 全被调用。
 *
 * 失败直接抛（node 非零退出）。
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const httpServerMod = await import(pathToFileURL(resolve(root, 'lib/http-server.js')).href)

const PANEL = '/api/manage-api/panel'
const DAEMON_PORT = 4319 // 已在运行的 daemon（PID 811），只读访问，绝不监听/占用

// ── 假 webServer：按 DSH 语义存两张表，并记录每条注册项与 disposer 状态 ──
function makeFakeWebServer() {
  const exact = new Map()
  const prefixes = new Map()
  const records = [] // { kind, path, disposed }
  return {
    exact,
    prefixes,
    records,
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route "${route.path}"`)
      table.set(route.path, route)
      const rec = { kind: route.kind, path: route.path, disposed: false }
      records.push(rec)
      return () => {
        table.delete(route.path)
        rec.disposed = true
      }
    },
    // 复刻 DSH responderFor/match：exact 全等 → prefix 最长前缀（pathname===prefix 或 startsWith(prefix+'/')）
    match(pathname) {
      const exactHit = exact.get(pathname)
      if (exactHit !== undefined) return exactHit
      let best
      for (const [prefix, route] of prefixes) {
        if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
        if (best === void 0 || prefix.length > best.path.length) best = route
      }
      return best
    },
  }
}

// ── 计数器：包住 globalThis.fetch，记录真正打到 daemon 的请求数（判定「有没有泄漏给 daemon」）──
let daemonHits = 0
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input)
  if (url.includes(`127.0.0.1:${DAEMON_PORT}`)) daemonHits += 1
  return realFetch(input, init)
}

// ── 启动真实 SUT 分发服务器 ──
const webServer = makeFakeWebServer()
const registration = httpServerMod.registerHttpRoutes({ webServer, port: DAEMON_PORT, log: () => {} })

// 1) 注册项形状断言（要求 1）
{
  assert.equal(registration.count, 7, `应注册 7 条，实际 ${registration.count}`)
  assert.equal(webServer.records.length, 7)
  const prefixRecords = webServer.records.filter((r) => r.kind === 'prefix')
  assert.equal(prefixRecords.length, 1, '带 :id 的路由应只有 1 条且为 prefix')
  assert.equal(prefixRecords[0].path, '/api/manage-api/providers', '带参路由的稳定前缀应为 /api/manage-api/providers')
  const exactRecords = webServer.records.filter((r) => r.kind === 'exact')
  assert.deepEqual(exactRecords.map((r) => r.path).sort(), [
    '/api/manage-api/health', '/api/manage-api/monitor', '/api/manage-api/state',
    '/api/manage-api/usage', '/api/manage-api/usage/detail', PANEL,
  ].sort(), '5 条只读 + panel 应仍为 exact')
}

const dispatcher = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://placeholder').pathname
  const responder = webServer.match(pathname)
  if (responder === undefined) {
    res.statusCode = 404
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, error: 'NO_ROUTE_MATCH' }))
    return
  }
  Promise.resolve(responder.handler(req, res)).catch(() => {
    if (!res.headersSent) { res.statusCode = 500; res.end('{}') }
  })
})

await new Promise((ok, bad) => { dispatcher.once('error', bad); dispatcher.listen(0, '127.0.0.1', ok) })
const sutPort = dispatcher.address().port
assert.notEqual(sutPort, DAEMON_PORT, 'SUT 绝不能占用 4319')

function hit(pathAndQuery) {
  return new Promise((ok, bad) => {
    const req = http.get({ host: '127.0.0.1', port: sutPort, path: pathAndQuery }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        let body = null
        try { body = JSON.parse(raw) } catch { /* 非 JSON 时 body=null */ }
        ok({ status: res.statusCode, raw, body })
      })
    })
    req.on('error', bad)
  })
}

const passed = []
const ok = (label) => { passed.push(label); console.log(`  ok  ${label}`) }

const results = {} // path -> status，用于报告

try {
  // 2) /health → 200 且 body.ok===true
  {
    const r = await hit('/api/manage-api/health')
    results['/health'] = r.status
    assert.equal(r.status, 200, `health 应 200，实际 ${r.status}`)
    assert.equal(r.body && r.body.ok, true, 'health body.ok 应为 true')
    ok('/api/manage-api/health → 200 {ok:true}')
  }

  // 3) /state → 200 且 body 里搜不到 sk-mapi- 明文；顺带取真实 provider id
  let providerId = null
  {
    const r = await hit('/api/manage-api/state')
    results['/state'] = r.status
    assert.equal(r.status, 200, `state 应 200，实际 ${r.status}`)
    assert.equal(r.raw.includes('sk-mapi-'), false, 'state 响应不得含 sk-mapi- 明文')
    const providers = r.body && Array.isArray(r.body.providers) ? r.body.providers : []
    providerId = providers[0] && providers[0].id
    assert.ok(providerId, 'state 里应能取到真实 provider id')
    ok(`/api/manage-api/state → 200，无 sk-mapi- 明文，providerId=${providerId}`)
  }

  // 4) /usage?days=7 → 200
  {
    const r = await hit('/api/manage-api/usage?days=7')
    results['/usage?days=7'] = r.status
    assert.equal(r.status, 200, `usage 应 200，实际 ${r.status}`)
    ok('/api/manage-api/usage?days=7 → 200')
  }

  // 5) /providers/<真实id>/groups → 200（确认 prefix 把请求放进来且 suffixMatcher 收紧命中）
  {
    const r = await hit(`/api/manage-api/providers/${providerId}/groups`)
    results['/providers/<id>/groups'] = r.status
    assert.equal(r.status, 200, `providers/<id>/groups 应 200，实际 ${r.status} body=${r.raw.slice(0, 160)}`)
    ok(`/api/manage-api/providers/${providerId}/groups → 200`)
  }

  // 6) /providers/x/y/z（多余段）→ 404，且绝不透传 daemon（daemonHits 增量 0）
  {
    daemonHits = 0
    const r = await hit('/api/manage-api/providers/x/y/z')
    results['/providers/x/y/z'] = r.status
    assert.equal(r.status, 404, `多余段应 404，实际 ${r.status}`)
    assert.equal(daemonHits, 0, '多余段绝不能透传给 daemon（daemonHits 应为 0）')
    ok('/api/manage-api/providers/x/y/z → 404，未透传 daemon (daemonHits=0)')
  }

  // 7) /panel?panel=1 → 403（panel=1 必须被拒，且不请求 daemon）
  {
    daemonHits = 0
    const r = await hit('/api/manage-api/panel?panel=1')
    results['/panel?panel=1'] = r.status
    assert.equal(r.status, 403, `panel=1 应 403，实际 ${r.status}`)
    assert.equal(daemonHits, 0, 'panel 拒绝不应请求 daemon')
    ok('/api/manage-api/panel?panel=1 → 403')
  }
} finally {
  // 8) 关闭服务器、调 disposer，断言 7/7 disposer 全调用（要求 5）
  await new Promise((ok) => dispatcher.close(ok))
  registration.dispose()
  const disposedCount = webServer.records.filter((r) => r.disposed === true).length
  assert.equal(disposedCount, 7, `7 条 disposer 应全部调用，实际 ${disposedCount}/7`)
  ok('关闭服务器 + dispose：7/7 disposer 全部调用')
  globalThis.fetch = realFetch
}

console.log('\n[status code table]')
for (const [k, v] of Object.entries(results)) console.log(`  ${String(v).padEnd(4)} ${k}`)
console.log(`\ncheck-http-e2e: ${passed.length} 组断言通过`)
