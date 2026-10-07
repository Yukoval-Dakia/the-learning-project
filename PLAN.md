# PLAN — 活看板

> Linear 是权威 tracker。2026-10-08 YUK-1346/1350 正常合入 fetched main 5aa2a9e98（PR1591）。保留 answer_only、provider fence/deadline、1365 streaming/listener 及1364 canonical criterion/execution/V1 compatibility。当前仅 Agent TEST ONLY，automation disabled；完整非 UI 迁移优先，UI 暂缓。本轮592 unit/538 fresh DB/typecheck/lint/build/10 audits通过，旧统计只属历史。父独占 delivery/CI/runtime。

## NOW

- **最新集成**：合入main36f719675的YUK1375相对路径audit修复，allowlist不改；相关audit重新验证。1364已由7631发布为5aa2/build853/image9b76（owner报告）。1376 /mistakes与1359归7631，1352/55/56归主线；不交叉写入。

- **YUK-1346 / YUK-1350 integration**：clean `31098cdbceb320da9b678f07c83ca95dbecf448e` 正常 merge `5aa2a9e989984dfa065b3ba400b67b6b987b12e3`。实际冲突仅 PLAN/now；源码自动合并。可信逐轮 answer_only、raw chat 保留、不派生记忆/模型历史、cold 六 read/no cursor 与 operation-kind fence/deadline/未知结果不重投保持。旧聊天审核 consumer 已退休，P1 superseded，不恢复 gate。[恢复证据](docs/planning/2026-10-07-yuk1346-main-streaming-recovery.md)。本轮25文件592 unit、17文件538 fresh Testcontainers DB及Node24静态/构建通过。
- **YUK-1364**：PR1591 已在 fetched main 合并，canonical criterion、完整 execution contract 与历史 V1/absent compatibility 原样整合。upstream 镜像/HTTP/CI 证据见[原记录](docs/planning/2026-10-07-yuk1364-probe-issuance.md)，本 lane 不复称实时状态；新 integration head 的 CI/runtime 归父。
- **YUK-1365**：保留 PR1593/1594 的真实 Pi DELTA/SSE、Stop/权威终态及 startup/shutdown LISTEN 接线，不接管该 owner 的运行验收。1367 正式练习出版/评分准入另线负责。
- **YUK-1338 / YUK-1351 / YUK-1360**：保留 Pi+DBOS gate、26 production/3 type upgrades、Mem0 patch、Laminar 与 DBOS。依赖/锁与 fetched main 一致；source checks 不替代 BAM、provider 或迁移完成证明。
- **YUK-1359 / YUK-1356**：保留[退出调查](docs/planning/2026-10-07-yuk1359-exit-inventory.md)与[操作迁移输入](docs/planning/2026-10-07-yuk1356-operation-seams.md)，主线负责逐族实施，可信 provenance/diagnostic/coverage 契约保留。本 lane 仅整合，不实施新 feature。
- **YUK-1362 / YUK-1363**：当前用途 Agent TEST ONLY，automation disabled，禁止再次清库或恢复私人数据。完整非 UI 迁移优先、UI 暂缓，见[owner 优先级](docs/planning/2026-10-07-non-ui-migration-priority.md)。本 lane 未读 runtime/锁/private env，不断言 live revision。
- **历史 YUK-1341 产品 AI 发布**：PR #1585 已通过 exact-head CI、独立初审和等待窗并合并。app/worker 都固定 `opencode-go/mimo-v2.6-pro`；54聊天任务和 Mem0 接线已落地。生产两轮 Copilot 成功，原会话及 Pi cursor 连续、刷新回放一致；后台 MemoryBrief 也已实际成功。未宣称所有任务质量或评分切片均获准入。
- **历史 YUK-1340 会话入口发布**：PR #1583 满足 exact-head CI、审查和等待窗后合并。准确 ARM64 镜像完成副本迁移、旧镜像读取兼容、停写备份恢复及生产页面验收。默认续接、历史只读、新建、重开、刷新保持会话均通过；没有发送 AI 消息。YUK-1343 两条 P2 仍延期。
- **行为基线 / YUK-405**：[完整设计](docs/design/2026-10-06-continuous-learning-system-behavior.md)连接学校、纸笔、自习与数字工具，由 agent 在持续委托下负责实现和验证，不是已实现清单。
- **模型范围**：产品生成式/多模态 AI 为 MiMo2.6Pro；开发按 AGENTS 常规选模。专用 embedding、typed Jev 和 OCR 协议保留。现有评分准入与确定性功能不降级。

## NEXT

- 父线程接回 clean recovery tree，核验最终 artifact，处理 PR1588 P1 supersession 回复/resolve、push 后新 exact-head CI 和必要等待窗，按最新 owner 决定组织 runtime/provider/browser 验收。审查预算已用尽，不开新轮。本 lane 不 push/watch/merge PR，不读 existing/private DB，不接触 other-owner runtime 锁。
- 旧 R/R2/R3/R4/A/ingest、超时整理请求与 failed/DLQ 保留，不 replay 或新付费。全局 brief、原 key 幂等、最终数据保护及 release/restore 证据仍归父。YUK-1367 正式练习出版/评分准入与链接工作、PR1594 Hono LISTEN 跟进继续由其他 owner 负责。
- YUK-1042历史42failed+42DLQ已随owner明确授权的reset退出主runtime并离线保留；不自动restore/replay，清库不代表原缺陷或未知结果已修。
- **TS 迁移 + UI 重写（epic YUK-1351）**：[准备计划](docs/planning/2026-10-07-ts-migration-and-ui-rewrite-prep.md) 保留历史路由合并交付方向；owner 当前要求完整非 UI 迁移优先，UI 暂缓。**YUK-1338** Pi+DBOS gate 已在 main，1352/1355/1356 由父协调各自独立 lane。UI 票（YUK-1353/1354/1357 及 P6 UI 子票）只交 Claude Opus 5.5；非 UI 开发按 AGENTS 常规选择。ADR 以 main 的 0066 为准。
- **早期单收口（2026-10-07）**：YUK-100..500 的 20 张已在 Linear 逐张裁定——147/213/295/310/406/443/464 转 Todo，369 Canceled（被 1038 取代），其余设触发条件与 10-21 / 11-07 复查截止，到期未触发即取消；406 验收裁定连带 405/418/419。

