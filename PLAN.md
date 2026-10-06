# PLAN — 活看板

> Linear 是权威 tracker；更新于 2026-10-06：owner 已批准 **TanStack Start + Pi + PostgreSQL/Drizzle + DBOS** 的单服务器目标架构。决策见 [ADR-0065](docs/adr/0065-typescript-adaptive-learning-architecture.md)。本轮记录决策，尚未实施迁移。原看板与历史状态已归档到 [历史快照](docs/planning/2026-10-06-plan-snapshot.md)。

## NOW

- **YUK-1337 / 目标架构决定**：学习状态与教学安排持续共同演进；页面、Pi 工具和后台任务共用业务操作；Pi 保留，DBOS 承担目标持久执行机制，PostgreSQL 保存权威事实与版本。
- **本轮交付**：ADR-0065、领域术语、ADR-0051 修订入口及 handoff；仅文档与 Linear 记录。当前 Hono + Vite SPA + pg-boss 运行形态未改变。
- **进度边界**：目标已批准；Pi/DBOS 集成与迁移尚未实施。项目 [P-YUK-23](https://linear.app/yukoval-studios/project/tlp-ts-全栈与实时自适应学习-5cc10bf2aaea) 保持 Backlog。

## NEXT

1. **YUK-1338（Backlog，未启动）**：在隔离工作树和测试数据库验证 Pi + DBOS 的业务竖切：新证据影响安排、旧版本结果受提交校验、真实进程重启不重复已提交业务效果。
2. 根据验证证据制定模块、持久任务和数据的迁移计划，明确旧任务义务、回滚及实际版本；不能把整段 agentLoop 重试视为步骤恢复。

## PARKED

- 前端视觉改造仍是目标，视觉方向本轮暂缓；具体 UI 实施按设计 pre-flight。
- `pi-durable` 后续评估，不作为已选持久化基础，也不与 DBOS 同时拥有同一循环的恢复。
- 以下保留原看板待办，本轮未重新核查其实施状态：
  - YUK-1045 初审遗留（非阻塞待归票）：claim 冲突路由未翻译 409 `claim_conflict`（question-restore.ts:49–55，当前 500/泛 conflict）；source_verify 对 part 走 child→root 锁序，与 publisher root→child 反向可能死锁（source_verify.ts:699–717）；1043 lane 已知缺口 `publishQuestionGroup` 不调 `validateStructure`（material_id 重复不被拦）。
  - 两处judge直调已核实为照片作答/独立解答一致性，不为调用形式统一机械删除，无新缺陷证据。
  - 全历史ADR审计仍未完成，不冒充全量通过；971仅覆盖三份已确认冲突的现役指引。
  - 951按ADR0063明确保留历史表/native投影及live remote ToolOperations；不是待做通用表名合并。
  - 921多provider、572夜间教研、832HOLD不解锁。
  - Astra P2/P3 叫停：YUK-1028 回 Backlog（重启基线=main，`attempt-cost.ts` 已有 openai→estimated 归因初版）、YUK-1029 needs-info 等 owner 拍 LIGHT/FULL scope + actual-output 预算。
  - 计费、重试、prompt/skill、复杂parser、并发/回滚/恢复、UI安全测试仍保留，不按数量硬删。

## BLOCKED-ON

- 本次架构决策记录无外部阻塞；后续 Pi/DBOS 恢复语义、实际延迟及输出质量仍需验证，不能声称已经通过。
- 本次没有启动迁移、生产数据切换、部署或付费模型评估；历史授权与预算留在原 handoff，不自动转用到新任务。
