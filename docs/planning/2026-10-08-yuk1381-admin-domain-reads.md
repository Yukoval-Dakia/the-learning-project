# YUK1381 shared admin domain reads

## Scope and acceptance boundary

Implementation baseline `fadcb0c87ecb7dd4ff86d71983a99a532d699c08`, branch
`feat/yuk-1381-admin-domain-reads`, workspace
`/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1363-test-storage`.
This lane owns the four admin read handlers, `server/ai-observability.ts`,
`observability/public.ts`, two directly scoped tests and this note. Parent owns
PLAN, .remember, YUK1359 docs, Linear, independent review, actual DB acceptance,
PR, exact-head CI, runtime and deployment. No delegation, DB execution, services,
containers, providers, credentials, paid calls, replay, push or PR action occurred.
This slice does not complete the admin pages, Start integration or YUK1358/1359.

## Consumers and decision

The four HTTP handlers consumed `listAdminRunsPage`, `getAdminRunTimeline`,
`getAdminCost` and `getAdminFailureClusters` directly. Existing
`server/ai-observability.db.test.ts` also consumes these raw readers; its Date
contracts remain intact. Admin UI consumes generated HTTP operation types.
No Start consumer was added. HTTP now consumes the public loaders below.

The loaders accept only the caller's `Db | Tx`. They never construct a Request
or Response and never choose the global DB. HTTP still obtains its singleton DB
and keeps transport errors in the handler. Composition-root authentication is
unchanged. No aggregate, selector, recovery path or writer was added.

## Public signatures

All exports are available from `src/capabilities/observability/public.ts`:

```ts
loadAdminRuns(db: Db | Tx, opts?: AdminRunsOptions): Promise<AdminRunsDto>
loadAdminRunDetail(db: Db | Tx, opts: AdminRunDetailOptions): Promise<AdminRunDetailDto | null>
loadAdminCost(db: Db | Tx, opts?: AdminCostOptions, now?: Date): Promise<AdminCostDto>
loadAdminFailures(db: Db | Tx, opts?: AdminFailuresOptions): Promise<AdminFailuresDto>
```

- `AdminRunsOptionsSchema`: optional `limit`, `status`, `taskKind`, `cursor`.
  Limit must be a positive integer, defaults to 50 and caps at 200; status uses
  the existing running/success/failure enum. Cursor decoding remains in the raw reader.
- `AdminRunDetailOptions` uses the public `AdminRunParamsSchema`, `{ id: string }`,
  with the existing minimum length and no added trimming.
- `AdminCostOptionsSchema`: optional numeric `days`; strings are rejected.
  The existing raw reader remains the sole numeric window normalizer, including
  non-finite defaults, fractional truncation and 90-day cap. `now` defaults to one
  `new Date()` clock sample. The raw `getAdminCost` gains a compatible optional
  third `now` argument. It calls `readProviderCostAggregates(db, from)` with the
  existing lower bound only, including future rows and existing authority/dedup.
- `AdminFailuresOptionsSchema`: optional positive integer limit, default 200,
  capped at 200. The raw failure reader retains its original default of 50.

`parseAdminRunsQuery`, `parseAdminCostQuery` and `parseAdminFailuresQuery` are
public query-to-options adapters. Runs retains strict Number/positive integer
validation and original validation_error messages, enum, task_kind and cursor.
Cost retains parseInt/default 30 and the existing day normalizer. Failures retains
parseInt/default 200, invalid or nonpositive fallback 50 and max 200, including
numeric overflow. These functions contain no Request/Response dependency.
Existing query, params and response schemas are also re-exported for consumers.
RPC composition should validate its own inputs and call these public loaders;
authentication and HTTP/RPC error translation stay at that boundary.

## Complete DTO contract

DTO types derive from complete raw reader types. Responses are not parsed through
Zod, so old wire fields cannot silently disappear. Projection uses typed object
spreads and explicit ISO conversion; it uses no JSON serialization roundtrip or
unsafe assertion.

- `AdminRunDto` preserves every run field and replaces `started_at` and
  `finished_at` with ISO strings, retaining finished_at null.
- `AdminRunsPageDto` replaces rows with those DTOs. `AdminRunsDto` adds the existing
  `data` and `page` collection fields while retaining `rows`, `limit`,
  `next_cursor`, `total`, `truncated` and property insertion order.
- `AdminRunDetailDto` retains run, every ledger column and every selected tool
  column. Both nested occurred_at values and every timeline at value become ISO
  strings. Timeline optional undefined properties are explicitly omitted;
  nullable cost/provenance/job fields stay null. Raw payloads are not mutated.
- `AdminCostDto` is the existing AdminCostResponse, with days_window, days,
  by_task and by_truth. USD/CNY, reported/estimated/unknown/legacy provenance,
  known-zero amounts, tokens, calls and all existing sorting remain intact.
- `AdminFailureClusterDto` retains the cluster fields and converts latest_at and
  every sample started_at to ISO. `AdminFailuresDto` retains clusters and limit.
  Grouping, 80-character normalized prefix, recent bounded row selection,
  descending count/latest ordering and five-sample cap stay in the raw reader.

### Detail invalid-params baseline adjudication

Baseline `api/admin-run-detail.ts` uses `AdminRunParamsSchema.parse(params)` and
catches with kernel `errorResponse`. That function handles ApiError, but treats
ZodError as an unhandled exception and returns
`500 { error: 'internal_error', message: 'Internal Server Error' }`.
`server/app.ts` passes params to the handler without request-schema parsing.
Parent verified this source path and adjudicated that YUK1381 keeps the baseline.
The original brief's "preserve detail 400 params parse" was an incorrect assumption,
not a requested behavior change. The added unit tests directly invoke the handler
with missing or empty params and prove generic 500 without DB reads or error
detail leakage. The normal `[id]` route requires a nonempty captured path segment;
these direct-handler cases do not establish malformed actual-route behavior.
The existing 404 `not_found` body also remains unchanged. Start must use the
exported schema to validate its boundary and translate errors itself; parent
will hand that integration to the main lane. No decision or permission is pending.

