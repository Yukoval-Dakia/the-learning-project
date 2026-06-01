# DESIGN SPEC — 解题陪练 (Solve-Tutor)

**Status:** Proposed (implementation-ready)
**Date:** 2026-06-01
**Scope:** A question-centric solve-tutor: open any `question` → optionally get Socratic hints → submit a solution (typed steps/answer OR handwritten photo) → AI judges it against a reference solution → reveal the worked solution → on a low score, enroll a mistake + schedule FSRS. The hero is the interactive solve loop; an AI **solution generator** is its supporting fuel.
**Anchors:** Math MVP vision design (`docs/superpowers/specs/2026-05-21-math-mvp-vision-design.md`), ADR-0014 (capability registry + JudgeResultV2), ADR-0008 (learning_session polymorphic envelope), ADR-0005 (event spine).

---

## 1. Context & Goal

### 1.1 The feature is ~70% already built

A code sweep (2026-06-01) found the solve-tutor's hard parts already shipped by the Math MVP (M-1/M2) + Phase 2C:

| Capability the user wants | Already exists (anchor) |
|---|---|
| **Handwritten-photo solution judging** | `StepsJudge` is multimodal: `StepsJudgeInput` carries `student_image_refs` (asset-id list = handwriting photo), `student_text_steps`, `student_final_answer_text`, graded against `reference_solution` → `JudgeResultV2` partial credit. `src/core/capability/judges/steps.ts:33-49`, runtime `src/server/ai/judges/steps-judge.ts`. The Math MVP "档 3 (vision-as-input): 手写草稿独立提交、单次 vision-LLM call" is shipped (`2026-05-21-math-mvp-vision-design.md §2.3`). |
| **Reference-solution carrier** | `question.rubric_json` (`$type<RubricT>()`, `src/db/schema.ts:153`) carries `RubricReferenceSolution` = `{expected_signals: string[]≥1, final_answer: string, answer_equivalents: string[]}` (`src/core/schema/business.ts:165-170`, `Rubric.reference_solution` optional `:183`). Worked-solution prose carrier: `question.reference_md` (`schema.ts:152`). |
| **Hint / interactive-teaching engine** | `TeachingTurnTask` + `src/server/orchestrator/teaching.ts` (turn kinds `explain`/`ask_check`/`end`) + `app/api/teaching-sessions/*` (Phase 2C). |
| **Attempt → mistake → FSRS chain** | `event(action='attempt', subject_kind='question')` (`src/core/schema/event/known.ts:28`) → mistakes (`app/api/mistakes/*`) → FSRS (`src/core/capability/schedulers/fsrs.ts`). Partial-credit UI: `src/ui/components/JudgeResultPanel.tsx`. |
| **Photo upload** | `POST /api/assets` (multipart → R2 → `source_asset`, `app/api/assets/route.ts`). |
| **Judge routing by kind** | capability registry `steps@1` / `semantic@1`; invoker `src/server/judge/invoker.ts`; `SemanticJudgeTask` for prose. |

### 1.2 The two genuine gaps (the only net-new work)

1. **No AI generator for a reference solution / rubric on a bare question.** `question.rubric_json` is written only by fixtures (`src/subjects/{math,wenyan}/fixtures/*`), seed routes (`app/api/_/seed/math/route.ts`), and the structure/import path — **never AI-generated from a bare prompt**. So the **real ingested questions** (which arrive with no `rubric_json` — verified by the 2026-06-01 real-ingestion run: 6 extracted blocks, zero rubric) **cannot be StepsJudge'd** — the judge returns `unsupportedResult('reference_solution missing from rubric_json')` (`steps-judge.ts:165-168`). This generator is the fuel that makes the whole shipped judging stack usable on real material.
2. **No unified "solve a question" session.** The judging / teaching / attempt pieces are wired into *other* flows (review/submit, embedded-check/attempt, teaching-sessions) but there is no single orchestration that lets a user open one question and run attempt → hints → submit → judge → reveal → enroll.

### 1.3 Goal

Ship the solve-tutor as **two thin phases that add a generator + an orchestrator and reuse everything else**, question-centric, backend-first (UI is redraw-pending — reuse `JudgeResultPanel` + a minimal entry; defer visual polish to the design redraw). Anti-over-engineering: no new judge, no new vision pipeline, no new mistake/FSRS path — those exist.

---

## 2. Phase 1 — `SolutionGenerateTask` (the fuel)

### 2.1 Contract

A new AI task in the registry (`src/ai/registry.ts` + prompt in `src/ai/task-prompts.ts`), invoked through the existing runner (`src/server/ai/runner.ts`) — do **not** hand-roll `runTask`.

