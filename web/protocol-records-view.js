/**
 * 协议记录 · 独立 tab 视图。
 *
 * 和协议探查页（protocol-view.js）的分工：
 *   - 探查页只管「测」；这页对应的是完整历史大库：每次探查都追加一条，永不自动去重。
 *   - 渲染函数（结果卡/胶囊切换/灯）全部复用 protocol-view.js 导出的同一份，
 *     两边不各画一套，避免记录页和探查页结论长得不一样。
 *
 * 清理：默认永不自动清；开关打开后按天数惰性清理（GET 记录时服务端顺带删旧的）。
 */
import { t } from './i18n.js'
import {
  esc,
  PROTOCOL_ORDER,
  SURFACE_LABEL,
  surfaceBadgeClass,
  surfaceDotClass,
  realBadgeClass,
  resultCardHtml,
  wireResultCard,
  openDefaultDetail,
  recordSummaryDots,
} from './protocol-view.js'

const state = {
  built: false,
  records: [],
  retentionDays: 0,
  filters: { site: '', group: '', model: '' },
  expandedId: null,
}

let els = null

function escLocal(value) {
  return esc(value)
}

function skeletonHtml() {
  return `
    <section class="card pp-records-page">
      <div class="pp-records-head">
        <b>${escLocal(t('模型协议记录'))}</b>
        <span class="hint" id="pp-rec-count"></span>
        <span style="margin-left:auto" class="pp-retention">
          <label class="pp-retention-switch">
            <input type="checkbox" id="pp-retention-on" />
            <span>${escLocal(t('自动清理'))}</span>
          </label>
          <span id="pp-retention-days-wrap" hidden>
            ${escLocal(t('删掉超过'))}
            <input type="number" id="pp-retention-days" min="1" max="365" style="width:64px" />
            ${escLocal(t('天前的记录'))}
          </span>
          <button type="button" class="ghost tiny" id="pp-retention-save" hidden>${escLocal(t('保存'))}</button>
        </span>
        <button type="button" class="ghost tiny danger" id="pp-clear-records">${escLocal(t('清空记录'))}</button>
      </div>

      <div class="pp-rec-filters">
        <label class="pp-field">
          <span>${escLocal(t('站点'))}</span>
          <select id="pp-filter-site"></select>
        </label>
        <label class="pp-field">
          <span>${escLocal(t('分组'))}</span>
          <select id="pp-filter-group"></select>
        </label>
        <label class="pp-field">
          <span>${escLocal(t('模型'))}</span>
          <select id="pp-filter-model"></select>
        </label>
      </div>

      <div class="pp-record-list" id="pp-record-list"></div>
    </section>`
}

/** 切到协议记录 tab 时调用（幂等）。每次都重置筛选——这个 tab 永远对应完整大库。 */
export function ensureProtocolRecordsView(view) {
  if (!view) return
  if (!state.built) {
    view.innerHTML = skeletonHtml()
    els = {
      count: view.querySelector('#pp-rec-count'),
      list: view.querySelector('#pp-record-list'),
      filterSite: view.querySelector('#pp-filter-site'),
      filterGroup: view.querySelector('#pp-filter-group'),
      filterModel: view.querySelector('#pp-filter-model'),
      retentionOn: view.querySelector('#pp-retention-on'),
      retentionDaysWrap: view.querySelector('#pp-retention-days-wrap'),
      retentionDays: view.querySelector('#pp-retention-days'),
      retentionSave: view.querySelector('#pp-retention-save'),
      clear: view.querySelector('#pp-clear-records'),
    }
    wireEvents()
    state.built = true
  }
  state.filters = { site: '', group: '', model: '' }
  state.expandedId = null
  void reload()
}

async function reload() {
  try {
    const response = await fetch('/api/protocol/records', { headers: { Accept: 'application/json' } })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
    state.records = data.records || []
    state.retentionDays = Number(data.retentionDays) || 0
  } catch (error) {
    state.records = []
    els.count.textContent = `${t('读不到记录：')}${error.message || error}`
    return
  }
  renderFilters()
  renderList()
  renderRetention()
}

function wireEvents() {
  for (const select of [els.filterSite, els.filterGroup, els.filterModel]) {
    select.addEventListener('change', () => {
      state.filters.site = els.filterSite.value
      state.filters.group = els.filterGroup.value
      state.filters.model = els.filterModel.value
      renderFilters()
      renderList()
    })
  }

  els.retentionOn.addEventListener('change', () => {
    const on = els.retentionOn.checked
    els.retentionDaysWrap.hidden = !on
    els.retentionSave.hidden = !on
    if (on && Number(els.retentionDays.value) > 0) void saveRetention()
  })
  els.retentionSave.addEventListener('click', () => void saveRetention())
  els.retentionDays.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void saveRetention()
  })

  els.clear.addEventListener('click', async () => {
    if (!confirm(t('清空全部协议记录？'))) return
    await fetch('/api/protocol/records', { method: 'DELETE' }).catch(() => {})
    await reload()
  })

  // 行点击展开详情：动态列表，绑在容器上做委托
  els.list.addEventListener('click', (event) => {
    if (event.target.closest('button')) return
    const row = event.target.closest('.pp-record-row')
    if (!row) return
    toggleRecordDetail(row.dataset.record, row)
  })
}

