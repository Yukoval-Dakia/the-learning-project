// YUK-573 (Deliverable 2) — judge-calibration disagreement sampling core.
//
// REPORT-ONLY red line (design doc §5): this module re-judges already-decided
// attempts through the PURE judgeAnswer pipeline on a second provider lane and
// writes ONLY two observation actions — `experimental:judge_calibration_sample`
// (one per re-judged pair, caused_by = the original judge event) and
// `experimental:judge_calibration_run_summary` (one per run — the mass-skip
// vs cold-start discriminator, r3 复核吸收 3). It NEVER calls handleRejudge,
// never writes judge/correct/attempt/review events, never touches
// mastery_state / θ̂ checkpoints / FSRS / draft_status. Both observation
// actions prefill ingest_at (memory-outbox opt-out) — pure ledger rows.
//
// Selection (MF4): LLM-route whitelist (deterministic routes re-agree trivially
// and would burn BATCH_MAX), newest judge per answer event (appeal overturns
// supersede — rejudge.ts newest-wins), RANDOM order (Q4 ruling: recency slabs
// anti-correlate with activity), capped at cfg.batchMax per run.
//
// Idempotency (MF8): the SELECT dedup below is a pre-filter only; the
// correctness guarantee is the partial unique index
// `event_judge_calibration_sample_unique_idx` (drizzle/0059) — the writer maps
// a 23505 unique_violation to 'duplicate' and skips. The dedup is
// action-filtered on purpose: appeal events ALSO anchor caused_by = judge
// event id, so rejudge.ts's bare caused_by dedup precedent would misread an
// appealed judge as already-sampled (load-bearing deviation, design §3.2).
//
// Lane (MF5/S1): the re-judge runs through a per-call ctx.override
// { provider, model } — spread AFTER ...ctx so it beats the vision routes'
// own visionJudgeProviderOverride() injection (S5 spread order). The global
// AI_PROVIDER_OVERRIDE is never set or consulted for routing; sample rows
// carry env snapshots + same_lane_suspected so a collapsed lane is visible.

import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalProviderName } from '@/ai/task-spec';
import {
  IMAGE_CONSUMING_JUDGE_ROUTES,
  MODEL_BACKED_JUDGE_ROUTES,
} from '@/capabilities/practice/server/judge';
import {
  type JudgeQuestionRow,
  judgeAnswer,
} from '@/capabilities/practice/server/judge/question-contract';
import { getConfig } from '@/core/config/store';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resolveVerdictsForAttempts } from '@/kernel/read-models/assessment-verdict';
import { resolveSubjectProfileForKnowledgeIds } from '@/kernel/read-models/subject-profile';
import type { ResolvedProvider } from '@/server/ai/providers';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import type {
  CalibrationItemSkipClassification,
  CalibrationWorkSetItem,
} from './calibration-sample-durable-operation';

export const JUDGE_CALIBRATION_SAMPLE_ACTION = 'experimental:judge_calibration_sample';
export const JUDGE_CALIBRATION_RUN_SUMMARY_ACTION = 'experimental:judge_calibration_run_summary';
export const JUDGE_CALIBRATION_ACTOR = 'judge_calibration';

// The LLM-backed judge routes worth double-judging (MF4① whitelist). Consumes
// the canonical `MODEL_BACKED_JUDGE_ROUTES` predicate (@/capabilities/practice/server/judge,
// YUK-589 route-resolve.ts) instead of a locally-owned duplicate — YUK-769
// fixed a drift where this module's own copy omitted `unit_dimension` (its
// LLM fallback route), silently excluding it from calibration sampling.
// The routes whose invoker dispatch threads student_image_refs (photo answers).
// OCR minor (PR #1056): this used to be a locally-owned Set duplicating the
// canonical `IMAGE_CONSUMING_JUDGE_ROUTES` (@/capabilities/practice/server/judge, YUK-589
// route-resolve.ts) — same double-write drift risk as the MODEL_BACKED_ROUTES
// fix above. Consume the shared predicate instead of a local copy.
const VISION_ROUTES: Set<string> = IMAGE_CONSUMING_JUDGE_ROUTES;
const SAMPLED_OUTCOMES = ['correct', 'partial', 'incorrect'] as const;
export type SampledOutcome = (typeof SAMPLED_OUTCOMES)[number];

