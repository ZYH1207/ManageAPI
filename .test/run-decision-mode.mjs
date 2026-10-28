/**
 * 决策侧重端到端验证：三档切换真的会改「谁排前面」，网关也真的跟着换站。
 *
 * 前置（与 run-order / run-latency 同一套环境）：
 *   MODE=good PORT=5101 node .test/mock-upstream.mjs &
 *   MODE=degraded PORT=5102 node .test/mock-upstream.mjs &
 *   MODE=truncated PORT=5103 node .test/mock-upstream.mjs &
 *   MANAGE_API_HOME=$(mktemp -d) node daemon/index.js --port 4399 &
 *   node .test/seed-demo.mjs
 *
 * 用法：node .test/run-decision-mode.mjs
 *
 * 断言口径（不看具体哪个站，只看规则）：
 *   1. /api/state 下发三档表，PATCH 非法档位被 400 挡住
 *   2. 每档下「能登场」的候选按该档口径单调不回头（性价比看有效成本、价格看名义价、速度看首字）
 *   3. 不可用的候选（可疑/不稳定/慢速）在任何一档下都排在最后
 *   4. 网关实际派给的站 = 该档下第一张能登场的牌
 */
const BASE = process.env.BASE || 'http://127.0.0.1:4399'

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

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

let state = await api('GET', '/api/state')
const key = state.gateway.keys[0].key
const model = 'test-model-a'

console.log('[1] 三档表下发 + 非法值被挡住')
{
  ok(Array.isArray(state.decisionModes) && state.decisionModes.length === 3, `decisionModes 三档`)
  ok(state.decisionMode === 'value', `默认档 ${state.decisionMode}`)
  const res = await fetch(`${BASE}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decisionMode: 'cheapest' }),
  })
  ok(res.status === 400, `非法档位 → ${res.status}`)
  state = await api('GET', '/api/state')
  ok(state.decisionMode === 'value', '非法值没有写进库')
}

const pick = (s) => s.decisions.find((d) => d.modelKey === model)
const monotonic = (values) => values.every((v, i) => i === 0 || values[i - 1] <= v)

async function hit() {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  })
  await res.text()
  return decodeURIComponent(res.headers.get('x-manageapi-provider') || '(none)')
}

const field = { value: 'effective', price: 'price', speed: 'ttftMs' }

for (const mode of ['value', 'price', 'speed']) {
  console.log(`[2] ${mode} 档：排序口径 + 网关跟随`)
  // 看板档位也一起切到同一个口径，下面才能断言「结论句的站 = 网关派活的站」
  state = await api('PATCH', '/api/settings', { decisionMode: mode, headlineMode: mode })
  ok(state.decisionMode === mode, `已切到 ${mode}（${state.decisionModeText}）`)
  const decision = pick(state)
  const admitted = decision.candidates.filter((c) => c.admission?.ok)
  const rest = decision.candidates.filter((c) => !c.admission?.ok)
  ok(admitted.length > 0, `有 ${admitted.length} 张能登场的牌`)
  ok(
    monotonic(admitted.map((c) => c[field[mode]] ?? Infinity)),
    `${mode} 档按 ${field[mode]} 单调：${admitted.map((c) => c[field[mode]]).join(' ≤ ')}`,
  )
  // 不可用的永远在最后：任何一个可用行的下标都必须小于第一个不可用行
  const firstRest = decision.candidates.findIndex((c) => !c.admission?.ok)
  ok(
    firstRest === -1 || decision.candidates.slice(firstRest).every((c) => !c.admission?.ok),
    '不可用的候选全部排在后面',
  )
  ok(rest.length >= 0, `不可用 ${rest.length} 张（不参与排序结论）`)
  const got = await hit()
  ok(
    got === (admitted[0]?.providerName ?? '(none)'),
    `网关派给第一张能登场的牌：${got}（期望 ${admitted[0]?.providerName}）`,
  )
  // 看板顶部那句必须和网关实际派活一致（两边吃同一份 decisions）
  ok(state.headline?.mode === mode, `看板结论句也按 ${mode} 档算：${state.headline?.mode}`)
  ok(
    state.headline?.providerName === (admitted[0]?.providerName ?? null),
    `看板结论句的站 = 网关派活的那个：${state.headline?.providerName}`,
  )
  ok(state.headline?.modelKey === decision.modelKey, `结论句的模型：${state.headline?.modelKey}`)
}

console.log('[3] 结论句可以换模型（settings.focusModel）')
{
  const models = (state.headlineModels || []).map((row) => row.modelKey)
  ok(models.includes('test-model-a'), `下拉里有 test-model-a：${models.join(', ')}`)
  ok(state.settings.focusModel === null, '默认不指定，按关注度自动挑')
  state = await api('PATCH', '/api/settings', { focusModel: 'test-model-a' })
  ok(state.settings.focusModel === 'test-model-a', `已落库：${state.settings.focusModel}`)
  ok(state.headline?.modelKey === 'test-model-a', `结论句跟着换：${state.headline?.modelKey}`)
  state = await api('PATCH', '/api/settings', { focusModel: null })
  ok(state.settings.focusModel === null, '传 null 可以交回自动')
  // 不存在的模型不报错，只是回落自动
  state = await api('PATCH', '/api/settings', { focusModel: 'no-such-model' })
  ok(state.headline?.modelKey === 'test-model-a', `选了不存在的模型 → 回落可用模型：${state.headline?.modelKey}`)
  state = await api('PATCH', '/api/settings', { focusModel: null })
}

console.log('[4] 看板档位和路由档位是两件事')
{
  // 路由留在性价比，看板切到首字速度：结论句换成最快的那个，网关派活不变
  state = await api('PATCH', '/api/settings', { decisionMode: 'value', headlineMode: 'speed' })
  ok(state.decisionMode === 'value' && state.headlineMode === 'speed', '两个档位各存各的')
  const decision = pick(state)
  const admitted = decision.candidates.filter((c) => c.admission?.ok)
  const fastest = [...admitted].sort((a, b) => (a.ttftMs ?? Infinity) - (b.ttftMs ?? Infinity))[0]
  ok(state.headline?.mode === 'speed', `结论句按看板档位算：${state.headline?.mode}`)
  ok(
    state.headline?.providerName === (fastest?.providerName ?? null),
    `结论句挑最快的：${state.headline?.providerName}（期望 ${fastest?.providerName}）`,
  )
  const got = await hit()
  ok(got === (admitted[0]?.providerName ?? '(none)'), `网关仍按性价比派活：${got}`)
  state = await api('PATCH', '/api/settings', { headlineMode: 'value' })
}

// 收尾：切回默认，别把测试状态留给下一个人
state = await api('PATCH', '/api/settings', { decisionMode: 'value', headlineMode: 'value' })
ok(state.decisionMode === 'value' && state.headlineMode === 'value', '已恢复默认档（性价比）')

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
