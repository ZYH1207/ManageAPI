/**
 * 网关端到端验证：路由、故障切换、流式、鉴权。
 * 环境要求（README「跑测试」一节）：
 *   MODE=good      PORT=5101 node .test/mock-upstream.mjs   # 正常A
 *   MODE=good      PORT=5102 node .test/mock-upstream.mjs   # 正常B
 *   MODE=fail      PORT=5103 node .test/mock-upstream.mjs   # 便宜但会挂（chat 一律 503）
 *   MANAGE_API_HOME=<临时目录> node daemon/index.js --port 4399
 */
import { AUTO_ROUTE_CLIENT_SWITCH } from '../core/auto-route.js'

const BASE = process.env.GW_BASE || 'http://127.0.0.1:4399'

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
    for (const f of r.failures || []) console.log(`    ✗ ${f.providerName}: ${(f.error || '(无错误信息)').slice(0, 80)}`)
  }
}

console.log('\n=== 7. 客户端拨开关：点 AutoThink 开接管，点别的模型关接管 ===')
if (!AUTO_ROUTE_CLIENT_SWITCH) {
  // 2026-10-30：客户端拨开关暂时收起（缓存命中率原因，见 core/auto-route.js）。
  // 这一段验的就反过来：清单里不能有 AutoThink；面板开关仍然是可用的
  const listed = async () =>
    (await (await fetch(`${BASE}/v1/models`, { headers: auth })).json()).data.map((m) => m.id)
  const ids = await listed()
  if (ids.includes('AutoThink')) throw new Error(`收起状态下清单不该有 AutoThink，实际 ${JSON.stringify(ids)}`)
  if (ids.length < 1) throw new Error('清单空了——真模型应该照旧全部列出')
  console.log('清单（无 AutoThink）', JSON.stringify(ids))
  let st = await api('PATCH', '/api/settings', { autoRouteEnabled: true })
  if (!st.autoRoute?.enabled) throw new Error('面板开关应该还能打开接管（能力没删）')
  st = await api('PATCH', '/api/settings', { autoRouteEnabled: false })
  if (st.autoRoute?.enabled) throw new Error('面板开关应该还能关掉接管')
  console.log('面板开关 开→关 正常，接管能力保留')
} else {
  // 清单始终是「AutoThink + 全场」，接管与否都这样——客户端才能在同一个下拉里拨开关
  const listed = async () =>
    (await (await fetch(`${BASE}/v1/models`, { headers: auth })).json()).data.map((m) => m.id)
  const idleIds = await listed()
  if (idleIds[0] !== 'AutoThink' || idleIds.length < 2) {
    throw new Error(`清单应为 AutoThink + 全场，实际 ${JSON.stringify(idleIds)}`)
  }
  console.log('未接管时清单', JSON.stringify(idleIds))

  // 未接管时点 AutoThink → 接管打开，这一单本身也按接管派活
  const turnOn = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ model: 'AutoThink', messages: [{ role: 'user', content: 'hi' }] }),
  })
  if (!turnOn.ok) throw new Error(`点 AutoThink 应 200，实际 ${turnOn.status} ${await turnOn.text()}`)
  const served = decodeURIComponent(turnOn.headers.get('x-manageapi-model') || '')
  if (!served) throw new Error('响应缺 X-ManageAPI-Model 头')
  console.log('点 AutoThink → 200，实际派给', served)
  let st = await api('GET', '/api/state')
  if (!st.autoRoute?.enabled) throw new Error('点 AutoThink 后自动路由应已打开')

  // 接管中清单照样是全量（不再是只有 AutoThink）
  const onIds = await listed()
  if (onIds.length < 2 || onIds[0] !== 'AutoThink') {
    throw new Error(`接管中清单仍应是全量，实际 ${JSON.stringify(onIds)}`)
  }
  console.log('接管中清单', JSON.stringify(onIds))

  // 流式也必须带真实模型头
  const stream = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ model: 'AutoThink', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })
  if (!stream.ok) throw new Error(`AutoThink 流式应 200，实际 ${stream.status}`)
  const streamServed = decodeURIComponent(stream.headers.get('x-manageapi-model') || '')
  if (!streamServed) throw new Error('流式响应缺 X-ManageAPI-Model 头')
  if (!(await stream.text()).includes('[DONE]')) throw new Error('流式没走到 [DONE]')
  console.log('流式 200，X-ManageAPI-Model =', streamServed)

  // 接管中点别的模型 → 关接管、就派那一个，并把它钉住
  const named = onIds.find((id) => id !== 'AutoThink')
  const turnOff = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ model: named, messages: [{ role: 'user', content: 'hi' }] }),
  })
  if (!turnOff.ok) throw new Error(`点 ${named} 应 200，实际 ${turnOff.status} ${await turnOff.text()}`)
  st = await api('GET', '/api/state')
  if (st.autoRoute?.enabled) throw new Error('点别的模型后自动路由应已关闭')
  if (st.autoRoute?.modelKey) throw new Error('关接管后应清掉挑选记录（modelKey 只属于接管期）')
  if (!st.pinnedModelKey) throw new Error('关接管后应钉住客户端选的那个模型')
  console.log(`点 ${named} → 自动路由已关，pinnedModelKey=${st.pinnedModelKey}`)

  // 解除钉子：界面上的小叉就是这条 PATCH
  st = await api('PATCH', '/api/settings', { pinnedModelKey: '' })
  if (st.pinnedModelKey) throw new Error('解除后 pinnedModelKey 应为 null')
  console.log('解除钉子 → pinnedModelKey =', st.pinnedModelKey)
}
