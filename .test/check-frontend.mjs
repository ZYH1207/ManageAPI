/**
 * 前端关键路径自检（Node 直接跑，不需要浏览器）。
 *
 * ## 为什么要这个文件
 *
 * 后端有 100+ 个检查，前端只有少数几个「HTML 字符串包含某段」的断言。
 * 但 2026-11-02 实际踩到的两个 bug 都在前端，而且都**不是**「渲染错了」，
 * 是「渲染对了但事件到不了」：
 *
 *   1. 全局搜索的结果按钮用了 `data-tab`，被主点击处理器里「切页」的分支
 *      更早劫持并 `return`，永远走不到自己的处理器。
 *   2. 路由页第一次点进去连不上活动流——首次 render() 在 setTab() 之前，
 *      那时 #view-route 还是 hidden，连接逻辑走了「不可见就不连」的分支。
 *
 * 这两类问题的共同点：**静态 HTML 断言抓不到，真浏览器点一遍才知道**。
 * 所以这个文件测三样东西：
 *
 *   A. 依赖注入契约（bindRouteView / bindFreeRelay 之类必须传出全部依赖）
 *   B. 「动作名 → 处理器」必须真的存在（grep 源码，不执行浏览器）
 *   C. 关键 DOM 契约：data-* 属性不能撞上更早的分支
 *
 * 用法：node .test/check-frontend.mjs
 */
import { readFile } from 'node:fs/promises'

