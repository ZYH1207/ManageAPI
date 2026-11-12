/**
 * 缓存价来源回填自检。
 *
 * 这个模块的价值全在「区分三种没有缓存价」——如果它把「站点没公布」
 * 判成「无接口」或者反过来，界面上就会把不知道的事说成确定的事。
 * 所以四种判定逐一定死。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const m = await import(join(here, '..', 'core', 'cache-price-backfill.js'))

let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  ✓ ' + l) } else { fail++; console.log('  ✗ ' + l) } }

const P_RICH = { id: 'p1', name: '绿萝', kind: 'new-api' }
const P_DRY = { id: 'p2', name: 'rapid', kind: 'sub2api' }

console.log('[A] 四种来源判定')
{
  // 有价格表 + 有缓存价 → site-reported
  ok(m.inferCacheReadSource({ cacheReadPrice: 0.02, inPrice: 2 }, P_RICH) === 'site-reported',
    '站点报了非 0 缓存价 → site-reported')
  // 有价格表 + 缓存价 0 → explicit-zero（真免费，比价按 0 算）
  ok(m.inferCacheReadSource({ cacheReadPrice: 0, inPrice: 2 }, P_RICH) === 'explicit-zero',
    '站点明确报 0 → explicit-zero')
  // 有价格表 + 没缓存价 → site-silent（接口通了但没这字段）
  ok(m.inferCacheReadSource({ cacheReadPrice: null, inPrice: 2 }, P_RICH) === 'site-silent',
    '有价格表但无缓存价 → site-silent')
  // 没有价格接口 → no-source
  ok(m.inferCacheReadSource({ cacheReadPrice: null, inPrice: null }, P_DRY) === 'no-source',
    '站点无价格接口 → no-source')
}

console.log('\n[B] 已有标记优先（新数据不被覆盖）')
{
  ok(m.inferCacheReadSource({ cacheReadSource: 'explicit-zero', cacheReadPrice: 0.5, inPrice: 2 }, P_RICH) === 'explicit-zero',
    '已有 explicit-zero 不被重算成 site-reported')
}

console.log('\n[C] 批量回填')
{
  const offers = [
    { id: 'o1', providerId: 'p1', cacheReadPrice: 0.02, inPrice: 2 },
    { id: 'o2', providerId: 'p1', cacheReadPrice: 0, inPrice: 2 },
    { id: 'o3', providerId: 'p1', cacheReadPrice: null, inPrice: 2 },
    { id: 'o4', providerId: 'p2', cacheReadPrice: null, inPrice: null },
    { id: 'o5', providerId: 'p1', cacheReadSource: 'site-reported', cacheReadPrice: 0.1, inPrice: 2 },
  ]
  const st = m.backfillCacheReadSource(offers, [P_RICH, P_DRY])
  ok(st.total === 5, '统计总数为 5')
  ok(st.patched === 4, '只给缺标记的 4 条打标（o5 已有标记）')
  ok(offers[0].cacheReadSource === 'site-reported', 'o1 → site-reported')
  ok(offers[1].cacheReadSource === 'explicit-zero', 'o2 → explicit-zero')
  ok(offers[2].cacheReadSource === 'site-silent', 'o3 → site-silent')
  ok(offers[3].cacheReadSource === 'no-source', 'o4 → no-source')
  ok(st.bySource['site-reported'] === 2, '汇总：site-reported 共 2 条（o1 + o5）')
}

console.log('\n[D] 关键：三种「没有缓存价」必须互不相同')
{
  const silent = m.inferCacheReadSource({ cacheReadPrice: null, inPrice: 2 }, P_RICH)
  const noSrc = m.inferCacheReadSource({ cacheReadPrice: null, inPrice: null }, P_DRY)
  ok(silent !== noSrc, '「站点没公布」与「没有价格接口」是两个不同结论')
  ok(silent === 'site-silent' && noSrc === 'no-source', '具体值也对')
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
