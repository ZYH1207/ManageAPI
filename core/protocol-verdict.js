/**
 * 协议结论：把「哪几项红了」翻译成「这个协议能干什么、能导进哪个工具、导错了会怎样」。
 *
 * 作者的原话：只知道缺东西，但不知道缺了有什么影响。所以这里不输出数字，
 * 只输出四段人话：
 *   1. 一句话结论（这个协议在这站上是什么成色）
 *   2. 能干的事 / 干不了的事（干不了的直接带上「所以会怎样」）
 *   3. 能导进哪些工具（拿实测结果和工具的 requires 求交集，不是猜）
 *   4. 导错工具的后果（用该能力的 impact 拼出来）
 *
 * 判定口径与 core/protocol-probe.js 的 real 结论互相独立：
 *   real 回答「它是不是原生实现」，verdict 回答「用它能不能干活」，两件事。
 */

import { CONSUMERS, PROTOCOLS, PROTOCOL_ORDER, capabilitiesFor } from './protocol-catalog.js'

/**
 * 该协议上「必须过」的能力。任一项红，就意味着这个协议干不了正经活。
 * 取 key:true 的子集 —— 这些就是 catalog 里标了命脉的项。
 */
function criticalIds(protocolId) {
  return (PROTOCOLS[protocolId]?.capabilities || []).filter((cap) => cap.key).map((cap) => cap.id)
}

const MISSING_WORD = '缺失'

/**
 * @param {string} protocolId
 * @param {Array} capabilities 实测能力行（带 status / detail）
 * @param {object} surface     表面协议结果
 * @returns {{level:string, headline:string, can:string[], cannot:object[], consumers:Array, toolHint:string}}
 */
export function protocolVerdict(protocolId, capabilities = [], surface = {}) {
  const meta = PROTOCOLS[protocolId]
  const label = meta?.short || protocolId
  const rows = capabilities || []
  const known = rows.filter((row) => row.status !== 'unknown')
  const passed = rows.filter((row) => row.status === 'pass')
  const failed = rows.filter((row) => row.status === 'fail')
  const flaky = rows.filter((row) => row.status === 'flaky')
  const byId = new Map(rows.map((row) => [row.id, row]))

  // 端点压根没被接受：不解释能力，直接说不支持
  if (surface?.outcome === 'unsupported' || surface?.outcome === 'rejected') {
    return {
      level: 'unsupported',
      headline: `${label} 端点不接受请求，这个协议用不了。`,
      can: [],
      cannot: [
        {
          id: 'endpoint',
          name: `${label} 协议本身`,
          impact: surface?.error || '站点直接拒绝了这个端点，任何依赖它的工具都导不进来。',
        },
      ],
      consumers: CONSUMERS.filter((item) => item.protocol === protocolId).map((item) => ({
        id: item.id,
        name: item.name,
        ready: 'no',
        missing: ['协议端点不可用'],
        why: `这个站不提供 ${label} 端点，${item.name} 无法接入。`,
      })),
      toolHint: `别把 ${item0Name(protocolId)} 导进只认这个协议的工具，会直接报协议错。`,
    }
  }

  if (surface?.outcome === 'denied' || surface?.outcome === 'network' || surface?.outcome === 'upstream-error') {
    return {
      level: 'unknown',
      headline: `${label} 没能拿到有效响应，无法判断能力。`,
      can: [],
      cannot: [],
      consumers: CONSUMERS.filter((item) => item.protocol === protocolId).map((item) => ({
        id: item.id,
        name: item.name,
        ready: 'unknown',
        missing: [],
        why: `这次没测出来：${surface?.error || surface?.outcome}。检查地址、Key、分组权限后重测。`,
      })),
      toolHint: '这次是环境问题不是协议问题，先解决连通性再看结论。',
    }
  }

  if (!known.length) {
    return {
      level: 'unknown',
      headline: `${label} 能力测试没有拿到任何有效样本。`,
      can: [],
      cannot: [],
      consumers: [],
      toolHint: '重测一次，或换「全量 + 三次」模式排除偶发。',
    }
  }

  const criticals = criticalIds(protocolId)
  const criticalFailed = criticals.filter((id) => byId.get(id)?.status === 'fail')
  const criticalFlaky = criticals.filter((id) => byId.get(id)?.status === 'flaky')
  const passRate = passed.length / Math.max(1, known.length)

  let level
  if (failed.length === 0 && flaky.length === 0) level = 'native'
  // 命脉项时好时坏，比「彻底缺」更坑人：不能算可用
  else if (criticalFlaky.length > 0) level = 'partial'
  else if (criticalFailed.length === 0 && passRate >= 0.8) level = 'mostly'
  else if (criticalFailed.length === 0) level = 'partial'
  else if (passRate >= 0.5) level = 'partial'
  else level = 'weak'

  const headline = (() => {
    if (level === 'native') return `${label} 全绿：${passed.length} 项能力全过，可以当原生协议直接用。`
    if (criticalFlaky.length > 0) {
      return `${label} 不稳定：关键能力时好时坏（${criticalFlaky
        .map((id) => byId.get(id)?.name || id)
        .join('、')}），能跑但会间歇性出错。`
    }
    if (level === 'mostly') return `${label} 基本完整：${passed.length}/${known.length} 项通过，只有 ${failed.length + flaky.length} 项非关键能力有问题。`
    if (level === 'partial') return `${label} 残缺可用：${passed.length}/${known.length} 项通过，缺的是关键项，能跑但会在特定环节出错。`
    return `${label} 大面积缺失：只有 ${passed.length}/${known.length} 项通过，这个协议基本是空壳，包装得像但对不上。`
  })()

  const can = []
  for (const row of passed) {
    if (row.key) can.push(row.name)
  }
  if (!can.length) {
    // lite 模式下可能没有 key 项全过，退化成列出所有通过的
    for (const row of passed.slice(0, 6)) can.push(row.name)
  }

  const cannot = []
  for (const row of [...failed, ...flaky]) {
    const meta2 = meta?.capabilities?.find((cap) => cap.id === row.id)
    cannot.push({
      id: row.id,
      name: row.name,
      status: row.status,
      impact: meta2?.impact || '这一项缺失会影响对应功能。',
      detail: row.detail || '',
    })
  }

  const consumers = CONSUMERS.filter((item) => item.protocol === protocolId).map((item) => {
    const missing = item.requires.filter((id) => {
      const row = byId.get(id)
      return !row || row.status === 'fail'
    })
    const unstable = item.requires.filter((id) => byId.get(id)?.status === 'flaky')
    // requires 里列的都是「这工具干活离不开的」，缺一项就不是「凑合能用」，
    // 而是「连上了也干不了活」——这里不做讨价还价式的折中判定。
    let ready = 'ok'
    if (missing.length) ready = 'no'
    else if (unstable.length) ready = 'part'
    const why = (() => {
      if (ready === 'ok') return item.good
      const parts = []
      if (missing.length) {
        parts.push(
          `缺 ${missing.map((id) => meta?.capabilities?.find((cap) => cap.id === id)?.name || id).join('、')}`,
        )
      }
      if (unstable.length) {
        parts.push(`${unstable.map((id) => meta?.capabilities?.find((cap) => cap.id === id)?.name || id).join('、')} 时好时坏`)
      }
      return `${parts.join('；')}。${item.bad}`
    })()
    return { id: item.id, name: item.name, ready, missing, why }
  })

  // 导错工具的后果：一句话，不重复工具卡里已经写过的 why，只给「会看到什么现象」
  // 取第一个分句做「典型现象」，优先在标点处收尾，避免把句子切成半截
  const symptomOf = (item) => {
    const text = String(item.impact || '')
    const head = text.split('。')[0]
    if (head.length <= 26) return head
    const cut = Math.max(head.lastIndexOf('；'), head.lastIndexOf('，'))
    return cut > 8 ? head.slice(0, cut) : `${head.slice(0, 26)}…`
  }
  const toolHint = (() => {
    if (!consumers.length) return `${label} 暂时没有已知消费方。`
    const blocked = consumers.filter((item) => item.ready === 'no')
    const risky = consumers.filter((item) => item.ready === 'part')
    const shots = cannot.filter((item) => item.status === 'fail').slice(0, 2).map(symptomOf)

    if (blocked.length) {
      const names = blocked.map((item) => item.name).join('、')
      return shots.length
        ? `接上 ${names} 会「连得上但干不了活」，典型现象：${shots.join('；')}。`
        : `接上 ${names} 会连得上但干不了活。`
    }
    if (risky.length) {
      const names = risky.map((item) => item.name).join('、')
      return shots.length
        ? `可以接 ${names}，但要接受这些现象：${shots.join('；')}。`
        : `可以接 ${names}，个别环节不稳。`
    }
    return `接 ${consumers.map((item) => item.name).join('、')} 没问题，未发现影响使用的缺口。`
  })()

  return { level, headline, can, cannot, consumers, toolHint }
}

