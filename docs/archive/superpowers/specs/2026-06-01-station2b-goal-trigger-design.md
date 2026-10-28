# Station 2B — Goal-Scope Trigger (Nightly Cron) — Design Spec

- **Issue**: YUK-186 (Station 2B)
- **Date**: 2026-06-01
- **Status**: Implemented (PR #233, YUK-186) — committed.
- **ADR context**: ADR-0025 (North-Star goal layer), YUK-143
- **Decision (user)**: a **nightly pg-boss cron** that proposes a goal-scope from accumulated mastery. **NOT** a Copilot chip / UI trigger. Reuse-first, anti-over-engineering.

---

## Problem

The entire goal layer is dark. `runGoalScopeAndWrite` (`src/server/goals/scope.ts:53`) is the PROPOSE half — it writes a `goal_scope` AiProposal that the existing accept→materialize path (`src/server/proposals/actions.ts:576-588` → `src/server/goals/accept.ts:43`) can turn into a `goal` row, which then lights up three additive consumers (Coach daily, Dreaming nightly, Review due-list). But `runGoalScopeAndWrite` **has no production caller** — grep over `src/` + `app/` finds it only in `scope.ts` (def), `scope.test.ts`, and a comment in `brief-writer.ts:121`. There is no goals API route, no UI, no boss handler. So a `goal_scope` proposal can only be born if something invokes the producer, and nothing does. The synthetic seed (`scripts/seed-synthetic.ts`) builds the substrate the producer reads (approved nodes + attempt/review events feeding the `knowledge_mastery` view + `knowledge_edge` rows) but never drives the goal slice.

## Goal

Add a nightly pg-boss cron handler that:
1. Reads accumulated mastery / active subjects to pick **one** goal-scope candidate.
2. Calls `runGoalScopeAndWrite` (REUSE — do not re-implement the propose logic) to emit a `goal_scope` PROPOSAL into the inbox.
3. Is idempotent + non-spammy: never re-proposes a goal already live (`listActiveGoals`) or already pending in the inbox; caps at **1 proposal per run**.
4. Makes a real LLM call in prod via the runner; uses a stubbed `runTaskFn` seam in tests (zero token, deterministic).
5. Is validated on the Station-1 synthetic seed: seed → run cron on-demand → proposal lands in inbox → accept → goal materialized → `listActiveGoals` non-empty → Coach/Dreaming/Review goal-bias observably light up.

Non-goal: the accept→materialize path and the three consumers are already built — this spec only wires the **producer trigger**.

---

## Decisions

### D1 — Handler: mirror `knowledge_edge_propose_nightly` exactly

New file `src/server/boss/handlers/goal_scope_propose_nightly.ts`, structurally a clone of `knowledge_edge_propose_nightly.ts`:
- Pure `runGoalScopeProposeNightly(db, deps)` returning a `GoalScopeNightlyResult` count struct.
- `DepsOverride = { runTaskFn?: TaskTextRunFn }`; resolved `const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn`. (`knowledge_edge_propose_nightly.ts:15-17,71`).
- Lazy `defaultRunTaskFn` dynamic-imports `@/server/ai/runner`'s `runTask` so the worker doesn't eagerly load the Anthropic runtime at module-eval (`knowledge_edge_propose_nightly.ts:82-90`). **Reuse the `TaskTextRunFn` signature** that `runGoalScopeAndWrite` already takes (`scope.ts:34`), not edge's `RunTaskFn`.
- `buildGoalScopeProposeNightlyHandler(db)` wraps `runGoalScopeProposeNightly` in try/catch → `console.log` result on success, `console.error` + rethrow on failure so pg-boss marks the job retryable (`knowledge_edge_propose_nightly.ts:92-104`).

**Justification**: `runGoalScopeAndWrite` already owns load-snapshot + single structured-output call + parse + id-subset filter + `writeAiProposal` + failure-swallowing (`scope.ts:56-122`). The cron is a thin candidate-picker + dedup gate + one call. Mirroring the edge nightly keeps the F-1 evidence-trace posture and the test seam identical to Station 2A.

### D2 — Candidate selection: most-active subject, weakest-cluster title; **no ranking engine**

Per run, in `runGoalScopeProposeNightly`:
1. `const active = await listActiveSubjectsSinceRefresh(db, …)` then `const top = selectSubjectsForRun(active, 1)` (`src/server/memory/active-subjects.ts:196,314-321`) → the single most-active subject (sort by `maxCreatedAt` DESC, take 1). Empty active set → **no-op early return** (`considered: 0`), cheaper than an empty LLM call (mirrors edge's 0-attempts early return, `knowledge_edge_propose_nightly.ts:60-69`).
2. Resolve a candidate subjectId = `top[0].subjectId`. Pass it as `runGoalScopeAndWrite({ subjectId })`. (Cross-subject goals are allowed — `subjectId` is nullable, ND-1 — but the cron deliberately scopes per active subject to keep candidates concrete.)
3. **profile-id → domain (FIX-3)**: `selectSubjectsForRun` yields a subject **profile-id** (the BR-4 bridge groups events by profile-id; orphan/unresolvable events land in a synthetic **default bucket**). Two things downstream need a **domain** string, not a profile-id: (a) the weak-node tree filter compares against `KnowledgeNode.effective_domain` (a domain), and (b) `resolveSubjectProfile(domain)` (`src/subjects/profile.ts:151-153`) resolves by domain/alias. Derive the domain from the profile: `const profile = resolveSubjectProfile(subjectId); const domain = profile.id;` (for the current single real subject `wenyan`, profile-id == domain, so they coincide; the general path is the registry lookup — do NOT assume id == domain in code that could see another subject). If `subjectId` is the **default/orphan bucket** rather than a known profile id (`KNOWN_SUBJECT_IDS`, `src/subjects/profile.ts:6,16`), **skip** the candidate — do not propose a goal scoped to a synthetic default id (`considered: 1`, no proposal; treat as a skip).

4. **Goal title**: deterministic placeholder. Title = `resolveSubjectProfile(domain).displayName` if present, else the raw slug — the schema requires a non-empty `displayName` (`src/subjects/profile-schema.ts:41`), so this is one field access, **not** a name-resolution system. The LLM picks the actual `scope_knowledge_ids` from the full grid anyway, and the user **edits the title in the inbox before accepting** (accept.ts reads the edited `proposed_change.title`, `accept.ts:49-50`), so this is just a better human-readable anchor. **Weak-node pre-check (FIX-2)**: do NOT call `loadMasteryMap` (it is NOT exported — `knowledge-readers.ts:136` is a private `async function`) and there is NO `loadSubjectKnowledgeIds` helper (it does not exist anywhere in `src/`/`app/`). Instead reuse the **already-exported** `loadTreeSnapshot(db)` (`src/server/knowledge/tree.ts:21-50`), which `runGoalScopeAndWrite` already calls (`scope.ts:57`) and which carries per-node `mastery` + `evidence_count` + `effective_domain`:
   ```ts
   const tree = await loadTreeSnapshot(db);
   const subjectNodes = tree.filter((n) => n.effective_domain === domain);
   const hasWeak = subjectNodes.some((n) => (n.mastery ?? 0.5) < 0.55);
   ```
   the weak-node convention is `mastery < 0.55` (`knowledge-readers.ts:321,644`). **No scoring/ranking beyond "most active subject + has ≥1 weak node".** If the chosen subject has zero weak nodes (all `mastery >= 0.55`), skip it (`considered: 1, skipped_no_weak: 1`, no proposal) — don't propose a goal with nothing to strengthen.

**Justification**: keeps the picker to existing helpers (`selectSubjectsForRun`, `loadTreeSnapshot`) and a literal title. The producer's GoalScopeTask already does the real scope selection over the whole grid (`scope.ts:68-92`); the cron only decides *which subject is worth a goal tonight* and *whether there is anything weak to target*. Anti-over-engineering: no new ranking module, no candidate queue. The cron + the producer each call `loadTreeSnapshot` once per night — acceptable for a 1/night cron; do **not** build a shared-snapshot abstraction (that would over-engineer the other way).

> **Note on `active-subjects` cost**: `listActiveSubjectsSinceRefresh` is the same activity reader the brief pipeline uses; it does its own event→subject resolution (BR-4 bridge). The cron reuses it read-only and selects 1. If it proves heavier than wanted, an Open Fork (§ Open product forks) covers a cheaper substitute.

### D3 — Dedup / cap / cooldown (anti-storm) — **critical**

Three gates, all BEFORE the LLM call so a dup never spends a token:

1. **Cap = 1 proposal per run.** The cron picks exactly one candidate subject and calls `runGoalScopeAndWrite` at most once. No loop.
2. **Skip subjects with a live goal.** `const activeGoals = await listActiveGoals(db)` (`src/server/goals/queries.ts:114-133`). If any active goal already has `subject_id === candidate.subjectId`, skip (`skipped_existing_goal: 1`, no proposal). This is the same additive read Dreaming uses (`dreaming_nightly.ts:258`).
3. **Skip subjects with a pending `goal_scope` proposal.** New helper `loadPendingGoalScopeSubjects(db)`, modeled on `loadPendingEdgeProposalKeys` (`propose_edge.ts:212-267`) but adapted to the goal-proposal envelope (see § Dedup logic for the exact event shape). If the candidate's `subject_id` is in the pending set, skip (`skipped_pending: 1`, no proposal).

**Cron self-overlap**: rely on the documented nightly posture — `batchSize:1` + `localConcurrency 1` + **no `singletonKey`** (`handlers.ts:69-73`). A single worker serializes runs; do **not** add a singleton the other nightlies lack.

**Cooldown**: `runGoalScopeAndWrite` already stamps `cooldown_key: goal_scope:${goalId}` on each proposal (`scope.ts:110`). We do **not** rely on that for dedup (each call mints a fresh reserved `goalId`, so the key is unique per attempt) — the real anti-storm is gates 2+3 keyed on `subject_id`. The cron does not need an additional cooldown table.

### D4 — Test seam: stubbed `runTaskFn`, no live LLM

Same seam as Station 2A and the seed's stubbed nightly. `runGoalScopeProposeNightly(db, { runTaskFn: async () => ({ text: JSON.stringify({ scope_knowledge_ids:[…], sequence_hint, reasoning }) }) })`. The stub shape is `{ text }` (no `task_run_id` → defaults null at `scope.ts:112`; `cost_usd` optional → `scope.ts:113`). Parsed by `parseGoalScopeOutput` against `GoalScopeOutputSchema` (`scope.ts:22-26,125-139`). Identical to `scope.test.ts:75-81` and the edge nightly seed stub `runStubbedNightly` (`seed-synthetic.ts:864-868`).

### D5 — Validation on synthetic data: DB test is the source of truth; `--observe` extension optional

- **Primary**: a new DB test `tests/integration/goal_scope_propose_nightly.db.test.ts` (or a case in the existing seed DB test harness `tests/integration/seed-synthetic.db.test.ts:97-130`) that runs `runSeed` → `runGoalScopeProposeNightly(db, { runTaskFn: stub })` → asserts the full chain (§ Validation-on-synthetic).
- **Optional**: extend `seed-synthetic.ts --observe` (`runObserve`, drives `runStubbedNightly` at `seed-synthetic.ts:848`) to ALSO call the goal cron stubbed, and add a `goal_scope_proposes` count to `printReport` (`seed-synthetic.ts:882`). Decision: **gate the chain assertion in the DB test, keep `--observe` extension as a nice-to-have demo** — the test is what the gate runs; `--observe` is for eyeballing. Implementer may skip the `--observe` extension if it adds churn.

### D6 — Schema: **NO new production schema**

Reuse `goal` / `goal_scope` proposal / `event` tables entirely. The proposal is an `event` row (`experimental:proposal` / `subject_kind:'goal'`); the goal is the existing `goal` table (`schema.ts:711-740`); dedup reads existing `event` + `goal` rows. **If the implementer finds a column unavoidable** (not expected), STOP — flag `pnpm audit:schema` live, write the migration, note it in the PR, and re-confirm before proceeding. The design budget is **zero migrations**.

### D7 — F-2 worker-env (prod LLM call)

In prod the cron calls `runTask('GoalScopeTask', …)` which hits the xiaomi/mimo Anthropic-compatible endpoint. Same env requirement as Station 2A: the worker process (`scripts/worker.ts`) must have `XIAOMI_API_KEY` (and the AI endpoint env) set. Note this env requirement in the worker deploy checklist.

**F-1 asymmetry (FIX-5) — state it precisely, do NOT over-swallow.** The failure posture is split into two halves, and only one of them degrades silently:

- **LLM / producer half — swallow-safe.** Only the call into `runGoalScopeAndWrite` is covered by an error swallow: its *internal* try/catch catches the LLM/key/runner-import throw, calls `writeRetryableAiFailureLedger`, and returns `EMPTY_RESULT` (`scope.ts:118-122`). A missing `XIAOMI_API_KEY` or a transient LLM outage therefore yields `proposed: 0` (logged ledger), **not** a retry storm.
- **Pre-LLM DB reads — retry legitimately.** Everything the cron does *before* `runGoalScopeAndWrite` — `listActiveSubjectsSinceRefresh`, `listActiveGoals`, the `loadPendingGoalScopeSubjects` scan, and the `loadTreeSnapshot` weak-node pre-check — runs **outside** that swallow. If one of those throws (e.g. a real DB fault), it propagates up and the builder's try/catch `console.error`s + **rethrows** so pg-boss marks the job retryable. That is correct: a DB fault SHOULD retry, not be logged-and-skipped.
- **Do NOT wrap the pre-LLM reads in a catch-all.** Masking them would hide genuine DB faults behind a false `proposed: 0`. So: *the LLM half is swallow-safe; the DB reads retry legitimately.* The builder only ever rethrows on its own (non-producer) errors.

---

## Mechanism

### Schedule + registration (`src/server/boss/handlers.ts`)

Add the import alongside the others (`handlers.ts:13`):
```ts
import { buildGoalScopeProposeNightlyHandler } from './handlers/goal_scope_propose_nightly';
```
Add the canonical 3-call block inside `registerHandlers` (the same shape as `dreaming`/`coach_daily`, `handlers.ts:94-114`):
```ts
await boss.createQueue('goal_scope_propose_nightly');
await boss.work(
  'goal_scope_propose_nightly',
  { pollingIntervalSeconds: 2, batchSize: 1 },
  buildGoalScopeProposeNightlyHandler(db),
);
await boss.schedule('goal_scope_propose_nightly', '0 4 * * *', {}, { tz: 'Asia/Shanghai' });
```

**Cron slot**: BJT `0 4` (04:00). The producer chain is staggered: `0 2` node → `30 2` edge → `45 2` hub-sync → `0 3` maintenance → `15 3` dreaming → `45 3` coach_daily (`handlers.ts:47,60,80,90,100,114`). Goal-propose must run **after the mastery view has settled** and reads same-night active-subject state, so place it at `0 4`. NOTE: `prune_job_events` is currently `0 4` too (`handlers.ts:48`) — to avoid IO contention with that bulk DELETE pass, prefer **`50 3`** (between coach_daily `45 3` and the `0 4` prune storm) OR push prune later. **Decision: schedule goal-propose at `50 3` BJT** (after coach_daily, before the prune storm) — it reads active subjects + materialized goals (steady by 03:50) and avoids the `0 4` DELETE contention. (Coach reading a same-night-proposed-but-unaccepted goal is fine: `listActiveGoals` only returns *accepted/materialized* goals, and an unaccepted proposal never enters the active list — so there is no ordering hazard with coach at `45 3`.)

Final schedule line:
```ts
await boss.schedule('goal_scope_propose_nightly', '50 3 * * *', {}, { tz: 'Asia/Shanghai' });
```

### Handler body (sketch, `goal_scope_propose_nightly.ts`)

```ts
export interface GoalScopeNightlyResult {
  considered: number;          // active subjects examined (0 or 1)
  proposed: number;            // 0 or 1
  skipped_existing_goal: number;
  skipped_pending: number;
  skipped_no_weak: number;
  proposal_id: string | null;
}

export async function runGoalScopeProposeNightly(
  db: Db,
  deps: DepsOverride = {},
): Promise<GoalScopeNightlyResult> {
  const empty: GoalScopeNightlyResult = { considered: 0, proposed: 0,
    skipped_existing_goal: 0, skipped_pending: 0, skipped_no_weak: 0, proposal_id: null };

  // PRE-LLM reads run OUTSIDE runGoalScopeAndWrite's swallow (FIX-5): a throw
  // here is a legit retryable DB error (pg-boss retries via the builder), NOT a
  // logged skip. Do NOT wrap these in a catch-all — that would mask DB faults.
  const active = await listActiveSubjectsSinceRefresh(db, {});
  const top = selectSubjectsForRun(active, 1);
  if (top.length === 0) return empty;
  const subjectId = top[0].subjectId; // a subject PROFILE-id (BR-4 bridge), not a domain

  // FIX-4: candidate quality — the BR-4 bridge resolves orphan events to a
  // synthetic default bucket. Don't propose a goal scoped to a non-profile id.
  if (!KNOWN_SUBJECT_IDS.includes(subjectId as KnownSubjectId))
    return { ...empty, considered: 1 }; // skip default/orphan bucket

  // FIX-3: profile-id → domain. resolveSubjectProfile takes a domain/alias;
  // for wenyan profile-id == domain, but the general path is a registry lookup.
  const profile = resolveSubjectProfile(subjectId);
  const domain = profile.id;

  // Gate 2: skip subject with a live goal.
  const activeGoals = await listActiveGoals(db);
  if (activeGoals.some((g) => g.subject_id === subjectId))
    return { ...empty, considered: 1, skipped_existing_goal: 1 };

  // Gate 3: skip subject with a pending goal_scope proposal.
  // (Set key construction tolerates a null/undefined proposed_change.subject_id
  // per ND-1, FIX-4 — see § Dedup logic; the cron always passes a concrete id.)
  const pendingSubjects = await loadPendingGoalScopeSubjects(db);
  if (pendingSubjects.has(subjectId))
    return { ...empty, considered: 1, skipped_pending: 1 };

  // FIX-2: candidate-has-weak-node check via the already-exported loadTreeSnapshot
  // (NOT loadMasteryMap — private — and NOT loadSubjectKnowledgeIds — nonexistent).
  // Filter by effective_domain (a DOMAIN), not the profile-id.
  const tree = await loadTreeSnapshot(db);
  const subjectNodes = tree.filter((n) => n.effective_domain === domain);
  const hasWeak = subjectNodes.some((n) => (n.mastery ?? 0.5) < 0.55);
  if (!hasWeak) return { ...empty, considered: 1, skipped_no_weak: 1 };

  // From here on, the LLM half is swallow-safe (FIX-5): runGoalScopeAndWrite's
  // internal try/catch absorbs LLM/key/runner throws → EMPTY_RESULT, proposed: 0.
  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
  const result = await runGoalScopeAndWrite({
    db,
    goalTitle: profile.displayName || subjectId, // FIX-4: displayName placeholder; user edits in inbox
    subjectId,
    runTaskFn,
    subjectProfile: profile,
  });

  return { ...empty, considered: 1,
    proposed: result.proposal_id ? 1 : 0, proposal_id: result.proposal_id };
}
```
Notes: the weak-node pre-check reuses `loadTreeSnapshot` — the producer loads the same tree once more inside `runGoalScopeAndWrite` (`scope.ts:57`). For a 1/night cron that double-read is fine; do **not** introduce a shared-snapshot abstraction to dedupe it. `KNOWN_SUBJECT_IDS` / `KnownSubjectId` import from `@/subjects/profile`. `resolveSubjectProfile`/`profile.displayName`/`profile.id` are the only profile fields touched — no name-resolution system.

---

## Dedup logic — `loadPendingGoalScopeSubjects(db)`

Modeled on `loadPendingEdgeProposalKeys` (`propose_edge.ts:212-267`) but adapted to the goal-proposal **event shape**, which differs from the edge proposal:

- A `goal_scope` proposal is written via `writeAiProposal` → `eventShapeForProposal` **default branch** (`writer.ts:76-85`): `action: 'experimental:proposal'`, `subject_kind: payload.target.subject_kind` = `'goal'`, `subject_id` = reserved goalId, and the proposal fields are nested under `payload.ai_proposal` (NOT top-level like the edge's `from_knowledge_id`).
- `proposalWhere()` surfaces it via `eq(event.action, 'experimental:proposal')` (`inbox.ts:143`).

So the scan:
1. Select `event` rows WHERE `action='experimental:proposal' AND subject_kind='goal'`, **excluding rubric-rejected**: `sql\`(${event.payload}->'rubric_verdict'->>'ok') IS DISTINCT FROM 'false'\`` (same RB-7 guard as `propose_edge.ts:228` — a rubric-rejected propose is TERMINAL, not live-pending; counting it would permanently lock out re-propose).
2. Select chained `rate` events keyed **ONLY** on `and(eq(event.action,'rate'), inArray(event.caused_by_event_id, proposeIds))` — **NO `subject_kind` filter (FIX-1, BLOCKING).** This is the load-bearing divergence from the edge dedup. The edge path can filter `subject_kind='knowledge_edge'` on its rate query because the edge accept path writes that kind; the **goal accept path does NOT**: the goal accept rate event is written `subject_kind: 'event'` (`accept.ts:121`), and dismiss/generic rate is *also* `subject_kind: 'event'` (`writeGenericRateEvent`, `actions.ts:1631,1661`). A `subject_kind='goal'` filter on the rate query therefore matches **ZERO rows** → an already-accepted-or-dismissed `goal_scope` propose is mis-read as still-pending → that subject is **permanently blocked from re-propose** (the goal layer silently goes dark for it). `caused_by_event_id` uniquely links the rate back to its propose (`accept.ts:129`), so it alone is the correct, sufficient join key. A propose with any chained rate is decided, not pending.
3. For each propose with no chained rate, read `payload.ai_proposal.proposed_change.subject_id` (the candidate subject) and add it to the Set **only if it is a non-empty string**. Cross-subject goals allow a `null`/`undefined` `subject_id` (ND-1), and the Set-key construction must **not throw** on a null (skip nulls rather than coercing) — the cron always passes a concrete `subjectId`, but the pending scan must survive a null-scoped pending proposal in the table. Key on **`subject_id`** (not scope ids — a subject with any live goal-scope proposal is "covered tonight"; scope-level keying would let near-duplicate goals stack).

Status-derivation rules honored: only `pending` blocks re-propose; `rubric_rejected`/`stale` do NOT (`inbox.ts:21,78-115`). Intra-run there is at most 1 proposal (cap=1), so no intra-batch dedup set is needed (unlike edge's `:175`).

---

## Test plan (stubbed, no live LLM)

`tests/integration/goal_scope_propose_nightly.db.test.ts` (DB config — touches `goal`/`event` tables; Docker testcontainer):

1. **Happy path**: seed substrate (active subject + weak nodes + edges) → `runGoalScopeProposeNightly(db, { runTaskFn: stub })` → assert `result.proposed === 1`, `result.proposal_id` truthy; `listProposalInboxRows(db)` (`inbox.ts:446`) contains a row with `kind === 'goal_scope'`, `status === 'pending'`, `target.subject_kind === 'goal'` (pattern from `scope.test.ts:90-100`).
2. **Hallucinated-id drop**: stub returns a non-existent id in `scope_knowledge_ids`; assert it's filtered out of the materialized proposed_change (`scope.ts:91-92`, `scope.test.ts:93,102`).
3. **Dedup — existing goal**: pre-materialize an active goal for the candidate subject → run cron → assert `proposed === 0`, `skipped_existing_goal === 1`, no new proposal.
4. **Dedup — pending proposal**: run cron once (proposal lands), run again WITHOUT accepting → assert second run `proposed === 0`, `skipped_pending === 1`; only one `goal_scope` row in the inbox.
5. **No-op — no active subjects**: empty DB / no qualifying activity → `considered === 0`, `proposed === 0`, no LLM call (stub not invoked — assert via a call-count spy).
6. **No-op — no weak nodes** (FIX-6 — NOT seed-drivable): candidate subject all `mastery >= 0.55` → `skipped_no_weak === 1`, no proposal. **This case cannot be driven by `runSeed`**: the `knowledge_mastery` view returns `0.5` for any node with `evidence_count < 3`, and `0.5 < 0.55` is true, so virtually every seeded subject has at least one "weak" node → `skipped_no_weak` is near-unreachable on the synthetic seed. Drive it one of two ways instead: (a) a **dedicated hand-built fixture** where every node has `evidence_count >= 3` AND a success-rate that lifts mastery `>= 0.55` (an all-success attempt fixture), or (b) a **unit test on the weak-node filter helper** — extract the `tree.filter(effective_domain==domain) → some(mastery<0.55)` predicate and assert it returns `false` for an all-mastered node array, without a DB round-trip. Prefer (b) if the filter is factored into a pure helper; otherwise (a).
7. **F-1 failure swallow**: stub `runTaskFn` throws → `runGoalScopeAndWrite` swallows (writes failure ledger), cron returns `proposed: 0` without throwing (the builder rethrow path is exercised separately by a builder-level test if desired).
8. **Cap**: assert at most one `runGoalScopeAndWrite` call per run (spy).

All stubbed → zero token, deterministic. Run with `pnpm test:db:watch tests/integration/goal_scope_propose_nightly.db.test.ts`.

---

## Validation-on-synthetic (end-to-end chain)

Drive the full goal layer light-up on the Station-1 synthetic seed (the substrate — approved nodes, attempt/review events feeding the `knowledge_mastery` view with `evidence_count >= 3`, materialized edges — is already present post-seed; `seed-synthetic.ts:227,248,341,347-348`):

1. `await runSeed(db)` (`seed-synthetic.ts:727`).
2. `await runGoalScopeProposeNightly(db, { runTaskFn: stub })` → a `goal_scope` proposal lands.
3. `listProposalInboxRows(db)` filter `kind==='goal_scope'` → `status:'pending'`, `target.subject_id === proposal.goal_id`.
4. `await acceptAiProposal(db, proposalId)` (`actions.ts:576-588` → `accept.ts:43`) → goal row inserted (`status:'active'`, `source:'goal_scope_proposal'`, `source_ref:proposalId`), accept `rate` event written, idempotent on re-accept.
5. `await listActiveGoals(db)` → **non-empty**, contains the materialized goal id (pattern `scope.test.ts:124-153`).
6. **Goal-bias lights up** (assert each consumer flips, additive ND-5):
   - **Coach**: `runCoachDaily` with stub Coach task → `active_goals` non-empty in input (`coach_daily.ts:143`), plan carries `goal_ids[]` + `goal_strand[]` (`coach.ts:46-71`).
   - **Dreaming**: `runDreamingNightly` reads `listActiveGoals` (`dreaming_nightly.ts:258`) → `active_goals` injected (`:186`); bias is additive.
   - **Review**: `due-list` with active goals re-ranks the OVERDUE segment by `goalScope` union (`due-list.ts:402-421`); with-goals vs no-goals output preserves the same set/due_at/fsrs_state, only reorders goal-relevant overdue items ahead.
7. **Retract round-trip** (optional): retract → goal tombstones to `'dormant'`, drops out of `listActiveGoals` (`scope.test.ts:200-221`, `actions.ts` retract path).

---

## Gate (pre-PR)

`pnpm typecheck` · `pnpm lint` · `pnpm audit:schema` (must stay green — no new schema, D6) · `pnpm audit:partition` (the new test is a DB test → db config) · `pnpm audit:profile` · `pnpm test` · `pnpm build`. The new DB test runs under `pnpm test:db`.

## Acceptance

- [ ] `src/server/boss/handlers/goal_scope_propose_nightly.ts` exists, exports `runGoalScopeProposeNightly` + `buildGoalScopeProposeNightlyHandler`, mirrors the edge nightly (deps seam, lazy default, builder try/catch).
- [ ] Registered in `handlers.ts` with the 3-call block + `schedule('… 50 3 * * *', { tz:'Asia/Shanghai' })`.
- [ ] Cap = 1 proposal/run; never re-proposes a subject with a live goal (`listActiveGoals`) or a pending `goal_scope` proposal (`loadPendingGoalScopeSubjects`, rubric-rejected excluded).
- [ ] Reuses `runGoalScopeAndWrite` — propose logic NOT re-implemented.
- [ ] Candidate = most-active subject (`selectSubjectsForRun(…,1)`), skipping the default/orphan bucket (must be in `KNOWN_SUBJECT_IDS`), with ≥1 weak node found via `loadTreeSnapshot` filtered by `effective_domain === domain` (`mastery ?? 0.5) < 0.55`); profile-id resolved to a domain via `resolveSubjectProfile`; title = `displayName`; no ranking engine. NOT `loadMasteryMap`/`loadSubjectKnowledgeIds`.
- [ ] DB test green: happy path, hallucination drop, both dedup gates, both no-op paths (no-active-subject is seed-drivable; **no-weak-nodes needs a dedicated all-mastered fixture or a unit test on the filter helper**, FIX-6), failure-swallow (LLM half), cap.
- [ ] Synthetic chain verified: seed → cron → proposal → accept → `listActiveGoals` non-empty → Coach/Dreaming/Review bias lights up.
- [ ] No new migration; `audit:schema` green.
- [ ] Worker deploy note: `XIAOMI_API_KEY` required in worker env (F-2).

## Out of scope

- **Copilot chip / UI trigger** — explicitly deferred by user decision; nightly cron only.
- **accept→materialize path + the three goal-bias consumers** — already built (`accept.ts`, `actions.ts:576-588`, `coach_daily.ts`, `dreaming_nightly.ts`, `due-list.ts`); this spec only adds the producer trigger.
- **Goal lifecycle UPDATE (re-scope / status transitions)** — `updateGoalScope`/`updateGoalStatus` exist (`queries.ts:62-106`); not touched here.
- **Multi-goal-per-run, cross-subject goal candidates, ranking** — single most-active subject, cap 1. (Open fork below.)
- **`--observe` extension to `seed-synthetic.ts`** — optional demo, not gated (D5).

## Open product forks (genuine)

1. **Cap & cadence**: 1 proposal/night/most-active-subject is the conservative start. Is nightly too eager, or should a subject get *one* goal-scope offer then a cooldown (e.g. don't re-offer the same subject for N days even after dismiss)? Dismiss currently leaves no goal row and no pending proposal, so the cron WILL re-offer the same subject next eligible night — possibly spammy if the user keeps dismissing. **Recommend**: ship as-is, watch the inbox; if dismiss-churn appears, add a "recently-dismissed subject" cooldown reading the dismiss `rate` event (no schema — derive from events). Flag as YUK follow-up.
2. **Candidate signal**: "most-active subject with a weak node" vs "weakest cluster regardless of recency". Recency keeps goals tied to what the user is actually studying (better UX); weakness-first might surface stale-but-important gaps. Recommend recency (current decision); revisit if goals feel disconnected from current study.
3. **`active-subjects` cost**: if `listActiveSubjectsSinceRefresh` is heavier than wanted in the nightly chain, substitute a lighter "subjects with attempt/review events in last 24h" query (mirrors the edge nightly's 24h cutoff). Defer unless profiling flags it.
