/**
 * 存储层：数据目录定位、JSON 原子读写、凭据加解密。
 *
 * 设计约束：
 * - 数据目录独立于宿主（默认 ~/.manage-api），DSH 插件壳与独立 daemon 共用同一份。
 * - 单进程写入 + 原子替换（写 tmp 再 rename），避免半写坏文件。
 * - 凭据用 AES-256-GCM 加密，密钥存本地 master.key（0600）。
 *   威胁模型：防备份泄露 / 误传文件；不防本机已被攻破的情况。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile, chmod, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { ensureMonitor, defaultMonitor } from './monitor.js'
import { ensureProtocolRecords } from './protocol-records.js'
import { ensureEmptyEvents } from './empty-guard.js'
import { ensureFaultSignals } from './fault-signal.js'
import { ensureDiagnosisKeys } from './offer-stats.js'
import { ensureFaultKeys } from './fault-reporter.js'
import { writeJsonAtomic } from './fsx.js'
// 模型身份键（零依赖文件，不会与 store 成环）
import { identityKey } from './model-name.js'

// v5 = 协议探查记录 / 空回合记录 / 故障信号
// v6 = 模型名身份归一（别名表）
// v7 = 诊断地基（错误指纹账本 / 供给表现时序 / 故障上报配置）
export const DB_VERSION = 7

/**
 * 归一化分组名。定义在存储层（零依赖），台账层再导出——两边共用同一份，
 * 不允许各自写一份 trim，那正是「同步去重键与写入口径不一致」的根源。
 *
 * 分组名是从站点后台 / 令牌列表抄来的，经常带尾随或连续空白
 * （实测「国模-0045 p哥」与「国模-0045 p哥 」只差一个尾随空格）。
 */
export function normalizeGroup(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
}

/** 写盘串行链（见 mutate） */
let writeChain = Promise.resolve()

/** 数据文件坏了要报 5xx，不能当「参数错误」——这类错误前端做什么都没用 */
export class StorageError extends Error {}

export function dataDir() {
  return process.env.MANAGE_API_HOME || join(homedir(), '.manage-api')
}

export function dbPath() {
  return join(dataDir(), 'db.json')
}

function keyPath() {
  return join(dataDir(), 'master.key')
}

