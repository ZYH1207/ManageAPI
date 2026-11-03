/**
 * 流式可靠性回归：半帧、多帧粘连、/responses、慢客户端、收尾块。
 *
 * ## 为什么要有这个测试
 *
 * 交接报告 N05 的原话是「不应宣称全面通过」：流式链路只验过「能跑通」，
 * 下面这些边界从来没有可重复的假上游测试：
 *
 *   ① SSE 帧被 TCP 切碎（`data: {...` 和 `}\n\n` 分在两个 chunk 里）
 *   ② 一帧里粘了多条事件（上游一次写出 `\n\n\n\n` 分隔的多帧）
 *   ③ `/v1/responses` 协议（事件名、response.completed、DONE 形状都和 chat 不同）
 *   ④ 慢客户端：下游不读，`res.write()` 返回 false，必须等 `drain` 而不是
 *      继续灌——灌下去就是内存暴涨，最后 OOM 或者截断
 *   ⑤ 收尾：正常结束必须有终止信号；没有的话客户端会一直挂着
 *
 * 每一条都用**真** daemon + 假上游，落在 mktemp 目录，不碰线上、不花钱。
 *
 * ## 判定口径
 *
 * 不看「有没有报错」，看**客户端收到的字节**：帧完整、顺序对、有终止、
 * 粘帧与碎帧都能被还原。这比「日志里没有异常」结实得多——断流时日志也常常干净。
 *
 * 用法：node .test/check-stream-reliability.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let n = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  n += 1
  console.log(`  ✓ ${label}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const freePort = async () => {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** 把一段文本按字节切成若干块（模拟 TCP 任意切分，含切在帧中间） */
const slices = (text, size) => {
  const buf = Buffer.from(text, 'utf8')
  const out = []
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size))
  return out
}

const CHAT_FRAMES = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"你好"}}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"，世界"}}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n',
  'data: [DONE]\n\n',
]

// /responses 的帧形状和 chat 完全不同：靠 event: 名 + response.completed 收尾
const RESP_FRAMES = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"r1","status":"in_progress"}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好"}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"世界"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":3,"output_tokens":4}}}\n\n',
]

const UP_PORT = await freePort()
const APP_PORT = await freePort()
const HOME = await mkdtemp(join(tmpdir(), 'mapi-stream-'))

/** 假上游行为由 mode 决定；每个 mode 对应上面一个边界 */
let mode = 'chat-normal'
let upstream = null

function startUpstream() {
  upstream = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ id: 'gpt-x' }, { id: 'gpt-r' }] }))
    }
    const isResp = url.pathname.endsWith('/responses')
    if (!url.pathname.endsWith('/chat/completions') && !isResp) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      return res.end('{}')
    }
    let raw = ''
    req.on('data', (c) => {
      raw += c.toString()
    })
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        /* 空 body 当非流式 */
      }

      // 非流式必须回真 JSON，否则「502 也算通过」的断言没有区分力
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        if (isResp) {
          return res.end(
            JSON.stringify({
              id: 'r1',
              object: 'response',
              status: 'completed',
              output: [
                { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好世界' }] },
              ],
              usage: { input_tokens: 3, output_tokens: 4 },
            }),
          )
        }
        return res.end(
          JSON.stringify({
            id: 'c1',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: '你好世界' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          }),
        )
      }

      // 大批量流：1200 帧 × 48KB ≈ 57MB。客户端会先完全停止读取 3 秒，
      // 上游继续猛灌 → 网关的 res.write 必然返回 false。
      // 此时「等 drain」网关只缓存几 MB；不等 drain 就会把整个 57MB 堆在内存里。
      const pad = 'x'.repeat(48 * 1024)
      const frames = mode === 'bulk'
        ? [
            ...Array.from({ length: 1200 }, (_, i) =>
              `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"块${i}。${pad}"}}]}\n\n`),
            'data: [DONE]\n\n',
          ]
        : isResp ? RESP_FRAMES : CHAT_FRAMES
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })

      if (mode === 'chat-normal' || mode === 'resp-normal' || mode === 'bulk') {
        for (const f of frames) res.write(f)
        return res.end()
      }

      // ① 逐帧切碎：每个 data 帧再切成 7 字节一段，切点必然落在帧中间
      if (mode === 'chopped') {
        const all = frames.join('')
        let i = 0
        const step = () => {
          if (i >= all.length) return res.end()
          const buf = Buffer.from(all.slice(i, i + 7), 'utf8')
          i += 7
          res.write(buf)
          // 异步推进，制造真正独立的 TCP 段
          setImmediate(step)
        }
        return step()
      }

      // ② 粘帧：一次性写出全部帧（上游一次 flush），网关必须自己切
      if (mode === 'glued') {
        return res.end(frames.join(''))
      }

      // ④ 慢客户端：网关写下游时会被 backpressure 挡住，这里只要正常吐完即可
      if (mode === 'slow-chunks') {
        let i = 0
        const step = () => {
          if (i >= frames.length) return res.end()
          res.write(frames[i])
          i += 1
          setTimeout(step, 120)
        }
        return step()
      }

      return res.end()
    })
  })
  return new Promise((resolve) => upstream.listen(UP_PORT, '127.0.0.1', resolve))
}

