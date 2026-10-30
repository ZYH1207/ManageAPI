/**
 * 客户端拨自动路由开关（AutoThink）自检。
 *
 * 需求（2026-10-29 作者）：开启不开启自动路由，供应商那侧能拿到的模型都是
 * 「现在供给的所有模型 + 一个 AutoThink」。客户端点 AutoThink = 请求上游
 * 打开自动路由（网关随即接管）；点别的模型 = 关掉自动路由、就派那一个。
 * 好处是本机换模型不用反复改 Key / 改 base_url。
 *
 * 验的四件事：
 *   1. 纯函数：autoThinkIntent 的名字宽容度、真供给让位、enable/disable 的记账口径
 *   2. 清单：接管与否都出「AutoThink + 全场」（不再接管时只剩一个）
 *   3. 网关：点 AutoThink 开接管并真实改派；点别的模型关接管、派那一个、并钉住
 *   4. 边界：free/ 前缀与 /free 入口永远不接管（不偷偷扣钱）；关接管保留 scope
 *
 * 2026-10-30：客户端拨开关先收起（core/auto-route.js 的 AUTO_ROUTE_CLIENT_SWITCH）。
 * 端到端那几段默认跳过，改验两件事：
 *   - 清单里确实没有 AutoThink；手写 model:AutoThink 也不会偷偷开接管
 *   - 面板开关（PATCH autoRouteEnabled）与 AutoThink 走同一套记账——恢复后行为一致
 * 把常量改回 true 就自动跑回原来的全量断言，不用改测试。
 *
 * 用法：node .test/check-autothink.mjs
 */
import { createServer } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUTO_THINK_MODEL,
  AUTO_ROUTE_CLIENT_SWITCH,
  autoThinkIntent,
  isAutoThinkModel,
  normalizeAutoRoute,
  enableAutoRoute,
  disableAutoRoute,
} from '../core/auto-route.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
const ok = (cond, msg, extra) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}${extra ? `  ← ${extra}` : ''}`)
  }
}

// ============================================================ [1] 纯函数

console.log('[1] 名字判定：宽容写法算，别的模型名不算')
{
  ok(AUTO_THINK_MODEL === 'AutoThink', `虚拟模型名固定是 AutoThink（${AUTO_THINK_MODEL}）`)
  for (const name of ['AutoThink', 'autothink', 'AUTO-THINK', 'auto think', ' AutoThink ']) {
    ok(isAutoThinkModel(name), `「${name}」算 AutoThink`)
  }
  for (const name of ['auto', 'think', 'AutoThinker', 'gpt-4.1', '', null]) {
    ok(!isAutoThinkModel(name), `「${name}」不算`)
  }
}

console.log('[2] 真供给让位：站里真有同名模型时，那个模型优先')
{
  const offer = (upstreamName) => ({ upstreamName, modelKey: upstreamName })
  ok(autoThinkIntent('AutoThink', []) === 'virtual', '没同名真供给 → 虚拟开关')
  ok(autoThinkIntent('AutoThink', [offer('gpt-4.1')]) === 'virtual', '有别的模型但不同名 → 仍算开关')
  ok(
    autoThinkIntent('AutoThink', [offer('gpt-4.1'), offer('autothink')]) === 'real',
    '真有同名供给 → 让开，当普通模型派活',
  )
  // 身份键口径：写法变体也算「同一个模型」，不能让虚拟模型遮住它
  ok(
    autoThinkIntent('AutoThink', [offer('auto-think')]) === 'real',
    '变体写法（auto-think）也算真供给',
  )
  ok(autoThinkIntent('gpt-4.1', [offer('AutoThink')]) === 'real', '别的模型名一律 real')
}

console.log('[3] 开关记账：清挑选记录但保留接管范围')
{
  const settings = {
    autoRoute: {
      enabled: false,
      modelKey: 'm-a',
      offerId: 'o-a1',
      pickedAt: 't0',
      reason: 'gain',
      failoverFrom: 'm-old',
      scope: ['m-b', 'm-c'],
    },
  }
  const on = enableAutoRoute(settings)
  ok(on.enabled === true, 'enableAutoRoute 打开接管')
  ok(on.modelKey === 'm-a', '打开时不动已有挑选记录（界面开关会紧接着 force 重选）')
  ok(JSON.stringify(on.scope) === '["m-b","m-c"]', '打开时范围原样保留')

  const off = disableAutoRoute(settings)
  ok(off.enabled === false, 'disableAutoRoute 关闭接管')
  ok(off.modelKey === null && off.offerId === null && off.reason === null, '关掉清挑选记录（临时状态不留）')
  ok(off.failoverFrom === null, '关掉清故障转移记账')
  ok(JSON.stringify(off.scope) === '["m-b","m-c"]', '关掉保留接管范围（用户勾的偏好，不是接管结果）')

  // 归一化后字段形状不变：前端与老数据都靠这个
  const shape = normalizeAutoRoute(off)
  ok(shape.enabled === false && Array.isArray(shape.scope), '归一化后形状完整')
}

// ============================================================ [4] 端到端

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function killTree(pid) {
  if (!pid) return
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

async function waitFor(fn, { timeoutMs = 15000, stepMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(stepMs)
  }
  throw new Error(`等待超时${last ? `：${last.message}` : ''}`)
}

async function api(base, method, path, body, headers = null) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error || res.status}`)
  return data
}

