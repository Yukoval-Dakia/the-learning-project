import { z } from 'zod';

/**
 * Mastery-evidence attachment on a grader result.
 * It never contributes to points_awarded or the answer aggregate.
 */
export const KcEvidenceDirection = z.enum(['up', 'down', 'none']);
export type KcEvidenceDirectionT = z.infer<typeof KcEvidenceDirection>;

export const KcMasteryUpdate = z
  .object({
    kc_id: z.string().min(1),
    role: z.enum(['primary', 'dependency']),
    direction: KcEvidenceDirection,
    /** Share of this attempt's mastery step, in (0, 1]. Not an answer score. */
    weight: z.number().gt(0).lte(1),
    uncertain: z.boolean(),
    /** Data for a later UI pipe. Not rendered here. */
    learner_line: z.string().min(1).max(200),
  })
  .strict();
export type KcMasteryUpdateT = z.infer<typeof KcMasteryUpdate>;

export const KcWrongCause = z
  .object({
    /** KC that dragged the attempt down. null when nothing failed or the cause cannot be named. */
    kc_id: z.string().min(1).nullable(),
    uncertain: z.boolean(),
  })
  .strict();
export type KcWrongCauseT = z.infer<typeof KcWrongCause>;

/** Optional grader payload. Absent on deterministic items and on older model output. */
export const GraderKcMasteryEvidence = z
  .object({
    wrong_cause: KcWrongCause,
    updates: z.array(KcMasteryUpdate).min(1).max(32),
  })
  .strict();
export type GraderKcMasteryEvidenceT = z.infer<typeof GraderKcMasteryEvidence>;

/** One KC row inside a single theta call. Distinct from the answer score. */
export interface KcEvidenceApply {
  kc_id: string;
  outcome: 0 | 1;
  weight: number;
}

/**
 * A shared unit cannot show that a dependency KC failed on its own.
 * The dependency still moves, but only a quarter of a full mastery step, and the
 * row is marked uncertain. This is not a point value.
 */
export const DEPENDENCY_EVIDENCE_WEIGHT = 0.25;

export function learnerLine(role: 'primary' | 'dependency', uncertain: boolean): string {
  const base = role === 'primary' ? '这题主要考这个知识点' : '还需要这个知识点';
  return uncertain ? `${base}，归属不确定` : base;
}
