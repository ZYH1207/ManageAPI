/** 前端：无框架，全量状态 + 重渲染。 */
import { getLang, onLangChange, restoreDom, setLang, t, translateDom } from './i18n.js'
import { renderFreeRelayPane, vendorChipClass, vendorOf, vendorLabel } from './free-relay.js'
import { renderFreePlatformPane } from './free-platform.js'
import { ensureProtocolView } from './protocol-view.js'
import { ensureProtocolRecordsView } from './protocol-records-view.js'

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
// 比价页「只显示允许放行」：纯前端过滤，本地记住开关。默认关（保持原来的全表视图）
// 决策页「只显示可使用」：同款纯前端过滤，本地记住开关。默认关（保持原来的全表视图）。
// 只改展示不改派活：网关仍按 admission.ok 派活，手动顺序也照旧整表参与
const DECISION_ONLY_ADMITTED_KEY = 'manageapi.decisionOnlyAdmitted'
let decisionOnlyAdmitted = localStorage.getItem(DECISION_ONLY_ADMITTED_KEY) === '1'
// 这两个页签要看评分/候选明细，轮询时走完整 state；其它页只要轻量那份省带宽
// （比价页已并入智能决策，见 renderDecision）
const HEAVY_TABS = new Set(['decision'])

/**
 * 价速比列：价格 ÷ 首字延迟，越小越优先（排序口径在 core/decision-mode.js#tierMetricOf，
 * 这里只负责展示）。排序按每毫秒算，展示换算成「每等 1 秒首字花多少钱」——
 * 每毫秒的比值太小会显示成 0.000，把同一比值 ×1000 后单调性不变、读起来像人话。
 * 缺价或缺首字的一律 —：不知道就是不冒充，与排序口径一致。
 * 评分过期同理：价速比是价格÷首字算出来的，首字都不作数了，它也不能拿旧数冒充。
 */
function priceSpeedText(candidate) {
  if (candidate?.status === 'stale') return '—'
  const price = Number(candidate?.price)
  const ttft = Number(candidate?.ttftMs)
  if (!Number.isFinite(price) || !Number.isFinite(ttft) || ttft <= 0) return '—'
  return `${priceText(price / ttft * 1000)}<div class="sub">/s 首字</div>`
}
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
 * 显示单位：'USD'（站内美元，与人民币 1:1）/ 'RUSD'（真实美元，按汇率折算）。
 * CNY 已退出（计费口径与站内 USD 完全相同，迁移只是改名）；
 * 换单位真的会变数：R$ 下所有价格 ÷ 汇率。只影响渲染，不参与任何比较。
 */
function displayCur() {
  return String(state?.settings?.displayCurrency || 'USD').toUpperCase() === 'RUSD' ? 'RUSD' : 'USD'
}
function priceSym() {
  return displayCur() === 'RUSD' ? 'R$' : '$'
}
/** 1 USD = ? CNY。真源是 settings.fx.rates.CNY，fxUsdCny 只是兼容镜像 */
function rateCny() {
  const fromFx = Number(state?.settings?.fx?.rates?.CNY)
  if (Number.isFinite(fromFx) && fromFx > 0) return fromFx
  const legacy = Number(state?.settings?.fxUsdCny)
  return Number.isFinite(legacy) && legacy > 0 ? legacy : 7.2
}
/** 显示值：站内美元/CNY 与人民币 1:1，同一数值只换符号；真实美元按汇率折算 */
function dispPrice(cny) {
  if (cny === null || cny === undefined || !Number.isFinite(cny)) return null
  return displayCur() === 'RUSD' ? cny / rateCny() : cny
}
/** 价格文本，例：¥0.29 或 $0.041 */
function priceText(cny) {
  const v = dispPrice(cny)
  return v === null ? '—' : `${priceSym()}${money(v)}`
}

/**
 * 站点「1 个额度单位」值多少真实人民币。
 *
 * 中转站绝大多数是 1:1 充值（充 ¥1 到账 1 单位额度），这时额度数值本身就是人民币。
 * **默认就是 1**，不按市场汇率兜底——
 * 那个兜底假设「站内美元 = 真美元」，正是余额凭空 ×6.68 的根源。
 * 真按美元扣费的国外站，把充值汇率填成市场汇率（如 6.68）。
 * 与后端 core/monitor.js 的 siteUnitPrice 同一口径。
 */
function siteUnitCny(p) {
  const own = Number(p?.unitPrice)
  if (Number.isFinite(own) && own > 0) return own
  const fallback = Number(state?.settings?.defaultUnitPrice)
  if (Number.isFinite(fallback) && fallback > 0) return fallback
  return 1
}

/**
 * 金额显示：余额这类「站点原生额度」的数值（p.quotaRemaining 是站点自己报的数）。
 * 先按站点单价折成真实人民币，再走 dispPrice 按全局显示币种出。
 *
 * 此前这里一律 × 汇率（`n * rateCny()`），把「站内美元」当成了真美元：
 * 1:1 充值的站余额 2.49 被显示成 $16.63，凭空放大 6.7 倍，阈值也跟着放大。
 * 官方的比价卡那次改动把**价格**统一成了 1:1 口径，余额这条链路漏了。
 */
