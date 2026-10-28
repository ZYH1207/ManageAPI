/**
 * 中英文切换。
 *
 * 设计取舍：词典以**中文原文**为 key，翻译作用在 DOM 文本节点上（精确整串匹配）。
 *
 * 为什么不用「到处 t('key')」：整个界面有 400+ 处文案，散在几十个模板字符串里，
 * 逐处包 t() 改动面太大、也容易漏。改成渲染后统一过一遍文本节点，源码里的中文
 * 保持原样可读，只有英文需要维护。
 *
 * 安全边界：
 *   - 只做**整串精确匹配**，绝不按子串替换——否则「默认分组」这类用户数据会被误伤
 *   - 用户填的分组名、模型名不进词典，所以永远保持原样
 *   - 连续空白先归一化再查表，写回时保留首尾空白
 */

const STORAGE_KEY = 'manageapi.lang'

export const LANGS = ['zh', 'en']

function detectLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (LANGS.includes(saved)) return saved
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
  const nav = String(navigator.language || '').toLowerCase()
  return nav.startsWith('zh') ? 'zh' : 'en'
}

let current = detectLang()

export function getLang() {
  return current
}

let onChange = null
export function onLangChange(fn) {
  onChange = fn
}

export function setLang(lang) {
  if (!LANGS.includes(lang) || lang === current) return
  current = lang
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    /* 忽略 */
  }
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'
  document.documentElement.dataset.lang = lang
  if (onChange) onChange(lang)
}

export function toggleLang() {
  setLang(current === 'zh' ? 'en' : 'zh')
}

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
  )
}

/** 取一句翻译。没收录就原样返回中文，界面不会崩。 */
export function t(text, vars) {
  const raw = String(text)
  if (current === 'zh') return vars ? fill(raw, vars) : raw
  const key = normalize(raw)
  const hit = EN[key]
  const out = hit === undefined ? raw : hit
  return vars ? fill(out, vars) : out
}

function normalize(s) {
  return String(s).replace(/\s+/g, ' ').trim()
}

/**
 * 记住每个被翻译过的节点原来的样子，切回中文时用它还原。
 *
 * 为什么要记：静态 HTML（侧边栏副标题、弹窗标题这些）翻成英文之后，
 * 没有任何东西会把它们改回中文——它们不像页面视图那样每次渲染都重建。
 *
 * 存 {原串, 译串} 两个值，还原时先比对当前内容是不是当初写进去的译串：
 * 是才还原。否则像 toast 这种复用同一个节点、内容会换的，会被还原成过期文案。
 */
const originalText = new WeakMap() // textNode → { from, to }
const originalAttr = new WeakMap() // element → Map<attr, { from, to }>

/**
 * 把一棵子树里的中文翻成英文。
 *
 * 只处理文本节点和 title / placeholder / aria-label，且只做整串匹配。
 * 重复调用是安全的（英文文本不会再命中词典）。
 */
export function translateDom(root = document.body) {
  if (current === 'zh' || !root) return

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)

  for (const node of nodes) {
    const raw = node.nodeValue
    if (!raw) continue
    // 使用说明有中英两份静态块，由 CSS 切换，别在这里动它们
    if (node.parentElement?.closest('[data-lang-block]')) continue
    const key = normalize(raw)
    if (!key) continue
    const hit = EN[key] ?? hitPattern(key)
    if (hit === undefined) continue
    const lead = raw.match(/^\s*/)[0]
    const trail = raw.match(/\s*$/)[0]
    node.nodeValue = lead + hit + trail
    if (!originalText.has(node)) originalText.set(node, { from: raw, to: node.nodeValue })
  }

  for (const el of root.querySelectorAll('[title], [placeholder], [aria-label]')) {
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      const value = el.getAttribute(attr)
      if (!value) continue
      const key = normalize(value)
      const hit = EN[key] ?? hitPattern(key)
      if (hit === undefined) continue
      el.setAttribute(attr, hit)
      let bag = originalAttr.get(el)
      if (!bag) {
        bag = new Map()
        originalAttr.set(el, bag)
      }
      if (!bag.has(attr)) bag.set(attr, { from: value, to: hit })
    }
  }
}

/** 切回中文时调用：把当初翻译过的静态文案还原回去 */
export function restoreDom(root = document.body) {
  if (!root) return

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)

  for (const node of nodes) {
    const saved = originalText.get(node)
    if (!saved) continue
    // 内容被换过了（比如 toast 复用了这个节点），就别拿旧文案盖回去
    if (node.nodeValue !== saved.to) {
      originalText.delete(node)
      continue
    }
    node.nodeValue = saved.from
    originalText.delete(node)
  }

  for (const el of root.querySelectorAll('[title], [placeholder], [aria-label]')) {
    const bag = originalAttr.get(el)
    if (!bag) continue
    for (const [attr, saved] of bag) {
      if (el.getAttribute(attr) === saved.to) el.setAttribute(attr, saved.from)
    }
    originalAttr.delete(el)
  }
}

/** 数字 + 量词的组合没法逐条进词典，用正则统一处理 */
const PATTERNS = [
  [/^需要关注（(\d[\d,]*) 个站点）$/, 'Needs attention ($1 sites)'],
  [/^站点 ×([\d.]+)$/, 'site ×$1'],
  [/^截断 (\d+)%$/, 'truncated $1%'],
  [/^指纹 (\d+)%$/, 'fp $1%'],
  [/^计费 (\d+)%$/, 'billing $1%'],
  [/^可用率 (\d+)%$/, 'uptime $1%'],
  [/^(\d[\d,]*) 把 Key$/, '$1 key(s)'],
  [/^分组 · (.+)$/, 'Group · $1'],
  [/^(\d[\d,]*) 个模型$/, '$1 models'],
  [/^(\d[\d,]*) 个已定价$/, '$1 priced'],
  [/^(\d[\d,]*) 个 Key$/, '$1 key(s)'],
  [/^(\d[\d,]*) 个未匹配$/, '$1 unmatched'],
  [/^(\d[\d,]*) 个站点$/, '$1 sites'],
  [/^(\d[\d,]*) 个站$/, '$1 sites'],
  [/^(\d[\d,]*) 条模型供给$/, '$1 supplies'],
  [/^(\d[\d,]*) 条供给可路由$/, '$1 routable supplies'],
  [/^(\d[\d,]*) 条供给$/, '$1 supplies'],
  [/^(\d[\d,]*) 次探测$/, '$1 probes'],
  [/^(\d[\d,]*) 次请求$/, '$1 requests'],
  [/^(\d[\d,]*) 次$/, '$1 runs'],
  [/^(\d[\d,]*) 条$/, '$1'],
  [/^(\d[\d,]*) 个$/, '$1'],
  [/^(\d[\d,]*) \/ (\d[\d,]*) 个模型$/, '$1 / $2 models'],
  [/^(\d[\d,]*) \/ (\d[\d,]*) 条$/, '$1 / $2'],
  [/^(\d[\d,]*) \/ (\d[\d,]*) 成功$/, '$1 / $2 succeeded'],
  [/^(\d[\d,]*) 个站点 · (\d[\d,]*) 条模型供给 · (\d[\d,]*) 次探测$/, '$1 sites · $2 supplies · $3 probes'],
  [/^(\d[\d,]*) 个站 · (\d[\d,]*) 条供给$/, '$1 sites · $2 supplies'],
  [/^(\d[\d,]*) 个模型 · 结果可疑$/, '$1 models · suspicious'],
  [/^(\d[\d,]*) 分钟前$/, '$1 min ago'],
  [/^(\d[\d,]*) 小时前$/, '$1 h ago'],
  [/^(\d[\d,]*) 天前$/, '$1 d ago'],
  [/^(\d[\d,]*) 分钟$/, '$1 min'],
  [/^(\d[\d,]*) 小时$/, '$1 h'],
  [/^(\d[\d,]*) 天$/, '$1 days'],
  [/^缓存 ([\d.]+)%$/, 'cache $1%'],
  [/^价差 ([\d.]+)%$/, 'spread $1%'],
  [/^可用 ([\d.]+)% · 质量 ([\d.]+) · ([\d,]+)ms · ([\d,]+) 次$/, 'avail $1% · q $2 · $3ms · $4 runs'],
  [/^余额 ≈ ¥([\d.,]+)$/, '≈ ¥$1'],
  [/^当前选 (.+)$/, 'picks $1'],
  [/^(.+) 需要关注$/, '$1 needs attention'],
  [/^(.+) 个模型$/, '$1 models'],
  // ---- 补漏（按渲染文案 diff 清单）：计数、监控描述、探针证据、告警细节
  [/^(\d[\d,]*) 个分组$/, '$1 groups'],
  [/^(\d[\d,]*) 条未读$/, '$1 unread'],
  [/^(\d[\d,]*) 条 · (\d[\d,]*) 条未读$/, '$1 · $2 unread'],
  [/^(\d[\d,]*) 个站点 · (\d[\d,]*) 条供给$/, '$1 sites · $2 supplies'],
  [/^(\d[\d,]*) \/ (\d[\d,]*) 个模型$/, '$1 / $2 models'],
  [/^剩余 (.+?)，该充值了$/, '$1 left — top up soon'],
  [/^余额低于阈值（剩 (.+?)，阈值 (.+?)）$/, 'Balance below threshold ($1 left, threshold $2)'],
  [/^检测到 (\d[\d,]*) 项倍率\/价格变动$/, '$1 rate/price change(s) detected'],
  [/^读取余额超时 \((\d+)ms\)$/, 'Balance read timed out ($1ms)'],
  [/^读取余额超时（(\d+)ms）$/, 'Balance read timed out ($1ms)'],
  // 监控变动描述（core/monitor.js 生成，含站方数据没法整句进词典）
  [/^(.+)倍率下调至 ([\d.]+)$/, '$1 rate down to $2'],
  [/^(.+)倍率上调至 ([\d.]+)$/, '$1 rate up to $2'],
  [/^(.+) 原厂降价$/, '$1 official price dropped'],
  [/^(.+) 恢复供给$/, '$1 is back'],
  [/^(.+) ([\d.]+) → ([\d.]+)$/, '$1 $2 → $3'],
  // 探针证据行
  [/^最高数字 (\d+)，finish_reason=(\w+)，completion_tokens=(\d+)$/, 'max number $1, finish_reason=$2, completion_tokens=$3'],
  [/^实际返回：(.*)$/, 'raw output: $1'],
  [/^缓存：prompt_tokens=(\d+)，cached_tokens=(\d+)$/, 'cache: prompt_tokens=$1, cached_tokens=$2'],
]

function hitPattern(key) {
  for (const [re, rep] of PATTERNS) {
    if (re.test(key)) return key.replace(re, rep)
  }
  return undefined
}

// ------------------------------------------------------------------ 英文词典
// key 一律是「空白已归一化」的中文原文。用户填的数据（分组名、模型名）不要放进来。

