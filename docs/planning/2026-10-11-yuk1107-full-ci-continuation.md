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

## First exact-head CI failure and repair

Run 38130110481 on a72e9c2cb failed in DB shard 3. The placement unavailable-primary case observed native SUCCESS instead of ERROR, then the strict fixture guard blocked five later cases. This failed run took 247 seconds from creation to final Gate; it is not successful full-CI acceptance.

The injected unavailable-primary proxy previously closed only the socket pair carrying the lost COMMIT response and refused new connections. Its application pool permits two connections. A sibling opened before the fault could still perform the authoritative reread, making the fixture's claimed unavailability false. The fixture now destroys every socket owned by that proxy when the observed server COMMIT triggers unavailable-primary mode. Other fault modes retain their previous single-pair behavior. The terminal ERROR, unknown-outcome and no-replay assertions remain unchanged. Local r4 evidence above covers the preceding source only; the repair awaits exact-head CI and is not represented as locally rerun.

The same run passed all other lanes. Backup executed all 162 cases in 27.598 seconds on the GitHub runner, so the local 116-second file timing does not identify the current CI critical path. Passing DB shard files remained long: judge process 100.797 seconds, review recovery 85.249 seconds, session cron 75.105 seconds. The failed session recovery file took 165.225 seconds including a 60-second failure timeout. These file durations overlap; the next CI execution changes must use the hosted evidence rather than extrapolating local timings.

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

## Next critical-path source and r5 failure

PR1690 exact6e1f076024ea27cfc121d3763aaf1ec27b406058 passed Gate38130593891 in218 seconds and was squash-merged as e178690eb103ab3c064b7e6748f5b2df29b66df4. This is not120-second acceptance; the old path selector skipped native/WASM parity. The new perf/yuk-1107-ci-critical-path scope retains every command, computes the fail-closed plan in each independent job, runs code parity unconditionally, and raises the native DB matrix to eight. The physical session split preserves ten conversation, ten placement and one historical case; review setup uses a fresh clone and one SDK schema seed. Judge changes are only two50ms getResult polling options in worker.ts. No support.ts, production, normalizer, model input or original business assertion changes.

At b6f50793637b7a01af041e784f14cd8ed69855b4, initial independent review R1 found no P0/P1. Parent typecheck, changed-file Biome, policy, partition and build passed. These are source results, not runtime acceptance.

The r5 one-batch scoped run expected49 cases across seven files. It hit the390-second limit without writing complete Vitest JSON. Reported38 completed cases comprise34 PASS and4 FAIL. Judge15 passed in62.272 seconds; session cron2 passed in31.404 seconds; conversation10 passed in35.089 seconds; review cron1 passed in13.063 seconds. Review migration reported6 PASS/4 FAIL in216.714 seconds. Placement did not execute; the historical legacy case was interrupted without a final result.

The after-server-COMMIT review worker44545 reported genuine SUCCESS with three receipts/events and a complete DBOS step, then did not exit at child.stop(); the case timed out at120.050 seconds and cleanup terminated it. The existing IPC has no inner stop stages, so the exact shutdown await is unproven. Worker46769 in unavailable-primary mode exited1 with uncaught read ECONNRESET and no failure IPC; the workflow stayed PENDING with one committed receipt, while the parent spent60.802 seconds polling ERROR. The strict nonterminal guard correctly blocked the final two cases. It remains unchanged.

The final completed file was review cron at10:39:21.635Z. The next file was the historical legacy case; PostgreSQL logged EOF with an open transaction at10:39:26.318Z and10:39:33.355Z, and PID54381 was defunct at deadline. These observations do not identify the last legacy await or prove another deadlock. The two preceding review waits explain180 seconds of the batch cost; no test deadline is extended.

The minimal source repair uses bounded application-client end, stop-stage IPC and a bounded parent shutdown wait that still requires actual[0,null]. Unavailable-primary now closes its listening port before destroying all its own connections, so subsequent clients receive refusal instead of acceptance/reset; the parent waits for genuine failure IPC before retaining the original ERROR/unknown/no-replay assertions. These fixes await scoped runtime; the existing ECONNRESET stack does not fully establish its originating promise. They are not described as verified fixes.

