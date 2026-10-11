# YUK-1356 judge operational contract details

## Decisions

1. Add only a singleton `judge_run_control` table. Keep run-specific binding, delivery and manual-disposition receipts in the existing immutable `event` table. Serialize them with the existing run advisory transaction lock. No per-run workflow table, result table or new scorer is needed.
2. Fence new claims, candidate sealing and native resolution/activation with that same run lock and permanent disposition check. Put the activation check at the existing capability-owned settlement callback, before `recordOriginal` and `learningSettlement`. Do not lock the run in `beforeActivate` before acquiring the group lock.
3. Put one permanent-state selector and reducer in practice. Tx consumers use it directly; HTTP adds optional DBOS observation after its short domain transaction ends. Preserve the four-state wire DTO and existing dispatch port. No kernel, Start or bootstrap edit is needed for these three decisions.

This is a proposed implementation contract, not implemented behavior or acceptance. Product baseline is `a8800730b3c67667574bc44ec02edb7ed7800f78`; observed local HEAD was `8fb6b54d11c8c069990a91a092b8f578cbc7d378`, with only parent documentation differences. Full paths are listed in the source register. Short assessment/judge filenames refer to `src/capabilities/practice/server/`. Other paths below are relative to `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1363-test-storage`. Exact SHA-256 values, baseline comparisons and report hash are in the adjacent `.sources.json`. At source sealing, parent HEAD advanced to `645a69252dba5e2822881df8086fc555734bd4c6`; its differences from product remain documentation only, and all 28 sealed repository inputs still match product byte-for-byte. Existing report and refresh receipt were read first; this document replaces only their three unresolved implementation decisions.

## 1. Storage, identities and atomic boundaries

### Existing source facts

`assessment/durable-attempt.ts:55–123` already assigns run=`judge_native_<submission_id>`, pending=`evt_pending_<run>`, expected head, immutable capture and pending intent under `pg_advisory_xact_lock(hashtext(runId))`. Admission precedes pending. `judge-run-dispatch.ts:getJudgeRecoveryMetadata` currently counts REQUEUED markers in prunable `job_events`; `hasAutomaticRecoveryBudgetFor:428–439` uses strict age <7 days and count <2.

`judge/evaluate-submission.ts:445–522` computes the frozen input/intent digest, reuses a sealed execution receipt and otherwise allocates `max(evaluation.attempt)+1`. `recorded-model-executor.ts:29–38,47–127` derives claim/result/task IDs from group, submission, attempt and unit, commits the claim before calling the executor, and reuses saved parsed outcomes. Claim without valid matching result holds its cap reservation. `evaluation_submission_attempt_uq` is the native collision fence, not a pre-candidate reservation.

### Proposed control row

`judge_run_control`: `id smallint PRIMARY KEY CHECK(id=1)`, `incarnation uuid NOT NULL`, `epoch bigint NOT NULL CHECK(epoch>=0)`, `phase` CHECK in `pg-boss | draining-pg-boss | dbos | draining-dbos`, `phase_changed_at timestamptz NOT NULL`, `transition_event_id text NULL`.

The transition link is validated by the owner in the same transaction; do not add a control-to-event FK across the learner-archive exclusion boundary. The incarnation is created once when initializing a new control row. Epoch increases on each ownership transition, using `UPDATE ... WHERE epoch=expected RETURNING`. First initialization is pg-boss, never automatic DBOS adoption. During drain, already admitted deliveries retain their recorded epoch as explicit obligations; an epoch mismatch alone must not revoke a live final delivery. Cross-backend execution requires an explicit ownership mapping, never an inferred transfer. The transition event records the old/new phase, epoch, quiescence evidence IDs and source digest in the same transaction. Fresh admission takes control `FOR SHARE`; phase change takes `FOR UPDATE`. No family row lock spans enqueue, model I/O or waiting for a group lock. An event imported from a learner archive cannot execute under a newly initialized incarnation.

### Proposed typed event receipts

Add a small adjacent `src/core/schema/event/judge-operational-events.ts`; register its exact actions in `event/index.ts` AND `experimental.ts:RESERVED_EXPERIMENTAL_ACTIONS`. Infer TS types from Zod discriminated unions. IDs below use canonical hashes of coordinate tuples, never ambiguous string concatenation. All receipts have `version:1`, validated identifiers and digests; integer fields are checked nonnegative, attempt positive, slot 0..2. Envelope uses system actor, null outcome/cost, creation time, non-null `ingest_at` and empty `affected_scopes`; none is learner evidence.

