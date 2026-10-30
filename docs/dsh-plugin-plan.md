# DSH 插件端规划 v2

> 状态：**规划稿 v2，尚未开工**。本文回答两件事：插件端能做什么、怎么落地。
>
> v1（2026-10 早期稿）已被本稿替代。v1 的四处判断经实测修正：DSH 版本基线、P0 排序（provider 早已接通）、daemon 的能力边界（它不止是网页）、客户端「零构建」不成立。v2 另吸收了 `D:\AgentWorkPlace\DSH\manageapi-plugin-mapping.md`（678 行只读分析）的模块/数据/网关事实。
>
> **已定决策**（用户 2026-10-30 确认）：运行形态走 **内置运行时 + 子进程**。

---

## 1. 定位：插件补的是 daemon 补不了的四件事

| 形态 | 是什么 | 边界 |
|---|---|---|
| **daemon**（已有） | 独立 Node 进程 + 浏览器页面，服务**所有**客户端 | 只能被动「被调用」，进不了 DSH 的渲染树和请求生命周期 |
| **插件**（本文） | 装进 DSH profile 的 bundle，宿主进程内运行 | 能参与决策、渲染原生 UI、注册工具 |

插件独占的四类能力：

1. **参与决策** —— `llm/stream`、`agent/request`、`tools.guard`、`systemPrompt.context` 只在宿主进程里存在
2. **原生 UI** —— 右栏面板、会话内 chip、设置页、toast，跟随主题/明暗/语言
3. **原生交互** —— 注册工具给模型调、slash command、提问与审批
4. **进程生命周期** —— DSH 起则 daemon 起，DSH 关则停（用户不再手动 `npm start`）

**不重复做的事**：不重实现选站/换站/记账/探针。这些 daemon 已经做好，插件只做「把它变成 DSH 原生的一部分」。

---

## 2. 关键事实核对（实测，v1 的错误在这里纠正）

| # | 事实 | 证据 |
|---|---|---|
| 1 | DSH 运行时是 `@deepseek-ai/dsh@0.2.1-rc.5`；**44.7.0 是桌面 app 壳版本** | `resources/app.asar/dsh/package.json`（name= `@deepseek-ai/dsh-desktop-runtime`） |
| 2 | **provider 层早已接通**：profile patch 的 `llm-pi-ai` 里 `manage-api` → `http://127.0.0.1:4319/v1`，模型硬编码 2 条 | `~/.dsh/profiles/desktop/cordis.patch.yml` |
| 3 | daemon 有 **51 条 `/api/*` 路由**（表驱动 `routes[]`，`daemon/server.js:445-446`），含 `GET /api/state`（唯一全量状态，`?light=1`）、`/api/health`、`/api/probes/run`、余额、监控、免费平台、网关 Key | `daemon/server.js:452-1900` |
| 4 | `core/` **23 个模块**，13 个是纯函数（零 I/O、零全局态）；无任何文件 import `node:http` | `manageapi-plugin-mapping.md` §1 |
| 5 | **6 处模块级可变状态**（写盘串行链/读缓存）：`store.js:21`、`store.js:230`、`benchmark.js:53`、`platforms/store.js:81`、`usage.js:18`、`backup.js:20` | 同上 |
| 6 | 网关全内联在 `(req,res)`：`handleProxy:2526` → `handleChatCompletions:2273` → `forwardToUpstream:2046`；**没有函数式入口** | 同上 §5 |
| 7 | `db.json` 的 `traffic / routing / manualOrder / billingSamples` 是**懒创建**；`decryptSecret` **吞异常返回 `''`**（`store.js:141`） | 同上 §3 |
| 8 | `/api/*` **完全无鉴权**，只靠 loopback + content-type 挡 CSRF | 同上 §9 |
| 9 | 客户端一半**必须打包**：`window.__ModuleLoader__.load({id, factory})` 形式的预打包产物 | `@kenz1117/dsh-ui-usage-billing/lib/client.js:1` |
| 10 | `dsh-better-sidebar@0.28.0` 已装且启用，暴露 `ctx.betterSidebar.registerTab(descriptor)`；`descriptor.component: (props) => ReactNode` | `dsh-better-sidebar/lib/types/client/service.d.ts:146-303` |
| 11 | profile 已装 `@linxin666/dsh-remote-web-ui`（`autoTunnel: true`）→ **同源路由有被隧道放出去的风险** | `~/.dsh/profiles/desktop/cordis.patch.yml` |
| 12 | 运行时体积：`core` 373K + `daemon` 152K + `web` 520K = **1.1M 纯文本** | `du -sh` |