await startUpstream()

const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  cwd: ROOT,
  env: { ...process.env, MANAGE_API_HOME: HOME, MANAGE_API_PROBE_FIRST_DELAY_MS: '600000' },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let stderrText = ''
app.stderr.on('data', (c) => {
  stderrText += c.toString()
})

const base = `http://127.0.0.1:${APP_PORT}`
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

/** 网关进程当前 RSS（MB）。macOS/Linux 都用 ps，不依赖 /proc */
function appRss() {
  const out = execFileSync('ps', ['-o', 'rss=', '-p', String(app.pid)], { encoding: 'utf8' })
  return Number(out.trim()) / 1024
}

/** 持续采样网关 RSS，返回 {stop(): 峰值}。100ms 一次，够抓住 3 秒停顿里的堆涨 */
function watchRss() {
  let peak = appRss()
  const timer = setInterval(() => {
    try {
      peak = Math.max(peak, appRss())
    } catch {
      /* 进程刚退出 */
    }
  }, 100)
  return {
    stop() {
      clearInterval(timer)
      return peak
    },
  }
}

/** 发流式请求，返回 {status, text, headers}；text 用 TextDecoder 拼（不是 Uint8Array+''） */
async function streamRequest(path, body, { slowReader = false, pauseMs = 0 } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  })
  if (!res.body) return { status: res.status, text: '', headers: res.headers }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let paused = false
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
    // pauseMs：读到第一块后彻底停读这么久，制造下游堵死（背压的真实场景）
    if (pauseMs && !paused) {
      paused = true
      await sleep(pauseMs)
      continue
    }
    // 下游故意慢：不读也不取消，让网关的 write 返回 false 并等 drain
    if (slowReader) await sleep(12)
  }
  text += decoder.decode()
  return { status: res.status, text, headers: res.headers }
}

/** 把 SSE 文本切成事件块，校验每块都是完整帧（不残缺） */
function parseEvents(text) {
  const out = []
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue
    const lines = block.split('\n').filter(Boolean)
    const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() || null
    const data = lines.find((l) => l.startsWith('data:'))?.slice(5).trim() || ''
    out.push({ event, data })
  }
  return out
}

let key = null

