/**
 * 在役供给过滤（routeableOffers）自检：单元 + 端到端两层。
 *
 * 背景：过滤规则（delistedAt + paused + ignoredModels）此前在
 * daemon/server.js 与 daemon/probe-runner.js 各写一份，探针那份漏了
 * delistedAt，导致已下线模型仍被定时探测、白烧额度。本测试把三条规则
 * 钉死在唯一实现 core/inventory.js#routeableOffers 上：
 *   1. 单元层：内存 db 直接断言三条规则与边界；
 *   2. 端到端：起假上游 + daemon，验证「忽略 / 下线 / 暂停」的供给
 *      既不出现在 /api/state 里，也不会收到探针的真实请求。
 *
 * 用法：node .test/check-routable-offers.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { routeableOffers } = await import(pathToFileURL(join(ROOT, 'core/inventory.js')).href)

let failed = 0
function ok(cond, message) {
  if (cond) {
    console.log(`  ✓ ${message}`)
  } else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

// ---------------------------------------------------------------- 单元层
console.log('[1] routeableOffers 单元断言（内存 db）')
{
  const db = {
    providers: [
      { id: 'p1', paused: false },
      { id: 'p2', paused: true },
    ],
    settings: { ignoredModels: ['model-b'] },
    offers: [
      { id: 'o1', providerId: 'p1', modelKey: 'model-a', upstreamName: 'model-a' },
      { id: 'o2', providerId: 'p1', modelKey: 'model-b', upstreamName: 'model-b' }, // 被忽略
      { id: 'o3', providerId: 'p1', modelKey: 'model-c', upstreamName: 'model-c', delistedAt: '2026-10-01T00:00:00Z' }, // 已下线
      { id: 'o4', providerId: 'p2', modelKey: 'model-a', upstreamName: 'model-a' }, // 站点暂停
      { id: 'o5', providerId: 'p1', modelKey: 'other/model-d', upstreamName: 'other/model-d' }, // 前缀归一化后不在忽略表
    ],
  }
  const visible = routeableOffers(db).map((o) => o.id)
  ok(visible.join(',') === 'o1,o5', `只剩在役供给（得到 ${visible.join(',') || '空'}）`)

  // 手动指定探针目标时也被拦：忽略的模型即使点名也不该被探测
  const ignoredOnly = routeableOffers({ ...db, offers: [db.offers[1]] })
  ok(ignoredOnly.length === 0, '点名忽略模型时返回空')

  // 忽略表匹配走归一化：MODEL-B 与 model-b 是同一个
  const upperIgnored = routeableOffers({
    ...db,
    settings: { ignoredModels: ['MODEL-B'] },
  })
  ok(!upperIgnored.some((o) => o.id === 'o2'), '忽略表按归一化名匹配（大小写不敏感）')

  // 没有 settings / 忽略表为空时不应抛错（老数据兼容）
  const noSettings = routeableOffers({ providers: db.providers, settings: {}, offers: db.offers })
  ok(noSettings.some((o) => o.id === 'o2'), '忽略表为空时不做模型过滤')
}

console.log('[1b] 余额探底（balanceDepleted）：判定本身 + 不在 routeableOffers 里过滤')
{
  const { BALANCE_DEPLETED_BELOW, balanceDepleted } = await import(
    pathToFileURL(join(ROOT, 'core/inventory.js')).href
  )
  ok(BALANCE_DEPLETED_BELOW === 0.01, `探底线是 0.01（得到 ${BALANCE_DEPLETED_BELOW}）`)
  ok(balanceDepleted({ quotaRemaining: 0 }) === true, '余额 0 算探底')
  ok(balanceDepleted({ quotaRemaining: 0.005 }) === true, '余额 0.005 算探底')
  ok(balanceDepleted({ quotaRemaining: 0.01 }) === true, '余额正好 0.01 算探底（≤）')
  ok(balanceDepleted({ quotaRemaining: 0.02 }) === false, '余额 0.02 不算探底')
  ok(balanceDepleted({ quotaRemaining: null }) === false, '余额从未读到（null）不算探底')
  ok(balanceDepleted({}) === false, '没有余额字段不算探底')

  // 探底是「准入离场」不是「数据口删掉」：routeableOffers 不过滤，
  // 供给必须留在比价/决策表里挂红标，由「只显示准入通过」负责隐藏
  const db = {
    providers: [
      { id: 'p1', quotaRemaining: 0.005 },
      { id: 'p2', quotaRemaining: 3.5 },
    ],
    settings: {},
    offers: [
      { id: 'o1', providerId: 'p1', modelKey: 'm-a', upstreamName: 'm-a' },
      { id: 'o2', providerId: 'p1', modelKey: 'm-b', upstreamName: 'm-b' },
      { id: 'o3', providerId: 'p2', modelKey: 'm-a', upstreamName: 'm-a' },
    ],
  }
  const kept = routeableOffers(db).map((o) => o.id)
  ok(kept.join(',') === 'o1,o2,o3', `探底站的供给仍留在在役名单里（得到 ${kept.join(',') || '空'}）`)
}
console.log('')

// ---------------------------------------------------------------- 端到端
console.log('[2] 端到端：忽略 / 下线 / 暂停的供给不被探测、不进 state')
const HOME = await mkdtemp(join(tmpdir(), 'mapi-routable-'))
const APP_PORT = 4396
const UP_PORT = 5112

const probed = [] // 每次 chat 请求记一条 `${pathname} ${model}`
let site1Models = ['model-a', 'model-b', 'model-c']

const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/v1/models') return send(200, { data: site1Models.map((id) => ({ id })) })
  if (url.pathname === '/s2/v1/models') return send(200, { data: [{ id: 'model-d' }] })
  if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      try {
        probed.push(`${url.pathname} ${JSON.parse(raw).model}`)
      } catch {
        probed.push(`${url.pathname} <坏请求体>`)
      }
      // 探针结果不关心内容，快速失败让它走完五项检测的请求序列即可
      send(400, { error: { message: 'mock 不真正对话' } })
    })
    return
  }
  return send(404, { error: 'not found' })
})
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))

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

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) break
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150))
  }

  const up = `http://127.0.0.1:${UP_PORT}`
  // 建站接口返回的是全量 state（各写路由统一约定），站点要从 providers 里找
  const p1 = (await call('POST', '/api/providers', { name: '甲站', baseUrl: `${up}/v1` }))
    .providers.find((p) => p.name === '甲站')
  await call('POST', '/api/credentials', { providerId: p1.id, secret: 'sk-test-1' })
  const sync1 = await call('POST', `/api/providers/${p1.id}/sync`)
  ok(sync1.offers.length === 3, `甲站同步出 3 个模型（得到 ${sync1.offers.length}）`)

  const p2 = (await call('POST', '/api/providers', { name: '乙站', baseUrl: `${up}/s2/v1` }))
    .providers.find((p) => p.name === '乙站')
  await call('POST', '/api/credentials', { providerId: p2.id, secret: 'sk-test-2' })
  await call('POST', `/api/providers/${p2.id}/sync`)

  // 忽略 model-b；甲站下一次同步不再返回 model-b → 它被软下线（delistedAt）
  await call('PATCH', '/api/settings', { ignoredModels: ['model-b'] })
  site1Models = ['model-a', 'model-c']
  const sync2 = await call('POST', `/api/providers/${p1.id}/sync`)
  ok(
    !sync2.offers.some((o) => o.modelKey === 'model-b'),
    'state.offers 不含被忽略的 model-b',
  )
  ok(sync2.sync.pruned >= 1, `model-b 被标记下线（pruned=${sync2.sync.pruned}）`)

  // 模型列表恢复 → 再次同步 → model-b 复活。复活由 syncOffers 当场清 delistedAt
  // （model-b 还在忽略表里，state.offers 看不到它，所以直接读 db 验证）
  site1Models = ['model-a', 'model-b', 'model-c']
  const sync3 = await call('POST', `/api/providers/${p1.id}/sync`)
  const rawDb = JSON.parse(await readFile(join(HOME, 'db.json'), 'utf8'))
  const rowB = rawDb.offers.find((o) => o.providerId === p1.id && o.upstreamName === 'model-b')
  ok(rowB && !rowB.delistedAt, '下线过的 model-b 重新同步后当场复活（delistedAt 已清）')
  ok(
    sync3.sync.perKey.some((k) => k.revived >= 1),
    `复活计数上报（perKey.revived=${sync3.sync.perKey.map((k) => k.revived).join(',')}）`,
  )

  // 恢复「已下线」状态并重新忽略，继续后面的探测断言
  site1Models = ['model-a', 'model-c']
  await call('POST', `/api/providers/${p1.id}/sync`)

  // 暂停乙站：整站不探针
  await call('PATCH', `/api/providers/${p2.id}`, { paused: true })

  probed.length = 0
  const probe = await call('POST', '/api/probes/run', { limit: 10 })
  const models = new Set(probed.map((line) => line.split(' ')[1]))
  const paths = new Set(probed.map((line) => line.split(' ')[0]))
  // probeResults 只带 offerId，映射回 state.offers 里的模型名便于阅读失败输出
  const keyOf = (offerId) => probe.offers.find((o) => o.id === offerId)?.modelKey ?? offerId
  const probedKeys = probe.probeResults.map((r) => keyOf(r.offerId))
  ok(
    !probedKeys.includes('model-b'),
    `探针目标里没有 model-b（结果 ${probedKeys.join(',')}）`,
  )
  ok(!models.has('model-b'), '忽略且已下线的 model-b 没收到任何探测请求')
  ok(!models.has('model-d'), '暂停站点的 model-d 没收到任何探测请求')
  ok(paths.size === 1 && [...paths][0] === '/v1/chat/completions', '探测只打了甲站')
  ok(models.has('model-a') && models.has('model-c'), '在役的 model-a / model-c 被正常探测')

  // ---- 点名清单（offerIds）：照单全收不截断；无差别调用仍然限量 ----
  // 扩到 8 个在役模型（跳过被忽略的 model-b），才能验证「超过默认限量 5 也全探」
  site1Models = ['model-a', 'model-c', 'model-e', 'model-f', 'model-g', 'model-h', 'model-i', 'model-j']
  const syncAll = await call('POST', `/api/providers/${p1.id}/sync`)
  const allIds = syncAll.offers.map((o) => o.id)
  ok(allIds.length === 8, `甲站现在 8 个在役供给（得到 ${allIds.length}）`)

  probed.length = 0
  const picked = await call('POST', '/api/probes/run', { offerIds: allIds })
  ok(
    picked.probeResults.length === 8,
    `点名 8 个 offerIds 全部被探测，不被默认限量砍到 5（探到 ${picked.probeResults.length}）`,
  )
  ok(new Set(probed.map((line) => line.split(' ')[1])).size === 8, '8 个模型各收到真实探测请求')

  probed.length = 0
  const one = await call('POST', '/api/probes/run', { offerIds: [allIds[0]] })
  ok(one.probeResults.length === 1, '点名单个 offerId 只探那一个')

  probed.length = 0
  const capped = await call('POST', '/api/probes/run', { limit: 3 })
  ok(capped.probeResults.length === 3, `无差别调用仍按 limit 截断（探到 ${capped.probeResults.length}）`)

  console.log('')
  if (failed === 0) console.log('全部通过 ✓')
  else {
    console.error(`${failed} 项失败`)
    process.exitCode = 1
  }
} catch (error) {
  console.error('测试出错：', error.message || error)
  process.exitCode = 1
} finally {
  app.kill()
  upstream.close()
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}
