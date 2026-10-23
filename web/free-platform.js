/**
 * 免费池 · 平台侧渲染（纯函数）。
 *
 * 为什么不直接写进 web/app.js：
 *   这一栏要等 T2b 的 OAuth 才真正可用，先做成不依赖全局 state 的纯函数，
 *   入参只有数据 + esc + t。接进 app.js 时只换一行调用，也方便单独测。
 *
 * 数据结构见 docs/free-api-plan.md 附录 A：
 *   platform = { id, connectorId, label, enabled }
 *   account  = { id, platformId, label, status, lastCheckinAt, quota }
 */

const UNIT_LABEL = { request: '次', credit: '积分', token: 'token' }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]))
}

/**
 * 默认的 t：只做 {占位符} 填充。
 * 真实调用方传的是 web/i18n.js 的 t，行为一致；这里兜底是为了让本模块能单独跑。
 */
function defaultT(text, vars) {
  const raw = String(text)
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
  )
}

function fmt(value) {
  if (!Number.isFinite(value)) return '—'
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(1)
}

/** 本地日期键，与 core/platforms/ledger.js 的 localDayKey 同一口径（前端不能 import node 模块，只能各写一份） */
function localDayKey(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function remainingOf(account) {
  const quota = account?.quota
  if (!quota) return 0
  const limit = Number(quota.limit)
  if (!Number.isFinite(limit)) return 0
  return Math.max(0, limit - (Number(quota.used) || 0))
}

/**
 * 把一张卡下所有账号的额度汇总成一条。
 *
 * 不同单位不能相加——「3 次 + 20 积分 = 23」是纯粹的假数字，
 * 所以只按第一份额度的单位汇总，其余忽略。
 */
function aggregateQuota(accounts) {
  const rows = accounts.map((a) => a?.quota).filter((q) => q && Number(q.limit) > 0)
  if (rows.length === 0) return null
  const unit = rows[0].unit || 'credit'
  const same = rows.filter((q) => (q.unit || 'credit') === unit)
  const now = Date.now()
  const resets = same
    .map((q) => q.resetAt)
    .filter((at) => at && new Date(at).getTime() > now)
    .sort()
  return {
    unit,
    window: same[0].window === 'month' ? 'month' : 'day',
    limit: same.reduce((sum, q) => sum + (Number(q.limit) || 0), 0),
    used: same.reduce((sum, q) => sum + (Number(q.used) || 0), 0),
    resetAt: resets[0] || null,
  }
}

/** 首字母色块：颜色由名字哈希决定，同一个平台每次渲染颜色都一样 */
function avatarHtml(label, esc) {
  const text = String(label || '?').trim()
  const initial = (text[0] || '?').toUpperCase()
  let hash = 0
  for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)) % 360
  return `<span style="width:34px;height:34px;border-radius:9px;flex:none;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600;color:#fff;background:hsl(${hash} 46% 45%)">${esc(initial)}</span>`
}

function emptyPaneHtml(esc, t) {
  return `
    <div class="empty">
      <h3>${esc(t('还没有连接平台'))}</h3>
      <p>${esc(t('平台积分可以来自 WorkBuddy、Trae 等 Agent 平台。自动连接还在做，现在可以先手动记一个额度。'))}</p>
      <div style="display:flex;gap:8px;justify-content:center">
        <button class="primary" data-act="platform-add">${esc(t('手动添加'))}</button>
        <button class="ghost" data-act="platform-connect" title="${esc(t('WorkBuddy / Trae 自动连接开发中'))}">${esc(t('连接平台'))}</button>
      </div>
    </div>`
}

