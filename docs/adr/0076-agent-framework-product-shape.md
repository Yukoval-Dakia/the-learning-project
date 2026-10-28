---
status: accepted
---

# ADR-0076 — Agent 框架产品形态（AF 决定重立档）

**Status:** Accepted（决定本身 ratify 于 2026-06-03/04 owner 产品讨论 + U0 grill；2026-10-28 自归档 spec 重立档为现行 ADR）。
**Decision source:** AF spec（`docs/archive/superpowers/specs/2026-06-04-agent-framework-design.md` §1.1–§1.3、§8、N2 rider；原文经 YUK-1575 退役归档，本 ADR 提取其仍有效且未被后续 ADR 承接的产品形态决定，并成为其现行出处）。
**Tracking:** [YUK-1575](https://linear.app/yukoval-studios/issue/YUK-1575)（重立档）。
**Supersedes:** [ADR-0004](0004-pattern-c-two-type-agent-architecture.md) 的产品形态面（两类 agent 的产品切分；0004 此前被 AF spec 取代，该取代关系现由本 ADR 正式承接）。
**Related:** [ADR-0025](0025-north-star-goal-entity-and-coach-coexistence.md)（ND-5 proposal-only 不变量 owner）、[ADR-0029](0029-review-engine-lands-on-existing-primitives.md)（治理归位：memory 治理与 blast-radius admission 的现行记录）、[ADR-0031](0031-copilot-inline-quiz-authoring.md)、[ADR-0032](0032-domaintool-surface-redesign.md)（full safe capability 的下游消费）、[ADR-0062](0062-unified-copilot-conversation-lifecycle.md)/[ADR-0065](0065-pi-execution-and-conversation-replay.md)（会话生命周期与执行机制，后于 AF）、[ADR-0068](0068-general-subjects-co-maintained-context.md)（SKILL.md 语境层 C8 迁移方向）、[ADR-0075](0075-agent-harness-contract.md)（工具面细节修订）。

## 背景

AF spec 是 2026-06-04 定稿的 agent 框架产品形态设计，长期被 `docs/agents/objectives.md`、`docs/agents/domain.md`、ADR-0004/0031/0032 当作上位权威引用。YUK-1575 将 superpowers 语料整体归档后，仍有效的形态决定需要现行出处——本 ADR 即该出处；归档原文仅供溯源。

## 决定

1. **唯一用户面对话 agent**：Copilot 是唯一的用户面对话 agent——全局存在、自动获得用户当前上下、一个连续对话心智模型；Teaching/Solve 等是 Copilot 的 skill/state，不是独立产品面（用户永远不在「Copilot vs Teaching」之间选择）。
2. **Full safe capability**：Copilot 永远携带完整**安全**能力集。skill 可以调整 prompt、上下文、策略与输出形态，但**不得因页面/模式不同而隐藏或移除工具能力**。安全面不变量由 ADR-0025 ND-5 拥有：破坏性领域改动 proposal-only（除非既有用户确认路由拥有该变更）；raw DB mutation 不是 Copilot 能力；draft 层直改仅限显式设计为用户触发编辑的面。
3. **Skill = behavior pack，不是工具开关**：skill 决定注意力、解释方式、subject policy、输出形状、反馈缓冲；**不定义 Copilot 的工具权限边界**（工具权限归 Copilot 安全面；窄后端 task 保留窄 allowlist）。SKILL.md 生态不止 Copilot 一个消费者——后端生题/验题 task 经 SDK `Options.skills` 加载同一套 per-题型 pack（出题验题同源）。
4. **两个 `skills/` 命名空间不可混淆（N2）**：`src/subjects/<id>/skills/` = SDK SKILL.md 目录（frontmatter + references + assets，磁盘发现、`Options.skills` 装载）；`src/server/copilot/skills/` = 旧式进程内 TS 服务模块，**不是** SKILL.md pack。触碰任一树的后续工作必须维持这一区分。
5. **Non-goals**（AF §8，仍全部有效）：不做公开插件平台；不做 raw DB 编辑工具；不出现第二个用户面 chat agent；不把每个窄 task 升格为 full agent；不一次性替换全部既有路由。

## 未重立档（已有现行出处）

AF §3.1 memory 治理与 §3.2 blast-radius admission → ADR-0029「治理归位」+ 根 `CONTEXT.md`；会话生命周期/执行机制 → ADR-0062/0063/0065；工具面细节（MAINTENANCE_TOOLS 移除、single-writer 表、note→finding 迁移）→ ADR-0075 D1/D3/D4 修订。

## 运行期速查的同步义务

`docs/agents/objectives.md` 的五节速查卡与本 ADR 互链不重复：本 ADR 改了，回 objectives.md 同步授权矩阵与边界；发现矛盾以本 ADR 为准（AF spec 及 U0 裁决原文见归档路径与 `docs/design/2026-06-04-u0-decisions.md`）。