/** Raw re-judge output stored for the leg A capture chain (MF1); hard cap. */
const RAW_OUTPUT_MAX_CHARS = 20_000;
const RAW_TRUNCATION_MARKER = '…[truncated by judge_calibration]';

export interface JudgeCalibrationConfig {
  rejudgeProvider: string;
  rejudgeModel: string;
  batchMax: number;
  windowDays: number;
}

type RunTaskInner = (
  kind: string,
  input: unknown,
  ctx: unknown,
) => Promise<{ task_run_id?: string; text: string; structured_output?: unknown }>;

export interface JudgeCalibrationSampleDeps {
  /** replace the whole judge (coarse-grained test hook; default = real judgeAnswer). */
  judgeFn?: typeof judgeAnswer;
  /** replace the inner LLM runner (fine-grained test hook; default = real runTask). */
  runTaskInner?: RunTaskInner;
  now?: () => Date;
}

export interface JudgeCalibrationSampleResult {
  sampled: number;
  agreed: number;
  disagreed: number;
  skipped: number;
  /** OCR major 2: answer payload persisted NEITHER text key — face unreconstructable. */
  skipped_missing_input: number;
  skipped_unsupported: number;
  errors: number;
}

/** bit(coarse) = coarse ∈ {correct, partial} ? 1 : 0 — the θ̂ sensor bit (rejudge.ts). */
function outcomeBit(coarse: string): 0 | 1 {
  return coarse === 'correct' || coarse === 'partial' ? 1 : 0;
}

function truncateRawOutput(text: string | null): string | null {
  if (text === null) return null;
  if (text.length <= RAW_OUTPUT_MAX_CHARS) return text;
  return `${text.slice(0, RAW_OUTPUT_MAX_CHARS)}${RAW_TRUNCATION_MARKER}`;
}

/** Prefer the actual structured product when the SDK supplies one; text can be empty. */
function rawTaskOutput(result: { text: string; structured_output?: unknown }): string {
  if (result.structured_output === undefined || result.structured_output === null) {
    return result.text;
  }
  try {
    return JSON.stringify(result.structured_output);
  } catch {
    // Defensive only: SDK structured output is JSON, but evidence capture must
    // never turn a successful rejudge into a sampler failure.
    return result.text;
  }
}

/** postgres.js surfaces unique violations as code '23505' (possibly wrapped); walk the cause chain. */
function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e !== null && typeof e === 'object'; depth++) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Defensive local shape for the sample payload (generic experimental barrier is loose on purpose). */
const JudgeCalibrationSamplePayload = z.object({
  original_outcome: z.enum(SAMPLED_OUTCOMES),
  rejudge_outcome: z.enum(SAMPLED_OUTCOMES),
  agreed: z.boolean(),
  bit_agreed: z.boolean(),
  original_judge_event_id: z.string().min(1),
  question_id: z.string().min(1),
  answer_event_id: z.string().min(1),
  rejudge_route: z.string().min(1),
  rejudge_confidence: z.number().min(0).max(1),
  rejudge_provider: z.string().min(1),
  rejudge_model: z.string().min(1),
  rejudge_task_run_id: z.string().nullable(),
  rejudge_raw_output: z.string().nullable(),
  // MF5 lane snapshots — the original judge's lane is not recoverable, say so.
  original_provider: z.literal('unknown'),
  vision_judge_provider_at_sample: z.string().nullable(),
  ai_provider_override_at_sample: z.string().nullable(),
  same_lane_suspected: z.boolean(),
  sampled_at: z.string().min(1),
});

