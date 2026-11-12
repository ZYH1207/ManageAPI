/**
 * Anthropic Messages 适配验证（端到端，自带 mock 上游 + 临时数据目录）。
 *
 * 验的是「客户端说 Anthropic、上游只会 Chat」这条路上真正会踩的坑：
 *   1. 非流式：Chat 的 choices[0].message → Anthropic 的 content 块数组 + stop_reason
 *   2. 流式：Chat 的 `data:` 增量 → Anthropic 的 `event:` 序列，且顺序合法
 *      （message_start → content_block_start → delta → stop → message_delta → message_stop）
 *   3. 请求方向：system 顶层 / content 块数组 / tool_use / tool_result / input_schema
 *      真的被翻成了 Chat 形状（用 mock 记下收到的 body 断言，不靠猜）
 *   4. tool_use：上游 tool_calls → content[].type='tool_use'，stop_reason='tool_use'
 *   5. 鉴权：x-api-key 也能过（Claude Code 的原生写法），失败时回 Anthropic 错误信封
 *   6. usage：input_tokens 是净值、缓存单列（cache_read_input_tokens）
 *   7. 回归：老的 /v1/chat/completions 仍是 Chat 形状，没被这层改坏
 *   8. 上游全挂：502 但 body 是 Anthropic 信封，客户端认得出 error.type
 *
 * 用法：node .test/check-anthropic-gateway.mjs
 */
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// ------------------------------------------------------------------ mock 上游
// 只提供 /v1/chat/completions（绝大多数中转站就是这样），并把收到的 body 记下来
// 给断言用：请求方向的翻译对不对，只能看上游真正收到了什么。

function startMock(port) {
  const state = { lastBody: null, mode: 'text', calls: 0, emptyCount: 0 }
  const server = createHttpServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      body = {}
    }
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'test-model-a' }] }))
      return
    }
    if (req.url.includes('/__state')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(state))
      return
    }
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    state.lastBody = body
    state.calls += 1

    if (state.mode === 'fail') {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'mock upstream exploded', type: 'server_error' } }))
      return
    }

    // 空回合：第一次一个字都不吐，第二次正常。用来验空回合守卫与 Anthropic 出口
    // 能不能共存——补问会把「第二次」的帧接在后面，客户端不该看到两个 message_start
    if (state.mode === 'empty-once' && state.emptyCount === 0) {
      state.emptyCount += 1
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const emitEmpty = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      setTimeout(() => {
        emitEmpty({ choices: [{ index: 0, delta: { role: 'assistant' } }] })
        emitEmpty({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        emitEmpty({
          choices: [],
          usage: { prompt_tokens: 30, completion_tokens: 1, total_tokens: 31 },
        })
        res.write('data: [DONE]\n\n')
        res.end()
      }, 10)
      return
    }

    const usage = {
      prompt_tokens: 120,
      completion_tokens: 8,
      total_tokens: 128,
      prompt_tokens_details: { cached_tokens: 100 },
    }
    const wantsTool = Array.isArray(body.tools) && body.tools.length > 0 && state.mode === 'tool'
    const text = 'hello from chat upstream'

    if (body.stream !== true) {
      const message = wantsTool
        ? {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_mock_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"/tmp/a.txt"}' },
              },
            ],
          }
        : { role: 'assistant', content: text }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model: body.model,
          choices: [
            {
              index: 0,
              message,
              finish_reason: wantsTool ? 'tool_calls' : 'stop',
            },
          ],
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
      // 第一个块只有 role，没有任何正文——网关会先 hold 住，不该提前提交
      emit({ choices: [{ index: 0, delta: { role: 'assistant' } }] })
      if (wantsTool) {
        // **交错**的两路并行工具调用：这是 OpenAI 流的真实形状，也是 Anthropic
        // 的串行块最容易踩崩的地方（边收边发会让 delta 落到已关闭的块上）
        emit({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_mock_1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } },
                  { index: 1, id: 'call_mock_2', type: 'function', function: { name: 'write_file', arguments: '{"pa' } },
                ],
              },
            },
          ],
        })
        emit({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: 'th":"/tmp/a.txt"}' } },
                  { index: 1, function: { arguments: 'th":"/tmp/b.txt"}' } },
                ],
              },
            },
          ],
        })
        emit({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        for (const piece of ['hello ', 'from ', 'chat ', 'upstream']) {
          emit({ choices: [{ index: 0, delta: { content: piece } }] })
        }
        emit({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
      emit({ choices: [], usage })
      res.write('data: [DONE]\n\n')
      res.end()
    }, 20)
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, state }))
  })
}

