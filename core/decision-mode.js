/**
 * 决策侧重：智能决策页顶部那三档排序偏好（价格 / 性价比 / 质量）。
 *
 * 为什么要有这个开关：原来的「智能」只有一种价值观——有效成本最低。
 * 但便宜和好用不是一回事：一条比别家便宜十倍、却总是降智/掉包的供给，
 * 按有效成本它可能永远排第一，用户其实根本不想用。排序依据是用户的取舍，
 * 不是代码的取舍。
 *
 * 关键边界：**档位只改「能登场的里面谁排前面」，不改准入**。
 * 可疑 / 不稳定 / 缺少可信样本仍然由评分与「放行可疑供给」这个独立开关决定，
 * 任何一档都不能把不合格的站放进来。快慢不是准入条件——它折进质量里的体验分。
 * 把准入和偏好混成一个滑块，用户永远说不清自己改的是哪条规则。
 *
 * 口径（唯一实现：排序在 core/router.js#selectCandidates 读这一份；
 * 前端从 /api/state 的 decisionModes 取同一张表渲染，别在浏览器里另抄一份）：
 *   price   —— 价格：名义单价最低优先，质量只用来挡不合格的
 *   value   —— 性价比：有效成本 = 价格 ÷ 质量（默认，也是此前唯一的行为）
 *   quality —— 质量：质量最高优先，同质量再比价格
 *
 * 为什么是三档离散而不是连续权重：价格和质量量纲不同，连续权重会被理解成
 * 「按比例权衡」，实际调的是一个指数，中间值说不清也没法复盘；而真正的
 * 「质量优先」是词典序（先比质量再比价格），指数权重在数学上做不到。
 */

export const DEFAULT_DECISION_MODE = 'value'

export const DECISION_MODES = [
  {
    key: 'price',
    label: '价格',
    hint: '名义单价最低',
    desc: '只比名义单价，最便宜的排第一。质量仍然用来挡掉不合格的供给，但不参与排序。',
  },
  {
    key: 'value',
    label: '性价比',
    hint: '价格 ÷ 质量（默认）',
    desc: '按「有效成本 = 价格 ÷ 质量」排序：降智的站名义价再低，除下来也会更贵。',
  },
  {
    key: 'quality',
    label: '质量',
    hint: '质量最高，同质量比价格',
    desc: '按质量从高到低排，质量相同才比价格。适合「输出必须可信、贵一点无所谓」的时候。',
  },
]

/** 任意输入 → 合法档位；非法 / 空一律回落默认（宁可回到原行为，也不静默改成别的口径） */
export function normalizeDecisionMode(value) {
  const key = String(value ?? '')
    .trim()
    .toLowerCase()
  return DECISION_MODES.some((mode) => mode.key === key) ? key : DEFAULT_DECISION_MODE
}

/** 档位元信息（给界面渲染标签与说明用）；非法输入返回默认档。 */
export function decisionModeMeta(value) {
  const key = normalizeDecisionMode(value)
  return DECISION_MODES.find((mode) => mode.key === key)
}

const INF = Number.POSITIVE_INFINITY

/**
 * 参与排序的键（升序）。返回数组是为了让「质量档」能表达词典序：
 * 先按 -quality，再按价格。
 *
 * @param {{priceUsd?:number|null, quality?:number|null, effectiveUsd?:number|null}} candidate
 * @param {string} mode
 * @returns {number[]}
 */
export function orderKey(candidate, mode) {
  const price = Number.isFinite(candidate?.priceUsd) ? candidate.priceUsd : INF
  const quality = Number.isFinite(candidate?.quality) ? candidate.quality : null
  const effective = Number.isFinite(candidate?.effectiveUsd) ? candidate.effectiveUsd : INF
  switch (normalizeDecisionMode(mode)) {
    case 'price':
      return [price]
    case 'quality':
      // 没有质量证据的（null）排在质量最差的后面：它连"可信"都还没被证明
      return [quality === null ? 0 : -quality, price]
    default:
      return [effective]
  }
}

/** 按档位比较两个候选（升序，排在前面的返回负数）。 */
export function compareByMode(a, b, mode) {
  const ka = orderKey(a, mode)
  const kb = orderKey(b, mode)
  const len = Math.max(ka.length, kb.length)
  for (let i = 0; i < len; i += 1) {
    const va = ka[i] ?? 0
    const vb = kb[i] ?? 0
    if (va === vb) continue
    return va < vb ? -1 : 1
  }
  return 0
}

/**
 * 表格里「排序键」那一列要显示的值：跟当前档位一一对应，
 * 否则用户看到的数字和排名顺序对不上。
 * @returns {number|null}
 */
export function sortValueOf(candidate, mode) {
  switch (normalizeDecisionMode(mode)) {
    case 'price':
      return Number.isFinite(candidate?.priceUsd) ? candidate.priceUsd : null
    case 'quality':
      return Number.isFinite(candidate?.quality) ? candidate.quality : null
    default:
      return Number.isFinite(candidate?.effectiveUsd) ? candidate.effectiveUsd : null
  }
}