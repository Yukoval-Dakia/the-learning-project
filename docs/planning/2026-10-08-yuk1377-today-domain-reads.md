# YUK-1377 Today domain reads

The owner requires complete non-UI migration before remaining feature development. This lane prepares the existing Today reads for shared HTTP and Start consumers; it does not complete the Today page, W1 or the full migration.

## Ownership and implementation

Baseline: main `1bbd82795290931ac99b7669abf93fab83e2b56b`. Branch: `feat/yuk-1358-w1-domain-reads`.

Main thread 57961995 confirmed no overlapping Today writer. This thread owns shell public read exports, the corresponding HTTP consumer and scoped contract tests. Main retains Start functions, route/page injection and global composition. Inbox remains investigation-only. Commands, teaching-brief events, grading and recovery are excluded.

Reuse `loadWorkbenchSummary(db: Db): Promise<WorkbenchSummary>`. Expose its existing implementation and result type through shell's public boundary and consume it from the current HTTP endpoint. Do not create another aggregate. Preserve cold-start evidence, the 200-row KPI sample and pending-proposal lower-bound semantics.

`loadTodayOvernightDigest(db: Db | Tx, now?: Date): Promise<OvernightDigest>` already provides the shared Today/Copilot boundary in `src/server/today/overnight-digest.ts`. Keep its BJT window, five-source facts, cost and degraded-state semantics. No replacement facade is needed.

## Required integration still pending

Summary's `countDue` currently constructs a Request and calls `handleReviewDue`, which uses the global database. YUK1356 owns extraction and export of `queryReviewDue(activeDb, input, deps)`. The intended summary call is `queryReviewDue(db, { limit: 200 })`. Wait for that owner's exact delivered commit, then replace the old call and verify database injection. Do not copy the selector or claim database isolation before this is done.

Start consumers must enforce authentication and contract epoch before invoking reads and preserve safe error responses. The Hono middleware does not automatically protect a direct server-function call. Main owns this integration and its real entry acceptance.

### Database-injection regression to add with the due integration

The six current summary DB fixtures exercise only zero due counts. Their public-loader/HTTP parity cannot detect a due selector using the wrong connection. Keep those tests, and add a separate public-summary test using `beginTestTransaction()` from `tests/helpers/db.ts`: its `testDb()` returns a `Db` on a reserved connection, while the HTTP singleton remains on another connection. Insert uncommitted eligible questions, knowledge and due states through that injected database. Assert a nonzero summary due count and cold-start review evidence while the HTTP singleton cannot see those rows. Always roll back the helper transaction in cleanup. Do not change the public loader to accept `Tx` merely for this fixture.

Also verify the summary retains its 200-row sample using more than 200 eligible entries, with future-due and excluded entries present. Practice owns selector ordering and eligibility tests; shell should assert only its aggregation, sampling and database forwarding. The practice dependency already tests transaction forwarding at its own public boundary, but that does not prove the summary forwards its database correctly.

## Evidence to collect

- Existing HTTP and public-domain outputs agree on realistic empty, populated, error and boundary fixtures.
- Scoped unit/DB checks, typecheck, lint and build are recorded separately from independent diff review and exact-head CI.
- The Start consumer and real browser/HTTP/DB behavior require their own candidate evidence after mounting.
- UI appearance remains unchanged. Whole-page and old-SPA exit remain open until all relevant consumers are replaced and verified.

Implementation `1aa3fd8925c5e580ea4daa42119410f3087ca2d3` is committed, with four source/test files. The writer completed with no pending child runs. Parent verified all eight source hashes. Author validation: 35 scoped unit tests, typecheck, lint, build and partition/capability audits passed. Whole-repository lint reported 297 warnings; owned files had no Biome diagnostics.

Parent independently ran the six existing workbench DB fixtures through the public loader and HTTP consumer: all six passed, exit 0. The standard test setup created a fresh temporary Postgres container and migrated it; it did not use the retained acceptance database. Log: `/tmp/yuk1377-parent-db.log`. Owner-checked deployment lock released at 2026-10-07 21:52:13Z after temporary Postgres exited; main release digest was unchanged and four original services remained healthy. Cleanup: `/tmp/yuk1377-db-cleanup.json`.

These checks cover the public export and current HTTP contract only. The summary implementation still uses the old due HTTP handler/global database. Main has started an independent YUK1356 typed-due delivery from the latest main, separate from its Pi/tool WIP. Wait for its exact merged commit, then integrate and test. Independent review and exact-head CI for the finished lane have not run; Start mounting and runtime acceptance remain pending.