export interface JudgeCalibrationSampleWrite {
  originalJudgeEventId: string;
  questionId: string;
  answerEventId: string;
  priorOutcome: SampledOutcome;
  rejudgeOutcome: SampledOutcome;
  rejudgeRoute: string;
  rejudgeConfidence: number;
  rejudgeProvider: string;
  rejudgeModel: string;
  rejudgeTaskRunId: string | null;
  rejudgeRawOutput: string | null;
  visionJudgeProviderAtSample: string | null;
  aiProviderOverrideAtSample: string | null;
  sameLaneSuspected: boolean;
  now: Date;
}

/**
 * Write ONE sample observation event. 'duplicate' = the partial unique index
 * (MF8, drizzle/0059) rejected a second row for the same judge event — the
 * mid-batch-redeliver double-write case the SELECT dedup cannot close.
 */
export async function writeJudgeCalibrationSampleEvent(
  db: Db,
  w: JudgeCalibrationSampleWrite,
): Promise<'written' | 'duplicate'> {
  const payload = JudgeCalibrationSamplePayload.parse({
    original_outcome: w.priorOutcome,
    rejudge_outcome: w.rejudgeOutcome,
    agreed: w.rejudgeOutcome === w.priorOutcome,
    bit_agreed: outcomeBit(w.rejudgeOutcome) === outcomeBit(w.priorOutcome),
    original_judge_event_id: w.originalJudgeEventId,
    question_id: w.questionId,
    answer_event_id: w.answerEventId,
    rejudge_route: w.rejudgeRoute,
    rejudge_confidence: w.rejudgeConfidence,
    rejudge_provider: w.rejudgeProvider,
    rejudge_model: w.rejudgeModel,
    rejudge_task_run_id: w.rejudgeTaskRunId,
    rejudge_raw_output: truncateRawOutput(w.rejudgeRawOutput),
    original_provider: 'unknown',
    vision_judge_provider_at_sample: w.visionJudgeProviderAtSample,
    ai_provider_override_at_sample: w.aiProviderOverrideAtSample,
    same_lane_suspected: w.sameLaneSuspected,
    sampled_at: w.now.toISOString(),
  });
  try {
    await writeEvent(db, {
      id: newId(),
      session_id: null,
      actor_kind: 'system',
      actor_ref: JUDGE_CALIBRATION_ACTOR,
      action: JUDGE_CALIBRATION_SAMPLE_ACTION,
      subject_kind: 'event',
      subject_id: w.originalJudgeEventId,
      outcome: null,
      payload,
      caused_by_event_id: w.originalJudgeEventId,
      task_run_id: w.rejudgeTaskRunId,
      // Memory-outbox opt-out (ADR-0021): a calibration ledger row is not a
      // learning fact — it must never spawn a Mem0 add / brief regen.
      ingest_at: w.now,
      created_at: w.now,
    });
    return 'written';
  } catch (err) {
    if (isUniqueViolation(err)) return 'duplicate';
    throw err;
  }
}

/** Fisher–Yates — the TS-side ORDER BY random() (MF4③ Q4 ruling). */
function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = items[i] as T;
    items[i] = items[j] as T;
    items[j] = a;
  }
  return items;
}

export interface JudgeCandidate {
  id: string;
  subject_id: string;
  created_at: Date;
  payload: Record<string, unknown>;
}

/** Execution outcome of ONE frozen candidate through the second lane.
 * YUK-1355 extraction (feature-owner released): provider EXECUTION and domain
 * APPLY are separate seams — `missing_*` and `unsupported` produce no
 * observation row (terminal for that effect); `rejudged` carries exactly what
 * the apply step needs. Throws on fetch/judge failures — callers keep their
 * own isolation catch. */
