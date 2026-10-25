/**
 * 自动备份：把数据目录里的关键文件复制到项目外的时间戳目录。
 *
 * 只把 db.json 复制过去是不够的——凭据用 master.key 加密，少了它备份里的
 * Key 全部解不开。所以这里固定同时备份 master.key 以及几份旁路数据。
 *
 * 默认目录：数据目录的同级 `manage-api-backups/`（例如 ~/manage-api-backups/）。
 * 这个位置在仓库外，不会被 git clean / 重新 clone 带走。
 * 可用 MANAGE_API_BACKUP_DIR 覆盖，MANAGE_API_BACKUP_KEEP 改保留数量。
 */
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataDir } from './store.js'
import { writeJsonAtomic } from './fsx.js'

// master.key（明文模式）与 master.key.enc（主密码模式）二选一存在，
// 不存在的自动跳过——两者必须随备份一起走，否则恢复后 Key 解不开
const FILES = ['db.json', 'master.key', 'master.key.enc', 'benchmark.json', 'free.json', 'usage.json']
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}_\d{6}(?:-\d+)?$/

let inFlight = null

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export function backupRoot() {
  const custom = process.env.MANAGE_API_BACKUP_DIR
  if (custom && custom.trim()) return custom.trim()
  return join(dirname(dataDir()), 'manage-api-backups')
}

export function backupKeep() {
  const value = Number(process.env.MANAGE_API_BACKUP_KEEP)
  if (Number.isInteger(value) && value > 0) return Math.min(value, 365)
  return 30
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

async function uniqueDir(root, date) {
  const base = join(root, stamp(date))
  if (!(await exists(base))) return base
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`
    if (!(await exists(candidate))) return candidate
  }
  throw new Error(`备份目录重名过多：${base}`)
}

async function prune(root, keep) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory() && BACKUP_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  for (const name of dirs.slice(0, Math.max(0, dirs.length - keep))) {
    await rm(join(root, name), { recursive: true, force: true }).catch(() => {})
  }
}

async function doBackup({ reason = 'manual', keep = backupKeep() } = {}) {
  const source = dataDir()
  const dbFile = join(source, 'db.json')
  if (!(await exists(dbFile))) {
    return { skipped: 'db.json 不存在，还没有可备份的数据' }
  }

  // 只跳过「刚生成、没有任何业务内容、也没有密钥」的空库；
  // 解析失败时仍然复制，坏文件本身可能是恢复线索。
  let parsed = null
  try {
    parsed = JSON.parse(await readFile(dbFile, 'utf8'))
  } catch {
    parsed = null
  }
  const empty =
    parsed &&
    !parsed.providers?.length &&
    !parsed.credentials?.length &&
    !parsed.offers?.length &&
    !parsed.probes?.length
  if (
    empty &&
    !(await exists(join(source, 'master.key'))) &&
    !(await exists(join(source, 'master.key.enc')))
  ) {
    return { skipped: '当前是空库，跳过备份' }
  }

  const root = backupRoot()
  await mkdir(root, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700).catch(() => {})

  const target = await uniqueDir(root, new Date())
  await mkdir(target, { mode: 0o700 })

  const files = []
  for (const name of FILES) {
    const from = join(source, name)
    if (!(await exists(from))) continue
    const to = join(target, name)
    await copyFile(from, to)
    await chmod(to, 0o600).catch(() => {})
    const info = await stat(to)
    files.push({ name, size: info.size })
  }

  if (!files.length) {
    await rm(target, { recursive: true, force: true }).catch(() => {})
    return { skipped: '没有可复制的文件' }
  }

  await writeJsonAtomic(
    join(target, 'manifest.json'),
    {
      createdAt: new Date().toISOString(),
      reason,
      source,
      files,
    },
    2,
  )
  await chmod(join(target, 'manifest.json'), 0o600).catch(() => {})
  await prune(root, keep)

  return { path: target, files, root, keep }
}

/**
 * 立即备份。并发调用会复用同一个任务，避免启动备份和定时备份同时复制。
 */
export function backupNow(options = {}) {
  if (inFlight) return inFlight
  inFlight = doBackup(options).finally(() => {
    inFlight = null
  })
  return inFlight
}

/**
 * 每 24 小时备份一次。启动时的那次由 daemon/index.js 单独调用。
 * 返回停止函数，便于测试和优雅退出。
 */
export function startBackupScheduler({ intervalMs = 24 * 60 * 60 * 1000, logger = console } = {}) {
  const timer = setInterval(async () => {
    try {
      const result = await backupNow({ reason: 'daily' })
      if (result?.path) logger.log(`[backup] 每日备份完成：${result.path}`)
    } catch (error) {
      logger.error('[backup] 每日备份失败：', error)
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
