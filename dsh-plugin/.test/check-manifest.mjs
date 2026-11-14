/**
 * B 棒清单/契约形状自测。只读、零第三方运行依赖、不连 4319、
 * 不访问 ~/.manage-api、不安装到 profile、不 spawn 真实进程。
 * 失败直接抛（node 非零退出），不写 process.exit(0) 敷衍。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const passed = []
const ok = (label, fn) => { fn(); passed.push(label) }
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

// ── 真实 YAML 解析器（若可用）+ 自足严格子集解析器（兜底）─────────────
function loadRealYaml() {
  const require = createRequire(import.meta.url)
  const candidates = [
    () => require('yaml'),
    () => require('js-yaml'),
    () => createRequire(pathToFileURL(join('/Applications/Deep Pi.app/Contents/Resources/app/dsh', 'node_modules', 'noop.js')).href)('js-yaml'),
  ]
  for (const attempt of candidates) {
    try {
      const mod = attempt()
      if (mod && typeof mod.load === 'function') return { name: 'yaml/js-yaml', load: (s) => mod.load(s) }
      if (mod && typeof mod.parse === 'function') return { name: 'js-yaml', load: (s) => mod.parse(s) }
    } catch { /* 候选不可用，继续 */ }
  }
  return null
}

/** 严格子集解析：只接受本机 bundle patch 方言，缩进/结构不合规即抛。 */
function parseBundlePatchFallback(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !/^\s*#/.test(l))
  const doc = []
  let group = null
  let row = null
  let configOwner = null
  for (const line of lines) {
    if (/^\s/.test(line) === false && !line.startsWith('- ')) throw new Error(`顶层只能是 "- insert:"：${line}`)
    const indent = line.match(/^ */)[0].length
    const body = line.slice(indent)
    if (indent === 0) {
      if (body !== '- insert:') throw new Error(`未知顶层指令：${body}`)
      group = { insert: [] }
      doc.push(group)
      row = null
      configOwner = null
    } else if (indent === 4 && body.startsWith('- ')) {
      row = {}
      group.insert.push(row)
      configOwner = null
      const kv = body.slice(2).match(/^([A-Za-z][\w-]*):\s*(.*)$/)
      if (!kv) throw new Error(`row 首字段非法：${body}`)
      row[kv[1]] = scalar(kv[2])
    } else if (indent === 6) {
      const kv = body.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
      if (!kv) throw new Error(`row 字段非法：${body}`)
      if (kv[2] === '') {
        row[kv[1]] = {}
        configOwner = kv[1] === 'config' ? row[kv[1]] : null
      } else row[kv[1]] = scalar(kv[2])
    } else if (indent === 8 && configOwner) {
      const kv = body.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
      if (!kv) throw new Error(`config 字段非法：${body}`)
      configOwner[kv[1]] = scalar(kv[2])
    } else throw new Error(`意外缩进 ${indent}：${line}`)
  }
  return doc
}

function scalar(text) {
  const v = text.trim()
  if (v === '') return ''
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null' || v === '~') return null
  if (/^-?\d+$/.test(v)) return Number(v)
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) return v.slice(1, -1)
  return v
}

// ── 1. package.json 关键字段 ─────────────────────────────────────────
const manifestPath = join(root, 'package.json')
const pkg = readJson(manifestPath)
ok('name/private/type', () => {
  assert.equal(pkg.name, '@local/dsh-manage-api')
  assert.equal(pkg.private, true)
  assert.equal(pkg.type, 'module')
  assert.equal(typeof pkg.version, 'string')
})
ok('零第三方运行依赖', () => {
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
})
ok('dsh.bundle.patch 指向包内文件', () => {
  const p = pkg?.dsh?.bundle?.patch
  assert.equal(typeof p, 'string')
  assert.ok(!isAbsolute(p) && !p.startsWith('..'), '不得越出包根')
  const resolved = resolve(root, p)
  assert.ok(relative(root, resolved).startsWith('..') === false)
  assert.ok(existsSync(resolved), `缺少 ${resolved}`)
})
ok('dsh.client 形状', () => {
  const c = pkg?.dsh?.client
  assert.equal(typeof c, 'object')
  assert.equal(c.platform, 'web')
  assert.equal(c.immediately, true)
  assert.ok(Array.isArray(c.inject))
  assert.equal(c.inject.length, 0)
  assert.ok(c.inject.every((x) => typeof x === 'string'))
})
ok('exports["./client"] 声明', () => {
  assert.equal(typeof pkg.exports, 'object')
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
})
ok('files 是字符串数组且覆盖关键产物', () => {
  assert.ok(Array.isArray(pkg.files))
  assert.ok(pkg.files.every((x) => typeof x === 'string'))
  for (const f of ['index.js', 'client.js', 'cordis.patch.yml', 'lib']) {
    assert.ok(pkg.files.includes(f), `files 缺 ${f}`)
  }
})

