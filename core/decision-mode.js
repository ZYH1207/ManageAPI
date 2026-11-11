/**
 * 决策侧重：智能决策页顶部的四档（性价比 / 价格 / 首字速度 / 价速比）。
 *
 * 为什么要有这个开关：原来的「智能」只有一种价值观——有效成本最低。
 * 但便宜和好用不是一回事：一条比别人便宜一万倍、首字却要等十几秒的供给，
 * 按有效成本它永远排第一，用户却根本不想用。排序依据是用户的取舍，不是代码的取舍。
 *
 * 价速比档已在 2026-11-02 移除。原因：它算的是「价格 ÷ 真实首字」，而真实首字
 * 样本在很多库里几乎为空（本机 12 个候选里大多数 realTtftMs 为 null），
 * 这时它把候选算成 Infinity 一片并列，实际退化成「看谁有真实数据」；
 * 有数据时又与价格档高度重合（本机实测 2 个候选下与 value 同序）。
 * 「流畅度」档已经把价格与速度的关系表达得更准（用首字+吐字，不是一个比值）。
 *
 * 口径（**唯一实现**，排序在 core/router.js#selectCandidates 里读这一份，
 * 前端从 /api/state 的 decisionModes 取同一张表渲染，别在浏览器里另抄一份）：
 *   value —— 性价比：有效成本 = 价格 ÷ 质量（原来的默认行为）
 *   price —— 价格：名义单价最低者优先，质量只用来挡不合格的
 *   speed —— 首字速度：首字延迟最低者优先，网关也优先派给最快的站
 *   flow —— 流畅度：首字 + 参照输出的吐字时间，越小越流畅（2026-11-02 新增）
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
    key: 'realSpeed',
    label: '实速（只信真实流量）',
    hint: '真实首字，无样本即淘汰',
    desc: '**只用真实流量的首字**，完全没有真实样本的站直接排到最后（不给它靠探针冒充最快的机会）。'
      + '这是最贴近你实际体感的一档 —— 探针发的是几十 token 的小请求，'
      + '和你几万到几十万上下文的真实耗时不是一回事。',
  },
  {
    key: 'flow',
    label: '流畅度',
    hint: '首字 + 吐字速度（一屏回答要多久）',
    desc: '**回答「哪个用起来真的更顺」**，而不只是「谁第一个字快」。'
      + '算法：首字 + 参照 500 token 的吐字时间，单位毫秒，越小越流畅。'
      + '为什么要它：首字只说明开头快慢，不说明后面吐得快不快——实测本机库就有一对反例，'
      + '首字 15.5 秒但吐字 227 tok/s 的站，实际读完比首字 5.8 秒但只吐 45 tok/s 的更快。'
      + '探针首字会按标定比值放大（本机约 2.7×），因为探针发的是几十 token 的小请求。',
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

  // 主键统一走 tierMetricOf：它和决策页「档位标量」、路由拖拽排序同源。
  // 以前这里手抄了一份分支，结果 realSpeed 档只加在 tierMetricOf 里，
  // 路由这边没跟上——切到实速档，排序其实还在按有效成本走，界面显示却在说
  // 「按真实首字排」。这类「显示一套、执行另一套」比算错更难发现，所以
  // 从今往后只留一份实现，别在这里另写 if。
  // 两个标量先各自算出来再比，**不要写成差**：`12000 - Infinity = -Infinity`，
  // 不是有限数，一旦用 Number.isFinite 守门就会把「一个有数据、一个没数据」
  // 判成「无从比较」而滑到次级口径——那正是「缺数据冒充最优」的老毛病。
  const ka = tierMetricOf(a?.row || a, mode)
  const kb = tierMetricOf(b?.row || b, mode)
  if (ka !== kb) {
    if (ka === Number.POSITIVE_INFINITY) return 1
    if (kb === Number.POSITIVE_INFINITY) return -1
    if (ka !== ka) return 1 // NaN：也算「不知道」，沉底
    if (kb !== kb) return -1
    return ka - kb
  }

  // 次级比较本身也要防「两条都缺价」：`Infinity - Infinity = NaN`，
  // 而比较函数返回 NaN 时 V8 的排序结果是未定义的（谁前谁后看实现）。
  // 这种情况下两条在本档位上确实无从比较，交给调用方的下一级口径（routeScore）
  // 去分先后，这里必须返回 0 而不是 NaN。
  const delta = cost(a) - cost(b)
  if (Number.isFinite(delta) && delta !== 0) return delta
  const priceDelta = price(a) - price(b)
  return Number.isFinite(priceDelta) ? priceDelta : 0
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

/**
 * 流畅度：预测「这个站答完一屏字要多久」，单位毫秒，越小越流畅。
 *
 * ## 为什么需要它（用户 2026-11-02 的原话）
 *
 *   「这些都是指针速，指针速度不一定准，所以你在用的时候也不知道哪个好。
 *     总得有个能先指示速度、能告诉你哪个最流畅的指标。」
 *
 * 首字（TTFT）只说明「第一个字多久出来」，不说明「后面吐得快不快」。
 * 实测本机库就有一对反例：
 *   o_524932ac  首字 15.5 秒，但吐字 227 tok/s
 *   o_9f4bc096  首字 5.8 秒，但吐字 45 tok/s
 * 只看首字会选后者，而实际读一整段回答时前者反而更快读完。
 *
 * 所以用「首字 + 参照输出量的吐字时间」合成一个数：
 *
 *     flowMs = ttft + refOutTokens × msPerToken
 *
 * refOutTokens 是参照输出量（默认 500 token，约一屏中文回答）。
 * 这不是「总耗时预测」——真实输出多长取决于模型，没人能预先知道；
 * 它的意义是**同一个参照工作量下谁更快**，用来横向比较，不是用来报 ETA。
 *
 * ## 口径优先级
 *
 *   1. 真实首字 + 真实吐字速度（最可信，来自真实流量的小时桶）
 *   2. 真实首字 + 无吐字数据 → 用首字 × 2 粗估（保守：假设吐字占一半时间）
 *   3. 无真实首字 → 用探针首字 × 标定比值（探针是小请求，比真实快）
 *   4. 都没有 → Infinity（排最后，不让它冒充最快）
 *
 * @param {object} row 路由行（realTtftMs / realMsPerToken / ttftMs）
 * @param {{refTokens?: number, calibRatio?: number}} options
 * @returns {number} 毫秒，拿不到就是 Infinity
 */
