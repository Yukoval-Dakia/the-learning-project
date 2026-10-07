# PLAN — 活看板

> Linear 是权威 tracker。2026-10-07：YUK-1346/PR1588 首个真实受限 R 执行成功，费用 $0.0019227，公开回复被 learning_content 拦截且原因未知。保护摘要未变，R 真实 restricted-ingest handler 已通过，A 未发送，发布待完成。本轮从 clean f5709896dd 仅修复受限 prompt 缺少共享验证协议的已确认源码缺口，120 scoped unit/typecheck/lint/build 与4项相关静态审计通过。

## NOW

- **YUK-1346 In Progress**：隔离树 `tlp-yuk-1346-turn-retention`，分支 `feat/yuk-1346-turn-retention` / PR1588。本轮只将共享 Copilot SKILL.md 的验证-manifest 协议注入 answer_only prompt；完整 skill/写入/提案/子研究/Exa 仍禁用，普通模式和六读工具不变，不改 detector。真实 R 原候选仅存 hash、不可取得，不能认定拦截根因。父线程确认保护业务表/旧事件/vector/reconcile/保留队列内容摘要未变，R ask/reply 的真实 restricted-ingest provider_delta=0、queue_delta=0、memory_count=0。A 尚未发送；源码检查和实际验收分开记，详情见[方案与本地交接](docs/planning/2026-10-07-yuk1346-answer-only-turn.md)。不标 Done。
- **YUK-1103 自主交付**：本机 http://localhost:8787；远程 https://loom-mac-mini.tail2ee344.ts.net/（同一 tailnet，沿用 Loom 令牌）。app/worker `f3bfff2cf` healthy，115项迁移、readiness active。已备份及恢复验证；不要重复发布旧 `5d738dbc0`。
- **YUK-1341 产品 AI**：PR #1585 已通过 exact-head CI、独立初审和等待窗并合并。app/worker 都固定 `opencode-go/mimo-v2.6-pro`；54聊天任务和 Mem0 接线已落地。生产两轮 Copilot 成功，原会话及 Pi cursor 连续、刷新回放一致；后台 MemoryBrief 也已实际成功。未宣称所有任务质量或评分切片均获准入。
- **YUK-1340 会话入口已交付**：PR #1583 满足 exact-head CI、审查和等待窗后合并。准确 ARM64 镜像完成副本迁移、旧镜像读取兼容、停写备份恢复及生产页面验收。默认续接、历史只读、新建、重开、刷新保持会话均通过；没有发送 AI 消息。YUK-1343 两条 P2 仍延期。
- **行为基线 / YUK-405**：[完整设计](docs/design/2026-10-06-continuous-learning-system-behavior.md)连接学校、纸笔、自习与数字工具，由 agent 在持续委托下负责实现和验证，不是已实现清单。
- **模型范围**：产品生成式/多模态 AI 为 MiMo2.6Pro；开发按 AGENTS 常规选模。专用 embedding、typed Jev 和 OCR 协议保留。现有评分准入与确定性功能不降级。

## NEXT

- 父线程检查并整合 YUK-1346 最小验证协议修复 commit，负责 push/PR/Linear、新 exact-head CI 和剩余实际隔离验收；初审+唯一验证审查预算已用完，不启动第三轮。R 不重付/不重发，A 仍未发送，由父线程决定预算内后续验收。发布仍待完成；跨版本须停全部写入者，新 worker 先于 app 恢复写入，受限数据写入后禁止旧 f3 回退。
- YUK-1042：42 failed +42 DLQ 原义务保留；先查每项副作用和幂等身份再恢复，不清队列或重付未知结果。
- YUK-1338 目标架构集成保持 Backlog，单独证明状态版本、过期结果拒绝与重启恢复；ADR-0066 的 TanStack Start/Pi/PostgreSQL/DBOS 方向尚非当前运行形态。

## PARKED

- YUK-1343：失败创建提前标为显式来源、50条历史截断隐藏可续接会话均未修；已成组登记，不阻塞此次已裁决发布。

- YUK-1342：付费探针开关、不可覆盖封存及 OpenAI4 node-fetch 绕过 global-fetch 观测。副本记忆功能通过，但整体探针仍 FALSE；SDK wire/count/cost 不完整，不重复付费刷绿。
- YUK-1345：provider-only 校准默认值及旧 vision lane 同源归因，已裁决非阻塞；不把统一模型称为异源证据。
- YUK-1344：Tailscale 本机 HTTPS/鉴权和既有独立 peer 已验证，离家实体设备验证尚缺。
- YUK-1329：通用发布与回退演练仍未完成。旧备份 helper 的 auto-purge 文案/清单不适用当前保留策略；此前 MiMo 发布的 R2 时序补证保留。本次入口发布全部最终备份在停写后，101表计数恢复一致、63附件完整。
- YUK-1235：镜像外部 MCP/sharp 版本与 lock 漂移已有票；本轮无已证实可达 P0/P1，不扩张成依赖整治。
- 其他线程 YUK-1325 / PR #1580 独立推进；不接管其工作树或批量标 Done。旧完成线程被 PR 通知唤醒后越界写入的风险继续由父线程独占 watch 约束，平台跟进仍待去重登记。

## BLOCKED-ON

- 无需 owner 追加日常授权。旧 Xiaomi402 不再阻塞新 Copilot；历史失败没有删除。
- 默认会话入口已在生产修复；完整学习状态评估和自适应安排仍需逐条行为验收，不能以此次日用修复冒称产品完成。
- 旧0f81整镜像读取新迁移副本兼容已验证；回退需刷新浏览器且恢复旧入口缺陷。数据库恢复仍须保护备份后新写入，不可自动覆盖。当前指针已更新且发布锁已释放。
- 每小时 T3 任务仍绑定原线程；需要 Mac/T3 运行。远程访问需要同一 tailnet、Mac 开机且用户会话内 daemon 在运行。
