/**
 * 请求耗时细分（借鉴 Magpie 的 net 明细）。
 *
 * ## 为什么需要
 *
 * 现在只记了 `latencyMs`（总耗时）和 `ttftMs`（首字）。这导致一个问题：
 * 用户觉得「慢」的时候，分不清慢在哪 ——
 *   · 是自己的网关开销？
 *   · 是上游在思考？
 *   · 是网络/DNS/TLS？
 *   · 还是首字之后吐字慢？
 *
 * 这四种的应对完全不同：网关开销要优化代码，上游思考要换站，网络问题要看线路，
 * 吐字慢要看站的生成能力。只有一个「总耗时」数字，什么判断都做不了。
 *
 * ## Magpie 的做法与我们的取舍
 *
 * Magpie 用 Go 写，能拿到网络栈每一段（dns/connect/tls/send/wait/head/own，
 * 实测中位：wait 5614ms、own 仅 76.8ms）。Node 的 `fetch` 不暴露 DNS 和 TLS 细分。
 *
 * 但**最有价值的那一段是可以拿到的**：`wait`（等上游首字节）vs `own`（自己的开销）。
 * Magpie 的数据也说明这两段才是关键 —— 它的 own 中位只有 76.8ms，wait 是 5614ms，
 * 差 73 倍。能分开这两者，就足够回答「是我的问题还是上游的问题」。
 *
 * DNS / TCP / TLS 这一段用 `undici` 的 diagnostics channel 可以拿到（Node 20+ 内置
 * undici），但需要额外接线且会干扰连接池复用。这里先不做，留 TODO 标注清楚。
 *
 * ## 四段怎么分
 *
 *   t0  收到客户端请求
 *   t1  开始向上游发请求（t1 - t0 = own，我们自己的开销：路由决策、DB 读、拼装）
 *   t2  收到上游响应头（t2 - t1 = wait，上游思考 + 网络往返）← 最常被误认为"网点慢"
 *   t3  收到第一个内容字节（t3 - t2 = head，首包解析 + 模型开始吐字）
 *   t4  流结束（t4 - t3 = flow，生成耗时）
 *
 * 与 Magpie 的对应关系：
 *   own  ≈ 它的 own
 *   wait ≈ 它的 wait（它的 wait 是「等到首字节」，我们的含了响应头，略宽）
 *   flow ≈ 它的 flow
 *   它的 dns/connect/tls 我们暂时没有
 *
 * ## 为什么要按「阶段打点」而不是「事后算差值」
 *
 * 因为流式请求的各个阶段是异步交错的，事后只拿到总时长无法回溯分段。
 * 用 `mark()` 在每个阶段边界打一个时间戳，最后 `finish()` 一次算出全部差值。
 * 打点是 O(1) 的，热路径上开销可忽略。
 */

/**
 * 一次请求的分段计时器。
 *
 * 用法：
 *   const t = new PhaseTimer()
 *   t.mark('start')          // 收到请求
 *   t.mark('dispatch')       // 开始发上游
 *   t.mark('headers')        // 收到响应头
 *   t.mark('firstByte')      // 收到第一个内容字节
 *   t.mark('done')           // 流结束
 *   const net = t.finish()   // → { own, wait, head, flow, total, ... }
 */
export class PhaseTimer {
  #marks = new Map()
  #now

  /**
   * @param {() => number} [now] 时钟函数，测试可注入
   */
  constructor(now = () => Date.now()) {
    this.#now = now
    this.#marks.set('start', now())
  }

