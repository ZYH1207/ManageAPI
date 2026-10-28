/**
 * 探测暂停时段（界面上的「定时关闭检测」）。
 *
 * 场景：晚上人睡了，没人看评分，探针还在一小时一轮地打真实请求，纯烧额度。
 * 允许每天配若干段「暂停探测」的窗口，到点自动停、到点自动恢复，白天照常跑。
 *
 * 口径（唯一实现：调度器、写接口、前端状态都从这里取，别各写一份 trim/比较）：
 *   - 时间只有 HH:MM，本地时间，精确到分钟
 *   - start 含、end 不含：23:00~08:00 = 23:00 起停、08:00 恢复
 *   - start > end 表示跨夜；start === end 既不是 0 也不是 24 小时，判非法
 *   - 多段可以重叠，重叠处按「暂停」合并，恢复时间取最后一段的结束点
 *   - 空列表 = 不暂停，定时探测全天运行
 */

/** 一段一天里最多几段：够覆盖「早/午/晚」这类作息，又不至于把界面撑爆 */
export const MAX_WINDOWS = 12

const MINUTES_PER_DAY = 24 * 60
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** 'HH:MM' → 分钟数；格式不对返回 null */
export function parseTime(text) {
  const m = TIME_RE.exec(String(text ?? '').trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 分钟数 → 'HH:MM'（1440 折回 00:00） */
export function formatTime(minutes) {
  const n = ((Math.round(Number(minutes) || 0) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
}

export function isTime(text) {
  return parseTime(text) !== null
}

/**
 * 归一化时段列表：丢掉格式不对 / 起止相同 / 完全重复的条目。
 * 读路径也走它——库里的老数据或手工改过的 db.json 不该让调度器崩。
 */
export function normalizeWindows(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const item of list) {
    const start = parseTime(item?.start)
    const end = parseTime(item?.end)
    if (start === null || end === null) continue
    if (start === end) continue
    const key = `${start}-${end}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: String(item?.id || key),
      start: formatTime(start),
      end: formatTime(end),
    })
    if (out.length >= MAX_WINDOWS) break
  }
  return out
}

/** 某段是否覆盖第 minute 分钟（0..1439）；start 含、end 不含，跨夜靠取反判断 */
export function coversMinute(window, minute) {
  const start = parseTime(window?.start)
  const end = parseTime(window?.end)
  if (start === null || end === null || start === end) return false
  const m = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  return start < end ? m >= start && m < end : m >= start || m < end
}

function pausedAt(windows, minute) {
  return windows.some((w) => coversMinute(w, minute))
}

/**
 * 当前状态。
 *
 * @param {Array} windows 原始时段列表（内部归一化）
 * @param {Date}  now
 * @returns {{paused:boolean, until:string|null, next:string|null, count:number}}
 *   paused 现在是否暂停；until 暂停中时几点恢复（全天覆盖则为 null）；
 *   next 未暂停时下一次几点开始暂停（没配时段则为 null）
 */
export function pauseStatus(windows, now = new Date()) {
  const list = normalizeWindows(windows)
  const minute = now.getHours() * 60 + now.getMinutes()
  if (list.length === 0) return { paused: false, until: null, next: null, count: 0 }

  // 逐分钟向前找「状态翻转点」。窗口只有分钟精度，扫 1440 次足够便宜，
  // 而且重叠、跨夜、全天覆盖这些情况不用各写一套分支
  const paused = pausedAt(list, minute)
  for (let i = 1; i <= MINUTES_PER_DAY; i += 1) {
    const m = (minute + i) % MINUTES_PER_DAY
    if (pausedAt(list, m) === paused) continue
    return {
      paused,
      until: paused ? formatTime(m) : null,
      next: paused ? null : formatTime(m),
      count: list.length,
    }
  }
  // 24 小时都被盖住：停着的永远不恢复，没停的永远不会停
  return { paused, until: null, next: null, count: list.length }
}
