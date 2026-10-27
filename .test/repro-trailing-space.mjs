/**
 * 端到端复现：站点返回带尾随空格的分组名时，
 * 「同步模型 → 识别分组 → 再同步」是否会产生重复行。
 *
 * 用法：
 *   node .test/mock-trailing-space.mjs &        # 先起 mock 站（5150）
 *   node .test/repro-trailing-space.mjs         # 再跑这个
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'mapi-repro-'))
process.env.MANAGE_API_HOME = home

const BASE = process.env.BASE || 'http://127.0.0.1:5150'
const up = `${BASE}/v1`

const api = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${process.env.DAEMON_PORT || 4499}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${path}: ${data.error || res.status}`)
  return data
}

const rowsOf = (state, providerId) =>
  state.offers.filter((o) => o.providerId === providerId)

console.log('=== 复现：带尾随空格的分组名 ===\n')

// 1) 建站
let state = await api('POST', '/api/providers', { name: '空格分组站', baseUrl: up })
const provider = state.providers.find((p) => p.name === '空格分组站')
await api('POST', '/api/credentials', { providerId: provider.id, label: 'K1', secret: 'sk-test-trailing-0001' })
// detect-groups 要读站点后台的令牌列表，必须给 adminToken
await api('PATCH', `/api/providers/${provider.id}`, { adminToken: 'admin-token-for-test' })

// 2) 同步模型（此时分组为空）
state = await api('POST', `/api/providers/${provider.id}/sync`, {})
console.log('同步 1 次后：', rowsOf(state, provider.id).length, '行')
const groupAfterFirst = [...new Set(rowsOf(state, provider.id).map((o) => JSON.stringify(o.group)))]
console.log('  分组值：', groupAfterFirst.join(', '))

// 3) 识别分组（把带空格的分组名写进 offer）
state = await api('POST', `/api/providers/${provider.id}/detect-groups`, {})
console.log('\n识别分组后：', rowsOf(state, provider.id).length, '行')
console.log('  分组值：', [...new Set(rowsOf(state, provider.id).map((o) => JSON.stringify(o.group)))].join(', '))

// 4) 再同步一轮 —— 这里是关键：修复前会多插一整套
const before = rowsOf(state, provider.id).length
state = await api('POST', `/api/providers/${provider.id}/sync`, {})
const after1 = rowsOf(state, provider.id).length
console.log('\n再同步 1 轮：', before, '→', after1, '行', after1 > before ? '❌ 多插了' : '✓ 没变')

// 5) 再来一轮（模拟每轮同步 + 识别分组）
for (let i = 2; i <= 4; i += 1) {
  state = await api('POST', `/api/providers/${provider.id}/detect-groups`, {})
  state = await api('POST', `/api/providers/${provider.id}/sync`, {})
  console.log(`第 ${i} 轮（识别+同步）：${rowsOf(state, provider.id).length} 行`)
}

// 6) 最终统计
const finalRows = rowsOf(state, provider.id)
const norm = (v) => String(v ?? '').trim().replace(/\s+/g, ' ')
const seen = new Map()
let dups = 0
for (const o of finalRows) {
  const k = norm(o.group) + '|' + o.upstreamName
  if (seen.has(k)) dups += 1
  else seen.set(k, o)
}

console.log('\n=== 结果 ===')
console.log('总行数：', finalRows.length, '（模型数 3）')
console.log('归一化后重复行：', dups)
console.log('分组值是否带空格：', finalRows.some((o) => o.group !== norm(o.group)) ? '是 ❌' : '否 ✓')
if (finalRows.length === 3 && dups === 0) {
  console.log('\n✓ 通过：反复「识别分组 + 同步」没有产生重复行')
} else {
  console.log('\n❌ 失败：产生了重复行，说明分组名没有归一化')
  console.log('   明细：')
  for (const o of finalRows) console.log('     ', JSON.stringify(o.group), o.upstreamName)
}

await rm(home, { recursive: true, force: true })
