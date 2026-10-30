/**
 * daemon 生命周期管理（host 半边）。
 *
 * ## 状态机
 *
 *   down ──probe ok──────────────▶ attached   （用户自己开着 daemon：不抢锁、不写库、退出时不动它）
 *   down ──probe fail──spawn────▶ starting ──health ok──▶ owned
 *                                        └─exit 1 + 锁冲突文案──▶ attached
 *                                        └─超时/异常──▶ failed
 *
 * ## 为什么必须区分 attached / owned
 *
 * `daemon/instance-lock.js` 的语义是「一台机器只能有一个写者」。用户自己起的 daemon 必须先被
 * 认出来（`GET /api/health`），否则我们 spawn 的子进程会因锁冲突退出；反过来，卸载时也**只能**
 * 停掉自己起的那个（owned），停用户的 daemon 属于越权。
 *
 * ## 为什么不 fork / 不用 node 子进程池
 *
 * DSH 宿主跑在 Electron 里：`process.execPath` 是 electron 可执行文件，直接 spawn 会弹出第二个
 * 应用窗口。必须带 `ELECTRON_RUN_AS_NODE=1` 让它以纯 Node 模式跑 daemon/index.js。
 */

import { spawn } from 'node:child_process'
import { daemonEntry } from './runtime.js'

const LOOPBACK = '127.0.0.1'

/**
 * 探活：daemon 的 /api/health。
 * @param {number} port
 * @param {number} [timeoutMs]
 */
export async function probeHealth(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://${LOOPBACK}:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = await res.json().catch(() => null)
    return { ok: true, body }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
}

/** 锁冲突时 daemon 打到 stderr 的文案（daemon/index.js 里 process.exit(1) 前那一句）。 */
const LOCK_CONFLICT_PATTERN = /已有 ManageAPI 实例在运行/

/**
 * 读 daemon 的一个 GET 接口。
 * 只用于「顺手拿一下数据」的路径（面板、工具、提示词上下文），失败一律返回 {ok:false}，
 * 绝不让调用方因为 daemon 没起来拿到异常。
 * @param {number} port
 * @param {string} path 以 / 开头的路径（不含 origin）
 * @param {number} [timeoutMs]
 */
