/**
 * 生成一份「展示用」数据，专门给 README 截图。
 *
 * 和 seed-demo.mjs 的区别：那个要起 mock 上游、走真实 API、跑真探针，用于端到端测试；
 * 这个直接写 JSON，不需要任何上游，目的是让界面有内容可看。
 *
 * 站点名全是虚构的（云雀 / 星链 / 极光 / 苍穹），不涉及任何真实中转站。
 *
 *   MANAGE_API_HOME=/tmp/manage-api-showcase node .test/seed-showcase.mjs
 *   MANAGE_API_HOME=/tmp/manage-api-showcase node daemon/index.js --port 4400
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dir = process.env.MANAGE_API_HOME || join(homedir(), '.manage-api-showcase')
const now = Date.now()
const iso = (offsetMs = 0) => new Date(now - offsetMs).toISOString()
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const BENCH = {
  'deepseek-v4.1-flash': { display: 'DeepSeek V4.1 Flash', in: 2, out: 8 },
  'deepseek-v4-pro': { display: 'DeepSeek V4 Pro', in: 9, out: 27 },
  'glm-5.3': { display: 'GLM-5.3', in: 8, out: 28 },
  'kimi-k3': { display: 'Kimi K3', in: 20, out: 100 },
  'qwen3.8-max': { display: 'Qwen3.8 Max', in: 12, out: 36 },
}

const PROVIDERS = [
  { id: 'p_show01', name: '云雀 API', baseUrl: 'https://api.yunque.dev/v1', quota: 186.4 },
  { id: 'p_show02', name: '星链 API', baseUrl: 'https://api.xinglian.io/v1', quota: 92.8 },
  { id: 'p_show03', name: '极光 API', baseUrl: 'https://api.jiguang.cc/v1', quota: 41.5 },
  { id: 'p_show04', name: '苍穹 API', baseUrl: 'https://api.cangqiong.ai/v1', quota: null },
]

/** 每个站卖哪些模型、在哪个分组、倍率多少 */
const OFFERS = [
  { p: 'p_show01', model: 'deepseek-v4.1-flash', group: '特价池', ratio: 0.1 },
  { p: 'p_show01', model: 'deepseek-v4-pro', group: '特价池', ratio: 0.1 },
  { p: 'p_show01', model: 'glm-5.3', group: '默认分组', ratio: 0.4 },
  { p: 'p_show01', model: 'qwen3.8-max', group: '默认分组', ratio: 0.4 },
  { p: 'p_show02', model: 'deepseek-v4.1-flash', group: '默认分组', ratio: 0.6 },
  { p: 'p_show02', model: 'deepseek-v4-pro', group: '默认分组', ratio: 0.6 },
  { p: 'p_show02', model: 'kimi-k3', group: '默认分组', ratio: 0.6 },
  { p: 'p_show03', model: 'deepseek-v4.1-flash', group: 'Pro 号池', ratio: 0.65 },
  { p: 'p_show03', model: 'deepseek-v4-pro', group: 'Pro 号池', ratio: 0.65 },
  { p: 'p_show03', model: 'glm-5.3', group: 'Pro 号池', ratio: 0.65 },
  { p: 'p_show04', model: 'deepseek-v4.1-flash', group: '默认分组', ratio: 1 },
  { p: 'p_show04', model: 'kimi-k3', group: '默认分组', ratio: 1 },
  { p: 'p_show04', model: 'qwen3.8-max', group: '默认分组', ratio: 1 },
]

/** 探测剧本：ok / fp（指纹挂）/ trunc（截断） */
const PROFILE = {
  p_show01: { kind: 'trunc', ttft: [820, 1240], latency: [3100, 4200], cache: 0.96 },
  p_show02: { kind: 'fp', ttft: [640, 980], latency: [2600, 3400], cache: 0.88 },
  p_show03: { kind: 'ok', ttft: [410, 620], latency: [1800, 2400], cache: 0.93 },
  p_show04: { kind: 'ok', ttft: [180, 300], latency: [900, 1400], cache: 0.72 },
}

const spread = ([lo, hi], seed) => Math.round(lo + (((seed * 9301 + 49297) % 233280) / 233280) * (hi - lo))

const providers = PROVIDERS.map((p) => ({
  id: p.id,
  name: p.name,
  baseUrl: p.baseUrl,
  kind: 'sub2api',
  note: '',
  createdAt: iso(30 * DAY),
  updatedAt: iso(HOUR),
}))

const credentials = PROVIDERS.map((p, i) => ({
  id: `c_show0${i + 1}`,
  providerId: p.id,
  label: '主 Key',
  secret: null,
  tail: String(4820 + i * 137).slice(-4),
  quotaRemaining: p.quota,
  currency: 'CNY',
  quotaUpdatedAt: p.quota === null ? null : iso(2 * HOUR),
  expiresAt: null,
  createdAt: iso(30 * DAY),
  adminToken: null,
  adminTokenTail: null,
  // 这把 Key 买的是哪个分组——和它第一条供给的分组保持一致
  group: OFFERS.find((o) => o.p === p.id)?.group || '',
}))

const offers = OFFERS.map((o, i) => ({
  id: `o_show${String(i + 1).padStart(2, '0')}`,
  providerId: o.p,
  credentialId: `c_show0${PROVIDERS.findIndex((p) => p.id === o.p) + 1}`,
  upstreamName: o.model,
  modelKey: o.model,
  group: o.group,
  inPrice: null,
  outPrice: null,
  ratio: o.ratio,
  siteRatio: o.ratio,
  ratioSource: 'site',
  pricingMode: 'ratio',
  benchmarkKey: null,
  currency: 'CNY',
  priceUnit: 'per_mtok',
  listedAt: iso(20 * DAY),
  updatedAt: iso(HOUR),
}))

