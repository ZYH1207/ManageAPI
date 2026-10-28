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
  [/^(.+) 官方降价$/, '$1 official price dropped'],
  [/^(.+) 恢复供给$/, '$1 is back'],
  [/^(.+) ([\d.]+) → ([\d.]+)$/, '$1 $2 → $3'],
  [/^同样用 (.+)，现在选「(.+)」最划算$/, 'Same $1 — cheapest at "$2" right now'],
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
  '切换语言': 'Switch language',
  '个人专属API网关': 'Your personal API gateway',
  '这个工具怎么用、为什么这么设计': 'How to use it, and why it works this way',

  // ---- 顶栏 / 通知
  '通知': 'Notifications',
  '全部已读': 'Mark all read',
  '条未读': 'unread',

  // ---- 页面副标题
  '当前状态一眼看完': 'Everything at a glance',
  '同一模型跨站对比': 'Cross-site comparison',
  '候选排序与手动调整': 'Candidates and manual order',
  '指纹 / 截断 / 计费 / 缓存': 'Fingerprint / truncation / billing / cache',
  '一个入口接管全部流量': 'One endpoint for all traffic',
  '按 Key / 模型 / 站点统计': 'By key / model / site',
  '倍率换算的参照物': 'The baseline for ratio conversion',

  // ---- 通用
  '保存': 'Save',
  '站点地址': 'Site addresses',
  '网站地址': 'Site URL',
  'API 端点': 'API endpoint',
  '地址': 'Addresses',
  '只用于卡片上的「打开站点」按钮，填后台网址即可': 'Only used by the card\u2019s "open site" button — paste the dashboard URL',
  '程序真正请求的地址，一般形如 https://站点域名/v1': 'The address the app actually calls, usually https://your-site/v1',
  '网站地址用于卡片链接；API 端点也可以直接在「密钥」里随 Key 一起填。':
    'The site URL drives the card link; the API endpoint can also be set alongside a key under "Keys".',
  '程序真正请求的地址。留空则沿用这个站已保存的端点；没写 /v1 会自动补':
    'The address the app actually calls. Leave empty to keep the saved endpoint; /v1 is appended automatically',
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
  '选分组': 'Pick group',
  '分组倍率': 'Group ratios',
  '全部恢复为站点值': 'Restore all to site values',
  '改一次，该分组所有模型一起变': 'One edit updates every model in this group',
  '还没有 Key，加一个才能拉模型。': 'No key yet — add one to sync models.',
  '余额未录入': 'Balance not set',
  '从站点读分组，选你买的那个，倍率自动填到下面所有模型': 'Read groups from the site, pick yours, ratios fill in below',
  '用管理令牌拉站方用量，和我们的估算对比': 'Pull the site\u2019s own usage and compare with our estimate',
  '这把 Key 属于这个分组，点这里换': 'This key belongs to this group — click to change',
  '还没选分组，点这里选（会顺便把倍率填好）': 'No group yet — click to pick one (ratios fill in too)',
  '这把 Key 属于站点的哪个分组，同步模型时会自动带上': 'Which group this key belongs to; carried into model sync',
  '改这里就是自定义倍率，不影响站点原始值': 'Editing here is a custom ratio; the site value is kept',
  '恢复成站点公布的倍率': 'Restore the ratio published by the site',
  '把这个站所有自定义倍率改回站点公布的值': 'Reset every custom ratio on this site',
  '扣费核对': 'Billing check',

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
  '未截断': 'Not truncated',
  '已截断': 'Truncated',
  '计费正常': 'Billing normal',
  '次': 'runs',

  // ---- 网关
  '网关地址': 'Gateway URL',
  '关闭网关': 'Turn off gateway',
  '开启网关': 'Turn on gateway',
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
  '网关已关闭': 'Gateway off',

  // 概览 / 决策 / 探针的状态说明
  '默认按「有效成本 = 价格 ÷ 质量」排序，用 ↑↓ 手动调整「可用」那几条的先后——不可信的站不会因为你拖它而排到前面。':
    'Sorted by effective cost (price ÷ quality). Use ↑↓ to reorder the available ones — an untrusted site will not move up just because you drag it.',

  // 比价
  '价格直接改，失焦即保存。「{sym}/百万 token」是综合成本：输入按 25%、输出按 75% 加权。人民币标价的站按「基准价」页里的汇率折算成美元比较。':
    'Edit prices inline; saved on blur. {sym}/Mtok is a blended cost: 25% input, 75% output. CNY-priced sites convert at the rate on the Benchmarks page.',
  '{sym}/百万 token': '{sym}/Mtok',

  // 探针
  '主动探测': 'Active probing',
  '每个模型发 5 个请求：指纹 + 计费、截断、缓存（连发两次）、身份自述。结果进入评分，路由据此排除可疑的站。':
    'Five requests per model: fingerprint + billing, truncation, cache (twice), self-identification. The results feed the score that routing uses to exclude suspicious sites.',
  '探测全部（最多 5 个）': 'Probe all (max 5)',
  '指纹 100% 表示每次都精确返回了要求的内容，低于这个值说明上游可能把请求转给了别的模型。 截断一栏是「没被截断」的比例，计费一栏是「用量正常」的比例。':
    'Fingerprint 100% means the exact requested output came back every time; lower means the upstream may be rerouting. Truncation is the share not truncated; Billing is the share with normal usage.',

  // 网关
  '网关入口': 'Gateway endpoint',
  '路由决策': 'Routing decisions',

  // 用量
  '柱高按 token 总量，悬停看当天明细。': 'Bar height is total tokens; hover for that day.',

  // 基准价（<b>标题</b> 后面的片段）
  '：优先用「令牌」读该站的「可用渠道」（数据最全，不要求开广场），读不到再回落「模型广场」。只补空缺、不覆盖你已有的条目。':
    ': reads the site\u2019s available channels with a token (richest data, no plaza needed), falling back to the model plaza. Only fills gaps, never overwrites.',
  '：用工具内置的一份官方价（截至 ': ': uses the built-in official price list (as of ',
  '），价格常变，务必核对。': '). Prices change often — verify before relying on it.',

  // 站点页的令牌说明（整段走 t()，带 <code> 标记）

  // 概览的一句话结论（带 <strong>）
  '同样用 {model}，现在选「{provider}」最划算：{price}/百万 token，比最贵的站省 {pct}%。':
    'For {model}, {provider} is the best deal right now: {price}/Mtok — {pct}% less than the priciest site.',
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
  '已保存': 'Saved',
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
  '分组': 'Groups',
  '配额': 'Quota',
  '指纹': 'Fingerprint',
  '首字': 'TTFT',
  '状态': 'Status',

  '还没有免费模型': 'No free models yet',
  '去站点导入': 'Import from sites',

  '还没有连接平台': 'No platform connected',

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
  '真实花费': 'Actual spend',
  '数字直接来自站点自己的账单接口，按天汇总，不是本地估算。':
    'The number comes straight from the site\u2019s own billing API, summed per day. It is not a local estimate.',
  '只有当站点开放用量接口、且填了有效令牌时才有数；读不到显示「读不到账单」，不会拿估算顶替。':
    'It only exists when the site exposes a usage API and a valid token is set; otherwise it shows "no bill" rather than substituting an estimate.',
  '它包含这个站当天的全部消耗，包括探针自检产生的请求。':
    'It covers everything this site charged that day, including the requests made by probing itself.',
  '和历史某天对不上时，是因为账单可回溯，而本工具只会保留最近 45 天。':
    'If an older day looks off, remember the site can bill retroactively while this tool only keeps the last 45 days.',
  // 词典补漏：t() 用到但此前缺失的条目（英文界面之前会回落成中文）
  '诊断信息': 'Diagnostics',
  '下面这段可以直接全选复制，发给开发者定位问题。': 'Select the block below and send it to the developer to help pin down the issue.',
  '还没有读到分组倍率。点「导入倍率」从站点读一次，或在下面手动填。': 'No group rates yet. Click "Import rates" to read them from the site, or fill them in manually below.',
  '/次': '/call',
  '已忽略 {n}': '{n} ignored',
  '没有匹配的模型。': 'No matching models.',
  '{n} 个账号': '{n} account(s)',
  '已打开授权页。在浏览器里登录，如果弹出「打开 WorkBuddy」，先点取消、留在网页上，直到页面显示授权成功。': 'Authorization page opened. Log in within the browser; if an "Open WorkBuddy" prompt appears, dismiss it and stay on the page until it shows success.',
  '「令牌」在站点卡片上（不在 Key 上）——它是站点后台的登录凭证，一个后台账号填一次，整站通用。获取：登录后台 → F12 → Network → 点任意 <code>/api/v1/</code> 请求 → 复制 Request Headers 里的 <code>Authorization</code>（去掉 <code>Bearer </code> 前缀）。令牌会过期，失效后重新复制。填了令牌后会自动识别这个站是哪一系。':
    'The "token" lives on the site card (not on a key) — it is the site dashboard login credential: one per dashboard account, shared by the whole site. To get it: log in → F12 → Network → click any <code>/api/v1/</code> request → copy <code>Authorization</code> from Request Headers (drop the <code>Bearer </code> prefix). Tokens expire; copy a fresh one when they do. Saving it also auto-detects which relay family the site is.',
  '余额合计': 'Total balance',
  '读不到账单': 'No bill',
  '{n} 个站点账单': 'Bills from {n} sites',
  '站点未提供账单接口或令牌无效': 'Site has no billing API or the token is invalid',
  '截至 {time}': 'as of {time}',
  '有明细未拉全': 'some records not fetched',
  '花费合计': 'Total spend',
  '余额': 'Balance',
  '全部站点': 'All sites',
  '只看这个站': 'Show only this site',
  '余额合计（{sym}，其他币种按汇率折算）': 'Total balance ({sym}, other currencies converted)',
  '该站余额（{sym}）': 'Site balance ({sym})',
  '各站花费（堆叠）': 'Spend by site (stacked)',
  '该站每日花费': 'Daily spend for this site',
  '充值汇率': 'Top-up rate',
  '令牌尾号': 'Token tail',
  '「令牌」是站点后台的登录凭证，一次填好整站通用，用来读余额、公告和分组': 'The token is the site login credential — fill it once per site for balance, announcements and groups',
  '未填站点令牌': 'No site token',
  '站点充值汇率：充 1 元到账多少站点额度。1:1 充值的站填 1；充 ¥100 到账 $120 填 0.83。留空 = 按市场汇率折算。「实际消费」用它把站点账单换算成人民币。': 'Top-up rate: how much site credit ¥1 buys. 1:1 sites enter 1; ¥100 for $120 → 0.83. Empty = market rate. Actual spend converts the site bill with it.',
  '今天': 'Today',
  '本周': 'This week',
  '本月': 'This month',
  '模型消费 / 实际消费': 'Model spend / actual spend',
  '模型消费': 'Model spend',
  '实际消费': 'Actual spend',
  '置信度高': 'high confidence',
  '置信度中': 'medium confidence',
  '置信度低（样本少）': 'low confidence (few samples)',
  '最近证据': 'Latest evidence',
  '最近一次有效证据（探针或真实调用）': 'Most recent evidence (probe or real call)',
  '探针：': 'probe: ',
  // 冷却中的供给（额度不足 / 限流 / 模型不在分组）：不是坏了，只是此刻别派过去
  '额度不足': 'Out of credit',
  '单次预算超限': 'Request over budget',
  '限流中': 'Rate limited',
  '模型不可用': 'Model unavailable',
  '暂时不可用': 'Temporarily unavailable',
  '冷却中': 'cooling down',
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
})