const home = await mkdtemp(join(tmpdir(), 'mapi-autothink-'))
const mockPort = await freePort()
const home2 = await mkdtemp(join(tmpdir(), 'mapi-autothink2-'))
const mockPort2 = await freePort()
let mock = null
let mock2 = null
let daemon = null
let daemonOut = ''

try {
  // 两个正常站：单价不同，接管后会挑便宜的那个（A 站 1 元 / B 站 5 元）
  mock = spawn(process.execPath, [join(ROOT, '.test/mock-upstream.mjs')], {
    cwd: ROOT,
    env: { ...process.env, MODE: 'good', PORT: String(mockPort) },
    stdio: 'ignore',
  })
  mock2 = spawn(process.execPath, [join(ROOT, '.test/mock-upstream.mjs')], {
    cwd: ROOT,
    env: { ...process.env, MODE: 'good', PORT: String(mockPort2) },
    stdio: 'ignore',
  })

  daemon = spawn(process.execPath, [join(ROOT, 'daemon/index.js'), '--port', String(await freePort())], {
    cwd: ROOT,
    env: {
      ...process.env,
      MANAGE_API_HOME: home,
      MANAGE_API_BACKUP_DIR: join(home, 'backups'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  daemon.stdout.setEncoding('utf8')
  daemon.stderr.setEncoding('utf8')
  daemon.stdout.on('data', (chunk) => (daemonOut += chunk))
  daemon.stderr.on('data', (chunk) => (daemonOut += chunk))

  const base = await waitFor(async () => {
    const hit = daemonOut.match(/http:\/\/127\.0\.0\.1:(\d+)\//)
    if (hit) {
      const url = `http://127.0.0.1:${hit[1]}`
      await api(url, 'GET', '/api/health')
      return url
    }
    return null
  })

  console.log(`\n实例 ${base}（mock ${mockPort} / ${mockPort2}）`)
  // 定时采集与定时探针都关掉：这个用例只验拨开关，不要后台噪声
  await api(base, 'PATCH', '/api/settings', { probeIntervalMinutes: 0, monitorIntervalMinutes: 0 })

  // ---- 建两个站，各一条供给，价格差得远（接管后必然挑便宜的）
  let state = await api(base, 'GET', '/api/state')
  for (const [name, port, price] of [
    ['甲站', mockPort, 1],
    ['乙站', mockPort2, 5],
  ]) {
    await api(base, 'POST', '/api/providers', { name, baseUrl: `http://127.0.0.1:${port}/v1` })
    state = await api(base, 'GET', '/api/state')
    const provider = state.providers.find((p) => p.name === name)
    await api(base, 'POST', '/api/credentials', { providerId: provider.id, label: '默认', secret: 'sk-test' })
    await api(base, 'POST', `/api/providers/${provider.id}/sync`, {})
    state = await api(base, 'GET', '/api/state')
    for (const offer of state.offers.filter((o) => o.providerId === provider.id)) {
      await api(base, 'PATCH', `/api/offers/${offer.id}`, {
        inPrice: price,
        outPrice: price * 2,
        currency: 'CNY',
        ratio: null,
        pricingMode: 'manual',
      })
    }
  }
  state = await api(base, 'GET', '/api/state')
  const key = state.gateway.keys[0].key
  const auth = { Authorization: `Bearer ${key}` }
  const pricey = state.offers.find(
    (o) =>
      o.providerId === state.providers.find((p) => p.name === '乙站').id && o.modelKey === 'test-model-b',
  )

  const listed = async (path = '/v1/models') =>
    (await (await fetch(`${base}${path}`, { headers: auth })).json()).data.map((m) => m.id)
  const chat = async (model, extra = {}) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...extra }),
    })
    return {
      status: res.status,
      text: await res.text(),
      servedModel: decodeURIComponent(res.headers.get('x-manageapi-model') || ''),
      servedProvider: decodeURIComponent(res.headers.get('x-manageapi-provider') || ''),
    }
  }

  console.log('\n[4] 未接管时清单：AutoThink + 全场')
  {
    const ids = await listed()
    if (AUTO_ROUTE_CLIENT_SWITCH) {
      ok(ids[0] === 'AutoThink', `AutoThink 排第一（${ids[0]}）`)
    } else {
      ok(!ids.includes('AutoThink'), `客户端拨开关已收起：清单里没有 AutoThink（${ids.join(', ')}）`)
    }
    ok(ids.includes('test-model-a') && ids.includes('test-model-b'), `全场模型都在（${ids.join(', ')}）`)
    ok(state.autoRoute?.enabled === false, '初始状态自动路由是关的')
  }

  if (!AUTO_ROUTE_CLIENT_SWITCH) {
    console.log('\n[4b] 收起状态下：手写 AutoThink 不能偷偷开接管，面板开关照旧能开')
    {
      const r = await chat('AutoThink')
      ok(r.status !== 200, `手写 model:AutoThink 不生效（HTTP ${r.status}）`)
      state = await api(base, 'GET', '/api/state')
      ok(state.autoRoute?.enabled === false, '请求没把接管打开')
      ok(state.pinnedModelKey === null, '也没把「客户端停在」写成 AutoThink')
      ok(state.virtualAutoThink === false, 'state.virtualAutoThink 报 false（面板不会再写那条提示）')

      // 恢复后要用到的能力全都还在：面板开关能开、能挑、能关
      state = await api(base, 'PATCH', '/api/settings', { autoRouteEnabled: true })
      ok(state.autoRoute?.enabled === true, '面板开关能打开接管（能力没删）')
      ok(Boolean(state.autoRoute?.modelKey), `打开时立刻挑出模型（${state.autoRoute?.modelKey}）`)
      state = await api(base, 'PATCH', '/api/settings', { autoRouteEnabled: false })
      ok(state.autoRoute?.enabled === false, '面板开关能关掉接管')
    }
  }

  if (AUTO_ROUTE_CLIENT_SWITCH) {
    console.log('\n[5] 点 AutoThink：接管打开，这一单就按接管派活')
  {
    const r = await chat('AutoThink')
    ok(r.status === 200, `HTTP ${r.status}`)
    ok(r.servedProvider === '甲站', `派给了便宜的甲站（实际 ${r.servedProvider}）`)
    state = await api(base, 'GET', '/api/state')
    ok(state.autoRoute?.enabled === true, '自动路由已打开')
    ok(Boolean(state.autoRoute?.modelKey), `已挑出现役模型（${state.autoRoute?.modelKey}）`)
    // 接管中清单仍是全量：这是本次改动的核心，以前接管时只剩 AutoThink 一项
    const ids = await listed()
    ok(ids[0] === 'AutoThink' && ids.length >= 3, `接管中清单仍是 AutoThink + 全场（${ids.join(', ')}）`)
  }
  }

  if (AUTO_ROUTE_CLIENT_SWITCH) {
  console.log('\n[6] 接管中点别的模型：关接管、就派那一个、并钉住')
  {
    // 把 test-model-b 钉到乙站：不接管时应该听这个指定，接管时应该听「哪个便宜」。
    // 两边结果不同，才能证明开关真的生效了（同模型在两个站各有一条）
    await api(base, 'POST', `/api/decisions/${encodeURIComponent('test-model-b')}/pick`, {
      offerId: pricey.id,
    })
    const r = await chat('test-model-b')
    ok(r.status === 200, `HTTP ${r.status}`)
    ok(r.servedProvider === '乙站', `按点名走了乙站，而不是接管挑的甲站（实际 ${r.servedProvider}）`)
    state = await api(base, 'GET', '/api/state')
    ok(state.autoRoute?.enabled === false, '自动路由已关闭')
    ok(state.autoRoute?.modelKey === null, '挑选记录已清（不再显示「正在使用」）')
    ok(
      state.pinnedModelKey === 'test-model-b',
      `钉住客户端选的模型（pinnedModelKey=${state.pinnedModelKey}）`,
    )
    // 同一模型再来一单：不接管，仍按点名派活
    const again = await chat('test-model-b')
    ok(again.status === 200 && again.servedProvider === '乙站', `后续请求仍按点名（${again.servedProvider}）`)
  }
  }

  if (AUTO_ROUTE_CLIENT_SWITCH) {
  console.log('\n[7] 解除钉子 + 关接管不丢接管范围')
  {
    state = await api(base, 'PATCH', '/api/settings', { pinnedModelKey: '' })
    ok(!state.pinnedModelKey, '解除后 pinnedModelKey 为空')

    // 勾一个范围，再让客户端拨一次开关，范围必须还在
    await api(base, 'POST', '/api/auto-route/scope', { modelKey: 'test-model-a', enrolled: true })
    state = await api(base, 'GET', '/api/state')
    ok(
      JSON.stringify(state.autoRoute?.scope) === '["test-model-a"]',
      `范围已勾（${JSON.stringify(state.autoRoute?.scope)}）`,
    )
    await chat('AutoThink')
    await chat('test-model-b')
    state = await api(base, 'GET', '/api/state')
    ok(
      JSON.stringify(state.autoRoute?.scope) === '["test-model-a"]',
      `客户端拨开关不动接管范围（${JSON.stringify(state.autoRoute?.scope)}）`,
    )
  }
  }

  if (AUTO_ROUTE_CLIENT_SWITCH) {
  console.log('\n[8] 免费池永不接管：free/ 前缀与 /free 入口')
  {
    // 把乙站那条改成免费：它不在付费池里，接管挑人时看不到它
    await api(base, 'PATCH', `/api/offers/${pricey.id}`, {
      inPrice: 0,
      outPrice: 0,
      currency: 'CNY',
      ratio: null,
      pricingMode: 'manual',
    })
    // 开着接管请求 free/x：不能走接管（否则等于静默扣钱）
    await chat('AutoThink') // 先确保接管是开的
    state = await api(base, 'GET', '/api/state')
    const wasOn = state.autoRoute?.enabled === true
    const r = await chat(`free/${pricey.modelKey}`)
    ok(wasOn, '前置：接管确实开着')
    // 免费池里这个模型存在（乙站那条），状态要么 200 走免费池、要么明确报池空，
    // 但绝不能是「被改派到付费的甲站」——那就是静默扣钱
    ok(
      r.servedProvider !== '甲站',
      `free/ 前缀不会被改派到付费模型（实际 ${r.servedProvider || `HTTP ${r.status}`}）`,
    )
    state = await api(base, 'GET', '/api/state')
    ok(state.autoRoute?.enabled === true, '免费请求不关接管（拨开关只认付费入口）')
  }
  }
} catch (error) {
  failed += 1
  console.error(`\n✗ ${error.message}`)
  if (daemonOut) console.error(daemonOut.slice(-1500))
} finally {
  killTree(daemon?.pid)
  killTree(mock?.pid)
  killTree(mock2?.pid)
  await sleep(200)
  await rm(home, { recursive: true, force: true }).catch(() => {})
  await rm(home2, { recursive: true, force: true }).catch(() => {})
}

process.exitCode = failed ? 1 : 0
console.log(failed ? `\n${failed} 项失败` : '\n全通过')
