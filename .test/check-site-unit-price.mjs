/**
 * 站点充值汇率（站点单价）自检。
 *
 * 现场：格子API（api.geziapi.com）充 ¥7 到账 quota 500000（= 1 额度单位），
 * 站点后台也按 ¥7 显示余额，但网关卡上写 $1.00、还标「低于阈值 $1.50」。
 * 根子：1 个站内额度单位值多少人民币没人填，缺省 1（1:1），而它是 7。
 *
 * 钉死四件事：
 *   1. /api/status 的 price（充值价格 元/美元）能被读出来当站点单价；
 *   2. 登录/同步时自动写进 provider.unitPrice，手填过（manual）绝不覆盖；
 *   3. 余额折人民币 = 站内额度 × 站点单价（¥7=1 单位的站显示 ¥7，不是 $1）；
 *   4. 余额阈值是**真实人民币**，不再被站点单价放大（¥1.5 的阈值不会变成 ¥10.5）。
 *
 * 用法：node .test/check-site-unit-price.mjs
 */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = await mkdtemp(join(tmpdir(), 'mapi-unitprice-'))
process.env.MANAGE_API_HOME = HOME

const { fetchSiteUnitPrice } = await import(pathToFileURL(join(ROOT, 'core/providers.js')).href)
const inv = await import(pathToFileURL(join(ROOT, 'core/inventory.js')).href)
const monitor = await import(pathToFileURL(join(ROOT, 'core/monitor.js')).href)

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

// ---- mock 站点：/api/status 的 price / usd_exchange_rate 可切换
const PORT = 5291
const UP = `http://127.0.0.1:${PORT}`
let statusBody = { price: 7, usd_exchange_rate: 7, quota_per_unit: 500000 }
const up = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/api/status') return send(200, { success: true, data: statusBody })
  if (url.pathname === '/api/pricing') return send(200, { success: true, data: [], group_ratio: {} })
  return send(404, {})
})
await new Promise((r) => up.listen(PORT, '127.0.0.1', r))

