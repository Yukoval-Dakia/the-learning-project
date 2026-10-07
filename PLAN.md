# PLAN — 活看板

> Linear 是权威 tracker。2026-10-07：产品 AI 已部署为 main `0f81e198f`；发布证据 PR1586 已合并为 `d501ea163`，无需重发相同运行源码。当前活动线为 YUK-1340 会话入口父线程验收。见[本机 MiMo 发布记录](docs/planning/2026-10-07-mimo-local-release-result.md)。

## NOW

- **YUK-1103 自主交付**：本机 http://localhost:8787；远程 https://loom-mac-mini.tail2ee344.ts.net/（同一 tailnet，沿用 Loom 令牌）。app/worker `0f81e198f` healthy，115项迁移、readiness active。已备份及恢复验证；不要重复发布旧 `5d738dbc0`。
- **YUK-1341 产品 AI**：PR #1585 已通过 exact-head CI、独立初审和等待窗并合并。app/worker 都固定 `opencode-go/mimo-v2.6-pro`；54聊天任务和 Mem0 接线已落地。生产两轮 Copilot 成功，原会话及 Pi cursor 连续、刷新回放一致；后台 MemoryBrief 也已实际成功。未宣称所有任务质量或评分切片均获准入。
- **YUK-1340 会话入口 / PR #1583**：writer 已交回 `94c0f0934`，修复 `ac9ab2ad1` 每次打开重新取得会话和服务端时间，保留显式选择、原请求与执行恢复。181 scoped unit、37 DB、36 构建页面用例及静态/构建门禁通过；父线程复验42组件与37DB通过，正在核验构建页面并集成发布文档 main。仍待push、新 exact-head CI、P1处置与17分钟窗。两轮 review 预算已用完，不开第三审。
- **行为基线 / YUK-405**：[完整设计](docs/design/2026-10-06-continuous-learning-system-behavior.md)连接学校、纸笔、自习与数字工具，由 agent 在持续委托下负责实现和验证，不是已实现清单。
- **模型范围**：产品生成式/多模态 AI 为 MiMo2.6Pro；开发按 AGENTS 常规选模。专用 embedding、typed Jev 和 OCR 协议保留。现有评分准入与确定性功能不降级。

## NEXT

- 完成 YUK-1340 日用入口，再沿“椭圆难题 → 记录过程与帮助程度 → 区分暂时理解和独立迁移 → 后续验证安排”的真实学习路径推进。短回答成功不等于可靠评估已经兑现。
- YUK-1042：42 failed +42 DLQ 原义务保留；先查每项副作用和幂等身份再恢复，不清队列或重付未知结果。
- YUK-1338 目标架构集成保持 Backlog，单独证明状态版本、过期结果拒绝与重启恢复；ADR-0066 的 TanStack Start/Pi/PostgreSQL/DBOS 方向尚非当前运行形态。

## PARKED

- YUK-1342：付费探针开关、不可覆盖封存及 OpenAI4 node-fetch 绕过 global-fetch 观测。副本记忆功能通过，但整体探针仍 FALSE；SDK wire/count/cost 不完整，不重复付费刷绿。
- YUK-1345：provider-only 校准默认值及旧 vision lane 同源归因，已裁决非阻塞；不把统一模型称为异源证据。
- YUK-1344：Tailscale 本机 HTTPS/鉴权和既有独立 peer 已验证，离家实体设备验证尚缺。
- YUK-1329：通用发布与回退演练仍未完成。旧备份 helper 的 auto-purge 文案/清单不适用当前保留策略；此次 R2 快照在停写前8秒完成，发布后逐对象内容和版本完全一致、最后修改均早于停写，已补证且保留真实时序。
- YUK-1235：镜像外部 MCP/sharp 版本与 lock 漂移已有票；本轮无已证实可达 P0/P1，不扩张成依赖整治。
- 其他线程 YUK-1325 / PR #1580 独立推进；不接管其工作树或批量标 Done。旧完成线程被 PR 通知唤醒后越界写入的风险继续由父线程独占 watch 约束，平台跟进仍待去重登记。

## BLOCKED-ON

- 无需 owner 追加日常授权。旧 Xiaomi402 不再阻塞新 Copilot；历史失败没有删除。
- 新对话目前可用；默认选择结束会话及自动续接 P1 尚待 #1583，不能称 UI 已修。
- 旧镜像单独回退兼容性未验证；数据库恢复必须处理备份后新写入，不可自动覆盖。发布材料见新 release-result，旧制品记录只作历史。
- 每小时 T3 任务仍绑定原线程；需要 Mac/T3 运行。远程访问需要同一 tailnet、Mac 开机且用户会话内 daemon 在运行。
