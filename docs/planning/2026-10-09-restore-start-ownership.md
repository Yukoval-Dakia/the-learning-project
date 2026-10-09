# Restore helper ownership

Coordinator7631 may implement the existing restore-helper repair after the judge writer releases and delivers, starting from fresh main. Start/release collaborator5796 has no competing writer or pending edits to the following source paths:

- `scripts/restore-drill.sh`
- `scripts/cutover-final-backup.sh`
- `scripts/cutover-backup.ts`
- `src/core/migration/cutover-manifest.ts`, limited to restore receipt types and necessary associated descriptions

Scoped tests, the existing `docs/runbooks/cutover-final-backup-and-restore.md`, relevant existing restore instructions and the README restore paragraph are included. A status scan of77 registered worktrees found75 accessible with no dirty changes in the four source files. Two unavailable historical trees are excluded; clean status does not rule out unannounced committed work. Receipt: `/tmp/yuk1358-restore-scope-ownership-20261009.json`.

The parent read the coordinator's `2026-10-09-yuk1359-dbos-restore-evidence-gap.md` and checked the current shell/TypeScript paths: SQL restore success sets verified before inspection, the table query names only three schemas, and the manifest preserves the boolean/counts but no complete parity contract. The existing offline failure reproduction remains the regression evidence; this ownership check ran no test or restore.

Repair both evidence production and consumption without a second backup system. Bind the dump to a coherent complete non-system schema/table inventory, per-table content and sequence values including is_called. Stop all writers for sequence parity; an exported table snapshot alone does not establish it. Validate inventory sets as well as values, quoted identifiers, JSON encoding and failure paths. Any inspection or parity failure must refuse verification and exit nonzero. Preserve old receipts as limited historical evidence, never silently upgrade their verified boolean.

Keep strict capture completeness distinct from the final restore gate. Restored DBOS records, pending/held obligations, compatible-worker reopening and no duplicate external effects need their own isolated evidence after SQL parity. Whole-runtime blob and Mem0 recovery remain separate obligations.

This transfer excludes Start, application bootstrap/shutdown, private runtime scripts, family execution logic and current deployment data. It does not authorize restoring private backups or changing the Agent TEST environment. Runtime acceptance must independently acquire the shared lock and prove cleanup. Additional source requirements need a concrete scope check before another writer. Existing YUK1359/YUK1329 own this work; no duplicate ticket is needed.
