#!/usr/bin/env node
/**
 * 验收实例：给作者「看得见」的独立端口，跑的是真实数据的一份**只读副本**。
 *
 *   node scripts/demo.mjs            起验收实例（默认端口 4319+100 = 4419 起找空位）
 *   node scripts/demo.mjs --port 4420
 *   node scripts/demo.mjs --fresh    不带数据（空实例，验证首次上手）
 *   node scripts/demo.mjs --stop     停掉正在跑的验收实例
 *   node scripts/demo.mjs --status   看它在不在
 *
 * ## 为什么必须单独一个端口
 *
 * 生产实例固定 4319，作者点开 http://127.0.0.1:4319/ 看到的是**正在跑的旧代码**
 * （改完前端要刷新才生效，改完后端要重启才生效）。验收时必须另起一个端口，
 * 打开它才是「此刻这份代码」的样子。
 *
 * ## 为什么必须复制数据目录
 *
 * `daemon/instance-lock.js` 明确禁止同一个数据目录起两个 daemon——两个实例会
 * 各自跑定时采集/探针，并且都往同一个 db.json 写，后写的覆盖先写的。
 * 端口往后找也挡不住这点。所以验收实例必须有自己的 MANAGE_API_HOME。
 *
 * 复制而不是软链：验收时随手点几个开关（切档、开自动路由、改倍率）就会写库，
 * 落到真实数据上等于污染。复制一份，怎么点都无所谓，退出即弃。
 *
 * ## 数据新鲜度
 *
 * 每次启动都重新复制，所以看到的站点/凭据/用量都是启动那一刻的真实状态。
 * `master.key` 一起复制——没有它 db.json 里的 Key 全部解不开，验收会看到
 * 一堆「解密失败」，那是假故障。
 */

import { spawn } from 'node:child_process'
import { copyFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag, fallback = null) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}

const repoRoot = process.cwd()
const prodHome = process.env.MANAGE_API_PROD_HOME || join(homedir(), '.manage-api')
const demoRoot = join(repoRoot, '.test-data', 'demo')
const demoHome = join(demoRoot, 'home')
const demoBackups = join(demoRoot, 'backups')
const stateFile = join(demoRoot, 'port')

/** 端口探活：能连上就是被占 */
function portFree(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (free) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(free)
    }
    socket.setTimeout(400)
    socket.once('connect', () => done(false))
    socket.once('error', () => done(true))
    socket.once('timeout', () => done(true))
  })
}

async function findPort(preferred) {
  // 默认从 4419 起：离生产的 4319 够远，不会被 daemon 自己的 +1 顺延撞上
  let port = Number(preferred) || 4419
  for (let i = 0; i < 40; i += 1) {
    if (await portFree(port)) return port
    port += 1
  }
  throw new Error('连续 40 个端口都被占用，先清理一下再试')
}

async function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'))
  } catch {
    return null
  }
}

/** --stop：只杀自己记下来的那个 pid，绝不按名字乱杀 */
if (has('--stop')) {
  const state = await readState()
  if (!state?.pid) {
    console.log('[demo] 没有正在运行的验收实例')
    process.exit(0)
  }
  if (await pidAlive(state.pid)) {
    try {
      process.kill(state.pid, 'SIGTERM')
      console.log(`[demo] 已停止验收实例 pid=${state.pid}（端口 ${state.port}）`)
    } catch (error) {
      console.error(`[demo] 停止失败：${error.message}`)
      process.exit(1)
    }
  } else {
    console.log('[demo] 记录的实例已经不在了')
  }
  await rm(stateFile, { force: true })
  process.exit(0)
}

/** --status：验收实例还活着吗 */
if (has('--status')) {
  const state = await readState()
  if (!state?.pid) {
    console.log('[demo] 未运行')
    process.exit(1)
  }
  const alive = await pidAlive(state.pid)
  console.log(`[demo] ${alive ? '运行中' : '已退出'} pid=${state.pid} 端口=${state.port}`)
  if (alive) console.log(`[demo] http://127.0.0.1:${state.port}/`)
  process.exit(alive ? 0 : 1)
}

// ---------------------------------------------------------------- 起实例

await mkdir(demoHome, { recursive: true })
await mkdir(demoBackups, { recursive: true })

const fresh = has('--fresh')

