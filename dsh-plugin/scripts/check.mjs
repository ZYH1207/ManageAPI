#!/usr/bin/env node
/**
 * dsh-plugin 本地自检（不装进 profile 也能跑）。
 *
 * 覆盖四件事：
 *   1. 所有 lib/*.js 语法可解析（node --check）
 *   2. host 半边能 import，并在假 ctx 上完整走通 apply / dispose
 *   3. client 半边能在假 window.__ModuleLoader__ 环境里加载，导出 apply/inject/name，
 *      且在假 slots 上完成 settings.section 注册
 *   4. package.json 的 dsh / exports / files 自洽（文件真实存在）
 *
 * 用法：node scripts/check.mjs
 */

import { execFileSync } from 'node:child_process'
import { readFile, readdir, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []
const checks = []

function ok(label, detail) {
  checks.push({ label, detail })
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
}

function fail(label, error) {
  failures.push(`${label}: ${error}`)
  console.log(`  ✗ ${label} — ${error}`)
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// ── 1) 语法检查 ─────────────────────────────────────────────────────
console.log('\n[1/4] 语法检查')
const libDir = join(root, 'lib')
const libFiles = (await readdir(libDir)).filter((f) => f.endsWith('.js'))
for (const file of libFiles) {
  try {
    execFileSync(process.execPath, ['--check', join(libDir, file)], { stdio: 'pipe' })
    ok(`node --check lib/${file}`)
  } catch (err) {
    fail(`node --check lib/${file}`, String(err.stderr || err.message).slice(0, 400))
  }
}

// ── 2) host 半边 ────────────────────────────────────────────────────
console.log('\n[2/4] host 半边加载')
try {
  const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  if (typeof mod.apply === 'function') ok('导出 apply(ctx, config)')
  else fail('导出 apply(ctx, config)', 'apply 不是函数')

  const registered = { effects: [], ons: [], services: new Map(), tools: [], guards: [], contexts: [], commands: [], routes: [], injects: [] }
  const fakeTools = {
    register(definition) {
      registered.tools.push(definition)
      return () => {}
    },
    guard(fn) {
      registered.guards.push(fn)
      return () => {}
    },
  }
  const fakeCommands = {
    register(definition) {
      registered.commands.push(definition)
      return () => {}
    },
  }
  const fakeSystemPrompt = {
    context(context) {
      registered.contexts.push(context)
      return () => {}
    },
  }
  const fakeWebServer = {
    register(route) {
      registered.routes.push(route)
      return () => {}
    },
  }
  const fakeCtx = {
    // 真 Cordis 的 ctx.inject(deps, cb) 在依赖就绪后执行 cb；
    // 这里同步执行，就能覆盖「webServer 就绪后才注册路由」的路径。
    inject(deps, cb) {
      registered.injects.push(deps.join(','))
      const d = cb(fakeCtx)
      if (typeof d === 'function') registered.effects.push({ label: 'inject:' + deps.join(','), dispose: d })
      return () => {}
    },
    effect(fn, label) {
      registered.effects.push({ label, dispose: fn() })
      return () => {}
    },
    on(event, handler) {
      registered.ons.push({ event, handler })
      return () => {}
    },
    get(name) {
      if (name === 'webServer') return fakeWebServer
      if (name === 'tools') return fakeTools
      if (name === 'systemPrompt') return fakeSystemPrompt
      if (name === 'commands') return fakeCommands
      return undefined
    },
    // 真 Cordis 里 set 只能写已 provide 的服务，直接 set 会抛
    // `cannot set property "x" without provide`；这里照实模拟，防止回归。
    set(name) {
      throw new Error(`cannot set property "${name}" without provide`)
    },
    provide(name, value) {
      if (registered.services.has(name)) throw new Error(`service "${name}" 重复 provide`)
      registered.services.set(name, value)
      return () => {}
    },
    logger() {
      return { info() {}, warn() {}, error() {} }
    },
  }
  const dispose = mod.apply(fakeCtx, { autoStart: false, proxyEnabled: false })
  ok('apply() 不抛异常', `${registered.effects.length} 个 effect，${registered.ons.length} 个事件监听`)
  if (registered.ons.some((o) => o.event === 'llm/stream')) ok('注册了 llm/stream tee')
  else fail('注册了 llm/stream tee', '没找到 llm/stream 监听')
  if (registered.services.has("manageApi")) ok("通过 ctx.provide 暴露 manageApi")
  else fail('暴露 ctx.set(manageApi)', '没有 set')

  const toolNames = registered.tools.map((t) => t.name)
  const expectedTools = ['manageapi_status', 'manageapi_models', 'manageapi_usage']
  if (expectedTools.every((n) => toolNames.includes(n))) ok('注册 3 个工具', toolNames.join(', '))
  else fail('注册 3 个工具', JSON.stringify(toolNames))
  if (registered.tools.every((t) => t.parameters && typeof t.parameters === 'object' && t.output && typeof t.output.render === 'function')) {
    ok('每个工具都有 parameters 与 output.render')
  } else fail('工具 schema 完整', '有工具缺 parameters/output.render')
  if (registered.guards.length === 1) ok('注册了预算 guard')
  else fail('注册了预算 guard', String(registered.guards.length))
  if (registered.commands.length === 1 && registered.commands[0].name === 'manage' && typeof registered.commands[0].handler === 'function') {
    ok('注册了 /manage 命令', registered.commands[0].description?.slice(0, 20) || '')
  } else fail('注册了 /manage 命令', JSON.stringify(registered.commands.map((c) => c.name)))
  if (registered.contexts.length === 1 && registered.contexts[0].name === 'manage-api') {
    ok('注册了 systemPrompt.context', `order=${registered.contexts[0].order}`)
  } else fail('注册了 systemPrompt.context', JSON.stringify(registered.contexts.map((c) => c.name)))

  for (const entry of registered.effects) {
    const fn = entry.dispose
    if (typeof fn === 'function') await fn()
    else if (fn && typeof fn.then === 'function') await fn
  }
  ok('所有 effect 的清理函数可调用')
  if (typeof dispose === 'function') {
    dispose()
    ok('apply 返回值可调用')
  }

  // ── [1b] 同源代理路由：proxyEnabled=true 时必须注册 /api/manage-api ──
  //
  // 回归防护：这里曾经是 ctx.get('webServer') 一次性探，服务未就绪就永久跳过注册，
  // 表现是「设置页面板一直报 401 / 非 JSON」。现在必须走 ctx.inject。
  {
    const routes = []
    const injects = []
    const fakeWebServer = {
      register(route) {
        routes.push(route)
        return () => {}
      },
    }
    const routeCtx = {
      inject(deps, cb) {
        injects.push(deps.join(','))
        const d = cb(routeCtx)
        if (typeof d === 'function') d()
        return () => {}
      },
      effect(fn) {
        const d = fn()
        if (typeof d === 'function') d()
        return () => {}
      },
      on() {
        return () => {}
      },
      get(n) {
        if (n === 'webServer') return fakeWebServer
        if (n === 'tools') return fakeTools
        if (n === 'systemPrompt') return fakeSystemPrompt
        if (n === 'commands') return fakeCommands
        return undefined
      },
      set(n) {
        throw new Error('cannot set property "' + n + '" without provide')
      },
      provide() {
        return () => {}
      },
      logger() {
        return { info() {}, warn() {}, error() {} }
      },
    }
    mod.apply(routeCtx, { autoStart: false, proxyEnabled: true, promptContext: false, ingestExternalUsage: false })
    if (injects.includes('webServer')) ok('通过 ctx.inject 等 webServer 就绪')
    else fail('通过 ctx.inject 等 webServer 就绪', JSON.stringify(injects))
    const route = routes.find((r) => r && r.path === '/api/manage-api')
    if (route && route.kind === 'prefix' && typeof route.handler === 'function') {
      ok('注册同源代理前缀 /api/manage-api')
    } else {
      fail('注册同源代理前缀 /api/manage-api', JSON.stringify(routes.map((r) => r && r.path)))
    }
  }
} catch (err) {
  fail('host 半边加载', String(err && err.stack ? err.stack : err).slice(0, 800))
}

// ── 2b) budget / ingest 纯逻辑 ──────────────────────────────────────
console.log('\n[2b] budget / ingest 纯逻辑')
try {
  const { createBudget } = await import(pathToFileURL(join(root, 'lib', 'budget.js')).href)
  const streamStats = new Map([['s1', { tokens: 400, calls: 2, lastAt: Date.now(), model: 'm' }]])
  const budget = createBudget({ config: { budget: { sessionTokens: 1000, dailyTokens: 5000 } }, streamStats, log: () => {} })
  if (budget.denyReason('s1') === undefined) ok('未超预算时不拒绝')
  else fail('未超预算时不拒绝', String(budget.denyReason('s1')))
  streamStats.set('s1', { tokens: 1200, calls: 3, lastAt: Date.now(), model: 'm' })
  if (typeof budget.denyReason('s1') === 'string') ok('会话超预算后拒绝', budget.denyReason('s1').slice(0, 24))
  else fail('会话超预算后拒绝', '仍是 undefined')
  const dailyBudget = createBudget({ config: { budget: { sessionTokens: 0, dailyTokens: 5000 } }, streamStats: new Map(), log: () => {} })
  dailyBudget.absorbUsage({ input: 4000, output: 2000 })
  if (typeof dailyBudget.denyReason() === 'string') ok('日预算超限后拒绝', dailyBudget.denyReason().slice(0, 24))
  else fail('日预算超限后拒绝', '仍是 undefined')
  const unlimited = createBudget({ config: { budget: { sessionTokens: 0, dailyTokens: 0 } }, streamStats, log: () => {} })
  if (unlimited.denyReason('s1') === undefined) ok('0 = 不设限')
  else fail('0 = 不设限', '仍拒绝')

  const { createIngest } = await import(pathToFileURL(join(root, 'lib', 'ingest.js')).href)
  const ingest = createIngest({ port: 1, enabled: true, getMode: () => 'down', log: () => {} })
  ingest.record({ provider: 'chatcode', model: 'm', usage: { inputTokens: 10, outputTokens: 5 } })
  ingest.record({ provider: 'manage-api', model: 'm', usage: { inputTokens: 10, outputTokens: 5 } })
  const snap = ingest.snapshot()
  if (snap && typeof snap === 'object') ok('ingest.snapshot() 可用', JSON.stringify(snap).slice(0, 120))
  else fail('ingest.snapshot() 可用', String(snap))
} catch (err) {
  fail('budget / ingest 纯逻辑', String(err && err.stack ? err.stack : err).slice(0, 800))
}

// ── 3) client 半边 ──────────────────────────────────────────────────
console.log('\n[3/4] client 半边加载（假 __ModuleLoader__ 环境）')
try {
  const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  let bundle = null
  const fakeWindow = {
    __ModuleLoader__: {
      load(entry) {
        bundle = entry
      },
    },
  }
  const fakeReact = {
    createElement: () => null,
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }),
    Fragment: 'Fragment',
  }
  const fakeRequire = (specifier) => {
    if (specifier === 'react') return fakeReact
    throw new Error(`client 只应 require('react')，实际要求：${specifier}`)
  }
  // 客户端是传统脚本（非 ESM）：用 Function 模拟宿主执行方式
  const run = new Function('window', 'document', 'fetch', 'console', source)
  run(fakeWindow, { baseURI: 'http://127.0.0.1:57096/' }, async () => ({ ok: true, json: async () => ({}) }), console)

  if (!bundle) fail('client bundle 调用 __ModuleLoader__.load', '没有调用')
  else {
    ok('client bundle 调用 __ModuleLoader__.load', `id=${bundle.id}`)
    if (bundle.id !== 'dsh-manage-api') fail('bundle id', `期望 dsh-manage-api，实际 ${bundle.id}`)
    const clientModule = bundle.factory(fakeRequire)
    if (typeof clientModule.apply === 'function') ok('导出 apply(ctx)')
    else fail('导出 apply(ctx)', 'apply 不是函数')
    if (Array.isArray(clientModule.inject) && clientModule.inject.includes('slots')) ok('inject 含 slots')
    else fail('inject 含 slots', JSON.stringify(clientModule.inject))

    const slotCalls = []
    const fakeSlots = {
      inject(ownerKey, cb) {
        slotCalls.push(ownerKey)
        cb()
      },
      register(definition, component) {
        slotCalls.push({ definition, component })
        return () => {}
      },
    }
    const fakeClientCtx = { get: (name) => (name === 'slots' ? fakeSlots : undefined) }
    const dispose = clientModule.apply(fakeClientCtx)
    const section = slotCalls.find((c) => c && c.definition && c.definition.name === 'settings.section')
    if (section) ok('注册 settings.section', `id=${section.definition.id}, order=${section.definition.order}`)
    else fail('注册 settings.section', JSON.stringify(slotCalls.map((c) => (c && c.definition ? c.definition.name : c))))
    const chip = slotCalls.find((c) => c && c.definition && c.definition.name === 'conversation.chat.assistant-actions')
    if (chip) ok('注册 conversation.chat.assistant-actions', `id=${chip.definition.id}, order=${chip.definition.order}`)
    else fail('注册 conversation.chat.assistant-actions', JSON.stringify(slotCalls.map((c) => (c && c.definition ? c.definition.name : c))))
    if (typeof dispose === 'function') { dispose(); ok('client dispose 可调用') }

    // ── 渲染冒烟：直接用假数据调用每个子页组件，确认不抛错 ──────────
    const internals = clientModule.__internals || {}
    const fixtureState = {
      ok: true,
      source: 'daemon',
      state: {
        providers: [{ id: 'p1', name: '秋' }, { id: 'p2', name: '北辰' }],
        offers: [{ id: 'o1', providerId: 'p1', upstreamName: '秋-官转', modelKey: 'deepseek-v4.1-flash', group: 'default' }],
        ranked: [{ modelKey: 'deepseek-v4.1-flash', spreadPct: 63, providerCount: 2, rows: [
          { offerId: 'o1', providerId: 'p1', group: 'default', isCheapest: true, blendedCnyPerMtok: 0.36, ttftMs: 900, avgLatencyMs: 2200, cacheHitRate: 0.7 },
          { offerId: 'o2', providerId: 'p2', group: 'default', blendedCnyPerMtok: 0.97, ttftMs: 1200, avgLatencyMs: 2600, cacheHitRate: 0.5 }] }],
        summary: { offerCount: 17, pricedCount: 17, modelCount: 7, comparableCount: 2, providerCount: 10, avgSpreadPct: 63, maxSpreadPct: 63 },
        headline: { modelKey: 'deepseek-v4.1-flash', providerName: '秋', price: 0.36, spreadPct: 63, text: '同样用 deepseek-v4.1-flash，现在选「秋」最划算' },
        siteRanking: [{ providerId: 'p1', providerName: '秋', score: 92, uptime: 0.98, avgQuality: 88, avgTtft: 900, modelCount: 7, probes: 210, weightedSamples: 40, lastAt: Date.now() }],
        scores: { o1: { offerId: 'o1', samples: 30, availability: 0.98, quality: 88, integrity: 96, cacheHitRate: 0.7, ttftMs: 900, latencyMs: 2200, confidence: 0.8, stale: false, evidenceAgeMs: 600000, lastError: '' } },
        routing: [{ id: 'r1', ts: Date.now(), model: 'deepseek-v4.1-flash', chosenProviderName: '秋', attempts: 2, outcome: 'ok', latencyMs: 2400, ttftMs: 900, failures: [{ providerName: 'wawazz', error: '连接失败：fetch failed', ms: 10480 }], candidates: [] }],
        usage: { totals: { requests: 2094, errors: 50, input: 448000000, output: 1081000, cached: 746000000, cacheCreation: 0, avgLatencyMs: 2400, avgTtftMs: 900 }, byProvider: [{ providerId: 'p1', requests: 100, input: 1000, output: 200 }], byDay: [] },
        probeTotal: 5000,
      },
    }
    const fixtureHealth = {
      ok: true,
      checkedAt: new Date().toISOString(),
      daemon: { mode: 'owned', pid: 1234, port: 4319, runtimeSource: 'config', lastError: '' },
      probe: { ok: true },
      budget: { configured: false, over: false, session: { tokens: 0, calls: 0, over: false }, daily: { tokens: 448669872, requests: 2094, errors: 50 }, limits: { sessionTokens: 0, dailyTokens: 0 } },
      ingest: { pushed: 1, skipped: 0, failed: 0, lastError: '', enabled: true },
      tools: { names: ['manageapi_status', 'manageapi_models', 'manageapi_usage'], failed: [] },
      commands: { name: 'manage', registered: true },
      prompt: { at: Date.now(), text: 'ManageAPI：17 个供给 / 7 个模型' },
    }
    const cases = [
      ['OverviewTab', () => internals.OverviewTab({ health: fixtureHealth, state: fixtureState, busy: false, restart() {}, onReload() {} })],
      ['OverviewTab(daemon down+budget over)', () => internals.OverviewTab({
        health: Object.assign({}, fixtureHealth, {
          daemon: { mode: 'failed', pid: null, port: 4319, lastError: 'spawn ENOENT' },
          budget: Object.assign({}, fixtureHealth.budget, { over: true, reason: '超预算' }),
          ingest: Object.assign({}, fixtureHealth.ingest, { failed: 3 }),
        }),
        state: { ok: false, error: 'boom' }, busy: true, restart() {}, onReload() {},
      })],
      ['PricesTab', () => internals.PricesTab({ state: fixtureState })],
      ['DecisionsTab', () => internals.DecisionsTab({ state: fixtureState })],
      ['ProbesTab', () => internals.ProbesTab({ state: fixtureState })],
      ['UsageTab', () => internals.UsageTab({ state: fixtureState })],
      ['CostChip(有数据)', () => internals.CostChip({ sessionId: 'session-x' })],
      ['各子页空数据', () => {
        const empty = { ok: false, state: null }
        for (const key of ['OverviewTab', 'PricesTab', 'DecisionsTab', 'ProbesTab', 'UsageTab']) {
          internals[key]({ health: null, state: empty, busy: false, restart() {}, onReload() {} })
        }
      }],
    ]
    for (const [label, runCase] of cases) {
      try {
        runCase()
        ok(`渲染冒烟：${label}`)
      } catch (err) {
        fail(`渲染冒烟：${label}`, String(err && err.message ? err.message : err))
      }
    }
  }
} catch (err) {
  fail('client 半边加载', String(err && err.stack ? err.stack : err).slice(0, 800))
}

