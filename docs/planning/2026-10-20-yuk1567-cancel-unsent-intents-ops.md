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
| Exactly one winner between cancel and a real send claim | Cancel runs inside one SERIALIZABLE transaction that takes the family control advisory lock **first**, then locks the identity row `FOR UPDATE`, then the entity advisory — the same pinned order as every claim/void. A concurrent claim serializes; the loser either sees `cancelled` (held) or the cancelled row's CAS fails. Gate reads run under that serializable snapshot so a concurrent event→delivery discovery handoff (which does **not** take the paid-effect family advisory) cannot slip between statements — an interleave aborts the transaction and the target fails closed. |
| Never-sent proof is live, literal, and fenced at 0 | The CAS requires `state='pending'` **and** `fence=0` — the manifest `expected_fence` is validated as the literal `0` and the row's live fence must also be `0`; any advanced fence means a claim already touched the row. The function additionally verifies `delivery_id`, `delivery_backend`, `delivery_tick`, `send_lease_expires_at`, `result_json`, `result_recorded_at`, `application_json`, `applied_at` are **all NULL** before writing anything. `full_row_md5` from pre-0124 evidence is a pre-migration observation (0124 added nullable columns that change whole-row JSON) and is **never** used as a compare token anywhere. |
| Strict replay, immutable history | Replaying the request returns `already_cancelled` with the stored receipt **only when every request field matches the recorded one exactly** — `request_id`, `reason`, `operator`, `basis`, the full five-part identity embedded in the receipt, and `previous_fence` equal to the manifest `expected_fence` (0). ANY divergence, or a different `request_id`, throws `PaidEffectCancellationError`; replay never mints a second event, never mutates `cancel_json`, and never writes. `paid_effect_cancellation`'s primary key is the identity itself, so an identity can be cancelled at most once, ever. The apply path detects the already-cancelled row under the family lock **before** eligibility, so a replayed request is never refused by post-commit state or new ambient work. |
| Event and state are atomic | `paid_effect_cancellation` is inserted in the **same transaction** before the `pending → cancelled` CAS. Any event failure rolls the transition back with it. |
| Cancel authorizes nothing | No `paid_effect_authorization` row is created; if the target is the **bound successor** of an existing authorization row, the cancel refuses (`PaidEffectAuthorizationError`) — this slice never unbinds an authorization gate. |
| Dead end for downstream consumers | `reservePaidEffect`/`claimPaidEffectSend` treat `cancelled` like `sending`/`unknown`/`voided` → `held`, never a send. `admitPaidEffectIntent` returns `existing`/`cancelled`. `listPaidEffectObligations`'s unfinished list excludes it. Admission `receipt.ts` never reconciles a cancelled row AND holds any same-base/revision redelivery whose fresh input digest is not the explicitly bound successor of an authorization — a cancelled intent can neither revive nor spawn a drifted re-pay. `reauthorization.ts` treats cancelled rows as resolved history (they block nothing, and can never be voided or successor-bound). The DB `paid_effect_state_shape_ck` CHECK constrains cancelled rows to the exact never-sent shape. |

## 3. Files

| Path | Role |
|---|---|
| `src/core/migration/paid-effect-protocol.ts` | `'cancelled'` in `PAID_EFFECT_STATE_SCHEMA`; `PaidEffectCancelRequest`, `PaidEffectCancelReceipt`, `PaidEffectCancellationError` |
| `src/db/schema.ts` | `paid_effect.cancelled_at`/`cancel_json`; `'cancelled'` in `paid_effect_state_ck` + `paid_effect_state_shape_ck`; new `paid_effect_cancellation` event table |
| `src/db/paid-effect-store.ts` | `cancelPaidEffectUnsentIntent` (the atomic cancel), `evaluatePaidEffectCancelEligibility` (the ops gate shared by plan/apply), `readPaidEffectCancellations`, snapshot fields, held-on-cancelled |
| `src/capabilities/practice/server/admission/receipt.ts` | Excludes cancelled rows from reconciliation queries; `held` on cancelled; sealed-history gate holds unauthorized same-revision drift |
| `src/capabilities/practice/server/admission/reauthorization.ts` | Cancelled treated as resolved history (see §9 — outside the original allowed-path list; reason recorded) |
| `drizzle/0127_yuk1567_paid_effect_cancellation.sql` + `drizzle/meta/{_journal,0127_snapshot}.json` | Incremental migration only; no existing row or migration is touched, 0124 is not renumbered; journal `when` is strictly greater than 0126 so incremental migrators never skip it |
| `src/server/export/constants.ts` | `paid_effect_cancellation` in `PAID_EFFECT_BACKUP_TABLES` (and thus `FK_ORDER`, before `provider_attempt`); `SCHEMA_VERSION` `4.29 → 4.30` |
| `scripts/yuk1567-cancel-unsent-intents.ts` | The ops CLI below (admission-family scoped; watch verified against the live subscription declaration) |

