/**
 * 诊断引擎：把账本里的原始信号加工成「说人话、带证据、指去处」的结论。
 *
 * 为什么单独一个文件：错误指纹账本（errorbook）和供给表现时间序列（offerStats）
 * 回答的是「发生过什么」；用户要的是「所以呢」——问题出在哪一层、谁修、怎么修。
 * 归因规则全部是纯函数：输入账本 + 台账 + 余额历史，输出 findings[]，
 * 方便 mock 测试，也方便将来「一键体检」复用同一套规则。
 *
 * 每条结论的硬性要求（少一条就不许上架）：
 *   layer   —— 五层归因：client / network / gateway / site / upstream
 *   severity —— info / warn / danger
 *   evidence —— 可核对的具体数字（次数、时间、金额），不许只有形容词
 *   action   —— 用户现在能做什么（没有就写「无需处理」）
 */

import { detectAnomalies } from './anomaly.js'

/** 五层归因的标签与顺序（severity 排序用） */
export const LAYERS = {
  client: '客户端',
  network: '本机网络',
  gateway: '网关自身',
  site: '站点',
  upstream: '站点上游',
}

const SEV_ORDER = { danger: 0, warn: 1, info: 2 }

/** 断流绝对次数门槛：总量大、比例被稀释的真问题靠这条兜底（见 checkStreamBreaks） */
export const STREAM_BREAK_COUNT_FLOOR = 8

/** 小时桶 key 的小时数（'2026-10-28T08'） */
const hourNum = (h) => Number(String(h).slice(11, 13))
/** 小时桶属于哪一天（UTC 天，用于取同站前几天的基线） */
const dayOf = (h) => String(h).slice(0, 10)

/**
 * 规则①：余额耗尽 / 余额告急
 * 证据：账本里该站 quota 类指纹的次数 + 余额读数。两层都要有才定「耗尽」，
 * 只有次数没有余额读数的降级为「疑似」（怕误判，站方报错措辞不可信）。
 */
export function checkBalanceDrain({ errorbook = {}, providers = [], monitorBalance = [] } = {}) {
  const findings = []
  // 各站最近 6 小时内的 quota/rate-limit 错误数
  const since = Date.now() - 6 * 3600000
  const byProvider = new Map()
  for (const e of Object.values(errorbook)) {
    if (e.kind !== 'quota' && e.kind !== 'rate-limit') continue
    if (Date.parse(e.lastAt) < since) continue
    for (const [name, count] of Object.entries(e.providers || {})) {
      const cur = byProvider.get(name) || { quota: 0, rateLimit: 0, templates: [] }
      if (e.kind === 'quota') cur.quota += count
      else cur.rateLimit += count
      cur.templates.push(e.template)
      byProvider.set(name, cur)
    }
  }
  if (!byProvider.size) return findings

  const balanceOf = new Map(
    (monitorBalance || []).map((b) => [b.providerId, b]),
  )
  for (const p of providers) {
    const hit = byProvider.get(p.name)
    if (!hit) continue
    const balance = typeof p.quotaRemaining === 'number' ? p.quotaRemaining : balanceOf.get(p.id)?.balance
    const lowBalance = typeof balance === 'number' && balance < 1
    if (hit.quota >= 3 && lowBalance) {
      findings.push({
        id: `balance-${p.id}`,
        providerId: p.id,
        rootCause: true,
        layer: 'site',
        severity: 'danger',
        title: `「${p.name}」余额只剩 ${balance.toFixed(2)}，最近 6 小时拒了你 ${hit.quota} 单`,
        detail:
          '这是计费错（insufficient balance），不是限流也不是你的并发问题：账号钱包空了。' +
          '网关会把这类供给按余额不足处理（1 分钟后自动重试），不会误判成坏站。',
        evidence: { balance, quotaErrors: hit.quota, templates: hit.templates.slice(0, 2) },
        action: '去这个站充值；充完不用重启网关，1 分钟内网关会自己重新试',
      })
    } else if (hit.quota >= 5) {
      findings.push({
        id: `balance-suspect-${p.id}`,
        providerId: p.id,
        rootCause: true,
        layer: 'site',
        severity: 'warn',
        title: `「${p.name}」最近 6 小时报了 ${hit.quota} 次额度类错误`,
        detail: lowBalance
          ? `余额读数 ${balance}（偏低）`
          : '余额接口没读到数，无法确认是欠费还是站方账号池抖动',
        evidence: { quotaErrors: hit.quota, balance: balance ?? null },
        action: lowBalance ? '去这个站充值（余额低于 1 很容易随时拒单）' : '点开错误账本看原始报错，或隔一小时再观察',
      })
    }
    if (hit.rateLimit >= 10) {
      findings.push({
        id: `ratelimit-${p.id}`,
        providerId: p.id,
        rootCause: true,
        layer: 'site',
        severity: 'warn',
        title: `「${p.name}」最近 6 小时被限流 ${hit.rateLimit} 次`,
        detail: '限流是站方账号池在排队，不是你的并发太大；网关会按上游给的冷却时间避开它，到点自动复测',
        evidence: { rateLimitErrors: hit.rateLimit },
        action: '不用处理；要立刻恢复就换一条供给，或者等它到点（有的模型冷却 5 小时）',
      })
    }
  }
  return findings
}

