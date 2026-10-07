# PLAN — 活看板

> Linear 是权威 tracker。2026-10-07 本轮正常 merge origin/main 42987dfd7；代码无冲突，交接文档合并两侧状态。保留 answer-only fail-closed、YUK-1350 start fence、Laminar 和 main Pi + DBOS TESTONLY gate。本轮57 unit/16 fresh DB及typecheck/lint/build/partition通过；旧实际验收不覆盖新 merge。本轮不 push、不启动 runtime 或付费调用，提交后子任务释放写权。

## NOW

- **YUK-1346 / YUK-1350 In Progress**：当前集成树 `tlp-yuk1346-reconcile-safety`，父唯一 writer，PR1588。真实 R4 椭圆答案通过全文判决，受限轮不派生记忆、后续 A 输入排除 R；普通 A 提取成功。整理请求真实超时，结果/费用未知不重投。324381a3b 复用现有 start fence，覆盖响应体超时并服从剩余 deadline；作者62 unit/80 DB/typecheck/lint/build通过，父独立42 unit/6真实DB复验通过。详见[验收与修复记录](docs/planning/2026-10-07-yuk1346-acceptance-and-reconcile-safety.md)。
- **YUK-1338 / YUK-1351 P0 gate**：main `42987dfd7` 已包含 PR #1590 的隔离 Pi + DBOS gate。main 封存的 2 unit / 10 DB、typecheck/lint/build 及独立 review 证据仍归属原 revision；本树集成检查另记，不称生产迁移或真实 provider 验收。首次并发创建及 provider 请求身份要求仍归 YUK-1356。
- **YUK-1103 自主交付**：本机 http://localhost:8787；远程 https://loom-mac-mini.tail2ee344.ts.net/（同一 tailnet，沿用 Loom 令牌）。此前发布记录为 app/worker `f3bfff2cf` healthy、115项迁移、readiness active，本轮未复验 runtime。此前已备份及恢复验证；不要重复发布旧 `5d738dbc0`。
- **YUK-1341 产品 AI**：PR #1585 已通过 exact-head CI、独立初审和等待窗并合并。app/worker 都固定 `opencode-go/mimo-v2.6-pro`；54聊天任务和 Mem0 接线已落地。生产两轮 Copilot 成功，原会话及 Pi cursor 连续、刷新回放一致；后台 MemoryBrief 也已实际成功。未宣称所有任务质量或评分切片均获准入。
- **YUK-1340 会话入口已交付**：PR #1583 满足 exact-head CI、审查和等待窗后合并。准确 ARM64 镜像完成副本迁移、旧镜像读取兼容、停写备份恢复及生产页面验收。默认续接、历史只读、新建、重开、刷新保持会话均通过；没有发送 AI 消息。YUK-1343 两条 P2 仍延期。
- **行为基线 / YUK-405**：[完整设计](docs/design/2026-10-06-continuous-learning-system-behavior.md)连接学校、纸笔、自习与数字工具，由 agent 在持续委托下负责实现和验证，不是已实现清单。
- **模型范围**：产品生成式/多模态 AI 为 MiMo2.6Pro；开发按 AGENTS 常规选模。专用 embedding、typed Jev 和 OCR 协议保留。现有评分准入与确定性功能不降级。

## NEXT

- 父线程接回本树后整合安全修复及最新记录，再推 PR1588，等待新 exact-head CI 与17分钟窗；不启第三轮审查。完成剩余整理/全局摘要、原key幂等、重投及最终数据保护验收后，再做新镜像、停写备份/恢复验证和发布。旧 R/R2/R3、成功 R4/A/提取及未知整理请求均不重发。
- YUK-1042：42 failed +42 DLQ 原义务保留；先查每项副作用和幂等身份再恢复，不清队列或重付未知结果。
- **TS 迁移 + UI 重写（epic YUK-1351）**：Owner 完整非 UI 迁移优先，UI 暂缓。主 runtime agent 为 TESTONLY，旧 automation disabled；Pi + DBOS gate 不授权启动主 runtime。YUK-1352/1355/1356 在各自其他 worktree 实施，本树不触及。ADR 以 main 的 0066 为准，具体迁移由父线程协调。
- **早期单收口（2026-10-07）**：YUK-100..500 的 20 张已在 Linear 逐张裁定——147/213/295/310/406/443/464 转 Todo，369 Canceled（被 1038 取代），其余设触发条件与 10-21 / 11-07 复查截止，到期未触发即取消；406 验收裁定连带 405/418/419。