- **Input:** one `question` — `prompt_md`, `kind`, `subject_id`, plus any existing `answers` / `analysis` / `figures` / `image_refs` (an ingested question may already carry Tencent's `tencent_grading.RightAnswer` / `AnswerAnalysis` as evidence — feed it as a hint, not ground truth).
- **Output:** `RubricReferenceSolution` (`expected_signals: string[]≥1`, `final_answer`, `answer_equivalents: string[]`) **+** a human-readable worked solution (markdown).
- **Writes:** `question.rubric_json` (merge the generated `reference_solution` into the existing `RubricT`, preserving any existing `criteria`/`keywords`/`required_points`) **+** `question.reference_md` (worked solution). Both are **existing columns → zero schema change, zero `audit:schema` allowlist entry.**
- **Provenance/evidence:** the run logs to the AI log (`src/server/ai/log.ts`); the write is attributable + reversible (ADR-0005 spirit). Tag the generated rubric with a provenance marker in `rubric_json` (e.g. `reference_solution_source: 'ai_generated'`) so a human can tell AI-generated reference solutions from authored ones.

### 2.2 Trigger (lazy, on-demand)

Generate **lazily** when a solve session starts on a question whose `rubric_json.reference_solution` is missing/empty. **Idempotent:** skip if a reference solution already exists, unless an explicit `regenerate` is requested. (Batch generation for the whole question bank is **out of scope** — lazy-on-demand first; a batch job can come later if the lazy path proves the quality.)

### 2.3 Subject-awareness

Route the generation prompt by `SubjectProfile` / capability (math derivation vs. physics vs. wenyan prose) so `expected_signals` are subject-appropriate (a derivation's signals ≠ a translation's points). Reuse the subject-profile resolution already used by the judges (`src/subjects/profile.ts`, `resolveSubjectProfile`).

### 2.4 Robustness

A missing `XIAOMI_API_KEY` / LLM throw / unparseable output ⇒ **logged skip**, NOT a thrown 500 and NOT a retry storm: the solve session degrades to "no reference solution yet → judge runs in a reduced mode or the session tells the user the model solution is unavailable", and the **existing manual review/answer flow is untouched**. The generator never overwrites a non-empty authored `reference_solution` without `regenerate`.

---

## 3. Phase 2 — Solve-session orchestration (the hero loop)

### 3.1 Persistence: reuse `learning_session(type='tutor')`

`LearningSessionType` already固化s a **`tutor`** value (`src/core/schema/learning_session.ts:13`), with `TutorStatus = z.enum(['placeholder'])` explicitly reserved for "Phase 1d/2 第一次实装时再展开" (`:50-54`). The solve-tutor is that first implementation:

- **Expand `TutorStatus`** from `['placeholder']` to a real machine: `active → submitted → judged → ended` (+ `abandoned`). This is a **Zod-only change** — `learning_session.type`/`status` are text columns validated by the `LearningSessionStatusByType` discriminated union (`:67-74`), not pg enums, so **no migration** (confirm during impl; the "enum 已固化" comment + the discriminated-union pattern indicate text). Add the `tutor` arm's real status to `LearningSessionStatusByType:71`.
- A solve session row links to its `question_id` (via the session envelope's question/activity ref, mirroring how `conversation` sessions link a `learning_item`). Multi-turn hints + the submission attach to this session.

This mirrors `app/api/teaching-sessions/route.ts` (which creates `learning_session(type='conversation')`) — same pattern, different type.

### 3.2 Orchestrator + routes

New `src/server/orchestrator/solve.ts` (mirrors `orchestrator/teaching.ts`) + routes:

- **`POST /api/questions/[id]/solve`** — start a solve session on a question. If `rubric_json.reference_solution` is missing, invoke Phase 1 (lazy gen) first. Creates `learning_session(type='tutor', status='active')`. Returns `{ sessionId }`.
- **`POST /api/questions/.../solve/[sid]/hint`** — request a Socratic hint: call `TeachingTurnTask` (reuse the teaching orchestrator) seeded with the worked solution, returning the *minimal next hint* (escalating across turns). Does not reveal the full solution.
- **`POST /api/questions/.../solve/[sid]/submit`** — submit a solution. Body accepts the multimodal carriers the judge already takes: `student_text_steps?` / `student_final_answer_text?` / `student_image_refs?` (asset ids from a prior `POST /api/assets` upload of the handwritten photo). **≥1 non-empty** (the Math MVP constraint). Routes by `question.kind` to `steps@1` (StepsJudge, derivations) or `semantic@1` (SemanticJudge, prose) via the existing invoker (`src/server/judge/invoker.ts`). On the result: write `event(action='attempt', subject_kind='question')` carrying the `JudgeResultV2`; transition session `submitted → judged`; **reveal** the worked solution (`reference_md`); if the score is below the subject's mastery threshold, **enroll a mistake** (reuse the existing mistake-capture path + cause tagging) and let the existing FSRS projection schedule it.

All AI calls (gen, hint, judge) log to the AI log; the attempt is an event (ADR-0005). Gen/hint/judge are synchronous `runTask` calls (not pg-boss jobs); if any later async job is added, enqueue only via `getStartedBoss()` (never the unstarted `createBoss()` — YUK-192).

### 3.3 Reuse map (no net-new for these)

TeachingTurn (hints) · StepsJudge/SemanticJudge incl. `student_image_refs` handwriting (judging) · `/api/assets` (photo upload) · `event(action='attempt')` + mistake capture + FSRS · `JudgeResultPanel` (UI render of partial credit).

### 3.4 UI (minimal, redraw-pending)

A minimal question-centric "开练" entry (e.g. a button on a question/learning-item view) that opens the solve flow and renders via the existing `JudgeResultPanel`. **No visual polish this phase** (the design redraw, WR umbrella, supersedes it). The backend route + orchestrator are the deliverable; the UI is a thin shell.

---

## 4. Data flow

```
question
  └─[rubric_json.reference_solution missing?]→ SolutionGenerateTask → writes rubric_json + reference_md
        │
        ▼
  POST /api/questions/[id]/solve  → learning_session(type='tutor', status='active')
        │
        ├─ (optional) /solve/[sid]/hint  → TeachingTurnTask (minimal escalating hint from worked solution)
        │
        └─ /solve/[sid]/submit  (typed steps/answer OR handwritten photo via /api/assets→student_image_refs)
              → judge by kind (StepsJudge | SemanticJudge) vs rubric_json.reference_solution → JudgeResultV2
              → event(action='attempt') ; status submitted→judged
              → reveal reference_md
              → if score < mastery threshold: enroll mistake (+causes) → FSRS schedule
              → status ended
```

---

## 5. Schema decision — ZERO new columns

- `rubric_json` + `reference_md` already exist (`schema.ts:153,152`) → Phase 1 writes them, **no migration, no `audit:schema` allowlist entry**.
- Phase 2 reuses `learning_session(type='tutor')` — `type` value already固化d; only the `TutorStatus` Zod enum expands (text column → no migration; confirm column is text not pg-enum during impl).
- Attempts/mistakes/FSRS already have their tables + write paths.
- New AI task = registry + prompt entries (not schema). `pnpm audit:schema` consequence: **zero new entries.**

---

## 6. Failure handling

- **Missing key / LLM error in Phase 1 gen:** logged skip; solve session proceeds without a model solution (judge degrades or session reports "model solution unavailable"); manual flow untouched; no retry storm.
- **Judge `unsupportedResult` (no reference_solution):** the solve session should have ensured a rubric via Phase 1; if gen failed, surface "can't auto-judge yet" rather than a 500.
- **Submit with all carriers empty:** 400 validation (mirror the Math MVP ≥1-non-empty constraint).
- **Photo upload:** reuse `/api/assets` validation (mime/size); a failed upload is a client-visible error, not a session corruption.

---

## 7. Test plan

Reuse the existing StepsJudge / teaching test patterns; stub the LLM seam (no live calls in tests).

- **Phase 1 (`SolutionGenerateTask`):** stubbed-LLM test that a bare question (no rubric) → generates a valid `RubricReferenceSolution` (≥1 expected_signal, non-empty final_answer) + `reference_md`; writes both columns; **idempotent** (second call skips unless `regenerate`); missing-key → logged skip, question untouched; provenance marker set.
- **Phase 2 (solve orchestrator):** (a) start session on a rubric-less question lazily generates the rubric then creates `tutor` session; (b) **typed** submit → StepsJudge/SemanticJudge → JudgeResultV2 → attempt event written → session `judged` → reference_md revealed; (c) **handwritten-photo** submit (`student_image_refs`) → same path (stub the vision judge); (d) low score → mistake enrolled + FSRS scheduled; (e) hint turn returns a non-revealing hint; (f) empty submit → 400.
- **Partition:** orchestrator + routes touch the DB → `pnpm test:db`; pure schema/registry bits unit. Honor `audit:partition`.
- Full pre-PR gate green (`typecheck`/`lint`/`audit:schema|partition|profile`/`test`/`build`).

---

## 8. Acceptance criteria

1. A question with no `rubric_json` can be made judgeable: `SolutionGenerateTask` writes a valid `reference_solution` + `reference_md` (verified on a real ingested question from the 2026-06-01 run).
2. A user can open a solve session on any question, optionally get an escalating hint, and submit either typed steps/answer or a handwritten photo.
3. The submission is judged (StepsJudge/SemanticJudge) against the reference solution → `JudgeResultV2`; an `attempt` event is recorded; the worked solution is revealed.
4. A low score enrolls a mistake (+ causes) and schedules it via FSRS — reusing the existing paths.
5. Lazy generation is idempotent; missing-key / LLM failure degrades gracefully (no 500, no retry storm, manual flow intact).
6. Zero new DB columns / zero `audit:schema` entries; full gate green.

---

## 9. Out of scope (explicit)

- **UI visual polish** — redraw-pending (WR umbrella); ship a minimal entry + reuse `JudgeResultPanel`.
- **Batch solution generation** for the whole question bank — lazy on-demand first.
- **Turn-by-turn co-solve** (step-by-step live checking) — submit-then-critique + hints only.
- **Streaming hints.**
- **New judge capabilities** (`unit_dimension@1`, sympy symbolic equivalence) — out per the Math MVP non-scope.
- **A new mistake/FSRS path** — reuse the existing one.

---

## 10. Implementation order (for the coding agent)

1. **Phase 1 — `SolutionGenerateTask`:** registry entry (`src/ai/registry.ts`) + prompt (`src/ai/task-prompts.ts`); a server module that runs it via the runner and writes `rubric_json.reference_solution` (merge-preserving) + `reference_md` + provenance marker; subject-aware prompt selection; lazy + idempotent + logged-skip robustness. Stubbed-LLM tests.
2. **`TutorStatus` expansion:** `src/core/schema/learning_session.ts:53` → real machine (`active`/`submitted`/`judged`/`ended`/`abandoned`); add the `tutor` arm status to `LearningSessionStatusByType:71`; confirm `learning_session.type`/`status` are text (no migration). Unit test the (type,status) validation.
3. **Solve orchestrator** `src/server/orchestrator/solve.ts` (mirror `teaching.ts`): start (lazy-gen if needed) / hint (TeachingTurn) / submit (judge-by-kind → attempt event → reveal → mistake+FSRS on low score).
4. **Routes:** `POST /api/questions/[id]/solve`, `.../solve/[sid]/hint`, `.../solve/[sid]/submit` (multimodal body; ≥1-non-empty).
5. **Minimal UI entry** reusing `JudgeResultPanel` (thin; defer polish).
6. **Pre-PR gate:** `typecheck`, `lint`, `audit:schema`, `audit:partition`, `audit:profile`, `test:db` (new cases), `build`.

---

## File:line anchors (re-verify before editing)

- StepsJudge multimodal input: `src/core/capability/judges/steps.ts:33-49`; runtime + missing-rubric guard `src/server/ai/judges/steps-judge.ts:165-168`.
- Rubric / reference-solution shape: `src/core/schema/business.ts:165-170` (`RubricReferenceSolution`), `:183` (`Rubric.reference_solution` optional).
- `question.rubric_json` / `reference_md` columns: `src/db/schema.ts:153, 152`.
- Teaching orchestrator + session creation (the pattern to mirror): `src/server/orchestrator/teaching.ts`; `app/api/teaching-sessions/route.ts` (`learning_session(type='conversation')`).
- `learning_session` type/status: `src/core/schema/learning_session.ts:10-17` (types incl. `tutor`), `:53-54` (`TutorStatus` placeholder), `:67-74` (`LearningSessionStatusByType`).
- Attempt event: `src/core/schema/event/known.ts:28`. Judge invoker: `src/server/judge/invoker.ts`. AI runner/log/registry: `src/server/ai/runner.ts`, `src/server/ai/log.ts`, `src/ai/registry.ts`, `src/ai/task-prompts.ts`. Photo upload: `app/api/assets/route.ts`. Partial-credit UI: `src/ui/components/JudgeResultPanel.tsx`.
- Subject profile resolution: `src/subjects/profile.ts`.

---

**Linear issue capture gate:** On approval, create a Linear issue (Strategy/feature: 解题陪练) with the two phases as the scope; reference the Math MVP spec + ADR-0014. The out-of-scope items (batch gen, co-solve, UI polish) are explicitly deferred, not undertracked.
