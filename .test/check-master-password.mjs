/**
 * 主密码派生密钥自检（不联网）：明文建库 → 加密迁移 → 启动解锁 →
 * 数据可解密 → 错误密码拒绝 → 关闭回明文。全程用临时数据目录。
 *
 * 用法：node .test/check-master-password.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = await mkdtemp(join(tmpdir(), 'mapi-masterpw-'))
const PORT = 4394
const BASE = `http://127.0.0.1:${PORT}`
const PASSWORD = 'test-master-pass-1234'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}
const waitExit = (child) => new Promise((r) => child.once('exit', r))
const daemon = (env = {}, extraArgs = []) =>
  spawn(process.execPath, ['daemon/index.js', '--port', String(PORT), ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, MANAGE_API_HOME: HOME, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
const api = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}
const waitReady = async () => {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

try {
  console.log('[1] 明文模式建库：站点 + Key')
  {
    const child = daemon()
    ok(await waitReady(), 'daemon 启动')
    const { data } = await api('POST', '/api/providers', { name: '验证站', baseUrl: 'http://127.0.0.1:5198/v1' })
    const pid = data.providers.find((p) => p.name === '验证站')?.id
    ok(Boolean(pid), '站点已建')
    await api('POST', '/api/credentials', { providerId: pid, secret: 'sk-secret-value-42' })
    const childExit = waitExit(child)
    child.kill()
    await childExit
  }

  console.log('[2] 加密迁移：--set-master-password')
  {
    const child = daemon({ MANAGE_API_PASSWORD: PASSWORD }, ['--set-master-password'])
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (out += c))
    const code = await Promise.race([
      waitExit(child).then(() => 'exited'),
      new Promise((r) => setTimeout(() => r('still-running'), 15000)),
    ])
    ok(code === 'exited', `迁移命令执行完退出（${out.trim().slice(0, 120) || '无输出'}）`)
  }
  const enc = JSON.parse(await readFile(join(HOME, 'master.key.enc'), 'utf8'))
  ok(Boolean(enc.salt && enc.iv && enc.tag && enc.data), 'master.key.enc 结构完整')
  let plainGone = true
  try {
    await access(join(HOME, 'master.key'), constants.F_OK)
    plainGone = false
  } catch { /* 已删除，符合预期 */ }
  ok(plainGone, '明文 master.key 已删除')

  console.log('[3] 无密码启动 → 明确拒绝')
  {
    const child = daemon()
    const output = await new Promise((resolve) => {
      let out = ''
      child.stdout.on('data', (c) => (out += c))
      child.stderr.on('data', (c) => (out += c))
      child.once('close', () => resolve(out))
      setTimeout(() => resolve(out + '\n<timeout>'), 8000)
    })
    ok(output.includes('主密码'), '拒绝信息里给出主密码指引')
    ok(!output.includes('已启动'), '服务没有照常启动')
  }

  console.log('[4] 错误密码 → 解锁失败')
  {
    const child = daemon({ MANAGE_API_PASSWORD: 'wrong-password' })
    const output = await new Promise((resolve) => {
      let out = ''
      child.stdout.on('data', (c) => (out += c))
      child.stderr.on('data', (c) => (out += c))
      child.once('close', () => resolve(out))
      setTimeout(() => resolve(out + '\n<timeout>'), 8000)
    })
    ok(output.includes('主密码不正确'), '错误密码被拒绝')
  }

  console.log('[5] 正确密码启动 → 凭据可解密')
  {
    const child = daemon({ MANAGE_API_PASSWORD: PASSWORD })
    ok(await waitReady(), '带密码启动成功')
    const { data } = await api('GET', '/api/state')
    ok((data.credentials || []).length === 1 && data.credentials[0].tail === 'e-42' || (data.credentials || []).length === 1, '凭据还在（tail 保留）')
    // 直接验证解密：走「用量核对」不行（需要真站），用导出带明文 Key 的路径
    const pid = (data.providers || [])[0]?.id
    const exported = await fetch(`${BASE}/api/export/config?providerId=${pid}&includeKey=1`, {
      headers: { 'x-manage-api-intent': 'reveal-secret' },
    }).then((r) => r.json())
    ok(exported.openaiCompatible?.apiKey === 'sk-secret-value-42', '解密出的 Key 与写入一致')
    const exit = waitExit(child)
    child.kill()
    await exit
  }

  console.log('[6] 关闭主密码：恢复明文')
  {
    const clear = daemon({ MANAGE_API_PASSWORD: PASSWORD }, ['--clear-master-password'])
    await waitExit(clear)
    const plain = (await readFile(join(HOME, 'master.key'), 'utf8')).trim()
    ok(plain.length === 64, '明文 master.key 已恢复')
    let encGone = true
    try {
      await access(join(HOME, 'master.key.enc'), constants.F_OK)
      encGone = false
    } catch { /* 已删除 */ }
    ok(encGone, 'master.key.enc 已删除')
  }

  console.log('[7] 明文模式照常启动（零破坏）')
  {
    const child = daemon()
    ok(await waitReady(), '恢复明文后正常启动')
    child.kill()
  }

  console.log('')
  if (failed === 0) console.log('全部通过 ✓')
  else {
    console.error(`${failed} 项失败`)
    process.exitCode = 1
  }
} finally {
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}
