# conjecture-engine-dark-loop — owner decision material（重接地 @ main 0291987e）

来源任务：master register `conjecture-engine-dark-loop`（约 line 318-329，verdict=DEFER）。本文档不重跑对抗，只对 main@0291987e 重接地 + 补一份 register 未见过的新耦合证据，产出 one-page wire/retire/第三路骨架。

**文献纪律说明**：本轮不引入新外部文献主张——外部基线（CDM/proper-scoring/CAT throughput 文献）沿用 register Appendix A 已完成的三方对抗验证结果（该轮已标注 venue/引用量/UNVERIFIED 旗标，见 register 原文）。本文档新增内容全部是**代码重接地**（file:line）+ **两份 2026-07-01 doc 间的张力发现**，非文献判断。

---

## 0. 三行结论

1. **两份 2026-07-01 doc 对同一问题给出不一致的紧迫度信号**：`misconception-model-investigation-and-implementation.md` 把 probe-resolution loop 叫 "Phase 1 = THE 90%"（现在做），`misconception-promote-mechanism.md` §4/§9 把 reconcile.ts:268 决策叫"正交、单独 follow-up、待 owner 拍"（不预设方向）。Register 的 DEFER verdict 只对齐了后者。
2. **新耦合证据（register 未见过）**：2026-07-01 新落地的 `hard-confirm.ts`（YUK-531 S4 RT1，dark）的**唯一**证据源是 `experimental:prediction_score` 事件——而该事件**唯一**写者是 `reconcile.ts`，`reconcile.ts` 的唯一输入是 `probe-lifecycle.ts` 的产出。**Retire probe-lifecycle ⇒ hard-confirm.ts 永久不可达（不是"暗"，是死代码）**——这条链条式依赖是 register verdict 定稿时未追踪到的新增量成本。
3. Owner 目前**没有任何活的路径**能铸造一个 `source='hard'` misconception（soft mint 是唯一活路径；authored-n=0-seam 与 probe-B-live 两条候选路径都是 0% 接线）——这是三个选项的共同起点，不因选哪个而改变。

---

## 1. 代码重接地（file:line，均核对于本次 session 的 main 树）

- **Producer 零生产 caller**：`serveProbeOnce`/`answerProbe`（`src/capabilities/agency/server/conjecture/probe-lifecycle.ts:120,203`）——`grep` 全仓，非测试引用只有 docstring/注释提及（`prep-desk.ts:23` 引用未来时"serving happens on accept via serveProbeOnce"，`conjecture-accept.ts` 实际未调用）。`acceptConjectureProposal`（`conjecture-accept.ts:90-183`）事务体内**没有** `serveProbeOnce` 调用——注释说"accept 只铸 soft misconception，probe 是后续 task"，但该"后续 task" origin/main 至今未接。
- **Consumer 活但输入恒空**：`reconcileConjecturePredictions`（`src/server/conjectures/reconcile.ts:204`）被 `research_meeting_nightly.ts:191,198` 真实调用，`research_meeting_nightly` job 已在 `src/capabilities/agency/manifest.ts:65-69` 注册进组合根（cron，非手动）。因 producer 零调用，`defaultListUnscoredProbeResults`（`reconcile.ts:137`）永远查到 0 行——nightly job 每晚跑一次 no-op 扫描。
- **两条相互矛盾的验收判据，逐字核对属实**：
  - Pool-invisibility：`probe-lifecycle.ts:8-12` 注释 + 代码 `draft_status: 'draft'`（`probe-lifecycle.ts:150`），由 `due-list.ts:236` `notDraftQuiz = or(isNull(draft_status), ne(draft_status,'draft'))` 排除出**所有**复习池。
  - Reuse-attempt-path：`docs/planning/2026-06-27-relationship-brain-roadmap.md:55`（U3 行）原文明确写"probe 必须走既有 practice/attempt 答题路径，不另起 UI"。
  - 两者字面不可共存：走既有 attempt/due-list 路径 ⇒ 题必须对 due-list 可见（违反 pool-invisibility invariant #1）；或需要在 attempt 路径内部特判"这题是 draft 但仍可答"，那样又会触发 attempt 路径默认写 FSRS 的副作用（违反 invariant #3 ND-5，`probe-lifecycle.ts:20-25` 明令"NEVER writes FSRS"）。**没有字面上都满足两条判据的实现**——这是 register 已发现、本次直接复核为真的结论，非新发现。
