/**
 * D 棒 · 人类命令 `/manage status|models|usage|budget`（移植自朋友版 lib/commands.js）。
 *
 * 与工具的分工：工具给**模型**用（tools.register，模型决定何时调）；命令给**人**用
 * （commands.register，不发回模型、不产生 token）。handler 必须返回
 * `{ kind:'success'|'error', text }`（本机 dsh-commands 的 normalizeResult 契约）。
 *
 * 命令名必须匹配 /^[a-z][a-z0-9_-]*$/ —— 注册名是 "manage"，斜杠由 UI 加。
 * 输入从 invocation.rawInput 取（若宿主给的是其它字段名则回退到空串，默认 status）。
 */

const n = (value) => { const v = Number(value); return Number.isFinite(v) ? v : null }
const compact = (value) => {
  const v = n(value)
  if (v === null) return '-'
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(1)}万`
  return String(Math.round(v))
}
const money = (value) => { const v = n(value); if (v === null) return '-'; return v >= 1 ? `¥${v.toFixed(2)}` : `¥${v.toFixed(3)}` }
const pct = (value) => { const v = n(value); return v === null ? '-' : `${Math.round(v * 100)}%` }

function providerNames(state) {
  const map = new Map()
  for (const provider of state?.providers || []) if (provider && provider.id) map.set(provider.id, provider.name || provider.id)
  return map
}

function statusText(state, budget) {
  const summary = state.summary || {}
  const headline = state.headline || null
  const totals = (state.usage && state.usage.totals) || {}
  const lines = [`ManageAPI · ${summary.providerCount ?? '?'} 个站点 / ${summary.offerCount ?? '?'} 个供给 / ${summary.modelCount ?? '?'} 个模型`]
  if (headline && headline.text) lines.push(`最划算：${headline.text}`)
  lines.push(`今日：${totals.requests ?? 0} 次 · 输入 ${compact(totals.input)} · 输出 ${compact(totals.output)}${totals.errors ? ` · 错误 ${totals.errors}` : ''}`)
  const snap = budget ? budget.snapshot() : null
  if (snap) {
    if (snap.configured) {
      lines.push(`预算（工具守卫，非 token 熔断）：本会话 ${compact(snap.session.tokens)}${snap.limits.sessionTokens ? `/${compact(snap.limits.sessionTokens)}` : ''} · 今日 ${compact(snap.daily.tokens)}${snap.limits.dailyTokens ? `/${compact(snap.limits.dailyTokens)}` : ''}`)
    } else {
      lines.push('预算：未设置（插件配置 budget.sessionTokens / budget.dailyTokens 可开启工具守卫）')
    }
    if (snap.over) lines.push('⚠️ 预算已超限：工具调用守卫已拒绝后续工具调用，模型只能收尾（不是 token 级熔断）。')
  }
  return lines.join('\n')
}

function modelsText(state, keyword, limit) {
  const names = providerNames(state)
  const ranked = Array.isArray(state.ranked) ? state.ranked : []
  const wanted = String(keyword || '').trim().toLowerCase()
  const picked = wanted ? ranked.filter((row) => String(row.modelKey || '').toLowerCase().includes(wanted)).slice(0, 3) : ranked.slice(0, limit)
  if (!picked.length) return wanted ? `没有匹配「${keyword}」的在售模型` : '暂无可比价的模型（可能还没跑探针）'
  const lines = ['模型比价（¥/百万 token，混合价；★ = 该模型最便宜的站）']
  for (const row of picked) {
    const spread = typeof row.spreadPct === 'number' ? `价差 ${Math.round(row.spreadPct)}% · ` : ''
    lines.push(`${row.modelKey} · ${spread}${row.providerCount ?? '-'} 个站点`)
    for (const cell of (row.rows || []).slice(0, limit)) {
      const provider = names.get(cell.providerId) || cell.providerId || '-'
      lines.push(`  ${cell.isCheapest ? '★' : ' '} ${String(provider).padEnd(12, ' ')} ${money(cell.blendedCnyPerMtok).padStart(9, ' ')}  TTFT ${cell.ttftMs ? `${Math.round(cell.ttftMs)}ms` : '-'}  缓存 ${pct(cell.cacheHitRate)}`)
    }
  }
  lines.push(`共 ${ranked.length} 个可路由模型；完整视图见设置页「ManageAPI」。`)
  return lines.join('\n')
}

function usageText(state, streamStats, budget) {
  const totals = (state.usage && state.usage.totals) || {}
  const lines = [`今日全渠道（daemon 记账）：${totals.requests ?? 0} 次 / 输入 ${compact(totals.input)} · 输出 ${compact(totals.output)} · 缓存读 ${compact(totals.cached)} · 缓存写 ${compact(totals.cacheCreation)}${totals.errors ? ` · 错误 ${totals.errors}` : ''}`]
  const sess = streamStats ? streamStats.sessions(5) : []
  if (sess.length) {
    lines.push('本进程观测到的会话：')
    for (const row of sess) lines.push(`  · ${row.model || '未知模型'} ${compact(row.tokens)} token / ${row.calls} 次`)
  } else {
    lines.push('本进程还没有观测到经 ManageAPI 的模型调用。')
  }
  const snap = budget ? budget.snapshot() : null
  if (snap) lines.push(`预算：${snap.configured ? (snap.over ? '已超限（工具守卫）' : '正常（工具守卫）') : '未设置'}`)
  return lines.join('\n')
}

/**
 * @param {{commands:{register:(def:any)=>()=>void}, client:{getState:()=>Promise<any>}, budget:any, streamStats:any, log?:(...a:any[])=>void}} deps
 */
export function registerCommands({ commands, client, budget, streamStats, log = () => {} }) {
  let dispose = null
  try {
    dispose = commands.register({
      name: 'manage',
      description: '查看 ManageAPI 状态 / 模型比价 / token 用量 / 预算（本地命令，不发给模型）',
      input: { hint: '[status|models|usage|budget] [模型名]', attachments: false },
      handler: async (invocation) => {
        const raw = String((invocation && (invocation.rawInput ?? invocation.input ?? invocation.args)) || '').trim()
        const [sub = 'status', ...rest] = raw.split(/\s+/).filter(Boolean)
        const keyword = rest.join(' ')

        if (sub === 'budget') {
          const snap = budget ? budget.snapshot() : null
          if (!snap) return { kind: 'error', text: '预算模块不可用（插件未激活预算功能）' }
          const lines = [
            `本会话：${compact(snap.session.tokens)} token / ${snap.session.calls} 次调用${snap.limits.sessionTokens ? `（上限 ${compact(snap.limits.sessionTokens)}）` : '（未设上限）'}`,
            `今日全渠道：${compact(snap.daily.tokens)} token / ${snap.daily.requests} 次${snap.limits.dailyTokens ? `（上限 ${compact(snap.limits.dailyTokens)}）` : '（未设上限）'}`,
            snap.over ? '⚠️ 已超预算：工具调用守卫已拒绝后续工具调用（不是 token 级熔断）。' : '未超预算。',
            '要开启工具守卫：在 profile 的 cordis.patch.yml 里给 manage-api 配 budget.sessionTokens / budget.dailyTokens。',
          ]
          return { kind: 'success', text: lines.join('\n') }
        }

        const loaded = await client.getState().catch((err) => ({ ok: false, error: String(err && err.message ? err.message : err) }))
        if (!loaded || !loaded.ok) {
          return { kind: 'error', text: `ManageAPI daemon 不可用：${(loaded && loaded.error) || '未知错误'}（面板里可看状态）` }
        }
        const state = loaded.body || {}
        if (budget && typeof budget.absorbUsage === 'function' && state.usage && state.usage.totals) {
          try { budget.absorbUsage(state.usage.totals) } catch { /* 预算刷新失败不影响命令输出 */ }
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
    try { dispose?.() } catch { /* ignore */ }
  }
}
