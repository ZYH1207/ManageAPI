/**
 * 协议探查页。
 *
 * 和后端 core/protocol-probe.js 的分工：
 *   - 后端负责发请求、判定能力、推断真实协议、落协议记录；
 *   - 这里负责多选批量、把结果画成「表面协议 / 真实协议 / 指示灯」，以及记录列表。
 * 两边不各写一套判定，避免页面结论和接口结论打架。
 */

const $ = (selector) => document.querySelector(selector)

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

const THEME_KEY = 'manageapi.theme'
const MANUAL_KEY = 'manageapi.protocol.manual'
const BATCH_WARN_KEY = 'manageapi.protocol.batchWarn'
/** 超过这个数量就弹「可能消耗过多 Token」确认 */
const BATCH_WARN_LIMIT = 5

const BAD_TAG_KINDS = new Set(['slow', 'degraded', 'unstable', 'no-evidence', 'inconclusive', 'blocked'])

const state = {
  targets: null,
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
  lastResults: [], // 本次会话产出的结果（含 recordId）
}

const els = {
  siteList: $('#site-list'),
  groupList: $('#group-list'),
  modelList: $('#model-list'),
  modelCount: $('#model-count'),
  targetNote: $('#target-note'),
  run: $('#run-btn'),
  stop: $('#stop-btn'),
  progress: $('#progress-root'),
  result: $('#result-root'),
  records: $('#records-root'),
  modeSeg: $('#mode-seg'),
  theme: $('#theme-btn'),
  modal: $('#batch-modal'),
}

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
  if (tags.length === 0) return '<span class="badge">未探测</span>'
  return tags
    .map((kind) => {
      const spec = STATUS_TAG[kind]
      if (!spec) return `<span class="badge">${esc(kind)}</span>`
      const label =
        kind === 'blocked' && model.blocked
          ? `${BLOCKED_LABEL[model.blocked.kind] || '暂时不可用'} · 冷却中`
          : spec.label
      return `<span class="badge${spec.cls ? ` ${spec.cls}` : ''}">${esc(label)}</span>`
    })
    .join(' ')
}

const STATUS_WARNING_HTML =
  '该模型当前状况不佳（慢速 / 结果可疑 / 冷却中）。协议测试可能出现偏差——红圆可能只是它暂时不在状态，不一定是协议层真的缺。'

// ---------------------------------------------------------------- 主题 / 模式

function applyThemeLabel() {
  const dark = document.documentElement.dataset.theme === 'dark'
  els.theme.textContent = dark ? '浅色模式' : '深色模式'
}

els.theme.addEventListener('click', () => {
  const root = document.documentElement
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
  if (next === 'dark') root.dataset.theme = 'dark'
  else root.removeAttribute('data-theme')
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch {
    /* 隐私模式 */
  }
  applyThemeLabel()
})

function setMode(mode) {
  state.mode = mode
  els.modeSeg.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode)
  })
  $('#gateway-panel').hidden = mode !== 'gateway'
  $('#manual-panel').hidden = mode !== 'manual'
  updateTargetNote()
}

els.modeSeg.addEventListener('click', (event) => {
  const button = event.target.closest('[data-mode]')
  if (button) setMode(button.dataset.mode)
})

function loadManualPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(MANUAL_KEY) || '{}')
    if (saved.baseUrl) $('#manual-base').value = saved.baseUrl
    if (saved.model) $('#manual-model').value = saved.model
    if (['auto', 'bearer', 'x-api-key'].includes(saved.auth)) $('#manual-auth').value = saved.auth
  } catch {
    /* 忽略损坏的本地记录 */
  }
}

function saveManualPrefs() {
  try {
    localStorage.setItem(
      MANUAL_KEY,
      JSON.stringify({
        baseUrl: $('#manual-base').value.trim(),
        model: $('#manual-model').value.trim(),
        auth: $('#manual-auth').value,
      }),
    )
  } catch {
    /* 隐私模式 */
  }
}

// ---------------------------------------------------------------- 目标数据

