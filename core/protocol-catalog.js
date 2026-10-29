/**
 * 协议能力字典：四种协议各自「原生应该有什么」、缺了会怎样、能被哪些工具消费。
 *
 * 为什么单独一个文件：这份清单同时被三个地方吃——
 *   1. core/protocol-probe.js 拿它决定测哪些项；
 *   2. web/protocol-view.js 拿它画「原生基线 vs 实测」和解释文案；
 *   3. 记录页拿它做历史对比。
 * 三处各写一份必然漂移（本项目最大的历史坑），所以口径只在这里定义。
 *
 * 每条能力四个字段：
 *   id      程序用的稳定键
 *   name    界面上的一句话名字
 *   desc    原生协议下它应该怎么表现（判定依据）
 *   impact  这一项缺失时，到底会坏在哪 —— 作者要求「说清影响」，就是这句
 *   key     true 表示轻量模式也测（agent 干活离不开的命脉项）
 *
 * 工具适配（CONSUMERS）也在这里：哪个工具真的用这条协议、它最少需要哪几项。
 * 判定「能不能导入某个工具」不靠猜，靠拿实测结果和 requires 求交集。
 */

/** 四种协议。path 是相对 baseUrl（已含 /v1）的路径；gemini 走单独解析。 */
export const PROTOCOLS = {
  chat: {
    id: 'chat',
    label: 'OpenAI Chat Completions',
    short: 'Chat',
    path: '/chat/completions',
    note: 'OpenAI 兼容生态的通用底座，几乎所有客户端都认。',
    capabilities: [
      { id: 'stream_sse', name: '流式 SSE', key: true, desc: 'stream=true 时按 choices[].delta 分块返回，并以 finish_reason / [DONE] 收尾', impact: '回答要整段生成完才出现，长回答像卡死；agent 界面看不到实时进度。' },
      { id: 'system_prompt', name: '系统提示 system', key: true, desc: 'role:"system" 的消息被模型采纳', impact: '模型看不到角色设定与规则，指令遵循全乱，等于把 agent 的人格和安全边界丢了。' },
      { id: 'tools', name: '函数调用 tools', key: true, desc: '接受 tools 定义，返回 tool_calls（name + 合法 JSON arguments）', impact: '模型不能读写文件、跑命令，只能陪聊 —— agent 直接退化成聊天机器人。' },
      { id: 'tool_result', name: '工具结果回放', key: true, desc: 'role:"tool" + tool_call_id 能把工具结果交回模型', impact: '工具调用链断在第二轮：模型看不到结果，会反复重调同一工具直到上下文烧完。' },
      { id: 'max_tokens', name: 'max_tokens 截断信号', key: true, desc: '额度用完时 finish_reason=length', impact: '不知道回答被砍断，补丁写一半会被当成写完去应用，改坏文件。' },
      { id: 'usage', name: 'usage 计量', desc: '返回 prompt_tokens / completion_tokens', impact: '无法核算花费，网关的计费、余额告警、预算拦截全部失真。' },
      { id: 'multi_turn', name: '多轮上下文', desc: '历史消息回放后能复述前文埋的信息', impact: '每轮失忆，会重复读同一个文件、忘了刚做的修改，长任务做不成。' },
      { id: 'tool_choice', name: '强制 tool_choice', desc: 'tool_choice 指定某个函数时必须调用它', impact: '没法强制「这一步必须查工具」，编排流程会跑偏成自由发挥。' },
      { id: 'parallel_tools', name: '并行工具调用', desc: '一次返回 2 个以上 tool_calls', impact: '多文件操作只能一个个串行往返，速度慢数倍。' },
      { id: 'json_schema', name: '结构化输出 json_schema', desc: 'response_format 的 json_schema 生效，返回合法 JSON', impact: '程序拿不到可靠 JSON，解析失败要重试，流水线不稳定。' },
      { id: 'stop_sequence', name: 'stop 停止序列', desc: 'stop 命中时立即停止输出', impact: '输出可能越过边界把后续内容也吐出来，污染下游解析。' },
      { id: 'vision', name: '图片输入 vision', desc: '接受 image_url，能读懂图片内容', impact: '看不了截图、设计稿、报错图，排查界面问题基本瞎。' },
      { id: 'reasoning', name: '推理内容回传', desc: '返回 reasoning_content 或等效思考字段', impact: '看不到推理过程，降智排查少一条线索，只能凭感觉判断。' },
      { id: 'long_context', name: '长上下文', desc: '约 2 万字符的输入里，仍能捞出开头埋的信息', impact: '长文件、大仓库读不全，会静默丢掉开头，行为诡异但报错为零。' },
      { id: 'long_output', name: '长输出不中断', desc: '一次能连续产出 1000 以上 token 且正常收尾', impact: '写长文件会被截断，一次改不完，要拆很多轮。' },
      { id: 'strict_schema', name: '严格 schema', desc: 'function.strict=true 被接受且遵守', impact: '工具参数可能缺字段或多字段，调用方要做额外防御。' },
      { id: 'n_choices', name: '多候选 n>1', desc: 'n=2 时返回两条 choices', impact: '只影响单次采样几条，agent 永远 n=1，通常无关紧要。' },
    ],
  },
  responses: {
    id: 'responses',
    label: 'OpenAI Responses',
    short: 'Responses',
    path: '/responses',
    note: 'Codex 与 OpenAI 新 SDK 的原生协议；很多中转站是「转成 Chat 再转回来」的翻译层。',
    capabilities: [
      { id: 'instructions', name: 'instructions 顶层指令', key: true, desc: '顶层 instructions 被模型采纳', impact: 'Codex 的人格、沙箱规则、AGENTS.md 全在这个字段；丢了模型等于裸奔。' },
      { id: 'tools_function', name: '函数调用', key: true, desc: '扁平 tools 定义返回 function_call item', impact: 'Codex 无法执行命令和改文件。' },
      { id: 'tool_result', name: '工具结果回放', key: true, desc: 'function_call_output 按 call_id 接得上', impact: '工具循环断掉，模型看不到执行结果，反复重试同一步。' },
      { id: 'previous_response_id', name: '跨请求接续', key: true, desc: 'previous_response_id 能继承上一轮上下文', impact: '每轮只看到最后一句，失忆；工具轮还会因 call_id 找不到而 400 或静默丢弃。' },
      { id: 'incomplete', name: 'incomplete 截断状态', key: true, desc: '额度用完返回 status=incomplete + reason', impact: '静默截断：上层以为写完了，实际补丁只写了一半。' },
      { id: 'sse_sequence', name: '原生 SSE 事件序列', desc: 'response.created → output_text.delta → completed', impact: '流式客户端等不到增量事件，界面一直转圈或直接报协议错。' },
      { id: 'output_items', name: '原生 output 结构', desc: 'output 是 message / output_text item 数组', impact: '按原生结构解析的客户端取不到正文。' },
      { id: 'input_array', name: 'input 数组形式', desc: 'input 接受 message/item 数组而不只是字符串', impact: '只能传一句话，多模态与历史数组都发不进去。' },
      { id: 'text_format', name: '结构化输出 text.format', desc: 'text.format 的 json_schema 生效', impact: '结构化输出拿不到，程序化消费要自己兜。' },
      { id: 'tool_choice', name: '强制 tool_choice', desc: 'tool_choice 指定某个函数时必须调用它', impact: '不能强制某步必须调工具，编排容易跑偏。' },
      { id: 'parallel_tools', name: '并行工具调用', desc: '一次返回 2 个以上 function_call', impact: '多文件操作串行化，速度变慢。' },
      { id: 'reasoning_item', name: '推理项回传', desc: 'output 里有 reasoning item 或 reasoning_tokens>0', impact: '思维链断裂，跨轮质量下降；排查降智少一条线索。' },
      { id: 'vision', name: '图片输入', desc: 'input_image 能读懂图片内容', impact: '看不了截图，Codex 读界面设计稿和报错图的能力消失。' },
      { id: 'usage', name: 'usage 计量', desc: '返回 input_tokens / output_tokens', impact: '花费核算失真。' },
      { id: 'long_context', name: '长上下文', desc: '约 2 万字符输入里仍能捞出开头埋的信息', impact: '长文读不全，静默丢开头。' },
      { id: 'store', name: '会话存储 store', desc: 'store:true 被接受并在响应里回显', impact: '依赖服务端存会话的客户端要退化成全量重发。' },
    ],
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Messages',
    short: 'Anthropic',
    path: '/messages',
    note: 'Claude Code 与 Anthropic SDK 用的协议；中转站通常也做一层翻译。',
    capabilities: [
      { id: 'tools', name: '工具 tool_use', key: true, desc: 'input_schema 工具返回 tool_use 块', impact: 'Claude Code 无法读写文件、执行命令。' },
      { id: 'tool_result', name: '工具结果回放', key: true, desc: 'tool_result 块能把结果交回模型', impact: '工具循环断在第二轮，模型看不到结果。' },
      { id: 'system_param', name: 'system 系统参数', key: true, desc: '顶层 system 被模型采纳', impact: '角色设定和规则全丢，指令遵循崩坏。' },
      { id: 'sse_events', name: '原生 SSE 事件', key: true, desc: 'message_start → content_block_delta → message_stop', impact: '流式客户端等不到事件，界面卡住或报协议错。' },
      { id: 'stop_reason', name: 'stop_reason', key: true, desc: '返回 end_turn / max_tokens / tool_use', impact: '上层分不清「说完了」还是「要调工具」还是「被截断」。' },
      { id: 'content_blocks', name: 'content 块数组', desc: '响应 content 是 text / tool_use 块数组', impact: '按块解析的客户端取不到内容。' },
      { id: 'tool_choice', name: '强制 tool_choice', desc: 'tool_choice={type:tool} 时必须调用', impact: '不能强制某步必须调工具。' },
      { id: 'usage', name: 'usage 计量', desc: '返回 input_tokens / output_tokens 且与实际相符', impact: '花费核算失真；长文下可能严重偏低。' },
      { id: 'thinking', name: 'thinking 扩展思考', desc: '接受 thinking 参数并回 thinking 块', impact: '没有可见思考过程，复杂任务质量下降，降智排查没依据。' },
      { id: 'vision', name: '图片输入', desc: 'image 块能读懂图片内容', impact: '看不了截图。' },
      { id: 'stop_sequences', name: 'stop_sequences', desc: '命中即停', impact: '输出越过边界污染下游。' },
      { id: 'max_tokens', name: '截断信号', desc: 'max_tokens 用完时 stop_reason=max_tokens', impact: '不知道被截断，长文件改一半。' },
      { id: 'multi_turn', name: '多轮上下文', desc: 'assistant/user 交替历史能复述前文', impact: '每轮失忆。' },
      { id: 'long_context', name: '长上下文', desc: '约 2 万字符输入里仍能捞出开头埋的信息', impact: '长文读不全。' },
      { id: 'json_via_tool', name: '结构化输出兜底', desc: '无原生 json_schema，靠强制 tool_use 拿结构化结果', impact: '程序化取结构化数据只能靠提示词祈祷。' },
    ],
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini generateContent',
    short: 'Gemini',
    path: '/v1beta/models',
    note: 'Google 原生协议；中转站常把它映射到 Chat，高级参数容易丢。',
    capabilities: [
      { id: 'function_call', name: '函数调用 functionCall', key: true, desc: 'functionDeclarations 返回 functionCall part', impact: 'Gemini 客户端无法调用工具。' },
      { id: 'function_response', name: '函数结果回放', key: true, desc: 'functionResponse 能把结果交回模型', impact: '工具循环断掉。' },
      { id: 'system_instruction', name: 'systemInstruction', key: true, desc: 'systemInstruction 被模型采纳', impact: '角色设定丢失。' },
      { id: 'sse_stream', name: '流式 alt=sse', key: true, desc: 'streamGenerateContent?alt=sse 逐块返回', impact: '只能等整段返回。' },
      { id: 'response_schema', name: '结构化 responseSchema', key: true, desc: 'responseMimeType+responseSchema 生效，返回纯 JSON', impact: '返回会带 ``` 围栏或多余解释，JSON.parse 直接失败。' },
      { id: 'basic', name: '基础对话', desc: 'generateContent 返回 candidates[0].content.parts', impact: '协议根本不可用。' },
      { id: 'function_config', name: '强制 functionCallingConfig', desc: 'mode=ANY 时必定调用工具', impact: '不能强制调工具。' },
      { id: 'max_output_tokens', name: '截断信号', desc: 'maxOutputTokens 用完时 finishReason=MAX_TOKENS', impact: '不知道被截断。' },
      { id: 'stop_sequences', name: 'stopSequences', desc: '命中即停', impact: '输出越界。' },
      { id: 'vision', name: '图片 inlineData', desc: 'inlineData 能读懂图片内容', impact: '看不了截图。' },
      { id: 'usage', name: 'usageMetadata', desc: 'promptTokenCount / candidatesTokenCount 非零', impact: '花费核算失真。' },
      { id: 'multi_turn', name: '多轮上下文', desc: 'role=user/model 交替历史能复述前文', impact: '每轮失忆。' },
      { id: 'thinking', name: 'thinkingConfig', desc: 'includeThoughts 能拿到 thought part', impact: '看不到思考过程。' },
      { id: 'long_context', name: '长上下文', desc: '约 2 万字符输入里仍能捞出开头埋的信息', impact: '长文读不全。' },
    ],
  },
}