export function emptyDb() {
  return {
    version: DB_VERSION,
    settings: {
      fxUsdCny: 7.2,
      // 汇率的正式结构（见 core/fx.js）：base 恒为 USD，rates[XXX] = 1 美元换多少 XXX。
      // fxUsdCny 只是给老代码留的镜像，每次写入都会同步。
      fx: { base: 'USD', rates: { CNY: 7.2 }, updatedAt: null, source: 'default', manual: false },
      blendInputWeight: 0.25,
      probeTimeoutMs: 45000,
      // 0 = 关闭定时探测
      probeIntervalMinutes: 60,
      // 超过这个小时数的探测结果视为过期，不再参与路由
      scoreMaxAgeHours: 6,
      // 定时关闭检测：每天若干段「暂停探测」的窗口（见 core/schedule.js）。
      // 空数组 = 全天都跑；每段 { id, start: 'HH:MM', end: 'HH:MM' }
      probePauseWindows: [],
      // 首字门槛（毫秒），0 = 不限。只会是 1000~20000 的整档：
      // 取档口径在 core/latency.js#snapTtftMs，写入侧（PATCH）负责归一
      maxTtftMs: 0,
      // 决策侧重（智能决策页顶部四档）：value = 性价比（价格 ÷ 质量，默认）、
      // price = 名义价格、speed = 首字速度、priceSpeed = 价速比（价格 ÷ 首字延迟）。
      // 只改排序，不改准入，口径见 core/decision-mode.js
      decisionMode: 'value',
      // 自动路由（一键接管）：开启后网关无视客户端请求的模型名，
      // 始终派给当前决策档位下全场最优的模型（口径见 core/auto-route.js）。
      // modelKey / offerId / pickedAt / reason 是最近一次挑选的落盘记录，
      // 决策页「正在使用」照着显示；归一化与挑选逻辑只有 core/auto-route.js 一份
      autoRoute: { enabled: false, modelKey: null, offerId: null, pickedAt: null, reason: null, failoverFrom: null },
      // 故障转移上报令牌：外部监控系统拿它证明身份（POST /api/failover/report）。
      // daemon 启动时自动生成一次（core/failover.js#ensureFailoverToken），这里只是形状占位
      failoverToken: null,
      // 看板顶部结论句自己的档位：和 decisionMode 分开——路由按策略派活，
      // 看板只是换一个角度看同一批「能登场」的站，两边互不干扰
      headlineMode: 'value',
      // 看板顶部第二句（全场冠军行）自己的档位：口径同上，但和 headlineMode 分开存——
      // 上面看某个模型的速度、下面看全场谁最便宜，两句话各看各的
      championMode: 'value',
      // 看板顶部结论句里选中的模型（归一化 key）；null = 自动挑（用量 > 手动排序 > 探过）
      focusModel: null,
      // 放行可疑供给：默认 false，探针判定不可信/过期的会被排到后面。
      // 打开后它们按当前决策侧重正常参与竞争——风险由用户自己承担。
      allowUntrusted: false,
      // 免费池跨栏偏好：同一个模型同时出现在中转站与平台时怎么选。
      //   'platform'  平台优先（更怕假货）
      //   'relay'     中转站优先（更怕断供）
      //   'remaining' 按「预计剩余天数」跨栏混排（默认）
      freeCrossPane: 'remaining',
      // 免费池耗尽时是否允许回落付费。默认关闭——静默花钱比报错更糟。
      allowPaidFallback: false,
      // 监控采集间隔（分钟），0 = 关闭。
      // 和探针是两个节奏：探针要打真实请求，成本高；采集只是读后台数据，可以更勤。
      monitorIntervalMinutes: 30,
      // 余额低于这个美元金额就告警（人民币站按汇率折算后比）。0 = 不告警。
      // 之所以用美元：中转站余额基本都是美元，用人民币要先折一次，多一层容易错。
      balanceWarnUsd: 1.5,
      // 价格展示币种：只影响渲染，不影响比较口径（比较一律用美元）。
      displayCurrency: 'USD',
      // 协议记录按天自动清理：0 = 永不自动清（默认）；>0 = 删掉比这个天数更旧的记录。
      // 清理动作在读记录页时惰性执行（core/protocol-records.js#pruneProtocolRecords）。
      protocolRecordMaxAgeDays: 0,
      // 空回合守卫（异常诊断页）：上游只吐了思考、正文和工具调用都空的时候自动补问。
      //   enabled  默认关闭——它是个「我遇到了才要开」的开关，不是常开功能
      //   mode     'same' = 同站再问一遍（便宜、不换上下文）
      //            'switch' = 换一家再问（同站必然犯病时才管用）
      // 判定口径与记录结构在 core/empty-guard.js，网关取用见 daemon/server.js
      emptyGuard: { enabled: false, mode: 'same' },
    // 全局忽略的模型（归一化后的 key）：不参与比价、决策、探针、网关
    ignoredModels: [],
    /**
     * 模型名别名表：modelBaseKey → 目标键。
     * 自动归一（4-5 ↔ 4.5 / v 前缀 / 日期尾巴）不需要写这里；
     * 这里只存**用户决定的合并/拆开**——因为规则归一只能处理「形状」，
     * 涉及语义（-thinking 是不是同一个模型、-highspeed 是不是另一个价）必须人拍。
     */
    modelAliases: {},
    },
    providers: [],
    credentials: [],
    offers: [],
    probes: [],
    // 故障转移上报记录（外部监控系统的真实故障）：判定与接口见 core/failover.js
    failover: { reports: [] },
    // 监控时序数据（余额快照 / 倍率变动 / 公告 / 告警）
    monitor: defaultMonitor(),
  }
}

