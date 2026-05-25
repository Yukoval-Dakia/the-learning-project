# Prompt Profile Coverage Audit (Foundation B M1 Closeout)

Date: 2026-05-25
Scope: YUK-5 / YUK-6 / YUK-77 Lane A
Spec: `docs/superpowers/specs/2026-05-25-foundation-b-m1-closeout.md` rev 4

## 1. TaskKind Coverage

`src/ai/registry.ts` currently registers 18 tasks. Runtime prompt rendering is centralized in `getTaskSystemPrompt(task, profile)` for the 15 SubjectProfile-driven tasks. The three pass-through tasks are subject-neutral, and only `ReviewIntentTask` remains exposed through the generic route.

| # | TaskKind | Prompt source | Category | Callsite default profile | Invocation policy |
|---:|---|---|---|---|---|
| 1 | `AttributionTask` | `buildAttributionPrompt(profile)` | SubjectProfile-driven | `attribution_followup` resolves from the first referenced knowledge effective domain; service fallback is `defaultSubjectProfile` when no profile is supplied. | `auto`; generic route returns `profile_required` |
| 2 | `KnowledgeProposeTask` | `buildKnowledgeProposePrompt(profile)` | SubjectProfile-driven | Import/nightly proposal paths resolve from selected or first referenced knowledge domain; fallback is `defaultSubjectProfile`. | `auto`; generic route returns `profile_required` |
| 3 | `KnowledgeEdgeProposeTask` | `buildKnowledgeEdgeProposePrompt(profile)` | SubjectProfile-driven | Nightly edge proposal resolves a single effective tree domain when possible; fallback is `defaultSubjectProfile`. | `auto`; generic route returns `profile_required` |
| 4 | `SessionSummaryTask` | `buildSessionSummaryPrompt(profile)` | SubjectProfile-driven | Session summary resolves the first reviewed question knowledge domain; fallback is `defaultSubjectProfile`. | `auto`; generic route returns `profile_required` |
| 5 | `KnowledgeReviewTask` | `buildKnowledgeReviewPrompt(profile)` | SubjectProfile-driven + tool-calling | `/api/knowledge/review` resolves the dominant tree domain and passes it to `streamTask`. | `auto`, `needsToolCall=true`; generic route returns `tool_task_requires_domain_route` |
| 6 | `LearningIntentOutlineTask` | `buildLearningIntentOutlinePrompt(profile)` | SubjectProfile-driven | Learning-intent planner resolves the topic knowledge node domain; fallback is `defaultSubjectProfile`. | `auto`; generic route returns `profile_required` |
| 7 | `NoteGenerateTask` | `buildNoteGeneratePrompt(profile)` | SubjectProfile-driven | `note_generate` handler resolves the target knowledge node domain; fallback is `defaultSubjectProfile`. | `auto`; generic route returns `profile_required` |
| 8 | `NoteVerifyTask` | `buildNoteVerifyPrompt(profile)` | SubjectProfile-driven | `note_verify` handler resolves the artifact knowledge node domain; fallback is `defaultSubjectProfile`. | `auto`; generic route returns `profile_required` |
| 9 | `EmbeddedCheckGenerateTask` | `buildEmbeddedCheckGeneratePrompt(profile)` | SubjectProfile-driven | `embedded_check_generate` handler resolves the artifact knowledge node domain; fallback is `defaultSubjectProfile`. | `auto`; generic route returns `profile_required` |
| 10 | `SemanticJudgeTask` | `buildSemanticJudgePrompt(profile)` | SubjectProfile-driven | `JudgeInvoker` receives the question subject profile resolved from question knowledge IDs. | `auto`; generic route returns `profile_required` |
| 11 | `UnitDimensionFallback` | `buildUnitDimensionFallbackPrompt(profile)` | SubjectProfile-driven | `JudgeInvoker` passes the routed question subject profile, usually physics for `unit_dimension`. | `auto`; generic route returns `profile_required` |
| 12 | `StepsJudgeTask` | `buildStepsJudgePrompt(profile)` | SubjectProfile-driven | `JudgeInvoker` / `runStepsJudge` pass the routed question subject profile, usually math for derivation questions. | `auto`; generic route returns `profile_required` |
| 13 | `VariantGenTask` | `buildVariantGenPrompt(profile)` | SubjectProfile-driven | `variant_gen` resolves from the variant source knowledge domain; fallback is `defaultSubjectProfile`. | `auto`; generic route returns `profile_required` |
| 14 | `VariantVerifyTask` | `buildVariantVerifyPrompt(profile)` | SubjectProfile-driven | `variant_verify` resolves from the variant knowledge domain; fallback is `defaultSubjectProfile`. | `auto`; generic route returns `profile_required` |
| 15 | `TeachingTurnTask` | `buildTeachingTurnPrompt(profile)` | SubjectProfile-driven | Teaching orchestrator resolves from the learning item's knowledge node domain; fallback is `defaultSubjectProfile`. | `auto`; generic route returns `profile_required` |
| 16 | `VisionExtractTask` | `tasks[task].systemPrompt` | Subject-neutral pass-through | None; ingestion rescue supplies image/session context rather than a SubjectProfile. | `manual_rescue_only`; generic route returns `requires_domain_route` |
| 17 | `VisionExtractTaskHeavy` | `tasks[task].systemPrompt` | Subject-neutral pass-through | None; ingestion rescue supplies image/session context rather than a SubjectProfile. | `manual_rescue_only`; generic route returns `requires_domain_route` |
| 18 | `ReviewIntentTask` | `tasks[task].systemPrompt` | Subject-neutral pass-through | None; subject voice is already present in the queue summary payload. | `auto`; the only task allowed by generic `/api/ai/[task]` |

