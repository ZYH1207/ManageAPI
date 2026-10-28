/**
 * 余额口径自检（纯函数，不联网）。
 *
 * 现场：监控页三张站点卡余额 $16.63 / $6.58 / $30.70，阈值 $10.03。
 * 站点后台里其实只有 2.49 / 0.98 / 4.59 —— 全部正好 ×6.6838（市场汇率）。
 *
 * 根子：「比价卡改 1:1 口径」那次只改了**价格**（offerCost / normalizeCurrency），
 * 余额这条链路漏了。余额显示仍按「站内美元 = 真美元」× 汇率折人民币：
 *   - dispAmount(value, currency) → value × rateCny()
 *   - 站点卡 quota = quotaRemaining × rateCny()
 *   - 阈值 warnCny = warnUsd × rateCny()（1.5 → 10.03）
 *   - buildBalanceSeries total 按 currency 判断 × 汇率
 * 1:1 充值的站（充值汇率填 1）余额被凭空放大 6.7 倍，看着像「钱翻了好几番」。
 *
 * 现在只有一条口径：
 *   真实人民币 = 站点额度 × 站点单价（充值汇率；没填则人民币站 1、美元站市场汇率兜底）
 * 余额、阈值、图表合计三处共用 siteUnitPrice（后端）/ siteUnitCny（前端），默认 1。
 *
 * 用法：node .test/check-balance-cny.mjs
 */
import { readFile } from 'node:fs/promises'
import { siteUnitPrice, spendFactorOf, applySnapshot, ensureMonitor, buildMonitorView } from '../core/monitor.js'

