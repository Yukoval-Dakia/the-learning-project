# YUK-1355: item_prior_backfill DAG member reference checkpoint

Base: `6f1f3e07e41a4db7b302f5404daf7e3067999423`, branch
`feat/yuk-1355-dag-reference`. This continues existing uncommitted WIP.
The retained handler consumes the extracted operation. The DBOS candidate is
unregistered and stops after read-only admission with an explicit prerequisite
error. It cannot execute paid work or complete a business obligation.

## Ownership and scope

Lane A owns the retained job, the new practice operation and its unit tests,
`src/server/durable/item-prior-family.ts` and its unit tests,
`tests/integration/item-prior-durable-member.db.test.ts`, and this document.
`vitest.shared.ts` contains only the three exact additive test entries started
in the prior WIP; the parent reconciles that shared file serially.

No policies, core/domain logic, registrations, boot, manifests, schema,
migrations, public barrels or Start files change. No independent member cron,
provider fallback, recovery poller or runtime cutover is implemented.

Lane C remains a separate second lane, default OFF, with no fallback. Its tick
identity must be frozen before dispatch. This checkpoint does not implement
Lane C or its recovery poller and does not prove either lane's runtime migration.

## Retained behavior at the base

`practice/manifest.ts:997-1002` declares `item_prior_backfill` as a root DAG
member with `dependsOn: []`. `recalibration_nightly` has a hard dependency on it
at line 1094. The orchestrator drives the member with an empty payload; the
member has no independent cron.

The extracted operation preserves the following behavior:

- Select questions lacking any `item_calibration(track='hard')` row, using
  the original unordered anti-join and `limit(maxPerRun ?? 25)`.
- Resolve knowledge names for the union of candidate knowledge IDs, then
  resolve each question's subject profile before constructing its task input.
- Default feature execution to three reps. Drop failed reps and aggregate
  surviving drafts with the existing median calculation. All failed reps
  cause that item to be skipped. Explicit one-rep execution stays supported.
- Keep LLaSA as one task call with reference/choices input. Reps greater than
  one still produce the retained warning and do not add LLaSA calls.
- Apply the existing domain writer, including its `onConflictDoNothing` behavior.
  Catch per-question provider, parse, profile and write errors; count them as
  `skipped_failed` and continue. Candidate/name reads still propagate errors.
- Report the same job yield counts and keep the existing epoch wrapper.

The extraction adds no candidate ordering. The prior WIP's `ORDER BY id` was
removed because a capped query could select a different batch.

The retained path can reselect an uncalibrated question after a provider error
or process crash. An exception does not establish whether a paid effect happened.
Preserving this existing behavior is not a claim that pg-boss prevents unknown
paid replay. It must be reconciled before a paid cutover.

## Extracted operation and live consumer

`src/capabilities/practice/server/item-prior-durable-operation.ts` owns candidate
selection, knowledge-name resolution, feature/LLaSA calculation, the call to
`applyItemPrior`, and the retained per-item loop. Candidate types derive from
the existing question row. No new domain policy is introduced.

`jobs/item_prior_backfill.ts` keeps its existing exported types, execution and
handler entry points. It normalizes method/reps and calls
`runItemPriorBackfillOperation`; this is the live retained consumer.

The DBOS candidate consumes only the candidate/name reads. It imports no paid
calibration function and performs no domain writes.

## Bounded DBOS candidate

The strict request binds `member='item_prior_backfill'`, `dagRunId`, `runDate`
and `nodeId`, with optional feature/LLaSA method and reps. It does not accept a
bare cron payload. This reference is only for the root member; it does not add
configurable upstreams or claim a template works for other members.

The candidate has one step, `item-prior-admission-v1`. Inside that step it gates
the epoch, then uses a read-only, repeatable-read transaction to verify:

- The DAG run exists, is running, and matches the request's run date.
- The member node exists, matches the node ID, and is pending/enqueued/running.
- A referenced pg-boss job is not created/retry/active.

It records the exact run/member identity, normalized method/reps, selected
questions and knowledge names. The original unordered query is retained;
once DBOS records admission, its stored candidate array defines replay order.
An admission that never checkpointed may rerun its reads.

After admission, the function always throws
`ItemPriorDurabilityPrerequisiteError`, code
`ITEM_PRIOR_DURABLE_PREREQUISITE`. An empty batch also stops here. No candidate
invocation can return SUCCESS as a substitute for business settlement. This
error means missing implementation prerequisites, not that any paid effect
occurred. The admission/error is not a durable business obligation ledger.

`registerItemPriorFamilyWorkflow` exists for parent integration but is not
called by registration, boot or manifests. Calling it later would still
register a blocked candidate; it would not enable paid execution.

