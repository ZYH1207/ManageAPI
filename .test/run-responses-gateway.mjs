/**
 * Responses 协议网关验证：路由、协议降级、流式、失败换站。
 *
 * 环境要求（跟 run-gateway.mjs 同套路，只是多一个「不给 responses」的站）：
 *   MODE=noresponses PORT=5104 node .test/mock-upstream.mjs   # 只给 chat 的站
 *   MODE=failedstream PORT=5105 node .test/mock-upstream.mjs  # responses 跑到一半挂
 *   MODE=good        PORT=5101 node .test/mock-upstream.mjs   # 正常站
 *   MANAGE_API_HOME=<临时目录> node daemon/index.js --port 4399
 *
 * 验的是三件在 Chat 协议下不存在、只在 Responses 下才会踩到的坑：
 *   1. 只给 chat 的站必须被判成 protocol-unsupported（不拉低可用率）并被跳过
 *   2. 200 流里发 response.failed 也算失败，必须能换站
 *   3. usage 要从 input_tokens/output_tokens 正确映射，不能记成 0
 */
const BASE = 'http://127.0.0.1:4399'

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

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
  // 先放一个「便宜但不支持 responses」的站：如果路由不考虑协议，它会抢第一
  { name: '只给chat', url: 'http://127.0.0.1:5104/v1', ratio: 0.01 },
  { name: 'responses中途挂', url: 'http://127.0.0.1:5105/v1', ratio: 0.02 },
  { name: '正常站', url: 'http://127.0.0.1:5101/v1', manual: [2.5, 10] },
]

let state = await api('GET', '/api/state')
const gatewayKey = state.gateway.keys.find((k) => k.enabled)?.key
if (!gatewayKey) throw new Error('没有可用的网关 Key')
console.log('网关 Key:', gatewayKey)

for (const station of stations) {
  if (state.providers.some((p) => p.name === station.name)) continue
  state = await api('POST', '/api/providers', { name: station.name, baseUrl: station.url })
  const provider = state.providers.find((p) => p.name === station.name)
  await api('POST', '/api/credentials', {
    providerId: provider.id,
    label: '默认',
    secret: `sk-${provider.id}`,
  })
  await api('POST', `/api/providers/${provider.id}/sync`, {})
}

state = await api('GET', '/api/state')
for (const station of stations) {
  const provider = state.providers.find((p) => p.name === station.name)
  for (const offer of state.offers.filter((o) => o.providerId === provider.id)) {
    if (station.manual) {
      await api('PATCH', `/api/offers/${offer.id}`, {
        inPrice: station.manual[0],
        outPrice: station.manual[1],
        currency: 'USD',
        ratio: null,
      })
    } else {
      await api('PATCH', `/api/offers/${offer.id}`, {
        ratio: station.ratio,
        pricingMode: 'ratio',
      })
    }
  }
}

