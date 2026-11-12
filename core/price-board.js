/**
 * 数据比价：把「同一模型到底该用哪家」算成一行人话。
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────────
 *
 * `pricing.js` 回答的是「每百万 token 多少钱」，`router.js` 回答的是「这一单派谁」。
 * 但用户真正反复问的是第三个问题：
 *
 *   「我这个模型，是不是该换一家？换到哪家？值不值得？」
 *
 * 这个问题的答案不在任何一个已有函数里——它需要同时看三样东西：
 *
 *   1. **每站收敛到一组**：一个站可能给同一个模型开 6 个分组（不同倍率），
 *      拿 6 条明细去比没有意义，要比的是「这个站最好能给到多少」。
 *   2. **领先幅度**：比第二名便宜多少。领先 4% 和领先 30% 是完全不同的决定。
 *   3. **有没有被验证过**：便宜但零探针 = 纸面便宜，是降智/限流的常见伪装。
 *
 * 本模块只做这三件事，输出纯数据，**不下「该不该切」的结论**——那是用户的判断，
 * 阈值是产品决策，写死在代码里等于用一套用户没同意的规则替他做决定。
 * 界面只陈述事实（便宜多少、测过几次），由人自己看。
 *
 * ── 全站 vs 智能决策 ────────────────────────────────────────────────
 *
 * 这个功能存在的理由是「看到底哪家实惠」，所以**默认统计全站**：不套忽略名单，
 * 只要站没暂停、供给没下线，就算进来。用户手动忽略一个模型，本意是「别拿它派活」，
 * 不是「别让我看见它的价格」——把价格藏起来恰好违背了这个页面的用途。
 *
 * 开关打开时切到「只统计参与智能决策的」：套 routeableOffers 那一份过滤，
 * 看到的就和决策页、网关派活完全一致。两个口径共用同一个入口函数，不各写一遍。
 *
 * 口径唯一性（项目踩过的最大的坑）：在役判定一律来自 `inventory.routeableOffers`，
 * 样本数一律来自 `score.js` 的评分表，本模块不自己判暂停、不自己数探针。
 *
 * ── 价格从哪来（2026-11-12 重定）─────────────────────────────────
 *
 * 实测发现 `offerCost`（benchmark × ratio）与站点真实扣费偏差极大——
 * 24 条可比供给里 23 条偏差 >30%，主因是它按「全新输入」算价，
 * 而实际 94.9% 的输入是缓存读（单价约输入价的 1/20）。
 *
 * 所以价格现在分两级，**每行都标出来源**：
 *
 *   1. `source: 'ledger'` —— 账单实测的 `effIn/effOut`（= baseIn × rate，不含缓存），
 *      跨天稳定，可用于排序与决策。
 *   2. `source: 'benchmark'` —— 没有账单时回落到 `offerCost`，语义是「挂牌价」，
 *      同样不含缓存，口径与 ledger 一级一致，但可能与实付有系统性偏差。
 *
 * **`paidPerMtok`（实付）只用于展示「我花了多少」，绝不参与排序**：
 * 它的值主要是缓存命中率的函数（实测同一条线价格不变、paidPerMtok 差 16 倍），
 * 拿它排序等于按「谁的缓存多」排名。
 */

import { offerCost, officialCost } from './pricing.js'
import { routeableOffers, modelIdentityKey } from './inventory.js'
import { ledgerForOffer } from './ledger-index.js'
import { ensureFx } from './fx.js'
import { backfillCacheReadSource } from './cache-price-backfill.js'

/**
 * 本模块的两种统计口径。
 *
 * 名字直接写在界面上（开关的两个状态），别改成 internal/external 这种用户看不懂的词。
 */
export const PRICE_BOARD_SCOPES = ['all', 'routed']

/** 开关缺省值：全站。用户要的是「看哪家实惠」，收窄口径必须是他主动选的。 */
export const PRICE_BOARD_SCOPE_DEFAULT = 'all'

/** 非法值一律回落到全站——不因为本地存了个脏值就把页面清空 */
export function normalizePriceBoardScope(value) {
  const v = String(value ?? '').trim().toLowerCase()
  return PRICE_BOARD_SCOPES.includes(v) ? v : PRICE_BOARD_SCOPE_DEFAULT
}

/**
 * 按口径取供给。
 *
 * 两个口径的差别只有一处：**要不要套「忽略模型」这一层**。
 * 暂停站 / 已下线两边都排除——那不是「用户的偏好」，是「这条线现在真的不通」，
 * 把它算进比价只会让结论变成假的。
 *
 * @param {object} db
 * @param {'all'|'routed'} scope
 * @returns {object[]} 供给数组（已排除暂停站与已下线）
 */
