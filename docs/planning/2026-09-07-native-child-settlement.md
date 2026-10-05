# YUK-978 — native child projections follow parent authority

## Failure and ownership

Native Task start writes a running projection without a legacy mailbox lease.
When no child terminal arrives before the parent exits, the old lease-based
mailbox repair does not select it. A real Postgres execution-owner probe and six
formal DB cases reproduced the gap: parent success/failure/cancellation, and
recovery from DONE/FAILED(cancelled)/persisted reply marker.

The Copilot execution owner closes its admitted lifecycle event stream and drains
already-admitted callbacks. It tracks persisted open children only to withhold SDK
cursor reuse, never to infer a product outcome from SDK exit. The durable worker
settles missing native children after the committed parent outcome, including
early returns and persisted markers whose public suffix failed. A committed
cancellation maps to cancelled; other missing results map to lost, never fabricated
success. Cleanup failure is logged without replacing the paid root reply.

The existing parent reconciler owns restart recovery. Its bounded candidate query
now includes terminal parents only while they retain open native projections; the
filter remains before LIMIT. It completes the parent outcome first and separately
repairs native children from that authoritative marker/job terminal. A failed child
repair cannot roll back the paid parent result, and remains eligible next time.
No new schedule, worker, timeout policy, paid replay or dependency on the legacy
subagent reconciler is introduced. An AI-attempt status or null lease is not used
as evidence that a parent product turn ended.

## Shared contracts and fences

The existing full persisted-reply decoder moves unchanged from `copilot_run.ts`
to `copilot-run-outcome.ts`, serving both parent recovery and native admission.
No second reply/mode/presentation decoder is maintained. Native start and native
terminal take the same parent settlement lock used by committed outcomes and Stop.
A parent outcome that wins that lock prevents a late new start or late success from
reviving its child; already settled child rows stay immutable.

Identity is session + parent ask (`runId/sourceEventId`) + actual task attempt.
Committed parent settlement and recovery include all attempts of that ask, not
another ask in the same session. Native projections have a started
timestamp but no claim, queue job, lease, hard deadline or child task-run ID; legacy
claimed mailbox children are excluded. Historical schema/tables and old recovery
handlers remain intact. Lock order is parent settlement then sorted child rows;
no native path acquires dispatch while holding settlement.

## Evidence before review

- Six DB regressions were RED, then GREEN.
- 25 real-Postgres mailbox/reconcile tests pass, including actual advisory-lock
  contention, late start/terminal, retry attempts, same-session live siblings,
  completed children, claimed legacy children and zero continuation creation.
- 76 related durable worker, teaching, session queue and Stop DB tests pass.
- 18 execution/native unit tests pass, including failure to persist a child
  projection preserving the root reply but withholding its SDK cursor.
- Typecheck, lint/build and capability/architecture gates pass; existing warnings
  remain. Dependency counts remain 437/0/47, not a claim of complete architecture.

The first combined DB run exposed fixture leakage: operational subagent tables
are outside resetDb's domain whitelist. The affected suites now clean their own
operational fixtures before/after tests; the original whole-table assertions stay.
No production data or global reset policy was changed.

## P1 correction before delivery

Initial review and CI at ba4bc7fe passed, but a later advisory identified premature
local child closure before finalization and the worker's final cancellation probe.
An actual public-worker Postgres regression reproduced parent cancelled / child
lost by delivering Stop after execution returned. The first two attempts had a
test fixture field-name error; only the corrected third RED demonstrates this P1.
The local terminal-writing helper is now removed. Both live completion and crash
repair use the existing canonical parent marker/job terminal under its settlement
lock. The regression now passes with one child settlement and no paid replay.
The three execution-only tests explicitly commit a parent result before expecting
child closure; SDK exit alone must leave the child running and withhold its cursor.

The initial clean-image physical pg-boss canary proved three restart repairs and
repeat idempotence with zero AI task/provider-attempt rows. That candidate was not
deployed; its isolated worker is stopped with exit 0. Production remains unchanged.
No paid model call, schema migration, UI change or historical data deletion occurred.

## Completed delivery

PR1362 exact `582b2e66cdd7f809e1f3c1509d60f668a46e9668` passed every job in
CI Gate `34139494605` and the sole P1 verification review (independent seven DB
cases). Root verification was 102 scoped DB and 18 unit cases, typecheck, lint,
build and both architecture audits. The PR merged at 2026-09-07T15:45:36Z as
`2351d5657ec7696bf5da88226d0e33fa873bc405`; the review thread is resolved.

Clean image `the-learning-project-app:582b2e66` has ID
`sha256:349a23af79dbf5a8da127e45fdc781cb22532c26cbd686697c4131824c0bbbac`.
It processed physical pg-boss reconciliation job `1b127e7f-ac55-46a0-9d86-f8396e76dde3`
in the isolated synthetic database `loom_native_978_ba4bc7fe_verify`, closing three
native children from DONE, FAILED(cancelled), and a reply marker. Explicit repeated
job `915b0c68-4d87-47ba-b028-60607cd663cb` left exactly three child-settled events,
zero continuations, zero AI tasks and zero provider attempts. Both candidate workers
are stopped with exit 0. This proves physical recovery, not paid-model output quality.

At 15:46Z Mac-local API and worker were updated to this image, healthy with zero
restarts. The prior API/worker stopped with exit 0; bundled live migration applied
zero new migrations and all seven LearningItems passed readiness. The existing
Postgres container `7d99236a` (StartedAt 09:40:42Z) and pgdata volume were unchanged.
Live counts stayed 423 events / 258 AI tasks / 4 provider attempts / 0 native children,
and the active/created/retry queue was empty at the final snapshot. Health returned
200; auth check returned 401 without the token and 200 with it; sessions returned 200.
The shipped browser drawer opened and reopened after refresh without page errors;
no message was sent. Screenshot is in the private local-production evidence directory.

The private `runtime-978-image.override.yml` selects the new image for both roles.
Removing that overlay restores the prior API c6bbf5e1 / worker 14ea1a81 images;
existing backups and append-only data are retained. No NAS/tunnel operation or paid
model call occurred. The recovery-specific $3 remains unused.

## Remaining work boundary

YUK-978 is Done, not the whole architecture goal. Next, map existing actual-output,
crash, migration and browser evidence to YUK-887's seven rollout scenarios and only
fill demonstrated gaps. Its production rollout gate is distinct from implementation
completion. YUK-951 still needs the deployed full retry/drain window before deleting
legacy handlers. YUK-977 known-zero provenance remains a non-blocking P2. Do not
restart a file-by-file architecture cleanup or repeat paid samples merely to make
every historical verification use the latest SHA.
