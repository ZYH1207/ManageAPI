/**
 * CNY 退场自检：单位体系只剩 站内 USD / 真实美元 RUSD（R.Dollar）。
 *
 * 这个决定最早做在「令牌持久化」分支（f2e03f5），本分支（冷却）后来补齐同一口径。
 * 钉死三件事：
 *   1. 迁移：displayCurrency CNY→USD、offer.currency CNY→USD（计费 1:1，纯改名，
 *      价格数字不变）；放在版本检查之前，对已最新版本的库也生效（幂等自愈）；
 *   2. 服务端拒绝把 displayCurrency 设回 CNY（400）；
 *   3. 老客户端写回 CNY 的 offer.currency，下次读取自愈成 USD。
 *
 * 用法：node .test/check-cny-retire.mjs
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
function ok(cond, message) {
  if (cond) console.log(`  ✓ ${message}`)
  else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

const home = await mkdtemp(join(tmpdir(), 'mapi-cny-'))
process.env.MANAGE_API_HOME = home
const store = await import(pathToFileURL(join(ROOT, 'core/store.js')).href)

try {
  // 造一个「带 CNY 老数据」的库：直接写 db.json（绕过写入层，模拟老客户端/老版本）
  const dbPath = join(home, 'db.json')
  await mkdir(home, { recursive: true })
  await writeFile(
    dbPath,
    JSON.stringify({
      version: store.DB_VERSION ?? 99,
      settings: { displayCurrency: 'CNY' },
      providers: [{ id: 'p1', name: '甲站', baseUrl: 'http://127.0.0.1:5199/v1' }],
      offers: [
        { id: 'o1', providerId: 'p1', upstreamName: 'm-a', currency: 'CNY', inPrice: 2, outPrice: 8 },
        { id: 'o2', providerId: 'p1', upstreamName: 'm-b', currency: 'cny', inPrice: 1, outPrice: 2 },
        { id: 'o3', providerId: 'p1', upstreamName: 'm-c', currency: 'RUSD', inPrice: 0.3, outPrice: 1.2 },
      ],
      credentials: [],
    }),
  )

  const db = await store.readDb()
  ok(db.settings.displayCurrency === 'USD', `displayCurrency CNY→USD（得到 ${db.settings.displayCurrency}）`)
  ok(db.offers.find((o) => o.id === 'o1').currency === 'USD', 'offer.currency CNY→USD')
  ok(db.offers.find((o) => o.id === 'o2').currency === 'USD', '小写 cny 也归一成 USD')
  ok(db.offers.find((o) => o.id === 'o3').currency === 'RUSD', 'RUSD 不动')
  ok(db.offers.find((o) => o.id === 'o1').inPrice === 2 && db.offers.find((o) => o.id === 'o1').outPrice === 8, '价格数字不被迁移改动（1:1 纯改名）')

  // 幂等：再读一遍还是 USD，不会翻回去
  const again = await store.readDb()
  ok(again.settings.displayCurrency === 'USD' && again.offers.every((o) => o.currency !== 'CNY'), '重复读取幂等')

  // 老客户端写回 CNY → 下次读取自愈
  const raw = JSON.parse(await (await import('node:fs/promises')).readFile(dbPath, 'utf-8'))
  raw.offers[0].currency = 'CNY'
  await writeFile(dbPath, JSON.stringify(raw))
  const healed = await store.readDb()
  ok(healed.offers.find((o) => o.id === 'o1').currency === 'USD', '老客户端写回 CNY，下次读取自愈')

  // 服务端拒绝把显示单位设回 CNY
  const { spawn } = await import('node:child_process')
  const { createServer } = await import('node:net')
  const freePort = () =>
    new Promise((resolve) => {
      const srv = createServer()
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address()
        srv.close(() => resolve(port))
      })
    })
  const APP_PORT = await freePort()
  const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
    cwd: ROOT,
    env: { ...process.env, MANAGE_API_HOME: home },
    stdio: 'ignore',
  })
  try {
    let up = false
    for (let i = 0; i < 100 && !up; i += 1) {
      try {
        up = (await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)).ok
      } catch {}
      if (!up) await new Promise((r) => setTimeout(r, 150))
    }
    const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayCurrency: 'CNY' }),
    })
    ok(res.status === 400, `PATCH displayCurrency CNY → 400（得到 ${res.status}）`)
    const res2 = await fetch(`http://127.0.0.1:${APP_PORT}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayCurrency: 'RUSD' }),
    })
    ok(res2.ok, 'RUSD 仍然可设')
  } finally {
    app.kill()
    // Windows 上 kill 后立刻退出偶发 libuv 断言噪音（exit 127），缓冲一下
    await new Promise((r) => setTimeout(r, 500))
  }
} finally {
  await rm(home, { recursive: true, force: true }).catch(() => {})
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
