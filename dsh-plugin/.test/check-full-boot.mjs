#!/usr/bin/env node
/**
 * N18 · 全链路启动验收（把手工多轮验证固化成正式测试）。
 *
 * 目的：专治「代码写了但没接上」这类静态测试永远发现不了的 bug ——
 *   历史两次事故：daemon.attach() 没调用、webServer.register() 没调用。
 * 本脚本真执行 apply() 与 client factory()，不是静态字符检查。
 *
 * 三组：
 *   A. Host 侧（Node 环境，真 import ../index.js）
 *      构造逼近真实 DSH 的 ctx（effect/get/logger/webServer/slots），
 *      调 apply(ctx, config) → 断言注册 6 exact + 1 prefix；
 *      真起 node:http 服务器按 DSH 语义分发，真打 daemon 4319（只读，绝不 spawn/监听 4319）；
 *      验证热重载（dispose 清表后重注册不抛 duplicate）；
 *      验证 attach 生命周期 down→attached→down 且不停外部 daemon。
 *   B. Client 侧（node:vm + 带 window 的 sandbox 跑 client.js）
 *      捕获 window.__ModuleLoader__.load(def)，断言 id 与包名一致；
 *      用正确 ctx 形状（ctx.get('slots', false)）调 apply，断言 3 槽注册与官方形状；
 *      断言 slots 缺失时软降级不抛、执行不依赖真实 DOM。
 *   C. 与本机真实契约对照（只读）：
 *      DSH webServer 源码确有 `route.kind === "exact"`；
 *      官方 schedule client 确有 `inject("sidebar.panellist"`。
 *
 * 失败直接抛（node 非零退出）。全程只读 4319，绝不 kill/重启 daemon。
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(here, '..')   // dsh-plugin/
const BASE = resolve(PLUGIN_ROOT, '..')   // worktree 根（runtimeDir）
const DAEMON_PORT = 4319                   // 已在运行的 daemon（PID 811），只读
const HOST_KEY = Symbol.for('local/dsh-manage-api/host')

// ── 断言分组统计 ─────────────────────────────────────────────────────────
const groups = []
function makeGroup(name) {
  const g = { name, total: 0, passed: 0 }
  groups.push(g)
  return {
    ok(label) { g.total++; g.passed++; console.log(`  ok  ${label}`) },
    info(label) { console.log(`  -   ${label}`) },
  }
}

// 短轮询（≤3 次、每次 ≤100ms；禁止 sleep/长等待）
async function waitUntil(pred, { tries = 3, delay = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return true
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delay))
  }
  return pred()
}

// 包 globalThis.fetch，统计真正打到 daemon 的请求（判定「有没有泄漏给 daemon」）
let daemonHits = 0
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input)
  if (url.includes(`127.0.0.1:${DAEMON_PORT}`)) daemonHits += 1
  return realFetch(input, init)
}

const config = {
  autoStart: false,
  attachExisting: true,
  port: DAEMON_PORT,
  runtimeDir: BASE,
  dataDir: '',
  waitMs: 10000,
}

// 逼近真实 DSH 的 ctx：effect 收集 disposer；get(name,false) 软取；真 register 语义的 webServer
function makeCtx() {
  const state = { effects: [], records: [], exact: new Map(), prefixes: new Map() }
  const webServer = {
    register(route) {
      const table = route.kind === 'exact' ? state.exact : state.prefixes
      if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      table.set(route.path, route)
      const rec = { kind: route.kind, path: route.path, disposed: false }
      state.records.push(rec)
      return () => { table.delete(route.path); rec.disposed = true }
    },
    // 复刻 DSH match：exact 全等 → prefix 最长前缀（pathname===prefix 或 startsWith(prefix+'/')）
    match(pathname) {
      const exactHit = state.exact.get(pathname)
      if (exactHit !== undefined) return exactHit
      let best
      for (const [prefix, route] of state.prefixes) {
        if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
        if (best === undefined || prefix.length > best.path.length) best = route
      }
      return best
    },
  }
  const slots = {
    register() { return () => {} },
    inject(_name, cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
  }
  const ctx = {
    effect(fn) { state.effects.push(fn()) },
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'slots') return slots
      return undefined
    },
    logger() { return { info() {}, warn() {}, error() {} } },
    // 服务已就绪场景：inject 立即用自身（具备 get/effect）触发回调
    inject(_names, cb) { const d = cb(ctx); return typeof d === 'function' ? d : () => {} },
    webServer,
    slots,
    _state: state,
  }
  return ctx
}

// ════════════════════════════════════════════════════════════════════════
// D. 真实 DSH 启动时序（N19 根因哨兵）
// ════════════════════════════════════════════════════════════════════════
// 前几轮所有模拟都是「webServer 已就绪」的理想态（makeCtx 的 get 直接返回），
// 因此路由注册看起来全绿；真实 DSH 是「插件先激活、webServer 后就绪」，
// 一次性 ctx.get('webServer', false) 会拿到 undefined 并永久跳过注册 —— 用户实测 401/404。
// 这里显式模拟该时序：初始 get 返回 undefined，inject 登记的回调稍后由宿主触发。
function makeDelayedCtx() {
  const state = { effects: [], exact: new Map(), prefixes: new Map(), injects: [] }
  const webServer = {
    register(route) {
      const table = route.kind === 'exact' ? state.exact : state.prefixes
      if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      table.set(route.path, route)
      return () => table.delete(route.path)
    },
  }
  const ctx = {
    effect(fn) { state.effects.push(fn()); return () => {} },
    get(name) { return name === 'webServer' ? undefined : undefined },  // 激活时服务未就绪
    logger() { return { info() {}, warn() {}, error() {} } },
    inject(names, cb) {
      state.injects.push({ names, cb })
      return () => {}   // 宿主暂不调用 cb，模拟「依赖还没就绪」
    },
    _state: state,
    _webServer: webServer,
  }
  return ctx
}

console.log('\n[D] 真实启动时序：插件先激活、webServer 后就绪')
const indexMod = await import(pathToFileURL(resolve(PLUGIN_ROOT, 'index.js')).href)
assert.equal(typeof indexMod.apply, 'function', 'index.js 应导出 apply 函数')

const DG = makeGroup('D 启动时序')
{
  const ctxD = makeDelayedCtx()
  // 激活：此时 get('webServer') 是 undefined，一次性探的实现会在这里永久跳过
  indexMod.apply(ctxD, config)
  DG.ok('激活不抛（webServer 初始未就绪）')
  // registerIntegration 也会为其它依赖调 ctx.inject，按依赖名筛出 webServer 那一条
  const wsInjects = ctxD._state.injects.filter((i) => i.names && i.names.includes('webServer'))
  assert.equal(wsInjects.length, 1, 'index.js 必须用 ctx.inject([\'webServer\'], ...) 等依赖就绪')
  DG.ok('使用了 ctx.inject(["webServer"], ...) 等待依赖（共 ' + ctxD._state.injects.length + ' 条注入）')
  assert.equal(ctxD._state.exact.size + ctxD._state.prefixes.size, 0, '依赖未就绪时不应提前注册路由')
  DG.ok('依赖未就绪期间路由表为空')

  // 宿主通知 webServer 就绪：用带真实服务的注入 ctx 触发回调
  const readyCtx = {
    get(name) { return name === 'webServer' ? ctxD._webServer : undefined },
    effect(fn) { const d = fn(); ctxD._state.effects.push(d); return () => { if (typeof d === 'function') d() } },
    logger() { return { info() {}, warn() {}, error() {} } },
  }
  const pending = wsInjects[0]
  assert.deepEqual(pending.names, ['webServer'], 'inject 的依赖名应为 webServer')
  const depDisposer = pending.cb(readyCtx)
  DG.ok('webServer 就绪后回调执行不抛')

  const total = ctxD._state.exact.size + ctxD._state.prefixes.size
  assert.equal(total, 7, `就绪后应注册 7 条路由（6 exact + 1 prefix），实际 ${total}`)
  DG.ok(`就绪后注册 7 条路由（exact=${ctxD._state.exact.size}, prefix=${ctxD._state.prefixes.size}）`)
  assert.ok(ctxD._state.exact.has('/api/manage-api/health'), 'health 路由必须存在')
  assert.ok(ctxD._state.prefixes.has('/api/manage-api/providers'), '参数路由 prefix 必须存在')
  DG.ok('health 与 providers prefix 均在就绪后注册')

  // disposer 成对：依赖 disposer + 各 effect disposer 都应能释放
  if (typeof depDisposer === 'function') depDisposer()
  for (const d of ctxD._state.effects.splice(0)) { if (typeof d === 'function') d() }
  DG.ok('disposer 释放不抛')
}

// ════════════════════════════════════════════════════════════════════════
// A. Host 侧
// ════════════════════════════════════════════════════════════════════════
console.log('\n[A] Host 侧：apply(ctx, config) 全链路')

const ctx = makeCtx()
const host = (() => {
  try {
    indexMod.apply(ctx, config)
    return true
  } catch (err) {
    console.error('apply 抛异常：', err)
    return false
  }
})()

const AG = makeGroup('A. Host')
AG.ok(`apply(ctx, config) 激活不抛：${host}`)
assert.equal(host, true, 'apply 激活不应抛异常')
assert.ok(ctx[HOST_KEY], 'apply 后 ctx[HOST_KEY] 应存在 HostLifecycle')
assert.equal(typeof ctx[HOST_KEY].daemon.snapshot, 'function', 'HostLifecycle.daemon.snapshot 应是函数')
const lifecycle = ctx[HOST_KEY]

// A.3 路由表：6 exact + 1 prefix，prefix 恰为 /api/manage-api/providers
{
  const records = ctx._state.records
  const exact = records.filter((r) => r.kind === 'exact').map((r) => r.path).sort()
  const prefixes = records.filter((r) => r.kind === 'prefix').map((r) => r.path)
  assert.equal(exact.length, 6, `应注册 6 条 exact，实际 ${exact.length}`)
  assert.equal(prefixes.length, 1, `应注册 1 条 prefix，实际 ${prefixes.length}`)
  assert.equal(prefixes[0], '/api/manage-api/providers', `prefix 路径应恰为 /api/manage-api/providers，实际 ${prefixes[0]}`)
  assert.deepEqual(exact, [
    '/api/manage-api/health', '/api/manage-api/monitor', '/api/manage-api/panel',
    '/api/manage-api/state', '/api/manage-api/usage', '/api/manage-api/usage/detail',
  ].sort(), '6 条 exact 路由集合不符')
  AG.ok('注册 6 exact + 1 prefix；prefix 恰为 /api/manage-api/providers')
}

// A.4 真起 node:http 服务器，按 DSH 语义分发，真打 daemon
const webServer = ctx.webServer
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
AG.ok(`SUT 监听 127.0.0.1:${sutPort}（≠4319）`)

function hit(pathAndQuery) {
  return new Promise((ok, bad) => {
    const req = http.get({ host: '127.0.0.1', port: sutPort, path: pathAndQuery }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        let body = null
        try { body = JSON.parse(raw) } catch { /* 非 JSON */ }
        ok({ status: res.statusCode, raw, body })
      })
    })
    req.on('error', bad)
  })
}

