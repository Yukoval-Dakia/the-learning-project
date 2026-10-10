# YUK-1355 actual cron supplement

Scope: only `prune_job_events`, in the exclusively owned `tlp-yuk1355-dbos-migration` worktree starting at `066f427fff7dda4fbd679b92186c3fb7fdeb4573`. This supplements the original acceptance evidence. It does not complete the other 67 task families, introduce another review round, or address the deferred P2 shutdown-pending timeout and same-process stop/start registration concerns. Parent owns final issue state, review of the new P1 fix, CI and runtime acceptance.

## Actual producer and effect observations

`tests/dbos-prune/cron.db.test.ts` runs the installed DBOS 5.2.11 and pg-boss 12.26.3 in two separate bundled worker processes. The DB test config always starts a new Testcontainers PostgreSQL 16 container and applies the real migration journal. The cron test clones its freshly migrated `test` template into an additional unique numeric `test_fork_*` database, preventing contamination from any reused Vitest fork. It never accepts a runtime, candidate or existing external database. Container teardown destroys the disposable databases.

Production uses `0 4 * * *`, `Asia/Shanghai`. The fixture uses `* * * * *` in the same timezone; OS, JavaScript and PostgreSQL clocks are unchanged. The fixture enables the real pg-boss timekeeper with one-second monitor/forward polls and uses 50ms application reconciliation, versus the production worker's 15-second reconciliation. The SDK's dynamic scheduler, jitter, database schedule polling and internal workflow queue remain unmodified. This is accelerated minute-cron evidence, not a wall-clock observation of production's daily 04:00 run. pg-boss supervision is disabled in the fixture; expiry/retry supervision is outside this cron scenario.

The only controlled boundaries are the database adapter immediately before the real timekeeper target INSERT, `offWork` of the legacy consumer until a new draining worker boots, and the existing DBOS callback after the business/receipt transaction commits. These preserve real production calls and their real payloads. No cron trigger API, manual prune send, clock simulation, synthetic schedule tick or queue replay supplies the observed prune tasks.

Test-only PostgreSQL audit triggers record inserted job identities, state transitions, phase transitions, receipt writes and every business DELETE statement, including zero-row deletes. Their transaction IDs, timestamps and backend PIDs are retained. Full child stdout/stderr and IPC observations are part of the JSON artifact. `__pgboss__send-it` completion after a failed forward is explicitly distinguished from completion of a prune job.

The scenario observes:

1. A real initial SEND_IT tick is forwarded into a prune task while its consumer is stopped. `draining-pg-boss` blocks cutover until a newly booted worker consumes this exact task and deletes the old synthetic event.
2. Another real cached tick forwards only after DBOS cutover. The database producer fence rejects its actual INSERT. The SEND_IT row remains observable and completes under pg-boss's existing all-settled forwarding behavior; no prune task is admitted from it.
3. A third real pre-cutover tick waits in SEND_IT and is held by whichever worker actually fetches it. It is released only after rollback, testing a cache retained across both transitions.
4. Two real DBOS scheduler processes share the schedule. The native minute workflow identity, scheduled inputs, PENDING status, one receipt and its matching cutoff are observed. Receipt commit alone does not allow rollback; draining blocks until this workflow becomes SUCCESS.
5. Phase returns to pg-boss while both schedules stay paused for the recent DBOS tick's 60-second lookback. The late cached forward completes without another DELETE; a newly inserted old event survives it. A subsequent real cron minute restores pg-boss production and removes that event.
6. Every observed effect minute has at most one DELETE statement. The expected total is one legacy drain, one DBOS commit and one later rollback tick. Every admitted legacy INSERT occurs in pg-boss phase. An unrelated failed task with an unknown external outcome retains its payload, failed state and retry count. No queue is cleared or blindly replayed.

## P1 found by this acceptance test

The [RED artifact](2026-10-07-yuk1355-prune-cron-red-evidence.json) records a strict assertion failure against the starting production sources: at `2026-10-07T13:14:00Z`, one DBOS DELETE and one rollback pg-boss DELETE occurred in the same minute. DBOS workflow `sched-prune_job_events-2026-10-07T13:14:00.000Z` had already committed its receipt. Restoring pg-boss immediately re-enabled the same cron point, which its `Timekeeper.shouldSendIt` accepts while `prevDiff < 60`. Thus the former constant `doubleSchedule: false` did not establish the original no-double-run acceptance requirement.

