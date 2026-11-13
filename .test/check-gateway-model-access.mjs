import {
  gatewayOffersForKey,
  normalizeGatewayModelAccess,
  routeableOffers,
} from '../core/inventory.js'

let failed = 0
const check = (condition, label) => {
  if (condition) console.log(`  ✓ ${label}`)
  else {
    failed += 1
    console.error(`  ✗ ${label}`)
  }
}

const offers = [
  { id: 'a', providerId: 'p1', group: 'g1', modelKey: 'alpha' },
  { id: 'b', providerId: 'p1', group: 'g2', modelKey: 'beta' },
  { id: 'c', providerId: 'p2', group: 'g1', modelKey: 'gamma' },
  { id: 'd', providerId: 'p2', group: 'g1', modelKey: 'ignored' },
]
const aliases = { alpha: 'alpha-model' }
const ids = ['alpha-model', 'beta', 'gamma', 'ignored']
const listIds = (list) => list.map((offer) => offer.id).sort().join(',')

console.log('[1] 默认 Key 延续智能决策的完整模型范围')
check(listIds(gatewayOffersForKey(offers, null, ['beta'], aliases)) === 'a,b,c,d', '默认范围完全保持旧行为')
check(listIds(gatewayOffersForKey(offers, { enabled: true, models: ['beta'] }, ['beta'], aliases)) === 'b', '自选模型只包含智能决策中的模型')

console.log('[2] 站点与分组展开后最终都保存为模型 ID')
check(listIds(gatewayOffersForKey(offers, { enabled: true, providerIds: [], groups: [], models: ['alpha-model'] }, ids, aliases)) === 'a', '模型选择使用身份键匹配别名')
check(listIds(gatewayOffersForKey(offers, { enabled: true, providerIds: ['p1'], groups: [{ providerId: 'p2', name: 'g1' }], models: ['alpha-model'] }, ids, aliases)) === 'a', '只使用最终保存的模型 ID')
check(gatewayOffersForKey(offers, { enabled: true, models: [] }, ids, aliases).length === 0, '启用但未勾选时不开放模型')

console.log('[3] 忽略模型始终不可见')
const live = routeableOffers({
  settings: { ignoredModels: ['ignored'], modelOverrides: {}, modelAliases: aliases },
  providers: [{ id: 'p1', paused: false }, { id: 'p2', paused: false }],
  offers,
})
check(!listIds(gatewayOffersForKey(live, null, ids, aliases)).split(',').includes('d'), '全局忽略先于 Key 范围过滤')

console.log('[4] 配置校验去重并拒绝畸形值')
const normalized = normalizeGatewayModelAccess({ enabled: true, models: ['beta', 'beta'] })
check(normalized.models.length === 1 && !('providerIds' in normalized) && !('groups' in normalized), '只保存去重后的模型身份键')
let rejected = false
try { normalizeGatewayModelAccess({ enabled: true, models: 'beta' }) } catch { rejected = true }
check(rejected, '格式错误会被拒绝')

if (failed) process.exitCode = 1
else console.log('\n全部通过')
