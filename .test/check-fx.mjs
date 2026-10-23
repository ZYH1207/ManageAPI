/**
 * 汇率模块自测：不联网也能跑（用假 fetch），重点是「手动优先」「拉取失败不炸」。
 * 用 mkdtemp 当数据目录，跑完删掉。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'mapi-fx-'))
process.env.MANAGE_API_HOME = home

const fx = await import('../core/fx.js')
const store = await import('../core/store.js')

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ok ${name}`) } else { fail += 1; console.log(`  FAIL ${name} ${extra}`) }
}

// 假上游：一次成功、一次失败
const okFetch = async () => ({
  ok: true,
  json: async () => ({ result: 'success', rates: { CNY: 7.11, EUR: 0.91, JPY: 150.2, XXX: 999 } }),
})
const badFetch = async () => { throw new Error('network down') }

try {
  console.log('1) 默认值与兼容旧字段')
  const db = await store.readDb()
  check('emptyDb 带 fx 结构', db.settings.fx?.base === 'USD' && db.settings.fx?.rates?.CNY > 0)
  check('ensureFx 从 fxUsdCny 兜底', fx.ensureFx({ fxUsdCny: 7.35 }).rates.CNY === 7.35)
  check('ensureFx 基币恒为 1', fx.ensureFx({ fx: { rates: { CNY: 7 } } }).rates.USD === 1)

  console.log('2) 拉取只保留白名单币种')
  const got = await fx.fetchRates({ fetchImpl: okFetch })
  check('CNY 取到', got?.rates?.CNY === 7.11)
  check('没用的币种被丢掉', got?.rates?.XXX === undefined)
  check('白名单里没返回的不编造', got?.rates?.GBP === undefined)
  check('基币 USD=1', got?.rates?.USD === 1)

  console.log('3) 刷新落盘 + 同步 fxUsdCny 镜像')
  const first = await fx.refreshFx({ fetchImpl: okFetch, logger: {} })
  check('ok', first.ok === true)
  check('updatedAt 有值', Boolean(first.fx.updatedAt))
  check('source 记录来源', first.fx.source === 'er-api')
  const after = await store.readDb()
  check('fxUsdCny 镜像同步', after.settings.fxUsdCny === 7.11)

  console.log('4) 不是 stale 时不重复拉取')
  const fresh = fx.ensureFx((await store.readDb()).settings)
  check('shouldRefresh=false', fx.shouldRefresh(fresh) === false)
  check('isStale=false', fx.isStale(fresh) === false)
  check('8 天后算过期', fx.isStale(fresh, Date.now() + 8 * 86400000) === true)

  console.log('5) 拉取失败沿用旧值、不改 updatedAt')
  const before = (await store.readDb()).settings.fx
  const bad = await fx.refreshFx({ fetchImpl: badFetch, logger: {} })
  check('ok=false error=fetch', bad.ok === false && bad.error === 'fetch')
  const kept = (await store.readDb()).settings.fx
  check('updatedAt 没动', kept.updatedAt === before.updatedAt)
  check('汇率没变', kept.rates.CNY === before.rates.CNY)

  console.log('6) 手动覆盖优先')
  const manual = await fx.setManualRate(7.05)
  check('标记 manual', manual.manual === true && manual.source === 'manual')
  check('CNY 已改', (await store.readDb()).settings.fx.rates.CNY === 7.05)
  check('手动时 shouldRefresh=false', fx.shouldRefresh(fx.ensureFx((await store.readDb()).settings)) === false)
  const skipped = await fx.refreshFx({ fetchImpl: okFetch, logger: {} })
  check('手动模式不拉取', skipped.ok === false && skipped.error === 'manual')
  check('值没被覆盖', (await store.readDb()).settings.fx.rates.CNY === 7.05)

  console.log('7) 非法汇率被拒')
  let threw = false
  try { await fx.setManualRate(-1) } catch { threw = true }
  check('负数被拒', threw)
  threw = false
  try { await fx.setManualRate('abc') } catch { threw = true }
  check('非数字被拒', threw)

  console.log('8) 恢复自动后再拉取')
  await fx.setAutoRate()
  check('manual 清空', (await store.readDb()).settings.fx.manual === false)
  const again = await fx.refreshFx({ fetchImpl: okFetch, logger: {} })
  check('又能自动拉了', again.ok === true && again.fx.rates.CNY === 7.11)

  console.log('9) 币种换算（三角）')
  const rates = { rates: { USD: 1, CNY: 7.2, EUR: 0.9 } }
  check('CNY→USD', Math.round(fx.convert(100, 'CNY', 'USD', rates) * 100) / 100 === 13.89)
  check('USD→EUR', fx.convert(10, 'USD', 'EUR', rates) === 9)
  check('缺失币种返回 null', fx.convert(10, 'USD', 'JPY', rates) === null)
} finally {
  await rm(home, { recursive: true, force: true })
}

console.log(fail === 0 ? `\n全部 ${pass} 项通过` : `\n失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
