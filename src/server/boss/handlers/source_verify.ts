// YUK-216 S2 slice 2 (题源扩展 Strategy D) — tier-2 source_verify handler.
//
// docs/superpowers/specs/2026-06-05-question-source-expansion-design.md §4
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §3 (step 2.7/2.8).
//
// Chained behind sourcing (the sourcing handler sends `source_verify`
// { question_ids } after writing draft questions, mirroring quiz_gen → quiz_verify).
// For each draft web_sourced question this handler runs the TIER-2 check set defined
// in verify-framework.ts (CHECK_SETS_BY_TIER[2] = structure_completeness +
// source_consistency + solve_check + dedup) and gates Option B:
//   pass (every check passes)   → promote draft_status 'draft'→'active' + FSRS enroll
//                                  (the question enters the review pool).
//   fail                        → leave draft_status='draft' (never reaches the pool).
//
// Skeleton copied from quiz_verify.ts (claim → idempotency → run → persist →
// writeEvent → catch). The checks here are mostly DETERMINISTIC (structure / source
// consistency / dedup); only solve_check spends an LLM call (reusing
// SolutionGenerateTask as an independent solver via verify-framework's runSolveCheck).
// This片 keeps the verify handler thin per plan §2.4 — kind_conformance (skill-driven)
// arrives in slice 4.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import { deriveSourceTier } from '@/core/schema/provenance';
import { WebSourcedProvenance } from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import { event, knowledge, question } from '@/db/schema';
import { type TaskTextResult, aiAgentRef } from '@/server/ai/provenance';
import { writeEvent } from '@/server/events/queries';
import { getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import {
  type SolveCheckQuestion,
  type SolveCheckResult,
  type VerifyCheck,
  checksForTier,
  runSolveCheck,
} from '@/server/quiz/verify-framework';
import { initialFsrsState } from '@/server/review/fsrs';
import { resolveSubjectProfile } from '@/subjects/profile';
import { maxNgramOverlap } from './quiz_verify';

export interface SourceVerifyJobData {
  question_ids: string[];
}

// Loose run seam (mirrors quiz_verify): the handler + solve-check only consume
// { text, task_run_id?, cost_usd? }. DB tests inject a vi.fn() returning a JSON
// string; production resolves runTask lazily.
export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>;

type DepsOverride = {
  runTaskFn?: RunTaskFn;
};

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<TaskTextResult> {
  const { runTask } = await import('@/server/ai/runner');
  return runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
}

// Dedup threshold: a sourced question whose prompt n-gram overlap with an existing
// ACTIVE pool question (sharing a knowledge point) is at/above this is treated as a
// near-duplicate. Reuses quiz_verify's deterministic maxNgramOverlap (word-shingle
// Jaccard, CJK-aware). CONSERVATIVE start, tunable.
export const DEDUP_OVERLAP_THRESHOLD = 0.7;

export interface CheckOutcome {
  check: VerifyCheck;
  // pass = the check is satisfied; fail = a hard problem; unsupported = no signal
  // (treated as non-blocking — conservative, mirrors solve-check semantics).
  verdict: 'pass' | 'fail' | 'unsupported';
  reason: string;
}

export type SourceVerifyPerQuestionStatus =
  | 'verified'
  | 'failed'
  | 'skipped:not_found'
  | 'skipped:not_web_sourced'
  | 'skipped:already_verified';

export interface RunSourceVerifyParams {
  db: Db;
  questionId: string;
  runTaskFn: RunTaskFn;
}

export interface RunSourceVerifyResult {
  status: SourceVerifyPerQuestionStatus;
  checks?: CheckOutcome[];
}

// ---------- deterministic checks ----------

type QuestionRow = typeof question.$inferSelect;

// structure_completeness — the row carries the fields its kind requires. Choice
// kinds need ≥2 options; every kind needs a non-empty prompt + reference answer.
function checkStructureCompleteness(row: QuestionRow): CheckOutcome {
  const problems: string[] = [];
  if (!row.prompt_md || row.prompt_md.trim().length === 0) problems.push('empty prompt_md');
  if (!row.reference_md || row.reference_md.trim().length === 0) {
    problems.push('empty reference_md');
  }
  if ((row.kind === 'choice' || row.kind === 'true_false') && (row.choices_md ?? []).length < 2) {
    problems.push(`${row.kind} question has <2 choices`);
  }
  return problems.length === 0
    ? { check: 'structure_completeness', verdict: 'pass', reason: 'all required fields present' }
    : { check: 'structure_completeness', verdict: 'fail', reason: problems.join('; ') };
}

// source_consistency — the row's declared source matches its persisted provenance:
// deriveSourceTier lands tier 2, the web_sourced block parses, and source_ref equals
// the provenance URL. A web_sourced row that does NOT derive tier 2 is mislabeled.
function checkSourceConsistency(row: QuestionRow): CheckOutcome {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const { tier } = deriveSourceTier({ source: row.source, metadata });
  if (tier !== 2) {
    return {
      check: 'source_consistency',
      verdict: 'fail',
      reason: `web_sourced row does not derive tier 2 (got tier ${tier}); provenance is missing or malformed`,
    };
  }
  const parsed = WebSourcedProvenance.safeParse(metadata.web_sourced);
  if (!parsed.success) {
    return {
      check: 'source_consistency',
      verdict: 'fail',
      reason: `metadata.web_sourced failed provenance parse: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }
  if (row.source_ref && row.source_ref !== parsed.data.url) {
    return {
      check: 'source_consistency',
      verdict: 'fail',
      reason: `source_ref (${row.source_ref}) disagrees with provenance url (${parsed.data.url})`,
    };
  }
  return {
    check: 'source_consistency',
    verdict: 'pass',
    reason: `tier 2 sourced provenance consistent (url ${parsed.data.url})`,
  };
}

// dedup — not a near-duplicate of an existing ACTIVE pool question sharing one of
// this question's knowledge points. Deterministic n-gram overlap (reused from
// quiz_verify). No candidates / no knowledge ids → no signal → pass.
async function checkDedup(db: Db, row: QuestionRow): Promise<CheckOutcome> {
  const knowledgeIds = row.knowledge_ids ?? [];
  if (knowledgeIds.length === 0) {
    return { check: 'dedup', verdict: 'pass', reason: 'no knowledge_ids — dedup not applicable' };
  }
  // Pull existing ACTIVE pool questions that share ANY knowledge point. Mirrors
  // due-list's `knowledge_ids @> [id]::jsonb` containment precedent (due-list.ts:215),
  // OR'd per id for ANY-overlap. Exclude the row itself + drafts. LIMIT keeps the
  // comparison bounded.
  const overlapClauses = knowledgeIds.map(
    (kid) => sql`${question.knowledge_ids} @> ${JSON.stringify([kid])}::jsonb`,
  );
  const candidates = await db
    .select({ id: question.id, prompt_md: question.prompt_md })
    .from(question)
    .where(
      and(
        ne(question.id, row.id),
        // draft_status IS NULL OR <> 'draft' — legacy active rows carry NULL
        // draft_status (due-list.ts:216 precedent); a bare ne() would drop them.
        or(isNull(question.draft_status), ne(question.draft_status, 'draft')),
        or(...overlapClauses),
      ),
    )
    .limit(50);
  if (candidates.length === 0) {
    return { check: 'dedup', verdict: 'pass', reason: 'no existing pool question to compare' };
  }
  let maxOverlap = 0;
  let nearestId = '';
  for (const c of candidates) {
    const overlap = maxNgramOverlap(row.prompt_md, [c.prompt_md]);
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      nearestId = c.id;
    }
  }
  if (maxOverlap >= DEDUP_OVERLAP_THRESHOLD) {
    return {
      check: 'dedup',
      verdict: 'fail',
      reason: `near-duplicate of pool question ${nearestId} (overlap ${maxOverlap.toFixed(2)} >= ${DEDUP_OVERLAP_THRESHOLD})`,
    };
  }
  return {
    check: 'dedup',
    verdict: 'pass',
    reason: `max overlap ${maxOverlap.toFixed(2)} below dedup threshold`,
  };
}

function solveCheckToOutcome(result: SolveCheckResult): CheckOutcome {
  // verify-framework's solve-check is conservative: 'unsupported' carries no signal.
  // Map its verdict onto the verify outcome — only a confident 'fail' blocks promotion.
  return {
    check: 'solve_check',
    verdict:
      result.verdict === 'fail' ? 'fail' : result.verdict === 'pass' ? 'pass' : 'unsupported',
    reason: result.reason,
  };
}

/**
 * Verify a single sourced draft question against the tier-2 check set. Idempotent
 * per (question_id) via the chained verify event guard. Promotes draft→active +
 * FSRS-enrolls when every check passes (no check is 'fail').
 */
export async function runSourceVerify(
  params: RunSourceVerifyParams,
): Promise<RunSourceVerifyResult> {
  const { db, questionId, runTaskFn } = params;

  const rows = await db.select().from(question).where(eq(question.id, questionId)).limit(1);
  const row = rows[0];
  if (!row) return { status: 'skipped:not_found' };
  if (row.source !== 'web_sourced') return { status: 'skipped:not_web_sourced' };

  // Idempotency: only a TERMINAL verify event short-circuits a re-run (outcome !=
  // 'error'). The catch-bottom writes a TRANSIENT-error event with outcome='error'
  // so a one-off LLM/DB blowup doesn't strand the draft (mirrors quiz_verify).
  const existingVerify = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:source_verify'),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, questionId),
        ne(event.outcome, 'error'),
      ),
    )
    .limit(1);
  if (existingVerify.length > 0) return { status: 'skipped:already_verified' };

  // Resolve subject profile from the first knowledge node (same convention as
  // quiz_gen / quiz_verify).
  const firstKnowledgeId = row.knowledge_ids[0];
  const knowledgeRows = firstKnowledgeId
    ? await db
        .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
        .from(knowledge)
        .where(eq(knowledge.id, firstKnowledgeId))
        .limit(1)
    : [];
  const knowledgeNode = knowledgeRows[0] ?? null;
  const subjectProfile = resolveSubjectProfile(knowledgeNode?.domain ?? null);

  try {
    // Run the tier-2 check set (CHECK_SETS_BY_TIER[2]). structure_completeness +
    // source_consistency + dedup are deterministic; solve_check spends the LLM call.
    const tierChecks = checksForTier(2);
    const checks: CheckOutcome[] = [];

    if (tierChecks.includes('structure_completeness')) {
      checks.push(checkStructureCompleteness(row));
    }
    if (tierChecks.includes('source_consistency')) {
      checks.push(checkSourceConsistency(row));
    }
    if (tierChecks.includes('dedup')) {
      checks.push(await checkDedup(db, row));
    }
    if (tierChecks.includes('solve_check')) {
      const solveQuestion: SolveCheckQuestion = {
        id: row.id,
        kind: row.kind,
        prompt_md: row.prompt_md,
        reference_md: row.reference_md,
        choices_md: row.choices_md,
        judge_kind_override: row.judge_kind_override,
        rubric_json: row.rubric_json,
        knowledge_ids: row.knowledge_ids,
        metadata: (row.metadata ?? null) as Record<string, unknown> | null,
      };
      const solveResult = await runSolveCheck(solveQuestion, {
        runTaskFn,
        profile: { id: subjectProfile.id, full: subjectProfile },
        db,
      });
      checks.push(solveCheckToOutcome(solveResult));
    }

    // Option B gate: promote ONLY when no check is 'fail'. 'unsupported' (no signal)
    // is non-blocking — conservative, so a question the solver couldn't independently
    // solve is not killed (R2). A hard structural / consistency / dedup / solve fail
    // keeps the draft out of the pool.
    const promote = !checks.some((c) => c.verdict === 'fail');

    // solve_check owns its AI run inside runSolveCheck, so this handler holds no
    // single TaskTextResult; the verify event carries the per-check verdicts as its
    // audit trail instead of a task_run_id.
    const now = new Date();
    const verifyEventId = createId();
    const verifiedBy = aiAgentRef('SourceVerify', { text: '' });

    await db.transaction(async (tx) => {
      if (promote) {
        await tx
          .update(question)
          .set({ draft_status: 'active', updated_at: now })
          .where(eq(question.id, questionId));

        // FSRS enroll-if-absent per knowledge point (identical convention to
        // quiz_verify): materialize an initial card only for knowledge points with no
        // existing projection; never reset an existing schedule.
        const initial = initialFsrsState(now);
        const fsrsSubjectIds = Array.from(new Set(row.knowledge_ids ?? []));
        if (fsrsSubjectIds.length > 0) {
          for (const knowledgeId of fsrsSubjectIds) {
            const existing = await getFsrsState(tx, 'knowledge', knowledgeId);
            if (existing) continue;
            await upsertFsrsState(tx, {
              subject_kind: 'knowledge',
              subject_id: knowledgeId,
              state: initial.state,
              due_at: initial.dueAt,
              last_review_event_id: verifyEventId,
            });
          }
        } else {
          const existing = await getFsrsState(tx, 'question', questionId);
          if (!existing) {
            await upsertFsrsState(tx, {
              subject_kind: 'question',
              subject_id: questionId,
              state: initial.state,
              due_at: initial.dueAt,
              last_review_event_id: verifyEventId,
            });
          }
        }
      }

      await writeEvent(tx, {
        id: verifyEventId,
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'source_verify',
        action: 'experimental:source_verify',
        subject_kind: 'question',
        subject_id: questionId,
        outcome: promote ? 'success' : 'failure',
        payload: {
          question_id: questionId,
          tier: 2,
          promoted: promote,
          checks: checks.map((c) => ({ check: c.check, verdict: c.verdict, reason: c.reason })),
          verified_by: verifiedBy,
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: now,
      });
    });

    return { status: promote ? 'verified' : 'failed', checks };
  } catch (err) {
    // failure-bottom: write a TRANSIENT-error event so pg-boss redelivery re-runs the
    // verify (idempotency guard treats outcome='error' as retriable). The draft stays
    // draft_status='draft' — the catch path NEVER promotes (mirrors quiz_verify).
    try {
      await writeEvent(db, {
        id: createId(),
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'source_verify',
        action: 'experimental:source_verify',
        subject_kind: 'question',
        subject_id: questionId,
        outcome: 'error',
        payload: {
          question_id: questionId,
          error: String((err as Error).message ?? err),
        },
        caused_by_event_id: null,
        // solve_check owns its own AI run inside runSolveCheck; this handler holds no
        // single TaskTextResult, so the transient-error event carries no run id/cost.
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date(),
      });
    } catch (cleanupErr) {
      console.error('[source_verify] catch-block cleanup failed for', questionId, cleanupErr);
    }
    throw err;
  }
}

export function buildSourceVerifyHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<SourceVerifyJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
  return async (jobs) => {
    for (const job of jobs) {
      const questionIds = job.data?.question_ids;
      if (!Array.isArray(questionIds) || questionIds.length === 0) {
        console.warn('[source_verify] job missing question_ids', job.id);
        continue;
      }
      for (const questionId of questionIds) {
        const result = await runSourceVerify({ db, questionId, runTaskFn });
        console.log(`[source_verify] ${questionId} -> ${result.status}`);
      }
    }
  };
}
