/**
 * 真实速度画像：把「一次真实请求有多快」变成可以横向比较的数字。
 *
 * 为什么不能直接拿「首字中位」比：首字不是一个站点常数，它是 prompt 大小的函数。
 * 实测（2026-11-26，同一台机器、同一批供给、缓存命中都报 99%）：
 *
 *   RapidApi   50–120k 档首字 5.3s   →  200k 以上 34.9s   （7 倍）
 *   codexpert  50–120k 档首字 6.7s   →  200k 以上 11.9s   （1.8 倍）
 *
 * 于是「A 站首字 33 秒」这句话单独看毫无意义：A 站可能只是恰好总在处理 20 万 token
 * 的请求。真正要比的是**同档之内**谁快——本次请求有多大，就跟同样大的那些样本比。
 *
 * 所以这里做三件事：
 *   1. 每条真实样本都带上它自己的 prompt 大小（token）；
 *   2. 按 prompt 大小分档，各档各取中位；
 *   3. 评分时按「本次请求落哪一档」取尺子，取不到同档样本就明确标记（不许假装同档）。
 *
 * 不设绝对毫秒阈值：见 router.js 文件头，2026-11 已经删过一次「首字上限」，
 * 那种固定数字换个模型或换个地区的链路就全错，而且会误杀全部供给。
 */

import { medianOf } from './traffic-profile.js'

/**
 * prompt 分档。边界取在这批真实数据自然分层的缝上（60k / 180k），
 * 不是为了好看：DSH 这类长会话的请求基本落在 180k 以上，探针是 45 token 级，
 * 中间那段（60k–180k）是压缩过上下文之后的常态。
 */
export const PROMPT_BUCKETS = [
  { key: 'short', max: 60_000, label: '短对话' },
  { key: 'mid', max: 180_000, label: '中等对话' },
  { key: 'long', max: Infinity, label: '长对话' },
]

/** 同档样本少于这个数就退回全档（并标记未同档），别拿 1 条样本当尺子。 */
export const MIN_BUCKET_SAMPLES = 3

/** 一次真实样本要留多少条。40 条按档一分，每档常常只剩个位数，所以放宽到 60。 */
export const SPEED_SAMPLE_KEEP = 60

/** 这个 prompt 大小落在哪一档；没有大小（老样本 / 估算失败）返回 null。 */
export function bucketOfPrompt(promptTokens) {
  const n = Number(promptTokens)
  if (!Number.isFinite(n) || n <= 0) return null
  for (const bucket of PROMPT_BUCKETS) {
    if (n < bucket.max) return bucket.key
  }
  return PROMPT_BUCKETS[PROMPT_BUCKETS.length - 1].key
}

/** 档位的人话名字（界面用；未知档返回空串，别硬写「未知」）。 */
export function bucketLabel(key) {
  return PROMPT_BUCKETS.find((bucket) => bucket.key === key)?.label || ''
}

/**
 * 把 traffic 行里的速度数据整理成样本数组。
 *
 * 兼容两种 schema：
 *   - 新：speed.rows = [{ttftMs, tps, promptTokens, cachedTokens, at}]
 *   - 老：speed.ttftMs / speed.tps 两条平行数组（没有 prompt 大小，只能进「全档」）
 */
