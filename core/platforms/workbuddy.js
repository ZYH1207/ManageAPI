/**
 * WorkBuddy / CodeBuddy 连接器（T2b）：一次登录，自动读积分与签到。
 *
 * 协议来自 dsh-our-free-model 的 channel-pack 源码，两个产品共用一套接口，
 * 只是 endpoint / platform 参数 / productCode 不同，所以配置放在 PRODUCTS 里，
 * 而不是复制出两份实现——两份实现迟早会漂移，其中一份必然先坏。
 *
 * 三条设计取舍：
 * 1. fetch 可注入。真实登录要开浏览器，测试里没法走完，注入假 fetch 是唯一能
 *    把授权流、业务码、错误翻译都覆盖到的办法。
 * 2. 连接器本身不写账本。签到奖励怎么叠加各平台规则不同，落账是上层（ledger.checkin）
 *    的事，这里只负责把远端结果翻译成结构化返回值。
 * 3. token 只以密文形态落库。accessToken 不进日志、不进错误消息，pollConnect 返回的
 *    明文 credential 只应交给 saveCredential 加密，别的地方不要碰。
 */
import { encryptSecret, decryptSecret } from '../store.js'
import { updateAccount } from './store.js'
import { registerConnector } from './connector.js'

/** 授权流总时长。超过这个时间 state 一般已在服务端失效，继续轮询只会拿到无意义的错误码。 */
export const AUTH_TIMEOUT_MS = 5 * 60 * 1000

/** 轮询节奏。由调用方按这个间隔反复调 pollConnect —— 连接器不自己 sleep，避免阻塞宿主。 */
export const POLL_INTERVAL_MS = 1000

const DEFAULT_TIMEOUT_MS = 10_000

// 业务码：HTTP 200 但 body 里的 code 表示「还没好」，属于中间态而非错误。
const CODE_TOKEN_PENDING = 11217
const CODE_ACCOUNT_PENDING = 12151

// token 快到期前多久就主动刷新。留 60 秒是给「请求发出到服务端校验」这段延迟的余量。
const REFRESH_SKEW_MS = 60_000

const PRODUCTS = {
  workbuddy: {
    id: 'workbuddy',
    endpoint: 'https://www.workbuddy.ai',
    apiDomain: 'www.workbuddy.ai',
    platform: 'workbuddy-ai',
    productCode: 'workbuddy',
    // 国际版与国内版 UA 不同，先按国际版写；换产品时这个值要跟着换
    userAgent: 'CodeBuddyIDE/1.106.1',
  },
  // 国内版与国际版共用同一套接口和域名，差别只在客户端 UA 上：
  // 国际版 UA 里带 "WorkBuddy AI"，国内版不带。模型权限也可能不同，所以分成两个入口。
  'workbuddy-cn': {
    id: 'workbuddy-cn',
    endpoint: 'https://www.workbuddy.ai',
    apiDomain: 'www.workbuddy.ai',
    platform: 'workbuddy-ai',
    productCode: 'workbuddy',
    userAgent: 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2',
  },
  codebuddy: {
    id: 'codebuddy',
    endpoint: 'https://copilot.tencent.com',
    apiDomain: 'copilot.tencent.com',
    platform: 'ide',
    productCode: 'codebuddy',
    userAgent: 'CodeBuddyIDE/1.106.1',
  },
}

// ---------------------------------------------------------------- 响应解析

/**
 * 取业务数据体。接口有时把结果放在 data 里，有时直接铺在顶层，
 * 统一走这个函数，调用方就不用每个接口各写一遍 `json.data ?? json`。
 */
function payload(json) {
  return json?.data ?? json ?? {}
}

/** 业务码：没有 code 字段视为成功（有些接口只回 { data }）。 */
function bodyCode(json) {
  const code = json?.code ?? json?.errorCode ?? json?.errCode
  if (code === null || code === undefined || code === '') return null
  const n = Number(code)
  return Number.isFinite(n) ? n : null
}

function bodyMessage(json) {
  return String(
    json?.msg ?? json?.message ?? json?.errorMsg ?? json?.error?.message ?? '',
  ).trim()
}

function isSuccessCode(code) {
  // 0 与 200 都见过：同一家公司的不同服务用了不同约定，两个都放行
  return code === null || code === 0 || code === 200
}

