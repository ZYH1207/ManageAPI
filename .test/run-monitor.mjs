/**
 * 监控页后端冒烟测试：起一个假上游（同时提供 /api/status 公告与渠道倍率），
 * 采集两轮，验证「首轮静默、次轮出变动、公告去重、余额曲线有数据」。
 *
 * 用法：node .test/run-monitor.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = await mkdtemp(join(tmpdir(), 'mapi-monitor-'))
const APP_PORT = 4398
const UP_PORT = 5111

let groupRate = 0.5
let announcements = [{ id: 'a1', title: '首次公告', content: '正文一', created_at: '2026-10-01T00:00:00Z' }]

const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/api/status') return send(200, { announcements })
  if (url.pathname === '/api/v1/channels/available') {
    // 真实结构：data[] → channels → platforms[] → groups[] / supported_models[]
    return send(200, {
      data: [
        {
          name: 'mock-channel',
          platforms: [
            {
              platform: 'openai',
              groups: [{ name: 'default', rate_multiplier: groupRate }],
              supported_models: [
                { name: 'test-model-a', pricing: { input_price: 1e-6, output_price: 2e-6 } },
              ],
            },
          ],
        },
      ],
    })
  }
  if (url.pathname === '/api/user/self') return send(200, { data: { quota: 250000, used_quota: 1000 } })
  if (url.pathname === '/v1/models') return send(200, { data: [{ id: 'test-model-a' }] })
  return send(404, { error: 'not found' })
})
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))

const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  env: { ...process.env, MANAGE_API_HOME: HOME },
  stdio: 'ignore',
})
const base = `http://127.0.0.1:${APP_PORT}`

async function waitReady() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150))
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

const failures = []
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
    failures.push(name)
  }
}

try {
  await waitReady()

  // 一个站点：Key + 后台令牌（有令牌才会去取倍率）
  const created = await call('POST', '/api/providers', { name: '冒烟站', baseUrl: `http://127.0.0.1:${UP_PORT}/v1` })
  const providerId = created.providers[0].id
  await call('POST', '/api/credentials', { providerId, label: '默认', secret: 'sk-smoke-1234' })
  await call('PATCH', `/api/providers/${providerId}`, { adminToken: 'admin-smoke-token' })

  console.log('\n第一轮采集')
  const first = await call('POST', '/api/monitor/collect', {})
  check('采集返回结果', Array.isArray(first.results) && first.results.length === 1)
  check('首轮不报倍率变动', first.changes.length === 0, `changes=${first.changes.length}`)
  check('首轮收录公告', first.announcements.length === 1, `announcements=${first.announcements.length}`)
  check('记了余额点', first.balanceSeries.some((d) => d.total !== null))
  check('站点余额写回', first.balanceByProvider[0].balance === 0.5, `balance=${first.balanceByProvider[0].balance}`)

  console.log('\n第二轮：改倍率 + 加公告')
  groupRate = 0.8
  announcements = [
    { id: 'a1', title: '首次公告', content: '正文一', created_at: '2026-10-01T00:00:00Z' },
    { id: 'a2', title: '新公告', content: '正文二', created_at: '2026-10-02T00:00:00Z' },
  ]
  const second = await call('POST', '/api/monitor/collect', {})
  check('第二轮记下倍率变动', second.changes.length === 1, `changes=${second.changes.length}`)
  check('变动是从 0.5 到 0.8', second.changes[0]?.from === 0.5 && second.changes[0]?.to === 0.8)
  check('公告只新增 1 条', second.announcements.length === 2, `announcements=${second.announcements.length}`)
  check('KPI 统计 24h 变动', second.kpi.rateChanges24h === 1, `rateChanges24h=${second.kpi.rateChanges24h}`)

  console.log('\n告警与已读')
  check('余额低于阈值应告警', second.alerts.some((a) => a.code === 'balance_low'), JSON.stringify(second.alerts.map((a) => a.code)))
  check('有未读告警', second.kpi.unreadAlerts > 0)
  const read = await call('POST', '/api/monitor/alerts/read', {})
  check('全部标记已读', read.kpi.unreadAlerts === 0, `unread=${read.kpi.unreadAlerts}`)
  const annRead = await call('POST', '/api/monitor/announcements/read', {})
  check('公告也能标记已读', annRead.kpi.unreadAnnouncements === 0)

  console.log('\n天数参数与采集记录')
  const three = await call('GET', '/api/monitor?days=3')
  check('days=3 返回 3 个点', three.balanceSeries.length === 3, `len=${three.balanceSeries.length}`)
  check('采集记录有 2 轮', three.runs.length === 2, `runs=${three.runs.length}`)
  check('记录里没有失败', three.runs.every((r) => r.ok), JSON.stringify(three.runs))

  console.log('')
  if (failures.length > 0) {
    console.log(`✗ ${failures.length} 项失败：${failures.join('、')}`)
    process.exitCode = 1
  } else {
    console.log('✓ 监控页后端全部通过')
  }
} catch (error) {
  console.log(`✗ 出错：${error.message}`)
  process.exitCode = 1
} finally {
  app.kill()
  upstream.close()
  await new Promise((r) => setTimeout(r, 200))
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

// ---- 花费双口径（模型消费 / 实际消费）
console.log('\n断言：花费双口径')
{
  const { spendFactorOf, buildSpendSummary } = await import('../core/monitor.js')
  const settings = { fx: { rates: { CNY: 6.68 } } }
  // 系数按「这条供给的标价币种」算，不是站点余额币种
  check('不填单价时系数=1（两数相同）', spendFactorOf({}, 'USD', settings) === 1)
  check('USD 标价 + 单价 1 → 1/6.68', Math.abs(spendFactorOf({ unitPrice: 1 }, 'USD', settings) - 1 / 6.68) < 1e-9)
  check('CNY 标价 + 单价 1 → 1（本来就是元）', spendFactorOf({ unitPrice: 1 }, 'CNY', settings) === 1)
  check('USD 标价 + 单价填市场汇率 → 无折扣', Math.abs(spendFactorOf({ unitPrice: 6.68 }, 'USD', settings) - 1) < 1e-9)
  check('非法单价按未填处理', spendFactorOf({ unitPrice: 0 }, 'USD', settings) === 1)
  check('同站混标价：USD 折、CNY 不折',
    spendFactorOf({ unitPrice: 1 }, 'USD', settings) < 0.2 && spendFactorOf({ unitPrice: 1 }, 'CNY', settings) === 1)
  check('实际消费不会超过模型消费（1:1 站）', spendFactorOf({ unitPrice: 1 }, 'USD', settings) < 1)

  const d = (offset) => {
    const t = new Date()
    t.setDate(t.getDate() - offset)
    const pad = (n) => String(n).padStart(2, '0')
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
  }
  const map = new Map([
    [d(0), { estimated: 2, actual: 0.3 }],
    [d(2), { estimated: 8, actual: 1.2 }],
    [d(40), { estimated: 100, actual: 15 }],
  ])
  const s = buildSpendSummary(map)
  check('今天只含今天', s.today.estimated === 2 && s.today.actual === 0.3)
  check('本周包含今天', s.week.estimated >= 2)
  check('本月 ≥ 本周', s.month.estimated >= s.week.estimated)
  check('本月不含 40 天前的数据', s.month.estimated < 100)
}
