/** 前端：无框架，全量状态 + 重渲染。 */
import { getLang, onLangChange, restoreDom, setLang, t, translateDom } from './i18n.js'
import { renderFreeRelayPane, vendorChipClass, vendorOf, vendorLabel } from './free-relay.js'
import { renderFreePlatformPane } from './free-platform.js'

const $ = (sel, root = document) => root.querySelector(sel)

// 先把语言挂到 <html> 上，使用说明的中英双块靠它选显示哪一份
document.documentElement.dataset.lang = getLang()

let state = null
let activeTab = 'providers'
// 自动刷新：默认开，本地记住开关。轮询间隔 15s，页面在后台时暂停
const AUTOREFRESH_MS = 15000
const AUTOREFRESH_KEY = 'manageapi.autorefresh'
let autoRefresh = localStorage.getItem(AUTOREFRESH_KEY) !== '0'
let refreshTimer = null
// 这两个页签要看评分/候选明细，轮询时走完整 state；其它页只要轻量那份省带宽
const HEAVY_TABS = new Set(['pricing', 'decision'])

// ------------------------------------------------------------------ 工具

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]))
}

function money(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value >= 100) return value.toFixed(0)
  if (value >= 1) return value.toFixed(2)
  return value.toFixed(3)
}

/**
 * 显示币种：后端算出来的一律是人民币（$ = ¥ ÷ 汇率），这里按设置换成美元展示。
 * 只影响渲染，不参与任何比较——比较走的是 core/pricing.js 的美元口径。
 */
function showUsd() {
  return state?.settings?.displayCurrency === 'USD'
}
function priceSym() {
  return showUsd() ? '$' : '¥'
}
/** 1 USD = ? CNY。真源是 settings.fx.rates.CNY，fxUsdCny 只是兼容镜像 */
function rateCny() {
  const fromFx = Number(state?.settings?.fx?.rates?.CNY)
  if (Number.isFinite(fromFx) && fromFx > 0) return fromFx
  const legacy = Number(state?.settings?.fxUsdCny)
  return Number.isFinite(legacy) && legacy > 0 ? legacy : 7.2
}
function dispPrice(cny) {
  if (cny === null || cny === undefined || !Number.isFinite(cny)) return null
  if (!showUsd()) return cny
  return cny / rateCny()
}
/** 价格文本，例：¥0.29 或 $0.041 */
function priceText(cny) {
  const v = dispPrice(cny)
  return v === null ? '—' : `${priceSym()}${money(v)}`
}

/**
 * 金额显示：余额这类「站点原生币种」的数值（p.currency 说它是 USD 就是 USD）。
 * 先折成人民币口径，再走 dispPrice 按全局显示币种出——
 * 以前余额直接用站点币种硬拼 ¥/$ 符号，顶栏切到人民币它还是显示美元
 */
function dispAmount(value, currency) {
  const n = Number(value)
  if (value === null || value === undefined || !Number.isFinite(n)) return null
  return dispPrice(currency === 'CNY' ? n : n * rateCny())
}

/** 日期时间（本机时区，固定 MM-DD HH:mm）：路由日志可能跨天，只有时分秒没法分辨 */
function fmtDateTime(iso) {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 站点登录态状态灯（卡片上站点名左边的小圆点）：
 *  绿=账号密码登录有效；黄=有令牌但不是可用登录态（手填的 / 登录令牌已失效）；
 *  红=什么都没有——余额、公告、分组识别这些登录态功能全是哑的 */
function loginLightDot(p) {
  const dot = (cls, title) => `<span class="dot login-dot ${cls}" title="${esc(title)}"></span>`
  if (!p.hasAdminToken) return dot('red', t('未填站点令牌：余额、公告、分组识别、用量核对都不可用'))
  if (p.adminTokenSource === 'login' && p.tokenStatus !== 'invalid') {
    return dot('green', t('登录态有效：账号密码登录的令牌，过期会自动续期'))
  }
  if (p.tokenStatus === 'invalid') {
    return dot('yellow', t('令牌已失效：余额、公告、分组识别暂时不可用，请重新登录或填入新令牌'))
  }
  return dot('yellow', t('已填站点令牌（非登录态）：功能可用，但不会自动续期'))
}

/** 余额状态徽章：档位全站统一——≤0 红（真没钱了）、低于阈值黄（该充值）、
 *  阈值关闭（0）不亮警告。此前站点页黄、监控页红，同一状态两种解读 */
function balanceBadge(balance, threshold) {
  if (balance === null || balance === undefined) return `<span class="badge">${t('无数据')}</span>`
  if (Number(threshold) > 0 && balance <= 0) return `<span class="badge danger">${t('低于阈值')}</span>`
  if (Number(threshold) > 0 && balance <= threshold) return `<span class="badge warn">${t('低于阈值')}</span>`
  return `<span class="badge ok">${t('正常')}</span>`
}

/**
 * 倍率数字的颜色档位（全站三处共用：监控变动流、站点卡分组胶囊、分组倍率弹窗）。
 * 常态（含折扣）与分组文字同色、仅加粗——「颜色只用来表达状态，不用来分区」：
 * 折扣是常态不是警报，标绿会和分组身份色抢语义；只有加价才是需要提醒的异常。
 * 「哪档便宜」的判断交给数字本身和比价页的「最便宜」徽章。
 */
function ratioToneClass(rate) {
  const n = Number(rate)
  if (!Number.isFinite(n)) return ''
  if (n > 2) return 'bad'
  if (n > 1.2) return 'warn'
  return ''
}

/**
 * 分组胶囊的厂商色（聚合判定）：组内全部免费 → 免费紫（与「免费 N」徽章同款）；
 * 忽略识别不出前缀的模型后，全国产 → 国产蓝、恰好一家海外 → 该厂色；
 * 混合厂商 → 中性灰。识别不出的模型不参与判断（不把整组拖成灰色）。
 * 免费判定是展示层近似（倍率 0 或手填双零价），权威判定在服务端 isFreeOffer。
 */
function groupChipClass(groupOffers) {
  if (!Array.isArray(groupOffers) || groupOffers.length === 0) return ''
  const isFree = (o) =>
    o.pricingMode === 'manual'
      ? Number(o.inPrice) === 0 && Number(o.outPrice) === 0
      : Number(o.ratio) === 0
  if (groupOffers.every(isFree)) return 'vchip-free'
  const chips = new Set()
  for (const o of groupOffers) {
    const cls = vendorChipClass(o.modelKey || o.upstreamName)
    if (cls) chips.add(cls)
  }
  if (chips.size === 0) return ''
  if ([...chips].every((c) => c === 'vchip-cn')) return 'vchip-cn'
  if (chips.size === 1) return [...chips][0]
  return ''
}

/**
 * 「站点 × 分组」→ 胶囊色。**同一分组在所有页面必须同色**，所以判定只看
 * 该站该分组下全部供给的聚合，不看单行模型——站点卡、Key 行、比价未定价块、
 * 智能决策、路由日志都调这一份。此前决策页按单行模型取色、站点卡按聚合，
 * 同一分组两页两个颜色，就是这个函数要修的。
 */
function groupChipOf(providerId, groupName) {
  const g = String(groupName || '')
  const groupOffers = (state.offers || []).filter(
    (o) => o.providerId === providerId && (o.group || '') === g,
  )
  return groupChipClass(groupOffers)
}

let toastTimer = null
function toast(message, isError = false) {
  const el = $('#toast')
  el.textContent = message
  el.className = `toast${isError ? ' error' : ''}`
  el.hidden = false
  translateDom(el)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, isError ? 4200 : 2200)
}

async function api(method, path, body, extraHeaders = null) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(extraHeaders || {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = new Error(data.error || `请求失败（${res.status}）`)
    // 把响应体挂上去：调用方要判断 needConfirm 之类的结构化错误
    error.status = res.status
    error.data = data
    throw error
  }
  return data
}

function providerName(id) {
  return state?.providers.find((p) => p.id === id)?.name || '未知站'
}

// ------------------------------------------------------------------ 渲染

// --------------------------------------------------------------- 通知中心

const NOTIFY_STORE_KEY = 'manageapi.readNotifs'

function loadReadIds() {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTIFY_STORE_KEY) || '[]')
    return new Set(Array.isArray(raw) ? raw : [])
  } catch {
    return new Set()
  }
}

function saveReadIds(ids) {
  try {
    localStorage.setItem(NOTIFY_STORE_KEY, JSON.stringify([...ids].slice(-300)))
  } catch {
    /* localStorage 满了就算了 */
  }
}

/**
 * 通知全部从当前状态派生，不额外存库。
 * 这样通知永远和数据一致，不会出现「已读的旧消息还挂着」。
 */
function buildNotifications() {
  const list = []
  const scores = state.scores || {}

  // 余额偏低（余额挂在站点上，一个站一条）。
  // 阈值与监控告警同一份（settings.balanceWarnUsd，统一按美元；0 = 关闭提醒），
  // 人民币余额按汇率折算后再比——此前这里硬编码 ¥10/$1.5，和告警设置对不上
  for (const p of state.providers || []) {
    if (typeof p.quotaRemaining !== 'number') continue
    const currency = p.currency || 'CNY'
    const rawUsd = Number(state.settings?.balanceWarnUsd ?? state.settings?.balanceWarnCny)
    const warnUsd = Number.isFinite(rawUsd) && rawUsd >= 0 ? rawUsd : 10
    if (warnUsd === 0) continue
    const fx = Number(state.settings?.fx?.rates?.CNY) || 7.2
    const threshold = currency.toUpperCase() === 'CNY' ? warnUsd * fx : warnUsd
    if (p.quotaRemaining > threshold) continue
    list.push({
      id: `quota:${p.id}:${p.quotaRemaining}`,
      level: p.quotaRemaining <= 0 ? 'danger' : 'warn',
      title: t('{name} 余额偏低', { name: p.name }),
      desc: t('剩余 {amount} {currency}，该充值了', { amount: p.quotaRemaining, currency }),
    })
  }

  // 站点异常（按站聚合，避免刷屏）
  const health = new Map()
  for (const [offerId, score] of Object.entries(scores)) {
    if (!['degraded', 'unstable', 'stale'].includes(score.status)) continue
    const offer = state.offers.find((o) => o.id === offerId)
    if (!offer) continue
    const entry = health.get(offer.providerId) || { count: 0, severe: false, reasons: new Set() }
    entry.count += 1
    if (score.status === 'unstable') entry.severe = true
    if (score.status === 'degraded') entry.reasons.add(t('结果可疑'))
    if (score.status === 'stale') entry.reasons.add(t('评分过期'))
    health.set(offer.providerId, entry)
  }
  for (const [providerId, entry] of health) {
    const provider = state.providers.find((p) => p.id === providerId)
    list.push({
      id: `health:${providerId}:${[...entry.reasons].join(',')}`,
      level: entry.severe ? 'danger' : 'warn',
      title: t('{name} {state}', {
        name: provider?.name || t('站点'),
        state: entry.severe ? t('不稳定') : t('需要关注'),
      }),
      desc: t('{n} 个模型 · {reasons}', { n: entry.count, reasons: [...entry.reasons].join(' · ') }),
    })
  }

  // 最近的路由事件：自动切换 / 全部失败
  for (const r of (state.routing || []).slice(0, 12)) {
    if (r.outcome === 'failed') {
      list.push({
        id: `fail:${r.id}`,
        level: 'danger',
        title: t('请求全部失败'),
        desc: t('{model}：所有候选站都不可用', { model: r.model }),
      })
    } else if (r.attempts > 1) {
      list.push({
        id: `switch:${r.id}`,
        level: 'info',
        title: t('自动切换了站点'),
        desc: t('{model}：首选失败，第 {n} 次成功（{provider}）', {
          model: r.model,
          n: r.attempts,
          provider: r.chosenProviderName || '—',
        }),
      })
    }
  }

  const order = { danger: 0, warn: 1, info: 2 }
  return list.sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3))
}

function renderNotifications() {
  const list = buildNotifications()
  const readIds = loadReadIds()
  const unread = list.filter((n) => !readIds.has(n.id))

  const dot = $('#notify-dot')
  if (dot) dot.hidden = unread.length === 0

  const btn = $('#notify-btn')
  if (btn) btn.title = unread.length ? t('{n} 条未读', { n: unread.length }) : t('通知')

  const container = $('#notify-list')
  if (!container) return
  if (list.length === 0) {
    container.innerHTML = '<div class="notify-empty">暂时没有通知</div>'
    translateDom(container)
    return
  }
  container.innerHTML = list
    .map(
      (n) => `
      <div class="notify-item ${n.level} ${readIds.has(n.id) ? 'read' : ''}">
        <span class="notify-bar"></span>
        <span class="notify-text"><b>${esc(n.title)}</b><span>${esc(n.desc)}</span></span>
      </div>`,
    )
    .join('')
  translateDom(container)
}

/**
 * 打开使用说明弹窗。
 * 内容从隐藏的 #view-help 页面复制过来——一份内容两处用，不用维护两份。
 * 说明有中英两份静态块（data-lang-block），按当前语言挑一份复制。
 */
function openHelpModal() {
  const source =
    document.querySelector(`#view-help .doc[data-lang-block="${getLang()}"]`) ||
    document.querySelector('#view-help .doc')
  const content = $('#help-content')
  const toc = $('#help-toc')
  if (!source || !content || !toc) return

  content.innerHTML = `<div class="doc">${source.innerHTML}</div>`

  const headings = [...content.querySelectorAll('h3, h4')]
  headings.forEach((h, i) => {
    h.id = `help-h-${i}`
  })

  toc.innerHTML = headings
    .map((h, i) => {
      const level = h.tagName === 'H3' ? 'lvl1' : 'lvl2'
      return `<button class="toc-item ${level}" data-target="help-h-${i}">${esc(h.textContent)}</button>`
    })
    .join('')

  content.scrollTop = 0
  toc.scrollTop = 0
  const modal = $('#help-modal')
  if (modal) modal.hidden = false
}

function render() {
  renderOverview()
  renderMonitor()
  renderFree()
  renderPricing()
  renderDecision()
  renderProbes()
  renderGateway()
  renderUsage()
  renderBenchmark()
  // 分组抽屉挂在 body 上，不在任何 view 里；一键同步 / 改倍率 / 自动轮询改了 state，
  // 它得跟着重画（paintGroupModels 会保留滚动位置，不然 15 秒一跳回到顶部）
  paintGroupModels()

  const badges = $('#topbar-badges')
  if (badges) {
    const healthy = Object.values(state.scores || {}).filter((s) => s.routable).length
    const gw = state.gateway
    badges.innerHTML = `
      <span class="badge ${healthy ? 'ok' : ''}">${healthy} 条供给可路由</span>
      <span class="badge ${gw?.enabled ? 'ok' : ''}">网关${gw?.enabled ? '运行中' : '已关闭'}</span>`
  }
  renderNotifications()
  // 所有页面都渲染完之后统一过一遍文案，把中文换成英文（中文模式下是空操作）
  translateDom(document.body)
}

// --------------------------------------------------------------- 概览视图

function headlineHtml() {
  const line = state.headline
  if (!line) return ''
  // 整句走 t()：中英语序不同，拆成片段翻会串行
  const sentence = t('同样用 {model}，现在选「{provider}」最划算：{price}/百万 token，比最贵的站省 {pct}%。', {
    model: esc(line.modelKey),
    provider: `<strong>${esc(line.providerName)}</strong>`,
    price: `<strong>${priceText(line.price)}</strong>`,
    pct: `<strong>${line.spreadPct}</strong>`,
  })
  // 不再挂「当前最优选择」小标题：一句话自己说清楚，标题交给页面头
  return `
    <div class="headline">
      <div class="line">${sentence}</div>
    </div>`
}

/**
 * 一组线条图标，只给「统计卡 / 版块标题」用。
 * 为什么不引图标库：全站只需要十来个形状，内联 SVG 比多一个 200KB 的依赖划算。
 */
const ICONS = {
  'eye-off': '<path d="M3 3l18 18"/><path d="M10.6 6.2A10.9 10.9 0 0 1 12 6c5 0 9 4.5 9 6 0 .6-.8 1.9-2.2 3.2"/><path d="M6.2 7.6C3.9 9 3 11.2 3 12c0 1.5 4 6 9 6 1 0 1.9-.2 2.8-.5"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  gift: '<rect x="3" y="8" width="18" height="13" rx="1.5"/><path d="M3 12h18M12 8v13"/><path d="M12 8c-2.5 0-4-1-4-2.6A1.9 1.9 0 0 1 12 5.4a1.9 1.9 0 0 1 4-.1C16 7 14.5 8 12 8z"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M15 12v2"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  servers: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5Z"/><path d="M3 13l9 5 9-5"/>',
  columns: '<rect x="3" y="5" width="5.5" height="14" rx="1.5"/><rect x="10" y="5" width="4" height="14" rx="1.5"/><rect x="16.5" y="5" width="4.5" height="14" rx="1.5"/>',
  trend: '<path d="M4 16l5-5 3 3 6-7"/><path d="M18 7h3v3"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>',
  alert: '<path d="M12 4l9 16H3L12 4Z"/><path d="M12 10v4M12 17h.01"/>',
  chart: '<path d="M4 19V5M4 19h16"/><path d="M8 15l3-4 3 2 4-6"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="16.5" cy="14.5" r="1"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/>',
  swap: '<path d="M7 20V4M7 4L4 7M17 4v16M17 20l3-3"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  'chevron-up': '<path d="M6 15l6-6 6 6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
  download: '<path d="M12 4v10"/><path d="M8 11l4 4 4-4"/><path d="M4 19h16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
}

// 站点系别徽章：vendor（厂商直连）与三系中转各一档，unknown 不显示（没信息不标）。
// 配色刻意不沿用分组胶囊的 .vchip-* 厂商品牌色——系别是「软件系」不是「模型厂商」，
// NewAPI 套 ChatGPT 绿之类会造成语义误导；vendor 用免费紫区分特殊类，三系统一蓝灰
const ID_PROVIDER_KIND = {
  vendor: { label: '厂商直连', cls: 'kindchip-vendor' },
  'one-api': { label: 'OneAPI', cls: 'kindchip-relay' },
  'new-api': { label: 'NewAPI', cls: 'kindchip-relay' },
  sub2api: { label: 'Sub2API', cls: 'kindchip-relay' },
}

function icon(name, cls = '') {
  const body = ICONS[name] || ''
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round"${cls ? ` class="${cls}"` : ''}>${body}</svg>`
}

function statsHtml() {
  const s = state.summary
  const items = [
    ['站点', s.providerCount, '', 'servers', 'tint-muted'],
    ['模型供给', s.offerCount, '条', 'layers', 'tint-accent'],
    ['可横向比较', s.comparableCount, '个模型', 'columns', 'tint-muted'],
    [
      '最大价差',
      s.maxSpreadPct === null ? '—' : s.maxSpreadPct,
      s.maxSpreadPct === null ? '' : '%',
      'trend',
      'tint-warn',
    ],
  ]
  return `<div class="stats">${items
    .map(
      ([k, v, unit, ic, tint]) => `
    <div class="stat">
      <div class="stat-main">
        <div class="k">${k}</div>
        <div class="v">${esc(v)}${unit ? `<small>${unit}</small>` : ''}</div>
      </div>
      <div class="stat-icon ${tint}">${icon(ic)}</div>
    </div>`,
    )
    .join('')}</div>`
}

// 概览「需要关注」默认只露前几条：站多了以后一屏全是红点，反而看不到下面的速览
const OVERVIEW_ISSUE_PREVIEW = 4
let overviewIssuesOpen = false

function renderOverview() {
  const view = $('#view-overview')
  const scores = state.scores || {}
  const providers = state.providers

  if (providers.length === 0) {
    setPageSubFor('overview', '还没有数据')
    view.innerHTML = `
      <div class="empty">
        <h3>从添加一个中转站开始</h3>
        <p>填上地址和一个 Key，同步模型列表，就能看到跨站比价。</p>
        <button class="primary" data-act="add-provider">${icon('plus')}新增站点</button>
      </div>`
    return
  }

  // 探针判定有问题的供给——按站点聚合，避免同一个站刷屏
  const issueMap = new Map()
  for (const [offerId, score] of Object.entries(scores)) {
    if (!['degraded', 'unstable', 'stale'].includes(score.status)) continue
    const offer = state.offers.find((o) => o.id === offerId)
    const provider = providers.find((p) => p.id === offer?.providerId)
    if (!provider) continue
    const entry =
      issueMap.get(provider.id) || { name: provider.name, count: 0, reasons: new Set(), severe: false }
    entry.count += 1
    if (score.status === 'unstable') entry.severe = true
    if (score.stale) entry.reasons.add('评分过期')
    if (score.availability !== null && score.availability < 0.8) entry.reasons.add('可用率低')
    if (score.fingerprintRate !== null && score.fingerprintRate < 1) entry.reasons.add('指纹不符')
    if (score.truncationRate !== null && score.truncationRate < 1) entry.reasons.add('输出截断')
    if (score.billingRate !== null && score.billingRate < 1) entry.reasons.add('用量虚报')
    issueMap.set(provider.id, entry)
  }
  const issues = [...issueMap.values()]

  const issueRows = (list) =>
    list
      .map(
        (issue) => `
        <div class="notice ${issue.severe ? 'danger' : ''}">
          <span class="name">${esc(issue.name)}</span>
          <span class="desc">${issue.count} 个模型</span>
          <span class="grow"></span>
          <span class="desc">${[...issue.reasons].join(' · ')}</span>
        </div>`,
      )
      .join('')

  const hiddenCount = overviewIssuesOpen ? 0 : Math.max(0, issues.length - OVERVIEW_ISSUE_PREVIEW)
  const issueBlock =
    issues.length === 0
      ? `
    <h3 class="section-title"><span class="s-icon">${icon('alert')}</span>需要关注</h3>
    <div class="notice-list">
      <div class="notice calm">
        <span class="name">一切正常</span>
        <span class="grow"></span>
        <span class="desc">所有探测过的供给都在正常范围</span>
      </div>
    </div>`
      : `
    <h3 class="section-title"><span class="s-icon">${icon('alert')}</span>需要关注（${issues.length} 个站点）</h3>
    <div class="notice-list">
      ${issueRows(overviewIssuesOpen ? issues : issues.slice(0, OVERVIEW_ISSUE_PREVIEW))}
      ${
        hiddenCount > 0
          ? `<button class="notice-more" data-act="overview-issues-toggle">还有 ${hiddenCount} 个站点，展开全部</button>`
          : issues.length > OVERVIEW_ISSUE_PREVIEW
            ? `<button class="notice-more" data-act="overview-issues-toggle">收起</button>`
            : ''
      }
    </div>`

  const rankingMap = new Map((state.siteRanking || []).map((r) => [r.providerId, r]))
  const orderedProviders = [...providers].sort((a, b) => {
    const ra = rankingMap.get(a.id)?.score
    const rb = rankingMap.get(b.id)?.score
    return (rb ?? -1) - (ra ?? -1)
  })

  const siteRows = orderedProviders.map((provider) => {
    const offers = state.offers.filter((o) => o.providerId === provider.id)
    const healthy = offers.filter((o) => scores[o.id]?.routable).length
    const hasQuota = typeof provider.quotaRemaining === 'number'
    const rank = rankingMap.get(provider.id)
    const issue = issueMap.get(provider.id)
    const dotClass = issue ? (issue.severe ? 'red' : 'yellow') : rank ? 'green' : 'gray'

    const scoreCell = rank
      ? `<div class="score-wrap">
           <b>${rank.score}</b>
           <div class="score-bar"><i class="${rank.score >= 80 ? 'good' : rank.score >= 60 ? 'mid' : 'bad'}" style="width:${Math.min(rank.score, 100)}%"></i></div>
         </div>
         <div class="sub">可用 ${Math.round((rank.uptime ?? 0) * 100)}%${
           rank.avgQuality !== null ? ` · 质量 ${rank.avgQuality.toFixed(2)}` : ''
         }${rank.avgTtft ? ` · ${rank.avgTtft}ms` : ''}${rank.probes ? ` · ${rank.probes} 次` : ''}</div>`
      : '<span style="color:var(--faint)">未探测</span>'

    return `
      <tr>
        <td><span class="dot ${dotClass}"></span>${esc(provider.name)}</td>
        <td class="num">${scoreCell}</td>
        <td class="num">${offers.length}</td>
        <td class="num">${healthy ? `<span class="badge ok">${healthy}</span>` : '<span class="badge">0</span>'}</td>
        <td class="num">${hasQuota ? `${priceSym()}${money(dispAmount(provider.quotaRemaining, provider.currency))}` : '<span style="color:var(--faint)">未录入</span>'}</td>
        <td class="num">${state.credentials.filter((c) => c.providerId === provider.id).length}</td>
      </tr>`
  }).join('')

  setPageSubFor(
    'overview',
    `${state.summary.providerCount} 个站点 · ${state.summary.offerCount} 条模型供给 · ${state.probeTotal} 次探测`,
  )

  view.innerHTML = `
    ${headlineHtml()}
    ${statsHtml()}
    ${issueBlock}
    <h3 class="section-title">
      <span class="s-icon">${icon('table')}</span>站点速览
      <a class="link" data-goto="providers">全部站点 →</a>
    </h3>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>站点</th><th class="num">长期评分</th><th class="num">模型</th><th class="num">健康供给</th>
          <th class="num">余额</th><th class="num">Key</th>
        </tr></thead>
        <tbody>${siteRows}</tbody>
      </table>
    </div>`
}

// --------------------------------------------------------------- 站点视图

const usageCheckResults = {}

/** 分组选择弹窗的状态 */
const groupPicker = {
  providerId: null,
  // 分组是「哪把 Key」的属性，弹窗必须记住是从哪一行点进来的
  credentialId: null,
  loading: false,
  error: null,
  data: null,
  selected: '',
  busy: false,
}

/**
 * 打开「选分组」弹窗：先把该站的分组拉下来，让用户点选，选中再应用。
 *
 * 为什么一定要让用户选：倍率是按分组定的，而「你买的是哪个分组」是商务事实，
 * 工具从 API 里读不出来（Key 只告诉你「能用哪些模型」，不告诉你「属于哪个分组」）。
 */
async function openGroupPicker(providerId, credentialId = null, { fresh = false } = {}) {
  groupPicker.providerId = providerId
  groupPicker.credentialId = credentialId
  groupPicker.loading = true
  groupPicker.error = null
  groupPicker.data = null
  groupPicker.selected = ''
  groupPicker.busy = false
  const modal = $('#group-modal')
  if (modal) modal.hidden = false
  renderGroupModal()

  try {
    const params = new URLSearchParams()
    if (credentialId) params.set('credentialId', credentialId)
    if (fresh) params.set('fresh', '1')
    const query = params.toString() ? `?${params.toString()}` : ''
    const data = await api('GET', `/api/providers/${providerId}/groups${query}`)
    groupPicker.data = data
    const names = data.groups.map((g) => g.name)
    groupPicker.selected = names.includes(data.current) ? data.current : names[0] || ''
  } catch (error) {
    groupPicker.error = error.message
  }
  groupPicker.loading = false
  renderGroupModal()
}

function renderGroupModal() {
  const body = $('#group-modal-body')
  if (!body) return
  paintGroupModal(body)
  translateDom(body)
}

function paintGroupModal(body) {
  if (groupPicker.loading) {
    body.innerHTML = '<p class="hint" style="margin:6px 0">正在从站点读取分组和倍率…</p>'
    return
  }
  if (groupPicker.error) {
    body.innerHTML = `
      <div class="alert danger" style="margin:0 0 12px">
        <div>
          <div class="name">读不到分组</div>
          <div class="desc">${esc(groupPicker.error)}</div>
        </div>
      </div>
      <p class="hint" style="margin:0">读不到也不影响用：可以在下面手动填倍率，或者在「基准价」页直接填价格。</p>
      <div class="group-pick-foot"><span class="grow"></span>
        <button class="ghost" data-act="retry-groups">重试</button>
        <button class="ghost" data-act="close-group-modal">知道了</button>
      </div>`
    return
  }

  const d = groupPicker.data
  if (!d) return

  if (!d.groups.length) {
    body.innerHTML = `
      <div class="alert" style="margin:0 0 12px">
        <div>
          <div class="name">站点没有返回分组</div>
          <div class="desc">这个站的「${d.source === 'channels' ? '可用渠道' : '模型广场'}」里没有分组信息，只能手动填倍率或单价。</div>
        </div>
      </div>
      <div class="group-pick-foot"><span class="grow"></span>
        <button class="ghost" data-act="close-group-modal">知道了</button>
      </div>`
    return
  }

  const provider = state.providers.find((p) => p.id === groupPicker.providerId)
  // 存着的分组名在站点分组表里找不到 = 站方改过分组名。不提示的话用户会以为
  // 「当前」就是这个分组，倍率却始终不生效（价格停在上一次的值上，不报错）
  const staleName = d.current && d.currentKnown === false
  const rows = d.groups
    .map((g) => {
      const on = g.name === groupPicker.selected
      const covered = g.modelCount
      // 分组里具体哪些模型 → 悬停就能看。以前只给一个数字，每个分组都是同一个数，
      // 根本看不出「GM1 里到底有没有 Deepseek」
      const names = Array.isArray(g.models) ? g.models : []
      const namesTitle = names.length ? ` title="${esc(names.join('、'))}"` : ''
      return `
        <label class="${on ? 'on' : ''}" data-act="pick-group" data-pick-group="${esc(g.name)}"${namesTitle}>
          <input type="radio" name="pick-group" value="${esc(g.name)}" ${on ? 'checked' : ''} />
          <span class="gname">${esc(g.name)}${g.isCurrent ? ' <span class="badge">当前</span>' : ''}</span>
          <span class="grate">${g.rate === null ? '—' : `×${g.rate}`}</span>
          <span class="gcount">${covered} 个模型</span>
        </label>`
    })
    .join('')

  const noRate = d.groups.every((g) => g.rate === null)
  // 多 Key 时一定要写清「这次改的是哪一把」，否则用户会以为改错了 Key
  const keyLine = d.credentialLabel
    ? `<b>${esc(d.credentialLabel)}</b> 这把 Key${d.keyCount > 1 ? `（该站共 ${d.keyCount} 把）` : ''}`
    : ''
  body.innerHTML = `
    <p class="hint" style="margin:0 0 4px">
      <b>${esc(provider?.name || '')}</b> 共 ${d.groups.length} 个分组，数据来自
      ${d.source === 'channels' ? '「可用渠道」' : '「模型广场」'}。
      ${keyLine ? `下面选的分组只作用于 ${keyLine}，不会动其它 Key。<br />` : ''}
      选你实际买的那个，倍率会立刻填到这把 Key 对应的模型上，比价和决策页同步更新。
    </p>
    ${noRate ? '<p class="hint" style="color:var(--warn);margin:6px 0 0">这个站没公布倍率，只能填绝对价。选完会按原价填入。</p>' : ''}
    ${
      staleName
        ? `<div class="alert" style="margin:8px 0 0">
            <div>
              <div class="name">当前保存的分组名，站点上已经没有了</div>
              <div class="desc">存的是「${esc(d.current)}」。站方改过分组名之后，倍率就查不到了，价格会停在上一次的值上。
              在下面重新选一次正确的分组（鼠标悬停能看到每个分组里有哪些模型）。</div>
            </div>
          </div>`
        : ''
    }
    <div class="group-pick">${rows}</div>
    <div class="group-pick-foot">
      <span class="hint" style="margin:0">选中的分组会记在这把 Key 上，下次不用再选</span>
      <span class="grow"></span>
      <button class="ghost" data-act="close-group-modal">取消</button>
      <button class="primary" data-act="apply-group" ${groupPicker.busy ? 'disabled' : ''}>
        ${groupPicker.busy ? '应用中…' : '应用倍率'}
      </button>
    </div>`
}

