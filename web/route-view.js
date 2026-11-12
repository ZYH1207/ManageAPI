/**
 * 路由页：实时看网关「正在做什么决定」。
 *
 * 对标 Magpie 的路由页——左边是客户端，中间是网关，右边是当前在答的那个站，
 * 有多个候选时右边摊开多条线路，每条线路随着真实请求点亮/熄灭/变红。
 *
 * ## 数据从哪来
 *
 * `GET /api/activity/stream`（SSE，daemon/server.js 的 pushActivity）：
 *    recv    —— 收到一次客户端请求（谁、要什么模型、流式还是非流式）
 *    pick    —— 选路完成（自动路由 / 直接点名；挑中的站、候选条数、依据）
 *    attempt —— 正在打某个供给（第几轮）
 *    ok/fail —— 这一轮的结果（耗时、错误原因）
 *
 * ## 为什么自己管一份 run 状态，而不是直接画帧流
 *
 * SSE 是一帧一件事，而图上要的是「这一单现在长什么样」。所以按 requestKey
 * 把帧归并成一单（run），run 结束时留在列表里当历史。帧本身不留——留帧会
 * 无限增长，而画图只需要最新状态。
 *
 * ## 为什么断开要自动重连
 *
 * 面板常年开着，SSE 会被休眠/代理/重启掐掉。静默断线比报错更糟：界面还亮着
 * 但数据停了，用户会以为「网关没在干活」。所以定时重连 + 明确显示连接状态。
 */

/**
 * 依赖由调用方注入（和 free-relay.js / free-platform.js 同一约定）：
 * 这里不读 app.js 的全局 state，也不 import 它，Node 里能直接跑一遍看 HTML。
 *
 * @type {{state:object, t:Function, esc:Function, icon:Function, $:Function}}
 */
let deps = null

/** @param {{state:object, t:Function, esc:Function, icon:Function, $:Function}} d */
export function bindRouteView(d) {
  deps = d
}

/** 连接状态：'live' | 'reconnecting' | 'off' */
let routeConnState = 'off'
/** 最近的 run（新的在前）。每个 run 是一单请求的生命周期 */
let routeRuns = []
/** 正在进行的 run，key → run */
const routeActive = new Map()
/** 展开一个组（app.js 的事件处理器调用） */
export function expandGroup(id) {
  expandedGroups.add(id)
}

/** 收起一个组 */
export function collapseGroup(id) {
  expandedGroups.delete(id)
}

/**
 * 哪些路由组是展开的。
 *
 * 用户 2026-11-02：「它那个如果点完保存就可以缩上去，变成一个小组。
 * 你这个一直是默认大卡片、大网页。」
 *
 * 所以默认全部收起，只显示一行摘要（名称/成员数/路由方式/生效态）；
 * 点「设置」才展开完整表单；改完点「保存并收起」缩回去。
 */
const expandedGroups = new Set()

let routeSource = null
let routeReconnectTimer = null

/** 单次请求在图上的留存上限（历史列表用） */
const ROUTE_RUN_MAX = 40

/** 一单的唯一键：没有 requestId 时用 seq 兜底 */
function routeRunKey(frame) {
  return frame.requestId || `r${frame.seq}`
}

/**
 * 把一帧并进它所属的 run。
 *
 * 归并规则刻意「只看 seq 顺序」：SSE 是有序的，同一单的 recv 必定先到。
 * 用 requestId 优先，没有就挂在最近一个「还在跑」的 run 上——这样即使服务端
 * 将来不传 requestId，图也不会散架（最坏情况是并发的两单合成一个，图仍然可读）。
 */
