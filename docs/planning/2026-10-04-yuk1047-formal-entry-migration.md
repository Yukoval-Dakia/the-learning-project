# YUK-1047 formal entry migration — implementation checkpoint

The target remains the approved eight-entry cutover in the original assessment
plan. This worktree is an unshipped checkpoint, not evidence that all entries
have migrated. No production, paid evaluation or dependency upgrade is included.
The Q20 approval recorded on 2026-09-25 applies to the existing response controls,
PfSolo/PfPaper hosts and hint drawer; no new route or drawer is introduced.

Prerequisites #1563 and #1564 merged to main 448ffe42 and 6e5d93ac respectively.
#1564 completed 94 DB / 107 scoped unit, local gates, the initial/sole-review
budget with all proven defects fixed, exact-head CI37234688601 and its 17-minute
window. The incremental CI did not run migration or browser tests.

Current implementation:

- Evaluations accept an operation key, bind its frozen input/intent digest under
  the existing group lock, and reuse the sealed candidate before another model
  invocation. Pending candidates also replay; explicit recovery uses a new key.
- Advice now requires a native immutable submission, validates question versus
  issuance scope, persists the original response, and returns a candidate without
  activating learning state. Published task identity selects native pi/Jev.
- Issuance recovery returns accepted original responses and evidence after draft
  archival, including the original idempotency key; it does not release paper
  feedback or publish scoring bases.
- Native response adapters preserve published option/item IDs, raw numeric text,
  confidence and original attachments. Upload receipts retain original digest,
  MIME, size and server timestamp where available.
- PfSolo now starts/restores a pinned issuance, renders frozen public material
  and slots, restores server drafts/accepted submissions, and sends the native
  response to advice. This host migration is not yet complete or acceptance-tested.

Completed scoped checks at this checkpoint: 19 evaluation/preview DB, 21
submission/recovery DB, 105 core/response unit cases and the 3 upload cases.
The native operation-key regression first failed before implementation. The
recovery test had a fixture variable error, corrected without dropping assertions.
API client and Postman generators ran. Typecheck passed after the first host
adapter correction; final local gates and independent review are not yet done.

Remaining on this branch before any release claim:

1. Solo commit and durable dispatch/worker must consume the same persisted
   candidate and activate through contract settlement, preserving once-only
   diagnostics, capture fields, pending recovery and appeal anchors. Remove the
   current legacy judge branch only after all actual callers move.
2. Explicit manual issuance needs its actual self-report candidate/FSRS-only
   confirmation flow. Advice currently executes automatic evaluation; a manual
   host must not silently send that request. No invented unit scores.
3. Persist assistance on the server before returning hints/reveals. Remove initial
   reference downloads and mutable current-row solution fallback; keep harmless
   clarification separate and unknown help abstaining.
4. Complete paper, solve, rejudge, probe and ingestion boundaries, including serve
   before response, whole-member grouping, paper feedback release, paid claims,
   frozen rejudge input and published ingestion input before evaluation.
5. Complete UI restoration/interaction fixtures and API/DB tests. Current old
   advice/submit fixtures are not acceptance evidence for the new mandatory input.
   Add native slot layout, subset evidence targeting and pending/manual behavior;
   preserve all previous meaningful assertions during fixture migration.
6. Rewrite registry/source census only when its claimed runtime callers are
   actually migrated, then complete local gates, independent review and exact-head CI.

The baseline still reports the original eight legacy dispositions. One advice
implementation has been changed in this unshipped branch; the other consumers
and publication evidence are intentionally not marked done from a partial edit.

## 22:02 UTC local checkpoint (unshipped)

The native request branch now reaches the actual solo HTTP commit handler.
Preview returns a CAS intent and commit verifies/reuses the sealed candidate;
unknown IDs cannot dispatch a model. Direct first commit expects the empty head,
so omission of an intent cannot silently replace a later regrade. A stable
`experimental:assessment_attempt` event captures participation without a fake
right/wrong bit or FSRS snapshot. Activation and the first capture share a
transaction; duplicates preserve the first capture and learning occurrence.
Explicit self-report uses unresolved scoring and updates FSRS only.

