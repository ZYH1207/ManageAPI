/**
 * 数据比价页自检（Node 直接跑，不需要浏览器）。
 *
 * ## 这一页要回答什么
 *
 * 用户的原话是「想知道到底哪家实惠」，且明确要求**统计全站的**——
 * 「这个功能就是为了看到底哪家实惠，必须把全站的都加进来才叫统计实惠」。
 * 所以这里钉住的第一件事就是：默认口径必须是全站，不能悄悄收窄。
 *
 * ## 这个文件测什么、不测什么
 *
 * 判定逻辑（每站收敛、领先幅度、实测标签）是纯函数，**用真数据算**；
 * 页面结构是模板字符串，失败方式是「不抛异常但行为不对」，所以做源码契约断言。
 *
 *   A. 口径：默认全站、非法值回落全站、两档共用同一个入口
 *   B. 每站收敛：一个站只出一个报价（它最便宜那条线），其余线挂在 otherLines
 *   C. 领先幅度：只有一个站时是 null（不是 0——0 会被读成「打平」）
 *   D. 实测标签：0 样本 = 未实测，不下「可疑」判定
 *   E. 全站口径确实绕开了忽略名单，routed 口径确实套上了
 *   F. 页面：nav 入口、按需拉取（不进 /api/state）、开关与展开处理器
 *   G. 样式与文案齐备
 *
 * ⚠️ 它**不**证明页面长对了。真实渲染由 CDP 探针验证（见交付说明）。
 *
 * 用法：node .test/check-price-board.mjs
 */
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 用 fileURLToPath 而不是 URL.pathname：仓库路径含中文，
// pathname 会给出百分号编码，readFile 直接 ENOENT。
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const core = join(root, 'core')

const pb = await import(join(core, 'price-board.js'))
const { offerCost } = await import(join(core, 'pricing.js'))