export async function daemonGet(port, path, timeoutMs = 4000) {
  try {
    const res = await fetch(`http://${LOOPBACK}:${port}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, status: res.status, error: body?.error || `HTTP ${res.status}` }
    return { ok: true, status: res.status, body }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
}

/**
 * 写 daemon 的一个 POST 接口。
 * daemon 的变更类接口强制要求 application/json（CSRF 防护），这里必须带上。
 * @param {number} port
 * @param {string} path
 * @param {unknown} payload
 * @param {number} [timeoutMs]
 */
export async function daemonPost(port, path, payload, timeoutMs = 6000) {
  try {
    const res = await fetch(`http://${LOOPBACK}:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, status: res.status, error: body?.error || `HTTP ${res.status}` }
    return { ok: true, status: res.status, body }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
}


/**
 * @param {{
 *   port: number,
 *   autoStart: boolean,
 *   runtimeDir: string|null,
 *   runtimeSource: string|null,
 *   waitMs?: number,
 *   flushOnDispose?: boolean,
 *   log: (...args: any[]) => void,
 * }} options
 */
export function createDaemonManager(options) {
  const { port, autoStart, runtimeDir, runtimeSource, log } = options
  const waitMs = options.waitMs ?? 10_000
  const flushOnDispose = options.flushOnDispose ?? true

  /** @type {'down'|'starting'|'owned'|'attached'|'failed'} */
  let mode = 'down'
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null
  let pid = null
  let lastError = ''
  let stderrTail = ''
  let startPromise = null
  let disposed = false

  function snapshot() {
    return {
      mode,
      pid,
      port,
      runtimeDir,
      runtimeSource,
      lastError,
      disposed,
    }
  }

  function noteStderr(chunk) {
    stderrTail = (stderrTail + String(chunk)).slice(-4096)
  }

  async function waitForHealth(deadline) {
    while (Date.now() < deadline) {
      if (disposed) return false
      const health = await probeHealth(port, 1200)
      if (health.ok) return true
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return false
  }

  /**
   * 启动（或认出已在跑的）daemon。重复调用是幂等的：并发调用共享同一个 promise。
   */
  async function start() {
    if (disposed) return snapshot()
    if (mode === 'owned' || mode === 'attached') {
      // 记录里说「在跑」不等于现在还在跑：用户可能手动关掉了、进程也可能崩了。
      // 探一下，确认不可达就重置状态继续走 spawn，避免插件永远停在 attached 不动。
      const health = await probeHealth(port)
      if (health.ok) return snapshot()
      log(`记录的 daemon 已不可达（mode=${mode}，${health.error || 'probe failed'}），重置后重新启动`)
      child = null
      pid = null
      mode = 'down'
      lastError = ''
    }
    if (startPromise) return startPromise

    startPromise = (async () => {
      // 1) 已经有人在跑 → attach，绝不 spawn（否则必然锁冲突）
      const existing = await probeHealth(port)
      if (existing.ok) {
        mode = 'attached'
        log(`attach 到已有 daemon（127.0.0.1:${port}）`)
        return snapshot()
      }

      if (!autoStart) {
        mode = 'down'
        lastError = 'autoStart 关闭，且没有已运行的 daemon'
        return snapshot()
      }
      if (!runtimeDir) {
        mode = 'failed'
        lastError = '找不到 ManageAPI 运行时目录'
        return snapshot()
      }

      // 2) 自己起一个
      mode = 'starting'
      stderrTail = ''
      const entry = daemonEntry(runtimeDir)
      log(`spawn daemon: ${entry} --port ${port}`)
      try {
        child = spawn(process.execPath, [entry, '--port', String(port), '--parent-watch'], {
          cwd: runtimeDir,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (err) {
        mode = 'failed'
        lastError = `spawn 失败：${String(err && err.message ? err.message : err)}`
        return snapshot()
      }

      pid = child.pid ?? null
      child.stdout?.on('data', (chunk) => log(String(chunk).trim()))
      child.stderr?.on('data', (chunk) => noteStderr(chunk))
      child.once('error', (err) => {
        lastError = `子进程错误：${String(err && err.message ? err.message : err)}`
      })
      child.once('exit', (code, signal) => {
        const wasOwned = mode === 'owned' || mode === 'starting'
        child = null
        pid = null
        if (disposed) return
        if (code === 1 && LOCK_CONFLICT_PATTERN.test(stderrTail)) {
          mode = 'attached'
          log('子进程报告实例锁被占 → 转为 attached')
          return
        }
        if (wasOwned) {
          mode = 'failed'
          lastError = `daemon 退出 code=${code} signal=${signal || '-'}${stderrTail ? `；stderr: ${stderrTail.slice(-300)}` : ''}`
          log(lastError)
        }
      })

      const ready = await waitForHealth(Date.now() + waitMs)
      if (ready) {
        mode = 'owned'
        lastError = ''
        log(`daemon 就绪（PID ${pid}，127.0.0.1:${port}）`)
        return snapshot()
      }
      // 超时；可能刚好撞上别人的锁（exit 事件需要一点时间）
      if (mode === 'owned' || mode === 'attached') return snapshot()
      mode = 'failed'
      lastError = lastError || `等待 /api/health 超时（${waitMs}ms）`
      return snapshot()
    })()

    try {
      return await startPromise
    } finally {
      startPromise = null
    }
  }

  async function stop() {
    const proc = child
    if (!proc) {
      mode = mode === 'owned' ? 'down' : mode
      return snapshot()
    }
    log(`停止 daemon（PID ${proc.pid}）`)
    await new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      proc.once('exit', done)
      try {
        // 关 stdin：daemon 侧 --parent-watch 会自退；没有该参数也无害
        proc.stdin?.end()
      } catch {
        /* ignore */
      }
      try {
        proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (settled) return
        try {
          proc.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        done()
      }, 5000)
    })
    child = null
    pid = null
    mode = 'down'
    return snapshot()
  }

  async function restart() {
    await stop()
    return start()
  }

  async function dispose() {
    disposed = true
    if (mode === 'owned') {
      if (flushOnDispose) {
        // SIGTERM 会让 daemon 走 shutdown() → flushGatewayBuffers()，不额外调 HTTP。
        log('dispose：停止自己启动的 daemon')
      }
      await stop()
    } else {
      log(`dispose：mode=${mode}，不触碰 daemon`)
    }
  }

  /** 探活并顺手纠正陈旧状态（面板/健康检查每次都调它）。 */
  async function probe() {
    const health = await probeHealth(port)
    if (!health.ok && (mode === 'attached')) {
      mode = 'down'
      lastError = `daemon 不可达：${health.error || 'probe failed'}`
    }
    return health
  }

  return { start, stop, restart, dispose, snapshot, probe }
}
