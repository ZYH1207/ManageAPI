# A 棒 · 兼容矩阵（朋友版调用 → 用户版 daemon 实际 → 结论）

> 配套 `decision-record.md`。**以实现代码为准，README 的 ✅ 不当证据。**
> 三份事实源：
> - 用户版 `$BASE/daemon/server.js`（`ecf55d1`）：`route(method, /regex/, handler)` 共 **109 条**，`const routes = []`（L982）开始；`/api/state` 在 L995。
> - 朋友版 `recon/friend-dsh-manage-api-main/lib/{client.js,routes.js,write-proxy.js,ingest.js,index.js,tools.js,commands.js,prompt.js,dsh-models.js,daemon.js,http.js}`（`main` @ `509c4bb…`）。
> - 本机 DSH `0.2.2-alpha.2` 安装文件（见 `decision-record.md` §3）。
>
> 结论枚举：**可直接用 / 需薄适配 / 需新增(已授权) / unavailable**。
> 全部为**静态只读核验**：daemon 4319 未运行、Client 未在线，未做任何运行时行为验证。

---

## 0. 关键字段与入参核实（验收点 2 的硬项）

| 项 | 朋友版会发什么 | 用户版实际 | 结论 |
|---|---|---|---|
| `/api/state?light=1` | `lib/routes.js` L199 发 `/api/state?light=1&panel=1`（`full=1` 时 `/api/state?panel=1`）；`lib/tools.js` L60、`lib/prompt.js` L54、`lib/commands.js` L41 直接发 `/api/state?light=1` | `server.js` L995：`buildState({ light: ctx.query.get('light') === '1' })`；`buildState({light=false})` L357，`light` 分支 L973 只删 `result.decisions`，**保留 `scores`** | **需薄适配**：`light=1` 两端一致可直接用；`panel=1` 会被用户版静默忽略（见下） |
| `/api/state?panel=1` / `panel` 入参 | `lib/routes.js` L197-199 注释声称「面板要有自己独立的忽略名单 `settings.panelIgnoredModels`，要拿全量在役供给、不被 `ignoredModels` 先裁一刀」，故强制带 `panel=1` | `server.js` 全文件 **`panel` 只出现在 `lanPanel`/`panelTokenOk`/`panelCookie`**（L958/L1571/L6872/L7039 等，属局域网面板），**`/api/state` 的 handler 不读 `panel` 参数**；`buildState` 只接 `{light}` | **unavailable（不得按朋友假设实现）**：`panel=1` 被静默忽略；需 C 棒改为不带 `panel=1`，面板侧自己按用户版 `settings.ignoredModels` 语义呈现，或明确标不支持「面板独立名单」 |
| `settings.panelIgnoredModels` | `lib/client.js` L1454-1466、L4691，`src/parts/05-overview.js` L6-18，`src/parts/30-gateway.js` L80：读 `s.panelIgnoredModels`，写 `{panelIgnoredModels:list}`，不存在时退回 `{ignoredModels:list}` | 全仓 `grep -rn panelIgnoredModels $BASE/daemon $BASE/core $BASE/web` → **0 命中**；`PATCH /api/settings` 只处理 `ctx.body.ignoredModels`（L1553-1567，存身份键、`applyIgnoredModels`）等有限键 | **unavailable**：用户版无此字段，也无「面板独立名单」语义。C 棒**不得引入**该字段或改变全局 `ignoredModels` 作用域（方案明令禁止）。朋友客户端的 fallback 分支会写 `ignoredModels` → 路由级生效，须在 UI 明示或禁用 |
| `settings.dshFreeModels` / `applyDshSettings` | 朋友 README L35/L69/L188 声称免费模型接入开关写 `PATCH /api/settings`（daemon `applyDshSettings`） | `grep -rn "dshFreeModels\|applyDshSettings"` → **0 命中**；`PATCH /api/settings` 写入键穷举后无 DSH 相关键 | **unavailable**：朋友版业务假设，不得搬入 |
| `POST /api/ingest/usage` | `lib/ingest.js` L79：`daemonPost(port, '/api/ingest/usage', payload)`；payload = `{provider, model, inputTokens, outputTokens, cachedTokens, cacheCreationTokens, latencyMs, ttftMs, ok, ts}`；跳过 `provider === 'manage-api'`/前缀、只在 `attached`/`owned` 时发、无 input/output token 直接丢 | `grep -n "ingest/usage" $BASE/daemon/server.js` → **0 命中**；109 条路由里无此路由。用户版记账在 `core/usage.js#recordUsage`（`server.js` L6261/L6340/L6541），`GET /api/usage`(L3879)、`/api/usage/detail`(L3905)、`POST /api/usage/reset`(L4002) 为现有读/重置口 | **需新增(已授权)**：用户已明确授权新增向后兼容 usage ingest API。C 棒只增不改；须沿用 `recordUsage`/`usage.json` 口径、保留「网关已记一次 → 插件不再记」的双保险去重（朋友 `ingest.js` 已有跳过逻辑，daemon 侧需再兜一层），不改既有规则、隔离测试 |
| `/api/state` 响应含密钥 | `lib/routes.js#sanitizeState`（L99-120）剥 `gateway.keys[].key` 与 `providers[].adminToken`；`lib/write-proxy.js#summarizeWrite` 只回小字段 | `buildState` 的 `result.gateway.keys` **含明文 `key`**（L945-951）；`settings: db.settings` 原样下发（L689）；`providers` 带 `adminTokenTail`/`hasAdminToken`（L829-830） | **需薄适配**：C 棒必须做响应瘦身/脱敏，不可把 daemon 原始 state 原样送进渲染进程 |

