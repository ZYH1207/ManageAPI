/**
 * D 棒 · Host 原生接入装配器（registerIntegration）。
 *
 * 逐项移植 A 棒确认要保留的朋友版 DSH 接入能力，依据本机 DSH 0.2.2-alpha.2 实测契约：
 *   - tools       `ctx.tools.register(def)`（3 个只读工具）            → tools.js
 *   - commands    `ctx.commands.register({name,handler})`（/manage）   → commands.js
 *   - systemPrompt`ctx.systemPrompt.context({name,order,text})`        → prompt.js
 *   - models      `configEditor` + `agentDefaultModel`（仅用户显式操作）→ dsh-models.js
 *   - llm/stream  waterfall tee，必须 next() 续流                      → stream.js
 *   - ingest      POST /api/ingest/usage（异步旁路，不阻塞热路径）      → ingest.js
 *   - budget      `ctx.tools.guard(...)`（工具守卫，非 token 熔断）     → budget.js
 *
 * 设计约束：
 *   - 所有注册随 ctx/宿主 dispose（ctx.inject / ctx.on 本身就是 effect 托管）；
 *   - 可选服务一律软依赖：缺失时相关能力标记 unavailable，绝不让整个插件激活失败；
 *   - 不在 apply 里自动启动 daemon、不自动写 DSH 配置；
 *   - 只读 llm/stream、只经固定白名单 POST 回写用量，绝不改模型请求/流。
 *
 * 用法：`registerIntegration(lifecycle, options) -> { dispose, publish, ... }`
 * lifecycle 即 B 棒 `createHostLifecycle()` 的返回值。
 */

import { createBudget } from './budget.js'
import { registerCommands } from './commands.js'
import { createDaemonClient } from './daemon-client.js'
import { createDshModel } from './dsh-models.js'
import { createIngest } from './ingest.js'
import { createPromptContext } from './prompt.js'
import { createStreamStats } from './stream-stats.js'
import { registerStreamObserver } from './stream.js'
import { registerTools } from './tools.js'

/** D 棒集成默认项（B 棒 patch 键集合冻结，不往 patch 里加这些键；此处仅代码默认值）。 */
export const INTEGRATION_DEFAULTS = Object.freeze({
  ingestExternalUsage: true,
  promptContext: true,
  registerTools: true,
  registerCommands: true,
  registerStream: true,
  registerGuard: true,
  enableModels: true,
  dshProvider: 'dsh-manage-api',
  budget: Object.freeze({ sessionTokens: 0, dailyTokens: 0 }),
  promptRefreshMs: 30000,
})

function mergeOptions(options = {}) {
  const budget = { ...INTEGRATION_DEFAULTS.budget, ...(options.budget || {}) }
  return { ...INTEGRATION_DEFAULTS, ...options, budget }
}

/**
 * @param {{ctx:any, config:any, runtime:any, daemon:any, optional:any, log?:Function}} lifecycle
 * @param {object} [options]
 */
