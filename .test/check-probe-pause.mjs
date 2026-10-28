/**
 * 定时关闭检测（暂停时段）验收测试。
 *
 * 分两段：
 *   1. 纯函数：core/schedule.js 的跨夜 / 边界 / 重叠 / 全天覆盖 / 非法输入
 *   2. 真跑：起假上游 + 起 daemon（把 60 秒一轮压到 400ms），用真实时钟跨分钟边界，
 *      验证「到点关」和「到点开」——不是断言某个函数返回值，而是看上游到底有没有收到请求。
 *
 * 为什么必须用真实分钟边界：窗口精度是分钟，测试里没有注入假时钟（生产代码不留时间
 * 后门），所以只能等真实的 HH:MM 翻转。整轮最多两分钟。
 *
 * 用法：node .test/check-probe-pause.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failures = []
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✓ ${name}`)
  else {
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
    failures.push(name)
  }
}

// ------------------------------------------------------------------ 纯函数

console.log('断言：时段判定（core/schedule.js）')
{
  const { pauseStatus, normalizeWindows, coversMinute, parseTime, formatTime, MAX_WINDOWS } =
    await import('../core/schedule.js')
  const at = (h, m) => new Date(2026, 9, 28, h, m, 0)
  const night = [{ id: 'n', start: '23:00', end: '08:00' }]
  const st = (windows, h, m) => pauseStatus(windows, at(h, m))

  check('parseTime 认得 00:00 / 23:59', parseTime('00:00') === 0 && parseTime('23:59') === 1439)
  check('parseTime 拒绝 24:00 / 7:00 / 空', [parseTime('24:00'), parseTime('7:00'), parseTime('')].every((v) => v === null))
  check('formatTime(1440) 折回 00:00', formatTime(1440) === '00:00')

  // 跨夜窗口：start 含、end 不含
  check('23:00~08:00：23:00 起暂停', st(night, 23, 0).paused)
  check('23:00~08:00：00:00 暂停', st(night, 0, 0).paused)
  check('23:00~08:00：07:59 仍暂停', st(night, 7, 59).paused)
  check('23:00~08:00：08:00 已恢复', st(night, 8, 0).paused === false)
  check('23:00~08:00：22:59 不暂停', st(night, 22, 59).paused === false)
  check('暂停中给出恢复时间 08:00', st(night, 2, 0).until === '08:00')
  check('未暂停时给出下次开始 23:00', st(night, 12, 0).next === '23:00')

  // 一天多段
  const three = [
    { id: 'a', start: '12:00', end: '13:00' },
    { id: 'b', start: '18:00', end: '19:00' },
    { id: 'c', start: '23:00', end: '07:00' },
  ]
  check('三段：12:30 暂停到 13:00', st(three, 12, 30).paused && st(three, 12, 30).until === '13:00')
  check('三段：14:00 下次 18:00', st(three, 14, 0).paused === false && st(three, 14, 0).next === '18:00')
  check('三段：23:30 暂停到 07:00', st(three, 23, 30).paused && st(three, 23, 30).until === '07:00')

  // 重叠：恢复时间要取最后一圈的结束点，不能按第一段算
  const overlap = [
    { id: 'a', start: '23:00', end: '03:00' },
    { id: 'b', start: '02:00', end: '06:00' },
  ]
  check('重叠窗口：02:30 暂停到 06:00', st(overlap, 2, 30).paused && st(overlap, 2, 30).until === '06:00')

  // 全天被覆盖
  const allDay = [
    { id: 'a', start: '00:00', end: '12:00' },
    { id: 'b', start: '12:00', end: '00:00' },
  ]
  const full = st(allDay, 5, 0)
  check('全天覆盖：一直暂停、没有恢复点', full.paused === true && full.until === null)

  // 空 / 非法
  check('没有时段 = 全天运行', st([], 3, 0).paused === false && st([], 3, 0).next === null)
  check('空数组归一化后为空', normalizeWindows([]).length === 0)
  const dirty = normalizeWindows([
    { start: '23:00', end: '07:00' },
    { start: '23:00', end: '07:00' }, // 重复
    { start: '25:00', end: '07:00' }, // 非法
    { start: '09:00', end: '09:00' }, // 起止相同
    { start: '07:00', end: '09:00' }, // 正常
  ])
  check('归一化丢掉重复 / 非法 / 起止相同', dirty.length === 2, JSON.stringify(dirty))
  check('归一化补出 id', dirty.every((w) => typeof w.id === 'string' && w.id.length > 0))
  check(
    `归一化最多 ${MAX_WINDOWS} 段`,
    normalizeWindows(Array.from({ length: 30 }, (_, i) => ({ start: `${String(i % 24).padStart(2, '0')}:00`, end: `${String((i % 24) + 1).padStart(2, '0')}:00` }))).length === MAX_WINDOWS,
  )
  check('同一天窗口 start 含、end 不含', coversMinute({ start: '09:00', end: '10:00' }, 540) && !coversMinute({ start: '09:00', end: '10:00' }, 600))
}

// -------------------------------------------------------------------- 真跑

const HOME = await mkdtemp(join(tmpdir(), 'mapi-pause-'))
// 端口取空闲的：本机常有别的 mock / 测试实例占着固定端口
async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}
const APP_PORT = await freePort()
let chatHits = 0
let models = ['test-model-a']

const upstream = createServer(async (req, res) => {
  if (req.url.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: models.map((id) => ({ id })) }))
    return
  }
  if (req.url.includes('/chat/completions')) {
    chatHits += 1
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      /* 忽略 */
    }
    const prompt = String(body?.messages?.[0]?.content || '')
    // 指纹题要答对，否则每条供给都判 degraded，重试节奏会盖住「该不该探」的观察
    const answer = prompt.includes('"fp"')
      ? '{"fp":"7Q2K","calc":391}'
      : prompt.includes('Count from 1 to 120')
        ? Array.from({ length: 120 }, (_, i) => i + 1).join(', ')
        : 'OK'
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    emit({ choices: [{ delta: { content: answer }, index: 0 }] })
    emit({
      choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
    })
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const UP_PORT = upstream.address().port

