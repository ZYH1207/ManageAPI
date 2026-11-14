// 一次性脚本：把 lib/theme.js 的 THEME_CSS（作用域化后的整张样式表字符串）
// 嵌入 client.js 的 // >>> theme:begin … // <<< theme:end 标记块之间。
// 用法：node tools/embed-theme.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const themePath = join(root, 'lib', 'theme.js')
const clientPath = join(root, 'client.js')

const { THEME_CSS } = await import(pathToFileURL(themePath).href)
const css = typeof THEME_CSS === 'string' ? THEME_CSS : ''
if (!css || css.length < 1000) throw new Error('theme.js 里没有可用的 THEME_CSS')

const block = [
  '    // >>> theme:begin',
  '    // 由 tools/embed-theme.mjs 从 lib/theme.js 灌入，请勿手改这一段。',
  `    var THEME_CSS = ${JSON.stringify(css)}`,
  "    var THEME_STYLE_ID = 'dsh-manage-api-theme'",
  '    // <<< theme:end',
].join('\n')

const source = readFileSync(clientPath, 'utf8')
const re = /[ \t]*\/\/ >>> theme:begin[\s\S]*?\/\/ <<< theme:end/
if (!re.test(source)) throw new Error('client.js 里找不到 theme 标记块')
const next = source.replace(re, block)
writeFileSync(clientPath, next, 'utf8')
console.log(`embedded ${css.length} bytes of CSS into client.js (total ${next.length} bytes)`)
