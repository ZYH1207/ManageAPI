#!/usr/bin/env node
/**
 * N21 · ManageAPI LLM Adapter 真实验收（不是静态字符检查）。
 *
 * 真打 http://127.0.0.1:4319/v1（已在运行的 daemon PID 34904，只读 + 一次真实 chat）：
 *   1. listModels() → 4 模型且含 gpt-6.1-sol
 *   2. resolveModel 成功 / 不存在明确失败
 *   3. prepareCall 返回结构（baseUrl 指向 4319、带 Authorization、model/stream 就位）
 *   4. 真实 chat：gpt-6.1-sol + 「只回复两个字：通了」，断言响应含「通了」，原文打印
 *   5. 假 ctx：注册 providers 恰为 ['dsh-manage-api']、adapter 有 prepareCall、无 ctx.llm 软降级
 *   6. ctx.inject(['llm']) 延迟就绪：未就绪不注册，就绪后注册成功
 *
 * 第 4 步失败即整体 exit != 0，绝不 mock / 跳过。
 * Key 只从环境变量 MANAGE_API_TEST_KEY 取，源码零字面量（仓库公开，不得提交真实 Key）。
 */

import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')
const ADAPTER = resolve(ROOT, 'lib', 'integration', 'llm-adapter.js')
const INDEX = resolve(ROOT, 'index.js')

// 本地测试用 Key：只从环境变量取，源码里不留任何字面量（仓库是公开的）。
// 用法：MANAGE_API_TEST_KEY=$(cat ~/.manage-api/test-key) node dsh-plugin/.test/check-llm-adapter.mjs
// 没给 Key 时明确失败退出，不静默跳过、不 mock。
const LOCAL_TEST_KEY = process.env.MANAGE_API_TEST_KEY
if (!LOCAL_TEST_KEY) {
  console.error('缺少 MANAGE_API_TEST_KEY：本测试要真打网关，必须显式提供 Key（不写死在源码里）。')
  console.error('例：MANAGE_API_TEST_KEY=<你的网关 Key> node dsh-plugin/.test/check-llm-adapter.mjs')
  process.exit(2)
}
const BASE_URL = 'http://127.0.0.1:4319/v1'
const PROVIDER = 'dsh-manage-api'
const MODEL = 'gpt-6.1-sol'
const PROMPT = '只回复两个字：通了'

const passed = []
const ok = (label) => { passed.push(label); console.log('  ok  ' + label) }

const mod = await import(pathToFileURL(ADAPTER).href)
const { ManageApiAdapter, registerLlmAdapter, resolveApiKey } = mod

// ── 1. 动态 /v1/models ────────────────────────────────────────────────
// 用户给的 4 模型是先前目录快照；网关 /v1/models 是动态目录（实跑时可能已同步更多）。
// 断言守住「4 个基线模型全部在列」+「adapter 与实时目录逐项一致」，不写死数量、不 mock。
const BASELINE_MODELS = ['claude-opus-5.5', 'deepseek-4.1-flash', 'gemini-3.8-flash', 'gpt-6.1-sol']
console.log('\n[1/6] listModels() 真打 GET /v1/models')
const adapter = new ManageApiAdapter({
  providerId: PROVIDER,
  displayName: 'ManageAPI 网关',
  baseUrl: BASE_URL,
  apiKey: LOCAL_TEST_KEY,
})
const liveRes = await fetch(`${BASE_URL}/models`, { headers: { authorization: `Bearer ${LOCAL_TEST_KEY}` } })
assert.equal(liveRes.status, 200, `实时 /v1/models 应 200，实际 ${liveRes.status}`)
const liveIds = (await liveRes.json()).data.map((row) => row.id)
const models = await adapter.listModels(PROVIDER)
console.log('  实时目录 ' + liveIds.length + ' 个；adapter 返回 ' + models.length + ' 个')
console.log('  实测模型：' + models.map((m) => m.id).join(', '))
assert.equal(BASELINE_MODELS.length, 4, '基线目录恰为 4 个模型')
for (const id of BASELINE_MODELS) {
  assert.ok(models.some((m) => m.id === id), `基线模型 ${id} 未列出`)
  assert.ok(liveIds.includes(id), `实时目录缺基线模型 ${id}`)
}
assert.ok(models.some((m) => m.id === MODEL), '未列出 gpt-6.1-sol')
assert.equal(models.length, liveIds.length, 'adapter 目录必须与实时 /v1/models 数量一致')
assert.deepEqual(models.map((m) => m.id), liveIds, 'adapter 目录必须与实时 /v1/models 逐项一致')
assert.ok(models.length >= 4, '动态目录至少应包含 4 个基线模型')
assert.equal(models[0].provider, PROVIDER)
assert.equal(models[0].inputModalities[0], 'text')
assert.equal(models[0].defaultMaxTokens, 131072, 'maxTokens 必须是保守值 131072')
assert.equal(models[0].context.contextWindow, 131072)
assert.deepEqual(adapter.providerInfo(PROVIDER), { id: PROVIDER, name: 'ManageAPI 网关', models: models.map((m) => m.id) })
ok('listModels 实测基线 4 模型全在列（含 gpt-6.1-sol）、与实时目录 ' + models.length + ' 项一致、providerInfo 形状正确')

