/**
 * 级联防护自检（纯函数，不联网）：
 *
 * 这三块防的是同一类事故——**局部故障被放大成全局故障**。
 * 本机在 2026-11-07 连着踩过三回，每一回用户看到的都是「全站都崩了」：
 *
 *   1. credential 冷却一过就三者皆无 → 自愈探测不选它、准入又硬拒 → 永久死锁
 *      （关掉定时探针后尤其致命：换好 Key 也不回来）
 *   2. modelKey 级故障上报无条件通配 → 一条上报打穿 5 个站 11 条供给
 *   3. 空回合 3 次就升级 faulty/avoid 30 分钟 → 抖动期间热门模型必然触发
 *
 * 用法：node .test/check-cascade-guards.mjs
 */
import { dampenFaultByCluster, judgeEmptyFault, FAULT_HITS_FOR_FAULTY } from '../core/fault-signal.js'
import { addFaultReport, faultMatcher } from '../core/failover.js'
import { scoreOffers, isRoutable } from '../core/score.js'
import { isGenerativeMediaModel } from '../daemon/probe-runner.js'
import { admissionOf, admissionOfScore } from '../core/router.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

const now = Date.now()
const agoIso = (ms) => new Date(now - ms).toISOString()
const HOUR = 3600000

console.log('[1] credential 不管失败多久，都必须仍能被自愈探测选中')
{
  // 冷却只有 10 分钟。一过就 blocked=null，而 pendingRecovery 若不含 credential
  // 也等于 null → scheduler 的 selfHealOnly 分支直接 return false，永不复测；
  // 准入那边按「样本 > 0 但没分母」判 no-evidence 硬拒，真实流量也到不了它。
  // 结果：供给永久消失，用户换好 Key 也不会回来。
  const mk = (msAgo) => [
    {
      offerId: 'cred',
      ok: false,
      ts: agoIso(msAgo),
      error: '预检未过（auth）：HTTP 403（Key 无效或无权限）',
      preflightLayer: 'auth',
    },
  ]
  for (const h of [0.2, 0.5, 2, 6]) {
    const r = scoreOffers(mk(h * HOUR), {}, { now }).get('cred')
    const selfHeal = Boolean(r.blocked || r.pendingRecovery || r.halfOpen)
    ok(selfHeal, `${h}h 前 auth 失败 → 仍满足自愈复测条件`)
  }

  // 证据超过 6 小时（DEFAULT_MAX_AGE_MS）会变 stale。stale 不走自愈路径，
  // 但准入对 stale 是**放行**的（「派一次真实调用就刷新了」），所以同样不死锁。
  // 这条断言钉的是「不死锁」这个结论本身，不是某个具体状态。
  const stale = scoreOffers(mk(24 * HOUR), {}, { now }).get('cred')
  ok(stale.status === 'stale', '24h 前 → 判 stale（证据过期）')
  const row = {
    ...stale,
    offer: { id: 'cred' },
    provider: { id: 'p' },
    allowUntrusted: false,
    integrityFaults: stale.integrityFaults || [],
    samples: stale.samples,
    availability: stale.availability,
    tooSlow: false,
    balanceDepleted: false,
    detour: null,
  }
  ok(admissionOf(row).ok === true, 'stale 的 credential 供给准入放行（下次真实调用即刷新，不锁死）')
}

console.log('[2] modelKey 级上报带 providerId 时只株连本站')
{
  const scoped = { reports: [] }
  addFaultReport(scoped, { modelKey: 'ds-flash', providerId: 'p-qiu', kind: 'empty-turn' })
  const m = faultMatcher(scoped)
  ok(m({ id: 'a', modelKey: 'ds-flash', providerId: 'p-qiu' }) === true, '本站同模型命中')
  ok(m({ id: 'b', modelKey: 'ds-flash', providerId: 'p-lvluo' }) === false, '别站同模型不被株连')
  ok(m({ id: 'c', modelKey: 'other', providerId: 'p-qiu' }) === false, '本站别的模型不被误伤')

  // 真·模型级（型号本身坏了，哪家接都一样）：不带 providerId 才允许跨站
  const globalOne = { reports: [] }
  addFaultReport(globalOne, { modelKey: 'ds-flash', kind: 'model-broken' })
  ok(
    faultMatcher(globalOne)({ id: 'b', modelKey: 'ds-flash', providerId: 'p-lvluo' }) === true,
    '不带 providerId 才跨站命中',
  )

  // offerId 精确命中，且不因带 providerId 而扩大
  const supply = { reports: [] }
  addFaultReport(supply, { offerId: 'o-1', providerId: 'p-qiu' })
  const ms = faultMatcher(supply)
  ok(ms({ id: 'o-1', modelKey: 'x', providerId: 'p-qiu' }) === true, 'offerId 命中该供给')
  ok(ms({ id: 'o-2', modelKey: 'x', providerId: 'p-qiu' }) === false, '同站同模型别的供给不连坐')
}

