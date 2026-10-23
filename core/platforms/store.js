/**
 * 平台与账号的持久化：独立文件 free.json。
 *
 * 为什么单独一个文件而不是塞进 db.json：
 *   免费池和付费比价是两条独立的供给线，平台账号里还存着授权密文。
 *   混进主库会让「导出付费配置」顺手把免费池的凭据一起带走。
 *
 * 写法对齐 core/store.js：读-改-写 + 写 tmp 再 rename。
 * 区别是写入要串行化——签到和网关扣额度可能并发进来，
 * 而 mutate 的回调是同步的，并发读-改-写会互相覆盖。
 */
import { join } from 'node:path'
import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dataDir } from '../store.js'

const FREE_DB_VERSION = 1
const ACCOUNT_STATUSES = ['ok', 'expired', 'exhausted']

export function freeDbPath() {
  return join(dataDir(), 'free.json')
}

/**
 * 与 inventory.js 的 newId 同一约定，但刻意不 import 它——
 * 免费池的数据层要能独立于付费台账存在，少一条依赖就少一处耦合。
 */
export function newId(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`
}

export function nowIso() {
  return new Date().toISOString()
}

export function emptyFreeDb() {
  return {
    version: FREE_DB_VERSION,
    platforms: [],
    accounts: [],
    activeAccount: {},
    ledger: [],
  }
}

async function exists(p) {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function readFreeDb() {
  const p = freeDbPath()
  if (!(await exists(p))) return emptyFreeDb()
  let raw
  try {
    raw = JSON.parse(await readFile(p, 'utf8'))
  } catch (error) {
    throw new Error(`免费池数据文件解析失败：${p}（${error.message}）`)
  }
  return {
    version: FREE_DB_VERSION,
    platforms: Array.isArray(raw?.platforms) ? raw.platforms : [],
    accounts: Array.isArray(raw?.accounts) ? raw.accounts : [],
    activeAccount:
      raw?.activeAccount && typeof raw.activeAccount === 'object' ? raw.activeAccount : {},
    ledger: Array.isArray(raw?.ledger) ? raw.ledger : [],
  }
}

export async function writeFreeDb(db) {
  await mkdir(dataDir(), { recursive: true })
  const p = freeDbPath()
  const tmp = `${p}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(db, null, 2), 'utf8')
  await rename(tmp, p)
}

let writeQueue = Promise.resolve()