function dispAmount(value, p) {
  const n = Number(value)
  if (value === null || value === undefined || !Number.isFinite(n)) return null
  return dispPrice(n * siteUnitCny(p))
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

/** 余额状态徽章：档位全站统一——探底（≤0.01）红「余额不足」且整站离场、
 *  余额 0 红、低于阈值黄（该充值）、阈值关闭（0）不亮警告。此前站点页黄、监控页红，同一状态两种解读 */
function balanceBadge(balance, threshold, depleted = false) {
  if (depleted) {
    return `<span class="badge danger" title="${esc(t('余额已探底：这个站的全部模型已离场（不进比价、决策、探针和网关，也不再撞 403）。充值后点卡片上的「余额」数字重读，自动恢复'))}">${t('余额不足')}</span>`
  }
  if (balance === null || balance === undefined) return `<span class="badge">${t('无数据')}</span>`
  if (Number(threshold) > 0 && balance <= 0) return `<span class="badge danger">${t('余额不足')}</span>`
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
 * 「站点 × 分组」→ 胶囊色（聚合判定）：组内全部免费 → 免费紫（与「免费 N」徽章同款）；
 * 忽略识别不出前缀的模型后，全国产 → 国产蓝、恰好一家海外 → 该厂色；
 * 混合厂商 → 中性灰。识别不出的模型不参与判断（不把整组拖成灰色）。
 * **同一分组在所有页面必须同色**，所以只看聚合、不看单行模型——站点卡、Key 行、
 * 比价未定价块、智能决策、路由日志都调这一份。
 *
 * 证据来自 modelsByGroup（全量台账：含被忽略的模型，去掉已下线），不是 state.offers。
 * state.offers 只含「会参与路由」的供给（inv.routeableOffers）：一个分组的模型全被
 * 忽略时它会变成空数组，胶囊就掉回中性灰，看着像这个分组坏了。分组身份是「谁家的」，
 * 不该因为忽略模型而变——和 modelsByGroup 自己的注释是同一条道理。
 *
 * 免费判定用服务端 isFreeOffer 的结果（modelsByGroup 里的 free），前端不另算一份：
 * 以前按「倍率 0 或手填双零价」近似，和「免费 N」徽章、免费池的口径会对不上。
 */
function groupChipOf(providerId, groupName) {
  const g = String(groupName || '')
  const models = state.modelsByGroup?.[providerId]?.[g]
  // 旧后端没有 modelsByGroup 时退回在役供给：口径窄，但不至于整片灰
  const rows = Array.isArray(models) && models.length
    ? models
    : (state.offers || [])
        .filter((o) => o.providerId === providerId && (o.group || '') === g)
        .map((o) => ({
          name: o.modelKey || o.upstreamName,
          free:
            o.pricingMode === 'manual'
              ? Number(o.inPrice) === 0 && Number(o.outPrice) === 0
              : Number(o.ratio) === 0,
        }))
  if (rows.length === 0) return ''
  if (rows.every((r) => r.free)) return 'vchip-free'
  const chips = new Set()
  for (const r of rows) {
    const cls = vendorChipClass(r.name)
    if (cls) chips.add(cls)
  }
  if (chips.size === 0) return ''
  if ([...chips].every((c) => c === 'vchip-cn')) return 'vchip-cn'
  if (chips.size === 1) return [...chips][0]
  return ''
}

/**
 * 模型行的币种下拉 + 手选标记。
 *
 * 币种不是纯展示：core/pricing.js 的 offerCost 按它决定要不要折汇率
 * （标 USD 就原样当美元）。所以一旦用户自己选过（currencySource:'custom'），
 * 同步就不能再改——否则数字不动、标签变了，比价直接差一个汇率。
 * 标记点一下能重新跟随站点声明。
 */
function currencyCell(offer, width = 96) {
  const custom = offer.currencySource === 'custom'
  return `
    <select data-field="currency" style="width:${width}px" title="${t('真实美元 R.Dollar：国外模型专用，按汇率换算；站内美元与人民币 1:1')}">
      <option value="USD" ${offer.currency !== 'RUSD' ? 'selected' : ''}>USD</option>
      <option value="RUSD" ${offer.currency === 'RUSD' ? 'selected' : ''}>R.Dollar</option>
    </select>
    ${custom
      ? `<button class="badge currency-custom" data-act="reset-currency" data-offer="${esc(offer.id)}" title="${t('币种是你手选的，同步不会改它。点一下恢复跟随站点声明')}">${t('手选')}</button>`
      : ''}`
}

/**
 * 比价页分组列里哪些分组该给删除键：只给「没挂任何 Key 的分组」。
 * 这种分组只可能是比价页「＋」复制出来的（duplicateOffer 建组时刻意不挂 Key，
 * 见 core/inventory.js），除了这一行没有别的删除入口；挂了 Key 的分组去「站点」页删，
 * 别在比价表里每行都摆一个垃圾桶——那排垃圾桶占地方、还容易被当成「删这一条供给」。
 * 口径和站点卡分组胶囊、del-group 的确认文案保持一致：Key 决定分组归属。
 */

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

/** 名字 → 模型身份键（后端给的表：同一模型的多种写法落到同一个键） */
function identityOf(name) {
  const raw = String(name || '').trim().toLowerCase()
  if (!raw) return ''
  return state?.modelIdentity?.[raw] || raw
}

/** 身份键 → 给人看的名字；单条模型没有合并组时就是它自己 */
function displayModel(idOrName) {
  const id = identityOf(idOrName)
  return state?.modelDisplay?.[id] || id || idOrName
}

/**
 * 把一组「模型名」按身份键合并：返回 [{ id, display, names: [...], count }]。
 * 用量、基准价这些页面本来是一行一个名字，合并后必须落到同一行，
 * 否则同一个模型在这里还是两条，和比价页对不上。
 */
function groupByModelIdentity(entries) {
  const groups = new Map()
  for (const entry of entries || []) {
    const id = identityOf(entry.name)
    if (!groups.has(id)) groups.set(id, { id, display: displayModel(id), names: [], rows: [] })
    const group = groups.get(id)
    group.names.push(entry.name)
    group.rows.push(entry)
  }
  return [...groups.values()]
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
  // 阈值与监控告警同一份（settings.balanceWarnUsd，单位是站内额度；0 = 关闭提醒），
  // 余额也是站内额度，同单位直接比——按币种乘汇率那套已去掉（1.5 会变成 10.03）
  for (const p of state.providers || []) {
    if (typeof p.quotaRemaining !== 'number') continue
    const currency = p.currency || 'CNY'
    const rawUsd = Number(state.settings?.balanceWarnUsd ?? state.settings?.balanceWarnCny)
    const warnUsd = Number.isFinite(rawUsd) && rawUsd >= 0 ? rawUsd : 10
    if (warnUsd === 0) continue
    const threshold = warnUsd
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

// 面板当前页签：'notif' = 通知，'alerts' = 告警。告警详情也在这个面板里看，
// 不再单独占页面一屏——之前告警只活在监控页第三屏，用户根本不知道它存在
let notifyTab = 'notif'

function unreadAlertCount() {
  return (monitorData?.alerts || []).filter((a) => !a.readAt).length
}

function markNotifsRead() {
  const ids = loadReadIds()
  for (const n of buildNotifications()) ids.add(n.id)
  saveReadIds(ids)
  renderNotifications()
}

// 告警「全部已读」：读状态存在服务端 db，标记后顺带拿回最新 monitor 视图
async function markAlertsReadRemote() {
  try {
    monitorData = await api('POST', '/api/monitor/alerts/read', {})
  } catch {
    /* 标不上就留着，下次再标 */
  }
  renderNotifications()
}

function paintNotifyTabs(unreadNotif, unreadAlerts) {
  for (const tab of document.querySelectorAll('.notify-tab')) {
    tab.classList.toggle('is-on', tab.dataset.notifyTab === notifyTab)
  }
  const notifCount = $('#notif-tab-count')
  if (notifCount) {
    notifCount.hidden = unreadNotif === 0
    notifCount.textContent = unreadNotif > 99 ? '99+' : String(unreadNotif)
  }
  const alertCount = $('#alert-tab-count')
  if (alertCount) {
    alertCount.hidden = unreadAlerts === 0
    alertCount.textContent = unreadAlerts > 99 ? '99+' : String(unreadAlerts)
  }
}

function renderNotifications() {
  const list = buildNotifications()
  const readIds = loadReadIds()
  const unreadNotif = list.filter((n) => !readIds.has(n.id))
  const unreadAlerts = unreadAlertCount()

  const dot = $('#notify-dot')
  if (dot) dot.hidden = unreadNotif.length === 0

  // 图标跟着未读种类变：有未读告警 → 告警标志；看过（标已读）后回到铃铛。
  // 通知未读照旧走红点，两套不互斥
  const btn = $('#notify-btn')
  if (btn) {
    btn.classList.toggle('is-alert', unreadAlerts > 0)
    const n = unreadNotif.length + unreadAlerts
    btn.title = n ? t('{n} 条未读', { n }) : t('通知')
  }

  paintNotifyTabs(unreadNotif.length, unreadAlerts)

  const container = $('#notify-list')
  if (!container) return
  if (notifyTab === 'alerts') {
    renderAlertsInPanel(container, monitorData?.alerts || [])
    return
  }
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

function renderAlertsInPanel(container, alerts) {
  if (!alerts.length) {
    container.innerHTML =
      '<div class="notify-empty">还没有告警。余额低于阈值、倍率变化、同步失败都会记在这里。</div>'
    translateDom(container)
    return
  }
  container.innerHTML = alerts
    .map(
      (a) => `
      <div class="notify-item ${a.level === 'danger' ? 'danger' : a.level === 'warn' ? 'warn' : 'info'} ${a.readAt ? 'read' : ''}">
        <span class="notify-bar"></span>
        <span class="notify-text"><b>${esc(a.title)}</b>${a.detail ? `<span>${esc(a.detail)}</span>` : ''}<span class="notify-meta">${esc(a.providerName || '')} · ${agoText(a.at)}</span></span>
      </div>`,
    )
    .join('')
  translateDom(container)
}

/**
 * 打开通知面板：告警数据在 monitor 视图里，没拉过就现拉（接口只读缓存，很轻）。
 * 默认落在有未读的那栏——图标都变成告警了，点进来就该直接看到告警。
 * 看哪栏就把哪栏标成已读，图标随之变回。
 */
async function openNotifyPanel() {
  if (!monitorData && !monitorLoading) {
    try {
      await loadMonitor()
    } catch {
      /* 拉不到也先把通知栏亮出来 */
    }
  }
  const hasUnreadAlerts = unreadAlertCount() > 0
  const hasUnreadNotifs = buildNotifications().some((n) => !loadReadIds().has(n.id))
  notifyTab = hasUnreadAlerts && !hasUnreadNotifs ? 'alerts' : 'notif'
  renderNotifications()
  if (notifyTab === 'notif') markNotifsRead()
  else void markAlertsReadRemote()
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

// --------------------------------------------------------------- 诊断系统
// v1：把错误指纹账本 + 供给表现时间序列摊开给人看；归因规则/异常判定后续逐步加。
// 数据源 /api/diagnosis/ledger，与决策日志同源，跟着真实流量自动长。

/** 诊断页当前展开的调试面板：'none'（默认收起）| 'book'（错误账本）| 'stats'（供给表现） */
let diagnosisPane = 'none'

let diagnosisData = null
/** 长期评价数据（站点/模型/分组三维聚合，按需拉取） */
let longTermData = null
/** 长期评价当前维度：'byProvider' | 'byModel' | 'byGroup' */
let longTermDim = 'byProvider'
let diagnosisHours = 48
/** 诊断引擎输出：{ findings, summary } */
let diagnosisFindings = null
/** 一键体检：正在跑 / 最近一次报告 */
let checkupRunning = false
let checkupReport = null
/** 故障处理状态（/api/faults）：截流/上报计数与最近事件 */
let faultData = null

/**
 * 故障处理卡：告诉用户「出错时系统替你挡了多少」——这是自动路由体验的底牌，
 * 不展示的话用户只会觉得「今天挺顺」，不知道背后发生了什么。
 */
function faultHtml() {
  if (!faultData) {
    return `<div class="card"><div class="notice calm"><span class="name">加载中…</span></div></div>`
  }
  const { stats = {}, config = {}, tokenReady, autoRouteTokenPresent, events = [] } = faultData
  const KIND_LABEL = {
    'stream-broken': '断流',
    'all-candidates-failed': '全部失败',
    'truncated-output': '输出截断',
    'degraded-quality': '降智',
    'thinking-stolen': '偷思考',
    slow: '变慢',
    degraded: '降质',
    'connectivity-test': '连通性测试',
  }
  const rows = events
    .slice(0, 12)
    .map(
      (e) => `
      <tr>
        <td class="mono">${esc(String(e.at).slice(5, 19).replace('T', ' '))}</td>
        <td><span class="badge ${e.status === 'sent' ? 'warn' : e.status === 'absorbed' ? 'ok' : 'danger'}">${
          e.status === 'sent' ? '已上报' : e.status === 'absorbed' ? '已截流' : e.status === 'skipped' ? '未上报' : '上报失败'
        }</span></td>
        <td>${esc(KIND_LABEL[e.kind] || e.kind || '—')}</td>
        <td class="desc" style="max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.detail || e.message || e.error || '')}">${esc(e.detail || e.message || e.error || '—')}</td>
      </tr>`,
    )
    .join('')

  // 上报通道自检：自动路由那边没生成令牌、或开关关着，都会让故障永远报不上去
  const channelOk = config.enabled && tokenReady
  return `
    <div class="card">
      <div class="card-head">
        <h3>故障处理</h3>
        <span class="meta">出错时先把错误截流，再判断该不该叫自动路由换人</span>
      </div>
      <div class="stats" style="margin:12px 0 4px">
        <div class="stat">
          <div class="stat-main"><div class="k">已截流</div><div class="v">${stats.absorbed || 0}</div></div>
          <div class="stat-icon tint-accent">${icon('swap')}</div>
        </div>
        <div class="stat">
          <div class="stat-main"><div class="k">已上报</div><div class="v">${stats.sent || 0}</div></div>
          <div class="stat-icon ${stats.sent ? 'tint-warn' : 'tint-muted'}">${icon('alert')}</div>
        </div>
        <div class="stat">
          <div class="stat-main"><div class="k">上报失败</div><div class="v">${stats.failed || 0}</div></div>
          <div class="stat-icon ${stats.failed ? 'tint-warn' : 'tint-muted'}">${icon('alert')}</div>
        </div>
        <div class="stat">
          <div class="stat-main"><div class="k">上报通道</div><div class="v" style="font-size:15px">${channelOk ? '畅通' : '未就绪'}</div></div>
          <div class="stat-icon ${channelOk ? 'tint-muted' : 'tint-warn'}">${icon('external')}</div>
        </div>
      </div>
      <p class="hint" style="margin:8px 0 12px">
        用户完全无感的失败（换站后成功）只记一笔、<b>不打扰自动路由</b>——否则它会为了无关痛痒的小问题在健康供给之间反复折腾。
        只有「真的没拿到东西」或「反复降质」才上报，让它做故障转移。
        ${!autoRouteTokenPresent ? '<br /><b>提示：</b>自动路由还没生成上报令牌，故障现在报不上去。' : ''}
      </p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="ghost tiny" data-act="fault-test">测试上报通道</button>
        <span class="desc">${esc(config.url || '')} · 开关${config.enabled ? '已开' : '已关'}</span>
      </div>
      ${
        events.length
          ? `<table class="table" style="margin-top:12px">
              <thead><tr><th>时间</th><th>处置</th><th>类型</th><th>说明</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`
          : '<p class="hint">还没有故障记录——一切正常。</p>'
      }
    </div>`
}

async function loadFaults() {
  try {
    faultData = await api('GET', '/api/faults')
  } catch {
    faultData = null
  }
}
/** 诊断结论里「被折叠的派生症状」哪几条已展开（key = `rel:<findingId>`） */
const expandedFindings = new Set()

function checkupHtml() {
  if (checkupRunning) {
    return `<div class="card"><div class="notice calm"><span class="name">正在体检…</span><span class="grow"></span><span class="desc">对每条供给跑探针 + 拉模型列表 + 读余额，大约 30 秒</span></div></div>`
  }
  const r = checkupReport
  if (!r) return ''
  const VERDICT_CLASS = { ok: 'calm', warn: 'warn', bad: 'danger' }
  const rows = (r.rows || [])
    .map(
      (x) => `
      <tr>
        <td><span class="badge ${VERDICT_CLASS[x.verdict] === 'calm' ? 'ok' : VERDICT_CLASS[x.verdict]}">${esc(x.verdictLabel || x.verdict)}</span></td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(x.label)}">${esc(x.label)}</td>
        <td class="mono">${x.ttftMs ? `${(x.ttftMs / 1000).toFixed(1)}s` : '—'}</td>
        <td class="desc" style="max-width:420px">${esc((x.reasons || []).join('；') || x.speedNote || '—')}</td>
      </tr>`,
    )
    .join('')
  return `
    <div class="card">
      <div class="card-head">
        <h3>体检报告${r.modelKey ? ` · ${esc(r.modelKey)}` : ''}</h3>
        <span class="meta">${esc(String(r.at).slice(5, 19).replace('T', ' '))} UTC · 正常 ${r.summary.ok} / 隐患 ${r.summary.warn} / 不可用 ${r.summary.bad}</span>
      </div>
      <table class="table">
        <thead><tr><th>结论</th><th>供给</th><th>首字</th><th>依据</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="desc">没有可体检的供给</td></tr>'}</tbody>
      </table>
      ${r.findings && r.findings.length ? `<div class="notice-list" style="margin-top:12px">${r.findings.map((f) => `<div class="notice ${f.severity === 'danger' ? 'danger' : 'warn'} has-detail"><span class="name">${esc(f.title)}</span><span class="grow"></span><span class="desc">${esc(f.detail || '')}</span><div class="desc" style="flex-basis:100%;margin-top:4px">→ ${esc(f.action || '')}</div></div>`).join('')}</div>` : ''}
    </div>`
}

const DIAG_KIND_LABEL = {
  quota: '余额不足',
  budget: '单次请求超限',
  'rate-limit': '上游账号冷却中',
  'model-missing': '该分组没有这个模型',
  'protocol-unsupported': '不支持该协议',
  outage: '未归类故障',
  slow: '慢速/超时',
}

async function loadDiagnosis() {
  try {
    const [ledger, findings, faults, longTerm] = await Promise.all([
      api('GET', `/api/diagnosis/ledger?hours=${diagnosisHours}`),
      api('GET', '/api/diagnosis'),
      api('GET', '/api/faults'),
      // 长期评价：聚合 30 天小时桶，失败只让这张卡空着，不影响诊断主结论
      api('GET', '/api/diagnosis/longterm').catch(() => null),
    ])
    diagnosisData = ledger
    diagnosisFindings = findings
    faultData = faults
    longTermData = longTerm
  } catch {
    diagnosisData = null
    diagnosisFindings = null
  }
  renderDiagnosis()
  // renderDiagnosis 会重写整页 innerHTML（含守卫插槽），所以要把守卫重画一遍
  renderDiagnostics()
  translateDom($('#view-diagnosis') || document.body)
}

function diagKindBadge(kind) {
  const label = DIAG_KIND_LABEL[kind] || kind || '未知'
  const cls = kind === 'outage' ? 'danger' : kind === 'quota' || kind === 'rate-limit' ? 'warn' : 'info'
  return `<span class="badge ${cls}">${esc(label)}</span>`
}

/**
 * 漂移监视卡（诊断页）：真实速度漂移的现况 + 参数 + 算法说明。
 *
 * 为什么放这儿：这一页是「系统怎么判断、现在判断成什么样」的总台账，
 * 漂移监视是自动路由的眼睛，它的阈值、冷却、试跑窗必须和它的读数放在一起，
 * 否则用户只能看到结论看不到旋钮。
 */
function driftMonitorCard() {
  const snap = state.drift
  const st = state.settings || {}
  const enabled = st.driftEnabled !== false
  const threshold = Number(st.driftThresholdPct) || 30
  const cooldown = Number(st.driftCooldownMinutes) || 10
  const trial = Number(st.driftTrialSamples) || 10
  const e = snap?.evaluation
  const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%` : '—')
  const ms = (v) => (Number.isFinite(v) ? `${(v / 1000).toFixed(1)}s` : '—')
  const verdictBadge =
    !e
      ? '<span class="badge">未判定</span>'
      : e.verdict === 'drifted'
        ? `<span class="badge warn">漂移 ${pct(e.drift)}</span>`
        : e.verdict === 'ok'
          ? `<span class="badge ok">正常 ${pct(e.drift)}</span>`
          : `<span class="badge">样本不足 ${e.samples}/5</span>`
  const demoted = Array.isArray(snap?.demoted) ? snap.demoted : []
  const offerName = (id) => {
    const o = (state.offers || []).find((x) => x.id === id)
    if (!o) return id
    const p = (state.providers || []).find((x) => x.id === o.providerId)
    return `${p ? p.name : '?'} · ${o.modelKey || o.upstreamName || '?'}`
  }
  const lastSwitch = snap?.lastSwitch
  const trialInfo = snap?.trial
    ? `<span class="desc">试跑中：${esc(offerName(snap.trial.offerId))}（已 ${snap.trial.samples} 单，攒满 ${trial} 单或 5 分钟后才判它）</span>`
    : ''
  return `
    <div class="card">
      <div class="card-head">
        <h3>漂移监视${enabled ? '' : '（已关闭）'}</h3>
        <span class="meta">真实流量算分 · 每分钟判一次 · ${verdictBadge}</span>
      </div>
      <div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px">
        <div class="stat" style="flex:1;min-width:150px">
          <div class="stat-main"><div class="k">现值总耗时</div><div class="v">${e ? ms(e.current) : '—'}</div></div>
        </div>
        <div class="stat" style="flex:1;min-width:150px">
          <div class="stat-main"><div class="k">6 小时基线</div><div class="v">${e ? ms(e.baseline) : '—'}</div></div>
        </div>
        <div class="stat" style="flex:1;min-width:150px">
          <div class="stat-main"><div class="k">首字分项</div><div class="v">${e ? pct(e.ttftDrift) : '—'}</div></div>
        </div>
        <div class="stat" style="flex:1;min-width:150px">
          <div class="stat-main"><div class="k">吐字分项</div><div class="v">${e ? pct(e.tpsDrift) : '—'}</div></div>
        </div>
      </div>
      <div class="desc" style="margin-bottom:8px">
        在岗供给：${e ? esc(offerName(e.offerId)) : '—'} · 样本 ${e?.samples ?? 0} 单（10 分钟窗口，至少 5 单才判）
        ${demoted.length ? ` · 降级 ${demoted.length} 条：${esc(demoted.map(offerName).join('、'))}` : ''}
        ${lastSwitch ? ` · 最近转移：${esc(offerName(lastSwitch.fromOfferId))} → ${esc(offerName(lastSwitch.toOfferId))}（${pct(lastSwitch.drift)}）` : ''}
        ${trialInfo}
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center">
        <label class="field-inline">漂移检测
          <select data-drift="enabled">
            <option value="1" ${enabled ? 'selected' : ''}>开启</option>
            <option value="0" ${enabled ? '' : 'selected'}>关闭</option>
          </select>
        </label>
        <label class="field-inline">阈值
          <input type="number" min="5" max="90" step="5" value="${threshold}" data-drift="threshold" style="width:64px" /> %
        </label>
        <label class="field-inline">冷却
          <input type="number" min="1" max="120" step="1" value="${cooldown}" data-drift="cooldown" style="width:64px" /> 分钟
        </label>
        <label class="field-inline">试跑窗
          <input type="number" min="1" max="100" step="1" value="${trial}" data-drift="trial" style="width:64px" /> 单
        </label>
      </div>
      <details style="margin-top:10px">
        <summary class="desc" style="cursor:pointer">算法说明（怎么算的、为什么这么定）</summary>
        <div class="desc" style="margin-top:6px;line-height:1.7">
          ① <b>现值</b>：最近 10 分钟真实请求的平均总耗时（首字 + 吐字，网关实测），至少 5 单才下结论。<br />
          ② <b>基线</b>：该供给在 offerStats 里最近 6 小时的小时桶加权均值；优先用历史桶（排除正在写入的当前桶，
          防止自己跟自己比），每天头一个小时没有历史桶时退回当前桶（只会低估漂移，不会误报）。<br />
          ③ <b>判定</b>：现值比基线慢出阈值（默认 30%）即为漂移。用总耗时而不是「成本 ÷ 耗时」——
          后者会把「吐字被抽慢但价格没变」判成「每秒更便宜 = 变好」，方向是反的。<br />
          ④ <b>动作</b>：把漂移的供给降级（本轮周期内不当「最优」），自动路由改派探针价速比最优的备选；
          冷却期内不重复转移，新现役要先过试跑窗。<br />
          ⑤ <b>逃生舱</b>：备选挨个试完仍不达标 → 踢一轮 Lite 探针刷新基础分，清空降级名单开新周期。<br />
          ⑥ <b>分项</b>：首字 / 吐字各自和基线比，只用于定位是哪半边烂，不单独触发。
        </div>
      </details>
    </div>`
}

/**
 * 长期评价卡（诊断页）：站点 / 模型 / 分组三个维度的 30 天长期表现。
 *
 * 数据全部来自 offerStats 小时桶（网关每单顺路记的账），没有额外请求。
 * 这一卡就是作者要的「站内各个站、各个模型、各个分组的长期评价」的起点：
 * 现在给的是可核对的原始指标，后续要加综合评分时从这里取数即可。
 */
function longTermCard() {
  const data = longTermData
  if (!data) {
    return `
      <div class="card">
        <div class="card-head"><h3>长期评价</h3><span class="meta">正在加载…</span></div>
      </div>`
  }
  const dim = longTermDim
  const rows = data[dim] || []
  const tabs = [
    ['byProvider', '站点'],
    ['byModel', '模型'],
    ['byGroup', '分组'],
  ]
  const pct = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—')
  const ms = (v) => (Number.isFinite(v) ? `${(v / 1000).toFixed(1)}s` : '—')
  const tps = (v) => (Number.isFinite(v) ? (v * 1000).toFixed(1) : '—')
  const body = rows.length
    ? rows
        .map(
          (r) => `
      <tr>
        <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.label)}">${esc(r.label)}</td>
        <td class="mono">${r.requests}</td>
        <td class="mono">${pct(r.okRate)}</td>
        <td class="mono">${ms(r.avgTtftMs)}</td>
        <td class="mono">${ms(r.avgLatencyMs)}</td>
        <td class="mono">${tps(r.tps)}</td>
        <td class="mono">${pct(r.cacheHitPct)}</td>
        <td class="mono">¥${r.estCostCny.toFixed(2)}</td>
        <td class="mono">${r.errors}</td>
        <td class="mono">${r.hours}</td>
        <td class="desc mono">${esc(String(r.lastHour || '').slice(5, 13).replace('-', '/').replace('T', ' '))}</td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="11" class="desc">还没有真实流量——用起来之后这里会自动积累（保留 30 天）</td></tr>'
  return `
    <div class="card">
      <div class="card-head">
        <h3>长期评价</h3>
        <span class="meta">近 30 天 · 按 ${tabs.find(([k]) => k === dim)?.[1] || '站点'} 聚合 · 来自真实流量的逐小时账本</span>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:10px">
        ${tabs
          .map(
            ([key, label]) =>
              `<button class="ghost tiny" data-act="longterm-dim" data-dim="${key}" style="${dim === key ? 'background:var(--hover);border-radius:6px' : ''}">${label}</button>`,
          )
          .join('')}
      </div>
      <table class="table">
        <thead><tr><th>${tabs.find(([k]) => k === dim)?.[1] || '对象'}</th><th>请求</th><th>成功率</th><th>首字</th><th>总耗时</th><th>吐字/s</th><th>缓存命中</th><th>费用</th><th>错误</th><th>覆盖小时</th><th>最近</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      <div class="desc" style="margin-top:8px">成功率 = 成功 / 已提交请求；总耗时与首字是真实请求实测；费用按当前报价估算（诊断级口径，非对账）。</div>
    </div>`
}

function renderDiagnosis() {
  const view = $('#view-diagnosis')
  if (!view) return
  if (!diagnosisData) {
    view.innerHTML = `
      <div class="card"><div class="notice calm"><span class="name">正在加载…</span></div></div>`
    return
  }
  const { errorbook, offerStats, totals } = diagnosisData

  // offerId → 「站点 · 模型」，给时间序列表加人话列
  const offerLabel = new Map()
  for (const o of state.offers || []) {
    const p = (state.providers || []).find((x) => x.id === o.providerId)
    offerLabel.set(o.id, `${p ? p.name : '?'} · ${o.modelKey || o.upstreamName || '?'}`)
  }

  const fmtTps = (b) =>
    b.genTimeSum > 0 && b.genOutSum > 0 ? `${(b.genOutSum / (b.genTimeSum / 1000)).toFixed(1)}` : '—'
  const fmtTtft = (b) => (b.ttftCount ? `${Math.round(b.ttftSum / b.ttftCount / 100) / 10}s` : '—')
  const fmtCache = (b) =>
    b.inputTokens > 0 ? `${Math.round((b.cachedTokens / b.inputTokens) * 100)}%` : '—'
  const fmtCost = (b) => (b.estCostCount ? `¥${b.estCostSum.toFixed(3)}` : '—')
  const fmtHour = (h) => `${h.slice(5, 10).replace('-', '/')} ${h.slice(11, 13)}时`

  // ---- 调试面板（默认收起）：错误账本 / 供给表现，给以后做准备
  const paneBtn = (pane, label, count) => `
    <button class="ghost" data-act="diagnosis-pane" data-pane="${pane}" style="${diagnosisPane === pane ? 'color:var(--text);background:var(--hover);border-radius:6px;' : ''}">
      ${label}${count !== null ? ` <small class="desc">${count}</small>` : ''}
    </button>`

  const errRows = errorbook
    .map(
      (e) => `
      <tr title="${esc(e.sample || e.template)}">
        <td>${diagKindBadge(e.kind)}</td>
        <td class="mono">${e.code ? `HTTP ${e.code}` : '—'}</td>
        <td class="mono" style="max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.template)}</td>
        <td class="mono">${e.count}</td>
        <td>${esc(Object.entries(e.providers).map(([p, c]) => `${p}×${c}`).join('、') || '—')}</td>
        <td class="mono">${esc(e.lastAt.slice(5, 19).replace('T', ' '))}</td>
      </tr>`,
    )
    .join('')

  const statRows = offerStats
    .slice(0, 60)
    .map((b) => {
      const label = offerLabel.get(b.offerId) || b.offerId
      const topErr = Object.entries(b.errors)
        .sort((a, c) => c[1] - a[1])
        .slice(0, 2)
        .map(([k, v]) => `${DIAG_KIND_LABEL[k.split('/')[0]] || k}×${v}`)
        .join('、')
      return `
      <tr>
        <td class="mono">${esc(fmtHour(b.hour))} <span class="desc">UTC</span></td>
        <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(label)}">${esc(label)}</td>
        <td class="mono">${b.requests}</td>
        <td class="mono">${b.ok}</td>
        <td class="mono">${b.broken || ''}</td>
        <td class="mono">${b.failed || ''}</td>
        <td class="mono">${fmtTtft(b)}</td>
        <td class="mono">${fmtTps(b)}</td>
        <td class="mono">${fmtCache(b)}</td>
        <td class="mono">${fmtCost(b)}</td>
        <td class="desc">${esc(topErr || '—')}</td>
      </tr>`
    })
    .join('')

  const bookPane = `
    <div class="card">
      <div class="card-head"><h3>错误指纹账本</h3><span class="meta">报错原文归一化后永久沉淀，不受决策日志滚动窗口影响</span></div>
      <table class="table">
        <thead><tr><th>归类</th><th>状态码</th><th>错误模板（悬停看原文）</th><th>次数</th><th>涉及站点</th><th>最近一次</th></tr></thead>
        <tbody>${errRows || '<tr><td colspan="6" class="desc">还没有失败记录——网关遇到报错会自动归一化沉淀，无需手动操作</td></tr>'}</tbody>
      </table>
    </div>`

  const statsPane = `
    <div class="card">
      <div class="card-head"><h3>供给表现</h3><span class="meta">近 ${diagnosisHours} 小时 · 按小时聚合 · UTC · 估算费用为诊断级非对账口径</span></div>
      <table class="table">
        <thead><tr><th>小时</th><th>供给</th><th>请求</th><th>成功</th><th>断流</th><th>失败</th><th>首字</th><th>吐字/s</th><th>缓存命中</th><th>估算费用</th><th>错误</th></tr></thead>
        <tbody>${statRows || '<tr><td colspan="11" class="desc">暂无流量</td></tr>'}</tbody>
      </table>
    </div>`

  // ---- 主卡：系统自动诊断的结论（core/diagnosis.js 的规则输出，按严重度排序）
  const findings = diagnosisFindings?.findings || []
  const errFindings = findings.filter((f) => (f.category || 'error') === 'error')
  const anomalyFindings = findings.filter((f) => f.category === 'anomaly')
  const hasFindings = findings.length > 0

  const LAYER_LABEL = {
    client: '客户端',
    network: '本机网络',
    gateway: '网关自身',
    site: '站点',
    upstream: '站点上游',
  }
  const FIND_CLASS = { danger: 'danger', warn: 'warn', info: 'calm' }

  const findingRows = (list) =>
    list
      .map((f) => {
        // 被归因收敛进来的派生症状：默认收起，点一下展开。收起来是因为它们
        // 都是同一个病的表象，展开看得到细节就够，不该跟根因抢注意力
        const related = Array.isArray(f.related) ? f.related : []
        const relKey = `rel:${f.id}`
        const relOpen = expandedFindings.has(relKey)
        return `
      <div class="notice ${FIND_CLASS[f.severity] || 'calm'} has-detail">
        <span class="name">${esc(f.title)}</span>
        <span class="grow"></span>
        <span class="desc">${esc(LAYER_LABEL[f.layer] || f.layer)}</span>
        ${
          f.detail || f.action
            ? `<div class="desc" style="flex-basis:100%;margin-top:4px">${esc(f.detail || '')}${
                f.action ? `　→ ${esc(f.action)}` : ''
              }</div>`
            : ''
        }
        ${
          related.length
            ? `<button class="notice-more inline" data-act="finding-related" data-key="${esc(relKey)}" style="flex-basis:100%;text-align:left">${
                relOpen ? '收起' : `展开看这 ${related.length} 项症状`
              }</button>
            ${
              relOpen
                ? `<div style="flex-basis:100%;margin-top:4px;padding-left:10px;border-left:2px solid var(--divider)">${related
                    .map(
                      (r) =>
                        `<div class="desc" style="margin-top:3px">· ${esc(r.title)}${r.detail ? `<span style="opacity:.75"> — ${esc(String(r.detail).slice(0, 80))}</span>` : ''}</div>`,
                    )
                    .join('')}</div>`
                : ''
            }`
            : ''
        }
      </div>`
      })
      .join('')

  const calmRow = (text, hint) => `
    <div class="notice calm">
      <span class="name">${esc(text)}</span>
      <span class="grow"></span>
      <span class="desc">${esc(hint)}</span>
    </div>`

  view.innerHTML = `
    <div class="stats">
      <div class="stat">
        <div class="stat-main"><div class="k">自动诊断</div><div class="v">${hasFindings ? `${findings.length} 项结论` : '一切正常'}</div></div>
        <div class="stat-icon ${hasFindings && diagnosisFindings.summary.counts.danger > 0 ? 'tint-warn' : 'tint-accent'}">${icon('alert')}</div>
      </div>
      <div class="stat">
        <div class="stat-main"><div class="k">需处理</div><div class="v">${hasFindings ? diagnosisFindings.summary.counts.danger : 0}</div></div>
        <div class="stat-icon tint-warn">${icon('alert')}</div>
      </div>
      <div class="stat">
        <div class="stat-main"><div class="k">异常项</div><div class="v">${anomalyFindings.length}</div></div>
        <div class="stat-icon ${anomalyFindings.length ? 'tint-warn' : 'tint-muted'}">${icon('trend')}</div>
      </div>
      <div class="stat">
        <div class="stat-main"><div class="k">已自动诊断</div><div class="v">${totals.diagnosed}</div></div>
        <div class="stat-icon tint-muted">${icon('search')}</div>
      </div>
    </div>

    <h3 class="section-title"><span class="s-icon">${icon('alert')}</span>报错诊断${errFindings.length ? `（${errFindings.length}）` : ''}</h3>
    <div class="notice-list">
      ${
        errFindings.length
          ? findingRows(errFindings)
          : calmRow(
              '没有需要处理的报错',
              '网关报错时自动归因：是不是并发、该不该充值、是不是站点挂了，都会直接给结论',
            )
      }
    </div>

    <h3 class="section-title"><span class="s-icon">${icon('trend')}</span>异常诊断${anomalyFindings.length ? `（${anomalyFindings.length}）` : ''}</h3>
    <div class="notice-list">
      ${
        anomalyFindings.length
          ? findingRows(anomalyFindings)
          : calmRow(
              '表现没有异常波动',
              '没报错也可能在变差：变慢、偷思考、关缓存、输出变短、时好时坏，都拿它自己的历史基线比出来',
            )
      }
    </div>

    ${driftMonitorCard()}
    ${longTermCard()}

    <div style="display:flex;align-items:center;gap:8px;margin:18px 0 10px;flex-wrap:wrap">
      <button class="primary" data-act="checkup-run" ${checkupRunning ? 'disabled' : ''}>
        ${checkupRunning ? '体检中…' : '一键体检'}
      </button>
      <span class="desc">对当前模型的全部供给当场核实一遍（指纹/截断/计费/缓存/在售/余额）——会真的打上游，只在你点的时候跑</span>
    </div>
    ${checkupRunning || checkupReport ? checkupHtml() : ''}

    <h3 class="section-title"><span class="s-icon">${icon('swap')}</span>故障处理</h3>
    ${faultHtml()}

    <h3 class="section-title"><span class="s-icon">${icon('layers')}</span>空回合守卫</h3>
    <div id="diag-guard-slot"></div>

    <div style="display:flex;align-items:center;gap:8px;margin:18px 0 10px">
      <span class="desc">调试数据（给以后做准备）</span>
      ${paneBtn('book', '错误账本', totals.fingerprints)}
      ${paneBtn('stats', '供给表现', offerStats.length)}
    </div>
    ${diagnosisPane === 'book' ? bookPane : ''}
    ${diagnosisPane === 'stats' ? statsPane : ''}
  `
}

function render() {
  renderOverview()
  renderMonitor()
  renderFree()
  renderDecision()
  renderProbes()
  renderGateway()
  renderUsage()
  renderBenchmark()
  renderDiagnosis()
  renderDiagnostics()
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

/** 看板结论句里的模型下拉是否展开。放模块级：15 秒轮询会重绘看板，状态得活过重绘 */
let headlineModelsOpen = false

/** 三档 → 句子里的用词。档位跟着「智能决策」页走，这里只是翻译表 */
const HEADLINE_WORDS = {
  value: { basis: '性价比', verdict: '最划算', metric: '有效成本' },
  price: { basis: '价格', verdict: '最便宜', metric: '价格' },
  speed: { basis: '首字速度', verdict: '最快', metric: '首字' },
}

/** 结论句里那个数字：档位不同看的东西不同，拿不到就写「未知」而不是编一个 0 */
function headlineMetric(line, mode) {
  if (mode === 'speed') return line.ttftMs === null ? t('未知') : `${line.ttftMs}ms`
  const cny = mode === 'price' ? line.priceCny : line.effectiveCny
  return cny === null ? t('未知') : `${priceText(cny)}${t('/百万 token')}`
}

/**
 * 看板顶部结论句：用哪个站、按什么档算的、那个档的关键数字。
 *
 * 数据来自 state.headline —— 服务端在「能登场」的候选里按**看板自己的档位**
 * （settings.headlineMode）重排一遍，所以这句话是一面独立的镜子：
 * 句子中间那个三档小开关只改这句话怎么看，不改网关派活（那是智能决策页的事）。
 * 点模型名可以换一个模型看结论，选择落库在 settings.focusModel。
 */
/**
 * 三档开关的公共画法：两行结论句共用一套样式，只是 data-act / 当前档不同。
 * action 区分「上面那句的档位」和「下面那句全场冠军的档位」——各自独立落库，互不牵连。
 */
function headlineBasisHtml(mode, action, title) {
  return `<span class="headline-basis" role="tablist" title="${esc(title)}">${(
    state.decisionModes || []
  )
    .map(
      (item) => `<button class="headline-basis-item${item.key === mode ? ' active' : ''}" role="tab"
      aria-selected="${item.key === mode}" data-act="${esc(action)}" data-mode="${esc(item.key)}"
      title="${esc(item.desc || item.hint || '')}">${esc(item.label)}</button>`,
    )
    .join('')}</span>`
}

/**
 * 看板顶部第二句：全场冠军行。
 *
 * 上面那句是「你关注的模型谁当家」；这句把口径放大到全部模型——全站未被忽略的
 * 模型各自「能登场」的牌合在一起，按档位比出真正的第一名（数据由服务端算好放在
 * state.champion，排序口径和准入判定与路由同源）。和上面那句的区别：这里
 * **没有模型下拉**，你能选的只有 性价比 / 价格 / 首字速度 三档
 * （settings.championMode，与上面那句的 headlineMode 各存各的）。
 */
function championLineHtml() {
  const champ = state.champion
  if (!champ) return ''
  const mode = HEADLINE_WORDS[champ.mode] ? champ.mode : 'value'
  const words = HEADLINE_WORDS[mode]
  const basis = headlineBasisHtml(mode, 'set-champion-mode', t('只改这句全场冠军的算法，不影响上面那句'))
  const sentence = t('在全部模型中，{provider}的 {model} 按{basis}算{verdict}：{metric}', {
    provider: `<strong>${esc(champ.providerName || '—')}</strong>`,
    model: `<strong class="mono">${esc(champ.modelKey)}</strong>`,
    basis,
    verdict: `<strong>${t(words.verdict)}</strong>`,
    metric: `${t(words.metric)} <strong>${headlineMetric(champ, mode)}</strong>`,
  })
  return `<div class="line sub">${sentence}</div>`
}

function headlineHtml() {
  const line = state.headline
  if (!line) return ''
  const mode = HEADLINE_WORDS[line.mode] ? line.mode : 'value'
  const words = HEADLINE_WORDS[mode]
  const models = state.headlineModels || []

  // 三档直接长在句子里（「按[性价比|价格|速度]算…」）：
  // 省掉右边那条独立控件，一句话自己就是全部操作面；点它只改这句话的算法
  const basis = headlineBasisHtml(mode, 'set-headline-mode', t('只改这句结论的算法，不改网关派活'))

  const sentence = t('选用{provider}的 {model}，按{basis}算{verdict}：{metric}', {
    provider: `<strong>${esc(line.providerName || '—')}</strong>`,
    // 模型名可点：点开是本机未忽略的模型清单，选完整个句子重算
    model: `<button class="headline-model" data-act="toggle-headline-models" aria-expanded="${headlineModelsOpen}" title="${esc(t('换一个模型看结论'))}"><span class="hm-name">${esc(displayModel(line.modelKey))}</span><span class="caret">▾</span></button>`,
    basis,
    verdict: `<strong>${t(words.verdict)}</strong>`,
    metric: `${t(words.metric)} <strong>${headlineMetric(line, mode)}</strong>`,

  })

  const menu = !headlineModelsOpen
    ? ''
    : `
    <div class="headline-menu">
      <div class="headline-menu-head">${t('本机未被忽略的模型')}</div>
      ${models
        .map((row) => {
          const dead = row.available === 0
          return `<button class="headline-menu-item${row.modelKey === line.modelKey ? ' active' : ''}"
            ${dead ? 'disabled' : ''} data-act="pick-headline-model" data-model="${esc(row.modelKey)}"
            title="${esc(dead ? t('现在没有可用供给') : t('{n} / {total} 条供给可用', { n: row.available, total: row.total }))}">
            <span class="mono">${esc(row.modelKey)}</span>
            <span class="sub">${dead ? t('没有可用供给') : t('{n} 条可用', { n: row.available })}</span>
          </button>`
        })
        .join('')}
    </div>`

  return `
    <div class="headline">
      <div class="line">${sentence}</div>
      ${championLineHtml()}
      ${menu}
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
        <td class="num">${hasQuota ? `${priceSym()}${money(dispAmount(provider.quotaRemaining, provider))}` : '<span style="color:var(--faint)">未录入</span>'}</td>
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
            `${r.missingBench.length} 个模型缺基准价，已按站点原价直接填。去「基准价」页核对，才能用倍率统一调整。`,
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
        ${site ? `<div style="color:var(--muted)">站点全站账单：<b>${site.actualCost === null ? '—' : priceText(site.actualCost * siteUnitCny((state.providers || []).find((x) => x.id === providerId)))}</b>
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
    // 余额是站点级「额度数值」，折真实人民币只乘站点单价（充值汇率），不乘市场汇率
    const quota = hasQuota ? p.quotaRemaining * siteUnitCny(p) : 0

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
        chipClass: groupChipOf(p.id, groupName),
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
      // 胶囊本身就是入口：点开弹出这个分组的模型清单。
      // 用 span + role 而不是 button，是因为里面还要嵌一个「删分组」按钮（button 不能套 button），
      // 点删除键时 closest('[data-act]') 命中的是里面的按钮，不会误开弹窗。
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
    // 告警阈值存的是「站内额度单位」（默认 1:1，就是 ¥）；余额也是站内额度，
    // 同单位直接比，展示时两边同乘一个站点单价，不会出现「阈值被放大 7 倍」
    const warnUsd = Number(state.settings.balanceWarnUsd ?? state.settings.balanceWarnCny) || 0
    const warnCny = warnUsd * siteUnitCny(p)
    const statusBadge = hasQuota
      ? balanceBadge(quota, warnCny, Boolean(p.balanceDepleted))
      : '<span class="badge">余额未录入</span>'
    // 赠金（Sub2API 的「赠送额度」）：quotaRemaining 里已经含它，这里只把
    // 「其中多少是赠金、什么时候到期」说清楚——否则「余额 0 却还能用」看着像 bug
    const giftAmount = p.giftBalance === null || p.giftBalance === undefined ? NaN : Number(p.giftBalance)
    const giftText =
      Number.isFinite(giftAmount) && giftAmount > 0
        ? `${priceSym()}${money(dispAmount(giftAmount, p))}`
        : ''
    const giftHint = giftText
      ? `<span class="hint" title="${esc(
          t('余额里含赠金 {amount}，{date} 到期。赠金按站点自己的规则抵扣，到期后自动失效。', {
            amount: giftText,
            date: p.giftExpiry ? fmtDateTime(p.giftExpiry) : t('没有固定到期日'),
          }),
        )}">${t('其中赠金 {amount}', { amount: giftText })}</span>`
      : ''

    return `
      <div class="card prov-card${p.paused ? ' is-paused' : ''}" data-provider="${esc(p.id)}" data-has-token="${p.hasAdminToken ? '1' : '0'}">
        <div class="prov-head">
          <div class="prov-id">
            ${loginLightDot(p)}
            <b>${esc(p.name)}</b>
            ${p.baseUrl ? `<a class="icon-btn prov-open" href="${esc(p.baseUrl)}" target="_blank" rel="noreferrer" title="${t('打开站点后台')}">${icon('external')}</a>` : ''}
            ${kindText ? `<span class="badge ${kindMeta.cls}" title="${esc(p.kindSource === 'manual' ? t('系别由用户手动设置') : t('系别由添加站点/登录时自动探测得出'))}">${esc(kindText)}</span>` : ''}
            <button class="ghost tiny" data-act="detect-kind" data-provider="${esc(p.id)}" title="${t('识别系别：用站点令牌探测这个站是哪一系（one-api / new-api / Sub2API）。匿名探测不出的站，带令牌再试一次往往就能识别')}" aria-label="${t('识别系别')}" style="padding:4px 6px">${icon('search')}</button>
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

        <div class="prov-tiles prov-tiles--duo">
          <div class="prov-tile-duo" data-provider="${esc(p.id)}">
            <div>
              <span class="k">${t('余额')}</span>
              <b class="edit-warn" data-act="prov-read-balance" data-provider="${esc(p.id)}" title="${esc(t('点这里重新读一次余额（充值后读完，探底离场的站当场回场）'))}">${hasQuota ? `${priceSym()}${money(dispAmount(p.quotaRemaining, p))}` : '—'}</b>
              ${giftHint}
            </div>
            <div>
              <span class="k">${t('阈值')} ${statusBadge}</span>
              <b><span class="edit-warn" data-act="edit-warn" data-provider="${esc(p.id)}" title="${esc(t('点击修改告警阈值（全站统一一条线，按这个站的额度单位计；0 = 关闭）'))}">${warnUsd > 0 ? `${priceSym()}${money(dispPrice(warnCny))}` : '—'}</span></b>
            </div>
          </div>
          <div>
            <button class="tile-feature" data-act="open-pricing-sheet" data-provider="${esc(p.id)}" title="${esc(t('点这里改每个模型的价格：没定价的排最前面，点数字或横杠就能填'))}">
              <span class="k">${t('定价修改')}</span>
              <b>${priced.length} <span class="of">/ ${offers.length}</span></b>
            </button>
          </div>
          <div>
            <span class="k">Key</span>
            <b>${keys.length} <span class="of">把</span></b>
          </div>
        </div>

        <div class="prov-tiles">
          <div title="${esc(t('「令牌」是站点后台的登录凭证，一次填好整站通用，用来读余额、公告和分组'))}">
            <span class="k">令牌</span>
            <b>${p.hasAdminToken
              ? (p.tokenStatus === 'invalid'
                ? '<span class="badge danger">已失效</span>'
                : '<span class="badge ok">已填</span>')
              : '<span class="badge">未填</span>'}<button class="ghost tiny" data-act="set-admin-token" data-provider="${esc(p.id)}" title="${esc(p.adminTokenTail ? `${t('令牌尾号')} …${p.adminTokenTail}` : t('未填站点令牌'))}">${p.hasAdminToken ? '更换' : '填写'}</button></b>
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
          <button data-act="open-login" title="用站点后台的账号密码登录，自动获取并续期令牌——令牌过期不再需要手动换">${icon('key')}账号登录</button>
          <button data-act="prov-sync-all" title="模型、分组、价格、密钥，一键同步">${icon('refresh')}一键同步</button>
          <button data-act="prov-panel" data-panel="keys">${icon('key')}密钥</button>
          <button data-act="prov-panel" data-panel="rates">${icon('columns')}分组倍率</button>
          <button data-act="open-group-picker" title="从站点读分组，选你买的那个，倍率自动填到下面所有模型">${icon('columns')}导入倍率</button>
          <button data-act="usage-check" title="用管理令牌拉站方用量，和我们的估算对比">${icon('receipt')}用量核对</button>
        </div>

        <div class="prov-detail" hidden>
        <div data-pane="keys">
        <div class="keylist">
          ${keys.length === 0 ? '<div class="hint">还没有 Key，加一个才能拉模型。</div>' : keys.map((k) => {
            // 「总 / 忽略 / 可用」全部取台账全量（含被忽略的），和点开弹窗看到的清单同口径。
            // 老服务端没有 modelsByCredential 时退回在役供给数（只是「可用」，总/忽略显示不出来）。
            const keyModels = state.modelsByCredential?.[k.id]
            const keyOffers = offers.filter((o) => o.credentialId === k.id)
            const keyTotal = Array.isArray(keyModels) ? keyModels.length : keyOffers.length
            const keyIgnored = Array.isArray(keyModels) ? keyModels.filter((m) => m.ignored).length : 0
            const keyAvail = Math.max(0, keyTotal - keyIgnored)
            const countBtn = (filter, label, n) => `<button class="gs-count" data-act="open-key-models" data-credential="${esc(k.id)}" data-filter="${filter}" title="${esc(
              t('点开看这把 Key 的模型清单'),
            )}">${label} <b>${n}</b></button>`
            return `
            <div class="keyrow" data-credential="${esc(k.id)}">
              <span>${esc(k.label)}</span>
              <span class="tail">sk-••••${esc(k.tail || '????')}</span>
              <button class="ghost tiny group-chip ${groupChipOf(p.id, k.group)}" data-act="open-group-picker" title="${k.group ? '这把 Key 属于这个分组，点这里换' : '还没选分组，点这里选（会顺便把倍率填好）'}">
                ${k.group ? `分组 · ${esc(k.group)}` : '选分组'}
              </button>
              <span class="key-models">${t('模型数')}${countBtn('all', t('总'), keyTotal)}${countBtn('ignored', t('忽略'), keyIgnored)}${countBtn('avail', t('可用'), keyAvail)}</span>
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
          ${p.hasAdminToken ? '' : `<div class="hint" style="margin-top:2px">
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
      <input type="number" min="0" step="0.5" id="monitor-warn" placeholder="告警阈值" title="余额告警阈值（站内额度单位，1:1 充值就是 ¥；0 = 不告警）" value="${data.settings?.balanceWarnUsd ?? 1.5}" />
      <input type="number" min="0" step="0.01" id="monitor-unit-price" placeholder="默认充值汇率（默认 1）" title="默认充值汇率（所有站口径一致时只填一次）：充 1 元到账 1 单位额度填 1（绝大多数中转站）；充 ¥100 到账 $120 填 0.83。留空 = 1:1" value="${state?.settings?.defaultUnitPrice ?? ''}" />
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
  injectFeedCards(host)
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
  // 允许直接传卡片：删完 Key 后要重开面板，手上只有卡片没有按钮
  const card = button.classList?.contains('prov-card') ? button : button.closest('.prov-card')
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

/**
 * 重开一次当前的站点面板。
 *
 * 面板内容是 cloneNode 复制进弹窗的，render() 只重绘页面上的站点卡，
 * 弹窗里那份克隆不会跟着变——所以弹窗内增删（Key、分组倍率）之后必须
 * 重新克隆一次，否则列表还停在旧数据上（删掉的 Key 还在、新加的看不到）。
 */
function reopenProvPanel(node, pane = 'keys') {
  const providerId = node?.closest?.('[data-provider]')?.dataset?.provider
  if (!providerId) return
  const card = document.querySelector(`.prov-card[data-provider="${CSS.escape(providerId)}"]`)
  if (card) openProvPanel(card, pane)
}

// --------------------------------------------------------- 模型清单弹窗
//
// 两个入口共用这一张居中卡片（.modal / .modal-panel，圆角居中）：
//   · 站点卡上的分组胶囊、「分组倍率」里的「N 个模型」→ 这个分组里到底有哪些模型
//   · 密钥面板里 Key 那行的「总 / 忽略 / 可用」→ 这把 Key 同步回来哪些模型
//
// 站点接口只给「分组名录」+「平台级模型表」，两者并列，谁属于哪个分组它没说——
// 交叉相乘会编出不存在的组合。真正把模型绑到分组/Key 上的，是「同步回来了哪些模型」，
// 所以数据只认后端算好的 state.modelsByGroup / state.modelsByCredential，前端不再自己拼一份。

/** 当前打开的弹窗：{ kind: 'group' | 'key', providerId, group?, credentialId?, filter? }；null = 关闭 */
let modelsSheet = null

function openGroupModels(providerId, group = '') {
  openModelsSheet({ kind: 'group', providerId, group: group || '' })
}

/** Key 那行的「总 / 忽略 / 可用」：filter = all | ignored | avail */
function openKeyModels(providerId, credentialId, filter = 'all') {
  openModelsSheet({ kind: 'key', providerId, credentialId, filter })
}

/** 站点卡「已定价 9 / 9」的入口：这站全部模型的定价清单，没定价的就地补 */
function openPricingSheet(providerId, filter = 'all') {
  openModelsSheet({ kind: 'pricing', providerId, filter, q: '' })
}

function openModelsSheet(next) {
  const sheet = $('#group-models')
  if (!sheet) return
  // 换目标 / 换筛选就从头看：沿用上一次的滚动位置会让人以为还在同一个清单里往下滑
  modelsSheet = next
  const body = $('#group-models-body')
  if (body) {
    // 同一份内容也要重画一次：标题、筛选按钮的选中态会变
    body.dataset.sig = ''
    body.scrollTop = 0
  }
  paintGroupModels()
  sheet.hidden = false
  translateDom(sheet)
}

function closeGroupModels() {
  const sheet = $('#group-models')
  if (sheet) sheet.hidden = true
  modelsSheet = null
}

/**
 * 一行模型：名字 + 倍率/标记 + 右侧价格。分组弹窗和 Key 弹窗共用，两处口径不能分家。
 *
 * 忽略状态是一个可点的开关徽章（分组页和 Key 页都能用）：
 *   已忽略 = 灰色，不参与比价、决策、探针和网关；已显示 = 橙黄。
 * 点一下只切这**一个**模型（精确名，走 modelOverrides 单行例外），
 * 不动同类写法；「整类忽略」在「忽略模型」管理面板（身份键名单）。判定规则在服务端。
 */
function modelRowHtml(m) {
  const flags = [
    m.free ? `<span class="badge ok">${t('免费')}</span>` : '',
    m.perCall ? `<span class="badge">${t('按次')}</span>` : '',
    m.name
      ? `<button type="button" class="badge ig-chip${m.ignored ? ' ig-on' : ' ig-off'}"
          data-act="toggle-sheet-ignore" data-name="${esc(m.name)}" aria-pressed="${Boolean(m.ignored)}"
          title="${m.ignored ? esc(t('点击显示：恢复参与比价、决策、探针和网关')) : esc(t('点击忽略：不参与比价、决策、探针和网关'))}"
        >${m.ignored ? t('已忽略') : t('已显示')}</button>`
      : '',
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
}

/**
 * 定价视图：这个站全部模型，哪些已定价、哪些没有，就地改价。
 *
 * 行内改价完全照搬比价页的管线（data-offer + data-field → stagePriceEdit）：
 * 暂存、去抖、焦点保护（表格带 .pricing-table 类）全部原样生效，两边口径不会分家。
 * 未定价的排前面：这个弹窗的主要用途就是补价，欠账的要一眼看到。
 */
function pricingSheetView() {
  const { providerId, filter, q } = modelsSheet
  const provider = (state.providers || []).find((p) => p.id === providerId)
  if (!provider) return null
  const all = (state.offers || []).filter((o) => o.providerId === providerId)
  const isPriced = (o) => o.inPrice !== null || o.outPrice !== null || o.ratio !== null
  const priced = all.filter(isPriced)
  const unpriced = all.filter((o) => !isPriced(o))
  const query = String(q || '').trim().toLowerCase()
  const matchQ = (o) =>
    !query ||
    String(o.upstreamName || '').toLowerCase().includes(query) ||
    String(o.group || '').toLowerCase().includes(query)
  const base = filter === 'unpriced' ? unpriced : filter === 'priced' ? priced : all
  const models = base.filter(matchQ).sort((a, b) => {
    const pa = isPriced(a) ? 1 : 0
    const pb = isPriced(b) ? 1 : 0
    if (pa !== pb) return pa - pb
    return String(a.upstreamName || '').localeCompare(String(b.upstreamName || ''))
  })
  const segBtn = (id, label, n) =>
    `<button type="button" data-act="pricing-sheet-filter" data-filter="${id}" class="${
      filter === id ? 'active' : ''
    }">${label}<span class="seg-count">${n}</span></button>`
  const head = `
    <div class="gs-meta">
      <span class="hint">${t('点数字或横杠就地改，回车保存；倍率填了按倍率走，不填按输入/输出单价走')}</span>
      <span class="grow"></span>
      <input id="pricing-sheet-search" class="search" type="search" placeholder="${esc(t('搜索模型名…'))}" value="${esc(modelsSheet.q || '')}" style="width:180px" />
    </div>`
  const empty = `<div class="empty small"><p>${
    all.length === 0 ? t('这个站还没有同步过模型。') : t('没有匹配的模型。')
  }</p>${
    all.length === 0 ? `<p class="hint">${t('点「一键同步」拉一次模型列表，再回来定价。')}</p>` : ''
  }</div>`
  const table = `<div class="table-wrap"><table class="pricing-table ps-table">
      <thead><tr><th>${t('模型')}</th><th class="num">${t('输入 / 输出 / 倍率')}</th><th>${t('币种')}</th><th></th></tr></thead>
      <tbody>${models.map(pricingSheetRowHtml).join('')}</tbody>
    </table></div>`
  return {
    title: t('定价'),
    seg: `<div class="seg gs-seg">${segBtn('all', t('全部'), all.length)}${segBtn(
      'unpriced',
      t('未定价'),
      unpriced.length,
    )}${segBtn('priced', t('已定价'), priced.length)}</div>`,
    meta: `${t('{n} 个模型', { n: models.length })} · ${t('已定价 {priced} / {total}', {
      priced: priced.length,
      total: all.length,
    })}`,
    models,
    customBody: all.length === 0 ? empty : `${head}${models.length ? table : empty}`,
  }
}

/**
 * 定价清单里的一行：三个数字（输入 / 输出 / 倍率）直接摆出来，不写已定价/未定价。
 * 空档显示横杠，点数字或横杠就地变输入框（edit-price-slot）。
 * 语义与比价页一致：倍率填了按倍率走，不填按输入/输出单价走。
 */
function pricingSheetRowHtml(offer) {
  const priced = offer.inPrice !== null || offer.outPrice !== null || offer.ratio !== null
  const perCall = offer.priceUnit === 'per_call'
  const slot = (field, title, off = false) => {
    if (off) return `<span class="price-slot is-off" title="${esc(title)}">—</span>`
    const v = offer[field]
    const empty = v === null || v === undefined || v === ''
    return `<button type="button" class="price-slot${empty ? ' is-empty' : ''}" data-act="edit-price-slot" data-offer="${esc(offer.id)}" data-field="${field}" title="${esc(title)}">${empty ? '—' : esc(v)}</button>`
  }
  return `
  <tr data-offer="${esc(offer.id)}"${priced ? '' : ' class="is-unpriced"'}>
    <td class="mono"><span class="offer-name" title="${esc(offer.upstreamName)}">${esc(offer.upstreamName)}</span>${
      offer.group
        ? ` <span class="badge ${groupChipOf(offer.providerId, offer.group)}"><span class="gc-name">${esc(offer.group)}</span></span>`
        : ''
    }${perCall ? ' <span class="badge">按次</span>' : ''}</td>
    <td class="num"><span class="price-trio">${
      slot('inPrice', perCall ? t('每次请求的价格。点击修改') : t('输入价（每百万 token）。点击修改'))
    }<span class="ps-sep">/</span>${
      slot('outPrice', t('输出价。点击修改'), perCall)
    }<span class="ps-sep">/</span>${
      slot('ratio', t('倍率：填了按倍率走（实际价 = 这里 × 输入/输出），不填按输入/输出单价走。点击修改'))
    }</span></td>
    <td>
      <div class="unit-cell">${currencyCell(offer)}</div>
    </td>
    <td><button class="ghost tiny" data-act="mark-free" data-offer="${esc(offer.id)}" title="${esc(t('把输入/输出价都设为 0，这条就进免费池（不进比价和自动选站）'))}">${t('标为免费')}</button></td>
  </tr>`
}

/** 分组视图：这个分组里有哪些模型。分组没了返回 null（弹窗自己收起） */
function groupSheetView() {
  const { providerId, group } = modelsSheet
  const site = state.modelsByGroup?.[providerId]
  const models = site?.[group] || []
  const keys = (state.credentials || []).filter(
    (c) => c.providerId === providerId && (c.group || '') === group,
  )
  // 分组被删掉了（卡片垃圾桶 / 分组倍率面板 / 比价页都能删）
  if (!site || (!(group in site) && keys.length === 0)) return null
  const ignoredCount = models.filter((m) => m.ignored).length
  return {
    title: group || t('未指定分组'),
    meta: `${t('{n} 个模型', { n: models.length })}${
      keys.length ? ` · ${t('{n} 把 Key 在这个分组', { n: keys.length })}` : ''
    }`,
    models,
    emptyTitle: t('这个分组还没同步过模型。'),
    emptyHint: keys.length
      ? t('点站点卡的「一键同步」，会按这把 Key 的分组拉一次。')
      : t('这个分组没有挂 Key（多半是比价页「＋」复制出来的），不会有模型同步进来。'),
    foot: ignoredCount > 0 ? t('其中 {n} 个已忽略：不参与比价、决策、探针和网关。', { n: ignoredCount }) : '',
  }
}

/** Key 视图：这把 Key 同步回来哪些模型，可按 总 / 忽略 / 可用 筛。Key 没了返回 null */
function keySheetView() {
  const { providerId, credentialId, filter } = modelsSheet
  const credential = (state.credentials || []).find(
    (c) => c.id === credentialId && c.providerId === providerId,
  )
  if (!credential) return null
  const all = state.modelsByCredential?.[credentialId] || []
  const ignored = all.filter((m) => m.ignored)
  const avail = all.filter((m) => !m.ignored)
  const models = filter === 'ignored' ? ignored : filter === 'avail' ? avail : all
  const segBtn = (id, label, n) =>
    `<button type="button" data-act="key-models-filter" data-filter="${id}" class="${
      filter === id ? 'active' : ''
    }">${label}<span class="seg-count">${n}</span></button>`
  const provider = (state.providers || []).find((p) => p.id === providerId)
  return {
    title: credential.group ? `${credential.label} · ${credential.group}` : credential.label,
    // 站点名后面补 Key 尾号：同一个站点常挂好几把 Key，只看标题分不清是哪一把
    site: `${provider?.name || ''} · sk-••••${credential.tail || '????'}`,
    seg: `<div class="seg gs-seg">${segBtn('all', t('总'), all.length)}${segBtn(
      'ignored',
      t('忽略'),
      ignored.length,
    )}${segBtn('avail', t('可用'), avail.length)}</div>`,
    meta:
      t('{n} 个模型', { n: models.length }) +
      (filter === 'ignored' ? ` · ${t('忽略的模型不参与比价、决策、探针和网关')}` : ''),
    models,
    emptyTitle:
      filter === 'ignored'
        ? t('这把 Key 没有忽略的模型。')
        : filter === 'avail'
          ? t('这把 Key 的模型全被忽略了。')
          : t('这把 Key 还没同步过模型。'),
    emptyHint:
      filter === 'all'
        ? t('点站点卡的「一键同步」，会按这把 Key 拉一次模型列表。')
        : filter === 'avail'
          ? t('去「忽略模型」里取消勾选，它们就会回到可用。')
          : t('这把 Key 的模型都还在用，没有被忽略的。'),
    foot: '',
  }
}

/** 重画弹窗内容：自动轮询、一键同步、改倍率、改忽略之后都得跟着变 */
function paintGroupModels() {
  if (!modelsSheet) return
  const sheet = $('#group-models')
  const body = $('#group-models-body')
  if (!sheet || !body) return

  // 定价清单四列（模型/三数字/币种单位/操作），默认 520px 装不下；其余清单维持窄面板
  const panel = sheet.querySelector('.modal-panel')
  if (panel) panel.classList.toggle('gs-panel-wide', modelsSheet.kind === 'pricing')

  const provider = (state.providers || []).find((p) => p.id === modelsSheet.providerId)
  const view =
    modelsSheet.kind === 'key'
      ? keySheetView()
      : modelsSheet.kind === 'pricing'
        ? pricingSheetView()
        : groupSheetView()
  // 目标没了（分组被删 / Key 被删）→ 弹窗没有存在意义，直接收起
  if (!view) {
    closeGroupModels()
    return
  }

  const siteText = view.site ?? provider?.name ?? ''
  const siteEl = $('#group-models-site')
  const titleEl = $('#group-models-title')
  if (siteEl) siteEl.textContent = siteText
  if (titleEl) titleEl.textContent = view.title

  // 内容没变就不重写：15 秒自动轮询会重画页面，每次重建 DOM 会把滚动位置打回顶部。
  // （语言、显示币种、汇率也算进签名，它们一变价格文字就该跟着变。）
  const sig = JSON.stringify([
    getLang(),
    displayCur(),
    rateCny(),
    siteText,
    view.title,
    view.seg || '',
    view.meta,
    // 定价视图的行是可编辑输入框，整段 HTML 进签名；清单视图仍是只读行，用 models 就够
    view.customBody ?? view.models,
    view.foot,
  ])
  if (body.dataset.sig === sig) return
  body.dataset.sig = sig

  const scrollTop = body.scrollTop
  let inner
  if (view.customBody !== undefined) {
    // 定价视图：自带表格（可编辑输入框），不再套 gs-list 只读行
    inner = `${view.seg || ''}${view.customBody}`
  } else {
    const rows = view.models.map(modelRowHtml).join('')
    const head = `
      <div class="gs-meta">
        <span class="hint">${view.meta}</span>
        <span class="grow"></span>
        <span class="hint">${t('价格：输入 / 输出，每百万 token')}</span>
      </div>`
    const empty = `<div class="empty small"><p>${view.emptyTitle}</p><p class="hint">${view.emptyHint}</p></div>`
    inner = `${view.seg || ''}${view.models.length ? head : ''}${
      view.models.length ? `<div class="gs-list">${rows}</div>` : empty
    }${view.foot ? `<p class="hint gs-foot">${view.foot}</p>` : ''}`
  }
  body.innerHTML = inner
  body.scrollTop = scrollTop
  translateDom(body)
}

// 定价弹窗里的搜索：只过滤本弹窗的行，不动全局筛选。
// 重画会丢焦点，画完把焦点和光标还回去，不然打一个字就得重新点输入框
document.addEventListener('input', (event) => {
  if (event.target.id !== 'pricing-sheet-search') return
  if (!modelsSheet || modelsSheet.kind !== 'pricing') return
  modelsSheet.q = event.target.value
  paintGroupModels()
  const el = $('#pricing-sheet-search')
  if (el) {
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }
})

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

/** 官方有效成本的混合权重（与 offerCost 同一默认与限幅） */
function blendWeight() {
  const raw = Number(state?.settings?.blendInputWeight)
  return Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0.25
}

/**
 * 官方参照胶囊：基准价表里没有这个模型就不显示（不硬凑）。
 * 有效成本口径与站内供给一致（offerCost 同一算法，质量按 1），只是来源是官方价。
 */
function officialChipHtml(official) {
  if (!official || official.blendedCnyPerMtok === null) return ''
  // 先官方原价（含币种与单位），后有效成本；缺哪个价用 — 占位
  // 币种符号：¥ = 官方人民币价，$ = 站内美元，R$ = 真实美元（国外官方价）
  const cur = official.currency === 'CNY' ? '¥' : official.currency === 'RUSD' ? 'R$' : '$'
  const detail = `${t('原厂价')} ${t('输入')} ${cur}${official.in ?? '—'} · ${t('输出')} ${cur}${official.out ?? '—'}（${t('每百万 token')}）`
  const w = Math.round(blendWeight() * 100)
  const title = t('{detail} · 原厂有效成本 = 输入按 {w}%、输出按 {ow}% 加权；在「基准价」页可改', {
    detail,
    w,
    ow: 100 - w,
  })
  // 填了峰谷价（如 DeepSeek 空闲时段减半）：分「峰 / 谷」展示两个有效成本
  const hasPeak = official.hasOffPeak && official.offPeakBlendedCnyPerMtok !== null
  const eff = hasPeak
    ? `${t('峰')}${priceText(official.blendedCnyPerMtok)} / ${t('谷')}${priceText(official.offPeakBlendedCnyPerMtok)}`
    : priceText(official.blendedCnyPerMtok)
  return `<span class="official-chip" title="${esc(title)}">${t('原厂')} ${cur}${official.in ?? '—'}/${cur}${official.out ?? '—'} /M → ${t('有效')} ${eff}/M</span>`
}

// --------------------------------------------------------------- 刷新

function paintAutoRefresh() {
  const btn = $('#autorefresh-btn')
  if (!btn) return
  btn.classList.toggle('is-off', !autoRefresh)
  const dot = $('#autorefresh-dot')
  if (dot) dot.style.background = autoRefresh ? 'var(--success)' : 'var(--faint)'
  btn.title = autoRefresh ? t('自动同步：开着，每 15 秒一次；点一下关闭') : t('自动同步已关，点一下开启')
}

/**
 * 重新拉一次 state 并重绘。
 * - 正在输入（焦点在表单元素里）时跳过，避免打断填写
 * - 比价/决策页用完整 state，其它页用 ?light=1（服务端只裁掉 decisions 这一大块；
 *   scores 保留——概览/探针/网关页和通知中心都靠它，停在这些页时评分才会跟着轮询更新）
 * - 重绘后恢复滚动位置
 */
// --------------------------------------------- 改价暂存（2 秒去抖）

/**
 * 比价页改价的烦恼：填完输入价，表格歋地就重排了，还没来得及改输出价就找不到行了。
 *
 * 规矩：输入价 / 输出价 / 倍率 / 单位 / 币种都算「改价行为」。改一下先落本地、
 * 不提交不重排；停手 2 秒才一次性提交，然后才计入真实价格变动（重排）。
 * 2 秒内接着改同一行，计时器重置——直到改完为止整张表纹丝不动。
 */
const PRICE_EDIT_DEBOUNCE_MS = 2000
const pendingPriceEdits = new Map() // offerId → { fields, timer }
let pendingSortRender = false

/** 把一次改动暂存起来：本地先生效（界面反映你输的值），提交和重排都推迟 */
function stagePriceEdit(offerId, field, value) {
  // 本地先生效：任何原因触发重绘（另一行 flush、切页）都不会丢你刚输的值
  const local = state.offers?.find((o) => o.id === offerId) || state.unpriced?.find((o) => o.id === offerId)
  if (local) local[field] = value
  const entry = pendingPriceEdits.get(offerId) || { fields: {}, timer: null }
  clearTimeout(entry.timer)
  entry.fields[field] = value
  entry.timer = setTimeout(() => void flushPriceEdits(offerId), PRICE_EDIT_DEBOUNCE_MS)
  pendingPriceEdits.set(offerId, entry)
}

/** 停手 2 秒：把这一行的所有暂存改动一次性提交，然后才重排 */
async function flushPriceEdits(offerId) {
  const entry = pendingPriceEdits.get(offerId)
  if (!entry) return
  pendingPriceEdits.delete(offerId)
  clearTimeout(entry.timer)
  try {
    state = await api('PATCH', `/api/offers/${offerId}`, entry.fields)
    scheduleSortRender()
  } catch (error) {
    toast(error.message, true)
  }
}

/** 暂存改动落库后要重排上屏；但焦点还在比价表里就先等它离开，别把正在编辑的下一行打飞 */
function scheduleSortRender() {
  pendingSortRender = true
  trySortRender()
}
function trySortRender() {
  if (!pendingSortRender) return
  const el = document.activeElement
  if (el && el.closest && el.closest('.pricing-table')) return
  pendingSortRender = false
  render()
}
// 焦点一离开比价表就把欠着的重排补上（点别处、切页都会触发 focusout）
document.addEventListener('focusout', () => setTimeout(trySortRender, 0))

// 关页面前的兜底：暂存中（还没到 2 秒）的改价用 keepalive 补发，尽力而为
window.addEventListener('beforeunload', () => {
  for (const [offerId, entry] of pendingPriceEdits) {
    clearTimeout(entry.timer)
    try {
      fetch(`/api/offers/${offerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry.fields),
        keepalive: true,
      })
    } catch {
      /* 尽力而为，失败就丢这最后 2 秒内的改动 */
    }
  }
})

async function refreshState({ silent = false } = {}) {
  const focused = document.activeElement
  if (focused && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)) return
  // 改价暂存中：轮询拿回的是没含暂存改动的服务端状态，会把正在编辑的值冲掉；
  // 停手 2 秒后 flushPriceEdits 自己会拉新状态并重排。
  // 价格单位切换的 2 秒暂存同理：服务端还是旧单位，拉回来会把刚选的冲掉
  if (pendingPriceEdits.size > 0) return
  if (pendingDisplayCurrency !== null) return
  const scroller = $('.content')
  const scrollTop = scroller ? scroller.scrollTop : 0
  const light = !HEAVY_TABS.has(activeTab)
  try {
    const next = await api('GET', `/api/state${light ? '?light=1' : ''}`)
    state = light && state ? { ...state, ...next } : next
    // 用量页默认 30 天与 state.usage 同口径：清掉旧快照轮询才能生效
    // （此前点过范围按钮后快照永不清空，用量页一直渲染旧数据）
    if (usageRange === 30 && !usageCustom) usageData = null
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
// 分组名 → 该组下的模型身份键（渲染时登记，供「整组忽略 / 全部显示」用）
let igGroupNames = new Map()
// 左栏当前选中的模型组（重画面板后保持选中）
let igSelected = null

// 厂牌前缀表与 vendorOf / vendorLabel 移到了 free-relay.js（胶囊配色与这里共用一份）

/**
 * 当前所有出现过的模型（**按身份键合并**）+ 覆盖站点数 + 各站写法。
 *
 * 忽略是按身份键生效的（忽略一个写法 = 忽略整个模型），所以列表也必须按身份键
 * 列一条——否则用户会看到两行「同一个模型」，勾掉一行另一行还在比价里，
 * 与忽略的实际效果自相矛盾。
 */
function knownModels() {
  const rows = new Map() // identity → { id, display, providers:Set, names:Set }
  const touch = (name) => {
    const raw = String(name || '').trim()
    if (!raw) return null
    const id = identityOf(raw)
    let row = rows.get(id)
    if (!row) {
      row = { id, display: displayModel(id), providers: new Set(), names: new Set() }
      rows.set(id, row)
    }
    row.names.add(raw)
    return row
  }
  // 站点数按 providerId 去重：一个站同时列了两种写法也只算一个站
  for (const offer of state.offers || []) {
    const row = touch(offer.modelKey || offer.upstreamName)
    if (row) row.providers.add(offer.providerId)
  }
  // 被忽略 / 已下线的名字不在 offers 里了，但还得出现在列表里（否则没法取消忽略）
  for (const entry of state.modelIndex || []) {
    const row = touch(entry.name)
    if (!row) continue
    if (row.providers.size === 0) row.sites = Math.max(row.sites || 0, entry.sites)
  }
  for (const name of state.settings?.ignoredModels || []) touch(name)
  return [...rows.values()]
    .map((row) => ({
      ...row,
      sites: row.providers.size || row.sites || 0,
      names: [...row.names].sort(),
    }))
    .sort((a, b) => a.display.localeCompare(b.display))
}

/** 按厂牌分组，组内按名字排；组按「未忽略数量多的在前」排，方便先处理没管过的 */
function groupModels(rows) {
  const ignored = new Set((state.settings?.ignoredModels || []).map(identityOf))
  const groups = new Map()
  for (const row of rows) {
    const key = vendorOf(row.display)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return [...groups.entries()]
    .map(([key, items]) => ({
      key,
      label: vendorLabel(key),
      items,
      ignoredCount: items.filter((row) => ignored.has(row.id)).length,
    }))
    .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label))
}

/**
 * 忽略模型面板：左右两栏（2026-10-29 重做，旧的复选框树太臃肿）。
 *
 *   左栏：厂牌模型组，一张张圆角卡，默认不展开任何一组；
 *   右栏：点中组里的模型逐行开关——灰「已忽略」/ 橙黄「已显示」，
 *          与分组/Key 弹窗的开关徽章同款；另有「整组忽略 / 全部显示」。
 *
 * 这里的开关仍是**身份键口径**（整类）：面板管的是「一类模型」的全局忽略，
 * 变体一起消失；要「这一行就是这一行」的单行例外，去分组弹窗（modelOverrides）。
 */
function openIgnoredModels() {
  const modal = $('#prov-modal')
  const title = $('#prov-modal-title')
  const body = $('#prov-modal-body')
  if (!modal || !body) return
  // 忽略名单里可能存着历史写法（未合并前的名字），统一映射到身份键再比对
  const ignored = new Set((state.settings?.ignoredModels || []).map(identityOf))
  const rows = knownModels()
  const q = ignoredQuery.trim().toLowerCase()
  // 搜索要匹配展示名和它的所有写法
  const shown = rows.filter(
    (row) =>
      !q ||
      row.display.toLowerCase().includes(q) ||
      row.names.some((name) => name.toLowerCase().includes(q)),
  )
  const groups = groupModels(shown)
  igGroupNames = new Map(groups.map((g) => [g.key, g.items.map((row) => row.id)]))
  // 搜索后选中的组可能被滤掉：滤没了就回落到未选中（右侧给提示）
  const selected = groups.find((g) => g.key === igSelected) || null
  title.textContent = t('忽略模型')
  const chipOf = (row) => {
    const on = ignored.has(row.id)
    return `<button type="button" class="badge ig-chip${on ? ' ig-on' : ' ig-off'}"
      data-act="toggle-ig-model" data-id="${esc(row.id)}" aria-pressed="${on}"
      title="${on ? esc(t('点击显示：恢复参与比价、决策、探针和网关')) : esc(t('点击忽略：不参与比价、决策、探针和网关'))}"
    >${on ? t('已忽略') : t('已显示')}</button>`
  }
  body.innerHTML = `
    <p class="hint" style="margin:0 0 10px">
      ${t('点左边的模型组，在右边逐个开关：灰「已忽略」不参与比价、决策、探针和网关；橙黄「已显示」在用。')}
    </p>
    <div class="toolbar" style="margin-bottom:8px">
      <input id="ig-search" class="search" type="search" placeholder="${t('搜索模型名…')}" value="${esc(ignoredQuery)}" />
      <span class="hint" style="margin:0">${t('{n} / {total} 个模型', { n: shown.length, total: rows.length })}</span>
    </div>
    <div class="ig-split">
      <div class="ig-pane-left">
        ${groups
          .map(
            (group) => `
          <button type="button" class="ig-vendor-row${group.key === igSelected ? ' active' : ''}"
            data-ig-pick="${esc(group.key)}">
            <span class="ig-vendor">${esc(group.label)}</span>
            <span class="hint">${t('{n} 个模型', { n: group.items.length })}${
              group.ignoredCount ? ` · ${t('已忽略 {n}', { n: group.ignoredCount })}` : ''
            }</span>
          </button>`,
          )
          .join('')}
      </div>
      <div class="ig-pane-right">
        ${!selected
          ? `<p class="hint" style="margin:10px 4px">${t('点一个模型组，看里面的模型。')}</p>`
          : `
          <div class="ig-detail-head">
            <b>${esc(selected.label)}</b>
            <span class="hint">${t('{n} 个模型 · 已忽略 {m}', { n: selected.items.length, m: selected.ignoredCount })}</span>
            <span class="grow"></span>
            <button class="ghost tiny" data-ig-bulk="ignore" data-group="${esc(selected.key)}">${t('整组忽略')}</button>
            <button class="ghost tiny" data-ig-bulk="show" data-group="${esc(selected.key)}">${t('全部显示')}</button>
          </div>
          ${selected.items
            .map(
              (row) => `
            <div class="ig-model-row" title="${esc(row.names.join(' / '))}">
              <span class="mono">${esc(row.display)}${
                row.names.length > 1
                  ? ` <span class="badge">${t('合并 {n} 种写法', { n: row.names.length })}</span>`
                  : ''
              }</span>
              <span class="hint">${row.sites ? t('{n} 个站', { n: row.sites }) : t('已不在榜单里')}</span>
              <span class="grow"></span>
              ${chipOf(row)}
            </div>`,
            )
            .join('')}`}
      </div>
    </div>`
  modal.hidden = false
}

/** 整组忽略 / 全部显示：一次 PATCH，不打断在输入框里的搜索词 */
async function bulkIgnoreGroup(key, ignore) {
  const ids = igGroupNames.get(key) || []
  const current = new Set((state.settings?.ignoredModels || []).map(identityOf))
  for (const id of ids) (ignore ? current.add : current.delete).call(current, id)
  try {
    state = await api('PATCH', '/api/settings', { ignoredModels: [...current] })
    render()
    openIgnoredModels()
    toast(
      ignore
        ? t('已忽略「{name}」全部模型', { name: vendorLabel(key) })
        : t('已恢复「{name}」全部模型', { name: vendorLabel(key) }),
    )
  } catch (error) {
    toast(String(error), true)
  }
}

async function toggleIgnoredModel(name, checked) {
  // name 传进来就是身份键；名单统一存身份键，忽略才会「一处生效到所有写法」
  const current = new Set((state.settings?.ignoredModels || []).map(identityOf))
  if (checked) current.add(identityOf(name))
  else current.delete(identityOf(name))
  try {
    state = await api('PATCH', '/api/settings', { ignoredModels: [...current] })
    render()
    const label = displayModel(name)
    toast(checked ? t('已忽略 {name}', { name: label }) : t('已显示 {name}', { name: label }))
  } catch (error) {
    toast(String(error), true)
  }
}

// --------------------------------------------------------------- 同模型合并

/**
 * 合并弹窗。
 *
 * 两块内容：
 *   1. 已归并：规则（大小写 / 4-5 ↔ 4.5 / v 前缀 / 日期尾巴）自动归到一起的名字，可单个拆开
 *   2. 疑似：形状被剥到「同一族」但规则没合的名字（典型：-thinking / -highspeed 尾巴），
 *      给个一键合并——这类可能真不是同一个模型（高速版常贵一倍），所以要人点确认
 */
function openModelMerge() {
  const modal = $('#prov-modal')
  const title = $('#prov-modal-title')
  const body = $('#prov-modal-body')
  if (!modal || !body) return
  const data = state.modelMerge || { groups: [], suggestions: [], aliasCount: 0, aliases: {} }
  const aliasCount = Number(data.aliasCount) || 0
  title.textContent = t('同模型合并')

  const siteCount = (offers) => new Set((offers || []).map((o) => o.providerId)).size

  const groupHtml = data.groups.length
    ? data.groups
        .map((group) => {
          const members = group.members
            .map((m) => {
              const manual = Object.prototype.hasOwnProperty.call(data.aliases || {}, m.name)
              return `<div class="ig-row ig-child">
                <span class="mono" style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.name)}</span>
                <span class="hint">${t('{n} 个站', { n: m.sites })}</span>
                <button class="ghost tiny" data-act="merge-split" data-name="${esc(m.name)}" title="${t('让它自成一档，不再和别的写法合并')}">拆开</button>
                ${manual ? `<span class="badge">${t('手动')}</span>` : ''}
              </div>`
            })
            .join('')
          return `<div class="ig-group">
            <div class="ig-row ig-group-head">
              <span class="mono" style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(group.display || group.id)}</span>
              <span class="hint">${t('{n} 种写法 · {s} 个站', { n: group.members.length, s: siteCount(group.offers) })}</span>
            </div>
            <div class="ig-children">${members}</div>
          </div>`
        })
        .join('')
    : `<p class="hint" style="margin:6px 0 0">${t('没有需要归并的名字：每个模型在名下都只有一种写法。')}</p>`

  const suggestionHtml = data.suggestions.length
    ? data.suggestions
        .map((sug) => {
          const target = sug.target || sug.loose
          const speed = sug.reason === 'speed'
          // 按「当前身份」分组显示：用户要看清「现在它是几个模型，合并后变成一个」，
          // 平铺一串名字会让人以为所有名字都要重组
          const byId = new Map()
          for (const m of sug.members) {
            if (!byId.has(m.id)) byId.set(m.id, [])
            byId.get(m.id).push(m)
          }
          const rows = [...byId.entries()]
            .map(([id, list]) => {
              const names = list.map((m) => m.name).join(' / ')
              const sites = list.reduce((sum, m) => sum + m.sites, 0)
              const already = id === target
              return `<div class="ig-row ig-child">
                <span class="mono" style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(names)}</span>
                <span class="hint">${t('{n} 个站', { n: sites })}</span>
                ${already ? `<span class="badge ok">${t('已在此组')}</span>` : ''}
              </div>`
            })
            .join('')
          const names = sug.members.map((m) => m.name)
          return `<div class="ig-group">
            <div class="ig-row ig-group-head">
              <span class="mono" style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(target)}</span>
              ${speed ? `<span class="badge warn" title="${t('高速版/极速版通常单独计价，合并前先确认价格')}">${t('可能不同价')}</span>` : ''}
              <span class="hint">${t('{n} 个模型 · {m} 种写法', { n: byId.size, m: sug.members.length })}</span>
              <button class="ghost tiny" data-act="merge-do" data-names="${esc(JSON.stringify(names))}" data-target="${esc(target)}">${t('合并成一个')}</button>
            </div>
            <div class="ig-children">${rows}</div>
          </div>`
        })
        .join('')
    : `<p class="hint" style="margin:6px 0 0">${t('没有疑似未合并的写法。')}</p>`

  body.innerHTML = `
    <p class="hint" style="margin:0 0 12px">
      ${t('同一个模型在不同站写法不一（少个 v、点写成横线、带日期尾巴）时，网关会把它们当成两个模型。已归并的名字在比价、智能决策和网关模型清单里当作同一个模型。写给上游的模型名不受影响。')}
    </p>
    <h4 class="section-title" style="margin-top:0">${t('已归并')}${data.groups.length ? `（${data.groups.length}）` : ''}</h4>
    <div class="ig-list">${groupHtml}</div>
    <h4 class="section-title">${t('疑似还没合并')}${data.suggestions.length ? `（${data.suggestions.length}）` : ''}</h4>
    <p class="hint" style="margin:0 0 8px">
      ${t('这些名字差在 -thinking / -preview / -highspeed 这类尾巴上：可能只是叫法不同，也可能是真的不同型号（高速版常贵一倍）。确认价格后再合。')}
    </p>
    <div class="ig-list">${suggestionHtml}</div>
    ${aliasCount ? `<p class="hint" style="margin-top:12px">${t('当前有 {n} 条手动合并。', { n: aliasCount })}<button class="ghost tiny" data-act="merge-reset">${t('全部恢复自动')}</button></p>` : ''}`
  modal.hidden = false
}

/** 执行合并：把 data-names 里的名字全指到 target（target 是规整后的合并键） */
async function doMergeModels(button) {
  const names = JSON.parse(button.dataset.names || '[]')
  const target = button.dataset.target || names[0]
  if (!names.length || !target) return
  await withBusy(button, async () => {
    try {
      state = await api('POST', '/api/models/merge', { names, target })
      render()
      openModelMerge()
      toast(t('已合并 {n} 种写法到「{name}」', { n: names.length, name: target }))
    } catch (error) {
      toast(String(error), true)
    }
  })
}

// --------------------------------------------------------------- 决策视图

// 不可用的原因。「冷却」只留给真正的上游冷却（限流）：余额不足是账单问题，
// 写成「冷却中」等于把「去充值」藏起来，用户根本不知道该干什么。
const BLOCKED_LABEL = {
  quota: '余额不足',
  budget: '单次请求超限',
  'rate-limit': '上游账号冷却中',
  'model-missing': '该分组没有这个模型',
  'protocol-unsupported': '不支持该协议',
  'error-rate': '失败率过高',
}
/**
 * 不可用状态的徽章文案：原因 + 该做什么。
 *
 * pending=false —— 等待窗口内，等时间到
 * pending=true  —— 窗口到了，等一次成功调用确认恢复（路由仍然不放行）
 */
function blockedLabel(blocked, { pending = false } = {}) {
  const kind = blocked?.kind
  const label = BLOCKED_LABEL[kind] || '暂时不可用'
  // 余额不足：不叫冷却，直接告诉人该去充值
  if (kind === 'quota') return t(pending ? '余额不足 · 等确认恢复' : '余额不足 · 请充值')
  return `${t(label)} · ${t(pending ? '等确认恢复' : '冷却中')}`
}

// 状态标签的文案与配色。kind 由 core/router.js#admissionTags 判定，这里只负责画——
// 判定不留第二份，否则两个页面迟早对不上。
// 一条供给可能同时有好几条毛病（又慢又掉包），所以状态是一串标签，不是单选。
const STATUS_TAG = {
  slow: { label: '慢速', cls: 'danger' },
  degraded: { label: '结果可疑', cls: 'warn' },
  unstable: { label: '不稳定', cls: 'danger' },
  'no-evidence': { label: '没有可信样本', cls: 'warn' },
  unverified: { label: '待验证（曾余额不足）', cls: '' },
  inconclusive: { label: '证据不足', cls: '' },
  blocked: { label: '冷却中', cls: 'warn' },
  depleted: { label: '余额不足', cls: 'danger' },
  detoured: { label: '临时改道', cls: 'warn' },
  billing: { label: '余额不足 · 请充值', cls: 'danger' },
  'awaiting-recovery': { label: '等确认恢复', cls: 'warn' },
  fallback: { label: '兜底', cls: '' },
  // 余额：来自站点余额读数（持久化数据），欠费红、预警黄；欠费已挡准入
  'balance-empty': { label: '余额不足', cls: 'danger' },
  'balance-warn': { label: '余额告警', cls: 'warn' },
  // 空回复：近 1 小时发生过空回合（含补全救回来的）。只是给人看的提醒，
  // 本地补全还在正常给出结果，不因此改道
  'empty-reply': { label: '空回复', cls: 'warn' },
  ok: { label: '可用', cls: 'ok' },
}

/**
 * 把服务端给的标签清单画成一串徽章：该标的都标，不是挑一个。
 *
 * @param {string[]} tags core/router.js#admissionTags 的返回
 * @param {{blocked?:object, hide?:string[]}} options
 *   blocked  —— 冷却/待复测的具体原因（额度不足 / 限流中…），措辞统一走 blockedLabel；
 *               待复测时传 pendingRecovery 那个对象也行（blockedLabel 只读 kind）
 *   hide     —— 不画的标签。比价页那种价格表里「可用」是默认状态、「兜底」是
 *               决策页的概念（谁先派活），标在价目表上只是噪声
 */
function statusBadges(tags, { blocked = null, hide = [] } = {}) {
  const kinds = Array.isArray(tags) ? tags : []
  const html = kinds
    .filter((kind) => !hide.includes(kind))
    .map((kind) => {
      const spec = STATUS_TAG[kind]
      if (!spec) return `<span class="badge">${esc(kind)}</span>`
      const label =
        kind === 'blocked'
          ? blockedLabel(blocked)
          : kind === 'awaiting-recovery'
            ? blockedLabel(blocked, { pending: true })
            : t(spec.label)
      return `<span class="badge${spec.cls ? ` ${spec.cls}` : ''}">${label}</span>`
    })
  return html.join(' ')
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
      <div class="empty"><h3>还没有可决策的模型</h3><p>先去站点卡的「定价修改」给模型填上价格。</p></div>`
    return
  }

  // 比价页并入了本页：这两个入口（同模型合并 / 忽略模型）是从比价工具栏搬来的
  const ignoredCount = (state.settings?.ignoredModels || []).length
  const mergeGroupCount = (state.modelMerge?.suggestions || []).length

  const filterText = filters.decision.trim().toLowerCase()
  // 搜索要能搜到任何一种写法：合并后 modelKey 是身份键，用户记住的多半是站上那个名字
  const matchedDecisions = decisions.filter((decision) => {
    if (!filterText) return true
    const haystack = [decision.modelKey, decision.display, ...(decision.variants || [])]
    return haystack.filter(Boolean).some((name) => String(name).toLowerCase().includes(filterText))
  })
  // 「只显示可使用」按服务端下发的 admission 过滤：门禁结论只有
  // core/router.js#admissionOf 一份，前端不自己再拼一遍「什么算不可用」。
  // admission 缺失时（旧后端）不隐藏：宁可多显示，也不要静默吞掉供给。
  let hiddenCandidates = 0
  let visibleDecisions = matchedDecisions
  if (decisionOnlyAdmitted) {
    visibleDecisions = []
    for (const decision of matchedDecisions) {
      const candidates = decision.candidates.filter((candidate) => {
        const ok = candidate.admission?.ok !== false
        if (!ok) hiddenCandidates += 1
        return ok
      })
      // 候选全被隐藏的模型整块收起，不然满屏都是「没有可用供给」的空壳
      if (candidates.length > 0) visibleDecisions.push({ ...decision, candidates })
    }
  }
  // 当前决策侧重：三档只改排序口径，准入规则不跟着变（见 core/decision-mode.js）
  const mode = state.decisionMode || state.settings?.decisionMode || 'value'
  const sortMark = (key) => (mode === key ? ' sort-by' : '')


  const blocks = visibleDecisions.map((decision) => {
    const panelKey = `decision:${decision.modelKey}`
    const isCollapsed = collapsedPanels.has(panelKey)
    // 「合并后这个模型到底有几种写法、分别是谁」必须在决策页也能看见：
    // 同一行里 8 条候选来自两个站名，不标出来用户会以为候选重复了。
    // 展示名用来比对，命中说明这一站的写法就是常用写法，没必要在行里重复一遍
    const shownName = decision.display || decision.modelKey
    const variants = decision.variants || []
    // 多数派写法：行内只标少数派（哪种写法是「另一种叫法」得一眼看出来，
    // 而 8 行重复同一个名字纯属噪音）
    const spellingCount = new Map()
    for (const c of decision.candidates) {
      const name = String(c.upstreamName || '')
      if (!name) continue
      spellingCount.set(name, (spellingCount.get(name) || 0) + 1)
    }
    let dominant = ''
    let dominantCount = -1
    for (const [name, count] of spellingCount) {
      if (count > dominantCount) {
        dominant = name
        dominantCount = count
      }
    }
    const rows = decision.candidates.map((candidate, index) => {
      // 评分过期：首字是旧证据，不作数——列里不给数字，给一个灰色「评分过期」，
      // 免得人拿一个过期值当现状（准入是放行的，真实调用本身就是刷新证据）
      const stale = candidate.status === 'stale'
      const badges = statusBadges(candidate.tags, {
        blocked: candidate.blocked || candidate.pendingRecovery,
      })
      const isChosen = candidate.offerId === decision.chosenOfferId
      // 官方参照（比价页并进来的那套）：分子分母都是综合成本（同口径），
      // 不是质量加权后的 effective——那个和官方比不出「几折」的意思
      const officialPct =
        decision.official &&
        decision.official.blendedCnyPerMtok > 0 &&
        candidate.blendedCnyPerMtok !== null
          ? (candidate.blendedCnyPerMtok / decision.official.blendedCnyPerMtok) * 100
          : null
      const officialPctText =
        officialPct === null ? '' : officialPct < 1 ? '<1%' : `${Math.round(officialPct)}%`
      // 整行可点 = 勾它为当前使用（点选逻辑见文件尾部的 pointerup 分支）：
      // 只改勾选，顺序不动；能不能真发出去看状态列，失败了网关会往后转移
      return `
        <tr class="dec-row${isChosen ? ' cheapest' : ''}" data-offer="${esc(candidate.offerId)}" title="${t('点击勾选这一行为当前使用（再点一下取消勾选），顺序不动')}">
          <td class="dec-grip-cell"><span class="dec-grip" title="${t('拖动调整顺序')}">${icon('grip')}</span></td>
          <td class="num" style="color:var(--faint)">${index + 1}</td>
          <td>${esc(candidate.providerName || '—')}${isChosen ? ' <span class="badge ok">当前</span>' : ''}${
            candidate.faulted ? ` <span class="badge danger failover-badge" title="${t('外部监控上报了真实故障（探针没测到也以监控为准），已故障转移；保持期过后若仍是全场第一会自动提回')}">${t('故障转移')}</span>` : ''
          }${
            // 只标少数派写法：多数派每行重复一遍没信息量，
            // 而少数派恰恰是「为什么要合并」的证据，不能省
            candidate.upstreamName && dominant && candidate.upstreamName !== dominant
              ? `<div class="sub mono">${t('该站写作 {name}', { name: candidate.upstreamName })}</div>`
              : ''
          }</td>
          <td>${candidate.group ? `<span class="badge ${groupChipOf(candidate.providerId, candidate.group)}">${esc(candidate.group)}</span>` : '<span style="color:var(--faint)">默认</span>'}</td>
          <td class="num${sortMark('price')}">${candidate.price === null ? '—' : priceText(candidate.price)}</td>
          <td class="num">${candidate.quality === null ? '—' : candidate.quality.toFixed(2)}${
            candidate.confidence && candidate.confidence !== 'high'
              ? `<div class="sub">${candidate.samples} ${t('样本')}</div>`
              : ''
          }</td>
          <td class="num${sortMark('value')}">${candidate.effective === null ? '—' : priceText(candidate.effective)}${
            // 官方参照（比价页并进来的那套）：本行综合成本是原厂有效成本的几折。
            // 与原比价页同口径：分子分母都是「输入25%/输出75%」加权的综合成本，
            // 不拿质量加权后的 effective 去比——那会比出另一个意思
            officialPct === null
              ? ''
              : `<div class="sub" title="${esc(t('本行综合成本为原厂有效成本的 {pct}（按波峰口径）', { pct: officialPctText }))}">${t('原厂')} ${officialPctText}</div>`
          }</td>
          <td class="num${sortMark('speed')}">${
            stale
              ? `<span class="badge" title="${t('评分已过期：超过有效期没重新探测，首字是旧证据，不作数')}">${t('评分过期')}</span>`
              : candidate.ttftMs === null
                ? '—'
                : `${candidate.ttftMs}ms`
          }</td>
          <td class="num${sortMark('priceSpeed')}">${priceSpeedText(candidate)}</td>
          <td>${badges}${candidate.statusReason ? `<div class="sub">${esc(candidate.statusReason)}</div>` : ''}</td>
        </tr>`
    }).join('')

    return `
      <div class="table-wrap" data-model="${esc(decision.modelKey)}">
        <div class="group-head">
          <button class="ghost tiny" data-act="toggle-panel" data-panel="${esc(panelKey)}">${isCollapsed ? '▸' : '▾'}</button>
          <span class="model mono">${esc(shownName)}</span>
          ${variants.length > 1 ? `<span class="badge" title="${t('这些站里同一个模型有 {n} 种写法，已合并成一个模型一起排序', { n: variants.length })}：${esc(variants.join(' / '))}">${t('已合并 {n} 种写法', { n: variants.length })}</span>` : ''}
          <span class="spread">${decision.chosenProviderName
            ? `当前选 ${esc(decision.chosenProviderName)}${
                decision.chosenGroup
                  ? ` <span class="badge ${groupChipOf(decision.chosenProviderId, decision.chosenGroup)}" title="${esc(decision.chosenGroup)}">${esc(decision.chosenGroup)}</span>`
                  : ''
              }`
            : '没有可用供给'}</span>
          ${officialChipHtml(decision.official)}
          ${autorouteScopeButton(decision)}
          ${decision.manual ? '<button class="ghost tiny" data-act="reset-order">恢复自动</button>' : ''}
        </div>
        ${isCollapsed ? '' : `
        <table>
          <thead><tr>
            <th style="width:30px"></th><th class="num">#</th><th>站点</th><th>分组</th>
            <th class="num${sortMark('price')}">价格</th><th class="num">质量</th>
            <th class="num${sortMark('value')}">有效成本</th><th class="num${sortMark('speed')}">首字</th><th class="num${sortMark('priceSpeed')}">价速比</th><th>状态</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`}
      </div>`
  }).join('')

  // 有多个模型是被合并过的：说明这里的候选池跨了站点的不同写法，
  // 否则用户看到同一模型 8 条候选里有两套名字会以为是重复数据
  const mergedCount = decisions.filter((d) => (d.variants || []).length > 1).length
  const mergedHint = mergedCount
    ? `<p class="hint">${t('其中 {n} 个模型在不同站写法不一（少个 v、点写成横线等），已按同一个模型合并排序——候选里会标出「该站写作…」的那种少数派写法。要调整合并关系，点右上角「同模型合并」。', { n: mergedCount })}</p>`
    : ''

  view.innerHTML = `
    ${modeCard(mode)}
    ${gateCard()}
    <div class="toolbar">
      <input id="decision-search" class="search" type="search" placeholder="搜索模型名…" value="${esc(filters.decision)}" />
      <span class="hint" style="margin:0">${
        decisionOnlyAdmitted && hiddenCandidates
          ? t('{shown} / {total} 个模型 · 已隐藏 {n} 条供给', {
              shown: visibleDecisions.length,
              total: decisions.length,
              n: hiddenCandidates,
            })
          : t('{shown} / {total} 个模型', { shown: visibleDecisions.length, total: decisions.length })
      }</span>
      <label class="switch switch-inline" title="${t('打开后只显示准入通过的供给：慢速 / 结果可疑 / 不稳定 / 没有可信样本 / 冷却中（额度不足、限流）整行隐藏；评分过期、未探测的仍然显示（它们不是坏站）。只是展示筛选，不影响网关派活和手动顺序。随时可切。')}">
        <input type="checkbox" id="decision-only-admitted" ${decisionOnlyAdmitted ? 'checked' : ''} />
        <span class="switch-track"><span class="switch-knob"></span></span>
        <span class="switch-text"><b>${t('只显示可使用')}</b></span>
      </label>
      <span class="grow"></span>
      <button class="with-icon" data-act="merge-models" title="${t('把同一个模型的不同写法归到一起（少个 v、点写成横线、带日期尾巴）')}">
        ${icon('swap')}${t('同模型合并')}${mergeGroupCount ? ` ${mergeGroupCount}` : ''}
      </button>
      <button class="with-icon" data-act="ignored-models" title="${t('忽略后不再参与比价、智能决策、探针和网关')}">
        ${icon('eye-off')}${t('忽略模型')}${ignoredCount ? ` ${ignoredCount}` : ''}
      </button>
    </div>
    <p class="hint">排序按上面的「决策侧重」。拖动整行（或最左边的把手）能改默认先后（没勾选时按这个派活）；点一下整行就是勾它为当前使用——顺序不动，再点一下取消勾选。勾选 &gt; 拖的先后 &gt; 自动排序。</p>
    <p class="hint">${t('注意：<b>同一个模型在不同站的状态是各自独立的</b>（A 站健康、B 站掉包很正常），所以这里按「站 × 模型」逐条评估，状态下方会写明具体原因。')}</p>
    ${mergedHint}
    ${blocks ||
    (decisionOnlyAdmitted && hiddenCandidates
      ? `<div class="empty"><h3>${t('没有允许放行的供给')}</h3><p>${t('当前范围内有 {n} 条供给被这个开关隐藏了：慢速、结果可疑、不稳定、没有可信样本或冷却中。关掉开关就能看到它们。', { n: hiddenCandidates })}</p></div>`
      : '')}`
}

/**
 * 决策侧重四档：性价比 / 价格 / 首字速度 / 价速比。
 *
 * 形态上刻意和「慢速档位限制」那条刻度条不一样：那边是 20 格的滑轨（同一个维度上的
 * 程度），这边是四段长条（互斥的四种价值观）——档位不是程度，分段比滑轨诚实，
 * 也不会让人以为四档之间还有「半档」这种不存在的东西。
 *
 * 标签和说明由服务端 /api/state 的 decisionModes 下发，浏览器不另抄一份。
 * 自动路由接管中，档位条旁直接显示当前被派活的模型：接管的意义就是
 * 「这个档位选出的全场最优」，不告诉用户是哪个，开关就和黑盒没两样。
 */
function modeCard(mode) {
  const modes = state.decisionModes?.length
    ? state.decisionModes
    : [
        { key: 'value', label: '性价比', hint: '价格 ÷ 质量', desc: '' },
        { key: 'price', label: '价格', hint: '名义单价', desc: '' },
        { key: 'speed', label: '首字速度', hint: '首字延迟', desc: '' },
        { key: 'priceSpeed', label: '价速比', hint: '价格 ÷ 首字延迟', desc: '' },
      ]
  return `
    <div class="card mode-card">
      <div class="mode-head">
        <span class="mode-label">${t('决策侧重')}</span>
        <span class="mode-note">${t('只改「谁排前面」，不放开准入')}</span>
      </div>
      <div class="mode-bar" role="tablist">
        ${modes
          .map(
            (item) => `
          <button class="mode-seg${item.key === mode ? ' active' : ''}" role="tab"
            aria-selected="${item.key === mode}" data-act="set-decision-mode" data-mode="${esc(item.key)}"
            ${item.desc ? `title="${esc(item.desc)}"` : ''}>
            <span class="mode-seg-label">${esc(item.label)}</span>
            <span class="mode-seg-hint">${esc(item.hint)}</span>
          </button>`,
          )
          .join('')}
      </div>
    </div>`
}

/**
 * 「正在使用」胶囊：接管记录里的模型 + 它此刻的实际选中供给（决策快照同一份）。
 * 放在自动路由开关旁边（慢速档位条右侧）——开关开不在开、在开什么，一眼看完。
 * 供给在快照里找不到（刚下线 / 还没发过请求）时只报模型名，不硬编。
 */
function routeNowPill() {
  if (!state.autoRoute?.enabled) return ''
  const takeover = state.autoRoute
  // 决策页的 modelKey 是**身份键**（deepseek-4.1-flash），自动路由记录的是
  // **存储键**（deepseek-v4.1-flash）：两边先过身份键再比，否则永远匹配不上，
  // 站名和分组就一直是空的（2026-10-29 实测）
  const want = identityOf(takeover.modelKey || '')
  const decision = (state.decisions || []).find(
    (d) => identityOf(d.modelKey) === want && (!takeover.offerId || d.chosenOfferId === takeover.offerId),
  ) || (state.decisions || []).find((d) => identityOf(d.modelKey) === want)
  const winner = decision
    ? (decision.candidates || []).find((c) => c.offerId === decision.chosenOfferId)
    : null
  // 站名 + 分组是「到底在用谁」的关键：只给模型名等于没说（同名模型散在
  // 十几个分组里，价和速度能差几倍）
  const provider = winner?.providerName || null
  const group = winner?.group || ''
  const where = provider
    ? `<span class="route-now-where">${esc(provider)}${group ? ` · ${esc(group)}` : ''}</span>`
    : `<span class="route-now-where dim">${t('定位中…')}</span>`
  const tip = t('自动路由正在把全部请求派给这条供给（当前档位下全场最优）')
  return `<span class="route-now" title="${esc(tip)}">${t('正在使用')}<b class="mono">${esc(takeover.modelKey || '—')}</b>${where}</span>`
}

/**
 * 决策页分组头上的自动路由范围按钮（加号）。
 *
 * 默认（一个都不勾）自动路由在**全场所有模型**里挑最优；点加号勾上这个模型后，
 * 自动路由只在勾选的那几个里挑。再点一次移出。勾选的是分组键（身份键口径），
 * 服务端按身份键匹配——站点把同一模型写成别的名字也能勾得住。
 */
function autorouteScopeButton(decision) {
  const scope = Array.isArray(state.autoRoute?.scope) ? state.autoRoute.scope : []
  const enrolled = scope.includes(decision.modelKey)
  const title = enrolled
    ? t('已加入自动路由：自动路由只在勾选的模型里挑。点击移出')
    : t('加入自动路由：勾选后自动路由只在勾选的模型里挑；一个都不勾 = 全场都参选')
  return `
    <button class="ghost tiny ar-scope${enrolled ? ' active' : ''}" data-act="toggle-autoroute"
      data-model="${esc(decision.modelKey)}" title="${esc(title)}"
      aria-pressed="${enrolled}">${icon('plus')}</button>
    ${enrolled ? `<span class="badge ok" title="${esc(title)}">${t('自动路由')}</span>` : ''}`
}

/**
 * 漂移监视器状态行：真实价速比现值 vs 基线的漂移幅度，供作者直接看到
 * 「后台实打实的分」和探针基础分的关系。数据来自 daemon/drift-watcher.js
 * 的快照（tick 每分钟算一次，这里纯展示）。
 */
function driftStatusLine() {
  const snap = state.drift
  if (!snap?.evaluation) return ''
  const e = snap.evaluation
  const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%` : '')
  if (e.verdict === 'insufficient') {
    return `<span class="sub" title="${esc(t('真实价速比每 10 分钟一窗，窗口内至少 5 单才开始判漂移；探针开工全量 + 每小时 Lite 负责基础分'))}">${t('实时分样本 {n}/5', { n: e.samples })}</span>`
  }
  // 分项定位：综合漂移里首字和吐字各贡献多少（解耦型劣化一眼看出烂在哪半边）
  const parts = []
  if (Number.isFinite(e.ttftDrift)) parts.push(`${t('首字')} ${pct(e.ttftDrift)}`)
  if (Number.isFinite(e.tpsDrift)) parts.push(`${t('吐字')} ${pct(e.tpsDrift)}`)
  const tip = esc(
    t('真实总耗时（首字+吐字）比 {n} 小时基线的漂移；慢出 30% 自动改派', { n: 6 }) +
      (parts.length > 0 ? ` · ${parts.join(' / ')}` : ''),
  )
  if (e.verdict === 'drifted') {
    const demotedNote = (snap.demoted || []).length > 0 ? t('，降级 {n} 条', { n: snap.demoted.length }) : ''
    return `<span class="sub"><span class="badge warn" title="${tip}">${t('漂移 {n}', { n: pct(e.drift) })}</span>${esc(demotedNote)}</span>`
  }
  return `<span class="sub"><span class="badge ok" title="${tip}">${t('实时 {n}', { n: pct(e.drift) })}</span></span>`
}

/**
 * 自动路由（一键接管）：权限在决策侧重之上的总开关。
 *
 * 形态是小开关，塞在慢速档位条右侧的空档里——它不是又一个档位，不值得单独
 * 一张卡；但它是「要不要把派活权整个拿走」，所以开关旁带个问号圈，悬浮
 * 就能看到完整介绍。接管之后档位条仍然可切（切了会立刻按新档位重选），
 * 但客户端请求什么模型就再也不重要了。免费入口不接管：把免费请求偷偷
 * 改派到付费模型等于静默扣钱。
 */
/**
 * 轮巡进度：自动路由开着时，探测由轮巡接管，一轮 60 秒起步。
 * 不做这个指示，用户在探针页看到的是一片静止，会以为「没在跑」。
 */
function patrolBadge() {
  const p = state.probePatrol
  if (!state.autoRoute?.enabled) return ''
  if (!p) return ''
  const minAgo = (ts) => Math.max(0, Math.round((Date.now() - ts) / 60000))
  if (p.running) {
    return `<span class="badge" title="${esc(t('轮巡正在进行：按节奏探测「现役模型 + 可能接替它的几个」的供给'))}">${t('轮巡中 {n} 条…', { n: p.passTargets || 0 })}</span>`
  }
  if (p.lastDoneAt) {
    const st = p.lastDoneTotal > 0 ? `${p.lastDoneOk}/${p.lastDoneTotal}` : '—'
    // 预计下一轮 = 上一轮完成 + 轮巡间隔（间隔由服务端下发，不在前端另写一份）
    const nextAt = p.passIntervalMs ? p.lastDoneAt + p.passIntervalMs : null
    const nextIn = nextAt ? Math.max(0, Math.round((nextAt - Date.now()) / 60000)) : null
    const nextText =
      nextIn === null
        ? ''
        : nextIn <= 0
          ? t('· 下一轮随时开始')
          : t('· 下一轮约 {n} 分钟后', { n: nextIn })
    return `<span class="badge ok" title="${esc(t('上一轮轮巡 {m} 分钟前完成：成功 {ok} / 共 {n} 条。{next}', { m: minAgo(p.lastDoneAt), ok: st, n: p.lastDoneTotal, next: nextText }))}">${t('轮巡 {m} 分钟前 · {ok}/{n}', { m: minAgo(p.lastDoneAt), ok: st, n: p.lastDoneTotal })}${esc(nextText)}</span>`
  }
  return `<span class="badge" title="${esc(t('轮巡待命：自动路由在等真实流量，第一条请求进来几秒后自动开跑'))}">${t('轮巡待命')}</span>`
}

function autoRouteSwitch() {
  const enabled = Boolean(state.autoRoute?.enabled)
  const scope = Array.isArray(state.autoRoute?.scope) ? state.autoRoute.scope : []
  const scopeHint =
    scope.length > 0
      ? `<span class="sub" title="${t('没有勾选的模型 = 回到全场。去智能决策页每个模型组上的加号增减')}">${t('接管范围：{n} 个勾选模型，其余不参选', { n: scope.length })}</span>`
      : ''
  return `
    <label class="switch switch-inline auto-route-inline">
      <input type="checkbox" id="auto-route-switch" ${enabled ? 'checked' : ''} />
      <span class="switch-track"><span class="switch-knob"></span></span>
      <span class="switch-text"><b>${t('自动路由')}</b></span>
    </label>
    ${scopeHint}
    ${driftStatusLine()}
    <span class="help-dot" tabindex="0" aria-label="${t('自动路由功能介绍')}" title="${t(
      '接管后，不管客户端请求哪个模型、怎么切模型，网关都只派给当前决策档位下全场最优的那一个模型——不分站点、不分分组、不分来自哪个站。若新模型只比现役好一点点（不到 15%），不切换：反复横跳对用户的干扰比那点收益大，只有明显更优或现役下线才换。免费入口不受影响。',
    )}">?</span>`
}

/**
 * 准入开关卡：慢速档位限制 + 放行可疑供给。
 *
 * 放这里的理由：智能决策就是「最后哪些模型能登场」的界面，门槛、候选、状态、
 * 排序应该在同一屏里，用户才能立刻看到「调高门槛之后还剩谁」。
 * 探针页只管取证（探什么、多久探一次），不碰准入——可疑供给放不放行
 * 曾经长在探针页，但它是准入开关，归这里管。
 */
function gateCard() {
  const maxTtft = Number(state.settings.maxTtftMs) || 0
  const tiers = state.ttftTiers || []
  const allowUntrusted = Boolean(state.settings.allowUntrusted)
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
        <span class="auto-route-side">
          ${autoRouteSwitch()}
          ${routeNowPill()}
          ${patrolBadge()}
        </span>
      </div>
      <div class="switch-row">
        <label class="switch">
          <input type="checkbox" id="allow-untrusted" ${allowUntrusted ? 'checked' : ''} />
          <span class="switch-track"><span class="switch-knob"></span></span>
          <span class="switch-text">
            <b>${t('放行可疑供给')}</b>
            <span>${t('开启后，判定可疑（指纹不符 / 输出截断 / 用量虚报）的站，也可正常登场。若在意可信度，请关闭。')}</span>
          </span>
        </label>
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
        ${p.error ? `<div class="detail-line danger">错误：${esc(p.error)}</div>` : ''}
      </div>
    </div>`
}

/** 改完暂停时段后的一句反馈：现在到底停不停、几点翻转 */
function pauseToast(pause) {
  if (!pause || !pause.count) return '已取消定时关闭，探测全天运行'
  if (pause.paused) return pause.until ? `已保存：现在暂停中，${pause.until} 恢复` : '已保存：全天暂停'
  return pause.next ? `已保存：现在照常探测，${pause.next} 起暂停` : '已保存'
}

/** 探针筛选后的目标：三个条件取交集，与表格展示同一份 state.offers（在役供给），口径一致 */
function probeFilteredOffers() {
  return state.offers.filter(
    (o) =>
      (!probeFilters.providerId || o.providerId === probeFilters.providerId) &&
      (!probeFilters.group || (o.group || '') === probeFilters.group) &&
      (!probeFilters.model || o.upstreamName === probeFilters.model),
  )
}

/**
 * 探针表列宽（probe-table-align）：每站一张表，宽度必须由列定义撑、不能由内容撑。
 * 以前是默认的 table-layout:auto，模型名一长第一列就变宽，状态和后面四个百分比列
 * 整体往右挪——同一个页面上各站点分组对不齐，看着歪。现在除了模型列吃剩余宽度，
 * 其余列全部钉成 px，所有站点表的列边界一致。
 */
const PROBE_COLS = `<colgroup>
            <col /><col style="width:132px" />
            <col style="width:78px" /><col style="width:78px" />
            <col style="width:78px" /><col style="width:78px" />
            <col style="width:76px" /><col style="width:96px" /><col style="width:86px" />
          </colgroup>`

function renderProbes() {
  const view = $('#view-probes')
  const providersWithOffers = state.providers.filter((p) => state.offers.some((o) => o.providerId === p.id))
  // 探针花费按需拉、半小时刷一次（见 loadProbeSpend）。没数据时先渲染个占位。
  void ensureProbeSpend()

  if (providersWithOffers.length === 0) {
    view.innerHTML = `
      <div class="empty">
        <h3>还没有可探测的模型</h3>
        <p>先在「站点」里同步模型列表，并加一个 Key。</p>
      </div>`
    return
  }

  const interval = Number(state.settings.probeIntervalMinutes) || 0
  // 连锁机制：自动路由开着时，定时探针由轮巡接管——下拉禁用 + 徽章说明，
  // 改了也不会跑（调度器侧有同一个门），不如不让人改
  const autoRouteOn = Boolean(state.autoRoute?.enabled)
  const maxAge = Number(state.settings.scoreMaxAgeHours) || 6
  const allowUntrusted = Boolean(state.settings.allowUntrusted)

  // 定时显示：整小时数用「小时」档，其余用「分钟」档；0 = 关闭
  const intervalUnit = interval > 0 && interval % 60 === 0 ? 60 : 1
  const intervalValue = intervalUnit === 60 ? interval / 60 : interval
  const intervalLock = autoRouteOn
    ? `disabled title="${esc(t('自动路由开着时定时探针不跑：轮巡每 30 分钟接替探测，关掉自动路由后这里自动恢复生效'))}"`
    : ''
  const pause = state.probePause || { paused: false, until: null, next: null, count: 0 }
  // 暂停状态由服务端算（state.probePause），这里只管显示，跨夜 / 多段重叠的判断
  // 不在浏览器里再写一遍。控件和「自动探测 / 评分有效期」同一行：什么时候探、
  // 证据活多久、什么时候不探

  const pauseWindows = Array.isArray(state.settings.probePauseWindows) ? state.settings.probePauseWindows : []
  const pauseBadge = pause.paused
    ? `<span class="badge warn">暂停中</span><span class="pause-note">${
        pause.until ? `将于 ${pause.until} 自动恢复探测` : '全天暂停，改配置才会恢复'
      }</span>`
    : pause.next
      ? `<span class="badge ok">探测中</span><span class="pause-note">下次暂停 ${pause.next}</span>`
      : `<span class="badge">无时段</span><span class="pause-note">全天运行</span>`
  const pauseRows = pauseWindows
    .map(
      (w) => `
        <span class="pause-row" data-pause="${esc(w.id)}">
          <input type="time" data-pause-field="start" value="${esc(w.start)}" title="${esc(t('暂停开始'))}" />
          <span class="sep">–</span>
          <input type="time" data-pause-field="end" value="${esc(w.end)}" title="${esc(t('恢复时间（不含）'))}" />
          <button class="ghost tiny danger" data-act="del-pause-window" title="${esc(t('删除这一段'))}">×</button>
        </span>`,
    )
    .join('')

  // 筛选下拉的选项做级联：选了站点，分组/模型只列该站点下的；选了分组，模型只列该分组下的。
  // 三个条件互不排斥，可以只用一个，也可以叠到「某站 × 某分组 × 某模型」= 单个供给。
  const groupOpts = [...new Set(state.offers.filter((o) => !probeFilters.providerId || o.providerId === probeFilters.providerId).map((o) => o.group || ''))].filter(Boolean).sort()
  const modelOpts = [...new Set(state.offers.filter((o) => !probeFilters.providerId || o.providerId === probeFilters.providerId).filter((o) => !probeFilters.group || (o.group || '') === probeFilters.group).map((o) => o.upstreamName))].sort()
  const probeTargets = probeFilteredOffers()
  const probeFiltered = probeFilters.providerId || probeFilters.group || probeFilters.model
  const probeBtn = probeFiltered ? t('探测所选（{n} 个）', { n: probeTargets.length }) : t('探测全部（{n} 个）', { n: probeTargets.length })
  const filterSelect = (field, allLabel, options, current) => `
    <select data-probe-filter="${field}">
      <option value="">${esc(allLabel)}</option>
      ${options
        .map(
          ({ v, label }) =>
            `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(label)}</option>`,
        )
        .join('')}
    </select>`

  // 版面：上面几行是标题，下面左右两栏——左栏从上到下是筛选/设置与开关，
  // 右栏原先整块空着，探针花费卡就落在那儿（底部对齐，贴住卡片右下角）
  const intro = `
    <div class="card">
      <div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap">
        <div style="flex:1;min-width:240px">
          <div style="font-weight:500">${t('主动探测')}</div>
          <div class="hint" style="margin:4px 0 0">${t('每个模型最多发 4 个请求：指纹 + 计费、截断、缓存（连发两次）。结果进入评分，路由据此排除可疑的站。缓存数字超过 2 小时过期，过期后的下一次定时/轮巡探测自动升级全量补测；手动探测每次都全量。自动路由开着时定时探针由轮巡接管。')}</div>
        </div>
        <button class="primary" data-act="probe-all" ${probeTargets.length === 0 ? 'disabled' : ''}>${esc(probeBtn)}</button>
      </div>
      <div class="probe-body">
        <div class="probe-body-main">
          <div class="probe-filter-row">
            <span class="hint" style="white-space:nowrap">筛选（可叠加，取交集）：</span>
            ${filterSelect('providerId', t('全部站点'), providersWithOffers.map((p) => ({ v: p.id, label: p.name })), probeFilters.providerId)}
            ${filterSelect('group', t('全部分组'), groupOpts.map((g) => ({ v: g, label: g })), probeFilters.group)}
            ${filterSelect('model', t('全部模型'), modelOpts.map((m) => ({ v: m, label: m })), probeFilters.model)}
            <span class="hint">选站点=整站；站点+分组=该分组；只选模型=所有站里的这个模型</span>
          </div>
          <div class="probe-settings">
            <label class="field-inline">自动探测
              ${autoRouteOn ? '<span class="badge">已由自动路由接管</span>' : ''}
              <input id="probe-interval-num" type="number" min="0" step="1" value="${intervalValue}" style="width:64px" ${intervalLock} />
              <select id="probe-interval-unit" ${intervalLock}>
                <option value="1" ${intervalUnit === 1 ? 'selected' : ''}>${t('分钟')}</option>
                <option value="60" ${intervalUnit === 60 ? 'selected' : ''}>${t('小时')}</option>
              </select>
            </label>
            <label class="field-inline">评分有效期
              <input id="score-age" type="number" min="1" max="72" value="${maxAge}" style="width:68px" /> 小时
            </label>
            <div class="field-inline pause-inline" title="${esc(t('到点自动停、到点自动恢复；跨夜直接填大的那个时间'))}">
              <span class="pause-title">定时关闭检测</span>
              ${pauseBadge}
              ${pauseRows}
              <button class="ghost tiny" data-act="add-pause-window">${icon('plus')}${t('添加时段')}</button>
            </div>
          </div>
        </div>
        ${probeSpendCardHtml()}
      </div>
    </div>`

  const blocks = providersWithOffers.map((provider) => {
    const offers = state.offers.filter((o) => o.providerId === provider.id)
    const rows = offers.map((offer) => {
      const score = state.scores[offer.id]
      const status = PROBE_STATUS[score?.status || 'unknown']
      const hasDetail = score && score.samples > 0
      // 冷却中（额度不足/限流/模型不在分组）单独标出来：可用率看不出问题，
      // 但路由会跳过它。冷却到期但还没探到成功也一样（待复测），两种都标
      const cool = score?.blocked || score?.pendingRecovery || null
      const statusCell = cool
        ? `<span class="badge warn">${esc(blockedLabel(cool, { pending: !score.blocked }))}</span>`
        : `<span class="badge ${status.cls}">${status.label}</span>${
            // 证据量：同样的「健康」，1 个样本和 10 个样本确定性差很多
            score && score.confidence !== 'high'
              ? `<div class="sub">${(score.samples || 0) + (score.trafficSamples || 0)} ${t('样本')}</div>`
              : ''
          }`
      return `
        <tr data-offer="${esc(offer.id)}" ${hasDetail ? 'data-act="toggle-detail" tabindex="0" style="cursor:pointer"' : ''}>
          <td class="mono"><span class="probe-model" title="${esc(offer.upstreamName)}">${esc(offer.upstreamName)}${offer.group ? ` <span class="badge ${groupChipOf(offer.providerId, offer.group)}">${esc(offer.group)}</span>` : ''}${hasDetail ? ' <span style="color:var(--faint);font-size:10px">▾</span>' : ''}</span></td>
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
        <table class="probe-table">
          ${PROBE_COLS}
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
    ${blocks}`
}

// --------------------------------------------------------------- 探针花费

/**
 * 探针花费统计。
 *
 * 数据来源是 core/probe-spend.js —— 只统计**探针自己发的请求**花了多少钱，
 * 不看站点账单（那是全站口径，会把同时段的真实流量也算进来）。
 *
 * 刷新节奏：半小时一次。不用 15 秒的状态轮询去带这个数，否则就变成实时了。
 */
const PROBE_SPEND_REFRESH_MS = 30 * 60 * 1000
let probeSpend = null
let probeSpendAttemptAt = 0
let probeSpendLoading = null
let probeSpendTimer = null

async function loadProbeSpend({ force = false } = {}) {
  // 没到半小时就用缓存；失败也记时间，避免轮询把坏接口打成每秒一击
  if (!force && probeSpendAttemptAt && Date.now() - probeSpendAttemptAt < PROBE_SPEND_REFRESH_MS) return probeSpend
  if (probeSpendLoading) return probeSpendLoading
  probeSpendAttemptAt = Date.now()
  probeSpendLoading = (async () => {
    try {
      const res = await api('GET', '/api/probes/spend')
      probeSpend = res.probeSpend || null
    } catch {
      // 读不到就先不显示，探针页其余部分照常能用；1 分钟后再试，
      // 不把失败也锁半小时（否则接口修好了卡片还停在「读取中…」）
      probeSpendAttemptAt = Date.now() - PROBE_SPEND_REFRESH_MS + 60000
    } finally {
      probeSpendLoading = null
    }
    return probeSpend
  })()
  return probeSpendLoading
}

/** 首次取到数据后重绘一次；再挂一个半小时的定时器保持新鲜。 */
async function ensureProbeSpend() {
  if (!probeSpend) {
    const data = await loadProbeSpend()
    if (data && activeTab === 'probes') {
      renderProbes()
      translateDom($('#view-probes') || document.body)
    }
  }
  if (!probeSpendTimer) {
    probeSpendTimer = setInterval(async () => {
      if (document.visibilityState === 'hidden' || activeTab !== 'probes') return
      await loadProbeSpend({ force: true })
      if (activeTab === 'probes') {
        renderProbes()
        translateDom($('#view-probes') || document.body)
      }
    }, PROBE_SPEND_REFRESH_MS)
  }
}

/**
 * 钱很小（一针探针通常不到一分钱），通用 money() 会把 0.0004 显示成 0.000。
 * 这里按量级选小数位，小到看不见就给个下限，不假装是 0。
 */
function probeMoneyText(cny) {
  const v = dispPrice(cny)
  if (v === null || !Number.isFinite(v)) return '—'
  if (v === 0) return `${priceSym()}0`
  if (v < 0.0001) return `${priceSym()}<0.0001`
  if (v < 0.01) return `${priceSym()}${v.toFixed(4)}`
  if (v < 1) return `${priceSym()}${v.toFixed(3)}`
  return `${priceSym()}${v.toFixed(2)}`
}

function dayClockOf(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 最近 24 小时的半小时柱（48 个），一眼看出「什么时候在烧钱」。 */
function probeSpendBarsHtml(buckets = []) {
  const bucketMs = probeSpend?.bucketMs || 1800000
  const count = 48
  const current = Math.floor(Date.now() / bucketMs) * bucketMs
  const byAt = new Map(buckets.map((b) => [b.at, b]))
  const cells = []
  let max = 0
  for (let i = count - 1; i >= 0; i -= 1) {
    const at = current - i * bucketMs
    const bucket = byAt.get(at)
    // 柱子跟总额同口径：都看钱包里真少掉的钱（站点单价折算后）
    const value = Number(bucket?.paidCny ?? bucket?.cny ?? 0) || 0
    if (value > max) max = value
    cells.push({ at, value })
  }
  // 高度直接给像素：药水条是 flex item，百分比高度在 flex 容器里会被算成 0
  // （实测 48 根柱子全是 0px，整排看不见）——所以在这里换算成 px
  const MAX_H = 22
  return `<div class="ps-bars" role="img">${cells
    .map(({ at, value }) => {
      const h = max > 0 && value > 0 ? Math.max(3, Math.round((value / max) * MAX_H)) : 3
      const cls = value > 0 ? 'ps-bar' : 'ps-bar is-empty'
      const title = `${dayClockOf(at)} · ${value > 0 ? probeMoneyText(value) : t('无花费')}`
      return `<span class="${cls}" style="height:${h}px" title="${esc(title)}"></span>`
    })
    .join('')}</div>`
}

/**
 * 探针花费：中等大小的圆角卡，放在「主动探测」卡右下角那块空地。
 *
 * 只显示一件事：**探针花了多少钱**。不做「模型消费 / 实际消费」双口径——
 * 作者的原话是「我不懂模型消费、实际消费是啥意思，我只想看我探针真花了多少钱」。
 * 所以取的是实际扣钱的那个数（按站点单价折算后的 paidCny），下面按站点列金额。
 */
function probeSpendCardHtml() {
  if (!probeSpend) {
    return `<div class="ps-card"><div class="ps-card-head"><span class="ps-card-title">探针花费</span></div><div class="ps-card-meta">读取中…</div></div>`
  }
  const total = probeSpend.total || {}
  const sites = probeSpend.byProvider || []
  // 钱包里真少掉的钱；站点没填单价时后端让 paidCny = cny
  const money = Number.isFinite(Number(total.paidCny)) ? Number(total.paidCny) : Number(total.cny) || 0
  const since = probeSpend.since ? dayClockOf(new Date(probeSpend.since).getTime()) : null

  // 每个探过的站都列一行（按花得多到少），鼠标悬停能看这个站探了几次、最近一次什么时候
  const siteRows = sites.length
    ? sites
        .map((row) => {
          const tip = [
            t('{n} 次探测 · {m} 个请求', { n: row.probes || 0, m: row.requests || 0 }),
            row.lastAt ? `${t('最近一次')}：${relTime(row.lastAt)}` : null,
          ]
            .filter(Boolean)
            .join(' · ')
          return `<div class="ps-row" title="${esc(tip)}">
            <span class="ps-row-name">${esc(row.name)}</span>
            <b class="ps-row-money">${probeMoneyText(row.paidCny)}</b>
          </div>`
        })
        .join('')
    : `<div class="ps-row"><span class="ps-row-name dim">${t('还没有探针花费')}</span></div>`

  // 一条探测记录都没有时趋势条整排是空的灰点，白白撑高卡片、把左边筛选行
  // 和上面标题隔出一条大空隙——没花过钱就不画趋势条，卡压到最矮
  const hasSpend = (total.probes || 0) > 0 || money > 0 || sites.length > 0

  return `
    <div class="ps-card">
      <div class="ps-card-head">
        <span class="ps-card-title">探针花费</span>
        <button class="icon-btn ps-card-trash" data-act="probe-spend-clear" title="${esc(t('清除探针花费统计'))}">${icon('trash')}</button>
      </div>
      <div class="ps-total">${probeMoneyText(money)}</div>
      <div class="ps-card-meta">
        ${since ? `${esc(t('统计自 {since} 起', { since }))} · ` : ''}${esc(t('共 {n} 次探测', { n: total.probes || 0 }))}
      </div>
      ${hasSpend ? probeSpendBarsHtml(probeSpend.buckets || []) : ''}
      <div class="ps-rows">${siteRows}</div>
      ${total.unpriced > 0 ? `<div class="ps-card-meta ps-unpriced">${esc(t('有 {n} 次探测算不出金额', { n: total.unpriced }))}</div>` : ''}
    </div>`
}

/** 刚跑完探针：钱马上变了，不能等半小时，强制刷一次。 */
async function refreshProbeSpendNow() {
  await loadProbeSpend({ force: true })
  if (activeTab === 'probes') {
    renderProbes()
    translateDom($('#view-probes') || document.body)
  }
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
          <button class="ghost" data-goto="usage" title="${esc(
            t('用量面板：按天 / Key / 模型 / 站点统计与清空'),
          )}">${icon('chart')}${t('用量统计')}</button>
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
          <td class="mono">${esc(r.model)}${r.autoRoute ? ` <span class="badge" title="${t('这一单是被自动路由改派的，不是客户端真的点名了这个模型')}">${t('接管')}</span>` : ''}</td>
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
        <button class="ghost tiny" data-act="open-usage-detail" title="${esc(
          t('每次请求的 token、缓存读/写、首字、生成速度、换站原因'),
        )}">${icon('table')}${t('详细用量')}</button>
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

// 用量区间：'1' / '7' / '30' 天，或 { from, to } 自定义起止（本地日期 YYYY-MM-DD，两端都含）
const USAGE_PRESETS = [1, 7, 30]
let usageRange = 30
// 自定义区间（选了「自定义」才有值）。null 表示走 usageRange
let usageCustom = null
let usageData = null

/** 区间参数的查询串：自定义优先 */
function usageRangeQuery() {
  if (usageCustom?.from && usageCustom?.to) {
    return `from=${encodeURIComponent(usageCustom.from)}&to=${encodeURIComponent(usageCustom.to)}`
  }
  return `days=${usageRange}`
}

/** 区间的人话描述（副标题 / 按钮标题共用） */
function usageRangeLabel() {
  if (usageCustom?.from && usageCustom?.to) return `${usageCustom.from} 至 ${usageCustom.to}`
  return `最近 ${usageRange} 天`
}

/** 本地今天的日期键，给「自定义」的默认起止用 */
function todayKey() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function tokenTotal(row) {
  return (row?.input || 0) + (row?.output || 0)
}

function renderUsage() {
  const view = $('#view-usage')
  if (!view) return
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

  const customOpen = Boolean(usageCustom?.open)
  // 自定义起止：和区间按钮同一行、同一尺寸的一小条，不另占一块面板
  const customBar = !customOpen
    ? ''
    : `<span class="usage-custom" title="${esc(t('两端都包含；起止写反了会自动调正'))}">
        <input type="date" data-usage-custom="from" value="${esc(usageCustom.from || '')}" max="${esc(todayKey())}" />
        <span style="color:var(--faint)">—</span>
        <input type="date" data-usage-custom="to" value="${esc(usageCustom.to || '')}" max="${esc(todayKey())}" />
        <button class="primary" data-act="usage-custom-apply">${t('查询')}</button>
        <button class="ghost" data-act="usage-custom-cancel">${t('取消')}</button>
      </span>`

  const seg = `
    <div class="usage-head">
      <div class="usage-left">
        <div class="seg">
          ${USAGE_PRESETS.map(
            (d) =>
              `<button data-range="${d}" class="${!usageCustom?.from && d === usageRange ? 'active' : ''}">${d} 天</button>`,
          ).join('')}
          <button data-act="usage-custom-toggle" class="${usageCustom?.from ? 'active' : ''}"
            title="${esc(t('自己选起止日期，两端都包含'))}">${t('自定义')}</button>
        </div>
        ${customBar}
      </div>
      <div style="display:flex;gap:8px">
        <button data-act="open-usage-detail" title="${esc(
          t('每次请求的 token、缓存读/写、首字、生成速度、换站原因'),
        )}">${icon('table')}${t('详细用量')}</button>
        <button class="ghost danger" data-act="usage-clear" title="${esc(
          t('清空全部用量统计（按天 / 按 Key / 模型 / 站点），不影响站点与 Key'),
        )}">${icon('trash')}${t('清空统计')}</button>
      </div>
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
      <td class="mono">${esc(displayModel(model))}</td>
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
    `${usageRangeLabel()} · ${totals.requests} 次请求 · ${formatTokens(tokenTotal(totals))} token`,
  )


  const clearedNote = !usage.clearedAt
    ? ''
    : `<div class="hint" style="margin-top:6px">${t('统计已于 {time} 清空，更早的请求不再计入。', {
        time: fmtDateTime(usage.clearedAt),
      })}</div>`

  view.innerHTML = `
    ${seg}
    ${clearedNote}
    <div class="stats" style="margin-top:16px">
      <div class="stat"><div class="k">请求数</div><div class="v">${totals.requests}</div></div>
      <div class="stat"><div class="k">输入 token</div><div class="v">${formatTokens(totals.input)}</div></div>
      <div class="stat"><div class="k">缓存读</div><div class="v">${formatTokens(totals.cached)}</div></div>
      <div class="stat"><div class="k">缓存写</div><div class="v">${formatTokens(totals.cacheCreation)}</div></div>
      <div class="stat"><div class="k">输出 token</div><div class="v">${formatTokens(totals.output)}</div></div>
      <div class="stat"><div class="k">命中率</div><div class="v">${pct(totals.cacheHitRate)}</div></div>
      <div class="stat"><div class="k">平均首字</div><div class="v">${msText(totals.avgTtftMs)}</div></div>
      <div class="stat" title="${esc(
        totals.avgTps === null
          ? t('老数据算不出准确速度：只有流式请求的耗时能分开算，新的流式请求进来后这里会有值。')
          : '',
      )}"><div class="k">生成速度</div><div class="v">${
        totals.avgTps === null ? '—' : `${tpsText(totals.avgTps)}<small>tok/s</small>`
      }</div></div>
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

// ------------------------------------------------------------- 详细用量

let usageDetail = null
let usageDetailDays = 7
// 区间切换得很快时，先发后到的响应会把新数据盖回去——用序号丢弃过期响应
let usageDetailSeq = 0
// 明细筛选：站点 / 分组 / 模型（与的关系）。分组带 providerId，因为不同站有同名分组
let usageDetailFilter = { providerId: '', group: null, model: '' }
// 分组下拉的选项（value 是下标，因为分组名里什么都可能有，不往 value 里塞）
let usageDetailGroupOptions = []

/** 毫秒：拿不到就显示「—」，不要用 0 冒充（0ms 首字是假的） */
function msText(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`
}

