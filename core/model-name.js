/**
 * 模型名的「是不是同一个模型」判定。
 *
 * 现实：同一个模型，每个中转站写法都不一样——
 *   deepseek-v4.1-flash / deepseek-4.1-flash / DeepSeek V4.1 Flash（空格）
 *   anthropic/claude-opus-4-5-20251101 / claude-opus-4.5 / claude-opus-4-5
 * 以前只有 normalizeModelKey 那一层（小写 + 去厂牌前缀 + 去 -free），剩下的靠人工。
 * 于是同一个模型在比价页被拆成两三行，网关里变成两三个「不同的模型」，
 * 探针、评分、用量也各算一套——看着像两个模型，其实是同一份供给。
 *
 * 这里把「归一」拆成三层，每层只干一件事，口径唯一：
 *   1. modelBaseKey      —— 存储键口径（大小写 / 空白 / 厂牌前缀 / -free），等于老的 normalizeModelKey
 *   2. canonicalModelKey —— 同一个模型的**形状**归一：版本分隔符 4-5 ↔ 4.5、v 前缀 v4.1 ↔ 4.1、
 *                           日期尾巴 -20251101 / -0813。纯规则、可解释、不做任何语义猜测
 *   3. identityKey       —— 在 2 的基础上再叠上用户手动的别名（合并 / 拆开）
 *
 * **只做形状归一，不做语义猜测**：-thinking / -preview / -hc / -highspeed 这类尾巴
 * 既可能是同一个模型的不同叫法，也可能是真的不同型号（-highspeed 通常贵一倍）。
 * 静默合并比不合并更危险——它会让比价把 10 倍价差藏起来，让路由把请求发给错的模型。
 * 所以这类只由 mergeOverview() 列成「疑似」建议，由用户点一下才合并。
 */

/** 厂牌前缀：anthropic/claude-opus-4-5 → claude-opus-4-5 */
const RE_VENDOR = /^[a-z0-9_.-]+\//
/** 免费后缀：站点常把免费档写成 glm-5.3:free / glm-5.3-free */
const RE_FREE = /[-:]free$/
/** 8 位日期戳：-20250929 / -20251101。允许夹在中间（-20251101-thinking 很常见） */
const RE_DATE = /-(?:19|20)\d{6}(?=-|$)/
/** 带横线的日期：-2024-11-20 */
const RE_ISO_DATE = /-(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?=-|$)/
/**
 * 4 位月日戳：-0813 / -1017 / -0613。
 * **不进自动归一的形状规则**——4 位数字太容易是别的东西（尺寸 1024、参数 4090、
 * 版本 1106）。它只进 looseModelKey，走「疑似同一个」让人点确认。
 */
const RE_SHORT_DATE = /-(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?=-|$)/
/** 版本号分隔符：4-5 → 4.5（前后有别的数字就不是版本号，别把日期拆坏） */
const RE_VERSION_SEP = /(?<!\d)(\d)[-_](\d)(?!\d)/g
/** v 前缀：deepseek-v4.1 → deepseek-4.1 */
const RE_VERSION_V = /(^|[-_])v(\d)/g

/** 装饰尾巴（合并建议用）：多数只是同一个模型的另一种叫法，但也可能不是 */
const RE_DECOR = /-(?:thinking|preview|latest|beta|exp|hc)$/
/** 速率档尾巴：官方通常单独计价，合并前必须看清价格 */
const RE_SPEED = /-(?:highspeed|ultraspeed)$/

/**
 * 第一层：存储键口径。
 * 站点同步、去重、忽略列表、手动排序都用它——所以它必须稳定，改动要连带迁移。
 */
export function modelBaseKey(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(RE_VENDOR, '')
    .replace(RE_FREE, '')
    .trim()
}

/**
 * 第二层：同一个模型的形状归一（纯规则）。
 * 只处理「同一个字符串的两种写法」，不涉及任何关于模型本身的推断：
 *   deepseek-v4.1-flash          → deepseek-4.1-flash
 *   claude-opus-4-5-20251101     → claude-opus-4.5
 *   claude-opus-4.5              → claude-opus-4.5
 * 循环几轮是因为尾巴可能叠着（-thinking-20251101 / -20251101-thinking）。
 */