function routeApplyFrame(frame) {
  if (!frame || !frame.phase) return
  let key = routeRunKey(frame)
  let run = routeActive.get(key)

  if (frame.phase === 'recv') {
    run = {
      key,
      startedAt: frame.at || new Date().toISOString(),
      client: frame.client || '—',
      model: frame.model || '—',
      pool: frame.pool || 'paid',
      stream: Boolean(frame.stream),
      pick: null,
      attempts: [],
      outcome: null,
    }
    routeActive.set(key, run)
    routeRuns.unshift(run)
    if (routeRuns.length > ROUTE_RUN_MAX) {
      // 被挤掉的多半是已经结束的；仍在跑的绝不丢
      const keep = routeRuns.filter((r) => !r.outcome)
      const drop = routeRuns.filter((r) => r.outcome).slice(ROUTE_RUN_MAX - keep.length)
      routeRuns = [...keep, ...drop].sort(
        (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      )
    }
    return
  }

  // 非 recv：挂到最近的活跃 run 上（正常情况下 key 能直接命中）
  if (!run) {
    const fallback = [...routeActive.values()].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    )[0]
    run = fallback
    if (!run) return
    key = run.key
  }

  if (frame.phase === 'pick') {
    run.pick = frame
    return
  }
  if (frame.phase === 'attempt') {
    run.attempts.push({
      n: frame.tries || run.attempts.length + 1,
      provider: frame.provider || '—',
      offerId: frame.offerId || null,
      model: frame.model || null,
      state: 'running',
      ms: null,
      error: null,
      at: frame.at,
    })
    return
  }
  if (frame.phase === 'ok' || frame.phase === 'fail') {
    // 落到「最后一个还在跑的那次尝试」上；没有就补一条
    const cur = [...run.attempts].reverse().find((a) => a.state === 'running')
    const target =
      cur ||
      (() => {
        const made = {
          n: run.attempts.length + 1,
          provider: frame.provider || '—',
          offerId: frame.offerId || null,
          model: frame.model || null,
          state: 'running',
          ms: null,
          error: null,
        }
        run.attempts.push(made)
        return made
      })()
    target.provider = frame.provider || target.provider
    target.state = frame.phase === 'ok' ? 'ok' : 'fail'
    target.ms = frame.ms ?? null
    target.error = frame.error || null
    if (frame.phase === 'ok') {
      run.outcome = 'ok'
      routeActive.delete(key)
    }
    return
  }
}

/** 连上活动流。重复调用是安全的（旧的会先关掉） */
export function routeConnect() {
  if (typeof EventSource === 'undefined') {
    routeConnState = 'off'
    return
  }
  // 已经连着就别重建：render() 每轮都调这里，重建等于每次刷新都断一次流
  if (routeSource && routeConnState === 'live') return
  if (routeSource) {
    try {
      routeSource.close()
    } catch {
      /* 已经关了 */
    }
    routeSource = null
  }
  clearTimeout(routeReconnectTimer)

  const es = new EventSource('/api/activity/stream')
  routeSource = es

  es.addEventListener('open', () => {
    routeConnState = 'live'
    routePaintConn()
  })

  // 首帧带历史：补上「打开页面前发生了什么」
  es.addEventListener('hello', (event) => {
    try {
      const data = JSON.parse(event.data || '{}')
      routeRuns = []
      routeActive.clear()
      for (const frame of data.items || []) routeApplyFrame(frame)
      // items 是旧→新，展示要新→旧
      routeRuns.reverse()
      routePaint()
    } catch {
      /* 首帧解析失败不影响后续帧 */
    }
  })

  es.addEventListener('message', (event) => {
    try {
      routeApplyFrame(JSON.parse(event.data || '{}'))
      routePaint()
    } catch {
      /* 单帧坏了丢掉，不能让整页崩 */
    }
  })

  const reconnect = () => {
    if (routeSource !== es) return
    try {
      es.close()
    } catch {
      /* ignore */
    }
    routeSource = null
    routeConnState = 'reconnecting'
    routePaintConn()
    // 3 秒后重连；这里不指数退避——本地网关重启通常几秒，退避反而让图空着更久
    routeReconnectTimer = setTimeout(routeConnect, 3000)
  }
  es.addEventListener('error', reconnect)
}

/** ISO 时间戳 → 当天 HH:MM:SS。给「最近的路由」行用：只有模型和结果没有时间，
 * 连着来几单一样的就分不清先后。解析不了就原样给空串，不编一个 0 点出来。 */
