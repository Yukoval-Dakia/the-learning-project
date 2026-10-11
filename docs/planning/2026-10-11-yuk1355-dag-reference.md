# YUK-1355: item_prior_backfill DAG member reference checkpoint

> Current source checkpoint: [fixed shared-store integration](#2026-10-11-fixed-shared-store-integration).
> Earlier sections describe their pinned revisions. The explicit versioned path now
> consumes the real store; the original candidate remains blocked and unregistered.

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

## 2026-10-11 parent-review fixes (round 1)

Parent review of `3cf13cf64` identified three substantive gaps; fixed on this
tree (B's rejected handoff `d78e3c43f` was NOT read or integrated — cross-
revision unknown predicate and backend/generation reserve verification are
being reworked by lane B; the next fixed protocol arrives via the parent).

### 1. Durable unknowns are no longer swallowable

`executeItemPriorRep` classifies store and receipt failures explicitly:

- `lookupRep`/`admitRep` throws → `ItemPriorDurableStoreError`
  (`ITEM_PRIOR_DURABLE_STORE`): no send happened this run, but prior
  obligations are unreadable — propagates.
- Provider send failed AND `completeRep(unknown)` throws →
  `ItemPriorReceiptPersistenceError` (`ITEM_PRIOR_RECEIPT_PERSISTENCE`,
  carries the rep identity): paid outcome AND receipt state both unresolved —
  propagates for reconciliation; never isolated, never an in-memory-only held.
- Provider succeeded AND `completeRep(output)` throws → same class: the
  receipt is unconfirmed, so the parsed draft is NOT returned.
- Provider errors with successful receipt persistence still settle as
  store-backed `held` (recorded unknown), unchanged.

`runItemPriorDurableMemberExecution` rethrows all three classes; its generic
per-item catch is now documented honestly as a defensive net for unexpected
non-durable failures (the earlier "unknown outcomes never reach this catch"
comment was wrong and is gone). Provider failures never reach the catch at
all — they are port-recorded and surface as `held`.

### 2. Frozen paid inputs (recovery drift fixed)

The parent-flagged drift was real: execution re-called
`prepareItemPriorWork` after the cached admission, re-resolving the subject
profile; a changed profile would re-key the input digest, strand old
obligations under the old digest and re-send the same logical input under a
new identity. Now `admitItemPriorMember` prepares every candidate's work
(input, profile, digests, repCount) inside the same read-only snapshot and
records it in the admission (`ItemPriorAdmission.prepared`); execution
consumes only the frozen works and never re-resolves. A recorded-step replay
returns the recorded works verbatim; an unrecorded admission re-runs
preparation against a fresh consistent snapshot, which is safe because
nothing has been sent under any digest yet. The happy-path unit test asserts
`resolveSubjectProfileForKnowledgeIds` is called exactly once per candidate
(admission only).

### 3. Real application verification

`applyItemPrior` is conflict-ignoring and returns void, so the old
`return true` proved nothing. `commitItemPriorStagedCalibration` now reads
the hard row back and compares it against the staged draft — numeric columns
at their float4 stored representation (`Math.fround` on both sides; PG
`real` legally shortens medians), `source` exactly (wording corrected in
round 2; the round-1 text below claimed an exact double round-trip, which
R1 disproved — see the round-2 section):

- existing row matching the staged draft → `applied` (idempotent replay,
  no second write);
- existing row differing → `superseded` with the persisted values — the
  foreign anchor is never overwritten and this attempt's draft was not
  persisted;
- no row → write once, re-read; a missing row escalates to
  `ItemPriorApplicationError`, a differing row to `superseded`;
- write or read failures throw `ItemPriorApplicationError`
  (`ITEM_PRIOR_APPLICATION`): every rep is already receipted so a later
  delivery replays them for free, but the application outcome itself is
  unknown and stays visible.

CAVEAT preserved in code and here: `applied` proves the domain row matches
this staged draft, NOT causal authorship — an identical row written earlier
by another attempt is indistinguishable until lane B's receipt-bound
comparison exists. No applied guarantee is claimed without the shared fixed
protocol. The member result adds a `superseded` counter alongside `applied`.

### Test surface changes

The obsolete "isolates a preparation failure" family test (preparation moved
into admission and profile resolution cannot throw) was replaced by:
receipt-persistence propagation, durable-store propagation, application-
failure propagation, and superseded counting; operation-level tests add
lookup/admit/complete failure classification and the four application
verification cases (superseded without write, matching-row idempotency,
write failure, write-without-row). Retained-path tests are unchanged.

### Validation record (fresh, round 1)

Same Node/pnpm as before; gates rerun after these fixes with sealed logs
(see below). 29 unit tests total (16 operation incl. 2 retained, 6 family
incl. 3 blocked-candidate proofs, 7 new classification/verification cases
within the two files' counts).

```text
unit exit=0        2 files, 29 tests passed
typecheck exit=0   both TypeScript projects
lint exit=0        174 warnings (baseline level; owned files scoped-clean)
build exit=0       Vite SPA, Start client/server, Hono server, worker, migrate
```

Logs under `/private/var/folders/bt/rcf5s7tx3s93g3dz0046y96w0000gn/T/opencode/tlp-yuk1355-reps-gates-r1/`.
SHA-256:

```text
unit.log      122cd4527f7ea945b65d88d10d78bbdb3344fdebc946f142d524ff18dd2ab431
typecheck.log 36ea241c6942f1a41abb39db13194e6117c19022d769f9059b8a87960ef20ad6
lint.log      08c22324c601b8576c922e3b6f4af483a8ba0de462c2d8029ecad1d725f1407b
build.log     49494ab3eb68057fda31eeb11b29779566cb4e19414d26e639d206178a0f1195
```

`git diff --check` passed. Same five owned files only; the blocked candidate's
always-reject is untouched and nothing new is registered or booted. The
provisional `ItemPriorRepEffectPort` remains the sole B integration point;
B's rejected `d78e3c43f` was never read or imported.

## 2026-10-11 round 2: float4 application comparison (R1 P1 fix)

Independent R1 on `927a927ef` confirmed one P1, now fixed on this tree (the
other three parent-review items were already cleared in round 1). B's next
shared protocol is still unfixed; `d78e3c43f` remains not integrated and the
blocked candidate still always rejects.

### Root cause and fix

`item_calibration.b / b_anchor / confidence` are PG `real` (float4, ~7
significant digits). `stagedRowMatches` compared with strict double equality,
so a legal even-count median like `(0.1 + 0.2) / 2` (double
0.15000000000000002) or a high-precision LLM value such as 1.35792468 would
read back shortened and misreport a freshly applied anchor as `superseded`.
The comparison now happens at the stored representation: `float4Equals`
applies `Math.fround` (float32) to both sides, null/NaN never match a finite
intended value, and `source` stays an exact string compare. No epsilon — a
genuinely different anchor (distinct at float4, e.g. 1.234567 vs 1.234568)
still reports `superseded`. Schema, domain write values and production model
calls are untouched. The round-1 document text claiming an "exact double
round-trip" is corrected above and in the seam's doc comment.

### Test additions (unit, offline)

- even-count median + 1/3 confidence and an 8-digit high-precision value
  verify `applied` across float4 storage (test writer mocks now store
  `Math.fround(...)` to model PG `real`);
- re-committing the same staged draft is idempotent at float4 precision with
  exactly one write;
- distinct-at-float4 values and null columns stay `superseded` (no epsilon
  masking).

A real-PG scoped assertion is prepared in
`tests/integration/item-prior-durable-member.db.test.ts` (applies, checks
`Math.fround(row.b) === Math.fround(evenMedian)` and `!== evenMedian`, re-verifies
idempotently, then supersedes a differing anchor) — prepared only, NOT run
by this lane; the parent executes the DB partition.

### Validation record (fresh, round 2)

Same Node `24.19.0` / pnpm `11.13.1`; gates rerun after the float4 fix with
sealed logs. 32 unit tests total (19 operation incl. 2 retained, 6 family
incl. 3 blocked-candidate proofs, plus the float4 comparison cases within
these files' counts).

```text
unit exit=0        2 files, 32 tests passed
typecheck exit=0   both TypeScript projects (covers the prepared DB test file)
lint exit=0        174 warnings (baseline level; owned files scoped-clean)
build exit=0       Vite SPA, Start client/server, Hono server, worker, migrate
```

Logs under `/private/var/folders/bt/rcf5s7tx3s93g3dz0046y96w0000gn/T/opencode/tlp-yuk1355-reps-gates-r2/`.
SHA-256:

```text
unit.log      e5ffbc6c8f759b0b1fb506f1ee4df6ca16fbe684787606489bde1a6869051872
typecheck.log 36ea241c6942f1a41abb39db13194e6117c19022d769f9059b8a87960ef20ad6
lint.log      78b5620468461422a722963c0bc49d43bc3fb5afdaf3f8d20bea63dc6afeedaf
build.log     fb61cc6cce537fdae953328e7607b6115180fef8c141cada76efaaf043e604f6
```

`git diff --check` passed. Owned surface unchanged (five files plus the
prepared DB test assertions inside the already-owned
`tests/integration/item-prior-durable-member.db.test.ts`). The blocked
candidate still always rejects; nothing registered; B's rejected
`d78e3c43f` was never read or imported. This diff (`927a927ef` → next
commit) awaits the parent-arranged single R2; this lane's R1 budget is spent
and no third review is requested.

## Per-rep stage final R2

R2 on `3acf6be20eb162f8ec8b557317525ca7883e9de6` versus `927a927effc4364009823350c4e100b3c10a94ba` confirms the float4 P1 is resolved, with no new P0/P1 within scope. Parent independently ran 32 unit cases successfully. The actual Postgres test is still prepared, not run. This completes the per-rep stage R1/R2 budget; shared protocol integration is a separate substantive change and remains pending. No paid-effect or runtime acceptance is inferred.


## 2026-10-11 fixed shared-store integration

Sole writer in the ORIGINAL
`/Volumes/YukovalSBak/yukoval-projects/tlp-migration-dag-reference`, existing
`feat/yuk-1355-dag-reference`, starting clean at
`8a584e1ce631e5b1534b35dea18845562850e222`. The parent already normally merged
fixed B `8e3b1af04` and main/0119. This work reads only that local fixed source.
The owner subsequently reports B R2 `403c7248682129722be0051b9fba5622540c71f3`
NONE within its scope, with production shared APIs unchanged. Its final real-DB
acceptance remains parent-owned and pending a new window. No accepted runtime
or cutover is inferred.

### Concrete consumer and behavior

`runItemPriorDurableMemberExecution` constructs `ItemPriorPaidEffectAdapter`
from the recorded original dispatch and the real `Db`. It no longer accepts
`ItemPriorRepEffectPort`; the provisional lookup/admit interface and its
in-memory store doubles are deleted. The adapter calls the fixed
`reservePaidEffect`, `recordPaidEffectResult`, `markPaidEffectUnknown`,
`readPaidEffect` and `recordPaidEffectApplication` exports directly.

- A strict version-1 request requires backend, delivery ID, original generation
  and tick ID. Tick ID must equal the frozen DAG run ID. Generation is required
  even for bootstrap through this new contract. It is never manufactured from
  a current control read. The distinct `item-prior-dispatched-admission-v1`
  checkpoint freezes dispatch, normalized parameters and prepared work.
  Recorded dispatch/identity/parameter mismatch rejects execution. The old
  unversioned candidate keeps its original checkpoint and always rejects.
- The paid identity is family `item_prior_backfill`, question entity ID, frozen
  workset revision, `feature/rep:N` or `llasa/rep:0`, and the shared input digest.
  The exact stored input envelope is `{version:1, taskName, input,
  ctx:{subjectProfile}}`; the task runner receives those same prepared arguments.
  The adapter recomputes the digest before reservation and rejects drift.
- Frozen workset revision is the shared digest of `{version:1,
  questionRevision, inputDigest, repCount}`. The question-row revision remains
  separately available in the prepared work. B's recognized feature-sibling
  exemption in `paid-effect-store.ts` / `paid-effect-protocol.ts` assumes one
  revision identifies one complete frozen workset. Binding all three coordinates
  prevents knowledge/profile input drift and rep-count changes from using that
  exemption around an old unknown. A bare question-row revision is insufficient
  for this adapter. No shared implementation change is required for this binding.
- Only `winner` sends. The complete winner identity and fence go to result or
  unknown persistence, together with the original delivery ID. `completed`
  parses immutable version-1 output without sending; `held` never sends.
  Provider errors become a durable unknown. Store, fenced-control and receipt
  failures propagate. A held rep stops later sibling reservations; remaining
  slots are pending. Later nights and changed work cannot turn that unknown into
  a new send ticket.
- Application re-reads every immutable result from the actual store and
  recomputes the staged result before any domain write. The retained applier,
  float4 readback and every rep's application receipt share one transaction.
  Its version-1 application payload binds the question revision, input digest,
  rep count, ordered identities/result digests, draft and disposition.
  Immutable application mismatch rolls the transaction back. A later replay
  reuses paid results. `matched` describes equality with the hard row; it never
  claims causal authorship. `superseded` preserves a foreign differing anchor.
  Known parse failures settle `no-anchor` with receipts and no hard-row write.
- The member throws `ItemPriorMemberIncompleteError` over any held/incomplete
  item. Successful return requires settled dispositions with transactional
  application receipts. It never writes DAG node status in this lane.

Only seven owned files change: operation, operation units, family, family units,
the narrow new family adapter, the existing DB test file, and this document.
The retained handler, shared paid-effect production modules, schema/SQL,
registration, boot, manifest, public barrels, Lane C and default pg-boss path
are not cut over. No child delegation or further old-diff review was started.
Prior A/C R1/R2 remain closed; this integration is a new substantive review
scope for the parent.

### Prepared real-DB cases

`tests/integration/item-prior-durable-member.db.test.ts` contains 11 prepared
cases: three retained admission/float4 cases and eight concrete adapter/store
cases. They use the real Drizzle database and fixed B transitions. The task
runner supplies offline output only, so these are DB proofs, not provider proofs.
They are NOT RUN in this lane.

1. Concurrent real reservations yield one winner; wrong fence and losing
   delivery cannot complete; immutable result replay performs no send; stored
   envelope and shared digest match exactly.
2. Actual versioned member execution records the frozen provider arguments,
   aggregates valid reps through float4 storage, and replays original inputs
   and application receipts after a question edit.
3. A provider exception records unknown, stops siblings, rejects member
   completion, and remains held through a new DAG night, changed input,
   changed question revision and expanded rep count. Old unknown history and
   pending DAG nodes are preserved.
4. A real immutable application conflict rolls back the hard-row write and
   all application transitions. Already-recorded paid results replay for free.
5. Explicit control fences the original generation without a provider call or
   a committed intent. The adapter never reads current generation to upgrade it.
6. LLaSA uses one paid unit with frozen reference/choices input and its retained
   provenance, regardless of requested reps.
7. Equal and differing foreign anchors remain unchanged. Bare readback leaves
   effects `receipt_ready`; only matching transactional application receipts
   settle the disposition, without causal attribution.
8. All-invalid known outputs settle `no-anchor` with every application receipt
   and no invented hard row.

### Permitted validation and receipts

Node `24.19.0` from `/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin`,
pnpm `11.13.1`. Final unit checks drive retained behavior, parsing/error
classification, frozen workset binding, held-stop behavior, original-dispatch
validation and an actual adapter/store transaction failure through a concrete
Drizzle/postgres-js client whose driver rejects before connecting. No mock
claims database safety or successful paid admission.

```text
scoped units       exit 0; 2 files / 22 tests
pnpm typecheck     exit 0; both TS projects, including all prepared DB cases
pnpm lint          exit 0; 172 warnings
owned Biome        exit 0; 6 source/test files, no warnings or errors
pnpm build         exit 0; SPA, Start client/server, API, worker, migrate
```

Sealed local logs, including earlier failing attempts, and `receipt.json`:
`/tmp/yuk1355-item-prior-shared-integration-20261011T104259Z/`.
Final log SHA-256:

```text
unit-final2       7510a0147efeb8a1d68add427cc61d1261a01e73e907ac636525bc460362c109
typecheck-final3  36ea241c6942f1a41abb39db13194e6117c19022d769f9059b8a87960ef20ad6
lint-final       3bb99fe5aefbae3aebe64e9b4b53f312a370015c98323e4bd0099f448b74e6cd
owned-biome      201178af575c70bc8663078255965f0c87e364938856fa46b0dfd288dd8df957
build-final      f3749474b7076d1d516a12ca637a659425eefa79e6c767ea69608813e547e67e
```

### Parent-owned gates before admission

Run the prepared scoped DB file with 0119 applied in the authorized DB window:

```bash
pnpm vitest run --config vitest.db.config.ts tests/integration/item-prior-durable-member.db.test.ts
```

Then validate the actual versioned producer/host path, persisted original
backend/generation/DAG identity, old unversioned job disposition, concurrent
backend admission, crash/restart with unfinished sending and application,
lease-expiry unknown classification, switch/rollback and real DAG downstream
non-completion over held work. Provider actual-output/cost quality and paid
acceptance remain separate gates. Registration/default admission and runtime
cutover stay parent-owned until those proofs and the new integration review
are complete. B's final real-DB gate also remains open.

This lane ran no DB/testcontainers/Docker/runtime/provider or credential/lock
operations, and performed no push, PR, Linear or child delegation. The parent
owns PLAN/.remember/Linear capture and issue state; no new shared-source fix
or duplicate tracker item is requested by this consumer integration. Keep the
existing migration/recovery/exit obligations open.
