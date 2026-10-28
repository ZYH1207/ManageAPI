/**
 * 基准价表：中转站的「倍率」需要一个参照物才能换算成绝对价格。
 *
 * 两个来源：
 *   1. 从「你信得过的那个站」的实际标价导入（更可信，主路径）
 *   2. 内置官方参考价（`model-prices.js`），解决「不知道官方价」的冷启动问题
 *
 * 内置参考价**不会自动生效**——必须用户主动点「载入参考价」才写入，
 * 而且只补空缺、不覆盖已有条目。宁可空着，也不偷偷给错数。
 *
 * 文件存在 ~/.manage-api/benchmark.json，可手工编辑。
 */
import { join } from 'node:path'
import { readFile, mkdir } from 'node:fs/promises'
import { dataDir } from './store.js'
import { writeJsonAtomic } from './fsx.js'
import { resolveReference } from './model-prices.js'

function filePath() {
  return join(dataDir(), 'benchmark.json')
}

/**
 * 种子数据：只放价格长期稳定的经典模型，用来让新用户第一眼看到比价效果。
 * 2026 年的新模型一律留空，由用户自行导入——宁可空着，也不给错数。
 *
 * 国外模型的官方价是真美元 → 用 R.Dollar（RUSD）标注；
 * 站内美元与人民币 1:1，所以作为倍率参照时数值不受影响。
 */
const SEED = {
  'gpt-4o': { display: 'GPT-4o', in: 2.5, out: 10, currency: 'RUSD', source: 'seed' },
  'gpt-4o-mini': { display: 'GPT-4o mini', in: 0.15, out: 0.6, currency: 'RUSD', source: 'seed' },
  'claude-3-5-sonnet': { display: 'Claude 3.5 Sonnet', in: 3, out: 15, currency: 'RUSD', source: 'seed' },
  'deepseek-chat': { display: 'DeepSeek Chat', in: 0.27, out: 1.1, currency: 'RUSD', source: 'seed' },
}

export async function readBenchmarks() {
  const p = filePath()
  try {
    const raw = JSON.parse(await readFile(p, 'utf8'))
    return raw && typeof raw === 'object' ? raw : { ...SEED }
  } catch {
    return { ...SEED }
  }
}

export async function writeBenchmarks(table) {
  await mkdir(dataDir(), { recursive: true })
  await writeJsonAtomic(filePath(), table, 2)
  return table
}

// 读-改-写串行化（与 store.mutate / usage.writeChain 同一套思路）：HTTP 天然并发，
// 手动改价与「载入参考价 / 广场导入 / 从站导入」同时到达时，裸的读改写会
// 后写覆盖先写、先完成的修改静默丢失。这里曾是全项目唯一没串行化的存储。
let writeChain = Promise.resolve()

/**
 * 把一次「读-改-写」排进串行队列。mutate 函数拿到当前表、就地修改并返回；
 * 写盘由队列统一完成。返回 mutate 的返回值。导出给 server.js 的
 * import-plaza 等复合路径用，避免任何裸的「读→改→写」绕过队列。
 */
export function mutateBenchmarks(mutate) {
  const job = writeChain.then(async () => {
    const table = await readBenchmarks()
    const result = await mutate(table)
    await writeBenchmarks(table)
    return result
  })
  // 失败不断链：下一个操作照常排队，但错误要冒给调用方
  writeChain = job.catch(() => {})
  return job
}

/** 单条写入/覆盖一个基准价。币种只认 USD / CNY / RUSD（真实美元）。 */
export function setBenchmark(modelKey, entry) {
  return mutateBenchmarks((table) => {
    const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))
    const currency = String(entry.currency || '').toUpperCase()
    table[modelKey] = {
      display: entry.display || modelKey,
      in: num(entry.in),
      out: num(entry.out),
      // 峰谷：留空表示该模型没有分时段定价
      offPeakIn: num(entry.offPeakIn),
      offPeakOut: num(entry.offPeakOut),
      currency: currency === 'CNY' || currency === 'RUSD' ? currency : 'USD',
      source: entry.source || 'manual',
      updatedAt: new Date().toISOString(),
    }
    return table[modelKey]
  })
}

export function deleteBenchmark(modelKey) {
  return mutateBenchmarks((table) => {
    delete table[modelKey]
    return { deleted: modelKey }
  })
}

/**
 * 把内置参考价里能匹配上的模型写入基准价表。
 * 只补缺失的，不覆盖已有条目——用户手填或从站导入的更可信。
 * daemon 启动时会自动跑一次（这是「默认录进系统」的唯一入口），
 * 基准价页的「载入内置参考价」按钮也走这里。
 */
export function seedReferenceBenchmarks(modelKeys) {
  return mutateBenchmarks((table) => {
    const added = []
    const skipped = []
    for (const key of modelKeys) {
      if (!key) continue
      const existing = table[key]
      // 用户手填或从站导入的，绝不覆盖；自家写入的（seed / reference）可以刷新，
      // 否则参考价库更新后旧条目（含币种口径）永远停留在老版本上
      const source = String(existing?.source || '')
      if (existing && source !== 'seed' && !source.startsWith('reference:')) {
        skipped.push(key)
        continue
      }
      const ref = resolveReference(key)
      if (!ref) {
        skipped.push(key)
        continue
      }
      table[key] = {
        display: key,
        in: ref.in,
        out: ref.out,
        offPeakIn: ref.offPeakIn ?? null,
        offPeakOut: ref.offPeakOut ?? null,
        currency: ref.currency,
        source: `reference:${ref.matchedKey}`,
        updatedAt: new Date().toISOString(),
      }
      added.push({ modelKey: key, matchedKey: ref.matchedKey, in: ref.in, out: ref.out, currency: ref.currency })
    }
    return { added, skipped, total: Object.keys(table).length }
  })
}

/**
 * 把某个站已填好的实际价，整体设为基准。
 * 找一个你确信「没虚标」的站，一键导入。
 */
export function importBenchmarksFrom(offers, providerId) {
  return mutateBenchmarks((table) => {
    let imported = 0
    for (const offer of offers) {
      if (offer.providerId !== providerId) continue
      if (offer.pricingMode === 'ratio') continue
      if (offer.inPrice === null && offer.outPrice === null) continue
      const key = offer.modelKey || offer.upstreamName
      table[key] = {
        display: offer.upstreamName,
        in: offer.inPrice === null ? null : Number(offer.inPrice),
        out: offer.outPrice === null ? null : Number(offer.outPrice),
        currency: offer.currency === 'CNY' ? 'CNY' : 'USD',
        source: `imported:${providerId}`,
        updatedAt: new Date().toISOString(),
      }
      imported += 1
    }
    return { imported, total: Object.keys(table).length }
  })
}