export type JudgeCalibrationSingleRejudge =
  | { kind: 'missing_answer_event' }
  | { kind: 'missing_input' }
  | { kind: 'missing_image_refs' }
  | { kind: 'missing_question' }
  | { kind: 'unsupported' }
  | {
      kind: 'rejudged';
      judgeEventId: string;
      questionId: string;
      answerEventId: string;
      priorOutcome: SampledOutcome;
      judgeRoute: string;
      isVision: boolean;
      route: string;
      coarseOutcome: string;
      confidence: number;
      taskRunId: string | null;
      rawText: string | null;
    };

/** Sample-time lane snapshots (YUK-1007: effective values, env+DB merged). */
export interface JudgeCalibrationLaneSnapshots {
  visionJudgeProviderAtSample: string | null;
  aiProviderOverrideAtSample: string | null;
}

/** MF4 selection — window query → effective-verdict walk (YUK-1054 §9) →
 * action-filtered dedup (§3.2) → RANDOM order (Q4) → batchMax cap. Extracted
 * verbatim from runJudgeCalibrationSample (YUK-1355): freezing a workset
 * reuses THIS selection — no duplicated selection/domain math. */
export async function selectJudgeCalibrationCandidates(
  db: Db,
  cfg: JudgeCalibrationConfig,
  now: Date,
): Promise<JudgeCandidate[]> {
  const windowStart = new Date(now.getTime() - cfg.windowDays * 24 * 3600 * 1000);
  const routeList = sql.join(
    [...MODEL_BACKED_JUDGE_ROUTES].map((r) => sql`${r}`),
    sql`, `,
  );
  const judgeRows = await db
    .select({
      id: event.id,
      subject_id: event.subject_id,
      created_at: event.created_at,
      payload: event.payload,
    })
    .from(event)
    .where(
      and(
        eq(event.action, 'judge'),
        eq(event.subject_kind, 'event'),
        gte(event.created_at, windowStart),
        sql`${event.payload}->>'coarse_outcome' IN ('correct', 'partial', 'incorrect')`,
        sql`${event.payload}->>'judge_route' IN (${routeList})`,
      ),
    );

  // Effective judge per answer event (YUK-1054 §9 dual-track — was "newest by
  // created_at"). A rejudge anchors caused_by=appeal.id, so newest-by-created_at
  // alone could pick a superseded/retracted row. resolveVerdictsForAttempts walks
  // the correct-chain and returns the chain-resolved effective judge — the standing
  // verdict the calibration should disagree-check.
  const attemptIds = [...new Set(judgeRows.map((row) => row.subject_id))];
  const rowById = new Map(judgeRows.map((row) => [row.id, row]));
  const verdicts = await resolveVerdictsForAttempts(db, attemptIds);
  let candidates: JudgeCandidate[] = [];
  for (const v of verdicts.values()) {
    const effectiveId = v.effective?.judge_event_id;
    if (!effectiveId) continue;
    const row = rowById.get(effectiveId);
    if (!row) continue;
    candidates.push({
      id: row.id,
      subject_id: row.subject_id,
      created_at: row.created_at,
      payload: row.payload as Record<string, unknown>,
    });
  }

  // Already-sampled pre-filter (performance layer; MF8 index is the guarantee).
  // ACTION-FILTERED — appeal events share the caused_by key space (§3.2).
  if (candidates.length > 0) {
    const sampledRows = await db
      .select({ caused_by_event_id: event.caused_by_event_id })
      .from(event)
      .where(
        and(
          eq(event.action, JUDGE_CALIBRATION_SAMPLE_ACTION),
          inArray(
            event.caused_by_event_id,
            candidates.map((c) => c.id),
          ),
        ),
      );
    const alreadySampled = new Set(sampledRows.map((r) => r.caused_by_event_id));
    candidates = candidates.filter((c) => !alreadySampled.has(c.id));
  }

  // Random order (MF4③), hard per-run cap (cost gate).
  return shuffleInPlace(candidates).slice(0, cfg.batchMax);
}

