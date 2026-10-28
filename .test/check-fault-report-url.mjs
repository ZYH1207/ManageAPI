/**
 * 故障上报地址自检（纯函数，不联网）：
 *   1. 默认地址跟着本进程端口走，不再是写死的 4319
 *   2. 老库里写死的 4319 当「没配过」处理——预览实例复制真实 db 后不会再把
 *      诊断上报打进真实实例
 *   3. 用户显式填的地址原样保留（分开部署的场景）
 *   4. 令牌仍默认复用本库的 failoverToken
 *
 * 用法：node .test/check-fault-report-url.mjs
 */
import {
  defaultFaultReport,
  normalizeFaultReport,
  resolveReportUrl,
  resolveToken,
  setReportPort,
  defaultReportUrl,
  LEGACY_DEFAULT_URL,
} from '../core/fault-reporter.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

console.log('[1] 默认值：地址留空 = 跟随本进程端口')
{
  ok(defaultFaultReport().url === '', 'defaultFaultReport().url 为空（运行时解析）')
  setReportPort(4500)
  ok(defaultReportUrl() === 'http://127.0.0.1:4500/api/failover/report', `4500 → ${defaultReportUrl()}`)
  ok(resolveReportUrl({ settings: {} }) === defaultReportUrl(), '没有配置 → 用本进程地址')
  setReportPort(4319)
  ok(defaultReportUrl() === LEGACY_DEFAULT_URL, '4319 → 正好等于老默认值')
  setReportPort(4500)
}

console.log('[2] 老库兼容：写死的 4319 视为未配置')
{
  const legacy = normalizeFaultReport({ url: LEGACY_DEFAULT_URL, enabled: true })
  ok(legacy.url === '', 'legacy 4319 → 空')
  ok(resolveReportUrl({ settings: { faultReport: { url: LEGACY_DEFAULT_URL } } }) === 'http://127.0.0.1:4500/api/failover/report',
    '老库在 4500 实例里解析到 4500，不会打 4319')
  ok(normalizeFaultReport({ url: '   ' }).url === '', '纯空白 → 空')
  ok(normalizeFaultReport({ url: 123 }).url === '', '非字符串 → 空')
}

console.log('[3] 显式地址原样保留（分开部署）')
{
  const custom = normalizeFaultReport({ url: 'http://10.0.0.9:6000/api/failover/report' })
  ok(custom.url === 'http://10.0.0.9:6000/api/failover/report', '自定义地址保留')
  ok(resolveReportUrl({ settings: { faultReport: custom } }) === custom.url, '解析优先用自定义地址')
  const trimmed = normalizeFaultReport({ url: '  http://10.0.0.9:6000/x  ' })
  ok(trimmed.url === 'http://10.0.0.9:6000/x', '首尾空白被 trim')
}

console.log('[4] 其余字段口径不变')
{
  const cfg = normalizeFaultReport({ enabled: false, token: 'tk_x', useOwnToken: false })
  ok(cfg.enabled === false && cfg.token === 'tk_x' && cfg.useOwnToken === false, 'enabled/token/useOwnToken 原样')
  ok(normalizeFaultReport({ enabled: 0 }).enabled === true, 'enabled 只有显式 false 才关')
  ok(resolveToken({ settings: { failoverToken: 'fv_own', faultReport: { useOwnToken: true } } }) === 'fv_own', '默认复用本库令牌')
  ok(resolveToken({ settings: { failoverToken: 'fv_own', faultReport: { useOwnToken: false } } }) === '', '显式关闭后不再复用')
  ok(resolveToken({ settings: { failoverToken: 'fv_own', faultReport: { token: 'tk_x' } } }) === 'tk_x', '手填令牌优先')
}

process.exitCode = failed ? 1 : 0
console.log(failed ? `\n${failed} 项失败` : '\n全通过')
