# YUK-1359 DBOS restore evidence gap

Read-only inspection at candidate `a8800730b3c67667574bc44ec02edb7ed7800f78`. No database connection, Docker command, backup, restore or service action was performed. This refines the existing1359/1329 exit obligation; it does not introduce a new backup system or declare a restore failure.

## What the existing paths prove

`scripts/cutover-final-backup.sh` uses whole-database `pg_dump -Fc`, without a schema filter. `scripts/restore-drill.sh` restores the custom dump into a scratch container with `--single-transaction --exit-on-error`. These commands do not intentionally omit the DBOS schema.

The repository drill's post-restore count query, however, explicitly selects only `public`, `drizzle` and `pgboss`. It sets `VERIFIED=true` when `pg_restore` succeeds. A later table-count query failure does not reset that value, and the helper does not compare its counts against a source inventory. `scripts/cutover-backup.ts` verifies the restored dump SHA and then projects the supplied `verified` and `table_counts`; it does not add a DBOS coverage check. Thus this receipt can prove successful SQL restoration while leaving durable-state parity unproven.

The current-release pointer was read as source `5aa2a9e989984dfa065b3ba400b67b6b987b12e3`, release directory `deployment-yuk1364-13b56e35a`, with `environmentPurpose=agent-development-test` and `personalDailyUse=false`. The release's `final_backup.py` is stronger than the repository helper: it dynamically lists non-system tables and checks restored inventory/count equality plus pg-boss queue/debt parity. Its saved `backup/table-counts.json` contains102 tables across `public`, `drizzle` and `pgboss`, with zero `tlp_dbos` tables. That earlier successful restore does not exercise persisted DBOS workflows or checkpoints.

These are source and stored-receipt observations. The current live database's contents were not queried, and no conclusion about a missing table in the live database follows from an older backup inventory.

## Bounded completion work

Extend the existing restoration verification rather than create a parallel helper. Determine the complete non-system schema/table/sequence inventory from the stopped source or a coherent snapshot, bind it to the dump identity, and compare the restored copy. Failed inspection must make verification fail. A DBOS candidate requires evidence from its actual configured system schema, including workflow/checkpoint state and family controls, not merely a hardcoded schema name added to the list.

Use synthetic but nonempty completed, pending and explicitly held obligations with the compatible candidate. Capture domain receipts, DBOS records, family phase/epoch and legacy queue dispositions from the same backup boundary. After isolated restore, reopen only the compatible worker under the coordinated lock and prove it resumes eligible work without duplicating domain effects or external calls. Held/unknown work must remain held. Preserve source/image/schema identity, exact inventories and failure artifacts.

Learner ZIP archives deliberately exclude operational ledgers. Their import tests do not replace full runtime recovery. A successful SQL restore, table count equality, process restart and external-effect safety are separate evidence layers; final migration acceptance needs all applicable layers.

The release/boot owner5796 has been notified of these exact paths. Source ownership for a future helper change must be coordinated before implementation. Existing1359/1329 remain open; this investigation does not delay or expand1394's current CI repair, allocate another writer or authorize a production restore.
