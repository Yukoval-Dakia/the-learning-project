# YUK-1365 local implementation evidence

Workspace: `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1365-copilot-stream`.
Branch: `fix/yuk-1365-copilot-stream-without-content-gate`.
Fetched base and HEAD: `a86d4e633a67f802554ae114387ab06b7110c135`;
`git rev-list --count HEAD..origin/main` was `0` at session start. Changes below
were initially uncommitted. No other checkout was reset or edited.

## Checks

`pnpm install --frozen-lockfile` passed with pnpm 11.13.1 and no lockfile change.
DB checks used the repository global setup: an isolated `pgvector/pgvector:pg16`
Testcontainer, migrations and per-fork test databases. No application runtime or
production database was used. The new streaming DB test scripts provider events
only; the installed Pi agentLoop, runner, actual read-tool bridge, finalizer and
durable job path execute normally.

All commands below exited `0`. Repeated suites overlap; their counts must not be
added. The two non-overlapping DB groups cover 157 tests in 10 files.

| Command group | Result | Local log |
| --- | --- | --- |
| Copilot/stream unit | 14 files, 182 passed | `/tmp/yuk1365-unit-final.log` |
| Copilot/domain DB | 8 files, 124 passed | `/tmp/yuk1365-db-final.log` |
| Finalizer/shared runner unit, including two additional remote-trace cases | 4 files, 117 passed | `/tmp/yuk1365-runner-unit-final.log` |
| Shared runner/SSE DB | 2 files, 33 passed | `/tmp/yuk1365-runner-sse-db-final.log` |
| After the final cancellation/usage fix: adapter/shared runner unit | 4 files, 130 passed | `/tmp/yuk1365-cancel-usage-unit-final.log` |
| After the final cancellation/usage fix: real Pi-loop stream/shared runner DB | 2 files, 23 passed | `/tmp/yuk1365-cancel-usage-db-final.log` |
| `pnpm typecheck` | Passed | `/tmp/yuk1365-typecheck-final.log` |
| `pnpm lint` | Passed, 297 warnings, 0 errors | `/tmp/yuk1365-lint-final.log` |
| `pnpm build` | Vite web and server/worker/migrate bundles passed | `/tmp/yuk1365-build-final.log` |
| `git diff --check` | Passed | No output |

Exact scoped commands:

