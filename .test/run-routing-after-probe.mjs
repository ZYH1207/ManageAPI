/** 验证：探针判定不可信的站，会被路由直接跳过。 */
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

let state = await api('GET', '/api/state')
const key = state.gateway.key

console.log('跑探针…')
state = await api('POST', '/api/probes/run', { limit: 20 })

console.log('\n=== 探针后的评分 ===')
for (const [offerId, score] of Object.entries(state.scores)) {
  const offer = state.offers.find((o) => o.id === offerId)
  const provider = state.providers.find((p) => p.id === offer.providerId)
  console.log(
    `${String(provider.name).padEnd(6)} ${String(offer.upstreamName).padEnd(14)} ` +
    `状态=${score.status.padEnd(8)} 质量=${score.quality?.toFixed(2)} 可路由=${score.routable}`,
  )
}

console.log('\n=== 探针前：最便宜但会挂的站被尝试了 2 次才成功 ===')
console.log('=== 探针后：应直接跳过它，1 次命中 ===')

const res = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: 'test-model-a', messages: [{ role: 'user', content: 'hi' }] }),
})
console.log(
  '状态', res.status,
  '| 选中', decodeURIComponent(res.headers.get('x-manageapi-provider') || '(无)'),
  '| 尝试', res.headers.get('x-manageapi-attempts'),
  '| 质量', res.headers.get('x-manageapi-quality'),
)

// 决策日志在响应结束后才落盘，等一拍再读
await new Promise((resolve) => setTimeout(resolve, 400))
const log = await api('GET', '/api/gateway/routing?limit=1')
const latest = log.routing[0]
console.log('\n决策候选顺序：')
for (const c of latest.candidates || []) {
  console.log(`  #${c.rank} ${c.providerName} 有效成本=${c.effective?.toFixed(2)} 可路由=${c.routable}`)
}
