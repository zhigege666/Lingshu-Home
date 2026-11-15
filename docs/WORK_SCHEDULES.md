# 定时事项

0.2.7 在现有事项看板上增加固定日历规则。规则保存一份模板，每次到期生成独立事项；昨天的完成记录、执行认领和结果不会被下一次运行覆盖。定时规则负责创建事项；0.2.8 的外部运行通过[独立执行器契约](WORK_AUTOMATION.md)显式处理，生成成功不等于同步程序执行成功。

## 1. 用户体验

在事项侧栏打开 **定时事项**。新建事项旁的菜单可以新建规则；普通事项详情中的 **保存为定时模板** 预填当前内容，保存前仍可修改。直接链接为 `#/library?view=board&space=<spaceId>&tab=schedules`，追加 `&schedule=<id>` 打开指定规则。

规则页展示启用状态、下一次时间和最近结果。编辑时预览后续五次日期；生成记录可分页，并定位真实事项。暂停保留规则与历史，恢复从恢复时点继续；归档不删除已经生成的事项。草稿、版本冲突和未知保存结果沿用事项页的保护方式。

### 每日同步示例

| 配置 | 示例 |
| --- | --- |
| 规则名称 | 每日同步 |
| 事项标题 | 同步任务 |
| 频率 | 每天 |
| 生成时间 | 09:00 |
| 时区 | Asia/Shanghai |
| 起始日期 | 用户选定日期 |
| 截止时间 | 当天 18:00 |
| 上一次未完成 | 继续创建 |
| 停机后错过 | 只补最近一次 |

每天的“同步任务”是不同事项，使用业务日期区分。标题是普通文本，不展开 `{{date}}` 或其他表达式。业务日期表示这次工作属于哪一天；创建时间表示实际落库时刻；截止时间用于逾期判断。补建昨天的事项不会伪造创建时间。

支持每天、周一至周五、每周选择星期、每月指定日期。周一至周五不识别法定节假日或调休。每月 29–31 日遇到不存在的日期时，由规则明确选择跳过或当月最后一天。IANA 时区随规则保存，浏览器和服务器本机时区不能替代它。生成或截止时间落在夏令时跳过的当地分钟时，本期跳过，预览不列出该日期；重复分钟仍只生成同日期的一次事项。

普通事项也可编辑业务日期与截止时间。看板的今日／逾期筛选读取服务端日期字段，不将更新时间当成任务日期。已有事项升级后日期为空，不会被人为分配为升级当天。

### 错过、暂停和重叠

- `latest`：停机后只补最近的有效日期，默认值。
- `skip`：比计划时间迟到超过一分钟时跳过，继续下一次；正常的一分钟唤醒容差不是无限补偿。
- `all`：有界补建最近至多七次，不无限追赶历史。
- `overlapPolicy:create`：前一次未完成仍创建本次，默认值。
- `overlapPolicy:skip`：前一次仍未结束时记录跳过原因，不暗中关闭旧卡。

主动暂停期间不累计待补任务。编辑规则仅影响未来生成，不改写已有事项和生成回执。同一规则同一业务日期最多一张事项；修改名称、时间或模板版本后再次生成该日，也不能产生第二张。成功记录始终重放原事项；策略性 `skipped` 也重放原决定。`failed` 在修正后可以指定原日期手动重试，事务成功后更新同一发生记录；保存规则仅恢复未来排期，不自动重跑历史失败。

规则最初记录创建者；实际修改／恢复失败规则时，改为本次保存者及其令牌权限。生成时重新检查该主体的当前权限、目标空间、项目、状态与引用权限。项目归档、状态失效或创建者失去权限时保留明确的失败原因，需修正配置或权限后继续，不自动挑选另一个项目或状态。关闭事项模块保留数据并暂停生成。

## 2. 开发体验

### HTTP

