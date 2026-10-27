/**
 * 渠道分组的「分组 → 模型」映射自检。
 *
 * 现场的病（北辰，sub2api）：站点把分组从
 *   「[GM1]国模分组（DS\qwen3.8\Glm5.3\K3）010」
 * 改名成
 *   「[GM1]Deepseek-v4.1(1017)/Minimax-m3.1」
 * 之后，网关里存着的还是旧名字，于是三件事同时坏掉：
 *   1. 倍率查不到（站点分组表里没这个名字）→ 落价退回「原价 × 1」，贵十倍还不报错；
 *   2. 分组页每个分组都显示「全站 N 个模型」，看不出 GM1 里到底有没有 Deepseek；
 *   3. Key 名下 0 行供给时，「识别分组」只记住分组名不导模型 → GM1 永远是 0 个模型。
 *
 * 这个测试盯的就是这三条底线：
 *   - /api/v1/channels/available 里的「分组 × 模型」不能被丢掉（byGroup）；
 *   - 0 行供给的 Key 在「选分组 / 识别分组」时会把模型导进来；
 *   - 分组名在站点上不存在时，价格一个字都不动（skip），并给出 groupUnknown。
 *
 * 用法：node .test/check-groups-channels.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = await mkdtemp(join(tmpdir(), 'mapi-chgroups-'))
process.env.MANAGE_API_HOME = HOME

const APP_PORT = 4397
const UP_PORT = 5121

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

// ---------------------------------------------------------------- 假上游
//
// 结构照抄真实站点的 /api/v1/channels/available：
//   data[] → { name(渠道), platforms[] → { platform, groups[], supported_models[] } }
// 关键点是一个渠道下的模型由该渠道的**每个**分组都能调（笛卡尔积），
// 不是「模型属于某一个分组」。
const OLD_GM1 = '[GM1]国模分组（DS\\qwen3.8\\Glm5.3\\K3）010'
const NEW_GM1 = '[GM1]Deepseek-v4.1(1017)/Minimax-m3.1'
const GM2 = '[GM2]Kimi-K3.1-pro/GLM'
const IMAGE_GROUP = '[生图专用]GPTimage2.5'

const site = { gm1Name: OLD_GM1, gm1Rate: 0.1 }

const model = (name, { inPrice, outPrice, cacheRead, billing = 'token', perRequest = null }) => ({
  name,
  platform: 'openai',
  pricing: {
    billing_mode: billing,
    input_price: inPrice ?? null,
    output_price: outPrice ?? null,
    cache_write_price: null,
    cache_read_price: cacheRead ?? null,
    image_input_price: null,
    image_output_price: null,
    per_request_price: perRequest,
    intervals: [],
  },
})

const GM1_MODELS = () => [
  model('deepseek-v4-pro', { inPrice: 2e-6, outPrice: 8e-6, cacheRead: 5e-7 }),
  model('deepseek-v4.1-flash', { inPrice: 0.15e-6, outPrice: 0.6e-6, cacheRead: 0.015e-6 }),
  model('minimax-m3.1-flash', { inPrice: 0.1e-6, outPrice: 0.4e-6 }),
]
const GM2_MODELS = () => [
  model('deepseek-v4-pro', { inPrice: 2e-6, outPrice: 8e-6, cacheRead: 5e-7 }),
  model('glm-5.3', { inPrice: 0.6e-6, outPrice: 2.2e-6 }),
  model('kimi-k3.1-pro', { inPrice: 0.5e-6, outPrice: 2e-6 }),
]

function channelsPayload() {
  return {
    data: [
      {
        name: 'GM1-DS/Minimax',
        platforms: [
          {
            platform: 'openai',
            groups: [
              {
                id: 6,
                name: site.gm1Name,
                platform: 'openai',
                rate_multiplier: site.gm1Rate,
                peak_rate_enabled: false,
                peak_rate_multiplier: 1,
                is_exclusive: false,
              },
            ],
            supported_models: GM1_MODELS(),
          },
        ],
      },
      {
        name: 'GM2-Kimi/GLM',
        platforms: [
          {
            platform: 'openai',
            groups: [{ id: 7, name: GM2, platform: 'openai', rate_multiplier: 0.15 }],
            supported_models: GM2_MODELS(),
          },
        ],
      },
      {
        name: '生图',
        platforms: [
          {
            platform: 'openai',
            groups: [{ id: 8, name: IMAGE_GROUP, platform: 'openai', rate_multiplier: 1 }],
            supported_models: [
              model('gpt-image-2.5', { billing: 'image', perRequest: 0.04 }),
            ],
          },
        ],
      },
    ],
  }
}

const TOKENS = () => ({
  data: {
    items: [
      { key: 'gm1-test', name: 'GM1 0.07', group: { name: site.gm1Name, rate_multiplier: site.gm1Rate } },
      { key: 'gm2-test', name: 'GM2 0.07', group: { name: GM2, rate_multiplier: 0.15 } },
    ],
  },
})

const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/api/v1/channels/available') return send(200, channelsPayload())
  if (url.pathname === '/api/v1/keys') return send(200, TOKENS())
  if (url.pathname === '/v1/models') {
    const auth = String(req.headers.authorization || '')
    const ids = auth.includes('gm2-test')
      ? GM2_MODELS().map((m) => m.name)
      : GM1_MODELS().map((m) => m.name)
    return send(200, { data: ids.map((id) => ({ id })) })
  }
  // 余额/公告/系别：本站不提供，保持 unknown
  return send(404, { error: 'not found' })
})
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))

const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  env: { ...process.env, MANAGE_API_HOME: HOME },
  stdio: 'ignore',
})
const base = `http://127.0.0.1:${APP_PORT}`

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`)
  return data
}

async function waitReady() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('服务没起来')
}

try {
  // ------------------------------------------------ 1 纯解析：分组 × 模型
  console.log('[1] 渠道数据的「分组 → 模型」映射')
  const providers = await import('../core/providers.js')
  const inv = await import('../core/inventory.js')
  const store = await import('../core/store.js')

  const siteUrl = `http://127.0.0.1:${UP_PORT}/v1`
  const ch = await providers.fetchAvailableChannels({ baseUrl: siteUrl, adminToken: 'admin-test' })
  ok(ch.groups.length === 3, `读到 3 个分组（实际 ${ch.groups.length}）`)
  const byGroupGm1 = ch.byGroup.filter((m) => m.group === OLD_GM1)
  ok(byGroupGm1.length === 3, `GM1 分组下有 3 个模型（实际 ${byGroupGm1.length}）`)
  ok(
    byGroupGm1.some((m) => m.name === 'deepseek-v4-pro'),
    'GM1 分组里有 deepseek-v4-pro',
  )
  ok(
    byGroupGm1.every((m) => m.rate === 0.1),
    'byGroup 条目带上该分组的倍率',
  )
  const imageEntry = ch.byGroup.find((m) => m.group === IMAGE_GROUP)
  ok(imageEntry?.billingMode === 'image', '生图模型标成按张计费，不混进 token 比价')
  ok(imageEntry?.callPrice === 0.04, `按张单价 = 原价 × 分组倍率（实际 ${imageEntry?.callPrice}）`)

  const pricing = await providers.fetchProviderPricing({ baseUrl: siteUrl, adminToken: 'admin-test' })
  ok(pricing.source === 'channels', `价格来源是渠道（实际 ${pricing.source}）`)
  ok((pricing.byGroup || []).length === 7, `fetchProviderPricing 透传 byGroup（实际 ${(pricing.byGroup || []).length} 条）`)

  await waitReady()

  // ------------------------------------------------ 2 落价：分组名过期不写价
  console.log('[2] applySitePricing：分组名在站点上不存在时不落价')
  const fresh = () => ({
    id: 'o_test',
    upstreamName: 'deepseek-v4-pro',
    modelKey: 'deepseek-v4-pro',
    inPrice: 9,
    outPrice: 9,
    ratio: 3,
    pricingMode: 'manual',
  })
  const sitePrice = { inPrice: 2, outPrice: 8, cacheReadPrice: 0.5 }
  const stale = fresh()
  const viaStale = inv.applySitePricing(stale, {
    exact: null,
    rate: null,
    sitePrice,
    hasBench: true,
    groupKnown: false,
  })
  ok(viaStale === 'skip', `分组名过期 → skip（实际 ${viaStale}）`)
  ok(stale.inPrice === 9 && stale.ratio === 3, '老价格一个字都没动（不会按原价×1 落价）')

  const noRateSite = fresh()
  const viaNoRate = inv.applySitePricing(noRateSite, {
    exact: null,
    rate: null,
    sitePrice,
    hasBench: true,
    groupKnown: true,
  })
  ok(viaNoRate === 'manual' && noRateSite.inPrice === 2, '站点确实没公布倍率 → 仍按原价填（老行为不变）')

  // ------------------------------------------------ 3 端到端：0 行供给的 Key
  console.log('[3] 端到端：Key 名下还没有供给行时，「选分组」直接把模型导进来')
  let state = await call('POST', '/api/providers', { name: '渠道分组验证站', baseUrl: siteUrl })
  const provider = state.providers.find((p) => p.name === '渠道分组验证站')
  await call('PATCH', `/api/providers/${provider.id}`, { adminToken: 'admin-test' })
  state = await call('POST', '/api/credentials', {
    providerId: provider.id,
    label: '默认',
    secret: 'sk-gm1-test',
  })
  const key1 = state.credentials.find((c) => c.providerId === provider.id)
  state = await call('POST', '/api/credentials', {
    providerId: provider.id,
    label: '默认',
    secret: 'sk-gm2-test',
  })
  const key2 = state.credentials.find((c) => c.providerId === provider.id && c.id !== key1.id)
  ok(Boolean(key1 && key2), '两把 Key 都建好了')

  state = await call('POST', `/api/providers/${provider.id}/apply-group`, {
    group: OLD_GM1,
    credentialId: key1.id,
  })
  ok(state.groupResult.resynced === 3, `选分组时补回 3 个模型（实际 ${state.groupResult.resynced}）`)
  ok(state.groupResult.rate === 0.1, `倍率 ×0.1 落到行上（实际 ${state.groupResult.rate}）`)
  ok(state.groupResult.groupUnknown === false, '分组名站点上有，不算过期')

  let offers = (await call('GET', '/api/state')).offers.filter((o) => o.providerId === provider.id)
  ok(offers.length === 3, `GM1 名下 3 条供给（实际 ${offers.length}）`)
  const dsPro = offers.find((o) => o.upstreamName === 'deepseek-v4-pro')
  ok(dsPro.group === OLD_GM1, '供给行挂在这个分组上')
  ok(dsPro.ratio === 0.1 && dsPro.inPrice === 2, `倍率模式：原价 2、倍率 0.1（实际 ${dsPro.inPrice}/${dsPro.ratio}）`)
  ok(dsPro.pricingMode === 'ratio', '落价走倍率模式，不是手填最终价')

  // ------------------------------------------------ 4 分组列表：按分组数模型
  console.log('[4] /groups：每个分组只数自己那几个模型，并给出模型名单')
  let picker = await call('GET', `/api/providers/${provider.id}/groups?credentialId=${key1.id}&fresh=1`)
  const gm1 = picker.groups.find((g) => g.name === OLD_GM1)
  const gm2 = picker.groups.find((g) => g.name === GM2)
  ok(gm1?.modelCount === 3, `GM1 能对上 3 个模型（实际 ${gm1?.modelCount}）`)
  // GM2 名下还没有任何供给行：它只“覆盖”到 deepseek-v4-pro 这一个（跨分组同名的那个）。
  // 这就是这个数字的真实语义：能对上你已录入的多少行，而不是这个分组里有几个模型
  ok(gm2?.modelCount === 1, `GM2 覆盖到 1 个统一模型（实际 ${gm2?.modelCount}）`)
  ok(gm2?.models?.length === 3, `GM2 自己的模型名单是 3 个（实际 ${gm2?.models?.length}）`)
  ok(gm1?.isCurrent === true && picker.currentKnown === true, '当前分组能被站点分组表认出来')
  ok(
    (gm1?.models || []).includes('deepseek-v4-pro'),
    '分组上带模型名单（悬停就能看到 GM1 里有 Deepseek）',
  )

  // ------------------------------------------------ 5 识别分组：改名后收敛，不重复插行
  console.log('[5] 站方改分组名：识别分组把行改名，不重复插一整套')
  // Key 上的分组只有是「后台识别」来的才会被重新识别覆盖（手选的是商务事实，不能被改）
  await call('PATCH', `/api/credentials/${key1.id}`, { group: OLD_GM1, groupSource: 'auto' })
  site.gm1Name = NEW_GM1
  // 价格表有 5 分钟缓存：先把新的分组表读进缓存，模拟「用户打开过选分组 / 缓存过期后」
  await call('GET', `/api/providers/${provider.id}/groups?credentialId=${key1.id}&fresh=1`)
  state = await call('POST', `/api/providers/${provider.id}/detect-groups`, {})
  const detect = state.detectResult
  ok(detect.matched === 2, `两把 Key 都识别到分组（实际 ${detect.matched}）`)
  const res1 = detect.results.find((r) => r.credentialId === key1.id)
  ok(res1?.group === NEW_GM1, `识别到站点的新分组名（实际 ${JSON.stringify(res1?.group)}）`)
  ok(res1?.imported === 0, '已经有行，不重复导入')
  ok(res1?.groupUnknown === false, '新分组名在站点分组表里')

  offers = (await call('GET', '/api/state')).offers.filter((o) => o.providerId === provider.id)
  const key1Offers = offers.filter((o) => o.credentialId === key1.id)
  ok(key1Offers.length === 3, `改名后仍是 3 条，没有变 6 条（实际 ${key1Offers.length}）`)
  ok(
    key1Offers.every((o) => o.group === NEW_GM1),
    '行的分组名跟着站点一起改，比价页不会出现两个 GM1',
  )
  ok(
    key1Offers.every((o) => o.ratio === 0.1),
    '改名后倍率照样对得上（旧名字那套根因就是这里）',
  )
  const key2Offers = offers.filter((o) => o.credentialId === key2.id)
  ok(key2Offers.length === 3, `第二把 Key 由识别分组补了 3 条（实际 ${key2Offers.length}）`)

  // ------------------------------------------------ 6 分组名过期：明确告知
  console.log('[6] 分组名过期：/groups 明确标出，apply-group 不落价')
  await call('PATCH', `/api/credentials/${key1.id}`, { group: OLD_GM1, groupSource: 'manual' })
  picker = await call('GET', `/api/providers/${provider.id}/groups?credentialId=${key1.id}&fresh=1`)
  ok(picker.currentKnown === false, '当前分组名站点上已经没有了 → currentKnown=false')
  ok(picker.current === OLD_GM1, '仍如实返回 Key 上存的名字')

  const before = (await call('GET', '/api/state')).offers.find((o) => o.id === dsPro.id)
  const applied = await call('POST', `/api/providers/${provider.id}/apply-group`, {
    group: OLD_GM1,
    credentialId: key1.id,
  })
  ok(applied.groupResult.groupUnknown === true, '明确回报「分组不在站点列表里」')
  const after = applied.offers.find((o) => o.id === dsPro.id)
  ok(
    after.inPrice === before.inPrice && after.ratio === before.ratio,
    `价格和倍率都没被改掉（${before.inPrice}/${before.ratio} → ${after.inPrice}/${after.ratio}）`,
  )
} catch (error) {
  failed += 1
  console.error('  ✗ 测试异常：', error?.stack || error)
} finally {
  app.kill()
  upstream.close()
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
