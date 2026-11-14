# Performance and interface verification

## v0.2.8：规划、事件、通知与外部执行器性能

本轮全部最终选定场景通过，SQLite 和 PostgreSQL 均实际执行，没有用跳过数据库测试代替通过。新功能存在可量化的固定成本：真实事项会输出编号/key，规划字段扩大 Go 对象，状态变化会留下统计观测记录。规则或通知没有启用时没有持续空轮询；这不等于整个版本零成本。

### 环境、来源与计量范围

基线是正式 v0.2.7，commit a4aa457a6a72c212ebd2526fc7dbf61c56cfa4d5，使用独立源码快照及同一工具链。环境为 Linux amd64、4 个逻辑 CPU、8126476 KiB 内存的共享主机，Go 1.26.8、GOMAXPROCS=4、CGO_ENABLED=0、PostgreSQL 18.6、modernc.org/sqlite v1.60.1。每次负载使用新 SQLite 目录或独立 PostgreSQL schema。

普通 board/bootstrap/mixed 与状态写入都经过 httptest.NewServer 的真实 loopback TCP。顺序采样另外包含客户端 JSON 解码。SQL 预算使用单独的 handler 调用计数，不将该调用当作网络延迟。定时生成和事件事务采用生产 helper；事件样本包含 HTTP 入队和顺序事务处理，未计自主协调器的调度开销。外部执行器使用活跃的生产 coordinator/worker、真实安全出站传输、私网 HTTP 参考服务和真实固定 argv 子进程。

初轮磁盘耗尽到 8 KiB 可用空间，导致隔离 PostgreSQL 写失败并退出；该轮状态与不完整顺序采样全部标为无效并保留原始日志。回收可重建缓存后，隔离 PostgreSQL 完成正常 WAL 恢复及建表、写入、读取、回滚健康检查，使用相同已构建二进制重测受影响窗口。有效阶段边界最低可用空间为 1,411,530,752 B，测量脚本设置 512 MiB 停止阈值。

另发现 PostgreSQL 编号回填中的相关子查询重复执行窗口计算。暂停性能负载后，将 PG021 改为等价 JOIN UPDATE，并单独验证升级；已通过且业务运行代码未变的 HTTP、状态与 idle 样本保留，剩余定时、事件和执行器采用新嵌入迁移候选。两个候选的业务 Go 源码散列相同，变化仅为 PG021、测试数据准备和新增迁移测试。来源散列与完整聚合数值保存在[机器可读数据](performance-work-0.2.8.json)。测量后仅清理了 SQLite/PostgreSQL 两份 022 迁移各一个多余的末尾换行，SQL 语句逐字相同；aggregate 同时记录清理前后 SHA。测试二进制 SHA 是测量快照的 SHA，不冒充后续发布制品的 SHA。

### 1. 普通请求与永久成本

10000 个事项、8 并发，每种请求 200 次。board 返回 4 列共 120 卡；mixed 包含 40 次普通事项创建和 160 次读取。表中延迟单位 ms，吞吐单位请求/秒。

| 数据库 | 负载 | v7 P50 | v8 P50 | v7 P95 | v8 P95 | v7 请求/秒 | v8 请求/秒 | 旧/新错误 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sqlite | board | 47.406 | 51.981 | 154.412 | 197.060 | 125.22 | 106.62 | 0 / 0 |
| sqlite | bootstrap | 3.420 | 3.127 | 12.394 | 11.231 | 1689.98 | 1825.53 | 0 / 0 |
| sqlite | mixed | 114.467 | 97.449 | 427.919 | 468.264 | 50.17 | 50.89 | 0 / 0 |
| postgres | board | 31.049 | 37.504 | 51.272 | 59.869 | 236.90 | 201.13 | 0 / 0 |
| postgres | bootstrap | 5.184 | 5.508 | 11.545 | 9.781 | 1238.09 | 1297.83 | 0 / 0 |
| postgres | mixed | 35.976 | 38.011 | 60.525 | 80.632 | 208.71 | 183.77 | 0 / 0 |

本次普通看板和混合负载的部分尾延迟上升，完整保留数值。共享主机的单次样本不能精确分离应用变化、GC 与环境波动，也不能据此承诺吞吐。bootstrap 控制项没有相同方向的全面变化。

真实编号的 120 卡响应由 40,313 B 增至 43,337 B，每次增加 3,024 B（7.50%）；这个值对应本测试页面的编号长度。bootstrap 每次仍为 2338 B。4 列普通看板的应用 SQL 预算保持 18 次，1000/10000 事项列查询使用排序索引。25 次顺序采样、100/1000/10000 事项的完整结果保存在 aggregate JSON。

Go Summary inline 大小为 216 → 416 B，Item 为 400 → 600 B，均增加 200 B。这是对象内字符串/切片头、指针和字段的大小，未包括字符串内容、关联堆对象或数据库缓存，不能直接乘成进程总内存。

### 2. 状态变化的固定写入成本

每库分别紧邻运行旧版和候选：200 个经 HTTP 创建的 todo 事项，先 200 次 todo→doing，再 200 次 doing→done，两个阶段均 8 并发，总计 400 PATCH。没有启用规则、通知或打开统计页。候选恰好记录 200 个已结束 cycle 观测，所有事项最终 revision=3。

| 数据库 | 版本 | P50 ms | P95 ms | 请求/秒 | Go进程CPU秒 | cycle观测 | 错误 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sqlite | 0.2.7 | 22.596 | 27.595 | 350.37 | 1.880 | 0 | 0 |
| sqlite | 0.2.8 | 25.825 | 31.083 | 308.19 | 2.052 | 200 | 0 |
| postgres | 0.2.7 | 93.031 | 109.662 | 84.16 | 3.852 | 0 | 0 |
| postgres | 0.2.8 | 101.947 | 122.972 | 77.75 | 3.953 | 200 | 0 |

SQLite P95 增加约 12.6%，PostgreSQL 增加约 12.1%。状态历史观测是始终存在的业务成本；关闭统计界面不会撤销它。Go 进程 CPU 包含本地 HTTP 客户端和服务端，PostgreSQL 数据库服务 CPU 不包含在该列，不能跨两种存储比较总 CPU。

### 3. 未使用、全部暂停与启用后空闲

以下观察对象全部是独立的 SQLite 原生 Home 进程，无浏览器且窗口内没有主动 HTTP 请求。暂停场景含 1000 条暂停事件规则和 4 个禁用执行器；启用场景含 1000 条启用规则、4 个启用执行器及开启的通知，没有待处理事件或运行。

| 版本 | 场景 | 观察秒 | CPU秒 | 起始RSS KiB | 结束RSS KiB | 意外执行器连接 |
| --- | --- | --- | --- | --- | --- | --- |
| 0.2.7 | unused | 30.03 | 0.0 | 91908 | 91908 | 0 |
| 0.2.8 | unused | 30.03 | 0.0 | 92816 | 92816 | 0 |
| 0.2.8 | 1000_paused_rules_4_disabled_executors | 20.02 | 0.0 | 134588 | 134588 | 0 |
| 0.2.8 | 1000_enabled_rules_4_enabled_executors_notifications_on | 20.02 | 0.0 | 135440 | 135440 | 0 |

CPU 计数为 100 Hz，三组候选窗口均观察到 0 tick、0 I/O 增量，数据库相关行数前后不变。零 tick 表示该有限窗口的量化结果；RSS 包含初始化、密码计算、配置准备与缓存，不能用两个场景相减宣称每条规则的内存。这个结论不覆盖 PostgreSQL 服务自身的 autovacuum 等后台活动。

代码路径在没有待处理工作时返回零 deadline，不创建周期 timer，之后等待唤醒或取消。启动与配置变更仍有一次有界扫描，工作线程、字段和接口存在静态成本。实际配置的空闲执行器也没有产生出站探测连接。

### 4. 定时生成与前台读取

每库覆盖 100/1000 条到期规则，普通看板预置 1000 个事项。4 个 HTTP 读线程覆盖整个生成窗口，80% board、20% bootstrap，没有 2000 次请求截止。下表为 1000 规则场景；控制组为同一 fixture 上的 200 次普通读取。

| 数据库 | 版本 | 生成秒 | 生成项/秒 | 控制board P95 | 生成中board P95 | 完整窗口读请求 | 错误 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sqlite | 0.2.7 | 18.957 | 52.75 | 30.387 | 44.224 | 4096 | 0 |
| postgres | 0.2.7 | 13.295 | 75.22 | 14.128 | 20.656 | 4408 | 0 |
| sqlite | 0.2.8 | 23.602 | 42.37 | 46.373 | 52.378 | 4075 | 0 |
| postgres | 0.2.8 | 14.983 | 66.74 | 19.217 | 21.697 | 4669 | 0 |

v0.2.8 在两库两档共生成 2200 个定时期次；额外 4 场同周期争抢，各 100 个 HTTP 生成请求加一个 worker 只增加一个期次/事项。400 次重放请求全部成功，没有重复 occurrence、额外事项或数据库锁错误。所有生成窗口每个完整秒均有读取，最后一次发出请求覆盖到生成结束附近；这是有界混合阶段，不是最大容量或持续服务承诺。

