/**
 * 顶栏改版冒烟验证：对预览实例真点一遍（需要 9222 无头 Chrome + SHOT_APP 指向实例）。
 *
 * 前置：
 *   chrome --headless=new --remote-debugging-port=9222 about:blank &
 *   SHOT_APP=http://127.0.0.1:4520 node .test/topbar-live.mjs
 *
 * 断言：
 *  [1] 币种切换框没了；文档/语言在侧边栏，不在顶栏
 *  [2] 刷新组：绿点 + 竖杆 + 「刷新」三个件都在；点「刷新」触发手动刷新
 *  [3] 绿点可点：关掉自动刷新变灰（is-off），再点恢复
 *  [4] 花费小框在通知按钮左边，显示金额
 *  [5] 通知面板：通知/告警两页签；告警页签有告警明细
 *  [6] 有未读告警 → 通知按钮变告警标志（is-alert）；看完告警页签后变回铃铛
 *  [7] 监控页：站点/总余额/24小时变动/未读告警 KPI 卡没了、余额概览没了、告警动态卡没了
 *  [8] 倍率变动列表、上游公告卡、站点卡还在
 */
const APP = process.env.SHOT_APP || 'http://127.0.0.1:4520'
const CDP = process.env.SHOT_CDP || 'http://127.0.0.1:9222'

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension'))
if (!page) throw new Error('没有可用的 page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ' —— ' + extra}`)
  ok ? pass++ : fail++
}

await send('Page.enable')
await send('Runtime.enable')
// 三列卡片网格要足够宽的视口（默认 800px 只放得下两列）
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 0, mobile: false })
await send('Page.navigate', { url: APP + '/' })
await sleep(2500)

// ---------- [1] 顶栏旧件删干净、文档/语言进侧边栏
{
  const r = await evalJs(`(() => {
    const q = (s) => document.querySelector(s)
    return {
      curSwitch: !!q('#cur-switch'),
      topbarHelp: !!q('.topbar-right [data-act="show-help"]'),
      topbarLang: !!q('.topbar-right .lang-wrap'),
      sideHelp: !!q('.sidebar-foot [data-act="show-help"]'),
      sideLang: !!q('.sidebar-foot .lang-wrap'),
      sideLangMenuUp: (() => {
        const m = q('.sidebar-foot .lang-menu')
        return m && getComputedStyle(m).bottom !== 'auto'
      })(),
    }
  })()`)
  check('[1] 顶栏没有币种切换框', r.curSwitch === false, JSON.stringify(r))
  check('[1] 顶栏没有文档/语言', !r.topbarHelp && !r.topbarLang)
  check('[1] 文档进了侧边栏', r.sideHelp === true)
  check('[1] 语言进了侧边栏（菜单向上弹）', r.sideLang === true && r.sideLangMenuUp === true)
  const duo = await evalJs(`(() => {
    const duo = document.querySelector('.sidebar-foot .side-duo')
    if (!duo) return null
    const kids = [...duo.children]
    return {
      two: kids.length === 2,
      row: getComputedStyle(duo).display.includes('flex') && kids.every((k) => k.getBoundingClientRect().top < kids[1].getBoundingClientRect().top + 4),
    }
  })()`)
  check('[1] 文档+语言并排一条横杠（两个按钮）', duo && duo.two && duo.row, JSON.stringify(duo))
  const langBtn = await evalJs(`(() => {
    const b = document.querySelector('#lang-btn')
    return {
      label: document.querySelector('#lang-label')?.textContent,
      svgCount: b.querySelectorAll('svg').length,
    }
  })()`)
  check('[1] 语言按钮只有 CN 字样+小箭头，没有地球图标', langBtn.label === 'CN' && langBtn.svgCount === 1, JSON.stringify(langBtn))
}

// ---------- [2] 刷新组
{
  const r = await evalJs(`(() => {
    const g = document.querySelector('.refresh-group')
    if (!g) return null
    return {
      dot: !!g.querySelector('#autorefresh-dot'),
      sep: !!g.querySelector('.rg-sep'),
      text: g.querySelector('.rg-manual')?.textContent.trim(),
      oldRefreshBtn: !!document.querySelector('.topbar-right .refresh-btn svg'),
      oldAutoText: [...g.querySelectorAll('.rg-auto span')].some((s) => s.id !== 'autorefresh-dot'),
    }
  })()`)
  check('[2] 刷新组存在：绿点+竖杆+刷新', r && r.dot && r.sep && r.text === '刷新', JSON.stringify(r))
  check('[2] 手动刷新不带转圈图标', r && r.oldRefreshBtn === false)

  // 点「刷新」：轮询等 toast 出现（最多 3 秒）
  await evalJs(`document.querySelector('.rg-manual').click()`)
  let toastText = false
  for (let i = 0; i < 15; i++) {
    await sleep(200)
    toastText = await evalJs(`!!document.querySelector('.toast') || document.body.textContent.includes('已刷新')`)
    if (toastText) break
  }
  check('[2] 点「刷新」真的刷一次（出已刷新提示）', toastText, 'toast=' + JSON.stringify(toastText))
}

