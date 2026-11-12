/**
 * 账单索引自检。
 *
 * 这一层是价格结论的地基，所以测两件最要命的事：
 *   A. 跨天合并**不能**把 paidPerMtok 当价格（那会被缓存率污染）
 *   B. 样本过薄的记录不能当价格用
 *
 * 用真数据 + 构造数据两条路都测：真数据证明现状，构造数据钉死规则。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const { buildLedgerIndex, ledgerForOffer, MIN_TOKENS } =
  await import(join(root, 'core', 'ledger-index.js'))

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ ' + label) } }

console.log('[A] 基础形状')
{
  const db = {
    ledger: {
      p1: {
        '2026-01-01': { rows: [
          { model: 'm1', group: 'g1', effIn: 0.1, effOut: 0.4, rate: 0.05, baseIn: 2, baseOut: 8,
            totalTokens: 50000, actualCost: 0.005, requests: 10 },
        ] },
      },
    },
  }
  const idx = buildLedgerIndex(db)
  const hit = idx.get('p1|g1|m1')
  ok(!!hit, '按 providerId|group|model 能查到')
  ok(hit.effIn === 0.1, 'effIn 原样保留')
  ok(hit.effOut === 0.4, 'effOut 原样保留')
  ok(hit.rate === 0.05, 'rate 原样保留')
  ok(hit.days === 1, 'days 计数正确')
}

console.log('\n[B] 关键规则：paidPerMtok 不参与价格')
{
  // 构造：同一条线，价格不变，但缓存命中率变化 → paidPerMtok 剧烈变化
  const db = {
    ledger: {
      p1: {
        '2026-01-01': { rows: [
          { model: 'm1', group: 'g1', effIn: 0.1, effOut: 0.4, rate: 0.05, baseIn: 2, baseOut: 8,
            totalTokens: 100000, actualCost: 0.05, requests: 5 },
        ] },
        '2026-01-02': { rows: [
          { model: 'm1', group: 'g1', effIn: 0.1, effOut: 0.4, rate: 0.05, baseIn: 2, baseOut: 8,
            totalTokens: 100000, actualCost: 0.0005, requests: 5 },   // 缓存全命中，花费低 100 倍
        ] },
      },
    },
  }
  const idx = buildLedgerIndex(db)
  const hit = idx.get('p1|g1|m1')
  ok(hit.effIn === 0.1, '两天 effIn 相同 → 合并后仍是 0.1（价格不受缓存影响）')
  ok(hit.paidPerMtok !== null, 'paidPerMtok 有值（供展示）')
  // paidPerMtok = 总花费 ÷ 总token = (0.05+0.0005)/200000×1e6
  const expected = Math.round(((0.05 + 0.0005) / 200000) * 1e6 * 1e6) / 1e6
  ok(Math.abs(hit.paidPerMtok - expected) < 1e-6, `paidPerMtok 按总花费÷总token 合并（${hit.paidPerMtok} = ${expected}）`)
  // 关键断言：effIn 不因 paidPerMtok 变化而变
  ok(hit.effIn === 0.1 && hit.effOut === 0.4, '价格字段与实付字段互相独立')
}

console.log('\n[C] 样本过薄标记')
{
  const db = {
    ledger: {
      p1: {
        '2026-01-01': { rows: [
          { model: 'm1', group: 'g1', effIn: 0.5, effOut: 2, rate: 0.1, baseIn: 5, baseOut: 20,
            totalTokens: 50, actualCost: 0.001, requests: 1 },
        ] },
      },
    },
  }
  const idx = buildLedgerIndex(db)
  const hit = idx.get('p1|g1|m1')
  ok(hit.thin === true, `低于 ${MIN_TOKENS} token 标记 thin`)
}

console.log('\n[D] 站方调价检测')
{
  const db = {
    ledger: {
      p1: {
        '2026-01-01': { rows: [ { model: 'm1', group: 'g1', effIn: 0.1, effOut: 0.4, rate: 0.05, baseIn: 2, baseOut: 8, totalTokens: 20000, actualCost: 1, requests: 1 } ] },
        '2026-01-02': { rows: [ { model: 'm1', group: 'g1', effIn: 0.2, effOut: 0.8, rate: 0.10, baseIn: 2, baseOut: 8, totalTokens: 20000, actualCost: 2, requests: 1 } ] },
      },
    },
  }
  const idx = buildLedgerIndex(db)
  const hit = idx.get('p1|g1|m1')
  ok(hit.priceChange === true, 'effIn 翻倍 → priceChange=true')
  ok(hit.effIn === 0.2, '取最后一天的价（0.2），不是平均值')
}

console.log('\n[D2] 生图模型不进价格索引')
{
  const db = {
    ledger: {
      p1: {
        '2026-01-01': { rows: [
          { model: 'gpt-image-2.6-exact', group: '生图', effIn: 1, effOut: 1, rate: 1,
            baseIn: 1, baseOut: 1, totalTokens: 100, actualCost: 0.05, requests: 1, billUnit: 'image' },
          { model: 'gpt-6.1-sol', group: 'g1', effIn: 0.1, effOut: 0.4, rate: 0.05,
            baseIn: 2, baseOut: 8, totalTokens: 50000, actualCost: 0.005, requests: 5, billUnit: 'token' },
        ] },
      },
    },
  }
  const idx = buildLedgerIndex(db)
  ok(!idx.has('p1|生图|gpt-image-2.6-exact'), 'billUnit=image 的行不进索引')
  ok(idx.has('p1|g1|gpt-6.1-sol'), 'billUnit=token 的行正常进索引')
}

console.log('\n[D3] 不跨分组借用数据（2026-11-12 修过的真实 bug）')
{
  // 构造：同站同模型两个分组，只有 A 有账单，B 没有
  const db = {
    ledger: {
      p1: {
        '2026-01-01': { rows: [
          { model: 'm1', group: 'A', effIn: 0.05, effOut: 0.2, rate: 0.02, baseIn: 2, baseOut: 8,
            totalTokens: 100000, actualCost: 0.01, requests: 5 },
        ] },
      },
    },
  }
  const idx = buildLedgerIndex(db)
  const offerB = { providerId: 'p1', group: 'B', upstreamName: 'm1' }
  const got = ledgerForOffer(idx, offerB)
  ok(got === null, 'B 分组没账单 → 返回 null（不借 A 的价）')
  const offerA = { providerId: 'p1', group: 'A', upstreamName: 'm1' }
  ok(ledgerForOffer(idx, offerA)?.effIn === 0.05, 'A 分组有账单 → 正常返回')
}

console.log('\n[E] 真实库冒烟')
{
  const p = join(homedir(), '.manage-api', 'db.json')
  if (existsSync(p)) {
    const db = JSON.parse(readFileSync(p, 'utf8'))
    const idx = buildLedgerIndex(db)
    ok(idx.size > 0, `真实库建出 ${idx.size} 条索引`)
    let withEff = 0
    for (const [, v] of idx) if (v.effIn !== null) withEff++
    ok(withEff > 0, `${withEff} 条有 effIn`)
    // ledgerForOffer 能按 offer 查到
    const anyOffer = (db.offers || []).find((o) => o.providerId && o.upstreamName)
    if (anyOffer) {
      const got = ledgerForOffer(idx, anyOffer)
      ok(got === null || typeof got === 'object', 'ledgerForOffer 对任意 offer 不抛异常')
    }
  } else {
    console.log('  (跳过：没有真实库)')
  }
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
