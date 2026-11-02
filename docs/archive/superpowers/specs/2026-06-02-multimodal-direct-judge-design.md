# multimodal_direct judge — design note

> **Status**: design, 2026-06-02. **Refs**: v0.4 roadmap §4 第4层 (judges) / P1.1 / P3.6 (Track F multimodal); ADR-0014 (capability registry); evidence from the judge-subsystem understand workflow.
> **Verdict**: build-narrowed-scope. **ONE** capability (`multimodal_direct`); do NOT add `diagram_handwriting`.

## 1. Why one capability, why now

- `multimodal_direct` is ALREADY a member of all three routing enums (`JudgeKind` business.ts:149, `JudgeRouteKindSchema` profile-schema.ts:33, the `index.ts` union) → usable as `judge_kind_override` + declarable in `preferredRoutes` with **zero enum changes**. `diagram_handwriting` is in none → adding it edits 3 enums for no scoring-contract gain (diagram-vs-handwriting is a property of WHICH `image_refs` are passed, not a separate contract).
- **Consumer is live today** via the question-figure path: `question.image_refs` (written by T-OC `tencent_ocr_extract`) already feeds the vision LLM in `steps-judge.ts`. `steps@1` owns step/rubric-weighted vision judging for math derivation. `multimodal_direct` owns the **holistic, no-step-rubric** vision judging that's currently missing (physics calculation with a diagram; short-answer with a figure and no `reference_solution`).
- Answer-photo path (`student_image_refs`) is contract-complete server-side (`submit/route.ts` → `submitSolveAttempt` → invoker → judge) but has **no UI producer** (M2.3 gap → YUK-169 redraw). multimodal_direct will consume it once the UI lands; until then its live producer is question figures.
- cred-free: reuses the existing xiaomi/mimo-v2.5 vision endpoint StepsJudgeTask already uses. No search/audio/SourcePack.

## 2. Scope + routing (zero regression)

`multimodal_direct` fires in exactly two additive cases inside `resolveQuestionJudgeRoute` (question-contract.ts:116-159):

1. **Override (primary, zero new routing)**: `q.judge_kind_override === 'multimodal_direct'` → returned by the existing override branch (the value already parses). Any question opts in explicitly; no automatic change can regress existing items.
2. **Gated auto-route (additive)**: a NEW branch placed **AFTER** the derivation→steps branch (so steps@1 keeps math derivations) and AFTER the physics unit_dimension branch (so physics calc keeps unit_dimension), gated on: kind is non-choice/non-derivation, AND `q.image_refs?.length > 0`, AND `isPreferred(subjectProfile,'multimodal_direct')`, AND no step-rubric (`Rubric.safeParse(rubric_json).data?.reference_solution` is null). wenyan never opts in → unaffected.

Add `'multimodal_direct'` to `RUNNABLE_ROUTES` and REMOVE from `FUTURE_JUDGE_ROUTES` (question-contract.ts). Add an invoker dispatch branch (invoker.ts, mirror the steps branch) that dynamic-imports `runMultimodalDirectJudge`, passing `student_image_refs`.

## 3. Blueprint (mirror steps@1 verbatim; reuse, don't invent)