const EN = {
  // ---- 侧边栏
  '概览': 'Overview',
  '状态与排名': 'Status & ranking',
  '站点': 'Sites',
  '中转站与 Key': 'Relays & keys',
  '比价': 'Pricing',
  '同一模型对比': 'Same model, side by side',
  '智能决策': 'Routing',
  '选站与手动调整': 'Auto pick & manual order',
  '探针': 'Probes',
  '检测是否偷工': 'Quality checks',
  '协议探查': 'Protocols',
  '表面协议与真实协议': 'Surface vs real protocol',
  '表面协议 · 真实协议 · 原生能力差异': 'Surface vs real protocol vs native capabilities',
  '协议记录': 'Protocol log',
  '全部探查历史': 'Full probe history',
  '全部探查历史 · 筛选与自动清理': 'Full history · filters & retention',
  '网关': 'Gateway',
  '一个入口接管': 'One endpoint',
  '用量': 'Usage',
  '消耗统计': 'Token spend',
  '基准价': 'Benchmarks',
  '基准价参照': 'Benchmark price reference',
  '使用说明': 'Docs',
  '联系我们': 'Contact',
  '汇率 USD→CNY': 'FX USD→CNY',
  '收起侧边栏': 'Collapse sidebar',
  '展开侧边栏': 'Expand sidebar',
  '切换深色模式': 'Toggle dark mode',
  '切换语言': 'Switch language',
  '个人专属API网关': 'Your personal API gateway',
  '这个工具怎么用、为什么这么设计': 'How to use it, and why it works this way',

  // ---- 顶栏 / 通知
  '通知': 'Notifications',
  '告警': 'Alerts',
  '全部已读': 'Mark all read',
  '暂无通知': 'Nothing to notify',
  '条未读': 'unread',
  '手动刷新一次': 'Refresh once',
  '自动同步已开启（每 15 秒一次）': 'Auto sync on (every 15s)',
  '自动同步已关闭': 'Auto sync off',
  '自动同步：开着，每 15 秒一次；点一下关闭': 'Auto sync: on, every 15s. Click to turn off',
  '自动同步已关，点一下开启': 'Auto sync off. Click to turn on',
  '实际消费 · {range}（{n} 个站点账单）': 'Actual spend · {range} ({n} site bills)',
  '还没有告警。余额低于阈值、倍率变化、同步失败都会记在这里。': 'No alerts yet. Low balance, rate changes and sync failures are logged here.',

  // ---- 页面副标题
  '当前状态一眼看完': 'Everything at a glance',
  '中转站、Key 与分组倍率': 'Relays, keys and group ratios',
  '同一模型跨站对比': 'Cross-site comparison',
  '候选排序与手动调整': 'Candidates and manual order',
  '指纹 / 截断 / 计费 / 缓存': 'Fingerprint / truncation / billing / cache',
  '一个入口接管全部流量': 'One endpoint for all traffic',
  '按 Key / 模型 / 站点统计': 'By key / model / site',
  '用量统计': 'Usage stats',
  '用量面板：按天 / Key / 模型 / 站点统计与清空': 'Usage panel: by day / key / model / site, with reset',
  '清空统计': 'Reset stats',
  '清空全部用量统计？此操作不可恢复。': 'Clear all usage stats? This cannot be undone.',
  '用量统计已清空': 'Usage stats cleared',
  '清空全部用量统计（按天 / 按 Key / 模型 / 站点），不影响站点与 Key':
    'Clear all usage stats (by day / key / model / site). Sites and keys are untouched.',
  '自定义': 'Custom',
  '自己选起止日期，两端都包含': 'Pick your own start and end dates, both inclusive',
  '起止日期': 'Date range',
  '查询': 'Apply',
  '起止日期都要填': 'Fill in both dates',
  '两端都包含；起止写反了会自动调正': 'Both ends inclusive; reversed dates are auto-corrected',
  '倍率换算的参照物': 'The baseline for ratio conversion',

  // ---- 通用
  '保存': 'Save',
  '取消': 'Cancel',
  '删除': 'Delete',
  '关闭': 'Close',
  '知道了': 'Got it',
  '展开': 'Expand',
  '收起': 'Collapse',
  '添加': 'Add',
  '恢复': 'Restore',
  '未探测': 'Not probed',
  '未录入': 'Not set',
  '未指定分组': 'No group',
  '可选': 'Optional',
  '标签': 'Label',
  '余额': 'Balance',
  '倍率': 'Ratio',
  '模型': 'Models',
  '搜索': 'Search',
  '空闲': 'off-peak',
  '按倍率': 'by ratio',
  '混合': 'Mixed',
  '自定义': 'Custom',
  '站点值': 'From site',
  '当前': 'current',
  '不限': 'no limit',
  '或': 'or',
  '条': '',
  '个': '',
  '值': 'value',
  '价格': 'Price',
  '时间': 'Time',
  '状态': 'Status',
  '来源': 'Source',
  '显示名': 'Display name',
  '模型key': 'Model key',
  '模型 key': 'Model key',
  '上游模型名': 'Upstream model',
  '模式': 'Mode',
  '输入价': 'Input',
  '输出价': 'Output',
  '输入': 'Input',
  '输出': 'Output',
  '缓存命中': 'Cached',
  '平均首字': 'Avg TTFT',
  '平均耗时': 'Avg latency',
  '请求数': 'Requests',
  '总计': 'Total',
  '币种': 'Currency',
  '月限额': 'Monthly limit',
  '复制': 'Copy',
  '轮换': 'Rotate',
  '启用': 'Enabled',
  '禁用': 'Disabled',

  // ---- 概览
  '当前最优选择': 'Best choice right now',
  '模型供给': 'Model supplies',
  '可横向比较': 'Comparable models',
  '最大价差': 'Max price spread',
  '需要关注': 'Needs attention',
  '一切正常': 'All clear',
  '所有探测过的供给都在正常范围': 'Every probed supply is within normal range',
  '站点速览': 'Sites at a glance',
  '长期评分': 'Long-term score',
  '健康供给': 'Healthy',
  '还没有数据': 'No data yet',
  '从添加一个中转站开始': 'Start by adding a relay',
  '填上地址和一个 Key，同步模型列表，就能看到跨站比价。':
    'Add its base URL and a key, sync the model list, and you can compare prices across sites.',
  '去添加站点': 'Add a site',
  '评分过期': 'score expired',
  '评分已过期：超过有效期没重新探测，首字是旧证据，不作数':
    'Score expired: not re-probed within the validity window; the TTFT is stale evidence and should not be trusted',
  '可用率低': 'low availability',
  '指纹不符': 'fingerprint mismatch',
  '输出截断': 'output truncated',
  '用量虚报': 'inflated usage',
  '结果可疑': 'Suspicious',
  '可用': 'Available',
  '质量': 'Quality',
  '个站点': 'sites',

  // ---- 站点页
  '还没有站点': 'No sites yet',
  '先添加一个中转站，填上它的地址和一个 Key，就能拉取模型列表开始比价。':
    'Add a relay with its base URL and a key, then sync its model list to start comparing prices.',
  '添加站点': 'Add a site',
  '名称': 'Name',
  '地址': 'Base URL',
  '类型': 'Type',
  '备注': 'Note',
  '不确定': 'Not sure',
  '例如：XX 中转站': 'e.g. My Relay',
  'Key 名称，如 Cherry Studio': 'Key label, e.g. Cherry Studio',
  'sk-... 粘贴完整 Key': 'sk-... paste the full key',
  '分组（可选）': 'Group (optional)',
  '添加 Key': 'Add key',
  '同步模型': 'Sync models',
  '导入倍率': 'Import ratios',
  '用量核对': 'Usage check',
  '读余额': 'Read balance',
  '导出配置': 'Export config',
  '令牌': 'Token',
  '令牌 ✓': 'Token ✓',
  '选分组': 'Pick group',
  '分组倍率': 'Group ratios',
  '全部恢复为站点值': 'Restore all to site values',
  '改一次，该分组所有模型一起变': 'One edit updates every model in this group',
  '还没同步过模型，先去「一键同步」': 'No models synced yet — run “Sync all” first',
  '还没有 Key，加一个才能拉模型。': 'No key yet — add one to sync models.',
  '余额未录入': 'Balance not set',
  '其中赠金 {amount}': 'incl. {amount} gift credit',
  '余额里含赠金 {amount}，{date} 到期。赠金按站点自己的规则抵扣，到期后自动失效。':
    'Balance includes {amount} of gift credit, expiring {date}. Gift credit is deducted by the site\u2019s own rules and lapses on expiry.',
  '没有固定到期日': 'no fixed expiry',
  '从站点读分组，选你买的那个，倍率自动填到下面所有模型': 'Read groups from the site, pick yours, ratios fill in below',
  '用管理令牌拉站方用量，和我们的估算对比': 'Pull the site\u2019s own usage and compare with our estimate',
  '填后台登录令牌后，可自动读余额': 'Fill in a login token to read the balance automatically',
  '这把 Key 属于这个分组，点这里换': 'This key belongs to this group — click to change',
  '还没选分组，点这里选（会顺便把倍率填好）': 'No group yet — click to pick one (ratios fill in too)',
  '这把 Key 属于站点的哪个分组，同步模型时会自动带上': 'Which group this key belongs to; carried into model sync',
  '改这里就是自定义倍率，不影响站点原始值': 'Editing here is a custom ratio; the site value is kept',
  '恢复成站点公布的倍率': 'Restore the ratio published by the site',
  '把这个站所有自定义倍率改回站点公布的值': 'Reset every custom ratio on this site',
  '扣费核对': 'Billing check',
  '我们的估算：': 'Our estimate:',
  '下面是站方返回的原始数据，差异大说明倍率有水分或计费口径不同。':
    'Raw data from the site below. A big gap means the ratio is inflated or billing differs.',

  // ---- 分组弹窗
  '选择分组': 'Pick a group',
  '正在从站点读取分组和倍率…': 'Reading groups and ratios from the site…',
  '读不到分组': 'Cannot read groups',
  '读不到也不影响用：可以在下面手动填倍率，或者在「基准价」页直接填价格。':
    'You can still use it: fill the ratio manually below, or set prices on the Benchmarks page.',
  '站点没有返回分组': 'The site returned no groups',
  '应用中': 'Applying…',
  '应用倍率': 'Apply ratios',
  '选中的分组会记在这把 Key 上，下次不用再选': 'The chosen group is saved on this key',
  '这个站没公布倍率，只能填绝对价。选完会按原价填入。':
    'This site publishes no ratios, so only absolute prices apply. Base price will be filled in.',

  // ---- 比价
  '还没定价': 'Unpriced',
  '无基准': 'no benchmark',
  '价差': 'Spread',
  '搜索模型名…': 'Search model name…',
  '最便宜': 'Cheapest',
  '超时': 'Too slow',
  '无缓存': 'no cache',
  '填「倍率」最省事：实际价 = 基准价 × 倍率。不知道倍率就直接填输入/输出单价。':
    'A ratio is easiest: price = benchmark × ratio. Otherwise fill in input/output unit prices.',

  // ---- 智能决策
  '有效成本': 'Effective cost',
  '恢复自动': 'Back to auto',
  '手动': 'Manual',
  '自动': 'Auto',
  '首字': 'TTFT',
  '当前会选中的那个站': 'The site that will be picked now',
  '价格 ÷ 质量，越小越优先': 'price ÷ quality, lower wins',
  '↑↓': '↑↓',

  // ---- 探针
  '探测': 'Probe',
  '探测全部': 'Probe all',
  '自动探测': 'Auto probe',
  '评分有效期': 'Score TTL',
  '定时关闭检测': 'Scheduled pause',
  '添加时段': 'Add window',
  '暂停中': 'Paused',
  '探测中': 'Probing',
  '无时段': 'No window',
  '暂停开始': 'Pause starts',
  '恢复时间（不含）': 'Resume at (exclusive)',
  '删除这一段': 'Remove this window',
  '定时探测全天运行': 'Scheduled probing runs all day',
  '全天运行': 'All day',
  '到点自动停、到点自动恢复；跨夜直接填大的那个时间':
    'Stops and resumes automatically; for an overnight window enter the later time first',
  '首字上限': 'TTFT limit',
  '小时': 'hours',
  '指纹': 'Fingerprint',
  '截断': 'Truncation',
  '计费': 'Billing',
  '缓存': 'Cache',
  '可用率': 'Availability',
  '完整性': 'Integrity',
  '样本': 'Samples',
  '健康': 'Healthy',
  '可疑': 'Suspicious',
  '不稳定': 'Unstable',
  '未知': 'Unknown',
  '过期': 'Expired',
  '上次探测': 'Last probe',
  '最近一次探测的证据': 'Evidence from the last probe',
  '各项正常': 'All checks passed',
  '实际返回': 'Actual response',
  '延迟': 'Latency',
  '指纹通过': 'Fingerprint OK',
  '指纹失败': 'Fingerprint failed',
  '未截断': 'Not truncated',
  '已截断': 'Truncated',
  '计费正常': 'Billing normal',
  '计费异常': 'Billing inflated',
  '次': 'runs',

  // ---- 探针花费卡片（探针页右下角）
  '探针花费': 'Probe spend',
  '清除探针花费统计': 'Clear probe spend',
  '探针花费统计已清除': 'Probe spend cleared',
  '无花费': 'no spend',
  '还没有探针花费': 'No probe spend yet',
  '统计自 {since} 起': 'since {since}',
  '共 {n} 次探测': '{n} probes in total',
  '最近一次：': 'latest: ',
  '{n} 次探测 · {m} 个请求': '{n} probes · {m} requests',
  '有 {n} 次探测算不出金额': '{n} probes could not be priced',

  // ---- 网关
  '网关地址': 'Gateway URL',
  '关闭网关': 'Turn off gateway',
  '开启网关': 'Turn on gateway',
  '新建Key': 'New key',
  '新建 Key': 'New key',
  '月 token 限额（可空）': 'Monthly token limit (optional)',
  '最近请求': 'Recent requests',
  '还没有请求经过网关': 'No requests through the gateway yet',
  '请求模型': 'Model',
  '选中站点': 'Chosen site',
  '尝试': 'Tries',
  '耗时': 'Latency',
  '结果': 'Result',
  '成功': 'ok',
  '失败': 'failed',
  '客户端填这个地址和任意一把 Key，就能访问全部站点':
    'Point any client at this URL with any gateway key to reach every site',
  '网关 Key': 'Gateway key',

  // ---- 详细用量（每次请求的 token / 缓存 / 首字 / 速度）
  '详细用量': 'Usage detail',
  '最近 {n} 天': 'Last {n} days',
  '错误 {n}': '{n} errors',
  '首字': 'TTFT',
  '生成': 'Gen',
  '生成速度': 'Gen speed',
  '缓存读': 'Cache read',
  '缓存写': 'Cache write',
  '思考': 'Thinking',
  '命中率': 'Hit rate',
  '速度': 'Speed',
  '无 usage': 'no usage',
  '全部失败': 'all failed',
  '断流': 'broken',
  '正在读取…': 'Loading…',
  '全部': 'All',
  '全部（{n}）': 'All ({n})',
  '清除筛选': 'Clear filter',
  '次请求': 'requests',
  '筛选命中的流量小计': 'Filtered traffic subtotal',
  '明细来自逐条账本（保留 {retention} 天）：区间内 {available} 条，这里列出最近 {shown} 条。':
    'Rows come from the per-request ledger ({retention}-day retention): {available} in range, newest {shown} listed.',
  '明细暂时来自决策日志（最近 {limit} 条）：区间内 {available} 条。账本从这次更新后开始积累。':
    'Rows temporarily come from the routing log (last {limit}): {available} in range. The ledger accumulates from this update on.',
  '上面的汇总是全量聚合；筛选时中间那行小计也是同一份聚合按条件求和的——两处永远对得上。下面的明细只是逐条展开，条数多少不代表流量大小。':
    'The summary above is the full aggregate; the subtotal is the same aggregate filtered — the two always agree. The rows below are just a per-request view; their count does not measure volume.',
  '统计已于 {time} 清空，更早的请求不再计入。': 'Stats were cleared at {time}; earlier requests no longer count.',
  '统计已于 {time} 清空：更早的请求不再计入上面的汇总，也不在下面的明细里。':
    'Stats were cleared at {time}: earlier requests are excluded from the summary above and from the detail below.',
  '筛出 {n} 条的小计': 'Subtotal of {n} matched',
  '匹配 {n} 条，表里只画最近 {shown} 条。': '{n} matched — only the newest {shown} are drawn.',
  '上面的汇总按 usage.json 全量聚合，不受筛选影响；筛出的小计只看明细窗口里的那几条。':
    'The summary above is the full usage.json aggregate and ignores the filter; the subtotal covers only the detail window.',
  '没有符合筛选的明细。': 'No detail rows match the filter.',
  '这段时间没有经过网关的请求。': 'No gateway requests in this period.',
  '明细来自决策日志（最多 {limit} 条）：区间内 {available} 条，这里列出最近 {shown} 条。':
    'Details come from the routing log (last {limit}): {available} in range, newest {shown} shown here.',
  '其中 {n} 条上游没有返回 usage：token 记作「—」，汇总里的 token 也不含它们。':
    '{n} of them got no usage from upstream — tokens show “—” and are excluded from the totals.',
  '汇总里算不出速度（老数据分不出非流式请求的耗时），上面的速度是下面明细窗口的平均值。':
    'The aggregate cannot yield a speed (old rows cannot separate non-stream latency); the value above is the detail window’s average.',
  '老数据算不出准确速度：只有流式请求的耗时能分开算，新的流式请求进来后这里会有值。':
    'Old rows cannot yield an accurate speed — only stream latency can be separated; this fills in once new stream requests arrive.',
  '输入为净值（prompt_tokens 减掉缓存读和缓存写）；命中率 = 缓存读 ÷（输入 + 缓存读 + 缓存写）；速度 = 输出 token ÷（总耗时 − 首字），只对流式请求计算。':
    'Input is net of cache read/write; hit rate = cache read ÷ (input + cache read + cache write); speed = output tokens ÷ (latency − TTFT), streams only.',

  // ---- 用量
  '按天': 'By day',
  '按 Key': 'By key',
  '按模型': 'By model',
  '按站点': 'By site',
  '7 天': '7 days',
  '30 天': '30 days',
  '90 天': '90 days',
  'token': 'tokens',

  // ---- 基准价
  '从站点导入基准价': 'Import site benchmark prices',
  '以此站已填价为准': 'Use this site\u2019s prices',
  '载入内置参考价': 'Load built-in prices',
  '空闲输入': 'Off-peak in',
  '空闲输出': 'Off-peak out',
  '基准价是「倍率」的换算参照。三条路：从站点导入中转站基准价、以此站已填价为准、或载入内置的厂商官方参考价。':
    'Benchmarks are what ratios convert against. Three sources: import a site\u2019s own benchmark prices, use a site\u2019s filled prices as-is, or load the built-in vendor-official list.',
  '条官方价': 'prices',
  '优先用令牌读「可用渠道」，没有则用模型广场': 'Read available channels with a token, falling back to the model plaza',
  '从站点读取分组倍率和模型价格': 'Read group ratios and model prices from the site',

  // ---- 联系我们
  '源码与更新': 'Source & updates',
  '博客': 'Blog',
  '使用笔记与踩坑记录': 'Notes and gotchas',
  'QQ 群': 'QQ group',
  '问题交流': 'Q&A',
  '邮箱': 'Email',
  '合作与反馈': 'Cooperation & feedback',
  '管理你买的多个 AI 中转站 · 本地运行 · 数据不出本机':
    'Manage the AI relays you bought · runs locally · data never leaves your machine',
  '遇到问题请优先看「使用说明」。想加新功能或者发现 bug，欢迎通过上面任一渠道告诉我。':
    'Please check the docs first. Feature requests and bug reports are welcome through any channel above.',
  '已复制到剪贴板': 'Copied to clipboard',
  '复制到剪贴板': 'Copy to clipboard',

  // ---- 通知中心
  '站点不健康': 'Site unhealthy',
  '网关已关闭': 'Gateway is off',
  '余额不足': 'Low balance',
}

