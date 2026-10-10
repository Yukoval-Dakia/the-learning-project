# YUK-1377 Today domain reads

The owner requires complete non-UI migration before remaining feature development. This lane prepares the existing Today reads for shared HTTP and Start consumers; it does not complete the Today page, W1 or the full migration.

## Ownership and implementation

Baseline: main `1bbd82795290931ac99b7669abf93fab83e2b56b`. Branch: `feat/yuk-1358-w1-domain-reads`.

Main thread 57961995 confirmed no overlapping Today writer. This thread owns shell public read exports, the corresponding HTTP consumer and scoped contract tests. Main retains Start functions, route/page injection and global composition. Inbox remains investigation-only. Commands, teaching-brief events, grading and recovery are excluded.

Reuse `loadWorkbenchSummary(db: Db): Promise<WorkbenchSummary>`. Expose its existing implementation and result type through shell's public boundary and consume it from the current HTTP endpoint. Do not create another aggregate. Preserve cold-start evidence, the 200-row KPI sample and pending-proposal lower-bound semantics.

`loadTodayOvernightDigest(db: Db | Tx, now?: Date): Promise<OvernightDigest>` already provides the shared Today/Copilot boundary in `src/server/today/overnight-digest.ts`. Keep its BJT window, five-source facts, cost and degraded-state semantics. No replacement facade is needed.

## Due integration and remaining Start work

PR1602 delivered `queryReviewDue(activeDb, input, deps)` in main `5b11f3edbd8c8a418cea8815976786d177e332bc`. This branch fetched and normally merged that main. Commit `79eb7980d` replaces summary's internal Request/HTTP/global-database call with `queryReviewDue(db, { limit: 200 })`, retaining the existing practice selector and sample limit. No practice implementation was copied or changed.

Start consumers must enforce authentication and contract epoch before invoking reads and preserve safe error responses. The Hono middleware does not automatically protect a direct server-function call. Main owns this integration and its real entry acceptance.

### Database-injection regression

The six current summary DB fixtures exercise only zero due counts. Their public-loader/HTTP parity cannot detect a due selector using the wrong connection. Keep those tests, and add a separate public-summary test using `beginTestTransaction()` from `tests/helpers/db.ts`: its `testDb()` returns a `Db` on a reserved connection, while the HTTP singleton remains on another connection. Insert uncommitted eligible questions, knowledge and due states through that injected database. Assert a nonzero summary due count and cold-start review evidence while the HTTP singleton cannot see those rows. Always roll back the helper transaction in cleanup. Do not change the public loader to accept `Tx` merely for this fixture.

Also verify the summary retains its 200-row sample using more than 200 eligible entries, with future-due and excluded entries present. Practice owns selector ordering and eligibility tests; shell should assert only its aggregation, sampling and database forwarding. The practice dependency already tests transaction forwarding at its own public boundary, but that does not prove the summary forwards its database correctly.

The new `api/workbench-summary-due.db.test.ts` fixture was prepared before integration. Parent ran both cases against `a2654fdc1` plus that test on 2026-10-07 at 22:00Z. Both failed for the expected reason: due counts were 0 instead of 3 and 200, and both `review_due` values were false. The other fixture, singleton-invisibility and rollback assertions did not fail. This proves the regression is detectable; it does not prove the fix or the fixture's final eligible counts yet. Log: `/tmp/yuk1377-due-red-db.log`. Temporary Postgres exited, the original four services remained healthy, release bytes were unchanged, and the owner-checked lock was released at 22:00:49Z. Cleanup: `/tmp/yuk1377-due-red-cleanup.json`. After integration, parent repeated this test together with the original six summary DB cases: all eight passed, including due counts 3 and 200 and correct review evidence. Log: `/tmp/yuk1377-due-green-db.log`. Owner-checked lock released at 2026-10-08 09:32:05Z; original running container set, four service health checks and release digest were unchanged. Cleanup: `/tmp/yuk1377-due-green-cleanup.json`.

## Evidence to collect

- Existing HTTP and public-domain outputs agree on realistic empty, populated, error and boundary fixtures.
- Scoped unit/DB checks, typecheck, lint and build are recorded separately from independent diff review and exact-head CI.
- The Start consumer and real browser/HTTP/DB behavior require their own candidate evidence after mounting.
- UI appearance remains unchanged. Whole-page and old-SPA exit remain open until all relevant consumers are replaced and verified.

Implementation `1aa3fd8925c5e580ea4daa42119410f3087ca2d3` is committed, with four source/test files. The writer completed with no pending child runs. Parent verified all eight source hashes. Author validation: 35 scoped unit tests, typecheck, lint, build and partition/capability audits passed. Whole-repository lint reported 297 warnings; owned files had no Biome diagnostics.

Parent independently ran the six existing workbench DB fixtures through the public loader and HTTP consumer: all six passed, exit 0. The standard test setup created a fresh temporary Postgres container and migrated it; it did not use the retained acceptance database. Log: `/tmp/yuk1377-parent-db.log`. Owner-checked deployment lock released at 2026-10-07 21:52:13Z after temporary Postgres exited; main release digest was unchanged and four original services remained healthy. Cleanup: `/tmp/yuk1377-db-cleanup.json`.

Final source checks on `79eb7980d`: 35 scoped unit tests passed, typecheck, lint and build completed successfully. Lint reported 297 existing warnings. Logs: `/tmp/yuk1377-final-{unit,typecheck,lint,build}.log`. No full local test suite, provider call, retained-database change or deployment was performed.

Independent R1 review of the complete branch diff against `5b11f3edb` completed with no P0/P1 findings. Parent verified all six reviewed source/test blobs remained identical through `61e41e319`, whose exact-head CI `37757563898` passed. After PR1592 merged, this branch normally integrated main `eae963377` as `e65445abe`; only PLAN and handoff text conflicted and both sides were preserved. The six reviewed source/test blobs are still identical. The new main adds the Start dependency and build, so dependencies were installed using the frozen lockfile. Integration verification passed: 42 scoped unit tests, both app/Start typechecks, lint and the full production build, all exit 0. Logs: `/tmp/yuk1377-main-integration-{unit,typecheck,lint,build}.log`; exit-code record: `/tmp/yuk1377-main-integration-checks.json`. Final head `53a70bf4a6b1b3e68240a67ab49d4229540bb7ba` passed exact-head CI `37760493515`. PR1603 merged at 2026-10-08 10:04:28Z as `90f499126e81249f2f193ec69f1c6966a11ca127`; candidate and merge trees both equal `c171d2090b32ec671fb17a731d7d7876d0c78532`. No new review round was needed for unchanged reviewed source. Linear1377 and parent1358 remain In Progress because Start acceptance is still outstanding. Start mounting and real entry acceptance remain with the main integration owner. This lane does not complete the Today page or the full migration.
