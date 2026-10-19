# YUK-1567 — Cancel Unsent Paid Intents — Test Text Plan (prose only)

Per owner rules and this slice's constraints: **no test file is written or modified
here**. This document is the approval-required textual plan. Two parts: (A) the
mechanical version-sync edits the existing backup test needs after the 4.30 bump;
(B) the real-DB-copy acceptance scenarios for the cancel path. Nothing below is an
assertion script; each item states the setup, the operation, and the expected
observable evidence.

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

2. **Same-request replay.** Re-run `apply` with the identical manifest. Every
   target returns `already_cancelled` with the stored receipt; the cancellation
   table still holds exactly one row per identity; `cancelled_at` unchanged.

3. **Altered-request-id replay.** Change only `request_id` in the manifest and
   re-apply. Each target fails with a `PaidEffectCancellationError`-class message;
   no second event row; row state unchanged.

4. **Race with a send claim.** On a copy, start a transaction that claims the
   target's send (hold it open), then run `apply` for that target from another
   session — the apply target must fail (state not `pending` or eligibility
   refusal), never cancel a live send. Then invert: commit the cancel first, then
   attempt the claim — the claim must observe `cancelled` and refuse to send
   (`held`-class outcome); no provider invocation occurs in either direction.

5. **Refusal matrix.** Seed/copy variants and confirm each apply target fails
   with its row unchanged and no event row:
   `sending`/`unknown`/`receipt_ready`/`applied`/`voided` states; `pending` with a
   non-NULL `delivery_id` (or lease/result/application column); `expected_fence`
   one behind the live fence; a missing row; a target that is the bound successor
   of a `paid_effect_authorization` row; a live `created`/`retry`/`active`
   `pgboss.job` of the family referencing the entity; a `pending`/`claimed`/
   `retry_wait` `event_subscription_delivery` referencing the entity; a watched
   `action` event with no delivery row.

6. **Event/transition atomicity.** Force the event insert to fail (e.g. pre-create
   a `paid_effect_cancellation` row for the identity on the copy) and apply. The
   target transaction rolls back: `paid_effect` row stays `pending`, fence
   unchanged — no cancelled state without its event exists.

7. **Idempotent partial batch.** Make one of two targets ineligible (e.g. give it
   a live job) and apply the two-target manifest. Result: the eligible target
   settles `cancelled`, the other records `failed` with its failure list, exit
   non-zero; re-applying the unchanged manifest settles cleanly
   (`already_cancelled` for the first once the second becomes eligible, or a
   clean refusal).

8. **Backup/restore round-trip.** On the copy, export the archive and restore it:
   the `paid_effect_cancellation` rows and the `cancelled` rows' receipts survive;
   the manifest reports `4.30`; an archive lacking the paid payload key is
   rejected before any wipe (existing strict behavior, now covering the new key).

9. **Consumer dead-end.** On the copy, drive the admission reconciliation for a
   cancelled identity: it must hold (no send, no receipt minted). A reauthorization
   plan over an entity whose history contains cancelled rows proceeds treating
   them as resolved history — and a cancelled row can never be voided (the void
   path accepts only `unknown`).

## C. Invariant mapping

Scenarios 2–4 and 6 map to the AGENTS.md concurrency/lock + data-irreversibility
invariants (CAS, advisory serialization, atomic event, immutable receipt);
scenario 8 maps to the restore invariant. If any of these are later implemented as
real tests, each must declare its `@invariant`/`@fails-if` and run in the DB lane —
approval for that code is a separate decision, not part of this slice.
