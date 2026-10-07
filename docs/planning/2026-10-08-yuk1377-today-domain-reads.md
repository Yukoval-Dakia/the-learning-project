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

## Evidence to collect

- Existing HTTP and public-domain outputs agree on realistic empty, populated, error and boundary fixtures.
- Scoped unit/DB checks, typecheck, lint and build are recorded separately from independent diff review and exact-head CI.
- The Start consumer and real browser/HTTP/DB behavior require their own candidate evidence after mounting.
- UI appearance remains unchanged. Whole-page and old-SPA exit remain open until all relevant consumers are replaced and verified.

At creation, investigation completed without edits or tests. The sole implementation task `yuk1377-today-public-read-implementation-20261008-v1` is running; no code or test result is claimed yet. No runtime action is authorized by this record itself.