/** Lane snapshots — YUK-1007：lane 快照记「生效值」（env+DB 合并后），不是裸
 * env——DB 写的 lane pin 也要被审计到。 lane.global.provider 才是 env pin >
 * DB > default 的生效值（裸 AI_PROVIDER_OVERRIDE 已从 keyspace 摘除）。 */
export function readCalibrationLaneSnapshots(): JudgeCalibrationLaneSnapshots {
  const visionJudgeProviderAtSample = (() => {
    const v = getConfig('VISION_JUDGE_PROVIDER');
    return typeof v === 'string' ? v : null;
  })();
  const aiProviderOverrideAtSample = (() => {
    const v = getConfig('lane.global.provider');
    return typeof v === 'string' ? v : null;
  })();
  return { visionJudgeProviderAtSample, aiProviderOverrideAtSample };
}

/** Prepared runner inputs. The staged executor uses this saved face without
 * reading answer/question/profile rows again. */
export interface JudgeCalibrationRejudgeFace {
  judgeEventId: string;
  questionId: string;
  answerEventId: string;
  priorOutcome: SampledOutcome;
  judgeRoute: string;
  answerMd: string;
  studentImageRefs: string[];
  question: JudgeQuestionRow;
  subjectProfile: Awaited<ReturnType<typeof resolveSubjectProfileForKnowledgeIds>>;
}

export type PreparedCalibrationRejudgeFace =
  | { kind: 'missing_answer_event' }
  | { kind: 'missing_input' }
  | { kind: 'missing_image_refs' }
  | { kind: 'missing_question' }
  | { kind: 'prepared'; face: JudgeCalibrationRejudgeFace };

/** PREPARE (live reads — the only place business rows are read for one
 * item): answer event face checks in the retained order, question row,
 * subject profile. Behavior-equivalent move of the fetch portion of the
 * per-candidate loop body. */
export async function prepareCalibrationRejudgeFace(
  db: Db,
  candidate: JudgeCandidate,
): Promise<PreparedCalibrationRejudgeFace> {
  const judgeRoute = String(candidate.payload.judge_route ?? '');
  const priorOutcome = candidate.payload.coarse_outcome as SampledOutcome;
  const isVision = VISION_ROUTES.has(judgeRoute);

  const [answerEvent] = await db.select().from(event).where(eq(event.id, candidate.subject_id));
  if (!answerEvent) {
    return { kind: 'missing_answer_event' };
  }
  const answerPayload = answerEvent.payload as Record<string, unknown>;
  // OCR major 2 (same information-face principle as MF2, text axis): when
  // NEITHER text key was persisted, the original judge saw submitted text
  // this payload never recorded — re-judging with '' would manufacture
  // false disagreements. KEY PRESENCE is the discriminator: a persisted ''
  // means the original judge also judged the empty submission (faces
  // match, legitimate pair); an absent key is a pre-persistence row (skip).
  const hasTextFace =
    typeof answerPayload.answer_md === 'string' ||
    typeof answerPayload.user_response_md === 'string';
  if (!hasTextFace) {
    return { kind: 'missing_input' };
  }
  const answerMd =
    (typeof answerPayload.answer_md === 'string' && answerPayload.answer_md) ||
    (typeof answerPayload.user_response_md === 'string' && answerPayload.user_response_md) ||
    '';
  // MF2: a vision-route answer whose payload predates answer_image_refs
  // persistence cannot be reconstructed with the original information face.
  if (isVision && !('answer_image_refs' in answerPayload)) {
    return { kind: 'missing_image_refs' };
  }
  const studentImageRefs = Array.isArray(answerPayload.answer_image_refs)
    ? (answerPayload.answer_image_refs as string[])
    : [];

  const [q] = await db.select().from(question).where(eq(question.id, answerEvent.subject_id));
  if (!q) {
    return { kind: 'missing_question' };
  }
  const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, q.knowledge_ids);

  return {
    kind: 'prepared',
    face: {
      judgeEventId: candidate.id,
      questionId: q.id,
      answerEventId: answerEvent.id,
      priorOutcome,
      judgeRoute,
      answerMd,
      studentImageRefs,
      question: q,
      subjectProfile,
    },
  };
}

