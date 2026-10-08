# YUK-1390 subject control domain operations

The five existing subject control HTTP handlers now consume the same typed operations exported by `src/capabilities/observability/public.ts`. Future Start callers can use those operations with an explicit `Db` and the public input schemas. This change does not implement a Start consumer or claim runtime acceptance.

## Ownership and transaction contract

The implementation owns only `api/admin-subject-control.ts`, `server/subject-control-operations.ts`, `public.ts`, the two new scoped tests and this document. The original `src/server/subjects/subject-control-write.ts`, `hydrate.ts`, and `api/subject-control-contracts.ts` remain unchanged. Parent-owned PLAN, handoff, W5 documentation, Start, runtime, PR and Linear work remain with the parent.

The public operations delegate to the original `renameSubject`, `retireSubject`, `restoreSubject`, `resetSubject` and `validateSubject`. Each writer owns its transaction. The shared operation waits for that transaction to resolve and, only for `kind: 'ok'`, awaits `hydrateSubjectRegistryFromDb(db)` once. Noop and rejected results do not hydrate. The operation does not construct Request/Response objects, obtain a global Db, or introduce retries, recovery or idempotency.

The original hydrate catches database errors, returns its report and keeps the last-good registry. A committed write can therefore return success while the registry still holds the previous value. That failure does not imply HTTP 500 or a transaction rollback. Unit tests of an unexpected hydrate throw cover an additional exceptional boundary only; the DB suite exercises the real never-throws path separately.

## Public signatures and schemas

```ts
renameAdminSubject(db: Db, input: RenameAdminSubjectInput): Promise<AdminSubjectControlResult>
retireAdminSubject(db: Db, input: AdminSubjectCasInput): Promise<AdminSubjectControlResult>
restoreAdminSubject(db: Db, input: AdminSubjectCasInput): Promise<AdminSubjectControlResult>
resetAdminSubject(db: Db, input: AdminSubjectCasInput): Promise<AdminSubjectControlResult>
validateAdminSubject(db: Db, input: ValidateAdminSubjectInput): Promise<AdminSubjectValidationResult | null>
```

`RenameAdminSubjectInput` is `{ subjectId: string }` plus the inferred rename body output. `AdminSubjectCasInput` is `{ subjectId: string }` plus the inferred CAS body output. `ValidateAdminSubjectInput` is `{ subjectId: string }` plus the inferred output of the running validate schema. All accept `Db`, not `Tx`; callers must preserve the writer's transaction ownership.

The public schemas are:

- `AdminSubjectControlParamsSchema`: non-strict object, trimmed nonempty `id`.
- `RenameAdminSubjectBodySchema`: non-strict object, nonnegative integer `expectedRevision` and string `displayName`. Empty strings pass boundary parsing and receive the existing domain invalid result.
- `AdminSubjectCasBodySchema`: non-strict object with nonnegative integer `expectedRevision`.
- `ValidateAdminSubjectInputSchema`: the original running non-strict `z.object({ traitPayloadOverrides: z.record(z.enum(SUBJECT_TRAIT_KINDS), z.unknown()).optional() })`. It accepts partial enum records and rejects alien kind keys. The declaration's object schema strips alien keys and is deliberately not substituted.

In the installed Zod version, parsing a partial enum record fills the omitted kinds with `undefined`. The original validator selects overrides with `Object.hasOwn`, so even a valid partial charter can produce `valid: false` after HTTP parsing. This behavior is retained. Start boundary callers should parse using the public schema and pass that output. Tests compare the same parsed input, and a full six-kind candidate proves the success/profile path.

`AdminSubjectControlResult` aliases the entire original `ControlWriteResult` discriminated union. `AdminSubjectValidationResult` aliases the entire original `ValidateSubjectResult`, including optional assembled `profile`. Neither operation crops its result to an HTTP declaration response schema.

The HTTP boundary still validates id, JSON, then body. Empty or whitespace-only validate bodies remain valid. Malformed JSON/body returns 400, unknown subject 404, and both valid and invalid candidate DTOs return 200. Stale results return 409 with `currentRevision`; conflicts return 409 without it; forbidden and invalid results return 422. Authentication and epoch handling remain boundary concerns.

## Verification performed by this writer

