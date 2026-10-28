/**
 * 失败归因：把上游返回的错误分成两类。
 *
 *   站点故障（countsAsOutage）—— 5xx、超时、连接失败、返回不是 JSON……
 *     这些说明「这家现在服务不了你」，要算进可用率。
 *
 *   供给暂时不可用（不计入可用率）—— 余额用完、被限流、模型不在这个分组里。
 *     这些是「这条供给此刻拿不到」，不是站点不稳定：余额充上、限流过去、
 *     换个分组就能用。把它们算成站点故障，会让一堆只是没余额的站长期挂红，
 *     也把真正的故障信号（卡死、502）淹掉。真实数据里这类占比很高
 *     （403 INSUFFICIENT_BALANCE、429 rate limit、404 model not supported）。
 *
 * 对「暂时不可用」不扣分，而是给一段等待时间：窗口内不参与路由，到点重试。
 * 这样既不冤枉站点，也不会把钱继续往一个空额度池里砸。
 *
 * 「冷却」这个词只留给**上游账号真的在冷却**（限流 / 账号池排队，有的模型
 * 一冷却就是 5 小时）。余额不足、单次请求太大、分组里没这个模型都不是冷却——
 * 那是账单和配置问题，要人去动手。混在同一个词下面，用户看到的永远只有
 * 「冷却中」，不知道到底该充值、该缩上下文，还是该换分组。
 */