export function canonicalModelKey(name) {
  let s = modelBaseKey(name)
  if (!s) return ''
  for (let round = 0; round < 4; round += 1) {
    const before = s
    s = s
      .replace(RE_DATE, '')
      .replace(RE_ISO_DATE, '')
      .replace(RE_VERSION_SEP, '$1.$2')
      .replace(RE_VERSION_V, '$1$2')
    if (s === before) break
  }
  return s.replace(/[-_]+/g, '-').replace(/^-+|-+$/g, '')
}

function has(map, key) {
  return Boolean(map) && Object.prototype.hasOwnProperty.call(map, key)
}

/**
 * 身份键缓存：routeableOffers / 比价 / 网关清单每个请求都会走一遍，
 * 几百条供给 × 一串正则重复算没有意义。按「别名表对象 + 原始名」缓存，
 * 别名表是 db.settings 里那个对象，改写时整张表会换新对象，缓存自然失效。
 */
const identityCache = new WeakMap()

/**
 * 第三层：最终身份键 = 形状归一 + 用户别名。
 *
 * 别名表的语义（键是 modelBaseKey，值是**原样保存的目标键**）：
 *   { 'hy4': 'hy4-preview' }              —— 合并：hy4 归到 hy4-preview
 *   { 'claude-opus-4-5': 'claude-opus-4-5' } —— 拆开：这一条就归它自己，不参与形状归一
 * 值不做二次归一化——「拆开」正是要一个不规范的名字自成一档，再归一次就白拆了。
 */
export function identityKey(name, aliases = {}) {
  const base = modelBaseKey(name)
  if (!base) return ''
  const table = aliases && typeof aliases === 'object' ? aliases : null
  if (table) {
    let cache = identityCache.get(table)
    if (!cache) {
      cache = new Map()
      identityCache.set(table, cache)
    }
    const hit = cache.get(base)
    if (hit !== undefined) return hit
    const key = computeIdentity(base, table)
    cache.set(base, key)
    return key
  }
  return computeIdentity(base, null)
}

/**
 * 「拆开」用的自成一档前缀。
 *
 * 为什么不能简单地写成 `别名[名字] = 名字`：拆开 deepseek-4.1-flash 时，
 * 另一个写法 deepseek-v4.1-flash 的归一键**正好等于**这个名字，两者又会撞回一组
 * （实测踩过）。所以拆开要把身份键放到形状归一永远产生不出来的命名空间里
 * ——归一键只由 [a-z0-9.-_] 组成，`~` 开头不可能撞车。
 */
export const SPLIT_PREFIX = '~'

/** 身份键是不是「用户拆开」的档 */
export function isSplitKey(key) {
  return String(key || '').startsWith(SPLIT_PREFIX)
}

function computeIdentity(base, aliases) {
  // 拆开键必须幂等：它本身就在 ~ 命名空间里，再归一会把 4-5 改成 4.5，
  // 于是「同一条供给的旧键/新键」算出两个不同结果（实测会丢手动排序）
  if (isSplitKey(base)) return base
  // 没有用户决定 → 纯规则归一。**归一结果不再去查别名表**：
  // 归一键是「一族写法共用的键」，如果拿它再查一次别名，一条 deepseek-4.1-flash
  // 的拆开决定会把所有能归一到这个键的写法（deepseek-v4.1-flash）一起拖走——
  // 实测就是「拆了等于没拆」。别名只对**用户写下的那个名字**生效。
  if (!aliases || !has(aliases, base)) return canonicalModelKey(base) || base
  let key = String(aliases[base])
  // 别名可以串（a→b→c），但要防环
  const seen = new Set([base, key])
  for (let i = 0; i < 8; i += 1) {
    if (!key || isSplitKey(key) || !has(aliases, key)) break
    const next = String(aliases[key])
    if (!next || next === key || seen.has(next)) break
    seen.add(next)
    key = next
  }
  // 别名值是「人写的名字」，最后再归一次，保证合并目标与规则键同一个命名空间；
  // 拆开值（~ 前缀）原样返回，那是刻意的非规范键
  return isSplitKey(key) ? key : canonicalModelKey(key) || key
}

