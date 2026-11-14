# A 棒 · 决策封板记录（DSH 插件化改造）

> **$BASE（本棒选定、B–F 棒沿用）= `/Users/sakura/个人收藏/Agent Storage/ManageAPI/manage-api-dsh-pluginize-20261110`**
> 新建专用 worktree；分支 `dsh-pluginize-20261110`；HEAD `ecf55d16e9603bfb771baa8dbd05fb588022a87a`；建立前 `git status --short` 干净。
> 不是现有四个 worktree（`ManageAPI/`、`manage-api-auto-sync/`、`manage-api-simple/`、`manage-api-ui-polish/`）中的任何一个，四个均未改动。
> `release-0.2.1` 已被 `ManageAPI/` worktree 占用，故用**新分支名**而非抢占已有分支，从用户确认的 commit 建立。

本文件只封板决策与证据，不含实现。逐 endpoint / 字段的映射见同目录 `compat-matrix.md`。
证据口径：**以实现代码与本机 DSH 安装包文件为准，README 的 ✅ 不视为证据**；静态/只读核验不等于运行时验证。

---

## 1. 用户已拍板的决定（封板，不得翻转）

| 项 | 封板内容 | 依据 |
|---|---|---|
| 朋友仓库 URL | 用户手填 `https://github.com/ZYH1207/dsh-manage-api` | 编排方 ask_user_question 收齐的用户原话；未指定分支/commit |
| 朋友 ref | 按该仓库 `main` @ `509c4bb78872a88c45e70f9dd96b09905202ab06` 记录；`release-v1.0.0` 同 commit | 本轮 `git ls-remote` 复核：`HEAD`/`refs/heads/main`/`refs/heads/release-v1.0.0` 均为 `509c4bb…`；只读快照 `recon/friend-dsh-manage-api-main` 的 `HEAD`=`main`=`509c4bb…`，与之相符 |
| **必须保留的事实** | 用户最初给的 `https://github.com/ZYH1207/dsh-manage-apio` **打不开**：`git ls-remote …dsh-manage-apio.git` 返回 `remote: Repository not found.` / `fatal: repository … not found`；`curl -sS -m 10 -o /dev/null -w %{http_code}` 返回 **HTTP 404** | 本轮实跑复核；不得隐去、不得静默改成别的仓库。用户手填的是 `dsh-manage-api`，本记录如实区分「原 URL 打不开」与「用户手填的 URL」 |
| 业务基线 | `/Users/sakura/个人收藏/Agent Storage/ManageAPI/ManageAPI/` @ `release-0.2.1` (`ecf55d1`) | 唯一业务事实源；`git rev-parse HEAD` 复核一致；根清单 `manage-api@0.3.0`，`"type":"module"`，`engines.node>=20`，零第三方运行依赖、无构建步骤 |
| 移植边界 | 朋友版本**只移植 UI 视觉/交互与 DSH 接入能力**，不整体搬业务 | 用户拍板；业务数据/评分/路由/daemon 语义一律以用户版为准 |
| 插件形态 | **项目内独立子包**（用户选「推荐」项） | 插件依赖与构建须隔离；不破坏现有零依赖 CLI/daemon 启动方式；**不得改用户根 `package.json`** |
| ✅ 已授权 | 允许**新增向后兼容的 usage ingest daemon API**（朋友版依赖 `POST /api/ingest/usage`，用户版当前无此路由） | 用户明确授权；实现须只增不改既有规则，且须隔离测试 |
| ❌ 未授权 | **disposable DSH profile 安装/激活** —— 后续 F 棒只能做静态/隔离测试；任何 profile 安装、profile `cordis.patch.yml` 改动、preset/工具集/DSH 本体改动都不得做 | 用户未授权，**须另问用户**才能解冻；本棒及 B–F 均不得触碰 |

> 远端另有 `refs/heads/archive/ia-phase3` @ `3830a652…` 与 tag `ia-phase3-0.10.0`；不作为本次朋友 ref。
> 远端 `ZYH1207/ManageAPI.git` 的 `main` 与用户本地基线不同，不覆盖用户本地版本。

---

## 2. 仍未由用户拍板（不许自行定案）

