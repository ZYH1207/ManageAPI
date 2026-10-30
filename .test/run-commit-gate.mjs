/**
 * 提交判据回归：上游 200 但只吐 role 空帧的站，不能被当成「已提交」。
 *
 * 环境要求（同 run-gateway.mjs）：
 *   MODE=good     PORT=5101 node .test/mock-upstream.mjs
 *   MODE=good     PORT=5102 node .test/mock-upstream.mjs
 *   MODE=roleonly PORT=5104 node .test/mock-upstream.mjs   # 只吐 role 帧就收尾
 *   MANAGE_API_HOME=<临时目录> node daemon/index.js --port 4399
 *
 * 断言：请求最终落在正常站，且路由日志里 角色帧站 被记为失败。
 * 旧行为下 role 帧会把 committed 置真 → 用户拿到空回答、attempts=1。
 */
const BASE = 'http://127.0.0.1:4399'
const BAD = '角色帧站'

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

const GOOD = [
  { name: '正常A', port: 5101 },
  { name: '正常B', port: 5102 },
]

async function ensureProvider(name, port) {
  let st = await api('GET', '/api/state')
  if (st.providers.some((p) => p.name === name)) return
  st = await api('POST', '/api/providers', { name, baseUrl: `http://127.0.0.1:${port}/v1` })
  const provider = st.providers.find((p) => p.name === name)
  await api('POST', '/api/credentials', { providerId: provider.id, label: '默认', secret: `sk-${provider.id}` })
  await api('POST', `/api/providers/${provider.id}/sync`, {})
}

for (const g of GOOD) await ensureProvider(g.name, g.port)

let state = await api('GET', '/api/state')
if (!state.providers.some((p) => p.name === BAD)) {
  state = await api('POST', '/api/providers', { name: BAD, baseUrl: 'http://127.0.0.1:5104/v1' })
  const provider = state.providers.find((p) => p.name === BAD)
  await api('POST', '/api/credentials', { providerId: provider.id, label: '默认', secret: `sk-${provider.id}` })
  await api('POST', `/api/providers/${provider.id}/sync`, {})
  state = await api('GET', '/api/state')
  // 最便宜 → 一定排在第一顺位，这样「换站」才有说服力
  for (const offer of state.offers.filter((o) => o.providerId === provider.id)) {
    await api('PATCH', `/api/offers/${offer.id}`, { inPrice: 0.01, outPrice: 0.01, currency: 'USD', ratio: null })
  }
  state = await api('GET', '/api/state')
}

const key = state.gateway.keys.find((k) => k.enabled)?.key
if (!key) throw new Error('没有可用的网关 Key')

const res = await fetch(BASE + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model: 'test-model-a',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  }),
})
const text = await res.text()

// 路由决策每 2 秒落一次盘，等它刷完再读，否则读到的是上一条
await new Promise((r) => setTimeout(r, 2600))
state = await api('GET', '/api/state')
const row = (state.routing || [])
  .filter((r) => r.model === 'test-model-a')
  .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())[0]
if (!row) throw new Error('没有路由决策记录')

const chosen = row.chosenProviderName
const attempts = row.attempts
const sawBadFailure = (row.failures || []).some((f) => f.providerName === BAD)

console.log(`HTTP ${res.status} · 选站=${chosen} · 尝试=${attempts} · ${BAD}被记失败=${sawBadFailure}`)
console.log(`响应含内容: ${/"content":"[^"]+/.test(text)} · 含 DONE: ${text.includes('[DONE]')}`)

const problems = []
if (chosen === BAD) problems.push(`${BAD} 被当成成功站返回了空回答`)
if (attempts < 2) problems.push(`attempts=${attempts}，说明没换站`)
if (!sawBadFailure) problems.push('失败名单里没有 ' + BAD)
if (!text.includes('[DONE]')) problems.push('下游没收到正常结束帧')

if (problems.length) {
  console.error('\n✗ 提交判据回归失败：')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log('\n✓ 提交判据回归通过：role 空帧不算提交，已自动换站')
