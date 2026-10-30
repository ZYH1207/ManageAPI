/**
 * 剪贴板自检：局域网地址（http://192.168.x.x）下「复制」必须真的复制。
 *
 * 现场：从 Mac / 另一台电脑用局域网地址打开面板，点「复制 Key」看着没反应，
 * 到别处一粘，粘出来的是**上一次复制的地址**——因为这次根本没写进剪贴板。
 *
 * 根因：`navigator.clipboard` 只在**安全上下文**里存在（localhost 或 HTTPS）。
 * 面板从 `http://192.168.1.26:4319/` 打开时不是安全上下文，`navigator.clipboard`
 * 直接是 `undefined`，`navigator.clipboard.writeText(...)` 抛 TypeError；
 * 而调用处是 `await` + 没有 try 的 async 事件处理器，异常变成未处理的 rejection，
 * 连 toast 都不会出现——用户只能靠「粘出来不对」才发现。
 *
 * 而「局域网访问」这个功能本身就是让人从别的设备用 http://<IP> 打开面板，
 * 所以这条路径必然踩到，不是边角情况。
 *
 * 断言口径（纯源码守卫，不需要浏览器）：
 *   [1] copyText 三级降级：clipboard API（可选链保护）→ execCommand 回退 → 返回 false
 *   [2] 复制失败时必须 showCopyBox（把内容摊开让人自己复制），不许提示「已复制」
 *   [3] 所有复制入口都走 copyText / copyWithFeedback，不许再直接调 navigator.clipboard
 *   [4] 网关 Key 复制传的是 record.key（不是地址），地址复制才用 location.origin
 *
 * 用法：node .test/check-copy-clipboard.mjs
 */
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = await readFile(join(ROOT, 'web', 'app.js'), 'utf8')

let failed = 0
const ok = (cond, msg, extra) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}${extra ? `  ← ${extra}` : ''}`)
  }
}

/** 取一个函数体的粗切片（从声明到下一个顶层 function/async function），够做源码守卫用 */
function bodyOf(name) {
  const start = app.indexOf(`function ${name}(`)
  const alt = app.indexOf(`async function ${name}(`)
  const from = alt !== -1 ? alt : start
  if (from === -1) return ''
  const next = app.indexOf('\nasync function ', from + 1)
  const nextPlain = app.indexOf('\nfunction ', from + 1)
  const candidates = [next, nextPlain].filter((i) => i > from)
  const end = candidates.length ? Math.min(...candidates) : app.length
  return app.slice(from, end)
}

// ---------------------------------------------------------------- [1] 三级降级
console.log('[1] copyText 的三级降级')
{
  const body = bodyOf('copyText')
  ok(body.length > 0, '存在 copyText()')
  ok(/navigator\.clipboard\?\.writeText/.test(body), '先用标准 API，且用可选链（非安全上下文下 clipboard 是 undefined）')
  ok(/await navigator\.clipboard\.writeText\(value\)/.test(body), '标准 API 里 await 的是实际文本')
  ok(/document\.execCommand\('copy'\)/.test(body), '回退到 execCommand(copy)')
  ok(/createElement\('textarea'\)/.test(body), '回退时建临时 textarea')
  ok(/area\.select\(\)/.test(body) && /setSelectionRange/.test(body), '回退时先选中（否则 execCommand 拿不到选区）')
  ok(/area\.remove\(\)/.test(body), '用完把临时节点删掉')
  ok(/return false/.test(body), '两条路都不行时返回 false（不谎报成功）')
  // 两层 try：clipboard 失败要继续往下降，不能把异常冒出去
  ok((body.match(/catch\s*\{/g) || []).length >= 2, '两级 catch：API 失败继续降级、execCommand 失败继续降级')
}

// ---------------------------------------------------------------- [2] 失败不撒谎
console.log('\n[2] 复制失败时的兜底：不许提示「已复制」')
{
  const body = bodyOf('copyWithFeedback')
  ok(body.length > 0, '存在 copyWithFeedback()')
  ok(/if \(await copyText\(/.test(body), '先判断是否真的复制成功')
  ok(/showCopyBox\(/.test(body), '失败时弹 showCopyBox')
  ok(body.indexOf('showCopyBox') > body.indexOf('copyText'), '顺序：先试复制，失败才弹窗')
  const box = bodyOf('showCopyBox')
  ok(box.length > 0, '存在 showCopyBox()')
  ok(/readonly/.test(box), '弹窗里的输入框是只读的（防误改）')
  ok(/area\.select\(\)/.test(box), '弹窗打开就全选，直接 ⌘C / Ctrl+C 即可')
  ok(/Ctrl\/⌘ \+ C|Ctrl\/⌘/.test(box) || /手动复制/.test(box), '弹窗里写清楚怎么复制')
}

// ---------------------------------------------------------------- [3] 入口都走它
console.log('\n[3] 所有复制入口都走统一实现')
{
  // 只允许 copyText 内部出现 navigator.clipboard（含注释里的说明）
  const codeOnly = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const hits = (codeOnly.match(/navigator\.clipboard/g) || []).length
  ok(hits === 2, '代码里只有 copyText 用 navigator.clipboard（2 处：判空 + 调用）', `实际 ${hits} 处`)

  const actions = ['copy-base', 'copy-gwkey', 'copy-new-gwkey', 'copy-lan-token', 'copy-lan-link']
  for (const act of actions) {
    const at = app.indexOf(`action === '${act}'`)
    ok(at !== -1, `存在 ${act} 处理分支`)
    const slice = app.slice(at, at + 700)
    ok(/copyWithFeedback\(|copyText\(/.test(slice), `${act} 走 copyWithFeedback / copyText`)
  }
  const contactCopy = app.indexOf("contactCard.dataset.act === 'copy-contact'")
  ok(contactCopy !== -1 && /copyWithFeedback\(/.test(app.slice(contactCopy, contactCopy + 400)), '联系人卡片复制也走统一实现')
  const diagnose = app.indexOf('诊断信息已复制')
  ok(diagnose !== -1 && /copyText\(text\)/.test(app.slice(Math.max(0, diagnose - 400), diagnose + 200)), '诊断信息复制也走 copyText')
}

// ---------------------------------------------------------------- [4] 复制的是对的内容
console.log('\n[4] 复制的内容对得上：Key 是 Key、地址是地址')
{
  const at = app.indexOf("action === 'copy-gwkey'")
  const slice = app.slice(at, at + 500)
  ok(/copyWithFeedback\(record\.key/.test(slice), '复制 Key 传的是 record.key')
  ok(!/location\.origin/.test(slice), '复制 Key 不掺 location.origin')

  const base = app.indexOf("action === 'copy-base'")
  const baseSlice = app.slice(base, base + 300)
  ok(/location\.origin/.test(baseSlice), '复制地址用的是 location.origin（局域网下自动变成 192.168 那个）')
  ok(!/record\.key/.test(baseSlice), '复制地址不掺 Key')

  const lan = app.indexOf("action === 'copy-lan-link'")
  const lanSlice = app.slice(lan, lan + 600)
  ok(/\?token=/.test(lanSlice), '复制带令牌链接时拼上 ?token=')
  ok(/encodeURIComponent\(token\)/.test(lanSlice), '令牌做了 URL 编码')
}

console.log('')
if (failed) {
  console.error(`剪贴板自检：${failed} 项失败`)
  process.exit(1)
}
console.log('剪贴板自检：全部通过')
