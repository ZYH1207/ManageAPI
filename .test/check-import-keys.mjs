/**
 * 一键导入站点密钥自检：单元（core 台账）+ 端到端（假上游 + daemon 同步）。
 *
 * 功能：点「一键同步」时先读站点后台的令牌列表，把本地还没有的密钥
 * 自动建为 Key（带各自分组、groupSource:'auto'），再照常拉模型。
 *
 * 钉死的口径：
 *   - 去重与 matchTokenBySecret 一致：两边剥 sk- 前缀比完整 key
 *   - 站点返回的 key 原样存（不擅自补 sk-，否则 Authorization 会发错）
 *   - 重复导入幂等：第二轮 imported=0
 *   - 分组归一化走 normalizeGroup，空名/无名分组落空串
 *
 * 用法：node .test/check-import-keys.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
function ok(cond, message) {
  if (cond) console.log(`  ✓ ${message}`)
  else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

// ---------------------------------------------------------------- 单元层
console.log('[1] importProviderKeys 单元断言（core 台账）')
{
  const home = await mkdtemp(join(tmpdir(), 'mapi-keyimp-'))
  process.env.MANAGE_API_HOME = home
  const inv = await import(pathToFileURL(join(ROOT, 'core/inventory.js')).href)
  const store = await import(pathToFileURL(join(ROOT, 'core/store.js')).href)

  try {
    const provider = await inv.createProvider({ name: '导入站', baseUrl: 'http://127.0.0.1:5136/v1' })
    await inv.createCredential({ providerId: provider.id, label: 'k1', secret: 'sk-abc12345', group: '' })

    const result = await inv.importProviderKeys(provider.id, [
      // 与现有 k1 同一把（剥前缀后相同）→ 跳过
      { name: '令牌A', key: 'abc12345', group: 'vip' },
      // 新的 → 导入，分组名带尾随空格要被归一化
      { name: '令牌B', key: 'def89012', group: 'Vip ' },
      // 名字为空 → 标签落到「站点密钥 + 尾号」；分组是对象形态（Sub2API）
      { name: '', key: 'sk-raw777655', group: { name: '特殊池', rate_multiplier: 2 } },
      // 空 key → 整行过滤，不进任何计数
      { name: '空key', key: '   ', group: '' },
    ])
    ok(result.imported === 2, `导入 2 把（得到 ${result.imported}）`)
    ok(result.skipped === 1, `跳过 1 把重复（得到 ${result.skipped}）`)
    ok(result.total === 3, `总数只数有 key 的 3 行（得到 ${result.total}）`)

    let db = await store.readDb()
    const mine = db.credentials.filter((c) => c.providerId === provider.id)
    ok(mine.length === 3, `台账里共 3 把 Key（得到 ${mine.length}）`)
    const b = mine.find((c) => c.label === '令牌B')
    ok(Boolean(b), '新 Key 用站点令牌名当标签')
    ok(b.group === 'Vip', `分组名归一化保留原名只去空白（得到「${b.group}」）`)
    ok(b.groupSource === 'auto', '分组记 groupSource:auto，不冒充用户手选')
    ok(b.tail === '9012', `尾号取原文后四位（得到 ${b.tail}）`)
    const c = mine.find((c) => c.label === '站点密钥 7655')
    ok(Boolean(c), `无名令牌落到「站点密钥+尾号」（得到 ${c?.label}）`)
    ok(c.group === '特殊池', '对象形态的分组取 name')
    const secret = await inv.revealSecret(c.id)
    ok(secret === 'sk-raw777655', `key 原样存（得到 ${secret.replace(/raw.*/, '***')}）`)

    // 幂等：同一份列表再导一遍，一把都不多
    const again = await inv.importProviderKeys(provider.id, [
      { name: '令牌A', key: 'sk-abc12345', group: 'vip' },
      { name: '令牌B', key: 'def89012', group: 'Vip' },
      { name: '', key: 'raw777655', group: '特殊池' },
    ])
    ok(again.imported === 0 && again.skipped === 3, `重复导入幂等（imported=${again.imported} skipped=${again.skipped}）`)
    db = await store.readDb()
    ok(db.credentials.filter((x) => x.providerId === provider.id).length === 3, '台账仍是 3 把')

    let threw = ''
    try {
      await inv.importProviderKeys('nope', [{ name: 'x', key: 'k' }])
    } catch (error) {
      threw = error.message
    }
    ok(/站点不存在/.test(threw), `站点不存在要报错（${threw || '没报错'}）`)
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}
console.log('')

// ---------------------------------------------------------------- 端到端
console.log('[2] 端到端：点同步 → 站上密钥自动进来并参与拉模型')
const HOME = await mkdtemp(join(tmpdir(), 'mapi-keyimp-e2e-'))
const APP_PORT = 4479
const UP_PORT = 5136

const tokens = {
  data: {
    items: [
      { key: 'tok-alpha', name: '站上令牌一', group: { name: 'vip', rate_multiplier: 2 } },
      { key: 'sk-tok-beta', name: '站上令牌二', group: 'vip' },
    ],
  },
}

const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/api/v1/keys') {
    const auth = String(req.headers.authorization || '')
    if (auth !== 'Bearer admin-token-1') return send(401, { error: 'unauthorized' })
    return send(200, tokens)
  }
  if (url.pathname === '/v1/models') return send(200, { data: [{ id: 'test-model-a' }, { id: 'test-model-b' }] })
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
  if (!res.ok) {
    const error = new Error(`${method} ${path} → ${res.status} ${data.error || ''}`)
    error.status = res.status
    error.data = data
    throw error
  }
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
  const provider = (await call('POST', '/api/providers', { name: '导入站', baseUrl: `${up}/v1` }))
    .providers.find((p) => p.name === '导入站')

  // 站上已有一把手工加过的 Key（与令牌一相同，只是少个前缀）
  await call('POST', '/api/credentials', {
    providerId: provider.id,
    label: 'k1',
    secret: 'tok-alpha',
  })

  // 还没填令牌：导入静默跳过，同步照常
  const plain = await call('POST', `/api/providers/${provider.id}/sync`, {})
  ok(plain.sync?.keyImport?.attempted === false, '没令牌时 attempted:false，不报错')
  ok((plain.offers || []).some((o) => o.providerId === provider.id), '同步照常拉到模型')

  // 填上站点后台令牌再同步：令牌列表里的新密钥自动进来
  await call('PATCH', `/api/providers/${provider.id}`, { adminToken: 'admin-token-1' })

  const first = await call('POST', `/api/providers/${provider.id}/sync`, {})
  const ki = first.sync?.keyImport
  ok(ki?.attempted === true, '同步结果带 keyImport.attempted')
  ok(ki?.imported === 1, `导入 1 把新的（得到 ${ki?.imported}）`)
  ok(ki?.skipped === 1, `跳过 1 把已有的（得到 ${ki?.skipped}）`)

  let mine = first.credentials.filter((c) => c.providerId === provider.id)
  ok(mine.length === 2, `同步后共 2 把 Key（得到 ${mine.length}）`)
  const beta = mine.find((c) => c.label === '站上令牌二')
  ok(Boolean(beta), '新 Key 标签 = 站点令牌名')
  ok(beta?.group === 'vip', `新 Key 带站点分组（得到「${beta?.group}」）`)

  // 新 Key 也参与了本轮模型同步：名下有供给行
  const betaRows = first.offers.filter((o) => o.credentialId === beta.id)
  ok(betaRows.length === 2, `新 Key 名下拉到 2 个模型（得到 ${betaRows.length}）`)

  // 第二轮：不再重复建
  const second = await call('POST', `/api/providers/${provider.id}/sync`, {})
  ok(second.sync?.keyImport?.imported === 0, `第二轮不重复导入（得到 ${second.sync?.keyImport?.imported}）`)
  ok(second.sync?.keyImport?.skipped === 2, `第二轮全部跳过（得到 ${second.sync?.keyImport?.skipped}）`)
} finally {
  app.kill()
  upstream.close()
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
