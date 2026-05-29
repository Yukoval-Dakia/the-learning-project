# YUK-145 T-OC Slice 3 — TaggingTask + WorkflowJudge + flag-gated auto-enroll — Lane Plan

> Written fresh against `main @ 7d129500` (slice 1 + slice 2 already merged) in
> worktree `/private/tmp/tlp-toc3` on branch `yuk-145-toc-slice3`. Authority: the
> design-approved spec `docs/superpowers/specs/2026-05-29-t-oc-ocr-rebuild-design.md`
> (OC-3 / OC-4 / OC-5) + the slice-1 lane plan
> `2026-05-30-yuk145-toc-slice1-lane.md` §DEFERRED ("Slice 3 — TaggingTask +
> WorkflowJudge + review surface") + slice-2 lane plan §DEFERRED (unchanged).
> This lane implements **OC-4 (confidence gate → auto vs review) + the OC-5
> evidence-first auto-enroll write path**, behind a **conservative OFF-by-default
> feature flag** so production behaviour is byte-equivalent to today.

## 1. Problem (spec §3, §5; OC-4 / OC-5)

Today every captured block (`question_block(status='draft')`) waits for the
human review UI, which POSTs to `app/api/ingestion/[id]/import/route.ts` with a
client-supplied `outcome` + `knowledge_ids`. Nothing is AI-tagged or
AI-auto-enrolled. The spec's OC-4 wants a confidence gate: high-confidence blocks
auto-enroll (AI picks knowledge + outcome), low-confidence/ambiguous blocks fall
through to the existing human review. OC-5 demands the auto path be
evidence-first: every auto-enrolled item logs an `event` with
`generated_by='workflow_judge'` provenance (the seam slice-1 already named in
`enroll.ts`), traceable + reversible, and gated by a conservative threshold.

## 2. Locked decisions consumed

- **OC-3 generalized capture** (slice 1, shipped): `enrollCapturedBlock` routes
  an `outcome` signal into the generalized `LearningRecord`. Slice 3 reuses it as
  the single enrollment owner — auto-enroll calls the SAME function, only the
  `generated_by` provenance differs.
- **OC-4 confidence gate**: TaggingTask (auto knowledge_ids + per-suggestion
  confidence) → WorkflowJudge (route 'auto' | 'review' + prefilled fields).
- **OC-5 evidence-first + conservative rollout**: auto-enroll writes an event via
  the existing owner (`writeEvent` / `createLearningRecord` through
  `enrollCapturedBlock`) with `generated_by='workflow_judge'`; the whole auto path
  is OFF by default behind a flag.
- **YAGNI (spec §7 Q1, §8)**: single-user → WorkflowJudge is a **deterministic
  single-pass confidence aggregator**, NOT a second LLM / multi-agent vote. It
  combines extraction_confidence (from extraction) + tagging confidence (from
  TaggingTask) into one route decision. No LLM call, no new provider cost.

## 3. Key facts that keep this small + audit-clean

- `enrollCapturedBlock` (slice 1) already accepts everything the auto path needs;
  the only addition is an optional `generatedBy` parameter (default
  `'ingestion_capture'` — byte-for-byte current behaviour). The slice-1 seam
  comment in `enroll.ts` §96-98 explicitly names `'workflow_judge'`.
- **NO new `question_block` columns.** The scout sketch proposed
  `ai_suggested_knowledge_ids` / `ai_judge_confidence` / `ai_judge_payload`
  columns, but persisting AI suggestions on the block is only needed by the
  DEFERRED review-surface UI (which shows prefilled suggestions before a human
  acts). The auto-enroll path consumes Tagging/Judge output **in memory** and the
  durable evidence trail is the `event` row written by `enrollCapturedBlock`
  (`generated_by='workflow_judge'` + `enroll_outcome` in payload). So
  `pnpm audit:schema` needs no new allowlist entry. When the review-surface UI
  lands (slice 3b), it can add those columns then, with its own write path.
- TaggingTask is a **single-shot structured-output** task (NOT multimodal): input
  = the extracted question text (derived from `structured` via
  `structuredToPromptMarkdown`) + optional `knowledge_hint` + a knowledge-grid
  snapshot (nodes + mesh edges, built by reusing the same `knowledge` /
  `knowledge_edge` reads the DomainTool grid readers use). Mirrors GoalScopeTask /
  SemanticJudgeTask: register in registry + a builder in task-prompts, parse
  strict JSON via a Zod schema. No agentic tool loop (`needsToolCall:false`,
  `maxIterations:1`, `allowedTools:[]`).

## 4. The FLAG (critical safety — OC-5 conservative rollout)

`src/server/ingestion/workflow-judge-config.ts`:
- `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` (env var) — **defaults OFF**. UNLIKE the
  WAVE6_TRIGGER_* flags (which default ON), this flag must default OFF so that at
  its default NOTHING auto-enrolls. Predicate: enabled ONLY when the env var is
  **explicitly** the string `'true'` (case-insensitive). Undefined / empty /
  `'false'` / anything else → disabled. The inverse of the WAVE6 convention,
  intentionally, with a loud comment.
- `WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD` (env var, default `0.85`) — combined
  confidence ≥ threshold AND flag ON → route 'auto'; else 'review'.
- `autoEnrollEnabled(env)` + `autoEnrollThreshold(env)` exported, env injected for
  tests (same shape as `noteRefineTriggerEnabled`).

When the flag is OFF (default), `runAutoEnrollForSession` short-circuits before
any judge/enroll work and returns `{ status: 'skipped:flag_off', ... }`. The
human review path is the ONLY path that enrolls. Production = today, byte-for-byte.

## 5. Build order (files create-vs-modify)

1. **CREATE** `src/core/capability/judges/tagging.ts` — `TaggingInput` /
   `TaggingOutput` Zod schemas + capability manifest (`id:'tagging'`,
   `kind:'judge'`, `cost_class:'cheap_llm'`, `stability:'experimental'`) +
   unsupported core-registry fallback (server-runtime-required, like steps@1).
   `TaggingOutput` = `{ suggestions: [{ knowledge_id, confidence, reasoning }],
   overall_confidence, reasoning }`.
2. **MODIFY** `src/core/capability/judges/index.ts` — register
   `taggingCapability` so profile validation can resolve it.
3. **MODIFY** `src/ai/registry.ts` — register `TaggingTask`
   (`defaultProvider:'xiaomi'`, `defaultModel:'mimo-v2.5'` text, `isMultimodal:
   false`, `needsToolCall:false`, `maxIterations:1`, `allowedTools:[]`,
   `invocation` omitted → 'auto').
4. **MODIFY** `src/ai/task-prompts.ts` — add `buildTaggingPrompt(profile)` + wire
   `case 'TaggingTask'` in `getTaskSystemPrompt`. Prompt: input = question text +
   knowledge_hint + grid snapshot → strict JSON `TaggingOutput`; every
   `knowledge_id` MUST exist in the grid (no invented nodes).
5. **CREATE** `src/server/ingestion/tagging.ts` — `runTaggingTask(params)`:
   builds the grid snapshot (knowledge nodes + mesh edges, scoped to the block's
   subject if resolvable), renders the question text, calls `runTaskFn`
   ('TaggingTask'), parses strict JSON via `TaggingOutput`, **filters out
   suggestions whose knowledge_id is not in the grid** (anti-hallucination), and
   returns the validated tagging result. Injectable `runTaskFn` for tests.
6. **CREATE** `src/server/ingestion/workflow-judge.ts` — `runWorkflowJudge(input)`:
   a pure deterministic aggregator. Input = `{ extractionConfidence,
   tagging: TaggingOutputT, threshold }`. Combined confidence =
   `min(extractionConfidence, tagging.overall_confidence)` (conservative: the
   weakest link gates). Output = `{ route: 'auto' | 'review', confidence,
   prefilled: { knowledge_ids, outcome, difficulty, question_kind } }`. `outcome`
   defaults to `'unanswered'` (item/material — the safest signal: no fabricated
   attempt; a captured exam question with no graded answer is item-bank by
   default). `route='auto'` ONLY when `confidence >= threshold` AND there is ≥1
   surviving knowledge suggestion.
7. **CREATE** `src/server/ingestion/auto-enroll.ts` — `runAutoEnrollForSession(
   params)`: the gated server path.
   - If `!autoEnrollEnabled(env)` → return `{ status:'skipped:flag_off',
     enrolled: 0, ... }` IMMEDIATELY (no judge, no enroll). This is the
     OFF-default safety: nothing happens.
   - Else: load `question_block WHERE ingestion_session_id=? AND status='draft'`,
     for each run TaggingTask → WorkflowJudge; blocks routed 'auto' →
     INSERT `question` + `enrollCapturedBlock(tx, { ..., generatedBy:
     'workflow_judge' })` + flip `question_block.status='imported'` + link
     `imported_question_id` / `imported_attempt_event_id`, all in ONE tx
     (mirrors the import route's transaction shape). Blocks routed 'review' are
     left untouched (status stays 'draft' for the existing human review flow —
     NO behaviour change). Injectable `runTaggingFn` + `runJudgeFn` for tests.
8. **MODIFY** `src/server/ingestion/enroll.ts` — add optional
   `generatedBy?: 'ingestion_capture' | 'workflow_judge'` to
   `EnrollCapturedBlockInput` (default `'ingestion_capture'`); replace the
   hardcoded `const generatedBy = 'ingestion_capture'` with
   `input.generatedBy ?? 'ingestion_capture'`. Update the seam comment to say the
   flip is now WIRED (slice 3). Existing callers (import route) pass nothing →
   default → unchanged.
9. **CREATE** tests:
   - `src/server/ingestion/tagging.test.ts` — injected runTaskFn returns canned
     JSON; happy path; hallucinated knowledge_id filtered out; malformed JSON →
     throws/typed error.
   - `src/server/ingestion/workflow-judge.test.ts` — routing table: high
     combined-confidence → 'auto'; below threshold → 'review'; zero surviving
     suggestions → 'review' even if confidence high; weakest-link gating.
   - `src/server/ingestion/auto-enroll.test.ts` (DB) — flag OFF → skipped, zero
     enrolled, all blocks stay 'draft' (the critical safety assertion); flag ON
     + high confidence → enrolled with `generated_by='workflow_judge'` event;
     flag ON + low confidence → block stays 'draft'.
   - `src/server/ingestion/enroll.test.ts` (MODIFY) — add a case asserting
     `generatedBy:'workflow_judge'` lands in the event payload; keep all existing
     `'ingestion_capture'` defaults green.
10. **MODIFY** `.env.example` — document both flags (default OFF / 0.85) with a
    loud "auto-enroll is OFF by default" comment.
11. **CREATE** `docs/adr/ADR-0026-...md` — the Tagging/Judge confidence-gate +
    flag-gated-conservative-rollout decision (OC-4 / OC-5).

## 6. Evidence-first provenance (OC-5)

Auto-enrolled items go through `enrollCapturedBlock` exactly like human captures;
the ONLY difference is `generatedBy='workflow_judge'` in the event payload (vs
`'ingestion_capture'`). The event is the durable, reversible audit record — no
side table. The DEFERRED "AI auto-enrolled N items" review surface (slice 3b)
will query `event WHERE payload->>'generated_by' = 'workflow_judge'` to show what
the judge auto-enrolled. The seam is the payload marker; no schema change.

## 7. Conventions / guardrails

- `pnpm audit:schema`: NO new business columns (no allowlist entry). The auto path
  reuses existing `question` / `question_block` / `event` / `learning_record`
  write paths.
- Respect umask: no file-mode hardcoding (no fs writes in this lane anyway).
- Phase-deferred seams (the flag default-OFF, the review-surface DEFERRED, the
  `generated_by` flip) carry explicit comments pointing back at THIS lane plan.
- Evidence-first: auto-enroll logs the event via the owner; never a raw insert.
- No overengineering: WorkflowJudge is deterministic single-pass (spec §7 Q1).

## 8. Definition of done

`pnpm typecheck`, `pnpm lint`, `pnpm audit:schema`, `pnpm audit:partition`,
`pnpm audit:profile`, `pnpm test`, `DATABASE_URL=postgres://x INTERNAL_TOKEN=x
pnpm build` — all green (Docker up). Commit on `yuk-145-toc-slice3` with
`Refs YUK-145` (slice 3 of N, NOT Closes — review surface still DEFERRED).

---

## DEFERRED — NOT built in this lane (need UI + user pre-flight)

### Slice 3b — "AI auto-enrolled N items" review surface (OC-5 UI)
A Living-Note-style panel on the review screen that lists what the WorkflowJudge
auto-enrolled (`event WHERE payload->>'generated_by'='workflow_judge'`) so the
user can one-glance + quickly correct/revert. This is UI; per project UI-preflight
discipline it needs a design-doc pre-flight + user approval before building. When
it lands it MAY add the `ai_suggested_*` columns to `question_block` (with their
own write path + audit entry) if it needs to show prefilled suggestions for
blocks the judge routed 'review'. **Seam:** the `event` provenance marker +
`workflow-judge-config.ts` are where this UI plugs in.

### Review-UI display of TaggingTask suggestions / prefilled fields
Showing the AI's suggested knowledge_ids / outcome / difficulty in the human
review UI (for 'review'-routed blocks, as a prefilled starting point) is also
UI + DEFERRED to 3b. Slice 3 computes them (in `auto-enroll.ts` / `workflow-
judge.ts`) but only consumes them for the 'auto' path; 'review' blocks are left
exactly as today (no prefill surfaced).

### Flipping the flag ON by default
`WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` stays OFF by default. Turning it ON in any
environment requires (per OC-5) the review surface above to exist first, plus an
explicit user decision. This lane ships the capability OFF; enabling it is a
separate, user-gated step.
