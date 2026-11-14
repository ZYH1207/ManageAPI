#!/usr/bin/env node
/**
 * tools/vendor-theme.mjs
 *
 * 把 ManageAPI 网页版的样式表（默认 ../web/style.css）作用域化后，
 * 内置生成为一个零依赖、可直接 require/import 的 JS 模块：
 *
 *   lib/theme.js  ->  export const THEME_CSS / THEME_STYLE_ID / injectTheme
 *
 * 用法：
 *   node tools/vendor-theme.mjs <style.css 路径>
 *   node tools/vendor-theme.mjs                # 仅当默认路径 ../web/style.css 存在时
 *
 * 为什么需要它：插件客户端是预打包的单文件，无法加载外部 CSS；面板会被插进
 * DSH 宿主页面，所以样式必须整体挂到面板根节点 `.ma-root` 之下，绝不能污染宿主。
 *
 * 转换规则（与 README / 面板实现约定一致）：
 *   - 删除 @import / @charset / @font-face / @namespace（外部引用块）
 *   - :root                        -> .ma-root（CSS 变量挂到面板根节点）
 *   - [data-theme='dark']          -> .ma-root[data-ma-theme='dark']
 *   - html / body / html, body / * -> 见 scopeSelector()：删掉或改写为 .ma-root 作用域
 *   - 其余选择器按顶层逗号拆分，逐个加 `.ma-root ` 前缀（不会拆坏 :is()/属性值里的逗号）
 *   - @media / @supports 内部递归处理；@keyframes 内部原样保留，但动画名统一加 `ma-` 前缀
 *
 * 输出是确定性的：同一份输入永远生成同一份输出（无时间戳、无随机量），可重复运行。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DEFAULT_SOURCE = resolve(ROOT, '..', 'web', 'style.css')
const OUT_FILE = resolve(ROOT, 'lib', 'theme.js')
const STYLE_ID = 'dsh-manage-api-theme'

const ROOT_CLASS = '.ma-root'
const THEME_ATTR = '[data-ma-theme='
const DROPPED_AT_RULES = new Set(['import', 'charset', 'font-face', 'namespace'])
// 内部仍是「选择器 + 声明」的 at-rule：递归作用域化
const NESTED_AT_RULES = new Set(['media', 'supports', 'container', 'layer', 'scope', 'starting-style', 'document'])
const RAW_AT_RULES = new Set(['keyframes', '-webkit-keyframes'])

const USAGE = `用法:
  node tools/vendor-theme.mjs <style.css 路径>
  node tools/vendor-theme.mjs                # 默认尝试 ${(relative(process.cwd(), DEFAULT_SOURCE) || DEFAULT_SOURCE).split(/[\\/]/).join('/')}

说明: 读取 ManageAPI 网页版 style.css，作用域化后写入 lib/theme.js（内置 CSS 字符串）。
      输出是确定性的，重复运行结果一致。`

/* ------------------------------------------------------------------ 基础扫描 */

const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f'

function skipComment(text, i) {
  const end = text.indexOf('*/', i + 2)
  return end === -1 ? text.length : end + 2
}

function skipString(text, i) {
  const quote = text[i]
  let j = i + 1
  while (j < text.length) {
    const c = text[j]
    if (c === '\\') { j += 2; continue }
    if (c === quote) return j + 1
    j++
  }
  throw new Error(`未闭合的字符串（偏移 ${i}）`)
}

/** 读取一段前导（选择器或 at-rule 头部），停在顶层的 { ; } 或 EOF */
function readPrelude(text, i) {
  let j = i
  let paren = 0
  while (j < text.length) {
    const c = text[j]
    if (c === '/' && text[j + 1] === '*') { j = skipComment(text, j); continue }
    if (c === '"' || c === "'") { j = skipString(text, j); continue }
    if (c === '(') paren++
    else if (c === ')') paren = Math.max(0, paren - 1)
    else if (paren === 0 && (c === '{' || c === ';' || c === '}')) {
      return { prelude: text.slice(i, j), term: c, next: j }
    }
    j++
  }
  return { prelude: text.slice(i), term: '', next: text.length }
}

