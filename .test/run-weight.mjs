/** 验证权重对决策的影响。 */
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

function show(label) {
  const decision = state.decisions.find((d) => d.modelKey === 'test-model-a')
  console.log(`\n${label}`)
  for (const c of decision.candidates) {
    console.log(
      `  #${c.rank} ${String(c.providerName).padEnd(8)} 权重=${String(c.weight).padEnd(4)} ` +
      `有效成本=${String(c.effective?.toFixed(2) ?? '—').padEnd(7)} 可路由=${c.routable}`,
    )
  }
  console.log(`  → 当前选：${decision.chosenProviderName || '无'}`)
}

show('默认（权重全 1.0）')

const yunque = state.providers.find((p) => p.name === '云雀 API')
state = await api('PATCH', `/api/providers/${yunque.id}`, { priorityWeight: 3 })
show('云雀权重 3.0')

const key = state.gateway.keys[0].key
const res = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: 'test-model-a', messages: [{ role: 'user', content: 'hi' }] }),
})
await res.text()
console.log('\n实际请求选中：', decodeURIComponent(res.headers.get('x-manageapi-provider') || '无'))

// 再试权重 0（禁用）
state = await api('PATCH', `/api/providers/${yunque.id}`, { priorityWeight: 0 })
show('云雀权重 0（禁用）')
