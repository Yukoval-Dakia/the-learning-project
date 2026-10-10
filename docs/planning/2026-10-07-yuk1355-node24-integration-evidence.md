# YUK-1355 integration under Node 24 and pg-boss 12.36

This local integration admits only `prune_job_events`. The starting branch was clean at `48ead4da80c4d7c528d8e512077e9e13cc9943f2`. A normal merge incorporated the parent's fetched main `df08399ff179c5882b39da87e162237fd18246c7`, including dependency upgrades and YUK-1365 streaming, in `3e04890bb72da34ebbe5df746eab64066b119782`. The three conflicts were PLAN, handoff and lockfile. Main's complete upgraded lock graph was retained because this lane adds no dependencies; both business implementations and the latest non-UI/Agent TEST restrictions were preserved.

Final source capture commit `71d2f0cfd3301823eeb858de9a22e546c0345467` includes the actual-version fixture changes from `7a2dc29d85aa7714ca20089f99fe1bee7c310cfc` and their required import-order fix. The adjacent [seal](2026-10-07-yuk1355-node24-integration-seal.json) hashes production sources, fixtures, vendor implementations, built bundles and command logs. Its hashes apply to the tested bytes, including working-tree fixture changes before that commit. The final evidence commit changes only documentation/artifacts. Historical [Node 26 / pg-boss 12.26.3 RED and GREEN evidence](2026-10-07-yuk1355-prune-cron-evidence.md) is unchanged and does not stand in for this version's acceptance.

## Isolation and actual execution

All commands used `/tmp/yuk1355-node24-main/run.py` with an environment allowlist of HOME, USER, LOGNAME, TMPDIR, LANG, CI, NPM_CONFIG_USERCONFIG and the existing full static/build gate flag. PATH starts with `/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin`; no inherited database URL, provider secret or exporter setting reaches the commands. No `.env`, `.env.local` or `.env.test` exists in this worktree. pnpm reports 11.13.1, Docker client/server report 29.4.0. The frozen install uses this worktree's own node_modules and main's lockfile.

The DB config starts a fresh PostgreSQL 16 Testcontainers container, applies the migration journal and assigns per-worker disposable databases before application DB imports. The cron scenario clones the freshly migrated template into another unique database. Subsequent worker/registrar and migration checks own fresh containers. No existing database, service, runtime lock or private data was inspected or changed.

The [cron artifact](2026-10-07-yuk1355-node24-cron-evidence.json) and [recovery artifact](2026-10-07-yuk1355-node24-recovery-evidence.json) record the runner and all ten actual bundled fixture children reporting Node `v24.19.0`, pg-boss `12.36.0`, DBOS `5.2.11`, and the explicit Node 24 executable path. Package versions are read from the installed package JSON and included in the worker bundle's readiness message. Full child stdout, stderr, messages and exit observations are preserved. All captured source/vendor/bundle digests were compared with their files after the runs. Final lint initially found one fixture import-order error. It was corrected, lint and ratchet passed with the existing warning count, and the actual cron/recovery suite was rerun to capture the final source bytes. The earlier successful new-version run and import-order failure remain in scratch evidence; the historical 12.26.3 artifacts were never overwritten.

The actual cron scenario preserves production's timezone and uses minute cron, real pg-boss timekeeper/forwarder and the unmodified DBOS dynamic scheduler. Clocks are unchanged. Existing test barriers pause real forward SQL, the legacy consumer and the DBOS post-commit callback. No fabricated tick, manual prune send, queue replay or clock simulation supplies the observed cron jobs. Production's daily 04:00 timing is not claimed.

Recorded DELETE statements occur once at `14:04:00.807Z` in `draining-pg-boss`, once at `14:05:02.618Z` in `dbos`, and once at `14:06:02.938Z` after restoring `pg-boss`. Receipt `sched-prune_job_events-2026-10-07T14:05:00.000Z` matches the native tick. Rollback is blocked while that receipt's workflow remains pending. The recent receipt's 60-second lookback keeps the old schedule paused after rollback and suppresses the late cached task's duplicate effect. A later real minute restores production and deletes the retained late event. Every admitted legacy INSERT occurs in pg-boss phase, and the unrelated failed task with an unknown external outcome remains intact.

