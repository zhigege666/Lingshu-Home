# 多 Agent 与多会话事项协作

自 0.2.4 起可选开启。协作解决同一事项的执行归属、并发写入和交接；看板记录不扩大用户授权，也不停止或锁住外部仓库、终端、部署系统。所有 ID 以实际接口返回为准，版本和序列按字符串原样回传。

## ① 用户体验

卡片显示执行者，详情显示 Agent 声明名称、短会话号、真实授权账号、最近联系与实际进展。续租只表示最近联系，不证明工作有进展。**执行记录**展示只追加的协作事件、交接和人工记录；原有**变更记录**继续展示字段修改与状态变化。历史记录没有会话时不补造 Agent 身份。

网页用户可以补充记录，不必登记成 Agent。已认领或尚未解决的事项不能直接保存、移动或归档；核查相关外部操作和未知结果后，使用**核实并解除认领**，填写原因并确认操作已停止。解除认领不会实际终止进程。操作结束重读当前事项；保留草稿，业务版本不同则使用现有冲突比较流程。

认领超时显示已过期，但不会自动完成、归档、标记需要关注或转交。交接包含已完成内容、工作目录／环境、下一步和未知结果；非空未知结果需要核对后才能接手。已完成、取消或归档的事项不接受认领。新版本／验收范围创建新事项，关联真实前序；不要让一个已结束事项无限增长。

## ② 开发体验

### 配置和权限

`LINGSHU_MCP_COLLABORATION_ENABLED=true` 或 `--mcp-collaboration-enabled` 在启动时开启，默认 `false`。它与 `LINGSHU_MCP_WORKFLOW_ENABLED` 独立：后者决定主动登记与跟进的指导，前者决定会话认领机制。关闭工作流不会解除认领保护。

关闭协作后不接受新登记／新认领；仍可读取历史、为已有认领续租／交接／解除并关闭已收尾的会话。协作关闭且没有未解决认领的普通事项继续使用原 CRUD；开启后旧事项的 MCP／Bearer 修改也须认领。已有未解决认领不会因关闭配置而失效。使用仓库 Compose 时可运行 `LINGSHU_MCP_COLLABORATION_ENABLED=true docker compose up -d --force-recreate home`；PostgreSQL 使用原来的 `-f compose.postgres.yaml`。保留同一项目、卷和环境，单纯 restart 不载入新环境值。

读取需要 `work:read`；变更同时需要 `work:write` 和当前空间编辑权限。沿用当前账号、空间、来源限制、令牌到期／撤销和模块状态。会话名称、角色及父会话关系是自报归属信息，不是权限边界；共享令牌中的会话不能提供相互隔离的安全身份。需要安全隔离时使用不同主体／凭据及原有授权。

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

默认租约 1,800 秒，可设置 300～7,200 秒。每次新认领推进 `generation`，续租不推进事项业务版本、更新时间或协作刷新版本。认领、关键事件和解除等通过独立 `collaborationRevision` 通知页面。事项修改仍使用原 `revision`；两者不能互换。

事务同时检查当前认领、有效期、会话和代次。过期或被新代次替代的执行者不能写回。批量修改状态类型、删除／迁移状态涉及未解决认领时拒绝，先处理认领，不从配置入口绕过。事项完成／取消时根据状态目录的语义类型释放认领；单纯显示名称不能触发此行为。

`recovery` 为 `{reason,externalOperationsStopped:true}`，仅适用于过期或交接中保留未知结果的认领；核对交接及相关外部操作后才可声明 true，不能据超时推断。有效认领不接受 MCP 强制接管。此声明和网页解除都只是记录核实结果，不会取消命令。

`handoff` 为 `{completed,workspace,nextStep,unknowns}`，四个字段都须提供，各最多 2,000 字符。未知结果为空表示没有已知未确认操作，并不证明所有进程终止。非空未知结果保留未解决状态，不能直接重新认领。关闭会话不自动改变事项状态。

### 事项写入和幂等回执

