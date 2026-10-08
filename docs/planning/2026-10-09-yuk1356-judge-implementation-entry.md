# YUK-1356 judge family implementation entry

Preparation at source `b9b019a3a0bfd655a618a0dc302796fadcaf1b6e`. PR1624 remains subject to its exact-head CI and merge gate. This document reserves neither a writer nor a migration number. Implementation starts from fresh main after1394 delivery, in this thread's bound worktree.

Use existing YUK1356, UUID `25b13c76-a8c2-4c21-9c43-429d81feff24`. Its scope already includes the judge business family. YUK1355 supplies the shared durable infrastructure; do not create a duplicate judge epic. Tracker comments `83aa9179-e668-483b-913b-f541eaa0b8d4` and `42f51b33-e37c-42a6-acf5-02b3d570feac` retain assignment and source refresh evidence.

## Verified entry points

The source design is `/tmp/yuk1355-judge-durable-design-20261009.md`, with its sealed input manifest. Refresh receipt `/tmp/yuk1356-judge-design-refresh-20261009.json` checked76 inputs:74 unchanged; the two changed housekeeping family files gained1394's shared installer lock. The Start ownership decision is available as Git object `1712199f5:docs/planning/2026-10-09-judge-start-ownership.md`.

The parent traced these paths again before assigning implementation:

| Concern | Existing path | Required implementation boundary |
| --- | --- | --- |
| Durable execution choice | `practice/server/assessment/attempt.ts` exposes `modelAdmission?: 'durable'`; `judge/evaluate-submission.ts` receives durable admission in `createFormalModelExecutor` | Carry a server-owned execution policy from the durable branch. Preserve synchronous and unrelated callers. |
| Per-call Pi options | `src/server/ai/sdk-types.ts` owns `Options`; `runner.ts` builds it in `buildQueryOptions`, then passes it through `ExecutionAdapterStartupArgs.options` | Extend the actual existing option type and propagation. There is no `src/server/ai/execution.ts` in this snapshot. Avoid a parallel options object or a global configuration change. |
| Actual lower retry setting | `pi-agent-adapter.ts` builds loop `maxRetries` from `piMaxRetries()` | Durable judge policy must override this for that call. Test the installed transport with controlled request counts; a runner spy or task-level retry flag is insufficient. Jev uses its existing typed `retry: 'none'` option for the same durable path. |
| Paid model identity | `recorded-model-executor.ts` hashes group, submission, attempt and unit into claim/result IDs | Preserve claims and saved outcomes. An unknown or invalid prior result must not permit another call. |
| Attempt allocation | `evaluate-submission.ts` currently allocates `max(evaluation.attempt) + 1` before returning the model-execution closure | Pin the durable operation's allocation before its first model claim. A crash followed by another candidate must not change the paid identity. The interleaving still needs a real regression, not a source-only defect claim. |
| Producer installation | `src/server/durable/producer-fence-lock.ts` owns the common short transaction lock | Any new installer touching `pgboss.job` or `pgboss.schedule` acquires it before family or target relation locks. Extend the actual cross-family DB regression to include judge. Preserve old-binary quiescence. |

Paths prefixed with `practice/` refer to `src/capabilities/practice/`.

## One implementation assignment

Move `judge_run` and `judge_pending_reconcile` together. Reuse native submission, model claim/result, candidate, activation and settlement truth. Own dispatch, permanent delivery/disposition evidence, bounded reconciliation and the status reads used by placement and intervention diagnostics. Do not introduce a second scorer, Pi runtime, recovery loop or result table.

Preserve `NativeAttemptDispatchPort`: null selects synchronous handling; a run ID means accepted durable intent even if enqueue needs recovery. Draining must reject or fence new admission explicitly, never silently select synchronous paid execution. Keep202 URLs and headers, run/status/result DTOs and original/effective result identity.

Expose `readJudgeRunStatus(database, runId)` through `practice/public.ts`, consumed by the existing HTTP adapter and later Start. It has no Request, global DB or write effects. Failed lookup is unknown, not authoritative absence or permission to dispatch. Domain resolution and permanent dispositions survive `job_events` retention.

The same writer may change the previously coordinated registrar, durable host, practice manifest/public, event schemas, DB schema/export and scoped tests. Start, routes, UI, canonical boot/shutdown and generic SSE remain with5796. Changes to kernel manifest declarations or other bootstrap files require an exact ownership extension before implementation. Re-inventory migrations after fresh fetch; do not assume the next number.

## Completion evidence remains mandatory

The architecture report's full acceptance matrix remains the task requirement. In particular, cover stable pending/enqueue identity, lost acknowledgments, two recovery admissions/seven-day boundaries, scan progress beyond200 retained rows, permanent manual status, stale activation guards and dependent placement/diagnostic behavior.

Parent runtime acceptance must kill actual production worker processes around paid claims, saved outcomes, candidate sealing and domain commit. Controlled transport counts must show no automatic repurchase after unknown outcomes, including the multi-unit case. Preserve first failures and distinguish fake-provider crash evidence from bounded real-provider output.

Prove coherent restore across domain, family controls, DBOS and legacy queue evidence; classify every legacy obligation and show old producers/consumers have exited. A default pg-boss compatibility phase or DBOS manifest declaration is an intermediate state. Neither closes1356 or the whole migration. Full migration exit and Start acceptance stay open until their actual consumers and runtime evidence are complete.
