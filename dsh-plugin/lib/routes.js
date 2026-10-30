/**
 * 插件自身的 HTTP 路由（host 半边，挂在插件 webServer 的 `/api/manage-api` 前缀下）。
 *
 * ## 三条原则
 *
 * 1. **只做代理，不做业务**：选站/比价/记账/探针都在 daemon 里，插件不重复实现。
 * 2. **daemon 在跑就以它为准**：不在宿主进程里 import `core/store.js` 造第二份状态
 *    （`mutate()` 只保证进程内串行，跨进程最后写入者覆盖）。daemon 不在时才走只读兜底。
 * 3. **只读兜底用裸 `fs.readFile`**：`db.json` 是 tmp+rename 的原子写产物，读到的一定是完整快照；
 *    不走 `core/store.js` 的 `readDbCached`（它按 mtime+size 判缓存，可能给旧值，且会拉起模块级状态）。
 *
 * ## 安全
 *
 * 全部路由先过 `checkLocalOrigin`（只认回环 + 挡跨站），写操作还要求 JSON content-type。
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { checkLocalOrigin, readJsonBody, sendJson, wantsJson } from './http.js'

const PREFIX = '/api/manage-api'

function dataDir() {
  return process.env.MANAGE_API_HOME || join(homedir(), '.manage-api')
}

/**
 * 直读 db.json（daemon 不在时的只读兜底）。
 */
async function readDbFile() {
  const file = join(dataDir(), 'db.json')
  const text = await readFile(file, 'utf8')
  return JSON.parse(text)
}

/**
 * 会话流式用量快照（`llm/stream` tee 攒在宿主内存里的计数）。
 *
 * 只暴露派生数字，不回传原始 options / chunk：里面可能有 prompt 片段。
 *
 * @param {Map<string, {tokens: number, calls: number, lastAt: number, model: string}>} streamStats
 * @param {string} session 会话 id；空串表示要全部（按最近活跃排序，最多 50 条）
 */
function streamStatsSnapshot(streamStats, session) {
  const entries = streamStats && typeof streamStats.get === 'function'
    ? Array.from(streamStats.entries())
    : []
  if (session) {
    const hit = streamStats && typeof streamStats.get === 'function' ? streamStats.get(session) : null
    return { ok: true, at: new Date().toISOString(), session, stats: hit || null }
  }
  const sessions = entries
    .map(([sessionId, value]) => ({
      sessionId,
      tokens: value.tokens || 0,
      calls: value.calls || 0,
      lastAt: value.lastAt || 0,
      model: value.model || '',
    }))
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
    .slice(0, 50)
  const totals = sessions.reduce(
    (acc, row) => ({ tokens: acc.tokens + row.tokens, calls: acc.calls + row.calls }),
    { tokens: 0, calls: 0 },
  )
  return { ok: true, at: new Date().toISOString(), totals, sessions }
}

/**
 * 转发到 daemon。
 * @param {{ port: number }} options
 * @param {string} pathWithQuery daemon 侧路径，例如 '/api/state?light=1'
 */
async function forwardToDaemon(options, pathWithQuery) {
  const url = `http://127.0.0.1:${options.port}${pathWithQuery}`
  const res = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text.slice(0, 4000) }
  }
  return { status: res.status, body }
}

/**
 * 注册路由。
 *
 * @param {{ webServer: any, manager: any, config: any, log: (...a: any[]) => void }} deps
 * @returns {() => void} disposer 集合
 */
