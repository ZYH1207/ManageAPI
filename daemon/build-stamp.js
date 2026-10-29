/**
 * 静态入口资源的构建戳（`/app.js?v=xxxxxxxx`）。
 *
 * 为什么要有这个东西：面板是纯 SPA，`web/index.html` 只有一句
 * `<script type="module" src="/app.js">`，页面开着的时候只有一个 setInterval 在刷
 * `/api/state` 的数据，从来不重取代码。于是合并 / 重启 daemon 之后，昨天就打开的标签页
 * 会一直跑旧模块图：余额、请求日志都在动（数据是新的），界面却停在上一个版本，
 * 新加的东西看起来「凭空消失」，排查时极容易被误判成代码丢了。
 * 没有版本号时浏览器也无从判断这个 URL 换了内容。
 *
 * 戳的算法：`web/` 下所有 .js/.css 的「相对路径 + mtime + 大小」排序后取 sha1 前 8 位。
 * 不用 git 哈希，是因为本仓常见「改完文件、没提交、刷新就要看到效果」——
 * mtime 才是真正生效的那一版。结果按 1 秒缓存，避免每次请求都去 stat 一遍。
 */
import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ASSET_EXT = /\.(?:js|mjs|css)$/i
const CACHE_MS = 1000

/** 递归列出目录下的 js/css（相对路径，排序保证同一套文件得到同一个戳）。 */
export function listAssets(dir, prefix = '') {
  const out = []
  let entries = []
  try {
    entries = readdirSync(join(dir, prefix), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      out.push(...listAssets(dir, rel))
    } else if (ASSET_EXT.test(entry.name)) {
      out.push(rel)
    }
  }
  return out.sort()
}

/** 直接从磁盘算一次戳（不走缓存），测试和一次性校验用这个。 */
export function computeBuildStamp(dir) {
  const hash = createHash('sha1')
  for (const rel of listAssets(dir)) {
    try {
      const stat = statSync(join(dir, rel))
      hash.update(`${rel}:${Math.round(stat.mtimeMs)}:${stat.size}\n`)
    } catch {
      // 文件在列目录之后被删了：这一份不算，戳照样能算出来
    }
  }
  return hash.digest('hex').slice(0, 8)
}

const cache = new Map()

/** 带 1 秒缓存的戳：同一次页面加载里的多个请求不会反复 stat。 */
export function buildStamp(dir, now = Date.now()) {
  const hit = cache.get(dir)
  if (hit && now - hit.at < CACHE_MS) return hit.stamp
  const stamp = computeBuildStamp(dir)
  cache.set(dir, { at: now, stamp })
  return stamp
}

/** 只换本地的 js/css 引用，外链（http://、//）与已经带 ?v= 的不动。 */
const ASSET_REF = /(\s(?:src|href)=")\/([A-Za-z0-9._-]+\.(?:js|css))(")/g

/**
 * 把戳挂到入口 HTML 上：
 *   - 本地 `/xxx.js`、`/xxx.css` 引用加 `?v=<戳>`，浏览器因此不会把它当成同一个 URL；
 *   - 顺手写一条 `<meta name="manageapi-build">`，让人能一眼看出
 *     「我这个标签页跑的是哪一版」（对比 `curl -s / | grep manageapi-build`）。
 */
export function injectBuildStamp(html, stamp) {
  if (!stamp) return html
  const text = String(html)
  const stamped = text.replace(ASSET_REF, (_, pre, file, post) => `${pre}/${file}?v=${stamp}${post}`)
  if (/name="manageapi-build"/.test(stamped)) return stamped
  const meta = `<meta name="manageapi-build" content="${stamp}" />`
  if (/<head[^>]*>/i.test(stamped)) return stamped.replace(/<head([^>]*)>/i, (m) => `${m}\n  ${meta}`)
  return `${meta}\n${stamped}`
}