async function loadTargets() {
  try {
    const response = await fetch('/api/protocol/targets', { headers: { Accept: 'application/json' } })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
    state.targets = data
  } catch (error) {
    state.targets = { sites: [] }
    showNotice(`读不到站点列表：${error.message || error}`, 'danger')
  }
  renderTree()
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

function renderSiteList() {
  const sites = sitesOf()
  if (sites.length === 0) {
    els.siteList.innerHTML = '<div class="pp-tree-empty">没有可探查的站点</div>'
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
          <span class="pp-tree-name">${esc(site.name)}${site.paused ? '（暂停）' : ''}</span>
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
    els.groupList.innerHTML = '<div class="pp-tree-empty">勾选站点，这里列出它的分组</div>'
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
          ${bad.length ? `<span class="cap-dot red" title="${esc(bad.map((kind) => STATUS_TAG[kind]?.label || kind).join(' / '))}"></span>` : ''}
          ${model.ignored ? '<span class="badge">已忽略</span>' : ''}
        </label>`)
    }
  }
  els.modelList.innerHTML =
    rows.join('') || '<div class="pp-tree-empty">勾选分组，这里列出模型；勾选才是真正要测的</div>'
  updateModelCount()
}

function updateModelCount() {
  els.modelCount.textContent = `已选 ${state.selected.size} 个`
}

async function handleTreeClick(event) {
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

els.siteList.addEventListener('change', handleTreeClick)
els.groupList.addEventListener('change', handleTreeClick)
els.modelList.addEventListener('change', handleTreeClick)
document.querySelectorAll('[data-tree]').forEach((button) => {
  button.addEventListener('click', handleTreeClick)
})

function updateTargetNote() {
  if (state.running) return

  if (state.mode === 'manual') {
    const base = $('#manual-base').value.trim()
    const model = $('#manual-model').value.trim()
    const auth = $('#manual-auth').value
    els.run.disabled = false
    if (!base && !model) {
      els.targetNote.innerHTML = '粘贴一个 API 地址和模型名；Key 只在本机内存里用一次。'
    } else {
      els.targetNote.innerHTML =
        `目标 <b>${esc(base || '（未填地址）')}</b> / <b>${esc(model || '（未填模型）')}</b>` +
        ` <span class="mono">· 鉴权 ${esc(auth)}</span>`
    }
    return
  }

  const models = [...state.selected].map((offerId) => findModel(offerId)).filter(Boolean)
  els.run.disabled = models.length === 0

  if (models.length === 0) {
    els.targetNote.innerHTML =
      '勾选站点展开分组，勾选分组展开模型；在模型列勾选才是真正要探查的，可跨站跨组任选。'
    return
  }

  const badCount = models.filter(hasBadStatus).length
  const noKey = models.filter((model) => !model.hasKey).length
  const requestEstimate = models.reduce(
    (sum, model) => sum + (looksAnthropic(model.model) ? 29 : 21),
    0,
  )
  els.targetNote.innerHTML =
    `已选 <b>${models.length}</b> 个模型，预计约 <b>${requestEstimate}</b> 个请求` +
    (badCount ? ` · <span class="warn">${badCount} 个状况不佳</span>` : '') +
    (noKey ? ` · <span class="danger">${noKey} 个分组没有 Key，会跳过</span>` : '')
}

function looksAnthropic(model) {
  return /claude|anthropic/i.test(String(model || ''))
}

$('#manual-base').addEventListener('input', updateTargetNote)
$('#manual-model').addEventListener('input', updateTargetNote)
$('#manual-auth').addEventListener('change', updateTargetNote)

// ---------------------------------------------------------------- 运行

function buildTargets() {
  if (state.mode === 'manual') {
    const baseUrl = $('#manual-base').value.trim()
    const apiKey = $('#manual-key').value.trim()
    const model = $('#manual-model').value.trim()
    if (!baseUrl) return { error: '请先填 API 地址，例如 https://api.example.com/v1' }
    if (!apiKey) return { error: '请先填 API Key' }
    if (!model) return { error: '请先填模型名' }
    saveManualPrefs()
    return {
      targets: [
        {
          mode: 'manual',
          baseUrl,
          apiKey,
          model,
          authMode: $('#manual-auth').value,
          label: `${baseUrl} / ${model}`,
        },
      ],
    }
  }

  const models = [...state.selected].map((offerId) => findModel(offerId)).filter(Boolean)
  if (models.length === 0) return { error: '请先勾选要探查的模型' }
  const runnable = models.filter((model) => model.hasKey)
  if (runnable.length === 0) return { error: '勾选的模型所在分组都没有 Key，先去「站点」页加一个' }
  return {
    targets: runnable.map((model) => ({
      mode: 'gateway',
      offerId: model.offerId,
      providerName: model.siteName,
      group: model.groupName,
      model: model.model,
      label: `${model.siteName} / ${model.groupName || '默认分组'} / ${model.model}`,
      badStatus: hasBadStatus(model),
    })),
    skipped: models.length - runnable.length,
  }
}

function setRunning(running) {
  state.running = running
  els.run.disabled = running
  els.run.classList.toggle('is-busy', running)
  els.run.textContent = running ? '探查中' : '开始探查'
  els.stop.hidden = !running
  els.run.disabled = running || (state.mode === 'gateway' && state.selected.size === 0)
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

  const proceed = () => runBatch(targets)
  if (targets.length > BATCH_WARN_LIMIT) {
    let warned = false
    try {
      warned = localStorage.getItem(BATCH_WARN_KEY) === 'off'
    } catch {
      /* 隐私模式 */
    }
    if (!warned) {
      $('#batch-modal-count').textContent = String(targets.length)
      els.modal.hidden = false
      els.modal.dataset.pending = '1'
      state.pendingTargets = targets
      return
    }
  }
  proceed()
}

$('#batch-modal-ok').addEventListener('click', () => {
  els.modal.hidden = true
  const targets = state.pendingTargets
  state.pendingTargets = null
  if (targets) runBatch(targets)
})

$('#batch-modal-off').addEventListener('click', () => {
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

els.run.addEventListener('click', startRun)
els.stop.addEventListener('click', () => state.abort?.abort())

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
    // 状况提醒跟 Queue 走：每个目标开始时刷新一次
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
  if (state.abort?.signal.aborted) {
    els.progress.hidden = true
  } else {
    els.progress.hidden = true
  }
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
      <div class="pp-notice warn" data-status-warning hidden>${STATUS_WARNING_HTML}</div>
      <div class="card pp-progress">
        <div class="pp-progress-head">
          <div><b data-queue>正在探查</b><span class="pp-progress-phase" id="pp-phase">连接中…</span></div>
          <div class="pp-progress-count" id="pp-count">0 / 0 项能力</div>
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
    state.queueTotal > 1 ? `正在探查 ${state.queueIndex} / ${state.queueTotal}` : '正在探查'
  const title = $('#pp-live-title')
  if (title) title.textContent = target.label
}

function liveProtocolCard(protocol) {
  const caps = protocol.capabilities || []
  return `
    <div class="pp-live-proto" data-protocol="${esc(protocol.id)}">
      <div class="pp-live-head">
        <b>${esc(protocol.label || PROTOCOL_FULL[protocol.id] || protocol.id)}</b>
        <span class="badge pp-live-status" data-status>等待中</span>
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
  const grid = $('#pp-live-grid')
  if (!grid) return
  // 非 Anthropic 模型跳过 anthropic；实时卡片与实际请求一致
  const scope = looksAnthropic(target.model)
    ? PROTOCOL_ORDER
    : PROTOCOL_ORDER.filter((id) => id !== 'anthropic')
  state.live = {
    total: 0,
    done: 0,
    protocols: scope.map((id) => ({
      id,
      label: PROTOCOL_FULL[id],
      capabilities: Array.from({ length: 8 }, (_, i) => ({ id: `cap${i}` })),
    })),
  }
  state.live.total = scope.length * 8
  grid.innerHTML = scope
    .map((id) =>
      liveProtocolCard({
        id,
        label: PROTOCOL_FULL[id],
        capabilities: Array.from({ length: 8 }, (_, i) => ({ id: `cap${i}`, name: `能力 ${i + 1}` })),
      }),
    )
  updateProgressCount()
  setPhase('检测表面协议…')
}

function updateProgressCount() {
  const count = $('#pp-count')
  const bar = $('#pp-bar')
  if (!count || !bar || !state.live) return
  count.textContent = `${state.live.done} / ${state.live.total} 项能力`
  bar.style.width = state.live.total ? `${(state.live.done / state.live.total) * 100}%` : '0%'
}

function setPhase(text) {
  const phase = $('#pp-phase')
  if (phase) phase.textContent = text
}

function updateLiveStatus(protocolId, label, cls) {
  const block = document.querySelector(`.pp-live-proto[data-protocol="${protocolId}"]`)
  const status = block?.querySelector('[data-status]')
  if (!status) return
  status.textContent = label
  status.className = `badge pp-live-status ${cls || ''}`
}

function updateLiveDetail(protocolId, text) {
  const block = document.querySelector(`.pp-live-proto[data-protocol="${protocolId}"]`)
  const detail = block?.querySelector('[data-detail]')
  if (detail) detail.textContent = text
}

function handleEvent(event) {
  if (!event || !event.type) return

  if (event.type === 'start') {
    state.live.protocols = event.protocols || []
    state.live.total = state.live.protocols.reduce((sum, p) => sum + (p.capabilities || []).length, 0)
    state.live.done = 0
    // start 事件只包含真正会探的协议；实时卡片已在 renderLiveGrid 画过一版（含跳过项），
    // 这里按真实范围重画一次
    const grid = $('#pp-live-grid')
    if (grid && state.live.protocols.length) {
      grid.innerHTML = state.live.protocols.map(liveProtocolCard).join('')
    }
    updateProgressCount()
    setPhase('检测表面协议…')
    return
  }

  if (event.type === 'surface-start') {
    updateLiveStatus(event.protocol, '检测表面协议…', '')
    return
  }

  if (event.type === 'surface') {
    const surface = event.surface || {}
    updateLiveStatus(
      event.protocol,
      SURFACE_LABEL[surface.outcome] || surface.outcome || '未知',
      surfaceBadgeClass(surface.outcome),
    )
    if (surface.canProbe) {
      updateLiveDetail(event.protocol, `HTTP ${surface.httpStatus ?? '?'} · ${surface.shape || '未知形状'} · ${secs(surface.latencyMs)}`)
      setPhase('逐项验证原生能力…')
    } else {
      updateLiveDetail(event.protocol, surface.error || '端点不可用，跳过能力测试')
      state.live.done += 8
      updateProgressCount()
    }
    return
  }

  if (event.type === 'capability-start') {
    const block = document.querySelector(`.pp-live-proto[data-protocol="${event.protocol}"]`)
    const dot = block?.querySelector(`[data-cap="${event.capability}"]`)
    if (dot) dot.className = 'cap-dot testing'
    return
  }

  if (event.type === 'capability') {
    const cap = event.capability || {}
    const block = document.querySelector(`.pp-live-proto[data-protocol="${event.protocol}"]`)
    const dot = block?.querySelector(`[data-cap="${cap.id}"]`)
    if (dot) {
      dot.className = `cap-dot ${capDotClass(cap.status)}`
      dot.title = `${cap.name}：${cap.detail || CAP_STATUS_LABEL[cap.status] || ''}`
    }
    updateLiveDetail(event.protocol, `${cap.name}：${cap.detail || CAP_STATUS_LABEL[cap.status] || ''}`)
    state.live.done += 1
    updateProgressCount()
    return
  }

  if (event.type === 'result') {
    appendResult(event.result)
    return
  }

  if (event.type === 'error') {
    appendResultError({ label: '本次探查' }, event.error || '未知错误')
  }
}

// ---------------------------------------------------------------- 结果卡

function conclusionHtml(protocols) {
  const supported = protocols.filter((protocol) => protocol.surface?.canProbe ?? protocol.summary)
  if (supported.length === 0) {
    const reasons = protocols
      .map(
        (protocol) =>
          `${PROTOCOL_SHORT[protocol.id] || protocol.id} ${SURFACE_LABEL[protocol.surface?.outcome] || protocol.surface?.outcome || '未知'}`,
      )
      .join('、')
    return `<span class="warn">可测的表面协议都没有被接受</span>（${esc(reasons)}）。先检查地址、Key 和分组权限。`
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
      return `<b>${esc(names)}</b> 的表面协议背后都是 <b>Chat Completions 翻译层</b>：外形能对上，原生能力大量缺失。`
    }
    if (entry.label.includes('兼容层')) {
      return `<b>${esc(names)}</b> 背后是 <b>${esc(entry.label)}</b>：结构像原生，但关键能力有缺失。`
    }
    if (entry.label.includes('不支持')) {
      return `<b>${esc(names)}</b> 不可用。`
    }
    return `<b>${esc(names)}</b> 背后是 <b>${esc(entry.label)}</b>，原生能力完整。`
  }

  return supported
    .map(
      (protocol) =>
        `<b>${esc(PROTOCOL_SHORT[protocol.id] || protocol.id)}</b> → ${esc(protocol.real?.label || '无法判定')}`,
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
          <span><b>${esc(PROTOCOL_SHORT[protocol.id] || protocol.id)}</b> ${esc(SURFACE_LABEL[surface.outcome] || surface.outcome || '未知')}</span>
          ${canExpand ? '<span class="pp-chip-caret">▾</span>' : ''}
        </button>`
    })
    .join('')

  const skippedChips = skipped
    .map(
      (id) => `
        <span class="pp-chip">
          <span class="cap-dot gray"></span>
          <span><b>${esc(PROTOCOL_SHORT[id] || id)}</b> 未测（非 Anthropic 模型）</span>
        </span>`,
    )
    .join('')

  const detailCards = protocols
    .map((protocol) => protocolDetailHtml(protocol, uid))
    .join('')

  const queueTag =
    total > 1 && index != null
      ? `<span class="badge">${index + 1} / ${total}</span>`
      : ''

  return `
    <div data-result-block="${esc(uid)}">
      <article class="card pp-summary">
        <div class="pp-summary-top">
          <div>
            <div class="pp-eyebrow">探查对象 ${queueTag}${entry.ts ? `<span class="pp-eyebrow-time">${esc(new Date(entry.ts).toLocaleString())}</span>` : ''}</div>
            <div class="pp-target-title">${esc(target.label || `${target.baseUrl || ''} / ${target.model || ''}`)}</div>
            <div class="pp-target-sub mono">${esc(target.baseUrl || '')} · ${esc(target.model || '')}</div>
            ${entry.badStatus ? `<div class="pp-inline-warn">${STATUS_WARNING_HTML}</div>` : ''}
          </div>
          <div class="pp-summary-stats">
            <div class="pp-stat good"><div class="n">${caps.pass}</div><div class="l">具备</div></div>
            <div class="pp-stat bad"><div class="n">${caps.fail}</div><div class="l">缺失</div></div>
            <div class="pp-stat gray"><div class="n">${caps.unknown}</div><div class="l">未测</div></div>
            <div class="pp-stat"><div class="n">${summary.requests ?? '—'}</div><div class="l">请求</div></div>
            <div class="pp-stat"><div class="n">${esc(entry.durationMs != null ? secs(entry.durationMs) : '—')}</div><div class="l">耗时</div></div>
          </div>
        </div>

        <div class="pp-surface-row">
          <span class="pp-label">表面协议</span>
          <div class="pp-chips">${chips}${skippedChips}</div>
        </div>

        <div class="pp-real-row">
          <span class="pp-label">真实协议</span>
          <div class="pp-conclusion">${conclusionHtml(protocols)}</div>
        </div>

        <div class="pp-legend">
          <span><span class="cap-dot green"></span>具备 / 原生基线</span>
          <span><span class="cap-dot red"></span>缺失</span>
          <span><span class="cap-dot gray"></span>未测 / 无法判定</span>
          <span><span class="cap-dot yellow"></span>表面被翻译</span>
          <span class="pp-legend-hint">点上方胶囊看能力明细</span>
          ${entry.recordId ? `<span style="margin-left:auto"><button type="button" class="ghost" data-del-record="${esc(entry.recordId)}">删除记录</button></span>` : ''}
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
      const detail = cap.detail || CAP_STATUS_LABEL[cap.status] || ''
      return `
        <tr>
          <td>
            <div class="cap-name">${esc(cap.name)}</div>
            <div class="pp-cap-desc">${esc(cap.desc || '')}</div>
          </td>
          <td class="dot-col"><span class="cap-dot green" title="原生协议本应具备"></span></td>
          <td class="dot-col"><span class="cap-dot ${dot}" title="${esc(CAP_STATUS_LABEL[cap.status] || cap.status)}"></span></td>
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
            <span class="badge ${surfaceBadgeClass(surface.outcome)}">表面：${esc(SURFACE_LABEL[surface.outcome] || surface.outcome || '未知')}</span>
            <span class="badge ${realBadgeClass(real)}">真实：${esc(real.label || '无法判定')}</span>
            ${surface.httpStatus ? `<span class="badge">HTTP ${esc(surface.httpStatus)}</span>` : ''}
            ${surface.latencyMs ? `<span class="badge">${esc(secs(surface.latencyMs))}</span>` : ''}
          </div>
        </div>
        <div class="pp-counts">
          <div>${summary.total} 项原生能力</div>
          <div><span class="ok">${summary.pass} 绿</span> · <span class="bad">${summary.fail} 红</span> · <span class="gray">${summary.unknown} 灰</span></div>
        </div>
      </div>

      <p class="pp-real-note">
        <b>真实协议：</b>${esc(real.label || '无法判定')}
        ${real.note ? `<br><span>${esc(real.note)}</span>` : ''}
      </p>

      <div class="pp-baseline">
        <b>原生基线</b>
        <span class="pp-baseline-dots">${capabilities.map(() => '<span class="cap-dot green"></span>').join('')}</span>
        <span>原生协议 8 项能力全绿</span>
        <span>实测 <b class="ok">${summary.pass}</b> 绿 / <b class="bad">${summary.fail}</b> 红 / <b>${summary.unknown}</b> 灰</span>
      </div>

      <table class="pp-cap-table">
        <thead>
          <tr>
            <th>能力</th>
            <th class="dot-col" title="原生协议本应具备">原生</th>
            <th class="dot-col" title="这个站实测">实测</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </article>`
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
        button.textContent = '删除失败'
        console.warn(error)
      }
    })
  })
}