---

## 3. 运行形态：内置运行时 + 子进程（已定）

### 3.1 为什么内置

新用户「只装了插件端」，机器上没有 daemon、没有 `~/.manage-api/`、也没配过 patch。若插件是纯壳，装完等于空壳。ManageAPI 运行时**零依赖零构建**（且 `core/` 不含 `node:http`），随包分发成本极低。

### 3.2 依赖形态（推荐 A，待确认 ManageAPI 是否已发布到 npm）

| 方案 | 做法 | 优点 / 缺点 |
|---|---|---|
| **A（推荐）** | 插件 `dependencies: { "manage-api": "^0.2.0" }`，spawn `node <pkgDir>/daemon/index.js`；开发时 `link:../` | 单一源，不漂移；依赖 npm 已发布 |
| B | `prepack` 脚本把根仓库 `core/`、`daemon/` 拷进 `dsh-plugin/runtime/` | 可离线单包分发；多一份拷贝，需同步校验 |

包目录解析用 `createRequire(import.meta.url).resolve('manage-api/package.json')` + `dirname`，兼容 pnpm 的符号链接布局。

### 3.3 spawn 细节（Electron 宿主）

```js
const child = spawn(process.execPath, [daemonEntry], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, // 缺这条会弹出 Electron 窗口
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
```

- **只能用 `process.execPath`**：宿主是 Electron，`process.execPath` 指向 Electron 本体；必须配 `ELECTRON_RUN_AS_NODE=1` 才按 Node 跑。
- `daemon/index.js` 本来就是独立入口（自带 SIGINT/SIGTERM、备份/探针调度），**子进程模式下无需改造**。
- 健康探测：轮询 `GET /api/health`（200 且 JSON `ok:true`），超时 10s 判定失败。

### 3.4 attach-or-spawn 状态机

```
启动
 ├─ GET 127.0.0.1:4319/api/health
 │    ├─ 通 → attach（不 spawn、不抢锁、不写库）→ 状态 = attached
 │    └─ 不通 → spawn 子进程
 │         ├─ 子进程启动后 /api/health 通 → 状态 = owned
 │         └─ 子进程退出 & 锁被占（另一个 daemon 抢先）→ 回到 attach 重试一次
 │              否则 → 状态 = failed，UI 显示「ManageAPI 未启动」+ 手动重试按钮
```

两种状态对上层透明，仅影响「卸载时是否 flush/kill」。**锁被占 vs 真启动失败**必须在 Phase 0 实测区分（读 `daemon/instance-lock.js` 的退出码/错误文案）。

### 3.5 孤儿防护（必做）

宿主被强杀时子进程会变僵尸。两层：

1. 插件 `process.on('exit')` → `child.kill()`（覆盖正常退出）
2. daemon 加 `--parent-watch`：监听 `process.stdin` 的 `end`/`close`，父进程死则自退（约 10 行，进必改清单）

### 3.6 卸载顺序（owned 状态）

```
flushGatewayBuffers()      // daemon/server.js:2007 已导出，丢调用 = 最后 2–5s 成败样本与路由日志丢失
→ 关闭 server（不再接收新连接）
→ child.kill('SIGTERM')，等 5s，超时 SIGKILL
→ 锁随进程退出释放（instance-lock 的 process.once('exit') 钩子）
```

attached 状态下**什么都不做**——那是用户的进程。

### 3.7 版本漂移

用户机器上可能同时有 npm 版 `manage-api`。策略：**先启动者为准**；插件发起的子进程抢锁失败即 attach；`/api/state` 里带版本号，与插件自身期望不符时在面板顶部提示一行，不阻断。

---

## 4. 架构

