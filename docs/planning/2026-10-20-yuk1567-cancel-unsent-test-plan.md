# YUK-1567 — Cancel Unsent Paid Intents — Test Text Plan (prose only)

Per owner rules and this slice's constraints this document remains the
textual plan, not test code. Status of its two parts: **(A)** the mechanical
version-sync edits below were APPROVED by the coordination line on
2026-10-20 under the owner10-19 standing list authorization and applied
verbatim to `src/server/export/paid-effect-backup.db.test.ts` in commit
`902b266a0` (three line sites only — no case added, removed, or reshaped, no
fixture touched); **(B)** the real-DB-copy acceptance scenarios remain
UNAPPROVED text — no assertion or script may be written from them yet.
Nothing below is an assertion script; each item states the setup, the
operation, and the expected observable evidence.

## A. Mechanical version sync — `src/server/export/paid-effect-backup.db.test.ts`

`SCHEMA_VERSION` moves `4.29 → 4.30` because `paid_effect_cancellation` joins
`FK_ORDER` (via `PAID_EFFECT_BACKUP_TABLES`, before `provider_attempt`). Three edit
sites, all in this one file:

1. Line ~138 — `expect(manifest.schema_version).toBe('4.29');` → `'4.30'`.
2. Lines ~139–144 — `expect(FK_ORDER.slice(-4)).toEqual(['paid_effect_control',
   'paid_effect', 'paid_effect_authorization', 'provider_attempt']);` →
   `FK_ORDER.slice(-5)` with `'paid_effect_cancellation'` inserted before
   `'provider_attempt'`:
   `['paid_effect_control','paid_effect','paid_effect_authorization',
   'paid_effect_cancellation','provider_attempt']`.
3. Lines ~263–265 — inside the `schema_version_mismatch` expectation:
   `expected: '4.29'` → `'4.30'` and the message string
   `'schema_version mismatch: expected 4.29, got 4.25'` → `expected 4.30`.

No other test changes are part of this plan. Until this sync lands, the
schema-version assertion in that file will fail against the new constant — the
sequencing (land sync before/with merge) is the parent's call. Optional extension,
only if wanted later: assert `data.paid_effect_cancellation` round-trips like the
other paid payload tables — not required for green.

## B. Real-DB-copy acceptance scenarios

All run on a **copy/restore of the deployment DB** (never the live TEST/PROD DB),
with migration `0127` applied. Each scenario states what a reviewer should observe;
none are scripts.

1. **Happy path, two approved targets.**
   Seed/copy the two approved `pending` rows (fence 0, all send columns NULL).
   Run `plan` → every target `eligible: true`, `observed` matches the row.
   Run `apply` → receipt shows `kind:'cancelled'`, `fence:1` per target.
   Verify: `paid_effect` rows now `cancelled` with `cancelled_at`/`cancel_json`
   populated and `input_json` byte-identical; exactly one
   `paid_effect_cancellation` row per identity carrying request/operator/reason/
   basis/`previous_fence:0`; the state-shape CHECK accepts the rows; the
   historical `unknown` siblings are untouched; `listPaidEffectObligations` no
   longer surfaces the two identities.

2. **Same-request replay.** Re-run `apply` with the identical manifest AND the
   identical frozen plan (`--plan` + the recorded `--plan-sha256`). Every
   target returns `already_cancelled` with the stored receipt; the cancellation
   table still holds exactly one row per identity; `cancelled_at` unchanged.
   Also cover the crash window: delete/lose the receipt artifact between commit
   and file write, re-run with the same manifest and plan to a new `--out`
   path — the stored result must come back, not a failure.

3. **Divergent replay.** Change only `request_id` — or, separately, alter
   `reason`/`operator`/`basis`/`expected_fence` while keeping the same
   `request_id` — and re-apply. Each target fails with a
   `PaidEffectCancellationError`-class message; no second event row; row state
   and receipt unchanged. A borrowed request id must never launder a mutated
   request.

