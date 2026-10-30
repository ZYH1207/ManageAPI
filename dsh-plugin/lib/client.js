// dsh-manage-api — Client 半边（手写 bundle，无构建步骤）。
//
// ## 为什么手写这个包裹
//
// 宿主契约要求 client 产物自己调用 `window.__ModuleLoader__.load({id, factory})`。
// 直接给 ESM 源码会被当经典脚本执行 → SyntaxError → client-modules 加载失败。
// 本文件不依赖任何打包器：`require` 是宿主的模块解析器，`react` 由宿主提供。
// （先例：dsh-notify-say 也是手写这一层。）
//
// ## 运行环境
//
// client 跑在沙箱渲染进程：sandbox:true / contextIsolation:true / nodeIntegration:false
// → 没有 process、读不了盘。所有数据都走 host 的 /api/manage-api/* route。
// 每一处 fetch 都必须 try/catch：任何一环失败只应"少一块内容"，绝不能让整页崩。
//
// ## 主入口
//
// 设置页常驻分区 `settings.section`（id: manage-api）。不依赖 dsh-better-sidebar。
window.__ModuleLoader__.load({
  id: 'dsh-manage-api',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react') || null
    var name = 'dsh-manage-api'
    // slots 是硬依赖：写在 inject 里，宿主会等它就绪再激活本插件，
    // 避免"激活早于 renderer 提供 slots → 设置分区永久不出现"的竞态。
    var inject = ['slots']

    // 必须与 lib/routes.js 的 PREFIX='"/api/manage-api"' 保持一致（check.mjs 有一致性断言）
    var API_PREFIX = 'manage-api'

    // ── 工具：URL / 请求 ───────────────────────────────────────────────
    //
    // ⚠️ 用 document.baseURI 解析，不写死 origin-absolute 的 `/api/...`：
    //    反向代理挂在子路径下时绝对路径会 404（本机已有先例）。
    function apiUrl(path) {
      try {
        return new URL('api/' + API_PREFIX + '/' + path, document.baseURI).toString()
      } catch (e) {
        return '/api/' + API_PREFIX + '/' + path
      }
    }

    function fetchJson(path, init) {
      var opts = { credentials: 'same-origin', headers: { accept: 'application/json' } }
      if (init) {
        for (var k in init) opts[k] = init[k]
      }
      if (opts.method && opts.method !== 'GET') {
        opts.headers = { 'content-type': 'application/json', accept: 'application/json' }
        opts.body = JSON.stringify(opts.body || {})
      }
      return fetch(apiUrl(path), opts).then(function (res) {
        return res.text().then(function (text) {
          var body = null
          try {
            body = text ? JSON.parse(text) : null
          } catch (e) {
            body = null
          }
          return {
            ok: res.ok,
            status: res.status,
            body: body,
            text: body === null ? String(text || '').slice(0, 120) : '',
          }
        })
      })
    }

    // ── 工具：格式化 ───────────────────────────────────────────────────
    function fmtInt(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '-'
      if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + ' 亿'
      if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(1) + ' 万'
      return String(Math.round(n))
    }
    function fmtMoney(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '-'
      if (n >= 100) return n.toFixed(0)
      if (n >= 1) return n.toFixed(2)
      return n.toFixed(3)
    }
    function fmtPct(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '-'
      return (n >= 0 ? '+' : '') + n.toFixed(0) + '%'
    }
    function fmtRate(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '-'
      return Math.round(n * 100) + '%'
    }
    function fmtMs(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '-'
      if (n >= 1000) return (n / 1000).toFixed(1) + 's'
      return Math.round(n) + 'ms'
    }
    function fmtTime(iso) {
      if (!iso) return '-'
      try {
        var d = new Date(iso)
        if (isNaN(d.getTime())) return String(iso)
        return d.toLocaleTimeString()
      } catch (e) {
        return String(iso)
      }
    }

    var MODE_TEXT = {
      owned: '托管中（插件启动）',
      attached: '已连接（外部实例）',
      starting: '启动中…',
      down: '未运行',
      failed: '启动失败',
    }

    // ── 样式（跟着主题 token 走；token 缺失时用中性回退色）──────────────
    var S = {
      alert: {
        border: '1px solid #6e4b0e', background: 'rgba(210,153,34,0.10)',
        borderRadius: '8px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '4px',
      },
      alertLine: { fontSize: '12px', lineHeight: 1.5 },
      pre: {
        margin: '6px 0 0', padding: '10px', borderRadius: '6px',
        background: 'var(--dsw-alias-surface-alt, rgba(128,128,128,0.10))',
        fontSize: '12px', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', maxHeight: '180px', overflow: 'auto',
      },
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0' },
      head: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 600 },
      sub: { fontSize: '12px', color: 'var(--dsw-alias-text-secondary, #8b949e)' },
      card: {
        border: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.28))',
        borderRadius: '10px',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '12px',
        padding: '2px 8px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.28))',
      },
      dot: { width: '7px', height: '7px', borderRadius: '50%', display: 'inline-block' },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontSize: '11px',
        padding: '1px 7px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.28))',
        color: 'var(--dsw-alias-text-secondary, #8b949e)',
        fontVariantNumeric: 'tabular-nums',
      },
      tabs: { display: 'flex', gap: '4px', flexWrap: 'wrap' },
      tab: {
        fontSize: '12px',
        padding: '4px 10px',
        borderRadius: '7px',
        border: '1px solid transparent',
        cursor: 'pointer',
        background: 'transparent',
        color: 'var(--dsw-alias-text-secondary, #8b949e)',
      },
      tabActive: {
        fontSize: '12px',
        padding: '4px 10px',
        borderRadius: '7px',
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.28))',
        background: 'var(--dsw-alias-bg-elevated, rgba(127,127,127,0.14))',
        color: 'var(--dsw-alias-text-primary, inherit)',
      },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '10px' },
      metric: { display: 'flex', flexDirection: 'column', gap: '2px' },
      metricLabel: { fontSize: '11px', color: 'var(--dsw-alias-text-secondary, #8b949e)' },
      metricValue: { fontSize: '16px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      row: { display: 'flex', gap: '10px', fontSize: '12px', alignItems: 'baseline', flexWrap: 'wrap' },
      kv: { color: 'var(--dsw-alias-text-secondary, #8b949e)', minWidth: '86px' },
      btn: {
        fontSize: '12px',
        padding: '4px 10px',
        borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.28))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      err: { fontSize: '12px', color: 'var(--dsw-alias-text-danger, #f85149)' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
      th: {
        textAlign: 'left',
        fontWeight: 500,
        color: 'var(--dsw-alias-text-secondary, #8b949e)',
        padding: '4px 6px',
        borderBottom: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.28))',
      },
      td: { padding: '4px 6px', borderBottom: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.14))', fontVariantNumeric: 'tabular-nums' },
    }

    function dotColor(mode) {
      if (mode === 'owned') return '#3fb950'
      if (mode === 'attached') return '#58a6ff'
      if (mode === 'starting') return '#d29922'
      return '#f85149'
    }

    // ── 数据 hook ─────────────────────────────────────────────────────
    function useManageApi(pollMs) {
      var healthState = React.useState(null)
      var health = healthState[0]
      var setHealth = healthState[1]
      var stateState = React.useState(null)
      var state = stateState[0]
      var setState = stateState[1]
      var errState = React.useState('')
      var error = errState[0]
      var setError = errState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      var load = React.useCallback(function () {
        return Promise.all([
          fetchJson('health').catch(function (e) { return { ok: false, body: { error: String(e) } } }),
          fetchJson('state').catch(function (e) { return { ok: false, body: { error: String(e) } } }),
        ]).then(function (results) {
          var h = results[0]
          var s = results[1]
          if (h && h.body) setHealth(h.body)
          if (s && s.body) {
            if (s.body.ok) { setState(s.body); setError('') } else { setState(s.body); setError(s.body.error || '') }
          } else if (s && s.body === null) {
            setError('宿主路由返回了非 JSON 响应（HTTP ' + s.status + '）'
              + (s.text ? '：' + s.text.replace(/\s+/g, ' ').trim() : ''))
          }
        })
      }, [])

      React.useEffect(function () {
        var alive = true
        var tick = function () { if (alive) load() }
        tick()
        var timer = setInterval(tick, pollMs || 15000)
        return function () { alive = false; clearInterval(timer) }
      }, [load, pollMs])

      var restart = React.useCallback(function (action) {
        setBusy(true)
        return fetchJson('daemon/' + action, { method: 'POST', body: {} })
          .then(function () { return load() })
          .catch(function (e) { setError(String(e)) })
          .then(function () { setBusy(false) })
      }, [load])

      return {
        health: health, state: state, error: error, busy: busy,
        reload: load, restart: restart,
      }
    }

    function nothingYet(text) {
      return React.createElement('div', { style: S.sub }, text || '数据加载中…')
    }

    // ── 各子页 ───────────────────────────────────────────────────────
    function OverviewTab(props) {
      var health = props.health
      var envelope = props.state
      var db = envelope && envelope.state ? envelope.state : null
      var daemon = health && health.daemon ? health.daemon : {}
      var summary = db && db.summary ? db.summary : null
      var headline = db && db.headline ? db.headline : null
      var usageTotals = db && db.usage && db.usage.totals ? db.usage.totals : null
      var siteRanking = db && Array.isArray(db.siteRanking) ? db.siteRanking.slice(0, 5) : []

      var ingestInfo = health && health.ingest ? health.ingest : null
      var toolInfo = health && health.tools ? health.tools : null
      var commandInfo = health && health.commands ? health.commands : null
      var promptInfo = health && health.prompt ? health.prompt : null
      var budgetInfo = health && health.budget ? health.budget : null
      var alerts = []
      if (daemon.mode === 'failed' || daemon.mode === 'down') {
        alerts.push({ level: 'error', text: 'ManageAPI daemon 未运行：' + (daemon.lastError || '可在本页点「重启 daemon」') })
      } else if (health && health.probe && health.probe.ok === false) {
        alerts.push({ level: 'error', text: 'daemon 进程在但没有响应：' + String(health.probe.error || '') })
      }
      if (budgetInfo && budgetInfo.over) {
        alerts.push({ level: 'warn', text: '预算已超限，工具调用已被熔断：' + String(budgetInfo.reason || '') })
      }
      if (ingestInfo && ingestInfo.failed > 0) {
        alerts.push({ level: 'warn', text: '用量回写有 ' + ingestInfo.failed + ' 次失败（daemon 版本可能早于 /api/ingest/usage）' })
      }

      var metrics = [
        { label: '站点', value: summary ? fmtInt(summary.providerCount) : '-' },
        { label: '可用供给', value: summary ? fmtInt(summary.offerCount) : '-' },
        { label: '可比价模型', value: summary ? fmtInt(summary.comparableCount) : '-' },
        { label: '模型总数', value: summary ? fmtInt(summary.modelCount) : '-' },
        { label: '平均价差', value: summary ? (typeof summary.avgSpreadPct === 'number' ? summary.avgSpreadPct.toFixed(0) + '%' : '-') : '-' },
        { label: '探针累计', value: db ? fmtInt(db.probeTotal) : '-' },
      ]

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        alerts.length
          ? React.createElement('div', { style: S.alert },
            alerts.map(function (a, i) {
              return React.createElement('div', {
                key: i,
                style: Object.assign({}, S.alertLine, { color: a.level === 'error' ? '#f85149' : '#d29922' }),
              }, (a.level === 'error' ? '⛔ ' : '⚠️ ') + a.text)
            }))
          : null,
        React.createElement(
          'div',
          { style: S.card },
          React.createElement(
            'div',
            { style: S.head },
            React.createElement('span', {
              style: Object.assign({}, S.pill),
            },
              React.createElement('span', { style: Object.assign({}, S.dot, { background: dotColor(daemon.mode) }) }),
              MODE_TEXT[daemon.mode] || String(daemon.mode || '未知'),
            ),
            React.createElement('span', { style: S.sub }, daemon.mode === 'attached'
              ? '外部 daemon 在跑，插件只读不写'
              : daemon.mode === 'owned' ? '由插件托管，DSH 退出时会一起停' : ''),
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('button', {
              style: S.btn,
              disabled: props.busy,
              onClick: function () { props.restart('restart') },
            }, props.busy ? '重启中…' : '重启 daemon'),
            React.createElement('button', {
              style: S.btn, onClick: props.onReload,
            }, '刷新'),
          ),
          React.createElement(
            'div',
            { style: S.row },
            React.createElement('span', { style: S.kv }, '端口'),
            React.createElement('span', null, String(daemon.port || '-')),
            React.createElement('span', { style: S.kv }, 'PID'),
            React.createElement('span', null, daemon.pid ? String(daemon.pid) : '-'),
            React.createElement('span', { style: S.kv }, '数据源'),
            React.createElement('span', null, envelope && envelope.source
              ? (envelope.source === 'daemon' ? 'daemon（实时）' : 'db.json（只读降级）')
              : '-'),
            React.createElement('span', { style: S.kv }, '运行时'),
            React.createElement('span', null, daemon.runtimeSource || '-'),
            React.createElement('span', { style: S.kv }, '检查于'),
            React.createElement('span', null, fmtTime(health && health.checkedAt)),
          ),
          daemon.lastError
            ? React.createElement('div', { style: S.err }, String(daemon.lastError))
            : null,
        ),
        React.createElement(
          'div',
          { style: S.card },
          React.createElement('div', { style: S.metricLabel }, '概览'),
          React.createElement('div', { style: S.grid }, metrics.map(function (m) {
            return React.createElement('div', { key: m.label, style: S.metric },
              React.createElement('span', { style: S.metricLabel }, m.label),
              React.createElement('span', { style: S.metricValue }, m.value))
          })),
          headline && headline.text
            ? React.createElement('div', { style: Object.assign({}, S.sub, { lineHeight: 1.5 }) }, String(headline.text))
            : null,
        ),
        React.createElement(
          'div',
          { style: S.card },
          React.createElement('div', { style: S.metricLabel }, '今日用量'),
          usageTotals
            ? React.createElement('div', { style: S.grid }, [
              { label: '请求', value: fmtInt(usageTotals.requests) },
              { label: '输入 token', value: fmtInt(usageTotals.input) },
              { label: '输出 token', value: fmtInt(usageTotals.output) },
              { label: '缓存命中', value: fmtInt(usageTotals.cached) },
              { label: '错误', value: fmtInt(usageTotals.errors) },
              { label: '平均延迟', value: fmtMs(usageTotals.avgLatencyMs) },
            ].map(function (m) {
              return React.createElement('div', { key: m.label, style: S.metric },
                React.createElement('span', { style: S.metricLabel }, m.label),
                React.createElement('span', { style: S.metricValue }, m.value))
            }))
            : nothingYet('还没有用量数据'),
        ),
        React.createElement(
          'div',
          { style: S.card },
          React.createElement('div', { style: S.metricLabel }, '运行时能力（Phase 2）'),
          React.createElement('div', { style: S.row },
            React.createElement('span', { style: S.kv }, '用量回写'),
            React.createElement('span', null, ingestInfo
              ? ('已回写 ' + fmtInt(ingestInfo.pushed) + ' · 跳过 ' + fmtInt(ingestInfo.skipped) + ' · 失败 ' + fmtInt(ingestInfo.failed))
              : '不可用'),
            React.createElement('span', { style: S.kv }, '工具'),
            React.createElement('span', null, toolInfo && toolInfo.names && toolInfo.names.length
              ? toolInfo.names.join(' / ')
              : '未注册'),
            React.createElement('span', { style: S.kv }, '命令'),
            React.createElement('span', null, commandInfo && commandInfo.registered ? '/manage' : '未注册'),
            React.createElement('span', { style: S.kv }, '预算'),
            React.createElement('span', null, budgetInfo
              ? (budgetInfo.configured ? ('本会话 ' + fmtInt(budgetInfo.session && budgetInfo.session.tokens) + ' tok' +
                (budgetInfo.limits && budgetInfo.limits.sessionTokens ? ' / 上限 ' + fmtInt(budgetInfo.limits.sessionTokens) : '') +
                (budgetInfo.over ? ' · 已超限' : '')) : '未设置（不熔断）')
              : '-'),
          ),
          promptInfo
            ? React.createElement('div', { style: { marginTop: '10px' } },
              React.createElement('div', { style: S.metricLabel }, '注入到系统提示词的内容'),
              React.createElement('pre', { style: S.pre }, String(promptInfo.text || '（空）')))
            : null,
        ),
        React.createElement(
          'div',
          { style: S.card },
          React.createElement('div', { style: S.metricLabel }, '站点评分前 5'),
          siteRanking.length
            ? React.createElement('table', { style: S.table },
              React.createElement('thead', null, React.createElement('tr', null,
                React.createElement('th', { style: S.th }, '站点'),
                React.createElement('th', { style: S.th }, '评分'),
                React.createElement('th', { style: S.th }, '可用率'),
                React.createElement('th', { style: S.th }, 'TTFT'),
                React.createElement('th', { style: S.th }, '模型'),
                React.createElement('th', { style: S.th }, '探针'),
              )),
              React.createElement('tbody', null, siteRanking.map(function (row, index) {
                return React.createElement('tr', { key: row.providerId || index },
                  React.createElement('td', { style: S.td }, String(row.providerName || row.providerId || '-')),
                  React.createElement('td', { style: S.td }, typeof row.score === 'number' ? row.score.toFixed(0) : '-'),
                  React.createElement('td', { style: S.td }, typeof row.uptime === 'number' ? (row.uptime * 100).toFixed(1) + '%' : '-'),
                  React.createElement('td', { style: S.td }, fmtMs(row.avgTtft)),
                  React.createElement('td', { style: S.td }, fmtInt(row.modelCount)),
                  React.createElement('td', { style: S.td }, fmtInt(row.probes)),
                )
              })),
            )
            : nothingYet('还没有探针数据'),
        ),
      )
    }

    function PricesTab(props) {
      var envelope = props.state
      var db = envelope && envelope.state ? envelope.state : null
      var ranked = db && Array.isArray(db.ranked) ? db.ranked : []
      if (!ranked.length) return nothingYet('还没有比价数据')

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        ranked.slice(0, 12).map(function (model) {
          var rows = Array.isArray(model.rows) ? model.rows.slice(0, 5) : []
          return React.createElement(
            'div',
            { key: model.modelKey, style: S.card },
            React.createElement(
              'div',
              { style: S.head },
              React.createElement('span', { style: S.title }, String(model.modelKey)),
              React.createElement('span', { style: S.sub }, rows.length + ' 条供给'),
              React.createElement('span', { style: S.sub }, '价差 ' + fmtPct(model.spreadPct)),
            ),
            React.createElement('table', { style: S.table },
              React.createElement('thead', null, React.createElement('tr', null,
                React.createElement('th', { style: S.th }, '站点 / 分组'),
                React.createElement('th', { style: S.th }, '¥/Mtok'),
                React.createElement('th', { style: S.th }, 'TTFT'),
                React.createElement('th', { style: S.th }, '延迟'),
                React.createElement('th', { style: S.th }, '缓存率'),
              )),
              React.createElement('tbody', null, rows.map(function (row) {
                return React.createElement('tr', { key: row.offerId },
                  React.createElement('td', { style: S.td },
                    (row.group ? String(row.group) : String(row.upstreamName || row.offerId))
                    + (row.isCheapest ? ' ★' : '')),
                  React.createElement('td', { style: S.td }, typeof row.blendedCnyPerMtok === 'number' ? row.blendedCnyPerMtok.toFixed(2) : '-'),
                  React.createElement('td', { style: S.td }, fmtMs(row.ttftMs)),
                  React.createElement('td', { style: S.td }, fmtMs(row.avgLatencyMs)),
                  React.createElement('td', { style: S.td }, typeof row.cacheHitRate === 'number' ? (row.cacheHitRate * 100).toFixed(0) + '%' : '-'),
                )
              })),
            ),
          )
        }),
      )
    }

    function UsageTab(props) {
      var envelope = props.state
      var db = envelope && envelope.state ? envelope.state : null
      var usage = db && db.usage ? db.usage : null
      if (!usage) return nothingYet('还没有用量数据')

      var byProvider = Array.isArray(usage.byProvider) ? usage.byProvider.slice(0, 12) : []
      var totals = usage.totals || {}

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        React.createElement(
          'div',
          { style: S.card },
          React.createElement('div', { style: S.metricLabel }, '总计'),
          React.createElement('div', { style: S.grid }, [
            { label: '请求', value: fmtInt(totals.requests) },
            { label: '错误', value: fmtInt(totals.errors) },
            { label: '输入 token', value: fmtInt(totals.input) },
            { label: '输出 token', value: fmtInt(totals.output) },
            { label: '缓存 token', value: fmtInt(totals.cached) },
            { label: '平均 TTFT', value: fmtMs(totals.avgTtftMs) },
          ].map(function (m) {
            return React.createElement('div', { key: m.label, style: S.metric },
              React.createElement('span', { style: S.metricLabel }, m.label),
              React.createElement('span', { style: S.metricValue }, m.value))
          })),
        ),
        React.createElement(
          'div',
          { style: S.card },
          React.createElement('div', { style: S.metricLabel }, '按站点'),
          byProvider.length
            ? React.createElement('table', { style: S.table },
              React.createElement('thead', null, React.createElement('tr', null,
                React.createElement('th', { style: S.th }, '站点'),
                React.createElement('th', { style: S.th }, '请求'),
                React.createElement('th', { style: S.th }, '输入'),
                React.createElement('th', { style: S.th }, '输出'),
              )),
              React.createElement('tbody', null, byProvider.map(function (row, index) {
                var label = row.providerName || row.provider || row.name || row.providerId || ('#' + index)
                return React.createElement('tr', { key: String(label) + index },
                  React.createElement('td', { style: S.td }, String(label)),
                  React.createElement('td', { style: S.td }, fmtInt(row.requests || row.count)),
                  React.createElement('td', { style: S.td }, fmtInt(row.input)),
                  React.createElement('td', { style: S.td }, fmtInt(row.output)),
                )
              })),
            )
            : nothingYet('还没有按站点统计'),
        ),
      )
    }

    function PlaceholderTab(props) {
      return React.createElement(
        'div',
        { style: S.card },
        React.createElement('div', { style: S.metricLabel }, props.title),
        React.createElement('div', { style: S.sub }, props.hint || '这一页在 Phase 1/2 补齐。'),
      )
    }

    // ── 决策子页：路由记录（谁被选中、试了几次、失败在哪）────────────────
    function buildProviderMap(state) {
      var map = {}
      var list = (state && state.providers) || []
      for (var i = 0; i < list.length; i += 1) {
        var p = list[i]
        if (p && p.id) map[p.id] = p.name || p.id
      }
      return map
    }

    function outcomeText(outcome) {
      if (outcome === 'ok') return '成功'
      if (outcome === 'failed') return '失败'
      return outcome || '—'
    }

    function outcomeColor(outcome) {
      if (outcome === 'ok') return '#3fb950'
      if (outcome === 'failed') return '#f85149'
      return 'var(--dsw-alias-text-secondary, #8b949e)'
    }

    function firstFailureText(row) {
      var failures = row && row.failures
      if (!failures || !failures.length) return ''
      var first = failures[0] || {}
      var parts = []
      if (first.providerName) parts.push(first.providerName)
      if (first.error) parts.push(String(first.error).slice(0, 40))
      var text = parts.join('：')
      if (failures.length > 1) text += ` 等 ${failures.length} 次`
      return text
    }

    function DecisionsTab(props) {
      var state = props.state
      var routing = (state && state.routing) || []
      if (!routing.length) return nothingYet('还没有路由记录——发起一次对话后这里会按请求列出选站过程。')

      var providerMap = buildProviderMap(state)
      var counts = { ok: 0, failed: 0 }
      for (var i = 0; i < routing.length; i += 1) {
        var outcome = routing[i] && routing[i].outcome
        if (outcome === 'ok') counts.ok += 1
        else if (outcome === 'failed') counts.failed += 1
      }
      var rows = routing.slice().reverse().slice(0, 20)

      return React.createElement(
        'div',
        { style: S.card },
        React.createElement('div', { style: S.metricLabel }, '路由决策（最近 20 条）'),
        React.createElement(
          'div',
          { style: S.row },
          React.createElement('span', { style: S.sub }, `成功 ${counts.ok} · 失败 ${counts.failed} · 共 ${routing.length} 条`),
          React.createElement('span', { style: S.sub }, '换站次数 = 尝试次数 − 1'),
        ),
        React.createElement(
          'table',
          { style: S.table },
          React.createElement('thead', null, React.createElement('tr', null,
            React.createElement('th', { style: S.th }, '时间'),
            React.createElement('th', { style: S.th }, '模型'),
            React.createElement('th', { style: S.th }, '选中站点'),
            React.createElement('th', { style: S.th }, '尝试'),
            React.createElement('th', { style: S.th }, '结果'),
            React.createElement('th', { style: S.th }, 'TTFT'),
            React.createElement('th', { style: S.th }, '总耗时'),
            React.createElement('th', { style: S.th }, '失败摘要'),
          )),
          React.createElement('tbody', null, rows.map(function (row, index) {
            var station = row.chosenProviderName || providerMap[row.chosenProviderId] || '—'
            var failures = firstFailureText(row)
            return React.createElement('tr', { key: String(row.id || index) },
              React.createElement('td', { style: S.td }, fmtTime(row.ts)),
              React.createElement('td', { style: S.td }, String(row.model || '—')),
              React.createElement('td', { style: S.td }, String(station)),
              React.createElement('td', { style: S.td }, String(row.attempts == null ? '—' : row.attempts)),
              React.createElement('td', { style: Object.assign({}, S.td, { color: outcomeColor(row.outcome) }) }, outcomeText(row.outcome)),
              React.createElement('td', { style: S.td }, fmtMs(row.ttftMs)),
              React.createElement('td', { style: S.td }, fmtMs(row.latencyMs)),
              React.createElement('td', { style: S.td }, failures || '—'),
            )
          })),
        ),
        React.createElement('div', { style: S.sub }, '候选与评分细节在「探针」子页；这里只看「为什么这次选它/为什么换了站」。'),
      )
    }

    // ── 探针子页：每个供给的探针证据（可用率/质量/完整性/缓存/新鲜度）────
    function ProbesTab(props) {
      var state = props.state
      var scores = (state && state.scores) || {}
      var offers = (state && state.offers) || []
      var providerMap = buildProviderMap(state)
      var byOfferId = {}
      for (var i = 0; i < offers.length; i += 1) {
        var offer = offers[i]
        if (offer && offer.id) byOfferId[offer.id] = offer
      }
      var entries = Object.keys(scores).map(function (offerId) {
        var score = scores[offerId] || {}
        var offer = byOfferId[offerId] || {}
        var providerName = providerMap[offer.providerId] || offer.providerId || '—'
        return { offerId: offerId, score: score, providerName: providerName, model: offer.upstreamName || offer.modelKey || '—' }
      })
      if (!entries.length) return nothingYet('还没有探针数据——到 ManageAPI 网页或 daemon 触发一次探针后这里会有证据表。')

      entries.sort(function (a, b) {
        var qa = typeof a.score.quality === 'number' ? a.score.quality : -1
        var qb = typeof b.score.quality === 'number' ? b.score.quality : -1
        return qb - qa
      })
      var shown = entries.slice(0, 25)

      return React.createElement(
        'div',
        { style: S.card },
        React.createElement('div', { style: S.metricLabel }, '探针证据（按质量排序，前 25 条）'),
        React.createElement('div', { style: S.sub }, `共 ${entries.length} 个供给有探针记录 · 历史探针总数 ${fmtInt((state && state.probeTotal) || 0)}`),
        React.createElement(
          'table',
          { style: S.table },
          React.createElement('thead', null, React.createElement('tr', null,
            React.createElement('th', { style: S.th }, '站点'),
            React.createElement('th', { style: S.th }, '上游模型'),
            React.createElement('th', { style: S.th }, '可用率'),
            React.createElement('th', { style: S.th }, '质量'),
            React.createElement('th', { style: S.th }, '完整性'),
            React.createElement('th', { style: S.th }, 'TTFT'),
            React.createElement('th', { style: S.th }, '缓存命中'),
            React.createElement('th', { style: S.th }, '样本'),
            React.createElement('th', { style: S.th }, '证据年龄'),
            React.createElement('th', { style: S.th }, '置信度'),
          )),
          React.createElement('tbody', null, shown.map(function (entry) {
            var score = entry.score
            var title = score.lastError ? String(score.lastError) : ''
            var staleSuffix = score.stale ? '（stale）' : ''
            return React.createElement('tr', { key: entry.offerId, title: title || undefined },
              React.createElement('td', { style: S.td }, entry.providerName),
              React.createElement('td', { style: S.td }, entry.model),
              React.createElement('td', { style: S.td }, fmtRate(score.availability)),
              React.createElement('td', { style: S.td }, fmtRate(score.quality)),
              React.createElement('td', { style: S.td }, fmtRate(score.integrity)),
              React.createElement('td', { style: S.td }, fmtMs(score.ttftMs)),
              React.createElement('td', { style: S.td }, fmtRate(score.cacheHitRate)),
              React.createElement('td', { style: S.td }, fmtInt(score.samples)),
              React.createElement('td', { style: S.td }, (typeof score.evidenceAgeMs === 'number' ? fmtMs(score.evidenceAgeMs) : '—') + staleSuffix),
              React.createElement('td', { style: S.td }, String(score.confidence || '—')),
            )
          })),
        ),
        React.createElement('div', { style: S.sub }, '「质量」综合了指纹/截断/计费三类一致性；悬停某行可看最近错误。'),
      )
    }

    // ── 会话成本 chip（conversation.chat.assistant-actions）──────────────
    var sessionStatsCache = { sessionId: '', at: 0, data: null, pending: null }

    function fetchSessionStats(sessionId) {
      var now = Date.now()
      if (sessionStatsCache.sessionId === sessionId) {
        if (sessionStatsCache.data && now - sessionStatsCache.at < 15000) return Promise.resolve(sessionStatsCache.data)
        if (sessionStatsCache.pending) return sessionStatsCache.pending
      }
      var pending = fetchJson('stream-stats?session=' + encodeURIComponent(sessionId))
        .then(function (result) {
          var stats = result && result.body && result.body.stats ? result.body.stats : null
          var data = { ok: !!(result && result.ok), stats: stats }
          sessionStatsCache = { sessionId: sessionId, at: Date.now(), data: data, pending: null }
          return data
        })
        .catch(function (e) {
          var data = { ok: false, error: String(e) }
          sessionStatsCache = { sessionId: sessionId, at: Date.now(), data: data, pending: null }
          return data
        })
      sessionStatsCache = { sessionId: sessionId, at: sessionStatsCache.at, data: sessionStatsCache.data, pending: pending }
      return pending
    }

    function CostChip(props) {
      if (!React) return null
      var sessionId = props && props.sessionId ? String(props.sessionId) : ''
      var tuple = React.useState(null)
      var state = tuple[0]
      var setState = tuple[1]
      React.useEffect(function () {
        if (!sessionId) return undefined
        var alive = true
        fetchSessionStats(sessionId).then(function (value) {
          if (alive) setState(value)
        })
        return function () { alive = false }
      }, [sessionId])

      var stats = state && state.stats
      if (!stats || !stats.calls) return null
      var title = '本会话经 ManageAPI 路由累计：' + stats.calls + ' 次调用 · ' + fmtInt(stats.tokens) + ' tokens'
        + (stats.model ? ' · 最近模型 ' + stats.model : '')
      return React.createElement('span', { style: S.chip, title: title },
        '⇄ ' + fmtInt(stats.tokens) + ' tok / ' + stats.calls + ' 次')
    }

    var TABS = [
      { id: 'overview', label: '概览' },
      { id: 'prices', label: '比价' },
      { id: 'decisions', label: '决策' },
      { id: 'probes', label: '探针' },
      { id: 'usage', label: '用量' },
    ]

    function PanelSection() {
      if (!React) return null
      var tabState = React.useState('overview')
      var tab = tabState[0]
      var setTab = tabState[1]
      var data = useManageApi(15000)

      var body = null
      if (tab === 'overview') {
        body = React.createElement(OverviewTab, {
          health: data.health, state: data.state, busy: data.busy,
          restart: data.restart, onReload: data.reload,
        })
      } else if (tab === 'prices') {
        body = React.createElement(PricesTab, { state: data.state })
      } else if (tab === 'usage') {
        body = React.createElement(UsageTab, { state: data.state })
      } else if (tab === 'decisions') {
        body = React.createElement(DecisionsTab, { state: data.state })
      } else {
        body = React.createElement(ProbesTab, { state: data.state })
      }

      return React.createElement(
        'div',
        { style: S.wrap },
        React.createElement(
          'div',
          { style: S.head },
          React.createElement('span', { style: S.title }, 'ManageAPI'),
          React.createElement('span', { style: S.sub }, '多站点模型路由 · 守护进程托管'),
        ),
        data.error ? React.createElement('div', { style: S.err }, String(data.error)) : null,
        React.createElement('div', { style: S.tabs }, TABS.map(function (item) {
          return React.createElement('button', {
            key: item.id,
            style: item.id === tab ? S.tabActive : S.tab,
            onClick: function () { setTab(item.id) },
          }, item.label)
        })),
        body,
      )
    }

    // ── 生命周期 ──────────────────────────────────────────────────────
    function apply(ctx) {
      var disposers = []
      try {
        var slots = ctx.get('slots', false)
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          try { console.warn('[dsh-manage-api] slots 不可用，设置页分区未注册') } catch (e) { /* ignore */ }
          return function () {}
        }

        // ① 设置页常驻分区（主入口）
        slots.inject('settings.section', function () {
          try {
            var d = slots.register({
              name: 'settings.section',
              id: 'manage-api',
              order: 60,
              label: 'ManageAPI',
            }, PanelSection)
            if (typeof d === 'function') disposers.push(d)
          } catch (e) { /* 注册失败不影响其它功能 */ }
        })

        // ② 每条 assistant 消息下方的会话用量 chip（会话作用域，拿得到 sessionId）
        slots.inject('conversation.chat.assistant-actions', function () {
          try {
            var d = slots.register({
              name: 'conversation.chat.assistant-actions',
              id: 'manage-api-cost',
              order: 30,
              label: 'ManageAPI 用量',
            }, CostChip)
            if (typeof d === 'function') disposers.push(d)
          } catch (e) { /* ignore */ }
        })
      } catch (e) {
        try { console.warn('[dsh-manage-api] apply 失败', e) } catch (e2) { /* ignore */ }
      }
      return function () {
        for (var i = 0; i < disposers.length; i += 1) {
          try { if (typeof disposers[i] === 'function') disposers[i]() } catch (e) { /* ignore */ }
        }
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    // 仅给 scripts/check.mjs 做渲染冒烟用；宿主不会读这个字段
    exports.__internals = {
      OverviewTab: OverviewTab,
      PricesTab: PricesTab,
      DecisionsTab: DecisionsTab,
      ProbesTab: ProbesTab,
      UsageTab: UsageTab,
      CostChip: CostChip,
      PanelSection: PanelSection,
    }
    return module.exports
  },
})
