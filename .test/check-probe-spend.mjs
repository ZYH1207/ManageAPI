/**
 * 探针花费统计：后端 + 记账口径冒烟测试（自包含，自己起假上游和自己起服务）。
 *
 * 这里最重要的断言是 [4]：**同一时间段里跑大量真实网关流量，探针花费一分不能动**。
 * 探针花费只能来自「探针自己发出的请求的 usage」，绝不能拿站点账单/整站用量做差。
 *
 * 用法：node .test/check-probe-spend.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = await mkdtemp(join(tmpdir(), 'mapi-probe-spend-'))
// 端口别和别的 check 撞车（check-routable-offers 占了 4396/5112）
const APP_PORT = 4397
const UP_PORT = 5114

// 假上游：所有对话请求返回**固定** usage，方便手算每一针的成本
const PROMPT_TOKENS = 1000
const COMPLETION_TOKENS = 100
const IN_PRICE = 2 // CNY / 百万 token
const OUT_PRICE = 8
const PER_REQUEST_CNY = (PROMPT_TOKENS / 1e6) * IN_PRICE + (COMPLETION_TOKENS / 1e6) * OUT_PRICE
const PROBE_REQUESTS = 5
const PER_PROBE_CNY = PER_REQUEST_CNY * PROBE_REQUESTS

const upstream = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'spend-model' }] }))
    return
  }
  if (!url.pathname.endsWith('/chat/completions')) {
    res.writeHead(404).end('not found')
    return
  }

  let raw = ''
  for await (const chunk of req) raw += chunk
  let body = {}
  try {
    body = JSON.parse(raw || '{}')
  } catch {
    body = {}
  }
  const prompt = body.messages?.[0]?.content || ''
  const answer = prompt.includes('1 to 120')
    ? Array.from({ length: 120 }, (_, i) => i + 1).join(',')
    : prompt.includes('7Q2K')
      ? '{"fp":"7Q2K","calc":391}'
      : 'ok'
  const usage = {
    prompt_tokens: PROMPT_TOKENS,
    completion_tokens: COMPLETION_TOKENS,
    total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
  }
  const finish = prompt.includes('1 to 120') ? 'stop' : 'stop'

  if (body.stream !== true) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: finish }],
        usage,
      }),
    )
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  setTimeout(() => {
    emit({ choices: [{ delta: { content: answer }, index: 0 }] })
    emit({ choices: [{ delta: {}, index: 0, finish_reason: finish }] })
    emit({ choices: [], usage })
    res.write('data: [DONE]\n\n')
    res.end()
  }, 10)
})
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))

let app = null
const base = `http://127.0.0.1:${APP_PORT}`

function startApp() {
  app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
    env: { ...process.env, MANAGE_API_HOME: HOME },
    stdio: 'ignore',
  })
  return app
}

async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('服务没起来')
}

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`)
  return data
}

const failures = []
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✓ ${name}`)
  else {
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
    failures.push(name)
  }
}

const near = (a, b, eps = 1e-9) => Math.abs(Number(a) - Number(b)) <= eps

/** 建站 → Key → 同步模型 → 给每条供给填单价。每个站用独立路径前缀，避免「地址已存在」。 */
let siteSeq = 0
async function addSite(name, { inPrice = IN_PRICE, outPrice = OUT_PRICE } = {}) {
  siteSeq += 1
  let state = await call('POST', '/api/providers', {
    name,
    baseUrl: `http://127.0.0.1:${UP_PORT}/site${siteSeq}/v1`,
  })
  const provider = state.providers.find((p) => p.name === name)
  await call('POST', '/api/credentials', { providerId: provider.id, label: '默认', secret: `sk-${provider.id}` })
  state = await call('POST', `/api/providers/${provider.id}/sync`, {})
  const offers = state.offers.filter((o) => o.providerId === provider.id)
  for (const offer of offers) {
    if (inPrice === null) {
      // 故意「不填价格」：用来验证「算不出钱」会被单独计数，而不是静默当 0
      await call('PATCH', `/api/offers/${offer.id}`, { inPrice: null, outPrice: null })
    } else {
      await call('PATCH', `/api/offers/${offer.id}`, {
        inPrice,
        outPrice,
        currency: 'CNY',
        priceUnit: 'per_mtok',
      })
    }
  }
  return { provider, offers }
}

