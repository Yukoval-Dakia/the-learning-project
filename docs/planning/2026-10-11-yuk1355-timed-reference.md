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
