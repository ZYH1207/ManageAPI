/**
 * B 棒 runtime「定位」：纯计算 + 只读的存在性检查。
 * 不启动进程、不连接端口、不读写数据目录、不解析 profile。
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const PLUGIN_ROOT = resolve(here, '..')
export const BASE_DIR = resolve(PLUGIN_ROOT, '..')
export const DEFAULT_PORT = 4319
export const LOOPBACK_HOST = '127.0.0.1'
export const DAEMON_ENTRY_RELATIVE = join('daemon', 'index.js')
export const RUNTIME_MARKERS = [DAEMON_ENTRY_RELATIVE, join('core', 'store.js')]

/** 冻结：E 棒产物 = $PLUGIN_ROOT/client.js，与 exports["./client"] 一致。 */
export const CLIENT_ENTRY = './client.js'

/** config 的默认值。patch 行是整块替换，键集合不得缺项。 */
export const DEFAULT_CONFIG = Object.freeze({
  autoStart: false,
  attachExisting: false,
  port: DEFAULT_PORT,
  runtimeDir: '',
  dataDir: '',
  waitMs: 10_000,
  apiKey: '',
})

/** 纯函数：只把外部输入收敛成受控值，不读环境、不读文件、不发请求。 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const port = Number(src.port ?? DEFAULT_PORT)
  const waitMs = Number(src.waitMs ?? DEFAULT_CONFIG.waitMs)
  return {
    autoStart: src.autoStart === true,
    attachExisting: src.attachExisting === true,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT,
    runtimeDir: typeof src.runtimeDir === 'string' ? src.runtimeDir.trim() : '',
    dataDir: typeof src.dataDir === 'string' ? src.dataDir.trim() : '',
    waitMs: Number.isFinite(waitMs) && waitMs > 0 ? waitMs : DEFAULT_CONFIG.waitMs,
    apiKey: typeof src.apiKey === 'string' ? src.apiKey.trim() : '',
  }
}

/** 只认「同时有 daemon/index.js 与 core/store.js」的目录；只读 stat。 */
export function isRuntimeDir(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return false
  try {
    return RUNTIME_MARKERS.every((marker) => existsSync(join(dir, marker)))
  } catch {
    return false
  }
}

export function resolveRuntimeDir(configured) {
  const candidates = []
  if (configured) candidates.push({ dir: resolve(String(configured)), source: 'config' })
  candidates.push({ dir: BASE_DIR, source: 'repo' })
  const tried = []
  for (const candidate of candidates) {
    if (isRuntimeDir(candidate.dir)) return { dir: candidate.dir, source: candidate.source, tried }
    tried.push(`${candidate.source}: ${candidate.dir}`)
  }
  return { dir: null, source: null, tried }
}

/** 绝不擅自展开 ~/.manage-api：未显式配置就没有数据目录。 */
export function resolveDataDir(configured) {
  if (typeof configured !== 'string' || configured.trim() === '') return null
  return resolve(configured.trim())
}

export function daemonEntryOf(runtimeDir) {
  return runtimeDir ? join(runtimeDir, DAEMON_ENTRY_RELATIVE) : null
}

export function loopbackBaseUrl(port) {
  return `http://${LOOPBACK_HOST}:${port}`
}

/** 一次性导出定位结果；不发请求、不启动进程。 */
export function buildRuntime(config) {
  const c = normalizeConfig(config)
  const runtime = resolveRuntimeDir(c.runtimeDir)
  return {
    config: c,
    pluginRoot: PLUGIN_ROOT,
    baseDir: BASE_DIR,
    clientEntry: CLIENT_ENTRY,
    runtimeDir: runtime.dir,
    runtimeSource: runtime.source,
    runtimeTried: runtime.tried,
    daemonEntry: daemonEntryOf(runtime.dir),
    dataDir: resolveDataDir(c.dataDir),
    loopbackBaseUrl: loopbackBaseUrl(c.port),
  }
}
