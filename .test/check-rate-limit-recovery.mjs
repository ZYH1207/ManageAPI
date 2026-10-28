/**
 * 限流冷却与恢复自检（纯函数 + 真调度器，不联网）：
 *
 *   1. 现场：一个模型 4 条供给，3 条慢速（被首字门槛挡住）+ 1 条限流。
 *      限流那条不能放行——以前它会被兜底派活，网关反复撞同一个 429，
 *      客户端等半天最后还是失败。
 *   2. 冷却到期 ≠ 恢复：要等下一次探测（或真实调用）成功才重新放行。
 *      健康过的供给被限流后也一样（可用率还是 100%，但最近一次证据是 429）。
 *   3. 定时探测：冷却窗口内跳过；冷却到期后按 10 分钟节奏复测，
 *      即使基础探测间隔是 1 小时（重试间隔 20 分钟）也要优先复测——
 *      不复测就永远停在「不放行」。
 *   4. 真跑网关：两条供给，一条健康一条限流，请求只打健康那条；
 *      两条都限流时直接 400，**一次上游请求都不发**（这才是「不再浪费时间」）。
 *
 * 用法：node .test/check-rate-limit-recovery.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { scoreOffers, isRoutable } = await import(pathToFileURL(join(ROOT, 'core/score.js')).href)
const { admissionOf, admissionFailure, selectCandidates } = await import(
  pathToFileURL(join(ROOT, 'core/router.js')).href
)

let failed = 0
function ok(cond, message) {
  if (cond) console.log(`  ✓ ${message}`)
  else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

const now = Date.now()
const isoAgo = (ms) => new Date(now - ms).toISOString()
const good = { ok: true, ttftMs: 1200, fingerprintOk: true, truncated: false, billingInflated: false }
const limited = { ok: false, error: 'HTTP 429：{"error":{"message":"rate limit exceeded"}}' }
const scoreOf = (probes, traffic = {}) => scoreOffers(probes, traffic, { maxAgeMs: 6 * 3600000, now })

console.log('[1] 冷却中 / 冷却到期未复测 → 都不放行')
{
  const cooling = scoreOf([{ offerId: 'a', ts: isoAgo(60_000), ...limited }]).get('a')
  ok(cooling.blocked?.kind === 'rate-limit', '1 分钟前被限流 → 冷却中')
  ok(cooling.pendingRecovery?.kind === 'rate-limit', '同时标记待复测')
  ok(admissionOf({ ...cooling, samples: 0 })?.ok === false, '冷却中 → 不准入')

  const expired = scoreOf([{ offerId: 'b', ts: isoAgo(20 * 60_000), ...limited }]).get('b')
  ok(expired.blocked === null, '20 分钟后冷却已到期')
  ok(expired.pendingRecovery?.kind === 'rate-limit', '但没有成功证据 → 仍待复测')
  ok(isRoutable(expired) === false, '不可路由')

  // 健康过的供给：可用率 100%、状态 healthy，但最近一次证据是限流
  const healthyThenLimited = scoreOf([
    { offerId: 'c', ts: isoAgo(3 * 3600_000), ...good },
    { offerId: 'c', ts: isoAgo(2 * 3600_000), ...good },
    { offerId: 'c', ts: isoAgo(25 * 60_000), ...limited },
  ]).get('c')
  ok(healthyThenLimited.status === 'healthy', `状态仍是 healthy（实际 ${healthyThenLimited.status}）`)
  ok(healthyThenLimited.availability === 1, '可用率仍是 1（限流不进分母）')
  ok(healthyThenLimited.pendingRecovery?.kind === 'rate-limit', '但待复测——可用率好看不代表现在能用')
  ok(isRoutable(healthyThenLimited) === false, '不放行')
  ok(
    admissionOf({
      ...healthyThenLimited,
      samples: healthyThenLimited.samples + healthyThenLimited.trafficSamples,
      allowUntrusted: true,
    }).ok === false,
    '「放行可疑供给」打开也不放行（那是另一件事）',
  )

  // 一次成功探测把 successAt 推到失败之后 → 恢复
  const recovered = scoreOf([
    { offerId: 'd', ts: isoAgo(20 * 60_000), ...limited },
    { offerId: 'd', ts: isoAgo(60_000), ...good },
  ]).get('d')
  ok(recovered.pendingRecovery === null, '之后探测成功 → 清掉待复测')
  ok(isRoutable(recovered) === true, '恢复后可路由')
}

console.log('[2] 现场：3 条慢速 + 1 条限流 → 一条都不登场，400 说清原因')
{
  const providers = [{ id: 'p1', name: '甲站' }]
  const credentials = [{ id: 'c1', providerId: 'p1', group: '' }]
  const offer = (id) => ({
    id,
    providerId: 'p1',
    credentialId: 'c1',
    group: '',
    modelKey: 'm',
    upstreamName: 'm',
    pricingMode: 'manual',
    priceUnit: 'per_mtok',
    currency: 'CNY',
    inPrice: 1,
    outPrice: 1,
  })
  const ids = ['slow1', 'slow2', 'slow3', 'limited']
  const scores = new Map([
    ['slow1', scoreOf([{ offerId: 'slow1', ts: isoAgo(3 * 3600_000), ...good, ttftMs: 16522 }]).get('slow1')],
    ['slow2', scoreOf([{ offerId: 'slow2', ts: isoAgo(3 * 3600_000), ...good, ttftMs: 19300 }]).get('slow2')],
    ['slow3', scoreOf([{ offerId: 'slow3', ts: isoAgo(3 * 3600_000), ...good, ttftMs: 22000 }]).get('slow3')],
    ['limited', scoreOf([{ offerId: 'limited', ts: isoAgo(60_000), ...limited }]).get('limited')],
  ])
  const rows = selectCandidates({
    offers: ids.map(offer),
    providers,
    credentials,
    scores,
    benchmarks: {},
    settings: { maxTtftMs: 8000, fxUsdCny: 7.2, allowUntrusted: false },
    model: 'm',
  })
  ok(rows.length === 4, `4 条候选都在表里（${rows.length}）`)
  ok(rows.every((row) => row.admission.ok === false), '没有一条能登场（以前限流那条会被兜底派活）')
  ok(
    rows.find((row) => row.offer.id === 'limited')?.admission.kind === 'blocked',
    '限流那条的拒绝原因归到 blocked',
  )
  const failure = admissionFailure(rows, { model: 'm', maxTtftMs: 8000 })
  ok(failure.status === 400, `直接 400，不拿限流那条碰运气（${failure.status}）`)
  ok(failure.detail.includes('限流中'), `逐站原因里有「限流中」：${failure.detail.slice(0, 80)}…`)
  ok(failure.detail.includes('慢速'), '慢速的三条也在原因里')
}

// ---------------------------------------------------------------- 调度器
console.log('[3] 定时探测：冷却窗口内跳过，冷却到期按 10 分钟节奏复测')
{
  const home = await mkdtemp(join(tmpdir(), 'mapi-rate-limit-'))
  process.env.MANAGE_API_HOME = home
  try {
    const store = await import(pathToFileURL(join(ROOT, 'core/store.js')).href)
    const { startProbeScheduler } = await import(pathToFileURL(join(ROOT, 'daemon/scheduler.js')).href)

    const mkOffer = (id) => ({
      id,
      providerId: 'p1',
      credentialId: 'c1',
      group: '',
      modelKey: 'm',
      upstreamName: 'm',
      pricingMode: 'manual',
      priceUnit: 'per_mtok',
      currency: 'CNY',
      inPrice: 1,
      outPrice: 1,
    })
    await store.mutate((db) => {
      db.settings.probeIntervalMinutes = 60
      // 手动汇率 = 定时器不会去拉网络
      db.settings.fx = { base: 'USD', rates: { CNY: 7.2 }, updatedAt: new Date().toISOString(), source: 'manual', manual: true }
      db.providers = [{ id: 'p1', name: '探测站', baseUrl: 'http://127.0.0.1:9/v1' }]
      db.credentials = [{ id: 'c1', providerId: 'p1', group: '', label: 'k' }]
      db.offers = ['cooling', 'recovering', 'healthy', 'traffic-only'].map(mkOffer)
      db.probes = [
        // 2 分钟前刚被限流：冷却 5 分钟还没到，跳过
        { offerId: 'cooling', ts: isoAgo(2 * 60_000), ...limited },
        // 12 分钟前被限流：冷却已过。基础间隔 60 分钟 → 重试间隔 20 分钟，
        // 按旧逻辑要再等 8 分钟；按复测节奏（10 分钟）现在就该探
        { offerId: 'recovering', ts: isoAgo(12 * 60_000), ...limited },
        // 12 分钟前刚成功：健康站按 60 分钟基础间隔，现在不该探
        { offerId: 'healthy', ts: isoAgo(12 * 60_000), ...good },
      ]
      // 网关真实流量撞到的 429（没有探针记录）：同样按复测节奏去探
      db.traffic = {
        'traffic-only': {
          ok: 0,
          fail: 0,
          since: isoAgo(30 * 60_000),
          kinds: { 'rate-limit': { n: 1, lastAt: isoAgo(12 * 60_000) } },
        },
      }
    })

    const probed = new Set()
    const stop = startProbeScheduler({
      runProbes: async ({ offerIds }) => {
        for (const id of offerIds) probed.add(id)
        return []
      },
      tickMs: 25,
      firstDelayMs: 0,
      logger: { info() {}, warn() {} },
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    stop()

    ok(probed.has('recovering'), '冷却到期的供给被复测（12 分钟前限流 → 已到 10 分钟节奏）')
    ok(probed.has('traffic-only'), '只有真实流量 429 的供给也被复测（没有探针记录不等于不用管）')
    ok(!probed.has('cooling'), '冷却窗口内（2 分钟前限流）跳过，不白烧请求')
    ok(!probed.has('healthy'), '健康站仍按基础间隔（60 分钟），不因为别人复测被顺带探')
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------- 真跑网关
console.log('[4] 真跑网关：限流的供给一次都不该被请求')
{
  const HOME = await mkdtemp(join(tmpdir(), 'mapi-rate-limit-gw-'))
  process.env.MANAGE_API_HOME = HOME
  const freePort = async () => {
    const probe = createServer()
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = probe.address().port
    await new Promise((resolve) => probe.close(resolve))
    return port
  }
  const APP_PORT = await freePort()
  const UP_PORT = await freePort()
  const hits = { '/a/v1': 0, '/b/v1': 0 }

  const upstream = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const site = url.pathname.startsWith('/a/v1')
      ? '/a/v1'
      : url.pathname.startsWith('/b/v1')
        ? '/b/v1'
        : null
    if (!site) return send(404, { error: 'not found' })
    if (url.pathname.endsWith('/models')) return send(200, { data: [{ id: 'gpt-x' }] })
    if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
      hits[site] += 1
      req.on('data', () => {})
      req.on('end', () => {
        send(200, {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: `served-by-${site.slice(1, 2).toUpperCase()}` },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
      })
      return
    }
    return send(404, { error: 'not found' })
  })
  await new Promise((resolve) => upstream.listen(UP_PORT, '127.0.0.1', resolve))

  const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      MANAGE_API_HOME: HOME,
      // 定时探测推到 10 分钟后：这节要看的是「网关派活」，不能被后台探测改写评分
      MANAGE_API_PROBE_FIRST_DELAY_MS: '600000',
    },
    stdio: 'ignore',
  })
  const base = `http://127.0.0.1:${APP_PORT}`
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`)
    return data
  }

  try {
    for (let i = 0; i < 100; i += 1) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break
      } catch {
        /* 还没起来 */
      }
      await sleep(150)
    }
    // 关掉定时探测（双重保险）
    await call('PATCH', '/api/settings', { probeIntervalMinutes: 0 })

    const up = `http://127.0.0.1:${UP_PORT}`
    const created = await call('POST', '/api/providers', { name: '甲站', baseUrl: `${up}/a/v1` })
    const pa = created.providers.find((p) => p.name === '甲站')
    await call('POST', '/api/credentials', { providerId: pa.id, label: '默认', secret: 'sk-a-1234' })
    await call('POST', `/api/providers/${pa.id}/sync`)

    const createdB = await call('POST', '/api/providers', { name: '乙站', baseUrl: `${up}/b/v1` })
    const pb = createdB.providers.find((p) => p.name === '乙站')
    await call('POST', '/api/credentials', { providerId: pb.id, label: '默认', secret: 'sk-b-1234' })
    await call('POST', `/api/providers/${pb.id}/sync`)

    const state = await call('GET', '/api/state')
    const key = state.gateway.keys.find((k) => k.enabled)?.key
    const offerA = state.offers.find((o) => o.providerId === pa.id && o.upstreamName === 'gpt-x')
    const offerB = state.offers.find((o) => o.providerId === pb.id && o.upstreamName === 'gpt-x')
    ok(Boolean(key && offerA && offerB), '两条同模型供给 + 网关 Key 就绪')

    // 直接改库注入探针证据：甲健康，乙 1 分钟前刚被限流（冷却中）
    const store = await import(pathToFileURL(join(ROOT, 'core/store.js')).href)
    const seed = async (aProbe, bProbe) => {
      await store.mutate((db) => {
        db.probes = [
          { offerId: offerA.id, ts: isoAgo(60_000), ...aProbe },
          { offerId: offerB.id, ts: isoAgo(60_000), ...bProbe },
        ]
      })
    }
    await seed(good, limited)

    // 评分缓存按 mtime 失效；同一毫秒写完再读可能拿到旧快照
    const waitState = async (predicate) => {
      for (let i = 0; i < 10; i += 1) {
        const next = await call('GET', '/api/state')
        if (predicate(next)) return next
        await sleep(30)
      }
      return call('GET', '/api/state')
    }
    const next = await waitState((s) => s.scores?.[offerB.id]?.blocked)
    ok(next.scores?.[offerA.id]?.admission?.ok === true, '甲站（健康）→ 允许放行')
    ok(next.scores?.[offerB.id]?.admission?.ok === false, '乙站（限流）→ 不放行')

    const post = (body) =>
      fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      })

    hits['/a/v1'] = 0
    hits['/b/v1'] = 0
    const first = await post({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] })
    const firstBody = await first.json()
    ok(first.status === 200, `请求成功（${first.status}）`)
    ok(JSON.stringify(firstBody).includes('served-by-A'), '由健康那条（甲站）服务')
    ok(hits['/b/v1'] === 0, `限流那条一次都没被请求（乙站命中 ${hits['/b/v1']} 次）`)
    ok(
      first.headers.get('x-manageapi-attempts') === '1',
      `只试了 1 次（${first.headers.get('x-manageapi-attempts')}）`,
    )

    // 甲站也被限流：两条都不能登场 → 直接 400，上游零请求
    await seed(limited, limited)
    await waitState((s) => s.scores?.[offerA.id]?.blocked)
    hits['/a/v1'] = 0
    hits['/b/v1'] = 0
    const second = await post({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] })
    const secondBody = await second.json()
    ok(second.status === 400, `没有可用供给 → 400（${second.status}）`)
    ok(JSON.stringify(secondBody).includes('no_available_supply'), '错误码指明「没有可用供给」')
    ok(JSON.stringify(secondBody).includes('限流中'), '错误信息说清是限流中')
    ok(hits['/a/v1'] === 0 && hits['/b/v1'] === 0, '上游一次请求都没发（时间不浪费在必然失败的路上）')
  } finally {
    app.kill()
    upstream.close()
    await rm(HOME, { recursive: true, force: true }).catch(() => {})
  }
}

console.log('')
if (failed > 0) {
  console.error(`✗ ${failed} 项失败`)
  process.exit(1)
}
console.log('✓ 全部通过')