// ── 2. 包级 patch：YAML 可解析、id 唯一、指向 Host 入口 ────────────────
const patchPath = resolve(root, pkg.dsh.bundle.patch)
const patchText = readFileSync(patchPath, 'utf8')
const realYaml = loadRealYaml()
let doc
ok(`包级 patch YAML 可解析（${realYaml ? realYaml.name : '内置严格子集解析器'}）`, () => {
  doc = realYaml ? realYaml.load(patchText) : parseBundlePatchFallback(patchText)
  assert.ok(Array.isArray(doc) && doc.length > 0, '顶层必须是 patch 指令序列')
  assert.deepEqual(parseBundlePatchFallback(patchText), doc, '严格子集解析结果须与真实 YAML 一致')
})
const rows = doc.flatMap((entry) => (entry && Array.isArray(entry.insert) ? entry.insert : []))
ok('每条 insert row 有唯一非空 id / name', () => {
  assert.ok(rows.length > 0, '没有 insert row')
  const ids = rows.map((r) => r?.id)
  assert.ok(ids.every((id) => typeof id === 'string' && id.trim() !== ''))
  assert.equal(new Set(ids).size, ids.length, 'id 重复')
})
ok('row 指向 Host 入口且入口文件存在', () => {
  for (const row of rows) {
    assert.equal(row.name, pkg.name)
    assert.equal(pkg.exports['.'], './index.js')
    assert.ok(existsSync(resolve(root, pkg.exports['.'])), 'index.js 缺失')
  }
})
ok('config 是整块（键集合与 runtime 默认值一致）', () => {
  for (const row of rows) {
    assert.equal(typeof row.config, 'object')
    assert.ok(row.config !== null && !Array.isArray(row.config))
    assert.equal(row.config.autoStart, false, '默认不得自动启动')
    assert.equal(row.config.attachExisting, false, '默认不得主动连接外部 daemon')
    assert.equal(row.config.port, 4319)
    assert.equal(row.config.apiKey, '', 'apiKey 默认必须为空，由 profile 覆盖或环境变量提供')
  }
})

// ── 3. Host 入口导出 / runtime 定位（纯函数，零副作用）─────────────────
const host = await import(pathToFileURL(join(root, 'index.js')).href)
const runtime = await import(pathToFileURL(join(root, 'lib', 'runtime.js')).href)
const daemon = await import(pathToFileURL(join(root, 'lib', 'daemon.js')).href)
ok('Host 入口导出 apply / createHostLifecycle / HOST_KEY', () => {
  assert.equal(typeof host.apply, 'function')
  assert.equal(typeof host.createHostLifecycle, 'function')
  assert.equal(typeof host.HOST_KEY, 'symbol')
})
ok('./client 声明与 runtime.CLIENT_ENTRY 一致且留在包内', () => {
  assert.equal(runtime.CLIENT_ENTRY, pkg.exports['./client'])
  const target = resolve(root, pkg.exports['./client'])
  assert.equal(relative(root, target).startsWith('..'), false)
  console.log(`    note: ${pkg.exports['./client']} 由 E 棒产出，本棒只冻结声明；当前存在=${existsSync(target)}`)
})
ok('config 整块替换：patch 键集合 == DEFAULT_CONFIG 键集合', () => {
  const expected = Object.keys(runtime.DEFAULT_CONFIG).sort()
  for (const row of rows) assert.deepEqual(Object.keys(row.config).sort(), expected)
})
ok('N21：dsh.plugin.json 声明 entry.inject=["llm"] 且在 files 里', () => {
  const meta = readJson(join(root, 'dsh.plugin.json'))
  assert.deepEqual(meta.entry.inject, ['llm'])
  assert.equal(typeof meta.entry.name, 'string')
  assert.ok(pkg.files.includes('dsh.plugin.json'))
})
ok('runtime 默认不展开真实数据目录', () => {
  const snapshot = runtime.buildRuntime({})
  assert.equal(snapshot.config.autoStart, false)
  assert.equal(snapshot.config.attachExisting, false)
  assert.equal(snapshot.dataDir, null)
  assert.equal(snapshot.runtimeDir, resolve(root, '..'))
  assert.ok(existsSync(snapshot.daemonEntry))
})