  /**
   * 打一个阶段时间戳。重复打同一阶段保留**第一次**（更适合「首字节」这类：
   * 后续字节的到来不该覆盖第一次的时间）。
   * @param {string} phase
   */
  mark(phase) {
    if (!this.#marks.has(phase)) this.#marks.set(phase, this.#now())
    return this
  }

  /** 取某个阶段的时间戳（没有则 null）。 */
  at(phase) {
    return this.#marks.get(phase) ?? null
  }

  /**
   * 算出分段耗时（毫秒，取整）。
   *
   * 缺失的阶段会以「上一个已知阶段」代替，保证各段加起来等于总时长 ——
   * 宁可某一段是 0（因为没测到），也不要出现「分段加起来和总数对不上」
   * 这种让人不敢信的数据。
   *
   * @returns {{
   *   own: number, wait: number, head: number, flow: number,
   *   total: number, toFirstToken: number,
   *   phases: {start:number, dispatch:number|null, headers:number|null, firstByte:number|null, done:number|null}
   * }}
   */
  finish() {
    const start = this.at('start') ?? 0
    const dispatch = this.at('dispatch')
    const headers = this.at('headers')
    const firstByte = this.at('firstByte')
    const done = this.at('done') ?? this.#now()

    // 用「上一个已知点」兜底：没打 dispatch 的点就把 own 记 0，
    // 把全部时间算到 wait 上（更保守：不虚报自己的开销小）
    const t1 = dispatch ?? start
    const t2 = headers ?? t1
    const t3 = firstByte ?? t2
    const t4 = done

    const own = Math.max(0, t1 - start)
    const wait = Math.max(0, t2 - t1)
    const head = Math.max(0, t3 - t2)
    const flow = Math.max(0, t4 - t3)

    return {
      own: Math.round(own),
      wait: Math.round(wait),
      head: Math.round(head),
      flow: Math.round(flow),
      total: Math.round(Math.max(0, t4 - start)),
      // 到首字的总时间 = own + wait + head（比单看 wait 更接近用户体感）
      toFirstToken: Math.round(Math.max(0, t3 - start)),
      phases: {
        start,
        dispatch: dispatch ?? null,
        headers: headers ?? null,
        firstByte: firstByte ?? null,
        done: done ?? null,
      },
    }
  }
}

/**
 * 从分段数据里提炼一句人话诊断。
 *
 * 用途：决策页/日志里显示「这次慢在哪」，而不是只给一堆数字。
 *
 * @param {ReturnType<PhaseTimer['finish']>} net
 * @returns {string} 空串表示没有明显异常
 */
export function diagnosePhases(net) {
  if (!net || !Number.isFinite(net.total) || net.total <= 0) return ''
  const share = (v) => (net.total > 0 ? v / net.total : 0)

  // 自己开销占比过大 = 网关自己的问题（路由决策/DB/序列化）
  if (share(net.own) > 0.3 && net.own > 500) {
    return `网关自身开销偏大（${net.own}ms，占 ${Math.round(share(net.own) * 100)}%）—— 检查路由决策与 DB 读取`
  }
  // 等上游首字节占绝大部分 = 上游在思考/排队
  if (share(net.wait) > 0.8 && net.wait > 3000) {
    return `主要耗在等上游首字节（${net.wait}ms）—— 上游在排队或思考，换站可能更快`
  }
  // 首字之后生成太慢 = 上游吐字能力差
  if (share(net.flow) > 0.8 && net.flow > 5000) {
    return `主要耗在生成阶段（${net.flow}ms）—— 首字后吐字慢，适合短回答、不适合长输出`
  }
  return ''
}

/**
 * 一次请求的开销对比：同一个站、同一个模型，近期自己开销 vs 上游耗时的中位数。
 *
 * 用来回答「我的网关是不是拖慢了」这个问题。单次数据说不清，看中位数才行。
 *
 * @param {Array<object>} samples  [{ own, wait, flow, total }]
 * @returns {{own:number|null, wait:number|null, flow:number|null, total:number|null, n:number}}
 */
export function medianPhases(samples) {
  const pick = (key) => {
    // 注意：不能直接 Number(s?.[key]) —— Number(null) 是 0、Number(undefined) 是 NaN。
    // null 会被当成「有效值 0」混进来，把中位数拉低（实测踩到）。
    // 必须先判 null/undefined 再加数值校验。
    const vals = samples
      .map((s) => s?.[key])
      .filter((v) => v !== null && v !== undefined)
      .map(Number)
      .filter((v) => Number.isFinite(v) && v >= 0)
    if (!vals.length) return null
    vals.sort((a, b) => a - b)
    const mid = Math.floor(vals.length / 2)
    return Math.round(vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2)
  }
  return {
    own: pick('own'),
    wait: pick('wait'),
    flow: pick('flow'),
    total: pick('total'),
    n: samples.length,
  }
}