| Action suffix after `experimental:judge_` | Deterministic ID/key and required payload |
| --- | --- |
| `execution_binding` | `evt_judge_binding_<H(group,key)>`; run, pending ID/digest, group, submission, execution key, frozen member IDs/input digest, intent digest, allocated attempt, original admission snapshot, execution policy/value+version. No response, score or candidate ID placeholder. |
| `delivery_reserved` | `evt_judge_delivery_<H(run,slot)>`; run, pending ID/digest, slot, backend, delivery/workflow ID, incarnation+epoch, reserved_at. DBOS ID=`judge-run-v1:<run>:delivery:<slot>`. Slot 0 is initial delivery; slots 1,2 are fresh recoveries. |
| `delivery_send` | `evt_judge_send_<H(reservationId,sendNo)>`; reservation ID, run, positive sendNo, incarnation+epoch, gate_checked_at, authorization digest/version. This is a durable send authorization after the existing process-local rate gate, not acceptance or a billed cost. |
| `delivery_rejected` | `evt_judge_reject_<H(sendId)>`; send ID, run, classified definitive pre-acceptance rejection, observed_at, evidence digest. Never write this for a timeout/lost acknowledgment. |
| `delivery_accepted` | `evt_judge_accept_<H(reservationId)>`; reservation ID, run, backend+delivery ID, pending/input digest, accepted send ID if known, evidence=`enqueue_ack | worker_entry | authoritative_lookup | legacy_mapping`, observed_at. Nullable send ID is allowed only for lookup/legacy proof of a previously authorized delivery. |
| `delivery_started` | `evt_judge_start_<H(reservationId)>`; run, reservation ID, ownership incarnation+epoch, started_at. Written at validated worker entry, after or atomically with acceptance. It reports progress, not a model claim. |
| `disposition` | `evt_judge_disposition_<H(run)>`; run, pending digest, kind=`manual`, reason code, actor/ref, decided_at, observed ownership, evidence refs/digest. Reasons include provider_unknown, invalid_receipt, input_conflict, terminal_delivery, recovery_exhausted, recovery_history_unknown, historical_unknown, explicit_disposal. No retry permission or verdict. |
| `ownership` | `evt_judge_owner_<H(run,incarnation,epoch)>`; run, pending/source digest, from/to ownership, original submitted_at, mapped delivery IDs/slots, recovery_history=`known` with accepted recovery IDs or `unknown`, evidence refs. Import cannot infer zero from pruned markers. |
| `family_transition` | `evt_judge_transition_<H(incarnation,nextEpoch)>`; prior/next phase+epoch, actor, quiescence/mapping evidence refs/digest, recorded_at. This is the control row's transition audit receipt. |

Use `subject_kind='event', subject_id=pendingId, caused_by_event_id=pendingId` for run receipts; binding additionally carries its native group. Family transitions use `subject_kind='durable_family', subject_id='judge_run', caused_by_event_id=null`, admitted explicitly by their dedicated schema. Exact envelope literals must be admitted by the dedicated schemas. Unkeyed legacy queue obligations use the ownership/disposition schema's separate `legacy_task` coordinate variant keyed by `(backend,taskId)` with payload digest; never fabricate a run/submission. Such variants cannot enter native execution.

No mutable accepted counter is necessary. Fold at most three reservation slots and distinct acceptance receipts. Send authorization has immutable sequence numbers under the run lock; an authorized send without rejection or acceptance is `send_unknown`, including crash before actual send. A reservation with no send authorization is `reserved_unsent`. Neither is accepted. Repeated DBOS execution/recovery of one ID does not add a slot or evaluation attempt.

### Keys and indexes

Keep `event.id` PK, existing subject/time and caused-by indexes and `evaluation(submission_id,attempt)` uniqueness. Add partial unique expression indexes for binding `(payload->>'evaluation_group_id',payload->>'execution_key')`, binding `(payload->>'submission_id',(payload->>'attempt')::int)`, reservation `(run_id,slot)`, reservation `(backend,delivery_id)`, acceptance `(reservation_id)`, and disposition `(run_id)`, each restricted to its exact action/native coordinate variant. Send `(reservation_id,send_no)` and rejection `(send_id)` also need partial uniqueness. Deterministic IDs are the normal idempotency path; these constraints reject incorrectly generated alternative IDs.

