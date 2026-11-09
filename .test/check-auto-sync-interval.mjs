/**
 * 自动同步（监控采集）间隔可设置：默认 10 分钟、老库迁移、接口校验、调度真的按它跑。
 *
 * 需求（2026-11-09）：把网站自动同步时间改成可设置的，默认 10 分钟一次。
 *
 * 验四件事：
 *   1. 默认值：空库 / 缺字段的库读出来都是 10
 *   2. 迁移：老库恰好等于旧默认 30 且用户没动过 → 跟着升到 10；
 *            用户亲手设过（touched）或者填的是别的值 → 原样保留，不许悄悄改
 *   3. 接口：PATCH 能改、改完落盘、越界被拒（负数 / 超过一天）
 *   4. 调度：真起 daemon（tick 压到 100ms），把间隔设成 1 分钟——
 *            刚采过就不采、过了 1 分钟就采，看上游到底收到几次余额请求
 *
 * 用法：node .test/check-auto-sync-interval.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
const ok = (cond, msg, extra = '') => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}${extra ? `  ← ${extra}` : ''}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ============================================================ [1] 常量与默认值

console.log('[1] 默认 10 分钟')
{
  const store = await import('../core/store.js')
  ok(store.MONITOR_INTERVAL_DEFAULT === 10, `默认常量是 10（${store.MONITOR_INTERVAL_DEFAULT}）`)
  ok(store.MONITOR_INTERVAL_LEGACY_DEFAULT === 30, '旧默认记成 30（迁移判定要用）')
  ok(store.emptyDb().settings.monitorIntervalMinutes === 10, '空库默认 10')
}

// ============================================================ [2] 老库迁移

console.log('[2] 老库迁移只动「没被人碰过且等于旧默认」的')
{
  const store = await import('../core/store.js')
  const dir = await mkdtemp(join(tmpdir(), 'mapi-asi-'))
  const prevHome = process.env.MANAGE_API_HOME
  const base = () => ({
    version: store.DB_VERSION,
    settings: { monitorIntervalMinutes: 30 },
    providers: [],
    credentials: [],
    offers: [],
    probes: [],
  })
  const readBack = async (db) => {
    await writeFile(join(dir, 'db.json'), JSON.stringify(db), 'utf8')
    return store.readDb()
  }

  try {
    process.env.MANAGE_API_HOME = dir

    const migrated = await readBack(base())
    ok(migrated.settings.monitorIntervalMinutes === 10, `旧默认 30 → 10（${migrated.settings.monitorIntervalMinutes}）`)

    const touched = await readBack({ ...base(), settings: { monitorIntervalMinutes: 30, monitorIntervalTouched: true } })
    ok(touched.settings.monitorIntervalMinutes === 30, '用户亲手设过的 30 原样保留')

    const custom = await readBack({ ...base(), settings: { monitorIntervalMinutes: 60 } })
    ok(custom.settings.monitorIntervalMinutes === 60, '自定义值（60）不被覆盖')

    const off = await readBack({ ...base(), settings: { monitorIntervalMinutes: 0 } })
    ok(off.settings.monitorIntervalMinutes === 0, '关闭（0）不被"修正"成 10')

    const missing = await readBack({ ...base(), settings: {} })
    ok(missing.settings.monitorIntervalMinutes === 10, '缺字段的老库补成 10')

    // 幂等：迁移过一遍的库再读一遍还是 10，不会在 30/10 之间来回跳
    const again = await readBack(migrated)
    ok(again.settings.monitorIntervalMinutes === 10, '重复读取仍然稳定在 10')

    // 迁移不能顺手把用户的可见配置改坏：其它设置原样
    ok(again.settings.balanceWarnUsd !== undefined, '其它设置没被迁移弄丢')
  } finally {
    if (prevHome === undefined) delete process.env.MANAGE_API_HOME
    else process.env.MANAGE_API_HOME = prevHome
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ============================================================ [3][4] 真跑 daemon

const HOME = await mkdtemp(join(tmpdir(), 'mapi-asi-run-'))
const APP_PORT = 4417
const UP_PORT = 5133
let balanceHits = 0

const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/api/user/self') {
    balanceHits += 1
    return send(200, { data: { quota: 250000 } })
  }
  if (url.pathname === '/v1/models') return send(200, { data: [{ id: 'test-model-a' }] })
  return send(404, { error: 'not found' })
})
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))

const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  cwd: ROOT,
  env: {
    ...process.env,
    MANAGE_API_HOME: HOME,
    // 调度器平时 60 秒一跳；压到 100ms 才验得出「到点采 / 没到点不采」
    MANAGE_API_PROBE_TICK_MS: '100',
    MANAGE_API_PROBE_FIRST_DELAY_MS: '0',
  },
  stdio: 'ignore',
})
const base = `http://127.0.0.1:${APP_PORT}`

async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }
  throw new Error('服务没起来')
}

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`)
  return data
}

/** 直接改库里的 lastRunAt，把「上次采集」摆到指定时间点（tick 会重读库） */
async function setLastRun(msAgo) {
  const file = join(HOME, 'db.json')
  const db = JSON.parse(await readFile(file, 'utf8'))
  db.monitor = db.monitor || {}
  db.monitor.lastRunAt = new Date(Date.now() - msAgo).toISOString()
  await writeFile(file, JSON.stringify(db), 'utf8')
}

