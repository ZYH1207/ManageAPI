/**
 * ZCode（智谱 AI 编程客户端）连接器 —— 「读本机客户端」路线。
 *
 * 为什么不是 OAuth：
 * ZCode 的授权走桌面协议 `zcode://oauth/callback`，回跳地址只有客户端自己注册得动，
 * 网页侧拿不到回调，所以没法像 WorkBuddy 那样开一个浏览器窗口去授权。
 *
 * 为什么可以读本机文件：
 * 额度归属的是「这个人在 zcode.z.ai 上的订阅」，而客户端已经把登录态存在本机了。
 * ManageAPI 本来就跑在同一个用户下（服务器只绑 127.0.0.1），直接复用这份登录态最省事，
 * 也不用让用户把 token 复制来复制去。
 *
 * 数据来源与已知限制：
 *   1. `~/.zcode/v2/credentials.json`：客户端加密后的登录态（enc:v1: + AES-256-GCM）
 *   2. `GET /api/v1/zcode-plan/billing/current`：套餐与额度上限（第三方可调用，已跑通）
 *   3. `GET /api/v1/zcode-plan/billing/balance`：每份额度的已用/剩余
 *      —— 这个接口对第三方调用一直回 `3001 parameter error`（缺客户端某个头，没逆出来），
 *      所以再补一条兜底：客户端每几分钟自己拉一次，结果写在日志里，从日志里取最后一条。
 *
 * 只读：这里不落任何凭据到 ManageAPI 的库里（账号上存的只是一段标记），
 * 客户端换账号后下一次刷新自动跟着变。
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { open, readFile, readdir } from 'node:fs/promises'
import { homedir, platform, userInfo } from 'node:os'
import { join } from 'node:path'

import { encryptSecret } from '../store.js'
import { registerConnector } from './connector.js'

/** 额度接口的域名（客户端默认就用这个）。 */
export const ZCODE_ORIGIN = 'https://zcode.z.ai'
/** 客户端数据目录：凭据、日志都在这里。 */
export const ZCODE_HOME = join(homedir(), '.zcode', 'v2')
const CREDENTIAL_FILE = join(ZCODE_HOME, 'credentials.json')
const LOG_DIR = join(ZCODE_HOME, 'logs')

const CURRENT_PATH = '/api/v1/zcode-plan/billing/current'
const BALANCE_PATH = '/api/v1/zcode-plan/billing/balance'
/** 凭据密文前缀，和客户端里一致。 */
const ENC_PREFIX = 'enc:v1:'
/** 日志里的用量超过这个年纪就不用了：宁可说「读不到」，也不要拿旧数字骗人。 */
const USAGE_MAX_AGE_MS = 12 * 60 * 60 * 1000
const DEFAULT_APP_VERSION = '3.16.3'

/**
 * 客户端派生加密密钥的默认 secret。
 *
 * 客户端源码里是 `process.env.ZCODE_CREDENTIAL_SECRET || `zcode-credential-fallback:${platform}:${homedir}:${username}``，
 * 所以「同一台机器、同一个用户」能直接复原密钥；换了机器或换了用户就解不开，这是它的设计。
 */
export function defaultCredentialSecret() {
  if (process.env.ZCODE_CREDENTIAL_SECRET) return process.env.ZCODE_CREDENTIAL_SECRET
  return `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`
}

/** 解一个 `enc:v1:` 值；不是密文（老版本/手改）就原样返回。 */
export function decryptCredentialValue(raw, secret = defaultCredentialSecret()) {
  const text = String(raw ?? '')
  if (!text.startsWith(ENC_PREFIX)) return text
  const parts = text.slice(ENC_PREFIX.length).split('.')
  if (parts.length !== 3) throw new Error('凭据密文格式不认识')
  const [iv, tag, data] = parts.map((part) => Buffer.from(part, 'base64url'))
  const key = createHash('sha256').update(secret).digest()
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    // 密钥对不上（换机器、换用户名、或客户端设了 ZCODE_CREDENTIAL_SECRET）：
    // 当成「读不到」处理，让上层给出「重新登录一次」的提示，而不是抛个 crypto 错误
    return ''
  }
}

/**
 * 读本机客户端的登录态。
 *
 * 返回 `{ ok: false, reason }` 而不是抛错：卡片要能显示「没找到客户端」这种正常状态。
 */
