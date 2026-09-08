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

LearningIntent creation now writes per-node genesis/index before projection in its
Knowledge owner. Agency passes the reserved accept rate ID for birth provenance;
memory outbox opt-out remains. A per-ID creation lock and existing-row refusal
retain create-only semantics instead of silently upserting over an existing node.
The existing3a acceptance scenario now proves Notes failure rolls back all newly
created knowledge/events/index, both root and child fold to exact live snapshots,
births reference the accepting rate, and the child accepts a later archive without
backfill. Two suites pass56 DB tests; typecheck/build pass. Duplicate-ID refusal
is also checked for no event or row mutation in the final targeted rerun.

Final source DML census identifies three additional event-paired creation sites:
knowledge/seed.ts, subjects/ensure-subject-root.ts and Practice placement-starter-store.ts;
subject-control-write.ts also directly updates root names. These remain in scope
for structural-owner consolidation. Do not count their paired events as retirement.
The two embedding maintenance writers remain derived-only and are not removed.

Merge now uses private preparation: validate all locked source/destination histories
and structural fold/live parity, repair all nine attribution surfaces, write the
complete immutable acceptance receipt, then project every affected node. Removed
the raw applyMerge export, both knowledge structural UPDATEs and the final accept
writer flag/parity branch. Embedding maintenance remains a derived-only write.
Duplicate sources and mismatched proposal destination are rejected.

Tests now call real acceptance and read the receipt by exact proposal identity.
A PostgreSQL trigger proves both structural updates occur only after the complete
repair receipt exists. Missing history, out-of-band drift and mismatched subject
all reject without structural changes or acceptance. Four old fixtures explicitly
prepare node history; the seed-root case first proves refusal/no deletion, then
accepts after preparation. Four suites pass131 DB tests, typecheck/build pass.
An initial runner exited1 after setup without test results; the terminal handle
was confirmed before a single-suite rerun exposed the four fixture gaps (63 passed).
No production failure/paid call/deployment. Deployment history and global flag
retirement remain, followed by full984 review/CI/authorized Mac delivery.
Final consumer inspection found another real creation owner outside these five
proposal operations: learning-intent-knowledge.ts still inserts directly, and its
two Agency acceptance call sites do not create knowledge event/index history.
That owner must be migrated before deployment validation/flag retirement. The
subject-root control/seed paths also need a final structural-writer audit; having
paired events alone is not proof that a duplicate writer should remain.

Merge preparation inspection confirms the nine attribution owners operate on explicit IDs
and do not require the absorbed knowledge rows to be archived first. Structural merge DML
has not yet been removed. Before that change, a real lock inversion was corrected:
accept held sorted knowledge row locks before applyMerge acquired the global learning-state
lock. Accept now acquires G first, matching repair/revert writers. A real proposal acceptance
regression inspects pg_locks while blocked on G and requires no knowledge RowShareLock.
Both scoped suites pass77 DB tests; typecheck/build pass. No production failure is claimed;
this is a local checkpoint, not the984 independent review/CI/deployment gate.
Bounded independent lock-only inspection found no P0/P1. Removing the entry fix
made the new regression fail with granted_knowledge_rel=1 (expected0); the fix was
restored. The probe now releases its holder and drains both transactions even if
an assertion fails, avoiding leaked asynchronous mutation in the RED path.

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

Reparent now validates expected version, live state and reconstructible history
under the existing accept row lock, projects from the accepted event, then resolves
the new effective domain to refresh embedding/hash only. Removed structural UPDATE;
the derived maintenance no longer writes the fold-owned updated_at. Public-accept
tests replace calls to the retired raw applier through an explicit fixture helper.
Two missing-history fixtures were corrected; a concurrency regression exposed the
old test writer's fabricated event subject. Fixtures now derive the real mutation
subject, and acceptance explicitly rejects a mismatched target rather than returning
success without a projection. Final four suites pass126 DB cases, plus7 focused
reparent guards (one winner for equal-version races, missing history, wrong subject,
stale version, parent guards); cross-/same-domain embedding, typecheck/build pass.
Archive/merge/split and deployment/flag retirement remain. No paid or live changes.

Archive/split are now prepared inside the accepting transaction without node DML:
lock/version/history validation, incident-edge retirement, then acceptance-driven
projection of source and minted children. The real node-retract applier also uses
preparation followed by projection. Removed the public raw archive export.
Existing retract atomicity exposed that non-null history alone could silently
overwrite out-of-band structural changes; reparent/archive/split now strictly
compare fold/live structural snapshots before mutation (derived embedding excluded).
Historical fixture clocks are set before genesis creation and advanced for accept;
no fixture rewrites an existing event. Final four suites pass127 DB cases, including
archive/split, retraction rollback and embedding; typecheck/build pass.
Only merge's node structural DML remains in this coordinator. A read-only follow-up
is checking whether any attribution owner requires the absorbed row already archived
before repair, and the global learning-state lock order, before that final removal.
No review, PR, production mutation or paid call in this checkpoint.
