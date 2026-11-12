#!/usr/bin/env node
/**
 * 原生 Anthropic 上游 + 上游协议判定 的验收。
 *
 * 覆盖 2026-11-12 那个真实故障：
 *   rapid 的 Rapid-Kiro 分组只认原生 /v1/messages，网关原来对 anthropic 客户端
 *   一律翻成 Chat 打 /chat/completions，这条路上游不吐字节，客户端挂到 60s 超时。
 *   同一个 offer 用 /messages 打，8.9 秒就有回应（实测）。
 *
 * 两层必须分开验，混在一起就分不清是哪层坏了：
 *   A. 形状层：Chat ⇄ 上游 Anthropic 的请求/响应/流翻译（纯函数，零网络）
 *   B. 判定层：哪条供给该走哪条路（含学习与手动覆盖）
 *
 * 全程零网络、零 daemon 依赖。
 */

import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')
const mod = (rel) => import(pathToFileURL(join(ROOT, rel)).href)

let pass = 0
async function ok(label, fn) {
  await fn()
  pass += 1
  console.log('  ✓ ' + label)
}

const up = await mod('core/anthropic-upstream.js')
const proto = await mod('core/upstream-protocol.js')

console.log('[A1] 请求方向：内部 Chat → 上游 Anthropic')
{
  await ok('system 提到顶层；max_tokens 保留；不再有 messages 里的 system 角色', () => {
    const out = up.chatToAnthropicRequest({
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
      ],
    }, { model: 'claude-opus-5-5' })
    assert.equal(out.system, '你是助手')
    assert.equal(out.max_tokens, 1024)
    assert.ok(out.messages.every((m) => m.role !== 'system'))
    assert.deepEqual(out.messages[0], { role: 'user', content: [{ type: 'text', text: '你好' }] })
  })

  await ok('max_tokens 缺失时补保守值（Anthropic 必填，缺了上游直接 400）', () => {
    const out = up.chatToAnthropicRequest({ messages: [{ role: 'user', content: 'hi' }] }, { model: 'm' })
    assert.ok(Number.isInteger(out.max_tokens) && out.max_tokens > 0, '必须有 max_tokens，实际 ' + out.max_tokens)
  })

  await ok('工具：{type:function,function:{...}} 摊平成 {name,input_schema}', () => {
    const out = up.chatToAnthropicRequest({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'read', description: 'd', parameters: { type: 'object', properties: { p: { type: 'string' } } } } }],
      tool_choice: 'required',
    }, { model: 'm' })
    assert.equal(out.tools[0].name, 'read')
    assert.equal(out.tools[0].description, 'd')
    assert.equal(out.tools[0].input_schema.type, 'object')
    assert.equal(out.tools[0].function, undefined, '不该残留 function 壳')
    assert.deepEqual(out.tool_choice, { type: 'any' })
  })

  await ok('tool 结果：role:"tool" 翻成 user 里的 tool_result 块', () => {
    const out = up.chatToAnthropicRequest({
      messages: [
        { role: 'user', content: '读文件' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '文件内容' },
      ],
    }, { model: 'm' })
    const assistant = out.messages.find((m) => m.role === 'assistant')
    assert.equal(assistant.content[0].type, 'tool_use')
    assert.equal(assistant.content[0].id, 'call_1')
    assert.deepEqual(assistant.content[0].input, { p: 'a' })
    const result = out.messages.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'))
    assert.ok(result, 'tool 结果必须落到 user 的 tool_result 块')
    assert.equal(result.content[0].tool_use_id, 'call_1')
  })

  await ok('图片：image_url(data:base64) 翻成 Anthropic base64 source', () => {
    const out = up.chatToAnthropicRequest({
      messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] }],
    }, { model: 'm' })
    const img = out.messages[0].content.find((b) => b.type === 'image')
    assert.equal(img.source.type, 'base64')
    assert.equal(img.source.media_type, 'image/png')
    assert.equal(img.source.data, 'QUJD')
  })

  await ok('不带 Chat 专属字段（stream_options / max_completion_tokens）', () => {
    const out = up.chatToAnthropicRequest({
      messages: [{ role: 'user', content: 'x' }],
      stream_options: { include_usage: true },
      max_completion_tokens: 100,
    }, { model: 'm' })
    assert.equal(out.stream_options, undefined)
    assert.equal(out.max_completion_tokens, undefined)
  })
}