All commands used Node 24.19.0 from `/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin` and the existing pnpm 11.13.1. No installation or full test gate ran.

| Command | Exit | Evidence |
| --- | --- | --- |
| `pnpm vitest run --config vitest.unit.config.ts src/capabilities/observability/server/subject-control-operations.unit.test.ts` | 0 | `/tmp/yuk1390-unit.log`, 60/60 tests |
| `pnpm typecheck` | 0 | `/tmp/yuk1390-typecheck.log`, root and Start TypeScript configurations |
| `pnpm lint` | 0 | `/tmp/yuk1390-lint.log`, 290 warnings; scoped task files have no diagnostics |
| `pnpm build` | 0 | `/tmp/yuk1390-build.log`, web/Start/server/worker/migrate bundles built without execution |
| `pnpm audit:schema` | 0 | `/tmp/yuk1390-audit-schema.log`, 893 fields, zero unallowed stubs |
| `pnpm audit:partition` | 0 | `/tmp/yuk1390-audit-partition.log`, zero unmatched files and zero unmocked unit DB imports; six existing warnings outside this lane |
| `pnpm audit:api-contracts` | 0 | `/tmp/yuk1390-audit-api-contracts.log`, 173/173 declared, zero legacy |
| `pnpm audit:capability-boundaries` | 0 | `/tmp/yuk1390-audit-capability-boundaries.log`, exact debt ratchets 435/0/48 |
| `pnpm gen:postman` | 0 | `/tmp/yuk1390-gen-postman.log` |
| `git diff --exit-code -- postman` | 0 | `/tmp/yuk1390-postman-diff.log`, generated collection and endpoint inventory unchanged |
| `git diff --check` | 0 | `/tmp/yuk1390-diff-check.log` |

No baseline changed and no exemption was added. The initial unit run failed one incorrect assumption about enum-record output keys, `/tmp/yuk1390-unit-initial.log`; the assertion now preserves those undefined keys and verifies full/partial HTTP parity. Initial typecheck errors in new DB fixtures were corrected by parsing unknown seed payloads before spreading, forwarding the select overload's fields, and passing schema-parsed validate inputs. The final commands above passed.

Unit tests use the real public operations, original writers/validator and HTTP handlers. Db query and hydrate seams are mocked; the public barrel's unused blob adapter is fenced. Coverage includes all result variants, id/JSON/body ordering, complete response bodies, alien keys, empty bodies, parsed partial overrides, full six-kind candidates, post-commit hydration ordering/awaiting and failure without repeated calls.

## Parent-owned DB acceptance and delivery

The new `server/subject-control-operations.db.test.ts` contains 13 expected cases and has not been executed by this writer. It uses `resetDb()` with the real pool, no outer transaction/savepoint shim, an isolated registry, and a separate observer connection. Before real hydration it reads the committed revision and journal on that second connection. Both public and HTTP lanes cover rename, retire/restore and a real `kind: 'ok'` reset from a rich fork fixture. Reset preserves the orphan, shared payloads and trait journals. Rejections/noops/validate compare all fields in nine relevant tables plus the shared sequence state.

The failure cases delete a fixture root's history to prove writer rollback and no retry, and redirect only the post-commit top-level hydrate select to an absent relation. The latter must observe an actual PostgreSQL `42P01`, the real hydrate catch/report, preserved last-good registry, committed revision, exactly one added journal entry, one transaction and one hydrate attempt. Complete validate DTO parity includes nested/long candidates, full six-kind success, partial-record failure, absent/blank body, alien keys and unknown subjects.

After acquiring the project's DB lock, the parent should run:

```bash
PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH pnpm vitest run --config vitest.db.config.ts src/capabilities/observability/server/subject-control-operations.db.test.ts src/capabilities/observability/api/admin-subject-control-contracts.db.test.ts src/server/subjects/subject-control-write.db.test.ts src/server/subjects/hydrate.db.test.ts > /tmp/yuk1390-parent-db.log 2>&1
```

The parent retains independent review, any DB-driven repairs, PR, exact-head CI, Linear capture and delivery. No DB, testcontainer, Docker, service, provider, worker, replay, runtime action or lock acquisition was performed here. No additional actionable follow-up was found; Start consumption is already parent-owned work under YUK-1358/YUK-1359. This lane does not close those tasks.
