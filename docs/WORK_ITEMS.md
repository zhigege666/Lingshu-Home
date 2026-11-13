# 事项看板

事项看板自 0.1.0 提供，使用当前空间保存项目、事项与资料关联。项目用于归类；事项表示一件可以结束的工作。详细方案与报告仍保存在现有 Markdown 原文件中。

## 1. 用户体验

从首页顶栏 **看板**，或 **资料库 → 事项看板** 进入。看板和列表显示同一份事项数据，切换视图不会复制事项。

- 新建事项只需标题，可选项目、说明、下一步、结果和关联书签/文档。事项不要求有网址。
- 在资料库的书签或文档详情中点击 **创建事项**，会预填标题与资料关联；检查后点击 **创建事项** 保存。项目栏的加号新建项目，项目旁的编辑按钮可改名、归档或恢复。
- 初始状态为 **待办、进行中、等待、完成**。通过 **看板操作 → 管理状态** 或列头菜单增删状态、改名、调整颜色与顺序，并设置默认状态；同一空间内的项目共用这套配置。
- 状态名称和业务类型分开维护。类型包括待办、进行中、等待、完成、取消；取消表示工作结束，但不表示成功完成。内置四个状态保留原有类型，自定义状态可调整类型。
- 拖动卡片或使用状态菜单修改状态；新建、详情和状态配置使用明确保存。删除有事项的状态时选择迁移目标，包含已归档事项；删除默认状态时同时选择新的默认状态。仅改名、改颜色或排序不会改变事项的状态键。
- **待我处理** 是独立标记，不会因状态为“等待”自动开启。完成事项无需强制填写结果。
- 按项目、文字、待我处理或归档状态筛选。看板每列分批加载，列总数与已加载数量不同。
- 拖到另一张卡片上表示放在其前面；拖到列空白处表示放到完整目标列末尾。筛选隐藏或尚未加载的卡片保留相对顺序。
- 归档事项后可恢复；归档项目不归档其事项，原项目的未归档事项仍出现在全部事项中。项目列表保留归档项目，供查看与筛选。
- 书签和文档以关联方式保留。归档事项、改项目或移除关联都不会修改或删除原书签、Markdown 文件或附件。文档目录断开或原文件暂不可用时，已有关系保留，详情显示 **资料暂不可用**；书签记录被真正删除后，相应事项关联随之移除。

未保存编辑在切换事项、空间或页面时使用离开保护；草稿保存在当前页面内存中，不是跨浏览器重启的草稿备份。内容冲突时保留本地编辑，点击 **读取最新版本** 比较，再选择 **使用最新版本** 或 **保存草稿中的改动**。请求超时不代表写入失败；先读取当前事项核对，不自动换新版本重写。当前值与提交意图不同时，不能仅凭一次回读认定上次操作是否成功。

看板是内部工作资料。浏览器须登录可编辑当前空间的账号：个人空间仅本人，共享空间须 Owner。公开浏览或匿名开放编辑不会公开看板。

## 2. 开发体验：HTTP 契约

以下路径统一以 `/api/v1/spaces/{spaceId}/work` 开头。浏览器写入沿用 Cookie 与 `X-CSRF-TOKEN`；有效 PAT Bearer 请求沿用现有独立鉴权。读取结果不应跨账号缓存。

| 方法与相对路径 | 行为 |
| --- | --- |
| `GET /board` | 按当前状态目录排列的列摘要、总数与后续游标，并带状态元数据 |
| `GET /items` | 事项摘要列表及状态元数据，可按稳定状态键筛选 |
| `GET /items/{id}` | 事项详情、`statusDefinition` 及当前调用者可见的关联资料 |
| `POST /items` | 使用客户端稳定 ID 创建事项 |
| `PATCH /items/{id}` | 带事项版本的局部修改；归档和恢复也使用此接口 |
| `POST /items/{id}/move` | 带事项版本和看板版本移动卡片 |
| `GET /projects` | 当前空间的项目，包含归档项目 |
| `POST /projects` | 使用稳定 ID 创建项目 |
| `PATCH /projects/{id}` | 带项目版本改名、归档或恢复 |
| `GET /resources` | 分页检索可关联的书签或文档摘要 |
| `GET /statuses` | 当前空间的状态目录、版本、默认状态和使用计数 |
| `POST /statuses/batch-edit` | 带目录版本，原子新增、修改、排序、合并/删除状态及设置默认值 |
| `GET /revision` | `{revision,statusRevision}`，供页面检查事项或状态配置是否更新 |

