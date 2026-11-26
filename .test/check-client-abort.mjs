/**
 * 客户端取消（ESC）不能被记成「站方断流」。
 *
 * 背景：浏览器按 ESC / 关页面时，前端会断开连接，网关随之中断上游 fetch，
 * 读流抛 AbortError（"This operation was aborted"）。旧口径把这句话交给
 * classifyFailure 的默认规则 → countsAsOutage=true → 记成站点断流：
 * 可用率被这次「用户自己不要了」的请求拉低，排查时也被引向站方。
 *
 * 本测试用一个会慢慢吐字的上游复现两条路径：
 *   A. 客户端收了一半就 abort  → 期望 client-aborted，不计 fail、不计错误
 *   B. 上游自己把连接掐了      → 期望仍是 stream-broken + fail（不能被顺手放过）
 *
 * 用法：node .test/check-client-abort.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP_PORT = 4397
const UP_PORT = 5117

let failed = 0
function ok(cond, message) {
  if (cond) console.log(`  ✓ ${message}`)
  else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 假上游
const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'm-slow' }, { id: 'm-break' }] }))
    return
  }
  if (!url.pathname.endsWith('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"error":"not found"}')
    return
  }
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    let model = ''
    try {
      model = JSON.parse(body).model
    } catch {
      /* 忽略 */
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    // 先来一个没有正文的 role 帧（网关会先扣在 held 缓冲里，不算提交）
    frame({ choices: [{ delta: { role: 'assistant' } }] })

    if (model === 'm-break') {
      // 上游自己断：吐两帧正文后直接掐连接（不写 [DONE]）
      let n = 0
      const timer = setInterval(() => {
        n += 1
        frame({ choices: [{ delta: { content: `片段${n}` } }] })
        if (n >= 2) {
          clearInterval(timer)
          res.socket.destroy()
        }
      }, 30)
      return
    }

    // 慢速长回答：够客户端读到正文后主动 abort
    let n = 0
    const timer = setInterval(() => {
      n += 1
      frame({ choices: [{ delta: { content: `第${n}段` } }] })
      if (n >= 40) {
        clearInterval(timer)
        frame({ choices: [{ delta: {}, finish_reason: 'stop' }] })
        frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 40 } })
        res.write('data: [DONE]\n\n')
        res.end()
      }
    }, 40)
    req.on('aborted', () => clearInterval(timer))
    res.on('close', () => clearInterval(timer))
  })
})
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))