// ---------- [3] 绿点开关（切换要有提示）
{
  const off = await evalJs(`(() => {
    document.querySelector('#autorefresh-btn').click()
    const btn = document.querySelector('#autorefresh-btn')
    return {
      off: btn.classList.contains('is-off'),
      title: btn.title,
      toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|'),
    }
  })()`)
  check('[3] 点绿点 → 变灰且弹「自动同步已关闭」', off.off === true && off.toast.includes('自动同步已关闭') && !off.toast.includes('开启'), JSON.stringify(off))
  const on = await evalJs(`(() => {
    document.querySelector('#autorefresh-btn').click()
    const btn = document.querySelector('#autorefresh-btn')
    return {
      off: btn.classList.contains('is-off'),
      toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|'),
    }
  })()`)
  check('[3] 再点绿点 → 变绿且弹「每 15 秒一次」', on.off === false && on.toast.includes('自动同步已开启') && on.toast.includes('15 秒'), JSON.stringify(on))
}

// ---------- [4] 花费小框 + 时段菜单
{
  const r = await evalJs(`(() => {
    const wrap = document.querySelector('.top-spend-wrap')
    const box = document.querySelector('#top-spend')
    const kids = [...document.querySelector('.topbar-right').children]
    return {
      hidden: box ? box.hidden : null,
      label: document.querySelector('#top-spend-label')?.textContent,
      value: document.querySelector('#top-spend-value')?.textContent,
      leftOfNotify: box ? kids.indexOf(wrap) < kids.indexOf(document.querySelector('.notify-wrap')) : null,
    }
  })()`)
  check('[4] 花费小框在通知按钮左边', r.leftOfNotify === true, JSON.stringify(r))
  check('[4] 花费小框显示了金额（副本有账单数据）', r.hidden === false && /^[-¥$R]/.test(r.value || ''), 'value=' + r.value)

  // 点开菜单 → 选「本月」→ 标签和数值跟着变
  const menu = await evalJs(`(() => {
    document.querySelector('#top-spend').click()
    const m = document.querySelector('#top-spend-menu')
    return { open: !m.hidden, items: [...m.querySelectorAll('.spend-item')].map((b) => b.textContent.trim()) }
  })()`)
  check('[4] 点花费小框弹出 时段菜单（今天/本周/本月）', menu.open && menu.items.length === 3, JSON.stringify(menu))
  const switched = await evalJs(`(() => {
    document.querySelector('[data-spend-range="month"]').click()
    return {
      menuOpen: !document.querySelector('#top-spend-menu').hidden,
      label: document.querySelector('#top-spend-label')?.textContent,
      on: document.querySelector('[data-spend-range="month"]')?.classList.contains('is-on'),
    }
  })()`)
  check('[4] 选本月 → 标签变「花费 · 本月」菜单收起', switched.label.includes('本月') && !switched.menuOpen && switched.on, JSON.stringify(switched))
  // 恢复回今天
  await evalJs(`document.querySelector('#top-spend').click(); document.querySelector('[data-spend-range="today"]').click()`)
}

// ---------- [6] 告警图标：先造一条未读告警（改阈值让某站压线再同步一轮太重，
// 直接在页面里调 API 把所有告警标成未读做不到——readAt 在 db。
// 退而求其次：直接断言当前状态，再走「告警页签看完 → is-alert 消失」的链路）
{
  const st = await evalJs(`(() => {
    const btn = document.querySelector('#notify-btn')
    return { isAlert: btn.classList.contains('is-alert'), dot: document.querySelector('#notify-dot').hidden }
  })()`)
  console.log(`  ℹ 当前未读告警=${st.isAlert ? '有' : '无'}，未读通知红点=${st.dot ? '无' : '有'}`)

  // ---------- [5] 打开面板，两页签
  await evalJs(`document.querySelector('#notify-btn').click()`)
  await sleep(1200)
  const panel = await evalJs(`(() => {
    const p = document.querySelector('#notify-panel')
    const tabs = [...p.querySelectorAll('.notify-tab')].map((t) => ({
      key: t.dataset.notifyTab,
      on: t.classList.contains('is-on'),
      text: t.textContent.trim(),
    }))
    const list = p.querySelector('#notify-list')
    return {
      visible: !p.hidden,
      tabs,
      firstItem: list.querySelector('.notify-item') ? true : list.querySelector('.notify-empty')?.textContent,
      itemCount: list.querySelectorAll('.notify-item').length,
    }
  })()`)
  check('[5] 面板打开，页签是 通知+告警 两个',
    panel.visible && panel.tabs.length === 2 && panel.tabs[0].text.startsWith('通知') && panel.tabs[1].text.startsWith('告警'),
    JSON.stringify(panel.tabs))
  check('[5] 当前栏有内容（通知或空态文案）', panel.itemCount > 0 || typeof panel.firstItem === 'string', JSON.stringify(panel.firstItem))

  // 切到告警页签
  await evalJs(`document.querySelector('[data-notify-tab="alerts"]').click()`)
  await sleep(1200)
  const alerts = await evalJs(`(() => {
    const p = document.querySelector('#notify-panel')
    const list = p.querySelector('#notify-list')
    const on = p.querySelector('.notify-tab.is-on')?.dataset.notifyTab
    return {
      on,
      items: [...list.querySelectorAll('.notify-item')].slice(0, 3).map((i) => i.textContent.trim().slice(0, 40)),
      count: list.querySelectorAll('.notify-item').length,
      empty: list.querySelector('.notify-empty')?.textContent || '',
    }
  })()`)
  check('[5] 切到告警页签，能看见告警明细（或空态）', alerts.on === 'alerts' && (alerts.count > 0 || alerts.empty.includes('还没有告警')), JSON.stringify(alerts).slice(0, 200))

  // ---------- [6] 看完告警后 is-alert 应消失（若有未读的话）
  const after = await evalJs(`document.querySelector('#notify-btn').classList.contains('is-alert')`)
  if (st.isAlert) check('[6] 看完告警页签 → 图标变回铃铛', after === false)
  else console.log('  ℹ 本来就没有未读告警，[6] 只验证了链路不报错')
}

