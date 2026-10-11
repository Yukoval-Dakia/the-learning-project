# YUK-1355 timed-model reference source checkpoint

Lane C, continued on 2026-10-11 in
`/Volumes/YukovalSBak/yukoval-projects/tlp-migration-timed-reference`,
branch `feat/yuk-1355-timed-reference`, base
`6f1f3e07e41a4db7b302f5404daf7e3067999423`.

The retained pg-boss handler now calls the extracted calibration operation.
The DBOS candidate is unregistered and evaluates only the gate. It cannot
execute a paid batch. Enabled candidate ticks stay held because this family
has no durable pre-spend claim and outcome reconciliation implementation.
This is a bounded source checkpoint, not completion of the family migration.

The inherited draft's test, build and audit claims were not accepted as evidence.
Fresh checks below replace them. The original nine WIP files were preserved in
`/tmp/yuk1355-timed-reference-codex-20261011/initial-wip.tar.gz` before editing.

## Owned files

- `src/capabilities/practice/jobs/judge_calibration_sample.ts`
- `src/capabilities/practice/jobs/judge_calibration_sample.test.ts`
- `src/capabilities/practice/server/calibration-sample-durable-operation.ts`
- `src/capabilities/practice/server/calibration-sample-durable-operation.test.ts`
- `src/capabilities/practice/server/calibration-sample-durable-operation.db.test.ts`
- `src/server/durable/calibration-sample-family.ts`
- `src/server/durable/calibration-sample-family.test.ts`
- This reference document.
- `vitest.shared.ts`, exactly the four additive entries already started in the
  WIP: the three unit files and the prepared DB file. Parent reconciles this
  shared file serially.

No changes to config, core, domain policies, schema, migrations, manifests,
registration, boot, public barrels or Start. No independent cron. Lane A's
DAG, member identity and three-repetition policy remain outside this lane.
`hub_sync_recovery` remains deferred; no recovery poller was implemented.
Parent owns runtime admission and all cross-lane integration.

## Retained operation and live consumer

`buildJudgeCalibrationSampleHandler` remains the registered handler loaded by
the existing practice manifest. It calls `runCalibrationSampleOperation`
with the original dependencies and diagnostic behavior:

1. Read the shared runtime flag. Default OFF returns without reading config,
   resolving a provider, importing the core or writing observations.
2. Read the unchanged calibration config and perform the synchronous,
   fail-loud second-lane preflight. A resolver failure escapes before the
   batch error hook. No fallback or added provider retries.
3. Lazy-load the unchanged core, forward the original config and sample
   dependencies, log its result, and rethrow batch failures to pg-boss.

The original handler dependency name remains a type alias for the same hooks.
If a caller supplies an empty job list, provenance uses a null job ID rather
than inventing a cron identity. The handler still accepts that list as before.
The existing worker epoch fence, schedule and queue ownership are unchanged.
The new operation does not add another queue, cron or recovery owner.

The operation's DBOS source variant pins `sampleDeps.now` to `scheduledAt`.
This fixes the lower cutoff clock and the summary subject label. It does
not freeze candidate rows, prevent selection changes, or establish paid
idempotency. The candidate never invokes this paid operation.

MF8's unique index prevents duplicate sample-event writes. The existing core
calls the model before writing the sample event, isolates per-item failures,
and catches summary-write failures. Consequently, a returned count object
is not proof of a discharged durable obligation. Retained pg-boss behavior
is preserved, including its existing retry exposure.

## Bounded DBOS candidate

The capability binds typed gate dependencies with
`buildCalibrationSampleOperationPort`. The server adapter accepts only
`readGate()`; it has no paid execution method or authorization injection.
It imports no capability implementation and declares no duplicate config or
batch-result types.

`runCalibrationSampleTick` validates the exact native scheduled identity:

```text
sched-judge_calibration_sample-<scheduledAt.toISOString()>
```

It returns a diagnostic `disabled` or `held` record with that fixed identity.
Every enabled invocation stays held. Gate failures propagate. No in-memory
start-once set, random workflow token, claim lease or speculative table
protocol is used.

`registerCalibrationSampleWorkflow` defines an epoch step and a gate-only
admission step. No production caller invokes this registration function.
The workflow uses the return value of `DBOS.runStep`, including when replay
returns a cached result without running its body. The previous WIP assigned
a local variable inside the step, which could lose the record on replay.

A held result throws `CalibrationSampleAdmissionRequiredError` after the step
returns. It must not resolve the workflow as successful business completion.
A disabled result can return normally, but it is only a diagnostic skip.
Neither the step checkpoint nor a DBOS SUCCESS row discharges a business
obligation. There is no business receipt or disposition ledger in this candidate.

The gate reads current flags when its body executes. A completed gate step
replays its saved result; it does not reread the flag. This candidate cannot
spend in either case.

## Verified SDK source facts and admission prerequisite

The installed dependency is pinned to `@dbos-inc/dbos-sdk@5.2.11`.
Local source inspection established:

- `dist/src/dbos-executor.js`, `runStep`: it checks for a saved operation
  result, otherwise executes the callback, and records its output after the
  callback completes. A crash before recording can execute the callback again.
  `retriesAllowed: false` disables exception retries within an execution,
  not crash-step replay.
