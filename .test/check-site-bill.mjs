/**
 * 站点账单口径自检（纯函数，不联网）：
 *   1. 站点账单按天落盘后，能算出今日/本周/本月
 *   2. 读不到账单的站不计入（不是记 0）
 *   3. 45 天滚动上限
 *
 * 用法：node .test/check-site-bill.mjs
 */
import { applySnapshot, ensureMonitor, buildMonitorView } from '../core/monitor.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

const pad = (n) => String(n).padStart(2, '0')
const dayKey = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() - offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function freshDb() {
  return {
    settings: { fx: { rates: { CNY: 7 } } },
    providers: [{ id: 'pa', name: '甲站', currency: 'USD' }, { id: 'pb', name: '乙站', currency: 'USD' }],
    offers: [],
    credentials: [],
    manualOrder: {},
    monitor: ensureMonitor({}),
  }
}

console.log('[1] 站点账单落盘并汇总')
{
  const db = freshDb()
  applySnapshot(db, {
    providerId: 'pa',
    at: new Date().toISOString(),
    siteSpendDays: {
      [dayKey(0)]: { actualCost: 5.5, totalCost: 110, requests: 700 },
      [dayKey(1)]: { actualCost: 3.2, totalCost: 64, requests: 500 },
      [dayKey(2)]: { actualCost: 2.1, totalCost: 42, requests: 300 },
    },
  })
  const view = buildMonitorView(db, { days: 7 })
  ok(Math.abs(view.siteSpend.today.actual - 5.5) < 1e-9, `今日 ${view.siteSpend.today.actual}`)
  ok(view.siteSpend.week.actual >= 5.5, `本周 ${view.siteSpend.week.actual} ≥ 今日`)
  ok(view.siteSpend.month.actual >= view.siteSpend.week.actual, '本月 ≥ 本周')
  ok(view.siteSpend.today.providers === 1, '只有 1 个站有账单')
  ok(view.siteSpend.byProvider.pa.today === 5.5, '按站拆分正确')
}

console.log('[2] 读不到账单的站不参与汇总')
{
  const db = freshDb()
  applySnapshot(db, {
    providerId: 'pa',
    at: new Date().toISOString(),
    siteSpendDays: { [dayKey(0)]: { actualCost: 1.0, requests: 10 } },
  })
  const view = buildMonitorView(db, { days: 7 })
  ok(view.siteSpend.today.providers === 1, '只有甲站计入')
  ok(!('pb' in view.siteSpend.byProvider), '乙站没有账单 → 不出现在拆分里')
}

console.log('[3] 同一天多次采集覆盖而不是累加')
{
  const db = freshDb()
  const today = dayKey(0)
  applySnapshot(db, { providerId: 'pa', at: new Date().toISOString(), siteSpendDays: { [today]: { actualCost: 1.0 } } })
  applySnapshot(db, { providerId: 'pa', at: new Date().toISOString(), siteSpendDays: { [today]: { actualCost: 4.0 } } })
  const view = buildMonitorView(db, { days: 7 })
  ok(view.siteSpend.today.actual === 4.0, `覆盖而非累加（${view.siteSpend.today.actual}）`)
}

console.log('[4] 超过 45 天的记录被裁掉')
{
  const db = freshDb()
  const days = {}
  for (let i = 0; i < 50; i += 1) days[dayKey(i)] = { actualCost: 0.1 }
  applySnapshot(db, { providerId: 'pa', at: new Date().toISOString(), siteSpendDays: days })
  const stored = Object.keys(db.monitor.siteSpend.pa).length
  ok(stored === 45, `保留 45 天（实际 ${stored}）`)
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}
