/**
 * 站点卡「还有 N 个分组」自检：折叠只露 6 个，点一下必须能看全，再点收起。
 *
 * 背景：分组多的时候卡片上只印「还有 N 个」，而它原来是个 <span>——
 * 多出来的分组在界面上没有任何入口能看，等于数据被藏死了。
 * 这里钉死：初始只露 6 个 → 点「还有 N 个」露全部 → 点「收起」回到 6 个。
 *
 * 浏览器层用 CDP 驱动本机 Chrome（与 check-lang / capture-shots 同一套做法），
 * 自己起 daemon、自己起无头 Chrome，跑完自动清理。
 *
 * 用法：node .test/check-group-chips.mjs
 * 环境变量：CHROME 指向 Chrome 可执行文件（找不到就跳过浏览器断言）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GROUPS = ['免押池', 'Pro 号池', '企业通道', '特价池', '生图专用', '长上下文', 'Claude 专用', '小号池']
const VISIBLE = 6

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
const HOME = await mkdtemp(join(tmpdir(), 'mapi-groups-'))
process.env.MANAGE_API_HOME = HOME
const inventory = await import(pathToFileURL(join(ROOT, 'core/inventory.js')).href)

console.log('[1] 造一个 8 个分组的站点')
const provider = await inventory.createProvider({ name: '分组很多站', baseUrl: 'http://127.0.0.1:5199/v1' })
for (const [i, group] of GROUPS.entries()) {
  const cred = await inventory.createCredential({
    providerId: provider.id,
    label: `Key ${i + 1}`,
    secret: `sk-groups-${i + 1}`,
    group,
  })
  await inventory.syncOffers(provider.id, cred.id, [`model-${i + 1}`], group)
}
{
  const { readDb } = await import(pathToFileURL(join(ROOT, 'core/store.js')).href)
  const db = await readDb()
  const seeded = new Set(db.offers.filter((o) => o.providerId === provider.id).map((o) => o.group))
  ok(GROUPS.every((g) => seeded.has(g)), `台账里有 ${GROUPS.length} 个分组（实际 ${seeded.size}）`)
}

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

  if (!chromePath) {
    console.log('  · 没找到 Chrome（可用 CHROME=/path/to/chrome 指定），跳过浏览器断言')
    console.log(`\n结果：${failed ? '失败' : '通过'}`)
    await cleanup()
    process.exit(failed ? 1 : 0)
  }

  // -------------------------------------------------------- 无头 Chrome + CDP
  console.log('[2] 无头 Chrome 打开站点页')
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

  const snapshot = `(() => {
    const host = document.querySelector('#monitor-sites-host')
    const named = [...host.querySelectorAll('.prov-group-chips > span.group-chip')].map((el) => {
      const x = el.querySelector('.chip-x')
      if (x) x.remove()
      return el.textContent.trim()
    })
    const more = host.querySelector('[data-act="toggle-group-chips"]')
    return {
      named,
      moreText: more ? more.textContent.trim() : '',
      moreJs: more ? more.getAttribute('class') : '',
    }
  })()`

  // -------------------------------------------------------- 1. 默认折叠
  const folded = await ev(snapshot)
  ok(folded.named.length === VISIBLE, `默认只露 ${VISIBLE} 个分组（实际 ${folded.named.length}）`)
  ok(folded.moreText === `还有 ${GROUPS.length - VISIBLE} 个`, `折叠提示是「还有 ${GROUPS.length - VISIBLE} 个」（实际「${folded.moreText}」）`)
  ok(folded.moreJs.includes('group-chip-more'), '折叠提示是按钮样式（group-chip-more）')

  // -------------------------------------------------------- 2. 点开看全部
  await ev(`document.querySelector('#monitor-sites-host [data-act="toggle-group-chips"]').click()`)
  let expanded = null
  for (let i = 0; i < 40; i += 1) {
    expanded = await ev(snapshot)
    if (expanded.named.length === GROUPS.length) break
    await sleep(100)
  }
  ok(expanded.named.length === GROUPS.length, `点开后露全部 ${GROUPS.length} 个（实际 ${expanded.named.length}）`)
  const lastGroup = GROUPS[GROUPS.length - 1]
  ok(
    expanded.named.some((name) => name.includes(lastGroup)),
    `最后一个分组「${lastGroup}」现在真的看得见`,
  )
  ok(expanded.moreText === '收起', `展开后提示变成「收起」（实际「${expanded.moreText}」）`)

  // -------------------------------------------------------- 3. 再点收起
  await ev(`document.querySelector('#monitor-sites-host [data-act="toggle-group-chips"]').click()`)
  let refolded = null
  for (let i = 0; i < 40; i += 1) {
    refolded = await ev(snapshot)
    if (refolded.named.length === VISIBLE) break
    await sleep(100)
  }
  ok(refolded.named.length === VISIBLE, `收起后回到 ${VISIBLE} 个（实际 ${refolded.named.length}）`)
  ok(
    refolded.moreText === `还有 ${GROUPS.length - VISIBLE} 个`,
    `收起后提示复位（实际「${refolded.moreText}」）`,
  )
} catch (error) {
  failed += 1
  console.error(`  ✗ ${error.message}`)
} finally {
  await cleanup()
}

console.log(`\n结果：${failed ? `失败 ${failed} 项` : '全部通过'}`)
process.exit(failed ? 1 : 0)