export function offersForScope(db, scope = PRICE_BOARD_SCOPE_DEFAULT) {
  const normalized = normalizePriceBoardScope(scope)
  if (normalized === 'routed') return routeableOffers(db)

  // 全站口径：只排除「暂停站」和「已下线」。刻意不走 routeableOffers，
  // 因为它还含一层忽略名单——那正是本口径要绕开的东西
  const paused = new Set((db.providers || []).filter((p) => p.paused).map((p) => p.id))
  return (db.offers || []).filter((offer) => {
    if (offer.delistedAt) return false
    if (paused.has(offer.providerId)) return false
    return true
  })
}

/**
 * 一个站给某个模型的最低价那一行。
 *
 * 同一个站可能给同一个模型开好几个分组（实测 rapid 对 gpt-6.1-sol 开了 6 个），
 * 对「哪家实惠」这个问题来说，它们只是同一个答案的不同报价——取最低的那条，
 * 其余条数只用来回答「这个站还有别的线吗」。
 */
/**
 * 生图模型判定。
 *
 * 为什么必须单独拦：生图按张计价（站点页面明码标价如 0.05/张），
 * 而账单里它也会有 token 数（提示词 + 少量输出）。拿 `花费 ÷ token` 去算
 * token 单价，会得到 26~37/Mtok 这种量纲错乱的数，在「谁最便宜」的排序里
 * 它会被排到最贵那一端，然后再也没人看它——而它其实可能最划算。
 *
 * 判定依据是名字特征而不是价格，因为价格本身不可比。宁可漏判（多进几行），
 * 也不能把正常模型误拦：这里的特征都是生图/视频模型独有的词。
 */
const IMAGE_MODEL_RE = /(^|[-_/])(image|imagen|dall-?e|flux|stable-?diffusion|sdxl|midjourney|seedream|kolors|wanx|hy-image|gpt-image|nano-?banana|imagine-video|veo|sora|kling|runway|pika)([-_/]|$)/i

function isImageModel(name) {
  const n = String(name || '')
  if (!n) return false
  return IMAGE_MODEL_RE.test(n)
}

function bestRowOfSite(rows) {
  let best = null
  for (const row of rows) {
    // 用 rankPrice（账单实测优先，估算兜底），不是 blended——
    // 后者已被实测证明与真实扣费偏差极大（96% 的供给偏 >30%）
    const p = row.price?.sortPrice
    if (p === null || p === undefined) continue
    if (best === null || p < (best.price?.sortPrice ?? Infinity)) best = row
  }
  return best
}

/**
 * 一行的「实测情况」——只看样本数，不做可信/不可信判定。
 *
 * 为什么不下判定：`samples=0` 不等于「不可信」，只等于「没证据」。这两件事
 * 在界面上必须是两句话，混成一句「可疑」会让用户以为我们测出了它有问题。
 *
 * @returns {{samples:number, probeSamples:number, trafficSamples:number, label:string}}
 */
function evidenceOf(score) {
  const probeSamples = Number(score?.samples) || 0
  const trafficSamples = Number(score?.trafficSamples) || 0
  const samples = probeSamples + trafficSamples
  return {
    samples,
    probeSamples,
    trafficSamples,
    // 给界面直接用的一句话，避免前端再拼一次（口径漂移高发区）
    label: samples === 0 ? '未实测' : `实测 ${samples} 次`,
  }
}

/**
 * 把一组合并后的模型行，算成「每站收敛 + 领先幅度 + 实测情况」。
 *
 * @param {object[]} offers 已按口径过滤好的供给
 * @param {object} settings db.settings
 * @param {object} benchmarks 基准价表
 * @param {Map<string,object>} scoreMap offerId → 评分（score.js 的输出）
 * @param {{providers?:object[], aliases?:object}} ctx 站名表与别名表
 * @returns {Array} 每个模型一条，按「领先幅度」降序
 */

/**
 * 一条供给的「价格答案」：把账单实测与估算合并成一个可排序的数。
 *
 * ── 为什么要有这个函数 ──────────────────────────────────────────
 *
 * 上层（排序、界面、决策）需要的是「这个模型在这条线上多少钱」一个数。
 * 但这个数有两个可能来源，且**必须标明用了哪个**——否则用户看到 0.09
 * 不知道是实测还是估算，就可能被一个偏了 20 倍的估算误导。
 *
 * ── 排序键怎么选 ──────────────────────────────────────────────
 *
 * 用 `effIn × w + effOut × (1-w)`，与 `offerCost.blendedCnyPerMtok` 同一条公式、
 * 同一个权重，**唯一区别是不含缓存**。这是刻意的：
 *
 *   - 挂单价（effIn/effOut、offerCost）都是「不含缓存」的口径，两者可直接比
 *   - 实付（paidPerMtok）含缓存效应，混进来会让排序变成「谁缓存多」
 *
 * ── 为什么不用 paidPerMtok 排序（实测）──────────────────────────
 *
 * 秋/国模-007/deepseek-v4.1-flash，7 天倍率恒 0.07、baseIn 恒 2（价格没变）：
 *   11-12 缓存 99% → paidPerMtok 0.0068
 *   11-06 缓存 43% → paidPerMtok 0.1116        差 16 倍
 * 拿它排序等于按缓存命中率排名，不是按价格排名。
 *
 * @returns {{source:string, effIn:number|null, effOut:number|null, rankPrice:number|null,
 *            paidPerMtok:number|null, rate:number|null, ledger:object|null}}
 */