function routeClock(iso) {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 离开路由页时断开，别让后台一直挂着一条连接 */
export function routeDisconnect() {
  clearTimeout(routeReconnectTimer)
  if (routeSource) {
    try {
      routeSource.close()
    } catch {
      /* ignore */
    }
    routeSource = null
  }
  routeConnState = 'off'
}

function routePaintConn() {
  const el = deps.$('#route-conn')
  if (!el) return
  const map = {
    live: { cls: 'route-conn-live', text: deps.t('实时') },
    reconnecting: { cls: 'route-conn-warn', text: deps.t('重连中…') },
    off: { cls: '', text: deps.t('未连接') },
  }
  const info = map[routeConnState] || map.off
  el.className = `route-conn ${info.cls}`
  el.textContent = info.text
}

/** 一个 run 现在到底在干什么，一句话 */
function routeRunPhaseText(run) {
  if (run.outcome === 'ok') return deps.t('已回答')
  const running = run.attempts.find((a) => a.state === 'running')
  if (running) return deps.t('正在请求 {name}…', { name: running.provider })
  const failed = run.attempts.filter((a) => a.state === 'fail').length
  if (failed) return deps.t('第 {n} 次失败，换下一条', { n: failed })
  return deps.t('排队中')
}

/** 一个 run 当前应该点亮的线路（provider 名 + 状态） */
function routeRunLines(run) {
  const lines = run.attempts.map((a) => ({
    provider: a.provider,
    offerId: a.offerId,
    state: a.state,
    ms: a.ms,
    error: a.error,
    n: a.n,
  }))
  // 还没 attempt 的有 pick：先把「打算打谁」画出来（灰色待定）
  if (lines.length === 0 && run.pick?.provider) {
    lines.push({
      provider: run.pick.provider,
      offerId: run.pick.offerId,
      state: 'pending',
      ms: null,
      error: null,
      n: 1,
    })
  }
  return lines
}

/**
 * 线路颜色：
 *   running  —— 亮（正在走这一条）
 *   ok       —— 绿
 *   fail     —— 红
 *   pending  —— 灰虚线（选好了但还没发出去）
 */
function routeLineClass(state) {
  return `route-line route-line-${state}`
}

/** 画一行 run 的详情（最近一单用文字说清「怎么路由的」） */
function routeRunExplain(run) {
  const bits = []
  if (run.pick) {
    if (run.pick.mode === 'auto') {
      bits.push(
        deps.t('自动路由接管：请求的是 {req}，改派 {picked}（原因 {reason}）', {
          req: run.pick.requested || run.model,
          picked: run.pick.picked || '—',
          reason: run.pick.reason || '—',
        }),
      )
      if (run.pick.switched) {
        bits.push(
          deps.t('从 {from} 切过来', { from: run.pick.switchedFrom || deps.t('上一个') }),
        )
      }
    } else {
      bits.push(
        deps.t('按客户端点名派活：{model}（候选 {n} 条）', {
          model: run.pick.picked || run.model,
          n: run.pick.candidates ?? '—',
        }),
      )
    }
    if (run.pick.basis === 'real') bits.push(deps.t('排序依据：真实首字'))
    else if (run.pick.basis === 'probe') bits.push(deps.t('排序依据：探针首字'))
  }
  for (const a of run.attempts) {
    if (a.state === 'fail') {
      bits.push(
        deps.t('第 {n} 次 {p} 失败：{e}', {
          n: a.n,
          p: a.provider,
          e: (a.error || deps.t('未知')).slice(0, 80),
        }),
      )
    }
  }
  if (run.outcome === 'ok') {
    const ok = [...run.attempts].reverse().find((a) => a.state === 'ok')
    if (ok) bits.push(deps.t('{p} 用了 {ms}ms 答完', { p: ok.provider, ms: ok.ms ?? '—' }))
  }
  return bits
}

/** 主绘制 */
export function routePaint() {
  const view = deps.$('#view-route')
  if (!view) return

  if (deps.state.providers.length === 0) {
    view.innerHTML = `
      <div class="empty">
        <h3>${deps.t('还没有站点')}</h3>
        <p>${deps.t('先添加站点并同步模型，这里会实时显示网关怎么派活。')}</p>
        <button class="primary" data-act="add-provider">${deps.icon('plus')}${deps.t('新增站点')}</button>
      </div>`
    return
  }

  const latest = routeRuns[0] || null
  const others = routeRuns.slice(1, 12)
  const gw = deps.state.gateway || {}
  const auto = deps.state.autoRoute || {}

  view.innerHTML = `
    <div class="route-head">
      <div class="route-head-left">
        <h2>${deps.t('路由')} <span id="route-conn" class="badge">${deps.t('未连接')}</span></h2>
        <p class="sub">${deps.t('网关正在做的决定。每来一次请求，这里会实时点亮它走的线路。')}</p>
      </div>
      <div class="route-head-right">
        <span class="badge ${auto.enabled ? 'ok' : ''}">${deps.t('自动路由')}${auto.enabled ? deps.t('开') : deps.t('关')}</span>
        ${auto.enabled && auto.modelKey ? `<span class="badge">${deps.t('现役')} ${deps.esc(auto.modelKey)}</span>` : ''}
        <span class="badge ${gw.enabled ? 'ok' : ''}">${deps.t('网关')}${gw.enabled ? deps.t('运行中') : deps.t('已关闭')}</span>
      </div>
    </div>

    ${latest ? routeDiagramHtml(latest) : `
      <div class="route-stage">
        <div class="route-idle">
          <svg class="route-idle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="5" cy="6" r="2.5"/><circle cx="19" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/>
            <path d="M7.5 6h9"/><path d="M5 8.5v4a3 3 0 0 0 3 3h2"/><path d="M19 8.5v4a3 3 0 0 1-3 3h-2"/>
          </svg>
          <p>${deps.t('还没有请求进来')}</p>
          <p class="sub">${deps.t('客户端一调网关，这里就会实时点亮它走的线路。')}</p>
          <p class="sub" style="margin-top:14px">${deps.t('网关地址')}：<code>http://127.0.0.1:${gw.port || 4319}/v1</code></p>
          <p class="sub">${deps.t('支持 /v1/chat/completions、/v1/responses、/v1/messages（Claude Code 直连）')}</p>
        </div>
      </div>`}

    ${latest ? `
      <div class="route-explain">
        <h3>${deps.t('这一单是怎么路由的')}</h3>
        <ul class="route-explain-list">
          <li>${deps.t('客户端')}：<b>${deps.esc(latest.client)}</b> · ${deps.t('要的是')} <code>${deps.esc(latest.model)}</code> · ${latest.stream ? deps.t('流式') : deps.t('非流式')} · ${latest.pool === 'free' ? deps.t('免费池') : deps.t('付费池')}</li>
          ${routeRunExplain(latest).map((x) => `<li>${deps.esc(x)}</li>`).join('')}
          ${latest.attempts.length === 0 ? `<li class="sub">${deps.t('正在选路…')}</li>` : ''}
        </ul>
      </div>` : ''}

    ${others.length ? `
      <div class="route-history">
        <h3>${deps.t('最近的路由')}</h3>
        <div class="route-history-rows">
          ${others
            .map((run) => {
              const ok = run.outcome === 'ok'
              const tried = run.attempts.length
              return `<div class="route-history-row">
                <span class="dot ${ok ? 'ok' : run.outcome ? 'bad' : 'warn'}"></span>
                <span class="route-h-time">${deps.esc(routeClock(run.startedAt))}</span>
                <span class="route-h-client" title="${deps.esc(run.client)}">${deps.esc(run.client)}</span>
                <span class="route-h-model"><code>${deps.esc(run.model)}</code></span>
                <span class="route-h-tries">${tried}${deps.t('次尝试')}</span>
                <span class="route-h-state">${deps.esc(routeRunPhaseText(run))}</span>
              </div>`
            })
            .join('')}
        </div>
      </div>` : ''}

    ${routeGroupsHtml()}
  `

  routePaintConn()
  // 量布局要在下一帧：innerHTML 刚写完，本帧的 reflow 还没发生
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(routeLayoutFix)
  } else {
    routeLayoutFix()
  }
}