export function flowScoreOf(row, { refTokens = 500, calibRatio = 1 } = {}) {
  const real = num2(row?.realTtftMs)
  const probe = num2(row?.ttftMs)
  const msPerToken = num2(row?.realMsPerToken)
  const ratio = Number(calibRatio) > 0 ? Number(calibRatio) : 1

  // 首字从哪来
  let ttft = Number.POSITIVE_INFINITY
  let basis = 'none'
  if (real !== Number.POSITIVE_INFINITY) {
    ttft = real
    basis = 'real'
  } else if (probe !== Number.POSITIVE_INFINITY) {
    // 探针是小请求口径，真实的会慢 ratio 倍（本机标定约 2.7×）
    ttft = probe * ratio
    basis = 'probe'
  }
  if (ttft === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY

  // 吐字：有实测就用实测，没有就按「吐字耗时 ≈ 首字」粗估（一条保守假设，
  // 比假装吐字很快诚实——那会让慢站冒充满分）
  const genMs = msPerToken !== Number.POSITIVE_INFINITY
    ? msPerToken * refTokens
    : ttft
  return Math.round(ttft + genMs)
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
 * realSpeed → 真实首字、flow → 流畅度（首字+吐字）。缺数据一律 Infinity（排到最后），
 * 与 compareByBasis「不知道不能冒充最好」的口径一致。
 *
 * 入参形状同 compareByBasis：路由行（美元字段）和 explain 输出（人民币字段）都接。
 */
export function tierMetricOf(row, value) {
  const mode = normalizeDecisionMode(value)
  // 速度类档位：口径改成「真实优先」
  //   realSpeed     只认真实，没真实样本 → Infinity（排最后，不给它靠探针冒充）
  //   speed  真实优先，没有才退回探针
  // 其它档位与速度无关，行为不变。
  if (mode === 'realSpeed') return speedOf(row, 'real')
  // 流畅度：首字 + 参照输出量的吐字时间，回答「哪个真的更顺」
  // （用户 2026-11-02 提出：只看首字不知道谁流畅，探针首字本身也不一定准）
  if (mode === 'flow') {
    const r = num2(row?.calibRatio)
    return flowScoreOf(row, { calibRatio: r === Number.POSITIVE_INFINITY ? 1 : r })
  }
  if (mode === 'speed') return speedOf(row, 'prefer-real')
  if (mode === 'price') return num2(row?.priceUsd ?? row?.price)
  return num2(row?.effectiveUsd ?? row?.effective)
}