## 4. Command signatures

```
# Read-only: one repeatable-read snapshot evaluates every manifest target,
# then freezes a write-once plan artifact. Mutates nothing.
tsx scripts/yuk1567-cancel-unsent-intents.ts plan  <manifest.json> --out <plan.json>

# Mutating: executes ONLY the scope a FROZEN plan authorized.
#   --plan is the artifact written by `plan`; --plan-sha256 is that file's
#   raw-byte digest as recorded in the frozen ops record / approved command
#   line — it is NEVER recomputed from the file as its own expected value.
#   Before the database client is even imported, apply verifies: raw-byte
#   hash → artifact schema → manifest_sha256 binds THIS manifest → request
#   fields + watch triples + (identity, expected_fence) multiset match
#   item-for-item → every plan target recorded eligible. An appended,
#   replaced, dropped, or foreign plan refuses — the request_id alone never
#   authorizes an execution scope.
#   Per authorized target: one SERIALIZABLE transaction — set isolation →
#   family advisory lock → already-cancelled strict replay (read-only return
#   of the stored receipt) or, for a fresh pending row, eligibility re-check
#   under the same snapshot → cancelPaidEffectUnsentIntent (event insert +
#   pending→cancelled CAS, atomic).
# A serialization conflict (SQLSTATE 40001) fails that target closed —
# record, fix the cause, re-plan; the script never retries writes and never
# re-freezes a plan on its own.
tsx scripts/yuk1567-cancel-unsent-intents.ts apply <manifest.json> \
  --out <receipt.json> --plan <plan.json> --plan-sha256 sha256:<approved plan hash>
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
  "watch": [                                     // REQUIRED, verified item-for-item
    {                                            // against the live practice
      "action": "experimental:assessment_publish",   // capability manifest's
      "subscriber_id": "practice.question-admission-enqueue",  // enqueue
      "subscriber_version": 1                    // subscription declaration
    }
  ],
  "targets": [                                   // EXACT batch scope — apply iterates
    {                                            // only this list, one tx each
      "family":           "question_admission_run",  // only family supported
      "entity_id":        "<entity id>",
      "entity_revision":  "<revision>",
      "unit":             "admission@3",
      "input_digest":     "sha256:<64 hex>",
      "expected_fence":   0                        // literal 0 — the never-sent token
    }
  ]
}
```

Rules enforced by the CLI / store:

- `targets` nonempty; duplicate five-part identities in one manifest are rejected
  before any write. Every target's `family` must be `question_admission_run` —
  the generic store stays family-agnostic, but THIS ops entry is admission-scoped
  because its drainage gate is bound to the practice subscription declaration;
  other families refuse at parse time.
- `expected_fence` is the literal `0` (`z.literal(0)`): the never-sent contract
  requires the row's live fence to be exactly 0 — a fence advanced past 0 means
  a claim already touched the row, and such a target is ineligible by schema,
  store, and CHECK alike.
- `watch` is **required** and verified item-for-item against the practice
  capability manifest's `practice.question-admission-enqueue` subscription
  declaration — each entry must match a declared `(action, subscriber_id,
  subscriber_version)` triple, the manifest set must equal the declared set
  exactly (no missing, no extra, no stale version), and a missing declaration
  refuses the whole manifest. An old `subscriber_version` cannot borrow a
  delivery written under a different version: the undelivered-event check
  requires a delivery row at the CURRENT declared version.
- `watch` gate semantics: for each declared triple, every `event` row matching
  the action and referencing the entity (by `subject_id` or payload text) must
  already have an `event_subscription_delivery` row for that subscriber at that
  version. An undelivered event — work that could still mint a claim — fails
  eligibility.
- One `request_id` covers the whole manifest — the two approved targets are one
  approved operation. The request id is per-identity IDEMPOTENCY metadata (it
  anchors replay detection on a cancelled row); it is NOT a batch-wide
  authorization key. The EXECUTION scope is authorized only by the verified
  frozen plan (`--plan` + `--plan-sha256`): a manifest that appends, replaces,
  or drops a target no longer matches the frozen plan and refuses before any
  database connection — even under the original request id. Changing the
  frozen scope requires re-plan AND re-approval; reusing the old request id or
  recomputing a fresh hash for an edited plan does not carry the approval over.
  A later apply with a **different** `request_id` or ANY divergent request
  field on an already-cancelled identity fails closed.
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
   a CAS token. The agreed compare is identity + `expected_fence: 0` + the live
   never-sent predicate re-verified under locks at apply time.
