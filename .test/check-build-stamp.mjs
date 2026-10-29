/**
 * 构建戳自检：入口 HTML 里的 /app.js、/style.css 必须带上 `?v=<戳>`。
 *
 * 回归的是「合并完改动凭空消失」这类现象：面板是纯 SPA，`web/index.html` 只有一句
 * `<script type="module" src="/app.js">`，页面开着时只有一个 setInterval 刷
 * `/api/state` 的数据，从不重取代码。没有版本号时，昨天开的标签页会一直跑旧模块图
 * —— 余额、请求日志都在动（数据是新的），界面却停在上一个版本。
 *
 * 断言口径：
 *   1. 戳只由 js/css 的「路径 + mtime + 大小」决定：同一套文件两次算出来一样，
 *      改文件（大小/时间变）就一定变；md/json/html 不参与
 *   2. listAssets 递归、排序、跳过隐藏目录与 node_modules
 *   3. injectBuildStamp 只给本地 js/css 挂戳：外链、已经带 ?v= 的、图片都不动；
 *      meta 只写一条（重复注入不叠加）
 *   4. 1 秒缓存：同目录连续调用不重新 stat，改文件后（缓存过期）能拿到新戳
 *   5. 端到端：起一个临时 daemon，GET / 返回的 HTML 里写着戳、响应头有 X-Build，
 *      并且带戳的 /app.js?v=戳 真能取到 200 + 正文
 *
 * 用法：node .test/check-build-stamp.mjs
 */