/**
 * 第二遍补充：页面内的说明文字、长句、以及带冒号前缀的片段。
 * 片段能这么翻是因为中英这里语序一致（「<b>标题</b>：说明」）。
 */
Object.assign(EN, {
  // 量词与统计
  '个模型': ' models',
  '输入 token': 'Input tokens',
  '输出 token': 'Output tokens',
  '错误': 'Errors',
  '请求': 'Requests',
  '分组': 'Groups',
  '30 天 token': '30-day tokens',
  '默认 Key': 'Default key',
  '运行中': 'running',
  '网关运行中': 'Gateway running',
  '网关已关闭': 'Gateway off',

  // 概览 / 决策 / 探针的状态说明
  '默认按「有效成本 = 价格 ÷ 质量」排序。拖动整行（或最左边的把手）能改默认先后（没勾选时按这个派活）；点一下整行就是勾它为当前使用——顺序不动，再点一下取消勾选。勾选 > 拖的先后 > 自动排序。':
    'Sorted by the decision focus above. Drag a row (or its handle) to set the default order used when nothing is pinned; click a row to pin it as the active supply — order is untouched, click again to unpin. Pin beats drag order beats automatic.',
  '点击勾选这一行为当前使用（再点一下取消勾选），顺序不动': 'Click to pin this row as the active supply (click again to unpin); order is untouched',
  '已取消勾选，回到按顺序自动选': 'Unpinned; back to automatic selection by order',
  '「{model}」已保存手动顺序，没勾选时按这个先后派活': 'Manual order saved for {model}; used when nothing is pinned',
  '拖动调整顺序': 'Drag to reorder',
  '「{model}」已保存手动顺序': 'Manual order saved for {model}',
  '已勾选 {name} 为当前使用': 'Picked {name} as the active supply',
  '注意：同一个模型在不同站的状态是各自独立的（A 站掉包，B 站却完全正常），所以这里按「站 × 模型」逐条评估，状态下方会写明具体原因。':
    'Note: the same model can be fine on one site and swapped on another, so each site × model is judged on its own. The reason is shown under the status.',

  // 比价
  '价格直接改，失焦即保存。「¥/百万 token」是综合成本：输入按 25%、输出按 75% 加权（权重可在左下角汇率旁调）。':
    'Edit prices inline; saved on blur. ¥/Mtok is a blended cost: 25% input, 75% output (weight sits next to the FX box).',
  '价格直接改，失焦即保存。「{sym}/百万 token」是综合成本：输入按 25%、输出按 75% 加权。人民币标价的站按「基准价」页里的汇率折算成美元比较。':
    'Edit prices inline; saved on blur. {sym}/Mtok is a blended cost: 25% input, 75% output. CNY-priced sites convert at the rate on the Benchmarks page.',
  '{sym}/百万 token': '{sym}/Mtok',

  // 探针
  '主动探测': 'Active probing',
  '每个模型发 5 个请求：指纹 + 计费、截断、缓存（连发两次）、身份自述。结果进入评分，路由据此排除可疑的站。':
    'Five requests per model: fingerprint + billing, truncation, cache (twice), self-identification. The results feed the score that routing uses to exclude suspicious sites.',
  '探测全部（最多 5 个）': 'Probe all (max 5)',
  '探测全部（{n} 个）': 'Probe all ({n})',
  '探测所选（{n} 个）': 'Probe selected ({n})',
  '全部站点': 'All sites',
  '全部分组': 'All groups',
  '全部模型': 'All models',
  '指纹 100% 表示每次都精确返回了要求的内容，低于这个值说明上游可能把请求转给了别的模型。 截断一栏是「没被截断」的比例，计费一栏是「用量正常」的比例。':
    'Fingerprint 100% means the exact requested output came back every time; lower means the upstream may be rerouting. Truncation is the share not truncated; Billing is the share with normal usage.',

  // 网关
  '网关入口': 'Gateway endpoint',
  '给每个客户端单独建一把 Key，用量才能分开统计；哪一把泄露了，单独轮换即可。':
    'One key per client so usage stays attributable; a leaked key can be rotated on its own.',
  '路由决策': 'Routing decisions',

  // 用量
  '柱高按 token 总量，悬停看当天明细。': 'Bar height is total tokens; hover for that day.',

  // 基准价（<b>标题</b> 后面的片段）
  '：优先用「令牌」读该站的「可用渠道」（数据最全，不要求开广场），读不到再回落「模型广场」。只补空缺、不覆盖你已有的条目。':
    ': reads the site\u2019s available channels with a token (richest data, no plaza needed), falling back to the model plaza. Only fills gaps, never overwrites.',
  '：把某个站已经填好的实际价整体设为基准，适合你确信它没虚标的情况。':
    ': takes one site\u2019s existing prices as the baseline — use it when you trust that site.',
  '：用工具内置的一份模型厂商官方价（截至 ': ': uses the built-in vendor-official price list (as of ',
  '），价格常变，务必核对。': '). Prices change often — verify before relying on it.',

  // 站点页的令牌说明（整段走 t()，带 <code> 标记）
  '「令牌」是站点后台的登录凭证，只用来读余额、不参与对话。获取：登录后台 → F12 → Network → 点任意 <code>/api/v1/</code> 请求 → 复制 Request Headers 里的 <code>Authorization</code>（去掉 <code>Bearer </code> 前缀）。令牌会过期，失效后重新复制。':
    'The token is your site login credential — used only to read balance and usage, never for chat. To get it: log in → F12 → Network → click any <code>/api/v1/</code> request → copy <code>Authorization</code> from Request Headers (drop the <code>Bearer </code> prefix). Tokens expire in 7–30 days; copy a fresh one when they do.',

})

// 第三遍：按真实渲染出来的原文校正（词典 key 必须是「空白已归一化」的原文）
Object.assign(EN, {
  '0 = 不限；超过上限的供给不参与路由': '0 = no limit; slower supplies are excluded from routing',
  '：把这个站已经填好的实际价整体设为基准，适合你确信它没虚标的情况。':
    ': takes this site\u2019s existing prices as the baseline — use it when you trust the site.',
  '：用工具内置的一份模型厂商官方价（截至': ': uses the built-in vendor-official price list (as of',
  '给每个客户端单独一把 Key，用量才能分开统计；哪一把泄露了，单独轮换即可。':
    'One key per client so usage stays attributable; a leaked key can be rotated on its own.',
  '月 token 限额（可空）': 'Monthly token limit',
  '选一个站，一键拉取。有「令牌」读可用渠道、没令牌读模型广场。 只补空缺，不覆盖你已有的':
    'Pulls from one site. With a token it reads available channels, otherwise the model plaza. Only fills gaps, never overwrites.',
})

// 基准价三条说明整段走 t()（带 <b>/<br> 标记），避免按片段匹配出错
Object.assign(EN, {
  '<b>从站点导入基准价</b>：优先用「令牌」读该站的「可用渠道」（数据最全，不要求开广场），读不到再回落「模型广场」。导入的是<b>中转站基准价</b>——站方自己标的、还没乘分组倍率的那层价，不是模型厂商的官方价。只补空缺、不覆盖你已有的条目。<br />':
    '<b>Import site benchmarks</b>: reads the site\u2019s available channels with a token (richest data, no plaza needed), falling back to the model plaza. What gets imported is the <b>site\u2019s own benchmark price</b> — its base layer before group ratios, not the model vendor\u2019s official pricing. Only fills gaps, never overwrites.<br />',
  '<b>以此站已填价为准</b>：把这个站已经填好的实际价整体设为基准，适合你确信它没虚标的情况。<br />':
    '<b>Use this site\u2019s prices</b>: takes this site\u2019s existing prices as the baseline — use it when you trust the site.<br />',
  '<b>载入内置参考价</b>：用工具内置的一份<b>模型厂商官方价</b>（OpenAI、DeepSeek 这些原厂的定价，截至 {asOf}）。启动时已自动补过一次，这个按钮只补新出现的空缺，不覆盖你手填或从站导入的。价格常变，务必核对。':
    '<b>Load built-in prices</b>: uses the bundled <b>vendor-official price list</b> (pricing published by OpenAI, DeepSeek and other model vendors, as of {asOf}). This already runs once at startup; the button only fills new gaps and never overwrites your manual or imported entries. Prices change often — verify before relying on it.',
})

Object.assign(EN, {
  '在新页面打开': 'Open as page',
})

// 提示消息（toast）与零散状态文案
Object.assign(EN, {
  'Key 已创建': 'Key created',
  'Key 已删除': 'Key deleted',
  'Key 已加密保存': 'Key saved (encrypted)',
  '先在上面选一个站点': 'Pick a site above first',
  '已删除': 'Deleted',
  '已复制到剪贴板': 'Copied to clipboard',
  '已复制新 Key': 'New key copied',
  '已恢复自动排序（勾选与顺序一并清掉）': 'Back to automatic order (pin and order cleared)',
  '已拉取站方数据': 'Pulled data from the site',
  '已轮换，记得更新客户端配置': 'Rotated — update your client config',
  '权重已更新': 'Weight updated',
  '正在探测，需要几秒到几十秒…': 'Probing… this takes a few seconds',
  '汇率已更新': 'FX rate updated',
  '站点已添加': 'Site added',
  '网关地址已复制': 'Gateway URL copied',
  '配置已复制到剪贴板': 'Config copied to clipboard',
  '余额已更新': 'Balance updated',
  '分组已更新': 'Group updated',
  '已保存': 'Saved',
  '已删除这段': 'Window removed',
  '时间请填 HH:MM': 'Enter a time as HH:MM',
  '已取消定时关闭，探测全天运行': 'Scheduled pause cleared — probing runs all day',
  '已保存：全天暂停': 'Saved — paused all day',
  '最多 12 段，够覆盖一整天的作息了': 'Up to 12 windows',
  '正在应用中…': 'Applying…',
})