### 5. 事件规则与默认关闭的通知

每个场景均有 1000 个普通事项和 4 个持续 HTTP 读线程。HTTP 入队并发为 8。25 条匹配规则乘 40 个事件产生 1000 个事项；26 条匹配专门验证匹配数量上限，200 次失败均为预期业务失败，HTTP/读取错误仍为 0。

| 数据库 | 场景 | 事件 | 规则 | 新增事项 | 阶段秒 | 控制board P95 | 负载board P95 | 预期事件失败 | 通知行 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sqlite | zero_rules | 200 | 0 | 0 | 7.369 | 45.616 | 44.333 | 0 | 0 |
| sqlite | 1000_unmatched_rules | 200 | 1000 | 0 | 8.709 | 42.985 | 47.577 | 0 | 0 |
| sqlite | 25_matching_rules | 40 | 25 | 1000 | 2.846 | 33.505 | 116.744 | 0 | 0 |
| sqlite | match_limit_notices_off | 200 | 26 | 0 | 7.926 | 42.242 | 47.061 | 200 | 0 |
| sqlite | match_limit_notices_on | 200 | 26 | 0 | 8.505 | 40.068 | 47.320 | 200 | 200 |
| postgres | zero_rules | 200 | 0 | 0 | 2.841 | 16.815 | 22.251 | 0 | 0 |
| postgres | 1000_unmatched_rules | 200 | 1000 | 0 | 2.935 | 17.885 | 23.532 | 0 | 0 |
| postgres | 25_matching_rules | 40 | 25 | 1000 | 8.653 | 23.380 | 21.057 | 0 | 0 |
| postgres | match_limit_notices_off | 200 | 26 | 0 | 2.881 | 19.724 | 20.962 | 200 | 0 |
| postgres | match_limit_notices_on | 200 | 26 | 0 | 3.211 | 18.271 | 22.129 | 200 | 200 |

1000 条不匹配规则没有创建事项或回执。匹配场景每库恰好 1000 条创建回执，无重复。通知关闭/开启的失败场景在计时后读取真实异常摘要，两者 automationFailed 均为 200；关闭时通知列表/未读为 0，开启时均为 200。真实异常计数独立于可关闭的消息收件箱。没有待处理事件、全暂停规则、启用但没有事件、以及清空队列后均返回无 timer 的计划。

### 6. 真实 HTTP 执行器与资源互斥

每库分别使用 4 个资源和同一个资源，各排入 12 个执行。参考服务以固定 argv 启动真实 Python 子进程，每次运行 250 ms，输入仅为 stdin JSON。保留生产最小 2 秒回执轮询，因此同资源下一项需等 Home 获得终态后才启动。读取线程覆盖到全部终态；若发生 unknown 或到达截止，会在该明确边界停止并记录，不能通过自动重派获得成功数字。

| 数据库 | 资源数 | 完整阶段秒 | 排队P95 ms | 控制board P95 | 运行中board P95 | 实测HTTP峰值 | 实测子进程峰值 | POST/GET | 错误 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sqlite | 4 | 7.223 | 4784.725 | 42.052 | 42.737 | 2 | 4 | 12 / 12 | 0 |
| sqlite | 1 | 26.643 | 24464.774 | 44.450 | 44.836 | 1 | 1 | 12 / 12 | 0 |
| postgres | 4 | 6.477 | 4297.255 | 22.854 | 22.319 | 2 | 4 | 12 / 12 | 0 |
| postgres | 1 | 24.842 | 22665.498 | 20.562 | 21.036 | 1 | 1 | 12 / 12 | 0 |

48 个执行全部 succeeded，实际 48 次 POST、48 次 GET，48 个子进程各启动/结束一次。每个资源实际子进程最大并发为 1；4 资源时子进程峰值为 4。本样本出站 HTTP RoundTrip 峰值为 2（同资源为 1），配置池大小 4 不等于实测请求峰值。每场只有 12 个执行，排队 P95 接近本场最大值，不能当作稳定尾延迟或执行器容量上限。

aggregate JSON 同时保留 Go 混合阶段 CPU、参考 HTTP 进程 CPU、已回收子进程 CPU，以及两者 RSS；这些观测范围彼此不同。Go 的 CPU 包含持续前台请求和本地负载客户端，不能当作仅执行器的额外 CPU。PostgreSQL 服务 CPU未计入。

### 7. PostgreSQL 旧库升级

旧回填 EXPLAIN 显示逐行 SubPlan 中重复 WindowAgg/Sort；发现问题时，本测试的相关准备查询已经运行 73 秒。该值是观测下界，不是旧完整迁移耗时。

改为按 id JOIN UPDATE 后，在真实 020 旧库执行完整升级链，10000 个旧事项（两个空间各5000，另一个空空间）共 419.195 ms。所有旧字段 checksum 保留，10000 个编号按 space/created_at/id 确定排序，next_number 分别为 5001/5001/1；既有保留和回滚组也通过。新计划只有一次窗口计算。准备查询与真实升级在索引和事务条件上不同，没有额外重跑慢旧 SQL，不给伪精确提速倍数。

### 8. 页面与关键功能验收

1. **用户体验。** 20 项必要浏览器检查有实际成功记录，覆盖规划字段、目录、关系、保存视图、完整日历计数、WIP、统计、通知、事件和真实执行。以 2560×1440 为基准，并验证 1920×1080、1600×900、2560×1080；大尺寸使用 520 px 内嵌详情，较窄尺寸使用抽屉，长内容内部滚动且操作栏固定。最终完整加载画面经过目视确认。中英文、草稿冲突、响应丢失后的真实读回、资料引用及原认领行为均已覆盖。
2. **开发体验。** TypeScript/Vite 构建通过。普通看板冷加载没有新增可选目录、通知、统计、自动化或执行记录请求；工作模块关闭后的 16 秒窗口没有 Work 请求或可选页面 chunk。BoardView 单个 JS chunk 约 88.22 kB、gzip 27.23 kB，P0 对应约 104.08/30.28 kB；这是拆分按需组件后的单个 chunk 大小，不等于整个首屏的网络或体验指标。后端双库验证了迁移数据保留/回滚、真实权限、原创建重放、事务原子性、HTTP 在写事务外、真实重启、配置代际切换、迟到结果 CAS，以及外部已成功但本地回执写失败后的恢复。
3. **AI Agent 使用体验。** 严格核对 101 个工具、67 个事项工具，工作流 v3 和实际执行能力、令牌依赖及网关发现。真实执行器验收使用实际 HTTP 与固定 argv 子进程；丢失响应后读取原执行 ID，未知结果不会自动重发，人工处理前在隔离环境确认外部进程已经退出。前端业务源码与已通过的普通 HTTP/worker 路径在后续 SQL 迁移优化中没有改动，因此没有重复运行无关功能组。

浏览器入口为 [browser_work_planning.cjs](../tests/browser_work_planning.cjs)，核心与执行测试位于 `server/internal/home/work_*_test.go`。参考执行器的 12 项具名必要检查覆盖持久幂等、真实子进程、重启未知、超时、输出和容量。测试副本、进程和数据均与生产分离。

### 复现入口

所有入口只接受新建隔离 fixture。先配置独立 PostgreSQL 测试数据库环境变量 LINGSHU_TEST_STORAGE_POSTGRES_URL；真实执行器另设 WORK_EXECUTOR_TEST_BIND 为测试主机已分配的私网地址，LINGSHU_WORK_EXECUTOR_EXAMPLE_DIR 为仓库 examples/work-executor 的绝对路径。

先在同一 Go 工具链构建测试二进制，构建过程不计入负载窗口；执行时当前目录为 server/internal/home。以下 FLAG 每次只开启相应测量，OUTPUT 写到新的证据路径：

~~~sh
cd server
GOMAXPROCS=4 CGO_ENABLED=0 go test -c -p 2 -o ../work-perf.test ./internal/home
cd internal/home
~~~

| 入口 | FLAG（设置为1） | OUTPUT |
| --- | --- | --- |
| TestWorkPerformanceV028 | LINGSHU_WORK_PERFORMANCE_V028 | 同名加 _OUTPUT |
| TestWorkCapacityV028 | LINGSHU_WORK_CAPACITY_V028 | 同名加 _OUTPUT |
| TestWorkStatusChangeCapacityV028 | LINGSHU_WORK_STATUS_CAPACITY_V028 | 同名加 _OUTPUT |
| TestWorkScheduleCapacityV028 | LINGSHU_WORK_SCHEDULE_CAPACITY_V028 | 同名加 _OUTPUT |
| TestWorkAutomationCapacityV028 | LINGSHU_WORK_AUTOMATION_CAPACITY_V028 | 同名加 _OUTPUT |
| TestWorkExecutorCapacityV028 | LINGSHU_WORK_EXECUTOR_CAPACITY_V028 | 同名加 _OUTPUT |
| TestWorkModelMemoryLayout | LINGSHU_WORK_MODEL_MEMORY | 同名加 _OUTPUT |

~~~sh
LINGSHU_WORK_STATUS_CAPACITY_V028=1 LINGSHU_WORK_STATUS_CAPACITY_V028_OUTPUT=/absolute/new-evidence/status.json GOMAXPROCS=4 ../../../work-perf.test   -test.run='^TestWorkStatusChangeCapacityV028$' -test.v -test.timeout=300s
~~~

