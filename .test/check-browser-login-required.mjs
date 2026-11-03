import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { loginProvider } from '../core/providers.js'
let attempts = 0
const site = createServer((_req, res) => {
  attempts++
  res.writeHead(400, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({code:400,reason:'TURNSTILE_VERIFICATION_FAILED',message:'turnstile verification failed'}))
})
await new Promise(r=>site.listen(0,'127.0.0.1',r))
try {
  await assert.rejects(()=>loginProvider({baseUrl:`http://127.0.0.1:${site.address().port}/v1`,kind:'sub2api',user:'test',password:'test'}), e=>e.code==='BROWSER_LOGIN_REQUIRED' && !e.message.includes('HTTP'))
  assert.equal(attempts,1)
  console.log('PASS: browser challenge returns concise structured guidance without retrying other login paths')
} finally {
  site.closeAllConnections()
  await new Promise(r=>site.close(r))
}