const RULES = [
  {
    // 站点不支持这个协议路径（最典型的是 Responses）：这不是站点坏了，也不是
    // 额度问题，而是「这一条路它不提供」。必须排在 model-missing 前面，
    // 并且刻意不给等待窗口——同一条供给走 chat 可能完全正常，把它整体冷却掉
    // 会让 chat 请求也失去这家站。
    kind: 'protocol-unsupported',
    test: /does not allow \/v1\/|never support \/v1\/|unsupported (endpoint|path)|不支持的?\s*(接口|路径|端点|endpoint)|暂不支持\s*\/v1\//i,
  },
  {
    // 单次请求的预算/上限被拒（REQUEST_BUDGET_EXCEEDED）：这一次请求太大，
    // 不代表这条供给不能用——换个小的就过了。给个短窗口，别把它晾半小时。
    // 注意要排在 quota 前面：这类文案里也带 budget_exceeded。
    kind: 'budget',
    test: /request[_\s-]?budget[_\s-]?exceeded|本次预计需要|单次.{0,4}(预算|上限)/i,
  },
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
 * 各类「暂时不可用」的等待时长：多久之后值得再试一次。
 * 能拿到上游自己说的时长时以它为准（见 retryAfterFromText），这张表只是兜底。
 */
export const UNAVAILABLE_COOLDOWN_MS = {
  // 余额不足：充值就解，1 分钟只为避免同一秒里把同一个 403 撞十几遍。
  // 以前是 30 分钟——「充了钱还要罚站半小时」，而且冷却到期还要一次成功证据
  // 才解除；定时探测关着的时候没人去探，供给就被永久锁死（真实踩过：
  // 绿萝余额已回到 9.98，14 条在役供给里 12 条还挂着「额度不足 · 等探测确认」）。
  quota: 60 * 1000,
  // 单次请求太大：换个小一点的请求就过，5 分钟后照常参与竞争
  budget: 5 * 60 * 1000,
  // 真正的冷却：站点账号池被限流。上游没给时长时先 5 分钟探一次
  'rate-limit': 5 * 60 * 1000,
  'model-missing': 60 * 60 * 1000,
  // 协议不支持刻意不给等待窗口：同一条供给换一条路（chat / responses）可能完全正常，
  // 整体冷却会让另一个协议的请求也失去这家站
}

/** 只有这几类才配叫「冷却」——上游账号自己排着队，只能等它到点 */
export const REAL_COOLDOWN_KINDS = new Set(['rate-limit'])
export function isRealCooldown(kind) {
  return REAL_COOLDOWN_KINDS.has(kind)
}

/**
 * 什么原因 + 该做什么。界面、决策页、告警只从这里取文案，别在各处再写一套
 * 「不可用」——用户最烦的就是「它红了，但不说我能做什么」。
 */
export const UNAVAILABLE_LABEL = {
  quota: '余额不足',
  budget: '单次请求超限',
  'rate-limit': '上游账号冷却中',
  'model-missing': '该分组没有这个模型',
  'protocol-unsupported': '不支持该协议',
  // 不是「暂时不可用」而是「目前不稳」：真实流量失败率过高，短时间避一避。
  // 单独一类是因为它不来自上游报错文案，而是网关自己算出来的比率（core/score.js）
  'error-rate': '失败率过高',
}

/** 每一类「暂时不可用」该让人做什么。必须能直接照做，不能只说「不可用」 */
export const UNAVAILABLE_HINT = {
  quota: '去这个站充值，充完不用重启网关',
  budget: '这一单的上下文或输出太大，缩小一点就过',
  'rate-limit': '站点账号池被限流，等它到点自己恢复；急用就换一条供给',
  'model-missing': '这个分组里没有该模型：换分组或换站才治本',
  'protocol-unsupported': '这条供给不提供该接口：换 chat 走，或换一条供给',
  'error-rate': '近期真实请求成片失败，网关先避开它，10 分钟后自动重试',
}

/** 某一类的「原因 + 怎么办」；未知类型给一句兜底而不是空白 */
export function describeUnavailable(kind) {
  return {
    label: UNAVAILABLE_LABEL[kind] || '暂时不可用',
    hint: UNAVAILABLE_HINT[kind] || '等一会儿会自动重试',
  }
}

/** 上游自己说的等待时长上下限：比本地拍的数可信，但别信到离谱 */
const RETRY_AFTER_MIN_MS = 30 * 1000
const RETRY_AFTER_MAX_MS = 6 * 3600 * 1000

/**
 * 从上游错误文案里抠「还要等多久」。
 *
 * 有的站点/模型是真 5 小时冷却，本地拍的 5 分钟只会反复撞同一个 429；
 * 反过来上游说「30 秒后重试」时硬等 5 分钟也是白等。认这几种写法（覆盖
 * one-api / new-api / Sub2API 常见文案）：
 *   retry after 300 / retry_after: 300 / "try again in 5 hours" /
 *   "请 5 分钟后再试" / "300 秒后重试" / "5小时后重置"
 *
 * 只在「等/再试/重试/重置/限流」语境里才算，避免把耗时、token 数当冷却。
 *
 * @returns {number} 毫秒；认不出来给 0（调用方回落到本地表）
 */
export function retryAfterFromText(message) {
  const text = String(message || '')
  if (!text) return 0
  const clamp = (ms) =>
    Number.isFinite(ms) && ms > 0
      ? Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, Math.round(ms)))
      : 0

  // 结构化的数字字段最可信：retry_after / retryAfter / reset_after（秒）
  const field = text.match(/retry[_\s-]?after["'\s:=]+(\d+)|reset[_\s-]?after["'\s:=]+(\d+)/i)
  if (field) return clamp(Number(field[1] ?? field[2]) * 1000)

  const contextual = /retry|try\s*again|again\s*in|reset|cooldown|wait|稍后|再试|后重试|后重置|冷却|限流|排队/i.test(
    text,
  )
  if (!contextual) return 0

  const unit = text.match(
    /(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?|小时|分钟|秒)/i,
  )
  if (!unit) return 0
  const n = Number(unit[1])
  const u = unit[2].toLowerCase()
  const ms = /^(hour|hr)/.test(u) || u === '小时'
    ? n * 3600 * 1000
    : /^(min|m$)/.test(u) || u === '分钟'
      ? n * 60 * 1000
      : n * 1000
  return clamp(ms)
}

/**
 * @param {string} message 上游错误文本（探针的 error 字段或网关的失败原因）
 * @returns {{kind: 'quota'|'budget'|'model-missing'|'rate-limit'|null,
 *            countsAsOutage: boolean, retryAfterMs: number}}
 *          retryAfterMs 是上游自己说的等待时长（认不出来为 0，调用方按类型兜底）
 */
export function classifyFailure(message) {
  const text = String(message || '')
  for (const rule of RULES) {
    if (rule.test.test(text)) {
      return { kind: rule.kind, countsAsOutage: false, retryAfterMs: retryAfterFromText(text) }
    }
  }
  return { kind: null, countsAsOutage: true, retryAfterMs: 0 }
}

/**
 * 某类失败的等待截止时间（毫秒时间戳）；未知类型没有等待窗口。
 * upstreamMs（上游自己给的时长）优先于本地表——有的模型真的冷却 5 小时。
 */
export function cooldownUntil(kind, atMs, upstreamMs = 0) {
  if (!Number.isFinite(atMs)) return 0
  const ms = Number(upstreamMs) > 0 ? Number(upstreamMs) : UNAVAILABLE_COOLDOWN_MS[kind]
  if (!ms || !Number.isFinite(ms)) return 0
  return atMs + ms
}
