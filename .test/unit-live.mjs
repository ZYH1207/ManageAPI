/**
 * 一次性验证：比价页价格单位（USD / R$）真换算 + 2 秒去抖 + 滚动保持。
 * 对预览 4516 用无头 Chrome 点一遍，结束恢复 USD。用法：node .test/unit-live.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, accessSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:4516'
let failed = 0
const ok = (c, m) => {
  if (c) console.log('  ✓ ' + m)
  else {
    failed++
    console.error('  ✗ ' + m)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chromePath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => {
  try {
    accessSync(p)
    return true
  } catch {
    return false
  }
})

// 取比价表里某个前缀（'$' / 'R$'）的最大价格值：重排不改数据，最大值跨单位可比
const maxPriceOf = (prefix) =>
  `Math.max(...[...document.querySelectorAll('.pricing-table td.num')]` +
  `.map(td=>({s:td.textContent.trim()}))` +
  `.map(x=>({v:parseFloat(x.s.split('').filter(c=>(c>='0'&&c<='9')||c==='.').join('')),t:x.s}))` +
  `.filter(x=>Number.isFinite(x.v)&&x.v>0&&x.t.startsWith('${prefix}')).map(x=>x.v))`

const dir = mkdtempSync(join(tmpdir(), 'mapi-unit-'))
const chrome = spawn(
  chromePath,
  ['--headless=new', '--remote-debugging-port=9434', `--user-data-dir=${dir}`, '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'],
  { stdio: 'ignore' },
)
let ws
let seq = 0
const pending = new Map()
const ev = async (expr) => {
  const r = await new Promise((res) => {
    const id = ++seq
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
  })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  return r.result?.result?.value
}
try {
  let page = null
  for (let i = 0; i < 100 && !page; i++) {
    try {
      page = (await (await fetch('http://127.0.0.1:9434/json/list')).json()).find((t) => t.type === 'page')
    } catch {}
    if (!page) await sleep(150)
  }
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))
  await ev(`location.href='${BASE}/#pricing'`)
  await sleep(1000)
  ok(await ev(`!!document.querySelector('#display-currency')`), '单位选择器在')
  ok(
    (await ev(`[...document.querySelector('#display-currency').options].map(o=>o.value).join(',')`)) === 'USD,RUSD',
    '只剩 USD / R.Dollar 两档',
  )
  await ev(`fetch('/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({displayCurrency:'USD'})}).then(r=>r.json())`)
  await ev(`location.reload()`)
  await sleep(1000)
  const rate = await ev(`fetch('/api/state').then(r=>r.json()).then(s=>s.settings.fx?.rates?.CNY||7.2)`)
  const sampleUsd = await ev(maxPriceOf('$'))
  ok(Number.isFinite(sampleUsd) && sampleUsd > 0, `USD 基准（全表最大价 ${sampleUsd}）`)
  await ev(`document.querySelector('.content').scrollTop = 300`)
  await ev(`(()=>{const el=document.querySelector('#display-currency'); el.value='RUSD'; el.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await sleep(300)
  const mid = await ev(`[...document.querySelectorAll('.pricing-table td.num')].map(td=>td.textContent.trim()).find(t=>/^R\\$[\\d.]+|^\\$[\\d.]+/.test(t))`)
  ok(mid && mid.startsWith('$'), '2 秒内页面不动（仍是 $）')
  await sleep(2200)
  const sampleR = await ev(maxPriceOf('R$'))
  ok(Number.isFinite(sampleR) && sampleR > 0, `2 秒后重排成 R$（全表最大价 ${sampleR}）`)
  const usdVal = parseFloat(sampleUsd)
  const rVal = parseFloat(sampleR)
  ok(Math.abs(usdVal / rVal - rate) < rate * 0.02, `数值真的变了：${usdVal} ÷ ${rVal} ≈ 汇率 ${rate}`)
  const scrollAfter = await ev(`document.querySelector('.content').scrollTop`)
  ok(Math.abs(scrollAfter - 300) < 5, `滚动位置保住（${scrollAfter} ≈ 300）`)
  ok(await ev(`![...document.querySelectorAll('.pricing-table')].some(t=>t.textContent.includes('¥'))`), '比价页不再出现硬编码 ¥')
  // 综合成本列专项：同一行在两种单位下的值
  // 综合成本列专项：同一行在两种单位下的值（td.num 顺序：入价/出价/倍率/综合成本）
  const costCol = (unit) =>
    `[...document.querySelectorAll('.pricing-table tbody tr')]` +
    `.map(tr=>tr.querySelectorAll('td.num')[5]?.textContent.trim().split('\\n')[0])` +
    `.filter(t=>t && t.startsWith('${unit}'))[0]`
  // 先回 USD 取基准，再切 R$ 取对照
  await ev(`fetch('/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({displayCurrency:'USD'})}).then(r=>r.json())`)
  await ev(`location.reload()`)
  await sleep(1200)
  const cUsd = await ev(costCol('$'))
  ok(!!cUsd && cUsd.startsWith('$'), `USD 基准综合成本（${cUsd}）`)
  await ev(`(()=>{const el=document.querySelector('#display-currency'); el.value='RUSD'; el.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await sleep(1800)
  const cR = await ev(costCol('R$'))
  ok(!!cR && cR.startsWith('R$'), `切 R$ 后综合成本（${cR}）`)
  const uVal = parseFloat(cUsd.slice(1))
  const rVal2 = parseFloat(cR.slice(2))
  ok(uVal > 0 && rVal > 0 && Math.abs(uVal / rVal2 - rate) < rate * 0.02, `同一行综合成本真换算：${uVal} ÷ ${rVal2} ≈ ${rate}`)
  await ev(`fetch('/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({displayCurrency:'USD'})})`)
} catch (e) {
  failed++
  console.error('  ✗ ' + e.message)
} finally {
  try {
    ws?.close()
  } catch {}
  try {
    chrome.kill()
  } catch {}
  await sleep(300)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed ? 1 : 0)
