/**
 * 故障研判：一次真实请求结束后，判断「用户到底受没受影响」，再决定要不要惊动自动路由。
 *
 * 为什么必须独立于探针：探针是抽样体检（几分钟戳一次、问固定题），它证明不了
 * 「此刻这个站能不能干活」。而每一次真实调用本身就是运行现场——真实故障的证据
 * 等级高于探针。这套东西就是现场取证 + 定级。
 *
 * 三级影响（唯一口径，前端/上报/日志都吃这一份）：
 *   none     —— 用户完全无感。换站成功了、零内容断流后重放成功了、多转了一轮但拿到了。
 *               这一类**绝不能上报**：自动路由一收到故障就会把供给剔除十分钟，
 *               拿无感故障去报，等于让它在健康供给之间瞎折腾，比不报更糟。
 *   degraded —— 用户拿到了结果，但明显变差：半截回答、首字慢了几倍、思考被偷。
 *               这一类要**攒够才报**（窗口内多次才升级），单次抖动不报，否则会抖。
 *   blocked  —— 用户真的没拿到东西：全部候选失败、流断在半中间。
 *               这一类**立即报**，一次就够——用户已经看到了。
 *
 * 关键取舍：宁可晚一拍上报，也不要误报。故障转移的代价是把一条可能健康的供给
 * 剔出十分钟；而「多转一小会」的代价只是几百毫秒。用户体验的天平偏向前者。
 */

/** 影响等级 */
export const IMPACT = { NONE: 'none', DEGRADED: 'degraded', BLOCKED: 'blocked' }

/** 升级上报的判定门槛：窗口内累计达到次数才报（把抖动滤掉） */
export const ESCALATE_WINDOW_MS = 10 * 60_000
/** degraded 需要攒几次才上报 */
export const DEGRADED_THRESHOLD = 2

/** 断流时用户已拿到的正文字数低于这个值，视为「没拿到东西」（blocked） */
export const PARTIAL_CHARS_THRESHOLD = 40

/**
 * 判一次请求的影响等级。
 *
 * @param {object} p
 * @param {'ok'|'stream-broken'|'failed'} p.outcome  网关记录的结局
 * @param {number} p.attempts        试了几条候选
 * @param {number} p.deliveredChars  断流时已经吐给客户端的正文字数
 * @param {boolean} p.recovered      是否最终拿到了完整结果（重试成功 / 换站成功）
 * @param {object} p.degradation     可选的降质证据（来自 anomaly/探针判定）
 * @param {number} p.degradation.ttftRatio        首字是基线的几倍
 * @param {boolean} p.degradation.fingerprintBad  指纹不符
 * @param {boolean} p.degradation.truncated       输出被截断
 * @param {boolean} p.degradation.thinkStolen     思考被偷
 */
export function assessRequestImpact({
  outcome,
  attempts = 1,
  deliveredChars = 0,
  recovered = false,
  degradation = null,
} = {}) {
  // ---- 拿到了完整结果
  if (outcome === 'ok' || recovered) {
    // 降质证据：拿到了但明显不对，用户可能会觉得「今天的模型变笨了/变慢了」
    const d = degradation || {}
    const badReason = d.fingerprintBad
      ? '指纹不符'
      : d.truncated
        ? '输出被截断'
        : d.thinkStolen
          ? '思考被偷'
          : d.ttftRatio && d.ttftRatio >= 2
            ? `首字慢 ${d.ttftRatio.toFixed(1)} 倍`
            : null
    if (badReason) {
      return {
        impact: IMPACT.DEGRADED,
        absorbed: true,
        reason: badReason,
        detail: '拿到结果但质量明显下降——用户不一定当场报错，但会觉得「不对劲」',
      }
    }
    return {
      impact: IMPACT.NONE,
      absorbed: attempts > 1,
      reason: attempts > 1 ? '换站后成功' : null,
      detail: attempts > 1 ? `静默换站了 ${attempts - 1} 次，用户无感` : '',
    }
  }

  // ---- 流式断在半中间
  if (outcome === 'stream-broken') {
    if (deliveredChars < PARTIAL_CHARS_THRESHOLD) {
      // 只吐了几个字（甚至一个字都没吐）：用户基本没拿到东西
      return {
        impact: IMPACT.BLOCKED,
        absorbed: false,
        reason: '断流且几乎没输出',
        detail: `已吐出 ${deliveredChars} 字就断了——用户看到的是「刚开口就没了」`,
      }
    }
    return {
      impact: IMPACT.DEGRADED,
      absorbed: false,
      reason: '回答被截断',
      detail: `已经吐出 ${deliveredChars} 字后断流——用户拿到了半截回答`,
    }
  }

  // ---- 全部候选失败：用户什么也没拿到
  return {
    impact: IMPACT.BLOCKED,
    absorbed: false,
    reason: '全部候选失败',
    detail: `试了 ${attempts} 条供给都没成功`,
  }
}