// 免费页 · 平台侧「手动添加」表单
Object.assign(EN, {
  '手动添加': 'Add manually',
  '连接平台': 'Connect platform',
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
})

Object.assign(EN, {
  '实验性': 'Experimental',
  '自动连接使用平台未公开接口，可能随平台升级失效':
    'Auto-connect uses an undocumented platform API and may break when the platform updates',
})

// 站点级令牌与余额
Object.assign(EN, {
  '站点余额': 'Site balance',
  '「令牌」在站点卡片上（不在 Key 上）——它是站点后台的登录凭证，一个后台账号填一次，整站通用。获取：登录后台 → F12 → Network → 点任意 <code>/api/v1/</code> 请求 → 复制 Request Headers 里的 <code>Authorization</code>（去掉 <code>Bearer </code> 前缀）。令牌会过期，失效后重新复制。':
    'The token lives on the site card, not on individual keys — it is the backend login credential, entered once per backend account and shared by the whole site. To get it: log in → F12 → Network → click any <code>/api/v1/</code> request → copy <code>Authorization</code> from Request Headers (drop the <code>Bearer </code> prefix). Tokens expire; copy a fresh one when they do.',
})

Object.assign(EN, {
  '识别分组': 'Detect groups',
})

Object.assign(EN, {
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
})

