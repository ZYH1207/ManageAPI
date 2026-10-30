/**
 * dsh-manage-api — Host 半边（插件宿主进程内运行）。
 *
 * ## 这一半负责什么
 *
 * 1. **daemon 生命周期**：attach-or-spawn、孤儿防护、卸载时只停自己起的那个（lib/daemon.js）
 * 2. **同源只读代理**：`/api/manage-api/*` → `127.0.0.1:4319/api/*`（lib/routes.js）
 * 3. **请求观测**：`llm/stream` waterfall 只做 tee，拿 usage/finish，不缓冲、不阻塞
 * 4. **用量回写**：非 ManageAPI 渠道的真实用量推给 daemon 记账（lib/ingest.js）
 * 5. **工具 / 提示词上下文 / 预算熔断**：lib/tools.js、lib/prompt.js、lib/budget.js
 *
 * ## 为什么这些必须在宿主进程里
 *
 * `llm/stream`、`systemPrompt.*`、`tools.*` 都是宿主进程内的服务/事件，daemon 作为独立进程
 * 一个都碰不到。daemon 负责「怎么调模型、调哪个站、记多少账」，插件负责「让 DSH 知道这些」。
 *
 * ## 依赖策略
 *
 * 全部用 `ctx.get(name, false)` 软取：webServer / tools / systemPrompt 缺失时其余部分照常工作，
 * 绝不因为一个增强能力缺失导致整个插件激活失败。
 */

import { createDaemonManager, probeHealth } from './daemon.js'
import { createBudget } from './budget.js'
import { createIngest } from './ingest.js'
import { createPromptContext } from './prompt.js'
import { registerRoutes } from './routes.js'
import { registerTools } from './tools.js'
import { registerCommands } from './commands.js'
import { resolveRuntimeDir } from './runtime.js'

export const name = 'dsh-manage-api'

const DEFAULT_CONFIG = {
  port: 4319,
  autoStart: true,
  runtimeDir: '',
  waitMs: 10_000,
  proxyEnabled: true,
  flushOnDispose: true,
  /** 把非 ManageAPI 渠道的真实用量回写给 daemon（避免界面里看不到那部分钱） */
  ingestExternalUsage: true,
  /** 是否把 ManageAPI 现状注入系统提示词上下文 */
  promptContext: true,
  /** 预算（0 = 不设限）。超限后 tools.guard 拒绝一切工具调用，逼模型收尾 */
  budget: { sessionTokens: 0, dailyTokens: 0 },
}

const BUDGET_KEYS = ['sessionTokens', 'dailyTokens']

/**
 * @param {unknown} raw
 */
function normalizeConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget } }
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (key === 'budget') continue
      if (raw[key] !== undefined && raw[key] !== null) cfg[key] = raw[key]
    }
    if (raw.budget && typeof raw.budget === 'object') {
      for (const key of BUDGET_KEYS) {
        const value = Number(raw.budget[key])
        if (Number.isFinite(value) && value > 0) cfg.budget[key] = Math.round(value)
      }
    }
  }
  cfg.port = Number(cfg.port) || 4319
  cfg.autoStart = Boolean(cfg.autoStart)
  cfg.proxyEnabled = Boolean(cfg.proxyEnabled)
  cfg.flushOnDispose = Boolean(cfg.flushOnDispose)
  cfg.ingestExternalUsage = cfg.ingestExternalUsage !== false
  cfg.promptContext = cfg.promptContext !== false
  cfg.waitMs = Number(cfg.waitMs) || 10_000
  return cfg
}