## PARKED

- YUK-1348：普通回复误称没有异步记忆写入通道；YUK-1349：Copilot 显示原始 LaTeX。已登记、未修，不将本次后台修复称为解决这两项。

- **YUK-1347 Backlog**（父已去重登记）：marker-free现有题检测缺口仍可免费重现。精确R2仅剥除标记后的SHA `8b6ba9ab93a56b4f028e53fff863e5588facc1b640cf3bf5aad925ceba3a2529` 被既有detector判为无需校验并直接通过，0次validator；证据 `/tmp/yuk1346-visible-answer-repair/results.json`。本次不扩regex、不删marker或弱化准入；需另行明确权威题目上下文/标记缺失契约。
- YUK-1343：失败创建提前标为显式来源、50条历史截断隐藏可续接会话均未修；已成组登记，不阻塞此次已裁决发布。

- YUK-1342：付费探针开关、不可覆盖封存及 OpenAI4 node-fetch 绕过 global-fetch 观测。副本记忆功能通过，但整体探针仍 FALSE；SDK wire/count/cost 不完整，不重复付费刷绿。
- YUK-1345：provider-only 校准默认值及旧 vision lane 同源归因，已裁决非阻塞；不把统一模型称为异源证据。
- YUK-1344：Tailscale 本机 HTTPS/鉴权和既有独立 peer 已验证，离家实体设备验证尚缺。
- YUK-1329：通用发布与回退演练仍未完成。旧备份 helper 的 auto-purge 文案/清单不适用当前保留策略；此前 MiMo 发布的 R2 时序补证保留。本次入口发布全部最终备份在停写后，101表计数恢复一致、63附件完整。
- YUK-1235：镜像外部 MCP/sharp 版本与 lock 漂移已有票；本轮无已证实可达 P0/P1，不扩张成依赖整治。
- YUK-1325 / PR #1580：保留 `1be38edbc`、`1af72b427`、`3940d61f9`，正常合入 main `8841ce68a` 为 `e484efa60`；359 scoped tests、21 audits、typecheck/lint/build 与 lint ratchet 通过，无 high/critical 依赖告警。开发 transcript 与产品 MiMo/自主交付指导同时保留。writer 已释放，父线程负责最终 SDK/SQL/browser 回放、push、exact-head CI、review replies、Linear 与发布；P2 typed tracing 留 YUK-1339，不启动第三审。详情见 [Laminar 记录](docs/planning/2026-10-06-yuk1325-laminar.md)。旧完成线程越界写入风险仍由父线程独占 watch 约束，平台跟进待去重登记。

## BLOCKED-ON

- 365871dab 的 CI 与候选 HTTP 原key幂等、只读页面验收已通过；合入 main 后需新 exact-head CI/运行验收。先前真实超时没有判决行，global brief/幂等/最终保护检查未完成；旧验收脚本未ACK导致的 ingest failed/DLQ 保留。CI绿色不替代这些证据。
- 无需 owner 追加日常授权。旧 Xiaomi402 不再阻塞新 Copilot；历史失败没有删除。
- 默认会话入口已在生产修复；完整学习状态评估和自适应安排仍需逐条行为验收，不能以此次日用修复冒称产品完成。
- 旧0f81整镜像读取新迁移副本兼容已验证；回退需刷新浏览器且恢复旧入口缺陷。数据库恢复仍须保护备份后新写入，不可自动覆盖。当前指针已更新且发布锁已释放。
- 旧 automation disabled；本轮不恢复定时任务。远程访问需要同一 tailnet、Mac 开机且用户会话内 daemon 在运行。
