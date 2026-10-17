# Lingshu-Home

**以导航为核心的独立个人面板，通过数据源、展示组件、布局与主题连接你的常用服务。**

**An independent, self-hosted personal dashboard built around navigation, data sources, widgets, layouts, and themes.**

## 项目状态

当前处于设计与基础资源准备阶段。已确定 Apache-2.0 许可证，建立产品说明、图标清单、版本与变更记录，以及仓库检查和源码发布流程。

当前版本见 [VERSION](VERSION)。现阶段的发布产物为源码和资源包；Docker 镜像及 Windows、macOS 安装包属于后续实现目标。

## 产品方向

- **导航优先**：在 Home 自身维护分类、项目、多个环境入口、链接和书签，支持 Chrome HTML 书签导入。
- **可组合页面**：链接卡片、紧凑目录、搜索、分类 Tab 和外部数据组件按布局组合；前两种导航设计保留为可切换预设。
- **可配置布局与主题**：分类导航可放在顶部、左侧、右侧、底部或隐藏；位置、密度、组件配置与颜色主题分开保存。
- **四种访问模式**：完全开放、公开浏览并登录维护、登录单用户、登录多用户。
- **三种数据更新方式**：实时获取、定时主动同步、外部推送；数据来源异常时保留可用导航与允许保留的上次结果。
- **独立部署与接入**：优先 Docker/Linux，提供自己的后台和 API；外部 Admin、知识库、监控与其他组件按接口接入。
- **桌面路线**：规划 Windows/macOS 客户端，先连接已部署的 Home，再评估使用同一后端的本机独立模式。

以上为设计目标。功能实现状态以本 README 和版本更新记录为准；内部设计资料另行维护，不随源码或发布包提供。

## 文档与资源

| 内容 | 入口 |
| --- | --- |
| 产品定位、当前状态与入口 | 本 README |
| 每次变更的记录 | [CHANGELOG.md](CHANGELOG.md) |
| 仓库协作与文档维护约束 | [AGENTS.md](AGENTS.md) |
| 初始离线图标和来源 | [assets/icons/manifest.json](assets/icons/manifest.json) |
| 第三方资产许可 | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |
| 校验与发布脚本 | [scripts](scripts) |

## 开发与发布约束

每次提交变更都要维护 `CHANGELOG.md`，并同步受影响的 README 或公开文档；内部设计资料另行维护。版本号统一读取 `VERSION`。发布标签、版本文件和对应版本更新记录必须一致。

提交与 CI 以公开 README/文档为依据；内部设计文档和视觉稿按忽略规则保留在维护环境，不进入 Git 跟踪或发布资产。

仓库校验使用 Python 3.10+ 和 Git：

```bash
python3 scripts/check_repository.py
```

GitHub Actions 在 PR 和主分支推送时执行检查；推送合法版本标签后，源码发布流程从对应版本的 CHANGELOG 条目生成更新说明并打包资源。当前不会产生可运行的 Home 服务或桌面客户端。

## License

Copyright 2026 zhigege666 and Lingshu-Home contributors.

项目原创代码与文档采用 [Apache License 2.0](LICENSE)。第三方图标等资产保留各自许可，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。产品名称和品牌标识的使用不因代码许可证而自动获得商标授权。
