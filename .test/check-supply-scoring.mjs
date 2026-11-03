/**
 * 供给侧判定回归测试：把 2026-11-03 那次事故的每个环节钉死。
 *
 * 事故链：routeTarget 未定义 → 507 次假失败被记成站点故障 → 4 条供给可用率 0
 * → 封禁 10 分钟 → 全部供给不可用 → 客户端看到 502，而站点后台一切正常。
 *
 * 这个测试不依赖网络，全部用纯函数 + 临时数据目录。
 * 用法：node .test/check-supply-scoring.mjs
 */
import assert from 'node:assert/strict'
import { classifyFailure, isLocalDefect, trafficDelta, kindEntryOf } from '../core/failure.js'
import { scoreOffers, FAIL_RATE_COOLDOWN_MS } from '../core/score.js'
import { admissionOf, admissionTags, isTooSlow, blockedTextOf } from '../core/router.js'

let failed = 0
const ok = (cond, msg, extra) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failed += 1; console.error(`  ✗ ${msg}${extra === undefined ? '' : `  ← ${extra}`}`) }
}

// ---------------------------------------------------------------- [1] 本地缺陷不入站点账
console.log('[1] 网关自身错误 / 本机网络不得记成站点故障')
{
  const local = [
    'ReferenceError: routeTarget is not defined',
    'routeTarget is not defined',
    'TypeError: Cannot read properties of undefined (reading id)',
    'Cannot read properties of null',
    '连接失败（ECONNREFUSED）：http://127.0.0.1:4319',
    '连接失败（ENOTFOUND）：http://127.0.0.1:9/v1',
    'getaddrinfo EAI_AGAIN localhost',
    'Formal ManageAPI unavailable at 127.0.0.1:4319',
    'ERR_HTTP_HEADERS_SENT',
  ]
  for (const text of local) {
    const r = classifyFailure(text)
    ok(r.localDefect === true && r.countsAsOutage === false, `本地缺陷被识别：${text.slice(0, 42)}`, `local=${r.localDefect} outage=${r.countsAsOutage}`)
  }
  // 真实上游故障必须照旧计入——不能因为加白名单就把真故障洗白
  for (const text of ['HTTP 500 internal error', 'HTTP 502 bad gateway', 'socket hang up', '请求超时（15000ms）', '返回的不是 JSON：<html>']) {
    const r = classifyFailure(text)
    ok(r.localDefect === false && r.countsAsOutage === true, `真实故障仍计分：${text.slice(0, 30)}`)
  }
  // ★ 反向陷阱（2026-11-03 审计抓到）：
  // 网关把上游错误正文原样拼进 `HTTP ${status} ${text}`，所以上游自己的 500
  // 完全可能带着「Cannot read properties」「ECONNREFUSED」这类字样。第一版用
  // 大正则判断地猜全文，会把它们判成我方缺陷 → 不计 fail → 真故障被洗白。
  // 判据必须是结构：以 HTTP 状态码开头 = 上游真的回了响应 = 算它的账。
  const upstreamBody = [
    'HTTP 500 {"error":{"message":"Cannot read properties of undefined"}}',
    'HTTP 500 backend said: TypeError: x is not defined',
    'HTTP 502 connect ECONNREFUSED 100.64.1.9:443',
    'HTTP 504 getaddrinfo ENOTFOUND upstream.vendor.com',
    'HTTP 502 <html><body>502 Bad Gateway</body></html>',
  ]
  for (const text of upstreamBody) {
    const r = classifyFailure(text)
    ok(
      r.localDefect === false,
      `上游回了响应，正文再像 JS 报错也不算我方：${text.slice(0, 46)}`,
      `local=${r.localDefect}`,
    )
    ok(trafficDelta(false, text).fail === 1, `上游 5xx 仍记 fail：${text.slice(0, 40)}`)
  }
  // 连**远端**站点失败是那条供给不可达，同样是它的账；连本机失败才是我方
  ok(isLocalDefect('连接失败：connect ECONNREFUSED 127.0.0.1:4319') === true, '连本机失败 → 我方')
  ok(isLocalDefect('连接失败：connect ECONNREFUSED 203.0.113.9:443') === false, '连远端站点失败 → 站点的账')
  for (const text of ['HTTP 429 rate limit', 'HTTP 403 insufficient balance', 'model_not_found']) {
    const r = classifyFailure(text)
    ok(r.localDefect === false && r.countsAsOutage === false && Boolean(r.kind), `暂时不可用归类正确：${text.slice(0, 30)}`, r.kind)
  }
  ok(isLocalDefect('routeTarget is not defined') && !isLocalDefect('HTTP 503'), 'isLocalDefect 只认本地特征')
}

