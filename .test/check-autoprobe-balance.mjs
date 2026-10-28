/**
 * 自动路由活跃期探针 + 余额标记 + 空回复徽章自检。
 *
 * 三件事（2026-10-28 需求）：
 *   1. 余额来自站点读数（持久化数据），探针测都不用测：欠费（≤0）直接红标
 *      「余额不足」并挡准入（和慢速同级，不受「放行可疑供给」影响）；
 *      低于预警阈值黄标「余额告警」，只提醒不拦人
 *   2. 轻量探针：lite 模式每模型只发 2 个请求（指纹+截断），完整模式 4 个；
 *      缓存保质期固定 2 小时（dueForCacheTest），过期后的下一次探测升级全量，
 *      手动探测永远全量
 *   3. 自动路由活跃期轮巡：来流量立刻全量探一轮（跳过欠费站），活跃期内
 *      每 60 分钟续一轮 Lite（实时性由漂移监视器吃真实流量保证），开工首拍全量
 *
 * 用法：node .test/check-autoprobe-balance.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { admissionOf, admissionTags, selectCandidates } from '../core/router.js'
import { probeModel } from '../core/probe.js'
import { dueForCacheTest, autoProbeShape } from '../daemon/probe-runner.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}
const has = (tags, kind) => tags.includes(kind)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ================================================================ [1] 余额标记

console.log('[1] 余额标记（持久化读数，不依赖探针）')

const offer = (id, providerId) => ({ id, providerId, modelKey: 'm1', upstreamName: 'm1', group: '' })
const provider = (id, patch = {}) => ({ id, name: id, baseUrl: 'http://x/v1', ...patch })
const credential = (id, providerId) => ({ id, providerId, group: '' })

function candidatesFor(providers, settings = {}, extra = {}) {
  return selectCandidates({
    offers: providers.map((p) => offer(`o_${p.id}`, p.id)),
    providers,
    credentials: providers.map((p) => credential(`c_${p.id}`, p.id)),
    scores: new Map(),
    benchmarks: {},
    settings,
    model: 'm1',
    ...extra,
  })
}

{
  // 欠费：红标 + 挡准入
  const rows = candidatesFor([provider('p1', { quotaRemaining: -5 })])
  ok(has(rows[0].tags ?? admissionTags(rows[0]), 'balance-empty'), '欠费 → 标「余额不足」')
  ok(admissionTags(rows[0]).includes('balance-empty'), 'admissionTags 含 balance-empty')
  const gate = admissionOf(rows[0])
  ok(!gate.ok && gate.kind === 'depleted', `欠费挡准入（kind=${gate.kind}）`)
  ok(String(gate.text).includes('余额不足'), '门禁文案是「余额不足」')
}
{
  // 欠费不受「放行可疑供给」影响：那是「可疑也愿意试」，欠费是「一定不行」
  const rows = candidatesFor([provider('p1', { quotaRemaining: 0 })], { allowUntrusted: true })
  ok(admissionOf(rows[0]).kind === 'depleted', 'allowUntrusted 开着欠费照样挡')
}
{
  // 预警：黄标，不拦人
  const rows = candidatesFor([provider('p1', { quotaRemaining: 1.2 })], { balanceWarnUsd: 1.5 })
  ok(admissionTags(rows[0]).includes('balance-warn'), '低于预警阈值 → 标「余额告警」')
  ok(!admissionTags(rows[0]).includes('balance-empty'), '预警不标「余额不足」')
  ok(admissionOf(rows[0]).ok, '预警不挡准入')
}
{
  // 余额充裕 / 没读过余额 / 阈值关掉：都不标
  const rich = candidatesFor([provider('p1', { quotaRemaining: 88 })], { balanceWarnUsd: 1.5 })
  ok(!admissionTags(rich[0]).includes('balance-warn'), '余额充裕不标')
  const unknown = candidatesFor([provider('p1', { quotaRemaining: null })], { balanceWarnUsd: 1.5 })
  ok(
    !admissionTags(unknown[0]).includes('balance-warn') &&
      !admissionTags(unknown[0]).includes('balance-empty'),
    '没读过余额（null）不标',
  )
  const off = candidatesFor([provider('p1', { quotaRemaining: 0.5 })], { balanceWarnUsd: 0 })
  ok(!admissionTags(off[0]).includes('balance-warn'), '阈值 0（关闭）不标预警')
}
{
  // 空回复徽章：只是给人看，准入不动
  const rows = candidatesFor([provider('p1', { quotaRemaining: 99 })], {}, {
    emptyRecent: new Map([['o_p1', 3]]),
  })
  ok(admissionTags(rows[0]).includes('empty-reply'), '近 1 小时空过 → 标「空回复」')
  ok(admissionOf(rows[0]).ok, '「空回复」不影响准入')
  const clean = candidatesFor([provider('p1', { quotaRemaining: 99 })])
  ok(!admissionTags(clean[0]).includes('empty-reply'), '没空过不标')
}

// ============================================================ [2] 轻量探针

console.log('[2] 轻量探针：lite 2 个请求，完整 5 个')

{
  let hits = 0
  const mock = createServer(async (req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    hits += 1
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw || '{}')
    const prompt = body?.messages?.[0]?.content || ''
    const usage = { prompt_tokens: 46, completion_tokens: 12, total_tokens: 58 }
    const answer = prompt.includes('7Q2K')
      ? '{"fp":"7Q2K","calc":391}'
      : Array.from({ length: 120 }, (_, i) => i + 1).join(',')
    if (body.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, index: 0 }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: answer }, finish_reason: 'stop' }], usage }))
    }
  })
  await new Promise((r) => mock.listen(0, '127.0.0.1', r))
  const port = mock.address().port
  try {
    const full = await probeModel({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm', timeoutMs: 5000 })
    ok(hits === 4, `完整探测发 4 个请求（实际 ${hits}）`)
    ok(full.fingerprintOk === true, '指纹通过')
    ok(full.truncated === false, '未截断')
    ok(typeof full.cacheHitRate === 'number', '完整模式测了缓存')

    hits = 0
    const lite = await probeModel({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm', timeoutMs: 5000, lite: true })
    ok(hits === 2, `lite 只发 2 个请求（实际 ${hits}）`)
    ok(lite.fingerprintOk === true && lite.truncated === false, 'lite 照常出指纹与截断结论')
    ok(lite.cacheSupported === null && lite.identityClaim === undefined, 'lite 跳过缓存；身份自述已彻底移除')
    ok(lite.spend.requests === 2, 'lite 花费账本记 2 个请求')
    ok(typeof lite.ttftMs === 'number', 'lite 仍带首字延迟')
  } finally {
    mock.close()
  }
}

// ====================================================== [3] 自动路由探针轮巡

console.log('[3] 自动路由活跃期轮巡')

// 环境必须在 import store/autoprobe 之前设好（动态 import，见下）
process.env.MANAGE_API_HOME = mkdtempSync(join(tmpdir(), 'manageapi-autoprobe-'))
process.env.MANAGE_API_AUTOPROBE_KICKOFF_MS = '30'
process.env.MANAGE_API_AUTOPROBE_ACTIVITY_MS = '400'
process.env.MANAGE_API_AUTOPROBE_INTERVAL_MS = '120'

const { mutate } = await import('../core/store.js')
const { createAutoRouteProber, AUTOPROBE_PASS_INTERVAL_MS } = await import('../daemon/autoprobe.js')

ok(AUTOPROBE_PASS_INTERVAL_MS === 60 * 60_000, '默认轮巡节奏是 60 分钟')

{
  await mutate((db) => {
    db.settings.autoRoute = { enabled: true }
    // p_empty 欠费（余额读数 ≤0）：轮巡必须跳过它；p_ok 正常
    db.providers.push(
      provider('p_empty', { quotaRemaining: -1 }),
      provider('p_ok', { quotaRemaining: 50 }),
    )
    db.offers.push(offer('o_e1', 'p_empty'), offer('o_ok1', 'p_ok'), offer('o_ok2', 'p_ok'))
    db.credentials.push(credential('c1', 'p_empty'), credential('c2', 'p_ok'))
  })

  const passes = []
  const runProbes = async ({ offerIds, lite, cache }) => {
    passes.push({ offerIds: [...offerIds], lite, cache })
    return offerIds.map((id) => ({ offerId: id, ok: true }))
  }
  const prober = createAutoRouteProber({ runProbes, logger: { info() {}, warn() {} } })

  // 安静时：tick 不探
  await prober.tick()
  ok(passes.length === 0, '没有流量就不探')

  // 来流量：kickoff 立刻全量探一轮，欠费站被跳过
  prober.noteActivity()
  await sleep(120)
  ok(passes.length === 1, `自动路由开始接流量 → 立刻探一轮（实际 ${passes.length} 轮）`)
  ok(passes[0].lite === false, '开工首拍是全量（基础分快照）')
  ok(passes[0].cache === 'auto', '轮巡走隔轮补测缓存（cache:auto）')
  ok(
    JSON.stringify(passes[0].offerIds.sort()) === JSON.stringify(['o_ok1', 'o_ok2']),
    `欠费站被跳过（实际 ${passes[0].offerIds.join(',')}）`,
  )

  // 活跃期内：不到节奏不续拍，到节奏（测试里 150ms = 60 分钟）续拍
  await prober.tick()
  ok(passes.length === 1, '不到节奏不重复探')
  await sleep(150)
  await prober.tick()
  ok(passes.length === 2, `到节奏续拍（实际 ${passes.length} 轮）`)

  // 流量停了：过了活跃窗口就不探；再来流量重新触发首轮
  await sleep(500)
  await prober.tick()
  ok(passes.length === 2, '流量停了就停探')
  prober.noteActivity()
  await sleep(120)
  ok(passes.length === 3, `重新来流量 → 重新触发首轮（实际 ${passes.length} 轮）`)
}

// ============================================================ [4] 定时探测隔轮补测缓存

// [3b] 短暂离开不重拍：kickoff 只看快照年龄（上一轮是否满一个间隔），不看「是否中断」
console.log('[3b] 短暂离开不重拍（kickoff 只看快照年龄）')
{
  process.env.MANAGE_API_AUTOPROBE_ACTIVITY_MS = '60'
  process.env.MANAGE_API_AUTOPROBE_INTERVAL_MS = '800'
  process.env.MANAGE_API_AUTOPROBE_KICKOFF_MS = '20'
  const { createAutoRouteProber: freshProber } = await import('../daemon/autoprobe.js')
  const passes2 = []
  const prober2 = freshProber({
    runProbes: async (opts) => {
      passes2.push(opts)
      return []
    },
    logger: { info() {}, warn() {} },
  })
  prober2.noteActivity()
  await sleep(80)
  ok(passes2.length === 1 && passes2[0].lite === false, '开工首拍全量（passes2[0]）')

  // 离开超过活跃窗口（60ms），但快照年龄（~100ms）远未满间隔（800ms）→ 不重拍
  await sleep(100)
  prober2.noteActivity()
  await sleep(60)
  ok(passes2.length === 1, `歇了一会儿回来：快照还新鲜，不重拍（实际 ${passes2.length} 轮）`)

  // 快照满了 interval：正常到点续 Lite——休息对节奏毫无影响
  // （noteActivity 保活再 tick：睡 750ms 早就超出 60ms 活跃窗口，不保活 tick 会直接返回）
  await sleep(750)
  prober2.noteActivity()
  await prober2.tick()
  ok(passes2.length === 2 && passes2[1].lite === true, `到点续 Lite，休息没多花一分钱（实际 ${passes2.length} 轮）`)

  // 逃生舱等外部路径踢了探针会拨表：下一轮从拨表时刻起算满一个间隔
  // （睡 700ms：拨表后年龄仍 < 800ms 间隔，不该有任何拍探针的动作）
  prober2.markPass()
  await sleep(700)
  prober2.noteActivity()
  await prober2.tick()
  ok(passes2.length === 2, `外部探针拨了表 → 一小时内不重复拍（实际 ${passes2.length} 轮）`)
}

console.log('[4] 缓存保质期固定 2 小时（dueForCacheTest）')
{
  const now = Date.now()
  const min = 60000
  const rec = (minutesAgo, cacheSupported) => ({
    ts: new Date(now - minutesAgo * min).toISOString(),
    cacheSupported,
  })
  ok(dueForCacheTest([], now) === true, '没历史 → 测')
  ok(dueForCacheTest([rec(119, true)], now) === false, '119 分钟前刚测过（保质期 2 小时）→ 跳')
  ok(dueForCacheTest([rec(121, true)], now) === true, '121 分钟前测的（已过期）→ 测')
  ok(
    dueForCacheTest([rec(90, true), rec(30, null)], now) === false,
    '最近的记录是 lite（cacheSupported=null）不算数，往前找到真测过的 → 跳',
  )
  ok(dueForCacheTest([rec(10, false)], now) === false, '测过但不支持缓存（cacheSupported=false）也算测过 → 跳')
  // 定时间隔 ≥ 2h 时每轮都过期 → 每轮全量（缓存跟定时走），是同一条规则的自然结果
  ok(dueForCacheTest([rec(125, true)], now) === true, '定时间隔 3 小时的站：每轮测时都已过期 → 每轮全量')

  console.log('[4b] 探测形态：赶上补测 4 发，没赶上 2 发（autoProbeShape）')
  ok(
    JSON.stringify(autoProbeShape(true, true)) === JSON.stringify({ lite: false, withCache: true }),
    '赶上补测 → 完整形态 4 发（轮巡的 lite 被升级）',
  )
  ok(
    JSON.stringify(autoProbeShape(false, true)) === JSON.stringify({ lite: true, withCache: false }),
    '没赶上 + 轮巡 → 维持 lite 2 发',
  )
  ok(
    JSON.stringify(autoProbeShape(false, false)) === JSON.stringify({ lite: false, withCache: false }),
    '没赶上 + 定时探测 → 2 发不带缓存',
  )
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