// 带变量的提示：整句用正则，避免在模板里塞 t()
const PATTERNS_MORE = [
  [/^导入 (\d[\d,]*) 条基准价$/, 'Imported $1 benchmark prices'],
  [/^已创建分组「(.+)」，记得填它的价格$/, 'Created group "$1" — remember to set its price'],
  [/^分组「(.+)」已删除：(\d[\d,]*) 个模型记录一并删掉$/, 'Group "$1" deleted, $2 model rows removed'],
  [/^已复制「(.+)」的 Key$/, 'Copied the key for "$1"'],
  [/^拉到 (\d[\d,]*) 个模型，新增 (\d[\d,]*)（(.+)）$/, '$1 models fetched, $2 new ($3)'],
  [/^探测 (\d[\d,]*) 个，成功 (\d[\d,]*)$/, 'Probed $1, $2 succeeded'],
  [/^探测失败：(.+)$/, 'Probe failed: $1'],
  [/^评分有效期改为 (\d+) 小时$/, 'Score TTL set to $1 hours'],
  [/^将于 (\d\d:\d\d) 自动恢复探测$/, 'Resumes automatically at $1'],
  [/^下次暂停 (\d\d:\d\d)$/, 'Next pause at $1'],
  [/^已加一段 (\d\d:\d\d) 至 (\d\d:\d\d)，点时间就能改$/, 'Added $1 to $2 — click a time to change it'],
  [/^已保存：现在暂停中，(\d\d:\d\d) 恢复$/, 'Saved — paused until $1'],
  [/^已保存：现在照常探测，(\d\d:\d\d) 起暂停$/, 'Saved — probing now, pausing at $1'],
  [/^复制失败，手动复制：(.+)$/, 'Copy failed — copy manually: $1'],
]
for (const row of PATTERNS_MORE) PATTERNS.push(row)

// 顶栏 / 侧边栏底部 / 通知中心
Object.assign(EN, {
  '文档': 'Docs',
  '深色模式': 'Dark mode',
  '浅色模式': 'Light mode',
  '收起': 'Collapse',
  '展开': 'Expand',
  '只影响按美元标价的站点；人民币标价的站不受影响。':
    'Only affects sites priced in USD; CNY-priced sites are unaffected.',
  '暂时没有通知': 'Nothing to notify',
  '{name} 余额偏低': '{name} balance is low',
  '剩余 {amount} {currency}，该充值了': '{amount} {currency} left — time to top up',
  '{n} 个模型 · {reasons}': '{n} models · {reasons}',
  '请求全部失败': 'All requests failed',
  '{model}：所有候选站都不可用': '{model}: no candidate site was usable',
  '自动切换了站点': 'Switched sites automatically',
  '{model}：首选失败，第 {n} 次成功（{provider}）':
    '{model}: first choice failed, succeeded on attempt {n} ({provider})',
})

Object.assign(EN, {
  '{n} 条未读': '{n} unread',
})

Object.assign(EN, {
  '价格直接改，失焦即保存。「¥/百万 token」是综合成本：输入按 25%、输出按 75% 加权。美元标价的站按「基准价」页里的汇率换算。':
    'Edit prices inline; saved on blur. ¥/Mtok is a blended cost: 25% input, 75% output. USD-priced sites convert at the rate on the Benchmarks page.',
})

// 比价页「只显示允许放行」开关
Object.assign(EN, {
  '只显示允许放行': 'Only admitted',
  '打开后只显示准入通过的供给：慢速 / 结果可疑 / 不稳定 / 没有可信样本 / 冷却中（额度不足、限流）整行隐藏；评分过期、未探测的仍然显示（它们不是坏站）。随时可切。':
    'Show only supplies that pass admission: rows flagged slow, suspicious, unstable, without usable samples or cooling down (out of credit, rate limited) are hidden; stale and never-probed rows stay visible (they are not bad sites). Toggle any time.',
  '{shown} / {total} 个模型': '{shown} / {total} models',
  '{shown} / {total} 个模型 · 已隐藏 {n} 条供给':
    '{shown} / {total} models · {n} supplies hidden',
  '没有允许放行的供给': 'No admitted supplies',
  '当前范围内有 {n} 条供给被这个开关隐藏了：慢速、结果可疑、不稳定、没有可信样本或冷却中。关掉开关就能看到它们。':
    '{n} supplies in this view are hidden by the switch: slow, suspicious, unstable, without usable samples or cooling down. Turn it off to see them.',
})

// 决策页「只显示可使用」开关：和比价页同一份 admission 过滤，只是位置不同
Object.assign(EN, {
  '只显示可使用': 'Usable only',
  '打开后只显示准入通过的供给：慢速 / 结果可疑 / 不稳定 / 没有可信样本 / 冷却中（额度不足、限流）整行隐藏；评分过期、未探测的仍然显示（它们不是坏站）。只是展示筛选，不影响网关派活和手动顺序。随时可切。':
    'Show only supplies that pass admission: rows flagged slow, suspicious, unstable, without usable samples or cooling down (out of credit, rate limited) are hidden; stale and never-probed rows stay visible (they are not bad sites). Display-only filter: routing and manual order are unaffected. Toggle any time.',
})

// 放行可疑供给（开关）
Object.assign(EN, {
  '太慢': 'Too slow',
  // 慢速 = 首字超过门槛被筛掉的那一类，和不可用同等待遇
  '慢速': 'Slow',
  '兜底': 'Fallback',
  '不会登场': 'Not routed',
  '没有可信样本': 'No usable samples',
  '慢速档位限制': 'Slow tier limit',
  '1000–20000ms 共 20 档 · 慢速即为不可用':
    '20 tiers, 1000–20000ms · slow means unavailable',
  '放行可疑供给': 'Allow suspicious supplies',
  '开启后，判定可疑（指纹不符 / 输出截断 / 用量虚报）的站，也可正常登场。若在意可信度，请关闭。':
    'When on, sites flagged as suspicious (fingerprint mismatch / truncated output / inflated usage) can also take part in routing. Turn this off if you care about trustworthiness.',
  '已放行可疑供给，它们会正常参与选站': 'Suspicious supplies are now allowed to compete',
  '已恢复：可疑供给不再登场': 'Restored: suspicious supplies are no longer routed',
})

// 决策侧重（性价比 / 价格 / 首字速度 / 价速比）
Object.assign(EN, {
  '决策侧重': 'Decision basis',
  '只改「谁排前面」，不放开准入': 'Changes ranking only, never admission',
  '性价比': 'Value',
  '首字速度': 'TTFT speed',
  '价格 ÷ 质量': 'price ÷ quality',
  '名义单价': 'list price',
  '首字延迟': 'first-token latency',
  '价速比': 'Price-pace',
  '价格 ÷ 首字延迟': 'price ÷ TTFT',
  '按「每毫秒首字等待花多少钱」排序：价格和速度合成一个比值，贵的、慢的一起现形，综合最优的排第一。':
    'Ranks by price per millisecond of first-token wait: cost and latency collapse into one number, so the slow and the pricey both show up — the best combined pick lands first.',
  '/s 首字': '/s TTFT',
  '自动路由': 'Auto routing',
  '一键接管': 'Take over',
  '权限在决策侧重之上：接管后客户端要什么模型都无所谓': 'Sits above the decision basis: once taken over, whatever model the client asks for is irrelevant',
  '自动路由功能介绍': 'About auto routing',
  '自动路由正在把全部请求派给这个模型（当前档位下全场最优）':
    'Auto routing is dispatching all requests to this model (best across the pool under the current basis)',
  '故障转移': 'Failover',
  '外部监控上报了真实故障（探针没测到也以监控为准），已故障转移；保持期过后若仍是全场第一会自动提回':
    'The external monitor reported a real failure (monitor wins even if probes saw nothing); traffic was failed over. It re-enters automatically after the hold expires if still ranked first.',
  '接管后，不管客户端请求哪个模型、怎么切模型，网关都只派给当前决策档位下全场最优的那一个模型——不分站点、不分分组、不分来自哪个站。若新模型只比现役好一点点（不到 15%），不切换：反复横跳对用户的干扰比那点收益大，只有明显更优或现役下线才换。免费入口不受影响。':
    'Once taken over, whichever model the client asks for — and however it switches — the gateway dispatches only to the single best model under the current decision basis, regardless of site, group or origin. A new champion only marginally better than the incumbent (under 15%) is ignored: flapping disturbs users more than the tiny gain, so it switches only on a clear win or when the incumbent goes offline. Free-pool entries are unaffected.',
  '开启后网关无视客户端请求的模型名，始终把请求派给当前决策档位下全场最优的模型。免费入口不受影响。':
    'When on, the gateway ignores the requested model name and always dispatches to the best model across the whole pool under the current decision basis. Free-pool entries are unaffected.',
  '开启后，不管客户端请求哪个模型、怎么切模型，网关都只派给当前决策档位下全场最优的那一个模型——不分站点、不分分组、不分来自哪个站。若新模型只比现役好一点点（不到 15%），不切换：反复横跳对用户的干扰比那点收益大，只有明显更优或现役下线才换。':
    'Once on, whichever model the client asks for — and however it switches — the gateway dispatches only to the single best model under the current decision basis, regardless of site, group or origin. A new champion only marginally better than the incumbent (under 15%) is ignored: flapping disturbs users more than the tiny gain, so it switches only on a clear win or when the incumbent goes offline.',
  '正在使用': 'Now using ',
  '自动路由已接管：不管客户端要什么模型，都只派当前档位下全场最优的那个':
    'Auto routing took over: whatever model the client asks for, only the best one under the current basis is dispatched',
  '自动路由已关闭：网关恢复按客户端请求的模型派活':
    'Auto routing off: the gateway dispatches by the requested model again',
  '；自动路由接管中，已按新档位重选最优模型':
    '; auto routing is active and re-picked the best model under the new basis',
  '这一单是被自动路由改派的，不是客户端真的点名了这个模型':
    'This request was re-routed by auto routing — the client did not actually name this model',
  '接管': 'auto',
  '决策侧重已切到「{mode}」，下面的排序和网关选站都跟着变了':
    'Decision basis switched to "{mode}" — both the ranking below and gateway site selection follow it',
  // 看板顶部结论句：用哪个站、按哪档算的、那个档的关键数字
  '选用{provider}的 {model}，按{basis}算{verdict}：{metric}':
    'Picked {provider} for {model} — {verdict} on {basis}: {metric}',
  '最划算': 'best value',
  '最快': 'fastest',
  '/百万 token': '/Mtok',
  '换一个模型看结论': 'Switch to another model',
  '本机未被忽略的模型': 'Models on this machine (ignored ones excluded)',
  '现在没有可用供给': 'no usable supply right now',
  '没有可用供给': 'no usable supply',
  '{n} / {total} 条供给可用': '{n} / {total} supplies usable',
  '{n} 条可用': '{n} usable',
  '只改这句结论的算法，不改网关派活': 'Changes only how this sentence is computed — routing is untouched',
  '看板结论句改按「{mode}」算（网关派活没变）': 'Headline now uses "{mode}" (routing unchanged)',
  // 看板顶部第二句：全场冠军行
  '在全部模型中，{provider}的 {model} 按{basis}算{verdict}：{metric}':
    'Across all models — {verdict} on {basis}: {provider} for {model}, {metric}',
  '只改这句全场冠军的算法，不影响上面那句': 'Changes only this champion line — the sentence above is untouched',
  '全场冠军改按「{mode}」算': 'Champion line now uses "{mode}"',
})

// 免费页
Object.assign(EN, {
  '免费': 'Free',
  '额度与积分': 'Quotas & credits',
  '免费额度与平台积分，不参与付费比价': 'Free quotas and platform credits — excluded from paid comparison',

  '<b>免费池独立于付费比价</b><span class="desc" style="display:block;margin-top:2px">这里的供给不参与「最便宜」判断和自动选站。只有你在客户端写 <code>free/</code> 前缀，或把地址换成 <code>/free/v1</code> 时才会用到。</span>':
    '<b>The free pool is separate from paid comparison</b><span class="desc" style="display:block;margin-top:2px">Nothing here takes part in "cheapest" ranking or automatic site selection. It is only used when your client sends a <code>free/</code> model prefix, or points at <code>/free/v1</code>.</span>',

  '中转站免费模型': 'Free relay models',
  '平台积分': 'Platform credits',
  '可用供给': 'Usable',
  '平均指纹': 'Avg fingerprint',
  '平均首字': 'Avg TTFT',
  '剩余额度': 'Remaining',
  '模型': 'Model',
  '站点': 'Site',
  '分组': 'Groups',
  '配额': 'Quota',
  '指纹': 'Fingerprint',
  '首字': 'TTFT',
  '状态': 'Status',

  '还没有免费模型': 'No free models yet',
  '去「站点」页点「导入倍率」，实际价为 0 的模型会自动出现在这里。':
    'Open Sites and click "Import ratios" — models priced at 0 will show up here automatically.',
  '去站点导入': 'Import from sites',
  '免费模型是探针最有价值的场景：没人会白送，最常见的偷工方式是拿小模型冒充大模型。 指纹低于 100% 的那几行值得点开看看。':
    'Free models are where probing matters most: nobody gives things away for free, and the usual trick is serving a smaller model. Rows below 100% fingerprint are worth a look.',

  '还没有连接平台': 'No platform connected',
  '平台积分可以来自 WorkBuddy、Trae 等 Agent 平台。连接后能自动读模型目录、剩余积分与重置时间。':
    'Platform credits can come from agents like WorkBuddy or Trae. Once connected, the model catalogue, remaining credits and reset time are read automatically.',
  '连接功能开发中': 'Connector in progress',

  '免费额度有两个来源': 'Free quota comes from two places',
  '① 中转站的免费模型': '1) Free models on relay sites',
  '② 平台的免费积分': '2) Free credits on agent platforms',
  '去「站点」页点「导入倍率」，实际价为 0 的模型会自动出现在这里':
    'Open Sites and click "Import ratios" — models priced at 0 appear here automatically',
  '连接 WorkBuddy、Trae 等平台，或手动填一个额度':
    'Connect WorkBuddy, Trae and similar platforms, or enter a quota manually',
})

