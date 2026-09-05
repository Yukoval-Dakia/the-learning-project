# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 更新于：2026-09-05（AI pipeline 完整改造进行中；尚未收口）

## NOW

- Owner 已授权继续完整 AI pipeline 重构，由 agent 决策；目标为低 token、清晰的能力归属、
  原生子 agent 与明确的 durable 根任务。整个项目结构优化在本线完成后再讨论。
- main 基线 `090e882c` / PR #1324 已完成前台上下文改造。当前隔离集成分支：
  `codex/yuk-939-pipeline-completion`，不修改原始脏 main。
- 已集成：单一 SDK 消息消费核心；业务自有 `generate_goal_outline` 与
  `generate_question_candidate`；前台/Mission 原生只读 Task；停止新 ToolOperations；
  七个旧控制工具已从 manifest 与实际 MCP 工具集合移除。保留历史任务恢复与重放。
- `fe71227b` 已集成根终态 finalization，退休两个重复 evidence Task 与过时 ledger/checkpoint 测试。
- 集成 scoped 单测、持久化/恢复 DB 场景、typecheck/lint/audits/build 已通过；发现的一处旧工具
  清单测试已按新 manifest 修正，正在复验。任务数为 50；capability→server 依赖从 464 降到 453。
- terminal Markdown 与技能隔离已集成。`5c2bdcad` 同输入 read 通过：28,464 input / 215 output /
  $0.076271；相对旧基准下界输入至少减 50.8%、费用至少减 62.2%，仅限合成样本。
- 整轮真实验收的冷启动/恢复/ambient/read/proposal 通过；纠错只安全回退，字段类型提示与验收
  已在 `12f77867` 收紧，尚待真实复验。native 发现 SDK 将 Task 规范化为 Agent 并异步返回，
  子任务被父请求结束中断：正在修 SDK 兼容性。最新取消入口实际验证 0 provider attempts。
- 已知新增费用累计 $0.503605，native child 另有未结算费用，付费验收暂停；已请求新增最多 $1。
- 计划与证据：`docs/planning/2026-09-05-ai-pipeline-completion.md`；具体设计：
  `docs/planning/2026-09-05-pipeline-finalization-design.md`。历史 F5 状态见 Git 中本文件前版。

## NEXT

1. 修复 Agent/Task 别名与 native foreground SDK 行为，保留只读/depth-1/父请求回流。
2. 两轮独立审查已用完：`5c2bdcad` 获批准；新实际兼容性修复由 root 检查 worker diff 与真实证据，
   不擅自启动第三轮。按修改范围补 scoped/static/build。
3. 等 owner 对额外 $1 真实验收选择；期间继续免费验证，禁止在未知子任务费用后继续付费。
4. Push 后以 exact-head GitHub CI Gate 为完整测试权威；通过后按仓库授权合并。
5. 收尾更新本看板、handoff、Linear 和部署边界；不得把 LOCAL_GREEN 称作完整验收。

## PARKED

- 整个项目目录/模块结构优化：owner 明确排在 AI pipeline 验收之后。
- Production deploy/observation：未授权。本次不删除数据库记录、旧 migration 或历史回复。
- 旧 mailbox/ToolOperations 恢复器退休：需部署后确认旧非终态记录和队列工作全部排空；
  当前只停止新生产者，保留 drain-only 义务。
- YUK-921 多 provider 方案一、YUK-572 夜间教研、YUK-832 HOLD、Architecture FULL 的生产观察，
  不因本次工程改造自动开启。

## BLOCKED-ON

- Linear 安装后当前工具仍返回 `Unknown tool`，无法读取或同步 issue；不声称 tracker 已同步。
- 旧链路真实只读基准总量不可补全：至少 57,817 input / 2,457 output tokens、$0.201614，
  比较模型超时后费用未知。Owner 已另外授权新链路最多新增 $2；不得把旧基准下界当作完整总量。
- 无生产部署或历史数据清理授权；不影响本地实现、审查与 CI。