/** JUDGE the prepared face (provider EXECUTION only — no reads of mutable
 * business rows; db is forwarded for pipeline plumbing exactly as the
 * retained path forwards it). Slot capture (MF1), override spread order (S5)
 * and the unsupported classification (MF3②) are behavior-equivalent moves of
 * the judge portion of the loop body. */
export async function judgeCalibrationPreparedFace(
  cfg: JudgeCalibrationConfig,
  face: JudgeCalibrationRejudgeFace,
  opts: {
    db: Db;
    judgeFn: typeof judgeAnswer;
    runTaskInner: RunTaskInner | ReturnType<typeof makeRunTaskFn>;
  },
): Promise<Extract<JudgeCalibrationSingleRejudge, { kind: 'rejudged' | 'unsupported' }>> {
  const isVision = VISION_ROUTES.has(face.judgeRoute);

  // S1/MF1 capture slot: the wrapper records the inner run's id + raw text.
  const slot: { taskRunId: string | null; rawText: string | null } = {
    taskRunId: null,
    rawText: null,
  };
  const rejudgeRunTaskFn = async (kind: string, input: unknown, ctx: unknown) => {
    const inner = await opts.runTaskInner(kind, input, {
      ...(ctx as Record<string, unknown>),
      // AFTER ...ctx on purpose (S5): the vision routes inject their own
      // override into ctx at the call site — the second lane must win.
      override: {
        provider: cfg.rejudgeProvider as ResolvedProvider['provider'],
        model: cfg.rejudgeModel,
      },
    });
    slot.taskRunId = inner.task_run_id ?? null;
    slot.rawText = rawTaskOutput(inner);
    return inner;
  };

  const invoked = await opts.judgeFn({
    db: opts.db,
    question: { ...face.question, judge_kind_override: face.judgeRoute },
    answer_md: face.answerMd,
    student_image_refs: face.studentImageRefs,
    subjectProfile: face.subjectProfile,
    runTaskFn: rejudgeRunTaskFn,
  });
  const rejudgeOutcome = invoked.result.coarse_outcome;

  // MF3②: unsupported = "review unavailable", NEVER a disagreement
  // (rejudge.ts unsupported-as-upheld semantics). No observation row.
  if (rejudgeOutcome === 'unsupported' || rejudgeOutcome === 'partial_unknown') {
    return { kind: 'unsupported' };
  }
  return {
    kind: 'rejudged',
    judgeEventId: face.judgeEventId,
    questionId: face.questionId,
    answerEventId: face.answerEventId,
    priorOutcome: face.priorOutcome,
    judgeRoute: face.judgeRoute,
    isVision,
    route: invoked.route,
    coarseOutcome: rejudgeOutcome,
    confidence: invoked.result.confidence,
    taskRunId: slot.taskRunId,
    rawText: slot.rawText,
  };
}

/** Single-item EXECUTION (retained composition): prepare the face (live
 * reads), then judge it. Behavior-equivalent with the pre-extraction loop
 * body. */
export async function rejudgeSingleCalibrationCandidate(
  db: Db,
  cfg: JudgeCalibrationConfig,
  candidate: JudgeCandidate,
  opts: {
    judgeFn: typeof judgeAnswer;
    runTaskInner: RunTaskInner | ReturnType<typeof makeRunTaskFn>;
  },
): Promise<JudgeCalibrationSingleRejudge> {
  const prepared = await prepareCalibrationRejudgeFace(db, candidate);
  if (prepared.kind !== 'prepared') {
    return prepared;
  }
  return judgeCalibrationPreparedFace(cfg, prepared.face, { db, ...opts });
}

/** Single-item APPLY seam (domain write only; no provider call). Composes the
 * MF5 lane snapshots + the observation write — behavior-equivalent move of
 * the loop's write portion. Returns the observation-write verdict. */
