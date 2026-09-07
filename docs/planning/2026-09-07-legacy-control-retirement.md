# YUK-951 — retired model controls and drain readiness

## Current cut

Remove the seven unregistered DomainTool adapters from `subagent-controls.ts` and
`tool-operation-controls.ts`. These files had no production consumer: only a unit
test imported four tool objects and a second test required both files to exist.
The actual manifest and allowlist tests already reject all seven tool names.

The adapters were not the historical recovery interface. Queued handlers directly
call `subagent-mailbox.ts` and the ToolOperations kernel. Keep those implementations,
their queues, cancellation, historical readers, schema and native child projection.
No rename of durable concepts, schema migration or new execution abstraction is made.

Delete the obsolete file-existence test and the four unused-tool mirror assertions.
Keep real manifest loading/permissions, the native child prompt/budget contracts,
native spawn configuration and the rich mailbox/ToolOperations behavior suites.
There is no replacement test requiring that a source file stay absent.

## Production evidence and remaining gate

Read-only Mac-local query at 2026-09-07T14:39:26Z found zero total rows in
`tool_operation`, `subagent_run` and `copilot_continuation`. No subagent-run,
continuation or corresponding DLQ jobs were present. The reconcile queue had 274
completed records, starting at 10:06:50Z; no created/retry/active record was present.
This proves a point-in-time empty state, not continuous drain readiness.

Actual registered agent queues have expire 7200 seconds, two retries, delay 30 seconds
with backoff and retention seven days. A conservative three-attempt expiry envelope
already exceeds six hours; do not use the 12-minute application deadline as the
whole queue retry window. Exact backoff/jitter and any scheduling delays still need
to be included before choosing a final retirement timestamp. Retention alone is not
an automatic replay schedule, and operator-replayed DLQ work remains a separate action.

Native Task events still write the `subagent_run` projection but do not mint a legacy
continuation. That table is therefore not wholly obsolete. Event/turn readers and
explicit cancellation must survive any subsequent legacy-handler deletion.

### Retained-history recheck (2026-09-07 16:09Z)

The deployed pg-boss version is 12.26.3. Its actual retry formula bounds the two
backoffs at 60 and 120 seconds, so the three active-expiry allowances total
`3 * 7200 + 60 + 120 = 21780 seconds` (6h03m), before supervision, polling and
process downtime. Expiry is driven by the supervisor (default 60 seconds), not
the separately named monitoring interval. Allow for a check on each expiry, not
only one final check, and for each fetch/downtime gap.

The four legacy main/DLQ queues and reconcile queue were created at 10:06:15Z;
all actually have retention_seconds **and deletion_seconds** 604800. The library's
normal cleanup therefore cannot remove their completed/failed job rows in this
six-hour observation interval. Current non-test production code has no deleteJob,
deleteAllJobs, purgeQueue, deleteQueue or deleteAfterSeconds override call. All-state
retained history contains no legacy run/continuation/DLQ jobs; the three operational
tables remain empty. Reconcile completions span 10:06:51.958Z–16:09:02.305Z, with
maximum inter-completion gap 94.688489 seconds.

Unlike two endpoint snapshots, those retained all-state records and unchanged queue
creation identities can establish absence of intermediate queue activity. They do
not excuse the elapsed-window requirement. Use **no earlier than 16:20Z** for the
final retirement recheck, then verify the same queue identities/retention, full-state
history, empty tables, successful recent reconciliation and actual worker identity.
This margin includes repeated supervision/fetch checks and observed brief restarts;
do not extrapolate it to another host or a stopped worker with unbounded downtime.

Retirement must remove the three legacy manifest jobs and their dedicated execution
helpers, while preserving native projection/parent recovery and historical readers.
The registrar only adds current schedules: removal from the manifest does not
automatically unschedule an already-persisted copilot_subagent_reconcile cron.
Its exact schedule must also be retired during authorized local delivery; preserve
the queue/history rather than deleting them. No handler/schedule has been removed
at this evidence-only checkpoint.

YUK-951 remains open after this source-only cut. The existing finalization design's
deployed zero-nonterminal plus zero-queue-activity window still governs deletion of
drain handlers. No production write, handler shutdown, paid call or historical data
deletion is authorized by a passing source cleanup test.

## Validation

### Drained execution retirement, 2026-09-08

