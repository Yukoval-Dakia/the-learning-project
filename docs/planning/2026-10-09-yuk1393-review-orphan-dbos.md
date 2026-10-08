# YUK-1393 review orphan DBOS migration

Implementation authorized after PR1619 merged as main `6aaf8ca89eaf5feb5af5c00b7c5b3bd90cd953ea`. Scope ownership was confirmed by 57961995 after inspecting 75 worktrees; migration0116 reserved and freshly checked absent. This proposal remains subject to implementation review and actual acceptance. No runtime cutover is authorized by source implementation alone.

Parent decisions: preserve known row-failure next-daily-tick behavior; unknown transaction outcomes require authoritative lock/receipt reconciliation. During draining, finish admitted candidate lists and record unadmitted/late ticks as fenced/no-effect, not completed business work. Preserve existing started_at age semantics; YUK1246 separately tracks paused-age product semantics and is not claimed fixed.

# Review orphan cleanup: minimal durable design

Original consultation status: read-only proposal, 2026-10-09. The implementation record below supersedes this status for the current candidate. Workspace `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1363-test-storage`; inspected HEAD `3883903f2a75d50d0e1ce0f371f850e5ddb48742`, supplied base `f80d47703`. No implementation, DB access, tests, build, services, providers, PR/Linear actions, or delegation. Only this file was written. PR1619/1392 merge and ownership coordination remain prerequisites supplied by the parent, not independently verified here.

Recommendation: retain per-session commits, freeze each tick's candidate set before effects, and commit a per-session receipt in the same outer transaction as the existing Review writer. Add this family to the existing DBOS host through one collected registration call. Keep `prune_job_events` identities, phase, receipts, workflow steps and recovery behavior unchanged. Do not introduce a generic migration framework.

The existing surveys are inputs, not reopened candidate selection: `docs/planning/2026-10-09-yuk1359-next-dbos-family.md` and `/tmp/yuk1359-next-dbos-family-20261009.md`. The earlier temporary survey's suggestion that current-state convergence might need no receipt is superseded by this proposal. State can change after a committed effect, and job-event retention is finite.

## Source facts

All repository references below are relative to the workspace and refer to the inspected HEAD. Installed package references describe local source, not deployed artifacts.

- The handler selects `review`, `started|paused`, `started_at < Date.now()-6h`, then individually calls `Review.abandonReviewSession`; it catches every row error and returns only an abandoned count. Selection and transition are separate (`src/server/boss/handlers/prune_orphan_review_sessions.ts:22-48`). The daily schedule is `15 4 * * *`, `Asia/Shanghai`; the current infra registrar mounts its handler and schedules it (`src/server/boss/handlers.ts:45-52,115-125,202-212`). Existing tests cover old/fresh, terminal, empty and paused rows, not crash or concurrent reopen (`src/server/boss/handlers/prune_orphan_review_sessions.test.ts:22-79`).
- `loadReviewSessionForUpdate` is private and locks the review row; `applyReviewSessionTransition` already accepts `Db | Tx` and starts a transaction. Abandon changes status, ended/updated timestamps and version, and writes `review.abandoned` in that transaction. Reopen changes `started_at`, clears `ended_at`, increments version, and emits `review.reopened` (`src/server/session/review.ts:36-45,69-128,166-185,297-301,343-347`). Pause/resume preserve `started_at`. The session module is the single write owner (`src/server/session/index.ts:9-17`).
- Existing prune commits its delete and workflow receipt together, validates identity/cutoff on replay, and gates under its own control-row lock (`src/server/durable/prune-family.ts:44-75`). Its phase transition checks outstanding jobs/workflows and terminal dispositions; its recent-receipt test covers the previous cron point's 60-second window (`:19-26,78-140`). These tables and trigger are specifically named for `prune_job_events` (`drizzle/0115_yuk1355_prune_backend.sql:1-36`).
- The manifest registrar launches DBOS when it encounters `prune_job_events` and rejects other DBOS families (`src/server/boss/register-capability-jobs.ts:51-59,119-134`). `startPruneWorker` is the sole owner; it registers the workflow before launch, configures `tlp-housekeeping`, `tlp_dbos`, executor `local`, application version `prune-v1`, and reconciles family schedules/consumers (`src/server/durable/prune-worker.ts:19-39,42-115,117-167`). Worker startup calls infra registration before capability registration (`src/server/boss/start-worker.ts:109-129`). Shutdown already calls `stopDurableWorker()` and subtracts its duration from the 30-second boss budget (`src/server/boss/shutdown.ts:50-58`).
- Installed DBOS is 5.2.11; pg-boss is 12.36.0 (their `package.json:3`). DBOS rejects registration after launch (`node_modules/@dbos-inc/dbos-sdk/dist/src/decorators.js:155-158,277-288`), recovers pending workflows by executor AND application version (`dist/src/dbos-executor.js:818-831`), and checks replayed step names (`:570-581`). Its native schedule ID is `sched-${scheduleName}-${scheduledDate.toISOString()}` and scheduled runs target the owner's latest application version (`dist/src/scheduler/scheduler.js:190-224`).
- DBOS records thrown step errors, and replay revives the recorded result/error (`dist/src/dbos-executor.js:570-581,706-725`). `resumeWorkflows` explicitly excludes `SUCCESS` and `ERROR` (`dist/src/system_database.js:1398-1423`). Therefore a process crash before checkpoint and a terminal recorded step error are different recovery cases. Do not promise that `resumeWorkflow(ERROR)` retries this work.
- pg-boss's occurrence window is 60 seconds; `onSendIt` strips its `key`/`slot` bookkeeping before forwarding the schedule's request (`node_modules/pg-boss/dist/timekeeper.js:46,666-673`). This family's old `{}` payload does not carry a trustworthy original scheduled timestamp.
- Epoch disposition is `drain`; pg-boss permits an active marker with an older code epoch and rejects maintenance states (`src/server/contract-epoch/boss-fence.ts:39-58`; `jobs.ts:32`). DBOS prune currently uses `waitForRunnableEpoch`, a separate existing contract (`src/server/durable/prune-worker.ts:28-34`). Preserve both existing prune paths; explicitly test the new family's maintenance behavior.
- Admin config projects infra schedules from the registrar and also projects capability schedules; moving the declaration must leave one visible row (`src/server/config/admin-config-facts.ts:223-237`). Execution receipts are excluded from learner archives because they must travel with pg-boss and DBOS in a full PostgreSQL backup (`src/server/export/constants.ts:329-342`).