/**
 * 规则②：并发自查——用户最爱猜的原因，每份诊断报告都应该主动排除/确认。
 * 报错时刻的实际并发 vs 同期平均并发：明显更高才算「和并发有关」。
 */
export function checkConcurrency({ offerStats = {} } = {}) {
  const buckets = Object.values(offerStats)
  if (buckets.length < 4) return [] // 样本太少不说话
  // 每个桶的并发近似 = 该小时处于失败状态的事件数占比（没有精确 in-flight 记录时的代理指标）
  const recent = buckets.filter((b) => Date.parse(`${b.hour}:00:00Z`) > Date.now() - 6 * 3600000)
  // 分母剔除客户端取消：那不是失败，会把这个比率抹平
  const served = (list) => list.reduce((a, b) => a + Math.max(0, (b.requests || 0) - (b.clientAborts || 0)), 0)
  const totalReq = served(recent)
  const totalErr = recent.reduce((a, b) => a + (b.broken || 0) + (b.failed || 0), 0)
  if (totalReq < 10) return []
  const errRate = totalErr / totalReq
  if (errRate < 0.1) return []
  // 与更早的窗口对比：错误率抬升才算新问题
  const older = buckets.filter((b) => {
    const t = Date.parse(`${b.hour}:00:00Z`)
    return t <= Date.now() - 6 * 3600000 && t > Date.now() - 48 * 3600000
  })
  const oldReq = served(older)
  const oldErr = older.reduce((a, b) => a + (b.broken || 0) + (b.failed || 0), 0)
  if (oldReq >= 10 && oldErr / oldReq >= errRate) return []
  return [
    {
      id: 'err-rate-up',
      layer: 'upstream',
      severity: 'warn',
      title: `近 6 小时失败率升到 ${(errRate * 100).toFixed(0)}%（${totalErr}/${totalReq}）`,
      detail: '错误集中在最近，更早的 48 小时没有这么高——问题出在站方，不是你的使用方式变了',
      evidence: { recentErrRate: errRate, recentReq: totalReq },
      action: '打开「错误账本」看是哪家站、什么错；如果集中在一家，先停用那家',
    },
  ]
}

/**
 * 规则③：断流聚集——探针测不到的质量问题。
 *
 * 两条口径缺一不可（2026-10-29 的教训）：
 *   比例  —— 断流率 ≥ 5% 且断流次数 ≥ 3：适用于样本大、站方整体在抖的情况
 *   次数  —— 断流 ≥ 8 次 且断流率 ≥ 0.8%：适用于“总量很大、比例被好请求稀释”的站
 *             现场：格子云 13/919 = 1.4%，用户真的连遭四五次，但比例永远上不去
 * 分母一律用 requests - clientAborts：客户端自己取消不是站方的错，算进分母
 * 会把真断流稀释掉（实测 144 次自动副任务超时就干过这事）。
 */