import { createServer } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
const ok = (cond, msg, extra) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}${extra ? `  ← ${extra}` : ''}`)
  }
}

const { listAssets, computeBuildStamp, buildStamp, injectBuildStamp } = await import('../daemon/build-stamp.js')

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function killTree(pid) {
  if (!pid) return
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

async function waitFor(fn, { timeoutMs = 20000, stepMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
      last = value
    } catch (error) {
      last = error
    }
    await sleep(stepMs)
  }
  throw new Error(`等不到条件：${last instanceof Error ? last.message : String(last)}`)
}

const work = await mkdtemp(join(tmpdir(), 'mapi-buildstamp-'))

try {
  // ---------------------------------------------------------------- 1. 戳的来源
  console.log('[1] 戳只由 js/css 的内容指纹决定')
  const assets = join(work, 'web')
  await mkdir(join(assets, 'sub'), { recursive: true })
  await writeFile(join(assets, 'app.js'), 'console.log(1)\n')
  await writeFile(join(assets, 'style.css'), 'body{}\n')
  await writeFile(join(assets, 'README.md'), '不该参与\n')
  await writeFile(join(assets, 'db.json'), '{"a":1}\n')
  await writeFile(join(assets, 'index.html'), '<html></html>\n')
  const base = computeBuildStamp(assets)
  ok(/^[0-9a-f]{8}$/.test(base), '戳是 8 位十六进制', base)
  ok(computeBuildStamp(assets) === base, '同一套文件两次算出来一样')
  ok(listAssets(assets).join(',') === 'app.js,style.css', '只收 js/css，且排序', listAssets(assets).join(','))

  await writeFile(join(assets, 'README.md'), '改了也不该影响戳\n')
  await writeFile(join(assets, 'db.json'), '{"a":2}\n')
  await writeFile(join(assets, 'index.html'), '<html><body>x</body></html>\n')
  ok(computeBuildStamp(assets) === base, 'md/json/html 改动不影响戳')

  await writeFile(join(assets, 'style.css'), 'body{color:red}\n')
  const afterCss = computeBuildStamp(assets)
  ok(afterCss !== base, '改了 css，戳就变')

  await writeFile(join(assets, 'app.js'), 'console.log(2)\n')
  const afterJs = computeBuildStamp(assets)
  ok(afterJs !== afterCss, '改了 js，戳再变')

  // 只改 mtime、内容不变也要变：本仓常见「cherry-pick 之后文件内容一样但时间不同」
  const stampBeforeTouch = computeBuildStamp(assets)
  const future = new Date(Date.now() + 5000)
  await utimes(join(assets, 'app.js'), future, future)
  ok(computeBuildStamp(assets) !== stampBeforeTouch, '只动 mtime 也会换戳')

  // ---------------------------------------------------------------- 2. 递归与排除
  console.log('[2] 目录遍历：递归收子目录，跳过隐藏目录')
  await writeFile(join(assets, 'sub', 'view.js'), 'export {}\n')
  await mkdir(join(assets, '.cache'), { recursive: true })
  await writeFile(join(assets, '.cache', 'x.js'), 'noop\n')
  await mkdir(join(assets, 'node_modules'), { recursive: true })
  await writeFile(join(assets, 'node_modules', 'y.js'), 'noop\n')
  const list = listAssets(assets)
  ok(list.includes('sub/view.js'), '递归到子目录', list.join(','))
  ok(!list.some((f) => f.startsWith('.cache')), '跳过隐藏目录')
  ok(!list.some((f) => f.startsWith('node_modules')), '跳过 node_modules')
  const beforeSub = computeBuildStamp(assets)
  await writeFile(join(assets, '.cache', 'x.js'), 'noop2\n')
  ok(computeBuildStamp(assets) === beforeSub, '被排除的目录改动不影响戳')

  // ---------------------------------------------------------------- 3. 注入
  console.log('[3] 注入：只挂本地 js/css，外链与已带戳的不动')
  const html = [
    '<!doctype html><html><head>',
    '<link rel="stylesheet" href="/style.css" />',
    '<link rel="stylesheet" href="/protocol.css" />',
    '<link rel="stylesheet" href="https://cdn.example.com/x.css" />',
    '</head><body>',
    '<script type="module" src="/app.js"></script>',
    '<script src="/app.js?v=deadbeef"></script>',
    '<img src="/logo.png" />',
    '</body></html>',
  ].join('\n')
  const out = injectBuildStamp(html, 'abc12345')
  ok(out.includes('href="/style.css?v=abc12345"'), '本地 css 挂上戳')
  ok(out.includes('href="/protocol.css?v=abc12345"'), '多个本地 css 都挂上')
  ok(out.includes('src="/app.js?v=abc12345"'), '入口 js 挂上戳')
  ok(out.includes('href="https://cdn.example.com/x.css"'), '外链不动')
  ok(out.includes('src="/app.js?v=deadbeef"'), '已经带戳的不重复挂')
  ok(out.includes('<img src="/logo.png" />'), '非 js/css 资源不动')
  ok((out.match(/name="manageapi-build"/g) || []).length === 1, '只写一条 meta')
  ok(out.includes('content="abc12345"'), 'meta 里是当前戳')
  ok(injectBuildStamp(out, 'abc12345') === out, '重复注入是幂等的')
  ok(injectBuildStamp('<p>没有 head</p>', 'abc12345').includes('manageapi-build'), '没有 head 也能带 meta')
  ok(injectBuildStamp(html, '') === html, '戳为空时原样返回')

  // ---------------------------------------------------------------- 4. 缓存
  console.log('[4] 1 秒缓存：同一秒内不重新算，过期后拿到新戳')
  const cacheDir = join(work, 'cache-web')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, 'app.js'), 'v1\n')
  const t0 = 1_000_000
  const first = buildStamp(cacheDir, t0)
  await writeFile(join(cacheDir, 'app.js'), 'v2 内容更长一些\n')
  ok(buildStamp(cacheDir, t0 + 500) === first, '500ms 内命中缓存，戳不变')
  const fresh = buildStamp(cacheDir, t0 + 1500)
  ok(fresh !== first, '超过 1 秒后重新算，戳跟着文件变')

  // ---------------------------------------------------------------- 5. 端到端
  console.log('[5] 端到端：临时 daemon 的首页写着戳，带戳的资源取得到')
  const home = await mkdtemp(join(tmpdir(), 'mapi-buildstamp-home-'))
  const port = await freePort()
  const child = spawn(process.execPath, ['daemon/index.js', '--port', String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      MANAGE_API_HOME: home,
      MANAGE_API_BACKUP_DIR: join(home, 'backups'),
      MANAGE_API_NO_SCHEDULE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  try {
    const page = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      if (!res.ok) return false
      return { res, body: await res.text() }
    })
    const header = page.res.headers.get('x-build') || ''
    ok(/^[0-9a-f]{8}$/.test(header), '响应头带 X-Build', header)
    const meta = (page.body.match(/name="manageapi-build" content="([0-9a-f]{8})"/) || [])[1] || ''
    ok(meta === header, 'HTML 里的 meta 与 X-Build 一致', `${meta} vs ${header}`)
    ok(page.body.includes(`src="/app.js?v=${header}"`), '入口 script 带戳')
    ok(page.body.includes(`href="/style.css?v=${header}"`), '样式表带戳')
    const asset = await fetch(`http://127.0.0.1:${port}/app.js?v=${header}`)
    const body = await asset.text()
    ok(asset.ok, '带戳的 /app.js 能取到', `HTTP ${asset.status}`)
    ok(body.includes(`/app.js?v=${header}`) === false && body.length > 1000, '拿到的确实是应用代码', `${body.length} 字节`)
    const css = await fetch(`http://127.0.0.1:${port}/style.css?v=${header}`)
    ok(css.ok && (await css.text()).length > 100, '带戳的 /style.css 能取到')
  } finally {
    killTree(child.pid)
    await rm(home, { recursive: true, force: true })
  }

  // 真实 web/ 目录也要能算出戳（防「忘了改扩展名 / 目录结构变了」这类静默退化）
  const realStamp = computeBuildStamp(join(ROOT, 'web'))
  ok(/^[0-9a-f]{8}$/.test(realStamp), '仓库自带的 web/ 能算出戳', realStamp)
} finally {
  await rm(work, { recursive: true, force: true })
}

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
