#!/usr/bin/env node
/**
 * daemon 启动入口。
 * 用法：node daemon/index.js [--port 4319] [--open]
 */
import { createAppServer, flushGatewayBuffers } from './server.js'
import { dataDir } from '../core/store.js'
import { ensureGatewayKeys } from '../core/inventory.js'
import { acquireInstanceLock } from './instance-lock.js'
import { backupKeep, backupNow, backupRoot, startBackupScheduler } from '../core/backup.js'
import { startProbeScheduler } from './scheduler.js'
import { runProbes } from './probe-runner.js'
import { collectProviderSnapshots } from './monitor-runner.js'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'

const args = process.argv.slice(2)
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return fallback
  const next = args[index + 1]
  return next && !next.startsWith('--') ? next : true
}

const preferredPort = Number(flag('port', process.env.PORT || 4319))
const shouldOpen = Boolean(flag('open', false))
const HOST = '127.0.0.1'

await mkdir(dataDir(), { recursive: true })

/**
 * 先抢实例锁，再碰数据库。
 * 两个进程都先跑 ensureGatewayKeys 的话，空库会被各自写一遍；锁必须在写之前。
 */
const lock = await acquireInstanceLock({ port: preferredPort })
if (lock.conflict) {
  const { pid, port, startedAt } = lock.conflict
  console.error('')
  console.error(`  已有 ManageAPI 实例在运行（PID ${pid}${port ? `，端口 ${port}` : ''}）。`)
  if (startedAt) console.error(`  启动时间 ${startedAt}`)
  console.error(`  为避免两个进程同时写 ${dataDir()}，本次启动已停止。`)
  console.error(`  如果确认旧进程已退出，删除锁文件后重试：${lock.file}`)
  console.error('')
  process.exit(1)
}

// 启动备份必须放在 ensureGatewayKeys 前面：它可能会给空库补网关 Key，
// 那一版不是用户原来的数据，不值得覆盖成「启动快照」。
try {
  const startupBackup = await backupNow({ reason: 'startup', keep: backupKeep() })
  if (startupBackup?.path) console.log(`  启动备份 ${startupBackup.path}`)
} catch (error) {
  console.error('[backup] 启动备份失败：', error)
}

const gateway = await ensureGatewayKeys()

function openBrowser(url) {
  const cmd =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    /* 打不开就算了，地址已经打印出来了 */
  }
}

async function listen(port, attemptsLeft = 10) {
  const server = createAppServer()
  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
        server.close()
        listen(port + 1, attemptsLeft - 1).then(resolve, reject)
        return
      }
      reject(error)
    })
    server.listen(port, HOST, () => resolve({ server, port }))
  })
}

const { server, port } = await listen(preferredPort)
const url = `http://${HOST}:${port}/`

try {
  await lock.update({ port })
} catch (error) {
  console.error('[daemon] 更新锁文件端口失败：', error)
}

const stopBackups = startBackupScheduler({ logger: console })

/**
 * 兜底：定时器、探针、监控采集里漏掉的 rejection 不该让整个守护进程消失。
 * 以前一个没 catch 的 Promise 会让进程直接退出，界面就「连不上本地服务」了。
 */
process.on('unhandledRejection', (reason) => {
  console.error('[daemon] 未处理的 Promise 异常：', reason)
})

/** Ctrl+C / 系统关机时先停服务再退出，避免请求写了一半 */
let closing = false
function shutdown(signal) {
  if (closing) return
  closing = true
  console.log(`\n  收到 ${signal}，正在停止…`)
  stopBackups()
  // 攒批的决策日志/流量计数先冲一次；close 等待期间和强退前再各冲一次（幂等），
  // 不然最后 2-5 秒的成败样本凭空消失，参与评分的可用率会失真
  flushGatewayBuffers()
  server.close(() => {
    flushGatewayBuffers().finally(() => process.exit(0))
  })
  // 有长连接（比如正在流式返回）时 close 会等很久，5 秒后强退
  setTimeout(() => {
    flushGatewayBuffers().finally(() => process.exit(0))
  }, 5000).unref()
}

startProbeScheduler({ runProbes, collectMonitor: collectProviderSnapshots, logger: console })

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal))

console.log('')
console.log('  ManageAPI  已启动')
console.log(`  管理界面 ${url}`)
console.log(`  网关地址 ${url}v1`)
console.log(`  网关 Key ${gateway.enabled ? `${gateway.keys.length} 个（在界面里管理）` : '（已关闭）'}`)
console.log(`  数据目录 ${dataDir()}`)
console.log(`  自动备份 ${backupRoot()}（每天一次，保留 ${backupKeep()} 份）`)
console.log('  停止     Ctrl+C')
console.log('')

if (shouldOpen) openBrowser(url)
