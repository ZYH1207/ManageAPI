import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'mapi-session-import-'))
const checked = await realpath(home)
process.env.MANAGE_API_HOME = home
const inv = await import('../core/inventory.js')
const store = await import('../core/store.js')
const providers = await import('../core/providers.js')
const { parseProviderSession } = await import('../core/provider-session.js')
let refreshDenied = false
let profileInvalid = false
let loginCalls = 0
let refreshCalls = 0
let delayed = null
let delayStarted = null
const server = createServer(async (req, res) => {
  const send = (status, data) => { res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(data)) }
  if (req.url === '/api/v1/auth/login') { loginCalls++; return send(400,{error:'human check required'}) }
  if (req.url === '/api/v1/auth/refresh') {
    refreshCalls++
    let text = ''; for await (const chunk of req) text += chunk
    assert.match(JSON.parse(text).refresh_token,/^refresh-/)
    return refreshDenied ? send(401,{message:'refresh expired'}) : send(200,{code:0,data:{access_token:'access-renewed',refresh_token:'refresh-rotated',expires_in:3600}})
  }
  if (req.url === '/api/v1/user/profile') {
    const token = String(req.headers.authorization || '').replace(/^Bearer /,'')
    if (token === 'race-token' && delayed) { delayStarted(); await delayed }
    if (!['access-imported','access-renewed','access-only','race-token'].includes(token)) return send(401,{message:'unauthorized'})
    return send(200,{code:0,data:profileInvalid?{id:42}:{id:42,balance:1}})
  }
  return send(404,{})
})
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  const p = await inv.createProvider({name:'test website session',baseUrl,kind:'sub2api'})
  await inv.updateProvider(p.id,{adminToken:'previous-manual'})
  const get = async()=> (await store.readDb()).providers.find(x=>x.id===p.id)
  const old = await get()
  await assert.rejects(inv.importProviderSession(p.id,{data:{access_token:'invalid-token',refresh_token:'refresh-invalid'}}),/HTTP 401/)
  assert.deepEqual((await get()).adminToken,old.adminToken)
  assert.equal((await get()).adminTokenSource,'manual')
  console.log('PASS invalid token never replaces existing credentials')

  profileInvalid = true
  await assert.rejects(inv.importProviderSession(p.id,{access_token:'access-imported'}),/数值余额/)
  profileInvalid = false
  await assert.rejects(inv.importProviderSession(p.id,{access_token:'access-imported',user:{id:99}}),/不一致/)
  assert.deepEqual((await get()).adminToken,old.adminToken)
  const result = await inv.importProviderSession(p.id,JSON.stringify({code:0,data:{access_token:'access-imported',refresh_token:'refresh-imported',expires_in:1,user:{id:42}}}))
  assert.deepEqual(Object.keys(result).sort(),['expiresAt','kind','ok','renewable','userId'])
  assert.equal(result.renewable,true)
  let saved = await get()
  assert.equal(saved.adminTokenSource,'session')
  assert.equal(saved.loginCred,null)
  assert.equal(await store.decryptSecret(saved.adminToken),'access-imported')
  assert.equal(await store.decryptSecret(saved.refreshTokenEnc),'refresh-imported')
  const publicView = inv.publicProvider(saved)
  assert.equal(publicView.tokenRenewal,'refresh')
  for(const key of ['adminToken','refreshTokenEnc','loginCred']) assert.equal(key in publicView,false)
  const disk = await readFile(join(home,'db.json'),'utf8')
  for(const secret of ['access-imported','refresh-imported']) assert.equal(disk.includes(secret),false)
  console.log('PASS verified token pair stored encrypted; public view and result do not expose credentials')

  const active = await inv.ensureAdminToken(p.id)
  assert.equal(active,'access-renewed')
  assert.equal(refreshCalls,1)
  assert.equal(loginCalls,0)
  saved = await get()
  assert.equal(await store.decryptSecret(saved.refreshTokenEnc),'refresh-rotated')
  const balance = await providers.tryBalance({baseUrl,adminToken:active,kind:'sub2api'})
  assert.equal(balance.ok,true); assert.equal(balance.remaining,1)
  console.log('PASS short expiry invokes official refresh and authenticated balance becomes 1')

  refreshDenied = true
  await inv.importProviderSession(p.id,{access_token:'access-imported',refresh_token:'refresh-expired',expires_in:1})
  const beforeDenied = await get()
  const failure = await inv.autoRelogin(p.id)
  assert.equal(failure.ok,false)
  assert.match(failure.reason,/站点重新登录/)
  assert.deepEqual((await get()).adminToken,beforeDenied.adminToken)
  assert.deepEqual((await get()).refreshTokenEnc,beforeDenied.refreshTokenEnc)
  assert.equal(loginCalls,0)
  console.log('PASS expired refresh preserves session and requests website login without password fallback')

  await inv.importProviderSession(p.id,'access-only')
  saved = await get()
  assert.equal(saved.refreshTokenEnc,null)
  assert.equal(saved.adminTokenExpiresAt,null)
  assert.equal(inv.publicProvider(saved).tokenRenewal,null)
  const calls = refreshCalls
  assert.equal((await inv.autoRelogin(p.id)).ok,false)
  assert.equal(refreshCalls,calls)
  await inv.updateProvider(p.id,{adminToken:'manual-again'})
  assert.equal(inv.publicProvider(await get()).tokenRenewal,null)
  assert.equal((await inv.autoRelogin(p.id)).ok,false)
  assert.equal(refreshCalls,calls)
  console.log('PASS access-only imports and manual tokens remain nonrenewable')

  let release
  delayed = new Promise(r=>{release=r})
  const started = new Promise(r=>{delayStarted=r})
  const race = inv.importProviderSession(p.id,'race-token')
  await started
  await inv.updateProvider(p.id,{adminToken:'new-user-choice'})
  release()
  await assert.rejects(race,/未覆盖/)
  assert.equal(await inv.revealAdminToken(p.id),'new-user-choice')
  console.log('PASS validation race never overwrites a user credential change')

  assert.throws(()=>parseProviderSession('x'.repeat(65537)),/64KB/)
  assert.throws(()=>parseProviderSession({access_token:'access-only',refresh_token:{bad:true}}),/refresh_token/)
  assert.throws(()=>parseProviderSession('{broken'),/JSON/)
  const jwt=`eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({exp:1900000000})).toString('base64url')}.unsigned`
  assert.equal(parseProviderSession(jwt).expiresAt,new Date(1900000000000).toISOString())
  assert.equal(parseProviderSession({access_token:'access-only',expires_in:60},1000).expiresAt,new Date(61000).toISOString())
  assert.equal(loginCalls,0)
  console.log('PASS bounded parsing and expiry scheduling; no direct-login requests occurred')
} finally {
  server.closeAllConnections()
  await new Promise(resolve=>server.close(resolve))
  if(await realpath(home)!==checked || !checked.startsWith(await realpath(tmpdir())+'/mapi-session-import-')) throw new Error('unexpected cleanup path')
  await rm(home,{recursive:true})
}
