/**
 * 站点卡「已定价 N / M」定价清单自检：点开那个数字，能看全站模型哪些有价、
 * 哪些没有，并就地改价。
 *
 * 版式（作者定稿）：行里不写「已定价/未定价」徽章，直接摆三个数字
 * 输入 / 输出 / 倍率（如 2 / 8 / 0.01）；空档显示横杠，点数字或横杠就地变
 * 输入框，回车/失焦保存，Esc 取消。
 *
 * 钉死的事：
 *   1. 入口：tile 数字是可点按钮，点开弹窗标题「定价」、副标题站点名；
 *   2. 版式：三数字斜杠分隔；已定价口径 = inPrice/outPrice/ratio 任一非空，
 *      未定价排最前；筛选 全部/未定价/已定价 数字对得上；
 *   3. 改价真的落库：横杠点开填输入价 → 回车 → /api/state 里 inPrice 变了，
 *      行上数字更新，站点卡上的 N / M 跟着 +1；
 *   4. 倍率联动：填倍率 → pricingMode 翻 ratio（实际价 = 原价 × 倍率），
 *      清空 → 翻回 manual（pricingMode 是权威，见 core/pricing.js）；
 *   5. Esc 取消不落库；搜索只过滤本弹窗。
 *
 * 浏览器层用 CDP 驱动无头 Chrome（与 check-group-models 同一套做法），
 * 自己起 daemon、自己起无头 Chrome，跑完自动清理。
 *
 * 用法：node .test/check-pricing-sheet.mjs
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
    'C:/Program Files (x86)/Google/Chrome/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) || null
}

// ---------------------------------------------------------------- 造数据
const HOME = await mkdtemp(join(tmpdir(), 'mapi-pricing-sheet-'))
process.env.MANAGE_API_HOME = HOME
const inventory = await import(pathToFileURL(join(ROOT, 'core/inventory.js')).href)

console.log('[1] 造一个站：3 个模型，2 个已定价 1 个没定价')
const provider = await inventory.createProvider({ name: '甲站', baseUrl: 'http://127.0.0.1:5199/v1' })
const cred = await inventory.createCredential({
  providerId: provider.id,
  label: '主力 Key',
  secret: 'sk-main-0001',
  group: '',
})
await inventory.syncOffers(provider.id, cred.id, ['p-a', 'p-b', 'p-c'], '')
const { readDb } = await import(pathToFileURL(join(ROOT, 'core/store.js')).href)
const byName = async (name) =>
  (await readDb()).offers.find((o) => o.providerId === provider.id && o.upstreamName === name)

// p-a：手填单价；p-c：按次；p-b：什么都不填（未定价）
await inventory.updateOfferPrice((await byName('p-a')).id, { inPrice: 2, outPrice: 8, currency: 'CNY' })
await inventory.updateOfferPrice((await byName('p-c')).id, { priceUnit: 'per_call', inPrice: 0.5, currency: 'CNY' })

const db = await readDb()
const mine = db.offers.filter((o) => o.providerId === provider.id)
const pricedCount = mine.filter((o) => o.inPrice !== null || o.outPrice !== null || o.ratio !== null).length
ok(mine.length === 3 && pricedCount === 2, `3 个模型 2 个已定价（得到 ${pricedCount}）`)

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

const getState = async () => (await fetch(`${base}/api/state`)).json()

try {
  await waitReady()
  ok(true, `服务已就绪 :${APP_PORT}`)

  // 显示币种固定成人民币：断言要可重复
  await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayCurrency: 'CNY' }),
  })

  if (!chromePath) {
    console.log('  · 没找到 Chrome（可用 CHROME=/path/to/chrome 指定），跳过浏览器断言')
    console.log(`\n结果：${failed ? '失败' : '通过'}`)
    await cleanup()
    process.exit(failed ? 1 : 0)
  }

  // -------------------------------------------------------- 无头 Chrome + CDP
  console.log('[2] 无头 Chrome 打开站点卡所在页')
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
      '--window-size=1440,900',
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

  let ready = false
  for (let i = 0; i < 150 && !ready; i += 1) {
    ready = await ev(`!!document.querySelector('.prov-card .tile-feature')`)
    if (!ready) await sleep(200)
  }
  if (!ready) throw new Error('站点卡一直没渲染出来')

  // ------------------------------------------------ 3. 点「定价修改」开定价清单
  console.log('[3] 点「定价修改」→ 定价清单')
  const tileText = await ev(`document.querySelector('.prov-card .tile-feature')?.textContent.replace(/\\s+/g, ' ').trim()`)
  ok(/定价修改\s*2 \/ 3/.test(tileText), `tile 是「定价修改 + 2 / 3」（实际「${tileText}」）`)

  await ev(`document.querySelector('.prov-card .tile-feature').click()`)
  const sheetOpen = async () =>
    ev(`(() => {
      const sheet = document.querySelector('#group-models')
      return !!sheet && !sheet.hidden
    })()`)
  let open = false
  for (let i = 0; i < 40 && !open; i += 1) {
    open = await sheetOpen()
    if (!open) await sleep(100)
  }
  ok(open, '弹窗打开了')

  const readSheet = () =>
    ev(`(() => {
      const body = document.querySelector('#group-models-body')
      const rows = [...body.querySelectorAll('tbody tr')].map((row) => ({
        name: row.querySelector('.offer-name')?.textContent.trim() || '',
        trio: row.querySelector('.price-trio')?.textContent.replace(/\\s+/g, ' ').trim() || '',
        slots: [...row.querySelectorAll('.price-slot')].map((s) => ({
          text: s.textContent.trim(),
          empty: s.classList.contains('is-empty'),
          off: s.classList.contains('is-off'),
        })),
        hasBadge: [...row.querySelectorAll('.badge')].some((b) => /定价/.test(b.textContent)),
        hasFree: !!row.querySelector('[data-act="mark-free"]'),
        hasUnitSelect: !!row.querySelector('select[data-field="priceUnit"]'),
        curOptions: [...(row.querySelector('select[data-field="currency"]')?.options || [])].map((o) => o.value),
      }))
      const seg = [...body.querySelectorAll('.seg button')].map((b) => b.textContent.replace(/\\s+/g, '').trim())
      return {
        title: document.querySelector('#group-models-title')?.textContent.trim() || '',
        meta: body.querySelector('.gs-meta .hint')?.textContent.trim() || '',
        seg,
        rows,
      }
    })()`)

  let view = await readSheet()
  ok(view.title.includes('定价'), `标题带「定价」（实际「${view.title}」）`)
  ok(view.rows.length === 3, `3 行（得到 ${view.rows.length}）`)
  ok(view.rows[0].name === 'p-b', `未定价的排最前（第一行 ${view.rows[0].name}）`)
  ok(
    view.rows.every((r) => !r.hasBadge),
    '行里不再写「已定价/未定价」徽章，数字自己会说话',
  )
  const trioOf = (name) => view.rows.find((r) => r.name === name)?.trio
  ok(trioOf('p-a') === '2/8/—', `p-a 三个数字 2/8/—（实际「${trioOf('p-a')}」）`)
  ok(trioOf('p-b') === '—/—/—', `p-b 全是横杠（实际「${trioOf('p-b')}」）`)
  const pcRow = view.rows.find((r) => r.name === 'p-c')
  ok(pcRow?.slots[0]?.text === '0.5', `p-c 输入价显示 0.5（实际「${pcRow?.slots[0]?.text}」）`)
  ok(pcRow?.slots[1]?.off === true, 'p-c 按次：输出位是不可点的横杠')
  ok(view.rows.every((r) => r.hasFree), '标为免费按钮还在')
  ok(view.rows.every((r) => !r.hasUnitSelect), '单位下拉已删：/M 是默认口径，不再让人选（按次由站点声明）')
  ok(
    view.rows.every((r) => r.curOptions.join(',') === 'USD,RUSD'),
    '币种下拉没有 CNY（只剩 USD / R.Dollar）',
  )
  ok(view.seg.join('|').includes('全部3') && view.seg.join('|').includes('未定价1') && view.seg.join('|').includes('已定价2'), `筛选计数对（${view.seg.join(' ')}）`)

  // 几何断言：三数字必须真的在弹窗可视区内。文本在 DOM 里 ≠ 看得见——
  // 表格被 min-width:1000px 撑开、面板只有 520px 时，价格列全被推到滚动区外（真实踩过）
  const geo = await ev(`(() => {
    const panel = document.querySelector('#group-models .modal-panel').getBoundingClientRect()
    const trio = document.querySelector('#group-models-body .price-trio').getBoundingClientRect()
    const wrap = document.querySelector('#group-models-body .table-wrap')
    return {
      trioVisible: trio.left >= panel.left && trio.right <= panel.right,
      noHScroll: wrap.scrollWidth <= wrap.clientWidth + 1,
      panelW: Math.round(panel.width),
    }
  })()`)
  ok(geo.trioVisible, `三数字在弹窗可视区内（面板 ${geo.panelW}px）`)
  ok(geo.noHScroll, '价格表不需要横向滚动')

  // ------------------------------------------------ 4. 筛选 + 搜索
  console.log('[4] 筛选与搜索')
  await ev(`[...document.querySelectorAll('#group-models-body .seg button')].find((b) => b.dataset.filter === 'unpriced').click()`)
  view = await readSheet()
  ok(view.rows.length === 1 && view.rows[0].name === 'p-b', '「未定价」筛选只剩 p-b')

  await ev(`[...document.querySelectorAll('#group-models-body .seg button')].find((b) => b.dataset.filter === 'all').click()`)
  await ev(`(() => {
    const input = document.querySelector('#pricing-sheet-search')
    input.value = 'p-c'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await sleep(150)
  view = await readSheet()
  ok(view.rows.length === 1 && view.rows[0].name === 'p-c', `搜「p-c」只剩 1 行（得到 ${view.rows.length}）`)
  ok(
    (await ev(`document.activeElement?.id`)) === 'pricing-sheet-search',
    '重画后焦点回到搜索框（连续打字不打断）',
  )
  await ev(`(() => {
    const input = document.querySelector('#pricing-sheet-search')
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await sleep(150)

  // ------------------------------------------------ 5. 点横杠就地改价，真的落库
  console.log('[5] 点横杠填输入价 → 回车落库，站点卡数字跟着翻')
  const pbOfferId = (await byName('p-b')).id

  // 「点横杠出输入框」本身要验一次（横杠 = 入口）
  const openInput = await ev(`(() => {
    const row = [...document.querySelectorAll('#group-models-body tbody tr')]
      .find((r) => r.querySelector('.offer-name')?.textContent.trim() === 'p-b')
    row.querySelector('.price-slot[data-field="inPrice"]').click()
    const input = row.querySelector('input.price-slot-input')
    if (!input) return 'no-input'
    input.focus()
    input.value = '3'
    return input === document.activeElement ? 'focused' : 'not-focused'
  })()`)
  ok(openInput === 'focused', '点横杠就地变输入框并聚焦')
  // 换个焦点触发 blur 兜底保存（headless 里 blur 事件不可靠，Enter 才是主路径）
  await ev(`(() => {
    const row = [...document.querySelectorAll('#group-models-body tbody tr')]
      .find((r) => r.querySelector('.offer-name')?.textContent.trim() === 'p-b')
    const input = row.querySelector('input.price-slot-input')
    if (!input) return 'gone'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return 'ok'
  })()`)

  // Enter 即存（不再是停手 2 秒），给网络一点余量
  await sleep(1200)
  const after = await getState()
  const pb = after.offers.find((o) => o.id === pbOfferId)
  ok(Number(pb?.inPrice) === 3, `p-b 输入价落库为 3（得到 ${pb?.inPrice}）`)

  await sleep(600)
  view = await readSheet()
  const trioAfter = view.rows.find((r) => r.name === 'p-b')?.trio
  ok(trioAfter === '3/—/—', `p-b 行变成 3/—/—（实际「${trioAfter}」）`)
  const tileAfter = await ev(`document.querySelector('.prov-card .tile-feature')?.textContent.replace(/\\s+/g, ' ').trim()`)
  ok(tileAfter.includes('3 / 3'), `站点卡数字变成 3 / 3（实际「${tileAfter}」）`)

  // ------------------------------------------------ 6. 倍率联动：填了按倍率走，清空按价格走
  console.log('[6] 填倍率 → pricingMode 翻成 ratio；清空 → 翻回 manual')
  const setSlot = async (field, value) =>
    ev(`(() => {
      const row = [...document.querySelectorAll('#group-models-body tbody tr')]
        .find((r) => r.querySelector('.offer-name')?.textContent.trim() === 'p-b')
      row.querySelector('.price-slot[data-field="${field}"]').click()
      const input = row.querySelector('input.price-slot-input')
      if (!input) return 'no-input'
      input.value = ${JSON.stringify('SLOT_VALUE')}
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return 'ok'
    })()`.replace('"SLOT_VALUE"', JSON.stringify(value)))

  ok((await setSlot('ratio', '0.5')) === 'ok', '倍率横杠点开能填')
  await sleep(1200)
  let mid = (await getState()).offers.find((o) => o.id === pbOfferId)
  ok(mid?.pricingMode === 'ratio' && Number(mid?.ratio) === 0.5, `填倍率后 pricingMode=ratio、ratio=0.5（得到 ${mid?.pricingMode}/${mid?.ratio}）`)

  ok((await setSlot('ratio', '')) === 'ok', '倍率清空')
  await sleep(1200)
  mid = (await getState()).offers.find((o) => o.id === pbOfferId)
  ok(mid?.pricingMode === 'manual' && mid?.ratio === null, `清空后 pricingMode=manual、ratio=null（得到 ${mid?.pricingMode}/${mid?.ratio}）`)

  // Esc 取消：不改任何东西
  await ev(`(() => {
    const row = [...document.querySelectorAll('#group-models-body tbody tr')]
      .find((r) => r.querySelector('.offer-name')?.textContent.trim() === 'p-b')
    row.querySelector('.price-slot[data-field="outPrice"]').click()
    const input = row.querySelector('input.price-slot-input')
    if (!input) return
    input.value = '99'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })()`)
  await sleep(400)
  const escState = (await getState()).offers.find((o) => o.id === pbOfferId)
  ok(escState?.outPrice === null, `Esc 取消不落库（outPrice=${escState?.outPrice}）`)

  // ------------------------------------------------ 7. 关闭
  await ev(`document.querySelector('#group-models [data-act="close-group-models"]')?.click()`)
  ok((await sheetOpen()) === false, '关闭按钮能关掉弹窗')
} catch (error) {
  failed += 1
  console.error(`  ✗ 测试中途抛错：${error.message}`)
} finally {
  await cleanup()
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