const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  env: {
    ...process.env,
    MANAGE_API_HOME: HOME,
    // 把调度器的 60 秒一轮压到 400ms：分钟边界仍然是真实时间
    MANAGE_API_PROBE_TICK_MS: '400',
    MANAGE_API_PROBE_FIRST_DELAY_MS: '100',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appLog = ''
app.stdout.on('data', (c) => (appLog += c))
app.stderr.on('data', (c) => (appLog += c))

const base = `http://127.0.0.1:${APP_PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`)
  return data
}

async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }
  throw new Error('服务没起来')
}

/** 等到当天第 minute 分钟的第 offsetMs 毫秒（本地时间） */
async function waitUntilMinute(minute, offsetMs = 1200) {
  const target = new Date()
  target.setHours(0, minute, 0, 0)
  target.setMilliseconds(offsetMs)
  let wait = target.getTime() - Date.now()
  if (wait < 0) wait += 24 * 3600 * 1000
  await sleep(wait)
  return target
}

const minuteOf = (date = new Date()) => date.getHours() * 60 + date.getMinutes()
const hhmm = (minute) => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

try {
  await waitReady()

  console.log('\n准备：一个站点、一把 Key、一个模型')
  const created = await call('POST', '/api/providers', {
    name: '暂停测试站',
    baseUrl: `http://127.0.0.1:${UP_PORT}/v1`,
  })
  const providerId = created.providers.find((p) => p.name === '暂停测试站').id
  await call('POST', '/api/credentials', { providerId, label: '默认', secret: 'sk-pause-1234' })
  const synced = await call('POST', `/api/providers/${providerId}/sync`, {})
  check('同步出 1 条供给', synced.offers?.length === 1, `offers=${synced.offers?.length}`)
  await call('PATCH', '/api/settings', { probeIntervalMinutes: 30 })
  await call('PATCH', '/api/settings', { probePauseWindows: [] })

  console.log('\n接口校验')
  for (const [label, windows] of [
    ['起止相同要拒', [{ start: '09:00', end: '09:00' }]],
    ['格式不对要拒', [{ start: '25:00', end: '07:00' }]],
    ['不是数组要拒', 'nope'],
  ]) {
    let status = 0
    try {
      await call('PATCH', '/api/settings', { probePauseWindows: windows })
    } catch (error) {
      status = Number(/→ (\d{3})/.exec(error.message)?.[1] || 0)
    }
    check(label, status === 400, `status=${status}`)
  }

  // ---------------------------------------------------------------- 到点关
  // 先用「现在不在时段里、下一分钟才进」的窗口，让关/开都由真实时钟触发
  const now0 = new Date()
  const m0 = minuteOf(now0)
  const stopAt = m0 + 1
  const resumeAt = m0 + 2
  console.log(`\n到点关：窗口 ${hhmm(stopAt)} ~ ${hhmm(resumeAt)}（现在 ${hhmm(m0)}）`)
  await call('PATCH', '/api/settings', {
    probePauseWindows: [{ id: 'w1', start: hhmm(stopAt), end: hhmm(resumeAt) }],
  })
  let state = await call('GET', '/api/state')
  check('还没到点，现在是照常探测', state.probePause?.paused === false, JSON.stringify(state.probePause))
  check('状态里给出下次开始时间', state.probePause?.next === hhmm(stopAt), `next=${state.probePause?.next}`)

  console.log(`  等到 ${hhmm(stopAt)}，然后新加一个从没探过的模型`)
  await waitUntilMinute(stopAt, 1200)
  state = await call('GET', '/api/state')
  check('到点后状态变成暂停中', state.probePause?.paused === true, JSON.stringify(state.probePause))
  check('状态里给出恢复时间', state.probePause?.until === hhmm(resumeAt), `until=${state.probePause?.until}`)
  check('日志里说明进入了暂停时段', appLog.includes('进入暂停时段'), '')

  // 新模型天然「到期」：暂停没生效的话，400ms 一轮的调度器立刻就会探它
  models = ['test-model-a', 'test-model-b']
  await call('POST', `/api/providers/${providerId}/sync`, {})
  const hitsAtStop = chatHits
  await sleep(3000)
  check('暂停期间一个探针请求都没发', chatHits === hitsAtStop, `新增 ${chatHits - hitsAtStop} 个请求`)

  // ---------------------------------------------------------------- 到点开
  console.log(`\n到点开：等到 ${hhmm(resumeAt)} 自动恢复`)
  await waitUntilMinute(resumeAt, 3000)
  state = await call('GET', '/api/state')
  check('过了结束时间自动解除暂停', state.probePause?.paused === false, JSON.stringify(state.probePause))
  check('恢复后探针真的发出去了', chatHits > hitsAtStop, `新增 ${chatHits - hitsAtStop} 个请求`)
  check('日志里说明恢复了探测', appLog.includes('恢复探测'), '')

  // ------------------------------------------------------- 配置后立即生效
  const m1 = minuteOf()
  console.log(`\n立即关：窗口 ${hhmm(m1)} ~ ${hhmm(m1 + 2)}（现在 ${hhmm(m1)}）`)
  await call('PATCH', '/api/settings', {
    probePauseWindows: [{ id: 'w1', start: hhmm(m1), end: hhmm(m1 + 2) }],
  })
  state = await call('GET', '/api/state')
  check('存下来就是暂停中', state.probePause?.paused === true, JSON.stringify(state.probePause))
  models = ['test-model-a', 'test-model-b', 'test-model-c']
  await call('POST', `/api/providers/${providerId}/sync`, {})
  const hitsNow = chatHits
  await sleep(3000)
  check('暂停中新增的到期模型也不会被探', chatHits === hitsNow, `新增 ${chatHits - hitsNow} 个请求`)

  // 收尾：清空时段，别把暂停状态留给后面的测试/用户
  state = await call('PATCH', '/api/settings', { probePauseWindows: [] })
  check('清空时段后恢复全天运行', state.probePause?.paused === false && state.probePause?.count === 0)
} catch (error) {
  console.log(`✗ 出错：${error.message}`)
  failures.push('异常')
} finally {
  app.kill()
  upstream.close()
  await sleep(200)
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

console.log('')
if (failures.length > 0) {
  console.log(`✗ ${failures.length} 项失败：${failures.join('、')}`)
  process.exitCode = 1
} else {
  console.log('✓ 定时关闭检测全部通过')
}
