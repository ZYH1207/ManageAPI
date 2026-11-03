/** Explicit website-session import. Never discovers credentials or accepts a destination from pasted JSON. */
import { tokenExpiresAt } from './providers.js'

const MAX_INPUT = 64 * 1024
const MAX_TOKEN = 16 * 1024
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function secret(value, name, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null
  if (typeof value !== 'string') throw new Error(`${name} 必须是文本`)
  const text = value.trim().replace(/^Bearer\s+/i, '')
  if (!text || text.length > MAX_TOKEN || /[\s\x00-\x1f\x7f]/.test(text)) throw new Error(`${name} 为空、过长或格式不正确`)
  return text
}

/** JWT payload supplies a scheduling hint only; only the profile request authenticates a token. */
function jwtExpiry(token) {
  try {
    const pieces = token.split('.')
    if (pieces.length !== 3) return null
    const data = JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8'))
    if (typeof data.exp !== 'number' || !Number.isFinite(data.exp) || data.exp <= 0 || data.exp * 1000 > 8.64e15) return null
    return new Date(data.exp * 1000).toISOString()
  } catch { return null }
}

export function parseProviderSession(input, now = Date.now()) {
  let value = input
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_INPUT) throw new Error('登录响应不能超过 64KB')
    const text = value.trim()
    if (text.startsWith('{') || text.startsWith('[') || text.startsWith('"')) {
      try { value = JSON.parse(text) } catch { throw new Error('登录响应不是有效 JSON，请复制完整响应或只粘贴 access_token') }
    } else value = { access_token: text }
  }
  if (typeof value === 'string') value = { access_token: value }
  if (!record(value)) throw new Error('请粘贴登录响应 JSON 或 access_token')
  let size
  try { size = Buffer.byteLength(JSON.stringify(value), 'utf8') } catch { throw new Error('登录响应格式不正确') }
  if (size > MAX_INPUT) throw new Error('登录响应不能超过 64KB')
  if (value.success === false || (value.code !== undefined && value.code !== 0)) throw new Error('这不是成功的登录响应，请先在站点完成登录与人机验证')
  const data = record(value.data) ? value.data : value
  const token = secret(data.access_token ?? data.accessToken, 'access_token')
  const refreshToken = secret(data.refresh_token ?? data.refreshToken, 'refresh_token', true)
  const id = data.user?.id ?? data.user_id
  const userId = id === undefined || id === null ? null : String(id)
  if (userId !== null && (!userId || userId.length > 128)) throw new Error('登录响应中的账号 ID 格式不正确')
  return { token, refreshToken, userId, expiresAt: tokenExpiresAt(data, now) || jwtExpiry(token) }
}

/** Validate only the configured origin's authenticated profile, never sk-key fallback or redirects. */
export async function validateProviderSession({ baseUrl, kind, session, timeoutMs = 12000 }) {
  if (!['sub2api', 'unknown', undefined, null].includes(kind)) throw new Error('网站登录会话导入目前支持 Sub2API；其他站点请导入官方管理令牌')
  let origin
  try {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
    origin = url.origin
  } catch { throw new Error('站点地址不正确，无法校验登录会话') }
  let response
  try {
    response = await fetch(`${origin}/api/v1/user/profile`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` },
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    })
  } catch { throw new Error('无法连接站点校验登录会话，请确认站点地址和网络后重试') }
  if (!response.ok) {
    await response.body?.cancel()
    const error = new Error(`登录会话校验失败（HTTP ${response.status}），请在站点完成登录后重新复制响应`)
    error.status = response.status
    throw error
  }
  let payload
  try { payload = await response.json() } catch { throw new Error('站点账号接口没有返回有效 JSON，未替换现有令牌') }
  const data = record(payload?.data) ? payload.data : payload
  if (!record(payload) || payload.success === false || (payload.code !== undefined && payload.code !== 0) || !record(data) ||
      !['string', 'number'].includes(typeof data.id) || !String(data.id).trim() ||
      (typeof data.id === 'number' && !Number.isFinite(data.id)) || typeof data.balance !== 'number' || !Number.isFinite(data.balance)) {
    throw new Error('站点账号接口未返回有效账号 ID 和数值余额，未替换现有令牌')
  }
  const userId = String(data.id)
  if (session.userId !== null && session.userId !== userId) throw new Error('登录响应账号与站点校验账号不一致，未替换现有令牌')
  return { userId, kind: 'sub2api' }
}