let failed = 0
const ok = (cond, msg, extra = '') => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}${extra ? `  ${extra}` : ''}`)
  }
}

const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const routeView = await readFile(new URL('../web/route-view.js', import.meta.url), 'utf8')
const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')

console.log('[A] 依赖注入契约')
{
  // route-view.js 不读全局 state，全靠 bindRouteView 注入
  ok(routeView.includes('export function bindRouteView'), 'route-view 有 bindRouteView')
  ok(/let deps = null/.test(routeView), 'route-view 用 deps 容器而不是全局')
  // 反向检查：不该出现裸的 `state.` 引用（deps.state. 除外）
  const bareState = [...routeView.matchAll(/(?<![\w.$])state\./g)]
  ok(bareState.length === 0, `route-view 无裸 state 引用（发现 ${bareState.length} 处）`)
  // app.js 里必须真的把依赖传进去
  ok(/bindRouteView\(\{\s*state,\s*t,\s*esc,\s*icon,\s*\$/.test(app.replace(/\s+/g, ' ')),
    'app.js 调 bindRouteView 时传齐了 state/t/esc/icon/$')
}

console.log('[B] 数据动作 → 处理器 必须成对存在')
{
  // 这些是「渲染出的按钮」必须有的处理器名。缺一个就是「点了没反应」。
  // ⚠️ 这里要认两种写法：
  //   a) 直接分支：`if (action === 'xxx')`
  //   b) 表驱动：`const X_FIELDS = { 'xxx': ... }` + `if (X_FIELDS[action])`
  // 只查 a) 会误报——路由组那 7 个单选设置是表驱动的（7 个字段共用一段逻辑，
  // 写 7 个 if 反而是坏味道）。
  const REQUIRED_ACTIONS = [
    'rg-new', 'rg-use', 'rg-del', 'rg-algo', 'rg-toggle',
    'rg-expand', 'rg-collapse', 'rg-up', 'rg-down', 'rg-unpattern',
    'rg-model-list', 'rg-first-token', 'rg-all-busy',
    'rg-context', 'rg-session-keep', 'rg-effort', 'rg-effort-level',
    'gs-hit', 'export-menu',
  ]
  for (const act of REQUIRED_ACTIONS) {
    const direct = app.includes(`action === '${act}'`)
    const table = app.includes(`'${act}':`)
    ok(direct || table, `处理器存在：${act}${table && !direct ? '（表驱动）' : ''}`)
  }
  ok(app.includes("data-act=" + String.fromCharCode(34) + "rg-add" + String.fromCharCode(34)), "rg-add 有 change 处理")
}

console.log('[C] data-* 属性不能撞上更早的分支')
{
  // 主点击处理器里「切页」分支是：
  //   const tab = event.target.closest('[data-tab]')
  //   if (tab) { setTab(...); return }
  // 它在 data-act 之前，所以任何**要自己处理点击**的元素都不能带 data-tab。
  //
  // 这里把「全局搜索结果按钮」当样本钉住：它带了 data-gs-tab。
  ok(routeView.includes('data-gs-tab') || app.includes('data-gs-tab'),
    '全局搜索结果用 data-gs-tab（不用 data-tab）')
  const gsHitBlock = app.slice(app.indexOf("action === 'gs-hit'"), app.indexOf("action === 'gs-hit'") + 400)
  ok(gsHitBlock.includes('dataset.gsTab'), 'gs-hit 处理器读 dataset.gsTab')

  // 切页分支本身存在的确认（如果哪天它被挪到 data-act 之后，这条会提醒复核）
  const tabBranch = app.indexOf("event.target.closest('[data-tab]')")
  const actBranch = app.indexOf("event.target.closest('[data-act]')")
  ok(tabBranch > 0 && actBranch > 0 && tabBranch < actBranch,
    '切页分支确实在 data-act 之前（所以 data-tab 会被劫持）')
}

console.log('[D] SSE 连接时机')
{
  // setTab 切到 route 时必须显式连接：首次 render() 早于 setTab，那时 view 还 hidden。
  // 2026-11-02 改成懒加载后，连接挂在 loadRouteView().then 里，所以这里查的是
  // 「切到 route 的分支里出现了 routeConnect」，而不是固定写法。
  const routeBranch = app.slice(app.indexOf("if (name === 'route')"), app.indexOf("if (name === 'route')") + 400)
  ok(routeBranch.includes('routeConnect'), 'setTab 切到 route 时显式 routeConnect')
  ok(routeBranch.includes('loadRouteView'), '切页时通过 loadRouteView 加载（懒加载）')
  ok(app.includes('routeDisconnect'), '离开路由页时断开')
  // route-view 内部要有幂等保护，否则每次 render 都重建连接
  ok(routeView.includes("routeConnState === 'live') return"), 'routeConnect 幂等（已连着就不重建）')

  // 懒加载的关键：首屏不该下载 route-view（否则「按需」等于没做，实测踩到过）
  ok(/if \(view\.hidden && !routeViewMod\) return/.test(app),
    'renderRoute 在页面不可见且未加载时直接返回（首屏不下 31KB）')
  ok(app.includes('routeViewLoading'), '并发加载共享同一个 Promise（不重复下载）')
}

console.log('[E] 页面清单一致性')
{
  // TABS 里的每个 tab 都必须在 index.html 里有 view 容器
  const tabsMatch = app.match(/const TABS = \[([^\]]+)\]/)
  ok(Boolean(tabsMatch), 'app.js 有 TABS 定义')
  if (tabsMatch) {
    const tabs = tabsMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
    for (const t of tabs) {
      ok(html.includes(`id="view-${t}"`), `TABS 里的 ${t} 有对应 view 容器`)
    }
    // 导航按钮：TABS 里的每个 tab 都该能从侧边栏点到（否则那页打不开）
    // free 是显式隐藏的（HIDDEN_TABS），跳过
    for (const t of tabs) {
      if (t === 'free') continue
      ok(html.includes(`data-tab="${t}"`), `侧边栏有 ${t} 入口`)
    }
  }
}

console.log('[F] 关键交互元素带无障碍标签')
{
  // 探针页的筛选下拉曾经 7 个都没有标签（2026-11-02 修）
  ok(app.includes("探针筛选"), "探针筛选有 aria-label")
  ok(app.includes("自动探测间隔单位"), "探测间隔单位有 aria-label")
  ok(app.includes("自动探测间隔数值"), "探测间隔数值有 aria-label")
}

console.log('')
if (failed) {
  console.log(`${failed} 项失败`)
  process.exit(1)
}
console.log('全部通过 ✓')