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

/**
 * 失败的影响范围（scope）——回答「这次失败到底该怪谁」：
 *
 *   request   请求本身不成立（这一单太大/参数错）：换站也没用，直接原样报错，
 *             不要冷却站点。以前 budget 超限也进冷却，好站被无谓闲置 5 分钟。
 *   account   账号/额度问题：只影响这家，冷却到额度恢复。
 *   provider  这家没有这个模型/渠道：跳过这家其余供给，别在同一个站上反复撞。
 *   transient 限流这类临时状态：短冷却即恢复。
 *
 * 只有 countsAsOutage 的失败（5xx/超时/非 JSON）才是站点故障，会算进可用率。
 */
export const FAILURE_SCOPE = {
  // Key 被拒：整站这把钥匙都不可用，按账号处理
  auth: 'account',
  budget: 'request',
  quota: 'account',
  'model-missing': 'provider',
  'rate-limit': 'transient',
}

/** 已知 kind 的影响范围；未知 kind 视为 provider 级（保守：跳过这家其余供给）。 */
export function failureScope(kind) {
  return FAILURE_SCOPE[kind] || 'provider'
}

/** 各类「暂时不可用」的冷却时长：多久之后值得再试一次 */
export const UNAVAILABLE_COOLDOWN_MS = {
  quota: 30 * 60 * 1000,
  // 单次预算超限只说明这一单太大，5 分钟后照常参与竞争
  budget: 5 * 60 * 1000,
  'rate-limit': 5 * 60 * 1000,
  'model-missing': 60 * 60 * 1000,
  // Key 被拒（401/403）不是一个供给的问题：整站这把钥匙都废了，
  // 同步给账号作用域，别在同站的其他供给上白试第二次。
  auth: 30 * 60 * 1000,
}

const RULES = [
  {
    // 单次请求的预算/上限被拒（REQUEST_BUDGET_EXCEEDED）：这一次请求太大，
    // 不代表这条供给不能用——换个小的就过了。给个短冷却，别把它晾半小时
    kind: 'budget',
    scope: 'request',
    test: /request[_\s-]?budget[_\s-]?exceeded|本次预计需要|单次.{0,4}(预算|上限)/i,
  },
  {
    kind: 'quota',
    scope: 'account',
    test: /insufficient[_\s-]?balance|insufficient[_\s-]?quota|quota[_\s-]?exceeded|budget[_\s-]?exceeded|余额不足|额度不足|额度已用|欠费/i,
  },
  {
    kind: 'model-missing',
    scope: 'provider',
    test: /model[_\s-]?not[_\s-]?found|not[_\s-]?supported[_\s-]?by|not[_\s-]?in[_\s-]?group|no[_\s-]?available[_\s-]?(channel|account)|model_not_in_group|模型不存在|模型不可用|无可用渠道|资源不存在/i,
  },
  {
    // 鉴权失败（Key 失效 / 被禁用）：账号级的确定性失败，冷却 30 分钟等人换 Key
    kind: 'auth',
    scope: 'account',
    test: /invalid[_ 	-]*api[_ 	-]*key|incorrect[_ 	-]*api[_ 	-]*key|unauthorized|authentication[_-]?fail|invalid[_-]?token|api[_-]?key[_-]?(invalid|expired|disabled)|401|403|鉴权失败|密钥无效|无效的?\s*(api\s*)?key|apikey?\s*无效/i,
  },
  {
    kind: 'rate-limit',
    scope: 'transient',
    test: /\b429\b|rate[_\s-]?limit|too[_\s-]?many[_\s-]?requests|请求过于频繁|限流/i,
  },
]

/**
 * @param {string} message 上游错误文本（探针的 error 字段或网关的失败原因）
 * @returns {{kind: 'quota'|'budget'|'model-missing'|'rate-limit'|'auth'|null, countsAsOutage: boolean}}
 */
export function classifyFailure(message) {
  const text = String(message || '')
  for (const rule of RULES) {
    if (rule.test.test(text)) return { kind: rule.kind, scope: rule.scope, countsAsOutage: false }
  }
  return { kind: null, scope: 'provider', countsAsOutage: true }
}

/** 某类失败的冷却截止时间（毫秒时间戳）；未知类型没有冷却 */
export function cooldownUntil(kind, atMs) {
  const ms = UNAVAILABLE_COOLDOWN_MS[kind]
  if (!ms || !Number.isFinite(atMs)) return 0
  return atMs + ms
}