当前没有项目或事项永久删除接口，也没有 AgentOS 调度、外部双向同步或看板自动公开功能。

### 摘要与详情

事项摘要字段：

```text
id, spaceId, projectId, projectName, title, status, nextStep,
needsAttention, archived, revision, updatedAt, referenceCount
```

`projectId` 可为 `null`。`status` 是当前空间状态目录中的稳定键：初始键为 `todo | doing | waiting | done`，新建状态使用 32 位小写十六进制键。它不是显示名称，也不是类型枚举。版本是十进制字符串，客户端应原样回传。`referenceCount` 只统计调用者有权查看的引用类型。

详情额外返回：

```text
description, result, createdAt, boardRevision, statusDefinition,
bookmarkIds, documentIds, references
```

`references` 中每项包含 `{kind,id,title,available}`，可带 `subtitle` 或 `url`。`kind` 为 `bookmark` 或 `document`；文档不返回绝对磁盘路径或正文。`available` 反映已观测到的资料状态，打开文档时仍由原文档接口检查当前可读性。

卡片摘要不加载长说明、结果或关联正文。详情及资源选择分别读取；看板请求不会触发外部网站探测。

### 查询与分页

`GET /board` 和 `GET /items` 支持 `q`、`projectId`、`archived`、`attention` 和 `limit`；`archived` 默认 `false`，`attention=true` 筛选“待我处理”；省略或 `false` 不限制该标记。`projectId=none` 筛选未归类事项，省略或空值表示全部项目。`q` 最多 200 个字符，搜索标题、下一步、说明与结果。`GET /items` 额外支持 `status` 和 `cursor`。`limit` 默认 30，最大 100；在看板中是每列的上限。

```text
GET /board
{revision, canEdit, statuses, statusRevision, defaultStatus,
 columns:[{status,total,items,nextCursor}]}

GET /items
{revision, canEdit, statuses, statusRevision, defaultStatus, items, total, nextCursor}
```

`total` 是相同筛选条件下的全部匹配数量。`nextCursor:null` 表示没有下一页；否则把返回游标原样传给 `GET /items`，保留原筛选及该列 `status`。游标不允许拼造或跨筛选复用。影响查询集合的看板变化会使旧游标返回 `409 work_version_conflict`；从第一页重新读取，不能继续拼接旧页。

`GET /projects` 返回 `{items:[{id,spaceId,name,archived,revision,updatedAt}]}`。项目名称在当前空间内按去除首尾空白和转小写后的值唯一，归档项目仍参与名称唯一性检查。归档项目可继续查看，其已有事项仍可编辑；新增或改关联到归档项目之前须先恢复项目。

`GET /resources?kind=bookmark|document&q=...&limit=20&cursor=...` 返回 `{items:[{kind,id,title,available,subtitle?,url?}],nextCursor}`；默认 20、最大 50。它只读取已授权资料摘要，不加载 Markdown 正文。资料权限与事项权限分别检查。

### 空间状态目录与原子维护

`GET /statuses` 返回：

```text
{revision, defaultStatus, canEdit,
 items:[{id,name,type,color,description,position,isDefault,total,archivedTotal}]}
```

- 每个空间保留 1～64 个有效状态，各项目与未归类事项共用；跨项目看板不按显示名称拼接不同流程。
- `id` 创建后不变，已退役的键也不能复用。名称去除首尾空白后最长 80 个字符，有效状态名称在空间内不区分大小写唯一。说明最多 1,000 个字符，颜色为 `#RRGGBB`。
- `type` 为 `todo | doing | waiting | done | canceled`。显示名不决定语义；`done` 与 `canceled` 都表示工作结束，只有前者表示完成。`needsAttention`、`archived` 始终独立，不随状态类型自动改变。
- `position` 表示列顺序，`defaultStatus` 是未指定状态的新事项落点。看板、列表和详情只附带状态语义元数据，不附带目录使用计数；目录读取和有读权限的配置保存返回 `total/archivedTotal`。迁移前以这些空间级计数为准，`columns[].total` 则只对应看板当前筛选。

