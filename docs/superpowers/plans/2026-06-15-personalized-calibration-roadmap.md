# Personalized Calibration + Urnings-Lite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the current B1-W1 `theta_hat + item_calibration.b` model into a reliable personalized calibration and selection stack: observable MFI, theta uncertainty, randomized selection with persisted inclusion probability, family-level personalized difficulty, active-PPI recalibration, and a final Urnings/full-model decision gate.

**Architecture:** Keep ADR-0042/0043 intact: FSRS remains the R/when owner; `mastery_state` remains the p(L)/theta diagnostic owner; `item_calibration` remains the difficulty anchor. Add uncertainty and sampling metadata before changing selection behavior. Do not let a single learner's online loop freely co-estimate `theta` and item `b`; promote `b` only through slow, labeled, auditable calibration.

**Tech Stack:** TypeScript, Drizzle/Postgres, Vitest unit/db tests, pg-boss worker jobs, existing practice capability package, existing Biome/tsc/test gates.

> **Amendment（2026-06-15，owner 复核）**：
> - **Phase 3 选题信号扩充**：L1 信号向量补 `exam_relevance` / `misconception_recurrence` / `transfer_gap`（GPT 研究稿 §9.2 复习推荐公式；选题不止 MFI 中心）。Task 4 `SelectionCandidateSignal` + Phase 1 signals 列纳入。详见 ADR-0042 编排档2 amendment「L1 信号集扩充」。
> - **Phase 6 b_anchor 框定纠正**：feature→b 锚 = 当前 ItemPriorTask（LLM in-context feature→b，`source='llm_prior'` 低置信）的**训练升级版**，**不是 vs 1-5 proxy**。spike（`docs/design/2026-06-15-b-anchor-feasibility-spike.md`）裁决「仅 scale 锚可行」；**真 blocker = 数据**（无中文全科 b 标签），**非经济性**（owner「无所谓经济性」→ Phase 6 **不加经济闸**，只留数据可行性 PoC）。更轻近路 = LLaSA 学生模拟 prompt 升级 ItemPriorTask（零数据）。承重 = active-PPI firm-up，非冷启先验。详见 ADR-0043「b_anchor 来源」节。

---

## Executive Roadmap

### Phase 0 — Decision Hygiene

**Purpose:** Make the model boundary unambiguous before implementation.

**Outcome:**
- ADR-0042 remains the selection-engine contract.
- ADR-0043 remains the difficulty recalibration contract.
- Add one short design amendment: "Urnings is adopted as an uncertainty direction, not as full item-half online updating."
- Mark `docs/design/2026-06-15-ai-pipeline-current-map.md` as an old understand snapshot because B1-W1 code now exists.

**Exit gate:** Future agents can answer "why not full Urnings now?" without re-litigating n=1 identifiability.

### Phase 1 — Observability Before Behavior

**Purpose:** Capture the evidence needed for later MFI/PPI work without changing what users see.

**Outcome:**
- `practice_stream_item` can store structured selection signals.
- Selected items persist `policy`, `mfi_score`, `theta_snapshot`, `b_snapshot`, and `inclusion_probability`.
- No change to visible order yet.

**Exit gate:** For any scheduled question, we can explain why it appeared and recover the probability with which it was selected.

### Phase 2 — Urnings-Lite: Theta Uncertainty

**Purpose:** Keep current Elo/MLE theta updates, but add an uncertainty estimate so MFI can stop pretending point estimates are equally reliable.

**Outcome:**
- `mastery_state` gets `theta_precision` and derived `theta_se`.
- `updateThetaForAttempt` increments information using Rasch Fisher information `p(1-p)` with the same b anchor used for theta update.
- MFI code can down-weight high-uncertainty theta.

**Exit gate:** A cold knowledge node and a well-practiced knowledge node with the same `theta_hat` produce different selection confidence.

### Phase 3 — Randomized MFI Selection

**Purpose:** Replace deterministic top-MFI with a shortlist plus randomized policy, so the system gets diagnostic value without collapsing into biased greedy selection.

**Outcome:**
- L1 computes deterministic signals: due order, frontier, `mfi_score`, `theta_se`, `b_source`, `recall_eligible`.
- Selection policy uses `epsilon-greedy` or `softmax` over the shortlist.
- Chosen items persist true inclusion probability `pi_i`.
- L3 still enforces due presence/order, recall invariant, capacity, and frontier quotas.