/**
 * 要不要向自动路由上报故障转移。
 *
 * @param {object} p
 * @param {object} p.impact            本次请求的 assessRequestImpact 结果
 * @param {Array}  p.history           该供给最近的研判记录 [{ at, impact }]
 * @param {number} p.now
 * @param {number} p.windowMs
 * @param {number} p.degradedThreshold
 * @param {boolean} p.alreadyReported  冷却期内是否已经报过同一个供给
 * @returns {{ escalate: boolean, reason: string }}
 */
export function shouldEscalate({
  impact,
  history = [],
  now = Date.now(),
  windowMs = ESCALATE_WINDOW_MS,
  degradedThreshold = DEGRADED_THRESHOLD,
  alreadyReported = false,
} = {}) {
  if (!impact || impact.impact === IMPACT.NONE) {
    return { escalate: false, reason: '用户无感，不值得让自动路由折腾' }
  }
  // 冷却期内已经报过：别重复轰炸（自动路由那边一条就剔十分钟）
  if (alreadyReported) {
    return { escalate: false, reason: '冷却期内已上报过，不重复打扰' }
  }
  if (impact.impact === IMPACT.BLOCKED) {
    return { escalate: true, reason: '用户真的没拿到结果，立即故障转移' }
  }
  // degraded：同一供给在窗口内攒够次数才升级（单次变慢可能只是抖一下）
  const recent = history.filter((h) => now - Date.parse(h.at) <= windowMs && h.impact !== IMPACT.NONE)
  const count = recent.length + 1
  if (count >= degradedThreshold) {
    return { escalate: true, reason: `窗口内第 ${count} 次降质，攒够了才报（避免抖动）` }
  }
  return { escalate: false, reason: `降质第 ${count} 次，还没到上报门槛（${degradedThreshold}）` }
}

/**
 * 把影响等级翻译成自动路由认识的 kind（自由文本，但保持稳定词表好做统计）。
 */
export function faultKindOf(impact, extra = '') {
  if (!impact) return 'runtime'
  if (impact.impact === IMPACT.BLOCKED) {
    if (/断流/.test(impact.reason || '')) return 'stream-broken'
    return 'all-candidates-failed'
  }
  if (impact.impact === IMPACT.DEGRADED) {
    if (/截断/.test(impact.reason || '')) return 'truncated-output'
    if (/指纹/.test(impact.reason || '')) return 'degraded-quality'
    if (/思考/.test(impact.reason || '')) return 'thinking-stolen'
    if (/首字/.test(impact.reason || '')) return 'slow'
    return 'degraded'
  }
  return extra || 'runtime'
}

/**
 * 上报保持期：blocked 给久一点（用户真受影响，别急着把坏供给放回来），
 * degraded 给短一点（可能只是一时抖动）。
 */
export function holdMinutesFor(impact) {
  if (!impact) return 10
  return impact.impact === IMPACT.BLOCKED ? 10 : 5
}
