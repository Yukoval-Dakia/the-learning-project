# YUK-39 L1 JudgeInvoker Execution Plan

> **For Yukoval:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan step-by-step.

**Goal:** Ship a single server-side judge invocation entrypoint for Foundation A closeout. All runtime question judging should go through `src/server/judge/invoker.ts`, with explicit Zod input/output schemas, route/confidence/elapsed telemetry, and no stale `steps@1` placeholder semantics.

**Architecture:** Keep the core capability registry as the catalog and local runner layer. Add `JudgeInvoker` above it as the server runtime boundary: it resolves the question route, checks the registered capability, dispatches server-context judges (`semantic`, `steps`, `unit_dimension`) or local registry judges (`exact`, `keyword`), and emits telemetry for every invocation. Existing `judgeAnswer` remains as a compatibility wrapper, but production app/server entrypoints migrate to `JudgeInvoker`.

**Tech Stack:** TypeScript, Zod, Vitest, Next.js route handlers, Drizzle/Postgres test harness.

### Task 1: Add `JudgeInvoker` server module

- Create `src/server/judge/invoker.ts`.
- Export `JudgeInvokerInputSchema`, `JudgeInvokerOutputSchema`, and inferred TS types.
- Export `JudgeInvocationTelemetrySchema` plus a `JudgeInvocationTelemetry` type.
- Implement `JudgeInvoker` with constructor dependencies:
  - `registry?: CapabilityRegistry` defaulting to `getDefaultRegistry()`
  - `runTaskFn?: JudgeAnswerParams['runTaskFn']`
  - `onTelemetry?: (event: JudgeInvocationTelemetry) => void | Promise<void>`
- Implement `invoke(input)`:
  - Resolve route with `resolveQuestionJudgeRoute`.
  - If route is not runnable or not registered, return unsupported result.
  - Dispatch `semantic`, `steps`, `unit_dimension`, `exact`, and `keyword`.
  - Measure elapsed time with monotonic clock.
  - Include telemetry in the return value and call `onTelemetry`.
- Export `createDefaultJudgeInvoker(deps?)`.

### Task 2: Split question-contract into reusable helpers plus compatibility wrapper

- Update `src/server/ai/judges/question-contract.ts` so reusable helpers needed by `JudgeInvoker` are exported:
  - `unsupportedResult`
  - `buildLocalJudgeQuestion`
  - `semanticInput`
  - `runSemanticJudge`
  - `defaultRunTaskFn`
- Keep `judgeAnswer(params)` as a thin wrapper around `createDefaultJudgeInvoker().invoke(params)` so existing tests and fixture helpers continue to pass during the transition.
- Avoid importing `judgeRouterV2` in `question-contract.ts`; local dispatch should live in the invoker.

### Task 3: Move production attempt endpoint to the new invoker

- Update `app/api/embedded-check/attempt/route.ts` to import `createDefaultJudgeInvoker` from `@/server/judge/invoker`.
- Replace direct `judgeAnswer` call with `createDefaultJudgeInvoker().invoke(...)`.
- Store `judge_elapsed_ms` and `judge.telemetry` in the attempt event payload.
- Preserve response shape and mistake-record behavior.

### Task 4: Clear stale `steps@1` placeholder semantics

- Update `src/core/capability/judges/index.ts` comments so `steps@1` is described as registered and server-executed by `JudgeInvoker`.
- Update `src/core/capability/judges/steps.ts` so the core runner feedback points to `JudgeInvoker`/`runStepsJudge` rather than an unimplemented milestone placeholder.
- Add or adjust tests to assert no stale M2.1/M2.2 placeholder behavior remains in the core steps runner.

### Task 5: Add focused tests

- Add `src/server/judge/invoker.test.ts` covering:
  - exact route dispatch via registry
  - semantic route dispatch with mocked `runTaskFn`
  - semantic provider failure returning unsupported without marking wrong
  - steps route dispatch through server runner with mocked `runTaskFn`
  - unit_dimension route dispatch with `db`/`subjectProfile` context
  - telemetry emitted with route, coarse outcome, confidence, and elapsed ms
- Update `app/api/embedded-check/attempt/route.test.ts` to assert attempt payload contains `judge_elapsed_ms` and telemetry.
- Keep existing `src/server/ai/judges/question-contract.test.ts` green through the compatibility wrapper.

### Task 6: Audit direct judge entrances

- Run:

```bash
rg -n "createDefaultRegistry|judges\\." src/server app
```

- Expected result: direct runtime entrances in `app` and `src/server` either use `src/server/judge/invoker.ts` or are compatibility/test-local exports under `src/server/ai/judges/*`. No app route should import `@/server/ai/judges/question-contract`.

### Task 7: Verify

- Targeted:

```bash
pnpm exec vitest run --config vitest.unit.config.ts src/server/judge/invoker.test.ts src/server/ai/judges/question-contract.test.ts app/api/embedded-check/attempt/route.test.ts tests/core/capability/judges.test.ts
```

- Full gates:

```bash
pnpm typecheck
pnpm test:unit
pnpm test:db
pnpm audit:schema
pnpm audit:partition
pnpm lint
```

### Task 8: Linear and PR closeout

- Comment progress on YUK-39 after the plan, implementation, targeted verification, full verification, PR creation, and merge.
- Commit with a message containing `YUK-39`.
- Open PR against `main` with `YUK-39` in title/body.
- After merge, set YUK-39 to Done and move to the next project issue.