- The same executor uses a truthy `maxRecoveryAttempts` check. Zero selects
  the default rather than disabling recovery. The candidate's value of one
  is not a paid safety mechanism.
- `dist/src/scheduler/scheduler.js` builds normal cron identities as
  `sched-${scheduleName}-${date.toISOString()}`. Manual trigger identities
  differ and this candidate rejects them.

A calibration-specific durable pre-spend claim and reconciliation mechanism
is missing. Existing note/placement claims and the compose lock have different
business identities; none is wired to this family. This lane did not repurpose
those contracts or propose a schema/token/recovery protocol.

Before any paid DBOS admission, parent must establish durable start evidence,
immutable outcome/receipt comparison, retained selected-work identity, and
explicit handling of unknown paid outcomes. Unknown outcomes must stay held
and must never automatically re-enter the provider call. Workflow randomness,
if a later design needs it, must obey the real SDK's deterministic workflow and
step-checkpoint semantics. No random tokens were introduced here.

## Fresh offline evidence

Commands used Node 24.19.0 on PATH. `pnpm exec node --version` returned
`v24.19.0`; `pnpm --version` returned `11.13.1`.
Logs are local artifacts under
`/tmp/yuk1355-timed-reference-codex-20261011/`.

| Check | Fresh result | Log |
| --- | --- | --- |
| Scoped unit, the three new unit files | 21 passed in 3 files | `unit.log` |
| `pnpm typecheck` | exit 0, both project configs | `typecheck.log` |
| `pnpm lint` | exit 0, 174 warnings reported | `lint.log` |
| `pnpm build` | exit 0, SPA/Start/server/worker/migrate bundles | `build.log` |
| `pnpm audit:partition` | exit 0, no partition errors | `partition.log` |
| `pnpm audit:test-policy --base 6f1f3e07e41a4db7b302f5404daf7e3067999423` | exit 0, 26 cases checked across 4 files | `test-policy.log` |
| `pnpm audit:capability-boundaries` | exit 0, server-to-capability-deep remains zero | `capability-boundaries.log` |

The unit tests exercise retained default-OFF behavior, failed second-lane
preflight, dependency forwarding, visible batch errors, fixed clock forwarding,
and a candidate that cannot execute paid work. SDK doubles exercise cached
disabled/held step results and the epoch fence. These are offline checks,
not actual DBOS recovery, provider quality or paid-effect evidence.

Five integration cases are prepared, typechecked and assigned to the DB test
partition, but were not executed or collected in this continuation. They cover
the real retained handler/core and observation writes with injected provider
outputs, long nested historical data, agreement/disagreement/missing-input
branches, and zero writes from disabled/held candidate ticks.

## Remaining parent gates

1. Review this actual diff independently and reconcile `vitest.shared.ts`
   serially with the other lanes. Integrate only the owned checkpoint.
2. Run the prepared scoped DB file and existing
   `judge-calibration-sample.db.test.ts` under the authorized DB workflow.
   Fix any observed failures; typecheck does not establish DB behavior.
3. Establish the durable calibration claim/reconciliation prerequisite before
   adding a paid DBOS execution path. Preserve frozen work identity and unknown
   outcome holds, plus separate business completion/disposition evidence.
4. Perform registration, producer/schedule fencing, unique recovery ownership,
   legacy drain/rollback, actual DBOS crash/restart, restore and runtime
   acceptance. Candidate existence does not satisfy these obligations.
5. Run the parent's integration/static gates, exact-head CI and review process.
   Parent owns PR, tracker capture and delivery.

No DB, testcontainers, Docker, provider calls, paid calls, runtime services,
credential operations, runtime-lock operations, network acceptance, full test
suite, push, PR, Linear action or child delegation occurred in this continuation.

## Independent R1 and parent checks

Independent R1 reviewed all nine files at `8f16ddc83fd9de6d8396616fc8b7512f3d1fc5f3` against `6f1f3e07e41a4db7b302f5404daf7e3067999423`: NONE, no proven P0/P1. The retained pg-boss behavior and fresh/cached held-result rejection were inspected. The reviewer did not run DB or runtime checks.

Parent independently passed 21 unit cases across three files (`/tmp/yuk1355-timed-parent-unit.log`). Durable claims, frozen work identity, outcome reconciliation and business receipts remain admission prerequisites. No production registration, paid execution, runtime cutover or deployment is authorized by this checkpoint.

## 2026-10-11 continuation — frozen workset, per-item effect identity, staged resume/apply seams

Actual next implementation on the same tree (cursor `07f1d5029`, branch `feat/yuk-1355-timed-reference`).
Only the two owned source files plus this doc changed; the family file, the retained handler, the
core, schema, migrations, manifests, registration, boot, barrels, Start and `vitest.shared.ts` are
untouched in this continuation.

### What was implemented (Part 2 of `calibration-sample-durable-operation.ts`)

