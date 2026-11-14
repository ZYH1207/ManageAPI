/**
 * D 棒 · DSH Host 原生接入单元测试（模拟 Context / Service / Event）。
 *
 * 边界：零真实网络（全局 fetch 一律 mock）、零真实 daemon（4319 未运行也不用）、
 * 零真实 profile 写入（configEditor/agentDefaultModel 全为内存假件）、零子进程。
 * 失败直接抛（node 非零退出），不写 process.exit(0) 敷衍。
 *
 * 覆盖：tools/commands/prompt/models/ingest/budget 的注册、llm/stream 的 next() 续流、
 * 各 disposer 清理、缺可选服务时软降级、以及 budget guard 文案「不是 token 级熔断」。
 */

import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const passed = []
const ok = async (label, fn) => { await fn(); passed.push(label) }

const INT = await import(pathToFileURL(resolve(root, 'lib/integration/index.js')).href)
const budgetMod = await import(pathToFileURL(resolve(root, 'lib/integration/budget.js')).href)
const streamMod = await import(pathToFileURL(resolve(root, 'lib/integration/stream.js')).href)
const dshModelsMod = await import(pathToFileURL(resolve(root, 'lib/integration/dsh-models.js')).href)
const ingestMod = await import(pathToFileURL(resolve(root, 'lib/integration/ingest.js')).href)
const statsMod = await import(pathToFileURL(resolve(root, 'lib/integration/stream-stats.js')).href)
const clientMod = await import(pathToFileURL(resolve(root, 'lib/integration/daemon-client.js')).href)

// ───────────────────────── 模拟 DSH Context ─────────────────────────
function makeCtx(services = {}) {
  const listeners = new Map()
  const onDisposers = []
  const effects = [] // ctx.inject 回调返回的 disposer
  const children = new Map()
  const ctx = {
    _listeners: listeners,
    _onDisposers: onDisposers,
    _effects: effects,
    _services: services,
    logger() { return null },
    get(name, strict = false) { const v = services[name]; if (strict && v === undefined) throw new Error(`service ${name} not available`); return v },
    provide(name, value) { children.set(name, value); services[name] = value; return () => { delete services[name] } },
    effect(fn) { const disposer = fn(); effects.push(disposer); return () => { try { disposer && disposer() } catch {} } },
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
      const d = () => { const arr = listeners.get(name); const i = arr.indexOf(listener); if (i >= 0) arr.splice(i, 1) }
      onDisposers.push(d)
      return d
    },
    inject(deps, callback) {
      // 模拟：依赖就绪后调用 callback，把返回值当作该 fiber 的 disposal。
      const child = ctx
      const disposer = callback(child)
      effects.push(disposer)
      return { then: (f) => Promise.resolve().then(f) }
    },
    unloadEffects() { for (const d of effects.splice(0).reverse()) { try { d && d() } catch {} } },
    // 驱动 llm/stream waterfall（cordis 语义：listener 最外层先跑，next() 进下一层）
    fireWaterfall(name, options, inner) {
      const cbs = (listeners.get(name) || []).slice()
      const next = () => (cbs.shift() ?? inner)(options, next)
      return next()
    },
  }
  return ctx
}

function makeTools() {
  const regs = []
  const guards = []
  return {
    _regs: regs,
    register(def) { regs.push(def); return () => { def._disposed = true } },
    guard(fn) { guards.push(fn); return () => { fn._disposed = true } },
    _guards: guards,
  }
}
function makeCommands() { const regs = []; return { _regs: regs, register(def) { regs.push(def); return () => { def._disposed = true } } } }
function makeSystemPrompt() { const ctxs = []; return { _ctxs: ctxs, context(cfg) { ctxs.push(cfg); return () => { cfg._disposed = true } } } }

