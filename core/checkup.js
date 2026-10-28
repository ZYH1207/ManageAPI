/**
 * 一键体检：对指定模型的全部供给做一次「当场核实」，出一份体检报告。
 *
 * 和定时探针的区别（为什么要有这个东西）：
 *   - 定时探针是**抽样、分散、滞后**的：每小时挑几条，结果散落在评分表里；
 *   - 体检是**当场、全量、同一时刻**的：此刻这个模型的每条供给都在同一分钟里被核实，
 *     拿到的是可以横向对比的快照——「别家 3 秒它 20 秒」这种事只有同时测才看得出来。
 *
 * 用户说「我现在就觉得不对劲」时点这个按钮，30 秒内给结论。
 *
 * 本文件只做「证据 → 报告」的纯函数转换；真正发请求的编排在 daemon/checkup-runner.js。
 */

/** 体检项：每一项对应一种可核实的毛病 */
export const CHECK_ITEMS = [
  { key: 'reachable', name: '连通' },
  { key: 'fingerprint', name: '指纹' },
  { key: 'truncation', name: '截断' },
  { key: 'billing', name: '计费' },
  { key: 'cache', name: '缓存' },
  { key: 'modelListed', name: '模型在售' },
  { key: 'balance', name: '余额' },
]

/** 单个供给的体检判定 */
export function judgeOffer({ probe = null, modelListed = null, balance = null, lowBalanceThreshold = 1 } = {}) {
  const reasons = []
  let verdict = 'ok'
  const worse = (level) => {
    const rank = { ok: 0, warn: 1, bad: 2 }
    if (rank[level] > rank[verdict]) verdict = level
  }

  if (!probe || probe.ok === false) {
    worse('bad')
    reasons.push(`探不通：${probe?.error || '没有返回结果'}`)
    return { verdict, reasons }
  }

  // 指纹：最硬的降智证据（问了固定题，答错就是掉包）
  if (probe.fingerprintOk === false) {
    worse('bad')
    reasons.push(`指纹不符（答错固定题，疑似被掉包或降智）：${(probe.fingerprintRaw || '').slice(0, 60)}`)
  }
  // 截断：让它数到 120，没数到就是被掐了
  if (probe.truncated === true) {
    worse('bad')
    reasons.push(`输出被截断：${probe.truncationDetail || '没数到 120'}`)
  }
  // 计费虚报：上报的 prompt token 远大于本地估算
  if (probe.billingInflated === true) {
    worse('warn')
    reasons.push(`计费可疑：本地估算约 ${probe.requestTokens ?? '?'} token，站点上报 ${probe.promptTokens ?? '?'}`)
  }
  // 缓存：站点宣称支持却打不中，等于成本翻倍
  if (probe.cacheSupported === false) {
    worse('warn')
    reasons.push('这个站不支持 prompt 缓存：长上下文会被全额计费')
  }
  // 模型在不在售：列表里没有说明分组失效或模型下架
  if (modelListed === false) {
    worse('bad')
    reasons.push('站点的模型列表里没有这个名字（分组改过名或模型已下架）')
  }
  // 余额
  if (typeof balance === 'number' && balance < lowBalanceThreshold) {
    worse(balance <= 0 ? 'bad' : 'warn')
    reasons.push(
      balance <= 0
        ? `余额只剩 ${balance.toFixed(2)}：必定拒单，去这个站充值`
        : `余额只剩 ${balance.toFixed(2)}，随时可能拒单，建议尽快充值`,
    )
  }

  return { verdict, reasons }
}

/** 首字延迟的相对评价：只在同批有可比对象时说话 */
export function judgeSpeed(rows) {
  const withTtft = rows.filter((r) => typeof r.probe?.ttftMs === 'number' && r.probe.ttftMs > 0)
  if (withTtft.length < 2) return new Map()
  const sorted = [...withTtft].map((r) => r.probe.ttftMs).sort((a, b) => a - b)
  const fastest = sorted[0]
  const out = new Map()
  for (const r of withTtft) {
    const ratio = r.probe.ttftMs / fastest
    out.set(r.offerId, {
      ratio,
      note:
        ratio >= 3
          ? `首字 ${(r.probe.ttftMs / 1000).toFixed(1)}s，是最快的 ${ratio.toFixed(1)} 倍`
          : ratio >= 1.8
            ? `首字 ${(r.probe.ttftMs / 1000).toFixed(1)}s，偏慢`
            : `首字 ${(r.probe.ttftMs / 1000).toFixed(1)}s`,
    })
  }
  return out
}