Object.assign(EN, {
  '剩余 {n} {unit}': '{n} {unit} left',
})

// 监控页
Object.assign(EN, {
  '监控': 'Monitor',
  '正在读取监控数据…': 'Loading monitor data…',
  '第一次打开会现采一轮，稍等一下。': 'The first open runs one collection round — give it a moment.',
  '还没有中转站': 'No upstream sites yet',
  '有余额数据': 'with balance data',
  '总余额': 'Total balance',
  '24 小时变动': 'Changes (24h)',
  '倍率 / 价格': 'rates / prices',
  '未读告警': 'Unread alerts',
  '还没有余额数据': 'no balance yet',
  '最低：{name} {amount}': 'Lowest: {name} {amount}',
  '余额概览': 'Balance overview',
  '还没有同步到余额。点右上角「立即同步」跑一轮。':
    'No balance collected yet — hit "Collect now" to run a round.',
  // 图例符号是动态的（显示币种），用 {sym} 占位符；旧的整串 key 已对不上当前文案
  '总余额（{sym}，其他币种按汇率折算）': 'Total balance ({sym}; other currencies converted at the current rate)',
  '≈ ¥{cny}（按汇率折算）': '≈ ¥{cny} at the current rate',
  '显示币种': 'Display currency',
  '只影响价格显示，不影响比较口径（比较一律按美元）': 'Display only — comparisons always use USD',
  '只影响人民币标价/展示的折算': 'Only used to convert CNY prices for display',
  '显示币种已切换': 'Display currency switched',
  '余额与花费趋势': 'Balance and spend trend',
  '只采这个站': 'Collect this site',
  '无数据': 'no data',
  '最近倍率变动': 'Recent rate changes',
  '还没有变动。第一次同步只记基线，之后才开始比较。':
    'No changes yet — the first collection only records a baseline.',
  '低于阈值 {amount}': 'below threshold {amount}',
  '{n} 个模型有官方价': '{n} models with published prices',
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
  '同步只读站点公开/后台数据，不打真实对话请求，所以可以比探针勤。 余额要走站点后台接口，需要先在「站点」页填「令牌」。':
    'Collection only reads public or backend data and never sends a real chat request, so it can run more often than probes. Balances come from the site backend API — fill in the site token first.',
  '耗时': 'Took',
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
  '{n} 个模型': '{n} models',
  '正常': 'OK',
  '这个站采完了': 'Site collected',
  '同步完成': 'Synced',
  '同步完成，{n} 个站有问题：{error}': 'Synced — {n} sites had problems: {error}',
  '已全部标记为已读': 'Marked all as read',
  '全部站点': 'All sites',
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
  '同步模型 + 读余额 + 识别分组，一次跑完': 'Sync models + read balance + detect groups, in one go',
  '从站点读分组，选你买的那个，倍率自动填到下面所有模型': 'Read groups from the site, pick the one you bought, ratios fill in automatically',
  '用管理令牌拉站方用量，和我们的估算对比': 'Pull site-side usage with the admin token and compare with our estimate',
  '拖动这张卡片调整顺序': 'Drag to reorder this site',
  '暂停这个站点：不进比价、决策、探针和同步': 'Pause this site: excluded from pricing, decisions, probes and sync',
  '恢复这个站点': 'Resume this site',
  '删除站点': 'Delete site',
  '这把 Key 属于这个分组，点这里换': 'This key belongs to this group — click to change',
  '还没选分组，点这里选（会顺便把倍率填好）': 'No group yet — click to pick one (ratios fill in too)',
  '改这里就是自定义倍率，不影响站点原始值': 'Editing here makes it a custom ratio; the site value stays untouched',
  '恢复成站点公布的倍率': 'Restore the ratio published by the site',
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
  '上移': 'Up',
  '下移': 'Down',
  '刷新': 'Refresh',
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
  '同步记录': 'Sync log',
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
  '同样用 {model}，现在选「{provider}」最划算：{price}/百万 token，比最贵的站省 {pct}%。':
    'Same {model} — "{provider}" is the cheapest now: {price}/M tok, {pct}% cheaper than the priciest.',
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
