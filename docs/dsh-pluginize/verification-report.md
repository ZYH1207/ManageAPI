# DSH 插件化改造 · F 棒验证与交接报告

- **$BASE**：`/Users/sakura/个人收藏/Agent Storage/ManageAPI/manage-api-dsh-pluginize-20261110`
- **$PLUGIN_ROOT**：`$BASE/dsh-plugin/`
- **分支 / HEAD**：`dsh-pluginize-20261110` @ `ecf55d16e9603bfb771baa8dbd05fb588022a87a`
- 报告日期：2026-11-10 · 作者：F 棒（隔离验收、部署门与交接）

## 0. 结论速览

- **`node dsh-plugin/.test/check-release.mjs` 退出码 0**（默认门 22/22 项通过）；`--with-daemon` 深跑 24/24（其中深层真实 daemon 子进程回归 27/27 通过）。
- **`git diff --check` 退出码 0**；`git status --short` 未见 F 棒以外的越界改动（F 棒仅新增 `dsh-plugin/.test/check-release.mjs` 与本报告）。
- **交付判定：`ready`（只到静态 + 隔离验收）**。
- **明确未验证**：DSH profile 安装/激活（**用户未授权，本棒不做**）、live DSH Host 激活、Client slot 挂载与浏览器视觉、真实 daemon 4319 运行时行为。daemon 4319 本轮未运行。

---

## 1. 本棒交付物（F 棒独占）

| 文件 | 作用 |
|---|---|
| `dsh-plugin/.test/check-release.mjs` | 全量隔离验收入口（release gate）：串行执行 B–E 阶段检查、入口语法、可打包性/文件齐备、原有业务基础测试的隔离回归；自带临时 HOME/MANAGE_API_HOME 隔离与自清理。 |
| `manage-api-dsh-pluginize-20261110/docs/dsh-pluginize/verification-report.md` | 本报告。 |

F 棒**未改** B–E 任何源码、根/子包 `package.json`、`cordis.patch.yml`、用户 `daemon`/`core`/`web`、DSH 安装目录、profile 或真实数据目录。

---

## 2. 隔离环境与安全边界（本棒实跑）

- `check-release.mjs` 每次运行新建临时根 `mkdtempSync(tmpdir(), 'dsh-release-')`，把子进程 `HOME`、`MANAGE_API_HOME` 指向其下 `home/`、`home/.manage-api/`，并**断言**二者既不是真实 `homedir()`、也不是真实 `~/.manage-api`、且必须落在临时根内；结束时 `rmSync` 清理。
- 未连接、未启动、未接管真实 daemon 4319；未读写真实 `~/.manage-api`；未运行 DB migration；未安装/激活任何 profile；未派子 agent。
- 深层 daemon 子进程回归只用各用例自建的临时 `MANAGE_API_HOME` + `freePort()` 随机回环端口（已核对 `check-route-target-forward`/`check-stream-reliability`/`check-probe-pause` 均为 `freePort()` 且断言非 4319）。

---

## 3. 分层证据（实际命令 + 退出码 + 通过项）

### 3.1 逐阶段检查（check-release 的 [1] 段，串行；退出码均 0）

| 命令 | 退出码 | 实际通过项 |
|---|---|---|
| `node dsh-plugin/.test/check-manifest.mjs`（B） | 0 | 20 组断言：清单字段 / 零第三方依赖 / `dsh.bundle.patch` / `dsh.client` 形状 / patch YAML 解析 / config 整块替换 / 入口导出 / daemon ownership 判定 / 默认零进程零网络 |
| `node .test/check-dsh-plugin-api.mjs`（C） | 0 | 29 组断言：新增 1 条 ingest 路由（基线 109→110）且 git diff 仅 + 行 / 6 条只读 ROUTES / sanitize 脱敏 / 路径与 query 校验 / 默认拒 loopback 之外 / 26 条 WRITE_RULES 命中真实正则 / 默认拒绝分支 / ingest 契约与去重 |
| `node dsh-plugin/.test/check-dsh-host.mjs`（D） | 0 | 13 组断言：tools(3)/commands(1)/prompt(1)/guard(1)/stream(1) 注册 / `llm/stream` 逐块 `next()` 续流 / ingest 跳过 manage-api 前缀 / budget 守卫文案 / 缺服务软降级 / disposer 释放与幂等 |
| `node dsh-plugin/.test/check-client-contract.mjs`（E） | 0 | 21 项：client 语法+自足导出 / 假 ctx 在 3 slot 注册且返回 dispose / 无 slots 软降级 / exports 与 `dsh.client` / locale en·zh 键一致且与内联 MESSAGES 一致 / THEME_CSS 全 `.ma-root` 作用域 / API 命中 C 的 ROUTES 与 WRITE_ACTIONS / 不用 panel 参数 |

### 3.2 入口语法（[2] 段，`node --check`，全部 ok）

