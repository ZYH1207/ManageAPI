/**
 * 把界面上所有中文文案抓出来，作为 i18n 词典的工作清单。
 *
 * 走 DOM 的文本节点而不是扫源码：源码里的模板字符串会被拆成 `<b>` / `<code>` 多段，
 * 而翻译是作用在文本节点上的，所以只有真实渲染出来的片段才是要翻译的单位。
 *
 * 用法：
 *   chrome --headless=new --remote-debugging-port=9222 about:blank &
 *   node .test/dump-strings.mjs > /tmp/strings.txt
 */
import { writeFile } from 'node:fs/promises'

const APP = process.env.SHOT_APP || 'http://127.0.0.1:4400'
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

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  return r.result?.result?.value
}

const COLLECT = `(() => {
  const out = new Set()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const v = walker.currentNode.nodeValue.trim()
    if (!v) continue
    if (!/[\\u4e00-\\u9fa5]/.test(v)) continue
    out.add(v)
  }
  for (const el of document.querySelectorAll('[title],[placeholder],[aria-label]')) {
    for (const a of ['title', 'placeholder', 'aria-label']) {
      const v = (el.getAttribute(a) || '').trim()
      if (v && /[\\u4e00-\\u9fa5]/.test(v)) out.add('@' + v)
    }
  }
  return [...out]
})()`

const all = new Set()
const collect = async () => {
  for (const s of await evalJs(COLLECT)) all.add(s)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

const tabs = ['overview', 'providers', 'pricing', 'decision', 'probes', 'gateway', 'usage', 'benchmark']
for (const tab of tabs) {
  await send('Page.navigate', { url: `${APP}/#${tab}` })
  await sleep(1200)
  await send('Page.reload', { ignoreCache: true })
  await sleep(1400)
  await collect()
}

// 弹窗：选分组 / 使用说明 / 联系我们 / 通知面板
await send('Page.navigate', { url: `${APP}/#providers` })
await sleep(1400)
await evalJs(`document.querySelector('[data-act="open-group-picker"]')?.click()`)
await sleep(900)
await collect()
await evalJs(`document.querySelector('[data-act="close-group-modal"]')?.click()`)
await sleep(200)

await evalJs(`document.querySelector('#notify-btn')?.click()`)
await sleep(500)
await collect()

await evalJs(`document.querySelector('[data-act="show-contact"]')?.click()`)
await sleep(600)
await collect()
await evalJs(`document.querySelector('[data-act="close-contact"]')?.click()`)
await sleep(200)

await evalJs(`document.querySelector('[data-act="show-help"]')?.click()`)
await sleep(900)
await collect()

const lines = [...all].sort()
await writeFile('C:/Users/ZYH/AppData/Local/Temp/ui-strings.txt', lines.join('\n'), 'utf8')
console.log(`共 ${lines.length} 条`)
ws.close()