v0.2.7 的普通请求基线使用该 tag 已有的 TestWorkPerformance / TestWorkCapacityPerformance。相邻状态写入使用同一份 work_status_capacity_v028_linux_test.go 拷入 exact v7 源码；持续读定时基线另拷贝 work_schedule_capacity_v028_linux_test.go 和 work_fixture_v028_linux_test.go。不能将依赖022的事件/执行器测试拷进旧版。两版均使用相同参数、固定数据量、同一个工具链和 PostgreSQL 服务，不用改动中的主树代替旧版基线。

原生 idle 入口为 tests/performance_work_automation_idle.py，参数包括 --binary、--version-file、--web-dir、--output-dir、--seconds；暂停/启用场景增加 --automation-rules 1000、--automation-state paused|enabled、--executors 4、--executor-bind，启用场景再加 --enable-notifications。该脚本自行新建 SQLite 数据目录、端口和随机凭据，不能指向现有服务或数据库。

压测完成后确认所有测量 Home、测试二进制、参考执行器进程退出；本次剩余 0，旧暂停 runner 已结束且未再执行旧版本剩余阶段。隔离 PostgreSQL 服务留供后续测试。原始 JSON、日志、源码/二进制散列及无效首轮均保留；公开 aggregate 不包含凭据、私网地址、PID、原始事项字段或逐请求延迟数组。

This document records reproducible development measurements, their scope, and the changes they motivated. Each section identifies its actual product/build version; earlier development evidence is retained under its original date. These are laboratory samples, not a Lighthouse score, a public-network service guarantee, or real-user Core Web Vitals percentiles.

## Recurring work — 0.2.7, 2026-11-14

Measurements below used the P0 candidate with VERSION 0.2.6 before its release gate found an outdated MCP test-count assertion. The 0.2.7 correction changes test expectations, release documentation and VERSION only; production Go/TypeScript/CSS and migrations are identical. Candidate filenames and measured version labels remain unchanged so the evidence is not relabeled as a second benchmark run.

结论：本轮必要性能验证全部通过。未启用、全部暂停、关闭事项模块时没有正常周期扫描；30 秒观测内未看到 CPU tick 或 I/O 增长。集中到期会占用资源、增加普通请求延迟，不能称为零开销。

复现脚本随源码提供；本轮原始观测保存在维护环境 `.runtime/work-performance-20261114`，最终流水线退出码为 0。下文按实际候选与方法记录结果，正式标签 CI、发行包和镜像验证另行核对。

### 环境、隔离和版本

- nx11 共享主机，Intel Xeon Skylake/IBRS，4 vCPU，GOMAXPROCS=4，x86_64 Linux 7.0.0-38-generic。
- Go 1.26.8；PostgreSQL 18.6；SQLite 驱动 modernc.org/sqlite v1.60.1。
- 全部为本机 loopback HTTP；没有 WAN、浏览器渲染或最大容量含义。
- 旧版：0.2.5 / 14c197e766e5bf0a830756153d3931aa34f16af2，源码归档在 baseline，独立二进制 home-baseline。
- 候选：0.2.6，复制后端最后验证的 binary。最终 binary 是 home-candidate-026-final；源文件与 binary 的 SHA256 在 candidate-026-final-manifest.json。
- HTTP/生成测试使用新 SQLite 数据目录或私有 PostgreSQL 的唯一 schema；真实 idle 脚本自行新建目录、随机 loopback 端口和进程。未向线上 Home 或其他服务施压。

### 未启用时的普通 HTTP 路径

旧/新使用相同 seed 和方法：100 / 1,000 / 10,000 条事项各 25 个顺序样本；10,000 条事项、并发 8、每个工作负载 200 请求；mixed 包含 40 普通创建和 160 读。普通看板 handler SQL 仍为 18，排序索引仍生效。

首轮原证据保留在 baseline-sequential.json / baseline-capacity.json，以及 candidate-026-sequential.json / candidate-026-capacity.json。SQLite 首轮看板 P95 为 161.750 → 162.267 ms，mixed 为 375.682 → 383.052 ms；均无错误。此首轮候选尚未省略空日期字段；后续仅复核最终字节，没有重复已通过的 SQLite 负载组。

首轮 PG 的共享主机负载变化明显，不能直接归因于代码。保留原结果后，在兄弟构建和浏览器停止时只追加一次紧邻 old → candidate PG 对照：

| 请求 | 旧 P50 ms | 新 P50 ms | 旧 P95 ms | 新 P95 ms | 旧 req/s | 新 req/s | 错误 |
|---|---:|---:|---:|---:|---:|---:|---:|
| board | 32.238 | 32.811 | 57.651 | 54.764 | 225.35 | 227.20 | 0 |
| bootstrap | 5.730 | 6.528 | 11.364 | 13.729 | 1167.96 | 1000.05 | 0 |
| mixed | 37.318 | 34.285 | 67.189 | 64.617 | 196.63 | 207.60 | 0 |

证据为 paired-026-postgres-baseline.json / paired-026-postgres-candidate.json。CPU/load 同期记录在最终 status；阶段 host 非空闲 CPU 分别约 54.51% / 53.06%。不能说所有请求都变快；bootstrap 仍有变动，单次共享主机测量不能精确区分调度、GC、环境和代码的微小效应。普通看板和混合路径没有测出可归因的持续回归。

最终正常 board 响应两版均为 8,062,600 B / 200 次，即 40,313 B / 次。可选日期/来源字段使用 omitempty，消除了首轮每项 +45 B、120 卡片 +5,400 B 的空字段成本。

静态内存仍有成本：Go summary 内联布局 168 → 216 B，item 352 → 400 B，均 +48 B。仅指结构体布局，不包括字符串内容、slice、缓存，也不是每条事项的进程常驻内存。空普通 summary 序列化两版均 181 B。见 baseline-026-model-memory.json / candidate-026-model-memory.json。

### 真实独立进程 idle

每次独立新 fixture，准备后取样 30 秒，测量期不发 HTTP 请求；CPU 时钟为 100 Hz。

| 场景 | 规则数 | CPU 秒 | RSS 起/止 KiB | I/O 增量 | 新增事项 |
|---|---:|---:|---:|---|---:|
| 0.2.5 旧版 | 0 | 0.00 | 90352 / 90352 | 全 0 | 0 |
| 0.2.6 无规则 | 0 | 0.00 | 93296 / 93296 | 全 0 | 0 |
| 0.2.6 全部暂停 | 1000 | 0.00 | 131840 / 131840 | 全 0 | 0 |
| 0.2.6 明年才开始 | 1000 | 0.00 | 133716 / 133716 | 全 0 | 0 |
| 0.2.6 明年开始且模块关闭 | 1000 | 0.00 | 133912 / 133912 | 全 0 | 0 |

证据分别在 baseline-idle/measurements.json 和 candidate-026-idle-{zero,paused,future,module-disabled}/measurements.json。

暂停/未来/模块关闭的 RSS 包含 HTTP 创建 1,000 条规则的准备历史、密码 hash 和 Go/SQLite 保留内存，不能按每条规则分摊或线性外推。无规则新版比旧版观察值多 2,944 KiB，也不能单独分解为调度器内存。

无周期扫描由控制流和 helper 共同验证：启动/配置变更唤醒扫描；next=zero 时 tick channel 为 nil，仅等配置 wake/cancel；正常只为最近实际 deadline 设置 timer。两库 helper 验证了 0 规则、全部暂停、模块关闭时 next=zero，未来规则返回 deadline。0 CPU tick/I/O 是支持性观测，不单独证明绝对零成本。真实服务进程的 idle 测量覆盖 SQLite；PG 使用相同 worker 控制流、helper 和活动负载验证。

### 启用并集中到期

每个独立 fixture 先有 1,000 条普通事项，先以 4 并发执行 200 次普通读作为同 fixture 控制组，然后处理 100 / 1,000 条同时到期规则（每批不超过 50）。

生成期间最多 4 个读线程、总上限 2,000 请求，80% board、20% bootstrap。1,000 档达到读上限后停止读并排空生成；下面吞吐是有界混合阶段总体平均，不是持续全程 4 读并发的 SLA。

| 数据库 | 到期规则 | 生成秒数 | 条/秒 | board 对照 P95 ms | 生成中 P95 ms | 生成中 board / 首页样本 | CPU 秒* | RSS 观测峰值 KiB* |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SQLite | 100 | 1.720 | 58.13 | 36.599 | 48.366 | 290 / 72 | 2.799 | 154400 |
| SQLite | 1000 | 10.496 | 95.27 | 32.114 | 47.089 | 1600 / 400 | 16.689 | 137684 |
| PostgreSQL | 100 | 1.381 | 72.39 | 16.769 | 18.054 | 408 / 101 | 2.244 | 150764 |
| PostgreSQL | 1000 | 11.207 | 89.23 | 15.506 | 18.581 | 1600 / 400 | 12.767 | 153584 |