/** 读 SSE 文本 → [{ event, data }] */
function parseSse(text) {
  const events = []
  for (const block of String(text).split('\n\n')) {
    if (!block.trim()) continue
    let event = null
    const dataLines = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (!dataLines.length) continue
    const raw = dataLines.join('\n')
    let data = raw
    try {
      data = JSON.parse(raw)
    } catch {
      /* 保持原样 */
    }
    events.push({ event, data })
  }
  return events
}

const home = await mkdtemp(join(tmpdir(), 'mapi-anthropic-'))
const mockPort = await freePort()
const daemonPort = await freePort()
let mock = null
let daemon = null
let daemonOut = ''

try {
  const started = await startMock(mockPort)
  mock = started.server
  const mockState = started.state

  daemon = spawn(process.execPath, [join(ROOT, 'daemon/index.js'), '--port', String(daemonPort)], {
    cwd: ROOT,
    env: { ...process.env, MANAGE_API_HOME: home, MANAGE_API_BACKUP_DIR: join(home, 'backups') },
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
  console.log(`\n实例 ${base}（mock ${mockPort}）`)
  await api(base, 'PATCH', '/api/settings', { probeIntervalMinutes: 0, monitorIntervalMinutes: 0 })

  let state = await api(base, 'GET', '/api/state')
  await api(base, 'POST', '/api/providers', { name: '只给chat', baseUrl: `http://127.0.0.1:${mockPort}/v1` })
  state = await api(base, 'GET', '/api/state')
  const provider = state.providers.find((p) => p.name === '只给chat')
  await api(base, 'POST', '/api/credentials', { providerId: provider.id, label: '主Key', secret: 'sk-test' })
  await api(base, 'POST', `/api/providers/${provider.id}/sync`, {})
  state = await api(base, 'GET', '/api/state')
  const offer = state.offers.find((o) => o.modelKey === 'test-model-a')
  await api(base, 'PATCH', `/api/offers/${offer.id}`, {
    inPrice: 1,
    outPrice: 4,
    currency: 'CNY',
    ratio: null,
    pricingMode: 'manual',
  })
  const key = state.gateway.keys[0].key

  const anthropic = (path, body, headers = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, ...headers },
      body: JSON.stringify(body),
    })

  // ---------------------------------------------------------------- [1] 非流式
  console.log('\n[1] 非流式 /v1/messages：Chat 响应 → Anthropic Message')
  mockState.mode = 'text'
  const res1 = await anthropic('/v1/messages', {
    model: 'test-model-a',
    max_tokens: 64,
    system: '你是测试助手',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  })
  const body1 = await res1.json().catch(() => null)
  ok(res1.status === 200, `HTTP ${res1.status}`)
  ok(body1?.type === 'message', `type=${body1?.type}`)
  ok(body1?.role === 'assistant', `role=${body1?.role}`)
  ok(
    Array.isArray(body1?.content) && body1.content[0]?.type === 'text' && body1.content[0].text === 'hello from chat upstream',
    `content=${JSON.stringify(body1?.content)}`,
  )
  ok(body1?.stop_reason === 'end_turn', `stop_reason=${body1?.stop_reason}`)
  ok(body1?.usage?.input_tokens === 20, `input_tokens=${body1?.usage?.input_tokens}（净值 = 120-100）`)
  ok(body1?.usage?.output_tokens === 8, `output_tokens=${body1?.usage?.output_tokens}`)
  ok(body1?.usage?.cache_read_input_tokens === 100, `cache_read_input_tokens=${body1?.usage?.cache_read_input_tokens}`)

  console.log('\n[2] 请求方向：system 顶层 → messages[0].role=system')
  const seen1 = mockState.lastBody
  ok(seen1?.messages?.[0]?.role === 'system', `上游第一条 role=${seen1?.messages?.[0]?.role}`)
  ok(seen1?.messages?.[0]?.content === '你是测试助手', `上游 system 正文=${JSON.stringify(seen1?.messages?.[0]?.content)}`)
  ok(seen1?.max_tokens === 64, `上游 max_tokens=${seen1?.max_tokens}`)
  ok(seen1?.messages?.[1]?.content === '你好', `上游 user 正文=${JSON.stringify(seen1?.messages?.[1]?.content)}（纯文本压成字符串）`)

  // ---------------------------------------------------------------- [3] 流式
  console.log('\n[3] 流式：事件序列必须是 Anthropic 的合法顺序')
  const res3 = await anthropic('/v1/messages', {
    model: 'test-model-a',
    max_tokens: 64,
    stream: true,
    messages: [{ role: 'user', content: '你好' }],
  })
  const text3 = await res3.text()
  const events3 = parseSse(text3)
  const names3 = events3.map((e) => e.event)
  ok(res3.status === 200, `HTTP ${res3.status}`)
  ok(
    names3[0] === 'message_start',
    `首事件=${names3[0]}（不能是 content_block_*，客户端要求先有 message）`,
  )
  ok(names3.includes('content_block_start'), `含 content_block_start：${names3.join(',')}`)
  ok(names3.includes('content_block_stop'), '含 content_block_stop')
  ok(
    names3[names3.length - 2] === 'message_delta' && names3[names3.length - 1] === 'message_stop',
    `收尾=${names3.slice(-2).join(',')}`,
  )
  ok(!names3.includes('data'), '所有帧都带 event: 名（不是裸 data）')
  const textDeltas = events3
    .filter((e) => e.event === 'content_block_delta' && e.data?.delta?.type === 'text_delta')
    .map((e) => e.data.delta.text)
    .join('')
  ok(textDeltas === 'hello from chat upstream', `增量拼起来=${JSON.stringify(textDeltas)}`)
  const msgDelta = events3.find((e) => e.event === 'message_delta')
  ok(msgDelta?.data?.delta?.stop_reason === 'end_turn', `message_delta.stop_reason=${msgDelta?.data?.delta?.stop_reason}`)
  ok(msgDelta?.data?.usage?.output_tokens === 8, `message_delta.usage.output_tokens=${msgDelta?.data?.usage?.output_tokens}`)
  ok(
    /event: message_start[\s\S]*?event: content_block_start[\s\S]*?event: content_block_stop/.test(text3),
    '原始字节里顺序是 start → block_start → block_stop',
  )

  // ---------------------------------------------------------------- [4] 工具调用
  console.log('\n[4] 工具调用：tools/input_schema → 上游 function.parameters，回来是 tool_use 块')
  mockState.mode = 'tool'
  const tools = [
    {
      name: 'read_file',
      description: '读文件',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ]
  const res4 = await anthropic('/v1/messages', {
    model: 'test-model-a',
    max_tokens: 64,
    tools,
    tool_choice: { type: 'any' },
    messages: [
      { role: 'user', content: '读一下 /tmp/a.txt' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: '/tmp/a.txt' } }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '文件内容' }] }],
      },
    ],
  })
  const body4 = await res4.json().catch(() => null)
  const block4 = (body4?.content || []).find((b) => b.type === 'tool_use')
  ok(res4.status === 200, `HTTP ${res4.status}`)
  ok(block4?.name === 'read_file', `tool_use.name=${block4?.name}`)
  ok(block4?.input?.path === '/tmp/a.txt', `tool_use.input=${JSON.stringify(block4?.input)}（字符串参数被解析成对象）`)
  ok(body4?.stop_reason === 'tool_use', `stop_reason=${body4?.stop_reason}`)

  const seen4 = mockState.lastBody
  ok(seen4?.tools?.[0]?.function?.name === 'read_file', `上游 tools[0].function.name=${seen4?.tools?.[0]?.function?.name}`)
  ok(
    seen4?.tools?.[0]?.function?.parameters?.properties?.path?.type === 'string',
    'input_schema 原样落到 function.parameters',
  )
  ok(seen4?.tool_choice === 'required', `tool_choice any → ${JSON.stringify(seen4?.tool_choice)}`)
  const toolMsg = (seen4?.messages || []).find((m) => m.role === 'tool')
  ok(toolMsg?.tool_call_id === 'toolu_1', `tool_result 回放成 role=tool（tool_call_id=${toolMsg?.tool_call_id}）`)
  ok(toolMsg?.content === '文件内容', `tool 消息正文=${JSON.stringify(toolMsg?.content)}`)
  const assistantMsg = (seen4?.messages || []).find((m) => m.role === 'assistant')
  ok(
    assistantMsg?.tool_calls?.[0]?.function?.name === 'read_file',
    `assistant 历史里的 tool_use → tool_calls（${assistantMsg?.tool_calls?.[0]?.function?.name}）`,
  )
  const order = (seen4?.messages || []).map((m) => m.role).join(',')
  ok(order === 'user,assistant,tool', `上游消息顺序=${order}（tool 必须紧跟 assistant）`)

  // ---------------------------------------------------------------- [5] 流式工具
  console.log('\n[5] 流式并行工具调用：两路交错 → 两个串行 tool_use 块，delta 不落到已关闭的块')
  const res5 = await anthropic('/v1/messages', {
    model: 'test-model-a',
    max_tokens: 64,
    stream: true,
    tools,
    messages: [{ role: 'user', content: '读文件' }],
  })
  const events5 = parseSse(await res5.text())
  const toolStarts5 = events5.filter(
    (e) => e.event === 'content_block_start' && e.data?.content_block?.type === 'tool_use',
  )
  ok(toolStarts5.length === 2, `tool_use 块数=${toolStarts5.length}`)
  ok(
    toolStarts5[0]?.data?.content_block?.name === 'read_file' &&
      toolStarts5[1]?.data?.content_block?.name === 'write_file',
    `块名顺序=${toolStarts5.map((e) => e.data.content_block.name).join(',')}`,
  )
  const partials5 = events5
    .filter((e) => e.event === 'content_block_delta' && e.data?.delta?.type === 'input_json_delta')
    .map((e) => ({ index: e.data.index, json: e.data.delta.partial_json }))
  const byIndex5 = new Map()
  for (const p of partials5) byIndex5.set(p.index, (byIndex5.get(p.index) || '') + p.json)
  const arg0 = byIndex5.get(toolStarts5[0]?.data?.index)
  const arg1 = byIndex5.get(toolStarts5[1]?.data?.index)
  ok(arg0 === '{"path":"/tmp/a.txt"}', `块0 参数=${arg0}`)
  ok(arg1 === '{"path":"/tmp/b.txt"}', `块1 参数=${arg1}`)

  // 结构性校验：每个 index 必须「start → delta* → stop」成对出现，且 delta 不能出现在 stop 之后
  const timeline = events5
    .filter((e) => e.event.startsWith('content_block_'))
    .map((e) => `${e.event}:${e.data?.index}`)
  const open5 = new Set()
  let structureOk = true
  for (const step of timeline) {
    const [kind, index] = step.split(':')
    if (kind === 'content_block_start') {
      if (open5.has(index)) structureOk = false
      open5.add(index)
    } else if (kind === 'content_block_stop') {
      if (!open5.has(index)) structureOk = false
      open5.delete(index)
    } else if (!open5.has(index)) {
      structureOk = false // delta 落在已关闭（或从未开启）的块上
    }
  }
  ok(structureOk, `块生命周期合法：${timeline.join(' → ')}`)
  ok(open5.size === 0, '收尾时没有未关闭的块')
  const stop5 = events5.find((e) => e.event === 'message_delta')
  ok(stop5?.data?.delta?.stop_reason === 'tool_use', `stop_reason=${stop5?.data?.delta?.stop_reason}`)

  // ---------------------------------------------------------------- [6] 鉴权
  console.log('\n[6] 鉴权：x-api-key 能过，错误 key 回 Anthropic 信封')
  const res6a = await anthropic('/v1/messages', {
    model: 'test-model-a',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  })
  ok(res6a.status === 200, `x-api-key 鉴权 HTTP ${res6a.status}`)

  const res6b = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'sk-not-a-gateway-key' },
    body: JSON.stringify({ model: 'test-model-a', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const body6b = await res6b.json().catch(() => null)
  ok(res6b.status === 401, `错 key HTTP ${res6b.status}`)
  ok(body6b?.type === 'error', `错 key 信封 type=${body6b?.type}`)
  ok(body6b?.error?.type === 'authentication_error', `error.type=${body6b?.error?.type}`)

  console.log('\n[7] 缺 max_tokens：本地 400，不白打上游')
  const callsBefore = mockState.calls
  const res7 = await anthropic('/v1/messages', {
    model: 'test-model-a',
    messages: [{ role: 'user', content: 'hi' }],
  })
  const body7 = await res7.json().catch(() => null)
  ok(res7.status === 400, `HTTP ${res7.status}`)
  ok(body7?.error?.type === 'invalid_request_error', `error.type=${body7?.error?.type}`)
  ok(mockState.calls === callsBefore, `上游调用数没变（${mockState.calls}）`)

  // ---------------------------------------------------------------- [8] count_tokens
  console.log('\n[8] /v1/messages/count_tokens 本地估算，不打上游')
  const res8 = await anthropic('/v1/messages/count_tokens', {
    model: 'test-model-a',
    messages: [{ role: 'user', content: '你好世界' }],
  })
  const body8 = await res8.json().catch(() => null)
  ok(res8.status === 200, `HTTP ${res8.status}`)
  ok(typeof body8?.input_tokens === 'number' && body8.input_tokens > 0, `input_tokens=${body8?.input_tokens}`)
  ok(mockState.calls === callsBefore, `上游调用数没变（${mockState.calls}）`)

  // ---------------------------------------------------------------- [9] 上游全挂
  console.log('\n[9] 上游全挂：502 也是 Anthropic 信封')
  mockState.mode = 'fail'
  const res9 = await anthropic('/v1/messages', {
    model: 'test-model-a',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  })
  const body9 = await res9.json().catch(() => null)
  ok(res9.status === 502 || res9.status === 503, `HTTP ${res9.status}`)
  ok(body9?.type === 'error' && typeof body9?.error?.type === 'string', `信封=${JSON.stringify(body9).slice(0, 120)}`)
  ok(!body9?.error?.code, '没有 OpenAI 的 code 字段（是 Anthropic 信封）')

  // ---------------------------------------------------------------- [10] 空回合补问
  console.log('\n[10] 空回合补问：第一次空、第二次正常，客户端只该看到一个 message_start')
  await api(base, 'PATCH', '/api/diagnostics', { enabled: true, mode: 'same' })
  mockState.mode = 'empty-once'
  mockState.emptyCount = 0
  const res10 = await anthropic('/v1/messages', {
    model: 'test-model-a',
    max_tokens: 64,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })
  const textEmpty = await res10.text()
  const eventsEmpty = parseSse(textEmpty)
  const namesEmpty = eventsEmpty.map((e) => e.event)
  ok(res10.status === 200, `HTTP ${res10.status}`)
  ok(
    namesEmpty.filter((n) => n === 'message_start').length === 1,
    `message_start 出现 ${namesEmpty.filter((n) => n === 'message_start').length} 次（补问接在后面，不能重开一轮）`,
  )
  ok(
    namesEmpty.filter((n) => n === 'message_stop').length === 1,
    `message_stop 出现 ${namesEmpty.filter((n) => n === 'message_stop').length} 次`,
  )
  const textEmptyAll = eventsEmpty
    .filter((e) => e.event === 'content_block_delta' && e.data?.delta?.type === 'text_delta')
    .map((e) => e.data.delta.text)
    .join('')
  ok(textEmptyAll === 'hello from chat upstream', `补问救回来的正文=${JSON.stringify(textEmptyAll)}`)
  ok(mockState.calls >= 2, `上游被打了 ${mockState.calls} 次（空回合 → 补问）`)
  await api(base, 'PATCH', '/api/diagnostics', { enabled: false, mode: 'same' })

  // ---------------------------------------------------------------- [11] 回归
  console.log('\n[11] 回归：/v1/chat/completions 仍是 Chat 形状')
  mockState.mode = 'text'
  const res11 = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'test-model-a', messages: [{ role: 'user', content: 'hi' }], stream: false }),
  })
  const body11 = await res11.json().catch(() => null)
  ok(res11.status === 200, `HTTP ${res11.status}`)
  ok(Array.isArray(body11?.choices), `choices 还在（${JSON.stringify(body11?.choices?.[0]?.message?.content)}）`)
  ok(body11?.object === 'chat.completion', `object=${body11?.object}`)
  ok(body11?.type === undefined, '没有 Anthropic 的 type 字段')

  const res11s = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'test-model-a', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })
  const text11s = await res11s.text()
  ok(/^data: \{/.test(text11s.trim()), `流式仍是裸 data: 帧（首行 ${JSON.stringify(text11s.slice(0, 20))}）`)
  ok(!/event: message_start/.test(text11s), '流式没有被套上 Anthropic 事件')
} finally {
  killTree(daemon?.pid)
  if (mock) mock.close()
  await sleep(200)
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
