#!/usr/bin/env node
/** One-time per-computer formal entry. Default: inspect and print, never install. */
import { lookup } from 'node:dns/promises'
import { createConnection } from 'node:net'
import { mkdir, writeFile, chmod, chown, lstat, realpath, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir, platform, userInfo } from 'node:os'
import { spawnSync } from 'node:child_process'

const DOMAIN = 'manage-api.localhost'
const DAEMON = dirname(fileURLToPath(import.meta.url))
const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;' })[c])
const unitQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`

export function buildPlan({ system = platform(), node = process.execPath, uid = userInfo().uid, gid = userInfo().gid, windowsRoot = join(homedir(), 'AppData', 'Local', 'ManageAPI', 'local-domain') } = {}) {
  if (!['darwin', 'linux', 'win32'].includes(system)) throw new Error(`Unsupported platform: ${system}`)
  const root = system === 'darwin' ? '/Library/Application Support/ManageAPI/local-domain'
    : system === 'linux' ? '/etc/manage-api-local-domain' : windowsRoot
  const proxy = join(root, 'local-domain-proxy.mjs')
  const config = join(root, 'config.json')
  const helper = join(root, 'bind-helper')
  const helperSource = join(root, 'local-domain-bind.c')
  const args = [helper, String(uid), String(gid), node, proxy, config]
  const plan = { system, domain: DOMAIN, targetPort: 4319, addresses: ['127.0.0.1:80', '[::1]:80'], root, proxy, config, node, uid, gid, helper, helperSource,
    files: [proxy, config], servicePath: null, serviceText: null }
  if (system === 'darwin') {
    plan.servicePath = '/Library/LaunchDaemons/local.manage-api.domain.plist'
    plan.serviceText = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>local.manage-api.domain</string>\n<key>ProgramArguments</key><array>${args.map((v) => `<string>${xml(v)}</string>`).join('')}</array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>\n<key>WorkingDirectory</key><string>${xml(root)}</string>\n<key>StandardOutPath</key><string>/var/log/manage-api-local-domain.log</string>\n<key>StandardErrorPath</key><string>/var/log/manage-api-local-domain.log</string>\n</dict></plist>\n`
  } else if (system === 'linux') {
    plan.servicePath = '/etc/systemd/system/manage-api-local-domain.service'
    plan.serviceText = `[Unit]\nDescription=ManageAPI per-computer localhost entry\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${args.map(unitQuote).join(' ')}\nWorkingDirectory=${unitQuote(root)}\nRestart=on-failure\nRestartSec=5\nUMask=0022\n\n[Install]\nWantedBy=multi-user.target\n`
  } else {
    plan.servicePath = 'Scheduled Task: ManageAPI Local Domain (current user, logon, Limited)'
    plan.serviceText = `$ErrorActionPreference = 'Stop'\n$action = New-ScheduledTaskAction -Execute ${psQuote(node)} -Argument ${psQuote(`"${proxy}" --config "${config}"`)} -WorkingDirectory ${psQuote(root)}\n$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name\n$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user\n$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited\n$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries\nRegister-ScheduledTask -TaskName 'ManageAPI Local Domain' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null\nStart-ScheduledTask -TaskName 'ManageAPI Local Domain'\n`
  }
  if (system !== 'win32') plan.files.push(helperSource, helper)
  return plan
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: platform() === 'win32' ? process.env : { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } })
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout || result.status}`)
  return result.stdout
}

/** Never follow an existing symlink while installing privileged service files. */
async function protectedDirectory(path) {
  const parent = dirname(path)
  if (parent !== path) await protectedDirectory(parent)
  try { await mkdir(path, { mode: 0o755 }) } catch (e) { if (e.code !== 'EEXIST') throw e }
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) {
    throw new Error(`Installation directory must be root-owned and not group/other writable: ${path}`)
  }
}
async function protectedFile(path, content, mode = 0o644) {
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) throw new Error(`Unsafe existing installation file: ${path}`) }
  catch (e) { if (e.code !== 'ENOENT') throw e }
  await writeFile(path, content, { mode, flag: 'w' })
  await chown(path, 0, 0)
  await chmod(path, mode)
}
async function occupied(host) {
  return new Promise((done) => {
    const socket = createConnection({ host, port: 80 })
    const finish = (value) => { socket.destroy(); done(value) }
    socket.setTimeout(500, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export async function inspectEnvironment() {
  let dns = []
  let dnsError = null
  try { dns = await lookup(DOMAIN, { all: true }) } catch (e) { dnsError = e.code || e.message }
  const busy = (await Promise.all(['127.0.0.1', '::1'].map(async (host) => ({ host, busy: await occupied(host) })))).filter((x) => x.busy).map((x) => x.host)
  return { dns, dnsError, busy }
}

export async function install(plan) {
  if (plan.system !== platform()) throw new Error('Cannot install a service for a different operating system')
  if (plan.system !== 'win32') {
    if (process.getuid?.() !== 0) throw new Error('Installation requires administrator privileges; inspect the dry-run plan, then run with sudo and --install')
    if (!Number.isInteger(plan.uid) || plan.uid <= 0 || !Number.isInteger(plan.gid) || plan.gid <= 0) {
      throw new Error('A regular user is required. Use sudo from your account (SUDO_UID/SUDO_GID), or pass --uid and --gid explicitly')
    }
  }
  const env = await inspectEnvironment()
  if (env.busy.length) throw new Error(`Loopback port 80 is already occupied on ${env.busy.join(', ')}. Stop the conflicting service first; no alternate port will be selected`)
  await access(plan.node, constants.X_OK)
  const proxySource = await import('node:fs/promises').then((fs) => fs.readFile(join(DAEMON, 'local-domain-proxy.js'), 'utf8'))
  if (plan.system === 'win32') {
    await mkdir(plan.root, { recursive: true })
    await writeFile(plan.proxy, proxySource)
    await writeFile(plan.config, JSON.stringify({ targetPort: 4319 }, null, 2) + '\n')
    // No elevated scheduled task: user-owned Node/module/config only execute as that user.
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', plan.serviceText])
    return
  }
  await access('/usr/bin/cc', constants.X_OK)
  await protectedDirectory(plan.root)
  await protectedDirectory(dirname(plan.servicePath))
  await protectedFile(plan.proxy, proxySource)
  await protectedFile(plan.config, JSON.stringify({ targetPort: 4319, uid: plan.uid, gid: plan.gid }, null, 2) + '\n')
  const c = await import('node:fs/promises').then((fs) => fs.readFile(join(DAEMON, 'local-domain-bind.c'), 'utf8'))
  await protectedFile(plan.helperSource, c)
  // Root only executes a minimal native helper; user-managed Node/dylibs execute after setuid.
  try { const old = await lstat(plan.helper); if (!old.isFile() || old.isSymbolicLink() || old.uid !== 0 || (old.mode & 0o022)) throw new Error(`Unsafe helper: ${plan.helper}`) }
  catch (e) { if (e.code !== 'ENOENT') throw e }
  run('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-o', plan.helper, plan.helperSource])
  await chown(plan.helper, 0, 0)
  await chmod(plan.helper, 0o755)
  await protectedFile(plan.servicePath, plan.serviceText)
  if (plan.system === 'darwin') {
    run('/bin/launchctl', ['bootstrap', 'system', plan.servicePath])
  } else {
    run('/usr/bin/systemctl', ['daemon-reload'])
    run('/usr/bin/systemctl', ['enable', '--now', 'manage-api-local-domain.service'])
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) {
    console.log('Usage: node daemon/install-local-domain.js [--dry-run | --install] [--node /absolute/node] [--uid N --gid N]\nDefault is --dry-run. Formal target is always loopback:4319; previews are unchanged.')
    return
  }
  const options = {}
  let doInstall = false
  let explicitDryRun = false
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]
    if (name === '--install') { doInstall = true; continue }
    if (name === '--dry-run') { explicitDryRun = true; continue }
    if (!['--node', '--uid', '--gid'].includes(name) || !argv[i + 1]) throw new Error(`Unknown or missing option: ${name}`)
    const value = argv[++i]
    options[name.slice(2)] = name === '--node' ? value : Number(value)
  }
  if (doInstall && explicitDryRun) throw new Error('Choose --dry-run or --install, not both')
  const node = options.node || process.execPath
  if (!isAbsolute(node) || /[\r\n\0]/.test(node)) throw new Error('--node must be an absolute executable path without control characters')
  const nodePath = await realpath(node)
  const plan = buildPlan({ node: nodePath, uid: options.uid ?? Number(process.env.SUDO_UID ?? userInfo().uid), gid: options.gid ?? Number(process.env.SUDO_GID ?? userInfo().gid) })
  const env = await inspectEnvironment()
  console.log(`ManageAPI local domain ${doInstall ? 'INSTALL' : 'DRY RUN (no changes)'}\nPanel: http://${DOMAIN}/\nGateway: http://${DOMAIN}/v1\nFixed target: 127.0.0.1:4319\nPreview ports: unchanged\nSystem: ${plan.system}\nRuntime: ${plan.node}\nRun as: ${plan.system === 'win32' ? 'current user, Limited scheduled task' : `uid=${plan.uid}, gid=${plan.gid} (drop before Node)`}\nInstall directory: ${plan.root}\nService: ${plan.servicePath}\nFiles: ${plan.files.join(', ')}\nPort 80: ${env.busy.length ? `OCCUPIED (${env.busy.join(', ')})` : 'no listening service detected'}\nOS resolver: ${env.dns.length ? env.dns.map((x) => x.address).join(', ') : `unresolved (${env.dnsError}); browser .localhost resolution may still work`}\n\nService definition:\n${plan.serviceText}`)
  if (!doInstall) {
    console.log('No files, services, hosts entries or gateway data were changed. To install, review this plan and run the same command with --install (sudo on macOS/Linux).')
    return
  }
  await install(plan)
  console.log(`Installed. Open http://${DOMAIN}/ . Start the formal ManageAPI instance on 4319 separately. If the domain does not resolve, see docs/local-domain.md.`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(`[manage-api local domain installer] ${error.message}`); process.exitCode = 1 })
}