方案 5.1 第 3 题剩余细节，**全部未定案**：

1. 插件包具体包名
2. `$PLUGIN_ROOT` 确切路径
3. Host 入口文件名
4. Web Client 入口 / 产物路径
5. 是否采用包级 `dsh.bundle.patch` + `cordis.patch.yml` + `dsh.client` 这套清单形态

> **状态：建议，待用户确认；B 棒启动前须经编排方回收确认。**
> 本节下面只给「1 个带理由的建议方案 + 备选项」，**不是决定**，B 棒不得据此直接命名/建包。
> 未决项不构成本棒 blocked：两份文档已封板已定案部分并如实标注未决项。

### 2.1 建议方案（1 个，带理由）

基于本机 DSH `0.2.2-alpha.2` 的真实契约（证据见 §3）：

| 项 | 建议值 | 理由 |
|---|---|---|
| `$PLUGIN_ROOT` | `$BASE/dsh-plugin/`（项目内独立子目录） | 满足「项目内独立子包」拍板；与根 `daemon/`、`core/`、`web/`、`package.json` 物理隔离，B–E 各棒文件不落到业务树 |
| 包名 | `@local/dsh-manage-api`（`private: true`） | 避免与朋友 npm 包 `dsh-manage-api` 及用户根 `manage-api` 重名；`@local/*` 与本机 DSH 模板 `templates/decoration/package.json` 的 `@local/my-plugin` 命名习惯一致。**仅为建议** |
| Host 入口 | `$PLUGIN_ROOT/index.js`，导出 `export function apply(ctx, config) {}`（可附 `export const inject`、`export const Config`） | 本机 `references/host-plugin.md` 明确列出的两种合法导出形式之一；朋友 `lib/index.js` 正是 `apply(ctx, rawConfig)`，移植成本最低；所有资源在 `apply` 内用 `ctx.effect` / `ctx.on` 注册并返回 cleanup |
| Web Client 入口 / 产物 | `$PLUGIN_ROOT/client.js`，经 `exports["./client"]` 暴露；手写/自足产物，**不引入根项目构建步骤** | 本机 `dsh-client-modules` 要求激活前 `./client` 产物必须存在；朋友包用 `exports: {"./client": "./lib/client.js"}` 且 `lib/client.js` 是手写 CJS 风格 bundle，证明「手写产物 + 无根构建」可行；React 走 Host 共享模块表，不重复打包、不用 CDN |
| 清单形态 | **采用**包级 `dsh.bundle.patch`（指向包内 `cordis.patch.yml`）+ 包内 `cordis.patch.yml` + `dsh.client`（`platform:"web"`、`immediately:true`、`inject:[]`） | 这是本机 DSH 唯一已核实的「可被识别为插件包」的清单形态（`dsh-app-boot` + `host-plugin.md` + `client-modules` 三方一致）；朋友包 `package.json` 亦为此形态；包级 patch 与 profile 的 `cordis.patch.yml` 是**不同层**，采用包级 patch **不等于**授权改 profile patch（后者仍未授权） |
| 依赖/构建隔离 | 子包自带 `package.json`、`node_modules`（如需）、`files`、`locale/`、`icon.svg`；根 `package.json` 一字不改 | 直接兑现「不破坏现有零依赖 CLI/daemon」 |

**理由汇总**：① 唯一与本机 DSH 版本对得上的装配方式；② 与朋友已验证可跑的清单形状同构，移植风险最小；③ 子包自带清单 → 根零依赖启动方式不受影响；④ `apply()` 与朋友生命周期代码一致；⑤ 手写 client 产物避免把构建工具链塞进用户根。

### 2.2 备选项（供编排方回收确认时选用，均非定案）