Assistance is written before hint/reference disclosure and snapshotted in the
submission receipt under its issuance lock. Unknown help abstains, verified
harmless clarification remains independent, and later help cannot rewrite an
accepted response. Tutor sessions bind their issuance in the existing start
receipt and read frozen question/reference bytes. New publications retain
per-part reference originals as private `sol_` materials. Old revisions are not
rewritten and a missing frozen solution returns null rather than current-row
fallback. Ordinary practice detail no longer includes reference/rubric/metadata.
The solution endpoint currently rejects container and intervention diagnostics;
paper release policies remain to be connected.

Native PfSolo submits its immutable input and CAS intent, supports explicit
manual practice, preserves restored evidence targets, and keeps undecided
ratings nullable. Its real interaction tests preserve process/confidence/upload
assertions and additionally verify native slot IDs and candidate binding.

Autosave integration exposed three reproducible defects: queued saves surviving
finalization, equivalent object values repeatedly counted as edits, and an older
ACK marking a newer failed save clean. All three failed before repair; all six
hook tests then passed. Host values are memoized and draft writes wait for
server restoration. These fixes belong to the same original autosave migration.

Latest checks: 61 DB across five files; 71 unit across normalizer, public DTO,
real PfSolo interactions and autosave; typecheck and production build passed.
API client and Postman spec/collection regenerated. No paid calls/deployment.
New private materials required count assertions to include the originals; all
prior public-material and per-part isolation assertions remain, with additional
private-byte checks. No independent review or exact-head CI has begun.

Still not release-ready: old non-native submit/worker paths remain; new neutral
attempt anchors need their history/failure/probe/durable consumers and native
appeal wiring. All eight entries must migrate before removing the legacy lane
and changing the registry. Model operation-key reuse only covers sealed
candidates: the next implementation must persist a pre-call claim and result so
a crash before candidate persistence cannot silently repeat a paid execution.
This is not a claim that existing candidate caching already solves that gap.

## 22:33 UTC local checkpoint (unshipped)

Persistent model claims now commit before dispatch on a separate connection.
Their operation identity binds group, submission, evaluation attempt and unit;
the immutable input digest and reserved cap prevent changed-input reuse. A
missing result after dispatch remains held with its original reservation, even
if a retry supplies a smaller cap. Sealed results survive candidate transaction
rollback. Native pi and Jev receive the claimed task-run identity. This prevents
automatic repeat dispatch; it does not claim automatic recovery of lost results.

Native appeals identify the current effective evaluation and retain the original
submission/revision/criterion. The learner objection travels as review context,
not replacement response text. Rejudge activation and its resolution receipt
share a transaction; a stale competing appeal is held before invoking a model.
The existing historical judge-event branch still awaits final entry cutover.

The real question timeline and failure readers now include neutral native
participation anchors. Their verdict comes from the current effective head,
with original/effective evaluation references kept separate from judge-event
IDs. Pending and self-report remain visible without becoming incorrect.
Pagination filters native verdicts before applying global/per-question caps.
Failure projections carry native response/evidence and revision coordinates;
legacy snapshot-dependent downstream attribution is still held rather than
reading the current question. Those attribution/tool consumers remain to migrate.

Native solve submission is now reachable through the canonical HTTP resource.
The bound session supplies stable group/key coordinates; replay reuses the first
submission. Candidate activation, participation capture, low-score learning
record and active→submitted→judged transitions are atomic. The returned solution
is the frozen original. A forced transition failure rolls back learning and
capture, while retry reuses the candidate. The old unbound session branch is
still present and must be removed with its obsolete API fixtures.

Verification: timeline regressions first failed 2/29, failure-reader regression
first failed 1/29, then the combined five-file DB run passed 101 tests (including
31 submission/entry tests and five durable-claim tests). A further native regrade
case exercises paging past five correct attempts and removing the corrected
failure. Four unit files passed 91 tests, including native/Jev review-context and
stable-run-ID assertions and neutral timeline rendering. Production build passed; typecheck caught an assignment-field typo in scoped
auto-commit eligibility, corrected to scoring_unit_ids membership, then passed.
No independent review or exact-head CI yet.
API/Postman generated artifacts include native appeal and solve coordinates.

Remaining release blockers: migrate/remove unbound solve and historical appeal
execution, durable submit/worker, paper, probe and ingestion grading; migrate
native failure-learning/diagnostic restore/tool consumers; complete hint visual
context and evidence subset selection. Registry remains honestly legacy until
all eight actual entry sites have switched. No production or paid provider calls.
