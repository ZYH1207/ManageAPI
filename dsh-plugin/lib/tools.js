/**
 * 模型可见的工具（host 半边）。
 *
 * 三个工具的定位都是「让模型少花几步就知道现状」，全部只读、只走 loopback HTTP，
 * 不碰 db.json（写通道只有 daemon 一个，见方案 §3.2）。
 *
 * 参数尽量少：模型调用工具时多一个必填参数就多一次失败机会。所有字段都有默认值。
 */

import { daemonGet } from './daemon.js'

const STATE_TTL_MS = 5000

const n = (value) => {
  const v = Number(value)
  return Number.isFinite(v) ? v : null
}

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

const pct = (value) => {
  const v = n(value)
  return v === null ? '-' : `${Math.round(v * 100)}%`
}

const ms = (value) => {
  const v = n(value)
  if (v === null) return '-'
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`
}

/**
 * @param {{
 *   tools: { register: (definition: any) => () => void },
 *   port: number,
 *   budget: ReturnType<typeof import('./budget.js').createBudget>,
 *   streamStats: Map<string, { tokens: number, calls: number, lastAt: number, model: string }>,
 *   log: (...args: any[]) => void,
 * }} deps
 */
export function registerTools({ tools, port, budget, streamStats, log }) {
  let cache = { at: 0, state: null, error: '' }

  async function readState() {
    if (cache.state && Date.now() - cache.at < STATE_TTL_MS) return cache.state
    const result = await daemonGet(port, '/api/state?light=1')
    if (!result.ok) {
      cache = { at: Date.now(), state: null, error: String(result.error || 'daemon 未就绪') }
      throw new Error(`ManageAPI daemon 不可用：${cache.error}（插件会尝试自动启动，面板里可看状态）`)
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
    if (totals && (totals.requests || totals.input || totals.output)) budget.absorbUsage(totals)
    const daemonInfo = state.dataDir ? 'daemon 在线' : 'daemon 在线'
    const snap = budget.snapshot()
    return {
      daemon: { reachable: true, port, portHint: daemonInfo, dataDir: state.dataDir || null },
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
        ? {
            model: headline.modelKey || '',
            provider: headline.providerName || '',
            priceCnyPerMtok: n(headline.price) ?? 0,
            spreadPct: n(headline.spreadPct) ?? 0,
            text: headline.text || '',
          }
        : {},
      today: {
        requests: n(totals.requests),
        input: n(totals.input),
        output: n(totals.output),
        cached: n(totals.cached),
        errors: n(totals.errors),
      },
      budget: snap,
    }
  }

  function renderStatus(_args, value) {
    const lines = []
    lines.push(`ManageAPI daemon 在线（127.0.0.1:${port}）`)
    const r = value.routing || {}
    lines.push(`供给 ${r.offers ?? '-'} · 可路由 ${r.priced ?? '-'} · 模型 ${r.models ?? '-'} · 可比价 ${r.comparable ?? '-'} · 平均价差 ${r.avgSpreadPct ?? '-'}%`)
    if (value.headline && value.headline.text) lines.push(`最划算：${value.headline.text}`)
    const t = value.today || {}
    lines.push(`今日：${t.requests ?? '-'} 次 / 输入 ${compact(t.input)} · 输出 ${compact(t.output)} · 缓存 ${compact(t.cached)}${t.errors ? ` · 错误 ${t.errors}` : ''}`)
    const b = value.budget || {}
    if (b.configured) {
      const s = b.session || {}
      const d = b.daily || {}
      lines.push(`预算：本会话 ${compact(s.tokens)}${b.limits?.sessionTokens ? `/${compact(b.limits.sessionTokens)}` : ''} · 今日 ${compact(d.tokens)}${b.limits?.dailyTokens ? `/${compact(b.limits.dailyTokens)}` : ''}`)
    } else {
      lines.push(`预算：未设置（可在插件配置 budget.sessionTokens / budget.dailyTokens 里开）`)
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
    if (!items.length) {
      return { matched: false, models: [], note: wanted ? `没有匹配「${args.model}」的在售模型` : '暂无可比价的模型' }
    }
    return { matched: true, models: items, totalRanked: ranked.length }
  }

  function renderModels(_args, value) {
    if (!value.matched) return [{ type: 'text', text: value.note }]
    const lines = ['模型比价（¥/百万 token，按混合价）：']
    for (const item of value.models) {
      lines.push(`${item.model} · 价差 ${item.spreadPct ?? '-'}% · ${item.providerCount ?? '-'} 个站点`)
      for (const station of item.stations) {
        const flag = station.cheapest ? '★' : ' '
        lines.push(`  ${flag} ${station.provider.padEnd(10, ' ')} ${money(station.priceCnyPerMtok).padStart(9, ' ')}  TTFT ${ms(station.ttftMs)}  缓存 ${pct(station.cacheHitRate)}`)
      }
    }
    lines.push(`共 ${value.totalRanked} 个在售模型；完整比价见设置页「ManageAPI · 比价」。`)
    return [{ type: 'text', text: lines.join('\n') }]
  }

  async function usageTool(args) {
    const state = await readState()
    const totals = (state.usage && state.usage.totals) || {}
    budget.absorbUsage(totals)
    const scope = String(args?.scope || 'both')
    const sessions = []
    for (const [sessionId, row] of streamStats) {
      sessions.push({ sessionId, tokens: n(row.tokens), calls: n(row.calls), lastAt: n(row.lastAt), model: row.model || null })
    }
    sessions.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
    const snap = budget.snapshot()
    return {
      scope,
      daily: {
        requests: n(totals.requests),
        input: n(totals.input),
        output: n(totals.output),
        cached: n(totals.cached),
        cacheCreation: n(totals.cacheCreation),
        errors: n(totals.errors),
        avgLatencyMs: n(totals.avgLatencyMs),
        avgTtftMs: n(totals.avgTtftMs),
      },
      sessionTotals: {
        sessions: sessions.length,
        tokens: sessions.reduce((sum, row) => sum + (row.tokens || 0), 0),
        calls: sessions.reduce((sum, row) => sum + (row.calls || 0), 0),
      },
      sessions: sessions.slice(0, 5),
      budget: snap,
    }
  }

  function renderUsage(_args, value) {
    const d = value.daily || {}
    const lines = [
      `今日（全渠道，daemon 记账）：${d.requests ?? '-'} 次 / 输入 ${compact(d.input)} · 输出 ${compact(d.output)} · 缓存读 ${compact(d.cached)} · 缓存写 ${compact(d.cacheCreation)}`,
      `平均延迟 ${ms(d.avgLatencyMs)} · 平均首字 ${ms(d.avgTtftMs)}${d.errors ? ` · 错误 ${d.errors}` : ''}`,
      `本进程观测：${value.sessionTotals?.calls ?? 0} 次调用 / ${compact(value.sessionTotals?.tokens)} token（${value.sessionTotals?.sessions ?? 0} 个会话）`,
    ]
    for (const row of value.sessions || []) {
      lines.push(`  · ${row.model || '未知模型'} ${compact(row.tokens)} token / ${row.calls} 次`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
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
    description:
      '查看 ManageAPI 的当前状态：daemon 是否在线、在售模型与站点数量、价差、今日用量、预算余量。用户问「现在用的什么渠道/哪个站最便宜/今天花了多少」时先调这个。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          daemon: { type: 'object' },
          routing: { type: 'object' },
          // headline 没有最优解时给空对象，而不是 null：宿主校验器不接受 type 数组
          headline: { type: 'object' },
          today: { type: 'object' },
          budget: { type: 'object' },
        },
        required: ['routing'],
      },
      render: renderStatus,
    },
    execute: async () => statusTool(),
  })

  register({
    name: 'manageapi_models',
    description:
      '按真实探测数据给模型比价：每个模型在各站的 ¥/百万 token、首字延迟、缓存命中率，标出最便宜站点。用于「换哪个模型划算」「某个模型哪家便宜」。',
    parameters: {
      type: 'object',
      properties: {
        model: { type: 'string', description: '模型名子串过滤，如 deepseek、glm；省略则返回价差最大的前几个模型' },
        limit: { type: 'number', description: '每个模型最多显示几个站点，默认 5，最大 12' },
      },
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
    description:
      '查看 token 用量：今日全渠道汇总（daemon 记账）与本进程观测到的会话用量。用户问「花了多少 token」「这个会话用了多少」时调用。',
    parameters: {
      type: 'object',
      properties: { scope: { type: 'string', enum: ['daily', 'session', 'both'], description: '默认 both' } },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { daily: { type: 'object' }, sessionTotals: { type: 'object' }, sessions: { type: 'array' }, budget: { type: 'object' } }, required: ['daily'] },
      render: renderUsage,
    },
    execute: async (args) => usageTool(args),
  })

  function dispose() {
    for (const fn of disposers.splice(0, disposers.length)) {
      try {
        fn()
      } catch {
        /* ignore */
      }
    }
  }

  return { dispose, info: () => ({ ...info, names: [...info.names], failed: [...info.failed] }) }
}
