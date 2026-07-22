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

import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/server/subject-profile';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event, question } from '@/db/schema';
import { judgeAnswer } from '@/server/ai/judges/question-contract';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { writeEvent } from '@/server/events/queries';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

export const JUDGE_CALIBRATION_SAMPLE_ACTION = 'experimental:judge_calibration_sample';
export const JUDGE_CALIBRATION_RUN_SUMMARY_ACTION = 'experimental:judge_calibration_run_summary';
export const JUDGE_CALIBRATION_ACTOR = 'judge_calibration';

/** The LLM-backed judge routes worth double-judging (MF4① whitelist). */
export const LLM_JUDGE_ROUTES = ['semantic', 'steps', 'multimodal_direct'] as const;
const VISION_ROUTES = new Set(['steps', 'multimodal_direct']);
const SAMPLED_OUTCOMES = ['correct', 'partial', 'incorrect'] as const;
type SampledOutcome = (typeof SAMPLED_OUTCOMES)[number];

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
) => Promise<{ task_run_id?: string; text: string }>;

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

interface JudgeCandidate {
  id: string;
  subject_id: string;
  created_at: Date;
  payload: Record<string, unknown>;
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

  // ── Selection (MF4) ──────────────────────────────────────────────────────
  const windowStart = new Date(now.getTime() - cfg.windowDays * 24 * 3600 * 1000);
  const routeList = sql.join(
    LLM_JUDGE_ROUTES.map((r) => sql`${r}`),
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

  // Newest judge per answer event (MF4② — appeal overturns supersede).
  const newestByAnswer = new Map<string, JudgeCandidate>();
  for (const row of judgeRows) {
    const candidate: JudgeCandidate = {
      id: row.id,
      subject_id: row.subject_id,
      created_at: row.created_at,
      payload: row.payload as Record<string, unknown>,
    };
    const prev = newestByAnswer.get(row.subject_id);
    if (
      !prev ||
      candidate.created_at.getTime() > prev.created_at.getTime() ||
      (candidate.created_at.getTime() === prev.created_at.getTime() && candidate.id > prev.id)
    ) {
      newestByAnswer.set(row.subject_id, candidate);
    }
  }
  let candidates = [...newestByAnswer.values()];

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
  const batch = shuffleInPlace(candidates).slice(0, cfg.batchMax);

  // ── Lane snapshots (MF5) — sample-time env; original lane unrecoverable. ──
  const visionProviderAtSample = process.env.VISION_JUDGE_PROVIDER ?? null;
  const globalOverrideAtSample = process.env.AI_PROVIDER_OVERRIDE ?? null;

  // ── Per-candidate re-judge (per-item isolation; one failure never kills the batch) ──
  for (const candidate of batch) {
    try {
      const judgeRoute = String(candidate.payload.judge_route ?? '');
      const priorOutcome = candidate.payload.coarse_outcome as SampledOutcome;
      const isVision = VISION_ROUTES.has(judgeRoute);

      const [answerEvent] = await db.select().from(event).where(eq(event.id, candidate.subject_id));
      if (!answerEvent) {
        result.errors += 1;
        continue;
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
        result.skipped_missing_input += 1;
        continue;
      }
      const answerMd =
        (typeof answerPayload.answer_md === 'string' && answerPayload.answer_md) ||
        (typeof answerPayload.user_response_md === 'string' && answerPayload.user_response_md) ||
        '';
      // MF2: a vision-route answer whose payload predates answer_image_refs
      // persistence cannot be reconstructed with the original information face.
      if (isVision && !('answer_image_refs' in answerPayload)) {
        result.skipped += 1;
        continue;
      }
      const studentImageRefs = Array.isArray(answerPayload.answer_image_refs)
        ? (answerPayload.answer_image_refs as string[])
        : [];

      const [q] = await db.select().from(question).where(eq(question.id, answerEvent.subject_id));
      if (!q) {
        result.errors += 1;
        continue;
      }
      const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, q.knowledge_ids);

      // S1/MF1 capture slot: the wrapper records the inner run's id + raw text.
      const slot: { taskRunId: string | null; rawText: string | null } = {
        taskRunId: null,
        rawText: null,
      };
      const rejudgeRunTaskFn = async (kind: string, input: unknown, ctx: unknown) => {
        const inner = await runTaskInner(kind, input, {
          ...(ctx as Record<string, unknown>),
          // AFTER ...ctx on purpose (S5): the vision routes inject their own
          // override into ctx at the call site — the second lane must win.
          override: {
            provider: cfg.rejudgeProvider as NonNullable<
              import('@/server/ai/runner-fn').BoundRunTaskCtx['override']
            >['provider'],
            model: cfg.rejudgeModel,
          },
        });
        slot.taskRunId = inner.task_run_id ?? null;
        slot.rawText = inner.text;
        return inner;
      };

      const invoked = await judgeFn({
        db,
        question: { ...q, judge_kind_override: judgeRoute },
        answer_md: answerMd,
        student_image_refs: studentImageRefs,
        subjectProfile,
        runTaskFn: rejudgeRunTaskFn,
      });
      const rejudgeOutcome = invoked.result.coarse_outcome;

      // MF3②: unsupported = "review unavailable", NEVER a disagreement
      // (rejudge.ts unsupported-as-upheld semantics). No observation row.
      if (rejudgeOutcome === 'unsupported') {
        result.skipped_unsupported += 1;
        continue;
      }

      const inferredOriginalProvider = isVision
        ? (visionProviderAtSample ?? globalOverrideAtSample ?? 'xiaomi')
        : (globalOverrideAtSample ?? 'xiaomi');

      const written = await writeJudgeCalibrationSampleEvent(db, {
        originalJudgeEventId: candidate.id,
        questionId: q.id,
        answerEventId: answerEvent.id,
        priorOutcome,
        rejudgeOutcome,
        rejudgeRoute: invoked.route,
        rejudgeConfidence: invoked.result.confidence,
        rejudgeProvider: cfg.rejudgeProvider,
        rejudgeModel: cfg.rejudgeModel,
        rejudgeTaskRunId: slot.taskRunId,
        rejudgeRawOutput: slot.rawText,
        visionJudgeProviderAtSample: visionProviderAtSample,
        aiProviderOverrideAtSample: globalOverrideAtSample,
        sameLaneSuspected: inferredOriginalProvider === cfg.rejudgeProvider,
        now,
      });
      if (written === 'duplicate') {
        result.skipped += 1;
        continue;
      }
      result.sampled += 1;
      if (rejudgeOutcome === priorOutcome) {
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
        vision_judge_provider_at_sample: visionProviderAtSample,
        ai_provider_override_at_sample: globalOverrideAtSample,
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