* CPU/RSS 属于 Go 测试进程，包含 HTTP 客户端。SQLite 引擎在同进程内；PG 服务进程 CPU/RSS 不包含，不能由此直接比较两库总 CPU 效率。RSS 包含 fixture 初始化和 GC 状态。控制组从 1,000 事项开始，生成期增长为 1,100 / 2,000，延迟变化同时包含写入竞争与数据增长。

全部 2,200 条到期规则生成正确，failed/skipped/duplicate 都是 0。另 4 个新周期，每个用 1 worker 和 100 次手动请求（并发 8）竞争，只各增加 1 条 item / receipt；400 个 HTTP 请求均 200。普通读、日期视图、手动生成无 HTTP 错误，未遇到数据库锁失败。

| 数据库 | 规则数 | 今日 P95 ms | 逾期 P95 ms | 同周期竞争 P95 ms |
|---|---:|---:|---:|---:|
| SQLite | 100 | 7.092 | 8.232 | 11.954 |
| SQLite | 1000 | 5.533 | 16.482 | 7.538 |
| PostgreSQL | 100 | 10.541 | 12.916 | 24.355 |
| PostgreSQL | 1000 | 18.144 | 28.722 | 24.287 |

日期视图各 25 个顺序请求。完整 P50/P95/max、首页控制项、数量、CPU/RSS 和计划都在 candidate-026-schedules.json。两库 1,000 条规则时 due 查询使用 work_schedules_due；PG 100 条时选择 Seq Scan 属于小表成本选择。

### SQLite 部分索引的实际计划

在 5,000 普通事项 + 100 日期事项的真实 SQLite fixture 中比较等价谓词：

| 路径 | 缺少显式非空谓词 | 加入谓词后 |
|---|---|---|
| today / 精确 businessDate | work_items_column | work_items_business_date |
| overlap=skip | SCAN w | work_items_schedule_date |
| overdue | 已有非空谓词 | work_items_due_at |

见 candidate-026-date-plans.json。最终代码只补逻辑等价的 business_date<>'' / schedule_id<>''，没有把新索引变为覆盖全部旧卡的全量索引。

### 复现与文件

日常测试不会执行这些 opt-in 压力。PG 必须事先设置独立测试库的 LINGSHU_TEST_STORAGE_POSTGRES_URL；缺少时 fixture 会跳过 PG，不能将 skip 计为双库通过。本轮 PG 均实际执行。

从 server 目录、配置可用 Go 1.26 工具链后运行：

~~~sh
GOMAXPROCS=4 LINGSHU_WORK_PERFORMANCE=1 LINGSHU_WORK_PERFORMANCE_OUTPUT=/tmp/work-sequential.json go test -p 2 ./internal/home -run "^TestWorkPerformance$" -count=1 -v
GOMAXPROCS=4 LINGSHU_WORK_CAPACITY=1 LINGSHU_WORK_CAPACITY_OUTPUT=/tmp/work-capacity.json go test -p 2 ./internal/home -run "^TestWorkCapacityPerformance$" -count=1 -v
GOMAXPROCS=4 LINGSHU_WORK_SCHEDULE_PERFORMANCE=1 LINGSHU_WORK_SCHEDULE_PERFORMANCE_OUTPUT=/tmp/work-schedules.json go test -p 2 ./internal/home -run "^TestWorkSchedulePerformance$" -count=1 -v
LINGSHU_WORK_DATE_PLAN=1 LINGSHU_WORK_DATE_PLAN_OUTPUT=/tmp/work-date-plans.json go test -p 2 ./internal/home -run "^TestWorkDateQueryPlans$" -count=1 -v
LINGSHU_WORK_MODEL_MEMORY=1 LINGSHU_WORK_MODEL_MEMORY_OUTPUT=/tmp/work-model.json go test -p 2 ./internal/home -run "^TestWorkModelMemoryLayout$" -count=1 -v
~~~

Linux idle 从仓库根运行，输出目录必须全新：

~~~sh
python3 tests/performance_work_idle.py --binary /absolute/path/lingshu-home --version-file VERSION --web-dir /absolute/path/frontend-dist --output-dir /tmp/home-idle-new --seconds 30 --label future --rules 1000 --schedule-state future
~~~

0 规则省略 rules；暂停用 --schedule-state paused；模块关闭在 future 上加 --disable-work。脚本不接受线上 base URL，只创建和结束自己的进程、目录和端口。

新增测试文件：

1. server/internal/home/work_capacity_performance_test.go
2. server/internal/home/work_model_memory_test.go
3. server/internal/home/work_schedule_performance_linux_test.go
4. tests/performance_work_idle.py

原有 work_performance_test.go 未修改。这些性能文件按显式环境变量开启，日常功能测试不自动执行压力。

### 覆盖边界

未覆盖公网/多机器、数万并发、长时间 Soak、PG 服务进程完整 CPU/RSS、浏览器渲染性能、1,000 规则全程持续读 SLA。后续版本需使用对应源码和独立结果，不能把本轮候选数字当成后续实现的实测。


## Work board — 0.1.0, 2026-11-13

The board is a deferred Library view. Its initial request returns up to 30 summaries per status (120 in total), with cursor-based continuation. Description/result bodies and mounted Markdown contents are not loaded into these summaries. Dragging uses native browser events and existing UI primitives; no new drag-and-drop dependency or background board polling was added.

### Database and HTTP measurements

`TestWorkPerformance` exercised disposable SQLite and PostgreSQL fixtures at 100, 1,000 and 10,000 items. Each operation used one warmup followed by **25 sequential local HTTP samples**, including authorization. These are development measurements without concurrent clients, remote latency, production storage contention or a service-level guarantee.

| Items | SQLite board P95 | PostgreSQL board P95 | Summary response bytes |
| --- | ---: | ---: | ---: |
| 100 | 6.525 ms | 7.676 ms | 33,565 |
| 1,000 | 6.453 ms | 10.953 ms | 40,973 |
| 10,000 | 9.651 ms | 18.653 ms | 40,977 |

| Other operations at 10,000 items | SQLite P95 | PostgreSQL P95 |
| --- | ---: | ---: |
| List first page | 5.836 ms | 14.741 ms |
| Move an item | 4.067 ms | 12.145 ms |
| Needs-attention filter plus text query | 12.272 ms | 15.569 ms |

The board handler issued **7 SQL calls** at each size; this count excludes surrounding authentication/transaction setup. Actual column query plans used `work_items_column` at 1,000 and 10,000 items. PostgreSQL chose a sequential scan for the small 100-item fixture, which is a valid planner choice.

The first 10,000-item attention/query measurement exposed a SQLite P95 of **42.584 ms**. Adding `(space_id, archived, needs_attention, status, sort_order, id)` to migration 012 reduced the same-method local result to **12.272 ms**, approximately 71% lower. PostgreSQL changed from 20.648 ms to 15.569 ms. Before/after samples and plans were retained; these are sequential measurements on one host, not a claim about every deployment or concurrent search capacity.

Reproduce the optional performance suite from `server/` with `LINGSHU_WORK_PERFORMANCE=1` and a dedicated PostgreSQL test database as described in [the test guide](../tests/README.md). It is opt-in to avoid turning ordinary functional CI into a timing benchmark.

### Actual browser population limits

A separate Chromium suite used fresh SQLite fixtures and three fresh browser contexts per size at 2560×1440. Its synthetic titles and descriptions differ from the Go HTTP fixture above, so response sizes are not interchangeable.

| Stored items | Initial mounted cards | DOM nodes | Median board-ready observation | HTTP P95, 20 samples | Response bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 | 100 | 1,833 | 986.6 ms | 7.659 ms | 30,177 |
| 1,000 | 120 | 2,157 | 999.1 ms | 8.435 ms | 36,919 |
| 10,000 | 120 | 2,157 | 1,002.6 ms | 13.306 ms | 36,923 |

Board readiness means a real card was visible and two animation frames had completed. It is not FCP, LCP or a browser score. The initial DOM remained bounded between 1,000 and 10,000 records; explicitly loading additional pages can add cards. The functional viewport check also observed **zero work API requests during a settled five-second foreground interval**. This short observation verifies absence of board polling in that scenario, not server-wide inactivity.

### Homepage comparison with released 0.0.11

The released 0.0.11 frontend/server and the 0.1.0 candidate each ran against their own fresh fixture with the same single manual-icon bookmark. Three fresh contexts per version used the same Chromium runtime and 2560×1440 viewport.

| Median of three samples | Released 0.0.11 | 0.1.0 candidate |
| --- | ---: | ---: |
| Initial JS/CSS encoded bodies | 250,455 B | 251,030 B |
| Homepage DOM nodes | 143 | 143 |
| Readiness observation | 889.4 ms | 892.6 ms |
| Observed LCP | 176 ms | 160 ms |
| Pre-observation long-task blocking | 79 ms | 73 ms |

The initial encoded JS/CSS increase was **575 B (about 0.23%)**. Neither version requested BoardView assets or work API data from the homepage. Readiness includes the test's `networkidle` wait; three local samples are too few to infer a meaningful speed improvement or regression from the small timing differences. The existing main-entry size warning remains visible in the Vite build; deferred board code does not eliminate all pre-existing entry-bundle cost.

### Interaction and responsive verification