/** text[i] === '{'，返回配平的块内容 */
function readBlock(text, i) {
  let depth = 0
  let j = i
  while (j < text.length) {
    const c = text[j]
    if (c === '/' && text[j + 1] === '*') { j = skipComment(text, j); continue }
    if (c === '"' || c === "'") { j = skipString(text, j); continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return { body: text.slice(i + 1, j), next: j + 1 }
    }
    j++
  }
  throw new Error(`未配平的 { 块（偏移 ${i}）`)
}

/* ------------------------------------------------------------------ 解析成树 */

function atRuleName(head) {
  const m = /^[-\w]+/.exec(head)
  return m ? m[0].toLowerCase() : ''
}

function parseRuleList(text) {
  const nodes = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (isSpace(c)) { i++; continue }
    if (c === '/' && text[i + 1] === '*') { i = skipComment(text, i); continue }
    if (c === '}') { i++; continue }
    if (c === ';') { i++; continue }

    if (c === '@') {
      const r = readPrelude(text, i + 1)
      const head = r.prelude.trim()
      const name = atRuleName(head)
      if (r.term === '{') {
        const blk = readBlock(text, r.next)
        if (NESTED_AT_RULES.has(name)) {
          nodes.push({ type: 'at-nested', name, prelude: head, children: parseRuleList(blk.body) })
        } else if (RAW_AT_RULES.has(name)) {
          nodes.push({ type: 'keyframes', name, prelude: head, body: blk.body })
        } else {
          nodes.push({ type: 'at-raw', name, prelude: head, body: blk.body })
        }
        i = blk.next
      } else {
        nodes.push({ type: 'at-stmt', name, prelude: head })
        i = r.next + (r.term === ';' ? 1 : 0)
      }
      continue
    }

    const r = readPrelude(text, i)
    if (r.term !== '{') {
      // 顶层游离的声明/垃圾文本：跳过
      i = r.term === ';' ? r.next + 1 : r.next
      continue
    }
    const blk = readBlock(text, r.next)
    nodes.push({ type: 'rule', selector: r.prelude.trim(), body: blk.body })
    i = blk.next
  }
  return nodes
}

/* ------------------------------------------------------- 文本规整（去注释/压缩空白） */

/**
 * 去注释 + 把空白折叠成单个空格（字符串字面量内容原样保留）。
 * tidySemicolons: 顺带规整 `;` 两侧空白（声明块用）。刻意不动 `:`，
 * 否则会把 `url(data:...)`、`content: "a:b"` 之类拆坏。
 */
function compactWhitespace(src, tidySemicolons = false) {
  let out = ''
  const pushSpace = () => { if (out && !out.endsWith(' ')) out += ' ' }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '*') { i = skipComment(src, i); pushSpace(); continue }
    if (c === '"' || c === "'") { const j = skipString(src, i); out += src.slice(i, j); i = j; continue }
    if (isSpace(c)) {
      let j = i
      while (j < src.length && isSpace(src[j])) j++
      pushSpace()
      i = j
      continue
    }
    if (tidySemicolons && c === ';') {
      out = out.replace(/\s+$/, '') + '; '
      i++
      while (i < src.length && isSpace(src[i])) i++
      continue
    }
    out += c
    i++
  }
  return out.trim()
}

/** 选择器 / keyframes 体：只折叠空白 */
const squash = (src) => compactWhitespace(src, false)

/** 声明块：折叠空白 + 规整 `;`，保证同一份输入产出同一串字符 */
const tidyDecls = (src) => compactWhitespace(src, true)

/* --------------------------------------------------------------- 选择器作用域化 */