try {
  startApp()
  await waitReady()

  console.log('[1] 干净环境：还没探测时花费为 0')
  {
    const { probeSpend } = await call('GET', '/api/probes/spend')
    check('总额 0', probeSpend.total.cny === 0)
    check('探测次数 0', probeSpend.total.probes === 0)
    check('分站为空', (probeSpend.byProvider || []).length === 0)
    check('半小时桶为空', (probeSpend.buckets || []).length === 0)
  }

  console.log('\n[2] 探一次：只按探针自己的 5 个请求算钱')
  const siteA = await addSite('甲站')
  const offerA = siteA.offers[0]
  await call('POST', '/api/probes/run', { offerId: offerA.id, limit: 1 })

  let spend = (await call('GET', '/api/probes/spend')).probeSpend
  check('探测次数 1', spend.total.probes === 1, `probes=${spend.total.probes}`)
  check(`请求数 ${PROBE_REQUESTS}`, spend.total.requests === PROBE_REQUESTS, `requests=${spend.total.requests}`)
  check(
    `金额 = 5×(${PROMPT_TOKENS}×输入价 + ${COMPLETION_TOKENS}×输出价) = ${PER_PROBE_CNY}`,
    near(spend.total.cny, PER_PROBE_CNY, 1e-9),
    `实际 ${spend.total.cny}`,
  )
  check('分站只有甲站', spend.byProvider.length === 1 && spend.byProvider[0].providerId === siteA.provider.id)
  check('甲站金额与总额一致', near(spend.byProvider[0].cny, PER_PROBE_CNY, 1e-9))
  check('有半小时桶', spend.buckets.length === 1, `buckets=${spend.buckets.length}`)
  check('桶时间对齐到半小时', spend.buckets[0].at % spend.bucketMs === 0)
  check('统计起点已记录', Boolean(spend.since))

  console.log('\n[3] 第二站单独记账，金额各归各')
  const siteB = await addSite('乙站')
  await call('POST', '/api/probes/run', { offerId: siteB.offers[0].id, limit: 1 })
  spend = (await call('GET', '/api/probes/spend')).probeSpend
  {
    const a = spend.byProvider.find((r) => r.providerId === siteA.provider.id)
    const b = spend.byProvider.find((r) => r.providerId === siteB.provider.id)
    check('两站各一笔', Boolean(a) && Boolean(b))
    check('两站金额都是单针成本', near(a.cny, PER_PROBE_CNY, 1e-9) && near(b.cny, PER_PROBE_CNY, 1e-9))
    check('总额 = 两站之和', near(spend.total.cny, PER_PROBE_CNY * 2, 1e-9), `实际 ${spend.total.cny}`)
  }

  console.log('\n[4] 关键：同时间段跑真实网关流量，探针花费不能被带涨')
  {
    const before = (await call('GET', '/api/probes/spend')).probeSpend
    const state = await call('GET', '/api/state')
    const key = state.gateway.keys.find((k) => k.enabled)?.key
    check('拿到网关 Key', Boolean(key))
    if (key) {
      // 5 次真实调用，每次上游都报 1000/100 token —— 这些钱属于网关流量，不属于探针
      for (let i = 0; i < 5; i += 1) {
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: 'spend-model',
            messages: [{ role: 'user', content: '真实流量，别算到探针头上' }],
          }),
        })
        await res.text()
      }
      const after = (await call('GET', '/api/probes/spend')).probeSpend
      check(
        '探针花费一分没动',
        near(after.total.cny, before.total.cny, 1e-12),
        `之前 ${before.total.cny} → 之后 ${after.total.cny}`,
      )
      check('探针请求数没动', after.total.requests === before.total.requests)
      // 反向确认：这次流量确实被记为真实用量了，说明上面不是「两边都没记」
      const usage = (await call('GET', '/api/usage?days=1')).usage
      check('真实流量进了用量统计', (usage.totals.requests || 0) >= 5, `requests=${usage.totals.requests}`)
    }
  }

  console.log('\n[5] 没填价格的供给：单独计数，不静默当 0')
  const siteC = await addSite('丙站', { inPrice: null })
  await call('POST', '/api/probes/run', { offerId: siteC.offers[0].id, limit: 1 })
  spend = (await call('GET', '/api/probes/spend')).probeSpend
  {
    const c = spend.byProvider.find((r) => r.providerId === siteC.provider.id)
    check('丙站算不出金额 → 记 0', c && c.cny === 0, `cny=${c?.cny}`)
    check('丙站被标记为未计价', c && c.unpriced === 1, `unpriced=${c?.unpriced}`)
    check('总额里也没把它算进去', near(spend.total.cny, PER_PROBE_CNY * 2, 1e-9), `实际 ${spend.total.cny}`)
  }

  console.log('\n[6] 重启服务后账本还在（落盘了）')
  {
    const before = (await call('GET', '/api/probes/spend')).probeSpend
    app.kill()
    await new Promise((r) => setTimeout(r, 400))
    startApp()
    await waitReady()
    const after = (await call('GET', '/api/probes/spend')).probeSpend
    check('总额不变', near(after.total.cny, before.total.cny, 1e-12), `${before.total.cny} → ${after.total.cny}`)
    check('分站不变', after.byProvider.length === before.byProvider.length)
    check('探测次数不变', after.total.probes === before.total.probes)
  }

  console.log('\n[7] 清空统计：账本归零、起点重置、探测结果不受影响')
  {
    const probesBefore = (await call('GET', '/api/state')).probeTotal
    const cleared = (await call('DELETE', '/api/probes/spend')).probeSpend
    check('总额归零', cleared.total.cny === 0)
    check('分站清空', cleared.byProvider.length === 0)
    check('半小时桶清空', cleared.buckets.length === 0)
    check('探测次数归零', cleared.total.probes === 0)
    check('起点重置为现在', Boolean(cleared.since) && Date.now() - new Date(cleared.since).getTime() < 60000)
    const probesAfter = (await call('GET', '/api/state')).probeTotal
    check('历史探测结果没被删', probesAfter === probesBefore, `${probesBefore} → ${probesAfter}`)
    // 清空后再探一次，重新从 0 开始累加
    await call('POST', '/api/probes/run', { offerId: offerA.id, limit: 1 })
    const again = (await call('GET', '/api/probes/spend')).probeSpend
    check('清空后重新记账', near(again.total.cny, PER_PROBE_CNY, 1e-9), `实际 ${again.total.cny}`)
  }

  console.log('\n[8] 半小时桶的边界与保留期（纯函数）')
  {
    const { bucketStart, BUCKET_MS, buildProbeSpendView } = await import('../core/probe-spend.js')
    check('BUCKET_MS = 30 分钟', BUCKET_MS === 30 * 60 * 1000)
    check('整点对齐', bucketStart(1800000 * 5) === 1800000 * 5)
    check('向下取整', bucketStart(1800000 * 5 + 1789999) === 1800000 * 5)
    check('跨半小时进位', bucketStart(1800000 * 5 + 1800000) === 1800000 * 6)

    const now = Date.now()
    const view = buildProbeSpendView(
      {
        since: new Date(now - 3600000).toISOString(),
        updatedAt: new Date(now).toISOString(),
        totals: { cny: 0.3, probes: 3, requests: 15, unpriced: 0 },
        byProvider: {
          pa: { cny: 0.2, probes: 2, requests: 10, unpriced: 0, lastAt: new Date(now).toISOString() },
          pb: { cny: 0.1, probes: 1, requests: 5, unpriced: 0, lastAt: new Date(now).toISOString() },
        },
        buckets: {
          [String(bucketStart(now))]: { cny: 0.3, probes: 3, requests: 15, byProvider: { pa: 0.2, pb: 0.1 } },
          // 8 天前的桶必须被视图丢掉
          [String(bucketStart(now - 8 * 86400000))]: { cny: 99, probes: 1, requests: 5, byProvider: { pa: 99 } },
        },
      },
      {
        providers: [
          { id: 'pa', name: '甲', unitPrice: 2 },
          { id: 'pb', name: '乙' },
        ],
        settings: { fx: { rates: { CNY: 7 } } },
        now,
      },
    )
    check('按金额降序', view.byProvider[0].providerId === 'pa')
    check('单价 2 的站实际消费 = 模型消费 × 2', near(view.byProvider[0].paidCny, 0.4, 1e-6))
    check('没填单价的站按 1:1，实际消费 = 模型消费', near(view.byProvider[1].paidCny, 0.1, 1e-6))
    check('总额的两个口径分开算', near(view.total.cny, 0.3, 1e-9) && near(view.total.paidCny, 0.5, 1e-6))
    check('超出保留期的桶被丢掉', view.buckets.length === 1, `buckets=${view.buckets.length}`)
    // 卡片只显示「花了多少钱」，所以每个桶也必须带同一个口径的 paidCny，
    // 否则柱子高矮和总金额对不上（用户看的是一个数，不是两个）
    check(
      '每个桶带实际消费口径',
      near(view.buckets[0].paidCny, 0.5, 1e-6),
      `paidCny=${view.buckets[0].paidCny}`,
    )
  }

  console.log('')
  if (failures.length > 0) {
    console.log(`✗ ${failures.length} 项失败：${failures.join('、')}`)
    process.exitCode = 1
  } else {
    console.log('✓ 探针花费统计全部通过')
  }
} catch (error) {
  console.log(`✗ 出错：${error.message}`)
  process.exitCode = 1
} finally {
  app?.kill()
  upstream.close()
  await new Promise((r) => setTimeout(r, 200))
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}
