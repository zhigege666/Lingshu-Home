# Home 测试用例索引

本文件定义可复用的测试场景与现有执行入口，覆盖用户、开发维护者和 AI Agent。首次整理依据为 0.3.1 源码（`0e874ce`）及公开行为契约；0.3.2 的重点是事项侧栏选中状态与查询条件的一致性。

**本索引不记录“本版本全部通过”。所有场景默认未执行，实际结果按版本另记。** [tests/README.md](../tests/README.md) 保留执行方法与历史证据；旧版本结果、测试文件存在、构建成功或 PostgreSQL 分支跳过，都不能替代本轮通过记录。下列编号表示场景组，组内断言数、数据库分支数和独立用例数分别统计。

## 使用与风险分层

1. 从实际改动选取相关场景。普通界面修复执行受影响交互、请求与结果断言、必要构建和四尺寸检查；不默认重跑全部模块。
2. 权限、数据持久化、迁移、并发写入及发布变化必须覆盖对应失败路径。修改数据库行为时分别验证 SQLite/PostgreSQL；环境缺失记为阻塞或跳过，不记为通过。
3. 已通过且相关代码未变的结果可以引用其精确提交与环境，不重复执行；修复失败后只重测失败及受影响部分。同一根因连续三轮无进展时重新分析。
4. 浏览器、HTTP、原文件编辑和迁移测试使用自己创建的可丢弃实例、数据库与挂载目录。现有脚本的夹具限制各不相同，应先读取其前置条件；不放宽保护以连接日常实例。公开报告不包含账号、令牌、连接串、私有路径或真实文档。
5. 源码回归、托管 CI、正式制品核验、实际实例升级分别记录。发布不会自动证明某个已运行实例安装了新版本。

优先级：**P0** 为数据、权限、核心流程或发布阻断；**P1** 为相关功能改动时的重点回归；**P2** 为按负载、平台或历史风险触发的扩展验证。优先级不是每次全量执行要求。

## 1. 用户体验（UX）

### 事项导航：0.3.2 必测场景

统一夹具包含仅待我处理、仅有阻塞、两者均有、两者均无的事项，以及跨项目、已归档、今日、逾期和绑定当前账号的事项。“待我处理”来自独立标记；“有阻塞”来自未完成的实际依赖；“我负责的”匹配真实账号，不依赖显示名称。必须有只满足单个条件的数据，才能发现误用交集。

主入口为 [browser_work_navigation.cjs](../tests/browser_work_navigation.cjs)，必要时复用 [browser_work_context.cjs](../tests/browser_work_context.cjs)、[browser_work_planning.cjs](../tests/browser_work_planning.cjs) 和 [browser_work_schedules.cjs](../tests/browser_work_schedules.cjs) 中对应检查。当前轮次以执行报告实际列出的组为准。

| 编号 | 优先级 | 前置条件与操作 | 可观察的预期 |
| --- | --- | --- | --- |
| UX-001 | P0 | 全部事项 → 有阻塞 → 待我处理 → 全部事项，使用四类不同匹配数据 | 切到待我处理后不残留 `blocked` 条件，只高亮当前入口；能看到“仅待我处理”的事项。返回全部后两个快捷条件均清除。标题、请求参数、返回结果与当前项一致。 |
| UX-002 | P0 | 待我处理 → 有阻塞；继续切换今日、逾期、我负责的、全部；重复点击当前入口 | 普通快捷入口互斥；不会叠加上一个入口的条件；重复点击当前项幂等，不把已选视图意外取消。今日/逾期仍按业务日期/截止时间，负责人仍按实际账号过滤。 |
| UX-003 | P0 | 在筛选面板明确组合待我处理、阻塞及其他条件，再修改或清空组合 | 合法组合条件仍取交集；组合语义显示为“筛选结果”，不会以两个当前导航项表达。清空条件后恢复相应普通视图，原有组合筛选能力保留。 |
| UX-004 | P1 | 打开私有/共享保存视图，再切普通快捷入口；返回视图并改变筛选 | 保存视图有独立当前项语义，不与普通快捷项同时高亮；打开视图使用其已保存配置。临时更改不暗中覆盖保存内容；不同调用者仍按视图权限访问。 |
| UX-005 | P1 | 项目 → 快捷入口 → 已归档 → 定时事项 → 普通事项，分别检查已有项目及归档事项 | 项目、归档和普通快捷入口在同层不双亮；项目与归档条件按目标入口明确切换，结果无残留交集；定时页面不误标普通事项入口。归档项目/事项的原有行为保留。 |
| UX-006 | P1 | 使用现有事项/保存视图深链；刷新，再使用浏览器前进/后退；切换有权限的空间 | 对现有 URL 契约支持的状态，标题、当前项、查询与详情同步恢复；不把尚未持久化的临时条件当作已保存状态。空间切换不读取前一空间的事项；不凭本用例新增 URL 持久化承诺。 |
| UX-007 | P0 | 在未保存的事项草稿中改变内容，然后切换快捷项、项目、归档或空间；分别选择继续编辑和放弃 | 离开保护有效；取消切换保留草稿及原视图；确认切换后只应用目标视图的条件。不会因修复选中状态而丢弃正文、引用或创建上下文。 |
| UX-008 | P1 | 在 2560×1440、1920×1080、1600×900、2560×1080 操作上述入口，抽查浅/深主题及键盘 | 当前项可辨识、焦点与选中可区分、标题与页头操作不重叠；侧栏和内容无新增页面横向溢出。几何断言与真实截图分别留证，不以截图张数代替功能通过数。 |

