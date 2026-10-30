/**
 * ManageAPI 运行时定位（host 半边）。
 *
 * ## 为什么需要「定位」而不是写死路径
 *
 * 插件有三种落地形态，路径各不相同：
 *
 *   1. **npm 依赖**（正式形态）：插件依赖 `manage-api@^0.3.0`，
 *      由 `createRequire(import.meta.url).resolve('manage-api/package.json')` 找到包根。
 *   2. **内嵌运行时**（兜底）：打包时把仓库的 `core/` + `daemon/` 拷进 `runtime/`。
 *   3. **同仓开发**：`dsh-plugin/` 与仓库根同级，直接指向仓库根即可。
 *
 * 另外允许配置项 `runtimeDir` 覆盖全部（开发期最常用，也方便用户指向别的副本）。
 *
 * ## 判定条件
 *
 * 只认「同时存在 `daemon/index.js` 与 `core/store.js`」的目录：
 * 光有 daemon/ 可能是别的项目，光有 core/ 跑不起来。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const requireFromHere = createRequire(import.meta.url)

/**
 * 这个目录是不是一个完整的 ManageAPI 运行时？
 * @param {unknown} dir
 * @returns {boolean}
 */
export function isRuntimeDir(dir) {
  if (!dir || typeof dir !== 'string') return false
  try {
    return existsSync(join(dir, 'daemon', 'index.js')) && existsSync(join(dir, 'core', 'store.js'))
  } catch {
    return false
  }
}

/**
 * 按优先级定位运行时目录。
 * @param {string|undefined} configured 配置项 runtimeDir
 * @returns {{ dir: string|null, source: string|null, tried: string[] }}
 */
export function resolveRuntimeDir(configured) {
  /** @type {Array<[string, string]>} */
  const candidates = []
  const tried = []

  if (configured) candidates.push([String(configured), 'config'])

  try {
    const pkgPath = requireFromHere.resolve('manage-api/package.json')
    candidates.push([dirname(pkgPath), 'dependency'])
  } catch {
    tried.push('dependency: manage-api 不可解析')
  }

  candidates.push([join(here, '..', 'runtime'), 'embedded'])
  candidates.push([join(here, '..', '..'), 'repo'])

  for (const [dir, source] of candidates) {
    if (isRuntimeDir(dir)) return { dir, source, tried }
    tried.push(`${source}: ${dir}`)
  }
  return { dir: null, source: null, tried }
}

/**
 * 运行时目录里的 daemon 入口。
 * @param {string} runtimeDir
 */
export function daemonEntry(runtimeDir) {
  return join(runtimeDir, 'daemon', 'index.js')
}

export { here as pluginLibDir }