function resolveLinePrice(cost, ledger, weight, fxRate = null) {
  // ── 价格口径：**一律以站点标价为准**（2026-11-12 定稿）──
  //
  // 排序、比价、路由全部用 `offerCost`（站点原价 × 站点倍率）。
  // 理由：网关实际扣费就是按这个口径算的——站点标价 × 倍率才是它真正收的钱。
  // 实测（账单 effIn）**不参与价格判定**，只用来校验标价是否与站点实际记账一致。
  //
  // 为什么实测不进排序（用户明确要求，且有实测依据）：
  //   · 账单反推本身有误差：同一天内站点调价会让反推出的原价失真
  //     （实测绿萝 GPT低价分组，账单反推 3.0987 vs 其他分组一致标 2.00）
  //   · 样本量小时噪音极大：claude-opus-4.8 只有 16 token 证据，
  //     反推价 0.25 却把 4 家有 1.4 估算价的挤成"更贵"
  //   · 分组名对不上时容易张冠李戴（已修，但说明这条链路本身就脆）
  //
  // 实测的正确定位：**校验器**。它回答「站点给我算的价对不对」，
  // 这个结论展示给用户（配 drift 差异清单），而不是拿去替代标价做决策。
  const inCny = cost.inCnyPerMtok ?? null
  const outCny = cost.outCnyPerMtok ?? null
  const price = cost.blendedCnyPerMtok ?? null

  // 实测只作为「校验证据」附在旁边，标明它与标价是否一致
  let verify = null
  if (ledger && ledger.effIn !== null && ledger.effIn !== undefined && inCny !== null && inCny > 0) {
    const effIn = Number(ledger.effIn)
    const diffPct = Math.round(((effIn - inCny) / inCny) * 1000) / 10
    // 币种误标判定（2026-11-12 增）：
    // 站点标价用的数字（如 2/10）与账单反推价差 6.69 倍左右时，
    // 几乎必然是「基准价的币种标错了」——把人民币价标成了 RUSD（或反之）。
    // 这个判定要单独给出：笼统说「不符 569%」用户看不出是币种问题。
    // 直接算比值，不要从 diffPct 反推：
    // diffPct 为负时（实测 < 标价），`|diffPct|/100 + 1` 给出的是 1.85，
    // 而真实比值是 0.15——反推公式只在 diffPct > 0 时成立，
    // 用它会让「标价虚高 6.69 倍」这类误标完全漏判（实测踩过）。
    const fxRatio = inCny > 0 ? effIn / inCny : null
    const invFxRatio = fxRatio !== null && fxRatio > 0 ? 1 / fxRatio : null
    // 用真实汇率判定（settings.fx.rates.CNY），不硬编码 6.69——
    // 汇率会变，写死会让判定在某天集体失效。
    // 容忍 ±15%：账单反推价本身有小误差，且汇率也在动。
    const fx = Number(fxRate) > 0 ? Number(fxRate) : null
    const near = (r) => fx !== null && Math.abs(r - fx) / fx <= 0.15
    const looksLikeCurrency =
      fx !== null && fxRatio !== null && (near(fxRatio) || (invFxRatio !== null && near(invFxRatio)))
    verify = {
      // 站点账单反推出的单价（不含缓存）——只用于核对，不替代标价
      effIn,
      effOut: ledger.effOut ?? null,
      rate: ledger.rate ?? null,
      // 与标价的偏差：0 表示站点记账与页面标价一致
      diffPct,
      // 偏差 >5% 视为「标价与账单不符」，界面要提示
      mismatch: Math.abs(diffPct) > 5,
      // 偏差 ≈ 6.69 倍 → 疑似基准价币种标错（RUSD/CNY 混淆），优先级高于 mismatch
      currencySuspect: looksLikeCurrency,
      // 样本量太小则偏差结论不可信
      thin: Boolean(ledger.thin),
      tokens: ledger.tokens ?? null,
      days: ledger.days ?? null,
    }
  }

  return {
    // 价格来源永远是站点标价
    source: 'benchmark',
    effIn: inCny,
    effOut: outCny,
    rankPrice: price,
    sortPrice: price,
    thin: false,
    // 实付：只展示「我花了多少」，不参与任何排序
    paidPerMtok: ledger?.paidPerMtok ?? null,
    verify,
    ledger: ledger || null,
  }
}

