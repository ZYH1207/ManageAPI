/**
 * 自动路由（一键接管）自检（纯函数，不联网）：
 *   1. 归一化：任意输入补齐成完整形状，enabled 默认关
 *   2. 开启后挑选：跨模型按当前档位标量挑最优，无视站点 / 分组
 *   3. 准入仍然硬门槛：可疑 / 慢速的供给撑不起一个模型
 *   4. 迟滞：新冠军好得不多（<15%）不换，防止反复横跳
 *   5. 现役供给全下线 → 无视迟滞被迫换（reason='unavailable'）
 *   6. 切档（force）→ 立刻按新档位重选（reason='mode-change'）
 *   7. 只看付费池；免费项永远不被接管选中
 *   8. 全场没有能登场的模型 → null（调用方走正常报错）
 *
 * 用法：node .test/check-auto-route.mjs
 */
import {
  normalizeAutoRoute,
  pickAutoRoute,
  applyAutoRoutePick,
  AUTO_ROUTE_SWITCH_GAIN,
} from '../core/auto-route.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

console.log('[1] 归一化：字段缺省补默认，enabled 默认关')
{
  ok(normalizeAutoRoute(undefined).enabled === false, 'undefined → 关')
  ok(normalizeAutoRoute('yes').enabled === false, '字符串 → 关（不把真值当开启）')
  ok(normalizeAutoRoute({ enabled: true }).modelKey === null, '开启但没记录 → modelKey null')
  const full = normalizeAutoRoute({ enabled: 1, modelKey: 'm', offerId: 'o1', pickedAt: 't', reason: 'gain', junk: 1 })
  ok(full.enabled === true && full.modelKey === 'm' && full.offerId === 'o1' && full.junk === undefined, '完整形状 + 丢弃多余字段')
  ok(typeof AUTO_ROUTE_SWITCH_GAIN === 'number' && AUTO_ROUTE_SWITCH_GAIN > 0 && AUTO_ROUTE_SWITCH_GAIN < 1, `迟滞阈值 ${AUTO_ROUTE_SWITCH_GAIN}`)
}

// ------------------------------------------------------------ 挑选链路
const provider = (id, name) => ({ id, name })
const credential = (id, providerId) => ({ id, providerId, group: '', tail: '0000' })
const offer = (id, providerId, modelKey, cny, ttft) => ({
  id,
  providerId,
  credentialId: `c-${providerId}`,
  group: '',
  modelKey,
  upstreamName: modelKey,
  pricingMode: 'manual',
  priceUnit: 'per_mtok',
  currency: 'CNY',
  inPrice: cny,
  outPrice: cny,
})
const score = (patch = {}) => ({
  samples: 5,
  trafficSamples: 0,
  status: 'healthy',
  availability: 1,
  integrity: 1,
  integrityFaults: [],
  quality: 1,
  stale: false,
  blocked: null,
  confidence: 'medium',
  ttftMs: 3000,
  ...patch,
})

/**
 * 两个模型、两个站：
 *   m-a 在甲站 2 元 / 3000ms（便宜但慢）
 *   m-b 在乙站 6 元 / 1000ms（贵但快）
 *   m-c 在丙站 1 元，但可用率 0.5（可疑，准入不过）——任何档位都不该选中它
 */
const db = (patch = {}) => ({
  settings: {
    fx: { base: 'USD', rates: { CNY: 7.2 } },
    fxUsdCny: 7.2,
    maxTtftMs: 0,
    allowUntrusted: false,
    decisionMode: 'value',
    autoRoute: { enabled: true, modelKey: null, offerId: null, pickedAt: null, reason: null },
    ...patch.settings,
  },
  providers: [provider('p1', '甲站'), provider('p2', '乙站'), provider('p3', '丙站')],
  credentials: [credential('c-p1', 'p1'), credential('c-p2', 'p2'), credential('c-p3', 'p3')],
  offers: [
    offer('o-a1', 'p1', 'm-a', 2, 3000),
    offer('o-b1', 'p2', 'm-b', 6, 1000),
    offer('o-c1', 'p3', 'm-c', 1, 500),
  ],
  manualOrder: {},
  ...patch,
})
const scores = {
  'o-a1': score({ quality: 1, ttftMs: 3000 }),
  'o-b1': score({ quality: 1, ttftMs: 1000 }),
  'o-c1': score({ quality: 0.5, availability: 0.5, status: 'unstable', ttftMs: 500 }),
}
const benchmarks = {}

