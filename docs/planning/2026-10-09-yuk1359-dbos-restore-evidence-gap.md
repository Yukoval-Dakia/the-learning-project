# YUK-1359 DBOS restore evidence gap

Read-only inspection at candidate `a8800730b3c67667574bc44ec02edb7ed7800f78`. No database connection, Docker command, backup, restore or service action was performed. This refines the existing1359/1329 exit obligation; it does not introduce a new backup system or declare a restore failure.

## What the existing paths prove

`scripts/cutover-final-backup.sh` uses whole-database `pg_dump -Fc`, without a schema filter. `scripts/restore-drill.sh` restores the custom dump into a scratch container with `--single-transaction --exit-on-error`. These commands do not intentionally omit the DBOS schema.

The repository drill's post-restore count query, however, explicitly selects only `public`, `drizzle` and `pgboss`. It sets `VERIFIED=true` when `pg_restore` succeeds. A later table-count query failure does not reset that value, and the helper does not compare its counts against a source inventory. `scripts/cutover-backup.ts` verifies the restored dump SHA and then projects the supplied `verified` and `table_counts`; it does not add a DBOS coverage check. Thus this receipt can prove successful SQL restoration while leaving durable-state parity unproven.

The current-release pointer was read as source `5aa2a9e989984dfa065b3ba400b67b6b987b12e3`, release directory `deployment-yuk1364-13b56e35a`, with `environmentPurpose=agent-development-test` and `personalDailyUse=false`. The release's `final_backup.py` is stronger than the repository helper: it dynamically lists non-system tables and checks restored inventory/count equality plus pg-boss queue/debt parity. Its saved `backup/table-counts.json` contains102 tables across `public`, `drizzle` and `pgboss`, with zero `tlp_dbos` tables. That earlier successful restore does not exercise persisted DBOS workflows or checkpoints.

These are source and stored-receipt observations. The current live database's contents were not queried, and no conclusion about a missing table in the live database follows from an older backup inventory.

## Offline error-handling reproduction

The parent subsequently sourced the unchanged repository drill in a Bash subprocess with every `docker` call intercepted by a function. The function has no real CLI fallback. It supplied synthetic successful readiness/restore responses, then returned17 for the table-inventory query. No Docker daemon, database or network was accessed; the39-byte input is explicitly not a real dump.

The actual script exited0 and wrote `table_counts: {}`, `verified: true`, and `errors: "OFFLINE_INJECTED_COUNT_QUERY_FAILURE|"`. The [reproduction receipt](evidence/2026-10-09-yuk1359-restore-count-failure.json) seals the original script, offline driver and outputs. The driver is `/tmp/yuk1359-restore-count-failure-20261009.sh`; outputs are `/tmp/yuk1359-restore-count-failure.thPFED/`. This proves the shell verification-error path, not a failed database restore. The repair must make the same injected path exit nonzero and refuse a verified receipt.

## Bounded completion work

Extend the existing restoration verification rather than create a parallel helper. Determine the complete non-system schema/table/sequence inventory from the stopped source or a coherent snapshot, bind it to the dump identity, and compare the restored copy. Failed inspection must make verification fail. A DBOS candidate requires evidence from its actual configured system schema, including workflow/checkpoint state and family controls, not merely a hardcoded schema name added to the list.

Use synthetic but nonempty completed, pending and explicitly held obligations with the compatible candidate. Capture domain receipts, DBOS records, family phase/epoch and legacy queue dispositions from the same backup boundary. After isolated restore, reopen only the compatible worker under the coordinated lock and prove it resumes eligible work without duplicating domain effects or external calls. Held/unknown work must remain held. Preserve source/image/schema identity, exact inventories and failure artifacts.

Learner ZIP archives deliberately exclude operational ledgers. Their import tests do not replace full runtime recovery. A successful SQL restore, table count equality, process restart and external-effect safety are separate evidence layers; final migration acceptance needs all applicable layers.

The release/boot owner5796 has been notified of these exact paths. Source ownership for a future helper change must be coordinated before implementation. Existing1359/1329 remain open; this investigation does not delay or expand1394's current CI repair, allocate another writer or authorize a production restore.

## Concrete repair boundary after judge delivery

