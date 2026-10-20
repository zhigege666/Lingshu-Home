<img src="https://raw.githubusercontent.com/zhigege666/Lingshu-Home/v0.0.1/web/src/assets/lingshu-home-logo.svg" alt="Lingshu-Home 标识" width="80" height="80">

# Lingshu-Home

[English](README.md) | **简体中文**

**以导航为核心的独立个人面板。**

在 Home 中维护链接、导入浏览器书签，并用数据源、组件、布局与主题拼装首页。项目提供自己的后台、账号、数据库、HTTP API 与 MCP 接口，其他服务通过可选集成接入。

Web 界面统一使用玉绿色折带房屋 Logo。[品牌资产、用法与来源](docs/BRANDING.md)记录原生 SVG、浏览器图标和触屏图标。

## 快速开始

**[0.0.1](VERSION)** 是首个应用发行版。Linux amd64 程序、Docker 镜像归档、源码与校验和见 **[v0.0.1 发布页](https://github.com/zhigege666/Lingshu-Home/releases/tag/v0.0.1)**。正式程序和镜像面向 **Linux amd64（x86-64）**。选择下面一种安装方式即可；均默认使用内置 SQLite，无需另装数据库或其他 Home 服务。

### Docker 镜像

使用 Docker 直接运行正式镜像：

```bash
docker run -d --name lingshu-home \
  --restart unless-stopped \
  --stop-timeout 30 \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  -p 127.0.0.1:5180:8080 \
  -e LINGSHU_LANGUAGE=zh-CN \
  -v lingshu-home-data:/data \
  ghcr.io/zhigege666/lingshu-home:0.0.1
```

在 Docker 宿主机打开 **http://127.0.0.1:5180**。数据库、实例密钥和已保存图片持久化在命名卷 `lingshu-home-data`，替换容器时继续使用这个卷。镜像以 UID/GID `10001:10001` 运行；自定义挂载到 `/data` 的目录需允许该身份写入。可以用 `docker logs --tail=100 lingshu-home` 查看启动日志。

### Linux amd64 发行包

从发布页下载 `Lingshu-Home-0.0.1-linux-amd64.tar.gz`，解压后在该目录运行，无需安装 Go 或 Node.js：

```bash
tar -xzf Lingshu-Home-0.0.1-linux-amd64.tar.gz
cd Lingshu-Home-0.0.1-linux-amd64
./lingshu-home --language zh-CN --data-dir "$HOME/.local/share/lingshu-home"
```

在运行 Home 的机器上打开 **http://127.0.0.1:5180**，使用期间保持终端运行。上面的命令把数据放在版本目录之外，升级后继续使用同一路径。保留发行包中的 `web/dist` 和 `VERSION`，在解压目录启动，或显式配置它们的路径。服务参数可用 `./lingshu-home -help` 查看。

以上示例都只在宿主机回环地址开放访问。其他设备需使用配置后的发布地址或 HTTPS 反向代理地址。由反向代理提供 TLS，并为 HTTPS 部署设置 `LINGSHU_SECURE_COOKIES=true`；这个变量只要求 Cookie 通过 HTTPS 传输，不会让 Home 自行启用 TLS 监听。

### Unraid

使用 [Unraid 模板和安装说明](docs/UNRAID.zh-CN.md)，通过 Docker Manager 或 Community Applications 安装。模板将宿主机 `5180` 映射到容器 `8080`，数据保存在 `/mnt/user/appdata/lingshu-home`，并明确以 `99:100` 访问该数据目录。模板固定使用 `0.0.1` 镜像，文档包含初始化、中英文切换、备份和指定版本升级方法；Apps 尚未收录时可手动安装模板。

### 首次初始化

1. 填写站点名称并选择访问方式。默认是**公开浏览**（公开只读，`public_read`）：访客可以读取已发布的共享内容，维护需要 Owner；个人空间仍然私有。
2. 需要账号的模式会要求创建 Owner。Home 没有默认管理员账号或密码。用户名为 3–40 位英文字母、数字或 `. _ -`，密码为 10–128 个字符，显示名称选填。**完全开放**可以免账号运行；勾选**同时创建管理员（可选）**即可在初始化时创建 Owner。
3. 需要示例时勾选**填充示例导航**，选择**中文网站预置**或**英文网站预置**，也可以展开**预览将添加的网站**。示例默认关闭，只填入共享空间。
4. 点击**创建我的 Home**。创建 Owner 后会自动登录；完全开放和公开浏览初始化后进入共享空间，不受是否勾选示例影响。
5. 有维护权限的空白首页提供**添加第一个链接**和**导入浏览器书签**，直接进入相应的后台流程；也可从**管理中心**进入链接/分类管理、导入导出和首页设置。

启动语言覆盖初始化、登录、首页和后台，默认 `zh-CN`；上面的命令显式使用简体中文。示例内容包与界面语言独立选择，Home 不会自动读取个人浏览器数据。所选且仍有权限的空间会在同一浏览器标签内跨整页刷新保留；该偏好区分登录账号与匿名身份，不会跨设备同步。

### 保留数据与正常停止

上述 Docker 实例使用 `docker stop lingshu-home` 和 `docker start lingshu-home` 停止、启动，停止等待时间为 30 秒。Linux 前台进程按 `Ctrl+C` 后等待退出。正常停止不需要删除数据。

升级前先停止 Home，备份数据库及与其匹配的实例密钥，新版本继续使用原命名卷或 `--data-dir`。下方源码 Compose 部署使用属于该项目的 `home-data` 卷；更换安装方式不会自动移动数据。外置 PostgreSQL 也需要保留本地密钥。升级或降级前阅读[备份与迁移说明](docs/STORAGE.md)。

日常操作见 **[中文使用手册](docs/USER_GUIDE.zh-CN.md)** 或 **[English user guide](docs/USER_GUIDE.md)**，包括账号、链接维护、书签与图标导入、可视化编辑、主题、分类联动、页面内容、语言、外部接入与恢复。

## 功能

| 模块 | 能力 |
| --- | --- |
| 前端 | React + TypeScript + Vite；管理界面采用 REUI 公开的 MIT 组件 |
| 后端 | Go HTTP 服务；同一服务提供前端静态页面、API 与 MCP |
| 存储 | 默认内置 SQLite；同时支持外置 PostgreSQL，两者分别维护版本迁移 |
| 导航 | 分类与嵌套文件夹、链接、标签、收藏、项目多个 URL、排序、搜索和 JSON/HTML 导出 |
| 后台 | 固定工作区、紧凑表格、链接/分类 25/50/100 条分页、统一键盘可操作表单与内联校验 |
| 书签 | Chrome/Netscape HTML 预览与导入、文件夹层级、去重方式和数量/大小限制 |
| 首页 | 紧凑工具栏；卡片/目录；浅色/深色/系统；密度；分类置顶/左/右/底部/隐藏，支持图文/纯图标/纯文字及树形/平铺 |
| 拼装 | 专用首页编辑器，包含组件库/页面结构、可选中画布与属性面板；固定区域或 24 列网格内添加、复制、隐藏、删除、移动、缩放和锁定组件 |
| 主题 | 经典导航与 iOS 风格两款整页主题；导航/收藏组件分别选择图文、简约文字或应用图标样式 |
| 页面内容 | 页眉页脚六个槽位直接在画布选中；文字、链接与可移除品牌共用页面草稿，统一保存/取消/恢复 |
| 图标 | 30 个可搜索的离线 Lucide 图标、当前空间图标库或图片导入、默认开启自动获取网页图标并缓存到服务端；每条链接可手动选图 |
| 品牌 | 统一玉绿色折带房屋 SVG；SVG/PNG 浏览器标签图标与 180 px 触屏图标 |
| 语言 | 启动时选择整站英文或简体中文，默认 `zh-CN` |
| 访问 | 四种模式；Owner/Member、可选注册、个人私有空间和共享空间 |
| 集成 | 类型化外部推送与 HTTP JSON 查询、ICS 日程、Open-Meteo 天气、统计/状态组件、GitHub Traffic、范围令牌和 MCP |
| 组件导入 | 公网 URL 或 JSON 模板预览、绑定本机兼容来源、随页面草稿保存；使用已安装的内置渲染器 |
| 分发 | Linux amd64 程序与 Docker 镜像；Windows 与 macOS 原生客户端仍在规划中 |

链接区域是首页主体。宽屏以 2560 × 1440 为主要目标，搜索框保持紧凑，小屏使用响应式排列。初始化时可选择示例导航；Home 不会自动读取个人浏览器数据。

## 运行截图

以下为 `0.1.0-dev.1` 开发版在 2560 × 1440 浏览器中的历史运行截图，使用[公开示例书签](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/tests/fixtures/demo-bookmarks.html)。桌面图片拍于验收中实际保存并整页重载之后，测试结束已恢复原演示配置。英文画面中的中文分类/书签是保留的用户内容。各图的拍摄状态和手机端示例见[截图记录](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/assets/screenshots/README.md)。

### iOS 风格首页

![Lingshu-Home 内置 iOS 风格主题，展示应用图标导航、分类和自定义页脚](https://raw.githubusercontent.com/zhigege666/Lingshu-Home/v0.0.1/assets/screenshots/home-ios-zh-CN-2k.png)

### 首页可视化编辑器

![Lingshu-Home 可视化编辑器，展示页面结构、可选中画布与主题属性](https://raw.githubusercontent.com/zhigege666/Lingshu-Home/v0.0.1/assets/screenshots/home-editor-ios-zh-CN-2k.png)

同轮其他实拍：[英文 iOS 首页](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/assets/screenshots/home-ios-en-2k.png) · [390 px 手机编辑画布](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/assets/screenshots/home-editor-mobile-zh-CN-390.png)。

更早的经典首页、后台与预览截图作为历史示例保留，统一见[截图记录](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/assets/screenshots/README.md)。

## 从源码构建

本节命令需要完整源码，不能直接在 Linux 程序发行包中执行。使用 Git 获取对应版本源码：

```bash
git clone --branch v0.0.1 --depth 1 https://github.com/zhigege666/Lingshu-Home.git
cd Lingshu-Home
```

### 从源码构建 Docker 镜像

安装 Docker 与 Compose 插件后，构建并启动默认 SQLite 部署：

```bash
LINGSHU_LANGUAGE=zh-CN docker compose up -d --build
```

在 Docker 宿主机打开 **http://127.0.0.1:5180**。这个 Compose 文件构建 `lingshu-home:local`，将容器 `8080` 端口发布到宿主机回环 `5180`，并将属于该 Compose 项目的 `home-data` 卷挂载到 `/data`。两份 Compose 的停止等待时间都是 30 秒。后续启动保留同一个项目身份和数据卷。

使用已有的外置 PostgreSQL 时，先建立 Home 专属数据库，允许应用执行迁移，并提供从容器可达的连接地址：

```bash
export LINGSHU_DATABASE_URL='postgres://home_user:replace_me@db.example:5432/lingshu_home?sslmode=require'
LINGSHU_LANGUAGE=zh-CN docker compose -f compose.postgres.yaml up -d --build
```

单独使用 PostgreSQL 文件，并在后续命令中保留私有数据库环境配置。该文件不会创建 PostgreSQL 服务，实例密钥仍需保存在数据卷中；切换 provider 不会迁移已有数据。详见[存储与备份说明](docs/STORAGE.md)。

导入图标和网页缓存保存在所选数据库内，不需要额外上传卷。迁移 **`005_auto_icons.sql`** 保存自动图标设置、链接选择模式和有界待办；**`006_network_routing.sql`** 保存默认开启的浏览器选路和服务端代理配置。旧图标、普通附加入口及之前迁移的校验和保持不变。回退到不认识已应用迁移的旧程序，需要恢复对应的数据库和密钥备份，仅替换程序或镜像不能完成回退。

构建使用固定依赖与基础镜像摘要。可用 `NODE_IMAGE`、`GO_IMAGE`、`RUNTIME_IMAGE` 和 `GOPROXY` 构建参数选择可达镜像源，同时保留经过核对的镜像摘要。

### 本地构建与启动

构建需要 **Go 1.26.8**、**Node.js 24.19.0 与 npm**、**Python 3.10+**。

```bash
python3 scripts/dev.py build
python3 scripts/dev.py start --language zh-CN
python3 scripts/dev.py status
```

打开 **http://127.0.0.1:5180**。构建内容包括前端、Go 服务程序与依赖原始许可证。开发脚本默认将持久化数据保存在源码目录的 `data/`。

```bash
python3 scripts/dev.py stop
# 也可以前台运行：
python3 scripts/dev.py run --listen 127.0.0.1:5180 --language zh-CN
```

后台启动脚本面向 Linux 开发环境，停止前会核对自己启动的进程身份，不安装系统服务。可以通过 `LINGSHU_GO`、`LINGSHU_NODE`、`LINGSHU_NPM` 指定便携工具链。开发前端时，让 API 运行在 `127.0.0.1:5180`，再在 `web/` 中执行 `npm run dev`；Vite 会代理应用 API 请求。

### 运行配置与语言

| 环境变量 | 默认值 / 含义 |
| --- | --- |
| `LINGSHU_LISTEN` | 独立程序 `127.0.0.1:5180`；正式镜像内 `0.0.0.0:8080` |
| `LINGSHU_DATA_DIR` | SQLite 与实例密钥；默认 `data/`，镜像内为 `/data` |
| `LINGSHU_STORAGE_PROVIDER` | `sqlite` 或 `postgres`；默认 `sqlite` |
| `LINGSHU_DATABASE_URL` | PostgreSQL 连接串；选择 `postgres` 时必填 |
| `LINGSHU_WEB_DIR` | 前端构建目录；独立程序 `web/dist`，镜像 `/app/wwwroot` |
| `LINGSHU_VERSION_FILE` | 产品 `VERSION` 文件；镜像内为 `/app/VERSION` |
| `LINGSHU_LANGUAGE` | 默认 `zh-CN`，可选 `en`；整个运行实例的固定语言 |
| `LINGSHU_SECURE_COOKIES` | Cookie 是否仅允许 HTTPS；本地 HTTP 默认 `false` |

快速开始的 Docker 命令通过 `-e LINGSHU_LANGUAGE=zh-CN` 选择语言。发行包支持 `./lingshu-home --language zh-CN`，源码构建后的程序支持 `./dist/lingshu-home --language zh-CN`；显式参数优先于环境变量。英文使用 `en`。

更换语言需要停止后重启程序，或使用新环境和同一持久化位置重新创建容器；单纯 Docker 或 Compose `restart` 不会应用新环境变量。Compose 可将 `LINGSHU_LANGUAGE` 保留在部署环境或同目录的私有 `.env` 中，后续 `up` 也继续使用。界面没有语言切换器，也不自动跟随浏览器。已有站点、空间、页面、链接、分类和自定义文字保持原文；新建默认空间/页面使用运行语言，可选示例链接使用初始化时选择的内容包。[语言设置操作](docs/USER_GUIDE.zh-CN.md#选择实例语言)。

## 四种访问模式

| 模式 | 浏览 | 维护 |
| --- | --- | --- |
| `open_edit` | 免登录浏览已发布共享内容 | 匿名维护这些内容；可以不创建 Owner |
| `public_read` | 免登录浏览已发布共享内容 | Owner 登录后维护共享内容和自己的个人空间 |
| `private_single` | 需要 Owner 登录 | 单个 Owner 维护实例 |
| `private_multi` | 需要账号登录 | Member 维护各自个人空间；Owner 管理账号与共享内容 |

首次设置默认选择 `public_read`。自助注册独立配置，默认关闭，只能在多用户模式开启。Owner 不能访问其他人的个人空间。切换模式时，个人空间仍为私有，旧会话与旧令牌授权会撤销。

浏览器写入使用与会话绑定的 CSRF 校验。即使导航允许匿名维护，管理集成凭据和个人访问令牌仍需要账号。免账号初始化不会开放一个不受限制的匿名 MCP 或凭据管理接口。

## 数据源、组件与主题

产品模型为 **数据源 + 展示组件 + 布局与主题**。本地导航是权威业务数据；移除面板、切换预设或改变分类位置会保留已有链接与分类。

内置 **经典导航**（`builtin/dashboard`）和 **iOS 风格**（`builtin/ios`）两款整页主题。切换主题只替换主题 ID，保留页面的数据源、组件、位置、自定义内容和外观设置；应用布局预设则会明确替换草稿中的组件排列。每个导航与收藏组件可分别选择**卡片/目录**，再独立选择**跟随主题/图标与文字/简约文字/应用图标**。未填写 `linkAppearance` 时跟随主题，明确选择的样式在换主题后保持不变。

具有维护权限时，在首页点击**编辑页面**进入专用工作区。普通头部替换为编辑工具栏；左侧是**页面结构**与**添加组件**，中间是实时画布，右侧编辑所选页面、组件或页眉页脚槽位。编辑窗口较窄时侧栏改为抽屉。可以添加搜索、分类、收藏、导航、GitHub Traffic、日程、天气、统计指标和服务状态；数据组件先绑定兼容来源，然后复制、隐藏、删除、调序或更换来源。组件使用固定区域或 24 列网格；拖动、尺寸、适应内容和锁定只调整展示，不改变链接归属，缩窄浏览器也不会覆盖桌面坐标。

分类导航本身就是可编辑组件，可置顶、居左、居右、置底或隐藏，支持图文、纯图标、纯文字、树形/平铺、数量与折叠。搜索、分类和链接通过友好联动组关联。普通浏览中的折叠属于当前页面/组件的标签页偏好，编辑时整栏折叠只修改草稿默认值。

页眉页脚全部六个槽位，包括空槽位，都能直接在画布选中并在同一个属性面板编辑。文字、HTTP/HTTPS 链接与品牌可在左右居中之间移动。保存前会检查所有槽位，包括关闭区域，并定位到有问题的内容。**保存页面**通过版本校验统一提交完整草稿；**预览**、**恢复**与**取消**不会保存。预览恢复正常头部展示，账号与管理控件仍由 Home 维护。默认品牌位于页脚右侧，可以移动或移除。

后台仍保留表单式页面编辑，可填写精确位置，并在 2560 × 1440、1920 × 1080、1600 × 900、2560 × 1080 下**预览首页**。两种预览均使用已授权来源投影，不触发上游同步，也不伪造缺失数据。[首页编辑、预览与页面内容操作](docs/USER_GUIDE.zh-CN.md#5-配置首页)。

链接、分类分页限制实际挂载行数，但浏览器仍持有当前授权快照，不属于后端分页。首页浏览工具按钮是临时状态，星标与明确的页面保存分别持久化对应数据。[保存范围说明](docs/USER_GUIDE.zh-CN.md#哪些操作会保存)。

组件与来源迭代增加了[模板导入、日程/天气与外部数据契约](docs/COMPONENTS.md)。模板配置已安装的渲染器；不会执行外部网页或安装远程 JavaScript。日程、天气、指标和状态只保留有界的最新快照，没有启用定时来源时调度器不周期唤醒。中英文初始化内容分别维护网站清单，可以独立于界面语言选择。

**编辑页面 → 添加组件 → 预置仪表板**提供个人概览、服务运行、数据统计三套布局。为需要的组件选择兼容来源，也可以明确跳过组件。应用预置会替换尚未保存的组件布局，保留当前主题、页眉页脚和有效的导航来源，再由**保存页面**持久化。预置本身不启动采集，也不填入演示数值。[预置布局与接入说明](docs/DASHBOARDS.md) · [版本化数据样例](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/examples/dashboard-data/README.md)。

扩展契约区分两类：接收指定数据格式的面板渲染器、组合多种数据的整页主题。第三方主题包安装、知识库连接器和通用实时适配器属于后续工作。后台与登录页由宿主提供。

### 图标库与网页图标

链接和分类共用可搜索图标选择器，可选 30 个内置 Lucide 图标、导入带版本的 JSON 图标库，或导入单张 PNG、JPEG、受支持的静态 SVG。图标库属于当前空间，保留来源和许可信息；如果删除会移除已保存内容所用图标的最后一份副本，服务端会拒绝删除。

**访问与账号 → 自动获取网页图标**默认开启。新建链接和导入浏览器书签默认使用自动模式，先保存书签，再由有界后台队列获取公网网站图标。手动选图会切换为手动模式；升级前的旧图标和离线预置图标保留原样。关闭开关会停止自动任务并保留已保存图片，链接表单仍可点击**获取网站图标**主动获取。

访问者读取 Home 自己提供、经过空间权限校验的图片；浏览器通过 ETag 重新验证后复用图片内容。打开首页不会触发网站请求或第三方 favicon 代理，空队列没有定时扫描。内网服务可导入本地图标。导入/删除图标库、主动获取网站图标会立即写入空间图标库/缓存；链接或分类的手动选图随表单保存。[图标操作与限制](docs/USER_GUIDE.zh-CN.md#选择或导入图标) · [图标存储、接口与抓取规则](docs/ICONS.md)。

### 网络设置与内外网入口

后台“网络设置”提供默认开启的浏览器自动选路，以及默认直连的服务端代理。书签可明确配置内网／外网入口；点击时优先选择预算内有响应的内网地址，浏览器无法检测时回退到外网或主入口。普通附加链接不参与探测，首页闲置时不扫描。

Owner 可指定 HTTP、HTTPS 或 SOCKS5 服务端代理，凭证加密保存且不回显。代理用于图标、组件模板、日程、天气和外部数据获取；书签打开仍遵循访问者的网络。网页组件导入支持发现并选择多个兼容模板、预览和绑定数据源。[网络配置、协议与限制](docs/NETWORK.md)。

### 外部写入与 MCP

外部客户端使用限制范围的个人访问令牌。`external-push` 数据源接收经过校验的导航、日程、天气、指标或状态完整快照，同时要求请求 ID，以及预期版本或递增序号。同一请求可幂等重放；冲突或过期更新会被拒绝。外部快照不会覆盖本地导航。

MCP 位于 **`/mcp`**，采用 Streamable HTTP，复用 HTTP API 的业务逻辑与授权。工具覆盖已授权的导航、书签、页面、数据源与同步。令牌范围、请求格式和客户端示例见 [API 说明](docs/API.md)与[集成指南](docs/INTEGRATIONS.md)。

### GitHub Traffic

GitHub Traffic 数据源支持定时采集和排队执行的手动刷新。首次完整成功采集会建立不可覆盖的仓库基线；本地持续保存 UTC 每日观测，超出 GitHub 滚动窗口后仍保留历史。缺失日期保持缺失，独立访客数量使用 GitHub 的统计口径。

在后台配置仓库与具有相应权限的 GitHub 令牌。Git 仓库 SSH 授权不等于 Traffic REST API 授权。Home 不自带真实仓库基线。令牌在服务端加密保存，不会发送给首页组件。上游失败时仍可读取已缓存数据，并分别显示新鲜度与错误状态。

## 验证与维护

以下命令在源码仓库中执行；发行包的运行检查见使用手册。

```bash
python3 scripts/check_repository.py
cd server
go test ./...
```

HTTP 验收使用新建的可丢弃实例，并执行真实进程重启，脚本会拒绝已初始化数据库与非回环目标。Go provider 测试通过 `LINGSHU_TEST_POSTGRES_URL`、`LINGSHU_TEST_INTEGRATIONS_POSTGRES_URL`、`LINGSHU_TEST_ICONS_POSTGRES_URL`、`LINGSHU_TEST_COMPONENTS_POSTGRES_URL` 和 `LINGSHU_TEST_COMPONENT_MIGRATION_POSTGRES_URL` 使用五个不同的全新 PostgreSQL 数据库；后两个分别覆盖组件数据源生命周期和升级保留/失败回滚。HTTP 验收另用自己的数据库。变量未设置而跳过测试不代表对应 provider 已验证。详见[测试步骤与覆盖范围](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/tests/README.md)和[数据库隔离要求](docs/STORAGE.md#provider-validation)。

每个变更集维护 CHANGELOG 与相关公开文档。`VERSION` 是唯一手工维护的产品版本来源，构建产物和发布标签均从它派生。更新说明来自对应日期版本节，自动发布需要先通过应用验证。创建或推送标签是独立的发布动作。

内部设计文档与视觉探索资料排除在 Git、Docker 上下文、前端资源和发布包之外。公开接口与部署说明维护在 `docs/` 中。

Tailwind 类名扫描明确限制在 `web/src`，构建输出目录、public 资源和私有文档不会影响生成样式。源码文件数量、产物一致性与浏览器耗时只适用于 [tests/README.md](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/tests/README.md) 和 [PERFORMANCE.md](docs/PERFORMANCE.md) 记录的那次运行，不作为持续性能承诺。

### 历史验证记录

以下段落描述前一轮编辑器/图标开发迭代，不代表 0.0.1 的全部验证结果。本次发布的实际范围以验收记录为准。

前一轮可视化编辑器已通过中英文各八组真实浏览器流程，包括主动保存、整页重载与修订校验后的恢复；图标导入、持久化、引用保护和非法图标包回滚也已在两种语言下验证。TypeScript 官网图标已实测获取成功并在再次请求时命中缓存；GitHub 获取在验收环境中仍出现超时。SQLite、独立 PostgreSQL 测试库和 Docker 运行检查均有该轮记录，实际范围见[验收记录](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/tests/README.md)。[性能报告](docs/PERFORMANCE.md)记录该开发版与其上一版的十二个独立桌面浏览器上下文对比。更早的界面检查作为历史证据保留。

## 文档

| 内容 | 入口 |
| --- | --- |
| English README | [README.md](README.md) |
| 中文使用手册 | [docs/USER_GUIDE.zh-CN.md](docs/USER_GUIDE.zh-CN.md) |
| English user guide | [docs/USER_GUIDE.md](docs/USER_GUIDE.md) |
| 性能方法与结果 | [docs/PERFORMANCE.md](docs/PERFORMANCE.md) |
| API 与页面配置 | [docs/API.md](docs/API.md) |
| Unraid 安装与升级 | [docs/UNRAID.zh-CN.md](docs/UNRAID.zh-CN.md) · [English](docs/UNRAID.md) |
| 存储、迁移与备份恢复 | [docs/STORAGE.md](docs/STORAGE.md) |
| 网络代理与书签内外网选路 | [docs/NETWORK.md](docs/NETWORK.md) |
| 预置仪表板与数据接入交接 | [docs/DASHBOARDS.md](docs/DASHBOARDS.md) |
| 数据源、推送、MCP、GitHub Traffic | [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) |
| 组件、日程/天气、模板导入与数据契约 | [docs/COMPONENTS.md](docs/COMPONENTS.md) |
| 图标库、格式与网页图标缓存 | [docs/ICONS.md](docs/ICONS.md) |
| 测试说明 | [tests/README.md](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/tests/README.md) |
| 变更记录 | [CHANGELOG.md](CHANGELOG.md) |
| 协作约束 | [AGENTS.md](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/AGENTS.md) |
| 内置图标来源 | [assets/icons/manifest.json](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/assets/icons/manifest.json) |
| 版本与发布 | [docs/RELEASING.md](docs/RELEASING.md) |
| 第三方许可 | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |

## 许可证

Copyright 2026 zhigege666 and Lingshu-Home contributors.

原创代码与文档采用 [Apache License 2.0](LICENSE)，第三方组件与资产保留原始许可。代码许可证不授予项目名称或品牌标识的商标使用权。