const statusTable = {}
let realProviderId = null
try {
  // health → 200 ok:true
  {
    const r = await hit('/api/manage-api/health')
    statusTable['/health'] = r.status
    assert.equal(r.status, 200, `health 应 200，实际 ${r.status}`)
    assert.equal(r.body && r.body.ok, true, 'health body.ok 应为 true')
    AG.ok('/health → 200 {ok:true}')
  }
  // state → 200 且无 sk-mapi- 明文；顺带取真实 provider id
  {
    const r = await hit('/api/manage-api/state')
    statusTable['/state'] = r.status
    assert.equal(r.status, 200, `state 应 200，实际 ${r.status}`)
    assert.equal(r.raw.includes('sk-mapi-'), false, 'state 响应不得含 sk-mapi- 明文')
    const providers = r.body && Array.isArray(r.body.providers) ? r.body.providers : []
    realProviderId = providers[0] && providers[0].id
    assert.ok(realProviderId, 'state 里应能取到真实 provider id')
    AG.ok(`/state → 200，无 sk-mapi- 明文，providerId=${realProviderId}`)
  }
  // usage → 200
  {
    const r = await hit('/api/manage-api/usage?days=7')
    statusTable['/usage?days=7'] = r.status
    assert.equal(r.status, 200, `usage 应 200，实际 ${r.status}`)
    AG.ok('/usage?days=7 → 200')
  }
  // providers/<真实id>/groups → 200（优先用题目给的 p_d204c0cf，不存在则用 state 里的真实 id）
  {
    let pid = 'p_d204c0cf'
    const probe = await hit(`/api/manage-api/providers/${pid}/groups`)
    if (probe.status !== 200) pid = realProviderId
    const r = pid === 'p_d204c0cf' ? probe : await hit(`/api/manage-api/providers/${pid}/groups`)
    statusTable['/providers/<id>/groups'] = r.status
    assert.equal(r.status, 200, `providers/<id>/groups 应 200，实际 ${r.status}（id=${pid}）`)
    AG.ok(`/providers/${pid}/groups → 200（prefix 收紧命中）`)
  }
  // providers/x/y/z → 404 且未透传 daemon
  {
    daemonHits = 0
    const r = await hit('/api/manage-api/providers/x/y/z')
    statusTable['/providers/x/y/z'] = r.status
    assert.equal(r.status, 404, `多余段应 404，实际 ${r.status}`)
    assert.equal(daemonHits, 0, '多余段绝不能透传给 daemon（daemonHits 应为 0）')
    AG.ok('/providers/x/y/z → 404，未透传 daemon (daemonHits=0)')
  }
  // panel?panel=1 → 403
  {
    daemonHits = 0
    const r = await hit('/api/manage-api/panel?panel=1')
    statusTable['/panel?panel=1'] = r.status
    assert.equal(r.status, 403, `panel=1 应 403，实际 ${r.status}`)
    assert.equal(daemonHits, 0, 'panel 拒绝不应请求 daemon')
    AG.ok('/panel?panel=1 → 403（未请求 daemon）')
  }
} finally {
  await new Promise((ok) => dispatcher.close(ok))
}