/**
 * 线路图。左：客户端；中：网关；右：这一单碰过的所有站（纵向排列，线路连过去）。
 *
 * 为什么用 SVG 而不是纯 CSS：多条线要避免交叉、还要跟着行数伸展，
 * 一个 path 比一堆绝对定位的 div 好算得多。
 */
function routeDiagramHtml(run) {
  const lines = routeRunLines(run)
  // 行高：单条时给足空间显得从容，多条时收紧但保持可读
  const rowH = lines.length <= 1 ? 64 : lines.length <= 3 ? 58 : 52
  const boxH = 44
  const stageH = Math.max(120, lines.length * rowH + 32)
  // viewBox 用固定坐标，靠 preserveAspectRatio="none" 拉伸——但在流式布局里
  // 拉伸会扭曲曲线，所以改成 100% 宽 + 像素坐标随容器算。
  const gwCenterY = stageH / 2

  // 曲线坐标不写死：按 CSS 里的实际布局比例算（viewBox 宽度 700 对应
  // 客户端 148 + 左间距 88 + 网关 132 + 右间距 36 + 站点区剩下的部分）。
  //
  // 这里用百分比换算而不是直接量 DOM——渲染函数是纯字符串拼接，
  // 拿不到布局；但布局的规则是固定的（见 style.css 的 .route-node*），
  // 所以按同一套数字算不会漂。
  const VB_W = 700
  const LEFT_PAD = 148 // 客户端宽
  const GAP1 = 88      // 客户端→网关
  const GW_W = 132     // 网关宽
  const GAP2 = 36      // 网关→站点
  const clientRight = LEFT_PAD
  const gwLeft = LEFT_PAD + GAP1
  const gwRight = gwLeft + GW_W
  const boxLeft = gwRight + GAP2

  // 客户端 → 网关：一条平直略弯的线
  const inPath = `M ${clientRight} ${gwCenterY} C ${clientRight + GAP1 * 0.45} ${gwCenterY}, ${gwLeft - GAP1 * 0.3} ${gwCenterY}, ${gwLeft} ${gwCenterY}`

  const outPaths = lines
    .map((line, index) => {
      const y = 16 + index * rowH + boxH / 2
      const cls = routeLineClass(line.state)
      // 网关 → 各站：先平推一段再柔和地弯到目标行（Magpie 那种 S 形）
      const mid = gwRight + (boxLeft - gwRight) * 0.55
      const d = `M ${gwRight} ${gwCenterY} C ${mid} ${gwCenterY}, ${mid} ${y}, ${boxLeft} ${y}`
      return `<path class="${cls}" d="${d}"/>`
    })
    .join('')

  const boxes = lines
    .map((line, index) => {
      const y = 16 + index * rowH
      const label =
        line.state === 'running'
          ? deps.t('请求中…')
          : line.state === 'ok'
            ? deps.t('答完了') + (line.ms != null ? ` · ${line.ms}ms` : '')
            : line.state === 'fail'
              ? deps.t('失败') + (line.ms != null ? ` · ${line.ms}ms` : '')
              : deps.t('待发')
      const err =
        line.state === 'fail' && line.error
          ? `<div class="route-box-err" title="${deps.esc(line.error)}">${deps.esc(String(line.error).slice(0, 52))}</div>`
          : ''
      return `<div class="route-box route-box-${line.state}" style="top:${y}px;height:${boxH}px">
        <div class="route-box-name"><span class="route-dot"></span>${deps.esc(line.provider)}</div>
        <div class="route-box-state">${deps.esc(label)}</div>
        ${err}
      </div>`
    })
    .join('')

  const anyRunning = lines.some((l) => l.state === 'running')
  const port = (deps.state.gateway && deps.state.gateway.port) || 4319

  return `
    <div class="route-stage">
      <div class="route-diagram" style="height:${stageH}px">
        <div class="route-node route-node-client" style="align-self:center">
          <div class="route-node-title">${deps.esc(run.client)}</div>
          <div class="route-node-sub"><code>${deps.esc(run.model)}</code></div>
        </div>
        <svg class="route-svg" data-route-svg="1">
          <path class="route-line route-line-in" data-route-in="1"/>
          ${outPaths.replace('<path class="', '<path data-route-out="1" class="')}
        </svg>
        <div class="route-node route-node-gateway${anyRunning ? ' is-active' : ''}" style="align-self:center">
          <span class="route-node-ripple"></span>
          <div class="route-node-title">${deps.t('网关')}</div>
          <div class="route-node-sub">127.0.0.1:${port}</div>
          <div class="route-node-badge">${run.pick?.mode === 'auto' ? deps.t('接管') : deps.t('直派')}</div>
        </div>
        <div class="route-boxes" style="height:${stageH}px">${boxes}</div>
      </div>
    </div>`
}

