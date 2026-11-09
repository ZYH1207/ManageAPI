/**
 * 诊断地基（错误指纹账本 + 供给表现时间序列）的纯函数测试。
 *
 * 样本全部来自 2026-10-28 真实排障中抓到的 8 种错误原文——
 * 归一化必须对真实世界的报错成立，而不是对着实验室里编的字符串成立。
 *
 * 跑法：node .test/check-diagnosis-capture.mjs
 */
import assert from 'node:assert/strict'
import {
  parseErrorPayload,
  messageFromBody,
  templateOf,
  fingerprintError,
  applyErrorToBook,
  pruneErrorbook,
} from '../core/error-fingerprint.js'
import {
  hourKey,
  estimateCostCny,
  applyRoutingToStats,
  pruneOfferStats,
  ensureDiagnosisKeys,
} from '../core/offer-stats.js'

let n = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  n += 1
}
const eq = (a, b, label) => {
  assert.deepEqual(a, b, label)
  n += 1
}

// ---------------------------------------------------------------- 指纹
// 今天真实抓到的 8 种错误原文（routing.failures / streamError 原样）
const SAMPLES = {
  prevRespId:
    'HTTP 400 {"error":{"message":"previous_response_id is not available for this user","type":"invalid_request_error"}}',
  balance: 'HTTP 403 {"error":{"message":"insufficient balance","type":"billing_error"}}',
  rateLimit:
    'HTTP 429 {"error":{"message":"All available accounts are currently rate-limited. Please retry later."}}',
  modelGroup:
    'HTTP 404 {"error":{"code":"model_not_found","message":"Model \\"deepseek-v4.1-flash\\" is not available for this group","type":"invalid_request_error"}}',
  fetchFailed: '连接失败：fetch failed',
  realm: "no usable account for realm 'intl': all are disabled, cooling down, expired or parked by the daily token limit",
  upstream502: 'HTTP 502 {"error":{"message":"Upstream stream ended without a terminal response event"}}',
  idleTimeout: '上游 120 秒无响应（首字超时）',
}

// 1. HTTP 前缀拆解
{
  const { code, body } = parseErrorPayload(SAMPLES.balance)
  eq(code, '403', 'HTTP 前缀 → 状态码')
  ok(body.startsWith('{"error"'), 'body 保留 JSON 原文')
  const { code: c2 } = parseErrorPayload(SAMPLES.fetchFailed)
  eq(c2, null, '无 HTTP 前缀 → code=null')
}

// 2. JSON 体抽人话
{
  eq(
    messageFromBody('{"error":{"message":"insufficient balance","type":"billing_error"}}').message,
    'insufficient balance',
    'error.message 优先',
  )
  eq(
    messageFromBody('{"error":{"code":"model_not_found","message":"Model X is not available"}}').hint,
    'model_not_found',
    'code 字段作为分类线索保留',
  )
  eq(messageFromBody('{"error":{"type":"billing_error"}}').message, '[billing_error]', '只有 type 也能留线索')
  ok(
    messageFromBody('{"error":{"message":"截断的 JSON…').message.length > 0,
    '截断的 JSON 不炸',
  )
}

// 3. 模板化：变量抹掉，句式保留
{
  eq(templateOf('Model "deepseek-v4.1-flash" is not available for this group'),
    'Model "…" is not available for this group', '带引号的模型名 → "…"')
  eq(templateOf('上游 120 秒无响应（首字超时）'), '上游 # 秒无响应（首字超时）', '数字 → #')
  eq(templateOf('余额 $0.39 不足，需 $1.2'), '余额 $# 不足，需 $#', '金额 → #')
}

// 4. 关键性质：不同模型名/不同站 → 同一指纹
{
  const a = fingerprintError(SAMPLES.modelGroup)
  const b = fingerprintError(
    'HTTP 404 {"error":{"code":"model_not_found","message":"Model \\"glm-5.3-flash\\" is not available for this group","type":"invalid_request_error"}}',
  )
  ok(a && b && a.id === b.id, '同病不同模型名 → 同指纹')
  eq(a.kind, 'model-missing', '404 模型不归组 → model-missing')
  const c = fingerprintError(SAMPLES.balance)
  eq(c.kind, 'quota', 'insufficient balance → quota')
  const d = fingerprintError(SAMPLES.rateLimit)
  eq(d.kind, 'rate-limit', '429 → rate-limit')
  const e = fingerprintError(SAMPLES.prevRespId)
  eq(e.kind, 'outage', '未归类错误暂入 outage（诊断阶段再细分）')
  eq(e.code, '400', '状态码保留')
  const f = fingerprintError(SAMPLES.idleTimeout)
  ok(f && f.kind === 'outage', '首字超时可归指纹')
  const g = fingerprintError(SAMPLES.realm)
  ok(g && g.template.includes("'…'"), "realm 报错里的单引号值 → '…'")
  eq(fingerprintError(''), null, '空串 → null')
  eq(fingerprintError(null), null, 'null → null')
  // 稳定性：同输入两次指纹一致（哈希确定性）
  eq(fingerprintError(SAMPLES.balance).id, fingerprintError(SAMPLES.balance).id, '指纹确定性')
}