// A.6 attach 生命周期：down → attached → dispose 回 down，且不停外部 daemon
// 用全新 ctx 做一次干净 apply，可在「任何 await 之前」捕获同步初始态 down。
{
  const ctxL = makeCtx()
  indexMod.apply(ctxL, config)
  const life = ctxL[HOST_KEY]
  // apply 返回时 attach() 正卡在首个 await（probeImpl→fetch），此时 mode 必为 down
  const snap0 = life.daemon.snapshot()
  assert.equal(snap0.mode, 'down', `激活后同步初始 mode 应为 down，实际 ${snap0.mode}`)
  AG.ok(`attach 前（同步）snapshot.mode = ${snap0.mode}`)

  const attached = await waitUntil(() => life.daemon.snapshot().mode === 'attached', { tries: 3, delay: 100 })
  const snapA = life.daemon.snapshot()
  assert.equal(attached, true, `attach 后 mode 应变 attached，实际 ${snapA.mode}（lastError=${snapA.lastError}）`)
  assert.equal(snapA.ownership, 'attached', 'attached 后 ownership 应为 attached')
  assert.equal(snapA.pid, null, 'attached 不应持有 child.pid（证明未 spawn/未收养任何进程）')
  AG.ok(`attach 后 snapshot.mode = ${snapA.mode}，ownership=${snapA.ownership}，pid=${snapA.pid}（无 owned 子进程）`)

  // 真活 daemon 探活：dispose 前
  const before = await life.daemon.probe()
  assert.equal(before.ok, true, 'attach 阶段 daemon 应存活')

  await life.daemon.dispose()
  const snapD = life.daemon.snapshot()
  assert.equal(snapD.mode, 'down', `dispose 后 mode 应回 down，实际 ${snapD.mode}`)
  AG.ok(`dispose 后 snapshot.mode = ${snapD.mode}（attached 仅清本地标记）`)

  // dispose 后外部 daemon 仍存活（结构上无 child，故 dispose 根本无进程可 kill）
  const after = await life.daemon.probe()
  assert.equal(after.ok, true, 'dispose 后 4319 上原有 daemon 必须仍存活')
  AG.ok('dispose 后 4319 daemon 仍存活（attached 不 kill 外部进程）')

  // 清理这个 ctx 的 effect（路由 disposer），避免残留
  for (const d of ctxL._state.effects.splice(0)) { try { d() } catch { /* ignore */ } }
}

