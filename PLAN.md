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
- 尚未集成：根任务终态 JSON 的最终回复校验器、两个重复 evidence Task 的退休及配套测试替换。
- 当前集成检查：runner 88 tests、生成工具/目录 85 tests、原生配置 28 tests、
  工具退休 15 tests；各组可能交叠，不作为唯一测试总数相加。类型/架构/任务清单检查通过。
  跨能力到 server 的依赖数已从基线 464 降至 462，没有放宽 ratchet。
- 计划与证据：`docs/planning/2026-09-05-ai-pipeline-completion.md`；具体设计：
  `docs/planning/2026-09-05-pipeline-finalization-design.md`。历史 F5 状态见 Git 中本文件前版。

## NEXT

1. 集成最终回复提交器，保留出题/解题/教学语义校验、提案权限和取消结算。
2. 完成集成 scoped unit/DB、typecheck/lint/audits/build；一轮独立 review，必要时仅一次 P0/P1 验证审。
3. 实际模型验收的追加费用获确认后，运行同输入的新链路和会话/子任务/durable 场景。
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
- 旧链路真实只读基准：至少 57,817 input / 2,457 output tokens，已确认 $0.201614；
  比较模型超时后费用未知，停止后续付费调用。已异步询问 owner 是否允许新链路新增最多 $2 验收。
- 无生产部署或历史数据清理授权；不影响本地实现、审查与 CI。
