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
import { type SubjectProfile, defaultSubjectProfile } from '@/subjects/profile';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { writeRetryableAiFailureLedger } from './ai_failure_log';

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
  profile: SubjectProfile = defaultSubjectProfile,
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
 * Runs the AttributionTask LLM call, parses the JSON output, and writes a
 * JudgeOnEvent row chained on the attempt via caused_by_event_id.
 *
 * Idempotency: if a prior judge already exists for this attempt, skip + warn.
 * Errors (LLM failure, parse failure) are caught and logged; the attempt event
 * remains intact (no judge written).
 */
export async function runAttributionAndWriteJudgeEvent(
  params: RunAttributionAndWriteJudgeEventParams,
): Promise<void> {
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
    // Round-6 fix #1: track the placeholder's visibility/verdict fields to inherit.
    let inheritedVisibility: {
      visible_to_user?: boolean;
      coarse_outcome?: string;
      score?: number;
    } | null = null;
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
        return;
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

    const result = await params.runTaskFn('AttributionTask', params.input, {
      env: params.env,
      subjectProfile: params.subjectProfile,
    });
    const parsed = parseAttributionOutput(
      result.text,
      params.subjectProfile ?? defaultSubjectProfile,
    );

    const judgeId = newId();
    // D6 (U4 L-stamp): attribution is a non-routed judge — it runs AttributionTask
    // directly (above), never through JudgeInvoker. So the version source here is
    // the resolved SubjectProfile already in scope, not the invoker telemetry.
    // Stamp `profile_version` only; `capability_ref` / `judge_route` stay
    // undefined (attribution has no routed judge capability) — both remain
    // optional on JudgeOnEvent.payload. See docs/design/2026-06-04-u0-decisions.md D6.
    const profileVersion = (params.subjectProfile ?? defaultSubjectProfile).version;
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
    console.error('runAttributionAndWriteJudgeEvent: failed (attempt unaffected)', err);
    await writeRetryableAiFailureLedger(params.db, 'AttributionTask');
  }
}
