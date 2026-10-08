# YUK-1387 subject and trait domain reads

Implementation lane in `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1363-test-storage`, branch `feat/yuk-1387-subject-trait-domain-reads`. Implementation parent is `9dffa49d90799ea8742f9d5dff4418ac386b3270`, supplied by the parent owner on latest-main ancestry `6c6905fad`. No fetch or branch switch occurred.

## Implemented contract

`src/capabilities/observability/public.ts` directly re-exports the existing readers from `src/server/subjects/admin-read.ts`. There is no duplicate selector or wrapper. All queries in these readers use the supplied `Db | Tx` handle. Public signatures are:

```ts
listAdminSubjects(db: Db | Tx): Promise<AdminSubjectListRow[]>
getAdminSubjectTraits(db: Db | Tx, subjectId: string): Promise<AdminSubjectTraits | null>
listAdminTraits(db: Db | Tx, kind: SubjectTraitKind): Promise<AdminTraitCatalogRow[]>
getTraitJournalPage(db: Db | Tx, traitId: string, options: TraitJournalPageOptions): Promise<TraitJournalPage | null>
```

Public DTO exports are `AdminSubjectListRow`, `AdminSubjectTraits`, `AdminTraitBindingRow`, `AdminTraitCatalogRow`, `TraitJournalRow`, `TraitJournalPageOptions`, and `TraitJournalPage`. The options are `{ limit: number; cursor?: string }`; the page is `{ rows: TraitJournalRow[]; next_cursor: string | null }`. Existing complete DTO fields and ISO timestamps are preserved. The internal unbounded `getTraitJournal` remains unchanged and is not exported by the public seam.

The four HTTP modules now import these readers through `../public`. Subject detail still lists and finds. Params validation, error bodies/status/headers, existence versus empty, HTTP journal default 100 and cap 200, trait-bound cursor validation, canonical `data/page`, and legacy `journal/next_cursor` remain unchanged.

Registry version, notation, capability count, general-fallback facts, and resolution-cache effective/degraded facts remain process assembly facts. DB revisions and payloads come from the supplied handle. An uncommitted DB revision does not imply hydration or a new effective revision. No hydration/cache implementation, write implementation, composition, manifest, Start, UI, package, lockfile, PLAN or `.remember` changed.

## Verification performed in this lane

Every command below used `PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH`. Observed `node --version` and `pnpm exec node --version` both report `v24.19.0`; pnpm reports `11.13.1`. Existing dependencies were reused.

- `pnpm vitest run --config vitest.unit.config.ts src/capabilities/observability/api/admin-subject-domain-reads.unit.test.ts src/capabilities/observability/server/admin-domain-reads.unit.test.ts src/capabilities/observability/server/diagnostics-domain-reads.unit.test.ts src/capabilities/observability/server/event-detail.unit.test.ts src/capabilities/observability/server/today-cost.unit.test.ts src/capabilities/observability/manifest.unit.test.ts`: 116 tests passed in 6 files. The new mocked-public-seam HTTP contract suite contributes 31 tests. Log `/tmp/yuk1387-unit.log`. These tests prove delegation and HTTP contracts over mocked read results, not DB behavior.
- `pnpm typecheck`: passed, log `/tmp/yuk1387-typecheck.log`.
- `pnpm lint`: passed with 290 warnings, log `/tmp/yuk1387-lint.log`. No lint errors or test failures occurred.
- `pnpm build`: passed for SPA, Start, server, worker and migrate bundles, log `/tmp/yuk1387-build.log`. Building Start does not establish Start runtime acceptance.
- `pnpm audit:api-contracts`: passed, 173/173 declared, 0 legacy, 163 OpenAPI paths. Log `/tmp/yuk1387-api-contracts.log`.
- `pnpm audit:api-client`: passed, generated API client has no diff. Log `/tmp/yuk1387-api-client.log`.
- `pnpm audit:api-client-usage`: passed, log `/tmp/yuk1387-api-client-usage.log`.
- `pnpm audit:schema`: passed, 893 fields, 0 unallowed stubs. Log `/tmp/yuk1387-schema.log`.
- `pnpm audit:partition`: passed, no P0 unit/DB partition errors, 6 warnings in unrelated existing files. Log `/tmp/yuk1387-partition.log`.
- `pnpm gen:postman`: passed, 33 folders, 87 paths, 94 requests; `git diff --exit-code -- postman src/ui/lib/api-schema.generated.ts` passed. Spec and generated artifacts remain unchanged. Log `/tmp/yuk1387-postman.log`.
- `git diff --check`: passed.

