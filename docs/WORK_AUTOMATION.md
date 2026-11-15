# 事件规则与事项执行器

0.2.8 提供事件生成事项和显式 HTTP 执行器。默认不启用事件规则，也不创建执行器。定时事项仍按 [固定日历规则](WORK_SCHEDULES.md)生成独立事项；只有显式配置的执行器才能收到外部运行请求。

## 1. 用户体验

事项页按需打开规则、事件、执行器和执行记录。普通事项的执行记录入口默认收起，不为每张卡片轮询执行器。页面保存失败、版本冲突和未知结果保留当前草稿／回执，不能将 HTTP 请求已返回当作任务已完成。

规则包含名称、精确事件类型、可选项目／状态筛选、一份事项模板和可选执行器。规则自身默认停用；空间事件自动化开关也默认关闭。内置事件为：

| 类型 | 实际触发条件 |
| --- | --- |
| `work.created` | 服务端成功创建真实事项，包括定时生成 |
| `work.status_changed` | 普通修改／移动确实改变状态 ID |
| `work.completed` | 真实状态变化从非完成类型进入完成类型 |

修改状态定义、批量迁移状态不冒充完成事件。自动化生成的事项具有 `automation` 活动来源，不继续触发规则，避免递归创建。外部调用可以发布自定义小写事件类型；`work.*` 保留给真实内部活动，不允许外部伪造。

每个事件／规则组合最多生成一张事项，成功回执始终指向原事项。失败有明确原因；修好后显式重试失败规则回执，既有成功结果不重做。模板变动不改写已生成事项。单事件匹配超过 25 条规则时整体明确失败，不任意挑选前 25 条。

执行器由 Owner 配置固定地址、只写 Bearer 凭据、资源键、查询间隔和运行时限。凭据以现有密钥机制加密保存，读取只返回“已配置”。执行时传出一份有界、不可变的事项摘要与可选事件文本；不传文档正文、PAT、浏览器凭据或伪造的会话。命令由外部执行器管理员预先配置，事项文本不能选择 shell、命令、环境或工作目录。

### 状态与不确定结果

| 状态 | 含义与后续操作 |
| --- | --- |
| `queued` | 已保存待派发，尚未发出运行请求；Owner 可取消 |
| `dispatching` | 已持久记录本次派发，正在进行唯一一次 POST |
| `running` | 外部回执表示仍在运行，按配置只读查询 |
| `succeeded`／`failed` | 外部返回明确结果，或有确定的接收前拒绝 |
| `unknown` | 无法证明结果或外部工作已停止；保留资源，显式核验只发 GET |
| `canceled` | 在尚未派发时取消；不表示杀死了外部进程 |

同一事项不能同时存在两次待处理执行。同一资源键在全实例串行，`dispatching/running/unknown` 均占用资源；不同资源可以并行。未知结果不会自动重新 POST，也不能用新 ID 绕过待处理执行的限制。

执行器返回成功不会自动将事项改为完成，也不会结束 Agent 的真实认领。应核对实际工作结果，再通过普通事项操作记录业务完成。未知执行只有在独立确认外部工作已停止后，Owner 才能填写依据、选择成功或失败并人工释放；该操作本身没有杀进程或全局隔离能力。

停用执行器取消尚未派发的队列；停用空间事件规则跳过未处理事件，并取消这些事件派生的未派发执行。已派发任务不宣称被停止，仍可读取回执。手动执行不依赖空间事件开关。关闭事项模块会暂停该模块的处理，数据保留；恢复后不重新 POST 已派发记录。

## 2. 开发体验

### API

以下路径以 `/api/v1/spaces/{spaceId}/work` 开头。

