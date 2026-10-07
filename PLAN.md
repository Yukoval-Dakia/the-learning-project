# PLAN — 活看板

> Linear 是权威 tracker；更新于 2026-10-07：owner 已将产品决定、实施与本机部署运维交由 agent 持续执行，见[持续授权](docs/planning/2026-10-07-autonomous-delivery-charter.md)。本轮形成 [连续学习系统行为设计 r0](docs/design/2026-10-06-continuous-learning-system-behavior.md)，归既有 YUK-405 产品愿景讨论；具体行为仍为提案。已批准的技术目标见 [ADR-0065](docs/adr/0065-typescript-adaptive-learning-architecture.md)，尚未启动迁移。旧看板见 [历史快照](docs/planning/2026-10-06-plan-snapshot.md)。

## NOW

- **当前单线 / YUK-1103 自主交付**：每小时 T3 自动任务已启用；main5d738dbc0 已在本机发布；当前修复 Copilot 旧 provider 余额不足并验证真实学习行为。活动工作树 `/Volumes/YukovalSBak/yukoval-projects/tlp-autonomous-local-delivery`，branch `ops/yuk-1103-local-delivery`。完整当前看板见该树 `PLAN.md`，交接见 `.remember/2026-10-07-autonomous-local-delivery.md`。本根树原有未提交改动保留，不在此部署旧代码。
- **本轮交付**：行为设计 r0、场景与验收样例、独立场景/边界检查及本地 handoff。设计提案不代表 owner 已批准，也不代表当前实现具备这些行为。
- **已定边界**：实时状态与安排共同演进；TanStack Start + Pi + PostgreSQL/Drizzle + DBOS 技术目标保留。当前 Hono + Vite SPA + pg-boss 运行形态未改变；本轮不改 UI 或业务代码。

## NEXT

- agent 在持续委托下采用行为稿为基线，负责设计细化、实现与验收；无需 owner 逐项审阅。本机部署及恢复演练已完成，下一步恢复真实 AI 帮助和学习行为验收。
- **TS 迁移 + UI 重写（epic YUK-1351）已准备、未实施**：[准备计划](docs/planning/2026-10-07-ts-migration-and-ui-rewrite-prep.md) 决定按路由合并交付（每条 TanStack 路由同时上线新 UI）。第一道 gate 为 **YUK-1338**（Pi + DBOS 竖切，Backlog）；不过 gate 不动生产。P2 视觉 loft YUK-1353 可并行。UI 票（YUK-1353/1354/1357 及 P6 UI 子票）只交 Claude Opus 5.5；非 UI 票按授权默认模型。当前 active 线仍为上一条。
- **早期单收口（2026-10-07）**：YUK-100..500 的 20 张已在 Linear 逐张裁定——147/213/295/310/406/443/464 转 Todo，369 Canceled（被 1038 取代），其余设触发条件与 10-21 / 11-07 复查截止，到期未触发即取消；406 验收裁定连带 405/418/419。

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

- 无需 owner 追加授权。本机 main5d738dbc0 健康、115项迁移；Copilot 实际调用旧 Xiaomi 返回402余额不足，暂未通过 AI 日用验收。
- 每小时任务已实际唤起；新工作子任务统一使用 OpenCode Go MiMo2.6Pro。父线程选择切换未保持，不重复触发中断。最新证据与后续入口见活动树 PLAN 和本地 handoff。
