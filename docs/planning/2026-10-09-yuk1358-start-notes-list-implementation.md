# YUK-1358 Start notes list implementation

Implemented the bounded native `/notes` LIST route and actual page consumer on `feat/yuk-1358-start-notes-list`. Starting HEAD was `ca538d6d623e51be12ddd55775299f3a09793f38`, with main base `7472f4395f4a12a5167e33034d5d8af8bf695049`. The delivery commit is recorded in the author handoff. This report and every listed source file are committed together. The working tree must be checked after that commit.

The approved migration plan is [notes list scope](2026-10-09-yuk1358-start-notes-list.md). This is source/offline completion only. No DB, Testcontainers, Docker, services, browser, provider, deployment, runtime locks, push, PR, watch, merge, or fetch operation ran. Parent owns integration, independent review, Linear capture/status, runtime acceptance and exact-head CI. No children were delegated.

## Behavior and implementation

`loadNoteList(database: Db | Tx, parsedQuery)` is the notes-owned operation shared by the real HTTP handler and Start reader. It calls the existing subject resolver only when subject is present, then the existing `listNotes` selector. Undefined filter and resolved empty set remain distinct. Public exports expose the authoritative query/response schemas and inferred types. No duplicate selector, pagination, manifest or write changes were added.

Start uses the existing token/epoch guard before query parsing, lazy domain/default DB imports or reads. Identity server-function validation leaves canonical parsing after authorization. Invalid inputs keep HTTP400 with exactly `{"error":"validation_error"}`; whitespace-only query is rejected after trimming, despite the existing schema comment. Domain errors become real Responses inside the ESM reader before the CJS host boundary. The client invokes the native Start function through `authenticatedStartFetch`, validates the full response schema, preserves status/code/details, and uses the existing401 token invalidation path.

`NotesPage` changes only its optional list-function injection. Its rendered JSX,250ms debounce, trimmed send behavior, subject tabs, copy, loading/error/retry/empty states and knowledge/detail navigation stay unchanged. Production SPA routing hands `/notes` back to the Start document; dev keeps the HTTP default. `/notes/:id` remains SPA fallback, and the detail API remains HTTP. The only existing event-test change is its migrated handoff inventory,13 to14 including NotesRoute.

Source discrepancy reported during implementation: this HEAD's `useSubjects` calls authenticated `/api/subjects` directly; neither `WorkbenchClient` nor `startWorkbenchClient` defines a subject-catalog method. The supplied claim that it already uses that Start client is not true at this revision. This lane preserves the existing hook/consumer and shell rather than expanding ownership. Parent must decide the separate remaining subject-catalog migration within YUK-1358/YUK-1359. No new tracker issue was created by this implementation lane.

## Verification

Runtime versions: Node24.19.0 at `/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin`; pnpm11.13.1 at `/opt/homebrew/bin/pnpm`. Commands below used that Node path. Selected test totals come from runners:44 across four files plus6 legacy-page tests across one file, and12 installed-protocol tests. The new conventions auto-select unit and prepared DB files; no partition registration was needed. Protocol tests use installed Start/Seroval serialization and emitted function IDs, with no server/browser execution. The emitted map contains 39 functions.

