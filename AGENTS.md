# ManageAPI

本地 AI 中转站管理网关：跨站比价、降智探针、一个 Key 走所有站点。
零依赖 Node.js（>=20），无构建步骤，改完刷新浏览器即可；改后端要重启进程。

新接手的人按这个顺序读：`README.md`（怎么跑）→ `CHANGELOG.md`（最近改了什么）→
`docs/ARCHITECTURE.md`（为什么这样设计）。改任何判定逻辑之前，先跑对应的 `.test/check-*.mjs`。

## 「提交」和「push」是两件事（先看这条）

用户说「提交」= **只在你自己所在的那个目录和分支上 `git commit`**。到此为止。

用户说「push」= 把改动落到主线：先确认每个提交的 Commit 信息都按下面的「提交规范」
写完整（现象/根因/改动/测试，不带半成品），然后合进 `release-0.2.1`，只推主线。

**Push 三条铁律：**

- **只推 `release-0.2.1`，不推任务分支**。任务分支上的改动先合并进主线再推；
  不要 `git push origin <任务分支>` 给云端留副本。
- **push 前把 Commit 写完整**。历史里有「待补」「wip」式的提交先整理好再推。
- **绝对不能动 `main`**：不 push、不 merge、不 rebase、不删除，本地 `main`
  和 `origin/main` 都不碰。唯一的开发主线是 `release-0.2.1`。

除此之外的合并动作（rebase、cherry-pick、合别的分支）仍只在用户明确点名时才做；
提交完回一句「已提交 <hash>，未合并」就够了。

## 一人一个 worktree（硬规矩，先看这条）

**每次任务都必须开独立 worktree，不在主目录上直接改。** 主目录
`ManageAPI/` 是 `release-0.2.1` 的日常位置，随时可能有别的会话在里面干活。

为什么是硬规矩而不是建议：几个人（几个会话）同时在一个插件上写功能时，共用一个
工作区会出现**双向串味**——2026-11-09 就发生过一次，A 会话未提交的半成品被 B 会话
的 `git commit` 顺手打包带进了两个标题完全无关的提交里（`37ad64e`、`bf9e0c5`），
结果那个提交引用了尚未存在的常量，上限校验变成空操作，直到几十分钟后才被发现。
代码本身没丢，但**归属和意图全乱了**，事后也没法安全地改写历史（会动到别人正在用的提交）。

开法（一个任务一个，名字就是任务名）：

```bash
cd "/Users/sakura/个人收藏/Agent Storage/ManageAPI/ManageAPI"
git worktree add "../manage-api-<任务名>" -b feat/<任务名> release-0.2.1
```

- 任务分支从 `release-0.2.1` 拉，**只推主线，不推任务分支**（见上面 Push 三条铁律）。
- 所有编辑、测试、验收都在 worktree 目录里做；主目录一个字都不要改。
- 交付验收用 `preview.mjs up --dir <worktree 路径>`，别占 4319。
- 收工时 `git worktree remove ../manage-api-<任务名>`；分支留着等 merge 或丢弃。
- 已有的 worktree 别复用、别删——那是别人正在跑的任务。

## 开工前必做

1. **确认自己在 worktree 里**：`pwd` 必须是 `manage-api-<任务名>/`，不是 `ManageAPI/`。
   再看 `git status`；有未提交改动时先说清「这是谁的、能不能动、能不能提交」。
   别的会话留下的半成品很常见，**不许打包提交**。
2. **建测试基线**：`git stash && 跑测试 && git stash pop`。
   记下哪些本来就红（见下），否则改完跑失败会误判成自己弄坏的。
3. **可能动数据时先备份**：
   `cp ~/.manage-api/db.json "/Users/sakura/个人收藏/Agent Storage/ManageAPI/manage-api-backups/db.before-<改动名>.json"`

## 数据与本机运行实例

- 真实数据在 `~/.manage-api/`（`db.json` / `master.key` / `usage.json`），
  **不在仓库里，永远不要提交**。`.gitignore` 已排除。
- `master.key` 和 `db.json` 必须配对；只恢复 db 会让所有 Key 解不开。
- 生产实例由 launchd 托管（`com.sakura.manage-api`），端口 4319，开机自启，
  数据即 `~/.manage-api`；每日备份到
  `/Users/sakura/个人收藏/Agent Storage/ManageAPI/manage-api-backups/`（由 launchd 的
  `MANAGE_API_BACKUP_DIR` 指定），默认保留 30 份。**4319 留给日常真实实例，不要拿它做验收。**
- 验收预览用仓库外的 `preview.mjs`（见「交付流程」），每个任务独立端口和独立数据副本。
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

其余 `check-*.mjs` 应全部通过。

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

## 交付流程（先看效果，后提交）

作者不读代码、不看 diff，验收方式只有一种：**把改动跑起来，点开网址用**。
所以默认顺序是「先看效果，后提交」——改完不要直接 commit。

1. **自测**：跑相关 `check-*.mjs`；红着的东西不要拿给人看。
2. **起一个自己的验收实例，别抢 4319**（改动仍未提交）：

   ```bash
   node "/Users/sakura/个人收藏/Agent Storage/ManageAPI/manage-api-previews/preview.mjs" \
     up --name <任务名> --dir <工作树> --marker <本次新增标识>
   ```

   它给这个任务分配独立端口（4500–4599）、复制一份真实数据（`db.json` + `master.key`
   成对复制，真实库不动）、默认关掉定时采集和探针，并登记到看板。
   同名重跑 = 重启（改了 `core/*` / `daemon/*` 必须重跑）。
3. **一次把验收信息写全**：看板 `http://127.0.0.1:4300/`（点任务名直接开）、
   该任务的端口网址、点哪里、应该看到什么、什么样算不对；并明确要求 **Ctrl+F5 强刷**
   （旧 `app.js` 会被缓存）。发链接前自检：`/api/health` 通，且 `--marker` 那行没有红字
   （红字表示实例里跑的不是你这版代码）。
4. **等对方试用**：这期间不要提交、不要动主树、不要切分支——
   对方眼前跑的就是工作区，代码一变行为就变。
5. **对方说「可以」之后才提交**（本地 commit）；对方说「push」才按上面的
   Push 三条铁律合进主线推送。
   不通过就在同一工作区继续改，重复 2–4；整个放弃前先问对方，别留半成品。

验收跑的是**未提交的工作区代码 + 真实数据的一份副本**：副本随便点、随便删，真实
`~/.manage-api` 不会被写；但真实库这边要做删站点 / 删分组这类不可逆操作，仍先提醒对方。

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

提交前必须做的两件事：

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
- **shallow clone 打 `git bundle` 时 `verify` 通过不代表能恢复**：缺失的父对象
  要等真实 clone 才报错。先 `git fetch --unshallow`，打完 bundle 真实 clone 一次验证。
