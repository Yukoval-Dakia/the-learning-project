# YUK-1567 — Cancel Unsent Paid Intents (generic `pending → cancelled`) — Ops Manual

Status: implementation slice (code + docs only). **Nothing in this document has been
executed against any database.** Every operational step below is `NOT_RUN` in this
slice and is written for the parent/migration line to execute later on the approved
deployment DB.

## 1. What this is

A generic, auditable, fail-closed cancellation path for paid-effect intents that were
persisted as `pending` but provably never physically sent:

```
pending ──(never sent, explicit approval, immutable receipt)──▶ cancelled (terminal)
```

- `cancelled` is a **terminal resolved state**: no provider was ever invoked for this
  identity, no authorization is minted, no successor is bound, and no row, job, or
  queue is deleted. The original `paid_effect` row — its full five-part identity, its
  frozen `input_json`, and its history — is preserved.
- Distinct from `voided`: `voided` retires an `unknown` obligation (a send already
  attempted, outcome unresolved) and binds a successor authorization. `cancelled`
  seals a `pending` intent whose send **never happened**. Do not reinterpret, rename,
  or migrate between them.
- Generic paid capability: the store function knows nothing about admission; the two
  currently-approved identities arrive exclusively through the manifest. Nothing in
  the library hardcodes a family, entity, or count.
- Not exposed to models, agent tools, copilot tools, or any automatic caller. The only
  invoker is the ops CLI below, run by an operator.

## 2. Guarantees

| Guarantee | Mechanism |
|---|---|
| Exactly one winner between cancel and a real send claim | Cancel runs inside one transaction that takes the family control advisory lock **first**, then locks the identity row `FOR UPDATE`, then the entity advisory — the same pinned order as every claim/void. A concurrent claim serializes; the loser either sees `cancelled` (held) or the cancelled row's CAS fails. |
| Never-sent proof is live, not historical | The CAS requires `state='pending'` **and** `fence=expected_fence`; the function additionally verifies `delivery_id`, `delivery_backend`, `delivery_tick`, `send_lease_expires_at`, `result_json`, `result_recorded_at`, `application_json`, `applied_at` are **all NULL** before writing anything. `full_row_md5` from pre-0124 evidence is a pre-migration observation (0124 added nullable columns that change whole-row JSON) and is **never** used as a compare token anywhere. |
| Idempotent replay, immutable history | Replaying the same `request_id` returns `already_cancelled` with the **stored** receipt verbatim — changed reason/operator/fence under the same id rewrites nothing. A different `request_id` on a cancelled identity throws `PaidEffectCancellationError` and never mints a second event. `paid_effect_cancellation`'s primary key is the identity itself, so an identity can be cancelled at most once, ever. |
| Event and state are atomic | `paid_effect_cancellation` is inserted in the **same transaction** before the `pending → cancelled` CAS. Any event failure rolls the transition back with it. |
| Cancel authorizes nothing | No `paid_effect_authorization` row is created; if the target is the **bound successor** of an existing authorization row, the cancel refuses (`PaidEffectAuthorizationError`) — this slice never unbinds an authorization gate. |
| Dead end for downstream consumers | `reservePaidEffect`/`claimPaidEffectSend` treat `cancelled` like `sending`/`unknown`/`voided` → `held`, never a send. `admitPaidEffectIntent` returns `existing`/`cancelled`. `listPaidEffectObligations`'s unfinished list excludes it. Admission `receipt.ts` excludes cancelled rows from reconciliation and returns `held` for the cancelled identity. `reauthorization.ts` treats cancelled rows as resolved history (they block nothing, and can never be voided or successor-bound). The DB `paid_effect_state_shape_ck` CHECK constrains cancelled rows to the exact never-sent shape. |

## 3. Files

