# YUK-1359 restore parity and same-target reopen: parent acceptance

The parent completed run11 against two fresh disposable PG16 databases. Capture, full logical restore parity, independent target identity checks and actual DBOS review-housekeeping reopen passed. This closes the scoped helper/housekeeping restore proof. It does not complete YUK-1359, migrate every task family, accept judge/provider behavior, or deploy anything.

## What is delivered

The existing backup and restore entrypoints now bind a custom dump to one coherent, writer-free source observation and compare all non-system schema/table content and sequence state after restoration. A successful `pg_restore` alone cannot set the full verified flag. Failed collection/comparison exits nonzero; historical limited receipts remain limited. The mandatory `pg16-column-text-sha256-multiset-v2` algorithm handles logical array types without treating inherited declaration dimensions as runtime value changes. Row values, array bounds/order/NULLs and sequence `is_called` remain checked.

The retained scratch option exposes only an explicitly requested loopback endpoint and records exact ownership/identity. It allows recovery acceptance on the database that actually passed restore parity. Capture maintenance evidence distinguishes stopped external host workers from container execution; neither self-reported quietness nor a borrowed restore receipt is sufficient.

## Evidence layers

| Layer | Evidence and scope |
| --- | --- |
| Independent source review | R1 found scratch TCP authentication P1; R2 at887012 resolved it with no remaining P0/P1. [R1](2026-10-09-yuk1359-restore-r1.md), [R2](2026-10-09-yuk1359-restore-r2.md). R2 does not cover the later array delta; no third review was opened. |
| Later array correction | Parent194 scoped unit and14 real PG tests passed, including dump/restore, actual arrays/domains/enums and corruption negatives. [Evidence](evidence/2026-10-10-yuk1359-parent-array-parity.json). |
| Acceptance driver | Parent reran558 inherited checks,43 protocol groups/299 splits,29 postkill groups,114 logical-schema groups and2 source checks; all passed with zero socket/listener/worker attempts. Separate original-causality9groups/112splits remain explicitly simulated. |
| Bound artifacts | 3,029 source files,3,076 evidence files,121,549 dependency files and3,756 links matched; post-suite source/evidence recheck passed before run11. Worker7472/helperb52e executables stayed unchanged. |
| Actual restore | Four non-system schemas,123 tables and5 sequences compared equal; no missing/extra/mismatched entries or environment differences. The parent observed helper exit0 and `verified:true` on the actual retained target. |
| Actual reopen | On that target, the pending task progressed from1 to3 effects/receipts, exactly2 new. Completed and unknown work remained unchanged; unknown ERROR and2 missing receipts persisted. The source raw seal remained unchanged. |
| Release/deployment | No production change or provider call. Both owned PGs stopped and retained; original four service identities/start times/health, running set and release hash matched. |

The mixed offline granularity sums to1,045 checks/groups/cases; it is not1,045 DB tests or a whole-system proof. The driver uses recorded source data and simulated boundaries for offline path tests; run11 is the separate real observation.

## Run11 identity and causal chain

- Parent candidate: `fc2956efd6b3d497446c3a58b5ecf47afd4f61ee`.
- Fixed worker source: `7472f4395f4a12a5167e33034d5d8af8bf695049`; worker SHA256 `4e2ec8ace103cf535c3472f2f2c4611438d8cfe5a6f14a1c65abe272674824a9`.
- Fixed helper source: `b52e255f746ebbf6a4f2f44ae06e7d1b672a4fff`; executable SHA256 `f257a7c86e88dc78e9fa54afedf3e669ba38f55ed4bf953ea54c8ce826d66606`. Capture records the current checkout revision separately; it does not change the bound executable.
- V6 source seal: `30242997a5cb79d6e7ec6ed6ff7023a2c33eef7e31475798f5b180a0b1ac43b6`; evidence seal `4a1173c2a6c6861f439d4f9fb3d691d33084d1e7117cb7cdf31d1db72aac2fad`.
- Mutex: `b3cfc9b3-4c72-4103-9876-8b4577bfe904`, held2026-10-09T18:56:16.100290Z through19:04:18.417981Z. Owner7631 notified Start owner5796 on acquisition and release.
- Source: `3126274e993fd105391f6efb7ef41f34611bc2e4abe51a6ef221448bdbfc5e08`, loopback32791, `test_fork_20261009185632`;118 migrations applied.
- Restored target: `b95be584c29a11123208e677201fc4b3e92fc5f9b9aef7f78285514dbedc7316`, loopback57325, `test_fork_20261009190006`.
- Dump SHA256: `a093020948030f660066a03a11491eab4be0c2d448a93d108d20cd34bebfbbb6`.

Source workers39902/39904/39906 respectively completed, encountered the identity-bound COMMIT outage, and reached the first-row/draining boundary before SIGKILL. The unknown path withheld target COMMIT completion and prevented other application connections from resolving its uncertain outcome. Exact backend observations established pending-worker connection settlement after OS exit under the operational exclusion boundary; this is not an OS socket-attribution claim. All owned workers and proxies were gone before capture.

The helper restored the captured dump once. Independent Docker/inside/host observations bound the successful receipt to the same retained database; no second restore, rename or migration was used. The parent sealed restored prelaunch state, refreshed actual ownership and no-client observations, launched the fixed recovery worker on that target, then compared resulting receipts/effects, terminal evidence and source state. The worker exited and all observers closed before cleanup.

## Preserved failures and fixture correction

Run01–10 remain failed historical attempts and must never restart. Run10's canonical full restore parity was successful, but its PREP prelaunch check compared physical `ordinal_position` gaps left by dropped columns. Run11 uses a bounded PREP-only logical visible-column comparator at cross-database checks. It preserves names/order/types/defaults/nullability/strict membership and raw snapshots; same-endpoint comparisons remain exact. All other gates and worker/helper bytes are unchanged. The old prelaunch and reopen assertions reproduced RED on saved run10 data; new negative cases reject real drift.

[Run11 evidence manifest](evidence/2026-10-10-yuk1359-parent-restore-attempt11.json) binds79 files. [Compressed evidence](evidence/2026-10-10-yuk1359-parent-restore-run11.tar.gz), SHA256 `a99118ab180eaa4f450797845b5f55654dbc25afea26cc18b79a3bbd679cbe69`, includes synthetic-only dump, helper receipts, source/target snapshots, causal lifecycle evidence, parent witnesses and offline reports. Text entries were checked for credential-bearing database URLs, provider/GitHub tokens and private keys before packing. Parent operations remain at `/tmp/yuk1359-restore-reopen-parent11`; fixed preparation remains `/tmp/yuk1359-dbos-restore-offline-prep-v6`.

## Final local gates and remaining delivery

Fresh fetch found origin/main04232 already contained in this branch, with no integration needed. Parent reran194 scoped unit tests across4 files, typecheck, full build, full lint and10 post-build audits; all exited0. Lint retains290 existing warnings. Product/helper and test paths are byte-identical to b52e. [Gate log bindings](evidence/2026-10-10-yuk1359-final-local-gates.json). No complete local test suite was run. Exact-head CI remains the next gate after push; historical source review, DB and runtime evidence retain their exact revisions. Judge-specific DBOS restore/reopen, provider actual-output, remaining task families and old SPA/pg-boss retirement stay under existing YUK-1356/1355/1358/1359 obligations. No duplicate follow-up issue is needed for this completed helper acceptance repair.
