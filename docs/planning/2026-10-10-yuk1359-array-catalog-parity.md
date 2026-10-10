# YUK-1359 array catalog parity repair

Implementation lane on `fix/yuk-1359-restore-parity`, base `93eb29b09038dc9ea60c7292b5f92c576e0890f3`. Ownership is the five code/test files below and this document. Parent owns locked DB/runtime acceptance, CI and delivery. No delegation or new review was performed. R2 NONE covers helper `887012c2f10f2812b88a600340ec6ae869983b23` only; it does not cover this delta. No R3 was started.

## Verified cause

The immutable run07 receipt remains failed, verified=false, envelope version 2, algorithm `pg16-column-text-sha256-multiset-v1`. Receipt SHA-256 is `02a571cbf297c910cca6f214019165593844d0c2a80df212b69b4b2fb0dff9cc`. Source manifest and dump bytes match their recorded artifact bindings. The saved inventory difference contains only declaration dimensions 0 versus 1 for two queue-stats partitions' wait_bins/run_bins and their derived table hashes. Both columns have type `pg_catalog._int4` and chain array(_int4) -> builtin(int4); the tables are empty.

Read-only extraction of the custom archive's embedded DDL found separate CREATE TABLE statements for both partitions with wait_bins integer[] and run_bins integer[]. No pg_restore command was used to inspect those bytes. Installed pg-boss 12.36.0 `dist/plans.js:1760` creates these children with PARTITION OF.

