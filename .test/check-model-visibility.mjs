/**
 * 单模型可见性开关自检（纯函数，不联网）。
 *
 * 背景（2026-10-28 作者反馈）：分组弹窗里点一下忽略，把「这一类」都忽略了——
 * 身份键把 v4.1-flash / 4.1-flash 这类写法归成一个模型，一处开关整组翻转。
 * 作者要的是**这一行就是这一行**：单独开关一个分组里的单个模型，
 * 也能从整类被忽略里单独捞一个出来。
 *
 * 两层各管各的（判定唯一实现在 core/inventory.js#ignoreChecker）：
 *   settings.ignoredModels —— 身份键整类忽略（「忽略模型」管理面板）
 *   settings.modelOverrides —— 精确名单行例外：'ignored' 单押一个 / 'shown' 捞一个
 *
 * 用法：node .test/check-model-visibility.mjs
 */
import {
  ignoreChecker,
  modelIgnored,
  routeableOffers,
  applyIgnoredModels,
  overrideKey,
  parseOverrideKey,
} from '../core/inventory.js'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}`)
  }
}

const provider = (id) => ({ id, name: id, baseUrl: 'http://x/v1', paused: false })
const offer = (id, modelKey) => ({ id, providerId: 'p1', modelKey, upstreamName: modelKey, group: '' })

/** 三个模型：前两个是同身份变体（v4.1 / 4.1），第三个无关 */
const db = (patch = {}) => ({
  settings: {
    modelAliases: {},
    ignoredModels: [],
    modelOverrides: {},
    ...patch.settings,
  },
  providers: [provider('p1')],
  offers: [offer('o1', 'deepseek-v4.1-flash'), offer('o2', 'deepseek-4.1-flash'), offer('o3', 'other-model')],
  ...patch,
})

const ids = (db2) => routeableOffers(db2).map((o) => o.id).sort()

console.log('[1] 没配置：全可见')
{
  ok(JSON.stringify(ids(db())) === JSON.stringify(['o1', 'o2', 'o3']), '无名单无例外 → 全部在役')
}

console.log('[2] 整类忽略（身份键名单）：变体一起消失')
{
  const d = db({ settings: { ignoredModels: ['deepseek-v4.1-flash'] } })
  ok(JSON.stringify(ids(d)) === JSON.stringify(['o3']), '忽略一个写法 → 两个变体都出役')
  ok(modelIgnored(d, 'deepseek-4.1-flash'), '另一个写法也判忽略')
}

console.log('[3] 整类被忽略时，单独捞一个出来（shown 例外）')
{
  const d = db({ settings: { ignoredModels: ['deepseek-v4.1-flash'], modelOverrides: { 'deepseek-v4.1-flash': 'shown' } } })
  ok(!modelIgnored(d, 'deepseek-v4.1-flash'), '精确名被捞回 → 显示')
  ok(modelIgnored(d, 'deepseek-4.1-flash'), '变体仍在整类忽略里')
  ok(JSON.stringify(ids(d)) === JSON.stringify(['o1', 'o3']), '在役集合：捞回的那个回来了，变体没有')
}

console.log('[4] 单押一个（ignored 例外）：不动变体')
{
  const d = db({ settings: { modelOverrides: { 'deepseek-v4.1-flash': 'ignored' } } })
  ok(modelIgnored(d, 'deepseek-v4.1-flash'), '精确名被单押 → 忽略')
  ok(!modelIgnored(d, 'deepseek-4.1-flash'), '变体不受影响')
  ok(!modelIgnored(d, 'other-model'), '别的模型更不受影响')
  ok(JSON.stringify(ids(d)) === JSON.stringify(['o2', 'o3']), '在役集合只有被单押的出役')
}

console.log('[5] 优先级：单行例外压过整类名单')
{
  // 整类没忽略、单行 shown：多余但无害，仍然显示
  ok(!modelIgnored(db({ settings: { modelOverrides: { 'kimi-k3': 'shown' } } }), 'kimi-k3'), 'shown + 无整类 → 显示')
}

console.log('[6] 真实现场：日期尾巴变体（截图里的 deepseek-v4-pro / -0813）')
{
  const d = db({
    settings: { modelOverrides: { 'deepseek-v4-pro': 'ignored' } },
    offers: [offer('a', 'deepseek-v4-pro'), offer('b', 'deepseek-v4-pro-0813')],
  })
  ok(modelIgnored(d, 'deepseek-v4-pro'), 'v4-pro 被单押')
  ok(!modelIgnored(d, 'deepseek-v4-pro-0813'), '-0813 不陪葬（各自精确名各自算）')
}

console.log('[7] 幂等：例外删空不留空对象')
{
  const d = db({ settings: { modelOverrides: { 'kimi-k3': 'ignored' } } })
  ok(modelIgnored(d, 'kimi-k3'), '单押生效')
  // 判定器是纯读，不 mutate——空对象清理由 API 层负责，这里只验证判定不受影响
  ok(modelIgnored(db(), 'kimi-k3') === false, '无配置 → 显示')
}

console.log('[8] 整组忽略要「这一行也别再漏出来」：清掉单行显示例外')
{
  // 现场：GPT 全家已整类忽略，但 gpt-6.1-sol 上留着一个早先点出来的 shown 例外，
  // 决策页就单蹦一行——面板上却写着「已忽略」，查不出来。
  const d = db({ settings: { ignoredModels: [], modelOverrides: { 'deepseek-v4.1-flash': 'shown' } } })
  applyIgnoredModels(d, ['deepseek-v4.1-flash'])
  ok(d.settings.modelOverrides?.['deepseek-v4.1-flash'] === undefined, '新加的身份键上的 shown 例外被清掉')
  ok(modelIgnored(d, 'deepseek-v4.1-flash'), '清完之后这一类真的出役了')
}

console.log('[9] 重发老名单不动例外（别的操作不能顺手废掉用户捞出来的那一个）')
{
  const d = db({ settings: { ignoredModels: ['deepseek-v4.1-flash'], modelOverrides: { 'other-model': 'shown' } } })
  applyIgnoredModels(d, ['deepseek-v4.1-flash'])
  ok(d.settings.modelOverrides?.['other-model'] === 'shown', '没涉及的例外原样保留')
}

console.log('[10] enforce：点「整组忽略」时，名单里本来就有也要清')
{
  const d = db({ settings: { ignoredModels: ['deepseek-v4.1-flash'], modelOverrides: { 'deepseek-v4.1-flash': 'shown' } } })
  applyIgnoredModels(d, ['deepseek-v4.1-flash'], { enforce: ['deepseek-v4.1-flash'] })
  ok(d.settings.modelOverrides?.['deepseek-v4.1-flash'] === undefined, 'enforce 指定的那一类，例外被清掉')
  ok(modelIgnored(d, 'deepseek-v4.1-flash'), '于是整类真的都不在役')

  const keep = db({ settings: { ignoredModels: ['deepseek-v4.1-flash'], modelOverrides: { 'other-model': 'shown' } } })
  applyIgnoredModels(keep, ['deepseek-v4.1-flash'], { enforce: ['deepseek-v4.1-flash'] })
  ok(keep.settings.modelOverrides?.['other-model'] === 'shown', 'enforce 只清自己那一类，别的例外不动')
}

console.log('[11] 只清 shown，单押的 ignored 例外不动')
{
  const d = db({ settings: { ignoredModels: [], modelOverrides: { 'other-model': 'ignored' } } })
  applyIgnoredModels(d, ['other-model', 'deepseek-v4.1-flash'])
  ok(d.settings.modelOverrides?.['other-model'] === 'ignored', 'ignored 例外保留（它本来就表示忽略）')
}

console.log('[12] 站点页的开关只作用于「这一行」：同名模型在别的站/分组不受影响')
{
  // 现场：deepseek-v4.1-flash 在 5 个站 8 个分组里都有。以前点一个「忽略」，
  // 8 条供给一起离场——用户点的是这一行，变的是这一类。现在按 站+分组+模型 存例外。
  const db2 = {
    settings: { modelAliases: {}, ignoredModels: [], modelOverrides: {} },
    providers: [provider('pa'), provider('pb')],
    offers: [
      { id: 'a1', providerId: 'pa', group: 'g1', modelKey: 'deepseek-v4.1-flash', upstreamName: 'deepseek-v4.1-flash' },
      { id: 'b1', providerId: 'pb', group: 'g9', modelKey: 'deepseek-v4.1-flash', upstreamName: 'deepseek-v4.1-flash' },
    ],
  }
  db2.settings.modelOverrides[overrideKey('deepseek-v4.1-flash', { providerId: 'pa', group: 'g1' })] = 'ignored'
  const live = ids(db2)
  ok(JSON.stringify(live) === JSON.stringify(['b1']), `只有 a1 离场，b1 还在（实际 ${live.join(',')}）`)
  ok(modelIgnored(db2, 'deepseek-v4.1-flash', { providerId: 'pa', group: 'g1' }), '带作用域问 a1 → 忽略')
  ok(!modelIgnored(db2, 'deepseek-v4.1-flash', { providerId: 'pb', group: 'g9' }), '带作用域问 b1 → 显示')
  ok(!modelIgnored(db2, 'deepseek-v4.1-flash'), '不带作用域（只问全局）→ 不算忽略')
}

console.log('[13] 旧数据兼容：纯模型名键仍是全局（对所有站生效）')
{
  const d = db({ settings: { ignoredModels: [], modelOverrides: { 'deepseek-v4.1-flash': 'ignored' } } })
  ok(modelIgnored(d, 'deepseek-v4.1-flash', { providerId: 'p1', group: '' }), '全局忽略对带作用域的行也生效')
  ok(modelIgnored(d, 'deepseek-v4.1-flash'), '不带作用域的询问也一样')
}

console.log('[14] 优先级：这一行的例外 > 全局例外 > 整类名单')
{
  const d = db({ settings: { ignoredModels: ['deepseek-v4.1-flash'], modelOverrides: {} } })
  d.settings.modelOverrides[overrideKey('deepseek-v4.1-flash', { providerId: 'p1', group: '' })] = 'shown'
  ok(!modelIgnored(d, 'deepseek-v4.1-flash', { providerId: 'p1', group: '' }), '这一行被捞回 → 显示')
  ok(modelIgnored(d, 'deepseek-v4.1-flash', { providerId: 'p2', group: '' }), '别的站仍整类忽略')

  const d2 = db({ settings: { ignoredModels: ['deepseek-v4.1-flash'], modelOverrides: { 'deepseek-v4.1-flash': 'shown' } } })
  ok(!modelIgnored(d2, 'deepseek-v4.1-flash'), '全局 shown 生效')
  d2.settings.modelOverrides[overrideKey('deepseek-v4.1-flash', { providerId: 'p1', group: '' })] = 'ignored'
  ok(modelIgnored(d2, 'deepseek-v4.1-flash', { providerId: 'p1', group: '' }), '这一行改成 ignored → 这一行忽略')
}

console.log('[15] 作用域键的解析（分组名里带冒号也不切坏）')
{
  ok(overrideKey('deepseek-v4.1-flash', { providerId: 'p1', group: '' }) === 'p1::::deepseek-v4.1-flash', '空分组也合法')
  const k = overrideKey('deepseek-v4.1-flash', { providerId: 'p1', group: 'a::b' })
  const parsed = parseOverrideKey(k)
  ok(parsed.model === 'deepseek-v4.1-flash', `模型名不被切坏（实际 ${parsed.model}）`)
  ok(parseOverrideKey('deepseek-v4.1-flash').scope === null, '纯模型名 → 全局')

  const d = db({ settings: { ignoredModels: [], modelOverrides: {} } })
  const key = overrideKey('deepseek-v4.1-flash', { providerId: 'p1', group: 'g1' })
  d.settings.modelOverrides[key] = 'shown'
  applyIgnoredModels(d, ['deepseek-v4.1-flash'])
  ok(d.settings.modelOverrides?.[key] === undefined, '整类忽略清掉了作用域写法上的 shown 例外')
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
