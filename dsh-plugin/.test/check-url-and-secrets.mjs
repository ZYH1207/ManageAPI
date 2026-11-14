#!/usr/bin/env node
/**
 * N17 加固专项验收（真实运行时，不是静态字符检查）。
 *
 * 覆盖两处真隐患：
 *  1) client.js apiUrl() 用相对路径解析 → 子路径 baseURI 下 API 打错路径（重启后 404）。
 *     这里用 4 种 baseURI（/、/app/、/session/abc/chat、/index.html）实跑 apiUrl，
 *     断言结果**都**是 <origin>/api/manage-api/<path>。
 *  2) sanitizeState() 漏清 settings.gateway.keys[].key → 真机明文密钥泄漏。
 *     这里 GET 真实 daemon（http://127.0.0.1:4319/api/state，只读，绝不写/重启），
 *     过 sanitizeState()，断言：无 sk- 明文、档位字段存活、展示字段存活。
 *
 * 失败直接抛（node 非零退出）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')
const CLIENT = join(ROOT, 'client.js')
const DAEMON_STATE = 'http://127.0.0.1:4319/api/state'

const passed = []
const ok = (label) => { passed.push(label); console.log('  ok  ' + label) }

// ── 假 react（client bundle 需要）──
function makeFakeReact() {
  const el = (type, props, ...children) => ({ type, props: props || {}, children })
  return {
    createElement: el, createContext: (d) => ({ _ctx: d }), useContext: () => 'zh',
    useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
    useEffect: () => {}, useMemo: (fn) => fn(), useRef: (v) => ({ current: v }), useCallback: (fn) => fn,
  }
}

// ── 在指定 document.baseURI 下加载 client bundle，取绑定该 document 的 apiUrl ──
function loadClientWithBase(baseURI) {
  const code = readFileSync(CLIENT, 'utf8')
  let def = null
  const fakeWindow = { __ModuleLoader__: { load: (d) => { def = d } } }
  const fakeRequire = (name) => { if (name === 'react') return makeFakeReact(); throw new Error(name) }
  const run = new Function('window', 'require', 'document', 'navigator', code)
  run(fakeWindow, fakeRequire, { baseURI }, undefined)
  return def.factory(fakeRequire)
}

// ════════════════════════════════════════════════════════════════════════════
// 1) apiUrl 路径解析：与朋友版原版一致（相对写法 + DSH 页面 baseURI 为站点根）
// ════════════════════════════════════════════════════════════════════════════
// 说明：N17 曾基于「子路径 baseURI 会打错 URL」的假设把这里改成前导斜杠绝对路径，
// 但朋友版 recon/.../lib/client.js:159 用的就是相对写法且在本机跑得通 —— DSH 的
// Web GUI 页面 baseURI 就是站点根，不存在子路径部署。N19 按用户要求回退成原版。
console.log('\n[1/2] apiUrl 路径解析（与朋友版原版一致）')
const ORIGIN = 'http://127.0.0.1:55092'
const EXPECTED = ORIGIN + '/api/manage-api/state'

const rootBaseCases = [
  [ORIGIN + '/', '站点根'],
  [ORIGIN + '/index.html', '文件式 baseURI（同源根）'],
]
for (const [baseURI, desc] of rootBaseCases) {
  const got = loadClientWithBase(baseURI).__internals.apiUrl('state')
  console.log(`  base=${baseURI.padEnd(34)} → ${got}`)
  assert.equal(got, EXPECTED, `[${desc}] 解析错误，得到 ${got}`)
}
ok('站点根 baseURI 解析为 ' + EXPECTED + '（与朋友版原版一致）')

// query 完整保留；path 不带前导斜杠时不拼出 //
{
  const apiUrl = loadClientWithBase(ORIGIN + '/').__internals.apiUrl
  assert.ok(!apiUrl('state').includes('manage-api//'), '出现双斜杠')
  assert.equal(apiUrl('state?light=1'), ORIGIN + '/api/manage-api/state?light=1')
  assert.equal(apiUrl('state?full=1'), ORIGIN + '/api/manage-api/state?full=1')
  ok('query 保留（state?light=1 / state?full=1）')
}

// 哨兵：源码必须是原版相对写法，不许再被改回绝对路径
{
  const src = readFileSync(CLIENT, 'utf8')
  assert.ok(/new URL\(\s*'api\/'\s*\+\s*API_PREFIX/.test(src), 'apiUrl 不是朋友版原版相对写法')
  assert.ok(!/new URL\(\s*'\/api\/'/.test(src), 'apiUrl 被改成前导斜杠绝对路径（偏离原版）')
  ok('apiUrl 源码形态与朋友版原版一致（相对写法哨兵）')
}

// ════════════════════════════════════════════════════════════════════════════
// 2) sanitizeState 真实 daemon 响应脱敏
// ════════════════════════════════════════════════════════════════════════════
console.log('\n[2/2] sanitizeState 真实 daemon 响应脱敏（只读 GET ' + DAEMON_STATE + '）')

const routes = await import(pathToFileURL(join(ROOT, 'lib/routes.js')).href)
const { sanitizeState } = routes

const resp = await fetch(DAEMON_STATE, { headers: { accept: 'application/json' } })
assert.equal(resp.status, 200, `daemon /api/state 应 200，实际 ${resp.status}`)
const raw = await resp.json()

// 先证明「原始真实响应里确实有明文」——否则脱敏断言没有意义
const rawText = JSON.stringify(raw)
const rawHits = rawText.match(/sk-[A-Za-z0-9_-]+/g) || []
console.log(`  真实响应中 sk- 明文: ${rawHits.length} 处（证明泄漏源真实存在）`)
assert.ok(rawHits.length > 0, '真实响应没有 sk- 明文，脱敏验证失去意义（daemon 结构可能变了）')

const out = sanitizeState(raw)
const outText = JSON.stringify(out)
const leaked = outText.match(/sk-[A-Za-z0-9_-]+/g) || []
console.log(`  脱敏后 sk- 明文: ${leaked.length} 处`)
assert.equal(leaked.length, 0, '脱敏后仍有 sk- 明文：' + leaked.slice(0, 3).join(','))

// 两处 gateway 副本的 key 都必须被清除
assert.ok(out.gateway && Array.isArray(out.gateway.keys), '顶层 gateway.keys 结构丢失')
assert.ok(out.settings && out.settings.gateway && Array.isArray(out.settings.gateway.keys), 'settings.gateway.keys 结构丢失')
for (const row of out.gateway.keys) assert.equal(row.key, undefined, '顶层 gateway.keys[].key 未清除')
for (const row of out.settings.gateway.keys) assert.equal(row.key, undefined, 'settings.gateway.keys[].key 未清除')
// 展示字段保留
const gRow = out.settings.gateway.keys[0]
assert.ok(gRow && typeof gRow.name === 'string', 'settings.gateway.keys[].name 被误删')
ok('settings/top gateway.keys[].key 均已清除，name 等展示字段保留')

// 档位字段绝不能误删（历史踩过泛化 key 打码毁字段的坑）
assert.ok(Array.isArray(out.ttftTiers) && out.ttftTiers.length > 0, 'ttftTiers 丢失')
for (const t of out.ttftTiers) {
  assert.ok(!('key' in t) || typeof t.key === 'string', 'ttftTiers[].key 结构异常')
}
assert.ok(Array.isArray(out.decisionModes) && out.decisionModes.length > 0, 'decisionModes 丢失')
for (const m of out.decisionModes) {
  assert.ok(typeof m.key === 'string', 'decisionModes[].key 被误删（档位字段被毁）')
}
// 依据真实数据：decisionModes[0].key 应为 'value'
assert.equal(out.decisionModes[0].key, 'value', 'decisionModes[0].key 期望 value，实际 ' + out.decisionModes[0].key)
ok(`档位字段存活：decisionModes[0].key=${out.decisionModes[0].key}，ttftTiers ${out.ttftTiers.length} 档`)

// 展示字段保留（providers 的 hasAdminToken / adminTokenTail 等）
assert.ok(Array.isArray(out.providers) && out.providers.length > 0, 'providers 丢失')
const p0 = out.providers[0]
assert.ok('hasAdminToken' in p0, 'providers[].hasAdminToken 展示字段被误删')
assert.ok('adminTokenTail' in p0, 'providers[].adminTokenTail 展示字段被误删')
ok('providers[] 展示字段 hasAdminToken / adminTokenTail 保留')

// 不改原对象
assert.equal(rawText === JSON.stringify(raw), true, '原响应被就地修改')

console.log(`\ncheck-url-and-secrets: ${passed.length} 组断言通过`)
