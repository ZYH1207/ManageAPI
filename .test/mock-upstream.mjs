/**
 * 本地 mock 中转站，用来验证探针逻辑。
 * MODE=good      正常站
 * MODE=degraded  掉包站（指纹答错）+ 虚报用量
 * MODE=truncated 砍额度站（数到 40 就停）
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

/** 记录见过的长 prompt，用来模拟缓存命中。 */
const seenPrompts = new Set()

createServer(async (req, res) => {
  if (req.url.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'test-model-a' }, { id: 'test-model-b' }] }))
    return
  }

  if (req.url.includes('/chat/completions')) {
    if (MODE === 'fail') {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'upstream unavailable', type: 'server_error' } }))
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

    if (MODE === 'roleonly') {
      // 只吐一个 role 帧就收工：模拟「上游 200 但先吐空帧」的坏供给。
      // 新提交判据要求「有内容的帧」才 committed，所以这一站应该被判失败并换站。
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      res.write('data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n')
      setTimeout(() => res.end(), 120)
      return
    }

    return sse(res, [answer.slice(0, 8), answer.slice(8)], { usage, finishReason })
  }

  res.writeHead(404).end('not found')
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock upstream [${MODE}] on http://127.0.0.1:${PORT}/v1`)
})
