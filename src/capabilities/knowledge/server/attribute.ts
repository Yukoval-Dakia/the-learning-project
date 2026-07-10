// Phase 1c.1 Step 4 — attribution rewrite.
//
// PREVIOUSLY: takes mistakeId + expectedVersion, UPDATEs mistake.cause with optimistic
// version check. NOW: takes attemptEventId, writes a chained judge event via writeEvent.
// Per ADR-0006 v2, attribution is no longer a column UPDATE — it's a JudgeOnEvent row
// chained on the attempt via caused_by_event_id.
//
// Idempotency: if a judge event with caused_by_event_id=attemptEventId already exists,
// skip + warn (mirrors the legacy "cause already set" check). Single-owner write path
// per ADR-0005 — never call db.insert(event) directly; goes through writeEvent.

import { newId } from '@/core/ids';
import { CauseSchema, validateCauseAgainstProfile } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { event as eventTable } from '@/db/schema';
import { type TaskTextRunFn, costUsdToMicroUsd } from '@/server/ai/provenance';
import { getJudgeForAttempt, writeEvent } from '@/server/events/queries';
// YUK-598 stale-const 收口（v2 §9①）：defaultSubjectProfile 冻结常量 → 活 registry
// resolveSubjectProfile()（每次调用求值，owner 编辑 general 即跟随）。
import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { writePermanentAiFailureLedger, writeRetryableAiFailureLedger } from './ai_failure_log';
import { retrieveCauseCandidates } from './attribute-retrieve';

// Lane B `CauseSchema` uses `analysis_md`. Step 7 cut over: the AttributionTask
// prompt now emits `analysis_md` natively, so the Step 4 `z.preprocess` bridge
// has been removed. Legacy LLM outputs emitting `ai_analysis_md` will fail
// schema parse and surface as a no-op (no judge event written) — see
// runAttributionAndWriteJudgeEvent's parse-error catch path.
const AttributionOutputSchema = CauseSchema.extend({
  analysis_md: z.string().min(1).max(2000),
});

export type AttributionOutput = z.infer<typeof AttributionOutputSchema>;

