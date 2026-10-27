/**
 * 概览图按站点拆分花费（纯函数，不联网）：
 * spendSeries 的每一天都要带 byProvider，否则「各站花费堆叠柱」画不出来。
 *
 * 用法：node .test/check-spend-by-provider.mjs
 */
import { buildMonitorView } from '../core/monitor.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

const today = new Date()
const pad = (n) => String(n).padStart(2, '0')
const dayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`

const db = {
  settings: { fx: { rates: { CNY: 7 } }, blendInputWeight: 0.25 },
  providers: [
    { id: 'pa', name: '甲站', currency: 'CNY', unitPrice: 1 },
    { id: 'pb', name: '乙站', currency: 'CNY', unitPrice: 1 },
  ],
  offers: [
    { id: 'oa', providerId: 'pa', modelKey: 'm', upstreamName: 'm', pricingMode: 'manual', inPrice: 2, outPrice: 8, priceUnit: 'per_mtok', currency: 'CNY' },
    { id: 'ob', providerId: 'pb', modelKey: 'm', upstreamName: 'm', pricingMode: 'manual', inPrice: 2, outPrice: 8, priceUnit: 'per_mtok', currency: 'CNY' },
  ],
  monitor: { balance: [], rates: [], announcements: [], alerts: [], runs: [], snapshot: {} },
  credentials: [],
  manualOrder: {},
}

const usageData = {
  days: {
    [dayKey]: {
      'k1|pa|m': { requests: 1, errors: 0, input: 1e6, output: 0, cached: 0, cacheCreation: 0, inputIncludesCached: 0, latencySum: 0, latencyCount: 0, ttftSum: 0, ttftCount: 0 },
      'k1|pb|m': { requests: 1, errors: 0, input: 0, output: 1e6, cached: 0, cacheCreation: 0, inputIncludesCached: 0, latencySum: 0, latencyCount: 0, ttftSum: 0, ttftCount: 0 },
    },
  },
}

const view = buildMonitorView(db, { usageData, benchmarks: {}, days: 1 })
const point = view.spendSeries[0]

console.log('[1] spendSeries 带按站点拆分')
{
  ok(Boolean(point.byProvider), 'byProvider 存在')
  ok(point.byProvider.pa === 2, `甲站 ¥2（实际 ${point.byProvider.pa}）`)
  ok(point.byProvider.pb === 8, `乙站 ¥8（实际 ${point.byProvider.pb}）`)
  ok(point.cny === 10, `合计 ¥10（实际 ${point.cny}）`)
  ok(Object.keys(point.byProvider).length === 2, '两站各自独立，不合并')
}

console.log('[2] 没有用量的站不出现在拆分里')
{
  const empty = buildMonitorView(
    { ...db, providers: [...db.providers, { id: 'pc', name: '丙站', currency: 'CNY' }] },
    { usageData, benchmarks: {}, days: 1 },
  ).spendSeries[0]
  ok(!('pc' in (empty.byProvider || {})), '丙站没有用量 → 不进 byProvider')
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}
