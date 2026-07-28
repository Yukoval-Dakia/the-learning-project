# ADR-0050 — A13 问责轨死件清账（typed-state 结构死格 / prediction_score / hard-confirm / pedagogy palette / Planning Panel）

**Status**: Accepted；§(b) 已由 YUK-795 通电（2026-07-29）
**Decision source**: 清账诊断由 YUK-790 完成；**四条的处置由 owner 2026-07-25 当场拍板**——(a)(b)(d) 三条**推翻**了本票初稿的 DEFERRED / CLOSED 建议，改判**通电 / 现在接 / 要审议**，执行分别承接到 **YUK-794 / YUK-795 / YUK-796**。(c) 维持 deferred。
**Amends**: ADR-0049 §3（Q3 双读 reader 的「reconcile auto-mints」前提在**当前代码**下不成立——本 ADR 更正之，reader 本身保留；YUK-794 落地后该前提才真正成立）
**Related**: ADR-0046（Rust 数值核——原 FLIP-deferred 节奏被 (b1) 裁定**提前**）· ADR-0036 / design `docs/design/2026-07-01-misconception-promote-mechanism.md`（misconception promote/hard-confirm dark track）· `docs/design/2026-07-06-yuk572-agent-meeting-lane-spec.md` §0.C（anti-swarm single-director）· roadmap `docs/planning/2026-06-27-relationship-brain-roadmap.md`
**Refs**: YUK-790 · YUK-794 · YUK-795 · YUK-796 · YUK-406 · YUK-440 · YUK-505 · YUK-506

---

## 背景与本 ADR 的角色

A13 问责轨上有四条同型债（「建成不通电」/「结构死格」/「文档反向漂移」），此前散落在多轮审计里被反复重新发现。本 ADR 是它们的**单一台账**，承担两件事：

1. **诊断固化**——逐条的门槛分析（缺什么、为什么现在产不出、通电真正要动哪些面）。这部分是 YUK-794/795/796 三张执行票的价值来源，**必须保留**，不因裁定改变而删。
2. **裁定登记**——owner 2026-07-25 的处置，及其承接票。

> **读这份文档的人请注意裁定方向**：本票初稿曾建议 (a)(b)(d) 走「显式记 deferred」（依据是仓库「不建无消费者基建」的既有纪律）。**owner 当场推翻了三条**——理由是这三条不是「无消费者的投机基建」，而是 A13 问责回路**本身的承重段**：回路缺了它们就不闭合，「问责」二字落空。(c) 的 deferred 被维持，因为它确实是一个还没有消费者的 palette。

**唯一不受裁定影响、必须无条件成立的一条**：代码与文档不得互相矛盾。反向漂移（文档宣称一条当下不会发生的行为）在任何裁定下都是 bug——deferred 时它谎称「已通电」，通电前它同样谎称「已通电」。本 ADR 的文案对齐工作因此照常落地，只是措辞从「结构性恒空」改为「**待通电**」。

---

## (a) `kc_typed_state.typed_state='confused-with-X'` — 结构死格

### 实证（2026-07-25 复核，代码为准；**通电前仍然成立**）

> **引用规范**：本表是 YUK-794 的实证入口，故一律用**符号锚**（函数 / 常量 / 测试名）而非行号——本 PR 自身的注释改动就把原先写死的行号顶漂了一次，行号在这张表里必然会腐。定位请用 `grep -n '<符号名>'`。

| 事实 | 证据（符号锚，用 grep 定位） |
|------|------|
| reconcile 是 `upsertKcTypedState` 的**唯一生产调用者** | `src/server/conjectures/reconcile.ts` → `reconcileConjecturePredictions()` 内对 `upsertFn(db, {…})` 的调用（`upsertFn` 默认解析为 `upsertKcTypedState`）；全仓 grep `upsertKcTypedState` 其余命中全在 `*.test.ts` / 注释 |
| 它**硬编码** `confused_with_kc_id: null` | 同一 `upsertFn(db, {…})` 调用内的 `confused_with_kc_id: null` 字面量（紧邻注释自陈「Phase 0 supplies NO confused_with KC」）；`grep -n 'confused_with_kc_id: null' src/server/conjectures/reconcile.ts` |
| 唯一 gate 要求该字段为真才返回 `confused-with-X` | `src/server/conjectures/typed-state.ts` → `nextTypedState()` 的四项合取 `if`（`proposed==='confused-with-X' && discriminating && recurrence_count>=CONFUSED_WITH_RECURRENCE_FLOOR && confused_with_kc_id`） |
| `upsertKcTypedState` 是 `kc_typed_state` 的**单写者**，CI 锁死 | `tests/integration/step9-invariant-audit.test.ts` → 测试 `db.{insert,update}(kc_typed_state) appears only in src/server/conjectures/typed-state.ts (A7 settlement ledger)` |
| 诱导侧 schema **根本没有**这个字段 | `src/core/schema/proposal.ts` → `ConjectureProposalChange` 的字段列表无 `confused_with_kc_id` |

