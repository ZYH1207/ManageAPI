/**
 * 局域网入口自检：给同一网络里的设备开 /v1，但面板**必须靠令牌才进得来**。
 *
 * 现场：daemon 只绑 127.0.0.1，手机/平板填了正确地址也连不上（TCP 都握不上手）。
 * 想开放时最自然的改法是把绑定地址改成 0.0.0.0 —— 那是错的：面板 /api/* 没有
 * 账号体系，能明文解出所有上游站点的 Key、能删站点改路由；把 4319 开到局域网
 * 等于把这些交给全局域网。而 Host 头校验也不是边界：`curl -H 'Host: 127.0.0.1'`
 * 一秒就绕过，它只挡浏览器那一侧的 DNS rebinding。
 *
 * 所以这里钉死的是「按 socket 绑定的网卡分权 + 开关关着就不监听」，不是
 * 「按请求头/路径白名单」：
 *
 *   [1] 纯函数：回环 / 私有网段判定，网关路径口径，地址解析（含虚拟网卡排序）
 *   [2] 端到端：本机实例照旧可用；局域网实例的 /v1、/free 只认网关 Key
 *       （401 无效 / 403 禁用分得开）；面板与 /api 只认令牌（无令牌 401、
 *       错令牌 401、?token= 对了才 302 种 cookie、重置后旧 cookie 立刻失效）；
 *       开关关掉后这张网卡上连 /api 都不存在（404）
 *   [3] 监听器生杀：开关改了立刻开/关、幂等、--lan 强制开时不被面板开关带走
 *
 * 数据全部落在临时目录，不碰真实的 ~/.manage-api。
 *
 * 用法：node .test/check-lan-gateway.mjs
 */
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = await mkdtemp(join(tmpdir(), 'mapi-lan-'))
process.env.MANAGE_API_HOME = home

let failed = 0
function ok(cond, message, extra) {
  if (cond) {
    console.log(`  ✓ ${message}`)
    return
  }
  failed += 1
  console.error(`  ✗ ${message}${extra === undefined ? '' : `  ← ${extra}`}`)
}

const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href)
const { isLoopbackPeer, isPrivatePeer, isGatewayPath } = await load('daemon/server.js')
const { attachLanListener, createLanHost, detectLanAddress, lanAddressWarning, pickLanAddress, probeRoutedAddress, resolveLanAddress } =
  await load('daemon/lan.js')