// 免费页 · 闸门原因与平台卡片（web/free-relay.js、web/free-platform.js、core/rank-free.js）
Object.assign(EN, {
  '超出配额': 'Over quota',
  '额度用尽': 'Quota used up',
  '未探测': 'Not probed',
  '评分过期': 'Score expired',
  '没有可信样本': 'No usable samples',
  '证据不足': 'Not enough evidence',
  '花费': 'Spend',
  '识别系别': 'Detect type',
  '用站点令牌探测这个站是哪一系（one-api / new-api / Sub2API）。匿名探测不出的站，带令牌再试一次往往就能识别': 'Detect which type this site is (one-api / new-api / Sub2API). Sites that fail anonymous probing often succeed with a token',
  '余额合计': 'Total balance',
  '读不到账单': 'No bill',
  '{n} 个站点账单': 'Bills from {n} sites',
  '站点未提供账单接口或令牌无效': 'Site has no billing API or the token is invalid',
  '花费合计': 'Total spend',
  '余额': 'Balance',
  '全部站点': 'All sites',
  '只看这个站': 'Show only this site',
  '余额合计（{sym}，其他币种按汇率折算）': 'Total balance ({sym}, other currencies converted)',
  '该站余额（{sym}）': 'Site balance ({sym})',
  '各站花费（堆叠）': 'Spend by site (stacked)',
  '该站每日花费': 'Daily spend for this site',
  '充值汇率': 'Top-up rate',
  '默认站单价': 'Default site unit price',
  '令牌尾号': 'Token tail',
  '「令牌」是站点后台的登录凭证，一次填好整站通用，用来读余额、公告和分组': 'The token is the site login credential — fill it once per site for balance, announcements and groups',
  '未填站点令牌': 'No site token',
  '站点充值汇率：充 1 元到账多少站点额度。1:1 充值的站填 1（绝大多数）；充 ¥100 到账 $120 填 0.83。留空 = 1:1。「实际消费」用它把站点额度换算成人民币。': 'Top-up rate: how much site credit ¥1 buys. 1:1 sites enter 1 (most relays); ¥100 for $120 → 0.83. Empty = 1:1. Actual spend converts site credit with it.',
  '今天': 'Today',
  '本周': 'This week',
  '本月': 'This month',
  '模型消费 / 实际消费': 'Model spend / actual spend',
  '模型消费': 'Model spend',
  '实际消费': 'Actual spend',
  '实际按充值汇率折算': 'actual converts with your top-up rate',
  '置信度高': 'high confidence',
  '置信度中': 'medium confidence',
  '置信度低（样本少）': 'low confidence (few samples)',
  '最近证据': 'Latest evidence',
  '最近一次有效证据（探针或真实调用）': 'Most recent evidence (probe or real call)',
  '探针：': 'probe: ',
  // 不可用的原因。「冷却」只留给上游账号真的在冷却（限流）；余额不足是账单问题
  '额度不足': 'Out of credit',
  '余额不足': 'Out of balance',
  '余额不足 · 请充值': 'Out of balance — top up',
  '余额不足 · 等确认恢复': 'Out of balance — awaiting confirmation',
  '单次请求超限': 'Request too large',
  '单次预算超限': 'Request over budget',
  '上游账号冷却中': 'Upstream account cooling down',
  '该分组没有这个模型': 'Model not in this group',
  '限流中': 'Rate limited',
  '模型不可用': 'Model unavailable',
  '失败率过高': 'Failure rate too high',
  '暂时不可用': 'Temporarily unavailable',
  '冷却中': 'cooling down',
  // 窗口到了但还没有成功证据：路由仍然不放行
  '等确认恢复': 'waiting for confirmation',
  '等探测确认': 'waiting for a probe',
  '指纹不符': 'Fingerprint mismatch',
  '输出截断': 'Output truncated',
  '低于门槛': 'below the 80% floor',
  '未截断': 'not truncated',
  '未设置配额': 'No quota set',
  '每天重置': 'Resets daily',
  '每月重置': 'Resets monthly',
  '即将重置': 'Resetting soon',
  '默认': 'Default',

  '用量已经超过这个窗口的上限，等重置后再用': 'Usage already exceeds this window — wait for the reset',
  '这个窗口的免费额度已经用完': 'The free quota for this window is used up',
  '还没有探测记录，免费站不能靠猜': 'Never probed — a free site is not worth guessing about',
  '上次探测太久远，先重新探测再放行': 'Last probe is too old — probe again before routing',

  '已连接平台': 'Connected',
  '账号': 'Accounts',
  '剩余积分': 'Credits left',
  '今日已签': 'Checked in today',
  '已连接': 'Connected',
  '未连接': 'Not connected',
  '尚未连接': 'Not connected yet',
  '签到': 'Check in',
  '刷新': 'Refresh',
  '连接': 'Connect',
  '连接后自动读取模型目录、剩余积分与重置时间。':
    'Once connected, the catalogue, remaining credits and reset time are read automatically.',
})

// 免费页 · 带变量的模板与两处长句
Object.assign(EN, {
  '预计撑最久': 'Lasts longest',
  '免费模型是探针最有价值的场景：没人会白送，最常见的偷工方式是拿小模型冒充大模型。指纹不到 100% 的那几行值得点开看看。':
    'Free models are where probing matters most: nobody gives things away for free, and the usual trick is serving a smaller model. Rows below 100% fingerprint are worth a look.',
  '{n} 个账号 · 剩 {r} {unit}': '{n} account(s) · {r} {unit} left',
  '{when}已用 {used}/{limit} {unit}': '{used}/{limit} {unit} used {when}',
  '下次重置：{v}': 'Next reset: {v}',
  '{n} 分钟后': 'in {n} min',
  '{n} 小时后': 'in {n} h',
  '本月': 'this month',
  '今日': 'today',
})

// 免费页 · 平台侧提示
Object.assign(EN, {
  '这个平台还没有账号': 'This platform has no account yet',
  '今天已经签过了': 'Already checked in today',
  '签到成功': 'Checked in',
  '签到成功，+{n}': 'Checked in, +{n}',
  '签到失败': 'Check-in failed',
  '已刷新': 'Refreshed',
  '账号池与自动连接还在做，先用「手动添加」': 'Account pool and auto-connect are still in progress — use manual entry for now',
})

// 免费页 · 平台侧「手动添加」表单
Object.assign(EN, {
  '平台积分可以来自 WorkBuddy、Trae 等 Agent 平台。自动连接还在做，现在可以先手动记一个额度。':
    'Platform credits can come from agents like WorkBuddy or Trae. Auto-connect is still in progress — you can record a quota manually for now.',
  '手动添加': 'Add manually',
  '连接平台': 'Connect platform',
  'WorkBuddy / Trae 自动连接开发中': 'WorkBuddy / Trae auto-connect is in progress',
  '添加一个平台': 'Add a platform',
  '只记额度也能用：能算「还能撑几天」、到期前提醒你。自动读取模型目录要等连接器。':
    'Recording just the quota is still useful: it estimates days left and warns you before it runs out. Reading the catalogue automatically needs a connector.',
  '平台名': 'Platform name',
  '额度上限': 'Quota limit',
  '单位': 'Unit',
  '积分': 'credits',
  '窗口': 'Window',
  '每天': 'Daily',
  '每月': 'Monthly',
  '先填一个平台名': 'Enter a platform name first',
  '已添加「{name}」': 'Added "{name}"',
})

Object.assign(EN, {
  // 额度单位可能不是积分（次 / token），所以标题用「剩余额度」而不是「剩余积分」
  '剩余额度': 'Quota left',
})

Object.assign(EN, {
  '常用站点': 'Common sites',
  '常用平台': 'Common platforms',
  '先选一个平台或填个名称': 'Pick a platform or enter a name first',
  '（手动填写）': '(fill in manually)',
})

// 平台连接（OAuth 轮询）
Object.assign(EN, {
  '先添加一个平台': 'Add a platform first',
  '平台没有返回授权地址': 'The platform did not return an authorisation URL',
  '已打开授权页，完成后会自动回来': 'Authorisation page opened — this will update automatically',
  '已连接': 'Connected',
  '授权超时，重新点一次「连接」': 'Authorisation timed out — click Connect again',
  '账号池还在做，先一个账号够用': 'Account pool is still in progress — one account is enough for now',
})

Object.assign(EN, {
  '实验性': 'Experimental',
  '自动连接使用平台未公开接口，可能随平台升级失效':
    'Auto-connect uses an undocumented platform API and may break when the platform updates',
})

// 站点级令牌与余额
Object.assign(EN, {
  '站点余额': 'Site balance',
  '一个后台账号一套，整站通用': 'One per backend account — shared by the whole site',
  '「令牌」在站点卡片上（不在 Key 上）——它是站点后台的登录凭证，一个后台账号填一次，整站通用。获取：登录后台 → F12 → Network → 点任意 <code>/api/v1/</code> 请求 → 复制 Request Headers 里的 <code>Authorization</code>（去掉 <code>Bearer </code> 前缀）。令牌会过期，失效后重新复制。':
    'The token lives on the site card, not on individual keys — it is the backend login credential, entered once per backend account and shared by the whole site. To get it: log in → F12 → Network → click any <code>/api/v1/</code> request → copy <code>Authorization</code> from Request Headers (drop the <code>Bearer </code> prefix). Tokens expire; copy a fresh one when they do.',
})

Object.assign(EN, {
  '识别分组': 'Detect groups',
  '从站点后台的令牌列表读出每把 Key 属于哪个分组，自动按各自的分组应用倍率':
    'Reads each key\u2019s group from the site\u2019s token list and applies that group\u2019s rate',
})

Object.assign(EN, {
  '需要先填「令牌」。从站点后台的令牌列表读出每把 Key 属于哪个分组，按各自的分组自动应用倍率':
    'Needs a site token first. Reads each key\u2019s group from the site token list and applies that group\u2019s rate.',
})

Object.assign(EN, {
  '免费池只收「实际价为 0」的模型。分组名叫「免费」但价格没填的，不算——空不等于 0。':
    'The free pool only takes models whose actual price is 0. A group named "free" with an empty price does not count — blank is not zero.',
  '去「比价」页把它的输入/输出价填 0，或直接点「标为免费」；也可以先「导入倍率」，实际价算下来是 0 的会自动进来。':
    'Set its input/output price to 0 on the Pricing page, or click "Mark free". You can also import ratios first — anything that works out to 0 lands here automatically.',
  '去比价页标免费': 'Mark free on Pricing',
  '去站点导入倍率': 'Import ratios on Sites',
  '标为免费': 'Mark free',
  '把输入/输出价都设为 0，这条就进免费池（不进比价和自动选站）':
    'Sets input and output price to 0 — this supply moves to the free pool and leaves paid comparison.',
})

// 平台侧内置卡片与参数说明
Object.assign(EN, {
  '添加': 'Add',
  '添加并连接': 'Add & connect',
  '参数怎么填': 'How to fill the fields',
  '平台给的总量，写数字就行（20、100、500000）': 'Total amount the platform gives — just the number (20, 100, 500000)',
  '平台按「次」给就选次，按积分就选积分，按 token 就选 token；拿不准选积分':
    'Pick the unit the platform uses — requests, credits or tokens. When unsure, use credits.',
  '每天重置选「每天」，每月重置选「每月」': 'Choose Daily if it resets every day, Monthly if it resets every month',
  '随便起，只用于你自己识别': 'Any name — it only helps you recognise the card',
  '想让程序自动读额度就用「连接」（WorkBuddy / CodeBuddy 支持）；其余平台先手动记，用完了自己更新':
    'Use Connect when you want the tool to read the quota automatically (WorkBuddy / CodeBuddy). For the rest, record it manually and update it when it runs out.',
  '手动添加一个不在列表里的平台': 'Add a platform that is not listed',
})

Object.assign(EN, {
  '额度是平台给的总量，用完自己更新；想自动读就点「连接」。':
    'The quota is the total the platform gives — update it yourself as it drains. Use Connect if you want it read automatically.',
})

Object.assign(EN, {
  '等待授权… 已 {s} 秒': 'Waiting for authorisation… {s}s',
  '已打开授权页，完成后这里会自动更新。': 'Authorisation page opened — this updates automatically when you finish.',
  '最近状态：': 'Latest status: ',
  '重新打开授权页': 'Reopen authorisation page',
  '已重新打开授权页': 'Authorisation page reopened',
  '已取消等待': 'Stopped waiting',
})

Object.assign(EN, {
  '诊断': 'Diagnose',
  '把平台接口的原始返回复制出来，字段对不上时用':
    'Copies the raw platform responses so field mismatches can be diagnosed',
  '诊断信息已复制，发给开发者就能定位': 'Diagnostics copied — send it over to get this fixed',
  '复制失败，诊断信息已打印到控制台': 'Copy failed — diagnostics printed to the console',
})

Object.assign(EN, {
  '剩余 {n} {unit}': '{n} {unit} left',
})