## r5 resource-recorder failure and replacement

The r5 recorder incorrectly used org.testcontainers.sessionId; actual metadata and installed Testcontainers use org.testcontainers.session-id. The automatic cleanup therefore failed closed and retained the lock. Its original result is preserved as cleanup-auto-failed.json. Manual cleanup verified the matching token and exact session0d68ffaa2873, removed only its PG347905a2ba1ad91564d96b5497456cc088d1d0c854543f69c142254894ea22d1 and Ryuka6ef7c9051291f2feb18f984ddb7c396e5b07f883dfa6a6c787a3a34d1339605, verified79 observed PIDs absent and original four containers/release/source unchanged, then released at10:40:55.650816Z. Total465.301205 seconds was within480. Both coordinator and migration received the actual receipt.

The failed /tmp/yuk1107-r5-window.py remains unchanged. Replacement /tmp/yuk1107-r6-window.py uses one SESSION_LABEL constant and session-filter function for discovery and cleanup, identifies a newly observed container from the actual run log, includes its same-session Ryuk, excludes original IDs and foreign sessions, and persists observed PIDs every poll. Offline replay checks the actual two r5 metadata rows, installed Testcontainers label, prior/foreign exclusion and exact filter. No Docker, DB, process group or lock was operated by this check. The validated replacement is sealed as recorder-replacement-validated.py with its digest and offline output in recorder-offline-final.json; this supersedes the earlier derived recorder digest. All original artifacts remain.

Migration fixed403 has the next runtime window. This lane stays static until a new coordinated window. Next acceptance remains all49 affected scoped cases and exact-head hosted complete CI including actual native/WASM parity within120 seconds. Existing YUK-1107 owns the follow-up; no duplicate issue or independent third review is opened.

## r6 scoped acceptance

The next coordinated window fixed c4f452a02be2e21e983974ebe432b3d2ff7c1fbb and ran only the authorized four files. All22 cases passed: review migration10, review cron1, placement migration10 and historical legacy1. Vitest and outer batch both exited0 with no timeout. File times were38.013,13.397,59.751 and26.336 seconds; batch test plus teardown wall time was162.205696 seconds. Normal lost-COMMIT workers recorded SUCCESS and actual[0,null] exits; unavailable-primary recorded genuine unknown/ERROR without the previous uncaught ECONNRESET. The strict guards and original business assertions passed. This is scoped22-case acceptance, not49 allPASS or fullCI120-second proof.

The actual new Testcontainers session was6bd0f987eeaf, discovered from its own PG and Ryuk metadata. Automatic cleanup briefly failed with Docker's rw-layer-snapshot-not-found error, preserved in cleanup-auto-failed.json. A subsequent actual session filter was empty, so no additional container stop/remove was used. Parent verified all65 observed owned PIDs and PGID768 absent, original four service ID/Image/Names/State/Ports equal, original release digest equal, and fixed source head/hashes and owner token unchanged. Actual token/parity release was11:03:28.399496Z,233.228110 seconds after10:59:35.171386Z, within480. Both coordinator and migration were notified. No runtime or lock remains.

All r6 evidence is retained in .cache/cron-speed-evidence/window-20261011-r6: seal.json, source.json, db.raw.log, db.exit.json, db.vitest.json, fixture ledgers, recorder-used.py, recorder-offline.json, resources-before/clean.json, testcontainers-clean.txt, cleanup-auto-failed.json and final cleanup.json. The failed r5 records remain unchanged.

Parent then normally integrated origin/main79825bb6d. No task-owned fixture/workflow source changed in that merge; support.ts is copied exactly from current main and was not authored by this lane. Final integrated static/build validation and exact-head hosted full CI including actual native/WASM parity remain required. No new local batch or third independent review is launched.