// A.5 热重载：cleanup 后 exact/prefix 表清空（disposer 全调用）；同 webServer 重注册不抛 duplicate
// 独立 fake webServer + 独立 ctx，表与 disposer 计数全部可直读，不依赖前文的闭包状态。
{
  const makeStandaloneWS = () => {
    const exact = new Map()
    const prefixes = new Map()
    const records = []
    return {
      exact, prefixes, records,
      register(route) {
        const table = route.kind === 'exact' ? exact : prefixes
        if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
        table.set(route.path, route)
        const rec = { kind: route.kind, path: route.path, disposed: false }
        records.push(rec)
        return () => { table.delete(route.path); rec.disposed = true }
      },
    }
  }
  const makeApplyCtx = (ws) => {
    const effects = []
    return {
      effects,
      effect(fn) { effects.push(fn()) },
      get(name) { return name === 'webServer' ? ws : undefined },
      logger() { return { info() {}, warn() {}, error() {} } },
    }
  }

  const ws = makeStandaloneWS()
  const ctx1 = makeApplyCtx(ws)
  indexMod.apply(ctx1, config)
  assert.equal(ws.exact.size, 6, `首次激活 exact 表应 6，实际 ${ws.exact.size}`)
  assert.equal(ws.prefixes.size, 1, `首次激活 prefix 表应 1，实际 ${ws.prefixes.size}`)
  assert.equal(ws.records.filter((r) => r.kind === 'exact').length, 6)
  assert.equal(ws.records.filter((r) => r.kind === 'prefix').length, 1)
  assert.equal(ws.records.find((r) => r.kind === 'prefix').path, '/api/manage-api/providers')

  // 清理（模拟热重载前的 dispose）
  for (const d of ctx1.effects.splice(0)) { try { d() } catch { /* ignore */ } }
  assert.equal(ws.exact.size, 0, `cleanup 后 exact 表应清空，实际剩 ${ws.exact.size}`)
  assert.equal(ws.prefixes.size, 0, `cleanup 后 prefix 表应清空，实际剩 ${ws.prefixes.size}`)
  assert.equal(ws.records.every((r) => r.disposed === true), true, 'cleanup 后所有注册项 disposer 都应被调用')
  AG.ok(`cleanup 后 exact/prefix 表清空，${ws.records.length}/${ws.records.length} disposer 全调用`)

  // 同一 webServer 上二次激活（真热重载场景）：不抛 duplicate
  const ctx2 = makeApplyCtx(ws)
  let reThrew = null
  try { indexMod.apply(ctx2, config) } catch (err) { reThrew = err }
  assert.equal(reThrew, null, `热重载二次激活不应抛 duplicate：${reThrew && reThrew.message}`)
  assert.equal(ws.exact.size, 6, `二次激活后 exact 表应 6，实际 ${ws.exact.size}`)
  assert.equal(ws.prefixes.size, 1, `二次激活后 prefix 表应 1，实际 ${ws.prefixes.size}`)
  const liveRecs = ws.records.filter((r) => r.disposed === false)
  assert.equal(liveRecs.length, 7, `二次激活后应有 7 条活动注册项，实际 ${liveRecs.length}`)
  AG.ok(`同 webServer 二次激活不抛 duplicate，重注册 6 exact + 1 prefix`)

  // 再次 cleanup → 表再次清空
  for (const d of ctx2.effects.splice(0)) { try { d() } catch { /* ignore */ } }
  assert.equal(ws.exact.size, 0, '二次 cleanup 后 exact 表应再次清空')
  assert.equal(ws.prefixes.size, 0, '二次 cleanup 后 prefix 表应再次清空')
  AG.ok('二次 cleanup 后 exact/prefix 表再次清空')
}

