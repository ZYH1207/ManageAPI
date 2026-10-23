/** 前端：无框架，全量状态 + 重渲染。 */
import { getLang, onLangChange, restoreDom, setLang, t, translateDom } from './i18n.js'

const $ = (sel, root = document) => root.querySelector(sel)

// 先把语言挂到 <html> 上，使用说明的中英双块靠它选显示哪一份
document.documentElement.dataset.lang = getLang()

let state = null
let activeTab = 'providers'

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

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`)
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

  // 余额偏低
  for (const c of state.credentials || []) {
    if (typeof c.quotaRemaining !== 'number') continue
    const threshold = c.currency === 'USD' ? 1.5 : 10
    if (c.quotaRemaining > threshold) continue
    const provider = state.providers.find((p) => p.id === c.providerId)
    list.push({
      id: `quota:${c.id}:${c.quotaRemaining}`,
      level: c.quotaRemaining <= 0 ? 'danger' : 'warn',
      title: t('{name} 余额偏低', { name: provider?.name || t('站点') }),
      desc: t('剩余 {amount} {currency}，该充值了', { amount: c.quotaRemaining, currency: c.currency }),
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
  renderProviders()
  renderFree()
  renderPricing()
  renderDecision()
  renderProbes()
  renderGateway()
  renderUsage()
  renderBenchmark()

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
  const sentence = t('{model} 目前 {provider} 最便宜，{price}/百万 token，比最贵的省 {pct}%', {
    model: esc(line.modelKey),
    provider: `<strong>${esc(line.providerName)}</strong>`,
    price: `<strong>¥${money(line.price)}</strong>`,
    pct: `<strong>${line.spreadPct}%</strong>`,
  })
  return `
    <div class="headline">
      <div class="kicker">当前最优选择</div>
      <div class="line">${sentence}</div>
    </div>`
}

function statsHtml() {
  const s = state.summary
  const items = [
    ['站点', s.providerCount, ''],
    ['模型供给', s.offerCount, '条'],
    ['可横向比较', s.comparableCount, '个模型'],
    ['最大价差', s.maxSpreadPct === null ? '—' : s.maxSpreadPct, s.maxSpreadPct === null ? '' : '%'],
  ]
  return `<div class="stats">${items.map(([k, v, unit]) => `
    <div class="stat"><div class="k">${k}</div>
    <div class="v">${esc(v)}${unit ? `<small>${unit}</small>` : ''}</div></div>`).join('')}</div>`
}

function renderOverview() {
  const view = $('#view-overview')
  const scores = state.scores || {}
  const providers = state.providers

  if (providers.length === 0) {
    setPageSub('还没有数据')
    view.innerHTML = `
      <div class="empty">
        <h3>从添加一个中转站开始</h3>
        <p>填上地址和一个 Key，同步模型列表，就能看到跨站比价。</p>
        <button class="primary" data-goto="providers">去添加站点</button>
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

  const issueBlock =
    issues.length === 0
      ? `
    <h3 class="section-title">需要关注</h3>
    <div class="alert calm">
      <span class="name">一切正常</span>
      <span class="grow"></span>
      <span class="desc">所有探测过的供给都在正常范围</span>
    </div>`
      : `
    <h3 class="section-title">需要关注（${issues.length} 个站点）</h3>
    <div class="alert-list">
      ${issues
        .map(
          (issue) => `
        <div class="alert ${issue.severe ? 'danger' : ''}">
          <span class="name">${esc(issue.name)}</span>
          <span class="desc">${issue.count} 个模型</span>
          <span class="grow"></span>
          <span class="desc">${[...issue.reasons].join(' · ')}</span>
        </div>`,
        )
        .join('')}
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
    const credentials = state.credentials.filter((c) => c.providerId === provider.id)
    const quota = credentials.reduce((sum, c) => {
      if (typeof c.quotaRemaining !== 'number') return sum
      return sum + (c.currency === 'CNY' ? c.quotaRemaining : c.quotaRemaining * state.settings.fxUsdCny)
    }, 0)
    const hasQuota = credentials.some((c) => typeof c.quotaRemaining === 'number')
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
        <td class="num">${hasQuota ? `¥${money(quota)}` : '<span style="color:var(--faint)">未录入</span>'}</td>
        <td class="num">${credentials.length}</td>
      </tr>`
  }).join('')

  setPageSub(
    `${state.summary.providerCount} 个站点 · ${state.summary.offerCount} 条模型供给 · ${state.probeTotal} 次探测`,
  )

  view.innerHTML = `
    ${headlineHtml()}
    ${statsHtml()}
    ${issueBlock}
    <h3 class="section-title">站点速览</h3>
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
async function openGroupPicker(providerId) {
  groupPicker.providerId = providerId
  groupPicker.loading = true
  groupPicker.error = null
  groupPicker.data = null
  groupPicker.selected = ''
  groupPicker.busy = false
  const modal = $('#group-modal')
  if (modal) modal.hidden = false
  renderGroupModal()

  try {
    const data = await api('GET', `/api/providers/${providerId}/groups`)
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
  const rows = d.groups
    .map((g) => {
      const on = g.name === groupPicker.selected
      const covered = g.modelCount
      return `
        <label class="${on ? 'on' : ''}" data-act="pick-group" data-pick-group="${esc(g.name)}">
          <input type="radio" name="pick-group" value="${esc(g.name)}" ${on ? 'checked' : ''} tabindex="-1" />
          <span class="gname">${esc(g.name)}${g.isCurrent ? ' <span class="badge">当前</span>' : ''}</span>
          <span class="grate">${g.rate === null ? '—' : `×${g.rate}`}</span>
          <span class="gcount">${covered} 个模型</span>
        </label>`
    })
    .join('')

  const noRate = d.groups.every((g) => g.rate === null)
  body.innerHTML = `
    <p class="hint" style="margin:0 0 4px">
      <b>${esc(provider?.name || '')}</b> 共 ${d.groups.length} 个分组，数据来自
      ${d.source === 'channels' ? '「可用渠道」' : '「模型广场」'}。
      选你实际买的那个，倍率会立刻填到下面所有模型，比价和决策页同步更新。
    </p>
    ${noRate ? '<p class="hint" style="color:var(--warn);margin:6px 0 0">这个站没公布倍率，只能填绝对价。选完会按原价填入。</p>' : ''}
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
    })
    state = result
    const modal = $('#group-modal')
    if (modal) modal.hidden = true
    groupPicker.busy = false
    render()

    const r = result.groupResult
    const parts = [`「${r.group || '未指定分组'}」已应用`]
    if (r.rate !== null) parts.push(`倍率 ×${r.rate}`)
    parts.push(`${r.updated} 个模型`)
    if (r.unmatched?.length) parts.push(`${r.unmatched.length} 个未匹配`)
    toast(parts.join('，'))
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

