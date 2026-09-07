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

YUK-951 remains open after this source-only cut. The existing finalization design's
deployed zero-nonterminal plus zero-queue-activity window still governs deletion of
drain handlers. No production write, handler shutdown, paid call or historical data
deletion is authorized by a passing source cleanup test.

## Validation

31 scoped unit tests pass across actual tool inventory, native contracts/configuration
and ToolOperations behavior. Typecheck, lint and build pass (existing lint/bundle
warnings remain). All 41 focused real-Postgres mailbox and ToolOperations tests pass;
independent review and exact-head CI are required before merge. Architecture counts alone are
not evidence that all business complexity is encapsulated.
