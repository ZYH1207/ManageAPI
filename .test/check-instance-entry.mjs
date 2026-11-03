import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isFormalInstance, instanceInfo } from '../daemon/instance-info.js'

const root = await mkdtemp(join(tmpdir(), 'mapi-entry-test-'))
const checked = await realpath(root)
try {
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  await mkdir(repo)
  const config = { port: 4319, dataDir: join(home, '.manage-api'), root: repo, home }
  assert.equal(isFormalInstance(config), true)
  assert.equal(isFormalInstance({ ...config, port: 4528 }), false)
  assert.equal(isFormalInstance({ ...config, dataDir: join(home, 'preview') }), false)
  await writeFile(join(repo, '.git'), 'gitdir: elsewhere')
  assert.equal(isFormalInstance(config), false)
  const identity = instanceInfo({ port: 4590, dataDir: root, build: 'test' })
  assert.equal(identity.mode, 'preview')
  assert.equal(identity.formalUrl, null)
  assert.equal(identity.build, 'test')
  console.log('PASS: formal identity rejects preview port, independent data and linked worktree')
} finally {
  if (await realpath(root) !== checked || !checked.startsWith(await realpath(tmpdir()) + '/mapi-entry-test-')) throw new Error('unexpected cleanup path')
  await rm(root, { recursive: true })
}