/**
 * 把 SVG 曲线对齐到真实布局。
 *
 * 为什么必须测量而不能算：左边是固定 px（客户端 148 + 间距 + 网关 132 + 间距），
 * 右边站点区是 flex 撑开的，宽度取决于窗口。用 viewBox 拉伸会让左侧的
 * 固定 px 节点和曲线对不上（曲线被等比缩放，节点没有）。
 * 所以 SVG 不用 viewBox（用户单位 = CSS px），画完量一次再写 d。
 *
 * 代价是每次重绘要读一次布局（一次 reflow）——路由页只在有帧来时重绘，
 * 频率远低于其他页面的轮询，可以接受。
 */
function routeLayoutFix() {
  const stage = deps.$('#view-route .route-stage')
  if (!stage) return
  const svg = stage.querySelector('svg[data-route-svg]')
  const client = stage.querySelector('.route-node-client')
  const gw = stage.querySelector('.route-node-gateway')
  const boxes = stage.querySelector('.route-boxes')
  if (!svg || !client || !gw || !boxes) return

  const base = stage.getBoundingClientRect()
  const rel = (el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left - base.left, right: r.right - base.left, midY: r.top - base.top + r.height / 2 }
  }
  const c = rel(client)
  const g = rel(gw)
  const b = rel(boxes)
  const gwY = g.midY

  // 客户端 → 网关
  const inPath = svg.querySelector('[data-route-in]')
  if (inPath) {
    const x1 = c.right
    const x2 = g.left
    const dx = x2 - x1
    inPath.setAttribute(
      'd',
      `M ${x1} ${gwY} C ${x1 + dx * 0.45} ${gwY}, ${x2 - dx * 0.28} ${gwY}, ${x2} ${gwY}`,
    )
  }

  // 网关 → 每个站点卡片
  const outPaths = svg.querySelectorAll('[data-route-out]')
  const boxEls = boxes.querySelectorAll('.route-box')
  outPaths.forEach((path, index) => {
    const box = boxEls[index]
    if (!box) return
    const br = box.getBoundingClientRect()
    const y = br.top - base.top + br.height / 2
    const x1 = g.right
    const x2 = b.left
    const mid = x1 + (x2 - x1) * 0.55
    path.setAttribute('d', `M ${x1} ${gwY} C ${mid} ${gwY}, ${mid} ${y}, ${x2} ${y}`)
  })

  // svg 本身铺满 stage，尺寸用属性写死避免第二次 reflow
  svg.setAttribute('width', String(Math.round(base.width)))
  svg.setAttribute('height', String(Math.round(base.height)))
}


