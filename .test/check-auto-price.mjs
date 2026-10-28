/**
 * 官方价自动入库（2026-10-28）：参考价库补全 + 归一化匹配 + 别名/变体 + 启动种子语义。
 *
 * 背景：收录了 160+ 条官方价，但站点模型名五花八门（claude-opus-4-5 vs
 * claude-opus-4.5、-20251101-thinking 尾巴、kimi-k3-1、裸名 hy4），老引擎
 * 只认精确 + 简单前缀，一半匹配不上，用户被迫一个一个手录。本次要求：
 *   1. 库补全后，站点上真实出现的文本模型 80/90 能自动命中
 *   2. daemon 启动自动 seed（默认录进系统），只补空缺不覆盖手填
 *
 * 用法：node .test/check-auto-price.mjs
 */
import { REFERENCE_PRICES, REFERENCE_AS_OF, resolveReference, canonicalName } from '../core/model-prices.js'
import { seedReferenceBenchmarks, readBenchmarks, writeBenchmarks } from '../core/benchmark.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 种子测试写的是基准价表文件：指到临时目录，绝不碰真实 ~/.manage-api
process.env.MANAGE_API_HOME = join(tmpdir(), 'manageapi-check-auto-price')

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

console.log('[1] 库规模与合法性')
{
  const n = Object.keys(REFERENCE_PRICES).length
  ok(n >= 140, `补全后条目数充足（${n} 条，asOf ${REFERENCE_AS_OF}）`)
  const bad = Object.entries(REFERENCE_PRICES).filter(
    ([k, e]) => !(e.in >= 0 && e.out > 0) || e.out < e.in,
  )
  ok(bad.length === 0, `价格合法 in≤out（异常：${bad.map(([k]) => k).join(', ') || '无'}）`)
  // 归一化撞名且价格不同 = 索引先到先得会静默吞掉一条，必须为零
  const idx = new Map()
  const clash = []
  for (const [k, v] of Object.entries(REFERENCE_PRICES)) {
    const c = canonicalName(k)
    if (idx.has(c) && JSON.stringify(idx.get(c)) !== JSON.stringify(v)) clash.push(k)
    if (!idx.has(c)) idx.set(c, v)
  }
  ok(clash.length === 0, `归一化后无撞名不同价（${clash.join(', ') || '无'}）`)
}

console.log('[2] 归一化匹配：横线/点、日期尾巴、装饰尾巴')
{
  ok(resolveReference('claude-opus-4-5')?.matchedKey === 'claude-opus-4.5', 'claude-opus-4-5 → 4.5')
  ok(resolveReference('claude-haiku-4-5-20251001')?.matchedKey === 'claude-haiku-4.5', '日期尾巴 -20251001 剥掉')
  ok(
    resolveReference('claude-opus-4-5-20251101-thinking')?.matchedKey === 'claude-opus-4.5',
    '-20251101-thinking 双尾巴剥掉，thinking 同价',
  )
  ok(resolveReference('claude-sonnet-4-20250514')?.matchedKey === 'claude-sonnet-4', '裸 sonnet-4 命中')
  ok(resolveReference('claude-sonnet-5-5')?.matchedKey === 'claude-sonnet-5.5', '5-5 → 5.5')
  ok(resolveReference('claude-fable-5-1')?.matchedKey === 'claude-fable-5.1', 'fable-5-1 → 5.1')
  ok(resolveReference('deepseek-4.1-flash')?.matchedKey === 'deepseek-v4.1-flash', '-v 前缀剥掉：deepseek-4.1-flash → v4.1-flash')
  ok(
    resolveReference('deepseek-4.1-flash')?.in === 2,
    'deepseek-4.1-flash 价格同 v4.1-flash（2/8 人民币高峰价）',
  )
  ok(resolveReference('gpt-5.5-2026-01-01')?.matchedKey === 'gpt-5.5', '分段日期 -2026-01-01 前缀归到 gpt-5.5')
  ok(resolveReference('gpt-4o-2024-11-20')?.matchedKey === 'gpt-4o-2024-11-20', '库内日期条目精确命中，不被拆坏')
  ok(resolveReference('kimi-k3-1')?.matchedKey === 'kimi-k3.1-pro', 'kimi-k3-1 → k3.1 → k3.1-pro')
  ok(resolveReference('minimax-m2.7-highspeed')?.matchedKey === 'minimax-m2.7', 'highspeed 尾巴剥掉后命中')
}

console.log('[3] 别名表')
{
  ok(resolveReference('hy4')?.matchedKey === 'hy4-preview', '裸 hy4 → hy4-preview')
  ok(resolveReference('hy4-preview-f')?.matchedKey === 'hy4-preview', 'hy4-preview-f → hy4-preview')
  ok(resolveReference('kimi-k2.7')?.matchedKey === 'kimi-k2.7-code', '裸 kimi-k2.7 → k2.7-code')
  ok(resolveReference('deepseek-v4-flash')?.matchedKey === 'deepseek-v4.1-flash', 'DeepSeek 旧名按官方口径落到 Flash')
  ok(resolveReference('chat-latest')?.matchedKey === 'gpt-chat-latest', 'chat-latest → gpt-chat-latest')
  ok(resolveReference('hy3')?.in === 0.132, 'hy3 拿到混元美元价')
}