Add one partial `(payload->>'run_id', action, created_at, id)` index for these operational actions, and a pending scan `(created_at,id)` restricted to `experimental:judge_pending_attempt`. The binding submission/attempt unique index also supports allocation lookup. Existing subject index serves question/pending discovery; no JSON-wide new index is needed. Migration validates existing shapes before casts; no migration number is reserved.

`kernel/events/events.ts:287–325` silently ignores duplicate event IDs. Therefore each practice writer must read/parse/compare the stored envelope identity and immutable payload after insertion under its lock; conflict is manual/error, never silently accepted. Replays reuse recorded timestamps. This is a local helper around `writeEvent`, not a kernel modification.

### Atomic-write protocol

- Initial admission: prepare/save native original as today; short tx takes family SHARE, then run lock R, checks replay and ownership, runs rate gate, writes capture + pending + slot-0 reservation + send authorization together. A 429 creates no accepted pending obligation. Commit before enqueue. If the pending transaction COMMIT acknowledgment is unknown, read the deterministic pending/reservation identities before deciding rollback/refund; do not turn acknowledgment loss into permission for another admission. Duplicate HTTP returns the existing handle without admission/send.
- Send: perform fixed-ID enqueue outside tx. On matching acceptance, short tx under R appends the acceptance receipt; QUEUED/REQUEUED follows as projection. Worker entry can append acceptance+started before producer acknowledgment. Both validate reservation, payload digest and permitted ownership. Acceptance remains factual even if manual disposition has since committed; it never clears that disposition or authorizes work.
- Definitive rejection: under R append rejection only if no acceptance exists. Refund only the original caller's live process-local token, once. A later retry re-enters the gate, appends a new send authorization for the SAME reservation/ID. Lost acknowledgment never refunds, abandons the slot or declares failure. Unknown lookup remains unknown; verified matching workflow repairs acceptance without recharging.
- Absence is only an observation. If an unresolved send may still land, retain its ID. A gated resend of that same ID is allowed only after authoritative absence and identity validation, with a new send authorization; a concurrent old enqueue is deduplicated by fixed workflow ID. Neither attempt spends another recovery slot. A rejection for send N cannot clear unknown send N-1. Retained authorization/acceptance and validated workflow input, not SDK ID reuse alone, authorize worker entry.
- Fresh recovery reservation: family SHARE then R; re-read native completion/disposition and all delivery receipts, preserve original submitted_at, require known imported history, <2 distinct accepted recovery slots and age <7 days at authorization. No unresolved send or live delivery may be superseded. Rejected reservation reuses its slot; the next slot follows the last accepted recovery. Unknown history or terminal ERROR/CANCELLED/DLQ is manual. An accepted row whose engine evidence was pruned is not proof of eligibility for another delivery.
- A recovery send authorization committed before the seven-day boundary is an in-flight admission obligation; late acknowledgment repairs that authorization even after the boundary. No new authorization at/after seven days. Count distinct accepted recovery reservations, reserve unresolved capacity, never reset history. An accepted final delivery may finish after age/count expiry. DBOS restart limits and the bounded within-delivery retry policy remain separate.
- Binding: in the existing group-locked short load tx, after frozen inputs/intent are known and before returning the model closure, take R, revalidate open run, and append/read the exact binding. Reuse its attempt, policy and admission snapshot. Compare recomputed frozen/intent digest; do not refresh snapshots on replay. Sealed matching candidate needs no new binding. Bound-slot collision with another candidate is held/manual, never `max+1` repurchase. Other evaluator allocations need not be redesigned in this lane.
- Manual disposition: R only; re-read exact native completion proof, then insert the unique disposition if still open. Return existing equivalent disposition on retry, or already-completed if native receipt won. Terminal notification is repairable afterward. No job_events marker can revoke manual disposition. A new explicit authorized domain action requires its own normal native identity/CAS, not resetting this run.

Existing unit claim/result events remain the only reusable model outcome store. Pass server-owned run/binding coordinates through `attempt.ts`, `evaluation-authority.ts` and `evaluate-submission.ts` into recorded execution. Before each fresh unit claim, under R then existing claim lock C, validate ownership, binding/request digest, current expected head/admission and no manual disposition. Detect any earlier claimed unit without valid result before admitting an unclaimed unit. Reuse valid results; do not invent another task ID. Cap reservation is not actual cost. Late result evidence may still append under its old claim ID after disposition, but cannot reopen the run.

