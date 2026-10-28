/**
 * 用无头 Chrome 抓 README 需要的截图。
 *
 * 前置：
 *   MANAGE_API_HOME=/tmp/showcase node .test/seed-showcase.mjs
 *   MANAGE_API_HOME=/tmp/showcase node daemon/index.js --port 4400
 *   chrome --headless=new --remote-debugging-port=9222 about:blank &
 *   node .test/capture-shots.mjs
 *
 * 说明：展示数据里的站点是虚构域名，读不到真实分组，所以「选分组」那张截图用 CDP
 * 拦截 /groups 请求、回一份形状一致的假响应——界面代码是真实的，只有数据是编的。
 *
 * 注意：探针记录的时间是「跑脚本那一刻」，评分有效期只有 6 小时。所以抓图前要重新
 * seed 一次，否则截出来全是「评分过期」。
 */
import { writeFile } from 'node:fs/promises'

const APP = process.env.SHOT_APP || 'http://127.0.0.1:4400'
const CDP = process.env.SHOT_CDP || 'http://127.0.0.1:9222'
const OUT = process.env.SHOT_OUT || 'docs'

const MOCK_GROUPS = {
  providerId: 'p_show01',
  current: '特价池',
  source: 'channels',
  hasGroupInfo: true,
  unmatched: [],
  groups: [
    { name: '特价池', rate: 0.1, modelCount: 4, isCurrent: true },
    { name: '默认分组', rate: 0.4, modelCount: 4, isCurrent: false },
    { name: 'Pro 号池', rate: 0.65, modelCount: 3, isCurrent: false },
    { name: '企业通道', rate: 0.8, modelCount: 3, isCurrent: false },
    { name: '生图专用', rate: 1, modelCount: 0, isCurrent: false },
    { name: 'Claude 专用', rate: 1.2, modelCount: 0, isCurrent: false },
  ],
}

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) throw new Error('没有可用的 page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const listeners = new Map()

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
    return
  }
  const handler = listeners.get(msg.method)
  if (handler) handler(msg.params)
})
await new Promise((resolve) => ws.addEventListener('open', resolve))

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
  return r.result?.result?.value
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(`${OUT}/screenshot-${name}.png`, Buffer.from(r.result.data, 'base64'))
  console.log(`  ✓ screenshot-${name}.png`)
}

async function goto(hash) {
  await send('Page.navigate', { url: `${APP}/${hash}` })
  await sleep(1400)
  await send('Page.reload', { ignoreCache: true })
  await sleep(1600)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
})

// 强制界面语言（默认中文；SHOT_LANG=en 出英文图）和主题（默认浅色）
const LANG = process.env.SHOT_LANG || 'zh'
const THEME = process.env.SHOT_THEME || 'light'
await send('Page.navigate', { url: `${APP}/` })
await sleep(1200)
await evalJs(`localStorage.setItem('manageapi.lang', '${LANG}'); localStorage.setItem('manageapi.theme', '${THEME}')`)

// 拦截 /api/providers/*/groups，回一份假的分组列表
listeners.set('Fetch.requestPaused', async ({ requestId, request }) => {
  if (request.url.endsWith('/groups')) {
    await send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify(MOCK_GROUPS)).toString('base64'),
    })
  } else {
    await send('Fetch.continueRequest', { requestId })
  }
})
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/providers/*' }] })

// name 决定文件名，hash 决定抓哪一页（站点页已并入监控页，保留 providers 这个名字给 README 用）
const pages = [
  { name: 'overview', hash: '#overview' },
  { name: 'monitor', hash: '#monitor' },
  // 站点卡已经并入监控页：README 的「站点页」那张要滚到卡片区，不然和监控页完全重复
  { name: 'providers', hash: '#monitor', scroll: '.sites-head' },
  { name: 'free', hash: '#free' },
  { name: 'free-platform', hash: '#free/platform' },
  { name: 'free-relay', hash: '#free/relay' },
  { name: 'decision', hash: '#decision' },
  { name: 'probes', hash: '#probes' },
  { name: 'gateway', hash: '#gateway' },
  { name: 'usage', hash: '#usage' },
  { name: 'benchmark', hash: '#benchmark' },
]
for (const { name, hash, scroll } of pages) {
  console.log(`抓 ${name}…`)
  await goto(hash)
  if (scroll) {
    // 页面滚的是 .content 这个容器，不是 window
    await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(scroll)})
      const box = document.querySelector('.content')
      if (!el || !box) return
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 10
      box.scrollTo(0, top)
    })()`)
    await sleep(450)
  }
  await shot(name)
}

console.log('抓分组弹窗…')
await goto('#monitor')
await evalJs(`document.querySelector('[data-act="prov-panel"][data-panel="rates"]').click()`)
await sleep(1200)
await shot('groups')
await evalJs(`document.querySelector('[data-act="close-prov-panel"]').click()`)
await sleep(300)

console.log('抓使用说明…')
// README 说的是顶栏「文档」打开的弹窗（带左侧目录），不是 #help 整页
await goto('#overview')
await evalJs(`document.querySelector('[data-act="show-help"]').click()`)
await sleep(900)
await shot('help')

console.log('抓语言菜单…')
await goto('#overview')
await evalJs(`document.querySelector('#lang-btn').click()`)
await sleep(500)
await shot('lang')
await evalJs(`document.querySelector('#lang-btn').click()`)
await sleep(300)

console.log('抓深色模式…')
await goto('#overview')
// 点按钮而不是直接改 dataset：这样「深色模式 / 浅色模式」的文案也会跟着翻
await evalJs(`if (!document.documentElement.dataset.theme) document.querySelector('#theme-btn').click()`)
await sleep(600)
await shot('dark')

console.log('完成')
ws.close()