3. `watch` for this operation is the admission enqueue pipeline, copied from the
   current declaration in `src/capabilities/practice/manifest.ts`
   (`subscriptions.handlers`): `action = experimental:assessment_publish`,
   `subscriber_id = practice.question-admission-enqueue`,
   `subscriber_version = 1`. If the declaration's version has moved by the time of
   execution, the frozen manifest no longer matches and must be re-authored
   against the current declaration and re-approved.
4. Choose a fresh `request_id` for the real operation (do not reuse this doc's
   example); record `operator`, `reason`, `basis` naming the lead approval.

## 7. Evidence — before cancel

Collect before `apply` (all of it is in the frozen `plan` artifact + live re-check):

- `plan` artifact per target: `observed.state === 'pending'`,
  `observed.fence === 0` (literal never-sent fence), `eligible: true`,
  `failures: []`.
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
  - every declared `watch` triple has a delivery row **at the declared
    `subscriber_version`** for every matching event (none undelivered).
- Source job terminal state: the evidence JSON already records the two admission jobs
  completed with no output; `plan` independently re-scans live jobs.

## 8. Evidence — after cancel

The `apply` receipt artifact records the verified hashes — `plan_sha256` (the
raw-byte digest of the frozen plan that authorized this execution, equal to the
approved `--plan-sha256`), `plan_manifest_sha256` and `manifest_sha256` (the
parsed-manifest digest both files bind) — plus, per target, the verbatim
`PaidEffectCancelOutcome`:

- `kind: 'cancelled'`: `fence` (old+1 — the retired fence token), `cancelledAt`,
  `request_id`. Post-state on the row: `state='cancelled'`, `cancelled_at` and
  `cancel_json` (the `PaidEffectCancelReceipt`: request id, reason, operator, basis,
  `cancelled_from_state='pending'`, `previous_fence`, full identity, ISO timestamp),
  all delivery/lease/result/application columns still NULL, `input_json` unchanged.
- `kind: 'already_cancelled'`: the stored receipt — returned only on an
  exactly-matching replay; proof nothing was rewritten.
- `outcome: 'serialization_conflict'`: a concurrent write interleaved the
  serializable gate reads — recorded per target, fail closed, re-plan after the
  ambient work settles.
- One `paid_effect_cancellation` row per cancelled identity: request id, reason,
  operator, basis, `cancelled_from_state`, `previous_fence`, `created_at`. PK = the
  identity — the durable proof the identity was cancelled exactly once.

## 9. Scenario narratives (acceptance evidence, not assertion scripts)

**Same-request replay.** Run `apply` twice with the identical manifest AND the
identical frozen plan (`--plan` + approved `--plan-sha256`). Second run: each
target's transaction sees the already-cancelled row under the family lock
**before** eligibility, strictly compares the recorded receipt against the replayed
request (request id, reason, operator, basis, full identity, previous fence), and
returns `already_cancelled` with the stored receipt verbatim; no second event row,
no writes; exit 0. This also covers crash recovery: a run that committed a target
but died before/while writing the artifact replays to the same stored result. A
fresh target that is still `pending` re-proves eligibility live — changed ambient
state (new jobs, new deliveries) gates it, but committed history is never
re-litigated.

**Scope mutation (manifest/plan divergence).** Edit the manifest to append,
replace, or drop a target — or alter watch/request fields — while reusing the
original `request_id`, then apply with the original frozen plan. `apply` refuses
BEFORE any database connection: `manifest_sha256` no longer matches the plan, and
the (identity, expected_fence) multiset check independently names the divergent
member. The request id is per-identity idempotency metadata only; it does not
carry authorization to a new scope. Widening scope requires a new `plan` artifact
AND a new approval — recomputing a hash for an edited plan file and passing it as
`--plan-sha256` just pins whatever the operator typed, which is exactly why the
approved digest must come from the frozen ops record, not from the file.

**Divergent replay.** Any apply that reuses `request_id` but alters `reason`,
`operator`, `basis`, the identity, or `expected_fence` — or replays under a
different `request_id` — hits `PaidEffectCancellationError`: the target fails, no
second `paid_effect_cancellation` row, no write to the row. A borrowed request id
can never launder a mutated request through an old receipt.

**Racing a real claim.** A send claim and this cancel serialize on the same family
advisory → identity row → entity advisory order. If the claim wins, the row is
`sending` (delivery fields set, fence ≥ 1) — the cancel's re-check fails and the
target is refused. If the cancel commits first, the claim sees `cancelled` →
`held`; no paid request is ever sent. Exactly one commits.

