# YUK-1355 paid-effect backup contract

Source base: `90f95b57d4fcb08e36fa7a782abffa3d7966d5cc`. This checkpoint fixes the
backup reverse-lockstep failure reported by PR #1698 CI run `38141711556`. The
original failed logs remain separate from the offline checks below. Actual DB
backup/restore acceptance is **UNRUN** and belongs to the parent window.

## Contract and source delta

Backup schema `4.26` includes whole rows from `paid_effect_control` and
`paid_effect`. The final export/restore order is control, effect, then
`provider_attempt`. Neither paid table has a hard FK to the other; restoring the
owning backend/generation first follows their production admission dependency.
Provider attempts retain their existing last position.

Both keys must be present as arrays in `data.json`, including empty arrays. A
missing key returns `400 data_validation_failed` before the destructive restore
transaction. Existing row/column/unknown-table checks remain intact. An old
manifest still returns `400 schema_version_mismatch`; there is no implicit
upgrade. The new required-key preflight is in
[archive.ts](../../src/server/export/archive.ts), and the version/order are in
[constants.ts](../../src/server/export/constants.ts).

The restore transaction, whole-row INSERT binder, paid-effect store/control,
unknown policy, receipts, SQL and feature policies are unchanged.
[AST evidence](evidence/yuk1355-paid-effect-backup/contract-preservation.json)
records eight identical archive functions. The ninth, `restoreFromArchive`, is
identical after removing exactly the two added required-payload statements. The
protected files also match the base byte for byte.

The fixture uses `paid_effect.$inferInsert` and complete real schema rows.
Production column validation derives from Drizzle's table definitions. Export
uses the existing `SELECT *` path; restore uses the existing value binder. This
proves the source mapping and preserved code, but does not prove Postgres
JSONB/timestamp round-trip values. That requires the prepared DB cases.

## Prepared DB cases

The new [paid-effect-backup.db.test.ts](../../src/server/export/paid-effect-backup.db.test.ts)
has three cases. All enter actual `buildBackupArchive`/`restoreFromArchive` with
the real test DB. Only external R2 uses the existing `memR2` helper. There are no
internal mocks, spies, call-count assertions or parameterized case permutations.

| Case | Invariant and observable proof | Different failure mechanism |
| --- | --- | --- |
| Whole-row round-trip and unknown send hold | One archive contains pending, sending, unknown, receipt_ready and applied rows, plus explicit pg-boss generation 17 and DBOS generation 29. Exported complete rows and restored ledger must match. Real `reservePaidEffect` transactions must hold the restored unknown at the same identity and across a new revision; the original rows/owners remain intact and the new revision has no send owner/fence. | Omitted or rewritten durable rows could bootstrap ownership or reopen a paid send. The two reservation checks exercise state hold and the distinct entity gate within this recovery invariant. |
| Missing required payload before wipe | An otherwise empty 4.26 archive omits both paid keys. Restore returns both missing-table issues and preserves the complete live canary ledger. | Current-version payload omission would otherwise look like an empty table and erase paid truth. The same-path omission permutations are merged into one case; the source filter independently checks each required key. |
| Old version before wipe | A complete archive changes only its manifest to 4.25. Restore returns the exact version mismatch and preserves live rows, including a target-only explicit owner. | A manifest mismatch could bypass the strict version barrier even when the payload is complete. |

These are **three prepared cases, zero DB cases executed**. State values share
one lossless round-trip fixture; they are not five separate test branches.
Existing backup unit fixtures and assertions are unchanged.

## Offline source gates

Node `24.19.0`, pnpm `11.13.1`. The
[check receipts](evidence/yuk1355-paid-effect-backup/checks.json) pin commands,
logs, source hashes and the original CI log hashes.

- Scoped backup-import unit: **2/2 PASS**, including archive module import.
- Typecheck, lint and build: **PASS**. Lint retains 172 existing warnings;
  build retains existing bundle warnings.
- Capability boundaries: **428/0/48**, unchanged baselines/auditors.
- Architecture deepening and test partition: **PASS**; partition is
  72 unit / 213 DB / 1 migration files.
- Test policy against the pinned base: **3 new cases checked, no errors**.

Product delta is **+26/-2 lines**, net +24. New test is **266 lines**, three cases.
The DB partition adds one line. Documentation/evidence is counted separately in
the commit diff. No other PR #1698 tests changed.

## Parent DB window

Run the prepared bearing proof at the delivered fixed head with Node 24:

```bash
PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH \
  pnpm vitest run --config vitest.db.config.ts \
  src/server/export/paid-effect-backup.db.test.ts
```

If the parent includes existing backup compatibility coverage in that window,
the adjacent files are `src/server/export/provider-attempt-backup.db.test.ts` and
`src/server/export/subscription-backup.db.test.ts`. They were not executed here.

This checkpoint does not claim actual backup/restore, CI recovery, runtime exit
or deployment acceptance. Earlier DB05/06/07/08/09 receipts retain their own
counts and limits; they are not combined into a clean backup PASS. No new
independent review round or Linear operation was started.