Files to create:
1. `src/core/capability/judges/multimodal_direct.ts` — mirror `steps.ts`. Zod `MultimodalDirectInput { prompt_md, reference_md (nullable), image_present:boolean }` + `MultimodalDirectLlmOutput { coarse_outcome:'correct'|'partial'|'incorrect', score:0..1, feedback_md:min(1), evidence:{observed_md, matched_points[], missing_points[]}, confidence:0..1 }`. manifest `{ id:'multimodal_direct', kind:'judge', version:'1.0.0', cost_class:'expensive_llm', latency_class:'sync', stability:'experimental' }`. `run()` returns unsupported pointing at the invoker (copy steps.ts fallback — server runtime needs DB/R2). Export `multimodalDirectV1Capability`.
2. `src/server/ai/judges/multimodal-direct-judge.ts` — mirror `steps-judge.ts`. `runMultimodalDirectJudge({db, question, answer_md, student_image_refs, subjectProfile, runTaskFn?, imageFetchFn?})`. **Reuse `defaultImageFetch` by importing from `./steps-judge`** (no R2 dup). `promptImages` from `question.image_refs`, `studentImages` from `student_image_refs`, `images=[...prompt,...student]`. Guard: 0 images AND empty answer → unsupported. Build `llmTextPayload` JSON + call `runTaskFn('MultimodalDirectJudgeTask', {text, images}, {db, subjectProfile})`. Parse → compose JudgeResultV2 (`score_meaning='correctness'`, `capability_ref={id:'multimodal_direct',version:'1.0.0'}`, discriminated-union clamping correct≥0.85/partial 0.01..0.84/incorrect 0). LLM/parse/fetch failure → unsupported (mirror steps-judge catches).

Task wiring (NEW MultimodalDirectJudgeTask — do NOT overload StepsJudgeTask):
3. `src/ai/registry.ts` — add `MultimodalDirectJudgeTask` mirroring StepsJudgeTask: `defaultProvider:'xiaomi'`, `defaultModel:'mimo-v2.5'`, `budget{maxIterations:1,timeout:90_000}`, `needsToolCall:false`, **`isMultimodal:true`**, `allowedTools:[]`. (reuses runner.ts multimodal image path — no runner change.)
4. `src/ai/task-prompts.ts` — add `case 'MultimodalDirectJudgeTask':` to the exhaustive getTaskSystemPrompt switch (strict-JSON MultimodalDirectLlmOutput instructions). Mandatory (switch throws on unhandled).

Registration + router + profile:
5. `src/core/capability/judges/index.ts` — `registry.registerJudge(multimodalDirectV1Capability)` in createDefaultRegistry + re-export.
6. `src/server/ai/judges/question-contract.ts` — RUNNABLE_ROUTES += 'multimodal_direct'; remove from FUTURE_JUDGE_ROUTES; add the gated auto-route branch (§2).
7. `src/server/judge/invoker.ts` — dispatch branch for 'multimodal_direct'.
8. `src/subjects/math/profile.ts` + `src/subjects/physics/profile.ts` — add `'multimodal_direct'` to `judgeCapabilities`. **physics** also gets it in `preferredRoutes` (the real consumer: physics calc with figures; ordering keeps unit_dimension precedence per §2). math: judgeCapabilities only (override-available; steps@1 owns its derivations). wenyan: no change. (`validate-profile.ts` requires a preferredRoute capability to be in judgeCapabilities AND registered — both satisfied.)

JudgeResultV2 output: `score_meaning='correctness'`; coarse_outcome union constraints; confidence 0..1 (0 for unsupported); `evidence_json` = observed_md/matched_points/missing_points/prompt_image_count/student_image_count.

## 4. Tests + gate

- **unit** (inject `imageFetchFn`+`runTaskFn` stubs, no DB/R2/AI): compose-result clamping (correct/partial/incorrect), unsupported on empty-images+empty-answer / parse-fail / fetch-throw, prompt+student image concat order; manifest parses; core `run()` returns unsupported; **router regression**: resolveQuestionJudgeRoute returns 'multimodal_direct' for override + the gated auto branch, AND wenyan/choice/derivation-with-rubric/short-answer/physics-calc(unit_dimension) fixtures route **UNCHANGED**.
- **audit:profile** must pass (math/physics validateProfile with the new capability).
- Gate: typecheck / lint / audit:profile / audit:partition / test / build (build catches the exhaustive-switch case).

## 5. Out of scope

`diagram_handwriting` (not needed — §1); answer-photo capture UI (M2.3 → YUK-169 redraw); audio (cred-blocked, no transcription key); search/SourcePack.
