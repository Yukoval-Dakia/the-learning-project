# PLAN — 活看板

> Linear 是权威 tracker。2026-10-07 本树 YUK-1365：已实现聊天内容门禁完整删除与真正 Pi prose 增量持久化，本地 scoped checks 通过；已提交，独立审查进行中；未部署。父线程负责独立审查、真实验收、Linear、PR/CI 与发布。见[决定与契约](docs/planning/2026-10-07-yuk1365-copilot-prose-stream.md)及[本地证据](docs/planning/evidence/2026-10-07-yuk1365-local-checks.md)。

## NOW

- **YUK-1365 本树实施完成，待父线程验收**：`fix/yuk-1365-copilot-stream-without-content-gate` 基于 fetched `origin/main a86d4e633`。聊天 keyword detector、独立 learning review/mandatory marker 已删除；Pi partial text 在最终结果未决时进入 durable DELTA，终态只替换正文。取消、回放、重投和多工具/模型回合有真实本地 Pi-loop DB 回归。无 UI 实施或主动出题行为变更。
- **YUK-1103 runtime 交接**：父线程确认 localhost:8787 的 `f3bfff2cf` 已 repurpose 为 agent-development-test、使用本地 SeaweedFS。本树未部署或操作 runtime；后续指针与发布由父线程核对。此前生产发布证据见[发布记录](docs/planning/2026-10-07-session-entry-local-release-result.md)，不能代替本次验收。
- **YUK-1338 / YUK-1351 P0 gate**：Pi 1.0.2 + DBOS 5.2.11，测试容器中完成新证据影响下一项、版本/过期拒绝、四个进程终止边界、响应复用与单次业务效果。2 unit / 10 DB passed；typecheck/lint/build 通过；独立 review 无 P0/P1。PR #1590 / In Review；旧 run lint format 失败已修复，复验后 push，不能用本机通过替代最终 CI；P2 首次并发证据创建与 provider 请求身份要求已记入 YUK-1356；owner 指定不自主合并，当前生产 Hono/Vite/pg-boss 不改。
- **YUK-1341 产品 AI**：PR #1585 已通过 exact-head CI、独立初审和等待窗并合并。app/worker 都固定 `opencode-go/mimo-v2.6-pro`；54聊天任务和 Mem0 接线已落地。生产两轮 Copilot 成功，原会话及 Pi cursor 连续、刷新回放一致；后台 MemoryBrief 也已实际成功。未宣称所有任务质量或评分切片均获准入。
- **YUK-1340 会话入口已交付**：PR #1583 满足 exact-head CI、审查和等待窗后合并。准确 ARM64 镜像完成副本迁移、旧镜像读取兼容、停写备份恢复及生产页面验收。默认续接、历史只读、新建、重开、刷新保持会话均通过；没有发送 AI 消息。YUK-1343 两条 P2 仍延期。
- **行为基线 / YUK-405**：[完整设计](docs/design/2026-10-06-continuous-learning-system-behavior.md)连接学校、纸笔、自习与数字工具，由 agent 在持续委托下负责实现和验证，不是已实现清单。
- **模型范围**：产品生成式/多模态 AI 为 MiMo2.6Pro；开发按 AGENTS 常规选模。专用 embedding、typed Jev 和 OCR 协议保留。现有评分准入与确定性功能不降级。

## NEXT

