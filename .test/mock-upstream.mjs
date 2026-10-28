/**
 * 本地 mock 中转站，用来验证探针逻辑。
 * MODE=good           正常站
 * MODE=degraded       掉包站（指纹答错）+ 虚报用量
 * MODE=truncated      砍额度站（数到 40 就停）
 * MODE=noresponses    不支持 /responses（403，模拟只给 chat 的站）
 * MODE=failedstream   /responses 先开流再发 response.failed（模拟跑到一半失败）
 */
import { createServer } from 'node:http'

const MODE = process.env.MODE || 'good'
const PORT = Number(process.env.PORT || 5101)
const DELAY = Number(process.env.DELAY || 60)

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

function sse(res, deltas, { usage, finishReason }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  setTimeout(() => {
    for (const delta of deltas) {
      emit({ choices: [{ delta: { content: delta }, index: 0 }] })
    }
    emit({ choices: [{ delta: {}, index: 0, finish_reason: finishReason }] })
    if (usage) emit({ choices: [], usage })
    res.write('data: [DONE]\n\n')
    res.end()
  }, DELAY)
}

/** 缓存模拟用的内存集合：同一模型 + 同一长 prompt 的第二次请求命中。 */
const seenPrompts = new Set()

/** EMPTY_ONCE=1：只有第一个请求空，之后正常（验证补问能救回） */
const EMPTY_ONCE = process.env.EMPTY_ONCE === '1'
let emptyDropped = 0
function emptyShouldDrop() {
  if (!EMPTY_ONCE) return true
  emptyDropped += 1
  return emptyDropped === 1
}

/** Responses 协议的 SSE：按 event: 名事件发，最后一个事件带 usage。 */
function sseResponses(res, text, { usage, failMidStream = false } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const emit = (type, obj) => res.write(`event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`)
  setTimeout(() => {
    emit('response.created', {
      type: 'response.created',
      response: { id: 'resp-mock', object: 'response', status: 'in_progress', output: [] },
    })
    if (failMidStream) {
      // 已经 200 并开了流，然后才报错——这是最容易把「换站」漏掉的形态
      emit('response.failed', {
        type: 'response.failed',
        response: {
          id: 'resp-mock',
          status: 'failed',
          error: { code: 'server_error', message: 'mock mid-stream failure' },
        },
      })
      res.end()
      return
    }
    emit('response.output_item.added', {
      type: 'response.output_item.added',
      item: { type: 'message', id: 'item_mock', role: 'assistant', content: [] },
    })
    for (const chunk of [text.slice(0, 8), text.slice(8)]) {
      emit('response.output_text.delta', { type: 'response.output_text.delta', delta: chunk })
    }
    emit('response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp-mock',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'item_mock',
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          },
        ],
        usage,
      },
    })
    res.end()
  }, DELAY)
}

