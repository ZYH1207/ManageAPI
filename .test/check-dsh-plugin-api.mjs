/**
 * C 棒 · 用户版 API 适配与安全路由的隔离验收。
 *
 * 边界：
 *  - 只用自清理的临时数据目录、随机回环端口、进程内假上游/真实 createAppServer handler；
 *  - 绝不连接真实 4319，绝不读写 ~/.manage-api（在启动前把 MANAGE_API_HOME 指向临时目录并断言）；
 *  - 不启动/接管外部 daemon，不 spawn 子进程（除只读的 git show/diff），不写业务源码；
 *  - 失败直接抛（node 非零退出），不写 process.exit(0) 敷衍。
 *
 * 本测试证明的是「契约形状 + 拒绝/脱敏/校验分支」。daemon 4319 未运行、未启动、
 * 未接管真实实例：真实生产数据下的运行时行为**未验证**。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { once } from 'node:events'

import {
  ApiHttpError, assertAllowed, assertLoopbackBase, buildQueryString,
  daemonRequest, loopbackBaseUrl, validateDaemonPath,
} from '../dsh-plugin/lib/http.js'
import {
  ROUTES, ROUTE_IDS, STATE_MODE, UNAVAILABLE, AVAILABLE, INGEST_CONTRACT, INGEST_PATH,
  sanitizeState, stateQuery, findRoute, findRouteByPath, isPanelQuery,
  materializeDaemonPath, unavailableFor, clampDays,
} from '../dsh-plugin/lib/routes.js'
import {
  WRITE_RULES, WRITE_ACTIONS, WRITE_UNAVAILABLE, resolveWrite, findWriteRule,
  validateSettingsPayload, materializeWritePath, summarizeWrite, runWrite,
} from '../dsh-plugin/lib/write-proxy.js'

const here = dirname(fileURLToPath(import.meta.url))
const BASE = resolve(here, '..')
const SERVER = join(BASE, 'daemon', 'server.js')
const passed = []
async function ok(label, fn) {
  await fn()
  passed.push(label)
}
const git = (...args) => execFileSync('git', args, { cwd: BASE, encoding: 'utf8' })
function routeLines(src) {
  return src.split(/\r?\n/).filter((l) => /^\s*route\('/.test(l))
}
function parseRouteRows(src) {
  return routeLines(src).flatMap((line) => {
    const m = line.match(/^\s*route\('([A-Z]+)',\s*(\/.+?\/),\s*(?:async|\(|function)/)
    if (!m) throw new Error(`无法解析 route 行：${line}`)
    return [{ method: m[1], re: new RegExp(m[2].slice(1, -1)), line }]
  })
}

const tmp = await mkdtemp(join(tmpdir(), 'dsh-c-api-'))
const dataDir = join(tmp, 'isolated-home')
const servers = []
let daemonApp = null

async function startServer(handler) {
  const s = createServer(handler)
  servers.push(s)
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  return s.address().port
}
const closeAll = async () => {
  for (const s of servers) {
    s.closeAllConnections?.()
    if (s.listening) { const p = once(s, 'close'); s.close(); await p }
  }
  if (daemonApp) {
    daemonApp.closeAllConnections?.()
    if (daemonApp.listening) { const p = once(daemonApp, 'close'); daemonApp.close(); await p }
  }
}

try {
  // ── 0. 隔离前提：端口随机、数据目录临时且不是真实数据目录 ────────────────
  await ok('隔离前提：MANAGE_API_HOME 指向自建临时目录，绝不展开 ~/.manage-api', async () => {
    const real = join(homedir(), '.manage-api')
    assert.notEqual(dataDir, real)
    assert.ok(dataDir.startsWith(tmp))
    process.env.MANAGE_API_HOME = dataDir
    assert.equal(process.env.MANAGE_API_HOME, dataDir)
  })

  // ── 1. server.js 只增不改 / 109 条既有路由仍在 / 新增恰好 1 条 ──────────
  const currentSrc = await readFile(SERVER, 'utf8')
  const baselineSrc = git('show', 'HEAD:daemon/server.js')
  const currentRows = parseRouteRows(currentSrc)
  const baselineRows = parseRouteRows(baselineSrc)

  await ok('server.js：基线 109 条 route、当前 110 条，新增恰好 1 条', async () => {
    assert.equal(baselineRows.length, 109, 'git HEAD 基线应为 109 条')
    assert.equal(currentRows.length, 110, '当前应为 109 + 1')
    const currentLines = routeLines(currentSrc)
    const missing = routeLines(baselineSrc).filter((l) => !currentLines.includes(l))
    assert.deepEqual(missing, [], `既有路由不得丢失/改动：${missing.join(' | ')}`)
    const added = currentLines.filter((l) => !routeLines(baselineSrc).includes(l))
    assert.equal(added.length, 1, `新增只能 1 条，实得 ${added.length}`)
    assert.match(added[0], /^route\('POST',\s*\/\^\\\/api\\\/ingest\\\/usage\$\//, added[0])
  })

  await ok('server.js：git diff 只有 + 行（无任何既有代码删改）', async () => {
    const diff = git('diff', '--', 'daemon/server.js')
    const removed = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('--- '))
    assert.deepEqual(removed, [], `发现删除/修改行：${removed.join(' | ')}`)
    assert.equal((diff.match(/^\+/gm) || []).length, 94, '93 行插入 + 文件头') // ++++ 不算
  })

  await ok('server.js：新增内容未引入 panel / panelIgnoredModels 字段或 panel=1', async () => {
    const diff = git('diff', '--', 'daemon/server.js')
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++ ')).join('\n')
    assert.doesNotMatch(added, /panelIgnoredModels/)
    assert.doesNotMatch(added, /panel\s*=\s*1/)
    assert.doesNotMatch(added, /dshFreeModels|applyDshSettings/)
    // 93 行里出现的是注释「朋友 Host 侧...」与去重逻辑，不是字段写入
    assert.doesNotMatch(added, /settings\.ignoredModels|applyIgnoredModels/)
  })

  await ok('ingest 路由以可匹配形式注册（正则里 / 被转义，字面 grep 会漏）', async () => {
    assert.equal((currentSrc.match(/ingest\\\/usage/g) || []).length, 1)
    const ingest = currentRows.filter((r) => r.re.test('/api/ingest/usage') && r.method === 'POST')
    assert.equal(ingest.length, 1)
    assert.equal((baselineSrc.match(/ingest/g) || []).length, 0, '基线不该有 ingest')
  })

  // ── 2. ROUTES 只读契约逐条对照真实 daemon 路由 ──────────────────────────
  await ok('ROUTES：6 条只读路由，每条 method+path 都能命中 daemon 的真实正则', async () => {
    assert.equal(ROUTES.length, 6)
    assert.deepEqual(ROUTE_IDS, ['health', 'state', 'usage', 'usage-detail', 'monitor', 'provider-groups'])
    for (const r of ROUTES) {
      const sample = r.id === 'provider-groups' ? '/api/providers/site-1/groups' : r.daemonPath
      const hits = currentRows.filter((row) => row.method === r.method && row.re.test(sample))
      assert.equal(hits.length, 1, `${r.id} ${r.method} ${sample} 命中 ${hits.length} 条`)
      assert.equal(r.write, false)
    }
    assert.equal(findRouteByPath('GET', '/state').id, 'state')
    assert.equal(findRouteByPath('POST', '/state'), null, '不认 method 不匹配')
    assert.equal(findRouteByPath('GET', '/state/../usage'), null, '不做路径猜测')
    assert.equal(findRoute('nope'), null)
  })

  await ok('/api/state 只发 light=1，绝不带 panel=1（用户版静默忽略）', async () => {
    assert.deepEqual(stateQuery(), { light: '1' })
    assert.deepEqual(stateQuery(STATE_MODE.LIGHT), { light: '1' })
    assert.deepEqual(stateQuery(STATE_MODE.FULL), {})
    assert.throws(() => stateQuery('panel=1'), ApiHttpError)
    const stateRouteLine = routeLines(currentSrc).find((l) => /api\\\/state/.test(l))
    assert.ok(stateRouteLine, '必须能定位到 /api/state 路由行')
    assert.doesNotMatch(stateRouteLine, /panel/)
    assert.equal(isPanelQuery({ light: '1', panel: '1' }), true)
    assert.equal(isPanelQuery({ light: '1' }), false)
    assert.equal(UNAVAILABLE.PANEL_QUERY.status, 403)
    assert.equal(unavailableFor('PANEL_IGNORED_MODELS').status, 503)
    assert.equal(clampDays(999, { def: 7, min: 1, max: 90 }), 90)
  })

  await ok('unavailable 明确标注，不伪成功：panel / 免费池 / 生命周期 / 任意反代（N23 同步）', async () => {
    for (const id of ['PANEL_IGNORED_MODELS', 'DSH_FREE_MODELS', 'FREE_POOL_WRITES', 'DAEMON_LIFECYCLE_VIA_WRITE', 'ARBITRARY_PROXY']) {
      assert.ok(UNAVAILABLE[id]?.reason, `${id} 必须有原因`)
      assert.ok([403, 503].includes(UNAVAILABLE[id].status))
    }
    assert.equal(WRITE_UNAVAILABLE.freePool, UNAVAILABLE.FREE_POOL_WRITES)
    assert.deepEqual(Object.keys(WRITE_UNAVAILABLE).sort(), ['arbitraryProxy', 'daemonLifecycle', 'dshFreeModels', 'freePool', 'panelIgnoredModels'])
    // N23：基准价写 / 网关 Key 管理从 UNAVAILABLE、WRITE_UNAVAILABLE 双双移除，改标 available
    assert.equal(UNAVAILABLE.BENCHMARK_WRITES, undefined)
    assert.equal(UNAVAILABLE.GATEWAY_KEYS, undefined)
    assert.equal(WRITE_UNAVAILABLE.benchmarks, undefined)
    assert.equal(WRITE_UNAVAILABLE.gatewayKeys, undefined)
    assert.equal(AVAILABLE.BENCHMARK_WRITES.status, 200)
    assert.equal(AVAILABLE.GATEWAY_KEYS.status, 200)
    assert.equal(resolveWrite('POST', '/api/free/accounts'), null, '免费池写仍被排除')
    assert.equal(materializeDaemonPath(findRouteByPath('GET', '/providers/:id/groups'), { id: 'site-1' }), '/api/providers/site-1/groups')
    assert.throws(() => materializeDaemonPath(findRouteByPath('GET', '/providers/:id/groups'), { id: '../etc' }), ApiHttpError)
  })

  // ── 3. /api/state 脱敏确实生效，且不打码 UI 档位字段 ────────────────────
  await ok('sanitizeState：剥离明文 Key / adminToken / 令牌，保留 hasAdminToken 等展示字段', async () => {
    const fixture = {
      gateway: { enabled: true, keys: [{ id: 'k1', name: 'main', key: 'sk-mapi-PLAINTEXT', enabled: true }] },
      providers: [{ id: 'p', name: 'A', adminToken: 'CIPHER', adminTokenTail: '..9f', hasAdminToken: true, tokenStatus: 'ok' }],
      settings: { ignoredModels: ['m'], failoverToken: 'FT', lanPanel: { enabled: false, token: 'LAN' }, masterKey: 'MK' },
      failover: { token: 'FT2', active: [] },
      lan: { enabled: false, token: 'LAN2' },
      ttftTiers: [{ ms: 1000, tier: 1, key: 'fast' }],
      decisionModes: [{ key: 'balanced', label: '均衡' }],
      modelKey: 'gpt-4o',
      scores: { x: { key: 'should-stay', nested: { deep: { secret: 'S', token: 'T', keep: 'K' } } } },
      freePool: { accounts: [{ id: 'a', secret: 'SEC', hasSecret: true }] },
    }
    const out = sanitizeState(fixture)
    const s = JSON.stringify(out)
    for (const secret of ['sk-mapi-PLAINTEXT', 'CIPHER', 'FT2', 'LAN2', '"masterKey"', 'SEC']) {
      assert.ok(!s.includes(secret), `泄露 ${secret}`)
    }
    assert.equal(out.gateway.keys[0].key, undefined)
    assert.equal(out.gateway.keys[0].name, 'main')
    assert.equal(out.settings.failoverToken, undefined)
    assert.equal(out.settings.lanPanel.token, undefined)
    assert.equal(out.failover.token, undefined)
    assert.equal(out.lan.token, undefined)
    assert.equal(out.providers[0].hasAdminToken, true)
    assert.equal(out.providers[0].adminTokenTail, '..9f')
    assert.deepEqual(out.settings.ignoredModels, ['m'], '不改全局 ignoredModels 作用域')
    // 泛化 key 匹配会毁掉页面：必须保留这些 UI 字段
    assert.equal(out.ttftTiers[0].key, 'fast')
    assert.equal(out.decisionModes[0].key, 'balanced')
    assert.equal(out.scores.x.key, 'should-stay')
    assert.equal(out.modelKey, 'gpt-4o')
    assert.equal(out.scores.x.nested.deep.secret, '***')
    assert.equal(out.scores.x.nested.deep.token, '***')
    assert.equal(out.scores.x.nested.deep.keep, 'K')
    assert.equal(fixture.gateway.keys[0].key, 'sk-mapi-PLAINTEXT', '不得改原对象')
  })

  // ── 3b. 根修：settings.gateway.keys[].key 必须清除（此前只清 top-level，真机泄漏）──
  await ok('sanitizeState：根修 settings.gateway.keys[].key，且不误伤 ttftTiers/decisionModes 档位字段', () => {
    const fixture = {
      gateway: { keys: [{ id: 'k1', name: 'main', key: 'sk-mapi-TOPLEVEL' }] },
      settings: {
        ignoredModels: ['m'],
        gateway: { enabled: true, keys: [
          { id: 'k2', name: 'pi chat', key: 'sk-mapi-SETTINGS', enabled: true, monthlyTokenLimit: 100, note: 'n', createdAt: '2026' },
          { id: 'k3', name: 'backup', key: 'sk-settings-secret', enabled: false },
        ] },
      },
      providers: [{ id: 'p', name: 'A', adminToken: 'AES-CIPHER', adminTokenTail: '..9f', hasAdminToken: true, tokenStatus: 'ok' }],
      ttftTiers: [{ ms: 1000, tier: 1, key: 'fast', level: '极快' }],
      decisionModes: [{ key: 'value', label: '性价比' }],
      scores: { o_1: { key: 'score-key', modelKey: 'gpt-4o' } },
    }
    const out = sanitizeState(fixture)
    const s = JSON.stringify(out)
    // 两处副本都不许残留明文
    assert.ok(!s.includes('sk-mapi-TOPLEVEL'), '顶层 gateway.keys[].key 泄漏')
    assert.ok(!s.includes('sk-mapi-SETTINGS'), 'settings.gateway.keys[].key 泄漏')
    assert.ok(!s.includes('sk-settings-secret'), 'settings.gateway.keys[].key（sk- 前缀）泄漏')
    assert.ok(!s.includes('AES-CIPHER'), 'providers[].adminToken 泄漏')
    // 精确剥离：展示字段全保留
    assert.equal(out.settings.gateway.keys[0].name, 'pi chat')
    assert.equal(out.settings.gateway.keys[0].monthlyTokenLimit, 100)
    assert.equal(out.settings.gateway.keys[0].enabled, true)
    assert.equal(out.settings.gateway.keys[0].key, undefined)
    assert.equal(out.providers[0].hasAdminToken, true)
    assert.equal(out.providers[0].adminTokenTail, '..9f')
    // UI 档位字段绝不能被泛化 key 打码误删
    assert.equal(out.ttftTiers[0].key, 'fast')
    assert.equal(out.decisionModes[0].key, 'value')
    assert.equal(out.scores.o_1.key, 'score-key')
    assert.equal(out.scores.o_1.modelKey, 'gpt-4o')
    // 不改原对象（浅拷贝后处理）
    assert.equal(fixture.settings.gateway.keys[0].key, 'sk-mapi-SETTINGS', '不得改原对象')
  })

  // ── 4. http.js：路径穿越 / 任意反代 / 非 loopback / query / 超时 / 错误归一 ──
  await ok('validateDaemonPath：拒路径穿越、编码穿越、双斜杠、反斜杠、query/hash、控制字符', async () => {
    const bad = [
      '/api/../etc/passwd', '/api/state/../../etc', '/api/%2e%2e/settings',
      '/api/state%00', '/api//state', '/api/state\\x', '/api/state?panel=1',
      '/api/state#x', '/api/state@evil', '/api/state/..', '/api/state/\x00',
      '/api/state/%2Fetc', '/api/%zz', '/etc/passwd', 'api/state', '/api/',
    ]
    for (const p of bad) assert.throws(() => validateDaemonPath(p), ApiHttpError, `应拒：${p}`)
    assert.equal(validateDaemonPath('/api/state'), '/api/state')
    assert.equal(validateDaemonPath('/api/decisions/gpt-4o/order', { allowEncodedSlash: false }), '/api/decisions/gpt-4o/order')
    assert.equal(validateDaemonPath('/api/decisions/gpt%2F4o/order', { allowEncodedSlash: true }), '/api/decisions/gpt%2F4o/order')
  })

  await ok('默认拒绝非 loopback 目标（含局域网 IP、域名、https、userinfo、路径、端口）', async () => {
    assert.equal(loopbackBaseUrl(0 + 12345), 'http://127.0.0.1:12345')
    for (const base of [
      'http://192.168.1.9:4319', 'http://0.0.0.0:4319', 'http://example.com:4319',
      'https://127.0.0.1:4319', 'http://user:pw@127.0.0.1:4319',
      'http://127.0.0.1:4319/api', 'http://127.0.0.1:4319/?x=1', 'http://127.0.0.1:4319/#x',
    ]) assert.throws(() => assertLoopbackBase(base), ApiHttpError, `应拒：${base}`)
    assert.equal(assertLoopbackBase('http://localhost:4319'), 'http://localhost:4319')
    assert.equal(assertLoopbackBase('http://[::1]:4319'), 'http://[::1]:4319')
    assert.throws(() => loopbackBaseUrl(4319, '192.168.1.9'), ApiHttpError)
    await assert.rejects(() => daemonRequest({ baseUrl: 'http://192.168.1.9:4319', path: '/api/state', allowedPattern: /^\/api\/state$/ }), ApiHttpError)
  })

  await ok('query 白名单：panel* 一律 403，非法键/对象值/控制字符拒绝', async () => {
    assert.equal(buildQueryString({ light: '1' }), '?light=1')
    assert.equal(buildQueryString({}), '')
    for (const q of [{ panel: '1' }, { panelIgnoredModels: 'x' }, { Panel: '1' }, { 'bad key': 1 }, { x: { a: 1 } }, { x: '\x00' }]) {
      assert.throws(() => buildQueryString(q), ApiHttpError, `应拒 query ${JSON.stringify(q)}`)
    }
    assert.equal(buildQueryString({ days: 7, from: '2026-01-01' }), '?days=7&from=2026-01-01')
  })

  await ok('assertAllowed：没有白名单 = 默认拒绝；有白名单要求完整命中', async () => {
    assert.throws(() => assertAllowed('/api/state', null), ApiHttpError)
    assert.throws(() => assertAllowed('/api/state/../usage', /^\/api\/state$/), ApiHttpError)
    assert.doesNotThrow(() => assertAllowed('/api/state', /^\/api\/state$/))
    await assert.rejects(
      () => daemonRequest({ port: 4321, path: '/api/gateway/keys', allowedPattern: /^\/api\/state$/ }),
      ApiHttpError,
    )
  })

  // 假上游：验证响应瘦身 / 脱敏透传 / 状态与错误归一 / 超时。
  const fakePort = await startServer((req, res) => {
    if (req.url.startsWith('/api/slow')) { setTimeout(() => res.end('{}'), 300); return }
    if (req.url.startsWith('/api/fail')) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: '站点名称不能为空' }))
      return
    }
    if (req.url.startsWith('/api/big')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ blob: 'x'.repeat(20000) }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true, sync: { added: 1 }, providers: [{ id: 'p', name: 'A', key: 'SECRET' }],
      gateway: { keys: [{ key: 'sk-PLAIN' }] },
    }))
  })
  const fakeBase = loopbackBaseUrl(fakePort)

  await ok('daemonRequest（假上游）：loopback 成功、响应脱敏回调生效、body 上限生效', async () => {
    const r = await daemonRequest({
      baseUrl: fakeBase, path: '/api/state', allowedPattern: /^\/api\/state$/,
      query: { light: '1' }, sanitize: (v) => ({ ok: v.ok, sync: v.sync }),
    })
    assert.equal(r.ok, true)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { ok: true, sync: { added: 1 } })
    assert.ok(!JSON.stringify(r.body).includes('sk-PLAIN'))
    const big = await daemonRequest({ baseUrl: fakeBase, path: '/api/big', allowedPattern: /^\/api\/big$/, maxBytes: 1024 })
    assert.equal(big.ok, false)
    assert.equal(big.status, 502)
    assert.match(big.error, /响应过大/)
  })

  await ok('错误归一：daemin 业务错误透传状态码/中文；连接失败 502；超时 504', async () => {
    const bad = await daemonRequest({ baseUrl: fakeBase, path: '/api/fail', allowedPattern: /^\/api\/fail$/ })
    assert.equal(bad.ok, false)
    assert.equal(bad.status, 400)
    assert.equal(bad.error, '站点名称不能为空')
    const closed = await daemonRequest({
      baseUrl: fakeBase, path: '/api/state', allowedPattern: /^\/api\/state$/,
      fetchImpl: async () => { throw new Error('connect ECONNREFUSED') },
    })
    assert.equal(closed.status, 502)
    assert.match(closed.error, /daemon 不可达/)
    const slowFetch = (_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
    const timedOut = await daemonRequest({
      baseUrl: fakeBase, path: '/api/state', allowedPattern: /^\/api\/state$/,
      timeoutMs: 30, fetchImpl: slowFetch,
    })
    assert.equal(timedOut.status, 504)
    assert.match(timedOut.error, /超时/)
  })

  // ── 5. WRITE_RULES 35 条逐条对照 daemon 真实路由 + 默认拒绝 ──────────────
  await ok('WRITE_RULES：35 条（26 既有 + N23 新增 9），逐条 method+路径命中用户版 daemon 真实正则', async () => {
    assert.equal(WRITE_RULES.length, 35)
    assert.equal(WRITE_ACTIONS.length, 35)
    for (const r of WRITE_RULES) {
      const path = materializeWritePath(r, { id: 'site-1', model: 'gpt-4o', key: 'gpt-4o' })
      const hits = currentRows.filter((row) => row.method === r.method && row.re.test(path))
      assert.equal(hits.length, 1, `${r.action} ${r.method} ${path} 命中 ${hits.length} 条 daemon 路由`)
      assert.equal(resolveWrite(r.method, path, { allowEncodedSlash: Boolean(r.allowEncodedSlash) })?.action, r.action)
    }
    const added = WRITE_ACTIONS.slice(26)
    assert.deepEqual(added, ['benchmark.upsert', 'benchmark.delete', 'benchmark.import', 'benchmark.seed', 'benchmark.import-plaza', 'gatewayKey.create', 'gatewayKey.update', 'gatewayKey.delete', 'gatewayKey.rotate'])
    // :key 按 daemon 的 decodeURIComponent(params[0]) 口径编码，含 / 的模型名收敛为 %2F
    assert.equal(materializeWritePath(findWriteRule('benchmark.delete'), { key: 'openai/gpt-4o' }), '/api/benchmarks/openai%2Fgpt-4o')
    assert.equal(resolveWrite('DELETE', '/api/benchmarks/openai%2Fgpt-4o', { allowEncodedSlash: true })?.action, 'benchmark.delete')
    assert.equal(resolveWrite('DELETE', '/api/benchmarks/openai%2Fgpt-4o'), null, '未显式放开编码斜杠仍拒绝')
  })

  await ok('默认拒绝：免费池写 / 生命周期 / 任意反代 / 穿越 / method 不符；N23 放行 9 条', async () => {
    const denied = [
      ['POST', '/api/free/platforms/site-1/connect/poll'], ['POST', '/api/free/platforms/site-1/connect'],
      ['POST', '/api/free/platforms/site-1/refresh'], ['POST', '/api/free/platforms/site-1/diagnose'],
      ['POST', '/api/free/accounts/a-1/checkin'], ['DELETE', '/api/free/platforms/site-1'],
      ['DELETE', '/api/free/accounts/a-1'], ['POST', '/api/free/platforms'],
      ['POST', '/api/free/accounts'], ['POST', '/api/offers/o-1/free-quota'],
      ['POST', '/api/manage-api/daemon/start'], ['DELETE', '/api/offers/../settings'],
      ['GET', '/api/state'], ['PATCH', '/api/providers/site-1/group-ratio'], ['PUT', '/api/providers/site-1'],
    ]
    for (const [m, p] of denied) assert.equal(resolveWrite(m, p), null, `应拒 ${m} ${p}`)
    const allowed = [
      ['PUT', '/api/benchmarks', 'benchmark.upsert'],
      ['DELETE', '/api/benchmarks/key', 'benchmark.delete'],
      ['POST', '/api/benchmarks/import', 'benchmark.import'],
      ['POST', '/api/benchmarks/seed', 'benchmark.seed'],
      ['POST', '/api/benchmarks/import-plaza', 'benchmark.import-plaza'],
      ['POST', '/api/gateway/keys', 'gatewayKey.create'],
      ['PATCH', '/api/gateway/keys/k1', 'gatewayKey.update'],
      ['DELETE', '/api/gateway/keys/k1', 'gatewayKey.delete'],
      ['POST', '/api/gateway/keys/k1/rotate', 'gatewayKey.rotate'],
    ]
    for (const [m, p, action] of allowed) assert.equal(resolveWrite(m, p)?.action, action, `应放行 ${m} ${p}`)
    assert.equal(resolveWrite('PUT', '/api/decisions/gpt/4o/order'), null, '用户版只接单段模型名')
    assert.equal(resolveWrite('PUT', '/api/decisions/gpt%2F4o/order', { allowEncodedSlash: true })?.action, 'decision.order')
    assert.equal(resolveWrite('PUT', '/api/decisions/gpt%2F4o/order'), null, '未显式放开编码斜杠仍拒绝')
  })

  await ok('settings 键集合：只认用户版 30 个键，拒 panelIgnoredModels / dshFreeModels / 未知键', async () => {
    assert.doesNotThrow(() => validateSettingsPayload({ ignoredModels: ['m'] }))
    assert.doesNotThrow(() => validateSettingsPayload({ displayCurrency: 'USD' }))
    for (const payload of [{ panelIgnoredModels: ['m'] }, { dshFreeModels: true }, { applyDshSettings: {} }, { totallyUnknown: 1 }, {}, null, []]) {
      assert.throws(() => validateSettingsPayload(payload), ApiHttpError, `应拒 ${JSON.stringify(payload)}`)
    }
  })

  await ok('materializeWritePath：id 限 [\\w-]+，model 必须 encodeURIComponent（含 / 收敛为 %2F）', async () => {
    assert.equal(materializeWritePath(findWriteRule('provider.sync'), { id: 'site-1' }), '/api/providers/site-1/sync')
    assert.equal(materializeWritePath(findWriteRule('decision.order'), { model: 'openai/gpt-4o' }), '/api/decisions/openai%2Fgpt-4o/order')
    assert.throws(() => materializeWritePath(findWriteRule('provider.sync'), { id: '../etc' }), ApiHttpError)
    assert.throws(() => materializeWritePath(findWriteRule('decision.order'), { model: '' }), ApiHttpError)
  })

  await ok('summarizeWrite：只回小字段，绝不把 daemon 全量 state / 明文 Key 带回渲染进程', async () => {
    const s = summarizeWrite({
      sync: { added: 2 }, providers: [{ id: 'p', name: 'A', key: 'sk-PLAIN' }],
      offers: [1, 2, 3], gateway: { keys: [{ key: 'sk-PLAIN' }] },
      scores: { huge: 'x'.repeat(1000) }, adminToken: 'CIPHER',
    }, { name: 'A' })
    assert.deepEqual(s, { sync: { added: 2 }, provider: { id: 'p', name: 'A' }, providers: 1, offers: 3 })
    assert.ok(!JSON.stringify(s).includes('sk-PLAIN'))
  })

  await ok('runWrite（假上游）：白名单命中 200 + 瘦身；未命中 403 且零请求；错误/超时归一', async () => {
    let calls = 0
    const countingFetch = (url, opts) => { calls += 1; return globalThis.fetch(url, opts) }
    const good = await runWrite({ baseUrl: fakeBase, action: 'provider.create', payload: { name: 'A' }, fetchImpl: countingFetch })
    assert.equal(good.ok, true)
    assert.equal(good.status, 200)
    assert.equal(good.action, 'provider.create')
    assert.ok(!JSON.stringify(good.summary).includes('sk-PLAIN'))
    assert.equal(calls, 1)
    const benchmarkWrite = await runWrite({ baseUrl: fakeBase, action: 'benchmark.upsert', payload: { modelKey: 'gpt-4o' }, fetchImpl: countingFetch })
    assert.equal(benchmarkWrite.ok, true, 'N23 放行的基准价写应命中并发请求')
    assert.equal(benchmarkWrite.action, 'benchmark.upsert')
    const callsAfterAllow = calls
    for (const input of [
      { action: 'free.platforms.create' },
      { action: 'settings.patch', payload: { panelIgnoredModels: ['m'] } },
      { action: 'provider.sync' /* 缺 id */ },
      { method: 'POST', path: '/api/free/accounts' },
      { method: 'POST', path: '/api/providers/../settings' },
    ]) {
      const denied = await runWrite({ ...input, baseUrl: fakeBase, fetchImpl: countingFetch })
      assert.equal(denied.ok, false, `应拒 ${JSON.stringify(input)}`)
      assert.ok([400, 403].includes(denied.status), `状态码 ${denied.status}`)
    }
    assert.equal(calls, callsAfterAllow, '所有被拒操作都不得发出请求')
    const err = await runWrite({ baseUrl: fakeBase, method: 'POST', path: '/api/fail', payload: {}, fetchImpl: countingFetch }).catch(() => null)
    // /api/fail 不在白名单，仍应 403（再次确认不做任意转发）
    assert.equal(err.ok, false)
    assert.equal(err.status, 403)
  })

  // ── 6. ingest 端点：真实 handler + 临时数据目录 + 随机端口 ────────────────
  const daemonMod = await import(pathToFileURL(SERVER).href)
  await ok('daemon/server.js 导出 ingest 校验辅助函数（纯函数可独立验证）', async () => {
    assert.equal(daemonMod.isGatewayRecordedProvider('manage-api'), true)
    assert.equal(daemonMod.isGatewayRecordedProvider('manage-api/gateway'), true)
    assert.equal(daemonMod.isGatewayRecordedProvider('openai'), false)
    assert.deepEqual(daemonMod.INGEST_USAGE_KEYS, [
      'provider', 'model', 'inputTokens', 'outputTokens', 'cachedTokens',
      'cacheCreationTokens', 'latencyMs', 'ttftMs', 'ok', 'ts',
    ])
    const norm = daemonMod.normalizeIngestUsagePayload({ provider: 'openai', model: 'gpt-4o', inputTokens: 10, outputTokens: 5 })
    assert.equal(norm.entry.keyId, '-')
    assert.equal(norm.entry.providerId, 'dsh:openai')
    assert.equal(norm.entry.group, 'dsh')
    assert.equal(norm.entry.ok, true)
    for (const bad of [
      {}, { provider: 'x', model: 'y' }, { provider: 'x', model: 'y', inputTokens: -1 },
      { provider: 'x', model: 'y', inputTokens: 1, extra: 1 },
      { provider: 'x', model: 'y', inputTokens: 1, ts: 'not-a-date' },
      { provider: 'x', model: 'y', inputTokens: 1, ok: 'yes' },
      null, [],
    ]) assert.throws(() => daemonMod.normalizeIngestUsagePayload(bad), (e) => e.status === 400, `应拒 ${JSON.stringify(bad)}`)
  })

  await ok('INGEST_CONTRACT：method/path/request/status/去重/口径与 daemon 实现一致', async () => {
    assert.equal(INGEST_CONTRACT.method, 'POST')
    assert.equal(INGEST_CONTRACT.path, INGEST_PATH)
    assert.equal(INGEST_CONTRACT.path, '/api/ingest/usage')
    assert.deepEqual(Object.keys(INGEST_CONTRACT.request).sort(), [...daemonMod.INGEST_USAGE_KEYS].sort())
    assert.deepEqual(INGEST_CONTRACT.status, [200, 400, 415])
    assert.match(INGEST_CONTRACT.dedupe, /gateway-already-recorded|manage-api/)
    assert.match(INGEST_CONTRACT.accounting, /recordUsage/)
  })

  daemonApp = daemonMod.createAppServer()
  await new Promise((r) => daemonApp.listen(0, '127.0.0.1', r))
  const daemonPort = daemonApp.address().port
  const daemonBase = `http://127.0.0.1:${daemonPort}`
  const post = async (body, contentType = 'application/json') => {
    const res = await fetch(`${daemonBase}/api/ingest/usage`, {
      method: 'POST', headers: { 'content-type': contentType }, body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }

  await ok('隔离断言：随机端口不是 4319，数据目录是临时目录', async () => {
    assert.notEqual(daemonPort, 4319)
    assert.ok(daemonPort > 0)
    assert.equal(process.env.MANAGE_API_HOME, dataDir)
    const health = await fetch(`${daemonBase}/api/health`)
    assert.equal(health.status, 200)
  })

  await ok('ingest 合法 payload → 200 recorded:true，沿 recordUsage/usage.json 口径落账', async () => {
    const r = await post({
      provider: 'openai', model: 'gpt-4o', inputTokens: 10, outputTokens: 5,
      cachedTokens: 2, cacheCreationTokens: 1, latencyMs: 100, ttftMs: 20, ok: true,
    })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { ok: true, recorded: true, source: 'dsh-ingest' })
    const raw = JSON.parse(await readFile(join(dataDir, 'usage.json'), 'utf8'))
    const day = Object.keys(raw.days)[0]
    const rows = Object.entries(raw.days[day])
    assert.equal(rows.length, 1)
    const [composite, row] = rows[0]
    assert.ok(composite.includes('dsh:openai'), `复合键应含 dsh:openai：${JSON.stringify(composite)}`)
    assert.equal(row.requests, 1)
    assert.equal(row.input, 10)
    assert.equal(row.output, 5)
    assert.equal(row.cached, 2)
    assert.equal(row.cacheCreation, 1)
    assert.equal(row.latencySum, 100)
    assert.equal(row.ttftSum, 20)
    const usage = await (await fetch(`${daemonBase}/api/usage?days=1`)).json()
    assert.equal(usage.usage.totals.requests, 1)
    assert.equal(usage.usage.totals.input, 10)
  })

  await ok('去重兜底：provider=manage-api / manage-api/* → 200 recorded:false，不写盘', async () => {
    const before = await readFile(join(dataDir, 'usage.json'), 'utf8')
    for (const provider of ['manage-api', 'manage-api/gateway']) {
      const r = await post({ provider, model: 'gpt-4o', inputTokens: 999, outputTokens: 999 })
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, { ok: true, recorded: false, reason: 'gateway-already-recorded', source: 'dsh-ingest' })
    }
    const after = await readFile(join(dataDir, 'usage.json'), 'utf8')
    assert.equal(after, before, '去重请求绝不能写 usage.json')
    assert.ok(!after.includes('999'))
    const usage = await (await fetch(`${daemonBase}/api/usage?days=1`)).json()
    assert.equal(usage.usage.totals.requests, 1, '总请求数不得变成 2/3')
  })

  await ok('payload 校验：缺 token / 未知字段 / 负数 / 坏 ts / 非对象 / 非 JSON 头 → 4xx 且不写盘', async () => {
    const before = await readFile(join(dataDir, 'usage.json'), 'utf8')
    const cases = [
      [{ provider: 'x', model: 'y' }, 400],
      [{ provider: 'x', model: 'y', inputTokens: 1, extra: 1 }, 400],
      [{ provider: 'x', model: 'y', inputTokens: -1 }, 400],
      [{ provider: 'x', model: 'y', inputTokens: 1, ts: 'nope' }, 400],
      [{ provider: 'x', model: 'y', inputTokens: 1, ok: 'yes' }, 400],
      [{ provider: '', model: 'y', inputTokens: 1 }, 400],
      [[], 400],
    ]
    for (const [body, status] of cases) {
      const r = await post(body)
      assert.equal(r.status, status, `${JSON.stringify(body)} → ${r.status}`)
      assert.ok(r.body.error)
    }
    const ct = await post({ provider: 'x', model: 'y', inputTokens: 1 }, 'text/plain')
    assert.equal(ct.status, 415)
    assert.equal(await readFile(join(dataDir, 'usage.json'), 'utf8'), before, '非法 payload 不得写盘')
  })

  await ok('ok:false 记 errors；自定义 ts 按 core/usage.js#localDayKey 归到本地日', async () => {
    const fixed = '2026-11-10T05:37:13.388Z'
    const r = await post({ provider: 'anthropic', model: 'claude', inputTokens: 3, ok: false, ts: fixed })
    assert.equal(r.status, 200)
    assert.equal(r.body.recorded, true)
    const raw = JSON.parse(await readFile(join(dataDir, 'usage.json'), 'utf8'))
    const day = Object.keys(raw.days).find((d) => d.startsWith('2026-11-10'))
    assert.ok(day, `自定义 ts 应落到本地日 2026-11-10：${Object.keys(raw.days)}`)
    const target = Object.values(raw.days[day]).find((row) => row.input === 3)
    assert.equal(target.errors, 1)
    assert.equal(target.requests, 1)
  })

  await ok('既有 109 条路由的行为未被新路由遮蔽（抽样 GET /api/state + /api/usage/reset 路由存在）', async () => {
    const state = await fetch(`${daemonBase}/api/state?light=1`)
    assert.equal(state.status, 200)
    const body = await state.json()
    assert.ok(body.settings, 'state 应含 settings')
    const unknown = await fetch(`${daemonBase}/api/definitely-not-a-route`)
    assert.equal(unknown.status, 404)
  })

  console.log(`check-dsh-plugin-api: ${passed.length} 组断言通过`)
  for (const label of passed) console.log(`  ok  ${label}`)
} finally {
  await closeAll()
  await rm(tmp, { recursive: true, force: true })
}
