// YUK-193 — Solve-tutor orchestrator (spec §3.2). Mirrors orchestrator/teaching.ts.
//
// Three operations: startSolveSession (lazy-gen + create), planSolveHint
// (TeachingTurn-seeded escalating hint), submitSolveAttempt (judge → attempt
// event → reveal → mistake-on-low-score). All AI calls go through injectable
// fns so tests stub the LLM/judge seam (no live calls).
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import type { JudgeAnswerParams } from '@/server/ai/judges/question-contract';
import {
  type GenerateReferenceSolutionResult,
  type SolutionGenerateRunTaskFn,
  generateReferenceSolution,
} from '@/server/ai/solution-generate';
import { writeEvent } from '@/server/events/queries';
import { type JudgeInvokerOutput, createDefaultJudgeInvoker } from '@/server/judge/invoker';
import { resolveSubjectProfileForKnowledgeIds } from '@/server/knowledge/subject-profile';
import { sanitizeJsonStringLiterals } from '@/server/orchestrator/json-sanitize';
import { createLearningRecord } from '@/server/records/queries';
import { Tutor } from '@/server/session';

export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

// Default mastery threshold for solve-tutor: a judged attempt scoring below this
// is enrolled as a mistake (spec §3.2 "score < subject's mastery threshold").
// Subject profiles do not yet carry a per-subject threshold; this constant is the
// single default until they do (revisit when SubjectProfile gains the field).
const SOLVE_MASTERY_THRESHOLD = 0.7;

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
  /** When set, the session's linked question must equal this (route-level guard). */
  expectedQuestionId?: string;
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

