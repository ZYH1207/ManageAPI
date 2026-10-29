/**
 * 连接层预检自检（core/probe-preflight.js）。
 *
 * 目的：在花 token 之前把「连不上的站」筛掉。这里用本地临时服务器造四种现场：
 *   1. L1 通过（DNS/TCP/TLS 都能建立）
 *   2. L2 通过（/models 返回 JSON 带 data）
 *   3. L2 判 auth（401/403，Key 错但站是通的）
 *   4. L2 判 entry（返回 HTML，落到网关页/反代页）
 *   5. DNS 失败（不存在的域名）
 *
 * 用法：node .test/check-preflight.mjs
 */
import { createServer } from 'node:http'
import { parseBaseUrl, probeConnectivity, probeEntry, preflight } from '../core/probe-preflight.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

console.log('[1] baseUrl 解析')
{
  const a = parseBaseUrl('https://api.example.com/v1')
  ok(a.ok && a.protocol === 'https' && a.port === 443 && a.pathPrefix === '/v1', `https 默认 443：${a.port}`)
  const b = parseBaseUrl('http://127.0.0.1:8080/api/v1/')
  ok(b.ok && b.protocol === 'http' && b.port === 8080 && b.pathPrefix === '/api/v1', `尾部斜杠被去掉：${b.pathPrefix}`)
  ok(parseBaseUrl('不是URL').ok === false, '非法地址 → ok=false（不抛异常）')
  ok(parseBaseUrl('').ok === false, '空串 → ok=false')
}

// 起一个本地服务器扮演上游
let mode = 'ok'
const server = createServer((req, res) => {
  if (req.url.endsWith('/models')) {
    if (mode === 'auth') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid key' }))
      return
    }
    if (mode === 'html') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body>welcome</body></html>')
      return
    }
    if (mode === '5xx') {
      res.writeHead(502)
      res.end('bad gateway')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }))
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/v1`

try {
  console.log('\n[2] L1 连通性（本地 http 服务）')
  const conn = await probeConnectivity(baseUrl)
  ok(conn.ok === true && conn.layer === null, `TCP 打通（${conn.ms}ms，ip=${conn.resolvedIp}）`)
  ok(conn.ms < 2000, `连接层很快（${conn.ms}ms，远低于对话超时）`)

  const bad = await probeConnectivity('https://this-domain-should-not-exist-xyz.invalid/v1')
  ok(bad.ok === false && bad.layer === 'dns', `不存在的域名 → 卡在 dns（${bad.layer}）`)

  const badUrl = await probeConnectivity('not a url')
  ok(badUrl.ok === false && badUrl.layer === 'dns', '非法 URL → dns 层失败')

  console.log('\n[3] L2 入口判定，四种现场')
  mode = 'ok'
  const good = await probeEntry({ baseUrl, apiKey: 'k' })
  ok(good.kind === 'ok' && good.modelCount === 2, `正常站 → ok，模型数 ${good.modelCount}`)

  mode = 'auth'
  const auth = await probeEntry({ baseUrl, apiKey: 'bad' })
  ok(auth.kind === 'auth' && auth.status === 401, `Key 错 → auth（HTTP ${auth.status}）`)

  mode = 'html'
  const html = await probeEntry({ baseUrl, apiKey: 'k' })
  ok(html.kind === 'entry', `返回 HTML（网关页）→ entry（${html.error}）`)

  mode = '5xx'
  const bad5 = await probeEntry({ baseUrl, apiKey: 'k' })
  ok(bad5.kind === 'entry' && bad5.status === 502, `上游 502 → entry（HTTP ${bad5.status}）`)

  console.log('\n[4] preflight 组合：只有全通才该继续花钱')
  mode = 'ok'
  const pass = await preflight({ baseUrl, apiKey: 'k' })
  ok(pass.ok === true && pass.layer === null, 'L1+L2 都过 → 允许进 L3')
  ok(typeof pass.ms === 'number' && pass.ms < 3000, `预检总耗时 ${pass.ms}ms（零 token）`)

  mode = 'auth'
  const failAuth = await preflight({ baseUrl, apiKey: 'bad' })
  ok(failAuth.ok === false && failAuth.layer === 'auth', `Key 错 → 不进 L3（${failAuth.layer}）`)

  const failDns = await preflight({ baseUrl: 'https://nope-nope-nope.invalid/v1', apiKey: 'k' })
  ok(failDns.ok === false && failDns.layer === 'dns', `DNS 失败 → 不进 L3（${failDns.layer}）`)
} finally {
  server.close()
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