```
DSH Host 进程
├─ plugin host 半边（index.js，零构建纯 ESM）
│   ├─ daemon 托管     attach-or-spawn / 孤儿防护 / 卸载 flush+kill
│   ├─ 同源代理        GET /api/manage-api/* → 127.0.0.1:4319/api/*
│   │                  webServer.register + connection.requestRejection（loopback only）
│   ├─ 采集            llm/stream waterfall（tee，不缓冲）→ usage/finish → 会话成本
│   ├─ 决策注入        systemPrompt.context + refreshContext（站点/单价/余额）
│   │                  tools.guard（预算熔断，Phase 2）
│   ├─ 注册            tools（status/switch/balance）+ commands(/manage) + model discovery
│   └─ 生命周期        ctx.effect 清理，全部注册返回 disposer
└─ plugin client 半边（client.js，打包为 __ModuleLoader__ 产物）
    ├─ ctx.betterSidebar.registerTab('manage-api:panel')  ← 主入口（缺失时降级）
    ├─ conversation.chat.assistant-actions                 ← 会话成本 chip
    ├─ settings.section                                    ← 设置页（Phase 3 表单）
    └─ workspace.toast / shell.overlay                     ← 余额低、降智、429

数据通路（唯一写通道 = daemon HTTP）
client ──fetch('/api/manage-api/state')──▶ host 代理 ──▶ daemon /api/state
client ──fetch('/api/manage-api/providers', POST)──▶ host 代理 ──▶ daemon /api/providers
```

**硬规则**

1. 插件**不 import `core/` 做写操作**。`mutate()` 只保证进程内串行（`store.js:265`），跨进程最后写入者覆盖。
2. **daemon 在跑 → 它是唯一数据源**。不在宿主进程里生成第二份状态，避免面板与网页数字不一致、`readDbCached` 的 `mtimeMs+size` 判定读到旧值。
3. 只读兜底（daemon 不在时）用裸 `fs.readFile` 读 `db.json`——它是原子写产物，读到的是完整快照；**不要**经过 `readDbCached`。

---

## 5. 功能清单

### P0｜Phase 1，装完就能日常用（约 2–3 天）

| # | 功能 | 落点 | 数据源 | 依赖 daemon |
|---|---|---|---|---|
| 1 | 右栏 ManageAPI 面板（概览/比价/决策/探针/用量 五个只读子页） | `ctx.betterSidebar.registerTab`；缺失降级为 `settings.section` + `conversation.view` | `GET /api/state?light=1` | 是（兜底直读文件） |
| 2 | 同源只读代理 | `webServer.register({kind:'exact', path:'/api/manage-api/state'})` + `connection.requestRejection` | 转发 4319 | 是 |
| 3 | 会话成本 chip | `conversation.chat.assistant-actions` | `llm/stream` 的 `usage` + `finish` | 否（DSH 侧自算） |
| 4 | daemon 托管（attach-or-spawn + 孤儿防护 + flush/kill） | 子进程 + `ctx.effect` | `/api/health` | — |

### P1｜Phase 2，差异化（约 3–4 天）

| # | 功能 | 落点 | 说明 |
|---|---|---|---|
| 5 | 真实流量回写评分 | `llm/stream` 采集 → daemon 新路由 `POST /api/ingest/usage` | **需要 daemon 小改（约 50 行，见 §8）**；必须分桶 `source:'traffic'`，不混进探针 benchmark |
| 6 | 模型列表动态化 | `llm.registerModelDiscovery(settingsNs, discover)` | `settingsNs` 从 `llm.listConfigurableProviders()` 运行时读，不猜；数据源 `/v1/models` + `/api/state` catalog；干掉 patch 里硬编码的 2 条 |
| 7 | 系统提示注入实时上下文 | `systemPrompt.context()` + `refreshContext()` | 当前站点、单价（`pricing.offerCost → blendedUsdPerMtok`）、余额、可用免费通道 |
| 8 | 工具 + command | `ctx.tools.register` / `commands.register` | `manageapi_status`（只读）、`manageapi_switch`、`manageapi_balance`；`/manage` 开面板 |
| 9 | 预算熔断 + 告警 | `tools.guard` / `agent/pre-step`；`workspace.toast` | 当日超支拒单；余额低/降智/429 推 toast |

### P2｜Phase 3，按需

| # | 功能 | 说明 |
|---|---|---|
| 10 | 表单页手写 React | 站点与 Key 管理、设置页。中间期可先用工具写（工具先行、UI 后补） |
| 11 | 工具 `manageapi_switch` 改路由 | 需要扩展 daemon 写接口；也可直接 `POST /api/settings` |
| 12 | 原生 adapter（`llm.registerAdapter`） | **走 HTTP 回环到 4319**，不做 in-process。只有在需要 per-provider 重试策略/图像计价时才做 |
| 13 | 换站次数与真实站点 chip | 需要 daemon 在响应里加 `x-ma-station` / `x-ma-failovers` 头（与 #5 同批） |
| 14 | 8 页面全量 React 化 | 只读页已能复用 HTML，这步只处理交互 |