function item0Name(protocolId) {
  return PROTOCOLS[protocolId]?.label || protocolId
}

/**
 * 汇总四种协议给一句总建议：优先用哪条、哪条别碰。
 */
export function overallAdvice(protocolEntries = {}) {
  const order = ['native', 'mostly', 'partial', 'weak', 'unknown', 'unsupported']
  const ranked = Object.entries(protocolEntries)
    .map(([id, entry]) => ({ id, label: PROTOCOLS[id]?.short || id, ...(entry.verdict || {}) }))
    .filter((item) => item.level)
    // 同档位时按协议固定顺序排，不按「谁先测完」——否则每次刷新顺序都不一样
    .sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level) || PROTOCOL_ORDER.indexOf(a.id) - PROTOCOL_ORDER.indexOf(b.id))

  if (!ranked.length) return null
  const best = ranked.filter((item) => item.level === 'native' || item.level === 'mostly')
  const worst = ranked.filter((item) => item.level === 'weak' || item.level === 'unsupported')
  const flaky = ranked.filter((item) => item.level === 'partial')

  const TOOL_FOR = { chat: 'pi', responses: 'Codex', anthropic: 'Claude Code', gemini: 'Gemini SDK' }
  if (best.length === ranked.length) {
    const allNative = best.every((item) => item.level === 'native')
    if (allNative) {
      return `${best.map((item) => item.label).join(' / ')} 四种协议全绿。按你要接入的工具挑：${best
        .map((item) => `${item.label}→${TOOL_FOR[item.id] || '对应客户端'}`)
        .join('、')}。`
    }
    return `四种协议都可用。按你要接入的工具挑：${best
      .map((item) => `${item.label}→${TOOL_FOR[item.id] || '对应客户端'}`)
      .join('、')}（个别非关键项有小瑕疵，见各协议明细）。`
  }

  const parts = []
  if (best.length) parts.push(`优先走 ${best.map((item) => `${item.label}（接 ${TOOL_FOR[item.id] || '对应客户端'}）`).join('、')}`)
  if (flaky.length) parts.push(`${flaky.map((item) => item.label).join(' / ')} 能用但不稳`)
  if (worst.length) parts.push(`${worst.map((item) => item.label).join(' / ')} 别接`)
  return parts.join('；')
}

export { capabilitiesFor }
