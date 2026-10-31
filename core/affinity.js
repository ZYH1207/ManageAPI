/**
 * 缓存亲和（cache affinity）—— 借鉴 Magpie 的核心洞察。
 *
 * ## 为什么要它
 *
 * 自动路由原先只看「谁更好」（价格 / 速度 / 性价比），完全没把「换人」的代价
 * 算进去。而真实成本里有一项占比极高：**上游的 prompt 缓存**。
 *
 * KV / prompt 缓存绑在「模型 + 上游分组 + 账号」这个组合上。一旦改派：
 *   · 客户端那几十万 token 的上下文要在新模型上从零重算一遍
 *   · 缓存读取那部分账单（通常占输入 token 的 80~95%）直接归零
 *   · 首字延迟从「几乎不用算」变成「全量预填充」
 *
 * Magpie 的做法（从它的路由日志与二进制里的提示文案还原）：
 *   **对话跟着「上次回答它的那个账号」走**，只要它还能答；
 *   「还能答」的判据不是「更便宜」，而是「它的缓存还算新鲜」。
 * 它把这件事做成一个可调档位：
 *     session  整段会话钉住
 *     turn     只在一个 turn 内钉住（工具结果回传时），用户再说话就重挑
 *     strict   死活不换（超额也报错给上游，让调用方自己决定）
 *     off      每次重新挑
 *     (默认)   一个 turn 内必钉住；跨 turn 只要缓存还新鲜就钉住
 *
 * 这份文件实现同一套语义，但**口径按 ManageAPI 的现状来**：
 *   · ManageAPI 网关是**无状态转发**，拿不到客户端会话（没有 session 头）
 *   · 所以会话标识只能自己造：用「API Key + 对话开头特征」做指纹
 *   · 缓存新鲜度用「距上次命中缓存有多久」+「上次实际用了多少缓存」判断
 *
 * ## 与 Magpie 的差异（说清楚，不假装一模一样）
 *
 * Magpie 是**有状态网关**：它自己转发、自己记账、能看到自己的会话表。
 * ManageAPI 也是网关，但模型侧是「一堆供给」，且客户端可能直连也可能走网关——
 * 所以指纹要能在「客户端没给会话 id」时也大致稳定。这里用
 * `keyId + 首条消息的 simhash` 作为会话标识：同一次对话里首条消息不变，
 * 因此指纹稳定；不同对话首条消息几乎必然不同，因此能区分。
 *
 * ## 纯函数
 *
 * 本模块不写 db。调用方拿到 `{ hold, reason }` 后自己决定要不要采用。
 */

import { createHash } from 'node:crypto'

/** 亲和模式。与 Magpie 的档位一一对应。 */
export const AFFINITY = {
  /** 默认：一个 turn 内必钉；跨 turn 只要缓存新鲜就钉 */
  AUTO: 'auto',
  /** 整段会话钉住 */
  SESSION: 'session',
  /** 只在一个 turn 内钉住 */
  TURN: 'turn',
  /** 死活不换 */
  STRICT: 'strict',
  /** 每次重挑 */
  OFF: 'off',
}

export const AFFINITY_LABELS = {
  [AFFINITY.AUTO]: '自动（缓存还新鲜就钉住）',
  [AFFINITY.SESSION]: '整段会话',
  [AFFINITY.TURN]: '只在单个 turn 内',
  [AFFINITY.STRICT]: '绝不换人',
  [AFFINITY.OFF]: '每次重挑',
}

/** 缓存「还新鲜」的判定阈值（毫秒）。超过就当过期，允许重挑。 */
export const FRESH_MS = {
  /** 默认档：15 分钟内算新鲜（对齐主流上游的 prompt cache TTL 量级） */
  [AFFINITY.AUTO]: 15 * 60_000,
  [AFFINITY.SESSION]: Infinity,
  [AFFINITY.TURN]: 0,
  [AFFINITY.STRICT]: Infinity,
  [AFFINITY.OFF]: 0,
}

/**
 * 缓存复用率低于这个值时，认为「钉住也没省到钱」，允许重挑。
 * 0.3 是个保守值：低于三成说明上下文基本没命中，钉住的收益不足以抵消
 * 「一直用次优供给」的损失。
 */