**Exit gate:** Re-running the same candidate pool can choose different non-due diagnostic items, while due items stay present and ordered.

### Phase 4 — Hybrid Stream Lifecycle

**Purpose:** Implement ADR-0042's runtime shape: nightly skeleton plus incremental re-rank after answers.

**Outcome:**
- Nightly job precomposes the day stream.
- `advanceStreamItem` can trigger a bounded incremental re-rank of pending non-due items affected by changed theta.
- Single-flight/advisory lock prevents double LLM or double composition.

**Exit gate:** After an answer updates `theta_hat`, the pending diagnostic part of today's stream can adjust without rewriting completed items.

### Phase 5 — Personalized Effective Difficulty

**Purpose:** When one person has enough data, start estimating personalized difficulty at family/bucket level, not per single item.

**Outcome:**
- Introduce item-family buckets such as `(subject, knowledge_id, kind, source, feature_bucket)`.
- Estimate `b_personalized` only after minimum repeated objective observations.
- Keep item-level `b` anchored; expose family-level adjustment as `b_effective = b_calib + family_delta`.

**Exit gate:** The system can say "these trigonometry short-answer items are consistently harder for you than the anchor predicts" without claiming the exact individual question's public difficulty changed.

### Phase 6 — Active-PPI Recalibration

**Purpose:** Start deferred recalibration only after the telemetry needed by ADR-0043 exists.

**Outcome:**
- Split `item_calibration.b` into `b_anchor` and `b_calib` while preserving read compatibility.
- Create labeled calibration rows where `Y` is an anchored-theta-derived difficulty label, not raw correctness.
- Use IPW/AIPW with persisted `pi_i`; add PPI++ power tuning so bad anchors can auto-degrade toward classical labels.

**Exit gate:** Calibration can correct anchor-scale bias without turning response rate into item difficulty.

### Phase 7 — Urnings / Full Bayesian Spike

**Purpose:** Decide whether full Urnings is worth production complexity after enough real data exists.

**Outcome:**
- Offline replay compares current Elo+uncertainty, Glicko-style RD, Urnings-lite, and full Urnings.
- Candidate metrics: calibration error, predictive log loss, MFI regret, user fatigue, and instability after learning jumps.

**Exit gate:** Full Urnings ships only if replay shows clear lift over simpler uncertainty methods and the item/family observation graph is dense enough.

### Phase 8 — Supply Target Discovery Engine

**Purpose:** Add the supply-side mirror of the selection engine. Selection decides what to practice from available material; target discovery decides what missing questions/materials should be generated, sourced, or ingested next.

**Architecture doc:** `docs/design/2026-06-15-question-supply-target-discovery-architecture.md`

**Outcome:**
- A deterministic gap scanner computes question-pool deficits by `knowledge_id`, kind, difficulty band, source tier, image/text need, and calibration value.
- A route planner emits acquisition targets for `QuestionAuthorTask`, `SourcingTask`, ingestion/image-candidate accept, or quiz generation.
- Targets carry priority, rationale, route preference, verification gates, and stop conditions.

**Exit gate:** When a frontier/new-check/diagnostic slot cannot be filled from the existing pool, the system produces a concrete acquisition target instead of silently falling back to weaker material.

---

## File Structure

### Existing Files to Modify

- `docs/adr/0042-mfi-selection-signal-three-layer-engine.md` — add amendment that Urnings is a later spike; current production path is Elo/MLE + uncertainty.
- `docs/adr/0043-difficulty-data-driven-recalibration.md` — add implementation sequencing note for `theta_precision`, `pi_i`, `b_anchor/b_calib`, and family-level personalized b.
- `docs/design/2026-06-15-ai-pipeline-current-map.md` — add top note that B1-W1 implementation has superseded the "code side zero" diagnosis.
- `src/db/schema.ts` — add columns/tables via forward-only migrations.
- `src/core/theta.ts` — add uncertainty math and MFI utility functions.
- `src/server/mastery/state.ts` — update theta write path to maintain precision.
- `src/capabilities/practice/server/stream-composer.ts` — add selection signal output while preserving deterministic fallback.
- `src/capabilities/practice/server/stream-store.ts` — persist selection observations/signals.
- `src/capabilities/practice/manifest.ts` — add nightly/re-rank jobs when Phase 4 begins.
- `src/server/mastery/item-calibration.ts` — evolve writer to `b_anchor/b_calib` in Phase 6.
- `src/ai/registry.ts` and `src/ai/task-prompts.ts` — only if Phase 6 needs a calibration task.