try {
  await waitReady()

  console.log('\n[3] 接口：能改、落盘、越界被拒')
  {
    const created = await call('POST', '/api/providers', {
      name: '自同步站',
      baseUrl: `http://127.0.0.1:${UP_PORT}/v1`,
    })
    const providerId = created.providers[0].id
    await call('POST', '/api/credentials', { providerId, label: '默认', secret: 'sk-asi-1234' })

    const initial = await call('GET', '/api/state')
    ok(initial.settings.monitorIntervalMinutes === 10, `新库默认就是 10（${initial.settings.monitorIntervalMinutes}）`)

    const patched = await call('PATCH', '/api/settings', { monitorIntervalMinutes: 7 })
    ok(patched.settings.monitorIntervalMinutes === 7, 'PATCH 改成 7 生效')
    ok(patched.settings.monitorIntervalTouched === true, '标记成「用户设过」，迁移以后不许再改它')

    const monitor = await call('GET', '/api/monitor?days=3')
    ok(monitor.settings.monitorIntervalMinutes === 7, '监控接口回报的也是 7（面板显示的口径）')

    const onDisk = JSON.parse(await readFile(join(HOME, 'db.json'), 'utf8'))
    ok(onDisk.settings.monitorIntervalMinutes === 7, '真的落盘了，不是只在内存里')

    let negativeRejected = false
    try {
      await call('PATCH', '/api/settings', { monitorIntervalMinutes: -1 })
    } catch {
      negativeRejected = true
    }
    ok(negativeRejected, '负数被 400 拒掉')

    let tooBigRejected = false
    try {
      await call('PATCH', '/api/settings', { monitorIntervalMinutes: 1441 })
    } catch {
      tooBigRejected = true
    }
    ok(tooBigRejected, '超过一天（1441 分钟）被 400 拒掉')

    const off = await call('PATCH', '/api/settings', { monitorIntervalMinutes: 0 })
    ok(off.settings.monitorIntervalMinutes === 0, '0 = 关闭，服务端接受')
  }

  console.log('\n[4] 调度：间隔没到不采，到了就采')
  {
    await call('PATCH', '/api/settings', { monitorIntervalMinutes: 1 })
    // 刚采过：哪怕 tick 跑了 20 多次（≈2 秒），也不该碰余额接口
    await setLastRun(5 * 1000)
    const before = balanceHits
    await sleep(2000)
    ok(balanceHits === before, `未到期时一次都不采（上游收到 ${balanceHits - before} 次）`)

    // 上次采集摆到 90 秒前：1 分钟的间隔已经到期，下一跳就该采
    await setLastRun(90 * 1000)
    let collected = false
    for (let i = 0; i < 40; i += 1) {
      if (balanceHits > before) {
        collected = true
        break
      }
      await sleep(150)
    }
    ok(collected, `到期后确实去读了余额（上游累计 ${balanceHits - before} 次）`)

    // 采完立刻又回到「未到期」，不该连着刷
    const afterCollect = balanceHits
    await sleep(1500)
    ok(balanceHits === afterCollect, `采完回到冷却，没有连刷（多了 ${balanceHits - afterCollect} 次）`)

    // 关闭后彻底不采：把上次采集摆得很久远也没用
    await call('PATCH', '/api/settings', { monitorIntervalMinutes: 0 })
    await setLastRun(3600 * 1000)
    const beforeOff = balanceHits
    await sleep(1500)
    ok(balanceHits === beforeOff, `0 = 关闭时不再自动采（多了 ${balanceHits - beforeOff} 次）`)
  }
} catch (error) {
  console.log(`✗ 出错：${error.message}`)
  process.exitCode = 1
} finally {
  app.kill()
  upstream.close()
  await sleep(200)
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

console.log('')
if (failed > 0) {
  console.log(`✗ ${failed} 项失败`)
  process.exitCode = 1
} else {
  console.log('✓ 自动同步间隔全部通过')
}