[PG16 arrays section 8.15.1](https://www.postgresql.org/docs/16/arrays.html) documents that declaration dimension counts do not affect array runtime types. [pg_attribute](https://www.postgresql.org/docs/16/catalog-pg-attribute.html) describes attndims. The [inheritance implementation](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/commands/tablecmds.c#L2546) constructs inherited column types from OID/modifier without array-bound syntax. [pg_dump](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/bin/pg_dump/pg_dump.c#L8046) prints format_type(type OID, modifier) and [creates partitions separately before attaching](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/bin/pg_dump/pg_dump.c#L15295). These facts explain the saved catalog discrepancy; the new DB reproduction remains UNRUN.

## Representation and compatibility

`canonicalTableMetadata` validates the descriptor, column/root identity and complete type chain. Only a chain containing an actual array node canonicalizes dimensions to 0. This includes arrays, domains over arrays, arrays of domains and nested domain/array chains. Scalar metadata stays exact. Invalid roots, incomplete chains, scalar intermediates and recursive identities fail. The implementation uses no table/name allowlist or dimension-integer heuristic.

Collection, digest construction and manifest comparison share that representation. Row SQL is unchanged: full PostgreSQL column text values enter the JSON row, are SHA-256 hashed, sorted and streamed with duplicate multiplicity. Stored array dimensions, bounds, order, NULL distinctions and content remain in those bytes. Type identities, enum labels, domain NOT NULL/modifiers, collation and scalar metadata remain in the metadata hash and comparison. Existing domain CHECK handling and the non-exhaustive-DDL boundary are unchanged; the DB regression checks actual domain constraint rejection after restoration.

The content algorithm is `pg16-column-text-sha256-multiset-v2`. Source, receipt and outer manifest envelopes stay version 2 because their structure is unchanged; the mandatory algorithm field identifies the new digest meaning. Every table hash changes because the prefix changes, including scalar-only tables. V1, unknown and missing algorithms are explicitly unsupported. Cross-algorithm comparisons and versioned v1 receipts fail closed. No historical hash is recomputed from incomplete evidence, accepted through downgrade or relabeled. Legacy unversioned receipts still normalize to legacy-limited, reported_verified and verified=false. A pure read-only parser check rejects the actual run07 receipt's old algorithm while retaining its failed state.

## Validation

Node v24.19.0 from `/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin` was placed first in PATH; pnpm was 11.13.1.

- `pnpm vitest run --config vitest.unit.config.ts scripts/cutover-backup.test.ts src/core/migration/cutover-manifest.test.ts src/core/migration/canonical.test.ts scripts/restore-runbook-drift.unit.test.ts`: 194 passed, 4 files, `unit-02.log`. Coverage includes declarations 0/1/2/6, empty/nonempty digests, nested chains, long Unicode/2D/bounded/NULL array values, value tampering, element/domain/enum changes, scalar metadata, malformed chains and algorithm compatibility.
- `pnpm typecheck`: passed, `typecheck-02.log`; final confirmation in `typecheck-final.log`.
- `pnpm build`: passed, `build-01.log`. This is the normal repository bundle check, not a rebuild of the parent's sealed helper closure.
- Scoped Biome check on the five owned TypeScript files and `git diff --check`: passed. Final scoped log is `scoped-lint-final.log`.
- Full `pnpm lint`: FAILED on unchanged, already-committed `docs/planning/evidence/2026-10-10-yuk1359-parent-restore-attempt05.json` formatting, plus existing warnings. `lint-01.log` preserves the diagnostic. That file is outside this lane's ownership.
- Initial `unit-01.log` and `typecheck-01.log` failures remain preserved. They exposed passing rows/sha256 into the strict metadata parser and fixture label inference as never[]. Both were repaired before the successful checks.
- DB suite: UNRUN. Existing 13 cases and one new round-trip case are prepared. The new case reads real CATALOG_SQL and TYPES_SQL, hashes actual rows, creates genuine partitions, and uses PG16 custom dump/restore in an isolated test_fork database schema. It expects inherited 0/restored 1 before comparing canonical manifests. An empty leaf and three populated rows cover duplicate bounded 2D arrays, long Unicode, NULL/empty arrays, enums and nested domains. It then mutates dimensions/bounds/order/content/NULLs, domain NOT NULL and element type, requiring rejection. It also verifies domain CHECK rejection. No direct pg_catalog writes or fabricated array type identities are used.

Evidence directory: `/tmp/yuk1359-array-catalog-parity-20261010-qLsqV6`. `bindings-and-cause.json` records immutable run07 source/dump/receipt/difference and parent-evidence hashes, archive DDL, the unchanged lint blocker and owned source hashes. `old-receipt-rejection.log` records explicit v1 rejection. These new logs are outside the sealed prep. All run01-07/history/prep artifacts were left untouched. No DB, Docker, Testcontainers, provider, browser, restore command, deployment, push or PR operation was executed.

## Parent handoff and out-of-scope needs

1. Resolve the full-lint formatting blocker in the parent-owned attempt05 JSON while preserving historical content and failure claims. This lane stopped that repair because the file is outside ownership.
2. Update `docs/sub5-restore-cli.md:279` to v2 and explain unsupported v1 evidence with unchanged version-2 envelopes. The passing drift test checks restore controls, not the algorithm label; it does not prove this prose is current. README, the assessment runbook and shell consumers retain their version-2 envelope/CLI contracts. This lane stopped the runbook edit because it is outside scope.
3. Under the mutex, run `pnpm vitest run --config vitest.db.config.ts tests/restore-parity/canonical.db.test.ts`. The new case requires local PG16 pg_dump/pg_restore; RESTORE_PARITY_PG_DUMP and RESTORE_PARITY_PG_RESTORE may provide exact paths. Both majors are checked before dump/restore, and non-test fork database names are rejected. Do not use retained run07 or the main database.
4. Build a separately rebound helper CLI and pure bundle from this commit's source closure. Existing package-helper.mjs and pure-contracts.mjs still bind helper 887012; offline-check-v2.mjs:32 embeds algorithm v1. Rebind the new prep's revision/closure and meaningful offline fixtures to v2; regenerate metainput/output hashes, helper package, provenance and immutable seals, then independently verify. Preserve previous prep/history/runtime inputs and old v1 fixtures/failed receipts. This lane did not rebuild or modify those artifacts.
5. Use a fresh independently bound source/capture/restore attempt under the lock. V2 evidence requires fresh row scans and hashes. Run07 remains failed and cannot be promoted or reopened. Parent owns runtime acceptance, exact-head CI and delivery.

Linear capture: the blocker and remaining acceptance belong to existing YUK-1359; no new unrelated actionable defect was discovered. External tracker writes were outside this sub-agent's authorization. Parent must align its existing issue and handoff. PLAN/.remember and parent evidence were not edited.

## Owned source SHA-256

| File | SHA-256 |
| --- | --- |
| scripts/cutover-backup.ts | 06ba974b7646faac67781dbdbdc3b70c23612d328f4a76f399403fd65db1d6d2 |
| scripts/cutover-backup.test.ts | e5e5e7e82e0f12e2ec79e34e49abee43da858928ea8b276dbb8c01fb7fab4a44 |
| src/core/migration/cutover-manifest.ts | 3266eee6d5f0b663a823dec73bd9e83c9ff752fcf97ef33ad0ea28c9f01db070 |
| src/core/migration/cutover-manifest.test.ts | 358d24565ce7b07921f6744808f822e384e330824a7eb690f7affcedc89e6a60 |
| tests/restore-parity/canonical.db.test.ts | 9a677286703fccbfdbb5d2ac611cc9826e7cc01ee7624f5ccc651f415319e690 |

## Test portability correction

This correction starts from `f325d413957437c8fecfdfa6cd48840dd9b89dd2` and owns only `tests/restore-parity/canonical.db.test.ts` and this section. The parent reports that command-v and known Homebrew/Postgres.app paths contain no pg_dump/pg_restore, and that CI does not explicitly provision the required major. The new round-trip case therefore uses the already-installed `@testcontainers/postgresql` API and an owned `pgvector/pgvector:pg16` container with database `test_fork_1359`. This supersedes the host-binary/environment-override requirement in parent handoff item 3 above. No dependency or global setup changed.

The actual client connects to `getConnectionUri()`. Both PG16 executable versions are checked through `container.exec()`, which also runs the real custom dump and restore against the container's own loopback database. The archive stays at `/tmp/restore-array-catalog.dump` inside that container. Dump retains `-Fc --no-owner --no-privileges --schema=restore_array_catalog -f`; restore retains `--single-transaction --exit-on-error --no-owner --no-privileges`. Only the fixture schema in the owned database is dropped. Password/SSL options belong to individual exec calls; the test reads no host CLI override and changes no global environment or shared client.

Catalog/type queries and row digests explicitly use the owned client. The original 13-case describe body and array value fixtures are byte-for-byte unchanged. The new case retains inherited attndims=0/restored attndims=1 for empty and populated partitions, complete fixture catalog/type-chain comparison, duplicate populated rows, 2D/bounded/NULL/Unicode/domain/enum data, CHECK rejection and negative value/type mutations. Nested finally blocks attempt schema cleanup, close the owned client, and stop the owned container. A schema cleanup or client-close rejection still reaches container stop.

Static validation used Node v24.19.0 and pnpm 11.13.1. The following commands passed, with logs in `/var/folders/bt/rcf5s7tx3s93g3dz0046y96w0000gn/T/yuk1359-container-test-static-7eifewgk`:

- `pnpm exec tsc --noEmit --project /var/folders/bt/rcf5s7tx3s93g3dz0046y96w0000gn/T/yuk1359-container-test-static-7eifewgk/tsconfig.json`: scoped configuration extends the repository tsconfig, disables incremental output and includes only the owned test file plus its imported types/source.
- `pnpm exec biome check tests/restore-parity/canonical.db.test.ts`: passed without fixes or diagnostics.
- `pnpm vitest list --config vitest.db.config.ts tests/restore-parity/canonical.db.test.ts`: discovered the original 13 cases and the new round-trip case, 14 total. List mode disables DB global setup and fork setup. The existing Vite native-config import-extension warning remains.
- Static comparison against the pinned base confirmed the original 13-case describe body and array value fixtures are unchanged; `git diff --check` passed.

DB UNRUN. No DB/Docker/Testcontainers runtime, CLI installation, provider/browser, build, child delegation, R3, push or branch change was performed. Parent owns the locked scoped DB execution and any resulting runtime fixes, full lint/docs, Linear state, CI and delivery. No new follow-up was discovered outside the existing YUK-1359 acceptance obligation. The historical source-hash table above remains its earlier snapshot; the corrected test SHA-256 is `87d91a3bf94b843305430024be50a7ddfd734e06da6d3a9ede603a91678edae3`.

## Parent actual PG16 acceptance

Parent independently ran 194 scoped unit tests and full lint successfully. The first actual 14-case DB run passed the original 13 cases and the new case's dump/restore parity and array-value mutations, then failed because PG16 disallows altering the domain used by an array column. The failed log remains preserved.

The parent added an independent scalar domain and table for the NOT NULL metadata mutation. Array domains, enum values, multidimensional arrays, lower bounds, NULL distinctions, domain CHECK rejection and bigint-array type mutation remain tested. The corrected 14/14 DB suite passed against owned PG16 containers. Scoped typecheck and Biome passed. This is a test-only correction; the helper source remains f325d4139.

Both runs released their mutex after exact baseline container/release comparison. The second release initially refused while Testcontainers cleanup was settling; the lock was retained until only the original four containers remained. Final release was 2026-10-09T16:34:06.063132Z. See [parent evidence](evidence/2026-10-10-yuk1359-parent-array-parity.json). No full fresh helper capture/restore or restored DBOS reopen has passed yet. Historical run07 remains failed.