async function exists(p) {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

let keyCache = null

async function masterKey() {
  if (keyCache) return keyCache
  await mkdir(dataDir(), { recursive: true })
  const p = keyPath()
  if (await exists(p)) {
    const hex = (await readFile(p, 'utf8')).trim()
    if (hex.length !== 64) throw new Error(`master.key 格式异常：${p}`)
    keyCache = Buffer.from(hex, 'hex')
    return keyCache
  }
  const key = randomBytes(32)
  await writeFile(p, key.toString('hex'), { mode: 0o600 })
  try {
    await chmod(p, 0o600)
  } catch {
    /* Windows 上 chmod 语义有限，忽略 */
  }
  keyCache = key
  return keyCache
}

/** 加密一个明文密钥，返回可直接存进 JSON 的对象。 */
export async function encryptSecret(plain) {
  if (!plain) return null
  const key = await masterKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

/** 解密；失败返回空串，让调用方按"无凭据"处理而不是崩掉。 */
export async function decryptSecret(blob) {
  if (!blob || !blob.data) return ''
  try {
    const key = await masterKey()
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(blob.data, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * 版本迁移。每段都必须是幂等的——用户可能从任意老版本跨级升上来。
 *
 * v1 → v2：把「令牌 / 余额」从 Key 上挪到站点上。
 *   原因：令牌是站点后台的登录凭证，余额是账号余额——两者都跟 Key 无关。
 *   挂在 Key 上会导致「加第二个 Key 后余额显示 0」「换个 Key 就要重填令牌」。
 *   迁移是就地提升：取该站第一个填过令牌的 Key，复制到站点上。
 *   Key 上的旧字段保留不删，万一要回滚还能读。
 *
 * v2 → v3：新增 monitor（余额快照 / 倍率变动 / 公告 / 告警），纯追加，补齐默认值即可。
 *
 * v3 → v4：分组名归一化 + 收敛重复供给。
 *   病因：写 offer 时分组名没归一化（detect-groups 直接把令牌列表的原样写下去，
 *   带尾随空格），而同步时用 trim 过的名字做去重键——两边口径不同，每轮
 *   「同步 + 识别分组」都匹配不上旧行，于是再插一整套。实测一个模型积到 7 份，
 *   比价页同一站点同一分组刷出 7 行一模一样的。
 *   处理：归一化所有分组名；按「站点 + 分组 + 模型名」收敛，重复行上的
 *   探针/流量/手动排序全部重挂到保留行，不丢证据。
 */
function collapseDuplicateOffers(db) {
  const offers = Array.isArray(db.offers) ? db.offers : []
  for (const credential of db.credentials || []) {
    credential.group = normalizeGroup(credential.group)
  }

  const byKey = new Map()
  for (const offer of offers) {
    offer.group = normalizeGroup(offer.group)
    const key = `${offer.providerId}||${offer.group}||${offer.upstreamName}`
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, offer)
      continue
    }
    // 保留「数据更值钱」的那条：手填过价格的优先，其次有真实流量/探针的，
    // 最后才看谁更新。顺序不能反——先比 listedAt 会挑中刚插进来还没填价的新行
    const rank = (o) => [
      o.inPrice != null || o.ratio != null ? 1 : 0,
      db.traffic?.[o.id] ? 1 : 0,
      db.probes?.some((p) => p.offerId === o.id) ? 1 : 0,
      String(o.updatedAt || ''),
    ]
    const a = rank(prev)
    const b = rank(offer)
    let winner = prev
    let loser = offer
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] === b[i]) continue
      const better = b[i] > a[i] ? offer : prev
      winner = better
      loser = b[i] > a[i] ? prev : offer
      break
    }
    byKey.set(key, winner)
    loser.__mergedInto = winner.id
  }

  if (byKey.size === offers.length) return { removed: 0, remapped: 0 }

  const alive = new Set([...byKey.values()].map((o) => o.id))
  const byId = new Map(offers.map((o) => [o.id, o]))
  const remap = new Map()
  for (const offer of offers) {
    if (alive.has(offer.id)) continue
    // 合并可能是链式的（o_b → o_a → o_c）：胜者本身可能后来又被别人赢了，
    // 所以要一直追到真正存活的那行为止，否则探针会重挂到另一条死行上
    let target = offer.__mergedInto
    const guard = new Set([offer.id])
    while (target && !alive.has(target) && !guard.has(target)) {
      guard.add(target)
      target = byId.get(target)?.__mergedInto
    }
    remap.set(offer.id, alive.has(target) ? target : null)
  }
  for (const offer of offers) delete offer.__mergedInto

  // 探针记录不删，改指向保留行——证据是花额度买来的，重挂比丢弃合理
  let remapped = 0
  for (const probe of db.probes || []) {
    const target = remap.get(probe.offerId)
    if (!target) continue
    probe.offerId = target
    remapped += 1
  }

  // 流量计数合并：这些行本来就是同一份供给被拆开的，成败各自累加才还原真实样本
  if (db.traffic && typeof db.traffic === 'object') {
    for (const [deadId, target] of remap) {
      if (!target) continue
      const row = db.traffic[deadId]
      if (!row) continue
      const into = db.traffic[target]
      if (!into) {
        db.traffic[target] = row
      } else {
        into.ok = (into.ok || 0) + (row.ok || 0)
        into.fail = (into.fail || 0) + (row.fail || 0)
        into.quality = {
          samples: (into.quality?.samples || 0) + (row.quality?.samples || 0),
          bad: (into.quality?.bad || 0) + (row.quality?.bad || 0),
        }
        for (const [kind, count] of Object.entries(row.kinds || {})) {
          into.kinds = into.kinds || {}
          into.kinds[kind] = (into.kinds[kind] || 0) + count
        }
      }
      delete db.traffic[deadId]
    }
  }

  // 手动排序：同一条供给的重复 id 去掉，保留首次出现的位置
  if (db.manualOrder && typeof db.manualOrder === 'object') {
    for (const [modelKey, order] of Object.entries(db.manualOrder)) {
      if (!Array.isArray(order)) continue
      const seen = new Set()
      const next = []
      for (const oid of order) {
        const id = remap.get(String(oid)) || String(oid)
        if (seen.has(id)) continue
        seen.add(id)
        next.push(id)
      }
      if (next.length === 0) delete db.manualOrder[modelKey]
      else db.manualOrder[modelKey] = next
    }
  }

  db.offers = offers.filter((o) => alive.has(o.id))
  return { removed: remap.size, remapped }
}
/**
 * 把手动排序重新分配到「当前身份键」下。
 *
 * 两个时机用它：v6 迁移（老库的键还是存储键）、以及**每次改别名表之后**
 * （合并/拆开都会改变身份键）。不重挂的话，用户拖过的顺序会在合并那一刻
 * 静默失效——决策页还显示着那一行，排序却变回默认，不报任何错。
 *
 * 关键：分配的依据是**每条供给自己的身份**，不是旧键的形状。
 * 只看键会把「别名生成的键」误当成一个永久的名字——实测拆开 hy4 时，
 * 它那条顺序挂在 hy4-preview 上，只看键就会原地不动，于是顺序丢了。
 *
 * @param {object} table  旧的 manualOrder（键是旧身份，值是 offerId 数组）
 * @param {Array} offers  当前供给（用来算每条供给的新身份）
 * @param {object} next   新的别名表
 * @param {object} prev   改之前的别名表（迁移时传空对象）
 */