try {
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }
  await call('PATCH', '/api/settings', { probeIntervalMinutes: 0 })

  const created = await call('POST', '/api/providers', {
    name: '甲站',
    baseUrl: `http://127.0.0.1:${UP_PORT}/v1`,
  })
  const provider = created.providers.find((p) => p.name === '甲站')
  await call('POST', '/api/credentials', {
    providerId: provider.id,
    label: '默认',
    secret: 'sk-stream-1234',
  })
  await call('POST', `/api/providers/${provider.id}/sync`)
  const state = await call('GET', '/api/state')
  key = state.gateway.keys.find((k) => k.enabled)?.key
  ok(Boolean(key), '网关 Key 就绪')
  const models = state.offers.filter((o) => o.providerId === provider.id).map((o) => o.modelKey)
  ok(models.length >= 1, `供给已同步（${models.length} 条）`)

  // ------------------------------------------------ ① 正常 chat 流：帧完整 + 有 DONE
  mode = 'chat-normal'
  const normal = await streamRequest('/v1/chat/completions', {
    model: 'gpt-x',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  })
  ok(normal.status === 200, `chat 流 200（${normal.status}）`)
  ok(normal.text.includes('data: [DONE]'), 'chat 流有 [DONE] 终止信号')
  const normalEvents = parseEvents(normal.text)
  ok(normalEvents.length >= 4, `chat 流帧数够（${normalEvents.length}）`)
  ok(normal.text.includes('你好') && normal.text.includes('，世界'), '正文两段都在（没被粘丢）')
  ok(
    normalEvents.every((e) => e.data === '[DONE]' || (() => {
      try {
        JSON.parse(e.data)
        return true
      } catch {
        return false
      }
    })()),
    '每帧 data 都是合法 JSON 或 [DONE]（没有半截帧漏给客户端）',
  )

  // ------------------------------------------------ ② 帧被切碎：必须还原
  mode = 'chopped'
  const chopped = await streamRequest('/v1/chat/completions', {
    model: 'gpt-x',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  })
  ok(chopped.status === 200, `碎帧流 200（${chopped.status}）`)
  ok(chopped.text.includes('data: [DONE]'), '碎帧流也有 [DONE]')
  const choppedEvents = parseEvents(chopped.text)
  ok(
    choppedEvents.length === normalEvents.length,
    `碎帧还原后帧数一致（${choppedEvents.length} vs ${normalEvents.length}）`,
  )
  ok(chopped.text.includes('你好'), '碎帧里的中文没有乱码/丢失')
  ok(chopped.text.includes('，世界'), '第二段正文也在')

  // ------------------------------------------------ ③ 粘帧：网关必须自己切
  mode = 'glued'
  const glued = await streamRequest('/v1/chat/completions', {
    model: 'gpt-x',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  })
  ok(glued.status === 200, `粘帧流 200（${glued.status}）`)
  ok(glued.text.includes('data: [DONE]'), '粘帧流有 [DONE]')
  const gluedEvents = parseEvents(glued.text)
  ok(gluedEvents.length === normalEvents.length, `粘帧切开后帧数一致（${gluedEvents.length}）`)

  // ------------------------------------------------ ④ /responses 协议
  mode = 'resp-normal'
  const resp = await streamRequest('/v1/responses', {
    model: 'gpt-r',
    input: 'hi',
    stream: true,
  })
  ok(resp.status === 200, `/responses 流 200（${resp.status}）`)
  ok(resp.text.includes('response.completed'), '/responses 有 response.completed 收尾')
  const respEvents = parseEvents(resp.text)
  ok(
    respEvents.some((e) => e.event === 'response.output_text.delta'),
    '/responses 保留了 event: 名（不是被当成 chat 处理）',
  )
  const textDeltas = respEvents
    .filter((e) => e.event === 'response.output_text.delta')
    .map((e) => {
      try {
        return JSON.parse(e.data).delta
      } catch {
        return null
      }
    })
  ok(textDeltas.filter(Boolean).join('') === '你好世界', `/responses 正文拼起来完整（${textDeltas.join('|')}）`)

  // /responses 非流式也要能用（协议分支不同，容易只测流式漏掉它）
  const respJson = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'gpt-r', input: 'hi' }),
  })
  const respJsonBody = await respJson.json().catch(() => ({}))
  ok(respJson.status === 200, `/responses 非流式 200（${respJson.status}）`)
  ok(
    JSON.stringify(respJsonBody).includes('你好世界'),
    `/responses 非流式正文字段透传（${JSON.stringify(respJsonBody).slice(0, 80)}）`,
  )

  // chat 非流式同理：走的是另一条读体分支（N03 改过）
  const chatJson = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] }),
  })
  const chatJsonBody = await chatJson.json().catch(() => ({}))
  ok(chatJson.status === 200, `chat 非流式 200（${chatJson.status}）`)
  ok(
    chatJsonBody.choices?.[0]?.message?.content === '你好世界',
    `chat 非流式正文完整（${JSON.stringify(chatJsonBody).slice(0, 80)}）`,
  )

  // ------------------------------------------------ ⑤ 慢客户端 + 背压
  mode = 'slow-chunks'
  const slow = await streamRequest(
    '/v1/chat/completions',
    { model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], stream: true },
    { slowReader: true },
  )
  ok(slow.status === 200, `慢客户端流 200（${slow.status}）`)
  ok(slow.text.includes('data: [DONE]'), '慢客户端也拿到了 [DONE]（没被背压卡死）')
  ok(slow.text.includes('你好'), '慢客户端正文完整')
  const slowEvents = parseEvents(slow.text)
  ok(slowEvents.length === normalEvents.length, `慢客户端帧数一致（${slowEvents.length}）`)

  // 大水漫灌：1200 帧 × 48KB ≈ 57MB。下游读到一半**彻底停 3 秒**，
  // 上游还在猛灌 → 网关的 res.write 必然返回 false。
  //   · 等 drain（正确）：内存峰值只比基线高几个 MB，因为停止读上游
  //   · 不等 drain（错误）：把整个 57MB 无脑堆进 res 缓冲区 → RSS 暴涨
  // 这条断言直接量 RSS 增量，因为「丢不丢帧」在 Node 里区分不出来（缓冲不丢数据）。
  mode = 'bulk'
  const rssBefore = appRss()
  const watcher = watchRss()
  const bulk = await streamRequest(
    '/v1/chat/completions',
    { model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], stream: true },
    { slowReader: true, pauseMs: 3000 },
  )
  const rssPeak = watcher.stop()
  const bulkEvents = parseEvents(bulk.text)
  ok(bulk.status === 200, `大批量慢读 200（${bulk.status}）`)
  ok(bulk.text.length > 50_000_000, `大批量慢读字节数够（${(bulk.text.length / 1e6).toFixed(1)}MB）`)
  ok(bulkEvents.length === 1201, `大批量慢读不丢帧（${bulkEvents.length} / 1201）`)
  ok(bulk.text.includes('块1199。'), '最后一帧正文到了（没有被截断在中间）')
  ok(bulk.text.includes('data: [DONE]'), '大批量慢读也有 [DONE]')
  ok(
    rssPeak - rssBefore < 40,
    `背压生效：网关内存只涨 ${(rssPeak - rssBefore).toFixed(0)}MB（应远小于 57MB 的流体积）`,
  )

  // ------------------------------------------------ ⑥ 没有半截帧漏出去
  const allTexts = [
    ['normal', normal.text],
    ['chopped', chopped.text],
    ['glued', glued.text],
    ['slow', slow.text],
  ]
  for (const [label, text] of allTexts) {
    // 每个 data: 行后面必须紧跟空行收尾；出现「data: {"id"」这种截断就是漏帧
    const bad = text.split('\n').filter((line) => line.startsWith('data:') && !/^data: (\{.*\}|\[DONE\])$/.test(line))
    ok(bad.length === 0, `${label} 里没有不完整的 data 行${bad.length ? `（${bad[0].slice(0, 60)}）` : ''}`)
  }

  ok(!/routeTarget is not defined/.test(stderrText), '日志里没有路由参数漏传')
  ok(!/ERR_STREAM_WRITE_AFTER_END/.test(stderrText), '日志里没有写已结束流的错误')

  console.log(`check-stream-reliability: ${n} 项全部通过`)
} finally {
  app.kill()
  upstream?.close()
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}