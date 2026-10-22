# DSH 插件端规划

> 状态：**规划稿，尚未开工**。本文回答一个问题：如果给 ManageAPI 做一个 DSH 插件壳，能做哪些功能、每个功能落在哪个扩展点上、先做哪些。
>
> 文中标注「已确认」的扩展点，都是从本机 DSH（44.7.0）的 `app.asar` 里提取的真实 API，不是推测。

---

## 1. 定位：插件不是「网页壳」

现在有两种形态，职责不同：

| 形态 | 是什么 | 能做什么 |
|---|---|---|
| **daemon**（已有） | 独立 Node 进程 + 浏览器页面 | 服务**所有**客户端：DSH、Cherry Studio、Cline、Chatbox… |
| **插件**（本文） | 嵌进 DSH 的包，跑在宿主进程里 | 能**读写 DSH 的请求生命周期**，不只是看数据 |

一句话区别：**daemon 只能「看数据」，插件能「参与决策」。**

所以插件端如果只把 8 个页面塞进侧边栏，价值约等于一个浏览器书签。真正的价值在下面第一章那 8 条。

---

## 2. 三种接入方式

| 方式 | 做法 | 侵入性 | 建议 |
|---|---|---|---|
| **A. 注册 adapter** | `llm.registerAdapter()` 把 ManageAPI 变成一个 provider，出现在 DSH 的模型选择器里 | 低 | **主线** |
| **B. 劫持请求** | 在 `agent/request` waterfall 里改 model / provider，用户无感 | 高，与其它插件抢注册顺序 | 备选，需先验证 |
| **C. 纯展示** | 只用 client slots 挂 UI，读同一份数据 | 零 | 第一版可以先只做这个 |

**为什么 A 优于 B**：A 是「我提供一个模型，你选它」，语义干净，不碰别人的路由；B 是「我替所有请求改道」，一旦和别的插件（如答案评审、转发类插件）同时启用，谁先注册谁生效，行为不可预测。

---

## 3. 功能清单

### 3.1 会话内嵌 —— 只有插件能做

| # | 功能 | 落点 | 价值 |
|---|---|---|---|
| 1 | DSH 模型选择器里出现「ManageAPI 路由」provider | `llm.registerAdapter()` | 用户选一次，之后自动选站，**不用改 base_url** |
| 2 | 首选站失败后静默换站，对话不中断 | `agent/request-error` 返回 `{ kind: 'retry' }` | DSH **原生支持**这个语义，不用自己写重试循环 |
| 3 | 每条回复下方显示「本次成本」 | `conversation.chat.assistant-actions` | 站名 / 实际花费 / 是否换过站 / 缓存命中率 |
| 4 | 对话内 tab「比价」 | `conversation.view` | 不离开对话就能看当前模型的跨站价格与健康 |
| 5 | 成本上下文写进系统提示 | `systemPrompt.context()` + `refreshContext()` | 让 agent 自己知道「你在用 ¥2/Mtok 的站」，主动收敛 token |
| 6 | **真实流量自动回写评分** | `agent/turn-stopping` | **插件端最大的独有价值**，见下方说明 |
| 7 | 成本熔断：某站当日超支就拒绝 | `ctx.tools.guard()` | 避免一晚上烧掉一个站一个月的余额 |
| 8 | 正在用的模型被判降智时提示并建议切站 | `agent/turn-stopping` + 通知中心 | 把「探针发现问题」变成「当场提醒」 |

**第 6 条值得单独说。** 现在评分样本只能靠网关转发的流量——也就是说，你不用网关就没有样本。插件接管后，**你正常用 DSH 的每一次对话都会变成样本**，样本量能涨一个数量级，而且全是真实请求（比探针的合成请求更接近实际）。

这决定了插件的长期价值：它不只是「更方便」，而是**让评分体系真正活起来**。

### 3.2 搬运现有页面 —— 几乎零成本

`core/` 是纯逻辑，无宿主依赖，插件壳可以直接 `import`。

| # | 功能 | 复用模块 |
|---|---|---|
| 9 | 右侧栏 / 设置页挂「概览 / 比价 / 决策」 | `core/pricing.js`、`core/router.js` |
| 10 | 站点与 Key 管理 | `core/inventory.js`（加解密不用重写） |
| 11 | 手动跑探针 + 结果表 | `core/probe.js`、`daemon/probe-runner.js` |
| 12 | 分组倍率导入 | `core/providers.js` 的 `fetchProviderPricing()` |
| 13 | 用量统计 + 余额低 / 评分过期通知 | `core/usage.js` |

### 3.3 工程与体验

| # | 功能 | 说明 |
|---|---|---|
| 14 | 与 daemon 共用 `~/.manage-api/` | 插件启动先探 `127.0.0.1:4319/health`：通则走 daemon（只读），不通则直读文件（可写） |
| 15 | 探针调度随 DSH 生命周期启停 | DSH 关了就停，不用像 daemon 那样常驻 |
| 16 | 首次启动引导 | 0 站点时在会话里问「你有哪几个站」，直接建档 |
| 17 | 跟随 DSH 界面语言 | 复用 `web/i18n.js` 的词典与整串匹配策略 |

---

## 4. 与 daemon 的关系

两条路并存，不互相替代：

