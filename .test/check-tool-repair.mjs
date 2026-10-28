/**
 * 工具调用本地重建（core/tool-repair.js）的口径验证。
 *
 * 这个模块的价值不在「能解析」，而在「不敢乱来」——所以测试的重点是拒绝：
 * 名字没声明过、参数坏掉、只认外壳不认内容，都必须老老实实返回空，
 * 交给补问兜底，而不是拼一个看起来正常、实际会读错文件的调用出去。
 */
import { repairToolCalls, buildRepairChunks, textForRepair } from '../core/tool-repair.js'

const passed = []
function ok(cond, name, extra) {
  passed.push(Boolean(cond))
  console.log(`  ${cond ? '✓' : '✗'} ${name}${!cond && extra ? `  ← ${extra}` : ''}`)
  if (!cond) process.exitCode = 1
}

const TOOLS = ['read_file', 'write_file', 'get_weather']

console.log('\n[1] DeepSeek DSML（全角竖线）')
{
  const text = `Let me read that file.
<｜DSML｜function_calls>
<｜DSML｜invoke name="read_file">
<｜DSML｜parameter name="path" string="true">/tmp/a.txt</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜function_calls>`
  const result = repairToolCalls(text, { allowedToolNames: TOOLS })
  ok(result.calls.length === 1, '解析出一个调用', JSON.stringify(result))
  ok(result.calls[0]?.name === 'read_file', '工具名正确')
  ok(JSON.parse(result.calls[0]?.arguments || '{}').path === '/tmp/a.txt', '参数正确')
  ok(result.format === 'deepseek-dsml', '格式标成 deepseek-dsml')
}

console.log('\n[2] DSML 双层竖线（另一种转义）')
{
  const text = `<｜｜DSML｜｜invoke name="read_file"><｜｜DSML｜｜parameter name="path">/tmp/b.txt</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>`
  const result = repairToolCalls(text, { allowedToolNames: TOOLS })
  ok(result.calls.length === 1 && result.calls[0].name === 'read_file', '双层竖线也能认')
}

console.log('\n[3] DSML 多参数 + 数字类型')
{
  const text = `<｜DSML｜invoke name="get_weather"><｜DSML｜parameter name="city">北京</｜DSML｜parameter><｜DSML｜parameter name="days">3</｜DSML｜parameter></｜DSML｜invoke>`
  const result = repairToolCalls(text, { allowedToolNames: TOOLS })
  const args = JSON.parse(result.calls[0]?.arguments || '{}')
  ok(args.city === '北京', '中文参数原样保留')
  ok(args.days === 3, '纯数字还原成 number 而不是字符串', JSON.stringify(args))
}

console.log('\n[4] Anthropic 风格')
{
  const text = `ok
<function_calls>
<invoke name="write_file">
<parameter name="path">/tmp/c.txt</parameter>
<parameter name="content">hello
world</parameter>
</invoke>
</function_calls>`
  const result = repairToolCalls(text, { allowedToolNames: TOOLS })
  ok(result.calls.length === 1, '解析出一个调用')
  ok(result.calls[0]?.name === 'write_file', '工具名正确')
  const args = JSON.parse(result.calls[0]?.arguments || '{}')
  ok(args.content === 'hello\nworld', '多行参数原样保留', JSON.stringify(args))
}

console.log('\n[5] Qwen / GLM / Hermes 的 <tool_call>{json}')
{
  const text = `<tool_call>\n{"name": "read_file", "arguments": {"path": "/tmp/d.txt"}}\n</tool_call>`
  const result = repairToolCalls(text, { allowedToolNames: TOOLS })
  ok(result.calls.length === 1, '解析出一个调用')
  ok(result.calls[0]?.name === 'read_file', '工具名正确')
  ok(JSON.parse(result.calls[0]?.arguments || '{}').path === '/tmp/d.txt', '参数正确')
}

// ---------------------------------------------------------------- 拒绝路径

