/**
 * 比价页「只显示允许放行」自检：纯函数契约 + 端到端 state 下发。
 *
 * 背景：比价页加了一个开关，打开后慢速 / 结果可疑 / 不稳定 / 没有可信样本的
 * 供给整行隐藏。过滤不能在前端拿标签自己拼一遍「什么算不合格」——那是第二份
 * 口径，迟早和网关的门禁漂移。所以服务端在 scores 里直接下发 admission
 * （core/router.js#admissionOf），前端只认 ok。这个测试钉死三件事：
 *
 *   1. 契约：admission.ok 为假 ⇔ 标签里有慢速 / 可疑 / 不稳定 / 没有可信样本；
 *      冷却中、评分过期、未探测、证据不足仍然放行（它们不是坏站）
 *   2. 「放行可疑供给」打开后，可疑 / 不稳定重新可见，慢速仍然隐藏（首字门槛独立）
 *   3. 端到端：/api/state 的 scores[offerId] 真的带 admission，且和 admissionOf
 *      的结论一致——少下发这个字段，前端会静默地什么都不隐藏
 *
 * 数据全部落在 mktemp 目录里，不碰真实的 ~/.manage-api。
 *
 * 用法：node .test/check-pricing-admitted.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
function ok(cond, message) {
  if (cond) console.log(`  ✓ ${message}`)
  else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

const { admissionOf, admissionTags } = await import(pathToFileURL(join(ROOT, 'core/router.js')).href)

// 一行候选的最小形状：和 check-admission / check-status-tags 同一份
const row = (patch = {}) => ({
  tooSlow: false,
  status: 'healthy',
  availability: 1,
  integrityFaults: [],
  blocked: null,
  samples: 10,
  allowUntrusted: false,
  ttftMs: 2000,
  ...patch,
})

// ---------------------------------------------------------------- 单元层
console.log('[1] 契约：被隐藏的正好是那几类硬伤')
{
  const cases = [
    ['慢速', row({ tooSlow: true, ttftMs: 9000 })],
    ['结果可疑', row({ status: 'degraded', integrityFaults: ['指纹不符'] })],
    ['不稳定', row({ status: 'unstable', availability: 0.33 })],
    ['没有可信样本', row({ status: 'unknown', availability: null, samples: 5 })],
  ]
  for (const [label, sample] of cases) {
    ok(admissionOf(sample).ok === false, `${label} → 不显示`)
    const tags = admissionTags(sample)
    ok(
      tags.some((k) => ['slow', 'degraded', 'unstable', 'no-evidence'].includes(k)),
      `${label} → 标签里确实有对应的毛病（${tags.join('+')}）`,
    )
  }

  const kept = [
    ['健康', row()],
    ['评分过期', row({ status: 'stale' })],
    ['未探测', row({ status: 'unknown', availability: null, samples: 0 })],
    ['证据不足', row({ status: 'inconclusive', availability: 0.5 })],
    ['冷却中', row({ blocked: { kind: 'quota', until: Date.now() + 1e6 }, availability: null, samples: 1 })],
  ]
  for (const [label, sample] of kept) {
    ok(admissionOf(sample).ok === true, `${label} → 仍然显示（不是坏站）`)
  }
}

console.log('[2] 「放行可疑供给」打开后：可疑/不稳定重新可见，慢速仍隐藏')
{
  const suspicious = row({ status: 'degraded', integrityFaults: ['指纹不符'], allowUntrusted: true })
  const unstable = row({ status: 'unstable', availability: 0.33, allowUntrusted: true })
  const slow = row({ tooSlow: true, ttftMs: 9000, allowUntrusted: true })
  ok(admissionOf(suspicious).ok === true, '可疑 + 已放行 → 显示')
  ok(admissionOf(unstable).ok === true, '不稳定 + 已放行 → 显示')
  ok(admissionOf(slow).ok === false, '慢速 + 已放行 → 仍隐藏（首字门槛是独立设置）')
}

// ---------------------------------------------------------------- 端到端
console.log('[3] /api/state 下发 admission（前端靠它过滤，不自己拼标签）')
{
  const home = await mkdtemp(join(tmpdir(), 'mapi-pricing-admitted-'))
  process.env.MANAGE_API_HOME = home
  try {
    const inv = await import(pathToFileURL(join(ROOT, 'core/inventory.js')).href)
    const store = await import(pathToFileURL(join(ROOT, 'core/store.js')).href)

    const provider = await inv.createProvider({ name: '过滤测试站', baseUrl: 'http://127.0.0.1:5198/v1' })
    const cred = await inv.createCredential({ providerId: provider.id, label: 'k1', secret: 'sk-1' })
    const models = ['slow-model', 'degraded-model', 'unstable-model', 'healthy-model', 'blocked-model', 'new-model']
    await inv.syncOffers(provider.id, cred.id, models)

    let db = await store.readDb()
    const offerOf = (name) => db.offers.find((o) => o.upstreamName === name)
    for (const name of models) {
      await inv.updateOfferPrice(offerOf(name).id, { inPrice: 1, outPrice: 2, currency: 'USD' })
    }
    db = await store.readDb()
    const id = (name) => offerOf(name).id

    // 探针证据：按名字造出五种状态，时间都在窗口内
    const ts = new Date(Date.now() - 60_000).toISOString()
    const good = { ok: true, ttftMs: 2000, fingerprintOk: true, truncated: false, billingInflated: false }
    const probes = [
      // 慢速：探针成功，只是首字 9000ms 超过门槛 5000
      { offerId: id('slow-model'), ts, ...good, ttftMs: 9000 },
      // 可疑：指纹不符（单次即可定性）
      { offerId: id('degraded-model'), ts, ...good, fingerprintOk: false },
      // 不稳定：3 个样本里只成功 1 次
      { offerId: id('unstable-model'), ts, ...good },
      { offerId: id('unstable-model'), ts, ok: false, error: 'upstream 502 bad gateway' },
      { offerId: id('unstable-model'), ts, ok: false, error: 'upstream 502 bad gateway' },
      // 健康：3 次全过
      { offerId: id('healthy-model'), ts, ...good },
      { offerId: id('healthy-model'), ts, ...good },
      { offerId: id('healthy-model'), ts, ...good },
      // 冷却中：额度不足，不是坏站
      { offerId: id('blocked-model'), ts, ok: false, error: 'insufficient balance' },
      // new-model 一次都没探过：没有评分，也就没有 admission
    ]
    await store.mutate((d) => {
      d.probes = probes
      d.settings.maxTtftMs = 5000
      d.settings.allowUntrusted = false
    })

    const { createAppServer } = await import(pathToFileURL(join(ROOT, 'daemon/server.js')).href)
    const server = createAppServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const getState = async () => (await fetch(`http://127.0.0.1:${port}/api/state`)).json()

    const fetchWithRetry = async () => {
      // 评分缓存按 db.json 的 mtime 失效；同一毫秒内写完再读可能命中旧快照
      for (let i = 0; i < 5; i += 1) {
        const data = await getState()
        if (data.scores?.[id('slow-model')]) return data
        await new Promise((r) => setTimeout(r, 20))
      }
      return getState()
    }

    try {
      const state = await fetchWithRetry()
      const score = (name) => state.scores?.[id(name)] || null

      ok(Boolean(score('healthy-model')?.admission), 'scores 里带 admission 字段')
      ok(score('healthy-model')?.admission?.ok === true, '健康 → 允许放行')
      ok(score('slow-model')?.admission?.ok === false, '慢速 → 不放行')
      ok(score('slow-model')?.admission?.kind === 'slow', `慢速的 kind 是 slow（得到 ${score('slow-model')?.admission?.kind}）`)
      ok(score('degraded-model')?.admission?.ok === false, '可疑 → 不放行')
      ok(score('unstable-model')?.admission?.ok === false, '不稳定 → 不放行')
      ok(score('blocked-model')?.admission?.ok === true, '冷却中 → 仍然允许放行（可见）')
      ok(score('new-model') === null, '没探过的供给没有评分（前端按「缺失不隐藏」处理）')

      // 服务端下发的结论必须和门禁函数一致，不能是另算的一份
      for (const name of models.filter((n) => score(n))) {
        const s = score(name)
        const expected = admissionOf({
          tooSlow: s.tooSlow,
          status: s.status,
          availability: s.availability,
          integrityFaults: s.integrityFaults,
          blocked: s.blocked,
          samples: (s.samples || 0) + (s.trafficSamples || 0),
          allowUntrusted: false,
        })
        ok(
          s.admission.ok === expected.ok && s.admission.kind === expected.kind,
          `${name} 的 admission 与 admissionOf 一致（${s.admission.kind ?? 'ok'}）`,
        )
      }

      // 模拟前端过滤：没有 admission（没评分）的行不隐藏
      const visible = (name) => state.scores?.[id(name)]?.admission?.ok !== false
      const shown = models.filter(visible)
      const hidden = models.filter((n) => !visible(n))
      ok(hidden.join(',') === 'slow-model,degraded-model,unstable-model', `隐藏的正好是三条硬伤（${hidden.join(',')}）`)
      ok(shown.join(',') === 'healthy-model,blocked-model,new-model', `显示的是健康 / 冷却中 / 未探测（${shown.join(',')}）`)

      // 打开「放行可疑供给」：可疑 / 不稳定重新可见，慢速仍然隐藏
      await store.mutate((d) => {
        d.settings.allowUntrusted = true
      })
      await new Promise((r) => setTimeout(r, 20))
      const relaxed = await fetchWithRetry()
      const visibleRelaxed = (name) => relaxed.scores?.[id(name)]?.admission?.ok !== false
      ok(visibleRelaxed('degraded-model'), '放行可疑供给后：可疑 → 重新显示')
      ok(visibleRelaxed('unstable-model'), '放行可疑供给后：不稳定 → 重新显示')
      ok(!visibleRelaxed('slow-model'), '放行可疑供给后：慢速 → 仍然隐藏')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

console.log('')
if (failed > 0) {
  console.error(`✗ ${failed} 项失败`)
  process.exit(1)
}
console.log('✓ 全部通过')