| Path | Role |
|---|---|
| `src/core/migration/paid-effect-protocol.ts` | `'cancelled'` in `PAID_EFFECT_STATE_SCHEMA`; `PaidEffectCancelRequest`, `PaidEffectCancelReceipt`, `PaidEffectCancellationError` |
| `src/db/schema.ts` | `paid_effect.cancelled_at`/`cancel_json`; `'cancelled'` in `paid_effect_state_ck` + `paid_effect_state_shape_ck`; new `paid_effect_cancellation` event table |
| `src/db/paid-effect-store.ts` | `cancelPaidEffectUnsentIntent` (the atomic cancel), `evaluatePaidEffectCancelEligibility` (the ops gate shared by plan/apply), `readPaidEffectCancellations`, snapshot fields, held-on-cancelled |
| `src/capabilities/practice/server/admission/receipt.ts` | Excludes cancelled rows from reconciliation queries; `held` on cancelled |
| `src/capabilities/practice/server/admission/reauthorization.ts` | Cancelled treated as resolved history (see §9 — outside the original allowed-path list; reason recorded) |
| `drizzle/0127_yuk1567_paid_effect_cancellation.sql` + `drizzle/meta/{_journal,0127_snapshot}.json` | Incremental migration only; no existing row or migration is touched, 0124 is not renumbered |
| `src/server/export/constants.ts` | `paid_effect_cancellation` in `PAID_EFFECT_BACKUP_TABLES` (and thus `FK_ORDER`, before `provider_attempt`); `SCHEMA_VERSION` `4.29 → 4.30` |
| `scripts/yuk1567-cancel-unsent-intents.ts` | The ops CLI below |

## 4. Command signatures

```
# Read-only: one repeatable-read snapshot evaluates every manifest target,
# then freezes a write-once plan artifact. Mutates nothing.
tsx scripts/yuk1567-cancel-unsent-intents.ts plan  <manifest.json> --out <plan.json>

# Mutating: one transaction PER TARGET, in manifest order —
#   family advisory lock → eligibility re-check under locks →
#   cancelPaidEffectUnsentIntent (event insert + pending→cancelled CAS, atomic)
# then freezes a write-once receipt artifact.
tsx scripts/yuk1567-cancel-unsent-intents.ts apply <manifest.json> --out <receipt.json>
```