**不做**：`agent/request` 强制改路由（B 路线，与其它插件抢 waterfall 顺序）；进程内 `routeOnce` 重构（除非做 in-process adapter）；远端/隧道共享。

---

## 6. 客户端半边工程

### 6.1 bundle 骨架

```jsonc
// dsh-plugin/package.json
{
  "name": "manage-api-dsh",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "dsh": {
    "engines": { "dsh": ">=0.2.1-rc.5" },
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-locale"] }
  },
  "peerDependencies": { "@deepseek-ai/cordis": "*", "react": "^18.2.0" }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: manage-api-dsh
      name: manage-api-dsh
```

**元数据必须齐全**：`locale/en.json` + `locale/zh.json` 的 `meta.title` / `meta.description`、原创 `icon.svg`（≤256KiB，包内）、`files` 列全。

### 6.2 client 产物的硬约束

- 形态：`window.__ModuleLoader__.load({ id: 'manage-api-dsh', factory: (e) => { /* CJS 风格 */ } })`
- 模块解析走 factory 的 `e(specifier)`：`react`、`react-dom`、`react/jsx-runtime` 由宿主提供
- 导出 `apply(ctx)` 与 `inject = [...]`（cordis 客户端插件形态）
- **不 import DSH client 内部包**（`dsh-client-ui-primitives` / `dsh-client-store` 等）。虽有个例能跑，但它们是 0.2.x 内部 API，升级必炸 → 自己写 markup + `--dsw-alias-*` 主题 token
- 文字走 `ctx.locale.register(...)`，不要硬编码中文

### 6.3 唯一的构建步骤

```js
// esbuild.mjs：只有一个产物
// 用 cjs 格式（不是 iife），把 require 别名成宿主的模块解析器 e，最后交出 module.exports
build({
  entryPoints: ['src/client/index.jsx'],
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  banner: { js: `window.__ModuleLoader__.load({id:"manage-api-dsh",factory:(e)=>{var module={exports:{}};var require=e;` },
  footer: { js: `;return module.exports}})` },
})
```

产物形态（与已装插件一致）：

```js
window.__ModuleLoader__.load({ id: 'manage-api-dsh', factory: (e) => {
  var module = { exports: {} }, require = e
  /* esbuild 的 cjs 产物：require('react') → 宿主提供的 React */
  return module.exports        // { apply, inject }
}})
```

host 半边（`lib/index.js`）**保持零构建**：手写 ESM，只 import `node:` 内置与（必要时）`manage-api/core/*.js` 的纯函数。产物 `lib/client.js` 提交进 git，仓库运行时依旧零依赖。

### 6.4 主入口的两种挂载

```js
// 优先：右侧栏（需 dsh-better-sidebar）
ctx.inject(['betterSidebar'], (s) =>
  s.effect(() => s.betterSidebar.registerTab({
    id: 'manage-api:panel',
    title: () => t('title'),
    description: () => t('desc'),
    icon: (size) => <Icon size={size} />,
    order: 40,
    single: true,
    component: (props) => <Panel {...props} />,   // props: { ctx, store, scope, ... }
  }), 'manage-api: sidebar tab'),
)

// 降级：设置页常驻 section + 会话内 tab
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section', id: 'manage-api', order: 60, locale: NS,
  inject: () => ({}),
}, PanelSection))
```

`ctx.inject([...], cb)` 不阻塞：betterSidebar 与我们的加载顺序无关。

### 6.5 UI 复用的边界（这条决定 Phase 1 工期）

`web/style.css` 与 `web/i18n.js` 可直接复用。`web/app.js` 里的 `renderXxx()` 返回 **HTML 字符串**：

- **只读页**：`<div dangerouslySetInnerHTML={{ __html: renderOverview(state) }} ref={afterRenderTranslate} />`，渲染后调一次 `translateDom()` 完成整块翻译。省掉绝大部分重写工作。
- **表单页**：必须手写 React 受控组件（事件、校验、提交），不做字符串拼接。
- 禁止 iframe：拿不到主题 token、明暗切换和 `ctx.locale`。

---

## 7. Host 半边工程