export function registerIntegration(lifecycle, options = {}) {
  const { ctx, runtime, daemon } = lifecycle
  const log = typeof lifecycle.log === 'function' ? lifecycle.log : () => {}
  const opts = mergeOptions(options)

  const client = createDaemonClient({ port: runtime && runtime.config ? runtime.config.port : undefined })
  const getMode = () => {
    try { return daemon && typeof daemon.snapshot === 'function' ? daemon.snapshot().mode : 'down' } catch { return 'down' }
  }
  const streamStats = createStreamStats()
  const budget = createBudget({ budget: opts.budget, streamStats, log })

  const ingest = createIngest({
    client,
    enabled: opts.ingestExternalUsage,
    getMode,
    log,
    // 回写成功顺手把用量并入预算的日维度投影（失败不影响）
    onRecorded: ({ payload }) => {
      try {
        const t = payload || {}
        budget.absorbUsage({ input: t.inputTokens, output: t.outputTokens, requests: 1, errors: t.ok === false ? 1 : 0 })
      } catch { /* ignore */ }
    },
  })

  const promptContext = createPromptContext({ client, budget, getMode, log, port: runtime && runtime.config ? runtime.config.port : 4319, refreshMs: opts.promptRefreshMs })

  const dshModel = opts.enableModels
    ? createDshModel({ ctx, provider: opts.dshProvider, baseUrl: () => `${(runtime && runtime.loopbackBaseUrl) || 'http://127.0.0.1:4319'}/v1`, log })
    : null

  // 各能力注册状态（供 publish / 诊断）
  const status = { tools: { registered: false, names: [], failed: [] }, commands: { registered: false }, prompt: { registered: false }, guard: { registered: false }, stream: { registered: false } }
  const disposers = []
  let disposed = false
  const addDispose = (fn) => { if (typeof fn === 'function') disposers.push(fn) }

  // ── llm/stream tee：ctx.on 本身即 effect 托管，不额外 ctx.effect ──────────
  if (opts.registerStream && typeof ctx.on === 'function') {
    try {
      addDispose(registerStreamObserver({ ctx, streamStats, ingest, log }))
      status.stream.registered = true
    } catch (err) {
      log(`注册 llm/stream 观察失败（软降级）：${String(err && err.message ? err.message : err)}`)
    }
  }

  // ── 可选服务用 ctx.inject 等待就绪；fake/缺失 ctx 下自动跳过 ──────────────
  if (typeof ctx.inject === 'function') {
    if (opts.registerTools) {
      try {
        ctx.inject(['tools'], (child) => {
          const tools = typeof child.get === 'function' ? child.get('tools', false) : undefined
          if (!tools || typeof tools.register !== 'function') return
          const reg = registerTools({ tools, client, budget, streamStats, log })
          status.tools = { registered: true, names: reg.info().names, failed: reg.info().failed }
          return reg.dispose
        })
      } catch (err) { log(`注册 tools 失败（软降级）：${String(err && err.message ? err.message : err)}`) }
    }
    if (opts.registerCommands) {
      try {
        ctx.inject(['commands'], (child) => {
          const commands = typeof child.get === 'function' ? child.get('commands', false) : undefined
          if (!commands || typeof commands.register !== 'function') return
          const dispose = registerCommands({ commands, client, budget, streamStats, log })
          status.commands.registered = true
          return dispose
        })
      } catch (err) { log(`注册 commands 失败（软降级）：${String(err && err.message ? err.message : err)}`) }
    }
    if (opts.registerGuard) {
      try {
        ctx.inject(['tools'], (child) => {
          const tools = typeof child.get === 'function' ? child.get('tools', false) : undefined
          if (!tools || typeof tools.guard !== 'function') return
          const dispose = tools.guard((execution) => {
            const agentId = execution && execution.agent && typeof execution.agent.id === 'string' ? execution.agent.id : undefined
            return budget.denyReason(agentId)
          })
          status.guard.registered = true
          return () => { try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ } }
        })
      } catch (err) { log(`注册预算工具守卫失败（软降级）：${String(err && err.message ? err.message : err)}`) }
    }
    if (opts.promptContext) {
      try {
        ctx.inject(['systemPrompt'], (child) => {
          const systemPrompt = typeof child.get === 'function' ? child.get('systemPrompt', false) : undefined
          if (!systemPrompt || typeof systemPrompt.context !== 'function') return
          const stopTimer = promptContext.start()
          const dispose = promptContext.register(systemPrompt)
          status.prompt.registered = true
          return () => { try { dispose() } catch { /* ignore */ } ; try { stopTimer() } catch { /* ignore */ } }
        })
      } catch (err) { log(`注册 systemPrompt 上下文失败（软降级）：${String(err && err.message ? err.message : err)}`) }
    }
  }

  /** 给 E / 未来 Host 路由的安全调用面（只读状态 + 仅在用户操作时写模型）。 */
  function publish() {
    return {
      ok: true,
      daemon: (() => { try { return daemon && daemon.snapshot ? daemon.snapshot() : null } catch { return null } })(),
      port: runtime && runtime.config ? runtime.config.port : null,
      loopbackBaseUrl: runtime ? runtime.loopbackBaseUrl : null,
      stream: { registered: status.stream.registered, totals: streamStats.totals(), sessions: streamStats.sessions(5) },
      budget: budget.snapshot(),
      ingest: ingest.snapshot(),
      tools: status.tools,
      commands: status.commands,
      prompt: { registered: status.prompt.registered, debug: promptContext.debug() },
      guard: status.guard,
      models: dshModel ? dshModel.snapshot() : { ok: false, error: 'models 集成已禁用' },
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const fn of disposers.splice(0).reverse()) { try { fn() } catch { /* ignore */ } }
  }

  return {
    client,
    streamStats,
    budget,
    ingest,
    promptContext,
    dshModel,
    status,
    publish,
    dispose,
    // 供 Host 路由 / 命令直接复用的操作（与工具同语义，共用一份实现）
    refreshPrompt: () => promptContext.maybeRefresh(),
    configureModel: (model, o) => (dshModel ? dshModel.configure(model, o) : Promise.resolve({ ok: false, error: 'models 集成已禁用' })),
    modelCatalog: () => (dshModel ? dshModel.catalog() : Promise.resolve({ ok: false, error: 'models 集成已禁用' })),
    selection: () => (dshModel ? dshModel.selection() : null),
  }
}
