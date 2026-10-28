/**
 * 模型广场（Sub2API 的 /api/v1/model-plaza）。
 *
 * 开了广场的站点会把「分组 + 倍率 + 每个模型的实际价格 + 官方价」全部公开，
 * 这是唯一能自动拿到价格的途径——API Key 本身查不到这些。
 *
 * 价格单位是「每 token」，×1e6 换算成我们用的「每百万 token」。
 *
 * 币种别假定：这个接口**不带币种字段**，而实测这些中转站报的是美元——
 * 绿萝广场里 gpt-4o 报 2.5/10、gpt-4o-mini 报 0.15/0.6、gemini-2.5-flash 报
 * 0.3/2.5，正好是官方美元价。所以广场价格不要标 CNY，币种由 offer 上用户选的值决定
 * （见 inventory.js 的 currencyOf）。
 */
import { normalizeModelKey } from './inventory.js'

function plazaUrl(baseUrl) {
  // 协议跟着用户填的走：内网/自建站常是 http，硬拼 https 会连不上
  const match = String(baseUrl).match(/^(https?):\/\/([^/]+)/i)
  if (!match) return ''
  const bare = match[2].replace(/^api\./i, '')
  return `${match[1].toLowerCase()}://${bare}/api/v1/model-plaza`
}

/**
 * 拉取模型广场。站点没开启时抛错，由调用方给出可读提示。
 * @returns {Promise<Array>} groups
 */
export async function fetchModelPlaza({ baseUrl, timeoutMs = 15000 }) {
  const url = plazaUrl(baseUrl)
  let res
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`连不上模型广场（${error.message}）`)
  }
  if (res.status === 404) {
    throw new Error('这个站没有开启模型广场（/api/v1/model-plaza 返回 404）')
  }
  if (!res.ok) {
    throw new Error(`模型广场返回 HTTP ${res.status}`)
  }
  let json
  try {
    json = await res.json()
  } catch {
    throw new Error('模型广场返回的不是 JSON')
  }
  const groups = json?.data?.groups
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error('模型广场返回里没有分组数据')
  }
  return groups
}

/** 每 token → 每百万 token，保留三位小数。 */
function perMtok(value) {
  if (value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 1e6 * 1000) / 1000
}

/**
 * 把分组数据压平成「模型名 → 价格」。
 *
 * 三个价格字段别搞混：
 *   baseIn/baseOut    —— 站方原价（未乘分组倍率），是「倍率换算」的参照物
 *   inPrice/outPrice  —— 该分组的实际价 = 原价 × 倍率
 *   officialIn/Out    —— 站方声明的「官方价」。**不可靠**：实测 leekbox 把
 *                        所有 deepseek 模型都报成同一个官方价（0.15/0.6），
 *                        明显是填的占位值。只做展示，别拿它当基准价。
 *
 * 同一模型常出现在多个分组，价格可能差好几倍（实测哈利恩的 deepseek-v4.1-flash：
 * 「按次计费」分组 0.15/0.6，「三方自部署」和「特惠」都是 2/8）。没指定分组时
 * 取「出现次数最多的那个价」——多数分组都这么定价，比取第一个靠谱。
 */