export const MIN_CACHE_REUSE = 0.3

/**
 * 从一次请求的消息体里算一个稳定的对话指纹。
 *
 * 为什么用「首条 user 消息」而不是整段：
 *   · 首条消息在整段对话里恒定不变 —— 每轮都带着，所以指纹稳定
 *   · 整段消息每轮都变，用它当指纹等于每次都新会话
 *
 * 为什么不直接用 system prompt：不同对话常常共用同一个 system prompt，
 * 区分度不够。
 *
 * @param {object} opts
 * @param {string} opts.keyId      网关 Key id（不同 Key 天然是不同对话）
 * @param {Array}  opts.messages   OpenAI 格式的消息数组
 * @returns {string|null}          指纹；拿不到可辨识内容时返回 null
 */
export function conversationFingerprint({ keyId, messages }) {
  if (!Array.isArray(messages) || !messages.length) return null
  // 找第一条 user 消息；找不到就退回第一条
  const first = messages.find((m) => m?.role === 'user') ?? messages[0]
  const text = typeof first?.content === 'string'
    ? first.content
    : Array.isArray(first?.content)
      // 多段内容（文本 + 图片）只取文本部分，图片 URL 每轮可能变
      ? first.content.filter((p) => p?.type === 'text').map((p) => p.text).join('')
      : ''
  const norm = String(text).trim().slice(0, 4000)
  if (!norm) return null
  return createHash('sha256').update(`${keyId ?? '-'}\u0000${norm}`).digest('hex').slice(0, 24)
}

/**
 * 判断这一轮该不该钉住上次服务它的那个供给。
 *
 * @param {object} opts
 * @param {string} opts.mode         AFFINITY 之一
 * @param {object|null} opts.record 上次的记录 { offerId, modelKey, at, cacheRead, inputTokens }
 * @param {boolean} opts.withinTurn 当前是否还在同一个 turn（有工具结果回传）
 * @param {number} [opts.now]
 * @returns {{ hold: boolean, reason: string, why: string }}
 *   hold=true 表示「别换人，继续用它」，调用方应按 record.offerId 派活
 */
export function shouldHold({ mode, record, withinTurn, now = Date.now() }) {
  const m = Object.values(AFFINITY).includes(mode) ? mode : AFFINITY.AUTO

  if (m === AFFINITY.OFF) {
    return { hold: false, reason: 'off', why: '每次重新挑选' }
  }
  if (!record?.offerId) {
    return { hold: false, reason: 'first', why: '这段对话还没有服务记录' }
  }

  // strict：无论什么情况都不换（超额也交给上游报错，让调用方决定）
  if (m === AFFINITY.STRICT) {
    return { hold: true, reason: 'strict', why: '绝不换人模式' }
  }

  // turn：只在一个 turn 内钉住
  if (m === AFFINITY.TURN) {
    return withinTurn
      ? { hold: true, reason: 'turn', why: '同一个 turn 内（工具结果回传），不换人' }
      : { hold: false, reason: 'new-turn', why: '新的一轮开始，重新挑选' }
  }

  // auto 与 session：先看是否同一 turn（同一 turn 必钉）
  if (withinTurn) {
    return { hold: true, reason: 'turn', why: '同一个 turn 内（工具结果回传），不换人' }
  }

  // 跨 turn：看缓存还新不新鲜
  const age = now - Number(record.at ?? 0)
  const ttl = FRESH_MS[m] ?? FRESH_MS[AFFINITY.AUTO]
  if (age > ttl) {
    return {
      hold: false,
      reason: 'stale',
      why: `距上次已 ${Math.round(age / 60000)} 分钟，缓存已过期，重新挑选`,
    }
  }

  // 缓存复用率太低说明钉住也省不到
  const cacheRead = Number(record.cacheRead ?? 0)
  const inputTokens = Number(record.inputTokens ?? 0)
  if (inputTokens > 0) {
    const reuse = cacheRead / (cacheRead + inputTokens)
    if (reuse < MIN_CACHE_REUSE) {
      return {
        hold: false,
        reason: 'low-reuse',
        why: `上次缓存复用率只有 ${(reuse * 100).toFixed(0)}%，钉住省不到钱，重新挑选`,
      }
    }
  }

  return {
    hold: true,
    reason: m === AFFINITY.SESSION ? 'session' : 'cache',
    why: `这段对话之前由它服务，缓存还新鲜（${Math.round(age / 1000)} 秒前），沿用`,
  }
}

