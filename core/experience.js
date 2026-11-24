/**
 * 体验分：同一个模型下，这家的「快」值多少。
 *
 * 为什么不用固定阈值（2000ms / 40 tok/s）：那类数字没人知道该填多少，填错一次
 * 就把整张排名带偏；而且不同模型的速度基线本来就不同（推理模型 vs 轻量模型）。
 *
 * 这里用「尺子」而不是「靶子」：
 *   首字分 = 同模型全部在售供给的首字中位 ÷ 本站首字
 *   速度分 = 本站输出速度 ÷ 同模型的速度中位
 * 于是 1.00 天然就是「这个模型的中位水平」，不需要任何人拍数字。
 *
 * 刻意不设上下限：快于中位的站得 >1，慢的得 <1，对称；同时「没测到」按 1.00
 * （中位水平）计，既不奖励也不惩罚——这比给个 0.5 的中间值更说得通。
 *
 * 这两项只描述「用起来爽不爽」，不描述「靠不靠得住」：可靠度（可用率 × 完整性）
 * 在 score.js 里单独算，两者在选站时相乘，不要混成一个数。
 */

export const EXPERIENCE_WEIGHTS = { ttft: 0.6, tps: 0.4 }

/** 没测到时的取值：中位水平，不奖不罚。 */
export const EXPERIENCE_PRIOR = 1

function finitePositive(value) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : null
}

export function medianOf(values) {
  const list = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (list.length === 0) return null
  const mid = Math.floor(list.length / 2)
  return list.length % 2 === 1 ? list[mid] : (list[mid - 1] + list[mid]) / 2
}

/**
 * 一个模型这一轮的「尺子」。
 * @param {Array<{ttftMs?:number|null, tps?:number|null}>} rows
 * @returns {{ttft: number|null, tps: number|null, samples: number}}
 */
export function experienceBaselines(rows) {
  const ttfts = []
  const speeds = []
  for (const row of rows || []) {
    const ttft = finitePositive(row?.ttftMs)
    if (ttft) ttfts.push(ttft)
    const tps = finitePositive(row?.tps)
    if (tps) speeds.push(tps)
  }
  return {
    ttft: medianOf(ttfts),
    tps: medianOf(speeds),
    samples: Math.max(ttfts.length, speeds.length),
  }
}

/**
 * 单条的体验分。
 * @returns {{score:number, ttftScore:number, tpsScore:number, source:string}}
 *   source: 'measured'（有速度证据）/ 'none'（两项都没测到，按中位水平 1.00）
 */
export function experienceScore(row, baseline) {
  const ttft = finitePositive(row?.ttftMs)
  const tps = finitePositive(row?.tps)
  const baseTtft = finitePositive(baseline?.ttft)
  const baseTps = finitePositive(baseline?.tps)

  // 没测到（或尺子本身没有样本）→ 中位水平，不奖不罚
  const ttftScore = ttft && baseTtft ? baseTtft / ttft : EXPERIENCE_PRIOR
  const tpsScore = tps && baseTps ? tps / baseTps : EXPERIENCE_PRIOR
  const score = Math.pow(ttftScore, EXPERIENCE_WEIGHTS.ttft) * Math.pow(tpsScore, EXPERIENCE_WEIGHTS.tps)
  return {
    score,
    ttftScore,
    tpsScore,
    source: ttft || tps ? 'measured' : 'none',
  }
}

/**
 * 一轮候选的体验分表：先取尺子，再逐条算。
 * @param {Array<{offerId:string, ttftMs?:number|null, tps?:number|null}>} rows
 * @returns {{map: Map<string, any>, baseline: ReturnType<typeof experienceBaselines>}}
 */
export function experienceScores(rows) {
  const baseline = experienceBaselines(rows)
  const map = new Map()
  for (const row of rows || []) {
    map.set(row.offerId, { ...experienceScore(row, baseline), baseline })
  }
  return { map, baseline }
}

/** 展示用：把 1.72 这种分数讲成「比中位好/差多少」。 */
export function describeExperience(score) {
  const value = Number(score)
  if (!Number.isFinite(value) || value === EXPERIENCE_PRIOR) return '中位水平'
  return value > EXPERIENCE_PRIOR
    ? `比中位快 ${((value - 1) * 100).toFixed(0)}%`
    : `比中位慢 ${((1 - value) * 100).toFixed(0)}%`
}