// YUK-17 / ADR-0018 — second-pass verification for accepted mistake variants.
//
// Enqueued by acceptAiProposal() when a `variant_question` proposal is
// accepted. The handler loads the freshly-materialized variant question, the
// parent question, and the original failure attempt's effective cause (CC-1:
// always via effectiveCauseForFailureAttempt, never the raw judge), then
// asks VariantVerifyTask whether the variant is still on-target.
//
// verdict='pass'   → mistake_variant row stays 'active' (no DB change beyond
//                    timestamp + verify event); next reviewer can act
// verdict='fail'   → mistake_variant.status='broken' + failure_reasons saved,
//                    verify event written with outcome='partial'
//
// Idempotent: if a verify event already chains off the variant's question
// (action='experimental:variant_verify', subject_id=variant_question_id),
// the handler short-circuits without calling the LLM. pg-boss retry is safe.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import { VariantVerificationResult, type VariantVerificationResultT } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { event, knowledge, mistake_variant, question } from '@/db/schema';
import { zodToJsonSchemaOutputFormat } from '@/server/ai/output-format';
import {
  type TaskTextResult,
  type TaskTextRunFn,
  aiAgentRef,
  costUsdToMicroUsd,
} from '@/server/ai/provenance';
import { effectiveCauseForFailureAttempt } from '@/server/events/cause-policy';
import { getFailureAttemptById, writeEvent } from '@/server/events/queries';
import { resolveSubjectProfile } from '@/subjects/profile';
import type { VerifyFailureClass } from './quiz_verify';

export interface VariantVerifyJobData {
  mistake_variant_id: string;
}

export type RunTaskFn = TaskTextRunFn;

export interface RunVariantVerifyParams {
  db: Db;
  mistakeVariantId: string;
  runTaskFn: RunTaskFn;
}

export interface RunVariantVerifyResult {
  status:
    | 'verified'
    | 'broken'
    | 'skipped:not_found'
    | 'skipped:not_active'
    | 'skipped:no_variant_question'
    | 'skipped:variant_question_missing'
    | 'skipped:parent_question_missing'
    | 'skipped:no_proposal_event'
    | 'skipped:no_attempt'
    | 'skipped:no_cause'
    | 'skipped:already_verified';
  cause_targeting?: VariantVerificationResultT['cause_targeting'];
  failure_reasons?: string[];
}

type DepsOverride = {
  runTaskFn?: RunTaskFn;
};

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<Awaited<ReturnType<RunTaskFn>>> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return result;
}

