# YUK-1404 ingestion assessment review continuation

Base: `b1e77b81777974d583d8eff50c7638a74959f392`, branch
`fix/yuk-1404-photo-import`. This lane implements a backend continuation for an
already saved question with an existing canonical reference. It does not establish
whole-issue, database, provider, UI, restore, CI or deployment acceptance.

## Callable consumer

The existing authenticated operation collection accepts:

```http
POST /api/ingestion-sessions/:id/operations
Idempotency-Key: optional-caller-key
Content-Type: application/json

{"kind":"assessment_review","input":{"block_id":"saved-block-id"}}
```

The existing `ingestion_operation` queue consumes the reserved operation. Poll
`GET /api/ingestion-operations/:id`: `result.status` is `admitted`, `withheld` or
`superseded`, with an explicit reason, actual canonical assessment receipt and
available runner provenance. A completed review with withholding still has
operation status `succeeded`; its result does not say the question was admitted.
The material save and imported session remain intact. The worker does not re-enter
import or move the session backward.

The block must belong to that ingestion session and bind either its imported
question or the current native capture identity. Question metadata must agree with
the block/session association. One physical standalone question, one canonical
part, one response slot and one scoring unit are supported. Supported criteria are
text keys, numeric keys, option sets and an existing semantic rule reference without
a probe specification. Multiple parts, matching pairs, holistic rules, unavailable
executors and unrepresentable contracts are withheld before model work.

## Frozen verification and paid-work evidence

Reservation derives `ingreview_v1_` plus a SHA-256 canonical identity from group,
revision ID, revision digest, admission generation and review policy version.
Different client keys reuse that operation. Client keys remain bound to their
original input, including aliases recorded when a canonical operation is reused.
Changing a caller key does not authorize another paid review of the same snapshot.

The accepted receipt freezes question version, block version, group, revision,
digest and admission generation. Before payment and again under the canonical
group lock before publication, the worker compares that binding. A stale result is
superseded; it does not automatically trigger another paid call.

Canonical conversion checks and executor validation precede model work. Subject
resolution requires every supplied knowledge identity to resolve to the same real
subject; there is no general-subject fallback. The comparison reference, options
and prompt come from the exact frozen part and scoring criterion. In particular,
printed structured leaf answers remain the reference even when the mutable row's
`reference_md` is null or different. The code never generates a replacement key.

The blind solve excludes original source-page photos, private scoring materials,
answer materials and mutable figure metadata. Only the target part's public frozen
figure materials with the supported normalizer role marker `figure (diagram)` and
verified SHA-256 references are accepted. Asset ownership, metadata and downloaded
bytes must agree with that frozen reference. Figure hints are projected from those
same materials. Complete structured text can be verified with its frozen choices;
legacy page-backed or ambiguous media contracts remain explicitly withheld. A
frozen digest and role marker do not prove absence of handwriting or printed
answers inside the pixels; that remains actual gold-media acceptance work.

`runSolveCheck` uses `release_strict`; only explicit `pass` qualifies. The existing
Practice runner is re-exported through its existing public seam and the sanctioned
kernel judge facade. It preserves task IDs, provider/model and cost evidence. Its
bound runner strips transient-retry opt-ins; `transientRetryEnabled` defaults false
and therefore the central task loop has one attempt per leg. A review can still
have a solver leg and a semantic comparator leg; this is not a claim about SDK wire
counts or real provider output quality.

The worker commits `review_started` before invoking the model and records actual
runner invocation identities through the supported `beforeProviderQuery` hook.
It stores a bounded parsed verdict/final answer, subject and provenance with a
digest in `review_result` before trying publication. No raw images, base64, full
input or thinking are stored in this operation ledger. Task-run metadata is not
used to reconstruct a missing model result.

A saved result permits only local settlement retry. A committed start with no
saved result remains `unknown_result`, including exceptions or timeouts that do
not prove the provider was never called. Corrupt evidence also fails closed. There
is no reset, automatic paid recovery, additional table or recovery loop.

## Execution owner and publication

The existing session advisory-lock helper owns an operation-wide execution lock
under `ingestion-assessment-execution` on a dedicated PostgreSQL client for each
execution, with a bounded acquisition deadline. Busy
delivery throws to the existing queue retry without writing an unknown or terminal
outcome. A normal duplicate waits for the first owner, then reads its terminal or
saved result; it cannot poison a live first invocation.

