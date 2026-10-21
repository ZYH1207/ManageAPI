/** 验证多 Key 与用量统计。 */
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

async function chat(key, model, stream) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      ...(stream ? { stream: true } : {}),
    }),
  })
  const text = await res.text()
  return { status: res.status, text }
}

let state = await api('GET', '/api/state')
const key1 = state.gateway.keys[0]
console.log('现有 Key:', key1.name)

state = await api('POST', '/api/gateway/keys', { name: 'Cline', monthlyTokenLimit: null })
const key2 = state.gateway.keys.find((k) => k.name === 'Cline')
console.log('新建 Key:', key2.name, key2.key.slice(0, 18) + '…')

console.log('\n=== 流式请求（客户端没要求 usage）===')
const r1 = await chat(key1.key, 'test-model-a', true)
console.log('状态', r1.status)
console.log('响应里含 usage 字段:', r1.text.includes('"usage"'), '（应为 false，网关把纯 usage chunk 滤掉了）')
console.log('含 [DONE]:', r1.text.includes('[DONE]'))

console.log('\n=== 非流式请求 ===')
const r2 = await chat(key1.key, 'test-model-a', false)
console.log('状态', r2.status, '响应含 usage:', r2.text.includes('"usage"'))

console.log('\n=== 用第二把 Key 发流式 ===')
const r3 = await chat(key2.key, 'test-model-b', true)
console.log('状态', r3.status)

console.log('\n=== 无效 Key ===')
const r4 = await chat('sk-mapi-invalid', 'test-model-a', false)
console.log('状态', r4.status)

await new Promise((resolve) => setTimeout(resolve, 600))

const { usage } = await api('GET', '/api/usage?days=7')
console.log('\n=== 用量统计 ===')
console.log(`总请求 ${usage.totals.requests}，输入 ${usage.totals.input}，输出 ${usage.totals.output}，平均首字 ${usage.totals.avgTtftMs ?? '—'}ms`)

console.log('\n按 Key：')
for (const [keyId, row] of Object.entries(usage.byKey)) {
  const name = state.gateway.keys.find((k) => k.id === keyId)?.name || keyId
  console.log(`  ${String(name).padEnd(10)} ${row.requests} 请求  in=${row.input} out=${row.output}`)
}

console.log('\n按模型：')
for (const [model, row] of Object.entries(usage.byModel)) {
  console.log(`  ${String(model).padEnd(16)} ${row.requests} 请求  in=${row.input} out=${row.output}`)
}

console.log('\n按站点：')
for (const [providerId, row] of Object.entries(usage.byProvider)) {
  const name = state.providers.find((p) => p.id === providerId)?.name || (providerId === '-' ? '未成功' : providerId)
  console.log(`  ${String(name).padEnd(10)} ${row.requests} 请求`)
}