- YUK-1365：父线程读取实际 diff 独立审查，完成真实 provider/browser streamed prose 与 Stop/reconnect 验收，再处理 Linear/commit/PR/exact-head CI/发布。本地脚本化 provider 证据不升级为真实输出或部署 PASS。
- 并行 owner lane `787449db-4205-41f0-bc22-0997649cdfbf` 独占结构化出题→展示/作答缺口；本树不新增主动调用行为。被删 finalizer/helper 字段及 receipt v2 已报告父线程；出题工具输入输出接口不变。
- YUK-1042：42 failed +42 DLQ 原义务保留；先查每项副作用和幂等身份再恢复，不清队列或重付未知结果。
- **TS 迁移 + UI 重写（epic YUK-1351）2026-10-07 owner 指示开工**：[准备计划](docs/planning/2026-10-07-ts-migration-and-ui-rewrite-prep.md) 按路由合并交付（每条 TanStack 路由同时上线新 UI）。首批：**YUK-1338**（Pi + DBOS 第一道 gate，本机已通过，PR #1590 待审查与 owner 合入；当前不动生产；P0 最终通过后由 57961995 父线程立即衔接 P1/P5，不以 1363/1364 为串行阻塞）与 **YUK-1353**（视觉方向 loft）。UI 票（YUK-1353/1354/1357 及 P6 UI 子票）只交 Claude Opus 5.5；非 UI 开发按 AGENTS 常规选择。ADR 以 main 的 0066 为准。
- **早期单收口（2026-10-07）**：YUK-100..500 的 20 张已在 Linear 逐张裁定——147/213/295/310/406/443/464 转 Todo，369 Canceled（被 1038 取代），其余设触发条件与 10-21 / 11-07 复查截止，到期未触发即取消；406 验收裁定连带 405/418/419。

## PARKED

- YUK-1346：当前基线源码已包含单次派生用途策略；本轮保留策略和历史过滤，未重新执行其真实验收或更新 Linear/发布状态。
- YUK-1343：失败创建提前标为显式来源、50条历史截断隐藏可续接会话均未修；已成组登记，不阻塞此次已裁决发布。

- YUK-1342：付费探针开关、不可覆盖封存及 OpenAI4 node-fetch 绕过 global-fetch 观测。副本记忆功能通过，但整体探针仍 FALSE；SDK wire/count/cost 不完整，不重复付费刷绿。
- YUK-1345：provider-only 校准默认值及旧 vision lane 同源归因，已裁决非阻塞；不把统一模型称为异源证据。
- YUK-1344：Tailscale 本机 HTTPS/鉴权和既有独立 peer 已验证，离家实体设备验证尚缺。
- YUK-1329：通用发布与回退演练仍未完成。旧备份 helper 的 auto-purge 文案/清单不适用当前保留策略；此前 MiMo 发布的 R2 时序补证保留。本次入口发布全部最终备份在停写后，101表计数恢复一致、63附件完整。
- YUK-1235：镜像外部 MCP/sharp 版本与 lock 漂移已有票；本轮无已证实可达 P0/P1，不扩张成依赖整治。
- YUK-1325 / PR #1580：保留 `1be38edbc`、`1af72b427`、`3940d61f9`，正常合入 main `8841ce68a` 为 `e484efa60`；359 scoped tests、21 audits、typecheck/lint/build 与 lint ratchet 通过，无 high/critical 依赖告警。开发 transcript 与产品 MiMo/自主交付指导同时保留。writer 已释放，父线程负责最终 SDK/SQL/browser 回放、push、exact-head CI、review replies、Linear 与发布；P2 typed tracing 留 YUK-1339，不启动第三审。详情见 [Laminar 记录](docs/planning/2026-10-06-yuk1325-laminar.md)。旧完成线程越界写入风险仍由父线程独占 watch 约束，平台跟进待去重登记。

## BLOCKED-ON

- YUK-1365 无实现阻塞；真实验收、独立审查和交付由父线程负责。无新增已证实 actionable follow-up，Linear capture gate 交父线程；本树不进行外部通信。
- 默认会话入口已在生产修复；完整学习状态评估和自适应安排仍需逐条行为验收，不能以此次日用修复冒称产品完成。
- 旧0f81整镜像读取新迁移副本兼容已验证；回退需刷新浏览器且恢复旧入口缺陷。数据库恢复仍须保护备份后新写入，不可自动覆盖。当前指针已更新且发布锁已释放。
- 每小时 T3 任务仍绑定原线程；需要 Mac/T3 运行。远程访问需要同一 tailnet、Mac 开机且用户会话内 daemon 在运行。