UX-001/002 同时断言 DOM 当前项、网络请求条件和结果中的特征事项；不能只检查 CSS 类名。UX-006 以实际支持的链接范围验收，不把刷新后的全部状态重置一概判为缺陷。

### 全 Home 功能目录

以下场景按模块改动触发；本次导航修复不意味着这些场景已全部重跑。

| 编号 | 优先级 | 操作与预期 | 现有入口与公开契约 |
| --- | --- | --- | --- |
| UX-009 | P1 | 新增/编辑分类、文件夹和书签，预览 HTML 导入；取消保留原数据，保存后刷新保留内容；分类折叠、搜索、更多与卡片/目录样式不改归属 | [browser_navigation_workflow.cjs](../tests/browser_navigation_workflow.cjs)、[browser_navigation_preview.cjs](../tests/browser_navigation_preview.cjs)、[用户指南](USER_GUIDE.zh-CN.md) |
| UX-010 | P0 | 行内批量修改、跨分类拖动、删除及排序后保存/取消；冲突保留草稿；删除书签不删除关联 Markdown 原文件 | [browser_home_content_edit.cjs](../tests/browser_home_content_edit.cjs)、[browser_bulk_delete.cjs](../tests/browser_bulk_delete.cjs)、[navigation_batch_delete_test.go](../server/internal/home/navigation_batch_delete_test.go) |
| UX-011 | P1 | 可视化编辑器添加/复制/隐藏组件，调整布局、主题、页眉页脚，撤销/重做、预览、取消与保存 | [browser_visual_composer.cjs](../tests/browser_visual_composer.cjs)、[browser_edit_boundaries.cjs](../tests/browser_edit_boundaries.cjs)、[COMPONENTS.md](COMPONENTS.md)；临时预览不写入，主题切换保留数据与组件绑定 |
| UX-012 | P1 | 图标选择/导入/自动抓取，点击明确配置的内外网入口及普通附加链接 | [browser_icons.cjs](../tests/browser_icons.cjs)、[browser_auto_icons.cjs](../tests/browser_auto_icons.cjs)、[browser_network_routing.cjs](../tests/browser_network_routing.cjs)、[NETWORK.md](NETWORK.md)；手工图标和既有缓存保留，附加链接不参与内外网探测，空闲首页不扫描网络 |
| UX-013 | P1 | 资料库按来源/文件夹搜索、打开书签说明与原文档；来源离线或扫描异常后查看并恢复 | [browser_document_library.cjs](../tests/browser_document_library.cjs)、[DOCUMENT_LIBRARY.md](DOCUMENT_LIBRARY.md)；保留文档身份、关系和恢复历史，不把挂载异常当作文件全部删除 |
| UX-014 | P0 | 原文件编辑与外部修改冲突、读取比较、另存副本、恢复历史及显式发布 | [browser_document_library.cjs](../tests/browser_document_library.cjs)、[documents_recovery_test.go](../server/internal/home/documents_recovery_test.go)；冲突保留输入，只读来源禁止改原件，发布使用授权快照，附件遵守同一边界 |
| UX-015 | P1 | 点击统计、资料活动热力图/日历、数据源组件刷新与预置布局 | [browser_link_clicks.cjs](../tests/browser_link_clicks.cjs)、[browser_document_activity.cjs](../tests/browser_document_activity.cjs)、[browser_components.cjs](../tests/browser_components.cjs)、[browser_dashboard_presets.cjs](../tests/browser_dashboard_presets.cjs)；真实记录与缺失数据分开，预览不制造点击/活动或同步上游 |
| UX-016 | P0 | 创建事项、复制短编号/链接、搜索与定位、刷新继续编辑；模拟创建已提交但响应丢失；四尺寸居中弹窗、保存并关闭、焦点恢复与草稿保护 | [browser_work_short_ids.cjs](../tests/browser_work_short_ids.cjs)、[browser_work_dialog.cjs](../tests/browser_work_dialog.cjs)、[browser_work_context.cjs](../tests/browser_work_context.cjs)、[WORK_ITEMS.md](WORK_ITEMS.md)；服务器分配短编号，原 `requestId` 核对，不重复建卡；编号与标题同行，保存结果未确认不自动关闭，隐藏文档引用不被无意清空 |
| UX-017 | P0 | 状态增删改排序与默认值、卡片移动、事项/项目归档恢复、活动分页 | [browser_work_items.cjs](../tests/browser_work_items.cjs)、[work_statuses_test.go](../server/internal/home/work_statuses_test.go)；迁移占用状态是原子操作，筛选隐藏项保持顺序，时间轴只记实际变更 |
| UX-018 | P1 | 维护标签、负责人、目标版本及父子/依赖/前序关系，打开日历、WIP 和统计 | [browser_work_planning.cjs](../tests/browser_work_planning.cjs)、[WORK_PLANNING.md](WORK_PLANNING.md)；拒绝环和不兼容版本，取消不解除“须完成”依赖，WIP 只提示，未知时长不显示为零 |
| UX-019 | P0 | 新建/预览定时规则、暂停恢复、月末/DST、错过策略、手动同日重复生成、发生记录定位 | [browser_work_schedules.cjs](../tests/browser_work_schedules.cjs)、[WORK_SCHEDULES.md](WORK_SCHEDULES.md)；同规则同日唯一，暂停期不补造，配置修改只影响未来，失权/失效项目明确失败 |
| UX-020 | P0 | 开启通知/事件规则或执行器，检查失败回执、取消、未知结果与人工核实 | [browser_work_planning.cjs](../tests/browser_work_planning.cjs)、[WORK_AUTOMATION.md](WORK_AUTOMATION.md)；默认关闭，未知结果保留资源占用，不自动再 POST，不因适配器成功直接完成事项 |
| UX-021 | P0 | 同令牌双会话认领、进展更新、交接、人工补充/解除及协作开关热变化 | [browser_work_collaboration.cjs](../tests/browser_work_collaboration.cjs)、[browser_mcp_settings.cjs](../tests/browser_mcp_settings.cjs)、[WORK_COLLABORATION.md](WORK_COLLABORATION.md)；不覆盖人工草稿，旧代次写入被拒绝，关闭后已有认领仍受保护 |
| UX-022 | P0 | 资料/头像/密码与会话保持；四种访问模式、个人/共享空间、模块开关、PAT 变更 | [browser_admin_account.cjs](../tests/browser_admin_account.cjs)、[browser_header_avatar.cjs](../tests/browser_header_avatar.cjs)、[browser_session_recovery.cjs](../tests/browser_session_recovery.cjs)、[browser_integration_tokens.cjs](../tests/browser_integration_tokens.cjs)；旧权限及时失效，个人空间隔离，关闭模块保留数据与草稿 |
| UX-023 | P0 | 空实例选择 SQLite/PostgreSQL、确认一次性语言、初始化并真实重启；测试连接失败与已配置存储不可用 | [browser_initialization.cjs](../tests/browser_initialization.cjs)、[browser_storage_setup.cjs](../tests/browser_storage_setup.cjs)、[browser_language_recovery.cjs](../tests/browser_language_recovery.cjs)、[STORAGE.md](STORAGE.md)；不静默换库/重置实例，已保存语言保持 |
| UX-024 | P0 | 按公开说明安装发布包或更新容器，保留数据与配置并真实重启；按迁移要求验证可恢复备份 | [RELEASING.md](RELEASING.md)、[UNRAID.zh-CN.md](UNRAID.zh-CN.md)、[STORAGE.md](STORAGE.md)；确认实际运行版本、页面资源和持久数据。固定镜像、`latest` 与已安装容器分别核验 |