export const PROTOCOL_ORDER = ['chat', 'responses', 'anthropic', 'gemini']

/**
 * 检测模式。
 *   lite —— 只测关键项（key:true），一个协议 5 项，适合「先看这站能不能用来干活」；
 *   full —— 全部测一遍，适合「彻查这个站到底能干到什么程度」。
 */
export const PROBE_MODES = {
  lite: {
    id: 'lite',
    label: '轻量',
    desc: '每个协议只测 5 项关键能力，约 20 个请求，几十秒内看完「能不能干活」。',
  },
  full: {
    id: 'full',
    label: '全量',
    desc: '每个协议全部能力逐项验证，约 60 个请求，适合彻底摸清一个站。',
  },
}

/** 这次要测哪些能力。lite 只取 key 项。 */
export function capabilitiesFor(protocolId, mode = 'full') {
  const all = PROTOCOLS[protocolId]?.capabilities || []
  return mode === 'lite' ? all.filter((cap) => cap.key) : all
}

/** 一次检测跑几遍：跑多遍才能区分「真没有」和「偶发」。 */
export const REPEAT_OPTIONS = [
  { value: 1, label: '单次', hint: '快，但偶发失败会被当成真的缺失，结论可能不确切。' },
  { value: 3, label: '三次', hint: '同一项跑三遍，三遍都过才算过、都挂才算挂，中间态标「不稳定」。推荐。' },
]