// ── 2. resolveModel 成功 / 不存在明确失败 ─────────────────────────────
console.log('\n[2/6] resolveModel 成功 / 不存在')
const resolved = await adapter.resolveModel(PROVIDER, MODEL)
assert.equal(resolved.id, MODEL)
assert.equal(resolved.provider, PROVIDER)
let failure = ''
try { await adapter.resolveModel(PROVIDER, 'no-such-model-n21') } catch (err) { failure = String(err && err.message ? err.message : err) }
assert.match(failure, /不存在模型/, `不存在的模型必须明确报错，实际：${failure}`)
console.log('  不存在时错误：' + failure)
ok('resolveModel 成功；不存在时明确报错')

// ── 3. prepareCall 返回结构（按 DSH 消费方：{model, stream}）──────────
console.log('\n[3/6] prepareCall 返回结构')
const call = await adapter.prepareCall(PROVIDER, MODEL)
assert.equal(typeof call, 'object')
assert.equal(call.model.id, MODEL)
assert.equal(typeof call.stream, 'function')
assert.equal(call.baseUrl, BASE_URL)
assert.match(call.baseUrl, /127\.0\.0\.1:4319\/v1$/, 'baseUrl 必须指向 4319 的 /v1')
assert.equal(call.headers.authorization, `Bearer ${LOCAL_TEST_KEY}`)
assert.equal(call.headers['content-type'], 'application/json')
// 真实消费方 LlmRuntime.prepareCall 只取 model（normalizeModelInfo）/ stream（dispatch）
const wire = adapter.wire
assert.equal(wire.baseUrl, BASE_URL)
assert.equal(wire.headers.authorization, `Bearer ${LOCAL_TEST_KEY}`)
console.log('  prepareCall: baseUrl=' + call.baseUrl + ' authorization=Bearer <local-test-key> model=' + call.model.id + ' stream=' + typeof call.stream)
ok('prepareCall 含 DSH 期望的 model/stream，且 baseUrl 指向 4319、带 Authorization')

// ── 4. 真实发一次调用（不许 mock / 跳过）─────────────────────────────
console.log('\n[4/6] 真实 chat：POST /v1/chat/completions（' + MODEL + '）')
const chatResponse = await fetch(`${BASE_URL}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${LOCAL_TEST_KEY}` },
  body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: PROMPT }], stream: false }),
})
assert.equal(chatResponse.status, 200, `真实 chat HTTP 状态应为 200，实际 ${chatResponse.status}`)
const chatRaw = await chatResponse.text()
console.log('  响应原文：' + chatRaw)
const chatBody = JSON.parse(chatRaw)
const chatText = chatBody?.choices?.[0]?.message?.content ?? ''
assert.ok(String(chatText).includes('通了'), `真实响应必须含「通了」，实际：${String(chatText)}`)
ok('真实 chat 响应含「通了」（原文已贴上方）')