Chinese and English checks exercised the board at **2560×1440, 1920×1080, 1600×900 and 2560×1080**, including board/list switching, detail bounds, footer/header controls and real close clicks. The 2200px breakpoint retains an inset detail pane on large screens and an overlay drawer below it.

The first smaller-screen run exposed inherited Dialog translation and a drawer stacking level below the overlay. The fix explicitly resets the Tailwind translation variables and uses the existing Dialog content stacking level. The corrected build passed all four sizes and was visually inspected. Project archive failure/readback was also checked against actual submitted archive state; a matching name alone cannot confirm an archive.

See [work items](WORK_ITEMS.md) for behavior and permissions and [the test guide](../tests/README.md) for functional, migration and process-restart evidence. Candidate measurements do not themselves establish release publication or deployment.

## Network routing, template discovery and dashboard presets — 2026-10-19

This iteration uses `index-DULkGFQe.js`, `index-BVg0b9Zj.css` and deferred `DashboardPresetDialog-LOTH5yel.js`. The tested binary SHA-256 is `e696cc5b2996f2e15bfbf05cc99cdb6fa02f1b9a94922e84359071207bf07a04`. Build output and disposable test data are isolated from the daily and previous demo instances. All values in this section belong to this build; older measurements remain in their own sections below.

Selecting a dashboard preset compiles a page draft. It does not create a source, enable collection, or allocate a history store. The source setup form is an explicit separate action. Server proxy configuration adds no health-check timer. Bookmark route selection runs only after an ordinary primary-link click, uses a bounded in-memory cache, and has no hover, focus or idle polling. Existing source workers still run when an enabled polling source is configured; hiding its card does not disable collection.

### Navigation-only browser and process samples

The dedicated public `open_edit` fixture contains 12 distinct bookmarks in three groups and three favorites, yielding 15 rendered cards. Every bookmark uses a bundled/manual icon. Both automatic website icons and automatic endpoint selection are enabled, and no external data source is configured. This is a quiet navigation workload, not an active provider, icon-discovery, authentication or maximum-collection workload.

The final `browser_lightweight_idle.cjs` run first verified that real bookmark cards were visible, then observed the foreground page for **65.007 seconds**. Its **41 checks passed**. The initial and final card counts were both 15, document width remained 2560 px, and the page remained visible. There were **zero additional HTTP requests, zero WebSocket attempts, zero forbidden requests and zero console/page errors**. DataPanels, TrafficPanel, WidgetImportDialog, DashboardPresetDialog and HomeEditor JS/CSS chunks were not requested. This identifies deferred output files; it does not assert that every related helper is absent from the entry bundle.

An independent Linux sample of the same initialized process at 07:41:02–07:41:12 UTC recorded:

| Metric | Observation |
| --- | --- |
| RSS, beginning / end | 22,012 / 22,048 KiB, approximately 21.5 MiB |
| Process high-water RSS, beginning / end | 22,012 / 22,048 KiB |
| CPU tick change | 1 tick over 10.0007 seconds, at 100 ticks/second |
| Equivalent process CPU time | 0.01 seconds, approximately 0.1% of one core over this interval |

This is a short process sample, not a memory ceiling, a zero-work guarantee or an improvement claim against different historical workloads. Go allocator/scavenger timing can change RSS and CPU without browser requests. Account password hashing, larger collections, active fetches and enabled sources have additional costs. The browser report alone cannot establish server-side inactivity.

The Chinese and English dashboard-preset suites each also observed a saved page with explicitly created push sources for **65 seconds**, with zero additional HTTP requests and zero WebSockets. Push sources have no polling schedule. These are separate functional observations, not extra samples in the cold-load benchmark below.

### Cold-load laboratory measurement

`browser_performance.cjs` ran at **2026-10-19T07:41:49.991Z**, using Chromium **155.0.8059.12**, a **2560 × 1440** viewport and the desktop profile. It used three fresh contexts for the homepage and three for link management, disabled HTTP caching, and rejected all writes and foreign-origin requests. All six samples completed with zero browser errors and zero forbidden requests. The benchmark copy omitted the redundant explicit `--no-sandbox` argument; application and browser network-policy settings were unchanged.

| Median of three | Homepage | Link management |
| --- | ---: | ---: |
| Initial JS/CSS encoded response bodies | 177,964 B (173.8 KiB) | 259,727 B (253.6 KiB) |
| Initial JS/CSS decoded bodies | 616,514 B | 868,373 B |
| Resource Timing transfer sizes, including its header allowance | 179,164 B | 265,127 B |
| FCP / observed LCP | 644 / 644 ms | 624 / 624 ms |
| Readiness observation | 1,666.2 ms | 1,976.7 ms |
| Navigation response start | 138.7 ms | 138.5 ms |
| Initial CLS | 0 | 0 |
| Pre-interaction long-task blocking | 106 ms | 0 ms |
| DOM nodes | 398 | 541 |
| Mounted management rows | — | 12 |
| Search input to two animation frames | 27.0 ms | 24.5 ms |
| Largest observed Event Timing duration | 64 ms | 56 ms |

Paint timings may describe the initial boot surface; readiness includes the network-idle observation. These are laboratory samples, not field INP, percentile guarantees or a Lighthouse score. There was no paired baseline run with this iteration, so the smaller readiness numbers compared with historical sections do not prove an improvement. The 106 ms of homepage startup blocking remains a measured opportunity for later profiling; the quiet-page result does not imply negligible startup work.

### Actual compressed output files

The entry JS is **449,571 B**, with a **141,318 B** gzip sidecar. Entry CSS is **129,837 B**, with a **23,441 B** sidecar. Those two sidecars total **164,759 B**, 4,108 B above the preceding automatic-icon build's corresponding files. That is a file-level comparison, not the complete incremental feature cost. The homepage's other eagerly requested shared chunks account for the remaining 13,205 B in the measured initial encoded total.

| Deferred output | Actual gzip sidecar bytes | Scope |
| --- | ---: | --- |
| Dashboard preset dialog | 8,275 JS + 1,023 CSS = 9,298 | Preset catalogue, binding setup and draft application UI |
| Four data renderers | 6,070 JS + 1,868 CSS = 7,938 | Shared calendar/weather/metrics/status views |
| Template import dialog | 7,906 JS + 743 CSS = 8,649 | Template selection, examples and review UI |
| Homepage editor | 11,562 JS + 3,992 CSS = 15,554 | The existing composer, loaded when editing starts |
| Traffic renderer | 3,618 JS | Existing GitHub Traffic presentation |

Shared dependencies and the source dialog are separate files; these values are not promises that opening a feature loads exactly one row's total. The isolated final `assets` directory contains 61 files, including 26 precompressed sidecars. Compression is verified from files on disk and actual encoded browser response bodies, not Vite's estimated gzip column. Build-time compression and static/API cache policies remain as documented below.

