# ADR-0050 — A13 问责轨死件清账（typed-state 结构死格 / prediction_score / hard-confirm / pedagogy palette / Planning Panel）

**Status**: Accepted (YUK-790，基线 `origin/main = 0c9a3336`)
**Amends**: ADR-0049 §3（Q3 双读 reader 的「reconcile auto-mints」前提在 Phase 0 **不成立**——本 ADR 更正之，reader 本身保留）
**Related**: ADR-0046（Rust 数值核——FLIP 消费者 deferred）· ADR-0036 / design `docs/design/2026-07-01-misconception-promote-mechanism.md`（misconception promote/hard-confirm dark track）· `docs/design/2026-07-06-yuk572-agent-meeting-lane-spec.md` §0.C（anti-swarm single-director）· roadmap `docs/planning/2026-06-27-relationship-brain-roadmap.md`
**Refs**: YUK-790 · YUK-406 · YUK-440 · YUK-505 · YUK-506

---

## 背景

A13 问责轨上有四条同型债（「建成不通电」/「结构死格」/「文档反向漂移」），此前散落在多轮审计里被反复重新发现。本 ADR 是它们的**单一台账**：逐条给 **wired / deferred** 裁定 + 理由，使下一轮审计能直接对账而不是重新考古。

裁定基调延续仓库既有纪律：**「不建无消费者基建」**——所以 deferred 是合法终态，不是待办；但**代码与文档必须自洽**，反向漂移（文档宣称一条实际不可能发生的行为）不是 deferred，是 bug。

---

## (a) `kc_typed_state.typed_state='confused-with-X'` — **结构死格**

### 实证（2026-07-25 复核，代码为准）

| 事实 | 证据 |
|------|------|
| reconcile 是 `upsertKcTypedState` 的**唯一生产调用者** | `src/server/conjectures/reconcile.ts:263`；全仓 grep 其余命中全在 `*.test.ts` / 注释 |
| 它**硬编码** `confused_with_kc_id: null` | `reconcile.ts:267`（注释自陈「Phase 0 supplies NO confused_with KC」） |
| 唯一 gate 要求该字段为真才返回 `confused-with-X` | `src/server/conjectures/typed-state.ts:49-63`（§修正-4 gate 四项合取） |
| `upsertKcTypedState` 是 `kc_typed_state` 的**单写者**，CI 锁死 | `tests/integration/step9-invariant-audit.test.ts:218-227` |
| 诱导侧 schema **根本没有**这个字段 | `src/core/schema/proposal.ts:496-514` `ConjectureProposalChange` 无 `confused_with_kc_id` |

⇒ **在当前代码下 `typed_state='confused-with-X'` 的行结构性不可能被产生。** 审计原措辞「reconcile 只记账」偏轻——不是「暂时没数据」，是**闭合的死格**。

### 裁定：**DEFERRED（显式承认 Phase 0 不产该态）**

理由：

1. **gate 本身是对的，不该放开。** §修正-4 的保守性（判别探针 + recurrence≥2 + 具名 confused-with KC）是刻意设计：单次探针失败可能是该误解、也可能是无关原因。放开 `null` 会把「未命名」误当「已确认」，正是这条轨要防的事。
2. **缺的不是接线，是产品输入。** 诱导侧 schema 无 `confused_with_kc_id`（上表末行）。通电要 (i) 扩 `ConjectureProposalChange`、(ii) 改诱导 prompt 让 LLM 具名第二个 KC、(iii) 校验该 KC 存在、(iv) 接受「LLM 的跨 KC 归因」作为结构事实。这是**产品判断 + n=1 下的真实质量风险**，不是清账能顺手做的事 → 保持 owner-gated（见下「留给 owner 的决定」）。
3. 消费面已建且应保留：`conjecture-scores` reader 是**刻意的 reader-before-producer**（ADR-0049 §3 红线），先建 reader 不是 bug；错的只是它的**文案**。

