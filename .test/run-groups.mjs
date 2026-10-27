/** 验证分组：同站同模型多分组、独立定价、独立参与路由。 */
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
const provider = state.providers.find((p) => p.name === '云雀 API')
if (!provider) throw new Error('先跑 seed-demo.mjs')

const base = state.offers.find(
  (o) => o.providerId === provider.id && o.upstreamName === 'test-model-a' && !o.group,
)
if (!base) throw new Error('找不到未分组的 test-model-a')
console.log('原 offer:', base.upstreamName, '| group =', JSON.stringify(base.group))

state = await api('POST', `/api/offers/${base.id}/duplicate`, { group: 'Pro 号池' })
const dup = state.offers.find((o) => o.providerId === provider.id && o.group === 'Pro 号池')
console.log('新分组:', dup.upstreamName, '| group =', JSON.stringify(dup.group), '| 价格已继承:', dup.ratio)

// 两个分组给不同价格：默认 0.7 倍，Pro 号池 0.3 倍
await api('PATCH', `/api/offers/${base.id}`, { ratio: 0.7 })
await api('PATCH', `/api/offers/${dup.id}`, { ratio: 0.3 })

state = await api('GET', '/api/state')
const group = state.ranked.find((g) => g.modelKey === 'test-model-a')
console.log('\n比价表里 test-model-a 的供给：')
for (const row of group.rows) {
  const name = state.providers.find((p) => p.id === row.providerId)?.name
  console.log(
    `  ${String(name).padEnd(8)} ${String(row.group || '(默认)').padEnd(10)} ` +
    `倍率=${String(row.ratio).padEnd(5)} ¥${row.blendedCnyPerMtok?.toFixed(2)}`,
  )
}

console.log('\n跑探针…')
state = await api('POST', '/api/probes/run', { limit: 20 })

const key = state.gateway.keys[0].key
const res = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: 'test-model-a', messages: [{ role: 'user', content: 'hi' }] }),
})
console.log('请求状态:', res.status)

await new Promise((r) => setTimeout(r, 2500)) // 路由日志攒批 2000ms 落盘
const log = await api('GET', '/api/gateway/routing?limit=1')
const latest = log.routing[0]
console.log('选中:', latest.chosenProviderName, '| 分组:', JSON.stringify(latest.chosenGroup))
console.log('\n候选顺序：')
for (const c of latest.candidates || []) {
  console.log(`  #${c.rank} ${c.providerName} ${c.group || '(默认)'} 有效成本=${c.effective?.toFixed(2)} 可路由=${c.routable}`)
}