| Command | Exit | Selected tests | Local log |
| --- | --- | --- | --- |
| `pnpm vitest run --config vitest.unit.config.ts server/start/notes-list-read.unit.test.ts server/start/notes-list-client.unit.test.ts web/src/routes/NotesPage.start.unit.test.tsx web/src/routes/EventDetailPage.start.unit.test.tsx` | 0 | 44 | [unit-final.log](../../.cache/yuk1358-notes-list/unit-final.log) |
| `pnpm vitest run --config vitest.unit.config.ts src/capabilities/notes/ui/NotesPage.unit.test.tsx` | 0 | 6 | [legacy-page-unit.log](../../.cache/yuk1358-notes-list/legacy-page-unit.log) |
| `pnpm exec tsx --test tests/usability/start-rpc-fixtures.unit.spec.ts` | 0 | 12 | [protocol-final.log](../../.cache/yuk1358-notes-list/protocol-final.log) |
| `pnpm typecheck` | 0 | n/a | [typecheck-final.log](../../.cache/yuk1358-notes-list/typecheck-final.log) |
| `pnpm lint` | 0 | n/a | [lint.log](../../.cache/yuk1358-notes-list/lint.log) |
| `pnpm lint:ratchet` | 0 | n/a | [lint-ratchet-final.log](../../.cache/yuk1358-notes-list/lint-ratchet-final.log) |
| `pnpm build` | 0 | n/a | [build-final.log](../../.cache/yuk1358-notes-list/build-final.log) |
| `pnpm audit:schema` | 0 | n/a | [audit-schema.log](../../.cache/yuk1358-notes-list/audit-schema.log) |
| `pnpm audit:partition` | 0 | n/a | [audit-partition.log](../../.cache/yuk1358-notes-list/audit-partition.log) |
| `pnpm audit:api-client` | 0 | n/a | [audit-api-client.log](../../.cache/yuk1358-notes-list/audit-api-client.log) |
| `pnpm audit:api-client-usage` | 0 | n/a | [audit-api-client-usage.log](../../.cache/yuk1358-notes-list/audit-api-client-usage.log) |
| `pnpm audit:capability-boundaries` | 0 | n/a | [audit-capability-boundaries.log](../../.cache/yuk1358-notes-list/audit-capability-boundaries.log) |
| `pnpm audit:provider-lanes` | 0 | n/a | [audit-provider-lanes.log](../../.cache/yuk1358-notes-list/audit-provider-lanes.log) |
| `pnpm audit:profile` | 0 | n/a | [audit-profile.log](../../.cache/yuk1358-notes-list/audit-profile.log) |
| `pnpm audit:task-census` | 0 | n/a | [audit-task-census.log](../../.cache/yuk1358-notes-list/audit-task-census.log) |
| `pnpm audit:draft-status` | 0 | n/a | [audit-draft-status.log](../../.cache/yuk1358-notes-list/audit-draft-status.log) |
| `pnpm audit:draft-status-reads` | 0 | n/a | [audit-draft-status-reads.log](../../.cache/yuk1358-notes-list/audit-draft-status-reads.log) |
| `pnpm audit:api-contracts` | 0 | n/a | [audit-api-contracts.log](../../.cache/yuk1358-notes-list/audit-api-contracts.log) |
| `pnpm gen:postman` | 0 | n/a | [gen-postman.log](../../.cache/yuk1358-notes-list/gen-postman.log) |
| `pnpm audit:architecture-deepening` | 0 | n/a | [audit-architecture-deepening-final.log](../../.cache/yuk1358-notes-list/audit-architecture-deepening-final.log) |
| `pnpm audit:agent-control-plane` | 0 | n/a | [audit-agent-control-plane-final.log](../../.cache/yuk1358-notes-list/audit-agent-control-plane-final.log) |

Unit evidence covers401/503 before parse/domain import/default DB/read, canonical invalid subject/query and malformed objects, no-filter versus empty resolution, resolver-owned custom/alias orchestration, exact200-character query boundary, complete ISO DTO, error shaping, native RPC token/status handling, exact settled page markup, real subject hook,250ms timing, search clearing, loading/error/retry/empty states and unchanged navigation/detail HTTP API.

Capability debt is unchanged at433/0/48, with no baseline/allowlist edits or netting of new dependencies. Lint exits0 with290 existing warnings; ratchet stays within305. Partition audit reports zero unmatched files and zero unmocked DB imports in unit tests, with seven repository warnings. API contracts remain173/173 and163 OpenAPI paths. API-client and Postman generation leave their tracked artifacts unchanged. Builds emit web, Start, server, worker and migrate bundles; their runtime logger loading was not tested.

Preserved earlier failed checks: initial unit run selected30, with29 passing and one fake-timer scheduling failure in the new UI test (`unit.log`, exit1); fixed run selected30 and passed (`unit-fixed.log`, exit0). Initial typecheck (`typecheck.log`, exit1) found two test-only URLSearchParams union errors, repaired with defined-entry iteration. Final typecheck passes. No unresolved source/offline failure remains.

## Prepared parent gates

The new `server/start/notes-list-reader.db.test.ts` contains three prepared tests and was typechecked but never executed. It uses the real Start wrapper, HTTP handler, shared operation, resolver and selector. Fixtures include inherited domains, custom/unknown/alias subjects, synthetic root exclusion, archived nodes/ancestor cutoff and archived notes, mixed note/non-note types, long nested body, Unicode/markup/arbitrary strings, literal percent/underscore searches, case-insensitive title/body matching, combined filters, exact200-character validation, full ISO DTO and205 rows proving no list pagination. Transaction assertions require nonzero fixture counts, an independent pool observer that sees no uncommitted rows, transaction-local parity, all public-table count/content-digest snapshots and rollback restoration.

Authorized parent DB commands, prepared only:

```bash
pnpm vitest run --config vitest.db.config.ts server/start/notes-list-reader.db.test.ts
pnpm vitest run --config vitest.db.config.ts src/capabilities/notes/api/notes-list.db.test.ts src/capabilities/notes/server/notes-read.db.test.ts
```

Real built RPC/browser acceptance remains required for cold auth, malformed input, live subjects, search/empty/error-retry, note-detail and knowledge navigation,401 re-gate, epoch503 and no-write evidence. Prepared assertions, mocked unit reads and serializer transport are separate from real DB/browser acceptance. This task does not complete the whole Notes migration.

## SHA256 evidence and file scope

Local ignored evidence directory: `.cache/yuk1358-notes-list/`. Logs and emitted artifacts were hashed after the final build/protocol checks. The source manifest below contains all21 task-owned source/test files, including the inventory-count adjustment; the report excludes its own hash to avoid self-reference. Artifact manifest covers 893 files present under `dist/` and `web/dist/`, with paths and individual digests. No artifacts were executed.