/** 扣费核对的展示块：我们的估算 + 站方原始返回 */
function renderUsageCheck(providerId) {
  const check = usageCheckResults[providerId]
  if (!check) return ''
  const est = check.estimate || {}
  return `
    <div class="keylist" style="border-top:1px solid var(--border);padding-top:10px">
      <div class="keyrow" style="border:none;padding-bottom:4px">
        <span style="color:var(--muted);font-size:12px">扣费核对</span>
        <span class="grow"></span>
        <button class="ghost tiny" data-act="close-usage-check">关闭</button>
      </div>
      <div style="font-size:12px;line-height:1.9;padding:2px 0 6px">
        <div>我们的估算：<b>¥${est.cost ?? '—'}</b>
          <span style="color:var(--faint)">（${est.requests || 0} 次请求 · 输入 ${formatTokens(est.input)} / 输出 ${formatTokens(est.output)} token）</span></div>
        <div style="color:var(--faint);margin-top:2px">下面是站方返回的原始数据，差异大说明倍率有水分或计费口径不同。</div>
        <pre class="raw-box">${esc(JSON.stringify(check.raw, null, 2))}</pre>
      </div>
    </div>`
}

function renderProviders() {
  const view = $('#view-providers')
  const addForm = $('#tpl-add-provider').innerHTML

  if (state.providers.length === 0) {
    view.innerHTML = `
      <div class="empty">
        <h3>还没有站点</h3>
        <p>先添加一个中转站，填上它的地址和一个 Key，就能拉取模型列表开始比价。</p>
      </div>
      ${addForm}`
    bindAddProviderForm()
    return
  }

  const cards = state.providers.map((p) => {
    const keys = state.credentials.filter((c) => c.providerId === p.id)
    const offers = state.offers.filter((o) => o.providerId === p.id)
    const priced = offers.filter((o) => o.inPrice !== null || o.outPrice !== null || o.ratio !== null)
    const quota = keys.reduce((sum, k) => {
      if (typeof k.quotaRemaining !== 'number') return sum
      const cny = k.currency === 'CNY' ? k.quotaRemaining : k.quotaRemaining * state.settings.fxUsdCny
      return sum + cny
    }, 0)
    const hasQuota = keys.some((k) => typeof k.quotaRemaining === 'number')

    // 中转站的倍率按「分组」定，不是按模型——所以按分组给一个批量入口
    const groupNames = [...new Set(offers.map((o) => o.group || ''))]
    const groupRows = groupNames.map((groupName) => {
      const groupOffers = offers.filter((o) => (o.group || '') === groupName)
      const ratioValues = new Set(groupOffers.map((o) => (o.ratio === null || o.ratio === undefined ? '' : String(o.ratio))))
      const uniform = ratioValues.size === 1 ? [...ratioValues][0] : ''
      const mixed = ratioValues.size > 1
      const siteRatios = new Set(
        groupOffers.map((o) => (o.siteRatio === null || o.siteRatio === undefined ? '' : String(o.siteRatio))),
      )
      const siteRatio = siteRatios.size === 1 ? [...siteRatios][0] : ''
      const custom = groupOffers.some((o) => o.ratioSource === 'custom')
      return `
        <div class="keyrow" data-group-ratio="${esc(groupName)}">
          <span>${groupName ? esc(groupName) : '<span style="color:var(--faint)">未指定分组</span>'}</span>
          <span class="tail">${groupOffers.length} 个模型</span>
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
              ? `<span style="color:var(--faint);font-size:11px">站点 ×${esc(siteRatio)}</span>`
              : ''
          }
          <input type="number" step="0.01" min="0" placeholder="倍率" value="${uniform}" data-act="group-ratio" style="width:86px" title="改这里就是自定义倍率，不影响站点原始值" />
          ${
            custom
              ? `<button class="ghost tiny" data-act="restore-ratio" data-group="${esc(groupName)}" title="恢复成站点公布的倍率">恢复</button>`
              : ''
          }
        </div>`
    }).join('')
    const hasCustom = offers.some((o) => o.ratioSource === 'custom')

    return `
      <div class="card" data-provider="${esc(p.id)}">
        <div class="card-head">
          <div>
            <h3>${esc(p.name)}</h3>
            <div class="meta">${esc(p.baseUrl)}</div>
          </div>
          <div class="card-actions">
            <button class="ghost" data-act="toggle-provider">${collapsedPanels.has(`provider:${p.id}`) ? '展开' : '收起'}</button>
            <button data-act="sync">同步模型</button>
            <button data-act="open-group-picker" title="从站点读分组，选你买的那个，倍率自动填到下面所有模型">导入倍率</button>
            <button data-act="usage-check" title="用管理令牌拉站方用量，和我们的估算对比">用量核对</button>
            <button data-act="balance">读余额</button>
            <button data-act="export">导出配置</button>
            <button data-act="del-provider" class="danger">删除</button>
          </div>
        </div>
        <div ${collapsedPanels.has(`provider:${p.id}`) ? 'hidden' : ''}>
        <div class="badges">
          <span class="badge">${keys.length} 个 Key</span>
          <span class="badge">${offers.length} 个模型</span>
          <span class="badge ${priced.length ? 'ok' : 'warn'}">${priced.length} 个已定价</span>
          ${hasQuota ? `<span class="badge ok">余额 ≈ ¥${money(quota)}</span>` : '<span class="badge warn">余额未录入</span>'}
        </div>
        <div class="keylist">
          ${keys.length === 0 ? '<div class="hint">还没有 Key，加一个才能拉模型。</div>' : keys.map((k) => `
            <div class="keyrow" data-credential="${esc(k.id)}">
              <span>${esc(k.label)}</span>
              <span class="tail">sk-••••${esc(k.tail || '????')}</span>
              <button class="ghost tiny group-chip" data-act="open-group-picker" title="${k.group ? '这把 Key 属于这个分组，点这里换' : '还没选分组，点这里选（会顺便把倍率填好）'}">
                ${k.group ? `分组 · ${esc(k.group)}` : '选分组'}
              </button>
              <span class="grow"></span>
              <input type="number" step="0.01" placeholder="余额" value="${k.quotaRemaining ?? ''}" data-act="quota" />
              <select data-act="currency" style="width:74px">
                <option value="CNY" ${k.currency === 'CNY' ? 'selected' : ''}>CNY</option>
                <option value="USD" ${k.currency === 'USD' ? 'selected' : ''}>USD</option>
              </select>
              <button class="ghost" data-act="set-admin-token" title="填后台登录令牌后，可自动读余额">${k.hasAdminToken ? '令牌 ✓' : '令牌'}</button>
              <button class="ghost danger" data-act="del-key">删除</button>
            </div>`).join('')}
          <form class="inline-form" data-form="add-key">
            <input name="label" placeholder="标签" />
            <input name="secret" placeholder="sk-... 粘贴完整 Key" autocomplete="off" required />
            <input name="group" placeholder="分组（可选）" style="width:118px" title="这把 Key 属于站点的哪个分组，同步模型时会自动带上" />
            <button type="submit">添加 Key</button>
          </form>
          <div class="hint" style="margin-top:2px">
            ${t('「令牌」是站点后台的登录凭证，只用来读余额、不参与对话。获取：登录后台 → F12 → Network → 点任意 <code>/api/v1/</code> 请求 → 复制 Request Headers 里的 <code>Authorization</code>（去掉 <code>Bearer </code> 前缀）。令牌会过期，失效后重新复制。')}
          </div>
        </div>
        ${groupRows ? `
        <div class="keylist" style="border-top:1px solid var(--border);padding-top:10px">
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
        ${renderUsageCheck(p.id)}
        </div>
      </div>`
  }).join('')

  view.innerHTML = `
    ${addForm}
    ${cards}`
  bindAddProviderForm()
}

function bindAddProviderForm() {
  const form = $('#form-add-provider')
  if (!form || form.dataset.bound) return
  form.dataset.bound = '1'
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = Object.fromEntries(new FormData(form))
    try {
      state = await api('POST', '/api/providers', data)
      render()
      toast('站点已添加')
    } catch (error) {
      toast(error.message, true)
    }
  })
}

// --------------------------------------------------------------- 免费池视图

/** 两栏共用的边界说明。放在切换控件上方，一次说清。 */
function freeNoteHtml() {
  // 整段交给 t()：句子里有 <code> 会被拆成多个文本节点，
  // 逐节点匹配翻不了，只能整段翻（和基准价页那三条说明同一个做法）。
  const inner =
    '<b>免费池独立于付费比价</b><span class="desc" style="display:block;margin-top:2px">这里的供给不参与「最便宜」判断和自动选站。只有你在客户端写 <code>free/</code> 前缀，或把地址换成 <code>/free/v1</code> 时才会用到。</span>'
  return `
    <div class="alert calm" style="margin-bottom:14px;align-items:flex-start">
      <span class="grow" style="line-height:1.65">${t(inner)}</span>
    </div>`
}

function freeSegHtml(relayCount, platformCount) {
  const btn = (pane, label, count) => `
    <button type="button" data-act="free-pane" data-pane="${pane}" class="${freePane === pane ? 'active' : ''}">
      ${label}<span class="seg-count">${count}</span>
    </button>`
  return `<div class="seg">${btn('relay', '中转站免费模型', relayCount)}${btn('platform', '平台积分', platformCount)}</div>`
}

function freeStats(items) {
  return `<div class="stats">${items
    .map(
      ([k, v, unit]) => `
    <div class="stat"><div class="k">${esc(k)}</div>
    <div class="v">${esc(v)}${unit ? `<small>${unit}</small>` : ''}</div></div>`,
    )
    .join('')}</div>`
}

/** 中转站侧：一行一个模型，同一模型的多个来源合并 */
function freeRelayPane(offers) {
  if (offers.length === 0) {
    return `
      <div class="empty">
        <h3>还没有免费模型</h3>
        <p>去「站点」页点「导入倍率」，实际价为 0 的模型会自动出现在这里。</p>
        <button class="primary" data-goto="providers">去站点导入</button>
      </div>`
  }

  const providerName = (id) => state.providers.find((p) => p.id === id)?.name || '—'
  const routable = offers.filter((o) => o.score?.routable).length
  const withFp = offers.filter((o) => typeof o.score?.fingerprintRate === 'number')
  const avgFp = withFp.length
    ? withFp.reduce((s, o) => s + o.score.fingerprintRate, 0) / withFp.length
    : null
  const withTtft = offers.filter((o) => typeof o.score?.ttftMs === 'number')
  const avgTtft = withTtft.length
    ? withTtft.reduce((s, o) => s + o.score.ttftMs, 0) / withTtft.length
    : null

  const stats = freeStats([
    ['可用供给', `${routable}/${offers.length}`, '条'],
    ['平均指纹', avgFp === null ? '—' : Math.round(avgFp * 100), avgFp === null ? '' : '%'],
    ['平均首字', avgTtft === null ? '—' : Math.round(avgTtft), avgTtft === null ? '' : 'ms'],
    ['剩余额度', '—', ''], // 配额在 T1-3 实现
  ])

  const rows = offers
    .map((offer) => {
      const score = offer.score || {}
      const status = !score.samples
        ? { label: '未探测', cls: '' }
        : score.routable
          ? { label: '可用', cls: 'ok' }
          : { label: '可疑', cls: 'warn' }
      const fp = typeof score.fingerprintRate === 'number' ? `${Math.round(score.fingerprintRate * 100)}%` : '—'
      const ttft = typeof score.ttftMs === 'number' ? `${Math.round(score.ttftMs)}ms` : '—'
      return `
        <tr>
          <td class="mono">${esc(offer.upstreamName)}</td>
          <td>${esc(providerName(offer.providerId))}</td>
          <td>${offer.group ? esc(offer.group) : '<span style="color:var(--faint)">默认</span>'}</td>
          <td class="mono">—</td>
          <td class="mono">${fp}</td>
          <td class="mono">${ttft}</td>
          <td><span class="badge ${status.cls}">${status.label}</span></td>
        </tr>`
    })
    .join('')

  return `
    ${stats}
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>模型</th><th>站点</th><th>分组</th><th>配额</th>
          <th>指纹</th><th>首字</th><th>状态</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint" style="margin-top:10px">
      免费模型是探针最有价值的场景：没人会白送，最常见的偷工方式是拿小模型冒充大模型。
      指纹低于 100% 的那几行值得点开看看。
    </p>`
}

/** 平台侧：卡片网格。T2 阶段接入 connector 后填充。 */
function freePlatformPane(platforms) {
  if (platforms.length === 0) {
    return `
      <div class="empty">
        <h3>还没有连接平台</h3>
        <p>平台积分可以来自 WorkBuddy、Trae 等 Agent 平台。连接后能自动读模型目录、剩余积分与重置时间。</p>
        <span class="badge">连接功能开发中</span>
      </div>`
  }
  return ''
}

function renderFree() {
  const view = $('#view-free')
  if (!view) return
  const pool = state.freePool || {}
  const relay = pool.relay || []
  const platforms = pool.platforms || []

  // 两栏都没内容时给一个「两个来源」的引导，不落到某一栏的空态
  if (relay.length === 0 && platforms.length === 0) {
    view.innerHTML = `
      ${freeNoteHtml()}
      <div class="empty">
        <h3>免费额度有两个来源</h3>
        <p style="text-align:left;display:inline-block;line-height:1.9;margin:8px 0 16px">
          <b>① 中转站的免费模型</b><br />
          去「站点」页点「导入倍率」，实际价为 0 的模型会自动出现在这里<br /><br />
          <b>② 平台的免费积分</b><br />
          连接 WorkBuddy、Trae 等平台，或手动填一个额度
        </p>
        <div>
          <button class="primary" data-goto="providers">去站点导入</button>
        </div>
      </div>`
    return
  }

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
    <p class="hint">填「倍率」最省事：实际价 = 基准价 × 倍率。不知道倍率就直接填输入/输出单价。</p>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>站点</th><th>上游模型名</th><th class="num">基准价</th>
          <th class="num">输入价</th><th class="num">输出价</th><th class="num">倍率</th>
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
              <td class="mono">${esc(offer.upstreamName)}${offer.group ? ` <span class="badge">${esc(offer.group)}</span>` : ''}</td>
              <td class="num" style="color:var(--faint)">${benchText}</td>
              <td class="num"><input type="number" step="0.001" placeholder="—" value="${offer.inPrice ?? ''}" data-field="inPrice" /></td>
              <td class="num"><input type="number" step="0.001" placeholder="—" value="${offer.outPrice ?? ''}" data-field="outPrice" /></td>
              <td class="num"><input class="ratio" type="number" step="0.01" placeholder="倍率" value="${offer.ratio ?? ''}" data-field="ratio" /></td>
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

  const groups = visibleGroups.map((group) => {
    const panelKey = `pricing:${group.modelKey}`
    const isCollapsed = collapsedPanels.has(panelKey)
    const rows = group.rows.map((row) => {
      const score = state.scores[row.offerId]
      const maxTtft = Number(state.settings.maxTtftMs) || 0
      const tooSlow =
        maxTtft > 0 && typeof score?.ttftMs === 'number' && score.ttftMs > maxTtft
      const badge = tooSlow
        ? ' <span class="badge warn">超时</span>'
        : score?.probeTrusted === false
          ? ' <span class="badge warn">可疑</span>'
          : ''
      const cacheNote =
        row.cacheHitRate === null || row.cacheHitRate === undefined
          ? ''
          : row.cacheHitRate > 0
            ? `<div class="sub">缓存 ${Math.round(row.cacheHitRate * 100)}%</div>`
            : '<div class="sub">无缓存</div>'
      return `
      <tr class="${row.isCheapest ? 'cheapest' : ''}" data-offer="${esc(row.offerId)}">
        <td>${esc(providerName(row.providerId))}</td>
        <td class="mono">${esc(row.upstreamName)}${badge}${cacheNote}</td>
        <td><input class="group-input" type="text" placeholder="默认" value="${esc(row.group || '')}" data-field="group" /><button class="ghost tiny" data-act="dup-offer" title="按这个模型再建一个分组">＋</button></td>
        <td class="num"><input type="number" step="0.001" placeholder="${row.ratio ? '按倍率' : '—'}" value="${row.inPrice ?? ''}" data-field="inPrice" /></td>
        <td class="num"><input type="number" step="0.001" placeholder="${row.ratio ? '按倍率' : '—'}" value="${row.outPrice ?? ''}" data-field="outPrice" /></td>
        <td>
          <select data-field="currency" style="width:70px">
            <option value="USD" ${row.currency === 'USD' ? 'selected' : ''}>USD</option>
            <option value="CNY" ${row.currency === 'CNY' ? 'selected' : ''}>CNY</option>
          </select>
        </td>
        <td class="num"><input class="ratio" type="number" step="0.01" placeholder="倍率" value="${row.ratio ?? ''}" data-field="ratio" /></td>
        <td class="num">${row.ttftMs ? `${row.ttftMs}ms` : '—'}</td>
        <td class="num">${row.blendedCnyPerMtok === null ? '—' : `¥${money(row.blendedCnyPerMtok)}`}${row.hasOffPeak && row.offPeakBlendedCnyPerMtok !== null ? `<div class="sub">空闲 ¥${money(row.offPeakBlendedCnyPerMtok)}</div>` : ''}</td>
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
        <table>
          <thead><tr>
            <th>站点</th><th>上游模型名</th><th>分组</th>
            <th class="num">输入价</th><th class="num">输出价</th>
            <th>币种</th><th class="num">倍率</th>
            <th class="num">首字</th><th class="num">¥/百万 token</th><th class="num">价差</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`}
      </div>`
  }).join('')

  view.innerHTML = `
    <div class="toolbar">
      <input id="pricing-search" class="search" type="search" placeholder="搜索模型名…" value="${esc(filters.pricing)}" />
      <span class="hint" style="margin:0">${visibleGroups.length} / ${state.ranked.length} 个模型</span>
    </div>
    <p class="hint">价格直接改，失焦即保存。「¥/百万 token」是综合成本：输入按 25%、输出按 75% 加权。美元标价的站按「基准价」页里的汇率换算。</p>
    ${groups}${unpricedBlock}`
}


