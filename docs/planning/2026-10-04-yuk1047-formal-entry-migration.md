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
   current URL/key-era/legacy judge branch only after all actual callers move.
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