- Both modes require `DATABASE_URL === YUK1567_DATABASE_URL` (explicit operator
  approval of the exact deployment DB; mirrors the reopen CLI's TEST guard).
- `--out` artifacts are **write-once** (`fs.open('wx')`) — a second run to the same
  path refuses; keep them under the evidence directory for the operation.
- `plan` exit code `0` when every target is eligible, `1` otherwise (artifact is still
  written with per-target `failures`).
- `apply` exit code `0` when every target settled as `cancelled` or
  `already_cancelled`; `1` if any target failed (failures are recorded per target in
  the artifact; each target's transaction is independent — a failed target never
  half-writes and never blocks a sibling's own atomic decision).
- The CLI never enqueues work, clears queues, edits jobs, stops workers, resends, or
  calls any provider. It reads/writes only `paid_effect`, `paid_effect_authorization`,
  `paid_effect_cancellation`, `paid_effect_control` (advisory), `pgboss.job`,
  `event`, and `event_subscription_delivery` — reads for gates, writes only inside the
  per-target cancel transaction.

## 5. Manifest schema

```jsonc
{
  "version": 1,
  "request_id": "yuk1567-cancel-20261020-01",   // operation idempotency anchor; non-empty
  "operator":   "<operator identity>",           // human/agent running apply
  "reason":     "<why these intents are being cancelled>",
  "basis":      "<authorization basis: lead/owner approval reference>",
  "watch": [                                     // enqueue pipelines that could still
    {                                            // mint work for the entity; [] = none
      "action": "experimental:assessment_publish",
      "subscriber_id": "practice.question-admission-enqueue"
    }
  ],
  "targets": [                                   // EXACT batch scope — apply iterates
    {                                            // only this list, one tx each
      "family":           "question_admission_run",
      "entity_id":        "<entity id>",
      "entity_revision":  "<revision>",
      "unit":             "admission@3",
      "input_digest":     "sha256:<64 hex>",
      "expected_fence":   0
    }
  ]
}
```

Rules enforced by the CLI / store:

- `targets` nonempty; duplicate five-part identities in one manifest are rejected
  before any write.
- `expected_fence` is the CAS token observed at approval time (`0` for the two
  approved targets). A drifted fence at apply time fails that target closed.
- One `request_id` covers the whole manifest — the two approved targets are one
  approved operation. A later apply with a **different** `request_id` on an
  already-cancelled identity fails closed.
- `watch` semantics: for each `(action, subscriber_id)` pair, every `event` row
  matching the action and referencing the entity (by `subject_id` or payload text)
  must already have an `event_subscription_delivery` row for that subscriber. An
  undelivered event — work that could still mint a claim — fails eligibility.
- The manifest is authored from the **frozen approval evidence**, not discovered by
  the CLI. The CLI never fishes for paid rows by group, actor, time window, or state;
  it only ever reads/writes the exact listed identities (plus entity-scoped *read*
  gates below).

## 6. Controlled identity sources (provenance)

The two approved targets are fixed by the lead's frozen evidence inventory:

- `/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-yuk1567-cancel-unsent-20261020/approved-targets-evidence.json`
  — SHA `c9ecd6415008a0f364e6500e0b8093fc0959bdf6ba59dcf0637f9fdd158321ff`
- Background evidence: `two-pending-disposition-20261019.md`,
  `two-pending-live-20261019.json`, `two-pending-source-20261019.txt` (same review dir,
  `stage1-yuk1406-stock-math-census-20261019/`).

Both rows: `family = question_admission_run`, `unit = admission@3`,
`entity_revision = 9`, `fence = 0`; entity ids `i2ytzyvs4h8uy1f9hcvp09r9` and
`q31srw8d0ukxolz33fzmelnp`; created by `solution-generate:reference_backfill` with
their admission jobs completed and no output; all delivery/lease/result/application
columns NULL at observation.

**Provenance rules for authoring the real manifest:**

1. Copy the five-part identity (`family`, `entity_id`, `entity_revision`, `unit`,
   `input_digest`) and `fence` from the evidence into `targets`, `fence` →
   `expected_fence`.
2. Do **not** copy `full_row_md5` — it is a pre-0124 whole-row observation and is not
   a CAS token. The agreed compare is identity + `expected_fence` + the live
   never-sent predicate re-verified under locks at apply time.
3. `watch` for this operation is the admission enqueue pipeline:
   `action = experimental:assessment_publish`,
   `subscriber_id = practice.question-admission-enqueue`.
4. Choose a fresh `request_id` for the real operation (do not reuse this doc's
   example); record `operator`, `reason`, `basis` naming the lead approval.

## 7. Evidence — before cancel

Collect before `apply` (all of it is in the frozen `plan` artifact + live re-check):

- `plan` artifact per target: `observed.state === 'pending'`,
  `observed.fence === expected_fence`, `eligible: true`, `failures: []`.
- Row evidence (from `observed` + the never-sent predicate): no `delivery_id`,
  `delivery_backend`, `delivery_tick`, `send_lease_expires_at`, `result_json`,
  `result_recorded_at`, `application_json`, `applied_at`.
- Gates evaluated per target (any hit is a `failures` entry):
  - target is **not** the bound successor of a `paid_effect_authorization` row;
  - no `sending`-state sibling row for the same `(family, entity_id)`;
  - no non-terminal (`created`/`retry`/`active`) `pgboss.job` of the family whose
    `data` references the entity;
  - no non-terminal (`pending`/`claimed`/`retry_wait`) `event_subscription_delivery`
    for an event referencing the entity;
  - every declared `watch` event has a delivery row (none undelivered).
- Source job terminal state: the evidence JSON already records the two admission jobs
  completed with no output; `plan` independently re-scans live jobs.

## 8. Evidence — after cancel

The `apply` receipt artifact records, per target, the verbatim
`PaidEffectCancelOutcome`:

- `kind: 'cancelled'`: `fence` (old+1 — the retired fence token), `cancelledAt`,
  `request_id`. Post-state on the row: `state='cancelled'`, `cancelled_at` and
  `cancel_json` (the `PaidEffectCancelReceipt`: request id, reason, operator, basis,
  `cancelled_from_state='pending'`, `previous_fence`, full identity, ISO timestamp),
  all delivery/lease/result/application columns still NULL, `input_json` unchanged.
- `kind: 'already_cancelled'`: the stored receipt — proof the replay rewrote nothing.
- One `paid_effect_cancellation` row per cancelled identity: request id, reason,
  operator, basis, `cancelled_from_state`, `previous_fence`, `created_at`. PK = the
  identity — the durable proof the identity was cancelled exactly once.

## 9. Scenario narratives (acceptance evidence, not assertion scripts)

**Same-request replay.** Run `apply` twice with the same manifest. Second run: each
target returns `already_cancelled` with the stored receipt; no second event row; exit
0. Any apply attempt that reuses `request_id` but alters `reason`/`operator`/`basis`
still returns `already_cancelled` verbatim — the first receipt is immutable history;
the altered fields are never persisted.

**Different-request replay.** Apply a manifest with a different `request_id` on an
already-cancelled identity: `PaidEffectCancellationError`, the target fails, no second
`paid_effect_cancellation` row, no write to the row.

**Racing a real claim.** A send claim and this cancel serialize on the same family
advisory → identity row → entity advisory order. If the claim wins, the row is
`sending` (delivery fields set) — the cancel's re-check fails and the target is
refused. If the cancel commits first, the claim sees `cancelled` → `held`; no paid
request is ever sent. Exactly one commits.

**State / evidence refusal.** Any non-`pending` state (`sending`, `unknown`,
`receipt_ready`, `applied`, `voided`) refuses: `unknown`/`voided` belong to the
void/successor lane; `receipt_ready`/`applied` are paid truth; `sending` is a live
send. Any non-NULL send/lease/result/application column refuses. Fence drift
(`expected_fence` ≠ live `fence`) refuses. Missing row refuses.

**Bound successor refusal.** If the manifest identity is the bound successor of a
`paid_effect_authorization` row, the cancel throws `PaidEffectAuthorizationError` —
the successor's authorization still gates that send, and this slice does not unbind.

**Ambient-liveness refusal.** A `sending` sibling for the entity, a live
`created`/`retry`/`active` job of the family referencing the entity, a
`pending`/`claimed`/`retry_wait` subscription delivery for the entity, or an
undelivered watched event each make the target ineligible — in `plan` (reported) and
re-verified under locks in `apply` (refused).

**Event/transition atomicity.** The `paid_effect_cancellation` insert precedes the
CAS in the same transaction. If the event insert fails (e.g. a PK violation proving
a prior cancellation), the whole target transaction rolls back — a cancelled state
with no event, or an event with no cancelled state, cannot exist.

**Read/connection failure.** Any SELECT or lock failure aborts the target transaction
and is recorded as that target's failure — the op fails closed, never guesses.

## 10. Out-of-list touch (reported per protocol)

`src/capabilities/practice/server/admission/reauthorization.ts`: one guard clause
extended so `cancelled` rows count as resolved history (`continue`) alongside
`voided`. Rationale: without it, a cancelled sibling on the same entity would be
misreported as an uncovered obligation and block the unrelated reauthorization lane;
with it, cancelled rows still can never be voided or successor-bound (the void
function accepts only `unknown`). Reported here as required.

## 11. NOT_RUN record

In this slice **none** of the following were run — by design and by instruction:

- `plan`/`apply` of `scripts/yuk1567-cancel-unsent-intents.ts` — `NOT_RUN` (no DB
  access from this worktree; the ops run is the parent/migration line's step).
- Migration application — `0127` is source-generated only (`drizzle-kit generate`);
  `NOT_RUN` against any database.
- Any DB/container/TEST access, provider call, queue/job/worker mutation — `NOT_RUN`.
- `pnpm test` or any test — `NOT_RUN` (prohibited in this slice).
- The mechanical test sync in `src/server/export/paid-effect-backup.db.test.ts` —
  `NOT_RUN`/`NOT_EDITED` (see the separate test-plan document; the three exact line
  changes are specified there for approval, tests remain untouched here).

Checks actually run are recorded in the PR body / handoff report.

## 12. Operator runbook (for the executor, later)

1. Apply migration `0127` through the normal migration line (bumps schema to include
   `paid_effect_cancellation` + `'cancelled'`). Deploy code containing this slice.
2. Author `manifest.json` per §5–§6 from the frozen approval evidence. Keep it next
   to the evidence file.
3. `YUK1567_DATABASE_URL=<deployment DATABASE_URL> DATABASE_URL=$YUK1567_DATABASE_URL
   tsx scripts/yuk1567-cancel-unsent-intents.ts plan manifest.json --out plan.json`
   → require `eligible: true` on every target; file `plan.json` as pre-evidence.
4. Same command with `apply` → file `receipt.json` as post-evidence. Per-target
   `failed` entries exit non-zero; investigate the recorded error/failures before any
   retry. A retry with the same `request_id` is safe by construction.
5. Post-checks (read-only SQL, operator's own session): rows now `cancelled` with
   `cancelled_at`/`cancel_json` populated; `paid_effect_cancellation` holds exactly
   one row per identity; the historical `unknown` rows for the entities are
   unchanged; obligation queries no longer list the two identities.
