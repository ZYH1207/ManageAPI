/**
 * 用量并入网关 + 清空统计 自检。
 *
 *   [1] core/usage.js 的 resetUsage：记账 → 汇总有数 → 清空 → 汇总归零、
 *       usage.json 落盘为空（「清空统计」按钮的整个后端语义就是它）。
 *   [2] 前端源码守卫：用量不再单独占导航项（index.html 无 usage 按钮 / 视图），
 *       统计块渲染进网关页的 #usage-pane，且「清空统计」确实打 POST /api/usage/reset。
 *
 * 用法：node .test/check-usage-reset.mjs
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = await mkdtemp(join(tmpdir(), 'mapi-usage-reset-'))
process.env.MANAGE_API_HOME = HOME
const { recordUsage, usageSummary, resetUsage } = await import('../core/usage.js')

let failed = 0
const ok = (cond, msg, extra = '') => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}${extra ? `  ${extra}` : ''}`)
  }
}

console.log('[1] resetUsage：清空后汇总归零、落盘为空')
{
  await recordUsage({ keyId: 'k1', providerId: 'p1', model: 'gpt-x', inputTokens: 100, outputTokens: 10 })
  await recordUsage({ keyId: 'k2', providerId: 'p2', model: 'gpt-y', inputTokens: 50, outputTokens: 5, ok: false })
  let s = await usageSummary({ days: 7 })
  ok(s.totals.requests === 2, `清空前请求数 2（实际 ${s.totals.requests}）`)
  ok(s.totals.input === 150 && s.totals.output === 15, `清空前 token 汇总正确（${s.totals.input}/${s.totals.output}）`)

  await resetUsage()
  s = await usageSummary({ days: 7 })
  ok(s.totals.requests === 0 && s.totals.input === 0, '清空后汇总归零')
  ok(Object.keys(s.byKey).length === 0 && Object.keys(s.byModel).length === 0, '清空后各切面为空')

  const raw = JSON.parse(await readFile(join(HOME, 'usage.json'), 'utf8'))
  ok(Object.keys(raw.days || {}).length === 0, 'usage.json 已落盘为空（重启后也不会回来）')
}

console.log('[1b] 自定义区间 from/to：两端都含、写反自动调正')
{
  // 重开一份干净数据，按「今天 / 昨天 / 30 天前」各记一笔
  await resetUsage()
  const { localDayKey } = await import('../core/usage.js')
  const day = (offset) => localDayKey(new Date(Date.now() - offset * 86400000))
  for (const offset of [0, 1, 40]) {
    await recordUsage({
      keyId: 'k1',
      providerId: 'p1',
      model: `m${offset}`,
      inputTokens: 10,
      outputTokens: 1,
      ts: `${day(offset)}T03:00:00.000Z`,
    })
  }

  const all = await usageSummary({ days: 60 })
  ok(all.totals.requests === 3, `60 天能看到 3 笔（实际 ${all.totals.requests}）`)

  const one = await usageSummary({ from: day(0), to: day(0) })
  ok(one.totals.requests === 1, `只查今天 → 1 笔（实际 ${one.totals.requests}）`)
  ok(one.days.length === 1 && one.days[0] === day(0), `区间只有今天这一天（实际 ${one.days.join(',')}）`)

  const two = await usageSummary({ from: day(1), to: day(0) })
  ok(two.totals.requests === 2, `昨天到今天 → 2 笔（实际 ${two.totals.requests}）`)
  ok(two.days.length === 2, `按天切面 2 个桶（实际 ${two.days.length}）`)

  // 写反了：和上面同一个区间，结果必须一模一样
  const flipped = await usageSummary({ from: day(0), to: day(1) })
  ok(flipped.totals.requests === two.totals.requests, '起止写反自动调正，结果不变')
  ok(flipped.days[0] === two.days[0] && flipped.days[1] === two.days[1], '写反后日期顺序也是从旧到新')

  // 自定义区间优先于 days（服务端约定：from/to 都在就忽略 days）
  const mixed = await usageSummary({ days: 1, from: day(1), to: day(0) })
  ok(mixed.totals.requests === 2, `from/to 优先于 days（实际 ${mixed.totals.requests}）`)

  const future = await usageSummary({ from: day(-3), to: day(-1) })
  ok(future.totals.requests === 0, '未来区间是空的，不报错')
}

console.log('[1c] 清空水位线：汇总是 0 时，明细也必须认同一个水位')
{
  const { detailRows } = await import('../core/usage-detail.js')
  const { usageClearedAt } = await import('../core/usage.js')
  const now = Date.now()
  const mk = (id, ms, tokens) => ({
    id,
    ts: new Date(ms).toISOString(),
    model: 'm',
    chosenProviderId: 'p1',
    chosenProviderName: '秋',
    outcome: 'ok',
    stream: true,
    latencyMs: 1000,
    ttftMs: 300,
    usage: { prompt_tokens: tokens, completion_tokens: 10, total_tokens: tokens + 10 },
  })
  // 清空前 3 条、清空后 2 条
  const before = [mk('a', now - 3 * 3600_000, 1000), mk('b', now - 2 * 3600_000, 2000)]
  const after = [mk('c', now - 60_000, 300), mk('d', now - 30_000, 400)]
  const all = [...before, ...after]

  // 没清空：4 条都在
  const plain = detailRows(all, { days: 1, now })
  ok(plain.available === 4 && plain.clearedDropped === 0, `未清空明细 4 条（实际 ${plain.available}）`)

  // 清空水位线卡在中间：只剩清空后的 2 条，且记下被挡掉的条数
  const cutMs = now - 3600_000
  const cut = detailRows(all, { days: 1, now, sinceMs: cutMs })
  ok(cut.available === 2, `清空后只剩 2 条（实际 ${cut.available}）`)
  ok(cut.rows.every((r) => r.tsMs >= cutMs), '清空前的那几条一条不剩')
  ok(cut.clearedDropped === 2, `被水位线挡掉 2 条（实际 ${cut.clearedDropped}）`)

  // 水位线早于区间起点时不起作用（别把本来该显示的挡掉）
  const early = detailRows(all, { days: 1, now, sinceMs: now - 30 * 86400_000 })
  ok(early.available === 4, `水位线早于区间起点时不影响（实际 ${early.available}）`)

  // resetUsage 真的落了 clearedAt，并且能读回来
  await resetUsage()
  const cleared = await usageClearedAt()
  ok(typeof cleared === 'string' && Math.abs(Date.parse(cleared) - Date.now()) < 60_000, `清空记下了时间（${cleared}）`)
  const s2 = await usageSummary({ days: 7 })
  ok(s2.clearedAt === cleared, '汇总接口也带 clearedAt，前端才有得显示')
  ok(s2.totals.requests === 0, '清空后汇总仍是 0')
}

console.log('[2] 前端源码守卫：入口是网关卡上的按钮，视图仍是独立面板，清空接对接口')
{
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
  const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')

  ok(!html.includes('data-tab="usage"'), '侧边栏没有「用量」导航项了')
  ok(html.includes('view-usage'), 'index.html 保留独立用量视图（面板没被拆掉）')
  ok(/'gateway', 'usage', 'benchmark'/.test(app), 'TABS 里有 usage（能被 setTab 切换）')
  ok(/usage: \{ title: '用量'/.test(app), 'TAB_META 里有用量页标题副标题')
  ok(!app.includes('usage-pane'), '没有把用量塞进网关页（不再有 #usage-pane）')
  ok(app.includes('data-goto="usage"'), '网关入口卡有「用量统计」按钮（data-goto=usage 打开面板）')
  ok(app.includes("$('#view-usage')"), 'renderUsage 渲染进 #view-usage')
  ok(app.includes('data-act="usage-clear"'), '用量面板有「清空统计」按钮')
  ok(app.includes("api('POST', '/api/usage/reset', {})"), '清空按钮打 POST /api/usage/reset（带空 body，否则服务端按非 JSON 拒掉）')
  ok(app.includes("confirm(t('清空全部用量统计？此操作不可恢复。'))"), '清空前有确认弹窗')

  // 区间选项：1 / 7 / 30 天 + 自定义（90 天已去掉）
  ok(/const USAGE_PRESETS = \[1, 7, 30\]/.test(app), '预设区间是 1 / 7 / 30 天')
  ok(!/\[7, 30, 90\]/.test(app), '没有 90 天选项了')
  ok(app.includes('data-act="usage-custom-toggle"'), '有「自定义」按钮')
  ok(app.includes('data-usage-custom="from"') && app.includes('data-usage-custom="to"'), '自定义有起止两个日期输入')
  ok(app.includes('data-act="usage-custom-apply"'), '自定义有「查询」按钮')
  ok(app.includes('function usageRangeQuery()'), '区间参数统一由 usageRangeQuery() 生成')
  ok(app.includes('if (usageRange === 30 && !usageCustom) usageData = null'), '轮询清快照的条件带上了自定义区间')

  // 清空之后界面必须说明「从什么时候开始算」，否则用户会以为统计坏了
  ok(app.includes('usage.clearedAt'), '用量面板读了 clearedAt')
  ok(app.includes('win.clearedAt'), '详细用量弹窗读了 clearedAt')

  const server = await readFile(new URL('../daemon/server.js', import.meta.url), 'utf8')
  // 水位线现在在明细接口里逐行判（账本 + 日志两条路共用同一段过滤）
  ok(server.includes('if (floorMs !== null && row.tsMs < floorMs)'), '明细接口按清空水位线过滤')
  ok(server.includes('const floorMs = Number.isFinite(clearedMs) ? clearedMs : null'), '水位线取自 usage.json 的 clearedAt')
  ok(server.includes('sumBuckets(summary.buckets, filter)'), '小计从全量聚合算（不从明细行加）')
  ok(server.includes('facetOptions(summary.buckets, filter)'), '筛选下拉也从全量聚合算')
  ok(server.includes('appendDetail(batch)'), '决策日志落盘时顺带写逐条账本')
  ok(server.includes('clearedAt: summary.clearedAt || null'), '明细接口把 clearedAt 传给前端')
}

await rm(HOME, { recursive: true, force: true }).catch(() => {})
console.log('')
if (failed) {
  console.error(`${failed} 项不通过`)
  process.exit(1)
}
console.log('全部通过')
