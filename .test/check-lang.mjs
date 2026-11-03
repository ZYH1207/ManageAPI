/**
 * 验证语言切换能来回切干净：切到英文再切回中文，静态文案必须复位。
 *
 * 自包含：自己起一份空库 daemon + 自己的无头 Chrome 调试端口，不依赖
 * 「4319 上正好在跑」和「9222 上正好有个 Chrome」。
 *
 * 原来这版写死了 `SHOT_APP || 'http://127.0.0.1:4319'` 和
 * `SHOT_CDP || 'http://127.0.0.1:9222'`，脚本第一行就 `fetch(CDP/json/list)`
 * 不带 try——本机没开 9222 时直接 `TypeError: fetch failed ... ECONNREFUSED`，
 * 于是它在全量套件里永远红。红得还很危险：4319 是**生产实例**，就算 9222 开着，
 * 这个测试也会拿真实数据去打真实的界面（AGENTS.local.md 铁律 0.5 正是禁止这个）。
 *
 * 现在照 check-route-target-forward / check-group-chips 的骨架来：
 * 空库 mktemp 目录 + 自己抢端口 + 退出时收拾干净。
 *
 * 用法：node .test/check-lang.mjs
 * 可选：SHOT_APP / SHOT_CDP 仍支持——给了就连现成的那一份，不再自己起。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
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

/** 与 check-group-chips.mjs 同一份候选表：macOS 上 Chrome 在 .app 里，PATH 上没有 */
function findChrome() {
  const candidates = [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) || null
}

// ---------------------------------------------------------------- 起服务（可跳过）
let HOME = null
let app = null
let chrome = null
let chromeDir = null
let ws = null

async function cleanup() {
  try { ws?.close() } catch { /* 忽略 */ }
  try { chrome?.kill() } catch { /* 忽略 */ }
  try { app?.kill() } catch { /* 忽略 */ }
  await sleep(300)
  if (chromeDir) await rm(chromeDir, { recursive: true, force: true }).catch(() => {})
  if (HOME) await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

let APP = process.env.SHOT_APP || null
let CDP = process.env.SHOT_CDP || null

try {
  if (!APP) {
    HOME = await mkdtemp(join(tmpdir(), 'mapi-lang-'))
    const port = await freePort()
    app = spawn(process.execPath, ['daemon/index.js', '--port', String(port)], {
      cwd: ROOT,
      env: { ...process.env, MANAGE_API_HOME: HOME, MANAGE_API_PROBE_FIRST_DELAY_MS: '600000' },
      stdio: 'ignore',
    })
    APP = `http://127.0.0.1:${port}`
    let ready = false
    for (let i = 0; i < 100 && !ready; i += 1) {
      try {
        ready = (await fetch(`${APP}/api/health`)).ok
      } catch {
        /* 还没起来 */
      }
      if (!ready) await sleep(150)
    }
    if (!ready) throw new Error('服务没起来')
  }

  if (!CDP) {
    const chromePath = findChrome()
    if (!chromePath) {
      // 没 Chrome 就**判失败**，不能报「通过」——浏览器断言一条没跑却打绿勾，
      // 是最坏的一种绿（本机确实装了 Chrome，正常情况永远走不到这里）。
      console.log('找不到 Chrome（可用 CHROME=/path/to/chrome 指定），语言断言无法执行')
      console.log('结果：失败（浏览器断言未执行）')
      await cleanup()
      process.exit(1)
    }
    chromeDir = await mkdtemp(join(tmpdir(), 'mapi-lang-chrome-'))
    const cdpPort = await freePort()
    chrome = spawn(
      chromePath,
      [
        '--headless=new',
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${chromeDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1440,900',
        'about:blank',
      ],
      { stdio: 'ignore' },
    )
    CDP = `http://127.0.0.1:${cdpPort}`
  }

  // -------------------------------------------------------- 连 CDP 页面
  let page = null
  for (let i = 0; i < 100 && !page; i += 1) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json()
      page = list.find((t) => t.type === 'page')
    } catch {
      /* Chrome 还没起调试端口 */
    }
    if (!page) await sleep(150)
  }
  if (!page) throw new Error(`Chrome 没起调试端口（${CDP}）`)

  ws = new WebSocket(page.webSocketDebuggerUrl)
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
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) return 'EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200)
    return r.result?.result?.value
  }

  const SNAPSHOT = `(() => {
    const pick = (sel) => document.querySelector(sel)?.textContent.trim()
    return {
      brand: pick('.brand .sub'),
      nav1: pick('.nav-title'),
      help: pick('#help-modal h3'),
      contact: pick('#contact-modal h3'),
      group: pick('#group-modal h3'),
      close: pick('#help-modal .modal-head button'),
      fx: pick('.fx span'),
      badge: pick('#topbar-badges span'),
      title: pick('#page-title'),
    }
  })()`

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

  await ev(`localStorage.setItem('manageapi.lang','zh')`)
  await send('Page.navigate', { url: `${APP}/#overview` })
  await sleep(800)
  await send('Page.reload', { ignoreCache: true })
  await sleep(2500)

  const zh1 = await ev(SNAPSHOT)
  console.log('① 初始中文：', JSON.stringify(zh1))
  if (!zh1 || typeof zh1 !== 'object') throw new Error(`快照取不到（页面没起来？）：${JSON.stringify(zh1)}`)

  /** 语言是下拉菜单：先点按钮展开，再点具体那一项 */
  const pickLang = async (lang) => {
    await ev(`document.querySelector('#lang-btn').click()`)
    await sleep(250)
    const clicked = await ev(
      `Boolean(document.querySelector('[data-act="set-lang"][data-lang="${lang}"]')?.click() ?? true)`,
    )
    if (clicked === false) throw new Error(`语言菜单里没有 ${lang}`)
    await sleep(800)
  }

  await pickLang('en')
  const en = await ev(SNAPSHOT)
  console.log('② 切到英文：', JSON.stringify(en))

  await pickLang('zh')
  const zh2 = await ev(SNAPSHOT)
  console.log('③ 切回中文：', JSON.stringify(zh2))

  let failed = 0
  const same = JSON.stringify(zh1) === JSON.stringify(zh2)
  if (same) console.log('✅ 来回切换后完全一致')
  else {
    failed += 1
    console.log('❌ 切回来有残留，逐项对比：')
    for (const k of Object.keys(zh1)) {
      if (zh1[k] !== zh2[k]) console.log(`   ${k}: ${JSON.stringify(zh1[k])} → ${JSON.stringify(zh2[k])}`)
    }
  }

  // 切到英文时至少要有几处真的变了，否则「一致」可能只是切换本身没生效
  const switched = Object.keys(zh1).filter((k) => zh1[k] && en[k] && zh1[k] !== en[k])
  if (switched.length >= 3) console.log(`✅ 英文确实生效（${switched.length} 处文案变了）`)
  else {
    failed += 1
    console.log(`❌ 英文没生效（只有 ${switched.length} 处变）`)
  }

  // 再切一次，确认多次往返也稳
  await pickLang('en')
  await pickLang('zh')
  const zh3 = await ev(SNAPSHOT)
  if (JSON.stringify(zh1) === JSON.stringify(zh3)) console.log('✅ 二次往返仍然一致')
  else {
    failed += 1
    console.log('❌ 二次往返出现偏差')
  }

  console.log(`\n结果：${failed ? `失败（${failed} 项）` : '全部通过'}`)
  await cleanup()
  process.exit(failed ? 1 : 0)
} catch (error) {
  console.error(`\n结果：失败 — ${error?.message || error}`)
  await cleanup()
  process.exit(1)
}