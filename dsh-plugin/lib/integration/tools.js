/**
 * D 棒 · 模型可见工具（移植自朋友版 lib/tools.js，适配当前工程 routes/runtime）。
 *
 * 原有 3 个工具只读、只走 loopback daemon（经 daemon-client，路径固定受白名单约束）；
 * N21 新增 5 个管理工具：只读部分走同一份脱敏 state，所有写操作统一经
 * write-proxy.js 的 WRITE_RULES 白名单（未命中一律 unavailable，零请求）。
 * 不碰 db.json（写通道只有 daemon 一个）。参数尽量少，所有字段都有默认值。
 *
 * 注册用 `ctx.tools.register(definition)`；definition 兼容 CJS 风格普通对象
 * （{name,description,parameters,output:{schema,render},execute}）——本机
 * dsh-tools 的 register() 只校验 output 形状，不强求 defineTool() 包装。
 * render 返回纯文本块（模型可读、极简）。
 */

import { WRITE_RULES, WRITE_UNAVAILABLE, runWrite } from '../write-proxy.js'

const STATE_TTL_MS = 5000

const n = (value) => { const v = Number(value); return Number.isFinite(v) ? v : null }
const money = (value) => {
  const v = n(value)
  if (v === null) return '-'
  if (v >= 100) return `¥${v.toFixed(0)}`
  if (v >= 1) return `¥${v.toFixed(2)}`
  return `¥${v.toFixed(3)}`
}
const compact = (value) => {
  const v = n(value)
  if (v === null) return '-'
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(1)}万`
  return String(Math.round(v))
}
const pct = (value) => { const v = n(value); return v === null ? '-' : `${Math.round(v * 100)}%` }
const ms = (value) => { const v = n(value); return v === null ? '-' : (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`) }

/**
 * @param {{tools:{register:(def:any)=>()=>void}, client:{getState:()=>Promise<any>}, budget:any, streamStats:any, log?:(...a:any[])=>void}} deps
 */
