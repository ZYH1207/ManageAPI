/**
 * 验证：改行内币种（USD→R.Dollar）后综合成本立即换算——即使焦点还留在下拉里。
 * 这是 2026-10-29 作者报的真 bug：改完下拉盯着综合成本看，它不刷（渲染被
 * 防打字保护扣到焦点离开才补）。修复 = 下拉类字段选完立即提交并 blur。
 * 对预览 4516 无头 Chrome。用法：node .test/row-currency-live.mjs
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
const dir = mkdtempSync(join(tmpdir(), 'mapi-rowcur-'))
const chrome = spawn(
  chromePath,
  ['--headless=new', '--remote-debugging-port=9435', `--user-data-dir=${dir}`, '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'],
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
      page = (await (await fetch('http://127.0.0.1:9435/json/list')).json()).find((t) => t.type === 'page')
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
  await sleep(1200)

  const row = await ev(`(()=>{
    for (const tr of document.querySelectorAll('.pricing-table tbody tr')) {
      const sel = tr.querySelector('select[data-field="currency"]')
      if (!sel) continue
      const cost = tr.querySelectorAll('td.num')[5]?.textContent.trim().split('\\n')[0]
      if (cost && cost.startsWith('$') && parseFloat(cost.slice(1)) > 0) {
        return { offerId: tr.dataset.offer, cost, currency: sel.value }
      }
    }
    return null
  })()`)
  if (!row) throw new Error('没找到可测的行')
  ok(row.currency === 'USD', `样本行 ${row.offerId}（cost=${row.cost}，币种 ${row.currency}）`)
  const base = parseFloat(row.cost.slice(1))

  // 模拟真实操作：先 focus（点开下拉焦点就在这），再选 R.Dollar，不点别处
  await ev(`(()=>{
    const tr = document.querySelector('.pricing-table tbody tr[data-offer="${row.offerId}"]')
    const sel = tr.querySelector('select[data-field="currency"]')
    sel.focus()
    sel.value = 'RUSD'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return document.activeElement === sel
  })()`)
  await sleep(1500)
  const focused = await ev(`document.activeElement?.dataset?.field === 'currency'`)
  const cost = await ev(`document.querySelector('.pricing-table tbody tr[data-offer="${row.offerId}"]')?.querySelectorAll('td.num')[5]?.textContent.trim().split('\\n')[0]`)
  const rate = await (await fetch(`${BASE}/api/state`)).json().then((s) => s.settings.fx?.rates?.CNY || 7.2)
  ok(!!cost && cost.startsWith('$'), `改完币种后综合成本 = ${cost}`)
  const now = parseFloat(cost.slice(1))
  ok(Math.abs(now / base - rate) < rate * 0.02, `换算生效：${base} → ${now}（×${(now / base).toFixed(3)} ≈ 汇率 ${rate.toFixed(3)}）`)
  if (focused) ok(true, '（测试里焦点仍在下拉上，刷新照样发生了）')

  // 还原币种
  await ev(`document.querySelector('.pricing-table tbody tr[data-offer="${row.offerId}"] select[data-field="currency"]').focus()`)
  await ev(`(()=>{
    const tr = document.querySelector('.pricing-table tbody tr[data-offer="${row.offerId}"]')
    const sel = tr.querySelector('select[data-field="currency"]')
    sel.value = 'USD'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await sleep(1500)
  const restored = await ev(`document.querySelector('.pricing-table tbody tr[data-offer="${row.offerId}"]')?.querySelectorAll('td.num')[5]?.textContent.trim().split('\\n')[0]`)
  ok(Math.abs(parseFloat(restored.slice(1)) - base) < base * 0.01, `切回 USD 还原（${restored}）`)
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