// ════════════════════════════════════════════════════════════════════════
// B. Client 侧（node:vm + 带 window 的 sandbox 跑 client.js）
// ════════════════════════════════════════════════════════════════════════
console.log('\n[B] Client 侧：factory() / apply() 真执行（node:vm sandbox）')
const BG = makeGroup('B. Client')

function makeFakeReact() {
  const el = (type, props, ...children) => ({ type, props: props || {}, children })
  return {
    createElement: el,
    createContext: (d) => ({ _ctx: d }),
    useContext: () => 'zh',
    useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
  }
}
function makeRequireStub() {
  return (name) => {
    if (name === 'react') return makeFakeReact()
    if (name === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}), Fragment: 'Fragment' }
    return {}
  }
}

// 最小 document stub：不依赖真实浏览器 DOM
function makeDocumentStub() {
  const appended = []
  const doc = {
    baseURI: 'http://127.0.0.1:55092/',
    documentElement: {
      getAttribute: () => '',
      appendChild: (el) => { appended.push(el) },
    },
    head: { appendChild: (el) => { appended.push(el) } },
    createElement: (tag) => ({ tagName: String(tag), id: '', _t: '', set textContent(v) { this._t = v }, get textContent() { return this._t }, remove() {} }),
    getElementById: () => null,
  }
  return { doc, appended }
}

