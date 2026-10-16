// Frozen solve sessions: issue-bound hints and atomic native submission.
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import type { ActivateEvaluationIntentT, PracticeIssuanceDtoT } from '@/core/schema/assessment';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { artifact, event, question } from '@/db/schema';
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
  /**
   * YUK-1409 T4 — caller-owned cancellation for the whole generation section
   * (frozen media load + provider call). Defaults to an internal
   * SOLVE_HINT_GENERATION_BUDGET_MS timeout so a hung provider cannot push the
   * route past the ~20s usable-help observation bound.
   */
  signal?: AbortSignal;
  /**
   * Absolute wall-clock deadline forwarded to the runner as
   * providerSessionDeadlineAt (admission + startup + execution share it).
   * Defaults to Date.now() + SOLVE_HINT_GENERATION_BUDGET_MS.
   */
  generationDeadlineAt?: number;
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
  // YUK-1409 T4 — one bounded budget covers frozen media load + provider call so
  // a slow upstream cannot push the route past the ~20s usable-help target.
  const signal = params.signal ?? AbortSignal.timeout(SOLVE_HINT_GENERATION_BUDGET_MS);
  const generationDeadlineAt =
    params.generationDeadlineAt ?? Date.now() + SOLVE_HINT_GENERATION_BUDGET_MS;
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
          { subjectProfile, signal, providerSessionDeadlineAt: generationDeadlineAt },
        )
      : await runTaskFn('TeachingTurnTask', input, {
          subjectProfile,
          signal,
          providerSessionDeadlineAt: generationDeadlineAt,
        });
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

// ─── YUK-1409 T4 — hint-generation failure fallback ──────────────────────────
//
// A failed hint turn (provider error, timeout, quota, parse failure) must still
// leave the learner with usable help inside ~20s instead of a 502. The fallback
// is typed so the client can render it honestly:
//   - 'reference' help discloses the issued frozen reference (private sol_*
//     material, projected scoring basis, or legacy question.reference_md) ONLY
//     when the current hint level is at/past the ladder's full-solution stage
//     (mirrors the UI ladder's H5 — see FULL_STAGE_INDEX in
//     ui/hint-ladder.ts) or the issuance's solution was already revealed via the
//     dedicated reveal path. Early levels never get the whole solution dumped —
//     they get the deterministic next step plus an honest note that a frozen
//     reference exists behind the reveal action.
//   - 'deterministic_next_step' help is composed text (re-read the prompt, plus
//     an existing ready note on the question's knowledge nodes) labelled as not
//     produced by AI on demand.
//   - 'unavailable' when neither exists: the learner can retry or skip.

/** Generation section budget: leaves ~2s of the 20s observation target for
 * fallback construction + response. */
const SOLVE_HINT_GENERATION_BUDGET_MS = 18_000;

/** Mirrors FULL_STAGE_INDEX in ui/hint-ladder.ts — the ladder's full-solution
 * stage (H5). A hint request at/above this index is the client escalated past
 * every hint stage, i.e. reveal-level intent. */
const HINT_LADDER_FULL_STAGE_INDEX = 5;

/** Mirrors notes NOTE_ARTIFACT_TYPES (src/capabilities/notes/server/note-artifact-types.ts);
 * duplicated here because capability packages cannot deep-import each other. */
const KC_NOTE_ARTIFACT_TYPES = ['note_atomic', 'note_long', 'note_hub'] as const;

export type SolveHintFallbackReason =
  | 'timeout'
  | 'provider_error'
  | 'parse_failed'
  | 'media_unavailable'
  | 'unknown';

export interface SolveHintFallbackHelp {
  kind: 'reference' | 'deterministic_next_step';
  source:
    | 'frozen_revision_solution'
    | 'frozen_scoring_basis'
    | 'legacy_reference_md'
    | 'deterministic';
  text_md: string;
  /** False — this response never called the model; `source` labels where the
   * material actually came from (frozen material may itself be pre-generated). */
  generated_on_demand: false;
  /** Honest disclosure note, e.g. that a frozen reference was withheld at this
   * hint level and how to reveal it. */
  disclosure_md?: string;
}

export type SolveHintOutcome =
  | { status: 'ok'; text_md: string }
  | {
      status: 'fallback';
      reason: SolveHintFallbackReason;
      help: SolveHintFallbackHelp;
      /** Mirrors help.text_md — keeps the pre-union {text_md} client shape working. */
      text_md: string;
      /** A frozen reference exists for this question (reachable via the reveal path). */
      reference_available: boolean;
      /** The response already includes the frozen reference. */
      reference_revealed: boolean;
      /** Measured wall-clock for the whole request path — never faked. */
      elapsed_ms: number;
    }
  | {
      status: 'unavailable';
      reason: SolveHintFallbackReason;
      options: ['retry', 'skip'];
      /** Honest dead-end message — keeps the pre-union {text_md} client shape working. */
      text_md: string;
      elapsed_ms: number;
    };