## Proposed tick and transaction contract

The smaller schema alternative is one transaction for the entire sweep plus one tick receipt. It closes the commit/checkpoint gap, but one row failure rolls back all prior progress and all selected sessions remain locked for the sweep. Retaining per-row commits matches the existing behavior and is the recommended choice. The unsafe alternative, fixed cutoff plus current-state checks without frozen selection/receipts, cannot identify earlier committed effects after reopen or distinguish partial completion.

### Fixed identity and immutable selection

For native cron, keep schedule/workflow name `prune_orphan_review_sessions`. Validate the supplied scheduled Date, persist `scheduled_at`, and derive `cutoff = scheduled_at - 6h` once. The native logical tick ID is the native workflow ID above. Disable automatic backfill as for existing prune. Delayed execution and recovery never substitute wall clock time for that input.

Before the first business effect, one transaction freezes a sorted, complete candidate list selected by the original predicate. Each entry stores session ID, precise PostgreSQL `started_at` text, and selected version. Use `started_at::text` and SQL timestamptz comparison so JavaScript millisecond conversion does not lose database precision. The candidate version is evidence, not an optimistic version precondition. Pause/resume alone must remain eligible under the existing age rule.

Commit the tick header and entire candidate list together. An empty list is still an admitted tick. No effects occur before that commit. If admission commit is uncertain, reacquire the same tick lock and look for that header before selecting again. A committed header is never overwritten, expanded, or regenerated. Before the first successful admission there is no committed selection to recover; a rolled-back selection may be redone with the same cutoff.

For the compatible pg-boss drain adapter, use `legacy:<job.id>` as identity and freeze the first admission's database timestamp/cutoff and candidates. Read the actual delivered job ID; do not let the handler ignore its job argument. Store timestamp provenance as `legacy-first-admission`, not `scheduled`. Retries reuse the same header. Historical empty payloads cannot support an invented exact cron timestamp or retroactive exactly-once claim for pre-upgrade attempts.

### Reuse the Review writer under the caller's transaction

Add one domain operation in `src/server/session/review.ts`:

```ts
export type OrphanReviewCandidate = {
  sessionId: string;
  selectedStartedAt: string; // precise PG timestamptz text, validated at the DB boundary
  selectedVersion: number;
};
export type OrphanReviewResult =
  | { kind: 'abandoned'; fromVersion: number; toVersion: number }
  | { kind: 'skipped'; reason: 'missing' | 'terminal' | 'reopened' | 'not-old' };
export async function abandonOrphanReviewSession(
  tx: Tx,
  input: { candidate: OrphanReviewCandidate; cutoff: Date },
): Promise<OrphanReviewResult>;
```

The helper uses private `loadReviewSessionForUpdate(tx, id)` first, extended to return version. Under that lock, require current type review, current status started/paused, SQL equality to `selectedStartedAt`, and strict SQL `started_at < cutoff`. Missing/terminal/new-incarnation/not-old are explicit skips. Then call the existing private `applyReviewSessionTransition(tx, id, 'abandoned', { allowedFrom: ['started','paused'], idempotent: false })`.

This deliberately tolerates its second lock read and nested transaction/savepoint; the outer transaction retains the lock through receipt insertion. It is the smallest change and copies no state update or event-writing code. An extraction into a private locked transition helper is optional only if actual transaction behavior requires it; it must preserve all current callers and completion's feedback-release branch. Do not export arbitrary writer callbacks or expose the private writer to the durable module.

If close wins the row lock, cleanup records terminal skip. If close+reopen wins, changed start time or failure of the fixed-cutoff predicate records reopened/not-old. If cleanup wins, it commits abandon plus receipt first; a subsequent reopen remains open when the same tick replays, even many hours later, because replay returns its receipt before consulting current state. Pause/resume retains the same incarnation and is still eligible. Version equality would defer these live sessions and is not recommended. The start timestamp is the existing incarnation marker; introducing a new generation column or treating resume as a fresh six-hour lease is a separate product change.

### Receipt and partial progress

Use four family-specific tables, with schema-builder writers visible to existing audits:

1. `review_orphan_control`: singleton phase (`pg-boss`, `draining-pg-boss`, `dbos`, `draining-dbos`), phase-change timestamp, and persisted legacy producer `not_before` for rollback cooldown. No reuse of `prune_job_events_control`.
2. `review_orphan_tick`: primary key `tick_id`; immutable backend, timestamp provenance, scheduled/admission timestamp, cutoff, ordered candidates and contract version `1`. Store admission versus fenced/no-effect outcome explicitly. A JSON candidate array is sufficient for the current unbounded sweep; do not add paging/watermarks unless measured size requires a new design.
3. `review_orphan_receipt`: primary key `(tick_id, session_id)`; write-once outcome abandoned/skipped/deferred-known-failure, reason, relevant before/after version and error classification, recorded timestamp. FK to tick; do not cascade-delete evidence when a learning session is removed. Existing transition plus this receipt share one application DB transaction. Job-event IDs/counts are corroborating effect evidence, not the durable deduplication authority.
4. `review_orphan_disposition`: append-only, named task/tick or per-session obligation, backend, observed state, reason and time. A later resolution references prior evidence; never rewrites an earlier unknown/failure to success. Terminal adjudications cannot retire active execution.

Per row, lock in the same order: family phase FOR SHARE, tick header FOR UPDATE, then Review session FOR UPDATE. Recheck phase authorization; return any existing receipt before reading current session state. Only then call the guarded domain operation and insert its receipt. The tick lock serializes duplicate executors, including reconciliation of a transaction whose COMMIT response was lost. Phase changes take UPDATE, so they wait for an in-flight row transaction. Do not hold family or session locks across epoch waits, DBOS checkpoints, or the whole sweep.

Keep one named DBOS step (`review-orphan-sweep-v1`, `retriesAllowed:false`) around admission plus the row loop; its result is a typed aggregate. Per-row application receipts are sufficient to recover the step's partial work; separate per-row DBOS steps are unnecessary. A SIGKILL after row A commits but before the step checkpoint re-enters the same tick, returns A's receipt, and processes only frozen remaining entries. Same-tick counters are sums of immutable receipts, not increments on each replay. Same workflow ID with a different supplied timestamp/cutoff is a hard conflict before any effect.

A transaction with confirmed rollback can record a separate `deferred-known-failure` receipt and continue to the next row, preserving the existing per-row continue/next-cron behavior. That follow-up transaction reacquires the same locks and checks for an existing receipt before insertion, so a concurrent executor cannot have its committed outcome overwritten by a deferred result. Do not classify arbitrary connection exceptions as confirmed rollback. For uncertain COMMIT, reacquire the phase/tick lock on the authoritative writable primary. If the receipt exists, use it; if that lock is acquired after the original transaction resolves and no receipt exists, no transition from this protocol committed, so the same frozen row can safely execute. A plain unlocked read of absence, current session status, or an absent job event is insufficient. If authoritative reconciliation is unavailable, stop the sweep and retain the unresolved obligation; do not record success or a known rollback.

Process-crash recovery retains the exact DBOS workflow ID and original inputs. Queue redelivery retains the exact legacy job ID. A terminal DBOS ERROR remains historical ERROR and blocks migration completion until individually reconciled/adjudicated. Recommended first slice has no operator retry/rewind/fork command: known failures wait for the next daily tick, as today. A new daily tick is fresh work with a new cutoff, not a retry of the old tick. If the parent requires explicit terminal same-tick retries, design a separately recorded attempt linked to the original tick and its frozen receipts; never use a new unlinked workflow ID or overwrite DBOS history. That is a separate decision, not assumed authorization.

Receipt classification and DBOS checkpoint status are separate. All receipt rows may be committed while DBOS is still PENDING/ERROR. A SUCCESS workflow with deferred rows means the sweep finished with deferred work, not that every candidate was abandoned. Outstanding/rollback reports must read both DBOS/pg-boss state and tick/receipt/disposition evidence, including missing receipts; scheduler status alone cannot close an obligation.

## One DBOS host, two explicit families

Move this one schedule declaration from `INFRA_HOUSEKEEPING_SCHEDULES` into `src/capabilities/observability/manifest.ts`, beside its existing prune declaration, with `backend:'dbos'`, queue fast, unchanged cron/timezone. This declares admission to the phase-controlled host, not an immediate runtime cutover. Remove only the unconditional review handler/schedule mount from `handlers.ts`. Its legacy consumer remains mounted by the phase-controlled family adapter until drain/rollback obligations end. Other infra families and the config read contract stay intact.

In `register-capability-jobs.ts`, collect and validate the complete DBOS declaration set before launching anything. Reject duplicates, missing required schedule/queue contracts, and unknown families. Preserve ordinary no-schedule jobs before scheduled jobs. Call the existing host once with both admitted declarations; per-declaration `mountJob` must no longer launch DBOS.

Keep the host in `durable/prune-worker.ts` for this change, avoiding file moves and boot import churn:

```ts
export async function startDurableWorker(options: {
  boss: PgBoss;
  db: Db;
  declarations: { pruneEvents: JobDecl; reviewOrphans: JobDecl };
  reconcileIntervalMs?: number;
}): Promise<void>;
// Keep startPruneWorker(existingOptions) and its workflow return for existing fixtures.
// Keep stopDurableWorker(): Promise<number> and its shutdown caller unchanged.
```