/**
 * 只更新选中态，不重建整个列表。
 *
 * 分组动辄二三十个，重渲染会把滚动位置弹回顶部——用户好不容易滚到 GM2，
 * 一选就跳回最上面，等于白找。所以选中态就地改。
 */
function markSelectedGroup() {
  const pick = document.querySelector('.group-pick')
  if (!pick) return
  for (const label of pick.children) {
    const on = label.dataset.pickGroup === groupPicker.selected
    label.classList.toggle('on', on)
    const radio = label.querySelector('input')
    if (radio) radio.checked = on
  }
}

/** 应用选中分组的倍率 */
async function applyPickedGroup(button) {
  const providerId = groupPicker.providerId
  if (!providerId) return
  groupPicker.busy = true
  renderGroupModal()
  try {
    const result = await api('POST', `/api/providers/${providerId}/apply-group`, {
      group: groupPicker.selected,
      credentialId: groupPicker.credentialId || undefined,
    })
    state = result
    const modal = $('#group-modal')
    if (modal) modal.hidden = true
    groupPicker.busy = false
    render()

    const r = result.groupResult
    // 多 Key 时必须点名改的是哪一把，否则用户分不清「第二把改了，第一把怎么没变」
    const keyPrefix = r.credentialLabel ? `${r.credentialLabel}：` : ''
    const parts = [`${keyPrefix}「${r.group || '未指定分组'}」已应用`]
    if (r.rate !== null) parts.push(`倍率 ×${r.rate}`)
    parts.push(`${r.updated} 个模型`)
    // 分组删掉后重新导入：这个 Key 名下已经没有供给行，后端会按它重新拉一次模型
    if (r.resynced) parts.push(`重新拉回 ${r.resynced} 个模型`)
    // 按次计费的模型单价是「每次多少元」，和 token 口径分开报，免得用户以为漏了
    if (r.viaPercall) parts.push(`其中 ${r.viaPercall} 个按次计费`)
    if (r.unmatched?.length) parts.push(`${r.unmatched.length} 个未匹配`)
    toast(parts.join('，'))
    if (r.groupUnknown) {
      setTimeout(
        () =>
          toast(
            `「${r.group}」不在站点现在的分组列表里，倍率对不上，价格没有改动。站方多半改过分组名，去「选分组」重新选一次。`,
            true,
          ),
        1700,
      )
    }
    if (r.resyncError) {
      setTimeout(
        () =>
          toast(
            `分组已记在这把 Key 上，但拉模型失败：${r.resyncError}。点「一键同步」可以再试一次。`,
            true,
          ),
        1700,
      )
    }
    if (r.missingBench?.length) {
      setTimeout(
        () =>
          toast(
            `${r.missingBench.length} 个模型缺基准价，已按站点原价直接填。去「基准价」页补上官方价，才能用倍率统一调整。`,
            true,
          ),
        1700,
      )
    }
  } catch (error) {
    groupPicker.busy = false
    renderGroupModal()
    toast(error.message, true)
  }
}

/**
 * 扣费核验：把「我们本地算的 token」和「站点上报的 token」摆在一起。
 *
 * 这才是能抓虚报的地方——站点虚报 prompt_tokens 时，我们的 usage 会跟着虚报，
 * 拿它和站点账单比永远一致；只有本地按请求体重新数一遍才有对照价值。
 */
function renderUsageCheck(providerId) {
  const check = usageCheckResults[providerId]
  if (!check) return ''
  const est = check.estimate || {}
  const verify = check.verify || {}
  const site = verify.site || null
  const samples = verify.samples || []
  const suspicious = samples.filter((x) => x.suspicious)

  const pct = (reported, local) => {
    if (!local || !reported) return ''
    const diff = (reported / local - 1) * 100
    return `${diff > 0 ? '+' : ''}${diff.toFixed(0)}%`
  }
  const toneOf = (reported, local) => {
    if (!local || !reported) return ''
    const ratio = reported / local
    return ratio > 2 ? 'danger' : ratio > 1.5 ? 'warn' : ''
  }

  const comparable = samples.filter((x) => typeof x.local === 'number' && x.local > 0)
  const sampleRows = comparable.slice(0, 8).map((x) => `
    <tr>
      <td class="mono" style="font-size:11px">${fmtDateTime(x.at)}</td>
      <td class="mono" style="font-size:11px">${esc(x.modelKey || '—')}</td>
      <td class="num">${x.local === null ? '—' : formatTokens(x.local)}</td>
      <td class="num">${x.reported === null ? '—' : formatTokens(x.reported)}</td>
      <td class="num ${toneOf(x.reported, x.local)}">${pct(x.reported, x.local) || '—'}</td>
    </tr>`).join('')

  return `
    <div class="keylist" style="border-top:1px solid var(--border);padding-top:10px">
      <div class="keyrow" style="border:none;padding-bottom:4px">
        <span style="color:var(--muted);font-size:12px">扣费核验</span>
        <span class="grow"></span>
        ${suspicious.length
          ? `<span class="badge danger">${suspicious.length} 条上报异常</span>`
          : comparable.length
            ? '<span class="badge ok">样本正常</span>'
            : '<span class="badge">还没有样本</span>'}
      </div>
      ${check.error ? `<div class="hint" style="padding:2px 0 6px">没拉到站方数据：${esc(check.error)}</div>` : ''}
      <div style="font-size:12px;line-height:1.9;padding:2px 0 4px">
        <div>我们记录的网关用量：<b>${priceText(est.cost)}</b>
          <span style="color:var(--faint)">（${est.requests || 0} 次 · 输入 ${formatTokens(est.input)} / 输出 ${formatTokens(est.output)}）</span></div>
        ${site ? `<div style="color:var(--muted)">站点全站账单：<b>${site.actualCost === null ? '—' : priceText(site.actualCost * rateCny())}</b>
          <span style="color:var(--faint)">（${site.requests ?? '—'} 次请求，含不经网关的直连流量）</span></div>` : ''}
      </div>
      ${comparable.length ? `
      <table class="mini-table" style="margin-top:6px">
        <thead><tr><th>时间</th><th>模型</th><th class="num">本地估算</th><th class="num">站点上报</th><th class="num">偏差</th></tr></thead>
        <tbody>${sampleRows}</tbody>
      </table>
      <div class="hint" style="margin:6px 0 0">
        本地估算 = 按请求体重新数的 token；站点上报 = 上游返回的 prompt_tokens。
        偏差超过 +100% 会标红——那说明站点在多算你的输入。缓存命中多时本地估算偏高是正常的（本地数不出缓存）。
      </div>` : '<div class="hint" style="padding:2px 0 6px">还没有样本：网关转发 20 次成功请求后会开始抽样。</div>'}
      <details style="margin-top:6px">
        <summary style="cursor:pointer;font-size:11px;color:var(--faint)">站点原始返回</summary>
        <pre class="raw-box">${esc(JSON.stringify(check.raw ?? null, null, 2))}</pre>
      </details>
    </div>`
}

/**
 * 概览图的悬停提示。
 *
 * 数据从卡片上的 data-chart-ctx 读——那是渲染时算好的同一份序列，
 * 保证 tooltip 和图上画的东西一致（尤其「全部」模式下的合计口径）。
 */
function showChartTip(hitEl) {
  const card = hitEl.closest('[data-chart-ctx]')
  const tip = document.getElementById('chart-tip')
  if (!card || !tip) return
  let ctx
  try {
    ctx = JSON.parse(card.dataset.chartCtx)
  } catch {
    return
  }
  const i = Number(hitEl.dataset.chartDay)
  if (!Number.isInteger(i) || i < 0) return

  // 注意不能叫 money：那会和模块级 money() 撞名，函数体里再调用就是
  // 自我引用的 TDZ 错误（整个 hover 处理器会静默失败）
  const fmtMoney = (v) => `${priceSym()}${money(dispPrice(v))}`
  const rows = []

  if (ctx.site === 'ALL') {
    const bal = ctx.balance[i]
    rows.push(`<div class="chart-tip-head">${esc(ctx.days[i])}</div>`)
    rows.push(`<div class="chart-tip-row"><span>${t('余额合计')}</span><b>${bal === null ? '—' : fmtMoney(bal)}</b></div>`)
    const parts = ctx.providers
      .map((pid) => ({ pid, name: ctx.names[pid] || pid, value: ctx.spend[i]?.[pid] || 0 }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value)
    if (parts.length) {
      rows.push('<div class="chart-tip-sep"></div>')
      for (const part of parts) {
        rows.push(
          `<div class="chart-tip-row"><span><i class="chart-tip-dot" style="background:${esc(ctx.colors[part.pid] || 'var(--faint)')}"></i>${esc(part.name)}</span><span>${fmtMoney(part.value)}</span></div>`,
        )
      }
      rows.push(
        `<div class="chart-tip-sep"></div><div class="chart-tip-row"><span>${t('花费合计')}</span><b>${fmtMoney(ctx.total[i] || 0)}</b></div>`,
      )
    }
  } else {
    const bal = ctx.balance[i]
    rows.push(`<div class="chart-tip-head">${esc(ctx.days[i])} · ${esc(ctx.names[ctx.site] || ctx.site)}</div>`)
    rows.push(`<div class="chart-tip-row"><span>${t('余额')}</span><b>${bal === null ? '—' : fmtMoney(bal)}</b></div>`)
    rows.push(`<div class="chart-tip-row"><span>${t('花费')}</span><b>${fmtMoney(ctx.spend[i]?.[ctx.site] || 0)}</b></div>`)
  }

  tip.innerHTML = rows.join('')
  tip.classList.add('is-on')

  // 定位：跟随光标所在列，靠右时翻到左侧
  const wrap = tip.parentElement
  const wrapRect = wrap.getBoundingClientRect()
  const hitRect = hitEl.getBoundingClientRect()
  const centerX = hitRect.left + hitRect.width / 2 - wrapRect.left
  const tipW = tip.offsetWidth
  let left = centerX + 14
  if (left + tipW > wrapRect.width) left = centerX - tipW - 14
  tip.style.left = `${Math.max(0, left)}px`
  tip.style.top = '12px'
}

/** 站点卡列表的 HTML（监控页专用；「站点」视图已并入监控页） */
function providersHtml({ withForm = true, panel = '', actions = '' } = {}) {
  const addForm = withForm ? $('#tpl-add-provider').innerHTML : ''

  if (state.providers.length === 0) {
    // 空状态也必须给出 actions（里面有「新增站点」按钮）：此前直接 return，
    // 按钮被丢掉，刚 clone 完的用户看到「还没有站点」却点不了任何东西
    return `
      ${actions ? `<div class="sync-actions" style="margin-bottom:12px">${actions}</div>` : ''}
      <div class="empty">
        <h3>还没有站点</h3>
        <p>先添加一个中转站，填上它的地址和一个 Key，就能拉取模型列表开始比价。</p>
        <button class="primary" data-act="add-provider">${icon('plus')}新增站点</button>
      </div>
      ${addForm}`
  }

  const query = siteQuery.trim().toLowerCase()
  const matched = query
    ? state.providers.filter(
        (p) => p.name.toLowerCase().includes(query) || String(p.baseUrl || '').toLowerCase().includes(query),
      )
    : state.providers
  const pageCount = Math.max(1, Math.ceil(matched.length / SITE_PAGE_SIZE))
  sitePage = Math.min(Math.max(1, sitePage), pageCount)
  const visibleProviders = matched.slice((sitePage - 1) * SITE_PAGE_SIZE, sitePage * SITE_PAGE_SIZE)

  const cards = visibleProviders.map((p) => {
    const keys = state.credentials.filter((c) => c.providerId === p.id)
    // 全局名次（不按当前分页/搜索算），上下移动就是和相邻名次换位
    const rank = (state.providers || []).findIndex((item) => item.id === p.id) + 1
    const total = (state.providers || []).length
    const offers = state.offers.filter((o) => o.providerId === p.id)
    const priced = offers.filter((o) => o.inPrice !== null || o.outPrice !== null || o.ratio !== null)
    // 余额是站点级的：一个后台账号一套，跟下面挂几个 Key 无关
    const hasQuota = typeof p.quotaRemaining === 'number'
    const quota = hasQuota
      ? p.currency === 'USD'
        ? p.quotaRemaining * rateCny()
        : p.quotaRemaining
      : 0

    // 中转站的倍率按「分组」定，不是按模型——所以按分组给一个批量入口。
    // 倍率归并结果（统一/混合/站点值）算一次，分组胶囊与「分组倍率」弹窗共用，两边口径一致。
    // Key 上的分组也收进来：Key 选了分组但还没同步过模型时，这一行仍是可删的分组
    // （只是 0 个模型）——否则这种分组在界面上没有任何删它的入口
    const groupNames = [...new Set([
      ...offers.map((o) => o.group || ''),
      ...keys.map((k) => k.group || '').filter(Boolean),
    ])]
    const groupStats = new Map(groupNames.map((groupName) => {
      const groupOffers = offers.filter((o) => (o.group || '') === groupName)
      // 模型数取台账全量（含被忽略的）：这里显示的数要和「点开分组看到的清单」对得上，
      // 用 filtered offers 的话，忽略了一堆模型的站会出现「1 个模型」却点开一堆。
      const listed = state.modelsByGroup?.[p.id]?.[groupName]
      const ratioValues = new Set(groupOffers.map((o) => (o.ratio === null || o.ratio === undefined ? '' : String(o.ratio))))
      const siteRatios = new Set(
        groupOffers.map((o) => (o.siteRatio === null || o.siteRatio === undefined ? '' : String(o.siteRatio))),
      )
      return [groupName, {
        count: Array.isArray(listed) ? listed.length : groupOffers.length,
        uniform: ratioValues.size === 1 ? [...ratioValues][0] : '',
        mixed: ratioValues.size > 1,
        siteRatio: siteRatios.size === 1 ? [...siteRatios][0] : '',
        custom: groupOffers.some((o) => o.ratioSource === 'custom'),
        chipClass: groupChipClass(groupOffers),
      }]
    }))
    // 分组胶囊一屏只放前 GROUP_CHIP_LIMIT 个：分组动辄十几个，全铺开会把站点卡撑到两屏高。
    // 剩下的折成「还有 N 个」按钮，点开看全部——之前它是死文字，多出来的分组在界面上等于不存在。
    const chipsOpen = openGroupChips.has(p.id)
    const chipsShown = chipsOpen ? groupNames : groupNames.slice(0, GROUP_CHIP_LIMIT)
    const chipOf = (g) => {
      const st = groupStats.get(g) || {}
      // 倍率统一才敢标（混合分组标「混合」，未填只显示名字）——数字色是折扣语义
      const tag = st.mixed
        ? `<span class="chip-note">${t('混合')}</span>`
        : st.uniform !== '' && st.uniform !== undefined
          ? `<span class="ratio-tone ${ratioToneClass(st.uniform)}">×${esc(st.uniform)}</span>`
          : ''
      // 胶囊本身就是入口：点开右侧的悬浮抽屉，看这个分组里到底有哪些模型。
      // 用 span + role 而不是 button，是因为里面还要嵌一个「删分组」按钮（button 不能套 button），
      // 点删除键时 closest('[data-act]') 命中的是里面的按钮，不会误开抽屉。
      return `<span class="group-chip ${st.chipClass || ''}" role="button" tabindex="0" data-act="open-group-models" data-provider="${esc(p.id)}" data-group="${esc(g)}" title="${esc(
        t('点开看这个分组里的模型'),
      )}">${g ? esc(g) : t('未指定')}${tag}${
        g
          ? `<button class="chip-x" data-act="del-group" data-provider="${esc(p.id)}" data-group="${esc(g)}" title="删掉这个分组（Key 保留，可重新导入）">${icon('trash')}</button>`
          : ''
      }</span>`
    }
    const hiddenGroupCount = groupNames.length - chipsShown.length
    // 展开后给一个「收起」，否则点开就回不去了（折叠状态不落库，刷新页面自然复位）
    const moreChipHtml = hiddenGroupCount > 0
      ? `<button class="group-chip group-chip-more" data-act="toggle-group-chips" data-provider="${esc(p.id)}" title="${esc(
          t('点开看全部 {n} 个分组', { n: groupNames.length }),
        )}">${t('还有 {n} 个', { n: hiddenGroupCount })}</button>`
      : chipsOpen && groupNames.length > GROUP_CHIP_LIMIT
        ? `<button class="group-chip group-chip-more" data-act="toggle-group-chips" data-provider="${esc(p.id)}" title="${esc(
            t('收起，只显示前 {n} 个', { n: GROUP_CHIP_LIMIT }),
          )}">${t('收起')}</button>`
        : ''
    const groupRows = [...groupStats.entries()].map(([groupName, st]) => {
      const { uniform, mixed, siteRatio, custom } = st
      return `
        <div class="keyrow" data-group-ratio="${esc(groupName)}">
          <span>${groupName ? esc(groupName) : '<span style="color:var(--faint)">未指定分组</span>'}</span>
          <button class="ghost tiny gs-count" data-act="open-group-models" data-provider="${esc(p.id)}" data-group="${esc(groupName)}" title="${esc(
            t('点开看这个分组里的模型'),
          )}">${st.count} 个模型</button>
          <span class="grow"></span>
          ${mixed ? '<span style="color:var(--warn);font-size:11px">混合</span>' : ''}
          ${
            custom
              ? '<span class="badge warn">自定义</span>'
              : siteRatio !== ''
                ? '<span class="badge">站点值</span>'
                : ''
          }
          ${
            siteRatio !== ''
              ? `<span style="color:var(--faint);font-size:11px">站点 <span class="ratio-tone ${ratioToneClass(siteRatio)}">×${esc(siteRatio)}</span></span>`
              : ''
          }
          ${
            st.count === 0
              ? `<span style="color:var(--faint);font-size:11px">${t('还没同步过模型，先去「一键同步」')}</span>`
              : `<input type="number" step="0.01" min="0" placeholder="倍率" value="${uniform}" data-act="group-ratio" style="width:86px" title="改这里就是自定义倍率，不影响站点原始值" />`
          }
          ${
            custom
              ? `<button class="ghost tiny" data-act="restore-ratio" data-group="${esc(groupName)}" title="恢复成站点公布的倍率">恢复</button>`
              : ''
          }
          ${
            groupName
              ? `<button class="ghost danger tiny" data-act="del-group" data-group="${esc(groupName)}" title="删掉这个分组（该分组下的模型记录删掉；挂在这个分组上的 Key 保留，之后在 Key 那行点「选分组」可以重新导入）">删除</button>`
              : ''
          }
        </div>`
    }).join('')
    const hasCustom = offers.some((o) => o.ratioSource === 'custom')

    const kindMeta = ID_PROVIDER_KIND[p.kind] || null
    const kindText = kindMeta?.label || ''
    // 这个站有多少模型落在免费池里（后端算好名字，这里只数）
    const freeNames = Array.isArray(p.freeModels) ? p.freeModels : []
    // 告警阈值设置里存的是美元；quota 已折成人民币，比较必须同口径——
    // 以前 USD 站拿「人民币余额」对「美元阈值」，实际阈值被放大了 7 倍。
    // 展示按全局显示币种走（priceSym/dispPrice）
    const fxRate = rateCny()
    const warnUsd = Number(state.settings.balanceWarnUsd ?? state.settings.balanceWarnCny) || 0
    const warnCny = warnUsd > 0 ? warnUsd * fxRate : 0
    const statusBadge = hasQuota
      ? balanceBadge(quota, warnCny)
      : '<span class="badge">余额未录入</span>'

    return `
      <div class="card prov-card${p.paused ? ' is-paused' : ''}" data-provider="${esc(p.id)}" data-has-token="${p.hasAdminToken ? '1' : '0'}">
        <div class="prov-head">
          <div class="prov-id">
            ${loginLightDot(p)}
            <b>${esc(p.name)}</b>
            ${p.baseUrl ? `<a class="icon-btn prov-open" href="${esc(p.baseUrl)}" target="_blank" rel="noreferrer" title="${t('打开站点后台')}">${icon('external')}</a>` : ''}
            ${kindText ? `<span class="badge ${kindMeta.cls}" title="${esc(p.kindSource === 'manual' ? t('系别由用户手动设置') : t('系别由添加站点/登录时自动探测得出'))}">${esc(kindText)}</span>` : ''}
            ${
              freeNames.length
                ? `<span class="badge prov-free" title="${esc(t('免费模型：{list}', { list: freeNames.join('、') }))}">${icon('gift')}${t('免费 {n}', { n: freeNames.length })}</span>`
                : ''
            }
            ${p.paused ? `<span class="badge warn">${t('已暂停')}</span>` : ''}
          </div>
          <div class="prov-head-right">
            <span class="hint">${p.quotaUpdatedAt ? agoText(p.quotaUpdatedAt) : '还没同步过'}</span>
            <span class="prov-pri" draggable="true" data-provider="${esc(p.id)}" title="${t('拖动这张卡片调整顺序')}">
              <span class="prov-pri-no">${rank}</span>
              <span class="prov-pri-grip">${icon('grip')}</span>
            </span>
            <button class="icon-btn prov-pause" data-act="prov-toggle-pause" data-provider="${esc(p.id)}" title="${p.paused ? t('恢复这个站点') : t('暂停这个站点：不进比价、决策、探针和同步')}">${p.paused ? icon('play') : icon('pause')}</button>
            <button class="icon-btn prov-del-icon" data-act="del-provider" title="${t('删除站点')}">${icon('trash')}</button>
          </div>
        </div>

        <div class="prov-tiles">
          <div data-provider="${esc(p.id)}">
            <span class="k">余额</span>
            <b>${hasQuota ? `${priceSym()}${money(dispAmount(p.quotaRemaining, p.currency))}` : '—'}</b>
          </div>
          <div>
            <span class="k">已定价</span>
            <b>${priced.length} <span class="of">/ ${offers.length}</span></b>
          </div>
          <div>
            <span class="k">Key</span>
            <b>${keys.length} <span class="of">把</span></b>
          </div>
        </div>

        <div class="prov-tiles prov-tiles--3">
          <div>
            <span class="k">阈值 · 状态</span>
            <b>${warnUsd > 0 ? `${priceSym()}${money(dispPrice(warnCny))} · ` : ''}${statusBadge}</b>
          </div>
          <div title="${esc(t('「实际消费」按这个单价折算：1 个站点货币单位 = ¥X。留空则美元站按市场汇率、人民币站按 1'))}">
            <span class="k">${t('站点单价')}</span>
            <b><input class="unit-price" type="number" step="0.0001" min="0" placeholder="${p.currency === 'CNY' ? '1' : money(rateCny())}"
              value="${p.unitPrice ?? ''}" data-act="unit-price" /></b>
          </div>
          <div title="${esc(t('「令牌」是站点后台的登录凭证，一次填好整站通用，用来读余额、公告和分组'))}">
            <span class="k">令牌</span>
            <b>${p.hasAdminToken
              ? (p.tokenStatus === 'invalid'
                ? '<span class="badge danger">已失效</span>'
                : '<span class="badge ok">已填</span>')
              : '<span class="badge">未填</span>'}</b>
            <button class="ghost tiny" data-act="set-admin-token" data-provider="${esc(p.id)}" title="${esc(p.adminTokenTail ? `${t('令牌尾号')} …${p.adminTokenTail}` : t('未填站点令牌'))}">${p.hasAdminToken ? '更换' : '填写'}</button>
          </div>
        </div>

        <div class="prov-groups">
          <span class="k">${groupNames.length ? `${groupNames.length} 个分组` : '还没有分组'}</span>
          <span class="prov-group-chips">
            ${chipsShown.map(chipOf).join('')}
            ${moreChipHtml}
          </span>
        </div>

        <div class="prov-actions">
          <button data-act="prov-sync-all" title="同步模型 + 读余额 + 识别分组，一次跑完">${icon('refresh')}一键同步</button>
          <button data-act="prov-panel" data-panel="keys">${icon('key')}密钥</button>
          <button data-act="prov-panel" data-panel="rates">${icon('columns')}分组倍率</button>
          <button data-act="open-group-picker" title="从站点读分组，选你买的那个，倍率自动填到下面所有模型">${icon('columns')}导入倍率</button>
          <button data-act="usage-check" title="用管理令牌拉站方用量，和我们的估算对比">${icon('receipt')}用量核对</button>
          <button data-act="open-login" title="用站点后台的账号密码登录，自动获取并续期令牌——令牌过期不再需要手动换">${icon('key')}账号登录</button>
          <button data-act="export">${icon('download')}导出配置</button>
        </div>

        <div class="prov-detail" hidden>
        <div data-pane="keys">
        <div class="keylist">
          ${keys.length === 0 ? '<div class="hint">还没有 Key，加一个才能拉模型。</div>' : keys.map((k) => {
            const keyOffers = offers.filter((o) => o.credentialId === k.id)
            return `
            <div class="keyrow" data-credential="${esc(k.id)}">
              <span>${esc(k.label)}</span>
              <span class="tail">sk-••••${esc(k.tail || '????')}</span>
              <button class="ghost tiny group-chip ${groupChipOf(p.id, k.group)}" data-act="open-group-picker" title="${k.group ? '这把 Key 属于这个分组，点这里换' : '还没选分组，点这里选（会顺便把倍率填好）'}">
                ${k.group ? `分组 · ${esc(k.group)}` : '选分组'}
              </button>
              <span class="tail">${keyOffers.length} 个模型</span>
              <span class="grow"></span>
              <button class="ghost danger" data-act="del-key">删除</button>
            </div>`
          }).join('')}
          <form class="inline-form" data-form="add-key">
            <input name="label" placeholder="标签" />
            <input name="secret" placeholder="sk-... 粘贴完整 Key" autocomplete="off" required />
            <input name="group" placeholder="分组（可选）" style="width:118px" title="这把 Key 属于站点的哪个分组，同步模型时会自动带上" />
            <button type="submit">添加 Key</button>
          </form>
          ${
            p.hasAdminToken
              ? ''
              : `<div class="hint" style="margin-top:2px">
            ${t('「令牌」在站点卡片上（不在 Key 上）——它是站点后台的登录凭证，一个后台账号填一次，整站通用。获取：登录后台 → F12 → Network → 点任意 <code>/api/v1/</code> 请求 → 复制 Request Headers 里的 <code>Authorization</code>（去掉 <code>Bearer </code> 前缀）。令牌会过期，失效后重新复制。')}
          </div>`
          }
        </div>
        </div>
        ${groupRows ? `
        <div data-pane="rates" class="keylist" style="border-top:1px solid var(--border);padding-top:10px">
          <div class="keyrow" style="border:none;padding-bottom:2px">
            <span style="color:var(--muted);font-size:12px">分组倍率</span>
            <span class="grow"></span>
            ${
              hasCustom
                ? `<button class="ghost tiny" data-act="restore-ratio-all" title="把这个站所有自定义倍率改回站点公布的值">全部恢复为站点值</button>`
                : '<span style="color:var(--faint);font-size:11px">改一次，该分组所有模型一起变</span>'
            }
          </div>
          ${groupRows}
        </div>` : ''}
        <div data-pane="usage">${renderUsageCheck(p.id)}</div>
        </div>
      </div>`
  }).join('')

  // 站点多了以后一屏放不下：搜索 + 分页（每页 9 张，和 upstream-ops 一样）
  // 翻页信息跟着搜索框走，不单独占一行
  const pager = `<span class="site-pager">
      <span class="hint range">${t('显示 {from}-{to}，共 {n} 个', {
        from: matched.length ? (sitePage - 1) * SITE_PAGE_SIZE + 1 : 0,
        to: Math.min(sitePage * SITE_PAGE_SIZE, matched.length),
        n: matched.length,
      })}</span>
      <button class="ghost tiny" data-act="site-page" data-page="${sitePage - 1}" ${sitePage <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="hint">${t('{a} / {b}', { a: sitePage, b: pageCount })}</span>
      <button class="ghost tiny" data-act="site-page" data-page="${sitePage + 1}" ${sitePage >= pageCount ? 'disabled' : ''}>下一页</button>
    </span>`

  // 头部两行：标题 + 说明 / 右侧「配置卡 + 按钮组」；第二行搜索框 + 分页
  const header = state.providers.length > 0
    ? `<div class="sites-head">
        <div class="sites-title-block">
          <h3>站点余额与分组</h3>
          <span class="hint">分组倍率来自站点公布的可用渠道</span>
        </div>
        <div class="sites-bar">
          <input id="site-search" type="search" placeholder="${t('搜索站点名或地址')}" value="${esc(siteQuery)}" />
          ${pager}
          <span class="grow"></span>
          ${panel}
          <div class="sites-actions">${actions}</div>
        </div>
      </div>`
    : ''

  return `
    ${header}
    <div class="drop-zone" data-drop="prev" ${sitePage <= 1 ? 'hidden' : ''}>${t('放到上一页')}</div>
    <div class="site-cards">${matched.length ? cards : `<div class="empty small"><p>${t('没有匹配的站点。')}</p></div>`}</div>
    <div class="drop-zone" data-drop="next" ${sitePage >= pageCount ? 'hidden' : ''}>${t('放到下一页')}</div>
    ${addForm}`
}

/** 同步设置面板与「立即同步 / 新增站点」按钮：renderMonitor 与 refreshSiteCards
 *  共用——此前 refreshSiteCards（搜索/翻页局部重绘）不带这两块，搜索一敲字面板就消失 */
function syncPanelHtml(data = monitorData || {}) {
  return `
    <div class="sync-panel">
      <input type="number" min="0" step="5" id="monitor-interval" placeholder="同步间隔（分钟）" title="同步间隔（分钟），0 = 关闭" value="${data.settings?.monitorIntervalMinutes ?? 30}" />
      <input type="number" min="0" step="0.5" id="monitor-warn" placeholder="告警阈值（$）" title="余额告警阈值（美元），0 = 不告警" value="${data.settings?.balanceWarnUsd ?? 1.5}" />
      <input type="number" min="0" step="0.01" id="monitor-unit-price" placeholder="默认站点单价" title="默认站点单价（¥/1 站点美元）：所有站口径一致时只填一次，如「全部 1:1 充值」填 1。留空 = 按市场汇率" value="${state?.settings?.defaultUnitPrice ?? ''}" />
      <button class="primary" data-act="monitor-save-settings">保存</button>
    </div>`
}

function syncActionsHtml() {
  return `
    <button data-act="monitor-collect">${icon('refresh')}立即同步</button>
    <button class="primary" data-act="add-provider">${icon('plus')}新增站点</button>`
}

/** 只重画监控页里的站点卡（搜索、翻页时用，不重新拉数据） */
function refreshSiteCards() {
  const host = $('#monitor-sites-host')
  if (!host) return
  host.innerHTML = providersHtml({ withForm: false, panel: syncPanelHtml(), actions: syncActionsHtml() })
  bindSiteSearch()
  translateDom(host)
}

function bindSiteSearch() {
  const input = $('#site-search')
  if (!input || input.dataset.bound) return
  input.dataset.bound = '1'
  input.addEventListener('input', () => {
    if (imeComposing) return // 拼音组合中不重绘（见 document input 委托处的说明）
    siteQuery = input.value
    sitePage = 1
    refreshSiteCards()
    const again = $('#site-search')
    if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length) }
  })
}

