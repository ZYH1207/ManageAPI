/**
 * 系统提示词上下文（host 半边）。
 *
 * 用 `systemPrompt.context()` 而不是 `section()`：这里给的是「当前运行时事实」
 * （daemon 在不在、模型/站点数、价差、今日用量、预算），不是行为规约。
 * context 的语义是可省略、可被 `suppressRuntimeContext()` 压制，正好对得上——
 * 用户不想让模型知道自己的账单时能一键关掉，而不是被迫接受一段永不消失的 prompt。
 *
 * ## 为什么文本来自缓存
 *
 * context 的 text 是同步回调，每次装配 prompt 都会调；在里面 await HTTP 会把
 * 每一步的模型请求都拖慢几百毫秒。所以由定时器（默认 30 秒）刷新一份
 * 快照文本，回调节只读内存。
 */

import { daemonGet } from './daemon.js'


/**
 * @param {{
 *   port: number,
 *   budget: ReturnType<typeof import('./budget.js').createBudget>,
 *   getMode: () => string,
 *   log: (...args: any[]) => void,
 *   refreshMs?: number,
 * }} deps
 */
export function createPromptContext({ port, budget, getMode, log, refreshMs = 30000 }) {
  let text = ''
  let timer = null
  let refreshing = null
  let disposed = false
  let retryTimer = null

  let lastAt = 0

  async function refresh() {
    if (refreshing) return refreshing
    refreshing = (async () => {
      const mode = getMode()
      if (mode !== 'attached' && mode !== 'owned') {
        text = `ManageAPI：daemon ${mode === 'starting' ? '正在启动' : '未运行'}（端口 ${port}），比价与网关暂不可用。`
        lastAt = Date.now()
        // 冷启动窗口内每 2 秒重试一次，避免提示词长时间停留在「未运行」
        if (!retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null
            if (!disposed) refresh().catch(() => {})
          }, 2000)
          if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref()
        }
        return
      }
      const result = await daemonGet(port, '/api/state?light=1')
      if (!result.ok) {
        text = `ManageAPI：daemon 运行中但状态读取失败（${result.error || '未知错误'}）。`
        lastAt = Date.now()
        return
      }
      const state = result.body || {}
      const summary = state.summary || {}
      const totals = (state.usage && state.usage.totals) || {}
      budget.absorbUsage(totals)
      const headline = state.headline
      const parts = [`ManageAPI：${summary.offerCount ?? '-'} 个供给 / ${summary.modelCount ?? '-'} 个模型 / ${summary.providerCount ?? '-'} 个站点`]
      // headline 自带价差信息，别重复同一句
      if (summary.avgSpreadPct && !(headline && headline.text)) parts.push(`同模型跨站平均价差 ${summary.avgSpreadPct}%`)
      if (headline && headline.text) parts.push(`当前最划算：${headline.text}`)
      // 今日用量交给 budget.describe() 统一表述，避免这里再说一遍造成重复
      const budgetText = budget.describe()
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
    const budgetText = budget.describe(sessionId)
    if (!budgetText) return text
    // 预算数字每一步都可能变，用实时值替换缓存里的那一段
    return text.includes('本会话') || text.includes('今日')
      ? text
      : `${text}；${budgetText}`
  }

  /** 注册进 systemPrompt 服务，返回 disposer。 */
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

  /** 面板/健康检查时顺手刷新一次（定时器在后台可能被节流，别只依赖它）。 */
  function maybeRefresh(minAgeMs = 5000) {
    if (refreshing) return false
    if (lastAt && Date.now() - lastAt < minAgeMs) return false
    refresh().catch(() => {})
    return true
  }

  function debug() {
    return { at: lastAt, text, mode: getMode(), refreshing: Boolean(refreshing) }
  }

  function start() {
    // 立即刷一次，让第一轮就有内容；之后按 refreshMs 轮询
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
