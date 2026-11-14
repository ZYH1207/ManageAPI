/**
 * D 棒 · 模型接入（移植自朋友版 lib/dsh-models.js，适配本机 DSH 0.2.2-alpha.2）。
 *
 * 客户端渲染进程是沙箱（无 fs、不能写 profile）；模型列表与默认模型分别归两个 host 服务：
 *  - `configEditor`：持久化并应用 raw config（configuration()/edit(entry, change)），
 *    把模型追加进 `providers['dsh-manage-api'].models`；
 *  - `agentDefaultModel`：currentSelection()/saveSelection()，写默认模型。
 *
 * 硬规则（对应方案 D 棒要求）：
 *  - **只在用户显式操作时写入**：本模块不提供任何自动写入的构造副作用，
 *    configure() 仅在 Host 明确调用（面板/命令按钮）时执行；
 *  - 无 configEditor 时 saveSelection() 本就是 no-op；缺服务软降级、返回明确错误；
 *  - 只写插件自有 provider（dsh-manage-api），绝不碰用户其它 provider；
 *  - 幂等：同一模型重复启停不重复追加/摘除。
 *
 * 当前真事件：`llm/adapters-updated`（dsh-llm emitAdaptersUpdated() 内部 dispatch）。
 * 朋友版自造的 `llm/adapters-updated` 与本机一致；`ctx.modelDirectories` 未核实，故不调用。
 */

export const DSH_PROVIDER = 'dsh-manage-api'

/** 模型 id：允许字母数字开头，含 . _ - / :，长度 1..80。 */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:]{0,79}$/

