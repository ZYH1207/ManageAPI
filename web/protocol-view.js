/**
 * 协议探查 · 主界面 tab 视图。
 *
 * 为什么单独一个文件：逻辑量接近 free 页（选择树 / 批量队列 / NDJSON 进度 / 记录），
 * 全塞进 app.js 会糊掉；按 free-platform.js 的先例拆成模块，app.js 只负责在
 * 切到这个 tab 时调 ensureProtocolView()。
 *
 * 和后端 core/protocol-probe.js 的分工：
 *   - 后端负责发请求、判定能力、推断真实协议、落协议记录；
 *   - 这里负责多选树、把结果画成「表面协议 / 真实协议 / 指示灯」，以及记录列表。
 * 两边不各写一套判定，避免页面结论和接口结论打架。
 */
import { t } from './i18n.js'

const PROTOCOL_ORDER = ['chat', 'responses', 'anthropic']
const PROTOCOL_SHORT = { chat: 'Chat', responses: 'Responses', anthropic: 'Anthropic' }
const PROTOCOL_FULL = {
  chat: 'OpenAI Chat Completions',
  responses: 'OpenAI Responses',
  anthropic: 'Anthropic Messages',
}

const SURFACE_LABEL = {
  native: '原生返回',
  translated: '被翻译',
  unsupported: '不支持',
  rejected: '请求被拒',
  denied: '鉴权被拒',
  'rate-limited': '限流',
  'upstream-error': '上游错误',
  network: '网络错误',
  cancelled: '已取消',
  'error-body': '返回错误',
  unknown: '无法判定',
}

const CAP_STATUS_LABEL = { pass: '通过', fail: '缺失', unknown: '未测' }

// 模型当前状况标签：判定在服务端（admissionTags 唯一实现），这里只负责画。
// 文案与探针/比价页的 STATUS_TAG 同一套，改文案两边要一起改。
const STATUS_TAG = {
  slow: { label: '慢速', cls: 'danger' },
  degraded: { label: '结果可疑', cls: 'warn' },
  unstable: { label: '不稳定', cls: 'danger' },
  'no-evidence': { label: '没有可信样本', cls: 'warn' },
  inconclusive: { label: '证据不足', cls: '' },
  blocked: { label: '冷却中', cls: 'warn' },
  fallback: { label: '兜底', cls: '' },
  ok: { label: '可用', cls: 'ok' },
}
const BLOCKED_LABEL = {
  quota: '额度不足',
  budget: '单次预算超限',
  'rate-limit': '限流中',
  'model-missing': '模型不可用',
}

const MANUAL_KEY = 'manageapi.protocol.manual'
const BATCH_WARN_KEY = 'manageapi.protocol.batchWarn'
/** 超过这个数量就弹「可能消耗过多 Token」确认 */
const BATCH_WARN_LIMIT = 5

const BAD_TAG_KINDS = new Set(['slow', 'degraded', 'unstable', 'no-evidence', 'inconclusive', 'blocked'])

const state = {
  targets: null,
  built: false,
  targetsLoaded: false,
  mode: 'gateway',
  running: false,
  abort: null,
  selected: new Set(), // offerId 集合：真正要探查的模型，只在模型列勾
  focusSites: new Set(), // 勾了哪些站点：只控制分组列展示什么，不代表选中模型
  focusGroups: new Set(), // 勾了哪些分组（siteId::group）：只控制模型列展示什么
  queueTotal: 0,
  queueIndex: 0,
  statusWarning: false,
  records: [],
  lastResults: [],
}

let els = null

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char])
}