`index.js`、`client.js`、`lib/runtime.js`、`lib/daemon.js`、`lib/routes.js`、`lib/http.js`、`lib/write-proxy.js`、`lib/theme.js`、`lib/integration/index.js`（另本棒曾对全部 23 个 js/mjs 文件跑 `node --check`，全 ok）。

### 3.3 可打包性与文件齐备性（[3] 段，7/7）

| 检查 | 结果 |
|---|---|
| `package.json` 可解析 | ok |
| `exports["."] → ./index.js`、`exports["./client"] → ./client.js` 均在包内且存在 | ok |
| `dsh.bundle.patch → ./cordis.patch.yml` 存在 | ok |
| `dsh.client.platform === "web"` | ok |
| `files` 覆盖 index/client/cordis/lib | ok |
| `npm pack --dry-run --json` 成功 | **20 个文件**：index.js、client.js、cordis.patch.yml、package.json、lib/**（16 个） |

> 说明：`files` 当前不含 `locale/`、`icon.svg`、`tools/`。经核实 `client.js` 已内联 MESSAGES（locale 为键集比对用，非运行期读取）、运行期入口（`index.js`→`lib/*`）不读 locale/icon，故这些不属于运行必需产物；**是否把它们并入发布包属用户/发布决策**（见 §6）。

### 3.4 原有用户版业务基础测试（[4] 段 · 隔离纯静态回归，55/55）

- 定义：`.test/check-*.mjs` 中**不含** `fetch(`/`spawn(`/`createServer(` 且非阶段检查、非浏览器用例者。
- 结果：**55/55 退出码 0**（临时 HOME 下运行）。
- 用途：确认插件化改造未回归用户版纯逻辑（定价/路由/评分/决策/校验等纯函数类用例）。

### 3.5 深层真实 daemon 子进程回归（`--with-daemon`，27/27）

- 定义：含 IO/子进程但**自设 `MANAGE_API_HOME` 且不含固定真实端口 `4399/4319`** 的用例，用 `freePort()` 起真实 `daemon/index.js` + 假上游。
- 结果（`--with-daemon` 全量）：**27/27 退出码 0**（约 1m44s）。抽样（check-currency / check-import-keys / check-ratio-price / check-usage-detail / check-gift-balance）亦分别 0–3s 通过。

### 3.6 默认门对隔离范围的诚实披露

- **默认门只跑纯静态**，不跑含 IO/浏览器用例（快、确定，~7s）。
- **已跳过并披露**：38 个含 IO/子进程用例（深层用 `--with-daemon`）、6 个浏览器用例（`check-diagnosis-page`、`check-group-chip-vendor`、`check-group-chips`、`check-group-models`、`check-lang`、`check-pricing-sheet`，需 headless Chrome）。
- **`--with-daemon` 另排除并披露** 3 个墙钟/慢用例：`check-probe-pause`（按墙钟等到分界时刻）、`check-route-target-forward`、`check-stream-reliability`——均在隔离环境挂起超时，属**环境/时序依赖，非代码回归**，故不纳入自动门。

### 3.7 本棒最终验收命令（§5 要求）

```
$ node dsh-plugin/.test/check-release.mjs          # exit 0，22/22
$ node dsh-plugin/.test/check-release.mjs --with-daemon  # exit 0，24/24（深层 27/27）
$ git diff --check                                 # exit 0
```

---

## 4. 静态 / 隔离 / 运行时 live 的边界（不可混淆）

| 层 | 已证 | **不能**证 |
|---|---|---|
| 静态检查（`node --check`、client contract、manifest 形状） | 语法正确、清单/module/export/slot/locale 契约与 C 的 API 静态映射一致 | 浏览器无渲染、无布局、无真实 slot props |
| 隔离契约测试（check-dsh-plugin-api / check-dsh-host） | 用假上游/模拟 Context 验证 route 白名单、脱敏、拒绝、dispose、`next()` 续流等**契约形状与分支** | 真实 daemon 数据下的读写、真实 DSH Host 激活 |
| 打包检查（`npm pack --dry-run`） | 可打包、关键产物入包 | 包能被 DSH Loader 载入、能被 profile 识别 |
| 基础回归（纯静态 + daemon 子进程） | 用户版业务逻辑与真实 daemon handler 未被插件改动回归 | live DSH UI / 可视结果 |
| **运行时 live**（本轮**未做**） | — | Host 激活状态、Client slot 注册、浅/深主题、locale、窄屏、console、真实 4319 行为 |

> 本报告全部结论止于静态 + 隔离层；任何「UI 可用/视觉正确」均**未验证**。

---

## 5. 部署流程建议（**须用户另行授权后才可执行**；本棒未执行）

当前插件已具备可打包的 DSH bundle 形态（`dsh.bundle.patch` + `cordis.patch.yml` + `dsh.client.platform=web` + `exports["./client"]`）。建议按当前 DSH 受支持安装流程，在**专用 disposable profile** 中验证，步骤（供获授权方参考，非本轮执行）：

1. **前置**：用户明确授权在 disposable profile 安装/激活；确认不动当前默认 profile/preset。
2. **打包安装**：在 `$PLUGIN_ROOT` 生成 tgz（`npm pack`）或按 DSH 支持的本地包方式安装到 disposable profile；**不手改** profile 的 `cordis.patch.yml`，走 DSH 官方 bundle/plugin 安装入口。
3. **记录结构化回执**：保存安装输出的 `application` / `warnings` / Host 应用状态；若为 `failed`/`overridden`/`restart-required`，**不得**称激活成功。
4. **Host smoke**：在隔离数据目录 + 临时端口起一个 manage-api 实例（勿用真实 4319/真实数据），验证 health、一次只读 `/api/manage-api/state`、一次白名单写闭环；观察 `attach` 不结束外部 daemon、`owned` 才在 dispose 停本插件进程。
5. **Client smoke**：Client 连接后查询实际 Slot 的 subtree/options/props 与 Theme tokens；页面内打开面板、一次只读刷新 + 一次非破坏交互；检查浅/深主题、中英 locale、窄屏、console slot 崩溃与网络请求状态。**视觉结论必须来自实跑页面**。
6. **默认配置**：`cordis.patch.yml` 的 `autoStart/attachExisting` 默认 `false`（只装载骨架、不 spawn、不占 4319、不碰真实数据目录）——建议 live smoke 时也保持默认，按需显式传参指向隔离实例。

---

## 6. 未决事项 / 需用户决定

1. **profile 安装/激活授权**：本轮用户明确**未授权** disposable profile 安装/激活；解冻需用户单独一句话确认。未解冻前 live Host/Client 全部未验证。
2. **写白名单是否扩展**：免费池 9 条 + 基准价 5 条写调用在用户版 daemon **有路由**、但不在 C 的 26 条 `WRITE_RULES` 内（与朋友版一致，UI 目前置灰并标 unavailable）。是否逐条补白名单属新增写权限，需用户决定。
3. **面板忽略模型语义**：朋友版 fallback 会写全局 `ignoredModels`（路由级生效）；本插件**不引入** `panelIgnoredModels`/`dshFreeModels`。是否在 UI 明示或禁用相关入口需用户定。
4. **用量页展示映射**：ingest 写入的 `providerId='dsh:<provider>'` 在用户版用量页「按站点」列会显示为原始 id（未改 `web/`）；是否需要展示名映射待定。
5. **发布包 contents**：`files` 目前不含 `locale/`、`icon.svg`、`tools/`。若要求发布包可离线重生成/校验主题，或需保留 locale 源文件与 icon，应把对应项加入 `files`（本轮 F 不改 `package.json`，交编排方/用户决定）。
6. **包名/入口最终确认**：A 记录中 `@local/dsh-manage-api`、`$PLUGIN_ROOT=dsh-plugin/`、`index.js`/`client.js` 当时为**建议、待确认**；B–E 已按该建议落地并通过检查，用户如无异议即视为确认。

---

## 7. 声明

- **当前未授权 profile 安装/激活**：本棒未调用任何 profile 安装、激活、或修改操作。
- **daemon 4319 本轮未运行**：未执行任何真实 daemon 行为验证（health、代理读写闭环、数据刷新、真实模型接入）。
- **live UI 未验证**：Client Slots/Theme 无实时查询，UI 挂载、视觉、明暗、locale、窄屏、console 均**未验证**。
- 本报告所有「通过」均指**静态检查 + 隔离测试**范围，不含运行时 live 结论；「预计/应该」一律不写成通过。

---

## 8. 复现命令清单（本会话实跑，含退出码）

| # | 命令 | 退出码 | 说明 |
|---|---|---|---|
| 1 | `node dsh-plugin/.test/check-manifest.mjs` | 0 | B 阶段，20 断言 |
| 2 | `node .test/check-dsh-plugin-api.mjs` | 0 | C 阶段，29 断言 |
| 3 | `node dsh-plugin/.test/check-dsh-host.mjs` | 0 | D 阶段，13 断言 |
| 4 | `node dsh-plugin/.test/check-client-contract.mjs` | 0 | E 阶段，21 项 |
| 5 | `node --check`（23 个插件 js/mjs） | 0 | 全 ok |
| 6 | `npm pack --dry-run --json` | 0 | 20 文件 |
| 7 | `node dsh-plugin/.test/check-release.mjs` | 0 | 22/22 |
| 8 | `node dsh-plugin/.test/check-release.mjs --with-daemon` | 0 | 24/24；深层 27/27 |
| 9 | `git diff --check` | 0 | 无 whitespace 错误 |
| 10 | `git status --short` | 0 | 仅本棒新增 `check-release.mjs` + 本报告；B–E 产物与本棒前一致（见 §1 说明） |
