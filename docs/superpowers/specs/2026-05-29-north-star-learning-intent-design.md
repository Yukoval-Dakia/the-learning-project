# 学习意图 / 北极星（North-Star Learning Intent）— Design Spec

> 状态：**design approved 2026-05-29**（brainstorming session）。本 spec 是 [YUK-143](https://linear.app/yukoval-studios/issue/YUK-143) 的实现依据。
> **Build 排期**：post-v1（v1 closeout 后的 scenario-B-recut 高优先 track）。本 spec 现在写好备用；实现走 writing-plans。
> **Source**：2026-05-29 master-coordinator session 的 feature-level 讨论；产品愿景见 `CLAUDE.md` + ADR-0014（"AI 是与用户对等的 first-class actor"）。

## 1. 问题 / 目的

工具已能捕获错题、生成 Living Note、夜间提议（Coach / Dreaming），但**不知道用户想达成什么**（`learning_session.goal_id` 是个从未激活的 stub）。因此 AI 的提议都是**反应式**的（"基于你错了啥补这补那"），缺一条贯穿主线。

**用户拍板的两个核心痛点**（其余明确**不是**重点）：
- ✅ **没方向感**：每天打开不知道该干嘛；AI 建议零散，缺主线。
- ✅ **AI 不懂我要去哪**：AI 只被动反应，从不为"我要达成什么"主动规划。
- ❌ **不是**进度/意义感（不做进度条 / 完成度量）。
- ❌ **不是**约束学习范围（北极星不当过滤器）。

一句话目标：让 AI 的诊断 / 今日安排 / 该学啥**朝用户的目标主动推进**，且每天的动作都能追溯到某个目标（方向感来源）——但**不劫持** spaced-review 骨干。

## 2. 已锁定的设计决策

| # | 决策 | 来源 |
|---|---|---|
| ND-1 | **多个并行北极星**（通常 subject-scoped），不是单一主线。AI 在 active goals 间分配每日精力 | 用户选"多个并行（按学科）" |
| ND-2 | **AI 主导 goal→path 翻译，用户确认**：用户输模糊标题，AI 推断覆盖的知识 + 粗排序，走 proposal 模式 confirm/edit/dismiss | 用户选"AI 主导，你确认" |
| ND-3 | **方案 1「目标透镜」**：轻量，重用 Coach/review/网格/提议箱；不建里程碑/进度 apparatus | 用户选"方案 1" |
| ND-4 | **非进度条的目标 UI**：展示"目标 + 覆盖什么 + 朝它在做什么"，**不**显示完成百分比 | 用户 "加一个不是进度条但显示目标的 UI" |
| ND-5 ⭐ | **硬约束：北极星不得覆盖/挤占复习等任务**。FSRS 到期复习、其他录入任务照常跑；goal 只叠加方向（软偏置 + 标签），不抑制、不隐藏、不抢占、不改 due | 用户 "不要让北极星覆盖其他的复习等任务" |

## 3. 数据模型

`goal`（多个并存，subject-scoped）。倾向**独立 `goal` 表**（而非仅激活 `learning_session.goal_id` stub——goal 是长期对象，不绑单 session），字段：

- `id`, `title`（模糊人话，如"能流畅读《史记》"）, `subject_id`（nullable，支持跨学科）
- `scope_knowledge_ids: string[]`（AI 推断 + 用户确认的覆盖知识节点）
- `sequence_hint`（轻量排序提示，**AI 内部 sequencing 用，不外显为进度**）
- `status`: `active | dormant | done`
- 时间戳 + 来源（创建/确认走 event 留痕，evidence-first）

`learning_session.goal_id` stub：实现时决定激活为 FK 指向 `goal.id`（把 session 归到某 goal）或保留 stub —— 见 §8 open Q。

## 4. AI：GoalScopeTask（ND-2）

- 输入：goal `title` + 知识网格快照（nodes + mesh edges + 现有 mastery）。
- 输出：推断的 `scope_knowledge_ids[]` + 粗 `sequence_hint` + reasoning。
- 落地：走**现有 proposal 模式**（`AiProposalPayload` discriminated union，新增 `goal_scope` kind）→ 用户 accept/edit/dismiss。evidence 留痕 + 可回滚。
- 演化：用户学习推进后，AI 可重新提议扩/缩 scope（仍走 proposal，**不静默改**）。
- 复用 `src/ai/registry.ts` + `src/server/ai/runner.ts`；mimo-v2.5-pro 文本。

## 5. Coach 集成 + 共存保证（ND-5，本设计最关键的一段）

Coach 每日计划（`CoachTask` / `TodayPlan`，`src/core/schema/coach.ts` + `src/server/boss/handlers/coach_daily.ts`）：

```
TodayPlan = [ 现有：复习/到期/其他录入任务 — 原样不动 ]
          + [ 新增：一条目标导向 strand ]
```

- Goal 只影响"**新内容 / 重点该投哪**"，并给计划项打 `goal_id` 标签（← 方向感：每条动作可追溯到目标）。
- 多目标时 Coach 在 active goals 间分配那条 strand 的精力。
- **硬约束（ND-5）**：goal **不**抑制 FSRS 到期复习、**不**隐藏非目标录入任务、**不**抢占当日额度、**不**改 due 时间。复习骨干完全独立运行。
- `TodayPlan` schema 扩展：加 `goal_ids` / 让 plan 项带 `serves_goal_id` —— **顺带闭合 graph-signals 勘察发现的 gap**（现 TodayPlan 不带 knowledge_ids、Coach 不知节点）。

## 6. 目标 UI（ND-4，非进度条）

"北极星"区（`/today` 卡 + 可能一个独立 goals 视图）：每个 active goal 显示
- `title`
- 它**覆盖的领域**（几个关键 knowledge 节点 / domain，从 `scope_knowledge_ids` 取）
- **今天/最近朝它做了什么**（带 `goal_id` 标签的动作）
- 定性状态（活跃 / 最近冷落了）—— 文字，非百分比

**不显示** % 完成 / 进度条 / 倒计时。展示的是"覆盖什么 + 在做什么"，不是"走了多远"。
UI 走 design system tokens + 现有 primitives（动 UI 前按 CLAUDE.md 做 design-doc pre-flight）。

## 7. 其他集成

- **诊断图谱（T-KG / YUK-142）**：goal 作为一个 **lens** —— 高亮某目标的 `scope_knowledge_ids` 子图。与图谱的 filter 机制天然契合。
- **review**：FSRS 到期队列**不变**（ND-5）。goal 仅在"同等条件下优先 goal-relevant"这种**软偏置**层起作用，绝不改 due / 跳过到期项。
- **Dreaming**：可朝 active goals 的薄弱 scope 提议（仍走 proposal 箱）。

## 8. Open implementation questions（writing-plans 阶段定）

1. `goal` 独立表 vs 激活 `learning_session.goal_id` stub —— 倾向独立表 + session 可选关联。
2. Coach 多目标"分配那条 strand 的精力"的具体策略（轮转 / 按薄弱 / 按用户标记主攻）——v0 可最简（轮转 + 薄弱优先），留可调。
3. `goal_scope` proposal 与现有 proposal inbox 的 UI 复用程度。
4. goal "达成 / dormant" 的判定：用户手动 vs AI 提议 vs scope 全 mastered 触发提议（注意 ND-4 不做自动进度，但"建议你这个目标可以收了"是合理的 AI 提议）。

## 9. 边界 / 非目标（YAGNI）

- 不做进度条 / 完成度量 / 倒计时（ND-4）。
- 不让 goal 覆盖、过滤、抑制复习或其他录入任务（ND-5）。
- 不自动隐藏非目标内容。
- 不强制单一主线（多目标并行，ND-1）。
- 不做里程碑/阶段课程 apparatus（那是被否的方案 2）。

## 10. 验收（acceptance，实现时细化）

- 用户输一句模糊目标 → GoalScopeTask 出 scope proposal → 确认后 `goal` 落库（带 scope_knowledge_ids）。
- 次日 Coach 计划：**到期复习/其他任务原样在**，额外出现带 `goal_id` 标签的目标导向动作；多目标时在它们间分配。
- 目标 UI 显示 active goals + 覆盖领域 + 近期目标动作，无进度条。
- 诊断图谱能按某 goal 高亮其 scope 子图。
- 回归：goal 存在时 FSRS 到期队列 / 数量 / due 时间**不变**（ND-5 守恒测试）。

## 11. 关联

- Linear：[YUK-143](https://linear.app/yukoval-studios/issue/YUK-143)（13pt，post-v1 高优先）。
- 跨切：Coach / Dreaming / review / 诊断图谱（YUK-142）/ schema / `/today` UI —— 实现需独立 ADR（goal 实体 + Coach 共存契约）。
- 闭合 gap：graph-signals 勘察发现的 "TodayPlan 无 knowledge_ids / Coach 不知节点"。
- Closeout 时补进 master-roadmap §2 + §11（新 track，原 scenario B 未含）。