const clientCode = readFileSync(resolve(PLUGIN_ROOT, 'client.js'), 'utf8')
let clientDef = null
{
  const { doc } = makeDocumentStub()
  const sandbox = {
    window: { __ModuleLoader__: { load: (d) => { clientDef = d } } },
    document: doc,
    navigator: { language: 'zh-CN' },
    URL,
    console,
  }
  vm.createContext(sandbox)
  new vm.Script(clientCode, { filename: 'client.js' }).runInContext(sandbox)
}

// B.1 load 捕获 + id 与包名一致
{
  assert.ok(clientDef, 'window.__ModuleLoader__.load 未被调用')
  const pkg = JSON.parse(readFileSync(resolve(PLUGIN_ROOT, 'package.json'), 'utf8'))
  assert.equal(clientDef.id, '@local/dsh-manage-api', `def.id 应为 @local/dsh-manage-api，实际 ${clientDef.id}`)
  assert.equal(clientDef.id, pkg.name, `def.id 应与 package.json name 一致（${pkg.name}）`)
  BG.ok(`load 捕获 def.id = ${clientDef.id}（== package.json name）`)
}

// B.2 factory(requireStub) 导出形状
const clientApp = clientDef.factory(makeRequireStub())
{
  assert.equal(typeof clientApp.apply, 'function', 'factory 导出应含 apply 函数')
  assert.ok(Array.isArray(clientApp.inject) && clientApp.inject.includes('slots'), "inject 数组应含 'slots'")
  assert.equal(typeof clientApp.name, 'string', 'factory 导出应含 name 字符串')
  BG.ok("factory(requireStub) 导出 apply(function) + inject 含 'slots' + name")
}

