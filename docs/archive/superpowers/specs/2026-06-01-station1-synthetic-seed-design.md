# Station 1 — Synthetic Seed (`scripts/seed-synthetic.ts`)

**Date:** 2026-06-01
**Issue:** YUK-184 (post-P5 data-activation drive, Station 1 of N)
**Status:** Implemented (PR #231, YUK-184). Brief layer stays dark until Station 2 (A3 generate-writer).
**Scope posture:** Pre-product. Synthetic data first. This is a **focused dev script**, NOT a framework. Anti-over-engineering and scope discipline (CLAUDE.md) are load-bearing constraints, not aspirations.

---

## Problem

Layer-8 features shipped in P5 are **data-gated** and therefore **inert** on an empty/sparse dev DB. You cannot see them work, demo them, or test the stations after this one against realistic state:

- **FSRS due list** — empty until `material_fsrs_state` rows exist with `due_at <= now()`, or failure attempts exist for the never-reviewed slice.
- **Proposal stack** (`proposal_signals` → acceptance/feedback digest → L2 adaptive bias) — `getProposalAcceptanceRates` filters out every `(kind, cooldown_key)` row with `total === 0`, so with no accept/dismiss history the digest is empty and `resolveEdgeGateBump` is a permanent no-op.
- **L1 edge evidence floor + edge-propose** — needs clustered failure→judge history within the 30d window for `computeEvidenceLevel` to return `strong`/`medium`; on an empty DB the edge-propose nightly scans 0 attempts and no-ops.
- **Subject-brief activity detection** — `listActiveSubjectsSinceRefresh` / `loadSubjectBriefEvents` find nothing to refresh.

There is no all-in-one synthetic seed today. `app/api/_/seed` (wenyan) and `/seed/math` seed **knowledge nodes + questions only** — no events, no FSRS state, no proposals, no causal chain. The test-only `tests/helpers/event-seed.ts` direct-inserts events but bypasses `writeEvent` (no `affected_scopes`, no outbox cursor) and is **not prod-faithful**.

## Goal

A single re-runnable script `scripts/seed-synthetic.ts` that manufactures a **realistic, causally-chained, time-distributed** event history so the FSRS / proposal / detection slices of Layer-8 light up and become **observable now**, on a local dev DB only. It is the anti-inert test+demo harness for the stations after it.

It does **not** try to light up the brief surface end-to-end — that needs A3 wiring (Station 2). See [Sequencing](#sequencing-brief-stays-dark-until-station-2).

**Single mode.** There is exactly ONE observe path: `--observe` drives the REAL nightly orchestration with a STUBBED `runTaskFn` (zero token, deterministic, fully faithful linkage). There is no `--llm` / `--no-llm` fork — the prior dual-mode design was cut (it introduced a spend-posture product fork for no fidelity gain; see D1).

---

## Decisions

### D1 — Write strategy: `writeEvent` for events + `recordProposalDecisionSignal` for signals + markered direct-insert for the rest. NOT the real producers.

**Decision:** Three write lanes, picked by what each table actually needs — do NOT route through the evolving real producers `decideKnowledgeEdgeProposal` / `writeAiProposal`:

1. **`event` rows → `writeEvent(db, input)`** (`src/server/events/queries.ts:1011`), inside a `db.transaction` per causal chain. This is the parse + scope chokepoint we DO want: `writeEvent` runs `parseEvent` (the Lane B union, `queries.ts:1016-1027`) — a malformed payload **throws at seed time** instead of silently producing a row no projection reads. It computes `affected_scopes` via `computeAffectedScopes` (`scope_tagger.ts:38`, re-exported via `queries.ts:33`) exactly as `app/api/review/submit/route.ts` and `app/api/mistakes/route.ts` do, and leaves `ingest_at = NULL` so the outbox poller treats synthetic rows identically to real capture.
2. **`proposal_signals` rows → `recordProposalDecisionSignal(db, source, decision)`** (`signals.ts:176`). A thin, pure-DB signal writer with no LLM and no HTTP coupling — faithful and stable. See GAP5 (§D-GAP5) for the exact `ProposalSignalSource` shape it requires.
3. **Everything else → markered direct-insert**: `knowledge` nodes, `knowledge_edge`, `question`, `material_fsrs_state` (via `upsertFsrsState`). These have no parse chokepoint worth replicating and no producer that accepts a bare `db` without LLM/HTTP.

**The exceptions** (GAP1): rubric-rejected propose events must replicate `foldRubricRejectedEdge`'s `event_override` payload shape directly via `writeEvent` (or `writeAiProposal` with `event_override`) — see §D-GAP1. The plain-PASS propose events come for free from the stubbed-runTaskFn nightly (below); the rubric-rejected ones must be hand-written because the nightly never produces them. The L2 dismiss cluster (§5c) ALSO uses `writeAiProposal` with `event_override` for its propose events — so the seed calls `writeAiProposal` for both hand-written propose families, not just one.

**Why NOT the real producers:** `decideKnowledgeEdgeProposal` / `writeAiProposal` are over-faithful for a dev seed — they couple the seed to signatures that evolve per-phase and carry side effects (record-link flips, tool-call logs, gate-bump reads) we don't want to drag in. The seed wants the linkage, not the producers' full apparatus. The stubbed-runTaskFn nightly (below) already exercises the REAL linkage logic (dedup, self-loop, duplicate-edge, scope tagging) without the producer coupling.

**The outbox wrinkle (and its resolution):** `writeEvent` does **not** enqueue anything — it only INSERTs with `ingest_at = NULL`. The per-minute outbox poller (`src/server/memory/triggers.ts:265`, `buildMemoryIngestOutboxPollHandler` at `:270`, registered by the worker) is what enqueues `memory_event_ingest`. So:

- **Seeding alone needs only `DATABASE_URL`** — no pg-boss, no worker, no `OPENAI_API_KEY`/`XIAOMI_API_KEY`. `writeEvent` + `upsertFsrsState` + the table inserts are pure DB writes.
- **The FSRS / proposal / detection wins this station targets do NOT depend on the outbox at all.** `material_fsrs_state`, `knowledge_mastery` (PG view over `event`), and `proposal_signals` are read directly from tables/views — they light up the instant the rows exist, with **no worker running**.
- **The outbox → ingest → brief chain (mem0 vector store) is the ONLY part that needs the worker**, and that chain feeds the *brief* surface, which is dark until A3 anyway. We do not run mem0 in this station.

**The `--observe` pass drives the REAL nightly with a STUBBED `runTaskFn`.** Killer fact: `runKnowledgeEdgeProposeNightly(db, deps)` accepts a `deps.runTaskFn` override (`knowledge_edge_propose_nightly.ts:54-57,71`; default falls back to `defaultRunTaskFn` → real LLM). The seed passes a stub that returns a canned `EdgeProposeOutput` JSON, so the nightly runs its REAL body — real `getFailureAttempts(now-24h)` scan, real `runEdgeProposeAndWrite` (real `loadTreeSnapshot`, real dedup/self-loop/duplicate-edge/duplicate-pending logic, real `writeAiProposal` → `writeEvent`) — with **zero token spend and deterministic output**. This is strictly more faithful than synthesizing the propose event by hand, and it removes the entire spend-posture product fork. The script does **not** start the worker and does **not** call mem0. Rows seeded at `ingest_at = NULL` are harmless — a later worker's recovery sweep drains them; otherwise they sit inert, exactly like an un-ingested real event.

### D2 — Distribution shape: parameterized, simple, NOT a simulation engine

A handful of named, hard-coded-default knobs at the top of the script (a `const SEED_PROFILE = { ... }`), overridable by env for one-off experiments. **No config file, no scenario DSL, no random-seed RNG framework.** Deterministic-by-default (fixed pseudo-random with a constant seed inline, or plain modular arithmetic over the fixture index — whichever is simpler) so re-runs are reproducible.

Target shape (defaults, tune freely during impl):

| Knob | Default | Purpose |
|---|---|---|
| `nodes` | ~6–8 knowledge nodes (one root + children) per subject | enough for edges + clustering |
| `questionsPerNode` | 3–5 | exceed the mastery `<3 evidence → 0.5` shortcut on hot nodes |
| `attemptsPerQuestion` | 2–6, **clustered** | some nodes are "weak" (mostly `failure`), some "strong" (mostly `success`) |
| `failureClusterNodes` | 2 nodes | these accumulate ≥2 endpoint-referencing, same-`primary_category`, judge-backed failures → `strong` evidence for edge-propose (see `recentClusterAttempts` below) |
| `timeSpanDays` | 28 (≈4 weeks) | spreads `created_at` so P5.3 freshness + brief windows + 180d mastery window are all exercised; some events inside 24h, some 1–4 weeks old, all inside 30d |

**Two different windows — do NOT conflate them.** The edge-propose nightly DISCOVERY scan is `now-24h` (`knowledge_edge_propose_nightly.ts:58`, `getFailureAttempts(db, { since: now-24h })` → `gte(created_at, since)`). The rubric EVIDENCE window is `now-30d` (`RUBRIC_EVIDENCE_WINDOW_DAYS=30`, `rubric-validator.ts:42`). These are independent: a failure 5 days old is inside the 30d rubric window but INVISIBLE to the 24h nightly scan. The broad 28d distribution is fine for FSRS / mastery / detection, but the failure cluster that drives the edge-propose MUST sit inside the last 24h or the nightly scans 0 attempts and no-ops.

**`recentClusterAttempts` invariant (load-bearing for the edge-propose win):** the cluster that drives the stubbed-nightly edge-propose must have **≥2 failure attempts with `created_at` inside the last 24h**, each (a) sharing the SAME registry-valid `primary_category` (see GAP3), (b) chained to a `judge` event (judge-backed), and (c) with `referenced_knowledge_ids` (on the attempt or its judge) that include BOTH edge endpoints — see GAP4. Without all three, the rubric folds the proposal at the relation gate even though the cluster cleared the raw evidence floor.
| `reviewSpacing` | FSRS-realistic | reviews backdated with widening gaps (1d, 3d, 7d, …) driving real `due_at` via `scheduleReview` |
| `overdueFraction` | ~0.4 | fraction of reviewed questions whose final `due_at <= now()` so the due list is non-empty |

**Time distribution is the point** — events MUST be backdated across the span via `writeEvent({..., created_at})` so the freshness/staleness/decay machinery has signal. A flat "all at now()" history exercises none of it.

**What this is NOT:** not a learner-behavior simulator, not a markov model of study sessions, not an FSRS replay engine. It is "manufacture N causal chains with plausibly-spread timestamps." If a knob tempts you toward a state machine, stop — hard-code the two or three archetypes (weak node / strong node / mixed node) inline.

### D3 — Idempotency + dev-only safety (CRITICAL — the dev DB must stay clean-able)

Three independent guards, all required:

1. **Hard prod fence (refuse to run):** abort with a non-zero exit unless **both** hold:
   - `process.env.SEED_SYNTHETIC_OK === '1'` (explicit opt-in env, must be set deliberately), **and**
   - `DATABASE_URL` host resolves to loopback: matches `/localhost|127\.0\.0\.1/`, or equals `buildLocalDatabaseUrl()` (`scripts/local-db-env.ts:15`, default port 5433 `loom` DB). Any other host → refuse. NOTE: `isLocalConnection` is NOT an exported helper — it is a local `const` inside `src/db/client.ts:22` (the regex `/localhost|127\.0\.0\.1/`). The seed inlines the same loopback regex; it does not import it.

   `import { config } from 'dotenv'; config({ path: '.env', override: false })` runs at the TOP of the script, **before** importing `@/db/client` (the client throws on missing `DATABASE_URL` at construction, `client.ts:8-13`). This matches `dev-local.ts:5` / `migrate-local-db.ts:5`.

   Rationale: the map confirmed there is **no `NODE_ENV` fence anywhere** and the destructive `/api/_/*` routes are token-gated but not env-gated. We do not rely on `NODE_ENV`; we require an explicit opt-in env **and** a loopback DB. Belt and suspenders, because pre-product the cost of a misfire against a real DB is total.

2. **ONE conceptual marker — `payload.__synthetic = true` on every synthetic `event`.** This is the only marker that survives the `writeEvent` / producer path WITHOUT distorting actor identity. **`actor_ref` must NOT be used as the marker** — `actor_ref='synthetic'` collides with the producer actor literals (the propose/judge events the stubbed nightly writes carry `actor_ref='dreaming'`/the real judge ref, and `RateKnowledgeEdge` pins `actor_ref: z.literal('self')`, `known.ts:467`), and overwriting those would make the row un-faithful and break schema parse. `payload.__synthetic` rides as an extra payload key.
   - **Tolerance verified:** the Lane B payload schemas for `attempt` / `judge` / `review` / `propose` / `rate` are plain `z.object(...)`, NOT `.strict()` — the only two `.strict()` schemas in `known.ts` are `CorrectArtifactEvent` (:246) and `SuppressArtifactLink` (:294), neither of which the seed writes. `parseEvent = Event.parse` (`event/index.ts:40`) is a non-strict union, so an extra `__synthetic` payload key is tolerated and the row parses. (If a future schema adds `.strict()` to a payload the seed writes, the seed will fail loudly at `writeEvent` — acceptable: it surfaces the drift.)
   - **Non-event tables** carry their own native markers (the teardown handles): **`knowledge`** by id prefix `synthetic:` (e.g. `synthetic:wenyan:root`, mirroring the `seed:<domain>:<slug>` convention in `knowledge/seed.ts`); **`question`** by `metadata.fixture_ref` + `metadata.synthetic=true` + `source='synthetic_seed'` (reuse `seed/math/route.ts:49-56`); **`knowledge_edge`** by both endpoints being `synthetic:`-prefixed; **`material_fsrs_state`** by synthetic `subject_id`; **`proposal_signals`** by the synthetic `cooldown_key`s. Re-run = select-then-skip by id, like the two seed routes.

   **No new prod schema column.** Markers live in existing nullable/jsonb/id fields (`payload` jsonb, `metadata`, id prefix, `source`). If impl discovers a marker is genuinely impossible without a column, **stop and flag** — a new column means `pnpm audit:schema` write-path proof + a migration, out of proportion for a dev seed; the existing fields suffice.

3. **Subcommands `--reset` and `--reset --reseed`:**
   - `--reset` enumerates its **OWN delete order — it does NOT mirror `FK_ORDER`.** `FK_ORDER` (`src/server/export/constants.ts:29`) omits `proposal_signals` entirely, and includes `material_fsrs_state` but with NO enforced FK (it is polymorphic, unique on `(subject_kind, subject_id)`, `schema.ts:629`). So a FK_ORDER-driven cascade would leave both tables' synthetic rows orphaned. Instead, delete in reverse-FK order everything transitively rooted at synthetic `knowledge` nodes (`id LIKE 'synthetic:%'`): synthetic `event` rows (`payload->>'__synthetic' = 'true'`), `knowledge_edge` (both endpoints synthetic), `question` (`metadata.synthetic`), `knowledge` (id-prefix), **PLUS two explicit FK-less deletes**: `material_fsrs_state WHERE subject_id` is a synthetic question id (no FK → won't cascade), and `proposal_signals WHERE cooldown_key` IN the synthetic cooldown keys (no FK to knowledge → won't cascade). Wrap in a transaction; print deleted counts per table.
   - Default invocation = INSERT-or-skip (idempotent re-run, no cleanup of stale rows), exactly like the existing seed routes.
   - `--reset --reseed` = teardown then fresh seed in one go.
   - **Sentinel-survival is a hard gate:** a real (non-synthetic) row inserted before `--reset` MUST survive it. The DB test asserts this (see Test plan).

   We deliberately do **not** reuse `POST /api/_/import?confirm=wipe-and-reload` — that nukes all 17 tables and needs a backup ZIP. Scoped marker-delete keeps the dev DB clean-able without destroying any real data the user may also have.

### D4 — Question seed: reuse fixtures + existing schema, zero new prod schema

Fixtures (`src/subjects/{wenyan,math}/fixtures/data.json`) are eval-locked subject-LOCAL items, NOT `question` rows. Materialize them following the canonical pattern in `src/subjects/wenyan/fixtures/e2e.smoke.test.ts:46-65`:

1. **Knowledge nodes first** (FK + mastery dependency). Map each fixture's `knowledge_hint` string → a real `knowledge` node (the hint is **not** an id). One root per subject + a few children; `domain` set; `approval_status='approved'`. Synthetic id prefix per D3.
2. **Knowledge edges** (proposal targets, optional but wanted): insert a few real `knowledge_edge` rows between seeded nodes via the existing schema (`schema.ts:636-665`) for the *materialized* edges, but note most edges in this station arrive as **propose events**, not pre-existing rows (the proposal stack is what we want to light up).
3. **Question rows** from fixture items: `id`, `kind = item.kind`, `prompt_md`, `reference_md`, `choices_md ?? null`, `rubric_json ?? null`, `difficulty`, `source = 'synthetic_seed'`, `knowledge_ids = [<seeded node id>]`, `figures: []`, `image_refs: []`, `structured: null`, `variant_depth: 0`, `version: 0`, `metadata: { fixture_ref, knowledge_hint, synthetic: true }`. Required NOT-NULL columns: `id, kind, prompt_md, source, created_at, updated_at`.

No new prod schema. Reuse `core/ids` `newId()` for non-prefixed ids and the `synthetic:` prefix for nodes.

### D5 — Observability: ONE `--observe` subcommand (stubbed-runTaskFn nightly + presence report)

A documented subcommand the user runs **after** seeding to *see* Layer-8 working. There is no `--llm` / `--no-llm` fork. It:

1. **Drives the REAL edge-propose nightly with a STUBBED `runTaskFn`** (D1 — no worker, no pg-boss, no mem0, **zero token**):
   `runKnowledgeEdgeProposeNightly(db, { runTaskFn: stub })` (`knowledge_edge_propose_nightly.ts:54`). The stub returns a canned `EdgeProposeOutput` JSON (the propose the seed wants), so the nightly's REAL body runs: `getFailureAttempts(now-24h)` finds the `recentClusterAttempts`, `runEdgeProposeAndWrite` applies real dedup / self-loop / unknown-node / duplicate-edge / duplicate-pending checks, then `writeAiProposal` → `writeEvent` writes a PLAIN PASS propose event. **The nightly does NOT run the L1 rubric** (see GAP1 §D-GAP1), so it produces PASS proposes only — the rubric-REJECTED propose events are written DIRECTLY by the seed (GAP1), NOT by this pass.
   - The node-propose pass (`runKnowledgeProposeNightly`) is **out of scope** — not a named win for this station. Struck.
2. **Prints a "what lit up" presence report** (plain `console.table` / lines, no dashboard). This is proof-of-PRESENCE (count > 0 after seed), NOT a before/after diff — the Problem section already establishes before = 0, so a diff would be ceremony. Per-slice counts only:
   - FSRS due count: `due-list.ts` overdue slice (`material_fsrs_state.due_at <= now`) + never-reviewed slice count.
   - `proposal_signals` rows with `total = accept_count + dismiss_count > 0`, grouped by `kind`, with `acceptance_rate`.
   - edge `propose` events: PASS (no `rubric_verdict`) from the stubbed nightly + rubric-rejected (`payload.rubric_verdict.ok=false`) written directly — so the L1 floor is visibly exercised both ways and the L2 feedback digest's `top_rubric_gates` has rows to surface.
   - L2 gate-bump: call `resolveEdgeGateBump(db, relation, PROPOSAL_FEEDBACK_BUDGET, PROPOSAL_GATE_BIAS_CONFIG)` for the sized dismiss cluster's relation and print whether it returned `tightenMediumToStrong: true` (the P5.4-L2 win — see GAP6 §D-GAP6 for sizing).
   - active subjects detected via `listActiveSubjectsSinceRefresh` / `loadSubjectBriefEvents` (`active-subjects.ts`) — proves detection sees the seeded activity (resolved via `referenced_knowledge_ids` knowledge-id resolution, NOT scope tagging — see §D-detection).
   - `knowledge_mastery` view rows with non-null `mastery` and `evidence_count >= 3` — proves the mastery projection escaped the `0.5` shortcut.

`--observe` is read-mostly except for the stubbed-nightly propose writes it triggers. **Documented EXCEPTION:** the nightly PASS propose is built by the real `writeAiProposal` path from the canned `EdgeProposeOutput`, whose `EdgeProposalSchema` forbids extra keys — so this propose event CANNOT carry `payload.__synthetic`. `--reset` purges it instead by its synthetic edge endpoints (the second arm of the event-delete predicate matches any `knowledge_edge` propose/generate event with a `synthetic:`-prefixed endpoint). Every OTHER synthetic event the seed writes does carry `payload.__synthetic`.

### D-GAP1 — the nightly does NOT emit rubric-rejected events; the seed writes them directly

**Corrected false claim:** the original spec said `runKnowledgeEdgeProposeNightly` "runs L1 rubric, writes propose (or rubric-rejected) events." It does NOT. `runEdgeProposeAndWrite` (`propose_edge.ts:137-150` NOTE) explicitly does **not** call `validateProposalQuality` — Facet B rubric gating on this batch path is deferred to YUK-175. So the stubbed-nightly pass produces ONLY plain PASS propose events.

To get rubric-REJECTED rows (so the L2 feedback digest's `top_rubric_gates` lights up and the report shows the floor exercised both ways), the seed writes them DIRECTLY, replicating `foldRubricRejectedEdge`'s `event_override` (`proposal-tools.ts:443-468`):
- `action='propose'`, `subject_kind='knowledge_edge'`, `outcome='success'`, `actor_kind='agent'`.
- `payload = { from_knowledge_id, to_knowledge_id, relation_type, weight, reasoning, rubric_verdict: { ok:false, gate:<real RubricGate>, reason }, ai_proposal:<the ai_proposal payload>, __synthetic:true }`.
- `gate` MUST be a real `RubricGate` enum member (`rubric-validator.ts:49-67`) — e.g. `'evidence_level'` or `'contrasts_with_no_confusion'`.
- Cleanest impl: call `writeAiProposal(db, { actor_ref, outcome:'success', payload, event_override: { action:'propose', subject_kind:'knowledge_edge', payload: { ...the fields above..., __synthetic:true } } })`. `writeAiProposal` (`writer.ts:91-101`) merges `event_override.payload` and re-injects `ai_proposal` automatically, so the resulting event payload matches the folded shape exactly. Field note: on the NON-override path `writeAiProposal` maps `reason_md` → `reasoning`; on the override path the seed supplies `reasoning` directly in `event_override.payload`.

These rubric-rejected rows get NO rate event and NO `proposal_signals` row (terminal, by design) — do not chain them.

### D-GAP4 — endpoint-referencing evidence is MANDATORY for a PASS edge

For the PASS edge (the one the stubbed nightly proposes), the cluster failures — or their judges — MUST set `referenced_knowledge_ids` to include the edge endpoints. The rubric relation gates (`rubric-validator.ts:280-374`) fold otherwise:
- `prerequisite` / `applied_in` / `related_to` / `derived_from` (default): ≥1 in-window judge-backed failure must reference AN endpoint (`referencingEndpoint.length > 0`), else `prerequisite_no_order_evidence` / `applied_in_role_mismatch` / `related_to_dumping_ground` / `derived_from_no_endpoint_evidence`.
- `contrasts_with`: ≥1 failure must reference BOTH endpoints (`referencingBoth.length > 0`), else `contrasts_with_no_confusion`.

The effective ref set is `attempt.referenced_knowledge_ids ∪ attempt.judge.referenced_knowledge_ids` (`effectiveReferencedKnowledgeIds`, :194). The `ai_proposal.evidence_refs` MUST point at exactly those endpoint-referencing attempt event ids. **A same-`primary_category`-only cluster clears the evidence FLOOR (`computeEvidenceLevel` → strong via shared cause) but FOLDS at the relation gate** — so the "or cause category" alternative is DROPPED: endpoint-referencing is mandatory for PASS rows. Pick a relation for the PASS edge whose gate you can satisfy; the simplest is a non-`contrasts_with` relation needing only ONE endpoint-referencing failure.

### D-GAP3 — synthetic judge chain (hard requirement)

Each cluster failure attempt must be chained to a `judge` event written via `writeEvent`:
- `action='judge'`, `actor_kind='agent'` (`JudgeOnEvent` pins `actor_kind: z.literal('agent')`, `known.ts:50`), `subject_kind='event'`, `subject_id=<attempt.id>`, `caused_by_event_id=<attempt.id>`, `outcome='success'`.
- `payload.cause` must satisfy `CauseSchema` (`cause.ts:13-18`): `{ primary_category, secondary_categories:[], analysis_md:<non-empty>, confidence }`. **`primary_category` must be a REGISTRY-VALID cause category for the subject profile** — for wenyan, one of `concept` / `knowledge_gap` / `reading` / `memory` / `expression` (`wenyan/profile.ts:44+`); an unregistered id makes the cluster cause not match (and a bad profile throws at registry register). `analysis_md` non-empty matters for the single-event rescue and for `hasExplicitJudgeAnalysis`.
- `payload.referenced_knowledge_ids` carries the endpoint ids (GAP4).

### D-GAP6 — sizing the L2 dismiss cluster so the gate-bump actually fires

`resolveEdgeGateBump` → `computeGateBump` (`adaptive-bias.ts:373-388`) returns `tightenMediumToStrong: true` ONLY when, for the relation cell, `total >= minSamples` AND `acceptance_rate < acceptanceThreshold`. `loadEdgeRelationCounts` (:412-419) SUMs `accept_count` / `dismiss_count` across ALL `proposal_signals` rows (cooldown_keys) for that relation. The real config (`budgets.ts:203`): **`minSamples = 5`, `acceptanceThreshold = 0.3`**. So 1-accept/1-dismiss-per-edge does NOT trip it (total 2 < 5).

To exercise the win: build a dismiss cluster on a **SINGLE `relation_type`** spanning **multiple distinct `from|to` pairs** (each pair = its own `cooldown_key`, its own `proposal_signals` row), so the relation-summed `total >= 5` and the summed `acceptance_rate < 0.3`. E.g. 5–6 dismisses + 0–1 accepts on the same relation across 5–6 edge pairs → total ≥5, rate ≤0.17 < 0.3 → `tightenMediumToStrong: true`. Use a relation distinct from the PASS edge's relation so the bump's effect is isolated and observable.

### D-detection — active-subject detection uses knowledge-id resolution, NOT scope tagging

`computeAffectedScopes` (`scope_tagger.ts:38`) tags `topic:<knowledgeId>` from `referenced_knowledge_ids` but does NOT emit `subject:*` for attempt/review events (it only emits `subject:` when `payload.subject_id`/`subject`/`domain` is set, which these events don't carry — BR-10). Active-subject detection (`active-subjects.ts:11,30-95`) resolves subjects via the knowledge nodes in `payload.referenced_knowledge_ids`, NOT via `affected_scopes` `subject:` tags. So impl must NOT expect `subject:*` in `affected_scopes`; detection works because the synthetic attempts reference real synthetic knowledge nodes whose domain resolves to a subject.

---

## Mechanism — the seed pipeline, step by step (with real anchors)

Dependency order (the map's prerequisite chain). Each step uses the exact verified shapes.

**Step 0 — Guard + env.** `import 'dotenv/config'` (or `config({ path: '.env' })`) **before** importing `@/db/client` (the client throws on missing `DATABASE_URL` at construction, `client.ts:8-13`). Enforce D3 prod fence. Scripts load `.env`, not `.env.local`.

**Step 1 — Knowledge nodes.** Insert `knowledge` rows (`schema.ts:49-65`). Required: `id` (synthetic-prefixed), `name`, `created_at`, `updated_at`. Set `domain`, `parent_id` for the tree. Idempotent select-then-skip by id.

**Step 2 — Knowledge edges (materialized few).** Insert `knowledge_edge` rows between seeded nodes (`schema.ts:636-665`): both endpoints seeded, `relation_type` ∈ the 5 core enums, `created_by` AgentRef, `weight`. Unique on `(from, to, relation_type)`.

**Step 3 — Questions.** Materialize fixture items → `question` rows per D4. `knowledge_ids` = seeded node ids.

**Step 4 — Mastery-feeding + FSRS-feeding events** (backdated, clustered). For each question, via `writeEvent(tx, {...})`:
- **Attempts:** `action='attempt'`, `subject_kind='question'`, `subject_id=<question.id>`, `outcome ∈ {success|failure|partial}`, `payload = { answer_md, answer_image_refs: [], referenced_knowledge_ids: [<node ids>] }` (`AttemptOnQuestion`, `known.ts:25-41`). `created_at` spread across `timeSpanDays`, inside 180d. ≥3 per hot node to clear the mastery shortcut (view `drizzle/0005_...sql:24-31`).
- **Reviews (drive FSRS):** for the reviewed subset, compute `scheduleReview(prevStateOrNull, rating, asOf)` (`src/server/review/fsrs.ts:35`) iteratively over the backdated review timeline, write `review` events (`ReviewOnQuestion`, `known.ts:69-101`: `payload = { fsrs_rating, fsrs_state_after, user_response_md, referenced_knowledge_ids }`, honoring the `again→failure / hard,good→success` superRefine invariant), and `upsertFsrsState(tx, { subject_kind:'question', subject_id, state, due_at, last_review_event_id })` (`fsrs/state.ts:36-58`) with the final `due_at`. Tune the last rating/timestamp so `overdueFraction` of items end with `due_at <= now()`.
- **Never-reviewed due slice:** leave some questions with only a `failure` attempt and no `material_fsrs_state` — they surface via `getFailureAttempts` (`queries.ts:166-179`) in `due-list.ts:216-276`.

**Step 5 — Causal chains for the proposal stack.** Two distinct shapes; both root in the Step-4 attempts (`caused_by_event_id` is the linkage; `cooldown_key` is the only join into `proposal_signals`).

**5a — the PASS edge (driven by the stubbed nightly, not hand-written):**
1. **`recentClusterAttempts`** (Step 4) → ids `A1, A2, ...`: ≥2 failure attempts, same registry-valid `primary_category`, `created_at` inside the last 24h (D2 invariant), each referencing the edge endpoint(s) per GAP4.
2. **Judge** per attempt via `writeEvent` (GAP3 §D-GAP3): chains `caused_by_event_id=Ai`, `subject_id=Ai`, carries the endpoint `referenced_knowledge_ids` and a registry-valid `primary_category`.
3. **`--observe` runs the stubbed nightly** → it discovers `A1,A2` (24h scan), and `runEdgeProposeAndWrite` → `writeAiProposal` writes the PASS propose event `P` with the real `cooldown_key` (`knowledge_edge:<from>|<to>|<rel>`) and `evidence_refs` pointing at the cluster attempts. The seed's stub supplies a `reasoning` that **names a concrete signal** (id token / 「」-quoted node name / `judge`/`cause`/`失败`/`错题`) so it clears G7a if the rubric were ever run (`rubric-validator.ts:97-121`); the stub sets `suggestion_kind='proactive'` (NOT `'corrective'` — corrective zeroes the KPI count). The PASS propose event CANNOT carry `__synthetic` (the canned `EdgeProposeOutput` flows through `EdgeProposalSchema`, which forbids extra keys) — it is the documented `--reset` EXCEPTION, purged by synthetic endpoint instead (see §D5).
4. **Rate** via `writeEvent`: `action='rate'`, **`actor_kind='user'` AND `actor_ref='self'`** (`RateKnowledgeEdge` pins `actor_ref: z.literal('self')`, `known.ts:467` — the prior spec omitted `actor_ref`), `subject_kind='knowledge_edge'`, `outcome='success'`, `caused_by_event_id=P`, `payload = { rating: 'accept'|'dismiss', user_note?, __synthetic:true }`. The rating enum is `accept|dismiss|reverse|change_type|rollback` (`known.ts:473`); use `accept`/`dismiss`. (For an `accept`, optionally also direct-insert the `knowledge_edge` row to mirror promotion — NOT required for the proposal-stack wins; skip unless a downstream slice needs the materialized edge.)
5. **proposal_signals** via **`recordProposalDecisionSignal(db, source, 'accept'|'dismiss')`** (GAP5 §D-GAP5) — the single signal write lane (D1). It maintains `accept_count`/`dismiss_count`/`acceptance_rate`, sets `cooldown_until=now+7d` on dismiss, unique on `(kind, cooldown_key)`.

**5b — rubric-rejected edges (hand-written directly, NOT via the nightly):** per GAP1 §D-GAP1 — a `propose` event carrying the `foldRubricRejectedEdge` `event_override` payload with `rubric_verdict:{ ok:false, gate:<real RubricGate>, reason }`. These get **NO** rate and **NO** `proposal_signals` row (terminal, by design — that IS the correct behavior to demonstrate).

**5c — the L2 dismiss cluster (sizes the gate-bump):** per GAP6 §D-GAP6 — 5–6 PASS-style propose+rate chains on a SINGLE `relation_type` across distinct `from|to` pairs, mostly `dismiss`, so the relation-summed `total ≥ minSamples(5)` and `acceptance_rate < acceptanceThreshold(0.3)`. This is what makes `resolveEdgeGateBump` return `tightenMediumToStrong: true`.

### D-GAP5 — `recordProposalDecisionSignal` source shape (the early-return traps)

`recordProposalDecisionSignal` (`signals.ts:176`) early-returns and writes NO row in two cases the seed must avoid:
- **falsy `cooldown_key`** (`:182-183`) — so the `ProposalSignalSource.payload.cooldown_key` MUST be set.
- **corrective + accept** (`:194-198`) — so `suggestion_kind` must be `'proactive'` (or omitted; absence === proactive) for the accept side.

Pass: `{ id:<propose event id P>, kind:'knowledge_edge', payload:{ cooldown_key:'knowledge_edge:<from>|<to>|<rel>', suggestion_kind:'proactive' } }`. The `cooldown_key` MUST be the DIRECTIONAL form `cooldownKeys[0]` from `edgeCooldownKeys` (`proposal-tools.ts:91-100`): for asymmetric relations (`prerequisite` / `applied_in` / `derived_from`) `cooldownKeys[0]` is `knowledge_edge:${from}|${to}|${rel}`. NOTE: for the two SYMMETRIC relations (`related_to` / `contrasts_with`) `cooldownKeys[0]` is the SORTED-normalized form, not the directional — if the seed uses a symmetric relation for a signal, match `cooldownKeys[0]` exactly (sorted endpoints), and ensure the PASS propose event's `cooldown_key` uses the same so the gate-bump's relation-scoped sum lines up.

---

## CLI / usage

```bash
# guard env required for ALL invocations
export SEED_SYNTHETIC_OK=1
export DATABASE_URL="postgres://loom:loom@127.0.0.1:5433/loom?sslmode=disable"  # loopback only

pnpm seed:synthetic                                 # idempotent seed (insert-or-skip)
pnpm seed:synthetic --reset                         # scoped teardown of synthetic rows only
pnpm seed:synthetic --reset --reseed                # clean re-seed
pnpm seed:synthetic --observe                       # seed (if needed) + stubbed-nightly pass + print "what lit up"
```

Add a `package.json` script alias `"seed:synthetic": "tsx scripts/seed-synthetic.ts"` (one line, mirrors `worker:dev` / `dev:local`). This is **non-optional**. `--observe` is always zero-token (stubbed `runTaskFn`) — there is no `--llm` / `--no-llm` flag, so it is always CI-safe.

---

## What lights up (and what stays dark)

**Lights up NOW (no worker, no mem0, no A3):**
- **FSRS due list** — overdue (`material_fsrs_state.due_at <= now`) + never-reviewed slices; non-empty due count.
- **knowledge_mastery view** — non-null mastery on hot nodes with `evidence_count >= 3`.
- **proposal_signals + acceptance digest** — `getProposalAcceptanceRates` returns non-empty (`total > 0`); per-kind acceptance rates.
- **L2 adaptive bias** — `resolveEdgeGateBump` has real signal to read; the SIZED dismiss cluster (single relation, total ≥5, rate <0.3) triggers `tightenMediumToStrong` (GAP6).
- **L1 edge evidence floor + edge-propose** — the stubbed-runTaskFn `runKnowledgeEdgeProposeNightly` produces PASS proposes from the in-24h endpoint-referencing `strong` cluster; rubric-rejected propose events are hand-written (GAP1). Both visible, both feed the L2 feedback digest.
- **Subject-brief activity detection** — `listActiveSubjectsSinceRefresh` / `loadSubjectBriefEvents` detect the seeded activity.

### Sequencing: brief stays dark until Station 2

The **memory-brief surface** (`query_memory_brief`, the mem0 vector store, the regenerated brief text) requires the outbox → ingest → regen chain, which requires the worker + mem0 env (`OPENAI_API_KEY` + `XIAOMI_API_KEY`) **and** the A3 wiring that Station 2 delivers. Synthetic events sit at `ingest_at = NULL` and are correctly never ingested in this station. **Station 1's observable wins are FSRS + proposal stack + detection. Brief comes after Station 2.** This is stated plainly so the user is not surprised that `query_memory_brief` returns empty after seeding.

---

## Test / verify plan

- **Unit (no DB):** distribution/knob math (timestamp spread inside windows, overdue fraction, cluster assignment) is pure-function — test it in the unit partition. Guard-fence logic (refuse on non-loopback `DATABASE_URL`, refuse without opt-in env) is pure-string and unit-testable.
- **DB integration (`vitest.db.config.ts`, real Postgres testcontainer):**
  - Run the seed against the testcontainer DB; assert `knowledge_mastery` returns ≥1 row with `evidence_count >= 3` and non-null mastery.
  - Assert `due-list` overdue + never-reviewed counts > 0.
  - Assert `getProposalAcceptanceRates` returns ≥1 kind with `total > 0`.
  - Assert at least one PASS edge `propose` (from the stubbed nightly, no `rubric_verdict`) and one rubric-rejected `propose` (`payload.rubric_verdict.ok=false` with a real `RubricGate`) exist.
  - Assert the SIZED dismiss cluster makes `resolveEdgeGateBump(db, relation, ...)` return `tightenMediumToStrong: true` for that relation (GAP6).
  - Assert `--reset` returns the DB to zero synthetic rows including the FK-less `material_fsrs_state` (synthetic subject_id) + `proposal_signals` (synthetic cooldown_keys), and leaves any non-synthetic rows untouched — **insert a sentinel real row, confirm it survives reset** (hard gate).
  - Assert idempotency: seed twice → same row counts (no duplicates).
- **`--observe` is always CI-safe** (stubbed `runTaskFn`, zero token); there is no LLM-on path.
- Verification before claiming done: run the DB tests, capture the `--observe` report output as evidence.

## Gate (before PR)

`pnpm typecheck`, `pnpm lint`, `pnpm audit:schema` (must stay green — **no new schema** expected), `pnpm audit:partition`, `pnpm test`, `pnpm build`. If a seed-marker column ever became necessary (it should not), `audit:schema` would require a write-path proof + allowlist entry — flag and stop before going there.

## Acceptance

1. `scripts/seed-synthetic.ts` runs to completion on a loopback dev DB with only `DATABASE_URL` + `SEED_SYNTHETIC_OK=1`, no worker, no mem0 env, **zero token spend**.
2. Refuses to run against a non-loopback `DATABASE_URL` or without the opt-in env (exit non-zero, clear message).
3. After seed, the five non-brief Layer-8 slices are observably non-empty via `--observe`: FSRS due count, proposal_signals rows (+acceptance_rate), edge proposals (PASS + rubric-rejected), L2 gate-bump fires on the sized dismiss cluster, subject-brief activity detection finds active subjects.
4. `--reset` cleanly removes only synthetic rows — including the FK-less `material_fsrs_state` + `proposal_signals` via their own explicit deletes — and a sentinel real row survives; re-run is idempotent.
5. Write lanes: `event` via `writeEvent`; `proposal_signals` via `recordProposalDecisionSignal`; PASS propose via the stubbed-`runTaskFn` real nightly; rubric-rejected propose via direct `foldRubricRejectedEdge`-shaped write; all other tables markered direct-insert. **No coupling to `decideKnowledgeEdgeProposal` / `writeAiProposal` as a routing layer; zero new prod schema.**
6. Gate green.

## Out of scope / Deferred (do NOT build)

- **No worker / pg-boss orchestration in the script.** No per-minute cron, no `createBoss`. (The brief chain that needs it is Station 2.)
- **No mem0 / brief ingestion.** `query_memory_brief` stays empty by design this station.
- **No NODE_ENV-based fencing as the primary guard** (the codebase has none; we use opt-in env + loopback check).
- **No new `/api/_/*` route**, no admin UI, no dashboard. Observability is `console` output from a subcommand.
- **No new prod schema column / migration** unless impl proves a marker is otherwise impossible (almost certainly not — `payload.__synthetic` jsonb / `metadata` / id-prefix / `source` / `cooldown_key` suffice).
- **No simulation engine / scenario DSL / config-file format.** Inline knobs + a couple of hard-coded archetypes only.
- **No whole-DB wipe reuse** (`/api/_/import?confirm=wipe-and-reload`). Scoped marker-delete only.
- **No production seeding.** Dev/local only, by construction.
- **No `--llm` / `--no-llm` fork.** Single `--observe` mode driving the real nightly via a stubbed `runTaskFn` (zero token). The spend-posture product fork is CUT — nothing blocks autonomous execution.
- **No node-propose pass.** `runKnowledgeProposeNightly` is not a named win for this station. Struck.
- **No coupling to the real producers as a routing layer.** `decideKnowledgeEdgeProposal` / `writeAiProposal` are not used as the seed's write path (except the `writeAiProposal` + `event_override` calls that emit the rubric-rejected shape AND the L2 dismiss-cluster proposes — §5b/§5c). The real LINKAGE logic is exercised by the stubbed-runTaskFn nightly instead.
- **No three-marker scheme.** ONE conceptual marker: `payload.__synthetic = true` on events; native id/metadata/cooldown_key markers on the FK-less / non-event tables. No `actor_ref='synthetic'` marker (it collides with producer actor literals).

_No remaining product forks._ Write strategy, distribution shape, idempotency/safety, question-seed, observability, and the spend posture are all resolved above as autonomous technical calls.