## 2. Generic AI Route Hardening

Decision: scheme A from the phase spec.

Implementation record:

- Deleted `src/ai/client.ts`. It was a Vite-era browser helper using `import.meta.env.VITE_INTERNAL_TOKEN` and had no production callers.
- Caller survey before deletion: `grep -rn "/api/ai/\|callAi" --include='*.ts' --include='*.tsx' src/ app/` only found `src/ai/client.ts` plus the route test surface.
- `app/api/ai/[task]/route.ts` now permits only `ReviewIntentTask`.
- `needsToolCall: true` tasks keep the existing `tool_task_requires_domain_route` response. Today that covers `KnowledgeReviewTask`, which must use `/api/knowledge/review`.
- `invocation === 'manual_rescue_only'` tasks return `requires_domain_route` with the ingestion rescue route hint.
- All remaining registered tasks return `profile_required`, because calling them without a resolved `SubjectProfile` would silently fall back to `defaultSubjectProfile`.
- `app/api/ai/[task]/route.test.ts` covers all four response paths: allowed `ReviewIntentTask`, `profile_required`, `requires_domain_route`, and `tool_task_requires_domain_route`.

## 3. Registry Fallback Diff Summary

The deprecated `systemPrompt` fields remain type-required metadata, but the three remaining wenyan-coupled fallback strings were neutralized. The `DEPRECATED (2026-05-22 M1)` comments remain unchanged.

| TaskKind | Before | After |
|---|---|---|
| `NoteGenerateTask` | Long fallback literal included wenyan-specific example policy. | `(see getTaskSystemPrompt(task, profile) - fallback not for runtime)` |
| `VariantGenTask` | Long fallback literal included wenyan-specific variant example policy. | `(see getTaskSystemPrompt(task, profile) - fallback not for runtime)` |
| `TeachingTurnTask` | Long fallback literal identified the assistant as a wenyan coach. | `(see getTaskSystemPrompt(task, profile) - fallback not for runtime)` |

Post-change invariant:

- `grep -rn "文言\|classical chinese\|繁简" src/ai/ src/server/ai/` should return only the 7 intentional `src/ai/task-prompts.test.ts` regressions.
- `grep -rn "文言\|classical chinese\|繁简" src/ai/ src/server/ai/ | grep -v "task-prompts.test.ts"` should be empty.
