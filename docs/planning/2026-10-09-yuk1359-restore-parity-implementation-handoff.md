# YUK-1359 / YUK-1329 restore helper implementation handoff

Author scope is source/offline only, in `tlp-yuk-1363-test-storage`, branch
`fix/yuk-1359-restore-parity`. Parent owns integration, Linear, independent review,
exact-head CI and actual source capture/restore/DBOS reopen acceptance. No subdelegation,
Docker/DB/application/provider/network execution, dependency installation, push, PR,
branch switch, merge, deployment or source restart was performed by the author.
PLAN and `.remember` remain parent-owned.

Accepted design SHA-256 is
`7df07b33b10b5a4bcb86680809925f2bfec72e304ee722f07751a9302a053280`.
The original author starting HEAD was `49ddae370`; parent documentation commits
advanced HEAD during implementation. Those parent files and commits were preserved.

## Implemented contract

The existing shell entry points dispatch named operations in `scripts/cutover-backup.ts`.
Imports do not load `.env`, connect or spawn. Capture owns the live exported snapshot
through dump/source readers, checks host/container cluster/database/postmaster identity,
requires externally held maintenance evidence, observes stopped containers and sessions/
prepared transactions, and retains exact companion identities within that interval. The exact supplied quiescence
bytes are copied into the unique capture directory and referenced by their original hash.
The existing migration CLI runs from the fresh capture directory with its explicit
DB target and repository tsconfig; its cwd has no `.env` to load provider credentials.
No ACL/configuration change or automatic source recovery was introduced.

Logical `pg16-column-text-sha256-multiset-v1` uses fixed PostgreSQL text settings,
ordered visible column/type metadata, PostgreSQL sorted full-row SHA-256 streams,
duplicate multiplicity and a bounded host digest. It includes empty non-system schemas,
ordinary/unlogged/inherited/partition/materialized tables and every sequence's decimal
state, parameters and ownership. Enum labels, recursive array/domain types and actual
pgvector output are supported; unknown output functions/foreign tables/unpopulated
materialized views/denied reads fail visibly. Each query has a deadline, bounded
work_mem/temp_file_limit and a minimum available sort-space observation. Sequence
observations cannot freeze state: assurance remains operator attestation with observations.

Restore copies the input once into private scratch staging, hashes and reads that same
staged dump, checks exact source/quiescence links, uses the immutable source Postgres
image with no published port/network, restores with single-transaction/exit-on-error,
then inspects using its own live read-only snapshot. Every phase and cleanup failure
makes the current receipt fail. JSON serialization is atomic; previous receipts require
explicit overwrite and are archived, while refusal emits a separate failed-attempt file.
SIGINT/SIGTERM terminate only helper-owned children and flow through failure cleanup.
SQL stderr is drained without retaining row-value/credential-bearing diagnostics;
structured phase/code/exit/signal errors remain available.

The consumer parses external unknown values, validates phases and all supplied artifact
links, recomputes schema/table/sequence/content comparison and retains the complete
receipt. `--strict` remains capture artifact presence; `--require-restore-parity` is an
independent current-proof gate. Legacy original files remain unchanged and normalized
as `legacy-limited`, `reported_verified`, current `verified:false`. README retains its
repaired link to the existing full-Postgres runbook; assessment consumers are updated.

## Source-evidence corrections

The installed pg-boss uses `job_state` ENUM and LIST partitions; these are supported,
including actual leaf data and zero local parent rows. The backend predicate explicitly
allows idle known nonwriting launchers, including `logical replication launcher`,
but refuses client sessions, replication workers, WAL senders and unknown/extension
workers; active transactions are refused even for known backend types. Prepared SQL
positive/negative cases exercise that exact predicate, including an exact keeper PID
and a client lookalike. They have not been run by the author.

## Validation and evidence

Final commands, logs, SHA-256 manifests and source commit are recorded in the final
appendix after the immutable source gate run. Intermediate scoped tests and build passed.
The first full lint run failed only on the parent-owned
`docs/planning/evidence/2026-10-09-yuk1359-parent-canonical-sql.json` formatting;
that file was not edited by the author. Scoped helper/test lint passed.
The partition audit returned exit 0 with no P0 DB-tainted unit files, plus existing
cache/unmatched and advisory warnings. Schema/provider-lane audits returned exit 0.

The parent driver `/tmp/yuk1359-restore-count-failure-20261009.sh` remains unchanged
(SHA-256 `3b08c6985bf7c755c0e84ae1d8d042be718f999fa0accb7f4c605af61ba2330b`).
The scoped shell regression archives its bytes and runs the real shell entry point
with intercepted Docker/psql/migration transport, rejecting unknown commands without
real transport fallback. Inventory exit 17 now yields exit 1 and a valid failed receipt.
Original versioned parent reproduction receipts were not edited.

## UNRUN acceptance

`tests/restore-parity/canonical.db.test.ts` is prepared in the DB partition for actual
catalog/COPY-select SQL, quoted Unicode/newline identifiers, enum/vector/long JSON/binary
content, duplicates/reordering/same-count mutation, partition ONLY semantics, exact
never-called bigint sequence state and backend classification. Author did not execute it.
It is SQL evidence preparation, not a whole helper dump/restore or worker recovery test.

Parent must execute the real helper against a compatible isolated nonempty source,
including empty/quoted schemas, inheritance/partition leaves, actual repository types,
large streams, cached/never-called sequences and unsupported/denied/interrupted cases.
Then independently restore completed, eligible pending and held/unknown obligations
using existing main housekeeping-family fixtures, prove parity before any migration or
reopen, and demonstrate eligible completion once, unique completed effects and held
work with no new wire calls. No unmerged judge code/fixtures are included. Judge
provider/quota/crash obligations remain separate. No full DDL/roles/privileges/blob/
Mem0 or production-runtime certification is claimed.

No new actionable follow-up outside the already owned YUK-1359/YUK-1329 acceptance
obligations was created. Parent owns the Linear capture/status gate; author did not
access or mutate Linear.
