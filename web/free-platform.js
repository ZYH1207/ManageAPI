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
  // token 额度动辄七位数，不加千分位就是 8000000 这种没法一眼读的数
  const shown = Number.isInteger(value) ? String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : value.toFixed(1)
  return shown
}

/** 本地日期键，与 core/platforms/ledger.js 的 localDayKey 同一口径（前端不能 import node 模块，只能各写一份） */
function localDayKey(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function remainingOf(account) {
  const quota = account?.quota
  if (!quota) return 0
  // 「本周期剩余」才是现在真能用的量。WorkBuddy 的免费订阅会出现
  //   CapacityRemain（包内）= 100、CycleCapacityRemain（本周期）= 0
  // 的情况：这个周期已经用满了，要等下个周期重置，只报 100 会让人以为还有额度。
  const cycle = Number(quota.cycleRemaining)
  if (Number.isFinite(cycle)) return Math.max(0, cycle)
  // 连接器只能读到「还剩多少」，读不到「总量是多少」——那就直接用剩余量，
  // 别硬造一个 limit 出来（会造成「已用 0/113」这种假进度）
  const remain = Number(quota.remaining)
  if (Number.isFinite(remain)) return Math.max(0, remain)
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
export function aggregateQuota(accounts) {
  const rows = accounts
    .map((a) => a?.quota)
    .filter((q) => q && (Number(q.limit) > 0 || Number.isFinite(Number(q.remaining))))
  if (rows.length === 0) return null
  const unit = rows[0].unit || 'credit'
  const same = rows.filter((q) => (q.unit || 'credit') === unit)
  const now = Date.now()
  const resets = same
    .map((q) => q.resetAt)
    .filter((at) => at && new Date(at).getTime() > now)
    .sort()
  const hasLimit = same.some((q) => Number(q.limit) > 0)
  // 本周期还剩多少：WorkBuddy 的免费订阅会出现「包内还剩 100、本周期已用满」，
  // 只报包内剩余会让人以为还能用，所以单独带一个数出去
  const cycles = same
    .map((q) => Number(q.cycleRemaining))
    .filter((n) => Number.isFinite(n))
  const cycleSizes = same
    .map((q) => Number(q.cycleSize))
    .filter((n) => Number.isFinite(n))
  // 一次性赠量（活动送的 token）不在 remaining 里，单独汇总，卡片上补一句
  const bonuses = same.map((q) => Number(q.bonusTokens)).filter((n) => Number.isFinite(n) && n > 0)
  return {
    unit,
    window: same[0].window === 'month' ? 'month' : 'day',
    // hasLimit=false 表示只知道剩余量、不知道总量：界面据此换一种说法
    hasLimit,
    limit: same.reduce((sum, q) => sum + (Number(q.limit) || 0), 0),
    used: same.reduce((sum, q) => sum + (Number(q.used) || 0), 0),
    // remaining = 现在能用多少（优先本周期剩余）
    remaining: same.reduce((sum, q) => sum + remainingOf({ quota: q }), 0),
    // capacity = 套餐容量，只用来在下面补一句「套餐里一共 100」，不参与「还剩多少」
    capacity: same.reduce((sum, q) => sum + (Number.isFinite(Number(q.remaining)) ? Number(q.remaining) : 0), 0),
    cycleRemaining: cycles.length ? cycles.reduce((sum, n) => sum + n, 0) : null,
    cycleSize: cycleSizes.length ? cycleSizes.reduce((sum, n) => sum + n, 0) : null,
    bonusTokens: bonuses.length ? bonuses.reduce((sum, n) => sum + n, 0) : null,
    resetAt: resets[0] || null,
  }
}

/**
 * 同一个租户下的多张卡不能重复计入总额。
 *
 * WorkBuddy 国际版/国内版是同一套账号（同一个 AppId），两张卡读回同一个余额，
 * 直接相加会凭空多出一份。有 tenantKey 就按它去重，没有就各自算。
 */
function dedupeByTenant(accounts) {
  const seen = new Set()
  const out = []
  for (const account of accounts) {
    const key = account?.quota?.tenantKey
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push(account)
  }
  return out
}

/** 首字母色块：颜色由名字哈希决定，同一个平台每次渲染颜色都一样 */
function avatarHtml(label, esc) {
  const text = String(label || '?').trim()
  const initial = (text[0] || '?').toUpperCase()
  let hash = 0
  for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)) % 360
  return `<span style="width:34px;height:34px;border-radius:9px;flex:none;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600;color:#fff;background:hsl(${hash} 46% 45%)">${esc(initial)}</span>`
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
  // 正在等待授权的平台：{ platformId, elapsedMs, reason }
  pending = null,
  // 图标渲染器由 app.js 注入（内联 SVG），这里不自己造一套图标
  icon = () => '',
} = {}) {
  const list = Array.isArray(platforms) ? platforms : []
  const allAccounts = Array.isArray(accounts) ? accounts : []

  // 内置平台里「还没添加」的那些，作为卡片直接摆出来——用户不用先知道自己要加什么
  const addedPresetIds = new Set(list.map((p) => p.presetId).filter(Boolean))
  const addedConnectors = new Set(
    list.filter((p) => p.connectorId && p.connectorId !== 'manual').map((p) => p.connectorId),
  )
  const available = (Array.isArray(presets) ? presets : []).filter(
    (p) => !addedPresetIds.has(p.id) && !(p.connectorId !== 'manual' && addedConnectors.has(p.connectorId)),
  )

  const presetBlock = available.length
    ? `
    <h3 class="section-title" style="margin-top:20px">内置平台</h3>
    <div class="grid preset-grid">
      ${available
        .map(
          (p) => `
        <div class="preset-card">
          <div class="preset-main">
            ${avatarHtml(p.label, esc)}
            <div class="preset-text">
              <h3>${esc(p.label)}</h3>
              <div class="meta">${esc(t(p.note || ''))}</div>
            </div>
          </div>
          <div class="preset-actions">
            <button class="ghost tiny" data-act="add-preset-platform" data-preset="${esc(p.id)}">${esc(t('添加'))}</button>
            ${
              p.connectorId !== 'manual'
                ? `<button class="tiny" data-act="add-preset-platform" data-preset="${esc(p.id)}" data-connect="1">${esc(t('添加并连接'))}</button>`
                : ''
            }
          </div>
        </div>`,
        )
        .join('')}
    </div>`
    : ''

  const helpBlock = `
    <div class="alert calm" style="margin-top:18px;align-items:flex-start">
      <span class="grow" style="line-height:1.75">
        <b>${esc(t('参数怎么填'))}</b>
        <span class="desc" style="display:block;margin-top:2px">
          · <b>${esc(t('额度上限'))}</b> —— ${esc(t('平台给的总量，写数字就行（20、100、500000）'))}<br />
          · <b>${esc(t('单位'))}</b> —— ${esc(t('平台按「次」给就选次，按积分就选积分，按 token 就选 token；拿不准选积分'))}<br />
          · <b>${esc(t('窗口'))}</b> —— ${esc(t('每天重置选「每天」，每月重置选「每月」'))}<br />
          · <b>${esc(t('平台名'))}</b> —— ${esc(t('随便起，只用于你自己识别'))}<br />
          · <b>${esc(t('连接'))}</b> —— ${esc(t('想让程序自动读额度就用「连接」（WorkBuddy / CodeBuddy 支持）；其余平台先手动记，用完了自己更新'))}
        </span>
      </span>
    </div>`

  if (list.length === 0) {
    // 没有任何平台时也要把「内置卡片 + 参数说明」摆出来，而不是一句「还没有连接平台」
    return `
      ${presetBlock}
      ${helpBlock}
      ${formOpen ? manualFormHtml(esc, t, presets) : `<div style="margin-top:14px"><button data-act="platform-add">${esc(t('手动添加一个不在列表里的平台'))}</button></div>`}`
  }

  // 「已连接」由服务端算：需要登录的平台必须有 token，手动平台有账号即可。
  // 前端不再自己推断——判断依据放在两处迟早会不一致。
  const isConnected = (p) => Boolean(p?.connected)
  const connected = list.filter(isConnected)

  // 与概览/监控同一套结构：左「标签 + 数字」、右一枚色调图标；数字太长时只在数字内部换行
  const statCard = (k, v, unit, iconName, tint) => `
    <div class="stat">
      <div class="stat-main">
        <div class="k">${esc(k)}</div>
        <div class="v">${esc(v)}${unit ? `<small>${esc(unit)}</small>` : ''}</div>
      </div>
      ${iconName ? `<div class="stat-icon ${tint || 'tint-muted'}">${icon(iconName)}</div>` : ''}
    </div>`

  // 汇总只看「现在能用多少」，并按单位分开算：积分和 token 相加是无意义的数字。
  // 只有一种单位时就只显示数字（原来那样），多种单位才把单位写出来。
  const totals = new Map()
  for (const account of dedupeByTenant(allAccounts)) {
    const unit = account?.quota?.unit || 'credit'
    const value = remainingOf(account)
    if (!Number.isFinite(value)) continue
    totals.set(unit, (totals.get(unit) || 0) + value)
  }
  const totalLabel =
    totals.size === 0
      ? '0'
      : totals.size === 1
        ? fmt([...totals.values()][0])
        : [...totals.entries()]
            .map(([unit, value]) => `${fmt(value)} ${t(UNIT_LABEL[unit] || '积分')}`)
            .join(' · ')
  const today = localDayKey()
  // 只有「能签到的平台」的账号才计入分母：ZCode 这类没有签到能力，算进去永远签不满
  const checkableAccounts = allAccounts.filter((a) => {
    const owner = list.find((p) => p.id === a.platformId)
    return owner ? owner.canCheckin !== false : false
  })
  const checkedToday = checkableAccounts.filter(
    (a) => a.lastCheckinAt && localDayKey(a.lastCheckinAt) === today,
  ).length

  const stats = `
    <div class="stats">
      ${statCard(t('已连接平台'), connected.length, t('个'), 'servers', 'tint-muted')}
      ${statCard(t('账号'), allAccounts.length, t('个'), 'layers', 'tint-accent')}
      ${statCard(t('剩余额度'), totalLabel, '', 'wallet', 'tint-muted')}
      ${statCard(t('今日已签'), `${checkedToday}/${checkableAccounts.length}`, '', 'receipt', 'tint-warn')}
    </div>`

  const cards = list.map((platform) => {
    const isOn = isConnected(platform)
    const pfAccounts = allAccounts.filter((a) => a.platformId === platform.id)
    // 与顶部汇总同口径：同租户两账号（国际版/国内版双卡）只按一份算，否则卡上额度翻倍
    const quota = aggregateQuota(dedupeByTenant(pfAccounts))
    const name = platform.label || platform.connectorId || '—'
    const unitLabel = t(UNIT_LABEL[quota?.unit] || '积分')
    // 剩余量跟着额度单位走：请求次数说成「积分」会让人误以为还有钱没用
    const remaining = quota ? remainingOf({ quota }) : 0

    const dot = `<span title="${esc(isOn ? t('已连接') : t('未连接'))}" style="display:inline-block;width:7px;height:7px;border-radius:50%;margin-left:7px;vertical-align:middle;background:${isOn ? 'var(--accent)' : 'var(--faint)'}"></span>`
    // 自动连接走的是平台未公开的接口，字段名有猜的成分，标出来免得用户以为是官方支持
    const betaTag =
      platform.connectorId && platform.connectorId !== 'manual'
        ? `<span class="badge" style="margin-left:7px" title="${esc(t('自动连接使用平台未公开接口，可能随平台升级失效'))}">${esc(t('实验性'))}</span>`
        : ''

    const isPending = Boolean(pending) && pending.platformId === platform.id
    // 余额已经在卡片正文里写了，meta 再写一遍会重复（「剩 100 积分」出现两行）
    const meta = isOn
      ? t('{n} 个账号', { n: pfAccounts.length })
      : isPending
        ? pending.local
          ? t('正在读本机客户端里的登录态…')
          : t('等待授权… 已 {s} 秒', { s: Math.round((pending.elapsedMs || 0) / 1000) })
        : t('尚未连接')

    let body = ''
    if (isOn) {
      const when = t(quota?.window === 'month' ? '本月' : '今日')
      // 只知道「还剩多少」时没有分母，画不出百分比进度——那就别画，直接报数
      const hasLimit = Boolean(quota?.hasLimit)
      const pct = hasLimit
        ? Math.min(100, Math.round((quota.used / quota.limit) * 100))
        : 0
      // 80% 变黄、100% 变红：额度和钱一样，快见底时要能一眼看出来
      const fillClass = pct >= 100 ? ' empty' : pct >= 80 ? ' warn' : ''
      const quotaText = !quota
        ? '—'
        : hasLimit
          ? t('{when}已用 {used}/{limit} {unit}', {
              when,
              used: fmt(quota.used),
              limit: fmt(quota.limit),
              unit: unitLabel,
            })
          : t('剩余 {n} {unit}', { n: fmt(quota.remaining), unit: unitLabel })

      // resetAt 可能没填（手动建的平台就是这样），按 window 推一个下次重置点，
      // 否则「下次重置：—」等于没告诉用户任何信息
      const resetText = relativeHours(resetAtOf(quota), t)
      // 包内剩余和本周期剩余不是一回事：免费订阅会出现「包里还有 100，本周期已用满」。
      // 上面那行「剩余」用的是本周期剩余（真能用的量），这里把套餐容量单独说明，
      // 不然用户会以为额度凭空少了一截。
      const cycle = Number(quota?.cycleRemaining)
      const capacity = Number(quota?.capacity)
      const hasCycle = Number.isFinite(cycle)
      const cycleLine = !hasCycle
        ? ''
        : cycle <= 0
          ? `<div class="hint" style="color:var(--danger)">${esc(t('本周期已用满，{r}重置', { r: resetText }))}</div>`
          : `<div class="hint">${esc(
              Number.isFinite(capacity) && capacity > 0
                ? t('本周期还剩 {n}/{total} {unit}', {
                    n: fmt(cycle),
                    total: fmt(capacity),
                    unit: unitLabel,
                  })
                : t('本周期还剩 {n} {unit}', { n: fmt(cycle), unit: unitLabel }),
            )}</div>`
      const capacityLine =
        hasCycle && Number.isFinite(capacity) && capacity > 0 && capacity !== cycle
          ? `<div class="hint">${esc(t('套餐容量 {n} {unit}', { n: fmt(capacity), unit: unitLabel }))}</div>`
          : ''
      // 一次性赠量（活动送的 token）没有用量桶，不在「剩余」里，单独说一句
      const bonusTokens = Number(quota?.bonusTokens)
      const bonusLine =
        Number.isFinite(bonusTokens) && bonusTokens > 0
          ? `<div class="hint">${esc(t('另有赠量 {n} {unit}（按次消耗，不计入本周期）', { n: fmt(bonusTokens), unit: unitLabel }))}</div>`
          : ''
      const resetLine = hasCycle
        ? ''
        : `<div class="hint">${esc(t('下次重置：{v}', { v: resetText }))}</div>`
      body = `
        <div class="quota" style="margin-top:12px">
          ${hasLimit ? `<div class="quota-track"><div class="quota-fill${fillClass}" style="width:${pct}%"></div></div>` : ''}
          <span class="quota-text">${esc(quotaText)}</span>
        </div>
        ${cycleLine}
        ${capacityLine}
        ${bonusLine}
        ${resetLine}`
    } else if (isPending) {
      // 等待授权时把服务端每次轮询的回应也显示出来——不然用户只看到转圈，
      // 分不清是「还没登录完」还是「登录了但平台没把 token 给回来」
      body = `
        <div class="hint">${
          pending.local
            ? esc(t('ZCode 额度就在本机客户端里，正在读取…读到就会自动出现在卡片上。'))
            : esc(t('已打开授权页。在浏览器里登录，如果弹出「打开 WorkBuddy」，先点取消、留在网页上，直到页面显示授权成功。'))
        }</div>
        ${
          pending.reason
            ? `<div class="hint" style="color:var(--faint)">${esc(t('最近状态：'))}${esc(pending.reason)}</div>`
            : ''
        }`
    } else {
      body = `<div class="hint">${esc(t('连接后自动读取模型目录、剩余积分与重置时间。'))}</div>`
    }

    // 删除入口对三种状态都要有：连错平台、连失败留下的空卡、演示数据，都得能清掉
    const deleteButton = `<button class="ghost danger" data-act="platform-delete" data-platform="${esc(platform.id)}" title="${esc(t('删掉这张卡和它的账号记录'))}">${esc(t('删除'))}</button>`

    // 能不能签到由服务端说了算：连接器没实现 checkin 的平台不显示这个按钮，省得点了报错
    const canCheckin = platform.canCheckin !== false
    const actions = isOn
      ? `${canCheckin ? `<button class="ghost" data-act="platform-checkin" data-platform="${esc(platform.id)}">${esc(t('签到'))}</button>` : ''}
         <button class="ghost" data-act="platform-accounts" data-platform="${esc(platform.id)}">${esc(t('账号'))}</button>
         <button class="ghost" data-act="platform-refresh" data-platform="${esc(platform.id)}">${esc(t('刷新'))}</button>
         <button class="ghost" data-act="platform-diagnose" data-platform="${esc(platform.id)}" title="${esc(t('把平台接口的原始返回复制出来，字段对不上时用'))}">${esc(t('诊断'))}</button>
         ${deleteButton}`
      : isPending
        ? `<button class="ghost" data-act="platform-connect-reopen" data-platform="${esc(platform.id)}">${esc(t('重新打开授权页'))}</button>
           <button class="ghost" data-act="platform-connect-cancel" data-platform="${esc(platform.id)}">${esc(t('取消'))}</button>
           ${deleteButton}`
        : `<span class="badge">${esc(t('尚未连接'))}</span>
           <button data-act="platform-connect" data-platform="${esc(platform.id || platform.connectorId)}">${esc(t('连接'))}</button>
           ${deleteButton}`

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
    <div class="toolbar" style="margin:0 0 10px">
      <span class="hint" style="margin:0">${esc(t('额度是平台给的总量，用完自己更新；想自动读就点「连接」。'))}</span>
      <span class="grow"></span>
      <button data-act="platform-add">${esc(t('手动添加'))}</button>
    </div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">
      ${cards}
    </div>
    ${formOpen ? manualFormHtml(esc, t, presets) : ''}
    ${presetBlock}
    ${helpBlock}`
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