Both public starts use ONE internal lifecycle state. `startPruneWorker` is a prune-only compatibility entry, not another owner. Same boss/db/declaration set returns the original startup promise; a different boss/db or a later attempt to expand the registered set fails explicitly rather than silently returning a prune-only host. Production always supplies the complete pair before launch. The existing fixture can remain prune-only. Register `registerPruneWorkflow` unchanged and the new `registerReviewOrphanWorkflow` before the sole `DBOS.launch`, regardless of their current phases, so pending recovery can always find both names.

Preserve DBOS name/schema/executor/applicationVersion (`prune-v1`), existing prune workflow name, scheduled inputs, `prune-business-commit` step name/order, receipts and boundary hooks. Adding a new named workflow is compatible with that old history; changing the application version would strand automatic recovery unless separately migrated. Do not run older prune-only binaries concurrently once review workflows are admitted under this same app version: they do not know the second workflow. Fixed-binary phase rollback is the supported rollback; old-binary rollback is not proven safe.

New family module split:

```ts
// durable/review-orphan-family.ts
export async function runReviewOrphanTick(db: Db, tick: ReviewOrphanTickInput): Promise<ReviewOrphanSummary>;
export async function readReviewOrphanPhase(db: Pick<Db, 'execute'>): Promise<ReviewOrphanPhase>;
export async function installReviewOrphanProducerFence(db: Db): Promise<void>;
export async function reviewOrphanObligations(db: Pick<Db, 'execute'>, backend: 'pg-boss' | 'dbos'): Promise<ReviewOrphanObligation[]>;
export async function changeReviewOrphanPhase(db: Db, boss: Pick<PgBoss, 'unschedule'>, target: ReviewOrphanPhase, schedules: Pick<typeof DBOS, 'getSchedule' | 'pauseSchedule'>): Promise<void>;
export async function inspectReviewOrphanOutcome(db: Db, input: { tickId: string; sessionId: string }): Promise<ReviewOrphanOutcomeInspection>;
export async function retireFailedReviewOrphan(db: Db, input: ReviewOrphanDispositionInput): Promise<void>;

// durable/review-orphan-worker.ts
export function registerReviewOrphanWorkflow(db: Db, boundary?: ReviewOrphanBoundaryHook): ReviewOrphanWorkflow;
export function createReviewOrphanBackend(options: ReviewOrphanBackendOptions): {
  reconcile(): Promise<void>;
  stop(): Promise<void>;
};
```

Define tick input as a discriminated union: native `{kind:'dbos', workflowId, scheduledAt}` versus legacy `{kind:'pg-boss', jobId}`. Define summary as `complete | completed-with-deferred | fenced`, each with counts derived from receipts; unresolved DB outcome throws with tick identity. `ReviewOrphanWorkflow` has `(scheduledDate: Date, context: unknown) => Promise<ReviewOrphanSummary>`. `ReviewOrphanOutcomeInspection` is `committed` with the saved receipt, `not-committed` after authoritative lock reconciliation, or `unknown`; inspection executes no transition. A terminal-error disposition can use that inspection without replaying the failed workflow. Backend options are `{boss, db, decl, workflow}`; the boundary hook names include `selection-committed`, `row-committed` with session ID, and `checkpoint-saved`. Hooks are no-op by default and test-only observers, not alternate writers.

The host owns all timers and shutdown. Keep the existing prune reconciliation transaction/receipt fence; call the review reconciler under its own family lock and error boundary so one family's failure does not skip the other's reconciliation. Stop scheduling/reconciliation, settle active reconciliation promises, and call DBOS shutdown once with the current timeout. Clear shared lifecycle state only after stop. `start-worker.ts` and `shutdown.ts` need no production edit for this design. Their owner must still confirm the registrar invocation and shutdown contract before a writer starts.

## Cutover, producer fence, and rollback proof

- Install a new family-specific trigger function on `pgboss.job` and `pgboss.schedule`, using a distinct trigger name and advisory-install lock. Check only this family and hold its control row FOR SHARE, rejecting legacy production outside pg-boss and during rollback `not_before`. Preserve existing prune triggers. Retry state updates of an already accepted job must remain allowed. New family business transactions independently check phase; enqueue fencing alone is not consumer fencing.
- Default stays pg-boss. Deploy the compatible binary with the new adapter before cutover. Stop and verify disappearance of every pre-migration worker/app-embedded consumer, including any process already holding a selected-row loop and in-flight DB transaction. An old handler has no family business fence; neither the trigger nor an idle queue snapshot proves it cannot later write. Do not declare mixed old/new consumer execution safe. An inability to identify those owners is a cutover blocker, not a reason to add a trigger to all learning-session writes.
- `pg-boss -> draining-pg-boss`: under control UPDATE, close producer fence and unschedule. Accepted created/retry/active tasks drain through the sole compatible adapter with frozen legacy identities. Inventory family jobs, unexpected DLQ, failed/cancelled rows, tick/receipt gaps, and `__pgboss__send-it` payloads naming this family. Preserve and classify each; do not delete or replay unknown payloads. Stop stale producers/forwarders and prove quiescence before treating their pending writes as absent.
- Only promote to dbos after that drain and zero unknown obligations. Preserve the epoch boot guard and per-delivery legacy `drain` wrapper; call the existing DBOS epoch wait before admission and each row transaction. These are gate checks, not proof of an atomic global maintenance cutover; in-flight transactions must also drain at an epoch maintenance boundary.
- `dbos -> draining-dbos`: pause native schedule and close new business-tick admission under control UPDATE. Already admitted headers continue their frozen rows. Recommended treatment of queued-but-unadmitted or late cached DBOS ticks is an explicit immutable fenced/no-effect tick, then next-cron coverage; this needs the parent decision below. A late enqueue cannot create a business effect after phase exits dbos. Report late fenced tasks instead of claiming the schedule pause synchronously eliminated every scheduler cache.
- `draining-dbos -> pg-boss`: require workflow obligations AND receipt gaps/unknowns resolved or explicitly dispositioned; no active work may be retired. Keep both schedules off and the legacy producer fence closed until at least `max(rollback barrier time, latest native scheduled tick) + 60 seconds`, using database time. Also require all old forwarders/in-flight sends and stored family SEND_IT obligations quiesced/classified. The 60-second source lookback is NOT a bound on a suspended process or stored forwarded task's lifetime. After the barrier, enable legacy scheduling and retain business admission guards. Do not rely solely on recent successful receipts: a zero-effect native tick or failed/unknown tick still occupies its schedule point.
- Keep `scripts/prune-backend.ts` unchanged. Add a family-specific client-only CLI with status/begin/finish/retire operations, no DBOS launch, replay, queue deletion or generic family selector. It must display unknowns and cooldown evidence. Full DB backup/recovery must retain both families' control/tick/receipt/disposition data together with DBOS and pg-boss. Learner archive restore is not execution-state restore.