export function checkStreamBreaks({ offerStats = {}, offerById = null } = {}) {
  const byOffer = new Map()
  for (const b of Object.values(offerStats)) {
    const cur = byOffer.get(b.offerId) || { requests: 0, broken: 0, clientAborts: 0, gapMax: 0 }
    cur.requests += b.requests || 0
    cur.broken += b.broken || 0
    cur.clientAborts += b.clientAborts || 0
    cur.gapMax = Math.max(cur.gapMax, b.streamGapMax || 0)
    byOffer.set(b.offerId, cur)
  }
  const findings = []
  for (const [offerId, s] of byOffer) {
    const served = Math.max(0, s.requests - s.clientAborts)
    if (served < 20 || s.broken < 3) continue
    const rate = s.broken / served
    const byRate = rate >= 0.05
    const byCount = s.broken >= STREAM_BREAK_COUNT_FLOOR && rate >= 0.008
    if (!byRate && !byCount) continue
    const label = offerById?.get?.(offerId) || offerId
    findings.push({
      id: `stream-${offerId}`,
      offerId,
      layer: 'upstream',
      severity: rate > 0.15 ? 'danger' : 'warn',
      title: `${label} 断流 ${s.broken} 次（${(rate * 100).toFixed(1)}%，分母 ${served} 次已交付请求）`,
      detail:
        '断流 = 回答吐到一半上游把流掐了（或送出损坏的 SSE 帧）；探针测不出这类问题。' +
        (byCount && !byRate ? '这条供给总量很大，比例看着不高，但绝对次数已经够多了。' : ''),
      evidence: {
        broken: s.broken,
        requests: s.requests,
        clientAborts: s.clientAborts,
        served,
        rate,
        streamGapMaxMs: s.gapMax,
      },
      action: '在智能决策页把这条供给降权，或直接停用这家站',
    })
  }
  return findings
}

/**
 * 规则④：未归类的陌生错误——自动判诊的入口提示。
 * outage 指纹计数高但没有诊断结论的，提示用户「这条还没看懂，值得点开看」。
 * 将来做「用 key 去 ping」时，就是把这里的 pending 指纹排队跑判别实验、写回 lastDiagnosis。
 */
export function checkUnknownErrors({ errorbook = {} } = {}) {
  const pending = Object.values(errorbook).filter(
    (e) => e.kind === 'outage' && e.count >= 5 && !e.lastDiagnosis && Date.parse(e.lastAt) > Date.now() - 24 * 3600000,
  )
  if (!pending.length) return []
  const worst = pending.sort((a, b) => b.count - a.count)[0]
  return [
    {
      id: `unknown-${worst.id}`,
      layer: 'upstream',
      severity: 'info',
      title: `有一种报错还没看懂（${worst.count} 次）`,
      detail: `报错模板：${worst.template}`,
      evidence: { fingerprint: worst.id, count: worst.count, sample: worst.sample },
      action: '点开「错误账本」看原文；系统后续会对陌生报错自动做判别实验',
    },
  ]
}

/**
 * 归因收敛：多条错误同时出现时，别把根因和派生症状平铺给用户。
 *
 * 为什么必须做：一个站余额空了，会同时产出四种表象——
 *   余额不足 403、平台限流、真实失败率 15%、全局错误率抬升。
 * 四个结论平铺出来，用户看到天七个红点，反而不知道先修哪个；而实际上
 * 它们就是一件事。平铺 = 把「归因」退化成了「报警器」。
 *
 * 规则（保守，只并「必然同源」的）：
 *   - 根因（余额/限流）按站点认领；
 *   - 同一个站的「间歇抽风」「断流」归进它的根因——那些失败就是 403 本身；
 *   - 全局的错误率抬升，只要已经有根因能解释，就归进去（它本来就是个汇总指标）；
 *   - 速度、思考、缓存、输出变短**不并**：那是另一个病，就算同时发生也要单独看。
 *
 * 被并进去的放在根因的 related 里，前端可以展开看，信息不丢。
 */
const DERIVATIVE_ID = /^(intermittent-|stream-|err-rate-up)/

