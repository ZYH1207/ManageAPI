/**
 * 存储层：数据目录定位、JSON 原子读写、凭据加解密。
 *
 * 设计约束：
 * - 数据目录独立于宿主（默认 ~/.manage-api），DSH 插件壳与独立 daemon 共用同一份。
 * - 单进程写入 + 原子替换（写 tmp 再 rename），避免半写坏文件。
 * - 凭据用 AES-256-GCM 加密，密钥存本地 master.key（0600）。
 *   威胁模型：防备份泄露 / 误传文件；不防本机已被攻破的情况。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile, chmod, access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { defaultMonitor, ensureMonitor } from './monitor.js'
import { writeJsonAtomic } from './fsx.js'

const DB_VERSION = 3

/** 写盘串行链（见 mutate） */
let writeChain = Promise.resolve()

/** 数据文件坏了要报 5xx，不能当「参数错误」——这类错误前端做什么都没用 */
export class StorageError extends Error {}

export function dataDir() {
  return process.env.MANAGE_API_HOME || join(homedir(), '.manage-api')
}

export function dbPath() {
  return join(dataDir(), 'db.json')
}

function keyPath() {
  return join(dataDir(), 'master.key')
}

export function emptyDb() {
  return {
    version: DB_VERSION,
    settings: {
      fxUsdCny: 7.2,
      // 汇率的正式结构（见 core/fx.js）：base 恒为 USD，rates[XXX] = 1 美元换多少 XXX。
      // fxUsdCny 只是给老代码留的镜像，每次写入都会同步。
      fx: { base: 'USD', rates: { CNY: 7.2 }, updatedAt: null, source: 'default', manual: false },
      blendInputWeight: 0.25,
      probeTimeoutMs: 45000,
      // 0 = 关闭定时探测
      probeIntervalMinutes: 60,
      // 超过这个小时数的探测结果视为过期，不再参与路由
      scoreMaxAgeHours: 6,
      // 首字延迟上限（毫秒），0 = 不限
      maxTtftMs: 0,
      // 放行可疑供给：默认 false，探针判定不可信/过期的会被排到后面。
      // 打开后它们按有效成本正常参与竞争——风险由用户自己承担。
      allowUntrusted: false,
      // 免费池跨栏偏好：同一个模型同时出现在中转站与平台时怎么选。
      //   'platform'  平台优先（更怕假货）
      //   'relay'     中转站优先（更怕断供）
      //   'remaining' 按「预计剩余天数」跨栏混排（默认）
      freeCrossPane: 'remaining',
      // 免费池耗尽时是否允许回落付费。默认关闭——静默花钱比报错更糟。
      allowPaidFallback: false,
      // 监控采集间隔（分钟），0 = 关闭。
      // 和探针是两个节奏：探针要打真实请求，成本高；采集只是读后台数据，可以更勤。
      monitorIntervalMinutes: 30,
      // 余额低于这个美元金额就告警（人民币站按汇率折算后比）。0 = 不告警。
      // 之所以用美元：中转站余额基本都是美元，用人民币要先折一次，多一层容易错。
      balanceWarnUsd: 1.5,
      // 价格展示币种：只影响渲染，不影响比较口径（比较一律用美元）。
      displayCurrency: 'USD',
    // 全局忽略的模型（归一化后的 key）：不参与比价、决策、探针、网关
    ignoredModels: [],
    },
    providers: [],
    credentials: [],
    offers: [],
    probes: [],
    // 监控时序数据（余额快照 / 倍率变动 / 公告 / 告警）
    monitor: defaultMonitor(),
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

let keyCache = null

async function masterKey() {
  if (keyCache) return keyCache
  await mkdir(dataDir(), { recursive: true })
  const p = keyPath()
  if (await exists(p)) {
    const hex = (await readFile(p, 'utf8')).trim()
    if (hex.length !== 64) throw new Error(`master.key 格式异常：${p}`)
    keyCache = Buffer.from(hex, 'hex')
    return keyCache
  }
  const key = randomBytes(32)
  await writeFile(p, key.toString('hex'), { mode: 0o600 })
  try {
    await chmod(p, 0o600)
  } catch {
    /* Windows 上 chmod 语义有限，忽略 */
  }
  keyCache = key
  return keyCache
}

/** 加密一个明文密钥，返回可直接存进 JSON 的对象。 */
export async function encryptSecret(plain) {
  if (!plain) return null
  const key = await masterKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

/** 解密；失败返回空串，让调用方按"无凭据"处理而不是崩掉。 */
export async function decryptSecret(blob) {
  if (!blob || !blob.data) return ''
  try {
    const key = await masterKey()
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(blob.data, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * 版本迁移。每段都必须是幂等的——用户可能从任意老版本跨级升上来。
 *
 * v1 → v2：把「令牌 / 余额」从 Key 上挪到站点上。
 *   原因：令牌是站点后台的登录凭证，余额是账号余额——两者都跟 Key 无关。
 *   挂在 Key 上会导致「加第二个 Key 后余额显示 0」「换个 Key 就要重填令牌」。
 *   迁移是就地提升：取该站第一个填过令牌的 Key，复制到站点上。
 *   Key 上的旧字段保留不删，万一要回滚还能读。
 *
 * v2 → v3：新增 monitor（余额快照 / 倍率变动 / 公告 / 告警），纯追加，补齐默认值即可。
 */
function migrate(db) {
  const version = Number(db.version) || 1
  if (version >= DB_VERSION) {
    ensureMonitor(db)
    return db
  }

  for (const provider of db.providers || []) {
    const mine = (db.credentials || []).filter((c) => c.providerId === provider.id)
    if (!provider.adminToken) {
      const withToken = mine.find((c) => c.adminToken)
      if (withToken) {
        provider.adminToken = withToken.adminToken
        provider.adminTokenTail = withToken.adminTokenTail ?? null
      }
    }
    if (provider.quotaRemaining === undefined || provider.quotaRemaining === null) {
      const withQuota = mine.find((c) => typeof c.quotaRemaining === 'number')
      if (withQuota) {
        provider.quotaRemaining = withQuota.quotaRemaining
        provider.currency = withQuota.currency || 'CNY'
        provider.quotaUpdatedAt = withQuota.quotaUpdatedAt ?? null
      }
    }
  }
  db.version = DB_VERSION
  ensureMonitor(db)
  return db
}

export async function readDb() {
  const p = dbPath()
  if (!(await exists(p))) return emptyDb()
  let raw
  try {
    raw = JSON.parse(await readFile(p, 'utf8'))
  } catch (error) {
    throw new StorageError(`数据文件解析失败：${p}（${error.message}）`)
  }
  const base = emptyDb()
  const rawSettings = raw.settings || {}
  const settings = { ...base.settings, ...rawSettings }
  // 阈值口径从人民币改成美元：老配置只存了 balanceWarnCny，这里折一次
  // （判断依据是原始文件里有没有 balanceWarnUsd，否则默认值会盖掉迁移）
  if (rawSettings.balanceWarnUsd === undefined) {
    // 这里不能用 fx.js 的 ensureFx —— fx.js 反过来 import 了本文件，会成环。
    // 所以按同样顺序取值：fx.rates.CNY → 兼容镜像 → 默认值。
    const fx =
      Number(rawSettings.fx?.rates?.CNY) ||
      Number(settings.fx?.rates?.CNY) ||
      Number(settings.fxUsdCny) ||
      7.2
    const oldCny = Number(rawSettings.balanceWarnCny)
    if (Number.isFinite(oldCny) && oldCny > 0) settings.balanceWarnUsd = Math.round((oldCny / fx) * 100) / 100
  }
  return migrate({
    ...base,
    ...raw,
    settings,
    providers: raw.providers || [],
    credentials: raw.credentials || [],
    offers: raw.offers || [],
    probes: raw.probes || [],
  })
}

export async function writeDb(db) {
  await mkdir(dataDir(), { recursive: true })
  await writeJsonAtomic(dbPath(), db, 2)
  // 自己写完就把缓存作废，下一次读一定是新的
  dbCache = { mtimeMs: 0, size: -1, db: null }
}

let dbCache = { mtimeMs: 0, size: -1, db: null }

/**
 * 读 db 并缓存——只读场景（网关热路径）用，**不要改返回的对象**。
 *
 * 每请求 readDb 要 15ms 左右（db.json 已到 1MB），对本地网关是白扔的延迟。
 * 用 mtime + size 判断文件有没有被换过：我们自己的写入会换文件，别的进程改了也一样。
 */
export async function readDbCached() {
  const p = dbPath()
  let stats
  try {
    stats = await stat(p)
  } catch {
    return readDb() // 文件不存在或读不到，走慢路径（会返回空库或抛 StorageError）
  }
  if (dbCache.db && dbCache.mtimeMs === stats.mtimeMs && dbCache.size === stats.size) {
    return dbCache.db
  }
  const db = await readDb()
  // 读完再 stat 一次：避免把「读的过程中又变了」的文件记成缓存
  const after = await stat(p).catch(() => null)
  if (after && after.mtimeMs === stats.mtimeMs && after.size === stats.size) {
    dbCache = { mtimeMs: after.mtimeMs, size: after.size, db }
  }
  return db
}

/**
 * 读 → 改 → 原子写。回调直接修改传入的 db 对象。
 *
 * 必须串行：HTTP 服务会并发进 mutate，每个请求都「读同一份 → 各自写回」，
 * 后写的会把先写的结果整份覆盖掉（丢数据），并发 rename 还会在 Windows 上互相打 EPERM。
 * usage.js 里的 writeChain 是同一个思路。
 */
export async function mutate(fn) {
  const run = async () => {
    const db = await readDb()
    const result = await fn(db)
    await writeDb(db)
    return result
  }
  const pending = writeChain.then(run, run)
  // 链尾吞掉异常，否则一次失败会把后续所有写操作都带成 reject
  writeChain = pending.then(
    () => {},
    () => {},
  )
  return pending
}
