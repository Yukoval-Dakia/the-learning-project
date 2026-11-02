# YUK-17 — Variant Double-Pass + variants_max=3 + draft→active Lifecycle

> Track 1 Wave 1 Lane 3 implementation plan. Worktree: `yuk-17-variant-double-pass`.

**Goal:** Add a second-pass `VariantVerifyTask` after `variant_gen`, enforce a per-parent `variants_max=3` cap that counts BOTH pending proposals AND accepted variants (any in-flight artifact), and land the explicit `draft → active → broken | dismissed` lifecycle on a new `mistake_variant` table.

**Architectural decisions (user-locked, do not revisit):**

1. **Schema A** — new `mistake_variant` table (own lifecycle, separate from `question`).
2. **variants_max semantics 2b** — count BOTH pending `variant_question` proposals AND active `mistake_variant` rows (all in-flight).
3. **Lifecycle 3a** — `variant_question` proposal accept materializes a `mistake_variant` row at status `active`; `broken` is only set by `VariantVerifyTask` Pass 2 verdict='fail'.

**Tech stack:** TypeScript, Drizzle/Postgres, pg-boss handler, Zod schema, Vitest DB tests.

---

## File map

| File | Action | Purpose |
|---|---|---|
| `docs/adr/0018-mistake-variant-lifecycle-and-variants-max.md` | create | Capture 3 architectural decisions + alternatives + tradeoffs |
| `src/db/schema.ts` | edit | Add `mistake_variant` pgTable + indexes |
| `drizzle/0013_mistake_variant.sql` | create | Generated migration for the new table |
| `drizzle/meta/0013_snapshot.json` | create | Drizzle meta snapshot (auto) |
| `drizzle/meta/_journal.json` | edit | Append migration entry (auto) |
| `src/ai/registry.ts` | edit | Register `VariantVerifyTask` TaskDef |
| `src/ai/task-prompts.ts` | edit | Add `buildVariantVerifyPrompt` + switch case |
| `src/core/schema/business.ts` | edit | Add `VariantVerificationResult` Zod schema (verdict / failure_reasons / cause_targeting / confidence) |
| `src/server/boss/handlers/variant_verify.ts` | create | pg-boss handler: read mistake_variant row + parent + variant question → call VariantVerifyTask → update row status='broken' on fail (with failure_reasons) or no-op on pass; write verify event |
| `src/server/boss/handlers/variant_verify.test.ts` | create | DB tests covering pass / fail / idempotency / cause-policy integration |
| `src/server/boss/handlers/variant_gen.ts` | edit | Add in-flight count gate (variants_max=3); write `mistake_variant` row (status='draft') alongside the proposal |
| `src/server/boss/handlers/variant_gen.test.ts` | edit | Add variants_max=3 and draft row tests |
| `src/server/boss/handlers.ts` | edit | Register `variant_verify` queue + worker |
| `src/server/proposals/actions.ts` | edit | variant_question accept: materialize question row (source='mistake_variant', draft_status='active') + flip mistake_variant row to status='active' + enqueue variant_verify; dismiss + retract: flip row to 'dismissed' |
| `src/server/proposals/actions.test.ts` | edit | Add variant_question accept / dismiss coverage |
| `scripts/audit-schema-allowlist.json` | edit | Resolve `question.draft_status` (now written) — drop entry; add nothing new (mistake_variant has full write path) |
| `app/api/proposals/[id]/accept/route.ts` | possibly edit | Verify variant_question accept enqueues without code change (already routes through `acceptAiProposal`) |

---

## Step-by-step plan

### Step 1 — ADR

Write `docs/adr/0018-mistake-variant-lifecycle-and-variants-max.md`. Three sections (one per decision), each with: chosen option, alternatives considered, why this choice, tradeoffs accepted, triggers to revisit. Mirror ADR-0013 format.

### Step 2 — Zod schema (no DB yet, no tests yet)

In `src/core/schema/business.ts`, add `VariantVerificationResult` next to `NoteVerificationResult`:

```ts
export const VariantVerificationResult = z.object({
  verdict: z.enum(['pass', 'fail']),
  failure_reasons: z.array(z.string()).max(10).default([]),
  cause_targeting: z.enum(['on_target', 'off_target', 'unclear']),
  summary_md: z.string().min(1).max(1000),
  confidence: z.number().min(0).max(1),
});
export type VariantVerificationResultT = z.infer<typeof VariantVerificationResult>;
```

### Step 3 — DB schema + migration

In `src/db/schema.ts`, append the `mistake_variant` table per task brief. Then `pnpm db:generate` to generate the migration + snapshot. Verify the generated `drizzle/0013_*.sql` matches expected DDL (text, jsonb, two indexes, no FK since `question.id` is text PK and we keep symmetry with knowledge_edge style).

### Step 4 — Update existing audit allowlist

`question.draft_status` was reserved in the allowlist for the deferred materialization. With this lane it gets written (status='active' on accept), so drop the entry from `scripts/audit-schema-allowlist.json`. `pnpm audit:schema` should be green.

### Step 5 — VariantVerifyTask registry + prompt

`src/ai/registry.ts`: add `VariantVerifyTask` TaskDef mirroring `NoteVerifyTask` shape. `src/ai/task-prompts.ts`: add `buildVariantVerifyPrompt(profile)` + switch case. The prompt receives `{ parent_question, variant_question, original_cause, original_attempt }` and outputs `VariantVerificationResult`. Keep deprecated stub `systemPrompt` field as fallback.

### Step 6 — variant_verify handler (TDD: red → green)

Tests first in `src/server/boss/handlers/variant_verify.test.ts`:

1. happy path — verdict='pass' → row status stays 'active', verify event written, no proposal
2. fail path — verdict='fail' → row status='broken', failure_reasons populated, verify event written
3. idempotency — second invocation finds existing verify event and short-circuits (skip LLM)
4. skipped:not_found — missing mistake_variant id
5. skipped:not_active — row in 'draft' / 'broken' / 'dismissed' state should skip
6. cause-policy integration — verify task pulls effective cause via `effectiveCauseForFailureAttempt()` (CC-1) when building input

Then implement `src/server/boss/handlers/variant_verify.ts`. Pattern: `runVariantVerify({ db, mistake_variant_id, runTaskFn })` + `buildVariantVerifyHandler(db, deps)`.

### Step 7 — variants_max=3 gate (TDD)

Test first in `variant_gen.test.ts`:

- seed parent + 3 in-flight variants (mix of draft proposals + active rows) → re-run variant_gen → status='skipped:variants_max_reached'
- seed parent + 2 in-flight variants → re-run variant_gen → status='proposed' (and produces 3rd)

Then implement in `runVariantGen()`: after the existing `existingVariants` check, query `mistake_variant` rows with `status IN ('draft', 'active')` for `parent_question_id = parent.id` and skip if count >= 3.

Also update the existing `skipped:already_has_variant` semantics — the old `parent_variant_id` check was a "1-per-parent" cap (MVP); the new variants_max=3 supersedes it. Decision: remove the 1-per-parent question.parent_variant_id check (and its pendingProposals dup-check) since `mistake_variant` is now the canonical in-flight ledger. Keep the cooldown_key behavior at the proposal layer to deduplicate the same attempt re-running variant_gen (a sane safety net).

After clarification: actually retain the per-(parent, attempt) cooldown via cooldown_key — drop only the 1-per-parent question.parent_variant_id ceiling. (Idempotency for the SAME attempt is still important; the new variants_max=3 governs across DIFFERENT attempts on the same parent.)

### Step 8 — Write draft row in variant_gen (TDD)

Test first:

- variant_gen happy path → both a `variant_question` proposal event AND a `mistake_variant` row (status='draft', `variant_question_id=null`, `proposal_event_id=<proposal id>`) exist

Then implement: after `writeVariantQuestionProposal()` returns the proposal id, INSERT a `mistake_variant` row in the same handler call. Use `createId()` for id; `parent_question_id = parent.id`; `status='draft'`.

### Step 9 — variant_question proposal lifecycle (TDD)

Tests in `src/server/proposals/actions.test.ts`:

- variant_question accept → materializes `question` row (source='mistake_variant', draft_status='active', variant_depth/parent_variant_id/root_question_id propagated from proposed_change), flips mistake_variant row to status='active' with variant_question_id, writes rate event (rating='accept'), enqueues variant_verify job (use injectable enqueue fn)
- variant_question dismiss → flips mistake_variant row to status='dismissed', writes rate event (rating='dismiss')
- variant_question retract (after accept) → existing retract path writes correction event; flip mistake_variant row to status='dismissed' (or leave for future broken-by-correction work — current scope: dismiss)

Then implement: add new `case 'variant_question':` branch in `acceptAiProposal()`. Use an injectable `enqueueVariantVerify` dep (mirrors attribution_followup pattern). In `dismissAiProposal()`, add a branch that updates the mistake_variant row (look up by `proposal_event_id`).

### Step 10 — Register variant_verify in pg-boss

`src/server/boss/handlers.ts`: add `boss.createQueue('variant_verify') + boss.work(...)` block after `variant_gen`. No schedule (enqueued by proposal accept).

Default `defaultEnqueueVariantVerify()` lives in actions.ts (or a new tiny `src/server/boss/enqueue-variant-verify.ts` to avoid pulling boss imports into proposals). Mirror `defaultEnqueueVariantGen` pattern in `attribution_followup.ts`.

### Step 11 — Pre-merge gate

Run sequentially:

```bash
pnpm typecheck
pnpm lint
pnpm audit:schema
pnpm audit:partition
pnpm audit:profile
pnpm test:db -- variant_verify variant_gen actions
pnpm test:migration
```

Then full `pnpm test` if time permits (3-4 hr budget so likely yes).

### Step 12 — Commit

Single commit on `yuk-17-variant-double-pass` branch.

```
feat(variant): YUK-17 double-pass + variants_max=3 + draft/active lifecycle

- New mistake_variant table + 0013 migration (schema A)
- variant_gen writes mistake_variant row (status='draft') alongside proposal
- variants_max=3 gate counts in-flight proposals + active variants
- VariantVerifyTask second-pass handler — fail flips status='broken'
- Proposal accept materializes question + flips row to 'active' + enqueues verify
- ADR-0018 documents the 3 locked decisions

Closes YUK-17
```

---

## CC invariants

- **CC-1 cause-policy** — variant_verify input builder MUST use `effectiveCauseForFailureAttempt()` to pull the original attempt's cause (so the verify pass checks the variant against the **effective** user-or-agent cause).
- **CC-3 JudgeInvoker** — not applicable here; variant_verify is a content-level alignment check, not answer-grading. No JudgeInvoker integration needed.
- **CC-4 Proposal lifecycle** — variant_question accept reuses `acceptAiProposal` owner-service + writes `rate` event; dismiss writes `rate` event with rating='dismiss'; retract writes `correct` event with correction_kind='retract'. No new route.

## Risks / escalate conditions

- If `question.parent_variant_id` existing 1-per-parent semantics turns out to be relied on elsewhere → escalate (else: drop the cap, keep cooldown_key for per-attempt idempotency).
- If `mistake_variant.variant_question_id` needs a FK to `question.id` for relational integrity → keep nullable text + index; FK only if existing pattern requires (knowledge_edge has FK; per-table convention varies; the brief said no FK).