const VERDICT_LABEL = { ok: '正常', warn: '有隐患', bad: '不可用' }

/**
 * 证据 → 体检报告。
 *
 * @param {object} opts
 * @param {string} opts.modelKey  体检针对的模型
 * @param {Array}  opts.rows      每条供给的原始证据
 *        [{ offerId, label, providerId, providerName, probe, modelListed, balance }]
 */
export function buildCheckupReport({ modelKey, rows = [], lowBalanceThreshold = 1, at = new Date().toISOString() } = {}) {
  const speed = judgeSpeed(rows)
  const judged = rows.map((row) => {
    const { verdict, reasons } = judgeOffer({
      probe: row.probe,
      modelListed: row.modelListed,
      balance: row.balance,
      lowBalanceThreshold,
    })
    return {
      ...row,
      verdict,
      verdictLabel: VERDICT_LABEL[verdict],
      reasons,
      speedNote: speed.get(row.offerId)?.note || null,
      ttftRatio: speed.get(row.offerId)?.ratio ?? null,
      ttftMs: row.probe?.ttftMs ?? null,
      latencyMs: row.probe?.latencyMs ?? null,
    }
  })

  // 排序：坏的最前面（问题先看见），同档按首字快慢
  const rank = { bad: 0, warn: 1, ok: 2 }
  judged.sort((a, b) => rank[a.verdict] - rank[b.verdict] || (a.ttftMs ?? 1e9) - (b.ttftMs ?? 1e9))

  // 报告级结论：和诊断引擎的输出同一个形状，前端可以直接混排
  const findings = []
  const okCount = judged.filter((j) => j.verdict === 'ok').length
  const badCount = judged.filter((j) => j.verdict === 'bad').length
  const warnCount = judged.filter((j) => j.verdict === 'warn').length

  for (const j of judged) {
    if (j.verdict === 'ok') continue
    findings.push({
      category: 'checkup',
      id: `checkup-${j.offerId}`,
      layer: j.reasons.some((r) => r.includes('余额')) ? 'site' : 'upstream',
      severity: j.verdict === 'bad' ? 'danger' : 'warn',
      title: `${j.label}：${VERDICT_LABEL[j.verdict]}`,
      detail: j.reasons.join('；'),
      evidence: {
        fingerprintOk: j.probe?.fingerprintOk ?? null,
        truncated: j.probe?.truncated ?? null,
        billingInflated: j.probe?.billingInflated ?? null,
        modelListed: j.modelListed,
        balance: j.balance,
        ttftMs: j.ttftMs,
      },
      action:
        j.verdict === 'bad'
          ? '把这条供给停用或降权；如果同一模型别家正常，问题就在这家站'
          : '继续观察；持续这样就降权',
    })
  }

  // 「只有一家能用」是体检才看得出来的结构性问题
  const usable = judged.filter((j) => j.verdict !== 'bad')
  if (judged.length > 1 && usable.length === 1) {
    findings.push({
      category: 'checkup',
      id: 'checkup-single-supply',
      layer: 'gateway',
      severity: 'warn',
      title: `这个模型只有 1 条供给还能用（共 ${judged.length} 条）`,
      detail: '没有备胎：这一条出问题时请求会直接失败，网关没有可换的站',
      evidence: { total: judged.length, usable: usable.length },
      action: '考虑再买一家，或把被停用的那条修好（充值/重新同步分组）',
    })
  }

  return {
    modelKey,
    at,
    rows: judged,
    findings,
    summary: {
      total: judged.length,
      ok: okCount,
      warn: warnCount,
      bad: badCount,
      items: CHECK_ITEMS,
    },
  }
}