- `lib/index.js`：`export function apply(ctx, config)` + `export const Config`（schemastery）+ `export const inject`
- 所有注册包在 `ctx.effect(() => ..., 'label')` 并返回清理函数
- 可调参数放 `Config`（写进 `cordis.patch.yml`，用户 patch 层升级后仍在）：`port`、`autoStart`、`proxyEnabled`、`flushOnDispose`、`pollIntervalMs`
- 每会话状态若要做投影，用 `ctx.sessionProjections` 单元（`apply(state,event)` 纯同步），不要订阅 `session/event` 重扫
- 定时器用 `ctx.timer`，触发型工作要 `agent.followup()`（`inject()` 不唤醒 agent）

### 7.1 同源代理的安全要求（你环境特有）

profile 里 `@linxin666/dsh-remote-web-ui` 开着 `autoTunnel`，DSH Web GUI 可能经隧道可远程访问。而 `/api/*` **完全无鉴权**。

必须：

1. handler 首行 `connection.requestRejection(req)`，非 loopback 直接 403
2. 只代理白名单路径，**第一版只放 GET**
3. 不把 4319 本身绑到 `0.0.0.0`
4. 写操作走白名单 POST，逐条列（不要通配 `/api/*` 转发）

### 7.2 采集与注入

```js
ctx.on('llm/stream', async function*(options, next) {
  const stream = next()
  for await (const chunk of stream) {
    if (chunk.type === 'usage') record(options.sessionId, options.provider, options.model, chunk.usage)
    yield chunk                      // 只 tee：不缓冲、不对 chunk 做 await IO
  }
})
```

- 落盘丢队列（内存环形 + 定时 flush），绝不阻塞流
- `llm/stream` 是**全局** waterfall，包重了会拖慢所有请求
- 站点归因（走哪个站、换站几次）要等 daemon 回传响应头，Phase 2 一起做

---

## 8. 需要 daemon 配合的三处小改

| # | 改动 | 位置 | 工作量 |
|---|---|---|---|
| 1 | `--parent-watch`：stdin 关闭即退出（孤儿防护） | `daemon/index.js` | ~10 行 |
| 2 | `POST /api/ingest/usage`：接收插件上报的 usage，复用现有记账函数 | `daemon/server.js` 路由表 + 复用 `recordUsage`/`queueRouting` | ~50 行 |
| 3 | 响应头 `x-ma-station` / `x-ma-failovers` / `x-ma-offer` | `forwardToUpstream` 提交首 chunk 处（`:2156-2233`） | ~15 行 |

三处都是**加法**，不动现有控制流。不改 `routeOnce`、不改 `createAppServer`、不动 `(req,res)` 结构。

数据层注意：`db.json` 的 `traffic / routing / manualOrder / billingSamples` 懒创建，读之前判空；`decryptSecret` 失败返回 `''`，拿空 Key 必须短路，否则空串会打到上游。

---

## 9. 与已装插件的重叠

| 插件 | 状态 | 关系 |
|---|---|---|
| `@deepseek-ai/dsh-llm-pi-ai` | 启用，已配 `manage-api` provider | 占着 provider 通道；我们只加 discovery/工具/UI，**不动它的 adapter** |
| `dsh-cost-meter` 1.9.46 | 启用 | 成本 UI 重叠 → chip 只补「站点/换站/单价」，不重复总价；落地前先看它的 slot 位置 |
| `@kenz1117/dsh-ui-usage-billing` 1.7.2 | 装了但 `disabled` | 更重叠，保持禁用 |
| `dsh-our-free-model` 2.1.0 | 装了但不在 bundles 列表（未启用） | 免费通道/账号池/本地网关与 ManageAPI free 平台正面重叠，别同时开 |
| `dsh-better-sidebar` 0.28.0 | 启用 | UI 宿主；必须做缺失降级 |
| `@linxin666/dsh-remote-web-ui` | `autoTunnel: true` | 安全约束，见 §7.1 |

---

## 10. 分期与验收

### Phase 0（0.5 天，只验四件事）

- [ ] 空 bundle 装上，client 产物 `__ModuleLoader__` 包装跑通（一个 hello 组件进右栏）
- [ ] `llm/stream` 能拿到 `usage` 与 `finish`（打印即可）
- [ ] spawn 子进程 + `ELECTRON_RUN_AS_NODE=1` 能起 daemon，`/api/health` 通
- [ ] 锁被占时子进程的**退出码/文案**能被识别为「应 attach」而非「启动失败」

### Phase 1（2–3 天）

