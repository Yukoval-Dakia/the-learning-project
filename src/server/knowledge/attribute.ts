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
import { type TaskTextRunFn, costUsdToMicroUsd } from '@/server/ai/provenance';
import { type SubjectProfile, defaultSubjectProfile } from '@/subjects/profile';
import { z } from 'zod';
import { getJudgeForAttempt, writeEvent } from '../events/queries';
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
    const existing = await getJudgeForAttempt(params.db, params.attemptEventId);
    if (existing) {
      console.warn(
        `runAttributionAndWriteJudgeEvent: skipped — judge already exists for attempt ${params.attemptEventId}`,
      );
      return;
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