function secs(ms) {
  const n = Number(ms) || 0
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`
}

function surfaceBadgeClass(outcome) {
  if (outcome === 'native') return 'ok'
  if (outcome === 'translated') return 'warn'
  if (['unsupported', 'rejected', 'denied', 'error-body'].includes(outcome)) return 'danger'
  return ''
}

function surfaceDotClass(outcome) {
  if (outcome === 'native') return 'green'
  if (outcome === 'translated') return 'yellow'
  if (['unsupported', 'rejected', 'denied', 'error-body'].includes(outcome)) return 'red'
  return 'gray'
}

function realBadgeClass(real) {
  if (!real) return ''
  if (real.id === 'unsupported') return 'danger'
  if (real.id === 'unknown') return ''
  if (String(real.id).includes('compat') || String(real.label).includes('翻译')) return 'warn'
  return 'ok'
}

function capDotClass(status) {
  if (status === 'pass') return 'green'
  if (status === 'fail') return 'red'
  return 'gray'
}

function badTagsOf(model) {
  return (model?.tags || []).filter((kind) => BAD_TAG_KINDS.has(kind))
}

function hasBadStatus(model) {
  return badTagsOf(model).length > 0
}

function statusBadgesHtml(model) {
  const tags = model?.tags || []
  if (tags.length === 0) return `<span class="badge">${t('未探测')}</span>`
  return tags
    .map((kind) => {
      const spec = STATUS_TAG[kind]
      if (!spec) return `<span class="badge">${esc(kind)}</span>`
      const label =
        kind === 'blocked' && model.blocked
          ? `${t(BLOCKED_LABEL[model.blocked.kind] || '暂时不可用')} · ${t('冷却中')}`
          : t(spec.label)
      return `<span class="badge${spec.cls ? ` ${spec.cls}` : ''}">${esc(label)}</span>`
    })
    .join(' ')
}

const STATUS_WARNING_HTML = t(
  '该模型当前状况不佳（慢速 / 结果可疑 / 冷却中）。协议测试可能出现偏差——红圆可能只是它暂时不在状态，不一定是协议层真的缺。',
)

// ---------------------------------------------------------------- 骨架

function skeletonHtml() {
  return `
    <section class="card pp-intro">
      <div class="pp-intro-head">
        <div>
          <h2>${esc(t('选择要探查的模型，或直接粘 API'))}</h2>
          <p class="hint">
            ${esc(t('勾选任意站点 / 分组 / 模型做批量探查；每个模型发二十多个小请求。非 Anthropic 模型自动跳过 Anthropic 协议。结果不影响评分与路由。'))}
          </p>
        </div>
        <div class="seg" id="pp-mode-seg">
          <button type="button" data-mode="gateway" class="active">${esc(t('网关内模型'))}</button>
          <button type="button" data-mode="manual">${esc(t('手动粘贴 API'))}</button>
        </div>
      </div>

      <div id="pp-gateway-panel">
        <div class="pp-tree">
          <div class="pp-tree-col">
            <div class="pp-tree-head"><b>${esc(t('站点'))}</b><button type="button" class="ghost tiny" data-tree="site-all">${esc(t('全选'))}</button></div>
            <div class="pp-tree-list" id="pp-site-list"></div>
          </div>
          <div class="pp-tree-col">
            <div class="pp-tree-head"><b>${esc(t('分组'))}</b><button type="button" class="ghost tiny" data-tree="group-all">${esc(t('全选'))}</button></div>
            <div class="pp-tree-list" id="pp-group-list"></div>
          </div>
          <div class="pp-tree-col pp-tree-col-wide">
            <div class="pp-tree-head"><b>${esc(t('模型'))}</b><span class="pp-tree-count" id="pp-model-count"></span><button type="button" class="ghost tiny" data-tree="model-all">${esc(t('全选'))}</button></div>
            <div class="pp-tree-list" id="pp-model-list"></div>
          </div>
        </div>
      </div>

      <div id="pp-manual-panel" hidden>
        <div class="pp-form pp-form-manual">
          <label class="pp-field">
            <span>${esc(t('API 地址（填到 /v1）'))}</span>
            <input id="pp-manual-base" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false" />
          </label>
          <label class="pp-field">
            <span>${esc(t('API Key'))}</span>
            <input id="pp-manual-key" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false" />
          </label>
          <label class="pp-field">
            <span>${esc(t('模型名'))}</span>
            <input id="pp-manual-model" placeholder="gpt-4o-mini / claude-sonnet-4-5" autocomplete="off" spellcheck="false" />
          </label>
          <label class="pp-field">
            <span>${esc(t('Anthropic 鉴权'))}</span>
            <select id="pp-manual-auth">
              <option value="auto">${esc(t('自动（Bearer + x-api-key）'))}</option>
              <option value="bearer">${esc(t('只发 Bearer'))}</option>
              <option value="x-api-key">${esc(t('只发 x-api-key'))}</option>
            </select>
          </label>
        </div>
        <p class="hint">${esc(t('Key 只在本机 daemon 内存里用一次，不写盘、不记录。官方 Anthropic 用 x-api-key，多数中转站用 Bearer。'))}</p>
      </div>

      <div class="pp-actions">
        <div class="pp-target-note" id="pp-target-note"></div>
        <div class="pp-action-buttons">
          <button type="button" class="ghost" id="pp-stop-btn" hidden>${esc(t('停止'))}</button>
          <button type="button" class="primary" id="pp-run-btn" disabled>${esc(t('开始探查'))}</button>
        </div>
      </div>
    </section>

    <section id="pp-progress-root" hidden></section>
    <section id="pp-result-root"></section>
    <section id="pp-records-root"></section>

    <div id="pp-batch-modal" class="pp-modal" hidden>
      <div class="pp-modal-backdrop" data-modal-cancel></div>
      <div class="pp-modal-card" role="dialog" aria-modal="true">
        <h3>${esc(t('一次探查的模型有点多'))}</h3>
        <p>
          ${esc(t('这次要探查'))} <b id="pp-batch-modal-count">0</b> ${esc(t('个模型，每个模型会发二十多个小请求，可能消耗较多 Token。确定要继续吗？'))}
        </p>
        <div class="pp-modal-actions">
          <button type="button" class="ghost" id="pp-batch-modal-off">${esc(t('不再提示'))}</button>
          <button type="button" class="primary" id="pp-batch-modal-ok">${esc(t('确定，开始探查'))}</button>
        </div>
      </div>
    </div>`
}

/**
 * 切到协议探查 tab 时调用（幂等）：第一次建骨架 + 绑事件，之后每次刷新
 * 目标列表与记录。探查进行中不重灌，避免把进行中的界面刷掉。
 */
export function ensureProtocolView(view) {
  if (!view) return
  if (!state.built) {
    view.innerHTML = skeletonHtml()
    els = {
      siteList: view.querySelector('#pp-site-list'),
      groupList: view.querySelector('#pp-group-list'),
      modelList: view.querySelector('#pp-model-list'),
      modelCount: view.querySelector('#pp-model-count'),
      targetNote: view.querySelector('#pp-target-note'),
      run: view.querySelector('#pp-run-btn'),
      stop: view.querySelector('#pp-stop-btn'),
      progress: view.querySelector('#pp-progress-root'),
      result: view.querySelector('#pp-result-root'),
      records: view.querySelector('#pp-records-root'),
      modeSeg: view.querySelector('#pp-mode-seg'),
      modal: view.querySelector('#pp-batch-modal'),
      gatewayPanel: view.querySelector('#pp-gateway-panel'),
      manualPanel: view.querySelector('#pp-manual-panel'),
      manualBase: view.querySelector('#pp-manual-base'),
      manualKey: view.querySelector('#pp-manual-key'),
      manualModel: view.querySelector('#pp-manual-model'),
      manualAuth: view.querySelector('#pp-manual-auth'),
    }
    wireEvents()
    loadManualPrefs()
    state.built = true
  }
  if (state.running) return
  void reloadTargetsAndRecords()
}

async function reloadTargetsAndRecords() {
  await Promise.all([loadTargets(), loadRecords()])
  renderTree()
  renderRecords()
  updateTargetNote()
}

// ---------------------------------------------------------------- 工具

function loadManualPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(MANUAL_KEY) || '{}')
    if (saved.baseUrl) els.manualBase.value = saved.baseUrl
    if (saved.model) els.manualModel.value = saved.model
    if (['auto', 'bearer', 'x-api-key'].includes(saved.auth)) els.manualAuth.value = saved.auth
  } catch {
    /* 忽略损坏的本地记录 */
  }
}

function saveManualPrefs() {
  try {
    localStorage.setItem(
      MANUAL_KEY,
      JSON.stringify({
        baseUrl: els.manualBase.value.trim(),
        model: els.manualModel.value.trim(),
        auth: els.manualAuth.value,
      }),
    )
  } catch {
    /* 隐私模式 */
  }
}

function looksAnthropic(model) {
  return /claude|anthropic/i.test(String(model || ''))
}

// ---------------------------------------------------------------- 目标数据

async function loadTargets() {
  try {
    const response = await fetch('/api/protocol/targets', { headers: { Accept: 'application/json' } })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
    state.targets = data
    state.targetsLoaded = true
  } catch (error) {
    state.targets = { sites: [] }
    showNotice(`${t('读不到站点列表：')}${error.message || error}`, 'danger')
  }
}

const sitesOf = () => state.targets?.sites || []

function siteById(id) {
  return sitesOf().find((site) => site.id === id) || null
}

/** 分组列展示哪些组：被勾选（展开）的站点的全部分组；没勾站点时为空。 */
function visibleGroups() {
  if (state.focusSites.size === 0) return []
  const out = []
  for (const site of sitesOf()) {
    if (!state.focusSites.has(site.id)) continue
    out.push(...site.groups)
  }
  return out
}

function findModel(offerId) {
  for (const site of sitesOf()) {
    for (const model of site.models || []) {
      if (model.offerId === offerId) return model
    }
  }
  return null
}

const siteModels = (site) => site.models || []
const groupModels = (group) => group.models || []
const groupKeyOf = (group) => `${group.models[0]?.siteId || ''}::${group.name}`

function someChecked(models) {
  return models.some((model) => state.selected.has(model.offerId))
}

// ---------------------------------------------------------------- 多选树

function renderTree() {
  indexTargets()
  renderSiteList()
  renderGroupList()
  renderModelList()
  updateTargetNote()
}

/** 把扁平 targets 变成带反查索引的结构，多选树的每层都靠它推导勾选态 */
function indexTargets() {
  for (const site of sitesOf()) {
    site.models = []
    for (const group of site.groups) {
      for (const model of group.models) {
        model.siteId = site.id
        model.siteName = site.name
        model.groupName = group.name
        site.models.push(model)
      }
    }
  }
}

function renderSiteList() {
  const sites = sitesOf()
  if (sites.length === 0) {
    els.siteList.innerHTML = `<div class="pp-tree-empty">${esc(t('没有可探查的站点'))}</div>`
    return
  }
  els.siteList.innerHTML = sites
    .map((site) => {
      const focused = state.focusSites.has(site.id)
      const partial = someChecked(siteModels(site))
      return `
        <label class="pp-tree-row" title="${esc(site.baseUrl)}">
          <input type="checkbox" data-check="site" data-id="${esc(site.id)}"
            ${focused ? 'checked' : ''} />
          <span class="pp-tree-name">${esc(site.name)}${site.paused ? `（${esc(t('暂停'))}）` : ''}</span>
          ${partial ? '<span class="pp-tree-partial"></span>' : ''}
          <span class="pp-tree-n">${siteModels(site).length}</span>
        </label>`
    })
    .join('')
}

function renderGroupList() {
  // 钻取式：勾站点 = 展开它的分组（不代表选中模型）；没勾站点时这里为空
  const groups = visibleGroups()
  if (groups.length === 0) {
    els.groupList.innerHTML = `<div class="pp-tree-empty">${esc(t('勾选站点，这里列出它的分组'))}</div>`
    return
  }
  const multiSite = state.focusSites.size > 1
  const rows = []
  let lastSiteId = null
  for (const group of groups) {
    const siteId = group.models[0]?.siteId || ''
    const siteName = group.models[0]?.siteName || ''
    if (multiSite && siteId !== lastSiteId) {
      rows.push(`<div class="pp-tree-group"><span class="pp-tree-group-name">${esc(siteName)}</span></div>`)
      lastSiteId = siteId
    }
    const key = groupKeyOf(group)
    const focused = state.focusGroups.has(key)
    const partial = someChecked(groupModels(group))
    rows.push(`
      <label class="pp-tree-row" title="${esc(siteName)} · ${esc(group.label)}">
        <input type="checkbox" data-check="group" data-site="${esc(siteId)}" data-id="${esc(key)}"
          ${focused ? 'checked' : ''} />
        <span class="pp-tree-name">${esc(group.label)}</span>
        ${partial ? '<span class="pp-tree-partial"></span>' : ''}
        <span class="pp-tree-n">${groupModels(group).length}</span>
      </label>`)
  }
  els.groupList.innerHTML = rows.join('')
}

function renderModelList() {
  // 模型列只展示被勾选（展开）分组里的模型；勾分组不选中模型，
  // 要测哪些在这里逐个勾，或用「全选」
  const groups = visibleGroups().filter((group) => state.focusGroups.has(groupKeyOf(group)))
  const rows = []
  for (const group of groups) {
    const siteName = group.models[0]?.siteName || ''
    rows.push(
      `<div class="pp-tree-group"><span class="pp-tree-group-name" title="${esc(siteName)} · ${esc(group.label)}">${esc(siteName)} · ${esc(group.label)}</span></div>`,
    )
    for (const model of group.models) {
      const checked = state.selected.has(model.offerId)
      const bad = badTagsOf(model)
      rows.push(`
        <label class="pp-tree-row${bad.length ? ' has-warn' : ''}">
          <input type="checkbox" data-check="model" data-id="${esc(model.offerId)}" ${checked ? 'checked' : ''} />
          <span class="pp-tree-name">${esc(model.model)}</span>
          ${bad.length ? `<span class="cap-dot red" title="${esc(bad.map((kind) => t(STATUS_TAG[kind]?.label || kind)).join(' / '))}"></span>` : ''}
          ${model.ignored ? `<span class="badge">${esc(t('已忽略'))}</span>` : ''}
        </label>`)
    }
  }
  els.modelList.innerHTML =
    rows.join('') || `<div class="pp-tree-empty">${esc(t('勾选分组，这里列出模型；勾选才是真正要测的'))}</div>`
  updateModelCount()
}

function updateModelCount() {
  els.modelCount.textContent = `${t('已选')} ${state.selected.size} ${t('个')}`
}

function handleTreeClick(event) {
  const allButton = event.target.closest('[data-tree]')
  if (allButton) {
    const kind = allButton.dataset.tree
    if (kind === 'site-all') {
      // 全选站点 = 展开全部站点的分组（仍不选中模型；测全部还要在分组/模型列各点一次全选）
      const all = sitesOf().length > 0 && sitesOf().every((site) => state.focusSites.has(site.id))
      if (all) state.focusSites.clear()
      else sitesOf().forEach((site) => state.focusSites.add(site.id))
    } else if (kind === 'group-all') {
      // 全选分组 = 展开可见分组的模型
      const groups = visibleGroups()
      const all = groups.length > 0 && groups.every((group) => state.focusGroups.has(groupKeyOf(group)))
      if (all) groups.forEach((group) => state.focusGroups.delete(groupKeyOf(group)))
      else groups.forEach((group) => state.focusGroups.add(groupKeyOf(group)))
    } else if (kind === 'model-all') {
      // 模型列的全选才是真正选中：勾上可见分组的全部模型
      const models = visibleGroups()
        .filter((group) => state.focusGroups.has(groupKeyOf(group)))
        .flatMap((group) => groupModels(group))
      const all = models.length > 0 && models.every((model) => state.selected.has(model.offerId))
      for (const model of models) {
        if (all) state.selected.delete(model.offerId)
        else state.selected.add(model.offerId)
      }
    }
    renderTree()
    return
  }

  const checkbox = event.target.closest('input[data-check]')
  if (!checkbox) return
  const kind = checkbox.dataset.check
  const id = checkbox.dataset.id

  if (kind === 'site') {
    // 勾站点 = 展开它的分组，不选中任何模型；取消时把它的分组从展开里收起
    if (checkbox.checked) {
      state.focusSites.add(id)
    } else {
      state.focusSites.delete(id)
      const site = siteById(id)
      for (const group of site?.groups || []) state.focusGroups.delete(groupKeyOf(group))
    }
  } else if (kind === 'group') {
    // 勾分组 = 展开它的模型，同样不选中
    if (checkbox.checked) state.focusGroups.add(id)
    else state.focusGroups.delete(id)
  } else if (kind === 'model') {
    // 只有模型列的勾选才是真正要探查的
    if (checkbox.checked) state.selected.add(id)
    else state.selected.delete(id)
  }
  renderTree()
}

function updateTargetNote() {
  if (state.running) return

  if (state.mode === 'manual') {
    const base = els.manualBase.value.trim()
    const model = els.manualModel.value.trim()
    const auth = els.manualAuth.value
    els.run.disabled = false
    if (!base && !model) {
      els.targetNote.innerHTML = esc(t('粘贴一个 API 地址和模型名；Key 只在本机内存里用一次。'))
    } else {
      els.targetNote.innerHTML =
        `${esc(t('目标'))} <b>${esc(base || `（${t('未填地址')}）`)}</b> / <b>${esc(model || `（${t('未填模型')}）`)}</b>` +
        ` <span class="mono">· ${esc(t('鉴权'))} ${esc(auth)}</span>`
    }
    return
  }

  const models = [...state.selected].map((offerId) => findModel(offerId)).filter(Boolean)
  els.run.disabled = models.length === 0

  if (models.length === 0) {
    els.targetNote.innerHTML = esc(
      t('勾选站点展开分组，勾选分组展开模型；在模型列勾选才是真正要探查的，可跨站跨组任选。'),
    )
    return
  }

  const badCount = models.filter(hasBadStatus).length
  const noKey = models.filter((model) => !model.hasKey).length
  const requestEstimate = models.reduce(
    (sum, model) => sum + (looksAnthropic(model.model) ? 29 : 21),
    0,
  )
  els.targetNote.innerHTML =
    `${esc(t('已选'))} <b>${models.length}</b> ${esc(t('个模型，预计约'))} <b>${requestEstimate}</b> ${esc(t('个请求'))}` +
    (badCount ? ` · <span class="warn">${esc(t('{n} 个状况不佳', { n: badCount }))}</span>` : '') +
    (noKey ? ` · <span class="danger">${esc(t('{n} 个分组没有 Key，会跳过', { n: noKey }))}</span>` : '')
}

// ---------------------------------------------------------------- 事件绑定

function wireEvents() {
  els.modeSeg.addEventListener('click', (event) => {
    const button = event.target.closest('[data-mode]')
    if (button) setMode(button.dataset.mode)
  })

  els.siteList.addEventListener('change', handleTreeClick)
  els.groupList.addEventListener('change', handleTreeClick)
  els.modelList.addEventListener('change', handleTreeClick)
  els.modeSeg.closest('.pp-intro').querySelectorAll('[data-tree]').forEach((button) => {
    button.addEventListener('click', handleTreeClick)
  })

  els.manualBase.addEventListener('input', updateTargetNote)
  els.manualModel.addEventListener('input', updateTargetNote)
  els.manualAuth.addEventListener('change', updateTargetNote)

  els.run.addEventListener('click', startRun)
  els.stop.addEventListener('click', () => state.abort?.abort())

  els.modal.querySelector('#pp-batch-modal-ok').addEventListener('click', () => {
    els.modal.hidden = true
    const targets = state.pendingTargets
    state.pendingTargets = null
    if (targets) runBatch(targets)
  })
  els.modal.querySelector('#pp-batch-modal-off').addEventListener('click', () => {
    try {
      localStorage.setItem(BATCH_WARN_KEY, 'off')
    } catch {
      /* 隐私模式 */
    }
    els.modal.hidden = true
    const targets = state.pendingTargets
    state.pendingTargets = null
    if (targets) runBatch(targets)
  })
  els.modal.addEventListener('click', (event) => {
    if (event.target.closest('[data-modal-cancel]')) {
      els.modal.hidden = true
      state.pendingTargets = null
    }
  })
}

function setMode(mode) {
  state.mode = mode
  els.modeSeg.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode)
  })
  els.gatewayPanel.hidden = mode !== 'gateway'
  els.manualPanel.hidden = mode !== 'manual'
  updateTargetNote()
}

// ---------------------------------------------------------------- 运行

function buildTargets() {
  if (state.mode === 'manual') {
    const baseUrl = els.manualBase.value.trim()
    const apiKey = els.manualKey.value.trim()
    const model = els.manualModel.value.trim()
    if (!baseUrl) return { error: t('请先填 API 地址，例如 https://api.example.com/v1') }
    if (!apiKey) return { error: t('请先填 API Key') }
    if (!model) return { error: t('请先填模型名') }
    saveManualPrefs()
    state.statusWarning = false
    return {
      targets: [
        {
          mode: 'manual',
          baseUrl,
          apiKey,
          model,
          authMode: els.manualAuth.value,
          label: `${baseUrl} / ${model}`,
        },
      ],
    }
  }

  const models = [...state.selected].map((offerId) => findModel(offerId)).filter(Boolean)
  if (models.length === 0) return { error: t('请先勾选要探查的模型') }
  const runnable = models.filter((model) => model.hasKey)
  if (runnable.length === 0) {
    return { error: t('勾选的模型所在分组都没有 Key，先去「站点」页加一个') }
  }
  return {
    targets: runnable.map((model) => ({
      mode: 'gateway',
      offerId: model.offerId,
      providerName: model.siteName,
      group: model.groupName,
      model: model.model,
      label: `${model.siteName} / ${model.groupName || t('默认分组')} / ${model.model}`,
      badStatus: hasBadStatus(model),
    })),
    skipped: models.length - runnable.length,
  }
}

function setRunning(running) {
  state.running = running
  els.run.disabled = running || (state.mode === 'gateway' && state.selected.size === 0)
  els.run.classList.toggle('is-busy', running)
  els.run.textContent = running ? t('探查中') : t('开始探查')
  els.stop.hidden = !running
  if (!running) updateTargetNote()
}

function showNotice(message, kind = '') {
  els.result.innerHTML = `<div class="pp-notice ${kind}">${esc(message)}</div>`
  els.progress.hidden = true
}

async function startRun() {
  if (state.running) return
  const built = buildTargets()
  if (built.error) {
    showNotice(built.error, 'warn')
    return
  }
  const targets = built.targets

  if (targets.length > BATCH_WARN_LIMIT) {
    let warned = false
    try {
      warned = localStorage.getItem(BATCH_WARN_KEY) === 'off'
    } catch {
      /* 隐私模式 */
    }
    if (!warned) {
      els.modal.querySelector('#pp-batch-modal-count').textContent = String(targets.length)
      els.modal.hidden = false
      state.pendingTargets = targets
      return
    }
  }
  runBatch(targets)
}

async function runBatch(targets) {
  state.running = true
  state.abort = new AbortController()
  state.lastResults = []
  state.queueTotal = targets.length
  state.queueIndex = 0
  setRunning(true)
  els.result.innerHTML = ''
  els.progress.hidden = false
  renderProgressShell()

  for (const target of targets) {
    if (state.abort.signal.aborted) break
    state.queueIndex += 1
    state.statusWarning = Boolean(target.badStatus)
    updateQueueHeader(target)
    // 状况提醒跟队列走：每个目标开始时刷新一次
    const banner = els.progress.querySelector('[data-status-warning]')
    if (banner) banner.hidden = !state.statusWarning
    renderLiveGrid(target)

    try {
      const response = await fetch('/api/protocol/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify(
          target.mode === 'manual'
            ? { mode: 'manual', baseUrl: target.baseUrl, apiKey: target.apiKey, model: target.model, authMode: target.authMode }
            : { mode: 'gateway', offerId: target.offerId },
        ),
        signal: state.abort.signal,
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        appendResultError(target, data.error || `HTTP ${response.status}`)
        continue
      }
      const contentType = String(response.headers.get('content-type') || '')
      if (contentType.includes('application/json')) {
        const result = await response.json()
        handleEvent({ type: 'result', result })
      } else {
        await readNdjson(response, handleEvent)
      }
    } catch (error) {
      if (error.name === 'AbortError') break
      appendResultError(target, error.message || String(error))
    }
  }

  state.running = false
  state.abort = null
  setRunning(false)
  els.progress.hidden = true
  renderRecords()
}

async function readNdjson(response, onEvent) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const consume = () => {
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      try {
        onEvent(JSON.parse(line))
      } catch {
        /* 忽略半行/非 JSON 行 */
      }
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    consume()
  }
  buffer += decoder.decode()
  consume()
}

// ---------------------------------------------------------------- 进度

function renderProgressShell() {
  els.progress.innerHTML = `
    <div>
      <div class="pp-notice warn" data-status-warning hidden>${esc(STATUS_WARNING_HTML)}</div>
      <div class="card pp-progress">
        <div class="pp-progress-head">
          <div><b data-queue>${esc(t('正在探查'))}</b><span class="pp-progress-phase" id="pp-phase">${esc(t('连接中…'))}</span></div>
          <div class="pp-progress-count" id="pp-count">0 / 0</div>
        </div>
        <div class="pp-progress-bar"><i id="pp-bar"></i></div>
        <div class="pp-live-title" id="pp-live-title"></div>
        <div class="pp-live-grid" id="pp-live-grid"></div>
      </div>
    </div>`
  if (state.statusWarning) {
    els.progress.querySelector('[data-status-warning]').hidden = false
  }
}

function updateQueueHeader(target) {
  const queue = els.progress.querySelector('[data-queue]')
  if (!queue) return
  queue.textContent =
    state.queueTotal > 1
      ? `${t('正在探查')} ${state.queueIndex} / ${state.queueTotal}`
      : t('正在探查')
  const title = els.progress.querySelector('#pp-live-title')
  if (title) title.textContent = target.label
}

function liveProtocolCard(protocol) {
  const caps = protocol.capabilities || []
  return `
    <div class="pp-live-proto" data-protocol="${esc(protocol.id)}">
      <div class="pp-live-head">
        <b>${esc(protocol.label || PROTOCOL_FULL[protocol.id] || protocol.id)}</b>
        <span class="badge pp-live-status" data-status>${esc(t('等待中'))}</span>
      </div>
      <div class="pp-live-caps">
        ${caps
          .map(
            (cap) =>
              `<span class="cap-dot gray" data-cap="${esc(cap.id)}" title="${esc(cap.name)}"></span>`,
          )
          .join('')}
      </div>
      <div class="pp-live-detail" data-detail>—</div>
    </div>`
}

function renderLiveGrid(target) {
  const grid = els.progress.querySelector('#pp-live-grid')
  if (!grid) return
  // 非 Anthropic 模型跳过 anthropic；实时卡片与实际请求一致
  const scope = looksAnthropic(target.model)
    ? PROTOCOL_ORDER
    : PROTOCOL_ORDER.filter((id) => id !== 'anthropic')
  grid.innerHTML = scope
    .map((id) =>
      liveProtocolCard({
        id,
        label: PROTOCOL_FULL[id],
        capabilities: Array.from({ length: 8 }, (_, i) => ({ id: `cap${i}`, name: `${t('能力')} ${i + 1}` })),
      }),
    )
  state.live = { total: scope.length * 8, done: 0 }
  updateProgressCount()
  setPhase(t('检测表面协议…'))
}

function updateProgressCount() {
  const count = els.progress.querySelector('#pp-count')
  const bar = els.progress.querySelector('#pp-bar')
  if (!count || !bar || !state.live) return
  count.textContent = `${state.live.done} / ${state.live.total}`
  bar.style.width = state.live.total ? `${(state.live.done / state.live.total) * 100}%` : '0%'
}

function setPhase(text) {
  const phase = els.progress.querySelector('#pp-phase')
  if (phase) phase.textContent = text
}

function updateLiveStatus(protocolId, label, cls) {
  const block = els.progress.querySelector(`.pp-live-proto[data-protocol="${protocolId}"]`)
  const status = block?.querySelector('[data-status]')
  if (!status) return
  status.textContent = label
  status.className = `badge pp-live-status ${cls || ''}`
}

function updateLiveDetail(protocolId, text) {
  const block = els.progress.querySelector(`.pp-live-proto[data-protocol="${protocolId}"]`)
  const detail = block?.querySelector('[data-detail]')
  if (detail) detail.textContent = text
}

function handleEvent(event) {
  if (!event || !event.type) return

  if (event.type === 'start') {
    state.live.total = (event.protocols || []).reduce((sum, p) => sum + (p.capabilities || []).length, 0)
    state.live.done = 0
    updateProgressCount()
    setPhase(t('检测表面协议…'))
    return
  }

  if (event.type === 'surface-start') {
    updateLiveStatus(event.protocol, t('检测表面协议…'), '')
    return
  }

  if (event.type === 'surface') {
    const surface = event.surface || {}
    updateLiveStatus(
      event.protocol,
      t(SURFACE_LABEL[surface.outcome] || surface.outcome || 'unknown'),
      surfaceBadgeClass(surface.outcome),
    )
    if (surface.canProbe) {
      updateLiveDetail(
        event.protocol,
        `HTTP ${surface.httpStatus ?? '?'} · ${surface.shape || '未知形状'} · ${secs(surface.latencyMs)}`,
      )
      setPhase(t('逐项验证原生能力…'))
    } else {
      updateLiveDetail(event.protocol, surface.error || t('端点不可用，跳过能力测试'))
      state.live.done += 8
      updateProgressCount()
    }
    return
  }

  if (event.type === 'capability-start') {
    const block = els.progress.querySelector(`.pp-live-proto[data-protocol="${event.protocol}"]`)
    const dot = block?.querySelector(`[data-cap="${event.capability}"]`)
    if (dot) dot.className = 'cap-dot testing'
    return
  }

  if (event.type === 'capability') {
    const cap = event.capability || {}
    const block = els.progress.querySelector(`.pp-live-proto[data-protocol="${event.protocol}"]`)
    const dot = block?.querySelector(`[data-cap="${cap.id}"]`)
    if (dot) {
      dot.className = `cap-dot ${capDotClass(cap.status)}`
      dot.title = `${cap.name}：${cap.detail || t(CAP_STATUS_LABEL[cap.status] || '')}`
    }
    updateLiveDetail(
      event.protocol,
      `${cap.name}：${cap.detail || t(CAP_STATUS_LABEL[cap.status] || '')}`,
    )
    state.live.done += 1
    updateProgressCount()
    return
  }

  if (event.type === 'result') {
    appendResult(event.result)
    return
  }

  if (event.type === 'error') {
    appendResultError({ label: t('本次探查') }, event.error || t('未知错误'))
  }
}

// ---------------------------------------------------------------- 结果卡

function conclusionHtml(protocols) {
  const supported = protocols.filter((protocol) => protocol.surface?.canProbe ?? protocol.summary)
  if (supported.length === 0) {
    const reasons = protocols
      .map(
        (protocol) =>
          `${PROTOCOL_SHORT[protocol.id] || protocol.id} ${t(SURFACE_LABEL[protocol.surface?.outcome] || protocol.surface?.outcome || '未知')}`,
      )
      .join('、')
    return `<span class="warn">${esc(t('可测的表面协议都没有被接受'))}</span>（${esc(reasons)}）。${esc(t('先检查地址、Key 和分组权限。'))}`
  }

  const groups = new Map()
  for (const protocol of supported) {
    const real = protocol.real || {}
    const key = real.id || 'unknown'
    if (!groups.has(key)) groups.set(key, { label: real.label || '无法判定', protocols: [] })
    groups.get(key).protocols.push(PROTOCOL_SHORT[protocol.id] || protocol.id)
  }

  if (groups.size === 1) {
    const [entry] = [...groups.values()]
    const names = entry.protocols.join(' / ')
    if (entry.label.includes('底层翻译')) {
      return `<b>${esc(names)}</b> ${esc(t('的表面协议背后都是'))} <b>${esc(t('Chat Completions 翻译层'))}</b>${esc(t('：外形能对上，原生能力大量缺失。'))}`
    }
    if (entry.label.includes('兼容层')) {
      return `<b>${esc(names)}</b> ${esc(t('背后是'))} <b>${esc(entry.label)}</b>${esc(t('：结构像原生，但关键能力有缺失。'))}`
    }
    if (entry.label.includes('不支持')) {
      return `<b>${esc(names)}</b> ${esc(t('不可用。'))}`
    }
    return `<b>${esc(names)}</b> ${esc(t('背后是'))} <b>${esc(entry.label)}</b>${esc(t('，原生能力完整。'))}`
  }

  return supported
    .map(
      (protocol) =>
        `<b>${esc(PROTOCOL_SHORT[protocol.id] || protocol.id)}</b> → ${esc(protocol.real?.label || t('无法判定'))}`,
    )
    .join('；')
}

/**
 * 结果摘要卡（简洁版）：表面协议 + 真实协议 + 统计。
 * 点「支持的表面协议」胶囊展开对应的能力明细卡（原生基线 vs 实测）。
 */
function resultCardHtml(entry, { index, total }) {
  const target = entry.target || {}
  const protocols = PROTOCOL_ORDER.map((id) => entry.protocols?.[id]).filter(Boolean)
  const skipped = entry.skippedProtocols || []
  const summary = entry.summary || {}
  const caps = summary.capabilities || { pass: 0, fail: 0, unknown: 0, total: 0 }
  const uid = entry.recordId || entry.localId || `local-${index}`

  const chips = protocols
    .map((protocol) => {
      const surface = protocol.surface || {}
      const canExpand = protocol.capabilities?.length > 0
      return `
        <button type="button" class="pp-chip pp-chip-btn" data-expand="${esc(uid)}" data-protocol="${esc(protocol.id)}">
          <span class="cap-dot ${surfaceDotClass(surface.outcome)}"></span>
          <span><b>${esc(PROTOCOL_SHORT[protocol.id] || protocol.id)}</b> ${esc(t(SURFACE_LABEL[surface.outcome] || surface.outcome || '未知'))}</span>
          ${canExpand ? '<span class="pp-chip-caret">▾</span>' : ''}
        </button>`
    })
    .join('')

  const skippedChips = skipped
    .map(
      (id) => `
        <span class="pp-chip">
          <span class="cap-dot gray"></span>
          <span><b>${esc(PROTOCOL_SHORT[id] || id)}</b> ${esc(t('未测（非 Anthropic 模型）'))}</span>
        </span>`,
    )
    .join('')

  const detailCards = protocols.map((protocol) => protocolDetailHtml(protocol, uid)).join('')

  const queueTag =
    total > 1 && index != null
      ? `<span class="badge">${index + 1} / ${total}</span>`
      : ''

  return `
    <div data-result-block="${esc(uid)}">
      <article class="card pp-summary">
        <div class="pp-summary-top">
          <div>
            <div class="pp-eyebrow">${esc(t('探查对象'))} ${queueTag}${entry.ts ? `<span class="pp-eyebrow-time">${esc(new Date(entry.ts).toLocaleString())}</span>` : ''}</div>
            <div class="pp-target-title">${esc(target.label || `${target.baseUrl || ''} / ${target.model || ''}`)}</div>
            <div class="pp-target-sub mono">${esc(target.baseUrl || '')} · ${esc(target.model || '')}</div>
            ${entry.badStatus ? `<div class="pp-inline-warn">${esc(STATUS_WARNING_HTML)}</div>` : ''}
          </div>
          <div class="pp-summary-stats">
            <div class="pp-stat good"><div class="n">${caps.pass}</div><div class="l">${esc(t('具备'))}</div></div>
            <div class="pp-stat bad"><div class="n">${caps.fail}</div><div class="l">${esc(t('缺失'))}</div></div>
            <div class="pp-stat gray"><div class="n">${caps.unknown}</div><div class="l">${esc(t('未测'))}</div></div>
            <div class="pp-stat"><div class="n">${summary.requests ?? '—'}</div><div class="l">${esc(t('请求'))}</div></div>
            <div class="pp-stat"><div class="n">${esc(entry.durationMs != null ? secs(entry.durationMs) : '—')}</div><div class="l">${esc(t('耗时'))}</div></div>
          </div>
        </div>

        <div class="pp-surface-row">
          <span class="pp-label">${esc(t('表面协议'))}</span>
          <div class="pp-chips">${chips}${skippedChips}</div>
        </div>

        <div class="pp-real-row">
          <span class="pp-label">${esc(t('真实协议'))}</span>
          <div class="pp-conclusion">${conclusionHtml(protocols)}</div>
        </div>

        <div class="pp-legend">
          <span><span class="cap-dot green"></span>${esc(t('具备 / 原生基线'))}</span>
          <span><span class="cap-dot red"></span>${esc(t('缺失'))}</span>
          <span><span class="cap-dot gray"></span>${esc(t('未测 / 无法判定'))}</span>
          <span><span class="cap-dot yellow"></span>${esc(t('表面被翻译'))}</span>
          <span class="pp-legend-hint">${esc(t('点上方胶囊看能力明细'))}</span>
          ${entry.recordId ? `<span style="margin-left:auto"><button type="button" class="ghost" data-del-record="${esc(entry.recordId)}">${esc(t('删除记录'))}</button></span>` : ''}
        </div>
      </article>
      <div class="pp-details" data-details="${esc(uid)}" hidden>${detailCards}</div>
    </div>`
}

function protocolDetailHtml(protocol, uid) {
  const surface = protocol.surface || {}
  const real = protocol.real || {}
  const capabilities = protocol.capabilities || []
  const summary = protocol.summary || { pass: 0, fail: 0, unknown: 0, total: capabilities.length }
  const rows = capabilities
    .map((cap) => {
      const dot = capDotClass(cap.status)
      const detail = cap.detail || t(CAP_STATUS_LABEL[cap.status] || '')
      return `
        <tr>
          <td>
            <div class="cap-name">${esc(cap.name)}</div>
            <div class="pp-cap-desc">${esc(cap.desc || '')}</div>
          </td>
          <td class="dot-col"><span class="cap-dot green" title="${esc(t('原生协议本应具备'))}"></span></td>
          <td class="dot-col"><span class="cap-dot ${dot}" title="${esc(t(CAP_STATUS_LABEL[cap.status] || cap.status))}"></span></td>
          <td><div class="pp-cap-detail ${esc(cap.status)}" title="${esc(detail)}">${esc(detail)}</div></td>
        </tr>`
    })
    .join('')

  return `
    <article class="card pp-card" data-detail-card="${esc(uid)}-${esc(protocol.id)}">
      <div class="pp-card-head">
        <div>
          <h3>
            ${esc(protocol.label || PROTOCOL_FULL[protocol.id] || protocol.id)}
            <span class="pp-path mono">${esc(protocol.path || '')}</span>
          </h3>
          <div class="pp-badges">
            <span class="badge ${surfaceBadgeClass(surface.outcome)}">${esc(t('表面：'))}${esc(t(SURFACE_LABEL[surface.outcome] || surface.outcome || '未知'))}</span>
            <span class="badge ${realBadgeClass(real)}">${esc(t('真实：'))}${esc(real.label || t('无法判定'))}</span>
            ${surface.httpStatus ? `<span class="badge">HTTP ${esc(surface.httpStatus)}</span>` : ''}
            ${surface.latencyMs ? `<span class="badge">${esc(secs(surface.latencyMs))}</span>` : ''}
          </div>
        </div>
        <div class="pp-counts">
          <div>${esc(t('{n} 项原生能力', { n: summary.total }))}</div>
          <div><span class="ok">${summary.pass} ${esc(t('绿'))}</span> · <span class="bad">${summary.fail} ${esc(t('红'))}</span> · <span class="gray">${summary.unknown} ${esc(t('灰'))}</span></div>
        </div>
      </div>

      <p class="pp-real-note">
        <b>${esc(t('真实协议：'))}</b>${esc(real.label || t('无法判定'))}
        ${real.note ? `<br><span>${esc(real.note)}</span>` : ''}
      </p>

      <div class="pp-baseline">
        <b>${esc(t('原生基线'))}</b>
        <span class="pp-baseline-dots">${capabilities.map(() => '<span class="cap-dot green"></span>').join('')}</span>
        <span>${esc(t('原生协议 8 项能力全绿'))}</span>
        <span>${esc(t('实测'))} <b class="ok">${summary.pass}</b> ${esc(t('绿'))} / <b class="bad">${summary.fail}</b> ${esc(t('红'))} / <b>${summary.unknown}</b> ${esc(t('灰'))}</span>
      </div>

      <table class="pp-cap-table">
        <thead>
          <tr>
            <th>${esc(t('能力'))}</th>
            <th class="dot-col" title="${esc(t('原生协议本应具备'))}">${esc(t('原生'))}</th>
            <th class="dot-col" title="${esc(t('这个站实测'))}">${esc(t('实测'))}</th>
            <th>${esc(t('说明'))}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </article>`
}

/** 默认展开 Chat 的能力明细；没有 Chat 就挑第一个有检测结果的协议。 */
function openDefaultDetail(block) {
  const details = block.querySelector('[data-details]')
  if (!details || details.hidden === false) return
  const uid = details.dataset.details
  for (const protocolId of ['chat', 'responses', 'anthropic']) {
    const card = details.querySelector(`[data-detail-card="${uid}-${protocolId}"]`)
    if (card) {
      details.hidden = false
      details.dataset.open = protocolId
      details.querySelectorAll('[data-detail-card]').forEach((row) => {
        row.hidden = row !== card
      })
      return
    }
  }
}

function wireResultCard(block) {
  block.querySelectorAll('[data-expand]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const uid = chip.dataset.expand
      const protocolId = chip.dataset.protocol
      const details = block.querySelector(`[data-details="${uid}"]`)
      if (!details) return
      // 胶囊当页签用：点谁就立刻切到谁；再点当前已展开的那张才收起，
      // 不存在「点别的先把当前收起、还要再点一下才展开」的二段式
      const current = details.dataset.open || ''
      if (!details.hidden && current === protocolId) {
        details.hidden = true
        details.dataset.open = ''
        return
      }
      const card = details.querySelector(`[data-detail-card="${uid}-${protocolId}"]`)
      if (!card) return
      details.hidden = false
      details.dataset.open = protocolId
      details.querySelectorAll('[data-detail-card]').forEach((row) => {
        row.hidden = row !== card
      })
    })
  })
  block.querySelectorAll('[data-del-record]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        const response = await fetch(`/api/protocol/records/${button.dataset.delRecord}`, { method: 'DELETE' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        renderRecords()
      } catch (error) {
        button.textContent = t('删除失败')
        console.warn(error)
      }
    })
  })
}

function appendResult(result) {
  const entry = {
    ...result,
    localId: `local-${Date.now()}-${state.lastResults.length}`,
    badStatus: state.statusWarning || Boolean(result.target?.badStatus),
    target: {
      ...(result.target || {}),
      label:
        result.target?.label ||
        (result.target?.providerName
          ? `${result.target.providerName} / ${result.target.group || t('默认分组')} / ${result.target.model}`
          : `${result.target?.baseUrl || ''} / ${result.target?.model || ''}`),
    },
  }
  state.lastResults.push(entry)
  const total = state.queueTotal
  const index = state.queueIndex - 1
  const wrap = document.createElement('div')
  wrap.innerHTML = resultCardHtml(entry, { index, total })
  const block = wrap.firstElementChild
  els.result.prepend(block)
  wireResultCard(block)
  openDefaultDetail(block)
}

function appendResultError(target, message) {
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="pp-notice danger">${esc(target.label || t('探查失败'))}：${esc(message)}</div>`
  els.result.prepend(wrap.firstElementChild)
}