// ---------------------------------------------------------------- [2] 假失败不压低可用率
console.log('[2] 假失败不污染可用率（事故复现）')
{
  const now = Date.now()
  // 事故现场：507 次假失败被当成站点故障。修好之后这些错误在**写入时**就被
  // 拦掉（trafficDelta），根本不会变成 fail 计数，所以这里直接测写入口径。
  const local = trafficDelta(false, 'ReferenceError: routeTarget is not defined')
  ok(local.fail === 0 && local.localDefects === 1, '假失败写入时不计 fail', JSON.stringify(local))
  ok(Object.keys(local.kinds).length === 0, '假失败也不给任何冷却类型', JSON.stringify(local.kinds))

  const real = trafficDelta(false, 'HTTP 502 bad gateway')
  ok(real.fail === 1, '真实 502 仍然记 fail')

  const quota = trafficDelta(false, 'HTTP 403 insufficient balance')
  ok(quota.fail === 0 && quota.kinds.quota === 1, '余额不足记 kinds 不记 fail', JSON.stringify(quota))

  ok(trafficDelta(true, null).ok === 1, '成功记 ok')

  // 只有成功样本时，可用率必须完好
  const clean = scoreOffers([], {
    o1: { ok: 2, fail: 0, since: new Date(now).toISOString(), lastOkAt: new Date(now).toISOString(), kinds: {}, quality: { samples: 0, bad: 0 } },
  }, { now }).get('o1')
  ok(clean.availability === 1, `全成功时可用率 1.0（实际 ${clean.availability}）`, clean.availability)
  ok(clean.blocked === null, '全成功不封禁', JSON.stringify(clean.blocked))
}

// ---------------------------------------------------------------- [3] 准入不再放行坏供给
console.log('[3] 准入与界面口径必须一致')
{
  const now = Date.now()
  const iso = new Date(now).toISOString()
  const cases = [
    { ok: 0, fail: 3, expect: false, label: '0/3 全失败（只有流量、没探针）' },
    { ok: 1, fail: 3, expect: false, label: '1/3 可用率 25%' },
    { ok: 2, fail: 9, expect: false, label: '2/9 可用率 18%' },
    { ok: 9, fail: 1, expect: true, label: '9/1 可用率 90%' },
    { ok: 5, fail: 0, expect: true, label: '5/0 全部成功' },
  ]
  for (const c of cases) {
    const s = scoreOffers([], {
      o1: { ok: c.ok, fail: c.fail, since: iso, lastFailAt: iso, lastOkAt: c.ok > 0 ? iso : undefined, kinds: {}, quality: { samples: 0, bad: 0 } },
    }, { now }).get('o1')
    const row = { ...s, samples: (s.samples || 0) + (s.trafficSamples || 0), availability: s.availability, status: s.status, billingOnly: s.billingOnly, balanceDepleted: false, integrityFaults: s.integrityFaults || [] }
    const a = admissionOf(row, { allowUntrusted: false, maxTtftMs: 0 })
    ok(a.ok === c.expect, `${c.label} → 准入 ${a.ok}`, a.text)
    // 界面标签不能和准入结论相反
    const tags = admissionTags(row, { allowUntrusted: false, maxTtftMs: 0 })
    if (c.expect === false) ok(!tags.includes('ok'), `${c.label} 界面不标「正常」`, tags.join(','))
  }
  const none = scoreOffers([], {}, { now }).get('o1')
  const noRow = { ...none, samples: 0, availability: null, status: 'unknown', billingOnly: false, balanceDepleted: false, integrityFaults: [] }
  ok(admissionOf(noRow, { allowUntrusted: false, maxTtftMs: 0 }).ok === true, '完全没证据的供给仍允许探路（新站不能用就永远没证据）')

  // 半开状态：准入不放行（不跟健康供给抢流量），但界面**不能**标「可用」。
  // 2026-11-03 实测过这个矛盾：决策页那条半开供给显示绿色「可用」，
  // 网关却从不派活——用户只会以为路由坏了。
  const halfOpenRow = {
    ...noRow,
    status: 'healthy',
    availability: 0.82,
    failRate: 0.17,
    samples: 242,
    halfOpen: { kind: 'error-rate', since: now },
  }
  const halfAdm = admissionOf(halfOpenRow)
  ok(halfAdm.ok === false && halfAdm.kind === 'blocked', '半开：准入不放行（但走兜底阶梯仍可被试）', JSON.stringify(halfAdm))
  ok(String(halfAdm.text).includes('17%'), '半开文案点名失败率', halfAdm.text)
  const halfTags = admissionTags(halfOpenRow)
  ok(halfTags.includes('half-open'), '半开：界面有专属标签', halfTags.join(','))
  ok(!halfTags.includes('ok'), '半开：界面绝不标「可用」', halfTags.join(','))
}