/**
 * @param {any} ctx
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = (...args) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-manage-api') : null
      if (logger && typeof logger.info === 'function') logger.info(...args)
      else console.log('[dsh-manage-api]', ...args)
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  const runtime = resolveRuntimeDir(config.runtimeDir)
  if (!runtime.dir) {
    log('找不到 ManageAPI 运行时，插件降级为「仅本地只读」：', runtime.tried.join(' | '))
  } else {
    log(`运行时目录：${runtime.dir}（来源 ${runtime.source}）`)
  }

  const manager = createDaemonManager({
    port: config.port,
    autoStart: config.autoStart && Boolean(runtime.dir),
    runtimeDir: runtime.dir,
    runtimeSource: runtime.source,
    waitMs: config.waitMs,
    flushOnDispose: config.flushOnDispose,
    log,
  })

  // ── 生命周期：所有注册都放 ctx.effect，卸载时按序回收 ──────────────
  ctx.effect(() => {
    // 不 await：激活阶段不能阻塞（daemon 冷启动可能要几秒）
    manager
      .start()
      // daemon 就绪后立刻刷新提示词文本，否则要等下一次 30s 轮询才纠正「未运行」
      .then(() => promptContext.refresh())
      .catch((err) => log('daemon 启动失败：', String(err && err.message ? err.message : err)))
    return () => manager.dispose().catch(() => {})
  }, 'manage-api: daemon lifecycle')

  // ── 会话用量累加器（内存，供 chip / 工具 / 预算读）───────────────
  const streamStats = new Map() // sessionId -> { tokens, calls, lastAt, model }

  const budget = createBudget({ config, streamStats, log })
  const ingest = createIngest({
    port: config.port,
    enabled: config.ingestExternalUsage,
    getMode: () => manager.snapshot().mode,
    log,
  })
  const promptContext = createPromptContext({
    port: config.port,
    budget,
    getMode: () => manager.snapshot().mode,
    log,
  })

  // ── HTTP 路由（webServer 是可选依赖）────────────────────────────
  //
  // ⚠️ 必须用 ctx.inject 等 webServer 就绪，不能用 ctx.get 一次性探：
  //    激活时机早于 webServer 服务时就绪时，ctx.get 返回 undefined，
  //    一次性判断会永久跳过注册 —— 表现是「面板一直 401 / 非 JSON」。
  if (config.proxyEnabled) {
    ctx.inject(['webServer'], (ctx) => {
      const webServer = ctx.get('webServer', false)
      if (!webServer) return
      return ctx.effect(() => registerRoutes({
        webServer,
        manager,
        config,
        log,
        streamStats,
        budget,
        ingest,
        promptDebug: () => promptContext.debug(),
        promptRefresh: () => promptContext.maybeRefresh(),
        toolInfo: () => toolsInfo(),
        commandInfo: () => commandInfo(),
      }), 'manage-api: http routes')
    })
  }

  // ── llm/stream：只 tee，不缓冲、不 await 磁盘 ────────────────────
  //
  // 这是唯一能同时看到「token 用量 + 结束原因 + 最终模型 + 首字延迟」的位置，且与轮次语义无关。
  //
  // 硬规则：**绝不 await 磁盘/网络**，否则会拖慢所有请求。回写用量走 ingest 的旁路队列
  // （fire-and-forget），失败只吞掉不重试。
  ctx.effect(() => {
    const dispose = ctx.on('llm/stream', async function* (options, next) {
      const sessionId = options && options.sessionId ? String(options.sessionId) : ''
      const model = options && options.model ? String(options.model) : ''
      const provider = options && options.provider ? String(options.provider) : ''
      const startedAt = Date.now()
      let ttftMs = null
      let usage = null
      let finish = null
      try {
        for await (const chunk of next()) {
          if (ttftMs === null && chunk && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')) {
            ttftMs = Date.now() - startedAt
          }
          if (chunk && chunk.type === 'usage') usage = chunk.usage
          else if (chunk && chunk.type === 'finish') finish = chunk.reason
          yield chunk
        }
      } finally {
        if (usage) {
          const prev = streamStats.get(sessionId) || { tokens: 0, calls: 0, lastAt: 0, model }
          const tokens = typeof usage.totalTokens === 'number'
            ? usage.totalTokens
            : (usage.inputTokens || 0) + (usage.outputTokens || 0)
          streamStats.set(sessionId, {
            tokens: prev.tokens + tokens,
            calls: prev.calls + 1,
            lastAt: Date.now(),
            model,
          })
          ingest.record({
            provider,
            model,
            usage,
            latencyMs: Date.now() - startedAt,
            ttftMs,
            ok: !(finish && finish.kind === 'error'),
          })
          log(
            `stream usage session=${sessionId || '-'} provider=${provider || '-'} model=${model || '-'} `
            + `in=${usage.inputTokens ?? 0} out=${usage.outputTokens ?? 0} `
            + `finish=${finish && finish.kind ? finish.kind : '-'}`,
          )
        }
      }
    })
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* ignore */
      }
    }
  }, 'manage-api: llm stream tee')

  // ── 工具（模型可见）：status / models / usage ────────────────────
  let toolsInfo = () => ({ names: [], failed: [], unavailable: true })
  ctx.inject(['tools'], (ctx) => {
    const tools = ctx.get('tools', false)
    if (!tools || typeof tools.register !== 'function') return
    const registered = registerTools({ tools, port: config.port, budget, streamStats, log })
    toolsInfo = registered.info
    return registered.dispose
  })

  // ── 人类命令：/manage status|models|usage|budget ─────────────────
  let commandInfo = () => ({ name: 'manage', registered: false, unavailable: true })
  ctx.inject(['commands'], (ctx) => {
    const commands = ctx.get('commands', false)
    if (!commands || typeof commands.register !== 'function') return
    commandInfo = () => ({ name: 'manage', registered: true, unavailable: false })
    return registerCommands({ commands, port: config.port, budget, streamStats, log })
  })

  // ── 预算熔断：超预算后拒绝一切工具调用 ───────────────────────────
  //
  // 只能挂在工具上：模型请求由宿主直接发出，插件在 llm/stream 里只是旁观者。
  // 拒绝一切工具后 agent 无法继续扩大动作面，配合提示词里的预算状态通常会自己收尾。
  ctx.inject(['tools'], (ctx) => {
    const tools = ctx.get('tools', false)
    if (!tools || typeof tools.guard !== 'function') return
    const dispose = tools.guard((execution) => {
      const agentId = execution && execution.agent && typeof execution.agent.id === 'string' ? execution.agent.id : undefined
      return budget.denyReason(agentId)
    })
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* ignore */
      }
    }
  })

  // ── 系统提示词上下文：daemon 现状 + 用量 + 预算 ──────────────────
  if (config.promptContext) {
    ctx.inject(['systemPrompt'], (ctx) => {
      const systemPrompt = ctx.get('systemPrompt', false)
      if (!systemPrompt || typeof systemPrompt.context !== 'function') return
      const stopTimer = promptContext.start()
      const dispose = promptContext.register(systemPrompt)
      return () => {
        try {
          dispose()
        } catch {
          /* ignore */
        }
        stopTimer()
      }
    })
  }

  // 暴露给同进程内的其它部件（Client 路由、后续投影）。
  // 必须走 ctx.provide()：Cordis 的 ctx.set() 只允许写「已声明」的服务，
  // 直接 set 会抛 `cannot set property "manageApi" without provide` 而整插件激活失败。
  ctx.provide('manageApi', {
    manager,
    config,
    runtime,
    log,
    probe: () => probeHealth(config.port),
    streamStats,
    budget: (sessionId) => budget.snapshot(sessionId),
    ingest: () => ingest.snapshot(),
    tools: () => toolsInfo(),
    commands: () => commandInfo(),
    prompt: () => promptContext.current(),
  })
}
