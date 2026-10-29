/**
 * 探测方案（Lite / 全量）的接线测试：界面选的方案必须真传到 probeModel。
 *
 * 背景：Lite（2 发）这套形态此前只给定时/轮巡用，手动探测一律全量、界面上
 * 也没得选——用户根本不知道有这两种、也不知道点一下花几分钱。
 * 现在「探测全部」展开出 Lite / 全量 两个按钮，单条探测保持全量。
 * 这里钉死三件事：
 *   ① 传 lite:true → 每模型只发 2 个请求，缓存那项不出数（cacheSupported 为 null）；
 *   ② 传 lite:false / 不传 → 4 个请求，缓存出数；
 *   ③ 单条探测（offerId）不传 lite 也是 4 个请求——行内那个「探测」永远给完整证据。
 *
 * 用法：node .test/check-probe-mode.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = await mkdtemp(join(tmpdir(), 'mapi-probe-mode-'))
// 端口避开其他 check（4397/5114 已被 check-probe-spend 占用）
const APP_PORT = 4394
const UP_PORT = 5118

/** 上游每收一个对话请求就 +1，用来数「这次到底发了几个请求」 */
let requests = 0

const upstream = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mode-model' }, { id: 'mode-model-2' }] }))
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
  requests += 1

  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 100,
    total_tokens: 1100,
    // 缓存检测看的是「第二次」的命中数；这里固定给 800，
    // 只要走了缓存检测这条腿，cacheSupported 就一定是 true
    prompt_tokens_details: { cached_tokens: 800 },
  }

  if (body.stream !== true) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage,
      }),
    )
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  setTimeout(() => {
    emit({ choices: [{ delta: { content: answer }, index: 0 }] })
    emit({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] })
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

/** 建一个站 + Key + 同步模型，返回它的供给 */
async function addSite(name, siteNo) {
  let state = await call('POST', '/api/providers', {
    name,
    baseUrl: `http://127.0.0.1:${UP_PORT}/site${siteNo}/v1`,
  })
  const provider = state.providers.find((p) => p.name === name)
  await call('POST', '/api/credentials', { providerId: provider.id, label: '默认', secret: `sk-${provider.id}` })
  state = await call('POST', `/api/providers/${provider.id}/sync`, {})
  return { provider, offers: state.offers.filter((o) => o.providerId === provider.id) }
}

/** 数一段探测的请求数与形态 */
async function runAndMeasure(payload) {
  requests = 0
  const result = await call('POST', '/api/probes/run', payload)
  return { result, requests, probes: result.probeResults || [] }
}

try {
  startApp()
  await waitReady()

  const site = await addSite('方案站', 1)
  check('建站并同步出两条供给', site.offers.length === 2, `offers=${site.offers.length}`)

  console.log('\n[1] Lite：每模型只发 2 个请求，缓存不出数')
  {
    const { requests: n, probes } = await runAndMeasure({ offerIds: site.offers.map((o) => o.id), lite: true })
    check('探测了两条供给', probes.length === 2, `probes=${probes.length}`)
    check('总请求数 = 2 个模型 × 2 发 = 4', n === 4, `实际 ${n}`)
    check('每条都成功', probes.every((p) => p.ok))
    check(
      '缓存项跳过（cacheSupported 为 null）',
      probes.every((p) => p.cacheSupported === null),
      `cacheSupported=${probes.map((p) => p.cacheSupported).join(',')}`,
    )
    check(
      '指纹与截断照测',
      probes.every((p) => p.fingerprintOk === true && p.truncated === false),
      `fp=${probes.map((p) => p.fingerprintOk).join(',')} trunc=${probes.map((p) => p.truncated).join(',')}`,
    )
  }

  console.log('\n[2] 全量：每模型 4 个请求，缓存出数')
  {
    const { requests: n, probes } = await runAndMeasure({ offerIds: site.offers.map((o) => o.id), lite: false })
    check('总请求数 = 2 个模型 × 4 发 = 8', n === 8, `实际 ${n}`)
    check(
      '缓存项有数（cacheSupported 为 true）',
      probes.every((p) => p.cacheSupported === true),
      `cacheSupported=${probes.map((p) => p.cacheSupported).join(',')}`,
    )
  }

  console.log('\n[3] 单条探测：不带 lite 也是全量（行内那个「探测」永远给完整证据）')
  {
    const { requests: n, probes } = await runAndMeasure({ offerId: site.offers[0].id, limit: 1 })
    check('只探一条', probes.length === 1, `probes=${probes.length}`)
    check('请求数 = 4', n === 4, `实际 ${n}`)
    check('缓存项有数', probes[0].cacheSupported === true)
  }

  console.log('\n[4] 探针花费跟着方案走：Lite 恰好是全量的一半')
  {
    // 每发请求上游都报 1000 in / 100 out，总请求数就是钱的唯一变量
    const before = (await call('GET', '/api/probes/spend')).probeSpend.total.requests
    const lite = await runAndMeasure({ offerIds: site.offers.map((o) => o.id), lite: true })
    const afterLite = (await call('GET', '/api/probes/spend')).probeSpend.total.requests
    const full = await runAndMeasure({ offerIds: site.offers.map((o) => o.id), lite: false })
    const afterFull = (await call('GET', '/api/probes/spend')).probeSpend.total.requests
    check('Lite 记 4 个请求的钱', afterLite - before === lite.requests && lite.requests === 4, `记了 ${afterLite - before}`)
    check('全量记 8 个请求的钱', afterFull - afterLite === full.requests && full.requests === 8, `记了 ${afterFull - afterLite}`)
  }
} finally {
  app?.kill()
  upstream.close()
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

if (failures.length) {
  console.log(`\n${failures.length} 项失败：${failures.join(' / ')}`)
  process.exit(1)
}
console.log('\n全部通过')
