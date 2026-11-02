/** 路由组：范围与档位的唯一来源是否正确 */
const { normalizeRouteGroups, activeGroupOf, routingTargetOf, algoOf, newRouteGroup, GROUP_ALGOS, MAX_MODELS_PER_GROUP } =
  await import('../core/route-groups.js')
const { tierMetricOf } = await import('../core/decision-mode.js')

let failed = 0
function ok(cond, label) {
  if (cond) console.log(`  ✓ ${label}`)
  else { console.log(`  ✗ ${label}`); failed += 1 }
}

console.log('[1] 归一化')
{
  const r = normalizeRouteGroups({ groups: [{ name: 'A', models: ['x', 'x', 'y'], algo: 'nonsense' }], activeId: 'rg_01' })
  ok(r.groups.length === 1, '一个组')
  ok(r.groups[0].models.length === 2, `成员去重（${r.groups[0].models.join(',')}）`)
  ok(r.groups[0].algo === 'smart', `非法算法回落默认（${r.groups[0].algo}）`)
  ok(r.activeId === 'rg_01', 'activeId 保留')
  ok(normalizeRouteGroups({ activeId: 'ghost' }).activeId === null, 'activeId 指向不存在的组 → null')
}

console.log('[2] 成员上限')
{
  const many = Array.from({ length: 40 }, (_, i) => `m${i}`)
  const r = normalizeRouteGroups({ groups: [{ models: many }] })
  ok(r.groups[0].models.length === MAX_MODELS_PER_GROUP, `截到 ${MAX_MODELS_PER_GROUP} 个`)
}

console.log('[3] 生效组与回退')
{
  const withGroup = normalizeRouteGroups({ groups: [{ name: '日常', models: ['a', 'b'], algo: 'cheap' }], activeId: 'rg_01' })
  ok(activeGroupOf(withGroup)?.name === '日常', '有生效组')
  ok(activeGroupOf({ groups: [], activeId: null }) === null, '没有生效组')

  // 有组：用组的范围和档位
  const t1 = routingTargetOf(withGroup, { scope: ['z'] }, { decisionMode: 'flow' })
  ok(JSON.stringify(t1.scope) === '["a","b"]', '组范围优先于旧 scope')
  ok(t1.decisionMode === 'price', '组算法优先于全局档位（cheap→price）')

  // 没组：回到旧行为
  const t2 = routingTargetOf({ groups: [], activeId: null }, { scope: ['z'] }, { decisionMode: 'flow' })
  ok(JSON.stringify(t2.scope) === '["z"]', '无组时用旧 scope')
  ok(t2.decisionMode === null, '无组时不覆盖全局档位')

  // 组存在但没有成员：视为不生效（否则等于全场，用户会以为组坏了）
  const emptyGroup = normalizeRouteGroups({ groups: [{ name: '空', models: [], algo: 'price' }], activeId: 'rg_01' })
  const t3 = routingTargetOf(emptyGroup, { scope: [] }, {})
  ok(t3.group === null, '空成员的组不生效')
}

console.log('[4] 算法档 → 决策档位映射（对齐 Magpie 的 11 种）')
{
  for (const a of GROUP_ALGOS) {
    const m = algoOf(a.key)
    ok(m.key === a.key && typeof m.mode === 'string', `${a.key}(${a.label}) → ${m.mode}`)
  }
  // Magpie 原话到这里的映射，逐条钉住
  const MAGPIE_MAP = {
    '智能': 'smart',
    '按顺序': 'order',
    '用完再换': 'failover',
    '轮流': 'rotate',
    '最少使用': 'least-used',
    '重置前用完': 'until-reset',
    '免费优先': 'free',
    '速度优先': 'speed',
    '最便宜': 'cheap',
    '按权重': 'weighted',
    '手动': 'manual',
  }
  for (const [magpie, key] of Object.entries(MAGPIE_MAP)) {
    const hit = GROUP_ALGOS.find((a) => a.magpie === magpie)
    ok(hit?.key === key, `Magpie「${magpie}」→ ${key}`)
  }
}

