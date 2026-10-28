/**
 * 一键体检判定层（core/checkup.js）测试。
 *
 * 这里钉的是「什么样的证据得出什么判定」——真实打上游的部分在
 * daemon/checkup-runner.js，靠页面 e2e 验（不能为了测试去花用户的 token）。
 *
 * 跑法：node .test/checkup.mjs
 */
import assert from 'node:assert/strict'
import { judgeOffer, judgeSpeed, buildCheckupReport, CHECK_ITEMS } from '../core/checkup.js'

let n = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  n += 1
}
const eq = (a, b, label) => {
  assert.deepEqual(a, b, label)
  n += 1
}

/** 一条「健康」的探针结果 */
const healthyProbe = {
  ok: true,
  ttftMs: 2000,
  latencyMs: 8000,
  fingerprintOk: true,
  truncated: false,
  billingInflated: false,
  cacheSupported: true,
  promptTokens: 60,
  requestTokens: 55,
}

// ---------------------------------------------------------------- 单条判定
{
  const j = judgeOffer({ probe: healthyProbe, modelListed: true, balance: 10 })
  eq(j.verdict, 'ok', '什么都正常 → 正常')
  eq(j.reasons.length, 0, '正常时不给理由（不制造噪声）')
}

{
  // 指纹不符 = 降智，最硬的证据
  const j = judgeOffer({ probe: { ...healthyProbe, fingerprintOk: false, fingerprintRaw: '{"fp":"XXXX"}' } })
  eq(j.verdict, 'bad', '指纹不符 → 不可用')
  ok(j.reasons[0].includes('指纹'), '理由指出指纹问题')
  ok(j.reasons[0].includes('XXXX'), '理由带原始证据')
}

{
  const j = judgeOffer({ probe: { ...healthyProbe, truncated: true, truncationDetail: '最高数字 37' } })
  eq(j.verdict, 'bad', '截断 → 不可用')
  ok(j.reasons[0].includes('37'), '理由带截断细节')
}

{
  const j = judgeOffer({ probe: { ...healthyProbe, billingInflated: true, promptTokens: 500, requestTokens: 55 } })
  eq(j.verdict, 'warn', '计费虚报 → 有隐患（不至于不可用）')
  ok(j.reasons[0].includes('55') && j.reasons[0].includes('500'), '理由给两个对照数字')
}

{
  const j = judgeOffer({ probe: { ...healthyProbe, cacheSupported: false } })
  eq(j.verdict, 'warn', '不支持缓存 → 有隐患')
  ok(j.reasons[0].includes('缓存'), '理由说明缓存')
}

{
  const j = judgeOffer({ probe: healthyProbe, modelListed: false })
  eq(j.verdict, 'bad', '模型不在售 → 不可用')
  ok(j.reasons[0].includes('列表'), '理由指向模型列表')
}

{
  const j = judgeOffer({ probe: { ok: false, error: '连接失败：fetch failed' } })
  eq(j.verdict, 'bad', '探不通 → 不可用')
  ok(j.reasons[0].includes('fetch failed'), '理由带原始错误')
}

{
  const j = judgeOffer({ probe: healthyProbe, balance: 0.5, lowBalanceThreshold: 1 })
  eq(j.verdict, 'warn', '余额低于阈值 → 有隐患')
  ok(j.reasons[0].includes('0.50'), '理由带余额数字')

  const j2 = judgeOffer({ probe: healthyProbe, balance: 0, lowBalanceThreshold: 1 })
  eq(j2.verdict, 'bad', '余额 0 → 不可用')

  const j3 = judgeOffer({ probe: healthyProbe, balance: null })
  eq(j3.verdict, 'ok', '读不到余额不当成问题（不冤枉站）')
}

{
  // 多项同时命中：取最严重的
  const j = judgeOffer({
    probe: { ...healthyProbe, fingerprintOk: false, billingInflated: true },
    modelListed: false,
    balance: 0,
  })
  eq(j.verdict, 'bad', '多项命中取最严重')
  ok(j.reasons.length >= 4, `理由全部保留（${j.reasons.length} 条）`)
}

// ---------------------------------------------------------------- 速度横比
{
  const rows = [
    { offerId: 'a', probe: { ...healthyProbe, ttftMs: 1000 } },
    { offerId: 'b', probe: { ...healthyProbe, ttftMs: 5000 } },
    { offerId: 'c', probe: { ...healthyProbe, ttftMs: 1000 } },
  ]
  const speed = judgeSpeed(rows)
  eq(Math.round(speed.get('b').ratio), 5, '最慢的是最快 5 倍')
  ok(speed.get('b').note.includes('5.0 倍'), '结论带倍数')
  ok(speed.get('a').note.includes('1.0s'), '快的给绝对秒数')

  // 只有一条时不做横比（没有参照就不评价）
  eq(judgeSpeed([rows[0]]).size, 0, '只有一条时不做速度横比')
}

