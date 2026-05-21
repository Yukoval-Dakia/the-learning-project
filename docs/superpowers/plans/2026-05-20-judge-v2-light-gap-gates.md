# Judge v2 Light + Gap Prevention Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the embedded-check judging gap and add audit gates that prevent declared-but-unimplemented judge routes from silently shipping.

**Architecture:** Keep the existing `question.rubric_json`, `question.judge_kind_override`, `JudgeResultV2`, and event stream. Add one async `judgeAnswer` service that compiles a question-level judge contract, chooses the judge route, runs local exact/keyword or `SemanticJudgeTask`, and preserves `partial` / `unsupported` semantics through the attempt event.

**Tech Stack:** Next.js App Router, Drizzle/Postgres, pg-boss, Vitest, Biome, existing `runTask` AI runner.

---

### Task 1: Judge Contract + Async Judge Service

**Files:**
- Modify: `src/core/schema/business.ts`
- Create: `src/server/ai/judges/question-contract.ts`
- Test: `tests/core/capability/judges.test.ts`

- [ ] Extend `Rubric` with optional `keywords`, `acceptable_answers`, and `required_points`.
- [ ] Add `judgeAnswer({ question, answer_md, subjectProfile, db })`.
- [ ] Route choice/true_false to exact, fill_blank to keyword when keywords exist, prose kinds to semantic, and unimplemented routes to `unsupported`.
- [ ] Parse `SemanticJudgeTask` JSON and convert provider/malformed failures to `JudgeResultV2.coarse_outcome='unsupported'`.

### Task 2: Embedded Check Generation Contract

**Files:**
- Modify: `src/ai/task-prompts.ts`
- Modify: `src/ai/registry.ts`
- Modify: `src/server/boss/handlers/embedded_check_generate.ts`
- Test: `src/server/boss/handlers/embedded_check_generate.test.ts`

- [ ] Add `SemanticJudgeTask` registry entry and subject-aware prompt.
- [ ] Require embedded-check AI output to include `judge_kind_override` and `rubric_json` for non-exact questions.
- [ ] Persist `judge_kind_override` and `rubric_json` when inserting `question(source='embedded')`.
- [ ] Reject prose questions that would otherwise fall back to exact.
- [ ] Reclaim `embedded_check_status='pending'` only when `artifact.updated_at` is older than 30 minutes.

### Task 3: Attempt Semantics

**Files:**
- Modify: `app/api/embedded-check/attempt/route.ts`
- Modify: `src/ui/components/EmbeddedCheckSection.tsx`
- Test: `app/api/embedded-check/attempt/route.test.ts`

- [ ] Replace direct `judgeRouterV2` calls with `judgeAnswer`.
- [ ] Map `correct -> success`, `partial -> partial`, `incorrect -> failure`, `unsupported -> partial`.
- [ ] Create `learning_record(kind='mistake')` and enqueue `attribution_followup` only for `failure`.
- [ ] Return enhanced judge evidence while keeping existing response fields.

### Task 4: Gap Prevention Audits + Docs

**Files:**
- Create: `tests/integration/judge-gap-audit.test.ts`
- Modify: `docs/superpowers/status.md`
- Modify: `docs/modules/quiz.md`
- Modify: `docs/modules/notes.md`
- Modify: `docs/planning/v0.3-generalized-ai-learning-framework.md`

- [ ] Audit that every `judgeCapabilities[]` entry resolves in the registry.
- [ ] Audit that future `preferredRoutes[]` entries are explicitly allowlisted with status text.
- [ ] Audit that runtime code does not hand-pick `preferredRoutes` outside `question-contract.ts`.
- [ ] Document Judge v2 light as shipped and mark full rubric/steps/multimodal judging as future.

### Task 5: Verification

- [ ] Run `pnpm vitest run src/core/schema/schema.test.ts tests/core/capability/judges.test.ts app/api/embedded-check/attempt/route.test.ts src/server/boss/handlers/embedded_check_generate.test.ts tests/integration/judge-gap-audit.test.ts`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm audit:schema`.
- [ ] Run `DATABASE_URL=postgres://loom:loom@127.0.0.1:5433/loom INTERNAL_TOKEN=dev pnpm build`.