The pinned connection runs domain reads and short transactions. The original
pooled database handle runs the canonical runner, whose provider admission
heartbeats can start independent transactions. No transaction spans the provider
call. Before each provider leg, the inherited callback finishes first; the final
awaited owned transaction checks the original backend PID and exact granted
session lock, then writes the invocation receipt. Results and publication also
require ownership witnesses, including checks before issuing BEGIN on a possibly
replaced reserved wrapper. Detected ownership loss is sticky and prohibits further
provider legs or result/publication writes. A disconnect after a witness still can
mean a prompt was sent; it never authorizes replay as a guaranteed-unsent call.

Only after acquiring exclusive execution ownership can a remaining start without
result be treated as abandoned. The existing shared helper is unchanged. The
local client constructor copies the injected database's resolved target, Unix
socket/custom socket, authentication callback, TLS and timeout options; it does
not construct a URL or consult a global database target. Each client has `max: 1`,
separate queues and separate mutable parameter, parser, serializer and retry state.
The local wrapper closes that entire client after success or failure and preserves
both work and client-close errors if both fail. The runner retains the original
pooled database handle.

R1 identified a concrete installed-driver failure in the original pooled lock
path. With postgres 3.4.9, a reserved wrapper retained its connection slot across
disconnect/reconnect; its old `finally` unlock/release could target a successor
reservation and admit unrelated pooled work into the successor transaction. A PID
witness prevented publication but could not prevent that cleanup. Per-execution
clients confine the stale wrapper and its replacement backend to the old owner.
The constructor's narrow type assertion documents the driver's resolved-options
fast path, which accepts array hosts/ports despite its scalar public constructor
types. The offline actual-driver invariant proves isolation for this reproduced
slot-reuse behavior. Real PostgreSQL backend-kill, lock and transaction behavior
remain prepared gates.

The worker uses the canonical publisher with the frozen revision and admission
generation CAS tokens. Publication, verification and operation completion share
one transaction. It reads actual final lifecycle state before reporting admission.
Existing container availability, owner holds, suspension and withdrawal are
preserved. The lane adds no general-pool enrollment, FSRS state or draft promotion,
and does not widen the imported-source guard in `verifyAndPromote`.

## Retention, deployment order and restore

The common job-events deletion owner now deletes old rows only when they are not
both `business_table = 'ingestion_operation'` and
`starts_with(business_id, 'ingreview_v1_')`. That exact identity family is bound to
the reservation constructor. All accepted, alias, queued, running, invocation,
parsed-result and terminal receipts in the family persist indefinitely, including
unknown outcomes. Payload flags, accepted-row joins and a broad allowlist are not
used. Old ordinary events and the same prefix on another business table still
prune normally. Both legacy and DBOS prune consumers already call this owner.

Every deployed legacy and DBOS pruner must use this protection **before** any new
assessment-review producer is used. Once these obligations exist, rollback must
not restore the old unconditional pruner; stop new production creation and retain
the ledger instead. The portable learner archive intentionally excludes operational
state. Operational restoration requires a full PostgreSQL backup that includes
`job_events` and queue state. This lane does not expand archive or database schema.

## Validation and remaining acceptance

All commands below used `bash /tmp/yuk1359-offline-env.sh pnpm ...` with installed
Node 24.19.0 and pnpm 11.13.1. Tests and builds ran serially. Initial implementation
results at `19420aa15`:

| pnpm command | Outcome | Log under `/tmp/` |
| --- | --- | --- |
| `vitest run --config vitest.unit.config.ts src/capabilities/ingestion/server/assessment-review-evidence.unit.test.ts` | exit 0; eight scoring, privacy and paid-fence invariants | `yuk1404-admission-unit.log` |
| `typecheck` | exit 0; main and Start TypeScript checks | `yuk1404-admission-typecheck.log` |
| `lint` | exit 0; 210 existing warnings | `yuk1404-admission-lint.log` |
| `build` | exit 0; SPA, Start, server, worker and migration bundles | `yuk1404-admission-build.log` |
| `gen:postman` | exit 0; generated artifact updated | `yuk1404-admission-postman.log` |
| `gen:api-client` | exit 0; generated request union updated | `yuk1404-admission-api-client.log` |