let failed = 0
const ok = (cond, msg, extra = '') => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}${extra ? `  ${extra}` : ''}`)
  }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

const FX = 6.683751
const settings = { fx: { rates: { CNY: FX } }, balanceWarnUsd: 1.5 }

console.log('[1] 站点额度 → 真实人民币：只乘充值汇率，默认 1')
{
  ok(siteUnitPrice({ currency: 'USD', unitPrice: 1 }, settings) === 1, '1:1 充值的美元站：1 单位 = ¥1')
  ok(near(siteUnitPrice({ currency: 'USD', unitPrice: 0.83 }, settings), 0.83), '充 ¥100 到账 $120：1 单位 = ¥0.83')
  ok(siteUnitPrice({ currency: 'CNY' }, settings) === 1, '人民币站：1 单位 = ¥1')
  ok(siteUnitPrice({ currency: 'USD' }, settings) === 1, '美元站没填充值汇率：默认 1:1，不乘市场汇率')
  ok(siteUnitPrice({ currency: 'USD', unitPrice: 1 }, settings) !== FX, '1:1 站绝不能乘市场汇率')
  ok(siteUnitPrice({}, settings) === 1, '什么信息都没有时也是 1')
}

console.log('[2] 现场三个站：余额回到后台里的数')
{
  const sites = [
    { name: '秋', quota: 2.48817242, shown: 16.63 },
    { name: '绿萝', quota: 0.98450952, shown: 6.58 },
    { name: '北辰', quota: 4.59251813, shown: 30.7 },
  ]
  for (const s of sites) {
    const cny = s.quota * siteUnitPrice({ currency: 'USD', unitPrice: 1 }, settings)
    ok(near(cny, s.quota), `${s.name}：${cny.toFixed(2)}（旧显示 ${s.shown}，就是 ×${FX.toFixed(2)}）`)
    ok(cny < 5, `${s.name}：这才是「几块钱」的量级`)
  }
}

console.log('[3] 阈值不跟着放大')
{
  const thresholdCny = 1.5 * siteUnitPrice({ currency: 'USD', unitPrice: 1 }, settings)
  ok(near(thresholdCny, 1.5), `阈值 1.5 → ¥1.50（旧显示 ¥${(1.5 * FX).toFixed(2)}）`)
  ok(2.48817242 * 1 > thresholdCny, '秋 2.49 > 1.5：正常，不该报警')
  ok(0.98450952 * 1 < thresholdCny, '绿萝 0.98 < 1.5：该充值，报警是对的')
}

console.log('[4] 图表合计：各站按自己的单价折，不一律乘汇率')
{
  const db = {
    settings,
    providers: [
      { id: 'pa', name: '秋', currency: 'USD', unitPrice: 1 },
      { id: 'pb', name: '北辰', currency: 'USD', unitPrice: 1 },
      { id: 'pc', name: '海外真美元站', currency: 'USD' },
    ],
    offers: [],
    credentials: [],
    manualOrder: {},
    monitor: ensureMonitor({}),
  }
  const at = new Date().toISOString()
  applySnapshot(db, { providerId: 'pa', at, balance: { ok: true, remaining: 2.48817242, currency: 'USD' } })
  applySnapshot(db, { providerId: 'pb', at, balance: { ok: true, remaining: 4.59251813, currency: 'USD' } })
  applySnapshot(db, { providerId: 'pc', at, balance: { ok: true, remaining: 1, currency: 'USD' } })
  const view = buildMonitorView(db, { days: 1 })
  const total = view.balanceSeries.at(-1)?.total
  const expect = 2.48817242 + 4.59251813 + 1
  ok(near(total, Math.round(expect * 100) / 100, 0.011), `合计 ${total}（= 2.49 + 4.59 + 1，没乘汇率）`)
  ok(total < 9, `1:1 的三个站都没被乘汇率（总额 ${total}；真乘的话是 ${((2.48817242 + 4.59251813 + 1) * FX).toFixed(2)}）`)
  // perProvider 必须是原生额度，前端自己乘单价——后端乘过一遍就会重复放大
  ok(near(view.balanceSeries.at(-1).perProvider.pa, 2.48817242), 'perProvider 存原生额度，不折')
}

console.log('[5] 阈值告警仍按站点原生额度比较（不因显示改动漂移）')
{
  const db = {
    settings,
    providers: [
      { id: 'pa', name: '秋', currency: 'USD', unitPrice: 1 },
      { id: 'pb', name: '绿萝', currency: 'USD', unitPrice: 1 },
    ],
    offers: [],
    credentials: [],
    manualOrder: {},
    monitor: ensureMonitor({}),
  }
  const at = new Date().toISOString()
  applySnapshot(db, { providerId: 'pa', at, balance: { ok: true, remaining: 2.48817242, currency: 'USD' } })
  applySnapshot(db, { providerId: 'pb', at, balance: { ok: true, remaining: 0.98450952, currency: 'USD' } })
  const view = buildMonitorView(db, { days: 1 })
  const codes = view.alerts.filter((a) => a.code === 'balance_low').map((a) => a.providerId)
  ok(codes.includes('pb'), '绿萝 0.98 < 1.5 报警')
  ok(!codes.includes('pa'), '秋 2.49 > 1.5 不报警')
}

console.log('[6] 损失侧：实际消费 = 模型消费 × 站点单价（不再 ÷ 市场汇率）')
{
  ok(spendFactorOf({ unitPrice: 1 }, settings) === 1, '1:1 充值：实际消费 = 模型消费（以前被算成 1/6.68）')
  ok(spendFactorOf({}, settings) === 1, '未填单价：也是 1（默认 1:1）')
  ok(near(spendFactorOf({ unitPrice: FX }, settings), FX), `真美元站（填 ${FX.toFixed(2)}）：站内 $1 值 ¥${FX.toFixed(2)}`)
  // 具体一笔：站内 $3/Mtok 用了 1M 输入，钱包应该少 ¥3，不是 ¥0.45
  const estimated = 3
  ok(near(estimated * spendFactorOf({ unitPrice: 1 }, settings), 3), '站内 $3 的调用 = 掉 ¥3')
  ok(near(estimated / FX, 0.45, 0.01), `旧算法（÷汇率）会算成 ¥${(estimated / FX).toFixed(2)}，正是少算 ${FX.toFixed(2)} 倍`)
}

console.log('[7] 前端源码守卫：余额链路不许再乘市场汇率')
{
  const src = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
  const banned = [
    ['quotaRemaining * rateCny()', '站点卡余额'],
    ['warnUsd * fxRate', '阈值'],
    ['raw * rateCny()', '图表单站余额'],
    ['raw * fx', '图表单站余额（旧签名）'],
    ['dispAmount(value, currency)', 'dispAmount 收币种而不是站点'],
  ]
  for (const [pattern, what] of banned) {
    ok(!src.includes(pattern), `${what}：源码里没有「${pattern}」`)
  }
  ok(src.includes('function siteUnitCny('), '有统一的 siteUnitCny 换算口')
  ok(/function dispAmount\(value, p\)/.test(src), 'dispAmount 按站点单价折，不再按币种折')
  ok(!/warnUsd \* rateCny\(\)/.test(src), '阈值没再按币种乘汇率')
  ok(src.length > 100000, `app.js 读全了（${src.length} 字节）`)
}

console.log('')
if (failed) {
  console.error(`${failed} 项不通过`)
  process.exit(1)
}
console.log('全部通过')
