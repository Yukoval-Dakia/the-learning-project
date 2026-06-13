# ADR-0025 — North-Star `goal` 实体 + Coach 共存契约（ND-5 不变式）

**状态**：accepted
**日期**：2026-05-30

> 起源：YUK-143「学习意图 / 北极星」。Spec
> `docs/superpowers/specs/2026-05-29-north-star-learning-intent-design.md`
> （design approved 2026-05-29）锁定 ND-1..ND-5。本 ADR 固化两件事：
> (1) goal 作为**独立长期实体**而非 `learning_session.goal_id` stub 的激活；
> (2) **Coach 共存契约**——把 ND-5（北极星不得覆盖/挤占复习等任务）写成一条
> 显式、可测的架构不变式。本 ADR 只覆盖 W9 core slice；UI（W10）不在此。

---

## 决策 1 — 独立 `goal` 表，不激活 `learning_session.goal_id`

新建 `goal` 表（standalone）：

```
goal(
  id, title, subject_id (nullable, 跨学科),
  scope_knowledge_ids jsonb<string[]>（AI 推断 + 用户确认的覆盖节点）,
  sequence_hint integer（AI 内部 sequencing 用，不外显为进度）,
  status 'active' | 'dormant' | 'done',
  source text（provenance：'goal_scope_proposal' 等）,
  source_ref text（materialize 它的 propose event id）,
  created_at, updated_at, version
)
```

`learning_session.goal_id` **保持 stub**（nullable text，沿用既有 allowlist
entry），不激活为指向 `goal.id` 的 FK。

**为什么独立表 / 不绑 session**：
- goal 是**长期对象**，跨多个 session（spec §3）。把它绑到单个
  `learning_session` 是错误基数（one goal ⇏ one session）。
- 多个并行 goal（ND-1，通常 subject-scoped）天然是顶层实体集合，不是某 session
  的属性。
- session↔goal 的可选关联在出现**第二个具体需求**前不建（ADR-0009「无第二实例
  不抽象」/ YAGNI）。W10+ 若真需要再加关联表或激活字段。

**create / confirm 走 event 留痕（evidence-first）**：goal 不是用户直接 INSERT
的——它由 `goal_scope` proposal 被 accept 时**物化**，物化事务里写一条 `rate`
event（rating='accept'，payload 带 `materialized_goal_id` 指向新 goal 行）；
`goal.source_ref` = propose event id。retract proposal → goal 行被
tombstone（`status='dormant'` + 反向 correction event），与 variant_question /
learning_item 的 proposal-retract 语义一致（`actions.ts`）。

---

## 决策 2 — `goal_scope` 复用现有 proposal 模式（ND-2）

不新建 proposal 通道。`AiProposalPayload` 加 `goal_scope` kind：

```
{ kind: 'goal_scope',
  target: { subject_kind: 'goal', subject_id: <goal id | null> },
  proposed_change: { title, subject_id?, scope_knowledge_ids[], sequence_hint, reasoning } }
```

- `writeAiProposal` 对未知 kind 落 `action='experimental:proposal'`，
  `subject_kind = target.subject_kind`（='goal'）。
- `listProposalInboxRows` 的 `proposalWhere()` 已匹配 `experimental:proposal`，
  `deriveLegacyAiProposal` 已能 `parseAiProposalPayload(payload)` ——
  **inbox.ts 零改动**即可让 goal_scope 出现在统一提议箱。
- accept → `acceptGoalScopeProposal`：在一个事务里 INSERT goal 行 + 写 rate
  event；dismiss → 通用 rate event；edit → UI 改 `proposed_change` 后走 accept
  （W10）。全部 evidence-logged + 可 retract（reversible）。

GoalScopeTask 输入 = goal title + 知识网格快照（nodes + mastery + mesh edges），
输出 = `scope_knowledge_ids[]` + 粗 `sequence_hint` + reasoning。复用
`runAgentTask` + mimo 文本 provider，单次结构化输出（同 propose_edge.ts 模式，
不走 12-iter tool loop）。

---

## 决策 3 — Coach 共存契约（ND-5，本 ADR 最关键）

