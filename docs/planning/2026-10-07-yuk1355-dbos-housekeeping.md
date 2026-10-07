# YUK-1355 DBOS housekeeping migration

This lane implements the non-UI portion authorized on 2026-10-07. Base is `a6d89037b`; its isolated writer is `tlp-yuk1355-dbos-migration`. It does not migrate a business/AI family, change pages, operate the main runtime, or establish deployment/merge acceptance. Parent owns independent review, exact-head CI and final acceptance. YUK-1363/1364 remain in their own threads.

## Implementation and ownership

`observability/manifest.ts` declares the admitted `prune_job_events` job with `backend: 'dbos'`. This is an admission declaration, not a second configuration store. The database singleton `prune_job_events_control.phase` owns the actual phase. Existing declarations default to pg-boss. An undeclared DBOS recovery implementation fails registration; there is no generic callback workflow registry.

`register-capability-jobs.ts` mounts the admitted family into the existing worker lifecycle. Both independent and in-process workers use that registrar. `prune-worker.ts` owns DBOS launch, native schedule reconciliation, stable `prune-v1` workflow registration and shutdown. Same-process repeated registration reuses one startup promise. Each process can have only one DBOS owner. DBOS uses the same PostgreSQL database, separate SDK-owned `tlp_dbos` schema, three connections, and explicitly disabled OTLP. Existing pg-boss business handlers remain registered.

The app tables added in migration 0115 are a single phase row, workflow receipts and explicit failure dispositions. They have no learner facts. They accompany pg-boss and DBOS system tables in full PostgreSQL backups. Learner JSON archives exclude all three because restoring a recovery owner without its workflow history is unsafe. No table or queue is dropped by the cutover commands.

The installed DBOS 5.2.11 SDK has optional Winston imports in its OTLP logger branch. The server/worker build commands externalize only `winston` and `winston-transport`; DBOS itself is bundled. No dependency or lockfile changes were made. Enabling DBOS OTLP requires a separately reviewed dependency/configuration change. Source/build tests do not establish that configuration.

## Single-family transition protocol

| Database phase | Producer / cron | Recovery owner |
| --- | --- | --- |
| `pg-boss` | pg-boss cron, `0 4 * * *`, `Asia/Shanghai` | pg-boss, including existing retries |
| `draining-pg-boss` | Both crons disabled; pg-boss inserts fenced | Existing pg-boss tasks only |
| `dbos` | Native DBOS cron with the same time/zone and backfill disabled | DBOS only; legacy handler unmounted |
| `draining-dbos` | Both crons disabled; pg-boss inserts fenced | Existing DBOS workflows only |

For this sole cron producer, the transition deliberately pauses new ticks while the old mechanism drains. It does not transfer an existing task to another recovery mechanism. A missed housekeeping tick is safe under its existing “next cron reruns” contract. The producer can switch only after that drain. This narrower protocol avoids having two mechanisms recover or produce overlapping prune obligations.

The PostgreSQL control lock serializes transitions, business commits and schedule reconciliation. Producer triggers on `pgboss.job` and `pgboss.schedule` reject stale old-worker inserts when the phase is not pg-boss. Those triggers are installed transactionally after pg-boss creates its schema; a separate advisory lock serializes worker boots. Cached pg-boss cron sends also meet this database fence. Unknown phase or a missing control row fails closed. The worker never recreates an ownership row.

DBOS obtains a fixed cutoff from the scheduled timestamp. Its step runs the existing `runPruneJobEvents` operation and stores the workflow ID, cutoff and delete count in the same application transaction. A crash after commit but before checkpoint reads the receipt instead of deleting again. A reused ID with another cutoff fails. Restart after a saved checkpoint skips the business step. The epoch guard is retained before either backend executes the operation.

Housekeeping has no page or Pi entry and no provider call. It has one shared business delete operation. This lane makes no claim that review-answer page/Pi/background entrypoints are integrated.

## Commands and rollback

Commands require an explicitly selected database and a worker running this revision. Do not aim them at the main environment under the current TEST ONLY instruction. On an authorized restored/synthetic database, use:

```sh
pnpm exec tsx scripts/prune-backend.ts status
pnpm exec tsx scripts/prune-backend.ts begin-dbos
pnpm exec tsx scripts/prune-backend.ts status
pnpm exec tsx scripts/prune-backend.ts finish-dbos
```

`begin-dbos` disables schedules and enters `draining-pg-boss`. Created/retry/active tasks keep their pg-boss identity and budget. `finish-dbos` refuses any unresolved main-queue or unexpected prune-DLQ row. Failed/cancelled main-queue ticks can be retired individually with a written reason after inspecting the exact task:

```sh
pnpm exec tsx scripts/prune-backend.ts retire pg-boss TASK_ID 'inspection and reason'
```

This records a disposition; it does not replay, cancel or delete a task. It refuses another family, live tasks and an unexpected prune DLQ. A DLQ containing an unknown obligation remains blocked for manual investigation. Other queues, provider attempts and unknown external results are outside this tool's authority.

Rollback uses:

```sh
pnpm exec tsx scripts/prune-backend.ts begin-rollback
pnpm exec tsx scripts/prune-backend.ts status
pnpm exec tsx scripts/prune-backend.ts finish-rollback
```

The DBOS schedule is paused before phase changes. Already started DBOS workflows complete/recover under DBOS. Pending/enqueued/error/cancelled/retries-exceeded workflows block `finish-rollback` until completed or individually adjudicated. A terminal, inspected prune workflow can be recorded with `retire dbos TASK_ID REASON`. Pending workflows cannot be retired. There is no generic retry command.

The command uses DBOSClient for schedule control, not DBOS.launch, and cannot recover workflows itself. Worker reconciliation converges within its 15-second poll. A crash between phase commit and reconciliation leaves both producer fences intact; restart reads the persisted phase. It may briefly delay production but cannot authorize the old backend. Graceful DBOS shutdown is charged against the existing 30-second worker drain budget.

Returning the **phase** to pg-boss is the supported execution rollback. Do not roll the binary back to a pre-0115 worker while phase is DBOS/draining or while DBOS has obligations. Full data recovery must restore application, pg-boss and `tlp_dbos` together with all writers stopped. No runtime backup or private-data restore was attempted in this lane.

Real cron testing found that an immediate phase rollback could rerun the DBOS tick: pg-boss considers the preceding cron point eligible for 60 seconds. The worker now delays pg-boss schedule restoration until that window has passed after the latest committed DBOS tick, derived from its existing receipt cutoff. The current legacy consumer also skips a late cached forward during this window. Phase rollback can therefore complete before schedule restoration. This preserves the existing next-cron housekeeping contract and does not clear queued tasks. See the [cron evidence supplement](2026-10-07-yuk1355-prune-cron-evidence.md).

## Task ledger and remaining migration order

The adjacent [inventory JSON](2026-10-07-yuk1355-task-inventory.json) contains all 68 registered application queues from the seven job-contributing manifests, infrastructure schedules, memory registration, orchestration and subscription dispatch. It lists cron/timezone, dependencies, queue tier, retry/DLQ policy, handler import and direct producer sites. `queue-names.ts`'s `COPILOT_NUDGE_EVALUATE_QUEUE` resolves to its actual manifest owner. Fifteen variable-based dispatch sites are listed separately. These are source facts, not a live queue/DLQ census. A direct-site list is not a claim that every dynamically selected producer is resolved.

Regenerate the ledger without application imports or database access:

```sh
pnpm exec tsx scripts/task-migration-inventory.ts
pnpm exec biome format --write docs/planning/2026-10-07-yuk1355-task-inventory.json
```

The following owner rules remain in force while those families are still pg-boss. Their queue retry/DLQ policy stays unchanged; this lane does not admit their model steps into DBOS.

