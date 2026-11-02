/**
 * 「为什么没选它」——把候选之间的差异翻译成人话。
 *
 * ## 为什么需要（用户 2026-11-02）
 *
 * 这个项目的判定链有七步（亲和 → 余额 → 速度 → 评分 → 阶梯 → 迟滞 → 故障），
 * 每一步都能否决一个看起来更优的候选。用户反复问的都是同一句话：
 * **「明明它更快 / 更便宜，为什么不选它？」**
 *
 * 表格里已经有「依据」列，但那是**单个候选的自述**（「实测 首字 8.3s+生成 5.2s
 * × 余额 × 质量」）。人要看的是**对比**：为什么 A 赢了 B。
 *
 * 所以这个模块只做一件事：给定「冠军」和「某个落选者」，算出一条**可验证的
 * 因果链**——不是「A 分低所以选 A」，而是「如果换档位，结论会不会变」。
 *
 * ## 输出设计
 *
 * 返回三段：
 *   reason   —— 一句话结论（按当前档位，冠军凭什么赢）
 *   compare  —— 两边的关键数字并排（用户能自己核对）
 *   flip     —— **换哪个档位会选它**（这是最有信息量的部分：它把「不是它不行，
 *               是你现在要的不是它」这件事说清楚了）
 *   blocked  —— 如果它是被准入挡掉的，说清是哪道门、差多少
 *
 * ## 纯函数
 *
 * 不读库、不落盘。调用方把 row（路由行）传进来。
 */

import { DECISION_MODES, tierMetricOf, normalizeDecisionMode, speedOf, speedBasisOf } from './decision-mode.js'

/** 档位 key → 中文短语，用于「换成 X 档就会选它」这类句子 */
function modeLabel(key) {
  const hit = DECISION_MODES.find((m) => m.key === key)
  return hit ? hit.label : key
}

