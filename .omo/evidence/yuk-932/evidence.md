# YUK-932 evidence

## Durable mailbox behavior

- Scenario: a child settles after its parent Copilot task has terminally failed before any parent reply
  was written. Invocation: the DB regression in
  `src/capabilities/copilot/server/subagent-mailbox.db.test.ts` seeds
  `ai_task_runs.status='failure'`, launches and settles a child, then claims its continuation.
  Observable: the continuation reaches `running` rather than remaining `waiting`.
  Current execution status: BLOCKED_ENV because the local Testcontainers runtime is unavailable;
  the attempted scoped invocation and binary error are captured in `scoped-db-blocked.log`.
- Scenario: a duplicate continuation delivery sees an unexpired lease. Invocation: the continuation
  claim regression in `subagent-mailbox.db.test.ts`. Observable: the second claim returns
  `{ waiting: true }`; it does not mark a live provider-fenced continuation as lost.
  Current execution status: BLOCKED_ENV for the same container-runtime reason.
- Scenario: continuation history binds result -> started -> ask/chip parent and excludes later roots.
  Invocation: the causal-history regression in `subagent-mailbox.db.test.ts`. Expected observable:
  only the prior roots and the anchored parent appear in continuation history. Current execution
  status: BLOCKED_ENV because the local Testcontainers runtime is unavailable.

## Contract and static verification

- Scenario: mailbox controls are registered, all four use `mirrorEvent: 'never'`, root prompt names
  the mailbox controls, and inline/durable roots do not mount native SDK Task. Invocation:
  `./node_modules/.bin/vitest run --config vitest.unit.config.ts src/capabilities/copilot/server/subagent-mailbox.unit.test.ts src/capabilities/copilot/server/copilot-tools.unit.test.ts src/ai/task-catalog.unit.test.ts`.
  Observable: 3 files / 60 tests passed. Artifact: `scoped-unit-final.log`.
- Scenario: changed mailbox TypeScript type-checks. Invocation:
  `./node_modules/.bin/tsc --noEmit`. Observable: exit 0. Artifact: `typecheck-final.log`.
- Scenario: all edited TypeScript files satisfy Biome's error gate. Invocation:
  `./node_modules/.bin/biome check <edited-ts-files>`. Observable: no errors; 7 pre-existing
  unsafe-fix warnings remain in lane files. Artifact: `biome-final.log`.
- Scenario: generated migration metadata is valid JSON. Invocation:
  `jq empty drizzle/meta/_journal.json` and `jq empty drizzle/meta/0098_snapshot.json`.
  Observable: both parse. Artifact: `json-validation.log`.

## Scope boundary

No local full `pnpm test` or full gate was run. No install, migration smoke, build, deploy, push,
PR, merge, or Linear write was performed in this completion pass. Earlier full lane artifacts remain
under `raw/`, including the previous 5-file/91-test unit, 3-file/37-test DB, migration, typecheck,
and capability-boundary checks. The historical DB green covers only the then-current mailbox baseline;
it does not cover the newest causal-history, parent-failure, or live-lease DB regressions, all of
which remain BLOCKED_ENV locally.
