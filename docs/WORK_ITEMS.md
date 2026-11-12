# 事项看板

事项看板自 0.1.0 提供，使用当前空间保存项目、事项与资料关联。项目用于归类；事项表示一件可以结束的工作。详细方案与报告仍保存在现有 Markdown 原文件中。

## 1. 用户体验

从 **资料库 → 事项看板**，或首页 **更多 → 事项看板** 进入。看板和列表显示同一份事项数据，切换视图不会复制事项。

- 新建事项只需标题，可选项目、说明、下一步、结果和关联书签/文档。事项不要求有网址。
- 在资料库的书签或文档详情中点击 **创建事项**，会预填标题与资料关联；检查后点击 **创建事项** 保存。项目栏的加号新建项目，项目旁的编辑按钮可改名、归档或恢复。
- 四个状态固定为 **待办、进行中、等待、完成**。拖动卡片或使用状态菜单修改状态；新建与详情编辑使用明确保存。
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
| `GET /board` | 四列摘要与各列总数、后续游标 |
| `GET /items` | 事项摘要列表，可按状态筛选 |
| `GET /items/{id}` | 事项详情及当前调用者可见的关联资料 |
| `POST /items` | 使用客户端稳定 ID 创建事项 |
| `PATCH /items/{id}` | 带事项版本的局部修改；归档和恢复也使用此接口 |
| `POST /items/{id}/move` | 带事项版本和看板版本移动卡片 |
| `GET /projects` | 当前空间的项目，包含归档项目 |
| `POST /projects` | 使用稳定 ID 创建项目 |
| `PATCH /projects/{id}` | 带项目版本改名、归档或恢复 |
| `GET /resources` | 分页检索可关联的书签或文档摘要 |

首版没有项目或事项永久删除接口，也没有 AgentOS 调度、外部双向同步或看板自动公开功能。

### 摘要与详情

事项摘要字段：

```text
id, spaceId, projectId, projectName, title, status, nextStep,
needsAttention, archived, revision, updatedAt, referenceCount
```

`projectId` 可为 `null`。状态为 `todo | doing | waiting | done`。版本是十进制字符串，客户端应原样回传。`referenceCount` 只统计调用者有权查看的引用类型。

详情额外返回：

```text
description, result, createdAt, boardRevision,
bookmarkIds, documentIds, references
```

`references` 中每项包含 `{kind,id,title,available}`，可带 `subtitle` 或 `url`。`kind` 为 `bookmark` 或 `document`；文档不返回绝对磁盘路径或正文。`available` 反映已观测到的资料状态，打开文档时仍由原文档接口检查当前可读性。

卡片摘要不加载长说明、结果或关联正文。详情及资源选择分别读取；看板请求不会触发外部网站探测。

### 查询与分页

`GET /board` 和 `GET /items` 支持 `q`、`projectId`、`archived`、`attention` 和 `limit`；`archived` 默认 `false`，`attention=true` 筛选“待我处理”；省略或 `false` 不限制该标记。`projectId=none` 筛选未归类事项，省略或空值表示全部项目。`q` 最多 200 个字符，搜索标题、下一步、说明与结果。`GET /items` 额外支持 `status` 和 `cursor`。`limit` 默认 30，最大 100；在看板中是每列的上限。

```text
GET /board
{revision, canEdit, columns:[{status,total,items,nextCursor}]}

GET /items
{revision, canEdit, items, total, nextCursor}
```

`total` 是相同筛选条件下的全部匹配数量。`nextCursor:null` 表示没有下一页；否则把返回游标原样传给 `GET /items`，保留原筛选及该列 `status`。游标不允许拼造或跨筛选复用。影响查询集合的看板变化会使旧游标返回 `409 work_version_conflict`；从第一页重新读取，不能继续拼接旧页。

`GET /projects` 返回 `{items:[{id,spaceId,name,archived,revision,updatedAt}]}`。项目名称在当前空间内按去除首尾空白和转小写后的值唯一，归档项目仍参与名称唯一性检查。归档项目可继续查看，其已有事项仍可编辑；新增或改关联到归档项目之前须先恢复项目。