## Corrections to the prior paid replay proposal

The installed DBOS SDK is pinned to 5.2.11. The following are local source
observations, not runtime recovery evidence:

- `dist/src/dbos-executor.js:532-590` increments a sequential function ID,
  looks up the stored operation at that ID and checks its function name.
  A name-keyed fake map does not model this position check.
- `dist/src/dbos-executor.js:637-732` separates exception retry from execution
  and records the output only after the step body returns. A crash before
  recording leaves the step eligible for execution during recovery even with
  `retriesAllowed:false`.
- `dist/src/dbos.js:810-818` documents and implements `DBOS.randomUUID()` as a
  deterministic workflow operation whose result is recorded/replayed.

The WIP's fresh native random token changed control flow during workflow
recovery. Skipping a previously committed item's commit step would also shift
later function IDs. Changing the token to `DBOS.randomUUID()` would instead
replay the same token, defeating the mismatch test. Neither is a safe paid
claim protocol. The speculative token protocol and its fake crash proofs were
replaced by the explicit pre-dispatch prerequisite stop.

A hard calibration row is a domain anchor, not a receipt bound to a paid attempt,
input, member or draft. `applyItemPrior` returns void after
`onConflictDoNothing`; existence alone cannot prove that this attempt's requested
result was committed. This checkpoint preserves that writer without treating it
as a durable paid receipt.

## Parent prerequisites and acceptance

Before enabling this member, the parent must provide and independently verify:

1. A durable paid claim/effect receipt owner bound to member identity, frozen
   input, each intended rep and output. Unknown outcomes must remain held across
   crashes, recovery, repeated dispatch and cross-backend cutover; they cannot
   re-enter through a new nightly run or retained anti-join.
2. Persistent business obligations and explicit dispositions. Workflow SUCCESS,
   held/skipped counts or an ERROR row cannot by themselves discharge unfinished
   work. Immutable receipt comparison must distinguish another writer's anchor
   from this attempt's result.
3. A single orchestrator driver, mutual backend exclusion, and member completion
   reported only after its obligations are discharged. The live pg-boss read
   check is neither a CAS claim nor a symmetric cutover fence. The current DAG
   node schema carries only `boss_job_id`; this lane does not invent a new column,
   table, lock or protocol to fill that gap.
4. Serial shared registration/test-list reconciliation, retained-consumer DB
   checks, actual DBOS process crash/reopen tests with stable step order, and
   authorized provider evidence for any paid execution. Other member DAG edges,
   Lane C frozen ticks/default OFF/no fallback, rollback and restore acceptance
   remain separate parent gates.

These are implementation prerequisites for the candidate. They are not optional
operational enhancements and are not satisfied by leaving it unregistered.
Independent review and exact-head CI remain parent-owned. No child delegation,
Linear update, push, PR, credentials, locks, DB, Docker, provider or runtime
acceptance is performed by this lane.

## Validation record

Prior draft statements saying unit tests had run are not evidence. The results
below come from fresh offline runs in this continuation.

- Retained operation unit tests exercise the live retained execution entry with
  stubbed provider/persistence and real parsing/median calculation. They assert
  numeric writer inputs and all-failed item isolation, not model output quality.
- Candidate unit tests check the explicit prerequisite stop, frozen admission
  under a one-step double, and identity/live-job rejection. They are not DBOS
  runtime or crash recovery tests.
- Prepared DB tests use real Postgres for anti-join/identity/unchanged anchors
  and a one-step double for admission replay. They are unrun in this lane.
- Existing `tests/integration/item_prior_backfill.db.test.ts` is unchanged and
  unrun here. No full local test suite is allowed.

Fresh validation used Node `24.19.0` from
`/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin`, including a fresh
`pnpm exec node --version` check. pnpm reported `11.13.1`.

- `pnpm vitest run --config vitest.unit.config.ts
  src/capabilities/practice/server/item-prior-durable-operation.unit.test.ts
  src/server/durable/item-prior-family.unit.test.ts`: 2 files, 5 tests passed.
- `pnpm typecheck`: passed both TypeScript projects.
- `pnpm lint`: exit 0, 174 warnings. Scoped Biome checked all 7 owned TypeScript
  files without diagnostics after formatting.
- `pnpm build`: passed the Vite SPA, Start client/server, Hono server, worker
  and migrate bundles. This compiled artifacts and did not launch services.
- `git diff --check`: passed. A TypeScript AST comparison against the base
  confirmed unchanged bodies for `normalizeReps` and `sampleFeaturePriorDraft`;
  source inspection compared the remaining extraction to the retained loop.

