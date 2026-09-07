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

## Runtime retirement in progress

Migration prerequisite PR #1355 merged as `9607310839b8e02d9b8d17ab9e3b3279fdf24535`;
final `6d476fc9` passed CI `34112766637`. The separate unpublished retirement branch removes
the main alternate paths, passes 108 scoped lifecycle DB cases and typecheck, and preserves
early verification admission and atomic dismissal failure. Flags, duplicate-mode tests and
remaining structural attribution are not finished or deployed.

The remaining learning-item attribution helper runs before the live merge acceptance event and
also serves historical repair based on `knowledge.merged_from`. Replaying only old accepted merge
events cannot repair a stale item whose genesis was recorded later. The next implementation is a
typed, subject-keyed `experimental:learning_item_knowledge_ids_rewrite` event with `{from_id, into_id}`:
the existing Practice helper keeps its row lock and affected-ID receipt, emits the correction and
projects immediately in the same transaction. The fold changes only knowledge IDs, not version or
updated_at; historical accepted-merge replay remains supported. Do not add another inline genesis
branch: require the formal migration first, including in historical-maintenance fixtures/entrypoints.
Verify event ordering against recently backfilled bases and preserve no-op behavior.
