/**
 * 价格校准执行器：给指定供给发一次最小请求，然后拿站点账单反推单价，
 * 比对页面标价。
 *
 * ── 铁律：**永不自动触发** ─────────────────────────────────────
 *
 * 这个模块只被 EXPLICIT 的 HTTP 调用触发（用户在基准价页点「校准」）。
 * 不挂定时器、不挂启动钩子、不挂 drift 自动响应。
 *
 * 理由：站点可能导进来几百个模型，自动跑一次就是几百次请求——
 * 钱是小事（几百次约几毛），但**上游限流和封号风险是真的**。
 * 用户明确要求「不能自动触发」，这条写在这里防止后来的人加定时。
 *
 * ── 成本 ───────────────────────────────────────────────────
 *
 * 每个供给 1 次请求：1000 token 输入 + <=8 token 输出 ≈ ¥0.0001。
 * 100 个供给 = 1 分钱。执行前接口会先返回预估成本让用户确认。
 */
import * as store from '../core/store.js'
import * as bench from '../core/benchmark.js'
import { ensureFx } from '../core/fx.js'
import { offerCost } from '../core/pricing.js'
import { revealSecret } from '../core/inventory.js'
import { decryptSecret } from '../core/store.js'
import { syncProviderLedger } from './ledger-runner.js'
import {
  buildCalibrationPrompt,
  judgeCalibration,
  pickCalibrationTargets,
  MIN_CALIBRATION_TOKENS,
  CALIBRATION_MAX_OUTPUT,
} from '../core/price-probe.js'

/** 单个校准请求的超时：1000 token 的请求比质量探针快，给 30 秒足够 */
const CALIBRATION_TIMEOUT_MS = 30_000
/** 校准后等账单更新的时间：站点账单是异步写的，太快读会读不到 */
const LEDGER_SETTLE_MS = 8_000
/** 预估单次校准成本用的样本价（rapid GPT 档），只用于报价预览 */
const ESTIMATE_PRICE_IN = 0.09
const ESTIMATE_PRICE_OUT = 0.45

function estimateOneCost() {
  return (MIN_CALIBRATION_TOKENS / 1e6) * ESTIMATE_PRICE_IN
    + (CALIBRATION_MAX_OUTPUT / 1e6) * ESTIMATE_PRICE_OUT
}

/**
 * 预估一批校准要花多少钱（用于「校准前先确认」）。
 *
 * @returns {{count:number, estimateCny:number, perItemCny:number}}
 */
export function estimateCalibrationCost(targets) {
  // 精度到 1e-7（0.1 微元）：单次约 9.4e-5，用 1e-6 会四舍五入成 0 或翻 10 倍
  const round7 = (v) => Math.round(v * 1e7) / 1e7
  const per = round7(estimateOneCost())
  const count = Array.isArray(targets) ? targets.length : 0
  return {
    count,
    perItemCny: per,
    estimateCny: round7(per * count),
  }
}