// AF S4 / YUK-203 U6 (OQ6, Cross-统合 §4.3) — the pure, session-FREE seed body
// extracted from planSolveHint (was solve.ts:189-206) so the Copilot solve-skill
// reuses the SAME TeachingTurnTask input rather than the tutor-session-bound
// entry. It takes a question face + reference + hintIndex — NOT a sessionId.
//
// Seeds the worked solution as material + a synthetic message asking for ONLY the
// next step (escalating with hintIndex). The TeachingTurnTask prompt forbids
// dumping the full solution + caps ≤300 字/轮, so the returned text_md is a
// minimal hint, not the answer. NO prior-attempt summary, NO memory content
// (R4/R6: the hint turn is not memory-bearing).
export function buildSolveHintInput(
  q: { prompt_md: string; reference_md: string | null },
  hintIndex: number,
): unknown {
  return {
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
}

// AF S4 / YUK-203 U6 — exported (was private) so the Copilot solve-skill parses
// the TeachingTurnTask hint output with the SAME defensive parser (single contract).
export function parseHintTurn(text: string): PlanSolveHintResult {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new SolveError('llm_parse_failed', 'hint turn output had no JSON object');
  }
  let raw: unknown;
  const slice = text.slice(start, end + 1);
  try {
    raw = JSON.parse(slice);
  } catch (firstErr) {
    // Fallback: LLM may embed bare control characters inside string literals.
    // Sanitize and retry once before giving up.
    try {
      const sanitized = sanitizeJsonStringLiterals(slice);
      console.warn(
        `[parseHintTurn] JSON.parse failed (${(firstErr as Error).message}); retrying after control-char sanitization`,
      );
      raw = JSON.parse(sanitized);
    } catch {
      throw new SolveError(
        'llm_parse_failed',
        `hint turn JSON.parse failed: ${(firstErr as Error).message}`,
      );
    }
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

  const { questionId, status } = await Tutor.getTutorQuestionId(db, sessionId);
  if (!questionId) {
    throw new SolveError('session_not_found', `tutor session ${sessionId} missing question link`);
  }
  if (params.expectedQuestionId !== undefined && questionId !== params.expectedQuestionId) {
    throw new SolveError(
      'session_not_found',
      `tutor session ${sessionId} is not bound to question ${params.expectedQuestionId}`,
    );
  }
  // Hints are only meaningful while the student is still solving; once the
  // session is submitted/judged/ended the worked solution is (or will be)
  // revealed, so refuse to spend more LLM budget on hints.
  if (status !== 'active') {
    throw new SolveError('session_not_active', `tutor session ${sessionId} status=${status}`);
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

  const input = buildSolveHintInput(q, hintIndex);
  const { text } = await runTaskFn('TeachingTurnTask', input, { db, subjectProfile });
  return parseHintTurn(text);
}

export interface SolveSubmission {
  student_text_steps?: string[];
  student_final_answer_text?: string;
  student_image_refs?: string[];
}

export type JudgeFn = (input: JudgeAnswerParams) => Promise<JudgeInvokerOutput>;

export interface SubmitSolveAttemptParams {
  db: Db;
  sessionId: string;
  submission: SolveSubmission;
  /** When set, the session's linked question must equal this (route-level guard). */
  expectedQuestionId?: string;
  /** Injected in tests; defaults to the production JudgeInvoker. */
  judgeFn?: JudgeFn;
  runTaskFn?: RunTaskFn;
}

export interface SubmitSolveAttemptResult {
  attempt_event_id: string;
  judge: {
    route: string;
    score: number | null;
    coarse_outcome: string;
    confidence: number;
    reason_md: string;
    evidence_json: unknown;
  };
  /** The worked solution revealed after judging (null if generation failed). */
  revealed_solution_md: string | null;
  /** Set when a mistake was enrolled (low score). */
  mistake_id?: string;
}

function hasNonEmptyCarrier(s: SolveSubmission): boolean {
  const steps = (s.student_text_steps ?? []).filter((x) => x.trim().length > 0);
  const finalText = (s.student_final_answer_text ?? '').trim();
  const images = (s.student_image_refs ?? []).filter((x) => x.trim().length > 0);
  return steps.length > 0 || finalText.length > 0 || images.length > 0;
}

function eventOutcomeForJudge(
  coarseOutcome: 'correct' | 'partial' | 'incorrect' | 'unsupported',
): 'success' | 'partial' | 'failure' {
  if (coarseOutcome === 'correct') return 'success';
  if (coarseOutcome === 'incorrect') return 'failure';
  return 'partial';
}

export async function submitSolveAttempt(
  params: SubmitSolveAttemptParams,
): Promise<SubmitSolveAttemptResult> {
  const { db, sessionId, submission } = params;

  if (!hasNonEmptyCarrier(submission)) {
    throw new SolveError(
      'empty_submission',
      'at least one of student_text_steps / student_final_answer_text / student_image_refs must be non-empty',
    );
  }

  const { questionId, status } = await Tutor.getTutorQuestionId(db, sessionId);
  if (!questionId) {
    throw new SolveError('session_not_found', `tutor session ${sessionId} missing question link`);
  }
  if (params.expectedQuestionId !== undefined && questionId !== params.expectedQuestionId) {
    throw new SolveError(
      'session_not_found',
      `tutor session ${sessionId} is not bound to question ${params.expectedQuestionId}`,
    );
  }
  if (status !== 'active') {
    throw new SolveError('session_not_active', `tutor session ${sessionId} status=${status}`);
  }

  const [q] = await db.select().from(question).where(eq(question.id, questionId)).limit(1);
  if (!q) throw new SolveError('question_not_found', `question ${questionId} not found`);

  const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, q.knowledge_ids);

  const answerParts = [
    ...(submission.student_text_steps ?? []),
    submission.student_final_answer_text,
  ].filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  const answerMd = answerParts.join('\n');

  const judgeFn = params.judgeFn ?? ((input) => createDefaultJudgeInvoker().invoke(input));
  const judged = await judgeFn({
    db,
    question: q,
    answer_md: answerMd,
    student_image_refs: submission.student_image_refs ?? [],
    subjectProfile,
    runTaskFn: params.runTaskFn,
  });

  const judgeResult = judged.result;
  const outcome = eventOutcomeForJudge(judgeResult.coarse_outcome);
  const responseJudge = {
    route: judged.route,
    score: judgeResult.score,
    coarse_outcome: judgeResult.coarse_outcome,
    confidence: judgeResult.confidence,
    reason_md: judgeResult.feedback_md,
    evidence_json: judgeResult.evidence_json,
  };

  // Enroll a mistake when the attempt scores below mastery. Prefer the numeric
  // score (spec: "score < mastery threshold"); fall back to the coarse outcome
  // only when the judge could not produce a score (e.g. unsupported).
  const belowMastery =
    judgeResult.score !== null
      ? judgeResult.score < SOLVE_MASTERY_THRESHOLD
      : outcome === 'failure';

  const now = new Date();
  const attemptEventId = createId();
  let mistakeId: string | undefined;

  // One transaction for the whole judged-attempt write: status active → submitted
  // → judged is committed atomically with the attempt event + mistake. If any
  // write fails the transition rolls back too, so the session never strands in
  // `submitted`. FOR UPDATE inside the transitions serialises concurrent submits
  // (the loser hits assertFromState and its txn aborts — no duplicate attempt).
  await db.transaction(async (tx) => {
    await Tutor.markSubmittedTx(tx, sessionId);
    await writeEvent(tx, {
      id: attemptEventId,
      session_id: sessionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: q.id,
      outcome,
      payload: {
        answer_md: answerMd.length > 0 ? answerMd : null,
        answer_image_refs: submission.student_image_refs ?? [],
        referenced_knowledge_ids: q.knowledge_ids,
        // provenance (stored in jsonb; stripped by the Zod contract on parse)
        source: 'solve_tutor',
        judge_route: judged.route,
        judge_score: judgeResult.score,
        judge: responseJudge,
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });

    if (belowMastery) {
      mistakeId = createId();
      await createLearningRecord(tx, {
        id: mistakeId,
        kind: 'mistake',
        title: null,
        content_md: answerMd.length > 0 ? answerMd : '(handwritten submission)',
        source: 'manual',
        capture_mode: (submission.student_image_refs ?? []).length > 0 ? 'image' : 'text',
        activity_kind: 'attempt',
        processing_status: 'raw',
        origin_event_id: attemptEventId,
        knowledge_ids: q.knowledge_ids,
        question_id: q.id,
        attempt_event_id: attemptEventId,
        asset_refs: submission.student_image_refs ?? [],
        payload: {
          from: 'solve_tutor',
          wrong_answer_md: answerMd,
          judge_route: judged.route,
          judge_score: judgeResult.score,
          judge: responseJudge,
        },
      });
    }

    // submitted → judged, atomic with the writes above (reveal is in the response).
    await Tutor.markJudgedTx(tx, sessionId);
  });

  return {
    attempt_event_id: attemptEventId,
    judge: responseJudge,
    revealed_solution_md: q.reference_md ?? null,
    ...(mistakeId !== undefined ? { mistake_id: mistakeId } : {}),
  };
}
