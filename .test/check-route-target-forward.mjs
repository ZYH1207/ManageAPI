/**
 * 转发路径回归：两条 forwardToUpstream 调用点都必须拿到 routeTarget。
 *
 * ## 为什么要有这个测试（真实事故）
 *
 * 2026-11-02 引入组级设置（core/route-groups.js）时，`forwardToUpstream` 内部读了
 * `routeTarget.firstTokenMs`，但 `routeTarget` 只声明在调用者 `handleChatCompletions`
 * 内部。模块级函数拿不到调用者的局部变量 → 每次转发都在 1ms 内抛
 *
 *     ReferenceError: routeTarget is not defined
 *
 * 请求根本没发到上游，但错误被当成「站点故障」记进流量账（详见 core/failure.js
 * 的 trafficDelta），于是 4 条供给可用率被打到 0、全部封禁 10 分钟。用户看到的
 * 是「Magpie 切到正式域名后全部 502」，站点后台一切正常。
 *
 * 当时只在 /tmp 里手搓了个 mock 复现，没进仓库 —— 于是这类漏传可以静默复发。
 * 这个测试把它钉死，覆盖**两条**调用点：
 *
 *   ① 主循环：候选链正常推进
 *   ② all-busy 整轮重试：所有成员都失败后，按组设置等待再试一轮
 *
 * 第 ② 条是最容易漏的那条 —— 它只在「全灭」时才走到，日常自测碰不到；
 * 事故里补参数时如果只补主循环，第二轮仍然会抛同一个 ReferenceError。
 *
 * ## 怎么不依赖线上
 *
 * 自己起假上游（本地 http），自己起 daemon，全部落在 mktemp 目录里。
 * 不碰 ~/.manage-api，不需要真 Key，不发一个真实模型请求。
 *
 * 用法：node .test/check-route-target-forward.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let n = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  n += 1
}

const freePort = async () => {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const HOME = await mkdtemp(join(tmpdir(), 'mapi-route-target-'))
process.env.MANAGE_API_HOME = HOME
const APP_PORT = await freePort()
const UP_PORT = await freePort()

// 假上游：模型清单 + chat/completions。mode 由 query 之外的路径决定，
// 这里只用**一个**站点，靠「先失败再成功」控制两条调用点。
const hits = { chat: 0 }
let upstreamMode = 'fail-first'
const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname.endsWith('/models')) return send(200, { data: [{ id: 'gpt-x' }] })
  if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
    hits.chat += 1
    req.on('data', () => {})
    req.on('end', () => {
      // fail-first：第一次 500（让主循环失败、逼出 all-busy 第二轮），之后成功
      if (upstreamMode === 'fail-first' && hits.chat === 1) {
        return send(500, { error: { message: 'upstream blew up' } })
      }
      send(200, {
        id: 'chatcmpl-rt',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'served' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
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
    // 后台探测推到 10 分钟后：这节只看转发路径，不能被探针改写评分
    MANAGE_API_PROBE_FIRST_DELAY_MS: '600000',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})
// 收集 stderr：如果又出现 routeTarget is not defined，要能从日志里直接看到
let stderrText = ''
app.stderr.on('data', (chunk) => {
  stderrText += chunk.toString()
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

  const up = `http://127.0.0.1:${UP_PORT}`
  const created = await call('POST', '/api/providers', { name: '甲站', baseUrl: `${up}/v1` })
  const provider = created.providers.find((p) => p.name === '甲站')
  await call('POST', '/api/credentials', { providerId: provider.id, label: '默认', secret: 'sk-rt-1234' })
  await call('POST', `/api/providers/${provider.id}/sync`)
  const state = await call('GET', '/api/state')
  const key = state.gateway.keys.find((k) => k.enabled)?.key
  ok(Boolean(key), '网关 Key 就绪')
  ok(state.offers.some((o) => o.providerId === provider.id), '供给已同步')

  // 建一个路由组并置为生效：routeTarget 正是从这里来的（组级 firstTokenMs/allBusyMs）。
  // 没有生效组时 routeTarget 是 null，缺陷会被「null?.」静默掩盖 —— 所以必须建组，
  // 让 routeTarget 是**真对象**，这条路径才和事故现场一致。
  const group = await call('POST', '/api/route-groups', {
    name: '回归组',
    models: ['gpt-x'],
  })
  ok(Boolean(group.group?.id), '路由组创建成功')
  await call('PATCH', `/api/route-groups/${group.group.id}`, {
    firstTokenMs: 30_000,
    // 全忙重试：设成最小值 1 分钟（关掉的话走不到第二条调用点）
    allBusyMs: 60_000,
  })
  await call('POST', '/api/route-groups/active', { id: group.group.id })

  const post = (body) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    })

  // ---------------------------------------------------------------- ① 主循环
  hits.chat = 0
  upstreamMode = 'always-ok'
  const first = await post({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] })
  const firstBody = await first.json().catch(() => ({}))
  ok(first.status === 200, `带生效组时主循环转发成功（${first.status}）`)
  ok(JSON.stringify(firstBody).includes('served'), '拿到了上游正文（不是网关自造的错）')
  ok(hits.chat === 1, `上游真的收到了请求（${hits.chat} 次）`)
  // 事故特征：本地 ReferenceError 时上游一次都不会收到。这条断言直接把它钉死
  ok(!stderrText.includes('routeTarget is not defined'), '日志里没有 routeTarget is not defined')

  // ---------------------------------------------------------------- ② all-busy 整轮重试
  //
  // 让第一轮必然失败、第二轮成功：上游按 hits 计数第一次回 500。
  // 这条路径只在「所有成员都失败 + 组里设了 allBusyMs」时走到，
  // 而且就拿同一份 routeTarget —— 漏传的话这里会抛同一个 ReferenceError。
  hits.chat = 0
  upstreamMode = 'fail-first'
  stderrText = ''
  const retried = await post({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi again' }] })
  const retriedBody = await retried.json().catch(() => ({}))
  ok(retried.status === 200, `全灭后整轮重试成功（${retried.status}）`)
  ok(JSON.stringify(retriedBody).includes('served'), '重试那一轮真的拿到了上游正文')
  ok(hits.chat >= 2, `上游被请求了至少 2 次（实际 ${hits.chat}）：说明第二轮真的发出去了`)
  ok(!stderrText.includes('routeTarget is not defined'), 'all-busy 重试路径也没有 routeTarget 未定义')

  // ---------------------------------------------------------------- ③ 组设置真的生效
  //
  // 只验「不抛错」还不够：参数传了但传错（比如把 routeTarget 传成别的对象）
  // 同样不抛错。这里用组级 firstTokenMs 做一个可观测的后果 ——
  // 上游故意迟迟不下发首字节，超时应该由网关按**组**的门槛触发，而不是全局 60s。
  // 组里设 30s 太久，改用 1 秒级的假上游不现实；改成断言「组设置被读到」
  // 用一条更便宜的路：/api/route-groups 回读，确认 active 组带着我们写的值。
  const groups = await call('GET', '/api/route-groups')
  ok(groups.active?.id === group.group.id, '生效组就是刚建的那个')
  ok(groups.active?.firstTokenMs === 30_000, `组级首字超时已落库（${groups.active?.firstTokenMs}）`)
  ok(groups.active?.allBusyMs === 60_000, `组级全忙等待已落库（${groups.active?.allBusyMs}）`)

  console.log(`check-route-target-forward: ${n} 项全部通过`)
} finally {
  app.kill()
  upstream.close()
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}