# 多 Agent 与多会话事项协作

自 0.2.4 起可选开启。协作解决同一事项的执行归属、并发写入和交接；看板记录不扩大用户授权，也不停止或锁住外部仓库、终端、部署系统。所有 ID 以实际接口返回为准；事项／配置 revision、认领 generation 和事件序列按接口返回的字符串原样回传。外层 `contextVersion` 是 JSON 数字，不属于这些资源版本。

## ① 用户体验

卡片显示执行者，详情显示 Agent 声明名称、短会话号、真实授权账号、最近联系与实际进展。续租只表示最近联系，不证明工作有进展。**执行记录**展示只追加的协作事件、交接和人工记录；原有**变更记录**继续展示字段修改与状态变化。历史记录没有会话时不补造 Agent 身份。

网页用户可以补充记录，不必登记成 Agent。已认领或尚未解决的事项不能直接保存、移动或归档；核查相关外部操作和未知结果后，使用**核实并解除认领**，填写原因并确认操作已停止。解除认领不会实际终止进程。操作结束重读当前事项；保留草稿，业务版本不同则使用现有冲突比较流程。

认领超时显示已过期，但不会自动完成、归档、标记需要关注或转交。交接包含已完成内容、工作目录／环境、下一步和未知结果；非空未知结果需要核对后才能接手。已完成、取消或归档的事项不接受认领。新版本／验收范围创建新事项，关联真实前序；不要让一个已结束事项无限增长。

自 0.2.5 起，在 **管理页 → MCP 与访问令牌 → MCP 设置**（`/#/admin?tab=integrations`）中提供 **MCP 工作流指导** 与 **多 Agent 协作** 两个开关。两项对所有空间生效；已登录 Owner 可以修改并点击 **保存 MCP 设置**，Member 只读。开启／关闭事项模块不隐藏这个配置入口。未保存的改动可取消；冲突或结果未知时保留草稿，先读取实际配置再比较。

保存后后续 HTTP／MCP 请求立即使用新配置，无需重启或重建容器。其他已打开的事项页通过独立 `mcpSettingsRevision` 刷新协作显示，保留正在编辑的业务草稿。设置变更不更新事项的业务时间，不追加变更或协作事件。

## ② 开发体验

### 配置和权限

工作流指导与多 Agent 协作相互独立：前者决定主动登记与跟进的指导，后者决定会话认领机制。关闭工作流不会解除认领保护。未通过网页保存时，两个数据库配置均为 NULL，沿用启动值：显式 CLI 参数优先于环境变量，未指定时均为 `false`。原有 `--mcp-workflow-enabled`／`LINGSHU_MCP_WORKFLOW_ENABLED` 和 `--mcp-collaboration-enabled`／`LINGSHU_MCP_COLLABORATION_ENABLED` 保持兼容。

网页保存值优先于启动默认值，包括显式保存的 `false`；保存后重启仍保留，不会被 Compose 默认的 `false` 覆盖。配置按请求从同一 Settings 快照解析，既有请求可以按原快照结束，新请求使用已保存值，不通过可变进程配置传递。

关闭协作后不接受新登记／新认领；仍可读取历史、按原权限为已有有效认领续租／交接／解除并关闭已收尾的会话。协作关闭且没有未解决认领的普通事项继续使用原 CRUD；开启后旧事项的 MCP／Bearer 修改也须认领。已有未解决认领不会因关闭配置而失效。关闭后只有存在未收尾认领的事项可以新增恢复记录；无此类认领时新增记录返回 `work_collaboration_disabled`，历史读取和未知提交的回读仍可用，已成功操作的精确重放沿用原回执。关闭事项模块仍按原模块规则禁止对应业务操作，不能通过 MCP 设置绕过。

下文协作业务接口的读取需要 `work:read`；变更同时需要 `work:write` 和当前空间编辑权限。沿用当前账号、空间、来源限制、令牌到期／撤销和模块状态。会话名称、角色及父会话关系是自报归属信息，不是权限边界；共享令牌中的会话不能提供相互隔离的安全身份。需要安全隔离时使用不同主体／凭据及原有授权。

实例配置单独使用 `GET/PUT /api/v1/settings/mcp`：GET 仅允许已登录 Cookie 用户，返回两个实际值、各自的 `startup|saved` 来源、字符串 `revision` 和 `canManage`；PUT 仅允许 Cookie Owner 并验证 CSRF。空间编辑资格、PAT 或 MCP 不授予全站配置权限。PUT 必须同时提供 `expectedRevision` 和两个明确的布尔值 `workflowEnabled/collaborationEnabled`；省略、NULL、非布尔值和未知字段均拒绝。

