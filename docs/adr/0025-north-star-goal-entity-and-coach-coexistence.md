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

**结构性保证（SET 级守恒是数据流事实；ORDER 级守恒是 test-enforced 纪律）**：

> **W10 修正注（YUK-167，2026-05-30；照本文末「M5 路径注」先例，带日期就地更正而非
> 降级规范）**：本 ADR 落笔时（W9 core）due 路由与 `goal` 表**零耦合**属实。W10 的
> YUK-167 起，due 路由为**软重排**读取 active goals（`rerankOverdueByGoals`，即本文
> §决策 3「W10 才接：…review 软偏置排序」预授权的扩展）。须区分强度不同的两级守恒：
>
> - **SET 级守恒（四条禁令）仍是结构性数据流事实、不是约定**：goal 数据**绝不进入
>   due 的选择阶段**——SQL `WHERE` / `ORDER` / `limit`、跨学科 round-robin、当日额度
>   全程无 goal 输入；goal 唯一的触点是**已选定页**上 order-only 的稳定分区
>   （`rerankOverdueByGoals` 跑在选页 + limit **之后**，对同一 multiset 原样 re-emit
>   行对象，构造上不可能增删行、改 `due_at` 或 `fsrs_state`）。因此四条禁令
>   （不抑制 / 不隐藏 / 不抢占额度 / 不改 due）依旧由数据流结构本身保证，而非仅靠测试。
> - **ORDER 级守恒（W9 的「顺序逐字节一致」）已被 YUK-167 有意放宽**为「goal 相关
>   overdue item 软上浮」，这一维降级为 test-enforced 纪律（由下方 conservation +
>   soft-bias 双 DB 测试守护）；这是预授权的 W10 扩展，非静默侵蚀。

- FSRS 到期队列（`src/capabilities/practice/server/due-list.ts` 的 `handleReviewDue`）
  只从 `material_fsrs_state` + `event(action='attempt', outcome='failure')` 选定返回页；
  **选择阶段**与 `goal` 表 / Coach 输出**零耦合**，仅在选页 + limit 之后对 overdue 尾段
  做 order-only 的 goal 软重排（`rerankOverdueByGoals`）。
- `runCoach`（`coach_daily.ts`）只写 proposal + 一条 `experimental:coach_scan`
  event；它从不 UPDATE `material_fsrs_state`、从不改 due。
- goal 集成把 active goals 喂进 Coach 输入，并扩展 `TodayPlan`：
  plan 级加 `goal_ids[]`，plan-item 加 `serves_goal_id` + `knowledge_ids`
  （← 顺带闭合 graph-signals gap：原 TodayPlan 不带 knowledge_ids、Coach 不知
  节点）。新增的「目标导向 strand」是 `TodayPlan` payload 上的**纯增量字段**，
  不触碰 `review_session_proposal` 的产生路径。

```
TodayPlan = [ 复习/到期/其他录入任务 — 原样不动 ]
          + [ 目标导向 strand（带 serves_goal_id / knowledge_ids 标签）]
```

**回归守卫（双测试分工——W10 后删「顺序」维度）**：ND-5 由两个 load-bearing DB
测试守护，各守一半，分工不同：

- **`coach_daily.northstar.db.test.ts`（Coach 侧守卫）**：跑完整 `runCoach` + goal
  strand 路径并直接 snapshot `material_fsrs_state` 行，断言 `/api/review/due` 的输出
  在「有 / 无 active goals」下 **ids-SET / counts / due_at / fsrs_state 一致**——
  **ORDER 可因 goal 软偏置变化，故不再断言顺序逐字节一致**。它独家承载 **Coach 侧
  禁令**（runCoach 从不 UPDATE FSRS / 改 due）。其 fixture 含一个 off-goal overdue
  item，使软重排路径被真实执行（2026-07-07 修复：旧 fixture 全 goal-relevant →
  `rerankOverdueByGoals` 的 `others.length===0` 早退 → 重排恒 no-op、测试恒绿，
  order-only 维度从未被这个测试守到）。
- **`due-soft-bias.db.test.ts`（重排路径行为守卫）**：goal 软重排的真守卫——覆盖
  set / count / due_at 守恒 + **over-limit 命门 guard**（一个较不到期的 goal 相关
  item 绝不被拉进当页顶替更到期的 item，即 goal 不能抢占额度）+ 稳定分区 + off-safe。

改动 goal/Coach 路径若让任一测试变红 = 违反 ND-5，必须修生产代码而非改测试。

**多目标 strand 精力分配（spec §8 Q2，v0）**：`listActiveGoals` 按
`sequence_hint` then `created_at` 排序，全部喂进 Coach 输入；v0 分配策略 =
轮转 + 薄弱 scope 优先，作为 objective/prompt 里的**软指导**（模型挑），handler
不硬切额度。可调，留 hook。

**ND-5 标签用法消歧（A7 结算裁决，2026-07-07；不重编号）**：`ND-5` 标签已在三处以
不同外延被引用，**三义并存合法，追溯时按引用处上下文取义**；不另立编号（全仓 78 处
历史引用不回改）：

- **① 本 ADR 正主含义** = 北极星 goal 不得**抑制 / 挤占 / 改写** FSRS 复习（由上方
  conservation test 守卫）。
- **② `docs/agents/objectives.md` 引用** = proposal-only 破坏性操作的 owner 出处。
- **③ agentic lane specs（scout / meeting / reconcile 注释）中的 ND-5** = **结算账本
  写面禁令**（scout / agent 绝不直写 FSRS / θ̂ / `kc_typed_state` —— 结算层单写者由
  `tests/integration/step9-invariant-audit.test.ts` 的 fs-walker 机器强制，含
  `kc_typed_state`（`src/server/conjectures/typed-state.ts`）与 `learner_axis_state`
  （`src/server/calibration/axis-writer.ts`）两条断言）。

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