await evalJs(`document.body.click()`)
await sleep(300)

// ---------- [7][8] 监控页布局
{
  await evalJs(`location.hash = '#monitor'`)
  await sleep(2000)
  const r = await evalJs(`(() => {
    const v = document.querySelector('#view-monitor')
    const head = (sel) => [...v.querySelectorAll(sel)].map((h) => h.textContent.trim())
    return {
      kpiRow: !!v.querySelector('.stats.monitor-kpi'),
      chartCard: !!v.querySelector('.monitor-chart-card'),
      alertsCard: head('.monitor-feed-card h3'),
      changeCard: !!v.querySelector('.monitor-flow-card'),
      siteCards: v.querySelectorAll('.prov-card').length,
      announcements: head('.monitor-feed-card h3').some((h) => h.includes('公告')),
      alarmBar: !!v.querySelector('.balance-alarm'),
    }
  })()`)
  check('[7] KPI 卡整排没了（站点/总余额/24h变动/未读告警/花费）', r.kpiRow === false)
  check('[7] 余额概览图没了', r.chartCard === false)
  check('[7] 告警动态卡没了（告警搬进通知面板）', !r.alertsCard.some((h) => h.includes('告警动态')), JSON.stringify(r.alertsCard))
  check('[8] 最近倍率变动还在', r.changeCard === true)
  check('[8] 上游公告卡还在', r.announcements === true)
  check('[8] 站点卡还在', r.siteCards > 0, 'count=' + r.siteCards)

  // ---------- [9] 两张信息卡嵌进站点卡网格最右列：公告第一行，倍率变动第二行
  const layout = await evalJs(`(() => {
    const v = document.querySelector('#view-monitor')
    const grid = v.querySelector('.site-cards')
    const notice = grid?.querySelector('.monitor-notice-card')
    const changes = grid?.querySelector('.monitor-flow-card')
    const provs = [...grid.querySelectorAll('.prov-card')]
    const box = (el) => el.getBoundingClientRect()
    const near = (a, b, tol = 3) => Math.abs(a - b) <= tol
    return {
      inGrid: !!grid?.classList.contains('has-feed') && !!notice && !!changes,
      provCount: provs.length,
      noticeTopRow1: provs[0] ? near(box(notice).top, box(provs[0]).top) : false,
      noticeRightCol: provs[1] ? box(notice).left > box(provs[1]).left : false,
      flowTopRow2: provs[2] ? near(box(changes).top, box(provs[2]).top) : false,
      flowSameColAsNotice: near(box(changes).left, box(notice).left),
      foldBtns: v.querySelectorAll('[data-act="flow-toggle"]').length,
    }
  })()`)
  check('[9] 两张卡进了站点卡网格', layout.inGrid, JSON.stringify(layout))
  check('[9] 上游公告在第一行最右一列', layout.noticeTopRow1 && layout.noticeRightCol, JSON.stringify(layout))
  check('[9] 最近倍率变动在第二行最右一列（公告正下方）', layout.flowTopRow2 && layout.flowSameColAsNotice, JSON.stringify(layout))

  // 折叠倍率变动 → 列表藏掉，状态记住；展开复原
  const folded = await evalJs(`(() => {
    document.querySelector('[data-act="flow-toggle"][data-flow="changes"]').click()
    const card = document.querySelector('.monitor-flow-card')
    return {
      folded: card.classList.contains('is-folded'),
      listHidden: getComputedStyle(card.querySelector('.monitor-flow-list')).display === 'none',
      stored: localStorage.getItem('manageapi.monitorFlowFold'),
    }
  })()`)
  check('[9] 折叠倍率变动 → 列表收起且本地记住', folded.folded && folded.listHidden && (folded.stored || '').includes('"changes":true'), JSON.stringify(folded))
  await evalJs(`document.querySelector('[data-act="flow-toggle"][data-flow="changes"]').click()`)
  const unfolded = await evalJs(`!document.querySelector('.monitor-flow-card').classList.contains('is-folded')`)
  check('[9] 再点展开复原', unfolded === true)
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 过 / ${fail} 挂`)
process.exit(fail === 0 ? 0 : 1)