### New Files to Create

- `src/core/selection-signals.ts` — pure MFI, uncertainty penalty, softmax/epsilon-greedy helpers.
- `src/core/selection-signals.test.ts` — unit tests for MFI and probability policies.
- `src/capabilities/practice/server/selection-observations.ts` — persistence helpers for `pi_i` and signal snapshots.
- `src/capabilities/practice/server/selection-observations.db.test.ts` — DB tests for selected-row telemetry.
- `src/server/mastery/personalized-difficulty.ts` — family-level difficulty adjustment computation.
- `src/server/mastery/personalized-difficulty.test.ts` — pure tests for gates and shrinkage.
- `src/server/mastery/recalibration.ts` — Phase 6 active-PPI/AIPW logic.
- `src/server/mastery/recalibration.test.ts` — pure tests for IPW normalization and PPI++ fallback.
- `src/server/question-supply/target-discovery.ts` — computes missing question/material targets from learning goals, frontier, mastery, and pool coverage.
- `src/server/question-supply/route-planner.ts` — maps targets to acquisition routes: author, source, ingest, image candidate, quiz generation.
- `src/server/question-supply/target-discovery.test.ts` — pure tests for target prioritization and route choice.
- `src/server/question-supply/target-discovery.db.test.ts` — DB tests for pool coverage scanner.
- `docs/design/2026-06-15-urnings-lite-calibration-amendment.md` — concise design amendment for the roadmap.

---

## Implementation Tasks

### Task 1: Documentation Amendment

**Files:**
- Create: `docs/design/2026-06-15-urnings-lite-calibration-amendment.md`
- Modify: `docs/adr/0042-mfi-selection-signal-three-layer-engine.md`
- Modify: `docs/adr/0043-difficulty-data-driven-recalibration.md`
- Modify: `docs/design/2026-06-15-ai-pipeline-current-map.md`

- [ ] **Step 1: Write the amendment doc**

Add a short doc with these exact decisions:

```markdown
# Urnings-Lite Calibration Amendment

**Date:** 2026-06-15
**Status:** Accepted as implementation sequencing guidance

## Decision

Use Urnings as an uncertainty-model inspiration, not as the current production
paired-comparison engine.

Current production path:

1. Keep `item_calibration.b` anchored and read-only in online theta updates.
2. Maintain `mastery_state.theta_hat` with the existing MLE/Elo update.
3. Add theta uncertainty (`theta_precision` / `theta_se`) before changing MFI.
4. Persist inclusion probability `pi_i` for selected diagnostic items.
5. Defer full Urnings to an offline replay spike after family-level observation
   density exists.

## Rationale

One learner can accumulate enough data to improve personalized theta and
family-level effective difficulty, but this is not the same as a cohort. Full
item-half online updates remain unsafe for sparse per-item observations because
theta changes and item difficulty are confounded.
```

- [ ] **Step 2: Add ADR references**

Append a short "Implementation sequencing amendment" paragraph to ADR-0042 and ADR-0043 pointing to the amendment doc.

- [ ] **Step 3: Mark old map as stale**

Add this note near the top of `docs/design/2026-06-15-ai-pipeline-current-map.md`:

```markdown
> **Supersession note (2026-06-15):** This was an understand-stage snapshot.
> Its "B1 calibration code side zero" statement is stale after B1-W1: the repo
> now has `mastery_state`, `item_calibration`, `ItemPriorTask`, and theta update
> wiring. Keep this document as historical pipeline evidence, not current state.
```

- [ ] **Step 4: Verify docs**

Run:

```bash
pnpm lint
```

Expected: Biome either passes or reports only pre-existing unrelated docs/style findings.

### Task 2: Theta Uncertainty Pure Math

**Files:**
- Modify: `src/core/theta.ts`
- Modify: `src/core/theta.test.ts`

- [ ] **Step 1: Add pure functions**

Add:

```ts
export function fisherInformation(theta: number, b: number): number {
  const p = expectedScore(theta, b);
  return p * (1 - p);
}

export function thetaSe(thetaPrecision: number): number {
  return 1 / Math.sqrt(Math.max(thetaPrecision, 1e-9));
}

export function updateThetaPrecision(
  thetaPrecision: number,
  thetaBefore: number,
  b: number,
  weight = 1,
): number {
  return thetaPrecision + weight * weight * fisherInformation(thetaBefore, b);
}
```

- [ ] **Step 2: Add tests**