/**
 * 原厂输入价，换算成站内人民币口径。
 *
 * 为什么单独一个函数：`officialCost().in` 是**原币种原价**（RUSD 时是美元），
 * 而折扣比的分子（effIn）是站内人民币。两者直接相除会差 6.69 倍。
 *
 * 换算规则与 officialCost 内部完全一致（RUSD × fx，站内 USD/CNY 1:1），
 * 为了不把 fx 逻辑抄两遍，这里用「officialCost 的 blended 与其纯原价 blended 之比」
 * 反解出换算倍率——两者的权重与公式完全相同，比值就是纯汇率因子。
 */
function officialInCny(bench, settings) {
  const oc = officialCost(bench, settings)
  if (!oc || oc.in === null || oc.in === undefined) return null
  const peak = Number(oc.blendedCnyPerMtok)
  const rawIn = Number(oc.in)
  const rawOut = oc.out === null || oc.out === undefined ? rawIn : Number(oc.out)
  if (!Number.isFinite(peak) || !Number.isFinite(rawIn)) return null
  // blended(原币种) = in×w + out×(1-w)
  const w = Number.isFinite(Number(settings?.blendInputWeight))
    ? Math.min(Math.max(Number(settings.blendInputWeight), 0), 1)
    : 0.25
  const rawBlend = rawIn * w + rawOut * (1 - w)
  if (!(rawBlend > 0)) return null
  // 换算倍率 = 换算后 blended ÷ 原币种 blended（同公式，比值即纯汇率因子）
  const factor = peak / rawBlend
  if (!Number.isFinite(factor) || factor <= 0) return null
  return Math.round(rawIn * factor * 1e6) / 1e6
}

/**
 * 含缓存的估算价：按用户设定的缓存命中率，把缓存单价折进去。
 *
 * ── 为什么单独一个字段，不改 rankPrice ────────────────────────────
 *
 * `rankPrice`（纯挂牌价）是**站点属性**：两家标价多少，直接可比。
 * 而含缓存的价混进了「你的命中率」这个**用量属性**——它随客户端、任务类型变，
 * 不是这条供给的固有属性。拿它做排序，等于把用法习惯算成价格差异。
 *
 * 所以它是**并排展示的第二列**：让用户看到「缓存价能把挂牌价压到多少」，
 * 但排序仍按挂牌价。等用户确信命中率稳定，再自己去设置里把
 * blendCacheHitRate 打开让排序也吃它。
 *
 * ── 为什么没缓存价时要区分来源 ──────────────────────────────────
 *
 * 实测 158 条供给没填缓存价，但含义完全不同：
 *   'explicit-zero' 站点明确报 0     → 缓存真免费，按 0 算（估算价会大幅下降）
 *   'site-silent'   站点接口通了但没这字段 → 不知道，**按输入价算**（不假装有折扣）
 *   'no-source'     站点根本没有价格接口   → 同上，且界面要标「未公布」
 *
 * 不区分就会把「站点没公布」误导成「这家缓存贵」。
 *
 * @returns {{price:number|null, basis:string, note:string|null}}
 */
function priceWithCache(line, cost, offer, hitRate) {
  const h = Number(hitRate)
  if (!Number.isFinite(h) || h <= 0) {
    return { price: null, basis: 'off', note: null }
  }
  const rate = Math.min(Math.max(h, 0), 1)
  const inCny = line.effIn
  const outCny = line.effOut
  if (inCny === null || outCny === null) {
    return { price: null, basis: 'no-price', note: null }
  }
  const src = offer?.cacheReadSource || (cost.cacheReadCnyPerMtok === null ? 'no-source' : 'site-reported')
  // 站点明确报 0 → 缓存读真免费；其余缺值情况一律退回输入价（不假装有折扣）
  let cacheRead = cost.cacheReadCnyPerMtok
  if (src === 'explicit-zero') cacheRead = 0
  if (cacheRead === null || cacheRead === undefined) cacheRead = inCny
  const w = 0.25
  // 输入拆成命中/未命中两段；输出不受缓存影响
  const blendedIn = inCny * (1 - rate) + cacheRead * rate
  return {
    price: blendedIn * w + outCny * (1 - w),
    // 'site-reported' 有真实缓存价；其余三种是「不知道」的不同原因
    basis: src,
    note:
      src === 'explicit-zero' ? '站点明确无缓存费'
        : src === 'site-silent' ? '站点未公布缓存价，按输入价算'
          : src === 'no-source' ? '该站没有价格接口，缓存价未知'
            : null,
  }
}

/**
 * 折扣比：这条线是原厂价的几分之几。
 *
 * **分子分母必须同口径——都不含缓存。**
 * 用 paidPerMtok / officialCost 是错的：分子含缓存效应（可能只有挂牌价的 1/20），
 * 分母不含，算出来的「0.2%」毫无意义。
 *
 * @returns {number|null} 例如 0.045 表示 4.5%
 */
