/**
 * 分组胶囊配色自检：模型全被忽略的分组，颜色不能掉。
 *
 * 背景：胶囊色按「这个分组里有什么模型」聚合出来。以前证据取自 state.offers，
 * 而它只含「会参与路由」的供给（inv.routeableOffers）——一个分组的模型全被
 * 忽略之后，那组就变成空数组，胶囊掉回中性灰。现场表现是密钥页一半分组没颜色，
 * 看着像那些分组坏了；站点页只露前 6 个分组，正好都是有颜色的，于是两边看着不一致。
 *
 * 这里钉死：
 *   1. 台账里 claude / 生图 两个分组的模型全被忽略（state.offers 里确实一条不剩）；
 *   2. 密钥行与站点卡上的胶囊仍按厂商上色，且两处同色（同一分组跨页面必须同色）；
 *   3. 混合厂商仍然中性灰（含被忽略的那一家），没模型的分组也仍然中性灰——不猜。
 *
 * 浏览器层用 CDP 驱动本机 Chrome（与 check-group-chips / check-lang 同一套做法），
 * 自己起 daemon、自己起无头 Chrome，跑完自动清理。
 *
 * 用法：node .test/check-group-chip-vendor.mjs
 * 环境变量：CHROME 指向 Chrome 可执行文件（找不到就只跑接口层断言）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 分组名 → 期望的胶囊 class（'' = 中性灰，不上色）
const EXPECT = {
  'claude 号池': 'vchip-anthropic', // 模型全被忽略，仍要按厂商上色
  生图: 'vchip-openai', // 同上
  国模池: 'vchip-cn',
  'gemini 组': 'vchip-google',
  混合池: '', // 国产 + Claude（后者被忽略）→ 混合，中性灰
  空分组: '', // 一个模型都没同步过，没有证据可猜
}
const IGNORED = ['claude-opus-4-8', 'claude-sonnet-5', 'gpt-image-2']

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

/** 从 className 里挑出 vchip-*；没有就是中性灰 */
function chipClassOf(className) {
  return (String(className || '').match(/vchip-[\w-]+/) || [''])[0]
}

// ---------------------------------------------------------------- 造数据
const HOME = await mkdtemp(join(tmpdir(), 'mapi-chip-'))
process.env.MANAGE_API_HOME = HOME
const inventory = await import(pathToFileURL(join(ROOT, 'core/inventory.js')).href)

console.log('[1] 造一个分组里有 Claude / 生图 / 国产 / Gemini / 混合 / 空 的站点')
const provider = await inventory.createProvider({ name: '配色站', baseUrl: 'http://127.0.0.1:5199/v1' })
const seed = [
  ['claude 号池', ['claude-opus-4-8', 'claude-sonnet-5']],
  ['生图', ['gpt-image-2']],
  ['国模池', ['deepseek-v4.1-flash']],
  ['gemini 组', ['gemini-3.8-flash']],
  ['混合池', ['deepseek-v4.1-flash', 'claude-opus-4-8']],
  ['空分组', []],
]
for (const [i, [group, models]] of seed.entries()) {
  const cred = await inventory.createCredential({
    providerId: provider.id,
    label: `Key ${i + 1}`,
    secret: `sk-chip-${i + 1}`,
    group,
  })
  if (models.length) await inventory.syncOffers(provider.id, cred.id, models, group)
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

  // -------------------------------------------------------- 接口层：先把模型全忽略掉
  console.log('[2] 忽略 Claude / 生图 的模型，确认它们在 state.offers 里消失')
  const patched = await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ignoredModels: IGNORED }),
  })
  ok(patched.ok, '忽略名单写入成功')
  const state = await (await fetch(`${base}/api/state`)).json()
  const liveGroups = new Set(state.offers.filter((o) => o.providerId === provider.id).map((o) => o.group))
  ok(!liveGroups.has('claude 号池'), 'claude 号池在 state.offers 里一条不剩（这就是以前掉色的触发条件）')
  ok(!liveGroups.has('生图'), '生图在 state.offers 里一条不剩')
  ok(liveGroups.has('国模池') && liveGroups.has('gemini 组'), '没被忽略的分组仍在役')
  const ledger = state.modelsByGroup?.[provider.id] || {}
  ok((ledger['claude 号池'] || []).length === 2, 'modelsByGroup 仍是全量台账（claude 号池 2 条）')
  ok((ledger['claude 号池'] || []).every((m) => m.ignored), '台账里这两条都标着「已忽略」')

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

  let ready = false
  for (let i = 0; i < 150 && !ready; i += 1) {
    ready = await ev(`!!document.querySelector('#monitor-sites-host .prov-group-chips')`)
    if (!ready) await sleep(200)
  }
  if (!ready) throw new Error('站点卡一直没渲染出来')

  // 两个页面的胶囊都取一遍：站点卡上的（span）和密钥行上的（button）
  const snapshot = `(() => {
    const host = document.querySelector('#monitor-sites-host')
    const card = [...host.querySelectorAll('.prov-group-chips > span.group-chip')].map((el) => ({
      group: el.textContent.trim(),
      cls: el.className,
    }))
    const key = [...host.querySelectorAll('[data-pane="keys"] .keyrow .group-chip')].map((el) => ({
      group: el.textContent.trim().replace(/^分组 · /, ''),
      cls: el.className,
    }))
    return { card, key }
  })()`

  const shot = await ev(snapshot)
  const cardOf = new Map(shot.card.map((c) => [c.group, chipClassOf(c.cls)]))
  const keyOf = new Map(shot.key.map((c) => [c.group, chipClassOf(c.cls)]))
  ok(shot.card.length === seed.length, `站点卡上 6 个分组都在（实际 ${shot.card.length}）`)
  ok(shot.key.length === seed.length, `密钥行 6 个分组都在（实际 ${shot.key.length}）`)

  console.log('[4] 密钥行：全被忽略的分组也要按厂商上色')
  for (const [group, want] of Object.entries(EXPECT)) {
    ok(keyOf.get(group) === want, `密钥行「${group}」→ ${want || '中性灰'}（实际 ${keyOf.get(group) || '中性灰'}）`)
  }

  console.log('[5] 站点卡：与密钥行同色')
  for (const [group, want] of Object.entries(EXPECT)) {
    ok(cardOf.get(group) === want, `站点卡「${group}」→ ${want || '中性灰'}（实际 ${cardOf.get(group) || '中性灰'}）`)
    ok(cardOf.get(group) === keyOf.get(group), `「${group}」两处同色（站点卡 ${cardOf.get(group) || '中性灰'} / 密钥行 ${keyOf.get(group) || '中性灰'}）`)
  }
} catch (error) {
  failed += 1
  console.error(`  ✗ ${error.message}`)
} finally {
  await cleanup()
}

console.log(`\n结果：${failed ? `失败 ${failed} 项` : '全部通过'}`)
process.exit(failed ? 1 : 0)
