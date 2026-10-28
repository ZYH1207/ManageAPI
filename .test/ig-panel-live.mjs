/**
 * 一次性验证：忽略模型面板改版（两栏：左圆角模型组卡 / 右逐行开关徽章）
 * 对着预览实例 4516 用无头 Chrome 点一遍。结束时把忽略名单恢复原状。
 * 用法：node .test/ig-panel-live.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, accessSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:4516'
let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chromePath = (() => {
  for (const p of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ]) {
    try {
      accessSync(p)
      return p
    } catch {}
  }
  return null
})()

const chromeDir = mkdtempSync(join(tmpdir(), 'mapi-ig-'))
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=9433',
    `--user-data-dir=${chromeDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let ws = null
let seq = 0
const pending = new Map()
const ev = async (expression) => {
  const r = await new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
  if (r.result?.exceptionDetails) throw new Error('页面执行出错: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}

try {
  let page = null
  for (let i = 0; i < 100 && !page; i += 1) {
    try {
      const list = await (await fetch('http://127.0.0.1:9433/json/list')).json()
      page = list.find((t) => t.type === 'page')
    } catch {}
    if (!page) await sleep(150)
  }
  if (!page) throw new Error('Chrome 没起调试端口')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))

  await ev(`location.href = '${BASE}/#pricing'`)
  await sleep(500)
  let ready = false
  for (let i = 0; i < 100 && !ready; i += 1) {
    ready = await ev(`!!document.querySelector('[data-act="ignored-models"]')`)
    if (!ready) await sleep(200)
  }
  ok(ready, '比价页渲染出「管理」入口')

  const original = await ev(`fetch('/api/state').then(r=>r.json()).then(s=>JSON.stringify(s.settings.ignoredModels||[]))`)
  const before = JSON.parse(original).length
  console.log(`  · 初始忽略名单 ${before} 条`)

  // 打开面板
  await ev(`document.querySelector('[data-act="ignored-models"]').click()`)
  await sleep(300)
  ok(await ev(`!!document.querySelector('.ig-split')`), '面板是两栏布局')
  const groupCount = await ev(`document.querySelectorAll('.ig-vendor-row').length`)
  ok(groupCount > 0, `左栏有 ${groupCount} 个模型组（圆角卡）`)
  ok(await ev(`!!document.querySelector('.ig-pane-right .hint') && !document.querySelector('.ig-model-row')`), '默认不展开：右栏只有提示')

  // 选第一个组 → 右栏出模型行
  await ev(`document.querySelector('.ig-vendor-row').click()`)
  await sleep(250)
  const rowCount = await ev(`document.querySelectorAll('.ig-model-row').length`)
  ok(rowCount > 0, `点组后右栏列出 ${rowCount} 个模型`)
  ok(await ev(`!!document.querySelector('.ig-model-row .ig-chip')`), '每行带「已忽略/已显示」开关徽章')
  ok(await ev(`document.querySelector('.ig-vendor-row').classList.contains('active')`), '选中的组高亮')

  // 点一个「已显示」→ 忽略；再点回「已显示」→ 还原。断言按集合语义（id 在/不在名单），
  // 不比条数：首次 PATCH 会把历史名单里的重复写法归一成身份键（一次性的去重）
  const state1 = await ev(`fetch('/api/state').then(r=>r.json()).then(s=>JSON.stringify(s.settings.ignoredModels||[]))`)
  const list1 = JSON.parse(state1)
  const chipId = await ev(`document.querySelector('.ig-model-row .ig-chip.ig-off').dataset.id`)
  await ev(`document.querySelector('.ig-model-row .ig-chip.ig-off').click()`)
  await sleep(500)
  ok(await ev(`!!document.querySelector('.ig-model-row .ig-chip.ig-on')`), '点完徽章翻成「已忽略」')
  const list2 = JSON.parse(await ev(`fetch('/api/state').then(r=>r.json()).then(s=>JSON.stringify(s.settings.ignoredModels||[]))`))
  ok(list2.includes(chipId) && !list1.includes(chipId), `名单里多了这个模型（${chipId}）`)
  await ev(`document.querySelector('.ig-chip[data-id="${chipId}"]').click()`)
  await sleep(500)
  const list3 = JSON.parse(await ev(`fetch('/api/state').then(r=>r.json()).then(s=>JSON.stringify(s.settings.ignoredModels||[]))`))
  ok(!list3.includes(chipId), `点回「已显示」名单还原（${chipId} 不在名单）`)

  // 整组忽略 / 全部显示
  const groupSize = await ev(`document.querySelectorAll('.ig-model-row').length`)
  await ev(`document.querySelector('[data-ig-bulk="ignore"]').click()`)
  await sleep(600)
  const state4 = await ev(`fetch('/api/state').then(r=>r.json()).then(s=>s.settings.ignoredModels.length)`)
  ok(await ev(`document.querySelectorAll('.ig-model-row .ig-chip.ig-on').length`) === groupSize, '整组忽略后全组变灰')
  await ev(`document.querySelector('[data-ig-bulk="show"]').click()`)
  await sleep(600)
  ok(await ev(`document.querySelectorAll('.ig-model-row .ig-chip.ig-on').length`) === 0, '全部显示后全组变橙')
  const state5 = await ev(`fetch('/api/state').then(r=>r.json()).then(s=>s.settings.ignoredModels.length)`)
  console.log(`  · 批量后名单 ${state5} 条（初始 ${before}）`)

  // 恢复原状（服务端会再做一次同样的归一，条数应等于首次归一后的基准）
  await ev(`fetch('/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({ignoredModels:${original}})}).then(r=>r.json())`)
  const restored = await ev(`fetch('/api/state').then(r=>r.json()).then(s=>s.settings.ignoredModels.length)`)
  const baseNormalized = JSON.parse(state1).length + 0 // 归一前的原始名单长度仅作参考
  ok(restored === list3.length, `名单已恢复原状（${restored} = 本轮基准 ${list3.length}）`)

  // 搜索框还在
  ok(await ev(`!!document.querySelector('#ig-search')`), '搜索框还在')

  // 合并弹窗（复用旧结构类）不受 CSS 改动影响：打开不出错
  await ev(`document.querySelector('#prov-modal .modal-backdrop').click()`)
  await sleep(200)
  await ev(`document.querySelector('[data-act="merge-models"]').click()`)
  await sleep(300)
  ok(await ev(`!!document.querySelector('#prov-modal .ig-list')`), '合并弹窗照常渲染（旧结构类还活着）')
} catch (error) {
  failed += 1
  console.error('  ✗ ' + error.message)
} finally {
  try { ws?.close() } catch {}
  try { chrome?.kill() } catch {}
  await sleep(300)
  try { rmSync(chromeDir, { recursive: true, force: true }) } catch {}
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