### 必须修的（本 ADR 一并落地）：文档—代码反向漂移

以下位置此前**宣称 reconcile 会自动铸出该态**，与代码矛盾，会持续误导 owner 读盘与后续审计（本轮 reground 亦几乎被带偏）。全部改为「Phase 0 该轨未通电」：

- `src/capabilities/observability/server/conjecture-scores.ts`（文件头 + 类型注释 + `loadConjectureScores` docblock）
- `src/capabilities/observability/ui/conjecture-scores.tsx`（文件头 / `PageHeader.sub` / typed-states 栏空态与栏头徽标）
- `src/capabilities/observability/api/conjecture-scores.ts` 文件头
- `src/capabilities/observability/manifest.ts` route 注释
- `src/capabilities/observability/AGENTS.md`
- `src/server/agency/scout/evidence-mcp.ts` `get_typed_state` 的**工具描述**（对夜间 director 的承诺——Phase 0 恒返 `no-evidence`，须直说）
- `docs/runbooks/conjecture-wire.md` 排障 SQL 注释
- `docs/adr/0049-...md` §3（本 ADR 的 amend 指针）

**验收对偶**：若将来判「通电」，须有 db.test 真产出一行 `typed_state='confused-with-X'`；在此之前上述文案不得回退。

---

## (b) `prediction_score` / hard-confirm — 零**行为**消费者

### (b1) `experimental:prediction_score` — **wired as observation, dark as behavior（设计如此）**

- 生产者：`reconcile.ts:276-307`，自陈 LOG ONLY / FLIP-inert。
- **有活消费者**：`loadConjectureScores` 读它 → `GET /api/admin/conjecture-scores` → admin UI 表格（ADR-0049 §3 (a)）。所以它**不是**零消费者——是「零**行为**消费者」。
- **行为消费者（score → flip 标签）按 ADR-0046 归 Rust 数值核，明确 deferred。**

**裁定：DEFERRED（dark 观测账本，无行为消费者是设计）。** 不通电、不改。审计再遇到请对照本条，不重开。

### (b2) `hard-confirm.ts` + `misconceptionHardConfirmEnabled()` — **knowingly-deferred（Tier-1 暗轨）**

- `src/server/conjectures/hard-confirm.ts` 全部导出零生产 caller（仅 `hard-confirm.unit.test.ts` / `hard-confirm.db.test.ts`）；文件头已自陈 dark。
- 其闸门 `misconceptionHardConfirmEnabled()`（`src/capabilities/agency/server/misconception-promote.ts:89`）**零生产 caller**、默认 OFF。
  （注意区分：同文件 `misconceptionPromoteEnabled()` :76 **有**活 caller —— `conjecture-accept.ts:167`。只有 hard-confirm 那一半是暗的。）
- 设计出处：`docs/design/2026-07-01-misconception-promote-mechanism.md` §2 —— Tier 1 **刻意** ship dark，soft→hard 翻转永远需要 owner 当刻新确认，绝不自动。

**裁定：DEFERRED（knowingly-deferred，先建判定逻辑后接调用点是刻意顺序）。** flag 已在 `scripts/audit-flags-ledger.json` 登记，本 ADR 只把「零 caller 是设计」写进其 `notes`，不新增 flag、不接线。

---

## (c) 教学法 8 法 palette — 零 caller

`src/core/pedagogy/method-library.ts` + `policy.ts` + `index.ts`：全仓命中**只在模块内 + 两个 unit test**，零外部 importer（`grep "core/pedagogy"` 在 `src/ server/ scripts/ web/` 下除自身目录外零命中）。单 commit `37a37aeb` 自陈 wiring deferred。归属 issue：**YUK-506**（roadmap 记「安全脊柱 IN PROGRESS，panel-SELECT / B5 接线仍 deferred」）。

**裁定：DEFERRED（knowingly-deferred）。**