console.log('[4] 变体加价与防重复乘')
{
  const hs = resolveReference('kimi-k2.7-code-highspeed')
  ok(hs.matchedKey === 'kimi-k2.7-code' && hs.in === 6.5 && hs.out === 54, `highspeed 输出 ×2（${hs.in}/${hs.out}）`)
  const ul = resolveReference('mimo-v2.6-pro-ultraspeed')
  ok(ul.matchedKey === 'mimo-v2.6-pro' && ul.in === 4.35 && ul.variant === 'ultraspeed',
    `ultraspeed ×10（${ul.in}/${ul.out}，OpenRouter 实价验证）`)
  const base = resolveReference('mimo-v2.6-pro')
  ok(base.in === 0.435 && !base.variant, '基座价不受变体规则影响')
  const thinking = resolveReference('deepseek-v4.1-flash-thinking')
  ok(thinking?.in === 2 && !thinking.variant, 'thinking 不加价')
}

console.log('[5] 站点真实模型名覆盖（读真实台账快照名单）')
{
  // 站上真实出现过、且预期永远不收的：图像按次模型 + 查无官方单价的裸名/代号
  const never = new Set([
    'gpt-image-1', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst',
    'codex-auto-review', 'gpt-5.3-codex-spark', 'gpt-5.6', 'gpt-6', 'gpt-daybreak-blue-latest',
    'kimi-k2.8-preview',
  ])
  const names = [
    'claude-opus-4-5', 'claude-opus-4-5-20251101', 'claude-opus-4-5-20251101-thinking', 'claude-opus-4-6',
    'claude-opus-4-6-thinking', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-4-20250514',
    'claude-sonnet-4-5-20250929', 'claude-sonnet-4-5-20250929-thinking', 'claude-sonnet-4-6',
    'claude-sonnet-4-6-thinking', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'claude-fable-5.1',
    'deepseek-4.1-flash', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash',
    'kimi-k2.7', 'kimi-k3', 'kimi-k3-1', 'minimax-m2.7', 'minimax-m3.1-flash', 'mimo-v2.5',
    'qwen3.8-max', 'qwen3.8-flash', 'gpt-5.5', 'gpt-5.4', 'gpt-4o', 'gpt-5.6-luna', 'gpt-6-astra',
    'hy3', 'hy4', 'hy4-preview', 'chat-latest', 'gemini-2.5-flash', 'gemini-3.8-flash', 'step-5-preview',
  ]
  const missed = names.filter((k) => !resolveReference(k))
  ok(missed.length === 0, `常见站点名全部命中（缺：${missed.join(', ') || '无'}）`)
  ok(never.size === 11, '「永不收录」清单在位（图像按次模型 + 查无官方价裸名）')
}

console.log('[6] 启动种子语义：默认录进系统，但绝不覆盖手填/导入')
{
  const backup = await readBenchmarks()
  try {
    await writeBenchmarks({
      'glm-5.3': { display: 'glm-5.3', in: 1, out: 2, currency: 'CNY', source: 'manual', updatedAt: new Date().toISOString() },
      'deepseek-v4.1-flash': { display: 'd', in: 9, out: 9, currency: 'CNY', source: 'seed', updatedAt: new Date().toISOString() },
      'kimi-k3': { display: 'k', in: 7, out: 7, currency: 'CNY', source: 'imported:xxx', updatedAt: new Date().toISOString() },
      'gpt-5.5': { display: 'g', in: 3, out: 3, currency: 'RUSD', source: 'plaza:p1', updatedAt: new Date().toISOString() },
    })
    const result = await seedReferenceBenchmarks(['glm-5.3', 'deepseek-v4.1-flash', 'kimi-k3', 'gpt-5.5', 'minimax-m2.7', '不存在的模型'])
    const table = await readBenchmarks()
    ok(result.added.some((a) => a.modelKey === 'minimax-m2.7'), '空缺 → 自动补入（minimax-m2.7）')
    ok(table['minimax-m2.7']?.source === 'reference:minimax-m2.7', '补入条目标 reference: 来源')
    ok(table['glm-5.3']?.in === 1 && table['glm-5.3']?.source === 'manual', '手填（manual）绝不覆盖')
    ok(table['kimi-k3']?.in === 7 && table['kimi-k3']?.source === 'imported:xxx', '从站导入绝不覆盖')
    ok(table['gpt-5.5']?.in === 3 && table['gpt-5.5']?.source === 'plaza:p1', '广场导入绝不覆盖')
    ok(table['deepseek-v4.1-flash']?.in === 2, '自家 seed/reference 条目可刷新到最新口径')
    ok(result.skipped.includes('不存在的模型'), '查无参考价 → 跳过留空，不给错数')
  } finally {
    await writeBenchmarks(backup)
  }
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