## PARKED

- **YUK-1375**：继承 schema audit 对绝对路径 test/spec 过滤的已知限制。原 test-storage 树失败不冒称 PASS，不改 allowlist 或隐藏失败；本树新命令结果单独封存。原记录见1364证据，工具修复归父/既有 tracker。YUK-1374 列表窗口 P2 仍独立未修。

- **YUK-1360 父线程发布验收义务**：真实 startup 返回 schema44 时仍有7项 BAM index 工作 pending；不能把 start/health/Drizzle smoke 当作 background migration 完成。YUK-1360 历史 lane 的 disposable/index validity 证据只归原 revision，本轮未复验 BAM；运行验收需父线程核验。旧12.26.3默认启动仅证明单个 synthetic queue 操作，`migrate:false`拒绝44；没有执行或批准 queue downgrade。归入既有 YUK-1360/YUK-1329 验收，不在此 lane 新建 Linear。
- YUK-1347 的 marker-free detector 缺口属于已退休聊天 gate，后续 tracker 裁定交父线程。本树不恢复 detector。YUK-1348 回复错误否认记忆能力、YUK-1349 LaTeX 显示问题仍未在本 lane 修复。
- YUK-1343：失败创建提前标为显式来源、50条历史截断隐藏可续接会话均未修；已成组登记，不阻塞此次已裁决发布。

- YUK-1342：付费探针开关、不可覆盖封存及 OpenAI4 node-fetch 绕过 global-fetch 观测。副本记忆功能通过，但整体探针仍 FALSE；SDK wire/count/cost 不完整，不重复付费刷绿。
- YUK-1345：provider-only 校准默认值及旧 vision lane 同源归因，已裁决非阻塞；不把统一模型称为异源证据。
- YUK-1344：Tailscale 本机 HTTPS/鉴权和既有独立 peer 已验证，离家实体设备验证尚缺。
- YUK-1329：通用发布与回退演练仍未完成。旧备份 helper 的 auto-purge 文案/清单不适用当前保留策略；此前 MiMo 发布的 R2 时序补证保留。本次入口发布全部最终备份在停写后，101表计数恢复一致、63附件完整。
- YUK-1235：镜像外部 MCP/sharp 版本与 lock 漂移已有票；本轮无已证实可达 P0/P1，不扩张成依赖整治。
- YUK-1325 / PR #1580：保留 `1be38edbc`、`1af72b427`、`3940d61f9`，正常合入 main `8841ce68a` 为 `e484efa60`；359 scoped tests、21 audits、typecheck/lint/build 与 lint ratchet 通过，无 high/critical 依赖告警。开发 transcript 与产品 MiMo/自主交付指导同时保留。writer 已释放，父线程负责最终 SDK/SQL/browser 回放、push、exact-head CI、review replies、Linear 与发布；P2 typed tracing 留 YUK-1339，不启动第三审。详情见 [Laminar 记录](docs/planning/2026-10-06-yuk1325-laminar.md)。旧完成线程越界写入风险仍由父线程独占 watch 约束，平台跟进待去重登记。 最新 main 的前缀 credential P1 修复及73tests记录一并保留；PR父线程仍负责后续验收，此lane无新review。

## BLOCKED-ON

- 本 lane 完成本轮84 parent source comparisons、3147文件manifest、592 unit/538 disposable DB与typecheck/lint/build/10audits。初始TMPDIR过长导致tsx IPC失败已保留并在本树短路径复验通过。新 exact-head CI、真实 provider/browser/host-restart、live revision 与旧 timeout 结果/费用未验证；父继续 delivery/runtime，不以本地绿升格发布 PASS。任务报告 PR1593 已由另一 owner 发布，只作为报告来源，未复验。

- YUK-1360新source checks不构成最终head CI/review或runtime acceptance。无新增actionable follow-up；四个peer warnings继承两parent，runtime/BAM/rollback限制仍属1360/1329。Linear capture归父线程。主runtime仅Agent TEST ONLY；切日用需owner后续明确要求。
- 无需 owner 追加日常授权。旧 Xiaomi402 不再阻塞新 Copilot；历史失败没有删除。
- 默认会话入口已在生产修复；完整学习状态评估和自适应安排仍需逐条行为验收，不能以此次日用修复冒称产品完成。
- 旧0f81整镜像读取新迁移副本兼容已验证；回退需刷新浏览器且恢复旧入口缺陷。数据库恢复仍须保护备份后新写入，不可自动覆盖。历史发布指针与锁记录不表示当前runtime状态。
- automation disabled，本 lane 未查询或恢复定时任务。远程访问需要同一 tailnet、Mac 开机且用户会话内 daemon 在运行。