**明确不注册 `*_ENABLED` flag**——理由是机制性的，不是偷懒：`audit:flags` 的对账是**双向**的，ledger 每条都要求其 `file` 里存在该 flag 名的**活 token**（`scripts/audit-flags.ts` `reconcileFlags` → STALE `name-missing`）。palette 里没有任何 runtime 判定点可以承载这个 token；硬塞一个只为登记而存在的 flag 会**立刻**制造一条 STALE 发现，即「为了让审计变绿而弄脏审计」。palette 是纯数据 + 纯函数，没有可 gate 的运行时路径——**它的台账就是本 ADR 本条 + 模块头注释**。等 B5 / panel-SELECT 真接线时再按 A5 dark-ship 纪律登记闸门 flag。

---

## (d) Planning Panel 审计线 — **CLOSED，不新建**

- 全仓零代码命中（`planning_panel` / `planning-panel` 仅出现在 design/planning/audit **文档**里）。
- 运行时拓扑已是**既决事项**：single-director + 至多一名条件性侦察兵（anti-swarm）。约束点：`docs/design/2026-07-06-yuk572-agent-meeting-lane-spec.md` §0.C（深度封顶为真结构性）、`src/ai/registry.ts:1706` director prompt 内「【anti-swarm】你是单一决策者 + 至多一名条件性侦察兵」、`src/server/agency/scout/scout-agent.unit.test.ts`（AgentDefinition 结构性 pin：scout 无 `Task`）。
- 2026-06-18 的 fan-out panel 规格（`docs/superpowers/specs/2026-06-18-jiaoyantuan-deliberative-panel-design.md`）与之冲突；`docs/audit/2026-07-16-drift.md` 已记该冲突并建议「先修 YUK-505 再接线」。

**裁定：审计线 CLOSED——以 single-director 为准，YUK-505 的 fan-out 形态作为运行时方案被取代。** 不新建 Planning Panel，不删除既有设计文档（历史留档）。roadmap 中 YUK-505 行同步改写为本裁定。后续若 owner 仍要审议能力，须以**不破 anti-swarm 的形态**重新立项，届时另开 ADR。

---

## 台账速查

| 条目 | 裁定 | 台账位置 | 归属 issue |
|------|------|----------|-----------|
| (a) `typed_state='confused-with-X'` | **DEFERRED** — Phase 0 不产该态；文案全面对齐 | 本 ADR §(a) + 各文件头注释 + 面板「本轨未通电」标注 | YUK-440 / YUK-790 |
| (b1) `prediction_score` | **DEFERRED** — dark 观测账本；有观测消费者、无行为消费者（设计） | 本 ADR §(b1) + ADR-0046 | YUK-440 |
| (b2) hard-confirm 轨 | **DEFERRED** — knowingly-deferred 暗轨 | 本 ADR §(b2) + `scripts/audit-flags-ledger.json` → `MISCONCEPTION_HARD_CONFIRM_ENABLED.notes` | YUK-406 |
| (c) pedagogy 8 法 palette | **DEFERRED** — knowingly-deferred；**刻意不注册 flag**（会造 STALE） | 本 ADR §(c) + `method-library.ts` 头注释 | YUK-506 |
| (d) Planning Panel | **CLOSED** — single-director 既决，不新建 | 本 ADR §(d) + roadmap YUK-505 行 | YUK-505 |

## 留给 owner 的决定（本 ADR 不代拍）

1. **(a) 是否要在 Phase 1 真通电 `confused-with-X`**：需扩 `ConjectureProposalChange` + 诱导 prompt 具名第二 KC + 校验 + 接受 LLM 跨 KC 归因的质量风险。本 ADR 只裁「Phase 0 不产、文案必须诚实」，**未**裁「永不产」。
2. **(b1) 何时把 FLIP 消费者接上**：绑 ADR-0046 Rust 数值核节奏，非本票范围。
3. **(d) 是否仍要审议能力**：若要，须以 single-director 兼容形态重新立项。