| Families | Producer / durable identity / recovery owner | Required next migration boundary |
| --- | --- | --- |
| `judge_run`, `rejudge`, `judge_pending_reconcile` | Native assessment dispatch, immutable pending intent/run ID and deterministic queue UUID; `assessment/durable-attempt.ts`, `judge-run-dispatch.ts` and the existing judge reconciler | YUK-1356 operation integration plus YUK-1355 dispatch ownership. Reuse `executeNativeAttempt` and formal commit. Preserve provider-attempt/unknown-result evidence, admission and diagnostic claims; do not add another sweeper. |
| `attribution_followup`, `variant_gen`, `variant_verify` | Per-attempt failure-learning facade, stable handoff IDs in `failure-learning-jobs.ts`, accept-proposal verification | Preserve attempt/version eligibility, attribution-to-variant handoff and irreversible provider-start evidence. |
| `note_generate`, `note_verify`, `note_refine`, `hub_sync_mutation_wake`, `hub_sync_recovery`, `hub_auto_sync_nightly` | Artifact intents/receipts and deterministic dispatch in `notes/server/note-handoff.ts`; `hub_sync_recovery` is the only recovery floor | Split saved generation, verification and business commit. Expired pre-wire claims may be redelivered by the existing owner; provider-start ambiguity must remain held, not replayed by DBOS. |
| `copilot_run`, `copilot_run_reconcile`, `copilot_nudge_evaluate` | Session-head dispatch, durable run/claim/outcome marker; nudge source event identity; copilot's existing two-minute reconcile | Preserve session ordering and outcome receipts. Uncheckpointed started runs remain ambiguous under the existing evidence windows. DBOS cannot interpret queue death as proof that no provider/tool ran. |
| `ingestion_operation`, `tencent_ocr_extract`, `auto_enroll` | Ingestion operation/session producer and capture in `ingestion/api/operations.ts`, `server/session/ingestion.ts`, `docx-ingestion.ts`; operation owner then downstream deterministic enroll | Separate captured input, OCR/provider attempt, stored result and enrollment. External OCR/blob outcomes require explicit reconciliation before replay. |
| `memory_event_ingest`, `memory_brief_regen`, `memory_brief_sweep`, `memory_ingest_outbox_poll`, `memory_ingest_outbox_recover`, `memory_reconcile` | Transactional memory outbox, event/scope identity; reconcile handoff uses `memoryReconcileJobId(sourceId, intentDigest)` with dispatch receipt and recovery cursor. `triggers.ts` owns minute/hour floors; reconcile recovery shares the hourly floor | Preserve ADR-0052 handoff, mode/retention rules, UTC outbox cadence, Mem0 side-effect identity and unknown external results. Do not create a second poller/recovery owner. |
| `prepare_intervention`, `intervention_prepare_recovery` | Intervention ID/version/idempotency key and existing preparation job identity; `agency/server/intervention/{prepare,reconcile}.ts` | Preserve preparation/diagnostic reservations, stale versions and recovery claims; retain domain ownership. |
| `supply_execute`, `supply_planner`, `quiz_gen`, `quiz_verify`, `source_verify`, `question_supply_nightly` | Kernel supply dispatch and sourcing sequence, fixed plans/claims, question verification intents; `verify_dispatch_recover` only repairs verify dispatch | Preserve placement claims, candidate provenance, budget and unknown provider windows. No generator replay when only verification is missing. |
| DAG members, `nightly_orchestrator` | Single nightly run/node ledger; members' `dependsOn` edges; orchestrator ticks and queue-state adapter | Migrate the graph and its queue observation atomically or add an explicitly tested per-node backend adapter. A member must never also acquire its own cron. Preserve hard/soft edge behavior. |
| Remaining fast sweeps, `event_subscription_dispatch`, session prunes | Existing database projections/session transitions; subscriptions retain durable per-delivery lease and checkpoint | Migrate one operation at a time after deterministic-equivalence tests. A queue name alone is not an idempotency proof. |
| Remaining LLM/agent periodic jobs, including coach, dreaming, research, knowledge, embedding/calibration/reference-answer jobs | Manifest cron or DAG producer, task-specific business commit and existing queue owner | Record each actual provider/tool boundary, effect identity, cancellation and unknown-result policy before backend admission. The ledger does not infer exactly-once execution from repeatable scans. |

YUK-1358 owns the remaining non-UI waves; YUK-1359 owns removal after every family is migrated. Linear duplicate search on 2026-10-07 found those existing issues and YUK-1356, so no duplicate migration/follow-up ticket was created. The parent maintains those issue states. YUK-1355 remains In Progress pending its parent acceptance, not Done by this sub-agent.

## YUK-1356 dispatch contract