> 用户版 `/api/state` 的 `light`：**已核实存在且语义为「删 decisions、留 scores」**；`panel`：**已核实不存在**。
> `panelIgnoredModels`：**已核实不存在**；`/api/ingest/usage`：**已核实不存在**。

---

## 1. 朋友版 Host/UI 读路径 → 用户版 daemon

朋友 Client 只经 `fetchJson('…')` → `apiUrl()`（`lib/client.js` L151-158）→ `/api/manage-api/<sub>`；Host `lib/routes.js` 前缀 `PREFIX='/api/manage-api'`（L24），用 `forwardToDaemon()`（L77）转发到 `127.0.0.1:<port>/api/...`。

| 朋友版调用 | 用户版 daemon 实际 | 结论 |
|---|---|---|
| `GET /api/health`（`lib/daemon.js#probeHealth` L33-35，探活/attach 判据） | `route('GET', /^\/api\/health$/)` L989 → `{ok:true, at}` | **可直接用** |
| `GET /api/state?light=1[&panel=1]`（`routes.js` L199） | L995 `GET /api/state`，读 `light`，忽略 `panel` | **需薄适配**（去 `panel=1`；见 §0） |
| `GET /api/state?panel=1`（`full=1`） | 同上，`panel` 忽略 → 返回的是**未经 light 裁剪**的全量 state（因无 `light=1`） | **需薄适配**：语义意外变成 full-state，须显式改成 `/api/state?light=1` 或明确 full 语义 |
| `GET /api/monitor?days=N`（`routes.js` L298） | `route('GET', /^\/api\/monitor$/)` L2676（`ctx.query` 取 days） | **可直接用** |
| `GET /api/providers/:id/groups[?credentialId=&fresh=1]`（`routes.js` L268-278，转发 `'/api/'+sub+search`） | `route('GET', /^\/api\/providers\/([\w-]+)\/groups$/)` L2091 | **可直接用** |
| `GET /api/state?light=1`（`tools.js` L60、`prompt.js` L54、`commands.js` L41，Host 内部直连） | L995 | **可直接用** |
| `GET /api/usage`、`/api/usage/detail`（用户版页面 / 用量视图） | L3879 / L3905 存在 | **可直接用**（字段以用户版为准） |
| `GET /v1/models`、OpenAI-compatible `/v1/chat/completions`（对外 API） | `server.js` L6638 `/v1/models`、L6716 注释列出代理路径 | **保留不动**（不做全局劫持） |
| `GET /api/manage-api/stream-stats`、`/prompt`、`/budget`、`/dsh-model`、`/dsh-catalog`（朋友 Host 自有路由） | 用户版 daemon **无这些路由**（它们是插件 Host 侧的，不转发到 daemon） | **需薄适配**：B/D 棒在插件 Host 侧重建；不属于 daemon 兼容问题 |
| `POST /api/manage-api/daemon/{start,stop,restart}`（`routes.js` L313-328） | 用户版 daemon 无此路由；由朋友 `lib/daemon.js` 的 attach/owned 管理器处理 | **需薄适配**：B 棒生命周期骨架自有能力，须区分 attach 与 owned、dispose 只停自己起的进程 |

