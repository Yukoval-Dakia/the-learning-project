// YUK-193 — Solve-tutor orchestrator (spec §3.2). Mirrors orchestrator/teaching.ts.
//
// Three operations: startSolveSession (lazy-gen + create), planSolveHint
// (TeachingTurn-seeded escalating hint), submitSolveAttempt (judge → attempt
// event → reveal → mistake-on-low-score). All AI calls go through injectable
// fns so tests stub the LLM/judge seam (no live calls).
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import {
  type GenerateReferenceSolutionResult,
  type SolutionGenerateRunTaskFn,
  generateReferenceSolution,
} from '@/server/ai/solution-generate';
import { resolveSubjectProfileForKnowledgeIds } from '@/server/knowledge/subject-profile';
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

// Reuse the TeachingTurnTask output loosely — for hints we only need text_md
// (the minimal next step). Parse defensively: any JSON object with a string
// text_md is accepted.
const HintTurn = z.object({ text_md: z.string().min(1) }).passthrough();

export interface PlanSolveHintParams {
  db: Db;
  sessionId: string;
  /** 0-based hint count so far in this session — escalates the ask. */
  hintIndex: number;
  runTaskFn?: RunTaskFn;
}

export interface PlanSolveHintResult {
  text_md: string;
}

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}

function parseHintTurn(text: string): PlanSolveHintResult {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new SolveError('llm_parse_failed', 'hint turn output had no JSON object');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new SolveError(
      'llm_parse_failed',
      `hint turn JSON.parse failed: ${(e as Error).message}`,
    );
  }
  const parsed = HintTurn.safeParse(raw);
  if (!parsed.success) {
    throw new SolveError('llm_parse_failed', `hint turn schema mismatch: ${parsed.error.message}`);
  }
  return { text_md: parsed.data.text_md };
}

export async function planSolveHint(params: PlanSolveHintParams): Promise<PlanSolveHintResult> {
  const { db, sessionId, hintIndex } = params;
  const runTaskFn = params.runTaskFn ?? defaultRunTaskFn;

  const { questionId } = await Tutor.getTutorQuestionId(db, sessionId);
  if (!questionId) {
    throw new SolveError('session_not_found', `tutor session ${sessionId} missing question link`);
  }
  const [q] = await db
    .select({
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      knowledge_ids: question.knowledge_ids,
    })
    .from(question)
    .where(eq(question.id, questionId))
    .limit(1);
  if (!q) throw new SolveError('question_not_found', `question ${questionId} not found`);

  const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, q.knowledge_ids);

  // Seed TeachingTurnTask with the worked solution as material + a synthetic
  // message asking for ONLY the next step (escalating with hintIndex). The
  // TeachingTurnTask prompt forbids dumping the full solution + caps ≤300 字/轮,
  // so the returned text_md is a minimal hint, not the answer.
  const input = {
    learning_item: {
      title: '解题陪练',
      one_line_intent: q.prompt_md,
      knowledge_node: null,
    },
    parent_hub_summary: null,
    atomic_sections: q.reference_md ? { worked_solution: q.reference_md } : null,
    messages: [
      {
        role: 'user' as const,
        text_md:
          hintIndex === 0
            ? '我卡住了，给我一个不剧透答案的最小提示，只点一步方向。'
            : `还是不会，给下一个更具体的提示（第 ${hintIndex + 1} 个），仍然不要直接说出最终答案。`,
      },
    ],
  };

  const { text } = await runTaskFn('TeachingTurnTask', input, { db, subjectProfile });
  return parseHintTurn(text);
}