async function saveRetention() {
  const on = els.retentionOn.checked
  const days = on ? Math.max(1, Math.round(Number(els.retentionDays.value) || 0)) : 0
  try {
    const response = await fetch('/api/protocol/records/retention', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
    state.retentionDays = Number(data.retentionDays) || 0
    els.retentionDays.value = state.retentionDays || els.retentionDays.value
    await reload()
  } catch (error) {
    alert(`${t('保存失败：')}${error.message || error}`)
  }
}

function renderRetention() {
  els.retentionOn.checked = state.retentionDays > 0
  els.retentionDaysWrap.hidden = state.retentionDays <= 0
  els.retentionSave.hidden = state.retentionDays <= 0
  if (state.retentionDays > 0 && !els.retentionDays.value) {
    els.retentionDays.value = String(state.retentionDays)
  }
}

/** 筛选键：手动探查没有 providerName，归到「手动」一项。 */
function siteOf(record) {
  return record.providerName || (record.mode === 'manual' ? t('手动') : record.baseUrl || '—')
}

function filteredRecords() {
  const { site, group, model } = state.filters
  return state.records.filter((record) => {
    if (site && siteOf(record) !== site) return false
    if (group && (record.group || t('默认分组')) !== group) return false
    if (model && record.model !== model) return false
    return true
  })
}

function renderFilters() {
  const sites = [...new Set(state.records.map(siteOf))].sort((a, b) => a.localeCompare(b, 'zh'))
  const groups = [
    ...new Set(
      state.records
        .filter((record) => !state.filters.site || siteOf(record) === state.filters.site)
        .map((record) => record.group || t('默认分组')),
    ),
  ].sort((a, b) => a.localeCompare(b, 'zh'))
  const models = [
    ...new Set(
      state.records
        .filter((record) => !state.filters.site || siteOf(record) === state.filters.site)
        .filter((record) => !state.filters.group || (record.group || t('默认分组')) === state.filters.group)
        .map((record) => record.model),
    ),
  ].sort((a, b) => a.localeCompare(b, 'zh'))

  const options = (values, current) =>
    [`<option value="">${esc(t('全部'))}</option>`]
      .concat(values.map((value) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(value)}</option>`))
      .join('')

  els.filterSite.innerHTML = options(sites, state.filters.site)
  els.filterGroup.innerHTML = options(groups, state.filters.group)
  els.filterModel.innerHTML = options(models, state.filters.model)
  // 级联收缩时当前选中值可能不在候选里，归位到「全部」
  if (state.filters.group && !groups.includes(state.filters.group)) state.filters.group = ''
  if (state.filters.model && !models.includes(state.filters.model)) state.filters.model = ''
}

function renderList() {
  const records = filteredRecords()
  els.count.textContent =
    t('{n} 条', { n: records.length }) +
    (records.length !== state.records.length ? ` / ${t('{n} 条', { n: state.records.length })}` : '')

  if (records.length === 0) {
    els.list.innerHTML = `<div class="pp-tree-empty">${esc(
      state.records.length === 0 ? t('还没有协议记录——去「协议探查」测一次就有了') : t('没有匹配筛选的记录'),
    )}</div>`
    return
  }

  els.list.innerHTML = records
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
            <button type="button" class="ghost tiny danger" data-del-record="${esc(record.id)}">${esc(t('删除'))}</button>
          </div>
        </div>`,
    )
    .join('')

  els.list.querySelectorAll('[data-del-record]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation()
      button.disabled = true
      try {
        await fetch(`/api/protocol/records/${button.dataset.delRecord}`, { method: 'DELETE' })
        await reload()
      } catch (error) {
        button.textContent = t('失败')
        console.warn(error)
      }
    })
  })

  // 展开中的记录被筛掉/重绘后，展开态跟着消失，避免详情悬空
  state.expandedId = null
}

/** 点一行：在行下方就地展开完整结果卡（与探查页同一渲染），再点收起。 */
async function toggleRecordDetail(id, row) {
  const existing = els.list.querySelector(`[data-record-detail="${id}"]`)
  if (state.expandedId === id && existing) {
    existing.remove()
    state.expandedId = null
    return
  }
  // 换行展开前收起旧的，列表里永远最多一张展开卡
  els.list.querySelector('[data-record-detail]')?.remove()
  state.expandedId = null

  const holder = document.createElement('div')
  holder.className = 'pp-record-detail'
  holder.dataset.recordDetail = id
  holder.innerHTML = `<div class="pp-record-detail-loading">${esc(t('加载中…'))}</div>`
  row.after(holder)
  state.expandedId = id

  try {
    const response = await fetch(`/api/protocol/records/${id}`, { headers: { Accept: 'application/json' } })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
    const record = data.record
    if (state.expandedId !== id) return // 展开期间又被点了别的行
    const entry = {
      ...record,
      recordId: record.id,
      target: { label: record.label, baseUrl: record.baseUrl, model: record.model },
    }
    const wrap = document.createElement('div')
    wrap.innerHTML = resultCardHtml(entry, {})
    const block = wrap.firstElementChild
    block.querySelectorAll('[data-del-record]').forEach((button) => button.remove())
    holder.innerHTML = ''
    holder.appendChild(block)
    wireResultCard(block)
    openDefaultDetail(block)
  } catch (error) {
    if (state.expandedId === id) {
      holder.innerHTML = `<div class="pp-notice danger">${esc(t('读不到记录：'))}${esc(error.message || error)}</div>`
    }
  }
}