/** 手动建一个平台：只记额度，不依赖任何连接器 */
function manualFormHtml(esc, t, presets = []) {
  const options = presets
    .map(
      (p) =>
        `<option value="${esc(p.id)}" data-label="${esc(p.label)}" data-connector="${esc(p.connectorId)}">${esc(p.label)}</option>`,
    )
    .join('')
  return `
    <div class="form-card">
      <h3 style="margin:0 0 4px">${esc(t('添加一个平台'))}</h3>
      <p class="hint" style="margin:0 0 14px">${esc(t('只记额度也能用：能算「还能撑几天」、到期前提醒你。自动读取模型目录要等连接器。'))}</p>
      <div class="inline-form" style="flex-wrap:wrap;gap:12px">
        <label class="field-inline">${esc(t('常用平台'))}
          <select id="pf-preset" style="width:160px">
            <option value="">${esc(t('自定义'))}</option>
            ${options}
          </select>
        </label>
        <label class="field-inline">${esc(t('名称'))}
          <input id="pf-label" type="text" placeholder="Trae" style="width:130px" />
        </label>
        <label class="field-inline">${esc(t('额度上限'))}
          <input id="pf-limit" type="number" min="0" step="1" placeholder="100" style="width:90px" />
        </label>
        <label class="field-inline">${esc(t('单位'))}
          <select id="pf-unit" style="width:88px">
            <option value="credit">${esc(t('积分'))}</option>
            <option value="request">${esc(t('次'))}</option>
            <option value="token">token</option>
          </select>
        </label>
        <label class="field-inline">${esc(t('窗口'))}
          <select id="pf-window" style="width:88px">
            <option value="day">${esc(t('每天'))}</option>
            <option value="month">${esc(t('每月'))}</option>
          </select>
        </label>
      </div>
      <div class="form-actions">
        <button class="primary" data-act="platform-save">${esc(t('保存'))}</button>
        <button class="ghost" data-act="platform-cancel">${esc(t('取消'))}</button>
      </div>
    </div>`
}

