/**
 * B 棒 Host 入口（DSH Cordis plugin，apply 形式；依据本机 references/host-plugin.md）。
 *
 * 交付给 C/D 的唯一 Host 初始化 / cleanup 接口：
 *   createHostLifecycle(ctx, rawConfig) -> HostLifecycle       （初始化）
 *   HostLifecycle.dispose() -> Promise<Snapshot>               （唯一 cleanup，幂等）
 *   HostLifecycle = { ctx, config, runtime, daemon, optional, log, dispose }
 * HOST_KEY 只是同一实例的 ctx 取用键，不是第二套接口；apply 是 DSH 装载入口。
 *
 * 本棒只注册一个生命周期 effect：不注册 tools/commands/prompt/stream/routes。
 * 激活时按 config 建立一次 daemon 连接（不阻塞激活，失败软降级）：
 *   attachExisting=true → daemon.attach()（连已运行的外部 daemon，dispose 绝不停它）
 *   autoStart=true      → daemon.startOwned()（插件自己 spawn）
 *   两者皆 false        → 保持零进程、零连接、零数据访问的默认。
 * 可选服务一律 ctx.get(name, false) 软取，缺服务不阻塞激活。
 */

import { buildRuntime, normalizeConfig } from './lib/runtime.js'
import { createDaemonManager } from './lib/daemon.js'
import { registerIntegration } from './lib/integration/index.js'
import { registerHttpRoutes } from './lib/http-server.js'
import { registerLlmAdapter } from './lib/integration/llm-adapter.js'

export const HOST_KEY = Symbol.for('local/dsh-manage-api/host')
export const INTEGRATION_KEY = Symbol.for('local/dsh-manage-api/integration')

function softGet(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name, false) : undefined
  } catch {
    return undefined
  }
}

function makeLog(ctx) {
  return (...args) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('local-dsh-manage-api') : null
      if (logger && typeof logger.info === 'function') logger.info(...args)
      else console.log('[local-dsh-manage-api]', ...args)
    } catch {
      /* 日志失败不影响生命周期 */
    }
  }
}

/** @param {unknown} rawConfig patch 行 config（整块替换后的值） */
export function createHostLifecycle(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const runtime = buildRuntime(config)
  const log = makeLog(ctx)
  const optional = { webServer: softGet(ctx, 'webServer') }
  const daemon = createDaemonManager({
    port: config.port,
    autoStart: config.autoStart,
    attachExisting: config.attachExisting,
    runtimeDir: runtime.runtimeDir,
    daemonEntry: runtime.daemonEntry,
    dataDir: runtime.dataDir,
    waitMs: config.waitMs,
    log,
  })

  let disposed = false
  async function dispose() {
    if (disposed) return daemon.snapshot()
    disposed = true
    return daemon.dispose()
  }

  return { ctx, config, runtime, daemon, optional, log, dispose }
}

