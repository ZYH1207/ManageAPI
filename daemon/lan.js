/**
 * 局域网入口：同一台机器上再开一个监听器，绑在局域网那张网卡上。
 *
 * 为什么不是「把 127.0.0.1 改成 0.0.0.0」：
 * 那样面板（/api/*）也一起出去了，而面板**完全没有账号体系**——`revealSecret()` 能把
 * 所有上游站点的 Key 明文解出来，能删站点、删分组、改路由。把 Host 头校验当成
 * 边界也不行：Host 是客户端自己填的，`curl -H 'Host: 127.0.0.1'` 一秒就绕过。
 *
 * 所以边界做成「这个 socket 绑在哪张网卡上」，并且按用途分权：
 *   127.0.0.1:4319   → 完整实例（面板 + 网关），只有本机能开，本机即身份
 *   <局域网IP>:4319  → 同一端口号上的第二个监听器：
 *                        /v1、/free  → 只认网关 Key（和本机入口同一套鉴权）
 *                        面板与 /api → 开关打开时才存在，且只认一把局域网令牌
 * 开关关着时**这张网卡上连端口都不存在**（不是 403：别的设备连 TCP 都握不上手），
 * 所以外面要不要开面板，是“有没有监听器”这一件事决定的，不靠请求头二次判断。
 * 同一个端口号，局域网设备填 http://<局域网IP>:4319/v1 就行，不用记两个端口。
 */
import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { createAppServer, isPrivatePeer } from './server.js'

/**
 * 虚拟网卡排除表。
 *
 * 它们也常常拿着 192.168.x 地址，但同一局域网里的手机根本连不到——
 * 自动探测要是挑中了它们，用户看到的就是「地址填对了却连不上」。
 *
 * `本地连接* N` 是 Windows 的「Microsoft Wi-Fi Direct 虚拟适配器」（热点/投屏用），
 * 在这台机器上实测它排在真网卡前面，而且拿着 192.168.137.1——所以名字里
 * 带 `本地连接*` 的一律降级，不能只看前缀像不像真的。
 *
 * 只是排序用，不做硬排除：真只有虚拟网卡可用时仍然选它（比如整机走 Tailscale）。
 */
const VIRTUAL_ADAPTER =
  /virtual|vmware|hyper-?v|vethernet|docker|wsl|loopback|tap|tun|tailscale|zerotier|radmin|npcap|bluetooth|wi-?fi\s*direct|热点|本地连接\s*\*|虚拟|桥接/i

const TRUTHY = new Set(['1', 'true', 'on', 'yes', 'auto'])
const FALSY = new Set(['', '0', 'false', 'off', 'no'])

/**
 * 问「默认路由那一侧」要本机地址：向一个公网地址做 UDP `connect`。
 *
 * connect 只让内核选一个源地址，**不发任何包**，所以离线、被防火墙拦、
 * 被墙都不影响结果，也不需要管理员权限。
 * 这比枚举网卡靠谱：它直接回答「真正出网的那张网卡是哪个」。
 */
export function probeRoutedAddress({ target = '8.8.8.8', port = 53, timeoutMs = 300 } = {}) {
  return new Promise((resolve) => {
    let socket = null
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        socket?.close()
      } catch {
        /* 已经关了 */
      }
      resolve(value)
    }
    try {
      socket = createSocket(target.includes(':') ? 'udp6' : 'udp4')
      socket.once('error', () => finish(null))
      const timer = setTimeout(() => finish(null), timeoutMs)
      timer.unref?.()
      socket.connect(port, target, () => {
        clearTimeout(timer)
        try {
          finish(socket.address()?.address || null)
        } catch {
          finish(null)
        }
      })
    } catch {
      finish(null)
    }
  })
}

/**
 * 挑一个局域网地址：先问默认路由（最准），问不到再扫网卡。
 */
export async function pickLanAddress(interfaces) {
  if (interfaces === undefined) {
    const routed = await probeRoutedAddress()
    if (routed && /^\d+\.\d+\.\d+\.\d+$/.test(routed) && isPrivatePeer(routed)) return routed
  }
  return detectLanAddress(interfaces)
}

/**
 * 自动挑一个局域网地址：优先物理网卡的私有 IPv4。
 *
 * 为什么不把地址写死在配置里：换一次 DHCP 租约地址就变了，写死的那个
 * 第二天就成了「昨天还能用今天不能」。启动时现算，重启即跟随。
 */
