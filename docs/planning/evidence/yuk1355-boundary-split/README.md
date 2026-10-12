# YUK-1355 responsibility split

Base: `fa33bad5a1c55756f1852c3da7eb2c9e28a5cbec` in the parent B worktree
`/Volumes/YukovalSBak/yukoval-projects/tlp-migration-receipt-reference`.
This is mechanical ownership integration. A is absent from this tree and was
not read or synthesized. The independent C repair tree was not read.

The boundary audit passes at capability-to-server **428**, server-to-capability
deep **0**, and cross-capability value **48**. Baseline, auditors, test partition,
SQL migrations, registration and default pg-boss behavior are unchanged.

## Ownership and consumer paths

- `src/core/migration/paid-effect-protocol.ts` owns the unchanged pure protocol.
- `src/db/paid-effect-store.ts` owns generic paid-effect row persistence.
- `src/db/paid-effect-control.ts` owns generic PG admission, locks and control
  snapshots. Only the existing `rowToControl` helper gains an export.
- `src/server/durable/paid-effect-control.ts` retains the original switch
  transaction and pinned probe composition. It consumes the Notes obligation
  query through `notes/public`, inside the original transaction.
- Notes owns `server/paid-effect-note-admission.ts` and
  `server/paid-effect-note-obligations.ts`. Its public entrypoint adds only the
  operation, admission builder, obligation query/constant and required types.
- Practice owns `server/calibration-sample-store.ts`. Its public entrypoint
  adds only the dispatch schema and type consumed by the existing candidate.

The existing Notes manifest still loads the retained pg-boss handler, which
calls the Notes operation and injects its admission hook into reservation.
The existing Practice manifest still loads `judge_calibration_sample`, which
calls `runCalibrationSampleOperation`. It does not select the staged path.
The DBOS candidates remain unregistered. No runtime acceptance is claimed.

The five moved implementations have no compatibility wrappers at their old
paths. All source and test consumers have migrated. Existing test file paths
are retained. `src/db/schema.ts` changes only three protocol TYPEIMPORT paths.

## Preservation evidence

`compare-ast.cjs` captures declarations from the immutable base and compares
them with the current files. It ignores import/re-export declarations, export
wrappers and parser metadata. Inside declarations, it normalizes only the
three old schema TYPEIMPORT source literals to their new protocol path.

`ast-before.json` contains the before hashes. `ast-comparison.json` records
**335/335 identical declaration ASTs**, with no unexpected declarations. Each
function declaration also has an explicit before/after body AST hash. This
covers the moved implementations, every original control/switch declaration,
the unchanged consumers, schema declarations and all edited test bodies.

`product-files.json` records every active changed product file's SHA-256 and
the deleted paths. `changed-paths.tsv` records the complete staged change list
except its own manifest entry. These identify the source checked before commit.

`import-cycles.json` compares synchronous value imports and re-exports reachable
from the changed production modules. Type-only and dynamic imports are excluded.
It follows 567 base modules and 568 resulting modules; each graph has one
existing SCC, with **zero new cycle pairs** after normalizing moved paths.

Reproduce the AST comparison under Node 24:

```bash
node docs/planning/evidence/yuk1355-boundary-split/compare-ast.cjs
```

The comparator writes its manifest. Format that artifact before lint if needed.

## Checks and limits

All requested checks ran with Node **24.19.0**. `checks.json` contains exact
commands, exit codes, durations and compressed log filenames.

- Boundary and architecture audits pass at 428/0/48.
- Partition audit passes: 69 unit files, 210 DB files, one migration file.
- Six scoped unit files pass, **54/54 cases**.
- Typecheck and build pass.
- Final lint passes with 172 warnings. The initial lint failure was formatting
  of the generated `checks.json`; its failed log remains preserved separately.
- Diff whitespace and protected-path equality checks pass.

No DB tests, testcontainers, shared 34-case DB rerun, runtime services, Docker,
provider calls, runtime locks, deployment, PR, push, Linear or child agents were
used. Parent owns A integration, C repair merge, acceptance and follow-ups.
Merge C's fixed repair with rename detection and retain its corrected behavior;
this split does not replace or review that repair.
