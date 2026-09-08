# YUK984 — Canonical knowledge writes

Status: active, not delivered. Production remains the verified983 image.

## Execution plan

1. Consolidate edge create/archive/reactivate/supersede/merge writes around their
   existing generate events and projection. Preserve locks, topology, tombstone
   reuse, proposal decisions and atomic failure; remove duplicate DML and switches.
2. Consolidate node propose_new/reparent/archive/merge/split at the existing
   accept rate/index/projection seam. Preserve expected versions, embedding/hash
   maintenance and all nine downstream attribution owners. No event-bus/framework.
3. Extend deployment history validation to both kinds, including materialized
   proposal anchors and merge secondary IDs. Reject incomplete history rather
   than manufacturing a current-state genesis over missing history.
4. Scoped DB/concurrency/revert tests, local typecheck/lint/build, independent
   review and exact-head CI; fresh clone/backup/live Mac delivery. No paid calls.

## Progress

Create proposal accept now emits rate/generate before the sole projection write;
the duplicate flag-off INSERT is removed. The shared edge topology gate always
projects and rejects cycles; it no longer relies on production parity warnings.
Existing route, proposal and advisory-lock suites pass37 DB cases, including
topology rejection under both legacy flag values in production mode.
An additional INSERT-time DB trigger observes event existence, distinguishing
event-first execution from dual writes with coincidentally identical final rows.
This test and its full11-case route suite pass; typecheck and build pass.

Remaining edge create/archive/reactivate callers still pair raw DML with events;
the global flag is not yet retired. No completion/rollout claim for this step.
Read-only node mapping confirms the current fold covers all five operations:
Q1 subject, Q2 materialized proposal IDs and Q3 merge-from IDs. Root still must
validate each order-dependent side effect before moving structural writes.
In particular reparent hash recomputation currently reads the new tree position;
merge retirement repairs rely on tombstone/locking semantics. Do not blindly move
all side effects ahead of projection, and do not retain a second writer as rollback.
Rollback will use the prior release, not a permanent imperative mode.