4. **Frozen-plan authorization.** Variants that must refuse BEFORE any
   database connection or target write, with nonzero exit and an error naming
   the divergence — zero rows touched, no cancellation event: (a) `--plan` or
   `--plan-sha256` missing/malformed; (b) `--plan-sha256` not equal to the plan
   file's raw-byte digest; (c) a plan whose `manifest_sha256` does not bind the
   presented manifest — including a manifest edited to append, replace, or drop
   a target while reusing the original `request_id`; (d) a plan whose
   (identity, expected_fence) multiset diverges from the manifest's even by one
   member; (e) a plan recording any `eligible: false` target. Reusing the
   original request id must never widen execution scope; the approved plan
   digest, not the request id, is the authorization.

5. **Race with a send claim.** On a copy, start a transaction that claims the
   target's send (hold it open), then run `apply` for that target from another
   session — the apply target must fail (state not `pending` or eligibility
   refusal), never cancel a live send. Then invert: commit the cancel first, then
   attempt the claim — the claim must observe `cancelled` and refuse to send
   (`held`-class outcome); no provider invocation occurs in either direction.

6. **Refusal matrix.** Seed/copy variants and confirm each apply target fails
   with its row unchanged and no event row:
   `sending`/`unknown`/`receipt_ready`/`applied`/`voided` states; `pending` with a
   non-NULL `delivery_id` (or lease/result/application column); a `pending` row
   whose live fence is not `0`; a manifest `expected_fence` other than `0`
   (rejected at parse); a missing row; a target that is the bound successor
   of a `paid_effect_authorization` row; a live `created`/`retry`/`active`
   `pgboss.job` of the family referencing the entity; a `pending`/`claimed`/
   `retry_wait` `event_subscription_delivery` referencing the entity; a watched
   `action` event with no delivery row at the declared `subscriber_version`
   (a delivery under an older version must NOT satisfy it). Separately, confirm
   manifest-level refusals before any query: omitted/empty `watch`, a watch
   triple not equal to the declared `practice.question-admission-enqueue`
   `(action, subscriber_id, subscriber_version)`, or a target family other than
   `question_admission_run`.

7. **Event/transition atomicity.** Force the event insert to fail (e.g. pre-create
   a `paid_effect_cancellation` row for the identity on the copy) and apply. The
   target transaction rolls back: `paid_effect` row stays `pending`, fence
   unchanged — no cancelled state without its event exists.

8. **Idempotent partial batch.** Make one of two targets ineligible (e.g. give it
   a live job) and apply the two-target manifest. Result: the eligible target
   settles `cancelled`, the other records `failed` with its failure list, exit
   non-zero; re-applying the unchanged manifest with the same frozen plan
   settles cleanly (`already_cancelled` for the first once the second becomes
   eligible, or a clean refusal).

9. **Backup/restore round-trip.** On the copy, export the archive and restore it:
   the `paid_effect_cancellation` rows and the `cancelled` rows' receipts survive;
   the manifest reports `4.30`; an archive lacking the paid payload key is
   rejected before any wipe (existing strict behavior, now covering the new key).

10. **Serialization-conflict fail-closed.** On the copy, engineer a concurrent
   event→delivery discovery commit that interleaves between the apply gate
   reads (or equivalently any write the serializable snapshot conflicts with):
   the apply transaction aborts `40001`, the target is recorded
   `serialization_conflict`, the row stays `pending`, no event row exists —
   then settle the ambient work and re-apply cleanly.

11. **Consumer dead-end.** On the copy, drive the admission reconciliation for a
    cancelled identity: it must hold (no send, no receipt minted). Then deliver a
    same-base/revision redelivery whose prepared input drifted (e.g. bumped
    admission generation): the fresh identity must return `held`, and no new
    `pending` row may be admitted, unless a `paid_effect_authorization` row
    explicitly binds that exact identity as successor. A reauthorization plan
    over an entity whose history contains cancelled rows proceeds treating them
    as resolved history — and a cancelled row can never be voided (the void
    path accepts only `unknown`).

## C. Invariant mapping

Scenarios 2–5 and 7 map to the AGENTS.md concurrency/lock + data-irreversibility
invariants (CAS, advisory serialization, atomic event, immutable receipt,
authorized-scope integrity); scenario 9 maps to the restore invariant. If any of these are later implemented as
real tests, each must declare its `@invariant`/`@fails-if` and run in the DB lane —
approval for that code is a separate decision, not part of this slice.