Control table belongs with existing runtime-control exclusions in `src/server/export/constants.ts`; events remain permanent historical evidence. Full-DB restore must preserve control incarnation/epoch, native rows and engine state together. Ordinary event archive import alone is not execution authority. Export classification is not proof of safe archive restore; that broader parent-owned acceptance remains open, and this design does not authorize changing archive/bootstrap restore flows. Installer must call existing `lockProducerFenceInstaller(tx)` before family/relation lookup or DDL. This is an invariant for later implementation, not another1394 review.

## 2. Exact late-worker fence and lock order

### Existing source facts

`evaluateSubmission:306–318,548–649` holds the group session advisory lock across load, model work and seal, using short load/seal transactions. `src/db/session-advisory-lock.ts:withinSessionAdvisoryLock` reserves one connection, commits each short transaction and finally unlocks. A separate process can continue external I/O after connection loss; session locking alone does not establish paid-call uniqueness.

`src/server/assessment/activate.ts:218–275,310–333,425–529` orders learning lock G, group advisory lock, candidate row, submission row, head row, question root/admission checks, settlement, head CAS, activation event. Its settlement callback runs BEFORE head UPDATE. Expected effective ID plus generation prevents stale/ABA head replacement; it does not inspect operational manual disposition.

`activateSubmissionCandidate:672–687` invokes `beforeActivate` after G but before group, invokes `recordOriginal` in the settlement callback, then writes `record` after `activated`. `commitFormalAttempt:284–289` returns held after a separate capture tx. `durable-attempt:208–277` writes resolution under R in the activation transaction; held/already-effective cases later use a separate resolution tx. These are all required fence sites.

### Proposed operation placement

Define `assertJudgeRunOpen(tx, execution)` in the capability-owned operational helper. It takes existing R=`pg_advisory_xact_lock(hashtext(runId))`, parses permanent receipts, validates binding/authorized delivery and rejects permanent disposition. It performs ordinary MVCC native reads and takes no G/group/question locks. Return structured `completed | disposed | open`; callers must distinguish them, not catch disposed as a retryable model error.

| Operation | Lock order and smallest change |
| --- | --- |
| Binding/load | Existing group session+xact and submission locks, then short family SHARE if validating admission epoch, then R. Write binding and release tx before model work. |
| Fresh claim | Group session is already owned; independent short claim tx takes family SHARE if needed, R, then claim lock C. Add async transactional run validation before claim INSERT. Do not turn synchronous `beforeClaim` into an external I/O callback. |
| Candidate seal | Still under group session, seal tx takes R and rejects disposed before evaluation INSERT. Recheck even when a saved result was reused. Existing candidate replay may be read, but confers no right to activate. |
| Activation | Existing G → group → candidate/submission/head/root, then R at the START of the existing settlement closure, before capture and `learningSettlement`; hold R until native resolution commits in the same outer tx. Add a narrow server-owned execution option to `activateSubmissionCandidate`; do not require a kernel activation hook. |
| Held and already-effective resolution | `writeResolution` takes R, validates completion/disposition again and writes idempotently. Held capture transaction also checks R before capture's lock A. Already-effective requires exact native activation proof for this operation; do not infer it merely from a same-submission head. |
| Manual disposition | R only. No group session/G/root lock and no release helper that updates question rows inside this tx. Native completion check and disposition INSERT are one transaction. |

Ordering details: initial dispatch is family SHARE → R → capture A; activation is G → group/native rows → R → capture A → settlement → resolution under already-held R. Never take group or G after R. Phase transitions may take family UPDATE → R to map ownership but must not wait on G/group while retaining either. Any diagnostic release happens after disposition commit through the existing owner, retaining its accepted-original guard. It is not required for fencing.

Concrete interleaving: W binds attempt 3, commits unit claim and calls the model while holding only its group session lock. M acquires R, sees no resolution/exact activation and commits manual disposition without waiting for W's group lock. W later appends its existing unit result, starts seal tx and acquires R; the disposition prevents candidate INSERT. If W sealed just before M, M still wins R before activation's settlement callback; that callback rejects and its whole activation tx rolls back without settlement/head/resolution. If activation wins R first, M waits until activation+resolution commit, then returns already-completed instead of writing manual.