| Manifest | SHA256 |
| --- | --- |
| `source-sha256.txt` | `4888c273e1a145d1427886f7100370e27aba4860e89426fb4577fe8b499a245e` |
| `logs-sha256.txt` | `f6491e264a7d9012cd65f8f177873e54da871e1b8adb26b02399cd96f6c1bf18` |
| `artifacts-sha256.txt` | `a1270539ff7d12a28a60c37630f4e513fc4a9331419cf87615c51206a9aee896` |
| `commands.json` | `af3678ebff5a3fe80a718816bca4975091f6b0f62362f80837107cb96da674ff` |

Source SHA256 manifest:

```text
2fe1f0f070510867c8b70b10f7e2dd4d25a4d92f696d8490bf0e88f3a44505ed  server/start/notes-list-client.ts
4b4d29632cde9fd13297370bf561244ba9c119a8f6c3f02735817d11690c3803  server/start/notes-list-client.unit.test.ts
1b7c7d19f40635242b591ca77070c4daa1ee250c054bf961dcc730691946f436  server/start/notes-list-function.ts
c366c182ea1c8360ca0a909487e57686146d3838d5e66d2fe8961f8a453ffaeb  server/start/notes-list-read.ts
bac9d74b8f535fa7fb5f6d3e34478877fbddf9c999015768219082244dbd2a69  server/start/notes-list-read.unit.test.ts
108aa98c7397a9b979a441565eb3d47a7d56bc16186f2350e963b9c90de8e5d4  server/start/notes-list-reader.db.test.ts
f6519f3d0fcf46e1efd0eb6ebea9d41956a34f06bfc176204d8f7349c8c4a4a8  server/start/notes-list-reader.ts
26bf080adee380c3375153f51d912f09733459f9419cb0bd7ea14a44620077bf  server/start/notes-list-test-fixtures.ts
72ddf0275d8d5491db8c9e8ddd97dad06d654bc712867df7cf2403c0fca977db  server/start/routeTree.gen.ts
933fc3bb5372e68d7bfc7c2e2741006e8b128e828574a9a19217f7d8830eee4b  server/start/routes/notes.tsx
582f06830bffeb4dcfcb683c4221519cf5e603598e8329c9a8c2e2a0db8a3f22  src/capabilities/notes/api/notes-list.ts
3ca4351cbbb9e356f4215bd2acc0bfdcd3d7aa1044a3b716f5de422c5bb24e44  src/capabilities/notes/public.ts
f45683ec85b027c74b88349c9406c2d826d8234c4723b92445f41ae0c6e76de0  src/capabilities/notes/server/note-list-read.ts
2f58bd6e3856f4a878c0c57b8e206de6836971fed7c07de84187cca05c2a71a3  src/capabilities/notes/ui-public.ts
653138ea1f5da4f767aab5b231e18d4a5c3109e50971e1aabf6b2252248d2fff  src/capabilities/notes/ui/NotesPage.tsx
e23f33fae9a918ef64d269b4693efaec1e7a55aa2ed332dc4529bdd13078d73c  src/capabilities/notes/ui/notes-api.ts
340553e0fb5123c4d23239496a988ba3e77cf5783230f919ccb69aaa2161dbdb  tests/usability/start-rpc-fixtures.ts
1e1eca2bbd592f1cce29decbe3cb3a6717894b4b30178e05a64e81211380504b  tests/usability/start-rpc-fixtures.unit.spec.ts
aa25871b249df14b4827c201c2f30a44c42166713e813a1795b89747f9f425e7  web/src/router.tsx
d35eb6e8de959d075ef9b9ad21845efd21f0e61586b6eb6f49dc647ad5ec7eb8  web/src/routes/EventDetailPage.start.unit.test.tsx
5e76b0e3b2dffac7ac44c5b587af5943cd475629e6f393036a68d4960e7432a9  web/src/routes/NotesPage.start.unit.test.tsx
```

Key emitted artifacts:

```text
4481370897bc928c4d56c766e95099f71187ebea406d9604d4b7af168122b2c4  dist/server.cjs
c7089a19f65492e216f2c92b197674cab7cc54e0524f4ecefa682473c110af76  dist/start/server/server.js
84fce7dd427f137bde28e0187eec4216c68e6977ff4f293ed98400fa9b79f0d5  dist/start/server/assets/__23tanstack-start-server-fn-resolver-CDRLZzXT.js
97e713a95932dcdf0e75f3c84cbfd63d067b676c4f1d58e65617186ad2ccbe85  dist/worker.cjs
8fcfcb15817b74fa668131d026a8371aa591c1d3363a95719aae984025bbc359  dist/migrate.cjs
```

Logs and hashes remain local ignored evidence for parent inspection. No PLAN, remember, existing ownership doc, packages/lockfile, Vite, boot/shutdown, judge, provider, schema/migration, job/task, note-detail/editor/presence or write source was edited. Writer is released after the delivery commit; this terminal task has no push/watch/restart authority.
