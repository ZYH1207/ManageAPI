/**
 * 上游协议判定：这一条供给该用 /chat/completions 还是原生 /messages。
 *
 * 为什么需要它（2026-11-12 实测）：
 *   网关原来对 anthropic 客户端一律「翻成 Chat 打上游 /chat/completions」。
 *   绝大多数中转站确实只有这一条路，所以那是合理的默认。但**只提供原生
 *   /v1/messages 的站**（实测 rapid 的 Rapid-Kiro 分组）在 /chat/completions
 *   上不吐任何字节，客户端直接挂到超时；同一个 offer 走 /messages 立刻有回应。
 *
 * 判定顺序（前者覆盖后者）：
 *   1. offer 上的显式标记 `upstreamProtocol`：'chat' | 'anthropic'
 *      —— 供给级开关，用户在后台点一下就能钉死，不猜。
 *   2. 学到的结果（settings.upstreamProtocols，键 = providerId::group::模型名）
 *      —— 上一次真实请求失败后自动记下来的「这条路走不通 / 走这条能通」。
 *   3. 模型名像 Anthropic 系（claude / anthropic）且该分组从来没成功过 chat
 *      —— 这条不能默认，见 shouldTryNativeAnthropic 的注释。
 *   4. 都没有 → 'chat'（保持改造前的行为，不动绝大多数站）。
 *
 * 判定的唯一约束：**只影响「往上游打哪个路径」，不影响路由、评分、计费**。
 * 所以本文件是纯函数 + 一个轻量的设置读写，不碰任何派活逻辑。
 */

/** 上游协议取值。'auto' 表示交给本文件判定。 */
export const UPSTREAM_PROTOCOLS = Object.freeze(['auto', 'chat', 'anthropic', 'responses'])

/** 模型名是否像 Anthropic 系。与 daemon 里 looksAnthropic 同口径，避免两套判断。 */
export function looksAnthropicModel(name) {
  return /claude|anthropic/i.test(String(name || ''))
}

/** 学习记录的键：站 + 分组 + 上游模型名（与 modelOverrides 的写法一致）。 */
export function protocolKey({ providerId, group, model }) {
  if (!providerId) return ''
  return `${providerId}::${group || ''}::${String(model || '')}`
}

/** 上游路径：三种协议各自的真实端点。 */
export function upstreamPathFor(protocol) {
  if (protocol === 'anthropic') return '/messages'
  if (protocol === 'responses') return '/responses'
  return '/chat/completions'
}

/**
 * 判定一条供给该走哪个上游协议。
 *
 * @param {object} candidate 路由候选（streamAttempt 拿到的那种：offer / credential / provider）
 * @param {object} settings  网关 settings（读 upstreamProtocols 学习表）
 * @returns {{ protocol: 'chat'|'anthropic'|'responses', source: string, reason: string }}
 */
export function resolveUpstreamProtocol(candidate, settings, { clientProtocol = 'chat' } = {}) {
  const offer = candidate?.offer || {}
  const provider = candidate?.provider || {}
  const credential = candidate?.credential || {}

  // 1) 供给级显式标记：用户在后台钉死的，最高优先级
  const explicit = String(offer.upstreamProtocol || '').trim()
  if (explicit === 'anthropic' || explicit === 'chat' || explicit === 'responses') {
    return { protocol: explicit, source: 'offer', reason: `该供给显式指定 ${explicit}` }
  }

  // 2) 学到的结果
  const model = offer.upstreamName || offer.modelKey || ''
  const key = protocolKey({ providerId: provider.id, group: offer.group || credential.group, model })
  const learned = settings?.upstreamProtocols && key ? settings.upstreamProtocols[key] : null
  const learnedMode = learned && typeof learned === 'object' ? String(learned.mode || '') : ''
  if (learnedMode === 'anthropic' || learnedMode === 'chat' || learnedMode === 'responses') {
    return {
      protocol: learnedMode,
      source: 'learned',
      reason: learned.note || `上次实测该供给走 ${learnedMode} 可用`,
    }
  }

  // 3) 默认跟随客户端协议（与改造前完全一致）。
  //
  //    responses 客户端 → 上游 /responses：这是改造前就有的行为，不能丢。
  //    chat / anthropic  → 上游 /chat/completions：anthropic 客户端在入口已经被
  //                        anthropicToChat 翻成 Chat，往上游自然也是 Chat 形状。
  //
  //    为什么不按「模型名像 Claude」就自动切原生 /messages：
  //    绝大多数中转站的 Claude 也只在 /chat/completions 上提供服务（它们内部再翻），
  //    一刀切会把这些站全部打挂 —— 那是比现状更大的破坏。
  //    真正需要原生的站由 1）/2）两条路解决：用户显式标记，或失败后自动学习。
  const fallback = clientProtocol === 'responses' ? 'responses' : 'chat'
  return {
    protocol: fallback,
    source: 'default',
    reason: fallback === 'responses'
      ? 'Responses 客户端继续走 /responses'
      : '默认走 /chat/completions（绝大多数中转站只有这条路）',
  }
}

/**
 * 这次失败值不值得记成「该换原生 anthropic」。
 *
 * 只在一种情况下记：模型是 Anthropic 系 + 走的是 chat + 失败形态像「上游不认这条路」
 * （超时 / 空响应 / 404）。明确的 429 限流、401 鉴权不算 —— 那些换协议也没用，
 * 记下来反而会把正常站带偏。
 */
export function shouldLearnNativeAnthropic({ model, protocol, error }) {
  if (protocol !== 'chat') return false
  if (!looksAnthropicModel(model)) return false
  const text = String(error || '')
  if (/rate limit|429|限流/i.test(text)) return false
  if (/401|403|unauthorized|invalid.*key|Key.*无效|鉴权/i.test(text)) return false
  return /超时|timeout|无响应|空响应|no answer|404|not found|全部失败/i.test(text)
}

/** 记一条学习结果（就地改 db，由调用方负责 mutate/落盘）。 */
export function learnUpstreamProtocol(db, { providerId, group, model, mode, note }) {
  if (!db || !db.settings || !providerId) return false
  const key = protocolKey({ providerId, group, model })
  if (!key) return false
  if (!db.settings.upstreamProtocols || typeof db.settings.upstreamProtocols !== 'object') {
    db.settings.upstreamProtocols = {}
  }
  db.settings.upstreamProtocols[key] = {
    mode: mode === 'anthropic' ? 'anthropic' : 'chat',
    note: String(note || '').slice(0, 200),
    at: new Date().toISOString(),
  }
  return true
}

/** 清掉某条供给的学习结果（用户手动改回时用）。 */
export function forgetUpstreamProtocol(db, { providerId, group, model }) {
  const key = protocolKey({ providerId, group, model })
  if (!key || !db?.settings?.upstreamProtocols) return false
  if (!Object.prototype.hasOwnProperty.call(db.settings.upstreamProtocols, key)) return false
  delete db.settings.upstreamProtocols[key]
  if (Object.keys(db.settings.upstreamProtocols).length === 0) delete db.settings.upstreamProtocols
  return true
}
