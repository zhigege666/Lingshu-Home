# Unraid 安装说明

[English](UNRAID.md) | **简体中文**

Lingshu-Home 提供可用于 Unraid Docker Manager 和 Community Applications 的 Docker 模板。模板使用 **Linux amd64（x86-64）** 镜像 `ghcr.io/zhigege666/lingshu-home:latest`，跟随已发布的正式稳定版。内置 SQLite 无需另装数据库，未配置的新实例先在浏览器确认存储选择。需要固定本版本时使用 `0.0.6` 精确标签。

下方安装说明对应 **0.0.6**，增加可重复文档活动组件、登录保持策略、个人资料、分类／链接行内编辑、分类文件夹与首次存储选择，保留 0.0.5 引入的文件型资料库、书签使用说明和原生 HTTPS。已有安装沿用原 Appdata、文档挂载、允许根目录及 HTTP/TLS 配置；活动组件不需要新挂载或环境变量。从 0.0.5 升级会自动执行**迁移 009 和 010**，请先备份。升级后通过**编辑页面 → 添加组件**使用，已有页面布局保留；导航未配置分类预览数量时，每类先展示 6 个书签，其余可在文件夹查看。语言仍保存在数据库；已有 0.0.1 实例还需遵守下方语言规则和迁移 007 的要求。

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
| Appdata（数据目录） | `/mnt/user/appdata/lingshu-home` → `/data` | 保存数据库、私密的 `storage.json`、图标、文档元数据、恢复历史和实例密钥，重建容器时保留此映射。 |
| Interface language（界面语言） | `en` | 首次启动或首次从 0.0.1 升级前选择 `en` 或 `zh-CN`；以后启动以实例已保存语言为准。 |
| Allowed document roots（允许的文档根目录） | `[]` | 可选高级变量 `LINGSHU_DOCUMENT_ROOTS`，填写容器路径的 JSON 数组；空数组关闭文档文件访问，相应 Path 映射需单独添加。 |
| TLS certificate file / TLS private key file | 两项均留空 | 可选高级变量，填写匹配的 PEM 证书链和私钥的容器路径。两项一起设置才开启直接 HTTPS；使用 HTTP 或由反向代理终止 HTTPS 时均留空。 |
| HTTPS-only cookies | `false` | 通过 HTTPS 反向代理访问时设为 `true`；直接 TLS 会自动使用 Secure Cookie。此选项本身不会开启 HTTPS。 |

每个 Home 实例使用独立的数据目录。需要更换共享目录或存储池路径时，只修改 Appdata 的**宿主机路径**，容器路径保留 `/data`。不要让两个运行中的容器共用同一个数据目录。

### 数据目录权限

正式镜像默认以 `10001:10001` 运行。Unraid 模板通过 `--user=99:100` 明确改用 Unraid appdata 的用户和组。应用没有实现 `PUID` 或 `PGID`，添加这些环境变量不会改变实际运行身份。

所选 Appdata 目录必须允许 UID `99`、GID `100` 写入。Docker Manager 为不存在的宿主机挂载路径创建目录时，会设置为这个用户和组；它不会修复已有目录的归属。对于新的专用目录，允许所属用户写入和进入目录即可，无需向所有用户开放写权限。数据库和实例密钥等文件仅允许运行用户访问。

从镜像默认身份或其他部署迁入数据时，先停止 Home 并完整备份，再仅调整 Home 专用数据目录内的归属。不要递归修改整个 appdata 共享目录。后续启动保持相同运行身份。调整已有部署前请阅读[存储和迁移说明](STORAGE.md)。

模板将 Docker 默认停止等待时间设为 30 秒，移除 Linux capabilities，并启用 `no-new-privileges`，不启用特权模式。Unraid 的 WebUI 和阵列关闭流程可能通过全局 Docker 停止超时覆盖容器默认值，因此全局设置也应允许至少 30 秒。模板不单独设置 Docker 重启策略；需要随阵列启动时，在 Unraid 的 Docker 页面设置 **Autostart（自动启动）**。

## 首次启动

使用容器菜单里的 **WebUI**，或打开 `http://<Unraid-IP>:5180`；如果修改了宿主机端口，使用修改后的端口。此 bridge 端口映射允许通过 Unraid 宿主机的网络接口访问，与 README 中仅绑定回环地址的 Docker 示例不同。

模板不固定数据库 provider。全新实例先选择 **SQLite** 或外置 **PostgreSQL**，再进入语言和账号初始化。PostgreSQL 填写主机、端口、数据库、用户名、密码与 TLS 模式，测试连接后确认；测试不写业务表、不保存凭据。已有有效 SQLite 实例、显式或已保存的数据库配置直接沿用。两种 provider 都需要保留同一个 `/data` 映射。

