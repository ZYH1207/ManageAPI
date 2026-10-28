/**
 * 工具调用本地重建：把上游漏进正文/思考里的「原生工具调用标记」重新拼成标准 tool_calls。
 *
 * 病因（2026-10-28 实测）：部分中转站的协议翻译层有 bug——模型吐的是自家方言
 * （DeepSeek 的 DSML、Anthropic 的 <invoke>、Qwen/GLM 的 <tool_call>{json}），
 * 本该被翻成标准的 tool_calls，结果整块被吞。运气好的时候方言会原样漏进
 * content 或 reasoning_content，这时网关自己就能把它解析回来：
 *   本地重建 = 零延迟、零成本，比「再问模型一遍」好得多。
 *
 * 但必须说清楚它补不了什么：**只有标记真的到了网关手里才谈得上重建**。如果整块
 * 被吞、一个字节都没传过来，那缺的是「内容」而不是「格式」——网关不知道模型想
 * 调哪个工具、参数是什么，这种只能补问（见 core/empty-guard.js）。
 *
 * ---------------------------------------------------------------- 三条铁律
 *
 * 这个模块的价值全在「不敢乱来」上，所以规则写得比解析逻辑还长：
 *
 * 1. **名字必须在本次请求声明的 tools 里**。模型文本里冒出一个没声明过的工具名，
 *    一律不认——那多半是正文里在讲别人的代码，不是它要调工具。
 * 2. **参数必须是合法 JSON（或按各家约定退化成字符串）**。解析不出来就不重建：
 *    给 agent 一个参数错乱的工具调用，比让它拿到空回合更糟——它会拿着错误的
 *    路径去读文件，而且看起来完全正常。
 * 3. **只在「客户端带了 tools、上游没回 tool_calls、正文为空」三条同时成立时启动**。
 *    调用方（daemon/server.js）负责这个前置判断，本模块只做解析，不判断该不该解析。
 *
 * 认不出的方言不报错、不猜，返回 sawMarker=true 让调用方记一笔「见到了标记但
 * 解析不出」——这就是以后补清单的依据，而不是静默失败。
 */

/**
 * 已知方言：每一条都是「先认外壳，再认里面的参数」。
 *
 * 为什么写成表而不是一坨 if：方言只会越来越多，加一种就是加一个对象，
 * 不用碰解析主流程，也不会改坏已有格式。
 */
const FORMATS = [
  {
    id: 'deepseek-dsml',
    label: 'DeepSeek DSML',
    // 外壳：<｜DSML｜invoke name="x"> ... </｜DSML｜invoke>
    // 分隔符有两种写法（全角竖线与半角竖线、单层与双层），都是同一套东西的不同转义
    callPattern: /<[｜|]{1,2}DSML[｜|]{1,2}\s*invoke\s+name="([^"<>]+)"[^>]*>([\s\S]*?)<\/[｜|]{1,2}DSML[｜|]{1,2}\s*invoke>/gi,
    argPattern: /<[｜|]{1,2}DSML[｜|]{1,2}\s*parameter\s+name="([^"<>]+)"[^>]*>([\s\S]*?)<\/[｜|]{1,2}DSML[｜|]{1,2}\s*parameter>/gi,
    markerPattern: /[｜|]{1,2}DSML[｜|]{1,2}/i,
  },
  {
    id: 'anthropic-xml',
    label: 'Anthropic <invoke>',
    callPattern: /<invoke\s+name="([^"<>]+)"\s*>([\s\S]*?)<\/invoke>/gi,
    argPattern: /<parameter\s+name="([^"<>]+)"[^>]*>([\s\S]*?)<\/parameter>/gi,
    markerPattern: /<\s*(?:antml:)?invoke\s+name=|<\s*function_calls\s*>/i,
  },
  {
    id: 'json-tool-call',
    label: '<tool_call>{json}',
    // Qwen / GLM / Hermes 一脉：整个调用就是一个 JSON
    callPattern: /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/gi,
    jsonBody: true,
    markerPattern: /<tool_call>/i,
  },
]

