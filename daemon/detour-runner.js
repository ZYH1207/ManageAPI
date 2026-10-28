/**
 * 改道复检：原站被空回合守卫挂起之后，每 20 分钟悄悄摸一次，
 * 连续正常几次就把流量切回去。
 *
 * 为什么不能直接复用探针：探针测的是「模型老不老实」（指纹/截断/计费），
 * 根本不带 tools，所以它一直显示健康——而这里的病恰恰是「带 tools 时工具调用
 * 被上游吞掉」。拿探针复检等于永远复检不出结果，改道永远解除不了。
 *
 * 所以复检专门打一个**必须调工具**的最小请求：给一个只有一种用法的工具，
 * 看模型会不会真的调它。调了 = 翻译层恢复正常；不调 = 还是老样子，
 * 继续挂着，20 分钟后再摸。
 *
 * 只发一次小请求（几百 token），代价可以忽略；并且只在有生效改道时才跑。
 */
import * as store from '../core/store.js'
import * as inv from '../core/inventory.js'
import { activeDetours, noteDetourCheck } from '../core/empty-guard.js'
import { buildFaultSignal, publishFault } from '../core/fault-signal.js'

/** 复检用的工具：只有一个参数，必须调才答得出来，没法用文字糊过去 */
const PROBE_TOOL = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the content of a file. You must call this to answer.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'absolute file path' } },
        required: ['path'],
      },
    },
  },
]

const PROBE_MESSAGES = [
  {
    role: 'user',
    content: 'Read the file /etc/manage-api-probe using the read_file tool, then report its content.',
  },
]

/**
 * 对一个「站 × 模型」做一次带 tools 的复检。
 * @returns {{ok:boolean, hasToolCall:boolean, textChars:number, error:string|null, ms:number}}
 */
async function probeToolCall({ baseUrl, apiKey, model, timeoutMs = 30000 }) {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: PROBE_MESSAGES,
        tools: PROBE_TOOL,
        tool_choice: 'auto',
        max_tokens: 200,
        temperature: 0,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      return { ok: false, hasToolCall: false, textChars: 0, error: `HTTP ${res.status}`, ms: Date.now() - startedAt }
    }
    const payload = await res.json()
    const message = payload?.choices?.[0]?.message || {}
    const hasToolCall = Boolean(message.tool_calls?.length)
    const textChars = String(message.content || '').length
    // 判定口径与守卫一致：真的调了工具才算恢复。只回一段文字说明「我不能读文件」
    // 不算——那正是「工具调用丢了」的另一种表现
    return { ok: hasToolCall, hasToolCall, textChars, error: null, ms: Date.now() - startedAt }
  } catch (error) {
    return {
      ok: false,
      hasToolCall: false,
      textChars: 0,
      error: error?.name === 'AbortError' ? '复检超时' : error?.message || String(error),
      ms: Date.now() - startedAt,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 检查所有该复检的改道。
 *
 * @param {{logger?:Console}} options
 * @returns {Promise<Array>} 每个复检的结果
 */
export async function runDetourRechecks({ logger = console } = {}) {
  const db = await store.readDb()
  const detours = [...activeDetours(db).values()]
  if (detours.length === 0) return []

  const now = Date.now()
  const results = []

  for (const detour of detours) {
    const lastCheck = detour.lastCheckAt ? Date.parse(detour.lastCheckAt) : Date.parse(detour.since || '')
    const intervalMs = Number(detour.recheckMs) || 20 * 60_000
    if (Number.isFinite(lastCheck) && now - lastCheck < intervalMs) continue

    const offer = db.offers.find((o) => o.id === detour.offerId)
    const provider = db.providers.find((p) => p.id === detour.providerId)
    // 站点删了 / 模型下线了：改道已经没有意义，直接结掉
    if (!offer || !provider || offer.delistedAt) {
      await inv.resolveEmptyDetour(detour.offerId, { reason: 'gone' }).catch(() => {})
      results.push({ offerId: detour.offerId, ok: false, resolved: 'gone' })
      continue
    }

    // 余额探底的站不撞墙：复检本身也是一次真实请求，403 只会白摳一个来回。
    // 不结改道只跳过——余额回上线后这里自然恢复复检，改道照常自动解除
    if (inv.balanceDepleted(provider)) {
      results.push({ offerId: detour.offerId, ok: false, skipped: 'balance-depleted' })
      continue
    }

    const credential =
      (offer.credentialId && db.credentials.find((c) => c.id === offer.credentialId)) ||
      db.credentials.find((c) => c.providerId === provider.id && (c.group || '') === (offer.group || '')) ||
      db.credentials.find((c) => c.providerId === provider.id)
    if (!credential) {
      await inv.resolveEmptyDetour(detour.offerId, { reason: 'no-credential' }).catch(() => {})
      results.push({ offerId: detour.offerId, ok: false, resolved: 'no-credential' })
      continue
    }

    const apiKey = await inv.revealSecret(credential.id)
    if (!apiKey) {
      results.push({ offerId: detour.offerId, ok: false, error: 'Key 解密失败' })
      continue
    }

    const check = await probeToolCall({
      baseUrl: provider.baseUrl,
      apiKey,
      model: offer.upstreamName,
      timeoutMs: Math.min(Number(db.settings.probeTimeoutMs) || 30000, 30000),
    })

    const row = await inv.noteEmptyDetourCheck(detour.offerId, { ok: check.ok })
    // 复检通过并把改道解除 → 告诉路由「这家可以放回来了」。
    // 没这一步的话，自动路由只会收到「有问题」、永远收不到「好了」，
    // 那家站就再也没机会被选中
    if (row?.resolvedAt && check.ok) {
      await inv.clearFaults({ offerId: detour.offerId }).catch(() => {})
      publishFault(
        buildFaultSignal({
          kind: 'empty-turn',
          level: 'notice',
          active: false,
          scope: {
            providerId: detour.providerId,
            providerName: detour.providerName,
            offerId: detour.offerId,
            modelKey: detour.modelKey,
            model: detour.model,
          },
          reason: '复检连续正常，已解除改道',
          suggested: 'none',
        }),
      )
    }
    logger.info?.(
      `[改道复检] ${provider.name} ${offer.upstreamName}：${check.ok ? '工具调用正常' : `仍然不通（${check.error || '没有 tool_calls'}）`}` +
        (row?.resolvedAt ? '，已解除改道' : ''),
    )
    results.push({ offerId: detour.offerId, ...check, resolved: row?.resolvedAt ? 'recovered' : null })
  }

  return results
}
