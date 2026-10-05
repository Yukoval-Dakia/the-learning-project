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

Exact-head CI and Mac-local rollout are still required; independent review is complete below.
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
without relaxing approval/honesty checks; their four cases pass. Unique verification review of
`4e1dec7c` passed, independently rerunning 67 DB cases and confirming all three locking regressions.
The review budget is exhausted; no third review is required.

CI `34119067574` passed all gates except one existing deadline-cleanup DB test, whose real
50ms deadline made success depend on CI database speed. The test now injects semantic time until
confirmed settlement, then crosses the deadline and asserts the execution signal stays un-aborted.
Real deadline enforcement cases remain unchanged. All 26 tool-operation DB and 15 unit cases pass;
typecheck and lint pass. This follow-up changes tests only and awaits a new exact-head CI.

Image `the-learning-project-app:4e1dec7c` was built from a clean archive and its actual bundled
migration succeeded against the retained production clone. Before deployment, the live hydrated
projection audit and all eight private golden reaudits have zero drift (423 live events, seven
LearningItems; Goal and MistakeVariant production sets remain empty). This is not deployed evidence.

Rollback must account for the two new typed LearningItem repair events: the old `55aaac30`
reducers do not understand them. Use the retained old image with its three structural projection
flags OFF, preserve materialized rows, and never rebuild with old reducers after new-version writes.
Re-entering canonical mode after rollback writes requires readiness verification/repair again.
The private rollback compose override is retained alongside backups; a fresh pre-deploy database
dump is still required. No NAS deployment or new model calls are authorized by this preparation.

## Completed Mac-local delivery

PR #1356 exact `4328ab89753e21d3aa90754de02f64cfe1be2db6` passed every CI Gate job in
run `34120804982`; merged 2026-09-07T12:25:54Z as `21bc94dcfe7b6a940d8c8fc2a4d63c42222890f1`.
The final tip differs from reviewed runtime `4e1dec7c` only in tests and delivery documentation.
The final test-only adjustment passed local build as well as the checks above; it was root-verified,
not a third independent runtime review.

- Fresh private `loom-before-973-4e1dec7c.dump` SHA256:
  `b7d6299b829b4dba9c3300290b7f42cf83f81d33598ad93a6ccbf3166db69fbd`.
  Actual restore into new isolated `loom_before_973_verify` succeeded: 423 events, seven
  LearningItems, 258 AI tasks, four provider attempts. All earlier backups remain retained.
- Stopped app and worker, then ran the new image's bundled migration against live `loom`.
  Migration succeeded with zero new anchors/trait changes and seven LearningItems checked.
  No live rebuild, data deletion, queue redrive or paid model call occurred.
- Started worker then app using explicit project `the-learning-project` and the private image
  override. Both run `the-learning-project-app:4e1dec7c`, image
  `sha256:835951fff624572d31c4812ffe2e48d28e71df248914722c64012f355fb9e0aa`, healthy as `node`,
  zero restarts. Their three retired writer flags are absent; API remains loopback 8787/RW_WORKER=0.
- Existing Postgres container `7d99236a099a4216517a63c6511495f7ffff156b6385004af2942069f7bb61ba`
  retains start time `2026-09-07T09:40:42.502546542Z` and original data volume. No tunnel/NAS change.
- Post-start hydrated live projection audit has zero drift/allowances across eight kinds;
  all eight retained goldens re-fold with zero differences. Goal/variant are still empty in
  production, not populated canaries; rich scoped DB and exact-head CI cover those entities.
- Chromium verified real authentication, visible drawer, refresh/reopen, with zero page errors.
  Private screenshot `copilot-after-973.png` was visually inspected. No message was sent;
  this is surface verification, not a new model-output or crash-recovery claim.
- Final live counts remain 423 events, seven LearningItems, 258 AI tasks and four provider
  attempts; active/created/retry queue sets empty. The recovery-specific $3 remains unused.

YUK-973 is complete. The overall architecture goal remains active: YUK-974 tracks remaining
other-entity writer ownership, YUK-972 the custom-profile constraint, and YUK-887 retains the
broader provider/crash matrix. This delivery does not claim the entire product refactor complete.
