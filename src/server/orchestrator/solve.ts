// YUK-193 — Solve-tutor orchestrator (spec §3.2). Mirrors orchestrator/teaching.ts.
//
// Three operations: startSolveSession (lazy-gen + create), planSolveHint
// (TeachingTurn-seeded escalating hint), submitSolveAttempt (judge → attempt
// event → reveal → mistake-on-low-score). All AI calls go through injectable
// fns so tests stub the LLM/judge seam (no live calls).
import { eq } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import {
  type GenerateReferenceSolutionResult,
  type SolutionGenerateRunTaskFn,
  generateReferenceSolution,
} from '@/server/ai/solution-generate';
import { Tutor } from '@/server/session';

export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

export class SolveError extends Error {
  constructor(
    public code:
      | 'question_not_found'
      | 'session_not_found'
      | 'session_not_active'
      | 'empty_submission'
      | 'llm_parse_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SolveError';
  }
}

export interface StartSolveSessionParams {
  db: Db;
  questionId: string;
  /** Injected in tests; forwarded to generateReferenceSolution. */
  runTaskFn?: SolutionGenerateRunTaskFn;
  /** Force regeneration of the reference solution. */
  regenerate?: boolean;
}

export interface StartSolveSessionResult {
  sessionId: string;
  /** true when this call generated a fresh reference solution. */
  generated: boolean;
  /** true when lazy generation was attempted but failed (degraded mode). */
  generationError: boolean;
}

export async function startSolveSession(
  params: StartSolveSessionParams,
): Promise<StartSolveSessionResult> {
  const { db, questionId } = params;

  const [q] = await db
    .select({ id: question.id })
    .from(question)
    .where(eq(question.id, questionId))
    .limit(1);
  if (!q) throw new SolveError('question_not_found', `question ${questionId} not found`);

  let gen: GenerateReferenceSolutionResult;
  try {
    gen = await generateReferenceSolution({
      db,
      questionId,
      runTaskFn: params.runTaskFn,
      regenerate: params.regenerate,
    });
  } catch (err) {
    // generateReferenceSolution already swallows LLM/parse errors into
    // skipped_error; this catch only guards an unexpected throw (e.g. DB read).
    console.warn(`[startSolveSession] generation threw for ${questionId}:`, err);
    gen = { status: 'skipped_error', reason: err instanceof Error ? err.message : String(err) };
  }

  const { sessionId } = await Tutor.startTutorSession(db, { questionId });

  return {
    sessionId,
    generated: gen.status === 'generated',
    generationError: gen.status === 'skipped_error',
  };
}