function discountRatio(effIn, officialIn) {
  const a = Number(effIn)
  const b = Number(officialIn)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null
  return Math.round((a / b) * 1e6) / 1e6
}

export function buildPriceBoard(offers, settings, benchmarks, scoreMap, ctx = {}) {
  const byModel = new Map()
  // 站名从 providers 取：offer 上只有 providerId，站名写在站点那一层。
  // 归一化用 inventory.modelIdentityKey（唯一实现），不在这里再写一份 trim。
  const siteName = new Map((ctx.providers || []).map((p) => [p.id, p.name]))
  const aliases = ctx.aliases || {}
  // 账单索引（可选）：有就优先用实测价，没有就退回估算
  const ledgerIndex = ctx.ledgerIndex || null
  // 汇率（唯一真源 fx 模块）：用于「币种疑似标错」的自动判定
  const fxRate = Number(ensureFx(settings || {}).rates?.CNY) || null
  // 存量供给没有 cacheReadSource（2026-11-12 前导入的），这里按已有数据回填，
  // 让界面能把「明确免费 / 未公布 / 无接口」分开显示。只改内存，不落盘。
  backfillCacheReadSource(offers, ctx.providers)
  // 含缓存估算用的命中率：**只影响展示那一列，不影响排序**。
  // 用户没设（blendCacheHitRate=0）时按 0.95 展示——实测全局缓存读占输入 94.9%，
  // 这是给用户看「缓存价能压到多少」的参考值，不是替他做决定。
  // 用户设了就按他的，没设（0/缺失）才用 0.95 作**展示**参考值。
  // 注意区分「用户明确要 0」与「没设过」：前者是想关掉缓存口径，
  // 后者是默认参考。但当前 UI 只有「0 = 关闭」这一种表达，且 0 会让
  // 含缓存列恒等于挂牌价（没有信息量），所以这里统一按 0.95 展示，
  // 并在界面注明「这是参考值，不改排序」。
  const rawHit = Number(settings?.blendCacheHitRate)
  const hitProvided = Number.isFinite(rawHit) && rawHit > 0
  const estimatedHitRate = hitProvided ? Math.min(rawHit, 1) : 0.95

  // 未定价供给：算不出价格 = 这个模型不会出现在比价表里。
  // 静默丢掉是危险的——用户会以为「我买的模型都在这」，实际少了一堆。
  // 所以收集起来由接口下发，界面明示「这些没价、所以没法比」。
  const unpriced = []

  for (const offer of offers || []) {
    const cost = offerCost(offer, settings, benchmarks)
    // 按次计费的供给与 token 口径量纲不同，塞进来会把「¥/M」和「¥/次」混着比
    if (cost.perCall) continue
    // 生图模型：按张计价，token 单价无意义（实测同一条线按 token 除会算出
    // 26~37/Mtok，把正常模型全挤下去）。它们的价格在站点页面有明确标价，
    // 不该进 token 比价表——留着只会让「谁最便宜」的结论失真。
    if (isImageModel(offer.upstreamName || offer.modelKey)) continue
    const ledger = ledgerIndex ? ledgerForOffer(ledgerIndex, offer) : null
    // 算不出价：记进 unpriced 而不是静默跳过。
    // 注意口径：这里**不**用账单价救场——按定稿口径，价格只认站点标价，
    // 账单只做校验。所以没标价就是没价，不能拿实测顶上（那会让
    // 「标价缺失」这个事实被掩盖成「有价」）。
    if (cost.blendedCnyPerMtok === null) {
      unpriced.push({
        offerId: offer.id,
        providerId: offer.providerId,
        providerName: siteName.get(offer.providerId) || null,
        group: offer.group || '',
        upstreamName: offer.upstreamName || '',
        modelKey: offer.modelKey || offer.upstreamName || '',
        // 为什么没价：站点没给价 / 基准价表缺这个模型
        reason: offer.benchmarkKey && !benchmarks?.[offer.benchmarkKey] ? 'no-benchmark' : 'no-price',
      })
      continue
    }

    const rawName = offer.modelKey || offer.upstreamName
    const key = modelIdentityKey(rawName, aliases) || rawName
    const price = resolveLinePrice(cost, ledger, settings?.blendInputWeight, fxRate)
    // 含缓存估算价：并排展示的第二列，不参与排序（理由见 priceWithCache 注释）
    const withCache = priceWithCache(price, cost, offer, estimatedHitRate)
    if (!byModel.has(key)) byModel.set(key, [])
    byModel.get(key).push({ offer, cost, ledger, price, withCache })
  }

  const boards = []
  for (const [modelKey, rows] of byModel) {
    // 先按站收敛：一个站一个报价（它最便宜的那条线）
    const bySite = new Map()
    for (const row of rows) {
      const pid = row.offer.providerId
      if (!bySite.has(pid)) bySite.set(pid, [])
      bySite.get(pid).push(row)
    }

    const sites = []
    for (const [providerId, siteRows] of bySite) {
      const best = bestRowOfSite(siteRows)
      if (!best) continue
      const score = scoreMap?.get(best.offer.id) || null
      const evidence = evidenceOf(score)
      sites.push({
        providerId,
        providerName: siteName.get(providerId) || null,
        group: best.offer.group || '',
        upstreamName: best.offer.upstreamName || '',
        // 这个站对这个模型一共开了几条线（含更贵的那些）
        lineCount: siteRows.length,
        ratio: best.offer.ratio ?? null,
        pricingMode: best.offer.pricingMode || 'manual',
        inCnyPerMtok: best.cost.inCnyPerMtok,
        outCnyPerMtok: best.cost.outCnyPerMtok,
        blendedCnyPerMtok: best.cost.blendedCnyPerMtok,
        // ---- 2026-11-12 增：价格来源与实测值 ----
        // source='ledger' 时 effIn/effOut/rankPrice 是站点账单实测；
        // source='benchmark' 时是 offerCost 估算（挂牌价口径）。
        // 界面必须显示 source，否则用户分不清实测和估算。
        priceSource: best.price?.source ?? 'benchmark',
        // 标价校验证据：账单反推单价 vs 标价的偏差（只用于提示，不改价格）
        verify: best.price?.verify ?? null,
        effIn: best.price?.effIn ?? null,
        effOut: best.price?.effOut ?? null,
        rankPrice: best.price?.rankPrice ?? best.cost.blendedCnyPerMtok,
        sortPrice: best.price?.sortPrice ?? null,
        thin: best.price?.thin ?? false,
        // 实付：只展示「我花了多少」，不参与排序（含缓存效应）
        paidPerMtok: best.price?.paidPerMtok ?? null,
        // ---- 含缓存估算价（2026-11-12）----
        // 按 estimatedHitRate 把缓存单价折进去的估算值。**不参与排序**，
        // 只和 rankPrice 并排展示，让用户看到「缓存价能压到多少」。
        priceWithCache: best.withCache?.price ?? null,
        // 缓存价来源：site-reported / explicit-zero / site-silent / no-source
        // 后两种是「不知道」，不能读成「这家没有缓存优惠」
        cachePriceBasis: best.withCache?.basis ?? null,
        cachePriceNote: best.withCache?.note ?? null,
        // 账单证据量
        ledgerTokens: best.price?.ledger?.tokens ?? null,
        ledgerDays: best.price?.ledger?.days ?? null,
        ledgerThin: best.price?.ledger?.thin ?? null,
        ledgerPriceChange: best.price?.ledger?.priceChange ?? null,
        // 该站其余线相对自己最低线的报价。
        // 不叫「更贵」：同站同价的两条线（实测 rapid 的 DeepSeek高缓组就是）
        // 会一条当最低、另一条落在这里，价格完全一样。字段只陈述「还有这些线、
        // 各多少钱」，贵不贵由前端拿 deltaPct 自己判断，别让字段名替数据下结论。
        otherLines: siteRows
          .filter((r) => r !== best && r.price?.sortPrice !== null && r.price?.sortPrice !== undefined && Number.isFinite(r.price.sortPrice))
          .sort((a, b) => a.price.sortPrice - b.price.sortPrice)
          .map((r) => ({
            group: r.offer.group || '',
            rankPrice: r.price.rankPrice,
            blendedCnyPerMtok: r.cost.blendedCnyPerMtok,
            priceSource: r.price.source,
            // 相对本站最低线贵多少（0 = 同价，只是另一条线）
            deltaPct:
              best.price?.rankPrice > 0
                ? Math.round(((r.price.rankPrice - best.price.rankPrice) / best.price.rankPrice) * 100)
                : null,
          })),
        evidence,
      })
    }

    if (sites.length === 0) continue
    // 按 rankPrice 排序（实测优先）。rankPrice 与 blended 同口径（都不含缓存），
    // 差别只在于前者可能来自账单实测、后者一定是估算。
    sites.sort((a, b) => (a.sortPrice ?? Infinity) - (b.sortPrice ?? Infinity))

    const cheapest = sites[0]
    const runnerUp = sites.length > 1 ? sites[1] : null
    // 领先幅度：比第二便宜的站低多少。只有一个站时没有「领先」这回事，给 null
    // ——不要给 0，0 会被读成「打平」，而真相是「没得比」。
    const leadPct =
      runnerUp && runnerUp.rankPrice > 0 && cheapest.rankPrice !== null
        ? Math.round(((runnerUp.rankPrice - cheapest.rankPrice) / runnerUp.rankPrice) * 1000) / 10
        : null

    boards.push({
      modelKey,
      // 展示名：优先用基准价表的公认写法，回落站上的写法
      display: benchmarks?.[modelKey]?.display || cheapest.upstreamName || modelKey,
      siteCount: sites.length,
      // 只有一个站供货 = 没得选。界面要能明确区分「你选了最便宜的」和「只有它能供」。
      comparable: sites.length > 1,
      cheapest,
      runnerUp,
      leadPct,
      // 差价绝对值（¥/M）：百分比在极低价模型上会失真，绝对值给一个参照
      leadAbsCny: runnerUp && runnerUp.rankPrice !== null && cheapest.rankPrice !== null
        ? Math.round((runnerUp.rankPrice - cheapest.rankPrice) * 1000) / 1000
        : null,
      official: benchmarks?.[modelKey] || null,
      // 官方有效成本（换算成站内人民币口径）+ 折扣比。
      // discountIn = 本站实测挂牌输入价 ÷ 原厂输入价，同口径（都不含缓存）。
      // 用 paidPerMtok 做分子是错的：它含缓存效应，会算出 0.x% 这种无意义的值。
      officialCost: (() => {
        const oc = officialCost(benchmarks?.[modelKey], settings)
        if (!oc || oc.blendedUsdPerMtok === null) return null
        return {
          in: oc.in,
          out: oc.out,
          currency: oc.currency,
          blendedCnyPerMtok: oc.blendedCnyPerMtok,
        }
      })(),
      // 折扣比：本站挂牌输入价 ÷ 原厂输入价（两者同为站内人民币口径）。
      // RUSD 原厂价要先乘汇率——这个汇率与 officialCost 用的是同一个真源，
      // 不在这里再写一份 fx 逻辑：用 blended 反推会引入浮点误差，
      // 所以直接从 officialCost 的 blended 反解出「换算倍率」是错的，
      // 正确做法是让 officialCost 把「换算后的原价」也返回出来（见下）。
      // 折扣比：本站标价输入单价 ÷ 原厂输入价（同口径，都不含缓存）。
      // cheapest.effIn 现在是站点标价口径（offerCost），不是账单实测——
      // 因为网关实际扣费按标价走，折扣比要回答的是「标价是原厂几折」。
      discountIn: (() => {
        const oc = officialInCny(benchmarks?.[modelKey], settings)
        if (oc === null) return null
        return discountRatio(cheapest.effIn, oc)
      })(),
      sites,
      // 全部线路（站 × 分组），按价格升序。展开时画的就是这一份：
      // 「每站收敛」回答「哪家实惠」，这一份回答「具体每条线多少钱」。
      // 两件事都要，但默认只显示前者——106 个模型全展开是没法看的。
      allLines: (() => {
        // 同一个站可能用两个 Key 拉回同一个分组的同一个模型（实测秋的
        // 「国模-0055 p哥」就有两条，价格完全一样）。明细表里并排两行一模一样
        // 的数据只会让人以为看错了——按「站 + 分组 + 价格」去重，保留证据多的那条。
        const seen = new Map()
        for (const r of rows) {
          const score = scoreMap?.get(r.offer.id) || null
          const line = {
            providerId: r.offer.providerId,
            providerName: siteName.get(r.offer.providerId) || null,
            group: r.offer.group || '',
            upstreamName: r.offer.upstreamName || '',
            ratio: r.offer.ratio ?? null,
            pricingMode: r.offer.pricingMode || 'manual',
            inCnyPerMtok: r.cost.inCnyPerMtok,
            outCnyPerMtok: r.cost.outCnyPerMtok,
            blendedCnyPerMtok: r.cost.blendedCnyPerMtok,
            // 价格来源（2026-11-12）：实测 or 估算，界面必须显示
            priceSource: r.price?.source ?? 'benchmark',
            verify: r.price?.verify ?? null,
            effIn: r.price?.effIn ?? null,
            effOut: r.price?.effOut ?? null,
            rankPrice: r.price?.rankPrice ?? r.cost.blendedCnyPerMtok,
            sortPrice: r.price?.sortPrice ?? null,
            thin: r.price?.thin ?? false,
            paidPerMtok: r.price?.paidPerMtok ?? null,
            priceWithCache: r.withCache?.price ?? null,
            cachePriceBasis: r.withCache?.basis ?? null,
            cachePriceNote: r.withCache?.note ?? null,
            ledgerTokens: r.price?.ledger?.tokens ?? null,
            ledgerDays: r.price?.ledger?.days ?? null,
            ledgerThin: r.price?.ledger?.thin ?? null,
            ledgerPriceChange: r.price?.ledger?.priceChange ?? null,
            evidence: evidenceOf(score),
          }
          const key = `${line.providerId}|${line.group}|${line.rankPrice}`
          const prev = seen.get(key)
          if (!prev || line.evidence.samples > prev.evidence.samples) seen.set(key, line)
        }
        return [...seen.values()].sort((a, b) => (a.sortPrice ?? Infinity) - (b.sortPrice ?? Infinity))
      })(),
    })
  }

  // 排序：有得比的排前面（那才是「哪家实惠」的答案），没得比的沉底；
  // 同组内按领先幅度降序——领先越大越值得看
  boards.sort((a, b) => {
    if (a.comparable !== b.comparable) return a.comparable ? -1 : 1
    if (a.comparable && b.comparable) {
      const la = a.leadPct ?? -1
      const lb = b.leadPct ?? -1
      if (la !== lb) return lb - la
    }
    return String(a.display).localeCompare(String(b.display))
  })

  // 返回值带 unpriced：老调用方拿 `.boards` 或直接把整个对象当数组用的都要兼容，
  // 所以这里返回一个**数组本身**（保留 forEach/length 等），
  // 同时把 unpriced 挂成它的属性——`boards.unpriced`。
  // 这样 `buildPriceBoard(...).length` 和 `buildPriceBoard(...).unpriced` 都能用。
  boards.unpriced = unpriced
  return boards
}

