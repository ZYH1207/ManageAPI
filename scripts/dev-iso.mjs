#!/usr/bin/env node
/**
 * 隔离的本地开发实例：端口、数据目录、备份目录都落在当前工作树的 .test-data/ 下。
 *
 *   node scripts/dev-iso.mjs           # 起服务
 *   node scripts/dev-iso.mjs --setup   # 只准备目录和端口（Orbit 建完工作树后调用）
 *   node scripts/dev-iso.mjs --open    # 起服务并打开浏览器
 *
 * 为什么需要：两个 worktree 同时起 daemon 会都往 ~/.manage-api/db.json 写，
 * 后写的把先写的整份覆盖（见 daemon/instance-lock.js 开头）。端口被占用时
 * daemon 会自动往后找，所以「只换端口」挡不住共用数据库，必须连数据目录一起隔离。
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const setupOnly = process.argv.includes('--setup')
const shouldOpen = process.argv.includes('--open')

const base = process.cwd()
const devDir = join(base, '.test-data') // 已在 .gitignore 里，不会进版本控制
const portFile = join(devDir, 'dev-port')
const home = join(devDir, 'dev-home')
const backups = join(devDir, 'dev-backups')

await mkdir(home, { recursive: true })
await mkdir(backups, { recursive: true })

let port = 0
try {
  port = Number((await readFile(portFile, 'utf8')).trim())
} catch {
  /* 还没分配过 */
}

if (!Number.isInteger(port) || port < 1) {
  // 按工作树路径算一个固定端口：同一个工作树永远是同一个端口，两个工作树天然错开
  const hash = createHash('sha1').update(base).digest()
  port = 4400 + (hash[0] % 100)
  await writeFile(portFile, String(port))
}

console.log(`[dev] 工作树 ${base}`)
console.log(`[dev] 端口   ${port}`)
console.log(`[dev] 数据   ${home}`)
console.log(`[dev] 备份   ${backups}`)

if (setupOnly) process.exit(0)

const args = ['daemon/index.js', '--port', String(port)]
if (shouldOpen) args.push('--open')

console.log(`[dev] 管理界面 http://127.0.0.1:${port}/`)

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    MANAGE_API_HOME: home,
    MANAGE_API_BACKUP_DIR: backups,
  },
})

child.on('exit', (code) => process.exit(code ?? 0))