try {
  console.log('[1] 从 /api/status 读站点单价')
  {
    statusBody = { price: 7, usd_exchange_rate: 7 }
    ok((await fetchSiteUnitPrice({ baseUrl: `${UP}/v1` })) === 7, '¥7=1 单位的站 → 7')
    statusBody = { price: 1, usd_exchange_rate: 1 }
    ok((await fetchSiteUnitPrice({ baseUrl: `${UP}/v1` })) === 1, '1:1 充值的站 → 1')
    statusBody = { usd_exchange_rate: 6.68 }
    ok((await fetchSiteUnitPrice({ baseUrl: `${UP}/v1` })) === 6.68, '只有 usd_exchange_rate 时用它兜底')
    statusBody = { price: 0, usd_exchange_rate: 0 }
    ok((await fetchSiteUnitPrice({ baseUrl: `${UP}/v1` })) === null, '两个都是 0 → null（不瞎填）')
    statusBody = {}
    ok((await fetchSiteUnitPrice({ baseUrl: `${UP}/v1` })) === null, '都没有 → null')
    ok((await fetchSiteUnitPrice({ baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 500 })) === null, '连不上 → null，不抛错')
  }

  console.log('[2] refreshSiteUnitPrice：登录/同步后写进 provider')
  {
    statusBody = { price: 7, usd_exchange_rate: 7 }
    const created = await inv.createProvider({ name: '格子云', baseUrl: `${UP}/v1` })
    const pid = created.id
    const v = await inv.refreshSiteUnitPrice(pid)
    ok(v === 7, `读到 7（实际 ${v}）`)
    const db1 = await (await import(pathToFileURL(join(ROOT, 'core/store.js')).href)).readDb()
    const saved = db1.providers.find((x) => x.id === pid)
    ok(saved.unitPrice === 7, `unitPrice 写入 7（实际 ${saved.unitPrice}）`)
    ok(saved.unitPriceSource === 'auto', `来源标记 auto（实际 ${saved.unitPriceSource}）`)

    console.log('  · 手填过就不覆盖')
    await inv.updateProvider(pid, { unitPrice: 3 })
    let db2 = await (await import(pathToFileURL(join(ROOT, 'core/store.js')).href)).readDb()
    ok(db2.providers.find((x) => x.id === pid).unitPriceSource === 'manual', '手填 → manual')
    statusBody = { price: 7, usd_exchange_rate: 7 }
    await inv.refreshSiteUnitPrice(pid)
    db2 = await (await import(pathToFileURL(join(ROOT, 'core/store.js')).href)).readDb()
    const after = db2.providers.find((x) => x.id === pid)
    ok(after.unitPrice === 3, `手填的 3 没被站点值覆盖（实际 ${after.unitPrice}）`)
  }

  console.log('[3] 余额折人民币：站内额度 × 站点单价')
  {
    const settings = {}
    ok(monitor.balanceInCny({ quotaRemaining: 1, unitPrice: 7 }, settings) === 7, '站内 1.00 × 7 = ¥7.00')
    ok(monitor.balanceInCny({ quotaRemaining: 1, unitPrice: 1 }, settings) === 1, '1:1 站还是 ¥1.00')
    ok(monitor.balanceInCny({ quotaRemaining: null, unitPrice: 7 }, settings) === null, '没读到余额 → null')
    ok(monitor.balanceInCny({ quotaRemaining: 1, unitPrice: 7 }, { defaultUnitPrice: 2 }) === 7, '站点自己的单价优先于全局默认')
    ok(monitor.balanceInCny({ quotaRemaining: 1 }, { defaultUnitPrice: 2 }) === 2, '没填时用全局默认')
  }

  console.log('[4] 阈值是真实人民币：余额 ¥7 对 ¥1.5 阈值不报警')
  {
    const store = await import(pathToFileURL(join(ROOT, 'core/store.js')).href)
    const mkDb = (unitPrice) => ({
      settings: { balanceWarnUsd: 1.5 },
      providers: [{ id: 'p1', name: '格子云', currency: 'USD', unitPrice, quotaRemaining: 1 }],
      offers: [],
      credentials: [],
      manualOrder: {},
      monitor: monitor.ensureMonitor({}),
    })
    // 余额 ¥7、阈值 ¥1.5 → 不该报
    const dbA = mkDb(7)
    monitor.applySnapshot(dbA, { providerId: 'p1', balance: { ok: true, remaining: 1, currency: 'USD' } })
    ok(!monitor.buildMonitorView(dbA, { days: 1 }).alerts.some((a) => a.code === 'balance_low'), '¥7 > ¥1.5：不报警')

    // 1:1 的站余额 1.00 仍然低于 1.5 → 照旧报（不改变既有站的行为）
    const dbB = mkDb(1)
    monitor.applySnapshot(dbB, { providerId: 'p1', balance: { ok: true, remaining: 1, currency: 'USD' } })
    ok(monitor.buildMonitorView(dbB, { days: 1 }).alerts.some((a) => a.code === 'balance_low'), '1:1 站 1.00 < 1.5：照旧报警')

    // 余额真的见底（站内 0.2 × 7 = ¥1.4 < 1.5）→ 该报
    const dbC = mkDb(7)
    monitor.applySnapshot(dbC, { providerId: 'p1', balance: { ok: true, remaining: 0.2, currency: 'USD' } })
    ok(monitor.buildMonitorView(dbC, { days: 1 }).alerts.some((a) => a.code === 'balance_low'), '¥1.4 < ¥1.5：报警')
    void store
  }
  console.log('[5] 监控页余额行：投影不能把 unitPrice 丢掉')
  {
    const mkDb = (unitPrice) => ({
      settings: { balanceWarnUsd: 1.5 },
      providers: [
        { id: 'p1', name: '格子云', currency: 'USD', unitPrice, quotaRemaining: 1 },
        { id: 'p2', name: '秋', currency: 'USD', unitPrice: 1, quotaRemaining: 4 },
      ],
      offers: [],
      credentials: [],
      manualOrder: {},
      monitor: monitor.ensureMonitor({}),
    })
    const db = mkDb(7)
    monitor.applySnapshot(db, { providerId: 'p1', balance: { ok: true, remaining: 1, currency: 'USD' } })
    monitor.applySnapshot(db, { providerId: 'p2', balance: { ok: true, remaining: 4, currency: 'USD' } })
    const view = monitor.buildMonitorView(db, { days: 1 })
    const rows = view.balanceByProvider
    const gezi = rows.find((r) => r.providerId === 'p1')
    ok(gezi.unitPrice === 7, `行里带出站点单价 7（实际 ${gezi.unitPrice}）`)
    ok(gezi.balanceCny === 7, `balanceCny = 站内 1.00 × 7 = ¥7（实际 ${gezi.balanceCny}）`)
    ok(gezi.balance === 1, 'balance 仍保留站内原始额度（图表用）')
    ok(rows[0].providerId === 'p2', '按真实人民币排序：¥4 的站排在 ¥7 的站前面')
    ok(view.balanceSeries.at(-1).total === 11, `图表合计 = 7 + 4（实际 ${view.balanceSeries.at(-1).total}）`)
    ok(!rows.some((r) => r.balanceCny <= r.threshold), '没有站低于 ¥1.5 阈值（告警条不该出现）')
  }

} finally {
  up.close()
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}