/** Generation-class failures become fallbacks; session/state/coordinate errors
 * keep their HTTP status. study_media_unavailable is thrown inside the
 * generation section (frozen media gating) and still deserves fallback help. */
function isHintGenerationFailure(err: unknown): boolean {
  if (err instanceof SolveError) return err.code === 'llm_parse_failed';
  if (err instanceof ApiError) return err.code === 'study_media_unavailable';
  return true;
}

function classifyHintFailure(err: unknown, generationAborted: boolean): SolveHintFallbackReason {
  if (generationAborted) return 'timeout';
  if (err instanceof SolveError) return 'parse_failed';
  if (err instanceof ApiError) return 'media_unavailable';
  // Runner errors are matched by their self-set names/subtypes rather than
  // instanceof — importing the error classes would add capability→server
  // dependency edges (audit:capability-boundaries baseline). A miss degrades to
  // 'unknown', which only affects the reason label, never the fallback itself.
  const record =
    err !== null && typeof err === 'object' ? (err as Record<string, unknown>) : {};
  const name = typeof record.name === 'string' ? record.name : '';
  if (name === 'AgentRunError') {
    return record.subtype === 'budget_timeout' ? 'timeout' : 'provider_error';
  }
  if (name === 'ProviderSessionWallClockBudgetError') return 'timeout';
  if (name === 'ProviderSessionAdmissionError') {
    return record.reason === 'wait_timeout' ? 'timeout' : 'provider_error';
  }
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  return 'unknown';
}

/** Was the issuance's full solution already revealed via the dedicated reveal
 * path? Exposure is recorded per-issuance (the reveal route's own granularity),
 * so a prior reveal makes re-serving the frozen reference non-disclosing. */