This P1 acceptance blocker was reported to the parent before the business change. The minimal fix adds `hasRecentDbosPruneReceipt` and checks it while reconciling the old schedule and executing the current legacy consumer. A receipt's cutoff is exactly 30 * 86400 seconds before its scheduled tick; the database-clock comparison includes pg-boss's additional 60-second lookback. Both checks run under the existing control-row transaction lock. No schema/migration, queue deletion, recovery owner or other task family changes. A late cached job may still be admitted once phase is pg-boss; the guard suppresses its duplicate business effect within the recent tick window. A pre-migration binary's consumer does not have this guard and is not admitted as a rollback binary.

The RED artifact includes its test/fixture source snapshots, exact base revision and source/bundle digests. Its `passed: false` is intentional. The old process artifact now explicitly labels its unobserved cron scope and no longer contains the misleading constant.

## Final local evidence

The [GREEN artifact](2026-10-07-yuk1355-prune-cron-green-evidence.json) has `passed: true`. The exact original legacy task is `c7c8d0f9-1c6b-46ce-9990-3232b9465e42`; cached tick `3a4d06b7-70eb-41fd-8428-894e278887a1` is rejected after cutover; cached tick `ec57fdf1-b7ec-467e-9623-eb3ff51f4012` is forwarded after rollback without a duplicate business effect. The one DBOS receipt belongs to `sched-prune_job_events-2026-10-07T13:21:00.000Z`. Business DELETE statements occur once in each of `13:20Z` (legacy drain), `13:21Z` (DBOS) and `13:22Z` (restored pg-boss). There are three completed legacy tasks, including the cached task with its suppressed effect, one DBOS receipt, and zero admitted legacy INSERTs outside pg-boss phase. This is observed execution evidence, not a boolean assigned from schedule registrations.

Worker PIDs `66293` and `72973` both exited with code 0, signal null. A subsequent process check found neither running. The successful Vitest invocation completed the test-container teardown. All eight GREEN source/vendor/bundle hashes were compared to the files used for this run. RED source snapshots were compared to their stored hashes, and RED production/migration source hashes were compared to base `066f427fff`. The CJS bundles target Node 24; the test runner and child processes ran on host Node 26.10.0, not a production app image.

Final commands and results:

- `TLP_PRUNE_CRON_EVIDENCE_PATH=/tmp/yuk1355-cron-final-evidence.json TLP_PRUNE_EVIDENCE_PATH=/tmp/yuk1355-cron-regression-evidence.json pnpm vitest run --config vitest.db.config.ts tests/dbos-prune/cron.db.test.ts tests/dbos-prune/migration.db.test.ts`: **4 passed, 2 files**, 251.12 seconds. This includes the original three cutover/recovery scenarios. No full `pnpm test` was run.
- `pnpm typecheck`: passed.
- `CODEX_FULL_GATE=1 pnpm lint`: passed, zero errors and the unchanged 297 warnings. The first lint attempt found only formatting errors in two evidence JSON files; both were formatted before the final pass.
- `pnpm lint:ratchet`: passed, 297 warnings within the existing 305 ceiling. No baseline changed.
- `CODEX_FULL_GATE=1 pnpm build`: passed, including web/server/worker/migrate bundles.
- `git diff --check`: passed.

Raw logs: `/tmp/yuk1355-cron-red-db.log`, `/tmp/yuk1355-cron-final-db.log`, `/tmp/yuk1355-cron-typecheck.log`, `/tmp/yuk1355-cron-lint.log`, `/tmp/yuk1355-cron-ratchet.log`, `/tmp/yuk1355-cron-build.log`. The versioned RED/GREEN JSON includes complete worker logs and database observations; the regression artifact remains `/tmp/yuk1355-cron-regression-evidence.json`. An intermediate attempt expected immediate schedule restoration and failed after the fix correctly kept it paused; the final test explicitly observes that cooldown and the subsequent real tick.

## Limits and handoff

This proves the recorded real producer interleavings and receipt/effect counts for one deterministic housekeeping family. It is not an exhaustive proof of all timing, host reboot, restart-after-shutdown, old-binary rollback, production daily cron, other families or provider outcomes. No paid calls, main runtime, existing external DB, deployment, new review, delegation, push, PR, watch or merge were performed. The deferred P2 concerns remain recorded without remediation or a new review round. No new standalone follow-up was discovered beyond the P1 fixed within YUK-1355 and those already parent-owned concerns; tracker updates remain parent-owned.

After the local YUK-1355 commit, this test agent releases writer ownership. No fixture worker remains active; parent may take over the worktree and assess the two production-source changes against the captured P1 evidence.
