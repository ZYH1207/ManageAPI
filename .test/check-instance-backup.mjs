/**
 * 单实例锁 + 自动备份的本地检查。
 * 全程使用临时数据目录，不碰真实的 ~/.manage-api。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'manageapi-instance-backup-'))
process.env.MANAGE_API_HOME = join(root, 'data')
process.env.MANAGE_API_BACKUP_DIR = join(root, 'backups')
process.env.MANAGE_API_BACKUP_KEEP = '2'

const { emptyDb, encryptSecret, writeDb } = await import('../core/store.js')
const { backupNow, backupRoot } = await import('../core/backup.js')
const { acquireInstanceLock, lockPath } = await import('../daemon/instance-lock.js')

try {
  const db = emptyDb()
  db.providers.push({ id: 'p_test', name: '测试站', baseUrl: 'https://example.com/v1' })
  db.credentials.push({
    id: 'c_test',
    providerId: 'p_test',
    name: '测试 Key',
    secret: await encryptSecret('sk-test-123'),
  })
  await writeDb(db)

  const first = await backupNow({ reason: 'test' })
  assert.ok(first.path, '备份应返回目录')
  assert.equal(backupRoot(), process.env.MANAGE_API_BACKUP_DIR)
  const names = (await readdir(first.path)).sort()
  assert.deepEqual(names, ['db.json', 'manifest.json', 'master.key'])
  assert.equal((await readFile(join(first.path, 'master.key'), 'utf8')).trim().length, 64)

  const manifest = JSON.parse(await readFile(join(first.path, 'manifest.json'), 'utf8'))
  assert.equal(manifest.reason, 'test')
  assert.equal(manifest.files.length, 2)

  await backupNow({ reason: 'test-2', keep: 2 })
  await backupNow({ reason: 'test-3', keep: 2 })
  const dirs = (await readdir(process.env.MANAGE_API_BACKUP_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
  assert.equal(dirs.length, 2, '保留策略应只留下 keep 份')

  const firstLock = await acquireInstanceLock({ port: 4567 })
  assert.ok(firstLock.file, '第一次应拿到锁')
  assert.ok(existsSync(firstLock.file))

  const conflict = await acquireInstanceLock({ port: 4568 })
  assert.equal(conflict.conflict?.pid, process.pid, '第二个实例应被拒')

  await firstLock.release()
  assert.equal(existsSync(lockPath()), false, '释放后锁文件应删除')

  // 模拟上次崩溃留下的失效 PID：应自动清理并成功获取。
  await writeFile(lockPath(), JSON.stringify({ pid: 999999, port: 1, startedAt: new Date().toISOString() }))
  const secondLock = await acquireInstanceLock({ port: 4569 })
  assert.ok(secondLock.file, '失效锁应被清理')
  await secondLock.release()

  console.log('instance lock + backup: ok')
} finally {
  await rm(root, { recursive: true, force: true })
}
