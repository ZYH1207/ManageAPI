/**
 * 勾选压过「忽略模型」：手动勾的那一条必须真的收到流量（端到端，自包含）。
 *
 * 用户 2026-11-12 的原话：
 *   「我单独放出来的站点，应该不受到模型忽略影响。我手动勾选把它开启了，
 *     然后这个时候忽略模型不应该能挡掉它们的流量。也就是它应该是生效的。」
 *
 * 语义边界（都在这里钉住）：
 *   · 勾选的那一条 → 越过忽略名单，网关必须派给它
 *   · 同模型的**其他**供给 → 仍然被忽略挡住（忽略名单没失效）
 *   · 站点暂停 / 已下线 → 压过勾选，救不回来
 *
 * 用例：两个站各一条 test-model-a。把 model-a 整类忽略，然后勾选乙站那条。
 * 期望：网关派给乙站；甲站那条始终不参与。
 *
 * 用法：node .test/check-pin-overrides-ignore.mjs
 *   MAPI_ROOT=<另一个工作树> node .test/check-pin-overrides-ignore.mjs  # 验改动前的红
 */
import { createServer } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.MAPI_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
const ok = (cond, msg, extra) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}${extra ? `  ← ${extra}` : ''}`)
  }
}

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
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* 已经退出 */
  }
  spawnSync('kill', ['-KILL', String(pid)], { stdio: 'ignore' })
}

async function waitFor(fn, { timeoutMs = 25000, stepMs = 200 } = {}) {
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

async function api(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error || res.status}`)
  return data
}

const home = await mkdtemp(join(tmpdir(), 'mapi-pin-ignore-'))
const portA = await freePort()
const portB = await freePort()
const children = []
let daemonOut = ''

