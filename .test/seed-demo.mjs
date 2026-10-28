/** 造一份演示数据：三个站、真实价格关系、探针结果各不相同。 */
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

const stations = [
  { name: '云雀 API', url: 'http://127.0.0.1:5101/v1', manual: [2.5, 10] },
  { name: '星链 API', url: 'http://127.0.0.1:5102/v1', ratio: 0.7 },
  { name: '极光 API', url: 'http://127.0.0.1:5103/v1', ratio: 0.5 },
]

let state = await api('GET', '/api/state')
for (const station of stations) {
  if (state.providers.some((p) => p.name === station.name)) continue
  state = await api('POST', '/api/providers', { name: station.name, baseUrl: station.url })
  const provider = state.providers.find((p) => p.name === station.name)
  await api('POST', '/api/credentials', {
    providerId: provider.id,
    label: '主 Key',
    secret: `sk-demo-${provider.id}`,
    quotaRemaining: station.name === '云雀 API' ? 48.6 : null,
    currency: 'USD',
  })
  await api('POST', `/api/providers/${provider.id}/sync`, {})
}

state = await api('GET', '/api/state')
for (const station of stations) {
  const provider = state.providers.find((p) => p.name === station.name)
  for (const offer of state.offers.filter((o) => o.providerId === provider.id)) {
    if (station.manual) {
      await api('PATCH', `/api/offers/${offer.id}`, {
        inPrice: station.manual[0], outPrice: station.manual[1], currency: 'USD', ratio: null,
      })
    } else {
      await api('PATCH', `/api/offers/${offer.id}`, { ratio: station.ratio })
    }
  }
}

await api('POST', '/api/benchmarks/import', {
  providerId: state.providers.find((p) => p.name === '云雀 API').id,
})

console.log('跑探针…')
state = await api('POST', '/api/probes/run', { limit: 20 })
for (const [offerId, score] of Object.entries(state.scores)) {
  const offer = state.offers.find((o) => o.id === offerId)
  const provider = state.providers.find((p) => p.id === offer.providerId)
  console.log(`${provider.name} ${offer.upstreamName} → ${score.status} 可路由=${score.routable}`)
}
const line = state.headline
console.log(
  '结论:',
  line ? `选用 ${line.providerName} 的 ${line.modelKey}（${line.mode}）` : '（无）',
)