const gw = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayKey}` },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return {
    status: res.status,
    provider: decodeURIComponent(res.headers.get('x-manageapi-provider') || ''),
    attempts: res.headers.get('x-manageapi-attempts'),
    text,
  }
}

console.log('\n=== 1. Responses 非流式：必须跳过不支持 responses 的站 ===')
{
  const r = await gw('/v1/responses', {
    model: 'test-model-a',
    input: 'hello responses',
    max_output_tokens: 32,
  })
  check('HTTP 200', r.status === 200, `got ${r.status}`)
  check('落到了支持 responses 的站', r.provider === '正常站', `provider=${r.provider}`)
  check('响应体是 Responses 形状', r.text.includes('"object":"response"'))
  check('没有把 403 的错误文本透给客户端', !r.text.includes('does not allow'))
}

console.log('\n=== 2. Responses 流式：事件必须完整 ===')
{
  const r = await gw('/v1/responses', {
    model: 'test-model-a',
    input: 'stream please',
    stream: true,
    max_output_tokens: 32,
  })
  check('HTTP 200', r.status === 200, `got ${r.status}`)
  check('有 response.completed', r.text.includes('event: response.completed'))
  check('有 output_text.delta', r.text.includes('event: response.output_text.delta'))
  check('落到了支持 responses 的站', r.provider === '正常站', `provider=${r.provider}`)
}

console.log('\n=== 3. Chat 协议不能被这次改动弄坏 ===')
{
  const r = await gw('/v1/chat/completions', {
    model: 'test-model-a',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 32,
  })
  check('HTTP 200', r.status === 200, `got ${r.status}`)
  check('响应体是 chat 形状', r.text.includes('"object":"chat.completion"'))
}

console.log('\n=== 4. usage 必须从 input_tokens/output_tokens 正确映射 ===')
{
  // 先取一次基准，再发一笔 responses 请求，看增量——usage 是异步写入的，
  // 直接查总量会被前面几步的请求污染，靠增量才能孤立出这一笔
  const before = await (await fetch(BASE + '/api/usage')).json()
  // 这个接口的形状是 {usage:{days:[日期字符串...], totals:{input,...}, byKey:{...}}}
  // 注意 days 是字符串数组不是对象，直接按 totals 读
  const sumInput = (payload) => payload.usage?.totals?.input || 0
  const inputBefore = sumInput(before)

  const r = await gw('/v1/responses', {
    model: 'test-model-a',
    input: 'usage mapping check',
    max_output_tokens: 32,
  })
  check('这一笔成功', r.status === 200, `got ${r.status}`)

  // usage 是批量落盘的（bufferTraffic / recordUsage 有延迟），等它刷一次
  let inputAfter = inputBefore
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const after = await (await fetch(BASE + '/api/usage')).json()
    inputAfter = sumInput(after)
    if (inputAfter > inputBefore) break
  }

  check(
    'usage 记录了 input token（input_tokens → prompt_tokens 映射生效）',
    inputAfter > inputBefore,
    `${inputBefore} → ${inputAfter}`,
  )
}

console.log('\n=== 5. 200 流里发 response.failed 也必须能换站 ===')
{
  // 这一步是本改动最核心的回归点：Responses 的失败不等于非 200，
  // 它可能先发 response.created 再发 response.failed。如果没在 commit 前拦住，
  // 客户端会收到一个空流，而且换站能力静默失效。
  const st = await api('GET', '/api/state')
  const bad = st.providers.find((p) => p.name === 'responses中途挂')
  const good = st.providers.find((p) => p.name === '正常站')
  // 把「中途挂」这条站定到远低于「正常站」的价格，确保它排第一被先试。
  // 必须用 manual（inPrice/outPrice）：ratio 模式在 siteRatio 缺失时算不出价，
  // effectiveUsd 会是 null，排序时被当成无穷大推到后面，根本不参与竞争。
  for (const offer of st.offers.filter((o) => o.providerId === bad.id)) {
    await api('PATCH', `/api/offers/${offer.id}`, {
      inPrice: 0.01,
      outPrice: 0.01,
      currency: 'USD',
      ratio: null,
    })
  }
  for (const offer of st.offers.filter((o) => o.providerId === good.id)) {
    await api('PATCH', `/api/offers/${offer.id}`, {
      inPrice: 50,
      outPrice: 150,
      currency: 'USD',
      ratio: null,
    })
  }

  const r = await gw('/v1/responses', {
    model: 'test-model-a',
    input: 'must fail over',
    stream: true,
    max_output_tokens: 32,
  })
  check('HTTP 200（换站成功）', r.status === 200, `got ${r.status}`)
  check('没有把 failed 事件透给客户端', !r.text.includes('response.failed'))
  check('最终落到了正常站', r.provider === '正常站', `provider=${r.provider}`)
  check('尝试次数 > 1（说明真的换了站）', Number(r.attempts) > 1, `attempts=${r.attempts}`)
  check('客户端收到了正文增量', r.text.includes('response.output_text.delta'))
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