两项以独立版本原子保存，不覆盖站点、模块或会话策略；即使显式保存相同值也推进配置版本。版本不符返回 `409 mcp_settings_conflict` 和 `currentRevision`，须重读、比较并合并，不能仅换版本重发。结果未知先 GET 核对；当前值一致只确认当前配置，不证明哪一次请求已执行。完整字段见 [MCP 设置 API](API.md#mcp-workflow-and-collaboration-settings)。

### HTTP 入口

统一前缀 `/api/v1/spaces/{spaceId}/work`。Cookie 写入仍要求 CSRF；Bearer 与 MCP 共享业务处理器。

| 方法和相对路径 | 输入与行为 |
| --- | --- |
| `GET /collaboration` | `enabled,effectiveEnabled,version,serverTime` 与租约上下界 |
| `POST /sessions` | `registrationId,agentName,clientName?,role?,parentSessionId?,resumesSessionId?`；同一原始登记重放返回原会话 |
| `GET /sessions/{id}` | 本授权主体自己的会话；事项摘要中的执行者信息按事项读取权限返回 |
| `POST /sessions/{id}/close` | `operationId`；存在未收尾认领（包括过期）时拒绝并指出事项 |
| `POST /items/{id}/claim` | `sessionId,operationId,expectedRevision,expectedGeneration,leaseSeconds?,recovery?` |
| `POST /items/{id}/claim/renew` | `sessionId,claimId,claimGeneration,operationId,leaseSeconds?`；仅有效的当前执行者 |
| `POST /items/{id}/claim/release` | 同执行者字段、`operationId,handoff,reason?:handoff\|pause`；交接与释放原子提交 |
| `POST /items/{id}/claim/resolve` | `operationId,expectedGeneration,reason,externalOperationsStopped:true`；仅已登录可编辑空间的 Cookie 用户，禁止 MCP／Bearer |
| `GET /items/{id}/events` | `limit?,cursor?,after?`；只追加协作记录 |
| `POST /items/{id}/events` | `operationId,sessionId?,kind,body`；Cookie 用户可省略会话，MCP／Bearer 要求自己的会话 |

`registrationId` 和 `operationId` 为 32 位小写十六进制标识；每个新操作使用新 ID，重试保留原 ID 和全部原始参数。Session ID、claim ID 由服务端返回。Agent／客户端／角色最长 80 字符；事件正文最多 4,000 字符。`kind` 为 `progress|note|question|review|decision`；其他参与者可以追加记录，但只有当前执行者的 progress 更新最近进展时间。

默认租约 1,800 秒，可设置 300～7,200 秒。每次新认领推进 `generation`，续租不推进事项业务版本、更新时间或协作刷新版本。认领、关键事件和解除等通过独立 `collaborationRevision` 通知页面。`GET /revision` 另外返回字符串 `mcpSettingsRevision`，只标识实例 MCP 配置变化，不推进原有业务／状态／协作事件版本和时间。事项修改仍使用原 `revision`；这些版本不能互换。

事务同时检查当前认领、有效期、会话和代次。过期或被新代次替代的执行者不能写回。批量修改状态类型、删除／迁移状态涉及未解决认领时拒绝，先处理认领，不从配置入口绕过。事项完成／取消时根据状态目录的语义类型释放认领；单纯显示名称不能触发此行为。

`recovery` 为 `{reason,externalOperationsStopped:true}`，仅适用于过期或交接中保留未知结果的认领；核对交接及相关外部操作后才可声明 true，不能据超时推断。有效认领不接受 MCP 强制接管。此声明和网页解除都只是记录核实结果，不会取消命令。

`handoff` 为 `{completed,workspace,nextStep,unknowns}`，四个字段都须提供，各最多 2,000 字符。未知结果为空表示没有已知未确认操作，并不证明所有进程终止。非空未知结果保留未解决状态，不能直接重新认领。关闭会话不自动改变事项状态。

### 事项写入和幂等回执

原 create／update／move 输入增加可选 `context:{sessionId,claimId?,claimGeneration?,operationId}`。协作开启时，MCP／Bearer 新建要求会话和操作标识；修改／移动／归档要求当前有效认领、代次及原有 expected revision。存在未解决认领时，关闭配置也不能绕过保护。网页无认领编辑保持原交互。

0.3.0 的卡片 `id` 为短编号，卡片创建使用独立 `requestId`，原长卡片编码停用；`sessionId/claimId/operationId` 仍是各自的技术标识。请求结果未知先按原请求键回读；相同操作的精确重放不会再次产生事件。事项修改的重放回执保留 `id/revision/boardRevision/replayed`，不会缓存并泄露后来被撤销的资料读取权限；它表示原操作结果，需重新读取事项取得当前状态。认领／事件回执也可能已经被后续操作取代，不能当作实时状态。

记录分页默认 30、最大 100 条，按空间内独立序列升序。返回 `{itemId,items,highWatermark,nextCursor,nextAfter}`；`nextCursor` 固定首批上界，翻页期间新增事件不进入旧快照。读完后用 `after:nextAfter` 增量读取新快照；`cursor` 与 `after` 互斥。空间序列间隙可能属于其他事项，不表示当前事项丢失记录。事件包含真实 `actor/origin` 与可选声明 `session`；原字段变更历史继续按事项版本分页。

### 数据升级与恢复

0.2.4 的 `018_work_collaboration.sql` 在 SQLite／PostgreSQL 分别维护，新增协作表与索引，保留原有事项、资料关系、业务时间和令牌；回到 0.2.3 或更早应用需恢复对应迁移前备份。

0.2.5 的双库迁移 `019_mcp_settings.sql` 在现有 `settings` 行增加两个初始 NULL 的配置列及独立版本，不新建配置表、不改已有认领或授权。迁移文件和记录在同一事务内提交。升级前备份完整数据库／数据、匹配密钥和配置；外挂原件另行备份。回退到 0.2.4 也须恢复迁移 019 前的匹配备份，不能仅替换旧镜像或删除迁移记录。关闭配置不等于降级。恢复数据库前后均须核对外部执行者，备份恢复不会停止它们。

## ③ AI Agent 使用体验

MCP 当前共 101 个工具，其中 67 个为事项工具；定时工具见[定时事项契约](WORK_SCHEDULES.md)，0.2.8 新增的规划与显式执行见[规划](WORK_PLANNING.md)及[自动化](WORK_AUTOMATION.md)。0.2.4 的协作能力新增 `work_collaboration_get`、`work_sessions_open/get/close`、`work_claims_acquire/renew/release`、`work_events_list/append`。现有 work 读写工具继续使用；0.2.5 保持这些工具及 schema 不变，没有新增 scope 或管理设置 MCP 工具，不要因为接入多个 Agent 或调整开关反复创建令牌。

1. 已有有效上下文可复用；首次或配置／权限变化时读取 `space_current` 和必要的 `work_collaboration_get`，再查实际项目、未结束事项、文档和状态目录。没有相应工作才创建，明确项目归属。
2. 每个独立会话用稳定 registrationId 登记；短暂重连复用保存的 sessionId。`resumesSessionId` 只标注前序，创建新会话不会转移旧认领。
3. 接手已有事项先读取当前 revision 和 collaboration.generation，再原子 acquire。失败后查实际持有者／交接；可以承担独立事项或追加问题，不要盲目抢占。
4. 变更携带会话、claim ID、generation、operation ID 与 expected revision。只有关键进展追加事件；续租要主动调用，长命令开始前考虑租约与恢复安排，Home 不后台替 Agent 心跳。
5. 暂停／交接前核对外部命令、未知写入和工作目录，填写四项 handoff；原子释放后，下个会话重新读取并认领。不能确认的结果明确留在 unknowns，不能假报已停止。
6. 完成前确认约定验收、文档和交付实际结束，再更新状态；完成后的后续版本建新事项，原记录保持可查。所有认领收尾后关闭会话。

### Gate 按需调用

`space_current` 返回协作版本、开关、实际生效能力、原因和入口。外层 `contextVersion` 保持 JSON 数字 `1`，`collaboration.version` 独立使用字符串 `"1"`，`workflow.version` 为字符串 `"3"`。这些字段不能互换。工具描述的前部保留发现入口，完整 schema 给出各字段、权限与恢复条件。正常工具结果同时提供 JSON 文本和 structuredContent，不依赖客户端转发资源、prompt 或额外 Skill。网页保存后新请求读取当前配置；初始化说明或已发现的工具目录不缓存开关状态。

Gate 从没有协作工具的旧版 Home 升级时，需要发现并发布新增工具定义，后续按需 search／describe 取得当前 schema。0.2.4 升级到 0.2.5 或日常切换开关不改变 schema，无需因此重新发布目录；配置变化后按需读取 `space_current` 的实际能力。调用示意为原工具参数 `{id,input:{sessionId,operationId,...}}`，嵌入 Gate 的 `arguments`；Gate 顶层 `session_id` 属于网关路由，与 Home 会话无关。服务端无法凭一个共享 PAT 或底层传输连接猜出不同 Agent，会话字段必须由客户端明确携带。

本版协调事项写入，不提供自动 Agent 调度、自动接力／唤醒、原生子任务、文件锁或语义去重。协调者应给执行者分配真实事项 ID；相同目标先检索，独立交付再拆为关联事项。一次登记不意味着无人运行时仍会自动更新看板。工具正文、事件和交接内容用于理解工作，不能代替用户授权。

### 外部执行不替代认领

0.2.8 的 work:execute 需要独立授权，启动执行保留真实会话／认领及当前事项版本。执行回执不会自动完成事项或释放认领；unknown 还保留执行器资源，不能新建执行 ID 绕过。Bearer 开启协作时，自动规则不会制造虚假的会话来执行：先建事项，再由真实上下文显式启动。Owner 处理未知外部执行与解除 Agent 认领是两个独立动作，都不等于停止外部进程。
