# Unraid 安装说明

[English](UNRAID.md) | **简体中文**

Lingshu-Home 提供可用于 Unraid Docker Manager 和 Community Applications 的 Docker 模板。模板使用 **Linux amd64（x86-64）** 镜像 `ghcr.io/zhigege666/lingshu-home:latest`，跟随已发布的正式稳定版，默认使用内置 SQLite，无需另装数据库。仍可使用 `0.0.4` 等精确标签固定版本。

下方安装说明对应 **0.0.4**，语言只确定一次并保存到数据库。升级已有 0.0.1 实例前，请阅读下方语言规则和迁移 007 的备份要求。

## 安装

当 **Apps** 中已经可以找到 Lingshu-Home 时，搜索 **Lingshu-Home**，确认仓库为 **zhigege666/Lingshu-Home**，选择安装，并检查下方配置。如果暂时尚未收录，可使用手动模板安装。

### 手动安装模板

下载[当前原始模板文件](https://raw.githubusercontent.com/zhigege666/Lingshu-Home/main/templates/lingshu-home.xml)，保存到 Unraid 启动盘的以下位置：

`/boot/config/plugins/dockerMan/templates-user/my-lingshu-home.xml`

如果没有 `templates-user` 目录，先创建它。如果已有同名文件，先备份并比较原有配置，再决定是否替换；不要覆盖另一个 Home 实例的模板。

打开 **Docker → Add Container（添加容器）**，在模板列表选择 **Lingshu-Home**，检查配置后点击 **Apply（应用）**。Docker Manager 会拉取镜像并启动容器。这会在本机安装应用，不代表 Community Applications 已经批准收录。

## 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| Repository（镜像） | `ghcr.io/zhigege666/lingshu-home:latest` | 已发布的最高稳定版本；更新仍需拉取镜像并重建容器。 |
| Network（网络） | `bridge` | 通过宿主机端口访问 Home。 |
| WebUI port | 宿主机 `5180` → 容器 `8080/tcp` | 端口冲突时修改宿主机端口，容器端口保留 `8080`。 |
| Appdata（数据目录） | `/mnt/user/appdata/lingshu-home` → `/data` | 保存数据库、图标和实例密钥，重建容器时保留此映射。 |
| Interface language（界面语言） | `en` | 首次启动或首次从 0.0.1 升级前选择 `en` 或 `zh-CN`；以后启动以实例已保存语言为准。 |
| HTTPS-only cookies | `false` | 高级选项，仅在通过 HTTPS 反向代理访问 Home 时改为 `true`。 |

每个 Home 实例使用独立的数据目录。需要更换共享目录或存储池路径时，只修改 Appdata 的**宿主机路径**，容器路径保留 `/data`。不要让两个运行中的容器共用同一个数据目录。

### 数据目录权限

正式镜像默认以 `10001:10001` 运行。Unraid 模板通过 `--user=99:100` 明确改用 Unraid appdata 的用户和组。应用没有实现 `PUID` 或 `PGID`，添加这些环境变量不会改变实际运行身份。

所选 Appdata 目录必须允许 UID `99`、GID `100` 写入。Docker Manager 为不存在的宿主机挂载路径创建目录时，会设置为这个用户和组；它不会修复已有目录的归属。对于新的专用目录，允许所属用户写入和进入目录即可，无需向所有用户开放写权限。数据库和实例密钥等文件仅允许运行用户访问。

从镜像默认身份或其他部署迁入数据时，先停止 Home 并完整备份，再仅调整 Home 专用数据目录内的归属。不要递归修改整个 appdata 共享目录。后续启动保持相同运行身份。调整已有部署前请阅读[存储和迁移说明](STORAGE.md)。

模板将 Docker 默认停止等待时间设为 30 秒，移除 Linux capabilities，并启用 `no-new-privileges`，不启用特权模式。Unraid 的 WebUI 和阵列关闭流程可能通过全局 Docker 停止超时覆盖容器默认值，因此全局设置也应允许至少 30 秒。模板不单独设置 Docker 重启策略；需要随阵列启动时，在 Unraid 的 Docker 页面设置 **Autostart（自动启动）**。

## 首次启动

使用容器菜单里的 **WebUI**，或打开 `http://<Unraid-IP>:5180`；如果修改了宿主机端口，使用修改后的端口。此 bridge 端口映射允许通过 Unraid 宿主机的网络接口访问，与 README 中仅绑定回环地址的 Docker 示例不同。

在可信网络中完成初始化向导：填写站点名称、选择访问方式，并在需要账号的模式中创建 Owner。Home 没有默认管理员账号或密码。默认的公开浏览模式要求 Owner 才能修改内容，个人空间保持私有；完全开放模式可以免账号使用。

新建简体中文实例时，应在首次启动前将 **Interface language** 设为 `zh-CN`。模板默认明确指定 `en`，因此直接进入英文初始化，不再显示浏览器语言选择页。语言保存后，再修改此字段不能切换语言。

### 一次性语言与从 0.0.1 升级

新实例已经明确配置容器语言时，会一次保存并直接进入初始化；未配置语言时，先选择简体中文或 English，再进入初始化表单。界面与可选示例导航使用同一种语言，不再出现独立示例语言下拉框，后续也没有页面内切换。

已初始化的 0.0.1 实例会在首次升级启动时保存当时明确配置的语言，未指定则保留旧默认 `zh-CN`；首次启动 0.0.2 时应将 **Interface language** 保持为原值，英文实例尤其要保留 `en`。语言存入数据库后，更换容器只要继续使用原 Appdata 就会保留。后续冲突启动值会被忽略并记录警告，服务继续运行；再修改 Unraid 字段不会覆盖保存语言。

0.0.2 为 SQLite 与 PostgreSQL 应用**迁移 007**。升级前正常停止并备份数据库和匹配密钥，退回 0.0.1 时需要恢复升级前备份，不能只替换旧镜像。详见[存储与恢复](STORAGE.md)。

远程访问时，先配置 HTTPS 反向代理，再将 **HTTPS-only cookies** 改为 `true`。这个选项仅控制 Cookie 的传输要求，不会让 Home 自行启用 TLS。直接使用 HTTP WebUI 时保留 `false`，否则浏览器无法通过 HTTP 使用安全登录 Cookie。

## 备份、重建和升级

0.0.2 升级到 0.0.4 不增加数据库迁移，保留原 Appdata 和密钥。新增图标 ID 与组件设置不被旧版本校验器识别；使用后如需回退，应恢复升级前备份。

`/data` 中包含 `lingshu-home.db`、`csrf.key` 和 `integrations.key`，以及 SQLite 运行时文件和实例锁。已保存的网站图标与自定义图标字节存放在数据库中。停止 Home 后备份**整个专用数据目录**，确保数据库与对应密钥成套保留；只导出数据库不能替代这种备份。

重建相同版本时，保留原 Appdata 宿主机路径、运行用户和其他配置。删除容器不需要删除 appdata。

模板使用 `latest`，跟随已经成功发布、SemVer 版本号最高的正式稳定版。草稿和预发布版不会成为 `latest`，`0.0.4` 等精确版本标签继续保留。已有安装如果固定在 `0.0.1` 或 `0.0.2`，需手动将 **Repository** 改为 `ghcr.io/zhigege666/lingshu-home:latest` 一次，之后才会跟随稳定版。商店模板更新不会修改已安装容器的 Repository，`latest` 标签更新也不会直接升级运行中的容器；阅读升级要求后，通过 Unraid 的更新操作或已配置的自动更新任务拉取镜像并重建容器。

升级到新版本时：

1. 阅读该版本的[发行说明](https://github.com/zhigege666/Lingshu-Home/releases)和迁移要求。
2. 停止 Home，完整备份专用数据目录并保留旧镜像。首次从 0.0.1 升级时，保留原本使用的 **Interface language** 值。
3. **Repository** 使用 `ghcr.io/zhigege666/lingshu-home:latest` 跟随稳定版，或使用 `ghcr.io/zhigege666/lingshu-home:0.0.4` 等已发布的精确标签固定版本。保留 `/data`、原 Appdata 宿主机路径和 `--user=99:100`。
4. 修改 Repository 后应用配置；已经使用 `latest` 时，通过 **Check for Updates → Update（检查更新 → 更新）**，让 Docker Manager 拉取镜像并重建容器。
5. 检查日志，打开 WebUI，登录并确认原来的链接和设置仍然存在。

新版本可能迁移数据库。如果没有明确支持的降级流程，不要用旧镜像直接打开迁移后的数据；保留升级前的完整备份。

## 排错与支持

- **端口被占用：**修改 WebUI 的宿主机端口，容器端口保留 `8080`。WebUI 模板通过 `[PORT:8080]` 查找映射后的端口。
- **/data 下出现权限错误：**核对实际映射路径、归属和权限，确认 `99:100` 可写。已有目录不会自动迁移；不要通过特权模式或向所有用户开放写权限来掩盖问题。
- **重新出现初始化页面：**先停止并检查 Appdata 映射，避免初始化另一个数据库。复用镜像但更换宿主机路径不会自动搬迁数据。
- **启用安全 Cookie 后无法登录：**使用 HTTPS 代理地址，或在直接 HTTP 访问时将该选项改回 `false`。
- **镜像拉取失败：**检查完整镜像名、版本标签，以及宿主机对 GHCR 的 DNS 和网络连通性。模板需要 Linux amd64 发行镜像。
- **停止不完整或数据库被占用：**同时检查 Unraid 的全局 Docker 停止超时与容器默认值，允许至少 30 秒停止时间，并确认只有一个 Home 进程在使用此数据目录。

安装问题和可复现缺陷请提交到 [GitHub Issues](https://github.com/zhigege666/Lingshu-Home/issues)，附上 Unraid 版本、镜像标签、相关非敏感配置和脱敏日志。不要附加数据库、实例密钥、密码或访问令牌。

## 模板维护

公开安装模板为 [templates/lingshu-home.xml](../templates/lingshu-home.xml)，仓库资料为 [ca_profile.xml](../ca_profile.xml)，均适用仓库的 [Apache-2.0 许可证](../LICENSE)。

发布仓库与 Community Applications 收录是两个步骤。通过[官方提交入口](https://ca.unraid.net/submit)提交公开仓库，并按[官方模板文档](https://ca.unraid.net/submit/help/repository-xml)依次执行 **Validate** 和 **Scan**。只有确认商店条目后，才应描述为已经收录。

等效 Docker 部署测试可以验证镜像、运行身份和持久化行为，但不能替代通过 Unraid WebUI 进行的实际安装。
