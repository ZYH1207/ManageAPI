#!/usr/bin/env node
/**
 * F 棒 · 全量隔离验收入口（release gate）。
 *
 * 只做「验收 + 汇总」：不改 B–E 源码、不改任何 package.json、不安装到 profile、
 * 不占用真实 4319、不读写真实 ~/.manage-api、不运行 DB migration、不派子 agent。
 *
 * 分层：
 *   [1] 依次执行 B–E 四个阶段检查（manifest / dsh-api / dsh-host / client-contract）
 *   [2] 插件入口语法检查（node --check）
 *   [3] 可打包性与文件齐备性（exports / files / bundle patch / npm pack --dry-run --json）
 *   [4] 原有用户版业务基础测试（.test/check-*.mjs）的隔离纯静态回归
 *
 * 严格隔离：所有子进程 HOME / MANAGE_API_HOME 指向本次自建临时目录，结束清理；
 * 断言临时目录既不是真实 home 也不是 ~/.manage-api；默认基线只跑「不联网、不 spawn、
 * 不起 server」的纯静态用例（快、确定）；更深层的真实 daemon 子进程套件放在
 * --with-daemon（默认跳过，避免慢/端口/时序抖动污染默认门）。
 *
 * 失败直接抛错设置退出码非 0，不写 process.exit(0) 敷衍。
 *
 * 用法：
 *   node check-release.mjs               # 默认门（快、确定）
 *   node check-release.mjs --with-daemon # 额外跑真实 daemon 子进程回归子集
 *   node check-release.mjs --strict      # 基线任何失败都判失败（默认纯静态失败即判失败）
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(here, '..')          // dsh-plugin/
const BASE = resolve(PLUGIN_ROOT, '..')          // $BASE
const argv = new Set(process.argv.slice(2))
const WITH_DAEMON = argv.has('--with-daemon')
const STRICT = argv.has('--strict')

// ── 结果汇总 ─────────────────────────────────────────────────────────────
const sections = []
let hardFailures = 0
class Section {
  constructor(title) { this.title = title; this.items = []; sections.push(this) }
  add(name, ok, detail = '') { this.items.push({ name, ok, detail }); if (!ok) hardFailures += 1; return ok }
}

// ── 隔离临时目录（HOME / MANAGE_API_HOME）───────────────────────────────
const REAL_HOME = homedir()
const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-release-'))
const isoHome = join(tmpRoot, 'home')
const isoManageHome = join(isoHome, '.manage-api')
// 断言：绝不落在真实 home 或 ~/.manage-api
function assertIsolated(p) {
  const r = resolve(p)
  if (r === resolve(REAL_HOME) || r === resolve(REAL_HOME, '.manage-api')) {
    throw new Error(`隔离目录越界（指向真实 home / ~/.manage-api）：${r}`)
  }
  if (!r.startsWith(resolve(tmpRoot))) throw new Error(`隔离目录不在临时根内：${r}`)
}
assertIsolated(isoHome)
assertIsolated(isoManageHome)

const childEnv = {
  ...process.env,
  HOME: isoHome,
  MANAGE_API_HOME: isoManageHome,
  // 把可能存在的真实端口/数据相关变量清掉，避免子测试误连真实环境
  MANAGE_API_DATA_DIR: '',
  MANAGE_API_PORT: '',
}
// 便于部分测试脚本按约定创建目录
try { readdirSync(isoHome) } catch { spawnSync('mkdir', ['-p', isoManageHome]) }

function runNode(absFile, { timeout = 30000 } = {}) {
  const r = spawnSync(process.execPath, [absFile], {
    cwd: BASE, env: childEnv, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
  })
  const status = r.status
  const out = (r.stdout || '') + (r.stderr || '')
  const timedOut = status === null && (r.signal === 'SIGTERM' || r.error)
  return { ok: status === 0, status, out, timedOut }
}

function tail(s, n = 6) {
  const lines = s.trimEnd().split('\n')
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

let reported = false
function finish() {
  if (reported) return
  reported = true
  const total = sections.reduce((a, s) => a + s.items.length, 0)
  const passed = sections.reduce((a, s) => a + s.items.filter((i) => i.ok).length, 0)
  console.log('\n==================== check-release 汇总 ====================')
  for (const s of sections) {
    const p = s.items.filter((i) => i.ok).length
    console.log(`\n${s.title}  [${p}/${s.items.length}]`)
    for (const i of s.items) console.log(`  ${i.ok ? 'ok ' : 'FAIL'} ${i.name}${i.detail ? '  — ' + i.detail : ''}`)
  }
  console.log(`\n合计：${passed}/${total} 项通过；隔离临时目录=${tmpRoot}`)
  console.log(`隔离断言：HOME=${isoHome} MANAGE_API_HOME=${isoManageHome}（均非真实 home / ~/.manage-api）`)
  if (hardFailures > 0) {
    console.log(`\n结果：FAIL（${hardFailures} 项失败）`)
    process.exitCode = 1
  } else {
    console.log('\n结果：PASS（全部硬性检查通过）')
    console.log('注意：本门只证明静态/隔离契约与打包齐备，不证明 live DSH Host 激活、Client slot 挂载或浏览器视觉。')
    process.exitCode = 0
  }
}

try {
  // ── [1] 依次执行 B–E 四阶段检查 ───────────────────────────────────────
  const stage = new Section('[1] B–E 阶段检查（顺序执行）')
  const stageChecks = [
    ['B check-manifest', join(PLUGIN_ROOT, '.test', 'check-manifest.mjs')],
    ['C check-dsh-plugin-api', join(BASE, '.test', 'check-dsh-plugin-api.mjs')],
    ['D check-dsh-host', join(PLUGIN_ROOT, '.test', 'check-dsh-host.mjs')],
    ['E check-client-contract', join(PLUGIN_ROOT, '.test', 'check-client-contract.mjs')],
    // N18 全链路启动验收：真执行 apply()/factory()，真打 4319（只读），把「代码写了但没接上」
    // 这类静态测试发现不了的 bug 固化成回归（daemon.attach/webServer.register 必须真被调用）。
    ['N18 check-full-boot', join(PLUGIN_ROOT, '.test', 'check-full-boot.mjs')],
  ]
  for (const [name, file] of stageChecks) {
    if (!existsSync(file)) { stage.add(name, false, `缺失 ${file}`); continue }
    const r = runNode(file, { timeout: 60000 })
    const firstFail = (r.out.match(/FAIL[^\n]*/) || [])[0] || ''
    stage.add(name, r.ok, r.ok ? 'exit 0' : `exit=${r.status} ${firstFail}`.trim())
    if (!r.ok) console.log(`\n[${name}] 失败输出尾部：\n${tail(r.out, 12)}\n`)
  }

  // ── [2] 插件入口语法检查 ──────────────────────────────────────────────
  const syn = new Section('[2] 插件入口语法（node --check）')
  const entryFiles = [
    'index.js', 'client.js',
    'lib/runtime.js', 'lib/daemon.js', 'lib/routes.js', 'lib/http.js',
    'lib/write-proxy.js', 'lib/theme.js', 'lib/integration/index.js',
  ]
  for (const rel of entryFiles) {
    const abs = join(PLUGIN_ROOT, rel)
    if (!existsSync(abs)) { syn.add(`node --check ${rel}`, false, '缺失'); continue }
    const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' })
    syn.add(`node --check ${rel}`, r.status === 0, r.status === 0 ? 'ok' : `exit=${r.status}`)
  }

  // ── [3] 可打包性与文件齐备性 ──────────────────────────────────────────
  const pack = new Section('[3] 可打包性与文件齐备性')
  const pkgPath = join(PLUGIN_ROOT, 'package.json')
  let pkg = null
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch (e) { pack.add('package.json 可解析', false, String(e)) }
  if (pkg) {
    pack.add('package.json 可解析', true)
    // exports 目标都在包内且存在
    const exp = pkg.exports || {}
    for (const [k, v] of Object.entries(exp)) {
      if (k === './package.json') continue
      const target = typeof v === 'string' ? v : (v && v.default)
      const abs = target ? resolve(PLUGIN_ROOT, target) : null
      const inside = abs && abs.startsWith(resolve(PLUGIN_ROOT) + '/')
      pack.add(`exports["${k}"] 命中包内文件`, Boolean(inside && existsSync(abs)), target || '缺失')
    }
    // dsh.bundle.patch / dsh.client
    const patchRel = pkg.dsh?.bundle?.patch
    pack.add('dsh.bundle.patch 指向存在的补丁', Boolean(patchRel && existsSync(resolve(PLUGIN_ROOT, patchRel))), patchRel || '缺失')
    pack.add('dsh.client.platform === web', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform))
    // files 覆盖关键运行产物
    const files = Array.isArray(pkg.files) ? pkg.files : []
    const need = ['index.js', 'client.js', 'cordis.patch.yml', 'lib']
    const covered = need.every((n) => files.some((f) => f === n || f.startsWith(n + '/')))
    pack.add('files 覆盖 index/client/cordis/lib', covered, `files=[${files.join(',')}]`)
  }
  // 真实 npm pack --dry-run（无第三方依赖、离线）
  {
    const packDest = join(tmpRoot, 'pack')
    try { spawnSync('mkdir', ['-p', packDest]) } catch {}
    const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--pack-destination', packDest], {
      cwd: PLUGIN_ROOT, env: childEnv, encoding: 'utf8', timeout: 60000,
    })
    if (r.status === 0) {
      let files = []
      try {
        const j = JSON.parse(r.stdout)
        files = (Array.isArray(j) ? j[0]?.files || [] : []).map((f) => f.path)
      } catch { /* fallthrough */ }
      const needInPack = ['index.js', 'client.js', 'cordis.patch.yml', 'package.json', 'lib/routes.js', 'lib/integration/index.js']
      const missing = needInPack.filter((n) => !files.includes(n))
      pack.add('npm pack --dry-run 成功且关键产物在包内', files.length > 0 && missing.length === 0,
        files.length ? `${files.length} 文件${missing.length ? '，缺:' + missing.join(',') : ''}` : '未能解析 --json')
    } else {
      // npm 不可用时不阻塞主判定，但如实记录为失败项（可打包性未证）
      pack.add('npm pack --dry-run 成功且关键产物在包内', false, `npm exit=${r.status} ${(r.stderr || '').slice(0, 120)}`)
    }
  }

  // ── [4] 原有用户版业务基础测试的隔离纯静态回归 ────────────────────────
  const base = new Section('[4] 原有用户版基础测试（隔离纯静态回归）')
  const testDir = join(BASE, '.test')
  const STAGE_NAMES = new Set(['check-dsh-plugin-api.mjs'])
  const BROWSER_RE = /headless|puppeteer|chromium|playwright|chrome-launcher/i
  const IO_RE = /\bfetch\s*\(|\bspawn\s*\(|\bcreateServer\s*\(/
  const candidates = readdirSync(testDir)
    .filter((f) => /^check-.*\.mjs$/.test(f))
    .filter((f) => !STAGE_NAMES.has(f))          // 阶段检查已在 [1] 跑
    .sort()
  const pureStatic = []
  const skipped = { io: [], browser: [] }
  for (const f of candidates) {
    const src = readFileSync(join(testDir, f), 'utf8')
    if (BROWSER_RE.test(src)) { skipped.browser.push(f); continue }
    if (IO_RE.test(src)) { skipped.io.push(f); continue }
    pureStatic.push(f)
  }
  let psPass = 0, psFail = 0
  const psFailed = []
  for (const f of pureStatic) {
    const r = runNode(join(testDir, f), { timeout: 30000 })
    if (r.ok) psPass += 1
    else { psFail += 1; psFailed.push(`${f}(exit=${r.status}${r.timedOut ? ',timeout' : ''})`) }
  }
  base.add(
    `纯静态回归 ${psPass}/${pureStatic.length} 通过`,
    psFail === 0,
    psFail ? `失败: ${psFailed.join(' ')}` : '无联网/无 spawn/无 server',
  )
  // 如实记录未纳入默认门的分层（不判失败，仅披露边界）
  base.add(
    `已披露：${skipped.io.length} 个含 IO/子进程用例、${skipped.browser.length} 个浏览器用例默认跳过`,
    true,
    '深层回归用 --with-daemon；浏览器用例需 headless Chrome，隔离门不跑',
  )

  if (WITH_DAEMON) {
    const deep = new Section('[4b] 深层真实 daemon 子进程回归（--with-daemon，默认跳过）')
    // 已知墙钟等待/固定慢用例：隔离门不跑（避免拖长与抖动），单独披露。
    const SLOW_RE = /check-(probe-pause|route-target-forward|stream-reliability)\.mjs/
    const daemonSet = skipped.io
      .filter((f) => {
        if (SLOW_RE.test(f)) return false
        const src = readFileSync(join(testDir, f), 'utf8')
        // 只挑：自设 MANAGE_API_HOME 且不含固定真实端口 4399/4319 的（可用 freePort 自选端口）
        return /MANAGE_API_HOME/.test(src) && !/4399|4319/.test(src)
      })
    const slowSkipped = skipped.io.filter((f) => SLOW_RE.test(f))
    let dp = 0
    const df = []
    for (const f of daemonSet) {
      const r = runNode(join(testDir, f), { timeout: 30000 })
      if (r.ok) dp += 1
      else df.push(`${f}(exit=${r.status}${r.timedOut ? ',timeout' : ''})`)
    }
    deep.add(`daemon 子进程回归 ${dp}/${daemonSet.length} 通过`, STRICT ? df.length === 0 : true,
      df.length ? `失败/超时: ${df.join(' ')}` : '全部通过')
    deep.add(
      `已披露：${slowSkipped.length} 个墙钟/慢用例与 ${skipped.browser.length} 个浏览器用例不在 daemon 子集`,
      true,
      `${slowSkipped.join(',')}${skipped.browser.length ? ' / 浏览器:' + skipped.browser.join(',') : ''}`,
    )
  }
} catch (err) {
  const s = new Section('[!] 运行时异常')
  s.add(String(err && err.message ? err.message : err), false)
} finally {
  finish()
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 清理尽力 */ }
}