⇒ **在当前代码下 `typed_state='confused-with-X'` 的行不可能被产生。** 审计原措辞「reconcile 只记账」偏轻——不是「暂时没数据」，是**闭合的死格**。下游是**已通电但该分类恒空**的消费面：`observability/server/conjecture-scores.ts` → `loadConjectureScores()` 的第二个 query（`eq(kc_typed_state.typed_state, 'confused-with-X')`，admin 面板半边恒空）；`agency/scout/evidence-mcp.ts` 的 `get_typed_state` 工具仍会返回该 KC 已持久化的其它 typed-state 行（包括 `no-evidence`），但在 YUK-794 前不会读到由此轨产生的 `confused-with-X` 行。缺行/空 projection 与一条持久化的 `typed_state='no-evidence'` 行不是同一语义。

### 裁定：**owner 2026-07-25 — 要通电。执行见 YUK-794。**

（本票初稿建议 DEFERRED，被推翻。）

### 门槛分析（**保留，这是 YUK-794 的价值所在**）

通电**不是「放开 reconcile 的 null」**这么一行的事——这是本条最容易被误读的地方。真正要动的是四个面：

1. **扩 schema**：`ConjectureProposalChange` 加 `confused_with_kc_id`（当前完全没有这个字段，null 从哪来都没有）。
2. **改诱导 prompt**：让 LLM 在提猜想时**具名第二个 KC**（「他把 X 和 Y 搞混了」而不只是「他在 X 上有误解」）。
3. **加校验**：具名的 KC 必须真实存在（否则写进 `confused_with_kc_id` 的是幻觉 id，且该列**无 FK**——`typed-state.ts` 的 `retireKcTypedStateOnMerge()` docblock 自陈「the pointer is a soft display ref, no FK / no unique on it」，`schema.ts` 的 `kc_typed_state` 定义亦注明「loose text ref to knowledge.id, no FK」，脏值不会被数据库挡住）。
4. **才轮到**放开 `reconcileConjecturePredictions()` 里那个硬编码的 `confused_with_kc_id: null`。

**gate 不要放开**：§修正-4 的四项合取（判别探针 + recurrence≥2 + 具名 KC）是刻意的保守设计——单次探针失败可能是该误解、也可能是无关原因。通电的正确做法是**补上「具名 KC」这个缺失的输入**，而不是把「要求具名」这个条件删掉。删条件等于把「未具名的混淆」当「已确认的混淆」写进结构态，正是这条轨要防的事。

**质量风险须在 YUK-794 内正面处理**：n=1 场景下接受「LLM 的跨 KC 归因」作为结构事实是有代价的。YUK-794 有硬前置（等 YUK-786 grounding），不要绕过。

### 验收对偶

通电落地时，须有 db.test 真产出一行 `typed_state='confused-with-X'`；**在那之前**，下述文案必须保持「待通电」而非「已自动铸出」。

---

## (b) `prediction_score` / hard-confirm — **已通电（YUK-795）**

> 下面保留 2026-07-25 的诊断作为决策依据；当前事实以“落地”段为准。

### (b1) `experimental:prediction_score`

- 生产者：`reconcile.ts` → `reconcileConjecturePredictions()` 写 `PREDICTION_SCORE_ACTION`。
- **有活的观测消费者**：`loadConjectureScores` 读它 → `GET /api/admin/conjecture-scores` → admin UI 表格（ADR-0049 §3 (a)）。
- **YUK-795 前无行为消费者**：score 不改变后续候选顺序。

**裁定：owner 2026-07-25 — 现在接 FLIP 消费者，不等 ADR-0046 的 Rust 节奏。执行见 YUK-795。**
（本票初稿建议 DEFERRED「dark 观测账本」，被推翻。owner 的理由：不接，则「预测被证伪」这件事对 conjecture 的命运毫无影响，A13 的「防编造缝」就只是个仪表盘。）

**YUK-795 落地规则（n=1、纯 ordinal、无群体拟合）**：

1. `skill_score_point > 0` 为 hit，`< 0` 为 miss，`= 0` 为 neutral；按
   `probe_result_event_id` 去重，correction/dependency-inactive 的来源不进入 fold。
