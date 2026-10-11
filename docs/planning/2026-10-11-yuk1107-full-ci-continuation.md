# YUK-1107 full CI continuation

The full CI target is 120 seconds. This revision removes real-time waits and repeated setup from retained fixtures. It does not change product cron behavior or reduce the retained case set. Full exact-head CI timing remains pending.

## Scoped acceptance

The parent ran the frozen source in the coordinated r4 window on 2026-10-11. Local Node was 26.10.0; CI uses the pinned Node 24 release, so these measurements do not prove GitHub CI duration or a controlled before/after speedup.

| Scope | Passed cases | Vitest result interval, ms |
| --- | ---: | ---: |
| prune cron | 1 | 16963.278 |
| review-orphan cron | 1 | 11161.942 |
| session-orphan recovery | 21 | 74986.237 |
| isolated runtime | 1 | 91.083 |
| backup CLI and manifest | 162 | 115652.125 |

The four DB files ran serially with one worker and exited 0, Vitest 116.69 seconds. The backup file exited 0, Vitest 116.18 seconds. The table uses each JSON testResult endTime minus startTime; it is not summed parallel CI latency. All 24 DB and 162 unit cases passed, with zero failed cases. Backup remains a long file despite bundled CLI startup and accelerated injected identity deadlines.

## Changes and preserved behavior

Prune and review fixtures clone a freshly migrated database, retain native workflow and admission/receipt history, and inject application SQL time only into the disposable fixture. Their PgBoss clocks follow the same logical time. Real SDKs, Timekeeper forwarding, producer fencing, duplicate owners, drains, receipts, business deletes, and exact rollback boundary assertions remain. Prune arms both native SDK schedulers for one common future calendar occurrence after seeding its marker. Review rollback waits for a genuine Timekeeper-forwarded job and checks the review family schedule.

Session recovery seeds its genuine DBOS system schema once per file instead of once per case. Every actor and parent query uses the same fixture-owned database. The TCP COMMIT fault proxy disables Nagle buffering without changing packet-loss points. All 21 cases still exercise their real crash, SIGSTOP, unknown outcome, non-replay and duplicate-owner contracts. Shutdown awaits the child exit pair [0, null]; bounded application-client close and stop-stage diagnostics address the observed completed-workflow shutdown hang.

The isolated-runtime fixture advances the SDK TestClock by 65 seconds and compares all actual PgBoss tables except the fixture clock row. The real disabled-automation configuration and explicit send/fetch/complete path remain.

Backup compiles the real CLI once, then executes each CLI case in a separate process with its intercepted transport and network traps. Only its exact injected 15-second identity and 2-second close deadlines are accelerated. Canonical temporary paths preserve the ESM CLI entrypoint on macOS. All 49 source registrations expand to the retained 162 runtime cases.

## Review and cleanup

R1 found admission evidence being deleted while native SUCCESS rows survived. A fresh fixture clone and removal of ledger TRUNCATE repaired it. R2 found that manual review rollback enqueue did not prove Timekeeper behavior, and that prune recurring native points could race exact-one assertions. The parent repaired both and ran the final r4 artifacts. No third review was started; the final clock, realpath and shutdown delta is parent-tested, not represented as part of the earlier static review snapshot.

Raw evidence is retained under the worktree .cache/cron-speed-evidence/window-20261011-r4: source.json, db/unit exit and Vitest JSON, raw logs, prune/review/session ledgers, resource snapshots and cleanup.json. Earlier failed r3 artifacts remain separately retained and do not count as successful timings.

Cleanup verified all 59 owned child PIDs absent, the owned Testcontainers session empty, original four container ID/Image/State/Ports equal and the original release-file digest unchanged. Only the matching owner token was released. Actual release was 2026-10-11T09:47:59.444858Z, later than the 09:38:08Z plus eight-minute window. Runtime batches ended around 09:44:21Z; cleanup overran the window. This timing error was reported to both coordinator and migration lane. The migration lane has priority for the next window. No new local runtime batch, deployment, TEST data change or provider call is authorized by this evidence.

## Remaining acceptance

Latest full green baseline 38122365986 at 148cf4bd took 432 seconds from run creation to final required Gate completion. The prior session-cron delivery run took 390 seconds on another revision. Neither is a controlled speedup comparison. Current fixture acceptance does not close the full target. Next measure the complete exact-head CI and remove its remaining execution and dispatch costs while preserving all test, audit, build, migration and parity obligations. This is already owned by YUK-1107; no duplicate follow-up issue is created.

## Frozen source digests

```json
{
  "tests/dbos-session-orphan/migration.db.test.ts": "a0141e97d5461e82c1a93ecb0fe829c3c571295b1b7d745da468ff7b8057ea41",
  "tests/dbos-session-orphan/worker.ts": "250a4166f9f3d6a062ea78676d4d2f7e91136a6cc2dd8aeaf9bd376fb53ae665",
  "src/server/boss/isolated-runtime.db.test.ts": "d5b1f2a12856f3b7d60b3aac43da31f81f1d6a9068cfa852f548712d71bee77b",
  "scripts/cutover-backup.test.ts": "0c4c2a9f191ad6ca8f079970a552c0eeae1562cbd218c1471973ef8c2c58d89c",
  "tests/dbos-prune/cron.db.test.ts": "a4d8864998ece69e354d3d6c560ee45d4f57d8421dd5512fbadbaf0b98434601",
  "tests/dbos-prune/worker.ts": "45c828be9e827e545c9522c24fb4a95bd6e8f0e58a194512ad5d4efbc8775cea",
  "tests/dbos-prune/fixture.ts": "d2dbcd99157a6e0ff5191175f7c62bb28ba700605cf8a1fa18c522366e900a1d",
  "tests/dbos-review-orphan/cron.db.test.ts": "1a703c0f2ae984efb2db4dc1a51d4cf5d1910e5b30e02d4225111f9831d207a1",
  "tests/dbos-review-orphan/worker.ts": "f89e3566a13ebb8ee9281546520c0bbb1ee7e654428437ec857a398ed95d3d5f",
  "tests/dbos-review-orphan/fixture.ts": "956e2af14c79b03932fa71f48614ceca4e9fac4a7e0199eab1cddfc651cf65b0"
}
```
