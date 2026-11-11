/**
 * 「页面说没人能用」与「网关照派」必须同时成立或同时不成立（端到端，自包含）。
 *
 * 背景（2026-11-12，与勾选那批同族）：
 *   决策页挑「当前选」原来是自己筛 `admission.ok && !faulted`，而网关走
 *   core/fallback-ladder.js 的兜底阶梯——准入没过但「偏慢 / 无证据 / 降级 /
 *   冷却已过」的供给**照样会被派出去**（设计原则：报错是最后手段）。
 *   于是页面写「没有可用供给」，网关却在正常派活。
 *
 * 这个用例只造一条供给，并把它压进「偏慢」这一级（首字超出门槛）：
 *   A. 页面必须仍然给出一个「当前选」（不是「没有可用供给」）
 *   B. 网关必须真的派活，且派的就是页面写的那条
 *   C. 首字门槛放到 20s（不再算慢）后，两边仍然是同一条
 *
 * 用法：node .test/check-winner-parity.mjs
 *   MAPI_ROOT=<另一个工作树> node .test/check-winner-parity.mjs  # 验改动前的红
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

const home = await mkdtemp(join(tmpdir(), 'mapi-winner-'))
const slowPort = await freePort()
const children = []
let daemonOut = ''

try {
  // 只有一个站，且故意很慢（首字 ~900ms 会超出门槛，落进「偏慢但可用」级）
  children.push(spawn(process.execPath, [join(ROOT, '.test/mock-upstream.mjs')], {
    cwd: ROOT,
    env: { ...process.env, MODE: 'good', PORT: String(slowPort), DELAY: '2500' },
    stdio: 'ignore',
  }))

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
  console.log(`\n实例 ${base}（唯一慢站 ${slowPort}）`)

  // 门槛压到 1ms 级别 → 这条供给必然算「慢」；关掉后台噪声
  await api(base, 'PATCH', '/api/settings', {
    probeIntervalMinutes: 0,
    monitorIntervalMinutes: 0,
    // 慢速门槛最小档是 1000ms（core/latency.js#snapTtftMs 会把 300 吸附成 0=不限），
    // 所以这条供给的首字必须真的超过 1000ms 才会被判「慢」。mock 的 DELAY 设 2500ms。
    maxTtftMs: 1000,
    lockFailover: 'none',
  })

  let state = await api(base, 'GET', '/api/state')
  await api(base, 'POST', '/api/providers', { name: '唯一慢站', baseUrl: `http://127.0.0.1:${slowPort}/v1` })
  state = await api(base, 'GET', '/api/state')
  const provider = state.providers.find((p) => p.name === '唯一慢站')
  await api(base, 'POST', '/api/credentials', { providerId: provider.id, label: '默认', secret: 'sk-test' })
  await api(base, 'POST', `/api/providers/${provider.id}/sync`, {})
  state = await api(base, 'GET', '/api/state')
  const offer = state.offers.find((o) => o.providerId === provider.id && o.modelKey === 'test-model-a')
  ok(Boolean(offer), '站里有一条 test-model-a 供给')
  await api(base, 'PATCH', `/api/offers/${offer.id}`, {
    inPrice: 1, outPrice: 2, currency: 'USD', ratio: null, pricingMode: 'manual',
  })

  const key = state.gateway.keys.find((k) => k.enabled)?.key
  const auth = { Authorization: `Bearer ${key}` }
  const chat = async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({
        model: 'test-model-a',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 16,
        stream: true,
      }),
    })
    await res.text()
    return {
      status: res.status,
      provider: decodeURIComponent(res.headers.get('x-manageapi-provider') || ''),
    }
  }
  const decisionOf = (st) => st.decisions.find((d) => d.modelKey === 'test-model-a')

  // 先打两单攒真实首字（900ms > 300ms 门槛 → 会被判「慢」）。
  // 注意：真实首字落盘后，准入判定读的是 realTtftMs，而 tooSlow 只看探针口径的
  // ttftMs（core/router.js#admissionOf）。只有探针跑过才有 ttftMs，所以这里显式
  // 触发一次探针，否则这条供给会一直是「准入通过」，测的就不是「慢」这条路。
  for (let i = 0; i < 2; i += 1) await chat()
  // 点名探这一条：不传 offerIds 的话 runProbes 会按 limit 挑目标，不保证挑到它
  await api(base, 'POST', '/api/probes/run', { offerIds: [offer.id] })
  await sleep(6000) // 流量攒批写盘 5s + 探针落盘

  console.log('\n[A] 唯一供给被判「偏慢」：页面仍要给当前选，不能写「没有可用供给」')
  {
    state = await api(base, 'GET', '/api/state')
    const d = decisionOf(state)
    const cand = d.candidates.find((c) => c.offerId === offer.id)
    ok(cand?.admission?.ok === false, `这条供给准入没过（kind=${cand?.admission?.kind}）`, JSON.stringify(cand?.admission))
    ok(
      Boolean(d.chosenOfferId),
      `页面仍给出当前选（chosen=${d.chosenOfferId}）——改动前这里是 null，界面写「没有可用供给」`,
    )
    ok(d.chosenOfferId === offer.id, '当前选就是这条唯一供给')
  }

  console.log('\n[B] 网关照常派活，且派的就是页面写的那条')
  {
    const r = await chat()
    ok(r.status === 200, `HTTP ${r.status}`)
    ok(r.provider === '唯一慢站', `派给了它（实际 ${r.provider}）`)
    state = await api(base, 'GET', '/api/state')
    ok(decisionOf(state).chosenOfferId === offer.id, '页面与网关同一条——本用例判据')
  }

  console.log('\n[C] 放宽门槛（不再算慢）：两边仍是同一条')
  {
    await api(base, 'PATCH', '/api/settings', { maxTtftMs: 20000 })
    state = await api(base, 'GET', '/api/state')
    const d = decisionOf(state)
    const cand = d.candidates.find((c) => c.offerId === offer.id)
    ok(cand?.admission?.ok === true, `准入恢复（kind=${cand?.admission?.kind ?? 'null'}）`)
    ok(d.chosenOfferId === offer.id, '当前选仍是它')
    const r = await chat()
    ok(r.provider === '唯一慢站', `网关仍派它（${r.provider}）`)
  }
} finally {
  for (const child of children.reverse()) killTree(child.pid)
  await rm(home, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? '✓ 全部通过' : `✗ ${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
