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
import { mkdir, readFile, writeFile, rename, chmod, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const DB_VERSION = 2

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
    },
    providers: [],
    credentials: [],
    offers: [],
    probes: [],
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
 * v1 → v2：把「令牌 / 余额」从 Key 上挪到站点上。
 *
 * 原因：令牌是站点后台的登录凭证，余额是账号余额——两者都跟 Key 无关。
 * 挂在 Key 上会导致「加第二个 Key 后余额显示 0」「换个 Key 就要重填令牌」。
 *
 * 迁移是就地提升：取该站第一个填过令牌的 Key，复制到站点上。
 * Key 上的旧字段保留不删，万一要回滚还能读。
 */
function migrate(db) {
  const version = Number(db.version) || 1
  if (version >= DB_VERSION) return db

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
  return db
}

export async function readDb() {
  const p = dbPath()
  if (!(await exists(p))) return emptyDb()
  let raw
  try {
    raw = JSON.parse(await readFile(p, 'utf8'))
  } catch (error) {
    throw new Error(`数据文件解析失败：${p}（${error.message}）`)
  }
  const base = emptyDb()
  return migrate({
    ...base,
    ...raw,
    settings: { ...base.settings, ...(raw.settings || {}) },
    providers: raw.providers || [],
    credentials: raw.credentials || [],
    offers: raw.offers || [],
    probes: raw.probes || [],
  })
}

export async function writeDb(db) {
  await mkdir(dataDir(), { recursive: true })
  const p = dbPath()
  const tmp = `${p}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(db, null, 2), 'utf8')
  await rename(tmp, p)
}

/** 读 → 改 → 原子写。回调直接修改传入的 db 对象。 */
export async function mutate(fn) {
  const db = await readDb()
  const result = await fn(db)
  await writeDb(db)
  return result
}