/** 生成速度：token/秒。保留一位小数，拿不到给「—」 */
function tpsText(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n.toFixed(1) : '—'
}

/** 明细筛选 → 查询串。筛选在服务端算（小计必须和汇总同源，见 sumBuckets） */
function detailFilterQuery() {
  const f = usageDetailFilter
  if (!f.providerId && !f.group && !f.model) return ''
  const parts = []
  if (f.providerId) parts.push(`providerId=${encodeURIComponent(f.providerId)}`)
  if (f.group) {
    parts.push(`group=${encodeURIComponent(f.group.name)}`)
    parts.push(`groupProviderId=${encodeURIComponent(f.group.providerId)}`)
  }
  if (f.model) parts.push(`model=${encodeURIComponent(f.model)}`)
  return `&${parts.join('&')}`
}

async function openUsageDetail(days = usageDetailDays) {
  const sheet = $('#usage-detail')
  if (!sheet) return
  const seq = ++usageDetailSeq
  usageDetailDays = days
  // 先开弹窗再拉数据：本地接口很快，但先给个壳子比让人以为没点上好
  sheet.hidden = false
  usageDetail = null
  paintUsageDetail()
  translateDom(sheet)
  let res = null
  try {
    res = await api('GET', `/api/usage/detail?days=${days}${detailFilterQuery()}`)
  } catch (error) {
    if (seq === usageDetailSeq) {
      closeUsageDetail()
      toast(`详细用量读取失败：${error.message}`, true)
    }
    return
  }
  if (seq !== usageDetailSeq) return
  usageDetail = res
  paintUsageDetail()
  // paintUsageDetail 内部不走 t()，英文界面下靠这层 DOM 翻译兜底
  translateDom($('#usage-detail') || document.body)
}