export function apply(ctx, config) {
  ctx.effect(() => {
    const host = createHostLifecycle(ctx, config)
    // 激活时真正执行一次 attach / startOwned，使 daemon.snapshot().mode 反映真实连接状态。
    // fire-and-forget：不 await 阻塞激活；失败 .catch() 吞掉并记日志，激活流程照常继续。
    if (host.config.attachExisting === true) {
      void host.daemon.attach().catch((err) => {
        try { host.log(`daemon.attach 失败（软降级，激活照常继续）：${String(err && err.message ? err.message : err)}`) } catch { /* ignore */ }
      })
    } else if (host.config.autoStart === true) {
      void host.daemon.startOwned().catch((err) => {
        try { host.log(`daemon.startOwned 失败（软降级，激活照常继续）：${String(err && err.message ? err.message : err)}`) } catch { /* ignore */ }
      })
    }
    // D 棒：在 B 生命周期之上挂 DSH 原生接入（tools/commands/prompt/models/stream/ingest/budget）。
    // 软调用：任何注册失败都不应让插件崩溃；集成自身另有一个独立 effect 负责 dispose。
    let integration = null
    try {
      integration = registerIntegration(host)
    } catch (err) {
      try { log(`DSH 集成装配失败（软降级，仅保留生命周期）：${String(err && err.message ? err.message : err)}`) } catch { /* ignore */ }
    }
    // C/E 棒：把 lib/routes.js 的 ROUTES 真正注册到 DSH HTTP 服务器（/api/manage-api/*）。
    //
    // ⚠️ 必须用 ctx.inject 等 webServer 就绪，不能用 ctx.get 一次性探（照抄朋友版
    //    recon/.../lib/index.js:171-180 的时序）：插件激活时机早于 webServer 服务就绪时，
    //    一次性 ctx.get('webServer', false) 返回 undefined，会永久跳过路由注册 ——
    //    表现就是面板一直 401/404，而所有「手动塞好 webServer」的模拟测试全绿。
    // N21：LLM provider 注册必须等 llm 服务就绪（真实 DSH 中插件激活早于服务）。
    // 一次性 ctx.get('llm', false) 会永久漏注册，必须 ctx.inject(['llm'], ...)。
    let disposeLlmAdapter = null
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['llm'], (injectedCtx) => {
          const llm = injectedCtx && typeof injectedCtx.get === 'function'
            ? injectedCtx.get('llm', false)
            : null
          if (!llm) return
          const effect = typeof injectedCtx.effect === 'function' ? injectedCtx.effect : ctx.effect
          return effect(() => {
            try {
              disposeLlmAdapter = registerLlmAdapter({
                ctx: { llm }, config: host.config, runtime: host.runtime, log: host.log,
              })
            } catch (err) {
              try { host.log(`ManageAPI LLM adapter 装配失败（软降级）：${String(err && err.message ? err.message : err)}`) } catch { /* ignore */ }
            }
            return () => { if (disposeLlmAdapter) { try { disposeLlmAdapter() } catch { /* ignore */ } } }
          })
        })
      } catch (err) {
        try { host.log(`ManageAPI LLM adapter ctx.inject 失败（软降级）：${String(err && err.message ? err.message : err)}`) } catch { /* ignore */ }
      }
    } else if (ctx.llm && typeof ctx.llm.registerAdapter === 'function') {
      // 无 ctx.inject 的旧宿主 / 测试假 ctx：服务已直接挂在 ctx 上时才一次性注册。
      try {
        disposeLlmAdapter = registerLlmAdapter({ ctx, config: host.config, runtime: host.runtime, log: host.log })
      } catch (err) {
        try { host.log(`ManageAPI LLM adapter 装配失败（软降级）：${String(err && err.message ? err.message : err)}`) } catch { /* ignore */ }
      }
    }
    let httpRoutes = null
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (injectedCtx) => {
          const ws = injectedCtx && typeof injectedCtx.get === 'function'
            ? injectedCtx.get('webServer', false)
            : null
          if (!ws) return
          const effect = typeof injectedCtx.effect === 'function' ? injectedCtx.effect : ctx.effect
          return effect(() => {
            try {
              httpRoutes = registerHttpRoutes({ webServer: ws, port: host.config.port, log: host.log })
            } catch (err) {
              try { host.log(`/api/manage-api 路由注册失败（软降级，仅保留生命周期）：${String(err && err.message ? err.message : err)}`) } catch { /* ignore */ }
            }
            return () => { if (httpRoutes) { try { httpRoutes.dispose() } catch { /* ignore */ } } }
          })
        })
      } else {
        // 兼容没有 ctx.inject 的环境（旧版 DSH / 测试用假 ctx）：一次性探，拿到就注册。
        httpRoutes = registerHttpRoutes({ webServer: host.optional && host.optional.webServer, port: host.config.port, log: host.log })
      }
    } catch (err) {
      try { host.log(`/api/manage-api 路由注册失败（软降级，仅保留生命周期）：${String(err && err.message ? err.message : err)}`) } catch { /* ignore */ }
    }
    try { ctx[HOST_KEY] = host } catch { /* 只读 ctx：C/D 仍可自行 createHostLifecycle */ }
    if (integration) { try { ctx[INTEGRATION_KEY] = integration } catch { /* ignore */ } }
    return () => {
      try { delete ctx[HOST_KEY] } catch { /* ignore */ }
      try { delete ctx[INTEGRATION_KEY] } catch { /* ignore */ }
      if (httpRoutes) { try { httpRoutes.dispose() } catch { /* ignore */ } }
      if (disposeLlmAdapter) { try { disposeLlmAdapter() } catch { /* ignore */ } }
      if (integration) { try { integration.dispose() } catch { /* ignore */ } }
      void host.dispose().catch(() => {})
    }
  })
}
