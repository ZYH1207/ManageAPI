/**
 * D 棒 · 系统提示词运行时上下文（移植自朋友版 lib/prompt.js）。
 *
 * 用 `systemPrompt.context()` 而非 `section()`：给的是「当前运行时事实」
 * （daemon 在不在、站点/模型数、价差、今日用量、预算），不是行为规约。
 * context 可省略、可被 `suppressRuntimeContext()` 压制，符合 practices.md。
 *
 * context.text 是同步回调，每次装配 prompt 都会调；在里面 await HTTP 会拖慢每一步
 * 模型请求。所以用定时器（默认 30s）刷新一份内存文本，回调只读缓存同步返回。
 * 定时器全部 unref，避免吊住进程退出。
 */

/**
 * @param {{client:{getState:()=>Promise<any>}, budget:any, getMode:()=>string, log?:(...a:any[])=>void, port?:number, refreshMs?:number}} deps
 */
export function createPromptContext({ client, budget, getMode, log = () => {}, port = 4319, refreshMs = 30000 } = {}) {
  let text = ''
  let timer = null
  let retryTimer = null
  let refreshing = null
  let disposed = false
  let lastAt = 0

  async function refresh() {
    if (refreshing) return refreshing
    refreshing = (async () => {
      const mode = typeof getMode === 'function' ? getMode() : 'down'
      if (mode !== 'attached' && mode !== 'owned') {
        text = `ManageAPI：daemon ${mode === 'starting' ? '正在启动' : '未运行'}（端口 ${port}），比价与网关暂不可用。`
        lastAt = Date.now()
        // 冷启动窗口每 2 秒重试一次，避免提示词长期停在「未运行」
        if (!retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null
            if (!disposed) refresh().catch(() => {})
          }, 2000)
          if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref()
        }
        return
      }
      const result = await client.getState()
      if (!result || !result.ok) {
        text = `ManageAPI：daemon 运行中但状态读取失败（${(result && result.error) || '未知错误'}）。`
        lastAt = Date.now()
        return
      }
      const state = result.body || {}
      const summary = state.summary || {}
      const totals = (state.usage && state.usage.totals) || {}
      if (budget && typeof budget.absorbUsage === 'function') budget.absorbUsage(totals)
      const headline = state.headline
      const parts = [`ManageAPI：${summary.offerCount ?? '-'} 个供给 / ${summary.modelCount ?? '-'} 个模型 / ${summary.providerCount ?? '-'} 个站点`]
      if (summary.avgSpreadPct && !(headline && headline.text)) parts.push(`同模型跨站平均价差 ${summary.avgSpreadPct}%`)
      if (headline && headline.text) parts.push(`当前最划算：${headline.text}`)
      const budgetText = budget && typeof budget.describe === 'function' ? budget.describe() : ''
      if (budgetText) parts.push(budgetText)
      parts.push('详情见设置页 ManageAPI 面板或 manageapi_status 工具。')
      text = parts.join('；')
      lastAt = Date.now()
    })()
      .catch((err) => {
        text = ''
        log(`[prompt] 刷新失败：${String(err && err.message ? err.message : err)}`)
      })
      .finally(() => {
        refreshing = null
      })
    return refreshing
  }

  function current(sessionId) {
    if (!text) return ''
    const budgetText = budget && typeof budget.describe === 'function' ? budget.describe(sessionId) : ''
    if (!budgetText) return text
    return text.includes('本会话') || text.includes('今日') ? text : `${text}；${budgetText}`
  }

  /** 注册进 systemPrompt 服务，返回 disposer（同步 context 回调，只读缓存）。 */
  function register(systemPrompt) {
    const dispose = systemPrompt.context({
      name: 'manage-api',
      order: 60,
      required: false,
      interpolate: false,
      text: (context) => {
        const sessionId = context && context.scope && typeof context.scope.id === 'string' ? context.scope.id : undefined
        return current(sessionId)
      },
    })
    return typeof dispose === 'function' ? dispose : () => {}
  }

  /** 面板/健康检查顺手刷新一次（后台定时器可能被节流，别只靠它）。 */
  function maybeRefresh(minAgeMs = 5000) {
    if (refreshing) return false
    if (lastAt && Date.now() - lastAt < minAgeMs) return false
    refresh().catch(() => {})
    return true
  }

  function debug() {
    return { at: lastAt, text, mode: typeof getMode === 'function' ? getMode() : 'down', refreshing: Boolean(refreshing) }
  }

  function start() {
    refresh().catch(() => {})
    timer = setInterval(() => {
      if (disposed) return
      refresh().catch(() => {})
    }, Math.max(5000, refreshMs))
    if (timer && typeof timer.unref === 'function') timer.unref()
    return () => {
      disposed = true
      if (timer) clearInterval(timer)
      timer = null
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  return { refresh, maybeRefresh, register, start, current: () => text, debug }
}