A crash after seal but before activation is handled by the same second check. A held run cannot publish a late resolution after manual because its separate writeResolution tx uses R too. A preexisting exact activation without resolution is completion repair, not manual failure; use the bound candidate execution key/digest and activation receipt, not newest evaluation. `runJudgeRun` entry/catch and terminal repair must prefer this proof and committed resolution before disposition or transport failure.

This fence cannot recall an already authorized network request: manual may commit after claim and before the worker actually sends. It guarantees no subsequent seal/activation for the disposed run and no newly admitted unit, not provider cancellation or proof of zero billing. Old binaries that omit these checks must be quiesced before transfer. These are source-derived design properties, not observed runtime guarantees.

All changes above fit `practice/server/assessment/{durable-attempt,attempt}.ts`, `practice/server/judge/{evaluate-submission,evaluation-authority,recorded-model-executor}.ts` and the proposed practice helper. `src/server/assessment/activate.ts`, `src/db/session-advisory-lock.ts`, kernel manifest, Start and canonical boot/shutdown are evidence dependencies only. No extra ownership extension is needed for this fence. Using `beforeActivate` alone would need redesign; it is explicitly rejected here.

## 3. Shared permanent read and external observation

### Existing source facts

`judge-run-status-route.ts:63–190` currently reads job replay first and may consult queue before native reconstruction. `judge-run-payload.ts:203–261` reconstructs native original/current-effective identities; its parameter is Db-only, but both `resolveVerdictForAttempt:417` and `resolveVerdictsForNativeAttempts:745` in `src/kernel/read-models/assessment-verdict.ts` already accept `Db | Tx`. Widen only the practice wrapper, preserve those canonical resolvers.

`placementAssessmentProgress:75–99` advances only on matching native head plus applied/ineligible settlement. Lines104–145 infer held/pending from pending/resolution/job_events. `materializeInterventionDiagnostics:597–657` embeds FAILED/REQUEUED SQL. It also guards accepted native originals at53–63 and608. `releaseInterventionDiagnosticSubmissionClaim` independently checks absence of a native original at194–203. Retention does not currently erase that native-original guard; the new contract must preserve it, not claim every failed diagnostic is presently reopenable.

### Proposed types and selector

Put the implementation in `src/capabilities/practice/server/judge-run-observation.ts`, types/schema with existing judge status contracts. `loadJudgeRunEvidence(db: Db | Tx, query)` accepts a discriminated run-ID or question-ID batch and is the ONLY permanent operational selector, including pending-run discovery: batched pending, binding, delivery, ownership, disposition and validated native-resolution identity, plus exact native completion/settlement refs. Native verdict projection delegates to the existing resolvers. Do not expose raw event JSON beyond schema parsing.

```ts
type PermanentJudgeState =
  | { kind: 'resolved'; completion: NativeCompletion; activity: 'terminal' }
  | { kind: 'manual'; disposition: JudgeDisposition; activity: 'held' }
  | { kind: 'pending'; delivery: PermanentDelivery; activity: 'pending' }
  | { kind: 'unmapped'; reason: 'legacy' | 'corrupt' | 'ownership_unknown'; activity: 'held' }
  | { kind: 'absent' };
type WorkflowObservation =
  | { kind: 'present'; identity: ValidatedDelivery; state: WorkflowState }
  | { kind: 'absent'; identity: DeliveryPointer; observedAt: string }
  | { kind: 'unavailable'; reason: 'timeout' | 'backend_unavailable' | 'identity_unverified' };
type StatusRead =
  | { kind: 'found'; value: JudgeRunStatusDto }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; reason: 'domain_read' | 'observation_unavailable' };
readJudgeRunPermanent(db: Db | Tx, runId: RunId): Promise<PermanentJudgeState>;
readJudgeRunStatus(database: Db, runId: RunId): Promise<StatusRead>;
```

These are pseudotypes, derived in implementation from existing schemas plus the proposed receipt schemas. `NativeCompletion` references resolution/candidate/activation/settlement; it stores no new score. `PermanentDelivery` is a discriminated reserved_unsent/send_unknown/accepted/started value with immutable delivery pointer and known/unknown recovery history. Native resolved includes `review_required`; resolution means processing ended, not that placement may advance.

Permanent precedence: validated native resolution or exact native completion receipt, then manual disposition, then mapped pending receipts. Orphaned/corrupt/import-only evidence is held/unmapped, never absent. Candidate alone, DBOS SUCCESS and ai_task_runs success are not completion. Manual is always `{status:'failed',result:null}`. A resolved DTO uses the existing reconstruction and `JudgeRunTerminalResultSchema`, preserving original/current-effective IDs and unsupported/score-null semantics.

