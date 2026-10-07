# PLAN — 活看板

> Linear 是权威 tracker。2026-10-07 YUK-1346/1350 恢复 cancelled 实施，正常合入 main df08399ff 后，再合入 main6e54da8df 的已落地PR1594 listener接线。按 YUK-1365 owner 决定删除旧聊天审核残留，保留 answer-only、provider fence、真实 streaming、26 项依赖升级与确定性评分准入。451 unit/188 fresh DB/typecheck/lint/build/10 audits 通过。本 lane 仅本地提交后交还写权，父独占 PR1588/CI/runtime。

## NOW

- **YUK-1346 / YUK-1350**：本 lane 从 clean c59bb7dad 经6cce7fe40正常 merge main df08399ff，再正常合入 main6e54da8df 已落地listener follow-up；旧 P1 discussion4207279165 的聊天审核 consumer 已被 YUK-1365 明确退休，按 source evidence 记 superseded，不冒称新路径修复或事实审核。answer-only 可信逐轮接纳、不派生记忆/模型历史、cold/no cursor 与未知结果不重投保留。最终 451 unit/188 fresh Testcontainers DB、typecheck/lint/build/10 audits 通过；[恢复与证据](docs/planning/2026-10-07-yuk1346-main-streaming-recovery.md)。父负责最终 PR 回复与 CI/runtime 验收。
- **YUK-1365**：main df08399ff 已含 PR1593 的真实 Pi DELTA/SSE、取消/权威终态替换及聊天审核/强制 marker 删除。任务 brief 报告另一 owner 已部署，本 lane 没有读取 runtime 或锁，不宣称 live revision。正式工具、物化和评分准入保留；PR1594 的 owner 实施已在 main6e54da8df 落地，按最新main正常合入，不接管该owner的runtime验收。
- **YUK-1338 / YUK-1351 / YUK-1360 main source**：保留 PR1590 Pi+DBOS gate、26f101581 的26 production/3 type upgrades、Mem0 858dc patch、Laminar0.8.49 和 DBOS5.2.11。依赖/锁与 main 逐字节一致，本 lane 新源码检查不替代旧 gate/provider/BAM 的运行验收。Owner 完整非 UI 迁移优先、UI 暂缓；1352/1355/1356 继续各自隔离实施。
- **历史 YUK-1103 发布记录（已被 Agent TEST ONLY reset 覆盖用途）**：本机 http://localhost:8787；远程 https://loom-mac-mini.tail2ee344.ts.net/（同一 tailnet，沿用 Loom 令牌）。app/worker `f3bfff2cf` healthy，115项迁移、readiness active。已备份及恢复验证；不要重复发布旧 `5d738dbc0`。
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

- 本 lane 完成本地 source/scoped 验证。新 exact-head CI、真实 provider/browser/host-restart、live revision 与旧 timeout 结果/费用未验证；父继续 delivery/runtime，不以本地绿升格发布 PASS。任务报告 PR1593 已由另一 owner 发布，只作为报告来源，未复验。

- YUK-1360新source checks不构成最终head CI/review或runtime acceptance。无新增actionable follow-up；四个peer warnings继承两parent，runtime/BAM/rollback限制仍属1360/1329。Linear capture归父线程。主runtime仅Agent TEST ONLY；切日用需owner后续明确要求。
- 无需 owner 追加日常授权。旧 Xiaomi402 不再阻塞新 Copilot；历史失败没有删除。
- 默认会话入口已在生产修复；完整学习状态评估和自适应安排仍需逐条行为验收，不能以此次日用修复冒称产品完成。
- 旧0f81整镜像读取新迁移副本兼容已验证；回退需刷新浏览器且恢复旧入口缺陷。数据库恢复仍须保护备份后新写入，不可自动覆盖。历史发布指针与锁记录不表示当前runtime状态。
- 旧 automation disabled，本 lane 不恢复定时任务。远程访问需要同一 tailnet、Mac 开机且用户会话内 daemon 在运行。
