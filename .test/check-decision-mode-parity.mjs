/**
 * 页面「当前选」与网关「实际派活」必须是同一套口径（端到端，自包含）。
 *
 * 背景（2026-11-12，与勾选那批同族）：
 *   决策页重排用 `db.settings.decisionMode`（全局档），网关用
 *   `routeTarget.decisionMode || db.settings.decisionMode`（有生效路由组就听组里的）。
 *   于是「选了一个价格优先的路由组」时，页面按流畅度排、网关按价格排，
 *   两个地方各给出一个「当前选」——用户看到的就是「页面写 A，实际走 B」。
 *
 * 这个用例造两个站，故意让「便宜」和「快」指向不同的站：
 *   甲站：便宜（$1/M）、慢（DELAY 900ms）
 *   乙站：贵（$8/M）、快（DELAY 60ms）
 * 然后：
 *   A. 全局档 = 流畅度（flow），无生效组 → 页面与网关都该选快的乙站
 *   B. 建「最便宜」组并生效（组档 = price）→ 页面与网关都该选便宜的甲站
 *
 * 判据：B 状态下 /api/state 的 chosenOfferId 必须等于网关实际派活的那个 offer，
 * 且都指向甲站。改动前 B 会分叉（页面仍按 flow 选乙站）。
 *
 * 用法：node .test/check-decision-mode-parity.mjs
 *   MAPI_ROOT=<另一个工作树> node .test/check-decision-mode-parity.mjs  # 验改动前的红
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

const home = await mkdtemp(join(tmpdir(), 'mapi-parity-'))
const cheapSlowPort = await freePort()
const fastPriceyPort = await freePort()
const children = []
let daemonOut = ''

try {
  // 甲站：便宜但慢 900ms；乙站：贵但快 60ms
  children.push(spawn(process.execPath, [join(ROOT, '.test/mock-upstream.mjs')], {
    cwd: ROOT,
    env: { ...process.env, MODE: 'good', PORT: String(cheapSlowPort), DELAY: '900' },
    stdio: 'ignore',
  }))
  children.push(spawn(process.execPath, [join(ROOT, '.test/mock-upstream.mjs')], {
    cwd: ROOT,
    env: { ...process.env, MODE: 'good', PORT: String(fastPriceyPort), DELAY: '60' },
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
  console.log(`\n实例 ${base}（便宜慢 ${cheapSlowPort} / 贵快 ${fastPriceyPort}）`)

  await api(base, 'PATCH', '/api/settings', {
    probeIntervalMinutes: 0,
    monitorIntervalMinutes: 0,
    decisionMode: 'flow',
    lockFailover: 'none',
  })

  // 建两个站，价格拉开（甲 1 / 乙 8），都同步 test-model-a
  let state = await api(base, 'GET', '/api/state')
  for (const [name, port, price] of [['甲站便宜慢', cheapSlowPort, 1], ['乙站贵快', fastPriceyPort, 8]]) {
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
  const offerOf = (name, model = 'test-model-a') => {
    const pid = state.providers.find((p) => p.name === name).id
    return state.offers.find((o) => o.providerId === pid && o.modelKey === model)
  }
  const cheapOffer = offerOf('甲站便宜慢')
  const fastOffer = offerOf('乙站贵快')
  ok(Boolean(cheapOffer && fastOffer), '两个站各有一条 test-model-a')

  const chat = async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      // 必须流式：非流式没有首字可测，flow 档会退化成两边都是 Infinity（并列），
      // 那样测的就不是档位而是「都没数据」。真实客户端也是流式为主。
      body: JSON.stringify({
        model: 'test-model-a',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 32,
        stream: true,
      }),
    })
    await res.text()
    return {
      status: res.status,
      provider: decodeURIComponent(res.headers.get('x-manageapi-provider') || ''),
      attempts: Number(res.headers.get('x-manageapi-attempts') || 0),
    }
  }
  const decisionOf = (st) => st.decisions.find((d) => d.modelKey === 'test-model-a')

  // 两个站都得有真实样本，否则「快」的那家会因为没有证据落进兜底层，
  // 被测的就不是档位而是准入了。用勾选把它们各打几单，再清掉勾选。
  for (const offer of [fastOffer, cheapOffer]) {
    await api(base, 'POST', `/api/decisions/${encodeURIComponent('test-model-a')}/pick`, { offerId: offer.id })
    for (let i = 0; i < 3; i += 1) await chat()
  }
  await api(base, 'POST', `/api/decisions/${encodeURIComponent('test-model-a')}/pick`, { offerId: '' })
  // 流量是攒批写盘的（5 秒一批），等它落盘再断言，否则评分里还没有真实首字
  await sleep(6000)

  console.log('\n[A] 全局档 = 流畅度，无生效路由组：两边都该选「快」的乙站')
  {
    state = await api(base, 'GET', '/api/state')
    const d = decisionOf(state)
    ok(d?.chosenOfferId === fastOffer.id, `页面当前选 = 快的乙站（实际 ${d?.chosenOfferId}）`)
    const r = await chat()
    ok(r.provider === '乙站贵快', `网关派给快的乙站（实际 ${r.provider}）`)
    ok(d?.chosenOfferId === (state.offers.find((o) => o.providerId === state.providers.find((p) => p.name === r.provider)?.id && o.modelKey === 'test-model-a')?.id), '页面与网关同一个 offer')
  }

  console.log('\n[B] 建「最便宜」路由组并生效（组档 = 价格）：两边都该改选「便宜」的甲站')
  {
    const created = await api(base, 'POST', '/api/route-groups', {
      name: '省钱',
      models: ['test-model-a'],
      algo: 'cheap',
    })
    const gid = created?.group?.id
    ok(Boolean(gid), `路由组已创建（${gid}）`)
    await api(base, 'POST', '/api/route-groups/active', { id: gid })
    state = await api(base, 'GET', '/api/state')
    ok(state.routeGroups?.active?.algo === 'cheap', `组已生效（algo=${state.routeGroups?.active?.algo}）`)

    const d = decisionOf(state)
    ok(d?.chosenOfferId === cheapOffer.id, `页面当前选 = 便宜的甲站（实际 ${d?.chosenOfferId}）`)
    const r = await chat()
    ok(r.provider === '甲站便宜慢', `网关派给便宜的甲站（实际 ${r.provider}）`)
    ok(
      d?.chosenOfferId === cheapOffer.id && r.provider === '甲站便宜慢',
      '页面与网关一致——这就是本用例的判据',
    )
  }

  console.log('\n[C] 撤掉生效组：回到全局档，两边一起回到快的乙站')
  {
    await api(base, 'POST', '/api/route-groups/active', { id: '' })
    state = await api(base, 'GET', '/api/state')
    const d = decisionOf(state)
    const r = await chat()
    ok(d?.chosenOfferId === fastOffer.id, `页面回到快的乙站（实际 ${d?.chosenOfferId}）`)
    ok(r.provider === '乙站贵快', `网关回到快的乙站（实际 ${r.provider}）`)
  }
} finally {
  for (const child of children.reverse()) killTree(child.pid)
  await rm(home, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? '✓ 全部通过' : `✗ ${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