/**
 * 宽松键（只给「合并建议」用）：在形状归一之上再剥掉装饰尾巴、速率档、月日戳，
 * 看有没有「该合并却没合」的。这些都不自动合并——-highspeed 可能真的更贵，
 * -1024 可能是尺寸而不是日期，让人点一下确认比猜错强。
 */
export function looseModelKey(name) {
  let s = canonicalModelKey(name)
  if (!s) return ''
  for (let round = 0; round < 3; round += 1) {
    const before = s
    s = s.replace(RE_DECOR, '').replace(RE_SPEED, '').replace(RE_SHORT_DATE, '')
    if (s === before) break
  }
  return s.replace(/[-_]+/g, '-').replace(/^-+|-+$/g, '')
}

/** 名字里带速率档后缀（highspeed / ultraspeed）——合并前要提醒价格可能不同 */
export function looksLikeSpeedVariant(name) {
  return RE_SPEED.test(modelBaseKey(name)) || RE_SPEED.test(canonicalModelKey(name))
}

/**
 * 从一组同义写法里挑一个「展示名」。
 *
 * 分组键用归一键（稳定、不随站点写法变），但**给人看的那一行**要挑个像样的名字：
 * 直接把 deepseek-v4-pro 显示成 deepseek-4-pro，用户会以为工具把模型名弄坏了。
 * 优先顺序（前一条压倒后一条）：
 *   1. 在官方参考价 / 基准价表里的（那就是公认写法）
 *   2. 用的人多的（多数派的写法最可能是站点的通用叫法）
 *   3. 本身就是归一键的（没经历过形状改写）
 *   4. 不带日期戳、不带 v 前缀的（读起来更干净）
 *   5. 字典序兜底（结果确定，不会每次刷新跳）
 *
 * @param {string[]} names 同一组里的原始写法，**可以重复**——重复次数就是票数
 */