function closeUsageDetail() {
  const sheet = $('#usage-detail')
  if (sheet) sheet.hidden = true
  usageDetail = null
  usageDetailSeq += 1
  // 筛选不跨次保留：下次打开多半是想从头看
  usageDetailFilter = { providerId: '', group: null, model: '' }
  usageDetailGroupOptions = []
}

// 结果列的短标签：决策日志里存的是英文 outcome（stream-broken / failed），
// 直接铺在表里会把列撑到溢出；原文放到 title 里，想对日志还能对上
const OUTCOME_LABEL = { ok: '成功', 'stream-broken': '断流', failed: '全部失败' }

// 明细表最多画多少行：筛选在**全部**明细上做，只是不把 500 行一次性塞进 DOM
const UD_ROW_LIMIT = 200

function paintUsageDetail() {
  const sheet = $('#usage-detail')
  const body = $('#usage-detail-body')
  const sub = $('#usage-detail-sub')
  if (!sheet || !body) return

  const seg = `<div class="seg ud-seg">${[1, 7, 30]
    .map(
      (d) =>
        `<button data-act="usage-detail-range" data-days="${d}" class="${d === usageDetailDays ? 'active' : ''}">${t('{n} 天', { n: d })}</button>`,
    )
    .join('')}</div>`

  if (!usageDetail) {
    if (sub) sub.textContent = ''
    body.innerHTML = `${seg}<p class="hint">${t('正在读取…')}</p>`
    return
  }

  const totals = usageDetail.totals || {}
  const win = usageDetail.window || {}
  const requests = usageDetail.requests || []
  if (sub) sub.textContent = t('最近 {n} 天', { n: usageDetail.days })

  const stat = (k, v, note = '') =>
    `<div class="stat"><div class="k">${k}</div><div class="v">${v}${
      note ? `<small>${note}</small>` : ''
    }</div></div>`

  // 汇总里的生成速度只统计流式请求（见 core/usage.js 的 genSum 注释）。老数据分不出
  // 非流式请求的耗时，补不出来时用下面明细窗口的速度兜底——那是逐请求算的，准确，
  // 只是窗口不同，所以必须写清楚。
  const windowTps = (() => {
    let out = 0
    let gen = 0
    for (const r of requests) {
      if (!r.genMs || !r.output) continue
      out += r.output
      gen += r.genMs
    }
    return gen > 0 ? Math.round((out / (gen / 1000)) * 10) / 10 : null
  })()
  const tpsFromWindow = totals.avgTps === null && windowTps !== null

  const stats = `<div class="stats ud-stats">
    ${stat(t('请求数'), totals.requests || 0, totals.errors ? t('错误 {n}', { n: totals.errors }) : '')}
    ${stat(t('输入'), formatTokens(totals.input))}
    ${stat(t('缓存读'), formatTokens(totals.cached))}
    ${stat(t('缓存写'), formatTokens(totals.cacheCreation))}
    ${stat(t('输出'), formatTokens(totals.output))}
    ${stat(t('思考'), formatTokens(totals.reasoning || 0))}
    ${stat(t('命中率'), pct(totals.cacheHitRate))}
    ${stat(t('平均首字'), msText(totals.avgTtftMs))}
    ${stat(t('平均耗时'), msText(totals.avgLatencyMs))}
    ${stat(
      t('生成速度'),
      tpsText(totals.avgTps ?? windowTps),
      (totals.avgTps ?? windowTps) === null ? '' : t('tok/s'),
    )}
  </div>`

  // ---- 筛选与小计：全部由服务端在全量聚合上算好（见 /api/usage/detail）。
  // 这里只负责展示。小计永远从全量桶求和，与上面的总计同源。
  const facets = usageDetail.facets || { providers: [], groups: [], models: [] }
  const subtotal = usageDetail.subtotal || null
  const filtering = Boolean(
    usageDetailFilter.providerId || usageDetailFilter.group || usageDetailFilter.model,
  )

  if (
    usageDetailFilter.providerId &&
    !facets.providers.some((p) => p.id === usageDetailFilter.providerId)
  ) {
    usageDetailFilter.providerId = ''
    usageDetailFilter.group = null
  }
  if (
    usageDetailFilter.group &&
    !facets.groups.some(
      (g) =>
        g.providerId === usageDetailFilter.group.providerId &&
        g.name === usageDetailFilter.group.name,
    )
  ) {
    usageDetailFilter.group = null
  }
  if (usageDetailFilter.model && !facets.models.some((m) => m.name === usageDetailFilter.model)) {
    usageDetailFilter.model = ''
  }

  const providerName = (id) =>
    state.providers.find((p) => p.id === id)?.name || (id === '-' ? '（未成功）' : id)
  usageDetailGroupOptions = facets.groups

  const shownRows = requests.slice(0, UD_ROW_LIMIT)

  const option = (value, label, selected) =>
    `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`

  const filters = `<div class="ud-filters">
    <label class="ud-filter">${t('站点')}
      <select data-usage-filter="provider">
        ${option('', t('全部'), !usageDetailFilter.providerId)}
        ${facets.providers
          .map((p) =>
            option(
              p.id,
              `${providerName(p.id)}（${p.requests} ${t('次请求')}）`,
              p.id === usageDetailFilter.providerId,
            ),
          )
          .join('')}
      </select>
    </label>
    <label class="ud-filter">${t('分组')}
      <select data-usage-filter="group">
        ${option('', t('全部'), !usageDetailFilter.group)}
        ${facets.groups
          .map((g, index) =>
            option(
              String(index),
              `${g.name || t('未指定分组')}（${g.requests} ${t('次请求')}）`,
              Boolean(usageDetailFilter.group) &&
                g.providerId === usageDetailFilter.group?.providerId &&
                g.name === usageDetailFilter.group?.name,
            ),
          )
          .join('')}
      </select>
    </label>
    <label class="ud-filter">${t('模型')}
      <select data-usage-filter="model">
        ${option('', t('全部'), !usageDetailFilter.model)}
        ${facets.models
          .map((m) =>
            option(m.name, `${m.name}（${m.requests} ${t('次请求')}）`, m.name === usageDetailFilter.model),
          )
          .join('')}
      </select>
    </label>
    ${
      filtering
        ? `<button class="ghost tiny" data-act="usage-detail-clear">${t('清除筛选')}</button>`
        : ''
    }
  </div>`

  const subChip = (k, v) => `<span class="ud-sub"><b>${v}</b> ${k}</span>`
  const subtotalHtml = subtotal
    ? `<div class="ud-subtotal">
        <span class="ud-subtotal-title">${t('筛选命中的流量小计', { n: subtotal.requests })}</span>
        ${subChip(t('输入'), formatTokens(subtotal.input))}
        ${subChip(t('缓存读'), formatTokens(subtotal.cached))}
        ${subChip(t('缓存写'), formatTokens(subtotal.cacheCreation))}
        ${subChip(t('输出'), formatTokens(subtotal.output))}
        ${subChip(t('命中率'), pct(subtotal.cacheHitRate))}
        ${subChip(t('平均首字'), msText(subtotal.avgTtftMs))}
        ${subChip(
          t('速度'),
          subtotal.avgTps === null ? '—' : `${tpsText(subtotal.avgTps)} ${t('tok/s')}`,
        )}
      </div>`
    : ''

  const notes = []
  if (win.source === 'ledger') {
    notes.push(
      t('明细来自逐条账本（保留 {retention} 天）：区间内 {available} 条，这里列出最近 {shown} 条。', {
        retention: win.retentionDays || 30,
        available: win.available || 0,
        shown: win.shown || 0,
      }),
    )
  } else {
    notes.push(
      t('明细暂时来自决策日志（最近 {limit} 条）：区间内 {available} 条。账本从这次更新后开始积累。', {
        limit: win.logLimit || 500,
        available: win.available || 0,
      }),
    )
  }
  notes.push(
    win.missingUsage > 0
      ? t('其中 {n} 条上游没有返回 usage：token 记作「—」，汇总里的 token 也不含它们。', {
          n: win.missingUsage,
        })
      : '',
  )
  notes.push(
    win.clearedAt
      ? t('统计已于 {time} 清空：更早的请求不再计入上面的汇总，也不在下面的明细里。', {
          time: fmtDateTime(win.clearedAt),
        })
      : '',
  )
  notes.push(
    t(
      '上面的汇总是全量聚合；筛选时中间那行小计也是同一份聚合按条件求和的——两处永远对得上。下面的明细只是逐条展开，条数多少不代表流量大小。',
    ),
  )
  notes.push(
    t(
      '输入为净值（prompt_tokens 减掉缓存读和缓存写）；命中率 = 缓存读 ÷（输入 + 缓存读 + 缓存写）；速度 = 输出 token ÷（总耗时 − 首字），只对流式请求计算。',
    ),
  )

  const notesHtml = notes
    .filter(Boolean)
    .map((line) => `<p class="ud-note">${line}</p>`)
    .join('')

  const rows = shownRows
    .map((r) => {
      const ok = r.outcome === 'ok'
      const tip = [
        r.protocol
          ? `${r.protocol}${r.stream === true ? ' · 流式' : r.stream === false ? ' · 非流式' : ''}`
          : '',
        `${t('尝试')} ${r.attempts}`,
        r.upstreamModel && r.upstreamModel !== r.model ? `上游模型 ${r.upstreamModel}` : '',
        ...r.failures.map((f) => `${f.providerName}: ${f.error}${f.ms ? ` (${f.ms}ms)` : ''}`),
      ]
        .filter(Boolean)
        .join(' · ')
      const site = r.providerName
        ? `${esc(r.providerName)}${
            r.group
              ? ` <span class="badge ${r.pool === 'free' ? 'vchip-free' : groupChipOf(r.providerId, r.group)}">${esc(r.group)}</span>`
              : ''
          }`
        : `<span class="badge danger">${t('全部失败')}</span>`
      return `<tr class="${ok ? '' : 'ud-bad'}" title="${esc(tip)}">
        <td style="color:var(--faint)">${fmtDateTime(r.ts)}</td>
        <td>${esc(r.keyName || '—')}</td>
        <td class="mono ud-model">${esc(r.model)}</td>
        <td>${site}</td>
        <td class="num">${msText(r.ttftMs)}</td>
        <td class="num">${msText(r.latencyMs)}</td>
        <td class="num">${msText(r.genMs)}</td>
        <td class="num">${r.input === null ? `<span class="badge warn">${t('无 usage')}</span>` : formatTokens(r.input)}</td>
        <td class="num">${r.cached === null ? '—' : formatTokens(r.cached)}</td>
        <td class="num">${r.cacheCreation === null ? '—' : formatTokens(r.cacheCreation)}</td>
        <td class="num">${r.output === null ? '—' : formatTokens(r.output)}</td>
        <td class="num">${r.reasoning === null ? '—' : formatTokens(r.reasoning)}</td>
        <td class="num">${pct(r.cacheHitRate)}</td>
        <td class="num">${tpsText(r.tps)}</td>
        <td>${ok ? `<span class="badge ok">${t('成功')}</span>` : `<span class="badge danger" title="${esc(r.outcome)}">${esc(
          OUTCOME_LABEL[r.outcome] ? t(OUTCOME_LABEL[r.outcome]) : r.outcome,
        )}</span>`}${r.attempts > 1 ? ` <span class="badge">${r.attempts}</span>` : ''}</td>
      </tr>`
    })
    .join('')

  const emptyText = filtering
    ? t('没有符合筛选的明细。')
    : t('这段时间没有经过网关的请求。')

  body.innerHTML = `${seg}${stats}${filters}${subtotalHtml}${notesHtml}
    <div class="table-wrap ud-table">
      <table>
        <thead><tr>
          <th>${t('时间')}</th><th>Key</th><th>${t('模型')}</th><th>${t('站点')}</th>
          <th class="num">${t('首字')}</th><th class="num">${t('耗时')}</th><th class="num">${t('生成')}</th>
          <th class="num">${t('输入')}</th><th class="num">${t('缓存读')}</th><th class="num">${t('缓存写')}</th>
          <th class="num">${t('输出')}</th><th class="num">${t('思考')}</th>
          <th class="num">${t('命中率')}</th><th class="num">${t('速度')}</th><th>${t('结果')}</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="15" class="ud-empty">${emptyText}</td></tr>`}</tbody>
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

  // 同一个模型在基准价表里可能有多条（claude-opus-4-5 与 claude-opus-4.5 各一条，
  // 来自「从站导入」和「载入参考价」两条路）。合并之后它们是一个模型，
  // 这里必须收成一行，否则用户以为表里有两份价，改动也只改到其中一份。
  const allGroups = groupByModelIdentity(
    Object.entries(state.benchmarks)
      .filter(([key, entry]) => {
        if (!filterText) return true
        return (
          key.toLowerCase().includes(filterText) ||
          String(entry.display || '').toLowerCase().includes(filterText)
        )
      })
      .map(([key, entry]) => ({ name: key, key, entry })),
  )
  // 组内挑一条当「主行」：手填的优先（那是用户确信的数），其次有输入价的
  const primaryOf = (group) =>
    [...group.rows].sort((a, b) => {
      const score = (r) => [
        String(r.entry.source || '') === 'manual' ? 1 : 0,
        r.entry.in !== null && r.entry.in !== undefined ? 1 : 0,
      ]
      const sa = score(a)
      const sb = score(b)
      return sb[0] - sa[0] || sb[1] - sa[1]
    })[0]

  const entries = allGroups
    .map((group) => ({ group, primary: primaryOf(group) }))
    .sort((a, b) => String(a.group.display).localeCompare(String(b.group.display)))

  // 与本地供给相关的判定：这一组里的**任何一个写法**被供给引用就算相关
  // （合并之后供给上的名字可能是组里的少数派写法）
  const usedIdentities = new Set()
  for (const o of state.offers || []) {
    for (const k of [o.benchmarkKey, o.modelKey, o.upstreamName]) {
      if (k) usedIdentities.add(identityOf(k))
    }
  }
  const isRelevant = ({ group, primary }) =>
    usedIdentities.has(group.id) ||
    group.rows.some((r) => String(r.entry.source || '') === 'manual') ||
    String(primary.entry.source || '') === 'manual'
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

  const rows = matching.map(({ group, primary }) => {
    const key = primary.key
    const entry = primary.entry
    // 次要信息合并成一行小字（显示名 · 来源 · 合并了哪几种写法）
    const extras = []
    const display = String(entry.display || '')
    if (display && display !== key) extras.push(display)
    const src = sourceLabel(entry.source)
    if (src) extras.push(src)
    const spellings = group.names.filter((name) => name !== key)
    // 保留组里所有写法：改价要同时写进去，否则按另一种写法查表的那条供给拿不到价
    const aliasAttr = spellings.length ? esc(JSON.stringify(group.rows.map((r) => r.key))) : ''
    return `
    <tr data-benchmark="${esc(key)}"${aliasAttr ? ` data-benchmark-group="${aliasAttr}"` : ''}>
      <td class="mono">
        ${esc(key)}
        ${spellings.length ? `<span class="badge" title="${t('同一个模型的其它写法，改价会一起写进去')}：${esc(spellings.join(' / '))}">${t('合并 {n} 种写法', { n: group.names.length })}</span>` : ''}
        ${extras.length ? `<div class="sub" style="color:var(--faint)">${esc(extras.join(' · '))}</div>` : ''}
      </td>
      <td class="num"><input type="number" step="0.001" placeholder="—" value="${entry.in ?? ''}" data-field="in" /></td>
      <td class="num"><input type="number" step="0.001" placeholder="—" value="${entry.out ?? ''}" data-field="out" /></td>
      <td class="num" style="white-space:nowrap">
        <input type="number" step="0.001" placeholder="入" value="${entry.offPeakIn ?? ''}" data-field="offPeakIn" style="width:62px" title="空闲时段输入价（如 DeepSeek 半价时段），没有就留空" />
        <input type="number" step="0.001" placeholder="出" value="${entry.offPeakOut ?? ''}" data-field="offPeakOut" style="width:62px" title="空闲时段输出价" />
      </td>
      <td>
        <select data-field="currency" style="width:88px">
          <option value="USD" ${entry.currency !== 'RUSD' ? 'selected' : ''}>USD</option>
          <option value="RUSD" ${entry.currency === 'RUSD' ? 'selected' : ''}>R.Dollar</option>
        </select>
      </td>
      <td class="num"><button class="ghost danger" data-act="del-benchmark">删除</button></td>
    </tr>`
  }).join('')

  const providerOptions = state.providers
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')

  // 官方成本表单的候选：站内已有模型（比价 + 未定价）+ 已有基准价 key。
  // datalist 只是提示不是限制：直接输入新名字就是新条目 —— 导了站内没有的
  // 模型时，在这里填官方输入/输出就能算出它的有效成本
  const modelCandidates = [...new Set([
    ...(state.ranked || []).map((g) => g.modelKey),
    ...(state.unpriced || []).map((o) => o.modelKey || o.upstreamName).filter(Boolean),
    ...Object.keys(state.benchmarks),
  ])].sort((a, b) => a.localeCompare(b))

  view.innerHTML = `
    <p class="hint">基准价是「倍率」的换算参照。三条路：从站点导入中转站基准价、以此站已填价为准、或载入内置的厂商官方参考价。</p>
    <div class="card">
      <div class="inline-form" style="border-top:none;margin-top:0;padding-top:0">
        <select id="import-provider" style="max-width:210px">${providerOptions || '<option value="">还没有站点</option>'}</select>
        <button id="btn-plaza-benchmark" title="优先用令牌读「可用渠道」，没有则用模型广场；导入的是中转站基准价，不是模型厂商的官方价" ${state.providers.length ? '' : 'disabled'}>从站点导入基准价</button>
        <button id="btn-import-benchmark" ${state.providers.length ? '' : 'disabled'}>以此站已填价为准</button>
        <span style="color:var(--faint);font-size:12px;margin:0 2px">或</span>
        <button id="btn-seed-benchmark">载入内置参考价</button>
      </div>
      <p class="hint" style="margin:10px 0 0">
        ${t('<b>从站点导入基准价</b>：优先用「令牌」读该站的「可用渠道」（数据最全，不要求开广场），读不到再回落「模型广场」。导入的是<b>中转站基准价</b>——站方自己标的、还没乘分组倍率的那层价，不是模型厂商的官方价。只补空缺、不覆盖你已有的条目。<br />')}
        ${t('<b>以此站已填价为准</b>：把这个站已经填好的实际价整体设为基准，适合你确信它没虚标的情况。<br />')}
        ${t('<b>载入内置参考价</b>：用工具内置的一份<b>模型厂商官方价</b>（OpenAI、DeepSeek 这些原厂的定价，截至 {asOf}）。启动时已自动补过一次，这个按钮只补新出现的空缺，不覆盖你手填或从站导入的。价格常变，务必核对。', {
          asOf: esc(state.reference?.asOf || '—'),
        })}
      </p>
    </div>
    <div class="card" id="bench-official-card">
      <h3>${t('模型厂商官方价（原厂价）')}</h3>
      <p class="hint" style="margin:6px 0 0">${t('这里的「官方」指模型厂商（OpenAI、Anthropic、DeepSeek 这些原厂）自己公布的定价，不是中转站的价；中转站的基准价在上面一格导入。')}</p>
      <p class="hint" style="margin:4px 0 0">${t('由于中转站模板原因，1 美元 = 1 人民币。为了站内比价方便，特增加单位「真实美元 R.Dollar」：国外模型的原厂价用它填，按汇率折算；常规情况不使用 CNY。')}</p>
      <p class="hint" style="margin:4px 0 0">${t('选一个站内模型（也可以直接输入站内还没有的模型名），填原厂输入 / 输出价。保存后比价页的每个分组头部会显示它的原厂有效成本，供各站实际价做参照。')}</p>
      <div class="inline-form" style="border-top:none;margin-top:8px;padding-top:0">
        <input id="bench-add-model" list="bench-model-list" placeholder="${t('模型名（如 gpt-5.5）')}" style="min-width:220px" spellcheck="false" />
        <datalist id="bench-model-list">${modelCandidates.map((k) => `<option value="${esc(k)}"></option>`).join('')}</datalist>
        <span class="hint" style="margin:0">${t('波峰')}</span>
        <input id="bench-add-in" type="number" step="0.001" min="0" placeholder="${t('原厂输入价')}" style="width:110px" />
        <input id="bench-add-out" type="number" step="0.001" min="0" placeholder="${t('原厂输出价')}" style="width:110px" />
        <select id="bench-add-currency" style="width:88px" title="${t('真实美元 R.Dollar = 国外模型原厂价专用，按汇率换算；站内美元与人民币 1:1')}">
          <option value="USD">USD</option>
          <option value="RUSD">R.Dollar</option>
        </select>
        <span id="bench-add-preview" class="hint" style="margin:0"></span>
        <button id="btn-bench-add" class="primary" disabled>${t('保存原厂价')}</button>
      </div>
      <div class="inline-form" style="border-top:none;margin-top:4px;padding-top:0">
        <span class="hint" style="margin:0 0 0 0">${t('波谷')}</span>
        <input id="bench-add-offin" type="number" step="0.001" min="0" placeholder="${t('波谷输入价')}" style="width:110px" />
        <input id="bench-add-offout" type="number" step="0.001" min="0" placeholder="${t('波谷输出价')}" style="width:110px" />
        <span class="hint" style="margin:0">${t('两格都留空 = 默认计价（无峰谷）；填了则比价组头分「峰 / 谷」展示两个有效成本。通用字段，任何模型都能用。')}</span>
      </div>
    </div>
    <div class="toolbar" style="margin:18px 0 10px">
      <input id="benchmark-search" class="search" type="search" placeholder="搜索模型名…" value="${esc(filters.benchmark)}" />
      <span class="hint" style="margin:0">${layering ? `${matching.length} 条与本地供给相关 · 共 ${entries.length} 条` : `共 ${entries.length} 条`}</span>
      <span style="flex:1"></span>
      <label class="field-inline" title="${t('站内 $ 与人民币 1:1；R$（真实美元）按汇率折算，切过去所有价格变小（除以汇率）')}">
        <span>${t('价格单位')}</span>
        <select id="display-currency" data-act="display-currency" style="width:110px">
          <option value="USD" ${state.settings.displayCurrency !== 'RUSD' ? 'selected' : ''}>USD $</option>
          <option value="RUSD" ${state.settings.displayCurrency === 'RUSD' ? 'selected' : ''}>R$ R.Dollar</option>
        </select>
      </label>
      <label class="field-inline" title="${t('只用于「真实美元 R.Dollar」的换算（国外模型原厂价）；站内价格不受影响')}">
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

// ------------------------------------------------------------- 异常诊断视图
// 异常诊断页 空回合守卫：中转站吞掉工具调用时静默断线的现场就在这里。

/**
 * 异常诊断页：目前只放「空回合守卫」这一件事。
 *
 * 数据不塞进 state：空回合记录会一直长，而 state 每 15 秒被轮询整体重取一遍，
 * 把它塞进去等于每轮都搬一遍几百条历史。这里单独按需拉。
 */
let diagnosticsData = null

async function loadDiagnostics() {
  try {
    diagnosticsData = await api('GET', '/api/diagnostics')
  } catch (error) {
    diagnosticsData = { error: error.message }
  }
  renderDiagnostics()
  translateDom($('#diag-guard-slot') || document.body)
}

function fmtAgo(iso) {
  if (!iso) return t('—')
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return t('—')
  if (ms < 60_000) return t('刚刚')
  const min = Math.floor(ms / 60_000)
  if (min < 60) return t('{n} 分钟前', { n: min })
  const hour = Math.floor(min / 60)
  if (hour < 24) return t('{n} 小时前', { n: hour })
  return t('{n} 天前', { n: Math.floor(hour / 24) })
}

/** 处置结果 → 徽章配色：救回来的绿、白忙一场的黄、关着的灰 */
const EMPTY_ACTION_STYLE = {
  'repaired-local': 'ok',
  'retry-same': 'ok',
  'retry-switch': 'ok',
  'repair-failed': 'warn',
  'no-retry': 'warn',
  'gave-up': 'warn',
  off: '',
}

const EMPTY_ACTION_TEXT = {
  'repaired-local': '本地重建',
  'retry-same': '同站补问',
  'retry-switch': '换一家补问',
  'repair-failed': '标记解析失败',
  'no-retry': '没别家可换',
  'gave-up': '补问后仍空',
  off: '守卫关闭，未处置',
}

function renderDiagnostics() {
  // 空回合守卫是诊断系统的一个分段：渲染进诊断页里的插槽，不再单独占一个 tab
  const view = $('#diag-guard-slot')
  if (!view) return
  const data = diagnosticsData
  if (!data) {
    view.innerHTML = `<div class="empty"><h3>${t('正在读取…')}</h3></div>`
    return
  }
  if (data.error) {
    view.innerHTML = `<div class="empty"><h3>${t('读取失败')}</h3><p>${esc(data.error)}</p></div>`
    return
  }

  const guard = data.guard || { enabled: false, mode: 'same' }
  const summary = data.summary || {}
  const tiers = data.tiers || []
  const events = data.events || []
  const detours = data.detours || []

  const tierRows = tiers
    .map(
      (tier) => `
      <tr>
        <td>${esc(tier.label)}</td>
        <td class="num">${tier.retries === 0 ? t('不补问') : t('{n} 次', { n: tier.retries })}</td>
        <td class="num">${tier.waitMs ? `${Math.round(tier.waitMs / 1000)}s` : t('—')}</td>
      </tr>`,
    )
    .join('')

  const faultSummary = data.faults?.summary || { active: 0, faulty: 0, degraded: 0, subscribers: 0 }
  const faultList = data.faults?.active || []
  const FAULT_LEVEL_TEXT = { faulty: 'faulty', degraded: 'degraded', notice: 'notice' }
  const faultRows = faultList.length
    ? faultList
        .map(
          (signal) => `
        <tr>
          <td>${esc(signal.scope?.model || signal.scope?.modelKey || '')}</td>
          <td>${esc(signal.scope?.providerName || t('未知站'))}</td>
          <td><span class="badge ${signal.level === 'faulty' ? 'warn' : ''}">${
            signal.level === 'faulty' ? t('严重') : t('降级')
          }</span></td>
          <td style="max-width:320px">${esc(t(signal.reason || ''))}</td>
          <td>${esc(signal.suggested === 'avoid' ? t('避开') : signal.suggested === 'deprioritize' ? t('降优先级') : t('无'))}</td>
          <td style="white-space:nowrap">${esc(signal.expiresAt ? fmtAgo(signal.expiresAt).replace('前', '后') : t('不过期'))}</td>
        </tr>`,
        )
        .join('')
    : `<tr><td colspan="6" class="muted" style="text-align:center;padding:14px">${t('当前没有生效中的故障信号')}</td></tr>`

  const detourRows = detours.length
    ? detours
        .map(
          (row) => `
        <tr>
          <td>${esc(row.model || '')}</td>
          <td>${esc(row.providerName || t('未知站'))}</td>
          <td><span class="badge ok">${esc(row.replacedByProviderName || t('已切走'))}</span></td>
          <td>${esc(fmtAgo(row.since).replace('前', ''))}</td>
          <td class="num">${row.checkCount || 0}</td>
          <td>
            <button class="ghost tiny" data-act="diag-resolve-detour" data-offer="${esc(row.offerId)}" title="不等复检，立刻把流量切回原站">${t('立即切回')}</button>
          </td>
        </tr>`,
        )
        .join('')
    : `<tr><td colspan="6" class="muted" style="text-align:center;padding:14px">${t('当前没有改道，流量都在原站上')}</td></tr>`

  const eventRows = events.length
    ? events
        .slice(0, 80)
        .map((event) => {
          const style = EMPTY_ACTION_STYLE[event.action] ?? ''
          const actionText = EMPTY_ACTION_TEXT[event.action] || event.action
          const recovered = event.recovered ? `<span class="badge ok">${t('已救回')}</span>` : ''
          return `
        <tr>
          <td style="white-space:nowrap">${esc(fmtAgo(event.ts))}</td>
          <td>${esc(event.model || '')}</td>
          <td>${esc(event.providerName || '')}</td>
          <td><span class="badge ${style}">${esc(t(actionText))}</span> ${recovered}</td>
          <td class="num">${event.textChars}</td>
          <td class="num">${event.wastedInput + event.wastedOutput}</td>
        </tr>`
        })
        .join('')
    : `<tr><td colspan="6" class="muted" style="text-align:center;padding:14px">${t('还没遇到过空回合')}</td></tr>`

  view.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div>
          <h3>${t('空回合守卫')}</h3>
          <div class="meta">${t('中转站把模型想调的工具吞掉时，这一轮会「什么都没说」就结束——客户端只能安静地停下。这个开关会在检测到空回合后自动补问一次。')}</div>
        </div>
      </div>
      <div class="switch-row">
        <label class="switch">
          <input type="checkbox" id="empty-guard-enabled" ${guard.enabled ? 'checked' : ''} />
          <span class="switch-track"><span class="switch-knob"></span></span>
          <span class="switch-text">
            <b>${t('启用空回合守卫')}</b>
            <span>${t('默认关闭。遇到「跑着跑着自己断了、也不汇报」时打开它；不想让网关替你重发就关掉。关闭时仍然记录每一次空回合，只是不补问。')}</span>
          </span>
        </label>
      </div>
      <div class="switch-row" style="margin-top:14px">
        <div class="field-inline" style="display:flex;align-items:center;gap:10px">
          <span>${t('补问模式')}</span>
          <div class="seg" role="group">
            <button type="button" data-act="diag-set-mode" data-mode="same" class="${guard.mode === 'same' ? 'active' : ''}">${t('同站补问')}</button>
            <button type="button" data-act="diag-set-mode" data-mode="switch" class="${guard.mode === 'switch' ? 'active' : ''}">${t('换一家补问')}</button>
          </div>
        </div>
        <div class="hint" style="margin-top:8px">
          ${guard.mode === 'same'
            ? t('同站补问：拿同一个问题再问原来那家。便宜、上下文不变，适合偶发抽风。')
            : t('换一家补问：从智能决策判完之后能打的站里，挑价格和速度都最接近的一家顶上。原站会被临时改道，每 20 分钟复检一次，连续正常就自动切回。')}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <h3>${t('故障信号')}</h3>
          <div class="meta">${t('诊断系统发现「这家供给真的不能用」时会向外发一条信号，自动路由收到后自己决定怎么处理。救回来了的不发——不影响你干活就不打扰它。')}</div>
        </div>
      </div>
      <div class="badges" style="margin-bottom:10px">
        <span class="badge ${faultSummary.active > 0 ? 'warn' : 'ok'}">${t('生效中 {n} 条', { n: faultSummary.active || 0 })}</span>
        <span class="badge">${t('严重 {n}', { n: faultSummary.faulty || 0 })}</span>
        <span class="badge">${t('降级 {n}', { n: faultSummary.degraded || 0 })}</span>
        <span class="badge ${faultSummary.subscribers > 0 ? 'ok' : ''}" title="${esc(t('0 表示现在没有模块在接收这些信号（自动路由没开或没接上）'))}">
          ${faultSummary.subscribers > 0 ? t('{n} 个接收方', { n: faultSummary.subscribers }) : t('无人接收')}
        </span>
      </div>
      <table class="table">
        <thead><tr>
          <th>${t('模型')}</th><th>${t('站点')}</th><th>${t('严重度')}</th>
          <th>${t('原因')}</th><th>${t('建议')}</th><th>${t('到期')}</th>
        </tr></thead>
        <tbody>${faultRows}</tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <h3>${t('补问档位')}</h3>
          <div class="meta">${t('补问要花多久是能估出来的：用这一轮的思考量 ÷ 这家站的实测速度，再加上首字延迟。预计越贵，补得越少。')}</div>
        </div>
      </div>
      <table class="table">
        <thead><tr><th>${t('预计补问耗时')}</th><th class="num">${t('最多补问')}</th><th class="num">${t('单次上限')}</th></tr></thead>
        <tbody>${tierRows}</tbody>
      </table>
      <p class="hint" style="margin:10px 0 0">
        ${t('另外两条硬规则：同一个站 5 分钟内已经空过 2 次，就不再问它（直接换一家）；单次上限到了还没见到正文就放弃，不会无限等。')}
      </p>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <h3>${t('临时改道')}</h3>
          <div class="meta">${t('原站被挂起后，流量先走别家。每 {n} 分钟带工具复检原站一次，连续两次正常就自动切回。', { n: data.recheckMinutes || 20 })}</div>
        </div>
      </div>
      <table class="table">
        <thead><tr>
          <th>${t('模型')}</th><th>${t('原站')}</th><th>${t('当前走')}</th>
          <th>${t('开始于')}</th><th class="num">${t('复检次数')}</th><th></th>
        </tr></thead>
        <tbody>${detourRows}</tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <h3>${t('发生记录')}</h3>
          <div class="meta">
            ${t('共 {total} 次：工具调用被吞 {dropped} 次、纯空 {empty} 次；补问救回 {recovered} 次；最近一次 {ago}。', {
              total: summary.total || 0,
              dropped: summary.toolCallDropped || 0,
              empty: summary.noContent || 0,
              recovered: summary.recovered || 0,
              ago: fmtAgo(summary.lastAt),
            })}
          </div>
        </div>
        <div class="card-actions">
          <button class="ghost tiny" data-act="diag-refresh">${t('刷新')}</button>
          <button class="ghost tiny" data-act="diag-clear-events">${t('清空记录')}</button>
        </div>
      </div>
      <table class="table">
        <thead><tr>
          <th>${t('时间')}</th><th>${t('模型')}</th><th>${t('站点')}</th>
          <th>${t('处置')}</th><th class="num">${t('正文')}</th><th class="num">${t('白烧 token')}</th>
        </tr></thead>
        <tbody>${eventRows}</tbody>
      </table>
    </div>`
}