console.log('\n[A2] 响应方向：上游 Anthropic → 内部 Chat')
{
  await ok('非流式 message → chat.completion，usage 把缓存读加回 prompt_tokens', () => {
    const chat = up.anthropicMessageToChat({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
      content: [{ type: 'text', text: '通了' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 20 },
    }, { model: 'claude-opus-5-5' })
    assert.equal(chat.choices[0].message.content, '通了')
    assert.equal(chat.choices[0].finish_reason, 'stop')
    assert.equal(chat.usage.prompt_tokens, 120, 'prompt_tokens 要含缓存（Chat 口径）')
    assert.equal(chat.usage.completion_tokens, 5)
    assert.equal(chat.usage.prompt_tokens_details.cached_tokens, 20)
  })

  await ok('tool_use 块 → tool_calls，stop_reason=tool_use → finish_reason=tool_calls', () => {
    const chat = up.anthropicMessageToChat({
      type: 'message', role: 'assistant',
      content: [{ type: 'text', text: '我读一下' }, { type: 'tool_use', id: 'tu1', name: 'read', input: { p: 'a' } }],
      stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 2 },
    })
    assert.equal(chat.choices[0].finish_reason, 'tool_calls')
    assert.equal(chat.choices[0].message.tool_calls[0].id, 'tu1')
    assert.equal(chat.choices[0].message.tool_calls[0].function.name, 'read')
    assert.deepEqual(JSON.parse(chat.choices[0].message.tool_calls[0].function.arguments), { p: 'a' })
  })

  await ok('max_tokens → finish_reason=length（截断信号不能丢）', () => {
    const chat = up.anthropicMessageToChat({ type: 'message', role: 'assistant', content: [], stop_reason: 'max_tokens', usage: {} })
    assert.equal(chat.choices[0].finish_reason, 'length')
  })

  await ok('looksLikeAnthropicMessage 能区分 message 与 error', () => {
    assert.equal(up.looksLikeAnthropicMessage({ type: 'message', role: 'assistant', content: [] }), true)
    assert.equal(up.looksLikeAnthropicMessage({ type: 'error', error: { message: 'x' } }), false)
    assert.equal(up.looksLikeAnthropicMessage({ choices: [] }), false)
  })
}