/** 默认展开 Chat 的能力明细；没有 Chat 就挑第一个有检测结果的协议。 */
function openDefaultDetail(block) {
  const details = block.querySelector('[data-details]')
  if (!details || details.hidden === false) return
  const uid = details.dataset.details
  const order = ['chat', 'responses', 'anthropic']
  for (const protocolId of order) {
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
          ? `${result.target.providerName} / ${result.target.group || '默认分组'} / ${result.target.model}`
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
  wrap.innerHTML = `<div class="pp-notice danger">${esc(target.label || '探查失败')}：${esc(message)}</div>`
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
      return `<span class="cap-dot gray" title="${esc(PROTOCOL_SHORT[id])}：未测${skipped ? '（非 Anthropic 模型）' : ''}"></span>`
    }
    const outcome = protocol.surface?.outcome
    return `<span class="cap-dot ${surfaceDotClass(outcome)}" title="${esc(PROTOCOL_SHORT[id])}：${esc(SURFACE_LABEL[outcome] || outcome || '未知')}"></span>`
  }).join('')
}

function renderRecords() {
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
            ${(record.statusTags || []).length && record.badStatus ? '<span class="badge warn">测时状况不佳</span>' : ''}
            <span class="pp-record-meta">${esc(new Date(record.ts).toLocaleString())}</span>
          </div>
          <div class="pp-record-side">
            <span class="pp-record-real">${esc(
              [...new Set(Object.values(record.protocols || {}).map((protocol) => protocol.real?.label).filter(Boolean))].join('；') || '—',
            )}</span>
            <button type="button" class="ghost tiny" data-view-record="${esc(record.id)}">查看</button>
            <button type="button" class="ghost tiny danger" data-del-record="${esc(record.id)}">删除</button>
          </div>
        </div>`,
    )
    .join('')

  els.records.innerHTML = `
    <div class="card pp-records">
      <div class="pp-records-head">
        <b>模型协议记录</b>
        <span class="hint">每个模型只留最新一次；${records.length} 条</span>
        <span style="margin-left:auto"><button type="button" class="ghost tiny danger" id="clear-records">清空记录</button></span>
      </div>
      <div class="pp-record-list">${rows}</div>
    </div>`

  els.records.querySelectorAll('[data-view-record]').forEach((button) => {
    button.addEventListener('click', () => viewRecord(button.dataset.viewRecord))
  })
  els.records.querySelectorAll('[data-del-record]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        await fetch(`/api/protocol/records/${button.dataset.delRecord}`, { method: 'DELETE' })
        await refreshRecords()
      } catch (error) {
        button.textContent = '失败'
        console.warn(error)
      }
    })
  })
  $('#clear-records')?.addEventListener('click', async () => {
    if (!confirm('清空全部协议记录？')) return
    await fetch('/api/protocol/records', { method: 'DELETE' }).catch(() => {})
    await refreshRecords()
  })
}

async function refreshRecords() {
  await loadRecords()
  renderRecords()
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
    showNotice(`读不到记录：${error.message || error}`, 'danger')
  }
}

// ---------------------------------------------------------------- 启动

applyThemeLabel()
loadManualPrefs()
setMode('gateway')
loadTargets()
refreshRecords()