Parent rechecked the repository helpers at `39964ec13` while the sole judge/Hono writer was still active. No source or runtime change was made. The existing runtime-specific `final_backup.py` checks stopped writers, no other DB clients, dynamic table inventory and restored counts. It is useful evidence of the existing procedure, but hardcodes an old release and does not compare every table's contents or sequence state. Do not invoke or copy it as a new general backup service.

The bounded follow-up should own `scripts/restore-drill.sh`, `scripts/cutover-final-backup.sh`, `scripts/cutover-backup.ts`, their scoped tests, and the restore-evidence type in `src/core/migration/cutover-manifest.ts`. The existing runbook and README restore paragraph need to describe the resulting contract. This scope still needs coordination with the release owner before a new source writer starts. Start, boot, shutdown, family execution logic, private release scripts and application data are outside it.

The receipt has two consumers that must be repaired together. The shell currently sets `verified` from SQL restore before inspection. The TypeScript manifest checks dump SHA but then trusts the boolean and copies only counts, so a richer comparison result would otherwise be dropped. Preserve legacy receipts as explicitly limited historical evidence; do not reinterpret an old `verified: true` as current DBOS parity. The CLI's existing `--strict` checks presence of manifest/dump/DLQ arguments, not successful restore. Preserve the distinction between a backup capture and the final restore gate rather than silently treating strict capture as deployment approval.

Required proof for the follow-up:

- Capture the complete non-system table/schema and sequence inventory from the stopped source, with per-table content digests and sequence values including `is_called`. Bind the inventory and comparison to the exact dump SHA and compatible source revision. Sequence state is not an ordinary MVCC table snapshot, so an exported table snapshot alone is insufficient without writer quiescence.
- Compare the restored table and sequence sets as well as values. A missing DBOS schema, missing or extra table, equal-count changed row, or sequence mismatch must fail verification. Arbitrary quoted identifiers must be handled safely; JSON must remain valid for paths or diagnostics containing quotes and newlines.
- Any inspection or comparison failure must produce a failed receipt and nonzero exit. Retain the existing offline injected count-query failure as the regression; add mismatched inventory/digest/sequence and wrong-dump negatives. No allowlist may hide an operational schema.
- Use a disposable nonempty source containing completed, eligible pending and unknown/held judge obligations with actual DBOS records and family controls. Stop its compatible worker, perform the real backup/restore, verify parity before reopening, then prove the compatible restored worker completes only eligible work. Original saved outcomes and terminal effects remain unique; unknown/held work produces no new wire calls. This is separate from SQL restoration and cannot be claimed from unit tests.

The whole-runtime release additionally retains its blob and Mem0 obligations. This database helper repair does not itself prove those or authorize running the current deployment. It remains captured under existing YUK-1359/YUK-1329, with no duplicate issue or concurrent writer.

## Ownership confirmed

Start/release owner5796 confirmed the exact follow-up scope after reading this document and checking 77 registered worktrees, of which75 were accessible. The four named source paths had no dirty changes in those accessible trees, and that thread has no assigned or planned writer for them. Two inaccessible historical trees were explicitly excluded from the claim. Receipt: `/tmp/yuk1358-restore-scope-ownership-20261009.json`.

After judge delivery and complete writer release, this thread may start one writer from fresh main for the existing helpers, receipt type/necessary explanation, scoped tests and the existing runbook/README restore paragraph. No additional permission is needed within that scope. Capture strictness remains distinct from the restore gate, and older receipts retain their historical limits. Start, boot, shutdown, private runtime scripts, family execution and restoring the main database are not included. Broader required paths must be coordinated before editing. This ownership confirmation is not DB or restoration evidence.


## Sequencing update at04:34Z

Start/release owner5796 rechecked ownership and committed `0015de13dc062e6badaa9cbf74e5dcc81ec9bae4`, explicitly removing the dependency on judge merge or provider-quota restoration. Parent read that completed thread result and the commit. Once the current judge transport test writer has fully released and parent has committed its acceptance evidence, this thread may switch its existing bound worktree to a fresh-main branch and implement the already confirmed restore scope with one writer. PR1625 stays draft/watched with its actual-model gate intact. Do not carry judge WIP onto main, start parallel writers, or change runtime during this source step. All original exact-file, fail-closed, dump binding, full inventory/content/sequence, history and actual restore/reopen requirements remain unchanged.
