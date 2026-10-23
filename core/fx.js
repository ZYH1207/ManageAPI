/**
 * 汇率：自动拉取 + 手动覆盖。
 *
 * 设计取舍：
 * - 内部基准永远是 USD，`rates[XXX]` 表示「1 美元换多少 XXX」。所以 USD 恒为 1，
 *   换算只需要「先折成美元、再折成目标币种」，不用管交叉汇率。
 * - `settings.fx` 是唯一事实来源，`settings.fxUsdCny` 只是给它留的兼容镜像
 *   （老的定价/监控代码都读这个字段），每次写入都同步刷新。
 * - 手动填过就 `manual: true`，自动任务不再覆盖；用户点「恢复自动」才重新跟随。
 * - 拉取失败一律静默沿用旧值：这是个辅助数据，不能因为它让整个面板报错。
 */
import { readDb, mutate } from './store.js'

export const FX_BASE = 'USD'
export const FX_REFRESH_MS = 12 * 3600 * 1000
export const FX_WARN_MS = 7 * 24 * 3600 * 1000
export const FX_DEFAULT_CNY = 7.2

/** 只留我们可能用到的币种：接口会返回 170 多种，全存进 db.json 只是让 state 变胖 */
export const FX_KEEP = ['CNY', 'HKD', 'TWD', 'EUR', 'JPY', 'GBP', 'SGD', 'KRW', 'AUD', 'CAD']
const SOURCES = [
  {
    name: 'er-api',
    url: 'https://open.er-api.com/v6/latest/USD',
    pick: (json) => (json && json.result === 'success' ? json.rates : null),
  },
  {
    name: 'frankfurter',
    url: 'https://api.frankfurter.app/latest?from=USD&to=CNY,EUR,JPY,GBP,HKD',
    pick: (json) => (json && json.rates ? json.rates : null),
  },
]

export function defaultFx() {
  return { base: FX_BASE, rates: { CNY: FX_DEFAULT_CNY }, updatedAt: null, source: 'default', manual: false }
}

/** 把 db 里可能缺失/半残的 fx 补成完整形状（纯函数，不写盘） */
export function ensureFx(settings = {}) {
  const raw = settings.fx && typeof settings.fx === 'object' ? settings.fx : {}
  const rates = { ...(raw.rates || {}) }
  const legacy = Number(settings.fxUsdCny)
  const cny = Number(rates.CNY)
  rates.CNY = Number.isFinite(cny) && cny > 0 ? cny : Number.isFinite(legacy) && legacy > 0 ? legacy : FX_DEFAULT_CNY
  rates[FX_BASE] = 1
  return {
    base: FX_BASE,
    rates,
    updatedAt: raw.updatedAt || null,
    source: raw.source || 'default',
    manual: Boolean(raw.manual),
  }
}

/** 1 单位 from → 1 单位 to（都基于 USD 三角换算） */
export function convert(amount, from, to, fx) {
  const rates = fx?.rates || {}
  const a = Number(rates[from])
  const b = Number(rates[to])
  if (!Number.isFinite(amount) || !Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null
  return (amount / a) * b
}

export function isStale(fx, now = Date.now()) {
  if (!fx?.updatedAt) return true
  const at = Date.parse(fx.updatedAt)
  return !Number.isFinite(at) || now - at > FX_REFRESH_MS
}

export function shouldRefresh(fx, now = Date.now()) {
  if (fx?.manual) return false
  return isStale(fx, now)
}

/** 当前汇率（只读，不写盘） */
export async function readFx() {
  const db = await readDb()
  return ensureFx(db.settings)
}

/** 拉一次；成功返回 {rates, source}，失败返回 null */
export async function fetchRates({ fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  for (const source of SOURCES) {
    try {
      const response = await fetchImpl(source.url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) continue
      const raw = source.pick(await response.json())
      if (!raw) continue
      const clean = {}
      for (const code of FX_KEEP) {
        const n = Number(raw[code])
        if (Number.isFinite(n) && n > 0) clean[code] = n
      }
      if (!clean.CNY) continue
      clean[FX_BASE] = 1
      return { rates: clean, source: source.name }
    } catch {
      // 换下一个源；全失败就静默
    }
  }
  return null
}

/**
 * 刷新并落盘。返回 {ok, fx, error}：
 * - 手动模式直接跳过（error: 'manual'）
 * - 拉取失败沿用旧值（error: 'fetch'），updatedAt 不动，避免伪装成「刚更新过」
 */
export async function refreshFx({ fetchImpl, logger = console } = {}) {
  const current = await readFx()
  if (current.manual) return { ok: false, fx: current, error: 'manual' }
  const got = await fetchRates({ fetchImpl })
  if (!got) {
    logger?.warn?.('[汇率] 拉取失败，继续用上次的值')
    return { ok: false, fx: current, error: 'fetch' }
  }
  const next = {
    base: FX_BASE,
    rates: got.rates,
    updatedAt: new Date().toISOString(),
    source: got.source,
    manual: false,
  }
  await mutate((db) => {
    db.settings.fx = next
    db.settings.fxUsdCny = next.rates.CNY
  })
  return { ok: true, fx: next }
}

/** 手动覆盖人民币汇率（其它币种保留） */
export async function setManualRate(cny) {
  const value = Number(cny)
  if (!Number.isFinite(value) || value <= 0) {
    const error = new Error('汇率必须是正数')
    error.status = 400
    throw error
  }
  let saved = null
  await mutate((db) => {
    const fx = ensureFx(db.settings)
    fx.rates.CNY = value
    fx.manual = true
    fx.source = 'manual'
    fx.updatedAt = new Date().toISOString()
    db.settings.fx = fx
    db.settings.fxUsdCny = value
    saved = fx
  })
  return saved
}

/** 恢复自动：清掉手动标记，下一次调度会去拉 */
export async function setAutoRate() {
  let saved = null
  await mutate((db) => {
    const fx = ensureFx(db.settings)
    fx.manual = false
    db.settings.fx = fx
    db.settings.fxUsdCny = fx.rates.CNY
    saved = fx
  })
  return saved
}
