/**
 * 错误指纹：把上游五花八门的报错归一化成可聚合、可学习的指纹。
 *
 * 为什么单独一个文件：中转站不规范，同一个错误各家措辞不同、同一个措辞里
 * 又夹着变量（模型名、数字、id）。直接存原文，错误库会膨胀成一本流水账，
 * 永远凑不齐「同类错误发生过几次、哪家站爱犯」这种统计。
 *
 * 归一化分三步：
 *   1. 抽 HTTP 状态码（`HTTP 403 {...}` → code=403）
 *   2. 从 JSON 体里抽人话（error.message 优先，退到 error.code / 顶层 message）
 *   3. 模板化：数字→#、带引号的串→"…"、长十六进制→ID
 *
 * 指纹 id = kind|code|模板 的哈希。同模板不同模型名的两条报错会落进同一个
 * 指纹——这正是想要的：`Model "deepseek-v4.1-flash" is not available` 和
 * `Model "glm-5.3" is not available` 是同一个病。
 */

import { createHash } from 'node:crypto'
import { classifyFailure } from './failure.js'

/** 抽 HTTP 状态码 + 错误正文。`HTTP 403 {"error":…}` → { code:'403', body:'{…}' } */
export function parseErrorPayload(text) {
  const raw = String(text || '')
  const m = raw.match(/^HTTP\s+(\d{3})\s+([\s\S]*)$/)
  if (!m) return { code: null, body: raw }
  return { code: m[1], body: m[2] }
}

/** 从 JSON 体里尽量抽出「人话」+ 分类线索；抽不出来就原样返回 */
export function messageFromBody(body) {
  const raw = String(body || '').trim()
  if (!raw.startsWith('{')) return { message: raw, hint: '' }
  try {
    const j = JSON.parse(raw)
    const err = j?.error
    const hint = [err?.code, err?.type, j?.code].filter((x) => typeof x === 'string' && x && x !== (err?.message || j?.message)).join(' ')
    let message
    if (typeof err === 'string') message = err
    else
      message =
        err?.message ||
        j?.message ||
        err?.code ||
        j?.code ||
        // 完全没有 message 时保留 type 当线索（如 billing_error）
        (err?.type ? `[${err.type}]` : raw)
    return { message: String(message), hint }
  } catch {
    // JSON 被截断（server.js 只存前 160 字符）：退化为整段原文
    return { message: raw, hint: '' }
  }
}

/** 模板化：抹掉变量，保留句式 */
export function templateOf(message) {
  return String(message || '')
    .replace(/[0-9a-f]{8,}/gi, 'ID') // 长 hex 串（请求 id、trace id）
    .replace(/\b\d[\d,\.]*\b/g, '#') // 数字（金额、配额、时间）
    .replace(/"[^"]{0,120}"/g, '"…"') // 带引号的串（模型名、分组名）
    .replace(/'[^']{0,120}'/g, "'…'") // 单引号版本
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

/**
 * 错误文本 → 指纹。返回 null 表示这段文本没有可归一化的内容（空串等）。
 * kind 直接复用 failure.js 的归类（quota / rate-limit / model-missing / …），
 * 未命中的算 outage（真故障）——两边口径必须一致，诊断页才不会自相矛盾。
 */
export function fingerprintError(text) {
  const raw = String(text || '')
  if (!raw.trim()) return null
  const { code, body } = parseErrorPayload(raw)
  const { message, hint } = messageFromBody(body)
  const template = templateOf(message)
  if (!template) return null
  // 归类要把 JSON 里的 code/type 当线索一起给：站点常把「病名」放 code 字段
  // （如 model_not_found），人话 message 里反而不提
  const { kind } = classifyFailure(`${message} ${hint}`)
  const id = `fp_${createHash('sha1').update(`${kind || 'outage'}|${code || ''}|${template.toLowerCase()}`).digest('hex').slice(0, 10)}`
  return { id, kind: kind || 'outage', code, template, message: String(message).slice(0, 200) }
}

/**
 * 把一次失败写进错误账本（原地更新 book）。
 * book 结构：{ [id]: { id, kind, code, template, sample, count, firstAt, lastAt,
 *                      providers: {站名: n}, offers: {offerId: n}, lastDiagnosis: null } }
 * lastDiagnosis 留给将来的自动判诊：新指纹 ping 完把结论写回这里，同指纹终身免检。
 */
export function applyErrorToBook(
  book,
  fp,
  { providerName = null, offerId = null, at = new Date().toISOString() } = {},
) {
  if (!fp) return
  let entry = book[fp.id]
  if (!entry) {
    entry = book[fp.id] = {
      id: fp.id,
      kind: fp.kind,
      code: fp.code,
      template: fp.template,
      sample: fp.message,
      count: 0,
      firstAt: at,
      lastAt: at,
      providers: {},
      offers: {},
      lastDiagnosis: null,
    }
  }
  entry.count += 1
  if (at > entry.lastAt) entry.lastAt = at
  if (at < entry.firstAt) entry.firstAt = at
  if (providerName) entry.providers[providerName] = (entry.providers[providerName] || 0) + 1
  if (offerId) entry.offers[offerId] = (entry.offers[offerId] || 0) + 1
}

/**
 * 账本瘦身：指纹种类有限但不是无限，长期不出现的旧指纹清掉。
 * 按 lastAt 保留最新的 maxEntries 条，且清掉超过 maxAgeDays 天没再犯的。
 */
export function pruneErrorbook(book, now = Date.now(), { maxEntries = 400, maxAgeDays = 90 } = {}) {
  const cutoff = now - maxAgeDays * 86400000
  const ids = Object.keys(book)
  for (const id of ids) {
    const last = Date.parse(book[id]?.lastAt) || 0
    if (last < cutoff) delete book[id]
  }
  const rest = Object.values(book)
  if (rest.length <= maxEntries) return { removed: 0, kept: rest.length }
  rest.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
  const keep = new Set(rest.slice(0, maxEntries).map((e) => e.id))
  let removed = 0
  for (const id of Object.keys(book)) {
    if (!keep.has(id)) {
      delete book[id]
      removed += 1
    }
  }
  return { removed, kept: keep.size }
}
