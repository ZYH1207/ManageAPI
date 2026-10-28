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
import { ignoreChecker, modelIgnored, routeableOffers } from '../core/inventory.js'

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

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
