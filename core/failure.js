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
  // 客户端自己按了 ESC / 关了页面：这一单没跑完，但不是任何一方出错。
  // 按 request 处理（这一单不成立），绝不冷却、绝不算站点故障。
  'client-abort': 'request',
}

/** 已知 kind 的影响范围；未知 kind 视为 provider 级（保守：跳过这家其余供给）。 */
export function failureScope(kind) {
  return FAILURE_SCOPE[kind] || 'provider'
}

/** 各类「暂时不可用」的冷却时长：多久之后值得再试一次 */
export const UNAVAILABLE_COOLDOWN_MS = {
  // 余额/额度类不是「等一会儿就好」，要人去充值或换 Key：给足半天再探。
  quota: 6 * 60 * 60 * 1000,
  // 单次预算超限只说明这一单太大，10 分钟后照常参与竞争
  budget: 10 * 60 * 1000,
  // 限流至少半小时：之前 5 分钟的冷却比重试节奏（20 分钟）还短，
  // 等于没有冷却，同一条供给一天被探 60 多次，还越探越限流。
  'rate-limit': 30 * 60 * 1000,
  'model-missing': 6 * 60 * 60 * 1000,
  // Key 被拒（401/403）不是一个供给的问题：整站这把钥匙都废了，
  // 同步给账号作用域，别在同站的其他供给上白试第二次。
  auth: 60 * 60 * 1000,
  // 分组在站方后台被删了：不修永远是错的，别每小时再去撞一次。
  'group-deleted': 6 * 60 * 60 * 1000,
  // 502/503/504 是站方上游抖动，值得等一会儿再验
  upstream: 10 * 60 * 1000,
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
    test: /model[_\s-]?not[_\s-]?found|not[_\s-]?supported(?:[_\s-]?by)?|not[_\s-]?in[_\s-]?group|no[_\s-]?available[_\s-]?(channel|account)|model_not_in_group|模型不存在|模型不可用|无可用渠道|资源不存在/i,
  },
  {
    // 分组被站方删了（GROUP_DELETED）：比鉴权失败更确定——这把 Key 的分组
    // 不存在了，不修就永远是错的。排在 auth 之前：403 会被 auth 的裸 403 吃掉。
    kind: 'group-deleted',
    scope: 'account',
    test: /group[_\s-]?deleted|所属分组已删除|分组已删除|group[_\s-]?not[_\s-]?found/i,
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
  {
    // 站方上游抖动（502/503/504）：不是这条供给的问题，但也不是「能用」，
    // 给个短冷却，别在重试节奏里反复撞。必须排在 auth 之后，
    // 否则 403 里带 503 字样的响应会被抢先归到这里。
    kind: 'upstream',
    scope: 'provider',
    // 502 是站方真的没服务成功，必须继续扣可用率（此前靠「没有规则」间接实现）
    countsAsOutage: true,
    test: /HTTP\s*50[234]|bad gateway|gateway time-?out|upstream (request|service)|service temporarily unavailable|服务暂时不可用/i,
  },
  {
    // 客户端主动断开：浏览器按 ESC、切走页面、Ctrl+C、fetch abort。
    // 本地会把上游 fetch abort 掉，读流于是抛 AbortError（文本形如
    // "This operation was aborted"），push() 也会抛「客户端已断开」。
    // 以前这两句落进默认规则 → countsAsOutage=true → 记成站方断流，
    // 拉低可用率、把排查引向站方，而真正该记的是「这一单被用户取消了」。
    // 必须排在最后：先让真正的错误类型（429/401/额度…）优先归因。
    // 也必须在文本出现「超时」时让位——AbortSignal.timeout() 的报错是
    // "The operation was aborted due to timeout"，那是站卡死，必须继续算故障。
    kind: 'client-abort',
    scope: 'request',
    test: /^(?![\s\S]*(?:timeout|timed out|超时))[\s\S]*(?:客户端已断开|client[_\s-]?abort|aborted by the (?:client|caller)|user aborted|operation was aborted)/i,
  },
]

/**
 * @param {string} message 上游错误文本（探针的 error 字段或网关的失败原因）
 * @returns {{kind: 'quota'|'budget'|'model-missing'|'rate-limit'|'auth'|'group-deleted'|'upstream'|'client-abort'|'connection'|null, countsAsOutage: boolean}}
 */
/** 5 分钟内两个以上站点都出现连接层失败 → 更像是本机网络，不是站点 */
export const LOCAL_NETWORK_WINDOW_MS = 5 * 60 * 1000

/**
 * 连接层失败的特征（DNS/TCP/TLS 都没过，拿不到任何 HTTP 响应）。
 *
 * 注意：它**不能**放进 RULES —— RULES 里命中的都算「不是站方的问题」，
 * 而连接失败单看一条分不清是站挂了还是本机断网，必须先按站方故障计，
 * 再由 localNetworkSuspect() 用「多站同时」这个证据来豁免。
 */
const CONNECTION_RE =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang ?up|network error|连接被重置|连接超时|网络错误/i

/** 这条错误是不是「连接层就没通」（没拿到任何 HTTP 响应） */
export function isConnectionError(message) {
  const text = String(message || '')
  if (/HTTP \d{3}/i.test(text)) return false // 有 HTTP 状态码 = 已经连上了
  return CONNECTION_RE.test(text)
}

/**
 * 判断这次连接层失败要不要算「本机网络问题」。
 *
 * @param {string} providerId 这次失败的站点
 * @param {Map<string, number>} recent providerId → 最近一次连接层失败的时间戳
 * @param {number} [now]
 * @returns {{localNetwork: boolean, providers: number}}
 */
export function localNetworkSuspect(providerId, recent, now = Date.now()) {
  const map = recent || new Map()
  if (providerId) map.set(providerId, now)
  // 清掉窗口外的
  for (const [id, at] of map) {
    if (now - at > LOCAL_NETWORK_WINDOW_MS) map.delete(id)
  }
  return { localNetwork: map.size >= 2, providers: map.size }
}

export function classifyFailure(message) {
  const text = String(message || '')
  // 连接层失败先按站方故障计（scope=provider），豁免逻辑在调用方按「多站同时」判定
  if (isConnectionError(text)) return { kind: 'connection', scope: 'provider', countsAsOutage: true }
  for (const rule of RULES) {
    // 规则默认「有种类但不计故障」：429/额度/鉴权这些是配置或限流问题，
    // 记下来档位就够了。真该扣可用率的规则（上游 5xx）显式标 countsAsOutage。
    if (rule.test.test(text)) {
      return { kind: rule.kind, scope: rule.scope, countsAsOutage: rule.countsAsOutage === true }
    }
  }
  return { kind: null, scope: 'provider', countsAsOutage: true }
}

/** 某类失败的冷却截止时间（毫秒时间戳）；未知类型没有冷却 */
export function cooldownUntil(kind, atMs) {
  const ms = UNAVAILABLE_COOLDOWN_MS[kind]
  if (!ms || !Number.isFinite(atMs)) return 0
  return atMs + ms
}