## Future file ownership, subject to parent reservation

No implementation writer before 1392 merges and collaborator `57961995` coordinates ownership. This list reserves nothing by itself.

| Classification | Exact proposed files | Change |
|---|---|---|
| Family implementation | new `src/server/durable/review-orphan-family.ts`; new `src/server/durable/review-orphan-worker.ts`; new `scripts/review-orphan-backend.ts` | Fixed tick, receipts, independent phase/fence/drain/CLI, workflow and backend adapter. |
| Family adapter | `src/server/boss/handlers/prune_orphan_review_sessions.ts`; its `.test.ts` | Preserve the standalone `runPruneOrphanReviewSessions(db): Promise<{abandoned:number}>` caller contract; make its one sweep use the guarded domain operation. Production phase adapter passes actual legacy IDs into the durable family path. No second DBOS-launching handler. |
| Shared domain, explicit reservation required | `src/server/session/review.ts` | Add only guarded orphan operation and private loader version projection. Preserve public transition contracts and every existing writer. `session/index.ts` namespace export already exposes the new function; no edit needed. |
| Shared registrar/lifecycle, explicit reservation required | `src/server/durable/prune-worker.ts`; `src/server/boss/register-capability-jobs.ts`; `src/server/boss/handlers.ts`; `src/capabilities/observability/manifest.ts` | Collected admission, one host, register-before-launch, relocate one declaration and phase-own legacy mount. `prune-family.ts`, `scripts/prune-backend.ts`, `start-worker.ts`, `shutdown.ts`, config/subject boot and Start pages remain source dependencies, with no planned production edits. |
| Schema/recovery contract | `src/db/schema.ts`; new `drizzle/0116_yuk1393_review_orphan_backend.sql`; `drizzle/meta/_journal.json`; `src/server/export/constants.ts`; `src/server/export/constants.test.ts` | Four tables, constraints/fence function, archive exclusion with full-DB recovery explanation. 0116 is next at this HEAD; parent must reserve/rebase the number before implementation if another lane claims it. Use ordinary generated migration metadata if required by the chosen migration workflow. Never rewrite 0115. |
| Family verification | new `src/server/durable/review-orphan-family.db.test.ts`; new `src/server/session/review-orphan.db.test.ts`; new `tests/dbos-review-orphan/worker.ts`, `migration.db.test.ts`, `cron.db.test.ts` | Actual SQL/concurrent row locks, isolated worker crash/cron and effect evidence. |
| Shared compatibility verification | `src/server/boss/handlers.test.ts`; `src/server/boss/start-worker.test.ts`; new `src/server/durable/prune-worker.unit.test.ts`; `tests/dbos-prune/worker.ts`, `migration.db.test.ts`, `cron.db.test.ts` only if coexistence fixture changes are needed | One-launch/order/failure/shutdown tests and actual existing-prune pending-recovery compatibility. Do not rewrite historical evidence artifacts. |
| Delivery documentation | `src/server/boss/handlers/AGENTS.md`; `docs/planning/2026-10-09-yuk1393-review-orphan-dbos.md` | Update only this family's registration/evidence/ownership facts. Parent owns delivery board, Linear and eventual runbook/evidence record. No repeated whole-family inventory is needed. |

Schema/audit or test-reset support files beyond this set are not pre-authorized write scope. If concrete integration checks require one, report the exact dependency and coordinate it before extending ownership. New execution tables must not be hidden with blanket audit exemptions.

## Scoped future acceptance, not executed here

Use disposable synthetic DBs and isolated, exact-built worker processes. Preserve existing fixture safety checks and record source/bundle hashes, Node executable/version, installed package versions, timezone, workflow/job/tick IDs, raw inputs, receipts, state/version changes and observer event counts. Existing fixtures illustrate real process boundaries and actual scheduler forwarding (`tests/dbos-prune/worker.ts:11-17,37-67,82-103`; `cron.db.test.ts:386-465`). Their historical success is not acceptance for this new code.