---

## 2. 朋友版 `WRITE_RULES` → 用户版 daemon 路由（逐条）

`lib/write-proxy.js` 的 `WRITE_RULES` 共 **26 条**，`resolveWrite()` 默认拒绝、只认 `method + path` 全匹配、拒绝 `..`/`?`/`#`；`runWrite()` 用 `daemonSend()` 转发。
本棒用脚本把 26 条规则转出具体样例路径，逐条与用户版 109 条路由的正则做**功能性匹配**：**25/26 命中**，剩 1 条是 `决策排序` 的正则口径差异（见下）。

| # | 规则名 | method + path | 用户版路由 | 结论 |
|---|---|---|---|---|
| 1 | 新增站点 | `POST /api/providers` | L1677 | 可直接用 |
| 2 | 修改站点 | `PATCH /api/providers/:id` | L1720 | 可直接用 |
| 3 | 删除站点 | `DELETE /api/providers/:id` | L1727 | 可直接用 |
| 4 | 同步模型 | `POST /api/providers/:id/sync` | L1759 | 可直接用 |
| 5 | 识别系别 | `POST /api/providers/:id/detect-kind` | L1697 | 可直接用 |
| 6 | 查余额 | `POST /api/providers/:id/balance` | L2644 | 可直接用 |
| 7 | 查用量 | `POST /api/providers/:id/usage-check` | L2459 | 可直接用 |
| 8 | 账号登录 | `POST /api/providers/:id/login` | L1612 | 可直接用 |
| 9 | 新增 Key | `POST /api/credentials` | L1742 | 可直接用 |
| 10 | 删除 Key | `DELETE /api/credentials/:id` | L1752 | 可直接用 |
| 11 | 改设置 | `PATCH /api/settings` | L1345 | **需薄适配**：键集合不完全一致，见 §0/§3 |
| 12 | 跑探针 | `POST /api/probes/run` | L3235 | 可直接用 |
| 13 | 同步余额账单 | `POST /api/monitor/collect` | L2681 | 可直接用 |
| 14 | 告警标已读 | `POST /api/monitor/alerts/read` | L2688 | 可直接用 |
| 15 | 公告标已读 | `POST /api/monitor/announcements/read` | L2694 | 可直接用 |
| 16 | 改供给价格 | `PATCH /api/offers/:id` | L3281 | 可直接用 |
| 17 | 决策排序 | `PUT /api/decisions/:model/order` | L2815：`/^\/api\/decisions\/([^/]+)\/order$/` | **需薄适配**：朋友规则 `/^\/api\/decisions\/[\w.\/-]+\/order$/` 允许模型名带 `/`，用户版 daemon 只允许单段。朋友 Client L6976 用 `encodeURIComponent(decision.modelKey)`，斜杠会变 `%2F`，常规模型名实际能匹配；但含 `/` 且未编码的 key 会被 daemon 拒绝。C 棒须收敛为用户版正则或统一编码 |
| 18 | 刷新汇率 | `POST /api/fx/refresh` | L2666 | 可直接用（Client L5416 用 `fetchJson('write', …)` 直发，仍走同一白名单通道） |
| 19 | 网关开关 | `PATCH /api/gateway` | L4007 | 可直接用 |
| 20 | 应用分组 | `POST /api/providers/:id/apply-group` | L2163 | 可直接用 |
| 21 | 改分组倍率 | `POST /api/providers/:id/group-ratio` | L1927 | 可直接用 |
| 22 | 恢复站点倍率 | `POST /api/providers/:id/restore-ratio` | L2449 | 可直接用 |
| 23 | 识别分组 | `POST /api/providers/:id/detect-groups` | L2444 | 可直接用 |
| 24 | 复制供给 | `POST /api/offers/:id/duplicate` | L3385 | 可直接用 |
| 25 | 免费额度 | `POST /api/offers/:id/free-quota` | L3397 | 可直接用 |
| 26 | 站点排序 | `POST /api/providers/reorder` | L1734 | 可直接用 |

