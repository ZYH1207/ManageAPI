/**
 * 单实例锁：同一个数据目录只允许一个 daemon。
 *
 * 为什么需要：两个实例会各自启动定时采集、探针和网关，并且都往同一个
 * `db.json` 里写，后写的会把先写的整份覆盖。端口会自动往后找，所以
 * 「换一个端口」并不能阻止它们共用数据目录。
 *
 * 锁文件里记 PID、端口和启动时间。进程崩溃后 PID 不再存活，下一次启动
 * 会把它当作失效锁清理掉，不需要用户手工删。
 */
import { chmod, link, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../core/store.js'
import { writeJsonAtomic } from '../core/fsx.js'

const LOCK_NAME = 'daemon.lock'
const MAX_ATTEMPTS = 6

export function lockPath() {
  return join(dataDir(), LOCK_NAME)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Windows 上对「存在但无权限查询」的进程会返回 EPERM；它仍然是活的。
    return error?.code === 'EPERM'
  }
}

async function readLock(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (!parsed || !Number.isInteger(parsed.pid)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 先写临时文件，再用硬链接原子地「占位」。
 * 这样别的进程读到的锁文件要么不存在，要么内容完整，不会读到写了一半的 JSON。
 */
async function createLock(file, payload) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(payload), { mode: 0o600 })
  try {
    await link(tmp, file)
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

function releaseSync(file) {
  try {
    const current = JSON.parse(readFileSync(file, 'utf8'))
    if (current.pid === process.pid) unlinkSync(file)
  } catch {
    /* 文件不在了或已损坏，交给下次启动处理 */
  }
}

/**
 * 获取锁。成功返回句柄；被占用返回 { conflict }。
 *
 * @param {{ port?: number|null }} options
 */
export async function acquireInstanceLock({ port = null } = {}) {
  const file = lockPath()
  const payload = {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (await createLock(file, payload)) {
      await chmod(file, 0o600).catch(() => {})
      process.once('exit', () => releaseSync(file))

      return {
        file,
        pid: process.pid,
        async update(patch) {
          const current = await readLock(file)
          if (!current || current.pid !== process.pid) return false
          await writeJsonAtomic(file, { ...current, ...patch })
          await chmod(file, 0o600).catch(() => {})
          return true
        },
        async release() {
          const current = await readLock(file)
          if (!current || current.pid === process.pid) await unlink(file).catch(() => {})
        },
      }
    }

    const existing = await readLock(file)
    if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
      return { file, conflict: existing }
    }
    if (existing && existing.pid === process.pid) {
      // 同一进程重复获取（测试或异常重入），按冲突处理，避免自己覆盖自己。
      return { file, conflict: existing }
    }

    // 读到的是空文件/坏 JSON：可能是另一个进程刚创建锁、还没写完。
    // 先等一拍；超过 2 秒仍不可读，才当作上次崩溃留下的垃圾清掉。
    await sleep(120)
    const current = await readLock(file)
    if (current) {
      if (current.pid !== process.pid && pidAlive(current.pid)) return { file, conflict: current }
      if (current.pid === process.pid) return { file, conflict: current }
      await unlink(file).catch(() => {})
      continue
    }
    const info = await stat(file).catch(() => null)
    if (info && Date.now() - info.mtimeMs > 2000) await unlink(file).catch(() => {})
  }

  throw new Error(`无法获取实例锁：${file}（可能被其他进程占用）`)
}
