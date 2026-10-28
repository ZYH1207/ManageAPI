/**
 * 空回合守卫端到端验证。
 *
 * 模拟现场：站 A 的工具调用被上游吞掉（流式返回：只有思考、无正文、无 tool_calls、
 * finish_reason=stop）。守卫应该：
 *   1. 关闭时——什么都不做，只记录（客户端拿到空回合）
 *   2. 开启 + 同站模式——拿同一个请求再问 A 一次，救回来
 *   3. 换站模式——换到 B，救回来
 *   4. 每次都落一条记录，界面接口能读出来
 *
 * 环境（与 run-gateway.mjs 同一套约定）：
 *   PORT=5104 MODE=empty EMPTY_ONCE=1  node .test/mock-upstream.mjs   # 只空第一次的站
 *   PORT=5105 MODE=good                node .test/mock-upstream.mjs   # 正常 B
 *   MANAGE_API_HOME=<临时目录> node daemon/index.js --port 4398
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:4398'
const MOCK_EMPTY = 'http://127.0.0.1:5104/v1'
const MOCK_GOOD = 'http://127.0.0.1:5105/v1'
const MOCK_LEAK = 'http://127.0.0.1:5106/v1'

const passed = []
function ok(cond, name) {
  passed.push([Boolean(cond), name])
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
  if (!cond) process.exitCode = 1
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 复位 mock 的「只空一次」计数器，否则第一个用例会把它用掉 */
async function resetMockEmpty() {
  await fetch(`${MOCK_EMPTY.replace('/v1', '')}/__reset`).catch(() => {})
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${path}: ${data.error || res.status}`)
  return data
}

// --------------------------------------------------------------- mock 站
const mocks = []
function startMock(port, mode, extraEnv = {}) {
  const child = spawn(process.execPath, ['.test/mock-upstream.mjs'], {
    env: { ...process.env, PORT: String(port), MODE: mode, ...extraEnv },
    stdio: 'ignore',
  })
  mocks.push(child)
  return child
}

// --------------------------------------------------------------- daemon
const home = mkdtempSync(join(tmpdir(), 'manageapi-empty-'))
let daemon
async function startDaemon() {
  daemon = spawn(process.execPath, ['daemon/index.js', '--port', '4398'], {
    env: { ...process.env, MANAGE_API_HOME: home, PORT: '4398' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  daemon.stderr.on('data', (d) => process.stderr.write(`[daemon] ${d}`))
  daemon.stdout.on('data', (d) => process.stdout.write(`[daemon] ${d}`))
  for (let i = 0; i < 60; i++) {
    try {
      await api('GET', '/api/health')
      return
    } catch {
      await wait(250)
    }
  }
  throw new Error('daemon 起不来')
}

// 带工具的流式请求：读完整条 SSE
async function gatewayStream(body) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayKey}` },
    body: JSON.stringify({ ...body, stream: true }),
  })
  const raw = await res.text()
  const events = raw
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const line = block.split('\n').find((l) => l.startsWith('data:'))
      if (!line) return null
      const text = line.slice(5).trim()
      if (text === '[DONE]') return { done: true }
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  return { status: res.status, raw, events, provider: res.headers.get('x-manageapi-provider') }
}

let gatewayKey = ''
let tempProviderA
let tempProviderB

