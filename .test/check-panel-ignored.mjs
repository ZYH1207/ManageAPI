/**
 * 「面板忽略名单」自检：settings.panelIgnoredModels 只影响面板视图，不碰路由。
 *
 * 背景：DSH 插件面板有自己的一份忽略模型名单。它以前写的是 settings.ignoredModels，
 * 而那是**路由级**名单——面板里点一下忽略，网关就不再给别的客户端发这个模型，
 * 网页版的比价/决策也跟着变。现在两份分开，本测试把这件事钉死：
 *   1. 面板忽略 → panel 视图里消失，路由视图（不带 panel）里还在；
 *   2. 路由忽略 → 路由视图里消失，panel 视图里还在；
 *   3. 两份名单互不写入对方（ignoredModels 数量不变）；
 *   4. 非法入参（非数组）被 400 拒绝。
 *
 * 用法：node .test/check-panel-ignored.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOCK_PORT = 5111
const APP_PORT = 4396

let failed = 0
function ok(cond, message) {
  if (cond) {
    console.log(`  ✓ ${message}`)
  } else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

const base = `http://127.0.0.1:${APP_PORT}`
async function raw(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
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
const modelKeys = (state) => (state.ranked || []).map((g) => String(g.modelKey))

const HOME = await mkdtemp(join(tmpdir(), 'mapi-panel-'))
const mock = spawn(process.execPath, ['.test/mock-upstream.mjs'], {
  cwd: ROOT,
  env: { ...process.env, MODE: 'good', PORT: String(MOCK_PORT) },
  stdio: 'ignore',
})
const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  cwd: ROOT,
  env: { ...process.env, MANAGE_API_HOME: HOME },
  stdio: 'ignore',
})

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

  // 造一个站 + 两个模型（test-model-a / test-model-b）
  let state = await call('POST', '/api/providers', {
    name: '面板站',
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
  })
  const provider = state.providers.find((p) => p.name === '面板站')
  await call('POST', '/api/credentials', {
    providerId: provider.id,
    label: '主 Key',
    secret: 'sk-panel-test',
  })
  await call('POST', `/api/providers/${provider.id}/sync`, {})
  state = await call('GET', '/api/state')
  ok(state.offers.length >= 2, `同步出 ${state.offers.length} 个供给`)
  // 填价：不填价进 unpriced，ranked 里就没有这几行，比价口径没法验
  for (const offer of state.offers.filter((o) => o.providerId === provider.id)) {
    await call('PATCH', `/api/offers/${offer.id}`, {
      inPrice: 2,
      outPrice: 8,
      currency: 'USD',
      ratio: null,
    })
  }

  console.log('[1] 面板忽略只影响面板视图')
  let panel = await call('GET', '/api/state?panel=1')
  let route = await call('GET', '/api/state')
  const target = modelKeys(panel)[0]
  ok(Boolean(target), `挑中模型 ${target}`)
  await call('PATCH', '/api/settings', { panelIgnoredModels: [target] })
  await new Promise((r) => setTimeout(r, 400))
  panel = await call('GET', '/api/state?panel=1')
  route = await call('GET', '/api/state')
  ok(!modelKeys(panel).includes(target), '面板视图里已隐藏')
  ok(modelKeys(route).includes(target), '路由视图里仍在（网关照发）')
  ok((route.settings.ignoredModels || []).length === 0, '没有写进路由名单 ignoredModels')

  console.log('[2] 路由忽略不影响面板视图')
  // 换另一个模型做路由忽略（第一个已经被面板名单藏起来了，不能用它验“面板仍在”）
  const other = modelKeys(panel).find((k) => k !== target)
  ok(Boolean(other), `挑中第二个模型 ${other}`)
  await call('PATCH', '/api/settings', { ignoredModels: [other] })
  await new Promise((r) => setTimeout(r, 400))
  panel = await call('GET', '/api/state?panel=1')
  route = await call('GET', '/api/state')
  ok(!modelKeys(route).includes(other), '路由视图里已隐藏')
  ok(modelKeys(panel).includes(other), '面板视图里仍在（面板只认自己的名单）')
  ok(
    JSON.stringify(panel.settings.panelIgnoredModels) === JSON.stringify([target]),
    '面板名单没有被路由写入污染',
  )

  console.log('[3] 非法入参被拒绝')
  const bad = await raw('PATCH', '/api/settings', { panelIgnoredModels: 'test-model-a' })
  ok(bad.status === 400, `非数组 → ${bad.status}`)
  ok(typeof bad.data.error === 'string' && bad.data.error.includes('数组'), `错误文案：${bad.data.error}`)
} finally {
  app.kill()
  mock.kill()
  await new Promise((r) => setTimeout(r, 300))
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

if (failed) {
  console.error(`\n✗ ${failed} 项失败`)
  process.exit(1)
}
console.log('\n✓ 面板忽略名单自检通过')