/** 发一次最小请求。返回上游 usage。 */
async function sendOnce({ baseUrl, apiKey, model, prompt, timeoutMs = CALIBRATION_TIMEOUT_MS }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: CALIBRATION_MAX_OUTPUT,
        stream: false,
      }),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 120)}` }
    }
    let payload = null
    try { payload = JSON.parse(text) } catch { return { ok: false, error: '响应不是 JSON' } }
    return { ok: true, usage: payload.usage || null, payload }
  } catch (error) {
    return { ok: false, error: error.message || String(error) }
  } finally {
    clearTimeout(timer)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 执行校准。
 *
 * @param {object} db 数据库（就地不改，只读 offers / settings / credentials）
 * @param {{providerIds?:string[], modelKeys?:string[], onlyDrifted?:string[],
 *          offerIds?:string[], settleMs?:number}} options 筛选条件
 * @returns {Promise<{results:Array, cost:object, skipped:string[]}>}
 */
export async function calibratePrices(db, options = {}) {
  const offers = (db.offers || []).filter((o) => !o.delistedAt)
  const ignored = db.settings?.ignoredModels || []
  const targets = pickCalibrationTargets(offers, {
    providerIds: options.providerIds,
    modelKeys: options.modelKeys,
    onlyDrifted: options.onlyDrifted,
    ignoredIds: ignored,
  })
  // 用户点名要的（offerIds）优先，且不受「忽略」限制——他明确选了就是要校准
  const explicit = options.offerIds && options.offerIds.length
    ? offers.filter((o) => options.offerIds.includes(o.id))
    : targets

  const benchmarks = await bench.readBenchmarks()
  const fx = Number(ensureFx(db.settings || {}).rates?.CNY) || null
  const results = []
  const skipped = []
  let spent = 0

  for (const offer of explicit) {
    const provider = (db.providers || []).find((p) => p.id === offer.providerId)
    if (!provider) { skipped.push(`${offer.id}: 站点不存在`); continue }
    if (provider.paused) { skipped.push(`${offer.id}: 站点已暂停`); continue }
    // 一个站可能有多个 Key，取第一个绑了这个供给的
    // 凭据里存的是密文（字段名 secret），必须先解密才能发请求
    const creds = (db.credentials || []).filter((c) => c.providerId === provider.id && c.secret)
    const cred = creds.find((c) => c.id === offer.credentialId) || creds[0]
    if (!cred) { skipped.push(`${offer.id}: 没有可用的 Key`); continue }
    let apiKey = null
    try { apiKey = await revealSecret(cred.id) } catch (e) { skipped.push(`${offer.id}: Key 解密失败 ${e.message}`); continue }
    if (!apiKey) { skipped.push(`${offer.id}: Key 为空`); continue }

    const prompt = buildCalibrationPrompt(MIN_CALIBRATION_TOKENS)
    const sent = await sendOnce({
      baseUrl: provider.baseUrl,
      apiKey,
      model: offer.upstreamName,
      prompt,
    })
    if (!sent.ok) {
      results.push({ offerId: offer.id, providerName: provider.name, group: offer.group,
        upstreamName: offer.upstreamName, ok: false, error: sent.error, verdict: 'error' })
      continue
    }
    const cost = offerCost(offer, db.settings, benchmarks)
    const listPrice = cost.inCnyPerMtok
    // 账单是异步的，等一会儿再读——读太快会拿到「还没有这条」的结果
    if (options.settleMs !== 0) await sleep(options.settleMs ?? LEDGER_SETTLE_MS)

    results.push({
      offerId: offer.id,
      providerId: provider.id,
      providerName: provider.name,
      group: offer.group || '',
      upstreamName: offer.upstreamName,
      ok: true,
      listPrice,
      // 待上层用新账单跑一次 diffLedgerAgainstOffers 后再判定
      // （这里不直接读库，避免与并发写入竞争）
      usage: sent.usage,
      verdict: 'pending',
    })
    spent += estimateOneCost()
  }

  // 校准发完之后必须**主动同步一次账单**：账单没有定时任务，不拉就永远读不到
  // 刚发的那些请求。同步是纯读站点后台（不打模型），免费且必要。
  // 只同步本轮涉及过的站点，不惊动其他站。
  const touched = [...new Set(results.filter((r) => r.ok).map((r) => r.providerId))]
  const synced = {}
  for (const pid of touched) {
    const provider = (db.providers || []).find((p) => p.id === pid)
    if (!provider) { synced[pid] = { ok: false, error: '站点不存在' }; continue }
    // 账单接口要的是**解密后**的管理令牌。syncAllLedgers 也是这么做的
    // （daemon/ledger-runner.js:188），这里照同一口径来，别指望 provider.adminToken
    // 那个密文能直接用——实测会报「没有管理令牌」。
    let adminToken = ''
    try {
      adminToken = provider.adminToken ? await decryptSecret(provider.adminToken) : ''
    } catch { adminToken = '' }
    if (!adminToken) { synced[pid] = { ok: false, error: '站点没配管理令牌，读不到账单' }; continue }
    try {
      // 第一个参数要 provider 对象（函数内部读 .id/.baseUrl），不是 id
      const one = await syncProviderLedger(provider, { adminToken, days: 1, force: true })
      synced[pid] = { ok: Boolean(one?.ok), rows: one?.rows?.length ?? 0, error: one?.error ?? null }
    } catch (error) {
      synced[pid] = { ok: false, error: error.message || String(error) }
    }
  }

  return {
    results,
    cost: { estimateCny: Math.round(spent * 1e8) / 1e8, count: results.length },
    skipped,
    ledgerSynced: synced,
  }
}

/**
 * 拿校准后的账单行做判定。
 *
 * 单独一个函数：校准请求发完就返回，判定要等账单更新，
 * 由前端再过几秒调 `POST /api/price-calibrate/judge` 完成。
 * 这样接口不会有 8 秒以上的阻塞调用。
 */
export function judgeCalibrationResults(results, ledgerRows, fxRate) {
  const byGroupModel = new Map()
  for (const r of ledgerRows || []) {
    if (!r.group) continue
    byGroupModel.set(`${r.group}::${r.model}`, r)
  }
  const out = []
  for (const item of results || []) {
    if (item.verdict === 'error') { out.push(item); continue }
    const row = byGroupModel.get(`${item.group}::${item.upstreamName}`)
    if (!row) {
      out.push({ ...item, verdict: 'unknown', note: '账单里还没这条记录（站点账单有延迟）' })
      continue
    }
    // 口径必须对齐——这里最容易错，实测踩过一次：
    //   账单 `baseIn` 是**站点原价**（未乘倍率），eg 4.0
    //   台账 `listPrice` 是 offerCost 算出的**折后价**（原价 × 倍率），eg 0.2
    //   倍率 rate = 0.05 → 4.0 × 0.05 = 0.2 才对得上
    // 直接拿 baseIn 比 listPrice 会算出 1900% 的荒谬偏差。
    const rawBase = row.baseIn === null || row.baseIn === undefined ? null : Number(row.baseIn)
    const rate = row.rate === null || row.rate === undefined ? null : Number(row.rate)
    const backIn = rawBase === null ? null : rawBase * (rate === null ? 1 : rate)
    const judged = judgeCalibration({ backIn }, item.listPrice, fxRate)
    out.push({ ...item, ...judged })
  }
  return out
}