The initial capability audit failed before the required mechanical ratchet synchronization. At that point, `pnpm audit:capability-boundaries` exited 1 solely because dependency debt decreased and its exact ratchet requires tightening. `observability -> subjects` is 11 versus baseline 14; total capability-to-server debt is 435 versus 438. There are no additional violations reported. Log `/tmp/yuk1387-capability-boundaries.log`.

The parent explicitly extended sole-writer scope to `scripts/capability-boundary-baseline.json` for these exact two downward counts. `pnpm audit:capability-boundaries:snapshot` passed and produced `/tmp/yuk1387-capability-baseline-proposed.json`; its debt object matches exactly the two-number change. The baseline now records total 435 and `observability -> subjects` 11. No other group, notes, allowlist or manifest changed. The initial failure log `/tmp/yuk1387-capability-boundaries.log` is preserved. The corrected `pnpm audit:capability-boundaries` passed; log `/tmp/yuk1387-capability-boundaries-green.log`. No artificial dependencies were added to preserve the old count.

## Prepared DB validation, not executed

The new `api/admin-subject-domain-reads.db.test.ts` contains 4 real-DB tests. Two transaction cases cover current and real journal-fallback assembly facts. Fixtures include retired/shared/custom subjects, all six complete seeded trait payloads, long charter text, nonzero revisions, and 205 journal rows with all six actions and historical provenance. The tests require nonzero results from all four public reads inside an uncommitted Tx, invisibility through the outside helper DB and production singleton, rollback, unchanged resolution-cache contents, and full row-content snapshots of every public table before/after reads. Snapshots digest rows, including projections and outboxes; they do not claim sequence state or host durability.

Committed fixture tests compare complete public/HTTP DTOs, list-and-find subject detail, all six catalogs, ISO timestamps, sharing/retirement, journal default/cap, complete descending pagination, bound/malformed/fractional cursors, existing empty versus missing, and read-only snapshots. Existing `admin-read.db.test.ts` assertions and rich reconcile/hydrate/thin-create fixtures remain intact; its three bounded subject/catalog imports now use the public seam. Its internal unbounded journal coverage remains internal. The existing subject-control contracts test remains unchanged and should run alongside the reads.

Parent command, under the parent's DB authorization/isolation:

```bash
PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH pnpm vitest run --config vitest.db.config.ts src/server/subjects/admin-read.db.test.ts src/capabilities/observability/api/admin-subject-domain-reads.db.test.ts src/capabilities/observability/api/admin-subject-control-contracts.db.test.ts > /tmp/yuk1387-parent-db.log 2>&1
```

Expected inventory is 15 tests across 3 files: 10 existing admin reads, 4 new public read tests, and 1 existing subject-control contract. This lane executed none of them and acquired no deployment lock. Independent review, exact-head CI, DB execution, PR, Linear and delivery remain parent-owned. No Start/browser/provider/runtime/deployment acceptance is claimed.

## Handoff

Changed-file SHA256 manifest will be `/tmp/yuk1387-sha256.txt` and covers all 11 owned changed files, including this document. Exact commit and parent are reported at terminal handoff. The writer releases ownership there. No additional actionable follow-up was discovered beyond the already-assigned DB/review/CI/Start acceptance; no external tracker operation was authorized or performed.