// 5. 账本聚合
{
  const book = {}
  const t1 = '2026-10-28T07:41:05Z'
  const t2 = '2026-10-28T08:04:15Z'
  const fp = fingerprintError(SAMPLES.balance)
  applyErrorToBook(book, fp, { providerName: '绿萝', offerId: 'o_9f4bc096', at: t1 })
  applyErrorToBook(book, fp, { providerName: '绿萝', offerId: 'o_9f4bc096', at: t2 })
  applyErrorToBook(book, fp, { providerName: '秋', offerId: 'o_3cb287ae', at: t2 })
  const e = book[fp.id]
  eq(e.count, 3, '同指纹计数累加')
  eq(e.firstAt, t1, 'firstAt 是最早一次')
  eq(e.lastAt, t2, 'lastAt 是最新一次')
  eq(e.providers['绿萝'], 2, '按站计数')
  eq(e.offers['o_9f4bc096'], 2, '按供给计数')
  ok(e.sample === 'insufficient balance', '样本保留人话原文')
  eq(e.lastDiagnosis, null, 'lastDiagnosis 初始为 null（留给自动判诊写回）')
  // 断流原因也进账本
  const sb = fingerprintError('上游流中断（15 秒无数据）')
  applyErrorToBook(book, sb, { providerName: '北辰', at: t2 })
  ok(book[sb.id], '断流原因有指纹')
}

// 6. 账本瘦身
{
  const book = {}
  for (let i = 0; i < 10; i++) {
    applyErrorToBook(book, { id: `fp_${i}`, kind: 'outage', code: null, template: `t${i}`, message: `t${i}` }, {
      at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
    })
  }
  const now = Date.UTC(2026, 11, 1) // 12 月 1 日
  const { removed, kept } = pruneErrorbook(book, now, { maxEntries: 5, maxAgeDays: 90 })
  ok(removed >= 5 && kept <= 5, `瘦身生效（removed=${removed} kept=${kept}）`)
  // 90 天没再犯的会被清
  const book2 = {}
  applyErrorToBook(book2, { id: 'fp_old', kind: 'outage', code: null, template: 'old', message: 'old' }, {
    at: new Date(now - 100 * 86400000).toISOString(),
  })
  pruneErrorbook(book2, now, {})
  eq(Object.keys(book2).length, 0, '超过 90 天没犯的指纹被清')
}

// ------------------------------------------------------------ 时间序列
{
  const h = hourKey('2026-10-28T08:15:56.706Z')
  eq(h, '2026-10-28T08', '小时桶 key（UTC）')
  eq(hourKey(1769636156706), hourKey(new Date(1769636156706).toISOString()), '毫秒时间戳同口径')
}

// 7. 费用估算
{
  const offer = {
    priceUnit: 'per_mtok',
    inPrice: 2,
    outPrice: 8,
    currency: 'CNY',
    cacheReadPrice: 0.5,
    ratio: 1,
  }
  const usage = {
    prompt_tokens: 1000000,
    completion_tokens: 500000,
    prompt_tokens_details: { cached_tokens: 0 },
  }
  const c = estimateCostCny(offer, usage, { fxUsdCny: 7.2 }, {})
  ok(Math.abs(c - (2 + 4)) < 1e-9, `无缓存：1M×2 + 0.5M×8 = 6（实际 ${c}）`)
  const usage2 = { ...usage, prompt_tokens_details: { cached_tokens: 400000 } }
  const c2 = estimateCostCny(offer, usage2, { fxUsdCny: 7.2 }, {})
  ok(Math.abs(c2 - (1.2 + 0.2 + 4)) < 1e-9, `缓存命中：0.6M×2 + 0.4M×0.5 + 4 = 5.4（实际 ${c2}）`)
  eq(estimateCostCny(offer, null, {}, {}), null, '无 usage → null')
  eq(
    estimateCostCny({ priceUnit: 'per_mtok', inPrice: null, outPrice: 8 }, usage, {}, {}),
    null,
    '未定价 → null（别硬编 0）',
  )
  const perCall = estimateCostCny(
    { priceUnit: 'per_call', inPrice: 0.1, currency: 'CNY' },
    usage,
    {},
    {},
  )
  ok(perCall === 0.1, `按次计费 → 单次价（实际 ${perCall}）`)
}