1. Domain/SQL: strict six-hour boundary, old started/paused, fresh and other types; completion/abandon wins the lock; reopen between selection and lock; reopen after committed receipt; pause/resume without age reset; deleted row and microsecond start timestamp. Assert each abandoned row has version +1 and exactly one `review.abandoned` event; skips have zero cleanup effects. Count user close/reopen events separately.
2. Partial commit: freeze A/B/C; kill before selection commit, after selection commit, after A's transition but before outer receipt commit, after A+receipt COMMIT before DBOS checkpoint, and after final checkpoint. Restart two compatible workers. Uncommitted A rolls back; committed A is not repeated; B/C settle from the original list. Add a newly aged row D and a backdated inserted row after admission: same-tick recovery must not select either. Reopen A before replay and verify it remains started with only the expected user version/event changes.
3. Database outcome: sever the commit response with actual database/proxy fault injection after server commit and separately before rollback. Receipt plus lock determines committed/absent; unavailable primary stays unknown and blocks rollback. Do not simulate this only by throwing before a write. A confirmed row failure can defer that row and continue B/C; its next daily eligibility and historical failure evidence remain distinct. Verify terminal DBOS ERROR is not falsely reported as retried by resume.
4. Identity/ownership: duplicate native tick and concurrent executors produce one candidate header and at most one cleanup receipt/effect per session; mismatched tick timestamp rejects. Legacy redelivery reuses its original ID/cutoff. Two overlapping different ticks may both select a row, but row-lock recheck yields one abandon and one terminal skip. Both families registered before one launch; wrong/late declaration sets fail; stopping one host calls shutdown once. Recover an old `prune-v1` pending workflow from the old bundle with the new bundle and assert unchanged delete/receipt/checkpoint counts, both before and after native review admission.
5. Actual cron: observe real pg-boss Timekeeper/SEND_IT forwarding and real DBOS dynamic-scheduler execution, including two schedulers, next tick, timezone mapping and restart. A one-minute test schedule can measure forwarding; verify the production 04:15 Asia/Shanghai expression maps to 20:15Z on the previous UTC date separately. Observe actual business effects/receipts/IDs at each tick. Schedule rows, scheduler registration counts or fabricated `startWorkflow` calls cannot satisfy this cron gate.
6. Fence/drain/rollback: hold actual legacy forwarding before INSERT, cross the phase barrier and prove rejected insertion plus zero effect; test active/retry/failed/unexpected-DLQ/unknown obligations. Explicitly hold an old selected-row consumer to demonstrate why cutover remains blocked until it terminates. Include late native scheduler enqueue, empty native tick, partial receipt, and rollback inside the 60-second window. Hold a forwarder longer than 60 seconds and prove rollback remains blocked on quiescence, rather than assuming elapsed time invalidates its empty payload. After safe rollback, observe an actual next pg-boss tick and effect count. Existing prune must keep working throughout the independent family phase transitions.

Run only the future authorized scoped unit/DB/migration checks and required static/build gates. No full local test suite. Parent acceptance must distinguish source design, scoped tests, exact-head CI, process/cron evidence, and deployed runtime; none is implied by this document.

## Integration sequence and decisions

1. Parent confirms 1392 merge and reserves the shared files with `57961995`, including the narrow Review helper. Choose the two behavior decisions below before code.
2. Implement additive schema, Review helper, frozen tick/receipt family and scoped SQL tests in one owned writer lane. Keep defaults pg-boss and preserve every live caller.
3. Integrate the collected registrar and single host, then move the declaration/legacy mount together. Preserve the old prune wrapper and workflow history. Verify existing prune recovery and the config schedule row before considering review-family cutover.
4. Run isolated crash/concurrency/actual-cron/migration/rollback gates. Parent completes normal independent review/CI and delivery ownership; this consultation authorizes none of those operations.
5. Only after runtime old-consumer/forwarder quiescence and obligation classification may the parent change phase. Retain the compatible legacy drain/rollback consumer until the rollback horizon and obligations are explicitly retired. Do not delete it merely because the primary scheduler switched.

Consequential choices requiring parent/owner resolution:

- Recommended: confirmed row failures remain deferred to the next daily cron, while uncertain DB outcomes remain held until authoritative reconciliation. This preserves today's failure backstop while making its evidence honest. Requiring automatic/explicit same-tick retries of terminal DBOS ERROR is a larger recovery feature and needs a separate immutable attempt design; it is not silently included.
- Recommended: entering draining-dbos admits no new business candidate lists. Already admitted ticks finish; queued/unadmitted and late cached ticks receive explicit fenced/no-effect outcomes and rely on the next cron. If the owner instead requires every pre-barrier queued tick to execute, freeze an allowlist of those workflow IDs at the phase barrier and drain exactly that list. Do not allow arbitrary late scheduler ticks throughout draining.

The non-negotiable safety prerequisites are precise file ownership, preserving existing prune replay compatibility, and verified removal of pre-migration consumers. They are not optional behavior preferences. This proposal does not establish whole-migration completion or authorize an implementation writer.


## Implementation candidate and acceptance handoff

Sole implementation writer, starting `c0870b0eb0b741dcdf7b5ff5a29e818af72d71e1` on `feat/yuk-1393-review-orphan-dbos`. Parent owns PR, independent review, CI, Linear, runtime and deployment. No DB, migration smoke, Testcontainers, Docker, worker/process fixture, provider or replay execution occurred during authoring. Default remains pg-boss. The proposal above is historical design input; runtime claims remain pending.

