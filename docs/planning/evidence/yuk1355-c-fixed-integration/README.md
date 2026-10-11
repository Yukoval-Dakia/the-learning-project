# YUK-1355 fixed C integration

This normal merge combines A's mechanical path checkpoint
`f98647b7c5a00394f3ca570301c51e54eed6dd85` with fixed C
`99f5e069d0476a0afe50d246eecfe38cae18854a` in the parent B tree. It does not
include the original A writer's later terminal-job repair.

Git recognized the earlier calibration-store rename and applied C's correction
to `src/capabilities/practice/server/calibration-sample-store.ts`. The only two
merge conflicts were imports in the operation and its DB fixture. Those files
were resolved from the immutable fixed C source and the agreed path mapping.
Two newly added unit-test imports received that same mapping afterward.

The paths now use the Practice-owned store, `core/migration/paid-effect-protocol`
and `db/paid-effect-store`/`db/paid-effect-control`. No corrected C function body,
transaction, receipt validator or test assertion was rewritten.

## Source proof

`compare-ast.cjs` compares the fixed C source with the resulting files. It
excludes only import/re-export declarations, export wrappers and AST metadata;
it normalizes no body content. `ast-before.json` and `ast-comparison.json` record
**120/120 identical declarations**, including 47 function declarations, with
explicit function-body hashes.

All 42 prior evidence files are byte-identical, and all six A product files
remain at their checkpoint SHA-256 values; see `prior-preservation.json`.
`product-files.json` binds the five merged source/document files to the checked
bytes. `changed-paths.tsv` lists the staged merge delta except its own entry.

Baseline, auditors, test partitions, schema declarations and SQL migrations are
unchanged. The exact capability debt remains **428/0/48** without adjustment.

## Offline checks and outstanding acceptance

Node **24.19.0** ran the commands recorded in `checks.json`. Compressed logs
preserve both the initial stale-import failures and the corrected reruns.

- Fixed C unit suite: **35/35 pass** across three files.
- Shared protocol and Notes unit suite: **20/20 pass** across three files.
- A checkpoint unit suite: **25/25 pass** across two files.
- Boundary audit, C AST comparison, typecheck, lint, build and protected-path
  equality pass. Lint reports 172 warnings.
- Architecture deepening still fails at A's unchanged
  `deps.runTaskFn(work.taskName, ...)` caller.
- Partition still reports the same six direct DB imports in A's two unit files.
  No partition or audit exception was introduced. The A checkpoint also records
  the public-export synchronous SCC limitation; no further A source changes
  were made to address it.

These are offline integration results, not DB/provider or recovery acceptance.
**C's 22 DB cases and the two shared-switch cases remain unrun here. A's 15 DB
cases are not PASS.** Parent owns the later single DB window and A's terminal
repair integration.

No moving A/C tree was read. No DB, testcontainer, runtime service, Docker,
provider, runtime lock, deployment, PR, push, Linear or child agent was used.
No new correctness review was requested or conducted.