console.log('[3] 空回合升级 faulty 前，跨站同簇要降级')
{
  const faulty = judgeEmptyFault({ hits: FAULT_HITS_FOR_FAULTY, recovered: true, hadFallback: true })
  ok(faulty.level === 'faulty' && faulty.suggested === 'avoid', '孤立单站：仍是 faulty/avoid')

  const isolated = dampenFaultByCluster(faulty, 0)
  ok(isolated.verdict.level === 'faulty', '没有别的站也空 → 不改判')
  ok(isolated.clusterNote === null, '无降级说明')

  const clustered = dampenFaultByCluster(faulty, 2)
  ok(clustered.verdict.level === 'degraded', '另有 2 站也空 → 降级 degraded')
  ok(clustered.verdict.suggested === 'deprioritize', '降级后只降优先级、不剔除')
  ok(clustered.verdict.broadcast === true, '仍然广播（不静默吞掉）')
  ok(/另有 2 个站/.test(clustered.verdict.reason), '原因里说明是跨站同簇')

  // 本来就 degraded/notice 的不受影响
  const degraded = judgeEmptyFault({ hits: 1, recovered: false, hadFallback: true })
  ok(dampenFaultByCluster(degraded, 5).verdict.level === 'degraded', 'degraded 不被改判')
  const notice = judgeEmptyFault({ hits: 1, recovered: true, hadFallback: true })
  ok(dampenFaultByCluster(notice, 5).verdict.level === 'notice', 'notice 不被改判')
}

console.log('[4] 关闭定时探针后，任何被准入拒绝的供给都必须仍会被复测（无永久死锁）')
{
  // 2026-11-07 穷举 1008 种「失败类型 × 证据年龄 × 样本数」组合发现：
  // 只枚举 blocked/pendingRecovery/halfOpen 会漏掉「没有名字的拒绝态」——
  // unstable（可用率<80%）、degraded（指纹不符）、no-evidence（协议不支持 /
  // 我方缺陷被跳过但 samples 仍占位）三者皆无自愈字段。
  // 关掉定时探针后它们拿不到真实流量（准入拒），也永不被复测 → 永久卡死。
  //
  // 修法：scheduler 用 admissionOfScore 兜底——凡准入不放行的，都按复测节奏探。
  const mk = (count, err, layer) =>
    Array.from({ length: count }, (_, i) => ({
      offerId: 'x', ok: false,
      ts: new Date(now - (30 + i * 0.01) * 60000).toISOString(),
      error: err,
      ...(layer ? { preflightLayer: layer } : {}),
    }))

  const cases = [
    ['unstable（502 ×3）', mk(3, 'HTTP 502 upstream failed')],
    ['unstable（超时 ×3）', mk(3, 'The operation was aborted due to timeout')],
    ['no-evidence（协议不支持）', mk(1, 'HTTP 400 does not allow /v1/responses')],
    ['no-evidence（我方缺陷 ×5）', mk(5, 'Cannot read properties of undefined')],
    ['blocked（auth ×3）', mk(3, '预检未过（auth）：HTTP 403', 'auth')],
  ]
  for (const [name, rows] of cases) {
    const s = scoreOffers(rows, {}, { now }).get('x')
    const adm = admissionOfScore(s)
    const namedSelfHeal = Boolean(s.blocked || s.pendingRecovery || s.halfOpen)
    ok(!adm.ok, `${name} → 准入确实拒绝（${adm.kind}）`)
    ok(
      namedSelfHeal || !adm.ok,
      `${name} → 有复测路径（有名自愈=${namedSelfHeal}，兜底=${!adm.ok}）`,
    )
  }

  // 反向：健康的供给不该被兜底规则拉去反复复测（否则白烧额度）
  const healthy = scoreOffers(
    Array.from({ length: 5 }, (_, i) => ({
      offerId: 'h', ok: true,
      ts: new Date(now - (i + 1) * 60000).toISOString(),
      fingerprintOk: true, truncated: false, billingInflated: false,
      ttftMs: 100, latencyMs: 800,
    })),
    {}, { now },
  ).get('h')
  ok(admissionOfScore(healthy).ok === true, '健康供给准入放行')
}

console.log('[5] 生图/生成类模型不进例行探针（成本爆炸防护）')
{
  // 实测（本机 db，2026-11-07）：生图探针 1488 条成功仅 67 条（4.5%），
  // 却烧掉 32,995,096 output token —— 单条最高 1,203,821（图片以 base64
  // 塞在 output 里返回）。例行探针「测一次」就是真生成一张图。
  const media = [
    'gpt-image-2.6-flare', 'gpt-image-2', 'dall-e-3', 'flux-pro',
    'sdxl-turbo', 'midjourney-v6', 'mj_imagine', 'sora-2', 'veo-3',
    'kling-v2', 'runway-gen3', 'suno-v4', 'grok-imagine-image',
  ]
  for (const m of media) ok(isGenerativeMediaModel(m), `跳过生成类：${m}`)

  // 反向：对话/嵌入/语音模型必须照常探测，别误伤
  const normal = [
    'deepseek-v4.1-flash', 'gpt-6.1-sol', 'claude-opus-5-5',
    'glm-5.3-flash', 'kimi-k3', 'gemini-3.8-flash',
    'text-embedding-3-large', 'whisper-1',
  ]
  for (const m of normal) ok(!isGenerativeMediaModel(m), `照常探测：${m}`)
}

console.log('')
if (failed === 0) console.log('全部通过 ✓')
else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}