function makeConfigEditor() {
  // 一行承载 providers 的配置（llm-pi-ai 形状）
  let config = { providers: {} }
  const row = { entry: { id: 'llm-pi-ai' }, get inherited() { return { providers: {} } }, get override() { return config } }
  let edits = 0
  return {
    getConfig() { return config },
    _edits: () => edits,
    entries() { return [row.entry] },
    configuration() { return [row] },
    async edit(entry, change) { edits += 1; config = change(config, { providers: {} }) },
  }
}
function makeAgentDefaultModel() {
  let sel = { provider: 'other', model: 'x' }
  const saves = []
  return { _saves: saves, currentSelection() { return { ...sel } }, async saveSelection(next) { sel = { ...next }; saves.push({ ...next }) } }
}
function makeLlm() { const emitted = []; return { _emitted: emitted, emitAdaptersUpdated() { emitted.push(1) }, listProviders() { return [{ id: 'dsh-manage-api', name: 'DSH ManageAPI' }] }, async listModels() { return [{ id: 'm1' }] }, async resolveModelInfo(_p, m) { return { name: m } } } }

function makeLifecycle(services) {
  const ctx = makeCtx(services)
  const lifecycle = {
    ctx,
    config: { port: 4599 },
    runtime: { config: { port: 4599 }, loopbackBaseUrl: 'http://127.0.0.1:4599' },
    daemon: { snapshot: () => ({ mode: 'attached', ownership: 'attached', port: 4599 }) },
    optional: {},
    log: () => {},
  }
  return { ctx, lifecycle }
}

function mockFetch(handler) {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => handler(String(url), init)
  return () => { globalThis.fetch = original }
}

// 一个可控的假 daemon HTTP 响应（daemonRequest 走 res.text() 分支）
function fakeRes(status, bodyObj) {
  return { ok: status >= 200 && status < 300, status, body: null, async text() { return JSON.stringify(bodyObj) } }
}

// ───────────────────────── 1. 全量注册 ─────────────────────────
// N21：新增 5 个管理工具，总数 8（原有 3 个只读工具不动）。
await ok('全量注册：tools(8)/commands(1)/prompt(1)/guard(1)/stream(1)', async () => {
  const tools = makeTools()
  const commands = makeCommands()
  const systemPrompt = makeSystemPrompt()
  const { ctx, lifecycle } = makeLifecycle({ tools, commands, systemPrompt, configEditor: makeConfigEditor(), agentDefaultModel: makeAgentDefaultModel(), llm: makeLlm() })
  const integ = INT.registerIntegration(lifecycle)
  const pub = integ.publish()
  assert.equal(pub.tools.registered, true)
  assert.deepEqual(pub.tools.names.sort(), [
    'manageapi_gateway', 'manageapi_ignore', 'manageapi_models', 'manageapi_pricing',
    'manageapi_probe', 'manageapi_sites', 'manageapi_status', 'manageapi_usage',
  ])
  assert.equal(pub.commands.registered, true)
  assert.equal(pub.prompt.registered, true)
  assert.equal(pub.guard.registered, true)
  assert.equal(pub.stream.registered, true)
  assert.equal(tools._regs.length, 8)
  assert.equal(commands._regs.length, 1)
  assert.equal(systemPrompt._ctxs.length, 1)
  assert.equal(tools._guards.length, 1)
  // 工具 definition 形状（register 只要求 output {schema, render}）
  for (const def of tools._regs) {
    assert.equal(typeof def.name, 'string')
    assert.equal(typeof def.output.render, 'function')
    assert.equal(typeof def.output.schema, 'object')
    assert.equal(typeof def.execute, 'function')
  }
  // prompt context 形状
  const cfg = systemPrompt._ctxs[0]
  assert.equal(cfg.name, 'manage-api')
  assert.ok(Number.isFinite(cfg.order))
  assert.equal(typeof cfg.text, 'function')
  // 命令名合法
  assert.match(commands._regs[0].name, /^[a-z][a-z0-9_-]*$/)
  ctx.unloadEffects()
  integ.dispose()
})

