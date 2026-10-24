/**
 * 免费池 · 中转站侧表格。
 *
 * 单独成文件是为了让 app.js 只做接线：这里不读全局 state、不绑事件，
 * esc / t / providers 全由调用方传入，Node 里也能直接跑一遍看 HTML 长什么样。
 *
 * 为什么这里自带一份闸门判断：daemon 的静态服务只覆盖 web/，浏览器拿不到 core/，
 * 渲染层没法 import core/rank-free.js。规则必须与它保持一致——改阈值请两边一起改。
 */

/**
 * 厂商前缀表：deepseek-v4-flash → deepseek；gpt-5.3 与 gpt-5.3-codex 同厂。
 * 放在这个纯函数模块里导出，app.js（忽略模型弹窗按厂牌分组）与胶囊配色共用。
 */
export const VENDOR_LABEL = {
  gpt: 'OpenAI',
  o1: 'OpenAI',
  o3: 'OpenAI',
  o4: 'OpenAI',
  codex: 'OpenAI',
  claude: 'Anthropic',
  gemini: 'Gemini',
  grok: 'Grok',
  llama: 'Llama',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  glm: '智谱 GLM',
  chatglm: '智谱 GLM',
  qwen: '通义千问',
  kimi: 'Moonshot',
  moonshot: 'Moonshot',
  doubao: '豆包',
  hunyuan: '腾讯混元',
  ernie: '文心一言',
  minimax: 'MiniMax',
  abab: 'MiniMax',
  spark: '讯飞星火',
  yi: '零一万物',
}

/** 国产厂商前缀集合：胶囊统一蓝色 */
const CN_PREFIXES = new Set([
  'deepseek', 'glm', 'chatglm', 'qwen', 'kimi', 'moonshot', 'doubao',
  'hunyuan', 'ernie', 'minimax', 'abab', 'spark', 'yi',
])

/** 海外主流厂商的专属色；其余海外厂牌与未识别的一律中性灰，不猜 */
const OVERSEAS_CHIP = {
  gpt: 'vchip-openai',
  o1: 'vchip-openai',
  o3: 'vchip-openai',
  o4: 'vchip-openai',
  codex: 'vchip-openai',
  claude: 'vchip-anthropic',
  gemini: 'vchip-google',
}

/**
 * 模型名 → 厂商胶囊 class：国产=蓝（统一）、海外主流各家一色、
 * 未识别=空（中性灰）。免费分组的 `.vchip-free` 不在这里判——
 * 免费与否看价格（倍率 0 / 实际价 0），由调用方按数据判定。
 */
export function vendorChipClass(modelName) {
  const prefix = String(modelName || '').toLowerCase().split(/[-_./:]/)[0]
  if (!prefix) return ''
  if (CN_PREFIXES.has(prefix)) return 'vchip-cn'
  return OVERSEAS_CHIP[prefix] || ''
}

export function vendorOf(name) {
  const prefix = String(name || '').toLowerCase().split(/[-_./:]/)[0]
  return prefix || '其它'
}

export function vendorLabel(prefix) {
  return VENDOR_LABEL[prefix] || prefix
}

const DAY_MS = 86400000
const WINDOW_MS = { day: DAY_MS, month: 30 * DAY_MS }
// 与 core/rank-free.js 同一套门槛：指纹、未截断都要求 >= 80%
const MIN_RATE = 0.8

const UNIT_LABEL = { request: '次', token: 'token', credit: '积分' }

/** 只认能算出上限的配额；「不限量」返回 null，和「额度为 0」是两件事 */
function readQuota(raw) {
  if (!raw || typeof raw !== 'object') return null
  const limit = Number(raw.limit)
  if (!Number.isFinite(limit)) return null
  const used = Number(raw.used)
  return {
    unit: UNIT_LABEL[raw.unit] ? raw.unit : 'request',
    limit,
    used: Number.isFinite(used) ? used : 0,
    window: raw.window === 'month' ? 'month' : 'day',
    resetAt: raw.resetAt || null,
  }
}

