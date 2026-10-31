#!/usr/bin/env node
/**
 * 缓存亲和自检。
 *
 * 覆盖三块：
 *   1. core/affinity.js 的纯逻辑（钉住 / 过期 / 复用率 / 各档位）
 *   2. 对话指纹的稳定性（同一对话多轮不变，不同对话不同）
 *   3. core/auto-route.js 的接缝（recordAffinity / readConversation / 上限淘汰）
 */

import assert from 'node:assert/strict'
import {
  shouldHold, applyAffinity, conversationFingerprint, recordFrom,
  listAffinityModes, AFFINITY, FRESH_MS, MIN_CACHE_REUSE,
} from '../core/affinity.js'
import { recordAffinity, readConversation, normalizeAutoRoute, AFFINITY_MAX_CONVERSATIONS } from '../core/auto-route.js'

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); fail++ }
}

const fresh = (over = {}) => ({
  offerId: 'o1', modelKey: 'm1', at: Date.now() - 60_000,
  cacheRead: 9000, inputTokens: 1000, ...over,
})

console.log('\n[1/3] 亲和纯逻辑')

check('同一 turn 内必钉住', () => {
  const r = shouldHold({ mode: AFFINITY.AUTO, record: fresh(), withinTurn: true })
  assert.equal(r.hold, true)
  assert.equal(r.reason, 'turn')
})

check('跨 turn 但缓存新鲜 → 钉住', () => {
  const r = shouldHold({ mode: AFFINITY.AUTO, record: fresh(), withinTurn: false })
  assert.equal(r.hold, true)
  assert.equal(r.reason, 'cache')
})

check('缓存过期 → 放开（改用更优供给）', () => {
  const old = fresh({ at: Date.now() - FRESH_MS[AFFINITY.AUTO] - 1000 })
  const r = shouldHold({ mode: AFFINITY.AUTO, record: old, withinTurn: false })
  assert.equal(r.hold, false)
  assert.equal(r.reason, 'stale')
})

check('缓存复用率过低 → 放开（钉住也省不到）', () => {
  const low = fresh({ cacheRead: 100, inputTokens: 90_000 })
  const r = shouldHold({ mode: AFFINITY.AUTO, record: low, withinTurn: false })
  assert.equal(r.hold, false)
  assert.equal(r.reason, 'low-reuse')
  assert.ok(MIN_CACHE_REUSE > 0)
})

check('off 档：同一 turn 也不钉', () => {
  const r = shouldHold({ mode: AFFINITY.OFF, record: fresh(), withinTurn: true })
  assert.equal(r.hold, false)
})

check('session 档：跨 turn 也钉（不看 TTL）', () => {
  const old = fresh({ at: Date.now() - 30 * 86400_000 })
  const r = shouldHold({ mode: AFFINITY.SESSION, record: old, withinTurn: false })
  assert.equal(r.hold, true)
  assert.equal(r.reason, 'session')
})

check('turn 档：跨 turn 就放开', () => {
  const r = shouldHold({ mode: AFFINITY.TURN, record: fresh(), withinTurn: false })
  assert.equal(r.hold, false)
  assert.equal(r.reason, 'new-turn')
})

check('strict 档：过期也钉住（超额交给上游报错）', () => {
  const old = fresh({ at: Date.now() - 365 * 86400_000, cacheRead: 0, inputTokens: 99_999 })
  const r = shouldHold({ mode: AFFINITY.STRICT, record: old, withinTurn: false })
  assert.equal(r.hold, true)
  assert.equal(r.reason, 'strict')
})

check('没有记录 → 不钉（首次）', () => {
  const r = shouldHold({ mode: AFFINITY.AUTO, record: null, withinTurn: false })
  assert.equal(r.hold, false)
  assert.equal(r.reason, 'first')
})

check('applyAffinity：要钉时把选择改回上次那个', () => {
  const pick = { offerId: 'best', modelKey: 'm2', metric: 1 }
  const out = applyAffinity({
    pick, record: fresh(), mode: AFFINITY.AUTO, withinTurn: true,
  })
  assert.equal(out.held, true)
  assert.equal(out.pick.offerId, 'o1', '应改回上次那个供给')
  assert.equal(out.pick.bestOfferId, 'best', '应保留真实最优，便于解释')
  assert.equal(out.pick.switched, false)
})

check('applyAffinity：最优本来就是它 → 不改', () => {
  const pick = { offerId: 'o1', modelKey: 'm1', metric: 1 }
  const out = applyAffinity({ pick, record: fresh(), mode: AFFINITY.AUTO, withinTurn: true })
  assert.equal(out.held, true)
  assert.equal(out.pick.offerId, 'o1')
  assert.equal(out.affinity.reason, 'kept-best')
})