// 8. 路由记录 → 时间序列聚合
{
  const stats = {}
  const offerById = new Map([
    ['o_ok', { id: 'o_ok', priceUnit: 'per_mtok', inPrice: 1, outPrice: 2, currency: 'CNY', ratio: 1 }],
    ['o_bad', { id: 'o_bad', priceUnit: 'per_mtok', inPrice: 1, outPrice: 2, currency: 'CNY', ratio: 1 }],
  ])
  const settings = { fxUsdCny: 7.2 }

  // 成功请求
  applyRoutingToStats(stats, {
    ts: '2026-10-28T08:00:00Z',
    chosenOfferId: 'o_ok',
    outcome: 'ok',
    latencyMs: 10000,
    ttftMs: 2500,
    streamGapMs: 1800,
    usage: { prompt_tokens: 100000, completion_tokens: 50000, prompt_tokens_details: { cached_tokens: 80000 }, completion_tokens_details: { reasoning_tokens: 5000 } },
  }, { offerById, settings, benchmarks: {} })

  // 断流请求（同一小时）
  applyRoutingToStats(stats, {
    ts: '2026-10-28T08:30:00Z',
    chosenOfferId: 'o_ok',
    outcome: 'stream-broken',
    streamError: '上游流中断（15 秒无数据）',
    latencyMs: 9000,
    ttftMs: 3000,
    usage: null,
  }, { offerById, settings, benchmarks: {} })

  // 失败尝试：记在被试供给名下
  applyRoutingToStats(stats, {
    ts: '2026-10-28T08:45:00Z',
    chosenOfferId: null,
    outcome: 'failed',
    failures: [
      { providerName: '绿萝', offerId: 'o_bad', error: 'HTTP 403 {"error":{"message":"insufficient balance","type":"billing_error"}}' },
      { providerName: '秋', offerId: 'o_bad', error: 'HTTP 429 {"error":{"message":"rate limited"}}' },
    ],
  }, { offerById, settings, benchmarks: {} })

  const key = 'o_ok|2026-10-28T08'
  const b = stats[key]
  ok(b, '成功+断流落同一小时桶')
  eq(b.requests, 2, 'requests 计数')
  eq(b.ok, 1, 'ok 计数')
  eq(b.broken, 1, 'broken 计数')
  eq(b.failed, 0, '选中供给的 failed 为 0')
  eq(b.ttftCount, 2, '断流也有首字，ttftCount=2')
  eq(b.streamGapMax, 1800, '流内最大停顿记录')
  eq(b.inputTokens, 100000, '输入 token 累加')
  eq(b.cachedTokens, 80000, '缓存 token 累加')
  eq(b.reasoningTokens, 5000, '推理 token 累加')
  ok(b.estCostCount === 1 && b.estCostSum > 0, `费用估算只记成功的（n=${b.estCostCount} sum=${b.estCostSum.toFixed(4)}）`)
  ok(b.errors['outage'] === 1, '断流原因进错误归类')

  const bad = stats['o_bad|2026-10-28T08']
  ok(bad, '失败尝试落在被试供给名下')
  eq(bad.failed, 2, 'failed 计数')
  eq(bad.requests, 0, '被试但未提交 → requests=0')
  eq(bad.errors['quota/403'], 1, '错误归类带 kind/状态码')
  eq(bad.errors['rate-limit/429'], 1, '429 归类')
}

// 9. 时序瘦身
{
  const stats = {}
  const old = new Date(Date.now() - 40 * 86400000).toISOString()
  applyRoutingToStats(stats, { ts: old, chosenOfferId: 'o_x', outcome: 'ok', latencyMs: 1 }, {})
  applyRoutingToStats(stats, { ts: new Date().toISOString(), chosenOfferId: 'o_y', outcome: 'ok', latencyMs: 1 }, {})
  const removed = pruneOfferStats(stats, Date.now())
  eq(removed, 1, '40 天前的桶被清')
  ok(stats['o_y|' + hourKey(Date.now())], '新桶保留')
}