Raw functional reports, six browser samples, process observations and screenshots are retained with the private iteration evidence. [tests/README.md](../tests/README.md#当前轮次网络模板预置与空闲验收) records real versus controlled network boundaries and separate final-source HTTP, race, Docker and packaging results. These browser and process measurements do not establish long-duration behavior, real provider-account compatibility, throttled-device performance or release-gate completion.

## Previous automatic website icons and idle operation — 2026-10-19

This follow-up uses `index-CfyvMXdD.js`, `index-DnX6M1YH.css` and deferred `AdminView-BQ-_eEvG.js`. The binary SHA-256 is `3bffc8161829602fe2e2773e0c8d50cf5eaed52969e3b80d145432c8fcf36cac`. The measurements below apply to that build. The preceding component iteration and its cold-load timings are retained separately below.

Automatic acquisition runs after an authorized bookmark save or import commits. One worker consumes durable, deduplicated per-space/origin jobs; an empty queue has no periodic timer. A page visit, image GET, cache expiry or re-enabling the setting does not scan bookmarks. A new navigation-only Refresh content action reads the saved dashboard explicitly without adding polling or a WebSocket. Settings and per-link controls add no runtime dependency or separate image service.

Image bytes remain in the existing database. The server caches successful discovery for 24 hours and failures for 30 minutes, with later eligible saves or an explicit lookup triggering the next attempt. These intervals do not create automatic retry timers. Browser image responses use `private, no-cache` and ETag validation after current authorization; JSON APIs remain `no-store`. Limits and cancellation behavior are in [ICONS.md](ICONS.md).

### Current idle samples

Two new ownerless `open_edit` fixtures each contained five bookmarks, one original local SVG and no external data sources. The automatic-icon switch was enabled, with zero queued jobs or favicon cache records at observation time. No public-site discovery was active. After the Chinese and English acceptance runs, Linux process samples gave:

| Fixture | RSS at both ends | Observed process high-water RSS | CPU tick change / sample |
| --- | ---: | ---: | --- |
| Chinese | 17,220 KiB (16.8 MiB) | 23,580 KiB (23.0 MiB) | 0 / 10.003 s |
| English | 17,304 KiB (16.9 MiB) | 23,716 KiB (23.2 MiB) | 0 / 10.003 s |

CPU ticks use 100 ticks/second. Zero means no measurable tick increase during this interval. RSS is a process sample after this workload and allocator reclamation, not a guaranteed minimum, cap, or an established improvement over the preceding 12-bookmark fixture. Real password hashing, enabled sources, network acquisition and larger collections have different resource costs.

Each visible browser also remained idle on its navigation-only homepage for **65 seconds** after requests settled. Both recorded **zero additional requests**, **zero WebSockets**, no foreign-origin browser requests and no console/page errors. This covers the default-enabled setting with an empty automatic queue; it does not claim zero traffic while jobs or external sources are active.

### Build size and cache verification scope

The current entry JS is 439,079 B, with a 137,315 B gzip sidecar; entry CSS is 129,275 B, with a 23,336 B gzip sidecar. These two sidecars total 160,651 B. The preceding component build's two sidecars total 160,635 B, a 16 B difference. This compares those files only, not all initial browser resources or the complete feature cost. The deferred AdminView sidecars are 43,565 B JS and 1,118 B CSS; other shared dependencies are separate.

The Chinese and English functional browser suites each passed 80 checks, including same-origin image rendering after reload and an explicit conditional request returning an empty 304. Their request routing disables Chromium's ordinary HTTP cache, so this is protocol validation rather than a measurement of automatic browser-cache hits. Backend tests separately verify ETag syntax, revoked authorization, cross-space access and error headers.

This follow-up did not repeat the cold-load FCP/LCP/CLS benchmark, container measurements or race checks. It does not reuse the timings below as results for the new binary. Raw process/browser reports and screenshot verification are retained with the private iteration evidence; reproduction commands and the exact test boundaries are in [tests/README.md](../tests/README.md#当前轮次自动网页图标).

## Previous component iteration: sources and idle operation — 2026-10-19

The final UI uses `index-B0fG8zm7.js`, `index-DnX6M1YH.css` and deferred `DataPanels-Cg_z1Jh5.js`. The Go binary's SHA-256 is `eebf96e0a78fb2c4def713f6c90aca04c1f8062a73c6d8e319c356ba9776749d`. The complete implementation and test boundaries are in [COMPONENTS.md](COMPONENTS.md) and [tests/README.md](../tests/README.md).

### What is avoided when no external source is enabled

The integration scheduler waits for a due source or an explicit, committed source change. It has no periodic empty-table scan. A push-only source does not create a polling job; source responses and normalized snapshots are bounded. A hidden component does not implicitly disable its source: users disable a source to stop collection, while retaining the last good snapshot.

Calendar/weather/metrics/status share one deferred renderer chunk and shared dashboard reads. Ordinary cards do not create independent polling intervals or WebSockets. Navigation-only browsing does not load that chunk, TrafficPanel or the component-template dialog. It requires no additional agent, Redis, queue, or time-series service.

### Server samples: startup, browsing and authentication are different workloads

Measurements use Linux process RSS, not virtual address space. CPU time comes from `/proc/PID/stat` at 100 ticks/second; “0” means no measurable tick increase in that sample, not a guarantee of zero instructions or work for all environments.

| Workload | RSS sample | Peak/scope | Observed CPU |
| --- | ---: | --- | --- |
| Before the startup fix: fresh, uninitialized, no sources | 85,092 KiB (83.1 MiB) | One sample before removing a redundant dummy-password derivation | 0 ticks / 10.00 s |
| Final binary: fresh, uninitialized, no sources | 19,728 KiB (19.3 MiB) | Same local environment, separate fresh process | 0 ticks / 10.00 s |
| Initialized navigation-only instance after cold-browser measurements | 21,452 KiB (20.9 MiB) | 12 stored bookmarks, no external sources; visible idle browser | 0 ticks / 10.00 s |
| New account plus component acceptance activity | 91,704 / 92,128 KiB (89.6 / 90.0 MiB) | Chinese/English fixture process high-water values after real password hashing and page/API activity | Not an idle-CPU comparison |

The fixed public dummy hash preserves the full unknown-account verification path, with the same Argon2id parameters as real passwords. It eliminates one unnecessary startup derivation. Real password creation and login still allocate their original 64 MiB work area. The tests reject unknown users even when their input matches the public dummy fixture; this is not a shared login credential.

An earlier sample during six active browser cold loads increased by 0.12 CPU seconds and is retained as a browsing sample, not reported as idle. The final idle sample was taken after those cold-load requests finished. Results depend on allocator/scavenger timing, traffic, enabled sources and snapshots; no fixed maximum RSS is promised.

### Final browser lab measurement

The existing `tests/browser_performance.cjs` ran three fresh contexts for the homepage and three for link management, with the HTTP cache disabled, Chromium **155.0.8059.12**, desktop profile and **2560 × 1440** viewport. This is a new disposable `open_edit` instance with **12 distinct local bookmarks in three groups**. Its default Favorites panel repeats three of those links, giving 15 rendered bookmark cards. No external source is configured.

| Median of three | Homepage | Link management |
| --- | ---: | ---: |
| Initial JS/CSS encoded response bodies | 173,786 B (169.7 KiB) | 245,024 B (239.3 KiB) |
| Initial JS/CSS decoded bodies | 605,230 B | 828,683 B |
| FCP / observed LCP | 672 / 672 ms | 668 / 668 ms |
| Readiness observation | 1,876.5 ms | 2,229.8 ms |
| Initial CLS | 0 | 0 |
| Pre-interaction long-task blocking | 76 ms | 0 ms |
| DOM nodes | 361 | 500 |
| Mounted management rows | — | 12 |
| Search input to two animation frames | 26.1 ms | 26.8 ms |
| Largest observed Event Timing duration | 48 ms | 48 ms |

There were no browser errors, write attempts or foreign-origin requests. These measurements do not establish a speedup over the historical 43-link benchmark below: the fixtures, source tree and observation times differ. The 76 ms of homepage startup blocking remains a concrete optimization opportunity. FCP/LCP may describe an early boot surface; readiness includes the network-idle observation. These are laboratory observations, not field INP or a Lighthouse score.

The entry JS and CSS gzip sidecars are 137,299 B and 23,336 B. Including their eagerly requested shared chunks yields the measured 173,786 B total. Optional chunk sizes are:

| Deferred feature | gzip sidecar bytes | Scope |
| --- | ---: | --- |
| Four data renderers | 6,061 JS + 1,868 CSS = 7,929 | Shared calendar/weather/metrics/status rendering |
| Traffic renderer | 3,611 JS | Existing Traffic presentation |
| Template dialog | 3,760 JS + 487 CSS = 4,247 | Template import UI; editor/shared dependencies are separate |

These are specific output files, not guarantees that every feature's full incremental load equals one chunk.

### Visible-page idle check

A separate fresh browser loaded the navigation-only instance, waited for its bookmarks, then remained visible without interaction for **65.055 seconds**. It observed **zero additional requests**, **zero WebSockets**, no blocked foreign-origin/write attempts and no browser errors. Resource entries contained no DataPanels, TrafficPanel or WidgetImportDialog chunk. This check crosses a 60-second interval boundary; it does not simulate every focus/background transition or an enabled polling source.

The ordinary component refresh action still reads a shared cached dashboard. The full component acceptance checks verify exactly one dashboard GET and no upstream sync request for that action, and no page writes for calendar day/week browsing.

Raw reports, geometry and process samples are retained in the private iteration verification directory. The historical metrics below belong to older implementations. This iteration does not claim current-source Docker/race/hosted-CI performance or long-duration behavior under maximum source/event counts.

## Historical visual composer, iOS theme and icons — 2026-10-18

The final frontend uses `index-QrhLUHDl.js`, shared `dist-BJSLTIqn.js` and `index-Co5760t1.css`. Its visitor route keeps the visual editor deferred. Imported icons are served from the current space on the same origin; ordinary viewing does not initiate website discovery or load an external icon library.

The preceding logo/card-sizing build was measured starting at **15:44:32 UTC**; the final build, including localized icon errors, was measured at **16:16:15 UTC**, in Chromium **155.0.8059.12**. The comparison uses **twelve fresh contexts in total**: two builds × homepage/admin × three repetitions. An intermediate six-context measurement at 15:44:49 UTC is retained separately but is not included in the table. Both compared builds use the same 43 links, eight categories, three favorites and restored Classic/content-height page configuration at **2560 × 1440**. The final run reuses the earlier unchanged baseline; the time gap and small sample size limit timing conclusions. These measurements use the **desktop profile only**; the four-times CPU profile below is historical. The scripts disabled browser caching and rejected all writes and foreign origins. Both reports contain zero browser errors and zero write attempts.

| Desktop metric, median of three | Previous homepage | Current homepage | Previous admin | Current admin |
| --- | ---: | ---: | ---: | ---: |
| Initial JS/CSS encoded bodies | 164,184 B | 174,389 B | 223,607 B | 239,232 B |
| Initial JS/CSS decoded bodies | 571,379 B | 608,560 B | 759,917 B | 814,761 B |
| FCP / observed LCP | 656 ms | 636 ms | 656 ms | 632 ms |
| Readiness observation | 1,783.9 ms | 1,875.1 ms | 2,097.8 ms | 2,142.6 ms |
| Initial CLS | 0.004714 | 0 | 0 | 0 |
| Search input to two animation frames | 31.3 ms | 29.0 ms | 28.2 ms | 25.7 ms |
| Pre-interaction long-task blocking | 110 ms | 124 ms | 0 ms | 0 ms |
| DOM nodes | 827 | 828 | 869 | 873 |
| Mounted admin rows | — | — | 25 | 25 |
| Document height | 1,440 px | 1,440 px | 1,440 px | 1,440 px |

The added theme and shared icon support cost **10,205 B (6.2%)** on the homepage and **15,625 B (7.0%)** on the admin route in compressed response bodies. This is actual browser resource timing, including all initially loaded JS/CSS chunks. FCP/LCP can describe the boot screen; readiness includes the network-idle observation. Small timing differences from three samples do not prove a general speedup: readiness on both surfaces and homepage startup blocking increased slightly, while search-to-frame observations decreased. Navigation response medians stayed between 138.1 and 139.9 ms. Observed interaction maxima were 72 ms on both homepages and 56 ms on both admin builds; these are lab Event Timing samples, not field INP.

Separate normal-motion UI runs passed eight composer workflows in **each** language. They exercised the fixed editor shell, selectable categories, added/duplicated components, theme preview, six-slot validation, a 390 px property drawer and actual save/reload/restoration. The 2K editor's document remained 2560 × 1440 without root overflow. Icon-library flows separately validated same-origin image decoding and complete cleanup of their temporary content. These functional runs are not additional performance samples. Commands, deliberate-write boundaries and the website-fetch outcome are in [tests/README.md](../tests/README.md).

Raw `performance-baseline.json` and `performance-current-final.json` are retained in the private verification directory; `performance-current.json` is the intermediate build's report. Reproduce this comparison with `PERFORMANCE_PROFILE=desktop PERFORMANCE_REPEATS=3`; run the baseline and current builds sequentially without changing their data or page configuration. Measuring iOS-specific rendering, editor latency, throttled devices and much larger collections remains outside this comparison.

## Historical logo and card-sizing follow-up — 2026-10-18

The final logo/card-sizing build uses `index-Bt7DVb98.js` and `index-BpXllbTu.css`. Its initial JavaScript/CSS gzip files are **143,244 B** and **20,940 B**, totaling **164,184 B**, compared with **163,335 B** for the measured preview/language build below: an **849 B** increase (about 0.5%). The shared SVG mark is **1,298 B**, with optional 32 px favicon (**1,262 B**) and 180 px touch icon (**6,444 B**) exported from it. These are actual build-file and gzip-sidecar sizes, not measured browser transfer totals; icon fetching depends on the browser.

This follow-up keeps deferred admin/editor loading, build-time compression and the static-cache policy. Card rows use available tracks; adjacent small categories share available space in their existing order, while larger categories retain full rows and favorites keep a bounded background. The explicit Fit content action changes an editable draft's height mode. Logo images reserve their dimensions before loading. The timing, CLS and long-task figures in the sections below describe the earlier entry assets named there; a new twelve-context performance benchmark has not been run for this follow-up. Current functional and geometry checks are recorded separately in [tests/README.md](../tests/README.md).

## Changes from the compact-admin iteration

- Link/category management mounts only the selected page of 25, 50, or 100 rows from the authorized navigation snapshot. The header, toolbar, table header and paginator stay visible; only the table body scrolls. This reduces DOM work without changing the navigation API.
- Homepage category counts, parent paths and search text reuse an index for each immutable dataset object. Grouping uses a single pass over links. These caches contain already authorized browser data and do not replace server authorization.
- Login/setup forms and the multi-space selector load when required. A single-space homepage does not eagerly load the admin form, Dialog or Select implementation. The default desktop grid keeps its initial layout implementation available.
- The grid measures its real container width before paint. Previously its first pixel layout used a 1,440 px fallback and then widened, moving cards between rows. Grid configuration, child elements and interaction callbacks keep stable references when their inputs have not changed, reducing avoidable work during content-height updates.
- Production builds create gzip sidecars for JavaScript/CSS files of at least 1 KiB when compression reduces their size. The Go service negotiates these only for static assets, honors an explicit `gzip;q=0`, sets `Vary: Accept-Encoding`, and serves the original representation for range requests or missing sidecars. Compression is performed during the build, not on every request.
- Content-hashed `/assets/*.js` and `/assets/*.css` use `public, max-age=31536000, immutable`. HTML and unversioned files use `no-cache` (revalidation). JSON API, MCP and health responses remain `no-store`; authorized icon image responses use private ETag revalidation.
- Native scrolling is retained. `scrollbar-gutter: stable`, bounded overflow regions, visible scrollbars and category scroll buttons address layout movement and reachability without adding a simulated-scrolling library.

## Reproduce the browser measurement

Use a disposable instance containing a fixed public navigation dataset. The recorded comparison uses 43 public links, eight categories, a 2560 × 1440 viewport and a fresh Chromium context for every sample. Do not change the dataset, page configuration, build or server while a comparison is running.

```bash
BASE_URL=http://demo-host:5182 \
LINGSHU_PLAYWRIGHT_MODULE=/path/to/playwright \
CHROMIUM_EXECUTABLE=/path/to/chromium \
PERFORMANCE_OUTPUT=.runtime/performance-current.json \
node tests/browser_performance.cjs
```

The script is read-only: it rejects write requests and foreign origins, clears the HTTP cache for every sample, and measures three repetitions for both the homepage and link management. Optional `PERFORMANCE_PROFILE=desktop` or `throttled` selects one profile; `PERFORMANCE_REPEATS=1..5` controls repetitions. `--baseline` labels an existing build for comparison; it does not switch application versions.

| Profile | CPU | Network emulation |
| --- | --- | --- |
| Desktop | No CPU throttling | Actual test-network conditions |
| Throttled | Chromium 4× CPU slowdown | 40 ms requested latency, 10 Mbit/s download, 2 Mbit/s upload, in addition to the underlying network |

The output includes raw per-sample resource timings, FCP, LCP, CLS using session windows, navigation response time, DOM size, mounted table rows and long tasks. `readyMs` includes the script's network-idle observation and must not be described as a user's first paint. `blockingTimeMs` sums the portion above 50 ms of observed pre-interaction long tasks; it is a diagnostic observation, not a Lighthouse TBT score.

Search latency is measured from a real input event to two animation frames later. The maximum observed Event Timing duration is a small laboratory interaction sample, not field INP. The browser's first visible boot state may be an LCP candidate, so compare readiness, layout stability and resource transfer alongside paint timings. Medians of three samples indicate this test run only; they are not a 75th-percentile real-user assessment.

## Composition, preview and form refinement — 2026-10-18

This section records the 2026-10-18 build. Since 0.0.8, enabled header/footer areas stay visible around an independently scrolling body; the historical footer behavior and measurements below describe the earlier build only.

This later iteration adds the homepage draft editor, an actual-homepage preview in the layout settings, configurable header/footer slots and instance-level English. Category folding now updates measured grid width and content height before paint instead of animating the container width through intermediate layouts. The footer follows the page's flex flow: it rests at the bottom of short pages and follows all content on longer pages. The homepage editor remains a deferred chunk until editing starts; ordinary homepage measurements below do not include an opened editor or preview.

The final build also limits Tailwind class detection to `web/src`, using `source(none)` and an explicit source declaration. Automatic detection had made a build in a different output directory generate an additional 118 selectors and a 124,510 B stylesheet. The explicit source range produces the same **51 output files, including gzip sidecars, byte for byte** in two independent output directories. The resulting stylesheet is **109,843 B**. A scan audit found all 39 source files and no files outside that scope; the source's shared components and complete variant strings remain included. This build boundary follows [Tailwind's explicit source registration](https://tailwindcss.com/docs/detecting-classes-in-source-files#disabling-automatic-detection). No stylesheet is generated from private design documents or previous bundles.

The same 43-link, eight-category dataset and saved fixed-height navigation configuration were measured in **12 fresh Chromium contexts**, using both profiles and three loads of each surface. Chromium was `155.0.8059.12`; the measurement started at `2026-10-18T10:47:06.336Z`. The measured entry assets were `index-B_HJ6vA2.js` and `index-CLUYafx8.css`. Raw results are retained in the maintenance environment as `performance-source-final.json`; they are not required to run the public test script. No write requests or browser errors occurred.

### Resource and layout comparison with the preceding iteration

| Metric | Previous compact-admin build | Composition build |
| --- | ---: | ---: |
| Homepage initial JS/CSS, actual encoded response bodies | 156,805 B | 163,335 B |
| Admin initial JS/CSS, actual encoded response bodies | 202,542 B | 222,719 B |
| Homepage JS/CSS after decompression | 537,698 B | 568,189 B |
| Admin JS/CSS after decompression | 683,166 B | 756,731 B |
| Homepage initial CLS, both profiles | 0.001898 | 0 |
| Admin initial CLS, both profiles | 0 | 0 |
| Document height, homepage and admin | 1,440 px | 1,440 px |
| Mounted admin table rows | 25 | 25 |
| Homepage DOM nodes | 821 | 824 |
| Admin DOM nodes | 868 | 868 |

Encoded initial resources increased by **4.2% on the homepage** and **10.0% in admin**. The added language strings, composition controls and preview implementation have a measurable cost. The zero CLS result applies to these laboratory loads; it is not a guarantee for every theme, dataset, external image or device.

### Current timing observations

Values are medians of three repetitions, in milliseconds. Readiness includes the network-idle observation. FCP and observed LCP may describe the initial boot state rather than usable bookmarks.

| Profile / page | FCP and observed LCP | Readiness observation | Search input to two frames | Pre-interaction long-task blocking |
| --- | ---: | ---: | ---: | ---: |
| Desktop / homepage | 896 | 2,164.9 | 32.5 | 137 |
| Desktop / admin | 652 | 2,154.8 | 28.3 | 0 |
| 4× CPU / homepage | 948 | 2,258.2 | 83.8 | 738 |
| 4× CPU / admin | 992 | 3,042.6 | 92.6 | 262 |

Navigation response medians were 139.3–140.0 ms for three profile/surface combinations, while the desktop homepage observed 389.8 ms. That larger response wait means its paint and readiness increase cannot be attributed entirely to frontend code. The maximum observed interaction durations in the four summaries were 72, 64, 304 and 232 ms, respectively; these are small laboratory Event Timing samples, not field INP. Compared with the immediately preceding iteration, homepage startup blocking remained higher, while throttled admin blocking and readiness decreased; throttled search-to-frame observations increased on both surfaces. The fold and footer fixes improve visible stability, but this run does **not** establish an overall speed improvement. Lowering React/grid startup and filtered-card reconstruction cost remains a concrete performance target.

### Interaction and responsive evidence

- Normal-motion category folding was checked separately from paint timing: repeated fold/unfold actions retained document width, final grid geometry and scrollbar bounds. The Chinese run observed 14 actions across 157 frames; the continuous English run observed 14 actions across 174 frames. These are actual observations, not a requested frame-rate target.
- Actual homepage previews were checked at logical 2560 × 1440, 1920 × 1080, 1600 × 900 and 2560 × 1080 sizes. A scaled preview uses its own viewport for layout; the settings sidebar width does not become the simulated screen width.
- The separate responsive geometry run passed 65 total assertions at 2560 × 1440, 1920 × 1080, 1600 × 900, 2560 × 1080, 768 × 1024 and 390 × 844. This script uses reduced motion and checks overflow, panel overlap and retained data. It must not be described as a normal-animation run on all six sizes.
- Dedicated form runs passed 118 Chinese and 119 English assertions. The checks include keyboard Select interaction, search focus, inline constraints, corrected input retention, file selection, access-mode radios and dialog focus restoration. A real regression in which validation could restore an older input value was fixed by validating after the field's change handler has updated its state.
- The editor boundary checks passed 67 assertions for hidden/disabled-slot URL validation, visible error focus and draft restoration, plus 75 assertions for actual mouse resizing, dragging and one explicit save. The latter uses a separate English demo and restores the original full page configuration through a revision-guarded cleanup. These checks are separate from the read-only performance run.

Commands, instance guards, write budgets and revision-aware cleanup are documented in [tests/README.md](../tests/README.md). Performance samples are read-only; deliberate editor-save tests have separate records and run only against disposable demos.

## Historical measurement: compact-admin refinement

The pre-refinement and compact-admin builds were measured earlier on 2026-10-18 with the same instrumentation, dataset and saved page configuration. These are historical results from the preceding iteration, before the composition and preview work above. Each build has 12 cold-context loads: two profiles × two surfaces × three repetitions. The saved navigation panel uses a fixed height with internal scrolling; three favorites are also shown in their own panel, so the homepage mounts 46 bookmark cards for 43 distinct links. No request writes or browser errors occurred. The compact-admin report preserves six decimal places for CLS; the comparison below uses the original raw samples rather than the earlier summary's two-decimal rounding.

### Resource and layout measurements

| Metric | Before refinement | Final refined build |
| --- | ---: | ---: |
| Homepage initial JS/CSS, actual encoded response bodies | 496,789 B | 156,805 B |
| Admin initial JS/CSS, actual encoded response bodies | 581,548 B | 202,542 B |
| Homepage JS/CSS after decompression | 496,789 B | 537,698 B |
| Admin JS/CSS after decompression | 581,548 B | 683,166 B |
| Homepage initial CLS, both profiles | 0.113801 | 0.001898 |
| Admin initial CLS, both profiles | 0 | 0 |
| Admin document height in a 1,440 px viewport | 5,160 px | 1,440 px |
| Mounted admin table rows | 43 | 25 |
| Admin DOM nodes | 1,274 | 868 |
| Homepage DOM nodes | 806 | 821 |

The encoded-body reduction is **68.4% for the homepage** and **65.2% for admin**. These are actual browser resource timings with server-negotiated gzip, not a bundler's compression estimate. Decoded resources grew with the new interface, while compression and deferred loading reduced network transfer. The remaining small initial CLS comes from the footer moving when content height is measured; the large card-width correction is removed. Pagination bounds mounted admin rows while preserving the full authorized collection in browser memory.

### Timing observations

Values below are medians of three repetitions, in milliseconds. Every cell is **before → final**.

| Profile / page | FCP and observed LCP | Readiness observation | Search input to two frames | Pre-interaction long-task blocking |
| --- | ---: | ---: | ---: | ---: |
| Desktop / homepage | 1,608 → 632 | 2,695.7 → 1,790.1 | 24.5 → 37.5 | 4 → 130 |
| Desktop / admin | 1,588 → 632 | 3,276.2 → 2,089.8 | 25.9 → 26.5 | 0 → 0 |
| 4× CPU / homepage | 1,828 → 984 | 3,561.9 → 2,241.7 | 56.8 → 75.1 | 403 → 674 |
| 4× CPU / admin | 1,884 → 964 | 4,208.5 → 3,180.6 | 80.4 → 65.7 | 324 → 309 |

Navigation response times remained around 138–140 ms. The early boot state is a paint candidate, so the FCP/LCP column must not be interpreted as the time at which all bookmarks are usable. Readiness includes the test's network-idle observation, as described above.

**Not every metric improved.** The homepage's observed startup blocking and search-to-frame times increased from the old build even though transfer, readiness and layout stability improved. Measuring width before paint removes visible correction but does not eliminate React, grid and content-measurement work. Restoring a cleared search also remounts the full set of cards. This run does not isolate total CPU time by subsystem; reducing that startup and reconstruction cost remains a performance target. Do not advertise a general search-speed improvement from this 43-link experiment.

The maximum observed interaction duration in the final three-sample summaries was 72 ms for desktop home, 56 ms for desktop admin, 216 ms for throttled home and 208 ms for throttled admin. These limited laboratory Event Timing observations are **not field INP**. Earlier first-iteration HTTP, image and browser counts remain explicitly historical in [tests/README.md](../tests/README.md).

## Interface acceptance

See [tests/README.md](../tests/README.md) for commands and actual results. `tests/browser_refinement.cjs` checks bounded admin scrolling, pagination, real Select and Checkbox interaction, inline constraints, category presentation/disclosure and six responsive sizes. Its mutations require an explicitly identified ownerless demo on port 5182 and `--allow-demo-write`; it preserves original business records and revision-checks cleanup of temporary page configuration.

The source audit covers visible select, checkbox, radio, file, number, text/search and textarea controls. Hidden file inputs and Radix compatibility inputs intentionally retain browser/platform semantics. A styled file-selection button still opens the operating system's file picker. No source scan or screenshot alone establishes complete accessibility compliance.

## Further scale limits

The frontend still receives the complete authorized navigation snapshot. Pagination bounds the admin DOM, but it does not make network payloads independent of collection size. The homepage renders the filtered collection; large-collection virtualization and a server pagination/query contract need separate product decisions and representative browser evidence. Do not extrapolate the 43-link browser run to ten thousand live cards or concurrent-user capacity.

Reverse proxies may provide their own compression and caching; preserve response `Vary` and the distinction between versioned assets and private API data. Revisit bundle and browser measurements when adding a large data-source panel, icon library, theme or editor dependency.

## References

- [MDN: scrollbar-gutter](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/scrollbar-gutter)
- [MDN: scrollbar-width and accessibility](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/scrollbar-width)
- [Radix Select: keyboard and accessibility behavior](https://www.radix-ui.com/primitives/docs/components/select)
- [Tailwind: explicit source detection](https://tailwindcss.com/docs/detecting-classes-in-source-files#disabling-automatic-detection)
- [MDN: Accept-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Accept-Encoding)
- [MDN: Cache-Control](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control)
- [web.dev: Web Vitals and laboratory versus field measurement](https://web.dev/articles/vitals)

## 0.2.4 collaboration query budget

The earlier timing tables remain historical measurements. The new small TestWorkBoardQueryBudget fixture validates SQL counts only: four statuses with four or sixteen items use 18 handler queries; five statuses with seventeen items use 21, for both SQLite/PostgreSQL and both collaboration settings. The current upper bound is 6 + 3 × actual status count, independent of card count. Empty columns or future query consolidation may use fewer reads. A separate 120-card fixture confirms one batched claim/session/user JOIN for a summary batch. This does not remeasure HTTP P95 or the opt-in 100/1,000/10,000 samples.