const ROUTE_DEFAULTS = {
  api: 'openai-completions',
  apiKeyEnv: 'MANAGE_API_API_KEY',
  displayName: 'DSH ManageAPI',
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function providerOf(row, provider) {
  const inherited = asRecord(asRecord(asRecord(row && row.inherited).providers)[provider])
  const override = asRecord(asRecord(asRecord(row && row.override).providers)[provider])
  return { inherited, override, merged: { ...inherited, ...override } }
}

function modelIdsOf(value) {
  const models = Array.isArray(asRecord(value).models) ? asRecord(value).models : []
  const ids = []
  for (const item of models) {
    const id = item && typeof item === 'object' ? String(item.id || '') : ''
    if (id && ids.indexOf(id) < 0) ids.push(id)
  }
  return ids
}

/**
 * @param {{ctx:any, provider?:string, baseUrl?:()=>string, log?:(...a:any[])=>void}} options
 */
export function createDshModel(options = {}) {
  const ctx = options.ctx
  const provider = options.provider || DSH_PROVIDER
  const baseUrl = typeof options.baseUrl === 'function' ? options.baseUrl : () => 'http://127.0.0.1:4319/v1'
  const log = typeof options.log === 'function' ? options.log : () => {}

  function services() {
    return {
      configEditor: ctx && typeof ctx.get === 'function' ? ctx.get('configEditor', false) : false,
      agentDefaultModel: ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel', false) : false,
    }
  }

  function selection() {
    const { agentDefaultModel } = services()
    if (!agentDefaultModel || typeof agentDefaultModel.currentSelection !== 'function') return null
    try { return agentDefaultModel.currentSelection() || null } catch { return null }
  }

  /** 找到承载 providers 的配置行（不硬编码 id，按形状找；兼容改名/换插件）。 */
  function findRow() {
    const { configEditor } = services()
    if (!configEditor || typeof configEditor.configuration !== 'function') return null
    const rows = configEditor.configuration()
    const list = Array.isArray(rows) ? rows : []
    let best = null
    let bestCount = 0
    let shaped = null
    for (const row of list) {
      const inherited = asRecord(row && row.inherited)
      const override = asRecord(row && row.override)
      const inheritedProviders = asRecord(inherited.providers)
      const overrideProviders = asRecord(override.providers)
      if (inheritedProviders[provider] || overrideProviders[provider]) return row
      if (!shaped && ('providers' in inherited || 'providers' in override)) shaped = row
      const count = Object.keys({ ...inheritedProviders, ...overrideProviders }).length
      if (count > bestCount) { best = row; bestCount = count }
    }
    return best || shaped
  }

  /** 读现状：已登记模型 id、默认模型、写入通道是否可用。绝不写。 */
  function snapshot() {
    const { configEditor, agentDefaultModel } = services()
    const row = findRow()
    const route = row ? providerOf(row, provider).merged : {}
    const exists = Object.keys(asRecord(route)).length > 0
    const models = exists ? modelIdsOf(route) : []
    return {
      ok: Boolean(row),
      provider,
      displayName: typeof route.displayName === 'string' && route.displayName ? route.displayName : ROUTE_DEFAULTS.displayName,
      exists,
      entryId: row && row.entry && row.entry.id ? String(row.entry.id) : '',
      models,
      selection: selection(),
      configurable: Boolean(configEditor && typeof configEditor.edit === 'function'),
      selectable: Boolean(agentDefaultModel && typeof agentDefaultModel.saveSelection === 'function'),
      error: row ? '' : 'DSH 配置里找不到承载 llm providers 的配置行',
    }
  }

  /** 广播 provider 拓扑变化（真事件 llm/adapters-updated）。拿不到实例返回 false，由 UI 兜底。 */
  function notifyAdaptersUpdated() {
    const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm', false) : false
    try {
      if (llm && typeof llm.emitAdaptersUpdated === 'function') { llm.emitAdaptersUpdated(); return true }
      if (ctx && typeof ctx.emit === 'function') { ctx.emit('llm/adapters-updated'); return true }
    } catch (error) {
      log(`广播 llm/adapters-updated 失败：${String(error && error.message ? error.message : error)}`)
    }
    return false
  }

  /**
   * 开/关一个模型在 DSH 里的可用性（多选，互不影响）。**只在用户显式操作时调用**。
   * @param {string} model 模型 id（ManageAPI 的 modelKey）
   * @param {{enabled?:boolean}} [options]
   */
  async function configure(model, opts) {
    const id = String(model || '').trim()
    const enabled = !(opts && opts.enabled === false)
    if (!MODEL_ID_RE.test(id)) return { ok: false, error: `模型名不合法：${JSON.stringify(String(model).slice(0, 60))}` }
    const { configEditor, agentDefaultModel } = services()
    if (!configEditor || typeof configEditor.edit !== 'function') return { ok: false, error: 'DSH 的 configEditor 服务不可用，无法写入 provider 模型列表' }
    if (!agentDefaultModel || typeof agentDefaultModel.saveSelection !== 'function') return { ok: false, error: 'DSH 的 agentDefaultModel 服务不可用，无法设置默认模型' }
    const row = findRow()
    if (!row) return { ok: false, error: 'DSH 配置里找不到承载 llm providers 的配置行' }

    const before = modelIdsOf(providerOf(row, provider).merged)
    const sel = selection()
    const isCurrent = Boolean(sel && sel.provider === provider && sel.model === id)

    if (!enabled) {
      if (!before.includes(id)) return { ok: true, provider, model: id, enabled: false, added: false, created: false, removed: false, nudged: false, state: snapshot() }
      if (before.length === 1 && isCurrent) return { ok: false, error: '这是分组里最后一个模型，而且正是 DSH 当前默认模型。请先把 DSH 默认模型切到别的模型，再关掉它。' }
    }

    let added = false
    let created = false
    let removed = false
    let modelsAfter = []
    await configEditor.edit(row.entry, (currentConfig, inheritedConfig) => {
      const current = asRecord(currentConfig)
      const inherited = asRecord(inheritedConfig)
      const currentProviders = { ...asRecord(current.providers) }
      const inheritedProviders = asRecord(inherited.providers)
      // provider 块是「整体替换」：只写 { models } 会顶掉继承来的 api/baseURL/apiKeyEnv/displayName。
      const base = { ...asRecord(inheritedProviders[provider]), ...asRecord(currentProviders[provider]) }
      created = enabled && Object.keys(base).length === 0
      const list = Array.isArray(base.models) ? base.models.map((item) => ({ ...asRecord(item) })) : []
      if (enabled) {
        modelsAfter = list
        if (!list.some((item) => String(item.id || '') === id)) { modelsAfter.push({ id, name: id }); added = true }
      } else {
        modelsAfter = list.filter((item) => String(item.id || '') !== id)
        removed = modelsAfter.length !== list.length
      }
      if (modelsAfter.length === 0) { delete currentProviders[provider]; return { ...current, providers: currentProviders } }
      const next = { ...base, models: modelsAfter }
      if (next.api === undefined) next.api = ROUTE_DEFAULTS.api
      if (next.baseURL === undefined) next.baseURL = baseUrl()
      if (next.apiKeyEnv === undefined) next.apiKeyEnv = ROUTE_DEFAULTS.apiKeyEnv
      if (next.displayName === undefined) next.displayName = ROUTE_DEFAULTS.displayName
      currentProviders[provider] = next
      return { ...current, providers: currentProviders }
    })

    let selectionChanged = enabled
    if (enabled) await agentDefaultModel.saveSelection({ provider, model: id })
    else if (isCurrent) {
      const fallback = modelsAfter[0] && String(modelsAfter[0].id || '')
      if (fallback) { await agentDefaultModel.saveSelection({ provider, model: fallback }); selectionChanged = true }
    }

    const nudged = notifyAdaptersUpdated()
    log(enabled ? `DSH 已启用 ${provider}/${id}${created ? '（新建分组）' : added ? '（追加到分组）' : '（本来就在）'}` : `DSH 已停用 ${provider}/${id}${removed ? '' : '（本来就不在）'}`)
    return { ok: true, provider, model: id, enabled, added, created, removed, selectionChanged, nudged, state: snapshot() }
  }

  /** 诊断：宿主 llm 注册表里有哪些 provider、各自能列出哪些模型（只读）。 */
  async function catalog() {
    const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm', false) : false
    if (!llm || typeof llm.listProviders !== 'function') return { ok: false, error: 'DSH 的 llm 服务不可用' }
    const providers = llm.listProviders() || []
    const groups = []
    for (const item of providers) {
      const id = item && item.id ? String(item.id) : ''
      const entry = { id, name: (item && item.name) || id, models: [], resolved: [], error: '' }
      try {
        const models = await llm.listModels(id)
        entry.models = (models || []).map((m) => m && m.id).filter(Boolean)
      } catch (error) {
        entry.error = String(error && error.message ? error.message : error)
      }
      if (typeof llm.resolveModelInfo === 'function') {
        for (const modelId of entry.models) {
          try {
            const info = await llm.resolveModelInfo(id, modelId)
            entry.resolved.push({ id: modelId, ok: true, name: (info && info.name) || '' })
          } catch (error) {
            entry.resolved.push({ id: modelId, ok: false, error: String(error && error.message ? error.message : error) })
          }
        }
      }
      groups.push(entry)
    }
    return { ok: true, provider, total: groups.length, groups, managed: groups.filter((g) => g.id === provider) }
  }

  return { provider, snapshot, configure, selection, findRow, catalog }
}
