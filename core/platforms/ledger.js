/**
 * 额度账本与签到。
 *
 * 账本和 accounts 放同一个文件、同一次 mutateFree 里改，是因为
 * 「扣额度」和「记一笔」必须原子完成：分开写会出现扣了额度却没记账的中间态，
 * 之后按账本推算剩余天数就会偏乐观。
 */
import { newId, nowIso, readFreeDb, mutateFree } from './store.js'
// quota.js 零依赖、不回头 import 本目录，不会形成循环；周期重置逻辑与中转站侧共用一份
import { resetIfDue } from '../quota.js'
// 本地日期键全后端唯一实现（签到与用量必须同一口径）
import { localDayKey } from '../dates.js'

// 账本只留最近这么多条：free.json 每次写入都要整份序列化，
// 明细无限增长会让签到这种高频小操作越来越慢。汇总靠 quota 字段，不靠账本。
const LEDGER_MAX = 5000

// 「还能撑几天」的观测窗口
const RATE_WINDOW_DAYS = 7

function pushLedger(db, { accountId, kind, amount, unit, note }) {
  const entry = {
    id: newId('lg'),
    accountId,
    at: nowIso(),
    kind,
    amount: Number(amount) || 0,
    unit: unit || 'credit',
    note: String(note || ''),
  }
  db.ledger.push(entry)
  if (db.ledger.length > LEDGER_MAX) db.ledger = db.ledger.slice(-LEDGER_MAX)
  return entry
}

/** 按时间倒序；不传 accountId 就是全平台的流水。 */
export async function listLedger({ accountId = null, limit = 50 } = {}) {
  const db = await readFreeDb()
  const rows = accountId ? db.ledger.filter((row) => row.accountId === accountId) : [...db.ledger]
  // ISO 字符串按字典序比较即时间序，省一次 Date 解析
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  const max = Number(limit)
  return Number.isFinite(max) ? rows.slice(0, Math.max(0, max)) : rows
}

/**
 * 记一笔消耗：账本存负数，同时把账号的 used 往上加。
 * 入参 amount 要求是正数（「用掉 3 积分」），负数在这里取绝对值——
 * 调用方把符号搞反是很容易发生的事，与其报错不如按语义纠正。
 */
export async function consume(accountId, { amount, unit, note = '' } = {}) {
  const value = Math.abs(Number(amount))
  if (!Number.isFinite(value) || value <= 0) throw new Error('消耗额度需要是正数')

  return mutateFree((db) => {
    const account = db.accounts.find((a) => a.id === accountId)
    if (!account) throw new Error(`账号不存在：${accountId}`)

    const entry = pushLedger(db, {
      accountId,
      kind: 'consume',
      amount: -value,
      unit: unit || account.quota?.unit || 'credit',
      note,
    })

    if (account.quota) {
      // 跨过重置点先归零（与中转站侧 consumeFreeQuota 同口径）：used 只增不减的话，
      // 手动平台没有连接器来刷新，跨周期后剩余额度与 daysLeft 会一直偏悲观
      const quota = resetIfDue(account.quota)
      quota.used = (Number(quota.used) || 0) + value
      account.quota = quota
      // 手动连接器没有远端可查，本地扣到超限就是真的没了，卡片该立刻变红
      const limit = Number(quota.limit)
      if (Number.isFinite(limit) && limit > 0 && quota.used >= limit) {
        account.status = 'exhausted'
      }
    }
    return { entry, account }
  })
}

/**
 * 签到。幂等：同一本地日期只有第一次成功。
 *
 * reward 只进账本、不改 quota.limit —— 奖励怎么叠加各平台规则不同
 * （有的加到上限、有的单独计数），统一在这里猜会算错，留给 connector 自己处理。
 */
export async function checkin(accountId, { reward = 0, unit, note = '每日签到' } = {}) {
  return mutateFree((db) => {
    const account = db.accounts.find((a) => a.id === accountId)
    if (!account) throw new Error(`账号不存在：${accountId}`)

    const today = localDayKey()
    if (account.lastCheckinAt && localDayKey(account.lastCheckinAt) === today) {
      return { ok: false, alreadyToday: true, account }
    }

    const entry = pushLedger(db, {
      accountId,
      kind: 'checkin',
      amount: Math.abs(Number(reward) || 0),
      unit: unit || account.quota?.unit || 'credit',
      note,
    })
    account.lastCheckinAt = nowIso()
    return { ok: true, alreadyToday: false, entry, account }
  })
}

/**
 * 预计还能撑几天：剩余量 ÷ 最近 7 天的日均消耗。
 *
 * 固定除以 7（而不是「有记录的那几天」）是故意的：
 * 刚记一笔就按 1 天算会得出「只能撑 0.5 天」的抖动值，
 * 跨栏排序需要的是稳定的速率，宁可偏保守。
 *
 * 没有额度或没有消耗记录时返回 null —— 「不知道」和「0 天」是两回事。
 */
/**
 * 从已有的 free db 对象直接算 daysLeft（不重新读文件）。
 * freePlatformState（buildState）每轮会对每个平台调一次——此前经过
 * daysLeft → readFreeDb，P 个平台 = P 次全量 JSON.parse。
 */
export function daysLeftInDb(db, accountId) {
  const account = db.accounts.find((a) => a.id === accountId)
  if (!account?.quota) return null

  // 读的时候也按重置点归零（副本，不落盘）：夜里没消耗、第二天直接看卡片，
  // remaining 不该还背着昨天的 used
  const quota = resetIfDue(account.quota)
  const limit = Number(quota.limit)
  if (!Number.isFinite(limit) || limit <= 0) return null
  const remaining = Math.max(0, limit - (Number(quota.used) || 0))

  const since = Date.now() - RATE_WINDOW_DAYS * 86400000
  let spent = 0
  for (const row of db.ledger) {
    if (row.accountId !== accountId || row.kind !== 'consume') continue
    if (new Date(row.at).getTime() < since) continue
    spent += Math.abs(Number(row.amount) || 0)
  }
  if (spent <= 0) return null

  // 留一位小数：整数天会把 1.2 天和 1.9 天压成同一个数，排序就失去意义了
  return Math.round((remaining / (spent / RATE_WINDOW_DAYS)) * 10) / 10
}

export async function daysLeft(accountId) {
  const db = await readFreeDb()
  return daysLeftInDb(db, accountId)
}