export function pickDisplayName(names, official = null) {
  const counts = new Map()
  for (const raw of names || []) {
    const name = modelBaseKey(raw)
    if (!name) continue
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  if (counts.size === 0) return ''
  if (counts.size === 1) return [...counts.keys()][0]
  const officialSet = official instanceof Set ? official : new Set(official || [])
  const score = (name, count) => [
    officialSet.has(name) ? 1 : 0,
    count,
    canonicalModelKey(name) === name ? 1 : 0,
    !RE_DATE.test(name) && !RE_ISO_DATE.test(name) && !RE_SHORT_DATE.test(name) ? 1 : 0,
    !RE_VERSION_V.test(name) ? 1 : 0,
  ]
  const rank = (a, b) => {
    const sa = score(a, counts.get(a))
    const sb = score(b, counts.get(b))
    for (let i = 0; i < sa.length; i += 1) {
      if (sa[i] !== sb[i]) return sb[i] - sa[i]
    }
    return a.localeCompare(b)
  }
  return [...counts.keys()].sort(rank)[0]
}

/** 一组写法里的「多数派」（行内标少数派写法用：多数派不值得每行重复一遍） */
export function dominantName(names) {
  const counts = new Map()
  for (const raw of names || []) {
    const name = modelBaseKey(raw)
    if (!name) continue
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  let best = ''
  let bestCount = -1
  for (const [name, count] of counts) {
    if (count > bestCount || (count === bestCount && name < best)) {
      best = name
      bestCount = count
    }
  }
  return best
}

/**
 * 合并总览：给界面用。
 *
 *   groups      —— 已经（按规则或别名）归到同一个身份键下的多个名字
 *   suggestions —— 宽松键相同、但身份键不同的名字组：疑似同一个模型，等用户决定
 *
 * @param {Array<string|{name:string}>} names 原始模型名（可重复，内部去重并计数）
 * @param {object} aliases 用户别名表
 */
export function mergeOverview(names, aliases = {}, official = null) {
  const byIdentity = new Map() // identity → Map(base → 出现次数)
  for (const item of names || []) {
    const raw = typeof item === 'string' ? item : item?.name
    const base = modelBaseKey(raw)
    if (!base) continue
    const id = identityKey(base, aliases)
    if (!byIdentity.has(id)) byIdentity.set(id, new Map())
    const members = byIdentity.get(id)
    members.set(base, (members.get(base) || 0) + 1)
  }

  const groups = []
  for (const [id, members] of byIdentity) {
    if (members.size < 2) continue
    groups.push({
      id,
      // 展示名：官方写法优先。路由/比价按 id，不按 display，所以两者可以不同
      display: pickDisplayName([...members.keys()], official),
      members: [...members.entries()]
        .map(([name, count]) => ({ name, sites: count }))
        .sort((a, b) => b.sites - a.sites || a.name.localeCompare(b.name)),
      // 有成员被用户显式指到这个 id 上，说明是手动合并的
      manual: [...members.keys()].some((name) => has(aliases, name) && String(aliases[name]) === id),
    })
  }
  groups.sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id))

  // 疑似：宽松键把名字剥到「同一族」，但形状归一之后仍是不同身份
  const byLoose = new Map() // loose → Map(identity → true)
  for (const [id, members] of byIdentity) {
    // 用户手动拆开的不进建议：刚拆完就被劝「合回去吧」是很烦的
    if (isSplitKey(id)) continue
    for (const name of members.keys()) {
      const loose = looseModelKey(name)
      if (!loose) continue
      if (!byLoose.has(loose)) byLoose.set(loose, new Map())
      byLoose.get(loose).set(id, true)
    }
  }
  const suggestions = []
  for (const [loose, ids] of byLoose) {
    if (ids.size < 2) continue
    const members = []
    let speed = false
    for (const [id, names] of [...byIdentity].filter(([key]) => ids.has(key))) {
      for (const name of names.keys()) {
        members.push({ name, id, sites: names.get(name) })
        if (looksLikeSpeedVariant(name)) speed = true
      }
    }
    suggestions.push({
      loose,
      // 合并目标就用宽松键：它本身就是「抹掉装饰尾巴之后的规范形」，
      // 拿任何一个成员的原始写法当目标都可能是个非规范的键（那就等于把它拆开了）
      target: loose,
      ids: [...ids.keys()].sort(),
      members: members.sort((a, b) => b.sites - a.sites || a.id.localeCompare(b.id) || a.name.localeCompare(b.name)),
      // speed：名字里带 -highspeed / -ultraspeed，官方多半单独计价
      reason: speed ? 'speed' : 'decor',
    })
  }
  suggestions.sort((a, b) => b.members.length - a.members.length || a.loose.localeCompare(b.loose))

  return { groups, suggestions }
}

/**
 * 基准价查表：先精确命中，再按形状归一命中。
 *
 * 基准价表的键是「当初导入 / 手填时的那个名字」，从来没人保证它和模型名同形
 * （实测同一张表里 claude-opus-4-5 和 claude-opus-4.5 各一份）。
 * 合并之后如果还按原名查，会出现「同一组里一条有价、一条无价」的假象，
 * 所以这里兜一层归一化命中。指数建一次，挂在 WeakMap 上（不改入参）。
 */
const canonIndexCache = new WeakMap()

function canonIndex(table) {
  let index = canonIndexCache.get(table)
  if (index) return index
  index = new Map()
  for (const [key, entry] of Object.entries(table || {})) {
    const id = canonicalModelKey(key)
    if (!id) continue
    // 精确形状的那份优先：先到不一定更好，但同形条目价格本来就该一致
    if (!index.has(id)) index.set(id, entry)
  }
  canonIndexCache.set(table, index)
  return index
}

export function benchmarkEntry(table, key) {
  if (!table || !key) return null
  if (table[key]) return table[key]
  const id = canonicalModelKey(key)
  if (!id) return null
  if (table[id]) return table[id]
  return canonIndex(table).get(id) || null
}

/** 把用户从界面传来的别名表洗干净：键统一成 modelBaseKey，值原样（拆开要靠它） */
export function normalizeAliasTable(input) {
  const out = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  let count = 0
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = modelBaseKey(rawKey)
    const value = String(rawValue ?? '').trim().toLowerCase()
    if (!key || !value) continue
    out[key] = value
    count += 1
    if (count >= 500) break
  }
  return out
}