function parseVariantVerifyOutput(text: string): VariantVerificationResultT {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseVariantVerifyOutput: no JSON object found in text');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`parseVariantVerifyOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  const parsed = VariantVerificationResult.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `parseVariantVerifyOutput: schema invalid: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/**
 * YUK-299 — three-state dispatch over a runTask result for VariantVerifyTask.
 * Exported so the unit test can feed constructed results directly (no runner/DB).
 *
 *   (A) result.structured_output present (endpoint honoured outputFormat) →
 *       Zod second-pass via VariantVerificationResult.safeParse. The Zod pass is
 *       NOT optional (约束⑥): outputFormat only guarantees JSON shape, not the
 *       app-level business constraints (failure_reasons[].length<=500, maxItems
 *       <=10, enums). A shape-valid-but-constraint-violating payload throws here
 *       so pg-boss re-runs the job — same outcome as the text-fallback path.
 *       safeParse also re-applies the .default([]) for an omitted failure_reasons.
 *   (B) result.structured_output undefined (outputFormat unset / endpoint
 *       unsupported / model fell back to text) → the existing char-scan
 *       parseVariantVerifyOutput fallback (约束③ — defensive layer kept).
 */
export function parseVariantVerifyResult(result: TaskTextResult): VariantVerificationResultT {
  // Exclude null as well as undefined: `structured_output?: unknown` includes
  // null, and an endpoint emitting the key as null would otherwise reach
  // safeParse(null) → a guaranteed throw → pg-boss retry. Treat null like
  // "absent" so it takes the char-scan text fallback instead.
  if (result.structured_output !== undefined && result.structured_output !== null) {
    const parsed = VariantVerificationResult.safeParse(result.structured_output);
    if (!parsed.success) {
      throw new Error(
        `parseVariantVerifyResult: structured_output schema invalid: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data;
  }
  return parseVariantVerifyOutput(result.text);
}

/**
 * Returns the source_attempt_event_id stored on the original
 * variant_question proposal event payload (under ai_proposal.proposed_change),
 * so we can pull the effective cause via the same CC-1 helper that
 * variant_gen used.
 */
function extractAttemptEventIdFromProposal(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const aiProposal = (payload as { ai_proposal?: unknown }).ai_proposal;
  if (!aiProposal || typeof aiProposal !== 'object') return null;
  const change = (aiProposal as { proposed_change?: unknown }).proposed_change;
  if (!change || typeof change !== 'object') return null;
  const attemptId = (change as { source_attempt_event_id?: unknown }).source_attempt_event_id;
  return typeof attemptId === 'string' && attemptId.length > 0 ? attemptId : null;
}

export async function runVariantVerify(
  params: RunVariantVerifyParams,
): Promise<RunVariantVerifyResult> {
  const { db, mistakeVariantId, runTaskFn } = params;

  const rows = await db
    .select()
    .from(mistake_variant)
    .where(eq(mistake_variant.id, mistakeVariantId))
    .limit(1);
  const row = rows[0];
  if (!row) return { status: 'skipped:not_found' };
  if (row.status !== 'active') {
    // draft → variant not yet accepted; broken / dismissed → already terminal.
    return { status: 'skipped:not_active' };
  }
  if (!row.variant_question_id) {
    return { status: 'skipped:no_variant_question' };
  }
  if (!row.proposal_event_id) {
    return { status: 'skipped:no_proposal_event' };
  }
  const variantQuestionId: string = row.variant_question_id;
  const proposalEventId: string = row.proposal_event_id;

  // Idempotency: a prior verify event already exists for this variant.
  const existingVerifyRows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:variant_verify'),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, variantQuestionId),
      ),
    )
    .limit(1);
  if (existingVerifyRows.length > 0) {
    return { status: 'skipped:already_verified' };
  }

  // Load variant question + parent question.
  const variantQs = await db
    .select()
    .from(question)
    .where(eq(question.id, variantQuestionId))
    .limit(1);
  const variantQ = variantQs[0];
  if (!variantQ) return { status: 'skipped:variant_question_missing' };

  const parentQs = await db
    .select()
    .from(question)
    .where(eq(question.id, row.parent_question_id))
    .limit(1);
  const parentQ = parentQs[0];
  if (!parentQ) return { status: 'skipped:parent_question_missing' };

  // Pull the original proposal event so we can recover the source attempt id.
  const proposalRows = await db.select().from(event).where(eq(event.id, proposalEventId)).limit(1);
  const proposalRow = proposalRows[0];
  if (!proposalRow) return { status: 'skipped:no_attempt' };
  const attemptEventId = extractAttemptEventIdFromProposal(proposalRow.payload);
  if (!attemptEventId) return { status: 'skipped:no_attempt' };

  // CC-1: always use the canonical cause-policy helper, never read judge
  // events directly.
  const failure = await getFailureAttemptById(db, attemptEventId);
  if (!failure) return { status: 'skipped:no_attempt' };
  const cause = effectiveCauseForFailureAttempt(failure);
  if (!cause) return { status: 'skipped:no_cause' };

  // Resolve subject profile from the first knowledge node touched by the
  // parent (same convention as variant_gen).
  const firstKnowledgeId = parentQ.knowledge_ids[0];
  const knowledgeRows = firstKnowledgeId
    ? await db
        .select({ domain: knowledge.domain })
        .from(knowledge)
        .where(eq(knowledge.id, firstKnowledgeId))
        .limit(1)
    : [];
  const subjectProfile = resolveSubjectProfile(knowledgeRows[0]?.domain);

  const input = {
    parent_question: {
      id: parentQ.id,
      prompt_md: parentQ.prompt_md,
      reference_md: parentQ.reference_md,
      knowledge_ids: parentQ.knowledge_ids,
      kind: parentQ.kind,
    },
    variant_question: {
      id: variantQ.id,
      prompt_md: variantQ.prompt_md,
      reference_md: variantQ.reference_md,
      knowledge_ids: variantQ.knowledge_ids,
      difficulty: variantQ.difficulty,
      kind: variantQ.kind,
    },
    original_cause: {
      primary_category: cause.primary_category,
      analysis_md: cause.analysis_md ?? cause.user_notes ?? '',
      source: cause.source,
    },
    original_attempt: {
      wrong_answer_md: failure.answer_md,
    },
  };

  // YUK-299 — pilot: ask the SDK to constrain the model to the verification
  // schema. The endpoint may ignore outputFormat (mimo); parseVariantVerifyResult
  // falls back to the char-scan path when structured_output is absent, so this is
  // a zero-loss opt-in. The Zod second-pass still enforces business constraints.
  const result = await runTaskFn('VariantVerifyTask', input, {
    db,
    subjectProfile,
    outputFormat: zodToJsonSchemaOutputFormat(VariantVerificationResult),
  });
  const parsed = parseVariantVerifyResult(result);

  const now = new Date();
  const verifyEventId = createId();

  await db.transaction(async (tx) => {
    if (parsed.verdict === 'fail') {
      await tx
        .update(mistake_variant)
        .set({
          status: 'broken',
          failure_reasons: parsed.failure_reasons,
          updated_at: now,
        })
        .where(eq(mistake_variant.id, mistakeVariantId));
    } else {
      // verdict='pass' — touch updated_at only so we can tell verify ran.
      await tx
        .update(mistake_variant)
        .set({ updated_at: now })
        .where(eq(mistake_variant.id, mistakeVariantId));
    }

    await writeEvent(tx, {
      id: verifyEventId,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'variant_verify',
      action: 'experimental:variant_verify',
      subject_kind: 'question',
      subject_id: variantQuestionId,
      outcome: parsed.verdict === 'pass' ? 'success' : 'partial',
      payload: {
        mistake_variant_id: mistakeVariantId,
        parent_question_id: row.parent_question_id,
        variant_question_id: variantQuestionId,
        proposal_event_id: proposalEventId,
        attempt_event_id: attemptEventId,
        verdict: parsed.verdict,
        // YUK-350 (L3, RL5) — additive: a 'fail' verdict (variant broke; outcome
        // 'partial') is a validation failure. 'pass' carries no failure_class.
        ...(parsed.verdict === 'fail'
          ? { failure_class: 'validation_failure' satisfies VerifyFailureClass }
          : {}),
        cause_targeting: parsed.cause_targeting,
        failure_reasons: parsed.failure_reasons,
        summary_md: parsed.summary_md,
        confidence: parsed.confidence,
        cause_source: cause.source,
        original_cause_category: cause.primary_category,
        verified_by: aiAgentRef('VariantVerifyTask', result),
      },
      caused_by_event_id: proposalEventId,
      task_run_id: result.task_run_id ?? null,
      cost_micro_usd: costUsdToMicroUsd(result.cost_usd),
      created_at: now,
    });
  });

  return {
    status: parsed.verdict === 'pass' ? 'verified' : 'broken',
    cause_targeting: parsed.cause_targeting,
    failure_reasons: parsed.failure_reasons,
  };
}

export function buildVariantVerifyHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<VariantVerifyJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
  return async (jobs) => {
    for (const job of jobs) {
      const mistakeVariantId = job.data?.mistake_variant_id;
      if (!mistakeVariantId) {
        console.warn('[variant_verify] job missing mistake_variant_id', job.id);
        continue;
      }
      try {
        const result = await runVariantVerify({
          db,
          mistakeVariantId,
          runTaskFn,
        });
        console.log(`[variant_verify] ${mistakeVariantId} → ${result.status}`);
      } catch (err) {
        // YUK-350 (RL1) — error-safe: this catch only logs + re-throws (pg-boss
        // retries). variant_verify writes NO verify event on a thrown failure and
        // writes no `overall`, so a system error cannot promote a variant (promotion
        // = mistake_variant status change happens only inside the committed txn in
        // runVariantVerify, which is past the throw). No result-layer 'error' value is
        // assigned here (no `overall` field exists for variants).
        //
        // YUK-350 (L3, RL5) — PHASE-DEFERRED observability gap: unlike quiz_verify /
        // source_verify, variant_verify has NO catch-bottom verify event, so a system
        // error here is NOT recorded as a failure_class='system_error' verify event —
        // only this console.error + the pg-boss retry trail. Intentionally NOT adding a
        // catch event (L3-Q2 decided): it would touch the retry/idempotency semantics
        // (this handler has no transient-error event guard). Revisit if variant-verify
        // observability needs event-level system-error coverage.
        console.error(`[variant_verify] ${mistakeVariantId} failed`, err);
        throw err;
      }
    }
  };
}
