# YUK-1380 event detail and correction domain

The current HTTP event routes now consume two injected operations exported by
`src/capabilities/observability/public.ts`. Start can use the same operations and
validation schemas when its owner mounts the future consumer. This lane does not
implement Start, the entire event page, or complete the migration.

Workspace is `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1363-test-storage`,
branch `feat/yuk-1380-event-domain`, base
`6150f01a949c3d1357f8b44f0d8ed6807cd74179`. Main thread 57961995 owns Start and
YUK-1356. This lane has one code writer and no children. PR 1606 is unrelated and
untouched.

## Public contract

```ts
readEventDetail(db: Db | Tx, eventId: string): Promise<EventDetail>
createEventCorrection(
  db: Db | Tx,
  eventId: string,
  input: unknown,
  now?: Date,
): Promise<EventCorrectionResult>
```

`EventDetail`, `EventCorrectionInput`, and `EventCorrectionResult` are inferred
from the existing `EventDetailResponseSchema`, `EventCorrectionBodySchema`, and
`EventCorrectionResponseSchema`. These schemas and `EventParamsSchema` are also
exported through public.ts. Correction input stays `unknown` at the boundary so
Start and HTTP both receive runtime validation without asserting an input type.
Callers can use `EventCorrectionInput` to construct their validated inputs.

The domain imports Db/Tx only as types. It has no singleton database, Request,
Response, authentication, query, event selector, or event writer implementation.
It calls existing `getEventById`, `getEventChain`, and `writeEvent` unchanged.
Authentication remains the caller's responsibility.

Every focal, parent, child, and correction envelope gets an explicit
`created_at.toISOString()` projection. The projection preserves all other
defined fields, including dispatch_seq and extra envelope fields, and omits
undefined envelope entries. The existing passthrough response schema validates
the resulting DTO. There is no JSON roundtrip or unsafe transport assertion.
Passthrough extras have the existing schema's unknown type; dispatch_seq is
preserved as its runtime number. Kernel Date types remain unchanged.

## Preserved behavior

- ID validation trims and requires a nonempty value. HTTP validates route params
  before reading JSON, preserving missing-ID precedence. The domain uses the
  same schema for direct callers.
- Correction validation uses the existing body schema, including replacement
  iff supersede, trimmed reason of 1 through 2000 characters, and nonempty
  affected_refs. Issue formatting, ApiError codes, and 400/404 behavior remain.
- Missing targets return not_found. Corrupt stored focal or chain data throws;
  the HTTP boundary uses the existing generic 500 errorResponse. The kernel
  status fold's malformed-correction skip and chain parser's rejection remain
  distinct behaviors.
- Corrections use actor user/self, action correct, subject event/target, outcome
  success, caused_by_event_id target, and the parsed original payload. They
  append through the sole kernel writer and retain pending ingest. Original
  rows remain immutable. Advisory locking, transaction/savepoint rollback,
  scope tagging, and outbox behavior stay in the kernel.
- Each invocation generates a fresh ID. Identical HTTP requests produce
  separate correction events. Kernel first-write-wins applies only to the same
  event ID; this change introduces no request idempotency or payload dedup.
- An explicit Date can be injected. The default clock is sampled once at
  operation entry and retained across asynchronous target reads.
- Canonical correction creation remains 201 with an encoded event Location.
  Legacy POST remains 200 with its existing Deprecation and successor Link.
  Error responses and caller authentication boundaries remain intact.

## Evidence

Local commands ran using Node v26.10.0 and pnpm 11.13.1. No install or dependency
change was performed. The build targets Node 24 as configured in the repository.

| Command | Result | Log |
| --- | --- | --- |
| `pnpm vitest run --config vitest.unit.config.ts src/capabilities/observability/server/event-detail.unit.test.ts src/capabilities/observability/server/today-cost.unit.test.ts` | 28 passed, including 20 new event tests and 8 existing Today-cost tests | `/tmp/yuk1380-unit.log` |
| `pnpm typecheck` | exit 0 | `/tmp/yuk1380-typecheck.log` |
| `pnpm lint` | exit 0, 297 existing warnings | `/tmp/yuk1380-lint.log` |
| `pnpm build` | exit 0, web/Start/server/worker/migrate bundles built | `/tmp/yuk1380-build.log` |
| `pnpm audit:partition` | exit 0, no P0 unmocked DB imports, no unmatched tests | `/tmp/yuk1380-partition.log` |
| `pnpm gen:postman` | exit 0, no contract or generated collection diff | `/tmp/yuk1380-postman.log` |

Scoped Biome formatting was limited to owned source/tests. The final DB-test
fixture formatting and typecheck/lint recheck logs are
`/tmp/yuk1380-db-format-final.log`, `/tmp/yuk1380-typecheck-final.log`, and
`/tmp/yuk1380-lint-final.log`. Protected-file verification and the final changed
file hashes are in `/tmp/yuk1380-protected-check.log` and
`/tmp/yuk1380-implementation-hashes.sha256`.

The new DB suite authors 11 cases: uncommitted nonzero Tx evidence invisible to
the singleton, rollback, focal/parent/child/correction wire parity, unchanged
original rows, sequential four-kind corrections with tied timestamps and
deliberately reverse lexical IDs, dispatch chronology, pending ingest, invalid
input without writes, missing versus corrupt payloads, malformed correction
fold versus chain behavior, and canonical/legacy HTTP contracts with distinct
IDs for repeated requests. These are fixtures, not observed DB acceptance.

The parent owns real DB execution under its runtime lock, independent review,
exact-head CI, delivery, and tracker updates. Parent's scoped command, **not run
by this writer**, is:

```bash
pnpm vitest run --config vitest.db.config.ts \
  src/capabilities/observability/server/event-detail.db.test.ts \
  src/capabilities/observability/api/event-detail.db.test.ts \
  src/capabilities/observability/api/event-correct.db.test.ts
```

No DB, container, service, runtime, provider, paid call, push, PR, Linear, PLAN,
or .remember operation was performed. No new material separate issue was found;
the existing corruption policies and request retry semantics are preserved and
documented above. This lane does not claim deployment, Start acceptance,
independent review, or exact-head CI success.