export function detectLanAddress(interfaces = networkInterfaces()) {
  const candidates = []
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const item of list || []) {
      if (!item || item.internal) continue
      const family = item.family === 'IPv6' ? 6 : typeof item.family === 'string' ? item.family : 4
      if (family !== 4 && family !== 'IPv4') continue
      const address = String(item.address || '')
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) continue
      // 169.254.x.x 是拿不到 DHCP 时的自分配地址：网段里除了自己没别人
      if (address.startsWith('169.254.')) continue
      candidates.push({ name, address, virtual: VIRTUAL_ADAPTER.test(String(name)) })
    }
  }
  candidates.sort((a, b) => Number(a.virtual) - Number(b.virtual))
  return candidates[0]?.address || null
}

/**
 * 把命令行 / 环境变量的取值翻译成一个要绑的地址。
 *
 *   空 / 0 / off          → 不开（默认）
 *   1 / true / auto       → 自动探测
 *   192.168.1.9           → 显式地址（想绑指定网卡时用）
 *   127.0.0.1             → 拒绝：那是本机完整实例的位置，绑上去只会撞端口
 *
 * @param {string|boolean} value
 * @param {object} [interfaces] 传入则只用这份网卡快照扫（测试用，不碰真实网络）
 * @returns {Promise<{ address: string|null, reason: 'off'|'loopback'|'not-found'|'ok' }>}
 */
export async function resolveLanAddress(value, interfaces) {
  const raw = typeof value === 'string' ? value.trim() : value ? '1' : ''
  if (FALSY.has(raw.toLowerCase())) return { address: null, reason: 'off' }
  if (TRUTHY.has(raw.toLowerCase())) {
    const address = await pickLanAddress(interfaces)
    return address ? { address, reason: 'ok' } : { address: null, reason: 'not-found' }
  }
  if (/^127\./.test(raw) || raw === '::1' || raw.toLowerCase() === 'localhost') {
    return { address: null, reason: 'loopback' }
  }
  return { address: raw, reason: 'ok' }
}

/**
 * 局域网监听器的生命周期。
 *
 * 开关在 `settings.lanPanel.enabled`（面板里那个开关），不重启进程就生效，
 * 所以开/关必须由 daemon 侧（index.js）拿得住：setting 改了 → server 调 apply()
 * → 这里按需 bind/unbind。
 *
 * forced = 命令行 `--lan` 显式要求时用它：监听器一直开着（只放网关），
 * 面板开关只决定那张网卡上要不要多出面板。
 */
export function createLanHost({
  port,
  log = console,
  addressOverride = null,
  forced = false,
  serverOptions = {},
  bind = attachLanListener,
}) {
  let server = null
  let address = null
  let error = null

  async function open() {
    if (server) return status()
    error = null
    const target = addressOverride || (await pickLanAddress())
    if (!target) {
      error = '没探测到局域网地址（只有回环 / 没连网？）；可用 --lan 192.168.x.x 指定'
      return status()
    }
    const attached = await bind({ port, address: target, serverOptions })
    if (attached.warning && log?.error) log.error(`  [lan] ${attached.warning}`)
    if (attached.error) {
      error = `绑定 ${target}:${port} 失败（${attached.error.code || attached.error.message}）`
      return status()
    }
    server = attached.server
    address = target
    return status()
  }

  async function close() {
    if (!server) return status()
    const current = server
    server = null
    address = null
    await new Promise((resolve) => current.close(() => resolve())).catch(() => {})
    return status()
  }

  /** 按设置开/关。每次调用都幂等，重复调用不会重复绑定 */
  async function apply(panel) {
    if (forced || panel?.enabled) await open()
    else await close()
    return status()
  }

  function status() {
    return {
      open: Boolean(server),
      address,
      port,
      url: address ? `http://${address}:${port}/` : null,
      error,
    }
  }

  return { open, close, apply, status }
}

/**
 * 地址本身是不是私有网段。绑到一个公网地址上时，局域网入口的「只接私有来源」
 * 会把**所有人都挡在外面**（包括你自己）——这不是安全漏洞，但会让人以为功能坏了，
 * 所以启动时要把这句话说出来。
 */
export function lanAddressWarning(address) {
  if (!address || isPrivatePeer(address)) return null
  return `${address} 不在私有网段，局域网入口会拒绝所有来源；--lan 请给局域网地址`
}

/**
 * 起局域网监听器。绑定失败不抛——本机入口已经起来了，不能因为局域网这一半
 * 把整个 daemon 拖死；调用方只负责把 error 打给人看。
 *
 * @returns {Promise<{ server: import('node:http').Server|null, address: string, error: Error|null, warning: string|null }>}
 */
export async function attachLanListener({ port, address, serverOptions = {} }) {
  const warning = lanAddressWarning(address)
  const server = createAppServer({ ...serverOptions, mode: 'lan' })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, address, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    return { server, address, error: null, warning }
  } catch (error) {
    server.close()
    return { server: null, address, error, warning }
  }
}