check('applyAffinity：不钉 → 原样返回', () => {
  const pick = { offerId: 'best', modelKey: 'm2', metric: 1 }
  const out = applyAffinity({ pick, record: fresh(), mode: AFFINITY.OFF, withinTurn: false })
  assert.equal(out.held, false)
  assert.equal(out.pick.offerId, 'best')
})

check('listAffinityModes 列出全部档位', () => {
  const modes = listAffinityModes()
  assert.equal(modes.length, Object.keys(AFFINITY).length)
  for (const m of modes) assert.ok(m.label, `${m.id} 缺 label`)
})

console.log('\n[2/3] 对话指纹')

check('同一对话多轮 → 指纹不变', () => {
  const a = conversationFingerprint({ keyId: 'k1', messages: [{ role: 'user', content: '修个 bug' }] })
  const b = conversationFingerprint({ keyId: 'k1', messages: [
    { role: 'user', content: '修个 bug' },
    { role: 'assistant', content: '好' },
    { role: 'user', content: '继续' },
  ] })
  assert.equal(a, b, '首条 user 消息决定指纹，多轮不变')
})

check('不同对话 → 指纹不同', () => {
  const a = conversationFingerprint({ keyId: 'k1', messages: [{ role: 'user', content: '修个 bug' }] })
  const b = conversationFingerprint({ keyId: 'k1', messages: [{ role: 'user', content: '写个测试' }] })
  assert.notEqual(a, b)
})

check('不同 Key 同一句话 → 指纹不同（不同客户端不串台）', () => {
  const a = conversationFingerprint({ keyId: 'k1', messages: [{ role: 'user', content: 'hi' }] })
  const b = conversationFingerprint({ keyId: 'k2', messages: [{ role: 'user', content: 'hi' }] })
  assert.notEqual(a, b)
})

check('拿不到内容 → null', () => {
  assert.equal(conversationFingerprint({ keyId: 'k', messages: [] }), null)
  assert.equal(conversationFingerprint({ keyId: 'k', messages: [{ role: 'user', content: '  ' }] }), null)
})

check('多段内容只取文本部分', () => {
  const a = conversationFingerprint({ keyId: 'k', messages: [{
    role: 'user',
    content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'http://x/1.png' } }],
  }] })
  const b = conversationFingerprint({ keyId: 'k', messages: [{
    role: 'user',
    content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'http://x/2.png' } }],
  }] })
  assert.equal(a, b, '图片 URL 每轮变，不该影响指纹')
})

console.log('\n[3/3] 与 auto-route 的接缝')

check('normalizeAutoRoute 保留 affinity 与 conversations', () => {
  const n = normalizeAutoRoute({ affinity: 'session', conversations: { fp: { offerId: 'o' } } })
  assert.equal(n.affinity, 'session')
  assert.equal(n.conversations.fp.offerId, 'o')
})

check('缺字段时给安全默认值', () => {
  const n = normalizeAutoRoute(null)
  assert.equal(n.affinity, '')
  assert.deepEqual(n.conversations, {})
})

check('recordAffinity 写入并读回', () => {
  const settings = {}
  const rec = recordFrom({ pick: { offerId: 'o9', modelKey: 'm9' }, usage: { cachedTokens: 500, inputTokens: 100 } })
  recordAffinity(settings, 'fp1', rec)
  const back = readConversation(settings, 'fp1')
  assert.equal(back.offerId, 'o9')
  assert.equal(back.cacheRead, 500)
})

check('recordAffinity 超上限时按最旧淘汰', () => {
  const settings = {}
  const base = Date.now() - 1_000_000
  for (let i = 0; i <= AFFINITY_MAX_CONVERSATIONS; i++) {
    recordAffinity(settings, `fp${i}`, { offerId: `o${i}`, at: base + i * 1000 })
  }
  const table = normalizeAutoRoute(settings.autoRoute).conversations
  assert.equal(Object.keys(table).length, AFFINITY_MAX_CONVERSATIONS, '应被裁到上限')
  assert.equal(table.fp0, undefined, '最旧的应被淘汰')
  assert.ok(table[`fp${AFFINITY_MAX_CONVERSATIONS}`], '最新的应保留')
})

check('recordFrom 拿不到 offerId → null', () => {
  assert.equal(recordFrom({ pick: {}, usage: {} }), null)
})

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