网页选择的目标私密保存在 `storage.json`，备份时与数据库及密钥一起保存。已选 PostgreSQL 连接失败进入同一目标的恢复流程，修复后重试；无效本地配置或不完整旧 SQLite 实例会阻止启动，不提供自动换库；选择其他 provider 不会复制已有数据。详见[存储选择与恢复](STORAGE.md#first-run-storage-setup)。

在可信网络中完成初始化向导：填写站点名称、选择访问方式，并在需要账号的模式中创建 Owner。Home 没有默认管理员账号或密码。默认的公开浏览模式要求 Owner 才能修改内容，个人空间保持私有；完全开放模式可以免账号使用。

新建简体中文实例时，应在首次启动前将 **Interface language** 设为 `zh-CN`。模板默认明确指定 `en`，因此直接进入英文初始化，不再显示浏览器语言选择页。语言保存后，再修改此字段不能切换语言。

### 一次性语言与从 0.0.1 升级

存储就绪后，新实例已经明确配置容器语言时，会一次保存并直接进入初始化；未配置语言时，先选择简体中文或 English，再进入初始化表单。界面与可选示例导航使用同一种语言，不再出现独立示例语言下拉框，后续也没有页面内切换。

已初始化的 0.0.1 实例会在首次升级启动时保存当时明确配置的语言，未指定则保留旧默认 `zh-CN`；首次启动 0.0.2 时应将 **Interface language** 保持为原值，英文实例尤其要保留 `en`。语言存入数据库后，更换容器只要继续使用原 Appdata 就会保留。后续冲突启动值会被忽略并记录警告，服务继续运行；再修改 Unraid 字段不会覆盖保存语言。

0.0.2 为 SQLite 与 PostgreSQL 应用**迁移 007**。升级前正常停止并备份数据库和匹配密钥，退回 0.0.1 时需要恢复升级前备份，不能只替换旧镜像。详见[存储与恢复](STORAGE.md)。

## 接入已有 Markdown 目录

模板不预置示例文档 Path 映射，只添加你实际需要开放的目录。Unraid 可能自动创建不存在的宿主机路径，因此应用配置前需检查路径拼写、已有文件及 NAS 是否已挂载。原来的 `/data` 映射继续独立保留。

1. 打开 **Docker → Lingshu-Home → Edit（编辑）**，开启 **Advanced View（高级视图）** 查看可选变量。
2. 点击 **Add another Path, Port, Variable, Label or Device**，选择 **Path**，为每个已有目录分别增加映射。例如：

   | 名称 | 宿主机路径 | 容器路径 | 访问模式 |
   | --- | --- | --- | --- |
   | 笔记 | `/mnt/user/knowledge/notes` | `/documents/notes` | 初次接入使用 Read Only；需要编辑原件时改为 Read/Write |
   | 项目文档 | `/mnt/user/projects/docs` | `/documents/projects` | Read Only |

3. 将 **Allowed document roots**（`LINGSHU_DOCUMENT_ROOTS`）设为 `["/documents/notes","/documents/projects"]`。直接填写 JSON 数组，不要再加 Shell 外层引号。如果旧的已保存模板没有此字段，新增 **Variable**，按上述准确键名和值填写。
4. 应用修改，让 Docker Manager 使用这些映射重建容器。单纯重启容器不会增加新的 bind mount。
5. 以 Owner 登录 Home，进入**后台 → 文档目录**，把每个**容器路径**连接到自己的个人空间或共享空间。一个空间可以管理多个目录；此版本一个目录只归属一个管理空间。来源默认只读，需要时可选择一个已启用的可写来源作为新建文档的默认位置。

编辑原文件需要 Docker 挂载允许写入、Home 中明确开启**允许写入原文件**，以及 UID `99` / GID `100` 对文件系统具有相应权限。仅将挂载设为可写，不会自动授予用户或 Agent 文件写入权限。接入已有资料库时可先从只读开始；不要将 `/`、`/data`、证书目录或整个 appdata 树加入允许列表。目录绑定到共享空间也不会自动发布其中的文档。

Markdown 原件及附件保留在这些目录里，元数据和恢复历史还需要正常备份 `/data`。外部编辑器仍可以继续使用原文件。完整行为、限制和恢复方式见[文档资料库说明](DOCUMENT_LIBRARY.md)。

## HTTPS

已有 HTTP 安装保持 **TLS certificate file** 和 **TLS private key file** 留空，**HTTPS-only cookies** 保持 `false`。如果已经由反向代理终止 HTTPS，两个直接 TLS 字段仍留空，通过代理的 HTTPS 地址访问时将 **HTTPS-only cookies** 设为 `true`。代理上游和网络开放范围按[传输加密说明](TRANSPORT_SECURITY.md)配置。

要让 Home 直接提供 HTTPS：

1. 准备匹配的证书链和私钥，证书应覆盖客户端实际使用的主机名或 IP，且客户端信任其签发 CA。证书目录与文档根目录分开。
2. 在 **Docker → Lingshu-Home → Edit** 中增加 **Read Only** Path，例如把已有证书目录 `/mnt/user/appdata/lingshu-home-tls` 映射到 `/certs`。确保 UID `99` / GID `100` 能读取文件，不要向所有用户开放私钥读取权限。
3. **TLS certificate file**（`LINGSHU_TLS_CERT_FILE`）填 `/certs/fullchain.pem`，**TLS private key file**（`LINGSHU_TLS_KEY_FILE`）填 `/certs/privkey.pem`。填写的是文件路径，不是 PEM 正文；旧模板没有这两项时，手动补充这两个 Variable。
4. 在高级视图中把 **WebUI** 改为 `https://<证书覆盖的主机名>:[PORT:8080]`，主机名需解析到这台 Unraid。如果证书覆盖实际服务器 IP，也可用 `https://[IP]:[PORT:8080]`。容器端口保留 `8080`；未修改宿主机端口时仍使用 `5180`。
5. 应用配置，检查日志，再使用 `https://<证书覆盖的主机名>:5180` 访问；修改过端口则替换为实际端口。直接 TLS 自动使用 Secure Cookie，Home 在该监听端口提供 HTTPS，不会另开一个端口或自动添加 HTTP 跳转。

两个 TLS 字段必须成对设置。文件不可读、证书与私钥不匹配或内容无效时会阻止启动，Home 不会退回明文 HTTP。证书由外部机制续期，更新后重启 Home 加载新证书。公开模板为兼容旧安装仍保留 HTTP WebUI 默认值，因此启用 HTTPS 时需同步修改该实例保存的 WebUI 地址。

HTTPS 保护浏览器／Agent 流量，不会加密磁盘上的 Markdown，也不会自动加密宿主机到 NAS 的连接；这些需由存储和网络挂载配置保障。详见[传输加密边界](TRANSPORT_SECURITY.md)。

## 备份、重建和升级

**0.0.5 → 0.0.6** 会为 SQLite 或 PostgreSQL 自动执行新增式**迁移 009（活动）和 010（登录保持）**。从 0.0.4 直接升级则依次执行 008（0.0.5 引入）、009 和 010。保留原 Appdata 映射、运行身份、私密的 `storage.json` 或显式数据库环境、保存语言、文档／证书挂载、允许根目录及 HTTP／TLS／反向代理配置；导航、页面布局、文档元数据与发布状态继续保存在同一数据库中。活动组件不需要额外卷或凭据。更早的 0.0.1 实例还会执行迁移 007，并遵守其一次性语言规则。

`/data` 中包含 `lingshu-home.db`、`csrf.key` 和 `integrations.key`，以及 SQLite 运行时文件、实例锁和编辑文档后产生的 `document-history`。已保存图标、文档标签／关联及发布快照存放在数据库中。停止 Home 后备份**整个专用数据目录**，确保数据库、恢复历史与对应密钥成套保留；还需备份每个外挂原件目录及附件，因为这些原件不在 appdata 里。如果已配置 PostgreSQL，还要备份该外置数据库。只导出数据库或重新扫描 Markdown 都不能替代这套组合备份。

重建相同版本时，保留原 Appdata 宿主机路径、运行用户和其他配置。删除容器不需要删除 appdata。

模板使用 `latest`，跟随已经成功发布、SemVer 版本号最高的正式稳定版。草稿和预发布版不会成为 `latest`，也可使用精确版本标签固定安装。已有安装如果固定在旧的精确标签，需手动将 **Repository** 改为 `ghcr.io/zhigege666/lingshu-home:latest` 一次，之后才会跟随稳定版。`latest` 标签更新不会直接升级运行中的容器；阅读升级要求后，通过 Unraid 的更新操作或已配置的自动更新任务拉取镜像并重建容器。

已安装容器有自己保存的模板。本仓库模板更新不会替换你配置好的宿主机路径、语言或 Repository 选择，新可选字段也可能尚未出现在这份本地配置中。需要启用新功能时，在 **Edit** 中按上文增加准确的 Variable 和 Path 映射即可。只升级镜像不需要重新安装 Home、删除 appdata 或替换整份已保存模板；如果刷新模板，应用前先核对最终配置。

升级到新版本时：

1. 阅读该版本的[发行说明](https://github.com/zhigege666/Lingshu-Home/releases)和迁移要求。
2. 停止 Home，完整备份专用数据目录、可能使用的外置数据库及外挂文档／附件，并保留旧镜像。首次从 0.0.1 升级时，保留原本使用的 **Interface language** 值。
3. **Repository** 使用 `ghcr.io/zhigege666/lingshu-home:latest` 跟随稳定版，或使用 `ghcr.io/zhigege666/lingshu-home:0.0.6` 等已发布的精确标签固定版本。保留 `/data`、原 Appdata 宿主机路径、已有文档／证书挂载和 `--user=99:100`。
4. 修改 Repository 后应用配置；已经使用 `latest` 时，通过 **Check for Updates → Update（检查更新 → 更新）**，让 Docker Manager 拉取镜像并重建容器。
5. 检查日志，打开 WebUI，登录并确认原来的链接和设置仍然存在。

从 0.0.6 退回 0.0.5 时，停止 Home，使用 0.0.5 镜像并恢复其 009/010 升级前匹配的数据库／数据目录、密钥与存储／部署配置；继续退回 0.0.4 则需要迁移 008 前的备份。恢复数据库不会撤销外挂原件中的编辑，这些文件需单独恢复对应备份。不要用旧镜像直接打开迁移后的数据库，也不要删除迁移记录。详见[存储与回退](STORAGE.md)。

## 排错与支持

- **端口被占用：**修改 WebUI 的宿主机端口，容器端口保留 `8080`。WebUI 模板通过 `[PORT:8080]` 查找映射后的端口。
- **/data 下出现权限错误：**核对实际映射路径、归属和权限，确认 `99:100` 可写。已有目录不会自动迁移；不要通过特权模式或向所有用户开放写权限来掩盖问题。
- **重新出现初始化页面：**先停止并检查 Appdata 映射，避免初始化另一个数据库。复用镜像但更换宿主机路径不会自动搬迁数据。
- **启用安全 Cookie 后无法登录：**使用已配置的 HTTPS 地址，或在直接 HTTP 访问时将该选项改回 `false`。
- **启用直接 TLS 后 WebUI 仍打开 HTTP：**在已保存模板的高级视图中把 WebUI 地址改为 HTTPS，并使用证书覆盖的地址；端口映射不变。
- **TLS 启动失败：**检查是否成对填写了文件路径变量、是否有独立的只读证书挂载、`99:100` 的读取权限，以及证书和私钥是否匹配；证书不能放在允许的文档根目录下。
- **文档目录为空或不可用：**先核对实际已有宿主机目录／NAS 挂载、映射与权限，以及容器路径 JSON 允许列表，再在 Home 中确认文件缺失。Docker Manager 中的路径拼写错误可能产生一个新的空目录。
- **镜像拉取失败：**检查完整镜像名、版本标签，以及宿主机对 GHCR 的 DNS 和网络连通性。模板需要 Linux amd64 发行镜像。
- **停止不完整或数据库被占用：**同时检查 Unraid 的全局 Docker 停止超时与容器默认值，允许至少 30 秒停止时间，并确认只有一个 Home 进程在使用此数据目录。

安装问题和可复现缺陷请提交到 [GitHub Issues](https://github.com/zhigege666/Lingshu-Home/issues)，附上 Unraid 版本、镜像标签、相关非敏感配置和脱敏日志。不要附加数据库、实例密钥、密码或访问令牌。

## 模板维护

公开安装模板为 [templates/lingshu-home.xml](../templates/lingshu-home.xml)，仓库资料为 [ca_profile.xml](../ca_profile.xml)，均适用仓库的 [Apache-2.0 许可证](../LICENSE)。

发布仓库与 Community Applications 收录是两个步骤。通过[官方提交入口](https://ca.unraid.net/submit)提交公开仓库，并按[官方模板文档](https://ca.unraid.net/submit/help/repository-xml)依次执行 **Validate** 和 **Scan**。只有确认商店条目后，才应描述为已经收录。

等效 Docker 部署测试可以验证镜像、运行身份和持久化行为，但不能替代通过 Unraid WebUI 进行的实际安装。

一手参考：[Unraid 容器映射与环境变量](https://docs.unraid.net/unraid-os/using-unraid-to/run-docker-containers/managing-and-customizing-containers/)、[Community Applications 保存的配置](https://docs.unraid.net/community-applications/)、[模板字段说明](https://ca.unraid.net/submit/help/xml-field-reference)及 [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)。