// ───────────────────────── 2. llm/stream next() 续流 + usage 记账 + ingest ─────────────────────────
await ok('llm/stream：逐块 yield（next() 续流）、usage 入 streamStats、非 manage-api 触发 ingest', async () => {
  const captured = []
  const restore = mockFetch((url, init) => {
    captured.push({ url, method: init && init.method, body: init && init.body })
    return fakeRes(200, { ok: true, recorded: true, source: 'dsh-ingest' })
  })
  try {
    const { ctx, lifecycle } = makeLifecycle({ tools: makeTools(), commands: makeCommands(), systemPrompt: makeSystemPrompt(), configEditor: makeConfigEditor(), agentDefaultModel: makeAgentDefaultModel(), llm: makeLlm() })
    const integ = INT.registerIntegration(lifecycle)
    const innerChunks = [
      { type: 'text-delta', text: 'he' },
      { type: 'text-delta', text: 'llo' },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    async function* inner(options) { for (const c of innerChunks) yield c }
    const out = []
    for await (const chunk of ctx.fireWaterfall('llm/stream', { sessionId: 's1', model: 'deepseek-x', provider: 'dsh-provider' }, inner)) out.push(chunk)
    // next() 续流：所有 inner chunk 原样透出
    assert.deepEqual(out, innerChunks)
    // 会话累加
    assert.equal(integ.streamStats.totals().sessions, 1)
    assert.equal(integ.streamStats.totals().tokens, 140)
    // ingest 旁路 flush（drain 等待串行链）
    await integ.ingest.drain()
    const ingestCalls = captured.filter((c) => /\/api\/ingest\/usage$/.test(c.url))
    assert.equal(ingestCalls.length, 1, '应发生一次 POST /api/ingest/usage')
    assert.match(ingestCalls[0].url, /\/api\/ingest\/usage$/)
    assert.equal(ingestCalls[0].method, 'POST')
    const payload = JSON.parse(ingestCalls[0].body)
    assert.equal(payload.provider, 'dsh-provider')
    assert.equal(payload.model, 'deepseek-x')
    assert.equal(payload.inputTokens, 100)
    assert.equal(payload.outputTokens, 40)
    assert.equal(integ.ingest.snapshot().pushed, 1)
    integ.dispose()
  } finally { restore() }
})

// ───────────────────────── 3. ingest 跳过 manage-api & daemon 未就绪 ─────────────────────────
await ok('ingest：manage-api 前缀跳过、daemon 未 attached 跳过、无 token 丢弃', async () => {
  let calls = 0
  const restore = mockFetch(() => { calls += 1; return fakeRes(200, { ok: true }) })
  try {
    const client = clientMod.createDaemonClient({ port: 4599 })
    let mode = 'attached'
    const ingest = ingestMod.createIngest({ client, enabled: true, getMode: () => mode })
    ingest.record({ provider: 'manage-api', model: 'm', usage: { inputTokens: 1, outputTokens: 1 } })
    assert.equal(ingest.snapshot().skipped, 1)
    mode = 'down'
    ingest.record({ provider: 'other', model: 'm', usage: { inputTokens: 1, outputTokens: 1 } })
    assert.equal(ingest.snapshot().skipped, 2)
    mode = 'attached'
    ingest.record({ provider: 'other', model: 'm', usage: { inputTokens: 0, outputTokens: 0 } })
    await ingest.drain()
    assert.equal(calls, 0, '以上都不应真的 POST')
  } finally { restore() }
})

// ───────────────────────── 4. budget 工具守卫（超预算拒绝 + 文案） ─────────────────────────
await ok('budget：超会话预算 → guard 返回拒绝原因，文案含「工具守卫」「不是 token 级熔断」', async () => {
  const stats = statsMod.createStreamStats()
  const budget = budgetMod.createBudget({ budget: { sessionTokens: 100 }, streamStats: stats })
  stats.record('s1', { tokens: 150, model: 'm' })
  const reason = budget.denyReason('s1')
  assert.equal(typeof reason, 'string')
  assert.match(reason, /工具调用守卫/)
  assert.match(reason, /不是 token 级熔断/)
  // 未超限时返回 undefined
  stats.record('s2', { tokens: 10, model: 'm' })
  assert.equal(budget.denyReason('s2'), undefined)
  // 未配置预算永远不拒
  const free = budgetMod.createBudget({ budget: {}, streamStats: stats })
  assert.equal(free.denyReason('s1'), undefined)
  assert.equal(free.snapshot().configured, false)
})

// ───────────────────────── 5. guard 通过 tools.guard 真注册并被调用 ─────────────────────────
await ok('guard：tools.guard 注册的函数被执行；集成 publish.guard.registered=true', async () => {
  const tools = makeTools()
  const { ctx, lifecycle } = makeLifecycle({ tools, commands: makeCommands(), systemPrompt: makeSystemPrompt(), configEditor: makeConfigEditor(), agentDefaultModel: makeAgentDefaultModel(), llm: makeLlm() })
  const integ = INT.registerIntegration(lifecycle, { budget: { sessionTokens: 50 } })
  assert.equal(tools._guards.length, 1)
  // 直接驱动已注册 guard（模拟 tools 管线调用 exec）
  integ.streamStats.record('agent-1', { tokens: 60, model: 'm' })
  const deny = tools._guards[0]({ agent: { id: 'agent-1' } })
  assert.equal(typeof deny, 'string')
  // 未超预算的 agent 不拒
  assert.equal(tools._guards[0]({ agent: { id: 'agent-2' } }), undefined)
  ctx.unloadEffects(); integ.dispose()
})

// ───────────────────────── 6. 缺可选服务软降级（不抛，能力标记 false） ─────────────────────────
await ok('缺服务软降级：无 tools/commands/systemPrompt 时不抛，能力标记 false', async () => {
  const { ctx, lifecycle } = makeLifecycle({}) // 全空
  let threw = false
  let integ
  try { integ = INT.registerIntegration(lifecycle) } catch { threw = true }
  assert.equal(threw, false)
  const pub = integ.publish()
  assert.equal(pub.tools.registered, false)
  assert.equal(pub.commands.registered, false)
  assert.equal(pub.prompt.registered, false)
  assert.equal(pub.guard.registered, false)
  // stream 仍注册（ctx.on 存在）
  assert.equal(pub.stream.registered, true)
  ctx.unloadEffects(); integ.dispose()
})

// ───────────────────────── 7. 极简 ctx（无 inject/on）不抛 ─────────────────────────
await ok('极简 ctx（无 inject/on）不抛，全部标记未注册', async () => {
  const bare = { get() { return undefined }, logger() { return null } }
  const lifecycle = { ctx: bare, config: { port: 4599 }, runtime: { config: { port: 4599 }, loopbackBaseUrl: 'http://127.0.0.1:4599' }, daemon: { snapshot: () => ({ mode: 'down' }) }, optional: {}, log: () => {} }
  let integ
  assert.doesNotThrow(() => { integ = INT.registerIntegration(lifecycle) })
  const pub = integ.publish()
  assert.equal(pub.tools.registered, false)
  assert.equal(pub.stream.registered, false)
  integ.dispose()
})

// ───────────────────────── 8. disposer 清理：注册逆序释放、可重复 dispose ─────────────────────────
await ok('disposer：unload 释放 tools/commands/prompt/guard；integration.dispose 移除 stream 监听、幂等', async () => {
  const tools = makeTools()
  const commands = makeCommands()
  const systemPrompt = makeSystemPrompt()
  const { ctx, lifecycle } = makeLifecycle({ tools, commands, systemPrompt, configEditor: makeConfigEditor(), agentDefaultModel: makeAgentDefaultModel(), llm: makeLlm() })
  const integ = INT.registerIntegration(lifecycle)
  assert.equal((ctx._listeners.get('llm/stream') || []).length, 1)
  ctx.unloadEffects() // 模拟 fiber 卸载：inject 回调返回的 disposer 全部执行
  assert.ok(tools._regs.every((d) => d._disposed === true), 'tools 全部被 dispose')
  assert.ok(commands._regs.every((d) => d._disposed === true), 'commands 被 dispose')
  assert.ok(systemPrompt._ctxs.every((c) => c._disposed === true), 'prompt context 被 dispose')
  assert.ok(tools._guards.every((g) => g._disposed === true), 'guard 被 dispose')
  integ.dispose()
  assert.equal((ctx._listeners.get('llm/stream') || []).length, 0, 'stream 监听被移除')
  assert.doesNotThrow(() => integ.dispose(), '重复 dispose 幂等')
})

// ───────────────────────── 9. dsh-models：显式启用/幂等/停用（内存假 configEditor） ─────────────────────────
await ok('dsh-models：configure 启用→幂等→停用；saveSelection；广播 adapters-updated', async () => {
  const configEditor = makeConfigEditor()
  const agentDefaultModel = makeAgentDefaultModel()
  const llm = makeLlm()
  const model = dshModelsMod.createDshModel({ ctx: { get: (n) => ({ configEditor, agentDefaultModel, llm })[n] }, provider: 'dsh-manage-api' })
  // 启用
  const r1 = await model.configure('deepseek-v3', { enabled: true })
  assert.equal(r1.ok, true)
  assert.equal(r1.added, true)
  assert.equal(r1.created, true)
  assert.equal(configEditor.getConfig().providers['dsh-manage-api'].api, 'openai-completions')
  assert.equal(configEditor.getConfig().providers['dsh-manage-api'].models.length, 1)
  assert.deepEqual(agentDefaultModel._saves.at(-1), { provider: 'dsh-manage-api', model: 'deepseek-v3' })
  assert.equal(llm._emitted.length >= 1, true)
  // 幂等：再启用不重复追加
  const r2 = await model.configure('deepseek-v3', { enabled: true })
  assert.equal(r2.added, false)
  assert.equal(configEditor.getConfig().providers['dsh-manage-api'].models.length, 1)
  // 停用「最后一个且正是当前默认」→ 被拒绝（保护 DSH 默认模型指向不存在的模型）
  const rRefuse = await model.configure('deepseek-v3', { enabled: false })
  assert.equal(rRefuse.ok, false)
  assert.match(rRefuse.error, /最后一个模型/)
  // 再加一个模型，再停用第一个（非唯一、非当前默认）→ 成功移除，组保留
  const rAdd2 = await model.configure('glm-4', { enabled: true })
  assert.equal(rAdd2.added, true)
  const r3 = await model.configure('deepseek-v3', { enabled: false })
  assert.equal(r3.ok, true)
  assert.equal(r3.removed, true)
  const remaining = configEditor.getConfig().providers['dsh-manage-api'].models.map((m) => m.id)
  assert.deepEqual(remaining, ['glm-4'])
})

// ───────────────────────── 10. dsh-models：缺服务/非法模型名 返回明确错误 ─────────────────────────
await ok('dsh-models：无 configEditor / 非法模型名 → ok:false 明确错误', async () => {
  const noEditor = dshModelsMod.createDshModel({ ctx: { get: () => undefined } })
  const r1 = await noEditor.configure('m1', { enabled: true })
  assert.equal(r1.ok, false)
  assert.match(r1.error, /configEditor/)
  const withEditor = dshModelsMod.createDshModel({ ctx: { get: (n) => ({ configEditor: makeConfigEditor(), agentDefaultModel: makeAgentDefaultModel() })[n] } })
  const r2 = await withEditor.configure('bad model *', { enabled: true })
  assert.equal(r2.ok, false)
  assert.match(r2.error, /不合法/)
})

// ───────────────────────── 11. 工具 execute 走 mock daemon state（脱敏 client） ─────────────────────────
await ok('tools.execute：原有 3 个只读工具 + N21 新增 5 个管理工具，写操作全走 WRITE_RULES', async () => {
  const tools = makeTools()
  const restore = mockFetch((url) => {
    assert.match(url, /\/api\/state\?light=1$/)
    return fakeRes(200, {
      summary: { offerCount: 3, pricedCount: 2, modelCount: 5, comparableCount: 4, providerCount: 2, avgSpreadPct: 12 },
      headline: { text: 'deepseek 最便宜', modelKey: 'deepseek', providerName: 'A', price: 1.2, spreadPct: 3 },
      usage: { totals: { requests: 7, input: 1000, output: 500, cached: 100, errors: 0 } },
      ranked: [{ modelKey: 'deepseek', providerCount: 2, spreadPct: 10, rows: [{ providerId: 'p1', blendedCnyPerMtok: 1.2, isCheapest: true, ttftMs: 300 }], cheapest: { providerId: 'p1', blendedCnyPerMtok: 1.2 } }],
      providers: [{ id: 'p1', name: 'A' }],
    })
  })
  try {
    const { ctx, lifecycle } = makeLifecycle({ tools, commands: makeCommands(), systemPrompt: makeSystemPrompt(), configEditor: makeConfigEditor(), agentDefaultModel: makeAgentDefaultModel(), llm: makeLlm() })
    const integ = INT.registerIntegration(lifecycle)
    const defs = Object.fromEntries(tools._regs.map((d) => [d.name, d]))
    const status = await defs.manageapi_status.execute({}, {})
    assert.equal(status.daemon.reachable, true)
    assert.equal(status.routing.offers, 3)
    const rendered = defs.manageapi_status.output.render({}, status)
    assert.equal(rendered[0].type, 'text')
    assert.match(rendered[0].text, /ManageAPI/)
    const models = await defs.manageapi_models.execute({ limit: 3 }, {})
    assert.equal(models.matched, true)
    assert.equal(models.models[0].model, 'deepseek')
    const usage = await defs.manageapi_usage.execute({}, {})
    assert.equal(usage.daily.requests, 7)
    // N21：5 个新工具的只读路径 + 写白名单路径（假 daemon state）
    const sites = await defs.manageapi_sites.execute({}, {})
    assert.equal(sites.readonly, true)
    assert.equal(sites.count, 1)
    const gateway = await defs.manageapi_gateway.execute({ action: 'status' }, {})
    assert.equal(gateway.readonly, true)
    // N24：用户指示「除免费池外按正常网关放开」—— keys 列表是只读，
    // key-* 写操作放开但必须 confirm（未确认不发请求）。
    const gatewayKeys = await defs.manageapi_gateway.execute({ action: 'keys' }, {})
    assert.equal(gatewayKeys.readonly, true)
    assert.ok(Array.isArray(gatewayKeys.keys))
    const keyCreateNoConfirm = await defs.manageapi_gateway.execute({ action: 'key-create' }, {})
    assert.equal(keyCreateNoConfirm.status, 'confirm-required')
    assert.equal(keyCreateNoConfirm.action, 'key-create')
    const probe = await defs.manageapi_probe.execute({ action: 'query' }, {})
    assert.equal(probe.readonly, true)
    const pricing = await defs.manageapi_pricing.execute({ model: 'deepseek' }, {})
    assert.equal(pricing.readonly, true)
    assert.ok(Array.isArray(pricing.models))
    // 基准价写：放开后缺参数报 400、缺 confirm 报 confirm-required（都不发请求）
    const benchmarkNoArgs = await defs.manageapi_pricing.execute({ setBenchmark: true }, {})
    assert.equal(benchmarkNoArgs.writes[0].status, 400)
    assert.equal(benchmarkNoArgs.writes[0].action, 'benchmark.upsert')
    const benchmarkNoConfirm = await defs.manageapi_pricing.execute({ setBenchmark: true, benchmarkKey: 'deepseek', benchmarkPrice: 1 }, {})
    assert.equal(benchmarkNoConfirm.writes[0].status, 'confirm-required')
    // 免费池仍必须 unavailable（用户明确不要这个功能）
    const wp = await import(pathToFileURL(resolve(root, 'lib/write-proxy.js')).href)
    assert.ok(wp.WRITE_UNAVAILABLE.freePool !== undefined, '免费池必须仍在 WRITE_UNAVAILABLE')
    assert.ok(wp.WRITE_UNAVAILABLE.benchmarks === undefined, 'N24 放开后 benchmarks 不应再标 unavailable')
    assert.ok(wp.WRITE_UNAVAILABLE.gatewayKeys === undefined, 'N24 放开后 gatewayKeys 不应再标 unavailable')
    const ignored = await defs.manageapi_ignore.execute({ action: 'list' }, {})
    assert.equal(ignored.readonly, true)
    const panelIgnore = await defs.manageapi_ignore.execute({ action: 'panel-ignore' }, {})
    assert.equal(panelIgnore.status, 'unavailable')
    // 写操作必须先 confirm（未确认不发请求）
    const noConfirm = await defs.manageapi_gateway.execute({ action: 'enable' }, {})
    assert.equal(noConfirm.status, 'confirm-required')
    ctx.unloadEffects(); integ.dispose()
  } finally { restore() }
})

// ───────────────────────── 12. commands handler：success/error 契约 ─────────────────────────
await ok('commands handler：status→success、bad sub→error、daemon 不可用→error', async () => {
  const commands = makeCommands()
  const okState = mockFetch(() => fakeRes(200, { summary: { providerCount: 2, offerCount: 3, modelCount: 4 }, usage: { totals: { requests: 1, input: 2, output: 3 } } }))
  try {
    const { ctx, lifecycle } = makeLifecycle({ tools: makeTools(), commands, systemPrompt: makeSystemPrompt(), configEditor: makeConfigEditor(), agentDefaultModel: makeAgentDefaultModel(), llm: makeLlm() })
    const integ = INT.registerIntegration(lifecycle)
    const handler = commands._regs[0].handler
    const r1 = await handler({ rawInput: 'status' })
    assert.equal(r1.kind, 'success')
    assert.match(r1.text, /ManageAPI/)
    const r2 = await handler({ rawInput: 'nope' })
    assert.equal(r2.kind, 'error')
    const r3 = await handler({ rawInput: 'budget' })
    assert.equal(r3.kind, 'success')
    ctx.unloadEffects(); integ.dispose()
  } finally { okState() }
  const fail = mockFetch(() => ({ ok: false, status: 502, body: null, async text() { return JSON.stringify({ error: 'down' }) } }))
  try {
    const commands2 = makeCommands()
    const { ctx, lifecycle } = makeLifecycle({ tools: makeTools(), commands: commands2, systemPrompt: makeSystemPrompt(), configEditor: makeConfigEditor(), agentDefaultModel: makeAgentDefaultModel(), llm: makeLlm() })
    const integ = INT.registerIntegration(lifecycle)
    const r = await commands2._regs[0].handler({ rawInput: 'status' })
    assert.equal(r.kind, 'error')
    ctx.unloadEffects(); integ.dispose()
  } finally { fail() }
})

// ───────────────────────── 13. stream-stats 有界淘汰 ─────────────────────────
await ok('stream-stats：超过 maxSessions 淘汰最久未活跃会话', async () => {
  const s = statsMod.createStreamStats({ maxSessions: 2 })
  s.record('a', { tokens: 1 }); s.record('b', { tokens: 1 }); s.record('c', { tokens: 1 })
  assert.equal(s.size(), 2)
  assert.equal(s.get('a'), null, 'a 最旧应被淘汰')
  assert.equal(s.totals().sessions, 2)
})

// ───────────────────────── 14. /api/manage-api 路由注册层（lib/http-server.js） ─────────────────────────
// 纯静态：不起真实 server、不发网络（只验证注册形状 / disposer 成对 / 缺服务软降级 / apply 挂载）。
// 真实端到端（curl live daemon 4319）在 release 报告的临时脚本里单独跑，静态测试不等价于路由可达。
const httpServerMod = await import(pathToFileURL(resolve(root, 'lib/http-server.js')).href)
const { apply: hostApply } = await import(pathToFileURL(resolve(root, 'index.js')).href)

await ok('http-server：5 条只读为 exact、带参 /providers 为 prefix（稳定前缀）+ panel 别名', async () => {
  const regs = httpServerMod.buildRouteRegistrations({ port: 4599 })
  const reads = regs.filter((r) => r.path !== '/api/manage-api/panel')
  assert.equal(reads.length, 6)
  // 5 条无参只读路由：仍按 exact 注册，路径不变。
  const exactReads = reads.filter((r) => r.kind === 'exact')
  assert.deepEqual(exactReads.map((r) => r.path).sort(), [
    '/api/manage-api/health', '/api/manage-api/monitor', '/api/manage-api/state',
    '/api/manage-api/usage', '/api/manage-api/usage/detail',
  ])
  // 带 :id 的路由：kind 必须为 prefix，路径取参数段之前的稳定前缀 /api/manage-api/providers。
  const paramReads = reads.filter((r) => r.kind === 'prefix')
  assert.equal(paramReads.length, 1)
  assert.equal(paramReads[0].path, '/api/manage-api/providers')
  for (const r of reads) {
    assert.ok(r.path.startsWith('/api/manage-api'))
    assert.ok(r.kind === 'exact' || r.kind === 'prefix')
    assert.equal(typeof r.handler, 'function')
  }
  assert.ok(regs.some((r) => r.path === '/api/manage-api/panel' && r.kind === 'exact'))
})

await ok('http-server：registerHttpRoutes 全部注册并返回成对 disposer；dispose 后全部调用', async () => {
  const calls = []
  const webServer = { register(route) { const rec = { path: route.path, disposed: false }; calls.push(rec); return () => { rec.disposed = true } } }
  const res = httpServerMod.registerHttpRoutes({ webServer, port: 4599, log: () => {} })
  assert.equal(res.count, calls.length)
  assert.ok(res.count >= 6)
  res.dispose()
  assert.ok(calls.every((c) => c.disposed === true), '每个 register 返回的 disposer 都应被调用')
  assert.doesNotThrow(() => res.dispose(), '重复 dispose 幂等')
})

await ok('http-server：webServer 缺失时软降级（不抛、count=0）', async () => {
  let res
  assert.doesNotThrow(() => { res = httpServerMod.registerHttpRoutes({ webServer: undefined, port: 4599, log: () => {} }) })
  assert.equal(res.count, 0)
})

await ok('index.apply：经 host.optional.webServer 挂载 /api/manage-api 路由，effect cleanup 成对释放', async () => {
  const calls = []
  const webServer = { register(route) { const rec = { path: route.path, disposed: false }; calls.push(rec); return () => { rec.disposed = true } } }
  let cleanup = null
  const ctx = {
    effect(fn) { const d = fn(); cleanup = () => { try { d && d() } catch {} }; return cleanup },
    get(name) { return name === 'webServer' ? webServer : undefined },
    logger() { return { info() {}, warn() {} } },
  }
  // attachExisting/autoStart 均 false → 零进程、零网络
  assert.doesNotThrow(() => { hostApply(ctx, { autoStart: false, attachExisting: false, port: 4599, runtimeDir: '', dataDir: '', waitMs: 1000 }) })
  const paths = calls.map((c) => c.path)
  assert.ok(paths.includes('/api/manage-api/health'), 'apply 应挂载 /api/manage-api/health')
  assert.ok(paths.includes('/api/manage-api/state'), 'apply 应挂载 /api/manage-api/state')
  assert.equal(calls.filter((c) => c.path !== '/api/manage-api/panel').length, 6)
  cleanup()
  assert.ok(calls.every((c) => c.disposed === true), 'effect cleanup 应释放全部路由 disposer')
})

console.log(`check-dsh-host: ${passed.length} 组断言通过`)
for (const label of passed) console.log(`  ok  ${label}`)