console.log('[2] 挑选：跨模型按档位标量取最优，可疑的模型再便宜也不选')
{
  const pick = pickAutoRoute(db(), { scores, benchmarks })
  ok(pick.modelKey === 'm-a' && pick.reason === 'initial' && pick.switched === true, `无记录 → 首次挑选 m-a（有效成本 2 < 6）：${pick.modelKey}/${pick.reason}`)
  ok(pick.providerName === '甲站', `带站名：${pick.providerName}`)

  const byPrice = pickAutoRoute(db(), { scores, benchmarks, force: true }) // 同上，value 档
  ok(byPrice.modelKey === 'm-a', 'value 档：m-a（有效成本最低）')

  // price 档同样是 m-a（1 元的 m-c 不可用）
  const bySpeed = pickAutoRoute(
    db({ settings: { decisionMode: 'speed' } }),
    { scores, benchmarks, force: true },
  )
  ok(bySpeed.modelKey === 'm-b', `speed 档：m-b（1000ms 快于 3000ms）：${bySpeed.modelKey}`)
  ok(bySpeed.reason === 'initial', `无记录时 force 也是 initial：${bySpeed.reason}`)

  // 价速比：m-a 2/3000=0.67，m-b 6/1000=6 → m-a 胜
  const byPace = pickAutoRoute(
    db({ settings: { decisionMode: 'priceSpeed' } }),
    { scores, benchmarks, force: true },
  )
  ok(byPace.modelKey === 'm-a', `priceSpeed 档：m-a（每 ms 更便宜）：${byPace.modelKey}`)
}

console.log('[3] 迟滞：新冠军好得不多不换，防反复横跳')
{
  // 现役 m-a（value 档有效成本 2）。新造一个 m-d：有效成本 1.85，只比现役好 7.5%
  const d = db({
    offers: [
      offer('o-a1', 'p1', 'm-a', 2, 3000),
      offer('o-d1', 'p2', 'm-d', 1.85, 3000),
    ],
  })
  d.settings.autoRoute = { enabled: true, modelKey: 'm-a', offerId: 'o-a1', pickedAt: 't0', reason: 'gain' }
  const keep = pickAutoRoute(d, { scores: { ...scores, 'o-d1': score({ quality: 1 }) }, benchmarks })
  ok(keep.modelKey === 'm-a' && keep.reason === 'keep' && keep.switched === false, `只好 7.5% (<15%) → 不换：${keep.modelKey}/${keep.reason}`)

  // 好出 15% 以上：m-e 有效成本 1.5，比现役好 25%
  const e = db({
    offers: [
      offer('o-a1', 'p1', 'm-a', 2, 3000),
      offer('o-e1', 'p2', 'm-e', 1.5, 3000),
    ],
  })
  e.settings.autoRoute = { enabled: true, modelKey: 'm-a', offerId: 'o-a1', pickedAt: 't0', reason: 'gain' }
  const gain = pickAutoRoute(e, { scores: { ...scores, 'o-e1': score({ quality: 1 }) }, benchmarks })
  ok(gain.modelKey === 'm-e' && gain.reason === 'gain' && gain.switched === true, `好 25% (≥15%) → 换：${gain.modelKey}/${gain.reason}`)

  // speed 档迟滞按同样比例：现役 m-b 1000ms， challenger 900ms 只好 10% → 不换
  const f = db({
    settings: { decisionMode: 'speed' },
    offers: [
      offer('o-b1', 'p2', 'm-b', 6, 1000),
      offer('o-f1', 'p1', 'm-f', 6, 900),
    ],
  })
  f.settings.autoRoute = { enabled: true, modelKey: 'm-b', offerId: 'o-b1', pickedAt: 't0', reason: 'gain' }
  const keepFast = pickAutoRoute(f, { scores: { ...scores, 'o-f1': score({ ttftMs: 900 }) }, benchmarks })
  ok(keepFast.modelKey === 'm-b' && keepFast.reason === 'keep', `速度快 10% 不值得换：${keepFast.modelKey}`)
}