- **B1（布局变体）**：沿用朋友布局，`Host=lib/index.js`、`Client=lib/client.js`、`exports["./client"]="./lib/client.js"`。适合希望与朋友包 1:1 对照时；代价是子包多一层 `lib/`。
- **B2（Host 导出变体）**：改用 `default export` Service class（`host-plugin.md` 允许的另一种形式）。代价是要重写朋友的 `ctx.effect`/`ctx.inject` 生命周期代码，**不推荐**。
- **B3（构建变体）**：Client 用 tsdown 等编译产物 + `dsh.client.external` 声明非基线模块。代价是子包内要引入构建工具与依赖，更重；仅当 UI 必须编译源码时考虑。
- **B4（形态变体）**：单包形态（用户项目根成为 DSH 包）。**已被用户拍板排除**（选了独立子包），且需要改根 `package.json`，本任务禁止。
- **B5（清单变体）**：不采用包级 bundle patch、改走别的装配方式。本机当前契约下**未核实存在**其他受支持形态，若用户坚持，须先另行核验再定，B 棒不得自行假设。

> **重要边界**：`cordis.patch.yml`（无论 profile 级还是包级）在本 A 棒**一律不写**；此处只记录「建议 B 棒在用户确认后创建包级文件」。profile 级 `cordis.patch.yml` 的改动属未授权项。

---

## 3. DSH 契约证据（本机 `/Applications/Deep Pi.app/Contents/Resources/app/dsh/`，只读）

安装版本：`@deepseek-ai/dsh-desktop-runtime@0.2.2-alpha.2`（`package.json` 实读）。

### 3.1 已核实（实现代码 / 随附文档）

| 契约 | 真实形态 | 证据 |
|---|---|---|
| 包级 `dsh.bundle.patch` | `package.json` 的 `dsh.bundle.patch` 指向包内 YAML（可为单文件或有序文件列表）；`dsh.bundle.platforms` 可选 | `dsh-app-boot/README.md`：「A bundle's `dsh.bundle.patch` names one patch file or an ordered list of files」；`references/host-plugin.md`：「A bundle is a package whose `package.json` declares `dsh.bundle.patch`」；模板 `templates/decoration/package.json` 实写 `"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}` |
| patch 方言 / 层次 | YAML `- insert: - id: … / name: … / config: …`；**匹配行的 `config` 是整块替换，不是字段合并**；包级 bundle layer 与 profile 的 `cordis.patch.yml`（用户 tweak 层，最后应用）是**不同层** | `host-plugin.md`；`dsh-app-boot/README.md` §63；`dsh-sdk-minimal/cordis.patch.yml`；朋友 `cordis.patch.yml` |
| `dsh.client` | `platform` 必须为字符串（`web`）；`inject`、`external` 为字符串数组；`immediately` 为布尔；包须 `exports["./client"]`；**激活前产物必须已存在**，缺失会「fails activation loudly」 | `dsh-client-modules/lib/index.js` 校验代码（`optionalStringArray`、类型断言）；`README.md`（Declaring a client plugin / Build requirements）；`ui-plugin.md` |
| Client 运行时 | 浏览器经 `__DSH_BOOT__` boot graph 懒加载；执行 bundle 只注册 factory，副作用在 materialization；React 来自 Host 冻结的共享模块表；不得重复打包 React / CDN / 第二 app root；样式继承 Host theme；文案走 Client locale | `dsh-client-modules/README.md`；`references/ui-plugin.md` |
| Host 导出形式 | 二选一、不可混用：① `export function apply(ctx, config) {}`（可附 `export const inject`、`export const Config`）；② `default export` Service class。资源在 `apply` 内用 `ctx.effect`/`ctx.on` 注册并返回 cleanup | `references/host-plugin.md` §Host plugin export forms |
| `configEditor` | `entries()`、`configuration()`、`async edit(entry, change)`；写的是**活动 profile 的 patch**，写前校验完整候选；无 config editor 时相关写入不落盘 | `dsh-config-editor/lib/index.js`（方法实读）、`README.md` |
| `agentDefaultModel` | `currentSelection()` → 分离的 `{provider, model, reasoningEffort?}`；`saveSelection({provider, model, reasoningEffort})`；**无 configEditor 时 `saveSelection()` 是 no-op**；不校验目录成员 | `dsh-agent-default-model/lib/index.js`、`README.md` |
| `tools` | `defineTool({name, description, parameters, output, execute})`；`ctx.tools.register(def, {when})`、`restrict(filter)`（需 scoped context，否则抛错）、`guard(guard)`（同步）、`execute()`；注册即进入 prompt schema | `dsh-tools/README.md`、`dsh-tools/lib/types/index.js` |
| `commands` | `ctx.commands.register({name, description, input?, handler})`；handler 返回 `{kind:'success'|'error', text}`；同名同 scope 重复注册抛错 | `dsh-commands/README.md`、`lib/index.js`（`register()` 实读） |
| `systemPrompt` | `ctx.systemPrompt.section({name, order, text})`、`context({...})`、`variable()`、`getSectionOrder()`、`suppressRuntimeContext()`；`practices.md`：加提示文本用 `section()`，运行时事实用 context/per-agent `agent.inject()` | `dsh-system-prompt/lib/index.js`、`README.md`；`references/practices.md` |
| `llm/stream` | **waterfall**：`dsh-llm/lib/index.js` 实写 `this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))`；不拥有决策的 listener **必须 `next()` 并原样续流** | `dsh-llm/lib/index.js`；`references/practices.md` §Stability |
| 可选服务软依赖 | `ctx.get(name, false)` / `inject` / `ctx.inject([...], …)`；缺服务不应使整个插件崩溃 | `references/practices.md`；朋友 `lib/index.js` 已按此写 |

