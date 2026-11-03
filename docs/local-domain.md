# 每台电脑固定使用 manage-api.localhost

正式面板地址固定为 **http://manage-api.localhost/**，客户端的 OpenAI 兼容 Base URL 固定为 **http://manage-api.localhost/v1**，都不带端口。

`.localhost` 指向浏览器所在的电脑。因此，把项目分别安装到两台电脑后，两台电脑可以使用同样的网址，但各自连接自己的 ManageAPI、读取自己的数据，不会串到另一台电脑。手机访问这个域名也会指向手机自己；跨设备访问仍使用服务电脑的局域网地址和原有令牌流程。

“把项目放到互联网分发”是让别人下载并在自己的电脑上运行，和把管理面板公开部署到互联网不同。本功能只监听 `127.0.0.1:80` 和 `[::1]:80`，不对局域网或公网开放新的入口。

## 正式实例和预览实例

固定入口只代理本机 **4319**，且先验证后端 `/api/instance` 的 `mode` 是 `formal`。正式实例没启动或身份不匹配时，返回明确的 502，不寻找其他端口，不自动切换到预览实例。

- 正式实例：仍由原来的启动方式管理，数据仍在该用户的 `~/.manage-api`。修改后端后需要重启正式实例。
- 地址代理：独立常驻的轻量进程，只转发请求，不保存上游 Key、不保存网关数据库。
- 预览实例：继续使用原来的独立端口和独立数据目录。预览测试通过，不代表正式实例已经更新。

这个代理支持流式响应和 SSE；不提供 WebSocket 转发。`/v1` 仍要求网关 Key，固定域名不会绕过网关鉴权。

## 先检查，再安装

在仓库目录运行：

```sh
node daemon/install-local-domain.js
# 等同于：
node daemon/install-local-domain.js --dry-run
```

默认**只检查并打印安装计划**：目标端口、监听地址、安装目录、服务定义、运行用户、80 端口是否被占用、系统能否解析域名。不写文件、不安装服务、不改 hosts、不重启正式实例、不修改网关数据。

80 端口被占用时，需要先处理占用它的服务。安装器会明确失败，绝不改用另一个端口。重新安装前也应先停止已有的地址代理；不要把占用端口的正常代理当成第二个实例再装一遍。

## macOS

先安装 Node.js 20 或以上版本，以及系统命令行编译工具（`xcode-select --install`）。查看安装计划后，从日常使用 ManageAPI 的普通账号执行：

```sh
sudo "$(command -v node)" daemon/install-local-domain.js --install
```

安装器使用 `SUDO_UID` 和 `SUDO_GID` 记录调用者，不把 Node 常驻进程作为 root 运行。必要时可以显式指定：

```sh
sudo /absolute/path/to/node daemon/install-local-domain.js --install --uid 501 --gid 20
```

这里的 UID/GID 应换成运行正式 ManageAPI 的普通账号（`id -u` / `id -g`），不能是 0。

安装位置：

- `/Library/Application Support/ManageAPI/local-domain/`：受保护的代理副本、配置、最小端口绑定程序。
- `/Library/LaunchDaemons/local.manage-api.domain.plist`：开机启动项。
- `/var/log/manage-api-local-domain.log`：代理日志。

目录、源码、配置和绑定程序归 root 所有，组和其他用户不可写。原仓库里的修改不会自动替换已安装副本。

绑定程序由 `/usr/bin/cc` 编译，只负责绑定两个回环 80 端口，随后清除附加组、切换至普通 UID/GID，最后才执行 Node。即使 Node 安装在用户管理的 Homebrew 目录中，Node 和其动态库也在**降权之后**执行；不会把用户可写的 JavaScript 或 Node 动态库作为 root 开机运行。

检查与重启：

```sh
sudo launchctl print system/local.manage-api.domain
sudo launchctl kickstart -k system/local.manage-api.domain
curl --resolve manage-api.localhost:80:127.0.0.1 http://manage-api.localhost/api/instance
```

更新地址代理副本时，先停止，再重新运行安装器：

```sh
sudo launchctl bootout system /Library/LaunchDaemons/local.manage-api.domain.plist
sudo "$(command -v node)" daemon/install-local-domain.js --install
```

停止地址代理不会停止正式 ManageAPI；正式实例的原端口仍然存在。卸载时先执行上面的 `bootout`，再由管理员删除对应的 plist 和专用 `local-domain` 安装目录；不要删除 `~/.manage-api`。

