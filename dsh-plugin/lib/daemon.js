/**
 * B 棒 daemon 生命周期状态机。
 *
 *   down --attach() 探活成功--> attached   外部 daemon：dispose 绝不停它
 *   down --startOwned() 守卫通过--> starting --health ok--> owned
 *   owned/starting --dispose()--> down     只停插件自己 spawn 的进程
 *   attached --dispose()--> down           仅清本地标记，不 kill、不发停止请求
 *
 * 默认：createDaemonManager() 不 fetch、不 spawn、不占端口、不碰数据目录。
 * owned spawn 强制要求 autoStart=true + 绝对隔离 dataDir（注入 MANAGE_API_HOME），
 * 并拒绝 ~/.manage-api，避免插件进程写到真实数据。
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { LOOPBACK_HOST } from './runtime.js'

export const MODES = Object.freeze(['down', 'starting', 'owned', 'attached', 'failed'])
export const OWNERSHIP = Object.freeze({ OWNED: 'owned', ATTACHED: 'attached', NONE: 'none' })

/** attach / owned 的唯一判定入口。starting 也算 owned，避免 spawn 后超时漏停孤儿进程。 */
export function ownershipOf(state) {
  const mode = typeof state === 'string' ? state : state && state.mode
  if (mode === 'owned' || mode === 'starting') return OWNERSHIP.OWNED
  if (mode === 'attached') return OWNERSHIP.ATTACHED
  return OWNERSHIP.NONE
}

export const isAttached = (state) => ownershipOf(state) === OWNERSHIP.ATTACHED
export const isOwned = (state) => ownershipOf(state) === OWNERSHIP.OWNED

/** 仅在显式调用时发请求；构造 manager 不会调用它。 */
export async function probeHealth(port, timeoutMs = 1500, host = LOOPBACK_HOST) {
  try {
    const res = await fetch(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, body: await res.json().catch(() => null) }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
}

/**
 * @param {{port?:number, autoStart?:boolean, attachExisting?:boolean,
 *          runtimeDir?:string|null, daemonEntry?:string|null, dataDir?:string|null,
 *          waitMs?:number, log?:(...args:unknown[])=>void}} [options]
 */
export function createDaemonManager(options = {}) {
  const {
    port = 4319,
    autoStart = false,
    attachExisting = false,
    runtimeDir = null,
    daemonEntry = null,
    dataDir = null,
    waitMs = 10_000,
    log = () => {},
    spawnImpl = spawn,
    probeImpl = probeHealth,
  } = options

  /** @type {'down'|'starting'|'owned'|'attached'|'failed'} */
  let mode = 'down'
  let child = null
  let pid = null
  let disposed = false
  let lastError = ''

  const snapshot = () => ({
    mode,
    ownership: ownershipOf(mode),
    pid,
    port,
    runtimeDir,
    dataDir,
    disposed,
    lastError,
  })

  function guardOwnedStart() {
    if (disposed) return 'manager 已 dispose'
    if (!autoStart) return 'autoStart=false：拒绝 spawn（默认不启动任何进程）'
    if (!runtimeDir || !daemonEntry) return '未定位到 ManageAPI 运行时目录'
    if (!dataDir || !isAbsolute(dataDir)) return 'dataDir 必须是绝对路径的隔离目录'
    if (dataDir === join(homedir(), '.manage-api')) return '拒绝使用真实数据目录 ~/.manage-api'
    return ''
  }

  async function waitForHealth(deadline) {
    while (Date.now() < deadline) {
      if (disposed) return false
      const health = await probeImpl(port, 1200)
      if (health.ok) return true
      await new Promise((done) => setTimeout(done, 250))
    }
    return false
  }

  /** 连到用户/外部已运行的 daemon。成功后 ownership=attached，dispose 绝不停它。 */
  async function attach() {
    if (disposed) return snapshot()
    if (!attachExisting) {
      lastError = 'attachExisting=false：拒绝主动连接外部 daemon'
      return snapshot()
    }
    const health = await probeImpl(port)
    if (!health.ok) {
      lastError = `attach 失败：${health.error || 'probe failed'}`
      return snapshot()
    }
    child = null
    pid = null
    mode = 'attached'
    lastError = ''
    log(`attach 到外部 daemon（${LOOPBACK_HOST}:${port}）；dispose 不会停止它`)
    return snapshot()
  }

  /** 插件自己 spawn 的实例。只有全部守卫通过才会真正创建子进程。 */
  async function startOwned() {
    if (mode === 'owned' || mode === 'starting') return snapshot()
    const reason = guardOwnedStart()
    if (reason) {
      mode = 'failed'
      lastError = reason
      return snapshot()
    }
    mode = 'starting'
    try {
      child = spawnImpl(process.execPath, [daemonEntry, '--port', String(port)], {
        cwd: runtimeDir,
        env: { ...process.env, MANAGE_API_HOME: dataDir, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      mode = 'failed'
      lastError = `spawn 失败：${String(err && err.message ? err.message : err)}`
      return snapshot()
    }
    pid = child.pid ?? null
    child.once('exit', (code) => {
      child = null
      pid = null
      if (!disposed && ownershipOf(mode) === OWNERSHIP.OWNED) {
        mode = 'failed'
        lastError = `owned daemon 退出 code=${code}`
      }
    })

    const ready = await waitForHealth(Date.now() + waitMs)
    if (ready) {
      mode = 'owned'
      lastError = ''
      return snapshot()
    }
    // 超时/异常时状态可能已成 failed，仍必须回收自己 spawn 的子进程，不留孤儿。
    const failure = mode === 'starting' ? `等待 /api/health 超时（${waitMs}ms）` : lastError
    await stop()
    mode = 'failed'
    lastError = failure
    return snapshot()
  }

  /**
   * 唯一允许 kill 的分支。
   * 不变量：child 只在 startOwned 的 spawn 里被赋值；attach() 强制 child=null。
   * 因此以 child 判定而不以 mode 判定，状态漂移到 failed 也不会漏停 owned 子进程，
   * attached 也绝不可能被误停。
   */
  async function stop() {
    if (!child) {
      if (mode === 'attached') log('attached：stop() 不触碰外部 daemon')
      else mode = 'down'
      return snapshot()
    }
    const proc = child
    log(`停止 owned daemon（PID ${proc.pid}）`)
    await new Promise((done) => {
      let settled = false
      let timer
      const finish = () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        done()
      }
      proc.once('exit', finish)
      try { proc.stdin?.end() } catch { /* ignore */ }
      try { proc.kill('SIGTERM') } catch { finish() }
      // 5 秒兜底：SIGTERM 不退就 SIGKILL，保证 dispose 不会永久挂住。
      timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* ignore */ }
        finish()
      }, 5000)
    })
    child = null
    pid = null
    mode = 'down'
    return snapshot()
  }

  /** 唯一 cleanup：stop() 只认 owned spawn 的 child；attached 只清本地标记。 */
  async function dispose() {
    disposed = true
    const before = ownershipOf(mode)
    if (before === OWNERSHIP.OWNED) log('dispose：清理插件自己启动的 owned daemon')
    if (before === OWNERSHIP.ATTACHED) log('dispose：mode=attached，绝不停止用户/外部 daemon')
    await stop()
    child = null
    pid = null
    mode = 'down'
    return snapshot()
  }

  return {
    attach,
    startOwned,
    stop,
    dispose,
    snapshot,
    probe: () => probeImpl(port),
    ownership: () => ownershipOf(mode),
  }
}