// B.3 用正确 ctx 形状（ctx.get('slots', false)）apply → 3 槽注册 + 官方形状
{
  const regs = []
  const slotsStub = {
    inject: (_name, cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
    register: (defn) => { regs.push(defn); return () => {} },
  }
  const ctxClient = {
    get: (n, _soft) => (n === 'slots' ? slotsStub : undefined),
    logger: () => ({ warn() {}, info() {} }),
  }
  const dispose = clientApp.apply(ctxClient)
  assert.equal(typeof dispose, 'function', 'apply 应返回 dispose 函数')
  assert.equal(regs.length, 3, `应注册 3 个槽，实际 ${regs.length}（形状错误会漏注册）`)

  const byName = Object.fromEntries(regs.map((r) => [r.name, r]))
  assert.deepEqual(Object.keys(byName).sort(), ['main', 'settings.section', 'sidebar.panellist'], '三槽名不符')

  const main = byName.main
  assert.equal(main.name, 'main', 'main 槽 name 不符')
  assert.equal(main.key, 'manage-api', `main 槽 key 应为 manage-api，实际 ${main.key}`)

  const side = byName['sidebar.panellist']
  assert.equal(side.name, 'sidebar.panellist', 'sidebar.panellist 槽 name 不符')
  assert.equal(side.id, 'manage-api', `sidebar.panellist 槽 id 应为 manage-api，实际 ${side.id}`)
  assert.equal(typeof side.order, 'number', 'sidebar.panellist 槽 order 应为数字')

  const settings = byName['settings.section']
  assert.equal(settings.name, 'settings.section', 'settings.section 槽 name 不符')
  assert.equal(settings.id, 'manage-api', `settings.section 槽 id 应为 manage-api，实际 ${settings.id}`)
  assert.equal(typeof settings.order, 'number', 'settings.section 槽 order 应为数字')

  BG.ok(`正确 ctx 形状注册 3 槽：main{key:manage-api} / sidebar.panellist{id,order} / settings.section{id,order}`)
  dispose()
}

// B.4 slots 缺失时软降级不抛且返回 dispose
{
  let threw = null
  let dispose
  try { dispose = clientApp.apply({ get: () => undefined }) } catch (err) { threw = err }
  assert.equal(threw, null, `slots 缺失时 apply 不应抛：${threw && threw.message}`)
  assert.equal(typeof dispose, 'function', 'slots 缺失时仍应返回 dispose 函数')
  BG.ok('slots 缺失 → 软降级不抛，返回 dispose 函数')
}

// B.5 factory 执行不依赖真实 DOM（上面的 load/apply 全程只用最小 document stub，无异常即证）
{
  assert.equal(typeof clientDef.factory, 'function', 'def.factory 应为函数')
  BG.ok('factory/apply 全程仅用最小 document stub，未依赖真实浏览器 DOM')
}

// ════════════════════════════════════════════════════════════════════════
// C. 与本机真实契约对照（只读哨兵，防 DSH 升级后契约漂移）
// ════════════════════════════════════════════════════════════════════════
console.log('\n[C] 与本机真实契约对照（只读）')
const CG = makeGroup('C. 契约哨兵')
const DSH_ROOT = '/Applications/Deep Pi.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai'
const WEBSERVER_LIB = `${DSH_ROOT}/dsh-host-webserver/lib/index.js`
const SCHEDULE_CLIENT = `${DSH_ROOT}/dsh-client-ui-schedule/lib/client.js`
{
  assert.ok(existsSync(WEBSERVER_LIB), `未找到 DSH webServer 源码（契约漂移或路径变更）：${WEBSERVER_LIB}`)
  const src = readFileSync(WEBSERVER_LIB, 'utf8')
  assert.ok(/route\.kind === "exact"/.test(src), `DSH webServer 源码不再含 route.kind === "exact"（我们用的 kind 字段可能已过时）：${WEBSERVER_LIB}`)
  CG.ok('DSH webServer 源码确有 route.kind === "exact"（kind 字段名未过时）')
}
{
  assert.ok(existsSync(SCHEDULE_CLIENT), `未找到官方 schedule client（契约漂移或路径变更）：${SCHEDULE_CLIENT}`)
  const src = readFileSync(SCHEDULE_CLIENT, 'utf8')
  assert.ok(src.includes('inject("sidebar.panellist"'), `官方 schedule client 不再含 inject("sidebar.panellist"（槽名可能已变更）：${SCHEDULE_CLIENT}`)
  CG.ok('官方 schedule client 确有 inject("sidebar.panellist"（槽名真实存在）')
}

// ════════════════════════════════════════════════════════════════════════
// 汇总
// ════════════════════════════════════════════════════════════════════════
globalThis.fetch = realFetch

console.log('\n[HTTP status code table]')
for (const [k, v] of Object.entries(statusTable)) console.log(`  ${String(v).padEnd(4)} ${k}`)

let total = 0
let passedCount = 0
console.log('\n[group summary]')
for (const g of groups) { total += g.total; passedCount += g.passed; console.log(`  ${g.name}: ${g.passed}/${g.total}`) }
console.log(`\ncheck-full-boot: ${passedCount}/${total} 项断言通过，${groups.length} 个断言分组`)