Logs are under `/tmp/tlp-yuk1355-dag-reference-codex-gates/`. SHA-256:

```text
unit.log      e0697e34a2b0366021fc7debeea84a3a920289543c10b104e2c69f91bca5420f
typecheck.log 36ea241c6942f1a41abb39db13194e6117c19022d769f9059b8a87960ef20ad6
lint.log      24c8af2a219890e5d73b4e25b302b18c7a73a57f4b1d1ac1979aa0110b6fe472
build.log     d7fab371c9d4005ec21e9436e3912f94e457783016a3bb61f26c09b0249f199a
```

The prior speculative family/tests/document are preserved for comparison under
`/tmp/tlp-yuk1355-dag-reference-wip-20261011/`. Only the eight owned files form
this checkpoint. No DB/runtime/provider/restore/whole-migration acceptance is
claimed. The parent still owns independent review, admission audits, shared
registration reconciliation and exact-head CI.

## Independent review and parent verification

Independent R1 on `f53e1470c775ac25615a452fd037bc6fc88fcfb5` versus `6f1f3e07e41a4db7b302f5404daf7e3067999423` returned NONE: no proven P0/P1 in the eight-file diff. The initial SWE-2 request failed on quota without a verdict; Codex Sol 6.1 resumed that same R1. No second review round has been used.

Parent separately reran the two scoped unit files: five cases passed (`/tmp/yuk1355-dag-parent-unit.log`). R1 was source-only and did not repeat those checks. DB tests and DBOS runtime recovery remain unrun.

Review confirmed the retained query, three-rep/median/LLaSA behavior and failure isolation. The candidate has no reachable provider call, domain write or business-completion path and rejects even an empty batch. This does not close the missing per-rep claims/immutable receipts, cross-run unknown reconciliation, durable obligations or symmetric backend fencing. Complete those prerequisites before treating this as a reusable migrated DAG template.

## 2026-10-11 continuation: per-rep durable seams behind the provisional port

Owner renewed instruction (parent plan
`docs/planning/2026-10-11-migration-next-durable-implementation.md`, lane A,
this tree). This continuation implements the actual per-rep
preparation / execute / result-parse / aggregate / application seams on top of
the blocked candidate, preserving the default three reps, median aggregation,
the single LLaSA call, per-item error isolation and the unordered capped
candidate query. The retained pg-boss consumer keeps its behavior; the blocked
candidate keeps rejecting; the new execution path exists only behind the
provisional shared port and stays unregistered.

### Seams (src/capabilities/practice/server/item-prior-durable-operation.ts)

- `prepareItemPriorWork(db, candidate, nameById, params)` — deterministic
  preparation with the retained step order (knowledge context → subject
  profile → method-specific input). Freezes `questionRevision` (digest of the
  candidate row), `inputDigest` (digest of task name + exact input + subject
  profile, via the existing `canonicalHash`) and `repCount`
  (feature → reps, llasa → 1). No provider calls, no writes.
- `itemPriorRepIdentity(work, repIndex)` — the per-rep work identity
  `{questionId, questionRevision, method, inputDigest, repIndex}`. It excludes
  scheduler delivery identity (dagRunId / runDate / nodeId) by construction, so
  the same question on a later nightly delivery yields the same rep identities.
- `ItemPriorRepEffectPort` — provisional consumption surface for lane B's
  durable paid-effect machinery (see "Explicit B dependency").
- `executeItemPriorRep(work, repIndex, {port, runTaskFn})` — resume first: an
  existing record is replayed (parse of the immutable output text) and the
  provider is never called. Otherwise the rep must be admitted; a provider
  error records an `unknown` receipt (an exception does not prove that no paid
  effect occurred) and returns `held`; a completed response records an
  immutable `output` receipt and parses deterministically.
- `parseStagedItemPriorOutput` — result-parse seam over a receipt's text
  (`draft` or `dropped`; a completed-but-unparseable output is a known
  outcome, not an unknown one).
- `settleItemPriorStagedItem` / `runItemPriorItemRepStages` — aggregate seam in
  ascending rep order: `held` outranks `pending`; with every rep resolved,
  surviving feature drafts take the retained median (attempted = intended rep
  count; single-rep and LLaSA stay byte-identical to the retained draft), an
  empty survivor set settles `no-anchor` without a write.
- `commitItemPriorStagedCalibration(db, staged)` — application seam; writes the
  retained `applyItemPrior` anchor iff status is `ready`. Replay of a ready
  item after a crash between application and acknowledgement is a no-op
  (onConflictDoNothing); receipt-bound dispositive comparison stays with
  lane B / the parent.

### Unknown outcomes stay held

