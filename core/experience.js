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

import { MIN_BUCKET_SAMPLES } from './speed-profile.js'

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
 * 一个模型这一轮的「尺子」，分成两档。
 *
 * 为什么要分档：探针发的是 1k 级短请求，实测首字 3 秒上下；真实请求是十几万
 * token 的长前缀，同一时刻首字中位 9~14 秒。同一个「1.00」在两档里等于完全
 * 不同的绝对时间，混着比就是把苹果和梨相加。
 *
 * 所以每档各用各的中位当尺子，且都以 1.00 为「该档之中的中位水平」——
 * 数字之间可以直接比大小（都是相对分），但只有拿到真实数据的站才允许超过 1.00：
 * 探针档只能证明「不慢」，不能证明「比有实测的站更快」。
 *
 * @param {Array<{ttftMs?:number|null, tps?:number|null,
 *   trafficTtftMs?:number|null, trafficTps?:number|null}>} rows
 */
export function experienceBaselines(rows) {
  const probeTtfts = []
  const probeSpeeds = []
  const realTtfts = []
  const realSpeeds = []
  for (const row of rows || []) {
    // 真实流量优先：有真实样本就整条走真实档，不把两种量纲混成一把尺子
    const realTtft = finitePositive(row?.trafficTtftMs)
    const realTps = finitePositive(row?.trafficTps)
    // 尺子只能用「同一档」的样本量出来。一个站只有 50k 的样本、却拿它去量 200k 的
    // 请求，量出来的数偏快；把它算进中位会把整把尺子拉快，让真正扛长前缀的站显得更慢。
    // 所以这种「未同档」的样本不参与造尺子，只参与自己那一条的打分（并且不给超额）。
    const sameSize = row?.trafficTtftMatched !== false
    if (realTtft || realTps) {
      if (sameSize) {
        if (realTtft) realTtfts.push(realTtft)
        if (realTps) realSpeeds.push(realTps)
      }
      continue
    }
    const ttft = finitePositive(row?.ttftMs)
    if (ttft) probeTtfts.push(ttft)
    const tps = finitePositive(row?.tps)
    if (tps) probeSpeeds.push(tps)
  }
  return {
    // 老字段：探针档（保持既有调用方与测试的语义不变）
    ttft: medianOf(probeTtfts),
    tps: medianOf(probeSpeeds),
    samples: Math.max(probeTtfts.length, probeSpeeds.length),
    probe: {
      ttft: medianOf(probeTtfts),
      tps: medianOf(probeSpeeds),
      samples: Math.max(probeTtfts.length, probeSpeeds.length),
    },
    real: {
      ttft: medianOf(realTtfts),
      tps: medianOf(realSpeeds),
      samples: Math.max(realTtfts.length, realSpeeds.length),
    },
  }
}

/**
 * 单条的体验分。
 *
 * @returns {{score:number, ttftScore:number, tpsScore:number, source:'real'|'probe'|'none',
 *   tier:'real'|'probe', capped:boolean, bucket:string|null, bucketMatched:boolean}}
 *   source: 'real' 走真实流量档 / 'probe' 只有探针数据 / 'none' 什么都没测到
 *   capped: 分数被压回 1.00（探针档，或真实档但缺同档样本——没有实测就不给超额）
 *   bucketMatched: 这条真实样本是不是「与本次请求同样大小」的那一档
 */
export function experienceScore(row, baseline) {
  const realTtft = finitePositive(row?.trafficTtftMs)
  const realTps = finitePositive(row?.trafficTps)
  const hasReal = Boolean(realTtft || realTps)

  // 选档：有真实样本走真实档，否则走探针档；两档各用各的中位
  const tier = hasReal ? 'real' : 'probe'
  const ttft = hasReal ? realTtft : finitePositive(row?.ttftMs)
  const tps = hasReal ? realTps : finitePositive(row?.tps)
  // 注意：baseline 可能只有老字段（ttft/tps），那是探针档的中位——真实档必须
  // 用 baseline.real，拿不到就退回老字段，否则两档会悄悄共用一把尺子。
  const base = hasReal ? baseline?.real || baseline : baseline?.probe || baseline
  const baseTtft = finitePositive(base?.ttft)
  const baseTps = finitePositive(base?.tps)

  // 没测到（或尺子本身没有样本）→ 中位水平，不奖不罚
  const ttftScore = ttft && baseTtft ? baseTtft / ttft : EXPERIENCE_PRIOR
  const tpsScore = tps && baseTps ? tps / baseTps : EXPERIENCE_PRIOR
  const raw = Math.pow(ttftScore, EXPERIENCE_WEIGHTS.ttft) * Math.pow(tpsScore, EXPERIENCE_WEIGHTS.tps)
  // 探针只能证明「不慢」，不能证明「比有实测的更快」：上限压到中位水平。
  // 下限不设——探针测出来明显慢的站照样该被降权。
  // 真实档也有一个同款陷阱：这个站确实有实测，但一批样本都不是本次请求这个大小
  // （只有 50k 的样本，却要判 200k 的请求）。拿别的大小的首字当证据，等于替它
  // 担保一件没测过的事，所以同样不给超额——与探针档共用一个上限。
  const bucketMatched = row?.trafficTtftMatched !== false
  const overclaim = tier === 'probe' || !bucketMatched
  // 证据太少时只说明「这一次」，不能据此判生死：一条 200 token 的短回答测出 tps=2.8，
  // 不等于这家站慢 40%（那条样本里解码阶段只有几百毫秒，误差比信号大）。
  // 样本越少越往 1.00 收缩，同档攒到 MIN_BUCKET_SAMPLES 条才全额计入偏差。
  // 不传样本数（老调用方）按「证据充分」处理，保持既有语义。
  const evidenceSamples = Number(row?.trafficSpeedSamples)
  const confidence =
    tier === 'real' && Number.isFinite(evidenceSamples) && evidenceSamples > 0
      ? Math.min(1, evidenceSamples / MIN_BUCKET_SAMPLES)
      : 1
  const damped = EXPERIENCE_PRIOR + (raw - EXPERIENCE_PRIOR) * confidence
  const capped = overclaim && damped > EXPERIENCE_PRIOR
  const score = capped ? EXPERIENCE_PRIOR : damped
  return {
    score,
    ttftScore,
    tpsScore,
    source: ttft || tps ? tier : 'none',
    tier,
    capped,
    // 这一条打分用了多少样本、按多大比例计入偏差（1 = 全额）
    confidence,
    samples: Number.isFinite(evidenceSamples) && evidenceSamples > 0 ? evidenceSamples : null,
    // 这条证据取自哪一档（'short'/'mid'/'long'）；null = 没有同档样本、退回了全档
    bucket: row?.trafficTtftBucket ?? null,
    bucketMatched,
    // 界面要能写清「这个分是按谁算的」：实测档给真实首字/速度，探针档给探针值
    ttftMs: ttft,
    tps,
  }
}

/**
 * 一轮候选的体验分表：先取两档的尺子，再逐条算。
 *
 * @param {Array<{offerId:string, ttftMs?:number|null, tps?:number|null,
 *   trafficTtftMs?:number|null, trafficTps?:number|null}>} rows
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