export function registerRoutes(deps) {
  const { webServer, manager, config, log, streamStats, budget, ingest, promptRefresh, promptDebug, toolInfo, commandInfo } = deps
  if (!webServer || typeof webServer.register !== 'function') {
    log('webServer 不可用，跳过 /api/manage-api 路由（面板将拿不到数据）')
    return () => {}
  }

  const disposers = []

  /** @param {(req: any, res: any) => Promise<void>} handler */
  function route(handler) {
    return async (req, res) => {
      const guard = checkLocalOrigin(req)
      if (!guard.ok) {
        sendJson(res, 403, { ok: false, error: `forbidden: ${guard.reason}` })
        return
      }
      if (!wantsJson(req)) {
        sendJson(res, 415, { ok: false, error: '写操作必须用 application/json' })
        return
      }
      try {
        await handler(req, res)
      } catch (err) {
        const message = String(err && err.message ? err.message : err)
        log(`路由异常：${message}`)
        if (!res.writableEnded) sendJson(res, 500, { ok: false, error: message })
      }
    }
  }

  disposers.push(
    webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: route(async (req, res) => {
        const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
        const sub = url.pathname.slice(PREFIX.length).replace(/^\/+/, '')
        const method = String(req.method || 'GET').toUpperCase()

        // ── GET /api/manage-api/health ────────────────────────────────
        if (sub === 'health' && method === 'GET') {
          if (typeof promptRefresh === 'function') promptRefresh()
          const probe = await manager.probe()
          sendJson(res, 200, {
            ok: true,
            plugin: { name: 'dsh-manage-api', version: config.pluginVersion || '0.1.0' },
            daemon: manager.snapshot(),
            probe: probe.ok ? { ok: true, body: probe.body ?? null } : { ok: false, error: probe.error },
            dataDir: dataDir(),
            budget: budget && typeof budget.snapshot === 'function' ? budget.snapshot() : null,
            ingest: ingest && typeof ingest.snapshot === 'function' ? ingest.snapshot() : null,
            tools: typeof toolInfo === 'function' ? toolInfo() : null,
            commands: typeof commandInfo === 'function' ? commandInfo() : null,
            prompt: typeof promptDebug === 'function' ? promptDebug() : null,
            checkedAt: new Date().toISOString(),
          })
          return
        }

        // ── GET /api/manage-api/state ─────────────────────────────────
        if (sub === 'state' && method === 'GET') {
          if (typeof promptRefresh === 'function') promptRefresh()
          const full = url.searchParams.get('full') === '1'
          const snapshot = manager.snapshot()
          if (snapshot.mode === 'owned' || snapshot.mode === 'attached') {
            try {
              const daemonPath = full ? '/api/state' : '/api/state?light=1'
              const result = await forwardToDaemon({ port: config.port }, daemonPath)
              sendJson(res, result.status === 200 ? 200 : result.status, {
                ok: result.status === 200,
                source: 'daemon',
                at: new Date().toISOString(),
                state: result.body,
              })
              return
            } catch (err) {
              log(`转发 /api/state 失败：${String(err && err.message ? err.message : err)}`)
            }
          }
          // 兜底：直读文件（只读）
          try {
            const db = await readDbFile()
            sendJson(res, 200, {
              ok: true,
              source: 'file',
              degraded: true,
              at: new Date().toISOString(),
              state: db,
            })
          } catch (err) {
            sendJson(res, 503, {
              ok: false,
              source: 'none',
              error: `daemon 未运行，且读不到 ${join(dataDir(), 'db.json')}：${String(err && err.message ? err.message : err)}`,
              daemon: manager.snapshot(),
            })
          }
          return
        }

        // ── GET /api/manage-api/stream-stats ─────────────────────────
        // 供会话成本 chip / 用量子页读：宿主内存里的 token 计数，不落盘、不 await。
        if (sub === 'stream-stats' && method === 'GET') {
          sendJson(res, 200, streamStatsSnapshot(streamStats, url.searchParams.get('session') || ''))
          return
        }

        // ── GET /api/manage-api/prompt ───────────────────────────────
        // 诊断用：确认注入系统提示词的文本、刷新时间与 daemon 判定模式。
        if (sub === 'prompt' && method === 'GET') {
          sendJson(res, 200, {
            ok: true,
            at: new Date().toISOString(),
            prompt: promptDebug && typeof promptDebug === 'function' ? promptDebug() : null,
          })
          return
        }

        // ── GET /api/manage-api/budget[?session=] ────────────────────
        // 预算与用量判定：面板、chip 的 title 都从这里读，避免各自算一遍。
        if (sub === 'budget' && method === 'GET') {
          const session = url.searchParams.get('session') || ''
          sendJson(res, 200, {
            ok: true,
            at: new Date().toISOString(),
            session: session || null,
            budget: budget && typeof budget.snapshot === 'function' ? budget.snapshot(session || undefined) : null,
            ingest: ingest && typeof ingest.snapshot === 'function' ? ingest.snapshot() : null,
            tools: typeof toolInfo === 'function' ? toolInfo() : null,
            commands: typeof commandInfo === 'function' ? commandInfo() : null,
            prompt: typeof promptDebug === 'function' ? promptDebug() : null,
          })
          return
        }

        // ── POST /api/manage-api/daemon/{start,stop,restart} ──────────
        const daemonAction = sub.startsWith('daemon/') ? sub.slice('daemon/'.length) : ''
        if (daemonAction && method === 'POST') {
          await readJsonBody(req).catch(() => ({}))
          if (daemonAction === 'start') {
            sendJson(res, 200, { ok: true, daemon: await manager.start() })
            return
          }
          if (daemonAction === 'stop') {
            sendJson(res, 200, { ok: true, daemon: await manager.stop() })
            return
          }
          if (daemonAction === 'restart') {
            sendJson(res, 200, { ok: true, daemon: await manager.restart() })
            return
          }
        }

        sendJson(res, 404, { ok: false, error: `未知路由：${method} ${PREFIX}/${sub}` })
      }),
    }),
  )

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  }
}

export { PREFIX as ROUTE_PREFIX }