批量维护请求使用普通 JSON 对象与数组，例如：

```json
{
  "expectedRevision": "<status-catalog-revision>",
  "create": [{"id": "<new-32-lowercase-hex-id>", "name": "待复核", "type": "waiting", "color": "#5596BC", "description": "执行完成，等待复核结果"}],
  "patches": [{"id": "todo", "name": "待安排"}],
  "order": ["todo", "doing", "waiting", "<new-32-lowercase-hex-id>", "done"],
  "deletions": [],
  "defaultStatus": "todo"
}
```

`create`、`patches`、`order`、`deletions` 各最多 64 项，均可省略；至少提交一项变更。新增状态必须给稳定 ID、名称和类型；修改只覆盖已提供字段。`order` 若提供，必须包含本批次保存后所有有效状态的完整顺序，包含新建键、排除删除键。不能在同一批次重复修改同一键，或同时修改和删除它。

删除使用 `deletions:[{id,moveToStatus?}]`。空状态可直接退役；有未归档或已归档事项时必须提供仍然有效的目标键，服务端在同一事务中迁移全部事项、保留各自归档标记，并追加到对应目标列末尾。目标可以是同批新建状态，不能是同批删除状态。默认状态被删除时必须同批提供有效的 `defaultStatus`。退役记录保留原键及迁移目标，不删除事项或原始资料。

一次保存原子执行所有校验与变更，任一步失败整批回滚。成功返回最新目录；无 `work:read` 的只写 PAT 仅取得 `{revision,boardRevision,applied:true}` 回执。目录变化推进 `statusRevision` 与看板版本；自定义类型改变或合并迁移也推进受影响事项版本。状态维护使用目录 `revision`，不能拿事项或看板版本代替。

发生配置冲突或响应不确定时，保留草稿，读取最新配置并比较；不能仅替换版本重发整个批次。新增状态的 ID 也须保持不变，不能因超时换 ID 再建一列。

### 创建、修改与移动

创建事项：

```json
{
  "id": "<new-32-lowercase-hex-id>",
  "title": "整理部署验证结果",
  "projectId": null,
  "status": "todo",
  "description": "",
  "nextStep": "查看验证记录并整理结论",
  "result": "",
  "needsAttention": false,
  "bookmarkIds": [],
  "documentIds": []
}
```

把示例 ID 替换为客户端新生成的 32 位小写十六进制 ID。每件新事项使用新 ID；同一次创建在未知响应恢复时保留原 ID。

标题必填，最多 160 个字符；说明与结果各最多 4,000 个字符，下一步最多 1,000 个字符。省略状态时使用当前目录的 `defaultStatus`，省略 `needsAttention` 时使用 `false`。显式状态必须是目录中的有效键；示例中的内置键同样需要仍然有效。每类关联最多 20 个，ID 必须唯一且属于当前空间。创建项目接受 `{id,name}`，名称必填且最多 80 个字符。

同 ID、相同规范化创建内容不会重复插入；同 ID、不同创建内容返回 `409 work_id_conflict`。重复创建返回当前项或当前操作回执，不把后续编辑恢复成最初创建值。新的创建请求在解析可变默认状态前记录原始意图；默认状态随后改变，或原状态已经合并退役，不会让已成功的同 ID、同请求重放创建第二条事项。升级前创建记录保留原有哈希解释规则。响应未知时保留原 ID 和原请求体，不生成替代 ID。

局部更新必须提交所读事项的 `expectedRevision`，以及至少一个修改字段：

```json
{
  "expectedRevision": "<item-revision>",
  "nextStep": "在测试环境复核",
  "needsAttention": true
}
```

可修改创建字段中的业务属性及 `archived`，不能更改 ID 或空间。省略字段保留原值；`projectId:null` 取消项目归属；引用数组为 `[]` 时清空该类关联。修改项目使用项目自己的 `expectedRevision`，可改 `name` 和 `archived`。普通编辑不要求整个看板的版本。通过 PATCH 改状态或恢复事项时，事项追加到完整目标列末尾；精确插入位置使用移动接口。