以下路径以 `/api/v1/spaces/{spaceId}/work` 开头，沿用 Cookie／CSRF 或 PAT 的权限检查和事务。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /schedules` | `q,archived,limit,cursor` 分页规则；默认未归档 |
| `POST /schedules` | 稳定 ID 创建规则 |
| `GET /schedules/{id}` | 规则详情及当前编辑能力 |
| `PATCH /schedules/{id}` | 配置版本控制的局部修改，含启停和归档 |
| `POST /schedules/preview` | 预览日历结果，不保存或生成事项 |
| `POST /schedules/{id}/generate` | 为指定业务日期生成或返回已有回执 |
| `GET /schedules/{id}/occurrences` | `limit,cursor` 分页生成历史 |

创建示例；将 ID 与日期替换为实际值：

```json
{
  "id": "<new-32-lowercase-hex-id>",
  "name": "每日同步",
  "template": {
    "title": "同步任务",
    "projectId": null,
    "status": "todo",
    "description": "核对来源与同步结果",
    "nextStep": "开始本次同步",
    "needsAttention": false,
    "bookmarkIds": [],
    "documentIds": []
  },
  "rule": {
    "frequency": "daily",
    "time": "09:00",
    "timezone": "Asia/Shanghai",
    "startDate": "2026-11-15",
    "endDate": "",
    "dueTime": "18:00",
    "dueDayOffset": 0
  },
  "enabled": true,
  "missedPolicy": "latest",
  "overlapPolicy": "create"
}
```

模板不包含旧事项的结果、认领或历史。状态必须使用当前空间的有效稳定键；示例 `todo` 也可能已经被用户删除，不能假定始终存在。资料关联沿用对应读取权限；文档模块关闭或引用无权限时，省略未修改的引用字段，不能把隐藏关联当成空数组覆盖。

`rule.frequency` 为 `daily|weekdays|weekly|monthly`；时间为 `HH:mm`，日期为 `YYYY-MM-DD`，时区为有效 IANA 名称。每周使用 `weekdays:[1..7]`（周一为 1）；每月使用 `monthDay:1..31` 和 `monthPolicy:skip|last_day`。截止时间可用 `dueTime` 加 `dueDayOffset:0..7`，或用相对计划生成时间的 `dueAfterMinutes:1..10080`，两种方式互斥。

PATCH 必须带所读的 `expectedRevision`；顶层仅修改提供的字段。`template` 与 `rule` 为整对象配置，但模板内未提供的 `bookmarkIds/documentIds` 保留旧关联。归档和暂停也用 PATCH。版本冲突后读取当前规则、比较草稿；不能只替换版本后自动重发。

规则包含 `spaceId,archived,revision,createdAt,updatedAt,nextRunAt,lastRunAt,lastResult,lastError,references`。配置版本不随每次运行推进；实际创建事项才推进看板业务版本。运行状态不是修改模板的 CAS 版本。

列表返回 `{items,total,nextCursor,canEdit}`，详情和写回返回 `{schedule,canEdit}` 及适用的创建／重放标记。权限不足的写操作沿用最小回执，不借回执泄露已有内容。

预览输入为 `{rule,limit?:5,after?:RFC3339}`，返回 `{items:[{businessDate,scheduledAt,dueAt}],timezone}`。预览不需要先保存规则。

手动生成输入为 `{businessDate?:YYYY-MM-DD,expectedRevision}`，返回 `{occurrence,replayed}`。发生响应未知时保留原规则、日期与请求意图，先读取记录；不得换日期或新建另一条规则来代替核对。回执字段如下：

```text
businessDate, scheduledAt, itemId, result, reason, occurredAt, templateRevision
```

`result` 为 `created|skipped|failed`，未创建事项时 `itemId` 可为空。分页返回 `{items,nextCursor}`。已有生成记录保留当时模板版本，但唯一身份是规则与业务日期，不包含模板版本。

普通事项摘要／详情增加 `businessDate,dueAt,scheduleId`。`businessDate,dueAt` 可写，空串清除；`scheduleId` 是只读来源。列表／看板支持 `date=today|overdue` 与 `timezone=<IANA>`，也支持精确 `businessDate`。与其他条件取交集，游标仍绑定原筛选。日期／来源为空时响应省略这三个可选字段，减少未使用日期功能的传输成本；写入空串仍表示清除。旧客户端省略日期时保留原创建重放语义。逾期分页在游标内固定首批时间，后续页的总数与事项使用同一截止快照，刷新第一页才采用新时刻。

### 调度与事务

复用当前实例数据库租约、工作事务及事项创建逻辑，不引入 Redis 或另一个分布式调度器。规则、业务日期的唯一约束与事务共同防重；事项创建、生成回执和下一时间同事务提交。0.3.0 由全局序列分配卡片短编号，生成回执的 `itemId` 也使用短号；不再从规则与日期计算长卡片 ID。重放已成功的发生记录直接返回原卡片。手动和后台路径遵守同一业务校验。后台创建的活动来源为 `scheduler`。

没有启用规则、全部暂停或事项模块关闭时，工作线程等待配置唤醒或退出，不做周期 SQL 扫描。启用未来规则时等待最近一次时间，使用索引查询与有界处理批次。规则／模块变更提交后才唤醒，普通看板读取不会触发规则扫描。规则页代码、规则请求、预览和记录只在使用入口后加载。

这一约束不等于绝对零资源占用：迁移增加索引和字段，进程仍保存少量工作线程状态，日期摘要也有有限响应成本。实测以[性能报告](PERFORMANCE.md)中的版本、数据量、采样方式与误差边界为准。

## 3. AI Agent 使用体验

新增以下七个 MCP 工具，共用 HTTP 的验证、事务、权限与响应结构：

| 工具 | 参数 |
| --- | --- |
| `work_schedules_list` | 可选 `spaceId,input` 查询和分页 |
| `work_schedules_get` | 可选 `spaceId`，必填 `id` |
| `work_schedules_create` | 可选 `spaceId`，必填 `input` 创建体 |
| `work_schedules_update` | 可选 `spaceId`，必填 `id,input`，含配置版本 |
| `work_schedules_preview` | 可选 `spaceId`，必填 `input.rule` |
| `work_schedules_generate` | 可选 `spaceId`，必填 `id,input`，含所读版本 |
| `work_schedules_occurrences` | 可选 `spaceId`，必填 `id`，可选 `input` 分页 |

应用目录共 62 个工具，其中 28 个事项工具。`work:read/write`、原绑定空间、当前账号能力、资料读取 scope 及模块状态仍是权限边界。后台规则保存真实创建／最近保存主体，不能凭一份旧权限快照永久执行。规则创建不要求伪造 Agent 会话；生成后若 Agent 要执行实际工作，仍遵守已开启的协作认领契约。

`space_current.contextVersion=1` 保持兼容。升级 Home 后刷新 Gate 对应连接的发现和发布定义，再确认工具名称、参数与实际服务器一致；发布 GitHub 版本不会自动替换运行中的容器或网关目录。每天生成卡片也不会自动唤醒外部 Agent。

## 升级、测试与恢复

SQLite／PostgreSQL 迁移 020 保留现有事项与创建哈希。SQLite 为扩展活动来源约束，会在迁移事务中重建 work_activity 并保留原列、历史、唯一约束及分页索引，耗时随既有活动量增长；PostgreSQL 修改对应 CHECK 约束。升级不自动创建规则，不为旧卡填充日期。升级前备份完整数据库、数据目录、匹配密钥、部署配置及外置文件。回退 0.2.5 或更早版本需要恢复迁移前匹配备份，不能通过删除迁移记录或仅换镜像实现。

功能验证覆盖两个 provider 的日期、权限、并发幂等、迁移与恢复；浏览器验证包含四种桌面尺寸和未知响应／草稿保护。实际命令、通过数和未覆盖范围见[测试记录](../tests/README.md)，未使用与启用负载见[性能报告](PERFORMANCE.md)。测试数据只使用隔离回环实例，不向日常工作库批量生成事项。

## 0.2.8 模板与事件

定时模板增加[优先级、标签、负责人和目标版本](WORK_PLANNING.md)，省略规划字段保留既有值，显式清空按字段契约处理。真实定时生成可以产生 work.created 事件；只有开启空间事件自动化且存在匹配规则时才入队，同一事务提交后唤醒处理。事件规则生成的后续事项不再递归触发规则。现有日历规则、业务日期去重和暂停／错过策略不变。
