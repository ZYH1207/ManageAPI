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
  '网关': 'Gateway',
  '一个入口接管': 'One endpoint',
  '用量': 'Usage',
  '消耗统计': 'Token spend',
  '基准价': 'Benchmarks',
  '官方价参照': 'Official reference prices',
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
  '全部已读': 'Mark all read',
  '暂无通知': 'Nothing to notify',
  '条未读': 'unread',

  // ---- 页面副标题
  '当前状态一眼看完': 'Everything at a glance',
  '中转站、Key 与分组倍率': 'Relays, keys and group ratios',
  '同一模型跨站对比': 'Cross-site comparison',
  '候选排序与手动调整': 'Candidates and manual order',
  '指纹 / 截断 / 计费 / 缓存': 'Fingerprint / truncation / billing / cache',
  '一个入口接管全部流量': 'One endpoint for all traffic',
  '按 Key / 模型 / 站点统计': 'By key / model / site',
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
  '上移': 'Move up',
  '下移': 'Move down',
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
  '还没有 Key，加一个才能拉模型。': 'No key yet — add one to sync models.',
  '余额未录入': 'Balance not set',
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
  '从站点导入官方价': 'Import official prices',
  '以此站已填价为准': 'Use this site\u2019s prices',
  '载入内置参考价': 'Load built-in prices',
  '空闲输入': 'Off-peak in',
  '空闲输出': 'Off-peak out',
  '基准价是「倍率」的换算参照。三条路：从站点导入官方价、以此站已填价为准、或载入内置参考价。':
    'Benchmarks are what ratios convert against. Three sources: import official prices from a site, use a site\u2019s own prices, or load the built-in list.',
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
  '分组': 'Group',
  '30 天 token': '30-day tokens',
  '默认 Key': 'Default key',
  '运行中': 'running',
  '网关运行中': 'Gateway running',
  '网关已关闭': 'Gateway off',

  // 概览 / 决策 / 探针的状态说明
  '默认按「有效成本 = 价格 ÷ 质量」排序，用 ↑↓ 手动调整「可用」那几条的先后——不可信的站不会因为你拖它而排到前面。':
    'Sorted by effective cost (price ÷ quality). Use ↑↓ to reorder the available ones — an untrusted site will not move up just because you drag it.',
  '注意：同一个模型在不同站的状态是各自独立的（A 站掉包，B 站却完全正常），所以这里按「站 × 模型」逐条评估，状态下方会写明具体原因。':
    'Note: the same model can be fine on one site and swapped on another, so each site × model is judged on its own. The reason is shown under the status.',

  // 比价
  '价格直接改，失焦即保存。「¥/百万 token」是综合成本：输入按 25%、输出按 75% 加权（权重可在左下角汇率旁调）。':
    'Edit prices inline; saved on blur. ¥/Mtok is a blended cost: 25% input, 75% output (weight sits next to the FX box).',

  // 探针
  '主动探测': 'Active probing',
  '每个模型发 5 个请求：指纹 + 计费、截断、缓存（连发两次）、身份自述。结果进入评分，路由据此排除可疑的站。':
    'Five requests per model: fingerprint + billing, truncation, cache (twice), self-identification. The results feed the score that routing uses to exclude suspicious sites.',
  '探测全部（最多 5 个）': 'Probe all (max 5)',
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
  '：用工具内置的一份官方价（截至 ': ': uses the built-in official price list (as of ',
  '），价格常变，务必核对。': '). Prices change often — verify before relying on it.',

  // 站点页的令牌说明（整段走 t()，带 <code> 标记）
  '「令牌」是站点后台的登录凭证，只用来读余额、不参与对话。获取：登录后台 → F12 → Network → 点任意 <code>/api/v1/</code> 请求 → 复制 Request Headers 里的 <code>Authorization</code>（去掉 <code>Bearer </code> 前缀）。令牌会过期，失效后重新复制。':
    'The token is your site login credential — used only to read balance and usage, never for chat. To get it: log in → F12 → Network → click any <code>/api/v1/</code> request → copy <code>Authorization</code> from Request Headers (drop the <code>Bearer </code> prefix). Tokens expire in 7–30 days; copy a fresh one when they do.',

  // 概览的一句话结论（带 <strong>）
  '{model} 目前 {provider} 最便宜，{price}/百万 token，比最贵的省 {pct}%':
    '{provider} is the cheapest for {model} at {price}/Mtok — {pct}% below the priciest',
})