/** 从一段文本里能截出来的最大字符数：方言块通常几 KB，16K 已经足够，防内存被撑爆 */
const MAX_SCAN_CHARS = 16000

/**
 * 从正文/思考里把「标记原文」抓好：只看最后一段。
 *
 * 为什么要截尾而不是全量：一个 20 万 token 的对话里正文可能很长，但标记总是出现在
 * **这一轮刚生成的那一小段**里。留尾部 16K 既够解析，又不至于为大回答白占内存。
 */
export function textForRepair(text) {
  const raw = String(text || '')
  return raw.length <= MAX_SCAN_CHARS ? raw : raw.slice(-MAX_SCAN_CHARS)
}

/**
 * 把一组 <parameter>/JSON 解析成 arguments 对象。
 *
 * 空的参数（只有外壳、没有 parameter）返回 {}——有些站就是这么表达「无参数工具」。
 */
function parseArgs(format, body) {
  if (format.jsonBody) {
    try {
      const parsed = JSON.parse(body)
      const name = parsed?.name || parsed?.function?.name
      const args = parsed?.arguments ?? parsed?.function?.arguments
      if (!name) return null
      return { name: String(name), args: normalizeArgs(args) }
    } catch {
      return null
    }
  }

  const args = {}
  format.argPattern.lastIndex = 0
  let match
  while ((match = format.argPattern.exec(body)) !== null) {
    const [, key, rawValue] = match
    if (!key) continue
    args[key.trim()] = coerce(rawValue)
  }
  return { args }
}

/**
 * 参数值的还原：先当 JSON 解析（数字/布尔/对象/数组都在这里），
 * 解析不了就当字符串——Anthropic 那套的约定就是「文本即值」。
 * 结尾的换行/缩进是格式化留下的，剪掉，但不剪内部空白（值里可能真有空格）。
 */