export async function readLocalCredentials() {
  let raw
  try {
    raw = await readFile(CREDENTIAL_FILE, 'utf8')
  } catch {
    return { ok: false, reason: '没找到 ZCode 的登录数据：先打开客户端登录一次' }
  }

  let store
  try {
    store = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'ZCode 的凭据文件解析失败，可能在升级中，稍后再试' }
  }

  const read = (key, asJson = false) => {
    try {
      const plain = decryptCredentialValue(store?.[key])
      if (!plain) return null
      return asJson ? JSON.parse(plain) : plain
    } catch {
      return null
    }
  }

  const jwt = read('zcodejwttoken')
  if (!jwt) return { ok: false, reason: 'ZCode 里没有可用的登录态：在客户端里重新登录一次' }

  return {
    ok: true,
    jwt,
    user: read('oauth:zai:user_info', true),
    provider: read('oauth:active_provider'),
    path: CREDENTIAL_FILE,
  }
}

function numberOrNull(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

async function readLogFiles() {
  try {
    const names = await readdir(LOG_DIR)
    return names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.log$/.test(name))
      .sort()
      .reverse()
      .slice(0, 2)
      .map((name) => join(LOG_DIR, name))
  } catch {
    return []
  }
}

/** 只读日志尾部若干字节：客户端日志动辄几 MB，整份读进来只为找最后一条太浪费 */
const LOG_TAIL_BYTES = 512 * 1024

async function readLogTail(file) {
  try {
    const handle = await open(file, 'r')
    try {
      const { size } = await handle.stat()
      const start = Math.max(0, size - LOG_TAIL_BYTES)
      const length = size - start
      if (length <= 0) return ''
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
      return buffer.toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}

/** 客户端自己在日志里写了它用的版本号，跟着它走就不用每次升级都改代码。 */
async function detectAppVersion() {
  if (process.env.ZCODE_APP_VERSION) return process.env.ZCODE_APP_VERSION
  for (const file of await readLogFiles()) {
    const text = await readLogTail(file)
    const match = text.match(/billing\/balance\?app_version=([\d.]+)/)
    if (match) return match[1]
  }
  return DEFAULT_APP_VERSION
}

function parseLogTime(line) {
  const match = String(line).match(/^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
  if (!match) return null
  // 日志时间戳没有时区后缀，它是客户端所在机器的本地时间，按本机时区解释。
  // 此前硬编码 +08:00：客户端在别的时区运行时日志时间会被静默读偏，
  // 表现为「12 小时窗口内找不到用量」
  const [, y, mo, d, h, mi, s] = match
  const at = new Date(
    Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s),
  ).getTime()
  return Number.isFinite(at) ? at : null
}

/**
 * 从客户端日志里捞最后一次成功的额度响应。
 *
 * 日志行形如：
 *   [2026-10-23 22:12:30.648] [info] ... [usage-stats] billing/balance 请求完成 {"balanceCount":2,"balances":[...],...}
 * 冒号后面就是完整的响应体，直接 JSON.parse 即可。
 */
export async function readLoggedBalance(now = Date.now()) {
  for (const file of await readLogFiles()) {
    const text = await readLogTail(file)
    if (!text) continue
    const lines = text.split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]
      if (!line.includes('billing/balance') || !line.includes('请求完成')) continue
      const at = parseLogTime(line)
      if (!at || now - at > USAGE_MAX_AGE_MS) continue
      const mark = line.lastIndexOf('请求完成 ')
      if (mark < 0) continue
      try {
        const payload = JSON.parse(line.slice(mark + '请求完成 '.length))
        const data = payload?.payload?.data || payload?.data || null
        const balances = Array.isArray(data?.balances) ? data.balances : null
        if (!balances?.length) continue
        return { at, balances, plans: Array.isArray(data?.plans) ? data.plans : null, source: 'client-log' }
      } catch {
        continue
      }
    }
  }
  return null
}

async function requestJson(url, { authorization, timeoutMs = 10_000 } = {}) {
  let res
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json', ...(authorization ? { authorization } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const name = error?.name || ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`zcode.z.ai 没有在 ${Math.round(timeoutMs / 1000)} 秒内响应，稍后再试`)
    }
    throw new Error(`连不上 zcode.z.ai：${error?.message || error}`)
  }

  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

/** 套餐与额度上限。缺这个就什么都算不出来，所以失败要往上抛。 */
export async function fetchPlans(token) {
  const { status, json, text } = await requestJson(`${ZCODE_ORIGIN}${CURRENT_PATH}`, {
    authorization: token,
  })
  if (status === 401 || status === 403) throw new Error('ZCode 登录态已失效：在客户端里重新登录一次')
  if (status !== 200 || !json) throw new Error(`读取 ZCode 套餐失败：HTTP ${status} ${String(text).slice(0, 120)}`)
  if (json.code !== 0 && json.code !== undefined) {
    throw new Error(`读取 ZCode 套餐失败：${json.msg || `code ${json.code}`}`)
  }
  return { plans: Array.isArray(json?.data?.plans) ? json.data.plans : [], serverTime: json?.data?.server_time }
}

/**
 * 每份额度的已用/剩余。
 *
 * 这个接口目前对第三方调用一律 3001，所以失败返回 null（由调用方回落到日志），
 * 只有「登录态失效」这种确定性错误才抛。
 */