// 10. ensureDiagnosisKeys 幂等
{
  const db = {}
  ensureDiagnosisKeys(db)
  db.errorbook.fp_x = { id: 'fp_x' }
  db.offerStats['k'] = {}
  ensureDiagnosisKeys(db)
  ok(db.errorbook.fp_x && db.offerStats.k, '已有数据不被清掉')
  eq(db.errorbook.fp_x.id, 'fp_x', '幂等不重建')
  ensureDiagnosisKeys({ errorbook: '坏类型' })
  ok(true, '坏类型不炸（重置为空对象）')
}

// 11. 缓存读/写必须走 wire.js#usageNumbers（唯一口径）
//
// 回归 2026-11-09：offer-stats 自己读 `prompt_tokens_details.cached_tokens`，
// 而 sub2api 系上游把命中放在 prompt_cache_hit_tokens / cache_read_input_tokens
// 里、prompt_tokens_details 那份是 0。真实库 12179 条明细里有 544 条命中被漏算，
// 北辰 · deepseek-4.1-flash 的长期评价写着命中 26.8%，按同一份账应该是 37.9%。
{
  const { aggregateLongTerm } = await import('../core/offer-stats.js')
  const offerById = new Map([
    ['o_sub2api', { id: 'o_sub2api', priceUnit: 'per_mtok', inPrice: 10, outPrice: 20, currency: 'CNY', ratio: 1 }],
  ])
  const stats = {}
  // 上游同时回「prompt_tokens_details.cached_tokens = 0」和真实命中 80000 的别名
  applyRoutingToStats(stats, {
    ts: '2026-11-09T08:00:00Z',
    chosenOfferId: 'o_sub2api',
    outcome: 'ok',
    latencyMs: 5000,
    ttftMs: 1000,
    usage: {
      prompt_tokens: 100000,
      completion_tokens: 1000,
      total_tokens: 101000,
      prompt_tokens_details: { cached_tokens: 0 },
      prompt_cache_hit_tokens: 80000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 10000,
      prompt_cache_write_tokens: 10000,
    },
  }, { offerById, settings: {}, benchmarks: {} })

  const b = stats['o_sub2api|2026-11-09T08']
  eq(b.cachedTokens, 80000, '缓存读取到别名里的 80000（不是 prompt_tokens_details 的 0）')
  eq(b.cacheCreationTokens, 10000, '缓存写取到别名里的 10000')
  eq(b.inputTokens, 100000, 'inputTokens 保持上游 prompt 原值（老桶口径不变）')
  eq(b.billedInputTokens, 100000, '计费输入 = 净值 10000 + 缓存读 80000 + 缓存写 10000')

  // 费用：净值 10000 按输入价、80000 按缓存读价（站点没公布 → 退回输入价）、
  // 10000 按缓存写价（同样退回输入价），输出 1000
  const cost = estimateCostCny(offerById.get('o_sub2api'), {
    prompt_tokens: 100000,
    completion_tokens: 1000,
    prompt_tokens_details: { cached_tokens: 0 },
    prompt_cache_hit_tokens: 80000,
  }, {}, {})
  // 缓存 80000 走缓存价（没公布 → 退回输入价 10），剩 20000 走输入价，输出 1000 走 20
  ok(
    Math.abs(cost - (0.02 * 10 + 0.08 * 10 + 0.001 * 20)) < 1e-9,
    `费用按别名里的缓存数算：0.02M×10 + 0.08M×10 + 0.001M×20（实际 ${cost}）`,
  )
  // 反证：旧实现只认 prompt_tokens_details.cached_tokens=0，会算成 0.1M 全按输入价
  ok(Math.abs(cost - 1.1) > 1e-9, '不是旧口径的 1.1（0.1M 全按输入价 + 输出）')

  // 长期评价：命中率分母用计费输入，不是 prompt 原值
  const meta = new Map([
    ['o_sub2api', { providerId: 'p1', providerName: '北辰', modelKey: 'deepseek-4.1-flash', group: '国模' }],
  ])
  const lt = aggregateLongTerm(stats, meta)
  const row = lt.byProvider[0]
  ok(
    Math.abs(row.cacheHitPct - 0.8) < 1e-9,
    `长期评价命中率 = 80000/100000 = 0.8（实际 ${row.cacheHitPct}）`,
  )
  eq(row.cachedTokens, 80000, '长期评价把分子也交出来（界面要能写清谁比谁）')
  eq(row.billedInputTokens, 100000, '长期评价把分母也交出来')

  // 老桶（没有 billedInputTokens）退回 inputTokens 兜底：旧口径「缓存 ÷ prompt」不变，
  // 升级后老数据不会忽然从 96% 跳到 99%
  const legacyStats = {
    'o_legacy|2026-11-09T08': {
      offerId: 'o_legacy', hour: '2026-11-09T08', requests: 1, ok: 1,
      inputTokens: 100000, cachedTokens: 96000,
    },
  }
  const legacyMeta = new Map([
    ['o_legacy', { providerId: 'p2', providerName: '秋', modelKey: 'm', group: 'g' }],
  ])
  const legacyRow = aggregateLongTerm(legacyStats, legacyMeta).byProvider[0]
  ok(
    Math.abs(legacyRow.cacheHitPct - 0.96) < 1e-9,
    `老桶没有 billedInputTokens 时按「缓存 ÷ prompt」兜底 = 0.96（实际 ${legacyRow.cacheHitPct}）`,
  )

  // anomaly 的窗口指标同一口径（诊断的「缓存被关」规则吃它）
  const { mergeWindow, windowMetrics } = await import('../core/anomaly.js')
  const m = mergeWindow([
    { requests: 1, ok: 1, inputTokens: 100000, cachedTokens: 80000, billedInputTokens: 100000 },
  ])
  eq(windowMetrics(m).cacheHit, 0.8, 'anomaly 的命中率也是缓存读 ÷ 计费输入')
  const legacyM = mergeWindow([{ requests: 1, ok: 1, inputTokens: 100000, cachedTokens: 50000 }])
  eq(windowMetrics(legacyM).cacheHit, 0.5, 'anomaly 对老桶按 inputTokens 兜底')
}

