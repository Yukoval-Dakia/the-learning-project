# YUK-1355 A mechanical boundary checkpoint

Base: `60c4f980fce83d73b78fb912a4b097c34b8f250a`, the parent merge of fixed A
`a30079646` into B. Only this fixed B tree was read and written. Moving A/C
worktrees and the original A review were not read or changed.

The adapter moves from `src/server/durable/item-prior-paid-effect-adapter.ts`
to `src/capabilities/practice/server/item-prior-paid-effect-adapter.ts`.
Its shared protocol and store imports now target `core/migration` and `db`.
The operation's reverse adapter import remains type-only. The family imports
its existing operation, adapter and types through narrow `practice/public`
exports and reads backend control from `db/paid-effect-control`.
All affected test paths migrate without changing assertions or file partitions.

The boundary audit decreases from **430/3/48** to **428/0/48**. The five removed
edges were the operation's two Practice-to-durable imports, the family's two
deep Practice imports, and the adapter's deep Practice operation import.
No baseline adjustment was needed. No auditor, schema or SQL change is included.

## Preservation

`compare-ast.cjs`, `ast-before.json` and `ast-comparison.json` prove **491/491
identical declaration ASTs**, including 154 function declarations. Imports,
re-export declarations, export wrappers and parser metadata are excluded; no
body content is normalized. Full class declarations include every adapter
method body. The compared files cover A's operation, adapter, owning-job guard,
retained job, both unit files, the DB fixture and all prior shared product files.

The prior 19 evidence files, including the original 335-declaration proof, are
byte-identical. Eighteen of the 19 prior product files are byte-identical; only
the authorized Practice public exports change. `prior-preservation.json`
records these hashes. `product-files.json` binds the checked product files;
`changed-paths.tsv` lists the staged paths except its own entry.

## Checks and outstanding gates

Node **24.19.0** ran the exact commands recorded in `checks.json` and the
compressed logs. Boundary audit, **25 A unit cases**, **54 shared/Notes/C unit
cases**, typecheck, lint, build, diff whitespace and protected-path equality pass.
Lint reports 172 warnings.

This checkpoint is not fully accepted:

- Architecture deepening fails at the unchanged
  `deps.runTaskFn(work.taskName, ...)` call. The primary census scanner reproduces
  one unresolved caller against both the immutable base and current single-file
  source snapshots; see `census-before-after.json`. Resolving its expression
  would change A's frozen function body or the auditor.
- Partition audit reports six unmocked direct DB imports in A's two unit files.
  These exact imports already exist in the base. `partition-before-after.json`
  reproduces the same six findings. Fixing mocks or partitions would exceed the
  instruction to preserve the tests and partitions.
- Direct public exports add the operation and adapter to an existing
  synchronous import SCC: **78 to 80 modules**, **314 additional cycle pairs**.
  `import-cycles.json` records this source topology. No runtime failure is
  inferred from it, and no runtime validation was performed. Removing this
  connection requires a narrower source module or injected composition beyond
  the frozen-body mechanical step.

All four stale value-import targets resolve after the move. The remaining
architecture, partition and source-cycle limitations are handed to the parent;
no gate has been relaxed or reported as passing.

No DB tests, runtime, Docker, providers, locks, PR, push, Linear or child agents
were used. Parent owns subsequent A fixes and acceptance.
