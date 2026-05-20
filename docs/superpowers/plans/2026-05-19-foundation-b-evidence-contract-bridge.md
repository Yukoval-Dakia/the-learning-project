# Foundation B Evidence Contract Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make subject-scoped attribution cause ids flow end-to-end from `AttributionTask` output through parsing, judge-event writes, review planning, and variant generation.

**Architecture:** Introduce `src/core/schema/cause.ts` as the single source of truth for cause id grammar, cause payload shape, profile-scoped labels/priorities, and runtime validation. There is no runtime universal baseline: each `SubjectProfile.causeCategories` is the complete taxonomy for that subject, and attribution output is validated only against the active profile.

**Tech Stack:** TypeScript, Zod, Drizzle/Postgres event rows, pg-boss handlers, existing SubjectProfile registry, Vitest.

---

## Scope

- In scope: profile-scoped validation, math `unit_error` end-to-end tests, profile-aware review label/priority lookup, registry fallback comments.
- Out of scope: profile-specific variant skip policy, ActivityRef shim, CorrectEvent, Maintenance/Inbox/Product Track, README drift, math dataset import, math manual cause UI.

## Files

- Create `src/core/schema/cause.ts`
- Modify `src/core/schema/business.ts`
- Modify `src/core/schema/event/blocks.ts`
- Modify `src/core/schema/event/known.ts`
- Modify `src/core/schema/event/experimental.ts`
- Modify `src/core/schema/schema.test.ts`
- Modify `src/server/knowledge/attribute.ts`
- Modify `src/server/knowledge/attribute.test.ts`
- Modify `src/server/boss/handlers/attribution_followup.test.ts`
- Modify `src/server/boss/handlers/variant_gen.ts`
- Modify `src/server/boss/handlers/variant_gen.test.ts`
- Modify `src/server/orchestrator/review.ts`
- Modify `src/server/orchestrator/review.test.ts`
- Modify `src/ai/task-prompts.test.ts`
- Modify `src/ai/registry.ts`

---

### Task 1: Cause Schema Single Source

- [ ] Add failing tests in `src/core/schema/schema.test.ts` proving `CauseSchema` accepts syntactically valid cause string ids while profile validation rejects ids outside the active profile.
- [ ] Run `pnpm vitest run src/core/schema/schema.test.ts` and confirm failure.
- [ ] Create `src/core/schema/cause.ts` with:
  - `CauseCategoryId`
  - `CauseSchema`
  - `validateCauseAgainstProfile(cause, profile)`
  - `getCauseLabel(causeId, profile?)`
  - `getCausePriority(causeId, profile?)`
- [ ] Re-export cause symbols from `business.ts` and `event/blocks.ts`; remove duplicate enum definitions.
- [ ] Run schema tests and commit.

### Task 2: Attribution Parse Bridge

- [ ] Add failing tests in `src/server/knowledge/attribute.test.ts`:
  - math profile accepts `unit_error`
  - invalid category degrades to `other`, preserves `analysis_md`, and does not throw
  - ids absent from the active profile do not parse as hidden shared categories
- [ ] Run `pnpm vitest run src/server/knowledge/attribute.test.ts` and confirm failure.
- [ ] Change `parseAttributionOutput(text, profile = defaultSubjectProfile)` to validate only against the active profile.
- [ ] Ensure `runAttributionAndWriteJudgeEvent` passes `params.subjectProfile` into parser.
- [ ] Run tests and commit.

### Task 3: Worker And Math E2E

- [ ] Add/extend tests in `src/server/boss/handlers/attribution_followup.test.ts` proving a math referenced knowledge id lets mocked `unit_error` output write a chained judge event.
- [ ] Run `pnpm vitest run src/server/boss/handlers/attribution_followup.test.ts` and confirm failure if parser bridge is incomplete.
- [ ] Keep existing domain resolution path through `loadTreeSnapshot` and `resolveSubjectProfile`; only adjust code if test exposes a gap.
- [ ] Run tests and commit.

### Task 4: Review And Variant Consumers

- [ ] Add review test proving a judge cause `unit_error` is accepted into planning and does not bucket to null.
- [ ] Add variant test proving a math `unit_error` judge can reach `VariantGenTask` and is not blocked by enum typing.
- [ ] Run:
  - `pnpm vitest run src/server/orchestrator/review.test.ts`
  - `pnpm vitest run src/server/boss/handlers/variant_gen.test.ts`
- [ ] Update review cause priority/label lookup to use active profile category metadata + fallback.
- [ ] Remove hard `CauseCategory` enum typing from variant consumer paths; keep existing legacy skip set unchanged.
- [ ] Run tests and commit.

### Task 5: Prompt And Registry Drift Guard

- [ ] Strengthen `src/ai/task-prompts.test.ts` so math Attribution prompt includes `unit_error`, excludes `time_pressure`, and does not contain `文言/古文`.
- [ ] Add `// fallback only; runtime uses getTaskSystemPrompt(task, profile)` comments above registry `systemPrompt` fields for profile-builder tasks.
- [ ] Run `pnpm vitest run src/ai/task-prompts.test.ts src/ai/registry.test.ts`.
- [ ] Commit.

### Task 6: Verification

- [ ] Run targeted suite:

```bash
pnpm vitest run src/core/schema/schema.test.ts src/ai/task-prompts.test.ts src/server/knowledge/attribute.test.ts src/server/boss/handlers/attribution_followup.test.ts src/server/boss/handlers/variant_gen.test.ts src/server/orchestrator/review.test.ts src/server/session/summary.test.ts src/server/knowledge/propose_edge.test.ts
```

- [ ] Run repo checks:

```bash
pnpm typecheck
pnpm lint
pnpm audit:schema
```

- [ ] Stop at green local branch with a concise summary. PR comes after review of the diff.

---

## Stop Point

Stop when the branch has green targeted tests, typecheck, lint, and schema audit. Do not continue into ActivityRef, CorrectEvent, NoteVerify, or proposal inbox in this PR.
