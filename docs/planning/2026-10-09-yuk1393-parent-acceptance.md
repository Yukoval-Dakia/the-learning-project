# YUK-1393 parent acceptance

The review orphan cleanup family now shares the existing DBOS host while retaining its own admission, receipts and cutover controls. The default remains pg-boss. This delivery does not switch the Agent TEST runtime or complete YUK-1355/1358/1359.

## Revisions and independent review

- Implementation: `a9d7c8322b6ffe3aa9252c024cb5f3479aeb0ea4`, 26 authorized files; author completed/noPending and released the writer.
- Normal integration of main `10df1a47179fe2e368f5df1a538e1dd11cf9e6da`: `3bd071c6c64ad4d32c9936006756cdfc5b2b79a8`. Only PLAN/now conflicted; all 26 implementation blobs stayed identical.
- Parent verified 26 source, 72 log, 749 artifact and 7 metadata hashes, plus 10 protected file/symbol hashes. The existing prune workflow and `prune-v1` recovery identity are unchanged.
- Independent R1: Codex gpt-6.1-sol xhigh, completed/noPending, P0/P1 NONE. Reviewed base10df to head3bd; diff SHA-256 `62859738808541c400754e711e14bec47c85ae4c1c673a22cb8809ea0e55e8f1` independently matched by parent. Source review does not certify runtime results.
- Parent test-only repair: `b33e2e2baa24e60be3fe48fc50d3cdb1e9e0dbe0`. No product source changed after R1. The fixture corrections below are parent-owned and outside the R1 diff; no additional independent review is claimed.

## Observed checks

| Layer | Actual result |
| --- | --- |
| Parent official unit partition | 49/49 across shared lifecycle, export classification and worker startup tests |
| Parent domain DB | 33/33 across Review locking, family transactions, legacy handler and registrar tests |
| Actual crash/recovery | First and second complete runs each 9/10; five SIGKILL boundaries, two real PostgreSQL COMMIT packet faults, old selected-consumer quiescence and genuine old-prune recovery passed. Final unknown-primary/terminal-error case passed separately after fixture correction. |
| Actual review orphan cron | 2/2 after fixture correction; real Timekeeper forwarding, late producer rejection beyond60s, two schedulers, restart, empty native admission, cooldown and pg-boss rollback effect |
| Parent static/build | typecheck, lint, build and seven post-build audits exit0. Final fixture changes rechecked by typecheck/lint/Biome; product bundles unchanged by those test-only changes. |
| Existing prune regression | 4/4 across actual process recovery and real cron/cutover/rollback |
| Migration bundle/empty database | 26/26 selected cases; 56 unrelated migration cases skipped. Shipped migrate bundle starts twice without reseeding; full SQL chain including0116 applied. |

### Preserved failed runs and repairs

1. Process run1 consumed an expected terminal `failure` before an earlier queued `ready`. The helper now consumes the requested message first, and the terminal test explicitly checks the error identity.
2. Process run2 reached the expected failure and unchanged receipts/events, then raced natural exit1 against a forced SIGKILL expectation. The final test waits for and asserts natural exit1; forced cleanup of the unavailable first process does not masquerade as a crash-boundary assertion. Five intentional SIGKILL cases retain their strict signal assertion.
3. Cron run1 correctly rejected a phase change because an actual active forwarder remained. The fixture expected the later quiescence check too early. The corrected test separately requires the active-forwarder rejection and, after the forwarder settles, the missing-quiescence rejection. No gate was removed.

Original failure logs and synthetic runtime evidence remain under `/tmp/yuk1393-parent-validation`; final delivery seals selected evidence below. Product code and business assertions were not weakened to repair these fixtures.

## Runtime ownership

The parent atomically acquired `deployment-20261007/deployment.lock` at2026-10-08T18:25:42.760063Z, token `bcedb44d-2d99-4261-b8c2-5bed6b456fa4`, after verifying the original four services were healthy. It notified57961995 before starting only disposable Testcontainers and bounded fixture processes. No provider, main worker, queue replay, private-data restore or deployment was performed. Owner/token verified and lock released at2026-10-08T18:39:51.511332Z. All owned fixture processes and containers exited. Running container set, original four IDs/images/StartedAt/health and release SHA were identical to the acquired baseline.

## Remaining boundaries

Exact-head CI and PR delivery remain pending. Versioned evidence: [seal](evidence/yuk1393/seal.json) lists source/build/log digests and compressed original failed/successful runs, including the actual runtime JSON. No additional product changes followed R1. The old-consumer test proves why a pre-migration selected loop must be stopped; it does not prove the current deployed worker has been retired. A deployment still needs the real stopped-writer backup/restore, original-consumer/forwarder exit evidence and controlled family transition. Full backup retains execution state; learner archives exclude execution control/receipt tables. Whole-migration exits remain in YUK-1355/1358/1359. No new follow-up ticket is needed for the repaired fixture failures; YUK-1246 paused-age semantics remain separate.

## CI schedule projection fixture correction

Exact53f CI37826255809 completed with one failing test in DB shard2: admin-config's HTTP schedule projection still expected review orphan in the old infra source. All other cases in that shard passed, as did the other three DB shards and unit/migration/build/audit gates. Parent changed only the test: remove the old infra expectation and assert exactly one review-orphan row across the entire response, sourced from capability-manifest with unchanged 04:15 Asia/Shanghai schedule. Product source is unchanged from the reviewed candidate. This mechanical fixture correction does not start another source-review round.

Parent independently ran the whole admin-config DB file:29/29 passed, exit0. Runtime lock22c45280 was acquired19:04:14.486790Z and owner-verified released19:04:58.895678Z. The temporary PG exited; original four IDs/images/StartedAt/health, running set and release SHA were unchanged. Typecheck passed. Lint first found formatting in the separate new1359 census JSON; only that JSON was formatted, and lint then passed. Full build also passed. Failure and successful logs are retained in [CI repair seal](evidence/yuk1393/ci-repair/seal.json). New exact-head CI is required; the old failed run is not retried or called green.

The already prepared local1359 documentation update is included with this necessary repair push. It changes no product or tests beyond the single fixture above. Its static route/job counts remain tied to main10df and candidate53f; source/backend declaration counts are not live cutover or whole-migration completion.

## Delivery receipt

PR1621 merged as `e1f2ef6bb7af15fc633ffea5c9909f0968ad99cd`. Parent fetched and compared its tree to exact `3be966000e53842dc9592df60c367b5af14660fb`: both `cad230a5ad56548d61c48b6c62fb00d66a56dfb6`, empty diff. CI37829575046 completed successfully including four DB shards and aggregate. Final review threads were empty; independent R1 NONE retained. Advisory bots ended skipped/quota, not counted as performed review. PR unwatched, YUK1393 Done; parent migration issues remain open. This supersedes the earlier pending-CI note, not the remaining runtime/cutover boundaries.
