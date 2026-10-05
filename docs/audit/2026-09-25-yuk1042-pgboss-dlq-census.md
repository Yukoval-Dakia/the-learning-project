# pg-boss DLQ backlog census — YUK-1042

**Date**: 2026-09-25 · **Scope**: Mac 本地生产库（`the-learning-project-postgres-1`，pgboss schema v37，pg-boss 12.26.3）· **Branch**: `feat/yuk-1042-dlq`（只含本文档）

## 0. Context — worker was down the whole time

At census time the Mac compose stack had **only `postgres` running**; `app`/`worker` containers exited ~2026-09-19 05:42 UTC (all `pgboss.job` activity stops at that timestamp). DLQ rows are **informational tombstone copies**: `*_dlq` queues are created without consumers (`src/server/boss/queue-config.ts` `createJobQueue` → `deadLetter: <name>_dlq`; `boss.work` is never registered on them), so DLQ copies sit in `state='created'` with `data` copied from the failed job and `source_name`/`source_id`/`source_retry_count` back-references. They are **not executable work** and cannot "recover" by themselves.

**Retention caveat for future readers**: `keep_until` on all 27 rows has already passed (2026-09-19→25, 7-day retention). They persist only because no boss process runs the deletion maintenance while the worker is stopped. **The next worker start will auto-purge all 27 DLQ rows (and the 27 `failed` parents)** — this doc is the durable record.

## 1. Census (27 DLQ rows, all 2026-09-12 → 09-18)

| DLQ queue | n | parent failed_at | failure output | category |
| --- | --- | --- | --- | --- |
| `memory_event_ingest_dlq` | 8 | 09-17 11:17–11:28 | `ProviderAttemptLifecycleError: provider attempt recovery_required` (see §3a) | transient-fence → now permanently stalled (see §4) |
| `memory_event_ingest_dlq` | 11 | 09-17 13:17–15:43 | `MemoryReconcileHandoffError: enqueue unconfirmed <event_id>` | consumer slot-contention drop (see §3b) |
| `dreaming_nightly_dlq` | 2 | 09-16 19:02, 09-17 19:02 | `AgentRunError subtype=budget_timeout` ("Claude Code process aborted by user" / "provider attempt aborted during query") | transient abort (pre-pi image) |
| `knowledge_maintenance_nightly_dlq` | 2 | 09-16/09-17 18:52–18:53 | `streamTask failure: Claude Code process aborted by user` | transient abort |
| `coach_daily_dlq` | 1 | 09-18 18:38 | `AgentRunError subtype=budget_timeout` | transient abort |
| `quiz_gen_dlq` | 1 | 09-17 11:17 | `AgentRunError subtype=budget_timeout` | transient abort |
| `quiz_verify_dlq` | 1 | 09-12 22:07 | `parseQuizVerifyOutput: schema invalid … received undefined` (mimo empty output) | model-output parse failure (known; rerun可补) |
| `note_refine_dlq` | 1 | 09-17 11:20 | `parseNoteRefineOutput: JSON.parse failed … position 722` | model-output parse failure |

All parents exhausted `retry_count=2/2`. Failure windows correlate with the pre-pi image `c89079b68` (Agent-SDK era) bursts on 09-16→09-18.

## 2. Payload states verified

### `memory_event_ingest_dlq` (19) — split into two groups

| group | n | events | `add_started` | `ingest_completed` | mem0 row | reconcile dispatched? |
| --- | --- | --- | --- | --- | --- | --- |
| A `recovery_required` | 8 | `s65yoco38…`, `jw8opkaq…`, `qggtcj77…`, `rfmykwb5…`, `hct5tra8…`, `g4kh8gie…`, `ccv2p2uo…`, `drggpx1a…` (all `review` actions, 09-17 11:14–11:25) | yes | **no** | **0** | no |
| B `enqueue unconfirmed` | 11 | `d9vgrgrh…`, `m8cvngpu…`, `t3qszhes…`, `b6r78av7…`, `xh23rdl8…`, `vz32qahe…`, `v8g0wv6z…`, `n78ge1bg…`, `ecx396u5…`, `kkchu5x9…`, `pgfdghjk…` (rate/generate, 09-17 13:11–15:38) | yes | yes (`provider_result`, `memory_count=1`) | **1 each** | **no** |

Global state: `ingest_at` stamped on all 19 source events (outbox will not re-enqueue); zero `reconcile_intent`/`reconcile_dispatch_complete` handoff events exist **ever** (`MEMORY_RECONCILE_HANDOFF_MODE` unset → `observe`); all 19 `memory_reconciliation_log` rows are `KEEP_BOTH`/`applied`; `event` pending ingest = 0.

### §3a. Why `recovery_required` (group A)

`executeMem0OpaqueOperation` (providerStartFence=`operation_kind`) reserves `provider_start_reserved_at` per attempt; the crashed/aborted attempts left `provider_attempt` rows with `reserved_at` set but terminal `released` admission. The fence treats any such prior attempt as `recovery_required` (unknown paid outcome — fail closed). Verified today: all 39 `add_inferred` blockers are `terminal + released` (the sweeps landed post-mortem), so a fresh attempt would now reserve cleanly — but then hits the `add_started` wall (§4).

