// YUK-1770 steering — the persisted shape stored on `goal.steering` (jsonb).
//
// A steering goal is a learner-said instruction captured by the companion's
// `record_steering` tool: the learner's verbatim words, the AI restatement, the
// scope that could not be confidently mapped to KCs, an optional subtractive
// exclusion set (D4: 「这周别排物理」 defers due reviews inside the window), and
// free AI-written metadata. Only the exclusion arrays and the date window are
// machine-read by deterministic code paths (due-list deferral, expiry); the rest
// is prompt-facing prose for the agents that read goals.

import { z } from 'zod';

export const SteeringMetadataValue = z.union([z.string().max(200), z.number(), z.boolean()]);
export type SteeringMetadataValueT = z.infer<typeof SteeringMetadataValue>;

/**
 * Free-form AI-written metadata. No deterministic code branches on these keys;
 * they ride goal events for provenance (capture session, date_known flags…).
 */
export const SteeringMetadata = z.record(z.string().max(40), SteeringMetadataValue);
export type SteeringMetadataT = z.infer<typeof SteeringMetadata>;

/**
 * The `goal.steering` jsonb payload. `learner_words` is the integrity anchor:
 * it must be a verbatim (NFKC, whitespace-collapsed) substring of a user
 * message in the capturing copilot session — checked deterministically at
 * record time so the AI cannot invent an instruction the learner never gave.
 */
export const SteeringGoalData = z.object({
  /** Verbatim quote of what the learner said (≤500 chars). */
  learner_words: z.string().min(1).max(500),
  /** AI restatement in plain words; the only guidance-facing summary. */
  instruction_md: z.string().min(1).max(280),
  /** The scope as the learner said it, e.g. 「第1–3章」; null when n/a. */
  scope_text: z.string().max(200).nullable(),
  /** Scope parts that could not be confidently mapped to KCs; kept as text. */
  scope_unresolved: z.array(z.string().max(80)).max(10),
  /** D4 subtractive steering: subjects whose due reviews defer inside the window. */
  excluded_subject_ids: z.array(z.string().min(1).max(80)).max(8),
  /** D4 subtractive steering: KCs whose due reviews defer inside the window. */
  excluded_knowledge_ids: z.array(z.string().min(1)).max(60),
  metadata: SteeringMetadata,
});
export type SteeringGoalDataT = z.infer<typeof SteeringGoalData>;