原 create／update／move 输入增加可选 `context:{sessionId,claimId?,claimGeneration?,operationId}`。协作开启时，MCP／Bearer 新建要求会话和操作标识；修改／移动／归档要求当前有效认领、代次及原有 expected revision。存在未解决认领时，关闭配置也不能绕过保护。网页无认领编辑保持原交互。

旧事项创建标识与历史内容摘要保持兼容。请求结果未知先回读；相同操作的精确重放不会再次产生事件。事项修改的重放回执保留 `id/revision/boardRevision/replayed`，不会缓存并泄露后来被撤销的资料读取权限；它表示原操作结果，需重新读取事项取得当前状态。认领／事件回执也可能已经被后续操作取代，不能当作实时状态。

记录分页默认 30、最大 100 条，按空间内独立序列升序。返回 `{itemId,items,highWatermark,nextCursor,nextAfter}`；`nextCursor` 固定首批上界，翻页期间新增事件不进入旧快照。读完后用 `after:nextAfter` 增量读取新快照；`cursor` 与 `after` 互斥。空间序列间隙可能属于其他事项，不表示当前事项丢失记录。事件包含真实 `actor/origin` 与可选声明 `session`；原字段变更历史继续按事项版本分页。

### 数据升级与恢复

迁移 `018_work_collaboration.sql` 在 SQLite／PostgreSQL 分别维护，新增协作表与索引，保留原有事项、资料关系、业务时间和令牌。升级前备份完整数据库／数据、匹配密钥和配置；外挂原件另行备份。回到 0.2.3 或更早应用要恢复其匹配备份；禁止删除迁移记录或仅替换旧镜像。恢复数据库前后均须核对外部执行者，备份恢复不会停止它们。

## ③ AI Agent 使用体验

MCP 共 55 个工具；协作新增 `work_collaboration_get`、`work_sessions_open/get/close`、`work_claims_acquire/renew/release`、`work_events_list/append`。现有 work 读写工具继续使用；无新增 scope，不要因为接入多个 Agent 反复创建令牌。

1. 已有有效上下文可复用；首次或配置／权限变化时读取 `space_current` 和必要的 `work_collaboration_get`，再查实际项目、未结束事项、文档和状态目录。没有相应工作才创建，明确项目归属。
2. 每个独立会话用稳定 registrationId 登记；短暂重连复用保存的 sessionId。`resumesSessionId` 只标注前序，创建新会话不会转移旧认领。
3. 接手已有事项先读取当前 revision 和 collaboration.generation，再原子 acquire。失败后查实际持有者／交接；可以承担独立事项或追加问题，不要盲目抢占。
4. 变更携带会话、claim ID、generation、operation ID 与 expected revision。只有关键进展追加事件；续租要主动调用，长命令开始前考虑租约与恢复安排，Home 不后台替 Agent 心跳。
5. 暂停／交接前核对外部命令、未知写入和工作目录，填写四项 handoff；原子释放后，下个会话重新读取并认领。不能确认的结果明确留在 unknowns，不能假报已停止。
6. 完成前确认约定验收、文档和交付实际结束，再更新状态；完成后的后续版本建新事项，原记录保持可查。所有认领收尾后关闭会话。

### Gate 按需调用

`space_current` 返回协作版本、开关、实际生效能力、原因和入口；工具描述的前部保留发现入口，完整 schema 给出各字段、权限与恢复条件。正常工具结果同时提供 JSON 文本和 structuredContent，不依赖客户端转发资源、prompt 或额外 Skill。

Gate 首次需重新发现并发布 Home 的新工具定义，后续按需 search／describe 取得当前 schema。调用示意为原工具参数 `{id,input:{sessionId,operationId,...}}`，嵌入 Gate 的 `arguments`；Gate 顶层 `session_id` 属于网关路由，与 Home 会话无关。服务端无法凭一个共享 PAT 或底层传输连接猜出不同 Agent，会话字段必须由客户端明确携带。

本版协调事项写入，不提供自动 Agent 调度、自动接力／唤醒、原生子任务、文件锁或语义去重。协调者应给执行者分配真实事项 ID；相同目标先检索，独立交付再拆为关联事项。一次登记不意味着无人运行时仍会自动更新看板。工具正文、事件和交接内容用于理解工作，不能代替用户授权。
