# ManageAPI

本地 AI 中转站管理网关：跨站比价、降智探针、一个 Key 走所有站点。
零依赖 Node.js（>=20），无构建步骤，改完刷新浏览器即可；改后端要重启进程。

## 开工前必做

1. **看工作区**：`git status`。有未提交改动时先说清「这是谁的、能不能动、能不能提交」。
   别的会话留下的半成品很常见，**不许打包提交**。
2. **建测试基线**：`git stash && 跑测试 && git stash pop`。
   记下哪些本来就红（见下），否则改完跑失败会误判成自己弄坏的。
3. **可能动数据时先备份**：
   `cp ~/.manage-api/db.json ~/manage-api-backups/db.before-<改动名>.json`

## 数据与危险区

- 真实数据在 `~/.manage-api/`（`db.json` / `master.key` / `usage.json`），
  **不在仓库里，永远不要提交**。`.gitignore` 已排除。
- `master.key` 和 `db.json` 必须配对；只恢复 db 会让所有 Key 解不开。
- 备份在 `~/manage-api-backups/`（数据目录同级），默认保留 30 份。
- 单实例锁 `~/.manage-api/daemon.lock`：同一数据目录只允许一个 daemon，
  进程崩了下次启动会自动清理。跑测试一律用 `mktemp -d` 另开数据目录。
- 默认端口 4319，被占用会自动往后找。
- **DB 有版本迁移**（`core/store.js` 的 `migrate`，当前 v4）。改数据结构要同时
  写迁移，且必须幂等——用户可能从任意老版本跨级升上来。

## 已知本来就失败的测试

这两个与代码改动无关，**看到它们红不用管**，除非你正是在改它们：

| 测试 | 失败原因 |
|---|---|
| `check-lang.mjs` | 需要 Chrome 远程调试端口 9222，没开就 ECONNREFUSED |
| `check-zcode.mjs` | `bonusTokens` 汇总断言依赖当前日期 |

其余 18 个 `check-*.mjs` 应全部通过。

## 跑测试

```bash
# 自包含（自己起假上游 + 自己起服务 + 跑完退出），首选
node .test/run-monitor.mjs
node .test/run-score.mjs

# 端到端需要外部环境：3 个 mock + 一个指向它们的实例
MODE=good PORT=5101 node .test/mock-upstream.mjs &
MODE=degraded PORT=5102 node .test/mock-upstream.mjs &
MODE=truncated PORT=5103 node .test/mock-upstream.mjs &
MANAGE_API_HOME=$(mktemp -d) node daemon/index.js --port 4399 &
node .test/seed-demo.mjs        # 建演示站，run-groups/run-weight 依赖它
node .test/run-groups.mjs
```

几个坑：

- `run-e2e` / `run-gateway` **自己建站**，和 `seed-demo` 建同名站会冲突。
  每个场景用独立数据目录，别混跑。
- `run-gateway` 要 5103 是 `MODE=fail`，而 `seed-demo` 要它是 `truncated`。
- 网关决策日志是**攒批写盘（2000ms）**的，断言日志前至少等 2500ms。
- 路径：bash 的 `/tmp` 与 node 眼里的 `/tmp` 不是同一个地方。跨语言传路径
  一律用 `mktemp -d` 或 `$TEMP`，别手写 `/tmp/xxx`。

## 提交规范

作者风格（读过仓库全部历史总结）：**纯文本、无 emoji、无 Co-authored-by**。

```
<type>: <症状 + 根因，25~40 字，可带括号补人话>

现象：<具体数字、具体站点/模型名，让人能对上自己的遭遇>
根因：<为什么这样，一针见血>
改动：<一条一个决策 + 为什么这么定，不写「改了哪个函数第几行」>
测试：<新增/补了什么、多少项、覆盖哪几个边界>
```

`type` 用 `fix` / `feat` / `chore` / `docs` / `style` / `refactor`。

**提交前必须做的两件事**：

1. **列出要提交的文件清单并确认**——`git add <具体文件>`，不要 `git add .`。
2. 一次提交只干一件事，别把两个无关改动混在一起。

## 这个项目踩过的坑（写之前先看一眼）

- **口径不一致是最大的一类 bug**：同一个概念在两处各写一份 `trim` / 各算一遍，
  迟早漂移。已经出过「分组名尾随空格导致每轮同步多插一整套重复供给」
  （v4 迁移修的）、「未乘倍率原价当手填价导致 10 倍价错」。
  新增比较逻辑时先找现成的归一化函数，别自己再写一份。
- **静默数值错误比崩溃更危险**：价格、花费、评分算错不会抛异常，页面照常渲染。
  改这类代码一定要有断言兜着。
- **落价三分支**收敛在 `core/inventory.js` 的 `applySitePricing`，别在调用方复制逻辑。
- **在役供给过滤**收敛在 `routeableOffers`（暂停站 / 忽略模型 / 已下线），
  比价、决策、网关、探针、免费池都从它取，别各自再写一遍。