```
DSH            ──插件──▶  路由  ──▶ 各中转站
其它客户端      ──daemon─▶  路由  ──▶ 各中转站
                    │
                    └──▶ 同一份 ~/.manage-api/
```

**数据共享**：两个壳读写同一个目录，评分、用量、站点配置天然一致。

**冲突点**：`core/store.js` 是「单进程写入 + 原子替换」，没有文件锁。两个进程同时写会互相覆盖。所以插件的策略是：

- 探到 daemon 在跑 → 走 daemon 的 HTTP 接口（只读 + 写操作转给它）
- 探不到 → 自己直读直写文件

---

## 5. MVP：先做 3 个

| 优先级 | 功能 | 理由 |
|---|---|---|
| **P0** | `registerAdapter` + 模型列表 | 没有这个，插件就只是个网页壳 |
| **P0** | `agent/request-error` 换站 | 一行 `return { kind: 'retry' }` 换来「永不中断」 |
| **P1** | `assistant-actions` 成本徽标 | 唯一能天天被看见的地方 |

这三个做完就是一个「能用」的插件，其余都是加分项。

---

## 6. 风险与待验证

| # | 风险 | 说明 | 处理 |
|---|---|---|---|
| 1 | `agent/request` 能否改写 model / provider | 只确认了它「在路由解析前跑」，payload 结构未验证 | 先写最小插件做 spike，半天 |
| 2 | 注册顺序冲突 | waterfall 按注册顺序执行，与其它插件可能互相覆盖 | 避免走 B 路线；必须走时用 `getSectionOrder()` 之类的显式排序 |
| 3 | DSH 升级破 API | `peerDependencies` 卡版本范围，DSH 一升级插件可能直接拒绝加载 | 接受；文档里写清兼容版本 |
| 4 | 双写覆盖 | 两个进程同时写 `db.json` | 见第 4 节的探活降级策略 |

---

## 7. 附录：已确认的扩展点

以下均从本机 `app.asar` 提取（DSH 44.7.0）。

### 7.1 Agent 生命周期（host 侧）

| 事件 | 语义 |
|---|---|
| `agent/pre-step` | 可拒绝某个 step，或**替换进入该 step 的消息** |
| `agent/request` | waterfall，在 `prepareCall()` 之前跑，此时解析路由 |
| `agent/request-error` | 请求失败后进入。监听器返回 `{ kind: 'retry' }` 且不调 `next()` → **原生换站重试**；不处理则该失败终止整轮 |
| `agent/turn-stopping` | 轮次收尾前，可 steer 让轮次继续 |
| `agent/assistant-stream` | 单次 assistant 尝试的 start / transition 序列 |
| `agent/session-start` / `agent/status` | 会话开始 / 状态变化 |
| `system-prompt/assemble` | 整体替换提示词组装（最强干预） |

### 7.2 `systemPrompt` 服务

`section()` / `context()` / `variable()` / `tools()` / `refreshContext()` / `assemble()` /
`getSectionOrder()` / `getContextOrder()`

`refreshContext()` 的特别之处：**只刷新运行时事实，不重新组装**提示词与工具，开销极小。

### 7.3 `llm` 服务

`stream()` / `listProviders()` / `listModels()` / `resolveModelInfo()` / `prepareCall()` /
`resolveCallConfig()` / **`registerAdapter()`** / `discoverModels()` / `providerRetryPolicy()` /
`fileRequestText()` / `imageRequestPricing()`

相关事件：`llm/stream`（**waterfall**，可拦截改写）、`llm/retry`、`llm/retry-started`、
`llm/adapters-updated`、`llm/model-discovery-rejected`

### 7.4 工具干预（由弱到强）

```
ctx.tools.restrict()   只能移除工具
ctx.tools.guard()      只能拒绝
waterfall 监听器        可改写，依赖注册顺序
system-prompt/assemble 整体替换
```

### 7.5 client 侧插槽

| API | 位置 |
|---|---|
| `slots.register('conversation.view', …)` | 输入框上方的一等 tab |
| `slots.register('conversation.chat.assistant-actions', …)` | assistant 消息下方的动作行 |
| `betterSidebar.registerTab({…})` | 右侧栏 tab（依赖 `dsh-better-sidebar`，属可选依赖） |

`slots` 是核心服务，`ctx.inject(['slots'], scope => …)` 即可；`betterSidebar` 不存在时要有降级。

### 7.6 host 侧 HTTP

```js
ctx.inject(['webServer', 'connection'], (scope) =>
  scope.effect(
    () => scope.webServer.register({ kind: 'exact', path, handler }),
    'manage-api: register route',
  ),
)
```

同源路由，自带登录态与 Origin 栅栏（用 `connection.requestRejection(req)` 校验）。

---

## 8. 不做的事

- **不与已有的探测 / 转发类插件重叠** —— 别人做过的事不重复做，插件只做「多站台账 + 选站 + 记账」
- **不接管非 DSH 客户端的流量** —— 那些走 daemon，两条路并存
- **不做账号池** —— 超出「配置写入器 + 路由」的定位

---

## 9. 参考

- 插件包结构、profile 安装方式：见本机任一已装 DSH 插件的 `package.json` 与 `cordis.patch.yml`
- 数据目录与降级策略：见 `core/store.js` 的 `dataDir()`