**不变式 ND-5**：北极星只 **ADD 方向**（软偏置 + 标签），**绝不**：
- 抑制 / 隐藏 FSRS 到期复习；
- 隐藏非目标的录入 / capture 任务；
- 抢占当日复习额度；
- 改任何材料的 `due` 时间 / FSRS 状态。

**结构性保证（不是约定，是数据流事实）**：
- FSRS 到期队列（`app/api/review/due/route.ts`）只读
  `material_fsrs_state` + `event(action='attempt', outcome='failure')`，
  与 `goal` 表 / Coach 输出**零耦合**。
- `runCoach`（`coach_daily.ts`）只写 proposal + 一条 `experimental:coach_scan`
  event；它从不读 review-due 路径、从不 UPDATE `material_fsrs_state`。
- goal 集成把 active goals 喂进 Coach 输入，并扩展 `TodayPlan`：
  plan 级加 `goal_ids[]`，plan-item 加 `serves_goal_id` + `knowledge_ids`
  （← 顺带闭合 graph-signals gap：原 TodayPlan 不带 knowledge_ids、Coach 不知
  节点）。新增的「目标导向 strand」是 `TodayPlan` payload 上的**纯增量字段**，
  不触碰 `review_session_proposal` 的产生路径。

```
TodayPlan = [ 复习/到期/其他录入任务 — 原样不动 ]
          + [ 目标导向 strand（带 serves_goal_id / knowledge_ids 标签）]
```

**回归守卫**：ND-5 conservation test —— 对同一份 FSRS 状态，断言
`/api/review/due` 的输出（ids / 顺序 / counts / due_at / fsrs_state）在「有
active goals」与「无 active goals」两种 fixture 下逐字节一致。该测试是这条不变
式的 load-bearing 守卫；改动 goal/Coach 路径若让它变红 = 违反 ND-5，必须修复
而非改测试。

**多目标 strand 精力分配（spec §8 Q2，v0）**：`listActiveGoals` 按
`sequence_hint` then `created_at` 排序，全部喂进 Coach 输入；v0 分配策略 =
轮转 + 薄弱 scope 优先，作为 objective/prompt 里的**软指导**（模型挑），handler
不硬切额度。可调，留 hook。

---

## 接受的代价 / 边界

- goal 没有进度 / 完成度量字段（ND-4）：`sequence_hint` 仅供 AI 内部排序，**不**
  外显为进度条。「目标可以收了」是合理的 AI 提议（走 proposal），不是自动进度。
- `goal.subject_id` / `goal.source` 是 set-once provenance：有 INSERT write path
  （`insertGoal`）但不在 UPDATE path 里（status/title/scope/sequence_hint 可 UPDATE）。
  INSERT write path 即满足 `audit:schema`，无需 allowlist entry。
- W10 才接：/today goal 卡、独立 goals 视图、KG goal-lens 高亮、review 软偏置
  排序、Dreaming goal-aware 提议。core 只落 schema + AI task + Coach 字段 +
  accept/dismiss dispatch + 守卫测试。

---

## 与其它 ADR 关系

- **ADR-0014**（AI 与用户对等的 first-class actor）—— GoalScopeTask 是 AI 主导
  goal→path 翻译、用户确认（ND-2）的直接体现。
- **ADR-0006 v2 / ADR-0021**（event 是真相 / outbox）—— goal create/confirm 走
  event 留痕；goal 行是 event 物化产物，不是独立可写状态。
- **ADR-0013**（review session lifecycle）—— ND-5 明确 goal 不改 review 骨干；
  本 ADR 把它写成可测不变式。
- **ADR-0018 / YUK-19**（variant / learning_item proposal lifecycle）——
  goal_scope 的 accept/retract 物化语义对齐它们既有的 proposal→materialize→
  retract-tombstone 模式。

---

## 一句话总结

> **北极星是一层「方向透镜」：它给计划加 goal 标签、给 AI 加 sequencing 提示，
> 但复习骨干（FSRS due）在它眼里完全透明——goal 只 ADD，永不 INHIBIT。**

> **M5 路径注（YUK-321，2026-06-13）**：本文提及的 `app/api/**` Next route 路径已随旧栈拆除迁移至 capability manifests（`src/capabilities/*/manifest.ts` + 各包 `api/*.ts`），由组合根 `server/app.ts` 挂载；决策本身不受影响。