console.log('\n[A3] 流式：上游 Anthropic SSE → Chat SSE（下游零改动的前提）')
{
  const runStream = async (frames) => {
    const text = frames.map((f) => `event: x\ndata: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n'
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(text)); c.close() },
    })
    const chatStream = up.anthropicUpstreamToChatStream(stream, { model: 'claude-opus-5-5' })
    const reader = chatStream.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    const chunks = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let cut
      while ((cut = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, cut).replace(/\r$/, '')
        buf = buf.slice(cut + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        chunks.push(JSON.parse(data))
      }
    }
    return chunks
  }

  await ok('纯文本流：切成 choices[].delta.content，收尾有 finish_reason 与 usage', async () => {
    const chunks = await runStream([
      { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10, cache_read_input_tokens: 4 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    ])
    const deltas = chunks.filter((c) => c.choices?.[0]?.delta?.content)
    assert.equal(deltas.map((c) => c.choices[0].delta.content).join(''), '你好')
    const finish = chunks.find((c) => c.choices?.[0]?.finish_reason)
    assert.equal(finish.choices[0].finish_reason, 'stop')
    const usage = chunks.find((c) => c.usage)
    assert.equal(usage.usage.prompt_tokens, 14, 'prompt_tokens 含缓存')
    assert.equal(usage.usage.completion_tokens, 2)
    assert.equal(usage.usage.total_tokens, 16)
  })

  await ok('工具流：tool_use 起始 + input_json_delta → tool_calls 参数片段', async () => {
    const chunks = await runStream([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'read' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"p":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"a"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
    ])
    const calls = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls).map((c) => c.choices[0].delta.tool_calls[0])
    assert.equal(calls[0].id, 'tu1')
    assert.equal(calls[0].function.name, 'read')
    const args = calls.map((c) => c.function.arguments || '').join('')
    assert.equal(args, '{"p":"a"}', '参数片段拼起来必须是完整 JSON，实际 ' + args)
    const finish = chunks.find((c) => c.choices?.[0]?.finish_reason)
    assert.equal(finish.choices[0].finish_reason, 'tool_calls')
  })

  await ok('上游流内 error → 写成 Chat 的 error 帧（现有检测器能接住）', async () => {
    const chunks = await runStream([
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'error', error: { type: 'overloaded_error', message: '上游过载' } },
    ])
    const err = chunks.find((c) => c.error)
    assert.ok(err, '必须有 error 帧')
    assert.match(String(err.error.message), /上游过载/)
  })

  await ok('thinking_delta 被丢弃（内部 Chat 形状没有对应字段）', async () => {
    const chunks = await runStream([
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '思考中' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    ])
    const text = chunks.filter((c) => c.choices?.[0]?.delta?.content).map((c) => c.choices[0].delta.content).join('')
    assert.equal(text, '', 'thinking 不该漏进正文')
  })
}

console.log('\n[B] 判定层：哪条供给走哪条路')
{
  await ok('默认协议跟随客户端：responses→responses、chat/anthropic→chat', () => {
    const c = { offer: { upstreamName: 'gpt-r', group: 'g' }, provider: { id: 'p1' }, credential: {} }
    assert.equal(proto.resolveUpstreamProtocol(c, {}, { clientProtocol: 'responses' }).protocol, 'responses',
      'responses 客户端必须继续走上游 /responses（这是改造前就有的行为）')
    assert.equal(proto.resolveUpstreamProtocol(c, {}, { clientProtocol: 'chat' }).protocol, 'chat')
    assert.equal(proto.resolveUpstreamProtocol(c, {}, { clientProtocol: 'anthropic' }).protocol, 'chat',
      'anthropic 客户端在入口已翻成 Chat，上游默认仍是 Chat')
  })

  await ok('没有任何标记时默认 chat（保持改造前行为，不动绝大多数站）', () => {
    const r = proto.resolveUpstreamProtocol({
      offer: { upstreamName: 'claude-opus-5-5', group: 'g' },
      provider: { id: 'p1' },
      credential: { group: 'g' },
    }, {})
    assert.equal(r.protocol, 'chat')
    assert.equal(r.source, 'default')
  })

  await ok('供给显式标 anthropic → 走原生（最高优先级）', () => {
    const r = proto.resolveUpstreamProtocol({
      offer: { upstreamName: 'claude-opus-5-5', group: 'g', upstreamProtocol: 'anthropic' },
      provider: { id: 'p1' }, credential: {},
    }, { upstreamProtocols: { 'p1::g::claude-opus-5-5': { mode: 'chat' } } })
    assert.equal(r.protocol, 'anthropic')
    assert.equal(r.source, 'offer', '显式标记必须压过学习结果')
  })

  await ok('学到的结果在没有显式标记时生效', () => {
    const r = proto.resolveUpstreamProtocol({
      offer: { upstreamName: 'claude-opus-5-5', group: 'Rapid-Kiro' },
      provider: { id: 'p_80c372b1' }, credential: {},
    }, { upstreamProtocols: { 'p_80c372b1::Rapid-Kiro::claude-opus-5-5': { mode: 'anthropic', note: '实测' } } })
    assert.equal(r.protocol, 'anthropic')
    assert.equal(r.source, 'learned')
  })

  await ok('非 Anthropic 模型即使学到也不会被误判成原生', () => {
    // 学习表是按「站::组::模型名」精确匹配的，gpt 的键不会命中 claude
    const r = proto.resolveUpstreamProtocol({
      offer: { upstreamName: 'gpt-6.1-sol', group: 'Rapid-0.045不降智gpt' },
      provider: { id: 'p_80c372b1' }, credential: {},
    }, { upstreamProtocols: { 'p_80c372b1::Rapid-Kiro::claude-opus-5-5': { mode: 'anthropic' } } })
    assert.equal(r.protocol, 'chat')
  })

  await ok('shouldLearnNativeAnthropic：超时/空响应/404 才学', () => {
    const base = { model: 'claude-opus-5-5', protocol: 'chat' }
    assert.equal(proto.shouldLearnNativeAnthropic({ ...base, error: '上游 60 秒无响应（超时）' }), true)
    assert.equal(proto.shouldLearnNativeAnthropic({ ...base, error: 'HTTP 404 not found' }), true)
    assert.equal(proto.shouldLearnNativeAnthropic({ ...base, error: '上游全部失败（共试了 1 个供给）' }), true)
  })

  await ok('shouldLearnNativeAnthropic：限流/鉴权/非 Claude 不学（学了反而带偏正常站）', () => {
    const base = { model: 'claude-opus-5-5', protocol: 'chat' }
    assert.equal(proto.shouldLearnNativeAnthropic({ ...base, error: 'Upstream rate limit exceeded' }), false, '429 限流换协议也没用')
    assert.equal(proto.shouldLearnNativeAnthropic({ ...base, error: 'HTTP 401 unauthorized' }), false, '鉴权失败换协议也没用')
    assert.equal(proto.shouldLearnNativeAnthropic({ model: 'gpt-6.1-sol', protocol: 'chat', error: '上游 60 秒无响应（超时）' }), false, '非 Claude 模型不该切原生')
    assert.equal(proto.shouldLearnNativeAnthropic({ ...base, protocol: 'anthropic', error: '超时' }), false, '已经在走原生，不再重复学')
  })

  await ok('upstreamPathFor 三种协议路径正确', () => {
    assert.equal(proto.upstreamPathFor('chat'), '/chat/completions')
    assert.equal(proto.upstreamPathFor('responses'), '/responses')
    assert.equal(proto.upstreamPathFor('anthropic'), '/messages')
  })

  await ok('learnUpstreamProtocol / forgetUpstreamProtocol 往返', () => {
    const db = { settings: {} }
    assert.equal(proto.learnUpstreamProtocol(db, {
      providerId: 'p1', group: 'g', model: 'claude-opus-5-5', mode: 'anthropic', note: '实测',
    }), true)
    assert.equal(db.settings.upstreamProtocols['p1::g::claude-opus-5-5'].mode, 'anthropic')
    assert.equal(proto.forgetUpstreamProtocol(db, { providerId: 'p1', group: 'g', model: 'claude-opus-5-5' }), true)
    assert.equal(db.settings.upstreamProtocols, undefined, '清空后应删除整个字段')
  })
}

console.log(`\ncheck-upstream-protocol: ${pass} 组断言通过`)
process.exit(0)
