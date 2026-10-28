/**
 * 详细用量自检。
 *
 *   [1] 纯函数 usageNumbers：上游那一堆别名怎么归一（含「别名把缓存读报成 0」的真实坑）、
 *       净值怎么算、命中率的分母、思考 token 从哪儿取。
 *   [2] 纯函数 detailRows：老决策日志（没有 protocol / stream 字段）也能出明细；
 *       上游没回 usage 的请求 token 必须是 null（不是 0），且被计进 missingUsage。
 *   [3] 端到端：自己起假上游 + 自己起 daemon（临时数据目录），跑一次流式、一次非流式、
 *       一次必失败的请求，然后查 /api/usage/detail 和 /api/usage：
 *       缓存写入要在汇总里出现（以前 addRow 漏了这个字段，汇总恒为 0）、
 *       生成速度要有值、失败请求只贡献请求数不贡献 token。
 *
 * 用法：node .test/check-usage-detail.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { usageNumbers } from '../core/wire.js'
import { detailRow, detailRows } from '../core/usage-detail.js'

let failed = 0
const ok = (cond, msg, detail = '') => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}${detail ? ` —— ${detail}` : ''}`)
  }
}

// ------------------------------------------------------------ 1. usageNumbers
console.log('[1] usageNumbers：别名 / 净值 / 命中率')
{
  // 真实 sub2api 的形状：同一份用量里既有 OpenAI 标准字段，又有一堆别名，
  // 其中 cache_read_input_tokens 是 0（真正命中的在 cached_tokens 里）。
  // 按优先级取「第一个有值的」会稳定取到这个 0，所以缓存字段必须取最大值。
  const fat = {
    prompt_tokens: 1000,
    completion_tokens: 50,
    total_tokens: 1050,
    prompt_tokens_details: { cached_tokens: 600 },
    completion_tokens_details: { reasoning_tokens: 20 },
    cache_read_input_tokens: 0,
    prompt_cache_hit_tokens: 600,
    cache_creation_input_tokens: 200,
    prompt_cache_write_tokens: 200,
    completion_thinking_tokens: 20,
  }
  const n = usageNumbers(fat)
  ok(n.cached === 600, `缓存读取到 600（别名里的 0 不能盖掉真值，实际 ${n.cached}）`)
  ok(n.cacheCreation === 200, `缓存写取到 200（实际 ${n.cacheCreation}）`)
  ok(n.reasoning === 20, `思考 token 取到 20（实际 ${n.reasoning}）`)
  ok(n.input === 200, `输入是净值 1000−600−200=200（实际 ${n.input}）`)
  ok(n.prompt === 1000, `prompt 保留上游原值 1000（虚报核验要用它，实际 ${n.prompt}）`)
  ok(Math.abs(n.cacheHitRate - 0.6) < 1e-9, `命中率 = 600/(200+600+200) = 0.6（实际 ${n.cacheHitRate}）`)

  // Anthropic 系：input_tokens 不含缓存，缓存单独报
  const anthropic = usageNumbers({
    input_tokens: 100,
    output_tokens: 10,
    cache_read_input_tokens: 900,
    output_tokens_details: { reasoning_tokens: 0 },
  })
  ok(anthropic.prompt === 100 && anthropic.cached === 900, '只有 Anthropic 字段时也能认（input_tokens + cache_read）')
  ok(anthropic.input === 100, `Anthropic 的 input_tokens 本身就是净值，不再减缓存（实际 ${anthropic.input}）`)
  ok(Math.abs(anthropic.cacheHitRate - 0.9) < 1e-9, `命中率 900/1000 = 0.9（实际 ${anthropic.cacheHitRate}）`)

  ok(usageNumbers(null) === null, '没有 usage 返回 null，不是 0')
  ok(usageNumbers({}).input === 0 && usageNumbers({}).cacheHitRate === null, '空 usage 全 0、命中率 null')
}

// -------------------------------------------------------------- 2. detailRows
console.log('\n[2] detailRows：老日志 / 缺 usage / 区间过滤')
{
  const now = Date.parse('2026-10-28T12:00:00.000Z')
  // 改动前的历史记录：没有 protocol / stream，usage 是原始上游对象
  const legacy = {
    id: 'g_old',
    ts: '2026-10-28T11:00:00.000Z',
    model: 'deepseek-v4.1-flash',
    keyName: 'deepseek v4.1flash',
    chosenProviderId: 'p_demo',
    chosenProviderName: '秋',
    chosenGroup: '国模-0045 p哥',
    attempts: 1,
    outcome: 'ok',
    latencyMs: 8786,
    ttftMs: 4516,
    usage: {
      prompt_tokens: 7803,
      completion_tokens: 777,
      total_tokens: 8580,
      prompt_tokens_details: { cached_tokens: 4352 },
    },
  }
  const row = detailRow(legacy)
  ok(row.protocol === null && row.stream === null, '老记录没有 protocol / stream 时给 null（不瞎猜）')
  ok(row.genMs === 4270, `生成窗口 = 8786 − 4516 = 4270（实际 ${row.genMs}）`)
  ok(row.tps === 182, `速度 = 777 ÷ 4.27s ≈ 182 tok/s（实际 ${row.tps}）`)
  ok(row.input === 3451 && row.cached === 4352, `输入净值 3451、缓存读 4352（实际 ${row.input} / ${row.cached}）`)

  // 上游没回 usage：token 是「不知道」，不是 0
  const noUsage = detailRow({ ...legacy, id: 'g_none', usage: null, ts: '2026-10-28T11:30:00.000Z' })
  ok(noUsage.prompt === null && noUsage.output === null, '缺 usage 时 token 为 null')
  ok(noUsage.tps === null, '缺 usage 时没有速度（不编数）')

  // 非流式：没有首字 → 不算生成速度（否则会把排队时间当生成时间）
  const nonStream = detailRow({
    ...legacy,
    id: 'g_ns',
    ttftMs: null,
    latencyMs: 3000,
    usage: { prompt_tokens: 100, completion_tokens: 40 },
  })
  ok(nonStream.genMs === null && nonStream.tps === null, '非流式不给生成窗口和速度')

  const { rows, available, missingUsage, capped } = detailRows(
    [legacy, noUsage, { ...legacy, id: 'g_ancient', ts: '2026-10-01T00:00:00.000Z' }],
    { days: 7, now },
  )
  ok(available === 2, `只算区间内的 2 条（更早的 1 条被过滤，实际 ${available}）`)
  ok(rows[0].id === 'g_none', '按时间倒序，最新在前')
  ok(missingUsage === 1, `缺 usage 的算进 missingUsage（实际 ${missingUsage}）`)
  ok(capped === false, '没超 limit 时 capped = false')

  const limited = detailRows([legacy, noUsage], { days: 7, now, limit: 1 })
  ok(limited.shown === 1 && limited.capped === true, 'limit 生效且标记 capped')
}

// ---------------------------------------------------------------- 3. 端到端
const HOME = await mkdtemp(join(tmpdir(), 'mapi-usage-detail-'))
const APP_PORT = 4396
const UP_PORT = 5115
const BASE = `http://127.0.0.1:${APP_PORT}`

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 假上游：流式那条回「肥」usage（全别名 + 缓存读/写 + 思考），非流式回最小 usage
const upstream = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname.endsWith('/models')) {
    return json(200, { data: [{ id: 'detail-model' }, { id: 'fail-model' }] })
  }
  if (!url.pathname.endsWith('/chat/completions')) return json(404, { error: { message: 'not found' } })

  const body = await readBody(req)
  // 到得了候选、但会挂的模型：用来验证「失败请求只贡献请求数、不贡献 token」
  if (body.model === 'fail-model') {
    return json(503, { error: { message: 'upstream unavailable', type: 'server_error' } })
  }
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 50,
    total_tokens: 1050,
    prompt_tokens_details: { cached_tokens: 600 },
    completion_tokens_details: { reasoning_tokens: 20 },
    cache_read_input_tokens: 0,
    prompt_cache_hit_tokens: 600,
    cache_creation_input_tokens: 200,
    prompt_cache_write_tokens: 200,
    completion_thinking_tokens: 20,
  }

  if (body.stream !== true) {
    return json(200, {
      id: 'chatcmpl-ns',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    })
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  const emit = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
  emit({ id: 'chatcmpl-s', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '你' } }] })
  // 留出可测量的生成窗口：首字之后还要再产出 300ms 左右
  for (const piece of ['好', '，', '这', '是', '回答']) {
    await sleep(60)
    emit({ id: 'chatcmpl-s', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece } }] })
  }
  emit({ id: 'chatcmpl-s', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))

const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  env: { ...process.env, MANAGE_API_HOME: HOME },
  stdio: 'ignore',
})
const cleanup = async () => {
  app.kill()
  upstream.close()
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`)
  return data
}

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }

  console.log('\n[3] 端到端：流式 / 非流式 / 必失败')
  let state = await api('GET', '/api/state')
  state = await api('POST', '/api/providers', { name: '详细用量站', baseUrl: `http://127.0.0.1:${UP_PORT}/v1` })
  const provider = state.providers.find((p) => p.name === '详细用量站')
  await api('POST', '/api/credentials', { providerId: provider.id, label: '默认', secret: 'sk-detail' })
  await api('POST', `/api/providers/${provider.id}/sync`, {})

  state = await api('GET', '/api/state')
  // 未定价的供给进不了付费池，和 run-gateway 一样手动落个价
  for (const offer of state.offers.filter((o) => o.providerId === provider.id)) {
    await api('PATCH', `/api/offers/${offer.id}`, {
      inPrice: 1,
      outPrice: 2,
      currency: 'USD',
      ratio: null,
      pricingMode: 'manual',
    })
  }

  const key = state.gateway.keys.find((k) => k.enabled)?.key
  const chat = async (payload) => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    })
    return { status: res.status, text: await res.text() }
  }

  const streamed = await chat({
    model: 'detail-model',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  })
  ok(streamed.status === 200 && streamed.text.includes('[DONE]'), `流式请求成功（状态 ${streamed.status}）`)

  const plain = await chat({ model: 'detail-model', messages: [{ role: 'user', content: 'hi' }] })
  ok(plain.status === 200, `非流式请求成功（状态 ${plain.status}）`)

  const missing = await chat({ model: 'fail-model', messages: [] })
  ok(missing.status === 502, `上游挂了返回 502（实际 ${missing.status}）`)

  // 决策日志是 2 秒攒批落盘的（AGENTS.md 里写的坑）
  await sleep(2500)

  const detail = await api('GET', '/api/usage/detail?days=1')
  const totals = detail.totals || {}
  ok(detail.requests.length === 3, `明细 3 条（实际 ${detail.requests.length}）`)
  ok(detail.window.missingUsage === 1, `其中 1 条没有 usage（实际 ${detail.window.missingUsage}）`)

  const streamRow = detail.requests.find((r) => r.outcome === 'ok' && r.stream === true)
  ok(Boolean(streamRow), '流式那条明细存在且标了 stream=true')
  ok(streamRow.protocol === 'chat', `协议记成 chat（实际 ${streamRow.protocol}）`)
  ok(streamRow.cached === 600 && streamRow.cacheCreation === 200, `缓存读 600 / 写 200（实际 ${streamRow.cached} / ${streamRow.cacheCreation}）`)
  ok(streamRow.reasoning === 20, `思考 token 20（实际 ${streamRow.reasoning}）`)
  ok(streamRow.input === 200, `输入净值 200（实际 ${streamRow.input}）`)
  ok(Math.abs(streamRow.cacheHitRate - 0.6) < 1e-9, `命中率 0.6（实际 ${streamRow.cacheHitRate}）`)
  ok(streamRow.ttftMs > 0 && streamRow.tps > 0, `首字 ${streamRow.ttftMs}ms、速度 ${streamRow.tps} tok/s`)

  const plainRow = detail.requests.find((r) => r.stream === false)
  ok(Boolean(plainRow) && plainRow.ttftMs === null && plainRow.tps === null, '非流式那条没有首字也没有速度')

  const failedRow = detail.requests.find((r) => r.outcome !== 'ok')
  ok(Boolean(failedRow) && failedRow.prompt === null, '失败那条没有 token（只贡献请求数）')

  // 汇总（usage.json）：缓存写入必须出现——addRow 漏字段时这里恒为 0
  ok(totals.requests === 3, `汇总请求数 3（实际 ${totals.requests}）`)
  ok(totals.errors === 1, `汇总错误 1（实际 ${totals.errors}）`)
  ok(totals.input === 300, `汇总输入 200+100=300（实际 ${totals.input}）`)
  ok(totals.output === 60, `汇总输出 50+10=60（实际 ${totals.output}）`)
  ok(totals.cached === 600, `汇总缓存读 600（实际 ${totals.cached}）`)
  ok(totals.cacheCreation === 200, `汇总缓存写 200（以前这里恒为 0，实际 ${totals.cacheCreation}）`)
  ok(totals.reasoning === 20, `汇总思考 token 20（实际 ${totals.reasoning}）`)
  ok(Math.abs(totals.cacheHitRate - 600 / 1100) < 1e-9, `汇总命中率 600/1100（实际 ${totals.cacheHitRate}）`)
  ok(totals.avgTps > 0, `汇总生成速度有值（实际 ${totals.avgTps} tok/s）`)

  // 老接口 /api/usage 拿到的也是同一份汇总（页面上的「缓存读/写」卡片吃它）
  const usage = await api('GET', '/api/usage?days=1')
  ok(usage.usage.totals.cacheCreation === 200, '/api/usage 的 totals 也带缓存写')
  ok(usage.usage.byModel['detail-model']?.cached === 600, 'byModel 切面也带缓存读')
} finally {
  await cleanup()
}

// ------------------------------------------------- 4. 老数据的速度补算
console.log('\n[4] 老数据（没有 genSum）也能看到生成速度')
{
  const legacyHome = await mkdtemp(join(tmpdir(), 'mapi-usage-legacy-'))
  const { writeFile } = await import('node:fs/promises')
  const { usageSummary, localDayKey } = await import('../core/usage.js')
  const day = localDayKey()
  const row = (extra = {}) => ({
    requests: 3,
    errors: 0,
    input: 1000,
    output: 300,
    cached: 0,
    cacheCreation: 0,
    inputIncludesCached: 0,
    latencySum: 9000,
    latencyCount: 3,
    ttftSum: 3000,
    ttftCount: 3,
    ...extra,
  })
  await writeFile(
    join(legacyHome, 'usage.json'),
    JSON.stringify({
      version: 1,
      days: {
        [day]: {
          // 全是流式请求 → 生成窗口 = 9000 − 3000，速度可算
          'k|p|all-stream': row(),
          // 混了非流式（ttftCount 少于 latencyCount）→ 补不出来，必须是 null
          'k|p|mixed': row({ latencyCount: 5, latencySum: 15000, ttftCount: 3, ttftSum: 3000 }),
          // 最老的行连 cacheCreation 字段都没有 → 不能变成 NaN
          'k|p|ancient': {
            requests: 1,
            errors: 0,
            input: 10,
            output: 5,
            cached: 0,
            latencySum: 1000,
            latencyCount: 1,
            ttftSum: 0,
            ttftCount: 0,
          },
        },
      },
    }),
  )
  process.env.MANAGE_API_HOME = legacyHome
  // usage.js 有模块级缓存，这里必须是本进程第一次读它（上面都走子进程）
  const summary = await usageSummary({ days: 1 })
  const byModel = summary.byModel
  ok(
    byModel['all-stream'].avgTps === 50,
    `全流式老行补出 300 ÷ 6s = 50 tok/s（实际 ${byModel['all-stream'].avgTps}）`,
  )
  ok(byModel.mixed.avgTps === null, '混合老行补不出速度，给 null 而不是瞎算')
  ok(
    Number.isFinite(byModel.ancient.cacheCreation) && byModel.ancient.cacheCreation === 0,
    `缺字段的老行汇总后是 0，不是 NaN（实际 ${byModel.ancient.cacheCreation}）`,
  )
  await rm(legacyHome, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n结果：${failed ? `失败 ${failed} 项` : '通过'}`)
// ------------------------------------------ 5. 明细筛选（站点 / 分组 / 模型）
console.log('')
console.log('[5] 筛选：三个维度 + 筛出的小计')
{
  const { facetsOf, matchRow, subtotalOf } = await import('../web/usage-filter.js')
  const rows = [
    // 有 usage 的流式请求
    { providerId: 'p1', providerName: '秋', group: '国模', model: 'm-a', input: 100, cached: 300, cacheCreation: 0, output: 50, ttftMs: 1000, genMs: 2000, latencyMs: 3000 },
    // 上游没回 usage：只该计请求数
    { providerId: 'p1', providerName: '秋', group: '国模', model: 'm-b', input: null, output: null, cached: null, cacheCreation: null, ttftMs: 800, genMs: null, latencyMs: 800 },
    // 另一个站的同名分组 + 同名模型，非流式（没有首字 / 生成窗口）
    { providerId: 'p2', providerName: '绿萝', group: '国模', model: 'm-a', input: 200, cached: 0, cacheCreation: 100, output: 10, ttftMs: null, genMs: null, latencyMs: 5000 },
  ]
  const facets = facetsOf(rows)
  ok(facets.providers.length === 2, `两个站点（实际 ${facets.providers.length}）`)
  ok(
    facets.groups.length === 2,
    `同名分组按站点分开算：两个「国模」而不是一个（实际 ${facets.groups.length}）`,
  )
  ok(facets.models.find((m) => m.name === 'm-a')?.count === 2, '模型 m-a 在两个站各有 1 条 → 2')

  const onlyP1 = rows.filter((r) => matchRow(r, { providerId: 'p1' }))
  ok(onlyP1.length === 2, `按站点筛出 2 条（实际 ${onlyP1.length}）`)
  const onlyP2Group = rows.filter((r) => matchRow(r, { group: { providerId: 'p2', name: '国模' } }))
  ok(
    onlyP2Group.length === 1 && onlyP2Group[0].providerId === 'p2',
    '按分组筛不会把另一个站的同名分组带进来',
  )
  ok(rows.filter((r) => matchRow(r, { model: 'm-a' })).length === 2, '按模型筛（跨站点）2 条')
  ok(
    rows.filter((r) => matchRow(r, { providerId: 'p1', model: 'm-b' })).length === 1,
    '站点 + 模型是「与」的关系',
  )

  const sub = subtotalOf(rows.filter((r) => matchRow(r, { providerId: 'p1' })))
  ok(
    sub.requests === 2 && sub.missingUsage === 1,
    `小计 2 条、其中 1 条缺 usage（实际 ${sub.requests} / ${sub.missingUsage}）`,
  )
  ok(sub.input === 100 && sub.cached === 300 && sub.output === 50, '缺 usage 的行不贡献 token')
  ok(Math.abs(sub.cacheHitRate - 0.75) < 1e-9, `命中率 300/(100+300)=0.75（实际 ${sub.cacheHitRate}）`)
  ok(sub.avgTps === 25, `速度 50 ÷ 2s = 25 tok/s（实际 ${sub.avgTps}）`)
  ok(sub.avgTtftMs === 900, `平均首字 (1000+800)/2 = 900（实际 ${sub.avgTtftMs}）`)

  const all = subtotalOf(rows)
  ok(all.avgTps === 25, `非流式行（没有生成窗口）不参与速度平均（实际 ${all.avgTps}）`)
  ok(
    Math.abs(all.cacheHitRate - 300 / 700) < 1e-9,
    `全量命中率 300/(输入 300 + 缓存读 300 + 缓存写 100)=300/700（实际 ${all.cacheHitRate}）`,
  )
}

process.exit(failed ? 1 : 0)
