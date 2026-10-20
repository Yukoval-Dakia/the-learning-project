# Practice selection 域责任归位（YUK-1570 · practice-ai-domain-exit lane）

- 基线：`56637f4a4582aad52ffb0b6a6bdf9b91eeeaa347`；集成后 head = merge `6a76a522`（#1902/#1895）。
- 原报告与校正：外置 `tlp-audit-artifacts/architecture-deepening/YUK-1570/56637f4a4582aad52ffb0b6a6bdf9b91eeeaa347/practice-ai-domain-exit/`（`exit-plan-and-block-1.md` 原报告 + `errata-v1.md` 校正层；含全量 63/62 边分组表与各 family 长期退出方向）。

## 本片内容

`src/server/ai/selection-orchestrator.ts` → `src/capabilities/practice/server/selection-orchestrator.ts`。

该文件承载 ADR-0042 档2 L2 编排的**域决策**：分桶信号投影（诚实天花板）、mem0 `<ADVISORY_ONLY>` 封套、`⊆/dedup/非负权`解析 barrier。它原先放在 `src/server/ai` 且反向 `import @/capabilities/practice/public`——server→capability 层方向倒置。迁移后与 TaskSpec（`practice/tasks/selection-orchestrator.ts`）、信号源（`candidate-signals.ts`）、常量 owner（`selection-constants.ts`）、唯一 consumer（`softmax-selection.ts`）同域同目录。

**性质如实**：这是**域责任归位**，不是新增深度。接口、caller 参数与调用步骤逐字未变；变化场景下的修改文件数不变。真实收益只有两条：域编辑不再跨进 runtime 目录；`server/ai` 失去对 practice barrel 的生产依赖（反向域知识解除）。

## 触碰面

- 迁移文件本体（import 改指 `./candidate-signals` + `./selection-constants`）。
- `practice/server/softmax-selection.ts`：1 处 import 改指（等价证明见 errata E4）。
- `core/schema/selection-orchestrator.ts`：注释路径指针 1 行（零算法收益）。

## 边账（官方口径 distinct-source-file→resolved-module）

`practice → ai` **63 → 62**；`capability → server` total **406 → 405**。baseline 经 `pnpm audit:capability-boundaries --tighten` 登记（decrease 条目，schema 完整，无新增 edge——`edgeRecords` 保持空）。

## 验证（heavy.sh）

typecheck / lint / build 全 PASS；`audit:capability-boundaries` 与 `audit:architecture-deepening` PASS（tighten 后零违规）。测试未跑（owner 冻结）。

## 不属本片

item-prior / solution-generate 的迁移被冻结测试钉与未释放 caller 阻塞；sealed-validation / vision-judge-config / failure-ledger 及 G3/G4 runtime family 的长期位置归 runtime_exit lane 裁决（见 errata E2 逐 family 表）。
