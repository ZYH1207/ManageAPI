/**
 * 改道门槛「按空耗时长、不按次数」自检（纯函数，不联网）。
 *
 * 背景（2026-10-28 作者纠偏）：是否故障转移（改道）看的是空回复**耽误了多少
 * 工作时间**，不是发生了几次——大上下文里一次白等一分钟，轻请求空十次也不疼。
 * 口径：emptyWastedMs 累加窗口内每次空回合的 wastedMs（失败尝试的实际耗时），
 * 达到 EMPTY_DETOUR_WASTED_MS（2 分钟/30 分钟窗口）才改道；平时只标「空回复」。
 *
 * 用法：node .test/check-empty-detour-threshold.mjs
 */
import { emptyWastedMs, EMPTY_DETOUR_WINDOW_MS, EMPTY_DETOUR_WASTED_MS } from '../core/empty-guard.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}
const now = Date.now()
const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString()
const event = (minutesAgo, wastedMs, providerId = 'p1', model = 'm1') => ({
  ts: at(minutesAgo),
  wastedMs,
  providerId,
  model,
})

console.log('[1] 阈值形状')
ok(EMPTY_DETOUR_WINDOW_MS === 30 * 60_000, '窗口 30 分钟')
ok(EMPTY_DETOUR_WASTED_MS === 120_000, '空耗门槛 2 分钟（真实损失约 4 分钟，补问翻倍）')

console.log('[2] 次数少但耗时长 → 改道（大上下文的刀）')
{
  // 3 次 × 50 秒 = 150 秒 ≥ 120 秒；按旧次数口径（10 次）根本够不着
  const events = [event(2, 50_000), event(10, 50_000), event(20, 50_000)]
  ok(emptyWastedMs(events, { providerId: 'p1', model: 'm1' }) >= EMPTY_DETOUR_WASTED_MS,
    '3 次共 150s 达标（旧口径 3<10 会放过）')
}

console.log('[3] 次数多但耗时短 → 不改道（补全救得回来的小请求）')
{
  // 20 次 × 3 秒 = 60 秒 < 120 秒；按旧次数口径（≥10 次）早就改道了
  const events = Array.from({ length: 20 }, (_, i) => event(i + 1, 3_000))
  ok(emptyWastedMs(events, { providerId: 'p1', model: 'm1' }) < EMPTY_DETOUR_WASTED_MS,
    '20 次共 60s 不达标（旧口径 20≥10 会错杀）')
}

console.log('[4] 只算自己站、自己模型、窗口内、真耗时')
{
  const events = [
    event(5, 100_000, 'p_other', 'm1'), // 别的站
    event(5, 100_000, 'p1', 'm_other'), // 别的模型
    event(45, 100_000, 'p1', 'm1'), // 窗口外（45 分钟前）
    event(5, null, 'p1', 'm1'), // 旧数据没有 wastedMs → 计 0
    event(5, -5, 'p1', 'm1'), // 负数 → 计 0
  ]
  ok(emptyWastedMs(events, { providerId: 'p1', model: 'm1' }) === 0,
    '站/模型/窗口/字段四个口径外的一律不计')
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