// 第三遍：按真实渲染出来的原文校正（词典 key 必须是「空白已归一化」的原文）
Object.assign(EN, {
  '0 = 不限；超过上限的供给不参与路由': '0 = no limit; slower supplies are excluded from routing',
  '：把这个站已经填好的实际价整体设为基准，适合你确信它没虚标的情况。':
    ': takes this site\u2019s existing prices as the baseline — use it when you trust the site.',
  '：用工具内置的一份官方价（截至': ': uses the built-in official price list (as of',
  '给每个客户端单独一把 Key，用量才能分开统计；哪一把泄露了，单独轮换即可。':
    'One key per client so usage stays attributable; a leaked key can be rotated on its own.',
  '月 token 限额（可空）': 'Monthly token limit',
  '选一个站，一键拉取。有「令牌」读可用渠道、没令牌读模型广场。 只补空缺，不覆盖你已有的':
    'Pulls from one site. With a token it reads available channels, otherwise the model plaza. Only fills gaps, never overwrites.',
})

// 基准价三条说明整段走 t()（带 <b>/<br> 标记），避免按片段匹配出错
Object.assign(EN, {
  '<b>从站点导入官方价</b>：优先用「令牌」读该站的「可用渠道」（数据最全，不要求开广场），读不到再回落「模型广场」。只补空缺、不覆盖你已有的条目。<br />':
    '<b>Import official prices</b>: reads the site\u2019s available channels with a token (richest data, no plaza needed), falling back to the model plaza. Only fills gaps, never overwrites.<br />',
  '<b>以此站已填价为准</b>：把这个站已经填好的实际价整体设为基准，适合你确信它没虚标的情况。<br />':
    '<b>Use this site\u2019s prices</b>: takes this site\u2019s existing prices as the baseline — use it when you trust the site.<br />',
  '<b>载入内置参考价</b>：用工具内置的一份官方价（截至 {asOf}），价格常变，务必核对。':
    '<b>Load built-in prices</b>: uses the bundled official price list (as of {asOf}). Prices change often — verify before relying on it.',
})

Object.assign(EN, {
  '注意：<b>同一个模型在不同站的状态是各自独立的</b>（A 站健康、B 站掉包很正常），所以这里按「站 × 模型」逐条评估，状态下方会写明具体原因。':
    'Note: <b>the same model can be healthy on one site and swapped on another</b>, so each site × model is judged on its own. The reason appears under the status.',
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
  '已恢复自动排序': 'Back to automatic order',
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
  '正在应用中…': 'Applying…',
})

// 带变量的提示：整句用正则，避免在模板里塞 t()
const PATTERNS_MORE = [
  [/^导入 (\d[\d,]*) 条基准价$/, 'Imported $1 benchmark prices'],
  [/^已创建分组「(.+)」，记得填它的价格$/, 'Created group "$1" — remember to set its price'],
  [/^已复制「(.+)」的 Key$/, 'Copied the key for "$1"'],
  [/^拉到 (\d[\d,]*) 个模型，新增 (\d[\d,]*)（(.+)）$/, '$1 models fetched, $2 new ($3)'],
  [/^探测 (\d[\d,]*) 个，成功 (\d[\d,]*)$/, 'Probed $1, $2 succeeded'],
  [/^探测失败：(.+)$/, 'Probe failed: $1'],
  [/^评分有效期改为 (\d+) 小时$/, 'Score TTL set to $1 hours'],
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

// 放行可疑供给（开关）
Object.assign(EN, {
  '太慢': 'Too slow',
  '已放行': 'allowed',
  '放行可疑供给': 'Allow suspicious supplies',
  '探针判定可疑（指纹不符 / 输出截断 / 用量虚报 / 评分过期）的站，也按有效成本正常参与路由':
    'Sites the probes flagged (fingerprint mismatch, truncated output, inflated usage, expired score) also compete on effective cost',
  '已放行：可疑的站会正常参与选站':
    'Enabled: suspicious sites now take part in routing',
  '它们仍然按「价格 ÷ 质量」排序——质量差一半，成本就翻倍，只有便宜到足够多才会被选中。首字上限仍然独立生效。如果你更在意输出是否可信，把这个开关关掉。':
    'They still sort by price ÷ quality, so half the quality doubles the cost — only a large enough discount wins. The TTFT limit still applies separately. Turn this off if you care more about trustworthy output.',
  '已放行可疑供给，它们会正常参与选站': 'Suspicious supplies are now allowed to compete',
  '已恢复：可疑供给只作为最后兜底': 'Restored: suspicious supplies are only a last resort',
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
  '分组': 'Group',
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