- [ ] 面板五页只读可用，`translateDom()` 中英都正常
- [ ] 代理路由仅 loopback，非 loopback 403，隧道下不可达
- [ ] 成本 chip 在 assistant 消息下正确显示 token 与花费
- [ ] DSH 退出后 daemon 子进程在 5s 内消失
- [ ] attached 模式下插件不碰锁、不写库

### Phase 2（3–4 天）

- [ ] 三类 daemon 小改落地并自测
- [ ] 流量上报写入 `db.traffic`，`source:'traffic'` 分桶，探针分布不被污染
- [ ] 模型列表来自 `/v1/models`，patch 里硬编码条目可删
- [ ] 工具与 `/manage` 可用；熔断与 toast 生效

### Phase 3（按需）

表单页、adapter（HTTP 回环）、关注点见 §5 P2。

---

## 11. 风险

| # | 风险 | 处理 |
|---|---|---|
| 1 | `__ModuleLoader__` 契约无公开文档，随小版本可能变 | 锁 `>=0.2.1-rc.5`；装上后冒烟：面板出现即通过；产物回归脚本进 CI |
| 2 | `llm/stream` 是全局 waterfall，包重会拖慢所有请求 | 只 tee、不缓冲、不 await 磁盘；落盘走队列 |
| 3 | 隧道把无鉴权 `/api/*` 放出去 | §7.1 四道约束；验收项写进 Phase 1 |
| 4 | 双写覆盖 `db.json` | 写一律走 daemon HTTP；只读兜底用裸 `fs.readFile` |
| 5 | 宿主强杀留僵尸 daemon | 双层孤儿防护（§3.5） |
| 6 | 评分样本语义污染 | `source:'traffic'` 独立分桶，不混 benchmark |
| 7 | Electron 里 `process.execPath` 直接 spawn 会开窗口 | 必须 `ELECTRON_RUN_AS_NODE=1` |
| 8 | 与 pi-ai 的 provider 配置漂移 | 模型发现成功后删除硬编码；失败时回退并提示 |

---

## 12. 待定

1. **ManageAPI 是否已发布到 npm？** 决定了运行时是「作依赖」还是「打包内置」（§3.2）。
2. **第一版范围**：只到 Phase 1，还是一路做到 Phase 2 的流量上报？
3. **面板入口**：确认走 betterSidebar 右栏（建议）+ 缺失降级，还是直接常驻 `settings.section`。

---

## 13. 附录：已实测的接口摘录

```js
// host：同源路由（沿用 usage-billing 的写法）
ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), 'manage-api: route')
connection.requestRejection(req)   // 非 loopback 判定

// host：模型发现
llm.listConfigurableProviders()                     // → [{ provider, settingsNs }]
llm.registerModelDiscovery(settingsNs, async (req, signal) => Promise<LlmModelInfo[]>)

// host：llm/stream waterfall
ctx.on('llm/stream', async function*(options, next) { /* options: GenerateOptions */ })
// StreamChunk: {type:'usage', usage:{inputTokens,outputTokens,cacheReadTokens?,...}}
//              {type:'finish', reason:{kind}} / {type:'text-delta'|'tool-call-delta'|...}

// host：系统提示
ctx.systemPrompt.context({ ... }) + ctx.systemPrompt.refreshContext(assembly, context)

// client：右栏 tab
ctx.betterSidebar.registerTab({ id, title, description, icon, order, single, component: (props) => ReactNode })
// 其它可用字段：hidden / bottomOnly / available / dedupeKey / createTab / badge / rightActions
//               settings:{ toggles, pluginToggles, render } / onOpen / onActivate / onClose

// client：slot 注册形态
ctx.slots.inject(ownerKey, () => ctx.slots.register({ name, id, order, locale, inject: (props) => ({...}) }, Component))

// client：产物形态
window.__ModuleLoader__.load({ id: 'manage-api-dsh', factory: (e) => { /* module.exports = { apply, inject } */ } })
```

---

## 14. 参考

- 模块/数据/网关逐文件事实：`D:\AgentWorkPlace\DSH\manageapi-plugin-mapping.md`（678 行，只读分析）
- 插件包结构与 profile 安装方式：本机任一已装插件的 `package.json` + `cordis.patch.yml`
- 数据目录与降级策略：`core/store.js:26 dataDir()`
- 内置运行时的入口：`daemon/index.js`、`daemon/server.js:2620 createAppServer()`