Implemented the complete live family path: observability manifest owns the unchanged `15 4 * * *` / `Asia/Shanghai` declaration, the central infra registrar no longer mounts it, and collected capability admission calls one shared host with both families. The legacy handler passes each actual delivered UUID. The original standalone count-returning caller remains and uses the guarded Review operation.

The parent's locked drain decision applies to both backends: only an already admitted header may finish during its draining phase. A created/active delivery without a saved admission receives an immutable `fenced` result with no candidate list or effect, including legacy deliveries during `draining-pg-boss`. Redelivery cannot turn that frozen result into a later admission. The compatible legacy adapter stays mounted to settle those deliveries and finish admitted work; the next daily tick covers eligible sessions after the phase changes. This supersedes the historical proposal's broader legacy admission during drain.

`abandonOrphanReviewSession(tx, {candidate, cutoff})` checks the precise selected PostgreSQL start timestamp and strict age under the row lock, then calls the existing private transition/event writer. Selected version remains evidence; pause/resume does not exclude the incarnation. `runReviewOrphanTick(db, input, boundary?)` admits the complete sorted list atomically, uses phase/tick/session lock order per row, and commits each transition plus immutable receipt. Saved receipts precede state reads. Reconciliation waits for the same authoritative lock; proven rollback gets a deferred receipt and proceeds to the daily backstop. Unavailable reconciliation throws `ReviewOrphanUnknownOutcome` and leaves task/gap obligations held. Native input timestamp conflicts throw `ReviewOrphanIdentityConflict` before effects.

The installed SDK `ScheduledWorkflowFn` requires `Promise<void>`, so the workflow wrapper returns void. Its named `review-orphan-sweep-v1` step persists the typed `complete | completed-with-deferred | fenced` summary. No cast hides an incompatible scheduler signature. Legacy per-delivery and per-row epoch checks preserve the existing drain behavior at an older active epoch; native admission/rows retain `waitForRunnableEpoch`. Maintenance still requires an operational transaction drain; these checks are not an atomic global cutover.

Four additive tables and producer/immutability functions are in `0116_yuk1393_review_orphan_backend.sql`. Journal 0115 and the existing prune family/CLI are unchanged. Full PostgreSQL recovery must retain these four tables with the existing prune ledgers, pg-boss and DBOS. Learner archives exclude execution state and retain schema version 4.25.

The host keeps prune application/executor/schema/version/name/inputs/step/hooks unchanged, registers both names before launch and shuts down once. Its original prune-only start remains for the existing fixtures. Changing the boss, DB or admitted declaration set after startup rejects. Each reconciler has its own error boundary; a prune error does not starve review reconciliation. The current `start-worker.ts` and `shutdown.ts` remain unchanged consumers.

Phase controls and client-only CLI are family-specific. `changeReviewOrphanPhase`, `reviewOrphanObligations`, `inspectReviewOrphanOutcome`, `retireFailedReviewOrphan`, `attestReviewOrphanQuiescence` and `reviewOrphanRollbackHorizon` provide the operator contract. Unreceipted candidates, non-success native tasks, legacy active/retry/failure, unexpected DLQ and unclassified SEND_IT payloads block drain. Dispositions apply only to observed terminal tasks, rechecked under authoritative locks. Resolve named frozen row gaps before disposing their parent terminal task. No resume/replay/fork or queue-deletion command is exposed. A recorded quiescence statement must cite externally verified old-process and legacy/native in-flight producer evidence at that exact barrier. It is an operator assertion, not automated process discovery. Rollback also waits until max of the barrier and latest native scheduled point plus 60 seconds, including empty/fenced/failed ticks and pending native schedule IDs.

Additional approved write scope is the exact `src/server/durable/prune-worker.unit.test.ts` entry in `vitest.shared.ts` and `with: fetch-depth: 0` on only the DB execution job's checkout in `.github/workflows/ci-gate.yml`, each authorized by the parent after checking 77 worktrees (75 accessible, 2 historical trees inaccessible). No glob, baseline, exemption, gate, condition, matrix, timeout, test selection or permission was changed. Parent delivery board and other YUK-1359 documents remain untouched.

### Prepared real acceptance commands, not author-run results

Use Node 24.19.0 with `PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH`. Parent must acquire the runtime/deployment lock and inventory/limit its disposable resources before running any commands below. The repository DB config creates a single pgvector/pg16 test container with a 2 GiB tmpfs and durability enabled, then four isolated `test_fork_N` clones. These scoped commands use `--maxWorkers=1 --no-file-parallelism`; no full local suite. New process fixtures additionally require a loopback `TEST_DATABASE_URL` and a `test_fork_N` database, never fall back to default `DATABASE_URL`, pass only explicit child env, and pin external module resolution to this tree's node_modules. Application/proxy URLs must name that same fork. Child application and boss pools cap at 2 each; DBOS caps at 3, its fixture client at 1; observer pool caps at 3. Migration fixture uses at most two compatible worker children simultaneously after a killed predecessor, plus a loopback TCP proxy when specified. Cron uses at most two scheduler children. No shared worker ports or service containers are started by a fixture.