async function hasPriorSolutionExposure(db: Db, issuanceId: string): Promise<boolean> {
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_assistance'),
        eq(event.subject_id, issuanceId),
        sql`${event.payload}->>'kind' = 'solution'`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

function bodyBlocksExcerpt(value: unknown, maxLength = 280): string | null {
  const texts: string[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (typeof record.text === 'string') texts.push(record.text);
    if (Array.isArray(record.content)) for (const child of record.content) visit(child);
  };
  if (value !== null && typeof value === 'object') {
    const content = (value as Record<string, unknown>).content;
    if (Array.isArray(content)) for (const node of content) visit(node);
  }
  const joined = texts.join(' ').replace(/\s+/g, ' ').trim();
  if (!joined) return null;
  return joined.length > maxLength ? `${joined.slice(0, maxLength - 1)}…` : joined;
}

/** The KC's existing stored note/explanation: a ready note artifact on any of
 * the question's knowledge nodes, newest first, first one with real text. */
async function loadKcNoteExcerpt(
  db: Db,
  knowledgeIds: string[],
): Promise<{ title: string; excerpt: string } | null> {
  if (knowledgeIds.length === 0) return null;
  const scope = knowledgeIds.map(
    (id) => sql`${artifact.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`,
  );
  const rows = await db
    .select({ title: artifact.title, body_blocks: artifact.body_blocks })
    .from(artifact)
    .where(
      and(
        inArray(artifact.type, [...KC_NOTE_ARTIFACT_TYPES]),
        eq(artifact.generation_status, 'ready'),
        isNull(artifact.archived_at),
        or(...scope),
      ),
    )
    .orderBy(desc(artifact.updated_at))
    .limit(4);
  for (const row of rows) {
    const excerpt = bodyBlocksExcerpt(row.body_blocks);
    if (excerpt) return { title: row.title, excerpt };
  }
  return null;
}

async function buildSolveHintFallback(params: {
  db: Db;
  sessionId: string;
  hintIndex: number;
  reason: SolveHintFallbackReason;
  elapsedMs: number;
}): Promise<SolveHintOutcome> {
  const { db, sessionId, hintIndex, reason, elapsedMs } = params;

  // Re-resolve the session's frozen coordinates. State/coordinate errors keep
  // propagating — the fallback only covers the generation failure, it does not
  // rewrite boundary semantics.
  const { questionId, issuanceId } = await Tutor.getTutorQuestionId(db, sessionId);
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

  let context: Awaited<ReturnType<typeof loadFrozenStudyContext>> | null = null;
  if (issuanceId) {
    try {
      context = await loadFrozenStudyContext(db, issuanceId, questionId);
    } catch (err) {
      // Disclosure boundaries (not_found / coordinate_mismatch /
      // reveal_unavailable) stay errors; other failures just mean there is no
      // frozen reference to fall back to.
      if (err instanceof ApiError) throw err;
      context = null;
    }
  }

  let reference: {
    text_md: string;
    source: 'frozen_revision_solution' | 'frozen_scoring_basis' | 'legacy_reference_md';
  } | null = null;
  if (context?.reference_md?.trim()) {
    reference = {
      text_md: context.reference_md,
      source: context.solution_md ? 'frozen_revision_solution' : 'frozen_scoring_basis',
    };
  } else if (q.reference_md?.trim()) {
    reference = { text_md: q.reference_md, source: 'legacy_reference_md' };
  }

  const mayRevealReference =
    hintIndex >= HINT_LADDER_FULL_STAGE_INDEX ||
    (issuanceId ? await hasPriorSolutionExposure(db, issuanceId) : false);

  if (reference && mayRevealReference) {
    if (issuanceId) {
      await recordAssistanceExposure(db, {
        issuanceId,
        questionId,
        kind: 'solution',
        impact: 'answer_help',
        contentDigest: `sha256:${canonicalHash(reference.text_md)}`,
      });
    }
    return {
      status: 'fallback',
      reason,
      help: {
        kind: 'reference',
        source: reference.source,
        text_md: reference.text_md,
        generated_on_demand: false,
        disclosure_md:
          '提示生成失败，这是该题封存的参考材料（非本次 AI 生成）。查看参考解记为非独立完成。',
      },
      text_md: reference.text_md,
      reference_available: true,
      reference_revealed: true,
      elapsed_ms: elapsedMs,
    };
  }

  // Deterministic next step — never the full solution at a sub-reveal level.
  const kcNote = await loadKcNoteExcerpt(db, q.knowledge_ids);
  const hasPrompt = Boolean(q.prompt_md?.trim());
  if (!hasPrompt && !kcNote) {
    return {
      status: 'unavailable',
      reason,
      options: ['retry', 'skip'],
      text_md: '这次没有可生成的提示，也没有可替代的参考材料 —— 可以重试，或先跳过这题。',
      elapsed_ms: elapsedMs,
    };
  }
  const lines = [
    '提示这次没生成出来 —— 给你一条确定性的下一步（不是 AI 现想的）：',
    hasPrompt
      ? '回到题面，把已知条件和它问的东西各划一遍；卡住多半在读题这一步。'
      : '先想清楚这类题第一步通常做什么（画图 / 列式 / 找等量关系）。',
  ];
  if (kcNote) {
    lines.push(`相关知识点已有的笔记《${kcNote.title}》里写着：${kcNote.excerpt}`);
  }
  const disclosures = ['本条为确定性文本，非 AI 生成。'];
  if (reference) {
    disclosures.push(
      '本题有封存参考解 —— 按提示阶梯规则当前阶不在此展开；走「直接看完整解」（记为非独立完成）可查看。',
    );
  }
  const text_md = lines.join('\n\n');
  if (issuanceId) {
    await recordAssistanceExposure(db, {
      issuanceId,
      questionId,
      kind: 'hint',
      impact: 'unknown',
      contentDigest: `sha256:${canonicalHash(text_md)}`,
    });
  }
  return {
    status: 'fallback',
    reason,
    help: {
      kind: 'deterministic_next_step',
      source: 'deterministic',
      text_md,
      generated_on_demand: false,
      disclosure_md: disclosures.join(' '),
    },
    text_md,
    reference_available: reference !== null,
    reference_revealed: false,
    elapsed_ms: elapsedMs,
  };
}

/**
 * Hint entry for the route layer: same session/state validation as
 * planSolveHint, but generation failures resolve to a typed fallback instead of
 * an upstream 502. The failed provider attempt keeps its own durable run row +
 * cost accounting (unknown cost stays unknown); this wrapper only adds the
 * deterministic help on top.
 */
export async function planSolveHintOutcome(params: PlanSolveHintParams): Promise<SolveHintOutcome> {
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(SOLVE_HINT_GENERATION_BUDGET_MS);
  try {
    const hint = await planSolveHint({
      ...params,
      signal,
      generationDeadlineAt: startedAt + SOLVE_HINT_GENERATION_BUDGET_MS,
    });
    return { status: 'ok', text_md: hint.text_md };
  } catch (err) {
    if (!isHintGenerationFailure(err)) throw err;
    const reason = classifyHintFailure(err, signal.aborted);
    const elapsedMs = Date.now() - startedAt;
    console.warn('[solve-hint] generation failed; serving fallback', {
      event: 'solve_hint_fallback',
      session_id: params.sessionId,
      hint_index: params.hintIndex,
      reason,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      elapsed_ms: elapsedMs,
    });
    return buildSolveHintFallback({
      db: params.db,
      sessionId: params.sessionId,
      hintIndex: params.hintIndex,
      reason,
      elapsedMs,
    });
  }
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