export async function fetchBalance(token, appVersion = DEFAULT_APP_VERSION) {
  const url = `${ZCODE_ORIGIN}${BALANCE_PATH}?app_version=${encodeURIComponent(appVersion)}`
  const { status, json } = await requestJson(url, { authorization: `Bearer ${token}` })
  if (status === 401 || status === 403) throw new Error('ZCode 登录态已失效：在客户端里重新登录一次')
  if (status !== 200 || !json || json.code !== 0) return null
  const balances = Array.isArray(json?.data?.balances) ? json.data.balances : null
  if (!balances?.length) return null
  return { balances, plans: Array.isArray(json?.data?.plans) ? json.data.plans : null, source: 'live' }
}

/** 日额度在北京时间零点重置；客户端也是这个口径。 */
export function nextDailyReset(now = Date.now()) {
  const CST_OFFSET = 8 * 3600 * 1000
  const cst = new Date(now + CST_OFFSET)
  const next = Date.UTC(cst.getUTCFullYear(), cst.getUTCMonth(), cst.getUTCDate() + 1)
  return next - CST_OFFSET
}

/**
 * 把「套餐的额度上限」和「用量的剩余」合成一个额度对象。
 *
 * 口径与 WorkBuddy 那边保持一致：
 *   remaining      现在还能用多少（各份额度可用量之和）
 *   cycleRemaining 周期额度还剩多少（日/月这类会重置的桶）
 *   cycleSize      周期额度的总量
 * 一次性赠量（one_time）算进 remaining，但不进 cycle*——它不会每月刷新。
 */
export function summarizeQuota(plans = [], usage = null, now = Date.now()) {
  const byEntitlement = new Map()
  for (const row of usage?.balances || []) {
    const id = String(row?.entitlement_id ?? '')
    if (id) byEntitlement.set(id, row)
  }

  const rows = []
  for (const plan of plans) {
    if (String(plan?.status || '').toLowerCase() !== 'active') continue
    const endsAt = Number(plan?.ends_at) > 0 ? Number(plan.ends_at) * 1000 : null
    if (endsAt && endsAt < now) continue
    for (const ent of plan?.entitlements || []) {
      const id = String(ent?.entitlement_id ?? '')
      const balance = byEntitlement.get(id) || null
      const grant = numberOrNull(ent?.grant_units)
      const total = balance ? numberOrNull(balance.total_units) ?? grant : grant
      const remaining = balance
        ? numberOrNull(balance.available_units) ?? numberOrNull(balance.remaining_units)
        : null
      rows.push({
        id,
        name: String(ent?.show_name || (ent?.capabilities || []).join(' / ') || id),
        period: String(ent?.period || 'one_time'),
        total,
        remaining,
        planName: String(plan?.name || ''),
        endsAt,
      })
    }
  }

  const periodic = rows.filter((row) => row.period !== 'one_time' && row.period !== 'once')
  const known = rows.filter((row) => Number.isFinite(row.remaining))
  const sum = (list, key) => list.reduce((total, row) => total + (Number.isFinite(row[key]) ? row[key] : 0), 0)

  const remaining = known.length ? sum(known, 'remaining') : null
  const cycleRemaining = periodic.some((row) => Number.isFinite(row.remaining))
    ? sum(periodic, 'remaining')
    : null
  const cycleSize = periodic.some((row) => Number.isFinite(row.total)) ? sum(periodic, 'total') : null
  const planEnds = rows.map((row) => row.endsAt).filter((value) => Number.isFinite(value))
  const refreshAt = periodic.length ? nextDailyReset(now) : planEnds.length ? Math.min(...planEnds) : null

  return { remaining, cycleRemaining, cycleSize, refreshAt, rows, periodCount: periodic.length }
}