/**
 * 顶部那句总结。只陈述事实，不给建议。
 *
 * @returns {{comparable:number, single:number, total:number, text:string}|null}
 */
export function priceBoardSummary(boards) {
  const total = boards.length
  if (total === 0) return null
  const comparable = boards.filter((b) => b.comparable).length
  const single = total - comparable
  return {
    total,
    comparable,
    single,
    text:
      comparable === 0
        ? `${total} 个模型全部只有一家供货，暂时没有可比的`
        : `${comparable} 个模型有跨站可比，${single} 个只有一家供货`,
  }
}

/**
 * 手动价格对比：把「基准模型」与任意多个对象解析成一行价格。
 *
 * 三种对象（用户 2026-11-12 明确要求「都做」）：
 *   model:<key>    另一个模型，取它在全站的最低价
 *   site:<id>      某个站点，取该站所有模型最低价的中位数（代表站点整体价位）
 *   official:<key> 基准价表的原厂有效成本（换算已由 officialCost 完成）
 *
 * 口径铁律：**前端不碰汇率**。所有价格都从后端已算好的数字里取，
 * 尤其官方价——再乘一次 6.69 就会重复换算。
 *
 * 站点取中位数而不是最低价：一个站有便宜国产模型不代表整体便宜，
 * 中位数更能回答「这个站的价位」。这是产品判断，不是数学结论。
 *
 * @param {object} compareOptions 后端构造的可选项清单
 * @param {Array} boards buildPriceBoard 的输出
 * @param {{base:string|null, tokens:string[]}} selection
 * @returns {{base:object|null, rows:Array}}
 */
