# kc-dedup attribution rewrite gap — 实施 spec(worklist #1)

> **Program**: 项目逻辑全量打磨(master register worklist #1,`docs/design/2026-07-02-project-logic-master-register.md` §worklist `kc-dedup-attribution-rewrite-gap`)
> **Linear**: 子 issue 挂 YUK-538
> **Provenance**: 6-agent 设计 workflow(`wf_fa3ba23b-877`,2026-07-02)——dual-ground(外部知识 + code)→ design → 对抗 ×2(Lens A ownership 轴 / Lens B event-sourcing 轴)→ reconcile。reconcile 段对 HEAD `9ef22630`(当日 main)逐条重接地,非转述 attack。
> **自主协议**: owner 已授自主("你自主")——§4 decision points 按推荐默认直接实施;唯一升级为 owner 可见的高亮:`knowledge_edge` 是 LIVE fold-owned(W1 flip 后每次触边 merge 都已在生产产生 fold 不可复现行),紧急度高于 register 原 P1 定级。
> **Status**: 实施中(worktree lane,PR 停等 owner merge)

---

# Final Implementation-Ready Spec: `kc-dedup-attribution-rewrite-gap`

Reconciles the design against **Attack A** (English lens, ownership-axis critique) and **Attack B** (Chinese lens, event-sourcing critique). All facts below re-verified directly against the working tree at HEAD `9ef226302143e8ba3f141b69089cafb49c2471a9` (2026-07-02) in this pass — every attack claim was independently re-grounded, not taken on faith. One correction beyond what either attack found is folded in (§3, item "beyond-attacks").

---

## 1. CURRENT BEHAVIOR (verified file:line)

**`applyMerge`** — `src/capabilities/knowledge/server/proposals.ts:446-497`. Confirmed by direct read: inside one `tx`, it (a) verifies `into_id` exists and is unarchived, (b) for each `from_id` does a version-guarded `UPDATE knowledge SET archived_at=now ...` (throws `stale:` on mismatch), (c) appends `from_ids` to `into.merged_from[]`. **That is the entire mutation surface.** No other table is touched.

**Single caller** — `proposals.ts:702-711`, the `'merge'` case inside `acceptProposal`'s mutation switch (confirmed only call site in `src/`/`scripts/`, non-test, via repo-wide grep). Signature today: `applyMerge(db, payload: MergePayload, now): Promise<void>` where `MergePayload = { mutation:'merge'; from_ids: string[]; into_id: string; expected_versions: Record<string,number> }` (`proposals.ts:75-80`).

**Producer-side guard holds** — `kc_dedup_nightly.ts:9-14`: "IRON RULE — PROPOSE-ONLY, NEVER auto-merge... this file MUST NOT import or call `applyMerge`" — confirmed zero `applyMerge` references in that file; only the structural claim, no over-claim of what `applyMerge` does downstream.

**5 doc locations over-claim what `applyMerge` does** (all confirmed by direct read): `dedup-flags.ts:9,17-18` ("rewrites knowledge_ids attribution + sets merged_from[]"), `manifest.ts:135-138` (same claim), `kc_dedup_nightly.ts:10-11` (same claim, embedded in the otherwise-true IRON RULE comment), ADR-0045 line 31 ("重写 knowledge_ids 归属 + merged_from[]"). None of these five is true today.

**Two entities are already event-fold-owned and LIVE**, contradicting the design's blast-radius claim:
- `docker-compose.mac.yml:16,21`: `PROJECTION_IS_WRITER: "1"` on both `app` and `worker` — this is the *current production* config (per project CLAUDE.md, mac-compose is prod). Comment at `docker-compose.mac.yml:9`: "`PROJECTION_IS_WRITER` = W1 knowledge / knowledge_edge (live since W1)."
- `docker-compose.mac.yml:17,22`: `PROJECTION_IS_WRITER_ARTIFACT: "1"` — artifact fold also LIVE (flipped 2026-06-28 per comment).
- `sot-flag.ts:26-29` confirms the bare global flag "gates ONLY knowledge/knowledge_edge."

**`knowledge_edge` fold event vocabulary has no "rewire endpoint" event** — `src/core/projections/knowledge_edge.ts:72,137,162-188`: only `experimental:genesis` and `generate` with `payload.edge_op ∈ {create, archive}` (absent = create). A raw endpoint `UPDATE` produces a row the fold vocabulary cannot reproduce.

**ADR-0034 topology gate is a synchronous write-time check, not just a fold-replay check** — `propose_edge.ts:325-329` ("write-time STRUCTURAL CONSISTENCY gate") calls `checkEdgeTopology` (`topology-gate.ts:111`); separately the fold itself also throws on replay (`knowledge_edge.ts:101-102,208-210`: reject verdict → `throw`, caller tx aborts). Real precedent for a rewrite-shaped edge mutation exists: `applyEdgeSupersede` (`propose_edge.ts:733-825`) archives one edge + creates another **via the imperative `archiveKnowledgeEdge`/`createKnowledgeEdge` (`edges.ts:129-207,233+`) run in the SAME tx as parallel `generate` events** — this is the actual in-repo shape for "rewrite an edge's identity," not a raw UPDATE.

**`goal`/`learning_item` folds exist, flags OFF today** (absent from `docker-compose.mac.yml`; `sot-flag.ts:76-81` lists `PROJECTION_IS_WRITER_GOAL`/`PROJECTION_IS_WRITER_LEARNING_ITEM`, default OFF). But their gathers are **already merge-aware by exclusion, not ignorance**: `gather.ts:154-155` "NO Q3 merged-into" for goal, `gather.ts:262` "NO Q3 merge-into" for learning_item — explicit acknowledgment the case exists and isn't handled. `gather.ts:116-129` shows the exact precedent (`gatherAndFoldKnowledgeNode`'s Q3): `payload -> 'from_ids' @> [nodeId]` on `action = 'experimental:knowledge_merge'` — an event **already written at propose time** (`kc_dedup_nightly.ts:82`, `proposal-tools.ts`), consumed today only by the node fold.

**Goal already has a reusable event+writer for scope rewrites** — `experimental:goal_scope_update` (`src/core/schema/event/goal-events.ts:46-58`), consumed by the goal reducer (`goal.ts:247`), with a live writer at `src/capabilities/agency/server/goals/queries.ts:179`.

**`learner_axis_state` exists and is unclassified in the design** — `src/db/schema.ts:1072-1095`, `uniqueIndex('learner_axis_state_unique').on(subject_kind, subject_id)` (`:1094`), single writer `src/server/calibration/axis-writer.ts` with `pg_advisory_xact_lock(hashtext('axis_state:<kind>:<id>'))` at `axis-writer.ts:121`. Same per-KC fitted-aggregate shape as `mastery_state`.

**`kc_typed_state` has zero step9 guard coverage** — confirmed by grep: `tests/integration/step9-invariant-audit.test.ts` has no `kc_typed_state` hits at all (mastery_state and material_fsrs_state do, at `:156-177`). `kc_typed_state` schema at `schema.ts:1011-1044`; its own advisory lock `kc_typed:<kind>:<id>` at `src/server/conjectures/typed-state.ts:88`.