// ---------------------------------------------------------------- [4] 恢复必须可达
console.log('[4] 封禁必须能自己结束（恢复条件可达）')
{
  const now = Date.now()
  const mk = (ok_, fail, failAgo, okAgo) => ({
    ok: ok_, fail, since: new Date(now - 1800000).toISOString(),
    lastFailAt: new Date(now - failAgo).toISOString(),
    ...(okAgo != null ? { lastOkAt: new Date(now - okAgo).toISOString() } : {}),
    kinds: {}, quality: { samples: 0, bad: 0 },
  })
  // 53 次失败之后 300 次成功，最近成功在 1 分钟前 → 必须可达恢复
  // （旧代码：解除条件挂在「成功晚于失败」上，而失败率按整个窗口算 →
  //  blocked + pendingRecovery 永久成立，等于永久拉黑，与「10 分钟后重试」矛盾）
  //
  // 但「可达」不等于「一次成功就洗白」：那又会退回「高失败率夹杂少量成功仍继续
  // 派活」。所以按四态断言：冷却时间已过 → blocked 必须解除，进入 half-open
  // （排在 RECOVERING 级、只在没有更好候选时才被试到），而不是直接判 recovered。
  const recovered = scoreOffers([], { o1: mk(300, 53, 900000, 60000) }, { now }).get('o1')
  ok(recovered.blocked === null, '冷却时间已过 → 不再按时间封禁（恢复可达）', JSON.stringify(recovered.blocked))
  ok(recovered.pendingRecovery === null, '也不再要求「攒够成功才解封」', JSON.stringify(recovered.pendingRecovery))
  ok(recovered.halfOpen?.kind === 'error-rate', '窗口内失败率仍超标 → 标记半开（不是直接洗白）', JSON.stringify(recovered.halfOpen))

  // 反面：一次成功不能推翻整段高失败率 —— 半开必须留着，让网关继续把它排在后面
  const oneSuccess = scoreOffers([], { o1: mk(1, 53, 900000, 1000) }, { now }).get('o1')
  ok(oneSuccess.blocked === null && oneSuccess.halfOpen !== null, '一次成功不清账：仍处半开，不当作已恢复', JSON.stringify(oneSuccess.halfOpen))

  // 恢复真的完成的样子：窗口滚过、失败率降下来（旧失败不在窗口内）→ 彻底正常
  const fullyRecovered = scoreOffers([], {
    o1: { ok: 30, fail: 1, since: new Date(now - 600000).toISOString(), lastFailAt: new Date(now - 300000).toISOString(), lastOkAt: new Date(now - 60000).toISOString(), kinds: {}, quality: { samples: 0, bad: 0 } },
  }, { now }).get('o1')
  ok(fullyRecovered.blocked === null && fullyRecovered.halfOpen === null, '失败率回落后回到正常（四态里最末的 recovered）', JSON.stringify(fullyRecovered.halfOpen))

  // 真在持续失败 → 仍封禁，且时长不超过一个冷却周期
  const active = scoreOffers([], { o1: mk(2, 20, 30000, null) }, { now }).get('o1')
  ok(active.blocked !== null && active.blocked.kind === 'error-rate', '持续失败仍然封禁', JSON.stringify(active.blocked))
  const left = active.blocked ? active.blocked.until - now : 0
  ok(left > 0 && left <= FAIL_RATE_COOLDOWN_MS + 1000, `封禁时长不超过一个周期（实际 ${Math.round(left / 1000)}s）`, left)
}

