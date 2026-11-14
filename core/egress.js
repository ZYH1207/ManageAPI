/**
 * 出口自检：回答「现在我这条本机链路到底通不通」。
 *
 * 为什么必须有这一层：原来的归因是**纯被动**的——看这一批失败里跨了几个站、
 * 网络类占比多少。它只能在事后猜「大概是我这边」，而且有个致命前提：
 * 得先能把失败认成「网络类」。2026-11-14 事故就是栽在这个前提上：
 * 本机唯一的失败形式是 `EHOSTUNREACH`，当时不在 NETWORK_FAILURE 正则里，
 * 于是网络类失败数恒为 0，跨站同簇防护一次都没触发，316 次失败全记成站点故障。
 *
 * 被动判定还有一个根本缺陷：**它无法区分「站全挂了」和「我出不去」**。
 * 两种情况下，失败集合长得一模一样（都是所有站连不上）。要分清，必须有一个
 * **与这些站无关的对照物**。
 *
 * 所以这里做的是主动对照：拿几个和用户上游毫无关系的公网地址，走同一条出口
 * 做 DNS → TCP → TLS。几百毫秒、零 token、不打上游、不计入任何供给的账。
 *
 * 判定就变成硬证据，而不是猜：
 *
 *   对照也挂            → 出口问题（还能说清是 DNS / TCP / TLS 哪一层断的）
 *   对照通、站点挂      → 站点真不可用
 *   对照通、所有站都挂  → 分流规则/代理规则选错了对象（不是断网，是路由不对）
 *
 * 口径约定：`probeEgress` 只测量、不下结论；`judgeEgress` / `attributeFailures`
 * 是纯函数，方便单测直接钉死。写给谁看由调用方决定（诊断页/状态条）。
 */
import { probeConnectivity } from './probe-preflight.js'

/**
 * 对照目标：刻意选三条**路径不同**的链路，这样能分辨「全断」和「只是某条路不通」。
 *
 *   cloudflare —— 裸 IP + 明文 HTTP，**既不过 DNS 也不过 TLS**，只测 TCP 层。
 *                 它挂了但别的通 = 连「发一个包出去」都做不到（最底层的断）。
 *   baidu      —— 国内域名 + 国内 CDN。它挂了通常意味着本地网络/运营商断了。
 *   google     —— 必须走代理才通。只有它挂 = 代理没连上（今天就是这种）。
 *
 * 三条全挂是最强的「出口不通」证据；只有 google 挂说明代理断了但直连还在，
 * 这时上游站如果全挂，仍然要算出口问题（因为上游走的就是代理）。
 *
 * 为什么 cloudflare 这条用 `http://` 而不是 `https://`：TLS 不允许把 IP 当
 * servername（Node 直接抛 `Setting the TLS ServerName to an IP address is not
 * permitted`），那会把一条本该「通」的链路判成 tls 失败，让自检永远显示
 * 「部分可用」。这条的目标就是测最底层的 TCP，不该被 TLS 的规矩拖下水。
 */
export const EGRESS_TARGETS = [
  { id: 'cloudflare', label: 'Cloudflare（裸 IP，不过 DNS/TLS）', url: 'http://1.1.1.1', expect: 'any' },
  { id: 'baidu', label: '百度（国内直连）', url: 'https://www.baidu.com', expect: 'any' },
  { id: 'google', label: 'Google（需走代理）', url: 'https://www.google.com', expect: 'any' },
]

/** 单目标超时：和预检同档，整轮三目标并发跑完通常 < 2 秒 */
const DEFAULT_TIMEOUT_MS = { dns: 3000, tcp: 4000, tls: 4000 }

/**
 * 跑一轮出口自检。并发，整体耗时 = 最慢那个目标。
 *
 * @param {{targets?: Array<{id:string,label:string,url:string}>, timeoutMs?: object}} options
 * @returns {Promise<{at:string, ms:number, targets:Array<{id,label,url,ok,layer,ms,error,ip}>}>}
 */
