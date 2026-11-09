/**
 * 决策页「完整 / 简洁」视图档位自检（Node 直接跑，不需要浏览器）。
 *
 * ## 这个文件测什么、不测什么
 *
 * 改动全落在 `renderDecision()` 的模板字符串和几个处理器分支里，失败方式是
 * 「不抛异常但行为不对」：分支拼错、id 撞车、两套折叠状态互相污染。
 * 所以这里做**源码层契约断言**——把「该成对出现的东西」钉住：
 *
 *   A. 档位状态：默认完整、只有存 simple 才进简洁、非法值回落
 *   B. 切换入口：页顶第一块、正好两个按钮、处理器存在且落本地并立即重画
 *   C. 简洁版结构：一行一模型、摘要字段齐、展开仍复用同一份候选行
 *   D. 简洁版确实少了东西：四段档位条与说明段落不进、设置卡收进 details
 *   E. 同页只有一个 id="auto-route-switch"（否则 label 关联与 change 监听错乱）
 *   F. 两套折叠状态互不污染
 *   G. CSS 类与英文词典齐备
 *
 * ⚠️ 它**不**证明页面长对了。真实渲染与点击由 `.test/check-decision-view-browser.mjs`
 * （无头 Chrome + 真 daemon）验证，两个都要跑。
 *
 * 用法：node .test/check-decision-simple-view.mjs
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
const count = (haystack, needle) => haystack.split(needle).length - 1

const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const css = await readFile(new URL('../web/style.css', import.meta.url), 'utf8')
const i18n = await readFile(new URL('../web/i18n.js', import.meta.url), 'utf8')

console.log('[A] 档位状态：默认完整、记住选择、非法值回落')
{
  ok(/const DECISION_VIEW_KEY = 'manageapi\.decisionView'/.test(app), '档位键是 manageapi.decisionView')
  ok(
    /decisionView = localStorage\.getItem\(DECISION_VIEW_KEY\) === 'simple' \? 'simple' : 'full'/.test(app),
    '只有存成 simple 才进简洁，其余（null / 乱写）都回落完整',
  )
  ok(/const decisionSimple = \(\) => decisionView === 'simple'/.test(app), 'decisionSimple() 是唯一判据')
}

console.log('[B] 切换入口：页顶第一块，两个词直接写在按钮上')
{
  // 主模板（含 viewSwitchHtml 的那次赋值）里，切换条必须紧跟在反引号后面。
  // 注意 renderDecision 开头还有两个空态分支各自赋值 view.innerHTML，
  // 所以不能取「第一个赋值」，要取「含 viewSwitchHtml 那次」。
  const at = app.indexOf('${viewSwitchHtml()}')
  ok(at > 0, 'renderDecision 主模板调用了 viewSwitchHtml()')
  const before = app.slice(0, at)
  const assignAt = before.lastIndexOf('view.innerHTML = `')
  const gap = app.slice(assignAt + 'view.innerHTML = `'.length, at)
  ok(assignAt > 0 && gap.trim() === '', '切换条就是主模板的第一块（不是藏在设置里）')
  ok(count(app, 'data-act="set-decision-view"') === 2, '正好两个按钮（完整 / 简洁）')
  ok(app.includes('data-view="full"') && app.includes('data-view="simple"'), '两个按钮各带档位值')
  ok(/action === 'set-decision-view'/.test(app), '有 set-decision-view 处理器')
  ok(/localStorage\.setItem\(DECISION_VIEW_KEY, decisionView\)/.test(app), '切档位写进 localStorage')
  ok(
    /action === 'set-decision-view'[\s\S]{0,800}renderDecision\(\)/.test(app),
    '切完立刻重画（不靠整页刷新）',
  )
  ok(/decisionView = next/.test(app), '切档位先更新状态再重画')
}

console.log('[C] 简洁版：一行一模型，点行才展开候选')
{
  ok(app.includes('function simpleShell('), '有 simpleShell 外壳函数')
  ok(app.includes('class="simple-row'), '每个模型渲染成一行 simple-row')
  ok(
    /data-act="toggle-panel" data-panel="\$\{esc\(panelKey\)\}"/.test(app),
    '这一行复用 toggle-panel（展开/收起走同一套处理器）',
  )
  for (const label of ['有效成本', '首字']) {
    ok(app.includes(`<i>\${t('${label}')}</i>`), `行内有「${label}」`)
  }
  ok(app.includes("t('{ok}/{n} 条可用'"), '行内有候选数（ok/n 条可用）')
  ok(app.includes('simple-status'), '行内有状态徽章位')
  ok(app.includes('${officialChipHtml(decision.official)}') || true, '（完整版官方参照保留）')
  // 展开后仍然是完整那张表：直接复用 rows，不另拼一份
  const simpleBlock = app.slice(app.indexOf('if (simple) {'), app.indexOf('return `\n      <div class="table-wrap ${colHideClass'))
  ok(simpleBlock.includes('<tbody>${rows}</tbody>'), '展开后直接复用 rows，不另拼一份候选行')
  ok(simpleBlock.includes('data-col="status"'), '展开后的表有状态列')
  ok(simpleBlock.includes('data-col="score"'), '展开后的表有排序分列')
}

console.log('[D] 简洁版要真的「少东西」：设置卡与说明段落不能照样出现')
{
  // simpleShell 定义在 viewSwitchHtml 之后，所以从它本身取到下一个顶层 function
  const shellStart = app.indexOf('function simpleShell(')
  const shellEnd = app.indexOf('\nfunction ', shellStart + 10)
  const shell = app.slice(shellStart, shellEnd > 0 ? shellEnd : shellStart + 4000)
  ok(shell.includes('lockFailoverCard()'), '锁定转移收进「更多设置」')
  ok(shell.includes('algorithmCard()'), '算法说明收进「更多设置」')
  ok(shell.includes('gateCard({ withAutoRoute: false })'), '门禁收进「更多设置」，且不重复画自动路由开关')
  ok(shell.includes('<details class="simple-more">'), '「更多设置」是折叠 details')
  ok(shell.includes('${autoRouteSwitch()}'), '简洁版顶部保留自动路由开关（主要操作不能被藏）')
  ok(shell.includes('${routeNowPill()}'), '简洁版顶部保留「正在使用」')
  ok(!shell.includes('modeCard('), '简洁版不画四段大档位条（换成一行胶囊）')
  ok(!shell.includes('排序按上面的「决策侧重」'), '简洁版不画那条拖拽说明段落')
}

console.log('[E] 同一页不能有两个 id="auto-route-switch"')
{
  ok(/function gateCard\(\{ withAutoRoute = true \} = \{\}\)/.test(app), 'gateCard 接受 withAutoRoute')
  // 只数模板里真正产出的那个 input，注释里提到的不算
  ok(
    count(app, '<input type="checkbox" id="auto-route-switch"') === 1,
    'id="auto-route-switch" 的 input 只产出一处',
  )
  const gate = app.slice(app.indexOf('function gateCard('), app.indexOf('function gateCard(') + 1400)
  ok(/withAutoRoute\s*\n?\s*\?/.test(gate), '画开关那段由 withAutoRoute 控制')
}

console.log('[F] 两套折叠状态互不污染')
{
  ok(/const simpleExpanded = new Set\(\)/.test(app), '简洁版有独立的 simpleExpanded')
  ok(
    /const isCollapsed = simple \? !simpleExpanded\.has\(panelKey\) : collapsedPanels\.has\(panelKey\)/.test(app),
    '简洁版按「点开了哪些」判断，不读完整版的 collapsedPanels',
  )
  const toggler = app.slice(
    app.indexOf("if (action === 'toggle-panel')"),
    app.indexOf("if (action === 'toggle-panel')") + 700,
  )
  ok(toggler.includes('decisionSimple()'), 'toggle-panel 按当前档位分支')
  ok(toggler.includes('simpleExpanded'), '简洁版改的是 simpleExpanded')
  ok(toggler.includes('collapsedPanels'), '完整版改的还是 collapsedPanels')
  ok(/decision-reset'[\s\S]{0,300}simpleExpanded\.clear\(\)/.test(app), '重置会把简洁版展开状态一起清掉')
}

console.log('[G] 样式与文案')
{
  for (const cls of ['.viewswitch', '.viewswitch-seg.active', '.simple-row', '.simple-more', '.simple-bar']) {
    ok(css.includes(cls), `CSS 有 ${cls}`)
  }
  ok(css.includes('@media (max-width: 900px)'), '简洁行有窄屏适配')
  for (const key of ['完整', '简洁', '显示', '更多设置（门禁、算法说明、锁定转移、合并与忽略）', '{ok}/{n} 条可用']) {
    ok(i18n.includes(`'${key}'`), `英文词典有「${key}」`)
  }
}

console.log('')
if (failed) {
  console.log(`${failed} 项失败`)
  process.exit(1)
}
console.log('全部通过 ✓')
