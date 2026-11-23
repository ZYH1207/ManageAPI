/**
 * 基准价「按原价重建」：把表里已经乘过倍率的条目用站点当前价目表原价重算。
 *
 * 背景：广场给的 inPrice 是「原价 × 分组倍率」，从站导入抄的 offer.inPrice 也是
 * 乘过倍率的实际价。这些数被存进基准价表后，倍率模式再乘一次倍率 → 双重打折，
 * 实测这批条目正好是官方价的 0.08 倍（少算 12.5 倍）。
 *
 * 本测试用一个假站点验证：
 *   1. dry-run 只报 from → to，不写盘
 *   2. apply 后基准价变回原价，来源改成实际读到的站点
 *   3. 倍率行的币种标签跟着基准价对齐
 *   4. 再跑一次 dry-run 应为 0 条（幂等）
 *
 * 用法：node .test/check-bench-rebuild.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP_PORT = 4417
const UP_PORT = 5129
const ADMIN_TOKEN = 'admin-token-for-rebuild'

let failed = 0
function ok(cond, message) {
  if (cond) console.log(`  ✓ ${message}`)
  else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 假上游
const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const json = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/api/status') {
    json({ success: true, data: { system_name: '重建测试站', version: 'v0.9.2', quota_per_unit: 500000 } })
    return
  }
  // 站点价目表原价：9 / 27 每百万 token（元）
  if (url.pathname === '/api/v1/channels/available') {
    json({
      data: [
        {
          name: '默认渠道',
          platforms: [
            {
              platform: 'openai',
              groups: [{ name: 'default', rate_multiplier: 0.15 }],
              supported_models: [
                { name: 'deepseek-v4-pro', pricing: { input_price: 9e-6, output_price: 27e-6 } },
                { name: 'glm-5.3', pricing: { input_price: 8e-6, output_price: 28e-6 } },
              ],
            },
          ],
        },
      ],
    })
    return
  }
  if (url.pathname === '/v1/models') {
    json({ data: [{ id: 'deepseek-v4-pro' }] })
    return
  }
  if (url.pathname === '/api/user/self') {
    json({ success: true, data: { quota: 500000 } })
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end('{"error":"not found"}')
})
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))

// ---------------------------------------------------------------- daemon
const HOME = await mkdtemp(join(tmpdir(), 'mapi-bench-rebuild-'))
const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  cwd: ROOT,
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

const benchPath = join(HOME, 'benchmark.json')
const readBench = async () => JSON.parse(await readFile(benchPath, 'utf8'))

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) break
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }

  let state = await call('POST', '/api/providers', {
    name: '重建测试站',
    baseUrl: `http://127.0.0.1:${UP_PORT}/v1`,
  })
  const provider = state.providers.find((p) => p.name === '重建测试站')
  await call('PATCH', `/api/providers/${provider.id}`, { adminToken: ADMIN_TOKEN })
  await call('POST', '/api/credentials', { providerId: provider.id, secret: 'sk-rebuild-1234', label: '主 Key' })
  state = await call('POST', `/api/providers/${provider.id}/sync`, {})
  const offer = state.offers.find((o) => o.providerId === provider.id && o.modelKey === 'deepseek-v4-pro')
  ok(Boolean(offer), '同步后产生了 deepseek-v4-pro 的供给行')

  // 把这条供给切成倍率模式，币种故意标错成 USD（历史脏数据的形态）
  state = await call('PATCH', `/api/offers/${offer.id}`, {
    pricingMode: 'ratio',
    ratio: 0.15,
    currency: 'USD',
    inPrice: null,
    outPrice: null,
  })
  let row = state.offers.find((o) => o.id === offer.id)
  ok(row.pricingMode === 'ratio' && row.ratio === 0.15, '供给已切到倍率模式（0.15）')

  // 基准价表里塞一条「已经乘过倍率」的条目：9 × 0.08 = 0.72
  await writeFile(
    benchPath,
    JSON.stringify(
      {
        'deepseek-v4-pro': {
          display: 'deepseek-v4-pro',
          in: 0.72,
          out: 2.16,
          offPeakIn: null,
          offPeakOut: null,
          currency: 'CNY',
          source: 'imported:p-old',
          updatedAt: new Date().toISOString(),
        },
        // 老库里广场/渠道来源写的是裸 `channels`（不带站点 id）：这条也必须能被重算
        'glm-5.3': {
          display: 'glm-5.3',
          in: 0.64,
          out: 2.24,
          offPeakIn: null,
          offPeakOut: null,
          currency: 'CNY',
          source: 'channels',
          updatedAt: new Date().toISOString(),
        },
        'manual-model': {
          display: 'manual-model',
          in: 5,
          out: 15,
          currency: 'CNY',
          source: 'manual',
          updatedAt: new Date().toISOString(),
        },
      },
      null,
      2,
    ),
  )

  // ---- 1. dry-run
  const preview = await call('POST', '/api/benchmarks/rebuild', {})
  const plan = preview.benchRebuild
  ok(plan.changedCount === 2, 'dry-run 报 2 条要改（手填来源不动）')
  const proChange = plan.changes.find((c) => c.modelKey === 'deepseek-v4-pro')
  const legacyChange = plan.changes.find((c) => c.modelKey === 'glm-5.3')
  ok(proChange?.modelKey === 'deepseek-v4-pro', '报的是 deepseek-v4-pro')
  ok(proChange?.fromIn === 0.72, 'from 是折后价 0.72')
  ok(proChange?.toIn === 9, 'to 是站点原价 9')
  ok(proChange?.toSource === `channels:${provider.id}`, '来源标成实际读到它的站')
  ok(legacyChange?.fromIn === 0.64 && legacyChange?.toIn === 8, '裸 channels 老来源也被重算（0.64 → 8）')
  ok(plan.applied === false, 'dry-run 不落盘')
  ok((await readBench())['deepseek-v4-pro'].in === 0.72, 'dry-run 后文件里的基准价没变')

  // ---- 2. apply
  const applied = await call('POST', '/api/benchmarks/rebuild', { apply: true })
  const done = applied.benchRebuild
  ok(done.applied === true, 'apply 落盘')
  const table = await readBench()
  ok(table['deepseek-v4-pro'].in === 9, '基准价改成原价 9')
  ok(table['deepseek-v4-pro'].out === 27, '输出价改成原价 27')
  ok(table['glm-5.3'].in === 8 && table['glm-5.3'].out === 28, '裸 channels 条目落盘成原价 8 / 28')
  ok(table['manual-model'].in === 5, '手填来源的基准价不动')

  // ---- 3. 倍率行的币种跟着基准价对齐
  row = applied.offers.find((o) => o.id === offer.id)
  console.log('    debug row:', JSON.stringify({ currency: row?.currency, cs: row?.currencySource, mode: row?.pricingMode }))
  ok(row.currency === 'CNY', '倍率行币种对齐到基准价币种 CNY')
  ok(done.offersRelabeled === 1, '报告里记了 1 条币种对齐')

  // ---- 4. 幂等
  const again = await call('POST', '/api/benchmarks/rebuild', {})
  ok(again.benchRebuild.changedCount === 0, '再跑一次 dry-run 是 0 条（幂等）')

  // ---- 5. 站点没声明「报价币种」时拒绝导入：否则会静默按美元写，
  //         人民币站的价格凭空差一个汇率（6.68 倍），事后还看不出来
  const beforeImport = Object.keys(await readBench()).length
  const rawImport = await fetch(`${base}/api/benchmarks/import-plaza`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: provider.id }),
  })
  const importBody = await rawImport.json().catch(() => ({}))
  ok(rawImport.status === 400, '没声明报价币种时导入被拒绝（400）')
  ok(String(importBody.error || '').includes('报价币种'), '拒绝原因指明要先声明报价币种')
  ok(Object.keys(await readBench()).length === beforeImport, '被拒绝时基准价表没被写')

  // 声明之后同一个站就能导入了
  await call('PATCH', `/api/providers/${provider.id}`, { priceCurrency: 'CNY' })
  const afterDeclare = await call('POST', '/api/benchmarks/import-plaza', { providerId: provider.id })
  ok(Boolean(afterDeclare.plazaBenchResult), '声明币种后导入成功')
  const importedTable = await readBench()
  ok(importedTable['deepseek-v4-pro']?.currency === 'CNY', '导入的基准价币种跟着站点声明（CNY）')

  // ---- 6. 手填新增条目必须选币种（没有站点可继承时，默认美元会差一个汇率）
  const rawAdd = await fetch(`${base}/api/benchmarks`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelKey: 'hand-model', in: 3, out: 6 }),
  })
  const addBody = await rawAdd.json().catch(() => ({}))
  ok(rawAdd.status === 400, '新增基准价不选币种被拒绝（400）')
  ok(String(addBody.error || '').includes('币种'), '拒绝原因说明要选币种')

  await call('PUT', '/api/benchmarks', { modelKey: 'hand-model', in: 3, out: 6, currency: 'CNY' })
  const added = await readBench()
  ok(added['hand-model']?.in === 3 && added['hand-model']?.currency === 'CNY', '选了币种后新增成功')
  ok(added['hand-model']?.source === 'manual', '手填条目来源标成 manual')

  // 改已有条目不该被降级成 manual，也不该因为带了币种而报错
  await call('PUT', '/api/benchmarks', {
    modelKey: 'deepseek-v4-pro',
    in: 9,
    out: 27,
    currency: 'CNY',
    source: `channels:${provider.id}`,
  })
  ok((await readBench())['deepseek-v4-pro'].source === `channels:${provider.id}`, '改已有条目保留原来源')
} finally {
  app.kill()
  await new Promise((r) => upstream.close(r))
  const { rm } = await import('node:fs/promises')
  await rm(HOME, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(failed + ' 项失败')
  process.exit(1)
}
console.log('全部通过')