// --------------------------------------------------------------- 决策视图

function decisionState(candidate) {
  if (candidate.tooSlow) return { label: t('太慢'), cls: 'warn' }
  // 探针说可疑，但因为「放行可疑供给」开着，它照样参与选站——标出来别让人误以为是健康的
  const passed = candidate.routable && candidate.probeOk === false
  const tag = (label, cls) => ({
    label: passed ? `${label} · ${t('已放行')}` : label,
    cls: passed ? 'warn' : cls,
  })
  if (candidate.status === 'stale') return tag(t('评分过期'), 'warn')
  if (candidate.status === 'degraded') return tag(t('结果可疑'), 'warn')
  if (candidate.status === 'unstable') return tag(t('不稳定'), 'danger')
  if (candidate.status === 'unknown') return tag(t('未探测'), '')
  return { label: t('可用'), cls: 'ok' }
}

function renderDecision() {
  const view = $('#view-decision')
  const decisions = state.decisions || []

  if (state.providers.length === 0) {
    view.innerHTML = `
      <div class="empty">
        <h3>还没有站点</h3>
        <p>先添加站点并同步模型，这里会显示路由怎么选。</p>
        <button class="primary" data-goto="providers">去添加站点</button>
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
          <td>${candidate.group ? `<span class="badge">${esc(candidate.group)}</span>` : '<span style="color:var(--faint)">默认</span>'}</td>
          <td class="num">${candidate.price === null ? '—' : `¥${money(candidate.price)}`}</td>
          <td class="num">${candidate.quality === null ? '—' : candidate.quality.toFixed(2)}</td>
          <td class="num">${candidate.effective === null ? '—' : `¥${money(candidate.effective)}`}</td>
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
    <div class="toolbar">
      <input id="decision-search" class="search" type="search" placeholder="搜索模型名…" value="${esc(filters.decision)}" />
      <span class="hint" style="margin:0">${visibleDecisions.length} / ${decisions.length} 个模型</span>
    </div>
    <p class="hint">默认按「有效成本 = 价格 ÷ 质量」排序，用 ↑↓ 手动调整「可用」那几条的先后——不可信的站不会因为你拖它而排到前面。</p>
    <p class="hint">${t('注意：<b>同一个模型在不同站的状态是各自独立的</b>（A 站健康、B 站掉包很正常），所以这里按「站 × 模型」逐条评估，状态下方会写明具体原因。')}</p>
    ${blocks}`
}

// --------------------------------------------------------------- 探针视图

const PROBE_STATUS = {
  healthy: { label: '健康', cls: 'ok' },
  degraded: { label: '结果可疑', cls: 'warn' },
  unstable: { label: '不稳定', cls: 'danger' },
  stale: { label: '评分过期', cls: 'warn' },
  unknown: { label: '未探测', cls: '' },
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
        <div class="detail-line">质量 <b>${fmt(score.quality)}</b>
          <span class="dim">= 可用率 × 完整性，低于 0.8 就不参与路由</span></div>
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
  const maxTtft = Number(state.settings.maxTtftMs) || 0
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
        <label class="field-inline">首字上限
          <input id="max-ttft" type="number" min="0" max="60000" step="500" value="${maxTtft}" style="width:82px" /> ms
        </label>
        <span class="hint" style="margin:0">0 = 不限；超过上限的供给不参与路由</span>
      </div>
      <div class="switch-row">
        <label class="switch">
          <input type="checkbox" id="allow-untrusted" ${allowUntrusted ? 'checked' : ''} />
          <span class="switch-track"><span class="switch-knob"></span></span>
          <span class="switch-text">
            <b>放行可疑供给</b>
            <span>探针判定可疑（指纹不符 / 输出截断 / 用量虚报 / 评分过期）的站，也按有效成本正常参与路由</span>
          </span>
        </label>
        ${
          allowUntrusted
            ? `<div class="alert" style="margin-top:10px;background:var(--warn-soft);border-color:var(--warn-border)">
                 <div>
                   <div class="name">已放行：可疑的站会正常参与选站</div>
                   <div class="desc">它们仍然按「价格 ÷ 质量」排序——质量差一半，成本就翻倍，只有便宜到足够多才会被选中。首字上限仍然独立生效。如果你更在意输出是否可信，把这个开关关掉。</div>
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
      return `
        <tr data-offer="${esc(offer.id)}" ${hasDetail ? 'data-act="toggle-detail" style="cursor:pointer"' : ''}>
          <td class="mono">${esc(offer.upstreamName)}${offer.group ? ` <span class="badge">${esc(offer.group)}</span>` : ''}${hasDetail ? ' <span style="color:var(--faint);font-size:10px">▾</span>' : ''}</td>
          <td><span class="badge ${status.cls}">${status.label}</span></td>
          <td class="num">${pct(score?.availability)}</td>
          <td class="num">${pct(score?.fingerprintRate)}</td>
          <td class="num">${pct(score?.truncationRate)}</td>
          <td class="num">${pct(score?.billingRate)}</td>
          <td class="num">${score?.ttftMs ? `${score.ttftMs}ms` : '—'}</td>
          <td style="color:var(--faint)">${relTime(score?.lastProbeAt)}</td>
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
            <th class="num">TTFT</th><th>上次探测</th><th></th>
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
          <td style="color:var(--faint)">${new Date(r.ts).toLocaleTimeString('zh-CN')}</td>
          <td>${esc(r.keyName || '—')}</td>
          <td class="mono">${esc(r.model)}</td>
          <td>${r.chosenProviderName ? `${esc(r.chosenProviderName)}${r.chosenGroup ? ` <span class="badge">${esc(r.chosenGroup)}</span>` : ''}` : '<span class="badge danger">全部失败</span>'}</td>
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
    setPageSub('还没有请求经过网关')
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

  setPageSub(
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

  const rows = entries.map(([key, entry]) => `
    <tr data-benchmark="${esc(key)}">
      <td class="mono">${esc(key)}</td>
      <td>${esc(entry.display || key)}</td>
      <td class="num"><input type="number" step="0.001" placeholder="—" value="${entry.in ?? ''}" data-field="in" /></td>
      <td class="num"><input type="number" step="0.001" placeholder="—" value="${entry.out ?? ''}" data-field="out" /></td>
      <td class="num"><input type="number" step="0.001" placeholder="空闲" value="${entry.offPeakIn ?? ''}" data-field="offPeakIn" style="width:76px" /></td>
      <td class="num"><input type="number" step="0.001" placeholder="空闲" value="${entry.offPeakOut ?? ''}" data-field="offPeakOut" style="width:76px" /></td>
      <td>
        <select data-field="currency" style="width:70px">
          <option value="USD" ${entry.currency !== 'CNY' ? 'selected' : ''}>USD</option>
          <option value="CNY" ${entry.currency === 'CNY' ? 'selected' : ''}>CNY</option>
        </select>
      </td>
      <td class="mono" style="color:var(--faint)">${esc(entry.source || 'manual')}</td>
      <td class="num"><button class="ghost danger" data-act="del-benchmark">删除</button></td>
    </tr>`).join('')

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
      <span class="hint" style="margin:0">${entries.length} / ${Object.keys(state.benchmarks).length} 条</span>
      <span style="flex:1"></span>
      <label class="field-inline" title="只影响按美元标价的站点">
        <span data-i18n="汇率 USD→CNY">汇率 USD→CNY</span>
        <input id="fx-input" data-act="fx" type="number" step="0.01" min="1" value="${esc(state.settings.fxUsdCny)}" style="width:78px" />
      </label>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>模型 key</th><th>显示名</th><th class="num">输入价</th><th class="num">输出价</th>
          <th class="num">空闲输入</th><th class="num">空闲输出</th>
          <th>币种</th><th>来源</th><th></th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="9" style="color:var(--faint);text-align:center;padding:24px">还没有基准价</td></tr>'}</tbody>
      </table>
    </div>`
}

// ------------------------------------------------------------------ 事件

async function withBusy(button, fn) {
  const original = button?.textContent
  if (button) { button.disabled = true; button.textContent = '处理中…' }
  try {
    await fn()
  } catch (error) {
    toast(error.message, true)
  } finally {
    if (button) { button.disabled = false; button.textContent = original }
  }
}

/**
 * 联系方式 —— 开源前把 value 改成你自己的。
 * type: github / blog / qq / email / link
 * qq 和 email 点击是复制，其余点击是打开链接。value 留空则该项不显示。
 */
const CONTACTS = [
  { type: 'github', label: 'GitHub', value: 'https://github.com/ZYH1207', desc: '源码与更新' },
  { type: 'blog', label: '博客', value: 'https://zyh1207.github.io/', desc: '使用笔记与踩坑记录' },
  { type: 'qq', label: 'QQ 群', value: '', desc: '问题交流' },
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
      <div class="contact-card" data-act="${copyable ? 'copy-contact' : 'open-contact'}" data-value="${esc(c.value)}">
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

const TABS = ['overview', 'providers', 'free', 'pricing', 'decision', 'probes', 'gateway', 'usage', 'benchmark']

/** 折叠状态：'provider:xxx' / 'pricing:模型名' / 'probe:站点id' */
const collapsedPanels = new Set()

/** 免费页当前栏：'relay'（中转站免费模型）| 'platform'（平台积分） */
let freePane = 'relay'

/** 搜索框内容 */
const filters = { pricing: '', decision: '', benchmark: '' }

const TAB_META = {
  overview: { title: '概览', sub: '当前状态一眼看完' },
  providers: { title: '站点', sub: '中转站、Key 与分组倍率' },
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

function setTab(name) {
  // 支持二级 hash：#free/relay、#free/platform
  const [tabPart, panePart] = String(name || '').split('/')
  if (tabPart === 'free' && ['relay', 'platform'].includes(panePart)) freePane = panePart
  name = tabPart

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
}

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
  if (event.key !== 'Escape') return
  closeLangMenu()
  for (const id of ['help-modal', 'contact-modal', 'group-modal']) {
    const modal = document.getElementById(id)
    if (modal && !modal.hidden) modal.hidden = true
  }
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

  const rangeBtn = event.target.closest('[data-range]')
  if (rangeBtn) {
    const days = Number(rangeBtn.dataset.range)
    if (days === usageRange && usageData) return
    await withBusy(rangeBtn, async () => {
      const res = await api('GET', `/api/usage?days=${days}`)
      usageData = res.usage
      usageRange = days
      renderUsage()
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

  if (action === 'sync') {
    await withBusy(actionButton, async () => {
      const result = await api('POST', `/api/providers/${providerId}/sync`, {})
      state = result
      render()
      const sync = result.sync
      const removed = sync.removed.length ? `，${sync.removed.length} 个已下线` : ''
      toast(`拉到 ${sync.fetched} 个模型，新增 ${sync.added}${removed}（${sync.elapsedMs}ms）`)
    })
    return
  }

  if (action === 'balance') {
    await withBusy(actionButton, async () => {
      const result = await api('POST', `/api/providers/${providerId}/balance`, {})
      state = result
      render()
      toast(result.balance.ok ? `余额已更新` : result.balance.reason, !result.balance.ok)
    })
    return
  }

  if (action === 'export') {
    const includeKey = confirm('导出内容会包含完整 API Key，确认？\n\n取消则导出脱敏版本。')
    try {
      const data = await api('GET', `/api/export/config?providerId=${encodeURIComponent(providerId)}&includeKey=${includeKey ? 1 : 0}`)
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

  if (action === 'dup-offer') {
    const offerId = actionButton.closest('[data-offer]').dataset.offer
    const name = prompt('新分组名（例如：Pro 号池 / 特价池 / 企业通道）')
    if (!name || !name.trim()) return
    await withBusy(actionButton, async () => {
      state = await api('POST', `/api/offers/${offerId}/duplicate`, { group: name.trim() })
      render()
      toast(`已创建分组「${name.trim()}」，记得填它的价格`)
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

  if (action === 'toggle-provider') {
    const card = actionButton.closest('[data-provider]')
    const key = `provider:${card?.dataset.provider}`
    if (!key) return
    if (collapsedPanels.has(key)) collapsedPanels.delete(key)
    else collapsedPanels.add(key)
    render()
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

  if (action === 'usage-check') {
    const providerId = actionButton.closest('[data-provider]').dataset.provider
    await withBusy(actionButton, async () => {
      try {
        const result = await api('POST', `/api/providers/${providerId}/usage-check`, {})
        usageCheckResults[providerId] = result
        render()
        toast('已拉取站方数据')
      } catch (error) {
        toast(error.message, true)
      }
    })
    return
  }

  if (action === 'close-usage-check') {
    const providerId = actionButton.closest('[data-provider]').dataset.provider
    delete usageCheckResults[providerId]
    render()
    return
  }

  if (action === 'open-group-picker') {
    const providerId = actionButton.closest('[data-provider]').dataset.provider
    await openGroupPicker(providerId)
    return
  }

  if (action === 'apply-group') {
    await applyPickedGroup(actionButton)
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
    const credentialId = actionButton.closest('[data-credential]').dataset.credential
    const value = prompt(
      '粘贴站点后台的登录令牌（浏览器 F12 → Network → 任意 /api/v1/ 请求 → Request Headers 里的 Authorization 值，去掉 Bearer 前缀）\n\n留空表示清除。',
      '',
    )
    if (value === null) return
    try {
      state = await api('PATCH', `/api/credentials/${credentialId}`, { adminToken: value.trim() || null })
      render()
      toast(value.trim() ? '令牌已保存，点「读余额」试试' : '令牌已清除')
    } catch (error) {
      toast(error.message, true)
    }
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
  const gwForm = event.target.closest('[data-form="add-gwkey"]')
  if (gwForm) {
    event.preventDefault()
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
    }
    return
  }

  const form = event.target.closest('[data-form="add-key"]')
  if (!form) return
  event.preventDefault()
  const providerId = form.closest('[data-provider]').dataset.provider
  const data = Object.fromEntries(new FormData(form))
  try {
    state = await api('POST', '/api/credentials', { ...data, providerId })
    render()
    toast('Key 已加密保存')
  } catch (error) {
    toast(error.message, true)
  }
})

// 搜索框：只重渲染当前页，然后恢复焦点与光标
document.addEventListener('input', (event) => {
  const id = event.target.id
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
    const ms = Number(input.value) || 0
    try {
      state = await api('PATCH', '/api/settings', { maxTtftMs: ms })
      render()
      toast(ms > 0 ? `首字超过 ${ms}ms 的供给将被跳过` : '已取消首字延迟限制')
    } catch (error) {
      toast(error.message, true)
    }
    return
  }

  if (input.id === 'allow-untrusted') {
    try {
      state = await api('PATCH', '/api/settings', { allowUntrusted: input.checked })
      render()
      toast(input.checked ? '已放行可疑供给，它们会正常参与选站' : '已恢复：可疑供给只作为最后兜底')
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

  const credentialRow = input.closest('[data-credential]')
  if (credentialRow) {
    const credentialId = credentialRow.dataset.credential
    const fieldMap = { quota: 'quotaRemaining', currency: 'currency' }
    const field = fieldMap[input.dataset.act]
    if (!field) return
    try {
      state = await api('PATCH', `/api/credentials/${credentialId}`, {
        [field]: input.value === '' ? (field === 'group' ? '' : null) : input.value,
      })
      render()
      toast(field === 'group' ? '分组已更新' : '已保存')
    } catch (error) {
      toast(error.message, true)
    }
    return
  }
})

// 汇率输入框在「基准价」页里动态渲染，所以用事件委托而不是直接绑定
document.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-act="fx"]')
  if (!input) return
  try {
    state = await api('PATCH', '/api/settings', { fxUsdCny: Number(input.value) })
    render()
    toast('汇率已更新')
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
  render()
  setTab(location.hash.replace('#', '') || 'providers')
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