### §3b. Why `enqueue unconfirmed` (group B)

`dispatchMemoryReconcile` → `boss.send('memory_reconcile', …, {id: <deterministic>, singletonKey:'memory.reconcile.self', singletonSeconds:90, singletonNextSlot:true})`. pg-boss v12 `createJob` tries the current 90s slot, then one offset slot, then **returns `null`** (insert skipped by `ON CONFLICT DO NOTHING` on `job_common_i4` `(name, singleton_on, singleton_key)`). Readback `getJobById` then finds no row (nothing was inserted for this deterministic id — the colliding rows belong to *other* events' dispatches) → `enqueue unconfirmed`. During 13:13–13:21 eight reconcile jobs churned the singleton key back-to-back, so retries kept dropping. **The reconcile jobs were never enqueued.**

## 4. Dispositions

| queue/group | disposition | rationale | executed? |
| --- | --- | --- | --- |
| `dreaming_nightly_dlq` (2), `knowledge_maintenance_nightly_dlq` (2), `coach_daily_dlq` (1) | **archive-drop** (keep as tombstone; auto-purge on next worker start) | Later-scheduled runs already completed 09-17/09-18 — work is superseded. Retry would re-spend nightly-agent budget for stale windows. | n/a |
| `quiz_gen_dlq` (1) | **archive-drop** | budget_timeout during a knowledge-triggered gen burst; supply chain ran normally afterward (12 quiz_gen completed). Not worth a paid re-gen absent a specific demand. | n/a |
| `quiz_verify_dlq` (1) | **archive-drop** | `jo3i…` went `active` 09-13 via re-dispatch; `vddx47…` remains `draft` — consistent with fail-closed parse-failure design (owner can re-dispatch quiz_verify manually if the draft is wanted). | n/a |
| `note_refine_dlq` (1) | **archive-drop** | Artifact `fnkwx…` is `generation_status=ready`, `verification_status=verified`; a refine on a 08-15 artifact triggered by mastery signals is best-effort and stale. | n/a |
| `memory_event_ingest_dlq` group B (11) | **translate-or-drop; not retried by this lane** | Events fully extracted (mem0 row + `ingest_completed` present). Only the `memory_reconcile` dispatch was dropped. In `observe` mode intents were never persisted, so `recoverMemoryReconcileHandoffs` cannot replay them; translation would require materializing intents or re-sending the deterministic job with the mem0 result payload. Reconcile is advisory (YUK-690 forces KEEP_BOTH), so **zero business effect from the drop**; a re-dispatch costs 1 mem0 embed-search + 1 GLM judge call per event. Recommendation: drop; optionally file a ticket for a reconcile-completion audit. | not executed (paid GLM call + no material benefit) |
| `memory_event_ingest_dlq` group A (8) | **report — needs owner decision** | `add_started` marker exists + 0 mem0 rows → every retry fails closed at `claimMemoryIngest` ("incomplete or ambiguous") **by design**: protocol cannot distinguish "paid add that wrote nothing" from "crash before add". Recovery requires an explicit fence decision: (a) verify external truth (mem0 lookup returned 0 twice — evidence the add never landed) then remove the marker and re-ingest (1 paid add each, ~8 calls), or (b) accept the 8 review-events as absent from the fact layer (their content is practice-review facts; impact = memory/brief quality only). | not executed (ambiguous, per ticket) |

## 5. YUK-1055/1056 interplay

- None of the 27 payloads are cutover artifacts of the question-assessment migration (YUK-1044/1050 lanes): DLQ payloads are pg-boss job data, not `question`/`question_part` rows. `quiz_verify_dlq`'s payload is the legacy `{question_ids:[]}` shape — it predates the contract migration and should **not** be retried into the new chain; if the `vddx47…` draft is still wanted post-cutover, re-dispatch belongs to the 1055/1056 lane's verify path, not to this DLQ row.
- `memory_event_ingest` group A's stuck `add_started` markers are an owner-local handoff fence (YUK-858 / ADR-0052), orthogonal to 1055's translation fences.

## 6. Findings worth follow-up (Linear capture)

1. **`enqueue unconfirmed` = `memory_reconcile` singleton drop.** `singletonKey:'memory.reconcile.self'` + `singletonNextSlot` collapses a burst into at most 2 slots; `send` returning `null` is pg-boss's designed "drop" — the handoff treats it as a hard failure, so the ingest job burns both retries and DLQs even though extraction succeeded. Under `observe` mode the drop is invisible (no intents persisted → recovery can't see it). Suggest: treat `send=null` under observe mode as a warn-skip (dispatch-complete is advisory), or lift the singleton for reconcile dispatches.
2. **`add_started` stall has no operator path.** A crashed-after-reserve add leaves the event permanently unfenceable without manual DB surgery. The protocol needs either a "verify-then-release" recovery operator or a documented runbook step.
3. **DLQ rows are invisible while the worker is down** (purged on next start). If DLQ backlog should survive for audit, a script to persist `pgboss.job` DLQ rows to a file before worker restart is the minimal artifact; not built here (no live consumer beyond this census).