// ---------------------------------------------------------------- 协议记录

async function loadRecords() {
  try {
    const response = await fetch('/api/protocol/records', { headers: { Accept: 'application/json' } })
    const data = await response.json().catch(() => ({}))
    if (response.ok) state.records = data.records || []
  } catch {
    state.records = []
  }
}

function recordSummaryDots(record) {
  return PROTOCOL_ORDER.map((id) => {
    const protocol = record.protocols?.[id]
    if (!protocol) {
      const skipped = (record.skippedProtocols || []).includes(id)
      return `<span class="cap-dot gray" title="${esc(PROTOCOL_SHORT[id])}：${esc(t('未测'))}${skipped ? `（${esc(t('非 Anthropic 模型'))}）` : ''}"></span>`
    }
    const outcome = protocol.surface?.outcome
    return `<span class="cap-dot ${surfaceDotClass(outcome)}" title="${esc(PROTOCOL_SHORT[id])}：${esc(t(SURFACE_LABEL[outcome] || outcome || '未知'))}"></span>`
  }).join('')
}

function renderRecords() {
  if (!els) return
  const records = state.records
  if (records.length === 0) {
    els.records.innerHTML = ''
    return
  }
  const rows = records
    .map(
      (record) => `
        <div class="pp-record-row" data-record="${esc(record.id)}">
          <div class="pp-record-main">
            <span class="pp-record-dots">${recordSummaryDots(record)}</span>
            <span class="pp-record-label">${esc(record.label)}</span>
            ${(record.statusTags || []).length && record.badStatus ? `<span class="badge warn">${esc(t('测时状况不佳'))}</span>` : ''}
            <span class="pp-record-meta">${esc(new Date(record.ts).toLocaleString())}</span>
          </div>
          <div class="pp-record-side">
            <span class="pp-record-real">${esc(
              [...new Set(Object.values(record.protocols || {}).map((protocol) => protocol.real?.label).filter(Boolean))].join('；') || '—',
            )}</span>
            <button type="button" class="ghost tiny" data-view-record="${esc(record.id)}">${esc(t('查看'))}</button>
            <button type="button" class="ghost tiny danger" data-del-record="${esc(record.id)}">${esc(t('删除'))}</button>
          </div>
        </div>`,
    )
    .join('')

  els.records.innerHTML = `
    <div class="card pp-records">
      <div class="pp-records-head">
        <b>${esc(t('模型协议记录'))}</b>
        <span class="hint">${esc(t('每个模型只留最新一次'))}；${esc(t('{n} 条', { n: records.length }))}</span>
        <span style="margin-left:auto"><button type="button" class="ghost tiny danger" id="pp-clear-records">${esc(t('清空记录'))}</button></span>
      </div>
      <div class="pp-record-list">${rows}</div>
    </div>`

  els.records.querySelectorAll('.pp-record-row').forEach((row) => {
    const recordId = row.dataset.record
    // 整行可点：点中间那长串任意位置都能展开记录详情，不用去够右下角的「查看」
    row.addEventListener('click', (event) => {
      // 行内的「删除」按钮按自己的逻辑走，别把展开详情也触发了
      if (event.target.closest('button')) return
      viewRecord(recordId)
    })
  })
  els.records.querySelectorAll('[data-view-record]').forEach((button) => {
    button.addEventListener('click', () => viewRecord(button.dataset.viewRecord))
  })
  els.records.querySelectorAll('[data-del-record]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        await fetch(`/api/protocol/records/${button.dataset.delRecord}`, { method: 'DELETE' })
        await loadRecords()
        renderRecords()
      } catch (error) {
        button.textContent = t('失败')
        console.warn(error)
      }
    })
  })
  els.records.querySelector('#pp-clear-records')?.addEventListener('click', async () => {
    if (!confirm(t('清空全部协议记录？'))) return
    await fetch('/api/protocol/records', { method: 'DELETE' }).catch(() => {})
    await loadRecords()
    renderRecords()
  })
}

async function viewRecord(id) {
  try {
    const response = await fetch(`/api/protocol/records/${id}`, { headers: { Accept: 'application/json' } })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
    const record = data.record
    const entry = {
      ...record,
      recordId: record.id,
      target: {
        label: record.label,
        baseUrl: record.baseUrl,
        model: record.model,
      },
    }
    const wrap = document.createElement('div')
    wrap.innerHTML = resultCardHtml(entry, {})
    const block = wrap.firstElementChild
    block.querySelectorAll('[data-del-record]').forEach((button) => button.remove())
    els.result.prepend(block)
    wireResultCard(block)
    openDefaultDetail(block)
    block.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (error) {
    showNotice(`${t('读不到记录：')}${error.message || error}`, 'danger')
  }
}
