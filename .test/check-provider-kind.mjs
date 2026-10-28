/**
 * 站点系别自动判定自检：四种 mock 站（one-api / new-api / sub2api / unknown）
 * 的识别正确性 + 获取逻辑按系别分支（Sub2API 之外的站不再碰 channels）。
 *
 * 用法：node .test/check-provider-kind.mjs
 */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { detectProviderKind, tryBalance, fetchAnnouncements } = await import(
  pathToFileURL(join(ROOT, 'core/providers.js')).href
)

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

// ---- mock：按端口区分系别
// 5201 one-api：/api/status 无 version；/api/user/self 有 quota
// 5202 new-api：/api/status 带 version；/api/pricing 通
// 5203 sub2api：/api/v1/settings/public 通；/api/v1/user/profile 有 balance
// 5204 unknown：全部 404
let balanceRequests = [] // 记录 tryBalance 实际打到的路径（验证分支）
const mock = (port, handlers) =>
  new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://x')
      const handler = handlers[url.pathname]
      balanceRequests.push(`${port}${url.pathname}`)
      if (handler) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(handler))
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
      }
    })
    server.listen(port, '127.0.0.1', () => resolve(server))
  })

const servers = [
  await mock(5201, {
    '/api/status': { data: { quota_per_unit: 500000, chat_link: 'https://t.me/x' } },
    '/api/user/self': { data: { quota: 2500000 } },
  }),
  await mock(5202, {
    '/api/status': { data: { version: 'v1.2.3', quota_per_unit: 500000 } },
    '/api/pricing': { data: [] },
    '/api/user/self': { data: { quota: 1000000 } },
  }),
  await mock(5203, {
    '/api/v1/settings/public': { data: {} },
    '/api/v1/user/profile': { data: { balance: 12.5, currency: 'CNY' } },
    '/api/v1/announcements': { data: { items: [{ id: 1, title: '公告', content: '正文' }] } },
  }),
  await mock(5204, {}),
]

// 5205 需要登录的站：匿名一律 401，带令牌才通（验证「带令牌再识别一次」）
const authServer = await new Promise((resolve) => {
  const server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer tok') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: { version: 'v2.0.0', quota_per_unit: 500000 } }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  server.listen(5205, '127.0.0.1', () => resolve(server))
})
servers.push(authServer)

try {
  console.log('[1] 系别判定')
  for (const [port, want, label] of [
    [5201, 'one-api', 'status 无 version → one-api'],
    [5202, 'new-api', 'status 带 version → new-api'],
    [5203, 'sub2api', 'settings/public 通 → sub2api'],
    [5204, 'unknown', '全 404 → unknown'],
  ]) {
    const r = await detectProviderKind({ baseUrl: `http://127.0.0.1:${port}/v1`, timeoutMs: 3000 })
    ok(r.kind === want, `${label}（实际 ${r.kind}）`)
  }

  // 部分站的特征接口要求登录：匿名 401 只能判 unknown，带令牌再试一次才认得出来
  const anon = await detectProviderKind({ baseUrl: 'http://127.0.0.1:5205/v1', timeoutMs: 3000 })
  ok(anon.kind === 'unknown', `匿名探测 401 → unknown（实际 ${anon.kind}）`)
  const withToken = await detectProviderKind({
    baseUrl: 'http://127.0.0.1:5205/v1',
    timeoutMs: 3000,
    adminToken: 'tok',
  })
  ok(withToken.kind === 'new-api', `带令牌 → new-api（实际 ${withToken.kind}）`)
  const wrongToken = await detectProviderKind({
    baseUrl: 'http://127.0.0.1:5205/v1',
    timeoutMs: 3000,
    adminToken: 'bad',
  })
  ok(wrongToken.kind === 'unknown', `令牌无效 → 仍 unknown（实际 ${wrongToken.kind}）`)

  console.log('[2] 余额按系别走确定性路径')
  balanceRequests = []
  const oneApi = await tryBalance({ baseUrl: 'http://127.0.0.1:5201/v1', adminToken: 'tok', kind: 'one-api' })
  ok(oneApi.ok === true && oneApi.via === 'admin-token-quota', 'one-api 系余额走 quota 换算')
  ok(!balanceRequests.some((r) => r.includes('/api/v1/user/profile')), 'one-api 站不再碰 Sub2API 的 profile 路径')

  balanceRequests = []
  const sub = await tryBalance({ baseUrl: 'http://127.0.0.1:5203/v1', adminToken: 'tok', kind: 'sub2api' })
  ok(sub.ok === true && sub.remaining === 12.5 && sub.currency === 'CNY', 'Sub2API 系余额直接读 balance 字段')
  ok(!balanceRequests.some((r) => r.includes('/api/user/self')), 'Sub2API 站不再碰 one-api 的 self 路径')

  console.log('[3] 公告按系别走单一来源')
  const subAnn = await fetchAnnouncements({ baseUrl: 'http://127.0.0.1:5203/v1', adminToken: 'tok', kind: 'sub2api' })
  ok(subAnn.length === 1 && subAnn[0].title === '公告', 'Sub2API 公告读取正常')

  console.log('')
  if (failed === 0) console.log('全部通过 ✓')
  else {
    console.error(`${failed} 项失败`)
    process.exitCode = 1
  }
} finally {
  for (const s of servers) s.close()
}