/** 按顶层逗号拆选择器列表（不拆 :is(...)/[...=","] 里的逗号） */
function splitTopLevelCommas(list) {
  const parts = []
  let start = 0
  let i = 0
  let paren = 0
  let bracket = 0
  while (i < list.length) {
    const c = list[i]
    if (c === '"' || c === "'") { i = skipString(list, i); continue }
    if (c === '(') paren++
    else if (c === ')') paren = Math.max(0, paren - 1)
    else if (c === '[') bracket++
    else if (c === ']') bracket = Math.max(0, bracket - 1)
    else if (c === ',' && paren === 0 && bracket === 0) {
      parts.push(list.slice(start, i))
      start = i + 1
    }
    i++
  }
  parts.push(list.slice(start))
  return parts
}

/** 统计给报告用 */
const stats = {
  globalDropped: [],
  globalRewritten: [],
  themeSelectors: 0,
  rootedSelectors: 0,
  unknownAtRules: [],
  droppedAtRules: [],
}

function scopeSelector(raw) {
  const sel = squash(raw)
  if (!sel) return []

  // 1) [data-theme='dark'] / [data-theme="dark"] -> [data-ma-theme='dark']，并保证带 .ma-root
  let s = sel.replace(
    /\[data-theme\s*=\s*([^\]]*)\]/gi,
    (_m, value) => {
      stats.themeSelectors++
      const v = String(value).trim().replace(/^['"]|['"]$/g, '')
      return `${THEME_ATTR}'${v}']`
    },
  )

  // 2) :root -> .ma-root（CSS 变量挂到面板根节点）
  s = s.replace(/:root\b/g, ROOT_CLASS)

  // 2b) 深色 token 挂在根节点自身：`[data-ma-theme='dark'] ...` -> `.ma-root[data-ma-theme='dark'] ...`
  if (s.startsWith(THEME_ATTR)) s = ROOT_CLASS + s

  // 3) 全局通配 *：box-sizing 之类的重置要覆盖面板内部，但不能碰宿主
  if (s === '*') {
    stats.globalRewritten.push('* -> .ma-root, .ma-root *')
    return [`${ROOT_CLASS}`, `${ROOT_CLASS} *`]
  }

  // 4) 已经作用域化（含 :root / [data-theme] 改写结果）
  if (s.startsWith(ROOT_CLASS)) return [s]

  // 5) html / body 开头的复合选择器 -> 面板根节点上的复合选择器
  const lead = /^(html|body)(?![-\w])/.exec(s)
  if (lead) {
    const out = ROOT_CLASS + s.slice(lead[1].length)
    stats.globalRewritten.push(`${s} -> ${out}`)
    return [out]
  }

  // 6) 其余统一加前缀
  return [`${ROOT_CLASS} ${s}`]
}

/* ------------------------------------------------------------ 动画名（keyframes） */

function keyframeName(prelude) {
  // prelude 形如 `keyframes busy-spin`（不含 @）
  return prelude.replace(/^[-\w]+\s*/, '').trim()
}

function animationRenamer(names) {
  if (names.length === 0) return (decls) => decls
  const pattern = names
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const re = new RegExp(`(?<![\\w-])(${pattern})(?![\\w-])`, 'g')
  return (decls) =>
    decls.replace(/\b(animation(?:-name)?)\s*:\s*([^;]+)/g, (_m, prop, value) => {
      return `${prop}: ${value.replace(re, 'ma-$1')}`.trim()
    })
}

/* ------------------------------------------------------------------ 渲染成 CSS */

const lines = []

function indentOf(depth) {
  return '  '.repeat(depth)
}

function renderRule(node, depth, rename) {
  const pad = indentOf(depth)
  const decls = tidyDecls(node.body)
  if (!decls) return
  const selectors = splitTopLevelCommas(node.selector).flatMap(scopeSelector)
  if (selectors.length === 0) {
    stats.globalDropped.push(node.selector)
    return
  }
  for (const s of selectors) {
    if (!s.startsWith(ROOT_CLASS)) {
      throw new Error(`内部错误：选择器未作用域化: ${s}`)
    }
    stats.rootedSelectors++
  }
  lines.push(`${pad}${selectors.join(', ')} { ${rename(decls)} }`)
}

function renderNodes(nodes, depth, rename) {
  for (const node of nodes) {
    if (node.type === 'rule') { renderRule(node, depth, rename); continue }
    if (node.type === 'at-nested') {
      const pad = indentOf(depth)
      lines.push(`${pad}@${node.prelude} {`)
      renderNodes(node.children, depth + 1, rename)
      lines.push(`${pad}}`)
      continue
    }
    if (node.type === 'keyframes') {
      const name = keyframeName(node.prelude)
      const prefixed = name.startsWith('ma-') ? name : `ma-${name}`
      lines.push(`${indentOf(depth)}@${node.prelude.replace(name, prefixed)} { ${squash(node.body)} }`)
      continue
    }
    // @import / @charset / @font-face / @namespace：外部引用块，直接丢弃
    if (DROPPED_AT_RULES.has(node.name)) {
      stats.droppedAtRules.push(node.name)
      continue
    }
    // 认不出、又带块的 at-rule 直接失败：宁可报错，也不让里面的选择器绕过作用域化
    if (node.type === 'at-raw') {
      throw new Error(
        `未识别的 at-rule「@${node.prelude}」：请先把它加入 NESTED_AT_RULES（内部是规则）` +
          '或 DROPPED_AT_RULES（外部引用），再重新生成。',
      )
    }
    if (node.type === 'at-stmt') {
      stats.unknownAtRules.push(node.prelude)
      lines.push(`${indentOf(depth)}@${node.prelude};`)
      continue
    }
  }
}

/* -------------------------------------------------------------------- 校验 */

function verify(cssText) {
  const problems = []
  let rules = 0
  let keyframes = 0

  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.type === 'rule') {
        for (const raw of splitTopLevelCommas(node.selector)) {
          const s = squash(raw)
          if (!s) continue
          rules++
          if (!s.startsWith(ROOT_CLASS)) problems.push(s)
        }
        continue
      }
      if (node.type === 'at-nested') { walk(node.children); continue }
      if (node.type === 'keyframes') { keyframes++; continue }
    }
  }
  walk(parseRuleList(cssText))

  // @keyframes 内部的选择器（0% / to）不算规则，不参与前缀断言
  if (/@import\b/i.test(cssText)) problems.push('@import 残留')
  if (/@charset\b/i.test(cssText)) problems.push('@charset 残留')
  if (/@font-face\b/i.test(cssText)) problems.push('@font-face 残留')
  if (/url\(\s*['"]?https?:/i.test(cssText)) problems.push('外部 url(http...) 残留')

  const rootCount = (cssText.match(/\.ma-root/g) || []).length
  return { problems, rules, keyframes, rootCount, bytes: Buffer.byteLength(cssText, 'utf8') }
}

/* -------------------------------------------------------------- 生成 JS 模块 */

function toJsStringLiteral(value) {
  // JSON.stringify 产出的双引号字符串同时是合法 JS 字符串字面量；
  // 再补上 U+2028/2029（老解析器会当成换行）。
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function buildModule(cssText, sourceLabel, v) {
  const cssLines = cssText.replace(/\n+$/, '').split('\n')
  const body = cssLines.map((line) => `  ${toJsStringLiteral(line)},`).join('\n')
  return `// 由 tools/vendor-theme.mjs 从 ${sourceLabel} 生成，请勿手改。
// 源文件含浅色 token（:root）与深色 token（[data-theme='dark']，此处改写为
// ${ROOT_CLASS}${THEME_ATTR}'dark']，靠面板根节点上的 data-ma-theme="dark" 生效）。
// 所有选择器均已作用域化到 ${ROOT_CLASS}，注入宿主页面不会污染宿主全局样式。
// 生成的 CSS：${v.bytes} 字节 / ${v.rules} 条规则 / .ma-root 出现 ${v.rootCount} 次。
// 重新生成：node tools/vendor-theme.mjs ${sourceLabel}

export const THEME_STYLE_ID = '${STYLE_ID}'

/** 作用域化后的 ManageAPI 样式表（所有选择器以 .ma-root 开头）。 */
export const THEME_CSS = [
${body}
].join('\\n')

/**
 * 把样式表注入文档一次；重复调用是幂等的。
 * @param {Document} [doc] 目标文档，默认取全局 document
 * @returns {() => void} dispose 函数，用于移除 <style>
 */
export function injectTheme(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null)
  if (!d || d.getElementById(THEME_STYLE_ID)) return function noop() {}
  const el = d.createElement('style')
  el.id = THEME_STYLE_ID
  el.textContent = THEME_CSS
  ;(d.head || d.documentElement).appendChild(el)
  return function dispose() {
    try {
      el.remove()
    } catch {}
  }
}
`
}

/* ---------------------------------------------------------------------- 主流程 */

function main() {
  const arg = process.argv[2]
  const source = arg ? resolve(process.cwd(), arg) : DEFAULT_SOURCE

  if (!existsSync(source)) {
    console.error(`找不到源样式表: ${source}\n`)
    console.error(USAGE)
    process.exit(1)
  }

  const raw = readFileSync(source, 'utf8')
  if (!raw.trim()) {
    console.error(`源样式表是空的: ${source}`)
    process.exit(1)
  }

  const sourceLabel = relative(ROOT, source).split(/[\\/]/).join('/')
  const nodes = parseRuleList(raw)

  // 动画名要先收集，声明里的 animation: 才能同步改名
  const keyframeNames = nodes
    .filter((n) => n.type === 'keyframes')
    .map((n) => keyframeName(n.prelude))
    .filter(Boolean)
  const rename = animationRenamer(keyframeNames)

  lines.length = 0
  renderNodes(nodes, 0, rename)
  const cssText = lines.join('\n') + '\n'

  const v = verify(cssText)
  if (v.problems.length > 0) {
    console.error(`校验失败：${v.problems.length} 处未作用域化/残留:`)
    for (const p of v.problems.slice(0, 20)) console.error(`  - ${p}`)
    process.exit(1)
  }
  if (stats.rootedSelectors < 150) {
    console.error(`校验失败：作用域化选择器只有 ${stats.rootedSelectors} 个（预期 > 150）`)
    process.exit(1)
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true })
  writeFileSync(OUT_FILE, buildModule(cssText, sourceLabel, v), 'utf8')

  // node --check 自检（.js + package.json type:module 会按 ESM 解析）
  const check = spawnSync(process.execPath, ['--check', OUT_FILE], { encoding: 'utf8' })
  if (check.status !== 0) {
    console.error('node --check lib/theme.js 失败:')
    console.error(check.stderr || check.stdout)
    process.exit(check.status || 1)
  }

  const outBytes = Buffer.byteLength(readFileSync(OUT_FILE, 'utf8'), 'utf8')
  console.log(`源文件      : ${source} (${Buffer.byteLength(raw, 'utf8')} 字节)`)
  console.log(`输出文件    : ${OUT_FILE} (${outBytes} 字节)`)
  console.log(`CSS 字节数  : ${v.bytes}`)
  console.log(`规则数      : ${v.rules}（作用域化选择器 ${stats.rootedSelectors} 个）`)
  console.log(`.ma-root 数 : ${v.rootCount}`)
  console.log(`@keyframes  : ${v.keyframes} 个（已加 ma- 前缀: ${keyframeNames.map((n) => 'ma-' + n).join(', ') || '无'}）`)
  console.log(`丢弃 at-rule: ${[...new Set(stats.droppedAtRules)].join(', ') || '无'}`)
  console.log(`改写全局选择器:`)
  for (const s of [...new Set(stats.globalRewritten)]) console.log(`  - ${s}`)
  if (stats.globalDropped.length > 0) {
    console.log(`丢弃全局选择器: ${stats.globalDropped.join(' | ')}`)
  }
  if (stats.unknownAtRules.length > 0) {
    console.log(`保留的 @ 语句（无块，如 @layer 声明）: ${[...new Set(stats.unknownAtRules)].join(' | ')}`)
  }
  console.log(`自检        : node --check 通过，未发现未作用域化选择器 / @import / 外链 url()`)
}

main()
