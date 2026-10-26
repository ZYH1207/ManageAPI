/**
 * 失败归因：把上游返回的错误分成两类。
 *
 *   站点故障（countsAsOutage）—— 5xx、超时、连接失败、返回不是 JSON……
 *     这些说明「这家现在服务不了你」，要算进可用率。
 *
 *   供给暂时不可用（不计入可用率）—— 额度用完、被限流、模型不在这个分组里。
 *     这些是「这条供给此刻拿不到」，不是站点不稳定：余额充上、限流过去、
 *     换个分组就能用。把它们算成站点故障，会让一堆只是没额度的站长期挂红，
 *     也把真正的故障信号（卡死、502）淹掉。真实数据里这类占比很高
 *     （403 INSUFFICIENT_BALANCE、429 rate limit、404 model not supported）。
 *
 * 对「暂时不可用」不扣分，而是给一段冷却时间：冷却期内不参与路由，
 * 冷却结束后重试。这样既不冤枉站点，也不会把钱继续往一个空额度池里砸。
 */

/** 各类「暂时不可用」的冷却时长：多久之后值得再试一次 */
export const UNAVAILABLE_COOLDOWN_MS = {
  quota: 30 * 60 * 1000,
  'rate-limit': 5 * 60 * 1000,
  'model-missing': 60 * 60 * 1000,
}

/** 冷却原因的中文说明，决策页直接展示 */
export const UNAVAILABLE_LABEL = {
  quota: '额度不足',
  'rate-limit': '限流中',
  'model-missing': '模型不可用',
}

const RULES = [
  {
    kind: 'quota',
    test: /insufficient[_\s-]?balance|insufficient[_\s-]?quota|quota[_\s-]?exceeded|budget[_\s-]?exceeded|余额不足|额度不足|额度已用|欠费/i,
  },
  {
    kind: 'model-missing',
    test: /model[_\s-]?not[_\s-]?found|not[_\s-]?supported[_\s-]?by|not[_\s-]?in[_\s-]?group|no[_\s-]?available[_\s-]?(channel|account)|model_not_in_group|模型不存在|模型不可用|无可用渠道|资源不存在/i,
  },
  {
    kind: 'rate-limit',
    test: /\b429\b|rate[_\s-]?limit|too[_\s-]?many[_\s-]?requests|请求过于频繁|限流/i,
  },
]

/**
 * @param {string} message 上游错误文本（探针的 error 字段或网关的失败原因）
 * @returns {{kind: 'quota'|'model-missing'|'rate-limit'|null, countsAsOutage: boolean}}
 */
export function classifyFailure(message) {
  const text = String(message || '')
  for (const rule of RULES) {
    if (rule.test.test(text)) return { kind: rule.kind, countsAsOutage: false }
  }
  return { kind: null, countsAsOutage: true }
}

/** 某类失败的冷却截止时间（毫秒时间戳）；未知类型没有冷却 */
export function cooldownUntil(kind, atMs) {
  const ms = UNAVAILABLE_COOLDOWN_MS[kind]
  if (!ms || !Number.isFinite(atMs)) return 0
  return atMs + ms
}