## Linux（systemd）

需要 Node.js 20 或以上、C 编译器 `/usr/bin/cc` 和 systemd。普通用户查看计划后安装：

```sh
node daemon/install-local-domain.js --dry-run
sudo "$(command -v node)" daemon/install-local-domain.js --install
```

安装器从 sudo 环境识别普通用户。直接以 root 登录时，必须提供 `--uid` 和 `--gid`。Node 本体可以在普通用户目录中，因为受保护的原生绑定程序在执行它之前已经降权。

受保护的文件在 `/etc/manage-api-local-domain/`，服务文件在 `/etc/systemd/system/manage-api-local-domain.service`。

```sh
sudo systemctl status manage-api-local-domain
sudo journalctl -u manage-api-local-domain -n 50
sudo systemctl restart manage-api-local-domain
```

更新安装副本前先 `sudo systemctl stop manage-api-local-domain`，再运行安装器。正式 ManageAPI 服务仍单独管理。

## Windows

Windows 不要求管理员权限来绑定普通 TCP 80 端口。安装器为**当前普通用户**登记“登录时启动”的计划任务，运行级别是 `Limited`；不创建 SYSTEM 任务，也不会让用户可写的 Node 或 JavaScript 以 SYSTEM 权限执行。

在 PowerShell 的仓库目录中，以日常运行 ManageAPI 的同一个账号执行：

```powershell
node .\daemon\install-local-domain.js --dry-run
node .\daemon\install-local-domain.js --install
```

文件在 `%LOCALAPPDATA%\ManageAPI\local-domain`，计划任务名为 `ManageAPI Local Domain`。正式 ManageAPI 本身仍需要启动并监听 4319。该任务在用户登录后启动，不是无人登录时的系统级服务。

```powershell
Get-ScheduledTask -TaskName 'ManageAPI Local Domain'
Stop-ScheduledTask -TaskName 'ManageAPI Local Domain'
Start-ScheduledTask -TaskName 'ManageAPI Local Domain'
```

更新前先停止任务，再运行安装器。卸载使用 `Unregister-ScheduledTask -TaskName 'ManageAPI Local Domain'`，确认后删除专用安装目录。不要删除原网关数据。

## 域名解析检查

现代浏览器通常把 `.localhost` 自动解析到回环地址，不需要修改 hosts。不过，部分系统解析器、命令行工具或代理配置没有相同行为，安装器会打印系统 DNS 检查结果。DNS 检查失败并不一定表示浏览器打不开。

先检查不依赖 DNS 的完整入口：

```sh
curl --resolve manage-api.localhost:80:127.0.0.1 http://manage-api.localhost/api/instance
```

如果以上请求正常，浏览器或 API 客户端却解析失败，可以由管理员在 hosts 中添加：

```text
127.0.0.1 manage-api.localhost
::1 manage-api.localhost
```

macOS/Linux 是 `/etc/hosts`，Windows 是 `C:\Windows\System32\drivers\etc\hosts`。IPv6 已在系统中完全禁用时，只添加 IPv4 行。安装器**不会自动编辑 hosts**。

系统或客户端使用网络代理时，也应把 `manage-api.localhost`、`localhost`、`127.0.0.1` 和 `::1` 加入不代理列表。外部 HTTP 代理访问的是代理服务器自身的回环地址，不能替代你电脑上的本地入口。

## 从原来的 IP 地址迁移

`http://192.168.1.26:4319/` 与本机固定域名可以对应不同的电脑、进程和数据库。改浏览器网址只会切换你看到的面板，**不会自动迁移数据，也不会修改已经运行的 GPT 客户端的 Base URL**。因此，旧面板和旧网关仍可继续处理流量，并不矛盾。

迁移时要分别确认：

1. 当前 GPT 客户端的 Base URL 实际指向哪里。
2. 正式实例是否已迁移所需配置和密钥；跨电脑迁移数据时，`db.json` 与 `master.key` 必须成对。
3. 在运行 GPT 客户端的那台电脑上，`http://manage-api.localhost/api/instance` 是否返回期望的正式实例身份。
4. 确认后再把该客户端 Base URL 改为 `http://manage-api.localhost/v1`，使用该正式实例的网关 Key。

本功能不修改旧设备、不停止旧网关、不静默导入或覆盖数据。正式实例代码更新后仍需重启它；固定域名不会把旧进程自动变成新版本。