function bindAddProviderForm() {
  const form = $('#form-add-provider')
  if (!form || form.dataset.bound) return
  form.dataset.bound = '1'

  // 预置站点：选中就填好名称和地址，省掉手打；地址留空的（拿不准的厂商）不填，让人自己补
  const preset = $('#preset-site', form)
  const sites = state.catalog?.sites || []
  if (preset && sites.length) {
    preset.innerHTML =
      `<option value="">（手动填写）</option>` +
      sites
        .map(
          (s) =>
            `<option value="${esc(s.id)}" data-name="${esc(s.name)}" data-url="${esc(s.baseUrl)}">${esc(s.name)}${s.baseUrl ? '' : ' · 地址待填'}</option>`,
        )
        .join('')
    preset.addEventListener('change', () => {
      const opt = preset.selectedOptions[0]
      if (!opt || !opt.value) return
      const nameInput = form.elements.name
      const urlInput = form.elements.baseUrl
      if (nameInput) nameInput.value = opt.dataset.name || ''
      if (urlInput && opt.dataset.url) urlInput.value = opt.dataset.url
      if (urlInput && !opt.dataset.url) urlInput.focus()
    })
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = Object.fromEntries(new FormData(form))
    // preset 只用于填表，不是站点字段
    delete data.preset
    try {
      state = await api('POST', '/api/providers', data)
      closeAddProvider()
      render()
      toast('站点已添加')
    } catch (error) {
      toast(error.message, true)
    }
  })
}

/** 账号密码登录弹窗：登录产物写入 adminToken，现有读取逻辑全部复用 */
function openLoginModal(providerId) {
  const modal = $('#login-modal')
  if (!modal) return
  const provider = (state.providers || []).find((p) => p.id === providerId)
  $('#login-modal-title').textContent = `${provider?.name || '站点'} · 账号登录`
  const form = $('#form-login')
  form.dataset.provider = providerId
  form.elements.user.value = ''
  form.elements.password.value = ''
  modal.hidden = false
  translateDom(modal)
  setTimeout(() => form.elements.user?.focus(), 60)
}

function closeLoginModal() {
  const modal = $('#login-modal')
  if (modal) modal.hidden = true
}

/** 新增站点：把模板塞进弹窗，弹窗关掉再清空（避免旧输入残留） */
function openAddProvider() {
  const modal = $('#add-provider-modal')
  const body = $('#add-provider-body')
  const tpl = $('#tpl-add-provider')
  if (!modal || !body || !tpl) return
  body.innerHTML = ''
  body.appendChild(tpl.content.cloneNode(true))
  // 弹窗标题已经写了「新增站点」，里面那块卡片和重复标题都去掉
  body.querySelector('#form-add-provider')?.classList.remove('card', 'form-card')
  body.querySelector('#form-add-provider > h3')?.remove()
  bindAddProviderForm()
  modal.hidden = false
  translateDom(modal)
  setTimeout(() => body.querySelector('input[name="name"]')?.focus(), 60)
}

function closeAddProvider() {
  const modal = $('#add-provider-modal')
  const body = $('#add-provider-body')
  if (modal) modal.hidden = true
  if (body) body.innerHTML = ''
}

/** 卡片上的「密钥 / 分组倍率」：把卡片里藏着的详情按 pane 取出来放进弹窗 */
/**
 * 诊断信息只读框：剪贴板不可用时的兜底，让用户自己选中复制。
 * 不走 console，避免把可能含站点信息的原文留在控制台。
 */
function showDiagnoseBox(text) {
  const old = document.getElementById('diagnose-box')
  if (old) old.remove()
  const wrap = document.createElement('div')
  wrap.id = 'diagnose-box'
  wrap.className = 'modal'
  wrap.innerHTML = `
    <div class="modal-backdrop" data-act="close-diagnose"></div>
    <div class="modal-panel" style="max-width:760px">
      <div class="modal-head">
        <b>${t('诊断信息')}</b>
        <button class="ghost" data-act="close-diagnose">${t('关闭')}</button>
      </div>
      <div class="modal-body">
        <p class="hint" style="margin:0 0 8px">${t('下面这段可以直接全选复制，发给开发者定位问题。')}</p>
        <textarea class="diagnose-text" readonly rows="15"></textarea>
      </div>
    </div>`
  wrap.querySelector('.diagnose-text').value = text
  document.body.appendChild(wrap)
  wrap.addEventListener('click', (event) => {
    if (event.target.closest('[data-act="close-diagnose"]')) wrap.remove()
  })
  const area = wrap.querySelector('.diagnose-text')
  area.focus()
  area.select()
}

function openProvPanel(button, pane) {
  const card = button.closest('.prov-card')
  const source = card?.querySelector('.prov-detail')
  const modal = $('#prov-modal')
  const body = $('#prov-modal-body')
  const title = $('#prov-modal-title')
  if (!source || !modal || !body) return
  const name = card.querySelector('.prov-id b')?.textContent?.trim() || '站点'
  const fragment = source.cloneNode(true)
  // 源节点是 hidden 的（详情现在只在弹窗里出现），克隆品要显示出来
  fragment.hidden = false
  // 克隆体脱离了站点卡的 [data-provider] 祖先；不补上的话弹窗里的
  // 添加 Key 表单、分组倍率行内编辑都会 closest 不到站点 id 而抛错
  fragment.dataset.provider = card.dataset.provider
  for (const node of fragment.querySelectorAll('[data-pane]')) {
    if (node.dataset.pane !== pane) node.remove()
  }
  // 分组倍率那一块只在读到倍率时才渲染；没有就明说怎么办，别给一个空弹窗
  if (pane === 'rates' && !fragment.querySelector('[data-pane="rates"]')) {
    fragment.innerHTML = `<div class="hint">${t('还没有读到分组倍率。点「导入倍率」从站点读一次，或在下面手动填。')}</div>`
  }
  body.innerHTML = ''
  body.appendChild(fragment)
  const paneTitle = { keys: '密钥', rates: '分组倍率', usage: '用量核对' }[pane] || '详情'
  if (title) title.textContent = `${name} · ${paneTitle}`
  modal.hidden = false
  translateDom(modal)
}

function closeProvPanel() {
  const modal = $('#prov-modal')
  const body = $('#prov-modal-body')
  if (modal) modal.hidden = true
  if (body) body.innerHTML = ''
}

// --------------------------------------------------------- 分组模型悬浮抽屉
//
// 站点卡上的分组胶囊（以及「分组倍率」里的「N 个模型」）点一下，右侧拉出一块悬浮面板，
// 回答一个只有本地台账能回答的问题：这个分组里到底有哪些模型。
//
// 站点接口只给「分组名录」+「平台级模型表」，两者并列，谁属于哪个分组它没说——
// 交叉相乘会编出不存在的组合。真正把模型绑到分组上的是「这个分组下的 Key 同步回来了哪些
// 模型」，所以数据只认后端算好的 state.modelsByGroup，前端不再自己拼一份。

/** 当前打开的抽屉：{ providerId, group }；null = 关闭 */
let groupSheet = null

function openGroupModels(providerId, group = '') {
  const sheet = $('#group-models')
  if (!sheet) return
  // 换分组就从头看：沿用上一组的滚动位置会让人以为在同一个清单里往下滑
  const switched = !groupSheet || groupSheet.providerId !== providerId || groupSheet.group !== group
  groupSheet = { providerId, group: group || '' }
  paintGroupModels()
  const body = $('#group-models-body')
  if (switched && body) body.scrollTop = 0
  sheet.hidden = false
  translateDom(sheet)
}

function closeGroupModels() {
  const sheet = $('#group-models')
  if (sheet) sheet.hidden = true
  groupSheet = null
}

/** 重画抽屉内容：自动轮询、一键同步、改倍率之后都得跟着变 */
function paintGroupModels() {
  if (!groupSheet) return
  const { providerId, group } = groupSheet
  const sheet = $('#group-models')
  const body = $('#group-models-body')
  if (!sheet || !body) return

  const provider = (state.providers || []).find((p) => p.id === providerId)
  const site = state.modelsByGroup?.[providerId]
  const models = site?.[group] || []
  const keys = (state.credentials || []).filter(
    (c) => c.providerId === providerId && (c.group || '') === group,
  )
  // 分组被删掉了（卡片垃圾桶 / 分组倍率面板 / 比价页都能删）→ 抽屉没有存在意义，直接收起
  if (!site || (!(group in site) && keys.length === 0)) {
    closeGroupModels()
    return
  }

  const siteEl = $('#group-models-site')
  const titleEl = $('#group-models-title')
  if (siteEl) siteEl.textContent = provider?.name || ''
  if (titleEl) titleEl.textContent = group || t('未指定分组')

  // 内容没变就不重写：15 秒自动轮询会重画页面，每次重建 DOM 会把用户正在选的
  // 模型名 / 滚动的滚动位置全部打回。（语言、显示币种、汇率也算进签名，
  // 它们一变价格文字就该跟着变。）
  const sig = JSON.stringify([
    getLang(),
    showUsd(),
    rateCny(),
    provider?.name || '',
    group,
    models,
    keys.map((k) => k.label),
  ])
  if (body.dataset.sig === sig) return
  body.dataset.sig = sig

  const scrollTop = body.scrollTop
  const ignoredCount = models.filter((m) => m.ignored).length
  const rows = models
    .map((m) => {
      const flags = [
        m.free ? `<span class="badge ok">${t('免费')}</span>` : '',
        m.perCall ? `<span class="badge">${t('按次')}</span>` : '',
        m.ignored ? `<span class="badge">${t('已忽略')}</span>` : '',
      ]
        .filter(Boolean)
        .join('')
      const ratio =
        m.ratio === null || m.ratio === undefined
          ? ''
          : `<span class="ratio-tone ${ratioToneClass(m.ratio)}">×${esc(m.ratio)}</span>`
      // 价格用后端算好的实际价（已乘倍率）：原价 × 倍率是计费口径，显示原价会骗人
      const price = m.perCall
        ? m.callCny === null || m.callCny === undefined
          ? '<span class="gs-unpriced">—</span>'
          : `${priceText(m.callCny)}<span class="sub">/次</span>`
        : m.inCny === null && m.outCny === null
          ? `<span class="gs-unpriced">${t('未定价')}</span>`
          : `${priceText(m.inCny)}<span class="gs-sep"> / </span>${priceText(m.outCny)}`
      return `<div class="gs-row${m.ignored ? ' is-ignored' : ''}">
        <span class="gs-name mono">${esc(m.name)}</span>
        ${ratio}${flags}
        <span class="grow"></span>
        <span class="gs-price">${price}</span>
      </div>`
    })
    .join('')

  const head = `
    <div class="gs-meta">
      <span class="hint">${t('{n} 个模型', { n: models.length })}${
        keys.length ? ` · ${t('{n} 把 Key 在这个分组', { n: keys.length })}` : ''
      }</span>
      <span class="grow"></span>
      <span class="hint">${t('价格：输入 / 输出，每百万 token')}</span>
    </div>`

  const empty = `
    <div class="empty small">
      <p>${t('这个分组还没同步过模型。')}</p>
      <p class="hint">${
        keys.length
          ? t('点站点卡的「一键同步」，会按这把 Key 的分组拉一次。')
          : t('这个分组没有挂 Key（多半是比价页「＋」复制出来的），不会有模型同步进来。')
      }</p>
    </div>`

  const foot =
    ignoredCount > 0
      ? `<p class="hint gs-foot">${t('其中 {n} 个已忽略：不参与比价、决策、探针和网关。', { n: ignoredCount })}</p>`
      : ''

  body.innerHTML = `${models.length ? head : ''}${models.length ? `<div class="gs-list">${rows}</div>` : empty}${foot}`
  body.scrollTop = scrollTop
  translateDom(body)
}

// --------------------------------------------------------------- 免费池视图

/** 两栏共用的边界说明。放在切换控件上方，一次说清。 */
function freeNoteHtml() {
  // 整段交给 t()：句子里有 <code> 会被拆成多个文本节点，
  // 逐节点匹配翻不了，只能整段翻（和基准价页那三条说明同一个做法）。
  const inner =
    '<b>免费池独立于付费比价</b><span class="desc" style="display:block;margin-top:2px">这里的供给不参与「最便宜」判断和自动选站。只有你在客户端写 <code>free/</code> 前缀，或把地址换成 <code>/free/v1</code> 时才会用到。</span>'
  return `<div class="note-card">${t(inner)}</div>`
}

function freeSegHtml(relayCount, platformCount) {
  const btn = (pane, label, count) => `
    <button type="button" data-act="free-pane" data-pane="${pane}" class="${freePane === pane ? 'active' : ''}">
      ${label}<span class="seg-count">${count}</span>
    </button>`
  return `<div class="seg">${btn('relay', '中转站免费模型', relayCount)}${btn('platform', '平台积分', platformCount)}</div>`
}

/** 中转站侧：交给 web/free-relay.js 渲染（闸门与排序在 core/rank-free.js） */
function freeRelayPane(offers) {
  return renderFreeRelayPane({
    offers,
    providers: state.providers,
    crossPane: state.freePool?.crossPane || 'remaining',
    esc,
    t,
  })
}

/** 平台侧：交给 web/free-platform.js 渲染 */
function freePlatformPane(platforms) {
  return renderFreePlatformPane({
    platforms,
    accounts: state.freePool?.accounts || [],
    esc,
    t,
    formOpen: platformFormOpen,
    presets: state.catalog?.platforms || [],
    pending: platformConnectPending,
    icon,
  })
}

/** 发起一次平台授权：拿 authUrl → 开浏览器 → 轮询结果 */
async function connectPlatform(platformId) {
  try {
    const result = await api(`POST`, `/api/free/platforms/${platformId}/connect`, {})
    const connect = result.connect
    // 有些平台没有网页授权（ZCode 走桌面协议），连接器会标 local：读本机客户端即可，
    // 这种情况下没有 authUrl 是正常的，别当成错误。
    if (!connect?.authUrl && !connect?.local) throw new Error('平台没有返回授权地址')
    state = result
    // 记下等待状态：卡片上会显示「等待授权…已 N 秒」和服务端最近一次回应
    platformConnectPending = {
      platformId,
      authUrl: connect.authUrl || '',
      local: Boolean(connect.local),
      startedAt: Date.now(),
      elapsedMs: 0,
      reason: '',
    }
    connectCancelled = false
    render()
    if (connect.authUrl) {
      window.open(connect.authUrl, '_blank', 'noopener,noreferrer')
      toast('已打开授权页，完成后会自动回来')
    } else {
      toast('正在读本机客户端里的登录态…')
    }
    await waitForConnect(platformId, connect.state, connect.accountId)
  } catch (error) {
    finishConnect(error.message, true)
  }
}

/** 轮询授权结果：服务端说 ready 之前一直等，最长 5 分钟（与连接器的超时一致） */
async function waitForConnect(platformId, authState, accountId) {
  const deadline = Date.now() + 5 * 60 * 1000
  let ticks = 0
  while (Date.now() < deadline) {
    if (connectCancelled) return finishConnect(null, false)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    if (connectCancelled) return finishConnect(null, false)

    let result
    try {
      result = await api(`POST`, `/api/free/platforms/${platformId}/connect/poll`, {
        state: authState,
        accountId,
      })
    } catch (error) {
      return finishConnect(error.message, true)
    }

    if (result.connectPoll?.ready) {
      state = result
      // 连上了但账号信息没读到：把原因带出去，别让用户以为一切完美
      return finishConnect(result.connectPoll.warning || null, false, true)
    }

    // 把服务端每次的回应显示出来：到底是「等浏览器授权」还是「正在读账号信息」
    if (platformConnectPending) {
      platformConnectPending.elapsedMs = Date.now() - platformConnectPending.startedAt
      platformConnectPending.reason = result.connectPoll?.reason || ''
      // 每 4 次（约 6 秒）重绘一次，避免每 1.5 秒重建 DOM 造成闪烁
      ticks += 1
      if (ticks % 4 === 0) render()
    }
  }
  finishConnect('授权超时，重新点一次「连接」', true)
}

/** 收尾：清掉等待状态并重绘 */
function finishConnect(message, isError, ok = false) {
  platformConnectPending = null
  connectCancelled = false
  render()
  if (ok) {
    toast('已连接')
    // 警告不是错误：连上了但昵称/额度暂时没读到，用普通提示而不是红色报错
    if (message) setTimeout(() => toast(message), 1500)
  } else if (message) {
    toast(message, isError)
  }
}

// ------------------------------------------------------- 免费池 · 平台账号

let pfAccountsPlatformId = null

const PF_STATUS_TEXT = { ok: '正常', expired: '已过期', error: '异常' }

function quotaSummary(quota) {
  if (!quota) return '—'
  const parts = []
  // 本周期剩余才是现在能用的量，包内剩余只作补充，别把两个数并排摆着让人挑
  const cycle = Number(quota.cycleRemaining)
  const size = Number(quota.cycleSize)
  if (Number.isFinite(cycle)) {
    parts.push(Number.isFinite(size) && size > 0 ? `本周期 ${cycle}/${size}` : `本周期 ${cycle}`)
  } else if (Number.isFinite(Number(quota.remaining))) {
    parts.push(`剩 ${quota.remaining}`)
  }
  if (Number.isFinite(cycle) && Number.isFinite(Number(quota.remaining)) && quota.remaining !== cycle) {
    parts.push(`套餐 ${quota.remaining}`)
  }
  if (quota.resetAt) parts.push(`重置 ${String(quota.resetAt).slice(0, 10)}`)
  return parts.join(' · ') || '—'
}

function openPfAccounts(platformId) {
  pfAccountsPlatformId = platformId
  const modal = $('#pf-accounts-modal')
  if (modal) modal.hidden = false
  renderPfAccounts()
}

function closePfAccounts() {
  const modal = $('#pf-accounts-modal')
  if (modal) modal.hidden = true
  pfAccountsPlatformId = null
}

