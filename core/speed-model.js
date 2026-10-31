/**
 * 速度估计模型 —— 回答「没有真实流量时该信谁」。
 *
 * ## 核心问题
 *
 * 探针速度 vs 真实流量速度，哪个更准？
 *
 * 答案取决于问的是什么：
 *
 * | | 探针 | 真实流量 |
 * |---|---|---|
 * | 量的是什么 | 站本身多快 | 你实际等多久 |
 * | 请求形态 | 固定 ~45 token | 几万~几十万 token |
 * | 受上下文影响 | 无 | 很大 |
 * | 适合判断 | 站是否健康/是否变慢 | 用户体验 |
 * | 适合排序 | 只在没有真实数据时 | 优先 |
 *
 * **实测证据**（本机 ManageAPI 库，2026-10-31）：
 *
 *   探针口径首字：约 2000 ms
 *   真实口径首字：4365 ~ 19771 ms
 *
 * 探针系统性低估 **2~10 倍**。原因很直白：探针发的是几十 token 的小请求，
 * 上游的 KV cache 几乎必然全部命中，预填充几乎为零；而你的真实请求要
 * 预填充几万 token，那才是首字慢的主因。
 *
 * ## 所以怎么办：标定（calibration）
 *
 * 关键洞察：**同一个站，探针和真实的比值是相对稳定的**。
 *
 *   站 A：探针 2s，真实 9s → 比值 4.5
 *   站 B：探针 1s，真实 3s → 比值 3.0
 *
 * 这个比值反映的是「该站的真实负载特征」（上下文长度、缓存策略、排队深度），
 * 短期内不会剧变。所以：
 *
 *   1. 有真实数据 → 直接用真实值（最准）
 *   2. 没真实数据但有探针 → **用探针值 × 该站/全局的标定比值**
 *   3. 两者都没有 → 标记为「未知」，排序时排后面但**不排除**
 *
 * 这比「没真实数据就退回裸探针值」准得多，也比「直接排除未知供给」安全得多
 * ——后者正是「一处没数据、整条链崩掉」的成因。
 *
 * ## 为什么用中位数比值而不是平均值
 *
 * 比值受长尾影响极大（一个 30s 的异常样本能把平均值拉到离谱）。
 * 中位数对离群点稳健，这是标定这类问题的标准做法。
 */

/** 标定所需的最少配对样本数。少于这个数就当标定不可信，退回全局比值。 */
export const MIN_CALIBRATION_SAMPLES = 3

/** 标定比值允许的范围。超出这个范围说明数据有问题，夹紧而不是盲信。 */
export const CALIBRATION_CLAMP = { min: 0.5, max: 20 }

/** 样本来源的置信度权重。真实数据永远最可信。 */
export const SOURCE_CONFIDENCE = {
  real: 1.0,          // 真实流量实测
  calibrated: 0.6,    // 探针 × 标定比值（推出来的）
  probe: 0.3,         // 裸探针值（系统性低估，只能当粗略参考）
  none: 0.0,          // 什么都不知道
}

/**
 * 算中位数。
 * @param {number[]} values
 * @returns {number|null}
 */
function median(values) {
  const nums = (values ?? [])
    .filter((v) => v !== null && v !== undefined)
    .map(Number)
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b)
  if (!nums.length) return null
  const mid = Math.floor(nums.length / 2)
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2
}

/**
 * 从历史数据里算「探针 → 真实」的标定比值。
 *
 * 数据来源：每个供给同时有 `ttftMs`（探针口径）和 `realTtftMs`（真实口径）时，
 * 两者的比值就是一个配对样本。按供给、按站点两级聚合。
 *
 * @param {Array<{offerId:string, providerId:string, probeTtftMs:number, realTtftMs:number}>} pairs
 * @returns {{
 *   global: number|null,
 *   byOffer: Map<string, number>,
 *   byProvider: Map<string, number>,
 *   samples: {global:number, offers:number, providers:number}
 * }}
 */
export function buildCalibration(pairs = []) {
  const globalRatios = []
  const offerRatios = new Map()
  const providerRatios = new Map()

  for (const p of pairs) {
    const probe = Number(p?.probeTtftMs)
    const real = Number(p?.realTtftMs)
    if (!Number.isFinite(probe) || !Number.isFinite(real)) continue
    if (probe <= 0 || real <= 0) continue
    const ratio = clampRatio(real / probe)
    globalRatios.push(ratio)

    if (p.offerId) {
      if (!offerRatios.has(p.offerId)) offerRatios.set(p.offerId, [])
      offerRatios.get(p.offerId).push(ratio)
    }
    if (p.providerId) {
      if (!providerRatios.has(p.providerId)) providerRatios.set(p.providerId, [])
      providerRatios.get(p.providerId).push(ratio)
    }
  }

  const toMedianMap = (map) => {
    const out = new Map()
    for (const [key, list] of map) {
      if (list.length < MIN_CALIBRATION_SAMPLES) continue
      const m = median(list)
      if (m !== null) out.set(key, m)
    }
    return out
  }

  return {
    global: globalRatios.length >= MIN_CALIBRATION_SAMPLES ? median(globalRatios) : null,
    byOffer: toMedianMap(offerRatios),
    byProvider: toMedianMap(providerRatios),
    samples: { global: globalRatios.length, offers: offerRatios.size, providers: providerRatios.size },
  }
}

