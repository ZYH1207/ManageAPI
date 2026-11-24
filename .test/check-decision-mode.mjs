/**
 * 「决策侧重」自检（纯函数 + 排序入口，不联网）：
 *   1. 三档在**同一份数据**下排出三种不同顺序（价格 / 性价比 / 质量）；
 *   2. 档位只改排序，不改准入：不可信、首字超限的供给在哪一档都排在可用之后；
 *   3. 缺失 / 拼错的档位回落默认（value），老库升级后排序结果不变；
 *   4. 手动顺序仍然优先于排序键（用户拖过的顺序不被滑块冲掉）；
 *   5. 界面「排序键」列取的值与排序实际用的键一致（否则数字和名次对不上）。
 *
 * 用法：node .test/check-decision-mode.mjs
 */
import {
  DECISION_MODES,
  DEFAULT_DECISION_MODE,
  normalizeDecisionMode,
  decisionModeMeta,
  orderKey,
  compareByMode,
  sortValueOf,
} from '../core/decision-mode.js'
import { selectCandidates } from '../core/router.js'

let failed = 0
function ok(cond, message) {
  if (cond) {
    console.log(`  ✓ ${message}`)
  } else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

const MODEL = 'glm-5.3'
const settings = { blendInputWeight: 0.25, fx: { base: 'USD', rates: { CNY: 7.2 } }, decisionMode: 'value' }

/** 造一条手填美元价的供给：价格定死，质量由 scores 注入。 */
function offer(id, providerId, inPrice) {
  return {
    id,
    providerId,
    modelKey: MODEL,
    upstreamName: MODEL,
    pricingMode: 'manual',
    currency: 'USD',
    currencySource: 'custom',
    inPrice,
    outPrice: inPrice * 4,
    ratioSource: 'custom',
  }
}

/** 一条「健康」评分：quality 直接给定，可用率与完整性都合格。 */
function healthy(quality, extra = {}) {
  return { status: 'healthy', samples: 5, availability: 0.99, quality, confidence: 'high', ttftMs: 100, ...extra }
}

const providers = [
  { id: 'p1', name: 'A站' },
  { id: 'p2', name: 'B站' },
  { id: 'p3', name: 'C站' },
  { id: 'p4', name: 'D站' },
]
const credentials = providers.map((provider) => ({ id: `k_${provider.id}`, providerId: provider.id, group: '' }))

// A：价格 1.0、质量 1.00 → 有效成本 1.0
// B：价格 0.5、质量 0.25 → 有效成本 2.0（名义便宜一半，除质量后反而最贵）
// C：价格 2.0、质量 1.00 → 有效成本 2.0
// D：价格 0.1、质量 0.90 —— 但评分不稳定，永远不该被选中
const offers = [offer('a', 'p1', 1.0), offer('b', 'p2', 0.5), offer('c', 'p3', 2.0), offer('d', 'p4', 0.1)]
const scores = new Map([
  ['a', healthy(1.0)],
  ['b', healthy(0.25)],
  ['c', healthy(1.0)],
  ['d', { status: 'unstable', samples: 5, availability: 0.4, quality: 0.9, confidence: 'high', ttftMs: 100 }],
])

const rank = (mode, extraSettings = {}, order = null) =>
  selectCandidates({
    offers,
    providers,
    credentials,
    scores,
    benchmarks: {},
    settings: { ...settings, decisionMode: mode, ...extraSettings },
    model: MODEL,
    order,
  })

const ids = (mode, extraSettings, order) => rank(mode, extraSettings, order).map((row) => row.offer.id).join(',')

console.log('[1] 三档在同一份数据下排出不同顺序')
{
  ok(ids('price') === 'b,a,c,d', `价格档：B(0.5) → A(1.0) → C(2.0) → D(不稳定) 得到 ${ids('price')}`)
  ok(ids('value') === 'a,b,c,d', `性价比档：A(1.0) → B/C(2.0，同价取便宜的 B) → D 得到 ${ids('value')}`)
  ok(ids('quality') === 'a,c,b,d', `质量档：A(1.0) → C(1.0，同质量取便宜的 A 先) → B(0.25) → D 得到 ${ids('quality')}`)
}

console.log('[2] 档位只改排序，不改准入')
{
  // 首字不再有绝对门槛（探针量 1k 级短请求，真实首字慢 3~4 倍，固定上限必误杀）：
  // 快慢只通过质量里的体验分折算，任何档位都不会因为「慢」被踢出候选
  const ignoredGate = rank('quality', { maxTtftMs: 50 })
  ok(
    ignoredGate.filter((row) => row.offer.id !== 'd').every((row) => row.routable === true),
    '首字上限已删除：慢站照样可路由，只有不稳定的 D 不可路由',
  )
  // 不可信站无论质量档多喜欢它，都排在可用之后
  for (const mode of ['price', 'value', 'quality']) {
    const rows = rank(mode)
    const last = rows[rows.length - 1]
    ok(last.offer.id === 'd' && last.routable === false, `${mode} 档：不稳定的 D 在最后且不可路由`)
  }
  // 放行开关打开后 D 能参选，但仍按档位排序（质量档下它排不到第一）
  const allowed = rank('quality', { allowUntrusted: true })
  ok(allowed[0].offer.id === 'a' && allowed.some((row) => row.offer.id === 'd' && row.routable), '放行可疑后 D 可路由，但质量档仍先选 A')
}

console.log('[3] 非法 / 缺失档位回落默认 value')
{
  ok(normalizeDecisionMode(undefined) === DEFAULT_DECISION_MODE, 'undefined → value')
  ok(normalizeDecisionMode('') === 'value', '空串 → value')
  ok(normalizeDecisionMode('cheapest') === 'value', '拼错的档位 → value（不静默改成别的口径）')
  ok(normalizeDecisionMode(' QUALITY ') === 'quality', '首尾空白与大小写被归一')
  ok(ids(undefined) === ids('value'), 'settings 里没有 decisionMode 时，排序与默认档完全一致')
  ok(DECISION_MODES.map((mode) => mode.key).join(',') === 'price,value,quality', '档位表顺序 = 滑块 0/1/2')
  ok(decisionModeMeta('quality').label === '质量', '档位元信息可取到 label')
  ok(decisionModeMeta('nope').key === 'value', '非法档位取元信息也回落 value')
}

console.log('[4] 手动顺序优先于排序键')
{
  const ordered = ids('price', {}, ['c', 'a'])
  ok(ordered === 'c,a,b,d', `手动顺序 c,a 覆盖滑块（价格档下得到 ${ordered}）`)
  const orderedQuality = ids('quality', {}, ['b'])
  ok(orderedQuality === 'b,a,c,d', `质量档下手动首选 B 仍排第一（得到 ${orderedQuality}）`)
}

console.log('[5] 排序键与排序实际用的键一致')
{
  // orderKey 升序排出来的顺序，必须与 selectCandidates 的结果一致
  for (const mode of DECISION_MODES.map((item) => item.key)) {
    const rows = rank(mode).filter((row) => row.routable)
    const sorted = [...rows].sort((a, b) => compareByMode(a, b, mode)).map((row) => row.offer.id)
    ok(sorted.join(',') === rows.map((row) => row.offer.id).join(','), `${mode} 档：orderKey 与路由排序一致（${sorted.join(',')}）`)
    // 界面拿 sortValue 显示，它必须是这一档真正比较的那个量（质量档比的是 -quality，
    // 但显示给用户的是正的 quality，方向靠"越高越好"的列头表达）
    const field = { price: 'priceUsd', value: 'effectiveUsd', quality: 'quality' }[mode]
    for (const row of rows) {
      ok(
        sortValueOf(row, row.decisionMode) === row[field],
        `${mode} 档：${row.offer.id} 的排序键 ${sortValueOf(row, row.decisionMode)} == ${field} ${row[field]}`,
      )
    }
    if (mode === 'quality') {
      ok(orderKey(rows[0], mode)[0] === -rows[0].quality, '质量档的 orderKey 首分量 = -quality（升序即质量高的在前）')
    }
  }
  const picked = rank('quality')[0]
  ok(picked.sortValue === picked.quality, '质量档的排序键显示质量本身')
  const cheap = rank('price')[0]
  ok(cheap.sortValue === cheap.priceUsd, '价格档的排序键显示名义单价（美元口径）')
  const best = rank('value')[0]
  ok(best.sortValue === best.effectiveUsd, '性价比档的排序键显示有效成本（美元口径）')
}

console.log('')
if (failed > 0) {
  console.error(`${failed} 项失败`)
  process.exit(1)
}
console.log('全部通过')