export function consolidateFindings(findings, offerMeta = new Map()) {
  // 先补上断流结论的 providerId（它的 offerId 已经带了，但需要站点才能归并）
  for (const f of findings) {
    if (!f.providerId && f.offerId) f.providerId = offerMeta.get(f.offerId)?.providerId || null
  }

  // 按站点找根因：一个站有多条根因时，取最严重的那条（danger 优先、其次更近的）
  const rootByProvider = new Map()
  const absorbedRoots = new Set()
  const sortedRoots = findings
    .filter((f) => f.rootCause && f.providerId)
    .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])
  for (const f of sortedRoots) {
    const cur = rootByProvider.get(f.providerId)
    if (!cur) {
      rootByProvider.set(f.providerId, f)
      continue
    }
    // 同一个站已经有更严重的根因：本条并进去（例：余额空的站往往同时在报限流）
    cur.related = cur.related || []
    cur.related.push({ title: f.title, detail: f.detail })
    absorbedRoots.add(f)
  }
  if (!rootByProvider.size) return { findings, folded: absorbedRoots.size }

  const kept = []
  let folded = absorbedRoots.size
  for (const f of findings) {
    if (absorbedRoots.has(f)) continue
    if (f.rootCause) {
      kept.push(f)
      continue
    }
    if (!DERIVATIVE_ID.test(f.id)) {
      kept.push(f)
      continue
    }
    // 全局汇总指标：只要已经有根因能解释这批失败，就别再单列一条
    if (f.id === 'err-rate-up') {
      const worst = [...rootByProvider.values()].sort(
        (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity],
      )[0]
      worst.related = worst.related || []
      worst.related.push({ title: f.title, detail: f.detail })
      folded += 1
      continue
    }
    // 站点级派生症状：归到该站根因下
    const root = f.providerId ? rootByProvider.get(f.providerId) : null
    if (!root) {
      kept.push(f)
      continue
    }
    root.related = root.related || []
    root.related.push({ title: f.title, detail: f.detail })
    folded += 1
  }
  return { findings: kept, folded }
}

/**
 * 汇总入口：跑全部规则 → 按严重度 + 层级排序。
 * 以后加规则就在这里加一行，前端不用动。
 */
export function diagnose({
  errorbook = {},
  offerStats = {},
  providers = [],
  monitorBalance = [],
  offerById = null,
  offerMeta = new Map(),
  scores = {},
  nowMs = Date.now(),
} = {}) {
  // 错误诊断：账本里已有的失败信号 → 结论
  const errorFindings = [
    ...checkBalanceDrain({ errorbook, providers, monitorBalance }),
    ...checkConcurrency({ offerStats }),
    ...checkStreamBreaks({ offerStats, offerById }),
    ...checkUnknownErrors({ errorbook }),
  ].map((f) => ({ category: 'error', ...f }))

  // 异常诊断：没报错但表现偏离基线（变慢 / 偷思考 / 关缓存 / 输出变短 / 间歇抽风）
  const anomalyFindings = detectAnomalies({ offerStats, offerMeta, scores, nowMs })

  const merged = [...errorFindings, ...anomalyFindings]
  // 先收敛（把同源症状归到根因下），再排序——否则被并掉的那些还会占位置
  const { findings, folded } = consolidateFindings(merged, offerMeta)
  for (const f of findings) {
    if (f.related && f.related.length) {
      f.detail = `${f.detail}（另有 ${f.related.length} 项症状由它引起）`
    }
  }
  findings.sort(
    (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || String(a.layer).localeCompare(String(b.layer)),
  )
  return {
    findings,
    summary: {
      counts: {
        danger: findings.filter((f) => f.severity === 'danger').length,
        warn: findings.filter((f) => f.severity === 'warn').length,
        info: findings.filter((f) => f.severity === 'info').length,
        error: findings.filter((f) => f.category === 'error').length,
        anomaly: findings.filter((f) => f.category === 'anomaly').length,
        // 被判为「同一个病的派生症状」而收进根因的条数
        folded,
      },
      at: new Date().toISOString(),
    },
  }
}