export function remapManualOrderKeys(table, offers, next, prev = {}) {
  if (!table || typeof table !== 'object') return table
  const identityOf = new Map()
  for (const offer of offers || []) {
    identityOf.set(offer.id, identityKey(offer.modelKey || offer.upstreamName || '', next))
  }
  const out = {}
  const push = (key, id) => {
    if (!key) return
    if (!out[key]) out[key] = []
    if (!out[key].includes(id)) out[key].push(id)
  }
  for (const [key, order] of Object.entries(table)) {
    if (!Array.isArray(order)) continue
    for (const rawId of order) {
      const id = String(rawId)
      // 供给还在：按它现在的身份归档；供给已不在：按原键留着（别把顺序吃掉）
      push(identityOf.get(id) || key, id)
    }
  }
  return out
}

function migrate(db) {
  // CNY 退出单位体系（2026-10-29）：只剩 站内 USD / 真实美元 RUSD 两档。
  // CNY 的计费口径与站内 USD 完全相同（1:1），迁移只是改名，不影响任何价格。
  // 放在版本检查之前：它不是结构迁移，而是对新旧库都成立的归一（幂等），
  // 且老客户端若还把 CNY 写进来，下次读取也会自愈
  if (db.settings?.displayCurrency === 'CNY') db.settings.displayCurrency = 'USD'
  for (const offer of db.offers || []) {
    if (String(offer.currency || '').toUpperCase() === 'CNY') offer.currency = 'USD'
  }

  const version = Number(db.version) || 1
  if (version >= DB_VERSION) {
    ensureMonitor(db)
    ensureProtocolRecords(db)
    ensureEmptyEvents(db)
    ensureFaultSignals(db)
    ensureDiagnosisKeys(db)
    ensureFaultKeys(db)
    return db
  }

  for (const provider of db.providers || []) {
    const mine = (db.credentials || []).filter((c) => c.providerId === provider.id)
    if (!provider.adminToken) {
      const withToken = mine.find((c) => c.adminToken)
      if (withToken) {
        provider.adminToken = withToken.adminToken
        provider.adminTokenTail = withToken.adminTokenTail ?? null
      }
    }
    if (provider.quotaRemaining === undefined || provider.quotaRemaining === null) {
      const withQuota = mine.find((c) => typeof c.quotaRemaining === 'number')
      if (withQuota) {
        provider.quotaRemaining = withQuota.quotaRemaining
        provider.currency = withQuota.currency || 'CNY'
        provider.quotaUpdatedAt = withQuota.quotaUpdatedAt ?? null
      }
    }
  }
  // v4：分组名归一化 + 收敛重复供给（幂等，v5 的库里跑一遍也无害）
  const collapse = collapseDuplicateOffers(db)
  if (collapse.removed > 0) {
    console.log(
      `[migrate] v4 合并重复供给 ${collapse.removed} 条，重置指向 ${collapse.remapped} 条探针`,
    )
  }
  // v5：协议探查记录（新键，缺省补空数组，幂等）
  ensureProtocolRecords(db)
  // 空回合记录（新键，纯追加，幂等）
  ensureEmptyEvents(db)
  // 故障信号（新键，纯追加，幂等）
  ensureFaultSignals(db)
  // v6：模型名身份归一。不改 offer.modelKey（那是写给上游的名字，改了就 404）——
  // 合并按规则实时算，老库升上来直接生效。
  const settings = db.settings || (db.settings = {})
  if (!settings.modelAliases || typeof settings.modelAliases !== 'object') {
    settings.modelAliases = {}
  }
  // 手动排序的键要跟着换成身份键：读的时候按身份键查，不迁移就会「拖过的顺序全丢」。
  // 两条老键归到同一个身份时按出现顺序合并去重——排序本来就是相对次序
  db.manualOrder = remapManualOrderKeys(db.manualOrder, db.offers, settings.modelAliases)
  // v7：诊断地基——错误账本、供给表现时序、故障上报配置（幂等）。
  // 与 v6 各自独立、都幂等，跨级升上来两条都会跑
  ensureDiagnosisKeys(db)
  ensureFaultKeys(db)
  db.version = DB_VERSION
  ensureMonitor(db)
  return db
}