2. 同一 owner 的 `(cause_category × knowledge_id)` 身份跨再归纳累计；单条 miss
   不改变排序。最新连续两条 miss → `downweighted`（0.25×）；连续两条 hit →
   `supported`（1.15×）；mixed/neutral/不足两条 → `watch`（1.0×）。后续相反
   streak 可以反转。
3. `research_meeting_nightly` 在 evidence cell 的 top-K 截断**前**读取并重排，
   因此 score 已真实改变下一次 conjecture 的生存/曝光，而不是只在 admin 表里展示。
4. honest Rust window mean 仍 deferred；本规则只消费单点 score 的符号，不写
   mastery、typed-state 或 FSRS。

### (b2) `hard-confirm.ts` + `misconceptionHardConfirmEnabled()`

- YUK-795 前，`src/server/conjectures/hard-confirm.ts` 与
  `misconceptionHardConfirmEnabled()` 均无生产 caller。
  **（注意区分，别修错文件）**：同文件 `misconceptionPromoteEnabled()` :76 **有**活 caller（`conjecture-accept.ts:167`）。只有 hard-confirm 那一半是暗的。
- 设计出处：`docs/design/2026-07-01-misconception-promote-mechanism.md` §2（Tier 1 刻意 ship dark，soft→hard 翻转永远需要 owner 当刻新确认，绝不自动）——**这条红线在通电后依然有效**，通电指的是接上调用点，不是取消 owner 确认。

**裁定：owner 2026-07-25 — 同 (b1)，并入 YUK-795 一并通电。**
（本票初稿建议 knowingly-deferred，被推翻。）

**YUK-795 落地**：`loadPredictionAccountabilityByKey()` 批量读取有效 score，
调用 `summarizeDissociation()` / `decideDissociation()`，并把
`INSUFFICIENT/EMERGING` 消费进 rank multiplier（hard flag 开启时，
`EMERGING` 的持续命中为 1.25×；flag 关闭仍保持基础 1.15×）。
这是真实 nightly caller，不再是 test-only export。

`MISCONCEPTION_HARD_CONFIRM_ENABLED` 继续默认 OFF，理由不是 defer 问责，而是两条
仍未满足的诚实门：当前 Judge 没有明确 `target_error_match`，且 soft→hard 必须
owner 当刻新确认。nightly caller 强制 `ownerFreshlyConfirmed=false`，所以即使 flag
误开也不能执行 hard mutation；它只能看到 `EMERGING`。不得把普通答错冒充
M-diagnostic，也不得把后台 job 冒充 owner 确认。flag ledger 已同步为 live caller。

---

## (c) 教学法 8 法 palette — 零 caller

`src/core/pedagogy/method-library.ts` + `policy.ts` + `index.ts`：全仓命中**只在模块内 + 两个 unit test**，零外部 importer（`grep "core/pedagogy"` 在 `src/ server/ scripts/ web/` 下除自身目录外零命中）。单 commit `37a37aeb` 自陈 wiring deferred。归属 issue：**YUK-506**。

### 裁定：**DEFERRED（knowingly-deferred）——owner 2026-07-25 维持本票判断。**

四条里唯一未被推翻的一条。与 (a)(b) 的区别很清楚：(a)(b) 是**已建回路的断口**（补上就闭合），(c) 是一个**还没有消费者的候选 palette**——它的消费者形态本身还没定。

**指向 YUK-796**：palette 的去留不由本 ADR 终裁。YUK-796（审议能力重新立项，设计先行）会连带重新评估它的**复用 / 重构 / 废弃**——「教学法选择」正是该设计票的题面之一。在 YUK-796 出设计前，palette 保持原样、不接线、不删除。

**明确不注册 `*_ENABLED` flag**——理由是机制性的，不是偷懒：`audit:flags` 的对账是**双向**的，ledger 每条都要求其 `file` 里存在该 flag 名的**活 token**（`scripts/audit-flags.ts` `reconcileFlags` → STALE `name-missing`）。palette 里没有任何 runtime 判定点可以承载这个 token；硬塞一个只为登记而存在的 flag 会**立刻**制造一条 STALE 发现，即「为了让审计变绿而弄脏审计」。palette 是纯数据 + 纯函数，没有可 gate 的运行时路径——**它的台账就是本 ADR 本条 + 模块头注释**。等 YUK-796 定了消费者形态、真接线时，再按 A5 dark-ship 纪律在**真正的消费点**登记闸门 flag。

---