HTTP sequence: short read-only domain transaction loads a consistent snapshot and projects terminal result; release it. If terminal, return without DBOS. Otherwise invoke a judge-scoped read-only observation port using the supplied immutable delivery pointer. Inject the port through a small factory/dependency seam; the production two-argument export binds the family DBOSClient adapter, never a global domain Db or a recovering DBOS runtime. Re-read permanent state once before using the observation; terminal truth wins and changed ownership/delivery invalidates the old observation. This is bounded reading, not recovery.

Known pending plus unavailable observation returns its best known queued/started DTO with null result. No local evidence plus observation unavailable returns `unavailable`, which the HTTP adapter maps to503 through existing error handling, not404. Only successful authoritative reads showing no permanent, compatibility notification or applicable engine evidence permit not_found/404. If a run has no mapped pointer, consult the deterministic original ID and bounded known legacy IDs through the same observation adapter; unresolvable identity is unavailable. An accepted delivery missing from DBOS is historical evidence loss, never run absence.

DBOS ERROR/CANCELLED/exhaustion observed only by the HTTP reader does not write a manual receipt or activate recovery. It remains nonterminal until the sole family reconciler persists disposition, unless domain completion already exists. Retained legacy terminal notifications may supply compatibility status only after permanent truth; they cannot reopen a manual run. Reads never enqueue, reserve, charge, dispose or repair notifications.

Tx usage: placement passes its existing tx and derived native run ID to `readJudgeRunPermanent`, retaining session locking and its native head/settlement advancement rule. Resolved-without-settlement/manual/unmapped maps to held; mapped pending maps to pending with the unchanged poll URL. Existing no-durable-intent candidate/retry logic remains. Intervention batch-loads states for its small scheduled question set in the supplied tx, replaces its job_events FAILED/REQUEUED subquery with those shared states, and keeps accepted-original/no-committed-attempt predicates in the final conditional UPDATE. Any accepted pending, manual or unknown run blocks automatic claim reopening; absence alone cannot override a native original. Pre-acceptance failed synchronous claims still use the existing lease/release path.

Use one SQL statement for the permanent operational classification snapshot, including resolution/disposition/ownership, or a caller-owned consistent read transaction. HTTP owns its short repeatable-read transaction; Tx callers retain their transaction and never open another pool transaction or call DBOS. No mutable run locks are necessary for display. Mutation consumers retain their existing conditional native-original predicates; their state read grants no dispatch/activation authority. SQL/read errors propagate as unavailable/abort, never an empty list or absent.

Export the read operation from `practice/public.ts`; make only the approved `practice/api/judge-run-status-route.ts` adapter call it. Status/body remain `{run_id,status:'queued'|'started'|'done'|'failed',result}`. `NativeAttemptDispatchPort` remains four arguments returning `Promise<string|null>`, with null for synchronous handling and a run ID for accepted durable intent. Start integration stays parent/5796-owned. No hidden global DB, duplicated operational selector or Tx-side recovery loop is introduced.

## Decisive future regressions and evidence limits

1. Crash after binding/claim, then create another candidate before resuming. Same operation retains attempt/unit/task IDs; collision holds without a new paid call. Multi-unit case reuses first result, holds unknown second and admits no third.
2. Commit enqueue but lose acknowledgment/markers; race delayed original send against same-ID repair and worker entry. One acceptance/slot, no speculative refund; rejection for a newer send cannot erase an older unknown. Repeat after job_events pruning.
3. Two concurrent sweepers at recovery slots1/2 and exact seven-day boundary. Unknown send reserves capacity, rejects reuse same slot, no third accepted recovery, no new post-boundary authorization; pre-boundary authorized/accepted final delivery may finish.
4. Barrier-controlled model/seal/activation races against manual disposition, including held and already-effective paths. Either native completion commits first or manual wins and no late seal/head/settlement/resolution commits. Include DB-session loss while original external call continues and test absence of lock cycles.
5. Delete only job_events in a disposable fixture. HTTP, placement and intervention agree on resolved/manual/pending, preserve native original/effective and held semantics. Within a caller Tx, insert uncommitted disposition and prove shared reader sees it while a separate observer does not; prove no DBOS call/global-Db escape.
6. DBOS unavailable versus verified absence, mismatched workflow input, accepted delivery with pruned engine status, native completion before checkpoint and imported receipts without matching control incarnation. No false404, false grade, reopening or dispatch from reads; source scopes/import graph stay within ownership.

