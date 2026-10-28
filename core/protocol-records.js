/**
 * 协议探查记录：每次探查的结果落一份到 db.protocolProbes。
 *
 * 为什么单独一个文件：存取口径（留哪些字段、上限多少条、列表视图裁掉什么）
 * 收在一处，server.js 只管调。探查结果里 requests / evidence 很占地方，
 * 记录里裁掉——记录回答的是「这个模型上次测出来是什么」，不是原始报文。
 */

/** 最多留多少条：一条完整能力明细约 6KB，60 条 ≈ 0.4MB，和 db.json 其余部分一个量级 */
export const MAX_RECORDS = 60

/** 幂等：db 里没有这个键就补上。migrate 和读取路径都调它。 */
export function ensureProtocolRecords(db) {
  if (!Array.isArray(db.protocolProbes)) db.protocolProbes = []
  return db
}

/**
 * 存一条探查记录。同一目标（同站同分组同模型，或同一手动地址+模型）只留最新一条
 * ——「模型协议记录」回答的是每个模型当前是什么协议形态，历史堆叠只会让人看花眼。
 */
export function saveProtocolRecord(db, record) {
  ensureProtocolRecords(db)
  const key = recordKey(record)
  const rest = db.protocolProbes.filter((row) => rowKey(row) !== key)
  rest.push(record)
  db.protocolProbes = rest.slice(-MAX_RECORDS)
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

function rowKey(row) {
  return rowKeyOf({ mode: row.mode, offerId: row.offerId, baseUrl: row.baseUrl, model: row.model })
}

function recordKey(record) {
  return rowKeyOf({
    mode: record.mode,
    offerId: record.offerId,
    baseUrl: record.baseUrl,
    model: record.model,
  })
}

function rowKeyOf({ mode, offerId, baseUrl, model }) {
  return `${mode || 'gateway'}::${offerId || ''}::${String(baseUrl || '').toLowerCase()}::${model || ''}`
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
      summary: protocol.summary || { pass: 0, fail: 0, unknown: 0, total: 0 },
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
    mode: target.mode || 'gateway',
    offerId: target.offerId ?? null,
    providerId: target.providerId ?? null,
    providerName: target.providerName ?? null,
    group: target.group ?? '',
    baseUrl: result.target?.baseUrl || target.baseUrl,
    model: result.target?.model || target.model,
    label: target.label || `${target.baseUrl} / ${target.model}`,
    anthropicSkipped: Boolean(target.anthropicSkipped),
    skippedProtocols: result.skippedProtocols || [],
    statusTags,
    badStatus,
    protocols,
    summary: result.summary || null,
  }
}
