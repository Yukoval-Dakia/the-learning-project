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

Archive proposal acceptance now locks the live row before emitting rate/archive
events and projecting, removing its imperative UPDATE and final writer switch.
It requires a creation/genesis baseline (archive-only synthesis is not a baseline)
and a reconstructible fold; rejection commits no decision/archive. Existing two-
proposal contention still allows exactly one archive. Three related suites pass59
DB cases, with missing-history refusal then explicit test-only backfill coverage.
Typecheck/build pass; final explicit base-action check passes the42-case actions suite.
Live read-only preflight finds0 edges: no live legacy edge is exposed, but that
empty population is not evidence for complex history migration or complete rollout.

The complete archive operation now belongs to Knowledge's
`archiveKnowledgeEdgeFromEvents`: transaction/lock, base validation, provenance,
projection and concurrent no-op handling. Proposal acceptance and cascade revert
both consume it; cascade no longer reads edge internals or constructs archive
events. Compensation retains its cause/time and `ingest_at` memory-outbox opt-out.
The raw archive function is now deleted: incident retirement, merge and supersede
also consume the common operation. Duplicate archive event assembly and inline
genesis fallback are removed. Supersede archives the old relationship before its
replacement, atomically; its caller no longer passes redundant old-edge fields.
Two integration suites pass61 DB cases. A legacy cascade fixture had an empty
create payload; replacing it with the actual structural fields/actor/time restores
replay fidelity, without weakening rollback assertions. Final cascade19DB,
typecheck/build and changed-file lint pass. No review/PR/deployment claim yet.

Internal caller migration passes145 scoped DB cases and20 edge-owner cases, plus
typecheck/build. Initial10 failures were old fixtures without creation history.
Fixtures explicitly seed history; the old inline-backfill expectation now proves
rejection/full rollback first, then success after explicit preparation, retaining
every field/replay assertion. The raw archive entrypoint and writeEdgeArchiveEvent
have no remaining production definitions/calls. Node DML and
deployment history validation remain; this is not984 completion or a deploy point.

Create/reactivate now also own event provenance and transactional projection;
paired generate events in route/merge/supersede are removed, preserving correction
event IDs. No raw edge INSERT/UPDATE remains in these business owners.
The global node flag is not yet retired. No completion/rollout claim for this step.
Read-only node mapping confirms the current fold covers all five operations:
Q1 subject, Q2 materialized proposal IDs and Q3 merge-from IDs. Root still must
validate each order-dependent side effect before moving structural writes.
In particular reparent hash recomputation currently reads the new tree position;
merge retirement repairs rely on tombstone/locking semantics. Do not blindly move
all side effects ahead of projection, and do not retain a second writer as rollback.
Rollback will use the prior release, not a permanent imperative mode.

Final seven suites pass212 DB cases, typecheck/build pass, and Postman regeneration
has no diff. The first192-case combined run found one stale fixture whose revival
predated creation; it now uses actual create/archive history. A same-clock
create→archive→revive regression also pins strict event ordering: under the row lock,
archive/revive advance beyond existing history instead of relying on random IDs.
The requested time is a lower bound; memory ingest_at opt-out remains independent.
No paid call or production change. Node operations and deployment history are next.

Node creation now shares a read-only `prepareProposedKnowledgeId` that validates
the parent and allocates identity. Explicit acceptance and automatic tagging
always record their existing creation contract before projection; removed the
optional direct INSERT and tagging's flag/parity fallback. Automatic approval,
cache and provenance semantics remain unchanged. Preparation tests assert no node
or event is prematurely written; original node-field assertions now live on actual
proposal acceptance. Three suites pass117 DB cases; final accepted-node contract
passes3 targeted cases, with typecheck/build green. Existing-node reparent/archive/
merge/split still require side-effect ordering work before removing their flag.
