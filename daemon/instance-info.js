/** Runtime identity is computed locally, never copied with the shared database. */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FORMAL_ORIGIN = 'http://manage-api.localhost'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const startedAt = new Date().toISOString()

export function isFormalInstance({ port, dataDir, root = ROOT, home = homedir() }) {
  let linked = false
  try { linked = statSync(join(root, '.git')).isFile() } catch { /* npm distribution has no .git */ }
  return !linked && port === 4319 && resolve(dataDir) === resolve(home, '.manage-api')
}

export function instanceInfo({ port, dataDir, build }) {
  const formal = isFormalInstance({ port, dataDir })
  return {
    mode: formal ? 'formal' : 'preview',
    version: VERSION,
    build,
    port,
    pid: process.pid,
    startedAt,
    formalUrl: formal ? `${FORMAL_ORIGIN}/` : null,
  }
}