createServer(async (req, res) => {
  // 测试辅助：把「只空一次」的计数器归零。EMPTY_ONCE 是进程级全局，
  // 多个测试用例连着跑时前一个用例会把那一次用掉，后面的就永远遇不上空回合
  if (req.url.includes('/__reset')) {
    emptyDropped = 0
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  if (req.url.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'test-model-a' }, { id: 'test-model-b' }] }))
    return
  }

  if (req.url.includes('/responses')) {
    // 「只给 chat、不给 responses」的站：网关必须把它当成
    // protocol-unsupported（不拉低可用率）并换到下一个候选
    if (MODE === 'noresponses') {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: 'This group does not allow /v1/responses dispatch',
            type: 'permission_error',
          },
        }),
      )
      return
    }

    const body = await readBody(req)
    const inputText =
      typeof body.input === 'string'
        ? body.input
        : (body.input || [])
            .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
            .map((part) => part?.text || '')
            .join('')

    const usage = {
      input_tokens: 10,
      output_tokens: 3,
      total_tokens: 13,
      output_tokens_details: { reasoning_tokens: 0 },
    }

    if (body.stream !== true) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'resp-mock',
          object: 'response',
          model: body.model,
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'item_mock',
              role: 'assistant',
              content: [{ type: 'output_text', text: `ok: ${inputText.slice(0, 20)}` }],
            },
          ],
          usage,
        }),
      )
      return
    }

    return sseResponses(res, `ok: ${inputText.slice(0, 20)}`, {
      usage,
      failMidStream: MODE === 'failedstream',
    })
  }

  if (req.url.includes('/chat/completions')) {
    if (MODE === 'fail') {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'upstream unavailable', type: 'server_error' } }))
      return
    }

    // 方言泄漏站：工具调用没被翻译成 tool_calls，而是原样漏进了正文——
    // 这种网关能本地解析重建（见 core/tool-repair.js），不用补问。
    // 用 EMPTY_ONCE=1 控制：第一次漏、之后正常，方便对比「本地重建」与「补问」
    if (MODE === 'leak' && emptyShouldDrop()) {
      const body = await readBody(req)
      const hasTools = Array.isArray(body?.tools) && body.tools.length > 0
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      if (hasTools) {
        // 模型方言原样漏进正文：外壳 + invoke + parameter 都完整
        emit({ choices: [{ delta: { content: 'Let me read it.\n<｜DSML｜function_calls>\n' }, index: 0 }] })
        emit({
          choices: [
            {
              delta: {
                content:
                  '<｜DSML｜invoke name="read_file">\n' +
                  '<｜DSML｜parameter name="path" string="true">/tmp/leak.txt</｜DSML｜parameter>\n' +
                  '</｜DSML｜invoke>\n</｜DSML｜function_calls>',
              },
              index: 0,
            },
          ],
        })
      }
      emit({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] })
      emit({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 80, total_tokens: 980 } })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    // 空回合站：客户端带了 tools 时，只在思考里打转，正文与 tool_calls 都不给，
    // 收尾却是正常的 stop——模拟 DeepSeek 工具调用被上游翻译层吞掉的真实现场。
    // 用 EMPTY_ONCE 环境变量控制：设 1 = 只空第一次，第二次开始正常（验证补问能救回）
    if (MODE === 'empty' && emptyShouldDrop()) {
      const body = await readBody(req)
      const hasTools = Array.isArray(body?.tools) && body.tools.length > 0
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      if (hasTools) {
        // 先流一段思考（让它不算「纯空」，但正文为 0、无工具调用）
        emit({ choices: [{ delta: { reasoning_content: 'Let me check the file first...' }, index: 0 }] })
        emit({ choices: [{ delta: { reasoning_content: '</｜tool▁calls▁begin｜> (swallowed)' }, index: 0 }] })
      }
      emit({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] })
      emit({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230 } })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    const body = await readBody(req)
    const prompt = body.messages?.[0]?.content || ''

    let answer = 'ok'
    let usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
    let finishReason = 'stop'

    if (prompt.includes('7Q2K')) {
      answer = MODE === 'degraded' ? '{"fp":"XX99","calc":0}' : '{"fp":"7Q2K","calc":391}'
      const pt = MODE === 'degraded' ? 500 : 46
      usage = { prompt_tokens: pt, completion_tokens: 12, total_tokens: pt + 12 }
    } else if (prompt.includes('1 to 120')) {
      const max = MODE === 'truncated' ? 40 : 120
      answer = Array.from({ length: max }, (_, i) => i + 1).join(',')
      usage = { prompt_tokens: 30, completion_tokens: max * 2, total_tokens: 30 + max * 2 }
      finishReason = MODE === 'truncated' ? 'length' : 'stop'
    } else if (prompt.includes('What model are you')) {
      // 掉包站自报别的模型，正常站报真实名字
      answer = MODE === 'degraded' ? 'Claude 3.5 Sonnet' : 'deepseek-v4.1-flash'
    }

    // 缓存模拟：同一模型 + 同一长 prompt 的第二次请求命中
    if (prompt.length > 1000) {
      const est = Math.floor(prompt.length / 4)
      usage = { prompt_tokens: est, completion_tokens: 2, total_tokens: est + 2 }
      const cacheKey = `${body.model}::${prompt.slice(0, 60)}`
      const isRepeat = seenPrompts.has(cacheKey)
      seenPrompts.add(cacheKey)
      // 掉包站和砍额度站不支持缓存
      const supportsCache = MODE === 'good'
      const cachedTokens = isRepeat && supportsCache ? Math.floor(est * 0.95) : 0
      usage.prompt_tokens_details = { cached_tokens: cachedTokens }
    }

    if (body.stream !== true) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: finishReason }],
        usage,
      }))
      return
    }

    return sse(res, [answer.slice(0, 8), answer.slice(8)], { usage, finishReason })
  }

  res.writeHead(404).end('not found')
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock upstream [${MODE}] on http://127.0.0.1:${PORT}/v1`)
})
