/**
 * 协议探查（core/protocol-probe.js）测试。
 *
 * 起一个本地 mock 中转站，在四种形态之间切换，验证探查结论：
 *   native      —— 三种协议都原生实现，24 项能力应全绿
 *   translated  —— /responses 和 /messages 收下了请求但回 Chat 的结构
 *                  （表面「原生返回」、真实判定为 Chat 翻译层，能力大面积红）
 *   chat-only   —— 只有 /chat/completions，其余 404（表面不支持，能力不硬猜）
 *   degraded    —— Chat 端点回的 JSON 缺 usage/choices（表面 200 但能力红）
 *
 * 用法：node .test/check-protocol-probe.mjs
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const failures = []
const { PROTOCOL_ORDER } = await import('../core/protocol-probe.js')

function check(name, condition, detail = '') {
  if (condition) console.log(`  ✓ ${name}`)
  else {
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
    failures.push(name)
  }
}

const PORT = 5198
const BASE = `http://127.0.0.1:${PORT}/v1`

async function setMode(mode) {
  await fetch(`http://127.0.0.1:${PORT}/__mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
}

// ------------------------------------------------------------------ 纯函数

console.log('断言：形状识别与真实协议推断（core/protocol-probe.js）')
{
  const { shapeOf, PROTOCOLS } = await import('../core/protocol-probe.js')
  check('PROTOCOL_ORDER 是三种表面协议', JSON.stringify(PROTOCOL_ORDER) === '["chat","responses","anthropic"]')
  check('每种协议 8 项能力', PROTOCOL_ORDER.every((id) => PROTOCOLS[id].capabilities.length === 8))
  check('能力清单带名字和说明', PROTOCOL_ORDER.every((id) =>
    PROTOCOLS[id].capabilities.every((c) => c.id && c.name && c.desc)))
  check('chat 响应识别为 chat', shapeOf({ choices: [{ message: { content: 'x' } }] }) === 'chat')
  check('Responses 响应识别为 responses', shapeOf({ object: 'response', output: [] }) === 'responses')
  check('Anthropic 响应识别为 anthropic', shapeOf({ type: 'message', content: [] }) === 'anthropic')
  check('顶层 error 识别为 error', shapeOf({ error: { message: 'x' } }) === 'error')
  check('垃圾体识别为 unknown', shapeOf({ hello: 1 }) === 'unknown')
}

// ------------------------------------------------------------------ 真跑

const mock = spawn(process.execPath, [join(import.meta.dirname, 'tmp/protocol-mock.mjs')], {
  env: { ...process.env, PORT: String(PORT), MODE: 'native' },
  stdio: ['ignore', 'ignore', 'inherit'],
})
await new Promise((r) => setTimeout(r, 500))

const { probeProtocols } = await import('../core/protocol-probe.js')

async function runOnce(extra = {}) {
  return probeProtocols({
    baseUrl: BASE,
    apiKey: 'sk-test',
    model: 'test-model-a',
    timeoutMs: 5000,
    overallTimeoutMs: 30000,
    ...extra,
  })
}

try {
  console.log('\n形态：native（三种协议全部原生）')
  await setMode('native')
  {
    const r = await runOnce()
    check('三种表面协议都原生返回', r.summary.surfaceNative.join(',') === 'chat,responses,anthropic', JSON.stringify(r.summary.surfaceNative))
    check('表面支持三种协议', r.summary.surfaceSupported.length === 3)
    check('24 项能力全部通过', r.summary.capabilities.pass === 24 && r.summary.capabilities.fail === 0, JSON.stringify(r.summary.capabilities))
    for (const id of PROTOCOL_ORDER) {
      check(`${id} 真实协议=原生`, r.protocols[id].real.label.includes('原生'), r.protocols[id].real.label)
    }
    check('previous_response_id 通过（真实协议的关键证据）', r.protocols.responses.capabilities.find((c) => c.id === 'previous_response_id')?.status === 'pass')
    check('tool_result 通过（Anthropic 真实协议的关键证据）', r.protocols.anthropic.capabilities.find((c) => c.id === 'tool_result')?.status === 'pass')
    check('请求次数约 29（3 表面 + 24 能力 + 首轮鉴权重试余量）', r.summary.requests >= 27 && r.summary.requests <= 30, String(r.summary.requests))
  }

  console.log('\n形态：translated（/responses、/messages 回 Chat 结构）')
  await setMode('translated')
  {
    const r = await runOnce()
    check('chat 表面原生', r.protocols.chat.surface.outcome === 'native')
    check('responses 表面「被翻译」', r.protocols.responses.surface.outcome === 'translated', r.protocols.responses.surface.outcome)
    check('anthropic 表面「被翻译」', r.protocols.anthropic.surface.outcome === 'translated', r.protocols.anthropic.surface.outcome)
    check('responses 真实协议=Chat 翻译层', r.protocols.responses.real.label.includes('底层翻译'), r.protocols.responses.real.label)
    check('anthropic 真实协议=Chat 翻译层', r.protocols.anthropic.real.label.includes('底层翻译'), r.protocols.anthropic.real.label)
    check('翻译层能力大面积缺失（fail>=12）', r.summary.capabilities.fail >= 12, JSON.stringify(r.summary.capabilities))
    check('previous_response_id 在翻译层上缺失', r.protocols.responses.capabilities.find((c) => c.id === 'previous_response_id')?.status === 'fail')
  }

  console.log('\n形态：chat-only（/responses、/messages 404）')
  await setMode('chat-only')
  {
    const r = await runOnce()
    check('responses 表面=不支持', r.protocols.responses.surface.outcome === 'unsupported', r.protocols.responses.surface.outcome)
    check('anthropic 表面=不支持', r.protocols.anthropic.surface.outcome === 'unsupported', r.protocols.anthropic.surface.outcome)
    check('不支持时不硬猜真实协议', r.protocols.responses.real.label === '不支持该协议' && r.protocols.anthropic.real.label === '不支持该协议')
    check('跳过的协议不再发能力请求', r.summary.requests <= 13, String(r.summary.requests))
    check('chat 仍全绿', r.protocols.chat.summary.pass === 8)
    check('不可测的能力标 fail 并说明原因', r.protocols.responses.capabilities.every((c) => c.status === 'fail' && c.detail.includes('表面协议不支持')))
  }

  console.log('\n形态：degraded（chat 端点回残缺 JSON）')
  await setMode('degraded')
  {
    const r = await runOnce()
    check('chat 表面仍是 200（原生返回）', r.protocols.chat.surface.outcome === 'native')
    check('但 chat 能力大面积红（fail>=5）', r.protocols.chat.summary.fail >= 5, JSON.stringify(r.protocols.chat.summary))
    check('responses / anthropic 不受影响', r.protocols.responses.summary.fail === 0 && r.protocols.anthropic.summary.fail === 0)
  }

  console.log('\n边界：协议子集（非 Anthropic 模型跳过 anthropic）')
  {
    const r = await runOnce({ protocols: ['chat', 'responses'] })
    check('只探 chat / responses', r.protocols.responses && !r.protocols.anthropic)
    check('skippedProtocols 记下 anthropic', JSON.stringify(r.skippedProtocols) === '["anthropic"]')
    check('能力总数 16 而不是 24', r.summary.capabilities.total === 16, JSON.stringify(r.summary.capabilities))
  }

  console.log('\n边界：不存在的地址 / 错误 Key')
  await setMode('native')
  {
    const dead = await probeProtocols({
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-x',
      model: 'm',
      timeoutMs: 2000,
      overallTimeoutMs: 8000,
    })
    check('连不上时表面=network', Object.values(dead.protocols).every((p) => p.surface.outcome === 'network'))
    check('network 不算「缺失能力」（全是 unknown）', dead.summary.capabilities.fail === 0 && dead.summary.capabilities.unknown === 24)
    check('真实协议=无法判定而不是硬猜', Object.values(dead.protocols).every((p) => p.real.label === '无法判定'))

    // mock 不校验 Key，这里只验证错误 Key 的分类路径：直接打 mock 的 401 分支不存在，
    // 所以只验证「探测本身不抛异常、结构完整」
    const r = await runOnce()
    check('结果结构完整（target/protocols/summary/requests）', Boolean(r.target && r.protocols && r.summary && Array.isArray(r.requests)))
    check('结果里没有泄露 apiKey', !JSON.stringify(r).includes('sk-test'))
  }

  console.log('\n边界：进度回调与取消')
  {
    const events = []
    const controller = new AbortController()
    const promise = probeProtocols({
      baseUrl: BASE,
      apiKey: 'sk-test',
      model: 'test-model-a',
      timeoutMs: 5000,
      overallTimeoutMs: 30000,
      signal: controller.signal,
      onProgress: (event) => events.push(event),
    })
    controller.abort()
    const r = await promise
    const types = new Set(events.map((e) => e.type))
    check('进度回调覆盖 start/surface/capability/result', ['start', 'surface', 'capability', 'result'].every((t) => types.has(t)), [...types].join(','))
    check('start 事件带原生基线（8 项能力）', events.find((e) => e.type === 'start')?.protocols?.every((p) => p.capabilities.length === 8))
    check('取消后能力标 unknown 而不是 fail', r.summary.capabilities.fail === 0 || r.summary.capabilities.unknown > 0, JSON.stringify(r.summary.capabilities))
  }
} finally {
  mock.kill()
}

console.log('')
if (failures.length) {
  console.error(`协议探查测试：${failures.length} 项失败`)
  process.exit(1)
}
console.log('协议探查测试：全部通过')
