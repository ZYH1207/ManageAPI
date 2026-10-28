/**
 * 决策侧重：智能决策页顶部的三档（性价比 / 价格 / 首字速度）。
 *
 * 为什么要有这个开关：原来的「智能」只有一种价值观——有效成本最低。
 * 但便宜和好用不是一回事：一条比别人便宜一万倍、首字却要等十几秒的供给，
 * 按有效成本它永远排第一，用户却根本不想用。排序依据是用户的取舍，不是代码的取舍。
 *
 * 口径（**唯一实现**，排序在 core/router.js#selectCandidates 里读这一份，
 * 前端从 /api/state 的 decisionModes 取同一张表渲染，别在浏览器里另抄一份）：
 *   value —— 性价比：有效成本 = 价格 ÷ 质量（原来的默认行为）
 *   price —— 价格：名义单价最低者优先，质量只用来挡不合格的
 *   speed —— 首字速度：首字延迟最低者优先，网关也优先派给最快的站
 *
 * 三档只改「能登场的里面谁排前面」，不改准入：可疑 / 不稳定 / 慢速 / 没有可信样本
 * 在任何一档下都不登场。想放宽那是「放行可疑供给」和「慢速档位限制」两个开关的事，
 * 不要把它们和排序偏好混成一个滑块——混起来用户永远说不清自己改的是哪个规则。
 */

export const DEFAULT_DECISION_MODE = 'value'

export const DECISION_MODES = [
  {
    key: 'value',
    label: '性价比',
    hint: '价格 ÷ 质量',
    desc: '按「有效成本 = 价格 ÷ 质量」排序：降智的站名义价再低，除下来也会更贵。',
  },
  {
    key: 'price',
    label: '价格',
    hint: '名义单价',
    desc: '只比名义单价，最便宜的排第一。质量只用来挡掉不合格的供给，不参与排序。',
  },
  {
    key: 'speed',
    label: '首字速度',
    hint: '首字延迟',
    desc: '完全按首字延迟排序，最快的排第一，网关也优先派给最快的站。',
  },
]

/** 任意输入 → 合法档位；非法 / 空一律回落默认（宁可回到原行为，也不静默改成别的口径） */
export function normalizeDecisionMode(value) {
  const key = String(value ?? '').trim()
  return DECISION_MODES.some((mode) => mode.key === key) ? key : DEFAULT_DECISION_MODE
}

/** 档位定义（含 label / hint / desc），非法输入回落默认档 */
export function decisionModeOf(value) {
  const key = normalizeDecisionMode(value)
  return DECISION_MODES.find((mode) => mode.key === key)
}

/** 给 /api/state 的整张表：前端照着渲染，不在浏览器里重写标签 */
export function decisionModeTable() {
  return DECISION_MODES.map((mode) => ({ ...mode }))
}

/** 一句话描述当前侧重，用于决策页说明与路由日志 */
export function describeDecisionMode(value) {
  const mode = decisionModeOf(value)
  return `${mode.label}（${mode.hint}）`
}

/**
 * 同一档位内的排序口径——**唯一实现**。
 *
 * 路由（core/router.js）和看板结论句（core/pricing.js）都调它：
 * 两处各写一份比较逻辑，切档之后迟早一边改了一边没改，结论和派活对不上。
 *
 * 入参两种形状都接：路由行带美元字段（effectiveUsd / priceUsd），
 * 决策快照（explain 的输出）只带人民币字段（effective / price）。
 * 人民币和美元只差一个汇率标量，排序结果完全等价，所以谁在就用谁。
 *
 * 缺数据（null / NaN，比如没探过针的 ttftMs）一律排到最后：
 * 「不知道多快」不能冒充「最快」，「没填价」也不能冒充「最便宜」。
 * 次级比较固定是「有效成本 → 价格」：同价时质量高的先上。
 */
export function compareByBasis(a, b, value) {
  const mode = normalizeDecisionMode(value)
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.POSITIVE_INFINITY)
  const cost = (row) => num(row.effectiveUsd ?? row.effective)
  const price = (row) => num(row.priceUsd ?? row.price)

  if (mode === 'speed') {
    const delta = num(a.ttftMs) - num(b.ttftMs)
    if (delta !== 0) return delta
  } else if (mode === 'price') {
    const delta = price(a) - price(b)
    if (delta !== 0) return delta
  }
  const delta = cost(a) - cost(b)
  if (delta !== 0) return delta
  return price(a) - price(b)
}
