/**
 * 落价币种自检：同步不能把「用户手选的币种」改掉，默认按美元。
 *
 * 现场的两个病，方向相反：
 *
 *   1. applySitePricing 里 4 处无条件写 offer.currency = 'CNY'。用户手选 USD 的行
 *      同步一轮就被改成人民币——数字不动、标签变了，而 pricing.js 的 offerCost 是
 *      这么算的：resolved.currency === 'CNY' ? 价格 / 汇率 : 价格。
 *
 *   2. 那个 'CNY' 本身就是错的。实测这些中转站报的是美元：绿萝的广场接口报
 *      gpt-4o 2.5/10、gpt-4o-mini 0.15/0.6、gemini-2.5-flash 0.3/2.5，正好是
 *      官方美元价；站点余额也是美元。被标成 CNY 之后比价里便宜 6.68 倍、
 *      花费估算也少算 6.68 倍，页面照常渲染不报错。
 *
 * 所以现在的规则只有两条：
 *   - 用户手选过（currencySource === 'custom'）→ 听用户的，同步不许改；
 *   - 没选过 → 美元（顺带把旧代码错标的 CNY 纠正回来）。
 *
 * 用法：node .test/check-currency.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = await mkdtemp(join(tmpdir(), 'mapi-currency-'))
process.env.MANAGE_API_HOME = HOME

const inv = await import('../core/inventory.js')
const plaza = await import('../core/model-plaza.js')
const providers = await import('../core/providers.js')
const store = await import('../core/store.js')

let pass = 0
let fail = 0
const ok = (cond, msg, extra = '') => {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${msg}`)
  } else {
    fail += 1
    console.error(`  ✗ ${msg}${extra ? `  ${extra}` : ''}`)
  }
}

// 站方报 2/8（美元），倍率 0.5
const site = { inPrice: 2, outPrice: 8 }

try {
  console.log('[1] 币种：用户手选 > 默认美元')

  // 旧代码留下的错标（CNY、用户没动过）→ 同步纠正成美元
  {
    const offer = { modelKey: 'm', inPrice: null, outPrice: null, currency: 'CNY' }
    const via = inv.applySitePricing(offer, { exact: site, rate: 0.5, sitePrice: site, hasBench: true })
    ok(via === 'ratio' && offer.currency === 'USD', `旧的错标 CNY → 纠正成 USD（${offer.currency}）`)
  }

  // 用户手选美元 → 保留
  {
    const offer = { modelKey: 'm', inPrice: null, outPrice: null, currency: 'USD', currencySource: 'custom' }
    inv.applySitePricing(offer, { exact: site, rate: 0.5, sitePrice: site, hasBench: true })
    ok(offer.currency === 'USD', `手选 USD 保持 USD（${offer.currency}）`)
  }

  // 用户手选人民币（真按人民币报价的站）→ 保留，别被默认值盖掉
  {
    const offer = { modelKey: 'm', inPrice: null, outPrice: null, currency: 'CNY', currencySource: 'custom' }
    inv.applySitePricing(offer, { exact: site, rate: 0.5, sitePrice: site, hasBench: true })
    ok(offer.currency === 'CNY', `手选 CNY 保持 CNY（${offer.currency}）`)
  }

  // 连币种字段都没有（老数据）→ 美元
  {
    const offer = { modelKey: 'm', inPrice: null, outPrice: null }
    inv.applySitePricing(offer, { exact: site, rate: 0.5, sitePrice: site, hasBench: true })
    ok(offer.currency === 'USD', `没有币种字段 → 默认 USD（${offer.currency}）`)
  }

  // 按次计费分支
  {
    const perCall = { billingMode: 'per_request', callPrice: 0.02 }
    const keep = { modelKey: 'm', inPrice: null, outPrice: null, currency: 'CNY', currencySource: 'custom' }
    const via = inv.applySitePricing(keep, { exact: perCall, rate: null, sitePrice: perCall, hasBench: true })
    ok(via === 'percall' && keep.currency === 'CNY', `按次：手选 CNY 保持（${keep.currency}）`)
    const plain = { modelKey: 'm', inPrice: null, outPrice: null, currency: 'CNY' }
    inv.applySitePricing(plain, { exact: perCall, rate: null, sitePrice: perCall, hasBench: true })
    ok(plain.currency === 'USD', `按次：没选过 → USD（${plain.currency}）`)
  }

  // 免费分支（站方把模型标成 0 价）
  {
    const zero = { inPrice: 0, outPrice: 0 }
    const keep = { modelKey: 'm', inPrice: null, outPrice: null, currency: 'CNY', currencySource: 'custom' }
    const via = inv.applySitePricing(keep, { exact: zero, rate: 1, sitePrice: zero, hasBench: true })
    ok(via === 'free' && keep.currency === 'CNY', `免费：手选 CNY 保持（${keep.currency}）`)
  }

  // 无倍率、只有站方原价（落绝对价）分支
  {
    const keep = { modelKey: 'm', inPrice: null, outPrice: null, currency: 'CNY', currencySource: 'custom' }
    const via = inv.applySitePricing(keep, { exact: null, rate: null, sitePrice: site, hasBench: true })
    ok(via === 'manual' && keep.currency === 'CNY', `落绝对价：手选 CNY 保持（${keep.currency}）`)
  }

  console.log('[2] 只有「真的改了币种」才记成用户手选')

  const provider = await inv.createProvider({ name: '币种测试站', baseUrl: 'https://cur.test/v1' })
  const cred = await inv.createCredential({ providerId: provider.id, label: 'k', secret: 'sk-cur', group: 'g1' })
  await inv.syncOffers(provider.id, cred.id, ['m1'], 'g1')
  const db0 = await store.readDb()
  const row = db0.offers.find((o) => o.providerId === provider.id)
  ok(Boolean(row), '同步出了供给行')
  ok(row.currency === 'USD' && row.currencySource === undefined, `新建行是美元、不算手选（${row.currency}/${row.currencySource}）`)

  // 值没变不算表态（界面点一下下拉又选回原值不该把这一行冻住）
  await inv.updateOfferPrice(row.id, { currency: row.currency })
  let now = (await store.readDb()).offers.find((o) => o.id === row.id)
  ok(now.currencySource === undefined, `提交相同币种不记 custom（${now.currencySource}）`)

  // CNY 已退出单位体系：写入会被迁移改名成 USD（计费 1:1），但「手选过」仍要记录
  await inv.updateOfferPrice(row.id, { currency: 'CNY' })
  now = (await store.readDb()).offers.find((o) => o.id === row.id)
  ok(now.currency === 'USD' && now.currencySource === 'custom', `改成 CNY 记 custom 且改名 USD（${now.currency}/${now.currencySource}）`)

  // 手选之后再落价，默认值不覆盖它
  const priced = inv.applySitePricing({ ...now, inPrice: null, outPrice: null }, {
    exact: site, rate: 0.5, sitePrice: site, hasBench: true,
  })
  ok(priced === 'ratio' && now.currency === 'USD', `手选后落价不覆盖（${now.currency}）`)

  console.log('[3] 价格源不要假装知道币种')

  const plazaEntry = plaza.flattenPlaza([{
    name: 'g1',
    rate_multiplier: 0.5,
    models: [{ name: 'm1', pricing: { input_price: 2e-6, output_price: 8e-6 } }],
  }]).allEntries[0]
  ok(plazaEntry?.currency === undefined, `广场条目不再写死币种（${plazaEntry?.currency}）`)

  // 用假 fetch 走两条价格来源：结构照旧，但不带 currency 字段
  const plazaPayload = {
    data: {
      groups: [{
        name: 'g1',
        rate_multiplier: 0.5,
        models: [{ name: 'm1', pricing: { input_price: 2e-6, output_price: 8e-6 } }],
      }],
    },
  }
  const channelsPayload = [{
    name: 'ch1',
    platforms: [{
      platform: 'openai',
      groups: [{ name: 'g1', rate_multiplier: 0.5 }],
      supported_models: [{ name: 'm1', pricing: { input_price: 2e-6, output_price: 8e-6 } }],
    }],
  }]
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const target = String(url)
    const body = target.includes('/channels/available') ? channelsPayload : plazaPayload
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }
  try {
    const viaChannels = await providers.fetchProviderPricing({ baseUrl: 'https://cur.test/v1', adminToken: 'admin' })
    ok(viaChannels.source === 'channels', `走渠道价格来源（${viaChannels.source}）`)
    ok(viaChannels.models.every((m) => m.currency === undefined), '渠道 models 不声明币种')
    ok(viaChannels.byGroup.every((m) => m.currency === undefined), '渠道 byGroup 不声明币种')

    const viaPlaza = await providers.fetchProviderPricing({ baseUrl: 'https://cur.test/v1' })
    ok(viaPlaza.source === 'plaza', `走广场价格来源（${viaPlaza.source}）`)
    ok(viaPlaza.models.every((m) => m.currency === undefined), '广场 models 不声明币种')
    ok(viaPlaza.byGroup.every((m) => m.currency === undefined), '广场 byGroup 不声明币种')
  } finally {
    globalThis.fetch = realFetch
  }

  console.log('[4] 界面改币种走 PATCH /api/offers/:id，要能标成手选、也能清掉')

  const { spawn } = await import('node:child_process')
  const { createServer } = await import('node:net')
  // 端口交给系统分配：固定端口会撞上别的会话留下的实例，
  // 而且撞了之后 fetch 会打到别人身上（看到的是别的数据，报错很迷惑）
  const PORT = await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
  // 用 fileURLToPath 而不是 url.pathname：pathname 是百分号编码的，
  // 工作区路径里只要有中文（比如 .wt/协议侦测全量）spawn 就会 ENOENT
  const { fileURLToPath } = await import('node:url')
  const child = spawn(process.execPath, ['daemon/index.js', '--port', String(PORT)], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, MANAGE_API_HOME: HOME },
    stdio: 'ignore',
  })
  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status} ${JSON.stringify(json)}`)
    return json
  }
  try {
    let ready = false
    for (let i = 0; i < 80 && !ready; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/health`)
        ready = res.ok
      } catch {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    ok(ready, '临时实例起来了')

    // 先清掉 [2] 里记下的 custom，回到「跟随默认」
    let st = await call('PATCH', `/api/offers/${row.id}`, { currencySource: 'site' })
    let o = st.offers.find((x) => x.id === row.id)
    ok(o.currencySource === undefined, `清掉手选标记（${o.currencySource}）`)

    // 用户把币种改成 R.Dollar → 记手选（USD 是默认值，改成它不算改过）
    st = await call('PATCH', `/api/offers/${row.id}`, { currency: 'RUSD' })
    o = st.offers.find((x) => x.id === row.id)
    ok(o.currency === 'RUSD' && o.currencySource === 'custom', `改成 RUSD 记 custom（${o.currency}/${o.currencySource}）`)

    // 再点一次下拉、选回同一个值 → 不该算改过
    st = await call('PATCH', `/api/offers/${row.id}`, { currency: 'RUSD' })
    o = st.offers.find((x) => x.id === row.id)
    ok(o.currencySource === 'custom', `同值重复提交保持原状（${o.currencySource}）`)
  } finally {
    child.kill()
  }
} finally {
  await rm(HOME, { recursive: true, force: true })
}

console.log('')
if (fail === 0) console.log(`全部 ${pass} 项通过`)
else {
  console.error(`${fail} 项失败 / 共 ${pass + fail} 项`)
  process.exitCode = 1
}
