/** 「为什么没选它」的解释链：结论 + 对比 + 换档提示是否正确 */
const { explainChoice, explainAll } = await import('../core/why-not.js')

let failed = 0
const ok = (c, m, x = '') => {
  if (c) console.log(`  ✓ ${m}`)
  else { failed += 1; console.error(`  ✗ ${m}${x ? '  ' + x : ''}`) }
}

const row = (o) => ({
  offer: { id: o.id }, providerName: o.providerName, priceUsd: o.price, effectiveUsd: o.price,
  quality: o.quality ?? 1, realTtftMs: o.ttft, realMsPerToken: o.msPerToken ?? null,
  availability: o.avail ?? 1, integrity: o.integrity ?? 1,
  admission: o.admission || { ok: true },
})

console.log('[1] 便宜但慢 vs 贵但快')
{
  const cheap = row({ id: 'a', providerName: '秋', price: 0.29, ttft: 8300, msPerToken: 1000 / 113 })
  const fast = row({ id: 'b', providerName: '北辰', price: 0.37, ttft: 6100, msPerToken: 1000 / 45 })

  const r1 = explainChoice(cheap, fast, 'value')
  ok(r1.reason.includes('性价比'), '性价比档的结论提到档位名')
  ok(r1.reason.includes('更低'), '结论说明冠军分数更低')
  ok(r1.flip.some((f) => f.mode === 'speed'), '提示「换首字速度会选它」')
  ok(!r1.flip.some((f) => f.mode === 'value'), '当前档位不出现在 flip 里（它已经输了）')

  const r2 = explainChoice(fast, cheap, 'speed')
  ok(r2.flip.some((f) => f.mode === 'value'), '反过来：速度档下会提示「换性价比选它」')
}

console.log('[2] 落选者没通过准入')
{
  const win = row({ id: 'a', providerName: '秋', price: 0.29, ttft: 8300 })
  // 可用率 0% → unstable
  const bad = row({ id: 'c', providerName: '绿萝', price: 0.1, ttft: 2000, avail: 0,
    admission: { ok: false, kind: 'unstable', text: '不稳定：可用率 0%（门槛 80%）' } })

  const r = explainChoice(win, bad, 'value')
  ok(r.blocked !== null, '结论里标出 blocked')
  ok(r.reason.includes('没通过准入') || r.reason.includes('没有通过准入'), '先说「没参与竞争」而不是比分数')
  ok(r.flip.length === 0, '没通过准入时不提「换档会选它」（换档也没用）')
  ok(r.compare.some((c) => c.label === '可用率'), '对比里给出可用率')
  // 关键：不能因为「它更便宜」就误导用户
  ok(!r.reason.includes('价格'), '结论不拿价格说事（那会误导）')
}

console.log('[3] 门槛类要并列出门槛值')
{
  const win = row({ id: 'a', providerName: '秋', price: 0.29, ttft: 3000 })
  const slow = row({ id: 'd', providerName: '慢站', price: 0.1, ttft: 15000,
    admission: { ok: false, kind: 'slow', text: '慢速：首字 15000ms 超过门槛 6000ms' } })
  const r = explainChoice(win, slow, 'value', { maxTtftMs: 6000 })
  const ttftRow = r.compare.find((c) => c.label === '首字')
  ok(Boolean(ttftRow), '对比里有首字')
  ok(String(ttftRow.lose).includes('门槛'), `首字行标出门槛（${ttftRow.lose}）`)
}

console.log('[4] explainAll：冠军自己不出现在列表里')
{
  const win = row({ id: 'a', providerName: '秋', price: 0.29, ttft: 8300 })
  const others = [
    win,
    row({ id: 'b', providerName: '北辰', price: 0.37, ttft: 6100 }),
    row({ id: 'c', providerName: '绿萝', price: 0.5, ttft: 2000 }),
  ]
  const r = explainAll(win, others, 'value')
  ok(r.winnerId === 'a', 'winnerId 正确')
  ok(r.items.length === 2, `除了冠军还剩 2 条（实际 ${r.items.length}）`)
  ok(!r.items.some((i) => i.offerId === 'a'), '冠军不在 items 里')
}

console.log('[5] 数据缺失时不瞎编')
{
  const win = row({ id: 'a', providerName: 'A', price: null, ttft: null })
  const lose = row({ id: 'b', providerName: 'B', price: null, ttft: null })
  const r = explainChoice(win, lose, 'value')
  ok(r.reason.includes('缺') || r.reason.includes('无法比较'), `缺数据时说清无法比较（${r.reason.slice(0, 30)}）`)
}

console.log('')
if (failed) { console.log(`${failed} 项失败`); process.exit(1) }
console.log('全部通过 ✓')
