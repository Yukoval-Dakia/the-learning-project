# YUK-973 — retire the three structural dual writers

## Required end state

Goal, LearningItem and MistakeVariant business operations record their canonical events and
materialize through one projection writer. They must not choose between imperative and projected
structural writes using deployment flags. Preserve transaction ownership, monotonic transition
times, approval/retract semantics, append-only history and guarded null projection behavior.
LearningItem's child IDs, AI score and review scheduling remain separately owned derived fields.
ItemCalibration's Scheme A is outside this cutover.

## Migration prerequisite (implemented first)

The existing `scripts/migrate.ts` calls `migrateCanonicalProjections` after schema and seed work.
One transaction locks event/index and the three entity tables, with a 5-second lock timeout.
It reuses the existing per-entity base classifiers and genesis backfills, rejecting unanchored
eventful rows before a snapshot could mask history. Per-kind value and symmetric row-set audits
have no allowlist. A malformed base, drift or potential resurrection aborts all new anchors.
No live entity rows are rebuilt or deleted, and genesis events opt out of the memory outbox.

The migration must run with application writers stopped. An active writer causes a bounded
failure; repair the cause and retry, rather than bypassing readiness. Existing startup dependencies
run migrate before app/worker. Direct boot paths must be checked again when retiring the writers.

Local evidence: 51 scoped DB cases pass, including hierarchy/long content/derived state, idempotency, orphan
mutations, indexed-but-baseless history, structural drift, event-only ghosts and concurrent migration.
The built migration bundle ran twice on retained restore DB `loom_refactor_verify_sjuacu`, with
zero new anchors, seven LearningItems clean, and empty Goal/MistakeVariant tables. The empty kinds
are not populated production canaries; rich DB fixtures cover them. No live or model calls occurred.
Initial review identified dangling index-only origins that null/null parity missed. Three entity
regressions were RED before the fix and GREEN afterward; missing/mismatched origin references and
unreconstructible indexed histories now fail. The existing real Goal proposal→accept→retract DB
case passes readiness with its retained proposal/index/dormant row. Typecheck, lint, build and
capability/architecture audits pass; the fixed bundle also passed the restore-clone rehearsal.
Final entrypoint verification caught the CLI module's eager `.env` load weakening the old
explicit-DATABASE_URL requirement. Baseline/changed/fixed bundle probes proved the regression
and repair; the import is now deferred until after the explicit target has been bound. A real
bundle-and-child-process unit test with a hostile local `.env` protects that target gate.

## Remaining implementation and acceptance

Delete the actual Goal/LI/variant alternate branches, their env/compose selections and runtime
plumbing. Merge OFF/ON duplicate tests into single-path public behavior tests, retaining migration,
permission, failure, concurrency, null-guard and derived-field contracts. Check all direct startup
and legacy import consumers so unprepared data cannot silently succeed without materialization.
Then require scoped DB gates, typecheck/lint/build, independent review and exact-head CI before
Mac-local rollout. Rollback after physical retirement uses the previous release, not a second
runtime writer implementation. NAS remains outside owner authorization. YUK-973 stays open until
the branches and configuration are actually retired and verified; this prerequisite alone is not completion.

## Runtime retirement implementation

Migration prerequisite PR #1355 merged as `9607310839b8e02d9b8d17ab9e3b3279fdf24535`;
final `6d476fc9` passed CI `34112766637`. The separate retirement branch now removes the
three alternate writers, their environment/compose selections and legacy inline anchoring.
The raw Goal fixture insertion API had no production consumer and now lives only in tests.

Learning-item attribution runs before live merge acceptance and also serves repair based only
on `knowledge.merged_from`. A typed subject-keyed `experimental:learning_item_knowledge_ids_rewrite`
records the mapping and projects in the same transaction. Its fold changes only knowledge IDs;
version, updated_at and derived state are preserved. Historical accepted-merge replay remains.
The shared repair operation requires an anchor and orders the event after the latest subject
event while callers retain their stable row lock. This handles recently backfilled bases and
same-clock chained repairs without an inline genesis fallback or extra ownership registry.

The final writer inventory found completion/relearn retraction still using raw state updates.
A typed `experimental:learning_item_state_restore` now records the captured prior status and
completion time, then projects. It preserves conditional/idempotent reversal and evidence cleanup,
rather than incorrectly mapping every undo to a new completion or relearn timestamp.
Completion/relearn acceptance also rechecks locked state and shares its canonical event clock.

Local validation: 312 scoped DB cases, 64 focused unit cases, typecheck, lint and build pass.
The existing lifecycle suite now checks replay after real completion/relearn acceptance and undo,
including resting/null, original completion time, evidence removal and repeated retraction.
Backfill/sweep fixtures include long, completed, versioned LearningItems with derived review data.
Duplicate OFF/ON cases are removed; migration refusal, null safety and row-lock probes remain.
Capability, architecture and flag checks pass; dependency baseline decreases 439→437 only.

Independent runtime review, exact-head CI and Mac-local rollout are still required.
The advisory fold-write inventory retains 8 other-entity unclassified writes and 5 stale entries;
YUK-974 captures their individual event-nativeness verification, not an allowlist expansion.
No new provider calls or production changes occurred in this runtime implementation.

## Initial review correction

PR #1356 initial review found a real retraction race: the proposal correction timestamp was
chosen before waiting on the target row. A concurrent later status/accept could then replay
after it and undo the retraction. Root reproduced Goal and MistakeVariant with actual blocked
Postgres statements (both RED), and the same ordering loss for LearningItem archive vs completion
(third RED: completed state/version disappeared). Locked owners now reject stale correction clocks;
the shared retract transaction rolls back the entire old event/outbox and retries with a time
beyond the locked row watermark. Batches use their maximum watermark. Three attempts bound
contention; exhaustion returns conflict, never a false success or persisted-event rewrite.
All three reproductions are GREEN, with one committed correction, exact replay and timestamp parity.
The related six DB suites pass 101 cases; typecheck/lint/build/architecture gates pass.

First exact-head CI `34117592341` passed non-DB gates; each DB shard failed one old raw fixture
(completion approval and placement cold start). Both now prepare fixtures through the real migration,
without relaxing approval/honesty checks; their four cases pass. Unique verification review and
new exact-head CI remain required before merge or Mac rollout.