function renderPfAccounts() {
  const body = $('#pf-accounts-body')
  if (!body) return
  const platform = (state?.freePool?.platforms || []).find((p) => p.id === pfAccountsPlatformId)
  if (!platform) {
    body.innerHTML = '<p class="hint">平台已经删掉了。</p>'
    return
  }
  const accounts = platform.accounts || []
  const head = `<p class="hint" style="margin:0 0 10px">${esc(platform.label || platform.connectorId)} · ${accounts.length} 个账号</p>`
  if (!accounts.length) {
    body.innerHTML = `${head}<p class="hint">还没有账号。点「连接」授权成功后会自己建一个。</p>`
    translateDom(body)
    return
  }
  body.innerHTML = `
    ${head}
    <table class="table">
      <thead>
        <tr><th>账号</th><th>状态</th><th>额度</th><th>最近签到</th><th></th></tr>
      </thead>
      <tbody>
        ${accounts
          .map(
            (account) => `
          <tr>
            <td>${esc(account.label || '—')}${account.hasSecret ? '' : ' <span class="badge warn">无凭据</span>'}</td>
            <td>${esc(t(PF_STATUS_TEXT[account.status] || account.status || '—'))}</td>
            <td>${esc(quotaSummary(account.quota))}</td>
            <td>${esc(account.lastCheckinAt ? String(account.lastCheckinAt).slice(0, 10) : '—')}</td>
            <td class="num"><button class="ghost danger" data-act="pf-account-delete" data-account="${esc(account.id)}">删除</button></td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>`
  translateDom(body)
}

function renderFree() {
  const view = $('#view-free')
  if (!view) return
  const pool = state.freePool || {}
  const relay = pool.relay || []
  const platforms = pool.platforms || []

  // 分段控件永远显示：它是这一页的导航，藏起来会让用户以为「没有免费模型就没有平台栏」。
  // 每栏各自处理空态，各给各的下一步动作。
  view.innerHTML = `
    ${freeNoteHtml()}
    ${freeSegHtml(relay.length, platforms.length)}
    <div style="margin-top:16px">
      ${freePane === 'relay' ? freeRelayPane(relay) : freePlatformPane(platforms)}
    </div>`
}

// --------------------------------------------------------------- 比价视图

function renderPricing() {
  const view = $('#view-pricing')

  // 未定价的供给：不管有没有已定价的，都要给出来填——否则新用户进来是一片空白
  const unpricedBlock = state.unpriced.length === 0 ? '' : `
    <h3 class="section-title">还没定价的供给（${state.unpriced.length}）</h3>
    <p class="hint">填「倍率」最省事：实际价 = 基准价 × 倍率。不知道倍率就直接填输入/输出单价。站上真的白送就点「标为免费」。</p>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>站点</th><th>上游模型名</th><th class="num">基准价</th>
          <th class="num">输入价</th><th class="num">输出价</th><th class="num">倍率</th><th>单位 / 币种</th><th></th>
        </tr></thead>
        <tbody>
          ${state.unpriced.map((offer) => {
            const bench = state.benchmarks[offer.modelKey] || state.benchmarks[offer.upstreamName]
            const hasBench = bench && (bench.in !== null || bench.out !== null)
            const benchText = hasBench
              ? `${bench.currency === 'CNY' ? '¥' : '$'}${bench.in ?? '—'}/${bench.out ?? '—'}`
              : '<span style="color:var(--faint)">无基准</span>'
            return `
            <tr data-offer="${esc(offer.id)}">
              <td>${esc(providerName(offer.providerId))}</td>
              <td class="mono">${esc(offer.upstreamName)}${offer.group ? ` <span class="badge ${groupChipOf(offer.providerId, offer.group)}">${esc(offer.group)}</span>` : ''}</td>
              <td class="num" style="color:var(--faint)">${benchText}</td>
              <td class="num"><input type="number" step="0.001" placeholder="—" value="${offer.inPrice ?? ''}" data-field="inPrice" ${offer.priceUnit === 'per_call' ? 'title="按次计费：这里填每次请求的价格"' : ''} /></td>
              <td class="num"><input type="number" step="0.001" placeholder="—" value="${offer.priceUnit === 'per_call' ? '' : offer.outPrice ?? ''}" data-field="outPrice" ${offer.priceUnit === 'per_call' ? 'disabled title="按次计费不区分输入/输出"' : ''} /></td>
              <td class="num"><input class="ratio" type="number" step="0.01" placeholder="倍率" value="${offer.ratio ?? ''}" data-field="ratio" /></td>
              <td>
                <select data-field="priceUnit" style="width:64px" title="计价单位：按次 = 输入价填每次请求的价格">
                  <option value="per_mtok" ${offer.priceUnit !== 'per_1k' && offer.priceUnit !== 'per_call' ? 'selected' : ''}>/M</option>
                  <option value="per_1k" ${offer.priceUnit === 'per_1k' ? 'selected' : ''}>/1k</option>
                  <option value="per_call" ${offer.priceUnit === 'per_call' ? 'selected' : ''}>/次</option>
                </select>
                <select data-field="currency" style="width:64px">
                  <option value="USD" ${offer.currency === 'USD' ? 'selected' : ''}>USD</option>
                  <option value="CNY" ${offer.currency === 'CNY' ? 'selected' : ''}>CNY</option>
                </select>
              </td>
              <td><button class="ghost tiny" data-act="mark-free" data-offer="${esc(offer.id)}" title="把输入/输出价都设为 0，这条就进免费池（不进比价和自动选站）">标为免费</button></td>
            </tr>`
          }).join('')}
        </tbody>
      </table>
    </div>`

  if (state.ranked.length === 0) {
    view.innerHTML = `
      <div class="empty" style="margin-bottom:18px">
        <h3>${state.unpriced.length ? '模型已同步，但还没定价' : '还没有模型'}</h3>
        <p>${state.unpriced.length
          ? '在下面的表格里给每个模型填一个倍率（或直接填单价），就能开始比价。'
          : '先去「站点」同步模型列表。'}</p>
        <button class="primary" data-goto="${state.unpriced.length ? 'benchmark' : 'providers'}">
          ${state.unpriced.length ? '先去载入基准价' : '去站点页'}
        </button>
      </div>
      ${unpricedBlock}`
    return
  }

  const filterText = filters.pricing.trim().toLowerCase()
  const visibleGroups = state.ranked.filter(
    (group) => !filterText || group.modelKey.toLowerCase().includes(filterText),
  )
  const ignoredCount = (state.settings?.ignoredModels || []).length

  const groups = visibleGroups.map((group) => {
    const panelKey = `pricing:${group.modelKey}`
    const isCollapsed = collapsedPanels.has(panelKey)
    const rows = group.rows.map((row) => {
      const score = state.scores[row.offerId]
      const maxTtft = Number(state.settings.maxTtftMs) || 0
      const tooSlow =
        maxTtft > 0 && typeof score?.ttftMs === 'number' && score.ttftMs > maxTtft
      const badge = tooSlow
        ? ' <span class="badge danger">慢速</span>'
        : score?.probeTrusted === false
          ? ' <span class="badge warn">可疑</span>'
          : ''
      const cacheCell =
        row.cacheHitRate === null || row.cacheHitRate === undefined
          ? '—'
          : `${Math.round(row.cacheHitRate * 100)}%`
      // 模式只看 offer.pricingMode，不能拿 row.ratio 推断：
      // 切成「倍率」但还没填倍率时 ratio 是 null，会被误判成手动
      const mode = row.pricingMode === 'ratio' ? 'ratio' : 'manual'
      const perCall = Boolean(row.perCall)
      // 综合成本列：按次行显示「/次」，按 token 行显示「/百万 token」
      const costCell = perCall
        ? row.callPriceCny === null
          ? '—'
          : `<div>¥${money(row.callPriceCny)}<span class="sub">/次</span></div>`
        : `${row.blendedCnyPerMtok === null ? '—' : priceText(row.blendedCnyPerMtok)}${
            row.hasOffPeak && row.offPeakBlendedCnyPerMtok !== null ? `<div class="sub">空闲 ${priceText(row.offPeakBlendedCnyPerMtok)}</div>` : ''
          }`
      // 计费单位是站点声明、识别出来的（模型广场 billing_mode），不是每行手选的
      // 配置项——所以只读展示。真要手动改（比如站点没开广场识别不到），去「站点」页
      const unitBadge = `<span class="badge unit-badge" title="${t('计费单位：由站点声明的计费形式识别而来；手动修改请到「站点」页的模型行')}">${
        perCall ? t('/次') : row.priceUnit === 'per_1k' ? t('/1k') : t('/M')
      }</span>`
      const modeCell = `
        <div class="seg-mini">
          <button class="${mode === 'ratio' ? 'is-on' : ''}" data-act="offer-mode" data-mode="ratio" title="按分组倍率折算">倍率</button>
          <button class="${mode === 'manual' ? 'is-on' : ''}" data-act="offer-mode" data-mode="manual" title="直接填单价">价格</button>
        </div>`
      return `
      <tr class="${row.isCheapest ? 'cheapest' : ''}" data-offer="${esc(row.offerId)}">
        <td>${esc(providerName(row.providerId))}</td>
        <td class="mono">${esc(row.upstreamName)}${badge}${perCall ? ' <span class="badge">按次</span>' : ''}</td>
        <td class="num sub-cell">${cacheCell}</td>
        <td><span class="group-chip-cell">${row.group ? `<span class="badge ${groupChipOf(row.providerId, row.group)}" title="${esc(row.group)}">${esc(row.group)}</span>` : `<span style="color:var(--faint)" title="${t('该行的 Key 没有分组')}">${t('默认')}</span>`}<button class="ghost tiny" data-act="dup-offer" title="同一个模型在另一档套餐里也有时，复制一条单独跟踪（分组归属跟随 Key，行内不可直接改）。不想要了可以在「站点」页删掉这个分组">＋</button>${row.group ? `<button class="ghost danger tiny" data-act="del-group" data-provider="${esc(row.providerId)}" data-group="${esc(row.group)}" title="删掉这个分组（Key 保留，之后在 Key 那行点「选分组」可以重新导入）">${icon('trash')}</button>` : ''}</span></td>
        <td>${modeCell}</td>
        <td class="num"><input type="number" step="0.001" placeholder="—" value="${row.inPrice ?? ''}" data-field="inPrice" ${perCall ? 'title="按次计费：这里填每次请求的价格"' : mode === 'ratio' ? 'title="原价。实际价 = 这个值 × 倍率"' : ''} /></td>
        <td class="num"><input type="number" step="0.001" placeholder="—" value="${perCall ? '' : row.outPrice ?? ''}" data-field="outPrice" ${perCall ? 'disabled title="按次计费不区分输入/输出"' : mode === 'ratio' ? 'title="原价。实际价 = 这个值 × 倍率"' : ''} /></td>
        <td>
          <div class="unit-cell">
            <select data-field="currency" style="width:70px">
              <option value="USD" ${row.currency === 'USD' ? 'selected' : ''}>USD</option>
              <option value="CNY" ${row.currency === 'CNY' ? 'selected' : ''}>CNY</option>
            </select>
            ${unitBadge}
          </div>
        </td>
        <td class="num"><input class="ratio" type="number" step="0.01" placeholder="倍率" value="${row.ratio ?? ''}" data-field="ratio" ${mode === 'manual' ? 'disabled title="当前按手填单价算，切到「倍率」才能填"' : ''} /></td>
        <td class="num">${row.ttftMs ? `${row.ttftMs}ms` : '—'}</td>
        <td class="num">${costCell}</td>
        <td class="num">${row.isCheapest ? '<span class="badge ok">最便宜</span>' : row.deltaPct === null ? '—' : `+${row.deltaPct}%`}</td>
      </tr>`
    }).join('')

    return `
      <div class="table-wrap">
        <div class="group-head">
          <button class="ghost tiny" data-act="toggle-panel" data-panel="${esc(panelKey)}">${isCollapsed ? '▸' : '▾'}</button>
          <span class="model mono">${esc(group.modelKey)}</span>
          ${group.spreadPct === null ? '' : `<span class="spread">价差 ${group.spreadPct}%</span>`}
          <span class="count">${group.providerCount} 个站 · ${group.rows.length} 条供给</span>
        </div>
        ${isCollapsed ? '' : `
        <table class="pricing-table">
          <thead><tr>
            <th>站点</th><th>上游模型名</th><th class="num">缓存</th><th>分组</th>
            <th>模式</th>
            <th class="num">输入价</th><th class="num">输出价</th>
            <th>币种 / 单位</th><th class="num">倍率</th>
            <th class="num">首字</th><th class="num">${t('综合成本')}<div class="sub">${t('{sym}/M · 按次行 /次', { sym: priceSym() })}</div></th><th class="num">价差</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`}
      </div>`
  }).join('')

  view.innerHTML = `
    <div class="toolbar">
      <input id="pricing-search" class="search" type="search" placeholder="搜索模型名…" value="${esc(filters.pricing)}" />
      <span class="hint" style="margin:0">${visibleGroups.length} / ${state.ranked.length} 个模型</span>
      <span class="grow"></span>
      <button class="with-icon" data-act="ignored-models" title="${t('忽略后不再参与比价、智能决策、探针和网关')}">
        ${icon('eye-off')}${t('忽略模型')}${ignoredCount ? ` ${ignoredCount}` : ''}
      </button>
    </div>
    <p class="hint">${t('价格直接改，失焦即保存。「{sym}/百万 token」是综合成本：输入按 25%、输出按 75% 加权。人民币标价的站按「基准价」页里的汇率折算成美元比较。', { sym: priceSym() })}</p>
    <p class="hint">${t('倍率模式下，输入 / 输出价填的是「原价」：实际价 = 原价 × 倍率。基准价只是导入时自动填进这两个框的默认值，手改过就以手改的为准。')}</p>
    ${ignoredCount ? `<p class="hint">已忽略 ${ignoredCount} 个模型：它们不出现在比价、智能决策、探针和网关里。<button class="ghost tiny" data-act="ignored-models">管理</button></p>` : ''}
    ${groups}${unpricedBlock}`
}


// --------------------------------------------------------------- 刷新

function paintAutoRefresh() {
  const btn = $('#autorefresh-btn')
  if (!btn) return
  btn.classList.toggle('is-off', !autoRefresh)
  const dot = $('#autorefresh-dot')
  if (dot) dot.style.background = autoRefresh ? 'var(--success)' : 'var(--faint)'
}

/** 顶栏币种开关：只影响显示，比较口径永远是美元 */
function paintCurrencySwitch() {
  const box = $('#cur-switch')
  if (!box) return
  const cur = showUsd() ? 'USD' : 'CNY'
  for (const button of box.querySelectorAll('button')) {
    const on = button.dataset.cur === cur
    button.classList.toggle('is-on', on)
    button.setAttribute('aria-pressed', on ? 'true' : 'false')
  }
}

/**
 * 重新拉一次 state 并重绘。
 * - 正在输入（焦点在表单元素里）时跳过，避免打断填写
 * - 比价/决策页用完整 state，其它页用 ?light=1（服务端只裁掉 decisions 这一大块；
 *   scores 保留——概览/探针/网关页和通知中心都靠它，停在这些页时评分才会跟着轮询更新）
 * - 重绘后恢复滚动位置
 */
async function refreshState({ silent = false } = {}) {
  const focused = document.activeElement
  if (focused && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)) return
  const scroller = $('.content')
  const scrollTop = scroller ? scroller.scrollTop : 0
  const light = !HEAVY_TABS.has(activeTab)
  try {
    const next = await api('GET', `/api/state${light ? '?light=1' : ''}`)
    state = light && state ? { ...state, ...next } : next
    // 用量页默认 30 天与 state.usage 同口径：清掉旧快照轮询才能生效
    // （此前点过范围按钮后快照永不清空，用量页一直渲染旧数据）
    if (usageRange === 30) usageData = null
    render()
    if (scroller) scroller.scrollTop = scrollTop
  } catch (error) {
    if (!silent) toast(String(error), true)
  }
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
  if (!autoRefresh) return
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return
    void refreshState({ silent: true })
  }, AUTOREFRESH_MS)
}

function setAutoRefresh(next) {
  autoRefresh = Boolean(next)
  localStorage.setItem(AUTOREFRESH_KEY, autoRefresh ? '1' : '0')
  paintAutoRefresh()
  scheduleRefresh()
}

document.addEventListener('visibilitychange', () => {
  // 回到前台立刻补一次，别让人盯着切走前的旧数据
  if (document.visibilityState === 'visible' && autoRefresh) void refreshState({ silent: true })
})

// --------------------------------------------------------------- 忽略模型

let ignoredQuery = ''
// 分组名 → 该组下的模型名（渲染时登记，供「整组勾选」用）
let igGroupNames = new Map()
// 折叠起来的厂牌（记住，重开弹窗仍是折叠的）
const igCollapsed = new Set()

// 厂牌前缀表与 vendorOf / vendorLabel 移到了 free-relay.js（胶囊配色与这里共用一份）

/** 当前所有出现过的模型名 + 覆盖站点数（含已被忽略的，来自后端 modelIndex） */
function knownModels() {
  const counts = new Map()
  for (const row of state.modelIndex || []) counts.set(row.name, row.sites)
  for (const offer of state.unpriced || []) {
    const key = String(offer.modelKey || offer.upstreamName || '').trim()
    if (key && !counts.has(key)) counts.set(key, 1)
  }
  for (const key of state.settings?.ignoredModels || []) if (!counts.has(key)) counts.set(key, 0)
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}

/** 按厂牌分组，组内按名字排；组按「未忽略数量多的在前」排，方便先处理没管过的 */
function groupModels(rows) {
  const ignored = new Set(state.settings?.ignoredModels || [])
  const groups = new Map()
  for (const [name, sites] of rows) {
    const key = vendorOf(name)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push([name, sites])
  }
  return [...groups.entries()]
    .map(([key, items]) => ({
      key,
      label: vendorLabel(key),
      items,
      ignoredCount: items.filter(([name]) => ignored.has(name)).length,
    }))
    .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label))
}

/** 组头和组内勾选状态对齐（全选 / 半选 / 未选） */
function syncIgGroups() {
  for (const [key, names] of igGroupNames) {
    const head = document.querySelector(`[data-ig-group="${CSS.escape(key)}"]`)
    if (!head) continue
    const boxes = names
      .map((name) => document.querySelector(`[data-ig="${CSS.escape(name)}"]`))
      .filter(Boolean)
    if (boxes.length === 0) continue
    const checked = boxes.filter((box) => box.checked).length
    head.checked = checked === boxes.length
    head.indeterminate = checked > 0 && checked < boxes.length
  }
}

function openIgnoredModels() {
  const modal = $('#prov-modal')
  const title = $('#prov-modal-title')
  const body = $('#prov-modal-body')
  if (!modal || !body) return
  const ignored = new Set(state.settings?.ignoredModels || [])
  const rows = knownModels()
  const q = ignoredQuery.trim().toLowerCase()
  const shown = rows.filter(([name]) => !q || name.toLowerCase().includes(q))
  const groups = groupModels(shown)
  igGroupNames = new Map(groups.map((g) => [g.key, g.items.map(([name]) => name)]))
  title.textContent = t('忽略模型')
  body.innerHTML = `
    <p class="hint" style="margin:0 0 10px">
      ${t('勾上的模型不再参与比价、智能决策、探针和网关；点厂牌可整组勾选，随时取消。')}
    </p>
    <div class="toolbar" style="margin-bottom:8px">
      <input id="ig-search" class="search" type="search" placeholder="${t('搜索模型名…')}" value="${esc(ignoredQuery)}" />
      <span class="hint" style="margin:0">${t('{n} / {total} 个模型', { n: shown.length, total: rows.length })}</span>
    </div>
    <div class="ig-list">
      ${shown.length
        ? groups
            .map((group) => {
              const folded = igCollapsed.has(group.key)
              return `
        <div class="ig-group">
          <div class="ig-row ig-group-head">
            <button class="ig-caret${folded ? ' is-collapsed' : ''}" type="button" data-ig-fold="${esc(group.key)}" title="${t('收起 / 展开')}">${icon('chevron-down')}</button>
            <input type="checkbox" data-ig-group="${esc(group.key)}" ${group.ignoredCount === group.items.length ? 'checked' : ''} />
            <span class="ig-vendor">${esc(group.label)}</span>
            <span class="hint">${t('{n} 个模型', { n: group.items.length })}${
              group.ignoredCount ? ` · ${t('已忽略 {n}', { n: group.ignoredCount })}` : ''
            }</span>
          </div>
          <div class="ig-children" data-ig-children="${esc(group.key)}" ${folded ? 'hidden' : ''}>
          ${group.items
            .map(
              ([name, count]) => `
            <label class="ig-row ig-child">
              <input type="checkbox" data-ig="${esc(name)}" ${ignored.has(name) ? 'checked' : ''} />
              <span class="mono">${esc(name)}</span>
              <span class="hint">${count ? t('{n} 个站', { n: count }) : t('已不在榜单里')}</span>
            </label>`,
            )
            .join('')}
          </div>
        </div>`
            })
            .join('')
        : `<p class="hint">${t('没有匹配的模型。')}</p>`}
    </div>`
  modal.hidden = false
  syncIgGroups()
}

/** 把当前所有勾选状态一次性提交（整组勾选也走这里） */
async function saveIgnoredFromModal() {
  const names = [...document.querySelectorAll('[data-ig]')]
    .filter((box) => box.checked)
    .map((box) => box.dataset.ig)
  try {
    state = await api('PATCH', '/api/settings', { ignoredModels: names })
    render()
    syncIgGroups()
  } catch (error) {
    toast(String(error), true)
  }
}

async function toggleIgnoredModel(name, checked) {
  const current = new Set(state.settings?.ignoredModels || [])
  if (checked) current.add(name)
  else current.delete(name)
  try {
    state = await api('PATCH', '/api/settings', { ignoredModels: [...current] })
    render()
    // 不重画弹窗：勾选状态是浏览器自己维护的，重画会把列表滚回顶部
    syncIgGroups()
    toast(checked ? t('已忽略 {name}', { name }) : t('已恢复 {name}', { name }))
  } catch (error) {
    toast(String(error), true)
  }
}

async function toggleVendorGroup(key, checked) {
  const names = igGroupNames.get(key) || []
  const boxes = names
    .map((name) => document.querySelector(`[data-ig="${CSS.escape(name)}"]`))
    .filter(Boolean)
  for (const box of boxes) box.checked = checked
  await saveIgnoredFromModal()
  toast(checked ? t('已忽略「{name}」全部模型', { name: vendorLabel(key) }) : t('已恢复「{name}」全部模型', { name: vendorLabel(key) }))
}

// --------------------------------------------------------------- 决策视图

// 冷却原因：额度不足 / 限流 / 模型不在分组——不是站坏了，别让人以为评分出错
const BLOCKED_LABEL = {
  quota: '额度不足',
  budget: '单次预算超限',
  'rate-limit': '限流中',
  'model-missing': '模型不可用',
}
function blockedLabel(blocked) {
  const label = BLOCKED_LABEL[blocked?.kind] || '暂时不可用'
  return `${t(label)} · ${t('冷却中')}`
}

function decisionState(candidate) {
  const admission = candidate.admission || { ok: true }
  // 「放行可疑供给」开着时，探针说可疑的也会准入：标出来，别让人误以为是健康的
  const passed = admission.ok && candidate.probeOk === false
  const tag = (label, cls) => ({
    label: passed ? `${label} · ${t('已放行')}` : label,
    cls: passed ? 'warn' : cls,
  })

  // 准入不过：真的不登场，网关会直接报错。红标 + 理由，别写得像「只是慢了点」
  if (!admission.ok) {
    if (admission.kind === 'slow') return { label: t('慢速'), cls: 'danger' }
    if (admission.kind === 'unstable') return { label: t('不稳定'), cls: 'danger' }
    if (admission.kind === 'degraded') return { label: t('结果可疑'), cls: 'warn' }
    return { label: t('不会登场'), cls: 'warn' }
  }

  if (candidate.blocked) return tag(blockedLabel(candidate.blocked), 'warn')
  // 过期 / 未探测：能登场，但只在没有更好的供给时才派活——真实调用本身就是证据，
  // 不拦它，下一轮评分就自愈了
  if (candidate.status === 'stale' || candidate.status === 'unknown') return tag(t('兜底'), '')
  if (candidate.status === 'inconclusive') return tag(t('证据不足'), '')
  return tag(t('可用'), 'ok')
}

function renderDecision() {
  const view = $('#view-decision')
  const decisions = state.decisions || []

  if (state.providers.length === 0) {
    view.innerHTML = `
      <div class="empty">
        <h3>还没有站点</h3>
        <p>先添加站点并同步模型，这里会显示路由怎么选。</p>
        <button class="primary" data-act="add-provider">${icon('plus')}新增站点</button>
      </div>`
    return
  }

  if (decisions.length === 0) {
    view.innerHTML = `
      <div class="empty"><h3>还没有可决策的模型</h3><p>先在比价页给模型填上价格。</p></div>`
    return
  }

  const filterText = filters.decision.trim().toLowerCase()
  const visibleDecisions = decisions.filter(
    (decision) => !filterText || decision.modelKey.toLowerCase().includes(filterText),
  )

  const blocks = visibleDecisions.map((decision) => {
    const panelKey = `decision:${decision.modelKey}`
    const isCollapsed = collapsedPanels.has(panelKey)
    const rows = decision.candidates.map((candidate, index) => {
      const badge = decisionState(candidate)
      const isChosen = candidate.offerId === decision.chosenOfferId
      const arrows = candidate.routable
        ? `<button class="ghost tiny" data-act="move-up" title="上移">↑</button><button class="ghost tiny" data-act="move-down" title="下移">↓</button>`
        : ''
      return `
        <tr class="${isChosen ? 'cheapest' : ''}" data-offer="${esc(candidate.offerId)}">
          <td style="white-space:nowrap">${arrows}</td>
          <td class="num" style="color:var(--faint)">${index + 1}</td>
          <td>${esc(candidate.providerName || '—')}${isChosen ? ' <span class="badge ok">当前</span>' : ''}${
            candidate.upstreamName && candidate.upstreamName !== decision.modelKey
              ? `<div class="sub mono">${esc(candidate.upstreamName)}</div>`
              : ''
          }</td>
          <td>${candidate.group ? `<span class="badge ${groupChipOf(candidate.providerId, candidate.group)}">${esc(candidate.group)}</span>` : '<span style="color:var(--faint)">默认</span>'}</td>
          <td class="num">${candidate.price === null ? '—' : priceText(candidate.price)}</td>
          <td class="num">${candidate.quality === null ? '—' : candidate.quality.toFixed(2)}${
            candidate.confidence && candidate.confidence !== 'high'
              ? `<div class="sub">${candidate.samples} ${t('样本')}</div>`
              : ''
          }</td>
          <td class="num">${candidate.effective === null ? '—' : priceText(candidate.effective)}</td>
          <td class="num">${candidate.ttftMs === null ? '—' : `${candidate.ttftMs}ms`}</td>
          <td><span class="badge ${badge.cls}">${badge.label}</span>${candidate.statusReason ? `<div class="sub">${esc(candidate.statusReason)}</div>` : ''}</td>
        </tr>`
    }).join('')

    return `
      <div class="table-wrap" data-model="${esc(decision.modelKey)}">
        <div class="group-head">
          <button class="ghost tiny" data-act="toggle-panel" data-panel="${esc(panelKey)}">${isCollapsed ? '▸' : '▾'}</button>
          <span class="model mono">${esc(decision.modelKey)}</span>
          <span class="spread">${decision.chosenProviderName ? `当前选 ${esc(decision.chosenProviderName)}` : '没有可用供给'}</span>
          ${decision.manual ? '<button class="ghost tiny" data-act="reset-order">恢复自动</button>' : ''}
        </div>
        ${isCollapsed ? '' : `
        <table>
          <thead><tr>
            <th style="width:66px"></th><th class="num">#</th><th>站点</th><th>分组</th>
            <th class="num">价格</th><th class="num">质量</th>
            <th class="num">有效成本</th><th class="num">首字</th><th>状态</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`}
      </div>`
  }).join('')

  view.innerHTML = `
    ${gateCard()}
    <div class="toolbar">
      <input id="decision-search" class="search" type="search" placeholder="搜索模型名…" value="${esc(filters.decision)}" />
      <span class="hint" style="margin:0">${visibleDecisions.length} / ${decisions.length} 个模型</span>
    </div>
    <p class="hint">默认按「有效成本 = 价格 ÷ 质量」排序，用 ↑↓ 手动调整「可用」那几条的先后——不会登场的站不会因为你拖它而排到前面。</p>
    <p class="hint">${t('注意：<b>同一个模型在不同站的状态是各自独立的</b>（A 站健康、B 站掉包很正常），所以这里按「站 × 模型」逐条评估，状态下方会写明具体原因。')}</p>
    ${blocks}`
}

/**
 * 慢速档位限制：这一页唯一的准入开关。
 *
 * 放这里的理由：智能决策就是「最后哪些模型能登场」的界面，门槛、候选、状态、
 * 排序应该在同一屏里，用户才能立刻看到「调高门槛之后还剩谁」。
 * 探针页只管取证（探什么、多久探一次），不碰准入。
 */
function gateCard() {
  const maxTtft = Number(state.settings.maxTtftMs) || 0
  const tiers = state.ttftTiers || []
  return `
    <div class="card">
      <div class="ttft-scale">
        <div class="ttft-scale-label">${t('慢速档位限制')}</div>
        <div class="ttft-scale-row">
        <span class="ttft-ticks">
          <button class="ttft-tick off${maxTtft === 0 ? ' active' : ''}" data-act="set-ttft" data-ms="0" title="不限：不按首字筛掉任何供给">不限</button>
          ${tiers
            .map(
              (tier) =>
                `<button class="ttft-tick lv-${tier.levelCls}${tier.ms === maxTtft ? ' active' : ''}" data-act="set-ttft" data-ms="${tier.ms}" title="第 ${tier.tier} 档 · ${tier.seconds}s · ${tier.level}"></button>`,
            )
            .join('')}
        </span>
        <label class="field-inline ttft-field">
          <input id="max-ttft" type="number" min="0" max="20000" step="100" inputmode="numeric"
            value="${maxTtft || ''}" placeholder="不限" style="width:74px"
            title="填 0 或留空 = 不限；按 500 为界就近取档，最大 20000ms" /> ms
        </label>
        <span class="ttft-scale-now">当前 ${esc(state.ttftLimitText || '不限')}</span>
        <span class="hint" style="margin:0">1000–20000ms 共 20 档 · 慢速即为不可用</span>
        </div>
      </div>
    </div>`
}

// --------------------------------------------------------------- 探针视图

const PROBE_STATUS = {
  healthy: { label: '健康', cls: 'ok' },
  degraded: { label: '结果可疑', cls: 'warn' },
  unstable: { label: '不稳定', cls: 'danger' },
  // 样本不足的失败：不参与路由，但不算「确定坏了」——不该催用户去修
  inconclusive: { label: '证据不足', cls: '' },
  stale: { label: '评分过期', cls: 'warn' },
  unknown: { label: '未探测', cls: '' },
}

// 置信度：同样的「健康」，1 个样本和 10 个样本的确定性差很多
const CONFIDENCE_LABEL = { high: '置信度高', medium: '置信度中', low: '置信度低（样本少）' }
function confidenceLabel(level) {
  return t(CONFIDENCE_LABEL[level] || '置信度低（样本少）')
}

function pct(value) {
  if (value === null || value === undefined) return '—'
  return `${Math.round(value * 100)}%`
}

function relTime(iso) {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

/** 展开行：把「质量怎么算的」和「为什么判它可疑」摊开给人看。 */
function probeDetailHtml(score) {
  if (!score || score.samples === 0) {
    return '<div class="detail-grid"><div class="detail-line dim">还没探测过，点右侧「探测」跑一次。</div></div>'
  }
  const p = score.lastProbe || {}
  const fmt = (v) => (v === null || v === undefined ? '—' : v.toFixed(2))
  const pctv = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`)

  const reasons = []
  if (p.fingerprintOk === false) reasons.push('指纹不符：要求精确输出固定内容，返回的不是——模型可能被掉包')
  if (p.truncated === true) reasons.push('输出被截断：要求数到 120 没数完，上游压低了 max_tokens')
  if (p.billingInflated === true) reasons.push('用量虚报：返回的 prompt_tokens 远超实际请求规模')
  if (score.availability !== null && score.availability < 0.8) reasons.push(`可用率过低（${pctv(score.availability)}）`)
  if (score.stale) reasons.push('评分已过期：超过有效期没重新探测')

  return `
    <div class="detail-grid">
      <div>
        <div class="detail-title">质量怎么算出来的</div>
        <div class="detail-line">可用率 <b>${pctv(score.availability)}</b>
          <span class="dim">= 探针 ${score.samples} 次 + 真实流量 ${score.trafficSamples} 次的成功率</span></div>
        <div class="detail-line">完整性 <b>${fmt(score.integrity)}</b>
          <span class="dim">= 指纹 ${pctv(score.fingerprintRate)}×0.5 + 未截断 ${pctv(score.truncationRate)}×0.3 + 计费正常 ${pctv(score.billingRate)}×0.2</span></div>
        <div class="detail-line dim">通过率按 (通过+1)/(样本+1) 平滑：样本少时一次异常只轻微降权，判「结果可疑」另有更严的原始证据规则</div>
        ${score.realQualitySamples
          ? `<div class="detail-line">真实响应抽样 <b>${score.realQualitySamples}</b> 次
              <span class="dim">异常 ${score.realBadRate === null ? '样本不足，暂不判定' : `${pctv(score.realBadRate)}（空回答 / 计费虚报）`}</span></div>`
          : ''}
        <div class="detail-line">质量 <b>${fmt(score.quality)}</b>
          <span class="dim">= 可用率 × 完整性，低于 0.8 就不参与路由</span></div>
        <div class="detail-line">证据 <b>${(score.samples || 0) + (score.trafficSamples || 0)}</b> 个样本
          <span class="dim">（探针 ${score.samples || 0} + 真实调用 ${score.trafficSamples || 0}）·
          最近一次 ${relTime(score.evidenceAt)} · 置信度 ${confidenceLabel(score.confidence)}</span></div>
      </div>
      <div>
        <div class="detail-title">最近一次探测的证据</div>
        ${reasons.length
          ? reasons.map((r) => `<div class="detail-line danger">· ${esc(r)}</div>`).join('')
          : '<div class="detail-line dim">各项正常</div>'}
        ${p.fingerprintRaw ? `<div class="detail-line mono dim">实际返回：${esc(p.fingerprintRaw)}</div>` : ''}
        ${p.truncationDetail ? `<div class="detail-line mono dim">${esc(p.truncationDetail)}</div>` : ''}
        ${p.cacheDetail ? `<div class="detail-line mono dim">缓存：${esc(p.cacheDetail)}</div>` : ''}
        ${p.identityClaim ? `<div class="detail-line dim">模型自述：<b>${esc(p.identityClaim)}</b>（仅供参考——模型经常认错自己，不能当作掉包证据）</div>` : ''}
        ${p.error ? `<div class="detail-line danger">错误：${esc(p.error)}</div>` : ''}
      </div>
    </div>`
}