> 注意：朋友规则 `POST /api/providers/:id/...` 用的是 `[\w-]+`；用户版 daemon 用 `([\w-]+)` 捕获组，语义一致。
> 用户版 daemon 还有 83 条路由未在朋友白名单内（含 `gateway/keys`、`free/*`、`benchmarks/*`、`export/*`、`diagnosis/*` 等）。**默认拒绝**是正确边界：C 棒不得做通用反代；要新增必须逐条白名单 + 单独决定。

---

## 3. 朋友版 README 声称「✅ 全接通」的写功能 → 实现代码实查（验收点 2 硬项）

朋友 `README.md` L26-41 用 ✅ 宣称：站点/Key 管理、比价改价、**基准价全量写（L30）**、**免费池 14 条路由全接通（L31）**、忽略模型、模型接入、用量回写等；L188 的 0.11.0 changelog 更称「写白名单 +24 条：基准价 PUT/DELETE + 三导入、免费平台与账号全套」。

**实查结论：以 `lib/write-proxy.js` 的 `WRITE_RULES`（26 条）+ `lib/client.js` 的实际发送路径为准，README 的 ✅ 不成立。**
`lib/client.js` 的 `writeOp(method, path, payload)`（L262）**统一 POST 到 `fetchJson('write', …)`**（L263），Host `routes.js` L376-400 交给 `runWrite()` → `resolveWrite()`；**没有任何绕开白名单的旁路**（`lib/http.js#checkLocalOrigin` 只做 loopback/CSRF 防护，不放行写路径）。

### 3.1 客户端会发、但被 `WRITE_RULES` 拒绝（403）的按钮

| 朋友 Client 行 | method + 实际路径 | 用户版 daemon 有此路由？ | 白名单？ | 结论 |
|---|---|---|---|---|
| L4159 | `POST /api/free/platforms/:id/connect/poll` | 有 L3539 | ❌ | **unavailable**（朋友版按钮实际写不通） |
| L4176 | `POST /api/free/platforms/:id/connect` | 有 L3526 | ❌ | **unavailable** |
| L4209 | `POST /api/free/platforms/:id/refresh` | 有 L3587 | ❌ | **unavailable** |
| L4226 | `POST /api/free/platforms/:id/diagnose` | 有 L3631 | ❌ | **unavailable** |
| L4252 | `POST /api/free/accounts/:id/checkin` | 有 L3441 | ❌ | **unavailable** |
| L4266 | `DELETE /api/free/platforms/:id` | 有 L3411 | ❌ | **unavailable** |
| L4275 | `DELETE /api/free/accounts/:id` | 有 L3436 | ❌ | **unavailable** |
| L4284 / L4298 | `POST /api/free/platforms` | 有 L3405 | ❌ | **unavailable** |
| L4303 | `POST /api/free/accounts` | 有 L3416 | ❌ | **unavailable** |
| L5280 | `PUT /api/benchmarks` | 有 L3645 | ❌ | **unavailable** |
| L5296 | `DELETE /api/benchmarks/:key` | 有 L3652 | ❌ | **unavailable** |
| L5315-5317 | `POST /api/benchmarks/{seed\|import\|import-plaza}`（变量 `path`） | 有 L3665 / L3657 / L3676 | ❌ | **unavailable**（三种导入全被拒） |
| L516 | `POST /api/manage-api/daemon/{start\|stop\|restart}`（经 writeOp 误入写通道） | 用户版 daemon 无此路由；`routes.js` L313 另有专门 handler | ❌ | **需薄适配**：朋友 Client 把 daemon 生命周期动作塞进白名单写代理，必然 403；应由 B 棒生命周期接口 + Host 自有路由承接，不改 daemon |

> 合计 **14 个不同的 `method + path` 调用被白名单拒绝**：免费池 9 个（L4159/4176/4209/4226/4252/4266/4275/4284·4298/4303）+ 基准价 5 个（`PUT` L5280、`DELETE` L5296、三种导入 L5317×3）；上表把 `POST /api/free/platforms` 两处与三种导入各自合并，故只显示 12 行。另有 1 个路由归属错误的生命周期动作（L516）。
> 另有 `L691` `POST /api/providers/<provider.id>/sync`、`L3025` `POST /api/providers/:id`+后缀（`actPost` 拼接）、`L3097` `DELETE /api/credentials/:id`、`L3153` `DELETE /api/providers/:id` 均在白名单内；早期脚本按字面量替换/正则贪婪匹配时误显示成未匹配，已逐行读源码确认，不计入上表。