## 2. 开发体验（DX）

| 编号 | 优先级 | 操作与预期 | 现有执行入口 |
| --- | --- | --- | --- |
| DX-001 | P0 | 保存缺陷复现基线与修复后证据，测试表达真实点击、请求条件和结果；原始失败不能被最终通过覆盖 | [browser_work_navigation.cjs](../tests/browser_work_navigation.cjs)；执行报告记录基线/候选提交、具体失败断言及修复后组 |
| DX-002 | P1 | 检查导航状态转换、保存视图与组合筛选，不复制实现逻辑来生成同义测试；共享逻辑变化时覆盖既有行为 | 导航专用浏览器入口及 [browser_work_planning.cjs](../tests/browser_work_planning.cjs)；已有纯核心测试在 [tests/](../tests/) 按实际影响选择 |
| DX-003 | P0 | TypeScript 类型检查和生产前端构建；脚本语法、差异空白、公开文档链接及版本一致性 | `web/package.json` 的 `npm run build`、`node --check`、`git diff --check`、[check_repository.py](../scripts/check_repository.py)；构建通过不代替浏览器交互 |
| DX-004 | P0 | 修改 HTTP/权限时覆盖 Cookie/CSRF、PAT scopes、只写回执、跨空间隐藏与模块关闭 | `TestHTTPStorageAndPermissions`、`TestHTTPPostgresStorageAndPermissions`、`TestModuleBoundariesPreserveDataAndNavigation`、`TestWorkBoardHTTPAndMCP`；按相关套件配置独立数据库 |
| DX-005 | P0 | 修改写路径时覆盖陈旧 revision、同请求重放、并发创建/移动、事务失败、保存后响应丢失 | `TestWorkCreationPlacementReplay`、`TestWorkCreationPlacementConcurrent`、`TestWorkShortIDConcurrentCreation`、`TestWorkStatusesLateFailureRollsBackBatch`、[navigation_batch_edit_test.go](../server/internal/home/navigation_batch_edit_test.go) |
| DX-006 | P0 | 修改数据模型时分别验证 SQLite/PostgreSQL 从对应历史边界升级、原数据/引用/排序保留、注入失败整体回滚与重启 | [work_short_ids_migration_test.go](../server/internal/home/work_short_ids_migration_test.go)、[work_schedule_migration_test.go](../server/internal/home/work_schedule_migration_test.go)、[documents_migration_test.go](../server/internal/home/documents_migration_test.go) 及受影响 `*_migration_test.go`；不篡改历史目标版本以绕过断言 |
| DX-007 | P1 | 修改事项查询/写入时核对 SQL 预算、批量投影、真实历史与认领收尾，不引入逐卡查询 | `TestWorkBoardQueryBudget`、`TestWorkCollaborationBatchedSummary`、`TestWorkMutationPreparedQueryBudget`、`TestWorkMutationPreparedContextReply`、`TestWorkEmptyReferenceMutationQueries` |
| DX-008 | P2 | 修改后台调度或性能路径时分别观测未使用、关闭、暂停、启用无任务与集中负载，保留并发前台读取 | [performance_work_idle.py](../tests/performance_work_idle.py)、[performance_work_automation_idle.py](../tests/performance_work_automation_idle.py)、[PERFORMANCE.md](PERFORMANCE.md) 中 opt-in Go 入口；报告采样窗口、数据量、错误和环境，零 tick 不等于零启动/内存成本 |
| DX-009 | P0 | 修改代理、抓取或执行器网络路径时验证目标策略、重定向、超时、取消、凭据隔离及配置变化后的旧请求 | `TestNetworkProxyOwnerToDefaultClientAndIconCache`、`TestNetworkProxyGenerationCancelsDetachedDNSAndOpenTunnel`、`TestWorkExecutionProductionNetworkGeneration` 及 [icons_network_test.go](../server/internal/home/icons_network_test.go) |
| DX-010 | P0 | 修改存储/进程/容器时使用全新夹具做真实关闭重启、持久化与故障识别，不自动退回另一数据库 | [http_smoke.py](../tests/http_smoke.py)、[test_dev_launcher.py](../tests/test_dev_launcher.py)、[test_document_container.py](../tests/test_document_container.py)、[storage_runtime_test.go](../server/internal/home/storage_runtime_test.go)；完整 smoke 仅在相应风险或发布门禁触发 |
| DX-011 | P0 | 发布前核对 VERSION、日期 changelog、中英文 README、标签提交与打包内容，排除私有材料/凭据/数据库 | [test_release_documentation.py](../tests/test_release_documentation.py)、[test_release_packaging.py](../tests/test_release_packaging.py)、[RELEASING.md](RELEASING.md)；本地检查与托管 CI 结果独立记录 |
| DX-012 | P0 | 正式发布回读完整制品及 SHA-256、源提交和镜像身份；验证匿名拉取固定版本与 stable latest | [test_promote_latest.py](../tests/test_promote_latest.py)、[promote_latest.py](../scripts/promote_latest.py)、[RELEASING.md](RELEASING.md)；离线回归不代替真实发布可用性，已验证镜像不在发布阶段重新构建 |

