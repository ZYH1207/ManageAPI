/** 验证免费池：闸门命中、按剩余天数排序、跨栏偏好保持顺序，外加配额记账。 */
import { rankFreePool } from '../core/rank-free.js'
import { normalizeQuota, resetIfDue, consumeQuota, remaining, usedRatio, daysLeft } from '../core/quota.js'

const now = Date.now()
const inHalfDay = new Date(now + 0.5 * 86400000).toISOString()

const okScore = (extra = {}) => ({
  samples: 5,
  // 闸门现在也看可用率（与付费侧 isRoutable 同口径），健康样本要给满
  availability: 1,
  blocked: null,
  integrityFaults: [],
  fingerprintRate: 1,
  truncationRate: 1,
  billingRate: 1,
  stale: false,
  ttftMs: 800,
  ...extra,
})

const offer = (id, freeQuota) => ({
  id,
  providerId: 'p_demo',
  upstreamName: `${id}-model`,
  group: '',
  freeQuota,
})

function show(title, rows) {
  console.log(`\n${title}`)
  for (const row of rows) {
    console.log(
      `  ${String(row.offer.id).padEnd(12)} gate=${String(row.gate?.code ?? '—').padEnd(13)} ` +
        `label=${String(row.gate?.label ?? '—').padEnd(8)} daysLeft=${String(row.daysLeft ?? '—').padEnd(5)} ` +
        `priority=${row.priority}`,
    )
  }
}

// 用例 1：额度用尽
show(
  '用例 1 · 额度用尽（20/20）',
  rankFreePool({
    offers: [offer('o_exhausted', { unit: 'request', limit: 20, used: 20, window: 'day', resetAt: inHalfDay })],
    scores: new Map([['o_exhausted', okScore()]]),
    now,
  }),
)

// 用例 2：指纹不达标
show(
  '用例 2 · 指纹 0.5',
  rankFreePool({
    offers: [offer('o_fake')],
    scores: new Map([['o_fake', okScore({ fingerprintRate: 0.5 })]]),
    now,
  }),
)

// 用例 3：一次都没探过
show(
  '用例 3 · 未探测（samples: 0）',
  rankFreePool({
    offers: [offer('o_new')],
    scores: new Map([['o_new', okScore({ samples: 0 })]]),
    now,
  }),
)

// 用例 4：三条都通过闸门，剩余天数 2 / 9 / null
const mixed = [
  offer('o_two', { unit: 'request', limit: 100, used: 20, window: 'day', resetAt: inHalfDay }),
  offer('o_nine', { unit: 'request', limit: 95, used: 5, window: 'day', resetAt: inHalfDay }),
  offer('o_unlimited'),
]
const scores = new Map([
  ['o_two', okScore({ ttftMs: 900 })],
  ['o_nine', okScore({ ttftMs: 1200 })],
  ['o_unlimited', okScore({ ttftMs: 700 })],
])

show(
  '用例 4 · 全部通过，按剩余天数降序（期望 o_nine 9 → o_two 2 → o_unlimited null）',
  rankFreePool({ offers: mixed, scores, crossPane: 'remaining', now }),
)

// 用例 5：relay 偏好保持传入顺序
show(
  '用例 5 · crossPane=relay，保持传入顺序（期望 o_two → o_nine → o_unlimited）',
  rankFreePool({ offers: mixed, scores, crossPane: 'relay', now }),
)

// 附加：配额记账。三种单位各记各的，不互相换算。
const daily = normalizeQuota({ unit: 'request', limit: 20, used: 3, window: 'day' })
const monthly = normalizeQuota({ unit: 'token', limit: 500000, used: 12000, window: 'month' })
const afterReq = consumeQuota(daily, { requests: 2, tokens: 999 })
const afterTok = consumeQuota(monthly, { requests: 1, tokens: 4000 })
const overdue = resetIfDue({ ...daily, used: 19, resetAt: new Date(now - 3 * 86400000).toISOString() }, now)

console.log('\n附加 · 配额记账')
console.log(`  request 单位 +2 次：used ${daily.used} → ${afterReq.used}（token 参数被忽略）`)
console.log(`  token 单位 +4000：used ${monthly.used} → ${afterTok.used}（requests 参数被忽略）`)
console.log(`  过期 3 天后归零：used ${19} → ${overdue.used}，resetAt 推到 ${overdue.resetAt}`)
console.log(`  remaining/usedRatio：${remaining(daily)} / ${usedRatio(daily).toFixed(2)}`)
console.log(`  daysLeft(剩 17，每天 5)：${daysLeft(daily, 5)}；速率未知：${daysLeft(daily, 0)}`)
