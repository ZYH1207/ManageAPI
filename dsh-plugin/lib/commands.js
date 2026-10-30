/**
 * 人类命令（host 半边）：`/manage status|models|usage|budget`。
 *
 * 与工具的分工：
 *   - 工具是给**模型**用的，走 `tools.register`，模型决定何时调；
 *   - 命令是给**人**用的，走 `commands.register`，不发回模型、不产生 token。
 *
 * 为什么不复用 tools.js 的 render：工具的 render 是给模型看的纯文本块（要极简），
 * 命令的返回值会直接显示在会话里，可以稍微详细一点，但同样必须是纯文本
 * —— 命令结果不进入消息历史，不能依赖 markdown 之外的渲染能力。
 */

import { daemonGet } from './daemon.js'

const n = (value) => {
  const v = Number(value)
  return Number.isFinite(v) ? v : null
}

const compact = (value) => {
  const v = n(value)
  if (v === null) return '-'
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(1)}万`
  return String(Math.round(v))
}

const money = (value) => {
  const v = n(value)
  if (v === null) return '-'
  if (v >= 1) return `¥${v.toFixed(2)}`
  return `¥${v.toFixed(3)}`
}

const pct = (value) => {
  const v = n(value)
  return v === null ? '-' : `${Math.round(v * 100)}%`
}

async function loadState(port) {
  const result = await daemonGet(port, '/api/state?light=1')
  if (!result.ok) return { ok: false, error: String(result.error || 'daemon 未就绪') }
  return { ok: true, state: result.body || {} }
}

function providerNames(state) {
  const map = new Map()
  for (const provider of state?.providers || []) {
    if (provider && provider.id) map.set(provider.id, provider.name || provider.id)
  }
  return map
}

function statusText(state, budget) {
  const summary = state.summary || {}
  const headline = state.headline || null
  const totals = (state.usage && state.usage.totals) || {}
  const lines = [
    `ManageAPI · ${summary.providerCount ?? '?'} 个站点 / ${summary.offerCount ?? '?'} 个供给 / ${summary.modelCount ?? '?'} 个模型`,
  ]
  if (headline && headline.text) lines.push(`最划算：${headline.text}`)
  lines.push(
    `今日：${totals.requests ?? 0} 次 · 输入 ${compact(totals.input)} · 输出 ${compact(totals.output)}` +
      (totals.errors ? ` · 错误 ${totals.errors}` : ''),
  )
  const snap = budget ? budget.snapshot() : null
  if (snap) {
    if (snap.configured) {
      lines.push(
        `预算：本会话 ${compact(snap.session.tokens)}${snap.limits.sessionTokens ? `/${compact(snap.limits.sessionTokens)}` : ''}` +
          ` · 今日 ${compact(snap.daily.tokens)}${snap.limits.dailyTokens ? `/${compact(snap.limits.dailyTokens)}` : ''}`,
      )
    } else {
      lines.push('预算：未设置（插件配置 budget.sessionTokens / budget.dailyTokens 可开启熔断）')
    }
    if (snap.over) lines.push('⚠️ 预算已超限：工具调用已被熔断，模型只能收尾。')
  }
  return lines.join('\n')
}

function modelsText(state, keyword, limit) {
  const names = providerNames(state)
  const ranked = Array.isArray(state.ranked) ? state.ranked : []
  const wanted = String(keyword || '').trim().toLowerCase()
  const picked = wanted
    ? ranked.filter((row) => String(row.modelKey || '').toLowerCase().includes(wanted)).slice(0, 3)
    : ranked.slice(0, limit)
  if (!picked.length) return wanted ? `没有匹配「${keyword}」的在售模型` : '暂无可比价的模型（可能还没跑探针）'
  const lines = ['模型比价（¥/百万 token，混合价；★ = 该模型最便宜的站）']
  for (const row of picked) {
    const spread = typeof row.spreadPct === 'number' ? `价差 ${Math.round(row.spreadPct)}% · ` : ''
    lines.push(`${row.modelKey} · ${spread}${row.providerCount ?? '-'} 个站点`)
    for (const cell of (row.rows || []).slice(0, limit)) {
      const provider = names.get(cell.providerId) || cell.providerId || '-'
      lines.push(
        `  ${cell.isCheapest ? '★' : ' '} ${String(provider).padEnd(12, ' ')} ${money(cell.blendedCnyPerMtok).padStart(9, ' ')}` +
          `  TTFT ${cell.ttftMs ? `${Math.round(cell.ttftMs)}ms` : '-'}  缓存 ${pct(cell.cacheHitRate)}`,
      )
    }
  }
  lines.push(`共 ${ranked.length} 个可路由模型；完整视图见设置页「ManageAPI · 比价」。`)
  return lines.join('\n')
}

function usageText(state, streamStats, budget) {
  const totals = (state.usage && state.usage.totals) || {}
  const lines = [
    `今日全渠道（daemon 记账）：${totals.requests ?? 0} 次 / 输入 ${compact(totals.input)} · 输出 ${compact(totals.output)}` +
      ` · 缓存读 ${compact(totals.cached)} · 缓存写 ${compact(totals.cacheCreation)}` +
      (totals.errors ? ` · 错误 ${totals.errors}` : ''),
  ]
  const sessions = [...streamStats.entries()]
    .map(([sessionId, row]) => ({ sessionId, ...row }))
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
    .slice(0, 5)
  if (sessions.length) {
    lines.push('本进程观测到的会话：')
    for (const row of sessions) lines.push(`  · ${row.model || '未知模型'} ${compact(row.tokens)} token / ${row.calls} 次`)
  } else {
    lines.push('本进程还没有观测到经 ManageAPI 的模型调用。')
  }
  const snap = budget ? budget.snapshot() : null
  if (snap) lines.push(`预算：${snap.configured ? (snap.over ? '已超限' : '正常') : '未设置'}`)
  return lines.join('\n')
}

/**
 * @param {{
 *   commands: { register: (definition: any) => () => void },
 *   port: number,
 *   budget: any,
 *   streamStats: Map<string, { tokens: number, calls: number, lastAt: number, model: string }>,
 *   log: (...args: any[]) => void,
 * }} deps
 */
export function registerCommands({ commands, port, budget, streamStats, log }) {
  let dispose = null
  try {
    dispose = commands.register({
      name: 'manage',
      description: '查看 ManageAPI 状态 / 模型比价 / token 用量 / 预算（本地命令，不发给模型）',
      input: { hint: '[status|models|usage|budget] [模型名]', attachments: false },
      handler: async (invocation) => {
        const raw = String(invocation?.rawInput || '').trim()
        const [sub = 'status', ...rest] = raw.split(/\s+/).filter(Boolean)
        const keyword = rest.join(' ')

        if (sub === 'budget') {
          const snap = budget ? budget.snapshot() : null
          if (!snap) return { kind: 'error', text: '预算模块不可用（插件未激活预算功能）' }
          const lines = [
            `本会话：${compact(snap.session.tokens)} token / ${snap.session.calls} 次调用` +
              (snap.limits.sessionTokens ? `（上限 ${compact(snap.limits.sessionTokens)}）` : '（未设上限）'),
            `今日全渠道：${compact(snap.daily.tokens)} token / ${snap.daily.requests} 次` +
              (snap.limits.dailyTokens ? `（上限 ${compact(snap.limits.dailyTokens)}）` : '（未设上限）'),
            snap.over ? '⚠️ 已超预算：工具调用被熔断。' : '未超预算。',
            '要开启熔断：在 profile 的 cordis.patch.yml 里给 manage-api 配 budget.sessionTokens / budget.dailyTokens。',
          ]
          return { kind: 'success', text: lines.join('\n') }
        }

        const loaded = await loadState(port)
        if (!loaded.ok) {
          return { kind: 'error', text: `ManageAPI daemon 不可用：${loaded.error}（插件会尝试自动启动，设置页面板可看状态）` }
        }
        const state = loaded.state
        // 顺手把 daemon 记账的今日用量喂给预算模块，保证 /manage budget 与面板口径一致
        if (budget && typeof budget.absorbUsage === 'function' && state.usage && state.usage.totals) {
          try {
            budget.absorbUsage(state.usage.totals)
          } catch {
            /* 预算刷新失败不影响命令输出 */
          }
        }
        if (sub === 'models') return { kind: 'success', text: modelsText(state, keyword, 3) }
        if (sub === 'usage') return { kind: 'success', text: usageText(state, streamStats, budget) }
        if (sub === 'status') return { kind: 'success', text: statusText(state, budget) }
        return { kind: 'error', text: `不认识的子命令「${sub}」，可用：status | models | usage | budget` }
      },
    })
    log('命令 /manage 已注册')
  } catch (err) {
    log(`注册命令 /manage 失败：${String(err && err.message ? err.message : err)}`)
  }
  return () => {
    try {
      dispose?.()
    } catch {
      /* ignore */
    }
  }
}