移动事项：

```json
{
  "expectedRevision": "<item-revision>",
  "expectedBoardRevision": "<board-revision>",
  "status": "doing",
  "beforeId": null
}
```

`beforeId` 必须显式填写：同空间、目标状态中未归档的卡片 ID 表示放到该卡片之前，`null` 表示完整目标列末尾。不能使用自身、其他空间或错误列的卡片作锚点。移动以服务端完整顺序为准，客户端不上传筛选后的全量排序数组。

成功写入返回 HTTP 200。具有 `work:read` 的调用者取得当前授权事项或项目；事项包含 `boardRevision`。只写 PAT 仅取得 `{id,revision,boardRevision}` 操作回执，创建/重放回执可额外带 `created` 或 `replayed`，不会返回已有标题、正文或关联资料。

### 冲突与错误

| 状态 / code | 处理 |
| --- | --- |
| `400` | 输入、状态、字段或游标无效；按错误说明修正 |
| `401` / `403` | 登录、账号、空间、PAT scope 或来源限制不满足 |
| `404` | 目标不存在或不在当前授权空间；不要通过其他空间探测 |
| `409 work_version_conflict` | 看板版本或分页快照变化，刷新相关视图 |
| `409 work_item_version_conflict` | 同一事项已改变，保留草稿并比较最新内容 |
| `409 work_project_version_conflict` | 项目已改变，重新读取后决定如何修改 |
| `409 work_id_conflict` | ID 已被另一创建请求占用，不能覆盖 |
| `409 work_project_name_conflict` | 项目重名，检索并复用现有或归档项目 |
| `409 work_project_archived` | 新增或改关联到归档项目，先恢复项目 |
| `409 work_move_target_conflict` | 移动锚点已不在目标列，刷新看板后选择 |
| `400 work_status_unavailable` | 状态不存在或已退役；根据授权返回的目录与可选替代键重新判断，不猜名称或其他空间 |
| `400 work_default_status_required` | 同批选择一个仍然有效的默认状态 |
| `409 work_status_version_conflict` | 状态目录版本变化，读取目录、比较草稿，再决定修改 |
| `409 work_status_in_use` | 状态仍含事项，提供有效 `moveToStatus`；迁移包括归档事项 |
| `409 work_status_id_conflict` | 状态键已存在或退役，先核对不确定创建，不能复用旧键 |
| `409 work_status_name_conflict` | 当前空间的有效状态重名，修改名称或复用已有状态 |

409 的 `currentRevision` 在适用时返回。不能只替换版本后无条件重发旧请求。当前值与意图不一致时，保留未确认状态，由调用者决定后续动作。

错误可带 `entity,id,field,details`。有 `work:read` 的调用者遇到不可用状态时，可取得 `details:{statusRevision,defaultStatus,availableStatuses,replacementStatus?,recoveryTool}`；信息已足够时可直接据此判断，无须再次查询。状态占用错误可返回未归档与已归档计数。只写 PAT 不通过错误取得状态目录或计数，MCP 也不会额外查询或补充这些资料。

## 3. AI Agent 使用体验：MCP 与权限

当前有 12 个事项工具，应用 MCP 目录共 46 个工具。所有工具复用相同 HTTP 业务处理、事务和权限检查。工具的 `spaceId` 可省略，使用当前 PAT 绑定空间；仅在需要空间名称或 ID 时调用 `space_current {}`。

| MCP 工具 | 参数 |
| --- | --- |
| `work_board_get` | 可选 `spaceId`、可选 `input` 查询条件 |
| `work_items_list` | 可选 `spaceId`、可选 `input` 查询条件及游标 |
| `work_items_get` | 可选 `spaceId`，必填 `id` |
| `work_items_create` | 可选 `spaceId`，必填 `input` 创建体 |
| `work_items_update` | 可选 `spaceId`，必填 `id,input`，含事项版本 |
| `work_items_move` | 可选 `spaceId`，必填 `id,input`，含事项和看板版本 |
| `work_projects_list` | 可选 `spaceId` |
| `work_projects_create` | 可选 `spaceId`，必填 `input` 创建体 |
| `work_projects_update` | 可选 `spaceId`，必填 `id,input`，含项目版本 |
| `work_resources_search` | 可选 `spaceId`，`input` 含必填 `kind` 及可选搜索/分页条件 |
| `work_statuses_get` | 可选 `spaceId`，返回状态目录与其 `revision` |
| `work_statuses_batch_edit` | 可选 `spaceId`，必填 `input`，含目录 `expectedRevision` 及结构化变更数组 |

