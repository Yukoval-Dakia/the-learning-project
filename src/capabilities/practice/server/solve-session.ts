// Frozen solve sessions: issue-bound hints and atomic native submission.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import type { ActivateEvaluationIntentT, PracticeIssuanceDtoT } from '@/core/schema/assessment';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { REASONING_TRACE_MAX_LEN } from '@/kernel/limits';
import { resolveSubjectProfileForKnowledgeIds } from '@/kernel/read-models/subject-profile';
import { createAssessmentLearningRecord } from '@/kernel/records/queries';
import { makeRunTaskTextFn } from '@/server/ai/runner-fn';
import { sanitizeJsonStringLiterals } from '@/server/orchestrator/json-sanitize';
import { Tutor } from '@/server/session';
import { recordAssistanceExposure } from './assessment/assistance';
import { commitFormalAttempt } from './assessment/attempt';
import {
  loadFrozenStudyContext,
  loadFrozenStudyImages,
  revealFrozenStudyReference,
} from './assessment/study-context';
import type { SaveSubmissionRequest } from './assessment/submit';
import { createAssessmentAssetLoader } from './assets';
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
  issuanceId?: string;
}

export interface StartSolveSessionResult {
  sessionId: string;
}

export async function startSolveSession(
  params: StartSolveSessionParams,
): Promise<StartSolveSessionResult> {
  const { db, questionId } = params;

  const [q] = await db
    .select({ id: question.id, source: question.source })
    .from(question)
    .where(eq(question.id, questionId))
    .limit(1);
  if (!q || q.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE) {
    throw new SolveError('question_not_found', `question ${questionId} not found`);
  }

  if (params.issuanceId) {
    await loadFrozenStudyContext(db, params.issuanceId, questionId);
    const { sessionId } = await Tutor.startTutorSession(db, {
      questionId,
      issuanceId: params.issuanceId,
    });
    return { sessionId };
  }

  throw new ApiError(
    'issuance_required',
    'start a solve session with the issued assessment snapshot',
    409,
  );
}

// Reuse the TeachingTurnTask output loosely — for hints we only need text_md
// (the minimal next step). Parse defensively: any JSON object with a string
// text_md is accepted.
const HintTurn = z.object({ text_md: z.string().min(1) }).passthrough();

