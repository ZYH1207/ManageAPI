/**
 * 用量口径：网页只看网关、插件只看自己的直连渠道。
 *
 * 以前两件事混在一起：DSH 插件把「没走网关」的直连渠道推给 daemon（keyId=dsh-plugin，
 * providerId=dsh:<渠道名>），还顺手把「走网关」的调用也推了一遍（providerId=dsh:dsh-manage-api），
 * 于是用量页「按站点」里凭空多出几个不存在的站，而且网关流量被算了两次。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'mapi-usage-'))
process.env.MANAGE_API_HOME = home

const usage = await import('../core/usage.js')

let failed = 0
function ok(cond, message) {
  if (cond) console.log('  ✓ ' + message)
  else {
    failed += 1
    console.error('  ✗ ' + message)
  }
}

// 网关自己记的一行
await usage.recordUsage({ keyId: 'gk_a', providerId: 'p1', model: 'm1', inputTokens: 1000, outputTokens: 100, ok: true })
// 插件推来的直连渠道（没走网关）
await usage.recordUsage({ keyId: 'dsh-plugin', providerId: 'dsh:chatcode', model: 'deepseek-chat', inputTokens: 500, outputTokens: 50, ok: true })
// 插件把「走网关」的调用又推了一遍 —— 两个口径里都不该出现
await usage.recordUsage({ keyId: 'dsh-plugin', providerId: 'dsh:dsh-manage-api', model: 'm1', inputTokens: 300, outputTokens: 30, ok: true })
await usage.recordUsage({ keyId: 'dsh-plugin', providerId: 'dsh:manageapi', model: 'm1', inputTokens: 70, outputTokens: 7, ok: true })
// 插件推的网关分路径形态
await usage.recordUsage({ keyId: 'dsh-plugin', providerId: 'dsh:manage-api/v1', model: 'm1', inputTokens: 20, outputTokens: 2, ok: true })

const gw = await usage.usageSummary({ days: 30, source: 'gateway' })
ok(gw.totals.requests === 1, '网关口径只有网关自己记的那一次请求')
ok(gw.totals.input === 1000, '网关口径不掺插件流量（1000 token）')
ok(!Object.keys(gw.byProvider).some((k) => String(k).startsWith('dsh:')), '网关口径的「按站点」里没有任何 dsh: 渠道')
ok(Object.keys(gw.byKey).length === 1 && gw.byKey.gk_a, '网关口径的「按 Key」只有真实网关 Key')

const dsh = await usage.usageSummary({ days: 30, source: 'dsh' })
ok(dsh.totals.requests === 1, '插件口径只有直连渠道那一次请求')
ok(dsh.totals.input === 500, '插件口径不含网关流量')
ok(Object.keys(dsh.byProvider).join(',') === 'dsh:chatcode', '插件口径只有真正的直连渠道')

const all = await usage.usageSummary({ days: 30, source: 'all' })
ok(all.totals.requests === 2, '全部口径 = 网关 + 直连渠道，重复推的那几行不算')
ok(all.totals.input === 1500, '全部口径的 token 也是两者之和，没有重复计数')

const dflt = await usage.usageSummary({ days: 30 })
ok(dflt.totals.requests === 1, '不传 source 时默认就是网关口径')

await rm(home, { recursive: true, force: true })
if (failed > 0) {
  console.error(failed + ' 项失败')
  process.exit(1)
}
console.log('全部通过')