export function flattenPlaza(groups) {
  const buckets = new Map() // key → [entry]
  const groupList = []

  for (const group of groups) {
    const models = Array.isArray(group.models) ? group.models : []
    const rate = Number(group.rate_multiplier)
    const multiplier = Number.isFinite(rate) && rate > 0 ? rate : 1
    // 生图/视频分组可以单独设倍率（image_rate_independent=true 时不再用分组倍率）。
    // 站点前端算价就是 `per_request_price × 这个倍率`，我们必须同口径
    const imageIndependent = Boolean(group.image_rate_independent)
    const imageMultiplierRaw = Number(group.image_rate_multiplier)
    const imageMultiplier = Number.isFinite(imageMultiplierRaw) ? imageMultiplierRaw : multiplier

    groupList.push({
      id: group.id,
      name: group.name,
      platform: group.platform,
      rateMultiplier: Number.isFinite(rate) ? rate : null,
      peakEnabled: Boolean(group.peak_rate_enabled),
      peakMultiplier: group.peak_rate_multiplier ? Number(group.peak_rate_multiplier) : null,
      modelCount: models.length,
    })

    for (const model of models) {
      const key = normalizeModelKey(model.name)
      if (!key) continue
      const p = model.pricing || {}
      const off = model.official_pricing || {}
      const baseIn = perMtok(p.input_price)
      const baseOut = perMtok(p.output_price)
      // 计费形式由站点声明：token（按量）/ per_request（按次）/ image（按张）。
      // 以前完全没读这个字段，于是「按次计费」分组的模型被当成按 token 计价，
      // 比价页把 ¥X/次 当成 ¥X/百万 token 来比——量纲完全不同，结论必错
      const billingMode = p.billing_mode === 'per_request' || p.billing_mode === 'image' ? p.billing_mode : 'token'
      // 按次价：优先顶层；分档价（intervals）里带 per_request_price 的取第一档
      const tierCall = (Array.isArray(p.intervals) ? p.intervals : []).find(
        (row) => row && row.per_request_price !== null && row.per_request_price !== undefined,
      )?.per_request_price
      const callBaseRaw = p.per_request_price ?? tierCall ?? null
      const callMultiplier = billingMode === 'image' && imageIndependent ? imageMultiplier : multiplier
      const callPrice =
        callBaseRaw === null || !Number.isFinite(Number(callBaseRaw))
          ? null
          : Math.round(Number(callBaseRaw) * callMultiplier * 1000) / 1000
      const entry = {
        name: model.name,
        groupName: group.name,
        rateMultiplier: Number.isFinite(rate) ? rate : null,
        baseIn,
        baseOut,
        billingMode,
        // 按次单价（元/次，已按站点算法乘过倍率）；token 计费时为 null
        callPrice,
        callPriceTiered: p.per_request_price == null && tierCall != null,
        // 实际价 = 原价 × 倍率
        inPrice: baseIn === null ? null : Math.round(baseIn * multiplier * 1000) / 1000,
        outPrice: baseOut === null ? null : Math.round(baseOut * multiplier * 1000) / 1000,
        // 缓存读价：原价（未乘倍率）与实际价（乘倍率）都给，和 inPrice 同口径
        baseCacheRead: p.cache_read_price == null ? null : perMtok(p.cache_read_price),
        cacheReadPrice: p.cache_read_price == null ? null : perMtok(Number(p.cache_read_price) * multiplier),
        // 缓存写价：站点按它收「写入缓存」的钱，通常是输入价的 1.25 倍
        baseCacheWrite: p.cache_write_price == null ? null : perMtok(p.cache_write_price),
        cacheWritePrice: p.cache_write_price == null ? null : perMtok(Number(p.cache_write_price) * multiplier),
        // 官方价（站方声明，可能不准，仅供参考）
        officialIn: perMtok(off.input_price),
        officialOut: perMtok(off.output_price),
      }
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(entry)
    }
  }

  const byModel = new Map()
  for (const [key, list] of buckets) {
    const tally = new Map()
    for (const entry of list) {
      // 计费形式和价格一起进签名：同一个模型在「按次」分组和「按 token」分组
      // 是两条不同的供给，不能当成同一个价合并
      const sig = `${entry.billingMode}|${entry.baseIn}|${entry.baseOut}|${entry.callPrice}`
      const row = tally.get(sig) || { entry, count: 0 }
      row.count += 1
      tally.set(sig, row)
    }
    let best = list[0]
    let bestCount = 0
    for (const { entry, count } of tally.values()) {
      if (count > bestCount) {
        best = entry
        bestCount = count
      }
    }
    byModel.set(key, best)
  }

  const allEntries = [...buckets.values()].flat()

  return { byModel, groupList, allEntries }
}