let failed = 0
const ok = (cond, msg, extra = '') => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}${extra ? `  ${extra}` : ''}`)
  }
}

// ---------------------------------------------------------------- 合成数据
//
// 用构造数据而不是真实库：真实库随用户操作变化（忽略名单、站点开关），
// 拿它当断言基准，测试会跟着用户的鼠标红绿。真实库只在最后做一次冒烟。
const makeOffer = (over = {}) => ({
  id: 'o_x',
  providerId: 'p_a',
  credentialId: 'c_x',
  upstreamName: 'm',
  modelKey: 'm',
  group: 'g',
  inPrice: 2,
  outPrice: 10,
  ratio: 1,
  // 倍率只在 ratio 模式下生效（manual 模式直接用 inPrice/outPrice）。
  // 默认给 ratio：本文件绝大多数用例靠倍率拉开价差。
  pricingMode: 'ratio',
  currency: 'USD',
  priceUnit: 'per_mtok',
  ...over,
})
const settings = { blendInputWeight: 0.25 }
const benchmarks = {}
const noScores = new Map()
const ctxOf = (providers) => ({ providers, aliases: {} })

console.log('[A] 口径：默认全站，非法值回落全站')
{
  ok(pb.PRICE_BOARD_SCOPE_DEFAULT === 'all', '默认口径常量就是 all')
  ok(pb.normalizePriceBoardScope(undefined) === 'all', 'undefined → all')
  ok(pb.normalizePriceBoardScope('') === 'all', '空串 → all')
  ok(pb.normalizePriceBoardScope('乱写') === 'all', '非法值 → all（不因为脏值把页面清空）')
  ok(pb.normalizePriceBoardScope('ROUTED') === 'routed', '大小写归一')
  ok(pb.normalizePriceBoardScope('routed') === 'routed', 'routed 原样')
  ok(Array.isArray(pb.PRICE_BOARD_SCOPES) && pb.PRICE_BOARD_SCOPES.length === 2, '只有两档')
}

console.log('[B] 每站收敛：一个站只出一个报价')
{
  // 同一站三条线，倍率 0.5 / 0.1 / 1.0 —— 最低应该是 0.1 那条
  const offers = [
    makeOffer({ id: 'o_hi', group: '贵线', ratio: 1 }),
    makeOffer({ id: 'o_lo', group: '便宜线', ratio: 0.1 }),
    makeOffer({ id: 'o_mid', group: '中间线', ratio: 0.5 }),
  ]
  const boards = pb.buildPriceBoard(offers, settings, benchmarks, noScores, ctxOf([{ id: 'p_a', name: '甲站' }]))
  ok(boards.length === 1, '三条线合并成一个模型行')
  const b = boards[0]
  ok(b.siteCount === 1, '只算出一个站')
  ok(b.cheapest.group === '便宜线', '取的是最低倍率那条线', b.cheapest.group)
  ok(b.cheapest.lineCount === 3, 'lineCount 记了该站一共几条线')
  ok(b.cheapest.otherLines.length === 2, '其余两条挂在 otherLines')
  ok(
    b.cheapest.otherLines.every((l) => l.blendedCnyPerMtok > b.cheapest.blendedCnyPerMtok),
    'otherLines 里都是比最低线贵的',
  )
  // deltaPct 相对本站最低线：0.5/0.1 - 1 = 400%
  const mid = b.cheapest.otherLines.find((l) => l.group === '中间线')
  ok(mid.deltaPct === 400, 'deltaPct 相对本站最低线算（0.5 vs 0.1 = 400%）', String(mid?.deltaPct))
}

console.log('[B2] allLines：展开用的全部线路，按价升序')
{
  const offers = [
    makeOffer({ id: 'o_a1', providerId: 'p_a', group: 'A贵', ratio: 1 }),
    makeOffer({ id: 'o_a2', providerId: 'p_a', group: 'A便宜', ratio: 0.1 }),
    makeOffer({ id: 'o_b1', providerId: 'p_b', group: 'B线', ratio: 0.5 }),
  ]
  const b = pb.buildPriceBoard(offers, settings, benchmarks, noScores, ctxOf([
    { id: 'p_a', name: '甲站' },
    { id: 'p_b', name: '乙站' },
  ]))[0]
  ok(Array.isArray(b.allLines), '有 allLines 字段')
  ok(b.allLines.length === 3, '全部线路都列出来（含同站更贵的那条）', String(b.allLines.length))
  ok(
    b.allLines.every((l, i, arr) => i === 0 || arr[i - 1].blendedCnyPerMtok <= l.blendedCnyPerMtok),
    'allLines 按混合价升序',
  )
  ok(b.allLines[0].group === 'A便宜', '第一条就是全场最低那条线')
  ok(b.allLines.every((l) => l.providerName && typeof l.evidence?.label === 'string'), '每条线都带站名与实测标签')
  // sites 是「每站收敛」，allLines 是「全部明细」——两者数量关系必须成立
  ok(b.allLines.length >= b.sites.length, 'allLines 条数不少于收敛后的站数')
}

console.log('[B3] allLines 去重：同站同分组同价只留一条')
{
  // 秋实测有「国模-0055 p哥」两条：两个 Key 拉回同一分组同一模型，价格一模一样
  const offers = [
    makeOffer({ id: 'o_dup1', providerId: 'p_a', group: '同名分组', ratio: 0.1, credentialId: 'c_1' }),
    makeOffer({ id: 'o_dup2', providerId: 'p_a', group: '同名分组', ratio: 0.1, credentialId: 'c_2' }),
    makeOffer({ id: 'o_other', providerId: 'p_a', group: '另一分组', ratio: 0.2 }),
  ]
  const scores = new Map([['o_dup2', { samples: 9, trafficSamples: 0 }]])
  const b = pb.buildPriceBoard(offers, settings, benchmarks, scores, ctxOf([{ id: 'p_a', name: '甲站' }]))[0]
  ok(b.allLines.length === 2, '同站同分组同价的两条并成一条', String(b.allLines.length))
  const kept = b.allLines.find((l) => l.group === '同名分组')
  ok(kept.evidence.samples === 9, '去重时保留证据更多的那条', String(kept?.evidence.samples))
}

console.log('[B4] 厂牌归类：同一家公司不许分成两张卡')
{
  const relay = await import(join(root, 'web', 'free-relay.js'))
  const cases = [
    ['gpt-6.1-sol', 'OpenAI'],
    ['codex-auto-review', 'OpenAI'],
    ['claude-opus-5.5', 'Anthropic'],
    ['claude-fable-5', 'Anthropic'],
    ['qwen3.8-max', '通义千问'],
    ['qwen-3.8-max', '通义千问'],
    ['glm-5.3-flash', '智谱 GLM'],
    ['deepseek-v4.1-flash', 'DeepSeek'],
    ['kimi-k3', 'Moonshot'],
    ['k3', 'Moonshot'],
    ['hy3-x', '腾讯混元'],
    ['hy4-preview', '腾讯混元'],
  ]
  for (const [name, want] of cases) {
    ok(relay.vendorKeyOf(name) === want, `${name} → ${want}`, relay.vendorKeyOf(name))
  }
  // 核心保证：gpt 与 codex 必须落到同一个键（否则出现两张 OpenAI 卡）
  ok(relay.vendorKeyOf('gpt-6.1-sol') === relay.vendorKeyOf('codex-auto-review'), 'gpt 与 codex 归到同一个键')
  ok(relay.vendorKeyOf('qwen3.8-max') === relay.vendorKeyOf('qwen-3.8-max'), 'qwen3.8 与 qwen-3.8 归到同一个键')
  // 未识别的不许消失
  ok(relay.vendorKeyOf('some-unknown-model') === 'some', '未识别前缀回落成自己的前缀（不丢模型）')
  ok(relay.vendorKeyOf('') === 'other', '空名归到 other')
}

console.log('[C] 领先幅度：只有一个站时必须是 null，不是 0')
{
  const one = pb.buildPriceBoard(
    [makeOffer({ id: 'o_1', providerId: 'p_a' })],
    settings,
    benchmarks,
    noScores,
    ctxOf([{ id: 'p_a', name: '甲站' }]),
  )
  ok(one[0].comparable === false, '单站 → comparable=false')
  ok(one[0].leadPct === null, 'leadPct 是 null（0 会被读成打平）', String(one[0].leadPct))
  ok(one[0].leadAbsCny === null, 'leadAbsCny 也是 null')
  ok(one[0].runnerUp === null, 'runnerUp 为 null')

  // 两站：甲 0.1 倍率、乙 1.0 倍率 → 领先 (100-10)/100 = 90%
  const two = pb.buildPriceBoard(
    [
      makeOffer({ id: 'o_a', providerId: 'p_a', ratio: 0.1 }),
      makeOffer({ id: 'o_b', providerId: 'p_b', ratio: 1 }),
    ],
    settings,
    benchmarks,
    noScores,
    ctxOf([
      { id: 'p_a', name: '甲站' },
      { id: 'p_b', name: '乙站' },
    ]),
  )
  ok(two[0].comparable === true, '两站 → comparable=true')
  ok(two[0].leadPct === 90, '领先幅度 90%', String(two[0].leadPct))
  ok(two[0].cheapest.providerName === '甲站', '最低价站是甲站')
  ok(two[0].runnerUp.providerName === '乙站', 'runnerUp 是乙站')
  ok(typeof two[0].leadAbsCny === 'number' && two[0].leadAbsCny > 0, '差价绝对值是正数')
}

console.log('[D] 实测标签：只陈述次数，不下判定')
{
  const offers = [
    makeOffer({ id: 'o_a', providerId: 'p_a', ratio: 0.1 }),
    makeOffer({ id: 'o_b', providerId: 'p_b', ratio: 1 }),
  ]
  const scores = new Map([
    // 甲站有 12 次探针、3 次真实流量
    ['o_a', { samples: 12, trafficSamples: 3 }],
    // 乙站一条证据都没有
    ['o_b', { samples: 0, trafficSamples: 0 }],
  ])
  const b = pb.buildPriceBoard(offers, settings, benchmarks, scores, ctxOf([
    { id: 'p_a', name: '甲站' },
    { id: 'p_b', name: '乙站' },
  ]))[0]
  ok(b.cheapest.evidence.samples === 15, '样本 = 探针 + 真实流量（12 + 3）', String(b.cheapest.evidence.samples))
  ok(b.cheapest.evidence.probeSamples === 12, '探针数与流量数分开记')
  ok(b.cheapest.evidence.label === '实测 15 次', '标签是「实测 N 次」')
  ok(b.runnerUp.evidence.label === '未实测', '0 样本 → 未实测（不是「可疑」）')
  // 关键词断言：标签里不许出现判定性词汇
  for (const word of ['可疑', '不可信', '降智', '假']) {
    ok(!b.cheapest.evidence.label.includes(word), `标签不含判定词「${word}」`)
  }
}

console.log('[E] 两个口径：全站绕开忽略名单，routed 套上')
{
  const db = {
    providers: [
      { id: 'p_a', name: '甲站', paused: false },
      { id: 'p_b', name: '乙站', paused: true },
    ],
    offers: [
      makeOffer({ id: 'o_live', providerId: 'p_a', modelKey: 'm1' }),
      makeOffer({ id: 'o_paused', providerId: 'p_b', modelKey: 'm1' }),
      makeOffer({ id: 'o_delisted', providerId: 'p_a', modelKey: 'm2', delistedAt: '2026-01-01' }),
      makeOffer({ id: 'o_ignored', providerId: 'p_a', modelKey: 'm3' }),
    ],
    settings: { ignoredModels: ['m3'] },
  }
  const all = pb.offersForScope(db, 'all')
  ok(all.length === 2, '全站口径：排除暂停站与已下线，但**保留**被忽略的模型', String(all.length))
  ok(all.some((o) => o.id === 'o_ignored'), '全站口径里被忽略的模型还在')
  ok(!all.some((o) => o.id === 'o_paused'), '全站口径排除暂停站')
  ok(!all.some((o) => o.id === 'o_delisted'), '全站口径排除已下线')

  const routed = pb.offersForScope(db, 'routed')
  ok(routed.length === 1, 'routed 口径：再套一层忽略名单', String(routed.length))
  ok(!routed.some((o) => o.id === 'o_ignored'), 'routed 口径里被忽略的模型消失了')
}

console.log('[F] 按次计费不进 token 比价')
{
  const offers = [
    makeOffer({ id: 'o_token', providerId: 'p_a', modelKey: 'm1' }),
    makeOffer({ id: 'o_call', providerId: 'p_b', modelKey: 'm1', priceUnit: 'per_call', inPrice: 0.5, outPrice: null }),
  ]
  const b = pb.buildPriceBoard(offers, settings, benchmarks, noScores, ctxOf([
    { id: 'p_a', name: '甲站' },
    { id: 'p_b', name: '乙站' },
  ]))
  ok(b.length === 1, '只有一个 token 口径的模型行')
  ok(b[0].siteCount === 1, '按次计费的供给被排除（¥/次 和 ¥/M 不能比）')
}

console.log('[G] 排序：有得比的在前，领先大的靠前')
{
  const offers = [
    // m_single 只有一个站
    makeOffer({ id: 'o_s1', providerId: 'p_a', modelKey: 'm_single' }),
    // m_big 领先 90%
    makeOffer({ id: 'o_b1', providerId: 'p_a', modelKey: 'm_big', ratio: 0.1 }),
    makeOffer({ id: 'o_b2', providerId: 'p_b', modelKey: 'm_big', ratio: 1 }),
    // m_small 领先 ~9%
    makeOffer({ id: 'o_sm1', providerId: 'p_a', modelKey: 'm_small', ratio: 0.5 }),
    makeOffer({ id: 'o_sm2', providerId: 'p_b', modelKey: 'm_small', ratio: 0.55 }),
  ]
  const boards = pb.buildPriceBoard(offers, settings, benchmarks, noScores, ctxOf([
    { id: 'p_a', name: '甲站' },
    { id: 'p_b', name: '乙站' },
  ]))
  // modelKey 是身份键，`m_big` 会被归一成 `m-big`（这是设计：同一模型不同写法要合并）
  ok(boards[0].modelKey === 'm-big', '领先最大的排第一', boards[0].modelKey)
  ok(boards[1].modelKey === 'm-small', '领先小的排第二', boards[1].modelKey)
  ok(boards[2].modelKey === 'm-single', '没得比的沉底', boards[2].modelKey)
}

console.log('[H] 顶部总结句')
{
  const boards = pb.buildPriceBoard(
    [
      makeOffer({ id: 'o_1', providerId: 'p_a', modelKey: 'm1', ratio: 0.1 }),
      makeOffer({ id: 'o_2', providerId: 'p_b', modelKey: 'm1', ratio: 1 }),
      makeOffer({ id: 'o_3', providerId: 'p_a', modelKey: 'm2' }),
    ],
    settings,
    benchmarks,
    noScores,
    ctxOf([{ id: 'p_a', name: '甲站' }, { id: 'p_b', name: '乙站' }]),
  )
  const s = pb.priceBoardSummary(boards)
  ok(s.total === 2, '总数 2')
  ok(s.comparable === 1, '可比 1')
  ok(s.single === 1, '单站 1')
  ok(/1 个模型有跨站可比/.test(s.text), '总结句说清了可比数', s.text)
  ok(pb.priceBoardSummary([]) === null, '空列表 → null（前端不画空句子）')
}

console.log('[I] 前端：按需拉取，不塞进 /api/state')
{
  const app = await readFile(join(root, 'web', 'app.js'), 'utf8')
  ok(app.includes('function renderPriceBoard()'), '有 renderPriceBoard')
  ok(/\/api\/price-board\?scope=\$\{encodeURIComponent\(wanted\)\}/.test(app), '按 scope 请求独立接口（且编码过）')
  ok(/const PRICE_BOARD_SCOPE_KEY = 'manageapi\.priceBoardScope'/.test(app), '口径开关记在本地')
  ok(
    /priceBoardScope = localStorage\.getItem\(PRICE_BOARD_SCOPE_KEY\) === 'routed' \? 'routed' : 'all'/.test(app),
    '只有存成 routed 才收窄，其余回落全站',
  )
  ok(app.includes("if (action === 'set-price-board-scope')"), '有口径切换处理器')
  ok(app.includes("if (action === 'toggle-price-board')"), '有展开明细处理器')
  ok(app.includes("if (action === 'reload-price-board')"), '有重试处理器')
  ok(app.includes('data-act="set-price-board-scope"'), '开关按钮带 data-act')
  ok(app.includes('data-scope="all"') && app.includes('data-scope="routed"'), '两档都有按钮')
  ok(app.includes('function priceBoardLeadText('), '领先幅度文案有独立函数（语义只写一处）')
  // 厂牌分类必须复用 free-relay.js 那一份，不许在本页另写前缀表
  ok(/import \{[^}]*vendorOf[^}]*\} from '\.\/free-relay\.js'/.test(app), '厂牌判定从 free-relay.js 导入（不另写一份）')
  ok(app.includes('function priceBoardVendorGroups('), '有厂牌分组函数')
  ok(/vendorKeyOf\(board\.display \|\| board\.modelKey\)/.test(app), '按展示名判厂牌，且用归一键（vendorKeyOf）')
  ok(app.includes('function priceBoardLinesHtml('), '有展开后的线路表渲染')
  ok(app.includes("if (action === 'pick-price-board-vendor')"), '有厂牌多选处理器')
  ok(app.includes("if (action === 'clear-price-board-vendor')"), '有清除筛选处理器')
  ok(/const priceBoardVendorPicked = new Set\(\)/.test(app), '多选状态用独立 Set')
  ok(!app.includes('priceBoardVendorCollapsed'), '旧的厂牌折叠状态已移除（改成了筛选）')
  // 空选 = 全部：这是筛选器的核心语义，选错就变成「进页面什么都看不到」
  ok(/if \(priceBoardVendorPicked\.size === 0\) return boards/.test(app), '空选返回全部（不是空列表）')
  ok(/data-act="pick-price-board-vendor"/.test(app), '筛选标签带 pick 动作')
  ok(/data-act="clear-price-board-vendor"/.test(app), '有清除筛选按钮')
  ok(app.includes('function priceBoardEvidenceHtml('), '实测标签有独立函数')
  // 不进轮询：render() 里要调用，但 HEAVY_TABS / state 里不该出现
  ok(/function render\(\) \{[\s\S]{0,400}renderPriceBoard\(\)/.test(app), 'render() 会画这一页')
  ok(!/HEAVY_TABS = new Set\(\[[^\]]*priceboard/.test(app), '不需要进 HEAVY_TABS（本页不吃 decisions）')
  const server = await readFile(join(root, 'daemon', 'server.js'), 'utf8')
  ok(/route\('GET', \/\^\\\/api\\\/price-board\$\/,/.test(server), '后端有独立路由')
  ok(!/priceBoard:\s*buildPriceBoard/.test(server), '没有把 boards 塞进 buildState')
  ok(/offersForScope\(db, scope\)/.test(server), '接口按 scope 取供给')
  ok(/buildPriceBoard\(offers, db\.settings, benchmarks, scoreMap/.test(server), '接口调同一份判定')
}

console.log('[J] 入口、样式与文案')
{
  const html = await readFile(join(root, 'web', 'index.html'), 'utf8')
  const css = await readFile(join(root, 'web', 'style.css'), 'utf8')
  const i18n = await readFile(join(root, 'web', 'i18n.js'), 'utf8')
  ok(html.includes('data-tab="priceboard"'), 'nav 有数据比价入口')
  ok(html.includes('id="view-priceboard"'), '有对应 view 容器')
  ok(/id="view-priceboard"[^>]*hidden/.test(html), '默认隐藏（切页才显示）')
  for (const cls of ['.pb-row', '.pb-price', '.pb-lead', '.pb-evidence', '.pb-vendor', '.pb-lines-table', '.pb-l-group', '.pb-chip', '.pb-filter']) {
    ok(css.includes(cls), `CSS 有 ${cls}`)
  }
  ok(/\.pb-chip\.on \{[^}]*background: var\(--accent\)/.test(css), '选中态是实心强调色（和未选中一眼分得开）')
  ok(css.includes('@media (max-width: 980px)'), '窄屏有适配')
  // 密度：折叠态必须是紧凑行，不能又变回整屏一行
  ok(/\.pb-row-head \{[^}]*grid-template-columns/.test(css), '折叠态是网格紧凑行（不是整屏一行）')
  ok(/\.pb-vendors \{[^}]*flex-direction: column/.test(css), '厂牌卡纵向堆叠')
  ok(i18n.includes("'数据比价'"), '英文词典有「数据比价」')
  ok(i18n.includes("'全站'"), '英文词典有「全站」')
  ok(i18n.includes("'未实测'"), '英文词典有「未实测」')
  for (const key of ['分组', '混合价', '输入 / 输出', '{n} 条线', '{n} 个模型', '清除筛选', '已筛 {n} 家']) {
    ok(i18n.includes(`'${key}'`), `英文词典有「${key}」`)
  }
}

console.log('\n[J3] 未定价供给必须报出来（不能静默丢掉）')
{
  const offer = (id, providerId, name) => ({
    id, providerId, upstreamName: name, group: 'g', modelKey: name,
    pricingMode: 'ratio', ratio: 0.1, credentialId: 'c1', inPrice: null, outPrice: null,
    benchmarkKey: name,
  })
  const settings = { blendInputWeight: 0.25, fx: { rates: { CNY: 6.6878 } } }
  // 基准价表只给 m1，不给 m2
  const benchmarks = { m1: { in: 2, out: 8, currency: 'CNY' } }
  const boards = pb.buildPriceBoard(
    [offer('o1', 'p1', 'm1'), offer('o2', 'p1', 'm2')],
    settings, benchmarks, new Map(),
    { providers: [{ id: 'p1', name: 'P1' }] },
  )
  ok(boards.length === 1, '只有有价的 m1 进比价表')
  const un = boards.unpriced || []
  ok(un.length === 1, 'm2 被记进 unpriced（不是静默丢弃）')
  ok(un[0] && un[0].upstreamName === 'm2', 'unpriced 里就是 m2')
  ok(un[0] && un[0].reason === 'no-benchmark', '原因标为 no-benchmark（基准价表缺该模型）')
}

console.log('\n[J4] 币种疑似标错自动判定（用真实汇率，不硬编码）')
{
  const N = 6.6878
  const mk = (effIn, effOut) => {
    const offer = {
      id: 'o1', providerId: 'p1', upstreamName: 'm1', group: 'g', modelKey: 'm1',
      pricingMode: 'ratio', ratio: 0.045, credentialId: 'c1', inPrice: null, outPrice: null,
    }
    const settings = { blendInputWeight: 0.25, fx: { rates: { CNY: N } } }
    const benchmarks = { m1: { in: 2, out: 10, currency: 'RUSD' } }
    const li = new Map([['p1|g|m1', {
      providerId: 'p1', group: 'g', model: 'm1', effIn, effOut,
      paidPerMtok: 0.01, rate: 0.045, tokens: 100000, days: 3, thin: false,
    }]])
    return pb.buildPriceBoard([offer], settings, benchmarks, new Map(),
      { providers: [{ id: 'p1', name: 'P' }], ledgerIndex: li })[0].cheapest.verify
  }
  // 标价 = 2 × 0.045 = 0.09
  const same = mk(0.09, 0.45)
  ok(same.currencySuspect === false, '一致时 currencySuspect=false')
  ok(same.mismatch === false, '一致时 mismatch=false')

  const low = mk(0.09 * N, 0.45 * N)      // 账单比标价大 6.69 倍
  ok(low.currencySuspect === true, '账单大 6.69 倍 → currencySuspect=true')
  ok(low.mismatch === true, '同时 mismatch=true')

  const high = mk(0.09 / N, 0.45 / N)     // 账单比标价小 6.69 倍
  ok(high.currencySuspect === true, '账单小 6.69 倍 → currencySuspect=true（负偏差不漏判）')

  const small = mk(0.12, 0.6)             // 小幅不符
  ok(small.currencySuspect === false, '仅小幅不符（+33%）不误判成币种问题')
  ok(small.mismatch === true, '但仍标 mismatch')
}

console.log('\n[J2] 价格口径：一律站点标价（2026-11-12 定稿）')
{
  const offer = (id, ratio, providerId) => ({
    id, providerId, upstreamName: 'm1', group: 'g', modelKey: 'm1',
    pricingMode: 'ratio', ratio, credentialId: 'c1', inPrice: null, outPrice: null,
  })
  const settings = { blendInputWeight: 0.25 }
  const benchmarks = { m1: { in: 2, out: 8, currency: 'CNY' } }
  const o = offer('o1', 0.1, 'p1')          // 标价: in 0.2 / out 0.8 / blended 0.65
  const ledgerIndex = new Map([['p1|g|m1', {
    providerId: 'p1', group: 'g', model: 'm1',
    effIn: 0.05, effOut: 0.2, paidPerMtok: 0.01, rate: 0.1,
    tokens: 100000, days: 3, thin: false, priceChange: false,
  }]])
  const boards = pb.buildPriceBoard([o], settings, benchmarks, new Map(), {
    providers: [{ id: 'p1', name: 'P1' }], ledgerIndex,
  })
  const c = boards[0].cheapest
  ok(Math.abs(c.rankPrice - 0.65) < 1e-9, `排序价 = 站点标价 blended 0.65（实际 ${c.rankPrice}）`)
  ok(c.priceSource === 'benchmark', '价格来源恒为站点标价')
  ok(c.verify && Math.abs(c.verify.effIn - 0.05) < 1e-9, '实测价只存在于 verify 校验字段')
  ok(c.verify && c.verify.mismatch === true, '实测与标价差 75% → mismatch=true')
  ok(c.paidPerMtok !== null, '实付仍透出（只展示，不排序）')
}


// ------------------------------------------------------------ 真实库冒烟
console.log('[K] 真实库冒烟（只读，不写任何东西）')
{
  const dbPath = join(homedir(), '.manage-api', 'db.json')
  if (!existsSync(dbPath)) {
    console.log('  - 跳过：本机没有 ~/.manage-api/db.json')
  } else {
    const { readFile: rf } = await import('node:fs/promises')
    const db = JSON.parse(await rf(dbPath, 'utf8'))
    const all = pb.offersForScope(db, 'all')
    const routed = pb.offersForScope(db, 'routed')
    ok(all.length >= routed.length, `全站口径不少于 routed（${all.length} >= ${routed.length}）`)
    const boards = pb.buildPriceBoard(all, db.settings, await import(join(core, 'benchmark.js')).then((m) => m.readBenchmarks()), new Map(), {
      providers: db.providers,
      aliases: db.settings?.modelAliases || {},
    })
    ok(boards.length > 0, `真实库算出了 ${boards.length} 个模型行`)
    ok(
      boards.every((b) => b.sites.length === b.siteCount),
      '每行 siteCount 与 sites 长度一致',
    )
    ok(
      boards.every((b) => b.comparable === (b.siteCount > 1)),
      'comparable 与 siteCount>1 严格一致',
    )
    ok(
      boards.filter((b) => !b.comparable).every((b) => b.leadPct === null),
      '所有单站行 leadPct 都是 null（没有假的 0%）',
    )
    ok(
      boards.every((b) => b.cheapest.blendedCnyPerMtok !== null),
      '每行的最低价都有值',
    )
    // 每站收敛的核心保证：同一站不会在一行里出现两次
    ok(
      boards.every((b) => new Set(b.sites.map((s) => s.providerId)).size === b.sites.length),
      '同一行里每个站只出现一次',
    )
  }
}

console.log('')
if (failed) {
  console.log(`${failed} 项失败`)
  process.exit(1)
}
console.log('全部通过 ✓')