// 监控页
Object.assign(EN, {
  '监控': 'Monitor',
  '余额与变动': 'Balance & changes',
  '余额趋势、倍率变动与上游公告': 'Balance trend, rate changes and upstream notices',
  '正在读取监控数据…': 'Loading monitor data…',
  '第一次打开会现采一轮，稍等一下。': 'The first open runs one collection round — give it a moment.',
  '还没有中转站': 'No upstream sites yet',
  '监控会定时读每个站的余额、倍率与公告。先去「站点」页添加一个。':
    'Monitoring periodically reads each site\u2019s balance, rates and notices. Add one on the Sites page first.',
  '去添加站点': 'Add a site',
  '有余额数据': 'with balance data',
  '总余额': 'Total balance',
  '今日花费': 'Spend today',
  '按当前价估算': 'estimated at current prices',
  '24 小时变动': 'Changes (24h)',
  '倍率 / 价格': 'rates / prices',
  '未读告警': 'Unread alerts',
  // 余额告警条（KPI 下方那条实心红）
  '余额告警 · {n} 个站点低于阈值': 'Balance alert · {n} site(s) below threshold',
  '余额见底会直接断供，尽快充值': 'Once it hits zero the site stops serving — top up soon',
  '阈值 {amount}': 'threshold {amount}',
  '已用尽': 'depleted',
  '看这个站的卡片': 'Jump to this site\u2019s card',
  '还没有余额数据': 'no balance yet',
  '最低：{name} {amount}': 'Lowest: {name} {amount}',
  '余额概览': 'Balance overview',
  '还没有同步到余额。点右上角「立即同步」跑一轮。':
    'No balance collected yet — hit "Collect now" to run a round.',
  // 图例符号是动态的（显示币种），用 {sym} 占位符；旧的整串 key 已对不上当前文案
  '总余额（{sym}，其他币种按汇率折算）': 'Total balance ({sym}; other currencies converted at the current rate)',
  '≈ ¥{cny}（按汇率折算）': '≈ ¥{cny} at the current rate',
  '余额币种，读余额时按站点接口自动判断，可手动纠正': 'Balance currency — auto-detected from the site API, override if wrong',
  '显示币种': 'Display currency',
  '只影响价格显示，不影响比较口径（比较一律按美元）': 'Display only — comparisons always use USD',
  '只影响人民币标价/展示的折算': 'Only used to convert CNY prices for display',
  '显示币种已切换': 'Display currency switched',
  '每日花费（估）': 'Daily spend (est.)',
  '余额与花费趋势': 'Balance and spend trend',
  '只同步这个站': 'Collect this site only',
  '只采这个站': 'Collect this site',
  '无数据': 'no data',
  '最近倍率变动': 'Recent rate changes',
  '还没有变动。第一次同步只记基线，之后才开始比较。':
    'No changes yet — the first collection only records a baseline.',
  '低于阈值 {amount}': 'below threshold {amount}',
  '还没读到模型价': 'prices not read yet',
  '{n} 个模型有原厂价': '{n} models with vendor-official prices',
  '还没读到分组倍率': 'No group rates yet',
  '站点余额与分组': 'Site balances & groups',
  '分组倍率来自站点公布的可用渠道': 'Group rates come from the channels the site publishes',
  '告警动态': 'Alert feed',
  '{n} 条未读': '{n} unread',
  '还没有告警。余额低于阈值、倍率变化、同步失败都会记在这里。':
    'No alerts yet — low balance, rate changes and failed collections are recorded here.',
  '上游公告': 'Upstream notices',
  '还没有读到公告。多数站点是公共接口，加了站点就会自动拉。':
    'No notices yet — most sites expose them publicly, so they arrive once a site is added.',
  '同步设置': 'Collection settings',
  '立即同步': 'Sync now',
  '同步间隔（分钟，0 = 关闭）': 'Sync interval (minutes, 0 = off)',
  '余额告警阈值（¥，0 = 不告警）': 'Low-balance threshold (¥, 0 = off)',
  '同步只读站点公开/后台数据，不打真实对话请求，所以可以比探针勤。 余额要走站点后台接口，需要先在「站点」页填「令牌」。':
    'Collection only reads public or backend data and never sends a real chat request, so it can run more often than probes. Balances come from the site backend API — fill in the site token first.',
  '耗时': 'Latency',
  '结果': 'Result',
  '上次同步 {ago}': 'Last sync {ago}',
  '还没有同步过': 'never collected',
  '拖动这张卡片调整顺序': 'Drag to reorder',
  '放到上一页': 'Move to previous page',
  '放到下一页': 'Move to next page',
  '已暂停': 'Paused',
  '暂停这个站点：不进比价、决策、探针和同步': 'Pause this site: excluded from pricing, routing, probes and sync',
  '恢复这个站点': 'Resume this site',
  '打开站点后台': 'Open site dashboard',
  '免费 {n}': 'Free {n}',
  '免费模型：{list}': 'Free models: {list}',
  '忽略模型': 'Ignored models',
  '忽略后不再参与比价、智能决策、探针和网关': 'Ignored models are excluded from pricing, routing, probes and the gateway',
  '勾上的模型不再参与比价、智能决策、探针和网关；随时可以取消勾选恢复。':
    'Checked models are excluded from pricing, routing, probes and the gateway. Uncheck anytime to restore.',
  '{n} / {total} 个模型': '{n} / {total} models',
  '{n} 个站': '{n} sites',
  '已不在榜单里': 'no longer ranked',
  '已忽略 {name}': 'Ignored {name}',
  '已恢复 {name}': 'Restored {name}',
  '刷新': 'Refresh',
  '已刷新': 'Refreshed',
  '自动刷新': 'Auto refresh',
  '每 15 秒自动刷新一次': 'Refresh every 15 seconds',
  '自动刷新已打开（15 秒）': 'Auto refresh on (15s)',
  '自动刷新已关闭': 'Auto refresh off',
  '勾上的模型不再参与比价、智能决策、探针和网关；点厂牌可整组勾选，随时取消。':
    'Checked models are excluded from pricing, routing, probes and the gateway. Click a vendor row to toggle the whole group.',
  '{n} 个模型': '{n} models',
  '已忽略「{name}」全部模型': 'Ignored every {name} model',
  // ---- 同模型合并
  '同模型合并': 'Merged model names',
  '把同一个模型的不同写法归到一起（少个 v、点写成横线、带日期尾巴）':
    'Treat different spellings of one model as the same model',
  '同一个模型在不同站写法不一（少个 v、点写成横线、带日期尾巴）时，网关会把它们当成两个模型。已归并的名字在比价、智能决策和网关模型清单里当作同一个模型。写给上游的模型名不受影响。':
    'When sites spell the same model differently (missing v, dash instead of dot, date suffix), the gateway counts them as two models. Merged spellings count as one in pricing, routing and the gateway model list. The name sent upstream is unchanged.',
  '已归并': 'Merged',
  '疑似还没合并': 'Possibly the same model',
  '这些名字差在 -thinking / -preview / -highspeed 这类尾巴上：可能只是叫法不同，也可能是真的不同型号（高速版常贵一倍）。确认价格后再合。':
    'These differ only by suffixes like -thinking / -preview / -highspeed: maybe just another name, maybe a genuinely different (often pricier) tier. Check the price before merging.',
  '没有需要归并的名字：每个模型在名下都只有一种写法。':
    'Nothing merged: every model has exactly one spelling.',
  '没有疑似未合并的写法。': 'No likely duplicates.',
  '{n} 种写法 · {s} 个站': '{n} spellings · {s} sites',
  '{n} 个模型 · {m} 种写法': '{n} models · {m} spellings',
  '拆开': 'Split',
  '手动': 'manual',
  '合并成一个': 'Merge into one',
  '已在此组': 'already here',
  '可能不同价': 'price may differ',
  '高速版/极速版通常单独计价，合并前先确认价格':
    'High-speed tiers are usually priced separately — check before merging',
  '让它自成一档，不再和别的写法合并': 'Keep this spelling separate',
  '已合并 {n} 种写法': 'merged {n} spellings',
  '这些站里同一个模型有 {n} 种写法，已合并成一行比价':
    'This model is listed under {n} spellings; they are compared as one row',
  '已合并 {n} 种写法到「{name}」': 'Merged {n} spellings into “{name}”',
  '已拆开 {name}，它不再和别的写法合并': 'Split {name}: it no longer merges with other spellings',
  '已恢复 {name} 的自动归并': 'Restored automatic merging for {name}',
  '已清空所有手动合并，全部回到自动归并': 'Cleared manual merges; everything is automatic again',
  '当前有 {n} 条手动合并。': '{n} manual merge(s).',
  '全部恢复自动': 'Reset all to automatic',
  '该站写作 {name}': 'this site spells it {name}',
  '合并 {n} 种写法': 'merged {n} spellings',
  '同一个模型的其它写法，改价会一起写进去': 'Other spellings of the same model — editing writes to all of them',
  '其中 {n} 个模型在不同站写法不一（少个 v、点写成横线等），已按同一个模型合并排序——候选里会标出「该站写作…」的那种少数派写法。要调整合并关系，去比价页的「同模型合并」。':
    '{n} model(s) are spelled differently across sites (missing v, dash instead of dot…). They are ranked as one model; minority spellings are marked “this site spells it…”. Adjust the merges on the pricing page → “Merged model names”.',
  '这些站里同一个模型有 {n} 种写法，已合并成一个模型一起排序':
    'This model is spelled {n} ways across these sites; they are ranked as one model',
  // ---- 同模型合并
  '同模型合并': 'Merge model names',
  '把同一个模型的不同写法归到一起（少个 v、点写成横线、带日期尾巴）':
    'Group the different spellings of one model (missing v, dash instead of dot, dated suffix)',
  '同一个模型在不同站写法不一（少个 v、点写成横线、带日期尾巴）时，网关会把它们当成两个模型。已归并的名字在比价、智能决策和网关模型清单里当作同一个模型。写给上游的模型名不受影响。':
    'When sites spell the same model differently (missing v, dash instead of dot, dated suffix), the gateway treats them as two models. Merged names count as one model in pricing, routing and the gateway model list. The name sent upstream is untouched.',
  '已归并': 'Merged',
  '疑似还没合并': 'Probably not merged yet',
  '这些名字差在 -thinking / -preview / -highspeed 这类尾巴上：可能只是叫法不同，也可能是真的不同型号（高速版常贵一倍）。确认价格后再合。':
    'These differ only by a -thinking / -preview / -highspeed suffix: possibly the same model, possibly a different (often pricier) tier. Check the price before merging.',
  '没有需要归并的名字：每个模型在名下都只有一种写法。':
    'Nothing to merge: every model has a single spelling here.',
  '没有疑似未合并的写法。': 'No likely unmerged spellings.',
  '{n} 种写法 · {s} 个站': '{n} spellings · {s} sites',
  '{n} 种写法': '{n} spellings',
  '拆开': 'Split',
  '手动': 'Manual',
  '合并': 'Merge',
  '用「{name}」': 'Use "{name}"',
  '可能不同价': 'price may differ',
  '高速版/极速版通常单独计价，合并前先确认价格':
    'High-speed tiers are usually priced separately — check the price first',
  '让它自成一档，不再和别的写法合并': 'Keep it separate instead of merging with other spellings',
  '用另一种写法作为合并后的名字': 'Use the other spelling as the merged name',
  '已合并 {n} 种写法到「{name}」': 'Merged {n} spellings into "{name}"',
  '已拆开 {name}，它不再和别的写法合并': 'Split {name}: it no longer merges with other spellings',
  '已恢复 {name} 的自动归并': 'Restored automatic merging for {name}',
  '已清空所有手动合并，全部回到自动归并': 'Cleared all manual merges; back to automatic merging',
  '当前有 {n} 条手动合并。': '{n} manual merges.',
  '全部恢复自动': 'Reset all to automatic',
  '该站写作 {name}': 'this site spells it {name}',
  '合并 {n} 种写法': 'merged {n} spellings',
  '同一个模型的其它写法，改价会一起写进去': 'Other spellings of the same model — editing writes to all of them',
  '其中 {n} 个模型在不同站写法不一（少个 v、点写成横线等），已按同一个模型合并排序——候选里会标出「该站写作…」的那种少数派写法。要调整合并关系，去比价页的「同模型合并」。':
    '{n} model(s) are spelled differently across sites (missing v, dash instead of dot…). They are ranked as one model; minority spellings are marked “this site spells it…”. Adjust the merges on the pricing page → “Merged model names”.',
  '这些站里同一个模型有 {n} 种写法，已合并成一个模型一起排序':
    'This model is spelled {n} ways across these sites; they are ranked as one model',
  '已恢复「{name}」全部模型': 'Restored every {name} model',
  '收起 / 展开': 'Collapse / expand',
  '刚刚': 'just now',
  '手动汇率': 'Manual rate',
  '自动 · {ago}更新': 'Auto · updated {ago}',
  '还没拉取过自动汇率': 'No auto rate fetched yet',
  '刷新汇率': 'Refresh rate',
  '恢复自动': 'Back to auto',
  '汇率已更新（手动）': 'Rate saved (manual)',
  '汇率已更新：1 美元 ≈ {rate} 元': 'Rate updated: 1 USD ≈ {rate} CNY',
  '已恢复自动汇率，下一轮会去拉取': 'Auto rate restored — will fetch on the next round',
  '汇率没更新': 'Rate was not updated',
  '还没采过': 'never',
  '{n} 分钟前': '{n} min ago',
  '{n} 小时前': '{n} h ago',
  '{n} 天前': '{n} d ago',
  '{n} 天': '{n}d',
  '{n} 条': '{n} entries',
  '还有 {n} 个': '{n} more',
  '点开看全部 {n} 个分组': 'Show all {n} groups',
  '收起，只显示前 {n} 个': 'Collapse — show the first {n}',
  '{n} 个模型': '{n} models',
  '正常': 'OK',
  '这个站采完了': 'Site collected',
  '同步完成': 'Synced',
  '同步完成，{n} 个站有问题：{error}': 'Synced — {n} sites had problems: {error}',
  '已全部标记为已读': 'Marked all as read',
  '全部站点': 'All sites',
  '还没有记录': 'Nothing yet',
  // 免费池 · 平台账号与删除
  '删掉这张卡和它的账号记录': 'Remove this card and its accounts',
  '本周期还剩 {n} {unit}': '{n} {unit} left this cycle',
  '本周期还剩 {n}/{total} {unit}': '{n}/{total} {unit} left this cycle',
  '本周期已用满，{r}重置': 'This cycle is used up — resets {r}',
  '套餐容量 {n} {unit}': 'Package capacity {n} {unit}',
  '本周期已用满，{r}重置；包内还剩 {n} {unit}':
    'This cycle is used up; resets {r}. Package still holds {n} {unit}',
  '平台已经删掉了。': 'This platform was removed.',
  '还没有账号。点「连接」授权成功后会自己建一个。':
    'No accounts yet. One is created automatically once “Connect” finishes authorizing.',
  // ZCode：额度在本机客户端里，没有网页授权
  '正在读本机客户端里的登录态…': 'Reading the sign-in state from the local client…',
  'ZCode 额度就在本机客户端里，正在读取…读到就会自动出现在卡片上。':
    'ZCode keeps its quota in the local client. Reading it now — it will appear on the card.',
  '另有赠量 {n} {unit}（按次消耗，不计入本周期）':
    'Plus {n} {unit} in bonus grants (consumed per call, not part of this cycle)',
  // 概览「需要关注」折叠
  '还有 {n} 个站点，展开全部': '{n} more sites — show all',
})