// ---------------------------------------------------------------- 报告
{
  const rows = [
    { offerId: 'o1', label: '绿萝 · deepseek', probe: { ...healthyProbe, ttftMs: 1000 }, modelListed: true, balance: 0.3 },
    { offerId: 'o2', label: '秋 · deepseek', probe: { ...healthyProbe, fingerprintOk: false }, modelListed: true, balance: 10 },
    { offerId: 'o3', label: '北辰 · deepseek', probe: { ok: false, error: '连接失败' }, modelListed: null, balance: 10 },
  ]
  const report = buildCheckupReport({ modelKey: 'deepseek', rows })

  eq(report.summary.total, 3, '总数')
  eq(report.summary.bad, 2, '两条不可用')
  eq(report.summary.warn, 1, '一条有隐患')
  eq(report.rows[0].verdict, 'bad', '坏的行排最前')
  ok(report.rows.every((r) => r.verdictLabel), '每行都有中文判定标签')
  ok(report.summary.items.length === CHECK_ITEMS.length, '报告带体检项清单')

  // findings 形状与诊断引擎一致（前端可混排）
  for (const f of report.findings) {
    ok(f.category === 'checkup', '结论归入 checkup 类')
    ok(['client', 'network', 'gateway', 'site', 'upstream'].includes(f.layer), `层级合法（${f.id}）`)
    ok(f.severity === 'danger' || f.severity === 'warn', `严重度合法（${f.id}）`)
    ok(f.evidence && typeof f.evidence === 'object', `带证据（${f.id}）`)
    ok(typeof f.action === 'string', `给去处（${f.id}）`)
  }

  // 三条里两条坏、只剩一条还能用 → 应报单供给风险（本例 o1 只是余额低，但还能用）
  const single = report.findings.find((f) => f.id === 'checkup-single-supply')
  ok(single, '只剩一条能用 → 报单供给风险')

  // 全部不可用 → 不该报「只剩一条」（那是「一条都没有」）
  const allBad = buildCheckupReport({
    modelKey: 'x',
    rows: [
      { offerId: 'a', label: 'A', probe: { ok: false, error: '连接失败' } },
      { offerId: 'b', label: 'B', probe: { ...healthyProbe, fingerprintOk: false } },
    ],
  })
  eq(allBad.findings.filter((f) => f.id === 'checkup-single-supply').length, 0, '全部不可用时不报单供给')

  // 健康的行不出现在 findings 里（报告只列问题）
  const healthyReport = buildCheckupReport({
    modelKey: 'x',
    rows: [
      { offerId: 'a', label: 'A', probe: healthyProbe, modelListed: true, balance: 10 },
      { offerId: 'b', label: 'B', probe: healthyProbe, modelListed: true, balance: 10 },
    ],
  })
  eq(healthyReport.findings.length, 0, '全部健康 → 零结论')
  eq(healthyReport.summary.ok, 2, '健康计数')
}

// ---------------------------------------------------------------- 单供给结构问题
{
  const rows = [
    { offerId: 'o1', label: '绿萝 · deepseek', probe: healthyProbe, modelListed: true, balance: 10 },
    { offerId: 'o2', label: '秋 · deepseek', probe: { ...healthyProbe, fingerprintOk: false }, modelListed: true, balance: 10 },
    { offerId: 'o3', label: '北辰 · deepseek', probe: { ok: false, error: '连接失败' }, modelListed: null, balance: 10 },
  ]
  const report = buildCheckupReport({ modelKey: 'deepseek', rows })
  const single = report.findings.find((f) => f.id === 'checkup-single-supply')
  ok(single, '只剩一条能用 → 报单供给风险')
  ok(single.title.includes('1 条供给'), '标题说明只剩一条')
  eq(single.layer, 'gateway', '这是网关层的结构问题（不是站坏了）')
}

// ---------------------------------------------------------------- 边界
{
  eq(buildCheckupReport({ modelKey: 'x', rows: [] }).findings.length, 0, '没有目标 → 空报告')
  eq(buildCheckupReport({ modelKey: 'x', rows: [] }).summary.total, 0, '没有目标时总数为 0')
}

console.log(`checkup: ${n} 项全部通过`)