```sh
pnpm vitest run --config vitest.unit.config.ts \
  src/capabilities/copilot/server/copilot-execution.unit.test.ts \
  src/capabilities/copilot/server/reply-finalization.unit.test.ts \
  src/capabilities/copilot/server/tool-result-snapshot.unit.test.ts \
  src/capabilities/copilot/server/mode-completion.unit.test.ts \
  src/capabilities/copilot/server/prose-stream.unit.test.ts \
  src/capabilities/copilot/server/copilot-run-input.unit.test.ts \
  src/capabilities/copilot/server/live-turn-context.unit.test.ts \
  src/capabilities/copilot/server/copilot-run-cancellation.unit.test.ts \
  src/capabilities/copilot/server/tool-activity.unit.test.ts \
  src/capabilities/copilot/ui/subtask-events.unit.test.ts \
  src/capabilities/copilot/ui/message-projection.unit.test.ts \
  src/server/ai/pi-agent-adapter.test.ts \
  src/server/ai/runner.stream-collect.test.ts \
  src/server/ai/stream-cancel.test.ts

pnpm vitest run --config vitest.db.config.ts \
  src/capabilities/copilot/jobs/copilot_run.streaming.db.test.ts \
  src/capabilities/copilot/jobs/copilot_run.test.ts \
  src/capabilities/copilot/server/tool-result-snapshot.db.test.ts \
  src/capabilities/copilot/server/copilot-tools.db.test.ts \
  src/capabilities/copilot/server/copilot-run-input.db.test.ts \
  src/capabilities/copilot/jobs/copilot_run_reconcile.db.test.ts \
  src/capabilities/copilot/server/subagent-mailbox.db.test.ts \
  src/capabilities/practice/server/learning-content-validation.db.test.ts

pnpm vitest run --config vitest.unit.config.ts \
  src/capabilities/copilot/server/reply-finalization.unit.test.ts \
  src/server/ai/runner.seam.test.ts \
  src/server/ai/runner.provider-admission.test.ts \
  src/server/ai/runner.stream-collect.test.ts

pnpm vitest run --config vitest.db.config.ts \
  src/server/ai/runner.test.ts \
  src/capabilities/observability/api/job-events.test.ts

pnpm vitest run --config vitest.unit.config.ts \
  src/server/ai/pi-agent-adapter.test.ts \
  src/server/ai/runner.stream-collect.test.ts \
  src/server/ai/stream-cancel.test.ts \
  src/server/ai/runner.seam.test.ts

pnpm vitest run --config vitest.db.config.ts \
  src/capabilities/copilot/jobs/copilot_run.streaming.db.test.ts \
  src/server/ai/runner.test.ts

pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

## Changed files

All paths are relative to this workspace. No UI implementation file changed.

Shared AI delivery:

- `src/server/ai/execution-adapter.ts`
- `src/server/ai/sdk-types.ts`
- `src/server/ai/pi-agent-adapter.ts`
- `src/server/ai/runner.ts`
- `src/server/ai/runner.stream-collect.test.ts`

Copilot execution, persistence and protocol:

- `src/capabilities/copilot/jobs/copilot_run.ts`
- `src/capabilities/copilot/server/copilot-execution.ts`
- `src/capabilities/copilot/server/reply-finalization.ts`
- `src/capabilities/copilot/server/prose-stream.ts` (new)
- `src/capabilities/copilot/server/content-validation.ts` (deleted)
- `src/capabilities/copilot/server/conversation-writes.ts`
- `src/capabilities/copilot/server/copilot-run-outcome.ts`
- `src/capabilities/copilot/server/copilot-run-status.ts`
- `src/capabilities/copilot/server/copilot-run-input.ts`
- `src/capabilities/copilot/server/live-turn-context.ts`
- `src/capabilities/copilot/server/mode-completion.ts`
- `src/capabilities/copilot/server/practice-port.ts`
- `src/capabilities/copilot/server/tool-activity.ts`
- `src/capabilities/copilot/server/tool-result-snapshot.ts`
- `src/capabilities/copilot/tasks/agent.ts` (stream comment only)
- `src/subjects/_shared/skills/copilot/SKILL.md` (mandatory chat marker/reviewer section deleted)

Tests and acceptance harness:

- `src/capabilities/copilot/jobs/copilot_run.streaming.db.test.ts` (new)
- `src/capabilities/copilot/jobs/copilot_run.test.ts`
- `src/capabilities/copilot/jobs/copilot-pi-actual.db.test.ts` (comment only; real-provider opt-in test not run)
- `src/capabilities/copilot/server/copilot-execution.unit.test.ts`
- `src/capabilities/copilot/server/reply-finalization.unit.test.ts`
- `src/capabilities/copilot/server/prose-stream.unit.test.ts` (new)
- `src/capabilities/copilot/server/content-validation.unit.test.ts` (deleted)
- `src/capabilities/copilot/server/copilot-run-input.unit.test.ts`
- `src/capabilities/copilot/server/live-turn-context.unit.test.ts`
- `src/capabilities/copilot/server/mode-completion.unit.test.ts`
- `src/capabilities/copilot/server/subagent-mailbox.db.test.ts`
- `src/capabilities/copilot/server/tool-result-snapshot.db.test.ts`
- `src/capabilities/copilot/server/tool-result-snapshot.unit.test.ts`
- `tests/acceptance/ai-pipeline.ts` (updated to the owner decision; real harness not run)

Decision and handoff:

- `src/capabilities/copilot/AGENTS.md`
- `docs/adr/0061-copilot-presentation-intent-control.md`
- `docs/planning/2026-10-07-yuk1365-copilot-prose-stream.md` (new)
- `docs/planning/evidence/2026-10-07-yuk1365-local-checks.md` (new)
- `PLAN.md`
- `.remember/now.md`

## Interface handoff and limits

The finalizer no longer takes `validateLearningContent` or `userContextText`;
the exported `primaryViewLearningContent`/`primaryViewLearningQuestions` review
helpers were deleted.
Receipt protocol v2 removes `learning_content`. The execution result no longer
returns `candidateDeltaObserved`; the observer delivers `prose_delta` instead.
The unused `validator_context_history` field and reviewed-whole-delta recovery
flag were removed. Persisted legacy flags are ignored; no DB migration is needed.

The input/output contracts of `author_question`, `generate_question_candidate`,
`write_quiz` and `present_primary_view` are unchanged. Actual materializing tool
validation, authorization, correction/proposal truth, trace-bound presentation,
retention policy and causal/history filtering remain. The parallel owner lane
owns structured-question invocation/display/answer behavior changes.

The tests prove local scripted-provider transport and settlement behavior. They
do not establish real-provider output quality/timing, browser acceptance, host
restart durability or deployment. Delta/STEP writes retain the existing
best-effort visibility behavior; terminal outcome recovery remains authoritative
and never repeats paid work to fill a missing increment. Parent owns independent
review, actual acceptance, Linear capture/status, commits, PR/exact-head CI and
deployment. No new actionable follow-up was identified within this scope; no
external tracker search/write was performed by this writer.

## Parent verification

The parent independently reran `pnpm vitest run --config vitest.db.config.ts
src/capabilities/copilot/jobs/copilot_run.streaming.db.test.ts`: both streaming
and cancellation tests passed (10.83 seconds; `/tmp/yuk1365-parent-stream-db.log`).
The parent also ran `audit:schema`, `audit:partition`, `audit:api-client`,
`audit:api-client-usage`, `audit:capability-boundaries`, `audit:provider-lanes`,
`audit:profile`, `audit:task-census`, `audit:draft-status`, and
`audit:draft-status-reads`; every command exited zero. `git diff --check` passed.
These remain local scripted-provider checks, not live-provider acceptance.

After merging `origin/main 42987dfd7` into `196360b27`, frozen install,
typecheck, lint (297 warnings, zero errors), full build and the two streaming DB
tests passed again. The merge resolved only PLAN/handoff prose conflicts;
upstream added the isolated DBOS test dependency and gate. Logs:
`/tmp/yuk1365-main-{install,typecheck,lint,build,stream-db}.log`.

## Independent review repair

Round 1 found a P1 interaction: filtering an unfinished model comment after
appending server text could erase proposal disclosure or correction fields.
Two regressions reproduced the defect before repair (2 failed, 30 passed).
Filtering now applies to model prose after correction-envelope parsing and
before authoritative correction/proposal composition; the receipt hashes the
final bytes. Finalizer/correction/prose suites pass all 47 tests. Scoped
copilot_run and real Pi-loop streaming DB tests, typecheck, lint and build also
pass. Logs: `/tmp/yuk1365-review-{red,green,db,typecheck,lint,build}.log`.
A separate read-only verification review is running as the second/final round.
