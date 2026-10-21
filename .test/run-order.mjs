/** 验证手动排序：上移/下移覆盖自动顺序，但可用性仍是硬约束。 */
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
const key = state.gateway.keys[0].key

function show(label) {
  const d = state.decisions.find((x) => x.modelKey === 'test-model-a')
  console.log(`\n${label}${d.manual ? '（手动）' : '（自动）'}`)
  for (const c of d.candidates) {
    console.log(`  #${c.rank} ${String(c.providerName).padEnd(8)} 可路由=${c.routable} 有效成本=${c.effective?.toFixed(2)}`)
  }
  console.log(`  → 选：${d.chosenProviderName || '无'}`)
}

async function hit() {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'test-model-a', messages: [{ role: 'user', content: 'hi' }] }),
  })
  await res.text()
  return decodeURIComponent(res.headers.get('x-manageapi-provider') || '无')
}

show('默认顺序')
console.log('实际请求 →', await hit())

// 手动把云雀移到第一位（模拟点击两次「上移」）
const d = state.decisions.find((x) => x.modelKey === 'test-model-a')
const ids = d.candidates.filter((c) => c.routable).map((c) => c.offerId)
console.log('\n手动顺序（原始）：', ids.map((id) => state.offers.find((o) => o.id === id).upstreamName + '@' + (state.providers.find((p) => p.id === state.offers.find((o) => o.id === id).providerId)?.name)).join(' → '))

const reordered = [...ids].reverse()
state = await api('PUT', '/api/decisions/test-model-a/order', { order: reordered })
show('手动把云雀挪到第一')
console.log('实际请求 →', await hit())

// 恢复自动
state = await api('PUT', '/api/decisions/test-model-a/order', { order: [] })
show('恢复自动')
console.log('实际请求 →', await hit())