**Racing a delivery discovery.** The event→delivery discovery handoff does not take
the paid-effect family advisory, so `apply` runs SERIALIZABLE: every gate read
shares one snapshot, and a discovery commit interleaving mid-transaction aborts
the apply at commit (`40001`) — recorded as `serialization_conflict` for that
target, fail closed. The operator fixes the cause and re-plans; the script never
retries or bypasses the gate.

**State / fence / evidence refusal.** Any non-`pending` state (`sending`,
`unknown`, `receipt_ready`, `applied`, `voided`) refuses. Any non-NULL
send/lease/result/application column refuses. A live fence other than literal `0`
refuses, and a manifest `expected_fence` other than `0` is rejected at parse —
the never-sent token is exact, not merely "matches whatever the row has". A
missing row refuses.

**Watch / scope refusal.** A manifest omitting `watch`, carrying `[]`, or naming
any triple other than the live `practice.question-admission-enqueue` declaration
(wrong action, wrong subscriber, stale `subscriber_version`) is rejected before
any query. Any target whose family is not `question_admission_run` is rejected.
A delivery written under an older subscriber version never proves the current
version saw the event.

**Bound successor refusal.** If the manifest identity is the bound successor of a
`paid_effect_authorization` row, the cancel throws `PaidEffectAuthorizationError` —
the successor's authorization still gates that send, and this slice does not unbind.

**Ambient-liveness refusal.** A `sending` sibling for the entity, a live
`created`/`retry`/`active` job of the family referencing the entity, a
`pending`/`claimed`/`retry_wait` subscription delivery for the entity, or an
undelivered watched event each make the target ineligible — in `plan` (reported)
and re-verified under the serializable snapshot in `apply` (refused).

**Event/transition atomicity.** The `paid_effect_cancellation` insert precedes the
CAS in the same transaction. If the event insert fails (e.g. a PK violation proving
a prior cancellation), the whole target transaction rolls back — a cancelled state
with no event, or an event with no cancelled state, cannot exist.

**Sealed-history consumer behavior.** After a cancel, a later same-base/revision
redelivery whose prepared input drifted (generation/profile/policy/solver config)
computes a new input digest → a new identity. `receipt.ts` holds that fresh
identity unless a `paid_effect_authorization` row explicitly binds it as a
successor — a cancelled intent never silently becomes a re-pay, and the entity is
not blocked for other revisions or other content. A legitimately bound successor
still proceeds: its own admitted row reconciles through the normal path.

**Read/connection failure.** Any SELECT or lock failure aborts the target
transaction and is recorded as that target's failure — the op fails closed, never
guesses.

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
  the three exact line changes were approved by the coordination line
  (2026-10-20, owner10-19 standing list authorization) and applied verbatim in
  commit `902b266a0`; the test itself remains `NOT_RUN` here.

Checks actually run are recorded in the PR body / handoff report.

## 12. Operator runbook (for the executor, later)

1. Apply migration `0127` through the normal migration line (bumps schema to include
   `paid_effect_cancellation` + `'cancelled'`). Deploy code containing this slice.
2. Author `manifest.json` per §5–§6 from the frozen approval evidence. Keep it next
   to the evidence file.
3. `YUK1567_DATABASE_URL=<deployment DATABASE_URL> DATABASE_URL=$YUK1567_DATABASE_URL
   tsx scripts/yuk1567-cancel-unsent-intents.ts plan manifest.json --out plan.json`
   → require `eligible: true` on every target; file `plan.json` as pre-evidence.
   Then record `sha256sum plan.json` (or `shasum -a 256`) in the frozen ops
   record — that digest is the approval token `apply` requires as
   `--plan-sha256`; it must come from the record, never be recomputed ad hoc
   from a file that could have been edited.
4. `... apply manifest.json --out receipt.json --plan plan.json
   --plan-sha256 sha256:<recorded hash>` → file `receipt.json` as post-evidence.
   A scope/hash divergence refuses before connecting; per-target `failed` or
   `serialization_conflict` entries exit non-zero — investigate the recorded
   error/failures before any retry. A retry with the same manifest and the same
   frozen plan is safe by construction — a divergent replay fails closed.
5. Post-checks (read-only SQL, operator's own session): rows now `cancelled` with
   `cancelled_at`/`cancel_json` populated; `paid_effect_cancellation` holds exactly
   one row per identity; the historical `unknown` rows for the entities are
   unchanged; obligation queries no longer list the two identities.