// 监控页站点卡（仿 upstream-ops 渠道卡）
Object.assign(EN, {
  '阈值 · 状态': 'Threshold · status',
  '同步这个站': 'Sync this site',
  '打开站点': 'Open site',
  '未设阈值': 'No threshold',
  '低于阈值': 'Below threshold',
  '模型价': 'Model prices',
  '上次同步': 'Last sync',
})

// 站点页并入监控页后的新文案
Object.assign(EN, {
  '余额与分组': 'Balances & groups',
  '余额趋势、倍率变动与站点管理': 'Balance trend, rate changes and site management',
  '搜索站点名或地址': 'Search by name or URL',
  '显示 {from}-{to}，共 {n} 个': 'Showing {from}-{to} of {n}',
  '{a} / {b}': '{a} / {b}',
  '没有匹配的站点。': 'No matching sites.',
  '上一页': 'Previous',
  '下一页': 'Next',
})

// ------------------------------------------------------------------ 打磨补漏
// 来源：dump-strings 渲染文案 × 词典 diff。@ 类是 title/placeholder 属性文案。
Object.assign(EN, {
  // 站点卡按钮与操作提示
  '模型、分组、价格、密钥，一键同步': 'Models, groups, prices, keys — sync all in one go',
  '从站点读分组，选你买的那个，倍率自动填到下面所有模型': 'Read groups from the site, pick the one you bought, ratios fill in automatically',
  '用管理令牌拉站方用量，和我们的估算对比': 'Pull site-side usage with the admin token and compare with our estimate',
  '站点后台的登录令牌，一次填好整站通用，用来读余额和用量': 'Admin token for the site backend — one per account, used for balance and usage',
  '拖动这张卡片调整顺序': 'Drag to reorder this site',
  '暂停这个站点：不进比价、决策、探针和同步': 'Pause this site: excluded from pricing, decisions, probes and sync',
  '恢复这个站点': 'Resume this site',
  '删除站点': 'Delete site',
  '这把 Key 属于这个分组，点这里换': 'This key belongs to this group — click to change',
  '还没选分组，点这里选（会顺便把倍率填好）': 'No group yet — click to pick one (ratios fill in too)',
  '改这里就是自定义倍率，不影响站点原始值': 'Editing here makes it a custom ratio; the site value stays untouched',
  '恢复成站点公布的倍率': 'Restore the ratio published by the site',
  '按这个模型再建一个分组': 'Duplicate this row into a new group for the same model',
  '删除这个分组': 'Delete this group',
  '删掉这个分组（Key 保留，可重新导入）': 'Delete this group (the key is kept and can re-import it)',
  '删掉这个分组（该分组下的模型记录删掉；挂在这个分组上的 Key 保留，之后在 Key 那行点「选分组」可以重新导入）':
    'Delete this group: its model rows are removed; any key bound to it is kept, and you can re-import the group from that key\u2019s “Pick group” button',
  '同一个模型在另一档套餐里也有时，复制一条单独跟踪（分组归属跟随 Key，行内不可直接改）':
    'Same model also exists in another plan? Copy one row to track it separately (group follows the key; not editable inline)',
  '删掉这个分组（比价页「＋」复制出来的，没挂 Key，别处没有删除入口）':
    'Delete this group (copied from the Pricing page with “+”; no key is bound to it, so this is the only place to remove it)',
  '忽略后不再参与比价、智能决策、探针和网关': 'Once ignored: excluded from pricing, decisions, probes and the gateway',
  '当前按倍率算，切到「价格」才能填': 'Priced by ratio now — switch to "Price" to edit',
  '当前按手填单价算，切到「倍率」才能填': 'Priced by manual unit price — switch to "Ratio" to edit',
  '优先用令牌读「可用渠道」，没有则用模型广场': 'Prefers channels API with a token; falls back to the model plaza',
  '同步间隔（分钟），0 = 关闭': 'Sync interval (minutes), 0 = off',
  '余额告警阈值（美元），0 = 不告警': 'Balance alert threshold (USD), 0 = off',
  '每 15 秒自动刷新一次': 'Auto-refresh every 15s',
  '这把 Key 属于站点的哪个分组，同步模型时会自动带上': 'Which site group this key belongs to; carried into model sync',
  '同步间隔（分钟）': 'Sync interval (min)',
  '告警阈值（$）': 'Alert threshold ($)',
  '月 token 限额（可空）': 'Monthly token limit (optional)',
  'Key 名称，如 Cherry Studio': 'Key name, e.g. Cherry Studio',
  'sk-... 粘贴完整 Key': 'sk-... paste the full key',
  '分组（可选）': 'Group (optional)',
  '标签': 'Tags',
  '搜索模型名…': 'Search models…',
  // 页面词
  '刷新': 'Refresh',
  '只同步这个站': 'Sync this site only',
  '只采这个站': 'Collect this site only',
  '切换语言': 'Language',
  '通知': 'Notifications',
  '默认': 'Default',
  '空闲': 'off-peak',
  '倍率': 'Ratio',
  '主 Key': 'Primary key',
  '已定价': 'priced',
  '未填': 'not set',
  '已填': 'set',
  '更换': 'Change',
  '填写': 'Set',
  '密钥': 'Keys',
  '一键同步': 'Sync all',
  '还没有分组': 'No groups yet',
  '未指定': 'unassigned',
  '还没同步过': 'never synced',
  '停用': 'Disabled',
  '已关闭': 'off',
  '网关未初始化': 'Gateway not initialized',
  '暂无用量数据': 'No usage yet',
  '去配置网关': 'Set up the gateway',
  '还没有基准价': 'No benchmark prices yet',
  '新增站点': 'Add site',
  '指纹不符': 'fingerprint mismatch',
  '身份自述': 'self-claimed identity',
  '首字节之前失败': 'failed before first byte',
  '首字节之后失败': 'failed after first byte',
  '采集失败': 'collect failed',
  '重试': 'retry',
  '余额读不到就留空': 'Leave balance empty when it cannot be read',
  '免费池': 'Free pool',
  '剩余': 'left',
  '未设置配额': 'No quota set',
  '中文': 'Chinese',
  '余额与花费趋势': 'Balance and spend trend',
  '显示币种': 'Display currency',
  '只影响人民币标价/展示的折算': 'Only converts CNY-listed prices for display',
  '只影响价格显示，不影响比较口径（比较一律按美元）': 'Display only — comparisons always use USD',
  '打开站点后台': 'Open site backend',
  '刷新 / 诊断': 'Refresh / diagnose',
  '同步这个站': 'Sync this site',
  '余额与分组': 'Balances & groups',
  // toast 与操作反馈
  'Key 已创建': 'Key created',
  'Key 已加密保存': 'Key saved (encrypted)',
  '站点已添加': 'Site added',
  '已同步': 'Synced',
  '这个站采完了': 'Site collected',
  '汇率已更新（手动）': 'FX rate updated (manual)',
  '配置已复制到剪贴板': 'Config copied to clipboard',
  'Key 已删除': 'Key deleted',
  '已恢复自动汇率': 'Back to auto FX',
})

// 打磨补漏（二）：模板整句与按钮 title
Object.assign(EN, {
  '按分组倍率折算': 'Priced as base price × group ratio',
  '直接填单价': 'Enter unit prices directly',
  '价格 ÷ 质量': 'price ÷ quality',
  '本次请求重试了 {n} 次': 'Retried {n} time(s) for this request',
})

// 平台积分暂停接入网关的说明条（free-platform.js）
Object.assign(EN, {
  '平台积分仅用于展示余额': 'Platform credits are display-only',
  '各平台对第三方调用检测严格（反代/客户端识别），为避免账号风控，「把平台额度接入网关代发对话」已暂停开发。这里的积分只能看、不能通过网关消耗；要在客户端用，请去对应平台自己的入口。':
    'Vendors strictly detect third-party calls (proxy / client fingerprinting). To avoid account risk, "routing platform credits through the gateway" is on hold. Credits here are view-only and cannot be consumed via the gateway — use each vendor\u2019s own entry point instead.',
})

// 按次计费（priceUnit=per_call）
Object.assign(EN, {
  '综合成本': 'Blended cost',
  '{sym}/M · 按次行 /次': '{sym}/M · per-call rows /call',
  '币种 / 单位': 'Currency / unit',
  '未填站点令牌：余额、公告、分组识别、用量核对都不可用': 'No site token: balance, announcements, group detection and usage checks are all unavailable',
  '登录态有效：账号密码登录的令牌，过期会自动续期': 'Logged in: the token comes from account login and renews itself',
  '令牌已失效：余额、公告、分组识别暂时不可用，请重新登录或填入新令牌': 'Token expired: balance, announcements and group detection are down — log in again or paste a new one',
  '已填站点令牌（非登录态）：功能可用，但不会自动续期': 'Site token filled (not a login session): works, but does not renew itself',
  '计费单位：由站点声明的计费形式识别而来；手动修改请到「站点」页的模型行': 'Unit: detected from the site-declared billing mode; edit it on the site page if needed',
  '该行的 Key 没有分组': 'The key of this row has no group',
})

// 系别自动判定
Object.assign(EN, {
  '系别由用户手动设置': 'Vendor type set manually',
  '系别由添加站点/登录时自动探测得出': 'Vendor type auto-detected when adding the site or logging in',
})

// 基准价分层折叠
Object.assign(EN, {
  '显示其余 {n} 条（未匹配本地供给）': 'Show {n} more (not referenced by local supplies)',
  '收起，只看与本地供给相关的 {n} 条': 'Collapse — show only the {n} referenced by local supplies',
})

// 分组模型悬浮抽屉（点站点卡上的分组胶囊打开）
Object.assign(EN, {
  '点开看这个分组里的模型': 'Open the models in this group',
  '已忽略': 'Ignored',
  '按次': 'Per call',
  '/次': '/call',
  '未定价': 'No price',
  '{n} 把 Key 在这个分组': '{n} key(s) on this group',
  '价格：输入 / 输出，每百万 token': 'Price: input / output per million tokens',
  '这个分组还没同步过模型。': 'No models synced for this group yet.',
  '点站点卡的「一键同步」，会按这把 Key 的分组拉一次。':
    'Hit "Sync all" on the site card — it pulls models under this key\u2019s group.',
  '这个分组没有挂 Key（多半是比价页「＋」复制出来的），不会有模型同步进来。':
    'No key is attached to this group (it was probably copied with "+" on the pricing page), so no models will sync in.',
  '其中 {n} 个已忽略：不参与比价、决策、探针和网关。':
    '{n} of them are ignored: they stay out of pricing, decisions, probes and the gateway.',
})

// 密钥面板：Key 那行的「模型数 总 / 忽略 / 可用」（点数字打开同一张模型清单）
Object.assign(EN, {
  '模型数': 'Models',
  '总': 'All',
  '忽略': 'Ignored',
  '点开看这把 Key 的模型清单': 'Open the models synced by this key',
  '忽略的模型不参与比价、决策、探针和网关':
    'Ignored models stay out of pricing, decisions, probes and the gateway',
  '这把 Key 还没同步过模型。': 'This key has not synced any models yet.',
  '点站点卡的「一键同步」，会按这把 Key 拉一次模型列表。':
    'Hit "Sync all" on the site card to pull the model list for this key.',
  '这把 Key 没有忽略的模型。': 'This key has no ignored models.',
  '这把 Key 的模型都还在用，没有被忽略的。': 'Every model of this key is in use — none ignored.',
  '这把 Key 的模型全被忽略了。': 'Every model of this key is ignored.',
  '去「忽略模型」里取消勾选，它们就会回到可用。':
    'Untick them under "Ignored models" and they become available again.',
})

