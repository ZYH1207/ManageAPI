/**
 * 协议探查记录：每次探查的结果落一份到 db.protocolProbes。
 *
 * 为什么单独一个文件：存取口径（留哪些字段、怎么清理）收在一处，server.js 只管调。
 * 探查结果里 requests / evidence 很占地方，记录里裁掉——记录回答的是
 * 「这次探查看出来是什么」，不是原始报文。
 *
 * 保留策略：默认永不自动清（用户要看完整历史）；开了「自动清理」才按天数删旧记录。
 */

/** 幂等：db 里没有这个键就补上。migrate 和读取路径都调它。 */
export function ensureProtocolRecords(db) {
  if (!Array.isArray(db.protocolProbes)) db.protocolProbes = []
  return db
}

/**
 * 存一条探查记录。**每次探查都追加一条**，不去重、不封顶：
 * 协议记录页对应的是完整历史库，重测同一模型也是一次新证据（站方可能改了实现）。
 * 清理只走两条路：用户手动删，或开了「按天自动清理」。
 */
export function saveProtocolRecord(db, record) {
  ensureProtocolRecords(db)
  db.protocolProbes.push(record)
  return record
}

export function removeProtocolRecord(db, id) {
  ensureProtocolRecords(db)
  const before = db.protocolProbes.length
  db.protocolProbes = db.protocolProbes.filter((row) => row.id !== id)
  return before - db.protocolProbes.length
}

export function clearProtocolRecords(db) {
  ensureProtocolRecords(db)
  const removed = db.protocolProbes.length
  db.protocolProbes = []
  return removed
}

/**
 * 按天自动清理：删掉比 maxAgeDays 天更旧的记录。返回删了几条。
 * maxAgeDays <= 0 视为关闭，不动任何数据。
 */
export function pruneProtocolRecords(db, maxAgeDays) {
  ensureProtocolRecords(db)
  const days = Number(maxAgeDays) || 0
  if (days <= 0) return 0
  const cutoff = Date.now() - days * 86400_000
  const before = db.protocolProbes.length
  db.protocolProbes = db.protocolProbes.filter((row) => {
    const ts = Date.parse(row.ts || '')
    return !(Number.isFinite(ts) && ts < cutoff)
  })
  return before - db.protocolProbes.length
}

/**
 * 从探查结果提取要落库的字段：丢掉 requests / evidence（大且只对单次调试有用），
 * 保留结论与能力明细（记录页要点开看「哪些能力缺失」）。
 */
export function buildProtocolRecord({ result, target, statusTags = [], badStatus = false }) {
  const protocols = {}
  for (const [id, protocol] of Object.entries(result.protocols || {})) {
    protocols[id] = {
      id,
      label: protocol.label,
      short: protocol.short,
      path: protocol.path,
      surface: {
        outcome: protocol.surface?.outcome ?? 'unknown',
        httpStatus: protocol.surface?.httpStatus ?? null,
        shape: protocol.surface?.shape ?? 'unknown',
        latencyMs: protocol.surface?.latencyMs ?? null,
        error: protocol.surface?.error ?? null,
      },
      real: protocol.real || { id: 'unknown', label: '无法判定', confidence: 'low', note: '' },
      verdict: protocol.verdict || null,
      summary: protocol.summary || { pass: 0, fail: 0, flaky: 0, unknown: 0, total: 0 },
      capabilities: (protocol.capabilities || []).map((cap) => ({
        id: cap.id,
        name: cap.name,
        desc: cap.desc,
        status: cap.status,
        detail: cap.detail || '',
      })),
    }
  }
  return {
    id: `pp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    ts: result.finishedAt || new Date().toISOString(),
    durationMs: result.durationMs ?? null,
    probeBy: target.mode || 'gateway',
    offerId: target.offerId ?? null,
    providerId: target.providerId ?? null,
    providerName: target.providerName ?? null,
    group: target.group ?? '',
    baseUrl: result.target?.baseUrl || target.baseUrl,
    model: result.target?.model || target.model,
    label: target.label || `${target.baseUrl} / ${target.model}`,
    anthropicSkipped: Boolean(target.anthropicSkipped),
    nativeAnthropicModel: Boolean(target.nativeAnthropicModel),
    mode: result.mode || 'full',
    repeat: result.repeat || 1,
    advice: result.advice || null,
    skippedProtocols: result.skippedProtocols || [],
    statusTags,
    badStatus,
    protocols,
    summary: result.summary || null,
  }
}