if (fresh) {
  // 空实例：验证「一个全新用户第一次打开」的路径
  await rm(demoHome, { recursive: true, force: true })
  await mkdir(demoHome, { recursive: true })
  console.log('[demo] --fresh：空数据实例（不复制生产数据）')
} else {
  // master.key 必须一起复制：没有它，db.json 里所有上游 Key 都解不开，
  // 验收会看到满屏「解密失败」——那是假故障，不是代码坏了
  const files = ['db.json', 'master.key', 'benchmark.json', 'probe-spend.json', 'usage.json']
  let copied = 0
  for (const name of files) {
    const from = join(prodHome, name)
    if (!existsSync(from)) continue
    await copyFile(from, join(demoHome, name))
    copied += 1
  }
  if (copied === 0) {
    console.error(`[demo] 生产数据目录里没东西可复制：${prodHome}`)
    console.error('[demo] 想验证空实例用 --fresh；想验证真实数据先确认生产实例跑过。')
    process.exit(1)
  }
  // 用量明细目录也带上（诊断页/用量页要看）
  const detailFrom = join(prodHome, 'usage-detail')
  if (existsSync(detailFrom)) {
    await rm(join(demoHome, 'usage-detail'), { recursive: true, force: true })
    const { cp } = await import('node:fs/promises')
    await cp(detailFrom, join(demoHome, 'usage-detail'), { recursive: true }).catch(() => {})
  }
  console.log(`[demo] 已复制生产数据 ${copied} 个文件到验收目录（真实数据只读副本，随便点）`)
}

// 已经有一个验收实例在跑：**直接复用**，不要重复启动。
//
// 为什么不能无脑重启：同一个数据目录只允许一个 daemon（instance-lock.js），
// 新起的那个会报「已有实例在运行」然后自己退出，而作者看到的是「地址连不上」。
// 想换一份数据（重新复制生产库）才需要 --restart。
const prev = await readState()
if (prev?.pid && (await pidAlive(prev.pid)) && !has('--restart')) {
  const alive = await portFree(prev.port).then((free) => !free)
  if (alive) {
    console.log('')
    console.log(`  验收实例已经在跑：http://127.0.0.1:${prev.port}/`)
    console.log(`  （要重新复制数据并重启：node scripts/demo.mjs --restart）`)
    console.log('')
    process.exit(0)
  }
  // 进程在但端口不通：状态已经不对了，继续往下走重新起
  console.log(`[demo] 记录的 pid=${prev.pid} 还在但端口不通，重启它`)
}

if (prev?.pid && (await pidAlive(prev.pid))) {
  try {
    process.kill(prev.pid, 'SIGTERM')
    console.log(`[demo] 停掉上一次的验收实例 pid=${prev.pid}`)
    await new Promise((r) => setTimeout(r, 1500))
  } catch {
    /* 已经没了 */
  }
}

const port = await findPort(valueOf('--port'))

// stdio 不能 inherit：父进程（这个脚本）退出后，子进程接着往已经关闭的
// 终端写日志会 EPIPE 把自己弄死（实测：启动 20 秒后实例自己退了）。
// 所以日志落到文件，出问题时能看。
const logPath = join(demoRoot, 'daemon.log')
const logFile = await open(logPath, 'a')
const logFd = logFile.fd
const child = spawn(
  process.execPath,
  ['daemon/index.js', '--port', String(port)],
  {
    cwd: repoRoot,
    // 完全脱离：脚本退出后实例继续活着，关终端也不影响
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      MANAGE_API_HOME: demoHome,
      MANAGE_API_BACKUP_DIR: demoBackups,
      // 验收实例不该往生产实例的诊断里写故障上报（两份数据，别串）
      MANAGE_API_NO_REPORT: '1',
    },
  },
)
child.unref()
// 只是关掉父进程这一份 fd，子进程继承的那份仍然有效
await logFile.close().catch(() => {})

await writeFile(stateFile, JSON.stringify({ pid: child.pid, port, at: new Date().toISOString() }))

console.log('')
console.log(`  ╔═══════════════════════════════════════════════════════╗`)
console.log(`  ║  验收实例（这份代码 / 这份数据）                       ║`)
console.log(`  ║                                                       ║`)
console.log(`  ║  http://127.0.0.1:${String(port).padEnd(36)}║`)
console.log(`  ║                                                       ║`)
console.log(`  ║  停：node scripts/demo.mjs --stop                      ║`)
console.log(`  ╚═══════════════════════════════════════════════════════╝`)
console.log('')
console.log(`[demo] 数据 ${demoHome}`)
console.log(`[demo] 生产实例仍在 4319，互不影响`)