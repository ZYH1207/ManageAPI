/**
 * 验证决策页拖拽排序（整张表都能拖）：
 *   1. 没拖过时按「有效成本 = 价格 ÷ 质量」自动排
 *   2. 拖动后保存的就是页面顺序，网关照这个先后派活
 *   3. 把「不会登场」的行拖到第一，位置照摆，但网关仍然跳过它（准入是硬门槛）
 *   4. 传空数组 = 恢复自动
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

let state = await api('GET', '/api/state')
const key = state.gateway.keys[0].key

const nameOf = (offerId) => {
  const offer = state.offers.find((o) => o.id === offerId)
  const provider = state.providers.find((p) => p.id === offer.providerId)
  return `${provider?.name}/${offer.upstreamName}`
}

function show(label) {
  const d = state.decisions.find((x) => x.modelKey === 'test-model-a')
  console.log(`\n${label}${d.manual ? '（手动）' : '（自动）'}`)
  for (const c of d.candidates) {
    const tag = c.admission?.ok ? '' : `  ← ${c.admission?.kind || '不登场'}`
    console.log(`  #${c.rank} ${String(c.providerName).padEnd(8)} 有效成本=${c.effective?.toFixed(2)}${tag}`)
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

const order = () => state.decisions.find((x) => x.modelKey === 'test-model-a').candidates.map((c) => c.offerId)
const drag = async (ids) => {
  state = await api('PUT', '/api/decisions/test-model-a/order', { order: ids })
}

show('默认顺序')
console.log('实际请求 →', await hit())

// 1) 把最便宜但不健康的那条（星链 degraded）拖到第一：位置照摆，但不会被派活
const all = order()
const dead = state.decisions
  .find((x) => x.modelKey === 'test-model-a')
  .candidates.find((c) => !c.admission?.ok)
if (dead) {
  await drag([dead.offerId, ...all.filter((id) => id !== dead.offerId)])
  show(`把「不会登场」的 ${nameOf(dead.offerId)} 拖到第一`)
  const served = await hit()
  console.log('实际请求 →', served)
  console.log(served === dead.providerName ? '  ✗ 不该派给不会登场的站' : '  ✓ 仍然跳过了不会登场的站')
}

// 2) 把健康但不便宜的那条拖到第一：这次真的会改变派活
const healthy = state.decisions
  .find((x) => x.modelKey === 'test-model-a')
  .candidates.filter((c) => c.admission?.ok)
const last = healthy[healthy.length - 1]
await drag([last.offerId, ...order().filter((id) => id !== last.offerId)])
show(`把能登场的 ${nameOf(last.offerId)} 拖到第一`)
const served2 = await hit()
console.log('实际请求 →', served2)
console.log(served2 === last.providerName ? '  ✓ 手动顺序生效' : `  ✗ 期望 ${last.providerName}，实际 ${served2}`)

// 3) 恢复自动
await drag([])
show('恢复自动')
console.log('实际请求 →', await hit())