export interface PlanSolveHintParams {
  issuanceId?: string;
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
  q: { prompt_md: string; reference_md: string | null; practice_dto?: PracticeIssuanceDtoT },
  hintIndex: number,
) {
  return {
    learning_item: {
      title: '解题陪练',
      one_line_intent: q.prompt_md,
      knowledge_node: null,
    },
    parent_hub_summary: null,
    ...(q.practice_dto ? { frozen_question: q.practice_dto } : {}),
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
  const runTaskFn = params.runTaskFn ?? makeRunTaskTextFn(db);

  const { questionId, status, issuanceId } = await Tutor.getTutorQuestionId(db, sessionId);
  if (params.issuanceId !== undefined && params.issuanceId !== issuanceId) {
    throw new ApiError('coordinate_mismatch', 'hint session is bound to a different issuance', 409);
  }
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

  if (!issuanceId)
    throw new ApiError(
      'historical_unknown',
      'this historical session has no issued assessment snapshot',
      409,
    );
  const context = await loadFrozenStudyContext(db, issuanceId, questionId);
  const input = buildSolveHintInput(context, hintIndex);
  const signal = AbortSignal.timeout(60_000);
  const { images, image_manifest } = await loadFrozenStudyImages(
    context,
    createAssessmentAssetLoader(db),
    signal,
  );
  const { text } =
    images.length > 0
      ? await runTaskFn(
          'TeachingTurnVisionTask',
          {
            text: JSON.stringify({ ...input, image_manifest }),
            images,
          },
          { subjectProfile, signal },
        )
      : await runTaskFn('TeachingTurnTask', input, { subjectProfile });
  const result = parseHintTurn(text);
  if (issuanceId)
    await recordAssistanceExposure(db, {
      issuanceId,
      questionId,
      kind: 'hint',
      impact: 'unknown',
      contentDigest: `sha256:${canonicalHash(result.text_md)}`,
    });
  return result;
}

export interface SolveSubmission {
  assessment?: SaveSubmissionRequest;
  activation_intent?: ActivateEvaluationIntentT;
  self_report?: boolean;
  user_rating?: 'again' | 'hard' | 'good';
  student_text_steps?: string[];
  student_final_answer_text?: string;
  student_image_refs?: string[];
}

export interface SubmitSolveAttemptParams {
  db: Db;
  sessionId: string;
  submission: SolveSubmission;
  /** When set, the session's linked question must equal this (route-level guard). */
  expectedQuestionId?: string;
  /** Optional client capture only; persisted issuance help controls assistance. */
  hintsUsed?: number;
  /** YUK-352 — highest hint tier reached (optional companion to hintsUsed). */
  finalHintLevel?: number;
}

export interface SubmitSolveAttemptResult {
  status?: 'effective' | 'review_required';
  assessment?: {
    submission_id: string;
    evaluation_group_id: string;
    candidate_id: string;
    activation_intent: ActivateEvaluationIntentT;
    effect: string | null;
  };
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

export async function submitSolveAttempt(
  params: SubmitSolveAttemptParams,
): Promise<SubmitSolveAttemptResult> {
  const { db, sessionId, submission } = params;

  const { questionId, status, issuanceId } = await Tutor.getTutorQuestionId(db, sessionId);
  if (!questionId) {
    throw new SolveError('session_not_found', `tutor session ${sessionId} missing question link`);
  }
  if (params.expectedQuestionId !== undefined && questionId !== params.expectedQuestionId) {
    throw new SolveError(
      'session_not_found',
      `tutor session ${sessionId} is not bound to question ${params.expectedQuestionId}`,
    );
  }
  if (submission.assessment || issuanceId) {
    if (!issuanceId || !submission.assessment || submission.assessment.issuance_id !== issuanceId) {
      throw new ApiError(
        'coordinate_mismatch',
        'solve submission must use the session frozen issuance',
        409,
      );
    }
    const stableKey = `solve_${sessionId}`;
    if (
      submission.assessment.evaluation_group_id !== stableKey ||
      submission.assessment.idempotency_key !== stableKey
    ) {
      throw new ApiError(
        'coordinate_mismatch',
        'use the session evaluation_group_id and idempotency_key',
        409,
      );
    }
    if (status !== 'active' && status !== 'judged') {
      throw new SolveError('session_not_active', `tutor session ${sessionId} status=${status}`);
    }
    const steps = (submission.student_text_steps ?? []).filter((step) => step.trim());
    const displayAnswer = [...steps, submission.student_final_answer_text]
      .filter(Boolean)
      .join('\n');
    const mistakeId = `mistake_${stableKey}`;
    const committed = await commitFormalAttempt(
      db,
      'solve_tutor',
      questionId,
      submission.assessment,
      {
        activationIntent: submission.activation_intent,
        selfReport: submission.self_report,
        userRating: submission.user_rating,
        capture: {
          session_id: sessionId,
          response_md: displayAnswer || null,
          reasoning_trace: steps.join('\n').slice(0, REASONING_TRACE_MAX_LEN),
          hints_used: params.hintsUsed,
          final_hint_level: params.finalHintLevel,
        },
        onActivated: async (tx, prepared, attemptId) => {
          await Tutor.markSubmittedTx(tx, sessionId);
          const score = prepared.candidate.result;
          const belowMastery =
            !submission.self_report &&
            score.score !== null &&
            score.score < SOLVE_MASTERY_THRESHOLD;
          const attachments = [
            ...prepared.submission.group_evidence.map((item) => item.evidence),
            ...prepared.submission.response_set.entries.flatMap((entry) =>
              entry.kind === 'open' ? entry.evidence : [],
            ),
          ];
          const assetRefs = [...new Set(attachments.map((item) => item.asset.asset_id))];
          if (belowMastery)
            await createAssessmentLearningRecord(tx, {
              id: mistakeId,
              kind: 'mistake',
              title: null,
              content_md: displayAnswer || JSON.stringify(prepared.submission.response_set),
              source: 'manual',
              capture_mode: attachments.some((item) => item.kind === 'image') ? 'image' : 'text',
              activity_kind: 'attempt',
              processing_status: 'raw',
              origin_event_id: attemptId,
              submission_id: prepared.submission.submission_id,
              question_id: questionId,
              attempt_event_id: attemptId,
              asset_refs: assetRefs,
              payload: {
                from: 'solve_tutor',
                assessment: {
                  submission_id: prepared.submission.submission_id,
                  revision_id: prepared.submission.revision_id,
                  evaluation_id: prepared.candidate.evaluation.record.evaluation_id,
                },
              },
            });
          await Tutor.markJudgedTx(tx, sessionId);
        },
      },
    );
    const score = committed.candidate.result;
    const belowMastery =
      !submission.self_report && score.score !== null && score.score < SOLVE_MASTERY_THRESHOLD;
    const revealed =
      committed.status === 'effective'
        ? await revealFrozenStudyReference(db, issuanceId)
        : { reference_md: null };
    return {
      status: committed.status,
      attempt_event_id: committed.attempt_id,
      assessment: {
        submission_id: committed.submission.submission_id,
        evaluation_group_id: committed.submission.evaluation_group_id,
        candidate_id: committed.candidate.evaluation.record.evaluation_id,
        activation_intent: committed.activation_intent,
        effect: committed.status === 'effective' ? committed.activation.effect : null,
      },
      judge: {
        route: 'evaluate_submission',
        score: score.score,
        coarse_outcome: score.coarse_outcome,
        confidence: score.confidence,
        reason_md: score.feedback_md,
        evidence_json: score.evidence_json,
      },
      revealed_solution_md: revealed.reference_md,
      ...(committed.status === 'effective' && belowMastery ? { mistake_id: mistakeId } : {}),
    };
  }
  throw new ApiError(
    'historical_unknown',
    'submit the response to a session bound to an issued assessment',
    409,
  );
}
