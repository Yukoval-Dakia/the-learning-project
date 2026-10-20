# Unavailable-primary diagnostics (YUK-1481)

Source/offline implementation only, for the owner-approved 20:01 proposal in
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/ci/YUK-1481/3fee78052-readonly-20261019/diagnosis.md`.
Verified SHA-256: `1ac7f9e0bcdc9b88e79d1c18db86e026cdd9cd4bcb6643115a79d658394d3fb6`.
Actual isolated tree: `/Users/yuqi/.t3/worktrees/the-learning-project/t3-dde1711b`.
Branch: `fix/yuk-1481-unavailable-primary-diagnostics`, created with normal
`git switch -c` from freshly fetched `origin/main`
`4fd179818bd4a3ad8f16c07b2c9f38daa1adc259` (138 commits beyond the initial old HEAD).
The old parent worktree was not edited. The 13 open PRs inspected before editing
had no direct overlap with these files. Dependency-closure overlap is not causal evidence.

## Diagnostic scope and interpretation

- Only the existing review unavailable-primary case opts its first/recovery workers
  into diagnostics. Session/placement cases, production code, dependencies and CI are unchanged.
- Its proxy records connection ordinals, lifecycle, frontend query ordinals/classes,
  protocol tags, pending Ready/unsynced state, and ordered COMMIT-loss/disconnect/08006 events.
  `lastQuery` means last observed frontend query, not proof of the rejected promise's identity.
- Its worker records caught/fatal stage, PID, SQLSTATE, a closed `error.query` class,
  fatal origin and whether the existing stack includes a `fetchArrayTypes` frame.
  Synchronous stderr writes survive the normal fatal path. `uncaughtExceptionMonitor`
  only observes: no rejection/exception handler, exit override, new catch around domain
  work, retry, cleanup or workflow-state change is introduced.
- Wall timestamps and per-process sequence/monotonic timestamps aid correlation;
  connection ordinals are proxy-local. They do not establish cross-process causality alone.
- The 19-line local classifier is shared directly by this proxy and worker so their
  fixed labels agree. It is the only new helper, with no service, registry or harness.
  `internal-pg-type` requires the normalized exact postgres 3.4.9 array-type query;
  a generic catalog read cannot establish that attribution.
- New records never serialize SQL, Bind parameters, credentials, error messages,
  stacks or learner data. Prepared-statement/portal names remain in memory only.
  No new postgres `debug` hook is enabled: it would make SQL/parameters enumerable
  on driver errors. Original IPC/stderr, fault records, receipt/event snapshots,
  failure/cleanup guards and unknown/PENDING evidence remain intact.

Original pool sizes, cold connections, `fetch_types`, fault response bytes/order,
assertions, timeouts and business-state handling are preserved. No test case or
assertion is added; modifications in the existing case only enable its diagnostic flag.
`fetchArrayTypes` remains unproven. The older RST/socket-null incident is not attributed
to this failure. One green run is inconclusive and does not authorize blind reruns.

## Parent-only single-case execution, not executed here

After independent review and separate runtime coordination, on the fixed commit:

```sh
TLP_REVIEW_EVIDENCE_PATH=/absolute/fresh-parent-artifact/review-migration.json \
pnpm vitest run --config vitest.db.config.ts \
  tests/dbos-review-orphan/migration.db.test.ts \
  -t '^actual review orphan crash and recovery holds an unavailable primary as unknown and does not resume a terminal DBOS ERROR$'
```

The artifact directory must already exist and the target must be unused. Execute
this command once, without a shard, suite rerun, warmup or changed concurrency options.
Record the exact commit, argv, Node/dependency versions, bundle digest, exit code,
full output and evidence JSON; retain failures and pre/post-cleanup states.

Required resources: the existing DB config's disposable `pgvector/pgvector:pg16`
Testcontainer (2 GiB tmpfs, max_connections=500), its migrations and four standard
fork DBs, the review fixture's additional template clone, loopback ephemeral proxy
port and the existing seed/first/recovery Node subprocesses. No TEST database or
provider is needed. Require full Git history including
`6aaf8ca89eaf5feb5af5c00b7c5b3bd90cd953ea`, installed frozen dependencies and esbuild.
The existing seed is retained; no additional connection warmup is introduced.

## Offline evidence and remaining work

Offline frozen install used `--ignore-scripts` and downloaded zero packages.
`pnpm typecheck` passed (47.9s), `pnpm lint` passed (9.2s, 178 existing warnings),
and `pnpm build` passed (29.6s). Final targeted Biome check passed for all three TS
files. The review worker also bundled offline with the fixture's unchanged flags;
it was never executed. Bundle SHA-256:
`2b658b2c0ed0e2dbf006844ccdac1b6ca8f2000e1f8c716084d53594ece3ca16`.

Compiler-AST source accounting against the base found the same five `it` declarations
(10 expanded cases), all 34 assertion chains, all invariant metadata, and identical
case bodies after omitting only the two new diagnostic flags. The selected case's
nine assertion chains are unchanged (SHA-256 of the JSON array of printed expressions:
`818bf614a253fa5c9a3368d7a27446f93ea3d14c392fe6c209830b3e2ebe8376`).
This is static accounting, not runtime acceptance. Logs and the accounting JSON
remain in `.cache/yuk1481-source-offline/` in this isolated tree.

No test, Docker/DB/provider/TEST/runtime,
CI trigger, push, PR, merge or delegation was executed by this implementation lane.
Independent review and the single runtime invocation remain parent-owned.
No new actionable follow-up was discovered beyond the existing YUK-1481 provenance
and acceptance work; no duplicate issue or tracker write was made in this offline lane.
The parent retains Linear status/capture and PR coordination.
