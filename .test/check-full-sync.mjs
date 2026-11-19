/**
 * 「完整同步」：登录 / 填令牌之后能拿到的东西，一次拿全。
 *
 * 背景：站点其实会公开不少东西（/api/status 的站名版本、/api/pricing 的分组倍率、
 * 后台令牌列表里的 Key 名单），但我们以前只拿余额和 channels 倍率，
 * 剩下的要么没读、要么读到了丢掉。用户建完站还得自己抄站名、自己补 Key、自己手填倍率。
 *
 * 本测试用一个假 new-api 站验证完整同步的六个阶段：
 *   1. 站点自述（名称/版本/计费单位/客服链接）→ provider.siteName 等
 *   2. /api/pricing 的 group_ratio           → provider.siteGroups
 *   3. 后台令牌列表：对上已有 Key 的分组、补录未导入的 Key
 *   4. 每把 Key 同步模型（各自的分组）
 *   5. 按分组落价（本站没有 channels/广场，倍率只能来自 /api/pricing）
 *   6. 读余额
 *
 * 用法：node .test/check-full-sync.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP_PORT = 4411
const UP_PORT = 5123
const ADMIN_TOKEN = 'admin-token-for-full-sync'

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
const seen = []
const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  seen.push(url.pathname)
  const json = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const admin = req.headers.authorization?.replace(/^Bearer /i, '') || ''

  if (url.pathname === '/api/status') {
    json({
      success: true,
      data: {
        system_name: '测试中转站',
        version: 'v0.9.1',
        quota_per_unit: 500000,
        chat_link: 'https://t.me/testrelay',
        top_up_link: 'https://relay.example/topup',
        display_in_currency: 'USD',
        start_time: 1700000000,
      },
    })
    return
  }
  if (url.pathname === '/api/pricing') {
    json({
      success: true,
      data: {
        group_ratio: { default: 1, vip: 0.8 },
        model_ratio: { 'gpt-4o': 1.25 },
        completion_ratio: 4,
        model_price: {},
      },
    })
    return
  }
  if (url.pathname === '/api/token/' || url.pathname === '/api/token') {
    if (admin !== ADMIN_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{"message":"unauthorized"}')
      return
    }
    json({
      success: true,
      data: [
        { id: 1, name: '我的默认', key: 'exist-abcdef', group: { name: 'vip', rate_multiplier: 0.8 } },
        { id: 2, name: '备用 Key', key: 'new-12345678', group: { name: 'default', rate_multiplier: 1 } },
      ],
    })
    return
  }
  if (url.pathname === '/api/user/self') {
    if (admin !== ADMIN_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{"message":"unauthorized"}')
      return
    }
    json({ success: true, data: { quota: 2500000 } })
    return
  }
  if (url.pathname === '/v1/models') {
    const key = req.headers.authorization?.replace(/^Bearer /i, '') || ''
    if (key === 'sk-exist-abcdef') {
      json({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })
      return
    }
    if (key === 'sk-new-12345678') {
      json({ data: [{ id: 'gpt-4o' }] })
      return
    }
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end('{"error":"bad key"}')
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end('{"error":"not found"}')
})
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))

// ---------------------------------------------------------------- daemon
const HOME = await mkdtemp(join(tmpdir(), 'mapi-full-sync-'))
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
    await sleep(150)
  }

  let state = await call('POST', '/api/providers', {
    name: '完整同步测试站',
    baseUrl: `http://127.0.0.1:${UP_PORT}/v1`,
  })
  const provider = state.providers.find((p) => p.name === '完整同步测试站')
  ok(Boolean(provider), '站点已创建')

  await call('PATCH', `/api/providers/${provider.id}`, { adminToken: ADMIN_TOKEN })
  await call('POST', '/api/credentials', {
    providerId: provider.id,
    secret: 'sk-exist-abcdef',
    label: '我的 Key',
  })

  const result = await call('POST', `/api/providers/${provider.id}/full-sync`, {})
  const report = result.fullSync
  ok(Boolean(report), '接口返回 fullSync 报告')

  // ---- 1. 站点自述
  ok(report.identity?.siteName === '测试中转站', '站点名称落库（/api/status system_name）')
  ok(report.identity?.version === 'v0.9.1', '站点版本落库')
  ok(report.identity?.quotaPerUnit === 500000, '计费单位落库（quota_per_unit）')
  ok(report.identity?.chatLink === 'https://t.me/testrelay', '客服链接落库')
  const view = result.providers.find((p) => p.id === provider.id)
  ok(view.siteName === '测试中转站', 'state 里的站点带 siteName')
  ok(view.siteVersion === 'v0.9.1', 'state 里的站点带 siteVersion')
  ok(view.kind === 'new-api', '系别按 /api/status 纠正为 new-api')

  // ---- 2. 价目表
  ok(report.pricing?.source === 'pricing', '价目表来源记为 /api/pricing')
  ok(report.pricing?.groups === 2, '/api/pricing 读到 2 个分组')
  const groups = view.siteGroups || []
  ok(groups.length === 2, '分组倍率存档到 provider.siteGroups')
  ok(groups.find((g) => g.name === 'vip')?.rate === 0.8, 'vip 分组倍率 0.8 存档')

  // ---- 3. 令牌列表
  ok(report.keys.existing === 1, '同步前只有 1 把 Key')
  ok(report.keys.matched === 1, '已有 Key 在后台列表里对上 1 把')
  ok(report.keys.imported === 1, '后台多出来的 Key 被补录 1 把')
  const imported = (result.credentials || []).find((c) => c.tail === '5678')
  ok(Boolean(imported), '补录的 Key 已落库（尾号 5678）')
  ok(imported?.tokenName === '备用 Key', '补录时带上后台令牌名')
  const existing = (result.credentials || []).find((c) => c.tail === 'cdef')
  ok(existing?.group === 'vip', '已有 Key 的分组被识别为 vip')
  ok(existing?.tokenRate === 0.8, '已有 Key 带上令牌自带倍率')

  // ---- 4. 模型
  ok(report.models.perKey.length === 2, '两把 Key 都拉了模型')
  ok(
    report.models.perKey.find((k) => k.credentialId === existing?.id)?.count === 2,
    '主 Key 拉到 2 个模型',
  )
  ok(report.models.fetched === 3, '模型总数按并集口径记录（2 + 1）')

  // ---- 5. 落价
  ok(report.changes.groups === 2, '两把 Key 都认出了分组')
  const offers = result.offers.filter((o) => o.providerId === provider.id)
  ok(offers.length >= 2, '同步后产生了供给行')
  ok(
    offers.some((o) => o.modelKey === 'gpt-4o' && o.group === 'vip'),
    'gpt-4o 落在 vip 分组下',
  )

  // ---- 6. 余额
  ok(report.balance?.ok === true, '余额读到了')
  ok(report.balance?.remaining === 5, '余额 2500000 quota 折 5 美元')
  ok(report.balance?.via === 'admin-token-quota', '余额来源记为 admin-token-quota')
  ok(view.quotaRemaining === 5, '余额写回站点卡')

  // ---- 收尾
  ok(Boolean(view.lastFullSyncAt), '记录最近一次完整同步时间')
  ok(report.errors.length === 0, `没有报错（实际：${report.errors.join('；') || '无'}）`)

  // 再跑一次：幂等（不会重复导入、不会重复建行）
  const again = await call('POST', `/api/providers/${provider.id}/full-sync`, {})
  ok(again.fullSync.keys.imported === 0, '第二次同步不再重复导入 Key')
  const offers2 = again.offers.filter((o) => o.providerId === provider.id)
  ok(offers2.length === offers.length, '第二次同步不产生重复供给行')
} finally {
  app.kill()
  upstream.close()
}

if (failed > 0) {
  console.error(`${failed} 项失败`)
  process.exit(1)
}
console.log('全部通过')