export async function applyJudgeCalibrationRejudgeSample(
  db: Db,
  cfg: JudgeCalibrationConfig,
  rejudged: Extract<JudgeCalibrationSingleRejudge, { kind: 'rejudged' }>,
  laneSnapshots: JudgeCalibrationLaneSnapshots,
  now: Date,
): Promise<'written' | 'duplicate'> {
  const inferredOriginalProvider = rejudged.isVision
    ? (laneSnapshots.visionJudgeProviderAtSample ??
      laneSnapshots.aiProviderOverrideAtSample ??
      'xiaomi')
    : (laneSnapshots.aiProviderOverrideAtSample ?? 'xiaomi');

  return writeJudgeCalibrationSampleEvent(db, {
    originalJudgeEventId: rejudged.judgeEventId,
    questionId: rejudged.questionId,
    answerEventId: rejudged.answerEventId,
    priorOutcome: rejudged.priorOutcome,
    rejudgeOutcome: rejudged.coarseOutcome as SampledOutcome,
    rejudgeRoute: rejudged.route,
    rejudgeConfidence: rejudged.confidence,
    rejudgeProvider: cfg.rejudgeProvider,
    rejudgeModel: cfg.rejudgeModel,
    rejudgeTaskRunId: rejudged.taskRunId,
    rejudgeRawOutput: rejudged.rawText,
    visionJudgeProviderAtSample: laneSnapshots.visionJudgeProviderAtSample,
    aiProviderOverrideAtSample: laneSnapshots.aiProviderOverrideAtSample,
    sameLaneSuspected:
      canonicalProviderName(inferredOriginalProvider) ===
      canonicalProviderName(cfg.rejudgeProvider),
    now,
  });
}

/** Freeze the selected candidates into staged-workset items by capturing the
 * FULL prepared input face (question row, subject profile, answer face) at
 * freeze time — YUK-1355 R1 P1b: the freeze digest binds the exact runner
 * inputs, and execution never re-reads the (mutable) business rows.
 * Un-preparable candidates are reported, never silently dropped. */
export async function freezeCalibrationWorkSetFromCandidates(
  db: Db,
  candidates: readonly JudgeCandidate[],
): Promise<{
  items: CalibrationWorkSetItem[];
  unprepared: Array<{ judgeEventId: string; classification: CalibrationItemSkipClassification }>;
}> {
  const items: CalibrationWorkSetItem[] = [];
  const unprepared: Array<{
    judgeEventId: string;
    classification: CalibrationItemSkipClassification;
  }> = [];
  for (const candidate of candidates) {
    const prepared = await prepareCalibrationRejudgeFace(db, candidate);
    if (prepared.kind !== 'prepared') {
      unprepared.push({ judgeEventId: candidate.id, classification: prepared.kind });
      continue;
    }
    const { face } = prepared;
    items.push({
      judgeEventId: face.judgeEventId,
      answerEventId: face.answerEventId,
      questionId: face.questionId,
      judgeRoute: face.judgeRoute,
      priorOutcome: face.priorOutcome,
      answerMd: face.answerMd,
      studentImageRefs: [...face.studentImageRefs],
      question: structuredClone(face.question),
      subjectProfile: structuredClone(face.subjectProfile),
      judgeCreatedAt: candidate.created_at.toISOString(),
    });
  }
  return { items, unprepared };
}

/** Runner factory for external single-item callers (YUK-1355): the same
 * inner runner the retained batch resolves — exported so staged seams build
 * without adding a new capability→server import edge. */
export function makeJudgeCalibrationRunner(db: Db): ReturnType<typeof makeRunTaskFn> {
  return makeRunTaskFn(db);
}

/**
 * Run one sampling batch. Report-only; see module header for the red line.
 * Always ends by writing ONE run-summary event (even for zero-candidate runs —
 * healthy-but-sparse vs systematically-skipping must be distinguishable).
 */
