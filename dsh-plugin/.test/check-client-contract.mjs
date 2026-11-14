#!/usr/bin/env node
/**
 * E 棒 · Client 契约静态验收（不启动浏览器、不启动 daemon）。
 *
 * 覆盖验收标准要求的 5 类检查：
 *   1. client.js 语法可解析 + 自足导出（假 window.__ModuleLoader__ + 假 react 能 load/apply）
 *   2. package.json 的 exports["./client"] 路径与真实产物匹配（含 dsh.client.platform=web）
 *   3. locale zh/en 键完整度比对，并与 client 内联 MESSAGES 键集一致（双语无缺失）
 *   4. THEME_CSS + EXTRA_CSS 作用域化（每条选择器以 .ma-root 开头；无 :root/html/body/裸 * /@import/外链）
 *   5. Client 内部 API 路径与 C 棒 ROUTES / write-proxy 的 WRITE_ACTIONS 对齐（默认拒绝不越界）
 *
 * 注意：本测试是**静态检查**，不证明真实浏览器视觉、布局、交互或 live slot props。
 * Client Slots 未在线核验，故不得据此宣称 UI 已挂载/视觉已验收。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')
const CLIENT = join(ROOT, 'client.js')
const PKG = join(ROOT, 'package.json')

const passed = []
async function ok(label, fn) { await fn(); passed.push(label); console.log('  ✓ ' + label) }

// ── 假 react：只满足 factory 顶层 + 组件定义所需，不会被真正渲染 ──────────────
function makeFakeReact() {
  const el = (type, props, ...children) => ({ type, props: props || {}, children })
  const ctx = (def) => ({ _ctx: def })
  return {
    createElement: el,
    createContext: ctx,
    useContext: () => 'zh',
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
  }
}

function loadClientFactory() {
  const code = readFileSync(CLIENT, 'utf8')
  let def = null
  const fakeWindow = { __ModuleLoader__: { load: (d) => { def = d } } }
  const fakeRequire = (name) => {
    if (name === 'react') return makeFakeReact()
    throw new Error('client 只应 require("react")，实际请求：' + name)
  }
  // 用 new Function 在提供的 window/require 下执行 bundle（不提供 document/navigator → 走兜底分支）
  const run = new Function('window', 'require', 'document', 'navigator', code)
  run(fakeWindow, fakeRequire, undefined, undefined)
  assert.ok(def, 'window.__ModuleLoader__.load 未被调用')
  return def
}

// ── 选择器作用域化检查 ──────────────────────────────────────────────────────
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}
function splitTopLevel(sel) {
  const out = []; let depth = 0; let cur = ''
  for (const ch of sel) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}
function ruleSelectors(css) {
  css = stripComments(css)
  const selectors = []
  const stack = []
  let i = 0; let start = 0
  while (i < css.length) {
    const ch = css[i]
    if (ch === '{') {
      const prelude = css.slice(start, i).trim()
      if (prelude.startsWith('@')) {
        const nm = prelude.slice(1).split(/[\s({]/)[0].toLowerCase()
        stack.push({ raw: /keyframes/.test(nm), at: true })
      } else {
        const parentRaw = stack.length > 0 && stack[stack.length - 1].raw
        if (!parentRaw) selectors.push(prelude)
        stack.push({ raw: parentRaw, at: false })
      }
      start = i + 1
    } else if (ch === '}') { stack.pop(); start = i + 1 }
    i++
  }
  return selectors
}
function assertScoped(css, label, min = 50) {
  const sels = ruleSelectors(css)
  assert.ok(sels.length >= min, label + '：选择器数量过少（' + sels.length + ' < ' + min + '）')
  const bad = []
  for (const group of sels) {
    for (const one of splitTopLevel(group)) {
      if (!one.startsWith('.ma-root')) bad.push(one.slice(0, 60))
    }
  }
  assert.deepEqual(bad.slice(0, 10), [], label + '：存在未作用域化选择器（前 10 条）')
  assert.ok(!/@import\b/.test(css), label + '：出现 @import')
  assert.ok(!/url\(\s*['"]?https?:/i.test(css), label + '：出现外链 url()')
}

try {
  console.log('\n[1/5] client.js 语法与自足导出')
  await ok('node --check client.js', () => {
    execFileSync(process.execPath, ['--check', CLIENT], { stdio: 'pipe' })
  })
  const def = loadClientFactory()
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
  const app = def.factory((n) => { if (n === 'react') return makeFakeReact(); throw new Error(n) })
  await ok('load 的 def.id 等于包名', () => assert.equal(def.id, pkg.name))
  await ok('factory 返回 apply/inject/name', () => {
    assert.equal(typeof app.apply, 'function')
    assert.ok(Array.isArray(app.inject) && app.inject.includes('slots'))
    assert.equal(typeof app.name, 'string')
  })
  await ok('apply(fakeCtx) 在 3 个 slot 上完成注册且返回 dispose', () => {
    const regs = []
    const fakeSlots = {
      inject: (name, cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
      register: (d) => { regs.push(d.name); return () => {} },
    }
    const fakeCtx = { get: (n) => (n === 'slots' ? fakeSlots : undefined), logger: () => ({ warn() {}, info() {} }) }
    const dispose = app.apply(fakeCtx)
    assert.deepEqual(regs.sort(), ['main', 'settings.section', 'sidebar.panellist'])
    assert.equal(typeof dispose, 'function')
    dispose()
  })
  await ok('apply 在无 slots 服务时不抛（软降级）', () => {
    const dispose = app.apply({ get: () => undefined })
    assert.equal(typeof dispose, 'function')
  })

  console.log('\n[2/5] package.json exports / dsh.client')
  await ok('exports["./client"] 指向存在的 client.js', () => {
    assert.equal(pkg.exports['./client'], './client.js')
    readFileSync(join(ROOT, pkg.exports['./client']), 'utf8')
  })
  await ok('dsh.client.platform === "web"', () => {
    assert.equal(pkg.dsh.client.platform, 'web')
  })
  await ok('exports["."] 与 files 自洽', () => {
    assert.ok(pkg.exports['.'])
    readFileSync(join(ROOT, pkg.exports['.']), 'utf8')
    assert.ok(Array.isArray(pkg.files) && pkg.files.includes('client.js'))
  })

  console.log('\n[3/5] locale zh/en 键完整度 + client 内联键集一致')
  const flatten = (o, p = '') => Object.entries(o).flatMap(([k, v]) =>
    (v && typeof v === 'object' && !Array.isArray(v)) ? flatten(v, p + k + '.') : [p + k])
  const en = flatten(JSON.parse(readFileSync(join(ROOT, 'locale/en.json'), 'utf8')))
  const zh = flatten(JSON.parse(readFileSync(join(ROOT, 'locale/zh.json'), 'utf8')))
  await ok('locale en / zh 键集合完全相等', () => {
    const onlyEn = en.filter((k) => !zh.includes(k))
    const onlyZh = zh.filter((k) => !en.includes(k))
    assert.deepEqual(onlyEn, [], 'en 多出：' + onlyEn.join(','))
    assert.deepEqual(onlyZh, [], 'zh 多出：' + onlyZh.join(','))
  })
  const inlineEn = Object.keys(app.__internals.messages.en).sort()
  const inlineZh = Object.keys(app.__internals.messages.zh).sort()
  await ok('client 内联 en/zh 键集相等', () => assert.deepEqual(inlineEn, inlineZh))
  await ok('locale 文件键集合（去 meta）与 client 内联 MESSAGES 一致', () => {
    const fileKeys = en.filter((k) => k !== 'meta.title' && k !== 'meta.description').sort()
    const inlineKeys = inlineEn.filter((k) => k !== 'meta.title').sort()
    assert.deepEqual(inlineKeys, fileKeys)
  })

  console.log('\n[4/5] CSS 作用域化 / 防全局污染')
  const theme = await import(pathToFileURL(join(ROOT, 'lib/theme.js')).href)
  await ok('lib/theme.js 导出 THEME_CSS 且足够大', () => {
    assert.ok(typeof theme.THEME_CSS === 'string' && theme.THEME_CSS.length > 10000)
  })
  await ok('THEME_CSS 每条选择器以 .ma-root 开头', () => assertScoped(theme.THEME_CSS, 'THEME_CSS'))
  await ok('EXTRA_CSS 每条选择器以 .ma-root 开头', () => assertScoped(app.__internals.extraCss, 'EXTRA_CSS', 10))
  await ok('client 内嵌的 THEME_CSS 非空（embed 成功）', () => {
    assert.ok(app.__internals.themeCssLength > 10000)
  })

  console.log('\n[5/5] API 路径与 C 棒 ROUTES / write-proxy 对齐')
  const routes = await import(pathToFileURL(join(ROOT, 'lib/routes.js')).href)
  const wp = await import(pathToFileURL(join(ROOT, 'lib/write-proxy.js')).href)
  const contract = app.__internals.contract
  await ok('contract.prefix === C 棒 PREFIX', () => assert.equal(contract.prefix, routes.PREFIX))
  await ok('每个只读 readPath 都命中 ROUTES.path', () => {
    const known = new Set(routes.ROUTES.map((r) => r.path))
    const miss = contract.readPaths.filter((p) => !known.has(p))
    assert.deepEqual(miss, [], '未在 ROUTES 中：' + miss.join(','))
  })
  await ok('每个 writeAction 都命中 WRITE_ACTIONS', () => {
    const known = new Set(wp.WRITE_ACTIONS)
    const miss = contract.writeActions.filter((a) => !known.has(a))
    assert.deepEqual(miss, [], '未在白名单：' + miss.join(','))
  })
  const src = readFileSync(CLIENT, 'utf8')
  await ok('client 源码实际以 /api/manage-api 前缀发请求', () => {
    assert.ok(src.includes("'/api/manage-api'") || src.includes('"/api/manage-api"'), '缺 PREFIX 字面量')
    assert.ok(/var API_PREFIX = 'manage-api'/.test(src))
  })
  await ok('client 源码里每个 writeAction 字面量都出现', () => {
    const miss = contract.writeActions.filter((a) => !src.includes("'" + a + "'"))
    assert.deepEqual(miss, [], '源码未使用：' + miss.join(','))
  })
  await ok('client 不使用 panel 查询参数 / 面板独立忽略名单 / dshFreeModels 数据访问', () => {
    // 去掉注释后再扫，避免把说明文字误判成数据访问
    const srcCode = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.ok(!/state\?panel/.test(srcCode), '出现 state?panel')
    assert.ok(!/\bpanel=1\b/.test(srcCode), '出现 panel=1')
    assert.ok(!/(?:settings|state|data|\bs)\.panelIgnoredModels/.test(srcCode), '出现 panelIgnoredModels 数据访问')
    assert.ok(!/panelIgnoredModels\s*:/.test(srcCode), '出现 panelIgnoredModels 写入')
    assert.ok(!/(?:settings|data|\bs)\.dshFreeModels/.test(srcCode), '出现 dshFreeModels 数据访问')
    assert.ok(!/dshFreeModels\s*:/.test(srcCode), '出现 dshFreeModels 写入')
  })
  await ok('TABS 严格为真实 10 项且不含 free', () => {
    assert.deepEqual(app.__internals.TABS, ['overview', 'monitor', 'route', 'decision', 'probes', 'protocol', 'gateway', 'usage', 'benchmark', 'diagnosis'])
    assert.ok(!app.__internals.TABS.includes('free'), 'TABS 仍含 free')
  })
  await ok('VIEWS 不含 free 键（FreeView 已移除）', () => {
    assert.ok(!Object.prototype.hasOwnProperty.call(app.__internals.VIEWS, 'free'), 'VIEWS 仍含 free')
  })
  await ok('源码不含 FreeView / free.title / free.writesUnavailable / freePoolWrites', () => {
    assert.ok(!/FreeView/.test(src), '源码仍含 FreeView')
    assert.ok(!/free\.title/.test(src), '源码仍含 free.title')
    assert.ok(!/free\.writesUnavailable/.test(src), '源码仍含 free.writesUnavailable')
    assert.ok(!/freePoolWrites/.test(src), '源码仍含 freePoolWrites')
  })

  console.log('\n[6/6] apiUrl 路径解析：任意 baseURI 都锚定到 origin 根的 /api/manage-api/')
  // 用可控假 document.baseURI 重新加载 bundle，拿到绑定该 document 的 apiUrl
  const loadClientWithBase = (baseURI) => {
    const code = readFileSync(CLIENT, 'utf8')
    let d = null
    const fakeWindow = { __ModuleLoader__: { load: (x) => { d = x } } }
    const fakeRequire = (name) => { if (name === 'react') return makeFakeReact(); throw new Error(name) }
    const run = new Function('window', 'require', 'document', 'navigator', code)
    run(fakeWindow, fakeRequire, { baseURI }, undefined)
    return d.factory(fakeRequire)
  }
  // N17 曾基于「DSH 页面可能部署在子路径」的假设改成前导斜杠绝对路径，并按该假设
  // 加了「4 种 baseURI 都必须锚定到根」的断言。朋友版 recon/.../lib/client.js:159
  // 用的是相对写法且在本机跑得通 —— DSH 的 Web GUI 页面 baseURI 就是站点根。
  // N19 按用户要求回退成原版，这里同步把断言口径改回「站点根 + 原版形态」。
  const ORIGIN = 'http://127.0.0.1:55092'
  const EXPECTED = ORIGIN + '/api/manage-api/state'
  const rootBaseCases = [ORIGIN + '/', ORIGIN + '/index.html']
  for (const baseURI of rootBaseCases) {
    await ok('baseURI=' + baseURI + ' → ' + EXPECTED, () => {
      const apiUrl = loadClientWithBase(baseURI).__internals.apiUrl
      assert.equal(apiUrl('state'), EXPECTED, '站点根解析错误')
    })
  }
  await ok('不拼出双斜杠', () => {
    const apiUrl = loadClientWithBase(ORIGIN + '/').__internals.apiUrl
    assert.ok(!apiUrl('state').includes('manage-api//state'), '出现双斜杠')
  })
  await ok('query 参数完整保留（state?light=1 / state?full=1）', () => {
    const apiUrl = loadClientWithBase(ORIGIN + '/').__internals.apiUrl
    assert.equal(apiUrl('state?light=1'), EXPECTED + '?light=1')
    assert.equal(apiUrl('state?full=1'), EXPECTED + '?full=1')
  })
  await ok('apiUrl 与朋友版原版一致（相对写法哨兵）', () => {
    const src = readFileSync(join(ROOT, 'client.js'), 'utf8')
    assert.ok(/new URL\(\s*'api\/'\s*\+\s*API_PREFIX/.test(src), 'apiUrl 不是原版相对写法')
    assert.ok(!/new URL\(\s*'\/api\/'/.test(src), 'apiUrl 被改成绝对路径（偏离原版）')
  })

  console.log('\n全部通过：' + passed.length + ' 项')
  console.log('注意：以上为静态检查，不证明真实浏览器视觉/布局/交互/live slot 挂载。')
} catch (err) {
  console.error('\n✗ 失败：' + (err && err.stack ? err.stack : err))
  process.exit(1)
}