Final read at 2026-09-07T16:20:25.695893Z passed the conservative full drain
window: queue identities were unchanged since 10:06Z, retention/deletion both
604800 seconds, zero legacy run/continuation/DLQ jobs across all states, 375
completed reconcile jobs, and zero rows in the three operational tables.
The production old reconcile schedule is still present; it must be explicitly
unscheduled and its housekeeping ticks drained during the controlled cutover.

The implementation removes three old handlers/registrations, standalone research
TaskSpec, mailbox launcher/lease/automatic continuation and its unused context
assembler. Native children, current history readers, durable Stop and real remote
ToolOperations remain. Historical fixtures now seed rows directly instead of
retaining an executable legacy launcher for tests. ADR-0063 records the boundary.

Local evidence: 34 focused DB and 87 current worker/teaching/turns DB tests pass;
82 census/catalog unit tests pass after repairing discovery of the actual injected
collecting-stream runner. Typecheck/lint/build and architecture/capability audits
pass (435/0/47). Real dist/migrate.cjs refuses the existing synthetic clone with
jobs=1/schedules=1 (exit 1). Fresh loom_retirement_951_fresh_verify migrates and
seeds with no pg-boss namespace (exit 0); adding only an empty pg-boss namespace
then correctly fails on missing tables (exit 1), rather than treating it as fresh.
That isolated diagnostic DB is retained. No production mutation or paid call.
Delivered as PR1363, exact57a7bbee6a1b193de912abbee94093e3e54fd5de; CI Gate
34144766869 passed every job. Independent initial review PASS (12 DB/54 unit),
no second review. First CI exposed only retained historical-column classifications
and a stale architecture Task row; both were corrected without runtime changes.
Merged 2026-09-07T16:57:40Z as3c8d5c1b35c10c323e3a3f55dcb294653ad29af1.

Mac app/worker now run clean106ac7ff image
7c08b3c116ae8d049feb4e89adfcc218f8b66c137c573f7a6d2505a73705ee93.
Old app stopped normally (exit0), the exact reconcile schedule was unscheduled,
all pending queue states were empty, and old worker stopped normally (exit0).
Live migration passed the new guard, zero new migrations/seeds, seven LearningItems
ready. New appac3e09f4/workerfaa93c5f started16:58:12Z, healthy/zero restarts;
original PG7d99236a and its09:40:42Z start/volume remained unchanged.
Counts stayed423events/258tasks/4attempts/0children/0continuations. Health200,
unauthenticated sessions401/authenticated200; browser drawer reload/reopen and
settled summary/input passed, zero page errors and zero sent model messages.
Private runtime-951-image.override.yml selects the image; removing it rolls back
to582b2e66, whose worker restores the old schedule and therefore requires repeat
readiness before upgrading again. No historical data/queue or volume was deleted.
Source README/advisory stale foreground/mailbox descriptions corrected in delivery
notes; B3 historical physical-name decision remains separate, not claimed complete.

### Earlier source-only slice

31 scoped unit tests pass across actual tool inventory, native contracts/configuration
and ToolOperations behavior. Typecheck, lint and build pass (existing lint/bundle
warnings remain). All 41 focused real-Postgres mailbox and ToolOperations tests pass;
independent review and exact-head CI are required before merge. Architecture counts alone are
not evidence that all business complexity is encapsulated.

## Source-only delivery and next recovery defect

PR1361 exact `ab0bbb909aca47530f706b2204045f6cd4b12a12` passed every job in
CI Gate `34134547233` and merged at 2026-09-07T14:54:05Z as
`26e0e2d6550404bdfeaee22df38a56dc56ff140c`. Independent initial review found no
findings and reran eight unit tests. No second review was needed. No production
restart is needed for adapters which were already absent from the runtime graph.
YUK-951 remains open for the explicitly retained drain/noun retirement work.

The retirement lookup exposed YUK-978, distinct from hidden-terminal handling:
native child start followed by a parent transport exception without a child terminal
leaves `running` with NULL lease and settled time. A real execution-owner probe with
only the external SDK stream substituted reproduced this on the retained isolated
Postgres clone. The actual mailbox recovery returned no work; no continuation was
created. The outer transaction was rolled back, and a separate read verified zero
probe rows/events. No provider call or production mutation occurred. This is the
next lifecycle correctness fix, not proof of production failure or a reason to
delete native projection/recovery responsibilities.
