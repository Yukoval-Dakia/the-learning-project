# PLAN — 活看板

> Linear 是权威 tracker。2026-10-07：P0 PR #1590 已合入 main `42987dfd7`；YUK-1352 PR #1592 正常 merge 此 main，保留 Start 前门及原 gate 证据。初审 NONE P0/P1，旧 head checks 已通过，新 head exact CI 待父线程 push 后核验。全非 UI 迁移优先，UI 暂缓；runtime Agent TEST ONLY，automation disabled，不供个人日用。见[1352交付](docs/planning/2026-10-07-yuk1352-start-frontdoor.md)。

## NOW

- **PR1592 main/dependency integration**：合入26f101581，修Start传递依赖js-yaml/source-map-js高危告警，51scoped/typecheck/lint/build和最终audit/frozen通过；新head CI待push。原运行验收仍待完成，无部署。

- **YUK-1352 非 UI 前门 / PR #1592**：Start 1.168.60 / Router 1.170.41 与原 Hono/SPA 回落源码保留；旧 head `5deb26cca` 的 scoped/static/build、隔离传输与页面证据保留，初次独立 review NONE P0/P1。正常 merge main `42987dfd7` 后的新 head CI 尚未运行，父线程负责 push、exact CI 及隔离业务/image drill；不置 Done。Hono/SPA 是过渡方案，P7/YUK-1359 负责退出。1355/1356/1364/PR1591 ownership 未触及。

- **YUK-1338 / YUK-1351 P0 gate**：PR #1590 已 squash 合入 main `42987dfd7d456ca187e716509d11ea100e7353b9`。该 main tree 与原 `a6d89037b` tree 相同；Pi 1.0.2 / DBOS 5.2.11 的源码及版本化证据完整保留。原 2 unit / 10 DB、静态/build、独立 review NONE P0/P1 属于 P0 原 revision，不代替 PR #1592 新 head CI。P2 首次并发证据创建与 provider 请求身份要求已归 YUK-1356。此合入未发布 runtime。
- **YUK-1103 runtime 边界**：当前 Agent TEST ONLY，automation disabled，不供个人日用。历史 app/worker `f3bfff2cf`、备份/恢复及访问地址是先前发布记录，本轮未重新核验或操作。禁止据此启动服务、恢复库、部署或重发旧镜像。
- **YUK-1341 产品 AI**：PR #1585 已通过 exact-head CI、独立初审和等待窗并合并。app/worker 都固定 `opencode-go/mimo-v2.6-pro`；54聊天任务和 Mem0 接线已落地。生产两轮 Copilot 成功，原会话及 Pi cursor 连续、刷新回放一致；后台 MemoryBrief 也已实际成功。未宣称所有任务质量或评分切片均获准入。
- **YUK-1340 会话入口已交付**：PR #1583 满足 exact-head CI、审查和等待窗后合并。准确 ARM64 镜像完成副本迁移、旧镜像读取兼容、停写备份恢复及生产页面验收。默认续接、历史只读、新建、重开、刷新保持会话均通过；没有发送 AI 消息。YUK-1343 两条 P2 仍延期。
- **行为基线 / YUK-405**：[完整设计](docs/design/2026-10-06-continuous-learning-system-behavior.md)连接学校、纸笔、自习与数字工具，由 agent 在持续委托下负责实现和验证，不是已实现清单。
- **模型范围**：产品生成式/多模态 AI 为 MiMo2.6Pro；开发按 AGENTS 常规选模。专用 embedding、typed Jev 和 OCR 协议保留。现有评分准入与确定性功能不降级。

## NEXT

- **TS 非 UI 迁移（epic YUK-1351）owner 最新覆盖**：先完成整个非 UI 迁移，UI 重写暂缓，保留现有页面及确定性行为。父线程协调 1352 前门、1355 任务迁移和 1356 共享业务操作；P0 PR1590 已合入，不以 UI 或独占 1364/PR1591 为串行阻塞。Hono/SPA 为过渡形态，P7/YUK-1359 负责退出，不宣称最终架构；数据库唯一真相源、三入口共用业务操作、每类任务唯一恢复 owner。runtime Agent TEST ONLY，automation disabled，不供个人日用。
- 当前优先整个非 UI 迁移；YUK-1346 的可信单次记忆/派生用途策略与真实学习路径继续保留为后续产品义务。短回答成功不等于可靠评估已经兑现。
- YUK-1042：42 failed +42 DLQ 原义务保留；先查每项副作用和幂等身份再恢复，不清队列或重付未知结果。
- **早期单收口（2026-10-07）**：YUK-100..500 的 20 张已在 Linear 逐张裁定——147/213/295/310/406/443/464 转 Todo，369 Canceled（被 1038 取代），其余设触发条件与 10-21 / 11-07 复查截止，到期未触发即取消；406 验收裁定连带 405/418/419。

## PARKED

- YUK-1346：单次“不写入记忆”的可信策略尚未实现，High/Backlog，选为下一条产品线；两条原假设验收摘要保留，不冒称已修。
- YUK-1343：失败创建提前标为显式来源、50条历史截断隐藏可续接会话均未修；已成组登记，不阻塞此次已裁决发布。

- YUK-1342：付费探针开关、不可覆盖封存及 OpenAI4 node-fetch 绕过 global-fetch 观测。副本记忆功能通过，但整体探针仍 FALSE；SDK wire/count/cost 不完整，不重复付费刷绿。
- YUK-1345：provider-only 校准默认值及旧 vision lane 同源归因，已裁决非阻塞；不把统一模型称为异源证据。
- YUK-1344：Tailscale 本机 HTTPS/鉴权和既有独立 peer 已验证，离家实体设备验证尚缺。
- YUK-1329：通用发布与回退演练仍未完成。旧备份 helper 的 auto-purge 文案/清单不适用当前保留策略；此前 MiMo 发布的 R2 时序补证保留。本次入口发布全部最终备份在停写后，101表计数恢复一致、63附件完整。
- YUK-1235：镜像外部 MCP/sharp 版本与 lock 漂移已有票；本轮无已证实可达 P0/P1，不扩张成依赖整治。
- YUK-1325 / PR #1580：保留 `1be38edbc`、`1af72b427`、`3940d61f9`，正常合入 main `8841ce68a` 为 `e484efa60`；359 scoped tests、21 audits、typecheck/lint/build 与 lint ratchet 通过，无 high/critical 依赖告警。开发 transcript 与产品 MiMo/自主交付指导同时保留。writer 已释放，父线程负责最终 SDK/SQL/browser 回放、push、exact-head CI、review replies、Linear 与发布；P2 typed tracing 留 YUK-1339，不启动第三审。详情见 [Laminar 记录](docs/planning/2026-10-06-yuk1325-laminar.md)。旧完成线程越界写入风险仍由父线程独占 watch 约束，平台跟进待去重登记。

## BLOCKED-ON

- 无需 owner 追加日常授权。旧 Xiaomi402 不再阻塞新 Copilot；历史失败没有删除。
- 默认会话入口已在生产修复；完整学习状态评估和自适应安排仍需逐条行为验收，不能以此次日用修复冒称产品完成。
- 旧0f81整镜像读取新迁移副本兼容已验证；回退需刷新浏览器且恢复旧入口缺陷。数据库恢复仍须保护备份后新写入，不可自动覆盖。当前指针已更新且发布锁已释放。
- 当前 automation disabled；每小时任务绑定原线程的说法仅属历史记录，不得据此启用自动化或个人日用。