Each of `audit:schema`, `audit:partition`, `audit:api-contracts`,
`audit:api-client`, `audit:api-client-usage`, `audit:capability-boundaries`,
`audit:provider-lanes`, `audit:provider-attempt-truth`, `audit:profile`,
`audit:task-census`, `audit:draft-status` and `audit:draft-status-reads` exited 0.
Their logs are `yuk1404-admission-audit-<name>.log`. Partition counts are 57 unit,
202 DB and one migration file, with no errors. Dependency ratchets remain exact:
431 capability-to-server, zero server-to-capability deep imports, and 48 cross
capability value edges. API-client reproduction was checked against the staged
generated artifact. The task census initially rejected an unresolved wrapper
argument; the wrapper now permits only the verifier's two solver task kinds and
semantic comparator, and its final census passes without an allowlist change.

R1's bounded client-lifecycle repair starts from `19420aa15`. The same offline
wrapper and serial execution produced these results:

| pnpm command | Outcome | Log under `/tmp/` |
| --- | --- | --- |
| `vitest run --config vitest.unit.config.ts src/capabilities/ingestion/server/assessment-review-evidence.unit.test.ts src/capabilities/ingestion/server/reference-origin.unit.test.ts src/capabilities/ingestion/server/assessment-review-client.unit.test.ts` | exit 0; 19 existing plus four client-lifecycle invariants | `yuk1404-r1-unit.log` |
| `typecheck` | exit 0; main and Start checks | `yuk1404-r1-typecheck.log` |
| `lint` | exit 0; unchanged 210 warnings | `yuk1404-r1-lint.log` |
| `build` | exit 0; all five build targets | `yuk1404-r1-build.log` |

Each of `audit:schema`, `audit:partition`, `audit:api-client-usage`,
`audit:capability-boundaries`, `audit:provider-lanes`,
`audit:provider-attempt-truth`, `audit:profile`, `audit:task-census`,
`audit:draft-status` and `audit:draft-status-reads` exited 0. Their logs are
`yuk1404-r1-audit-<name>.log`. Partition counts are now 58 unit, 202 DB and one
migration file; dependency ratchets remain 431/0/48. No API contract or generated
artifact changed in this repair.

The four new invariants exercise the production local client helper with the
actual installed driver: injected target/auth/socket/options with independent
mutable state; old reserved unlock/release after a lost owner's slot reconnect,
while a separate successor retains its lock and transaction; disposal after a
work failure while the original pool remains usable; and preservation of both
work and client-close failures. The initial socket fixture lacked `readyState`,
which made three disposal assertions fail; after correcting that fixture all 23
scoped tests passed. No real database behavior is inferred from these sockets.

The following 15 assessment-review cases and one retention case are prepared and
registered in the DB partition, **not executed**:

- Canonical identity reservation and client-key alias conflicts.
- Strict offline-model agreement, canonical verification/completion atomicity,
  container scope, session preservation and absence of FSRS enrollment.
- Structured printed keys with a null row reference and the actual queue consumer.
- Original-page exclusion and legacy-media withholding.
- Abandoned starts, uncertain provider outcomes, valid duplicate success and busy
  delivery without terminal poisoning.
- Distinct pooled runner and pinned domain backends; termination of the isolated
  execution backend, with exact/mismatch outputs, no old admission, an intact
  successor client's lock and transaction rollback, and continued original-pool
  usability.
- Stale bindings after edits and local receipt failure rollback followed by saved
  result reuse without another model invocation.
- Complete old event-chain retention, every terminal/unknown outcome, missing
  payload markers, and unrelated/ordinary/lookalike pruning.

The fake model seam in those prepared DB tests checks settlement and privacy; it
does not establish model correctness. The backend-kill test remains an unrun gate.
The separate offline actual-driver tests use only EventEmitter sockets and prove
the reproduced client-slot cleanup isolation without TCP, TLS, a listener or a
database. They do not establish real PostgreSQL or provider acceptance. No Docker,
DB connection, Testcontainers, service,
browser, provider, full local test suite, external publication or deployment ran.

Canonical conversion reports missing references as `missing_reference`; unsupported
criterion projections report `unsupported_scoring_contract`. No callable reference
correction or generation path is claimed here. Existing UI controls do not consume
this continuation yet. Multipart support, correction writers, historical reference
provenance, actual R03/R01 gold-media and provider reconciliation, full operational
restore, independent review and exact-head CI remain outside this lane's evidence.