function coerce(rawValue) {
  const text = String(rawValue ?? '').replace(/^\s*\n/, '').replace(/\s+$/, '')
  if (text === '') return ''
  // 只对明确的 JSON 字面量做还原：裸的 1、true、{"a":1}、[1,2]、"x"
  if (/^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(text)) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  if (/^[{[]/.test(text)) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  if (/^".*"$/s.test(text)) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

/** arguments 一律收敛成 JSON 字符串：OpenAI 的 tool_calls[].function.arguments 是这个形状 */
function normalizeArgs(args) {
  if (args === null || args === undefined) return '{}'
  if (typeof args === 'string') {
    // 已经是字符串的（<tool_call>{json} 里的 arguments 常有）校验一下能不能解析，
    // 解析不了就当空对象——宁可少参数，也不给一个语法坏掉的 arguments 让客户端崩
    try {
      JSON.parse(args)
      return args
    } catch {
      return '{}'
    }
  }
  try {
    return JSON.stringify(args)
  } catch {
    return '{}'
  }
}

/**
 * 尝试从文本里重建工具调用。
 *
 * @param {string} text 本轮生成的正文 + 思考（调用方用 textForRepair 截尾）
 * @param {{allowedToolNames?: string[]}} options
 *   allowedToolNames —— 本次请求声明过的工具名。**传空数组等于全禁**：
 *   调用方一定要把 body.tools 里的名字传进来，否则第 1 条铁律就失效了
 * @returns {{calls: Array<{name:string, arguments:string}>, format: string|null,
 *            sawMarker: boolean, rejected: string|null}}
 *   calls       —— 重建出来的调用；空数组表示没重建（不一定是没标记）
 *   sawMarker   —— 见到了方言标记（但可能解析失败）
 *   rejected    —— 放弃的原因，给记录页看：'unknown-format' / 'name-not-allowed' /
 *                  'bad-args' / 'no-tool-name'
 */
export function repairToolCalls(text, { allowedToolNames = [] } = {}) {
  const source = textForRepair(text)
  if (!source) return { calls: [], format: null, sawMarker: false, rejected: null }

  const allowed = new Set(
    (Array.isArray(allowedToolNames) ? allowedToolNames : []).map((name) => String(name).trim()),
  )
  let sawMarker = false
  let rejected = null

  for (const format of FORMATS) {
    if (!format.markerPattern.test(source)) continue
    sawMarker = true
    format.callPattern.lastIndex = 0
    const calls = []
    let match
    while ((match = format.callPattern.exec(source)) !== null) {
      const [, namePart, body] = match
      const parsed = format.jsonBody ? parseArgs(format, namePart) : { name: namePart, ...parseArgs(format, body) }
      if (!parsed || !parsed.name) {
        rejected = rejected || 'no-tool-name'
        continue
      }
      const name = String(parsed.name).trim()
      // 铁律 1：名字必须在本轮声明过的工具里
      if (allowed.size > 0 && !allowed.has(name)) {
        rejected = 'name-not-allowed'
        continue
      }
      // 铁律 2：参数必须能收敛成合法 JSON
      const args = normalizeArgs(parsed.args)
      if (args === '{}' && parsed.args !== undefined && parsed.args !== null && parsed.args !== '') {
        rejected = 'bad-args'
        continue
      }
      calls.push({ name, arguments: args })
    }
    if (calls.length > 0) return { calls, format: format.id, sawMarker: true, rejected: null }
  }

  return { calls: [], format: null, sawMarker, rejected: sawMarker ? rejected || 'unknown-format' : null }
}

/**
 * 把重建出来的调用翻译成客户端协议认得的事件。
 *
 * 只做「事件形状」这一件事，不碰判定——调用方决定要不要发。
 *
 * Chat 协议：一个把 tool_calls 拼完整的 delta，加一个 finish_reason=tool_calls 的收尾。
 * Responses 协议：output_item.added / done 各一条，外加一个把 output 补齐的
 * response.completed（该事件的原文由调用方提供，这里只改 output 数组）。
 *
 * @returns {string[]} 每项都是一段可直接写给客户端的 SSE 文本
 */
export function buildRepairChunks(protocol, calls, { terminal = null, responseId = null } = {}) {
  if (!Array.isArray(calls) || calls.length === 0) return []
  const chunks = []

  if (protocol === 'responses') {
    const items = calls.map((call, index) => ({
      type: 'function_call',
      id: `fc_repair_${Date.now().toString(36)}_${index}`,
      call_id: `call_repair_${Date.now().toString(36)}_${index}`,
      name: call.name,
      arguments: call.arguments,
      status: 'completed',
    }))
    for (const item of items) {
      chunks.push(`data: ${JSON.stringify({ type: 'response.output_item.added', item })}\n\n`)
      chunks.push(`data: ${JSON.stringify({ type: 'response.output_item.done', item })}\n\n`)
    }
    // 收尾事件如果本来就拿到了，就把 output 补上重发；没拿到就自己造一个最小的
    const base = terminal && typeof terminal === 'object' ? terminal : {
      type: 'response.completed',
      response: { id: responseId || `resp_repair_${Date.now().toString(36)}`, status: 'completed', output: [] },
    }
    const response = base.response && typeof base.response === 'object' ? base.response : {}
    const merged = { ...base, response: { ...response, output: [...(response.output || []), ...items] } }
    chunks.push(`data: ${JSON.stringify(merged)}\n\n`)
    return chunks
  }

  // Chat：一个 delta 里把多个 tool_calls 一次给全（index 递增，客户端按 index 归位）
  const toolCalls = calls.map((call, index) => ({
    index,
    id: `call_repair_${Date.now().toString(36)}_${index}`,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  }))
  chunks.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: toolCalls } }] })}\n\n`)
  chunks.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
  chunks.push('data: [DONE]\n\n')
  return chunks
}