1. **Delivery ≠ effect identity, concretely.** `CalibrationSampleTickSource` (Part 1) remains the
   scheduler DELIVERY identity and is not an input anywhere in Part 2. Effect identity is
   `CalibrationEffectIdentity` — `family`, `judgeEventId` (entity), `workSetId` (revision),
   `provider`/`model` (the pinned second lane), `inputDigest` (canonical hash of the frozen
   re-judge input face, via the shared `@/core/migration/canonical` primitives — no local crypto).
   `computeCalibrationWorkSetId` derives the revision from anchor+config only: two different
   deliveries of the same anchor+config freeze the same workset; a changed anchor or lane config is
   a new revision. `computeCalibrationEntityKey` is deliberately revision-free so later ticks still
   see older obligations.
2. **Staged resume/apply boundaries.** `runCalibrationStagedOperation` (same kill switch + bare
   second-lane pre-flight as the retained path, default OFF ⇒ zero port calls) executes a frozen
   workset over a durable record stream in three phases: finish pending applications from immutable
   receipts (provider never invoked), plan the frozen items, then report every unresolved obligation
   across ALL revisions. Per fresh item: append `intent` BEFORE the physical send, then the exact
   immutable receipt (`completed`), then `applied`. Receipts must echo their effect identity;
   replay compares that echo before reuse — a mismatched receipt is held, never reused, never
   resent, and blocks its entity until adjudicated.
3. **Unknown-paid semantics.** After a persisted intent, any failed or unknowable send appends
   `sent_unknown` — a durable unresolved obligation that is never auto-resent: not on replay of the
   same tick, not under a later workset that re-selects the same entity (entity-key blocking), not
   under workflow recovery. Completed history does NOT block a new revision; only open obligations
   do. Records are append-only; every record carries the freezing workset's anchor — Part 2 never
   reads a wall clock (no clock freshening) and holds no cached step closure state.
4. **Report surface.** `CalibrationStagedExecutionReport` exposes per-item dispositions
   (`applied_fresh` / `applied_from_receipt` / `applied_replay` / `held_unknown_send` /
   `held_receipt_mismatch` / `held_blocked_by_open_obligation` / `held_duplicate_in_workset`),
   counts, and `openObligations` (persist and appear on every tick, with their original workset
   revision) — the held/unknown rows a parent dashboard or recovery process must keep seeing.

### Explicit lane-B dependency (unresolved handshake)

`CalibrationStagedExecutionPort` (`loadFamilyRecords` / `appendRecord`) is the PROVISIONAL
consumer-side seam for the shared durable paid-effect store owned by lane B
(`tlp-migration-receipt-reference`, task `migration-shared-durable-effects-implementation-20261011`).
There is NO implementation of the port in this lane, no claim/fence/store code, and no production
caller of the staged executor: the retained pg-boss handler keeps Part 1 behavior verbatim and the
DBOS candidate stays gate-only held. When the parent relays lane B's fixed typed protocol, this
interface is replaced/aliased to it and the staged executor is re-verified against the real store.
This seam is NOT live admission and must not be reported as one; no always-success adapter exists
(`executeItem` has no default — it is a required injected dependency).

### Core release request (parent action; core is readonly for this lane)

`judge-calibration-sample-core.ts` should export, as a behavior-preserving move:

- the selection block (`runJudgeCalibrationSample` window query → effective-verdict walk →
  action-filtered dedup → shuffle → `batchMax` slice) as e.g.
  `selectJudgeCalibrationCandidates(db, cfg, now)` returning the frozen candidate list — freezing
  the workset must reuse the core's exact selection/domain math, not duplicate it here; and
- the per-candidate re-judge loop body as a per-item function over one frozen candidate — the only
  real future `executeItem` (provider call + observation write = the apply step).

Until that release, the staged seam is exercised solely by unit tests with injected executors.

### Fresh offline evidence (Node 24.19.0 via mise, pnpm 11.13.1)

Logs under `/tmp/yuk1355-timed-reference-codex-20261011/` (suffix `-staged`).

| Check | Fresh result | Log |
| --- | --- | --- |
| Scoped unit, the three owned unit files | 35 passed in 3 files (23 operation: 9 retained + 14 new) | `unit-staged.log` |
| `pnpm typecheck` | exit 0 | `typecheck-staged.log` |
| `pnpm lint` | exit 0 | `lint-staged.log` |
| `pnpm build` | exit 0 | `build-staged.log` |
| `pnpm audit:partition` | exit 0 | `partition-staged.log` |
| `pnpm audit:test-policy --base 6f1f3e07e41a4db7b302f5404daf7e3067999423` | exit 0, 40 cases checked across 4 files | `test-policy-staged.log` |
| `pnpm audit:capability-boundaries` | exit 0, server->capability-deep remains 0 | `capability-boundaries-staged.log` |

### Remaining parent gates (delta)

1. Relay lane B's fixed typed protocol; reconcile `CalibrationStagedExecutionPort` against it.
2. Release the core selection/per-item seams per the request above; wire the real
   `selectCalibrationWorkSetFn`-equivalent and `executeItem` behind parent-owned admission.
3. Real DB/process recovery, runtime obligation reconciliation and cutover remain parent-owned;
   the prepared DB integration cases from the previous checkpoint are still unexecuted.