The type-only port lives at `src/capabilities/practice/server/assessment/native-attempt-dispatch-port.ts`. Import `NativeAttemptDispatchPort` and `NativeAttemptDispatchOptions` from that file. The default function remains `dispatchNativeAttempt` in `assessment/durable-attempt.ts`.

```ts
const dispatch: NativeAttemptDispatchPort = dispatchNativeAttempt;
const runId = await dispatch(database, questionId, request, {
  enabled,
  capture,
  userRating,
  requireUnassistedModelEvidence,
});
```

Types derive from the existing function. `request` is its `SaveSubmissionRequest`; `capture` is its `FormalAttemptCapture`. The port returns `Promise<string | null>`. `null` chooses the operation's synchronous formal commit. A run ID represents durable acceptance, including a saved intent whose post-commit delivery failed; the caller must not make a second synchronous submission. Errors before durable acceptance remain errors. The existing fifth `JudgeRunEnqueueDeps` argument is a queue/budget injection seam owned by this lane, not part of the operation port.

Current `judge_run` recovery remains pg-boss. The port does not claim that judge DBOS migration is finished. No changes were made to `review-operation.ts`, `api/submit.ts`, practice/public, due-list, the Pi submit tool/allowlist, or `judge_run.ts`'s diagnostic release-helper import. YUK-1356 owns those hunks. `solve_tutor` retains its own domain operation and shared bottom-level formal commit.

## Verification and limits

The committed process-evidence JSON records the synthetic task IDs, killed/recovered PIDs, SIGKILL, DBOS recovery attempts/checkpoints, final success and source/bundle hashes. The process tests use real PostgreSQL and actual bundled CJS worker processes with DBOS 5.2.11. They test concurrent same-process registration, two worker schedule ownership, legacy retry drain, explicit failed-task retirement, unknown queue/DLQ preservation, rollback blocked by pending workflows, and competing recovery after both business-commit and checkpoint boundaries. A late old event survives recovery, proving the delete did not execute again.

Local checks on the final source:

- Scoped DB: **69 passed**, six files, including the three bundled-process scenarios, registrar, actual boot/shutdown and admin schedule projection.
- Scoped unit: **48 passed**, three files for start-worker, config projection and epoch rules.
- Scoped migration: **26 passed, 56 skipped** in `migration-smoke.test.ts`, selected fresh/repeated journal and migration bundle cases. This is not the full migration suite.
- `pnpm typecheck`, `pnpm lint`, `pnpm lint:ratchet`, `pnpm build`: passed. Lint retains the existing **297 warnings**, no errors; ratchet ceiling is 305 and was not changed.
- Schema audit: zero unallowed stubs. Capability audit: zero deep cross-capability imports, debt still 437. Partition, task census, provider lanes and provider-attempt truth passed. No audit baseline/allowlist was raised.

Process evidence: [committed JSON](2026-10-07-yuk1355-prune-process-evidence.json). All listed source and bundled-fixture hashes were rechecked before copying it into this tree. Scratch command logs are `/tmp/yuk1355-{db,unit,migration,typecheck,lint,ratchet,build,schema,partition,boundaries,census,provider-lanes,provider-truth}.log`. Migration smoke includes fresh/repeated application of the journal containing 0115. These are isolated synthetic/offline checks. No paid provider, production/private database, runtime deployment, browser flow, independent review, exact-head CI, push, PR or merge is claimed.

The original `doubleSchedule: false` field was a constant attached to schedule-table projection checks, not a cron observation. It has been renamed to `scheduleRegistrationProjectionChecked` with `cronTickExecutionObserved: false`; that historical artifact's hashes and earlier gate counts remain historical. Actual cron execution, phase, task identity, receipts, and the rollback defect's RED/fix evidence are recorded in the supplement above. Earlier independent review does not cover the supplement's subsequent P1 fix.

Compatibility exit: YUK-1355 removes the legacy prune handler/producer path, phase transitions, disposition tooling and producer fence after parent-verified DBOS operation, no unresolved legacy obligations and an explicitly closed rollback horizon. Retain DBOS workflow receipts until their matching workflows cannot be recovered/forked. YUK-1359 removes pg-boss dependency/schema only after all remaining family owners, backups and restore proof meet their gates. The current dual stack is a transition with named cleanup owners, not a permanent second scheduler.