### 3.2 未核实（不得当作事实使用）

- **Client 实时 Slot / Theme：`未验证，原因：Client Inspect 超时/不可用`**。planner 本轮 `Slots.listSubTree` / `Theme.listTokens` 均 10 秒超时；本棒两次有界（≤10s）重试也未取到：本会话只有 7 个工具，**没有 `cordis_inspect_query` 等 Client Inspect provider**；GUI `http://127.0.0.1:56456/` 与 `http://127.0.0.1:61874/` 的 `/`、`/api/cordis-inspect`、`/api/inspect`、`/api/plugins` 等试探返回 **401/404**。`dsh --help` 无 inspect 子命令。
  - 因此：**不猜槽位名、不宣称 UI 可挂载、不判 blocked**。
  - 朋友 `lib/client.js` 硬编码注册 `'main'`、`'sidebar.panellist'`、`'settings.section'`、`'conversation.chat.assistant-actions'`（经 `slots.inject`/`slots.register`）——这些只是**朋友包的假设**，本机 DSH 当前 Host 是否存在、其 registration options / props、theme token 清单，均**未验证**。方案 5.1 提到的 slot 名称同样不得当已验证事实。
- `Config.listConfigs` 的实际 schema、`Tools`/`Service`/`Event` 的实时目录、真实 Service 实例的方法签名细节：只核到随附 lib/README，未做 live Inspect。
- daemon 运行时行为：**4319 未运行、未启动、未接管真实实例**；health、代理读写闭环、数据刷新、模型接入均未实测。
- Host 激活 / 插件安装 / 视觉呈现 / 浅深主题 / locale / 窄屏：**未验证**（且 profile 安装未授权）。

> 静态/接口级核验 ≠ 运行时验证。本记录不声称任何东西「跑通了」。

---

## 4. 要保留的 UI / DSH 能力清单

### 4.1 移植（来自朋友版，仅视觉/交互与 DSH 接入）

- **UI 资产**：React 客户端面板、独立主题 CSS（`.ma-root` 作用域 + Host theme token）、中英 locale、左侧主面板与设置分区、卡片/图表/站点卡视觉语言。朋友 `src/parts/` 实为 **9 个文件**：`05-overview`、`10-monitor`、`20-free`、`30-gateway`、`40-benchmark`、`50-pricing`、`60-decision`、`70-probes`、`80-usage`（方案 1.1 列举了其中 8 个视图名，此处以 `ls` 实读为准）。
- **交互**：页内导航、站点卡、比价改价、决策排序、监控趋势、用量/成本 chip、帮助面板等呈现与交互模式。
- **DSH 接入能力**：daemon attach/owned 生命周期（卸载只停自己起的进程）、同源最小只读代理 + 白名单写通道、`llm/stream` 用量 tee、用量回写、tools / commands / system prompt context、预算 guard（**仅工具级，不等于阻止模型请求**）、模型接入（`configEditor` + `agentDefaultModel`）、DSH config 写入。
- **约束**：不用 iframe、不改 Host Web shell、不加第二个 app root、不读别的插件 DOM、不复制朋友业务判断替代用户版、不改用户现有 `web/` 行为。