export function renderFreePlatformPane({
  platforms = [],
  accounts = [],
  esc = escapeHtml,
  t = defaultT,
  formOpen = false,
  presets = [],
} = {}) {
  const list = Array.isArray(platforms) ? platforms : []
  const allAccounts = Array.isArray(accounts) ? accounts : []

  if (list.length === 0) {
    // 空态必须自带「添加」入口：否则没有任何免费模型时，用户根本没法开始用平台栏
    return formOpen ? manualFormHtml(esc, t, presets) : emptyPaneHtml(esc, t)
  }

  // 「已连接」由服务端算：需要登录的平台必须有 token，手动平台有账号即可。
  // 前端不再自己推断——判断依据放在两处迟早会不一致。
  const isConnected = (p) => Boolean(p?.connected)
  const connected = list.filter(isConnected)

  const statCard = (k, v, unit) => `
    <div class="stat">
      <div class="k">${esc(k)}</div>
      <div class="v">${esc(v)}${unit ? `<small>${esc(unit)}</small>` : ''}</div>
    </div>`

  const creditAccounts = allAccounts.filter((a) => (a?.quota?.unit || 'credit') === 'credit')
  const creditTotal = creditAccounts.reduce((sum, a) => sum + remainingOf(a), 0)
  const today = localDayKey()
  const checkedToday = allAccounts.filter(
    (a) => a.lastCheckinAt && localDayKey(a.lastCheckinAt) === today,
  ).length

  const stats = `
    <div class="stats">
      ${statCard(t('已连接平台'), connected.length, t('个'))}
      ${statCard(t('账号'), allAccounts.length, t('个'))}
      ${statCard(t('剩余额度'), fmt(creditTotal), '')}
      ${statCard(t('今日已签'), `${checkedToday}/${allAccounts.length}`, '')}
    </div>`

  const cards = list.map((platform) => {
    const isOn = isConnected(platform)
    const pfAccounts = allAccounts.filter((a) => a.platformId === platform.id)
    const quota = aggregateQuota(pfAccounts)
    const name = platform.label || platform.connectorId || '—'
    const unitLabel = t(UNIT_LABEL[quota?.unit] || '积分')
    // 剩余量跟着额度单位走：请求次数说成「积分」会让人误以为还有钱没用
    const remaining = quota ? Math.max(0, quota.limit - quota.used) : 0

    const dot = `<span title="${esc(isOn ? t('已连接') : t('未连接'))}" style="display:inline-block;width:7px;height:7px;border-radius:50%;margin-left:7px;vertical-align:middle;background:${isOn ? 'var(--accent)' : 'var(--faint)'}"></span>`
    // 自动连接走的是平台未公开的接口，字段名有猜的成分，标出来免得用户以为是官方支持
    const betaTag =
      platform.connectorId && platform.connectorId !== 'manual'
        ? `<span class="badge" style="margin-left:7px" title="${esc(t('自动连接使用平台未公开接口，可能随平台升级失效'))}">${esc(t('实验性'))}</span>`
        : ''

    const meta = isOn
      ? t('{n} 个账号 · 剩 {r} {unit}', { n: pfAccounts.length, r: fmt(remaining), unit: unitLabel })
      : t('尚未连接')

    let body = ''
    if (isOn) {
      const when = t(quota?.window === 'month' ? '本月' : '今日')
      const pct = quota && quota.limit > 0
        ? Math.min(100, Math.round((quota.used / quota.limit) * 100))
        : 0
      // 80% 变黄、100% 变红：额度和钱一样，快见底时要能一眼看出来
      const fillClass = pct >= 100 ? ' empty' : pct >= 80 ? ' warn' : ''
      const quotaText = quota
        ? t('{when}已用 {used}/{limit} {unit}', {
            when,
            used: fmt(quota.used),
            limit: fmt(quota.limit),
            unit: unitLabel,
          })
        : '—'

      // resetAt 可能没填（手动建的平台就是这样），按 window 推一个下次重置点，
      // 否则「下次重置：—」等于没告诉用户任何信息
      const resetText = relativeHours(resetAtOf(quota), t)
      body = `
        <div class="quota" style="margin-top:12px">
          <div class="quota-track"><div class="quota-fill${fillClass}" style="width:${pct}%"></div></div>
          <span class="quota-text">${esc(quotaText)}</span>
        </div>
        <div class="hint">${esc(t('下次重置：{v}', { v: resetText }))}</div>`
    } else {
      body = `<div class="hint">${esc(t('连接后自动读取模型目录、剩余积分与重置时间。'))}</div>`
    }

    const actions = isOn
      ? `<button class="ghost" data-act="platform-checkin" data-platform="${esc(platform.id)}">${esc(t('签到'))}</button>
         <button class="ghost" data-act="platform-accounts" data-platform="${esc(platform.id)}">${esc(t('账号'))}</button>
         <button class="ghost" data-act="platform-refresh" data-platform="${esc(platform.id)}">${esc(t('刷新'))}</button>`
      : `<span class="badge">${esc(t('尚未连接'))}</span>
         <button data-act="platform-connect" data-platform="${esc(platform.id || platform.connectorId)}">${esc(t('连接'))}</button>`

    return `
      <div class="card" data-platform-card="${esc(platform.id || platform.connectorId)}">
        <div class="card-head">
          <div style="display:flex;align-items:center;gap:10px;min-width:0">
            ${avatarHtml(name, esc)}
            <div style="min-width:0">
              <h3 style="display:flex;align-items:center">${esc(name)}${dot}${betaTag}</h3>
              <div class="meta">${esc(meta)}</div>
            </div>
          </div>
        </div>
        ${body}
        <div class="card-actions" style="margin-top:12px">${actions}</div>
      </div>`
  }).join('')

  // 卡片比表单字段宽：.grid 默认 minmax(190px) 在这个场景下会把配额文字挤换行
  return `
    ${stats}
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr));margin-top:16px">
      ${cards}
    </div>`
}

/** 有 resetAt 就用它；没有就按窗口推下一个重置点（本地时区） */
function resetAtOf(quota) {
  if (quota?.resetAt) return quota.resetAt
  if (!quota?.window) return null
  const now = new Date()
  if (quota.window === 'month') {
    return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()
}

function relativeHours(iso, t) {
  if (!iso) return '—'
  const diff = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(diff)) return '—'
  if (diff <= 0) return t('即将重置')
  const hours = diff / 3600000
  if (hours < 1) return t('{n} 分钟后', { n: Math.max(1, Math.round(diff / 60000)) })
  return t('{n} 小时后', { n: Math.round(hours) })
}