/** 业务失败一律抛错，由 callConnector 兜住——「签到接口 502」不该让整页渲染失败。 */
function ensureBusinessOk(json, action) {
  const code = bodyCode(json)
  if (isSuccessCode(code)) return
  const message = bodyMessage(json)
  throw new Error(`${action}失败：${message || `平台返回业务码 ${code}`}`)
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

function pickNumber(source, keys) {
  for (const key of keys) {
    const value = source?.[key]
    if (value === null || value === undefined || value === '') continue
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * 时间归一化成 ISO 字符串。
 *
 * 秒级时间戳与毫秒级时间戳混用是这类接口的常见坑：不判数量级的话，
 * 1700000000 会被当成 1970 年，token 会被判定为「永远过期」，每次请求都刷新。
 */
function toIso(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  const text = String(value).trim()
  if (/^\d+$/.test(text)) return toIso(Number(text))
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

/** token 结构：accessToken / refreshToken / expiresAt / domain / enterpriseId 已确认。 */
function pickCredential(json, nowMs) {
  const data = payload(json)
  const inner = data && typeof data === 'object' ? data.token ?? data.auth ?? data.credential : null
  const node = inner && typeof inner === 'object' ? { ...data, ...inner } : data ?? {}

  const accessToken = firstString(node.accessToken, node.access_token, node.token)
  if (!accessToken) return null

  let expiresAt = toIso(node.expiresAt ?? node.expireAt ?? node.expiredAt)
  if (!expiresAt) {
    const expiresIn = Number(node.expiresIn ?? node.expires_in)
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      expiresAt = new Date(nowMs + expiresIn * 1000).toISOString()
    }
  }

  return {
    accessToken,
    refreshToken: firstString(node.refreshToken, node.refresh_token) || '',
    expiresAt,
    domain: firstString(node.domain, node.apiDomain),
    enterpriseId: firstString(node.enterpriseId, node.enterprise_id, node.tenantId),
  }
}

/**
 * 额度解析。
 *
 * 腾讯云计费结构的实测语义（2026-10 抓的返回）：
 *   TotalDosage        —— 各资源包「包内」剩余之和（买了多少还扣掉多少）
 *   CapacityRemain     —— 单个包的包内剩余
 *   CycleCapacityRemain—— 单个包「本周期」还剩多少（按天/月循环扣减的那份）
 *   CycleCapacityUsed  —— 本周期已经扣掉多少
 *   Status=3           —— 这个包已过期
 *
 * 这两个数不是一回事：免费订阅包可能「包内还剩 100，但本周期已用满 100」，
 * 此时真实可用是 0。只报 TotalDosage 会让人以为还能用，所以两个都带出去，
 * 由界面决定拿哪个数当「现在能用多少」。
 */
function pickQuota(data) {
  const billing = data?.Response?.Data
  if (billing && typeof billing === 'object') {
    const accounts = (Array.isArray(billing.Accounts) ? billing.Accounts : []).filter(
      (account) => Number(account?.Status) !== 3,
    )
    const sumOf = (key) => {
      let sum = 0
      let counted = 0
      for (const account of accounts) {
        const value = Number(account?.[key])
        if (!Number.isFinite(value)) continue
        sum += value
        counted += 1
      }
      return counted > 0 ? sum : null
    }

    let remaining = Number(billing.TotalDosage)
    if (!Number.isFinite(remaining)) remaining = sumOf('CapacityRemain')
    const cycleRemaining = sumOf('CycleCapacityRemain')
    const cycleSize = sumOf('CycleCapacitySize')
    // 同一个租户（AppId/Uin）下可能有多张卡（国际版/国内版是同一套账号），
    // 带出去让上层能识别「这两张卡其实是同一个号」，避免把余额算两遍
    const tenantKey =
      firstString(billing.AppId, billing.Uin, billing.OwnerUin, billing.TenantId, accounts[0]?.AppId, accounts[0]?.Uin) ||
      ''

    if (Number.isFinite(remaining) || cycleRemaining !== null) {
      return {
        remaining: Number.isFinite(remaining) ? remaining : cycleRemaining,
        cycleRemaining,
        cycleSize,
        resetAt: pickRefreshAt(data),
        tenantKey,
      }
    }
  }

  const node = Array.isArray(data) ? data[0] : data
  if (!node || typeof node !== 'object') return null

  const direct = pickNumber(node, [
    'remaining',
    'remain',
    'available',
    'left',
    'surplus',
    'balance',
    'credits',
    'credit',
    'points',
  ])
  const resetAt = pickRefreshAt(data)
  if (direct !== null) {
    return { remaining: direct, cycleRemaining: null, cycleSize: null, resetAt, tenantKey: '' }
  }

  const total = pickNumber(node, ['total', 'totalCredits', 'quota', 'limit', 'amount'])
  const used = pickNumber(node, ['used', 'consumed', 'usage', 'usedCredits'])
  if (total !== null && used !== null) {
    return {
      remaining: Math.max(0, total - used),
      cycleRemaining: null,
      cycleSize: null,
      resetAt,
      tenantKey: '',
    }
  }
  if (total !== null) {
    return { remaining: total, cycleRemaining: null, cycleSize: null, resetAt, tenantKey: '' }
  }
  return null
}

function pickRefreshAt(data) {
  // 套餐的 CycleEndTime 才是「什么时候刷新」，ExpiredTime 是这条套餐自己的失效时间。
  // 取未过期账号里最近的一个未来时间点。
  const billing = data?.Response?.Data
  if (billing && typeof billing === 'object') {
    const now = Date.now()
    let best = null
    for (const account of Array.isArray(billing.Accounts) ? billing.Accounts : []) {
      if (Number(account?.Status) === 3) continue
      const at = Date.parse(String(account?.CycleEndTime || '').replace(' ', 'T'))
      if (!Number.isFinite(at) || at <= now) continue
      if (best === null || at < best) best = at
    }
    if (best !== null) return new Date(best).toISOString()
  }

  const node = Array.isArray(data) ? data[0] : data
  if (!node || typeof node !== 'object') return null
  return toIso(
    node.refreshAt ??
      node.resetAt ??
      node.expireAt ??
      node.expiresAt ??
      node.nextRefreshAt ??
      node.periodEnd,
  )
}

/** 模型目录：只关心名字，其余字段（倍率、上下文长度）留给上层按需扩展。 */
function pickModels(json) {
  const data = payload(json)
  const list = Array.isArray(data)
    ? data
    : data?.models ?? data?.list ?? data?.items ?? []
  if (!Array.isArray(list)) return []
  return list
    .map((item) =>
      typeof item === 'string'
        ? { name: item }
        : { name: firstString(item?.name, item?.model, item?.id) },
    )
    .filter((item) => item.name)
}

function pickProfile(json) {
  const data = payload(json)
  const node = data?.account && typeof data.account === 'object' ? data.account : data ?? {}
  return {
    label: firstString(
      node.nickname,
      node.name,
      node.userName,
      node.username,
      node.email,
      node.mobile,
    ),
    enterpriseId: firstString(node.enterpriseId, node.enterprise_id, node.tenantId),
  }
}

function resolveProduct(name) {
  const key = String(name || 'workbuddy').toLowerCase()
  const product = PRODUCTS[key]
  if (!product) throw new Error(`未知的平台产品：${name}`)
  return product
}

// ------------------------------------------------------------------- 工厂

/**
 * 建一个连接器实例。
 *
 * 默认实例用全局 fetch 与真实存储；测试传假的 fetch / store 即可，
 * 这样授权流的每个分支都能在没凭据的机器上跑到。
 */
export function createWorkbuddyConnector(options = {}) {
  // 同一个实现注册成两个连接器（国际版 / 国内版），靠默认产品区分
  const defaultProduct = String(options.product || 'workbuddy')
  const connectorId = String(options.id || 'workbuddy')
  const connectorLabel = String(options.label || 'WorkBuddy')
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境没有 fetch')
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const store = options.store ?? { updateAccount }

  // state → 截止时间。只存内存：进程重启后旧 state 本来也失效了，
  // 持久化它只会让用户看到「还在等一个永远不回来的授权」。
  const pending = new Map()

  function translateFetchError(error, timeoutMs) {
    const name = error?.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new Error(`平台没有响应（超过 ${Math.round(timeoutMs / 1000)} 秒），稍后重试`)
    }
    return new Error('连不上平台，检查网络或代理设置')
  }

  async function request(url, opts = {}) {
    const { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = opts
    const finalHeaders = {
      accept: 'application/json',
      ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    }

    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers: finalHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw translateFetchError(error, timeoutMs)
    }

    // 401/403 在这里就翻译成人话：往上抛原始状态码，UI 只能显示「HTTP 401」，
    // 用户不知道该点哪里。这三条是唯一能给出可执行建议的状态码。
    if (response.status === 401 || response.status === 403) {
      throw new Error('登录已失效，重新连接')
    }
    if (response.status === 404) {
      throw new Error('这个平台没有这个接口')
    }
    if (!response.ok) {
      // 把响应体带上：500 时服务端通常会写一句原因，只报状态码等于什么都没说
      let snippet = ''
      try {
        snippet = (await response.text()).slice(0, 160).replace(/\s+/g, ' ').trim()
      } catch {
        /* 读不出来就算了 */
      }
      throw new Error(`平台返回 HTTP ${response.status}${snippet ? `：${snippet}` : ''}`)
    }

    try {
      return await response.json()
    } catch {
      throw new Error('平台返回了无法解析的数据')
    }
  }

  function authHeaders(credential, product) {
    const headers = {
      authorization: `Bearer ${credential.accessToken}`,
      'x-domain': credential.domain || product.apiDomain,
      'user-agent': product.userAgent,
    }
    if (credential.enterpriseId) {
      headers['x-enterprise-id'] = credential.enterpriseId
      // 企业 id 同时当租户 id 用：协议要求两个头一起带，但没有独立的 tenant 字段
      headers['x-tenant-id'] = credential.enterpriseId
    }
    return headers
  }

  async function readCredential(account) {
    const plain = await decryptSecret(account?.secret)
    if (!plain) return null
    try {
      const parsed = JSON.parse(plain)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      // 密文能解开但不是 JSON：只可能是旧格式或人为写坏，按「无凭据」处理
      return null
    }
  }

  /**
   * 加密并落库。account 可以是账号对象，也可以只传 id。
   * 没有落库目标时（刚授权、账号还没建）把密文交给调用方，明文不留在任何地方。
   */
  async function saveCredential(accountOrId, credential) {
    const id = typeof accountOrId === 'string' ? accountOrId : accountOrId?.id
    const blob = await encryptSecret(JSON.stringify(credential))
    if (!id) return blob
    await store.updateAccount(id, { secret: blob })
    if (accountOrId && typeof accountOrId === 'object') accountOrId.secret = blob
    return blob
  }

  function needsRefresh(credential) {
    if (!credential?.accessToken) return true
    if (!credential.expiresAt) return false // 不知道到期时间就先用，401 会兜住
    const expiresAt = Date.parse(credential.expiresAt)
    if (Number.isNaN(expiresAt)) return false
    return expiresAt - now() <= REFRESH_SKEW_MS
  }

  async function refreshCredential(credential, product) {
    const json = await request(`${product.endpoint}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: {
        'x-refresh-token': credential.refreshToken,
        'x-auth-refresh-source': 'ide-main',
        'x-domain': credential.domain || product.apiDomain,
        'user-agent': product.userAgent,
      },
    })
    ensureBusinessOk(json, '刷新登录状态')

    const fresh = pickCredential(json, now())
    if (!fresh?.accessToken) throw new Error('刷新登录状态失败，重新连接')

    // 刷新接口可能不返回 refreshToken / domain：缺什么就沿用旧的，
    // 用空值覆盖会让下一次刷新彻底失败。
    return {
      ...credential,
      ...fresh,
      refreshToken: fresh.refreshToken || credential.refreshToken,
      domain: fresh.domain || credential.domain,
      enterpriseId: fresh.enterpriseId || credential.enterpriseId,
      product: product.id,
    }
  }

  /** 取一份可用凭据：过期就刷新并回写，保证 quota/catalog/checkin 不用各自关心 token 生命周期。 */
  async function prepare(account) {
    const credential = await readCredential(account)
    if (!credential?.accessToken) throw new Error('账号还没有授权，请先点「连接」')

    const product = resolveProduct(credential.product || account?.product)
    if (!needsRefresh(credential)) return { credential, product }

    if (!credential.refreshToken) throw new Error('登录已失效，重新连接')
    const next = await refreshCredential(credential, product)
    await saveCredential(account, next)
    return { credential: next, product }
  }

  // ------------------------------------------------------------- 授权流

  async function startConnect({ product: productName = defaultProduct } = {}) {
    const product = resolveProduct(productName)
    const json = await request(
      `${product.endpoint}/v2/plugin/auth/state?platform=${encodeURIComponent(product.platform)}`,
      {
        method: 'POST',
        headers: {
          'x-domain': product.apiDomain,
          'x-no-authorization': 'true',
          'x-no-user-id': 'true',
          'x-no-enterprise-id': 'true',
          'x-no-department-info': 'true',
          'user-agent': product.userAgent,
        },
      },
    )
    ensureBusinessOk(json, '发起授权')

    const data = payload(json)
    const state = firstString(data.state, data.authState)
    const authUrl = firstString(data.authUrl, data.authURL, data.url, data.loginUrl)
    if (!state || !authUrl) throw new Error('平台没有返回授权地址，稍后重试')

    const deadline = now() + AUTH_TIMEOUT_MS
    pending.set(state, { product: product.id, deadline })
    return { state, authUrl, expiresAt: new Date(deadline).toISOString() }
  }

  /**
   * 单次轮询。ready:false 不是错误，调用方按 POLL_INTERVAL_MS 再来一次。
   *
   * 传 accountId 时顺便把凭据加密落库——UI 拿到 ready:true 就能直接建账号，
   * 不必再单独调一次 saveCredential。
   */
  async function pollConnect({ state, product: productName, accountId } = {}) {
    const key = firstString(state)
    if (!key) throw new Error('缺少授权状态码')

    const entry = pending.get(key)
    const product = resolveProduct(entry?.product || productName)
    if (entry && now() > entry.deadline) {
      pending.delete(key)
      throw new Error('授权超时（5 分钟），请重新发起连接')
    }

    const json = await request(
      `${product.endpoint}/v2/plugin/auth/token?state=${encodeURIComponent(key)}`,
      { headers: { 'x-no-authorization': 'true', 'user-agent': product.userAgent } },
    )

    const code = bodyCode(json)
    if (code === CODE_TOKEN_PENDING) return { ready: false, reason: '等待浏览器授权' }
    ensureBusinessOk(json, '获取授权结果')

    const credential = pickCredential(json, now())
    if (!credential) return { ready: false, reason: '等待授权结果' }
    credential.product = product.id

    // 账号信息（昵称、企业 id）只是展示用，**不能因为它失败就丢掉已经拿到的 token**。
    // 实测这一步会返回 500（code 10000 / EOF），而 token 本身是好的——那就先连上，昵称空着。
    // 提示语不带原始 JSON：用户看不懂 code 10000，真要排查可以点「诊断」。
    let profile = { label: '', enterpriseId: '' }
    let profileWarning = ''
    try {
      const profileJson = await request(
        `${product.endpoint}/v2/plugin/login/account?state=${encodeURIComponent(key)}`,
        { method: 'POST', headers: authHeaders(credential, product) },
      )
      const profileCode = bodyCode(profileJson)
      if (profileCode === CODE_ACCOUNT_PENDING) {
        // 「还在读」是中间态，但也已经拿到 token 了，先连上再补
        profileWarning = '平台还在读账号信息，昵称暂时为空（不影响使用）'
      } else {
        ensureBusinessOk(profileJson, '读取账号信息')
        profile = pickProfile(profileJson)
        if (profile.enterpriseId) credential.enterpriseId = profile.enterpriseId
      }
    } catch {
      profileWarning = '平台没返回账号信息，昵称留空（不影响使用）'
    }

    pending.delete(key)
    if (accountId) await saveCredential(accountId, credential)

    return { ready: true, credential, profile, warning: profileWarning }
  }

  // ------------------------------------------------------------- 账号能力

  /** 模型目录失败返回空数组：目录是「锦上添花」，拉不到不该让整张卡片变成错误态。 */
  async function catalog(account) {
    try {
      const { credential, product } = await prepare(account)
      const json = await request(`${product.endpoint}/v1/models`, {
        headers: authHeaders(credential, product),
      })
      ensureBusinessOk(json, '拉取模型目录')
      return pickModels(json)
    } catch {
      return []
    }
  }

  async function quota(account) {
    const { credential, product } = await prepare(account)
    const json = await request(`${product.endpoint}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: authHeaders(credential, product),
      body: {},
    })
    ensureBusinessOk(json, '读取积分余额')
    const data = payload(json)
    const parsed = pickQuota(data)
    if (!parsed || !Number.isFinite(Number(parsed.remaining))) {
      // 接口通了但字段名对不上。把原始返回带出来——只说「读不到」等于没说，
      // 有了这段片段才能一次改对字段映射。
      throw new Error(
        `余额接口有响应，但没认出积分字段。返回片段：${JSON.stringify(json).slice(0, 400)}`,
      )
    }
    return {
      remaining: parsed.remaining,
      cycleRemaining: parsed.cycleRemaining,
      cycleSize: parsed.cycleSize,
      unit: 'credit',
      refreshAt: parsed.resetAt,
      tenantKey: parsed.tenantKey,
    }
  }

  /**
   * 签到。
   *
   * 「今天已经签过」既可能是业务码非 0，也可能是 code 0 + 布尔标记，
   * 所以两条路都认：先看结构化标记，再看文案。文案匹配看着脏，
   * 但总比把「已签到」当成失败、让用户以为签到坏了要好。
   */
  async function checkin(account) {
    const { credential, product } = await prepare(account)
    const json = await request(`${product.endpoint}/v2/billing/meter/daily-checkin`, {
      method: 'POST',
      headers: authHeaders(credential, product),
      body: {},
    })

    const data = payload(json)
    const node = data && typeof data === 'object' ? data : {}
    const reward = pickNumber(node, ['reward', 'credits', 'points', 'amount', 'checkinReward']) ?? 0
    const flagAlready = Boolean(
      node.alreadyToday ?? node.alreadyCheckin ?? node.checkedIn ?? node.todayChecked,
    )
    const message = bodyMessage(json)
    const saysAlready = /已签到|已经签到|今日已签|重复签到/.test(message)

    const code = bodyCode(json)
    if (!isSuccessCode(code)) {
      if (flagAlready || saysAlready) {
        return { ok: false, alreadyToday: true, reward: 0, message: message || '今天已经签过了' }
      }
      throw new Error(`签到失败：${message || `平台返回业务码 ${code}`}`)
    }

    if (flagAlready || saysAlready) {
      return { ok: false, alreadyToday: true, reward: 0, message: message || '今天已经签过了' }
    }
    return { ok: true, alreadyToday: false, reward, message: message || '签到成功' }
  }

  /**
   * 诊断：把几个只读接口的原始返回原样带出来。
   *
   * 这个平台的字段名是我从别处反推的，对不上时只能靠看真实返回来改。
   * 比反复问「你看到什么」高效得多。
   */
  async function diagnose(account) {
    const { credential, product } = await prepare(account)
    const headers = authHeaders(credential, product)
    const targets = {
      userResource: ['/v2/billing/meter/get-user-resource', 'POST'],
      checkinStatus: ['/v2/billing/meter/checkin-activity-status', 'POST'],
      models: ['/v1/models', 'GET'],
    }
    const out = { product: product.id, endpoints: {} }
    for (const [key, [path, method]] of Object.entries(targets)) {
      try {
        out.endpoints[key] = await request(`${product.endpoint}${path}`, {
          method,
          headers,
          body: method === 'POST' ? {} : undefined,
        })
      } catch (error) {
        out.endpoints[key] = { __error: error.message || String(error) }
      }
    }
    return out
  }

  return {
    id: connectorId,
    label: connectorLabel,
    defaultProduct,
    // 轮询节奏交给 UI：连接器自己 sleep 会占住请求线程
    pollIntervalMs: POLL_INTERVAL_MS,
    authTimeoutMs: AUTH_TIMEOUT_MS,

    detect() {
      return { available: true }
    },

    startConnect,
    pollConnect,
    catalog,
    quota,
    checkin,
    diagnose,
    saveCredential,
  }
}

export const workbuddyConnector = createWorkbuddyConnector({
  id: 'workbuddy',
  label: 'WorkBuddy 国际版',
  product: 'workbuddy',
})

// 国内版是同一套接口、同一域名，只换客户端 UA。分成两个连接器是因为
// 「加一个平台」在界面上是一次动作，两种账号该是两张卡。
export const workbuddyCnConnector = createWorkbuddyConnector({
  id: 'workbuddy-cn',
  label: 'WorkBuddy 国内版',
  product: 'workbuddy-cn',
})

// CodeBuddy 是腾讯的另一个产品（copilot.tencent.com），接口一样但端点和 platform 不同
export const codebuddyConnector = createWorkbuddyConnector({
  id: 'codebuddy',
  label: 'CodeBuddy',
  product: 'codebuddy',
})

// 导入即注册：与 manual.js 同一约定，调用方不必记得登记
registerConnector(workbuddyConnector)
registerConnector(workbuddyCnConnector)
registerConnector(codebuddyConnector)