| 方法与路径 | 行为 |
| --- | --- |
| `GET/PATCH /automation/settings` | 空间开关；修改为 `{expectedRevision,enabled}` |
| `GET/POST /automation/rules` | 分页规则／稳定 ID 创建 |
| `GET/PATCH /automation/rules/{id}` | 详情／版本化修改、启停、归档 |
| `GET/POST /automation/events` | 分页回执／发布自定义事件 |
| `GET /automation/events/{id}` | 事件与逐规则回执 |
| `POST /automation/events/{id}/retry` | 修复后的显式重试 |
| `GET/POST /executors`，`GET/PATCH /executors/{id}` | 读取与配置固定执行器 |
| `GET/POST /executions` | 分页执行记录／入队真实执行 |
| `GET /executions/{id}` | 当前执行回执 |
| `POST /executions/{id}/reconcile` | 未知态只读核验 |
| `POST /executions/{id}/resolve` | Owner 显式取消待派发项或处理已确认的未知结果 |

创建规则／执行器／事件／执行均要求一个 32 位小写十六进制稳定 ID。相同 ID 和原输入重放原记录，改变输入返回冲突；重放不回退后来修改的内容。修改使用当前 `expectedRevision`。列表使用 `limit=1..100` 和不透明 `cursor`，游标绑定空间、集合与全部筛选。规则／执行器支持 `q,archived`；事件支持 `eventType,state`；执行支持 `itemId,state`。

外部事件输入为 `{id,type,summary,details?,url?,projectId?,statusId?,sourceItemId?}`。链接只是参考数据，不自动访问。回执中的 `processed` 仅表示完成匹配，应继续检查每条 `receipts[].result` 与 `executionId` 对应的执行状态。

失败规则重试输入为 `{expectedRevision,ruleId,expectedRuleRevision}`。仅对匹配前就失败、且没有规则回执的事件，可以省略规则字段重新排队。成功回执不会创建第二张事项。

手动执行输入为 `{id,executorId,itemId,expectedItemRevision,context?}`。`context` 使用现有真实工作会话、认领及操作 ID。派发前再次检查当前身份、权限、事项版本和认领，排队期间发生变化不会被忽略。

执行器修改中的 `secret:{bearerToken}` 替换凭据，`secret:{clearBearerToken:true}` 显式清除，不能二者并用。连接、凭据、资源、查询间隔、时限与归档变动在仍有待处理执行时被拒绝；显示名称与停用另行处理。

### HTTP 执行协议

执行器固定地址为 `<endpoint>`：

```http
POST <endpoint>/runs
Authorization: Bearer <configured-secret>
Idempotency-Key: <stable-execution-id>
Content-Type: application/json
```

```json
{"id":"0123456789abcdef0123456789abcdef","item":{"id":"0000a","revision":"4","title":"同步任务"},"event":{"id":"...","type":"sync.requested","summary":"...","details":"...","url":"","origin":"external"}}
```

`event` 可以省略；`item` 只包含选定的工作内容、规划和日期字段。执行器应持久保存 ID 与请求内容哈希，新任务返回 202，同 ID／同内容返回原回执，同 ID／不同内容返回 409。状态查询为 `GET <endpoint>/runs/<id>`，使用相同 Bearer。

两类请求的成功回执都必须包含严格四字段，不接受额外字段或缺失字段：

```json
{"id":"0123456789abcdef0123456789abcdef","state":"running","result":"","message":""}
```

`state` 为 `running/succeeded/failed/unknown`；ID 必须一致。响应体上限 64 KiB，结果与消息分别限制为 4,000／1,000 字符；截断保持 Unicode 有效并给出标记。外部错误回显已知凭据时脱敏，不把响应正文或带凭据的网络异常写日志。

POST 只发送一次。连接错误、超时、5xx、408／409、未知拒绝状态、无效协议或 ID 不一致进入未知；明确接收前拒绝的 400／401／403／404／405／413／415／422／429 可以记失败。GET 的非 2xx 或无效回执无法证明先前任务失败；连续三次查询失败进入未知并停止自动查询。人工核验发起一轮只读查询；读取失败最多尝试三次 GET，不能替换为 POST。运行超过配置时限也进入未知，不能冒充已终止外部进程。

