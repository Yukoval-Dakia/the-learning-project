# PLAN — 活看板

> Linear 是权威 tracker；更新于 2026-10-06：owner 要求先用语言设计完整系统与行为，不讨论实施先后。本轮形成 [连续学习系统行为设计 r0](docs/design/2026-10-06-continuous-learning-system-behavior.md)，归既有 YUK-405 产品愿景讨论；具体行为仍为提案。已批准的技术目标见 [ADR-0065](docs/adr/0065-typescript-adaptive-learning-architecture.md)，尚未启动迁移。旧看板见 [历史快照](docs/planning/2026-10-06-plan-snapshot.md)。

## NOW

- **当前单线 / YUK-405 产品设计**：围绕学校、纸笔、自习及数字工具中的连续学习，完整说明记录、学情判断、动态安排、教学、主动备课、纠偏、自主权、隐私与失败恢复；不以 MVP、阶段或开发顺序组织。
- **本轮交付**：行为设计 r0、场景与验收样例、独立场景/边界检查及本地 handoff。设计提案不代表 owner 已批准，也不代表当前实现具备这些行为。
- **已定边界**：实时状态与安排共同演进；TanStack Start + Pi + PostgreSQL/Drizzle + DBOS 技术目标保留。当前 Hono + Vite SPA + pg-boss 运行形态未改变；本轮不改 UI 或业务代码。

## NEXT

- 与 owner 审阅完整行为稿，修正具体场景与默认权限，形成确认版本；本轮不拆实施票、不排开发顺序。
- **YUK-1338** 的技术集成验证保留 Backlog、未启动；行为稿不视为该验证已完成或新的迁移授权。

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

- 本次设计无外部访问阻塞；r0 的新增行为与重大默认取舍待 owner 审阅，不更新已批准领域词条或现役权限。
- 本次没有启动迁移、生产数据切换、部署或付费模型评估；历史授权与预算留在原 handoff，不自动转用到新任务。