An unknown rep is a durable record, never an exception: it is returned as
status `held` with `heldReps`, is not retried in-run, is not counted as a
retryable failure, and a later nightly delivery replays it from the port
without re-admission or provider re-send. A changed question or changed input
produces new identities; the old records — including the unknown — are never
deleted or rewritten (the seam exposes no delete; receipts are single-shot).
Admission refusal (no paid effect) settles `incomplete` with `pendingReps` and
is safely retryable later.

### Explicit B dependency (provisional port)

`ItemPriorRepEffectPort` is only lane A's consumption surface. ONE owner: lane
B, task `migration-shared-durable-effects-implementation-20261011` (worktree
`tlp-migration-receipt-reference`, not read by this lane). The parent relays
B's fixed typed protocol before this repository imports a real implementation.
Until then there is NO production implementation of the port, nothing
registered/booted/manifested consumes it, it must not be presented as live
admission, and no manufactured always-success adapter may be bound to it —
the unit-test `PortDouble` exists only inside test files. When the fixed
protocol arrives, `executeItemPriorRep`'s resume/admit/complete calls are the
integration points and the parent reconciles the shapes.

### Family composition (src/server/durable/item-prior-family.ts)

`runItemPriorDurableMemberExecution(deps)` composes the seams behind the port:
one recorded `item-prior-admission-v1` step (same admission body as the
blocked candidate), then per candidate in frozen query order: preparation,
staged rep execution, application of settled items, per-item error isolation
for preparation/staging infrastructure failures (`skippedError`), and a
counted result (`applied` / `held` / `noAnchor` / `incomplete` /
`skippedError`) carrying both the delivery identity and the per-item staged
outcomes. It requires an explicit `port` AND `runTaskFn` — no defaults are
manufactured — and nothing registers or boots it. `runItemPriorDurableMember`
still always throws `ItemPriorDurabilityPrerequisiteError`; the reject is not
turned off without the shared fixed protocol.

### Retained behavior preservation

`calibrateItemPriorQuestion` now routes through `prepareItemPriorWork` and a
retained rep runner with the original semantics: LLaSA stays one call with
propagating parse errors; feature keeps the single-call fast path for
reps ≤ 1 and the per-rep catch/warn/median loop otherwise. The two retained
unit tests (default three-rep median numerics, surviving-drafts settlement
with an all-failed item left uncalibrated) are unchanged and green. The
retained handler, its job-data normalization, yield reporting and per-question
catch/skip loop are untouched.

### Validation record (fresh, this continuation)

Node `24.19.0` (`/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin`),
pnpm `11.13.1`. Logs and SHA-256 below; `unit.log` covers both owned unit
files (18 tests: 12 operation incl. the 2 retained, 6 family incl. the 3
blocked-candidate proofs).

### Remaining gates (not claimed here)

- Import of lane B's fixed typed protocol (parent relay) and reconciliation of
  `ItemPriorRepEffectPort` against it; only then can the execution path be
  wired to a real store.
- Real-DB/process gates stay parent-owned: DBOS crash/reopen recovery with
  stable step order, retained-consumer DB checks, durable-store persistence of
  held obligations across restarts and cutover, symmetric backend fencing,
  exact-head CI, independent review of this new diff.
- No DB tests were run or added in this lane; `tests/integration/
  item-prior-durable-member.db.test.ts` is unchanged. No full local suite.
```text
unit exit=0        2 files, 18 tests passed (12 operation incl. 2 retained, 6 family incl. 3 blocked-candidate)
typecheck exit=0   both TypeScript projects
lint exit=0        174 warnings (baseline-level; scoped Biome on the four owned
                   files is clean)
build exit=0       Vite SPA, Start client/server, Hono server, worker, migrate
```

Logs under `/private/var/folders/bt/rcf5s7tx3s93g3dz0046y96w0000gn/T/opencode/tlp-yuk1355-reps-gates/`.
SHA-256:

```text
unit.log      b645c5f18c6d9f6c2e2a01a577a18d445d204b5031478beefceae8899206ccd3
typecheck.log 36ea241c6942f1a41abb39db13194e6117c19022d769f9059b8a87960ef20ad6
lint.log      53911e601d2485fb592633ff552368ea753d2b511388c4b518f80d814c33bba0
build.log     6fe975d09b9c1cf584c5449518bb0c6863e4517e45a6513baaab23bf081e13a5
```

`git diff --check` passed. Owned-file surface only: the operation, its unit
tests, the family, its unit tests and this document; `vitest.shared.ts`,
schema, migrations, registration, manifests, boot, barrels and Start files are
untouched. The five files form this continuation's diff.