/** 读 → 改 → 原子写。回调可以直接修改传入的 db 对象。 */
export function mutateFree(fn) {
  const run = writeQueue.then(async () => {
    const db = await readFreeDb()
    const result = await fn(db)
    await writeFreeDb(db)
    return result
  })
  // 上一次写入失败不能让队列永久卡死，所以这里吞掉错误、只把它交给调用方
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * 归一化配额。表单传来的是字符串，这里统一成数字；
 * 单位和窗口只接受约定值，非法值退回默认——否则渲染层会写出「undefined 次」。
 *
 * 刻意不导出：额度怎么推算（重置、跨单位比较）是另一层的事，
 * 存储层只负责把落库前的数据洗干净，少一个同名导出就少一处调用歧义。
 */
function normalizeQuota(input) {
  if (!input) return null
  const num = (value, fallback = 0) => {
    if (value === null || value === undefined || value === '') return fallback
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }
  return {
    unit: ['credit', 'request', 'token'].includes(input.unit) ? input.unit : 'credit',
    limit: num(input.limit, 0),
    used: Math.max(0, num(input.used, 0)),
    window: input.window === 'month' ? 'month' : 'day',
    resetAt: input.resetAt || null,
  }
}

// ----------------------------------------------------------------- platforms

export async function listPlatforms() {
  const db = await readFreeDb()
  return db.platforms
}

/**
 * 建或改一个平台。
 *
 * 有 id 就按 id 改；没有 id 就按 connectorId 找——同一个连接器只该有一张卡，
 * 「再连一次」是幂等的，不该长出两张一模一样的卡片。
 */
export async function upsertPlatform(input = {}) {
  const connectorId = String(input.connectorId || '').trim()
  if (!connectorId) throw new Error('缺少 connectorId')

  return mutateFree((db) => {
    const id = input.id ? String(input.id) : ''
    // 真实连接器一个平台只有一个实例，重复 upsert 视为更新；
    // 手动连接器允许建多个（Trae、WorkBuddy、别的），所以不去重。
    const existing = id
      ? db.platforms.find((p) => p.id === id)
      : connectorId === 'manual'
        ? null
        : db.platforms.find((p) => p.connectorId === connectorId)

    if (existing) {
      if (input.connectorId !== undefined) existing.connectorId = connectorId
      if (input.label !== undefined) existing.label = String(input.label).trim() || existing.label
      if (input.enabled !== undefined) existing.enabled = Boolean(input.enabled)
      return existing
    }

    const platform = {
      id: newId('pf'),
      connectorId,
      label: String(input.label || connectorId).trim() || connectorId,
      enabled: input.enabled === undefined ? true : Boolean(input.enabled),
      createdAt: nowIso(),
    }
    db.platforms.push(platform)
    return platform
  })
}

/** 删平台要级联清账号与账本，否则 free.json 里会留下一堆孤儿记录只增不减。 */
export async function deletePlatform(id) {
  return mutateFree((db) => {
    const before = db.platforms.length
    db.platforms = db.platforms.filter((p) => p.id !== id)
    if (db.platforms.length === before) throw new Error(`平台不存在：${id}`)

    const accountIds = new Set(
      db.accounts.filter((a) => a.platformId === id).map((a) => a.id),
    )
    db.accounts = db.accounts.filter((a) => a.platformId !== id)
    db.ledger = db.ledger.filter((row) => !accountIds.has(row.accountId))
    delete db.activeAccount[id]
    return { deleted: id, removedAccounts: accountIds.size }
  })
}

// ------------------------------------------------------------------ accounts

export async function listAccounts(platformId) {
  const db = await readFreeDb()
  if (!platformId) return db.accounts
  return db.accounts.filter((a) => a.platformId === platformId)
}

export async function addAccount(input = {}) {
  const platformId = String(input.platformId || '').trim()
  if (!platformId) throw new Error('缺少 platformId')

  return mutateFree((db) => {
    if (!db.platforms.some((p) => p.id === platformId)) {
      throw new Error(`平台不存在：${platformId}`)
    }
    const account = {
      id: newId('pa'),
      platformId,
      label: String(input.label || '').trim() || '默认账号',
      status: ACCOUNT_STATUSES.includes(input.status) ? input.status : 'ok',
      lastCheckinAt: null,
      quota: normalizeQuota(input.quota),
      // 明文授权信息由调用方先加密再传进来；这里不碰加解密，避免存储层依赖 crypto 细节
      secret: input.secret ?? null,
      createdAt: nowIso(),
    }
    db.accounts.push(account)
    // 第一个账号自动设成活跃，省掉「加完还要再点一次」
    if (!db.activeAccount[platformId]) db.activeAccount[platformId] = account.id
    return account
  })
}

export async function updateAccount(id, patch = {}) {
  return mutateFree((db) => {
    const account = db.accounts.find((a) => a.id === id)
    if (!account) throw new Error(`账号不存在：${id}`)

    if (patch.label !== undefined) account.label = String(patch.label).trim() || account.label
    if (patch.status !== undefined) {
      if (!ACCOUNT_STATUSES.includes(patch.status)) throw new Error(`未知的账号状态：${patch.status}`)
      account.status = patch.status
    }
    if (patch.quota !== undefined) {
      account.quota = patch.quota === null ? null : normalizeQuota(patch.quota)
    }
    if (patch.secret !== undefined) account.secret = patch.secret
    if (patch.lastCheckinAt !== undefined) account.lastCheckinAt = patch.lastCheckinAt
    return account
  })
}

export async function deleteAccount(id) {
  return mutateFree((db) => {
    const before = db.accounts.length
    db.accounts = db.accounts.filter((a) => a.id !== id)
    if (db.accounts.length === before) throw new Error(`账号不存在：${id}`)

    db.ledger = db.ledger.filter((row) => row.accountId !== id)
    for (const [platformId, accountId] of Object.entries(db.activeAccount)) {
      if (accountId === id) delete db.activeAccount[platformId]
    }
    return { deleted: id }
  })
}

export async function getActiveAccount(platformId) {
  const db = await readFreeDb()
  const accountId = db.activeAccount[platformId]
  if (!accountId) return null
  return db.accounts.find((a) => a.id === accountId) || null
}

/** 传 null / undefined 表示取消活跃账号。 */
export async function setActiveAccount(platformId, accountId) {
  return mutateFree((db) => {
    if (!db.platforms.some((p) => p.id === platformId)) {
      throw new Error(`平台不存在：${platformId}`)
    }
    if (accountId === null || accountId === undefined) {
      delete db.activeAccount[platformId]
      return null
    }
    const account = db.accounts.find((a) => a.id === accountId)
    if (!account) throw new Error(`账号不存在：${accountId}`)
    // 跨平台设活跃账号几乎一定是调用方传错了 id，直接报错比默默写坏数据好
    if (account.platformId !== platformId) throw new Error('该账号不属于这个平台')
    db.activeAccount[platformId] = account.id
    return account
  })
}