// 模型行的币种「手选」标记：币种决定要不要折汇率，用户选过就不能被同步覆盖
Object.assign(EN, {
  '手选': 'Custom',
  '币种是你手选的，同步不会改它。点一下恢复跟随站点声明':
    'You picked this currency, so sync leaves it alone. Click to follow the site again.',
  '已恢复跟随站点：下次同步按站方声明的币种落价':
    'Following the site again — the next sync applies the currency the site declares.',

  // ---- 协议探查（web/protocol-view.js）
  '选择要探查的模型，或直接粘 API': 'Pick models to probe, or paste an API directly',
  '勾选任意站点 / 分组 / 模型做批量探查；每个模型发二十多个小请求。非 Anthropic 模型自动跳过 Anthropic 协议。结果不影响评分与路由。':
    'Check any sites / groups / models for a batch probe; each model sends 20+ small requests. Non-Anthropic models skip the Anthropic protocol. Results never affect scoring or routing.',
  '网关内模型': 'Gateway models',
  '手动粘贴 API': 'Paste an API',
  '站点': 'Sites',
  '分组': 'Groups',
  '模型': 'Models',
  '全选': 'All',
  'API 地址（填到 /v1）': 'API base URL (up to /v1)',
  'API Key': 'API key',
  '模型名': 'Model name',
  'Anthropic 鉴权': 'Anthropic auth',
  '自动（Bearer + x-api-key）': 'Auto (Bearer + x-api-key)',
  '只发 Bearer': 'Bearer only',
  '只发 x-api-key': 'x-api-key only',
  'Key 只在本机 daemon 内存里用一次，不写盘、不记录。官方 Anthropic 用 x-api-key，多数中转站用 Bearer。':
    'The key is used once in local daemon memory — never written to disk or logged. Official Anthropic expects x-api-key; most relays use Bearer.',
  '停止': 'Stop',
  '开始探查': 'Start probe',
  '探查中': 'Probing',
  '一次探查的模型有点多': 'That is a lot of models for one run',
  '这次要探查': 'This run probes',
  '个模型，每个模型会发二十多个小请求，可能消耗较多 Token。确定要继续吗？':
    'models; each sends 20+ small requests and may consume a fair amount of tokens. Continue?',
  '不再提示': "Don't ask again",
  '确定，开始探查': 'Yes, start probing',
  '勾选站点，这里列出它的分组': 'Check a site to list its groups here',
  '勾选分组，这里列出模型；勾选才是真正要测的': 'Check a group to list its models — checking models is what actually selects them',
  '没有可探查的站点': 'No sites to probe',
  '已忽略': 'Ignored',
  '已选': 'Selected',
  '个': '',
  '勾选站点展开分组，勾选分组展开模型；在模型列勾选才是真正要探查的，可跨站跨组任选。':
    'Check sites to reveal groups, groups to reveal models. Checking models is what picks targets — you can mix across sites and groups.',
  '个模型，预计约': 'models, about',
  '个请求': 'requests',
  '{n} 个状况不佳': '{n} in poor shape',
  '{n} 个分组没有 Key，会跳过': '{n} groups have no key and will be skipped',
  '目标': 'Target',
  '未填地址': 'no base URL',
  '未填模型': 'no model',
  '鉴权': 'Auth',
  '粘贴一个 API 地址和模型名；Key 只在本机内存里用一次。':
    'Paste a base URL and model name; the key is used once in local memory.',
  '请先填 API 地址，例如 https://api.example.com/v1': 'Enter the API base URL first, e.g. https://api.example.com/v1',
  '请先填 API Key': 'Enter the API key first',
  '请先填模型名': 'Enter the model name first',
  '请先勾选要探查的模型': 'Pick at least one model first',
  '勾选的模型所在分组都没有 Key，先去「站点」页加一个':
    'None of the picked groups has a key — add one on the Sites page first',
  '正在探查': 'Probing',
  '连接中…': 'Connecting…',
  '检测表面协议…': 'Checking surface protocols…',
  '逐项验证原生能力…': 'Verifying native capabilities…',
  '等待中': 'Waiting',
  '能力': 'Capability',
  '端点不可用，跳过能力测试': 'Endpoint unavailable, skipping capability tests',
  '本次探查': 'This probe',
  '未知错误': 'Unknown error',
  '探查失败': 'Probe failed',
  '探查对象': 'Target',
  '具备': 'Present',
  '缺失': 'Missing',
  '未测': 'Untested',
  '请求': 'Requests',
  '耗时': 'Took',
  '表面协议': 'Surface',
  '真实协议': 'Real',
  '表面：': 'Surface: ',
  '真实：': 'Real: ',
  '原生': 'Native',
  '实测': 'Measured',
  '说明': 'Notes',
  '原生基线': 'Native baseline',
  '原生协议本应具备': 'A native server would have this',
  '这个站实测': 'What this relay actually does',
  '原生协议 8 项能力全绿': 'A native server passes all 8',
  '绿': ' green',
  '红': ' red',
  '灰': ' gray',
  '{n} 项原生能力': '{n} native capabilities',
  '真实协议：': 'Real protocol: ',
  '未测 / 无法判定': 'Untested / inconclusive',
  '表面被翻译': 'Surface translated',
  '点上方胶囊看能力明细': 'Click a pill above for capability details',
  '删除记录': 'Delete record',
  '具备 / 原生基线': 'Present / native baseline',
  '未测（非 Anthropic 模型）': 'Untested (non-Anthropic model)',
  '非 Anthropic 模型': 'non-Anthropic model',
  '的表面协议背后都是': 'behind the surface is a',
  'Chat Completions 翻译层': 'Chat Completions translation layer',
  '：外形能对上，原生能力大量缺失。': ': it mimics the shape, but native capabilities are largely missing.',
  '背后是': 'behind it is',
  '：结构像原生，但关键能力有缺失。': ': shaped like the native protocol, but key capabilities are missing.',
  '不可用。': 'is not available.',
  '，原生能力完整。': ', with full native capabilities.',
  '可测的表面协议都没有被接受': 'None of the testable surface protocols were accepted',
  '先检查地址、Key 和分组权限。': 'Check the URL, key and group permissions first.',
  '无法判定': 'Inconclusive',
  '原生返回': 'Native response',
  '被翻译': 'Translated',
  '不支持': 'Unsupported',
  '请求被拒': 'Rejected',
  '鉴权被拒': 'Auth denied',
  '限流': 'Rate-limited',
  '上游错误': 'Upstream error',
  '网络错误': 'Network error',
  '已取消': 'Cancelled',
  '返回错误': 'Error body',
  '通过': 'Pass',
  '未探测': 'Never probed',
  '慢速': 'Slow',
  '结果可疑': 'Suspicious',
  '不稳定': 'Unstable',
  '没有可信样本': 'No trusted samples',
  '待验证（曾余额不足）': 'Unverified (was out of balance)',
  '证据不足': 'Inconclusive',
  '冷却中': 'Cooling down',
  '余额不足 · 请充值': 'Out of balance — top up',
  '额度不足': 'Out of quota',
  '单次请求超限': 'Request too large',
  '单次预算超限': 'Per-call budget exceeded',
  '上游账号冷却中': 'Upstream account cooling down',
  '该分组没有这个模型': 'Model not in this group',
  '限流中': 'Rate-limited',
  '模型不可用': 'Model unavailable',
  '失败率过高': 'Failure rate too high',
  '等确认恢复': 'Waiting for confirmation',
  '暂时不可用': 'Temporarily unavailable',
  '该模型当前状况不佳（慢速 / 结果可疑 / 冷却中）。协议测试可能出现偏差——红圆可能只是它暂时不在状态，不一定是协议层真的缺。':
    'This model is in poor shape right now (slow / suspicious / cooling down). Probe results may skew — red dots might be temporary, not truly missing capabilities.',
  '模型协议记录': 'Protocol records',
  '每个模型只留最新一次': 'Only the latest run per model is kept',
  '{n} 条': '{n} records',
  '清空记录': 'Clear all',
  '清空全部协议记录？': 'Clear all protocol records?',
  '查看': 'View',
  '删除': 'Delete',
  '删除失败': 'Delete failed',
  '失败': 'Failed',
  '读不到站点列表：': 'Cannot load site list: ',
  '读不到记录：': 'Cannot load record: ',
  '测时状况不佳': 'Poor shape at probe time',
  '暂停': 'paused',
  '默认分组': 'default group',
  '自动清理': 'Auto-prune',
  '删掉超过': 'Drop records older than',
  '天前的记录': 'days',
  '保存': 'Save',
  '保存失败：': 'Save failed: ',
  '手动': 'Manual',
  '没有匹配筛选的记录': 'No records match the filters',
  '还没有协议记录——去「协议探查」测一次就有了': 'No protocol records yet — run a probe on the Protocols tab first',
  '加载中…': 'Loading…',
})

// 比价组头的原厂有效成本参照 + 基准价页「模型厂商官方价」表单
Object.assign(EN, {
  '原厂': 'Official',
  '原厂价': 'Official price',
  '{detail} · 原厂有效成本 = 输入按 {w}%、输出按 {ow}% 加权；在「基准价」页可改':
    '{detail} · Official effective cost = input × {w}% + output × {ow}%; edit it on the Benchmark page',
  '原厂有效成本': 'Official effective cost',
  '模型厂商官方价（原厂价）': 'Model vendor official price',
  '这里的「官方」指模型厂商（OpenAI、Anthropic、DeepSeek 这些原厂）自己公布的定价，不是中转站的价；中转站的基准价在上面一格导入。':
    '"Official" here means the pricing published by the model vendors themselves (OpenAI, Anthropic, DeepSeek and other original providers) — not relay-station prices; the relay\u2019s benchmark prices are imported in the card above.',
  '选一个站内模型（也可以直接输入站内还没有的模型名），填原厂输入 / 输出价。保存后比价页的每个分组头部会显示它的原厂有效成本，供各站实际价做参照。':
    'Pick a site model (or type a name that is not on any site yet) and enter the vendor\u2019s official input / output price. Each group header on the Pricing page then shows its official effective cost as a reference.',
  '模型名（如 gpt-5.5）': 'Model name (e.g. gpt-5.5)',
  '原厂输入价': 'Official input price',
  '原厂输出价': 'Official output price',
  '官方价用什么币种标': 'Currency the official price is quoted in',
  '保存原厂价': 'Save official price',
  '先填模型名': 'Enter a model name first',
  '至少填一个原厂价': 'Enter at least one official price',
  '已保存 {name} 的原厂价，比价页组头会显示原厂有效成本':
    'Saved the official price of {name}; its official effective cost now shows on the Pricing page',
})

// 官方胶囊：先原价（入/出 + 单位），后有效成本
Object.assign(EN, {
  '每百万 token': 'per Mtok',
  '有效': 'effective',
})

// 币种口径（1 站内美元 = 1 人民币；R.Dollar = 真实美元）+ 官方胶囊峰谷/占比
Object.assign(EN, {
  '峰': 'peak ',
  '谷': '/off-peak ',
  '本行有效成本为原厂有效成本的 {pct}（按波峰口径）':
    'This row costs {pct} of the official effective cost (peak basis)',
  '由于中转站模板原因，1 美元 = 1 人民币。为了站内比价方便，特增加单位「真实美元 R.Dollar」：国外模型的原厂价用它填，按汇率折算；常规情况不使用 CNY。':
    'Relay templates quote in "dollars" but actually charge the same number in CNY (1 dollar = 1 CNY). For easier comparison we add the unit "Real Dollar (R.Dollar)": use it for official vendor prices of foreign models, converted by the FX rate. Avoid CNY in normal cases.',
  '真实美元 R.Dollar = 国外模型原厂价专用，按汇率换算；站内美元与人民币 1:1':
    'Real Dollar (R.Dollar) is for official vendor prices of foreign models, converted by the FX rate; site dollars equal CNY 1:1',
  '只用于「真实美元 R.Dollar」的换算（国外模型原厂价）；站内价格不受影响':
    'Only used to convert Real Dollars (R.Dollar, official vendor prices of foreign models); site prices are unaffected',
  '只影响价格显示的符号；站内美元与人民币 1:1，数值不变':
    'Only switches the displayed symbol; site dollars equal CNY 1:1, the number stays the same',
  '价格直接改，失焦即保存。「{sym}/百万 token」是综合成本：输入按 25%、输出按 75% 加权。中转站按美元标价、实际按人民币 1:1 扣费，所以这里的 $ 和 ¥ 是同一个数。':
    'Edit inline, saved on blur. "{sym}/Mtok" is the blended cost: input 25% + output 75%. Relays quote in dollars but charge the same number in CNY, so $ and ¥ mean the same number here.',
})

// 币种三选项（CNY / USD / R.Dollar）+ 官方成本表单两行（波峰/波谷）
Object.assign(EN, {
  '波峰': 'Peak',
  '波谷': 'Off-peak',
  '波谷输入价': 'Off-peak input price',
  '波谷输出价': 'Off-peak output price',
  '波峰行至少填一个原厂价': 'Fill at least one official price in the peak row',
  '两格都留空 = 默认计价（无峰谷）；填了则比价组头分「峰 / 谷」展示两个有效成本。通用字段，任何模型都能用。':
    'Leave both empty for flat pricing (no peak/off-peak). Fill them and the pricing header shows two effective costs, peak / off-peak. Generic field — works for any model.',
  '真实美元 R.Dollar：国外模型专用，按汇率换算；站内美元与人民币 1:1':
    'Real Dollar (R.Dollar): for foreign models, converted by the FX rate; site dollars equal CNY 1:1',
})