export function registerTools({ tools, client, budget, streamStats, log = () => {} }) {
  let cache = { at: 0, state: null, error: '' }

  async function readState() {
    if (cache.state && Date.now() - cache.at < STATE_TTL_MS) return cache.state
    const result = await client.getState()
    if (!result || !result.ok) {
      cache = { at: Date.now(), state: null, error: String((result && result.error) || 'daemon 未就绪') }
      throw new Error(`ManageAPI daemon 不可用：${cache.error}（面板里可看状态）`)
    }
    cache = { at: Date.now(), state: result.body || {}, error: '' }
    return cache.state
  }

  function providerNames(state) {
    const map = new Map()
    for (const provider of state?.providers || []) {
      if (provider && provider.id) map.set(provider.id, provider.name || provider.id)
    }
    return map
  }

  async function statusTool() {
    const state = await readState()
    const summary = state.summary || {}
    const headline = state.headline || null
    const totals = (state.usage && state.usage.totals) || {}
    if (budget && totals && (totals.requests || totals.input || totals.output)) budget.absorbUsage(totals)
    return {
      daemon: { reachable: true, dataDir: state.dataDir || null },
      routing: {
        offers: n(summary.offerCount),
        priced: n(summary.pricedCount),
        models: n(summary.modelCount),
        comparable: n(summary.comparableCount),
        providers: n(summary.providerCount),
        avgSpreadPct: n(summary.avgSpreadPct),
        maxSpreadPct: n(summary.maxSpreadPct),
      },
      headline: headline
        ? { model: headline.modelKey || '', provider: headline.providerName || '', priceCnyPerMtok: n(headline.price) ?? 0, spreadPct: n(headline.spreadPct) ?? 0, text: headline.text || '' }
        : {},
      today: { requests: n(totals.requests), input: n(totals.input), output: n(totals.output), cached: n(totals.cached), errors: n(totals.errors) },
      budget: budget ? budget.snapshot() : null,
    }
  }

  function renderStatus(_args, value) {
    const lines = ['ManageAPI daemon 在线']
    const r = value.routing || {}
    lines.push(`供给 ${r.offers ?? '-'} · 可路由 ${r.priced ?? '-'} · 模型 ${r.models ?? '-'} · 可比价 ${r.comparable ?? '-'} · 平均价差 ${r.avgSpreadPct ?? '-'}%`)
    if (value.headline && value.headline.text) lines.push(`最划算：${value.headline.text}`)
    const t = value.today || {}
    lines.push(`今日：${t.requests ?? '-'} 次 / 输入 ${compact(t.input)} · 输出 ${compact(t.output)} · 缓存 ${compact(t.cached)}${t.errors ? ` · 错误 ${t.errors}` : ''}`)
    const b = value.budget || {}
    if (b.configured) {
      lines.push(`预算（工具守卫，非 token 熔断）：本会话 ${compact(b.session && b.session.tokens)} · 今日 ${compact(b.daily && b.daily.tokens)}`)
    } else {
      lines.push('预算：未设置（插件配置 budget.sessionTokens / budget.dailyTokens 可开启工具守卫）')
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  async function modelsTool(args) {
    const state = await readState()
    const names = providerNames(state)
    const limit = Math.max(1, Math.min(12, Number(args?.limit) || 5))
    const wanted = String(args?.model || '').trim().toLowerCase()
    const ranked = Array.isArray(state.ranked) ? state.ranked : []
    const picked = wanted
      ? ranked.filter((row) => String(row.modelKey || '').toLowerCase().includes(wanted)).slice(0, 3)
      : ranked.slice(0, limit)
    const items = picked.map((row) => ({
      model: row.modelKey || '-',
      providerCount: n(row.providerCount),
      spreadPct: n(row.spreadPct),
      cheapest: row.cheapest
        ? { provider: names.get(row.cheapest.providerId) || row.cheapest.providerId || '-', upstreamName: row.cheapest.upstreamName || null, priceCnyPerMtok: n(row.cheapest.blendedCnyPerMtok) }
        : null,
      stations: (Array.isArray(row.rows) ? row.rows : []).slice(0, limit).map((cell) => ({
        provider: names.get(cell.providerId) || cell.providerId || '-',
        upstreamName: cell.upstreamName || null,
        priceCnyPerMtok: n(cell.blendedCnyPerMtok),
        ttftMs: n(cell.ttftMs),
        avgLatencyMs: n(cell.avgLatencyMs),
        cacheHitRate: n(cell.cacheHitRate),
        cheapest: Boolean(cell.isCheapest),
      })),
    }))
    if (!items.length) return { matched: false, models: [], note: wanted ? `没有匹配「${args.model}」的在售模型` : '暂无可比价的模型' }
    return { matched: true, models: items, totalRanked: ranked.length }
  }

  function renderModels(_args, value) {
    if (!value.matched) return [{ type: 'text', text: value.note }]
    const lines = ['模型比价（¥/百万 token，按混合价）：']
    for (const item of value.models) {
      lines.push(`${item.model} · 价差 ${item.spreadPct ?? '-'}% · ${item.providerCount ?? '-'} 个站点`)
      for (const station of item.stations) {
        const flag = station.cheapest ? '★' : ' '
        lines.push(`  ${flag} ${String(station.provider).padEnd(10, ' ')} ${money(station.priceCnyPerMtok).padStart(9, ' ')}  TTFT ${ms(station.ttftMs)}  缓存 ${pct(station.cacheHitRate)}`)
      }
    }
    lines.push(`共 ${value.totalRanked} 个在售模型；完整比价见设置页「ManageAPI」。`)
    return [{ type: 'text', text: lines.join('\n') }]
  }

  async function usageTool(args) {
    const state = await readState()
    const totals = (state.usage && state.usage.totals) || {}
    if (budget) budget.absorbUsage(totals)
    const scope = String(args?.scope || 'both')
    const sess = streamStats ? streamStats.sessions(5) : []
    const total = streamStats ? streamStats.totals() : { sessions: 0, tokens: 0, calls: 0 }
    return {
      scope,
      daily: { requests: n(totals.requests), input: n(totals.input), output: n(totals.output), cached: n(totals.cached), cacheCreation: n(totals.cacheCreation), errors: n(totals.errors), avgLatencyMs: n(totals.avgLatencyMs), avgTtftMs: n(totals.avgTtftMs) },
      sessionTotals: { sessions: total.sessions, tokens: total.tokens, calls: total.calls },
      sessions: sess.map((row) => ({ sessionId: row.sessionId, tokens: n(row.tokens), calls: n(row.calls), lastAt: n(row.lastAt), model: row.model || null })),
      budget: budget ? budget.snapshot() : null,
    }
  }

  function renderUsage(_args, value) {
    const d = value.daily || {}
    const lines = [
      `今日（全渠道，daemon 记账）：${d.requests ?? '-'} 次 / 输入 ${compact(d.input)} · 输出 ${compact(d.output)} · 缓存读 ${compact(d.cached)} · 缓存写 ${compact(d.cacheCreation)}`,
      `平均延迟 ${ms(d.avgLatencyMs)} · 平均首字 ${ms(d.avgTtftMs)}${d.errors ? ` · 错误 ${d.errors}` : ''}`,
      `本进程观测：${value.sessionTotals?.calls ?? 0} 次调用 / ${compact(value.sessionTotals?.tokens)} token（${value.sessionTotals?.sessions ?? 0} 个会话）`,
    ]
    for (const row of value.sessions || []) lines.push(`  · ${row.model || '未知模型'} ${compact(row.tokens)} token / ${row.calls} 次`)
    return [{ type: 'text', text: lines.join('\n') }]
  }

  // ── N21 管理工具：写操作只认 WRITE_RULES，未命中零请求并标 unavailable ──
  const findRule = (action) => WRITE_RULES.find((rule) => rule.action === action) || null
  const unavailable = (action, extra = {}) => ({
    ok: false, status: 'unavailable', action,
    reason: `WRITE_RULES 未包含 action "${action}"（默认拒绝，未发请求）`,
    ...extra,
  })
  const writeBase = () => String(client && client.baseUrl ? client.baseUrl : 'http://127.0.0.1:4319').replace(/\/+$/, '')
  /** 唯一写出口：命中白名单才把 action 交给 runWrite，自身不拼任意 path。 */
  async function doWrite(action, { params = {}, payload } = {}) {
    const rule = findRule(action)
    if (!rule) return unavailable(action)
    try {
      const result = await runWrite({ baseUrl: writeBase(), action, params, payload })
      return { ...result, writeRule: { action: rule.action, name: rule.name, method: rule.method, template: rule.template } }
    } catch (err) {
      return { ok: false, status: 502, action, error: String(err && err.message ? err.message : err) }
    }
  }
  const textRender = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
  const genericSchema = { type: 'object', properties: { ok: { type: 'boolean' }, status: { type: ['string', 'number'] }, action: { type: 'string' }, reason: { type: 'string' }, error: { type: 'string' }, writeRule: { type: 'object' } }, required: ['ok'] }

  async function sitesTool(args) {
    const state = await readState()
    const wanted = String(args?.site || '').trim().toLowerCase()
    const rows = (Array.isArray(state.providers) ? state.providers : [])
      .filter((p) => p && (!wanted || String(p.id || '').toLowerCase().includes(wanted) || String(p.name || '').toLowerCase().includes(wanted)))
      .map((p) => ({
        id: p.id, name: p.name || p.id, kind: p.kind || null, baseUrl: p.baseUrl || null,
        paused: Boolean(p.paused), balanceDepleted: Boolean(p.balanceDepleted),
        quotaRemaining: n(p.quotaRemaining), unitPrice: n(p.unitPrice),
        hasAdminToken: Boolean(p.hasAdminToken), tokenStatus: p.tokenStatus || null,
      }))
    return { ok: true, count: rows.length, sites: rows, readonly: true }
  }

  async function gatewayTool(args) {
    const state = await readState()
    const g = state.gateway || {}
    const wanted = args?.action
    if (!wanted || wanted === 'status' || wanted === 'query') {
      return { ok: true, readonly: true, enabled: Boolean(g.enabled), keyCount: Array.isArray(g.keys) ? g.keys.length : 0, keys: (Array.isArray(g.keys) ? g.keys : []).map((k) => ({ id: k.id, name: k.name, enabled: Boolean(k.enabled) })) }
    }
    if (wanted === 'enable' || wanted === 'disable') {
      if (args.confirm !== true) return { ok: false, status: 'confirm-required', action: 'gateway.toggle', reason: '网关开关是写操作，需要显式 confirm:true' }
      return doWrite('gateway.toggle', { payload: { enabled: wanted === 'enable' } })
    }
    // N24：用户指示「除免费池外，其余按正常网关放开」。网关 Key 管理接入 N23 已加入
    // WRITE_RULES 的 gatewayKey.create/update/delete/rotate（白名单现为 35 条）。
    if (wanted === 'keys') {
      return { ok: true, readonly: true, keys: (Array.isArray(g.keys) ? g.keys : []).map((k) => ({ id: k.id, name: k.name, enabled: Boolean(k.enabled) })), hint: '写操作请用 action=key-create|key-update|key-delete|rotate-key，均需 confirm:true' }
    }
    if (wanted === 'key-create' || wanted === 'key-update' || wanted === 'key-delete' || wanted === 'rotate-key') {
      if (args.confirm !== true) return { ok: false, status: 'confirm-required', action: wanted, reason: `网关 Key 的 ${wanted} 是写操作，需要显式 confirm:true` }
      if (wanted === 'key-create') return doWrite('gatewayKey.create', { payload: args.payload || { name: args.name } })
      const keyId = String(args.keyId || '').trim()
      if (!/^[\w-]+$/.test(keyId)) return { ok: false, status: 400, action: wanted, error: 'keyId 必须匹配 [\\w-]+' }
      if (wanted === 'key-delete') return doWrite('gatewayKey.delete', { params: { id: keyId } })
      if (wanted === 'rotate-key') return doWrite('gatewayKey.rotate', { params: { id: keyId } })
      return doWrite('gatewayKey.update', { params: { id: keyId }, payload: args.payload || {} })
    }
    return { ok: false, status: 400, error: `未知 action：${String(wanted)}（可用：status/enable/disable/keys/key-create/key-update/key-delete/rotate-key）` }
  }

  async function probeTool(args) {
    const action = String(args?.action || 'query')
    if (action === 'query' || action === 'status') {
      const state = await readState()
      return { ok: true, readonly: true, probeTotal: n(state.probeTotal), probePatrol: state.probePatrol || null, rankedCount: Array.isArray(state.ranked) ? state.ranked.length : 0 }
    }
    if (action === 'run') {
      if (args.confirm !== true) return { ok: false, status: 'confirm-required', action: 'probes.run', reason: '触发探针会产生真实请求，需要显式 confirm:true' }
      const payload = {}
      if (args.providerId) payload.providerId = String(args.providerId)
      if (args.offerId) payload.offerId = String(args.offerId)
      if (Array.isArray(args.offerIds)) payload.offerIds = args.offerIds.map(String)
      if (args.limit !== undefined) payload.limit = Math.max(1, Math.min(20, Number(args.limit) || 5))
      if (args.lite !== undefined) payload.lite = Boolean(args.lite)
      return doWrite('probes.run', { payload })
    }
    return unavailable(String(action), { reason: `探针 action "${action}" 不在 WRITE_RULES（只有 probes.run）` })
  }

  async function pricingTool(args) {
    const state = await readState()
    const wanted = String(args?.model || '').trim().toLowerCase()
    const benchmarks = state.benchmarks && typeof state.benchmarks === 'object' ? state.benchmarks : {}
    const ranked = (Array.isArray(state.ranked) ? state.ranked : [])
      .filter((row) => !wanted || String(row.modelKey || '').toLowerCase().includes(wanted))
      .slice(0, Math.max(1, Math.min(12, Number(args?.limit) || 5)))
      .map((row) => ({
        model: row.modelKey || '-', spreadPct: n(row.spreadPct),
        cheapest: row.cheapest ? { providerId: row.cheapest.providerId || null, priceCnyPerMtok: n(row.cheapest.blendedCnyPerMtok) } : null,
        rows: (Array.isArray(row.rows) ? row.rows : []).slice(0, 5).map((cell) => ({ providerId: cell.providerId || null, priceCnyPerMtok: n(cell.blendedCnyPerMtok) })),
      }))
    const benchmark = wanted ? Object.entries(benchmarks).filter(([k]) => k.toLowerCase().includes(wanted)).slice(0, 5) : Object.entries(benchmarks).slice(0, 5)
    const sitePrice = (() => {
      if (!args?.siteId) return null
      const p = (Array.isArray(state.providers) ? state.providers : []).find((row) => row && row.id === String(args.siteId))
      return p ? { id: p.id, name: p.name || p.id, unitPrice: n(p.unitPrice), unitPriceSource: p.unitPriceSource || null } : null
    })()
    const writes = []
    // 改手填价必须显式 setManualPrice:true + siteId + unitPrice；否则一律只读。
    if (args?.setManualPrice === true) {
      if (!args.siteId || args.unitPrice === undefined) {
        writes.push({ ok: false, status: 400, action: 'provider.update', error: 'setManualPrice 需要显式 siteId 与 unitPrice' })
      } else {
        const value = Number(args.unitPrice)
        writes.push(Number.isFinite(value) && value > 0
          ? await doWrite('provider.update', { params: { id: String(args.siteId) }, payload: { unitPrice: value } })
          : { ok: false, status: 400, action: 'provider.update', error: 'unitPrice 必须是正数' })
      }
    }
    // N24：基准价写接入 WRITE_RULES 的 benchmark.upsert / benchmark.delete（N23 已加入白名单）。
    // 需显式 setBenchmark:true + benchmarkKey + benchmarkPrice；delete 用 deleteBenchmark:true。
    if (args?.deleteBenchmark === true && args?.benchmarkKey) {
      if (args.confirm !== true) writes.push({ ok: false, status: 'confirm-required', action: 'benchmark.delete', reason: '删除基准价需要显式 confirm:true' })
      else writes.push(await doWrite('benchmark.delete', { params: { key: String(args.benchmarkKey) } }))
    } else if (args?.setBenchmark === true) {
      const key = String(args.benchmarkKey || args.model || '').trim()
      const price = Number(args.benchmarkPrice)
      if (!key || !Number.isFinite(price) || price <= 0) {
        writes.push({ ok: false, status: 400, action: 'benchmark.upsert', error: 'setBenchmark 需要 benchmarkKey（或 model）与正数 benchmarkPrice' })
      } else if (args.confirm !== true) {
        writes.push({ ok: false, status: 'confirm-required', action: 'benchmark.upsert', reason: '写基准价需要显式 confirm:true' })
      } else {
        writes.push(await doWrite('benchmark.upsert', { payload: { [key]: price } }))
      }
    }
    return { ok: writes.every((w) => w.ok !== false), readonly: writes.length === 0, models: ranked, benchmarks: benchmark.map(([k, v]) => ({ model: k, ...v })), sitePrice, writes }
  }

  async function ignoreTool(args) {
    const state = await readState()
    const current = Array.isArray(state.settings?.ignoredModels) ? state.settings.ignoredModels.map(String) : []
    const model = String(args?.model || '').trim()
    const action = String(args?.action || 'query')
    if (action === 'query' || action === 'list') {
      return { ok: true, readonly: true, scope: 'global settings.ignoredModels', count: current.length, models: wantedList(current, args) }
    }
    if (action === 'panel-ignore') return unavailable('panel.ignoredModels.write', { declared: WRITE_UNAVAILABLE.panelIgnoredModels })
    if (!model) return { ok: false, status: 400, error: 'ignore/unignore 需要显式 model' }
    if (action === 'ignore' || action === 'unignore') {
      if (args.confirm !== true) return { ok: false, status: 'confirm-required', action: 'settings.patch', reason: '修改忽略名单是写操作，需要显式 confirm:true' }
      const next = action === 'ignore'
        ? (current.includes(model) ? current : [...current, model])
        : current.filter((m) => m !== model)
      return doWrite('settings.patch', { payload: { ignoredModels: next } })
    }
    return { ok: false, status: 400, error: `未知 action：${action}（可用：list/ignore/unignore/panel-ignore）` }
  }
  function wantedList(list, args) {
    const q = String(args?.filter || '').toLowerCase()
    const picked = q ? list.filter((m) => m.toLowerCase().includes(q)) : list
    return picked.slice(0, Math.max(1, Math.min(200, Number(args?.limit) || 50)))
  }

  const disposers = []
  const info = { names: [], failed: [] }
  const register = (definition) => {
    try {
      const dispose = tools.register(definition)
      if (typeof dispose === 'function') disposers.push(dispose)
      info.names.push(definition.name)
      return true
    } catch (err) {
      const message = String(err && err.message ? err.message : err)
      info.failed.push({ name: definition.name, error: message })
      log(`注册工具 ${definition.name} 失败：${message}`)
      return false
    }
  }

  register({
    name: 'manageapi_status',
    description: '查看 ManageAPI 当前状态：daemon 是否在线、在售模型与站点数量、价差、今日用量、预算余量。用户问「现在用的什么渠道/哪个站最便宜/今天花了多少」时先调这个。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: { daemon: { type: 'object' }, routing: { type: 'object' }, headline: { type: 'object' }, today: { type: 'object' }, budget: { type: 'object' } },
        required: ['routing'],
      },
      render: renderStatus,
    },
    execute: async () => statusTool(),
  })

  register({
    name: 'manageapi_models',
    description: '按真实探测数据给模型比价：每个模型在各站的 ¥/百万 token、首字延迟、缓存命中率，标出最便宜站点。用于「换哪个模型划算」「某个模型哪家便宜」。',
    parameters: {
      type: 'object',
      properties: { model: { type: 'string', description: '模型名子串过滤，如 deepseek、glm；省略则返回价差最大的前几个模型' }, limit: { type: 'number', description: '每个模型最多显示几个站点，默认 5，最大 12' } },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { matched: { type: 'boolean' }, models: { type: 'array' }, totalRanked: { type: 'number' }, note: { type: 'string' } }, required: ['matched', 'models'] },
      render: renderModels,
    },
    execute: async (args) => modelsTool(args),
  })

  register({
    name: 'manageapi_usage',
    description: '查看 token 用量：今日全渠道汇总（daemon 记账）与本进程观测到的会话用量。用户问「花了多少 token」「这个会话用了多少」时调用。',
    parameters: {
      type: 'object',
      properties: { scope: { type: 'string', description: 'daily | session | both，默认 both' } },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { daily: { type: 'object' }, sessionTotals: { type: 'object' }, sessions: { type: 'array' }, budget: { type: 'object' } }, required: ['daily'] },
      render: renderUsage,
    },
    execute: async (args) => usageTool(args),
  })

  // N21 新增 5 个管理工具（写操作统一走 doWrite → WRITE_RULES）。
  register({
    name: 'manageapi_sites',
    description: '只读列出 ManageAPI 站点：id/名称/类型/余额/是否暂停/手填单价/令牌状态。可按 site 子串过滤。',
    parameters: { type: 'object', properties: { site: { type: 'string', description: '站点 id 或名称子串；省略列全部' } }, additionalProperties: false },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, count: { type: 'number' }, sites: { type: 'array' }, readonly: { type: 'boolean' } }, required: ['ok', 'sites'] }, render: textRender },
    execute: async (args) => sitesTool(args),
  })
  register({
    name: 'manageapi_gateway',
    description: '查询 ManageAPI 网关状态（enabled/Key 数量，绝不回明文）。action=enable|disable 经 gateway.toggle；action=keys 列出 Key；action=key-create|key-update|key-delete|rotate-key 经 gatewayKey.* 写（均需 confirm:true）。',
    parameters: { type: 'object', properties: { action: { type: 'string', description: 'status | enable | disable | keys' }, confirm: { type: 'boolean', description: '写操作必须显式 true' } }, additionalProperties: false },
    output: { schema: genericSchema, render: textRender },
    execute: async (args) => gatewayTool(args),
  })
  register({
    name: 'manageapi_probe',
    description: '查询探针状态；action=run 且 confirm:true 时经 WRITE_RULES 的 probes.run 触发真实探针，可带 providerId/offerId/offerIds/limit/lite。',
    parameters: { type: 'object', properties: { action: { type: 'string', description: 'query | run' }, confirm: { type: 'boolean' }, providerId: { type: 'string' }, offerId: { type: 'string' }, offerIds: { type: 'array' }, limit: { type: 'number' }, lite: { type: 'boolean' } }, additionalProperties: false },
    output: { schema: genericSchema, render: textRender },
    execute: async (args) => probeTool(args),
  })
  register({
    name: 'manageapi_pricing',
    description: '查价比价与基准价（默认只读）。setManualPrice:true + siteId + unitPrice 经 provider.update 改站点手填价；setBenchmark:true + benchmarkKey + benchmarkPrice 经 benchmark.upsert 写基准价；deleteBenchmark:true + benchmarkKey 经 benchmark.delete 删除（写操作均需 confirm:true）。',
    parameters: { type: 'object', properties: { model: { type: 'string' }, siteId: { type: 'string' }, limit: { type: 'number' }, setManualPrice: { type: 'boolean' }, unitPrice: { type: 'number' }, setBenchmark: { type: 'boolean' } }, additionalProperties: false },
    output: { schema: genericSchema, render: textRender },
    execute: async (args) => pricingTool(args),
  })
  register({
    name: 'manageapi_ignore',
    description: '查询/修改全局忽略名单：ignore/unignore 需 confirm:true，经 WRITE_RULES 的 settings.patch 写 ignoredModels。面板独立忽略名单明确 unavailable。',
    parameters: { type: 'object', properties: { action: { type: 'string', description: 'list | ignore | unignore | panel-ignore' }, model: { type: 'string' }, filter: { type: 'string' }, limit: { type: 'number' }, confirm: { type: 'boolean' } }, additionalProperties: false },
    output: { schema: genericSchema, render: textRender },
    execute: async (args) => ignoreTool(args),
  })

  function dispose() {
    for (const fn of disposers.splice(0, disposers.length)) {
      try { fn() } catch { /* ignore */ }
    }
  }

  return { dispose, info: () => ({ ...info, names: [...info.names], failed: [...info.failed] }) }
}
