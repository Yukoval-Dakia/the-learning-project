// YUK-1049 — OpenRouter native decisions endpoint (POST /api/v1/systemone)
// wire contract: the {state, questions} typed input and the full typed
// response, as verified by the D12 smoke (2026-09-24 — wire/auth/cost only,
// NO accuracy claim).
//
// Subject-agnostic transport contract → lives in core (same lane as
// provider-attempt.ts). Ownership of the TASK spec stays in
// src/capabilities/practice/tasks/jev-typed.ts; the typed runner and the
// assessment executor import THESE schemas so no server→capability edge
// exists (capability-boundaries baseline).
//
// Contract facts (decisions file D12 + TypeSafe docs):
//   - request model pin 'typesafe/jev-1.13' → canonical response model
//     'typesafe/jev-1.13-20260917'; provider TypeSafe only;
//   - usage / usage.cost / probabilities / confidence are OPTIONAL —
//     absence must NEVER be fabricated;
//   - confidence is distribution shape, not accuracy; score is a
//     probability-weighted expectation over level indices, not points.

import { z } from 'zod';

// ---------- typed questions ----------

/**
 * Typed-question criteria, keyed by question primitive.
 *   noul   — probability a boolean statement holds (true/false criteria text)
 *   choice — single best category (criteria = option_id → descriptor|null)
 *   score  — probability-weighted expectation over ordered level descriptors
 */
export const JevQuestion = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('noul'),
    instructions: z.string().min(1),
    criteria: z.object({ true: z.string().min(1), false: z.string().min(1) }).strict(),
  }),
  z.object({
    type: z.literal('choice'),
    instructions: z.string().min(1),
    criteria: z.record(z.string(), z.string().nullable()),
  }),
  z.object({
    type: z.literal('score'),
    instructions: z.string().min(1),
    /** Ordered level descriptors — the response legend indexes this array. */
    criteria: z.array(z.string().min(1)).min(2),
  }),
]);
export type JevQuestionT = z.infer<typeof JevQuestion>;

const JsonLeaf = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([JsonLeaf, z.array(JsonValue), z.record(z.string(), JsonValue)]),
);

/**
 * The task's typed input: exactly the {state, questions} keys the runner
 * folds into the canonical systemone body (model/provider constraints are
 * pinned runner-side so callers cannot weaken them). `state` is any JSON
 * value; questions ≥1, keyed by stable question ids (e.g. scoring_unit_id).
 */
export const JevScoringDecisionInput = z
  .object({
    state: JsonValue,
    questions: z.record(z.string().min(1), JevQuestion),
  })
  .strict();
export type JevScoringDecisionInputT = z.infer<typeof JevScoringDecisionInput>;

// ---------- typed response (the full systemone response) ----------

export const JevNoulAnswer = z.object({
  type: z.literal('noul'),
  /** P(statement holds); distribution shape, NOT accuracy. */
  noul: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1).optional(),
});
export const JevChoiceAnswer = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export const JevScoreAnswer = z.object({
  type: z.literal('score'),
  /** Expectation over level indices — NOT student points. */
  score: z.number(),
  legend: z.record(z.string(), z.string()).optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export const JevAnswer = z.discriminatedUnion('type', [
  JevNoulAnswer,
  JevChoiceAnswer,
  JevScoreAnswer,
]);
export type JevAnswerT = z.infer<typeof JevAnswer>;

export const JevSystemOneResponse = z
  .object({
    id: z.string().optional(),
    /** Pinned canonical; the runner asserts it equals the expected pin. */
    model: z.string(),
    provider: z.string().optional(),
    answers: z.record(z.string(), JevAnswer),
    usage: z
      .object({
        input_tokens: z.number().int().min(0).optional(),
        output_tokens: z.number().int().min(0).optional(),
        /** OPTIONAL per contract — absence ⇒ estimated cost, never faked. */
        cost: z.number().min(0).optional(),
      })
      .optional(),
  })
  .strict();
export type JevSystemOneResponseT = z.infer<typeof JevSystemOneResponse>;
