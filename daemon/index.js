#!/usr/bin/env node
/**
 * daemon 启动入口。
 * 用法：node daemon/index.js [--port 4319] [--open]
 */
import { createAppServer } from './server.js'
import { dataDir } from '../core/store.js'
import { ensureGatewayKeys } from '../core/inventory.js'
import { startProbeScheduler } from './scheduler.js'
import { runProbes } from './probe-runner.js'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'

await mkdir(dataDir(), { recursive: true })
const gateway = await ensureGatewayKeys()

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

const { port } = await listen(preferredPort)
const url = `http://${HOST}:${port}/`

startProbeScheduler({ runProbes, logger: console })

console.log('')
console.log('  ManageAPI  已启动')
console.log(`  管理界面 ${url}`)
console.log(`  网关地址 ${url}v1`)
console.log(`  网关 Key ${gateway.enabled ? `${gateway.keys.length} 个（在界面里管理）` : '（已关闭）'}`)
console.log(`  数据目录 ${dataDir()}`)
console.log('  停止     Ctrl+C')
console.log('')

if (shouldOpen) openBrowser(url)
