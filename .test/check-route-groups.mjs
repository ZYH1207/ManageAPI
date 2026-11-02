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
  ok(r.groups[0].algo === 'value', `非法算法回落默认（${r.groups[0].algo}）`)
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
  const withGroup = normalizeRouteGroups({ groups: [{ name: '日常', models: ['a', 'b'], algo: 'price' }], activeId: 'rg_01' })
  ok(activeGroupOf(withGroup)?.name === '日常', '有生效组')
  ok(activeGroupOf({ groups: [], activeId: null }) === null, '没有生效组')

  // 有组：用组的范围和档位
  const t1 = routingTargetOf(withGroup, { scope: ['z'] }, { decisionMode: 'flow' })
  ok(JSON.stringify(t1.scope) === '["a","b"]', '组范围优先于旧 scope')
  ok(t1.decisionMode === 'price', '组算法优先于全局档位')

  // 没组：回到旧行为
  const t2 = routingTargetOf({ groups: [], activeId: null }, { scope: ['z'] }, { decisionMode: 'flow' })
  ok(JSON.stringify(t2.scope) === '["z"]', '无组时用旧 scope')
  ok(t2.decisionMode === null, '无组时不覆盖全局档位')

  // 组存在但没有成员：视为不生效（否则等于全场，用户会以为组坏了）
  const emptyGroup = normalizeRouteGroups({ groups: [{ name: '空', models: [], algo: 'price' }], activeId: 'rg_01' })
  const t3 = routingTargetOf(emptyGroup, { scope: [] }, {})
  ok(t3.group === null, '空成员的组不生效')
}

console.log('[4] 算法档 → 决策档位映射')
{
  for (const a of GROUP_ALGOS) {
    const m = algoOf(a.key)
    ok(m.key === a.key && typeof m.mode === 'string', `${a.key} → ${m.mode}${a.keepEligible ? ' +keep' : ''}`)
  }
  ok(algoOf('price').magpie === 'cheap first', 'price 对应 Magpie cheap first')
  ok(algoOf('flow').magpie === 'fastest', 'flow 对应 Magpie fastest')
  ok(algoOf('value-steady').keepEligible === true, 'value-steady 带 keepEligible')
}

console.log('[5] 新建组 id 不重复')
{
  const g1 = newRouteGroup({ name: 'A' }, [])
  const g2 = newRouteGroup({ name: 'B' }, [g1])
  ok(g1.id !== g2.id, `id 不同（${g1.id} / ${g2.id}）`)
  ok(g1.id.startsWith('rg_'), 'id 有前缀')
}

console.log('')
if (failed) { console.log(`${failed} 项失败`); process.exit(1) }
console.log('全部通过 ✓')