// 每条供给 3 次探测，时间落在最近 1 小时内，保证评分不过期
const probes = []
let seq = 0
for (const offer of offers) {
  const profile = PROFILE[offer.providerId]
  for (let round = 0; round < 3; round += 1) {
    seq += 1
    const seed = seq * 37 + round
    const fpOk = profile.kind === 'fp' ? round === 0 : true
    const truncated = profile.kind === 'trunc'
    probes.push({
      id: `r_show${String(seq).padStart(3, '0')}`,
      ts: iso((round * 17 + 3) * MIN),
      ok: true,
      model: offer.upstreamName,
      offerId: offer.id,
      providerId: offer.providerId,
      modelKey: offer.modelKey,
      latencyMs: spread(profile.latency, seed),
      ttftMs: spread(profile.ttft, seed + 3),
      fingerprintOk: fpOk,
      fingerprintRaw: fpOk ? null : '{"fp":"XX99","calc":0}',
      truncated,
      truncationDetail: truncated
        ? '最高数字 41，finish_reason=length，completion_tokens=612'
        : '最高数字 120，finish_reason=stop，completion_tokens=318',
      billingInflated: false,
      cacheSupported: true,
      cacheHitRate: Number((profile.cache - round * 0.012).toFixed(4)),
      cacheDetail: 'prompt_tokens=1316，cached_tokens=1264',
      promptTokens: 138,
      completionTokens: truncated ? 612 : 318,
      finishReason: truncated ? 'length' : 'stop',
      identityClaim: null,
      error: null,
    })
  }
}

// 真实流量回写：网关转发的成败也计入可用率。
// 结构是 { [offerId]: { ok, fail, since } }，不是数组——scoreOffers 直接按 offerId 取值。
const traffic = {}
for (const offer of offers) {
  traffic[offer.id] = { ok: 5, fail: 0, since: iso(40 * MIN) }
}

// 网关决策日志：让「最近请求」表有内容可看
const routing = []
for (let i = 0; i < 9; i += 1) {
  const offer = offers[i % offers.length]
  const provider = PROVIDERS.find((p) => p.id === offer.providerId)
  routing.push({
    id: `g_show${String(i + 1).padStart(2, '0')}`,
    ts: iso((i * 7 + 2) * MIN),
    model: offer.modelKey,
    keyId: 'gk_show01',
    keyName: '默认 Key',
    chosenOfferId: offer.id,
    chosenProviderId: offer.providerId,
    chosenProviderName: provider.name,
    upstreamModel: offer.upstreamName,
    chosenGroup: offer.group,
    attempts: 1,
    outcome: 'ok',
    latencyMs: 1800 + i * 130,
    ttftMs: 380 + i * 45,
    usage: { prompt_tokens: 1180 + i * 90, completion_tokens: 240 + i * 30, total_tokens: 1420 + i * 120 },
    candidates: [],
    failures: [],
  })
}

const db = {
  version: 1,
  settings: {
    fxUsdCny: 7.2,
    blendInputWeight: 0.25,
    probeTimeoutMs: 45000,
    probeIntervalMinutes: 0,
    scoreMaxAgeHours: 6,
    maxTtftMs: 0,
    gateway: {
      enabled: true,
      keys: [
        {
          id: 'gk_show01',
          name: '默认 Key',
          key: 'sk-mapi-0000000000000000000000000000',
          enabled: true,
          monthlyTokenLimit: null,
          note: '',
          createdAt: iso(30 * DAY),
        },
      ],
    },
  },
  providers,
  credentials,
  offers,
  probes,
  manualOrder: {},
  routing,
  traffic,
}

const benchmarks = {}
for (const [key, b] of Object.entries(BENCH)) {
  benchmarks[key] = {
    display: b.display,
    in: b.in,
    out: b.out,
    offPeakIn: null,
    offPeakOut: null,
    currency: 'CNY',
    source: 'reference:showcase',
    updatedAt: iso(5 * DAY),
  }
}

// 用量：最近 30 天，按 天 × Key × 站点 × 模型 聚合
const days = {}
for (let d = 0; d < 30; d += 1) {
  const day = new Date(now - d * DAY).toISOString().slice(0, 10)
  const bucket = {}
  for (const offer of offers) {
    const reqs = 2 + ((d * 7 + offer.id.charCodeAt(5)) % 12)
    const input = reqs * (2400 + ((d * 13 + offer.id.charCodeAt(5)) % 9) * 780)
    const output = reqs * (320 + ((d * 5) % 7) * 88)
    bucket[`gk_show01|${offer.providerId}|${offer.upstreamName}`] = {
      requests: reqs,
      errors: 0,
      input,
      output,
      cached: Math.round(input * 0.62),
      latencySum: reqs * (2100 + d * 60),
      latencyCount: reqs,
      ttftSum: reqs * (520 + d * 30),
      ttftCount: reqs,
    }
  }
  days[day] = bucket
}

await mkdir(dir, { recursive: true })
await writeFile(join(dir, 'db.json'), JSON.stringify(db, null, 2), 'utf8')
await writeFile(join(dir, 'benchmark.json'), JSON.stringify(benchmarks, null, 2), 'utf8')
await writeFile(join(dir, 'usage.json'), JSON.stringify({ version: 1, days }, null, 2), 'utf8')

console.log(`展示数据已写入 ${dir}`)
console.log(`  站点 ${providers.length} · 供给 ${offers.length} · 探针 ${probes.length} · 基准价 ${Object.keys(benchmarks).length}`)
