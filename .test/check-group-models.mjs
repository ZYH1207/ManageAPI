/**
 * 站点卡「分组里的模型」自检：点分组胶囊，右侧悬浮抽屉里要列出这个分组的模型。
 *
 * 背景：分组胶囊以前只是标签，点开「还有 N 个」也只能看到分组名——
 * 「这个分组里到底有什么模型」在界面上没有入口。
 *
 * 钉死三件事：
 *   1. 数据口径：含被忽略的模型（打「已忽略」）、去掉已下线的，价格是实际价（已乘倍率）；
 *   2. 交互：点胶囊/键盘都能开抽屉，换胶囊就换内容，Esc / 点背景能关；
 *   3. 分组没同步过模型时给明确说明，而不是一片空白。
 *
 * 同一个弹窗也给密钥面板用（Key 那行的「总 / 忽略 / 可用」），所以这里一并钉住
 * modelsByCredential 的口径和三个筛选按钮。
 *
 * 浏览器层用 CDP 驱动本机 Chrome（与 check-group-chips 同一套做法），
 * 自己起 daemon、自己起无头 Chrome，跑完自动清理。
 *
 * 用法：node .test/check-group-models.mjs
 * 环境变量：CHROME 指向 Chrome 可执行文件（找不到就只跑 API 断言）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
function ok(cond, message) {
  if (cond) console.log(`  ✓ ${message}`)
  else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function findChrome() {
  const candidates = [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) || null
}

// ---------------------------------------------------------------- 造数据
const HOME = await mkdtemp(join(tmpdir(), 'mapi-group-models-'))
process.env.MANAGE_API_HOME = HOME
const inventory = await import(pathToFileURL(join(ROOT, 'core/inventory.js')).href)

console.log('[1] 造一个两分组 + 一个空分组的站点')
const provider = await inventory.createProvider({ name: '甲站', baseUrl: 'http://127.0.0.1:5199/v1' })
const mainCred = await inventory.createCredential({
  providerId: provider.id,
  label: '主力 Key',
  secret: 'sk-main-0001',
  group: '主力分组',
})
const backupCred = await inventory.createCredential({
  providerId: provider.id,
  label: '备用 Key',
  secret: 'sk-backup-0002',
  group: '备用分组',
})
// 只选了分组、还没同步过模型的 Key：这颗胶囊必须也能点开，并说清楚为什么是空的
await inventory.createCredential({
  providerId: provider.id,
  label: '待同步 Key',
  secret: 'sk-pending-0003',
  group: '待同步分组',
})

const mainSync = await inventory.syncOffers(provider.id, mainCred.id, ['model-a', 'model-b', 'model-c'], '主力分组')
const backupSync = await inventory.syncOffers(provider.id, backupCred.id, ['model-d', 'model-e', 'model-f'], '备用分组')
const { readDb } = await import(pathToFileURL(join(ROOT, 'core/store.js')).href)
const byName = (list, name) => list.find((o) => o.upstreamName === name)
const allOffers = (await readDb()).offers.filter((o) => o.providerId === provider.id)
const mainModels = allOffers.filter((o) => o.group === '主力分组')
const backupModels = allOffers.filter((o) => o.group === '备用分组')
ok(mainSync.total === 3 && backupSync.total === 3 && mainModels.length === 3 && backupModels.length === 3, '两组各同步进 3 个模型')

// model-a：倍率模式，原价 2 / 8，倍率 0.5 → 实际价 1 / 4（抽屉里必须显示实际价）
await inventory.updateOfferPrice(byName(mainModels, 'model-a').id, {
  pricingMode: 'ratio',
  ratio: 0.5,
  inPrice: 2,
  outPrice: 8,
  currency: 'CNY',
})
// model-e：按次计费，每次 0.5 元
await inventory.updateOfferPrice(byName(backupModels, 'model-e').id, {
  priceUnit: 'per_call',
  inPrice: 0.5,
  currency: 'CNY',
})
// model-f：白送（实际价 0）→ 免费
await inventory.updateOfferPrice(byName(backupModels, 'model-f').id, { inPrice: 0, outPrice: 0 })
// model-c：这次同步没回来 → 已下线，不该出现在抽屉里
await inventory.markDelisted(provider.id, mainCred.id, ['model-a', 'model-b'])

// ---------------------------------------------------------------- 起服务
const APP_PORT = await freePort()
const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  cwd: ROOT,
  env: { ...process.env, MANAGE_API_HOME: HOME },
  stdio: 'ignore',
})
const base = `http://127.0.0.1:${APP_PORT}`

async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }
  throw new Error('服务没起来')
}

const chromePath = findChrome()
let chrome = null
let chromeDir = null
let ws = null

async function cleanup() {
  try { ws?.close() } catch { /* 忽略 */ }
  try { chrome?.kill() } catch { /* 忽略 */ }
  try { app.kill() } catch { /* 忽略 */ }
  await sleep(300)
  if (chromeDir) await rm(chromeDir, { recursive: true, force: true }).catch(() => {})
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

