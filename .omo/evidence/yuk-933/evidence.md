# YUK-933 evidence

Base: `origin/main@1cf06f575763fb72b558b6c8a2f064405a8a06bb`

## Deliberate RED

- Scenario: a replayed root reply must retain one bounded ToolOperation card and one bounded
  SubagentRun card, without private fields.
- Invocation: `./node_modules/.bin/vitest run --config vitest.unit.config.ts src/capabilities/copilot/ui/replay.unit.test.ts`
- Observable: `src/capabilities/copilot/ui/replay.unit.test.ts` failed exactly its new lifecycle
  assertion; 10 tests passed and 1 failed because `replayToMessages` omitted both fields.

## Green behavior

- Scenario: replay keeps operation state session/task-run scoped and subagent state causal to the
  root turn; the UI uses the existing `ToolUseCard` shell and never renders private payloads or a
  second voice.
- Invocation: `./node_modules/.bin/vitest run --config vitest.unit.config.ts src/capabilities/copilot/ui/replay.unit.test.ts src/capabilities/copilot/ui/CopilotDock.subtasks.unit.test.tsx src/capabilities/copilot/ui/CopilotDock.tool-use.unit.test.tsx src/capabilities/copilot/ui/durable-reconnect-storage.unit.test.ts src/capabilities/copilot/ui/CopilotDock.durable-retry.unit.test.tsx src/capabilities/copilot/ui/subtask-events.unit.test.ts`
- Observable: 6 test files and 59 tests passed. The lifecycle rendering test covers running,
  succeeded, failed, cancelled, and lost copy; the replay test deduplicates the replayed root;
  durable reconnect and subtask stream tests cover drawer reopen and Last-Event-ID recovery.

- Scenario: persisted event projection uses session/task-run identity for ToolOperations and the
  `started -> settled` causal chain for SubagentRuns, without exposing objective, process id, or
  child result.
- Invocation: `./node_modules/.bin/vitest run --config vitest.db.config.ts src/capabilities/copilot/server/turns.db.test.ts`
- Observable: BLOCKED_ENV locally before test collection because Testcontainers reported
  `Could not find a working container runtime strategy`. The new DB regression remains in
  `src/capabilities/copilot/server/turns.db.test.ts` for exact-head CI's container environment.

## Static and build checks

- Invocation: `./node_modules/.bin/tsc --noEmit`
- Observable: exit 0.

- Invocation: `./node_modules/.bin/biome check src/capabilities/copilot/server/turns.ts src/capabilities/copilot/server/turns.db.test.ts src/capabilities/copilot/ui/replay.ts src/capabilities/copilot/ui/replay.unit.test.ts src/capabilities/copilot/ui/CopilotDock.tsx src/capabilities/copilot/ui/CopilotDock.subtasks.unit.test.tsx`
- Observable: 6 files checked with no errors.

- Invocation: direct equivalent of `pnpm build` using the existing `vite` and `esbuild` binaries
  for web, server, worker, and migrate bundles.
- Observable: all four bundles built successfully.

- Invocation: `git diff --check`
- Observable: exit 0.

## Environment note

`pnpm` attempted dependency reconciliation for this lane's intentionally symlinked `node_modules`
and stopped in non-interactive mode before any removal. No dependency install, local full test gate,
or deployment was run; every successful local check above used the existing direct binaries.

## Stop-hook re-verification

Executed after the completion-evidence hook requested direct re-verification.

- `./node_modules/.bin/tsc --noEmit` exited 0.
- Scoped Biome over all six changed TypeScript/TSX files reported `Checked 6 files` and no errors.
- The six scoped unit files exited 0 with `Test Files 6 passed (6)` and `Tests 59 passed (59)`.
- The direct Vite/esbuild equivalent of the four build scripts exited 0. Its terminal artifacts were
  `dist/server.cjs` (24.0mb), `dist/worker.cjs` (24.1mb), and `dist/migrate.cjs` (3.0mb); Vite also
  completed successfully. The bundle-size messages were warnings, not failures.
- `git diff --check HEAD^ HEAD` exited 0 and `git status --short --branch` showed only
  `## yuk-933-operation-subagent-cards...origin/yuk-933-operation-subagent-cards`.
- The scoped DB invocation exited 1 before collection: Vitest reported `No test files found` for the
  DB filter and global setup then reported `Could not find a working container runtime strategy`.
  This is a local `BLOCKED_ENV`, not a passing DB result; exact-head CI owns that containerized case.
- `gh pr view 1309` confirmed open PR head `6a236f55413272d665c7fcf1d35df7fdc664d1be` against
  `main`, with CI Gate jobs running at verification time.
