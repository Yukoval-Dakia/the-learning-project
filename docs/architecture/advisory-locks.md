# Advisory locks — inventory and ordering

> Authoritative lock doc (YUK-1577). The machine-readable inventory lives in
> `src/db/advisory-lock-registry.ts`; this document is the narrative proof: every observed
> acquisition family, its key encoding, scope, release semantics, and the ordering edges that
> code actually establishes. Evidence is `path:line` in production code (tests never count).
> Where an edge is not proven, it is marked unresolved — no total order is invented.

## 1. Mechanisms in use

| Mechanism | SQL | Lifetime | Release |
|---|---|---|---|
| Transaction advisory | `pg_advisory_xact_lock(…)` | to tx commit/rollback | automatic |
| Transaction try | `pg_try_advisory_xact_lock(…)` | to tx end | automatic; miss → outcome not block |
| Session advisory (helper) | `pg_try_advisory_lock(…)` + `pg_advisory_unlock(…)` on a pinned `db.$client.reserve()` | connection-held across many txs | explicit unlock + `reserved.release()` in `finally` |
| Session advisory (ad hoc) | same, on a manually reserved connection | connection-held | explicit unlock (best-effort catch) |

Key encodings observed: `hashtext(key)` (int4), `hashtext(ns), hashtext(key)` (int4 pair),
`hashtextextended(key, salt)` (int8; salts in use: `0`, `1`, `1393`), bare int4 literals
(`597_001`, `406_440_3`), bare int4 pairs (`(1356,1)`, `(1356,2)`, `(1393,1)`, `(1355,1)`).

`hashtextextended(key, 0)` int8 keys are a different lock keyspace from `hashtext(key)` int4
keys — same name string, different lock. The registry records encodings exactly; it does NOT
normalize them.

## 2. Lock helpers

| Helper | File | Role |
|---|---|---|
| `acquireLearningStateWriteLock` / `withLearningStateLock` | `src/db/learning-state-lock.ts` | Global learning-write lock G (`learning-state:write`). Opens a real tx for `Db`, inline for `Tx`. Re-entrant. |
| `acquireSortedAdvisoryLocks` | `src/server/advisory-locks.ts` | Sorted per-id `hashtext(<ns>:<id>)` acquire — the consistent-lock-ordering doctrine. Namespaces: `fsrs:knowledge`, `fsrs`, `mastery:ability_global`, `kc_typed:*`, `axis_state:*`, `knowledge_edge`, `knowledge:create`. |
| `withinSessionAdvisoryLock` | `src/db/session-advisory-lock.ts` | Session-scoped try+retry-until-deadline on a reserved connection; patches `begin`/`savepoint` onto the reserved conn and hands a Drizzle `Db` to `work`. **Fail-closed registry admission since YUK-1577**: unregistered descriptors throw before any reservation. |
| `acquireProposalDecisionLock` | `src/server/proposals/applier-helpers.ts` | `proposal_decision:<id>` xact lock. |
| `lockPaidEffectControlFamily` / `lockEntityGate` | `src/db/paid-effect-control.ts` / `src/db/paid-effect-store.ts` | Paid-effect family + entity-gate locks. |
| `acquireControlPlaneLockSql` | `src/server/subjects/control-plane-lock.ts` | Subject control-plane int literal lock. |
| `lockProducerFenceInstaller` / `lockSessionOrphan*` / `lockPhase` | `src/server/durable/*` | Durable family install/control/tick locks. |
| `acquireCopilot*Lock` | `src/capabilities/copilot/server/durable-dispatch.ts` | Copilot dispatch/queue locks. |
| `streamPartitionLockKey` / `lockDailyStreamPartition` | `src/capabilities/practice/server/stream-store.ts` | `stream:compose:<date>` / `stream:session:<sessionId>`. |
| `withinComposePaidWorkLock` | `src/capabilities/practice/server/compose-paid-work-lock.ts` | `stream:compose-paid:<date>` session lock. |
| `acquireProposalDecisionLock`-family callers | see registry `sites` | — |

## 3. Registry

`src/db/advisory-lock-registry.ts` (`ADVISORY_LOCK_REGISTRY`, **79 families**) is the
descriptive source of truth: `family`, `keyTemplate`, `encoding`, `hashSalt`, `scope`,
`acquire`, `sites`, `after`, `sessionMatch`, `release`. Live consumers:

1. `LEARNING_STATE_WRITE_LOCK` is owned by the registry and re-exported unchanged by
   `src/db/learning-state-lock.ts` — every existing import site keeps working, the SQL
   statement is identical (`pg_advisory_xact_lock(hashtext('learning-state:write'))`).
