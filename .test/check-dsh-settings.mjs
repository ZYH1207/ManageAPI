/**
 * DSH 插件设置键（settings.dshFreeModels）自检：端到端一层。
 *
 * 背景：dsh-manage-api 插件「免费页 → 接入免费模型」开关走 PATCH /api/settings 落库。
 * applySettingsPatch 只认白名单键，漏登记时插件的写入会被静默丢弃（界面开了、刷新又回去）。
 * 本测试把「dshFreeModels 能写进 db.settings 并在 /api/state 里下发」钉死：
 *   1. true / false 来回切，值持久化并在 state.settings 下发；
 *   2. 非布尔被 400 拒绝，且不影响已有值；
 *   3. 补丁里不带该键时不清掉已有值（其他设置补丁不误伤）。
 *
 * 用法：node .test/check-dsh-settings.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
function ok(cond, message) {
  if (cond) {
    console.log(`  ✓ ${message}`)
  } else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

console.log('[1] 端到端：dshFreeModels 经 PATCH /api/settings 持久化')
const HOME = await mkdtemp(join(tmpdir(), 'mapi-dsh-'))
const APP_PORT = 4395

const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  cwd: ROOT,
  env: { ...process.env, MANAGE_API_HOME: HOME },
  stdio: 'ignore',
})
const base = `http://127.0.0.1:${APP_PORT}`

async function raw(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

async function call(method, path, body) {
  const r = await raw(method, path, body)
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.data)}`)
  return r.data
}

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) break
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150))
  }

  // 开：写入并在 state 下发
  let state = await call('PATCH', '/api/settings', { dshFreeModels: true })
  ok(state.settings.dshFreeModels === true, 'PATCH true 后 state.settings.dshFreeModels === true')

  // 其他键的补丁不误伤已有值
  state = await call('PATCH', '/api/settings', { ignoredModels: [] })
  ok(state.settings.dshFreeModels === true, '不带该键的补丁不清掉已有值')

  // 关
  state = await call('PATCH', '/api/settings', { dshFreeModels: false })
  ok(state.settings.dshFreeModels === false, 'PATCH false 后落库为 false')

  // 非布尔拒绝（400），且保持原值
  for (const bad of ['yes', 1, null, ['true']]) {
    const r = await raw('PATCH', '/api/settings', { dshFreeModels: bad })
    ok(r.status === 400, `非法值 ${JSON.stringify(bad)} 被 400 拒绝（得到 ${r.status}）`)
  }
  state = await call('GET', '/api/state')
  ok(state.settings.dshFreeModels === false, '被拒绝的补丁不影响已有值')

  // db 里真的落了盘（重启动也不丢）
  const { readFile } = await import('node:fs/promises')
  const db = JSON.parse(await readFile(join(HOME, 'db.json'), 'utf8'))
  ok(db.settings.dshFreeModels === false, '值写入 db.json（重启不丢）')
} finally {
  app.kill()
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

console.log('')
if (failed) {
  console.error(`✗ ${failed} 项失败`)
  process.exit(1)
}
console.log('✓ 全部通过')
