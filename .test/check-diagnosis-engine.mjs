/**
 * 诊断引擎（core/diagnosis.js）纯函数测试。
 *
 * 场景直接取自 2026-10-28 真实排障：绿萝余额耗尽（42 次 403 + 余额 0.39）、
 * 秋站限流爆发、断流聚集、previous_response_id 陌生错误。
 *
 * 跑法：node .test/check-diagnosis-engine.mjs
 */
import assert from 'node:assert/strict'
import {
  diagnose,
  checkBalanceDrain,
  checkConcurrency,
  checkStreamBreaks,
  checkUnknownErrors,
  LAYERS,
} from '../core/diagnosis.js'
import { fingerprintError, applyErrorToBook } from '../core/error-fingerprint.js'

let n = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  n += 1
}
const eq = (a, b, label) => {
  assert.deepEqual(a, b, label)
  n += 1
}

const now = new Date()
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()
const H = (hAgo) => {
  const d = new Date(Date.now() - hAgo * 3600000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`
}

// 构造一本带真实指纹的账本
function makeBook(entries) {
  const book = {}
  for (const [text, providerName, offerId, count, lastAgoMs] of entries) {
    const fp = fingerprintError(text)
    for (let i = 0; i < count; i++) {
      applyErrorToBook(book, fp, { providerName, offerId, at: iso((lastAgoMs ?? 3600000) - i * 60000) })
    }
  }
  return book
}

// ---------------------------------------------------------------- 规则① 余额
{
  const book = makeBook([
    ['HTTP 403 {"error":{"message":"insufficient balance","type":"billing_error"}}', '绿萝', 'o_lv', 42],
  ])
  const providers = [{ id: 'p_lv', name: '绿萝', quotaRemaining: 0.39 }]
  const f = checkBalanceDrain({ errorbook: book, providers })
  ok(f.length === 1, '余额耗尽 → 恰好 1 条结论')
  ok(f[0].severity === 'danger', '余额耗尽 = danger')
  ok(f[0].layer === 'site', '层级=站点')
  ok(f[0].title.includes('0.39') && f[0].title.includes('42'), '结论带余额数字和次数')
  ok(f[0].detail.includes('并发'), '明确排除并发怀疑')
  ok(typeof f[0].action === 'string' && f[0].action.includes('充值'), '给出去处')

  // 只有次数、没有余额读数 → 降级为 warn 疑似
  const f2 = checkBalanceDrain({ errorbook: book, providers: [{ id: 'p_lv', name: '绿萝' }] })
  ok(f2.length === 1 && f2[0].severity === 'warn', '无余额读数 → 降级疑似')

  // 次数不足 → 不说话
  const book3 = makeBook([
    ['HTTP 403 {"error":{"message":"insufficient balance","type":"billing_error"}}', '绿萝', 'o_lv', 2],
  ])
  eq(checkBalanceDrain({ errorbook: book3, providers }).length, 0, '2 次不够下结论')

  // 错误是老的（>6h）→ 不说话
  const book4 = {}
  {
    const fp = fingerprintError('HTTP 403 {"error":{"message":"insufficient balance","type":"billing_error"}}')
    applyErrorToBook(book4, fp, { providerName: '绿萝', offerId: 'o', at: iso(7 * 3600000) })
  }
  eq(checkBalanceDrain({ errorbook: book4, providers }).length, 0, '6 小时前的错不算数')
}

// ---------------------------------------------------------------- 规则① 限流
{
  const book = makeBook([
    ['HTTP 429 {"error":{"message":"All available accounts are currently rate-limited. Please retry later."}}', '秋', 'o_q', 32],
  ])
  const f = checkBalanceDrain({ errorbook: book, providers: [{ id: 'p_q', name: '秋', quotaRemaining: 5 }] })
  ok(f.length === 1 && f[0].title.includes('限流'), '32 次 429 → 限流结论')
  ok(f[0].action.includes('不用处理') && f[0].action.includes('换一条供给'), '限流建议=不用处理 + 急用就换供给')
}

// ---------------------------------------------------------------- 规则② 并发自查
{
  // 近 6h 错误率 30%，更早 48h 只有 5% → 报「失败率抬升」
  const stats = {}
  for (let h = 1; h <= 5; h++) {
    stats[`o_a|${H(h)}`] = { offerId: 'o_a', hour: H(h), requests: 50, ok: 35, broken: 10, failed: 5, errors: {} }
  }
  for (let h = 10; h <= 40; h += 3) {
    stats[`o_a|${H(h)}`] = { offerId: 'o_a', hour: H(h), requests: 50, ok: 47, broken: 2, failed: 1, errors: {} }
  }
  const f = checkConcurrency({ offerStats: stats })
  ok(f.length === 1, '错误率抬升 → 1 条结论')
  ok(f[0].title.includes('失败率'), '结论说人话（失败率）')

  // 更早的窗口一样差 → 不说话（长期如此是常态，不是新问题）
  const stats2 = {}
  for (let h = 1; h <= 5; h++) {
    stats2[`o_a|${H(h)}`] = { offerId: 'o_a', hour: H(h), requests: 50, ok: 35, broken: 10, failed: 5, errors: {} }
  }
  for (let h = 10; h <= 40; h += 3) {
    stats2[`o_a|${H(h)}`] = { offerId: 'o_a', hour: H(h), requests: 50, ok: 30, broken: 15, failed: 5, errors: {} }
  }
  eq(checkConcurrency({ offerStats: stats2 }).length, 0, '一直是这个水平 → 不报抬升')

  // 请求太少 → 不说话
  eq(
    checkConcurrency({
      offerStats: { [`o|${H(1)}`]: { offerId: 'o', hour: H(1), requests: 3, ok: 2, broken: 1, failed: 0 } },
    }).length,
    0,
    '样本不足不说话',
  )
}

// ---------------------------------------------------------------- 规则③ 断流
{
  const stats = {}
  for (let h = 1; h <= 5; h++) {
    stats[`o_a|${H(h)}`] = { offerId: 'o_a', hour: H(h), requests: 20, ok: 18, broken: 2, failed: 0, streamGapMax: 8000, errors: {} }
  }
  const offerById = new Map([['o_a', '绿萝 · deepseek-v4.1-flash']])
  const f = checkStreamBreaks({ offerStats: stats, offerById })
  ok(f.length === 1, '断流率 10%（10/100）→ 1 条结论')
  ok(f[0].title.includes('deepseek') && f[0].title.includes('断流率'), '结论带供给人话名和断流率')
  ok(f[0].detail.includes('探针测不出'), '说明为什么探针没抓到')

  // 样本不足（<20 请求）不说话
  const s2 = {}
  s2[`o_b|${H(1)}`] = { offerId: 'o_b', hour: H(1), requests: 5, ok: 4, broken: 1, failed: 0, errors: {} }
  eq(checkStreamBreaks({ offerStats: s2 }).length, 0, '断流样本不足不说话')

  // 断流率 20% → danger
  const s3 = {}
  for (let h = 1; h <= 5; h++) {
    s3[`o_c|${H(h)}`] = { offerId: 'o_c', hour: H(h), requests: 20, ok: 16, broken: 4, failed: 0, errors: {} }
  }
  eq(checkStreamBreaks({ offerStats: s3 })[0].severity, 'danger', '断流率 20% → danger')
}

// ---------------------------------------------------------------- 规则④ 陌生错误
{
  const book = makeBook([
    ['HTTP 400 {"error":{"message":"previous_response_id is not available for this user","type":"invalid_request_error"}}', '秋', 'o_q', 75],
  ])
  const f = checkUnknownErrors({ errorbook: book })
  ok(f.length === 1, '陌生 outage 错误 ≥5 次 → 提示待判诊')
  ok(f[0].detail.includes('previous_response_id'), '结论里能看到报错模板')
  ok(f[0].severity === 'info', '陌生错误是 info 级（还没定性）')

  // 已诊断过（lastDiagnosis 有值）→ 不再提示
  for (const e of Object.values(book)) e.lastDiagnosis = { at: now.toISOString(), conclusion: '协议错配' }
  eq(checkUnknownErrors({ errorbook: book }).length, 0, '写回诊断结论后不再重复提示')
}

// ---------------------------------------------------------------- 汇总排序
{
  const book = makeBook([
    ['HTTP 403 {"error":{"message":"insufficient balance","type":"billing_error"}}', '绿萝', 'o_lv', 42],
    ['HTTP 400 {"error":{"message":"previous_response_id is not available for this user","type":"invalid_request_error"}}', '秋', 'o_q', 10],
  ])
  const stats = {}
  for (let h = 1; h <= 5; h++) {
    stats[`o_a|${H(h)}`] = { offerId: 'o_a', hour: H(h), requests: 20, ok: 18, broken: 2, failed: 0, errors: {} }
  }
  const r = diagnose({
    errorbook: book,
    offerStats: stats,
    providers: [{ id: 'p_lv', name: '绿萝', quotaRemaining: 0.39 }],
    offerById: new Map([['o_a', '绿萝 · deepseek-v4.1-flash']]),
  })
  ok(r.findings.length >= 3, `多规则同时出结论（实际 ${r.findings.length} 条）`)
  ok(r.summary.counts.danger >= 1, 'summary 统计 danger 数')
  ok(r.findings[0].severity === 'danger', 'danger 排最前')
  for (const f of r.findings) {
    ok(LAYERS[f.layer] !== undefined, `每条结论有合法层级（${f.id}）`)
    ok(f.evidence && typeof f.evidence === 'object', `每条结论带证据（${f.id}）`)
    ok(typeof f.action === 'string' && f.action.length > 3, `每条结论给去处（${f.id}）`)
  }
  // 空账本 → 干净输出
  const empty = diagnose({})
  eq(empty.findings.length, 0, '空账本 → 0 条结论')
  eq(empty.summary.counts.danger, 0, '空账本 summary 归零')
}

// ------------------------------------------------- 归因收敛（多条错误同时出现）
{
  // 现场：一个站同时犯「余额不足 + 限流」，还有探针健康却间歇失败、全局失败率抬升。
  // 不收敛的话用户会看到 5 个红点说同一件事（真实踩过），收敛后应该只剩 1 条根因。
  const book = makeBook([
    ['HTTP 403 {"error":{"message":"insufficient balance","type":"billing_error"}}', '绿萝', 'o_lv', 42],
    ['HTTP 429 {"error":{"message":"All available accounts are currently rate-limited. Please retry later."}}', '绿萝', 'o_lv', 15],
  ])
  const stats = {}
  for (let h = 1; h <= 3; h++) {
    stats[`o_lv|${H(h)}`] = { offerId: 'o_lv', hour: H(h), requests: 20, ok: 16, broken: 1, failed: 3, errors: {} }
  }
  for (let h = 10; h < 30; h += 3) {
    stats[`o_lv|${H(h)}`] = { offerId: 'o_lv', hour: H(h), requests: 20, ok: 20, broken: 0, failed: 0, errors: {} }
  }
  const meta = new Map([['o_lv', { label: '绿萝 · deepseek', modelKey: 'deepseek', providerId: 'p_lv' }]])
  const r = diagnose({
    errorbook: book,
    offerStats: stats,
    providers: [{ id: 'p_lv', name: '绿萝', quotaRemaining: 0.39 }],
    offerMeta: meta,
    scores: { o_lv: { status: 'healthy', routable: true } },
  })
  const root = r.findings.find((f) => f.id === 'balance-p_lv')
  ok(root, '根因（余额耗尽）保留')
  eq(r.findings.filter((f) => f.id === 'balance-p_lv').length, 1, '根因只有一条')
  ok(Array.isArray(root.related) && root.related.length >= 2, `派生症状收进根因（${root.related?.length} 项）`)
  ok(root.related.some((x) => x.title.includes('限流')), '限流被归进余额根因（同一个病）')
  ok(root.related.some((x) => x.title.includes('失败率')), '失败率抬升被归进根因')
  ok(root.detail.includes('症状'), '根因描述里点明「另有 N 项症状由它引起」')
  eq(r.findings.filter((f) => f.id.startsWith('ratelimit-')).length, 0, '限流不再单列一条')
  eq(r.findings.filter((f) => f.id === 'err-rate-up').length, 0, '全局失败率不再单列')
  eq(r.findings.filter((f) => f.id.startsWith('intermittent-')).length, 0, '间歇抽风不再单列')
  ok(r.summary.counts.folded >= 2, `summary 记录被收起的条数（${r.summary.counts.folded}）`)

  // 不同病不能并：速度、思考、缓存都是独立的病，就算同一个站也要分开看
  const stats2 = {}
  for (let h = 8; h < 26; h++) {
    stats2[`o_x|${H(h)}`] = { offerId: 'o_x', hour: H(h), requests: 20, ok: 20, broken: 0, failed: 0,
      ttftSum: 2000*20, ttftCount: 20, latencySum: 10000*20, latencyCount: 20,
      genOutSum: 500*20, genCount: 20, genTimeSum: 5000*20,
      inputTokens: 2000000, outputTokens: 100000, cachedTokens: 1800000, reasoningTokens: 40000,
      estCostSum: 20, estCostCount: 20, streamGapMax: 500, errors: {} }
  }
  for (let h = 1; h <= 3; h++) {
    stats2[`o_x|${H(h)}`] = { offerId: 'o_x', hour: H(h), requests: 20, ok: 16, broken: 4, failed: 0,
      ttftSum: 8000*20, ttftCount: 20, latencySum: 10000*20, latencyCount: 20,
      genOutSum: 500*20, genCount: 20, genTimeSum: 5000*20,
      inputTokens: 2000000, outputTokens: 100000, cachedTokens: 1800000, reasoningTokens: 400,
      estCostSum: 20, estCostCount: 20, streamGapMax: 9000, errors: {} }
  }
  const r2 = diagnose({
    errorbook: {},
    offerStats: stats2,
    providers: [{ id: 'p_x', name: '秋', quotaRemaining: 5 }],
    offerMeta: new Map([['o_x', { label: '秋 · deepseek', modelKey: 'deepseek', providerId: 'p_x' }]]),
    scores: { o_x: { status: 'healthy' } },
  })
  ok(r2.findings.some((f) => f.id.startsWith('ttft-regress-')), '变慢单独成条（没有根因可归）')
  ok(r2.findings.some((f) => f.id.startsWith('think-stolen-')), '偷思考单独成条')
  ok(r2.findings.filter((f) => f.id.startsWith('intermittent-')).length === 1, '无根因时间歇抽风照常单列')

  // 没有根因时不做任何收敛（不能把无关的并起来）
  const r3 = diagnose({
    errorbook: makeBook([['HTTP 400 {"error":{"message":"weird unknown error xyz","type":"invalid_request_error"}}', '秋', 'o_q', 6]]),
    offerStats: stats2,
    providers: [{ id: 'p_x', name: '秋', quotaRemaining: 5 }],
    offerMeta: new Map([['o_x', { label: '秋 · deepseek', modelKey: 'deepseek', providerId: 'p_x' }]]),
    scores: { o_x: { status: 'healthy' } },
  })
  eq(r3.summary.counts.folded, 0, '没有根因 → 不收敛、不丢信息')
}

console.log(`check-diagnosis-engine: ${n} 项全部通过`)