/**
 * 路由组（页面最下方）——学 Magpie 的编制区。
 *
 * 用户 2026-11-02：「路由组那个页面，直接在路由页面里就可以。因为 Magpie 也是
 * 这么做的：最上面是正在进行的路由，中间是数据，最下面是编制路由组。」
 *
 * 一个组 = 一组模型 + 组级算法。点「启用」后自动路由只在这个组的模型里挑，
 * 按这个组的算法排序。不启用任何组 = 回到全场。
 */
function routeGroupsHtml() {
  const rg = deps.state.routeGroups || {}
  const groups = Array.isArray(rg.groups) ? rg.groups : []
  const algos = Array.isArray(rg.algos) ? rg.algos : []
  const opts = rg.options || {}
  const activeId = rg.activeId || null
  const active = rg.active || null
  const models = availableModels()

  return `
    <div class="route-groups">
      <div class="route-groups-head">
        <h3>${deps.t('路由组')}</h3>
        <span class="route-groups-note">${
          active
            ? deps.t('当前按「{name}」路由：{n} 个模型', { name: active.name, n: active.models.length })
            : deps.t('没有启用路由组——自动路由在全场所有模型里挑')
        }</span>
        <button class="route-group-new" data-act="rg-new">${deps.icon('plus')}${deps.t('新建组')}</button>
      </div>

      ${groups.length === 0 ? `<div class="route-groups-empty">${deps.t('还没有路由组。新建一个组，勾几个模型，再选这套路由用哪种算法。')}</div>` : `
      <div class="route-group-list">
        ${groups.map((g) => routeGroupCard(g, algos, opts, models, activeId === g.id)).join('')}
      </div>`}
    </div>`
}

