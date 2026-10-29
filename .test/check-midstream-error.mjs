/**
 * 已提交之后的流级失败：网关必须承认「这单没交付完」，而不是记成功。
 *
 * 现场（2026-10-29）：某个长上下文会话连着 4 次 `The request could not be completed.`
 * + 1 次 `malformed server-sent event JSON`（客户端 SDK 抛的），而 ManageAPI 的
 * 决策日志全部记成 `outcome: ok`、诊断页一片空白——因为三处代码都只看「未提交」：
 *
 *   1. `if (!committed && inspected.error)` —— 吐过字之后的错误帧原样转发、当成功
 *   2. SSE 帧 JSON.parse 失败被当心跳静默放行 —— 坏帧直接进客户端，SDK 当场崩
 *   3. `queueRouting` 没带 `streamError` —— errorbook / offerStats 永远收不到原因
 *
 * 这个测试把三种病逐一钉死，外加一条反向的：客户端自己取消（client-abort）
 * 不许再被记成断流。
 *
 * 跑法：node .test/check-midstream-error.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import http from 'node:http'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let n = 0
const ok = (cond, label) => {
  if (!cond) throw new Error(`✗ ${label}`)
  n += 1
  console.log(`  ✓ ${label}`)
}

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ROLE = 'data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null,"index":0}]}\n\n'
const TEXT = (t) => `data: {"choices":[{"delta":{"content":${JSON.stringify(t)}},"finish_reason":null,"index":0}]}\n\n`

// ---- mock 上游：四种行为，靠 URL 前缀区分
//   /err  吐一句正文后，在流里发 error 事件然后正常关连接
//   /bad  吐一句正文后，送一个坏掉的 JSON 帧（半截），然后关连接
//   /tail 吐一句正文后，送一个没有 \n\n 收尾的半截帧，然后关连接
//   /ok   完整回答（对照组）
const UP_PORT = await freePort()
const upstream = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const mode = String(req.url).split('/')[1] || 'ok'
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(ROLE)
    if (mode === 'err') {
      res.write(TEXT('半截回答'))
      res.write('data: {"error":{"message":"The request could not be completed.","type":"server_error"}}\n\n')
      res.end()
      return
    }
    if (mode === 'bad') {
      res.write(TEXT('半截回答'))
      res.write('data: {"choices":[{"delta":{"content":"这帧坏了\n\n')
      res.end()
      return
    }
    if (mode === 'tail') {
      res.write(TEXT('半截回答'))
      res.write('data: {"choices":[{"delta":{"content":"没有结尾')
      res.end()
      return
    }
    if (mode === 'slow') {
      // 慢流：吐一句就挂着，专门给「客户端中途取消」那条用
      res.write(TEXT('开始'))
      const t = setInterval(() => res.write(': keepalive\n\n'), 200)
      res.on('close', () => clearInterval(t))
      return
    }
    res.write(TEXT('完整回答'))
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))

const home = await mkdtemp(join(tmpdir(), 'mapi-midstream-'))
const APP_PORT = await freePort()
const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  cwd: ROOT,
  env: { ...process.env, MANAGE_API_HOME: home },
  stdio: 'ignore',
})
await sleep(3000)
for (let i = 0; i < 40; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)).ok) break
  } catch {}
  await sleep(250)
}

const api = (path, body) =>
  fetch(`http://127.0.0.1:${APP_PORT}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json())

// ---- 预置：四个站各一条供给（同一个模型，靠手动顺序单独点名）
{
  const ids = {}
  for (const mode of ['err', 'bad', 'tail', 'ok', 'slow']) {
    const r = await api('/api/providers', { name: `站-${mode}`, baseUrl: `http://127.0.0.1:${UP_PORT}/${mode}` })
    ids[mode] = r.providers.find((x) => x.name === `站-${mode}`)
    await api('/api/credentials', { providerId: ids[mode].id, label: 'k', secret: `key-${mode}`, group: 'g' })
  }
  const dbPath = join(home, 'db.json')
  const db = JSON.parse(await readFile(dbPath, 'utf8'))
  const mk = (mode) => ({
    id: `o_${mode}`,
    providerId: ids[mode].id,
    credentialId: null,
    upstreamName: `m-${mode}`,
    modelKey: `m-${mode}`,
    group: 'g',
    priceUnit: 'per_mtok',
    inPrice: 1,
    outPrice: 2,
    currency: 'CNY',
    ratio: 1,
  })
  db.offers = ['err', 'bad', 'tail', 'ok', 'slow'].map(mk)
  // 每个模型只有一条供给：断了也没别家可换，才能保证失败一路记到账上
  db.manualOrder = {}
  db.settings.gateway = {
    enabled: true,
    keys: [
      {
        id: 'gk_test',
        name: 'test',
        key: 'sk-mapi-test000000000000000000000000',
        enabled: true,
        monthlyTokenLimit: null,
        note: '',
        createdAt: new Date().toISOString(),
      },
    ],
  }
  await writeFile(dbPath, JSON.stringify(db))
  await sleep(600)
}

const call = async (model) => {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-mapi-test000000000000000000000000' },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const text = await res.text()
  return { status: res.status, text }
}

try {
  // ---- ① 流里的 error 事件（已提交之后）
  const r1 = await call('m-err')
  ok(r1.status === 200, '① 客户端仍是 200（流早开过了，不能改状态码）')
  ok(r1.text.includes('半截回答'), '① 客户端确实已经收到了半截正文（这就是「已提交」）')
  ok(r1.text.includes('could not be completed'), '① 上游的错误帧被转给客户端，它不会一直干等')

  // ---- ② 坏 JSON 帧
  const r2 = await call('m-bad')
  ok(r2.status === 200, '② 客户端 200')
  ok(r2.text.includes('半截回答'), '② 客户端拿到了前面那半截')
  ok(!r2.text.includes('这帧坏了'), '② 坏帧不再原样转发（转发 = 客户端 SDK 当场 JSON.parse 崩）')

  // ---- ③ 尾巴上的半截帧（没有 \n\n 收尾）
  const r3 = await call('m-tail')
  ok(r3.status === 200, '③ 客户端 200')
  ok(!r3.text.includes('没有结尾'), '③ 残留在缓冲里的半截帧也不许倒给客户端')

  // ---- ④ 对照组：正常回答仍然记成功（别把好站一起拖下水）
  const r4 = await call('m-ok')
  ok(r4.text.includes('完整回答'), '④ 正常回答照旧')

  await sleep(3500)

  // ---- 账本：三类失败都必须留下 streamError 与断流结局
  const state = await api('/api/state')
  const log = state.routing || []
  const find = (model) => log.find((r) => r.model === model)
  const e1 = find('m-err')
  ok(e1 && e1.outcome === 'stream-broken', `① 决策日志记断流（实际 ${e1?.outcome}）`)
  ok(String(e1?.streamError || '').includes('could not be completed'), '① 断流原因进了决策日志（以前是 null）')
  const e2 = find('m-bad')
  ok(e2 && e2.outcome === 'stream-broken', `② 坏帧记断流（实际 ${e2?.outcome}）`)
  ok(/SSE 帧/.test(String(e2?.streamError || '')), `② 原因写明是坏帧：${e2?.streamError}`)
  const e3 = find('m-tail')
  ok(e3 && e3.outcome === 'stream-broken', `③ 半截帧记断流（实际 ${e3?.outcome}）`)
  ok(/半截/.test(String(e3?.streamError || '')), `③ 原因写明是半截帧：${e3?.streamError}`)
  const e4 = find('m-ok')
  ok(e4 && e4.outcome === 'ok' && !e4.streamError, '④ 正常回答没有 streamError（不误伤）')

  // ---- 诊断聚合：断流原因必须沉淀进错误账本 + 供给表现
  const ledger = await api('/api/diagnosis/ledger?hours=48')
  const bookText = Object.values(ledger.errorbook || {})
    .map((e) => `${e.template} ${e.sample}`)
    .join(' | ')
  ok(/could not be completed|SSE 帧|半截/.test(bookText), `断流原因进错误账本：${bookText.slice(0, 120)}`)
  // /api/diagnosis/ledger 的 offerStats 是「小时桶数组」（不是以 offerId 为键的字典）
  const statRows = (ledger.offerStats || []).filter((b) => b.offerId === 'o_bad' || b.offerId === 'o_tail')
  const brokenSum = statRows.reduce((a, b) => a + (b.broken || 0), 0)
  ok(brokenSum >= 2, `供给表现里记了断流次数（${brokenSum}）`)

  // ---- 故障事件：已提交的断流必须上报（用户真的没拿到完整结果）
  const faults = await api('/api/faults')
  const sent = (faults.events || []).filter((e) => e.status === 'sent')
  ok(sent.length >= 1, `故障事件里有上报（${sent.length} 条）`)
  ok(
    (faults.events || []).some((e) => /截断|断流|没有输出/.test(String(e.impactReason || ''))),
    '上报原因写得清（截断/断流）',
  )

  // ---- 反向：客户端自己取消不许记成断流
  {
    // 用挂了 /slow 上游的那条供给：吐一句就挂着，客户端拿到第一帧就断开
    const ctl = new AbortController()
    try {
      const res = await fetch(`http://127.0.0.1:${APP_PORT}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-mapi-test000000000000000000000000' },
        body: JSON.stringify({ model: 'm-slow', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
        signal: ctl.signal,
      })
      const reader = res.body.getReader()
      await reader.read()
      ctl.abort()
      await reader.cancel().catch(() => {})
    } catch {}
    await sleep(3500)
    const st2 = await api('/api/state')
    const last = (st2.routing || []).find((r) => r.model === 'm-slow')
    ok(last && last.outcome === 'client-abort', `客户端取消记成 client-abort（实际 ${last?.outcome}）`)
    ok(!last?.streamError, '客户端取消不带断流原因')
  }
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  app.kill()
  upstream.close()
  await rm(home, { recursive: true, force: true }).catch(() => {})
}
console.log(`check-midstream-error: ${n} 项全部通过`)