// ---------------------------------------------------------------- [5] 文案说真话
console.log('[5] 封禁文案不得编造时间')
{
  const pending = blockedTextOf({ kind: 'error-rate' }, { pending: true })
  ok(/等一次成功调用确认恢复/.test(pending), '待复测明确说「等成功确认」，不编分钟数', pending)
  // 注意 hint 里自带「10 分钟后自动重试」这句固定文案（failure.js 的 UNAVAILABLE_HINT），
  // 它属于「怎么办」的说明而不是「还剩多久」的承诺，所以只断言不出现「N 分钟后自动重试：」式的假倒计时。
  ok(!/：\s*\d+ 分钟后自动重试/.test(pending), '待复测不出现假倒计时', pending)
  const expired = blockedTextOf({ kind: 'error-rate', until: Date.now() - 60000 })
  ok(!/1 分钟后/.test(expired), '剩余为负时不显示「1 分钟」', expired)
  const active = blockedTextOf({ kind: 'error-rate', until: Date.now() + 5 * 60000 })
  ok(/约 5 分钟后自动重试/.test(active), '剩余 5 分钟如实显示', active)
}

// ---------------------------------------------------------------- [6] 失败率阈值
console.log('[6] 失败率阈值：小样本靠「绝对失败数」挡住，不靠放宽比率')
{
  const now = Date.now()
  const iso = new Date(now).toISOString()
  const blockedAt = (ok_, fail) => {
    const s = scoreOffers([], { o1: { ok: ok_, fail, since: iso, lastFailAt: iso, kinds: {}, quality: { samples: 0, bad: 0 } } }, { now }).get('o1')
    return s.blocked !== null
  }
  // 当初「小流量站被过敏封禁」的真实成因不是 15% 这个比率，而是**假失败**：
  // 网关自己的 bug 被记成站点故障，于是几个小时就能攒出几十次根本不存在的失败
  // （见 core/failure.js#trafficDelta）。假失败在写入口被拦掉之后，比率门槛可以
  // 回到 15% —— 用宽阈值去兜记账缺陷，缺陷修好后就只剩「真坏了也不躲」。
  //
  // 真正保护低频站的是「绝对失败数 ≥ 5」那一条：一两次失败永远压不垮一条供给。
  ok(blockedAt(15, 5) === true, '20 样本 25% 失败封禁（5 次真故障该躲开了）')
  ok(blockedAt(180, 2) === false, '大样本只有 2 次失败不封禁（绝对失败数 < 5，不被小比例误伤）')
  ok(blockedAt(18, 2) === false, '20 样本 2 次失败不封禁（同上，低频不等于坏站）')
  // 20 样本 8 失败 = 40%：该封
  ok(blockedAt(12, 8) === true, '40% 失败封禁')
  // 大样本 20% 该封
  ok(blockedAt(800, 200) === true, '大样本 20% 失败封禁')
}