export async function runJudgeCalibrationSample(
  db: Db,
  cfg: JudgeCalibrationConfig,
  deps: JudgeCalibrationSampleDeps = {},
): Promise<JudgeCalibrationSampleResult> {
  const now = deps.now?.() ?? new Date();
  const judgeFn = deps.judgeFn ?? judgeAnswer;
  const runTaskInner = deps.runTaskInner ?? makeRunTaskFn(db);

  const result: JudgeCalibrationSampleResult = {
    sampled: 0,
    agreed: 0,
    disagreed: 0,
    skipped: 0,
    skipped_missing_input: 0,
    skipped_unsupported: 0,
    errors: 0,
  };

  // ── Selection + freeze of this batch (MF4; extracted — same math) ────────
  const batch = await selectJudgeCalibrationCandidates(db, cfg, now);

  // ── Lane snapshots (MF5) — sample-time env; original lane unrecoverable ──
  const laneSnapshots = readCalibrationLaneSnapshots();

  // ── Per-candidate re-judge (per-item isolation; one failure never kills the batch) ──
  // YUK-1355: EXECUTION (rejudgeSingleCalibrationCandidate — provider only) and
  // APPLY (applyJudgeCalibrationRejudgeSample — domain write only) are separate
  // seams composed here; counter semantics and isolation are unchanged.
  for (const candidate of batch) {
    try {
      const execution = await rejudgeSingleCalibrationCandidate(db, cfg, candidate, {
        judgeFn,
        runTaskInner,
      });
      if (execution.kind === 'missing_answer_event' || execution.kind === 'missing_question') {
        result.errors += 1;
        continue;
      }
      if (execution.kind === 'missing_input') {
        result.skipped_missing_input += 1;
        continue;
      }
      if (execution.kind === 'missing_image_refs') {
        result.skipped += 1;
        continue;
      }
      if (execution.kind === 'unsupported') {
        result.skipped_unsupported += 1;
        continue;
      }
      const written = await applyJudgeCalibrationRejudgeSample(
        db,
        cfg,
        execution,
        laneSnapshots,
        now,
      );
      if (written === 'duplicate') {
        result.skipped += 1;
        continue;
      }
      result.sampled += 1;
      if (execution.coarseOutcome === execution.priorOutcome) {
        result.agreed += 1;
      } else {
        result.disagreed += 1;
      }
    } catch (err) {
      result.errors += 1;
      // Message-only on purpose (review finding 3): never dump raw runner
      // errors — defensive against any future error shape carrying secrets.
      console.error('[judge_calibration_sample] per-item failure (isolated)', {
        judge_event_id: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Run summary (r3 复核吸收 3) — the tool's own health signal. ──────────
  // Own try/catch (OCR review): a transient summary-write failure must not
  // throw the whole batch into a pg-boss retry — the per-sample observations
  // already committed, and a replayed batch would emit a misleading second
  // summary (all prior samples re-counted as duplicates). Log loud instead.
  try {
    await writeEvent(db, {
      id: newId(),
      session_id: null,
      actor_kind: 'system',
      actor_ref: JUDGE_CALIBRATION_ACTOR,
      action: JUDGE_CALIBRATION_RUN_SUMMARY_ACTION,
      subject_kind: 'query',
      subject_id: `judge_calibration_run:${now.toISOString()}`,
      outcome: null,
      payload: {
        ...result,
        batch_max: cfg.batchMax,
        window_days: cfg.windowDays,
        rejudge_provider: cfg.rejudgeProvider,
        rejudge_model: cfg.rejudgeModel,
        vision_judge_provider_at_sample: laneSnapshots.visionJudgeProviderAtSample,
        ai_provider_override_at_sample: laneSnapshots.aiProviderOverrideAtSample,
      },
      caused_by_event_id: null,
      task_run_id: null,
      ingest_at: now,
      created_at: now,
    });
  } catch (err) {
    console.error('[judge_calibration_sample] run-summary write failed (batch results kept)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}