### 3.2 README 与代码的其它落差

| README 声称 | 实现实查 | 结论 |
|---|---|---|
| L30「基准价全量写 ✅」 | `PUT/DELETE /api/benchmarks*` + 三导入**全部不在** `WRITE_RULES`；`lib/routes.js` 也无专门 benchmark 转发分支（`grep free\|benchmark` 无命中） | **不可直接信**：按钮会 403 |
| L31「免费池 14 条路由全接通 ✅」 | 9 条写路径全被拒；用户版 daemon 侧这些路由**确实存在**（L3405-3631 共 14 条），缺口只在朋友白名单 | **需薄适配**：C 棒若用户确认要保留免费池写功能，须逐条补白名单（属新增写权限，须单独决定，不是自动继承） |
| L33「忽略模型写 `ignoredModels` ✅」 | `PATCH /api/settings` 在白名单内且用户版支持；但朋友 Client L1463-1466 优先写 `panelIgnoredModels`，用户版无此键 → 会走 fallback 写 `ignoredModels`（**路由级**生效，会影响网页版与网关） | **需薄适配**：须明确告知「面板点忽略 = 全局路由忽略」，或禁用该按钮；不得悄悄引入 `panelIgnoredModels` |
| L34「模型接入写 DSH provider ✅」 | 走 Host `POST /api/manage-api/dsh-model`（非 daemon 写），依赖 `configEditor` + `agentDefaultModel`；本机 DSH 两服务已核实存在 | **可直接用（DSH 侧）**，但**未授权**改 profile/preset/真默认模型；F 棒不得实测安装/激活 |
| L41「真实流量回写 ✅ `POST /api/ingest/usage`」 | 朋友 Host 会发；用户版 daemon **无此路由** | **需新增(已授权)**，见 §0 |
| L36「模型选择器刷新 `llm/adapters-updated` + catalog.refresh」 | 本机 DSH `dsh-llm/README.md` 记载 `llm/models-updated(provider)` 事件；朋友自造 `llm/adapters-updated` 与 Client `ctx.modelDirectories.catalog.refresh()` | **未核实**：本机契约只核到 `llm/models-updated(provider)`；朋友的事件名/Client 服务名**不得照搬**，D 棒须按本机实际重查 |

---

## 4. DSH Host 能力 → 本机 DSH 契约（静态核验）