**Lock namespace is shared, not two separate ones**: `fsrs:knowledge:<id>` is taken by `updateThetaForAttempt` (`src/server/mastery/state.ts:747`, sorted-KC-id loop) — and `updateThetaForAttempt` (lines 728-1111, one function, confirmed by top-level function-boundary scan) is **also the sole live caller of `upsertMasteryState`** (calls at `:970,1039`, both inside the same function, both inside the same lock scope). `upsertFsrsState` (`src/server/fsrs/state.ts:41`) itself takes no lock — callers (submit.ts / paper-submit.ts) take `fsrs:knowledge:<id>` before calling it. So **one lock namespace, `fsrs:knowledge:<id>`, currently covers the only live concurrent writer of both `mastery_state` and `material_fsrs_state`.** `restore-snapshot.ts:54` (`restoreStateSnapshot`, the cascade-revert path) calls `upsertMasteryState` **without** taking this lock — but it has zero live callers (Attack A, confirmed by design's own dossier §5 citation), so it's dormant risk, not live.

**Guard allowlists differ by table**: `mastery_state` guard (`step9...:170-177`) allows only `src/server/mastery/` — **no historical-script exception**. `material_fsrs_state` guard (`step9...:156-165`) allows `src/server/fsrs/` **and** `scripts/migrate-phase1c1.ts` (an existing one-time-script precedent). `artifact` guard (`step9...:388-410+`) is a curated **file list**, not a directory prefix — `proposals.ts` is confirmed absent from it (the one `proposals.ts` hit in that test file is for the unrelated `event`-table writer guard at line 112, not `artifact`).

**Register's own target shape was violated by the design as originally written** — `docs/design/2026-07-02-project-logic-master-register.md:454` (worklist entry `kc-dedup-attribution-rewrite-gap`, "If RESHAPE — target shape"), item (4): *"routed through the projection/event layer so `assertAcceptParity` stays valid across SoT-flip."* The design's Shape-1 recommendation, as written, proposed raw `UPDATE`s for `knowledge_edge`/`goal`/`learning_item` — directly contradicting the grounding document's own stated requirement. Both attacks caught this independently; neither the design's author nor a naive single-pass review would have.

**`RateEvent` payload is validate-then-store-raw** — `src/server/events/queries.ts:1020-1051`: `parseEvent()` runs for validation only (throws on Lane-B-shape mismatch); the actual `.insert(event)` at `:1041` writes `input.payload as Record<string, unknown>` — the **raw, unstripped** payload. `RateEvent.payload` (`known.ts:279-286`) is a non-strict `z.object`. Confirmed: adding an unmodeled `merge_repair` key is additive-safe and survives to the DB untouched.

---

## 2. FINAL SHAPE

### Per-surface decision table (supersedes the design's table)

| Surface | Ownership (verified) | Mechanism | Function / location |
|---|---|---|---|
| `question.knowledge_ids` | Imperative, no fold exists | Sync rewrite, in-tx (**unchanged from design**) | `rewriteKnowledgeReferenceArray(tx, question, 'knowledge_ids', fromId, intoId)` in `proposals.ts` |
| `learning_item.knowledge_ids` | **Fold-owned**, flag OFF today, **next-in-queue for W5** | **Event-native.** Extend `gather.ts`'s learning_item gather with a Q3 clause mirroring `gather.ts:116-129` (`payload->'from_ids' @> [itemsCurrentKcId]` on the *already-existing* `experimental:knowledge_merge` event — no new event type). Extend the `learning_item` reducer (`core/projections/learning_item.ts`) to apply the from→into replace+dedupe when it sees that event. `applyMerge` still does the imperative `UPDATE learning_item` too (OFF path = imperative row is SoT) and additionally invokes the existing per-entity parity assert (`parity.ts:723`, "learning_item parity assert") on touched ids, dev/test-throw | New: `gather.ts` Q3 clause + `core/projections/learning_item.ts` reducer branch; `proposals.ts` calls the existing parity-assert helper |
| `goal.scope_knowledge_ids` | **Fold-owned**, flag OFF today | **Event-native, reuse existing writer.** Call the existing `experimental:goal_scope_update` writer (`agency/server/goals/queries.ts:179`) per affected goal, in-tx, instead of a raw array UPDATE. Near-zero new code — the event + reducer + writer already exist | `proposals.ts` calls into `agency/server/goals/queries.ts`'s scope-update function |
| `knowledge_edge` endpoints | **Fold-owned, LIVE** (`PROJECTION_IS_WRITER=1`) | **Event-native, mirror `applyEdgeSupersede`.** For each live edge touching `fromId`: (1) synchronous `checkEdgeTopology` (`topology-gate.ts:111`) on the rewritten `(from,to,relation_type)`; (2) on OK: `archiveKnowledgeEdge(tx, oldId)` + `generate`/`edge_op:'archive'` event, then `createKnowledgeEdge(tx, rewritten)` + `generate` event (no `edge_op` = create), exactly the `propose_edge.ts:733-825` shape; (3) on `23505` unique-violation from `createKnowledgeEdge` (duplicate post-rewrite): archive the would-be-duplicate instead of creating (no event for the discarded create — same result the design wanted, now reproducible since the archive alone is a fold-legible event); (4) on topology `reject`: see Decision Point 5 | New `rewireKnowledgeEdges(tx, fromId, intoId, now)` in `proposals.ts`, calling exported functions from `edges.ts` + `topology-gate.ts` |
| `mastery_state` | Imperative, single-writer-guarded, **no historical-script guard exception** | 3-case identity-rename/freeze-and-log, **+ `pg_advisory_xact_lock('fsrs:knowledge:<id>')` for BOTH from_id and into_id, sorted, mirroring `state.ts:745-747`'s own ordering** | `retireMasteryStateOnMerge(tx, fromId, intoId)` in `src/server/mastery/state.ts` |
| `material_fsrs_state` | Imperative, single-writer-guarded, **has `migrate-phase1c1.ts` precedent** | Same 3-case + **same `fsrs:knowledge:<id>` lock namespace** (confirmed shared with mastery_state's live writer) | `retireFsrsStateOnMerge(tx, fromId, intoId)` in `src/server/fsrs/state.ts` |
| **`learner_axis_state`** *(NEW — F2)* | Imperative, single-writer-guarded (no step9 hard guard, but has its own advisory lock module) | Same 3-case identity-rename/freeze-and-log + `pg_advisory_xact_lock('axis_state:<kind>:<id>')` | `retireLearnerAxisStateOnMerge(tx, fromId, intoId)` in `src/server/calibration/axis-writer.ts` |
| `kc_typed_state` | Imperative, **no hard guard** | 3-case for keyed row + direct rewrite for `confused_with_kc_id` pointer + `pg_advisory_xact_lock('kc_typed:<kind>:<id>')` | `retireKcTypedStateOnMerge(tx, fromId, intoId)` in `src/server/conjectures/typed-state.ts` |
| `misconception_edge.to_id` (`to_kind='knowledge'`) | Imperative, no fold exists, dark (`MISCONCEPTION_PROMOTE_ENABLED` OFF, confirmed) | Sync rewrite, in-tx (**unchanged from design** — unchallenged by either attack, correctly, since no fold owns this table) | `rewireMisconceptionEdgeTargets(tx, fromId, intoId)` |
| **`learning_session.scope_knowledge_ids`** *(NEW — F2)* | Live-read by an active placement probe | **Explicitly leave stale** (session-ephemeral; probe pool query on a merged-away id returns empty and the KC is silently skipped for that session's remaining duration). This is now a **declared, documented** trade-off, not a silent gap | No code change — add a one-line comment at `schema.ts:757-762` and in `applyMerge`'s doc header naming this as accepted staleness |
| `artifact.knowledge_ids` | **Fold-owned, LIVE** (flipped 2026-06-28) | **Deferred, out of scope** — reasoning strengthened: not just "curated allowlist edit," but genuinely event-owned; a future writer here must follow the same event-native pattern as `knowledge_edge`, not repeat the original F1 mistake | Not touched this pass |
| `learning_record.knowledge_ids` | Append-only fact | Never rewritten (**unchanged**) | Not touched |

### Concrete diff-level plan

**`proposals.ts` — `applyMerge` signature change** (needed to thread the repair log up to the accept event):

```ts
export type MergeRepairEntry = {
  from_id: string;
  question_ids_rewritten: string[];
  learning_item_ids_rewritten: string[];
  goal_ids_rewritten: string[];
  edges_rewired: Array<{ old_edge_id: string; new_edge_id: string | null /* null = archived-as-duplicate */ }>;
  mastery_state: 'noop' | 'renamed' | 'frozen';
  fsrs_state: 'noop' | 'renamed' | 'frozen';
  axis_state: 'noop' | 'renamed' | 'frozen';
  kc_typed_state: 'noop' | 'renamed' | 'frozen';
  misconception_edges_rewritten: string[];
};

export async function applyMerge(
  db: DbLike,
  payload: MergePayload,
  now: Date = new Date(),
): Promise<MergeRepairEntry[]> {
  // ...existing into-row check + archive loop (unchanged)...
  const repairLog: MergeRepairEntry[] = [];
  for (const fromId of payload.from_ids) {           // deterministic: payload.from_ids array order
    repairLog.push({
      from_id: fromId,
      question_ids_rewritten: await rewriteKnowledgeReferenceArray(tx, question, 'knowledge_ids', fromId, payload.into_id),
      learning_item_ids_rewritten: await rewriteLearningItemKnowledgeIds(tx, fromId, payload.into_id, now),
      goal_ids_rewritten: await rewriteGoalScopeOnMerge(tx, fromId, payload.into_id, now),
      edges_rewired: await rewireKnowledgeEdges(tx, fromId, payload.into_id, now),
      mastery_state: await retireMasteryStateOnMerge(tx, fromId, payload.into_id),
      fsrs_state: await retireFsrsStateOnMerge(tx, fromId, payload.into_id),
      axis_state: await retireLearnerAxisStateOnMerge(tx, fromId, payload.into_id),
      kc_typed_state: await retireKcTypedStateOnMerge(tx, fromId, payload.into_id),
      misconception_edges_rewritten: await rewireMisconceptionEdgeTargets(tx, fromId, payload.into_id),
    });
  }
  // ...existing merged_from append (unchanged)...
  return repairLog;
}
```

**`acceptProposal`'s `'merge'` case** (`proposals.ts:702-711`) — capture the log, thread onto the accept event:

```ts
case 'merge': {
  const repairLog = await applyMerge(tx, apply, now);
  result = { kind: 'merge_applied', into_id: apply.into_id, archived_ids: apply.from_ids };
  mergeRepair = repairLog;                          // new outer-scope var
  break;
}
```

Then at the `rate=accept` `writeEvent` call (`proposals.ts:779-796`):
```ts
payload: {
  rating: 'accept',
  ...(materializedIds ? { materialized_ids: materializedIds } : {}),
  ...(mergeRepair ? { merge_repair: mergeRepair } : {}),
},
```
Confirmed additive-safe (§1, `RateEvent`/`writeEvent` finding) — but per Attack A/B convergence, also **explicitly widen `RateEvent.payload`** in `known.ts:279-286` with an optional `merge_repair` field, matching the existing `materialized_learning_item_id`/prior-state-capture precedent style, rather than relying on implicit passthrough.

**After the merge-specific rewrites, invoke the touched entities' own parity/consistency machinery**, in the same tx, before the accept event:
```ts
for (const itemId of touchedLearningItemIds) {
  await assertLearningItemAcceptParity(tx, itemId);   // parity.ts:723 region, dev/test throw
}
// goal: no separate assert needed — reusing the existing writer function IS the parity guarantee
// (same event + same imperative write the existing writer already produces)
```

**New per-surface functions** (signatures):
```ts
// src/server/mastery/state.ts
export async function retireMasteryStateOnMerge(tx: Tx, fromId: string, intoId: string): Promise<'noop'|'renamed'|'frozen'>

// src/server/fsrs/state.ts
export async function retireFsrsStateOnMerge(tx: Tx, fromId: string, intoId: string): Promise<'noop'|'renamed'|'frozen'>

// src/server/calibration/axis-writer.ts
export async function retireLearnerAxisStateOnMerge(tx: Tx, fromId: string, intoId: string): Promise<'noop'|'renamed'|'frozen'>

// src/server/conjectures/typed-state.ts
export async function retireKcTypedStateOnMerge(tx: Tx, fromId: string, intoId: string): Promise<'noop'|'renamed'|'frozen'>
```
Each: acquire the module's advisory lock for **both** `fromId` and `intoId` in sorted string order (mirrors `state.ts:745-747`'s own deadlock-avoidance pattern) → `SELECT` both rows → if neither exists, `noop`; if only `fromId`'s row exists, `UPDATE ... SET subject_id = intoId WHERE subject_id = fromId` (`renamed`); if both exist, leave both untouched, log `frozen`.

**New backfill script**: `scripts/backfill-merge-attribution.ts`, calling the SAME retire/rewrite functions above (not raw table writes) — this keeps it inherently guard-compliant (no `mastery_state` allowlist edit needed, since the guard already exempts `src/server/mastery/`) and reuses the merge-chain-resolution logic once (walk `merged_from[]` to the terminal live winner — see §4 Decision Point 4b).

---

## 3. RECONCILIATION LEDGER

| # | Source | What it claimed | Verified? | What changed in the final shape |
|---|---|---|---|---|
| 1 | **Attack A F1 / Attack B MAJOR-1** | `knowledge_edge` is fold-owned and LIVE (`PROJECTION_IS_WRITER=1`); raw endpoint `UPDATE` is invisible to the fold and gets resurrected on rebuild | **CONFIRMED** — `docker-compose.mac.yml:16,21` + fold event vocabulary has no rewire-endpoint event | Mechanism for `knowledge_edge` changed from raw UPDATE to event-native archive+create, mirroring the real in-repo precedent `applyEdgeSupersede` (`propose_edge.ts:733-825`), plus a synchronous `checkEdgeTopology` gate. Decision Point 5 (collision handling) mostly dissolves — delegated to `createKnowledgeEdge`'s existing `23505` handling + the topology gate, rather than bespoke logic |
| 2 | **Attack A F1 / Attack B MAJOR-2** | `goal.scope_knowledge_ids`/`learning_item.knowledge_ids` are fold-truth snapshot columns whose gathers explicitly exclude merge events; raw UPDATE creates permanent fold drift and blocks worklist #5's B3 gate | **CONFIRMED** — `gather.ts:154-155,262` say "NO Q3 merge(d)-into" verbatim; `sot-flag.ts:76-81` confirms both flags OFF but independently flippable | Goal: switched to reusing the existing `experimental:goal_scope_update` event/writer (near-zero new code). Learning_item: switched to extending `gather.ts`'s Q3 (reusing the *already-existing* `experimental:knowledge_merge` event, mirroring the node fold's own Q3) + reducer branch + invoking the existing per-entity parity assert. This is now a **prerequisite for worklist #5**, not a blocker of it (see §7) |
| 3 | **Attack A F2** | `learner_axis_state` — same shape as `mastery_state`, omitted from the decision table entirely; "Full" scope claim was false | **CONFIRMED** — `schema.ts:1072-1095` unique(subject_kind,subject_id), single writer `axis-writer.ts` with its own advisory lock | Added `retireLearnerAxisStateOnMerge` as a new row/function, same 3-case treatment as mastery/fsrs |
| 4 | **Attack A F2 (minor)** | `learning_session.scope_knowledge_ids` unclassified | **CONFIRMED** unclassified in the original design | Added as an explicit "leave stale, session-ephemeral" decision — no code change, but no longer silent |
| 5 | **Attack A F3 / Attack B MAJOR-3** | Retire functions take zero advisory locks; async pg-boss grading (`updateThetaForAttempt`) can race the merge tx and resurrect an archived subject_id via `onConflictDoUpdate`'s INSERT branch | **CONFIRMED** — `mastery_state`'s `onConflictDoUpdate` (`state.ts:171`) does insert-on-absence; the `fsrs:knowledge:<id>` lock namespace is real and shared; `axis_state:`/`kc_typed:` locks are real | Added lock acquisition to all four retire functions (mastery+fsrs share `fsrs:knowledge:<id>`; axis and kc_typed each get their own namespace), sorted-both-ids ordering. **Residual risk not fully closed by locking alone** (a worker whose `knowledgeIds` argument was resolved from a stale pre-merge read will still, after the lock releases post-merge-commit, write a fresh row keyed to the now-archived `fromId` — because the grading path itself is out of this fix's blast radius). Mitigation: promote the backfill predicate from a pure one-time script to **also** a low-frequency recurring report-only sweep (Decision Point 4, revised) |
| 6 | **Attack A Finding 4** | "`unmergeKnowledge()` is reconstructable" overstates what the breadcrumb provides — sequential θ̂/FSRS fits aren't decomposable; the codebase's own precedent (`cascade-revert.ts`) is exactly this kind of theater | **CONFIRMED** reasoning is sound; not independently re-derived but the underlying facts (θ̂ sequential-fit non-decomposability, zero live cascade-revert callers) are consistent with everything else verified | Red-line check 3 relabeled: "forensic audit trail enabling manual repair," not "reversibility." Under the F1 correction, `knowledge_edge` changes get real reversibility for free from the event log — the breadcrumb for edges only needs touched-ids, not full snapshots |
| 7 | **Attack A "over/under-built" verdict** | Sync in-tx is right; async/redirect would be over-build; the design is under-built on 3 axes (F1, F2, F3) | Agreed | No change to the core Shape-1-over-Shape-2/3/4 choice — only the per-surface mechanism inside Shape 1 |
| 8 | **Attack B "经验证成立" list** | Mid-tx crash safety, kc_dedup_nightly re-propose-of-archived-node handling, chained-merge propagation (sync path), event immutability, `merge_repair` additive-safety, backup/FK_ORDER, `audit:schema` non-impact, single-writer routing — all HOLD | **CONFIRMED**, independently re-verified rather than trusted (`applyMerge`'s single tx, `writeEvent`'s raw-payload storage, guard allowlist contents, single-caller grep) | No change — these parts of the design ship as originally written |
| 9 | **Beyond both attacks** (this pass) | Neither attack traced `applyEdgeSupersede` as the concrete in-repo precedent for edge rewrite, nor confirmed `checkEdgeTopology` runs synchronously at write time (both only argued abstractly for "route through events") | New finding this pass | `rewireKnowledgeEdges` now has a concrete, cite-able shape to implement against instead of an open design question |
| 10 | **Register's own target shape (§1)** | `master-register.md:454` item (4) already required "routed through the projection/event layer" — the design as originally written violated its own grounding document | **CONFIRMED** | This is the meta-lesson: both attacks essentially rediscovered a requirement the design's own source document already stated. Register item (2) ("additive merge... reconcile theta_hat" for mastery_state) was **knowingly NOT adopted** — freeze-and-log stays the recommendation, because both attacks independently re-confirmed the "no invented merge math at n=0/n=1" reasoning holds; this is a deliberate, attack-surviving deviation from the register's own suggested shape, flagged here for transparency |

---

## 4. DECISION POINTS (owner-vetoable; autonomy granted — proceeding on defaults absent veto)

| # | Decision | Recommended default | Severity |
|---|---|---|---|
| 1 | Scope width | **Full**, mechanism now mixed (imperative for question/mastery/fsrs/axis/kc_typed/misconception_edge; event-native for goal/learning_item/edge) — unchanged conclusion from design, corrected mechanism | MAJOR |
| 2 | `mastery_state`/`fsrs`/`axis`, both-sides-have-evidence case | **Freeze-and-log**, now with advisory locks. Register's own suggested "additive/reconcile theta_hat" shape explicitly rejected — both attacks independently reconfirm no-invented-math holds at n=0/n=1 | MAJOR |
| 3 | `artifact.knowledge_ids` | **Defer.** Reasoning strengthened: it's genuinely event-owned (LIVE since 2026-06-28), so a future pickup must follow the `knowledge_edge` event-native pattern, not treat it as a simple allowlist edit | Mechanical-leaning |
| 4 | Retroactive repair delivery | **One-time manual script** (`scripts/backfill-merge-attribution.ts`) for pre-fix history **PLUS a low-frequency recurring report-only sweep** (embed_backfill-shaped, same predicate) as a safety net for the residual async-grading race (§3 row 5) that in-tx locking cannot fully close without touching the grading path itself, which is out of this fix's blast radius | **Revised to MAJOR** — this is a real, load-bearing addition, not mechanical |
| 4b | Backfill chain resolution | Must walk `merged_from[]` to the **terminal live winner** (loser→winner→further-merged-winner chains), and define behavior when the terminal node is itself archived-not-merged (treat as an already-inconsistent state, log and skip, do not guess) | Mechanical, but must be in scope (Attack B machine-6) |
| 5 | `knowledge_edge` rewrite failure modes | (a) Duplicate `(from,to,relation_type)` post-rewrite: delegate to `createKnowledgeEdge`'s existing `23505` handling → archive the old edge without creating the new one (no information loss, matches design's original intent, now event-legible). (b) ADR-0034 topology reject (cycle/direction contradiction) on the rewritten edge: **abort the whole merge tx** (recommended — safest, surfaces the conflict to the human at accept time, consistent with "no invented math / no silent corruption"). Alternative (archive-and-drop the conflicting edge silently) is available if the owner finds aborts too disruptive in practice | MAJOR (a reasonable engineer might expect the richer "combine weights" behavior instead — explicitly rejected, matches "don't invent merge math") |
| 6 | `merge_repair` payload shape | As specified in §2 (`MergeRepairEntry[]`), plus explicit `RateEvent.payload` schema widening (not implicit passthrough) — matches the existing `materialized_learning_item_id` precedent style | Mechanical |
| 7 | Compensating `unmergeKnowledge()` | **Defer the function; capture the log now** (data cannot be added retroactively if missed). Label as "forensic audit trail enabling manual repair," not "reversibility" (Attack A Finding 4) | MAJOR only in that it commits future work |
| 8 | `learning_item`/`goal` parity-assert invocation at merge time | **Yes, invoke it** (dev/test throw) for every touched id, matching the existing accept-time A2b philosophy — catches a gather/reducer bug immediately rather than waiting for the eventual B3-flip audit | MAJOR — this is what actually satisfies the register's requirement (4) rather than just gesturing at it |

---

## 5. TEST PLAN

### Partitions
- New/extended pure-fold-logic tests (Q3 extension, reducer branch) → `pnpm vitest run --config vitest.unit.config.ts` (no DB): `src/core/projections/learning_item.test.ts`.
- Everything touching `db.transaction`/real Postgres → `pnpm vitest run --config vitest.db.config.ts`.

### New / extended tests
1. **`src/capabilities/knowledge/server/proposals.db.test.ts`** — extend the existing `describe('applyMerge', ...)` block (`:452-533`, 5 tests today). Add: question/learning_item/goal rewrite+dedupe assertions; `knowledge_edge` rewire including duplicate-collision-archive and topology-reject-aborts-whole-tx cases; `kc_typed_state` keyed-row + pointer rewrite; `misconception_edge.to_id` rewrite (direct function test, promotion writer stays flag-dark); **multi-`from_id` ordering test** — two `from_ids` both carrying `mastery_state`, merging into a cold `into_id`, assert first-array-order renames and second freezes deterministically. All 5 existing tests must keep passing unmodified in shape.
2. **`src/server/mastery/state.db.test.ts`** (or equivalent) — new 3-case matrix for `retireMasteryStateOnMerge` (noop/renamed/frozen) + a lock-contention test (concurrent `updateThetaForAttempt` call for the same `fromId` blocks until the merge tx commits, then resolves against the post-rename state).
3. **`src/server/fsrs/state.db.test.ts`** — symmetric 3-case matrix for `retireFsrsStateOnMerge`.
4. **`src/server/calibration/axis-writer.db.test.ts`** *(NEW file if none exists)* — 3-case matrix for `retireLearnerAxisStateOnMerge`.
5. **`src/server/conjectures/typed-state.db.test.ts`** — 3-case matrix + pointer-rewrite test for `retireKcTypedStateOnMerge`.
6. **`src/core/projections/learning_item.test.ts`** — pure fold test: a `learning_item` whose Q1 genesis knowledge_ids include a subsequently-merged KC id folds to the rewritten `into_id` after the Q3 clause consumes `experimental:knowledge_merge`.
7. **`src/server/projections/learning_item.db.test.ts`** / **gather.db.test.ts** — gather-level integration: seed an `experimental:knowledge_merge` event with `from_ids` containing the item's KC, assert the new Q3 clause returns it.
8. **`merge_repair` event-payload test** — the `rate=accept` event for a merge carries `merge_repair` with all 9 touched-surface fields, and `parseEvent`/`writeEvent` round-trip preserves it (regression-anchors the raw-payload-storage assumption in §1).
9. **Backfill script test** — seed a pre-fix-shaped orphan (archived KC + stale `question.knowledge_ids`/`mastery_state` on the old id), run the script, assert correctness; run twice, assert second run is a no-op (idempotency); seed a 2-hop `merged_from` chain and assert terminal-winner resolution (Decision Point 4b).

### Regression anchors — enumerate ALL fixtures assuming old orphaning behavior (YUK-539 lesson: CI-full-suite consumers, not just targeted files)
- **`src/capabilities/knowledge/jobs/kc_dedup_nightly.db.test.ts`** — the "never calls `applyMerge`" IRON RULE test must stay green; this fix is entirely on the accept side, structurally untouched.
- **`src/server/projections/gather.db.test.ts`** — has a fixture with `merged_from: []` (`:47`, confirmed) — verify it's not asserting an *absence* of Q3 behavior for goal/learning_item that the new Q3 clause would now trip; audit and update if so.
- **`src/core/projections/goal.test.ts`**, **`src/server/projections/goal.db.test.ts`** — confirmed zero references to `experimental:knowledge_merge` today (grep-verified), so adding merge-awareness to `learning_item`'s gather is additive to goal's own gather only if goal also gets a Q3 (it doesn't — goal reuses the existing writer instead, §2), so these should be unaffected; run as a regression check regardless.
- **`src/core/projections/learning_item.test.ts`**, **`src/server/projections/learning_item.db.test.ts`** — same "zero references today" status (grep-verified) — the new Q3 clause is additive, but re-run in full since this file is directly modified.
- **`src/core/projections/knowledge.test.ts`**, **`src/server/projections/knowledge.db.test.ts`** — the ONLY existing consumers of `experimental:knowledge_merge` today; must stay green (Q3 logic there is unchanged by this fix — the event is *shared*, not modified).
- **`src/capabilities/knowledge/server/proposals.db.test.ts`**'s `describe('acceptProposal — PR-A2b projection parity', ...)` (`:694+`) and `describe('acceptProposal — PR-B full flip...', ...)` (`:996+`) — the merge branch now does more work inside the same tx that `affectedNodeIds`/`assertAcceptParity`/`projectKnowledgeNodeGuarded` wrap around; these must stay green to confirm the new writes don't perturb the existing node-level parity/flip machinery.
- **`tests/integration/step9-invariant-audit.test.ts`** — full re-run: confirms all four new retire-function call sites resolve inside their designated single-owner modules (zero new violations), and confirms the backfill script does NOT need a `mastery_state` allowlist edit (it calls through `src/server/mastery/state.ts`, which is already allowed).
- **`src/capabilities/knowledge/server/edges.db.test.ts`** (or equivalent for `edges.ts`) and **`src/capabilities/knowledge/server/propose_edge.db.test.ts`** — `createKnowledgeEdge`/`archiveKnowledgeEdge` and the topology-gate call get a new caller (`rewireKnowledgeEdges`); their own unit/db tests are unaffected in shape but should be re-run since the functions gain a new invocation pattern (merge-triggered, not just propose/reconcile-triggered).
- **`src/core/projections/knowledge_edge.test.ts`**, **`src/server/projections/knowledge_edge.db.test.ts`** — confirm the fold still correctly reproduces edges created/archived via the merge-driven path (same event vocabulary, no new event shape, so should be transparent — but this is the highest-risk regression surface given `PROJECTION_IS_WRITER=1` is live).
- **`docs/design/2026-07-02-project-logic-master-register.md`** is not a test but should get a one-line addendum once this ships (the entry currently says "CONFIRMED question.knowledge_ids never rewritten" — becomes stale the moment this lands).

### Full gate (unchanged from CLAUDE.md)
`pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm audit:draft-status && pnpm audit:relations && pnpm test && pnpm build`. No new columns/migration — confirm explicitly during implementation review (unchanged from design; still true after this reconciliation).

---

## 6. RED-LINE CHECK

1. **Single-writer fs-walk guard** (`mastery_state`/`material_fsrs_state`) — satisfied: new writes route through `src/server/mastery/state.ts`/`src/server/fsrs/state.ts` exclusively; `learner_axis_state`/`kc_typed_state` route through their existing owner modules (`axis-writer.ts`/`typed-state.ts`), consistent with the guard's spirit even though those two tables lack a *hard* step9 check today. Re-run `step9-invariant-audit.test.ts` as acceptance.
2. **"misconception/theta-hat never write mastery"** — satisfied: `retireMasteryStateOnMerge` performs exactly noop/rename/freeze; never invokes `updateThetaForAttempt`, never computes a new θ̂. Unaffected by the F1 edge-mechanism correction.
3. **"Evidence-first: AI actions traceable and reversible"** — satisfied at the "traceable" clause; **corrected at "reversible"** per Attack A Finding 4: the `merge_repair` breadcrumb is a **forensic audit trail enabling manual repair**, not a guarantee of clean reversal (sequential θ̂/FSRS fits aren't decomposable post-merge). `knowledge_edge` changes are the one surface with genuine event-log reversibility, as a side effect of the F1 mechanism correction.
4. **"Structure timeless"** — satisfied: `learning_record.knowledge_ids` never rewritten; `learning_session.scope_knowledge_ids` explicitly left stale (documented, not silent).
5. **NEW — register's own target-shape requirement (4)** — "routed through the projection/event layer so `assertAcceptParity` stays valid across SoT-flip" — this is now genuinely satisfied for `knowledge_edge`/`goal`/`learning_item`, where the original design violated it.

---

## 7. BLAST RADIUS + SEQUENCING

### Touched
`src/capabilities/knowledge/server/proposals.ts` (`applyMerge` signature + new helper calls), `src/server/mastery/state.ts` (+`retireMasteryStateOnMerge`), `src/server/fsrs/state.ts` (+`retireFsrsStateOnMerge`), `src/server/calibration/axis-writer.ts` (+`retireLearnerAxisStateOnMerge`), `src/server/conjectures/typed-state.ts` (+`retireKcTypedStateOnMerge`), `src/server/projections/gather.ts` (+Q3 clause for learning_item), `src/core/projections/learning_item.ts` (+reducer branch), `src/capabilities/agency/server/goals/queries.ts` (new call site, existing function), `src/capabilities/knowledge/server/edges.ts`/`topology-gate.ts` (new callers, existing functions), `src/core/schema/event/known.ts` (`RateEvent.payload` widened), new `scripts/backfill-merge-attribution.ts` (+ new recurring sweep registration), the 5 doc/comment locations in the design's §3.

### Not touched, deliberately
`applyReparent`/`applyArchive`/`applySplit` (out of scope, merge-only per register finding), `artifact.knowledge_ids` writers, `learning_record.knowledge_ids`, `due-list.ts`/`variant-rotation.ts`/`matcher.ts`/`target-discovery.ts`/`hub-mesh.ts`/`node-page.ts` (zero reader-side changes — unchanged from the design, correctly unchallenged by either attack).

### vs. worklist #5 / YUK-471 SoT-flip
**Corrected relationship** (Attack B's MAJOR-2 was right that the *original* imperative-rewrite design would have blocked worklist #5; the corrected event-native design *reverses* this):
- Worklist #5 flips `learning_item`'s `PROJECTION_IS_WRITER_LEARNING_ITEM` flag once its B3 gate (`audit:projection` CLEAN on a prod-clone) passes. Its gate can **never** clear if the fold's event vocabulary has no way to reproduce a merge-driven `knowledge_ids` change — because any historical or future accepted merge leaves a permanently unreproducible row.
- This fix's `gather.ts` Q3 extension + reducer branch for `learning_item` is therefore not merely non-blocking — it is a **structural prerequisite** for worklist #5's B3 gate to be clearable at all, regardless of whether it lands now or later. Landing it now (alongside this fix, while the merge-accept path is already being touched) is strictly cheaper than landing it as a surprise dependency discovered mid-#5.
- Same reasoning applies to `goal`'s eventual SoT flip, though the register doesn't currently schedule it as "next."
- `knowledge_edge`'s flag is already ON — the F1 correction is not preparatory, it is fixing an **active, live** correctness gap (every merge since the W1 flip that touched an edge endpoint has silently created a fold-irreproducible row). This should be flagged to the owner as the single highest-urgency element of this fix, higher than the register's own P1 framing suggests, precisely because it's the one surface where the bug is already live in production, not latent behind an OFF flag.

### vs. other YUK-471 waves
No interaction with `PROJECTION_IS_WRITER_ARTIFACT`/`_QUESTION_BLOCK` (already ON, untouched — Decision Point 3 defers that surface). No interaction with `mistake_variant`'s own flag/B3 gate (not a merge-touched surface).

---

## 8. F3 REUSABLE CHECKLIST (for `re-embed-on-merge-cross-cutting-gap`, note dedup)

1. **Classify by fanout+mutability AND by fold ownership** (the axis this reconciliation added): small-fanout mutable typed column → sync same-tx rewrite *only if imperative*; if fold-owned, rewrite must go through the entity's existing event vocabulary (reuse an existing event+writer if one exists — check first, as `goal`'s did) or extend the fold's gather with a Q3-shaped containment clause mirroring `gather.ts:116-129`. Per-subject fitted aggregate → identity-rename-if-cold/freeze-and-log-if-both, never blind-combine, always take the entity's existing advisory-lock namespace (find it before inventing a new one — check for a *shared* namespace across mastery/fsrs-shaped tables first). Graph edges → archive-old+create-new through the existing propose/accept event path, not raw endpoint UPDATE; check for a synchronous structural-consistency gate (topology, uniqueness) at write time and decide abort-vs-partial-drop up front. Append-only fact → never rewritten.
2. **Before finalizing a mechanism, grep the target grounding doc (register/ADR) for an already-stated target shape** — this reconciliation's single largest correction was rediscovering a requirement (`master-register.md:454` item 4) the design's own source document already specified.
3. **Check for a live precedent in-repo before inventing a new pattern** — `applyEdgeSupersede` already existed as the exact shape needed for edge rewrite; this reconciliation found it by grepping for the tool names referenced in an unrelated guard-test comment.
4. **Do the rewrite inside the same tx as the absorb mutation, not async, unless fanout is genuinely unbounded** — but add a low-frequency recurring *report-only* sweep as a safety net for any residual race with an *independent async writer* (background grading, in this case) that in-tx locking narrows but cannot fully close without touching that writer's own resolution logic.
5. **Ship a durable, complete-enough repair log at absorb time**, even without a compensating "unreverse" function — label it a forensic audit trail, not reversibility, unless the surface genuinely gets reversibility for free (event-log-backed surfaces do).
6. **Add or extend a static drift/single-writer guard** for every new retire/rewrite call site — and if the target table has no hard guard yet (like `kc_typed_state`/`learner_axis_state` here), route through its existing single-owner module anyway, and flag the guard gap as a separate small follow-up.

---

**Files read/verified this pass** (all against HEAD `9ef22630`): `src/capabilities/knowledge/server/proposals.ts`, `src/capabilities/knowledge/server/dedup-flags.ts`, `src/capabilities/knowledge/server/edges.ts`, `src/capabilities/knowledge/server/propose_edge.ts`, `src/capabilities/knowledge/server/topology-gate.ts`, `src/capabilities/knowledge/jobs/kc_dedup_nightly.ts`, `src/capabilities/knowledge/manifest.ts`, `src/capabilities/agency/server/goals/queries.ts`, `src/db/schema.ts`, `src/server/mastery/state.ts`, `src/server/fsrs/state.ts`, `src/server/calibration/axis-writer.ts`, `src/server/conjectures/typed-state.ts`, `src/server/projections/sot-flag.ts`, `src/server/projections/gather.ts`, `src/server/projections/parity.ts`, `src/core/projections/knowledge_edge.ts`, `src/core/projections/learning_item.ts`, `src/core/projections/goal.ts`, `src/core/schema/event/goal-events.ts`, `src/core/schema/event/known.ts`, `src/server/events/queries.ts`, `tests/integration/step9-invariant-audit.test.ts`, `docker-compose.mac.yml`, `docs/adr/0045-unified-tagging-axis-match-or-propose.md`, `docs/design/2026-07-02-project-logic-master-register.md`.

---

# Appendix A — Attack Lens A 原文(ownership 轴,grounded @685b2c27)

# LENS A verdict: shape mostly right, but one architectural wrong-fix and one "full-isn't-full" hole — NOT clean

Verified at `685b2c27`. `applyMerge` (`src/capabilities/knowledge/server/proposals.ts:446-498`) confirmed writing only the two `knowledge` UPDATEs; guard locations, GIN index, `src/server/fsrs/state.ts` existence/single-writer status, and `kc_typed_state`'s absence from the fs-walk guard all check out as the design claims. The high-order shape choice survives: sync in-tx rewrite is the *minimal* correct mechanism at this fanout, and the Shape 2/3/4 rejections are sound. But two MAJOR findings and two MEDIUMs:

## FINDING 1 — MAJOR, wrong mechanism for 3 of 9 surfaces: imperative rewrite of fold-owned tables contradicts the live event-sourcing SoT

The design's decision table classifies surfaces by fanout+mutability but misses the axis this codebase actually turns on: **row ownership (imperative vs event-fold projection, YUK-471)**. Verified:

- `knowledge_edge` is **already projection-written in the owner's live deployment**: `PROJECTION_IS_WRITER: "1"` in `docker-compose.mac.yml:16,21` (app+worker), and `src/server/projections/sot-flag.ts` states the global flag covers knowledge/knowledge_edge, "flipped LIVE when W1's B3 gate cleared." The edge fold rebuilds rows solely from edge events keyed on edgeId (`src/server/projections/knowledge_edge.ts` header; `gather.ts:288` — "NO Q3 merged-into"). An imperative `rewireKnowledgeEdges` UPDATE is invisible to the event log: `pnpm audit:projection` (the designated drift detection on the ON path) goes permanently dirty, and any later re-fold/write-through **resurrects the archived from_id endpoint** — the fix itself becomes a new silent-corruption vector.
- `goal.scope_knowledge_ids` and `learning_item.knowledge_ids` are **fold-truth snapshot columns** (`src/server/projections/goal.ts:77,91` — "every column is fold truth"; `learning_item.ts:90,110` — knowledge_ids not in the excluded list), and their gathers explicitly exclude knowledge-merge events (`gather.ts:155,262`). Flags are OFF today, but per `sot-flag.ts` the OFF path runs the A2b parity assert (fold == row) at imperative write sites — so the next goal/item mutation on a merge-rewritten row throws in dev/test, and the goal/learning_item B3 flip gates (require `audit:projection` CLEAN) become **unclearable**, blocking the YUK-471 roadmap.

The design's blast-radius claim — "the SoT-flip projection machinery… untouched because it only reproduces `knowledge` rows and this fix's writes sit entirely outside that fold's scope" — is **false**. Correct shape for these three: express the rewrite as events — for edges, archive-old + create-new through the existing edge event path (which also **dissolves the bespoke unique-collision/self-loop handling**: the create path's validation already owns that, so Decision Point 5 mostly evaporates); for goal/learning_item, either a retag event their reducers consume or a merge Q3 in their gathers mirroring the node fold's `payload->'from_ids'` containment scan (`gather.ts:116-125` is the in-repo precedent). The backfill script hits the same constraint for edges. `question.knowledge_ids` is genuinely imperative (no question fold; not in `PER_ENTITY_FLAG_ENV`) — the direct rewrite is fine there.

## FINDING 2 — MAJOR, the "Full" scope claim isn't full: `learner_axis_state` omitted

`learner_axis_state` (`src/db/schema.ts:1072-1097`): unique `(subject_kind default 'knowledge', subject_id)`, per-KC fitted aggregate (DDM drift/boundary/Ter), live single writer `src/server/calibration/axis-writer.ts` (advisory lock `axis_state:<kind>:<id>`, :121). This is exactly the `mastery_state` shape and needs the same identity-rename/freeze treatment via a function in its owner module — yet it appears nowhere in the decision table. The design's own Decision-Point-1 argument ("leaving some surfaces silently stale is the exact bug being fixed") recoils on it. Lesser unclassified stragglers: `learning_session.scope_knowledge_ids` (`schema.ts:757-762`, live-read server-side by the placement /next route during an active probe — probably "leave, session-ephemeral," but it was never classified) and `memory_brief_note.subject_id` (regenerable cache). The §4 checklist's step 1 ("classify every reference surface") failed in its flagship application, and the checklist itself lacks the ownership axis from Finding 1 — add it.

## FINDING 3 — mastery_state handling HOLDS, minus one MEDIUM gap (advisory locks dropped)

Attacked hardest, as instructed; it survives:
- **Guard**: retire fns in `src/server/mastery/` / `src/server/fsrs/` are exactly where the fs-walk guard requires (`tests/integration/step9-invariant-audit.test.ts:156-178` verified; `src/server/fsrs/state.ts` exists and is the sole live `material_fsrs_state` writer). No trip.
- **No invented math**: rename/freeze only. Confirmed no θ̂ computation anywhere in the proposal.
- **No silent discard**: frozen rows are retained + logged, and I verified they're **inert** — every live `mastery_state` reader is subject_id-keyed off rewritten sources (`state.ts:807-815` `inArray(knowledgeIds)` from question tags; `personalized-difficulty.ts:545-555` keyed; no unkeyed aggregate scan exists), and `ability_global` rows are a separate subject_kind, incrementally written, dark (HIERARCHICAL_ELO default OFF). The honest cost — winner's θ̂ ignores loser's history — is the right n=1 trade; the Shape-4 rejection is well grounded.
- **Gap (MEDIUM)**: the dossier's own requirement that merge-repair "would need to acquire the `mastery:`/`fsrs:` namespace locks" is silently dropped — the red-line check never mentions locks. n=1 ≠ single process: pg-boss worker grading (paper-submit / quiz_verify) can upsert a from_id-keyed row concurrently with the accept tx; `onConflictDoUpdate` **inserts** on absence, resurrecting the orphan after rename, and the one-time backfill won't catch post-run resurrections. Cheap fix: take the same namespace locks in the retire fns (`axis_state:` too, per Finding 2) and state that the idempotent backfill doubles as a re-runnable audit.

## FINDING 4 — MEDIUM: unmerge story is half real, half theater — label it honestly

The breadcrumb capture is real, correctly timed (can't retrofit), and mechanically safe (folds read only specific payload keys — `rating`/`materialized_ids`; payloads are plain `Record<string, unknown>`, no strict parse — extra `merge_repair` key is additive-safe; "no migration needed" claim holds). But "a future `unmergeKnowledge()` is reconstructable" overstates: (a) post-merge θ̂/FSRS evolution under into_id pools both evidence streams — sequential fits aren't decomposable, so snapshot-restore discards post-merge evidence; (b) blind before-snapshot restore clobbers post-merge edits to the arrays; (c) the codebase's own precedent is exactly this theater — `cascade-revert.ts`, zero live callers, A-class unreachable. Ship the breadcrumb, but call it a **forensic audit trail enabling manual repair**, not reversibility. Under Finding 1's correction, edge rewrites-as-events get real reversibility free from the event log, shrinking what the breadcrumb must carry.

## Direct answers

- **Over-built?** No. Sync in-tx is right for n=1; redirects/async would be the over-build. Dark `misconception_edge` wiring matches the owner's dark-ship doctrine. The one over-built piece (edge collision machinery) is a symptom of the wrong mechanism, not gold-plating.
- **Under-built?** Yes, three ways: fold-owned surfaces need events not UPDATEs (F1), `learner_axis_state` missing (F2), advisory locks dropped (F3).
- **Silent data-loss window?** Shape 1 introduces none (atomic tx) — but as written, F1's clobber-back is a *new* silent corruption vector, and F2 leaves one live aggregate surface exactly as orphaned as the bug being fixed.

**Required revisions before implementation**: (1) split the decision table by ownership — event-native rewrites for knowledge_edge/goal/learning_item; (2) add `learner_axis_state` row + classify learning_session.scope_knowledge_ids; (3) add namespace advisory locks to the retire functions; (4) rename "reversibility" to "audit trail" in red-line check 3; (5) fix the blast-radius SoT-flip claim, which is currently false.

---

# Appendix B — Attack Lens B 原文(event-sourcing 轴,grounded @685b2c27)

# LENS B 对抗审查结论：设计不成立（3 个 MAJOR 漏耦合 + 2 个漏面 + 1 个机械缺口）；部分场景经验证成立

全部结论已在 `/Users/yukoval/yukoval-projects/the-learning-project` @ HEAD `685b2c27` 逐条 code-ground。

---

## MAJOR-1：`rewireKnowledgeEdges` 直接与**已 LIVE 的 knowledge_edge fold** 打架 —— 设计的 blast-radius 声明事实性错误

- 设计声称「SoT-flip projection machinery…untouched because it only reproduces `knowledge` rows」。**假**。`src/server/projections/sot-flag.ts:26-27` 白纸黑字：「The bare `PROJECTION_IS_WRITER` global flag gates ONLY knowledge **/ knowledge_edge** — it was flipped **LIVE** (=1, docker-compose.mac.yml)」；`docker-compose.mac.yml:16,21` 确认 app+worker 两容器均 `PROJECTION_IS_WRITER: "1"`（register 已确认 mac compose 就是当前生产）。
- knowledge_edge fold 的事件词汇表**只有** `experimental:genesis` / `generate(edge_op:create)` / `generate(edge_op:archive)`（`src/core/projections/knowledge_edge.ts:137-186`）——**不存在「改端点」事件**。设计的命令式端点 UPDATE + 命令式 archive-as-duplicate/self-loop 写出 fold 无法复现的行：`pnpm audit:projection`（flag-ON 路径唯一的漂移 oracle，sot-flag.ts:9-10）必报 drift；任何 fold rebuild 会**回滚 rewire、复活指向已归档 loser 的悬挂边**。
- 正确机制必须走事件层：旧边发 `generate(archive)` + 新边 id 发 `generate(create)`（走既有 wired chokepoint）。这恰是 register 自己的 target shape 第 (4) 条（`master-register.md:454`「routed through the projection/event layer so `assertAcceptParity` stays valid across SoT-flip」）——设计在 §1 只反驳了「读时重定向」的 Shape 3，**从未论证就丢掉了「写时走事件层」这条要求**。
- 附带漏掉的失效模式：**topology-gate 拒绝**。把 prerequisite 边重指到 `into_id` 可能制造 cycle / direction contradiction；fold-apply 对 reject **无条件 THROW**（knowledge_edge.ts ADR-0034 段 + register:580「prod-live, unconditionally-throwing fold-apply path」）。合并两个语义相近 KC 恰是边最可能互相矛盾的场景——设计只处理了 duplicate/self-loop 两种碰撞，事件化后一次 cycle-creating rewire 会让整个 accept tx 中止；命令式路径则会静默造出 gate 本应拒绝的环。

## MAJOR-2：learning_item / goal 的命令式重写制造**永久 fold 漂移**，与 register worklist **#5 sequencing gate 正面相撞**

- `src/core/projections/learning_item.ts` 的 `knowledge_ids` **只来自 genesis seed**（:125），事件词汇 = genesis/complete/relearn/archive（:109-203）——没有任何 knowledge_ids 更新事件。`scripts/b3-gate.ts:9-10`：scoped genesis backfill「anchor only TRULY event-less rows; **Already-event-sourced rows are NOT anchored**」。因此：任何已有 genesis 锚的 learning_item 行被本设计命令式改写后 = fold≠row 且**永久不可调和** → learning_item 自己的 B3 gate（audit:projection 必须 CLEAN 才许翻）**永远过不去**。而 register worklist #5（`master-register.md:20,221,1183`，P1「hard sequencing gate」）明说 learning_item 是「explicitly next in the SoT-flip queue」——本设计恰好在那个窗口给它新增无事件来源的行写。
- goal 更直接：**正确的缝早就存在**——`experimental:goal_scope_update` 事件（`src/core/schema/event/goal-events.ts:58`，goal fold 在 `goal.ts:247` 消费，既有 writer 在 `src/capabilities/agency/server/goals/queries.ts:179`）。设计的「Same helper, reused」raw UPDATE 绕过它。goal 的 scope 重写应发该事件/调既有函数，而非通用数组 helper。
- 顺带：Decision Point 3 把 artifact 推迟说成「只是 allowlist 编辑」——artifact fold 已于 2026-06-28 翻 LIVE（docker-compose.mac.yml:17,22），未来补 artifact.knowledge_ids 重写时同样必须事件化，不是 allowlist 一改就完。

## MAJOR-3：与 in-flight 练习/判分的竞态会在修复后**重新孤儿化证据**，且一次性 backfill 接不住

- merge tx 不取任何 advisory lock（只有 version 检查 + propose 事件行 FOR UPDATE）。判分/attempt 写在 pg-boss **后台 worker** 异步跑：worker 在 merge 提交前读到 `question.knowledge_ids=[loser]` → merge 提交（改写 question、rename mastery/fsrs 行）→ worker 的 `upsertMasteryState` ON CONFLICT **insert 出一条全新 loser 键行** —— 修复上线之后产生的孤儿，UI 不可见（node-page/tree 过滤 archived），而修复脚本按 Decision Point 4 是**一次性手动跑**，永远扫不到它。单用户完全可能一边挂着后台判分一边在 inbox 点 accept。
- 反向也炸：rename UPDATE 撞并发插入的 winner 行 → `mastery_state_unique` 唯一违例 → 整个 accept 以裸约束错误中止（不是友好的 stale 错误）。
- Dossier §5 已明确提示「any per-surface merge-completion fix that touches mastery_state would need to acquire the `mastery:`/`fsrs:` namespace locks」——设计的 `retireMasteryStateOnMerge`/`retireFsrsStateOnMerge`/`retireKcTypedStateOnMerge` 规格里**一个锁都没提**（现成模式：`state.ts:745` `fsrs:knowledge:<id>`、`typed-state.ts:88` `kc_typed:`、`axis-writer.ts:121` `axis_state:`）。廉价互补招：把 backfill 谓词（「行仍引用 archived id」）常驻成 report-only 夜巡（设计自己点名的 embed_backfill 形状），而非一次性脚本。

## 漏面-4：`learner_axis_state` 完全不在决策表里（Decision Point 1 自称「Full」不成立）

`src/db/schema.ts:1052-1095`，每行键 `(subject_kind='knowledge', subject_id=kcId)`，单写者 `upsertLearnerAxisState`（`src/server/calibration/axis-writer.ts`），kc = `question.knowledge_ids[0]`。减刑情节：夜批**按 question 当前主 KC 全量重算**，question 重写落地后 winner 侧自愈；但 loser 键行「skipped, not deleted」→ 永久孤儿行喂给 placement-profile 展示面。至少需要一行 retire/delete 决策进表。

## 漏面-5：`learning_session.scope_knowledge_ids`（schema.ts:762，placement probe 作用域）

进行中的 placement probe 持有 loser id；merge 落地后 `/next` 的池查询 `question.knowledge_ids @> [loser]` 返回空 → 该 KC 静默饿死。仅 session 生命周期窗口，小——但应显式声明为「接受的 staleness」而非沉默（dossier 也漏了它）。

## 机械-6：backfill 脚本缺**链式解析**规格

pre-fix 合并链：loser A 的 winner B 可能后来又被 merge 进 C 或被 `applyArchive` 归档。`merged_from` 只在 winner 侧 → 每跳需反查，必须解析到**终端 live winner**，并定义终端节点是 archived-not-merged 时的行为。§6 测试计划无链式 case。

---

## 经验证**成立**的部分（点名场景逐条）

- **中途崩溃**：`applyMerge` 全程单 tx（在 acceptProposal 的 tx 内为嵌套 savepoint，proposals.ts:446-498 实读确认）；stale-throw 整体回滚，同步路径不存在 partial rewrite。成立。
- **kc_dedup_nightly 重提已归档节点**：扫描硬过滤 `a.archived_at IS NULL AND b.archived_at IS NULL`（kc_dedup_nightly.ts 主查询）+ 跨夜 `proposedPairKeys`；指向已归档 id 的 pending proposal 在 accept 时 throw stale 并被标 `status='stale'`（acceptProposal catch 分支实读确认），不会永久 pending。成立。
- **双合并链（同步路径）**：每次 accept 重写当时的活引用，A→B 后 B→C 自然传递；逆序 accept 抛 stale。成立（残留只在 backfill，见机械-6）。
- **事件历史不可变**：events/learning_record 不重写；loser knowledge 行归档保留，旧事件仍可 fold。成立。
- **merge_repair 面包屑可写入**：`writeEvent`（`src/server/events/queries.ts:1020`）用 `parseEvent` 校验但**存原始 payload**；`RateEvent` payload 是非 strict `z.object`（known.ts:279-287）→ 未知键通过校验、原样落库，fold 侧 safeParse 仅内存剥离。机械上可行；建议显式加宽 RateEvent（先例：retract 的 `materialized_learning_item_id` + prior-state capture 键就是显式建模的），别赖 strip-mode。注意 `applyMerge` 需改签名把 repair log 返给 acceptProposal（事件在 :779-796 才写）。
- **backup/restore FK_ORDER**：零新表、零 FK 变更（mastery/fsrs/axis/typed_state 均无 enforced FK），无 SCHEMA_VERSION bump。成立。
- **audit:schema**：零新列，新增 UPDATE writer 只会加强 write-path 覆盖；`scripts/audit-schema-writes.ts` 未见「allowlisted-但有写路径即 fail」逻辑（material_fsrs_state.subject_id 的旧 allowlist 条目至多是卫生问题）。成立。
- **单写者守卫路由**：设计把 mastery/fsrs 写正确收进 `src/server/mastery//src/server/fsrs/`；step9 守卫确实不覆盖 kc_typed_state/axis（实读 step9 测试确认）。`applyMerge` 唯一活调用方 = acceptProposal（全仓 grep 确认）。成立。

**总裁定**：设计的每表决策方法论和「不发明统计合并数学」立场是对的，但它把 register 自己 target shape 的第 (4) 条（写路径过 projection/event 层）无声丢弃，导致与**两个已 LIVE 的 fold（knowledge_edge、连带 artifact 前瞻）和下一个排队翻转的 learning_item（worklist #5 硬排序门）**正面冲突；外加无锁 retire 的判分竞态和两个漏枚举面。MAJOR-1/2/3 不修，此设计不应实施。

---

## Implementation decision ledger (YUK-543, 落地实测)

实施过程中对 §2 FINAL SHAPE 的偏离 / 加固，逐条记录（编号 + 原因 + 影响面）。全部随码提交，gate 全绿（typecheck / biome / audit:schema·partition·draft-status·relations / step9 / 新增+回归 db·unit 测试）。

1. **`MergeRepairEntry` schema 单源在 `known.ts`**（非 §2 diff 展示的 proposals.ts 裸 TS type）。原因：§2 要求「显式加宽 RateEvent.payload」——把 Zod schema + 派生 type 定义在 `known.ts`（`MergeRepairEntry` / `MergeRepairEntryT`），proposals.ts import `MergeRepairEntryT`，schema 与 type 单源不漂移。影响：`known.ts`、`proposals.ts`。

2. **learning_item gather Q3 抓 ALL `experimental:knowledge_merge` 事件（不按 seed KC containment 收窄）**。原因：merge 会链（A→B 后 B→C），按 item 的 seed KC 反查只命中一跳、漏第二跳→链式 merge 后 fold≠row、破 B3 gate。单用户工具 merge 事件稀少，全量抓廉价且链安全（reducer 只对相交的 merge 生效，非相交是 no-op）。影响：`gather.ts` learning_item gather + reducer 加 pass-1 accept 解析。**这是与 §2「containment Q3」字面措辞的实质偏离，但满足 §2 的语义意图（fold 复现 merge 改写）且更正确。**

3. **learning_item merge 改写只动 `knowledge_ids`（不 bump version/updated_at）**，imperative 与 reducer 双侧一致。原因：结构性归属修复（对齐 archive 分支的 no-bump），fold==row 平凡成立，避免 accept-`now` 与 genesis-`now` 时间戳对齐的复杂度。影响：`learning_item.ts` reducer 分支 + `proposals.ts` `rewriteLearningItemKnowledgeIds`。

4. **learning_item parity assert 在 acceptProposal 写完 rate=accept 之后跑（`assertMergeLearningItemParity`），非 applyMerge 内**。原因：learning_item fold 的改写 gate 在 merge 的**接受态**，而 accept rate 在 applyMerge 返回后才写——若在 applyMerge 内 assert，fold 尚看不到接受→假 mismatch。goal 无此问题（走专用 `goal_scope_update` 事件，自洽）。影响：`proposals.ts` acceptProposal。

5. **edge rewire 的 create + misconception 的 to_id UPDATE 包 nested-tx SAVEPOINT**。原因（**实测发现**）：Postgres 在任一语句报错后 abort 整个事务，`createKnowledgeEdge` 把 23505 转成 ApiError 后 catch-continue 时，外层 merge tx 已进 aborted 态→下一条（retire 的 advisory lock）报 25P02。用嵌套 `tx.transaction`（savepoint）只回滚失败的 create/UPDATE，外层 merge tx 存活，archive-as-duplicate 才成立。影响：`proposals.ts` `rewireKnowledgeEdges` / `rewireMisconceptionEdgeTargets`。

6. **edge rewire 把**两个**端点都过完整 merge from_ids 集**（非只当前 fromId）**。原因：loser→loser 边（同一 merge 的两个 from_id 相连）改写后应塌成 self-loop（archive-only），而非指向刚归档的兄弟节点触发 FK 404。§2 签名扩展加 `mergeFromIds: ReadonlySet<string>`。影响：`proposals.ts` `rewireKnowledgeEdges` / `repairMergeAttributionForFromId` / applyMerge 传 `new Set(from_ids)`。

7. **edge rewire 亦 catch ApiError `not_found`（404，另一端点已归档/缺失）→ archive-as-duplicate + warn**（非中止 merge）。原因：指向已归档节点的活边本就退化，优雅丢弃胜过让正常 merge 因悬挂边中止。topology reject（cycle/direction）仍按 §4 决策 5b **throw 中止整 tx**（实测有专测覆盖）。影响：`proposals.ts` `rewireKnowledgeEdges`。

8. **抽出 `repairMergeAttributionForFromId` 为 applyMerge 与 backfill 共用的单一 per-fromId 修复函数**。原因：§2/§4「backfill 调同一批函数」落到字面——applyMerge 的 per-fromId 循环体与 backfill 走同一实现，不可能漂移。影响：`proposals.ts` 新 export。

9. **report-only 常驻巡 = `merge_attribution_sweep` job（queue `fast`，周一 04:00 Asia/Shanghai，dryRun census 零写）**；backfill 与 sweep 共用 `merge-attribution-backfill.ts` core（`resolveMergeChains` + `countOrphanSurfaces` + `runMergeAttributionBackfill`）。影响：新 `jobs/merge_attribution_sweep.ts` + manifest 登记 + 新 `server/merge-attribution-backfill.ts` + 新 `scripts/backfill-merge-attribution.ts`。

10. **retire fns**：mastery/fsrs 硬编 subject_kind='knowledge' + `fsrs:knowledge:<id>` 锁命名空间（对齐 `updateThetaForAttempt`）；axis/typed 带 `subjectKind='knowledge'` 默认参 + 各自 `axis_state:` / `kc_typed:` 命名空间。三态 noop/renamed/frozen，**绝不合并数值**。mastery lock 互斥性有确定性专测（第二连接 `pg_try_advisory_xact_lock` 命中 false）。影响：`state.ts`(mastery/fsrs) / `axis-writer.ts` / `typed-state.ts`。

11. **master register（`2026-07-02-project-logic-master-register.md`）本 worktree 未改**（未提交，留主 session 处理）——按任务指示 skip。
