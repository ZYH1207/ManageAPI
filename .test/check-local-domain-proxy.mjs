import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createLocalDomainProxy } from '../daemon/local-domain-proxy.js'

const listen = (server, host = '127.0.0.1', port = 0) => new Promise((done, reject) => {
  server.once('error', reject)
  server.listen(port, host, () => { server.removeListener('error', reject); done(server.address().port) })
})
const close = (server) => new Promise((done) => { server.closeAllConnections(); server.close(done) })
let streamedResolve
let abortedResolve
let uploadStartedResolve
const uploadStarted = new Promise((done) => { uploadStartedResolve = done })
const upstreamSawStream = new Promise((done) => { streamedResolve = done })
const upstreamSawAbort = new Promise((done) => { abortedResolve = done })
const upstream = http.createServer((req, res) => {
  if (req.url === '/api/instance') { res.end(JSON.stringify({ mode: 'formal' })); return }
  if (req.url === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-ManageAPI-Entry': 'spoofed',
      Connection: 'keep-alive, x-private-hop', 'X-Private-Hop': 'strip-me' })
    res.write('data: first\n\n')
    streamedResolve(() => res.end('data: last\n\n'))
    return
  }
  if (req.url === '/abort') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: waiting\n\n')
    res.on('close', abortedResolve)
    return
  }
  if (req.url === '/upload-abort') {
    req.once('data', () => { uploadStartedResolve(); res.write('receiving') })
    req.on('aborted', () => abortedResolve())
    return
  }
  let body = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers, body })) })
})
const targetPort = await listen(upstream)
const proxy = createLocalDomainProxy({ targetPort, port: 0 })
const bound = await proxy.listen()
const port = bound.port
const host = `manage-api.localhost:${port}`
function call({ path = '/', method = 'GET', headers = {}, body, address = '127.0.0.1' } = {}) {
  return new Promise((done, reject) => {
    const req = http.request({ host: address, port, path, method, headers: { host, ...headers } }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => done({ status: res.statusCode, text, headers: res.headers }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
}
const deadline = (promise, label) => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out`)), 2500)
  timer.unref()
})])
try {
  const result = await call({ path: '/v1/chat/completions?x=1', method: 'POST', headers: {
    Authorization: 'Bearer sk-test', 'Content-Type': 'application/json', Origin: `http://${host}`,
    Connection: 'x-remove', 'X-Remove': 'secret', Forwarded: 'for=evil', 'X-Forwarded-For': '10.0.0.1', 'X-Real-IP': '10.0.0.1',
  }, body: '{"stream":true}' })
  assert.equal(result.status, 200)
  assert.equal(result.headers['x-manageapi-entry'], 'formal')
  const echoed = JSON.parse(result.text)
  assert.equal(echoed.headers.host, `127.0.0.1:${targetPort}`)
  assert.equal(echoed.headers.authorization, 'Bearer sk-test')
  assert.equal(echoed.body, '{"stream":true}')
  assert.equal(echoed.url, '/v1/chat/completions?x=1')
  for (const name of ['forwarded', 'x-forwarded-for', 'x-remove', 'x-real-ip']) assert.equal(echoed.headers[name], undefined)
  for (const foreign of ['evil.example', 'manage-api.localhost.evil', `manage-api.localhost:${port + 1}`, '127.0.0.1']) {
    assert.equal((await call({ headers: { host: foreign } })).status, 403)
  }
  assert.equal((await call({ headers: { host: 'MANAGE-API.LOCALHOST' } })).status, 200)
  for (const origin of ['http://evil.example', 'null', 'https://manage-api.localhost', 'http://manage-api.localhost.evil']) {
    assert.equal((await call({ method: 'POST', headers: { Origin: origin } })).status, 403)
  }
  assert.equal((await call({ method: 'POST', body: 'cli with no Origin' })).status, 200)
  assert.equal((await call({ path: 'http://evil.example/' })).status, 400)
  if (bound.addresses.includes('::1')) assert.equal((await call({ address: '::1' })).status, 200)
  console.log('PASS host, Origin, IPv6, auth/body and hop headers')

  const streamDone = new Promise((done, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/stream', headers: { host } }, (res) => {
      assert.equal(res.headers['x-manageapi-entry'], 'formal')
      assert.equal(res.headers['x-private-hop'], undefined)
      let text = ''
      res.on('data', async (chunk) => {
        text += chunk
        if (text === 'data: first\n\n') (await upstreamSawStream)()
      })
      res.on('end', () => { assert.equal(text, 'data: first\n\ndata: last\n\n'); done() })
      res.on('error', reject)
    })
    req.on('error', reject)
  })
  await deadline(streamDone, 'unbuffered stream')
  const abortReq = http.get({ host: '127.0.0.1', port, path: '/abort', headers: { host } })
  abortReq.on('error', () => {})
  const [abortRes] = await once(abortReq, 'response')
  await once(abortRes, 'data')
  abortRes.destroy()
  await deadline(upstreamSawAbort, 'upstream cancellation')
  const uploadCancelled = new Promise((done) => { abortedResolve = done })
  const uploadReq = http.request({ host: '127.0.0.1', port, path: '/upload-abort', method: 'POST', headers: { host } })
  uploadReq.on('error', () => {})
  uploadReq.on('response', (res) => res.on('error', () => {}))
  uploadReq.write('first upload chunk')
  await deadline(uploadStarted, 'unbuffered upload')
  uploadReq.destroy()
  await deadline(uploadCancelled, 'upload cancellation')
  console.log('PASS streaming first chunk, unbuffered upload and disconnect cancellation')

  const inherited = http.createServer()
  const inheritedPort = await listen(inherited)
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {createLocalDomainProxy} from ${JSON.stringify(new URL('../daemon/local-domain-proxy.js', import.meta.url).href)};
    const proxy=createLocalDomainProxy({targetPort:${targetPort},port:${inheritedPort},listenFds:[3]});
    await proxy.listen();console.log('ready');
    process.on('SIGTERM',()=>proxy.close().then(()=>process.exit(0)));
  `], { stdio: ['ignore', 'pipe', 'pipe', inherited._handle.fd] })
  let childError = ''
  child.stderr.on('data', (chunk) => { childError += chunk })
  try {
    await deadline(once(child.stdout, 'data'), 'inherited listener startup')
    await close(inherited) // Child owns its duplicated descriptor; parent must stop accepting.
    const inheritedResult = await new Promise((done, reject) => {
      http.get({ host: '127.0.0.1', port: inheritedPort, headers: { host: `manage-api.localhost:${inheritedPort}` } }, (res) => {
        res.resume(); res.on('end', () => done(res.statusCode))
      }).on('error', reject)
    })
    assert.equal(inheritedResult, 200, childError)
  } finally { child.kill('SIGTERM'); await deadline(once(child, 'exit'), 'inherited listener close'); await close(inherited) }
  console.log('PASS inherited listening socket handoff')

  const blocked = http.createServer()
  // If IPv6 is available, failure binding its port must release the IPv4 half.
  if (bound.addresses.includes('::1')) {
    const blockedPort = await listen(blocked, '::1')
    const half = createLocalDomainProxy({ targetPort, port: blockedPort })
    await assert.rejects(half.listen(), /No alternate port/)
    const probe = http.createServer()
    await listen(probe, '127.0.0.1', blockedPort)
    await close(probe)
    await close(blocked)
  }
  console.log('PASS bind conflict rolls back listeners')
} finally {
  await proxy.close()
  await close(upstream)
}

const wrong = http.createServer((_req, res) => res.end(JSON.stringify({ mode: 'preview' })))
const wrongPort = await listen(wrong)
const guarded = createLocalDomainProxy({ targetPort: wrongPort, port: 0, ipv6: false })
const guardedPort = (await guarded.listen()).port
try {
  const response = await new Promise((done, reject) => {
    http.get({ host: '127.0.0.1', port: guardedPort, headers: { host: 'manage-api.localhost' } }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk }); res.on('end', () => done({ status: res.statusCode, text }))
    }).on('error', reject)
  })
  assert.equal(response.status, 502)
  assert.match(response.text, /formal instance identity could not be verified/)
  await close(wrong)
  const response2 = await new Promise((done, reject) => {
    http.get({ host: '127.0.0.1', port: guardedPort, headers: { host: 'manage-api.localhost' } }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk }); res.on('end', () => done({ status: res.statusCode, text }))
    }).on('error', reject)
  })
  assert.equal(response2.status, 502)
  assert.match(response2.text, /previews are not used/)
  console.log('PASS wrong instance and unavailable upstream never select preview')
} finally { await guarded.close(); if (wrong.listening) await close(wrong) }
console.log('All local domain proxy checks passed')
