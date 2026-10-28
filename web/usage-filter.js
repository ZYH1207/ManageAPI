/**
 * 详细用量的筛选逻辑（纯函数，不碰 DOM）。
 *
 * 为什么单独成文件：这段是「数字对不对」的地方——筛出来的条数、小计的 token、
 * 命中率、平均首字、速度，全是静默算错也不会报错的东西。放进 app.js 里就只能靠
 * 手点验证，单独拎出来才能被 .test/check-usage-detail.mjs 直接断言。
 *
 * 三个维度是「与」的关系：站点 + 分组 + 模型都满足才留下。
 */

/**
 * 一批明细里出现过的站点 / 分组 / 模型，各带条数（下拉框用）。
 *
 * 分组只在站点内唯一：不同站常有同名分组（「默认分组」到处都是），
 * 所以分组对象必须带 providerId，不能只按名字比对。
 */
export function facetsOf(rows = []) {
  const providers = new Map()
  const groups = new Map()
  const models = new Map()
  for (const row of rows) {
    if (row.providerId) {
      const provider = providers.get(row.providerId) || {
        id: row.providerId,
        name: row.providerName || row.providerId,
        count: 0,
      }
      provider.count += 1
      providers.set(row.providerId, provider)

      const groupKey = `${row.providerId}\u0001${row.group || ''}`
      const group = groups.get(groupKey) || {
        providerId: row.providerId,
        name: row.group || '',
        count: 0,
      }
      group.count += 1
      groups.set(groupKey, group)
    }
    const model = models.get(row.model) || { name: row.model, count: 0 }
    model.count += 1
    models.set(row.model, model)
  }
  const byName = (a, b) => a.name.localeCompare(b.name, 'zh')
  return {
    providers: [...providers.values()].sort(byName),
    groups: [...groups.values()].sort(byName),
    models: [...models.values()].sort(byName),
  }
}

/** filter = { providerId, group: { providerId, name } | null, model } */
export function matchRow(row, filter = {}) {
  if (filter.providerId && row.providerId !== filter.providerId) return false
  if (
    filter.group &&
    (row.providerId !== filter.group.providerId || (row.group || '') !== filter.group.name)
  ) {
    return false
  }
  if (filter.model && row.model !== filter.model) return false
  return true
}

/**
 * 筛出来的这些行的小计。
 *
 * 为什么不用汇总卡片的数：usage.json 只按 Key × 站点 × 模型聚合，没有分组维度，
 * 也没有「只算筛出来这几条」的说法。这里只对**明细窗口**里的行做加法，写清来源即可。
 *
 * 缺 usage 的行（上游没回）只计请求数，不贡献 token——把「不知道」当成 0 会让
 * 平均值和命中率一起偏。
 */
export function subtotalOf(rows = []) {
  const sum = {
    requests: 0,
    input: 0,
    cached: 0,
    cacheCreation: 0,
    output: 0,
    reasoning: 0,
    ttftSum: 0,
    ttftCount: 0,
    genSum: 0,
    genOutput: 0,
    missingUsage: 0,
  }
  for (const row of rows) {
    sum.requests += 1
    if (row.input === null || row.input === undefined) {
      sum.missingUsage += 1
    } else {
      sum.input += row.input
      sum.cached += row.cached || 0
      sum.cacheCreation += row.cacheCreation || 0
      sum.output += row.output || 0
      sum.reasoning += row.reasoning || 0
    }
    if (row.ttftMs) {
      sum.ttftSum += row.ttftMs
      sum.ttftCount += 1
    }
    // 速度只用「有生成窗口且有输出」的行，和非流式请求（没有首字）分开算
    if (row.genMs && row.output) {
      sum.genSum += row.genMs
      sum.genOutput += row.output
    }
  }
  const billed = sum.input + sum.cached + sum.cacheCreation
  return {
    ...sum,
    cacheHitRate: billed > 0 ? sum.cached / billed : null,
    avgTtftMs: sum.ttftCount ? Math.round(sum.ttftSum / sum.ttftCount) : null,
    avgTps: sum.genSum > 0 ? Math.round((sum.genOutput / (sum.genSum / 1000)) * 10) / 10 : null,
  }
}