Add tests asserting:

```ts
expect(fisherInformation(0, 0)).toBeCloseTo(0.25, 10);
expect(fisherInformation(4, 0)).toBeLessThan(0.02);
expect(thetaSe(4)).toBeCloseTo(0.5, 10);
expect(updateThetaPrecision(1, 0, 0, 1)).toBeCloseTo(1.25, 10);
expect(updateThetaPrecision(1, 0, 0, 0.3)).toBeCloseTo(1 + 0.09 * 0.25, 10);
```

- [ ] **Step 3: Run unit test**

Run:

```bash
pnpm vitest run src/core/theta.test.ts --config vitest.unit.config.ts
```

Expected: all tests pass.

### Task 3: Persist Theta Precision

**Files:**
- Modify: `src/db/schema.ts`
- Add migration: `drizzle/00xx_mastery_theta_precision.sql`
- Modify: `src/server/mastery/state.ts`
- Modify: `src/server/mastery/state.db.test.ts`
- Modify: `tests/integration/migration-smoke.test.ts`

- [ ] **Step 1: Add columns**

Add nullable/backfilled-safe columns to `mastery_state`:

```ts
theta_precision: real('theta_precision').notNull().default(1),
last_theta_delta: real('last_theta_delta'),
```

Do not store `theta_se`; derive it from `theta_precision`.

- [ ] **Step 2: Update state row types**

Extend `MasteryStateRow` and `UpsertMasteryStateInput` with:

```ts
theta_precision: number;
last_theta_delta: number | null;
```

- [ ] **Step 3: Update `updateThetaForAttempt`**

Compute:

```ts
const precisionBefore = row?.theta_precision ?? 1;
const newPrecision = updateThetaPrecision(precisionBefore, s.theta, b, bWeight);
const delta = newTheta - s.theta;
```

Persist `theta_precision: newPrecision` and `last_theta_delta: delta`.

- [ ] **Step 4: Add DB tests**

Add assertions:

```ts
expect(row?.theta_precision).toBeGreaterThan(1);
expect(row?.last_theta_delta).toBeCloseTo(row.theta_hat, 5);
```

For an anchored vs proxy question, assert proxy precision increases less than anchored precision.

- [ ] **Step 5: Run DB test**

Run:

```bash
pnpm vitest run src/server/mastery/state.db.test.ts --config vitest.db.config.ts
```

Expected: pass when container runtime is available.

### Task 4: Selection Signals and Randomized Policy

**Files:**
- Create: `src/core/selection-signals.ts`
- Create: `src/core/selection-signals.test.ts`

- [ ] **Step 1: Define signal types**

```ts
export interface SelectionCandidateSignal {
  refKind: 'question' | 'paper';
  refId: string;
  role: 'due' | 'frontier' | 'diagnostic' | 'new_check' | 'paper';
  thetaHat?: number;
  thetaPrecision?: number;
  b?: number;
  dueRank?: number;
  recallLocked?: boolean;
  // §9.2 / ADR-0042 编排档2 first-class 信号扩充（选题不止 MFI 中心）。
  // **Phase 1 只定义 type + 进 signals 存储结构（type-only）；computation 全部留
  // Phase 3 候选收集层（Task 7）**——examRelevance 据考纲映射、
  // misconceptionRecurrence 据错题家族复发频次、transferGap 据迁移缺口诊断。
  examRelevance?: number; // 0-1
  misconceptionRecurrence?: number; // 0-1
  transferGap?: number; // 0-1
}
```

> 落地状态（2026-06-15，PR #421）：这三个字段已随 Phase 1 selection-observability 在
> `src/core/selection-signals.ts` 落 **type-only**（值 computation 在 Task 7 候选收集层）。
> 本 lane 零选题行为变更——signals 列只存储不评分。

- [ ] **Step 2: Add MFI score helper**

```ts
export function mfiScore(thetaHat: number, b: number): number {
  const p = 1 / (1 + Math.exp(-(thetaHat - b)));
  return p * (1 - p);
}

export function uncertaintyPenalty(thetaPrecision: number): number {
  return Math.sqrt(Math.max(thetaPrecision, 1e-9)) / (1 + Math.sqrt(Math.max(thetaPrecision, 1e-9)));
}

export function diagnosticScore(thetaHat: number, b: number, thetaPrecision: number): number {
  return mfiScore(thetaHat, b) * uncertaintyPenalty(thetaPrecision);
}
```