后端用当前源码的测试名选择最小范围。历史报告中的旧测试名可能已随契约演进，不机械复制旧命令。例如当前入口为 `TestWorkDatesAndCreationReplay` 与 `TestWorkCollaborationCreationReplayAndStatusGuard`。定向运行示例：

```sh
# 从 server/ 运行；PostgreSQL 变量指向本次专用可丢弃数据库。
go test ./internal/home -run '^(TestWorkBoardHTTPAndMCP|TestWorkPlanningRelationsViewsCalendarWIP)$' -count=1 -v
```

这条示例是事项查询或规划接口受影响时的选择，不要求纯导航 UI 修复重复运行已验证且未变化的后端。数据库变量及隔离要求见 [tests/README.md](../tests/README.md)。

## 3. AI Agent 使用体验（AG）

| 编号 | 优先级 | 操作与预期 | 现有执行入口与契约 |
| --- | --- | --- | --- |
| AG-001 | P0 | 从业务读取或 `space_current {}` 获取当前空间与能力，再检索项目/用例；不要求用户手填可发现的 ID | `TestMCPBoundSpace`、`TestMCPDefaultFiltersAndBatchErrorDetails`、[INTEGRATIONS.md](INTEGRATIONS.md)；省略空间使用本次令牌绑定，显式跨空间仍鉴权 |
| AG-002 | P0 | 比较运行 Home、网关发布与调用端定义，核对名称、schema、描述和一次真实业务调用 | `TestIntegrationHTTPMCPAndTraffic`、`TestMCPWorkflowContextAndGatewayDiscovery`、`TestMCPCollaborationDiscoveryAndCapabilities`；不能只凭工具数量认定可用，发现工具不授予调用权限 |
| AG-003 | P0 | 创建事项并丢弃响应，用原 `requestId` 查回或按原载荷重放，再用短编号读写/搜索/关联 | `TestMCPWorkShortIDContract`、`TestWorkShortIDRecoveryAndScope`、`TestWorkShortIDConcurrentCreation`；拒绝旧长卡片 ID、W 编号和调用方自定卡片 ID，不重复创建 |
| AG-004 | P0 | 用真实版本更新事项；冲突后比较草稿，终态事项的新版本工作另建或定位未完成任务 | `TestMCPTaskBoundaryGuidance`、`TestMCPWorkflowContextAndGatewayDiscovery`、[WORK_ITEMS.md](WORK_ITEMS.md)；不只换 revision 强写，不自动重开历史完成事项来累计无限工作 |
| AG-005 | P0 | 同 token 登记两个执行会话，竞争认领、续租、交接、关闭/恢复与旧代次写入 | `TestMCPCollaborationSameTokenWorkflow`、`TestWorkCollaborationContentionRecoveryAndOffProtection`、`TestWorkCollaborationTerminalReleaseAtomicAndReplay`；同令牌不等于同会话，未知结果保留原 operation ID 核对 |
| AG-006 | P0 | 分页读取事项业务活动与协作事件，改变期间继续原游标，并检查跨空间/只写权限 | `TestWorkActivityPermissionsAndMCP`、`TestWorkCollaborationEventsSnapshotAndIsolation`；快照边界稳定，历史不冒充执行验收，写回执不泄露无权读取的正文 |
| AG-007 | P0 | 发现可写文档目录，读取 revision 后创建/修改测试文档；测试只读、缺失原件与异常扫描 | `TestDocumentMCPDestinations`、`TestDocumentMCPUnavailableOriginal`、`TestDocumentWriteGuardAfterSuspiciousScan`、[DOCUMENT_LIBRARY.md](DOCUMENT_LIBRARY.md)；有效 `canWrite` 与实际写边界一致，不换目录兜底 |
| AG-008 | P0 | 用完整导航快照与版本进行批量修改，维护书签使用说明；对比只读、只写和读写令牌 | `TestNavigationBatchMovesHTTPAndMCP`、`TestNavigationWriteOnlyReceipts`、`TestBookmarkContextAndAgentScopes`；使用稳定 ID，原子失败不留半批，说明文本不作为授权 |
| AG-009 | P0 | 定时规则先预览，再保存/生成；未知生成结果读取发生记录，同日重复请求 | `TestWorkSchedulesHTTPAndMCP`、`TestWorkScheduleRecoveryAndAtomicity`、`TestWorkScheduleRestartRecovery`；一个发生日期对应一个事项，配置版本与运行状态分离，重启不重复生成 |
| AG-010 | P1 | 通过 MCP 维护规划字段、关系、保存视图并读取日历/统计/通知 | `TestWorkPlanningMetadataHTTPMCP`、`TestWorkPlanningRelationsViewsCalendarWIP`、`TestWorkPlanningRelationClaimProtection`；私有视图仍隔离，结构化负责人不授予权限，未知统计覆盖明确返回 |
| AG-011 | P0 | 事件规则或手动执行使用显式执行能力；检查超时、重启、资源占用、轮询和迟到结果 | `TestWorkExecutorsPermissionsAndReceipts`、`TestWorkExecutionAuthorityAndClaimAtDispatch`、`TestWorkExecutionHTTPOutsideTransactionAndLateCAS`、`TestWorkExecutionRestartDoesNotRedispatch`；只写权限不能间接触发外部执行，不凭超时重新 POST |
| AG-012 | P0 | 改变工作流/协作配置、令牌范围或模块状态后继续调用，并将本轮测试结果回写到独立版本记录 | `TestMCPSettingsRuntimeContextAndClaimCleanup`、`TestIntegrationTokenEditingAndLivePermissions`、`TestModuleBoundariesPreserveDataAndNavigation`；能力读回反映实际设置，撤权立即生效，回写带 revision，未执行/阻塞与通过分开 |