// ── 4. daemon ownership：attach/owned 判定与默认零动作（不发请求、不 spawn）──
ok('ownershipOf / isAttached / isOwned 判定', () => {
  assert.equal(daemon.ownershipOf({ mode: 'attached' }), 'attached')
  assert.equal(daemon.ownershipOf('attached'), 'attached')
  assert.equal(daemon.ownershipOf({ mode: 'owned' }), 'owned')
  assert.equal(daemon.ownershipOf({ mode: 'starting' }), 'owned')
  assert.equal(daemon.ownershipOf({ mode: 'down' }), 'none')
  assert.equal(daemon.isAttached({ mode: 'attached' }), true)
  assert.equal(daemon.isOwned({ mode: 'owned' }), true)
})
{
  const m = daemon.createDaemonManager({ port: 1 })
  assert.equal(m.snapshot().mode, 'down')
  assert.equal(m.snapshot().ownership, 'none')
  assert.equal(m.snapshot().pid, null)
  assert.equal((await m.attach()).mode, 'down', 'attachExisting=false 不得连任何端口')
  assert.equal((await m.startOwned()).mode, 'failed', 'autoStart=false 不得 spawn')
  assert.equal(m.snapshot().pid, null)
  assert.equal((await m.dispose()).mode, 'down')
  passed.push('默认 manager：down / none / 无 pid；attach 与 startOwned 均被守卫拒绝')
}
{
  // 用 mock fetch 替换全局，绝不产生真实网络请求；port=1 不是 4319。
  const originalFetch = globalThis.fetch
  const logs = []
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, at: 0 }) })
  try {
    const m = daemon.createDaemonManager({ port: 1, attachExisting: true, log: (s) => logs.push(String(s)) })
    const attached = await m.attach()
    assert.equal(attached.mode, 'attached')
    assert.equal(attached.ownership, 'attached')
    assert.equal(attached.pid, null)
    await m.stop()
    assert.equal(m.snapshot().mode, 'attached', 'stop() 不得动 attached 的外部 daemon')
    await m.dispose()
    assert.equal(m.snapshot().mode, 'down')
    assert.ok(logs.some((l) => l.includes('绝不停止')), 'dispose 必须走 attached 分支')
    passed.push('attached：stop()/dispose() 均不触碰外部 daemon（mock fetch，零网络）')
  } finally {
    globalThis.fetch = originalFetch
  }
}
{
  // owned 分支真断言：注入 fake spawn + fake probe；绝不调用真实 child_process.spawn/fetch。
  const listeners = new Map()
  const fakeChild = {
    pid: -1,
    stdin: { end() {} },
    signs: [],
    once(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return this
    },
    emit(event) { for (const fn of listeners.get(event) ?? []) fn(0, null) },
    kill(signal) {
      this.signs.push(signal)
      queueMicrotask(() => fakeChild.emit('exit'))
      return true
    },
  }
  const spawnCalls = []
  const m = daemon.createDaemonManager({
    port: 1,
    autoStart: true,
    runtimeDir: '/tmp',
    daemonEntry: '/tmp/daemon/index.js',
    dataDir: '/tmp/isolated-b-self-test',
    waitMs: 1000,
    probeImpl: async () => ({ ok: true, body: { ok: true } }),
    spawnImpl: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, env: opts.env })
      return fakeChild
    },
  })
  const owned = await m.startOwned()
  assert.equal(owned.mode, 'owned')
  assert.equal(owned.ownership, 'owned')
  assert.equal(owned.pid, -1)
  assert.equal(spawnCalls.length, 1)
  assert.equal(spawnCalls[0].env.MANAGE_API_HOME, '/tmp/isolated-b-self-test', 'owned 必须用隔离数据目录')
  await m.dispose()
  assert.equal(m.snapshot().mode, 'down')
  assert.deepEqual(fakeChild.signs, ['SIGTERM'], 'owned dispose 必须 kill 自己 spawn 的 child')
  passed.push('owned：注入 fake spawn/probe 验证 spawn→owned→dispose kill（零真实进程/零网络）')
}
{
  const m = daemon.createDaemonManager({ port: 1, autoStart: true, runtimeDir: '/tmp', daemonEntry: '/tmp/daemon/index.js', dataDir: '/tmp/isolated-b-self-test' })
  assert.equal((await m.stop()).mode, 'down')
  assert.equal((await m.dispose()).mode, 'down')
  passed.push('未 startOwned 时 stop()/dispose() 不 kill 任何 child')
}
{
  // 模拟 Cordis ctx：验证 apply 注册 effect 且 cleanup 幂等、不抛错、不启动进程。
  const cleanups = []
  const ctx = {
    effect(fn) { const c = fn(); cleanups.push(c); return c },
    get() { return undefined },
    logger() { return null },
  }
  host.apply(ctx, {})
  assert.equal(cleanups.length, 1)
  assert.equal(typeof cleanups[0], 'function')
  assert.equal(host.createHostLifecycle(ctx, {}).daemon.snapshot().ownership, 'none')
  cleanups[0]()
  cleanups[0]()
  passed.push('apply(ctx, config)：一个 effect、返回 cleanup、幂等且零进程')
}

console.log(`check-manifest: ${passed.length} 组断言通过`)
for (const label of passed) console.log(`  ok  ${label}`)
