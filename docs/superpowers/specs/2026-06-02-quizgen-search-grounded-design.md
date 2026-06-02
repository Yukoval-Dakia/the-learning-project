# Search-grounded QuizGen (T-SQ) — backend wave design

> **Status**: design, 2026-06-02. **Issue**: (T-SQ wave). **Refs**: v0.4 roadmap §3 第5层 / P3.1-3.2; YUK-198 (Tavily MCP, on main); ADR-0006 v2 (events); evidence-first principle.
> Gate policy = **Option B** (owner-confirmed). All other forks = defaults below.

## 0. Decisive constraint (shapes everything)

Search-call provenance **cannot be recovered from logs**: `RunTaskResult` (runner.ts:56-64) exposes only `{task_run_id,text,finishReason,usage,cost_usd}` — no tool_use blocks; the non-stream `runTask`/`runAgentTask` path writes zero `tool_call_log` rows; and even `streamTask` does **not** mirror remote-Tavily tool_use (only local `buildMcpServerFromRegistry` tools mirror). **⇒ The QuizGen agent MUST self-declare its sources (`source_refs`) in its structured JSON output.** The systemPrompt + output schema are built around this. This is consistent with evidence-first (the agent declares its sources; traceable + reversible).

## 1. Architecture

Two tasks, mirroring EmbeddedCheckGenerate (gen) + VariantVerify (verify):

