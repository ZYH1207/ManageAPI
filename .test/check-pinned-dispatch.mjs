/**
 * 人工勾选必须真的被派活（端到端，自包含）。
 *
 * 现场（2026-11-12）：决策页手动勾的是秋的「国模-007」，网关用量一直走「国模-0055」。
 * 页面写着「当前选 007」，网关却派 0055，两边对不上。
 *
 * 根因：勾选那条因为真实流量失败率过高被标成 blocked，`decideRoute` 的兜底阶梯
 * 把它当硬失败踢出尝试链，之后 `applyPinnedChoice` 在链里找不到它 → 静默回退到
 * 自动排序第一名。日志只留一句「[锁定转移] … 未应用（pin-not-in-chain）」。
 *
 * 这个用例用两个真 mock 站复现整条链路：
 *   甲站（MODE=fail，503）被勾选 → 前 20 单先撞它、失败后转到乙站，攒够失败率；
 *   第 21 单起它被标 blocked —— 此时网关必须**仍然**先派它。
 *
 * 判据（第 21 单起）：
 *   · 最终仍是 200（勾选失败后按 lockFailover 转移，不把整单打死）
 *   · X-ManageAPI-Attempts ≥ 2 —— 说明真的先撞了勾选那条，不是直接派别人
 *   · 路由日志最后一条 attempts ≥ 2
 *
 * 用法：node .test/check-pinned-dispatch.mjs
 *   MAPI_ROOT=<另一个工作树> node .test/check-pinned-dispatch.mjs  # 用来验改动前的红
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

async function waitFor(fn, { timeoutMs = 20000, stepMs = 150 } = {}) {
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

const home = await mkdtemp(join(tmpdir(), 'mapi-pin-'))
const failPort = await freePort()
const goodPort = await freePort()
const children = []
let daemonOut = ''

try {
  // 甲站会挂（chat 一律 503），乙站正常。两站都列出 test-model-a / test-model-b
  children.push(spawn(process.execPath, [join(ROOT, '.test/mock-upstream.mjs')], {
    cwd: ROOT,
    env: { ...process.env, MODE: 'fail', PORT: String(failPort) },
    stdio: 'ignore',
  }))
  children.push(spawn(process.execPath, [join(ROOT, '.test/mock-upstream.mjs')], {
    cwd: ROOT,
    env: { ...process.env, MODE: 'good', PORT: String(goodPort) },
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
  console.log(`\n实例 ${base}（挂站 ${failPort} / 正常站 ${goodPort}）`)

  // 关掉定时采集与探针：这个用例只验勾选派活，不要后台噪声
  await api(base, 'PATCH', '/api/settings', {
    probeIntervalMinutes: 0,
    monitorIntervalMinutes: 0,
    // 勾选那条失败后按同模型最低价转移——不这样的话默认档「不转移」会把 503 直接交给客户端
    lockFailover: 'model-price',
  })

  let state = await api(base, 'GET', '/api/state')
  for (const [name, port] of [['甲站会挂', failPort], ['乙站正常', goodPort]]) {
    await api(base, 'POST', '/api/providers', { name, baseUrl: `http://127.0.0.1:${port}/v1` })
    state = await api(base, 'GET', '/api/state')
    const provider = state.providers.find((p) => p.name === name)
    await api(base, 'POST', '/api/credentials', { providerId: provider.id, label: '默认', secret: 'sk-test' })
    await api(base, 'POST', `/api/providers/${provider.id}/sync`, {})
    state = await api(base, 'GET', '/api/state')
    for (const offer of state.offers.filter((o) => o.providerId === provider.id)) {
      await api(base, 'PATCH', `/api/offers/${offer.id}`, {
        inPrice: 1, outPrice: 2, currency: 'USD', ratio: null, pricingMode: 'manual',
      })
    }
  }

  state = await api(base, 'GET', '/api/state')
  const key = state.gateway.keys.find((k) => k.enabled)?.key
  const auth = { Authorization: `Bearer ${key}` }
  const failProvider = state.providers.find((p) => p.name === '甲站会挂')
  const pinnedOffer = state.offers.find((o) => o.providerId === failProvider.id && o.modelKey === 'test-model-a')
  const goodOffer = state.offers.find(
    (o) => o.providerId === state.providers.find((p) => p.name === '乙站正常').id && o.modelKey === 'test-model-a',
  )
  ok(Boolean(pinnedOffer && goodOffer), '两站各有一条 test-model-a 供给')

  // 勾选会挂的那个站：人的明确指定，网关必须先撞它
  state = await api(base, 'POST', `/api/decisions/${encodeURIComponent('test-model-a')}/pick`, {
    offerId: pinnedOffer.id,
  })
  const decision = state.decisions.find((d) => d.modelKey === 'test-model-a')
  ok(decision?.pinnedOfferId === pinnedOffer.id, `决策页记下勾选（pinnedOfferId=${decision?.pinnedOfferId}）`)
  ok(decision?.chosenOfferId === pinnedOffer.id, `决策页「当前选」= 勾选那条（${decision?.chosenOfferId}）`)

  const chat = async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ model: 'test-model-a', messages: [{ role: 'user', content: 'hi' }] }),
    })
    await res.text()
    return {
      status: res.status,
      provider: decodeURIComponent(res.headers.get('x-manageapi-provider') || ''),
      attempts: Number(res.headers.get('x-manageapi-attempts') || 0),
    }
  }

  console.log('\n[1] 勾选一条会挂的供给：先撞它，失败后按锁定转移走正常站')
  {
    const first = await chat()
    ok(first.status === 200, `最终 200（实际 ${first.status}）`)
    ok(first.provider === '乙站正常', `最终落到正常站（实际 ${first.provider}）`)
    ok(first.attempts >= 2, `尝试次数 ≥ 2 说明先撞了勾选那条（实际 ${first.attempts}）`)
  }

  console.log('\n[2] 攒失败率：连打 25 单，让勾选那条被标 blocked')
  // 真实流量是攒批写盘的（5 秒一批），断言评分前必须等它落盘并让 state 重新算一遍
  for (let i = 0; i < 25; i += 1) await chat()
  let score = null
  let admission = {}
  await waitFor(async () => {
    await sleep(1200)
    state = await api(base, 'GET', '/api/state')
    score = state.scores?.[pinnedOffer.id] || null
    admission = score?.admission || {}
    return admission.kind === 'blocked'
  }, { timeoutMs: 20000, stepMs: 200 }).catch(() => {})
  ok(admission.kind === 'blocked', `勾选那条已被准入拦下（kind=${admission.kind}）`, JSON.stringify(admission).slice(0, 200))
  ok(Boolean(score?.blocked), `确实进了冷却（blocked=${JSON.stringify(score?.blocked)}）`)

  console.log('\n[3] 回归点：勾选那条被 blocked 之后，网关仍必须先派它')
  {
    // 页面侧先看一眼：决策页仍认它是「当前选」（这一步改动前就是对的，
    // 正因为页面是对的、网关不对，用户才会看到两边不一致）
    state = await api(base, 'GET', '/api/state')
    const d2 = state.decisions.find((d) => d.modelKey === 'test-model-a')
    ok(d2?.chosenOfferId === pinnedOffer.id, `决策页仍显示勾选那条（${d2?.chosenOfferId}）`)

    const after = await chat()
    ok(after.status === 200, `最终 200（实际 ${after.status}）`)
    ok(after.provider === '乙站正常', `失败后仍转到正常站（实际 ${after.provider}）`)
    ok(
      after.attempts >= 2,
      `勾选被 blocked 后仍先派它（attempts=${after.attempts}；=1 说明勾选被阶梯吃掉、直接派了别人）`,
    )

    // 路由日志（攒批写盘 2000ms，等够再断言）
    await sleep(2600)
    state = await api(base, 'GET', '/api/state')
    const last = state.routing?.[0]
    ok(Boolean(last), '路由日志有记录')
    ok(last?.attempts >= 2, `路由日志记下多次尝试（attempts=${last?.attempts}）`)
    ok(last?.chosenOfferId === goodOffer.id, `路由日志最终落在正常站（${last?.chosenOfferId}）`)
  }
} finally {
  for (const child of children.reverse()) killTree(child.pid)
  await rm(home, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? '✓ 全部通过' : `✗ ${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