export function speedRowsOf(speed) {
  if (!speed || typeof speed !== 'object') return []
  const rows = []
  if (Array.isArray(speed.rows)) {
    for (const row of speed.rows) {
      const ttftMs = Number(row?.ttftMs)
      if (!Number.isFinite(ttftMs) || ttftMs <= 0) continue
      const tps = Number(row?.tps)
      const promptTokens = Number(row?.promptTokens)
      const cachedTokens = Number(row?.cachedTokens)
      rows.push({
        ttftMs,
        tps: Number.isFinite(tps) && tps > 0 ? tps : null,
        promptTokens: Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : null,
        cachedTokens: Number.isFinite(cachedTokens) && cachedTokens >= 0 ? cachedTokens : null,
        at: row?.at ?? null,
      })
    }
  }
  if (rows.length === 0 && Array.isArray(speed.ttftMs)) {
    const tpsList = Array.isArray(speed.tps) ? speed.tps : []
    speed.ttftMs.forEach((value, index) => {
      const ttftMs = Number(value)
      if (!Number.isFinite(ttftMs) || ttftMs <= 0) return
      const tps = Number(tpsList[index])
      rows.push({
        ttftMs,
        tps: Number.isFinite(tps) && tps > 0 ? tps : null,
        promptTokens: null,
        cachedTokens: null,
        at: null,
      })
    })
  }
  return rows
}

/**
 * 某一档的统计量。key 为 null 表示「不分档，全部样本」。
 * @returns {{ttftMs:number|null, tps:number|null, samples:number}}
 */
export function bucketStats(rows, key = null) {
  const list = (rows || []).filter((row) => (key ? bucketOfPrompt(row?.promptTokens) === key : true))
  // 注意别直接 Number(null)：那是 0，会把「没有解码速度的样本」当成 0 tok/s 拉低中位
  const positive = (value) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  return {
    ttftMs: medianOf(list.map((row) => positive(row?.ttftMs))),
    tps: medianOf(list.map((row) => positive(row?.tps))),
    samples: list.length,
  }
}

/**
 * 给「本次请求」挑尺子。
 *
 * @param {object|null} speed traffic 行里的 speed 对象
 * @param {number} [promptTokens] 本次请求的 prompt 大小
 * @returns {{ttftMs:number|null, tps:number|null, samples:number, bucket:string|null,
 *   wantBucket:string|null, matched:boolean, byBucket:Object}}
 *   bucket: 这组数字实际取自哪一档（null = 全档）
 *   matched: 是否取到了「与本次请求同档」的样本。false 不等于没数据，
 *            而是「有数据但不同档」——调用方必须当它证据不足（见 experience.js）
 *            没有给定 promptTokens（列表/汇总这类「没有具体请求在定价」的场合）时
 *            不作同档声明，但也不算证据不足：此时全档中位就是总体本身，返回 true。
 */
export function selectBucketSpeed(speed, promptTokens = null) {
  const rows = speedRowsOf(speed)
  const byBucket = {}
  for (const bucket of PROMPT_BUCKETS) {
    const stats = bucketStats(rows, bucket.key)
    byBucket[bucket.key] = { ttftMs: stats.ttftMs, tps: stats.tps, samples: stats.samples }
  }
  const wantBucket = bucketOfPrompt(promptTokens)
  if (rows.length === 0) {
    return { ttftMs: null, tps: null, samples: 0, bucket: null, wantBucket, matched: false, byBucket }
  }
  if (wantBucket) {
    const own = bucketStats(rows, wantBucket)
    if (own.samples >= MIN_BUCKET_SAMPLES && own.ttftMs) {
      return { ...own, bucket: wantBucket, wantBucket, matched: true, byBucket }
    }
  }
  const all = bucketStats(rows, null)
  // wantBucket 为空 = 这次没有「某个具体请求」在定价（列表/汇总），全档中位就是总体，
  // 不存在跨档混算的问题；只有「给了大小却取不到同档样本」才算证据不足。
  return { ...all, bucket: null, wantBucket, matched: !wantBucket, byBucket }
}

/** 首字摊到每 1k prompt token 上是多少毫秒：一眼看出「长前缀惩罚」有多陡。 */
export function ttftMsPerKiloToken(ttftMs, promptTokens) {
  const ttft = Number(ttftMs)
  const prompt = Number(promptTokens)
  if (!Number.isFinite(ttft) || ttft <= 0) return null
  if (!Number.isFinite(prompt) || prompt <= 0) return null
  return (ttft / prompt) * 1000
}