export async function readDb() {
  const p = dbPath()
  if (!(await exists(p))) return emptyDb()
  let raw
  try {
    raw = JSON.parse(await readFile(p, 'utf8'))
  } catch (error) {
    throw new StorageError(`数据文件解析失败：${p}（${error.message}）`)
  }
  const base = emptyDb()
  const rawSettings = raw.settings || {}
  const settings = { ...base.settings, ...rawSettings }
  // 阈值口径从人民币改成美元：老配置只存了 balanceWarnCny，这里折一次
  // （判断依据是原始文件里有没有 balanceWarnUsd，否则默认值会盖掉迁移）
  if (rawSettings.balanceWarnUsd === undefined) {
    // 这里不能用 fx.js 的 ensureFx —— fx.js 反过来 import 了本文件，会成环。
    // 所以按同样顺序取值：fx.rates.CNY → 兼容镜像 → 默认值。
    const fx =
      Number(rawSettings.fx?.rates?.CNY) ||
      Number(settings.fx?.rates?.CNY) ||
      Number(settings.fxUsdCny) ||
      7.2
    const oldCny = Number(rawSettings.balanceWarnCny)
    if (Number.isFinite(oldCny) && oldCny > 0) settings.balanceWarnUsd = Math.round((oldCny / fx) * 100) / 100
  }
  return migrate({
    ...base,
    ...raw,
    settings,
    providers: raw.providers || [],
    credentials: raw.credentials || [],
    offers: raw.offers || [],
    probes: raw.probes || [],
  })
}