/**
 * 一个组的完整编辑卡（对标 Magpie 的路由组设置页）。
 *
 * Magpie 那一页有的项，这里一一对应：
 *   名称 / 成员列表（可上下移、移除、+ 添加）/ 模式匹配 / 模型列表展示 /
 *   路由方式 / 迟迟不出字 / 成员全都忙 / 上下文 / 会话保持 / 推理强度 / 推理档位
 *
 * 「规则」那一项（+ 添加规则）暂不做：它是 Magpie 自己的条件表达式引擎
 * （按 token 数/时间/模型切换路由），本项目没有对应能力，硬做一个空壳
 * 只会让人以为能用。等真有需求再补，不假装。
 */
function routeGroupCard(g, algos, opts, models, isActive) {
  const expanded = expandedGroups.has(g.id)
  const algoDef = algos.find((a) => a.key === g.algo) || {}
  const memberCount = (g.models || []).length

  const seg = (list, current, act, extra = {}) =>
    list
      .map((o) => {
        const data = Object.entries({ ...extra, [act]: o.key })
          .map(([k, v]) => `data-${k}="${deps.esc(String(v))}"`)
          .join(' ')
        return `<button class="rg-seg${o.key === current ? ' active' : ''}" data-act="${act}" ${data}
          title="${deps.esc(o.desc || o.hint || o.label)}">${deps.esc(o.label)}</button>`
      })
      .join('')

  const row = (label, hint, body) => `
    <div class="rg-row">
      <div class="rg-row-label">${deps.t(label)}</div>
      <div class="rg-row-body">${body}${hint ? `<div class="rg-row-hint">${deps.t(hint)}</div>` : ''}</div>
    </div>`

  // ── 收起态：一行摘要 ────────────────────────────────────────────
  const summary = `
    <div class="rg-summary">
      <span class="rg-summary-name">${deps.esc(g.name)}</span>
      <span class="rg-summary-meta">${deps.t('{n} 个模型', { n: memberCount })}</span>
      <span class="rg-summary-algo">${deps.esc(algoDef.label || g.algo)}</span>
      ${isActive ? `<span class="route-group-badge on">${deps.t('生效中')}</span>` : ''}
    </div>`

  // ── 收起态的头部动作 ────────────────────────────────────────────
  const headActions = `
    <button class="rg-expand" data-act="rg-expand" data-id="${deps.esc(g.id)}">
      ${expanded ? deps.t('收起') : deps.t('设置')}
      <span class="rg-caret${expanded ? ' open' : ''}">▾</span>
    </button>
    ${isActive
      ? `<button class="route-group-use off" data-act="rg-use" data-id="${deps.esc(g.id)}">${deps.t('停用')}</button>`
      : `<button class="route-group-use" data-act="rg-use" data-id="${deps.esc(g.id)}">${deps.t('启用')}</button>`}
    <button class="route-group-del" data-act="rg-del" data-id="${deps.esc(g.id)}"
      title="${deps.t('删除这个组')}">${deps.icon('x')}</button>`

  return `
    <div class="route-group-card${isActive ? ' active' : ''}${expanded ? ' expanded' : ''}" data-rg="${deps.esc(g.id)}">
      <div class="route-group-top">
        ${summary}
        <span class="rg-top-actions">${headActions}</span>
      </div>

      ${expanded ? `
      <div class="rg-settings">
        ${row('名称', '', `<input class="route-group-name rg-name-full" value="${deps.esc(g.name)}"
          data-rg-name="${deps.esc(g.id)}" />`)}

        ${row('模型', '排第一的模型决定本组对外的能力；按顺序模式下从上往下尝试。', `
          <div class="rg-members">
            ${(g.models || []).length === 0
              ? `<span class="route-group-hint">${deps.t('还没有成员——点下面的「添加模型」')}</span>`
              : (g.models || []).map((m, i) => `
                <span class="rg-member">
                  <span class="rg-member-idx">${i + 1}</span>
                  <span class="rg-member-name">${deps.esc(m)}</span>
                  <button class="rg-mini" data-act="rg-up" data-id="${deps.esc(g.id)}" data-model="${deps.esc(m)}"
                    title="${deps.t('上移')}" ${i === 0 ? 'disabled' : ''}>↑</button>
                  <button class="rg-mini" data-act="rg-down" data-id="${deps.esc(g.id)}" data-model="${deps.esc(m)}"
                    title="${deps.t('下移')}" ${i === g.models.length - 1 ? 'disabled' : ''}>↓</button>
                  <button class="rg-mini danger" data-act="rg-toggle" data-id="${deps.esc(g.id)}" data-model="${deps.esc(m)}"
                    title="${deps.t('移出这个组')}">×</button>
                </span>`).join('')}
          </div>
          <select class="rg-add-model" data-act="rg-add" data-id="${deps.esc(g.id)}">
            <option value="">+ ${deps.t('添加模型')}</option>
            ${models.filter((m) => !(g.models || []).includes(m)).map((m) => `<option value="${deps.esc(m)}">${deps.esc(m)}</option>`).join('')}
          </select>`)}

        ${row('模式', '模式匹配的模型均入组（含供应商日后新增的），排在显式成员之后。* 匹配 provider/model 中任意字符，re: 开头表示正则。', `
          <div class="rg-patterns">
            ${(g.patterns || []).map((p) => `<span class="rg-pattern">${deps.esc(p)}
              <button class="rg-mini" data-act="rg-unpattern" data-id="${deps.esc(g.id)}" data-pattern="${deps.esc(p)}">×</button></span>`).join('')}
          </div>
          <input class="rg-pattern-input" placeholder="${deps.t('例如 openrouter/*:free 或 re:...')}"
            data-rg-pattern="${deps.esc(g.id)}" />`)}

        ${row('模型列表', 'Agent 的模型列表和网关 /v1/models 里怎么呈现本组。', seg(opts.modelList || [], g.modelListMode, 'rg-model-list', { id: g.id }))}

        ${row('路由方式', '', seg(algos, g.algo, 'rg-algo', { id: g.id }))}

        ${row('迟迟不出字', '成员超过这个时间仍未开始回答（无文字、思考或工具调用）时改问下一个。仅对流式请求生效。',
          seg(opts.firstToken || [], g.firstTokenMs, 'rg-first-token', { id: g.id }))}

        ${row('成员全都忙', '每个成员都失败时，隔这么久再试；关闭则立刻把最后一个错误交出去。',
          seg(opts.allBusy || [], g.allBusyMs, 'rg-all-busy', { id: g.id }))}

        ${row('上下文', '告诉 agent 本组最大/最小的上下文窗口；某个成员放不下的对话会交给放得下的成员。',
          seg(opts.context || [], g.contextMode, 'rg-context', { id: g.id }))}

        ${row('会话保持', '厂商缓存仍有价值时，会话留在回答过它的成员上。与决策页的「缓存亲和」是同一件事的两种粒度，组级这里作默认值。',
          seg(opts.sessionKeep || [], g.sessionKeep, 'rg-session-keep', { id: g.id }))}

        ${row('推理强度', '按 agent 传的值，或每轮重新判断。',
          seg(opts.effort || [], g.effort, 'rg-effort', { id: g.id }))}

        ${row('推理档位', '对 Agent 提供所有模型都有的档位（成员共有），或各自自定。',
          seg(opts.effortLevel || [], g.effortLevel, 'rg-effort-level', { id: g.id }))}

        <div class="rg-save-row">
          <button class="rg-save" data-act="rg-collapse" data-id="${deps.esc(g.id)}">${deps.t('保存并收起')}</button>
        </div>
      </div>` : ''}
    </div>`
}

/** 当前有哪些模型可选（从决策数据里取，去重） *//** 当前有哪些模型可选（从决策数据里取，去重） *//** 当前有哪些模型可选（从决策数据里取，去重） */
function availableModels() {
  const out = []
  const seen = new Set()
  for (const dec of deps.state.decisions || []) {
    const key = dec.modelKey
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out.sort()
}