2. `withinSessionAdvisoryLock` calls `requireSessionAdvisoryLockFamily(lock)` **before**
   reserving a connection. Only three session families exist today and all three are
   registered: `stream:compose-paid:*` (helper), `assessment-evaluation-group` pair
   (helper), `model-slice-admission:*` + `yuk1050:migration-apply` (ad-hoc reserved-conn
   sites, registered for completeness). An unregistered descriptor now throws a coding
   error instead of silently creating a fifth protocol.

## 4. Proven ordering edges

`A → B` means: code acquires `A`, then acquires `B` while still holding `A`, in the same
critical section. These are the edges evidence supports; disjoint families carry no order.

### 4.1 Learning-state spine

```
event row FOR UPDATE
  → G (learning-state:write)          [knowledge merge accept: proposals.ts:927 — G taken AFTER
                                       the propose-event row lock, BEFORE knowledge row locks]
  → knowledge rows FOR UPDATE         [lockMutationRows]
  → knowledge_edge sorted advisory    [proposals.ts:522 / edge-topology-write.ts:119]
  → per-domain retire namespaces      [fsrs:knowledge / kc_typed:* / axis_state:* sorted]

G → fsrs:<kind>:<id> (sorted) → mastery:ability_global:<domain> (sorted)
  [updateThetaForAttempt: acquireLearningStateWriteLock → mastery/state.ts:1067 → :1369;
   settle.ts:1049-1055 same order; cascade-revert.ts:502 → :748 → :749]
```

### 4.2 Assessment group spine

```
session pair  ('assessment-evaluation-group', groupId)     [evaluate-submission.ts:785 —
  → G          held across the whole evaluation incl. model calls]
  → xact pair  same key pair                                [activate.ts:235 /
                                                             evaluate-submission.ts:411 /
                                                             settle.ts:1854 (withdraw)]
  → evaluation row → submission row → effective_head row → question group root row (FOR UPDATE)
                                                              [activate.ts doc lines 8-19]
  → fsrs:<kind>:<id> sorted                                  [settle.ts:1055]
  → mastery:ability_global sorted                            [via updateThetaForAttempt]
```

Other paths into the group lock, all consistent with the spine (group lock only ever appears
AFTER G when both are held; many holders take it alone):

| Holder | Order |
|---|---|
| `submit.ts:355` | group only |
| `appeal.ts:24→41` | `hashtext(evt_native_appeal_*)` → group |
| `review-operation.ts:399→421` | `review-answer:<g>:<key>` (hte0) → group |
| `drizzle 0114 trigger` | group inside `assessment_group_input_seal_guard` BEFORE INSERT on submission/evaluation |
| `failure-learning-{attribution,variant}` | group alone inside their txs |

### 4.3 Intervention corrections

```
G → intervention:<id>:<version> → intervention:corrections:all → intervention:source:<eventId>
  [store.ts:352→372→375]
corrections:all → source:<id> everywhere both appear
  [events.ts:342→346; probe-result-subscription.ts:115→118; reconcile.ts:212→215]
```

### 4.4 Practice stream

```
session('stream:compose-paid:<date>')          [singleFlightCompose — held across two inner txs]
  → xact('stream:compose:<date>')              [lockDailyStreamPartition, probe + finalize]

'stream:scope:<date>:<kc>' → 'stream:session:<sessionId>'   [stream-store.ts:509→521]

'intervention:deliver:<qId>' → 'stream:compose:<date>'      [intervention-diagnostics.ts:411→413,
                                                           under SET LOCAL lock_timeout=5s]
```

### 4.5 Durable family control plane

```
pgboss:producer-fence:install:v1 → family control → per-tick key
  [judge: judge-family.ts:42→43 (1356,1) → :103/:443 per-task/run;
   prune: prune-family.ts:33→34 (1355,1);
   review-orphan: :336→337 (1393,1); tick via hte(tickId,1393) after control row FOR SHARE;
   session-orphan: install :338; tick 'session-orphan:v1:<fam>:<tick>' after control FOR SHARE]
```

### 4.6 Paid-effect admission

```
paid-effect:control:v1:<family> → identity row FOR UPDATE → paid-effect:gate:v1:<f>:<e>
  → control row    [paid-effect-store.ts:451 doc + :155→:169 claim order]
serving-command 'yuk1514:serving:<eventId>' → question root FOR UPDATE
  → question_group_lifecycle FOR UPDATE          [serving-actions.ts:708 → lockAdmissionGroup]
```

### 4.7 Provider attempt lane (src/server/ai — read-only reference)