function clampRatio(v) {
  if (!Number.isFinite(v) || v <= 0) return null
  return Math.min(CALIBRATION_CLAMP.max, Math.max(CALIBRATION_CLAMP.min, v))
}

/**
 * 估计一条供给的速度。这是排序唯一该用的入口。
 *
 * @param {object} row 路由行（含 ttftMs / realTtftMs / realTtftSamples）
 * @param {object} opts
 * @param {ReturnType<typeof buildCalibration>} [opts.calibration]
 * @param {string} [opts.offerId]
 * @param {string} [opts.providerId]
 * @returns {{
 *   ms: number|null,
 *   source: 'real'|'calibrated'|'probe'|'none',
 *   confidence: number,
 *   rawProbeMs: number|null,
 *   rawRealMs: number|null,
 *   ratio: number|null,
 *   note: string
 * }}
 */
export function estimateSpeed(row, { calibration = null, offerId = null, providerId = null } = {}) {
  const probeMs = toPositive(row?.ttftMs)
  const realMs = toPositive(row?.realTtftMs)
  const realSamples = Number(row?.realTtftSamples ?? 0)

  // ① 有真实数据 → 直接用（最准，无需标定）
  if (realMs !== null && realSamples > 0) {
    return {
      ms: realMs,
      source: 'real',
      confidence: SOURCE_CONFIDENCE.real,
      rawProbeMs: probeMs,
      rawRealMs: realMs,
      ratio: probeMs ? realMs / probeMs : null,
      note: `真实流量 ${realSamples} 个样本`,
    }
  }

  // ② 只有探针 → 用标定比值校正
  if (probeMs !== null) {
    const ratio = pickRatio(calibration, offerId, providerId)
    if (ratio !== null) {
      return {
        ms: Math.round(probeMs * ratio),
        source: 'calibrated',
        confidence: SOURCE_CONFIDENCE.calibrated,
        rawProbeMs: probeMs,
        rawRealMs: null,
        ratio,
        note: `探针 ${Math.round(probeMs)}ms × 标定 ${ratio.toFixed(2)}（该站真实/探针比）`,
      }
    }
    // 连标定都没有（新库/新站）→ 裸探针值，置信度最低
    return {
      ms: probeMs,
      source: 'probe',
      confidence: SOURCE_CONFIDENCE.probe,
      rawProbeMs: probeMs,
      rawRealMs: null,
      ratio: null,
      note: '只有探针值，且无标定数据（系统性低估，仅供粗略参考）',
    }
  }

  // ③ 什么都没有 → 明确标记未知，但**不返回 Infinity**
  //    Infinity 会让它在排序里排最后，而「排最后」不等于「排除」——
  //    只要别的地方不因为 null 把它判死，它仍然能被兜底用到。
  return {
    ms: null,
    source: 'none',
    confidence: SOURCE_CONFIDENCE.none,
    rawProbeMs: null,
    rawRealMs: null,
    ratio: null,
    note: '没有任何速度数据',
  }
}