function renderProbes() {
  const view = $('#view-probes')
  const providersWithOffers = state.providers.filter((p) => state.offers.some((o) => o.providerId === p.id))

  if (providersWithOffers.length === 0) {
    view.innerHTML = `
      <div class="empty">
        <h3>还没有可探测的模型</h3>
        <p>先在「站点」里同步模型列表，并加一个 Key。</p>
      </div>`
    return
  }

  const interval = Number(state.settings.probeIntervalMinutes) || 0
  const maxAge = Number(state.settings.scoreMaxAgeHours) || 6
  const allowUntrusted = Boolean(state.settings.allowUntrusted)
  const intervalOptions = [
    [0, '关闭'],
    [30, '30 分钟'],
    [60, '1 小时'],
    [180, '3 小时'],
    [360, '6 小时'],
  ]

  const intro = `
    <div class="card">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div style="flex:1;min-width:240px">
          <div style="font-weight:500">主动探测</div>
          <div class="hint" style="margin:4px 0 0">
            每个模型发 5 个请求：指纹 + 计费、截断、缓存（连发两次）、身份自述。结果进入评分，路由据此排除可疑的站。
          </div>
        </div>
        <button class="primary" data-act="probe-all">探测全部（最多 5 个）</button>
      </div>
      <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:1px dashed var(--border)">
        <label class="field-inline">自动探测
          <select id="probe-interval">
            ${intervalOptions.map(([v, label]) => `<option value="${v}" ${v === interval ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        <label class="field-inline">评分有效期
          <input id="score-age" type="number" min="1" max="72" value="${maxAge}" style="width:68px" /> 小时
        </label>
      </div>
      <div class="hint" style="margin-top:8px">
        有效期决定「允许错过几轮探测」：最近一次有效证据（探针或真实调用）超过它就判过期。
        探测间隔不能超过有效期的一半，否则供给会在两轮探测之间整段过期。
      </div>
      <div class="switch-row">
        <label class="switch">
          <input type="checkbox" id="allow-untrusted" ${allowUntrusted ? 'checked' : ''} />
          <span class="switch-track"><span class="switch-knob"></span></span>
          <span class="switch-text">
            <b>放行可疑供给</b>
            <span>探针判定可疑（指纹不符 / 输出截断 / 用量虚报）的站，也按有效成本正常参与路由；首字门槛不受这个开关影响</span>
          </span>
        </label>
        ${
          allowUntrusted
            ? `<div class="alert" style="margin-top:10px;background:var(--warn-soft);border-color:var(--warn-border)">
                 <div>
                   <div class="name">已放行：可疑的站会正常参与选站</div>
                   <div class="desc">它们仍然按「价格 ÷ 质量」排序——质量差一半，成本就翻倍，只有便宜到足够多才会被选中。首字门槛仍然独立生效。如果你更在意输出是否可信，把这个开关关掉。</div>
                 </div>
               </div>`
            : ''
        }
      </div>
    </div>`

  const blocks = providersWithOffers.map((provider) => {
    const offers = state.offers.filter((o) => o.providerId === provider.id)
    const rows = offers.map((offer) => {
      const score = state.scores[offer.id]
      const status = PROBE_STATUS[score?.status || 'unknown']
      const hasDetail = score && score.samples > 0
      // 冷却中（额度不足/限流/模型不在分组）单独标出来：可用率看不出问题，
      // 但路由会跳过它。此时不再并排显示「未探测」——那是两回事，容易看串
      const statusCell = score?.blocked
        ? `<span class="badge warn">${esc(blockedLabel(score.blocked))}</span>`
        : `<span class="badge ${status.cls}">${status.label}</span>${
            // 证据量：同样的「健康」，1 个样本和 10 个样本确定性差很多
            score && score.confidence !== 'high'
              ? `<div class="sub">${(score.samples || 0) + (score.trafficSamples || 0)} ${t('样本')}</div>`
              : ''
          }`
      return `
        <tr data-offer="${esc(offer.id)}" ${hasDetail ? 'data-act="toggle-detail" tabindex="0" style="cursor:pointer"' : ''}>
          <td class="mono">${esc(offer.upstreamName)}${offer.group ? ` <span class="badge ${groupChipOf(offer.providerId, offer.group)}">${esc(offer.group)}</span>` : ''}${hasDetail ? ' <span style="color:var(--faint);font-size:10px">▾</span>' : ''}</td>
          <td>${statusCell}</td>
          <td class="num">${pct(score?.availability)}</td>
          <td class="num">${pct(score?.fingerprintRate)}</td>
          <td class="num">${pct(score?.truncationRate)}</td>
          <td class="num">${pct(score?.billingRate)}</td>
          <td class="num">${score?.ttftMs ? `${score.ttftMs}ms` : '—'}</td>
          <td style="color:var(--faint)" title="${esc(t('探针：'))}${relTime(score?.lastProbeAt)}">${relTime(score?.evidenceAt)}</td>
          <td class="num"><button class="ghost" data-act="probe">探测</button></td>
        </tr>
        <tr class="detail-row" data-detail-for="${esc(offer.id)}" ${new URLSearchParams(location.search).has('expand') ? '' : 'hidden'}>
          <td colspan="9">${probeDetailHtml(score)}</td>
        </tr>`
    }).join('')

    const panelKey = `probe:${provider.id}`
    const isCollapsed = collapsedPanels.has(panelKey)

    return `
      <div class="table-wrap">
        <div class="group-head">
          <button class="ghost tiny" data-act="toggle-panel" data-panel="${esc(panelKey)}">${isCollapsed ? '▸' : '▾'}</button>
          <span class="model">${esc(provider.name)}</span>
          <span class="count">${offers.length} 个模型</span>
        </div>
        ${isCollapsed ? '' : `
        <table>
          <thead><tr>
            <th>模型</th><th>状态</th>
            <th class="num">可用率</th><th class="num">指纹</th>
            <th class="num">截断</th><th class="num">计费</th>
            <th class="num">TTFT</th><th title="${esc(t('最近一次有效证据（探针或真实调用）'))}">${t('最近证据')}</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`}
      </div>`
  }).join('')

  view.innerHTML = `${intro}
    <p class="hint">
      指纹 100% 表示每次都精确返回了要求的内容，低于这个值说明上游可能把请求转给了别的模型。
      截断一栏是「没被截断」的比例，计费一栏是「用量正常」的比例。
    </p>
    ${blocks}`
}

// --------------------------------------------------------------- 网关视图

function formatTokens(value) {
  const n = Number(value) || 0
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

let lastCreatedGatewayKey = null

function renderGateway() {
  const view = $('#view-gateway')
  const gateway = state.gateway
  if (!Array.isArray(gateway?.keys)) {
    view.innerHTML = `<div class="empty"><h3>网关未初始化</h3><p>重启 daemon 会自动初始化。</p></div>`
    return
  }

  const baseUrl = `${location.origin}/v1`
  const routing = state.routing || []
  const okCount = routing.filter((r) => r.outcome === 'ok').length
  const healthyModels = Object.values(state.scores || {}).filter((s) => s.routable).length
  const usage = state.usage || { totals: {}, byKey: {}, byModel: {} }
  const byKey = usage.byKey || {}

  const createdBanner = !lastCreatedGatewayKey ? '' : `
    <div class="card" style="border-color:var(--accent-mid);background:var(--accent-soft)">
      <div style="font-weight:500;margin-bottom:8px">Key「${esc(lastCreatedGatewayKey.name)}」已创建，现在复制保存</div>
      <div class="keyrow" style="border:none;padding:0">
        <span class="mono grow">${esc(lastCreatedGatewayKey.key)}</span>
        <button data-act="copy-new-gwkey">复制</button>
        <button class="ghost" data-act="dismiss-new-gwkey">关闭</button>
      </div>
      <div class="hint">关闭后列表里只显示尾号，仍可通过「复制」取回。</div>
    </div>`

  const entryCard = `
    <div class="card">
      <div class="card-head">
        <div>
          <h3>网关入口</h3>
          <div class="meta">客户端填这个地址和任意一把 Key，就能访问全部站点</div>
        </div>
        <div class="card-actions">
          <button data-act="toggle-gateway">${gateway.enabled ? '关闭网关' : '开启网关'}</button>
        </div>
      </div>
      <div class="keyrow">
        <span style="width:52px;color:var(--muted)">地址</span>
        <span class="mono grow">${esc(baseUrl)}</span>
        <button class="ghost" data-act="copy-base">复制</button>
      </div>
      <div class="badges">
        <span class="badge ${gateway.enabled ? 'ok' : 'warn'}">${gateway.enabled ? '运行中' : '已关闭'}</span>
        <span class="badge">${gateway.keys.length} 把 Key</span>
        <span class="badge">${healthyModels} 条供给可路由</span>
      </div>
    </div>`

  const keyRows = gateway.keys.map((record) => {
    const used = byKey[record.id] || {}
    const total = (used.input || 0) + (used.output || 0)
    return `
      <tr data-gwkey="${esc(record.id)}">
        <td>${esc(record.name)}</td>
        <td class="mono">sk-mapi-••••${esc(String(record.key).slice(-4))}</td>
        <td class="num">${formatTokens(total)}</td>
        <td class="num">${record.monthlyTokenLimit ? formatTokens(record.monthlyTokenLimit) : '不限'}</td>
        <td>
          <button class="ghost" data-act="toggle-gwkey" style="padding:0">
            <span class="badge ${record.enabled ? 'ok' : ''}">${record.enabled ? '启用' : '停用'}</span>
          </button>
        </td>
        <td class="num">
          <button class="ghost" data-act="copy-gwkey">复制</button>
          <button class="ghost" data-act="rotate-gwkey">轮换</button>
          <button class="ghost danger" data-act="del-gwkey">删除</button>
        </td>
      </tr>`
  }).join('')

  const keyBlock = `
    <h3 class="section-title">API Keys</h3>
    <p class="hint">给每个客户端单独一把 Key，用量才能分开统计；哪一把泄露了，单独轮换即可。</p>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>名称</th><th>Key</th><th class="num">30 天 token</th>
          <th class="num">月限额</th><th>状态</th><th></th>
        </tr></thead>
        <tbody>${keyRows}</tbody>
      </table>
    </div>
    <form class="inline-form" data-form="add-gwkey"
      style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;margin-bottom:20px">
      <input name="name" placeholder="Key 名称，如 Cherry Studio" required style="max-width:300px" />
      <input name="monthlyTokenLimit" type="number" min="0" placeholder="月 token 限额（可空）" style="width:180px" />
      <button type="submit" class="primary">新建 Key</button>
    </form>`

  const logRows = routing.length === 0
    ? `<tr><td colspan="9" style="text-align:center;color:var(--faint);padding:28px">还没有请求经过网关</td></tr>`
    : routing.map((r) => `
        <tr>
          <td style="color:var(--faint)">${fmtDateTime(r.ts)}</td>
          <td>${esc(r.keyName || '—')}</td>
          <td class="mono">${esc(r.model)}</td>
          <td>${r.chosenProviderName ? `${esc(r.chosenProviderName)}${r.chosenGroup ? ` <span class="badge ${r.pool === 'free' ? 'vchip-free' : groupChipOf(r.chosenProviderId, r.chosenGroup)}">${esc(r.chosenGroup)}</span>` : ''}` : '<span class="badge danger">全部失败</span>'}</td>
          <td class="num">${r.usage ? formatTokens((r.usage.prompt_tokens || 0) + (r.usage.completion_tokens || 0)) : '—'}</td>
          <td class="num">${r.attempts}</td>
          <td class="num">${r.ttftMs ? `${r.ttftMs}ms` : '—'}</td>
          <td class="num">${r.latencyMs}ms</td>
          <td>${r.outcome === 'ok' ? '<span class="badge ok">成功</span>' : `<span class="badge danger">${esc(r.outcome)}</span>`}</td>
        </tr>`).join('')

  const logBlock = `
    <h3 class="section-title">最近请求</h3>
    <div class="table-wrap">
      <div class="group-head">
        <span class="model">路由决策</span>
        <span class="count">${okCount} / ${routing.length} 成功</span>
      </div>
      <table>
        <thead><tr>
          <th>时间</th><th>Key</th><th>请求模型</th><th>选中站点</th>
          <th class="num">token</th><th class="num">尝试</th><th class="num">首字</th><th class="num">耗时</th><th>结果</th>
        </tr></thead>
        <tbody>${logRows}</tbody>
      </table>
    </div>`

  view.innerHTML = `${createdBanner}${entryCard}${keyBlock}${logBlock}`
}

// --------------------------------------------------------------- 用量视图

let usageRange = 30
let usageData = null

function tokenTotal(row) {
  return (row?.input || 0) + (row?.output || 0)
}

function renderUsage() {
  const view = $('#view-usage')
  const usage = usageData || state.usage || {}
  const totals = usage.totals || {}
  const dayEntries = Object.entries(usage.byDay || {}).sort((a, b) => a[0].localeCompare(b[0]))

  if (!totals.requests) {
    // 副标题只在当前页是 usage 时显示；这里曾误写成 'gateway'，导致空态副标题永远不出现
    setPageSubFor('usage', '还没有请求经过网关')
    view.innerHTML = `
      <div class="empty">
        <h3>暂无用量数据</h3>
        <p>在客户端里把 Base URL 指向网关、填上 Key 之后，这里会开始记录。</p>
        <button class="primary" data-goto="gateway">去配置网关</button>
      </div>`
    return
  }

  const seg = `
    <div class="seg">
      ${[7, 30, 90].map((d) => `<button data-range="${d}" class="${d === usageRange ? 'active' : ''}">${d} 天</button>`).join('')}
    </div>`

  const maxTokens = Math.max(1, ...dayEntries.map(([, row]) => tokenTotal(row)))
  const showLabels = dayEntries.length <= 10
  const bars = dayEntries.map(([day, row], index) => {
    const total = tokenTotal(row)
    const height = total ? Math.max(Math.round((total / maxTokens) * 100), 3) : 1
    const label = showLabels || index % 5 === 0 || index === dayEntries.length - 1 ? day.slice(5) : ''
    return `<div class="bar-item ${total ? '' : 'zero'}" title="${day} · ${total} token · ${row.requests || 0} 次请求">
      <div class="bar" style="height:${height}%"></div>
      <span class="bar-label">${label}</span>
    </div>`
  }).join('')

  const keyRows = Object.entries(usage.byKey || {})
    .sort((a, b) => tokenTotal(b[1]) - tokenTotal(a[1]))
    .map(([keyId, row]) => {
      const record = state.gateway?.keys?.find((k) => k.id === keyId)
      const name = record?.name || (keyId === '-' ? '（未认证）' : keyId)
      return `<tr>
        <td>${esc(name)}</td>
        <td class="num">${row.requests}</td>
        <td class="num">${formatTokens(row.input)}</td>
        <td class="num">${formatTokens(row.output)}</td>
        <td class="num">${row.avgTtftMs ? `${row.avgTtftMs}ms` : '—'}</td>
      </tr>`
    }).join('')

  const modelRows = Object.entries(usage.byModel || {})
    .sort((a, b) => tokenTotal(b[1]) - tokenTotal(a[1]))
    .slice(0, 15)
    .map(([model, row]) => `<tr>
      <td class="mono">${esc(model)}</td>
      <td class="num">${row.requests}</td>
      <td class="num">${formatTokens(row.input)}</td>
      <td class="num">${formatTokens(row.output)}</td>
      <td class="num">${row.avgTtftMs ? `${row.avgTtftMs}ms` : '—'}</td>
    </tr>`).join('')

  const providerRows = Object.entries(usage.byProvider || {})
    .sort((a, b) => tokenTotal(b[1]) - tokenTotal(a[1]))
    .map(([providerId, row]) => {
      const name =
        state.providers.find((p) => p.id === providerId)?.name ||
        (providerId === '-' ? '（未成功）' : providerId)
      return `<tr>
        <td>${esc(name)}</td>
        <td class="num">${row.requests}</td>
        <td class="num">${formatTokens(row.input)}</td>
        <td class="num">${formatTokens(row.output)}</td>
        <td class="num">${row.avgLatencyMs ? `${row.avgLatencyMs}ms` : '—'}</td>
      </tr>`
    }).join('')

  const emptyRow = (cols) =>
    `<tr><td colspan="${cols}" style="text-align:center;color:var(--faint);padding:20px">无数据</td></tr>`

  setPageSubFor(
    'usage',
    `最近 ${usageRange} 天 · ${totals.requests} 次请求 · ${formatTokens(tokenTotal(totals))} token`,
  )

  view.innerHTML = `
    ${seg}
    <div class="stats" style="margin-top:16px">
      <div class="stat"><div class="k">请求数</div><div class="v">${totals.requests}</div></div>
      <div class="stat"><div class="k">输入 token</div><div class="v">${formatTokens(totals.input)}</div></div>
      <div class="stat"><div class="k">输出 token</div><div class="v">${formatTokens(totals.output)}</div></div>
      <div class="stat"><div class="k">错误</div><div class="v">${totals.errors || 0}</div></div>
    </div>

    <h3 class="section-title">按天</h3>
    <div class="card" style="padding:14px 16px 10px">
      <div class="bars">${bars}</div>
      <div class="hint" style="margin-top:8px">柱高按 token 总量，悬停看当天明细。</div>
    </div>

    <h3 class="section-title">按 Key</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Key</th><th class="num">请求</th><th class="num">输入</th><th class="num">输出</th><th class="num">平均首字</th></tr></thead>
        <tbody>${keyRows || emptyRow(5)}</tbody>
      </table>
    </div>

    <h3 class="section-title">按模型</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>模型</th><th class="num">请求</th><th class="num">输入</th><th class="num">输出</th><th class="num">平均首字</th></tr></thead>
        <tbody>${modelRows || emptyRow(5)}</tbody>
      </table>
    </div>

    <h3 class="section-title">按站点</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>站点</th><th class="num">请求</th><th class="num">输入</th><th class="num">输出</th><th class="num">平均耗时</th></tr></thead>
        <tbody>${providerRows || emptyRow(5)}</tbody>
      </table>
    </div>`
}

// ------------------------------------------------------------- 基准价视图

/** 汇率状态：手动 / 自动 + 更新时间 */
function fxState() {
  const raw = state?.settings?.fx
  return {
    manual: Boolean(raw?.manual),
    source: raw?.source || 'default',
    updatedAt: raw?.updatedAt || null,
    rates: raw?.rates || {},
  }
}

function fxNoteHtml() {
  const fx = fxState()
  if (fx.manual) return `<span class="hint">${t('手动汇率')}</span>`
  if (!fx.updatedAt) return `<span class="hint">${t('还没拉取过自动汇率')}</span>`
  const days = (Date.now() - Date.parse(fx.updatedAt)) / 86400000
  const when = agoText(fx.updatedAt)
  const text = t('自动 · {ago}更新', { ago: when })
  return `<span class="hint ${days > 7 ? 'warn-text' : ''}">${text}</span>`
}

// 基准价分层：默认只展开「与本地供给相关」（模型在比价/路由里用得到）
// 和「手动改过」的条目，其余（导入后没用上的）收进折叠区
let benchShowAll = false

function renderBenchmark() {
  const view = $('#view-benchmark')
  const filterText = filters.benchmark.trim().toLowerCase()
  const entries = Object.entries(state.benchmarks)
    .filter(([key, entry]) => {
      if (!filterText) return true
      return (
        key.toLowerCase().includes(filterText) ||
        String(entry.display || '').toLowerCase().includes(filterText)
      )
    })
    .sort((a, b) => a[0].localeCompare(b[0]))

  // 与本地供给相关的判定：基准 key 被任何一条供给引用（benchmarkKey /
  // modelKey / upstreamName 任一命中）
  const usedKeys = new Set()
  for (const o of state.offers || []) {
    for (const k of [o.benchmarkKey, o.modelKey, o.upstreamName]) {
      if (k) usedKeys.add(String(k).toLowerCase())
    }
  }
  const isRelevant = ([key, entry]) =>
    usedKeys.has(key.toLowerCase()) || String(entry.source || '') === 'manual'
  // 搜索时强制看全部（搜索意图就是找，别再分层）
  const layering = !filterText && !benchShowAll
  let matching = layering ? entries.filter(isRelevant) : entries
  // 相关条目为空时不分层：新用户还没有供给，全部折叠会让页面空白，
  // 看起来像「导入失败」——直接展示全部
  if (layering && matching.length === 0 && entries.length > 0) matching = entries
  const relevantCount = entries.filter(isRelevant).length
  const restCount = entries.length - (layering ? matching.length : relevantCount)

  // 来源值的展示友好化（来源是低频诊断信息，降为模型列的小字，省一列宽度）。
  // imported: 带站点名——「从站导入」不说是哪个站，用户对不上号
  const sourceLabel = (source) => {
    const s = String(source || 'manual')
    if (s === 'manual') return ''
    if (s === 'seed') return '内置'
    if (s.startsWith('reference:')) return `参考价 · ${s.slice('reference:'.length)}`
    if (s.startsWith('imported:')) {
      const pid = s.slice('imported:'.length)
      return `从站导入 · ${state.providers.find((p) => p.id === pid)?.name || pid}`
    }
    return s
  }

  const rows = matching.map(([key, entry]) => {
    // 次要信息合并成一行小字（显示名 · 来源），避免两行堆在 key 底下
    const extras = []
    const display = String(entry.display || '')
    if (display && display !== key) extras.push(display)
    const src = sourceLabel(entry.source)
    if (src) extras.push(src)
    return `
    <tr data-benchmark="${esc(key)}">
      <td class="mono">
        ${esc(key)}
        ${extras.length ? `<div class="sub" style="color:var(--faint)">${esc(extras.join(' · '))}</div>` : ''}
      </td>
      <td class="num"><input type="number" step="0.001" placeholder="—" value="${entry.in ?? ''}" data-field="in" /></td>
      <td class="num"><input type="number" step="0.001" placeholder="—" value="${entry.out ?? ''}" data-field="out" /></td>
      <td class="num" style="white-space:nowrap">
        <input type="number" step="0.001" placeholder="入" value="${entry.offPeakIn ?? ''}" data-field="offPeakIn" style="width:62px" title="空闲时段输入价（如 DeepSeek 半价时段），没有就留空" />
        <input type="number" step="0.001" placeholder="出" value="${entry.offPeakOut ?? ''}" data-field="offPeakOut" style="width:62px" title="空闲时段输出价" />
      </td>
      <td>
        <select data-field="currency" style="width:70px">
          <option value="USD" ${entry.currency !== 'CNY' ? 'selected' : ''}>USD</option>
          <option value="CNY" ${entry.currency === 'CNY' ? 'selected' : ''}>CNY</option>
        </select>
      </td>
      <td class="num"><button class="ghost danger" data-act="del-benchmark">删除</button></td>
    </tr>`
  }).join('')

  const providerOptions = state.providers
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')

  view.innerHTML = `
    <p class="hint">基准价是「倍率」的换算参照。三条路：从站点导入官方价、以此站已填价为准、或载入内置参考价。</p>
    <div class="card">
      <div class="inline-form" style="border-top:none;margin-top:0;padding-top:0">
        <select id="import-provider" style="max-width:210px">${providerOptions || '<option value="">还没有站点</option>'}</select>
        <button id="btn-plaza-benchmark" title="优先用令牌读「可用渠道」，没有则用模型广场" ${state.providers.length ? '' : 'disabled'}>从站点导入官方价</button>
        <button id="btn-import-benchmark" ${state.providers.length ? '' : 'disabled'}>以此站已填价为准</button>
        <span style="color:var(--faint);font-size:12px;margin:0 2px">或</span>
        <button id="btn-seed-benchmark">载入内置参考价</button>
      </div>
      <p class="hint" style="margin:10px 0 0">
        ${t('<b>从站点导入官方价</b>：优先用「令牌」读该站的「可用渠道」（数据最全，不要求开广场），读不到再回落「模型广场」。只补空缺、不覆盖你已有的条目。<br />')}
        ${t('<b>以此站已填价为准</b>：把这个站已经填好的实际价整体设为基准，适合你确信它没虚标的情况。<br />')}
        ${t('<b>载入内置参考价</b>：用工具内置的一份官方价（截至 {asOf}），价格常变，务必核对。', {
          asOf: esc(state.reference?.asOf || '—'),
        })}
      </p>
    </div>
    <div class="toolbar" style="margin:18px 0 10px">
      <input id="benchmark-search" class="search" type="search" placeholder="搜索模型名…" value="${esc(filters.benchmark)}" />
      <span class="hint" style="margin:0">${layering ? `${matching.length} 条与本地供给相关 · 共 ${entries.length} 条` : `共 ${entries.length} 条`}</span>
      <span style="flex:1"></span>
      <label class="field-inline" title="${t('只影响价格显示，不影响比较口径（比较一律按美元）')}">
        <span>${t('显示币种')}</span>
        <select id="display-currency" data-act="display-currency" style="width:78px">
          <option value="USD" ${state.settings.displayCurrency === 'USD' ? 'selected' : ''}>USD $</option>
          <option value="CNY" ${state.settings.displayCurrency === 'CNY' ? 'selected' : ''}>CNY ¥</option>
        </select>
      </label>
      <label class="field-inline" title="${t('只影响人民币标价/展示的折算')}">
        <span data-i18n="汇率 USD→CNY">汇率 USD→CNY</span>
        <input id="fx-input" data-act="fx" type="number" step="0.0001" min="1" value="${esc(rateCny())}" style="width:96px" />
      </label>
      <span class="fx-note">${fxNoteHtml()}</span>
      <button class="ghost tiny" data-act="fx-refresh">${t('刷新汇率')}</button>
      ${fxState().manual
        ? `<button class="ghost tiny" data-act="fx-auto">${t('恢复自动')}</button>`
        : ''}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>模型 <span style="color:var(--faint);font-weight:400">（小字为显示名 / 来源）</span></th>
          <th class="num">输入价</th><th class="num">输出价</th>
          <th class="num">空闲价（入 / 出）</th>
          <th>币种</th><th></th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="6" style="color:var(--faint);text-align:center;padding:24px">还没有基准价</td></tr>'}</tbody>
        ${
          layering && restCount > 0
            ? `<tr><td colspan="6" style="text-align:center;padding:10px;border-top:1px dashed var(--border)">
                 <button class="ghost tiny" data-act="bench-show-all">${t('显示其余 {n} 条（未匹配本地供给）', { n: restCount })}</button>
               </td></tr>`
            : benchShowAll && !filterText && relevantCount < entries.length
              ? `<tr><td colspan="6" style="text-align:center;padding:10px;border-top:1px dashed var(--border)">
                   <button class="ghost tiny" data-act="bench-show-all">${t('收起，只看与本地供给相关的 {n} 条', { n: relevantCount })}</button>
                 </td></tr>`
              : ''
        }
      </table>
    </div>`
}

// --------------------------------------------------------------- 监控视图

let monitorData = null
let monitorDays = 7
/** 花费 KPI 的时间段：today / week / month。只影响那张卡，不影响图表 */
let spendRange = 'today'
/** 概览图选中项：'ALL' 看总体，或某个 providerId 只看该站 */
let chartSite = 'ALL'
let monitorLoading = false
/** 公告面板当前选中的站点；'all' = 不分站。切站点只重渲染，不重新拉数据 */
let noticeSite = 'all'

/** 相对时间：监控页到处都是「3 分钟前」，比 ISO 串好读得多 */
function agoText(iso) {
  if (!iso) return t('还没采过')
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return '—'
  if (ms < 60 * 1000) return t('刚刚')
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return t('{n} 分钟前', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('{n} 小时前', { n: hours })
  return t('{n} 天前', { n: Math.floor(hours / 24) })
}

/**
 * 余额概览：左轴余额折线（带面积），右轴每日花费柱。
 * 两个量级差得远（余额几十块、花费几毛），共用一根轴的话柱子会贴地看不见。
 */
/**
 * 概览图：单站模式 / 全部模式。
 *
 * 折线永远只有一条（余额），柱子按选择切换：
 *   selected === 'ALL'  → 折线=各站余额合计，柱子=各站花费堆叠（每站一色）
 *   否则                → 折线=该站余额，柱子=该站每日花费（单色淡填充）
 *
 * 只有一条折线是刻意的：多站余额叠在一起时，小站的线会被压到贴地、
 * 互相穿插，看不出任何东西（实测 5 个站就糊成一片）。想看单站切过去，
 * 轴刻度会跟着缩放到该站的量级。
 */
function monitorChartSvg(balanceSeries = [], spendSeries = [], options = {}) {
  const W = 760
  const H = 240
  const padL = 54
  const padR = 54
  const padT = 14
  const padB = 26
  const innerW = W - padL - padR
  const innerH = H - padT - padB
  const n = Math.max(balanceSeries.length, spendSeries.length)
  if (n === 0) return ''

  const { selected = 'ALL', providerIds = [], colorOf = () => 'var(--accent)', fx = 7.2 } = options
  const isAll = selected === 'ALL'
  const accent = isAll ? 'var(--accent)' : colorOf(selected)

  // 余额序列：全部用后端 total（人民币），单站用该站余额折人民币
  const balVals = balanceSeries.map((d) => {
    if (isAll) return typeof d.total === 'number' ? d.total : null
    const raw = d.perProvider?.[selected]
    return typeof raw === 'number' ? raw * fx : null
  })

  const known = balVals.filter((v) => v !== null).map((v) => dispPrice(v))
  const hasSpend = spendSeries.some((d) => {
    if (isAll) return providerIds.some((pid) => (d.byProvider?.[pid] || 0) > 0)
    return (d.byProvider?.[selected] || 0) > 0
  })
  if (known.length === 0 && !hasSpend) return ''

  let min = known.length ? Math.min(...known) : 0
  let max = known.length ? Math.max(...known) : 1
  if (min === max) {
    min = Math.max(0, min - 1)
    max += 1
  }
  max += (max - min) * 0.15

  // 花费：全部按当日所有站合计定轴，单站按该站
  const spendVals = spendSeries.map((d) => {
    const cny = isAll
      ? providerIds.reduce((sum, pid) => sum + (d.byProvider?.[pid] || 0), 0)
      : (d.byProvider?.[selected] || 0)
    return dispPrice(cny) ?? 0
  })
  const spendMax = Math.max(0.01, ...spendVals) * 1.15

  const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const yBal = (v) => padT + innerH - ((v - min) / (max - min)) * innerH
  const ySpend = (v) => padT + innerH - (v / spendMax) * innerH
  const barW = Math.max(3, Math.min(24, (innerW / Math.max(n, 1)) * 0.5))

  // 网格 + 双轴刻度
  const grid = [0, 1, 2, 3]
    .map((i) => {
      const ratio = i / 3
      const py = padT + innerH * (1 - ratio)
      const balLabel = min + (max - min) * ratio
      const spendLabel = spendMax * ratio
      return `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${py.toFixed(1)}" y2="${py.toFixed(1)}" />
      <text class="axis-label" x="${padL - 8}" y="${(py + 3.5).toFixed(1)}" text-anchor="end">${priceSym()}${money(balLabel)}</text>
      <text class="axis-label" x="${W - padR + 8}" y="${(py + 3.5).toFixed(1)}">${priceSym()}${money(spendLabel)}</text>`
    })
    .join('')

  // 柱子
  let bars = ''
  spendSeries.forEach((d, i) => {
    const cx = x(i)
    if (isAll) {
      let acc = 0
      for (const pid of providerIds) {
        const cny = d.byProvider?.[pid] || 0
        if (cny <= 0) continue
        const v = dispPrice(cny) ?? 0
        if (v <= 0) continue
        const y0 = ySpend(acc)
        const y1 = ySpend(acc + v)
        bars += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.8, y0 - y1).toFixed(1)}" rx="1" fill="${colorOf(pid)}" opacity="0.85" />`
        acc += v
      }
    } else {
      const v = spendVals[i]
      if (v <= 0) return
      const y1 = ySpend(v)
      bars += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, padT + innerH - y1).toFixed(1)}" rx="1" fill="${accent}" opacity="0.3" />`
    }
  })

  // 余额折线（连续有效点才连）
  const segments = []
  let current = []
  balVals.forEach((raw, i) => {
    const v = raw === null ? null : dispPrice(raw)
    if (v === null) {
      if (current.length) segments.push(current)
      current = []
      return
    }
    current.push([x(i), yBal(v)])
  })
  if (current.length) segments.push(current)
  const linePaths = segments
    .filter((seg) => seg.length > 1)
    .map((seg) => `M${seg.map(([px, py]) => `${px.toFixed(1)} ${py.toFixed(1)}`).join('L')}`)
    .join(' ')
  const dots = segments
    .flat()
    .map(([px, py]) => `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.6" />`)
    .join('')

  // 逐日命中区：悬停看当天明细（余额 + 各站花费）
  const hits = balanceSeries
    .map((d, i) => {
      const w = innerW / Math.max(n, 1)
      // pointer-events="all" 必须显式写：fill="transparent" 的 rect 在 SVG 里
      // 默认不接收指针事件（透明填充被当成不可见），悬停会直接穿透到 svg
      return `<rect x="${(x(i) - w / 2).toFixed(1)}" y="${padT}" width="${w.toFixed(1)}" height="${innerH}" fill="transparent" pointer-events="all" data-chart-day="${i}" />`
    })
    .join('')

  const step = Math.max(1, Math.ceil(n / 7))
  const dayLabels = balanceSeries
    .map((d, i) => {
      const keep = (i > 0 && i % step === 0) || (i === n - 1 && n > 1)
      if (!keep) return ''
      const anchor = i === n - 1 ? 'end' : 'middle'
      return `<text class="axis-label" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${anchor}">${esc(String(d.day).slice(5))}</text>`
    })
    .join('')

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('余额与花费趋势'))}" style="--chart-accent:${accent}">
    ${grid}
    ${bars}
    ${linePaths ? `<path class="line" d="${linePaths}" />` : ''}
    <g class="dots">${dots}</g>
    ${dayLabels}
    ${hits}
  </svg>`
}

function feedAlertRow(row) {
  const dot = row.level === 'danger' ? 'red' : row.level === 'warn' ? 'yellow' : ''
  return `<div class="monitor-feed-row ${row.readAt ? 'read' : ''}">
    <span class="dot ${dot}"></span>
    <div class="monitor-feed-body">
      <div class="monitor-feed-title">${esc(row.title)}</div>
      ${row.detail ? `<div class="monitor-feed-detail">${esc(row.detail)}</div>` : ''}
      <div class="monitor-feed-meta">${esc(row.providerName || '')} · ${agoText(row.at)}</div>
    </div>
  </div>`
}

/**
 * 上游公告大多是 Markdown：标题井号、加粗星号、链接、列表符号。
 * 这里只做「去掉标记、保留文字」的降噪，不解析成 HTML——不引入渲染器，也不给自己找 XSS。
 */
function plainNotice(text) {
  return String(text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function feedAnnouncementRow(row) {
  const content = plainNotice(row.content)
  // 站点名已经在分组标题上了，行里不再重复，只留时间
  return `<div class="monitor-feed-row ${row.readAt ? 'read' : ''}">
    <div class="monitor-feed-body">
      <div class="monitor-feed-title">${esc(row.title)}</div>
      ${content ? `<div class="monitor-feed-detail">${esc(content)}</div>` : ''}
      <div class="monitor-feed-meta">${agoText(row.publishedAt)}</div>
    </div>
  </div>`
}

const SPEND_RANGES = [
  { key: 'today', label: '今天' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
]

/**
 * 花费 KPI 卡：模型消费 / 实际消费双值 + 时间段切换。
 *
 * 「模型消费」是站点口径的估算（和余额概览的每日花费柱同一份数）；
 * 「实际消费」乘站点单价，回答「我的钱包到底少了多少钱」——两者在
 * 1:1 充值的站会差好几倍，所以必须并列显示，不能只留一个。
 */
function spendStat(range) {
  const estimate = monitorData?.spendSummary?.[range] || { estimated: 0, actual: 0 }
  const site = monitorData?.siteSpend?.[range] || null
  const label = SPEND_RANGES.find((r) => r.key === range)?.label || '今天'
  const seg = `<span class="spend-range">${SPEND_RANGES.map(
    (r) => `<button class="${r.key === range ? 'is-on' : ''}" data-spend-range="${r.key}">${t(r.label)}</button>`,
  ).join('')}</span>`

  // 「实际消费」只有站点账单一个来源：站点自己按天算的账。
  // 网关侧的 token 估算缺 26% 的 token、上游 cached 字段也不可靠，
  // 拿它乘单价得到的数永远和钱包对不上——所以不做展示，只留作内部参考。
  // 站点账单金额是站点货币单位；按 1:1 充值口径它同时就是人民币近似值，
  // 这里直接按「站点货币 → 人民币」用站点单价折一次（默认 1）。
  const hasSite = site && site.providers > 0
  const siteCny = hasSite ? site.actual * siteUnitPriceForTotal() : 0
  const actualHtml = hasSite
    ? `<b class="spend-actual">${priceSym()}${money(dispPrice(siteCny))}</b>`
    : `<b class="spend-actual spend-muted">${t('读不到账单')}</b>`
  const hint = hasSite ? t('{n} 个站点账单', { n: site.providers }) : t('站点未提供账单接口或令牌无效')

  return {
    k: `${t('花费')} · ${t(label)}`,
    // 时间段切换单独一行：和金额挤在一行时，窄卡片会把「今天/本周/本月」
    // 压成竖排（每个字一行）
    vHtml: `<span class="spend-pair">
        <span class="spend-item"><span class="spend-tag spend-tag--actual">${t('实际消费')}</span>${actualHtml}</span>
      </span><span class="spend-range-row">${seg}</span>`,
    sub: hint,
    ic: 'receipt',
    tint: 'tint-warn',
  }
}

/**
 * 汇总站点账单时用的单价：站点自己填的 → 全局默认 → 1。
 * 与 spendFactorOf 不同：这里账单已经是「站点货币」，直接乘单价就是人民币，
 * 不再和市场汇率比（账单不是按美元定价的估算值）。
 */
function siteUnitPriceForTotal() {
  const explicit = Number(state?.settings?.defaultUnitPrice)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return 1
}

function renderMonitor() {
  const view = $('#view-monitor')
  if (!view) return

  if (!monitorData) {
    if (!monitorLoading) void loadMonitor()
    view.innerHTML = `<div class="empty"><h3>正在读取监控数据…</h3><p>第一次打开会现采一轮，稍等一下。</p></div>`
    return
  }

  const data = monitorData
  const kpi = data.kpi || {}
  const providers = state?.providers || []

  if (providers.length === 0) {
    // 这里必须是「新增站点」而不是 data-goto="providers"：站点页已经并入
    // 监控页，跳 #providers 等于跳回本页，点了没有任何反应（刚 clone 后
    // 唯一能进入的页面就是这里，按钮不通就等于整个工具无法使用）
    view.innerHTML = `
      <div class="empty">
        <h3>还没有中转站</h3>
        <p>监控会定时读每个站的余额、倍率与公告。先添加一个站点开始。</p>
        <button class="primary" data-act="add-provider">${icon('plus')}新增站点</button>
      </div>`
    return
  }

  // ---------------------------------------------------------------- KPI
  const latestBalance = [...(data.balanceSeries || [])].reverse().find((d) => typeof d.total === 'number')
  const kpiItems = [
    {
      k: '站点',
      v: `${kpi.withBalance ?? 0}/${kpi.providerCount ?? providers.length}`,
      sub: '有余额数据',
      ic: 'servers',
      tint: 'tint-muted',
    },
    {
      k: '总余额',
      // 后端给的 total 是人民币口径；主数字按显示币种渲染
      v: latestBalance?.total == null
        ? '—'
        : `${priceSym()}${money(dispPrice(latestBalance.total))}`,
      // 副标题给「另一个币种」的等值，方便对账；没有总额时才退回「最低」
      sub: latestBalance?.total != null
        ? (showUsd()
            ? `≈ ¥${money(latestBalance.total)}（按汇率折算）`
            : `≈ $${money(latestBalance.total / rateCny())}（按汇率折算）`)
        : (kpi.lowest
            ? t('最低：{name} {amount}', {
                name: kpi.lowest.name,
                amount: `${kpi.lowest.currency || ''} ${money(kpi.lowest.balance)}`.trim(),
              })
            : '还没有余额数据'),
      ic: 'wallet',
      tint: 'tint-accent',
    },
    {
      // 花费卡：模型消费（站点口径估算）与实际消费（钱包里真正少掉的钱）并列。
      // 实际消费 = 估算 × (站点单价 ÷ 市场汇率)；不填单价时系数为 1，两数相同
      ...spendStat(spendRange),
    },
    {
      k: '24 小时变动',
      v: kpi.rateChanges24h ?? 0,
      sub: '倍率 / 价格',
      ic: 'swap',
      tint: 'tint-muted',
    },
    {
      k: '未读告警',
      v: kpi.unreadAlerts ?? 0,
      sub: t('上次同步 {ago}', { ago: agoText(kpi.lastRunAt) }),
      ic: 'alert',
      tint: (kpi.unreadAlerts ?? 0) > 0 ? 'tint-warn' : 'tint-muted',
    },
  ]

  const kpiHtml = `<div class="stats monitor-kpi">${kpiItems
    .map(
      (item) => `<div class="stat">
        <div class="stat-main">
          <div class="k">${esc(item.k)}</div>
          <div class="v">${item.vHtml ?? esc(item.v)}</div>
          ${item.sub ? `<div class="sub">${esc(item.sub)}</div>` : ''}
        </div>
        <div class="stat-icon ${item.tint}">${icon(item.ic)}</div>
      </div>`,
    )
    .join('')}</div>`

  // -------------------------------------------------------------- 图表
  // 只把「有余额或有花费」的站放进选择器——没数据的站点了也是空图
  const chartProviders = (data.balanceByProvider || [])
    .filter((row) => row.balance !== null || (data.spendSeries || []).some((d) => (d.byProvider?.[row.providerId] || 0) > 0))
    .map((row) => row.providerId)
  // 直接解析 CSS 变量给 SVG 用：series-N 类挂在选择器胶囊上，
  // SVG 里的 rect 拿不到那个作用域，必须给具体颜色值
  const SERIES_COLORS = [
    'hsl(226 55% 52%)', 'hsl(18 60% 52%)', 'hsl(166 45% 38%)', 'hsl(268 42% 56%)',
    'hsl(340 48% 55%)', 'hsl(43 65% 45%)', 'hsl(200 50% 45%)', 'hsl(100 30% 42%)',
  ]
  const seriesColorOf = (pid) => SERIES_COLORS[(Math.max(0, chartProviders.indexOf(pid)) % 8)]
  const seriesClassOf = (pid) => `series-${(Math.max(0, chartProviders.indexOf(pid)) % 8) + 1}`
  const colorOf = seriesColorOf
  // 选中的站在数据里消失了（被删/暂停）→ 回落到全部
  if (chartSite !== 'ALL' && !chartProviders.includes(chartSite)) chartSite = 'ALL'
  const chart = monitorChartSvg(data.balanceSeries, data.spendSeries, {
    selected: chartSite,
    providerIds: chartProviders,
    colorOf,
    seriesClassOf,
    fx: rateCny(),
  })
  const seg = `<div class="seg">${[7, 14, 30]
    .map((d) => `<button data-monitor-days="${d}" class="${d === monitorDays ? 'active' : ''}">${t('{n} 天', { n: d })}</button>`)
    .join('')}</div>`

  // 站点选择胶囊：「全部」+ 有数据的站。只放站名，余额在卡片/KPI 里已经有了
  const allChip = `<button class="monitor-chip${chartSite === 'ALL' ? ' is-on' : ''}" data-chart-site="ALL">${t('全部站点')}</button>`
  const siteChips = (data.balanceByProvider || [])
    .filter((row) => chartProviders.includes(row.providerId))
    .map((row) => {
      const on = chartSite === row.providerId ? ' is-on' : ''
      return `<button class="monitor-chip ${seriesClassOf(row.providerId)}${on}" data-chart-site="${esc(row.providerId)}" title="${t('只看这个站')}">
        <span class="dot"></span>${esc(row.name)}
      </button>`
    })
    .join('')
  const chips = allChip + siteChips

  // 悬停所需的上下文（序列 + 站点名 + 配色）挂在卡片上，避免事件处理器再算一遍
  const chartCtx = {
    days: (data.balanceSeries || []).map((d) => d.day),
    balance: (data.balanceSeries || []).map((d) => {
      if (chartSite === 'ALL') return typeof d.total === 'number' ? d.total : null
      const raw = d.perProvider?.[chartSite]
      return typeof raw === 'number' ? raw * rateCny() : null
    }),
    spend: (data.spendSeries || []).map((d) => d.byProvider || {}),
    total: (data.spendSeries || []).map((d) => d.cny || 0),
    site: chartSite,
    names: Object.fromEntries((data.balanceByProvider || []).map((r) => [r.providerId, r.name])),
    providers: chartProviders,
    colors: Object.fromEntries(chartProviders.map((pid) => [pid, seriesColorOf(pid)])),
  }
  const chartCard = `
    <div class="card monitor-chart-card" data-chart-ctx="${esc(JSON.stringify(chartCtx))}">
      <div class="card-head">
        <h3>余额概览</h3>
        ${seg}
      </div>
      ${chart
        ? `<div class="chart-wrap">${chart}<div class="chart-tip" id="chart-tip" role="tooltip"></div></div>`
        : '<div class="empty small"><p>还没有同步到余额。点右上角「立即同步」跑一轮。</p></div>'}
      <div class="chart-legend">
        <span><i class="legend-line"></i>${chartSite === 'ALL'
          ? t('余额合计（{sym}，其他币种按汇率折算）', { sym: priceSym() })
          : t('该站余额（{sym}）', { sym: priceSym() })}</span>
        <span><i class="legend-bar"></i>${chartSite === 'ALL' ? t('各站花费（堆叠）') : t('该站每日花费')}</span>
      </div>
      <div class="monitor-chips">${chips}</div>
    </div>`

  // ---------------------------------------------------------- 倍率变动
  const changeRows = (data.changes || [])
    .slice(0, 12)
    .map((row) => {
      const dir = typeof row.pct === 'number' ? (row.pct > 0 ? 'up' : row.pct < 0 ? 'down' : 'flat') : 'flat'
      const label = typeof row.pct === 'number' ? `${row.pct > 0 ? '+' : ''}${row.pct}%` : '—'
      return `<div class="monitor-flow-row">
        <div class="monitor-flow-top">
          <span class="monitor-flow-key">${esc(row.key)}</span>
          <span class="badge ${dir === 'up' ? 'danger' : dir === 'down' ? 'ok' : ''}">${label}</span>
        </div>
        <div class="monitor-flow-meta">
          <span>${esc(row.providerName || '')}</span>
          <span>${money(row.from)} → ${money(row.to)}</span>
          <span>${agoText(row.at)}</span>
        </div>
      </div>`
    })
    .join('')

  const changesCard = `
    <div class="card monitor-flow-card">
      <div class="card-head">
        <h3>最近倍率变动</h3>
        <span class="hint">${t('{n} 条', { n: (data.changes || []).length })}</span>
      </div>
      ${changeRows || '<div class="empty small"><p>还没有变动。第一次同步只记基线，之后才开始比较。</p></div>'}
    </div>`

  // ------------------------------------------------------------ 站点卡
  // 版式照 upstream-ops 的渠道卡：头行（站名 + 类型 + 时间/外链）、三格统计、
  // 两格「阈值·状态 / 上次同步」、分组 chips、底部动作按钮。
  const siteCards = (data.balanceByProvider || [])
    .map((row) => {
      const prov = (state.providers || []).find((p) => p.id === row.providerId) || {}
      const kindLabel = ID_PROVIDER_KIND[prov.kind]
      const badge = balanceBadge(row.balance, row.threshold)
      const currency = row.currency || 'CNY'
      const balanceText = row.balance === null ? '—' : `${esc(currency)} ${money(row.balance)}`
      const thresholdText = row.threshold === null ? t('未设阈值') : `${esc(currency)} ${money(row.threshold)}`
      const groups = row.groups || []
      // 变动流只有分组名 + 倍率，没有模型归属 → 厂商不可知，不猜；
      // 倍率 0 的分组就是免费池，用免费色（与站点卡「免费 N」标记一致）
      const groupChips = groups
        .slice(0, 6)
        .map((g) => `<span class="group-chip static ${g.rate === 0 ? 'vchip-free' : ''}">${esc(g.name)}${typeof g.rate === 'number' ? ` <span class="ratio-tone ${ratioToneClass(g.rate)}">×${g.rate}</span>` : ''}</span>`)
        .join('')
      const more = groups.length > 6
        ? `<span class="hint">${t('还有 {n} 个', { n: groups.length - 6 })}</span>`
        : ''
      return `<div class="monitor-site">
        <div class="prov-head">
          <div class="prov-id">
            <b>${esc(row.name)}</b>
            ${kindLabel ? `<span class="badge">${esc(kindLabel)}</span>` : ''}
          </div>
          <div class="prov-head-right">
            ${prov.baseUrl ? `<a class="icon-btn" href="${esc(prov.baseUrl)}" target="_blank" rel="noreferrer" title="${t('打开站点')}">${icon('external')}</a>` : ''}
          </div>
        </div>
        <div class="prov-tiles">
          <div><span class="k">${t('余额')}</span><b>${balanceText}</b></div>
          <div><span class="k">${t('模型价')}</span><b>${row.modelCount === null ? '—' : row.modelCount}</b></div>
          <div><span class="k">${t('分组')}</span><b>${groups.length}</b></div>
        </div>
        <div class="prov-tiles prov-tiles--2">
          <div><span class="k">${t('阈值 · 状态')}</span><b><span>${thresholdText}</span>${badge}</b></div>
          <div><span class="k">${t('上次同步')}</span><b>${agoText(row.at)}</b></div>
        </div>
        <div class="monitor-site-groups">${groupChips || `<span class="hint">${t('还没读到分组倍率')}</span>`}${more}</div>
        <div class="prov-actions">
          <button data-monitor-provider="${esc(row.providerId)}">${icon('refresh')} ${t('同步这个站')}</button>
          ${prov.baseUrl ? `<a class="link-btn" href="${esc(prov.baseUrl)}" target="_blank" rel="noreferrer">${icon('external')} ${t('打开站点')}</a>` : ''}
        </div>
      </div>`
    })
    .join('')

  // 同步设置不单独占一行，挂在「站点余额与分组」的卡片头上——
  // 它和下面那排站点卡是同一件事：改完间隔/阈值，顺手就在这儿点「立即同步」。
  const syncPanel = syncPanelHtml(data)
  const syncActions = syncActionsHtml()

  const sitesCard = `
    <div class="sites-section">
      <div class="monitor-sites" id="monitor-sites-host"></div>
    </div>`

  // -------------------------------------------------------- 告警 / 公告
  // 两栏等高、各自内部滚动：公告动辄几百字，摊在页面流里会把下面所有卡片顶到几屏之外。
  const allAlerts = data.alerts || []
  const allAnnouncements = data.announcements || []

  const alertsCard = `
    <div class="card monitor-feed-card">
      <div class="card-head">
        <h3>告警动态</h3>
        <div class="monitor-head-actions">
          <span class="hint">${t('{n} 条未读', { n: kpi.unreadAlerts ?? 0 })}</span>
          <button class="ghost tiny" data-act="monitor-read-alerts">全部已读</button>
        </div>
      </div>
      <div class="monitor-feed-scroll">
        ${allAlerts.length
          ? allAlerts.map(feedAlertRow).join('')
          : '<div class="empty small"><p>还没有告警。余额低于阈值、倍率变化、同步失败都会记在这里。</p></div>'}
      </div>
    </div>`

  // 公告按站点分组：顶部一排站点胶囊，下面只显示这一家的公告
  const noticeGroups = []
  for (const row of allAnnouncements) {
    let group = noticeGroups.find((item) => item.id === row.providerId)
    if (!group) {
      group = { id: row.providerId, name: row.providerName || row.providerId, rows: [], unread: 0 }
      noticeGroups.push(group)
    }
    group.rows.push(row)
    if (!row.readAt) group.unread += 1
  }
  if (noticeSite !== 'all' && !noticeGroups.some((group) => group.id === noticeSite)) noticeSite = 'all'

  const noticeTabs = [
    `<button class="monitor-notice-tab" data-act="monitor-notice-site" data-site="all" aria-pressed="${noticeSite === 'all'}">${t('全部站点')}（${allAnnouncements.length}）</button>`,
    ...noticeGroups.map(
      (group) =>
        `<button class="monitor-notice-tab" data-act="monitor-notice-site" data-site="${esc(group.id)}" aria-pressed="${noticeSite === group.id}">${esc(group.name)}（${group.rows.length}）</button>`,
    ),
  ].join('')

  const shownGroups = noticeSite === 'all' ? noticeGroups : noticeGroups.filter((group) => group.id === noticeSite)
  const shownUnread = shownGroups.reduce((sum, group) => sum + group.unread, 0)
  const noticeRows = shownGroups
    .map(
      (group) => `
        <div class="monitor-feed-group">
          <span>${esc(group.name)}</span>
          <span class="hint">${t('{n} 条', { n: group.rows.length })}${group.unread ? ` · ${t('{n} 条未读', { n: group.unread })}` : ''}</span>
        </div>
        ${group.rows.map(feedAnnouncementRow).join('')}`,
    )
    .join('')

  const announcementsCard = `
    <div class="card monitor-feed-card">
      <div class="card-head">
        <h3>上游公告</h3>
        <div class="monitor-head-actions">
          <span class="hint">${t('{n} 条未读', { n: shownUnread })}</span>
          <button class="ghost tiny" data-act="monitor-read-announcements">全部已读</button>
        </div>
      </div>
      ${noticeGroups.length ? `<div class="monitor-notice-tabs">${noticeTabs}</div>` : ''}
      <div class="monitor-feed-scroll">
        ${noticeRows || '<div class="empty small"><p>还没有读到公告。多数站点是公共接口，加了站点就会自动拉。</p></div>'}
      </div>
    </div>`

  // ---------------------------------------------------------- 同步记录
  const runRows = (data.runs || [])
    .map(
      (run) => `<tr>
        <td>${agoText(run.at)}</td>
        <td>${esc(run.providerName || '')}</td>
        <td class="num">${run.ms}ms</td>
        <td>${run.ok ? '<span class="badge ok">成功</span>' : `<span class="badge danger">失败</span> <span class="hint">${esc(run.error || '')}</span>`}</td>
      </tr>`,
    )
    .join('')

  // 同步设置不单独占一行，挂在「站点余额与分组」的卡片头上——
  // 它和下面那排站点卡是同一件事：改完间隔/阈值，顺手就在这儿点「立即同步」。

  const runsCard = runRows
    ? `<div class="card">
        <div class="card-head"><h3>同步记录</h3><span class="hint">最近 ${data.runs.length} 次</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>时间</th><th>站点</th><th class="num">耗时</th><th>结果</th></tr></thead>
          <tbody>${runRows}</tbody>
        </table></div>
        <p class="hint">
          同步只读站点公开/后台数据，不打真实对话请求，所以可以比探针勤。
          余额要走站点后台接口，需要先在「站点」页填「令牌」。
        </p>
      </div>`
    : ''

  setPageSubFor(
    'monitor',
    data.kpi?.lastRunAt ? t('上次同步 {ago}', { ago: agoText(data.kpi.lastRunAt) }) : '还没有同步过',
  )
  view.innerHTML = `
    ${kpiHtml}
    <div class="monitor-cols">${chartCard}${changesCard}</div>
    ${sitesCard}
    <div class="monitor-cols monitor-cols--feed">${alertsCard}${announcementsCard}</div>
    ${runsCard}`

  // 站点卡与「添加站点」表单复用站点页的那一套，避免两处各写一份
  const sitesHost = $('#monitor-sites-host')
  if (sitesHost) sitesHost.innerHTML = providersHtml({ withForm: false, panel: syncPanel, actions: syncActions })
  bindSiteSearch()
}

async function loadMonitor(days = monitorDays) {
  if (monitorLoading) return
  monitorLoading = true
  try {
    monitorData = await api('GET', `/api/monitor?days=${days}`)
    monitorDays = Number(days) || 7
  } catch (error) {
    toast(error.message, true)
  } finally {
    monitorLoading = false
  }
  renderMonitor()
  translateDom($('#view-monitor') || document.body)
}

// ------------------------------------------------------------------ 事件

/** 按钮级 busy 包装：只禁用 + 加转圈样式，不动节点内容。
 *  此前保存/恢复 textContent——API 报错时不走 render，SVG 图标和
 *  chips 里的 span 结构会被拍平成纯文本且不再自愈 */
async function withBusy(button, fn) {
  if (button) {
    button.disabled = true
    button.classList.add('is-busy')
  }
  try {
    await fn()
  } catch (error) {
    toast(error.message, true)
  } finally {
    if (button) {
      button.disabled = false
      button.classList.remove('is-busy')
    }
  }
}

/**
 * 联系方式 —— 开源前把 value 改成你自己的。
 * type: github / blog / qq / email / link
 * qq 和 email 点击是复制，其余点击是打开链接。value 留空则该项不显示。
 */
const CONTACTS = [
  { type: 'github', label: 'GitHub', value: 'https://github.com/ZYH1207/ManageAPI', desc: '源码与更新' },
  { type: 'blog', label: '博客', value: 'https://zyh1207.github.io/', desc: '使用笔记与踩坑记录' },
  { type: 'qq', label: 'QQ 群', value: '361801207', desc: '问题交流' },
  { type: 'email', label: '邮箱', value: '2385377554@qq.com', desc: '合作与反馈' },
]

const CONTACT_ICONS = {
  github:
    '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>',
  blog:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  qq:
    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  email:
    '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  link:
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
}

function renderContacts() {
  const grid = $('#contact-grid')
  if (!grid) return
  const items = CONTACTS.filter((c) => c.value && String(c.value).trim())
  if (items.length === 0) {
    grid.innerHTML = `<p class="contact-empty">还没有配置联系方式。开源前在 <code>web/app.js</code> 顶部的 <code>CONTACTS</code> 里填上你的 GitHub / 博客 / QQ 群。</p>`
    return
  }
  grid.innerHTML = items
    .map((c) => {
      const copyable = c.type === 'qq' || c.type === 'email'
      return `
      <div class="contact-card" role="button" tabindex="0" data-act="${copyable ? 'copy-contact' : 'open-contact'}" data-value="${esc(c.value)}">
        <span class="contact-icon"><svg viewBox="0 0 24 24">${CONTACT_ICONS[c.type] || CONTACT_ICONS.link}</svg></span>
        <span class="contact-text">
          <b>${esc(c.label)}</b>
          <span>${esc(c.desc || c.value)}</span>
        </span>
      </div>`
    })
    .join('')
  translateDom(grid)
}

// ------------------------------------------------------------- 主题与折叠

const THEME_KEY = 'manageapi.theme'
const SIDEBAR_KEY = 'manageapi.sidebarCollapsed'

;(function initAppearance() {
  try {
    const forced = new URLSearchParams(location.search).get('theme')
    if (forced === 'dark') {
      document.documentElement.dataset.theme = 'dark'
    } else if (forced === 'light') {
      document.documentElement.removeAttribute('data-theme')
    } else {
      const saved = localStorage.getItem(THEME_KEY)
      if (saved === 'dark' || (!saved && matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.dataset.theme = 'dark'
      }
    }
    const collapsedParam = new URLSearchParams(location.search).get('collapsed') === '1'
    if (collapsedParam || localStorage.getItem(SIDEBAR_KEY) === '1') {
      document.querySelector('.sidebar')?.classList.add('collapsed')
    }
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
})()

const TABS = ['overview', 'monitor', 'free', 'pricing', 'decision', 'probes', 'gateway', 'usage', 'benchmark']

/** 折叠状态：'provider:xxx' / 'pricing:模型名' / 'probe:站点id' */
const collapsedPanels = new Set()

/** 站点卡的搜索与分页（站点多了以后一屏放不下） */
let siteQuery = ''
let sitePage = 1
const SITE_PAGE_SIZE = 9

/** 站点卡一次露出几个分组胶囊（其余折成「还有 N 个」） */
const GROUP_CHIP_LIMIT = 6

/** 哪几个站点卡已经被点开了全部分组（存 providerId）；不落库，刷新页面即复位 */
const openGroupChips = new Set()

/** 免费页当前栏：'relay'（中转站免费模型）| 'platform'（平台积分） */
let freePane = 'relay'

/** 平台侧「手动添加」表单是否展开 */
let platformFormOpen = false

/** 正在等待授权的平台：{ platformId, authUrl, startedAt, elapsedMs, reason } */
let platformConnectPending = null
/** 取消标记：点「取消」后让轮询循环自己退出 */
let connectCancelled = false

/** 搜索框内容 */
const filters = { pricing: '', decision: '', benchmark: '' }

const TAB_META = {
  overview: { title: '概览', sub: '当前状态一眼看完' },
  monitor: { title: '站点', sub: '余额趋势、倍率变动与站点管理' },
  free: { title: '免费', sub: '免费额度与平台积分，不参与付费比价' },
  pricing: { title: '比价', sub: '同一模型跨站对比' },
  decision: { title: '智能决策', sub: '候选排序与手动调整' },
  probes: { title: '探针', sub: '指纹 / 截断 / 计费 / 缓存' },
  gateway: { title: '网关', sub: '一个入口接管全部流量' },
  usage: { title: '用量', sub: '按 Key / 模型 / 站点统计' },
  benchmark: { title: '基准价', sub: '倍率换算的参照物' },
}

function setPageSub(text) {
  const el = $('#page-sub')
  if (el) el.textContent = text || ''
}

/**
 * 只有当前页才能改顶栏副标题。
 * render() 会把所有页面重画一遍，如果各页都无条件 setPageSub，
 * 最后跑的那个（用量页）会抢走别人的副标题。
 */
function setPageSubFor(tab, text) {
  if (activeTab === tab) setPageSub(text)
}

function setTab(name) {
  // 支持二级 hash：#free/relay、#free/platform
  const [tabPart, panePart] = String(name || '').split('/')
  if (tabPart === 'free' && ['relay', 'platform'].includes(panePart)) freePane = panePart
  name = tabPart === 'providers' ? 'monitor' : tabPart // 旧书签 #providers 落到合并后的站点页

  // 「使用说明」不在侧边栏里，但 #help 要能直接打开（弹窗里那个「在新页面打开」链接）
  if (name === 'help') {
    activeTab = 'help'
    document.querySelectorAll('#nav button').forEach((b) => b.classList.remove('active'))
    for (const tabName of TABS) {
      const el = $(`#view-${tabName}`)
      if (el) el.hidden = true
    }
    const help = $('#view-help')
    if (help) help.hidden = false
    const titleEl = $('#page-title')
    if (titleEl) titleEl.textContent = '使用说明'
    setPageSub('这个工具怎么用、为什么这么设计')
    translateDom($('.topbar-left') || document.body)
    if (location.hash !== '#help') history.replaceState(null, '', '#help')
    return
  }

  if (!TABS.includes(name)) name = 'overview'
  activeTab = name
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name))
  for (const tabName of TABS) {
    const el = $(`#view-${tabName}`)
    if (el) el.hidden = tabName !== name
  }
  // 从 #help 点回侧边栏时要顺手把说明页收掉，否则它会一直盖在上面
  const helpView = $('#view-help')
  if (helpView) helpView.hidden = true
  const meta = TAB_META[name]
  const titleEl = $('#page-title')
  if (titleEl) titleEl.textContent = meta.title
  setPageSub(meta.sub)
  translateDom($('.topbar-left') || document.body)
  const nextHash = name === 'free' ? `#free/${freePane}` : `#${name}`
  if (location.hash !== nextHash) history.replaceState(null, '', nextHash)
  // 初始化时 render() 早于 setTab()，那时 freePane 还是默认值；
  // 从 URL 直接打开 #free/platform 需要在这里补一次重绘。
  if (name === 'free') {
    renderFree()
    // 重绘发生在 render() 的 translateDom 之后，得自己补一次翻译
    translateDom($('#view-free') || document.body)
  }
  // 监控数据比 state 重，按需拉：第一次进这个页才请求
  if (name === 'monitor' && !monitorData) void loadMonitor(monitorDays)
}