console.log('[5] 新建组 id 不重复')
{
  const g1 = newRouteGroup({ name: 'A' }, [])
  const g2 = newRouteGroup({ name: 'B' }, [g1])
  ok(g1.id !== g2.id, `id 不同（${g1.id} / ${g2.id}）`)
  ok(g1.id.startsWith('rg_'), 'id 有前缀')
}

console.log('[6] 带行为标记的算法档')
{
  ok(algoOf('order').orderFirst === true, 'order 带 orderFirst（严格按列表顺序）')
  ok(algoOf('failover').stickyMember === true, 'failover 带 stickyMember（用完再换）')
  ok(algoOf('rotate').forceOff === true, 'rotate 带 forceOff（关缓存亲和）')
  ok(algoOf('least-used').balanceFirst === true, 'least-used 带 balanceFirst')
  ok(algoOf('until-reset').balanceFirst === true, 'until-reset 带 balanceFirst')
  ok(algoOf('free').freeFirst === true, 'free 带 freeFirst')
  ok(algoOf('weighted').weighted === true, 'weighted 带 weighted')
  ok(algoOf('manual').manualPick === true, 'manual 带 manualPick')

  const rgRotate = normalizeRouteGroups({ groups: [{ models: ['m1'], algo: 'rotate' }], activeId: 'rg_01' })
  const t = routingTargetOf(rgRotate, {}, {})
  ok(t.forceOff === true, 'rotate 组的 target.forceOff=true')
  ok(t.firstTokenMs === 60_000, '组带默认首字超时 60s')

  const t2 = routingTargetOf({ groups: [], activeId: null }, { scope: [] }, {})
  ok(t2.forceOff === false && t2.balanceFirst === false, '无组时行为开关全 false')
}

console.log('[7] 组级设置项归一化')
{
  const g = newRouteGroup({ name: 'x', models: ['a'], firstTokenMs: '30s', allBusyMs: '2m', contextMode: 'bad', sessionKeep: 'strict' }, [])
  ok(g.firstTokenMs === 30_000, `firstTokenMs 从 key 换成 ms（${g.firstTokenMs}）`)
  ok(g.allBusyMs === 120_000, `allBusyMs 从 key 换成 ms（${g.allBusyMs}）`)
  ok(g.contextMode === 'max', `非法 contextMode 回落（${g.contextMode}）`)
  ok(g.sessionKeep === 'strict', 'sessionKeep 保留合法值')
  ok(g.weights.a === 1, '权重缺省为 1')

  const g2 = normalizeRouteGroups({ groups: [{ models: ['a', 'b'], weights: { a: 3 } }] })
  ok(g2.groups[0].weights.a === 3 && g2.groups[0].weights.b === 1, '权重部分给出时其余补 1')

  const g3 = normalizeRouteGroups({ groups: [{ patterns: [' openrouter/*:free ', '', 'x', 'x'] }] })
  ok(g3.groups[0].patterns.length === 2, `模式去空去重（${g3.groups[0].patterns.join('|')}）`)
}

