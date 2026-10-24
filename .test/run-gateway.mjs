/**
 * 网关端到端验证：路由、故障切换、流式、鉴权。
 * 环境要求（README「跑测试」一节）：
 *   MODE=good      PORT=5101 node .test/mock-upstream.mjs   # 正常A
 *   MODE=good      PORT=5102 node .test/mock-upstream.mjs   # 正常B
 *   MODE=fail      PORT=5103 node .test/mock-upstream.mjs   # 便宜但会挂（chat 一律 503）
 *   MANAGE_API_HOME=<临时目录> node daemon/index.js --port 4399
 */
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
  { name: '便宜但会挂', url: 'http://127.0.0.1:5103/v1', ratio: 0.1 },
  { name: '正常A', url: 'http://127.0.0.1:5101/v1', manual: [2.5, 10] },
  { name: '正常B', url: 'http://127.0.0.1:5102/v1', ratio: 1.5 },
]

let state = await api('GET', '/api/state')
// 多 Key 改造后结构是 gateway.keys[]；取第一把启用的
const gatewayKey = state.gateway.keys.find((k) => k.enabled)?.key
if (!gatewayKey) throw new Error('没有可用的网关 Key')
console.log('网关 Key:', gatewayKey)

for (const station of stations) {
  if (state.providers.some((p) => p.name === station.name)) continue
  state = await api('POST', '/api/providers', { name: station.name, baseUrl: station.url })
  const provider = state.providers.find((p) => p.name === station.name)
  await api('POST', '/api/credentials', { providerId: provider.id, label: '默认', secret: `sk-${provider.id}` })
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
      // 只写 ratio 不写 pricingMode 不会生效（字段式 PATCH，manual 模式下倍率不参与算价），
      // 界面里倍率输入框在 manual 模式是禁用的，直调 API 必须显式带上模式
      await api('PATCH', `/api/offers/${offer.id}`, { ratio: station.ratio, pricingMode: 'ratio' })
    }
  }
}
await api('POST', '/api/benchmarks/import', {
  providerId: state.providers.find((p) => p.name === '正常A').id,
})

const auth = { Authorization: `Bearer ${gatewayKey}` }

console.log('\n=== 1. 无 Key 访问 ===')
{
  const res = await fetch(`${BASE}/v1/models`)
  console.log('状态', res.status, (await res.text()).slice(0, 120))
}

console.log('\n=== 2. GET /v1/models ===')
{
  const res = await fetch(`${BASE}/v1/models`, { headers: auth })
  const data = await res.json()
  console.log('状态', res.status, '模型数', data.data.length, JSON.stringify(data.data.map((m) => m.id)))
}

console.log('\n=== 3. 非流式，最便宜的站会挂 → 应自动切换 ===')
{
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ model: 'test-model-a', messages: [{ role: 'user', content: 'hi' }] }),
  })
  console.log('状态', res.status)
  console.log('选中站', decodeURIComponent(res.headers.get('x-manageapi-provider') || '(无)'))
  console.log('尝试次数', res.headers.get('x-manageapi-attempts'))
  console.log('响应体', (await res.text()).slice(0, 200))
}

console.log('\n=== 4. 流式 ===')
{
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ model: 'test-model-b', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })
  console.log('状态', res.status, '类型', res.headers.get('content-type'))
  console.log('选中站', decodeURIComponent(res.headers.get('x-manageapi-provider') || '(无)'))
  const text = await res.text()
  console.log('SSE 片段', text.slice(0, 160).replace(/\n/g, ' '))
  console.log('含 DONE', text.includes('[DONE]'))
}

console.log('\n=== 5. 不存在的模型 ===')
{
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ model: 'no-such-model', messages: [] }),
  })
  console.log('状态', res.status, (await res.text()).slice(0, 160))
}

console.log('\n=== 6. 路由决策日志 ===')
{
  // 决策日志是 2 秒攒批落盘的，等一下再查
  await new Promise((r) => setTimeout(r, 2500))
  const data = await api('GET', '/api/gateway/routing?limit=5')
  for (const r of data.routing) {
    console.log(
      `${r.model} → ${r.chosenProviderName || '全部失败'} | 尝试 ${r.attempts} | ${r.latencyMs}ms | ${r.outcome}`,
    )
    for (const c of r.candidates || []) {
      console.log(
        `    #${c.rank} ${c.providerName} 价格=${c.price?.toFixed(2)} 质量=${c.quality} ` +
        `有效=${c.effective?.toFixed(2)} 可路由=${c.routable}`,
      )
    }
    for (const f of r.failures || []) console.log(`    ✗ ${f.providerName}: ${f.error.slice(0, 80)}`)
  }
}