/** 数字 → 人话（毫秒、金额、百分比各有各的读法） */
function fmtMs(v) {
  if (!Number.isFinite(v)) return null
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`
}

function fmtMoney(v) {
  if (!Number.isFinite(v)) return null
  if (v >= 0.01) return `$${v.toFixed(4)}`
  return `$${v.toPrecision(3)}`
}

function fmtPct(v) {
  if (!Number.isFinite(v)) return null
  return `${Math.round(v * 100)}%`
}

/** 从 row 里取一个可比较的「速度」（真实优先，与排序口径一致） */
function speedOfRow(row) {
  const v = speedOf(row, 'prefer-real')
  return Number.isFinite(v) ? v : null
}

/**
 * 解释「为什么 win 赢了 lose」。
 *
 * @param {object} win   冠军行
 * @param {object} lose  落选行
 * @param {string} mode  当前决策侧重
 * @param {{maxTtftMs?: number, thresholds?: object}} options
 * @returns {{reason:string, compare:Array, flip:Array, blocked:string|null}}
 */
export function explainChoice(win, lose, mode, { maxTtftMs = 0 } = {}) {
  const modeKey = normalizeDecisionMode(mode)
  const compare = []

  // ── 1) 前提：落选者是不是压根没通过准入 ──────────────────────────
  //
  // 这种情况要**先说这个**：它压根没参与竞争，比分数毫无意义。
  // 用户最常见的困惑就是「它明明更便宜，为什么不选」——而真相是它掉包了。
  if (lose?.admission && lose.admission.ok === false) {
    const why = lose.admission.text || '没有通过准入'
    return {
      reason: `它没有通过准入，根本没参与竞争：${why}`,
      compare: admissionCompare(win, lose, { maxTtftMs }),
      flip: [],
      blocked: why,
    }
  }

  // ── 2) 两边在各档位下的名次（用来算「换档会不会选它」）──────────
  const mWin = tierMetricOf(win, modeKey)
  const mLose = tierMetricOf(lose, modeKey)

  compare.push({
    label: '价格',
    win: fmtMoney(win.priceUsd ?? win.price),
    lose: fmtMoney(lose.priceUsd ?? lose.price),
  })
  compare.push({
    label: '有效成本',
    win: fmtMoney(win.effectiveUsd ?? win.effective),
    lose: fmtMoney(lose.effectiveUsd ?? lose.effective),
  })
  const qw = Number.isFinite(win.quality) ? fmtPct(win.quality) : null
  const ql = Number.isFinite(lose.quality) ? fmtPct(lose.quality) : null
  if (qw || ql) compare.push({ label: '质量', win: qw, lose: ql })

  const sw = speedOfRow(win)
  const sl = speedOfRow(lose)
  if (sw !== null || sl !== null) {
    const basisW = speedBasisOf(win)
    const basisL = speedBasisOf(lose)
    compare.push({
      label: basisW === 'real' || basisL === 'real' ? '首字（真实优先）' : '首字（探针）',
      win: fmtMs(sw),
      lose: fmtMs(sl),
    })
  }
  const tpsW = Number.isFinite(win.realMsPerToken) ? Math.round(1000 / win.realMsPerToken) : null
  const tpsL = Number.isFinite(lose.realMsPerToken) ? Math.round(1000 / lose.realMsPerToken) : null
  if (tpsW !== null || tpsL !== null) {
    compare.push({
      label: '吐字速度',
      win: tpsW === null ? '无实测' : `${tpsW} tok/s`,
      lose: tpsL === null ? '无实测' : `${tpsL} tok/s`,
    })
  }

  // ── 3) 按当前档位说结论 ─────────────────────────────────────────
  let reason
  if (!Number.isFinite(mWin) || !Number.isFinite(mLose)) {
    reason = '有一边缺关键数据（价格或速度），按当前档位无法比较，所以它没有胜出。'
  } else {
    const lower = mLose < mWin
    const delta = mWin > 0 ? Math.abs((mLose - mWin) / mWin) : 0
    const pct = `${(delta * 100).toFixed(1)}%`
    if (lower) {
      // 理论上不该发生（调用方保证 win 是冠军），但算一下更稳妥
      reason = `按「${modeLabel(modeKey)}」档，它的分数反而更低（${mLose} vs ${mWin}），如果它是冠军说明别处有约束（亲和/迟滞/故障）在起作用。`
    } else {
      reason = `按「${modeLabel(modeKey)}」档，冠军的分数更低（${mWin} vs ${mLose}），好 ${pct}。`
    }
  }

  // ── 4) 换哪个档位会选它（最有信息量的一句）───────────────────────
  //
  // 遍历所有档位算两边分数，找出「它会赢」的那些。
  // 这一步把「不是它不行，是你现在要的不是它」讲清楚。
  const flip = []
  for (const m of DECISION_MODES) {
    if (m.key === modeKey) continue
    const a = tierMetricOf(win, m.key)
    const b = tierMetricOf(lose, m.key)
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    if (b < a) {
      flip.push({ mode: m.key, label: m.label, hint: m.hint })
    }
  }

  return { reason, compare, flip, blocked: null }
}

/**
 * 落选者是「没通过准入」时的对比：要把门槛和实际值并排，让人看出差多少。
 *
 * 只报和当前状态相关的那几项（慢速看首字、掉包看指纹...），
 * 不是把所有字段都倒出来——那反而看不出重点。
 */
function admissionCompare(win, lose, { maxTtftMs }) {
  const out = []
  const kind = lose.admission?.kind

  if (kind === 'slow') {
    const sw = speedOfRow(win)
    const sl = speedOfRow(lose)
    out.push({
      label: '首字',
      win: fmtMs(sw),
      lose: `${fmtMs(sl)}（门槛 ${fmtMs(maxTtftMs) || '未设'}）`,
    })
  }
  if (kind === 'unstable') {
    const aw = Number.isFinite(win.availability) ? fmtPct(win.availability) : '—'
    const al = Number.isFinite(lose.availability) ? fmtPct(lose.availability) : '—'
    out.push({ label: '可用率', win: aw, lose: `${al}（门槛 80%）` })
  }
  if (kind === 'suspect') {
    const fw = Number.isFinite(win.integrity) ? fmtPct(win.integrity) : '—'
    const fl = Number.isFinite(lose.integrity) ? fmtPct(lose.integrity) : '—'
    out.push({ label: '结果可信度', win: fw, lose: `${fl}（门槛 80%）` })
    if (Array.isArray(lose.integrityFaults) && lose.integrityFaults.length)
      out.push({ label: '具体问题', win: '—', lose: lose.integrityFaults.join('、') })
  }
  if (kind === 'cooling' || kind === 'billing') {
    out.push({ label: '状态', win: '正常', lose: lose.admission?.text || kind })
  }
  if (out.length === 0) {
    out.push({ label: '状态', win: '可用', lose: lose.admission?.text || '不可用' })
  }
  // 价格/质量始终给出，方便一起看
  out.push({
    label: '价格',
    win: fmtMoney(win.priceUsd ?? win.price),
    lose: fmtMoney(lose.priceUsd ?? lose.price),
  })
  return out
}

/**
 * 给一整组候选生成「为什么不是它们」的汇总（表格里每行一个入口时用）。
 *
 * @param {object} winner 冠军行（可能 null：全场没得选）
 * @param {Array} candidates 全部候选
 * @param {string} mode
 * @returns {{winnerId:string|null, items:Array}}
 */
export function explainAll(winner, candidates, mode, options = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  const items = []
  for (const c of list) {
    if (winner && c.offer?.id === winner.offer?.id) continue
    items.push({
      offerId: c.offer?.id || null,
      providerName: c.providerName || c.provider?.name || '',
      ...explainChoice(winner, c, mode, options),
    })
  }
  return { winnerId: winner?.offer?.id || null, items }
}