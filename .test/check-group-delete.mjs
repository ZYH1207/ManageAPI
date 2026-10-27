/**
 * 删除分组自检：单元（core 台账）+ 端到端（假上游 + daemon）。
 *
 * 背景：分组不是独立实体，只是 offer.group / credential.group 上的名字，所以
 * 删除分组的后果必须按来源分开：
 *   1. 比价页「＋」复制出来的分组没有 Key 认领 → 连供给行一起删；
 *   2. Key 自带的分组 → Key 保留、只清分组归属，之后在 Key 上重新「选分组」
 *      能把模型和倍率一起加回来（apply-group 发现该 Key 名下没有供给行时，
 *      会按这把 Key 重新拉一次模型）。
 *
 * 这里同时钉死「未指定分组」不能删、以及删行要顺手清掉流量计数 / 手动排序。
 *
 * 用法：node .test/check-group-delete.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
function ok(cond, message) {
  if (cond) console.log(`  ✓ ${message}`)
  else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

// ---------------------------------------------------------------- 单元层
console.log('[1] deleteGroup 单元断言（core 台账）')
{
  const home = await mkdtemp(join(tmpdir(), 'mapi-groupdel-'))
  process.env.MANAGE_API_HOME = home
  const inv = await import(pathToFileURL(join(ROOT, 'core/inventory.js')).href)
  const store = await import(pathToFileURL(join(ROOT, 'core/store.js')).href)

  try {
    const provider = await inv.createProvider({ name: '分组删除站', baseUrl: 'http://127.0.0.1:5199/v1' })
    const cred = await inv.createCredential({
      providerId: provider.id,
      label: 'k1',
      secret: 'sk-1',
      group: 'Pro 池',
    })
    await inv.syncOffers(provider.id, cred.id, ['model-a', 'model-b'], 'Pro 池')
    let db = await store.readDb()

    // 「＋」复制出来的孤儿分组：没有 Key 属于它
    const sample = db.offers.find((o) => o.providerId === provider.id && o.upstreamName === 'model-a')
    const dup = await inv.duplicateOffer(sample.id, { group: '手动复制' })
    ok(dup.credentialId === null, '孤儿分组的供给行没有挂 Key')

    // 造点孤儿数据：流量计数与手动排序都按 offerId 记
    await store.mutate((d) => {
      d.traffic = { [dup.id]: { ok: 1, fail: 0, since: new Date().toISOString() } }
      d.manualOrder = { 'model-a': [dup.id, sample.id] }
    })

    console.log('  · 孤儿分组（没有 Key）')
    const orphan = await inv.deleteGroup(provider.id, '手动复制')
    db = await store.readDb()
    ok(orphan.removedOffers === 1, `删掉 1 条供给（得到 ${orphan.removedOffers}）`)
    ok(!db.offers.some((o) => o.group === '手动复制'), '孤儿分组的行已经不在台账里')
    ok(!db.traffic[dup.id], '流量计数跟着行一起清掉')
    ok(
      (db.manualOrder['model-a'] || []).join(',') === sample.id,
      '手动排序里的死 id 被摘掉，活的保留',
    )
    ok(
      db.offers.filter((o) => o.group === 'Pro 池').length === 2,
      '另一个分组不受影响（仍是 2 行）',
    )
    ok(db.credentials[0].group === 'Pro 池', 'Key 的分组没有被误删')

    console.log('  · Key 自带的分组（Key 要保留）')
    const owned = await inv.deleteGroup(provider.id, 'Pro 池')
    db = await store.readDb()
    ok(owned.removedOffers === 2, `删掉 2 条供给（得到 ${owned.removedOffers}）`)
    ok(owned.keys.join(',') === 'k1', '结果里点名是哪把 Key 被摘出分组')
    ok(db.offers.length === 0, '供给行删干净')
    ok(db.credentials.length === 1, 'Key 本身保留')
    const cleared = db.credentials[0]
    ok(cleared.group === '' && cleared.groupSource === undefined, 'Key 的分组与手选标记一起清掉')

    console.log('  · 边界')
    let threw = ''
    try {
      await inv.deleteGroup(provider.id, 'Pro 池')
    } catch (error) {
      threw = error.message
    }
    ok(/没有/.test(threw), `不存在的分组报错（${threw || '没报错'}）`)
    threw = ''
    try {
      await inv.deleteGroup(provider.id, '')
    } catch (error) {
      threw = error.message
    }
    ok(/未指定分组/.test(threw), `「未指定分组」不给删（${threw || '没报错'}）`)

    console.log('  · 重新导入：按 Key 重新落分组与倍率')
    await inv.updateCredential(cred.id, { group: 'Pro 池', groupSource: 'manual' })
    const saved = await inv.syncOffers(provider.id, cred.id, ['model-a', 'model-b'], 'Pro 池')
    db = await store.readDb()
    ok(saved.added === 2, `重新建回 2 行（得到 ${saved.added}）`)
    ok(
      db.offers.every((o) => o.group === 'Pro 池'),
      '重建的行落在原分组名下',
    )
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}
console.log('')

// ---------------------------------------------------------------- 端到端
console.log('[2] 端到端：删除 → Key 保留 → 重新导入自动补模型')
const HOME = await mkdtemp(join(tmpdir(), 'mapi-groupdel-e2e-'))
const APP_PORT = 4398
const UP_PORT = 5116

const plaza = {
  data: {
    groups: [
      {
        id: 1,
        name: 'Pro 池',
        rate_multiplier: 0.5,
        models: [
          { name: 'test-model-a', pricing: { input_price: 0.000002, output_price: 0.000008 } },
          { name: 'test-model-b', pricing: { input_price: 0.000001, output_price: 0.000004 } },
        ],
      },
      {
        id: 2,
        name: '特惠池',
        rate_multiplier: 0.15,
        models: [
          { name: 'test-model-a', pricing: { input_price: 0.000002, output_price: 0.000008 } },
        ],
      },
    ],
  },
}

const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/v1/models') {
    return send(200, { data: [{ id: 'test-model-a' }, { id: 'test-model-b' }] })
  }
  if (url.pathname === '/api/v1/model-plaza') return send(200, plaza)
  return send(404, { error: 'not found' })
})
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))

const app = spawn(process.execPath, ['daemon/index.js', '--port', String(APP_PORT)], {
  cwd: ROOT,
  env: { ...process.env, MANAGE_API_HOME: HOME },
  stdio: 'ignore',
})
const base = `http://127.0.0.1:${APP_PORT}`

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = new Error(`${method} ${path} → ${res.status} ${data.error || ''}`)
    error.status = res.status
    error.data = data
    throw error
  }
  return data
}

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) break
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150))
  }

  const up = `http://127.0.0.1:${UP_PORT}`
  const provider = (await call('POST', '/api/providers', { name: '分组删除站', baseUrl: `${up}/v1` }))
    .providers.find((p) => p.name === '分组删除站')
  const cred = (await call('POST', '/api/credentials', {
    providerId: provider.id,
    label: 'k1',
    secret: 'sk-test',
  })).credentials.find((c) => c.providerId === provider.id)
  await call('POST', `/api/providers/${provider.id}/sync`)

  const applied = await call('POST', `/api/providers/${provider.id}/apply-group`, {
    group: 'Pro 池',
    credentialId: cred.id,
  })
  const proRows = applied.offers.filter((o) => o.providerId === provider.id && o.group === 'Pro 池')
  ok(proRows.length === 2, `应用分组后 2 行落在「Pro 池」（得到 ${proRows.length}）`)
  ok(
    proRows.every((o) => o.ratio === 0.5),
    '倍率 0.5 已落到每一行上',
  )
  ok(
    proRows.find((o) => o.upstreamName === 'test-model-a')?.inPrice === 2,
    '输入价存的是原价（2 元/百万 token），不是在落价时先乘倍率',
  )

  // 比价页「＋」：造一个没有 Key 的孤儿分组
  const dup = await call('POST', `/api/offers/${proRows[0].id}/duplicate`, { group: '手动复制' })
  const dupRow = dup.offers.find((o) => o.providerId === provider.id && o.group === '手动复制')
  ok(Boolean(dupRow), '孤儿分组已建立')

  const afterOrphan = await call('POST', `/api/providers/${provider.id}/delete-group`, {
    group: '手动复制',
  })
  ok(afterOrphan.groupDeleteResult.removedOffers === 1, '孤儿分组连同 1 条行一起删掉')
  ok(
    !afterOrphan.offers.some((o) => o.providerId === provider.id && o.group === '手动复制'),
    'state 里不再有该分组',
  )
  ok(
    afterOrphan.credentials.find((c) => c.id === cred.id).group === 'Pro 池',
    '删孤儿分组不动 Key 的分组',
  )

  const afterOwned = await call('POST', `/api/providers/${provider.id}/delete-group`, {
    group: 'Pro 池',
  })
  ok(afterOwned.groupDeleteResult.removedOffers === 2, 'Key 分组下的 2 条行被删掉')
  ok(
    afterOwned.credentials.find((c) => c.id === cred.id).group === '',
    'Key 保留，分组归属清空',
  )
  ok(
    !afterOwned.offers.some((o) => o.providerId === provider.id),
    '该站已经没有供给行',
  )

  // 在 Key 那行重新「选分组」：后端应自动重新拉模型并落价
  const reimported = await call('POST', `/api/providers/${provider.id}/apply-group`, {
    group: 'Pro 池',
    credentialId: cred.id,
  })
  const r = reimported.groupResult
  ok(r.resynced === 2, `重新导入补回 2 个模型（得到 ${r.resynced}）`)
  ok(r.updated === 2, `2 行完成落价（得到 ${r.updated}）`)
  const backRows = reimported.offers.filter((o) => o.providerId === provider.id && o.group === 'Pro 池')
  ok(backRows.length === 2 && backRows.every((o) => o.ratio === 0.5), '分组与倍率一起回来了')

  // 「未指定分组」不能删
  let status = 0
  try {
    await call('POST', `/api/providers/${provider.id}/delete-group`, { group: '' })
  } catch (error) {
    status = error.status
  }
  ok(status === 400, `空分组名被拒绝（HTTP ${status}）`)

  console.log('')
  if (failed === 0) console.log('全部通过 ✓')
  else {
    console.error(`${failed} 项失败`)
    process.exitCode = 1
  }
} catch (error) {
  console.error('测试出错：', error.message || error)
  process.exitCode = 1
} finally {
  app.kill()
  upstream.close()
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}