```
provider-attempt-operation-kind:* → provider-attempt:<id> (sorted candidate set)
  → provider-attempt-lane:<lane>   [provider-attempt-lifecycle.ts:163→184→530/696]
provider-session-admission:<lane> — pg_try_advisory_xact_lock under ≤250ms lock_timeout
  [provider-session-admission.ts:458]
```

### 4.8 Smaller proven edges

| Edge | Site |
|---|---|
| `probe-question` hte(q,0) → `conjecture-fold` hte(evt,1) → `proposal_decision:<evt>` | probe-lifecycle.ts:675→796→(acquireProposalDecisionLock) |
| `write_quiz:<run>` → `proposal_decision:<id>` sorted → question rows | write-quiz.ts:240→261 |
| `note_refine:effect:*` → `note_refine:product:*` | mastery-refine-effect.ts:56→73 |
| `paper-native:<issuance>` → `evt_assessment_<sub>` claim | paper-attempt.ts:87→122 |
| `lockPaidEffectControlFamily` → `lockAdmissionGroup` rows | resolved-repair.ts:145 |

## 5. Unresolved / disproven edges

- **`fsrs:*` vs `assessment-evaluation-group`**: inside activation the order is G → group →
  fsrs:* (settle). submit.ts takes group but NOT G; attempt-path callers of
  `recordFormalAttemptCapture` take `evt_assessment_*` after group or after `paper-native:*`.
  No site takes fsrs:* then group — consistent, no cycle.
- **`intervention:<id>:<version>` vs `intervention:corrections:all`**: observed only as
  instance → global (store.ts, reconcile.ts). No reverse site found — consistent.
- **`stream:session:*` vs `stream:compose:*`**: they are the same `streamPartitionLockKey`
  keyspace — `stream:session:<id>` and `stream:compose:<date>` cannot collide unless a
  sessionId literally equals `compose:<date>` (sessionIds are cuid-like; impossible in
  practice). No site holds both.
- **Anonymous `hashtext(<id>)` claims** (`evt_assessment_*`, `evt_native_appeal_*`,
  `evt_native_resolution_*`, `<requestId>`, `<runId>`, `<claimId>`, `<task_id>`) share one
  int4 keyspace with all namespaced `hashtext` locks. Collisions across families are
  theoretically possible (2³² space) but no observed cross-family duplicate key exists;
  treat each as an independent singleton claim.
- **`PROBE_SERVE_LOCK_KEY` (4064403)**: literal int4; colliding families would need the same
  bare integer — none exists. Independent global cap lock.

## 6. Row-lock interactions (non-advisory, part of the same protocols)

- `acceptProposal` (knowledge): propose-event `FOR UPDATE` → G → `lockMutationRows` (sorted
  knowledge rows) → `knowledge_edge` advisory → retire namespaces. G is deliberately taken
  AFTER the event row lock (proposals.ts:918-927 comment: taking it inside merge preparation
  would be too late).
- `lockAdmissionGroup`: question root `FOR UPDATE` → `question_group_lifecycle` `FOR UPDATE`
  (fixed order, enqueue.ts:25).
- Durable family phase reads: control row `FOR SHARE` before tick advisory (review-orphan
  `lockPhase`, session-orphan `lockSessionOrphanControl`).
- `paid_effect` claim: family advisory → identity row `FOR UPDATE` → entity advisory →
  control row.

## 7. Session-advisory connection discipline (`withinSessionAdvisoryLock`)

- Try-with-deadline on a reserved postgres-js connection; a failed try releases the pool
  slot before a ≤25ms backoff so unrelated queries progress.
- Timeout mid-`pg_try` still completes the query on the server side; the helper waits for it
  to settle, unlocks, then releases (`releaseReservedAfterTryLockSettles`).
- `begin`/`savepoint` are patched onto the reserved connection so `work` gets a Drizzle `Db`
  whose transactions run on the lock-holding connection.
- Failure ownership: `busy()` is caller-supplied (503 for compose; `evaluation_busy` for
  evaluate); unlock failure inside the timed-out path is logged, unlock failure on the normal
  path propagates after `work` settles.

## 8. Coverage

- Registry denominator: **79 families** covering every production `pg_advisory*` /
  `pg_try_advisory*` / `pg_advisory_unlock` site found by repo-wide search (raw evidence:
  `tlp-audit-artifacts/architecture-deepening/YUK-1577/<head>/raw-lock-sites.txt`).
- Ordering edges proven: 18 edge groups in §4. Unresolved: 0 reachable cycles found;
  anonymous-int4 collisions noted as theoretical in §5.
- Off-limits but documented: `src/server/ai/*` (provider-attempt-*, provider-session-admission),
  `src/db/paid-effect-*.ts` (read for inventory; not modified).
