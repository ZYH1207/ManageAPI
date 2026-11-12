/**
 * 价格校准探针：验证「站点页面标价」与「站点实际记账」是否一致。
 *
 * ── 为什么需要它（和现有探针的分工）─────────────────────────────
 *
 * `core/probe.js` 是**质量探针**：指纹 / 截断 / 虚报 / 缓存，三类都是二值判定，
 * 为了测准必须给足 token（缓存前缀 1200+、截断要求输出 1..120），一次约
 * ¥0.00035。它回答的是「这个站可不可信」。
 *
 * 本模块是**价格探针**：只回答一个问题——
 *   「站点页面上标的价，和它实际扣我的价，对得上吗？」
 *
 * 因此它只需发**一次**请求，且必须满足两个硬条件：
 *   1. 输入够大（>= MIN_CALIBRATION_TOKENS）——否则账单反推价噪音极大。
 *      实测 claude-opus-4.8 只有 16 token 证据时反推价 0.25 完全失真。
 *   2. 输够小（<= 8 token）——输出单价通常是输入的 4~5 倍，多吐一个字都亏。
 *
 * 成本：1000 token 输入 + 4 token 输出 ≈ ¥0.0001（rapid GPT 价），
 * 是质量探针的 1/3.5。批量校准 40 个供给约 4 分钱。
 *
 * ── 为什么不能更便宜 ─────────────────────────────────────────
 *
 * 试过纯 `max_tokens=1` + 2 token 输入：账单反推出来的单价偏差能到几倍，
 * 因为 token 太少时「四舍五入到分」和「缓存未命中」都会主导结果。
 * 1000 token 是实测能稳定反推出价格的下限。
 *
 * ── 为什么需要「长前缀去重」──────────────────────────────────
 *
 * 同一供给连续校准多次，第二次起会命中 prompt cache（缓存价约输入价 1/10）。
 * 这会让「账单反推价」算出折后价，与标价一比就误判成「不符」。
 * 所以每次校准用**不同前缀**，确保按全价计费，反推出的才是标准单价。
 */

import { estimateTokens } from './quality-signals.js'

/** 校准请求的输入下限：低于此值账单反推价不可信（实测阈值） */
export const MIN_CALIBRATION_TOKENS = 1000
/** 校准请求的输出上限：只验证「能返回」，不需要内容 */
export const CALIBRATION_MAX_OUTPUT = 8
/** 判定「标价与账单一致」的容差：站点四舍五入 + 汇率波动都在这之内 */
export const CALIBRATION_TOLERANCE = 0.05

/**
 * 造一个不重复的填充前缀。
 *
 * 用随机词而不是固定文本，是为了**避免命中缓存**——命中缓存会让账单按
 * 缓存价记账，反推出的单价只有标价的十分之一，直接误判。
 *
 * @param {number} targetTokens 期望 token 数
 * @param {() => number} rand 随机源（测试可注入固定序列）
 */
export function buildCalibrationPrompt(targetTokens = MIN_CALIBRATION_TOKENS, rand = Math.random) {
  // 英文词平均 ~1.3 token，凑够目标量留 20% 余量
  const words = []
  let approx = 0
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  while (approx < targetTokens * 1.2) {
    // 每个「词」8~12 字符，保证不像自然语言、极难被缓存命中
    const len = 8 + Math.floor(rand() * 5)
    let w = ''
    for (let i = 0; i < len; i += 1) w += alphabet[Math.floor(rand() * 26)]
    words.push(w)
    approx += 1.5
  }
  return `${words.join(' ')}\n\nReply with exactly: OK`
}

/**
 * 从上游 usage 与站点账单行算出「本次校准反推的单价」。
 *
 * @param {object} usage 上游返回的 usage
 * @param {object} ledgerRow 校准后从账单里找到的行（含 inputCost/outputCost 等）
 * @param {number} rate 该供给的分组倍率
 * @returns {{backIn:number|null, backOut:number|null, tokens:object}|null}
 */
export function backComputePrice(usage, ledgerRow, rate) {
  if (!usage || !ledgerRow) return null
  // 账单聚合行给的是**已除过 token 的每百万单价**（baseIn/baseOut），
  // 但那是**站点原价**（未乘倍率）。要比的是台账标价（已乘倍率），
  // 所以这里乘回 row.rate——不乘就会算出 1900% 这种荒谬偏差（实测踩过）。
  const r = rate === null || rate === undefined ? null : Number(rate)
  const mul = r === null || !Number.isFinite(r) ? 1 : r
  const backIn = ledgerRow.baseIn === null || ledgerRow.baseIn === undefined
    ? null : Number(ledgerRow.baseIn) * mul
  const backOut = ledgerRow.baseOut === null || ledgerRow.baseOut === undefined
    ? null : Number(ledgerRow.baseOut) * mul
  return {
    backIn,
    backOut,
    rate: r,
    tokens: { input: Number(ledgerRow.inputTokens) || 0, output: Number(ledgerRow.outputTokens) || 0 },
  }
}