```sh
pnpm vitest run --config vitest.db.config.ts --maxWorkers=1 --no-file-parallelism src/server/session/review-orphan.db.test.ts src/server/durable/review-orphan-family.db.test.ts src/server/boss/handlers/prune_orphan_review_sessions.test.ts src/server/boss/handlers.test.ts
TLP_REVIEW_EVIDENCE_PATH=/tmp/yuk1393-parent-migration.json pnpm vitest run --config vitest.db.config.ts --maxWorkers=1 --no-file-parallelism tests/dbos-review-orphan/migration.db.test.ts
TLP_REVIEW_CRON_EVIDENCE_PATH=/tmp/yuk1393-parent-cron.json pnpm vitest run --config vitest.db.config.ts --maxWorkers=1 --no-file-parallelism tests/dbos-review-orphan/cron.db.test.ts
pnpm vitest run --config vitest.db.config.ts --maxWorkers=1 --no-file-parallelism tests/dbos-prune/migration.db.test.ts tests/dbos-prune/cron.db.test.ts
pnpm vitest run --config vitest.migration.config.ts tests/integration/migration-smoke.test.ts
```

Parent may set `TLP_REVIEW_OLD_PRUNE_ARTIFACT`, `TLP_REVIEW_OLD_PRUNE_MANIFEST` and `TLP_REVIEW_OLD_PRUNE_SHA256` for its independently verified archived bundle. Without an override, the test archives exact base `6aaf8ca89eaf5feb5af5c00b7c5b3bd90cd953ea`, checks the lock, links pinned node_modules and builds the old worker locally. It never rebuilds the old fixture against the new prune implementation. The supplied path is not hardcoded in source/CI. Production candidate and fixture bundle hashes must be captured with runtime results; fixture builds always use this candidate's shared host/domain implementation. Existing prune tests are regression gates, not a substitute for the genuine archived old-to-new check.

The prepared fixture boundaries are admission before COMMIT, selection committed, transition before receipt COMMIT, row committed before checkpoint, and final checkpoint. Two compatible executors recover the original list; replay after reopen and a later backdated insertion cannot expand/repeat it. The TCP fault fixture recognizes actual PostgreSQL COMMIT frames and drops either the frontend COMMIT or its server CommandComplete response; unavailable primary reconciliation is held as unknown and terminal DBOS ERROR is not resumed. The archived old review actor demonstrates an old selected loop can still commit during a closed family phase, which establishes the mandatory quiescence prerequisite. Actual cron tests observe Timekeeper forwarding, a suspended forwarder beyond 60 seconds, native two-scheduler ticks, an empty tick, restart and the next pg-boss rollback effect. They do not fabricate scheduler ticks to claim cron acceptance.

Outstanding gates: all prepared DB, SQL migration, process crash/fault, actual cron, backup/restore, old-binary recovery, real quiescence and deployed-runtime acceptance. Source/unit/static/build results below cover only their named layers. Parent must repair fixture/runtime failures before claiming those gates. YUK-1246 paused-age product semantics and the whole YUK-1359 migration remain separate parent obligations. No new Linear action was performed by this child; the parent retains the capture gate and issue status.

The genuine archived fixtures require fixed base `6aaf8ca89`; the DB selector's full history is not inherited by execution shards. The authorized DB execution checkout now supplies full history. A source check parses YAML and compares all workflow semantics to the starting revision, allowing only that checkout option. The fixture fails before opening a pool/worker if the old commit is unavailable; it never substitutes current source. Parent owns exact-head CI execution.

### Author verification and evidence

All author commands use Node 24.19.0 and pnpm 11.13.1. All completed author verification rows below exited 0; the real acceptance row was not executed. The evidence directory is `/tmp/yuk1393-evidence`; `manifest.json` records the committed revision, complete owned file list and SHA-256 hashes, protected source comparisons, artifacts, commands/exits and every retained check log, including intermediate failures. `api-signatures.md` records the final signatures and typed outcome/error contract. Successful source checks are not DB/process acceptance.

| Layer | Authorized command / scope | Result |
| --- | --- | --- |
| Official unit partition | `pnpm vitest run --config vitest.unit.config.ts src/server/durable/prune-worker.unit.test.ts src/server/export/constants.test.ts src/server/boss/start-worker.test.ts` | 49 tests in 3 files; lifecycle/order/ownership/failure isolation and registrar admission, export classification and existing shutdown consumer |
| Types | `pnpm typecheck` | Both repository and Start TypeScript projects |
| Lint | `pnpm lint`; `pnpm lint:ratchet` | No errors; 290 existing warnings within baseline 305; no baseline increase or exception |
| Build | `pnpm build` | Web, Start, server, worker and migrate bundles |
| Post-build audits | `pnpm audit:schema`, `audit:partition`, `audit:capability-boundaries`, `audit:task-census`, `audit:provider-lanes`, `audit:architecture-deepening`, `audit:provider-attempt-truth` | No P0 or new debt/exemption; partition retains six existing P1 warnings |
| Fixture source/build | Esbuild candidate worker and exact archived old actor; workflow YAML/source comparison; protected source checks | Offline preparation only; no worker or fixture executed |
| Real acceptance | Scoped commands above, migration SQL, SIGKILL/COMMIT faults, actual cron, archived pending recovery, backup/restore and deployment | **Not run by author; parent gate remains open** |

The final production change tightened legacy admission during drain; the source checks, build and post-build audits were rerun after it. The prepared DB tests cover that correction as well as native drain admission. The immutable migration, real PostgreSQL locking, packet fault fixture and actual scheduler timing still require the parent runs above. The existing `registerPruneWorkflow` implementation and protected boot/shutdown/prune/lock/migration sources are byte-checked against the starting revision. No new runtime result is asserted by a build.
