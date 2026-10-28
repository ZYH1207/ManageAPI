/**
 * 余额探底离场自检：判定 → 准入 → 排序 → 免费池闸门 → 恢复。
 *
 * 背景：站点卡读到余额 ≤ 0.01（站内额度单位）时，整站供给要「离场」——
 * 但待遇与「慢速」同款：留在候选表里挂红标、准入拒之门外、排序沉底，
 * 由「只显示准入通过」负责隐藏；而不是从数据口删掉（那样比价/决策页就
 * 看不见它为什么没了）。充值并刷新余额后自动回场。
 *
 * 钉死的口径（唯一实现在 core/router.js#admissionOf + core/rank-free.js#gateOf）：
 *   1. admission kind='depleted'，tags 含 'depleted'（前端红「余额不足」徽章）；
 *   2. routable=false（排序沉底），candidateChain 不收、绝境兜底也不收；
 *   3. 免费池 gate code='depleted'（免费模型虽不耗余额，与付费侧同一条线）；
 *   4. 余额从未读到（null）不算探底，准入照常放行；
 *   5. 余额回上后 admission 立即恢复，没有要清理的状态。
 *
 * 用法：node .test/check-balance-depleted.mjs
 */
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { selectCandidates, candidateChain, explain } = await import(
  pathToFileURL(join(ROOT, 'core/router.js')).href
)
const { rankFreePool } = await import(pathToFileURL(join(ROOT, 'core/rank-free.js')).href)

let failed = 0
function ok(cond, message) {
  if (cond) {
    console.log(`  ✓ ${message}`)
  } else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

function fixtureDb(quotaOfP1) {
  return {
    providers: [
      { id: 'p1', name: '探底站', quotaRemaining: quotaOfP1 },
      { id: 'p2', name: '正常站', quotaRemaining: 5 },
    ],
    credentials: [
      { id: 'c1', providerId: 'p1' },
      { id: 'c2', providerId: 'p2' },
    ],
    offers: [
      { id: 'o1', providerId: 'p1', modelKey: 'm', upstreamName: 'm', group: '' },
      { id: 'o2', providerId: 'p2', modelKey: 'm', upstreamName: 'm', group: '' },
    ],
  }
}

/** 健康评分：没有它所有供给都是 routable=false（无证据不优先），看不出沉底效果 */
function healthyScores() {
  const base = {
    samples: 5,
    trafficSamples: 0,
    availability: 1,
    integrity: 1,
    integrityFaults: [],
    status: 'healthy',
    ttftMs: 1000,
    stale: false,
    blocked: null,
    pendingRecovery: null,
    billingOnly: false,
    quality: 1,
  }
  return new Map([
    ['o1', { ...base, offerId: 'o1' }],
    ['o2', { ...base, offerId: 'o2' }],
  ])
}

function selectRows(db) {
  return selectCandidates({
    offers: db.offers,
    providers: db.providers,
    credentials: db.credentials,
    scores: healthyScores(),
    benchmarks: {},
    settings: {},
    model: 'm',
  })
}

console.log('[1] 准入：探底站的供给 kind=depleted，挂红标，沉底')
{
  const rows = selectRows(fixtureDb(0.005))
  const depleted = rows.find((r) => r.offer.id === 'o1')
  const healthy = rows.find((r) => r.offer.id === 'o2')
  ok(depleted.admission?.ok === false, '探底供给准入拒绝')
  ok(depleted.admission?.kind === 'depleted', `kind 是 depleted（得到 ${depleted.admission?.kind}）`)
  ok(depleted.balanceDepleted === true, '行上带 balanceDepleted 标记')
  ok(depleted.routable === false, 'routable=false：排序沉底')
  ok(healthy.admission?.ok === true, '正常站供给准入照常')

  const tags = admissionTagsOf(explain(rows))
  ok(tags.o1.includes('depleted'), `explain 标签含 depleted（得到 ${tags.o1.join('|')}）`)
  ok(!tags.o2.includes('depleted'), '正常站不挂 depleted 标签')

  const order = rows.map((r) => r.offer.id)
  ok(order.join(',') === 'o2,o1', `沉底在正常供给之后（得到 ${order.join(',')}）`)

  const chain = candidateChain(
    rows.map((r) => ({ ...r, admission: r.admission, offer: r.offer })),
  )
  ok(chain.admitted.every((c) => c.offer.id !== 'o1'), '候选链不收探底供给')
  ok(chain.lastResort.every((c) => c.offer.id !== 'o1'), '绝境兜底也不收探底供给')
}
console.log('')

console.log('[2] 边界：余额 null 不是探底；充值后自动回场')
{
  const rowsNull = selectRows(fixtureDb(null))
  const row = rowsNull.find((r) => r.offer.id === 'o1')
  ok(row.admission?.ok !== false || row.admission?.kind !== 'depleted', '余额 null 不按探底拒')

  const rowsBack = selectRows(fixtureDb(9.98))
  const back = rowsBack.find((r) => r.offer.id === 'o1')
  ok(back.admission?.ok === true, '余额回上后准入立即恢复（无需清状态）')
  ok(back.routable === true, '恢复后 routable 也回来')
}
console.log('')

console.log('[3] 免费池：探底站的免费模型同样挂 gate 离场')
{
  const freeOffers = [
    { id: 'f1', providerId: 'p1', modelKey: 'fm', upstreamName: 'fm', freeQuota: null },
    { id: 'f2', providerId: 'p2', modelKey: 'fm', upstreamName: 'fm', freeQuota: null },
  ]
  const gated = rankFreePool({
    offers: freeOffers,
    scores: null,
    depletedProviderIds: new Set(['p1']),
  })
  const g1 = gated.find((r) => r.offer.id === 'f1')?.gate
  const g2 = gated.find((r) => r.offer.id === 'f2')?.gate
  ok(g1?.code === 'depleted' && g1?.label === '余额不足', `探底站免费模型挂「余额不足」闸门（得到 ${g1?.code}/${g1?.label}）`)
  ok(g2?.code !== 'depleted', '正常站免费模型不挂探底闸门')

  const notGated = rankFreePool({ offers: freeOffers, scores: null })
  ok(notGated.find((r) => r.offer.id === 'f1')?.gate?.code !== 'depleted', '不传探底集合时维持原判定')
}
console.log('')

function admissionTagsOf(explained) {
  const map = {}
  for (const row of explained) map[row.offerId] = row.tags || []
  return map
}

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('全部通过 ✓')