// 浏览器前进/后退只改 hash，不会触发任何渲染——没有这条监听，地址变了页面不动
window.addEventListener('hashchange', () => {
  const next = location.hash.replace('#', '') || 'providers'
  if (next !== activeTab && next !== `free/${freePane}`) setTab(next)
})

// 概览图悬停：移入命中区显示当天明细，移出隐藏。
// 用 mousemove 而不是 click —— 图表信息是「扫过去看」的，不该要求点击
document.addEventListener('mousemove', (event) => {
  const hit = event.target.closest?.('[data-chart-day]')
  const tip = document.getElementById('chart-tip')
  if (hit) {
    showChartTip(hit)
    return
  }
  if (tip?.classList.contains('is-on')) {
    // 移出图表范围才隐藏；在卡片内移动（比如滑到图例上）保持显示
    if (!event.target.closest?.('.chart-wrap')) tip.classList.remove('is-on')
  }
})

// 点语言菜单以外的地方收起它
document.addEventListener('click', (event) => {
  const menu = $('#lang-menu')
  if (!menu || menu.hidden) return
  if (event.target.closest('.lang-wrap')) return
  closeLangMenu()
})

// 点通知面板以外的地方收起它
document.addEventListener('click', (event) => {
  const panel = $('#notify-panel')
  if (!panel || panel.hidden) return
  if (event.target.closest('.notify-wrap')) return
  panel.hidden = true
})