try {
  for (const port of [portA, portB]) {
    children.push(spawn(process.execPath, [join(ROOT, '.test/mock-upstream.mjs')], {
      cwd: ROOT,
      env: { ...process.env, MODE: 'good', PORT: String(port) },
      stdio: 'ignore',
    }))
  }

  const daemon = spawn(process.execPath, [join(ROOT, 'daemon/index.js'), '--port', String(await freePort())], {
    cwd: ROOT,
    env: { ...process.env, MANAGE_API_HOME: home, MANAGE_API_BACKUP_DIR: join(home, 'backups') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(daemon)
  daemon.stdout.setEncoding('utf8')
  daemon.stderr.setEncoding('utf8')
  daemon.stdout.on('data', (c) => (daemonOut += c))
  daemon.stderr.on('data', (c) => (daemonOut += c))

  const base = await waitFor(async () => {
    const hit = daemonOut.match(/http:\/\/127\.0\.0\.1:(\d+)\//)
    if (!hit) return null
    const url = `http://127.0.0.1:${hit[1]}`
    await api(url, 'GET', '/api/health')
    return url
  })
  console.log(`\n实例 ${base}（甲站 ${portA} / 乙站 ${portB}）`)

  await api(base, 'PATCH', '/api/settings', {
    probeIntervalMinutes: 0,
    monitorIntervalMinutes: 0,
    lockFailover: 'none',
  })

  let state = await api(base, 'GET', '/api/state')
  for (const [name, port, price] of [['甲站', portA, 1], ['乙站', portB, 5]]) {
    await api(base, 'POST', '/api/providers', { name, baseUrl: `http://127.0.0.1:${port}/v1` })
    state = await api(base, 'GET', '/api/state')
    const provider = state.providers.find((p) => p.name === name)
    await api(base, 'POST', '/api/credentials', { providerId: provider.id, label: '默认', secret: 'sk-test' })
    await api(base, 'POST', `/api/providers/${provider.id}/sync`, {})
    state = await api(base, 'GET', '/api/state')
    for (const offer of state.offers.filter((o) => o.providerId === provider.id)) {
      await api(base, 'PATCH', `/api/offers/${offer.id}`, {
        inPrice: price, outPrice: price * 2, currency: 'USD', ratio: null, pricingMode: 'manual',
      })
    }
  }

  state = await api(base, 'GET', '/api/state')
  const key = state.gateway.keys.find((k) => k.enabled)?.key
  const auth = { Authorization: `Bearer ${key}` }
  const offerOf = (name) => {
    const pid = state.providers.find((p) => p.name === name).id
    return state.offers.find((o) => o.providerId === pid && o.modelKey === 'test-model-a')
  }
  const offerA = offerOf('甲站') // 便宜但没被勾选
  const offerB = offerOf('乙站') // 贵，将被勾选
  ok(Boolean(offerA && offerB), '两站各有一条 test-model-a')

  const chat = async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({
        model: 'test-model-a',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8,
        stream: true,
      }),
    })
    await res.text()
    return {
      status: res.status,
      provider: decodeURIComponent(res.headers.get('x-manageapi-provider') || ''),
    }
  }

  console.log('\n[1] 把 test-model-a 整类忽略：两条供给都该离场')
  {
    state = await api(base, 'PATCH', '/api/settings', { ignoredModels: ['test-model-a'] })
    const liveIds = state.offers.filter((o) => o.modelKey === 'test-model-a').map((o) => o.id)
    ok(liveIds.length === 0, `忽略后 test-model-a 不在在役清单里（实际 ${liveIds.join(',') || '空'}）`)
    const r = await chat()
    ok(r.status !== 200, `此时请求该失败（HTTP ${r.status}）`)
  }

  console.log('\n[2] 勾选乙站那条 → 忽略名单不该再挡它的流量')
  {
    state = await api(base, 'POST', `/api/decisions/${encodeURIComponent('test-model-a')}/pick`, {
      offerId: offerB.id,
    })
    const d = state.decisions.find((x) => x.modelKey === 'test-model-a')
    ok(d?.pinnedOfferId === offerB.id, `决策页记下勾选（${d?.pinnedOfferId}）`)
    ok(d?.pinnedApplied === true, 'pinnedApplied = true（不再报「勾选未生效」）')
    ok(d?.pinnedState?.state === 'ok', `勾选状态 ok（实际 ${d?.pinnedState?.state}）`)
    ok(d?.chosenOfferId === offerB.id, `当前选就是勾选那条（${d?.chosenOfferId}）`)

    const r = await chat()
    ok(r.status === 200, `请求成功（HTTP ${r.status}）`)
    ok(r.provider === '乙站', `派给了勾选的乙站（实际 ${r.provider}）`)
  }

  console.log('\n[3] 同模型的另一条仍被忽略挡住：不会被勾选顺带放开')
  {
    state = await api(base, 'GET', '/api/state')
    const d = state.decisions.find((x) => x.modelKey === 'test-model-a')
    const ids = (d?.candidates || []).map((c) => c.offerId)
    ok(ids.includes(offerB.id), '勾选那条在候选里')
    ok(!ids.includes(offerA.id), '没勾选的甲站那条仍被忽略挡住')
  }

  console.log('\n[4] 暂停站点压过勾选：救不回来')
  {
    const pid = state.providers.find((p) => p.name === '乙站').id
    await api(base, 'PATCH', `/api/providers/${pid}`, { paused: true })
    state = await api(base, 'GET', '/api/state')
    // 站一停，这一组的供给全不在役 → 决策页整组消失（不是「这一组显示没有可用供给」）。
    // 所以这里不该断言 decisions 里那一条的状态，而是断言「行为」：
    // 不再有候选、请求走不通、且不会偷偷派给暂停的站。
    const d = state.decisions.find((x) => x.modelKey === 'test-model-a')
    ok(!d || (d.candidates || []).length === 0, '暂停后这一组没有任何候选（组可能整块消失）')
    const r = await chat()
    ok(r.status !== 200, `请求失败（HTTP ${r.status}）`)
    ok(r.provider !== '乙站', `没有派给暂停的乙站（实际 ${r.provider || '无'}）`)
  }
} finally {
  for (const child of children.reverse()) killTree(child.pid)
  await rm(home, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? '✓ 全部通过' : `✗ ${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