/**
 * 把「该不该钉住」融合进自动路由的选择结果。
 *
 * 这是与 pickAutoRoute 的接缝：pickAutoRoute 回答「谁最好」，
 * 这个函数回答「但要不要为了缓存忍一下」。
 *
 * @param {object} opts
 * @param {object} opts.pick      pickAutoRoute 的结果（含 offerId / modelKey / metric）
 * @param {object|null} opts.record 上次记录
 * @param {string} opts.mode       AFFINITY 之一
 * @param {boolean} opts.withinTurn
 * @param {number} [opts.now]
 * @returns {{ pick: object, held: boolean, affinity: object }}
 *   如果决定钉住，返回的是「上次那个」而不是「当前最优那个」
 */
export function applyAffinity({ pick, record, mode, withinTurn, now = Date.now() }) {
  const verdict = shouldHold({ mode, record, withinTurn, now })

  // 不钉 或 拿不到上次的供给信息 → 保持 pickAutoRoute 的选择
  if (!verdict.hold || !record?.offerId) {
    return { pick, held: false, affinity: verdict }
  }

  // 要钉住：如果最优本来就是它，不用改
  if (pick && pick.offerId === record.offerId) {
    return { pick, held: true, affinity: { ...verdict, reason: 'kept-best' } }
  }

  // 否则把选择改回上次那个（这正是 Magpie 的做法：宁可不用最优，也不废掉缓存）
  return {
    pick: {
      ...pick,
      offerId: record.offerId,
      providerId: record.providerId ?? pick?.providerId ?? null,
      providerName: record.providerName ?? pick?.providerName ?? null,
      upstreamName: record.upstreamName ?? pick?.upstreamName ?? null,
      modelKey: record.modelKey ?? pick?.modelKey ?? null,
      group: record.group ?? pick?.group ?? '',
      // 保留真实最优的指标，便于面板解释「为什么没选它」
      metric: pick?.metric,
      bestOfferId: pick?.offerId ?? null,
      heldForCache: true,
      switched: false,
      reason: verdict.reason,
      why: verdict.why,
    },
    held: true,
    affinity: verdict,
  }
}

/**
 * 从一次已完成的请求里提炼下次要用的记录。
 *
 * @param {object} opts
 * @param {object} opts.pick     这次实际用的选择
 * @param {object} opts.usage    这次的实际用量 { cachedTokens, inputTokens }
 * @param {number} [opts.now]
 */
export function recordFrom({ pick, usage, now = Date.now() }) {
  if (!pick?.offerId) return null
  return {
    offerId: pick.offerId,
    providerId: pick.providerId ?? null,
    providerName: pick.providerName ?? null,
    upstreamName: pick.upstreamName ?? null,
    modelKey: pick.modelKey ?? null,
    group: pick.group ?? '',
    at: now,
    cacheRead: Number(usage?.cachedTokens ?? 0),
    inputTokens: Number(usage?.inputTokens ?? 0),
  }
}

/**
 * 从 settings 里取一段对话的服务记录。
 * 这是给 auto-route.js 用的便捷封装：那边拿到的只有 settings，
 * 不想让它自己再 normalize 一遍整个 autoRoute 状态。
 *
 * @param {object} settings
 * @param {string|null} fingerprint
 * @returns {object|null}
 */
export function readAffinity(settings, fingerprint) {
  if (!fingerprint) return null
  const table = settings?.autoRoute?.conversations
  if (!table || typeof table !== 'object') return null
  return table[fingerprint] ?? null
}

/** 面板展示用的档位清单。 */
export function listAffinityModes() {
  return Object.values(AFFINITY).map((id) => ({
    id,
    label: AFFINITY_LABELS[id],
    freshMs: Number.isFinite(FRESH_MS[id]) ? FRESH_MS[id] : null,
  }))
}
