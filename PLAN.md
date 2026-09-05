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
- 两次真实 read 累计 $0.194333，工具正确但模型未稳定遵守 JSON。已决策删除该模型格式协议，
  改为明确的 terminal Markdown + 服务端 observed trace 收据；不是静默伪造模型引用的 fallback。
  初审 P1（无效 durable terminal 错标 DONE）已修正；同时隔离启用技能时加载的项目开发指令。
- 计划与证据：`docs/planning/2026-09-05-ai-pipeline-completion.md`；具体设计：
  `docs/planning/2026-09-05-pipeline-finalization-design.md`。历史 F5 状态见 Git 中本文件前版。

## NEXT

1. 集成 terminal Markdown 简化与技能隔离，跑 scoped 验证。
2. 初审已完成；仅剩一次 P0/P1 修复验证审，不启动第三轮。
3. 在剩余 $1.805667 内完成同输入比较和会话/子任务/durable/语义校验场景；未知费用立即停止。
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
