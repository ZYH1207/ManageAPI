/**
 * 逐条用量账本：每次请求一行，按天一个文件，追加写。
 *
 * 为什么另开一份，而不是把决策日志（db.routing）加大：
 *   - 决策日志每条带着候选详情（实测 4.1KB，其中 3.5KB 是 candidates），
 *     500 条就 2MB，而 db.json 每次写都要整份重写（每 2 秒一批）——
 *     往那个方向加成 5000 条就是 20MB 每 2 秒重写一次，磁盘直接被打爆。
 *   - 「详细用量」要的是逐条数字（token / 首字 / 耗时 / 换站原因），
 *     不要候选详情：去掉 candidates 后每条约 300 字节，可以放心存很多天。
 *   - 追加写是 O(1)，和库大小无关；按天分文件，过期就整文件删掉，不用改写。
 *
 * 与 usage.json 的分工：
 *   usage.json     全量聚合（按天 × Key × 站点 × 分组 × 模型），**总量的唯一来源**
 *   usage-detail/  逐条明细（保留 N 天），只用来展开「每一条长什么样」
 * 所以日志/明细过期不影响总量——总量从来不从日志算。
 */
import { join } from 'node:path'
import { mkdir, appendFile, readdir, readFile, unlink } from 'node:fs/promises'
import { dataDir } from './store.js'
import { localDayKey } from './usage.js'

/** 明细保留天数。30 天足够回溯对账；再多就该看聚合而不是逐条了。 */
export const DETAIL_RETENTION_DAYS = 30

/** 单天最多记多少条：防一次意外刷量把一天的文件写到几百 MB */
const MAX_ROWS_PER_DAY = 200000

let writeChain = Promise.resolve()
const rowCountByDay = new Map()

function detailDir() {
  return join(dataDir(), 'usage-detail')
}

function fileOf(day) {
  return join(detailDir(), `${day}.jsonl`)
}

/**
 * 决策日志条目 → 账本条目：只留「详细用量」要显示的字段。
 * 取舍标准：这一行在界面上有列，就留；没有（candidates / explain）就丢。
 */
export function ledgerEntry(entry = {}) {
  return {
    id: entry.id || null,
    ts: entry.ts || new Date().toISOString(),
    model: entry.model || '',
    keyId: entry.keyId || null,
    keyName: entry.keyName || null,
    providerId: entry.chosenProviderId || null,
    providerName: entry.chosenProviderName || null,
    upstreamModel: entry.upstreamModel || null,
    group: entry.chosenGroup || '',
    pool: entry.pool || null,
    protocol: entry.protocol || null,
    stream: typeof entry.stream === 'boolean' ? entry.stream : null,
    attempts: Number(entry.attempts) || 1,
    outcome: entry.outcome || 'unknown',
    ttftMs: entry.ttftMs ?? null,
    latencyMs: entry.latencyMs ?? null,
    usage: entry.usage || null,
    // 换站原因要留着：这就是「为什么这条不是首选站」的答案
    failures: (entry.failures || []).map((f) => ({
      providerName: f.providerName || '',
      error: f.error || '',
      ms: Number(f.ms) || null,
    })),
  }
}

/**
 * 追加一批明细（串行，避免并发写同一个文件交错）。
 * 写失败只打日志，不影响请求本身——明细是观测数据，不能因为它挂掉业务。
 */
export async function appendDetail(entries = []) {
  if (!entries.length) return
  const byDay = new Map()
  for (const entry of entries) {
    const row = ledgerEntry(entry)
    const day = localDayKey(row.ts)
    const list = byDay.get(day) || []
    list.push(row)
    byDay.set(day, list)
  }

  writeChain = writeChain
    .then(async () => {
      await mkdir(detailDir(), { recursive: true })
      for (const [day, rows] of byDay) {
        const used = rowCountByDay.get(day) ?? 0
        if (used >= MAX_ROWS_PER_DAY) continue
        const room = Math.max(0, MAX_ROWS_PER_DAY - used)
        const take = rows.slice(0, room)
        await appendFile(fileOf(day), take.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
        rowCountByDay.set(day, used + take.length)
      }
    })
    .catch((error) => {
      console.error('[用量明细] 写盘失败（不影响请求）：', error)
    })
  return writeChain
}

/** 读某几天的明细（day 是本地日期键 YYYY-MM-DD），按文件顺序返回 */
export async function readDetail(dayKeys = []) {
  const out = []
  for (const day of dayKeys) {
    let raw = ''
    try {
      raw = await readFile(fileOf(day), 'utf8')
    } catch {
      continue // 那天没有明细（没流量 / 已过期）
    }
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        /* 半截行（进程被杀）跳过，不要让一行坏数据毁掉整天的明细 */
      }
    }
  }
  return out
}

/** 明细目录里现存的日期键（升序） */
export async function listDetailDays() {
  try {
    const names = await readdir(detailDir())
    return names
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
      .map((n) => n.slice(0, 10))
      .sort()
  } catch {
    return []
  }
}

/** 删掉超过保留期的明细文件。启动时跑一次就够。 */
export async function pruneDetail(keepDays = DETAIL_RETENTION_DAYS) {
  const days = await listDetailDays()
  if (!days.length) return 0
  const cutoff = localDayKey(new Date(Date.now() - Math.max(1, keepDays) * 86400000))
  let removed = 0
  for (const day of days) {
    if (day >= cutoff) continue
    try {
      await unlink(fileOf(day))
      rowCountByDay.delete(day)
      removed += 1
    } catch {
      /* 别的进程删过了 */
    }
  }
  return removed
}