Home MCP 中保存这份用例索引及每个版本的执行报告时，应复用已发现的项目、目录和文档身份。先检索再创建，更新使用当前文档版本；案例设计、实际执行、缺陷和发布回执相互关联，不建立无法收敛的重复任务。

## 按版本记录结果

执行报告使用下面的最小字段；需要时在 Home 资料库维护同一结构，并关联本次事项。

| 字段 | 内容 |
| --- | --- |
| 版本与源码 | 目标版本、实际 commit；未提交候选需注明差异标识，不能仅写“最新版” |
| 范围 | 选择的 UX/DX/AG 编号、具体子步骤；未选范围及原因 |
| 环境 | SQLite/PostgreSQL、浏览器、语言、分辨率和必要特性开关；不包含凭据 |
| 前置数据 | 自建夹具及关键条件，是否存在交集/非交集数据；清理状态 |
| 实际结果 | `未执行 / 通过 / 失败 / 阻塞 / 不适用`；跳过单独列出原因 |
| 证据 | 命令与最终退出码、具名检查、请求/结果断言、脱敏报告或截图；保留失败与续验过程 |
| 缺陷闭环 | 原因、修复范围、失败后重测范围；同编号关联后续记录 |
| 发布 | 本地验证、托管 CI、标签/Release、下载校验、固定镜像/latest、实际安装分别记录 |

### 0.3.2 的选择边界

本轮重点为 UX-001～UX-008、DX-001～DX-003，以及受影响公开文档/发布的 DX-011～DX-012。使用 Home MCP 创建/更新用例与版本任务可以为 AG-001、AG-004、AG-007、AG-012 提供**相应子步骤**的真实证据，不能据此宣称这些组的所有权限和失败分支已覆盖。

若最终只修改前端导航、测试与文档，不默认重跑全部定时、执行器、数据库迁移或容量测试。相关后端/请求链实际发生变化时再纳入对应组。正式发布仍执行 [RELEASING.md](RELEASING.md) 规定的门禁；本文件不削弱发布流程。