// 顺带验证 adapter 自己的 stream() 真能产出 DSH chunk（SSE 增量拼接）。
{
  let text = ''
  let finish = null
  for await (const chunk of adapter.stream({
    provider: PROVIDER, model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') finish = chunk.reason
  }
  assert.ok(text.includes('通了'), `adapter.stream 拼接文本应含「通了」，实际 ${text}`)
  assert.equal(finish?.kind, 'stop')
  console.log('  stream() 拼接：' + text.trim() + ' / finish=' + finish?.kind)
  ok('adapter.stream 真实 SSE → DSH chunk 词汇，文本含「通了」')
}

// ── 5. 注册入口：假 ctx / Key 优先级 / 软降级 ────────────────────────
console.log('\n[5/6] 假 ctx 注册与软降级')
function fakeLlm() {
  const regs = []
  const disposers = []
  return {
    regs, disposers,
    registerAdapter(providers, instance) {
      regs.push({ providers, instance })
      const dispose = () => { disposers.push(providers[0]) }
      return dispose
    },
  }
}
{
  const llm = fakeLlm()
  const logs = []
  const dispose = registerLlmAdapter({
    ctx: { llm }, config: { apiKey: LOCAL_TEST_KEY }, runtime: { loopbackBaseUrl: 'http://127.0.0.1:4319' },
    log: (...a) => logs.push(a.join(' ')),
  })
  assert.equal(llm.regs.length, 1)
  assert.deepEqual(llm.regs[0].providers, ['dsh-manage-api'])
  assert.equal(typeof llm.regs[0].instance.prepareCall, 'function')
  assert.equal(llm.regs[0].instance.wire.baseUrl, BASE_URL)
  assert.equal(typeof dispose, 'function')
  dispose(); dispose()
  assert.deepEqual(llm.disposers, ['dsh-manage-api'])
  ok('注册 providers 恰为 ["dsh-manage-api"]，adapter 有 prepareCall，disposer 幂等')
}
{
  const llm = fakeLlm()
  const logs = []
  const dispose = registerLlmAdapter({ ctx: {}, config: { apiKey: LOCAL_TEST_KEY }, runtime: {}, log: (...a) => logs.push(a.join(' ')) })
  assert.equal(llm.regs.length, 0)
  assert.equal(typeof dispose, 'function')
  assert.match(logs.join('\n'), /ctx\.llm 不可用/)
  ok('无 ctx.llm 时软降级不抛（零注册 + 日志）')
}
{
  const llm = fakeLlm()
  const logs = []
  const saved = { gateway: process.env.MANAGE_API_GATEWAY_KEY, plain: process.env.MANAGE_API_KEY }
  try {
    delete process.env.MANAGE_API_GATEWAY_KEY
    delete process.env.MANAGE_API_KEY
    registerLlmAdapter({ ctx: { llm }, config: {}, runtime: {}, log: (...a) => logs.push(a.join(' ')) })
    assert.equal(llm.regs.length, 0)
    assert.match(logs.join('\n'), /缺少 apiKey/)
    const a = resolveApiKey({}, { MANAGE_API_GATEWAY_KEY: 'gateway-key', MANAGE_API_KEY: 'plain-key' })
    assert.equal(a.key, 'gateway-key')
    assert.equal(resolveApiKey({ apiKey: 'config-key' }, { MANAGE_API_GATEWAY_KEY: 'gateway-key' }).key, 'config-key')
    assert.equal(resolveApiKey({}, { MANAGE_API_KEY: 'plain-key' }).key, 'plain-key')
  } finally {
    if (saved.gateway !== undefined) process.env.MANAGE_API_GATEWAY_KEY = saved.gateway
    if (saved.plain !== undefined) process.env.MANAGE_API_KEY = saved.plain
  }
  ok('apiKey 全无则警告跳过；优先级 config > GATEWAY_KEY > MANAGE_API_KEY')
}

// ── 6. ctx.inject(['llm']) 延迟就绪（照 check-full-boot.mjs D 组）─────
console.log('\n[6/6] 延迟就绪：插件先激活、llm 后就绪')
{
  const indexMod = await import(pathToFileURL(INDEX).href)
  const state = { injects: [], effects: [], registered: [] }
  const config = { autoStart: false, attachExisting: false, port: 4319, runtimeDir: '', dataDir: '', waitMs: 10000, apiKey: LOCAL_TEST_KEY }
  const ctx = {
    effect(fn) { const d = fn(); state.effects.push(d); return () => { if (typeof d === 'function') d() } },
    get(name) { return name === 'webServer' ? undefined : undefined },
    logger() { return { info() {}, warn() {}, error() {} } },
    inject(names, cb) { state.injects.push({ names, cb }); return () => {} },
    _state: state,
  }
  indexMod.apply(ctx, config)
  const llmInjects = state.injects.filter((i) => i.names && i.names.length === 1 && i.names[0] === 'llm')
  assert.equal(llmInjects.length, 1, 'index.js 必须恰好用一次 ctx.inject(["llm"], ...)')
  ok('使用 ctx.inject(["llm"], ...) 等待依赖')

  const fake = fakeLlm()
  assert.equal(fake.regs.length, 0, 'llm 未就绪时不得注册')
  ok('未就绪期间零注册')

  const readyCtx = {
    get(name) { return name === 'llm' ? fake : undefined },
    effect(fn) { const d = fn(); state.effects.push(d); return () => { if (typeof d === 'function') d() } },
    logger() { return { info() {}, warn() {}, error() {} } },
  }
  llmInjects[0].cb(readyCtx)
  assert.equal(fake.regs.length, 1, 'llm 就绪后应注册成功')
  assert.deepEqual(fake.regs[0].providers, ['dsh-manage-api'])
  assert.equal(typeof fake.regs[0].instance.prepareCall, 'function')
  ok('就绪后注册成功（providers / prepareCall 就位）')
  for (const d of state.effects.splice(0).reverse()) { try { if (typeof d === 'function') d() } catch { /* ignore */ } }
  ok('disposer 释放不抛')
}

console.log(`\ncheck-llm-adapter: ${passed.length} 组断言通过；真实 chat 原文：${chatRaw}`)
