/**
 * new-api / one-api 的公开价格表：`GET /api/pricing`。
 *
 * 为什么需要它：这是 new-api 系**唯一公开**的价格来源（不用登录、不用令牌）。
 * 没有它，一个没开「模型广场」、渠道接口又要管理员的 new-api 站就完全读不到分组
 * 和价格——格子API（api.geziapi.com）就是这种：模型能同步（靠 Key 打 /v1/models），
 * 但分组倍率、输入/输出单价全是空的。
 *
 * 返回结构与 model-plaza 那条路对齐（server.js 的 fetchProviderPricing 直接消费）：
 *   groups   [{name, rate}]                     分组倍率
 *   models   [{name, inPrice, outPrice, ...}]   每个模型一条（**原价**，未乘倍率）
 *   byGroup  [{...同上, group}]                 每个 (分组, 模型) 一条
 *   source   'pricing'
 *
 * 价格单位：new-api 的 ratio 约定是「ratio=1 → $2/百万 token」，所以
 *   输入 = model_ratio × 2
 *   输出 = model_ratio × completion_ratio × 2
 *   缓存读 = model_ratio × cache_ratio × 2
 * 与 plaza 那条路同量纲（都是「站点美元/百万 token」），倍率由调用方再乘。
 *
 * 表达式计费（billing_mode='tiered_expr'）：站点把单价写成
 *   p * 0.2857 + c * 1.1428 + cr * 0.0057
 * 的系数就是「美元/百万 token」，此时 model_ratio 常常是占位值 37.5（new-api 给未
 * 定价模型的默认倍率 → $75/M 的假价），必须解表达式，不能信 ratio。
 */

function originOf(baseUrl) {
  return String(baseUrl)
    .replace(/\/v\d+(\.\d+)?\/?$/i, '')
    .replace(/\/+$/, '')
}

const NUM = '([0-9]+(?:\\.[0-9]+)?)'

/** 拆出每个 tier(...) 的表达式体；没有 tier() 就整条当一段 */
function tierBodies(expr) {
  const out = []
  let i = 0
  for (;;) {
    const at = expr.indexOf('tier(', i)
    if (at < 0) break
    let k = at + 5
    let depth = 1
    while (k < expr.length && depth > 0) {
      if (expr[k] === '(') depth += 1
      else if (expr[k] === ')') depth -= 1
      k += 1
    }
    out.push(expr.slice(at + 5, k - 1))
    i = k
  }
  return out.length > 0 ? out : [expr]
}

/** 抽 p / c / cr / cc 的系数（美元/百万 token） */
function coefficients(body) {
  const pick = (v) => {
    const m = body.match(new RegExp(`(?<![a-z0-9])${v}\\s*\\*\\s*${NUM}`))
    return m ? Number(m[1]) : null
  }
  return { p: pick('p'), c: pick('c'), cr: pick('cr'), cc: pick('cc') }
}

/** 表达式里第一段 tier 对应的单价；全是 0 就返回 null（交回 ratio 口径） */
function priceFromExpr(expr) {
  for (const body of tierBodies(expr)) {
    const k = coefficients(body)
    if (!k.p && !k.c) continue
    return {
      inPrice: k.p ?? 0,
      outPrice: k.c ?? 0,
      cacheReadPrice: k.cr,
      cacheWritePrice: k.cc,
    }
  }
  return null
}

/** 按次计费：fixed(0.1466) 这种表达式给的是「每次多少美元」 */
function fixedPrice(expr) {
  const m = String(expr).match(new RegExp(`fixed\\(\\s*${NUM}\\s*\\)`))
  return m ? Number(m[1]) : null
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 一条 /api/pricing 的模型 → 我们的模型形状（原价，未乘分组倍率） */
export function toPricingModel(entry) {
  const name = String(entry?.model_name || '').trim()
  if (!name) return null
  const perCallPrice = num(entry?.model_price)
  if (Number(entry?.quota_type) === 1 || (perCallPrice !== null && perCallPrice > 0)) {
    return { name, billingMode: 'per_request', callPrice: perCallPrice ?? 0, inPrice: null, outPrice: null, cacheReadPrice: null, cacheWritePrice: null }
  }

  const expr = String(entry?.billing_expr || '').trim()
  if (entry?.billing_mode === 'tiered_expr' && expr) {
    const fromExpr = priceFromExpr(expr)
    if (fromExpr) return { name, billingMode: 'token', ...fromExpr }
    const fixed = fixedPrice(expr)
    if (fixed !== null) {
      return { name, billingMode: 'per_request', callPrice: fixed, inPrice: null, outPrice: null, cacheReadPrice: null, cacheWritePrice: null }
    }
  }

  const ratio = num(entry?.model_ratio)
  // 37.5 是 new-api 给「未定价模型」的默认倍率（ratio×2 = $75/M），不是真价
  if (ratio === null || ratio <= 0 || ratio === 37.5) return null
  const completion = num(entry?.completion_ratio) ?? 1
  const cacheRatio = num(entry?.cache_ratio) ?? 1
  const cacheWrite = num(entry?.create_cache_ratio) ?? 0
  return {
    name,
    billingMode: 'token',
    inPrice: ratio * 2,
    outPrice: ratio * completion * 2,
    cacheReadPrice: ratio * cacheRatio * 2,
    cacheWritePrice: cacheWrite > 0 ? ratio * cacheWrite * 2 : null,
  }
}

/**
 * 拉取 /api/pricing（公开接口，不需要令牌）。
 * @returns {Promise<{groups:Array, models:Array, byGroup:Array, source:'pricing'}>}
 */
export async function fetchNewApiPricing({ baseUrl, timeoutMs = 15000 }) {
  const origin = originOf(baseUrl)
  if (!origin) throw new Error('站点地址不合法')

  let json
  try {
    const res = await fetch(`${origin}/api/pricing`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 404) throw new Error('这个站没有公开的价格表（/api/pricing 返回 404）')
    if (!res.ok) throw new Error(`价格表返回 HTTP ${res.status}`)
    json = await res.json()
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new Error(`价格表请求超时（${timeoutMs}ms）`)
    throw error instanceof Error ? error : new Error(String(error))
  }

  const list = Array.isArray(json?.data) ? json.data : []
  if (list.length === 0) throw new Error('价格表是空的（/api/pricing 没返回模型）')

  const ratioTable = json?.group_ratio && typeof json.group_ratio === 'object' ? json.group_ratio : {}
  const groups = Object.entries(ratioTable).map(([name, rate]) => ({ name, rate: num(rate) }))
  // 「auto」这种分组的 ratio 是字符串 'auto'：倍率未知，但分组本身要列出来
  for (const name of Object.keys(json?.usable_group || {})) {
    if (!groups.some((g) => g.name === name)) groups.push({ name, rate: null })
  }

  const models = []
  const byGroup = []
  for (const entry of list) {
    const model = toPricingModel(entry)
    if (!model) continue
    models.push(model)
    // 分组维度：一个模型可能挂在多个分组里，界面按分组数模型/落价都要它
    for (const group of entry.enable_groups || []) {
      if (typeof group === 'string' && group) byGroup.push({ ...model, group })
    }
  }

  return { groups, models, byGroup, source: 'pricing' }
}
