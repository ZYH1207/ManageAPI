/**
 * 首字门槛档位自检（纯函数，不联网）：
 *   1. 20 档、1000~20000ms、按 500 为界就近取档
 *   2. 留空 / 0 / 负数 = 不限，超额输入按上界处理
 *   3. 每一档都有速度等级，等级单调不回头
 *
 * 用法：node .test/check-ttft-tier.mjs
 */
import {
  TTFT_TIERS,
  TTFT_TIER_MIN,
  TTFT_TIER_MAX,
  TTFT_TIER_STEP,
  SPEED_LEVELS,
  snapTtftMs,
  speedLevelOf,
  ttftTierTable,
  describeTtftLimit,
} from '../core/latency.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

console.log('[1] 档位表：20 档，1000~20000，步长 1000')
{
  ok(TTFT_TIERS.length === 20, `档位数量 ${TTFT_TIERS.length}`)
  ok(TTFT_TIERS[0] === TTFT_TIER_MIN, `首档 ${TTFT_TIERS[0]}`)
  ok(TTFT_TIERS[TTFT_TIERS.length - 1] === TTFT_TIER_MAX, `末档 ${TTFT_TIERS.at(-1)}`)
  ok(
    TTFT_TIERS.every((ms, i) => i === 0 || ms - TTFT_TIERS[i - 1] === TTFT_TIER_STEP),
    '档位等距',
  )
}

console.log('[2] 取档：500 为界，就近')
{
  const cases = [
    [0, 0],
    [null, 0],
    [undefined, 0],
    ['', 0],
    [-100, 0],
    [1, 1000],
    [499, 1000],
    [500, 1000],
    [501, 1000],
    [1000, 1000],
    [1499, 1000],
    [1500, 2000],
    [8000, 8000],
    [8499, 8000],
    [8500, 9000],
    [8501, 9000],
    [12345, 12000],
    [16522, 17000],
    [19499, 19000],
    [19500, 20000],
    [20000, 20000],
    [25000, 20000],
    [999999, 20000],
    ['8000', 8000],
  ]
  for (const [input, want] of cases) {
    const got = snapTtftMs(input)
    ok(got === want, `${JSON.stringify(input)} → ${got}（期望 ${want}）`)
  }
  ok(TTFT_TIERS.includes(snapTtftMs(7777)), '取档结果一定落在档位表里')
}

console.log('[3] 速度等级：每档都有，且单调')
{
  ok(speedLevelOf(0) === null, '不限没有等级')
  ok(speedLevelOf(1000)?.key === '极快', `1000 → ${speedLevelOf(1000)?.key}`)
  ok(speedLevelOf(2000)?.key === '极快', '2000 仍在极快')
  ok(speedLevelOf(3000)?.key === '快', '3000 → 快')
  ok(speedLevelOf(7000)?.key === '正常', '7000 → 正常')
  ok(speedLevelOf(8000)?.key === '偏慢', '8000 → 偏慢')
  ok(speedLevelOf(12000)?.key === '偏慢', '12000 仍在偏慢')
  ok(speedLevelOf(13000)?.key === '慢', '13000 → 慢')
  ok(speedLevelOf(20000)?.key === '慢', '20000 → 慢')
  ok(speedLevelOf(999999)?.key === '慢', '超出表也归到最慢一级，不会返回 undefined')

  const table = ttftTierTable()
  ok(table.length === 20, '表格 20 行')
  ok(
    table.every((row) => row.level && SPEED_LEVELS.some((level) => level.key === row.level)),
    '每一档都有合法的等级名',
  )
  const order = (key) => SPEED_LEVELS.findIndex((level) => level.key === key)
  ok(
    table.every((row, i) => i === 0 || order(row.level) >= order(table[i - 1].level)),
    '等级顺序不回头（极快 → 慢）',
  )
  ok(table[0].seconds === 1 && table.at(-1).seconds === 20, '秒数与毫秒同源')
}

console.log('[4] 一句话描述')
{
  ok(describeTtftLimit(0) === '不限', `0 → ${describeTtftLimit(0)}`)
  ok(describeTtftLimit(8000) === '第 8 档 · 8.0s · 偏慢', `8000 → ${describeTtftLimit(8000)}`)
  // 8600 先取 9000 档再描述——顺序反了会写出「8.6s」这种表里没有的档
  ok(describeTtftLimit(8600) === '第 9 档 · 9.0s · 偏慢', `8600 → ${describeTtftLimit(8600)}`)
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
