/**
 * 免费池的共用工具：判定、拆分、模型名前缀。
 *
 * 三条硬边界（见 docs/free-api-plan.md）：
 *   1. 免费供给在**数据入口**被切断，不靠渲染层过滤
 *   2. 免费池耗尽就报错，回落付费必须显式开开关
 *   3. 免费模型的可信门槛不低于付费模型
 *
 * 这里只做「判定与切分」，不含排序与配额——那是 rank-free.js 的事。
 */
import { resolveOfferPrice } from './pricing.js'

/** 网关里表示「走免费池」的模型名前缀 */
export const FREE_PREFIX = 'free/'

/** 免费池的专用入口前缀（`/free/v1/...`） */
export const FREE_BASE_PATH = '/free'

/**
 * 判断一条供给是不是免费的。
 *
 * 判据是**解析后的实际价 === 0**，不是原价 0：
 *   - 实际价 = 原价 × 分组倍率，倍率为 0 时原价不为 0 但实际免费
 *   - 反过来有些站把原价写成 0.000001，那不是免费，不能设容差放进来
 */
export function isFreeOffer(offer, benchmarks = {}) {
  if (!offer) return false

  // 按次计费（priceUnit='per_call'）：inPrice 即每次请求的价格，倍率与基准价
  // 都不参与换算——每次 0 元就是免费
  if (offer.priceUnit === 'per_call') {
    return Number(offer.inPrice) === 0
  }

  // 倍率为 0：pricing.js 的 resolveOfferPrice 要求 ratio > 0 才走倍率换算，
  // 0 会回落到手填价，所以这里单独识别一次。
  //
  // 注意：不能直接 Number(offer.ratio)——null 会被转成 0，把「没设倍率」误判成「倍率 0」，
  // 结果所有手填价的供给都被算成免费。
  const rawRatio = offer.ratio
  const hasRatio = rawRatio !== null && rawRatio !== undefined && rawRatio !== ''
  const ratio = hasRatio ? Number(rawRatio) : NaN
  const key = offer.benchmarkKey || offer.modelKey || offer.upstreamName
  if (Number.isFinite(ratio) && ratio === 0 && benchmarks[key]) return true

  const price = resolveOfferPrice(offer, benchmarks)
  return price.inPrice === 0 && price.outPrice === 0
}

/**
 * 把供给按付费/免费拆开。比价与决策只用 paid，免费池只用 free。
 * @returns {{paid:Array, free:Array}}
 */
export function splitOffers(offers, benchmarks = {}) {
  const paid = []
  const free = []
  for (const offer of offers || []) {
    if (isFreeOffer(offer, benchmarks)) free.push(offer)
    else paid.push(offer)
  }
  return { paid, free }
}

/**
 * 解析客户端传来的模型名。
 *   'free/deepseek-v4.1-flash' → { isFree: true,  model: 'deepseek-v4.1-flash' }
 *   'deepseek-v4.1-flash'      → { isFree: false, model: 'deepseek-v4.1-flash' }
 */
export function parseFreeModel(name) {
  const raw = String(name ?? '').trim()
  if (raw.toLowerCase().startsWith(FREE_PREFIX)) {
    return { isFree: true, model: raw.slice(FREE_PREFIX.length).trim() }
  }
  return { isFree: false, model: raw }
}

/** 给模型名加上免费前缀，用于 `/v1/models` 里区分来源 */
export function withFreePrefix(model) {
  return `${FREE_PREFIX}${model}`
}

/**
 * 一个请求最终走哪个池。
 *
 *   isFree = 模型名带 free/ 前缀 || 入口路径是 /free/v1
 *
 * 前缀只能把请求「升级」到免费池，不能降级回付费——所以不存在歧义。
 */
export function resolvePool({ pathname = '', model = '' } = {}) {
  const byPath = String(pathname).startsWith(`${FREE_BASE_PATH}/`)
  const parsed = parseFreeModel(model)
  return { isFree: byPath || parsed.isFree, model: parsed.model }
}