export function parseAttributionOutput(
  text: string,
  profile: SubjectProfile = resolveSubjectProfile(),
): AttributionOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseAttributionOutput: no JSON object found in text');
  }
  const slice = text.slice(start, end + 1);
  let json: unknown;
  try {
    json = JSON.parse(slice);
  } catch (e) {
    throw new Error(`parseAttributionOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  return validateCauseAgainstProfile(AttributionOutputSchema.parse(json), profile);
}

export interface AttributionInput {
  prompt_md: string;
  reference_md: string | null;
  wrong_answer_md: string;
  knowledge_context: Array<{ id: string; name: string; effective_domain: string | null }>;
}

export interface RunAttributionAndWriteJudgeEventParams {
  db: Db;
  attemptEventId: string; // was mistakeId + expectedVersion
  input: AttributionInput;
  runTaskFn: TaskTextRunFn;
  env?: unknown;
  subjectProfile?: SubjectProfile;
  /**
   * Optional: knowledge ids the judge referenced. Defaults to []. Used to populate
   * JudgeOnEvent.payload.referenced_knowledge_ids; caller (route layer) typically
   * passes the attempt's referenced knowledge so the mastery view picks them up.
   */
  referencedKnowledgeIds?: string[];
}

/**
 * Outcome discriminant for {@link runAttributionAndWriteJudgeEvent} (YUK-379 B1).
 *
 * The helper NEVER throws — it classifies every terminal state so the caller
 * decides retry policy:
 *  - `written`   — a real judge event was written.
 *  - `skipped`   — a real judge already existed (idempotent early-out).
 *  - `retryable` — the idempotency read / LLM call / judge write hit a transient
 *                  (DB fault or provider) failure. The caller (pg-boss job)
 *                  rethrows `error` so pg-boss retries + the llm_dlq are the
 *                  record of record. A best-effort `failed_retryable` ledger row
 *                  is ALSO written (OCR #6): the copilot `attribute_mistake`
 *                  caller does NOT rethrow (no pg-boss retry / llm_dlq), so that
 *                  row is its only observability for a retryable failure. The
 *                  discriminant + rethrow contract is unchanged.
 *  - `permanent` — the LLM SUCCEEDED but its output failed parse/validate.
 *                  Retrying re-spends money on a systematic failure, so a
 *                  `failed_permanent` cost_ledger row (carrying the task_run_id)
 *                  is written for observability and the job does not retry.
 */
export type AttributionOutcome =
  | { outcome: 'written' }
  | { outcome: 'skipped' }
  | { outcome: 'retryable'; error: unknown }
  | { outcome: 'permanent'; error: unknown };

/**
 * Runs the AttributionTask LLM call, parses the JSON output, and writes a
 * JudgeOnEvent row chained on the attempt via caused_by_event_id.
 *
 * Idempotency: if a real prior judge already exists for this attempt, returns
 * `{ outcome: 'skipped' }` + warns. Never throws — every failure is classified
 * into the {@link AttributionOutcome} discriminant so the caller owns retry
 * policy (YUK-379 B1). The attempt event is never mutated on any path.
 */
export async function runAttributionAndWriteJudgeEvent(
  params: RunAttributionAndWriteJudgeEventParams,
): Promise<AttributionOutcome> {
  // Profile resolution is IO-free; hoisted out of the try so it is in scope for
  // the LLM call, the post-LLM parse, and the judge write.
  const profile = params.subjectProfile ?? resolveSubjectProfile();

  // Round-6 fix #1: track the placeholder's visibility/verdict fields to inherit.
  let inheritedVisibility: {
    visible_to_user?: boolean;
    coarse_outcome?: string;
    score?: number;
  } | null = null;

  // ── Stage A: idempotency read + LLM call ──────────────────────────────────
  // A failure here (DB read fault OR LLM provider error) is RETRYABLE: return the
  // discriminant so the pg-boss caller rethrows — pg-boss retries + llm_dlq are
  // the durable record. OCR #6: ALSO write a best-effort `failed_retryable`
  // ledger row for the copilot `attribute_mistake` caller, which does NOT rethrow
  // and so has no other observability for a retryable failure.
  let result: Awaited<ReturnType<TaskTextRunFn>>;
  try {
    // Idempotency check — mirrors old "cause already set" behaviour. The DB-level
    // PK conflict in writeEvent gives us idempotency on event id, but here we
    // dedupe by attempt to avoid wastefully calling the LLM.
    //
    // Round-4 fix #4 (YUK-203): a paper placeholder judge sets
    // `attribution_pending: true` in its payload to signal that real attribution
    // has NOT happened yet. We must NOT skip when the only existing judge is a
    // pending placeholder — otherwise paper mistakes never get a real cause and
    // the D4 mistake-flywheel stays silent. Skip only when a real attribution
    // judge (no attribution_pending flag, or explicitly false) is present.
    const existing = await getJudgeForAttempt(params.db, params.attemptEventId);
    if (existing) {
      // Peek at the raw payload to check attribution_pending.
      // getJudgeForAttempt returns the processed shape; we need the raw flag.
      // Re-query is acceptable here (non-hot path, attribution is async).
      const rawRows = await params.db
        .select({ payload: eventTable.payload })
        .from(eventTable)
        .where(and(eq(eventTable.id, existing.judge_event_id)))
        .limit(1);
      const rawPayload = rawRows[0]?.payload as {
        attribution_pending?: boolean;
        visible_to_user?: boolean;
        coarse_outcome?: string;
        score?: number;
      } | null;
      if (!rawPayload?.attribution_pending) {
        // Real attribution already present — skip to stay idempotent.
        console.warn(
          `runAttributionAndWriteJudgeEvent: skipped — real judge already exists for attempt ${params.attemptEventId}`,
        );
        return { outcome: 'skipped' };
      }
      // attribution_pending=true: paper placeholder — fall through and run real
      // attribution. Capture the placeholder's visibility/verdict so the new judge
      // inherits them: visible_to_user:false must persist on the attribution event
      // or the newest-wins read layer will treat absent visible_to_user as visible
      // and expose buffered feedback before session completes (CR 3359820520).
      inheritedVisibility = {
        visible_to_user: rawPayload.visible_to_user,
        coarse_outcome: rawPayload.coarse_outcome,
        score: rawPayload.score,
      };
    }

    // YUK-462 — retrieve→rerank-with-rationale. The profile (resolved above) is
    // reused for both the L1 retriever and the post-LLM parse/clamp.
    //
    // Stage 1 (retrieve): deterministic, no-LLM candidate selection. For every
    // current profile (cause vocab <= K_SMALL) this returns the full vocab verbatim,
    // so the candidate set handed to stage 2 is byte-identical to the inline
    // taxonomy the legacy AttributionTask prompt embedded — behavior-equivalent.
    //
    // Stage 2 (rerank): AttributionRerankTask picks primary_category FROM the
    // candidate list + gives a per-candidate rationale. The candidate field is
    // added only to this internal rerank input; AttributionInput stays pure for
    // the 3 external callers. Post-LLM parse/clamp/write are unchanged below.
    const candidates = retrieveCauseCandidates(params.input, profile);
    result = await params.runTaskFn(
      'AttributionRerankTask',
      { ...params.input, candidates },
      { env: params.env, subjectProfile: profile },
    );
  } catch (err) {
    console.error('runAttributionAndWriteJudgeEvent: retryable failure (attempt unaffected)', err);
    // Best-effort (swallows internally); never masks the retryable classification.
    await writeRetryableAiFailureLedger(params.db, 'AttributionTask');
    return { outcome: 'retryable', error: err };
  }

  // ── Stage B: parse / validate ─────────────────────────────────────────────
  // The LLM already succeeded (cost incurred, task_run_id present). A parse or
  // schema-validate throw is PERMANENT — retrying re-spends money on a
  // systematic failure. Write a failed_permanent ledger row CARRYING
  // result.task_run_id so it joins into run-detail observability.
  let parsed: AttributionOutput;
  try {
    parsed = parseAttributionOutput(result.text, profile);
  } catch (err) {
    console.error(
      'runAttributionAndWriteJudgeEvent: permanent parse failure (attempt unaffected)',
      err,
    );
    await writePermanentAiFailureLedger(params.db, 'AttributionTask', result.task_run_id);
    return { outcome: 'permanent', error: err };
  }

  // ── Stage C: write the judge event ────────────────────────────────────────
  // A DB fault writing the judge is RETRYABLE (same rationale as stage A): the
  // caller rethrows, plus the best-effort `failed_retryable` ledger row (OCR #6)
  // for the non-rethrowing copilot caller. Honest cost note: a Stage-C retry
  // RE-INVOKES the LLM — the idempotency read precedes the LLM call and the
  // judge was never written, so nothing short-circuits the second attempt.
  // Accepted trade-off: Stage-C DB faults are rare, correctness > cost.
  try {
    const judgeId = newId();
    // D6 (U4 L-stamp): attribution is a non-routed judge — it runs AttributionRerankTask
    // directly (above), never through JudgeInvoker. So the version source here is
    // the resolved SubjectProfile already in scope, not the invoker telemetry.
    // Stamp `profile_version` only; `capability_ref` / `judge_route` stay
    // undefined (attribution has no routed judge capability) — both remain
    // optional on JudgeOnEvent.payload. See docs/design/2026-06-04-u0-decisions.md D6.
    const profileVersion = profile.version;
    await writeEvent(params.db, {
      id: judgeId,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'attribution',
      action: 'judge',
      subject_kind: 'event',
      subject_id: params.attemptEventId,
      outcome: 'success',
      payload: {
        cause: {
          primary_category: parsed.primary_category,
          secondary_categories: parsed.secondary_categories,
          analysis_md: parsed.analysis_md,
          confidence: parsed.confidence,
        },
        referenced_knowledge_ids: params.referencedKnowledgeIds ?? [],
        profile_version: profileVersion,
        // Round-6 fix #1 (CR 3359820520): inherit paper placeholder's visibility
        // gate and verdict fields so the newest-wins read layer does not treat the
        // absence of visible_to_user as "visible" and prematurely expose buffered
        // feedback. coarse_outcome/score are preserved so the paper-detail and
        // practice-list summaries remain accurate after attribution runs.
        // attribution_pending is intentionally NOT inherited (attribution is done).
        ...(inheritedVisibility?.visible_to_user !== undefined
          ? { visible_to_user: inheritedVisibility.visible_to_user }
          : {}),
        ...(inheritedVisibility?.coarse_outcome !== undefined
          ? { coarse_outcome: inheritedVisibility.coarse_outcome }
          : {}),
        ...(inheritedVisibility?.score !== undefined ? { score: inheritedVisibility.score } : {}),
      },
      caused_by_event_id: params.attemptEventId,
      task_run_id: result.task_run_id ?? null,
      cost_micro_usd: costUsdToMicroUsd(result.cost_usd),
      created_at: new Date(),
    });
  } catch (err) {
    console.error(
      'runAttributionAndWriteJudgeEvent: retryable write failure (attempt unaffected)',
      err,
    );
    // Best-effort (swallows internally); never masks the retryable classification.
    await writeRetryableAiFailureLedger(params.db, 'AttributionTask');
    return { outcome: 'retryable', error: err };
  }

  return { outcome: 'written' };
}
