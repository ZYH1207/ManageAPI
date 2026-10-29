/**
 * 协议探查（core/protocol-probe.js + protocol-catalog + protocol-verdict）测试。
 *
 * 起一个本地 mock 中转站，在多种形态之间切换，验证探查结论：
 *   native            四种协议都原生实现、能力齐全 → 全绿 + 可导入对应工具
 *   translated        /responses、/messages 收下请求但回 Chat 结构 → 判定翻译层
 *   chat-only         只有 /chat/completions，其余 404 → 表面不支持，能力不硬猜
 *   degraded          Chat 200 但缺 usage → 表面通、能力红
 *   toolchoice-blind  各协议无视 tool_choice → 「能不能强制调工具」全部红
 *   no-vision         各协议都读不出图 → vision 红，其它不受影响
 *   gemini-flat       Gemini 不认 responseSchema / thinkingConfig
 *   truncate-context  长上下文静默截头 → long_context 红
 *   flaky             部分能力隔次失败 → 三次模式下判 flaky
 *
 * 用法：node .test/check-protocol-probe.mjs
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const failures = []
const { PROTOCOL_ORDER, PROTOCOLS, capabilitiesFor, PROBE_MODES } = await import(
  '../core/protocol-probe.js'
)

function check(name, condition, detail = '') {
  if (condition) console.log(`  ✓ ${name}`)
  else {
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
    failures.push(name)
  }
}

// 随机端口：固定端口会被本机别的实例/残留连接撞上，导致 mock 被外部流量干扰
const PORT = 5300 + Math.floor(Math.random() * 250)
const BASE = `http://127.0.0.1:${PORT}/v1`

async function setMode(mode) {
  await fetch(`http://127.0.0.1:${PORT}/__mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
}

const cap = (result, protocolId, id) =>
  result.protocols[protocolId]?.capabilities?.find((row) => row.id === id) || null

// ------------------------------------------------------------------ 纯函数

console.log('断言：能力字典与形状识别')
{
  const { shapeOf } = await import('../core/protocol-probe.js')
  check('四协议顺序稳定', JSON.stringify(PROTOCOL_ORDER) === '["chat","responses","anthropic","gemini"]')
  check(
    '每种协议都有能力清单',
    PROTOCOL_ORDER.every((id) => PROTOCOLS[id].capabilities.length >= 13),
    PROTOCOL_ORDER.map((id) => `${id}:${PROTOCOLS[id].capabilities.length}`).join(' '),
  )
  check(
    '每条能力都写了「缺了会怎样」',
    PROTOCOL_ORDER.every((id) => PROTOCOLS[id].capabilities.every((c) => c.id && c.name && c.impact)),
  )
  check(
    '每种协议都有 key 项（轻量模式用）',
    PROTOCOL_ORDER.every((id) => PROTOCOLS[id].capabilities.filter((c) => c.key).length >= 3),
    PROTOCOL_ORDER.map((id) => `${id}:${capabilitiesFor(id, 'lite').length}`).join(' '),
  )
  check('轻量模式的项数少于全量', PROTOCOL_ORDER.every((id) => capabilitiesFor(id, 'lite').length < capabilitiesFor(id, 'full').length))
  check('两种模式都有说明文案', Boolean(PROBE_MODES.lite.desc && PROBE_MODES.full.desc))
  check('chat 响应识别为 chat', shapeOf({ choices: [{ message: { content: 'x' } }] }) === 'chat')
  check('responses 响应识别为 responses', shapeOf({ object: 'response', output: [] }) === 'responses')
  check('anthropic 响应识别为 anthropic', shapeOf({ type: 'message', content: [] }) === 'anthropic')
  check('gemini 响应识别为 gemini', shapeOf({ candidates: [{ content: { parts: [] } }] }) === 'gemini')
  check('顶层 error 识别为 error', shapeOf({ error: { message: 'x' } }) === 'error')
  check('垃圾体识别为 unknown', shapeOf({ hello: 1 }) === 'unknown')
}

console.log('\n断言：结论翻译（protocol-verdict）')
{
  const { protocolVerdict, overallAdvice } = await import('../core/protocol-verdict.js')
  const rows = (ids, status) =>
    ids.map((id) => ({ id, name: id, status, detail: '', key: id.includes('tool') }))

  const allPass = protocolVerdict('chat', rows(['tools', 'tool_result', 'system_prompt', 'max_tokens'], 'pass'), { outcome: 'native' })
  check('全绿时结论=native', allPass.level === 'native', allPass.level)
  check('全绿时能给「能做什么」', allPass.can.length > 0)
  check('全绿时消费方 ready=ok', allPass.consumers.every((c) => c.ready === 'ok'), JSON.stringify(allPass.consumers.map((c) => c.ready)))

  const missingTool = protocolVerdict(
    'chat',
    [
      { id: 'tools', name: '函数调用 tools', status: 'fail', detail: '没有 tool_calls', key: true },
      { id: 'system_prompt', name: '系统提示', status: 'pass', detail: '', key: true },
      { id: 'tool_result', name: '工具结果回放', status: 'pass', detail: '', key: true },
      { id: 'max_tokens', name: '截断', status: 'pass', detail: '', key: true },
    ],
    { outcome: 'native' },
  )
  check('缺关键项时不是 native', missingTool.level !== 'native', missingTool.level)
  check('缺关键项时给出「不能做什么」', missingTool.cannot.some((c) => c.id === 'tools'))
  check('缺关键项时消费方 ready 不是 ok', missingTool.consumers.some((c) => c.ready !== 'ok'))
  check(
    '缺工具时提示语说清后果（提到不能调工具）',
    /工具|调|读写/.test(missingTool.toolHint + missingTool.cannot.map((c) => c.impact).join('')),
    missingTool.toolHint,
  )

  const unsupported = protocolVerdict('responses', [], { outcome: 'unsupported', error: 'HTTP 404' })
  check('端点不支持时 level=unsupported', unsupported.level === 'unsupported')
  check('端点不支持时提示别导入', /别|不要/.test(unsupported.toolHint), unsupported.toolHint)

  const flaky = protocolVerdict(
    'chat',
    [
      { id: 'tools', name: '函数调用', status: 'flaky', detail: '', key: true },
      { id: 'system_prompt', name: '系统提示', status: 'pass', detail: '', key: true },
    ],
    { outcome: 'native' },
  )
  check('时好时坏不会被判成全绿', flaky.level !== 'native', flaky.level)
  check('时好时坏会点出来', flaky.cannot.some((c) => c.status === 'flaky') || /时好时坏/.test(flaky.toolHint))

  const adv = overallAdvice({
    chat: { verdict: { level: 'native', headline: 'ok' } },
    responses: { verdict: { level: 'weak', headline: 'bad' } },
  })
  check('总建议会点名优先协议和别碰的协议', /优先/.test(adv) && /别/.test(adv), adv)
}

// ------------------------------------------------------------------ 真跑

const mock = spawn(process.execPath, [join(import.meta.dirname, 'protocol-mock.mjs')], {
  env: { ...process.env, PORT: String(PORT), MODE: 'native' },
  stdio: ['ignore', 'ignore', 'inherit'],
})
await new Promise((r) => setTimeout(r, 600))

const { probeProtocols } = await import('../core/protocol-probe.js')

async function runOnce(extra = {}) {
  return probeProtocols({
    baseUrl: BASE,
    apiKey: 'sk-test',
    model: 'test-model-a',
    timeoutMs: 8000,
    overallTimeoutMs: 120000,
    ...extra,
  })
}

try {
  console.log('\n形态：native · 全量单次')
  await setMode('native')
  {
    const r = await runOnce()
    check('四种表面协议都原生返回', r.summary.surfaceNative.join(',') === 'chat,responses,anthropic,gemini', JSON.stringify(r.summary.surfaceNative))
    const total = r.summary.capabilities.total
    check('能力总数 = 四协议全量之和', total === PROTOCOL_ORDER.reduce((n, id) => n + capabilitiesFor(id, 'full').length, 0), String(total))
    check('没有红也没有 flaky', r.summary.capabilities.fail === 0 && r.summary.capabilities.flaky === 0, JSON.stringify(r.summary.capabilities))
    check('四协议都判为可用', r.summary.readyProtocols.length === 4, JSON.stringify(r.summary.readyProtocols))
    for (const id of PROTOCOL_ORDER) {
      check(`${id} 真实协议=原生`, r.protocols[id].real.label.includes('原生'), r.protocols[id].real.label)
      check(`${id} 有结论 verdict`, Boolean(r.protocols[id].verdict?.headline))
    }
    check('Codex 适配判定为可用', r.protocols.responses.verdict.consumers.find((c) => c.id === 'codex')?.ready === 'ok')
    check('结果带总建议', typeof r.advice === 'string' && r.advice.length > 0, r.advice)
  }

  console.log('\n形态：lite（只测关键项）')
  {
    const r = await runOnce({ mode: 'lite' })
    const expected = PROTOCOL_ORDER.reduce((n, id) => n + capabilitiesFor(id, 'lite').length, 0)
    check('轻量模式能力总数更少', r.summary.capabilities.total === expected, `${r.summary.capabilities.total} vs ${expected}`)
    check('轻量模式仍然给结论', PROTOCOL_ORDER.every((id) => Boolean(r.protocols[id].verdict?.headline)))
    check('轻量模式请求数也少', r.summary.requests < 40, String(r.summary.requests))
  }

  console.log('\n形态：三次（flaky 能被认出来）')
  await setMode('flaky')
  {
    const r = await runOnce({ mode: 'lite', repeat: 3 })
    check('repeat 记进结果', r.repeat === 3)
    check('时好时坏被判成 flaky 而不是 pass/fail', r.summary.capabilities.flaky > 0, JSON.stringify(r.summary.capabilities))
    check('flaky 的项会带每次的明细', r.protocols.chat.capabilities.some((row) => row.status === 'flaky' && Array.isArray(row.runs)))
    check('flaky 不进 readyProtocols', !r.summary.readyProtocols.includes('chat') || r.summary.readyProtocols.length < 4)
  }
  await setMode('native')

  console.log('\n形态：translated（/responses、/messages 回 Chat 结构）')
  await setMode('translated')
  {
    const r = await runOnce()
    check('chat 表面原生', r.protocols.chat.surface.outcome === 'native')
    check('responses 表面「被翻译」', r.protocols.responses.surface.outcome === 'translated', r.protocols.responses.surface.outcome)
    check('anthropic 表面「被翻译」', r.protocols.anthropic.surface.outcome === 'translated', r.protocols.anthropic.surface.outcome)
    check('responses 真实协议=Chat 翻译层', r.protocols.responses.real.label.includes('底层翻译'), r.protocols.responses.real.label)
    check('previous_response_id 在翻译层上缺失', cap(r, 'responses', 'previous_response_id')?.status === 'fail')
    check('Codex 判定为「不完全适配」', ['no', 'part'].includes(r.protocols.responses.verdict.consumers.find((c) => c.id === 'codex')?.ready))
  }

  console.log('\n形态：chat-only（/responses、/messages 404）')
  await setMode('chat-only')
  {
    const r = await runOnce()
    check('responses 表面=不支持', r.protocols.responses.surface.outcome === 'unsupported', r.protocols.responses.surface.outcome)
    check('anthropic 表面=不支持', r.protocols.anthropic.surface.outcome === 'unsupported', r.protocols.anthropic.surface.outcome)
    check('gemini 表面=不支持', r.protocols.gemini.surface.outcome === 'unsupported', r.protocols.gemini.surface.outcome)
    check('不支持时不硬猜真实协议', r.protocols.responses.real.label === '不支持该协议')
    check('不支持的协议不再发能力请求', r.summary.requests <= 30, String(r.summary.requests))
    check('chat 仍全绿', r.protocols.chat.summary.fail === 0, JSON.stringify(r.protocols.chat.summary))
    check('不可测的能力标 fail 并说明原因', r.protocols.responses.capabilities.every((c) => c.status === 'fail' && c.detail.includes('表面协议不支持')))
  }

  console.log('\n形态：degraded（chat 端点回残缺 JSON）')
  await setMode('degraded')
  {
    const r = await runOnce()
    check('chat 表面仍是 200（原生返回）', r.protocols.chat.surface.outcome === 'native')
    check('但 chat 能力大面积红', r.protocols.chat.summary.fail >= 5, JSON.stringify(r.protocols.chat.summary))
    check('responses / anthropic 不受影响', r.protocols.responses.summary.fail === 0 && r.protocols.anthropic.summary.fail === 0)
  }

  console.log('\n形态：toolchoice-blind（各协议无视 tool_choice）')
  await setMode('toolchoice-blind')
  {
    const r = await runOnce({ mode: 'full' })
    check('chat 强制 tool_choice 判红', cap(r, 'chat', 'tool_choice')?.status === 'fail')
    check('responses 强制 tool_choice 判红', cap(r, 'responses', 'tool_choice')?.status === 'fail')
    check('anthropic 强制 tool_choice 判红', cap(r, 'anthropic', 'tool_choice')?.status === 'fail')
    check('gemini 强制 functionCallingConfig 判红', cap(r, 'gemini', 'function_config')?.status === 'fail')
    check('但普通工具调用仍然算通过', cap(r, 'chat', 'tools')?.status === 'pass', cap(r, 'chat', 'tools')?.status)
  }

  console.log('\n形态：no-vision（读不出图）')
  await setMode('no-vision')
  {
    const r = await runOnce({ mode: 'full', protocols: ['chat', 'responses'] })
    check('chat vision 判红', cap(r, 'chat', 'vision')?.status === 'fail')
    check('responses vision 判红', cap(r, 'responses', 'vision')?.status === 'fail')
    check('其他关键项不受牵连', cap(r, 'chat', 'tools')?.status === 'pass')
  }

  console.log('\n形态：gemini-flat（不认 responseSchema / thinkingConfig）')
  await setMode('gemini-flat')
  {
    const r = await runOnce({ mode: 'full', protocols: ['gemini'] })
    check('gemini responseSchema 判红', cap(r, 'gemini', 'response_schema')?.status === 'fail', cap(r, 'gemini', 'response_schema')?.detail)
    check('gemini 基础对话仍通过', cap(r, 'gemini', 'basic')?.status === 'pass')
  }

  console.log('\n形态：truncate-context（长上下文静默截头）')
  await setMode('truncate-context')
  {
    const r = await runOnce({ mode: 'full', protocols: ['chat', 'gemini'] })
    check('chat 长上下文判红', cap(r, 'chat', 'long_context')?.status === 'fail')
    check('gemini 长上下文判红', cap(r, 'gemini', 'long_context')?.status === 'fail')
  }

  console.log('\n边界：协议子集')
  await setMode('native')
  {
    const r = await runOnce({ protocols: ['chat', 'responses'] })
    check('只探 chat / responses', Boolean(r.protocols.responses) && !r.protocols.anthropic && !r.protocols.gemini)
    check('skippedProtocols 记下跳过的两个', JSON.stringify(r.skippedProtocols) === '["anthropic","gemini"]', JSON.stringify(r.skippedProtocols))
  }

  console.log('\n边界：不存在的地址')
  {
    const dead = await probeProtocols({
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-x',
      model: 'm',
      mode: 'lite',
      timeoutMs: 2000,
      overallTimeoutMs: 15000,
    })
    check('连不上时表面=network', Object.values(dead.protocols).every((p) => p.surface.outcome === 'network'))
    check('network 不算「缺失能力」（没有 fail）', dead.summary.capabilities.fail === 0, JSON.stringify(dead.summary.capabilities))
    check('真实协议=无法判定而不是硬猜', Object.values(dead.protocols).every((p) => p.real.label === '无法判定'))
    check('结论也标成无法判定', Object.values(dead.protocols).every((p) => p.verdict.level === 'unknown'))
  }

  console.log('\n记录：结论与建议要能落库（记录页点开才看得到「缺什么、怎么用」）')
  {
    await setMode('translated')
    const { buildProtocolRecord, pruneProtocolRecords, ensureProtocolRecords, saveProtocolRecord } = await import(
      '../core/protocol-records.js'
    )
    const r = await runOnce({ mode: 'lite' })
    const record = buildProtocolRecord({
      result: r,
      target: {
        mode: 'gateway',
        offerId: 'o_test',
        providerId: 'p_test',
        providerName: '测试站',
        group: 'g1',
        label: '测试站 / test-model-a',
      },
      statusTags: ['ok'],
      badStatus: false,
    })
    check('记录带上总建议', typeof record.advice === 'string' && record.advice.length > 0, String(record.advice))
    check('记录里每个协议都留了结论', PROTOCOL_ORDER.every((id) => Boolean(record.protocols[id]?.verdict?.headline)))
    check(
      '记录里留了能力明细（记录页要能点开看哪项缺失）',
      PROTOCOL_ORDER.every((id) => (record.protocols[id]?.capabilities || []).length > 0),
    )
    check('记录里砍掉了大字段 requests/evidence', !('requests' in record) && !JSON.stringify(record).includes('"evidence"'))
    check(
      '记录自带身份：站点/分组/模型',
      record.providerName === '测试站' && record.group === 'g1' && record.model === 'test-model-a',
      `${record.providerName}/${record.group}/${record.model}`,
    )
    check('记录带 mode/repeat', record.mode === 'lite' && record.repeat === 1)

    // 落库再读回来：记录页走 /api/protocol/records/:id，靠的就是这份
    const db = ensureProtocolRecords({})
    saveProtocolRecord(db, record)
    check(
      '落库后按 id 读回结论不变',
      db.protocolProbes.find((row) => row.id === record.id)?.protocols.responses?.verdict?.headline ===
        record.protocols.responses.verdict.headline,
    )

    // Plus 版之前的旧记录：verdict/advice 全 null，不能因此被清理误删、也不能让记录页崩
    db.protocolProbes.unshift({ id: 'pp_legacy', ts: record.ts, advice: null, protocols: { chat: { surface: {}, real: null } } })
    check('自动清理关闭（0 天）时一条都不删', pruneProtocolRecords(db, 0) === 0 && db.protocolProbes.length === 2)
    check('按天清理只按时间算，新记录不会被误删', pruneProtocolRecords(db, 1) === 0)
    await setMode('native')
  }

  console.log('\n边界：进度回调与取消')
  {
    const events = []
    const controller = new AbortController()
    const promise = probeProtocols({
      baseUrl: BASE,
      apiKey: 'sk-test',
      model: 'test-model-a',
      mode: 'lite',
      timeoutMs: 5000,
      overallTimeoutMs: 30000,
      signal: controller.signal,
      onProgress: (event) => events.push(event),
    })
    controller.abort()
    const r = await promise
    const types = new Set(events.map((e) => e.type))
    check('进度回调覆盖 start/surface/capability/result', ['start', 'surface', 'capability', 'result'].every((t) => types.has(t)), [...types].join(','))
    check('start 事件带模式与重复次数', events.find((e) => e.type === 'start')?.mode === 'lite')
    check('取消后不会把能力判成 fail', r.summary.capabilities.fail === 0 || r.summary.capabilities.unknown > 0)
    check('结果里没有泄露 apiKey', !JSON.stringify(r).includes('sk-test'))
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