try {
  await waitReady()
  ok(true, `服务已就绪 :${APP_PORT}`)

  // 显示币种固定成人民币：价格断言要可重复，否则默认美元会按汇率折成 $0.139
  await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ignoredModels: ['model-b'], displayCurrency: 'CNY' }),
  })

  // ------------------------------------------------------------ 2. 数据口径
  console.log('[2] /api/state 的 modelsByGroup')
  const state = await (await fetch(`${base}/api/state`)).json()
  const groups = state.modelsByGroup?.[provider.id] || {}
  const main = groups['主力分组'] || []
  const backup = groups['备用分组'] || []

  ok(
    main.map((m) => m.name).join(',') === 'model-a,model-b',
    `主力分组只列还在的模型（得到 ${main.map((m) => m.name).join(',') || '空'}）`,
  )
  ok(!main.some((m) => m.name === 'model-c'), '已下线的 model-c 不在清单里')
  ok(main.find((m) => m.name === 'model-b')?.ignored === true, 'model-b 标了「已忽略」，而不是被藏起来')
  ok(main.find((m) => m.name === 'model-a')?.ignored === false, 'model-a 没被误标忽略')

  const a = main.find((m) => m.name === 'model-a')
  ok(a?.inCny === 1 && a?.outCny === 4, `实际价已乘倍率（得到 ${a?.inCny} / ${a?.outCny}，期望 1 / 4）`)

  const e = backup.find((m) => m.name === 'model-e')
  ok(e?.perCall === true && e?.callCny === 0.5, `按次模型给 /次 单价（得到 ${e?.callCny}）`)
  ok(backup.find((m) => m.name === 'model-f')?.free === true, '0 元模型标了免费')

  ok(!groups['待同步分组'], '还没同步过模型的分组不会凭空出现在清单里')
  ok(
    !state.offers.some((o) => o.upstreamName === 'model-b'),
    '对照：state.offers 里没有 model-b（被忽略过滤掉了）——所以这份清单必须单独给',
  )

  // 密钥面板上的「总 / 忽略 / 可用」：口径必须和分组清单一致（含已忽略、去掉已下线），
  // 否则卡片写「1 个模型」、点开弹窗列出 2 行，两个数对不上
  console.log('[2b] /api/state 的 modelsByCredential')
  const credModels = state.modelsByCredential?.[mainCred.id] || []
  ok(
    credModels.map((m) => m.name).join(',') === 'model-a,model-b',
    `主力 Key 的清单只列还在的模型（得到 ${credModels.map((m) => m.name).join(',') || '空'}）`,
  )
  ok(credModels.filter((m) => m.ignored).length === 1, '其中 1 个被忽略 → 可用 = 总 - 忽略')
  ok(
    (state.modelsByCredential?.[backupCred.id] || []).length === 3,
    '备用 Key 各自一份清单（3 个模型），不和主力 Key 混在一起',
  )
  ok(!state.modelsByCredential?.['no-such-key'], '没同步过的 Key 不会凭空出现在清单里')

  if (!chromePath) {
    console.log('  · 没找到 Chrome（可用 CHROME=/path/to/chrome 指定），跳过浏览器断言')
    console.log(`\n结果：${failed ? '失败' : '通过'}`)
    await cleanup()
    process.exit(failed ? 1 : 0)
  }

  // -------------------------------------------------------- 无头 Chrome + CDP
  console.log('[3] 无头 Chrome 打开站点页')
  chromeDir = await mkdtemp(join(tmpdir(), 'mapi-chrome-'))
  const CDP_PORT = await freePort()
  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${chromeDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  const CDP = `http://127.0.0.1:${CDP_PORT}`
  let page = null
  for (let i = 0; i < 100 && !page; i += 1) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json()
      page = list.find((t) => t.type === 'page')
    } catch {
      /* 还没起来 */
    }
    if (!page) await sleep(150)
  }
  if (!page) throw new Error('Chrome 没起调试端口')

  ws = new WebSocket(page.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) {
      throw new Error('页面里执行出错: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    }
    return r.result?.result?.value
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url: `${base}/#monitor` })

  // 站点卡渲染要等 /api/state + /api/monitor 都回来
  let ready = false
  for (let i = 0; i < 150 && !ready; i += 1) {
    ready = await ev(`!!document.querySelector('#monitor-sites-host .prov-group-chips')`)
    if (!ready) await sleep(200)
  }
  if (!ready) throw new Error('站点卡一直没渲染出来')

  const clickChip = (group) => `(() => {
    const chip = [...document.querySelectorAll('#monitor-sites-host .prov-group-chips .group-chip')]
      .find((el) => el.dataset.group === ${JSON.stringify(group)} && el.dataset.act === 'open-group-models')
    if (!chip) return 'missing'
    chip.click()
    return 'ok'
  })()`

  const drawer = `(() => {
    const sheet = document.querySelector('#group-models')
    const body = document.querySelector('#group-models-body')
    const rows = [...body.querySelectorAll('.gs-row')].map((row) => ({
      name: row.querySelector('.gs-name')?.textContent.trim() || '',
      text: row.textContent.replace(/\\s+/g, ' ').trim(),
    }))
    return {
      open: !!sheet && !sheet.hidden,
      title: document.querySelector('#group-models-title')?.textContent.trim() || '',
      site: document.querySelector('#group-models-site')?.textContent.trim() || '',
      meta: body.querySelector('.gs-meta .hint')?.textContent.trim() || '',
      rows,
      empty: body.textContent.replace(/\\s+/g, ' ').trim(),
    }
  })()`

  // -------------------------------------------------------- 4. 点胶囊开抽屉
  console.log('[4] 点分组胶囊 → 右侧抽屉')
  const chipMarkup = await ev(`(() => {
    const chip = document.querySelector('#monitor-sites-host .prov-group-chips .group-chip[data-group="主力分组"]')
    return chip ? { role: chip.getAttribute('role'), tab: chip.getAttribute('tabindex'), title: chip.getAttribute('title') } : null
  })()`)
  ok(chipMarkup?.role === 'button' && chipMarkup?.tab === '0', '分组胶囊是可聚焦的按钮语义（键盘也能开）')
  ok(Boolean(chipMarkup?.title), '胶囊有「点开看模型」的提示文案')

  ok((await ev(clickChip('主力分组'))) === 'ok', '找到了「主力分组」胶囊')
  let view = null
  for (let i = 0; i < 40; i += 1) {
    view = await ev(drawer)
    if (view.open) break
    await sleep(100)
  }
  ok(view.open, '抽屉打开了')
  ok(view.title === '主力分组', `标题是分组名（实际「${view.title}」）`)
  ok(view.site === '甲站', `副标题是站点名（实际「${view.site}」）`)
  ok(view.rows.length === 2, `列出 2 个模型（实际 ${view.rows.length}）`)
  ok(view.meta.includes('2 个模型'), `顶部标了模型数（实际「${view.meta}」）`)
  ok(view.rows.some((r) => r.name === 'model-b' && r.text.includes('已忽略')), '被忽略的模型也在清单里，并标着「已忽略」')
  const rowA = view.rows.find((r) => r.name === 'model-a')?.text || ''
  ok(rowA.includes('¥1.00') && rowA.includes('¥4.00'), `显示的是乘过倍率的实际价（实际「${rowA}」）`)

  // -------------------------------------------------------- 5. 换分组换内容
  console.log('[5] 换一颗胶囊 → 内容跟着换')
  await ev(clickChip('备用分组'))
  for (let i = 0; i < 40; i += 1) {
    view = await ev(drawer)
    if (view.title === '备用分组') break
    await sleep(100)
  }
  ok(view.title === '备用分组' && view.rows.length === 3, `抽屉内容换成了备用分组（${view.rows.length} 个模型）`)
  const rowE = view.rows.find((r) => r.name === 'model-e')?.text || ''
  ok(rowE.includes('按次') && rowE.includes('¥0.500'), `按次模型显示 /次 单价（实际「${rowE}」）`)
  ok(view.rows.some((r) => r.name === 'model-f' && r.text.includes('免费')), '0 元模型标了「免费」')

  // -------------------------------------------------------- 6. 还没同步的分组
  console.log('[6] Key 有分组但还没同步过模型')
  await ev(clickChip('待同步分组'))
  for (let i = 0; i < 40; i += 1) {
    view = await ev(drawer)
    if (view.title === '待同步分组') break
    await sleep(100)
  }
  ok(view.open && view.rows.length === 0, '空分组不显示假数据')
  ok(view.empty.includes('还没同步过模型'), `空状态说清了原因（实际「${view.empty.slice(0, 40)}…」）`)
  ok(view.empty.includes('一键同步'), '空状态给出了下一步怎么做')

  // -------------------------------------------------------- 7. 关闭方式
  console.log('[7] 关闭与不误触')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(150)
  ok(!(await ev(drawer)).open, 'Esc 能关掉抽屉')

  await ev(clickChip('主力分组'))
  await sleep(150)
  await ev(`document.querySelector('#group-models .modal-backdrop').click()`)
  await sleep(150)
  ok(!(await ev(drawer)).open, '点背景能关掉抽屉')

  // 胶囊里嵌着「删分组」按钮：点那个垃圾桶不能顺手把抽屉也打开
  await ev(`window.confirm = () => false`)
  const deleteClicked = await ev(`(() => {
    const x = document.querySelector('#monitor-sites-host .prov-group-chips .group-chip[data-group="主力分组"] .chip-x')
    if (!x) return 'missing'
    x.click()
    return 'ok'
  })()`)
  await sleep(150)
  ok(deleteClicked === 'ok' && !(await ev(drawer)).open, '点胶囊里的垃圾桶不会误开抽屉')

  // -------------------------------------------------------- 8. 键盘可开
  console.log('[8] 键盘 Enter 也能开')
  await ev(`(() => {
    const chip = document.querySelector('#monitor-sites-host .prov-group-chips .group-chip[data-group="主力分组"]')
    chip.focus()
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  for (let i = 0; i < 40; i += 1) {
    view = await ev(drawer)
    if (view.open) break
    await sleep(100)
  }
  ok(view.open && view.rows.length === 2, 'Tab 聚焦后按 Enter 能打开抽屉')

  // -------------------------------------------------------- 9. 密钥面板的「总 / 忽略 / 可用」
  console.log('[9] 密钥面板：模型数三个数字都能点开')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(150)
  await ev(`document.querySelector('#monitor-sites-host [data-act="prov-panel"][data-panel="keys"]').click()`)

  const keyRow = `(() => {
    const row = document.querySelector('#prov-modal-body .keyrow[data-credential="${mainCred.id}"]')
    if (!row) return null
    const counts = [...row.querySelectorAll('.key-models .gs-count')].map((b) => ({
      filter: b.dataset.filter,
      text: b.textContent.replace(/\\s+/g, ' ').trim(),
      title: b.getAttribute('title') || '',
    }))
    return { label: row.querySelector('.key-models')?.textContent.replace(/\\s+/g, ' ').trim() || '', counts }
  })()`

  let keyView = null
  for (let i = 0; i < 40; i += 1) {
    keyView = await ev(keyRow)
    if (keyView) break
    await sleep(150)
  }
  ok(Boolean(keyView), '密钥面板里找到了主力 Key 那一行')
  ok(
    keyView.counts.map((c) => c.filter).join(',') === 'all,ignored,avail',
    `三个数字的顺序是 总 / 忽略 / 可用（实际 ${keyView.counts.map((c) => c.filter).join(',')}）`,
  )
  ok(
    keyView.counts.map((c) => c.text).join(' | ') === '总 2 | 忽略 1 | 可用 1',
    `数字对得上（实际「${keyView.counts.map((c) => c.text).join(' | ')}」）`,
  )
  ok(Boolean(keyView.counts[0].title), '数字带「点开看清单」的提示文案')

  const clickKeyCount = (filter) => `(() => {
    const btn = document.querySelector('#prov-modal-body .keyrow[data-credential="${mainCred.id}"] .gs-count[data-filter="${filter}"]')
    if (!btn) return 'missing'
    btn.click()
    return 'ok'
  })()`

  ok((await ev(clickKeyCount('ignored'))) === 'ok', '找到了「忽略」那个数字')
  for (let i = 0; i < 40; i += 1) {
    view = await ev(drawer)
    if (view.open) break
    await sleep(100)
  }
  ok(view.open && view.title === '主力 Key · 主力分组', `标题是 Key 标签 + 分组（实际「${view.title}」）`)
  ok(view.site.includes('甲站') && view.site.includes('sk-••••0001'), `副标题标出是哪把 Key（实际「${view.site}」）`)
  ok(
    view.rows.length === 1 && view.rows[0].name === 'model-b',
    `点「忽略」只列被忽略的那一个（实际 ${view.rows.map((r) => r.name).join(',') || '空'}）`,
  )
  ok(view.rows[0].text.includes('已忽略'), '被忽略的模型在清单里也标着「已忽略」')

  const clickSeg = (filter) => `(() => {
    const btn = document.querySelector('#group-models-body .seg button[data-filter="${filter}"]')
    if (!btn) return 'missing'
    btn.click()
    return 'ok'
  })()`

  ok((await ev(clickSeg('avail'))) === 'ok', '弹窗里也能切到「可用」')
  for (let i = 0; i < 40; i += 1) {
    view = await ev(drawer)
    if (view.rows.length === 1 && view.rows[0].name === 'model-a') break
    await sleep(100)
  }
  ok(
    view.rows.length === 1 && view.rows[0].name === 'model-a',
    `「可用」排除了被忽略的 model-b（实际 ${view.rows.map((r) => r.name).join(',') || '空'}）`,
  )

  await ev(clickSeg('all'))
  for (let i = 0; i < 40; i += 1) {
    view = await ev(drawer)
    if (view.rows.length === 2) break
    await sleep(100)
  }
  ok(view.rows.length === 2, `「总」把被忽略的也列出来（${view.rows.length} 行）`)

  // 改忽略状态后（在别处改的）弹窗里的标记要跟着变
  await ev(`document.querySelector('#group-models .modal-backdrop').click()`)
  await ev(`fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ignoredModels: [] }) })`)
  // 弹窗是 cloneNode 副本，render() 不会更新里面的数字——得重新打开一次（真实用户也是这么做的）
  await ev(`document.querySelector('#refresh-btn').click()`)
  await sleep(400)
  await ev(`document.querySelector('#prov-modal .modal-backdrop').click()`)
  await ev(`document.querySelector('#monitor-sites-host [data-act="prov-panel"][data-panel="keys"]').click()`)
  for (let i = 0; i < 40; i += 1) {
    keyView = await ev(keyRow)
    if (keyView && keyView.counts[2].text === '可用 2') break
    await sleep(150)
  }
  ok(keyView.counts[2].text === '可用 2', `取消忽略后可用变成 2（实际「${keyView.counts[2].text}」）`)
  await ev(clickKeyCount('avail'))
  for (let i = 0; i < 40; i += 1) {
    view = await ev(drawer)
    if (view.open && view.rows.length === 2) break
    await sleep(100)
  }
  ok(view.rows.length === 2, `弹窗里也是 2 行（实际 ${view.rows.length}）`)
  await ev(`document.querySelector('#group-models .modal-backdrop').click()`)
  await ev(`fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ignoredModels: ['model-b'] }) })`)
  await ev(`document.querySelector('#prov-modal .modal-backdrop').click()`)
  await sleep(150)

  // -------------------------------------------------------- 10. 英文界面
  console.log('[10] 切到英文再打开一次')
  await ev(`localStorage.setItem('manageapi.lang','en')`)
  await send('Page.reload', { ignoreCache: true })
  let reloaded = false
  for (let i = 0; i < 150 && !reloaded; i += 1) {
    reloaded = await ev(`!!document.querySelector('#monitor-sites-host .prov-group-chips')`)
    if (!reloaded) await sleep(200)
  }
  ok(reloaded, '英文界面刷新后站点卡还在')
  await ev(clickChip('主力分组'))
  for (let i = 0; i < 40; i += 1) {
    view = await ev(drawer)
    if (view.open) break
    await sleep(100)
  }
  ok(view.meta.includes('models'), `模型数翻成英文（实际「${view.meta}」）`)
  ok(view.rows.some((r) => r.text.includes('Ignored')), '「已忽略」翻成 Ignored')
  await ev(clickChip('备用分组'))
  for (let i = 0; i < 40; i += 1) {
    view = await ev(drawer)
    if (view.title === '备用分组') break
    await sleep(100)
  }
  const rowEEn = view.rows.find((r) => r.name === 'model-e')?.text || ''
  ok(rowEEn.includes('Per call') && rowEEn.includes('/call'), `按次与 /次 翻成英文（实际「${rowEEn}」）`)
} catch (error) {
  failed += 1
  console.error(`  ✗ ${error.message}`)
} finally {
  await cleanup()
}

console.log(`\n结果：${failed ? `失败 ${failed} 项` : '全部通过'}`)
process.exit(failed ? 1 : 0)
