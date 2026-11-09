/**
 * 锁定失败后转移自检（纯函数，不联网）：
 *
 *   1. 档位归一化：合法值原样返回，非法 / 空回落「不转移」
 *   2. 「不转移」：链只剩勾选那条 —— 这是默认档，也是用户 2026-11-09 要的行为
 *   3. 没勾选 / 勾选的不在链里：一律不生效，链原样返回（不能影响别人的兜底）
 *   4. 六档范围的边界：同模型 / 同组（同站点+同分组）/ 同站，各自只把范围内的提前，
 *      范围外仍留在链尾兜底 —— 不能因为范围太窄就把整单打死
 *   5. 两个指标：低价用名义单价 priceUsd、真实速度用 realTtftMs；
 *      没真实样本的沉底，不许冒充「最快」
 *   6. 路由组档：按生效组的算法重排；组里配「按顺序」这类档时保持原顺序；
 *      没有生效组时跳过（skipped 说明原因）
 *   7. 勾选那条永远第一：不管传进来的链什么顺序、不管走哪一档
 *
 * 用法：node .test/check-lock-failover.mjs
 */
import {
  LOCK_FAILOVER_MODES,
  DEFAULT_LOCK_FAILOVER,
  applyLockFailover,
  describeLockFailover,
  lockFailoverOf,
  lockFailoverTable,
  normalizeLockFailover,
} from '../core/lock-failover.js'