// 12. 成功率不得超过 100%（老库里重复记账的桶）
//
// 回归 2026-11-09：长评价卡片上「格子云」那一行成功率显示 101%。根因是分母
// 用 requests − clientAborts，而真实库有 11 个桶（2026-10-29 那批，来自修复
// 「客户端断开被误记成断流」的那次数据修理）满足 ok+broken+clientAborts > requests。
// 分母被撑小 → ok/分母 > 1。
{
  const { aggregateLongTerm, servedRequestsOf } = await import('../core/offer-stats.js')

  // 现场原值（o_a402f83d|2026-10-29T05）：requests 1044、ok 1038、broken 6、clientAborts 10。
  // 旧算法 1038/(1044-10) = 100.4%；其中 ok+broken+ca = 1054 > 1044，是记重复了
  const broken = { requests: 1044, ok: 1038, broken: 6, clientAborts: 10 }
  // 现场：requests 1044 − clientAborts 10 = 1034，但 ok+broken 就有 1044（重复记账），
  // 旧算法 1038/1034 = 100.4%。分母取两者之大 → 1044
  eq(servedRequestsOf(broken), 1044, '分母取「真的结过果的单」1044，不拿被撑小的 1034')
  const stats = { 'o_x|2026-10-29T05': { ...broken, offerId: 'o_x', hour: '2026-10-29T05' } }
  const meta = new Map([['o_x', { providerId: 'p1', providerName: '格子云', modelKey: 'm', group: 'g' }]])
  const row = aggregateLongTerm(stats, meta).byProvider[0]
  ok(row.okRate <= 1, `成功率不超过 100%（实际 ${(row.okRate * 100).toFixed(2)}%）`)
  ok(Math.abs(row.okRate - 1038 / 1044) < 1e-9, `成功率 = 1038/1044（实际 ${row.okRate}）`)

  // 正常桶不受影响：分母仍是 requests − clientAborts
  eq(servedRequestsOf({ requests: 100, ok: 96, broken: 2, clientAborts: 2 }), 98, '正常桶分母 100−2=98')
  // 不变量成立时两条公式一致
  eq(servedRequestsOf({ requests: 100, ok: 96, broken: 2, clientAborts: 2 }), 0 + 96 + 2, '与 ok+broken 一致')
  // 全是被取消的：分母 0，成功率 null 而不是除零
  eq(servedRequestsOf({ requests: 5, ok: 0, broken: 0, clientAborts: 5 }), 0, '全取消时分母为 0')
}

console.log(`check-diagnosis-capture: ${n} 项全部通过`)
