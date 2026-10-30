/**
 * 自动路由入口暂时收起（2026-10-30）自检。
 *
 * 背景：自动路由接管后网关会在模型之间来回切，而模型的 KV 缓存绑在
 * 「模型 + 上游分组」上——每切一次，客户端几十万 token 的上下文都要在上游
 * 重新算一遍，缓存命中率暴跌，省下的差价远不够赔变慢与缓存重建。
 * 所以先把**入口**收起来：面板的开关、决策页的加号、/v1/models 里的 AutoThink。
 *
 * 但要藏得干净、留得住路：
 *   [1] 关掉的是「怎么开」，不是能力：挑选 / 迟滞 / 开关记账的纯函数一分没动
 *   [2] /v1/models 不再出 AutoThink；手写 model:AutoThink 也不会偷偷接管
 *   [3] 面板：没接管时开关不渲染；**已经在接管中**时仍然渲染（否则没有地方能关）
 *   [4] 判定只有一份：server.js 的清单与拨开关都走 AUTO_ROUTE_CLIENT_SWITCH
 *   [5] 恢复只需改两个常量（这里是它们的源码守卫，改回来这段就会红，提醒一起改）
 *
 * 用法：node .test/check-auto-route-hidden.mjs
 */
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUTO_ROUTE_CLIENT_SWITCH,
  AUTO_THINK_MODEL,
  autoThinkIntent,
  normalizeAutoRoute,
  enableAutoRoute,
  disableAutoRoute,
  applyAutoRoutePick,
  pickAutoRoute,
} from '../core/auto-route.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const core = await readFile(join(ROOT, 'core', 'auto-route.js'), 'utf8')
const server = await readFile(join(ROOT, 'daemon', 'server.js'), 'utf8')
const app = await readFile(join(ROOT, 'web', 'app.js'), 'utf8')
const readme = await readFile(join(ROOT, 'README.md'), 'utf8')

let failed = 0
const ok = (cond, msg, extra) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed += 1
    console.error(`  ✗ ${msg}${extra ? `  ← ${extra}` : ''}`)
  }
}

console.log('[1] 藏的是入口，不是能力：纯函数全在')
{
  ok(AUTO_ROUTE_CLIENT_SWITCH === false, '客户端拨开关常量当前是关的')
  ok(AUTO_THINK_MODEL === 'AutoThink', '虚拟模型名没变（恢复时不用改客户端）')
  ok(autoThinkIntent('AutoThink', []) === 'virtual', '判定函数照旧能认出虚拟模型')
  const settings = { autoRoute: normalizeAutoRoute(undefined) }
  ok(enableAutoRoute(settings).enabled === true, 'enableAutoRoute 照旧能开')
  ok(disableAutoRoute(settings).enabled === false, 'disableAutoRoute 照旧能关')
  const shape = applyAutoRoutePick(
    { autoRoute: { ...normalizeAutoRoute(undefined), enabled: true } },
    { modelKey: 'm-a', offerId: 'o-a', reason: 'initial', failoverFrom: null },
  )
  ok(shape.modelKey === 'm-a' && shape.reason === 'initial', '挑选结果照旧能落盘')
  ok(typeof pickAutoRoute === 'function', 'pickAutoRoute 没被删（测试与路由逻辑共用）')
}

console.log('[2] /v1/models 不再出 AutoThink，手写点名也不接管')
{
  // 清单：虚拟项被 AUTO_ROUTE_CLIENT_SWITCH 守住，且与 paidModels 拼在一起
  ok(/const virtualSwitch = AUTO_ROUTE_CLIENT_SWITCH/.test(server), '清单按常量决定要不要塞 AutoThink')
  ok(/\.\.\.virtualSwitch,/.test(server), 'virtualSwitch 确实进了 data 数组')
  ok(
    /!isFree &&\s*AUTO_ROUTE_CLIENT_SWITCH &&\s*isAutoThinkModel\(parsed\.model\)/.test(server),
    '拨开关判定第一道先看常量（关着时直接短路，不必重建供给数组）',
  )
  // 只有一处判定：再写一份「清单藏了但请求还认」就会两处漂。
  // 计的是**代码引用**（行首非注释、不是 import 行），注释里提到常量名不算
  const gated = server
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line) && !/^\s*AUTO_ROUTE_CLIENT_SWITCH,\s*$/.test(line))
    .filter((line) => line.includes('AUTO_ROUTE_CLIENT_SWITCH')).length
  ok(gated === 3, `server.js 里只有 3 处代码引用该常量（清单 / 拨开关 / state 提示位），实际 ${gated}`)
  ok(
    /virtualAutoThink:\s*AUTO_ROUTE_CLIENT_SWITCH &&/.test(server),
    'state.virtualAutoThink 也跟着关（否则面板还会写「客户端点 AutoThink = 开」）',
  )
}

console.log('[3] 面板：没接管时不渲染开关，接管中必须还渲染')
{
  ok(/const AUTO_ROUTE_UI_HIDDEN = true/.test(app), '前端常量为 true')
  ok(
    /if \(AUTO_ROUTE_UI_HIDDEN && !enabled\) return ''/.test(app),
    'autoRouteSwitch：只在未接管时藏（接管中要留一个能关的把手）',
  )
  ok(
    /if \(AUTO_ROUTE_UI_HIDDEN && !state\.autoRoute\?\.enabled\) return ''/.test(app),
    'autorouteScopeButton：同样只在未接管时藏',
  )
  // 隐藏开关不能把「事实」一起藏掉：正在使用 / 轮巡徽标是接管生效的现场
  ok(/\$\{routeNowPill\(\)\}/.test(app), '「正在使用」胶囊仍在 gateCard 里渲染')
  ok(/\$\{patrolBadge\(\)\}/.test(app), '轮巡徽标仍在 gateCard 里渲染')
  // 开关已藏，别再有别的入口能把它打开（action 处理器留着无害，但不能出现在导航/工具栏里）
  ok(
    !/data-act="toggle-auto-route"/.test(app),
    '没有额外的「开启自动路由」按钮绕过隐藏',
  )
}

console.log('[4] 文档跟着说清楚，别留「/v1/models 里永远有 AutoThink」')
{
  ok(!/永远多一个 `?AutoThink`?/.test(readme), 'README 不再声称清单里永远有 AutoThink')
  ok(/AUTO_ROUTE_CLIENT_SWITCH/.test(readme), 'README 写明了恢复用的常量名')
  ok(/缓存命中率/.test(readme), 'README 写明了收起的原因（缓存命中率），不是「先放着」')
}

process.exitCode = failed ? 1 : 0
console.log(failed ? `\n${failed} 项失败` : '\n全通过')
