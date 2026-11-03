import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'mapi-balance-failure-'))
const checked = await realpath(home)
process.env.MANAGE_API_HOME = home
const inv = await import('../core/inventory.js')
const { createAppServer } = await import('../daemon/server.js')
let expired = true
const upstream = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/api/v1/user/profile') {
    res.statusCode = expired ? 401 : 200
    res.end(JSON.stringify(expired ? {code:'TOKEN_EXPIRED',message:'Token has expired'} : {data:{balance:1.02,currency:'USD'}}))
  } else { res.statusCode = 404; res.end('{}') }
})
const app = createAppServer()
try {
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  await new Promise(r => app.listen(0, '127.0.0.1', r))
  const provider = await inv.createProvider({name:'expired balance',kind:'sub2api',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`})
  await inv.updateProvider(provider.id, {adminToken:'expired-test-token',quotaRemaining:4.004})
  const base = `http://127.0.0.1:${app.address().port}`
  const read = async () => {
    const r = await fetch(`${base}/api/providers/${provider.id}/balance`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
    assert.equal(r.status,200)
    return r.json()
  }
  let state = await read()
  let saved = state.providers.find(p=>p.id===provider.id)
  const oldTime = saved.quotaUpdatedAt
  assert.equal(state.balance.ok,false)
  assert.match(saved.balanceSyncError,/401/)
  assert.equal(saved.quotaRemaining,4.004)
  assert.ok(saved.balanceCheckedAt)
  assert.equal(saved.tokenStatus,'invalid')
  console.log('PASS: expired token keeps old balance and records explicit failure')
  expired = false
  state = await read()
  saved = state.providers.find(p=>p.id===provider.id)
  assert.equal(state.balance.ok,true)
  assert.equal(saved.quotaRemaining,1.02)
  assert.equal(saved.balanceSyncError,null)
  assert.equal(saved.tokenStatus,'ok')
  assert.ok(saved.quotaUpdatedAt >= oldTime)
  const p = {quotaRemaining:4,quotaUpdatedAt:'old'}
  inv.applyBalanceResult(p,{ok:false,reason:'network timeout'},'new')
  assert.equal(p.quotaRemaining,4)
  assert.equal(p.quotaUpdatedAt,'old')
  assert.equal(p.balanceSyncError,'network timeout')
  console.log('PASS: successful retry replaces old balance and clears failure; network failure preserves last success')
} finally {
  app.closeAllConnections(); upstream.closeAllConnections()
  await Promise.all([new Promise(r=>app.close(r)),new Promise(r=>upstream.close(r))])
  if(await realpath(home)!==checked || !checked.startsWith(await realpath(tmpdir())+'/mapi-balance-failure-')) throw new Error('unexpected cleanup path')
  await rm(home,{recursive:true})
}
