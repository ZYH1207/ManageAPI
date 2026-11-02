# 本地归档说明（0.3.0）

> 2026-11-02。**这份文件写的是「这台机器上的仓库现在是什么状态」**，
> 不是项目文档。项目文档见 README.md / docs/ARCHITECTURE.md / CHANGELOG.md。
>
> 为什么单独写：GitHub 账号被封，30 个 commit 推不上去。本地有大量工作成果，
> 需要一个地方讲清楚「东西在哪、怎么恢复、以后怎么推」。

## 一、当前状态

| 项 | 值 |
|---|---|
| 仓库路径 | `/Users/sakura/dev/ManageAPI` |
| 分支 | `release-0.2.1`（唯一分支） |
| HEAD | `9801182` chore(release): 0.3.0 |
| tag | `v0.3.0`（annotated，指向 9801182） |
| 未推送 | **30 个 commit**（远端 `origin/release-0.2.1` 停在 `7a90e7e`） |
| 工作区 | 干净（0 未跟踪、0 修改、无 stash） |
| worktree | 只有主仓一个 |

## 二、为什么推不上去

```
remote: Your account is suspended.
fatal: ... The requested URL returned error: 403
```

- **仓库本身没坏**：`https://github.com/ZYH1207/ManageAPI` 匿名访问返回 200
- **推送账号 `zbv-qwe` 被 GitHub 停用**
- 与代码无关，本地一切正常

## 三、这 30 个 commit 是什么

按主题分组（完整列表见 `git log --oneline 7a90e7e..HEAD`）：

**文档（4）**
- `docs/ARCHITECTURE.md` 新写，640 行：请求链路、三套证据系统、
  自动路由与缓存亲和、级联失败五道闸门、五处历史混乱根因
- README 补 Windows 迁移、级联失败分析

**路由页（3）**
- 新增左侧「路由」入口 + 实时线路图
- 视觉重做（柔光线路、呼吸状态点、网格纵深）
- 修复首次进入连不上活动流
- 按需加载（首屏 0 次请求）

**路由组（5）** —— 对标 Magpie
- 数据层 `core/route-groups.js`
- 11 种路由方式 + 10 项组设置
- 折叠式卡片
- **设置真正接进路由**（用户最反感的「能选不生效」）

**质量分与档位（3）**
- 质量分从 0/1 两极改成连续（老公式全通过恒为 1.000）
- 新增「流畅度」档位（首字 + 吐字）
- 档位 6→5（删「价速比」）

**决策页布局（6）** —— 全是用户逐条反馈改的
- 算法卡降为一行内联条
- 亲和 5 档并入灰栏
- 左右两列等高
- 表格列重排（删「排序分/依据」，加「吐字」）

**功能（3）**
- 全局搜索（顶栏）
- 数据导出（5 集合 × CSV/JSON）
- 窄屏适配

**修复（4）**
- 报错标注段位（客户端→网关 / 网关→中转站）
- 端口被占时吭声
- 探针页 7 个输入补 aria-label
- 用量页补导航入口

**工程（2）**
- 前端契约测试 `check-frontend.mjs`（60+ 项）
- 路由组测试 `check-route-groups.mjs`（67 项，含对照组）

## 四、怎么恢复到「完全干净」的历史

如果以后想把这 30 个 commit 整理成更少的、按主题分组的提交：

```sh
# 方案 A：交互式 rebase 合并相邻提交（保留所有改动）
git rebase -i 7a90e7e

# 方案 B：软重置后重新按主题提交（改动不变，历史重写）
git reset --soft 7a90e7e
git add -A && git commit -m "0.3.0: ..."     # 一条大提交

# 方案 C：什么都不动（推荐）
# 30 个提交本身消息质量不错，按主题能看懂；不必为了「好看」重写历史
```

⚠️ **重写历史前先打 tag**（已经有了 `v0.3.0`，它指向当前 HEAD，是安全网）。

## 五、GitHub 恢复后怎么推

```sh
cd ~/dev/ManageAPI

# 1) 换提交身份（如果是换账号）
git config user.name  "新用户名"
git config user.email "新邮箱"

# 2) 清掉 keychain 里被停用账号的凭据（否则推送仍用旧账号）
git credential-osxkeychain erase <<EOF
host=github.com
protocol=https
EOF

# 3) 推送分支 + tag
git push origin release-0.2.1
git push origin v0.3.0
```

注意：前 30 个 commit 的作者是 `zbv-qwe`。**不建议改写作者** ——
提交记录保留原作者是正常的，改写会破坏历史完整性。

## 六、如果 GitHub 一直用不了

本地成果不会丢（tag + 干净工作区就是保障），但要有异地备份：

```sh
# 打一个包含全部历史的 bundle（单个文件，可直接 clone 回来）
git bundle create ~/manage-api-0.3.0.bundle --all

# 以后从 bundle 恢复
git clone ~/manage-api-0.3.0.bundle ManageAPI-restored
```

**已经打过一份**：`~/manage-api-0.3.0.bundle`（12MB，含 250 个 commit + 两个 tag）。

打的时候发现一个坑值得记下来：这个仓库原本是 **shallow clone**（浅克隆），
`.git/shallow` 里记着一个边界提交，那个提交的父对象故意没下载。
结果 `git bundle --all` 虽然 `verify` 报「完整历史」，但**真实 clone 会失败**：

```
error: Could not read 93a69984448822070c4e43eabb821101d67f1f1d
fatal: Failed to traverse parents of commit ca5d289...
```

修法：`git fetch --unshallow`（历史从 88 补到 250 个 commit，缺失对象回来了）。
**打完 bundle 一定要真实 clone 一次验证** —— `verify` 通过不等于能恢复。

已验证：从 bundle clone 出来的副本能跑测试、能启动服务。

## 七、运行时实例

| 实例 | 端口 | 数据 | 用途 |
|---|---|---|---|
| 生产（launchd 托管） | 4319 | `~/.manage-api` | 日常使用，开机自启 |
| 验收预览 | 见 `preview.mjs list` | `~/manage-api-previews/<任务名>/data` | 每个任务一个端口 |

预览工具的用法见 README 的「开发」章节。**它不在仓库里**
（`~/manage-api-previews/preview.mjs`），换机器要单独带过去。

## 八、下一个接手的人（或三个月后的你）先看什么

1. `README.md` —— 项目是什么、怎么跑
2. `CHANGELOG.md` —— 0.3.0 改了什么
3. `docs/ARCHITECTURE.md` —— **为什么这样设计**，尤其：
   - 三套证据系统（探针 / 真实流量 / 外部上报）不能互相替代
   - 级联失败的五道闸门（历史教训：开自动路由连环崩）
   - 404 不符时的口径（准入看探针、排序看真实）
4. 改任何判定逻辑之前，先跑对应的 `.test/check-*.mjs`