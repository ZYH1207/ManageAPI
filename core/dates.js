/**
 * 本地日期键（YYYY-MM-DD）——全后端唯一实现。
 *
 * 刻意不用 toISOString：签到、用量、「今天/本月」都按用户本地时区算。
 * 东八区早上 7 点用 UTC 会落到前一天，用户会发现「今天签过了」；
 * 月底 8 小时会把用量记错月份。
 *
 * 之前 usage.js / platforms/ledger.js / daemon/monitor-runner.js 各写一份，
 * 口径虽同但边界行为已经开始漂移（非法日期一个返回 ''、一个返回 NaN 串），
 * 统一收敛到这里。
 */

export function localDayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 本地月份月初的日期键（月度 Key 限额、本月汇总用）。 */
export function localMonthStart(date = new Date()) {
  return `${localDayKey(date).slice(0, 7)}-01`
}

/** 本周周一（本地时区）的日期键。 */
export function localWeekStart(date = new Date()) {
  const d = new Date(date)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return localDayKey(d)
}