/**
 * 判定校准结果。
 *
 * 三种结论，各自对应不同的下一步动作：
 *   - `ok`        偏差 <= 5%：标价可信，无需改任何东西
 *   - `mismatch`  偏差 > 5%：标价与账单不符，**可以一键把标价改成账单值**
 *   - `currency`  偏差 ≈ 汇率倍数：基准价币种标错（RUSD/CNY 混淆），
 *                 改数字没用，要改币种
 *
 * @param {{backIn:number|null}} computed backComputePrice 的结果
 * @param {number} listPrice 站点页面标价（输入单价，站内口径）
 * @param {number} fxRate 当前汇率，用于识别币种误标
 */
export function judgeCalibration(computed, listPrice, fxRate = null) {
  const back = Number(computed?.backIn)
  const list = Number(listPrice)
  if (!Number.isFinite(back) || !Number.isFinite(list) || list <= 0) {
    return { verdict: 'unknown', diffPct: null, suggestedPrice: null }
  }
  const diffPct = Math.round(((back - list) / list) * 1000) / 10
  const ratio = back / list
  const inv = ratio > 0 ? 1 / ratio : null
  const fx = Number(fxRate) > 0 ? Number(fxRate) : null
  const nearFx = (r) => fx !== null && r !== null && Math.abs(r - fx) / fx <= 0.15

  if (nearFx(ratio) || nearFx(inv)) {
    return {
      verdict: 'currency',
      diffPct,
      suggestedPrice: null,
      note: `偏差 ${diffPct}% 接近汇率倍数 ${fx}，疑似基准价币种标错（RUSD/CNY）`,
    }
  }
  if (Math.abs(diffPct) <= CALIBRATION_TOLERANCE * 100) {
    return { verdict: 'ok', diffPct, suggestedPrice: null }
  }
  return {
    verdict: 'mismatch',
    diffPct,
    // 建议价 = 账单反推价（四舍五入到 6 位，和 pricing.js 的精度口径一致）
    suggestedPrice: Math.round(back * 1e6) / 1e6,
    note: `标价 ${list} vs 账单反推 ${Math.round(back * 1e6) / 1e6}，差 ${diffPct}%`,
  }
}

/**
 * 挑出「需要校准」的供给。
 *
 * 默认口径：**未被忽略的**。理由——忽略的模型用户明确说了不要，为它花校准费
 * 纯属浪费；而没忽略的才可能真被派活。
 *
 * 支持筛选器：
 *   - providerIds  只校准指定站点
 *   - modelKeys    只校准指定模型（模型名子串匹配，方便「所有 gpt」）
 *   - onlyDrifted  只校准已有 price-drift 预警的（省到极致）
 *
 * @param {object[]} offers 台账供给
 * @param {object} options
 * @returns {object[]} 待校准供给
 */
export function pickCalibrationTargets(offers, {
  providerIds = null,
  modelKeys = null,
  onlyDrifted = null,
  ignoredIds = null,
} = {}) {
  const skip = ignoredIds instanceof Set ? ignoredIds : new Set(ignoredIds || [])
  const pids = providerIds && providerIds.length ? new Set(providerIds) : null
  const keys = modelKeys && modelKeys.length
    ? modelKeys.map((k) => String(k).toLowerCase())
    : null
  const drifted = onlyDrifted ? new Set(onlyDrifted) : null

  const out = []
  for (const offer of offers || []) {
    if (!offer || !offer.id) continue
    // 默认跳过被忽略的模型
    if (skip.has(offer.id)) continue
    // 被忽略的模型也可能挂在 modelKey 上
    const name = String(offer.upstreamName || offer.modelKey || '').toLowerCase()
    if (skip.has(name)) continue
    if (pids && !pids.has(offer.providerId)) continue
    if (keys && !keys.some((k) => name.includes(k))) continue
    if (drifted && !drifted.has(offer.id)) continue
    // 按次/生图没有 token 单价，校准无意义
    if (offer.pricingMode === 'call') continue
    out.push(offer)
  }
  return out
}