// --------------------------------------------- 官方有效成本表单（基准价页）

/** 表单数字框读值：空/非法 → null */
function benchAddNum(id) {
  const raw = $(id)?.value
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * 现场预览有效成本：与 core/pricing.js#officialCost 同一口径
 * （混合权重 + 汇率），纯前端估算，保存后以后端算的为准。
 */
function paintBenchAddPreview() {
  const preview = $('#bench-add-preview')
  const saveBtn = $('#btn-bench-add')
  if (!preview || !saveBtn) return
  const modelKey = $('#bench-add-model')?.value.trim() || ''
  const inP = benchAddNum('#bench-add-in')
  const outP = benchAddNum('#bench-add-out')
  saveBtn.disabled = !modelKey || (inP === null && outP === null)
  if (!modelKey || (inP === null && outP === null)) {
    preview.textContent = ''
    return
  }
  const w = blendWeight()
  // 缺一侧回落到另一侧（与 offerCost 同一回落）
  const blend = (a, b) =>
    a !== null && b !== null ? a * w + b * (1 - w) : a !== null ? a : b
  const currency = $('#bench-add-currency')?.value === 'RUSD'
    ? 'RUSD'
    : $('#bench-add-currency')?.value === 'CNY' ? 'CNY' : 'USD'
  // 与 offerCost 同一条换算：只有真实美元乘汇率，站内美元/CNY 1:1
  const rate = currency === 'RUSD' ? rateCny() : 1
  const peak = blend(inP, outP) * rate
  // 波谷行：两格都空 = 默认计价；缺一格回落用波峰值
  const offIn = benchAddNum('#bench-add-offin')
  const offOut = benchAddNum('#bench-add-offout')
  const hasOff = offIn !== null || offOut !== null
  const off = hasOff ? blend(offIn ?? inP, offOut ?? outP) * rate : null
  preview.textContent = hasOff
    ? `${t('有效成本')} ${t('峰')}${priceText(peak)} / ${t('谷')}${priceText(off)}/M`
    : `${t('有效成本')} ${priceText(peak)}/M`
}

/** 选中的是已有基准价条目时，把它的官方价带回表单（只填空框，不覆盖已输的） */
function benchAddPrefill() {
  const modelKey = $('#bench-add-model')?.value.trim() || ''
  const entry = modelKey ? state.benchmarks[modelKey] : null
  if (!entry) return
  const set = (id, v) => {
    const el = $(id)
    if (el && el.value === '' && v !== null && v !== undefined) el.value = v
  }
  set('#bench-add-in', entry.in)
  set('#bench-add-out', entry.out)
  set('#bench-add-offin', entry.offPeakIn)
  set('#bench-add-offout', entry.offPeakOut)
  const cur = $('#bench-add-currency')
  if (cur && (entry.currency === 'CNY' || entry.currency === 'RUSD')) cur.value = entry.currency
}

// 官方有效成本表单：现场预览 + 选中已有条目回填（事件委托，表单随页面重画）
document.addEventListener('input', (event) => {
  const box = document.getElementById('bench-official-card')
  if (!box || !box.contains(event.target)) return
  if (event.target.id === 'bench-add-model') benchAddPrefill()
  paintBenchAddPreview()
})

// --------------------------------------------------------------- 监控视图

let monitorData = null
let monitorDays = 7
let monitorLoading = false
/** 公告面板当前选中的站点；'all' = 不分站。切站点只重渲染，不重新拉数据 */
let noticeSite = 'all'
/** 右窄栏两张卡（倍率变动/上游公告）的折叠状态，本地记住 */
const FLOW_FOLD_KEY = 'manageapi.monitorFlowFold'
let flowFold = { changes: false, notices: false }
try {
  flowFold = { ...flowFold, ...(JSON.parse(localStorage.getItem(FLOW_FOLD_KEY)) || {}) }
} catch {
  /* 坏了就当全展开 */
}

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
/** 花费小框当前选的时间段：只影响这个框，不碰别的卡片 */
let spendRange = 'today'

/** 顶栏花费小框：实际消费（站点账单口径），点开可选今天/本周/本月。没数据就藏起来 */
function paintTopSpend() {
  const btn = $('#top-spend')
  if (!btn) return
  const site = monitorData?.siteSpend?.[spendRange] || null
  const hasSite = site && site.providers > 0
  btn.hidden = !hasSite
  if (!hasSite) return
  const label = SPEND_RANGES.find((r) => r.key === spendRange)?.label || '今天'
  const labelEl = $('#top-spend-label')
  if (labelEl) labelEl.textContent = `${t('花费')} · ${t(label)}`
  const value = $('#top-spend-value')
  if (value) value.textContent = `${priceSym()}${money(dispPrice(siteSpendCny(site, spendRange)))}`
  btn.title = t('实际消费 · {range}（{n} 个站点账单）', { range: t(label), n: site.providers })
}

function paintSpendMenu() {
  for (const item of document.querySelectorAll('.top-spend-menu .spend-item')) {
    item.classList.toggle('is-on', item.dataset.spendRange === spendRange)
  }
}

function closeSpendMenu() {
  const menu = $('#top-spend-menu')
  if (menu) menu.hidden = true
  document.querySelector('.top-spend-wrap')?.classList.remove('open')
}

/**
 * 汇总站点账单时用的单价：站点自己填的 → 全局默认 → 1。
 * 与 spendFactorOf 不同：这里账单已经是「站点货币」，直接乘单价就是人民币，
 * 不再和市场汇率比（账单不是按美元定价的估算值）。
 */
function siteSpendCny(site, range) {
  const byProvider = site?.byProvider || {}
  const providers = new Map((state.providers || []).map((p) => [p.id, p]))
  let total = 0
  let seen = 0
  for (const [pid, row] of Object.entries(byProvider)) {
    const value = Number(row?.[range])
    if (!Number.isFinite(value) || value === 0) continue
    total += value * siteUnitCny(providers.get(pid))
    seen += 1
  }
  // 旧后端只给总额、没有分站数据时，退回总额 × 默认单价
  if (seen === 0) return Number(site?.actual) * siteUnitCny(null)
  return total
}

/**
 * 倍率变动 + 上游公告 两张信息卡。不单独成排，而是插进站点卡的网格：
 * 公告占第一行第一格，倍率变动占第二行第一格，站点卡从旁边接着平铺。
 * renderMonitor 首次渲染和 refreshSiteCards（搜索/翻页局部重绘）都要注回去。
 */
function feedCardsHtml(data) {
  // 公告按站点分组：顶部一排站点胶囊，下面只显示这一家的公告
  const allAnnouncements = data.announcements || []
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
    <div class="card monitor-feed-card monitor-notice-card${flowFold.notices ? ' is-folded' : ''}">
      <div class="card-head">
        <h3>上游公告</h3>
        <div class="monitor-head-actions">
          <span class="hint">${t('{n} 条未读', { n: shownUnread })}</span>
          <button class="ghost tiny" data-act="monitor-read-announcements">全部已读</button>
          <button class="flow-fold" type="button" data-act="flow-toggle" data-flow="notices" title="${t('收起 / 展开')}">${icon('chevron-down')}</button>
        </div>
      </div>
      ${noticeGroups.length ? `<div class="monitor-notice-tabs">${noticeTabs}</div>` : ''}
      <div class="monitor-feed-scroll">
        ${noticeRows || '<div class="empty small"><p>还没有读到公告。多数站点是公共接口，加了站点就会自动拉。</p></div>'}
      </div>
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
    <div class="card monitor-flow-card${flowFold.changes ? ' is-folded' : ''}">
      <div class="card-head">
        <h3>最近倍率变动</h3>
        <div class="monitor-head-actions">
          <span class="hint">${t('{n} 条', { n: (data.changes || []).length })}</span>
          <button class="flow-fold" type="button" data-act="flow-toggle" data-flow="changes" title="${t('收起 / 展开')}">${icon('chevron-down')}</button>
        </div>
      </div>
      <div class="monitor-flow-list">
        ${changeRows || '<div class="empty small"><p>还没有变动。第一次同步只记基线，之后才开始比较。</p></div>'}
      </div>
    </div>`

  return announcementsCard + changesCard
}

/** 把两张信息卡插进站点卡网格的开头（已在就不重复插） */
function injectFeedCards(host) {
  const grid = host?.querySelector('.site-cards')
  if (!grid || grid.classList.contains('has-feed')) return
  grid.classList.add('has-feed')
  grid.insertAdjacentHTML('afterbegin', feedCardsHtml(monitorData || {}))
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

  // ---------------------------------------------------------- 余额告警条
  // 余额告警此前只落在「未读告警」那个数字和下面第三屏的「告警动态」卡片里，
  // 阈值压线时首屏什么都看不出来——站点断供往往是事后才发现的。
  // 只要有站低于阈值，就在 KPI 正下方压一条实心红条：站名 + 剩余 + 阈值。
  // 判定口径与站点卡徽章、后端告警一致：阈值 > 0 且余额 <= 阈值（阈值为 0 即关闭提醒）
  // 不加 role="alert"：整页每 15 秒重渲染一次，读屏会被同一条公告反复打断
  const lowBalanceRows = (data.balanceByProvider || []).filter(
    (row) => typeof row.balance === 'number' && Number(row.threshold) > 0 && row.balance <= Number(row.threshold),
  )
  // balanceByProvider 已按余额升序，最危险的站排最前，不用再排
  const balanceAlarmRows = lowBalanceRows
    .map((row) => {
      const cur = row.currency || 'CNY'
      const depleted = row.balance <= 0
      return `<span class="balance-alarm-row">
        <button class="balance-alarm-site" data-balance-alarm-site="${esc(row.providerId)}" title="${t('看这个站的卡片')}">${esc(row.name)}</button>
        <b>${esc(cur)} ${money(row.balance)}</b>
        <span class="balance-alarm-th">${t('阈值 {amount}', { amount: money(row.threshold) })}</span>
        ${depleted ? `<span class="balance-alarm-tag">${t('已用尽')}</span>` : ''}
      </span>`
    })
    .join('')
  const balanceAlarmHtml = lowBalanceRows.length === 0
    ? ''
    : `<div class="balance-alarm">
        <span class="balance-alarm-icon">${icon('alert')}</span>
        <div class="balance-alarm-body">
          <div class="balance-alarm-head">
            <b>${t('余额告警 · {n} 个站点低于阈值', { n: lowBalanceRows.length })}</b>
            <span class="balance-alarm-hint">${t('余额见底会直接断供，尽快充值')}</span>
          </div>
          <div class="balance-alarm-rows">${balanceAlarmRows}</div>
        </div>
      </div>`

  // ------------------------------------------------------------ 站点卡
  // 版式照 upstream-ops 的渠道卡：头行（站名 + 类型 + 时间/外链）、三格统计、
  // 两格「阈值·状态 / 上次同步」、分组 chips、底部动作按钮。
  // 同步设置不单独占一行，挂在「站点余额与分组」的卡片头上——
  // 它和下面那排站点卡是同一件事：改完间隔/阈值，顺手就在这儿点「立即同步」。
  const syncPanel = syncPanelHtml(data)
  const syncActions = syncActionsHtml()

  const sitesCard = `
    <div class="sites-section">
      <div class="monitor-sites" id="monitor-sites-host"></div>
    </div>`

  // 同步设置不单独占一行，挂在「站点余额与分组」的卡片头上——
  // 它和下面那排站点卡是同一件事：改完间隔/阈值，顺手就在这儿点「立即同步」。

  setPageSubFor(
    'monitor',
    data.kpi?.lastRunAt ? t('上次同步 {ago}', { ago: agoText(data.kpi.lastRunAt) }) : '还没有同步过',
  )
  // 两张信息卡插进站点卡的网格：上游公告占第一行第一格，最近倍率变动占第二行
  // 第一格，站点卡从旁边的格子接着平铺（显式定位见 .site-cards.has-feed）。
  // 两栏布局会把窄栏叠到站点卡头上，作者已经否了三次，别再试
  view.innerHTML = `
    ${balanceAlarmHtml}
    ${sitesCard}`

  // 站点卡与「添加站点」表单复用站点页的那一套，避免两处各写一份
  const sitesHost = $('#monitor-sites-host')
  if (sitesHost) {
    sitesHost.innerHTML = providersHtml({ withForm: false, panel: syncPanel, actions: syncActions })
    injectFeedCards(sitesHost)
  }
  bindSiteSearch()
  paintTopSpend()
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

const TABS = ['overview', 'monitor', 'decision', 'probes', 'protocol', 'gateway', 'usage', 'benchmark', 'diagnosis']

/** 暂时隐藏但代码全部保留的 tab：恢复 = index.html 取消导航注释 + 从这里移除。
 *  隐藏视图的循环必须包含它们，否则切页时 #view-free 不会被动收起来。 */
const HIDDEN_TABS = ['free']

/** 折叠状态：'provider:xxx' / 'pricing:模型名' / 'probe:站点id' */
const collapsedPanels = new Set()

/** 探针页「探测」的筛选条件：站点 / 分组 / 模型，三个取交集，可单独用也可叠加。
 *  存模块级变量：探测完 re-render 不丢，切页回来也还在。 */
const probeFilters = { providerId: '', group: '', model: '' }

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

// 协议探查 tab 的两个视图（顶栏胶囊切换）：probe=测的主页面，records=历史大库
let protocolViewMode = 'probe'

function setProtocolViewMode(mode, { resetStore = false } = {}) {
  protocolViewMode = mode
  const probeView = $('#view-protocol')
  const recordsView = $('#view-protocol-records')
  if (probeView) probeView.hidden = mode !== 'probe'
  if (recordsView) recordsView.hidden = mode !== 'records'
  document.querySelectorAll('#protocol-top-seg [data-protocol-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.protocolView === mode)
  })
  const meta = mode === 'records' ? { title: '协议记录', sub: '全部探查历史 · 筛选与自动清理' } : TAB_META.protocol
  const titleEl = $('#page-title')
  if (titleEl) titleEl.textContent = meta.title
  if (activeTab === 'protocol') setPageSub(meta.sub)
  // 顶栏文案刚被改成中文，得自己过一遗翻译（setTab 里的 translateDom 发生在这之前）
  translateDom($('.topbar-left') || document.body)
  if (mode === 'records') {
    // 记录视图永远对应完整大库：resetStore=true 时重置筛选
    ensureProtocolRecordsView(recordsView, { resetFilters: resetStore })
    translateDom(recordsView || document.body)
  }
  if (location.hash !== '#protocol') history.replaceState(null, '', '#protocol')
}

const TAB_META = {
  overview: { title: '概览', sub: '当前状态一眼看完' },
  monitor: { title: '站点', sub: '余额趋势、倍率变动与站点管理' },
  free: { title: '免费', sub: '免费额度与平台积分，不参与付费比价' },
  pricing: { title: '比价', sub: '同一模型跨站对比' },
  decision: { title: '智能决策', sub: '候选排序与手动调整' },
  probes: { title: '探针', sub: '指纹 / 截断 / 计费 / 缓存' },
  protocol: { title: '协议探查', sub: '表面协议 · 真实协议 · 原生能力差异' },
  gateway: { title: '网关', sub: '一个入口接管全部流量' },
  usage: { title: '用量', sub: '按 Key / 模型 / 站点统计' },
  benchmark: { title: '基准价', sub: '倍率换算的参照物' },
  // 诊断系统 = 报错归因 + 异常诊断 + 一键体检 + 空回合守卫（同一件事的四个视角，
  // 不分两个侧边栏入口：它们是同一份台账的不同切面，分开了用户要在两页来回对）
  diagnosis: { title: '诊断系统', sub: '报错归因 · 异常体检 · 空回合守卫 · 故障上报' },
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
  if (name === 'pricing') name = 'decision' // 旧书签 #pricing：比价页已并入智能决策

  // 「使用说明」不在侧边栏里，但 #help 要能直接打开（弹窗里那个「在新页面打开」链接）
  if (name === 'help') {
    activeTab = 'help'
    document.querySelectorAll('#nav button').forEach((b) => b.classList.remove('active'))
    for (const tabName of [...TABS, ...HIDDEN_TABS]) {
      const el = $(`#view-${tabName}`)
      if (el) el.hidden = true
    }
    const help = $('#view-help')
    if (help) help.hidden = false
    const seg = $('#protocol-top-seg')
    if (seg) seg.hidden = true
    const titleEl = $('#page-title')
    if (titleEl) titleEl.textContent = '使用说明'
    setPageSub('这个工具怎么用、为什么这么设计')
    translateDom($('.topbar-left') || document.body)
    if (location.hash !== '#help') history.replaceState(null, '', '#help')
    return
  }

  if (!TABS.includes(name)) name = 'overview'
  activeTab = name
  const topSeg = $('#protocol-top-seg')
  if (topSeg) topSeg.hidden = name !== 'protocol'
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name))
  for (const tabName of [...TABS, ...HIDDEN_TABS]) {
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
  // 诊断系统页按需拉：结论、账本、故障上报、空回合守卫四份数据
  if (name === 'diagnosis') {
    void loadDiagnosis()
    void loadDiagnostics()
  }
  // 协议探查也是按需拉：目标列表和记录在每次进页时刷新（站点页加的 Key 才能立刻看到）
  // 用量面板：进页就重画一次，副标题（区间 · 请求数 · token）才跟得上当前区间。
  // 进度量页时 render() 已经跑过一轮，但那时 activeTab 还不是 'usage'，
  // setPageSubFor 会把它跳过——副标题会一直停在 TAB_META 的静态文案上
  if (name === 'usage') {
    renderUsage()
    translateDom($('#view-usage') || document.body)
  }
  if (name === 'protocol') {
    setProtocolViewMode(protocolViewMode, { resetStore: false })
    if (protocolViewMode === 'probe') {
      ensureProtocolView($(`#view-protocol`))
      translateDom($('#view-protocol') || document.body)
    }
  }
}

