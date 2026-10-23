/**
 * 免费页「剩余额度」口径回归。
 *
 * 起因：WorkBuddy 的免费订阅返回
 *   CapacityRemain（包内）= 100、CycleCapacityRemain（本周期）= 0
 * 页面当时报「剩余 100 积分」，而账号实际已经用不出东西了。
 * 这条测试把「显示的量 = 现在能用的量」钉住，顺便验证套餐容量只作补充说明。
 */
import assert from 'node:assert/strict'
import { aggregateQuota, remainingOf, renderFreePlatformPane } from '../web/free-platform.js'

const step = (n, title) => console.log(`\n[${n}] ${title}`)

const t = (text, vars = {}) =>
  String(text).replace(/\{(\w+)\}/g, (_, key) => (key in vars ? String(vars[key]) : `{${key}}`))

step(1, '本周期已用满：显示 0，而不是包内的 100')
const exhausted = { quota: { unit: 'credit', remaining: 100, cycleRemaining: 0, cycleSize: 100 } }
assert.equal(remainingOf(exhausted), 0)
const agg = aggregateQuota([exhausted])
console.log(`   → remaining=${agg.remaining} capacity=${agg.capacity} cycle=${agg.cycleRemaining}/${agg.cycleSize}`)
assert.equal(agg.remaining, 0, '「剩余」必须用本周期剩余')
assert.equal(agg.capacity, 100, '套餐容量单独带出来')
assert.equal(agg.cycleSize, 100)

step(2, '本周期还剩一点：显示本周期剩余')
const partial = { quota: { unit: 'credit', remaining: 2600, cycleRemaining: 2599, cycleSize: 2600 } }
assert.equal(remainingOf(partial), 2599)

step(3, '没有周期字段的平台（手动记账）保持老口径')
assert.equal(remainingOf({ quota: { unit: 'credit', limit: 50, used: 20 } }), 30)
assert.equal(remainingOf({ quota: { unit: 'credit', remaining: 7 } }), 7)
assert.equal(remainingOf({}), 0)

step(4, '卡片文案：剩余 0 积分 + 本周期已用满 + 套餐容量 100')
const html = renderFreePlatformPane({
  platforms: [
    {
      id: 'pf_1',
      label: 'WorkBuddy 国际版',
      connectorId: 'workbuddy',
      enabled: true,
      connected: true,
      accounts: [{ id: 'a1', label: '主账号', hasSecret: true, status: 'ok' }],
    },
  ],
  accounts: [
    {
      id: 'a1',
      platformId: 'pf_1',
      label: '主账号',
      hasSecret: true,
      status: 'ok',
      quota: {
        unit: 'credit',
        remaining: 100,
        cycleRemaining: 0,
        cycleSize: 100,
        resetAt: new Date(Date.now() + 8 * 86400_000).toISOString(),
      },
    },
  ],
  t,
})
const pick = (re) => (html.match(re) || [])[0]
console.log('   →', pick(/剩余 \d+ 积分/), '|', pick(/本周期已用满[^<]*/), '|', pick(/套餐容量 \d+ 积分/))
assert.match(html, /剩余 0 积分/)
assert.match(html, /本周期已用满/)
assert.match(html, /套餐容量 100 积分/)
assert.doesNotMatch(html, /剩余 100 积分/, '不能把包内剩余当成可用余额显示')

console.log('\n全部 4 步通过')