/**
 * 谁在用这条协议，以及它最少需要哪几项。
 *
 * 判定方式：拿实测通过的 id 集合和 requires 求交集，缺一项就算「不完全适配」。
 * 这里只写经过验证的结论（tools/need 全部有出处），不写猜测。
 */
export const CONSUMERS = [
  {
    id: 'pi-chat',
    name: 'pi / OpenAI 兼容客户端',
    protocol: 'chat',
    requires: ['system_prompt', 'tools', 'tool_result', 'max_tokens'],
    good: 'pi 走 openai-completions 原生，日常最稳的一条路。',
    bad: '缺关键项时 pi 会退化：不调工具、或调了接不住结果，表现为「只聊天不动手」。',
  },
  {
    id: 'codex',
    name: 'Codex',
    protocol: 'responses',
    requires: ['instructions', 'tools_function', 'tool_result', 'previous_response_id', 'incomplete'],
    good: '协议对上了，Codex 才能正常读文件、打补丁、跑命令。',
    bad: 'Codex 0.165 起只认 wire_api="responses"，配 chat 直接拒绝启动；responses 缺关键项则表现为失忆、静默截断、反复重试同一工具，长任务越跑越慢直到超时。',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    protocol: 'anthropic',
    requires: ['system_param', 'tools', 'tool_result', 'sse_events', 'stop_reason'],
    good: 'Claude Code 的正门，工具循环和流式都靠这套。',
    bad: '缺关键项会出现工具调用不执行、流式卡住、或分不清「说完了」还是「要调工具」，表现为任务中途停住。',
  },
  {
    id: 'gemini-sdk',
    name: 'Gemini SDK / Google 生态客户端',
    protocol: 'gemini',
    requires: ['function_call', 'function_response', 'system_instruction'],
    good: '原生 SDK 直接可用，结构化输出和工具都在。',
    bad: '缺关键项时工具调用不生效，官方 SDK 可能直接解析异常。',
  },
]

/** 按 id 找一条能力（跨协议）。 */
export function findCapability(protocolId, capabilityId) {
  return (PROTOCOLS[protocolId]?.capabilities || []).find((cap) => cap.id === capabilityId) || null
}