// ── 4) package.json 自洽 ────────────────────────────────────────────
console.log('\n[3b/4] client 与 host 的 API 前缀一致性')
try {
  const clientSource = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  const routesSource = await readFile(join(root, 'lib', 'routes.js'), 'utf8')
  const hostPrefix = (routesSource.match(/const PREFIX = '([^']+)'/) || [])[1] || ''
  const clientPrefix = (clientSource.match(/var API_PREFIX = '([^']+)'/) || [])[1] || ''
  if (hostPrefix && clientPrefix && hostPrefix === '/api/' + clientPrefix) {
    ok('client API 前缀与 host 路由一致', hostPrefix + " <- API_PREFIX='" + clientPrefix + "'")
  } else {
    fail('client API 前缀与 host 路由一致', 'host=' + hostPrefix + ' client=' + clientPrefix)
  }
} catch (err) {
  fail('client API 前缀一致性检查', String(err && err.message ? err.message : err))
}


console.log('\n[4/4] package.json 自洽')
try {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (pkg.name === 'dsh-manage-api') ok('name = dsh-manage-api')
  else fail('name', pkg.name)
  if (pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch) ok('dsh.bundle.patch 存在')
  else fail('dsh.bundle.patch', '缺失')
  if (pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web') ok('dsh.client.platform = web')
  else fail('dsh.client.platform', JSON.stringify(pkg.dsh && pkg.dsh.client))
  if (pkg.exports && pkg.exports['.'] && pkg.exports['./client']) ok('exports 暴露 . 与 ./client')
  else fail('exports', '缺少 . 或 ./client')

  const targets = [pkg.main, pkg.exports['.'], pkg.exports['./client'], pkg.dsh.bundle.patch, 'locale/zh.json', 'locale/en.json', 'icon.svg']
  for (const target of targets) {
    if (!target) continue
    const path = target.startsWith('./') ? target.slice(2) : target
    if (await exists(join(root, path))) ok(`文件存在：${path}`)
    else fail(`文件存在：${path}`, '缺失')
  }
} catch (err) {
  fail('package.json 自检', String(err && err.message ? err.message : err))
}

// ── 结果 ────────────────────────────────────────────────────────────
console.log('')
if (failures.length) {
  console.error(`✗ ${failures.length} 项失败：`)
  for (const item of failures) console.error('  - ' + item)
  process.exit(1)
}
console.log(`✓ 全部通过（${checks.length} 项）`)