## (d) Planning Panel 审计线

- 全仓零代码命中（`planning_panel` / `planning-panel` 仅出现在 design/planning/audit **文档**里）。
- 运行时拓扑是**既决约束**：single-director + 至多一名条件性侦察兵（anti-swarm）。约束点：`docs/design/2026-07-06-yuk572-agent-meeting-lane-spec.md` §0.C（深度封顶为真结构性）、`src/ai/registry.ts:1706` director prompt 内「【anti-swarm】你是单一决策者 + 至多一名条件性侦察兵」、`src/server/agency/scout/scout-agent.unit.test.ts`（AgentDefinition 结构性 pin：scout 无 `Task`）。
- 2026-06-18 的 fan-out panel 规格（`docs/superpowers/specs/2026-06-18-jiaoyantuan-deliberative-panel-design.md`）与之冲突；`docs/audit/2026-07-16-drift.md` 已记该冲突。

### 裁定：**owner 2026-07-25 — 要审议能力。形态待设计，执行见 YUK-796（设计先行，不是实现票）。**

（本票初稿建议「审计线 CLOSED，不新建」，被推翻。差别很实：CLOSED 意味着「这条路封了」，而 owner 的意思是「**这条路要走，但不能用 2026-06-18 那个会破 anti-swarm 的走法**」。）

两条约束同时成立，YUK-796 的设计必须同时满足：

1. **不破 single-director anti-swarm 契约**——2026-06-18 的 A/B planner + critic + judge fan-out 形态作为**运行时方案**不可直接采用。
2. **不越 P0 Stop Signal**——在 grounding 修复与盲评通过前，不把教学法脑接到该输入上。所以 YUK-796 是设计票，出设计后才谈实现。

既有设计文档保留作历史留档，不删除。roadmap 中 YUK-505 行同步改写为「重新立项，设计先行（YUK-796）」。

---

## 台账速查

| 条目 | 裁定（owner 2026-07-25） | 承接票 | 台账位置 |
|------|--------------------------|--------|----------|
| (a) `typed_state='confused-with-X'` | **要通电**（推翻初稿 DEFERRED） | **YUK-794** | 本 ADR §(a)（含门槛四面分析）+ 各文件头注释 + 面板「本轨待通电」标注 |
| (b1) `prediction_score` | **现在接** FLIP 消费者，不等 Rust 节奏（推翻初稿 DEFERRED） | **YUK-795** | 本 ADR §(b1) |
| (b2) hard-confirm 轨 | **同上，并入 YUK-795**（推翻初稿 knowingly-deferred） | **YUK-795** | 本 ADR §(b2) + `scripts/audit-flags-ledger.json` → `MISCONCEPTION_HARD_CONFIRM_ENABLED.notes` |
| (c) pedagogy 8 法 palette | **DEFERRED**（维持本票判断）；**刻意不注册 flag**（会造 STALE）；去留由 YUK-796 设计重评 | YUK-506 → 重评于 **YUK-796** | 本 ADR §(c) + `method-library.ts` 头注释 |
| (d) Planning Panel | **要审议能力**，形态待设计（推翻初稿 CLOSED） | **YUK-796** | 本 ADR §(d) + `docs/audit/2026-07-16-drift.md` + roadmap YUK-505 行 |

## 通电前的文案纪律（本 ADR 一并落地，与裁定方向一致）

三张执行票各有硬前置（794 等 YUK-786 grounding、795 等 YUK-787 证据强度纪律、796 先出设计），**通电不是立刻发生的**。在那之前：

- 面板/工具/文档一律标 **「本轨待通电（YUK-794）」**，**不得**写成「reconcile 会自动铸出」（那是通电后才成立的未来时，写在现在就是反向漂移）；
- 也**不得**写成「结构性恒空 / 不会铸出」——裁定通电后，这条同样是错的方向；
- `get_typed_state` 对夜间 director 的**硬警告保留**：当前的空返回**不得**被推断为「学习者没混淆」。这条在通电前后都成立，是本轮抓到的要害。

修正覆盖面（共 8 处，全部写全路径以便 grep）：`src/capabilities/observability/server/conjecture-scores.ts`、`src/capabilities/observability/ui/conjecture-scores.tsx`、`src/capabilities/observability/api/conjecture-scores.ts`、`src/capabilities/observability/manifest.ts`、`src/capabilities/observability/AGENTS.md`、`src/server/agency/scout/evidence-mcp.ts`、`docs/runbooks/conjecture-wire.md`、`docs/adr/0049-conjecture-wire-dark-loop-producer-consumer.md`。