// 浏览器前进/后退只改 hash，不会触发任何渲染——没有这条监听，地址变了页面不动
window.addEventListener('hashchange', () => {
  const next = location.hash.replace('#', '') || 'providers'
  // 免费页暂藏：#free/xxx 是历史书签，落到概览（别停在原页，也别报错）
  if ((next === 'free' || next.startsWith('free/')) && !TABS.includes('free')) {
    setTab('overview')
    return
  }
  if (next !== activeTab && next !== `free/${freePane}`) setTab(next)
})

// 顶栏胶囊：探查页 ↔ 记录页。点「协议记录」永远重置到完整大库
 document.querySelectorAll('#protocol-top-seg [data-protocol-view]').forEach((button) => {
  button.addEventListener('click', () => {
    setProtocolViewMode(button.dataset.protocolView, {
      resetStore: button.dataset.protocolView === 'records',
    })
  })
})

// 点花费菜单以外的地方收起它
document.addEventListener('click', (event) => {
  const menu = $('#top-spend-menu')
  if (!menu || menu.hidden) return
  if (event.target.closest('.top-spend-wrap')) return
  closeSpendMenu()
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
  for (const id of ['help-modal', 'contact-modal', 'group-modal', 'pf-accounts-modal', 'add-provider-modal', 'prov-modal', 'login-modal', 'usage-detail']) {
    const modal = document.getElementById(id)
    if (modal && !modal.hidden) modal.hidden = true
  }
  // 动态创建的诊断弹窗与通知面板也一并收起
  document.getElementById('diagnose-box')?.remove()
  const notify = $('#notify-panel')
  if (notify && !notify.hidden) notify.hidden = true
  // 分组模型抽屉也是悬浮层，Esc 一并收
  closeGroupModels()
  // 详细用量弹窗有自己的状态（拉过的数据），关的时候顺手清掉
  if (usageDetail) closeUsageDetail()
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
    if (!panel.hidden) void openNotifyPanel()
    return
  }
  // 面板头部的 通知 / 告警 页签：切到哪栏就看哪栏，顺手把那栏标成已读
  const notifyTabBtn = event.target.closest('[data-notify-tab]')
  if (notifyTabBtn) {
    const next = notifyTabBtn.dataset.notifyTab
    if ((next === 'notif' || next === 'alerts') && next !== notifyTab) {
      notifyTab = next
      renderNotifications()
      if (next === 'alerts') void markAlertsReadRemote()
      else markNotifsRead()
    }
    return
  }
  if (event.target.closest('[data-act="mark-read"]')) {
    if (notifyTab === 'alerts') void markAlertsReadRemote()
    else markNotifsRead()
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

  // 右窄栏：点卡片头上的箭头收起/展开倍率变动、上游公告
  const foldBtn = event.target.closest('[data-act="flow-toggle"]')
  if (foldBtn) {
    const key = foldBtn.dataset.flow
    if (key === 'changes' || key === 'notices') {
      flowFold[key] = !flowFold[key]
      try {
        localStorage.setItem(FLOW_FOLD_KEY, JSON.stringify(flowFold))
      } catch {
        /* 记不住就算了，本次会话内仍然生效 */
      }
      renderMonitor()
      translateDom($('#view-monitor') || document.body)
    }
    return
  }

  // 花费小框：点开选今天/本周/本月
  if (event.target.closest('#top-spend')) {
    const menu = $('#top-spend-menu')
    if (menu) {
      menu.hidden = !menu.hidden
      document.querySelector('.top-spend-wrap')?.classList.toggle('open', !menu.hidden)
    }
    return
  }
  const spendItem = event.target.closest('[data-spend-range]')
  if (spendItem) {
    const next = spendItem.dataset.spendRange
    if (SPEND_RANGES.some((r) => r.key === next)) {
      if (next !== spendRange) {
        spendRange = next
        paintSpendMenu()
        paintTopSpend()
      }
    }
    closeSpendMenu()
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
  // 识别系别：带令牌探测（匿名不通的站，带令牌再试一次往往就能识别）
  if (event.target.closest('[data-act="detect-kind"]')) {
    const providerId = event.target.closest('[data-provider]')?.dataset.provider
      || event.target.closest('[data-chart-ctx]')?.dataset.provider
      || (event.target.closest('.prov-card')?.dataset.provider)
    if (!providerId) return
    await withBusy(event.target.closest('[data-act="detect-kind"]'), async () => {
      state = await api('POST', `/api/providers/${providerId}/detect-kind`, {})
      render()
      const r = state.kindResult
      if (r?.kind === 'unknown') {
        toast(`没能识别系别：${r.evidence}`, true)
      } else {
        toast(`识别为 ${r.kind} 系（${r.evidence}）`)
      }
    })
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

  // 余额告警条里的站名：滚到他那张站点卡，并闪一下边框——
  // 告警条只给结论，具体要充值/换主站还是得看卡
  const alarmSiteBtn = event.target.closest('[data-balance-alarm-site]')
  if (alarmSiteBtn) {
    const pid = alarmSiteBtn.dataset.balanceAlarmSite
    const card = [...document.querySelectorAll('#monitor-sites-host [data-provider]')]
      .find((el) => el.dataset.provider === pid)
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' })
      card.classList.remove('is-flash')
      // 强制重排，否则连续点同一张卡第二次不会重播动画
      void card.offsetWidth
      card.classList.add('is-flash')
      setTimeout(() => card.classList.remove('is-flash'), 1600)
    }
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
    // 从自定义切回预设：清掉自定义区间，否则查询串仍走 from/to
    const wasCustom = Boolean(usageCustom?.from)
    if (days === usageRange && usageData && !wasCustom) return
    await withBusy(rangeBtn, async () => {
      usageCustom = null
      const res = await api('GET', `/api/usage?days=${days}`)
      usageData = res.usage
      usageRange = days
      renderUsage()
      // renderUsage 内部不走 t()，英文界面下靠这层 DOM 翻译兜底
      translateDom($('#view-usage') || document.body)
    })
    return
  }

  // 点在看板结论句以外的地方 → 收起模型下拉，别让它一直挂着挡住下面的卡
  if (headlineModelsOpen && !event.target.closest('.headline')) {
    headlineModelsOpen = false
    renderOverview()
    translateDom($('#view-overview') || document.body)
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

  // 阈值数字就地编辑：点一下变输入框，回车/失焦保存，Esc 取消，留空不动。
  // 阈值全局只有一条（settings.balanceWarnUsd，站内额度单位），卡上显示的是
  // 按本站单价折算后的「这个站的告警线」——所以输入的数按本站单价折回去再存
  if (action === 'edit-warn') {
    const p = (state.providers || []).find((x) => x.id === providerId)
    const unit = siteUnitCny(p)
    const raw = Number(state.settings.balanceWarnUsd ?? state.settings.balanceWarnCny) || 0
    const input = document.createElement('input')
    input.type = 'number'
    input.step = '0.01'
    input.min = '0'
    input.className = 'inline-num-edit'
    input.value = raw > 0 ? String(Math.round(raw * unit * 100) / 100) : ''
    input.title = t('回车保存，Esc 取消；留空 = 不改')
    actionButton.replaceWith(input)
    input.focus()
    input.select()
    // Enter 直接调 commit，不押在 blur 上（blur 在某些环境不可靠）；blur 只作点击别处时的兜底，
    // done 防重入：Enter 已保存后 blur 再触发也不会重复 PATCH
    let saving = false
    let done = false
    const commit = async () => {
      if (done || saving) return
      const v = input.value.trim()
      if (v === '') { done = true; render(); return }
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0) { done = true; toast('阈值不能是负数', true); render(); return }
      saving = true
      try {
        const usd = Math.round((n / unit) * 100) / 100
        state = await api('PATCH', '/api/settings', { balanceWarnUsd: usd })
        done = true
        await loadMonitor(monitorDays)
        render()
        toast(usd === 0 ? '余额告警已关闭' : '余额告警阈值已保存')
      } catch (error) {
        done = true
        toast(error.message, true)
        render()
      }
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit() }
      if (e.key === 'Escape') { done = true; render() }
    })
    input.addEventListener('blur', () => { if (!done) commit() })
    return
  }

  // 「自定义」：展开起止日期输入（先只展开，不查；查询按钮再拉数据）
  if (action === 'usage-custom-toggle') {
    const today = todayKey()
    usageCustom = usageCustom?.from
      ? { from: usageCustom.from, to: usageCustom.to, open: !usageCustom.open }
      : { from: '', to: today, open: true }
    renderUsage()
    translateDom($('#view-usage') || document.body)
    return
  }

  if (action === 'usage-custom-cancel') {
    // 取消：回到原区间。已经用自定义查过就保留那次结果，只收起输入框
    usageCustom = usageCustom?.from
      ? { from: usageCustom.from, to: usageCustom.to, open: false }
      : null
    renderUsage()
    translateDom($('#view-usage') || document.body)
    return
  }

  if (action === 'usage-custom-apply') {
    const view = $('#view-usage')
    const from = view?.querySelector('[data-usage-custom="from"]')?.value || ''
    const to = view?.querySelector('[data-usage-custom="to"]')?.value || ''
    if (!from || !to) {
      toast(t('起止日期都要填'), true)
      return
    }
    await withBusy(actionButton, async () => {
      usageCustom = { from, to, open: true }
      try {
        const res = await api('GET', `/api/usage?${usageRangeQuery()}`)
        usageData = res.usage
      } catch (error) {
        usageCustom = null
        throw error
      }
      renderUsage()
      translateDom($('#view-usage') || document.body)
    })
    return
  }

  // 清空用量统计：只清 usage.json 的汇总（按天 / Key / 模型 / 站点），
  // 决策日志（最近请求表）与站点 / Key 都不动。服务端返回重置后的完整 state
  if (action === 'usage-clear') {
    if (!confirm(t('清空全部用量统计？此操作不可恢复。'))) return
    await withBusy(actionButton, async () => {
      // 必须带个空对象：api() 只有在有 body 时才带 Content-Type，
      // 裸 POST 会被服务端当「非 JSON 请求体」拒掉
      state = await api('POST', '/api/usage/reset', {})
      // 清空后回默认区间：自定义区间是上次看的窗口，留着只会让人以为没清干净
      usageData = null
      usageCustom = null
      usageRange = 30
      render()
      toast(t('用量统计已清空'))
    })
    return
  }

  if (action === 'overview-issues-toggle') {
    overviewIssuesOpen = !overviewIssuesOpen
    renderOverview()
    // renderOverview 内部不走 t()，英文界面下靠这层 DOM 翻译兜底
    translateDom($('#view-overview') || document.body)
    return
  }

  // 看板结论句里的模型下拉：展开 / 收起
  if (action === 'toggle-headline-models') {
    headlineModelsOpen = !headlineModelsOpen
    renderOverview()
    translateDom($('#view-overview') || document.body)
    return
  }

  // 看板结论句的档位：只改这句话按什么算，路由/网关一概不动
  if (action === 'set-headline-mode') {
    const mode = actionButton.dataset.mode || ''
    if (!mode || mode === state.headlineMode) return
    try {
      state = await api('PATCH', '/api/settings', { headlineMode: mode })
      render()
      const label = (state.decisionModes || []).find((item) => item.key === mode)?.label || mode
      toast(t('看板结论句改按「{mode}」算（网关派活没变）', { mode: t(label) }))
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  // 全场冠军行的档位：只改第二句按什么比，上面那句和路由一概不动
  if (action === 'set-champion-mode') {
    const mode = actionButton.dataset.mode || ''
    if (!mode || mode === state.championMode) return
    try {
      state = await api('PATCH', '/api/settings', { championMode: mode })
      render()
      const label = (state.decisionModes || []).find((item) => item.key === mode)?.label || mode
      toast(t('全场冠军改按「{mode}」算', { mode: t(label) }))
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  // 选一个模型当结论句的主角（落库 settings.focusModel，不是只改眼前这一次）
  if (action === 'pick-headline-model') {
    const modelKey = actionButton.dataset.model || ''
    headlineModelsOpen = false
    if (!modelKey || modelKey === state.settings?.focusModel) {
      renderOverview()
      translateDom($('#view-overview') || document.body)
      return
    }
    try {
      state = await api('PATCH', '/api/settings', { focusModel: modelKey })
      render()
    } catch (error) {
      toast(error.message, true)
    }
  }

  if (action === 'open-usage-detail') {
    await openUsageDetail()
    return
  }

  if (action === 'usage-detail-range') {
    const days = Number(actionButton.dataset.days) || 7
    // 同一区间且已经拉到数据就不重复请求（连点不抖动）
    if (days === usageDetailDays && usageDetail) return
    await openUsageDetail(days)
    return
  }

  if (action === 'close-usage-detail') {
    closeUsageDetail()
    return
  }

  if (action === 'usage-detail-clear') {
    usageDetailFilter = { providerId: '', group: null, model: '' }
    // 小计在服务端从全量聚合算，筛选变了必须重拉
    void openUsageDetail(usageDetailDays)
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

  if (action === 'open-key-models') {
    // Key 那行的「总 / 忽略 / 可用」：三颗数字各带一个 filter，弹窗里也是同一组切换
    const target = actionButton.dataset.provider || providerId
    const credentialId = actionButton.dataset.credential
    if (!target || !credentialId) return
    openKeyModels(target, credentialId, actionButton.dataset.filter || 'all')
    return
  }

  if (action === 'open-pricing-sheet') {
    // 站点卡「已定价 9 / 9」：点开看这站全部模型的定价情况，就地改价
    const target = actionButton.dataset.provider || providerId
    if (!target) return
    openPricingSheet(target, 'all')
    return
  }

  if (action === 'pricing-sheet-filter') {
    if (!modelsSheet || modelsSheet.kind !== 'pricing') return
    modelsSheet.filter = actionButton.dataset.filter || 'all'
    paintGroupModels()
    return
  }

  if (action === 'edit-price-slot') {
    // 定价弹窗的三个数字（输入/输出/倍率）：点一下变输入框，回车/失焦保存，Esc 取消。
    // 语义与比价页一致：倍率填了按倍率走，清空按输入/输出单价走——pricingMode 是权威，
    // 所以改倍率必须连着它一起写，不能只改 ratio（见 core/pricing.js resolveOfferPrice）。
    const offerId = actionButton.dataset.offer
    const field = actionButton.dataset.field
    const offer = (state.offers || []).find((o) => o.id === offerId)
    if (!offerId || !field || !offer) return
    const input = document.createElement('input')
    input.type = 'number'
    input.step = field === 'ratio' ? '0.01' : '0.001'
    input.className = 'price-slot-input'
    const cur = offer[field]
    input.value = cur === null || cur === undefined ? '' : String(cur)
    input.title = t('回车保存，Esc 取消；留空 = 清空')
    actionButton.replaceWith(input)
    input.focus()
    input.select()
    // 提交逻辑自己发 PATCH，别让全局 change 委托再叠一层暂存
    input.addEventListener('change', (e) => e.stopPropagation())
    let done = false
    const commit = () => {
      if (done) return
      done = true
      const raw = input.value.trim()
      const value = raw === '' ? null : raw
      const prev = offer[field] === null || offer[field] === undefined ? null : String(offer[field])
      if (value === prev) {
        render()
        return
      }
      stagePriceEdit(offerId, field, value)
      if (field === 'ratio') stagePriceEdit(offerId, 'pricingMode', value === null ? 'manual' : 'ratio')
      void flushPriceEdits(offerId)
      render()
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit() }
      if (e.key === 'Escape') { done = true; render() }
    })
    input.addEventListener('blur', () => { if (!done) commit() })
    return
  }

  if (action === 'key-models-filter') {
    if (!modelsSheet || modelsSheet.kind !== 'key') return
    openKeyModels(modelsSheet.providerId, modelsSheet.credentialId, actionButton.dataset.filter || 'all')
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

  // 决策侧重：性价比 / 价格 / 首字速度 / 价速比。只改排序口径，准入规则不变
  if (action === 'set-decision-mode') {
    const mode = actionButton.dataset.mode || ''
    if (!mode || mode === (state.decisionMode || state.settings?.decisionMode)) return
    try {
      state = await api('PATCH', '/api/settings', { decisionMode: mode })
      render()
      const label = (state.decisionModes || []).find((item) => item.key === mode)?.label || mode
      // 接管中切档：服务端会立刻按新档位强制重选一次（不受迟滞约束），
      // 「正在使用」跟着变——这事得告诉用户，不然以为切了没反应
      const tail = state.autoRoute?.enabled
        ? t('；自动路由接管中，已按新档位重选最优模型')
        : ''
      toast(
        t('决策侧重已切到「{mode}」，下面的排序和网关选站都跟着变了', { mode: t(label) }) + tail,
      )
    } catch (error) {
      toast(error.message, true)
    }
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

  if (action === 'monitor-save-settings') {
    const interval = Number($('#monitor-interval')?.value ?? 30)
    const warnInput = $('#monitor-warn')
    // 阈值输入框可能不在页面上（设置面板收起来了），此时不要用默认值覆盖用户设置
    const patch = { monitorIntervalMinutes: interval }
    if (warnInput) patch.balanceWarnUsd = Number(warnInput.value || 0)
    // 默认站点单价：空串表示「1:1」，要显式传 null 才能清掉
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

  // 一键同步：拉取密钥（有令牌时）→ 同步模型 → 读余额 → 识别分组，串着跑完再刷新
  if (event.target.closest('[data-act="prov-sync-all"]')) {
    const btn = event.target.closest('[data-act="prov-sync-all"]')
    const card = btn.closest('.prov-card')
    const providerId = card?.dataset.provider
    const hasToken = card?.dataset.hasToken === '1'
    if (!providerId) return
    const failed = []
    let syncResult = null
    await withBusy(btn, async () => {
      try {
        syncResult = await api('POST', `/api/providers/${providerId}/sync`, {})
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
    // 一键导入的结果：新收了站上几把密钥要说清，一把没收（没令牌/读不到）不打扰
    const keyImport = syncResult?.sync?.keyImport
    let doneMsg = failed.length ? `部分完成：${failed.join('；')}` : '已同步'
    if (keyImport?.imported > 0) {
      doneMsg = failed.length
        ? doneMsg
        : t('已同步，新导入 {count} 把密钥', { count: keyImport.imported })
    }
    toast(doneMsg, failed.length > 0)
    return
  }

  // 读余额：只刷新这一项，不给整站跑一遍同步。探底离场的站，充值后靠它当场回场
  if (action === 'prov-read-balance') {
    const providerId = actionButton.dataset.provider
    if (!providerId) return
    await withBusy(actionButton, async () => {
      try {
        await api('POST', `/api/providers/${providerId}/balance`, {})
      } catch (error) {
        toast(t('读余额失败：{error}', { error: error.message }), true)
        return
      }
      state = await api('GET', '/api/state')
      render()
      toast(t('余额已更新'))
    })
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
    const inModal = Boolean(actionButton.closest('#prov-modal-body'))
    await withBusy(actionButton, async () => {
      state = await api('DELETE', `/api/credentials/${credentialId}`)
      render()
      if (inModal) reopenProvPanel(actionButton, 'keys')
      toast('Key 已删除')
    })
    return
  }

  if (action === 'del-benchmark') {
    const row = actionButton.closest('[data-benchmark]')
    const key = row.dataset.benchmark
    const keys = row.dataset.benchmarkGroup ? JSON.parse(row.dataset.benchmarkGroup) : [key]
    if (!confirm(`删除基准价「${key}」？${keys.length > 1 ? `（同组的 ${keys.length - 1} 种写法一起删）` : ''}`)) return
    await withBusy(actionButton, async () => {
      for (const name of keys) {
        state = await api('DELETE', `/api/benchmarks/${encodeURIComponent(name)}`)
      }
      render()
      toast('已删除')
    })
    return
  }

  if (action === 'offer-mode') {
    const offerId = actionButton.closest('[data-offer]').dataset.offer
    const mode = actionButton.dataset.mode === 'ratio' ? 'ratio' : 'manual'
    await withBusy(actionButton, async () => {
      // 这行还有暂存中的改价：先把它们落库，免得被模式切换的响应冲掉
      if (pendingPriceEdits.has(offerId)) await flushPriceEdits(offerId)
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
        '注意：这样建出来的分组没有对应 Key；不想要了在比价表里点它右边的小删除键。',
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

  if (action === 'toggle-autoroute') {
    // 自动路由范围：勾上后只在勾选的模型里挑，全移出 = 回到全场
    const modelKey = actionButton.dataset.model
    if (!modelKey) return
    const scope = Array.isArray(state.autoRoute?.scope) ? state.autoRoute.scope : []
    const enrolled = !scope.includes(modelKey)
    try {
      state = await api('POST', '/api/auto-route/scope', { modelKey, enrolled })
      render()
      const next = Array.isArray(state.autoRoute?.scope) ? state.autoRoute.scope : []
      toast(
        enrolled
          ? t('已加入自动路由：只在勾选的 {n} 个模型里挑', { n: next.length })
          : next.length > 0
            ? t('已移出，还在勾选的 {n} 个模型里挑', { n: next.length })
            : t('已移出：没有勾选的模型 = 全场都参选'),
      )
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (action === 'toggle-ig-model') {
    // 忽略模型面板右栏的单行开关：身份键口径（整类），与旧复选框同一语义，
    // 只是换成了弹窗徽章的样子。重画面板并保持两栏滚动位置
    const id = actionButton.dataset.id
    if (!id) return
    const ignored = new Set((state.settings?.ignoredModels || []).map(identityOf))
    const left = $('.ig-pane-left')
    const right = $('.ig-pane-right')
    const leftTop = left ? left.scrollTop : 0
    const rightTop = right ? right.scrollTop : 0
    await toggleIgnoredModel(id, !ignored.has(identityOf(id)))
    openIgnoredModels()
    const freshLeft = $('.ig-pane-left')
    const freshRight = $('.ig-pane-right')
    if (freshLeft) freshLeft.scrollTop = leftTop
    if (freshRight) freshRight.scrollTop = rightTop
    return
  }

  if (action === 'toggle-sheet-ignore') {
    // 分组/Key 弹窗里的「已忽略 / 已显示」开关徽章：切这**一个**模型（精确名），
    // 不动同类写法。绝对语义交给服务端算（可能是删例外也可能是设例外），
    // 当前状态直接读徽章自己的样式，前端不复制忽略判定规则。
    // 整类忽略（「忽略模型」管理面板）不在这里。
    const name = actionButton.dataset.name
    if (!name) return
    const makeShown = actionButton.classList.contains('ig-on')
    // 重画弹窗会把滚动位置打回顶部：先记住，切完再放回去
    const sheetBody = $('#group-models-body')
    const scrollTop = sheetBody ? sheetBody.scrollTop : 0
    try {
      state = await api('POST', '/api/model-visibility', { name, shown: makeShown })
      const label = displayModel(name)
      toast(makeShown ? t('已显示 {name}', { name: label }) : t('已忽略 {name}', { name: label }))
    } catch (error) {
      toast(String(error), true)
    }
    paintGroupModels()
    const fresh = $('#group-models-body')
    if (fresh) fresh.scrollTop = scrollTop
    return
  }

  if (action === 'reset-order') {
    const container = actionButton.closest('[data-model]')
    const modelKey = container?.dataset.model
    if (!modelKey) return
    try {
      state = await api('PUT', `/api/decisions/${encodeURIComponent(modelKey)}/order`, { order: [] })
      render()
      toast('已恢复自动排序（勾选与顺序一并清掉）')
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
    const inModal = Boolean(actionButton.closest('#prov-modal-body'))
    await withBusy(actionButton, async () => {
      try {
        const result = await api('POST', `/api/providers/${providerId}/restore-ratio`, body)
        state = result
        render()
        if (inModal) reopenProvPanel(actionButton, 'rates')
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
    // 切换必须有提示：绿色=开着（每 15 秒一次），灰色=关了
    toast(autoRefresh ? t('自动同步已开启（每 15 秒一次）') : t('自动同步已关闭'))
    return
  }

  // ---------------------------------------------------- 诊断系统 · 结论与体检
  // 一键体检：用户亲手点才真的打上游（会花 token，所以只在这里触发）
  if (action === 'checkup-run') {
    if (checkupRunning) return
    checkupRunning = true
    checkupReport = null
    renderDiagnosis()
    translateDom($('#view-diagnosis') || document.body)
    try {
      // 优先体检「当前决策聚焦的模型」，没选就由后端挑前几条供给
      const modelKey = state.settings?.focusModel || state.headline?.model || null
      checkupReport = await api('POST', '/api/diagnosis/checkup', { modelKey })
      // 体检后的新证据要反映到诊断结论里
      await loadDiagnosis()
    } catch (error) {
      toast(`体检失败：${error.message}`)
    } finally {
      checkupRunning = false
      renderDiagnosis()
      renderDiagnostics()
      translateDom($('#view-diagnosis') || document.body)
    }
    return
  }

  // 测试故障上报通道（真发一条，验证自动路由能收到）
  if (action === 'fault-test') {
    try {
      const r = await api('POST', '/api/faults/test', {})
      toast(r.hint || (r.ok ? '上报通道畅通' : '上报失败'))
      await loadDiagnosis()
      renderDiagnostics()
      translateDom($('#view-diagnosis') || document.body)
    } catch (error) {
      toast(`测试失败：${error.message}`)
    }
    return
  }

  // 展开/收起某条结论下被归因收敛进来的派生症状
  if (action === 'finding-related') {
    const key = actionButton.dataset.key
    if (key) {
      if (expandedFindings.has(key)) expandedFindings.delete(key)
      else expandedFindings.add(key)
      renderDiagnosis()
      renderDiagnostics()
      translateDom($('#view-diagnosis') || document.body)
    }
    return
  }

  // 长期评价切维度（纯前端重渲染，不重新拉数据）
  if (action === 'longterm-dim') {
    longTermDim = actionButton.dataset.dim || 'byProvider'
    renderDiagnosis()
    renderDiagnostics()
    translateDom($('#view-diagnosis') || document.body)
    return
  }

  // 调试数据面板：错误账本 / 供给表现（默认收起，互斥展开）
  if (action === 'diagnosis-pane') {
    const pane = actionButton.dataset.pane || 'none'
    diagnosisPane = diagnosisPane === pane ? 'none' : pane
    renderDiagnosis()
    renderDiagnostics()
    translateDom($('#view-diagnosis') || document.body)
    return
  }

  // ---------------------------------------------------- 异常诊断 · 空回合守卫
  if (action === 'diag-set-mode') {
    const mode = actionButton.dataset.mode
    try {
      await api('PATCH', '/api/diagnostics', { mode })
      await loadDiagnostics()
      toast(mode === 'same' ? t('已切换：同站补问') : t('已切换：换一家补问'))
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (action === 'diag-refresh') {
    await loadDiagnostics()
    toast(t('已刷新'))
    return
  }

  if (action === 'diag-clear-events') {
    if (!confirm(t('清空空回合记录？只清发生记录，开关和当前改道都不动，清空后无法恢复。'))) return
    try {
      await api('DELETE', '/api/diagnostics/events')
      await loadDiagnostics()
      toast(t('记录已清空'))
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (action === 'diag-resolve-detour') {
    const offerId = actionButton.dataset.offer
    try {
      await api('DELETE', `/api/diagnostics/detours/${offerId}`)
      await loadDiagnostics()
      toast(t('已切回原站'))
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (action === 'ignored-models') {
    openIgnoredModels()
    return
  }

  if (action === 'reset-currency') {
    const offerId = actionButton.dataset.offer
    try {
      // 清掉手选标记：之后同步按站方声明的币种落价
      state = await api('PATCH', `/api/offers/${offerId}`, { currencySource: 'site' })
      render()
      toast(t('已恢复跟随站点：下次同步按站方声明的币种落价'))
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (action === 'merge-models') {
    openModelMerge()
    return
  }

  if (action === 'merge-do') {
    await doMergeModels(actionButton)
    return
  }

  if (action === 'merge-split') {
    await withBusy(actionButton, async () => {
      try {
        state = await api('POST', '/api/models/split', { name: actionButton.dataset.name })
        render()
        openModelMerge()
        toast(t('已拆开 {name}，它不再和别的写法合并', { name: actionButton.dataset.name }))
      } catch (error) {
        toast(String(error), true)
      }
    })
    return
  }

  if (action === 'merge-unalias') {
    await withBusy(actionButton, async () => {
      try {
        state = await api('DELETE', `/api/models/alias?name=${encodeURIComponent(actionButton.dataset.name)}`)
        render()
        openModelMerge()
        toast(t('已恢复 {name} 的自动归并', { name: actionButton.dataset.name }))
      } catch (error) {
        toast(String(error), true)
      }
    })
    return
  }

  if (action === 'merge-reset') {
    await withBusy(actionButton, async () => {
      try {
        state = await api('POST', '/api/models/aliases/reset')
        render()
        openModelMerge()
        toast(t('已清空所有手动合并，全部回到自动归并'))
      } catch (error) {
        toast(String(error), true)
      }
    })
    return
  }

  if (action === 'mark-free') {
    const offerId = actionButton.dataset.offer
    await withBusy(actionButton, async () => {
      try {
        // 这行还有暂存中的改价：先落库再覆盖，免得被冲掉
        if (pendingPriceEdits.has(offerId)) await flushPriceEdits(offerId)
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
      void refreshProbeSpendNow()
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

  if (action === 'add-pause-window') {
    const windows = Array.isArray(state.settings.probePauseWindows) ? state.settings.probePauseWindows : []
    if (windows.length >= 12) {
      toast('最多 12 段，够覆盖一整天的作息了', true)
      return
    }
    // 默认「晚上 11 点到早上 7 点」：最常见的场景就是睡觉这段
    const next = [...windows, { id: `w${Date.now().toString(36)}`, start: '23:00', end: '07:00' }]
    try {
      state = await api('PATCH', '/api/settings', { probePauseWindows: next })
      render()
      toast('已加一段 23:00 至 07:00，点时间就能改')
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (action === 'del-pause-window') {
    const id = actionButton.closest('[data-pause]')?.dataset.pause
    const next = (state.settings.probePauseWindows || []).filter((w) => w.id !== id)
    try {
      state = await api('PATCH', '/api/settings', { probePauseWindows: next })
      render()
      toast('已删除这段')
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (action === 'probe-all') {
    // 前端按筛选条件算好目标清单，服务端照单全收（不再默认砍到 5 个）。
    // 清单为空就提示，不让用户点了个寂寞。
    const targets = probeFilteredOffers()
    if (targets.length === 0) {
      toast('筛选条件下没有可探测的模型，先调一下筛选', true)
      return
    }
    // 一次探十几个以上会真实花钱（每个模型 5 个请求），超过 10 个先确认一次
    if (targets.length > 10 && !confirm(`将探测 ${targets.length} 个模型，每个发 5 个请求，可能消耗较多 Token。继续？`)) return
    toast('正在探测，需要几秒到几十秒…')
    await withBusy(actionButton, async () => {
      const result = await api('POST', '/api/probes/run', { offerIds: targets.map((o) => o.id) })
      state = result
      render()
      void refreshProbeSpendNow()
      const okCount = result.probeResults.filter((r) => r.ok).length
      toast(`探测 ${result.probeResults.length} 个，成功 ${okCount}`)
    })
    return
  }

  if (action === 'probe-spend-clear') {
    // 不可逆，先问一句：只清账本，不动探测结果与评分
    if (!confirm('清除探针花费统计？\n\n只会把这份花费账本归零（总金额、分站金额、半小时趋势），已经跑过的探测结果和评分不受影响。')) return
    await withBusy(actionButton, async () => {
      const res = await api('DELETE', '/api/probes/spend')
      probeSpend = res.probeSpend || null
      probeSpendAttemptAt = Date.now()
      if (activeTab === 'probes') {
        renderProbes()
        translateDom($('#view-probes') || document.body)
      }
      toast(t('探针花费统计已清除'))
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
    const inModal = Boolean(form.closest('#prov-modal-body'))
    state = await api('POST', '/api/credentials', { ...data, providerId })
    render()
    if (inModal) reopenProvPanel(form, 'keys')
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

// ------------------------------------------------ 比价分组拖拽排序
// 把手在组头左边的 grip：拖动调整分组（模型）之间的顺序，落库 db.pricingGroupOrder。
// 改价格永远不影响分组顺序——拖拽是唯一改变分组顺序的方式（见 core/pricing.js）
let dragGroupKey = null

document.addEventListener('dragstart', (event) => {
  const grip = event.target.closest?.('.pricing-grip')
  if (!grip) return
  dragGroupKey = grip.dataset.model
  grip.closest('.table-wrap')?.classList.add('dragging')
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', dragGroupKey)
})

document.addEventListener('dragover', (event) => {
  if (!dragGroupKey) return
  const wrap = event.target.closest?.('#view-pricing .table-wrap')
  if (!wrap) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  const head = wrap.querySelector('.group-head')
  if (!head) return
  const rect = head.getBoundingClientRect()
  const after = event.clientY > rect.top + rect.height / 2
  document.querySelectorAll('.table-wrap.drop-before, .table-wrap.drop-after, .table-wrap.dragging').forEach((n) =>
    n.classList.remove('drop-before', 'drop-after', 'dragging'),
  )
  wrap.querySelector('.pricing-grip')?.closest('.table-wrap').classList.add('dragging')
  wrap.classList.add(after ? 'drop-after' : 'drop-before')
})

document.addEventListener('drop', async (event) => {
  const wrap = event.target.closest?.('#view-pricing .table-wrap')
  if (!dragGroupKey || !wrap) return
  event.preventDefault()
  const targetKey = wrap.querySelector('.pricing-grip')?.dataset.model
  const after = wrap.classList.contains('drop-after')
  document.querySelectorAll('.table-wrap.drop-before, .table-wrap.drop-after, .table-wrap.dragging').forEach((n) =>
    n.classList.remove('drop-before', 'drop-after', 'dragging'),
  )
  const dragged = dragGroupKey
  dragGroupKey = null
  if (!targetKey || targetKey === dragged) return
  // 顺序以 state.ranked 全集为准（含收起/被搜索滤掉的组）：拖到谁旁边就插到谁前面/后面
  const order = (state.ranked || []).map((g) => g.modelKey).filter((key) => key !== dragged)
  const at = order.indexOf(targetKey)
  if (at === -1) return
  order.splice(after ? at + 1 : at, 0, dragged)
  try {
    state = await api('PUT', '/api/pricing/order', { order })
    render()
    toast(t('分组顺序已保存（改价格不会再打乱它）'))
  } catch (error) {
    toast(error.message, true)
  }
})

document.addEventListener('dragend', () => {
  dragGroupKey = null
  document.querySelectorAll('.table-wrap.drop-before, .table-wrap.drop-after, .table-wrap.dragging').forEach((n) =>
    n.classList.remove('drop-before', 'drop-after', 'dragging'),
  )
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

// --------------------------------------------------- 决策页候选行：拖拽排序 + 点选勾选
// 两套交互独立，走同一条指针事件路径：按下后挪动超过 4px 就是拖拽（整行都能拖，
// 把手只是视觉提示），落位后保存整表顺序（含暂时不登场的行）——这只改「没勾选时
// 按什么先后派活」；没挪动就是点一下 = 勾它为「当前使用」，顺序完全不动，再点
// 一下取消勾选。勾选 > 拖的顺序 > 自动排序；勾选的牌哪怕准入没放行也算数
// （人的明确指定，探针准入管不住人手点的），真发失败了照样沿候选链故障转移。
//
// 刻意不用 HTML5 draggable：<tr draggable> 在部分浏览器里根本起不了拖，
// 用户看到的就是「拖不动」（站点卡能用是因为它的把手是个 span）。这里用指针事件
// 自己做，按住整行任意位置都能拖，指针越过相邻行的中线就把行原地挪过去。
let rowDrag = null // { row, tbody, container, startX, startY, pointerId, dragging, fromOrder }

/** 靠边自动滚动：长表格里靠后的行否则永远拖不到第一行 */
function autoScrollWhileDragging(clientY) {
  const scroller = document.querySelector('.content')
  if (!scroller) return
  const box = scroller.getBoundingClientRect()
  const edge = 72
  if (clientY < box.top + edge) scroller.scrollTop -= 18
  else if (clientY > box.bottom - edge) scroller.scrollTop += 18
}

function endRowDrag() {
  const drag = rowDrag
  rowDrag = null
  if (!drag) return null
  drag.row.classList.remove('dragging')
  document.body.classList.remove('row-dragging')
  return drag
}

document.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  const row = event.target.closest?.('tr.dec-row')
  if (!row) return
  const container = row.closest('[data-model]')
  const tbody = row.parentElement
  if (!container || !tbody) return
  rowDrag = {
    row,
    tbody,
    container,
    startX: event.clientX,
    startY: event.clientY,
    pointerId: event.pointerId,
    dragging: false,
    fromOrder: [...tbody.querySelectorAll('tr.dec-row')].map((tr) => tr.dataset.offer),
  }
})

document.addEventListener('pointermove', (event) => {
  const drag = rowDrag
  if (!drag || event.pointerId !== drag.pointerId) return
  // 移动超过 4px 才算拖，否则点一下也会被当成拖拽
  if (!drag.dragging) {
    if (Math.abs(event.clientY - drag.startY) < 4 && Math.abs(event.clientX - drag.startX) < 4) return
    drag.dragging = true
    drag.row.classList.add('dragging')
    document.body.classList.add('row-dragging')
  }
  event.preventDefault()
  autoScrollWhileDragging(event.clientY)

  const rows = [...drag.tbody.querySelectorAll('tr.dec-row')]
  const last = rows[rows.length - 1]
  if (last && last !== drag.row && event.clientY > last.getBoundingClientRect().bottom) {
    // 拖到最后一行下面：直接挪到末尾
    drag.tbody.appendChild(drag.row)
    return
  }
  for (const tr of rows) {
    if (tr === drag.row) continue
    const rect = tr.getBoundingClientRect()
    if (event.clientY < rect.top || event.clientY > rect.bottom) continue
    const ref = event.clientY < rect.top + rect.height / 2 ? tr : tr.nextElementSibling
    if (drag.row.nextElementSibling !== ref) drag.tbody.insertBefore(drag.row, ref)
    break
  }
})

document.addEventListener('pointerup', async (event) => {
  const drag = rowDrag
  if (!drag || event.pointerId !== drag.pointerId) return
  endRowDrag()
  const modelKey = drag.container.dataset.model
  const decision = state.decisions?.find((d) => d.modelKey === modelKey)
  if (!decision) return
  if (drag.dragging) {
    // 拖拽落位：按拖完的 DOM 顺序保存
    const visibleOrder = [...drag.tbody.querySelectorAll('tr.dec-row')].map((tr) => tr.dataset.offer)
    if (visibleOrder.join() === drag.fromOrder.join()) return
    // 「只显示可使用」开着时 DOM 里只有可见行：提交前把被隐藏的供给塞回它原来的
    // 槽位，否则一次拖动就会把它们从手动顺序里挤掉（服务端是整表覆盖，见 setManualOrder）
    const visibleSet = new Set(visibleOrder)
    const full = decision.candidates.map((c) => c.offerId)
    const order = full.map((id) => (visibleSet.has(id) ? visibleOrder.shift() : id))
    while (visibleOrder.length > 0) order.push(visibleOrder.shift())
    await persistDecisionOrder(modelKey, order)
  } else {
    // 没挪动 = 点选：勾它为「当前使用」，顺序完全不动；再点一下取消勾选
    const picked = drag.row.dataset.offer
    if (!picked) return
    await pickDecision(modelKey, picked === decision.pinnedOfferId ? '' : picked)
  }
})

// 拖到一半被打断（触摸滚动、系统手势）：把行放回服务端记着的顺序
document.addEventListener('pointercancel', () => {
  const drag = endRowDrag()
  if (drag?.dragging) render()
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !rowDrag?.dragging) return
  endRowDrag()
  render()
})

/** 点选勾选/取消勾选：只改「当前使用」，不碰顺序；重画会丢滚动位置，自己存一下 */
async function pickDecision(modelKey, offerId) {
  const scroller = document.querySelector('.content')
  const scrollTop = scroller ? scroller.scrollTop : 0
  try {
    state = await api('POST', `/api/decisions/${encodeURIComponent(modelKey)}/pick`, { offerId })
    render()
    if (scroller) scroller.scrollTop = scrollTop
    if (!offerId) {
      toast(t('已取消勾选，回到按顺序自动选'))
      return
    }
    const c = (state.decisions || []).find((d) => d.modelKey === modelKey)?.candidates?.find((x) => x.offerId === offerId)
    const name = c ? `${c.providerName || '—'}${c.group ? `（${c.group}）` : ''}` : modelKey
    toast(t('已勾选 {name} 为当前使用', { name }))
  } catch (error) {
    toast(error.message, true)
  }
}

/** 拖拽落位后提交整表顺序：重画会丢滚动位置，自己存一下 */
async function persistDecisionOrder(modelKey, order) {
  const scroller = document.querySelector('.content')
  const scrollTop = scroller ? scroller.scrollTop : 0
  try {
    state = await api('PUT', `/api/decisions/${encodeURIComponent(modelKey)}/order`, { order })
    render()
    if (scroller) scroller.scrollTop = scrollTop
    toast(t('「{model}」已保存手动顺序，没勾选时按这个先后派活', { model: modelKey }))
  } catch (error) {
    toast(error.message, true)
  }
}

document.addEventListener('click', (event) => {
  // 忽略模型面板：左栏选组（重画两栏，选中态高亮）
  const pick = event.target.closest?.('[data-ig-pick]')
  if (pick) {
    igSelected = igSelected === pick.dataset.igPick ? null : pick.dataset.igPick
    openIgnoredModels()
    return
  }
  // 右栏的整组批量：一次 PATCH，重画后保持选中
  const bulk = event.target.closest?.('[data-ig-bulk]')
  if (bulk) {
    void bulkIgnoreGroup(bulk.dataset.group, bulk.dataset.igBulk === 'ignore')
  }
}, true)

document.addEventListener('change', async (event) => {
  // 详细用量的筛选：站点 / 分组 / 模型。只在已经拉到的明细上重算，不再请求接口
  const udFilter = event.target.closest?.('[data-usage-filter]')
  if (udFilter) {
    const field = udFilter.dataset.usageFilter
    if (field === 'provider') {
      usageDetailFilter.providerId = udFilter.value
      // 换了站点，原来选的分组不属于它了
      usageDetailFilter.group = null
    } else if (field === 'group') {
      usageDetailFilter.group = udFilter.value === '' ? null : usageDetailGroupOptions[Number(udFilter.value)] || null
    } else if (field === 'model') {
      usageDetailFilter.model = udFilter.value
    }
    // 小计在服务端从全量聚合算，筛选变了必须重拉（不能只在前端过滤明细）
    await withBusy(udFilter, () => openUsageDetail(usageDetailDays))
    return
  }

  // 分组选择弹窗的 radio：键盘（Tab + 方向键）也能选——radio 此前 tabindex=-1，
  // 键盘完全无法选择分组
  if (event.target.matches?.('input[name="pick-group"]')) {
    groupPicker.selected = event.target.value
    markSelectedGroup()
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

  if (input.dataset.pauseField) {
    const row = input.closest('[data-pause]')
    const id = row?.dataset.pause
    const value = String(input.value || '')
    const windows = Array.isArray(state.settings.probePauseWindows) ? state.settings.probePauseWindows : []
    // 清空 / 半截输入不写库：input[type=time] 中途会给出空串，直接存就成了「全天暂停」
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      render()
      toast('时间请填 HH:MM', true)
      return
    }
    const next = windows.map((w) => (w.id === id ? { ...w, [input.dataset.pauseField]: value } : w))
    try {
      state = await api('PATCH', '/api/settings', { probePauseWindows: next })
      render()
      toast(pauseToast(state.probePause))
    } catch (error) {
      toast(error.message, true)
      render()
    }
    return
  }

  // 探针页的筛选下拉：只改本地状态重渲染，不写库。
  // 级联：上游条件变了，下游选中的值可能已不在选项里，还在就保留，不在就重置。
  if (input.dataset.probeFilter) {
    probeFilters[input.dataset.probeFilter] = input.value
    const pool = state.offers.filter((o) => !probeFilters.providerId || o.providerId === probeFilters.providerId)
    if (!pool.some((o) => (o.group || '') === probeFilters.group)) probeFilters.group = ''
    if (!pool.some((o) => (!probeFilters.group || (o.group || '') === probeFilters.group) && o.upstreamName === probeFilters.model)) {
      probeFilters.model = ''
    }
    render()
    return
  }

  if (input.id === 'probe-interval-num' || input.id === 'probe-interval-unit') {
    const rawNum = $('#probe-interval-num')?.value
    if (rawNum === '' || rawNum === null) return // 清空中间态不落库，等填完再算
    const unit = Number($('#probe-interval-unit')?.value || 1)
    const minutes = Math.round(Number(rawNum) * unit)
    if (!Number.isFinite(minutes) || minutes < 0) {
      toast('探测间隔不能是负数', true)
      return
    }
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


  if (input.id === 'decision-only-admitted') {
    // 同比价页「只显示允许放行」：纯本地开关，只改视图，不往服务端存
    decisionOnlyAdmitted = input.checked
    try {
      localStorage.setItem(DECISION_ONLY_ADMITTED_KEY, decisionOnlyAdmitted ? '1' : '0')
    } catch {
      /* 隐私模式下 localStorage 可能不可用 */
    }
    renderDecision()
    return
  }

  if (input.id === 'auto-route-switch') {
    // 自动路由（一键接管）：服务端开关 + 开启时立刻全场挑选一次，「正在使用」
    // 不用等第一个请求才有得显示。切档时的强制重选也由服务端做
    try {
      state = await api('PATCH', '/api/settings', { autoRouteEnabled: input.checked })
      render()
      toast(
        input.checked
          ? t('自动路由已接管：不管客户端要什么模型，都只派当前档位下全场最优的那个')
          : t('自动路由已关闭：网关恢复按客户端请求的模型派活'),
      )
    } catch (error) {
      input.checked = !input.checked
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

  if (input.id === 'empty-guard-enabled') {
    try {
      await api('PATCH', '/api/diagnostics', { enabled: input.checked })
      await loadDiagnostics()
      toast(input.checked ? t('空回合守卫已开启') : t('空回合守卫已关闭（仍会记录）'))
    } catch (error) {
      toast(error.message, true)
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
      const inModal = Boolean(input.closest('#prov-modal-body'))
      state = await api('POST', `/api/providers/${providerId}/group-ratio`, { group, ratio })
      const updated = state.groupRatioResult?.updated ?? 0
      render()
      // 弹窗里的是克隆副本，重绘页面不会更新它
      if (inModal) reopenProvPanel(groupRow, 'rates')
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

  // 漂移监视参数（诊断页）：存设置，服务端 tick 每次读，改完立即生效
  const driftField = input.dataset.drift
  if (driftField) {
    const v = input.value
    const patch =
      driftField === 'enabled'
        ? { driftEnabled: v === '1' }
        : driftField === 'threshold'
          ? { driftThresholdPct: Number(v) }
          : driftField === 'cooldown'
            ? { driftCooldownMinutes: Number(v) }
            : { driftTrialSamples: Number(v) }
    try {
      state = await api('PATCH', '/api/settings', patch)
      renderDiagnosis()
      renderDiagnostics()
      translateDom($('#view-diagnosis') || document.body)
      toast(
        driftField === 'enabled'
          ? v === '1'
            ? '漂移检测已开启'
            : '漂移检测已关闭（自动路由仍按探针分工作）'
          : '已保存，下一轮判定开始生效',
      )
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
    stagePriceEdit(offerId, field, value)
    // 下拉是「一下选完」的离散动作，没有「停手 2 秒」可言：立即提交并交回焦点。
    // 不这样做的话，焦点留在表格里，重排被防打字保护一直扣着——
    // 用户改完币种盯着综合成本看，它就是不刷（2026-10-29 实测真凶）
    if (input.tagName === 'SELECT') {
      input.blur()
      void flushPriceEdits(offerId)
    }
    return
  }

  const benchRow = input.closest('[data-benchmark]')
  if (benchRow) {
    const key = benchRow.dataset.benchmark
    // 合并组里的所有写法一起写：合并只是「显示成一行」，查表时每条供给还是按
    // 自己的名字找（benchmarkEntry 会归一命中，但精确键更直接也更不容易漏）
    const keys = benchRow.dataset.benchmarkGroup
      ? JSON.parse(benchRow.dataset.benchmarkGroup)
      : [key]
    const patch = { [field]: input.value === '' ? null : input.value }
    try {
      for (const name of keys) {
        state = await api('PUT', '/api/benchmarks', { ...state.benchmarks[name], ...patch, modelKey: name })
      }
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

/**
 * 价格单位切换：与改价同一套脾气——本地先选上，停手 2 秒才提交并重排，
 * 免得「歘一下」整页窜走。提交后 render 会重建 DOM，滚动位置先记后放。
 */
const DISPLAY_CURRENCY_DEBOUNCE_MS = 1000
let pendingDisplayCurrency = null
let displayCurrencyTimer = null

async function flushDisplayCurrency() {
  if (pendingDisplayCurrency === null) return
  pendingDisplayCurrency = null
  clearTimeout(displayCurrencyTimer)
  displayCurrencyTimer = null
  try {
    state = await api('PATCH', '/api/settings', { displayCurrency: state.settings.displayCurrency })
  } catch (error) {
    toast(error.message, true)
  }
  const scroller = $('.content')
  const top = scroller ? scroller.scrollTop : 0
  render()
  if (scroller) scroller.scrollTop = top
  toast(t('价格单位已切换'))
}

window.addEventListener('beforeunload', () => {
  // 兼底：停手 2 秒内关页，用 keepalive 把选好的单位补发（与改价暂存同一套）
  if (pendingDisplayCurrency === null) return
  clearTimeout(displayCurrencyTimer)
  try {
    fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayCurrency: pendingDisplayCurrency }),
      keepalive: true,
    })
  } catch {
    /* 尽力而为 */
  }
})

document.addEventListener('change', async (event) => {
  const currency = event.target.closest('[data-act="display-currency"]')
  if (currency) {
    // 本地先生效（不重排）：任何原因触发重绘都用新单位渲染
    state.settings.displayCurrency = currency.value
    pendingDisplayCurrency = currency.value
    clearTimeout(displayCurrencyTimer)
    displayCurrencyTimer = setTimeout(() => void flushDisplayCurrency(), DISPLAY_CURRENCY_DEBOUNCE_MS)
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
            ? `从${via}导入 ${r.added} 条基准价${r.skipped ? `（跳过 ${r.skipped} 条：已存在或无基准价）` : ''}`
            : `没有新增（都已有基准价，或${via}没报价格）`,
          r.added === 0,
        )
      } catch (error) {
        toast(error.message, true)
      }
    })
    return
  }

  if (event.target.id === 'btn-bench-add') {
    const modelKey = $('#bench-add-model')?.value.trim() || ''
    if (!modelKey) {
      toast('先填模型名', true)
      return
    }
    const inV = $('#bench-add-in').value
    const outV = $('#bench-add-out').value
    if (inV === '' && outV === '') {
      toast('波峰行至少填一个原厂价', true)
      return
    }
    const offInV = $('#bench-add-offin')?.value ?? ''
    const offOutV = $('#bench-add-offout')?.value ?? ''
    await withBusy(event.target, async () => {
      try {
        state = await api('PUT', '/api/benchmarks', {
          modelKey,
          display: modelKey,
          in: inV === '' ? null : Number(inV),
          out: outV === '' ? null : Number(outV),
          offPeakIn: offInV === '' ? null : Number(offInV),
          offPeakOut: offOutV === '' ? null : Number(offOutV),
          currency: $('#bench-add-currency').value,
        })
        render()
        toast(t('已保存 {name} 的原厂价，比价页组头会显示原厂有效成本', { name: modelKey }))
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
  // 按钮上只写当前语言的代码（CN / EN），点开才出选项
  if (label) label.textContent = lang === 'zh' ? 'CN' : 'EN'
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
  scheduleRefresh()
  render()
  setTab(location.hash.replace('#', '') || 'monitor')
  // 告警图标状态靠 monitor 视图的数据；不在站点页也要后台拉一份
  if (!monitorData && !monitorLoading) void loadMonitor()
  // ?help=1 / ?contact=1 直接打开对应面板（方便分享链接）
  const params = new URLSearchParams(location.search)
  if (params.has('contact')) {
    renderContacts()
    const modal = $('#contact-modal')
    if (modal) modal.hidden = false
  } else if (params.has('notify')) {
    const panel = $('#notify-panel')
    if (panel) {
      panel.hidden = false
      void openNotifyPanel()
    }
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
