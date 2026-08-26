// YUK-605 ① + YUK-555 — POST /api/questions/quiz-gen manual trigger contracts.
//
// Design: docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md §4/Q4
// (thin route: validate → enqueue quiz_gen → 202, manual-first). Guardrails follow
// the repo's 护栏两层 convention (decide-breaker.ts / note-refine-breaker.ts /
// budgets.ts): a warning watermark that only informs, plus a hard cap that only
// prevents accidents.
//
// This module is imported STATICALLY by the practice manifest, so it must stay
// dependency-light (zod only) — that is why the guardrail constants live here
// instead of jobs/quiz_gen.ts (whose import graph drags the whole agent runtime).

import { z } from 'zod';

// YUK-555 — two-layer count guardrail for the MANUAL endpoint.
//
// Normal volume = QUIZ_GEN_DEFAULT_COUNT (3, jobs/quiz_gen.ts §4). Per YUK-555 the
// hard cap sits at ~3-5× normal volume (事故防护, not throttling of heavy use):
//   · WARN = 2 × 3 = 6  — response carries a `warning` field; the request still
//     goes through (warn 水位：零干预只告知).
//   · CAP  = 5 × 3 = 15 — zod `.max()` rejects the request with 400. Deliberately
//     below both the nightly structural cap (question_supply_nightly
//     DEFAULT_MAX_PER_RUN = 25) and the AGENT queue's 2h expire comfort envelope:
//     after YUK-554's solve_check wiring each queued question costs 2-3 LLM calls
//     at verify time, so a manual burst multiplies an already-material cost.
// Values are literals (not imported from jobs/quiz_gen.ts) to keep the manifest's
// static import graph db-free; if QUIZ_GEN_DEFAULT_COUNT ever changes, revisit
// these derivations together.
export const QUIZ_GEN_MANUAL_DEFAULT_COUNT = 3;
export const QUIZ_GEN_MANUAL_COUNT_WARN = 6;
export const QUIZ_GEN_MANUAL_COUNT_CAP = 15;

export const QuizGenTriggerBodySchema = z.object({
  /** Knowledge point (KC) to generate questions for. Must resolve a real,
   * un-archived knowledge row — the route 404s on an empty read. */
  knowledge_id: z.string().min(1),
  /** How many questions to request. Defaults to the manual normal volume. */
  count: z
    .number()
    .int()
    .min(1)
    .max(QUIZ_GEN_MANUAL_COUNT_CAP, {
      error: `count must be ≤ ${QUIZ_GEN_MANUAL_COUNT_CAP} (manual quiz-gen hard cap, YUK-555)`,
    })
    .default(QUIZ_GEN_MANUAL_DEFAULT_COUNT),
  /** Optional generation-method preference (the dispatcher's subject-context
   * analog). material_grounded requires TAVILY_API_KEY; the route rejects it
   * with 409 when Tavily is unavailable instead of enqueuing a doomed job
   * (dispatcher review FINDING #5 gate, same single-truth predicate). */
  generation_method: z.enum(['material_grounded', 'closed_book']).optional(),
});

/** 202 Accepted — enqueue evidence. `job_id` is the pg-boss id returned by the
 * same kernel enqueue the nightly dispatcher uses; `warning` is present only
 * when count reached the warning watermark. */
export const QuizGenTriggerAcceptedSchema = z.object({
  status: z.literal('enqueued'),
  queue: z.literal('quiz_gen'),
  job_id: z.string(),
  trigger: z.literal('manual'),
  knowledge_id: z.string(),
  count: z.number().int(),
  generation_method: z.enum(['material_grounded', 'closed_book']).optional(),
  warning: z.string().optional(),
});
