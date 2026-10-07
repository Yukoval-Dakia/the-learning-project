# PLAN — 活看板

> Linear 是权威 tracker。2026-10-07：YUK-1362 已按 owner 指令清空并重部署本机业务库，当前仅供 Agent 开发测试；日用切换等待 owner 明确要求。见[重置记录](docs/planning/2026-10-07-agent-test-environment-reset.md)。

## NOW

- **YUK-1362 / 当前部署用途**：http://localhost:8787 仅供 Agent 开发测试。固定 `f3bfff2cf` 镜像，旧库备份后重新建库，115 项迁移、readiness active、app/worker healthy；新空库仅有系统初始化数据。未部署未验收的 PR1584/1588。未来日用部署必须由 owner 明确要求。
- **YUK-1341 产品 AI**：PR #1585 已通过 exact-head CI、独立初审和等待窗并合并。app/worker 都固定 `opencode-go/mimo-v2.6-pro`；54聊天任务和 Mem0 接线已落地。生产两轮 Copilot 成功，原会话及 Pi cursor 连续、刷新回放一致；后台 MemoryBrief 也已实际成功。未宣称所有任务质量或评分切片均获准入。
- **YUK-1340 会话入口已交付**：PR #1583 满足 exact-head CI、审查和等待窗后合并。准确 ARM64 镜像完成副本迁移、旧镜像读取兼容、停写备份恢复及生产页面验收。默认续接、历史只读、新建、重开、刷新保持会话均通过；没有发送 AI 消息。YUK-1343 两条 P2 仍延期。
- **行为基线 / YUK-405**：[完整设计](docs/design/2026-10-06-continuous-learning-system-behavior.md)连接学校、纸笔、自习与数字工具，由 agent 在持续委托下负责实现和验证，不是已实现清单。
- **模型范围**：产品生成式/多模态 AI 为 MiMo2.6Pro；开发按 AGENTS 常规选模。专用 embedding、typed Jev 和 OCR 协议保留。现有评分准入与确定性功能不降级。

## NEXT

- 先落实 YUK-1346 的可信单次记忆/派生用途策略，再沿“椭圆难题 → 记录过程与帮助程度 → 区分暂时理解和独立迁移 → 后续验证安排”的真实学习路径推进。短回答成功不等于可靠评估已经兑现。
- YUK-1042：原队列已随 owner 明确授权的 YUK-1362 清库退出运行环境，完整历史保存在离线备份；不得自动重放或把删除历史当作修复重试安全缺陷。
- **TS 迁移 + UI 重写（epic YUK-1351）2026-10-07 owner 指示开工**：[准备计划](docs/planning/2026-10-07-ts-migration-and-ui-rewrite-prep.md) 按路由合并交付（每条 TanStack 路由同时上线新 UI）。首批并行：**YUK-1338**（Pi + DBOS 状态版本/过期拒绝/重启恢复竖切，第一道 gate，不过 gate 不动生产）与 **YUK-1353**（视觉方向 loft）。UI 票（YUK-1353/1354/1357 及 P6 UI 子票）只交 Claude Opus 5.5；非 UI 开发按 AGENTS 常规选择。ADR 以 main 的 0066 为准。
- **早期单收口（2026-10-07）**：YUK-100..500 的 20 张已在 Linear 逐张裁定——147/213/295/310/406/443/464 转 Todo，369 Canceled（被 1038 取代），其余设触发条件与 10-21 / 11-07 复查截止，到期未触发即取消；406 验收裁定连带 405/418/419。

## PARKED

- YUK-1363：配置独立测试附件存储；当前 app/worker 已移除私人 R2 凭据，附件上传不可用。YUK-1364：旧 canary 判题问题仍需修复 TeachingBrief 的正式发题准入过滤，清库不等于修复代码。

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
- 每小时 T3 任务仍绑定原线程；需要 Mac/T3 运行。远程访问需要同一 tailnet、Mac 开机且用户会话内 daemon 在运行。