- **新发现：`discriminating` 事实在 reconcile 写 log 时被静默丢弃**。`reconcile.ts:250` 用 `facts.discriminating` 驱动 `upsertKcTypedState`（`reconcile.ts:269`），但 `reconcile.ts:277-308` 写 `experimental:prediction_score` 事件的 payload **不含** `discriminating` 字段。`hard-confirm.ts` 的 `predictionScoreToRecord`（`hard-confirm.ts:300-354`）读 `payload.discriminating`/`payload.m_diagnostic`（`hard-confirm.ts:349-350`），两者永远读不到 `discriminating`（字段不存在于 payload）、`m_diagnostic` 也无任何写者（`hard-confirm.ts:296-298` 自己注释承认"live reconcile loop 尚未 stamp 它们…这是刻意的 DARK 行为"）。**即便现在就把 producer 接活**，`hard-confirm.ts` 的判别门仍会因这两个缺失字段永远返回 `INSUFFICIENT`——需要额外补两处写路径，不是"接上 producer 就活"。
- **`decideDissociation`/`gatherDissociationEvidence` 零生产调用**（`grep` 确认，仅 `hard-confirm.unit.test.ts`/`hard-confirm.db.test.ts` 引用）——`hard-confirm.ts` 本身 100% dark，与其 docstring 自陈一致。
- **`hasRivalProbe` 无任何计算逻辑**：`decideDissociation`（`hard-confirm.ts:237`）把它当外部布尔参数吃入，全仓无一处代码计算"池中是否存在能分离 M vs 对手 M′ 的 probe"——这是 wire 路径必须新建的第三块缺失能力（前两块是 UI + 两个 payload 字段）。
- **Authored-hard n=0 seam 同样 0% 接线**：`promoteConjectureToMisconception`（`misconception-promote.ts:157`）签名已支持 `source?: 'hard'|'soft'`（`:129`），但其唯一生产调用者 `conjecture-accept.ts:172` 从不传 `source:'hard'`（`grep` 全仓确认零处 `source: 'hard'` 的调用点）。`misconception-promote-mechanism.md` §9 决策项 2 把它列为"owner 才能拍"的候选权限，尚未拍板也未接线。

---

## 2. 两份 2026-07-01 doc 的张力（register 未捕获的新发现）

| | `misconception-model-investigation-and-implementation.md` | `misconception-promote-mechanism.md` |
|---|---|---|
| 对 probe-loop 的态度 | §10-11 Phase 1 明确点名"probe-resolution loop"是"**THE 90%**"、"优先做"（`:198-199` 一节标题即"THE 90%") | §4："reconcile.ts:268 死 ledger = **正交技术债**……单独 follow-up，明确不在 promote 机制 scope 内" |
| 对"现在做不做"的立场 | 隐含"尽快"（Phase 排序把它排第一） | §9 决策项 3 列为待拍板的开放问题，无立场 |
| 对 promote 机制本身的依赖 | 未展开区分 | §4 明确："promote 机制**不依赖**修 reconcile.ts:268"（但仍依赖 probe_result/prediction_score 事件本身存在——即仍依赖 producer 被接活，只是不依赖 :268 的 confused_with_kc_id 具体修法） |

Register 的 DEFER verdict 引用的是 `misconception-promote-mechanism.md`（"per 2026-07-01 misconception-promote-mechanism.md §4/§8/§9…wire vs retire left as an open owner question"），**没有对齐** `misconception-model-investigation-and-implementation.md` 把同一件事叫"THE 90%"的更强立场。两份 doc 都是 2026-07-01 owner 材料，权重应视为同级——这本身就是需要 owner 拍板厘清的一层，不是本文档能替 owner 决定的。

---

## 3. 三选项骨架

### Option A — WIRE（把 producer 接进一条真实的、owner 发起的 probe-answer 流程）
- **要做的（不是"接上开关"，是一个中等竖切）**：
  1. 新建**独立的** probe-answer UI/端点（不复用 due-list/attempt 路径——上面已证明字面复用与两条 invariant 冲突；这等于**推翻** roadmap.md:55 的"不另起 UI"字面指示，需要 owner 明确认可这个推翻）。
  2. `reconcile.ts` 写 `prediction_score` payload 时补 `discriminating`（已有 fact，只是没转发）+ 新建 `m_diagnostic` 判定能力（当前全仓无一处写者，是一块新的 judge 侧能力）。
  3. 新建 `hasRivalProbe` 的判定逻辑（当前是外部参数，无计算实现）。
- **收益**：解锁 `misconception-model-investigation-and-implementation.md` 点名的"Phase 1 THE 90%"（kc_typed_state 的 confused-with-X 轴首次可点亮）；同时让已 dark-ship 的 `hard-confirm.ts` Tier-1 机制首次有路径可达 `HARD_CONFIRM`（而不是永久性死代码）。
- **代价/风险**：三块新建能力（UI + 两个 payload 字段 + rival-probe 判定），非"翻 flag"量级；n=1 owner-paced 吞吐量下（≤3 并发 probe + 夜间节奏）register 已引用的外部基线（CDM/proper-scoring 需要重复测量吞吐）仍成立——即便现在接上，短期内也只是涓流证据，不会立刻让 `HARD_CONFIRM` 大量触发。