function toPositive(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

function pickRatio(calibration, offerId, providerId) {
  if (!calibration) return null
  // 优先级：该供给自己的比值 > 该站点的比值 > 全局比值
  if (offerId && calibration.byOffer?.has(offerId)) return calibration.byOffer.get(offerId)
  if (providerId && calibration.byProvider?.has(providerId)) return calibration.byProvider.get(providerId)
  return calibration.global ?? null
}

/**
 * 给排序用的标量：速度 + 置信度惩罚。
 *
 * 为什么要有置信度惩罚：一个「标定推算出的 3 秒」和一个「实测的 3 秒」不是
 * 同等可信。如果完全不罚，新站会因为「探针值小」被误排到最前，实际用起来很慢。
 *
 * 惩罚方式：往不确定性方向拉。置信度越低，越倾向于把它的估计值往上调
 * （保守 —— 宁可低估它的速度，也不要让用户踩坑）。
 *
 * @param {ReturnType<typeof estimateSpeed>} est
 * @param {number} [confidencePenalty=0.25] 置信度每差 1，速度上调的比例
 * @returns {number} 用于排序的毫秒值；完全未知时返回 Infinity（排最后但不排除）
 */
export function speedMetric(est, confidencePenalty = 0.25) {
  if (!est || est.ms === null || !Number.isFinite(est.ms)) return Number.POSITIVE_INFINITY
  const penalty = (1 - est.confidence) * confidencePenalty
  return est.ms * (1 + penalty)
}

/** 给人看的标定摘要（面板上显示「探针可信度」）。 */
export function calibrationSummary(calibration) {
  if (!calibration) return { available: false, text: '无标定数据' }
  const g = calibration.global
  if (g === null) {
    return {
      available: false,
      text: `标定样本不足（需要 ${MIN_CALIBRATION_SAMPLES} 个同时有探针和真实数据的供给，现有 ${calibration.samples.global} 个）`,
    }
  }
  return {
    available: true,
    ratio: g,
    text: `真实速度约为探针的 ${g.toFixed(1)} 倍（基于 ${calibration.samples.global} 个配对样本、${calibration.samples.providers} 个站点）`,
  }
}

/**
 * 按「预估输出长度」估算总等待时间。
 *
 * ## 为什么需要
 *
 * 只看首字会选错站。两种典型的站：
 *
 *   站 A：首字 1s，吐字 5 tok/s      （快启动，慢生成）
 *   站 B：首字 4s，吐字 50 tok/s     （慢启动，快生成）
 *
 * 短回答（200 token）：A = 1 + 40 = 41s，B = 4 + 4 = 8s   → B 快 5 倍
 * 长回答（2000 token）：A = 1 + 400 = 401s，B = 4 + 40 = 44s → B 快 9 倍
 *
 * **长回答时 B 完胜。** 但如果只看首字，A（1s）会排在 B（4s）前面 —— 完全反了。
 *
 * ## 怎么估输出长度
 *
 * 三个信号，优先级从高到低：
 *   ① 客户端明确给了 `max_tokens` → 用它（这是硬上限，最接近真实）
 *   ② 该站该模型的历史平均输出长度（offerStats 里有 outputTokens / requests）
 *   ③ 兜底：一个保守的中位数（默认 500 token）
 *
 * 用 ② 而不是「全局平均」的原因：同一个模型在不同站上的输出长度往往相近，
 * 但不同模型差很多（推理模型动辄几千 token，对话模型几百）。
 *
 * @param {number} firstTokenMs 首字延迟（毫秒）
 * @param {number|null} msPerToken 每输出 token 的毫秒数（null = 不知道）
 * @param {number} expectedTokens 预估输出 token 数
 * @returns {{totalMs:number, firstTokenMs:number, genMs:number, known:boolean}}
 */
export function estimateTotalWait(firstTokenMs, msPerToken, expectedTokens) {
  const first = Number(firstTokenMs)
  const perTok = Number(msPerToken)
  const tokens = Number(expectedTokens)

  if (!Number.isFinite(first) || first <= 0) {
    return { totalMs: Number.POSITIVE_INFINITY, firstTokenMs: first, genMs: 0, known: false }
  }
  // 不知道吐字速度：只能按首字算，但要标 known=false 让调用方知道这是不完整的
  if (!Number.isFinite(perTok) || perTok <= 0) {
    return { totalMs: first, firstTokenMs: first, genMs: 0, known: false }
  }
  const gen = Number.isFinite(tokens) && tokens > 0 ? perTok * tokens : 0
  return { totalMs: first + gen, firstTokenMs: first, genMs: gen, known: true }
}

/**
 * 从 max_tokens 或历史统计里估「这次大概输出多少 token」。
 *
 * @param {object} opts
 * @param {number} [opts.maxTokens]      客户端给的硬上限
 * @param {number} [opts.historicalAvg]  该站该模型的历史平均输出
 * @param {number} [opts.fallback=500]   都没有时的保守估计
 * @returns {{tokens:number, source:'max-tokens'|'historical'|'fallback'}}
 */
export function estimateOutputTokens({ maxTokens = null, historicalAvg = null, fallback = 500 } = {}) {
  const max = Number(maxTokens)
  if (Number.isFinite(max) && max > 0) {
    // max_tokens 是上限不是预期值：真实输出通常是它的 30%~70%。
    // 直接用上限会把「长输出」的权重放得过大，用 0.5 倍更接近实际。
    return { tokens: Math.max(50, max * 0.5), source: 'max-tokens' }
  }
  const avg = Number(historicalAvg)
  if (Number.isFinite(avg) && avg > 0) return { tokens: avg, source: 'historical' }
  return { tokens: fallback, source: 'fallback' }
}
