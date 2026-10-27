/**
 * 端到端回归：站点令牌列表返回**带尾随空格的分组名**时，
 * 反复「识别分组 → 同步模型」不能产生重复行。
 *
 * 背景：这曾是真实 bug——syncOffers 去重时 trim 分组名，但 detect-groups
 * 写 offer.group 用原始值（带空格），两者永远对不上，每轮同步多插一整套。
 * 实测修复前 3 个模型 4 轮后变成 15 行。
 *
 * 用法（自包含，会自己起 mock 站和 daemon）：
 *   node .test/run-trailing-space.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')
const MOCK_PORT = 5151
const DAEMON_PORT = 4402
const BASE = `http://127.0.0.1:${DAEMON_PORT}`

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

async function waitReady(url, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

const home = await mkdtemp(join(tmpdir(), 'mapi-trailingspace-'))
const children = []

const spawnNode = (args, env = {}) => {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'ignore',
  })
  children.push(child)
  return child
}

const cleanup = async () => {
  for (const child of children) {
    try {
      child.kill()
    } catch {
      /* 已退出 */
    }
  }
  await rm(home, { recursive: true, force: true })
}

try {
  spawnNode(['.test/mock-trailing-space.mjs'], { PORT: String(MOCK_PORT) })
  spawnNode(['daemon/index.js', '--port', String(DAEMON_PORT)], { MANAGE_API_HOME: home })

  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('daemon 没起来')
  if (!(await waitReady(`http://127.0.0.1:${MOCK_PORT}/v1/models`))) throw new Error('mock 站没起来')

  const api = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`${path}: ${data.error || res.status}`)
    return data
  }

  console.log('[1] 建站 + Key + 令牌')
  let state = await api('POST', '/api/providers', {
    name: '空格分组站',
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
  })
  const provider = state.providers.find((p) => p.name === '空格分组站')
  await api('POST', '/api/credentials', {
    providerId: provider.id,
    label: 'K1',
    secret: 'sk-test-trailing-0001',
  })
  await api('PATCH', `/api/providers/${provider.id}`, { adminToken: 'admin-token-for-test' })

  const rows = (s) => s.offers.filter((o) => o.providerId === provider.id)

  console.log('[2] 首次同步')
  state = await api('POST', `/api/providers/${provider.id}/sync`, {})
  ok(rows(state).length === 3, `3 个模型 → 3 行（实际 ${rows(state).length}）`)

  console.log('[3] 识别分组：站点返回的分组名带尾随空格')
  state = await api('POST', `/api/providers/${provider.id}/detect-groups`, {})
  const groups = [...new Set(rows(state).map((o) => o.group))]
  ok(groups.length === 1, `只有一个分组（实际 ${groups.length}）`)
  ok(groups[0] === groups[0].trim(), `分组名已去尾随空格（${JSON.stringify(groups[0])}）`)

  console.log('[4] 反复「识别分组 + 同步」，不能新增行')
  for (let i = 1; i <= 4; i += 1) {
    await api('POST', `/api/providers/${provider.id}/detect-groups`, {})
    state = await api('POST', `/api/providers/${provider.id}/sync`, {})
    ok(rows(state).length === 3, `第 ${i} 轮后仍是 3 行（实际 ${rows(state).length}）`)
  }

  console.log('[5] 归一化后没有重复组合')
  const seen = new Set()
  let dups = 0
  for (const o of rows(state)) {
    const k = `${o.group}|${o.upstreamName}`
    if (seen.has(k)) dups += 1
    else seen.add(k)
  }
  ok(dups === 0, `无重复 (分组,模型) 组合（重复 ${dups} 条）`)
} finally {
  await cleanup()
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}