## Local validation

Final checks executed on Node v24.19.0 and pnpm 11.13.1, without installing
dependencies. Every command fixed
`PATH="/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH"`.
Earlier Node 26 runs are superseded by these Node 24 results.

| Command | Result | Log |
| --- | --- | --- |
| Scoped unit command below | 74 tests, four files passed | `/tmp/yuk1381-unit.log` |
| `pnpm typecheck` | Passed, including Start tsconfig and prepared DB tests | `/tmp/yuk1381-typecheck.log` |
| `pnpm lint` | Passed, 294 existing warnings | `/tmp/yuk1381-lint.log` |
| `pnpm build` | Passed, SPA/Start/server/worker/migrate bundles | `/tmp/yuk1381-build.log` |
| `pnpm audit:partition` | Passed, zero P0; six existing warnings | `/tmp/yuk1381-partition.log` |
| `pnpm audit:capability-boundaries` | Passed, exact ratchets | `/tmp/yuk1381-boundaries.log` |
| `pnpm audit:api-contracts` | Passed, 173/173 declared, 163 OpenAPI paths | `/tmp/yuk1381-api-contracts.log` |
| `pnpm gen:postman` | Passed; endpoint specs and generated collection unchanged | `/tmp/yuk1381-postman.log` |

```sh
PATH="/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH" \
  pnpm vitest run --config vitest.unit.config.ts \
  src/capabilities/observability/server/admin-domain-reads.unit.test.ts \
  src/capabilities/observability/server/today-cost.unit.test.ts \
  src/capabilities/observability/server/event-detail.unit.test.ts \
  src/capabilities/observability/manifest.unit.test.ts
```

Unit tests exercise the real public loaders and actual HTTP handlers with a mocked
DB seam. They cover complete rich detail/collection byte parity with raw-reader
JSON, nulls, undefined omission, nested usage extras, dates, errors, missing detail,
cursor failure, limits and query coercion, cost projection/injected DB/clock,
numeric-window normalization, failure grouping/prefix/order/sample cap.
These are source and mocked-seam checks, not real DB or deployed acceptance.

## Prepared DB command, not executed

```sh
PATH="/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH" \
  pnpm vitest run --config vitest.db.config.ts \
  src/capabilities/observability/server/admin-domain-reads.db.test.ts \
  src/capabilities/observability/server/ai-observability.db.test.ts \
  src/capabilities/observability/api/admin-observability.db.test.ts
```

Five new DB regressions are prepared through the shared public consumer: real
uncommitted Tx values with singleton invisibility and deliberate rollback;
all-public-table full-content digest equality before/after reads; filtered
same-time pagination and total invariance; rich raw/DTO/HTTP byte parity; mixed
currency/truth/known-zero/provider dedup/tokens/calls with exact inclusive lower
boundary and future rows; bounded recent failure grouping/order/sample cap.
These fixtures perform writes only when the parent runs the suite under its
mutex. Existing raw reader and HTTP DB tests are preserved. No DB PASS is claimed.

## File receipts and protected scope

The following SHA-256 values identify the final product/test files. The complete
nine-file receipt, including this document's hash, is written to
`/tmp/yuk1381-sha256.txt` at handoff.

| File | SHA-256 |
| --- | --- |
| `src/capabilities/observability/api/admin-runs.ts` | `ed3408d28c6d9d363797a289e51de5bdf79eb7252f83cf7a6a651dab378cea8f` |
| `src/capabilities/observability/api/admin-run-detail.ts` | `31c504105ca11cd78a4e3c039495e42f50af65d9581c7b7ab6e4f54c7cdf164c` |
| `src/capabilities/observability/api/admin-cost.ts` | `57323fab7780c4d414213e04fd8eb190fd4b2b4f5430a7418972e65aaa994280` |
| `src/capabilities/observability/api/admin-failures.ts` | `4a5dddc69e59a105b4a3771ceda2ba76ee358040d71d23984a3cc86438f51eb4` |
| `src/capabilities/observability/server/ai-observability.ts` | `a2e75da74ea43f0d5bfd0ce08dcb711b7ea58fff7a69b0a6234d9e06f5f54e67` |
| `src/capabilities/observability/public.ts` | `5ea23a2bb0acb52106d1f4ada6b12f12ad3099621ac015bc2ff9b05dac75a8b3` |
| `src/capabilities/observability/server/admin-domain-reads.unit.test.ts` | `8c58359d10d80ef28fa5af6d70d0119d66d564b5fdb320b5d0fa4d6298dc937a` |
| `src/capabilities/observability/server/admin-domain-reads.db.test.ts` | `ccad94e0ae2ae9f9741b9fec535eec10ee0619773b4b8d49a493c134eb7d2a99` |

Protected implementation paths are unchanged relative to the supplied baseline:
Start, UI, manifest, kernel, config writer, provider-cost-projection, coverage,
conjecture, package/lock and existing tests. Postman outputs also remain unchanged.
Parent-owned PLAN, .remember/now.md and a new YUK1359 W5 document changed
independently while this lane ran; they are left intact and excluded from staging. No other worktree was
accessed. This lane performed no Linear capture, because the parent owns tracking;
the only newly discovered contract discrepancy is recorded above with the parent's baseline-preserving adjudication.
