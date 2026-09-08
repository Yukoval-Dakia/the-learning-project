# YUK984 — Canonical knowledge writes

Status: delivered on Mac. PR1369 merged to main e9b6f251; production runs tested e514ef94. Whole-project goal remains active.

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

## Final delivery — authoritative current state

Final delivery: CI Gate34233241153 completed successfully for exacte514ef94;
independent initial review passed without P0/P1 and no verification round was needed.
PR1369 merged at2026-09-08T13:52:31Z to e9b6f2516dc4595bf3cb4eae1a179c4403fed78f.
The guarded Mac deployment started app/worker at13:53:04Z on e514ef94. Both are
healthy with zero restarts; original Postgres ID/start time/volume are unchanged.
Live migration checked all seven entities with zero new anchors. Production remains
454 events/280 AI tasks/21 provider attempts/zero active-created-retry jobs.
Health200, unauthenticated401, knowledge200, seven notes200 and actual browser
read/reload passed with zero page errors. No paid call or NAS operation occurred.
Retained golden replay also shows zero drift (Knowledge12, LearningItem7, Artifact8,
ItemCalibration22; the remaining kinds have zero retained rows and are not evidence
of complex live coverage). Backup, old image/overlays and clone evidence remain.
Recovery requires the previous release/configuration, not an environment toggle.
Linear984 is Done. Remaining overall work is tracked separately under887/951 and
the final behavior-by-behavior acceptance; no whole-project completion is claimed.

## Historical implementation checkpoints — not operational instructions

The records below describe earlier states before the final delivery above. Their
old SHA, process identities, waiting steps and undeployed observations are retained
as evidence only; do not repeat review, CI, migration or deployment from this section.

At the pre-merge checkpoint, PR1369 was open at exact
e514ef94a5f8032e21a8afbe9864294538b5b935; CI Gate34233241153 was running.
The first full independent review had passed with no P0/P1. Build/unit/audits/
migration/usability jobs had passed; both DB shards were awaiting completion.
The review's initial parent-lock candidate was withdrawn after checking the existing
explicit support for archived ancestors with live children. Only stale fold header
comments were noted as nonblocking P2; no extra nit issue or verification review is needed.

Fresh production backup SHA25614d0a533c49b6c2bbe6b3f8252dcda9277fd82f105755664d3d682b707a1128e
was actually restored into loom_before_984_verify, matching454 events/280 tasks/21
attempts. The real e514ef94 image (sha256:1a68f9042daaabe160c1ee2e4aa4e8b81405de06a3c2ebbd005af50d9f6f0ad0)
passed migration with zero new anchors and12 knowledge/7 learning items/8 artifacts
validated. Shipped HTTP on that clone renamed math successfully (200, revision0→1),
updated the knowledge tree name and rejected the old revision with409. A second
actual-image migration after the HTTP edit also passed. Clone now has455 events;
tasks/attempts remain280/21. Its temporary API is stopped; no worker/model credentials
were supplied. At that checkpoint production stayed454/280/21 on5dd7e8ed, and all
three original containers retained their IDs/start times and zero restart counts.
This was clone acceptance, before the final deployment recorded above. Private evidence is under the existing
tlp-local-prod-20260907.sjUaCU directory (knowledge984-* artifacts).

The global writer switch is retired from runtime policy, environment schema and
tracked Mac compose. Knowledge and KnowledgeEdge now have explicit canonical
registry identities alongside the other five structural entities; ItemCalibration
retains Scheme A. README documents seven-entity readiness and previous-release
rollback. Removed four redundant ON/OFF proposal comparisons and their volatile-field
helper; actual field/index/history/concurrency/replay tests remain. Oracle now audits
all seven kinds regardless of retired environment values. Final76 scoped DB tests,
3 policy unit tests, typecheck/lint/build and boundary/deepening/strict fold audits
pass. Lint reports316 warnings/1info, exit0; this is not a claim of warning-free code.
At the earlier source preflight, remote main was7cccb335 and no984 PR existed.
The then-pending independent review, exact-head CI, fresh-clone migration and Mac
delivery were subsequently completed as recorded above. That source checkpoint
made no production change or paid call.

Deployment preparation now covers all seven canonical entities, adding Knowledge
and KnowledgeEdge to the migration's table locks, backfills and symmetric audits.
Before any backfill, validateKnowledgeHistory checks direct genesis identity,
indirect proposal/split materialized IDs with original accept/index chains, all
merge source/destination bases, and edge creation before archive. Pending proposals
do not disqualify truly eventless legacy rows. Knowledge rates and edge decisions
have different production envelopes; each is checked against its actual protocol.
Edge accept/reverse/change-type/supersede must retain their generated effect(s).

Validation reuses existing schemas, reconstructing the mutation discriminator from
the action exactly as the fold does. A surviving materialized accept with both
proposal and index missing is refused, not treated as permission to snapshot live
state. Valid new-node/merge/split histories remain unchanged; lost acceptance/index/
merge source base and archive-only edge histories reject without writing a baseline.
Three suites pass95 DB tests; four caller/history suites pass73, including proposal
actions and merge-attribution backfill. Final expanded nine-case history rerun and
typecheck/build pass. Initial failures were two old five-entity
report fixtures plus new fixture/envelope construction errors, corrected without
relaxing provenance checks. No live migration or paid invocation occurred.

All four creation entrypoints now consume Knowledge's createKnowledgeNodeFromEvents:
LearningIntent, builtin bootstrap, custom subject roots and placement starters. The
shared operation owns per-ID creation locking, create-only vs existing-skip semantics,
genesis/index/projection and outbox opt-out. Existing nodes never receive replacement
history; a missing live row with reconstructible history is refused. Provenance and
placement's deterministic event ID remain, as do placement's existing identity checks.
Four suites pass44 DB tests; three additional creation/concurrency suites pass26;
typecheck/build pass. Cross-entrypoint bootstrap/root contention creates one birth.

The source structural DML census now leaves only the knowledge projector and two
derived embedding writers. Removed eight stale registry entries; proposals is now
maintenance-only. Strict fold-write audit has no violation/stale entries. Boundary
and deepening audits pass with explicitly reconciled totals428/0/48: Knowledge's
shared creation lock adds one server reference while projection references drop six;
Practice adds one real Knowledge creation command, replacing its raw cross-domain
INSERT. It is classified as a command under984, not hidden in a kernel facade or
mislabelled a read. This does not claim SCC removal or whole-project completion.
An audit unit fixture referencing removed seed writers was updated to still-existing
artifact/question-block caller-owned writers, preserving the advisory behavior test.

Remaining984 work: knowledge/edge deployment history (Q2/Q3), global writer flag
retirement, full independent review/exact-head CI and authorized Mac delivery.

Subject rename/reset now lock the root, validate history, write the existing name
event and project the structure instead of directly updating knowledge. The strict
requireKnowledgeHistory guard moved from the private proposal implementation into
the existing knowledge projection module, shared by both actual consumers. Subject
revision checks, root row serialization and lock-after timestamp ordering remain.
Missing genesis or structural drift rejects and rolls back subject fields/revision,
journal, events and root together. Two suites pass79 DB tests; the final expanded
control suite passes10 tests; typecheck/build pass. The three creation entrypoints
(seedKnowledge, ensureSubjectRoot and placement-starter) remain before migration
validation/global-flag retirement and full984 review/CI/Mac delivery.

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
