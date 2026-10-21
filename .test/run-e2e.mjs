/** 端到端验证：三个 mock 站 → 同步模型 → 探针 → 评分。 */
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
  { name: '正常站', url: 'http://127.0.0.1:5101/v1' },
  { name: '掉包站', url: 'http://127.0.0.1:5102/v1' },
  { name: '砍额度站', url: 'http://127.0.0.1:5103/v1' },
]

let state = await api('GET', '/api/state')
for (const station of stations) {
  state = await api('POST', '/api/providers', { name: station.name, baseUrl: station.url })
  const provider = state.providers.find((p) => p.name === station.name)
  await api('POST', '/api/credentials', { providerId: provider.id, label: '默认', secret: `sk-test-${provider.id}` })
  const synced = await api('POST', `/api/providers/${provider.id}/sync`, {})
  console.log(`${station.name}: 同步到 ${synced.sync.fetched} 个模型`)
}

console.log('\n开始探测…')
state = await api('POST', '/api/probes/run', { limit: 20 })

console.log('\n=== 单次探测结果 ===')
for (const r of state.probeResults) {
  const provider = state.providers.find((p) => p.id === r.providerId)?.name
  console.log(
    `${String(provider).padEnd(6)} ${String(r.model).padEnd(14)} ` +
    `ok=${r.ok} 指纹=${r.fingerprintOk} 截断=${r.truncated} 虚报=${r.billingInflated} ttft=${r.ttftMs}ms`,
  )
  if (r.fingerprintOk === false) console.log(`         原始输出: ${r.fingerprintRaw}`)
  if (r.truncationDetail) console.log(`         截断细节: ${r.truncationDetail}`)
}

console.log('\n=== 聚合评分 ===')
for (const [offerId, score] of Object.entries(state.scores)) {
  const offer = state.offers.find((o) => o.id === offerId)
  const provider = state.providers.find((p) => p.id === offer.providerId)?.name
  console.log(
    `${String(provider).padEnd(6)} ${String(offer.upstreamName).padEnd(14)} ` +
    `状态=${score.status} 可用=${score.availability} 完整性=${score.integrity?.toFixed(2)} ` +
    `质量=${score.quality?.toFixed(2)} 可路由=${score.routable}`,
  )
}