console.log('[8] 组的设置真的接进 pickAutoRoute 了吗')
{
  // 这个段落的目的是防止「界面能选、选了没反应」——
  // 用户 2026-11-02 明确说过最反感这种。
  const { pickAutoRoute } = await import('../core/auto-route.js')

  const mkOffer = (id, model, price) => ({
    id, providerId: 'p1', modelKey: model, upstreamName: model, group: '',
    inPrice: price, outPrice: price, enabled: true,
  })
  const scores = new Map()
  const baseDb = (routeGroups, autoRouteExtra = {}) => {
    const offers = [mkOffer('o_a', 'model-a', 1), mkOffer('o_b', 'model-b', 10)]
    for (const o of offers) scores.set(o.id, { ttftMs: 1000, availability: 1, integrity: 1, stale: false })
    return {
      providers: [{ id: 'p1', name: '站1' }],
      credentials: [{ id: 'c1', providerId: 'p1', label: 'x', enabled: true }],
      offers,
      settings: {
        decisionMode: 'value',
        autoRoute: {
          enabled: true, modelKey: null, offerId: null, pickedAt: null,
          reason: null, failoverFrom: null, scope: [], affinity: '', conversations: {},
          ...autoRouteExtra,
        },
        routeGroups,
      },
      failover: { reports: [] },
      manualOrder: {},
    }
  }

  // A) 智能（默认）：按价格，model-a 便宜 → 应选 a
  const dbSmart = baseDb({ groups: [{ id: 'rg_01', name: 'g', models: ['model-a', 'model-b'], algo: 'smart', sessionKeep: 'auto', firstTokenMs: 60000, allBusyMs: 0, weights: {} }], activeId: 'rg_01' })
  const pSmart = pickAutoRoute(dbSmart, { scores, benchmarks: {} })
  ok(pSmart?.modelKey === 'model-a', `智能档按价格选便宜的（${pSmart?.modelKey}）`)

  // B) 按顺序：成员顺序反过来（model-b 在前）→ 必须选 b，即使 b 贵 10 倍
  const dbOrder = baseDb({ groups: [{ id: 'rg_01', name: 'g', models: ['model-b', 'model-a'], algo: 'order', sessionKeep: 'auto', firstTokenMs: 60000, allBusyMs: 0, weights: {} }], activeId: 'rg_01' })
  const pOrder = pickAutoRoute(dbOrder, { scores, benchmarks: {} })
  ok(pOrder?.modelKey === 'model-b', `按顺序：尊重成员顺序，不比分（${pOrder?.modelKey}）`)

  // C) 按权重：给贵的那个 100 倍权重 → 它应该胜出
  const dbWeight = baseDb({ groups: [{ id: 'rg_01', name: 'g', models: ['model-a', 'model-b'], algo: 'weighted', sessionKeep: 'auto', firstTokenMs: 60000, allBusyMs: 0, weights: { 'model-b': 100 } }], activeId: 'rg_01' })
  const pWeight = pickAutoRoute(dbWeight, { scores, benchmarks: {} })
  ok(pWeight?.modelKey === 'model-b', `按权重：高权重胜出（${pWeight?.modelKey}）`)

  // D) 对照组：同样的权重但 algo=smart（不用权重）→ 应该还是 a
  const dbNoWeight = baseDb({ groups: [{ id: 'rg_01', name: 'g', models: ['model-a', 'model-b'], algo: 'smart', sessionKeep: 'auto', firstTokenMs: 60000, allBusyMs: 0, weights: { 'model-b': 100 } }], activeId: 'rg_01' })
  const pNoWeight = pickAutoRoute(dbNoWeight, { scores, benchmarks: {} })
  ok(pNoWeight?.modelKey === 'model-a', `智能档不看权重（${pNoWeight?.modelKey}）——证明 C 的差异来自 algo`)

  // E) sessionKeep 透传到亲和：rotate 组强制 off
  const dbRotate = baseDb({ groups: [{ id: 'rg_01', name: 'g', models: ['model-a'], algo: 'rotate', sessionKeep: 'session', firstTokenMs: 60000, allBusyMs: 0, weights: {} }], activeId: 'rg_01' })
  const tRotate = routingTargetOf(dbRotate.settings.routeGroups, dbRotate.settings.autoRoute, dbRotate.settings)
  ok(tRotate.forceOff === true, 'rotate 优先生效（forceOff=true）')
  const dbStrict = baseDb({ groups: [{ id: 'rg_01', name: 'g', models: ['model-a'], algo: 'smart', sessionKeep: 'strict', firstTokenMs: 60000, allBusyMs: 0, weights: {} }], activeId: 'rg_01' })
  const tStrict = routingTargetOf(dbStrict.settings.routeGroups, dbStrict.settings.autoRoute, dbStrict.settings)
  ok(tStrict.group.sessionKeep === 'strict', 'sessionKeep 透传到 target')
  ok(tStrict.firstTokenMs === 60000, 'firstTokenMs 透传到 target')
}

console.log('')
if (failed) { console.log(`${failed} 项失败`); process.exit(1) }
console.log('全部通过 ✓')