let failed = 0
function ok(cond, label, detail = '') {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failed += 1
    console.error(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

/** 造一条候选：row 形状对齐 core/router.js#selectCandidates 的产物 */
function row(id, { provider = 'p1', group = 'G1', priceUsd = 1, realTtft = null, ttft = 1000 } = {}) {
  return {
    offer: { id, providerId: provider, group, modelKey: 'm', upstreamName: 'm' },
    provider: { id: provider, name: provider },
    priceUsd,
    price: priceUsd * 7,
    effectiveUsd: priceUsd,
    effective: priceUsd * 7,
    realTtftMs: realTtft,
    ttftMs: ttft,
    quality: 1,
  }
}
const ids = (chain) => chain.map((r) => r.offer.id).join(' > ')

// ---------------------------------------------------------------- 1. 归一化
console.log('[1] 档位归一化')
{
  ok(normalizeLockFailover('none') === 'none', '合法值原样')
  ok(normalizeLockFailover('model-price') === 'model-price', '合法值原样（model-price）')
  ok(normalizeLockFailover('') === DEFAULT_LOCK_FAILOVER, '空 → 默认「不转移」')
  ok(normalizeLockFailover('nonsense') === DEFAULT_LOCK_FAILOVER, '非法 → 默认「不转移」')
  ok(normalizeLockFailover(undefined) === DEFAULT_LOCK_FAILOVER, 'undefined → 默认')
  ok(normalizeLockFailover('  none  ') === 'none', '两端空白被 trim')
  ok(LOCK_FAILOVER_MODES.length === 8, `共八档（实际 ${LOCK_FAILOVER_MODES.length}）`)
  ok(new Set(LOCK_FAILOVER_MODES.map((m) => m.key)).size === 8, '八档 key 互不重复')
  ok(lockFailoverTable().length === 8 && typeof lockFailoverTable()[0].desc === 'string', '下发用的表带 desc')
  ok(lockFailoverOf('bad').key === 'none', '非法输入查表回落默认档')
  ok(describeLockFailover('none').includes('不转移'), '一句话说明含档位名')
}

// ---------------------------------------------------------------- 2. 不转移
console.log('\n[2] 「不转移」：锁定即硬锁')
{
  const chain = [row('a'), row('b'), row('c')]
  const r = applyLockFailover(chain, { mode: 'none', pinnedOfferId: 'b' })
  ok(r.applied === true, '生效')
  ok(ids(r.chain) === 'b', `链只剩勾选那条（实际 ${ids(r.chain)}）`)
  ok(r.pinned?.offer.id === 'b', 'pinned 指向勾选那条')
  ok(chain.length === 3, '不改原数组（纯函数）')
}

// ---------------------------------------------------------------- 3. 不生效的情形
console.log('\n[3] 没勾选 / 勾选的不在链里：一律不生效')
{
  const chain = [row('a'), row('b')]
  const noPin = applyLockFailover(chain, { mode: 'model-price', pinnedOfferId: null })
  ok(noPin.applied === false && noPin.skipped === 'no-pin', '没勾选 → skipped=no-pin')
  ok(ids(noPin.chain) === 'a > b', '链原样（不影响没勾选的请求）')

  const ghost = applyLockFailover(chain, { mode: 'model-price', pinnedOfferId: 'zzz' })
  ok(ghost.applied === false && ghost.skipped === 'pin-not-in-chain', '勾选不在链里 → skipped=pin-not-in-chain')
  ok(ids(ghost.chain) === 'a > b', '链原样')
}

// ---------------------------------------------------------------- 4. 范围
console.log('\n[4] 六档的范围边界')
{
  // a=秋/G1（锁这条） · b=秋/G1 便宜 · c=秋/G2 更便宜 · d=绿萝/G9 最便宜
  const chain = [
    row('a', { provider: 'p1', group: 'G1', priceUsd: 5 }),
    row('b', { provider: 'p1', group: 'G1', priceUsd: 3 }),
    row('c', { provider: 'p1', group: 'G2', priceUsd: 2 }),
    row('d', { provider: 'p2', group: 'G9', priceUsd: 1 }),
  ]

  const model = applyLockFailover(chain, { mode: 'model-price', pinnedOfferId: 'a' })
  ok(ids(model.chain) === 'a > d > c > b', `同模型低价：全场按单价升序（实际 ${ids(model.chain)}）`)
  ok(model.scope === 'model' && model.metric === 'price', 'scope/metric 已回填')

  const group = applyLockFailover(chain, { mode: 'group-price', pinnedOfferId: 'a' })
  ok(ids(group.chain) === 'a > b > c > d', `同组低价：只有同站同分组提前，其余保原序（实际 ${ids(group.chain)}）`)

  const site = applyLockFailover(chain, { mode: 'site-price', pinnedOfferId: 'a' })
  ok(ids(site.chain) === 'a > c > b > d', `同站低价：同站其它分组按单价提前，别站留链尾（实际 ${ids(site.chain)}）`)

  // 同组但不同站点、分组名一样 → 不算同组（用户确认：同站点 + 同分组）
  const twin = [
    row('a', { provider: 'p1', group: 'G1', priceUsd: 9 }),
    row('x', { provider: 'p2', group: 'G1', priceUsd: 1 }),
  ]
  const g2 = applyLockFailover(twin, { mode: 'group-price', pinnedOfferId: 'a' })
  ok(ids(g2.chain) === 'a > x', '同名分组在不同站点 → 不算同组（x 只能在链尾兜底）')

  // 范围里一条都没有时不能把链裁空
  const alone = [row('a', { provider: 'p1', group: 'G1' }), row('z', { provider: 'p9', group: 'G8' })]
  const a2 = applyLockFailover(alone, { mode: 'group-price', pinnedOfferId: 'a' })
  ok(a2.chain.length === 2, `同组没别的供给也不裁空（实际 ${a2.chain.length} 条）`)
}

// ---------------------------------------------------------------- 5. 指标
console.log('\n[5] 两个指标：价格 / 真实速度')
{
  const chain = [
    row('a', { priceUsd: 5, realTtft: 9000 }),
    row('slow', { priceUsd: 1, realTtft: 20000 }),
    row('fast', { priceUsd: 9, realTtft: 1000 }),
    row('unknown', { priceUsd: 0.5, realTtft: null, ttft: 200 }),
  ]

  const byPrice = applyLockFailover(chain, { mode: 'model-price', pinnedOfferId: 'a' })
  ok(ids(byPrice.chain) === 'a > unknown > slow > fast', `低价档按 priceUsd（实际 ${ids(byPrice.chain)}）`)

  const bySpeed = applyLockFailover(chain, { mode: 'model-realSpeed', pinnedOfferId: 'a' })
  ok(ids(bySpeed.chain) === 'a > fast > slow > unknown', `实速档按 realTtftMs，无样本沉底（实际 ${ids(bySpeed.chain)}）`)
  ok(bySpeed.metric === 'realSpeed', 'metric=realSpeed')

  // 没有真实样本的不能靠探针值冒充最快
  const onlyProbe = [
    row('a', { realTtft: 8000 }),
    row('probeOnly', { realTtft: null, ttft: 100 }),
  ]
  const p = applyLockFailover(onlyProbe, { mode: 'model-realSpeed', pinnedOfferId: 'a' })
  ok(ids(p.chain) === 'a > probeOnly', '只有探针样本的沉底，不冒充最快')
}

// ---------------------------------------------------------------- 6. 路由组档
console.log('\n[6] 预设路由组优先')
{
  const chain = [
    row('a', { priceUsd: 5 }),
    row('cheap', { priceUsd: 1 }),
    row('dear', { priceUsd: 9 }),
  ]
  const routeGroups = { groups: [{ id: 'rg_01', name: '省钱', models: ['m'], algo: 'cheap' }], activeId: 'rg_01' }
  const r = applyLockFailover(chain, {
    mode: 'route-group',
    pinnedOfferId: 'a',
    routeGroups,
    settings: { decisionMode: 'value' },
  })
  ok(ids(r.chain) === 'a > cheap > dear', `按组算法「最便宜」重排（实际 ${ids(r.chain)}）`)
  ok(r.scope === 'route-group' && r.metric === 'price', '组算法 cheap → 指标 price')

  // 组里配「按顺序」：用户已经用拖拽表过态，不能再按指标重排
  const orderGroups = { groups: [{ id: 'rg_02', name: '按顺序', models: ['m'], algo: 'order' }], activeId: 'rg_02' }
  const o = applyLockFailover(chain, { mode: 'route-group', pinnedOfferId: 'a', routeGroups: orderGroups })
  ok(o.applied === false && o.skipped === 'route-group-order-first', '按顺序档 → 保持原顺序不重排')
  ok(ids(o.chain) === 'a > cheap > dear', '链保持原样')

  // 没有生效组 → 跳过并说明
  const noGroup = applyLockFailover(chain, { mode: 'route-group', pinnedOfferId: 'a', routeGroups: { groups: [], activeId: null } })
  ok(noGroup.applied === false && noGroup.skipped === 'no-active-route-group', '没有生效组 → skipped=no-active-route-group')
}

// ---------------------------------------------------------------- 7. 勾选永远第一
console.log('\n[7] 勾选那条永远第一')
{
  // 勾选在链中间、在链尾，都要顶到第一
  for (const mode of ['model-price', 'group-price', 'site-price', 'model-realSpeed', 'route-group', 'none']) {
    const chain = [row('x', { priceUsd: 1 }), row('pin', { priceUsd: 9 }), row('y', { priceUsd: 2 })]
    const r = applyLockFailover(chain, { mode, pinnedOfferId: 'pin' })
    ok(r.chain[0]?.offer.id === 'pin', `${mode}：勾选仍在第一位`)
  }
  // 已经排第一时也不重复、不丢
  const chain = [row('pin'), row('b')]
  const r = applyLockFailover(chain, { mode: 'model-price', pinnedOfferId: 'pin' })
  ok(r.chain.length === 2 && ids(r.chain) === 'pin > b', `不重复追加（实际 ${ids(r.chain)}）`)
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