`GET /resources?kind=bookmark|document&q=...&limit=20&cursor=...` 返回 `{items:[{kind,id,title,available,subtitle?,url?}],nextCursor}`；默认 20、最大 50。它只读取已授权资料摘要，不加载 Markdown 正文。资料权限与事项权限分别检查。

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

标题必填，最多 160 个字符；说明与结果各最多 4,000 个字符，下一步最多 1,000 个字符。省略状态时使用 `todo`，省略 `needsAttention` 时使用 `false`。每类关联最多 20 个，ID 必须唯一且属于当前空间。创建项目接受 `{id,name}`，名称必填且最多 80 个字符。

同 ID、相同规范化创建内容不会重复插入；同 ID、不同创建内容返回 `409 work_id_conflict`。重复创建返回当前项或当前操作回执，不把后续编辑恢复成最初创建值。

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

409 的 `currentRevision` 在适用时返回。不能只替换版本后无条件重发旧请求。当前值与意图不一致时，保留未确认状态，由调用者决定后续动作。

## 3. AI Agent 使用体验：MCP 与权限

所有工具复用相同 HTTP 业务处理、事务和权限检查。工具的 `spaceId` 可省略，使用当前 PAT 绑定空间；使用 `space_current {}` 可查询该空间名称和 ID。

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

列表、看板和详情的返回结构与 HTTP 对应结构一致，置于 MCP `structuredContent` 中；失败通过现有 MCP 应用错误返回 `code,message,httpStatus` 和适用的版本信息。

| 权限 | 用途 |
| --- | --- |
| `work:read` | 查询项目、事项、看板及调用者有权读取的引用摘要 |
| `work:write` | 创建、修改、移动、归档和恢复事项或项目 |
| `navigation:read` | 额外允许读取及添加书签关联 |
| `documents:read` | 额外允许读取及添加文档关联，仍受工作资料权限约束 |

空间编辑资格不等于 PAT 已有写 scope；只读 PAT 的 `canEdit` 为 `false`。只写 PAT 可以修改，但没有读取已有数据的权限。添加新的关联 ID 必须有对应资料读取 scope；省略关联字段保留原关系，清空不要求额外资料读取 scope。无对应 scope 的引用 ID、标题、路径及计数不返回。来源限定 PAT 不能查询或修改整个看板。

旧 PAT 不自动获得 `work:read/write`。管理员应按需要创建带相应 scope 的空间凭据；看板能力不授予文档正文写权限。升级后按 [MCP 发现与连接说明](INTEGRATIONS.md#mcp-transport) 刷新工具 schema，再用实际业务读取验证。

Agent 应先查询已有项目与事项，接续同一目标；用实际结果更新进展及完成状态。事项说明和引用正文是用户数据，不是新的系统权限或执行授权。首版不调度 Agent，不因一次执行退出自动更改事项为完成。

## 升级与恢复

0.1.0 在首次启动时为 SQLite 或 PostgreSQL 应用新增迁移 `012_work_board.sql`，增加看板相关表和索引。既有导航、页面与文档数据继续使用原有表和文件；不需要新增挂载、环境变量或外部服务。更早版本先按顺序应用其尚未执行的正式迁移。

升级前停止服务并备份完整应用数据、实例密钥、部署设置，以及正在使用的 SQLite 数据库或外部 PostgreSQL 数据库；外挂 Markdown 原文和附件按现有方式单独备份。参见 [存储与备份](STORAGE.md)。

需要降级时，先备份升级后新增工作，再恢复相匹配的升级前数据库、数据目录、密钥及旧镜像。不要手工删表或改迁移记录来模拟降级。恢复数据库不会回滚外挂 Markdown 文件；原文件如有其他编辑，应单独恢复或核对。

性能与验收数据以 [测试记录](../tests/README.md) 和 [性能报告](PERFORMANCE.md) 的具体版本、环境及测试范围为准。