列表、看板和详情的返回结构与 HTTP 对应结构一致，置于 MCP `structuredContent` 中；失败返回 `code,message,httpStatus` 和适用的 `currentRevision,entity,id,field,details`，授权边界与 HTTP 一致。

工具说明包含中文事项、任务、看板与状态检索词；字段说明给出稳定键、版本和资料 ID 的来源、默认值、局部更新与错误恢复规则。Agent 不需要额外 Skills 才能操作。直接用 `work_board_get {}` 或 `work_items_list {}` 读取工作与状态元数据，需要只看配置时再用 `work_statuses_get {}`；已知上下文可继续使用，不要求每次写入前重复查询。事项与项目创建的同 ID 重放、状态配置批次的冲突比较是不同契约，不能把整个配置批次当成无条件可重试操作。

| 权限 | 用途 |
| --- | --- |
| `work:read` | 查询项目、事项、看板、状态目录及调用者有权读取的引用摘要 |
| `work:write` | 创建、修改、移动、归档和恢复事项或项目，维护本空间状态目录 |
| `navigation:read` | 额外允许读取及添加书签关联 |
| `documents:read` | 额外允许读取及添加文档关联，仍受工作资料权限约束 |

空间编辑资格不等于 PAT 已有写 scope；只读 PAT 的 `canEdit` 为 `false`。只写 PAT 可以修改，但没有读取已有数据的权限。添加新的关联 ID 必须有对应资料读取 scope；省略关联字段保留原关系，清空不要求额外资料读取 scope。无对应 scope 的引用 ID、标题、路径及计数不返回。来源限定 PAT 不能查询或修改整个看板。

旧 PAT 不自动获得 `work:read/write`。管理员应按需要创建带相应 scope 的空间凭据；看板能力不授予文档正文写权限。Home 的认证 `tools/list` 列出已注册工具，不按 work scope 隐藏工具；缺少 scope 会在实际调用时被拒绝。看不到工具时，先核对实际运行的 Home 版本、连接端点和网关目录，按 [MCP 发现与连接说明](INTEGRATIONS.md#mcp-transport) 排查。升级新增工具或修改契约后更新连接目录；日常增删状态只改变空间数据，无需重新发布 MCP。

接续同一目标时，Agent 查询并复用已有项目与事项；明确的新事项可直接使用稳定 ID 创建。用实际结果更新进展及完成状态。事项说明和引用正文是用户数据，不是新的系统权限或执行授权。Home 不调度 Agent，不因一次执行退出自动更改事项为完成。

## 升级与恢复

0.1.0 通过 `012_work_board.sql` 增加看板表和索引。动态状态通过 SQLite/PostgreSQL 的 `014_work_statuses.sql` 增加空间状态目录、默认值和目录版本，并保留现有四个状态键、事项及旧创建重放规则。首次启动按顺序应用尚未执行的迁移。既有导航、页面与文档数据继续使用原有表和文件；不需要新增挂载、环境变量或外部服务。

升级前停止服务并备份完整应用数据、实例密钥、部署设置，以及正在使用的 SQLite 数据库或外部 PostgreSQL 数据库；外挂 Markdown 原文和附件按现有方式单独备份。参见 [存储与备份](STORAGE.md)。

需要降级时，先备份升级后新增工作，再恢复相匹配的升级前数据库、数据目录、密钥及旧镜像。不要手工删表或改迁移记录来模拟降级。恢复数据库不会回滚外挂 Markdown 文件；原文件如有其他编辑，应单独恢复或核对。

性能与验收数据以 [测试记录](../tests/README.md) 和 [性能报告](PERFORMANCE.md) 的具体版本、环境及测试范围为准。