export function buildPriceCompare(compareOptions, boards, selection = {}) {
  const opts = compareOptions || { models: [], sites: [], officials: [] }
  const baseKey = selection.base || boards?.[0]?.modelKey || null
  const baseBoard = (boards || []).find((b) => b.modelKey === baseKey)
  const basePrice = baseBoard?.cheapest?.rankPrice ?? null

  const sitePriceOf = (siteId) => {
    const prices = (boards || [])
      .flatMap((b) => (b.sites || [])
        .filter((s) => s.providerId === siteId)
        .map((s) => s.rankPrice))
      .filter((p) => p !== null && p !== undefined)
      .sort((a, b) => a - b)
    if (prices.length === 0) return null
    const mid = Math.floor(prices.length / 2)
    return prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2
  }

  const resolve = (token) => {
    if (typeof token !== 'string') return null
    const i = token.indexOf(':')
    if (i < 0) return null
    const kind = token.slice(0, i)
    const key = token.slice(i + 1)
    if (kind === 'model') {
      const m = (opts.models || []).find((x) => x.key === key)
      return m ? { label: m.label, price: m.price, kind: 'model' } : null
    }
    if (kind === 'site') {
      const st = (opts.sites || []).find((x) => x.id === key)
      return st ? { label: st.label, price: sitePriceOf(key), kind: 'site' } : null
    }
    if (kind === 'official') {
      const o = (opts.officials || []).find((x) => x.key === key)
      return o ? { label: o.label, price: o.price, kind: 'official', currency: o.currency } : null
    }
    return null
  }

  const rows = []
  if (baseBoard && basePrice !== null) {
    rows.push({ label: baseBoard.display || baseBoard.modelKey, price: basePrice, kind: 'base' })
  }
  for (const token of selection.tokens || []) {
    const r = resolve(token)
    if (r && r.price !== null) rows.push(r)
  }
  return { base: baseBoard ? { label: baseBoard.display || baseBoard.modelKey, price: basePrice } : null, rows }
}