// ---------------------------------------------------------------- [7] 质量分不反向激励
console.log('[7] 质量分：证据越多不该越吃亏')
{
  const now = Date.now()
  const q = (samples, bad) => scoreOffers([], {
    o1: { ok: samples, fail: 0, since: new Date(now).toISOString(), lastOkAt: new Date(now).toISOString(), kinds: {}, quality: { samples, bad } },
  }, { now }).get('o1').quality
  // 全成功时质量必须是 1.0，且不随样本数变化。
  // 旧公式 (n-bad+1)/(n+2) 让 20 次全成功只有 0.988，比"没证据"的 1.0 还低——激励反向。
  const q1 = q(1, 0)
  const q20 = q(20, 0)
  const q100 = q(100, 0)
  ok(Math.abs(q20 - 1) < 1e-9, `20 次全成功质量 = 1.0（实际 ${q20}）`, q20)
  ok(Math.abs(q100 - 1) < 1e-9, `100 次全成功质量 = 1.0（实际 ${q100}）`, q100)
  ok(q20 >= q1, `证据再多也不下降（${q1} → ${q20}）`, `${q1} ${q20}`)
  const qBad = q(20, 4)
  ok(qBad < q20, `出现坏样本时质量下降（${qBad} < ${q20}）`, `${qBad} ${q20}`)
  // 单次坏样本就该体现出来，而不是被先验稀释掉
  const qOneBad = q(20, 1)
  ok(qOneBad < 1, `20 次里 1 次坏也该扣分（实际 ${qOneBad}）`, qOneBad)

  // ★ 反向陷阱（2026-11-04 实测抓到）：探针本身已经劣质时，
  // 真实侧出现坏样本会不会反而把质量「拉高」？
  // 旧实现把两类证据塞进同一个加权平均：
  //   探针 0.6687（指纹 5 次只对 3 次），真实全成功 → realGoodRate=null → 0.6687
  //   出现 1 个坏样本 → realGoodRate=0.95 参与加权 → 0.7417  ← 反而更高
  // 质量是「最差那块板」，任一类证据变差都不该让总分上升。
  const badProbes = Array.from({ length: 5 }, (_, i) => ({
    offerId: 'o_bad',
    ts: new Date(now - 60000 - i * 1000).toISOString(),
    ok: true,
    fingerprintOk: i < 3,
    truncated: i >= 3,
    billingInflated: i >= 3,
    ttftMs: 2000,
  }))
  const qBadProbe = (bad) => scoreOffers(badProbes, {
    o_bad: { ok: 20, fail: 0, since: new Date(now).toISOString(), lastOkAt: new Date(now).toISOString(), kinds: {}, quality: { samples: 20, bad } },
  }, { now }).get('o_bad').quality
  const clean = qBadProbe(0)
  const oneB = qBadProbe(1)
  const manyB = qBadProbe(5)
  ok(clean > 0 && clean < 1, `探针劣质、真实全成功 → 质量介于 0 与 1（实际 ${clean.toFixed(4)}）`, clean)
  ok(oneB < clean, `★ 加一条坏证据后质量必须下降，不能反升（${oneB.toFixed(4)} < ${clean.toFixed(4)}）`, `${clean} → ${oneB}`)
  ok(manyB < oneB, `坏证据越多越低（${manyB.toFixed(4)} < ${oneB.toFixed(4)}）`, `${oneB} → ${manyB}`)
}

// ---------------------------------------------------------------- [8] 首字口径
console.log('[8] 准入的慢速判定：真实证据可推翻单次探针')
{
  ok(isTooSlow({ ttftMs: 22365, stale: false, realTtftMs: 4200, realTtftSamples: 6 }, 6000) === false, '真实 6 次都 4.2s → 不判慢速（旧代码判慢速出局）')
  ok(isTooSlow({ ttftMs: 22365, stale: false, realTtftMs: 4200, realTtftSamples: 2 }, 6000) === true, '真实样本不足 → 仍按探针判慢速')
  ok(isTooSlow({ ttftMs: 22365, stale: false, realTtftMs: 24000, realTtftSamples: 10 }, 6000) === true, '真实也慢 → 判慢速')
  ok(isTooSlow({ ttftMs: 3000, stale: false }, 6000) === false, '探针就快 → 不判慢速')
  ok(isTooSlow({ ttftMs: 9000, stale: true }, 6000) === false, '评分过期 → 不拿旧首字判慢速')
  ok(isTooSlow({ ttftMs: 9000, stale: false }, 0) === false, '门槛为 0（不限）→ 不判慢速')
}

// ---------------------------------------------------------------- [9] kinds 的两种形状
console.log('[9] traffic.kinds 合并：老库裸数字与新格式对象都要能累加')
{
  // 老库是 {quota: 3}，新格式是 {quota: {n:3, lastAt}}。两处写入点（addTraffic 累加、
  // 去重合并）以前都直接做加法：对象相加得 "[object Object]"，老数字上写 .n 直接抛
  // TypeError（整批流量不落盘）。kindEntryOf 是唯一口径，这里把它钉死。
  const fromNumber = kindEntryOf(3)
  ok(fromNumber.n === 3 && fromNumber.lastAt === null, '裸数字升成对象并保留次数（不清零）', JSON.stringify(fromNumber))
  const fromObject = kindEntryOf({ n: 4, lastAt: '2026-11-03T10:00:00.000Z' })
  ok(fromObject.n === 4 && fromObject.lastAt === '2026-11-03T10:00:00.000Z', '对象原样读出')
  ok(kindEntryOf(undefined).n === 0 && kindEntryOf(null).n === 0, '缺失当 0，不炸')
  ok(kindEntryOf({ n: 'x' }).n === 0, '坏值当 0，不产生 NaN')
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)