document.addEventListener('keydown', (event) => {
  // 探针行与联系卡是 div/tr 挂 data-act，键盘进不去——Tab 聚焦后 Enter/空格等效点击
  if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLElement) {
    const activatable = event.target.closest?.('[data-act][tabindex="0"], .contact-card[role="button"]')
    if (activatable) {
      event.preventDefault()
      activatable.click()
      return
    }
  }
  if (event.key !== 'Escape') return
  closeLangMenu()
  for (const id of ['help-modal', 'contact-modal', 'group-modal', 'pf-accounts-modal', 'add-provider-modal', 'prov-modal', 'login-modal']) {
    const modal = document.getElementById(id)
    if (modal && !modal.hidden) modal.hidden = true
  }
  // 动态创建的诊断弹窗与通知面板也一并收起
  document.getElementById('diagnose-box')?.remove()
  const notify = $('#notify-panel')
  if (notify && !notify.hidden) notify.hidden = true
  // 分组模型抽屉也是悬浮层，Esc 一并收
  closeGroupModels()
})

document.addEventListener('click', async (event) => {
  if (event.target.closest('#lang-btn')) {
    const wrap = document.querySelector('.lang-wrap')
    const menu = $('#lang-menu')
    if (!wrap || !menu) return
    menu.hidden = !menu.hidden
    wrap.classList.toggle('open', !menu.hidden)
    return
  }
  if (event.target.closest('[data-act="set-lang"]')) {
    setLang(event.target.closest('[data-act="set-lang"]').dataset.lang)
    closeLangMenu()
    return
  }
  if (event.target.closest('#theme-btn')) {
    const root = document.documentElement
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
    if (next === 'dark') root.dataset.theme = 'dark'
    else root.removeAttribute('data-theme')
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      /* 忽略 */
    }
    paintThemeButton()
    return
  }
  if (event.target.closest('[data-act="toggle-sidebar"]')) {
    const sidebar = document.querySelector('.sidebar')
    if (!sidebar) return
    sidebar.classList.toggle('collapsed')
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebar.classList.contains('collapsed') ? '1' : '0')
    } catch {
      /* 忽略 */
    }
    paintSidebarButton()
    return
  }

  if (event.target.closest('#notify-btn')) {
    const panel = $('#notify-panel')
    if (!panel) return
    panel.hidden = !panel.hidden
    if (!panel.hidden) {
      // 打开即视为已读：红点消失，列表项淡化但保留
      const ids = loadReadIds()
      for (const n of buildNotifications()) ids.add(n.id)
      saveReadIds(ids)
      renderNotifications()
    }
    return
  }
  if (event.target.closest('[data-act="mark-read"]')) {
    const ids = loadReadIds()
    for (const n of buildNotifications()) ids.add(n.id)
    saveReadIds(ids)
    renderNotifications()
    return
  }

  if (event.target.closest('[data-act="show-contact"]')) {
    renderContacts()
    const modal = $('#contact-modal')
    if (modal) modal.hidden = false
    return
  }
  if (event.target.closest('[data-act="close-contact"]')) {
    const modal = $('#contact-modal')
    if (modal) modal.hidden = true
    return
  }
  const contactCard = event.target.closest('.contact-card')
  if (contactCard) {
    const value = contactCard.dataset.value || ''
    if (contactCard.dataset.act === 'copy-contact') {
      try {
        await navigator.clipboard.writeText(value)
        toast('已复制到剪贴板')
      } catch {
        toast(`复制失败，手动复制：${value}`, true)
      }
    } else if (/^https?:\/\//i.test(value)) {
      window.open(value, '_blank', 'noopener,noreferrer')
    } else if (value) {
      try {
        await navigator.clipboard.writeText(value)
        toast('已复制到剪贴板')
      } catch {
        toast(`复制失败，手动复制：${value}`, true)
      }
    }
    return
  }

  if (event.target.closest('[data-act="show-help"]')) {
    openHelpModal()
    return
  }
  if (event.target.closest('[data-act="close-help"]')) {
    const modal = $('#help-modal')
    if (modal) modal.hidden = true
    return
  }
  const tocItem = event.target.closest('.toc-item')
  if (tocItem) {
    const el = document.getElementById(tocItem.dataset.target)
    const content = $('#help-content')
    if (el && content) {
      const top = el.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop
      content.scrollTo({ top: Math.max(top - 14, 0), behavior: 'smooth' })
      document.querySelectorAll('.toc-item').forEach((b) => b.classList.toggle('active', b === tocItem))
    }
    return
  }

  const goto = event.target.closest('[data-goto]')
  if (goto) {
    setTab(goto.dataset.goto)
    return
  }

  // 花费卡的时间段切换：三个区间后端一次算好，这里只重渲染，不重新拉数据
  const spendRangeBtn = event.target.closest('[data-spend-range]')
  if (spendRangeBtn) {
    const next = spendRangeBtn.dataset.spendRange
    if (next && next !== spendRange) {
      spendRange = next
      renderMonitor()
      translateDom($('#view-monitor') || document.body)
    }
    return
  }

  const monitorDaysBtn = event.target.closest('[data-monitor-days]')
  if (monitorDaysBtn) {
    const days = Number(monitorDaysBtn.dataset.monitorDays)
    if (days === monitorDays && monitorData) return
    await withBusy(monitorDaysBtn, async () => {
      await loadMonitor(days)
    })
    return
  }

  // 站点卡分页
  const sitePageBtn = event.target.closest('[data-act="site-page"]')
  if (sitePageBtn) {
    sitePage = Number(sitePageBtn.dataset.page) || 1
    refreshSiteCards()
    return
  }

  // 「新增站点」：弹窗里填（原来滚到底部表单，13 张卡之后要翻很久才找得到）
  if (event.target.closest('[data-act="add-provider"]')) {
    openAddProvider()
    return
  }
  if (event.target.closest('[data-act="close-add-provider"]')) {
    closeAddProvider()
    return
  }
  const provPanelBtn = event.target.closest('[data-act="prov-panel"]')
  if (provPanelBtn) {
    openProvPanel(provPanelBtn, provPanelBtn.dataset.panel === 'rates' ? 'rates' : 'keys')
    return
  }

  if (event.target.closest('[data-act="close-prov-panel"]')) {
    closeProvPanel()
    return
  }

  // 概览图的站点选择：单选，'ALL' 看总体，选站只看该站
  const chartSiteBtn = event.target.closest('[data-chart-site]')
  if (chartSiteBtn) {
    const next = chartSiteBtn.dataset.chartSite
    if (next && next !== chartSite) {
      chartSite = next
      renderMonitor()
      translateDom($('#view-monitor') || document.body)
    }
    return
  }

  // 概览图悬停：显示当天余额 + 各站花费明细
  const chartHit = event.target.closest?.('[data-chart-day]')
  if (chartHit) {
    showChartTip(chartHit)
    return
  }

  // 「只采这个站」：顶部 chips 和站点卡都挂着这个属性
  const monitorProviderBtn = event.target.closest('[data-monitor-provider]')
  if (monitorProviderBtn) {
    const providerId = monitorProviderBtn.dataset.monitorProvider
    await withBusy(monitorProviderBtn, async () => {
      const res = await api('POST', '/api/monitor/collect', { providerId, days: monitorDays })
      monitorData = res
      renderMonitor()
      translateDom($('#view-monitor') || document.body)
      toast('这个站采完了')
    })
    return
  }

  const rangeBtn = event.target.closest('[data-range]')
  if (rangeBtn) {
    const days = Number(rangeBtn.dataset.range)
    if (days === usageRange && usageData) return
    await withBusy(rangeBtn, async () => {
      const res = await api('GET', `/api/usage?days=${days}`)
      usageData = res.usage
      usageRange = days
      renderUsage()
      // renderUsage 内部不走 t()，英文界面下靠这层 DOM 翻译兜底
      translateDom($('#view-usage') || document.body)
    })
    return
  }

  const tab = event.target.closest('[data-tab]')
  if (tab) {
    setTab(tab.dataset.tab)
    return
  }

  const actionButton = event.target.closest('[data-act]')
  if (!actionButton) return
  const action = actionButton.dataset.act
  const card = actionButton.closest('[data-provider]')
  const providerId = card?.dataset.provider

  if (action === 'overview-issues-toggle') {
    overviewIssuesOpen = !overviewIssuesOpen
    renderOverview()
    // renderOverview 内部不走 t()，英文界面下靠这层 DOM 翻译兜底
    translateDom($('#view-overview') || document.body)
    return
  }

  if (action === 'open-group-models') {
    // data-group 可能是空串（「未指定分组」那颗胶囊），所以取不到时默认为空串，
    // 不能用 falsy 判断「没有分组」
    const target = actionButton.dataset.provider || providerId
    if (!target) return
    openGroupModels(target, actionButton.dataset.group || '')
    return
  }

  if (action === 'close-group-models') {
    closeGroupModels()
    return
  }

  if (action === 'toggle-group-chips') {
    // 只重画站点卡，不重新拉数据：这是纯展示的展开/收起，不该触发一次网络请求
    const target = actionButton.dataset.provider || providerId
    if (!target) return
    if (openGroupChips.has(target)) openGroupChips.delete(target)
    else openGroupChips.add(target)
    refreshSiteCards()
    return
  }

  if (action === 'monitor-collect') {
    await withBusy(actionButton, async () => {
      const res = await api('POST', '/api/monitor/collect', { days: monitorDays })
      monitorData = res
      renderMonitor()
      translateDom($('#view-monitor') || document.body)
      const failed = (res.results || []).filter((row) => !row.ok)
      if (failed.length > 0) toast(t('同步完成，{n} 个站有问题：{error}', { n: failed.length, error: failed[0].error }), true)
      else toast('同步完成')
    })
    return
  }

  if (action === 'monitor-read-alerts' || action === 'monitor-read-announcements') {
    const path = action === 'monitor-read-alerts' ? '/api/monitor/alerts/read' : '/api/monitor/announcements/read'
    await withBusy(actionButton, async () => {
      monitorData = await api('POST', path, {})
      renderMonitor()
      translateDom($('#view-monitor') || document.body)
      toast('已全部标记为已读')
    })
    return
  }

  if (action === 'monitor-notice-site') {
    noticeSite = actionButton.dataset.site || 'all'
    renderMonitor()
    translateDom($('#view-monitor') || document.body)
    return
  }

  // 首字门槛刻度条：点任意一档直接生效（0 = 不限）
  if (action === 'set-ttft') {
    const ms = Number(actionButton.dataset.ms) || 0
    try {
      state = await api('PATCH', '/api/settings', { maxTtftMs: ms })
      render()
      toast(ms > 0 ? `首字超过 ${state.ttftLimitText} 按「慢速」排除` : '已取消首字门槛：不限')
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (action === 'fx-refresh') {
    try {
      const result = await api('POST', '/api/fx/refresh', {})
      if (result?.ok) {
        state = await api('GET', '/api/state')
        render()
        toast(t('汇率已更新：1 美元 ≈ {rate} 元', { rate: money(result.fx.rates.CNY) }))
      } else {
        toast(t(result?.hint || '汇率没更新'), true)
      }
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (action === 'fx-auto') {
    try {
      state = await api('PATCH', '/api/settings', { fxAuto: true })
      render()
      toast(t('已恢复自动汇率，下一轮会去拉取'))
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (action === 'set-currency') {
    const next = actionButton.dataset.cur === 'CNY' ? 'CNY' : 'USD'
    if ((state.settings.displayCurrency || 'USD') === next) return
    try {
      state = await api('PATCH', '/api/settings', { displayCurrency: next })
      render()
      paintCurrencySwitch()
      toast(t('显示币种已切换'))
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (action === 'monitor-save-settings') {
    const interval = Number($('#monitor-interval')?.value ?? 30)
    const warnInput = $('#monitor-warn')
    // 阈值输入框可能不在页面上（设置面板收起来了），此时不要用默认值覆盖用户设置
    const patch = { monitorIntervalMinutes: interval }
    if (warnInput) patch.balanceWarnUsd = Number(warnInput.value || 0)
    // 默认站点单价：空串表示「按市场汇率」，要显式传 null 才能清掉
    const unitInput = $('#monitor-unit-price')
    if (unitInput) patch.defaultUnitPrice = unitInput.value === '' ? null : Number(unitInput.value)
    await withBusy(actionButton, async () => {
      state = await api('PATCH', '/api/settings', patch)
      await loadMonitor(monitorDays)
      render()
      toast('已保存')
    })
    return
  }

  if (action === 'platform-add') {
    platformFormOpen = true
    renderFree()
    translateDom($('#view-free') || document.body)
    $('#pf-label')?.focus()
    return
  }

  if (action === 'platform-cancel') {
    platformFormOpen = false
    renderFree()
    translateDom($('#view-free') || document.body)
    return
  }

  if (action === 'platform-save') {
    const presetOpt = $('#pf-preset')?.selectedOptions?.[0]
    const presetId = presetOpt?.value || ''
    const connectorId = presetOpt?.dataset?.connector || 'manual'
    const label = ($('#pf-label')?.value || presetOpt?.dataset?.label || '').trim()
    if (!label) {
      toast('先选一个平台或填个名称', true)
      $('#pf-label')?.focus()
      return
    }
    const limitRaw = $('#pf-limit')?.value ?? ''
    const limit = limitRaw === '' ? null : Number(limitRaw)
    const unit = $('#pf-unit')?.value || 'credit'
    const window = $('#pf-window')?.value || 'day'
    await withBusy(actionButton, async () => {
      try {
        // 先建平台，再挂一个账号——额度挂在账号上，一个平台可以多个账号。
        // 但自动连接的平台不手填额度：它的额度是登录后从平台读的，
        // 先塞一个「剩余 100」进去，就会变成「没连上也显示有积分」。
        let result = await api('POST', '/api/free/platforms', { connectorId, label, presetId })
        const platformId = result.platformResult?.id
        const manualQuota = connectorId === 'manual' && limit !== null && Number.isFinite(limit)
        if (platformId && manualQuota) {
          result = await api('POST', '/api/free/accounts', {
            platformId,
            label: '主账号',
            quota: { unit, limit, used: 0, window },
          })
        }
        state = result
        platformFormOpen = false
        render()
        toast(`已添加「${label}」`)
        if (connectorId !== 'manual' && limit !== null) {
          toast('这个平台支持自动连接，额度等连上后从平台读', true)
        }
      } catch (error) {
        toast(error.message, true)
      }
    })
    return
  }

  if (action === 'platform-checkin') {
    const platformId = actionButton.dataset.platform
    const platform = state.freePool?.platforms?.find((p) => p.id === platformId)
    const accountId = platform?.activeAccountId || platform?.accounts?.[0]?.id
    if (!accountId) {
      toast('这个平台还没有账号', true)
      return
    }
    await withBusy(actionButton, async () => {
      try {
        const result = await api('POST', `/api/free/accounts/${accountId}/checkin`, {})
        state = result
        render()
        const r = result.checkinResult
        if (r?.alreadyToday) toast('今天已经签过了')
        else if (r?.ok) toast(r.reward ? `签到成功，+${r.reward}` : '签到成功')
        else toast(r?.message || '签到失败', true)
      } catch (error) {
        toast(error.message, true)
      }
    })
    return
  }

  if (action === 'platform-refresh') {
    const platformId = actionButton.dataset.platform
    await withBusy(actionButton, async () => {
      try {
        // 有连接器的平台去平台拉一次余额；手动平台只是重读本地状态
        const result = platformId
          ? await api('POST', `/api/free/platforms/${platformId}/refresh`, {})
          : await api('GET', '/api/state')
        state = result
        render()
        // 多账号时可能部分失败：成功的照旧显示新数字，失败的要让人看见是哪把钥匙
        const failed = (result.refreshResult?.results || []).filter((row) => !row.ok)
        if (failed.length) toast(`有 ${failed.length} 个账号没刷到：${failed[0].error}`, true)
        else toast('已刷新')
      } catch (error) {
        toast(error.message, true)
      }
    })
    return
  }

  if (action === 'platform-connect') {
    const platformId = actionButton.dataset.platform
    if (!platformId) {
      toast('先添加一个平台', true)
      return
    }
    await withBusy(actionButton, () => connectPlatform(platformId))
    return
  }

  if (action === 'platform-diagnose') {
    const platformId = actionButton.dataset.platform
    await withBusy(actionButton, async () => {
      try {
        const result = await api('POST', `/api/free/platforms/${platformId}/diagnose`, {})
        const text = JSON.stringify(result.diagnose, null, 2)
        // 诊断信息是给人看的（发给开发者定位字段），复制比弹窗实用
        try {
          await navigator.clipboard.writeText(text)
          toast('诊断信息已复制，发给开发者就能定位')
        } catch {
          // 剪贴板不可用时的兜底：弹一个只读文本框让用户自己复制，
          // 不要把可能含站点信息的原文打到控制台
          showDiagnoseBox(text)
          toast('已打开诊断信息，手动复制一下')
        }
      } catch (error) {
        toast(error.message, true)
      }
    })
    return
  }

  if (action === 'platform-connect-reopen') {
    if (platformConnectPending?.authUrl) {
      window.open(platformConnectPending.authUrl, '_blank', 'noopener,noreferrer')
      toast('已重新打开授权页')
    }
    return
  }

  if (action === 'platform-connect-cancel') {
    // 让轮询循环下一轮自己退出，不在这里硬清状态——否则 waitForConnect 收尾时会重复 toast
    connectCancelled = true
    toast('已取消等待')
    return
  }

  if (action === 'add-preset-platform') {
    const presetId = actionButton.dataset.preset
    const preset = state.catalog?.platforms?.find((p) => p.id === presetId)
    if (!preset) return
    const wantsConnect = actionButton.dataset.connect === '1'
    await withBusy(actionButton, async () => {
      try {
        const result = await api('POST', '/api/free/platforms', {
          connectorId: preset.connectorId,
          label: preset.label,
          presetId: preset.id,
        })
        state = result
        render()
        toast(`已添加「${preset.label}」`)
        // 「添加并连接」：建完直接走授权，省一次点击
        if (wantsConnect && preset.connectorId !== 'manual') {
          const platformId = result.platformResult?.id
          if (platformId) await connectPlatform(platformId)
        }
      } catch (error) {
        toast(error.message, true)
      }
    })
    return
  }

  if (action === 'platform-accounts') {
    openPfAccounts(actionButton.dataset.platform)
    return
  }

  if (action === 'close-pf-accounts') {
    closePfAccounts()
    return
  }

  if (action === 'platform-delete') {
    const platformId = actionButton.dataset.platform
    const platform = (state?.freePool?.platforms || []).find((p) => p.id === platformId)
    const name = platform?.label || platform?.connectorId || '这个平台'
    if (!confirm(`删除「${name}」？它的账号和额度流水会一起删掉。`)) return
    await withBusy(actionButton, async () => {
      try {
        state = await api('DELETE', `/api/free/platforms/${platformId}`)
        render()
        toast('已删除')
      } catch (error) {
        toast(error.message, true)
      }
    })
    return
  }

  if (action === 'pf-account-delete') {
    const accountId = actionButton.dataset.account
    if (!confirm('删除这个账号？它的额度流水会一起删掉。')) return
    await withBusy(actionButton, async () => {
      try {
        state = await api('DELETE', `/api/free/accounts/${accountId}`)
        render()
        renderPfAccounts()
        toast('已删除')
      } catch (error) {
        toast(error.message, true)
      }
    })
    return
  }

  if (action === 'free-pane') {
    const pane = actionButton.dataset.pane
    if (pane && pane !== freePane) {
      freePane = pane
      render()
      const nextHash = `#free/${freePane}`
      if (location.hash !== nextHash) history.replaceState(null, '', nextHash)
    }
    return
  }

  // 一键同步：同步模型 → 读余额 →（有令牌时）识别分组，串着跑完再刷新
  if (event.target.closest('[data-act="prov-sync-all"]')) {
    const btn = event.target.closest('[data-act="prov-sync-all"]')
    const card = btn.closest('.prov-card')
    const providerId = card?.dataset.provider
    const hasToken = card?.dataset.hasToken === '1'
    if (!providerId) return
    const failed = []
    await withBusy(btn, async () => {
      try {
        await api('POST', `/api/providers/${providerId}/sync`, {})
      } catch (error) {
        failed.push(`同步：${error.message}`)
      }
      try {
        await api('POST', `/api/providers/${providerId}/balance`, {})
      } catch (error) {
        failed.push(`余额：${error.message}`)
      }
      if (hasToken) {
        try {
          await api('POST', `/api/providers/${providerId}/detect-groups`, {})
        } catch (error) {
          failed.push(`分组：${error.message}`)
        }
      }
      state = await api('GET', '/api/state')
      render()
    })
    toast(failed.length ? `部分完成：${failed.join('；')}` : '已同步', failed.length > 0)
    return
  }

  if (action === 'export') {
    const includeKey = confirm('导出内容会包含完整 API Key，确认？\n\n取消则导出脱敏版本。')
    try {
      // 取明文 Key 要额外带一个自定义头：跨站请求想伪造这个头必须先过 CORS 预检，
      // 而本服务不返回 CORS 头，预检必然失败——等于给「网页偷 Key」加了道门。
      const data = await api(
        'GET',
        `/api/export/config?providerId=${encodeURIComponent(providerId)}&includeKey=${includeKey ? 1 : 0}`,
        null,
        includeKey ? { 'x-manage-api-intent': 'reveal-secret' } : null,
      )
      await navigator.clipboard.writeText(data.envBlock)
      toast('配置已复制到剪贴板')
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (action === 'del-provider') {
    if (!confirm(`删除「${providerName(providerId)}」及其所有 Key、模型记录？`)) return
    await withBusy(actionButton, async () => {
      state = await api('DELETE', `/api/providers/${providerId}`)
      render()
      toast('已删除')
    })
    return
  }

  if (action === 'prov-toggle-pause') {
    const providerId = actionButton.dataset.provider
    const provider = (state.providers || []).find((p) => p.id === providerId)
    const next = !provider?.paused
    await withBusy(actionButton, async () => {
      try {
        state = await api('PATCH', `/api/providers/${providerId}`, { paused: next })
        render()
        toast(next
          ? `「${provider?.name || '站点'}」已暂停：不进比价、决策、探针和同步，随时可恢复`
          : `「${provider?.name || '站点'}」已恢复`)
      } catch (error) {
        toast(error.message, true)
      }
    })
    return
  }

  if (action === 'del-key') {
    const credentialId = actionButton.closest('[data-credential]').dataset.credential
    if (!confirm('删除这个 Key？')) return
    await withBusy(actionButton, async () => {
      state = await api('DELETE', `/api/credentials/${credentialId}`)
      render()
      toast('Key 已删除')
    })
    return
  }

  if (action === 'del-benchmark') {
    const key = actionButton.closest('[data-benchmark]').dataset.benchmark
    if (!confirm(`删除基准价「${key}」？`)) return
    await withBusy(actionButton, async () => {
      state = await api('DELETE', `/api/benchmarks/${encodeURIComponent(key)}`)
      render()
      toast('已删除')
    })
    return
  }

  if (action === 'offer-mode') {
    const offerId = actionButton.closest('[data-offer]').dataset.offer
    const mode = actionButton.dataset.mode === 'ratio' ? 'ratio' : 'manual'
    await withBusy(actionButton, async () => {
      // PATCH 的返回值就是完整 state，直接用它重绘
      state = await api('PATCH', `/api/offers/${offerId}`, { pricingMode: mode })
      render()
      toast(mode === 'ratio' ? '已切成「按倍率」：价格 = 基准价 × 倍率' : '已切成「按价格」：直接填输入/输出单价')
    })
    return
  }

  if (action === 'dup-offer') {
    const offerId = actionButton.closest('[data-offer]').dataset.offer
    const name = prompt(
      '新分组名（例如：Pro 号池 / 特价池）。\n\n' +
        '用途：同一个模型在另一档套餐里也有时，给它复制一条单独记价，比价时和原分组并列看。\n' +
        '注意：这样建出来的分组没有对应 Key；不想要了在「站点 → 分组倍率」里删掉它。',
    )
    if (!name || !name.trim()) return
    await withBusy(actionButton, async () => {
      state = await api('POST', `/api/offers/${offerId}/duplicate`, { group: name.trim() })
      render()
      toast(`已创建分组「${name.trim()}」，记得填它的价格`)
    })
    return
  }

  if (action === 'del-group') {
    // 比价表的按钮带 data-provider（那一行不在站点卡片里），卡片里的从祖先上取
    const providerId =
      actionButton.dataset.provider || actionButton.closest('[data-provider]')?.dataset.provider
    const group = actionButton.dataset.group || ''
    if (!providerId || !group) return
    const keys = state.credentials.filter(
      (c) => c.providerId === providerId && (c.group || '') === group,
    )
    // 模型数用台账全量（与卡片上「N 个模型」、抽屉里的清单同口径）。
    // 用 filtered state.offers 数的话，忽略了一大堆模型的站会出现「只删 1 个」而实际删掉几十条。
    const listed = state.modelsByGroup?.[providerId]?.[group]
    const rowCount = Array.isArray(listed)
      ? listed.length
      : state.offers.filter((o) => o.providerId === providerId && (o.group || '') === group).length
    // 两种来源后果不同，确认框里必须分开说清楚，不然用户不知道 Key 会不会被带走
    const question = keys.length
      ? `删除分组「${group}」？\n\n· 这个分组下的 ${rowCount} 个模型记录会被删掉\n· 挂在它上面的 Key（${keys
          .map((k) => k.label)
          .join('、')}）保留，只清掉分组归属\n· 之后在那把 Key 那行点「选分组」重新导入，模型和倍率会一起回来`
      : `删除分组「${group}」？\n\n· 这个分组下的 ${rowCount} 个模型记录会被删掉\n· 这个分组没有挂着 Key（多半是比价页「＋」复制出来的），删掉就没了`
    if (!confirm(question)) return
    await withBusy(actionButton, async () => {
      const result = await api('POST', `/api/providers/${providerId}/delete-group`, { group })
      state = result
      render()
      const r = result.groupDeleteResult
      const kept = r.keys.length ? `；Key ${r.keys.join('、')} 保留` : ''
      toast(`分组「${r.group}」已删除：${r.removedOffers} 个模型记录一并删掉${kept}`)
    })
    return
  }

  if (action === 'move-up' || action === 'move-down') {
    const row = actionButton.closest('[data-offer]')
    const container = actionButton.closest('[data-model]')
    if (!row || !container) return
    const modelKey = container.dataset.model
    const offerId = row.dataset.offer
    const decision = state.decisions.find((d) => d.modelKey === modelKey)
    if (!decision) return

    // 只在「可用」的候选之间调换，不可信的不参与
    const ids = decision.candidates.filter((c) => c.routable).map((c) => c.offerId)
    const index = ids.indexOf(offerId)
    const target = action === 'move-up' ? index - 1 : index + 1
    if (index === -1 || target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]

    try {
      state = await api('PUT', `/api/decisions/${encodeURIComponent(modelKey)}/order`, { order: ids })
      render()
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (action === 'reset-order') {
    const container = actionButton.closest('[data-model]')
    const modelKey = container?.dataset.model
    if (!modelKey) return
    try {
      state = await api('PUT', `/api/decisions/${encodeURIComponent(modelKey)}/order`, { order: [] })
      render()
      toast('已恢复自动排序')
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (action === 'toggle-panel') {
    const key = actionButton.dataset.panel
    if (!key) return
    if (collapsedPanels.has(key)) collapsedPanels.delete(key)
    else collapsedPanels.add(key)
    render()
    return
  }

  if (action === 'bench-show-all') {
    benchShowAll = !benchShowAll
    renderBenchmark()
    translateDom($('#view-benchmark') || document.body)
    return
  }

  if (action === 'open-login') {
    const providerId = actionButton.closest('[data-provider]')?.dataset.provider
    if (providerId) openLoginModal(providerId)
    return
  }

  if (action === 'close-login') {
    closeLoginModal()
    return
  }

  if (action === 'usage-check') {
    const providerId = actionButton.closest('[data-provider]').dataset.provider
    await withBusy(actionButton, async () => {
      let failure = ''
      try {
        const result = await api('POST', `/api/providers/${providerId}/usage-check`, {})
        usageCheckResults[providerId] = result
      } catch (error) {
        // 失败也要把弹窗开出来，否则用户点了就是「什么都没发生」
        usageCheckResults[providerId] = { error: error.message, estimate: {}, raw: null }
        failure = error.message
      }
      render()
      const card = document.querySelector(`.prov-card[data-provider="${providerId}"]`)
      if (card) openProvPanel(card, 'usage')
      toast(failure ? `没拉到站方数据：${failure}` : '已拉取站方数据', Boolean(failure))
    })
    return
  }

  if (action === 'open-group-picker') {
    const providerId = actionButton.closest('[data-provider]').dataset.provider
    // 从 Key 那一行点进来的，就认准那把 Key；从卡片按钮点进来的没有 credentialId，
    // 后端会回落到第一把——但改的仍是「第一把」，不会波及别的 Key。
    const credentialId = actionButton.closest('[data-credential]')?.dataset.credential || null
    await openGroupPicker(providerId, credentialId)
    return
  }

  if (action === 'apply-group') {
    await applyPickedGroup(actionButton)
    return
  }

  if (action === 'retry-groups') {
    await openGroupPicker(groupPicker.providerId, groupPicker.credentialId, { fresh: true })
    return
  }

  if (action === 'close-group-modal') {
    const modal = $('#group-modal')
    if (modal) modal.hidden = true
    return
  }

  if (action === 'pick-group') {
    groupPicker.selected = actionButton.dataset.pickGroup || ''
    markSelectedGroup()
    return
  }

  if (action === 'restore-ratio' || action === 'restore-ratio-all') {
    const providerId = actionButton.closest('[data-provider]').dataset.provider
    const body = action === 'restore-ratio' ? { group: actionButton.dataset.group ?? '' } : {}
    await withBusy(actionButton, async () => {
      try {
        const result = await api('POST', `/api/providers/${providerId}/restore-ratio`, body)
        state = result
        render()
        const r = result.restoreResult
        const parts = [`${r.restored} 个模型已恢复为站点倍率`]
        if (r.noSiteValue?.length) parts.push(`${r.noSiteValue.length} 个没有站点值，需要重新导入`)
        toast(parts.join('，'))
      } catch (error) {
        toast(error.message, true)
      }
    })
    return
  }

  if (action === 'set-admin-token') {
    const providerId = actionButton.dataset.provider || actionButton.closest('[data-provider]')?.dataset.provider
    if (!providerId) return
    const value = prompt(
      '粘贴站点后台的登录令牌（浏览器 F12 → Network → 任意 /api/v1/ 请求 → Request Headers 里的 Authorization 值，去掉 Bearer 前缀）\n\n一个后台账号填一次，整站通用。留空表示清除。',
      '',
    )
    if (value === null) return
    try {
      state = await api('PATCH', `/api/providers/${providerId}`, { adminToken: value.trim() || null })
      render()
      toast(value.trim() ? '令牌已保存，点「读余额」试试' : '令牌已清除')
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (action === 'refresh-state') {
    await refreshState()
    toast(t('已刷新'))
    return
  }

  if (action === 'toggle-autorefresh') {
    setAutoRefresh(!autoRefresh)
    toast(autoRefresh ? t('自动刷新已打开（15 秒）') : t('自动刷新已关闭'))
    return
  }

  if (action === 'ignored-models') {
    openIgnoredModels()
    return
  }

  if (action === 'mark-free') {
    const offerId = actionButton.dataset.offer
    await withBusy(actionButton, async () => {
      try {
        // 免费池的判据是「实际价 = 0」，不是分组名里带「免费」两个字。
        // 价格留空是 null（没填），和 0 不是一回事，所以这里显式写 0。
        const result = await api('PATCH', `/api/offers/${offerId}`, {
          pricingMode: 'manual',
          ratio: null,
          inPrice: 0,
          outPrice: 0,
          currency: 'CNY',
        })
        state = result
        render()
        toast('已标为免费，去「免费」页看看')
      } catch (error) {
        toast(error.message, true)
      }
    })
    return
  }

  if (action === 'toggle-detail') {
    const row = actionButton.closest('[data-offer]')
    const offerId = row?.dataset.offer
    const detail = offerId ? document.querySelector(`[data-detail-for="${offerId}"]`) : null
    if (detail) detail.hidden = !detail.hidden
    return
  }

  if (action === 'probe') {
    const offerId = actionButton.closest('[data-offer]').dataset.offer
    toast('正在探测，需要几秒到几十秒…')
    await withBusy(actionButton, async () => {
      const result = await api('POST', '/api/probes/run', { offerId, limit: 1 })
      state = result
      render()
      const probe = result.probeResults[0]
      if (!probe) return
      if (!probe.ok) {
        toast(`探测失败：${probe.error}`, true)
        return
      }
      const issues = []
      if (probe.fingerprintOk === false) issues.push('指纹异常')
      if (probe.truncated === true) issues.push('输出被截断')
      if (probe.billingInflated === true) issues.push('用量虚报')
      toast(issues.length ? `探测完成：${issues.join('、')}` : '探测完成：一切正常', issues.length > 0)
    })
    return
  }

  if (action === 'probe-all') {
    toast('正在探测，需要几秒到几十秒…')
    await withBusy(actionButton, async () => {
      const result = await api('POST', '/api/probes/run', { limit: 5 })
      state = result
      render()
      const okCount = result.probeResults.filter((r) => r.ok).length
      toast(`探测 ${result.probeResults.length} 个，成功 ${okCount}`)
    })
    return
  }

  if (action === 'copy-base') {
    await navigator.clipboard.writeText(`${location.origin}/v1`)
    toast('网关地址已复制')
    return
  }

  if (action === 'copy-gwkey') {
    const id = actionButton.closest('[data-gwkey]').dataset.gwkey
    const record = state.gateway.keys.find((k) => k.id === id)
    if (record) {
      await navigator.clipboard.writeText(record.key)
      toast(`已复制「${record.name}」的 Key`)
    }
    return
  }

  if (action === 'copy-new-gwkey') {
    if (lastCreatedGatewayKey) {
      await navigator.clipboard.writeText(lastCreatedGatewayKey.key)
      toast('已复制新 Key')
    }
    return
  }

  if (action === 'dismiss-new-gwkey') {
    lastCreatedGatewayKey = null
    render()
    return
  }

  if (action === 'rotate-gwkey') {
    const id = actionButton.closest('[data-gwkey]').dataset.gwkey
    const record = state.gateway.keys.find((k) => k.id === id)
    if (!confirm(`轮换「${record?.name || ''}」的 Key？旧 Key 立即失效。`)) return
    await withBusy(actionButton, async () => {
      state = await api('POST', `/api/gateway/keys/${id}/rotate`, {})
      lastCreatedGatewayKey = state.gateway.keys.find((k) => k.id === id) || null
      render()
      toast('已轮换，记得更新客户端配置')
    })
    return
  }

  if (action === 'toggle-gwkey') {
    const id = actionButton.closest('[data-gwkey]').dataset.gwkey
    const record = state.gateway.keys.find((k) => k.id === id)
    if (!record) return
    const next = !record.enabled
    await withBusy(actionButton, async () => {
      state = await api('PATCH', `/api/gateway/keys/${id}`, { enabled: next })
      render()
      toast(next ? '已启用' : '已停用')
    })
    return
  }

  if (action === 'del-gwkey') {
    const id = actionButton.closest('[data-gwkey]').dataset.gwkey
    const record = state.gateway.keys.find((k) => k.id === id)
    if (!confirm(`删除 Key「${record?.name || ''}」？使用它的客户端会立即失效。`)) return
    await withBusy(actionButton, async () => {
      state = await api('DELETE', `/api/gateway/keys/${id}`)
      render()
      toast('已删除')
    })
    return
  }

  if (action === 'toggle-gateway') {
    const next = !state.gateway.enabled
    await withBusy(actionButton, async () => {
      state = await api('PATCH', '/api/gateway', { enabled: next })
      render()
      toast(next ? '网关已开启' : '网关已关闭')
    })
    return
  }
})

document.addEventListener('submit', async (event) => {
  const loginForm = event.target.closest('#form-login')
  if (loginForm) {
    event.preventDefault()
    const submitBtn = loginForm.querySelector('button[type="submit"]')
    if (submitBtn?.disabled) return
    if (submitBtn) submitBtn.disabled = true
    const providerId = loginForm.dataset.provider
    const data = Object.fromEntries(new FormData(loginForm))
    const doLogin = (confirmUnknown = false) =>
      api('POST', `/api/providers/${providerId}/login`, {
        user: data.user,
        password: data.password,
        ...(confirmUnknown ? { confirmUnknown: true } : {}),
      })
    try {
      let result
      try {
        result = await doLogin(false)
      } catch (error) {
        // 系别识别不出：登录会向站点发一次错误协议的失败登录，先让用户确认
        if (error.data?.needConfirm && confirm(error.message)) {
          result = await doLogin(true)
        } else {
          throw error
        }
      }
      state = result
      closeLoginModal()
      render()
      // 系别在登录内部就探测过了（detectProviderKind），这里直接报结果——
      // 卡片上的系别徽章同时会更新，不需要单独的「识别系别」按钮
      const kind = state.loginResult?.kind
      const kindLabel = ID_PROVIDER_KIND[kind]?.label || (kind === 'unknown' ? '未知系别' : String(kind || '未知系别'))
      const via = state.loginResult?.via === 'sub2api' ? 'Sub2API' : 'OneAPI/NewAPI'
      toast(`登录成功 · 识别为 ${kindLabel}（${via} 协议），令牌已自动获取并开始续期`)
    } catch (error) {
      toast(error.message, true)
      if (submitBtn) submitBtn.disabled = false
    }
    return
  }

  const gwForm = event.target.closest('[data-form="add-gwkey"]')
  if (gwForm) {
    event.preventDefault()
    // 提交期间禁用：双击会连建两把 Key
    const submitBtn = gwForm.querySelector('button[type="submit"], button:not([type])')
    if (submitBtn?.disabled) return
    if (submitBtn) submitBtn.disabled = true
    const data = Object.fromEntries(new FormData(gwForm))
    try {
      state = await api('POST', '/api/gateway/keys', {
        name: data.name,
        monthlyTokenLimit: data.monthlyTokenLimit === '' ? null : Number(data.monthlyTokenLimit),
      })
      lastCreatedGatewayKey = state.gateway.keys[state.gateway.keys.length - 1] || null
      render()
      toast('Key 已创建')
    } catch (error) {
      toast(error.message, true)
      if (submitBtn) submitBtn.disabled = false
    }
    return
  }

  const form = event.target.closest('[data-form="add-key"]')
  if (!form) return
  event.preventDefault()
  const keySubmitBtn = form.querySelector('button[type="submit"], button:not([type])')
  if (keySubmitBtn?.disabled) return
  if (keySubmitBtn) keySubmitBtn.disabled = true
  const providerId = form.closest('[data-provider]').dataset.provider
  const data = Object.fromEntries(new FormData(form))
  try {
    state = await api('POST', '/api/credentials', { ...data, providerId })
    render()
    toast('Key 已加密保存')
  } catch (error) {
    toast(error.message, true)
    if (keySubmitBtn) keySubmitBtn.disabled = false
  }
})

// 搜索框：只重渲染当前页，然后恢复焦点与光标
// ---------------------------------------------------------------- 拖拽排序
// 只认卡片右上那颗「名次」作为把手：整卡可拖会让选文字、点按钮都变别扭。
let dragProviderId = null

function clearDropMarks() {
  document
    .querySelectorAll('.prov-card.drop-before, .prov-card.drop-after, .prov-card.dragging, .drop-zone.active')
    .forEach((node) => node.classList.remove('drop-before', 'drop-after', 'dragging', 'active'))
}

document.addEventListener('dragstart', (event) => {
  const handle = event.target.closest?.('.prov-pri')
  if (!handle) return
  const card = handle.closest('.prov-card')
  if (!card) return
  dragProviderId = handle.dataset.provider
  card.classList.add('dragging')
  // 分页时只有当前页的卡片在 DOM 里，拖不到别的页——给两个「放到最前 / 最后」的落点
  document.body.classList.add('prov-dragging')
  event.dataTransfer.effectAllowed = 'move'
  // Firefox 必须 setData 才会真的开始拖
  event.dataTransfer.setData('text/plain', dragProviderId)
})

document.addEventListener('dragover', (event) => {
  if (!dragProviderId) return
  const zone = event.target.closest?.('.drop-zone')
  if (zone) {
    event.preventDefault()
    zone.classList.add('active')
    return
  }
  document.querySelectorAll('.drop-zone.active').forEach((node) => node.classList.remove('active'))
  // 拖动时靠边自动滚动：列表在 .content 里滚，浏览器的原生自动滚动不认它，
  // 不自己滚的话第二页的卡片永远拖不到第一页。
  const scroller = document.querySelector('.content')
  if (scroller) {
    const box = scroller.getBoundingClientRect()
    const edge = 72
    if (event.clientY < box.top + edge) scroller.scrollTop -= 18
    else if (event.clientY > box.bottom - edge) scroller.scrollTop += 18
  }
  const card = event.target.closest?.('.prov-card')
  if (!card) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  const rect = card.getBoundingClientRect()
  const after = event.clientY > rect.top + rect.height / 2
  clearDropMarks()
  document.querySelector(`.prov-pri[data-provider="${dragProviderId}"]`)?.closest('.prov-card')?.classList.add('dragging')
  card.classList.add(after ? 'drop-after' : 'drop-before')
})

document.addEventListener('drop', async (event) => {
  if (!dragProviderId) return
  const zone = event.target.closest?.('.drop-zone')
  if (zone) {
    event.preventDefault()
    const dragged = dragProviderId
    clearDropMarks()
    dragProviderId = null
    document.body.classList.remove('prov-dragging')
    // 「上一页」= 挪到上一页的最后一格；「下一页」= 挪到下一页的第一格
    const totalPages = Math.max(1, Math.ceil((state.providers || []).length / SITE_PAGE_SIZE))
    const toPrev = zone.dataset.drop === 'prev'
    if (toPrev && sitePage <= 1) {
      toast('已经是第一页了，没有上一页可以放', true)
      return
    }
    if (!toPrev && sitePage >= totalPages) {
      toast('已经是最后一页了，没有下一页可以放', true)
      return
    }
    const order = (state.providers || []).map((p) => p.id).filter((id) => id !== dragged)
    const targetIndex = toPrev
      ? Math.max(0, (sitePage - 1) * SITE_PAGE_SIZE - 1)
      : Math.min(order.length, sitePage * SITE_PAGE_SIZE)
    order.splice(targetIndex, 0, dragged)
    await persistOrder(order, dragged)
    return
  }
  const card = event.target.closest?.('.prov-card')
  if (!card) return
  event.preventDefault()
  const targetId = card.querySelector('.prov-pri')?.dataset.provider
  const dragged = dragProviderId
  const after = card.classList.contains('drop-after')
  clearDropMarks()
  dragProviderId = null
  document.body.classList.remove('prov-dragging')
  if (!targetId || targetId === dragged) return

  const order = (state.providers || []).map((p) => p.id).filter((id) => id !== dragged)
  const at = order.indexOf(targetId)
  order.splice(after ? at + 1 : at, 0, dragged)
  await persistOrder(order, dragged)
})

document.addEventListener('dragend', () => {
  dragProviderId = null
  document.body.classList.remove('prov-dragging')
  clearDropMarks()
})

/** 落位后统一提交顺序：只在对话框/序列结束后调一次接口，避免中间态 */
async function persistOrder(order, dragged) {
  try {
    state = await api('POST', '/api/providers/reorder', { ids: order })
    // 落在哪一页就翻到哪一页，否则跨页拖完看起来像「没生效」
    sitePage = Math.floor(order.indexOf(dragged) / SITE_PAGE_SIZE) + 1
    render()
    const name = (state.providers || []).find((p) => p.id === dragged)?.name || '站点'
    toast(`「${name}」已移到第 ${order.indexOf(dragged) + 1} 位`)
  } catch (error) {
    toast(error.message, true)
  }
}

document.addEventListener('click', (event) => {
  const fold = event.target.closest?.('[data-ig-fold]')
  if (!fold) return
  const key = fold.dataset.igFold
  const children = document.querySelector(`[data-ig-children="${CSS.escape(key)}"]`)
  if (!children) return
  const folded = !children.hidden
  children.hidden = folded
  fold.classList.toggle('is-collapsed', folded)
  if (folded) igCollapsed.add(key)
  else igCollapsed.delete(key)
}, true)

document.addEventListener('change', async (event) => {
  // 分组选择弹窗的 radio：键盘（Tab + 方向键）也能选——radio 此前 tabindex=-1，
  // 键盘完全无法选择分组
  if (event.target.matches?.('input[name="pick-group"]')) {
    groupPicker.selected = event.target.value
    markSelectedGroup()
    return
  }
  const group = event.target.closest?.('[data-ig-group]')
  if (group) {
    await toggleVendorGroup(group.dataset.igGroup, group.checked)
    return
  }
  const box = event.target.closest?.('[data-ig]')
  if (!box) return
  await toggleIgnoredModel(box.dataset.ig, box.checked)
})

// 中文输入法组合期间（拼音候选框弹出）不触发搜索重绘——每键重建 DOM
// 会打断组合输入，拼音打到一半候选框就消失。组合结束时补发一次 input，
// 兜住「compositionend 后浏览器不再发 input」的顺序差异
let imeComposing = false
document.addEventListener('compositionstart', () => { imeComposing = true })
document.addEventListener('compositionend', (event) => {
  imeComposing = false
  event.target?.dispatchEvent?.(new Event('input', { bubbles: true }))
})

document.addEventListener('input', (event) => {
  if (imeComposing) return
  const id = event.target.id
  // 忽略模型弹窗里的搜索：只重画弹窗，不动页面
  if (id === 'ig-search') {
    ignoredQuery = event.target.value
    openIgnoredModels()
    const input = $('#ig-search')
    if (input) {
      input.focus()
      const len = input.value.length
      try {
        input.setSelectionRange(len, len)
      } catch {
        /* type=search 不支持选区，忽略 */
      }
    }
    return
  }
  const map = {
    'pricing-search': ['pricing', renderPricing],
    'decision-search': ['decision', renderDecision],
    'benchmark-search': ['benchmark', renderBenchmark],
  }
  const hit = map[id]
  if (!hit) return
  const [key, rerender] = hit
  filters[key] = event.target.value
  rerender()
  const el = document.getElementById(id)
  if (el) {
    el.focus()
    const len = el.value.length
    try {
      el.setSelectionRange(len, len)
    } catch {
      /* type=search 不支持选区，忽略 */
    }
  }
})

document.addEventListener('change', async (event) => {
  const input = event.target

  // 选预置平台 → 自动填名称，省掉手打
  if (input.id === 'pf-preset') {
    const opt = input.selectedOptions?.[0]
    const labelInput = $('#pf-label')
    if (labelInput && opt?.value) labelInput.value = opt.dataset.label || ''
    return
  }

  if (input.id === 'probe-interval') {
    const minutes = Number(input.value)
    try {
      state = await api('PATCH', '/api/settings', { probeIntervalMinutes: minutes })
      render()
      toast(minutes ? `自动探测已开启：每 ${minutes >= 60 ? `${minutes / 60} 小时` : `${minutes} 分钟`}` : '自动探测已关闭')
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (input.id === 'score-age') {
    const hours = Number(input.value)
    try {
      state = await api('PATCH', '/api/settings', { scoreMaxAgeHours: hours })
      render()
      toast(`评分有效期改为 ${hours} 小时`)
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (input.id === 'max-ttft') {
    // 原样发给服务端取档：20 档表只有 core/latency.js 一份，浏览器里不重算
    const raw = String(input.value || '').trim()
    const ms = raw === '' ? 0 : Number(raw)
    try {
      state = await api('PATCH', '/api/settings', { maxTtftMs: ms })
      render()
      const limit = Number(state.settings.maxTtftMs) || 0
      if (!limit) {
        toast('已取消首字门槛：不限')
      } else {
        const snapped = Number.isFinite(ms) && ms !== limit ? `（${ms}ms 按就近档位取整）` : ''
        toast(`首字超过 ${state.ttftLimitText} 按「慢速」排除${snapped}`)
      }
    } catch (error) {
      toast(error.message, true)
      render()
    }
    return
  }

  if (input.id === 'allow-untrusted') {
    try {
      state = await api('PATCH', '/api/settings', { allowUntrusted: input.checked })
      render()
      toast(input.checked ? '已放行可疑供给，它们会正常参与选站' : '已恢复：可疑供给不再登场')
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (input.dataset.act === 'free-quota-limit') {
    const offerId = input.dataset.offer
    const limit = input.value === '' ? null : Number(input.value)
    if (!offerId) return
    try {
      const current = state.freePool?.relay?.find((o) => o.id === offerId)?.freeQuota || {}
      // limit 清空 = 取消配额；否则沿用现有单位与窗口，只改上限
      const quota =
        limit === null
          ? null
          : {
              unit: current.unit || 'request',
              limit,
              used: current.used || 0,
              window: current.window || 'day',
            }
      state = await api('POST', `/api/offers/${offerId}/free-quota`, { quota })
      render()
      toast(limit === null ? '已取消这个模型的配额' : `配额上限改为 ${limit}`)
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (input.dataset.act === 'group-ratio') {
    const groupRow = input.closest('[data-group-ratio]')
    const providerId = groupRow?.closest('[data-provider]')?.dataset.provider
    if (!groupRow || !providerId) return
    const group = groupRow.dataset.groupRatio
    const ratio = input.value === '' ? null : Number(input.value)
    try {
      state = await api('POST', `/api/providers/${providerId}/group-ratio`, { group, ratio })
      const updated = state.groupRatioResult?.updated ?? 0
      render()
      const siteRatio = state.groupRatioResult?.siteRatio
      const isSite = siteRatio !== null && siteRatio !== undefined && siteRatio === ratio
      toast(
        isSite
          ? `「${group || '未指定分组'}」${updated} 个模型已更新，和站点值一致`
          : `「${group || '未指定分组'}」${updated} 个模型已改为自定义倍率${siteRatio !== null && siteRatio !== undefined ? `（站点值 ×${siteRatio}，可随时恢复）` : ''}`,
      )
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  // 站点单价：只影响「实际消费」的折算，留空回落默认（美元站=市场汇率、人民币站=1）
  if (input.dataset.act === 'unit-price') {
    const row = input.closest('[data-provider]')
    if (!row) return
    try {
      state = await api('PATCH', `/api/providers/${row.dataset.provider}`, {
        unitPrice: input.value === '' ? null : Number(input.value),
      })
      render()
      toast(input.value === '' ? '站点单价已清空（按默认汇率折算）' : '站点单价已保存')
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  const field = input.dataset.field
  if (!field) return

  const offerRow = input.closest('[data-offer]')
  if (offerRow) {
    const offerId = offerRow.dataset.offer
    const value = input.value === '' ? null : input.value
    try {
      state = await api('PATCH', `/api/offers/${offerId}`, { [field]: value })
      render()
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  const benchRow = input.closest('[data-benchmark]')
  if (benchRow) {
    const key = benchRow.dataset.benchmark
    const entry = { ...state.benchmarks[key], modelKey: key }
    entry[field] = input.value === '' ? null : input.value
    try {
      state = await api('PUT', '/api/benchmarks', entry)
      render()
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  const providerRow = input.closest('[data-provider]')
  if (providerRow) {
    const providerId = providerRow.dataset.provider
    try {
      state = await api('PATCH', `/api/providers/${providerId}`, { [field]: input.value })
      render()
      toast('权重已更新')
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  // 余额与币种是站点级的（一个后台账号一套），所以写到 provider 上而不是 Key 上
  const quotaFieldMap = { quota: 'quotaRemaining', currency: 'currency' }
  const quotaField = quotaFieldMap[input.dataset.act]
  if (quotaField) {
    const quotaRow = input.closest('[data-provider]')
    if (!quotaRow) return
    try {
      state = await api('PATCH', `/api/providers/${quotaRow.dataset.provider}`, {
        [quotaField]: input.value === '' ? null : input.value,
      })
      render()
      toast('已保存')
    } catch (error) {
      toast(error.message, true)
    }
    return
  }
})

// 汇率输入框在「基准价」页里动态渲染，所以用事件委托而不是直接绑定
document.addEventListener('change', async (event) => {
  const currency = event.target.closest('[data-act="display-currency"]')
  if (currency) {
    try {
      state = await api('PATCH', '/api/settings', { displayCurrency: currency.value })
      render()
      toast(t('显示币种已切换'))
    } catch (error) {
      toast(error.message, true)
    }
    return
  }
  const input = event.target.closest('[data-act="fx"]')
  if (!input) return
  // 清空或非正数不提交：Number('') 是 0，直接 PATCH 会把 0 存进设置
  // 并切入手动模式，界面显示与存储不一致
  if (!(Number(input.value) > 0)) return
  try {
    // 手填 = 手动模式，自动任务不再覆盖
    state = await api('PATCH', '/api/settings', { fxUsdCny: Number(input.value) })
    render()
    toast(t('汇率已更新（手动）'))
  } catch (error) {
    toast(error.message, true)
  }
})
document.addEventListener('click', async (event) => {
  if (event.target.id === 'btn-plaza-benchmark') {
    const providerId = $('#import-provider')?.value
    if (!providerId) {
      toast('先在上面选一个站点', true)
      return
    }
    await withBusy(event.target, async () => {
      try {
        const result = await api('POST', '/api/benchmarks/import-plaza', { providerId })
        state = result
        render()
        const r = result.plazaBenchResult
        const via = r.source === 'channels' ? '可用渠道' : '模型广场'
        toast(
          r.added > 0
            ? `从${via}导入 ${r.added} 条官方价${r.skipped ? `（跳过 ${r.skipped} 条：已存在或无官方价）` : ''}`
            : `没有新增（都已有基准价，或${via}没给官方价）`,
          r.added === 0,
        )
      } catch (error) {
        toast(error.message, true)
      }
    })
    return
  }

  if (event.target.id === 'btn-seed-benchmark') {
    await withBusy(event.target, async () => {
      try {
        const result = await api('POST', '/api/benchmarks/seed', {})
        state = result
        render()
        const added = result.seedResult.added.length
        toast(
          added
            ? `已载入 ${added} 条参考价，请核对后再用`
            : '没有可匹配的新模型（可能都已存在或不在内置列表里）',
          added === 0,
        )
      } catch (error) {
        toast(error.message, true)
      }
    })
    return
  }

  if (event.target.id !== 'btn-import-benchmark') return
  const providerId = $('#import-provider').value
  if (!providerId) return
  await withBusy(event.target, async () => {
    const result = await api('POST', '/api/benchmarks/import', { providerId })
    state = result
    render()
    toast(`导入 ${result.importResult.imported} 条基准价`)
  })
})

// ------------------------------------------------------------------ 启动

/** 语言按钮上的小字：显示「切过去之后」的语言 */
function paintLangButton() {
  const lang = getLang()
  const label = $('#lang-label')
  // 按钮上显示「当前」语言，和 MikuAPI 一样：中文环境写 CN ZH，英文写 us EN
  if (label) label.textContent = lang === 'zh' ? 'CN ZH' : 'us EN'
  document.documentElement.dataset.lang = lang
  for (const item of document.querySelectorAll('.lang-item')) {
    item.classList.toggle('active', item.dataset.lang === lang)
  }
}

function closeLangMenu() {
  const menu = $('#lang-menu')
  if (menu) menu.hidden = true
  document.querySelector('.lang-wrap')?.classList.remove('open')
}

/** 侧边栏底部的主题按钮：图标和文案都跟着当前主题走 */
function paintThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark'
  const label = $('#theme-label')
  if (label) label.setAttribute('data-i18n', dark ? '浅色模式' : '深色模式')
  if (label) label.textContent = t(dark ? '浅色模式' : '深色模式')
  const icon = $('#theme-icon')
  if (icon) {
    icon.innerHTML = dark
      ? '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/>'
      : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
  }
}

/** 收起按钮：收起后箭头翻转，文案跟着变 */
function paintSidebarButton() {
  const collapsed = document.querySelector('.sidebar')?.classList.contains('collapsed')
  const label = $('#sidebar-label')
  if (label) label.setAttribute('data-i18n', collapsed ? '展开' : '收起')
  if (label) label.textContent = t(collapsed ? '展开' : '收起')
}

onLangChange((lang) => {
  paintLangButton()
  // 静态外壳（侧边栏副标题、弹窗标题这些）不会重渲染，切回中文时靠还原
  if (lang === 'zh') restoreDom(document.body)
  applyShellText()
  paintThemeButton()
  paintSidebarButton()
  // 动态内容都是从中文模板重渲染出来的，重画一遍就换过来了
  render()
  setTab(activeTab === 'help' ? 'help' : activeTab)
  const helpModal = $('#help-modal')
  if (helpModal && !helpModal.hidden) openHelpModal()
  const contactModal = $('#contact-modal')
  if (contactModal && !contactModal.hidden) renderContacts()
  if (groupPicker.providerId) renderGroupModal()
})

/** 静态外壳里带 data-i18n 的文案，切回中文时靠它复位 */
function applyShellText() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.getAttribute('data-i18n'))
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')))
  }
}

try {
  state = await api('GET', '/api/state')
  paintLangButton()
  applyShellText()
  paintThemeButton()
  paintSidebarButton()
  paintAutoRefresh()
  paintCurrencySwitch()
  scheduleRefresh()
  render()
  setTab(location.hash.replace('#', '') || 'monitor')
  // ?help=1 / ?contact=1 直接打开对应面板（方便分享链接）
  const params = new URLSearchParams(location.search)
  if (params.has('contact')) {
    renderContacts()
    const modal = $('#contact-modal')
    if (modal) modal.hidden = false
  } else if (params.has('notify')) {
    const panel = $('#notify-panel')
    if (panel) panel.hidden = false
  } else if (params.has('help')) {
    openHelpModal()
  }
  if (params.has('toast')) setTimeout(() => toast('已复制到剪贴板'), 400)
} catch (error) {
  document.body.innerHTML = `<div style="padding:40px;font-family:system-ui">
    <h2 style="font-weight:500">连不上本地服务</h2>
    <p style="color:#666">${esc(error.message)}</p>
    <p style="color:#666">请确认 daemon 还在运行：<code>node daemon/index.js</code></p>
  </div>`
}
