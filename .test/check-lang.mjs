/**
 * 验证语言切换能来回切干净：切到英文再切回中文，静态文案必须复位。
 * 用法：chrome --headless=new --remote-debugging-port=9222 about:blank &
 *       node .test/check-lang.mjs
 */
const APP = process.env.SHOT_APP || 'http://127.0.0.1:4319'
const CDP = process.env.SHOT_CDP || 'http://127.0.0.1:9222'

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
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

/** 语言是下拉菜单：先点按钮展开，再点具体那一项 */
const pickLang = async (lang) => {
  await ev(`document.querySelector('#lang-btn').click()`)
  await sleep(250)
  await ev(`document.querySelector('[data-act="set-lang"][data-lang="${lang}"]').click()`)
  await sleep(800)
}

await pickLang('en')
const en = await ev(SNAPSHOT)
console.log('② 切到英文：', JSON.stringify(en))

await pickLang('zh')
const zh2 = await ev(SNAPSHOT)
console.log('③ 切回中文：', JSON.stringify(zh2))

const same = JSON.stringify(zh1) === JSON.stringify(zh2)
console.log(same ? '✅ 来回切换后完全一致' : '❌ 切回来有残留，逐项对比：')
if (!same) {
  for (const k of Object.keys(zh1)) {
    if (zh1[k] !== zh2[k]) console.log(`   ${k}: ${JSON.stringify(zh1[k])} → ${JSON.stringify(zh2[k])}`)
  }
}

// 再切一次，确认多次往返也稳
await pickLang('en')
await pickLang('zh')
const zh3 = await ev(SNAPSHOT)
console.log(JSON.stringify(zh1) === JSON.stringify(zh3) ? '✅ 二次往返仍然一致' : '❌ 二次往返出现偏差')

ws.close()
