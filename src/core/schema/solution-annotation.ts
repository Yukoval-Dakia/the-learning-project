/**
 * Ingestion solution annotation (YUK-1994 slice 3).
 *
 * A short, learner-facing description of HOW a question is solved: the method name
 * plus the key moves. It is deliberately not an answer key: it has no final-answer
 * field and never feeds the grader. The answer key stays `question.reference_md`,
 * the grading reference stays `question.rubric_json.reference_solution`, and the
 * admission-owned `question_solution_prior` stays private — none of them is written
 * by this contract.
 */
import { z } from 'zod';

/** Bump when the annotation semantics or stored shape change. */
export const SOLUTION_ANNOTATION_CONTRACT = 'ingestion-solution-annotation-v1';

const METHOD_MAX_CHARS = 200;
const STEP_MAX_CHARS = 200;
const MAX_STEPS = 8;

/** What the model returns: a method summary, not a worked answer. */
export const SolutionAnnotationOutput = z.object({
  /** The method / core idea, e.g. 「楞次定律判断感应电流方向」. */
  method_md: z.string().trim().min(1).max(METHOD_MAX_CHARS),
  /** The key moves in execution order; no final answer. */
  steps_md: z.array(z.string().trim().min(1).max(STEP_MAX_CHARS)).min(1).max(MAX_STEPS),
  /** The model's own confidence in this annotation, 0..1 (a signal, never a gate). */
  confidence: z.number().min(0).max(1),
});
export type SolutionAnnotationOutputT = z.infer<typeof SolutionAnnotationOutput>;

/**
 * What is persisted on `question.metadata.solution_annotation`. Provenance rides
 * with the annotation so an audit can reconcile it to the paid run.
 */
export const StoredSolutionAnnotation = SolutionAnnotationOutput.extend({
  contract: z.literal(SOLUTION_ANNOTATION_CONTRACT),
  task_run_id: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  generated_at: z.string(),
});
export type StoredSolutionAnnotationT = z.infer<typeof StoredSolutionAnnotation>;

/** Tolerant read: an unknown/legacy shape reads as null, never a crash. */
export function readStoredSolutionAnnotation(value: unknown): StoredSolutionAnnotationT | null {
  const parsed = StoredSolutionAnnotation.safeParse(value);
  return parsed.success ? parsed.data : null;
}