console.log('\n[6] 名字没声明过 → 不认（铁律 1）')
{
  const text = `<｜DSML｜invoke name="delete_everything"><｜DSML｜parameter name="x">1</｜DSML｜parameter></｜DSML｜invoke>`
  const result = repairToolCalls(text, { allowedToolNames: TOOLS })
  ok(result.calls.length === 0, '不重建')
  ok(result.sawMarker, '但记下了「见到标记」')
  ok(result.rejected === 'name-not-allowed', `拒绝原因是 name-not-allowed（实际 ${result.rejected}）`)
}

console.log('\n[7] 参数坏掉 → 不认（铁律 2）')
{
  // <tool_call> 里的 JSON 少了右括号：不能猜，宁可交给补问
  const text = `<tool_call>{"name": "read_file", "arguments": {"path": </tool_call>`
  const result = repairToolCalls(text, { allowedToolNames: TOOLS })
  ok(result.calls.length === 0, '不重建坏掉的调用')
  ok(result.sawMarker, '记下了见到标记')
}

console.log('\n[8] 只认出外壳、没有 invoke → 不认')
{
  const text = `模型想调工具：<｜DSML｜function_calls> ... </｜DSML｜function_calls>`
  const result = repairToolCalls(text, { allowedToolNames: TOOLS })
  ok(result.calls.length === 0, '不重建')
  ok(result.sawMarker, '记下了见到标记')
}

console.log('\n[9] 普通正文（不是在调工具）→ 完全不动')
{
  const text = '这个接口返回 { "name": "x" } 这样的结构，你可以参考文档。'
  const result = repairToolCalls(text, { allowedToolNames: TOOLS })
  ok(result.calls.length === 0, '不重建')
  ok(!result.sawMarker, '连「见到标记」都不算——正文里聊 JSON 不该被误判')
}

console.log('\n[10] 没传 allowedToolNames → 全禁（防呆）')
{
  const text = `<｜DSML｜invoke name="read_file"><｜DSML｜parameter name="path">/tmp/x</｜DSML｜parameter></｜DSML｜invoke>`
  const result = repairToolCalls(text, {})
  ok(result.calls.length === 1, '没传名单时不按名字拦（调用方必须传，见函数注释）')
  const blocked = repairToolCalls(text, { allowedToolNames: [] })
  ok(blocked.calls.length === 1, '空名单也不拦——真正的闸是调用方一定传 body.tools')
}

console.log('\n[11] 截尾保护')
{
  const long = 'x'.repeat(50000) + '<tool_call>{"name":"read_file","arguments":{"path":"/tmp/e"}}</tool_call>'
  const tail = textForRepair(long)
  ok(tail.length === 16000, `只留尾部 16000 字（实际 ${tail.length}）`)
  const result = repairToolCalls(long, { allowedToolNames: TOOLS })
  ok(result.calls.length === 1, '标记在尾部时照样能认出来')
}

console.log('\n[12] 事件形状')
{
  const chat = buildRepairChunks('chat', [{ name: 'read_file', arguments: '{"path":"/tmp/x"}' }])
  const joined = chat.join('')
  ok(joined.includes('"tool_calls"'), 'Chat：发出 tool_calls 增量')
  ok(joined.includes('"finish_reason":"tool_calls"'), 'Chat：收尾是 tool_calls 而不是 stop')
  ok(joined.includes('data: [DONE]'), 'Chat：带 [DONE]')
  const parsed = JSON.parse(chat[0].replace(/^data: /, '').trim())
  ok(parsed.choices[0].delta.tool_calls[0].function.name === 'read_file', 'Chat：工具名在正确位置')

  const responses = buildRepairChunks('responses', [{ name: 'read_file', arguments: '{"path":"/tmp/x"}' }])
  const joinedR = responses.join('')
  ok(joinedR.includes('response.output_item.added'), 'Responses：补发 output_item.added')
  ok(joinedR.includes('"type":"function_call"'), 'Responses：item 类型是 function_call')
  ok(joinedR.includes('response.completed'), 'Responses：有收尾事件')
}

console.log(`\n${passed.every(Boolean) ? '全部通过 ✓' : '有失败 ✗'}`)