export function createZcodeConnector(options = {}) {
  const origin = options.origin || ZCODE_ORIGIN
  const readCredentials = options.readCredentials || readLocalCredentials
  const readLogged = options.readLoggedBalance || readLoggedBalance
  const appVersion = options.appVersion || detectAppVersion

  async function local() {
    const cred = await readCredentials()
    if (!cred?.ok) throw new Error(cred?.reason || '没找到 ZCode 客户端的登录态')
    return cred
  }

  /** 连接 = 确认本机客户端登录着；真正要读的东西每次刷新时现读。 */
  async function startConnect() {
    const cred = await readCredentials()
    if (!cred?.ok) throw new Error(cred?.reason || '没找到 ZCode 客户端的登录态')
    return {
      state: 'local-client',
      // 没有网页授权：前端看到 local 就不开新窗口，直接轮询
      local: true,
      authUrl: '',
      expiresAt: null,
      hint: 'ZCode 没有网页授权，这里读的是本机客户端已经登录过的那份额度',
    }
  }

  async function pollConnect() {
    const cred = await readCredentials()
    if (!cred?.ok) return { ready: false, reason: cred?.reason || '还没找到客户端登录态' }
    return {
      ready: true,
      credential: { source: 'local-client', userId: cred.user?.user_id || '', provider: cred.provider || '' },
      profile: { label: cred.user?.name || cred.user?.email || 'ZCode 主账号' },
    }
  }

  /** 只存一个标记：真凭据始终在客户端自己那儿，换账号后自动跟着变。 */
  async function saveCredential(accountOrId, credential) {
    const id = typeof accountOrId === 'string' ? accountOrId : accountOrId?.id
    const blob = await encryptSecret(JSON.stringify(credential || { source: 'local-client' }))
    if (id) {
      const { updateAccount } = await import('./store.js')
      await updateAccount(id, { secret: blob })
      if (accountOrId && typeof accountOrId === 'object') accountOrId.secret = blob
    }
    return blob
  }

  async function quota() {
    const cred = await local()
    const version = await Promise.resolve(appVersion()).catch(() => DEFAULT_APP_VERSION)
    const { plans } = await fetchPlans(cred.jwt)

    let usage = null
    try {
      usage = await fetchBalance(cred.jwt, version)
    } catch (error) {
      // 登录态失效是确定性的，直接抛；其它情况回落到日志
      if (String(error?.message || '').includes('失效')) throw error
      usage = null
    }
    if (!usage) usage = await readLogged()

    const summary = summarizeQuota(plans, usage)
    if (!Number.isFinite(summary.remaining)) {
      throw new Error('还没读到用量：ZCode 客户端每几分钟才拉一次额度，等一会儿再点「刷新」')
    }

    return {
      unit: 'token',
      remaining: summary.remaining,
      cycleRemaining: summary.cycleRemaining,
      cycleSize: summary.cycleSize,
      refreshAt: summary.refreshAt ? new Date(summary.refreshAt).toISOString() : null,
      tenantKey: String(cred.user?.user_id || ''),
      source: usage?.source || 'unknown',
      usageAt: usage?.at ? new Date(usage.at).toISOString() : null,
      models: [...new Set(summary.rows.map((row) => row.name).filter(Boolean))],
      // 一次性赠量没有用量桶，remaining 里算不到，单独报一个总数给界面说明
      bonusTokens: summary.rows
        .filter((row) => row.period === 'one_time' && !Number.isFinite(row.remaining))
        .reduce((total, row) => total + (row.total || 0), 0),
    }
  }

  /** 诊断按钮：把每一步都试一遍，失败也照样返回，方便看卡在哪。 */
  async function diagnose() {
    const out = { origin, credentialPath: CREDENTIAL_FILE, logDir: LOG_DIR }
    let cred = null
    try {
      cred = await readCredentials()
      out.credentials = cred?.ok
        ? { ok: true, user: cred.user?.name || null, email: cred.user?.email || null, provider: cred.provider }
        : { ok: false, reason: cred?.reason }
    } catch (error) {
      out.credentials = { ok: false, reason: error?.message || String(error) }
    }

    if (cred?.ok) {
      try {
        const { plans } = await fetchPlans(cred.jwt)
        out.plans = plans.map((plan) => ({
          name: plan.name,
          status: plan.status,
          endsAt: plan.ends_at,
          entitlements: (plan.entitlements || []).map((ent) => `${ent.show_name}:${ent.grant_units}/${ent.period}`),
        }))
      } catch (error) {
        out.plans = { error: error?.message || String(error) }
      }
      try {
        out.balance = (await fetchBalance(cred.jwt, DEFAULT_APP_VERSION)) ? 'ok' : 'unavailable（接口拒绝，用日志兜底）'
      } catch (error) {
        out.balance = { error: error?.message || String(error) }
      }
      const logged = await readLogged().catch(() => null)
      out.loggedBalance = logged
        ? { at: new Date(logged.at).toISOString(), buckets: logged.balances.length }
        : '日志里没有最近的用量（客户端还没拉过，或超过 12 小时）'
    }
    return out
  }

  return {
    id: 'zcode',
    label: 'ZCode（智谱）',
    defaultProduct: 'zcode',
    pollIntervalMs: 1200,
    authTimeoutMs: 60_000,
    /** 标记给上层：这个连接器不需要用户粘贴 token，读本机客户端即可 */
    localClient: true,
    detect: async () => {
      const cred = await readCredentials()
      return cred?.ok
        ? { ok: true, user: cred.user?.name || cred.user?.email || null }
        : { ok: false, reason: cred?.reason }
    },
    startConnect,
    pollConnect,
    quota,
    diagnose,
    saveCredential,
  }
}

export const zcodeConnector = createZcodeConnector()

registerConnector(zcodeConnector)