// ---------------------------------------------------------------- [1] 纯函数
console.log('[1] 回环 / 私有网段 / 网关路径 / 地址解析')
{
  ok(isLoopbackPeer('127.0.0.1'), '回环：127.0.0.1')
  ok(isLoopbackPeer('127.8.9.10'), '回环：127/8 整段')
  ok(isLoopbackPeer('::1'), '回环：::1')
  ok(isLoopbackPeer('::ffff:127.0.0.1'), '回环：IPv4-mapped 形式')
  ok(!isLoopbackPeer('192.168.1.5'), '回环：192.168 不算')
  ok(!isLoopbackPeer(''), '回环：空地址不算（不能默认放行）')

  ok(isPrivatePeer('192.168.1.5'), '私有：192.168/16')
  ok(isPrivatePeer('10.1.2.3'), '私有：10/8')
  ok(isPrivatePeer('172.16.0.1') && isPrivatePeer('172.31.255.254'), '私有：172.16–172.31')
  ok(!isPrivatePeer('172.32.0.1'), '私有：172.32 已经出界')
  ok(isPrivatePeer('100.101.102.103'), '私有：CGNAT / 覆盖网 100.64/10')
  ok(!isPrivatePeer('100.63.0.1'), '私有：100.63 在 CGNAT 之外')
  ok(isPrivatePeer('169.254.10.1'), '私有：链路本地 169.254')
  ok(isPrivatePeer('fe80::1'), '私有：IPv6 链路本地')
  ok(isPrivatePeer('fd00::1'), '私有：IPv6 ULA fd00::/8')
  ok(isPrivatePeer('::ffff:192.168.1.5'), '私有：IPv4-mapped 形式')
  ok(!isPrivatePeer('8.8.8.8'), '私有：公网地址不放行（端口转发出去也不能变开放代理）')
  ok(!isPrivatePeer('2001:4860:4860::8888'), '私有：公网 IPv6 不放行')

  ok(isGatewayPath('/v1') && isGatewayPath('/v1/models'), '网关路径：/v1 及其子路径')
  ok(isGatewayPath('/free') && isGatewayPath('/free/v1/models'), '网关路径：免费池 /free 前缀')
  ok(!isGatewayPath('/api/state'), '网关路径：/api 不算')
  ok(!isGatewayPath('/v1x'), '网关路径：/v1x 不能被前缀匹配误伤')
  ok(!isGatewayPath('/'), '网关路径：面板首页不算')

  ok((await resolveLanAddress('')).reason === 'off', '解析：空值 → 不开（默认行为不变）')
  ok((await resolveLanAddress('0')).reason === 'off', '解析：0 → 不开')
  ok((await resolveLanAddress(false)).reason === 'off', '解析：false → 不开')
  ok((await resolveLanAddress('192.168.1.9')).address === '192.168.1.9', '解析：显式地址原样采用')
  ok(
    (await resolveLanAddress('127.0.0.1')).reason === 'loopback',
    '解析：回环地址被拒（那是完整实例的位置）',
  )
  ok(
    (await resolveLanAddress('1', {})).reason === 'not-found',
    '解析：自动探测且没有任何网卡 → 明确报没找到',
  )

  const fake = {
    'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    'vEthernet (WSL)': [{ address: '172.30.0.1', family: 'IPv4', internal: false }],
    'VMware Network Adapter VMnet8': [{ address: '192.168.222.1', family: 'IPv4', internal: false }],
    '以太网': [{ address: '192.168.1.9', family: 'IPv4', internal: false }],
  }
  ok(detectLanAddress(fake) === '192.168.1.9', '探测：物理网卡优先于 WSL / VMware 虚拟网卡')
  ok((await resolveLanAddress('auto', fake)).address === '192.168.1.9', '解析：auto 走探测')

  // 本机实测踩到的坑：「本地连接* N」是 Microsoft Wi-Fi Direct 虚拟适配器，
  // 它排在真网卡前面、也拿着 192.168 地址，但局域网里没人连得到它。
  const wifiDirect = {
    '本地连接* 14': [{ address: '192.168.137.1', family: 'IPv4', internal: false }],
    WLAN: [{ address: '192.168.1.26', family: 'IPv4', internal: false }],
  }
  ok(detectLanAddress(wifiDirect) === '192.168.1.26', '探测：跳过「本地连接*」这类 Wi-Fi Direct 虚拟网卡')

  // 默认路由探测是「不发包」的 UDP connect，连不到外网时必须安静地返回 null
  const routed = await probeRoutedAddress({ timeoutMs: 200 })
  ok(
    routed === null || /^\d+\.\d+\.\d+\.\d+$/.test(routed),
    '探测：默认路由侧地址要么是一个 IPv4、要么是 null（不抛异常）',
    routed,
  )
  const picked = await pickLanAddress({})
  ok(picked === null || /^\d+\.\d+\.\d+\.\d+$/.test(picked), '探测：pickLanAddress 在没有网卡时安静返回 null', picked)

  const onlyVirtual = { 'VMware Network Adapter VMnet8': [{ address: '192.168.222.1', family: 'IPv4' }] }
  ok(
    detectLanAddress(onlyVirtual) === '192.168.222.1',
    '探测：只有虚拟网卡时仍然选它（整机走 Tailscale 这类场景不该被挡死）',
  )

  const selfAssigned = {
    '以太网': [{ address: '169.254.23.11', family: 'IPv4', internal: false }],
    'Wi-Fi': [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
  }
  ok(detectLanAddress(selfAssigned) === '192.168.1.20', '探测：跳过 169.254 自分配地址')
  ok(detectLanAddress({}) === null, '探测：什么都没有 → null')

  ok(lanAddressWarning('192.168.1.26') === null, '提醒：私有地址不啰嗦')
  ok(/私有网段/.test(lanAddressWarning('8.8.8.8') || ''), '提醒：绑到公网地址要说清「所有人都连不上」')

  const badBind = await attachLanListener({ port: 0, address: '203.0.113.7' })
  ok(
    badBind.server === null && Boolean(badBind.error),
    '绑定：拿不到的地址安静失败并返回 error（不能把本机入口拖死）',
    badBind.error?.code,
  )
  ok(/私有网段/.test(badBind.warning || ''), '绑定：失败时同时带上「不在私有网段」的提醒')
}

// ---------------------------------------------------------------- [2] 端到端
console.log('[2] 本机实例照旧，局域网实例只放网关')
{
  const inv = await load('core/inventory.js')
  const store = await load('core/store.js')
  const { createAppServer } = await load('daemon/server.js')

  const provider = await inv.createProvider({ name: '局域网测试站', baseUrl: 'http://127.0.0.1:5199/v1' })
  const cred = await inv.createCredential({ providerId: provider.id, label: 'k1', secret: 'sk-lan-1' })
  await inv.syncOffers(provider.id, cred.id, ['lan-model'])
  let db = await store.readDb()
  const offer = db.offers.find((o) => o.upstreamName === 'lan-model')
  await inv.updateOfferPrice(offer.id, { inPrice: 1, outPrice: 2, currency: 'USD' })

  const gateway = await inv.ensureGatewayKeys()
  const key = gateway.keys[0].key
  // 再建一把禁用的 Key：局域网入口上「有 Key 但被禁用」要报 403，不能混成 401
  db = await store.readDb()
  await store.mutate((d) => {
    d.settings.gateway.keys.push({
      id: 'lan-test-disabled',
      name: '禁用的 Key',
      key: 'sk-disabled-lan-test',
      enabled: false,
      createdAt: new Date().toISOString(),
    })
  })

  // 两个实例都用回环地址监听（不同端口）：回环对端同样属于「私有网段」，
  // 所以局域网实例的行为可以在没有真实局域网的环境里测到。
  const full = createAppServer()
  await new Promise((resolve) => full.listen(0, '127.0.0.1', resolve))
  const fullPort = full.address().port
  const lan = createAppServer({ mode: 'lan' })
  await new Promise((resolve) => lan.listen(0, '127.0.0.1', resolve))
  const lanPort = lan.address().port

  const request = (port, { method = 'GET', path = '/', headers = {}, body = null } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => {
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            /* 非 JSON（403/404 的纯文本） */
          }
          resolve({ status: res.statusCode, text, json, headers: res.headers })
        })
      })
      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    })

  try {
    // ---- 本机实例：行为和旧版一致
    const localState = await request(fullPort, { path: '/api/state' })
    ok(localState.status === 200, '本机实例：/api/state 仍然 200（默认行为零变化）', localState.status)

    const foreignHost = await request(fullPort, {
      path: '/api/state',
      headers: { host: `192.168.1.9:${fullPort}` },
    })
    ok(foreignHost.status === 403, '本机实例：非本机 Host 仍然 403（DNS rebinding 防护没丢）', foreignHost.status)

    const localNoKey = await request(fullPort, { path: '/v1/models' })
    ok(localNoKey.status === 401, '本机实例：/v1 一样要网关 Key（401）', localNoKey.status)

    // ---- 局域网实例：面板与 /api 不存在
    const lanHost = `192.168.1.9:${lanPort}`
    const lanState = await request(lanPort, { path: '/api/state', headers: { host: lanHost } })
    ok(lanState.status === 404, '局域网实例：/api/state 是 404（面板在这张网卡上不存在）', lanState.status)

    const spoofed = await request(lanPort, { path: '/api/state', headers: { host: '127.0.0.1' } })
    ok(
      spoofed.status === 404,
      '局域网实例：伪造 Host: 127.0.0.1 依然是 404（这是 Host 白名单方案挡不住的）',
      spoofed.status,
    )

    const lanWrite = await request(lanPort, {
      method: 'POST',
      path: '/api/gateway/keys',
      headers: { host: lanHost, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '外部乱建' }),
    })
    ok(lanWrite.status === 404, '局域网实例：写接口（建 Key）也是 404', lanWrite.status)

    const lanPage = await request(lanPort, { path: '/', headers: { host: lanHost } })
    ok(lanPage.status === 404, '局域网实例：面板 HTML 也不下发（404）', lanPage.status)

    const lanAsset = await request(lanPort, { path: '/app.js', headers: { host: lanHost } })
    ok(lanAsset.status === 404, '局域网实例：静态资源同样 404', lanAsset.status)

    // ---- 局域网实例：网关可用，且只认 Key
    const lanNoKey = await request(lanPort, { path: '/v1/models', headers: { host: lanHost } })
    ok(lanNoKey.status === 401, '局域网实例：/v1/models 无 Key → 401', lanNoKey.status)
    ok(
      lanNoKey.json?.error?.type === 'authentication_error',
      '局域网实例：401 是网关自己的鉴权错误（不是 404 之外的另一套码）',
      lanNoKey.text?.slice(0, 120),
    )

    const lanBadKey = await request(lanPort, {
      path: '/v1/models',
      headers: { host: lanHost, authorization: 'Bearer sk-not-exist' },
    })
    ok(lanBadKey.status === 401, '局域网实例：错误的 Key → 401', lanBadKey.status)

    const lanDisabled = await request(lanPort, {
      path: '/v1/models',
      headers: { host: lanHost, authorization: 'Bearer sk-disabled-lan-test' },
    })
    ok(lanDisabled.status === 403, '局域网实例：被禁用的 Key → 403（和「无效」分得开）', lanDisabled.status)

    const lanModels = await request(lanPort, {
      path: '/v1/models',
      headers: { host: lanHost, authorization: `Bearer ${key}` },
    })
    ok(lanModels.status === 200, '局域网实例：带正确 Key → 200', lanModels.status)
    ok(lanModels.json?.object === 'list', '局域网实例：返回的是 OpenAI 兼容的模型清单')
    ok(
      (lanModels.json?.data || []).some((m) => String(m.id).includes('lan-model')),
      '局域网实例：清单里真的有本地供给的模型',
      JSON.stringify(lanModels.json?.data?.map?.((m) => m.id) ?? null).slice(0, 160),
    )

    const lanFreeNoKey = await request(lanPort, { path: '/free/v1/models', headers: { host: lanHost } })
    ok(lanFreeNoKey.status === 401, '局域网实例：/free 免费池也要 Key（不是公开端点）', lanFreeNoKey.status)

    const lanFree = await request(lanPort, {
      path: '/free/v1/models',
      headers: { host: lanHost, authorization: `Bearer ${key}` },
    })
    ok(lanFree.status === 200, '局域网实例：/free/v1/models 带 Key → 200', lanFree.status)

    const lanTrailing = await request(lanPort, { path: '/v1/models/', headers: { host: lanHost } })
    ok(lanTrailing.status === 401, '局域网实例：末尾斜杠的 /v1/models/ 同样走网关（401 而不是 404）', lanTrailing.status)

    // ---- 局域网面板：开关打开后才有，且只认令牌
    const patch = (body) =>
      request(fullPort, {
        method: 'PATCH',
        path: '/api/settings',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const enabled = await patch({ lanPanel: true })
    const panelToken = String(enabled.json?.lan?.token || '')
    ok(enabled.status === 200, '开关：从本机面板打开局域网访问 → 200', enabled.status)
    ok(/^mapi-lan-[0-9a-f]{32}$/.test(panelToken), '开关：打开时自动生成一把令牌', panelToken.slice(0, 14))
    ok(enabled.json?.lan?.enabled === true, '开关：state 里回读 enabled = true')

    const htmlLogin = await request(lanPort, { path: '/', headers: { host: lanHost, accept: 'text/html' } })
    ok(htmlLogin.status === 401, '面板：没令牌时 HTML 请求给登录页（401）', htmlLogin.status)
    ok(/需要局域网访问令牌/.test(htmlLogin.text), '面板：登录页里说明了「仅限局域网 / 公网务必关闭」')

    const apiNoToken = await request(lanPort, { path: '/api/state', headers: { host: lanHost } })
    ok(apiNoToken.status === 401, '面板：没令牌时 /api/ 是 401（脚本拿到 JSON 不是登录页）', apiNoToken.status)

    const wrongToken = await request(lanPort, { path: '/api/state', headers: { host: lanHost, authorization: 'Bearer nope' } })
    ok(wrongToken.status === 401, '面板：错误令牌 → 401', wrongToken.status)

    const wrongQuery = await request(lanPort, { path: '/?token=nope', headers: { host: lanHost, accept: 'text/html' } })
    ok(wrongQuery.status === 401, '面板：链接里令牌不对 → 挡住（401）', wrongQuery.status)

    const rightQuery = await request(lanPort, {
      path: `/?token=${encodeURIComponent(panelToken)}`,
      headers: { host: lanHost, accept: 'text/html' },
    })
    ok(rightQuery.status === 302, '面板：链接里令牌对 → 302 跳回干净路径', rightQuery.status)
    const setCookie = String(rightQuery.headers['set-cookie'] || '')
    ok(/mapi_lan=/.test(setCookie) && /HttpOnly/i.test(setCookie), '面板：顺手种下 HttpOnly cookie', setCookie.slice(0, 40))

    const htmlOk = await request(lanPort, { path: '/', headers: { host: lanHost, accept: 'text/html', cookie: `mapi_lan=${panelToken}` } })
    ok(htmlOk.status === 200 && /<html/i.test(htmlOk.text), '面板：带 cookie 打开首页 → 200 真页面', htmlOk.status)

    const stateByCookie = await request(lanPort, { path: '/api/state', headers: { host: lanHost, cookie: `mapi_lan=${panelToken}` } })
    ok(stateByCookie.status === 200, '面板：带 cookie 调 /api/state → 200', stateByCookie.status)

    const stateByHeader = await request(lanPort, {
      path: '/api/state',
      headers: { host: lanHost, authorization: `Bearer ${panelToken}` },
    })
    ok(stateByHeader.status === 200, '面板：带 Bearer 令牌也能进（curl / 脚本）', stateByHeader.status)

    const login = await request(lanPort, {
      method: 'POST',
      path: '/api/lan/login',
      headers: { host: lanHost, 'content-type': 'application/json' },
      body: JSON.stringify({ token: panelToken }),
    })
    ok(login.status === 200 && /mapi_lan=/.test(String(login.headers['set-cookie'] || '')), '面板：登录接口种 cookie', login.status)

    const loginBad = await request(lanPort, {
      method: 'POST',
      path: '/api/lan/login',
      headers: { host: lanHost, 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'mapi-lan-wrong' }),
    })
    ok(loginBad.status === 401, '面板：登录接口收错的令牌 → 401', loginBad.status)

    const write = await request(lanPort, {
      method: 'POST',
      path: '/api/gateway/keys',
      headers: { host: lanHost, 'content-type': 'application/json', cookie: `mapi_lan=${panelToken}` },
      body: JSON.stringify({ name: '甲机新建' }),
    })
    ok(write.status === 200, '面板：令牌过了就能真的写（新建 Key 成功）', write.status)

    const rotated = await request(fullPort, { method: 'POST', path: '/api/lan/token/rotate', headers: { 'content-type': 'application/json' }, body: '{}' })
    const freshToken = String(rotated.json?.lan?.token || '')
    ok(freshToken && freshToken !== panelToken, '重置：令牌真换了（长度照旧）', freshToken.slice(0, 14))
    const oldCookie = await request(lanPort, { path: '/api/state', headers: { host: lanHost, cookie: `mapi_lan=${panelToken}` } })
    ok(oldCookie.status === 401, '重置：旧 cookie 立刻失效（401）', oldCookie.status)
    const newCookie = await request(lanPort, { path: '/api/state', headers: { host: lanHost, cookie: `mapi_lan=${freshToken}` } })
    ok(newCookie.status === 200, '重置：新 cookie 能用', newCookie.status)

    // 网关侧不受面板开关影响：它自己的鉴权（网关 Key）照旧
    const gwAfterPanel = await request(lanPort, {
      path: '/v1/models',
      headers: { host: lanHost, authorization: `Bearer ${key}` },
    })
    ok(gwAfterPanel.status === 200, '开关打开的副作用：/v1 仍然只认网关 Key（200）', gwAfterPanel.status)

    const disabled = await patch({ lanPanel: false })
    ok(disabled.json?.lan?.enabled === false, '关闭开关：state 里 enabled = false')
    const closedState = await request(lanPort, { path: '/api/state', headers: { host: lanHost } })
    ok(closedState.status === 404, '关闭开关：局域网入口上 /api/ 又变成 404（连路由都没了）', closedState.status)
    const closedGw = await request(lanPort, { path: '/v1/models', headers: { host: lanHost } })
    ok(closedGw.status === 401, '关闭开关：/v1 仍在（网关不跟着关）', closedGw.status)
  } finally {
    await new Promise((resolve) => full.close(resolve))
    await new Promise((resolve) => lan.close(resolve))
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

console.log('[3] 监听器生杀：开关改了立刻开/关，幂等，不靠重启')
{
  const calls = []
  const closed = []
  const fakeBind = async ({ port, address }) => {
    calls.push(address)
    return { server: { close: (cb) => { closed.push(address); cb() } }, address, error: null, warning: null }
  }

  const host = createLanHost({ port: 4433, addressOverride: '192.168.1.9', bind: fakeBind })
  ok((await host.apply({ enabled: false })).open === false, '生杀：开关关着 → 不监听（默认就是没端口）')
  ok(calls.length === 0, '生杀：没开开关时连 bind 都不会调')

  const opened = await host.apply({ enabled: true })
  ok(opened.open === true && opened.address === '192.168.1.9', '生杀：开关一打开立刻绑上局域网地址')
  ok(opened.url === 'http://192.168.1.9:4433/', '生杀：status 里给出面板地址', opened.url)
  ok(calls.length === 1, '生杀：bind 只调一次')

  await host.apply({ enabled: true })
  ok(calls.length === 1, '生杀：重复 apply(true) 不会重复绑定（幂等）')

  const closedStatus = await host.apply({ enabled: false })
  ok(closedStatus.open === false && closed.length === 1, '生杀：关掉开关就真的释放端口')

  const forcedCalls = []
  const forcedHost = createLanHost({
    port: 4433,
    addressOverride: '192.168.1.9',
    forced: true,
    bind: async ({ address }) => {
      forcedCalls.push(address)
      return { server: { close: (cb) => cb() }, address, error: null, warning: null }
    },
  })
  const forcedStatus = await forcedHost.apply({ enabled: false })
  ok(forcedStatus.open === true, '生杀：--lan 强制开的监听器不因面板开关关闭而消失（网关还要用）')
  ok(forcedCalls.length === 1, '生杀：强制开时确实绑了一次')

  const failHost = createLanHost({
    port: 4433,
    addressOverride: '10.0.0.99',
    bind: async () => ({ server: null, address: '10.0.0.99', error: Object.assign(new Error('x'), { code: 'EADDRNOTAVAIL' }), warning: null }),
  })
  const failed = await failHost.apply({ enabled: true })
  ok(failed.open === false, '生杀：绑定失败时不去谎报已经开着')
  ok(/EADDRNOTAVAIL/.test(failed.error || ''), '生杀：失败原因原样带到 status（面板上就能看到）', failed.error)
}

console.log('')
if (failed > 0) {
  console.error(`✗ ${failed} 项失败`)
  process.exit(1)
}
console.log('✓ 局域网入口自检全部通过')