### Option B — RETIRE（正式退休 producer + consumer，文档化决策，job 停跑该段）
- **要做的**：`research_meeting_nightly.ts` 移除 `reconcileFn` 调用（或整段跳过并注释原因）；`probe-lifecycle.ts`/`reconcile.ts` 保留代码但标记 deprecated（或走既有 allowlist 机制归档）；`kc_typed_state` 的 confused-with-X 轴永久停在 `no-evidence`（`misconception-promote-mechanism.md` §9 决策项 3 的"退休"分支）。
- **收益**：去掉一个"每晚空跑"的认知负担；不再欠一个"字面无法两全"的验收判据债。
- **代价（本文档的核心新发现）**：**永久性锁死 `hard-confirm.ts`**——它的唯一证据源（`prediction_score` 事件）从此再无写者，Tier-1 dissociation 门变成不可能被满足的死代码，而不是当前"暗但可达"的状态。同时**直接反转** `misconception-model-investigation-and-implementation.md` 明示的"Phase 1 = THE 90%"建议——按 CLAUDE.md「反转此前建议前先核对用户原始诉求」的纪律，这个反转需要 owner 显式确认，不能作为本文档的默认落点。

### Option C — 第三路：降级为「misconception 专用、owner 发起」的 probe 工具（缩窄 scope，非通用关系脑循环）
- **构型**：不做通用"conjecture engine 夜间自主 serve"，改成**owner 在一张 soft misconception 卡片上主动点「测一下我是否还持有」**才触发单次 `serveProbeOnce`；`answerProbe` 判分后直接喂 `hard-confirm.ts`（本来就是它的姊妹设计）而不是回灌泛用的 `kc_typed_state` 混淆轴。
- **为什么这条路更贴合当前证据**：
  - 天然解掉 pool-invisibility vs reuse-attempt-path 矛盾——owner 发起的单题不需要经过 due-list/attempt 通用路径，本来就该是独立小 UI（不用推翻 roadmap.md:55，因为这条路径压根不再自称"关系脑夜间自动循环"的一部分，是范围更窄的新特性）。
  - 直接对齐 `misconception-model-investigation-and-implementation.md` 的"B-live + authored 缝"收口——probe 循环被点名为 B-live 半边的**唯一**实现路径（`misconception-model-investigation-and-implementation.md:12`），第三路让它专职服务这半边，而不是继续背负泛用"conjecture engine"的定位。
  - 天然规避"trickle noise"的外部基线顾虑——owner-发起、owner-节奏，不是自主背景累积，与 register 外部基线批注（"at this system's realistic volume even a wired producer yields trickle noise"）的顾虑正交。
- **仍要做的（比 A 略窄，但没有更便宜）**：同样需要新 UI（但范围更小——从"soft misconception 卡片"发起，不需要 due-list 集成）+ `discriminating`/`m_diagnostic` 两个 payload 字段 + rival-probe 判定（Tier-1 hard-confirm 三个缺口在这条路上原样存在，因为 hard-confirm.ts 的证据结构不因触发方式改变）。
- **代价**：`kc_typed_state` 的 confused-with-X 轴仍需 Option B 同款的独立决策（这条路不喂它了，需明确"退休"或另起）；`research_meeting_nightly` 的 reconcile 段仍需拆解或改造（不能保留"泛用夜间循环"框架不变）。

---

## 4. 三选项与两个待决问题的耦合矩阵

| | A wire | B retire | C 降级 misconception-only |
|---|---|---|---|
| 解锁 `hard-confirm.ts` Tier-1 | ✓（需补两字段+rival-probe） | ✗ 永久锁死 | ✓（同样需补两字段+rival-probe，且是它的原生用途） |
| 解锁 kc_typed_state confused-with-X | ✓ | ✗ 永久停 no-evidence | ✗（除非另起支线喂它，本设计未含） |
| 需要推翻 roadmap.md:55"不另起 UI" | 是，需 owner 确认 | 不适用 | 否——本就是新特性，不自称沿用 roadmap U3 通用路径 |
| 反转"Phase1=THE 90%"建议 | 否（执行它） | 是，需 owner 确认 | 部分——执行其 B-live 精神但缩小 scope，非字面 Phase 1 |
| 夜间 no-op job 成本 | 消失（有输入后） | 消失（移除调用） | 消失（不再是夜间循环，owner 发起） |
| 新建能力量级 | 中（UI+2 字段+rival-probe） | 零 | 中（范围更小的 UI + 同 2 字段 + rival-probe） |

---

## 5. 待 owner 拍板的问题（本文档不代拍）

1. 两份 2026-07-01 doc 的立场差异（"THE 90%" vs "正交待决"）——哪份代表当前真实意图？
2. A / B / C 三选一，或 C 的变体（例如 C + 之后再决定要不要另起支线喂 kc_typed_state）？
3. `misconception-promote-mechanism.md` §9 决策项 2（authored-hard n=0 seam）要不要同步接线——它是与 probe-B-live 完全独立的第二条 hard-confirm 入口，目前也是 0% 接线，可以独立于本决策先行/并行推进。
