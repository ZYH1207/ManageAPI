/** 验证延迟：展示 + 首字上限过滤。 */
const BASE = 'http://127.0.0.1:4399'

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

async function chat(key) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'test-model-a', messages: [{ role: 'user', content: 'hi' }] }),
  })
  await res.text()
  return decodeURIComponent(res.headers.get('x-manageapi-provider') || '(无)')
}

let state = await api('GET', '/api/state')
const key = state.gateway.keys[0].key

console.log('=== 各站首字延迟 ===')
for (const [offerId, score] of Object.entries(state.scores)) {
  const offer = state.offers.find((o) => o.id === offerId)
  if (offer.upstreamName !== 'test-model-a') continue
  const provider = state.providers.find((p) => p.id === offer.providerId)
  console.log(`  ${String(provider.name).padEnd(10)} 首字 ${score.ttftMs ?? '—'}ms  总耗时 ${score.latencyMs ?? '—'}ms  可路由 ${score.routable}`)
}

console.log('\n=== 不设上限 ===')
console.log('选中:', await chat(key))

console.log('\n=== 设首字上限 200ms ===')
state = await api('PATCH', '/api/settings', { maxTtftMs: 200 })
console.log('选中:', await chat(key))

await new Promise((r) => setTimeout(r, 2500)) // 路由日志攒批 2000ms 落盘
const log = await api('GET', '/api/gateway/routing?limit=1')
console.log('\n候选（含延迟判定）：')
for (const c of log.routing[0].candidates || []) {
  console.log(
    `  #${c.rank} ${String(c.providerName).padEnd(10)} 首字=${String(c.ttftMs ?? '—').padEnd(6)} ` +
    `可路由=${c.routable} 太慢=${c.tooSlow}`,
  )
}