### 4.2 保留（用户版，不得退化）

- 用户 `web/app.js` 的 `TABS = ['overview','monitor','route','decision','probes','protocol','gateway','usage','benchmark','diagnosis']` 及隐藏 `HIDDEN_TABS = ['free']`：**不因朋友版页面较少而删页或退化**。
- 用户版 `core/` 的定价/评分/路由/过滤逻辑、`daemon/server.js` 的 109 条既有路由语义、`db.json` 数据格式与单写者约束、OpenAI-compatible `/v1` 对外 API：一律原样。
- 现有零依赖 CLI/daemon 启动方式（`npm start` → `node daemon/index.js`）、根 `package.json`、真实数据目录 `~/.manage-api`：不动。

### 4.3 明确不做

- 不整体搬朋友仓库、不引入 `panelIgnoredModels` / `dshFreeModels` / `applyDshSettings` 等朋友 daemon 假设（用户版全仓搜索无命中，见矩阵）。
- 不做全局请求劫持（旧 `docs/dsh-plugin-plan.md` 的 `agent/request-error` 方案不作依据）。
- 不从插件进程直接写数据文件；daemon 不可用时显示 degraded/offline。
- 不改 DSH profile / preset / 内置工具集 / DSH 本体 / 用户默认模型（隐式）。

---

## 5. 授权边界速查（交给 B–F）

| 动作 | 状态 |
|---|---|
| 在 `$BASE` 内写插件子包源码、`package.json`、`files`/locale/icon | 允许（B–E 各按独占清单），但**命名/清单细节须先回收用户确认** |
| 改用户根 `package.json` / `daemon/`(既有规则) / `core/` / `web/` | 禁止 |
| 新增向后兼容的 `POST /api/ingest/usage`（只增、隔离测试） | ✅ 已授权（C 棒） |
| 改既有路由语义、加 `panelIgnoredModels`、改全局 ignored 作用域 | 禁止 |
| 写 profile 级 `cordis.patch.yml`、profile 安装/激活、preset/工具集/DSH 本体改动 | ❌ 未授权，须另问用户（F 棒只能静态/隔离测试） |
| git commit / push / 删除 / 归档 / 数据迁移 / 启动或接管真实 4319 / 访问 `~/.manage-api` | 禁止 |
| 宣称 UI 已挂载 / 视觉已验收 / 运行时已验证 | 禁止（当前无 live Client、daemon 未运行） |

---

## 6. 交给 B 棒的确定接口与冻结项

- **确定（本棒封板，B 可直接依赖）**：`$BASE` 绝对路径（本文件顶部）；业务基线 = `ManageAPI/` `release-0.2.1` @ `ecf55d1`；朋友 ref = `https://github.com/ZYH1207/dsh-manage-api` `main` @ `509c4bb…`（只读快照已存在）；「原 `dsh-manage-apio` 404」事实；插件形态 = 项目内独立子包、根 `package.json` 不动；usage ingest API 已授权新增；profile 安装/激活未授权；DSH 契约 §3.1；compat-matrix 的业务 API 事实。
- **冻结（B 棒启动前须编排方回收用户确认后才解冻）**：§2 的 5 项（包名、`$PLUGIN_ROOT`、Host 入口、Client 入口/产物、是否采用包级 `dsh.bundle.patch`+`cordis.patch.yml`+`dsh.client`）。§2.1/2.2 只是建议与备选，B 棒**不得自行命名或重选**。
- **B 棒不得开始于本棒**：本棒只交付两份文档；未开始 B、C、D、E、F 任何实现。

---

## 7. 本棒验证边界

- 所有证据来自只读文件核验、`git ls-remote`（10s 上限）、`curl`（10s 上限）、`grep`/`node` 静态比对；**未启动任何 daemon、未装插件、未改 profile、未跑数据迁移**。
- 文档验收命令及退出码见 `runs/dsh-pluginize-20261110/n2-a-report.md`。
- daemon 4319 未运行；Client 未在线；无运行时证据。
