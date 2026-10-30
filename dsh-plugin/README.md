# dsh-manage-api

DSH 的 [ManageAPI](https://github.com/ZYH1207/ManageAPI) 插件端：把 ManageAPI 的守护进程、站点比价、智能决策、探针与真实用量，变成 DSH 里的原生功能。

## 它做什么

| 能力 | 落点 | 状态 |
|---|---|---|
| 设置页常驻面板（概览 / 比价 / 决策 / 探针 / 用量） | `settings.section`（id `manage-api`） | ✅ |
| daemon 生命周期托管（attach-or-spawn、孤儿防护） | host 半边 | ✅ |
| 同源只读代理（只认 loopback + 自建 Origin 校验） | `webServer.register('/api/manage-api/*')` | ✅ |
| 请求观测（`llm/stream` tee，取 usage/finish/ttft） | host 半边 | ✅ |
| 会话成本 chip（本会话 token / 调用次数） | `conversation.chat.assistant-actions` | ✅ |
| 真实流量回写评分（非 ManageAPI 渠道用量） | `POST /api/ingest/usage`（daemon 侧 ~50 行） | ✅ |
| 系统提示注入实时上下文 | `systemPrompt.context`（30s 刷新缓存） | ✅ |
| 模型/用量工具（给模型用） | `tools.register`：`manageapi_status/models/usage` | ✅ |
| `/manage` 命令（给人用，不进模型上下文） | `commands.register` | ✅ |
| 预算熔断 + 面板告警 | `tools.guard` + `settings.section` 顶部横幅 | ✅ |
| 模型列表动态化 | `llm.registerModelDiscovery` | ⛔ 受限（见下） |

### 为什么"模型列表动态化"没做成

`llm.registerModelDiscovery(settingsNs, discover)` 只能为**插件自己拥有的 settings 命名空间**注册发现器；
ManageAPI 这个 provider 的命名空间属于 `llm-pi-ai`，第三方插件无权注册（会与它冲突）。
所以模型选择器里那两条硬编码模型仍由 `llm-pi-ai` 的配置管理，插件侧改用三条路覆盖同一需求：
`manageapi_models` 工具（模型可自查）、`/manage models` 命令（人可自查）、设置页「比价」子页（全量视图）。

## 常用命令

```text
/manage            概览：站点数 / 供给数 / 最划算的站 / 今日用量 / 预算
/manage models     模型比价（★ = 该模型最便宜的站）
/manage models glm 只看匹配的模型
/manage usage      今日全渠道用量 + 本进程观测到的会话
/manage budget     本会话 / 今日预算与是否已熔断
```

命令结果直接显示在会话里，**不会进入消息历史、不发给模型**。

## 依赖关系（重要）

- **不重复造轮子**：选站、换站、记账、探针都在 ManageAPI 的 daemon 里，插件只做"让 DSH 知道这些"。
- **daemon 在跑 = 最有利状态**：插件探测到 `/api/health` 通就 **attach**（不抢实例锁、不写库、退出时不动它）。
- **只装了插件端也能用**：插件会自己 spawn 内置/依赖的 ManageAPI 运行时（`ELECTRON_RUN_AS_NODE=1`），DSH 退出时一起停。
- **唯一写通道是 daemon HTTP**：插件不在宿主进程里写 `db.json`（两个进程同时写会互相覆盖）。

## 运行时解析顺序

1. `cordis.patch.yml` 里的 `config.runtimeDir`
2. npm 依赖 `manage-api`（`createRequire().resolve('manage-api/package.json')`）
3. 包内 `runtime/`（内嵌形态）
4. 同仓开发目录（`dsh-plugin/..`）

## 配置项（都在 `cordis.patch.yml` 的 `config` 里）

```yaml
- insert:
    - id: manage-api
      name: dsh-manage-api
      config:
        port: 4319              # daemon 端口（默认 4319）
        autoStart: true         # 探不到 daemon 就自己拉起
        runtimeDir: ""          # 显式指定 ManageAPI 目录；空则按「运行时解析顺序」找
        waitMs: 10000           # 冷启动等待上限
        ingestExternalUsage: true  # 把非 ManageAPI 渠道的真实用量回写给 daemon
        promptContext: true     # 把站点/比价/用量注入系统提示词上下文
        budget:                 # 0 = 不设限；超限后拒绝一切工具调用逼模型收尾
          sessionTokens: 0
          dailyTokens: 0
```

> 预算只作用于**工具调用**：模型请求由宿主直接发出，插件是旁观者。拒绝一切工具后 agent
> 无法继续扩大动作面，配合提示词里的超限警告通常会自己收尾。

## 安装（开发期）

```bash
# 在 profile 里安装并注册 bundle
dsh plugin --profile desktop add "file:D:/AgentWorkPlace/DSH/ManageAPI/dsh-plugin"
# 再把 "dsh-manage-api" 加进 profile package.json 的 dsh.profile.bundles
```

## 安全

- 所有插件路由只允许 **loopback** 来源；跨站请求（`Sec-Fetch-Site: cross-site` / 非回环 Origin）一律 403。
- 写操作强制 `application/json`（`<form>` 发不出来），堵掉恶意网页的表单/图片触发。
- 本机环境装了 `dsh-remote-web-ui` 且开着隧道，所以这条约束不是可选项。

## 许可

MIT