// ---------------------------------------------------------------- daemon
const HOME = await mkdtemp(join(tmpdir(), 'mapi-client-abort-'))
const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  cwd: ROOT,
  env: { ...process.env, MANAGE_API_HOME: HOME },
  stdio: 'ignore',
})
const base = `http://127.0.0.1:${APP_PORT}`

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`)
  return data
}

/** 读一次流式请求；onFirstContent 返回后由调用方决定是否 abort。 */
async function streamOnce(model, auth, { abortAfterFirstContent = false } = {}) {
  const controller = new AbortController()
  let sawContent = false
  let aborted = false
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: controller.signal,
    })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (abortAfterFirstContent && !sawContent && /"content":"[^"]+"/.test(text)) {
        sawContent = true
        controller.abort()
        aborted = true
        break
      }
    }
    return { text, aborted, sawContent }
  } catch (error) {
    // abort 自身抛 AbortError，属于预期
    return { text: '', aborted, sawContent, error: error.name }
  }
}

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) break
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }

  // 建站 + 同步模型
  let state = await call('POST', '/api/providers', {
    name: '断流测试站',
    baseUrl: `http://127.0.0.1:${UP_PORT}/v1`,
  })
  const provider = state.providers.find((p) => p.name === '断流测试站')
  await call('POST', '/api/credentials', { providerId: provider.id, secret: 'sk-abort-test' })
  state = await call('POST', `/api/providers/${provider.id}/sync`)
  const offerOf = (modelKey) => state.offers.find((o) => o.modelKey === modelKey)
  const slowOffer = offerOf('m-slow')
  const breakOffer = offerOf('m-break')
  ok(Boolean(slowOffer && breakOffer), '同步出两条供给（m-slow / m-break）')

  const gatewayKey = state.gateway.keys.find((k) => k.enabled)?.key
  if (!gatewayKey) throw new Error('没有可用的网关 Key')
  const auth = { Authorization: `Bearer ${gatewayKey}` }

  // ------------------------------------------------------------ A. 客户端取消
  console.log('\n[1] 客户端读到正文后 abort（模拟 ESC）')
  const a = await streamOnce('m-slow', auth, { abortAfterFirstContent: true })
  ok(a.aborted && a.sawContent, '客户端确实收到了正文再取消')
  // 等 traffic（5s 落盘）与 routing（2s 落盘）都写下去
  await sleep(6500)

  {
    const db = JSON.parse(await readFile(join(HOME, 'db.json'), 'utf8'))
    const row = db.traffic[slowOffer.id] || {}
    ok((row.fail || 0) === 0, `这次取消没有记成站点失败（fail=${row.fail || 0}）`)
    const clientKind = row.kinds?.['client-abort']?.n || 0
    ok(clientKind >= 1, `单独记成 client-abort（${clientKind} 次）`)
    ok((row.ok || 0) === 0, `也不算站点成功样本（ok=${row.ok || 0}）`)
    const last = (db.routing || []).filter((r) => r.model === 'm-slow').at(-1)
    ok(last?.outcome === 'client-aborted', `路由日志记 client-aborted（实际 ${last?.outcome}）`)
    // 断流不等于「白跑」：首字已经等到了，这个数字对「20 万 token 的对话要等多久」
    // 是最有价值的证据。我们自己这轮长对话几乎全是断流，扔掉它们等于长对话永远没实测。
    const speedRows = row.speed?.rows || []
    ok(speedRows.length === 1, `断流也留下 1 条首字样本（rows=${speedRows.length}）`)
    ok(speedRows[0]?.aborted === true, '样本标记为断流')
    ok(speedRows[0]?.ttftMs > 0, `首字是真实测到的（${speedRows[0]?.ttftMs}ms）`)
    ok(speedRows[0]?.tps === null, '没有解码完就不编一个速度出来（tps=null）')
  }
  {
    const usage = JSON.parse(await readFile(join(HOME, 'usage.json'), 'utf8'))
    const days = Object.values(usage.days || {})
    const rows = days.flatMap((d) => Object.values(d))
    const errors = rows.reduce((sum, r) => sum + (r.errors || 0), 0)
    ok(errors === 0, `用量里没有错误计数（errors=${errors}）`)
  }

  // ------------------------------------------------------------ B. 上游真断
  console.log('\n[2] 上游自己掐断连接（真断流，不能被一起放过）')
  const b = await streamOnce('m-break', auth)
  ok(!b.aborted, '客户端没取消（正常收尾）')
  await sleep(6500)
  {
    const db = JSON.parse(await readFile(join(HOME, 'db.json'), 'utf8'))
    const row = db.traffic[breakOffer.id] || {}
    ok((row.fail || 0) >= 1, `真断流仍然记站点失败（fail=${row.fail || 0}）`)
    ok(!(row.kinds?.['client-abort']?.n >= 1), '真断流不会被误记成 client-abort')
    const last = (db.routing || []).filter((r) => r.model === 'm-break').at(-1)
    ok(last?.outcome === 'stream-broken', `路由日志记 stream-broken（实际 ${last?.outcome}）`)
  }
  {
    const usage = JSON.parse(await readFile(join(HOME, 'usage.json'), 'utf8'))
    const rows = Object.values(usage.days || {}).flatMap((d) => Object.values(d))
    ok(rows.some((r) => (r.errors || 0) >= 1), '真断流仍然计入用量错误')
  }

  console.log('')
  if (failed === 0) console.log('全部通过 ✓')
  else {
    console.error(`${failed} 项失败`)
    process.exitCode = 1
  }
} catch (error) {
  console.error('测试出错：', error.message || error)
  process.exitCode = 1
} finally {
  app.kill()
  upstream.close()
  setTimeout(() => process.exit(process.exitCode || 0), 300)
}