export async function writeDb(db) {
  await mkdir(dataDir(), { recursive: true })
  await writeJsonAtomic(dbPath(), db, 2)
  // 自己写完就把缓存作废，下一次读一定是新的
  dbCache = { mtimeMs: 0, size: -1, db: null }
}

let dbCache = { mtimeMs: 0, size: -1, db: null }

/**
 * 读 db 并缓存——只读场景（网关热路径）用，**不要改返回的对象**。
 *
 * 每请求 readDb 要 15ms 左右（db.json 已到 1MB），对本地网关是白扔的延迟。
 * 用 mtime + size 判断文件有没有被换过：我们自己的写入会换文件，别的进程改了也一样。
 */
export async function readDbCached() {
  const p = dbPath()
  let stats
  try {
    stats = await stat(p)
  } catch {
    return readDb() // 文件不存在或读不到，走慢路径（会返回空库或抛 StorageError）
  }
  if (dbCache.db && dbCache.mtimeMs === stats.mtimeMs && dbCache.size === stats.size) {
    return dbCache.db
  }
  const db = await readDb()
  // 读完再 stat 一次：避免把「读的过程中又变了」的文件记成缓存
  const after = await stat(p).catch(() => null)
  if (after && after.mtimeMs === stats.mtimeMs && after.size === stats.size) {
    dbCache = { mtimeMs: after.mtimeMs, size: after.size, db }
  }
  return db
}

/**
 * 读 → 改 → 原子写。回调直接修改传入的 db 对象。
 *
 * 必须串行：HTTP 服务会并发进 mutate，每个请求都「读同一份 → 各自写回」，
 * 后写的会把先写的结果整份覆盖掉（丢数据），并发 rename 还会在 Windows 上互相打 EPERM。
 * usage.js 里的 writeChain 是同一个思路。
 */
export async function mutate(fn) {
  const run = async () => {
    const db = await readDb()
    const result = await fn(db)
    await writeDb(db)
    return result
  }
  const pending = writeChain.then(run, run)
  // 链尾吞掉异常，否则一次失败会把后续所有写操作都带成 reject
  writeChain = pending.then(
    () => {},
    () => {},
  )
  return pending
}