公开地址要求 HTTPS。只有显式允许私网、且地址为 RFC1918／ULA 字面 IP 时允许 HTTP。复用现有 DNS 固定与出站校验，禁止环回、链路本地、云元数据、保留地址和重定向。不要以启用私网为由关闭整个地址检查。

每次执行器 HTTP 操作使用已提交的出站网络配置，并沿用现有代理和地址校验。网络配置切换会取消旧配置上的请求；如果已经派发且未取得确定回执，执行保持 `unknown`，不会因为切换网络而丢失记录或重复 POST。修复后已用真实 CONNECT 代理和完整生产传输路径验证 POST／GET、配置切换与恢复，不只依赖测试客户端。

源码提供 [参考执行器](../examples/work-executor/README.md)：固定启动 argv、JSON stdin、SQLite 持久幂等和有界输出。它验证实际 HTTP 与子进程执行，不附带用户生产业务的同步命令。管理员配置所需固定程序与网络边界后才可用于具体业务。

### 事务、恢复与性能边界

迁移 **022** 新增规则、事件、执行器、执行与逐规则回执；所有开关默认关闭，升级不会自动创建或启动外部任务。SQLite 扩展活动来源 CHECK 时保留全部历史、唯一约束及 021 的周期索引；PostgreSQL 修改对应 CHECK。备份／回退须包括完整数据库、数据目录和原密钥，不能只备份程序二进制。

内部事件与实际事项活动在同一事务记录。规则生成事项、执行入队与规则回执原子提交；数据库错误回滚，领域失败保留原因。事件队列和待派发执行队列各最多 1,000 条，满时明确拒绝；不能静默丢事件。每事件最多匹配 25 条规则。

派发状态在事务内先持久化，随后在写锁与事务之外发 HTTP。固定四个并行工作槽，资源键在数据库有唯一约束。重启将未确定的 `dispatching` 变为 `unknown`；`running` 仅恢复 GET。迟到的查询回执按版本比较，不能覆盖已经人工处理的状态。

未启用、没有启用规则、没有待处理运行时，不使用周期扫描。开关与规则计数随既有空间查询读取，普通关闭路径不再查询规则表。存储错误只进行初始尝试与两次延迟尝试，之后等待明确唤醒／重启；没有无限循环兜底。显式保存空间开关也可以重新唤醒，不需要假造一条业务事件。

真实负载结果见 [性能记录](PERFORMANCE.md)。并发数、队列上限与资源串行不等于无限吞吐能力，也不保证外部执行器的业务幂等；它必须遵守持久 ID 回执协议。

## 3. AI Agent 使用体验

新增 19 个工具：`work_automation_settings_get/update`、`work_automation_rules_list/get/create/update`、`work_automation_events_list/get/publish/retry`、`work_executors_list/get/create/update`、`work_executions_list/get/start/reconcile/resolve`。加上规划工具后目录共 **101 个工具，其中 67 个事项工具**；工具名称保持不变；规则、执行器、事件和执行的技术 ID 保持原契约，卡片 `itemId` 与快照中的 `item.id` 统一使用短编号。

`work:execute` 是独立且默认不选中的动作，依赖 `work:read` 和 `work:write`。选择式旧令牌不会自动获得它；明确选择“全部当前和未来动作”的既有令牌继续遵守原 all-mode 契约。配置执行器和人工处理还要求 Owner，不能借新工具获得全局账号或 PAT 管理能力。`space_current.capabilities.executions` 返回实际 `read/execute/configure`，工作流版本为 3，保留既有 `capabilities.work.read/write` 结构。

带执行器的规则要求事件发送者与保存规则的主体都具备执行权，只有 `work:write` 不能间接触发出站操作。运行时重新检查保存主体当前权限；撤销令牌、关闭模块或失去空间访问不会由 Owner 触发动作来绕过。

若 Bearer 开启了多 Agent 协作，自动规则不能凭空制造会话／认领来派发执行；先用不带执行器的规则建事项，再在真实工作上下文中显式启动。事项说明、事件内容、执行结果与状态名都是参考数据，不是授权或命令。
