/**
 * 真实请求的缓存样本（逐单，不抽样）。
 *
 * 为什么要单独存：命中率会折进价格决定选站，而以前唯一的真实数据是
 * `billingSamples` —— 那个每 20 单才记一条，抽样口径会把「一轮对话的第一条几乎不命中、
 * 后面全命中」这种结构抹平（实测同一站同一模型能差 30pp 以上），
 * 于是「按抽样中位排序」等于按抽样噪声排序。
 *
 * 存储形态：`<数据目录>/cache-samples/YYYY-MM-DD.ndjson`，一行一条 JSON。
 * - 追加写，不重写整个文件（老库 db.json 近 10MB，每单重写代价太大）；
 * - 一天一个文件，天然分片；读取时只看最近 N 天，不删除历史文件
 *   （数据目录属于受保护路径，程序不做删改，只做「读窗口」）；
 * - 同时维护一个内存环形缓冲，供「最近 50 单」这类即时查询，避免每次读盘。
 */

import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from './store.js'

/** 保留读取窗口（天）。更早的文件留在盘上，但不再参与统计。 */
export const SAMPLE_KEEP_DAYS = 14

/** 内存里保留的最近样本条数（只服务「最近 N 单」展示，不参与全量统计） */
export const RING_SIZE = 2000

const ring = []

export function samplesDir() {
  return join(dataDir(), 'cache-samples')
}

function dayKey(at) {
  const d = new Date(at)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 记录一单真实请求的缓存数字。
 * 失败只打日志：样本缺失只让统计变保守，不能因为它中断一次已经成功的转发。
 *
 * @param {{at?:number, offerId:string, providerId?:string, modelKey?:string, keyId?:string,
 *   promptTokens?:number|null, cachedTokens?:number, cacheWriteTokens?:number, stream?:boolean,
 *   warm?:boolean, warmHint?:string}} entry
 */
export async function recordCacheSample(entry) {
  if (!entry?.offerId) return null
  const at = Number.isFinite(entry.at) ? entry.at : Date.now()
  const row = {
    at,
    offerId: entry.offerId,
    providerId: entry.providerId || null,
    modelKey: entry.modelKey || null,
    keyId: entry.keyId || null,
    prompt: Number(entry.promptTokens) || 0,
    cached: Number(entry.cachedTokens) || 0,
    cacheWrite: Number(entry.cacheWriteTokens) || 0,
    stream: entry.stream === true,
    // 发请求前这条供给刚热过（十分钟内、规模相近）→ 这一单的「固定开销」不可信：
    // 几百 token 的追问会把 prompt 全算成站方多收。标了 warm 的样本只当上界用
    warm: entry.warm === true,
    warmHint: entry.warmHint || null,
  }
  if (row.prompt <= 0) return null

  ring.push(row)
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE)

  try {
    const dir = samplesDir()
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, `${dayKey(at)}.ndjson`), `${JSON.stringify(row)}\n`, 'utf8')
  } catch (error) {
    console.warn('[缓存样本] 追加失败：', error?.message || error)
  }
  return row
}

/** 同步读内存里的最近样本（按时间升序），供接口即时返回 */
export function recentCacheSamples(limit = 50) {
  const size = Math.max(1, Math.min(RING_SIZE, Number(limit) || 50))
  return ring.slice(-size)
}

/**
 * 读最近 N 天的全部样本（按时间升序）。
 * 文件不存在、半行（进程被杀时最后一行可能不完整）都直接跳过。
 *
 * @param {{days?:number, now?:number}} options
 */
export async function readCacheSamples({ days = SAMPLE_KEEP_DAYS, now = Date.now() } = {}) {
  const dir = samplesDir()
  let files = []
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const earliest = now - Math.max(1, days) * 24 * 60 * 60 * 1000
  const rows = []
  for (const name of files) {
    if (!name.endsWith('.ndjson')) continue
    const day = name.slice(0, name.length - '.ndjson'.length)
    const dayStart = Date.parse(`${day}T00:00:00`)
    if (Number.isFinite(dayStart) && dayStart + 24 * 60 * 60 * 1000 < earliest) continue
    let text = ''
    try {
      text = await readFile(join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (!row?.offerId || !Number.isFinite(row.at)) continue
        if (row.at < earliest) continue
        rows.push(row)
      } catch {
        // 半行/坏行：跳过，不影响其它样本
      }
    }
  }
  rows.sort((a, b) => a.at - b.at)
  return rows
}

/** 清空内存环形（测试用；不动磁盘文件） */
export function resetCacheSampleRing() {
  ring.length = 0
}