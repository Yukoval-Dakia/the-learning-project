# YUK-978 — native child projections follow parent authority

## Failure and ownership

Native Task start writes a running projection without a legacy mailbox lease.
When no child terminal arrives before the parent exits, the old lease-based
mailbox repair does not select it. A real Postgres execution-owner probe and six
formal DB cases reproduced the gap: parent success/failure/cancellation, and
recovery from DONE/FAILED(cancelled)/persisted reply marker.

The Copilot execution owner closes its admitted lifecycle event stream, drains
already-admitted callbacks and closes only missing native children of its exact
session/ask/task attempt. Explicit abort maps to cancelled; other missing results
map to lost, never fabricated success. Cleanup failure is logged without replacing
the paid root reply. Missing or failed child projection prevents SDK cursor reuse.

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
Local closure is exact-attempt only; durable parent recovery includes all attempts
of that ask, not another ask in the same session. Native projections have a started
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

Independent review, exact-head CI and local runtime delivery remain pending.
No paid model call, schema migration, UI change or historical data deletion occurred.