console.log('[4] 现役下线 → 无视迟滞被迫换；切档 → force 立刻重选')
{
  // 现役 m-a 的供给整条删掉：m-b 接管
  const gone = db({ offers: [offer('o-b1', 'p2', 'm-b', 6, 1000)] })
  gone.settings.autoRoute = { enabled: true, modelKey: 'm-a', offerId: 'o-a1', pickedAt: 't0', reason: 'gain' }
  const forced = pickAutoRoute(gone, { scores, benchmarks })
  ok(forced.modelKey === 'm-b' && forced.reason === 'unavailable' && forced.switched === true, `现役没了 → 被迫换 m-b：${forced.modelKey}/${forced.reason}`)

  // 切档：现役 m-a 仍在，但用户切到 speed 档 → 立刻换 m-b，不受迟滞约束
  const switcher = db({ settings: { decisionMode: 'speed' } })
  switcher.settings.autoRoute = { enabled: true, modelKey: 'm-a', offerId: 'o-a1', pickedAt: 't0', reason: 'gain' }
  const modeChange = pickAutoRoute(switcher, { scores, benchmarks, force: true })
  ok(modeChange.modelKey === 'm-b' && modeChange.reason === 'mode-change' && modeChange.switched === true, `切档 → 立刻按新档位重选：${modeChange.modelKey}/${modeChange.reason}`)

  // 不 force 时同样的布局：m-b 只在速度上好 3 倍 —— 但那不是本档位（value）的口径，
  // value 档下 m-a 仍最优 → keep。验证 force 才会跨档重选
  const noForce = pickAutoRoute(db(), {
    scores,
    benchmarks,
  })
  ok(noForce.modelKey === 'm-a', `value 档下现役 m-a 本来就最优 → keep：${noForce.modelKey}/${noForce.reason}`)
}

console.log('[5] 边界：免费项不进池、无可用模型返回 null、applyAutoRoutePick 落盘形状')
{
  const mixed = db()
  mixed.offers = [
    ...mixed.offers,
    { ...offer('o-free', 'p1', 'm-free', 0, 100), free: true },
  ]
  const freeScores = { ...scores, 'o-free': score({ ttftMs: 100, quality: 1 }) }
  // speed 档下 free 项最快，但它不在付费池里，绝不能被接管选中
  const pick = pickAutoRoute(mixed, { scores: freeScores, benchmarks, force: true })
  ok(pick.modelKey !== 'm-free', `免费项不被接管选中：${pick.modelKey}`)

  const dead = db({ offers: [offer('o-c1', 'p3', 'm-c', 1, 500)] })
  ok(pickAutoRoute(dead, { scores, benchmarks }) === null, '全场只有可疑供给 → null')

  const settings = { autoRoute: { enabled: true } }
  applyAutoRoutePick(settings, { modelKey: 'm-a', offerId: 'o-a1', reason: 'initial' })
  const record = settings.autoRoute
  ok(record.modelKey === 'm-a' && record.offerId === 'o-a1' && record.reason === 'initial', `落盘：${record.modelKey}/${record.reason}`)
  ok(typeof record.pickedAt === 'string' && !Number.isNaN(Date.parse(record.pickedAt)), `pickedAt 是 ISO 时间：${record.pickedAt}`)
  ok(record.enabled === true, '落盘不清 enabled（接管状态由开关字段单独管）')
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