try {
  startMock(5104, 'empty', { EMPTY_ONCE: '1' })
  startMock(5105, 'good')
  startMock(5106, 'leak', { EMPTY_ONCE: '1' })
  await startDaemon()
  await wait(500)

  let state = await api('GET', '/api/state')
  gatewayKey = state.gateway.keys.find((k) => k.enabled)?.key
  if (!gatewayKey) throw new Error('没有网关 Key')

  // 站 A：便宜但空回合；站 B：正常。A 便宜会被排前面
  state = await api('POST', '/api/providers', { name: '空回合A', baseUrl: MOCK_EMPTY })
  tempProviderA = state.providers.find((p) => p.name === '空回合A')
  await api('POST', '/api/credentials', { providerId: tempProviderA.id, label: 'k', secret: `sk-${tempProviderA.id}` })
  state = await api('POST', '/api/providers', { name: '正常B', baseUrl: MOCK_GOOD })
  tempProviderB = state.providers.find((p) => p.name === '正常B')
  await api('POST', '/api/credentials', { providerId: tempProviderB.id, label: 'k', secret: `sk-${tempProviderB.id}` })
  // 同步模型 + 探针给速度样本
  await api('POST', `/api/providers/${tempProviderA.id}/sync`, {})
  await api('POST', `/api/providers/${tempProviderB.id}/sync`, {})
  // mock 站没有报官方价：给两个模型填上手动价，否则全部落进「未定价」，
  // 不参与比价排序，网关就没了候选顺序（A 便宜排第一的剧本演不起来）
  state = await api('GET', '/api/state')
  for (const offer of state.offers) {
    const price = offer.providerId === tempProviderA.id ? { inPrice: 1, outPrice: 2 } : { inPrice: 4, outPrice: 8 }
    const before = { pricingMode: offer.pricingMode, inPrice: offer.inPrice }
    const after = await api('PATCH', `/api/offers/${offer.id}`, { pricingMode: 'manual', ...price })
    const patched = (after.offers || []).find((o) => o.id === offer.id) || {}
  }
  // 只探 B：A 的「空回合」在探针眼里是指纹不符（它答不上来），会被判可疑挡在准入外。
  // A 不探测 = 零证据 = 准入放行（排后面当兜底），正好演「便宜但坏」的剧本
  await api('POST', '/api/probes/run', { providerId: tempProviderB.id, limit: 5 })
  // 手动排序把 A 顶到第一（决策页拖拽那套）：A 没探过 routable=false，
  // 只能靠手动顺序排前面；准入是放行的（零证据照样登场兜底）
  state = await api('GET', '/api/state')
  const modelAOffers = state.offers.filter((o) => o.modelKey === 'test-model-a')
  const idA = modelAOffers.find((o) => o.providerId === tempProviderA.id)?.id
  const idB = modelAOffers.find((o) => o.providerId === tempProviderB.id)?.id
  await api('PUT', '/api/decisions/test-model-a/order', { order: [idA, idB] })
  await wait(300)

  const TOOLS = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    },
  ]

  // 看看实际选站顺序（A 应该排第一，因为最便宜）

  // ---- 1. 守卫关闭：只记录，不补问 ----
  console.log('\n[1] 守卫关闭：空回合只记录')
  await api('PATCH', '/api/diagnostics', { enabled: false, mode: 'same' })
  const off1 = await gatewayStream({
    model: 'test-model-a',
    messages: [{ role: 'user', content: 'read /tmp/x' }],
    tools: TOOLS,
  })
  ok(off1.status === 200, '请求本身成功（上游谎报成功）')
  const off1Text = off1.events
    .filter((e) => e.choices?.[0]?.delta?.content)
    .map((e) => e.choices[0].delta.content)
    .join('')
  ok(off1Text === '', '守卫关着，客户端拿到的就是空回合（不干预）')
  await wait(2600) // 等记录落盘
  let diag = await api('GET', '/api/diagnostics')
  ok(diag.summary.total >= 1, '空回合被记录下来了')
  ok(diag.summary.off >= 1, '记录标着「守卫关闭，未处置」')
  ok(diag.summary.toolCallDropped >= 1, '病型判成 tool-call-dropped（带了 tools 却不调）')

  // ---- 2. 守卫开启 + 同站补问：第二次问 A，A 正常了，救回 ----
  console.log('\n[2] 守卫开启 + 同站补问')
  await resetMockEmpty()
  await api('PATCH', '/api/diagnostics', { enabled: true, mode: 'same' })
  await wait(300) // 给 mtime 缓存留出失效窗口
  const on1 = await gatewayStream({
    model: 'test-model-a',
    messages: [{ role: 'user', content: 'read /tmp/x' }],
    tools: TOOLS,
  })
  const on1Text = on1.events
    .filter((e) => e.choices?.[0]?.delta?.content)
    .map((e) => e.choices[0].delta.content)
    .join('')
  ok(on1Text.includes('ok'), '补问救回了正文')
  const on1Reasoning = on1.events.filter((e) => e.choices?.[0]?.delta?.reasoning_content)
  // mock 的第一次尝试吐 2 条思考、第二次吐 0 条；如果过滤器失效，第二次正常回答的
  // 思考也会被转发。这里断言「没有出现第二轮的思考」——即总数不超过第一次的 2 条
  ok(on1Reasoning.length <= 2, '补问的思考没有重复转发（第一段的思考保留，第二段的丢掉）')
  const on1Done = on1.events.filter((e) => e.done).length
  ok(on1Done === 1, '只有一次收尾，客户端不乱')
  await wait(2600)
  diag = await api('GET', '/api/diagnostics')
  const recovered = diag.events.find((e) => e.recovered)
  ok(recovered, '记录里有「已救回」的一条')
  ok(recovered?.action === 'retry-same', '处置方式是「同站补问」')

  // ---- 3. 换站模式：直接走 B ----
  console.log('\n[3] 换一家补问')
  await resetMockEmpty()
  await api('PATCH', '/api/diagnostics', { enabled: true, mode: 'switch' })
  await wait(300)
  const on2 = await gatewayStream({
    model: 'test-model-a',
    messages: [{ role: 'user', content: 'read /tmp/y' }],
    tools: TOOLS,
  })
  const on2Text = on2.events
    .filter((e) => e.choices?.[0]?.delta?.content)
    .map((e) => e.choices[0].delta.content)
    .join('')
  ok(on2Text.includes('ok'), '换到 B 后拿到正文')
  // 响应头在第一次 writeHead 时就发出去了（标着 A），HTTP 层没法事后改。
  // 真正能说明「第二次打的是谁」的证据在记录里：recoveredBy 记着兜底那家的名字
  ok(decodeURIComponent(on2.provider) === '空回合A', '响应头是第一次尝试的站（HTTP 头不能事后改）')
  await wait(2600)
  diag = await api('GET', '/api/diagnostics')
  const switched = diag.events.find((e) => e.action === 'retry-switch')
  ok(switched, '记录里有「换一家补问」的一条')
  ok(diag.detours.some((d) => d.providerName === '空回合A' && d.replacedByProviderName === '正常B'), '改道账建起来了：A → B')

  // ---- 4. 开关接口的自洽 ----
  console.log('\n[4] 配置接口')
  await api('PATCH', '/api/diagnostics', { enabled: false, mode: 'switch' })
  diag = await api('GET', '/api/diagnostics')
  ok(diag.guard.enabled === false && diag.guard.mode === 'switch', '开关与模式都能读回')
  let badMode = false
  try {
    await api('PATCH', '/api/diagnostics', { mode: 'nonsense' })
  } catch {
    badMode = true
  }
  ok(badMode, '非法模式被拒绝')

  // ---- 5. 清空记录 ----
  console.log('\n[5] 清空')
  await api('DELETE', '/api/diagnostics/events')
  diag = await api('GET', '/api/diagnostics')
  ok(diag.summary.total === 0 && diag.events.length === 0, '记录清空后归零')
  ok(diag.guard.enabled === false, '开关不受清空影响')

  // ---- 6. 本地重建：上游把方言漏进正文，网关自己拼回 tool_calls ----
  console.log('\n[6] 本地解析重建（不问模型）')
  await resetMockEmpty()
  state = await api('GET', '/api/state')
  if (!state.providers.some((p) => p.name === '方言泄漏C')) {
    state = await api('POST', '/api/providers', { name: '方言泄漏C', baseUrl: MOCK_LEAK })
    const pcNew = state.providers.find((p) => p.name === '方言泄漏C')
    await api('POST', '/api/credentials', { providerId: pcNew.id, label: 'k', secret: `sk-${pcNew.id}` })
    await api('POST', `/api/providers/${pcNew.id}/sync`, {})
  }
  state = await api('GET', '/api/state')
  const pc = state.providers.find((p) => p.name === '方言泄漏C')
  for (const offer of state.offers.filter((o) => o.providerId === pc.id)) {
    await api('PATCH', `/api/offers/${offer.id}`, { pricingMode: 'manual', inPrice: 6, outPrice: 9 })
  }
  const mA2 = state.offers.filter((o) => o.modelKey === 'test-model-a')
  await api('PUT', '/api/decisions/test-model-a/order', {
    order: [mA2.find((o) => o.providerId === pc.id)?.id, ...mA2.filter((o) => o.providerId !== pc.id).map((o) => o.id)],
  })
  await api('PATCH', '/api/diagnostics', { enabled: true, mode: 'same' })
  await wait(300)
  const leak = await gatewayStream({
    model: 'test-model-a',
    messages: [{ role: 'user', content: 'read /tmp/leak.txt' }],
    tools: TOOLS,
  })
  ok(decodeURIComponent(leak.provider) === '方言泄漏C', '请求落到方言泄漏站')
  const leakCalls = leak.events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls || [])
  ok(leakCalls.length === 1, `客户端拿到了重建出来的 tool_calls（实际 ${leakCalls.length}）`)
  ok(leakCalls[0]?.function?.name === 'read_file', '工具名是 read_file')
  ok(JSON.parse(leakCalls[0]?.function?.arguments || '{}').path === '/tmp/leak.txt', '参数是 /tmp/leak.txt')
  const leakFinish = leak.events.find((e) => e.choices?.[0]?.finish_reason)
  ok(leakFinish?.choices?.[0]?.finish_reason === 'tool_calls', '收尾改成了 tool_calls（不是 stop）')
  await wait(2600)
  diag = await api('GET', '/api/diagnostics')
  const repaired = diag.events.find((e) => e.action === 'repaired-local')
  ok(repaired, '记录里有一条「本地重建」')
  ok(repaired?.recovered === true, '而且是已救回（没花补问的钱）')


  console.log(`\n${passed.every((p) => p[0]) ? '全部通过 ✓' : '有失败 ✗'}`)
} catch (error) {
  console.error('\n测试执行失败：', error)
  process.exitCode = 1
} finally {
  for (const child of mocks) child.kill()
  if (daemon) daemon.kill()
}