export async function probeEgress({ targets = EGRESS_TARGETS, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const started = Date.now()
  const results = await Promise.all(
    targets.map(async (target) => {
      try {
        const r = await probeConnectivity(target.url, { timeoutMs })
        return {
          id: target.id,
          label: target.label,
          url: target.url,
          ok: Boolean(r.ok),
          // 失败时是哪一层断的：dns / tcp / tls。这是「出口问题」里唯一能
          // 直接指向「去改什么」的信息（改 DNS / 换节点 / 换个代理）
          layer: r.ok ? null : r.layer || 'unknown',
          ms: r.ms,
          error: r.ok ? null : r.error || null,
          ip: r.resolvedIp || null,
        }
      } catch (error) {
        return {
          id: target.id,
          label: target.label,
          url: target.url,
          ok: false,
          layer: 'unknown',
          ms: Date.now() - started,
          error: error?.message || String(error),
          ip: null,
        }
      }
    }),
  )
  return { at: new Date().toISOString(), ms: Date.now() - started, targets: results }
}

/**
 * 给一轮结果下结论。纯函数。
 *
 * 三档，刻意不合并成一个布尔：
 *   ok      全部通            —— 出口没问题
 *   down    一个都没通        —— 出口断了
 *   partial 部分通            —— 分流/代理规则问题，或者某条链路单独坏了
 *
 * `partial` 单独存在是因为它的处置完全不同：断网要去连代理，部分通则要去
 * **改规则**（比如某个域名没进代理列表）。混成「不通」会让人白折腾。
 *
 * @param {{targets?: Array<{ok:boolean}>}|null} record
 * @returns {'ok'|'down'|'partial'|'unknown'}
 */
export function judgeEgress(record) {
  const targets = Array.isArray(record?.targets) ? record.targets : []
  if (targets.length === 0) return 'unknown'
  const reachable = targets.filter((t) => t?.ok).length
  if (reachable === targets.length) return 'ok'
  if (reachable === 0) return 'down'
  return 'partial'
}

/**
 * 一轮自检里「断在哪一层」——取失败目标的层集合，命中多的排前面。
 * 只用于文案（「DNS 解析失败」比「出口不通」更能指路）。
 *
 * @param {{targets?: Array<{ok:boolean,layer:string}>}|null} record
 * @returns {string|null}
 */
export function worstEgressLayer(record) {
  const failed = (Array.isArray(record?.targets) ? record.targets : []).filter((t) => t && !t.ok)
  if (failed.length === 0) return null
  const counts = new Map()
  for (const t of failed) {
    const layer = String(t.layer || 'unknown')
    counts.set(layer, (counts.get(layer) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

const LAYER_TEXT = {
  dns: 'DNS 解析失败',
  tcp: 'TCP 连不上',
  tls: 'TLS 握手失败',
  unknown: '连接失败',
}

export function egressLayerText(layer) {
  return LAYER_TEXT[String(layer || 'unknown')] || '连接失败'
}

/**
 * 把「一次出口自检」+「同一时段的上游失败」拼成责任结论。
 *
 * 这是整个功能的目的：**在同一个时刻**同时看到「出口怎么样」和「站点怎么样」，
 * 才能说清是谁的问题。只有一侧的证据永远只能猜。
 *
 * 四种结论：
 *   egress    出口挂了。上游失败不算站点的账。
 *   site      出口通，站点挂。这是真故障，该降权/该换站。
 *   routing   出口部分通，且失败集中在走代理的那部分 → 分流规则。
 *   unknown   没有同期证据（比如自检是两小时前的），不下结论。
 *
 * @param {{record: object|null, failures?: Array<{error?:string,providerId?:string}>, now?: number,
 *          maxAgeMs?: number}} args
 * @returns {{owner:'egress'|'site'|'routing'|'unknown', verdict:'ok'|'down'|'partial'|'unknown',
 *            layer:string|null, detail:string}}
 */
export function attributeFailures({ record = null, failures = [], now = Date.now(), maxAgeMs = 5 * 60_000 } = {}) {
  const verdict = judgeEgress(record)
  const at = record?.at ? Date.parse(record.at) : NaN
  // 自检太旧就没有对照价值：两小时前出口通，不代表刚才那批失败不是出口问题
  const fresh = Number.isFinite(at) && now - at <= maxAgeMs
  const failedCount = failures.filter((f) => f && f.error).length
  if (!fresh) {
    return {
      owner: 'unknown',
      verdict,
      layer: worstEgressLayer(record),
      detail: record
        ? `出口自检是 ${Math.round((now - at) / 60000)} 分钟前的，不能作为这批失败的对照`
        : '还没有跑过出口自检，无法判断这批失败该算谁的',
    }
  }
  if (verdict === 'down') {
    return {
      owner: 'egress',
      verdict,
      layer: worstEgressLayer(record),
      detail: `出口不通（${egressLayerText(worstEgressLayer(record))}），对照地址一个都连不上；这 ${failedCount} 次失败不是站点的问题`,
    }
  }
  if (verdict === 'partial') {
    // 国内直连通、只有需要代理的那条挂：上游走代理，所以站点全挂仍是出口的事
    const google = (record.targets || []).find((t) => t.id === 'google')
    const cnOk = (record.targets || []).filter((t) => t.id !== 'google').every((t) => t.ok)
    if (google && !google.ok && cnOk) {
      return {
        owner: 'egress',
        verdict,
        layer: google.layer || 'tcp',
        detail: `直连通、代理通路不通（${egressLayerText(google.layer)}）：上游站点都走代理，所以这批失败仍算出口的问题`,
      }
    }
    return {
      owner: 'routing',
      verdict,
      layer: worstEgressLayer(record),
      detail: `出口部分可用（${egressLayerText(worstEgressLayer(record))}）：像是分流/代理规则只放行了部分目标，不是全断`,
    }
  }
  return {
    owner: 'site',
    verdict,
    layer: null,
    detail: `出口正常（${(record.targets || []).filter((t) => t.ok).length}/${(record.targets || []).length} 个对照地址都通），所以这 ${failedCount} 次失败要算站点自己的`,
  }
}

/**
 * 这条供给的负面标签是不是**在出口故障期间**积累出来的。
 *
 * 用途：一键「重新累积」时给出解释，以及诊断页把误判说清楚——
 * 「这 13 条不是站坏了，是 20:31–20:37 出口断了六分钟」。
 *
 * @param {{incidentAt?: string|null, since?: string|null}} args
 *        incidentAt —— 出口故障发生的时间；since —— 这批负面积累的起点
 * @returns {boolean}
 */
export function blameEgressIncident({ incidentAt = null, since = null } = {}) {
  const incident = Date.parse(incidentAt || '')
  const start = Date.parse(since || '')
  if (!Number.isFinite(incident) || !Number.isFinite(start)) return false
  // 负面积累起点早于（或正好在）故障发生时，说明这段账里混着出口的锅
  return start <= incident
}