| 朋友版用的接口（`lib/index.js` 等） | 本机 DSH 实际 | 结论 |
|---|---|---|
| `export function apply(ctx, rawConfig)` + `ctx.effect` / `ctx.inject` / `ctx.get(name,false)` / `ctx.provide` | `references/host-plugin.md` 明确允许 `apply(ctx, config)`；`practices.md` 要求 `ctx.effect`/`ctx.on` 成对 dispose、可选服务用 `inject` | 可直接用 |
| `ctx.on('llm/stream', async function* (options, next){ for await (const c of next()) yield c })`（L205） | `dsh-llm/lib/index.js` L2402：`this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(...))`；`practices.md`：不拥有决策的 waterfall listener 必须 `next()` 并原样续流 | 可直接用（tee 语义符合；**不得**在热路径等 IO/改流） |
| `tools.register(defineTool(...))`（`tools.js` L231 等）、`tools.guard(...)`（`index.js` L285） | `dsh-tools`：`register(def,{when})`、`restrict(filter)`、`guard()`（同步）、`execute()`；`practices.md`：budget guard 只是工具级，**不等于阻止模型请求** | 可直接用（文案须如实） |
| `commands.register({name,description,input,handler})`（`commands.js` L139） | `dsh-commands` `lib/index.js` L266 `register()`；README 明确 descriptor | 可直接用 |
| `systemPrompt.context({name,order,required,interpolate,text})`（`prompt.js` L97-98） | `dsh-system-prompt/lib/index.js` L279 `context()`、L253 `section()`；朋友用 `context()` 给「当前运行时事实」符合 `practices.md` | 可直接用 |
| `configEditor.configuration()` / `edit(entry, change)` + `agentDefaultModel.currentSelection()` / `saveSelection()`（`dsh-models.js` L105/L123/L215-291） | `dsh-config-editor/lib/index.js` L30/L39/L69；`dsh-agent-default-model/lib/index.js` L38/L53；README：**无 configEditor 时 `saveSelection()` 是 no-op** | 可直接用（**须用户显式操作**；未授权改真默认模型/profile） |
| `ctx.provide('manageApi', …)` | 本机 `host-plugin.md`：Service class 或 `apply` + `ctx.provide` 属 Cordis 常规；实时 Inspect 未核到该服务 schema | **未核实**（仅接口级） |
| 包级 `dsh.bundle.patch` + `dsh.client` 清单 | 已核实见 `decision-record.md` §3.1；朋友 `package.json` 正是此形态 | 形态可用，但**是否采用仍未由用户拍板** |
| Client slots：`'main'`、`'sidebar.panellist'`、`'settings.section'`、`'conversation.chat.assistant-actions'`（`client.js` L8484-8503）；`slots.inject` / `slots.register` | **未验证，原因：Client Inspect 超时/不可用**（planner 本轮 `Slots.listSubTree`/`Theme.listTokens` 10s 超时；本棒 ≤10s 重试仍无 provider，GUI 401/404） | **unavailable（证据级）**：不得猜槽位名、不得宣称可挂载；E 棒须等 live Client 查询实际 slot/options/props/theme token 后才能定 |

---

## 5. 边界与未验证（如实）

- **未跑任何 daemon**：4319 未运行、未启动、未接管；health/读写闭环/数据刷新/模型接入均无运行时证据。
- **未验证 live Client**：slot subtree、registration options/props、Theme tokens、视觉、locale、浅深主题、窄屏、console、网络请求状态，全部未验证。
- **未装插件 / 未改 profile**：`cordis.patch.yml`（profile 与包级都没写）、preset、工具集、DSH 本体、`~/.dee-pi-harness/`、`~/.manage-api`、四个现有 worktree 一律未动。
- **未跑迁移 / 未 commit / push / 删除 / 归档**。
- 本矩阵的数字（109 条路由、26 条规则、25/26 命中、14 个被拒 `method+path` 调用）来自本轮实跑的 `grep` + `node` 静态比对脚本，退出码 0；属**静态检查，不是运行时验证**。
- 「需新增(已授权)」只适用于 `POST /api/ingest/usage` 一项，且须只增不改、隔离测试（临时数据目录 + 随机端口 + 假上游，不碰 4319 与 `~/.manage-api`）。
- 任何未列入白名单的写操作 → **unavailable**，不得前端静默伪造成功。

---

## 6. 交给 C / D / E 的确定契约

- **C（API 适配）**：用户版 109 条路由清单与正则以 `$BASE/daemon/server.js` 为准；26 条朋友写规则 25 条直接对得上、`决策排序` 需收敛正则；`panel=1`/`panelIgnoredModels`/`dshFreeModels`/`applyDshSettings` 用户版不存在，一律不得引入或改全局忽略语义；`/api/state` 响应须剥离 `gateway.keys[].key`、`providers[].adminToken` 等；`POST /api/ingest/usage` 已授权新增；免费池/基准价写功能若要保留须**逐条单独决定**补白名单，不能照 README ✅ 继承。
- **D（Host 接入）**：`llm/stream` 是 waterfall 且必须 `next()`；`tools`/`commands`/`systemPrompt`/`configEditor`/`agentDefaultModel` 按 §4 实测签名；可选服务软注入；budget guard 文案不得写成「阻止模型请求」；朋友自造 `llm/adapters-updated` / `ctx.modelDirectories` 未核实，须按本机契约重查。
- **E（Client UI）**：slot 名称、props、theme token **未验证**，朋友硬编码的 4 个 slot 只是候选；未拿到 live Inspect 前只能做静态部分，不得声称挂载/视觉完成；页面须覆盖用户版 `TABS` 10 项 + 隐藏 `free`，按钮只能调 C/D 契约内接口。
