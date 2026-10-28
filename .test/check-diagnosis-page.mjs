/**
 * 诊断页 / 免费入口隐藏 的浏览器层自检（CDP 驱动本机 Chrome）。
 *
 * 钉死四件事：
 *   1. 侧边栏没有「免费」入口（HTML 注释之外），但 #view-free 容器还在（代码保留）
 *   2. 侧边栏最底下有「诊断系统」入口，点击能打开，标题/副标题正确
 *   3. 诊断页能渲染出错误账本表与供给表现表（数据来自预置的假账本）
 *   4. 直接打开 #free hash 会回落到概览（tab 已不在 TABS 里）
 *
 * 用法：node .test/check-diagnosis-page.mjs
 * （自起 daemon + 自起无头 Chrome，跑完自动清理；数据目录用临时副本）
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4567
const BASE = `http://127.0.0.1:${PORT}`

let n = 0
const ok = (cond, label) => {
  if (!cond) throw new Error(`✗ ${label}`)
  n += 1
  console.log(`  ✓ ${label}`)
}

// ---- 起 daemon（空数据目录 + 预置假账本，不碰真实库）
const home = await mkdtemp(join(tmpdir(), 'mapi-diag-'))
await mkdir(join(home, 'keys'), { recursive: true })
// master.key 需要成对：空库首启会自己生成，但我们要预置 errorbook/offerStats，
// 所以先让 daemon 自己初始化一次，再写 db。
const daemon = spawn(process.execPath, ['daemon/index.js', '--port', String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, MANAGE_API_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
})
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('daemon 启动超时')), 20000)
  daemon.stdout.on('data', (c) => {
    if (String(c).includes('4319') || String(c).includes(PORT) || String(c).includes('http')) {
      clearTimeout(t)
      resolve()
    }
  })
  daemon.on('exit', (code) => reject(new Error(`daemon 退出 ${code}`)))
})
// 等健康
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${BASE}/api/health`)
    if (r.ok) break
  } catch {}
  await new Promise((r) => setTimeout(r, 250))
}

// ---- 预置假账本（直接写 db.json：走同一份结构，daemon 下次 mutate 会原样保留）
{
  const db = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(join(home, 'db.json'), 'utf8')))
  db.errorbook = {
    fp_test1: {
      id: 'fp_test1', kind: 'quota', code: '403',
      template: 'insufficient balance', sample: 'insufficient balance',
      count: 42,
      firstAt: new Date(Date.now() - 30 * 60000).toISOString(),
      lastAt: new Date(Date.now() - 5 * 60000).toISOString(),
      providers: { 绿萝: 42 }, offers: { o_x: 42 }, lastDiagnosis: null,
    },
  }
  // 断言需要「最近 6 小时」内的错，站点名要与 providers 对得上
  // 同一站再报限流：用来验证「归因收敛」把派生症状收进根因
  db.errorbook.fp_test2 = {
    id: 'fp_test2', kind: 'rate-limit', code: '429',
    template: 'All available accounts are currently rate-limited',
    sample: 'All available accounts are currently rate-limited',
    count: 15,
    firstAt: new Date(Date.now() - 25 * 60000).toISOString(),
    lastAt: new Date(Date.now() - 3 * 60000).toISOString(),
    providers: { 绿萝: 15 }, offers: { o_slow: 15 }, lastDiagnosis: null,
  }
  db.providers = [{ id: 'p_lv', name: '绿萝', baseUrl: 'http://127.0.0.1:1/v1', quotaRemaining: 0.39, currency: 'USD', kind: 'sub2api' }]
  // 异常诊断链路验证：o_slow 近期首字 6s、基线 2s（慢 3 倍）
  const mkBucket = (hoursAgo, ttftMs) => {
    const d = new Date(Date.now() - hoursAgo * 3600000)
    const hour = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`
    return {
      offerId: 'o_slow', hour, requests: 10, ok: 10, broken: 0, failed: 0,
      ttftSum: ttftMs * 10, ttftCount: 10, latencySum: 10000 * 10, latencyCount: 10,
      genOutSum: 500 * 10, genCount: 10, genTimeSum: 5000 * 10,
      inputTokens: 100000, outputTokens: 5000, cachedTokens: 90000, reasoningTokens: 2000,
      estCostSum: 1, estCostCount: 10, streamGapMax: 500, errors: {},
    }
  }
  db.offers = [{ id: 'o_slow', providerId: 'p_lv', upstreamName: 'deepseek-v4.1-flash', modelKey: 'deepseek-v4.1-flash', priceUnit: 'per_mtok', inPrice: 1, outPrice: 2, currency: 'CNY', ratio: 1 }]
  db.__slowStats = {}
  // 按异常诊断需要重建 offerStats：基线 18 个小时桶（2s）+ 近期 3 个（6s）
  const slowStats = {}
  for (let h = 8; h < 26; h++) { const x = mkBucket(h, 2000); slowStats[`o_slow|${x.hour}`] = x }
  for (let h = 1; h <= 3; h++) { const x = mkBucket(h, 6000); slowStats[`o_slow|${x.hour}`] = { ...x, ok: 16, broken: 4 } }
  db.offerStats = slowStats
  delete db.__slowStats
  const { writeFile: wf } = await import('node:fs/promises')
  await wf(join(home, 'db.json'), JSON.stringify(db))
}

// ---- 起 CDP Chrome
const CHROME_CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean)
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p))
let chrome = null
let wsPort = null
const profile = await mkdtemp(join(tmpdir(), 'mapi-diag-chrome-'))
if (chromePath) {
  wsPort = 9333 + Math.floor(Math.random() * 300)
  chrome = spawn(chromePath, [
    '--headless=new', `--remote-debugging-port=${wsPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1500,950', 'about:blank',
  ], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 1500))
}

const cdpSend = (() => {
  let id = 0
  const pending = new Map()
  let ws = null
  const connect = async () => {
    // Node 22+ 内置 WebSocket（undici），不需要 node:ws
    return new Promise((resolve, reject) => {
      ws = new WebSocket(`http://127.0.0.1:${wsPort}`)
      ws.onopen = resolve
      ws.onerror = reject
    })
  }
  return async (method, params = {}, sessionId) => {
    if (!ws) await connect()
    return new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }))
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 15000)
    })
  }
})()

try {
  const targets = await (await fetch(`http://127.0.0.1:${wsPort}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const WebSocket2 = WebSocket
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let mid = 0
  const waiters = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id) }
  })
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++mid
    waiters.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
    return r.result?.result?.value
  }
  await send('Page.enable')
  await send('Page.navigate', { url: BASE })
  await new Promise((r) => setTimeout(r, 2500))

  // 1. 免费入口消失，容器还在
  ok((await evaluate(`document.querySelectorAll('#nav [data-tab="free"]').length`)) === 0, '侧边栏无「免费」入口')
  ok(await evaluate(`!!document.querySelector('#view-free')`), '#view-free 容器保留（不删代码）')
  ok(await evaluate(`document.querySelector('#view-free').hidden`), '#view-free 处于隐藏态')

  // 2. 诊断入口在最底部 + 点击打开
  const lastBtn = await evaluate(`document.querySelectorAll('#nav button')[document.querySelectorAll('#nav button').length-1].dataset.tab`)
  ok(lastBtn === 'diagnosis', '诊断系统在侧边栏最底部')
  await evaluate(`document.querySelector('#nav [data-tab="diagnosis"]').click()`)
  await new Promise((r) => setTimeout(r, 1500))
  ok(!(await evaluate(`document.querySelector('#view-diagnosis').hidden`)), '点击后诊断页展开')
  ok((await evaluate(`document.querySelector('#page-title').textContent`)) === '诊断系统', '页标题=诊断系统')

  // 3. UI 化：stats 瓷砖 + 诊断结论卡，账本/供给表默认收起
  // 诊断结论 4 块 + 故障处理 4 块
  ok((await evaluate(`document.querySelectorAll('#view-diagnosis .stat').length`)) === 8, '八块状态瓷砖（诊断 4 + 故障处理 4，复用 .stat 组件）')
  ok((await evaluate(`document.querySelector('#view-diagnosis').innerHTML`)).includes('故障处理'), '故障处理卡渲染')
  ok((await evaluate(`document.querySelector('#view-diagnosis').innerHTML`)).includes('已截流'), '故障处理卡有「已截流」计数')
  ok(!!(await evaluate(`document.querySelector('[data-act="fault-test"]')`)), '有「测试上报通道」按钮')
  const body0 = await evaluate(`document.querySelector('#view-diagnosis').innerHTML`)
  ok(body0.includes('报错诊断'), '第一段=报错诊断')
  ok(body0.includes('异常诊断'), '第二段=异常诊断')
  // 预置的假账本里绿萝 42 次 403 + 余额低 → 引擎应该报出 danger
  ok(body0.includes('余额只剩'), '诊断结论卡渲染出归因结论')
  ok(body0.includes('42'), '结论带具体次数')
  ok(body0.includes('站点'), '结论标注归因层级')
  ok(body0.includes('充值'), '结论给出处理方式')
  ok((await evaluate(`document.querySelector('#view-diagnosis').innerText.includes('需处理')`)), '瓷砖显示「需处理」数')
  ok(!body0.includes('错误模板（悬停看原文）'), '账本原始表格默认不露（不该轻易看到）')
  ok(!body0.includes('吐字/s'), '供给表现表默认不露')
  ok(body0.includes('首字变慢'), '异常诊断报出「首字变慢」')
  ok(body0.includes('慢 3.0 倍'), '结论带倍数')
  ok((await evaluate(`document.querySelectorAll('#view-diagnosis .notice').length`)) >= 2, '两段各有结论')
  ok(body0.includes('data-act="diagnosis-pane" data-pane="book"'), '错误账本是一个按钮')
  ok(body0.includes('data-act="diagnosis-pane" data-pane="stats"'), '供给表现是一个按钮')

  // 4. 点按钮展开账本表
  await evaluate(`document.querySelector('[data-act="diagnosis-pane"][data-pane="book"]').click()`)
  await new Promise((r) => setTimeout(r, 300))
  const body1 = await evaluate(`document.querySelector('#view-diagnosis').innerHTML`)
  ok(body1.includes('insufficient balance'), '展开后账本数据可见')
  ok(body1.includes('余额不足'), 'kind=quota 显示为「余额不足」（账单问题，不叫冷却）')
  ok(body1.includes('42'), '失败次数显示')
  ok(!body1.includes('供给表现</h3>') && !body1.includes('吐字/s'), '另一块仍收起')

  // 5. 切到供给表现
  await evaluate(`document.querySelector('[data-act="diagnosis-pane"][data-pane="stats"]').click()`)
  await new Promise((r) => setTimeout(r, 300))
  const body2 = await evaluate(`document.querySelector('#view-diagnosis').innerHTML`)
  ok(body2.includes('吐字/s'), '供给表现表展开')
  ok(body2.includes('2026-10-28T08'.slice(5, 10).replace('-', '/')), '小时桶显示')
  ok(!body2.includes('错误模板（悬停看原文）'), '切换后账本收起')

  // 5.5 归因收敛：同一站的多项症状收在根因下，可展开
  const body3 = await evaluate(`document.querySelector('#view-diagnosis').innerHTML`)
  ok(body3.includes('另有'), '根因说明里有「另有 N 项症状」')
  ok(body3.includes('data-act="finding-related"'), '派生症状有展开按钮')
  ok(!body3.includes('「绿萝」最近 6 小时被限流'), '派生症状默认收起（不与根因抢注意力）')
  await evaluate(`document.querySelector('[data-act="finding-related"]').click()`)
  await new Promise((r) => setTimeout(r, 300))
  const body4 = await evaluate(`document.querySelector('#view-diagnosis').innerHTML`)
  ok(body4.includes('被限流') || body4.includes('失败率'), '点开后能看到派生症状明细')
  ok(body4.includes('收起'), '展开后按钮变「收起」')

  // 5.8 空回合守卫已并入诊断系统（不再是独立 tab），页面里有它的分段与内容
  const merged = await evaluate(`document.querySelector('#view-diagnosis').innerHTML`)
  ok(merged.includes('空回合守卫'), '诊断页里有「空回合守卫」分段')
  ok(!!(await evaluate(`document.querySelector('#diag-guard-slot')`)), '守卫插槽存在（并入而非另开一页）')
  ok(
    (await evaluate(`document.querySelectorAll('#nav [data-tab="diagnostics"]').length`)) === 0,
    '侧边栏不再有独立的「异常诊断」入口',
  )
  ok(
    (await evaluate(`document.querySelectorAll('#nav [data-tab="diagnosis"]').length`)) === 1,
    '只有一个诊断入口',
  )
  ok(!!(await evaluate(`document.querySelector('#empty-guard-enabled')`)), '守卫开关在诊断页里可操作')

  // 6. 一键体检按钮存在且文案正确（不点：会真打上游花 token）
  const hasCheckupBtn = await evaluate(`!!document.querySelector('[data-act="checkup-run"]')`)
  ok(hasCheckupBtn, '一键体检按钮存在')
  const checkupHint = await evaluate(`document.querySelector('#view-diagnosis').innerText`)
  ok(checkupHint.includes('一键体检'), '按钮文案')
  ok(checkupHint.includes('会真的打上游'), '明确提示会花 token')
  ok(!checkupHint.includes('体检报告'), '未体检时不显示报告')

  // 4. #free hash 回落概览
  await send('Page.navigate', { url: `${BASE}/#free/relay` })
  await new Promise((r) => setTimeout(r, 1200))
  ok(await evaluate(`!document.querySelector('#view-overview').hidden`), '#free hash 安全回落到概览')
  ok(await evaluate(`document.querySelector('#view-free').hidden`), '回落时免费视图保持隐藏')

  console.log(`check-diagnosis-page: ${n} 项全部通过`)
} finally {
  try { chrome?.kill() } catch {}
  daemon.kill()
  await rm(home, { recursive: true, force: true }).catch(() => {})
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
