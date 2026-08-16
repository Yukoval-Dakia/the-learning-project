import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';

export type StructuredReviewVerdict = 'pass' | 'fail';

export type StructuredReviewAttempt<T> =
  | {
      outcome: 'contract_invalid';
      task_run_id?: string;
      detail?: string;
    }
  | {
      outcome: 'valid';
      task_run_id: string;
      verdict: StructuredReviewVerdict;
      result: T;
    };

export type ConfirmedStructuredReviewResult<T> =
  | {
      status: 'decided';
      verdict: StructuredReviewVerdict;
      result: T;
      attempts: StructuredReviewAttempt<T>[];
    }
  | {
      status: 'invalid';
      reason: 'attempt_budget_exhausted' | 'pass_not_confirmed';
      attempts: StructuredReviewAttempt<T>[];
    };

/**
 * Generic state machine used by release-critical structured comparators.
 *
 * It deliberately knows nothing about questions, intervention packages, or
 * Copilot prose. Domain adapters own paid-call execution, parsing, sealed
 * source binding, and persistence; this module owns the shared FULL invariant:
 * a valid fail stops immediately, while a pass is authoritative only after
 * every bounded attempt is a valid pass. Contract-invalid output consumes an
 * attempt and can never be washed into a pass by the final slot.
 */
export async function runConfirmedStructuredReview<T>(input: {
  maxAttempts: number;
  runAttempt: (attempt: number) => Promise<StructuredReviewAttempt<T>>;
}): Promise<ConfirmedStructuredReviewResult<T>> {
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 2) {
    throw new Error('confirmed structured review requires at least two bounded attempts');
  }

  const attempts: StructuredReviewAttempt<T>[] = [];
  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    const observed = await input.runAttempt(attempt);
    attempts.push(observed);
    if (observed.outcome !== 'valid') continue;
    if (observed.verdict === 'fail') {
      return {
        status: 'decided',
        verdict: 'fail',
        result: observed.result,
        attempts,
      };
    }
  }

  const validPasses = attempts.filter(
    (attempt): attempt is Extract<StructuredReviewAttempt<T>, { outcome: 'valid' }> =>
      attempt.outcome === 'valid' && attempt.verdict === 'pass',
  );
  if (
    attempts.length === input.maxAttempts &&
    validPasses.length === input.maxAttempts &&
    attempts.every((attempt) => attempt.outcome === 'valid' && attempt.verdict === 'pass')
  ) {
    const finalPass = validPasses.at(-1);
    if (!finalPass) throw new Error('confirmed pass result unexpectedly missing');
    return {
      status: 'decided',
      verdict: 'pass',
      result: finalPass.result,
      attempts,
    };
  }

  return {
    status: 'invalid',
    reason: validPasses.length > 0 ? 'pass_not_confirmed' : 'attempt_budget_exhausted',
    attempts,
  };
}

/** Bind a successful paid validator run to its exact prompt/input/result. */
export async function persistValidatorRunBinding(
  db: Db,
  input: {
    taskRunId: string;
    taskKind: string;
    taskInputSha256: string;
    promptFingerprint: string;
    resultDigest?: string | null;
  },
): Promise<void> {
  const rows = await db
    .update(ai_task_runs)
    .set({
      prompt_fingerprint: input.promptFingerprint,
      ...(input.resultDigest !== undefined ? { result_digest: input.resultDigest } : {}),
    })
    .where(
      and(
        eq(ai_task_runs.id, input.taskRunId),
        eq(ai_task_runs.task_kind, input.taskKind),
        eq(ai_task_runs.input_hash, input.taskInputSha256),
        eq(ai_task_runs.status, 'success'),
      ),
    )
    .returning({ id: ai_task_runs.id });
  if (rows.length !== 1) {
    throw new Error('validator run binding did not match one successful task run');
  }
}