/** 大数字压缩，避免配额列把表格撑变形 */
function fmtQty(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`
  if (n >= 1e3) return `${Math.round(n / 100) / 10}k`
  return String(Math.round(n))
}

function fmtReset(iso) {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 还能撑几天：剩余量 ÷ 近期消耗速率。
 * 速率只能从「已用多少 ÷ 窗口已过多久」反推，窗口刚开始的半天不足以估速率。
 */
function daysLeftOf(quota, now) {
  if (!quota) return null
  const windowMs = WINDOW_MS[quota.window] ?? DAY_MS
  const resetMs = quota.resetAt ? new Date(quota.resetAt).getTime() : NaN
  if (!Number.isFinite(resetMs)) return null
  const elapsedDays = (windowMs - (resetMs - now)) / DAY_MS
  if (!(elapsedDays >= 0.5)) return null
  const perDay = quota.used / Math.min(elapsedDays, windowMs / DAY_MS)
  if (!(perDay > 0)) return null
  return Math.max(0, (quota.limit - quota.used) / perDay)
}

/**
 * 闸门。任一命中即排除，quality 在这里只负责「能不能用」，不参与排序——
 * 免费成本恒为 0，加权打分会被 0 吞掉区分度。
 */
function judge(offer, score, t) {
  const quota = readQuota(offer.freeQuota)

  if (quota) {
    // used > limit 说明账已经记爆（站点给的额度和实际允许的不一致），先报超限更接近事实
    if (quota.used > quota.limit) {
      return { quota, gate: { label: '超出配额', why: t('用量已经超过这个窗口的上限，等重置后再用') } }
    }
    if (quota.limit - quota.used <= 0) {
      return { quota, gate: { label: '额度用尽', why: t('这个窗口的免费额度已经用完') } }
    }
  }
  if (!score || !score.samples) {
    return { quota, gate: { label: '未探测', why: t('还没有探测记录，免费站不能靠猜') } }
  }
  if (score.stale === true) {
    return { quota, gate: { label: '评分过期', why: t('上次探测太久远，先重新探测再放行') } }
  }
  if (typeof score.fingerprintRate === 'number' && score.fingerprintRate < MIN_RATE) {
    return {
      quota,
      gate: {
        label: '指纹不符',
        why: `${t('指纹')} ${Math.round(score.fingerprintRate * 100)}% · ${t('低于门槛')} 80%`,
      },
    }
  }
  // truncationRate 是「未截断比例」，不是截断率：判据是 < 0.8，写成 > 0.8 会把好站全排除
  if (typeof score.truncationRate === 'number' && score.truncationRate < MIN_RATE) {
    return {
      quota,
      gate: {
        label: '输出截断',
        why: `${t('未截断')} ${Math.round(score.truncationRate * 100)}% · ${t('低于门槛')} 80%`,
      },
    }
  }
  return { quota, gate: null }
}

function ttftOf(score) {
  return typeof score?.ttftMs === 'number' ? score.ttftMs : Number.POSITIVE_INFINITY
}

function byTtft(a, b) {
  const x = ttftOf(a.score)
  const y = ttftOf(b.score)
  if (x === y) return 0
  return x - y
}

function byDaysLeft(a, b) {
  if (a.daysLeft === null && b.daysLeft === null) return byTtft(a, b)
  if (a.daysLeft === null) return 1
  if (b.daysLeft === null) return -1
  if (a.daysLeft !== b.daysLeft) return b.daysLeft - a.daysLeft
  return byTtft(a, b)
}

function quotaCell(row, esc, t) {
  const offerId = esc(row.offer.id)
  const input = (value) =>
    `<input type="number" min="0" data-act="free-quota-limit" data-offer="${offerId}" value="${value}" style="width:70px">`

  if (!row.quota) {
    // 一行放完：进度条 + 文字 + 上限输入，避免列被撑成两行
    return `<td><div class="quota">
        <span class="quota-text" title="${esc(t('未设置配额'))}">—</span>
        ${input('')}
      </div></td>`
  }

  const q = row.quota
  const ratio = q.limit > 0 ? Math.min(1, q.used / q.limit) : 1
  // 快用完是黄，用满是灰：进度条在这里承担「还能不能继续用」的判断
  const cls = ratio >= 1 ? 'empty' : ratio >= 0.8 ? 'warn' : ''
  const reset = q.resetAt ? fmtReset(q.resetAt) : ''
  const title = `${q.window === 'month' ? t('每月重置') : t('每天重置')}${reset ? ` · ${reset}` : ''}`

  return `<td><div class="quota">
        <div class="quota-track"><div class="quota-fill ${cls}" style="width:${Math.round(ratio * 100)}%"></div></div>
        <span class="quota-text" title="${esc(title)}">${esc(`${fmtQty(q.used)}/${fmtQty(q.limit)}`)} ${esc(t(UNIT_LABEL[q.unit]))}</span>
        ${input(esc(q.limit))}
      </div></td>`
}

/**
 * @param {Object} options
 * @param {Array} options.offers 免费供给（daemon 的 freePool.relay，score 已挂在 offer 上）
 * @param {Array} options.providers 站点表，用来把 providerId 翻成站名
 * @param {'remaining'|'relay'|'platform'} [options.crossPane] 跨栏偏好，决定同栏内的次序
 * @param {(value:any)=>string} options.esc HTML 转义
 * @param {(text:string)=>string} options.t 取词
 * @returns {string} HTML
 */
export function renderFreeRelayPane({ offers = [], providers = [], crossPane = 'remaining', esc, t }) {
  if (!offers || offers.length === 0) {
    return `
      <div class="empty">
        <h3>${esc(t('还没有免费模型'))}</h3>
        <p>${esc(t('免费池只收「实际价为 0」的模型。分组名叫「免费」但价格没填的，不算——空不等于 0。'))}</p>
        <p class="hint" style="margin:0 0 14px">${esc(t('去「比价」页把它的输入/输出价填 0，或直接点「标为免费」；也可以先「导入倍率」，实际价算下来是 0 的会自动进来。'))}</p>
        <div style="display:flex;gap:8px;justify-content:center">
          <button class="primary" data-goto="pricing">${esc(t('去比价页标免费'))}</button>
          <button class="ghost" data-goto="providers">${esc(t('去站点导入倍率'))}</button>
        </div>
      </div>`
  }

  const now = Date.now()
  const providerName = (id) => providers.find((p) => p.id === id)?.name || '—'

  const rows = offers.map((offer) => {
    const score = offer.score || null
    const judged = judge(offer, score, t)
    // 服务端已经用 core/rank-free.js 算过闸门和剩余天数，以它为准；
    // 这里保留本地 judge 只作为兜底，免得两套阈值各写一份、慢慢漂移。
    const gate = 'gate' in offer ? offer.gate : judged.gate
    const daysLeft = 'daysLeft' in offer ? offer.daysLeft : gate ? null : daysLeftOf(judged.quota, now)
    return { offer, score, quota: judged.quota, gate, daysLeft }
  })

  const usable = rows.filter((row) => !row.gate)
  const blocked = rows.filter((row) => row.gate)
  // relay 偏好下不重排：用户选了「中转站优先」，同栏内就按导入顺序来
  const ordered = crossPane === 'relay' ? [...usable, ...blocked] : [...usable.sort(byDaysLeft), ...blocked]

  const avgOf = (pick) => {
    const values = rows.map(pick).filter((v) => typeof v === 'number')
    return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null
  }
  const avgFp = avgOf((row) => row.score?.fingerprintRate)
  const avgTtft = avgOf((row) => row.score?.ttftMs)
  const longest = usable.reduce(
    (best, row) => (row.daysLeft !== null && (best === null || row.daysLeft > best) ? row.daysLeft : best),
    null,
  )

  const stat = (label, value, unit) => `
    <div class="stat"><div class="k">${esc(t(label))}</div>
    <div class="v">${esc(value)}${unit ? `<small>${esc(t(unit))}</small>` : ''}</div></div>`

  // 只剩半天时整数会显示成「0 天」，保留一位小数才看得出「快没了」
  const longestText =
    longest === null ? '—' : longest >= 10 ? String(Math.round(longest)) : String(Math.round(longest * 10) / 10)

  const stats = `<div class="stats">
    ${stat('可用供给', `${usable.length}/${rows.length}`, '条')}
    ${stat('平均指纹', avgFp === null ? '—' : Math.round(avgFp * 100), avgFp === null ? '' : '%')}
    ${stat('平均首字', avgTtft === null ? '—' : Math.round(avgTtft), avgTtft === null ? '' : 'ms')}
    ${stat('预计撑最久', longestText, longest === null ? '' : '天')}
  </div>`

  const body = ordered
    .map((row) => {
      const { offer, score, gate } = row
      const fp = typeof score?.fingerprintRate === 'number' ? `${Math.round(score.fingerprintRate * 100)}%` : '—'
      const ttft = typeof score?.ttftMs === 'number' ? `${Math.round(score.ttftMs)}ms` : '—'
      // 免费页整页都是免费供给：分组列统一免费色（与站点卡「免费 N」标记同款），
      // 厂商由「模型」列自己表达，不抢分组的语义
      const group = offer.group
        ? `<span class="gtag vchip-free">${esc(offer.group)}</span>`
        : `<span style="color:var(--faint)">${esc(t('默认'))}</span>`
      const status = gate
        ? `<span class="badge warn" title="${esc(t(gate.why || gate.label))}">${esc(t(gate.label))}</span>`
        : `<span class="badge ok">${esc(t('可用'))}</span>`

      return `
        <tr>
          <td class="mono">${esc(offer.upstreamName)}</td>
          <td>${esc(providerName(offer.providerId))}</td>
          <td>${group}</td>
          ${quotaCell(row, esc, t)}
          <td class="mono">${fp}</td>
          <td class="mono">${ttft}</td>
          <td>${status}</td>
        </tr>`
    })
    .join('')

  return `
    ${stats}
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>${esc(t('模型'))}</th><th>${esc(t('站点'))}</th><th>${esc(t('分组'))}</th><th>${esc(t('配额'))}</th>
          <th>${esc(t('指纹'))}</th><th>${esc(t('首字'))}</th><th>${esc(t('状态'))}</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="hint" style="margin-top:10px">
      ${esc(
        t(
          '免费模型是探针最有价值的场景：没人会白送，最常见的偷工方式是拿小模型冒充大模型。指纹不到 100% 的那几行值得点开看看。',
        ),
      )}
    </p>`
}
