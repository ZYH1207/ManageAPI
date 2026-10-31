/**
 * 决策侧重：智能决策页顶部的四档（性价比 / 价格 / 首字速度 / 价速比）。
 *
 * 为什么要有这个开关：原来的「智能」只有一种价值观——有效成本最低。
 * 但便宜和好用不是一回事：一条比别人便宜一万倍、首字却要等十几秒的供给，
 * 按有效成本它永远排第一，用户却根本不想用。排序依据是用户的取舍，不是代码的取舍。
 *
 * 为什么要有第四档（价速比）：原有三档两头都太极端——价格档只看钱、速度档只看快，
 * 而性价比档除的是质量，可很多模型质量本来就在伯仲之间，除完之后拉开不开差距，
 * 等于少了一个参考维度。价速比把价格和首字延迟放进同一个数（每毫秒首字等待
 * 花多少钱），贵和慢会在同一个比值里现形，价格与速度综合最优的自然浮上来。
 *
 * 口径（**唯一实现**，排序在 core/router.js#selectCandidates 里读这一份，
 * 前端从 /api/state 的 decisionModes 取同一张表渲染，别在浏览器里另抄一份）：
 *   value —— 性价比：有效成本 = 价格 ÷ 质量（原来的默认行为）
 *   price —— 价格：名义单价最低者优先，质量只用来挡不合格的
 *   speed —— 首字速度：首字延迟最低者优先，网关也优先派给最快的站
 *   priceSpeed —— 价速比：价格 ÷ 首字延迟，越小越优先
 *
 * 四档只改「能登场的里面谁排前面」，不改准入：可疑 / 不稳定 / 慢速 / 没有可信样本
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
    hint: '真实首字（没有就退回探针）',
    desc: '按首字延迟排序。**优先用真实流量的首字**（db.offerStats 逐小时桶）；'
      + '这个站还没真实流量时退回探针首字，并在决策日志里标出口径。',
  },
  {
    key: 'priceSpeed',
    label: '价速比',
    hint: '价格 ÷ 真实首字',
    desc: '按「每毫秒首字等待花多少钱」排序。首字口径同「首字速度」：真实优先、探针兜底。',
  },
  {
    key: 'realSpeed',
    label: '实速（只信真实流量）',
    hint: '真实首字，无样本即淘汰',
    desc: '**只用真实流量的首字**，完全没有真实样本的站直接排到最后（不给它靠探针冒充最快的机会）。'
      + '这是最贴近你实际体感的一档 —— 探针发的是几十 token 的小请求，'
      + '和你几万到几十万上下文的真实耗时不是一回事。',
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
  } else if (mode === 'priceSpeed') {
    const delta = paceOf(a) - paceOf(b)
    if (delta !== 0) return delta
  }
  const delta = cost(a) - cost(b)
  if (delta !== 0) return delta
  return price(a) - price(b)
}

/** 价格 ÷ 首字延迟（价速比的标量）；首字缺失 / 非正数一律 Infinity，不冒充最优 */
function paceOf(row, speedPolicy = 'prefer-real') {
  const price = num2(row.priceUsd ?? row.price)
  const ttft = speedOf(row, speedPolicy)
  if (price === Number.POSITIVE_INFINITY || ttft === Number.POSITIVE_INFINITY || ttft <= 0) {
    return Number.POSITIVE_INFINITY
  }
  return price / ttft
}
const num2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.POSITIVE_INFINITY)

/**
 * 排序用哪个首字。
 *
 * 为什么必须有这一层：探针发的是 45 token 的小请求，量到的 ~2 秒，
 * 和用户 25 万上下文真实跑的 ~9 秒**不是同一个东西**。混在一起平均
 * 会让人以为这个站很快（项目里真实踩过，见 core/score.js#realTtftOf）。
 * 所以排序要优先用真实流量口径。
 *
 * @param {object} row  路由行 / explain 输出
 * @param {'real'|'prefer-real'} policy
 *   'real'        只用真实首字；没有真实样本就返回 Infinity（排最后）
 *   'prefer-real' 真实优先，没有就退回探针（探针口径会在决策日志里标出来）
 * @returns {number} 毫秒，拿不到就是 Infinity（与「不知道不能冒充最好」同口径）
 */
export function speedOf(row, policy = 'prefer-real') {
  const real = num2(row?.realTtftMs)
  const probe = num2(row?.ttftMs)
  if (policy === 'real') return real
  return real !== Number.POSITIVE_INFINITY ? real : probe
}

/** 这一行的首字用的是哪个口径。决策日志用它解释「凭什么说它快」。 */
export function speedBasisOf(row, policy = 'prefer-real') {
  const real = num2(row?.realTtftMs)
  const probe = num2(row?.ttftMs)
  const realOk = real !== Number.POSITIVE_INFINITY
  const probeOk = probe !== Number.POSITIVE_INFINITY
  if (policy === 'real') return realOk ? 'real' : 'none'
  if (realOk) return 'real'
  if (probeOk) return 'probe'
  return 'none'
}

/**
 * 档位 → 跨模型可比的标量（越小越优），**唯一实现**。
 *
 * compareByBasis 只能比「同一个模型的几条供给」；自动路由要在**所有模型之间**
 * 挑一个最优，得先给每个模型算出一个数。各档的标量与 compareByBasis 的主键
 * 一一对应：value → 有效成本、price → 名义单价、speed → 首字延迟、
 * priceSpeed → 价格 ÷ 首字延迟。缺数据一律 Infinity（排到最后），
 * 与 compareByBasis「不知道不能冒充最好」的口径一致。
 *
 * 入参形状同 compareByBasis：路由行（美元字段）和 explain 输出（人民币字段）都接。
 */
export function tierMetricOf(row, value) {
  const mode = normalizeDecisionMode(value)
  // 速度类档位：口径改成「真实优先」
  //   realSpeed     只认真实，没真实样本 → Infinity（排最后，不给它靠探针冒充）
  //   speed / priceSpeed  真实优先，没有才退回探针
  // 其它档位与速度无关，行为不变。
  if (mode === 'realSpeed') return speedOf(row, 'real')
  if (mode === 'speed') return speedOf(row, 'prefer-real')
  if (mode === 'price') return num2(row?.priceUsd ?? row?.price)
  if (mode === 'priceSpeed') return paceOf(row ?? {}, 'prefer-real')
  return num2(row?.effectiveUsd ?? row?.effective)
}