No tests, builds, installs, DB/service/provider/network calls, mutex actions, git mutations, tracker/PR work, other-thread communication or delegation were performed. Only the two requested /tmp artifacts were written. Runtime locking, crash behavior, request counts, retention, restore and wire parity remain unproven until parent acceptance after1394 formally merges. Parent retains migration integration, CI/merge, Linear capture and implementation decisions; this report is neither a1394 review nor an implementation assignment.

## Sealed source register

Full SHA-256 values for the decisive source files follow; the JSON includes all inspected source dependencies and starting reports. These hashes identify source only, not runtime acceptance.

| Source path | SHA-256 |
| --- | --- |
| `src/capabilities/practice/server/assessment/durable-attempt.ts` | `ff40f65a2f9eb9324c00d6e4d32f72b70ac895f32d79f232531001990f0c1f32` |
| `src/capabilities/practice/server/assessment/attempt.ts` | `52bee297f4cd6bb162f08c6ac99733b57ae5b24baba632d0cc36b6d847ad694c` |
| `src/capabilities/practice/server/judge/evaluate-submission.ts` | `f6f556f6aa44760f53406d6c17ee00fbbb0199b617c9ffb6aa4e19df39044e6e` |
| `src/capabilities/practice/server/judge/evaluation-authority.ts` | `361ed1ce454c37f3a887004105dda2c44bb68e6a3fd438238c5bb6b6e47efd01` |
| `src/capabilities/practice/server/judge/recorded-model-executor.ts` | `d341a2f7fabf6a66fc39c38e2a35430b3753bb7a03db0e03da63fea4d91f5f7b` |
| `src/capabilities/practice/server/judge-run-dispatch.ts` | `12846b0155153b41039d25d5ab3b5ad1115d46eb4af893af68314ef1c8f7b9be` |
| `src/capabilities/practice/server/judge-run-payload.ts` | `02d31e3b3a73b60ea14b5e960bd832bd124b9942d5dad157c75071da22f2f993` |
| `src/capabilities/practice/jobs/judge_run.ts` | `ee2d89d344892335828773e7b7b2bc30b26ac2c5112569c9ae9d4a7b157155c9` |
| `src/capabilities/practice/server/placement-assessment.ts` | `59510014cdb75c626a97490bf3781622a06a518869ee66a9e2dadb8b2e132cfa` |
| `src/capabilities/practice/server/intervention-diagnostics.ts` | `e0470849027888fdec49fb7f89b16b4b48e14f85a5c943deddabba6e4405652a` |
| `src/capabilities/practice/server/review-operation.ts` | `888c55639960d8e5a39d08b15dea8469cbd23c408bc94ccf5248bf7ae25a60d9` |
| `src/capabilities/practice/api/judge-run-status-route.ts` | `fd20850a2badc0b242643b74c88a07f46e69ab67b11f916fd429021189bcca94` |
| `src/server/assessment/activate.ts` | `af627ddc99bc585e17c1d0d512d53a130908c55ebeeba749e3e61dbfc4b7a3cf` |
| `src/db/schema.ts` | `46ba5b6cec6f86c6b6f025c6b631d1124b593d4e5557225921d1179b48c088a1` |
| `src/db/session-advisory-lock.ts` | `0ad6eee72a893d2deabc9f8ea1d87a437d0c84e0d01c6d80f6d68520b61538d6` |
| `src/kernel/events/events.ts` | `0a215e98ee38dc5bec6782b802926b7c4f553a3418568c41fa3bfa64360170ba` |
| `src/kernel/read-models/assessment-verdict.ts` | `5a4d75d620f47f64581a1be9c4a5f5f3265b682bde8bdf137189c2a5d5214632` |
| `src/core/schema/event/index.ts` | `3fb2b57dc02fc7b48dee5136ecb3317542e31f5c31e5aba4b97938d203c6af40` |
| `src/core/schema/event/experimental.ts` | `6e4ee484de40710aadd7a9a3b27c45930ad007a79ab2b179f286dde2126029b9` |
| `src/server/durable/producer-fence-lock.ts` | `4b1676b2c1df9657c01bebc1e71a071401150f63d33a12becb5cd2f639e54c60` |
