/**
 * 首字延迟（TTFT）门槛：档位化 + 速度等级。
 *
 * 为什么档位化：自由填数字会让人卡在「7999 和 8001 差 2 毫秒要不要紧」这种噪声上，
 * 也会让一条供给因为几十毫秒的抖动在边界上反复进出路由池——今天能派活、明天不能，
 * 用户只会觉得判定在抽风。落到 1000ms 一档之后，同一份延迟永远得到同一个结论，
 * 并且能说人话（「8 秒 · 偏慢」比 «8032ms» 好懂）。
 *
 * 口径（**唯一实现**，前端从 /api/state 的 ttftTiers 取这份表渲染，别在前端再抄一份）：
 *   - 档位：1000 ~ 20000ms，步长 1000，共 20 档
 *   - 取档：就近，500 为界。8600 → 9000，8499 → 8000，正好 8500 → 9000（半档向上）
 *   - 0 / 空 / 非正数 = 不限（不是「0 毫秒」，那是谁都过不了）
 *   - 超过 20000 = 按 20000 算。档位表到 2 万为止：再往上填就等于「不限」，
 *     而「不限」和「慢到不能用」是相反的结论，不能被同一个输入混着表达
 *
 * 速度等级只是**给人看的标签**，任何判定都用毫秒数直接比，别拿等级名当条件。
 */

export const TTFT_TIER_MIN = 1000
export const TTFT_TIER_MAX = 20000
export const TTFT_TIER_STEP = 1000
/** 半档：跨过它就是上一档 */
export const TTFT_SNAP_BOUNDARY = 500

/** 20 个档位：1000, 2000, …, 20000 */
export const TTFT_TIERS = (() => {
  const list = []
  for (let ms = TTFT_TIER_MIN; ms <= TTFT_TIER_MAX; ms += TTFT_TIER_STEP) list.push(ms)
  return list
})()

/**
 * 速度等级：按档位区间命名，上界含（<= max 即落在这级）。
 * cls 对应界面徽章配色（ok / info / warn / danger）。
 */
export const SPEED_LEVELS = [
  { key: '极快', cls: 'ok', max: 2000 },
  { key: '快', cls: 'ok', max: 4000 },
  { key: '正常', cls: 'info', max: 7000 },
  { key: '偏慢', cls: 'warn', max: 12000 },
  { key: '慢', cls: 'danger', max: TTFT_TIER_MAX },
]

/** 毫秒 → 速度等级；不限（0/空）返回 null */
export function speedLevelOf(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return null
  return SPEED_LEVELS.find((level) => value <= level.max) || SPEED_LEVELS[SPEED_LEVELS.length - 1]
}

/**
 * 任意毫秒数 → 档位毫秒数。0 表示不限。
 *
 * 非数字也归为 0，但**接口层必须先拦非法输入**（见 server.js 的 PATCH 校验），
 * 否则用户打错字会变成「悄悄关了限制」这种最危险的静默错误。
 */
export function snapTtftMs(value) {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  const tier = Math.round(raw / TTFT_TIER_STEP) * TTFT_TIER_STEP
  return Math.min(Math.max(tier, TTFT_TIER_MIN), TTFT_TIER_MAX)
}

/** 秒数文本：8000 → "8.0s" */
export function ttftSeconds(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return null
  return `${(value / 1000).toFixed(1)}s`
}

/** 给界面渲染的整张表（档位 + 等级 + 秒数） */
export function ttftTierTable() {
  return TTFT_TIERS.map((ms, index) => {
    const level = speedLevelOf(ms)
    return {
      ms,
      tier: index + 1,
      seconds: ms / 1000,
      level: level.key,
      levelCls: level.cls,
    }
  })
}

/** 一句话描述当前门槛：8000 → "第 8 档 · 8.0s · 偏慢"；0 → "不限" */
export function describeTtftLimit(ms) {
  const snapped = snapTtftMs(ms)
  if (!snapped) return '不限'
  const level = speedLevelOf(snapped)
  const tier = TTFT_TIERS.indexOf(snapped) + 1
  return `第 ${tier} 档 · ${ttftSeconds(snapped)} · ${level.key}`
}