Cron PIDs 54670 and 57347 exit with code 0. Recovery PIDs 54676 and 54741 receive the intentional SIGKILL at business-commit/checkpoint boundaries; all six surviving recovery workers exit with code 0. Test-container teardown completes. This is phase rollback on the fixed binary only. A pre-fix or pre-migration consumer lacks the receipt guard and is not a supported rollback binary; no queue-schema downgrade was tested or admitted.

## Scoped checks

Commands below were launched through the clean runner. No full `pnpm test` ran.

| Check | Result | Raw log in `/tmp/yuk1355-node24-main/` |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | Passed; lockfile unchanged | `install.log` |
| `pnpm vitest run --config vitest.db.config.ts tests/dbos-prune/cron.db.test.ts tests/dbos-prune/migration.db.test.ts` | 4 passed, 2 files, 226.41s | `cron-recovery.log` |
| Scoped worker/registrar DB suite | 28 passed, 6 files | `worker-registrar-db.log` |
| Scoped worker/manifest/queue unit suite | 77 passed, 5 files | `unit.log` |
| Selected migration smoke | 26 passed, 56 intentionally unselected | `migration.log` |
| `pnpm typecheck`, `pnpm build` | Passed | `typecheck.log`, `build.log` |
| `pnpm lint`, `pnpm lint:ratchet` | Passed; zero errors, 297 warnings within unchanged 305 ceiling | `lint.log`, `ratchet.log` |
| schema, partition, capability-boundaries, task-census, provider-lanes, provider-attempt-truth | All passed with existing baselines | respective named logs |
| `pnpm audit:dependencies` | Passed high/critical threshold; 2 low and 8 moderate remain | `dependency-audit.log` |

The DB suite selects `src/server/boss/handlers.test.ts`, `worker-boot.db.test.ts`, `verify-dispatch-startup-recovery.db.test.ts`, `job-observation-boss-contract.db.test.ts`, `handlers/prune_job_events.test.ts` and `client.test.ts`. The unit suite selects `start-worker.test.ts`, `queue-config.test.ts`, `job-yield.unit.test.ts`, `src/kernel/manifest.unit.test.ts` and `src/capabilities/observability/manifest.unit.test.ts`. All reported unit counts come from the actual five files. The migration selection is `tests/integration/migration-smoke.test.ts -t 'migration bundle|migration smoke — drizzle migrate from empty DB'`, including fresh and repeated startup with migration 0115 in the journal.

The existing optional Winston build externals remain necessary. A worker bundle probe without them fails on DBOS 5.2.11's `telemetry/logs.js` imports of `winston` and `winston-transport`; `winston-probe.log` records that expected negative check. The actual build passes with the existing externals. No dependency, audit suppression, lint baseline or cosmetic P2 change was introduced.

## Inventory and handoff

The [name-by-name crosscheck](2026-10-07-yuk1355-node24-inventory-crosscheck.json) corrects this lane's inventory description. YUK-1359's read-only baseline has 53 manifest loaders and 18 manifest schedules, plus six infrastructure schedules; those are subsets. This branch has 53 loaders plus the DBOS prune declaration, 19 manifest schedules, five infrastructure schedules, and six `handlers.ts` registrations including `echo`. The static ledger totals 68 distinct names after adding memory's six, orchestration's one and subscription dispatch's one. It excludes DLQs and internal physical queues and does not prove every dynamic producer. README's historical 52 AI tasks and the integrated audit's 55 AI kinds are separate registry counts, not queue denominators. Only the lane's own inventory description and evidence were corrected.

Parent-supplied R1 NONE and sole P1 verification R2 NONE apply to `48ead4da8`. The review budget is spent; this run did not request a new review or upgrade those reviews to the new head. Parent owns artifact acceptance, PR creation, exact-head CI, Linear and further delivery. No new actionable defect remains from this integration; existing migration-family, cleanup and deferred P2 obligations retain their prior owners. Linear operations are prohibited for this child, so there is no new tracker update.

Owner's latest direction is full non-UI priority, Agent TEST ONLY and automation disabled. Runtime lock owner bed93b71/YUK-1365 was left untouched. No delegation, provider call, runtime operation, private restore, deployment, push, PR, watch or remote merge was performed. The writer releases ownership at the clean final local commit.
