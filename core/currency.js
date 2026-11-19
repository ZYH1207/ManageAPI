/**
 * 币种：全库唯一真源。
 *
 * 这里有两个必须分开的概念。此前它们混在 offer.currency 一个字段里（既当
 * 「站点报价的币种」、又当「基准价表的币种」），于是出现「美元价被标成人民币、
 * 比价便宜 6.68 倍」这类错钱问题：
 *
 *   provider.currency      站点钱包／余额的币种 —— 充值、余额展示用（人民币站很常见）
 *   provider.priceCurrency 站点价目表的币种     —— 广场 / channels 报价的口径
 *
 * 价目表到底是美元还是人民币，**不看猜、看证据**（见 inferSiteCurrency）：
 * 中转站标价最常见的形态是「官方价 × 倍率」，供给上又同时存着倍率和手填价，
 * 那么 `手填价 ≈ 基准价 × 倍率` 成立时，两边就是同一个币种；若差一个汇率才成立，
 * 就是另一个币种。一条证据都不成立时保持原样（历史数据里 CNY 与 USD 都有，
 * 静默翻转等于凭一个猜测改掉整站的钱）。
 *
 * 用户单条手改过币种的供给记 currencySource='custom'，自动落价不覆盖。
 */

/** 价目表允许的币种。历史脏值（`RUSD`、空串、小写）一律归一到下面两个之一。 */
export const PRICE_CURRENCIES = ['USD', 'CNY']

/** 判定用：两条价格算「相等」的相对容差（中转站会把 0.15 写成 0.15x） */
const SAME_TOLERANCE = 0.05

/**
 * 任何来源的币种值 → 'USD' | 'CNY'。
 * 空值和脏值都当美元：内部比较口径是「美元 / 每百万 token」，认错方向的代价最小。
 */
export function normalizeCurrency(value) {
  return String(value ?? '').trim().toUpperCase() === 'CNY' ? 'CNY' : 'USD'
}

/**
 * 站点级**显式**声明的价目表币种；没声明返回 null。
 *
 * 返回 null 而不是 'USD' 是有意的：null 表示「还没定」，由 inferSiteCurrency
 * 去数据里找证据，找不到就沿用供给自己的币种（存量数据不动）。
 */
export function declaredPriceCurrency(provider) {
  const raw = String(provider?.priceCurrency ?? '').trim().toUpperCase()
  return raw === 'USD' || raw === 'CNY' ? raw : null
}

/** 基准价条目 → 它的币种（缺字段按美元）。 */
function benchmarkCurrency(entry) {
  return normalizeCurrency(entry?.currency)
}

function closeEnough(a, b, tolerance = SAME_TOLERANCE) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return false
  return Math.abs(a - b) / b <= tolerance
}

/**
 * 从站点自己的供给数据里推断价目表币种。
 *
 * 证据只有一种，但很硬：供给同时存了「倍率」和「手填价」时，两者与基准价的关系
 * 能反推出数字是用什么币种写的——
 *
 *   手填价 ≈ 基准价 × 倍率          → 与基准价同币种
 *   手填价 ≈ 基准价 × 倍率 ÷ 汇率   → 与基准价相反（美元 ↔ 人民币）
 *
 * 例：基准价 9（元）、倍率 0.15、手填价 1.35 → 9×0.15=1.35 ✓ 人民币；
 *     手填价 0.1875 → 9×0.15÷7.2=0.1875 ✓ 美元。
 *
 * 只看单条价格的数量级是不够的：中转站普遍打 2%–15% 的折，同一串数字既可能是
 * 「人民币打 15%」也可能是「美元打 2%」，两种解释都合理，靠数量级判会瞎猜。
 *
 * @param {object[]} offers 该站点的供给
 * @param {Record<string, object>} benchmarks 基准价表
 * @param {number} fx 人民币/美元汇率
 * @returns {{currency: 'USD'|'CNY'|null, votes: number, total: number, samples: object[]}}
 */
export function inferSiteCurrency(offers, benchmarks = {}, fx = 7.2) {
  const rate = Number.isFinite(Number(fx)) && Number(fx) > 0 ? Number(fx) : 7.2
  const votes = { USD: 0, CNY: 0 }
  const samples = []
  let total = 0
  for (const offer of offers || []) {
    if (offer.priceUnit === 'per_call') continue
    const price = Number(offer.inPrice)
    const ratio = Number(offer.ratio)
    if (!Number.isFinite(price) || price <= 0) continue
    if (!Number.isFinite(ratio) || ratio <= 0) continue
    const key = offer.benchmarkKey || offer.modelKey || offer.upstreamName
    const bench = benchmarks?.[key]
    const benchIn = Number(bench?.in)
    if (!Number.isFinite(benchIn) || benchIn <= 0) continue
    const benchCur = benchmarkCurrency(bench)
    const same = benchIn * ratio
    const flipped = same / rate
    total += 1
    if (closeEnough(price, same)) {
      votes[benchCur] += 1
      samples.push({ key, currency: benchCur, price, expected: same, by: 'same' })
    } else if (closeEnough(price, flipped)) {
      const other = benchCur === 'CNY' ? 'USD' : 'CNY'
      votes[other] += 1
      samples.push({ key, currency: other, price, expected: flipped, by: 'flipped' })
    }
  }
  // 一条证据就定整站的币种太冒险（可能是某条行手工算错了），要两条以上且过半
  const leader = votes.CNY >= votes.USD ? 'CNY' : 'USD'
  const lead = votes[leader]
  const confident = lead >= 2 && lead / Math.max(1, lead + votes[leader === 'CNY' ? 'USD' : 'CNY']) >= 0.6
  return {
    currency: confident ? leader : null,
    votes: lead,
    total,
    samples: samples.slice(0, 5),
  }
}

/**
 * 一条供给的 inPrice/outPrice 该按什么币种解释。
 *
 * 单条手改过（currencySource='custom'）用它自己的；站点声明过就用站点的；
 * 否则用这条供给自己记的币种（存量数据保持原样，不静默翻转）。
 * **所有写入口都应该用这个函数**，别再各处 `=== 'USD' ? 'USD' : 'CNY'`
 * 各写一套默认值——写入口的默认值和读入口的默认值一旦不一致，就会把价格
 * 按错币种落库。
 */
export function currencyOf(offer, provider) {
  if (offer?.currencySource === 'custom') return normalizeCurrency(offer.currency)
  return declaredPriceCurrency(provider) || normalizeCurrency(offer?.currency)
}