- **`QuizGenTask`** — tool-calling agent (`needsToolCall:true`, `maxIterations:8`, `timeout:120_000`, model mimo-v2.5-pro / fb mimo-v2.5, `allowedTools:[]` in registry → handler injects). Mounts **Tavily remote MCP** (`buildTavilyMcpServer()`, reuse YUK-198) + the **in-process domain-tool MCP** (read user mistakes + knowledge graph) — copy the verbatim mount pattern from `copilot/chat.ts:298-306`. Runs through the existing `runAgentTask` (no runner change). In its loop it: plans (knowledge/difficulty/types), searches via `tavily_search`/`tavily_extract` for **source material** (not questions), generates **ORIGINAL** questions grounded in sources, and emits every used source into `source_refs`.
- **`QuizVerifyTask`** — single-shot (`needsToolCall:false`, `maxIterations:1`, `timeout:60_000`), built on the VariantVerify skeleton. **closed-book** (trusts the agent's `source_refs`; no own Tavily loop in this wave — default). Three checks: fact/grounding, plagiarism/copy_safety, knowledge-hit.

**Reuse, do not rebuild**: `runAgentTask`, `buildTavilyMcpServer`, the domain MCP builder, `aiAgentRef`+`costUsdToMicroUsd`, `writeEvent`, the pg-boss handler skeleton (claim→run→parse→INSERT→writeEvent→catch) from `embedded_check_generate.ts`, the verify skeleton from `variant_verify.ts`, and the FSRS-init/enroll path (do NOT hand-roll FSRS). Extract `defaultJudgeKindForQuestion` from `embedded_check_generate.ts:62-81` to a shared util.

## 2. Data model (zero migration for Q1-Q4)

- `QuestionSource` enum (`src/core/schema/business.ts:30-41`): add `'quiz_gen'` (Zod enum = code-only, no ALTER).
- `question.metadata.quiz_gen` (existing jsonb `JsonObject`; precedent: workflow_judge) holds:
  ```ts
  metadata.quiz_gen = {
    source_pack: { query_plan: string[]; searched_at: string; tool: 'tavily' },
    source_refs: Array<{ url: string; title: string; snippet?: string; used_for: 'fact'|'inspiration'; extracted: boolean }>,
    generation_method: 'search_grounded' | 'closed_book',
    copy_safety: { verdict: 'original'|'too_close'|'unknown'; max_overlap?: number; checked_by: 'agent_self'|'quiz_verify' },
    generation_status: 'ready',                 // set by QuizGenTask on successful parse
    verification?: { status: 'verified'|'needs_review'|'failed'; summary: string; verified_by: AgentRefT },
  }
  ```
  Define these as Zod types in `src/core/schema` (Q1). **Not** promoted to DDL columns (defer; promote only if a reader needs SQL filtering).
- `question.source_ref` (existing single text col) = the **trigger pointer** (knowledge_id / learning_item_id), NOT a web URL.
- `question.created_by` = `aiAgentRef('QuizGenTask', result)`; `question.rubric_json` filled by the agent like EmbeddedCheckGenerate (criteria/keywords/required_points/reference_solution).
- `question.draft_status` write path for `source='quiz_gen'`: this wave WRITES it (`'draft'`→`'active'`), which extends the constrained write set — add an audit-schema allowlist note or confirm the write path is recognized.

## 3. Lifecycle — Gate Option B (owner-confirmed)

- **Q3 quiz_gen handler**: INSERT each generated question with `draft_status='draft'` (NOT in review pool, no FSRS yet) + `source='quiz_gen'` + `metadata.quiz_gen` (generation_status='ready', agent self copy_safety, source_refs, source_pack) + `source_ref`=trigger + `created_by`. Then enqueue a chained `quiz_verify` job `{ question_ids }` (like ingestion → attribution_followup).
- **Q5 QuizVerifyTask + quiz_verify handler**: idempotency guard (skip if `event(action='experimental:quiz_verify', subject_kind='question', subject_id)` exists). Run the 3 checks. Write `metadata.quiz_gen.verification` (two-axis) + `writeEvent(action='experimental:quiz_verify', subject_kind='question', outcome)`. On **pass** → **promote** `draft_status`→`'active'` AND **Q6 FSRS enroll** (init `material_fsrs_state` for the question via the existing enroll path) so it enters the review pool. On **fail / too_close** → leave `draft_status='draft'` with `verification.status='needs_review'|'failed'` (never reaches the pool). failure-bottom: catch → set `verification.status='failed'` → re-throw (pg-boss retries).

## 4. Trigger (backend-now) + defaults

- pg-boss job `quiz_gen`, data `{ trigger:'knowledge'|'learning_item'|'manual', ref_id, count? }` (default count e.g. 3). Handler skeleton copied from `embedded_check_generate.ts`.
- thin `POST /api/questions/quiz-gen` (or `/api/knowledge/[id]/quiz-gen`) route behind the x-internal-token middleware: validate input → enqueue `quiz_gen` → 202. **Manual-first** (auto-trigger on weak-cause is a later slice).
- copy_safety: QuizVerify runs a deterministic normalized n-gram overlap(prompt_md, source snippets) + LLM judgement; `'too_close'` blocks promotion (stays draft/needs_review). Threshold tunable; start conservative.
- **No UI this wave** — generate button / source·copy badges / draft-review surface are **Q7 → YUK-169 redraw** (SolveTutorPanel precedent: backend + route, minimal/no UI).

## 5. Slices (each green on its own; one branch `yuk-quizgen`)

- **Q1** — `'quiz_gen'` enum value + `metadata.quiz_gen` Zod types in `src/core/schema` + extract `defaultJudgeKindForQuestion` util. Pure types/enum, no behavior. (unit)
- **Q2** — `QuizGenTask` registry entry + `task-prompts.ts` builder (the §0 self-declare-sources + original-only + emit-source_refs + self copy_safety instructions) + Zod output schema (`{ questions:[{kind,prompt_md,reference_md,choices_md?,judge_kind_override?,rubric_json?,difficulty,knowledge_ids}], source_pack, per-question source_refs, generation_method, self_copy_safety }`). (unit: parse fixtures + prompt snapshot)
- **Q3** — `src/server/boss/handlers/quiz_gen.ts`: mount Tavily + domain MCP (copy chat.ts), `runAgentTask`, parse → INSERT draft questions + metadata + enqueue quiz_verify. (DB test, mocked AI)
- **Q4** — `POST /api/questions/quiz-gen` route: validate + enqueue. (route test)
- **Q5** — `QuizVerifyTask` registry+prompt+output schema + `src/server/boss/handlers/quiz_verify.ts`: idempotency + 3 checks + two-axis persist + **promote draft→active on pass** + FSRS enroll; demote/needs_review on fail. (DB test)
- **Q6** — FSRS enroll-on-active wiring (reuse enroll path; fold into Q5's promote). (DB test)
- **Q7 [redraw-UI]** — deferred to YUK-169.

## 6. Out of scope (this wave)

UI (Q7→redraw); auto-trigger on weak-cause; QuizVerify own Tavily loop; DDL column promotion of metadata keys; mounting Tavily on cron surfaces (Dreaming/Coach stay web-search-free).