- [ ] **Step 3: Add probability policy**

Implement deterministic due preservation and randomized non-due selection:

```ts
export function softmaxProbabilities(scores: number[], temperature = 0.25): number[] {
  if (scores.length === 0) return [];
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - max) / temperature));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / total);
}
```

- [ ] **Step 4: Add tests**

Assert:

```ts
expect(mfiScore(0, 0)).toBeCloseTo(0.25, 10);
expect(mfiScore(4, 0)).toBeLessThan(mfiScore(0, 0));
expect(softmaxProbabilities([1, 1])).toEqual([0.5, 0.5]);
expect(softmaxProbabilities([2, 1])[0]).toBeGreaterThan(softmaxProbabilities([2, 1])[1]);
```

- [ ] **Step 5: Run unit test**

```bash
pnpm vitest run src/core/selection-signals.test.ts --config vitest.unit.config.ts
```

Expected: pass.

### Task 5: Persist Selection Observations and Pi

**Files:**
- Modify: `src/db/schema.ts`
- Add migration: `drizzle/00xx_selection_observation.sql`
- Create: `src/capabilities/practice/server/selection-observations.ts`
- Create: `src/capabilities/practice/server/selection-observations.db.test.ts`

- [ ] **Step 1: Add table**

Add `selection_observation`:

```ts
export const selection_observation = pgTable('selection_observation', {
  id: text('id').primaryKey(),
  date: text('date').notNull(),
  stream_item_id: text('stream_item_id'),
  ref_kind: text('ref_kind').$type<'question' | 'paper'>().notNull(),
  ref_id: text('ref_id').notNull(),
  policy: text('policy').notNull(),
  selected: boolean('selected').notNull(),
  inclusion_probability: real('inclusion_probability').notNull(),
  signals: jsonb('signals').$type<JsonObject>().notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Add writer helper**

Create `recordSelectionObservation(db, input)` that inserts one row per selected item with `inclusion_probability > 0 && <= 1`.

- [ ] **Step 3: Add DB tests**

Test:
- rejects probability `0`
- persists selected question with signals JSON
- can query by `date` and `ref_id`

- [ ] **Step 4: Run DB test**

```bash
pnpm vitest run src/capabilities/practice/server/selection-observations.db.test.ts --config vitest.db.config.ts
```

Expected: pass when container runtime is available.

### Task 6: Stream Signals Without Behavior Change

**Files:**
- Modify: `src/db/schema.ts`
- Add migration: `drizzle/00xx_practice_stream_signals.sql`
- Modify: `src/capabilities/practice/server/stream-composer.ts`
- Modify: `src/capabilities/practice/server/stream-store.ts`
- Modify: `src/capabilities/practice/server/stream-composer.unit.test.ts`
- Modify: `src/capabilities/practice/api/stream.db.test.ts`

- [ ] **Step 1: Add `signals` column**

Add:

```ts
signals: jsonb('signals').$type<JsonObject>().notNull().default({}),
```

- [ ] **Step 2: Extend `StreamPlanItem`**

Add:

```ts
signals?: Record<string, unknown>;
```

- [ ] **Step 3: Persist signals**

In `materializeStream`, write `signals: it.signals ?? {}`.

- [ ] **Step 4: Preserve existing behavior**

Do not change ordering in this task. Existing stream composer tests should pass with signals defaulting to `{}`.

- [ ] **Step 5: Run tests**

```bash
pnpm vitest run src/capabilities/practice/server/stream-composer.unit.test.ts --config vitest.unit.config.ts
pnpm vitest run src/capabilities/practice/api/stream.db.test.ts --config vitest.db.config.ts
```

Expected: unit pass; DB pass when container runtime is available.

### Task 7: MFI Candidate Collection

**Files:**
- Create: `src/capabilities/practice/server/selection-signals.ts`
- Modify: `src/capabilities/practice/server/stream-store.ts`
- Test: `src/capabilities/practice/server/selection-signals.db.test.ts`

- [ ] **Step 1: Read theta and b**

For candidate questions, load:
- `question.knowledge_ids`
- `question.difficulty`
- `mastery_state.theta_hat`
- `mastery_state.theta_precision`
- `item_calibration.b`

Fallback:
- missing theta: `theta_hat = 0`, `theta_precision = 1`
- missing b: `difficultyToLogitB(question.difficulty)`, mark `b_source='difficulty_proxy'`

- [ ] **Step 2: Multi-KC aggregation**

Use weakest KC for selection:

```ts
const selectedKc = states.reduce((min, s) => s.theta_hat < min.theta_hat ? s : min);
```

Store all KC snapshots in signals.

- [ ] **Step 3: Exclude recall candidates**

Do not compute MFI for recall-locked variants. Mark `mfi_eligible: false`.

- [ ] **Step 4: Compute §9.2 first-class signals（选题不止 MFI 中心）**

填 `SelectionCandidateSignal` 在 Phase 1 留的 type-only 字段（ADR-0042 编排档2 L1 信号集扩充）：
- `examRelevance` ∈ [0,1]：据考纲/考点权重映射（subject profile 的考纲数据）。
- `misconceptionRecurrence` ∈ [0,1]：据该题关联错误观念家族的复发频次（mistake/cause 数据）。
- `transferGap` ∈ [0,1]：据跨情境迁移缺口诊断（同 KC 不同题型/情境的掌握差）。

缺数据时留 `undefined`（评分层按 MFI-only 退化，不强行兜 0）。这三个信号进 L2 LLM 编排器的候选画像 + 落 `signals` 快照，使选题脱离纯 MFI 中心。

- [ ] **Step 5: Add DB tests**

Seed two knowledge states and one multi-KC question. Assert selected theta snapshot uses the lower `theta_hat`. 另断言 §9.2 信号在有数据时被填、缺数据时留 `undefined`（不污染为 0）。

### Task 8: Randomized MFI Selection in Non-Due Slots

**Files:**
- Modify: `src/capabilities/practice/server/stream-composer.ts`
- Modify: `src/capabilities/practice/server/stream-store.ts`
- Modify: `src/capabilities/practice/server/stream-composer.unit.test.ts`
- Modify: `src/capabilities/practice/server/selection-observations.ts`

- [ ] **Step 1: Add policy config**

```ts
export interface SelectionPolicyConfig {
  policy: 'legacy' | 'softmax_mfi';
  temperature?: number;
  epsilon?: number;
}
```

Default to `legacy` until all tests pass.

- [ ] **Step 2: Implement softmax path for non-due candidates**

Keep due item order stable. Apply randomized selection only to frontier/diagnostic/new_check candidate pools.

- [ ] **Step 3: Persist pi**

For each selected non-due item, call `recordSelectionObservation` with its probability from softmax/epsilon policy.

- [ ] **Step 4: Test invariants**

Tests:
- due order is unchanged
- probabilities sum to 1 for non-due candidate pool
- selected item observation persists `pi_i`
- recall item has no MFI score

### Task 9: Hybrid Nightly + Incremental Re-Rank

**Files:**
- Modify: `src/capabilities/practice/manifest.ts`
- Create: `src/capabilities/practice/jobs/practice_stream_compose_nightly.ts`
- Modify: `src/capabilities/practice/server/stream-store.ts`
- Test: `src/capabilities/practice/server/stream-store.db.test.ts`

- [ ] **Step 1: Add nightly job**

Create a job handler that calls:

```ts
const plan = composeDailyStream(await collectComposerInputs(db, date));
await materializeStream(db, plan, 'composer_nightly');
```

- [ ] **Step 2: Add advisory lock**

Use a stable lock key:

```sql
SELECT pg_advisory_xact_lock(hashtext('practice_stream:' || date));
```

- [ ] **Step 3: Add incremental re-rank hook**

After `advanceStreamItem(..., 'done')`, call a bounded helper:

```ts
await recomposePendingDiagnosticTail(db, row.date, { affectedKnowledgeIds });
```

Keep done/in-progress/skipped rows unchanged.

- [ ] **Step 4: Test**

Seed stream rows, mark one done, re-rank pending rows. Assert completed rows keep position/status and pending diagnostic rows can change.

### Task 10: Family-Level Personalized Difficulty

**Files:**
- Modify: `src/db/schema.ts`
- Add migration: `drizzle/00xx_item_family_calibration.sql`
- Create: `src/server/mastery/personalized-difficulty.ts`
- Create: `src/server/mastery/personalized-difficulty.test.ts`

- [ ] **Step 1: Add table**

```ts
export const item_family_calibration = pgTable('item_family_calibration', {
  id: text('id').primaryKey(),
  family_key: text('family_key').notNull(),
  b_delta: real('b_delta').notNull().default(0),
  evidence_count: integer('evidence_count').notNull().default(0),
  confidence: real('confidence').notNull().default(0),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Define family key**

Use:

```ts
`${subject}:${primaryKnowledgeId}:${questionKind}:${source}`
```

Do not use exact question id for this phase.

- [ ] **Step 3: Add shrinkage**

Implement:

```ts
export function shrinkFamilyDelta(rawDelta: number, n: number, priorStrength = 20): number {
  return (n / (n + priorStrength)) * rawDelta;
}
```

- [ ] **Step 4: Add gates**

Only update family calibration when:
- objective/graded outcome exists
- `n >= 20` for the family
- at least 5 distinct questions in the family

- [ ] **Step 5: Test gates**

Assert no update before thresholds and shrunk delta after thresholds.

### Task 11: Active-PPI Recalibration

**Files:**
- Modify: `src/db/schema.ts`
- Add migration: `drizzle/00xx_item_calibration_recalibration.sql`
- Create: `src/server/mastery/recalibration.ts`
- Create: `src/server/mastery/recalibration.test.ts`
- Modify: `src/server/mastery/item-calibration.ts`

- [ ] **Step 1: Add calibration columns**

Add to `item_calibration`:

```ts
b_anchor: real('b_anchor'),
b_calib: real('b_calib'),
calibration_n: integer('calibration_n').notNull().default(0),
calibration_weight: real('calibration_weight'),
last_calibrated_at: timestamp('last_calibrated_at', { withTimezone: true }),
```

Read compatibility:

```ts
const effectiveB = row.b_calib ?? row.b_anchor ?? row.b;
```

- [ ] **Step 2: Add calibration label table**

```ts
export const difficulty_calibration_label = pgTable('difficulty_calibration_label', {
  id: text('id').primaryKey(),
  question_id: text('question_id').notNull(),
  attempt_event_id: text('attempt_event_id').notNull(),
  theta_snapshot: real('theta_snapshot').notNull(),
  outcome: integer('outcome').notNull(),
  b_label: real('b_label').notNull(),
  inclusion_probability: real('inclusion_probability').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 3: Implement AIPW normalization**

Use ADR-0043's corrected form:

```ts
export function aipwMean(poolPredictions: number[], labeledResiduals: Array<{ residual: number; pi: number }>): number {
  const n = poolPredictions.length;
  const predictionMean = poolPredictions.reduce((a, b) => a + b, 0) / n;
  const residualCorrection = labeledResiduals.reduce((sum, r) => sum + r.residual / r.pi, 0) / n;
  return predictionMean + residualCorrection;
}
```

- [ ] **Step 4: Add tests**

Assert uniform sampling does not multiply by `N/n` twice. Assert `pi <= 0` throws.

### Task 12: Offline Urnings Replay Spike

**Files:**
- Create: `scripts/replay-urnings-lite.ts`
- Create: `docs/design/2026-06-15-urnings-replay-results-template.md`

- [ ] **Step 1: Build replay inputs**

Read historical attempts with:
- question id
- knowledge ids
- outcome
- timestamp
- b anchor/effective b at the time

- [ ] **Step 2: Compare models**

Replay four variants:
- current Elo/MLE point estimate
- Elo/MLE + `theta_precision`
- Glicko/RD-style uncertainty
- full Urnings prototype

- [ ] **Step 3: Report metrics**

Report:
- next-answer log loss
- Brier score
- theta volatility
- MFI top-k regret proxy
- number of families meeting density threshold

- [ ] **Step 4: Decision gate**

Full Urnings can proceed only if:
- it beats Elo+uncertainty on log loss and Brier score
- it reduces MFI instability
- implementation complexity is justified by dense repeated observations

### Task 13: Question Supply Target Discovery Engine

**Files:**
- Create: `src/server/question-supply/target-discovery.ts`
- Create: `src/server/question-supply/route-planner.ts`
- Create: `src/server/question-supply/target-discovery.test.ts`
- Create: `src/server/question-supply/target-discovery.db.test.ts`
- Modify: `src/ai/registry.ts` only if a new `QuestionSupplyTargetTask` is required after deterministic coverage is insufficient
- Modify: `src/subjects/profile-schema.ts` only if route preferences need new typed fields beyond existing `sourcingRoutePreference`

- [ ] **Step 1: Define target shape**

Create:

```ts
export type SupplyRoute = 'author_question' | 'sourcing_web' | 'ingest_existing' | 'image_candidate' | 'quiz_gen';

export interface QuestionSupplyTarget {
  id: string;
  subjectId: string;
  knowledgeIds: string[];
  kind: string;
  difficultyBand: 'below' | 'near' | 'above' | 'stretch';
  desiredCount: number;
  minSourceTier: 1 | 2 | 3;
  routePreference: SupplyRoute[];
  priority: number;
  reason: string;
  constraints: {
    needsImage?: boolean;
    objectiveOnly?: boolean;
    calibrationCandidate?: boolean;
    avoidDuplicateOfQuestionIds?: string[];
  };
}
```

- [ ] **Step 2: Implement deterministic coverage gaps**

Inputs:
- active goals and `learning_item.knowledge_ids`
- frontier knowledge ids
- `mastery_state.theta_hat/theta_precision`
- existing questions grouped by `knowledge_id + kind + difficulty band + source tier`
- subject profile `sourcingRoutePreference`

Rules:
- if no question exists for a frontier/new-check knowledge id, emit `desiredCount=2`
- if only low-tier or llm-only questions exist, emit one higher-tier target
- if MFI/diagnostic selection repeatedly lacks near-`theta_hat` items, emit a calibration candidate
- if a knowledge id has only recall-style items, emit one application/transfer target

- [ ] **Step 3: Implement route planner**

Route priorities:

```ts
export function planSupplyRoutes(target: QuestionSupplyTarget): SupplyRoute[] {
  if (target.constraints.needsImage) return ['image_candidate', 'ingest_existing', 'sourcing_web'];
  if (target.minSourceTier <= 2) return ['sourcing_web', 'ingest_existing', 'author_question'];
  if (target.constraints.objectiveOnly) return ['sourcing_web', 'author_question'];
  return target.routePreference.length > 0 ? target.routePreference : ['author_question', 'sourcing_web'];
}
```

- [ ] **Step 4: Wire existing acquisition routes**

Do not create a new monolithic acquisition task. The target engine should dispatch to existing surfaces:
- `QuestionAuthorTask` for synthetic draft questions
- `SourcingTask` for web-sourced existing questions
- ingestion session / image candidate accept for visual sources
- `QuizGenTask` only when a bundled quiz/paper is explicitly desired

- [ ] **Step 5: Add pure tests**

Test cases:
- frontier with zero questions emits two targets
- existing low-tier-only pool emits a higher-tier target
- repeated diagnostic gap emits `calibrationCandidate`
- image-needed target routes to `image_candidate` first

- [ ] **Step 6: Add DB tests**

Seed:
- one knowledge node
- one active learning item
- zero questions

Assert target discovery emits a `new_check` supply target for that knowledge id.

Seed an existing `web_sourced` draft and an accepted manual question; assert accepted/manual satisfies higher-tier requirement and suppresses unnecessary sourcing.

- [ ] **Step 7: Add observability**

Every emitted target should log:
- input gap counts
- chosen route list
- stop condition
- whether it was satisfied, skipped, or failed verification

---

## Validation Gates

Run at each phase:

```bash
pnpm vitest run src/core/theta.test.ts --config vitest.unit.config.ts
pnpm vitest run src/core/selection-signals.test.ts --config vitest.unit.config.ts
pnpm typecheck
```

Before PR:

```bash
CODEX_FULL_GATE=1 pnpm lint
CODEX_FULL_GATE=1 pnpm test
CODEX_FULL_GATE=1 pnpm build
```

DB tests require a working container runtime.

---

## Non-Goals

- Do not let online single-user attempts update public item `b` directly.
- Do not feed `irt_a`, `irt_c`, `cdm_json`, or `kt_json` into scheduling.
- Do not treat raw correctness as a PPI difficulty label.
- Do not make LLM responsible for due presence or due order.
- Do not ship full Urnings before offline replay proves it beats simpler uncertainty methods.
- Do not let the supply target engine bypass verification: generated/sourced/ingested questions must still pass existing provenance, source tier, solve-check, and source_verify gates.
- Do not let supply target discovery decide today's due order. It feeds the pool; selection still owns practice scheduling.

---

## Recommended Branching

Use small branches:

1. `yuk-361-doc-urnings-lite-amendment`
2. `yuk-361-theta-uncertainty`
3. `yuk-361-selection-observability`
4. `yuk-361-randomized-mfi`
5. `yuk-361-hybrid-stream`
6. `yuk-361-personalized-difficulty`
7. `yuk-361-active-ppi`
8. `yuk-361-urnings-replay`
9. `yuk-361-question-supply-targets`

Each branch should merge independently after tests.
